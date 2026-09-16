/**
 * dsh-screen-reader — 让 DeepSeek-v4 系列模型**实时、便宜**地看见 Android 屏幕。
 *
 * 为什么不是「让模型跑 bash curl /app/ui/dump」：
 *   1. 每次都要新起进程 + 新建 TCP 连接，实测 200 ms 起步，而插件内复用 loopback
 *      连接只要 6~9 ms；
 *   2. 桥的原始 dump 一个聊天界面就有 15 KB（≈5k token），而模型只需要「哪些能点、
 *      叫什么、在哪」；
 *   3. 「点一下 → 看结果」要三次工具调用（curl 点按 / sleep / curl 读屏），
 *      插件里合成一次 `screen_act`。
 *
 * 于是本插件提供两个工具：
 *   - `screen_read`：读屏。默认输出**相对上次的增量**，可 `wait_ms` 阻塞等界面变化
 *     （真正的实时用法：点完直接 wait，别轮询），`mode:"image"` 才给截图。
 *   - `screen_act`：执行一次点按/输入/按键/滑动/启动，并直接回读结果——一个来回搞定。
 *
 * @module dsh-screen-reader
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as bridge from './bridge.js'
import { deltaText, diffTree, snapshotText } from './tree.js'
import { ScreenReader, readScreenshotBytes } from './reader.js'

/** Cordis 插件名。 */
export const name = 'dsh-screen-reader'

/** 依赖的工具注册表；systemPrompt 是可选的（极简配置里可能没有）。 */
export const inject = ['tools']

/** 运行时配置。 */
export const Config = z.object({
  /** 总开关；关掉后不注册任何工具。 */
  enabled: z.boolean().default(true),
  /** 是否注册 `screen_act`（点按/输入等）。只读审计场景可关掉。 */
  allowActions: z.boolean().default(true),
  /** 同一次工具调用内的采样缓存时长（ms）；短到不会让模型看到过期界面。 */
  cacheMs: z.number().default(120),
  /** 等待界面变化时的首次轮询间隔（ms）。 */
  minIntervalMs: z.number().default(60),
  /** 等待时的退避上限（ms）。 */
  maxIntervalMs: z.number().default(240),
  /** 读屏最多尝试几次：超时 / 瞬时无窗口 / 退化帧都会重试（读屏幂等，重试永远安全）。 */
  maxAttempts: z.number().default(3),
  /** 读屏重试前的等待（ms）。 */
  retryDelayMs: z.number().default(120),
  /** 全量输出时的条目上限。 */
  maxElements: z.number().default(120),
  /** 单条文字截断长度。 */
  maxText: z.number().default(96),
  /** `screen_act` 动作后等待界面变化的上限（ms）。 */
  actionWaitMs: z.number().default(1500),
  /** `screen_act` 动作后要求的画面稳定时长（ms），避免抓到动画中间帧。 */
  actionSettleMs: z.number().default(150),
  /** 单次工具调用允许的最长等待（ms），作为协作式取消预算。 */
  maxWaitMs: z.number().default(30_000),
  /** 是否注入一段简短的系统提示（建议开着，模型才知道该用这两个工具）。 */
  prompt: z.boolean().default(true),
  /** 加载时预热一次桥连接，把首次调用的建连开销挪到启动期。 */
  warmup: z.boolean().default(true),
})

const SECTION = 'dsh:screen-reader'

const PROMPT = [
  '【屏幕感知 · dsh-screen-reader】screen_read / screen_act 直连 DSHA 桥的无障碍服务，读一屏约 10ms。',
  '  - 看屏幕优先用 screen_read（要等界面变化就传 wait_ms 阻塞等，别自己 sleep 轮询），不要用 bash+curl 调 /app/ui/*。',
  '  - 默认只回**增量**（表头里的 Δ），这是省 token 的关键；需要全量时传 delta:false。',
  '  - 点按优先按 text：控件坐标会随滚动/动画变，文字不变。',
  '  - 只有界面没有文字（游戏、画布、图形按钮）才用 mode:"image" 让视觉模型看截图。',
].join('\n')

/**
 * 图片附件的规范化输出形状（与 read_image 一致，便于 UI/请求装配直接消费）。
 *
 * 注意：这里**不能**带 `required: true` —— 那个键属于「父对象里的属性声明」，
 * 写进来会把 `image` 传染成必填，导致不截图的那次调用直接 INVALID_TOOL_OUTPUT。
 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}

/** 两个工具共用的输出契约：文本 + 可选图片 + 少量元信息。 */
const SCREEN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    app: { type: 'string', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    elapsed_ms: { type: 'integer', required: true },
    waited_ms: { type: 'integer', required: true },
    total: { type: 'integer', required: true },
    shown: { type: 'integer', required: true },
    changed: { type: 'boolean', required: true },
    delta: { type: 'boolean', required: true },
    digest: { type: 'string', required: true },
    tree: { type: 'string', required: true },
    note: { type: 'string' },
    image: IMAGE_VALUE_SCHEMA,
  },
}

/** 把规范化值投影成模型可见内容块。 */
function renderScreen(_args, value) {
  const blocks = [{ type: 'text', text: value.tree }]
  if (value.image) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...(value.image.name === undefined ? {} : { name: value.image.name }),
      },
    })
  }
  return blocks
}

/** 每个会话各留一份「上次看到的屏幕」，用于增量。 */
const sessionStates = new WeakMap()
const fallbackState = { last: null }

/** 取会话状态；没有 agent/session 时退回全局单份（PTC 等场景）。 */
function stateFor(exec) {
  const session = exec?.agent?.session
  if (!session || (typeof session !== 'object' && typeof session !== 'function')) return fallbackState
  let state = sessionStates.get(session)
  if (!state) {
    state = { last: null }
    sessionStates.set(session, state)
  }
  return state
}

/** 读屏表头。 */
function headerOf(snapshot, sample) {
  const time = new Date(sample.at).toTimeString().slice(0, 8)
  const app = snapshot.app || '(未知应用)'
  return `# ${app} ${snapshot.width}x${snapshot.height} ${time} 读屏${sample.ms}ms`
}

/** 从配置里取渲染选项。 */
function renderOptions(args, config) {
  return {
    detail: args.detail === 'full' ? 'full' : 'compact',
    maxElements: clampInt(args.max_elements, config.maxElements, 1, 1000),
    maxText: config.maxText,
    find: typeof args.find === 'string' ? args.find : '',
  }
}

/** 安全取整并夹紧。 */
function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * 校验当前模型路由是否接受图片输入。
 *
 * 和 `read_image` 一样是硬门槛：模型看不见图片时，与其让它拿到一个用不上的结果，
 * 不如直接说清楚该怎么换。路由解析不出来时放行（宁可给图，也不要误报）。
 */
async function assertImageRoute(ctx, exec) {
  const llm = ctx.get('llm')
  const routed = exec?.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec?.agent?.options?.provider
  const model = routed?.model ?? exec?.agent?.options?.model
  if (!llm || provider === undefined || model === undefined) return
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    const modalities = info?.inputModalities
    if (Array.isArray(modalities) && !modalities.includes('image')) {
      throw new Error(`当前模型 "${model}" 不接受图片输入；改用 mode:"tree"（无障碍树更便宜，而且能直接给出可点文字）。`)
    }
  } catch (error) {
    if (typeof error?.message === 'string' && error.message.includes('不接受图片输入')) throw error
    // 型号信息解析失败不影响读屏本身。
  }
}

/**
 * 截屏 → 落成 durable 附件，返回可放进输出值的图片元信息。
 * @param {object} ctx 插件上下文。
 * @param {object} exec 工具执行上下文（取 signal）。
 * @returns {Promise<object|undefined>} 图片元信息；没有附件服务时返回 undefined。
 */
async function captureImage(ctx, exec) {
  const attachments = ctx.get('attachments')
  if (!attachments) {
    throw new Error('本部署没有挂载附件服务，无法把截图交给模型；请改用 mode:"tree"。')
  }
  await assertImageRoute(ctx, exec)
  const shot = await bridge.screenshot({ signal: exec.signal })
  const data = await readScreenshotBytes(shot.path, path => readFile(path))
  const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: basename(shot.path) })
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }
}

/** 组装一次「读屏结果」。 */
function buildResult(fields) {
  return {
    app: fields.app ?? '',
    width: fields.width ?? 0,
    height: fields.height ?? 0,
    elapsed_ms: fields.elapsed_ms ?? 0,
    waited_ms: fields.waited_ms ?? 0,
    total: fields.total ?? 0,
    shown: fields.shown ?? 0,
    changed: fields.changed ?? false,
    delta: fields.delta ?? false,
    digest: fields.digest ?? '',
    tree: fields.tree ?? '',
    ...(fields.note === undefined ? {} : { note: fields.note }),
    ...(fields.image === undefined ? {} : { image: fields.image }),
  }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {object} config 运行时配置（见 {@link Config}）。
 */
export function apply(ctx, config = {}) {
  const settings = { ...Config({}), ...config }
  if (settings.enabled === false) return

  const reader = new ScreenReader(settings)
  ctx.effect(() => () => reader.reset(), 'dsh-screen-reader.reader')

  // 首次调用前先建好 loopback 连接：冷启动要多花 100~200 ms，预热后第一次读屏就是 10 ms 级。
  // 只打 /app/version（纯元信息），不碰屏幕 —— 免得一加载就弹出读屏授权确认。
  if (settings.warmup) {
    void bridge.bridgeVersion().catch(() => {})
  }

  const describeNote = text => (text ? { note: text } : {})

  if (settings.prompt) {
    ctx.inject(['systemPrompt'], promptCtx => {
      promptCtx.effect(
        () => promptCtx.systemPrompt.section({ name: SECTION, order: 151, text: PROMPT }),
        'dsh-screen-reader.prompt',
      )
    })
  }

  ctx.tools.register(defineTool({
    name: 'screen_read',
    description: [
      'Read the Android phone screen the agent is running on (accessibility tree over the DSHA bridge, ~10ms per read).',
      'Prefer this over shelling out to curl /app/ui/dump.',
      'By default it returns only the DELTA against the previous read in this session (see Δ in the header) — that is the cheap path; pass delta:false for a full frame.',
      'wait_ms blocks until the screen actually changes before reading: after a tap, wait instead of sleeping and re-reading.',
      'mode:"image" additionally attaches a screenshot (vision models only, costs image tokens); mode:"both" gives tree + image.',
      'find narrows to elements whose text contains the given substring.',
      'Line format: `[marks ]text (x,y)`; marks c=clickable d=disabled s=selected v=scrollable x=center unreliable (tap by text instead).',
    ].join(' '),
    parameters: {
      mode: {
        type: 'string',
        enum: ['tree', 'image', 'both'],
        description: 'tree (default) = accessibility tree only; image = screenshot only; both = text then screenshot.',
      },
      detail: {
        type: 'string',
        enum: ['compact', 'full'],
        description: 'compact (default) omits the bridge index and raw bounds; full adds `[index]` and `[l,t,r,b]`.',
      },
      delta: {
        type: 'boolean',
        description: 'Return only changes since the previous read in this session. Defaults to true; pass false for a full frame.',
      },
      find: {
        type: 'string',
        description: 'Keep only elements whose text contains this substring (case-insensitive). Use it instead of reading a wall of chat text.',
      },
      wait_ms: {
        type: 'integer',
        description: 'Block up to this many milliseconds waiting for the screen to change before reading. 0 (default) reads immediately.',
      },
      settle_ms: {
        type: 'integer',
        description: 'With wait_ms, require the new frame to stay unchanged this long before returning (avoids mid-animation frames). Default 0.',
      },
      max_elements: {
        type: 'integer',
        description: 'Cap on returned elements. Defaults to the deployment setting.',
      },
    },
    output: {
      schema: SCREEN_OUTPUT_SCHEMA,
      render: renderScreen,
    },
    timeoutMs: settings.maxWaitMs + 15_000,
    async execute(args, exec) {
      const state = stateFor(exec)
      const options = renderOptions(args, settings)
      const waitMs = clampInt(args.wait_ms, 0, 0, settings.maxWaitMs)
      const settleMs = clampInt(args.settle_ms, 0, 0, settings.maxWaitMs)
      const mode = args.mode ?? 'tree'
      const wantImage = mode === 'image' || mode === 'both'
      const wantTree = mode !== 'image'

      let sample
      let waitedMs = 0
      let note = ''

      if (waitMs > 0) {
        let baselineHash = state.last?.hash ?? null
        if (baselineHash === null) {
          try {
            baselineHash = (await reader.read({ signal: exec.signal })).hash
          } catch {
            baselineHash = null
          }
        }
        const outcome = await reader.waitForChange(baselineHash, {
          signal: exec.signal,
          timeoutMs: waitMs,
          settleMs,
        })
        waitedMs = outcome.waitedMs
        if (outcome.unreadable) {
          return buildResult({
            changed: true,
            delta: false,
            digest: '',
            tree: `屏幕暂不可读：${outcome.unreadable}`,
            note: '多半是锁屏或系统弹窗盖住了；按 home 键把界面叫回来再读。',
            waited_ms: waitedMs,
          })
        }
        if (!outcome.changed) {
          note = `等了 ${waitedMs}ms，屏幕没有变化。`
        }
        sample = outcome.sample ?? await reader.read({ signal: exec.signal })
      } else {
        sample = await reader.read({ signal: exec.signal })
      }

      const previous = state.last
      state.last = sample

      // 前台应用都换了（用户切了 App），增量没有意义，直接给全量。
      const sameContext = previous !== null && previous.snapshot.app === sample.snapshot.app
      const useDelta = args.delta !== false && sameContext

      const header = headerOf(sample.snapshot, sample)
      let total
      let shown
      let tree
      if (useDelta) {
        const delta = diffTree(previous.snapshot, sample.snapshot, options)
        const rendered = deltaText(delta, { title: header })
        tree = rendered.text
        total = delta.total
        shown = delta.lines.length
        if (rendered.unchanged && !note) note = '界面和上次一模一样；如果刚点过，说明那一下没打中。'
      } else if (wantTree) {
        const rendered = snapshotText(sample.snapshot, { ...options, title: header })
        tree = rendered.text
        total = rendered.total
        shown = rendered.shown
      } else {
        tree = `${header}\n（仅截图；需要文字结构时用 mode:"tree"）`
        total = 0
        shown = 0
      }

      let image
      if (wantImage) image = await captureImage(ctx, exec)

      return buildResult({
        app: sample.snapshot.app,
        width: sample.snapshot.width,
        height: sample.snapshot.height,
        elapsed_ms: sample.ms,
        waited_ms: waitedMs,
        total,
        shown,
        changed: previous === null || previous.hash !== sample.hash,
        delta: useDelta,
        digest: sample.hash,
        tree,
        ...describeNote(note),
        ...(image === undefined ? {} : { image }),
      })
    },
  }))

  if (settings.allowActions) {
    ctx.tools.register(defineTool({
      name: 'screen_act',
      description: [
        'Perform ONE action on the phone screen and return the resulting screen in the same call (act + observe in one round trip).',
        'action:"tap" prefers text (the visible label — control coordinates drift with scrolling and animation, text does not); use x/y only when no text is available.',
        'action:"input" types into the focused field (tap the field first if nothing is focused).',
        'action:"key" presses back / home / recents / notifications / quicksettings / lock.',
        'After the action it waits for the screen to settle and reports the DELTA; "Δ ... 无变化" means the action did not change anything.',
        'Set screenshot:true to also attach the post-action screenshot (vision models only).',
      ].join(' '),
      parameters: {
        action: {
          type: 'string',
          enum: ['tap', 'input', 'key', 'swipe', 'launch'],
          required: true,
          description: 'The action to perform.',
        },
        text: {
          type: 'string',
          description: 'For tap: the visible label to tap (exact or substring). For input: the text to type.',
        },
        x: { type: 'integer', description: 'tap: x coordinate (only without text). swipe: start x.' },
        y: { type: 'integer', description: 'tap: y coordinate (only without text). swipe: start y.' },
        x2: { type: 'integer', description: 'swipe: end x.' },
        y2: { type: 'integer', description: 'swipe: end y.' },
        key: {
          type: 'string',
          enum: ['back', 'home', 'recents', 'notifications', 'quicksettings', 'lock'],
          description: 'For action:"key".',
        },
        pkg: { type: 'string', description: 'For action:"launch": the exact application package name.' },
        ms: { type: 'integer', description: 'swipe duration in milliseconds. Default 300.' },
        wait_ms: { type: 'integer', description: 'How long to wait for the screen to settle after the action. Defaults to the deployment setting.' },
        screenshot: { type: 'boolean', description: 'Also attach the post-action screenshot. Default false.' },
        find: { type: 'string', description: 'Keep only delta/tree elements whose text contains this substring.' },
      },
      output: {
        schema: SCREEN_OUTPUT_SCHEMA,
        render: renderScreen,
      },
      timeoutMs: settings.maxWaitMs + 25_000,
      async execute(args, exec) {
        const state = stateFor(exec)
        const options = renderOptions({ ...args, detail: 'compact' }, settings)
        const before = await reader.read({ signal: exec.signal, force: true })

        await performAction(args, exec)

        // 启动应用要等冷启动，给它更长的默认预算。
        const defaultWait = args.action === 'launch' ? Math.max(settings.actionWaitMs, 4000) : settings.actionWaitMs
        const waitMs = clampInt(args.wait_ms, defaultWait, 0, settings.maxWaitMs)
        const outcome = await reader.waitForChange(before.hash, {
          signal: exec.signal,
          timeoutMs: waitMs,
          settleMs: settings.actionSettleMs,
        })

        let note = ''
        let sample = before
        if (outcome.unreadable) {
          const image = args.screenshot ? await captureImage(ctx, exec) : undefined
          return buildResult({
            changed: true,
            waited_ms: outcome.waitedMs,
            tree: `${args.action} 已执行，随后屏幕不可读：${outcome.unreadable}`,
            note: '如果是 lock，这是预期结果。',
            ...(image === undefined ? {} : { image }),
          })
        }
        if (outcome.changed) {
          sample = outcome.sample
          note = `动作后等了 ${outcome.waitedMs}ms 界面才变化。`
        } else {
          note = `动作后等了 ${outcome.waitedMs}ms 屏幕没有任何变化——这一下多半没打中，先 screen_read 看看当前界面。`
        }
        state.last = sample

        const header = headerOf(sample.snapshot, sample)
        const delta = diffTree(before.snapshot, sample.snapshot, options)
        const rendered = deltaText(delta, { title: `${args.action} → ${header}` })

        const image = args.screenshot ? await captureImage(ctx, exec) : undefined
        return buildResult({
          app: sample.snapshot.app,
          width: sample.snapshot.width,
          height: sample.snapshot.height,
          elapsed_ms: sample.ms,
          waited_ms: outcome.waitedMs,
          total: delta.total,
          shown: delta.lines.length,
          changed: outcome.changed,
          delta: true,
          digest: sample.hash,
          tree: rendered.text,
          ...describeNote(note),
          ...(image === undefined ? {} : { image }),
        })
      },
    }))
  }
}

/** 上面分支里用不到的小工具，保持可读性。 */
/**
 * 执行一次动作。
 * @param {object} args 工具参数。
 * @param {object} exec 执行上下文（取 signal）。
 * @returns {Promise<void>}
 */
async function performAction(args, exec) {
  const options = { signal: exec.signal }
  switch (args.action) {
    case 'tap': {
      const label = typeof args.text === 'string' ? args.text.trim() : ''
      if (label) {
        await bridge.tapText(label, options)
        return
      }
      if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) {
        throw new Error('tap 需要 text（推荐），或者同时给 x 和 y。')
      }
      await bridge.tapXY(args.x, args.y, options)
      return
    }
    case 'input': {
      if (typeof args.text !== 'string') throw new Error('input 需要 text。')
      await bridge.inputText(args.text, options)
      return
    }
    case 'key': {
      if (!args.key) throw new Error('key 需要 key 名（back/home/recents/notifications/quicksettings/lock）。')
      await bridge.pressKey(args.key, options)
      return
    }
    case 'swipe': {
      if (![args.x, args.y, args.x2, args.y2].every(Number.isFinite)) {
        throw new Error('swipe 需要 x, y, x2, y2。')
      }
      await bridge.swipe({ x: args.x, y: args.y }, { x: args.x2, y: args.y2 }, { ...options, ms: args.ms })
      return
    }
    case 'launch': {
      if (typeof args.pkg !== 'string' || !args.pkg.trim()) throw new Error('launch 需要 pkg（完整包名）。')
      await bridge.launchApp(args.pkg.trim(), options)
      return
    }
    default:
      throw new Error(`不支持的动作 "${args.action}"。`)
  }
}
