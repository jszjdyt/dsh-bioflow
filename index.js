/**
 * dsh-bioflow — Host 半边入口（薄且稳定）
 *
 * 只做四件事：
 *   1. 把 `/bioflow/*` 的 prefix 路由挂到 webServer，全部转给 lib/impl.mjs；
 *   2. 注册 `bioflow` agent 工具（与 UI/CLI 同一套操作实现）；
 *   3. 注册一段 system prompt section；
 *   4. 插件卸载时关掉 store 与所有 engine。
 *
 * 业务逻辑都在 lib/*.mjs 里。用 `?rev=<mtime>` 绕开 ESM 缓存，改完 lib 不用重启宿主。
 */

import { statSync } from 'node:fs'

const PREFIX = '/bioflow'
const VERSION = '0.1.0'
const IMPL_URL = new URL('./lib/impl.mjs', import.meta.url)

function implVersion() {
  try { return String(statSync(IMPL_URL).mtimeMs) } catch { return 'static' }
}

let implCache = { version: '', promise: null }

function loadImpl() {
  const version = implVersion()
  if (implCache.promise && implCache.version === version) return implCache.promise
  const url = new URL(`?rev=${encodeURIComponent(version)}`, IMPL_URL)
  const promise = import(url.href)
  implCache = { version, promise }
  promise.catch(() => {
    if (implCache.promise === promise) implCache = { version: '', promise: null }
  })
  return promise
}

export const name = 'dsh-bioflow'

export function apply(ctx, config) {
  const runtime = {
    version: VERSION,
    config: config && typeof config === 'object' ? config : {},
    ctx,
    invocation: 'apply',
  }

  // ---- HTTP 路由：页面/CLI 通过同源 fetch 调这里 ----
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.webServer
    const dispose = webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (req, res) => dispatch(runtime, req, res),
    })
    scoped.effect(() => () => {
      try { dispose() } catch { /* ignore */ }
    }, 'dsh-bioflow: routes')
  })

  // ---- agent 工具 ----
  ctx.inject(['tools'], () => {
    loadImpl()
      .then((impl) => {
        // 宿主已有 pubmed 工具（dsh-pubmed）时优先转发；没有就用内置 E-utilities。
        try { impl.ensurePubMedForwarder(runtime) } catch { /* 转发不可用不影响内置检索 */ }
        return impl.ensureToolRegistered(runtime)
      })
      .catch((error) => {
        try { console.warn('[dsh-bioflow] agent tool unavailable:', error && error.message ? error.message : error) } catch { /* ignore */ }
      })
  })

  // ---- system prompt section ----
  ctx.inject(['systemPrompt'], () => {
    loadImpl()
      .then((impl) => impl.ensurePromptSection(runtime))
      .catch((error) => {
        try { console.warn('[dsh-bioflow] prompt section unavailable:', error && error.message ? error.message : error) } catch { /* ignore */ }
      })
  })

  // ---- 卸载 ----
  ctx.effect(() => () => {
    loadImpl()
      .then((impl) => impl.disposeRuntime(runtime))
      .catch(() => { /* ignore */ })
  }, 'dsh-bioflow: dispose')
}

async function dispatch(runtime, req, res) {
  const send = (status, payload, type = 'application/json; charset=utf-8', length = null) => {
    try {
      res.statusCode = status
      res.setHeader('content-type', type)
      res.setHeader('cache-control', 'no-store')
      if (length) res.setHeader('content-length', String(length))
      if (Buffer.isBuffer(payload)) res.end(payload)
      else res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
    } catch { /* ignore */ }
  }
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === PREFIX || url.pathname === `${PREFIX}/`) {
      return send(200, { name: 'dsh-bioflow', version: VERSION, platform: '许愿式生物信息全自动分析平台', routes: ['api', 'dispatch', 'catalog', 'status', 'health', 'figures/<run_id>/<file>', 'files/<rel>'] })
    }
    const impl = await loadImpl()
    const tail = url.pathname.slice(PREFIX.length).replace(/^\/+/, '')
    // 所有 action 都走同一个 runTool：HTTP / agent 工具 / CLI 是同一套实现。
    if (tail === 'dispatch' || tail === 'api' || tail === '') {
      const body = await readBody(req)
      const payload = body && typeof body === 'object' ? body : {}
      // 允许 GET ?action=xxx&run_id=... 便于 curl 排查（POST JSON 仍是主路径）
      if (!payload.action && url.searchParams.get('action')) {
        for (const [key, value] of url.searchParams.entries()) payload[key] = value
      }
      const result = await impl.runTool(runtime, payload)
      return send(200, result)
    }
    if (tail === 'status') return send(200, await impl.runTool(runtime, { action: 'status' }))
    if (tail === 'catalog') return send(200, await impl.buildCatalog(runtime))
    if (tail === 'health') {
      const rawSources = url.searchParams.get('sources')
      const sources = rawSources === 'all' ? undefined : rawSources ? rawSources.split(',').map((item) => item.trim()).filter(Boolean) : undefined
      return send(200, await impl.runTool(runtime, { action: 'health', sources }))
    }
    if (tail.startsWith('figures/')) {
      // /bioflow/figures/<run_id>/<file> → <dataRoot>/runs/<run_id>/figures/<file>
      const rel = decodeURIComponent(tail.slice('figures/'.length))
      const cut = rel.indexOf('/')
      if (cut <= 0) return send(404, { error: 'not_found', detail: '需要 /bioflow/figures/<run_id>/<file>' })
      const runId = rel.slice(0, cut)
      const file = rel.slice(cut + 1)
      const abs = impl.resolveServedPath(runtime, `runs/${runId}/figures/${file}`)
      if (!abs) return send(404, { error: 'not_found', detail: rel })
      const served = impl.readServedFile(abs)
      return send(200, served.buffer, served.contentType, served.bytes)
    }
    if (tail.startsWith('files/')) {
      const rel = decodeURIComponent(tail.slice('files/'.length))
      const abs = impl.resolveServedPath(runtime, rel)
      if (!abs) return send(404, { error: 'not_found', detail: rel })
      const served = impl.readServedFile(abs)
      return send(200, served.buffer, served.contentType, served.bytes)
    }
    return send(404, { error: 'not_found', detail: url.pathname })
  } catch (error) {
    const code = error && error.code ? error.code : 'internal_error'
    const status = code === 'bad_request' || code === 'blocked' || code === 'confirm_required' || code === 'draft_changed' ? 400
      : code === 'not_found' ? 404
        : code === 'source_unavailable' ? 503
          : 500
    return send(status, { error: code, message: String(error && error.message ? error.message : error), details: (error && error.details) || null })
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (!data) return resolve(null)
      try { resolve(JSON.parse(data)) } catch { resolve(null) }
    }
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 8 * 1024 * 1024) { try { req.destroy() } catch { /* ignore */ } ; finish() }
    })
    req.on('end', finish)
    req.on('error', () => finish())
  })
}
