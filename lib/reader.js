/**
 * 采样、缓存与「等界面变化」。**这一层决定「实时」的体感**。
 *
 * 关键设计：
 *  - **极短 TTL 缓存**：同一轮里 `screen_read` 之后紧跟一次截图/复核，不必再打一次桥；
 *    但 TTL 只有 ~120 ms，不会让模型看到过期界面。
 *  - **指纹先行**：判断「有没有变」只看原始 dump 的 32 位散列，不解析、不比对结构，
 *    单次 < 0.1 ms。所以等待循环可以 60 ms 一次地轮询 —— 桥走 loopback 且复用连接，
 *    实测一次读屏 6~9 ms，整轮延迟远低于人类感知阈值。
 *  - **自适应退避**：界面刚变的头几百毫秒是最该密集看的（动画/跳转），之后逐步放慢到
 *    240 ms，既保住「秒回」体感，又不会在长等待里把手机 CPU 打满。
 *  - **变化后可选稳定期**：`settleMs` 要求新画面连续保持同一指纹，避免抓到动画中间帧。
 *
 * @module dsh-screen-reader/reader
 */

import { dump } from './bridge.js'
import { fingerprint, parseDump } from './tree.js'

/**
 * 退化帧：整个 dump 只有一个节点、且这个节点没有任何文字。
 *
 * 实测这是「界面正在过渡」的签名 —— 例如 App 刚重启时，无障碍服务只能看到一个
 * 全屏的、无文字的可点节点。把它当成真实界面报给模型会误导（模型会以为自己看到了
 * 一个空白页面），所以这种情况要重试而不是当成结果。
 *
 * 判据刻意收得很窄（**恰好一个节点**），免得把真正的无字界面（游戏、画布）也卷进重试。
 * @param {string} raw 原始 dump。
 * @returns {boolean} 是否是退化帧。
 */
export function isDegenerateFrame(raw) {
  let count = 0
  let withText = 0
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!/^\[\d+\]/.test(trimmed)) continue
    count += 1
    if (/^\[\d+\]\s*"/.test(trimmed)) withText += 1
    if (count > 1) return false
  }
  return count === 1 && withText === 0
}

/** 可取消的 sleep。 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 一次采样结果。 */
export class ScreenReader {
  /**
   * @param {object} config 插件配置（缓存时长、轮询区间等）。
   * @param {object} [deps] 可注入依赖，测试用。
   * @param {Function} [deps.dump] 读原始 dump 的实现，默认打真桥。
   */
  constructor(config, deps = {}) {
    this.config = config
    this.dump = deps.dump ?? dump
    this.cache = null
  }

  /** 丢弃缓存（配置热更或 token 变化后调用）。 */
  reset() {
    this.cache = null
  }

  /**
   * 取一次屏幕采样（默认走缓存）。
   * @param {object} [options] 选项。
   * @param {AbortSignal} [options.signal] 取消信号。
   * @param {boolean} [options.force] 忽略缓存强制重新读桥。
   * @param {number} [options.timeoutMs] 单次桥调用超时。
   * @returns {Promise<{ raw: string, hash: string, snapshot: object, at: number, ms: number, cached: boolean }>} 采样。
   */
  async read(options = {}) {
    const { signal, force = false, timeoutMs = 6000 } = options
    const now = Date.now()
    const ttl = this.config.cacheMs
    if (!force && this.cache && now - this.cache.at <= ttl) {
      return { ...this.cache, cached: true }
    }
    const started = performance.now()
    const { raw, attempts } = await this.fetchStable({ signal, timeoutMs })
    const ms = Math.round(performance.now() - started)
    const sample = {
      raw,
      hash: fingerprint(raw),
      snapshot: parseDump(raw),
      at: Date.now(),
      ms,
      attempts,
      cached: false,
    }
    this.cache = sample
    return sample
  }

  /**
   * 取一次**可用**的 dump，失败或退化就重试。
   *
   * 读屏是幂等的，重试永远安全。实测有三种瞬时态会自愈，但放任它们过去会让模型
   * 莫名其妙地失败、或者读到「假界面」：
   *   - `BRIDGE_TIMEOUT`：App 的 Activity 刚切换时，第一次 dump 可能几秒不返回；
   *   - `[ERR] 取不到当前窗口`：界面正在过渡（刚重启、动画中）时短暂没有窗口；
   *   - **退化帧**：过渡期会读到只有一个全屏节点、没有任何文字的「屏幕」——
   *     把它当成真实界面报给模型是误导，所以同样重试。
   *
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} options 取消与超时。
   * @returns {Promise<{ raw: string, attempts: number }>} 原始 dump 与实际尝试次数。
   */
  async fetchStable(options) {
    const limit = Math.max(1, this.config.maxAttempts)
    let lastError
    for (let attempt = 1; attempt <= limit; attempt += 1) {
      try {
        const raw = await this.dump(options)
        if (attempt >= limit || !isDegenerateFrame(raw)) return { raw, attempts: attempt }
      } catch (error) {
        // 取消优先于错误本身：把 caller 的取消原因原样抛出去，别让它被桥的错误码盖住。
        if (options.signal?.aborted) throw options.signal.reason ?? error
        if (error?.code !== 'BRIDGE_TIMEOUT' && error?.code !== 'ERR') throw error
        lastError = error
        if (attempt >= limit) throw error
      }
      await sleep(this.config.retryDelayMs, options.signal)
    }
    throw lastError ?? new Error('读屏失败：连续多次都没有取到可用画面')
  }

  /**
   * 阻塞等待屏幕变化。返回变化后的第一帧（可选要求已稳定）。
   *
   * @param {string|null} baselineHash 基准指纹；null 表示不比较、只看能否读到。
   * @param {object} [options] 选项。
   * @param {AbortSignal} [options.signal] 取消信号。
   * @param {number} [options.timeoutMs] 最长等待。
   * @param {number} [options.settleMs] 变化后要求的稳定时长（0 = 一变就返回）。
   * @param {number} [options.intervalMs] 首次轮询间隔。
   * @returns {Promise<{ changed: boolean, sample?: object, waitedMs: number, unreadable?: string }>} 结果。
   */
  async waitForChange(baselineHash, options = {}) {
    const { signal, timeoutMs = 5000, settleMs = 0 } = options
    const start = Date.now()
    const deadline = start + Math.max(0, timeoutMs)
    let interval = Math.max(30, options.intervalMs ?? this.config.minIntervalMs)
    let stableHash = null
    let stableAt = 0

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      await sleep(Math.min(interval, remaining), signal)
      if (Date.now() >= deadline) break

      let sample
      try {
        sample = await this.read({ signal, force: true, timeoutMs: Math.min(6000, remaining + 1200) })
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error
        if (error?.code === 'ERR') {
          // 界面变得不可读（锁屏 / 系统弹窗）本身就是一种变化，如实回报。
          return { changed: true, waitedMs: Date.now() - start, unreadable: error.message }
        }
        throw error
      }

      if (sample.hash === baselineHash) {
        interval = Math.min(Math.round(interval * 1.35), this.config.maxIntervalMs)
        stableHash = null
        continue
      }

      if (settleMs > 0) {
        if (stableHash !== sample.hash) {
          stableHash = sample.hash
          stableAt = Date.now()
          interval = Math.max(30, this.config.minIntervalMs)
          continue
        }
        if (Date.now() - stableAt < settleMs) continue
      }

      return { changed: true, sample, waitedMs: Date.now() - start }
    }

    return { changed: false, waitedMs: Date.now() - start }
  }
}

/**
 * 读取截屏文件字节。桥回的是 `/storage/emulated/0/...`，容器里 `/sdcard` 也指向同一处，
 * 两个都试一遍即可拿到（有些 rootfs 只有其中一个挂载点）。
 * @param {string} path 桥返回的路径。
 * @param {Function} readFileBytes 注入的读文件实现（便于测试）。
 * @returns {Promise<Uint8Array>} PNG 字节。
 */
export async function readScreenshotBytes(path, readFileBytes) {
  const candidates = [path]
  const emulated = /^\/storage\/emulated\/0\/(.*)$/.exec(path)
  if (emulated) candidates.push(`/sdcard/${emulated[1]}`)
  const sdcard = /^\/sdcard\/(.*)$/.exec(path)
  if (sdcard) candidates.push(`/storage/emulated/0/${sdcard[1]}`)

  const failures = []
  for (const candidate of candidates) {
    try {
      return await readFileBytes(candidate)
    } catch (error) {
      failures.push(`${candidate}: ${error?.code ?? error?.message ?? error}`)
    }
  }
  throw new Error(`截屏已存到 ${path}，但容器读不到该文件（试过 ${candidates.length} 个路径：${failures.join('；')}）`)
}
