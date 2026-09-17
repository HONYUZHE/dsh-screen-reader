/**
 * 真实设备冒烟测试。不依赖 cordis，直接跑 lib/ 里的纯逻辑 + 打真桥。
 *
 *   node test/smoke.mjs            # 全量
 *   node test/smoke.mjs --quick    # 跳过等待/截图这类慢项
 *
 * @module dsh-screen-reader/test/smoke
 */

import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import * as bridge from '../lib/bridge.js'
import { ScreenReader, readScreenshotBytes } from '../lib/reader.js'
import { deltaText, diffTree, fingerprint, keyOf, parseDump, renderTree, snapshotText } from '../lib/tree.js'

const quick = process.argv.includes('--quick')
/** 会真的动手机界面的用例（下拉通知栏再复原）默认不跑，避免干扰用户。 */
const withUi = process.argv.includes('--with-ui')
let failures = 0
let checks = 0

function check(name, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

/** 估算 token：中文按 1 字 ≈ 1 token，ASCII 按 4 字符 ≈ 1 token。 */
function approxTokens(text) {
  let wide = 0
  let narrow = 0
  for (const char of text) {
    if (char.charCodeAt(0) > 0x2e80) wide += 1
    else narrow += 1
  }
  return Math.round(wide + narrow / 4)
}

const CONFIG = {
  cacheMs: 120,
  minIntervalMs: 60,
  maxIntervalMs: 240,
  retryDelayMs: 120,
  maxAttempts: 3,
  maxElements: 120,
  maxText: 96,
}

async function main() {
  section('解析器（合成用例）')
  const synthetic = [
    '窗口应用: com.example.app',
    '[1] "标题" 中心=(100,50) 区域=0,0,200,100',
    '[2] "带"引号"的按钮" 可点击 中心=(50,300) 区域=0,280,100,320',
    '[3]  可点击 中心=(10,10) 区域=5,5,10,10',
    '[4] "不可用的东西" 可点击 不可用 中心=(50,400) 区域=0,380,100,420',
    '[5] "很长的文字很长的文字很长的文字很长的文字很长的文字很长的文字" 中心=(500,500) 区域=0,480,1000,520',
    '[6] "退化宽度" 可点击 中心=(0,188) 区域=0,143,0,233',
    '[7] "滚动区" 可滚动 中心=(500,900) 区域=0,0,1000,1800',
    '[8]  中心=(700,700) 区域=600,600,800,800',
    '[9]  中心=(0,0) 区域=0,0,0,0',
  ].join('\n')
  const synthSnap = parseDump(synthetic)
  check('识别前台应用', synthSnap.app === 'com.example.app', synthSnap.app)
  check('屏幕尺寸取自最大区域', synthSnap.width === 1000 && synthSnap.height === 1800, `${synthSnap.width}x${synthSnap.height}`)
  const quoted = synthSnap.elements.find(el => el.index === 2)
  check('文字内含引号不截断', quoted?.text === '带"引号"的按钮', JSON.stringify(quoted?.text))
  const noText = synthSnap.elements.find(el => el.index === 3)
  check('无文字节点仍解析出可点', noText?.text === '' && noText?.clickable === true)
  const disabled = synthSnap.elements.find(el => el.index === 4)
  check('不可用标记生效', disabled?.clickable === true && disabled?.disabled === true)
  const degenerate = synthSnap.elements.find(el => el.index === 6)
  check('退化宽度被识别', degenerate?.degenerate === true)
  const scroll = synthSnap.elements.find(el => el.index === 7)
  check('可滚动标记生效', scroll?.scrollable === true)
  const syntheticRender = renderTree(synthSnap, { detail: 'compact', maxText: 20, maxElements: 50 })
  check('无文字纯容器被丢弃', !syntheticRender.lines.some(line => line.includes('(700,700)')))
  check('零面积节点被丢弃', !syntheticRender.lines.some(line => line.includes('(0,0)')))
  check('超长文字被截断', syntheticRender.lines.some(line => line.includes('…+')))
  check('退化宽度不给误导坐标', syntheticRender.lines.some(line => line.startsWith('cx ') && !line.includes('(')))
  check('find 过滤生效', renderTree(synthSnap, { find: '退化' }).lines.length === 1)

  section('指纹')
  check('同串同指纹', fingerprint('abc') === fingerprint('abc'))
  check('异串异指纹', fingerprint('abc') !== fingerprint('abd'))
  const fpStart = performance.now()
  for (let i = 0; i < 1000; i += 1) fingerprint(synthetic)
  const fpMs = (performance.now() - fpStart) / 1000
  check('指纹足够快（1KB×1000 次）', fpMs < 200, `${fpMs.toFixed(2)}ms/1000 次`)

  section('桥连通性')
  let version
  try {
    version = await bridge.bridgeVersion()
    console.log(version.trim().split('\n').map(line => `  ${line}`).join('\n'))
    check('桥可达', true)
  } catch (error) {
    check('桥可达', false, `${error.code}: ${error.message}`)
    console.log('\n桥不可用，后续真机项全部跳过。')
    return report()
  }

  const reader = new ScreenReader(CONFIG)
  try {
  section('读屏延迟（复用连接）')
  const timings = []
  let sample
  for (let i = 0; i < 12; i += 1) {
    const started = performance.now()
    sample = await reader.read({ force: true })
    timings.push(performance.now() - started)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const warm = timings.slice(1)
  const min = Math.min(...warm)
  const median = [...warm].sort((a, b) => a - b)[Math.floor(warm.length / 2)]
  check('单次读屏 < 60ms', median < 60, `最快 ${min.toFixed(1)}ms / 中位 ${median.toFixed(1)}ms（首次 ${timings[0].toFixed(1)}ms）`)

  section('压缩效果（同一帧）')
  const full = snapshotText(sample.snapshot, { detail: 'compact', maxElements: 120, maxText: 96, title: '# preview' })
  const rawTokens = approxTokens(sample.raw)
  const compactTokens = approxTokens(full.text)
  console.log(`  前台应用：${sample.snapshot.app}`)
  console.log(`  屏幕：${sample.snapshot.width}x${sample.snapshot.height}，元素 ${sample.snapshot.elements.length} 个`)
  console.log(`  原始 dump ${sample.raw.length} 字节 ≈ ${rawTokens} token`)
  console.log(`  压缩输出 ${full.text.length} 字节 ≈ ${compactTokens} token（${full.shown} 条）`)
  check('压缩后至少省一半 token', compactTokens * 2 <= rawTokens, `省 ${Math.round((1 - compactTokens / rawTokens) * 100)}%`)
  console.log('  --- 压缩输出预览（前 8 行）---')
  console.log(full.text.split('\n').slice(0, 9).map(line => `  | ${line}`).join('\n'))

  section('增量差分')
  const same = diffTree(sample.snapshot, sample.snapshot, {})
  check('同一帧判定无变化', same.identical === true, JSON.stringify({ added: same.added, removed: same.removed }))
  const renderedSame = deltaText(same, { title: '# test' })
  check('无变化输出极短', approxTokens(renderedSame.text) < 20, renderedSame.text)

  // 挑一个「只出现一次」的元素做消失用例：真实屏幕上有大量重复文字（列表项/对话），
  // 按文字作键时重复项本就不该算作消失，所以必须挑唯一的那个才能验证语义。
  const counts = new Map()
  for (const element of sample.snapshot.elements) {
    const key = keyOf(element)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const uniqueKey = [...counts.entries()].find(([, count]) => count === 1)?.[0]
  const mutated = {
    ...sample.snapshot,
    elements: [
      ...sample.snapshot.elements.filter(element => keyOf(element) !== uniqueKey),
      { ...sample.snapshot.elements[0], index: 9999, text: '凭空出现的按钮', clickable: true, cx: 42, cy: 42 },
    ],
  }
  const changed = diffTree(sample.snapshot, mutated, {})
  check('能看出新增', changed.added === 1, `+${changed.added}`)
  check('能看出消失', changed.removed === 1 && uniqueKey !== undefined, `-${changed.removed}`)
  const renderedChanged = deltaText(changed, { title: '# test' })
  check('增量输出远小于全量', approxTokens(renderedChanged.text) < compactTokens, `Δ≈${approxTokens(renderedChanged.text)} vs 全量≈${compactTokens} token`)

  section('缓存')
  const first = await reader.read({})
  const second = await reader.read({})
  check('TTL 内命中缓存', second.cached === true && second.hash === first.hash)
  const forced = await reader.read({ force: true })
  check('force 绕过缓存', forced.cached === false)

  section('等待界面变化')
  const unchanged = await reader.waitForChange(sample.hash, { timeoutMs: 700, settleMs: 0 })
  check('无变化时如实返回（不是假装变了）', unchanged.changed === false, `等了 ${unchanged.waitedMs}ms`)

  if (!quick && withUi) {
    section('等待真实变化（下拉通知栏，随后复原）')
    const baseline = await reader.read({ force: true })
    const started = performance.now()
    const waitPromise = reader.waitForChange(baseline.hash, { timeoutMs: 8000, settleMs: 120 })
    await new Promise(resolve => setTimeout(resolve, 120))
    await bridge.pressKey('notifications')
    const outcome = await waitPromise
    if (outcome.changed) {
      const delta = diffTree(baseline.snapshot, outcome.sample.snapshot, {})
      const roundTrip = performance.now() - started
      check('等到变化并给出增量', delta.added + delta.removed + delta.moved + delta.changed > 0,
        `等 ${outcome.waitedMs}ms（含动作），Δ +${delta.added} -${delta.removed} ~${delta.moved}`)
      check('「动作→看到变化」总耗时 < 3s', roundTrip < 3000, `${roundTrip.toFixed(0)}ms（含系统下拉动画与通知内容加载）`)
      console.log('  --- 增量预览 ---')
      console.log(deltaText(delta, { title: '# Δ' }).text.split('\n').slice(0, 7).map(line => `  | ${line}`).join('\n'))
    } else {
      check('等到变化并给出增量', false, '8s 内没检测到变化')
    }
    await bridge.pressKey('back')
    await new Promise(resolve => setTimeout(resolve, 400))

    section('截图 → 容器可读')
    const shot = await bridge.screenshot({})
    const startedShot = performance.now()
    const bytes = await readScreenshotBytes(shot.path, path => readFile(path))
    check('截屏可读且是合法 PNG',
      bytes.byteLength > 0 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
      `${shot.path} ${shot.width}x${shot.height} ${(bytes.byteLength / 1024).toFixed(0)}KB，桥+读盘 ${(performance.now() - startedShot).toFixed(0)}ms`)
  }

  } catch (error) {
    check('真机读屏可用', false, `${error.code ?? 'ERROR'}: ${String(error.message).slice(0, 80)}${error.hint ? ` — ${error.hint}` : ''}`)
  }

  section('错误分类')
  // 回归用例：屏幕正文里出现错误句子时，绝不能把成功的 dump 判成故障。
  const longDump = [
    '窗口应用: com.dsh.client',
    '[1] "讨论：[ERR] 你拒绝了这次屏幕读取 是什么意思" 中心=(10,10) 区域=0,0,20,20',
    '[2] "还有 无障碍服务未开启 这个提示" 中心=(20,20) 区域=0,0,30,30',
  ].join('\n')
  check('正文含同名字词不误判', bridge.classifyResult(longDump) === undefined,
    String(bridge.classifyResult(longDump)?.code))
  check('真正的拒绝被识别', bridge.classifyResult('[ERR] 你拒绝了这次屏幕读取')?.code === 'SCREEN_DENIED')
  check('截屏拒绝被识别', bridge.classifyResult('[ERR] 你拒绝了这次截屏')?.code === 'SCREEN_DENIED')
  check('越权被识别', bridge.classifyResult('[UNAUTHORIZED]')?.code === 'UNAUTHORIZED')
  check('锁屏读不到被识别', bridge.classifyResult('[ERR] 取不到当前窗口（可能停在锁屏或系统弹窗上）')?.code === 'ERR')
  // 无障碍被关掉跟「锁屏读不到」是两回事：该去的地方不同，提示也不能是「先按 home」。
  check('无障碍没开单独归类', bridge.classifyResult('[ERR] 无障碍服务未开启。请让用户在 DSHA「配置」页点「屏幕操作权限」')?.code === 'A11Y_OFF')
  try {
    await bridge.bridgeCall('/app/definitely-not-an-endpoint')
    check('未知端点被识别', false, '没有报错')
  } catch (error) {
    check('未知端点被识别', error instanceof bridge.BridgeError, `${error.code}: ${String(error.message).slice(0, 60)}`)
  }

  return report()
}

function report() {
  console.log(`\n=== 结果：${checks - failures}/${checks} 通过 ===`)
  if (failures > 0) {
    console.log(`${failures} 项失败`)
    process.exitCode = 1
  }
  return failures
}

await main()
