# dsh-screen-reader

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![platform](https://img.shields.io/badge/platform-Android%20%C2%B7%20DSH-lightgrey.svg)

让大模型**实时看见** Android 屏幕的 [DSH](https://github.com/deepseek-ai/deepseek-harness) 插件。

读一屏 **10 毫秒级**；全量输出比原始无障碍树**省 61% token**，增量输出只要**约 30 token**；
「点一下再看结果」从三次工具调用压成**一次**。

> **English** — A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives
> vision-capable models real-time access to an Android screen. It reads the accessibility tree over the
> DSHA bridge (`127.0.0.1:3090`) in ~10 ms, returns **deltas** by default (≈30 tokens instead of ≈4100),
> can **block until the UI changes** instead of polling, and folds act-and-observe into a single tool
> call. Requires the DSHA Android app (the accessibility service owns the screen) — it is a plugin for a
> DSH profile, not a standalone npm package.

---

## 实测

同一台平板（Lenovo TB710FU · Android 16 · 3200×2000）上的真实数据：

```text
# 读屏延迟（复用连接）：最快 7.2 ms，中位 13.4 ms
── 让模型自己 bash + curl：200 ms 起

# 全量读屏：4108 token → 1605 token（省 61%）
$ screen_read {delta:false, max_elements:15}
# com.dsh.client 3200x2000 14:51:43 读屏100ms
c 新建会话 (310,188)
c 收起侧边栏 (635,188)
c 新建会话 (350,330)
c 搜索会话 (475,448)
c 视图选项 (555,448)
cd Android屏幕实时读取插件 (973,178)
… 省略 100 条（候选共 115 条；用 find 收窄、或 detail:"full"、或调大 max_elements）

# 增量读屏：约 30 token
$ screen_read {find:"插件"}
# com.dsh.client 3200x2000 14:59:12 读屏141ms Δ +2 -1 ↔8
+ 进行中 Android屏幕实时读取插件 9分钟 (350,633)
~ Android屏幕实时读取插件 (973,178)→(965,178)
- 进行中 Android屏幕实时读取插件 2分钟

# 动作 → 看到变化：一次工具调用
$ screen_act {action:"key", key:"notifications"}
key → # com.dsh.client 3200x2000 读屏10ms Δ +16 -113 ↔1
```

## 为什么快 / 为什么省

| 做法 | 单次读屏 | 一次「点按后看结果」的往返 | 一次读屏的 token |
| --- | --- | --- | --- |
| 让模型自己 `bash` + `curl /app/ui/dump` | 200 ms 起（每次新建进程 + 新建 TCP） | 3 次工具调用（点按 / sleep / 再读屏） | 4200（原始 dump） |
| 本插件 | **7~16 ms**（进程内复用 loopback 连接） | **1 次工具调用**（`screen_act` 内置回读） | 1600 全量 / **约 30 增量** |

四个关键设计：

1. **连接复用**。桥在 `127.0.0.1:3090`，Node 内置 `fetch` 对同源连接默认 keep-alive。
   实测第 2 次起 7 ms，而新起一个 `curl` 进程要 200 ms —— 差 20 倍。
2. **增量优先**。每次读屏按会话留一份指纹，默认只回「相对上一帧的变化」。
   界面没动时输出就是一行 `Δ +0 -0 无变化`。
3. **指纹先行**。判断「有没有变」只算原始 dump 的 32 位 FNV 散列（15 KB < 0.1 ms），
   不解析、不比对结构。所以等待循环敢用 60 ms 轮询，做到「界面一变就知道」。
4. **自适应退避**。界面刚变的头几百毫秒最该密集看，之后从 60 ms 逐步放慢到 240 ms，
   长等待不会把手机 CPU 打满。

## 工作原理

```text
模型
 │  screen_read / screen_act                        ← 2 个工具，schema 合计约 250 token
 ▼
lib/index.js      Cordis 插件：注册工具、会话级增量状态
 ▼
lib/reader.js     120ms 采样缓存 · 可取消 sleep · 60ms 自适应轮询 · 瞬时态重试
 ▼
lib/tree.js       纯函数：解析 dump → 压缩渲染 → 增量差分 → FNV 指纹
 ▼
lib/bridge.js     keep-alive fetch · 超时 · 把桥的错误标记分类成稳定错误码
 ▼
127.0.0.1:3090    DSHA 无障碍服务（App 侧持有屏幕）
```

## 安装

**这不是一个能独立 `npm install` 的包** —— 它依赖 DSH 提供的 `tools` / `systemPrompt` 服务，
必须挂进一个 DSH profile。`peerDependencies` 里的 `@deepseek-ai/*` 由 DSH 安装自带，
不要单独装（npm 上公开的版本比 DSH 自带的旧）。

### DSHA（Android）

```bash
# 1. 放到 DSH 能解析到的位置：/root/dsha-<去掉 dsh- 前缀>
git clone https://github.com/HONYUZHE/dsh-screen-reader.git /root/dsha-screen-reader

# 2. 给它一层指向 DSH 运行时的 node_modules 软链（peer 依赖由此解析）
ln -sfn ../../usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules \
        /root/dsha-screen-reader/node_modules

# 3. 登记为内置插件
cd / && echo 'dsh-screen-reader' >> /root/dsha-builtin.txt
cd / && python3 /root/.dsh/register-builtin-plugins.py

# 4. 确认插件进了树
dsh --profile web --dump-config | grep -A2 screen-reader
```

然后**重启 DSHA Web**（DSH 的插件树只在启动时 compose）。

> ⚠️ 第 3 步必须在 `/` 下执行：注册脚本里的 `dsha-builtin.txt` 是**相对当前目录**的
> `root/dsha-builtin.txt`，换个目录跑会静默退回兜底清单，插件根本不会被注册。

### 通用 DSH profile

把仓库放到任意位置，然后在 `$DSH_HOME/profiles/<profile>/package.json` 里接上：

```json
{
  "dependencies": { "dsh-screen-reader": "link:/path/to/dsh-screen-reader" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-screen-reader"] } }
}
```

并同样给它一层指向 DSH 运行时的 `node_modules` 软链。

## 两个工具

### `screen_read` —— 读屏

| 参数 | 说明 |
| --- | --- |
| `mode` | `tree`（默认，无障碍树）/ `image`（只截图）/ `both` |
| `detail` | `compact`（默认）/ `full`（补上桥的序号与 `[l,t,r,b]` 区域） |
| `delta` | 默认 `true`，只回相对上次的变化；`false` 强制全量 |
| `find` | 只保留文字含该子串的条目（不区分大小写）—— 在聊天/长列表界面上最省 |
| `wait_ms` | 先阻塞等界面变化再读（`0` = 立刻读）。**这是最省的实时用法** |
| `settle_ms` | 配合 `wait_ms`：要求新画面稳定这么久才返回，避免抓到动画中间帧 |
| `max_elements` | 返回条目上限 |

行格式：`[标记 ]文字 (x,y)`，标记 `c`=可点 `d`=不可用 `s`=已选中 `v`=可滚动
`x`=桥给的坐标不可靠（面积为 0，按文字点，别按坐标）。

### `screen_act` —— 动作后直接回读

`action: tap | input | key | swipe | launch`。一个来回完成「动手 + 看结果」。

- `tap` 优先用 `text`（**控件坐标随滚动/动画变，文字不变**），没文字才用 `x`/`y`；
- `key`：`back` / `home` / `recents` / `notifications` / `quicksettings` / `lock`；
- 动作后自动等画面稳定并返回增量；输出 `Δ ... 无变化` 就说明这一下没打中；
- `screenshot: true` 额外附上动作后的截图。

### 给模型的提示词

插件会注入一段约 150 token 的系统提示，核心就四条：优先用 `screen_read`（要等变化传 `wait_ms`，
别自己 sleep 轮询）；默认就是增量；点按优先按文字；只有没文字的界面（游戏、画布）才用 `mode:"image"`。
不想要就设 `prompt: false`。

## 配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里按 id 覆盖，例如关掉动作工具：

```yaml
- id: screen-reader
  config:
    allowActions: false
    actionSettleMs: 250
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `allowActions` | `true` | 是否注册 `screen_act`（只读审计可关） |
| `cacheMs` | `120` | 同一次调用内的采样缓存时长 |
| `minIntervalMs` / `maxIntervalMs` | `60` / `240` | 等待轮询的起始间隔与退避上限 |
| `maxAttempts` | `3` | 读屏最多尝试几次（超时 / 瞬时无窗口 / 退化帧都会重试） |
| `retryDelayMs` | `120` | 读屏重试前的等待 |
| `maxElements` | `120` | 全量输出的条目上限 |
| `maxText` | `96` | 单条文字截断长度 |
| `actionWaitMs` / `actionSettleMs` | `1500` / `150` | 动作后等变化的上限与要求的稳定时长 |
| `maxWaitMs` | `30000` | 单次调用允许的最长等待（协作式取消预算） |
| `prompt` | `true` | 是否注入那段简短的系统提示 |
| `warmup` | `true` | 加载时预热一次桥连接（只打 `/app/version`，不碰屏幕），消掉首次调用的 100~200 ms 建连开销 |

## 文件

| 文件 | 职责 |
| --- | --- |
| `lib/bridge.js` | 3090 桥客户端：连接复用、超时、把 `[ERR]/[POLICY_BLOCKED]/DISABLED/NO_PERMISSION` 分类成稳定错误码 + 给模型的下一步建议 |
| `lib/tree.js` | **纯函数**：解析 dump、压缩渲染、增量差分、屏幕指纹 |
| `lib/reader.js` | 采样缓存、可取消 sleep、`waitForChange` 轮询、瞬时态重试、截屏读盘 |
| `lib/index.js` | Cordis 插件：注册两个工具、系统提示段、会话级状态 |

## 测试

```bash
npm test                         # = test/reader-unit.mjs，纯逻辑，不需要设备

node test/reader-unit.mjs        # 注入假桥，把重试/退化帧/取消逻辑钉死
node test/plugin-load.mjs        # 最小 cordis 上下文里真加载 + 真 dispatch
node test/smoke.mjs              # 走真机：解析 / 延迟 / 压缩率 / 差分 / 缓存 / 等待 / 截图
node test/smoke.mjs --with-ui    # 额外跑「下拉通知栏 → 复原」验证真实变化检测
```

| 测试 | 需要 | 覆盖 |
| --- | --- | --- |
| `reader-unit.mjs` | 无 | 解析边界、压缩、差分、指纹、重试、退化帧、取消、截屏路径兜底 |
| `plugin-load.mjs` | DSH 运行时 | 真 `ToolRuntime` 加载、schema 投影、参数校验、输出校验、render 全链路 |
| `smoke.mjs` | DSH + DSHA 设备 | 真桥延迟、压缩率、增量、`waitForChange`、截屏可读性 |

两个测试值得单独说：

**`plugin-load.mjs`** 用真实的 `ToolRuntime` + `SystemPrompt` 起一个最小 cordis 上下文，
把插件挂上去并真的 dispatch 一次。**开发期就该跑它，别靠重启 Web 来验证** —— 它当场抓出过
「输出 schema 里 `image` 被 `required: true` 传染成必填」的 bug（不截图的那次调用会直接
`INVALID_TOOL_OUTPUT`，而重启验证要等到真正用图才会暴露）。

**`reader-unit.mjs`** 靠**注入假桥**覆盖真机难复现的路径。退化帧只在界面过渡那一瞬间出现，
用真机测不稳定，但一旦回归模型就会读到「假界面」，所以必须钉死。

## 已知边界

- **读屏/截屏被拒**（`[ERR] 你拒绝了这次屏幕读取`）：这是 App 侧的授权决定，
  插件会原样转告用户去「设置 → 设备能力授权」，**不重试、不绕道**。
- **锁屏 / 系统弹窗**：桥会回 `[ERR] 取不到当前窗口`，插件给出「先按 home 调回界面」的建议。
- **三种瞬时态**（实测都出现过，都会自愈，插件自动重试 ≤ `maxAttempts` 次）：
  1. `BRIDGE_TIMEOUT` —— App 的 Activity 刚切换时第一次 dump 可能几秒不返回；
  2. `[ERR] 取不到当前窗口` —— 界面过渡中短暂没有窗口；
  3. **退化帧** —— 过渡期只读到一个全屏、无文字的节点，把它当界面报给模型是误导。

  > 只对这三种重试。`POLICY_BLOCKED` / `SCREEN_DENIED` / `DISABLED` 一律立刻抛出：
  > 那是策略和用户的决定，重试不会让开关自己变。
- **截图代价**：2000×3200 的 PNG 约 0.7 MB，附件服务会按当前路由的像素预算自动降采样；
  但图片 token 比文字贵得多。**界面有文字时一律用 `tree`**，只有游戏/画布/图形按钮才用 `image`。
- **退化帧判据刻意收得很窄**（恰好一个节点且无文字），免得把真正的无字界面（游戏、画布）
  也卷进重试。如果你的场景误判了，把 `maxAttempts` 设成 `1` 即可关掉这层重试。
- **依赖设备**：所有读屏能力都来自 DSHA App 的无障碍服务，没有它这个插件什么都做不了。

## 开发笔记

几个踩过的坑，都是实测出来的，不是想出来的：

- **桥的错误文本不能全局正则匹配**。屏幕正文里完全可能出现
  「你拒绝了这次屏幕读取」（比如模型正在讨论这个错误），不锚定行首就会把一次**成功**的
  dump 误判成授权被拒。
- **`required: true` 会传染**。工具输出 schema 里复用一个 `{..., required: true}` 的对象字面量
  当可选属性，会把那个属性变成必填。`read_image` 里能这么写只是因为它永远返回图片。
- **不要为了省事把 profile 的 `patchReload` 改成 `live`**：Android 上 HMR 会因为缺
  `--expose-internals` 让 dsh 起不来。源码改动只能靠重启生效。
- **注册脚本的相对路径陷阱**：`dsha-builtin.txt` 是相对 cwd 解析的，不在 `/` 下跑就静默失效。

## License

[MIT](LICENSE) © 2026 HONYUZHE
