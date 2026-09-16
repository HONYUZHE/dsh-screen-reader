/**
 * 最小 cordis 上下文里加载插件的验证脚本。
 *
 * 目的：在**不重启 DSHA Web** 的前提下，确认
 *   1. `apply()` 能跑通、两个工具能注册（defineTool 会在这里校验 schema）；
 *   2. 通过 ToolRuntime 真正 dispatch 一次，走完「参数校验 → 执行 → 输出校验 → render」全链路。
 *
 *   node test/plugin-load.mjs
 *
 * @module dsh-screen-reader/test/plugin-load
 */

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { ToolRuntime as RuntimeClass } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../lib/index.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 取一次 dispatch 结果的模型可见文本。 */
function failureText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  return blocks.map(block => block?.text ?? '').join(' ').trim()
}

/**
 * 设备侧「现在就是不给读屏」—— 授权被拒、无障碍没开、锁屏。
 * 这些不是插件的 bug，插件的正确行为恰恰是立刻原样转达，所以测试应当跳过而不是判失败。
 */
function isDeviceUnavailable(result) {
  if (!result?.isError) return false
  return /拒绝了这次|DISABLED|NO_PERMISSION|取不到当前窗口|连不上 DSHA 桥/.test(failureText(result))
}

console.log('=== 加载插件 ===')
const ctx = new Context()
// ToolRuntime 自己 inject 了 systemPrompt，缺它的话插件会一直挂在 pending，ctx.get('tools') 就是 undefined。
await ctx.plugin(SystemPrompt)
await ctx.plugin(RuntimeClass ?? ToolRuntime)
check('ToolRuntime 已挂载', ctx.get('tools') !== undefined)

try {
  await ctx.plugin(plugin, {})
  check('插件 apply() 未抛错', true)
} catch (error) {
  check('插件 apply() 未抛错', false, error.stack ?? String(error))
}

const names = ctx.tools.schemas().map(schema => schema.name)
console.log(`  已注册工具：${names.join(', ')}`)
check('screen_read 已注册', names.includes('screen_read'))
check('screen_act 已注册', names.includes('screen_act'))

const readSchema = ctx.tools.schemas().find(schema => schema.name === 'screen_read')
console.log('  screen_read 参数：' + Object.keys(readSchema?.parameters?.properties ?? {}).join(', '))
check('参数 schema 投影成功', readSchema?.parameters?.properties?.wait_ms?.type === 'integer')

console.log('\n=== 真实 dispatch（走完整管线）===')
let callCounter = 0
const dispatch = async (name, args) => {
  callCounter += 1
  return ctx.tools.execute({
    callId: `call-${callCounter}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

const first = await dispatch('screen_read', {})

// 设备侧拒绝读屏（授权被拒 / 关掉了无障碍）时，这不是插件的 bug：
// 插件的正确行为就是立刻把话原样转给用户。别把它报成失败，报成「跳过」。
if (isDeviceUnavailable(first)) {
  console.log(`  skip 设备当前不提供读屏：${failureText(first)}`)
  console.log('       （这是 App 侧的授权决定，不是插件问题；去「设置 → 设备能力授权」允许读屏后重跑）')
  console.log(`\n=== 结果：${failures === 0 ? '已注册并挂载，live 部分跳过' : `${failures} 项失败`} ===`)
  if (failures > 0) process.exitCode = 1
  await ctx.stop?.()
  process.exit(failures > 0 ? 1 : 0)
}

const firstValue = first?.value ?? first
console.log(`  第 1 次：delta=${firstValue?.delta} total=${firstValue?.total} digest=${firstValue?.digest}`)
check('首次读取成功', firstValue?.tree !== undefined)
check('首次给全量（无基线）', firstValue?.delta === false)
check('输出含文本', typeof firstValue?.tree === 'string' && firstValue.tree.length > 0)
check('render 产出 text 块', Array.isArray(first?.content) && first.content[0]?.type === 'text', first?.content?.[0]?.type)
console.log('  --- 输出前 6 行 ---')
console.log(String(firstValue?.tree ?? '').split('\n').slice(0, 6).map(line => `  | ${line}`).join('\n'))

const second = await dispatch('screen_read', {})
const secondValue = second?.value ?? second
check('第二次给增量', secondValue?.delta === true, `Δ 文本：${String(secondValue?.tree ?? '').split('\n')[0]}`)

const filtered = await dispatch('screen_read', { find: '设置', delta: false })
const filteredValue = filtered?.value ?? filtered
check('find 参数生效', filteredValue?.total !== undefined, `候选 ${filteredValue?.total} 条`)

const bad = await dispatch('screen_read', { wait_ms: '不是数字' })
check('非法参数被 schema 拦下', bad?.kind === 'error' || bad?.isError === true, `kind=${bad?.kind}`)
// 会真的动手机界面（按返回键）的用例默认不跑，避免干扰用户。
const withUi = process.argv.includes('--with-ui')

const acted = withUi
  ? await dispatch('screen_act', { action: 'key', key: 'back' })
  : undefined
if (withUi) {
  const actedValue = acted?.value ?? acted
  console.log(`  screen_act(key=back)：${String(actedValue?.tree ?? '').split('\n')[0]}`)
  check('screen_act 可用', actedValue?.tree !== undefined, `digest=${actedValue?.digest}`)
} else {
  console.log('  note 跳过 screen_act 真机动作（加 --with-ui 才跑，它会按真实按键）')
}

console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===`)
if (failures > 0) process.exitCode = 1
await ctx.stop?.()
