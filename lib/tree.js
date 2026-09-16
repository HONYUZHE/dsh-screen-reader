/**
 * 无障碍树的解析、压缩与差分渲染。**纯函数，不碰网络**，便于离线测试。
 *
 * 为什么要自己再解析一遍桥的 dump：桥给的原始文本为了通用，每行都带
 * `中心=(x,y) 区域=l,t,r,b`，一个聊天界面实测 **15 KB ≈ 5k token**；而模型真正
 * 需要的只是「哪些可点、叫什么、在哪」。这里做四件事把成本压下来：
 *
 *   1. 丢掉纯容器（无文字且不可点）和退化面积的节点；
 *   2. 超长文字截断（手机屏幕上经常整段显示上一轮对话，属于噪声）；
 *   3. 同一帧内按「文字+位置」去重；
 *   4. 相对上一帧只输出增量（新增 / 消失 / 位移 / 状态变化）。
 *
 * 解析必须容错：文字里可能带引号（实测 `..."builtin" ones...`），所以取文字用
 * 最后一个引号做右界，而不是正则的懒惰匹配。
 *
 * 行格式（compact）：`[标记 ]文字 (x,y)`；标记 c=可点 d=不可用 s=已选中
 * v=可滚动 x=坐标为 0 不可靠。full 模式额外给 `[序号]` 与 `[l,t,r,b]`。
 *
 * @module dsh-screen-reader/tree
 */

/** 已知状态词；未知词也保留，只做归类。 */
const KNOWN_FLAGS = new Set([
  '可点击', '可长按', '可滚动', '可获得焦点', '可编辑', '可勾选',
  '不可用', '已选中', '已勾选', '已展开', '已折叠', '密码', '弹窗', '多行',
])

const TAIL_RE = /中心=\((-?\d+),\s*(-?\d+)\)\s*区域=(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*$/
const CENTER_ONLY_RE = /中心=\((-?\d+),\s*(-?\d+)\)\s*$/

/**
 * 解析一行元素。
 * @param {number} index 桥给的序号。
 * @param {string} body `[n]` 之后的全部内容。
 * @returns {object} 结构化元素。
 */
function parseElement(index, body) {
  let rest = body
  let bounds = null
  let center = null

  const tail = TAIL_RE.exec(rest)
  if (tail) {
    center = [Number(tail[1]), Number(tail[2])]
    bounds = [Number(tail[3]), Number(tail[4]), Number(tail[5]), Number(tail[6])]
    rest = rest.slice(0, tail.index)
  } else {
    const only = CENTER_ONLY_RE.exec(rest)
    if (only) {
      center = [Number(only[1]), Number(only[2])]
      rest = rest.slice(0, only.index)
    }
  }

  let text = ''
  let flagText = rest
  if (rest.startsWith('"')) {
    // 文字里可能含 `"`，所以右界取最后一个引号。
    const close = rest.lastIndexOf('"')
    if (close > 0) {
      text = rest.slice(1, close)
      flagText = rest.slice(close + 1)
    }
  }

  const words = flagText.trim().split(/\s+/).filter(Boolean)
  const extra = words.filter(word => !KNOWN_FLAGS.has(word))
  const flags = new Set(words.filter(word => KNOWN_FLAGS.has(word)))
  if (extra.length) flags.add(extra.join(' '))

  const width = bounds ? bounds[2] - bounds[0] : null
  const height = bounds ? bounds[3] - bounds[1] : null
  const [cx, cy] = center ?? (bounds
    ? [Math.round((bounds[0] + bounds[2]) / 2), Math.round((bounds[1] + bounds[3]) / 2)]
    : [0, 0])

  return {
    index,
    text,
    flags: [...flags],
    clickable: flags.has('可点击') || flags.has('可长按') || flags.has('可勾选') || flags.has('可编辑'),
    disabled: flags.has('不可用'),
    selected: flags.has('已选中') || flags.has('已勾选'),
    scrollable: flags.has('可滚动'),
    bounds,
    cx,
    cy,
    width,
    height,
    /** 面积为 0 → 桥给的中心点不可靠，按坐标点按会打偏。 */
    degenerate: bounds !== null && (width <= 0 || height <= 0),
  }
}

/**
 * 解析一次 dump。
 * @param {string} raw 桥返回的原始 dump 文本。
 * @returns {{ app: string, width: number, height: number, elements: object[], raw: string }} 屏幕快照。
 */
export function parseDump(raw) {
  const text = typeof raw === 'string' ? raw : String(raw ?? '')
  const elements = []
  let app = ''
  let width = 0
  let height = 0

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const head = /^\[(\d+)\]\s*([\s\S]*)$/.exec(trimmed)
    if (!head) {
      const appLine = /^窗口应用[：:]\s*(.+)$/.exec(trimmed)
      if (appLine) app = appLine[1].trim()
      continue
    }
    const element = parseElement(Number(head[1]), head[2])
    if (element.bounds) {
      if (element.bounds[2] > width) width = element.bounds[2]
      if (element.bounds[3] > height) height = element.bounds[3]
    }
    elements.push(element)
  }

  return { app, width, height, elements, raw: text }
}

/**
 * 差分用的稳定身份。
 *
 * 优先用文字：列表滚动时位置全变但文字不变，用文字做键才能得到「只有几条新增」这种
 * 便宜结果。没有文字（图标按钮）才退化成位置键。
 * @param {object} element 元素。
 * @returns {string} 键。
 */
export function keyOf(element) {
  return element.text ? `t:${element.text}` : `p:${element.cx},${element.cy}`
}

/** 该节点是否值得给模型看。 */
function isNoise(element) {
  if (element.width !== null && element.height !== null && element.width <= 0 && element.height <= 0) return true
  if (element.degenerate && !element.text) return true
  return !element.text && !element.clickable
}

/** 状态标记串，如 `c`、`cd`、`cx`。 */
function marksOf(element) {
  const marks = []
  if (element.clickable) marks.push('c')
  if (element.disabled) marks.push('d')
  if (element.selected) marks.push('s')
  if (element.scrollable) marks.push('v')
  if (element.degenerate) marks.push('x')
  return marks.join('')
}

/** 截断超长文字，并标注被砍掉的字数。 */
function clip(text, maxText) {
  if (text.length <= maxText) return text
  return `${text.slice(0, maxText)}…+${text.length - maxText}`
}

/**
 * 单行渲染。
 * @param {object} element 元素。
 * @param {'compact'|'full'} detail 详细程度。
 * @param {number} maxText 文字上限。
 * @returns {string} 一行文本。
 */
export function formatLine(element, detail = 'compact', maxText = 96) {
  const marks = marksOf(element)
  const label = element.text ? clip(element.text, maxText) : '(无文字)'
  const coords = element.degenerate ? '' : ` (${element.cx},${element.cy})`
  const head = detail === 'full' ? `[${element.index}] ` : ''
  const bounds = detail === 'full' && element.bounds ? ` [${element.bounds.join(',')}]` : ''
  return `${head}${marks ? `${marks} ` : ''}${label}${coords}${bounds}`.trimEnd()
}

/**
 * 把一帧过滤成候选条目（去噪 + find 过滤 + 去重）。
 * @param {object} snapshot 快照。
 * @param {string} find 文字过滤子串（不区分大小写）。
 * @returns {object[]} 候选条目。
 */
function candidatesOf(snapshot, find) {
  const needle = find ? String(find).toLowerCase() : ''
  const out = []
  const seen = new Set()
  for (const element of snapshot.elements) {
    if (isNoise(element)) continue
    if (needle && !element.text.toLowerCase().includes(needle)) continue
    const mark = `${element.text}|${element.cx},${element.cy}`
    if (seen.has(mark)) continue
    seen.add(mark)
    out.push(element)
  }
  return out
}

/**
 * 渲染一帧（或一帧的过滤子集）为紧凑文本。
 * @param {object} snapshot {@link parseDump} 的结果。
 * @param {object} [options] 渲染选项。
 * @param {'compact'|'full'} [options.detail] 详细程度。
 * @param {number} [options.maxElements] 最多输出多少条，超出时优先保留可点条目。
 * @param {number} [options.maxText] 单条文字上限。
 * @param {string} [options.find] 只保留文字命中该子串的条目（不区分大小写）。
 * @returns {{ lines: string[], total: number, shown: number, omitted: number, matched: number }} 渲染结果。
 */
export function renderTree(snapshot, options = {}) {
  const { detail = 'compact', maxElements = 120, maxText = 96, find = '' } = options
  const rendered = candidatesOf(snapshot, find)
  const matched = rendered.length

  let selected = rendered
  let omitted = 0
  if (rendered.length > maxElements) {
    const actionable = rendered.filter(element => element.clickable)
    selected = actionable.length >= maxElements
      ? actionable.slice(0, maxElements)
      : rendered.slice(0, maxElements)
    omitted = rendered.length - selected.length
  }

  return {
    lines: selected.map(element => formatLine(element, detail, maxText)),
    total: rendered.length,
    shown: selected.length,
    omitted,
    matched,
  }
}

/**
 * 对比两帧，产出只含变化的增量描述。
 * @param {object} previous 上一帧快照。
 * @param {object} current 当前帧快照。
 * @param {object} [options] 与 {@link renderTree} 相同的渲染选项。
 * @returns {{ lines: string[], added: number, removed: number, moved: number, changed: number, identical: boolean, total: number }} 增量。
 */
export function diffTree(previous, current, options = {}) {
  const { detail = 'compact', maxElements = 120, maxText = 96, find = '' } = options

  const pick = snapshot => {
    const map = new Map()
    for (const element of candidatesOf(snapshot, find)) {
      const key = keyOf(element)
      if (!map.has(key)) map.set(key, element)
    }
    return map
  }

  const before = pick(previous)
  const after = pick(current)
  const lines = []
  let added = 0
  let removed = 0
  let moved = 0
  let changed = 0

  for (const [key, element] of after) {
    const old = before.get(key)
    const label = clip(element.text || '(无文字)', maxText)
    if (!old) {
      added += 1
      if (lines.length < maxElements) lines.push(`+ ${formatLine(element, detail, maxText)}`)
      continue
    }
    const movedFar = Math.abs(element.cx - old.cx) > 6 || Math.abs(element.cy - old.cy) > 6
    const oldMarks = marksOf(old)
    const newMarks = marksOf(element)
    if (movedFar) {
      moved += 1
      if (lines.length < maxElements) {
        lines.push(`~ ${label} (${old.cx},${old.cy})→(${element.cx},${element.cy})`)
      }
    } else if (oldMarks !== newMarks) {
      changed += 1
      if (lines.length < maxElements) {
        lines.push(`~ ${label} 状态 ${oldMarks || '—'}→${newMarks || '—'}`)
      }
    }
  }

  for (const [key, element] of before) {
    if (after.has(key)) continue
    removed += 1
    if (lines.length < maxElements) lines.push(`- ${clip(element.text || '(无文字)', maxText)}`)
  }

  const identical = added === 0 && removed === 0 && moved === 0 && changed === 0
  return { lines, added, removed, moved, changed, identical, total: after.size }
}

/**
 * 把一帧渲染成完整的模型可见文本（表头 + 条目）。
 * @param {object} snapshot 快照。
 * @param {object} [options] 渲染选项。
 * @param {string} [options.title] 表头前缀。
 * @returns {{ text: string, total: number, shown: number, omitted: number }} 文本与统计。
 */
export function snapshotText(snapshot, options = {}) {
  const { lines, total, shown, omitted } = renderTree(snapshot, options)
  const header = options.title ?? ''
  if (!lines.length) return { text: `${header}（无匹配条目，共 0 条）`, total, shown, omitted }
  const trailer = omitted > 0
    ? `\n… 省略 ${omitted} 条（候选共 ${total} 条；用 find 收窄、或 detail:"full"、或调大 max_elements）`
    : ''
  return { text: `${header}\n${lines.join('\n')}${trailer}`, total, shown, omitted }
}

/**
 * 把差分渲染成完整的模型可见文本。
 * @param {object} delta {@link diffTree} 的结果。
 * @param {object} [options] 渲染选项。
 * @param {string} [options.title] 表头前缀。
 * @returns {{ text: string, unchanged: boolean }} 文本。
 */
export function deltaText(delta, options = {}) {
  const header = options.title ?? ''
  const stats = `Δ +${delta.added} -${delta.removed}${delta.moved ? ` ↔${delta.moved}` : ''}${delta.changed ? ` ~${delta.changed}` : ''}`
  if (delta.identical) return { text: `${header} ${stats} 无变化`, unchanged: true }
  return { text: `${header} ${stats}\n${delta.lines.join('\n')}`, unchanged: false }
}

/**
 * 屏幕指纹：对原始 dump 做 FNV-1a 32 位散列。
 *
 * 用来判断「有没有变」——比解析后再比结构便宜一个数量级（15 KB 字符串 < 0.1 ms），
 * 所以等待循环可以放心地 60 ms 一次地轮询。
 * @param {string} text 原始 dump。
 * @returns {string} 8 位十六进制指纹。
 */
export function fingerprint(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
