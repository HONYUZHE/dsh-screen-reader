/**
 * reader 层单元测试：**注入假 dump**，把重试逻辑钉死。
 *
 * 这些路径靠真机很难稳定复现（退化帧只在界面过渡那一瞬间出现），但一旦回归，
 * 模型就会收到「假界面」或莫名其妙的失败 —— 所以必须用假桥把它测死。
 *
 *   node test/reader-unit.mjs
 *
 * @module dsh-screen-reader/test/reader-unit
 */

import { ScreenReader, isDegenerateFrame, readScreenshotBytes, sleep } from '../lib/reader.js'
import { BridgeError } from '../lib/bridge.js'

let failures = 0
let checks = 0
function check(name, condition, detail = '') {
  checks += 1
  if (condition) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const CONFIG = {
  cacheMs: 0,
  minIntervalMs: 20,
  maxIntervalMs: 60,
  retryDelayMs: 5,
  maxAttempts: 3,
  maxElements: 50,
  maxText: 60,
}

const GOOD = '窗口应用: com.demo\n[1] "标题" 中心=(500,100) 区域=0,0,1000,200\n[2] "确定" 可点击 中心=(800,900) 区域=700,860,900,940'
const DEGENERATE = '窗口应用: com.demo\n[1]  可点击 中心=(500,500) 区域=0,0,1000,1000'

/** 造一个按脚本出牌的假 dump。 */
function scriptedDump(steps) {
  let i = 0
  const calls = []
  const fake = async () => {
    calls.push(i)
    const step = steps[Math.min(i, steps.length - 1)]
    i += 1
    if (typeof step === 'function') return step()
    if (step instanceof Error) throw step
    return step
  }
  fake.calls = calls
  return fake
}

function transientError() {
  return new BridgeError('[ERR] 取不到当前窗口（可能停在锁屏或系统弹窗上）', 'ERR', '')
}

console.log('=== 退化帧判定 ===')
check('过渡帧（单节点无文字）判为退化', isDegenerateFrame(DEGENERATE) === true)
check('正常帧不退化', isDegenerateFrame(GOOD) === false)
check('单节点但有文字不退化', isDegenerateFrame('窗口应用: x\n[1] "只有标题" 中心=(1,1) 区域=0,0,2,2') === false)
check('只有窗口应用行不误判', isDegenerateFrame('窗口应用: x') === false)
check('空串不误判', isDegenerateFrame('') === false)

console.log('\n=== 重试：瞬时无窗口 ===')
{
  const fake = scriptedDump([transientError(), transientError(), GOOD])
  const reader = new ScreenReader(CONFIG, { dump: fake })
  const sample = await reader.read({ force: true })
  check('两次 ERR 后成功', sample.snapshot.elements.length === 2, `尝试 ${sample.attempts} 次`)
  check('尝试次数正确', sample.attempts === 3, String(sample.attempts))
}

console.log('\n=== 重试：退化帧 ===')
{
  const fake = scriptedDump([DEGENERATE, GOOD])
  const reader = new ScreenReader(CONFIG, { dump: fake })
  const sample = await reader.read({ force: true })
  check('退化帧被跳过、重读到真界面', sample.snapshot.elements.length === 2, `尝试 ${sample.attempts} 次`)
  check('尝试次数正确', sample.attempts === 2, String(sample.attempts))
}

console.log('\n=== 退化帧一直存在时：尽力而为，不抛错 ===')
{
  const fake = scriptedDump([DEGENERATE])
  const reader = new ScreenReader(CONFIG, { dump: fake })
  const sample = await reader.read({ force: true })
  check('用满重试次数后返回最后一帧', sample.attempts === CONFIG.maxAttempts, `尝试 ${sample.attempts} 次`)
  check('不抛错', sample.snapshot.elements.length === 1)
}

console.log('\n=== 不可重试的错误：立刻抛出，不浪费重试 ===')
{
  const fake = scriptedDump([
    () => { throw new BridgeError('[POLICY_BLOCKED] 不执行', 'POLICY_BLOCKED', '') },
    GOOD,
  ])
  const reader = new ScreenReader(CONFIG, { dump: fake })
  let caught
  try {
    await reader.read({ force: true })
  } catch (error) {
    caught = error
  }
  check('POLICY_BLOCKED 直接抛出', caught?.code === 'POLICY_BLOCKED', String(caught?.code))
  check('没有重试', fake.calls.length === 1, `调用 ${fake.calls.length} 次`)
}

console.log('\n=== 拒绝授权：同样不重试（用户的决定） ===')
{
  const fake = scriptedDump([() => { throw new BridgeError('[ERR] 你拒绝了这次屏幕读取', 'SCREEN_DENIED', '') }, GOOD])
  const reader = new ScreenReader(CONFIG, { dump: fake })
  let caught
  try {
    await reader.read({ force: true })
  } catch (error) {
    caught = error
  }
  check('SCREEN_DENIED 直接抛出', caught?.code === 'SCREEN_DENIED', String(caught?.code))
  check('没有重试', fake.calls.length === 1, `调用 ${fake.calls.length} 次`)
}

console.log('\n=== 取消 ===')
{
  const controller = new AbortController()
  // 假桥尊重 signal：这样取消才会发生在「读取途中」，而不是被重试次数先跑完。
  const reader = new ScreenReader(CONFIG, { dump: async options => { await sleep(200, options.signal); return GOOD } })
  const pending = reader.read({ force: true, signal: controller.signal })
  setTimeout(() => controller.abort(new Error('用户取消')), 12)
  let caught
  try {
    await pending
  } catch (error) {
    caught = error
  }
  check('等待中可被取消', caught?.message === '用户取消', String(caught?.message))
  check('取消不会被桥错误码盖住', caught?.code === undefined, `code=${String(caught?.code)}`)
  const sleepController = new AbortController()
  const timing = (async () => {
    const started = Date.now()
    sleepController.abort()
    try {
      await sleep(5000, sleepController.signal)
    } catch {
      return Date.now() - started
    }
    return -1
  })()
  check('sleep 立即响应取消', (await timing) < 200, `${await timing}ms`)
}

console.log('\n=== 截屏路径兜底 ===')
{
  const bytes = await readScreenshotBytes('/storage/emulated/0/Download/DSHA/x.png', async path => {
    if (path === '/sdcard/Download/DSHA/x.png') return new Uint8Array([1, 2, 3])
    throw Object.assign(new Error('nope'), { code: 'ENOENT' })
  })
  check('挂载点不同也能读到', bytes.length === 3)

  let message = ''
  try {
    await readScreenshotBytes('/storage/emulated/0/Download/DSHA/x.png', async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' })
    })
  } catch (error) {
    message = error.message
  }
  check('都读不到时给出可诊断信息', message.includes('试过') && message.includes('ENOENT'), message.slice(0, 70))
}

console.log(`\n=== 结果：${checks - failures}/${checks} 通过 ===`)
if (failures > 0) process.exitCode = 1
