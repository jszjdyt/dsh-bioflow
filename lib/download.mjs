/**
 * dsh-bioflow — 统一下载层
 *
 * 任务单要求：断点续传、限流、记录 URL/ETag/size/sha256/md5、已存在同 hash 直接复用、
 * 路径冲突明确报错、下载完落 artifact 表并冻结版本（artifact 登记在 executor/deliver 里做）。
 *
 * 只依赖 node 内置模块 + 注入的 fetch（测试用 stub，不联网）。
 * 下载落盘策略：
 *   - 先写 <dest>.part，完成后 sha256/md5/size 校验，再原子 rename 到 dest；
 *   - 同一 URL 的旧产物记录在 cache/downloads.index.json，同 hash 直接复用；
 *   - dest 已存在且 hash 与 expected/缓存不一致 → path_conflict（不静默覆盖）。
 */

import { createHash } from 'node:crypto'
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { atomicWriteJson, ensureDir, fileSize, nowIso, readJsonIfExists, sha256File } from './store.mjs'

export const DOWNLOAD_SCHEMA_VERSION = 1
const CHUNK = 1 << 20

export class TokenBucket {
  constructor({ ratePerSec = 3, burst = 3, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.ratePerSec = Math.max(0.1, Number(ratePerSec) || 3)
    this.capacity = Math.max(1, Number(burst) || Math.max(1, Math.ceil(this.ratePerSec)))
    this.tokens = this.capacity
    this.last = now()
    this.now = now
    this.sleep = sleep
  }

  refill() {
    const current = this.now()
    const elapsed = Math.max(0, current - this.last) / 1000
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSec)
    this.last = current
  }

  /** 取一个 token；不够就按速率等待（等待时间可测试注入）。 */
  async acquire() {
    this.refill()
    if (this.tokens >= 1) { this.tokens -= 1; return 0 }
    const deficit = 1 - this.tokens
    const waitMs = Math.ceil((deficit / this.ratePerSec) * 1000)
    await this.sleep(waitMs)
    this.refill()
    this.tokens = Math.max(0, this.tokens - 1)
    return waitMs
  }
}

function md5OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function downloadError(code, message, details = {}) {
  const error = Object.assign(new Error(message), { code })
  error.details = details
  return error
}

export class Downloader {
  constructor({ cacheDir, fetchImpl = null, ratePerSec = 4, retries = 2, timeoutMs = 120_000, log = null } = {}) {
    this.cacheDir = cacheDir
    this.indexFile = path.join(cacheDir, 'downloads.index.json')
    ensureDir(cacheDir)
    this.fetch = fetchImpl || globalThis.fetch
    if (typeof this.fetch !== 'function') throw downloadError('unsupported', '当前运行时没有 fetch，无法下载')
    this.ratePerSec = ratePerSec
    this.retries = retries
    this.timeoutMs = timeoutMs
    this.log = typeof log === 'function' ? log : () => {}
    this.buckets = new Map()
    this.index = readJsonIfExists(this.indexFile) || { schema_version: DOWNLOAD_SCHEMA_VERSION, entries: {} }
  }

  bucketFor(url) {
    let key = 'default'
    try { key = new URL(url).host } catch { key = 'default' }
    if (!this.buckets.has(key)) this.buckets.set(key, new TokenBucket({ ratePerSec: this.ratePerSec }))
    return this.buckets.get(key)
  }

  saveIndex() {
    atomicWriteJson(this.indexFile, this.index)
  }

  lookup(url) {
    return this.index.entries[url] || null
  }

  remember(url, meta) {
    this.index.entries[url] = meta
    this.saveIndex()
  }

  /** HEAD 不强求；GDC/HTTP 服务器可能不支持，拿不到就走完整 GET。 */
  async head(url, signal) {
    try {
      await this.bucketFor(url).acquire()
      const response = await this.fetch(url, { method: 'HEAD', signal, redirect: 'follow' })
      if (!response || !response.ok) return null
      return {
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        length: Number(response.headers.get('content-length')) || null,
      }
    } catch {
      return null
    }
  }

  /**
   * 下载一个 URL 到 destPath。
   * @returns {Promise<{dest, bytes, sha256, md5, etag, reused, resumed_from, expected_verified}>}
   */
  async download({ url, destPath, expected = {}, signal = null, onProgress = null, headers = {} } = {}) {
    if (!url) throw downloadError('bad_request', 'download 需要 url')
    if (!destPath) throw downloadError('bad_request', 'download 需要 destPath')
    ensureDir(path.dirname(destPath))
    const expectedSha = expected.sha256 ? String(expected.sha256).toLowerCase() : null
    const expectedMd5 = expected.md5 ? String(expected.md5).toLowerCase() : null
    const expectedSize = Number(expected.bytes || expected.size) > 0 ? Number(expected.bytes || expected.size) : null

    // 1) dest 已存在：按 hash 判断复用 / 冲突
    if (existsSync(destPath) && fileSize(destPath) > 0) {
      const existing = await this.describeExisting(destPath, { expectedSha, expectedMd5, expectedSize })
      if (existing.match) {
        this.remember(url, { ...existing.meta, dest: destPath, reused_at: nowIso() })
        return { ...existing.meta, dest: destPath, reused: true, resumed_from: 0 }
      }
      throw downloadError('path_conflict', `目标路径已存在且哈希不符：${destPath}`, {
        path: destPath, expected: { sha256: expectedSha, md5: expectedMd5, bytes: expectedSize }, actual: existing.meta,
      })
    }

    // 2) 缓存里同 URL 同 hash 的旧副本 → 直接复制复用（不需要再请求）
    const cached = this.lookup(url)
    if (cached && existsSync(cached.dest) && (!expectedSha || cached.sha256 === expectedSha) && (!expectedMd5 || cached.md5 === expectedMd5)) {
      const existing = await this.describeExisting(cached.dest, { expectedSha, expectedMd5, expectedSize })
      if (existing.match) {
        await this.copyLocal(cached.dest, destPath)
        return { ...existing.meta, dest: destPath, reused: true, resumed_from: 0, reused_from: cached.dest }
      }
    }

    // 3) 断点续传：<dest>.part + <dest>.part.meta.json
    const partFile = `${destPath}.part`
    const metaFile = `${destPath}.part.meta.json`
    const partMeta = readJsonIfExists(metaFile) || {}
    let offset = existsSync(partFile) ? fileSize(partFile) : 0
    if (offset > 0 && partMeta.url !== url) {
      // 不同 URL 的残片不能续
      try { unlinkSync(partFile) } catch { /* ignore */ }
      offset = 0
    }
    const etag = partMeta.etag || null
    if (offset > 0) this.log('download', `断点续传 ${url} from ${offset} B`)

    let response = null
    let lastError = null
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        await this.bucketFor(url).acquire()
        const requestHeaders = { ...headers }
        if (offset > 0) {
          requestHeaders.Range = `bytes=${offset}-`
          if (etag) requestHeaders['If-Range'] = etag
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        const mergedSignal = signal ? anySignal([signal, controller.signal]) : controller.signal
        try {
          response = await this.fetch(url, { method: 'GET', headers: requestHeaders, signal: mergedSignal, redirect: 'follow' })
        } finally {
          clearTimeout(timer)
        }
        lastError = null
        break
      } catch (error) {
        lastError = error
        if (signal && signal.aborted) throw downloadError('cancelled', '下载已取消')
        if (attempt >= this.retries) break
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      }
    }
    if (lastError) throw downloadError('network', `下载失败：${url}（${lastError.message || lastError}）`, { url, cause: String(lastError && lastError.message) })
    if (!response) throw downloadError('network', `下载没有响应：${url}`)

    if (response.status === 416) {
      // 残片已经覆盖完整文件：核对后收尾
      const total = partMeta.total || null
      if (total && offset === total) {
        return this.finalize({ partFile, destPath, url, expectedSha, expectedMd5, expectedSize, etag, offset, total, onProgress })
      }
      try { unlinkSync(partFile) } catch { /* ignore */ }
      throw downloadError('resume_mismatch', `服务器拒绝续传区间（416），已清理残片，请重试：${url}`, { url, offset })
    }
    if (!response.ok && response.status !== 200 && response.status !== 206) {
      const text = await safeText(response)
      throw downloadError('http_error', `下载失败 HTTP ${response.status}：${url}${text ? `（${text.slice(0, 200)}）` : ''}`, {
        url, status: response.status, body: text.slice(0, 500),
      })
    }

    const responseEtag = response.headers.get('etag') || etag
    const contentLength = Number(response.headers.get('content-length')) || null
    if (offset > 0 && response.status === 200) {
      // 服务器忽略 Range → 从头下
      offset = 0
      try { unlinkSync(partFile) } catch { /* ignore */ }
    }
    atomicWriteJson(metaFile, {
      url, etag: responseEtag, started_at: partMeta.started_at || nowIso(),
      offset, total: contentLength ? offset + contentLength : null,
    })

    const flags = offset > 0 ? 'a' : 'w'
    const writer = createWriteStream(partFile, { flags })
    if (response.body) {
      await pipeline(Readable.fromWeb(response.body), writer)
    } else {
      writer.end()
    }
    const total = fileSize(partFile)
    if (contentLength && response.status === 206) {
      const expectedTotal = offset + contentLength
      if (total !== expectedTotal) {
        throw downloadError('size_mismatch', `续传后大小不符：期望 ${expectedTotal}，实际 ${total}`, { url, expected: expectedTotal, actual: total })
      }
    }
    if (onProgress) { try { onProgress({ bytes: total }) } catch { /* ignore */ } }
    return this.finalize({ partFile, destPath, url, expectedSha, expectedMd5, expectedSize, etag: responseEtag, offset, total, onProgress })
  }

  async describeExisting(file, { expectedSha, expectedMd5, expectedSize }) {
    const bytes = fileSize(file)
    const sha256 = await sha256File(file)
    const md5 = expectedMd5 ? await md5OfFile(file) : null
    const match = (!expectedSha || expectedSha === sha256)
      && (!expectedMd5 || expectedMd5 === md5)
      && (!expectedSize || expectedSize === bytes)
    return {
      match,
      meta: { sha256, md5, bytes, etag: null, checked_at: nowIso() },
    }
  }

  async copyLocal(source, destPath) {
    ensureDir(path.dirname(destPath))
    const reader = createReadStream(source)
    const writer = createWriteStream(destPath)
    await pipeline(reader, writer)
  }

  async finalize({ partFile, destPath, url, expectedSha, expectedMd5, expectedSize, etag, offset, total, onProgress }) {
    const sha256 = await sha256File(partFile)
    const md5 = expectedMd5 ? await md5OfFile(partFile) : null
    const bytes = fileSize(partFile)
    if (expectedSize && bytes !== expectedSize) {
      throw downloadError('size_mismatch', `文件大小不符：期望 ${expectedSize}，实际 ${bytes}`, { url, expected: expectedSize, actual: bytes })
    }
    if (expectedSha && sha256 !== expectedSha) {
      throw downloadError('hash_mismatch', `sha256 校验失败：期望 ${expectedSha}，实际 ${sha256}`, { url, expected: expectedSha, actual: sha256 })
    }
    if (expectedMd5 && md5 !== expectedMd5) {
      throw downloadError('hash_mismatch', `md5 校验失败：期望 ${expectedMd5}，实际 ${md5}`, { url, expected: expectedMd5, actual: md5 })
    }
    if (expectedSha && md5) {
      // 同时声明 sha256/md5 时二者都要过
    }
    atomicMoveFile(partFile, destPath)
    try { unlinkSync(`${destPath}.part.meta.json`) } catch { /* ignore */ }
    const meta = {
      schema_version: DOWNLOAD_SCHEMA_VERSION,
      url, dest: destPath, bytes, sha256, md5,
      etag: etag || null,
      resumed_from: offset,
      downloaded_at: nowIso(),
    }
    this.remember(url, meta)
    if (onProgress) { try { onProgress({ bytes, done: true }) } catch { /* ignore */ } }
    return { ...meta, reused: false }
  }
}

function atomicMoveFile(from, to) {
  ensureDir(path.dirname(to))
  try {
    renameSync(from, to)
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      writeFileSync(to, readFileSync(from))
      unlinkSync(from)
    } else {
      throw error
    }
  }
}

async function safeText(response) {
  try { return await response.text() } catch { return '' }
}

/** 合并多个 AbortSignal（浏览器/Node 无 AbortSignal.any 时的手写版）。 */
export function anySignal(signals) {
  const valid = signals.filter(Boolean)
  if (valid.length === 1) return valid[0]
  const controller = new AbortController()
  const cleanup = []
  for (const signal of valid) {
    if (signal.aborted) { controller.abort(signal.reason); break }
    const onAbort = () => { controller.abort(signal.reason); for (const off of cleanup) off() }
    signal.addEventListener('abort', onAbort, { once: true })
    cleanup.push(() => signal.removeEventListener('abort', onAbort))
  }
  return controller.signal
}

export function createDownloader(opts = {}) {
  return new Downloader(opts)
}
