/**
 * DSHA 3090 桥客户端。
 *
 * 设计目标：**低延迟**。桥在 127.0.0.1 的 loopback 上，Node 内置 fetch(undici)
 * 默认对同一 origin 复用 TCP 连接，实测第 2 次起读屏只要 6~9 ms（新建连接要 200 ms+）。
 * 所以这里**禁止**在调用点自行拼 URL/换 origin，也**不要**用 curl 子进程 —— 那样每次
 * 都要重新握手，延迟直接翻 20 倍。
 *
 * 桥的返回统一是 `{"result": "<文本>"}`；错误也走 result，前缀标记区分：
 *   [ERR]              → 瞬时不可读（锁屏 / 系统弹窗 / 无窗口），可重试
 *   [POLICY_BLOCKED]   → 设备策略拒绝，重试无用
 *   [EXECUTION_UNKNOWN]→ 命令可能已执行，不能重放
 *   [UNAUTHORIZED]     → token 失效
 *   DISABLED/NO_PERMISSION → 用户在设置里没开该能力，重试无用
 *
 * @module dsh-screen-reader/bridge
 */

import { readFile } from 'node:fs/promises'

/** 桥的默认地址；容器内固定 127.0.0.1:3090。 */
export const BRIDGE_BASE = process.env.DSHA_BRIDGE_BASE || 'http://127.0.0.1:3090'

/** 桥 token 文件（App 写入，插件只读）。 */
const TOKEN_PATH = '/root/.dsh/.bridge_token'

/** 桥调用失败。`code` 是稳定分类，调用方据此决定「重试」还是「照原话转告用户」。 */
export class BridgeError extends Error {
  /**
   * @param {string} message 面向模型的说明。
   * @param {string} code 稳定错误码（ERR / POLICY_BLOCKED / BRIDGE_UNREACHABLE / …）。
   * @param {string} [hint] 给模型的下一步建议。
   */
  constructor(message, code = 'BRIDGE_ERROR', hint = '') {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.hint = hint
  }
}

let tokenCache

/**
 * 读取并缓存桥 token（首次调用读盘，之后走内存）。
 * @param {{ refresh?: boolean }} [options] 传 refresh 强制重读。
 * @returns {Promise<string>} token；读不到时返回空串（桥会回 UNAUTHORIZED）。
 */
export async function bridgeToken(options = {}) {
  if (options.refresh || tokenCache === undefined) {
    tokenCache = await readFile(TOKEN_PATH, 'utf8').then(text => text.trim()).catch(() => '')
  }
  return tokenCache
}

/** 丢弃缓存的 token（收到 UNAUTHORIZED 后调用一次）。 */
export function forgetToken() {
  tokenCache = undefined
}

/**
 * 判定一个 result 文本是错误还是正常值。**必须锚定行首行尾**，否则屏幕正文里
 * 出现同名单词（实测踩过）会把一次成功的 dump 误判成拒绝。
 * @param {string} result 桥返回的 result 文本。
 * @returns {{ code: string, hint: string } | undefined} 命中错误时返回分类。
 */
export function classifyResult(result) {
  const text = String(result ?? '').trim()
  // App 侧的读屏/截屏授权被拒：明确不是「锁屏读不到」，重试无用。
  // 必须**锚定整串**——屏幕上的对话正文里完全可能出现这句话（实测踩过），
  // 锚不住就会把一次成功的 dump 误判成拒绝。
  if (/^(?:\[ERR\]\s*)?你拒绝了这次(?:屏幕读取|截屏|屏幕|读取)$/.test(text)) {
    return { code: 'SCREEN_DENIED', hint: '' }
  }
  // 无障碍服务被关了 —— 这跟「锁屏读不到」完全是两回事，该去的地方也不同，
  // 所以单独分类，免得给模型一个误导性的「先按 home」建议。
  if (/^(?:\[ERR\]\s*)?无障碍服务未开启/.test(text)) return { code: 'A11Y_OFF', hint: '' }
  const marker = /^\[([A-Z_]{3,40})\]/.exec(text)
  if (marker) return { code: marker[1], hint: '' }
  const meta = /^(DISABLED|NO_PERMISSION|UNAUTHORIZED)\b/.exec(text)
  if (meta) return { code: meta[1], hint: '' }
  return undefined
}

/** 把错误码翻译成给模型的下一步建议。 */
function hintFor(code) {
  switch (code) {
    case 'ERR':
      return '屏幕当前不可读（锁屏 / 系统弹窗 / 无窗口）。等一小会儿再读，或先按 home 键把界面叫回来。'
    case 'SCREEN_DENIED':
      return '读屏/截屏授权被拒。这是用户的决定，不要重试、不要绕道 —— 照原话告诉用户去 DSHA「设置 → 设备能力授权」里允许屏幕读取。'
    case 'A11Y_OFF':
      return '无障碍服务没开，读屏和点按都不可能工作。照原话转告用户：DSHA「配置」页点「屏幕操作权限」，或到系统设置 → 无障碍 → DSHA 配对助手 打开。不要重试。'
    case 'UNAUTHORIZED':
      return '桥 token 失效，通常是 App 重启过。告诉用户去「设置 → 设备能力授权」确认桥可用。'
    case 'DISABLED':
      return '该能力默认关闭，需用户在 App 配置页勾选。照原话转告用户，不要重试。'
    case 'NO_PERMISSION':
      return '系统权限未授予（无障碍服务 / 截屏）。照原话转告用户去开，不要重试。'
    case 'POLICY_BLOCKED':
      return '设备策略拒绝执行，重试无用，也不要用其它通道绕过。'
    case 'EXECUTION_UNKNOWN':
      return '命令可能已执行。先读屏核对实际状态，不要自动重放。'
    default:
      return ''
  }
}

/**
 * 调用一个桥端点并返回 result 文本。
 *
 * @param {string} path 端点路径，如 `/app/ui/dump`。
 * @param {Record<string, string|number|boolean|undefined|null>} [params] 查询参数，自动 URL 编码。
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] 取消信号与超时。
 * @returns {Promise<string>} result 文本（正常值，不含错误标记）。
 * @throws {BridgeError} 连不上 / 超时 / 返回错误标记。
 */
export async function bridgeCall(path, params = {}, options = {}) {
  const { signal, timeoutMs = 10_000 } = options
  const token = await bridgeToken()
  const url = new URL(BRIDGE_BASE + path)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    url.searchParams.set(key, String(value))
  }
  if (token) url.searchParams.set('token', token)

  const budget = AbortSignal.timeout(timeoutMs)
  const composed = signal ? AbortSignal.any([signal, budget]) : budget
  let response
  try {
    response = await fetch(url, { signal: composed })
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    if (budget.aborted) {
      throw new BridgeError(`${path} 调用超时（${timeoutMs}ms）`, 'BRIDGE_TIMEOUT', '界面可能卡住了；重试一次或改用更小的请求。')
    }
    throw new BridgeError(
      `连不上 DSHA 桥（${BRIDGE_BASE}）：${error?.message ?? error}`,
      'BRIDGE_UNREACHABLE',
      '确认 DSHA App 正在运行、无障碍服务已开启。',
    )
  }

  let body
  try {
    body = await response.text()
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    throw new BridgeError(`读取 ${path} 响应失败：${error?.message ?? error}`, 'BRIDGE_READ_FAILED')
  }
  if (!response.ok) {
    throw new BridgeError(`${path} 返回 HTTP ${response.status}`, `BRIDGE_HTTP_${response.status}`)
  }

  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    throw new BridgeError(`${path} 返回非 JSON：${body.slice(0, 200)}`, 'BRIDGE_BAD_JSON')
  }

  const result = typeof payload?.result === 'string' ? payload.result : resultText(payload)
  const failure = classifyResult(result)
  if (failure) {
    if (failure.code === 'UNAUTHORIZED') forgetToken()
    throw new BridgeError(result, failure.code, hintFor(failure.code))
  }
  return result
}

/** 少数端点直接回对象；没有 result 时退化成 JSON 文本。 */
function resultText(payload) {
  return typeof payload === 'string' ? payload : JSON.stringify(payload ?? '')
}

/**
 * 读一次无障碍树（最核心的端点，实测 6~9 ms）。
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] 取消与超时。
 * @returns {Promise<string>} 原始 dump 文本。
 */
export function dump(options = {}) {
  return bridgeCall('/app/ui/dump', {}, { timeoutMs: 6000, ...options })
}

/**
 * 截屏并返回落盘信息。桥只回路径、不回 base64，所以这里返回路径由调用方读盘。
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] 取消与超时。
 * @returns {Promise<{ path: string, width: number, height: number }>} 截图信息。
 */
export async function screenshot(options = {}) {
  const result = await bridgeCall('/app/ui/screenshot', {}, { timeoutMs: 15_000, ...options })
  const match = /截屏已保存[：:]\s*(\S+?)(?:\s*[（(]\s*(\d+)\s*[x×]\s*(\d+)\s*[)）])?\s*$/.exec(result)
  if (!match) throw new BridgeError(result, 'SCREENSHOT_UNPARSED', '截屏返回格式不认识；可改用 mode:"tree"。')
  return {
    path: match[1],
    width: match[2] ? Number(match[2]) : 0,
    height: match[3] ? Number(match[3]) : 0,
  }
}

/** 按文字点按（推荐：文字不随滚动/动画变，控件位置会变）。 */
export function tapText(text, options = {}) {
  return bridgeCall('/app/ui/tap', { text }, options)
}

/** 按坐标点按（仅在没有文字可用时使用）。 */
export function tapXY(x, y, options = {}) {
  return bridgeCall('/app/ui/tap', { x, y }, options)
}

/** 向当前焦点输入框写文字。 */
export function inputText(text, options = {}) {
  return bridgeCall('/app/ui/input', { text }, options)
}

/** 发送系统按键：back / home / recents / notifications / quicksettings / lock。 */
export function pressKey(name, options = {}) {
  return bridgeCall('/app/ui/key', { name }, options)
}

/** 滑动。 */
export function swipe(from, to, options = {}) {
  return bridgeCall('/app/ui/swipe', {
    x1: from.x,
    y1: from.y,
    x2: to.x,
    y2: to.y,
    ms: options.ms ?? 300,
  }, options)
}

/** 启动应用（按包名）。 */
export function launchApp(pkg, options = {}) {
  return bridgeCall('/app/launch', { pkg }, options)
}

/** 读设备概览（机型 / 电量 / 屏幕 / 前台 App）。 */
export function deviceInfo(options = {}) {
  return bridgeCall('/app/device', {}, { timeoutMs: 8000, ...options })
}

/** 桥协议与 App 版本（特性探测用，判版本要用 >= 而不是 ==）。 */
export function bridgeVersion(options = {}) {
  return bridgeCall('/app/version', {}, { timeoutMs: 8000, ...options })
}
