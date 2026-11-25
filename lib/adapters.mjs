/**
 * dsh-bioflow — 六插件适配层
 *
 * 只依赖各插件 `lib/engine.mjs` 的最小契约（任务单调查结论）：
 *   pythonCandidates / probePython / findPython / prepareWorkdir / defaultWorkdir / createEngine
 *   createEngine(opts) → { workdir, dirs, request, start, dispose, status, progress, info, running, scriptPath }
 *
 * 三条硬设计决定之一：**每个 run 每个插件起一个临时 worker**
 *   - workdir = <runDir>/engines/<plugin>，绝不跨 run 复用；
 *   - run 结束/取消/失败统一 dispose()（POSIX 下引擎用 detached + 负 pid 杀进程组）。
 *
 * 命令命名空间三分裂（geobulk/spatial/metabolomics 走 cmd_*，singlecell 拆 op，
 * plotlab 走 pl_registry.handle，virtualcell 是 step 导向），全部集中在 COMMANDS 映射表。
 * 错误信封两种形状（plotlab 在 error.details，其余平铺）由 normalizeEngineError 归一化。
 *
 * 本文件不写死任何插件内部实现；import 失败/协议不符一律抛 protocol_mismatch。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const BIOFLOW_ROOT = path.resolve(HERE, '..')
export const PLUGINS_ROOT = path.resolve(BIOFLOW_ROOT, '..')

export const PLUGIN_IDS = ['geobulk', 'singlecell', 'spatial', 'metabolomics', 'plotlab', 'virtualcell']

export const PLUGIN_META = {
  geobulk: { package: 'dsh-geobulk', engine: 'lib/engine.mjs', python: 'lib/bg_engine.py', label: 'GEO Bulk' },
  singlecell: { package: 'dsh-singlecell', engine: 'lib/engine.mjs', python: 'lib/sc_engine.py', label: 'SingleCell' },
  spatial: { package: 'dsh-spatial', engine: 'lib/engine.mjs', python: 'lib/sp_engine.py', label: 'Spatial' },
  metabolomics: { package: 'dsh-metabolomics', engine: 'lib/engine.mjs', python: 'lib/mb_engine.py', label: 'Metabolomics' },
  plotlab: { package: 'dsh-plotlab', engine: 'lib/engine.mjs', python: 'lib/pl_engine.py', label: 'PlotLab' },
  virtualcell: { package: 'dsh-virtualcell', engine: 'lib/engine.mjs', python: 'lib/vc_engine.py', label: 'VirtualCell' },
}

const REQUIRED_ENGINE_EXPORTS = ['createEngine', 'pythonCandidates', 'probePython', 'findPython', 'prepareWorkdir', 'defaultWorkdir']
const REQUIRED_ENGINE_MEMBERS = ['workdir', 'dirs', 'request', 'start', 'dispose', 'status', 'progress', 'info', 'running', 'scriptPath']

// ---------------------------------------------------------------------------
// 命令映射（action → 引擎 cmd）
// ---------------------------------------------------------------------------

/** geobulk / spatial / metabolomics：Worker.dispatch + cmd_<name>，少数字段改名。 */
const CMD_ALIASES = {
  geobulk: { search: 'geo_search', detail: 'geo_detail', download: 'geo_download', sc_attach: 'sc_set', sc_refs: 'sc_refs' },
  spatial: { search: 'geo_search', detail: 'geo_detail', download: 'geo_download', ref_attach: 'ref_set', refs: 'refs', sc_refs: 'refs' },
  metabolomics: { search: 'geo_search', detail: 'geo_detail', download: 'geo_download', ml_search: 'ml_search', ml_detail: 'ml_detail', ml_download: 'ml_download' },
  // singlecell 的 samples 一个 action 拆成 7 个 cmd，按 op 派发
  singlecell: { scan: 'scan', geo_lookup: 'geo_lookup', external_tools: 'external_tools' },
  // plotlab：pl_registry.handle(cmd)，cmd 名就是 action 名
  plotlab: {},
  // virtualcell：step 导向；perturb/screen/response/transition 映射到 run {step, params}
  virtualcell: {
    perturb: 'run:perturb',
    screen: 'run:screen',
    response: 'run:response',
    transition: 'run:transition',
  },
}

const SINGLECELL_SAMPLES_OPS = {
  update: 'samples_update',
  auto_group: 'samples_auto_group',
  import_map: 'samples_import_map',
  remove: 'samples_remove',
  set_group: 'obs_set_group',
  join_obs: 'obs_join',
  derive: 'obs_derive',
  list: 'obs_list',
}

/**
 * action + params → { cmd, args }。
 * 纯函数，单测直接覆盖；未知 action 原样透传（让引擎报未知命令，错误可诊断）。
 */
export function mapAction(plugin, action, params = {}) {
  const aliases = CMD_ALIASES[plugin] || {}
  const args = params && typeof params === 'object' ? { ...params } : {}

  if (plugin === 'singlecell' && action === 'analysis') {
    const analysisId = args.analysis || args.id
    if (!analysisId) {
      throw protocolError('bad_request', 'singlecell analysis 需要 params.analysis（如 proportion_test / de_group）', { plugin, action })
    }
    return { cmd: 'analysis', args: { dataset: args.dataset, id: analysisId, params: args.params && typeof args.params === 'object' ? args.params : {} } }
  }

  if (plugin === 'singlecell' && action === 'samples') {
    const op = String(args.op || 'list')
    const cmd = SINGLECELL_SAMPLES_OPS[op]
    if (!cmd) {
      throw protocolError('bad_request', `singlecell samples 不支持的 op=${op}（可用：${Object.keys(SINGLECELL_SAMPLES_OPS).join('、')}）`, {
        plugin, action, op, available_ops: Object.keys(SINGLECELL_SAMPLES_OPS),
      })
    }
    return { cmd, args }
  }

  if (plugin === 'virtualcell') {
    const mapped = aliases[action]
    if (mapped && mapped.startsWith('run:')) {
      const step = mapped.slice(4)
      return {
        cmd: 'run',
        args: {
          step,
          dataset: args.dataset,
          params: args.params && typeof args.params === 'object' ? { ...args.params, ...pick(args, ['gene', 'mode', 'strength', 'cluster', 'genes']) } : pick(args, ['gene', 'mode', 'strength', 'cluster', 'genes']),
        },
      }
    }
    if (action === 'analysis') {
      // virtualcell 没有 analysis cmd：约定 action=analysis 时 params.step 必填
      return { cmd: 'run', args: { step: args.step, dataset: args.dataset, params: args.params || {} } }
    }
  }

  if (plugin === 'metabolomics' && action === 'search' && String(args.source || '').toLowerCase() === 'metabolights') {
    return { cmd: 'ml_search', args }
  }

  return { cmd: aliases[action] || action, args }
}

function pick(object, keys) {
  const out = {}
  for (const key of keys) if (object && object[key] !== undefined) out[key] = object[key]
  return out
}

/** 每个插件的引擎能力矩阵：哪些 action 可透传、下载支持哪几种。 */
export const CAPABILITIES = {
  geobulk: { search: true, detail: true, download: 'geo', run: true, plot: true, analysis: true, samples: true, export: true, sc_attach: true },
  singlecell: { search: true, detail: false, download: false, run: true, plot: true, analysis: true, samples: true, export: true, sc_attach: false },
  spatial: { search: true, detail: true, download: 'geo', run: true, plot: true, analysis: true, samples: true, export: true, sc_attach: false },
  metabolomics: { search: true, detail: true, download: 'geo+ml', run: true, plot: true, analysis: true, samples: true, export: true, sc_attach: false },
  plotlab: { search: false, detail: false, download: false, run: false, plot: true, analysis: false, samples: true, export: true, sc_attach: false },
  virtualcell: { search: false, detail: false, download: false, run: true, plot: true, analysis: false, samples: false, export: true, sc_attach: false },
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export function protocolError(code, message, details = {}) {
  const error = Object.assign(new Error(message), { code })
  if (details && Object.keys(details).length) error.details = details
  return error
}

/**
 * 归一化两种错误信封：
 *   - plotlab/单细胞/VC 的 EngineError 允许把 details 放 error.details；
 *   - geobulk/spatial/metabolomics 把 details 平铺在 error 顶层。
 * 统一成 { code, message, details, trace }。
 */
export function normalizeEngineError(error, plugin = 'unknown', action = 'unknown') {
  const source = error || {}
  const details = {}
  if (source.details && typeof source.details === 'object') Object.assign(details, source.details)
  for (const key of Object.keys(source)) {
    if (['code', 'message', 'details', 'trace', 'stack', 'name', 'taskId'].includes(key)) continue
    details[key] = source[key]
  }
  return {
    code: String(source.code || 'engine_error'),
    message: String(source.message || source),
    details,
    trace: source.trace ? String(source.trace) : null,
    plugin,
    action,
  }
}

function engineFailure(info) {
  const error = Object.assign(new Error(info.message), { code: info.code, details: info.details })
  error.plugin = info.plugin
  error.action = info.action
  if (info.trace) error.trace = info.trace
  return error
}

// ---------------------------------------------------------------------------
// 插件模块定位 + 协议检查
// ---------------------------------------------------------------------------

/** 在几个常见位置找 dsh-<plugin>/lib/engine.mjs。 */
export function engineCandidates(plugin, opts = {}) {
  const meta = PLUGIN_META[plugin]
  if (!meta) return []
  const list = []
  const explicit = opts.pluginPaths && opts.pluginPaths[plugin]
  if (explicit) list.push(path.resolve(explicit))
  const envRoot = process.env.DSH_BIOFLOW_PLUGINS_DIR
  if (envRoot) list.push(path.resolve(envRoot, meta.package, meta.engine))
  list.push(path.join(PLUGINS_ROOT, meta.package, meta.engine))
  list.push(path.join(BIOFLOW_ROOT, '..', meta.package, meta.engine))
  list.push(path.join(BIOFLOW_ROOT, 'node_modules', meta.package, meta.engine))
  try {
    const require = createRequire(import.meta.url)
    let manifest = null
    try { manifest = require.resolve(`${meta.package}/package.json`) } catch { manifest = null }
    if (manifest) list.push(path.join(path.dirname(manifest), meta.engine))
  } catch { /* ignore */ }
  try {
    const require = createRequire(path.join(PLUGINS_ROOT, 'noop.js'))
    const manifest = require.resolve(`${meta.package}/package.json`)
    list.push(path.join(path.dirname(manifest), meta.engine))
  } catch { /* ignore */ }
  return [...new Set(list)]
}

/**
 * 加载插件 engine 模块并做静态协议检查（不创建 worker、不写文件）。
 * 返回 { ok, plugin, modulePath, module, exports, error? }。
 */
export async function loadEngineModule(plugin, opts = {}) {
  const candidates = engineCandidates(plugin, opts)
  if (!candidates.length) {
    return { ok: false, plugin, code: 'protocol_mismatch', error: `未知插件 ${plugin}` }
  }
  const tried = []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) { tried.push({ path: candidate, reason: 'not_found' }); continue }
    let module
    try {
      module = await import(pathToFileURL(candidate).href)
    } catch (error) {
      tried.push({ path: candidate, reason: `import_failed: ${error && error.message}` })
      continue
    }
    const missing = REQUIRED_ENGINE_EXPORTS.filter((name) => typeof module[name] !== 'function')
    if (missing.length) {
      tried.push({ path: candidate, reason: `missing_exports: ${missing.join(',')}` })
      continue
    }
    return {
      ok: true,
      plugin,
      modulePath: candidate,
      module,
      exports: REQUIRED_ENGINE_EXPORTS.filter((name) => typeof module[name] === 'function'),
    }
  }
  const last = tried.length ? tried[tried.length - 1].reason : 'not_found'
  return {
    ok: false,
    plugin,
    code: 'protocol_mismatch',
    error: `插件 ${PLUGIN_META[plugin].package} 的 lib/engine.mjs 不可用（${last}）。` +
      `已尝试：${tried.map((item) => item.path).join('；') || '无'}。` +
      'Bioflow 不会重写这些插件，只静态 import 其 engine.mjs；请确认插件已安装或插件路径正确。',
    tried,
  }
}

/** 校验 createEngine 返回的 10 个成员；缺失 → protocol_mismatch。 */
export function checkEngineInstance(plugin, engine, modulePath) {
  const missing = []
  for (const member of REQUIRED_ENGINE_MEMBERS) {
    if (member === 'progress' || member === 'info' || member === 'running') {
      try {
        void engine[member]
      } catch {
        missing.push(member)
      }
      continue
    }
    if (member === 'workdir' || member === 'scriptPath') {
      if (typeof engine[member] !== 'string') missing.push(member)
      continue
    }
    if (member === 'dirs') {
      if (!engine.dirs || typeof engine.dirs !== 'object') missing.push(member)
      continue
    }
    if (typeof engine[member] !== 'function') missing.push(member)
  }
  if (missing.length) {
    throw protocolError('protocol_mismatch', `插件 ${plugin} 的 createEngine 返回对象不符合最小契约，缺少：${missing.join('、')}`, {
      plugin, modulePath, missing, required: REQUIRED_ENGINE_MEMBERS,
    })
  }
  return { ok: true, members: REQUIRED_ENGINE_MEMBERS }
}

// ---------------------------------------------------------------------------
// 适配器：一个 run 里一个插件一个临时 worker
// ---------------------------------------------------------------------------

/**
 * 创建适配器。
 * @param {string} plugin
 * @param {object} opts {workdir, config, pluginPaths, engineFactory?}
 *   engineFactory 用于测试注入（默认用插件模块的 createEngine）。
 */
export async function createAdapter(plugin, opts = {}) {
  if (!PLUGIN_META[plugin]) throw protocolError('unsupported', `未知插件 ${plugin}`, { plugin })
  const workdir = opts.workdir || path.join(BIOFLOW_ROOT, '.bioflow-engine', plugin)
  let engine = null
  let modulePath = null
  let loaded = null

  if (typeof opts.engineFactory === 'function') {
    engine = await opts.engineFactory({ plugin, workdir, config: opts.config || {} })
    modulePath = opts.modulePath || '<injected>'
  } else {
    loaded = await loadEngineModule(plugin, opts)
    if (!loaded.ok) throw protocolError('protocol_mismatch', loaded.error, { plugin, tried: loaded.tried })
    modulePath = loaded.modulePath
    const config = opts.config && typeof opts.config === 'object' ? opts.config : {}
    try {
      engine = loaded.module.createEngine({
        workdir,
        config,
        python: opts.python,
        timeout: opts.timeoutMs,
      })
    } catch (error) {
      throw protocolError('protocol_mismatch', `插件 ${plugin} 的 createEngine 调用失败：${error && error.message}`, {
        plugin, modulePath, cause: error && error.message,
      })
    }
    if (!engine || typeof engine !== 'object') {
      throw protocolError('protocol_mismatch', `插件 ${plugin} 的 createEngine 没有返回引擎对象`, { plugin, modulePath })
    }
    checkEngineInstance(plugin, engine, modulePath)
  }

  const adapter = {
    plugin,
    modulePath,
    engine,
    workdir: engine.workdir || workdir,
    dirs: engine.dirs || {},
    scriptPath: engine.scriptPath || null,
    protocol: { ok: true, members: REQUIRED_ENGINE_MEMBERS, modulePath },
    get running() { return Boolean(engine.running) },
    get info() { try { return engine.info } catch { return null } },
    get progress() { try { return engine.progress } catch { return null } },
    status() {
      try { return engine.status() } catch (error) { return { ready: false, error: String(error && error.message ? error.message : error) } }
    },
    async start() {
      try { return await engine.start() } catch (error) {
        const info = normalizeEngineError(error, plugin, 'start')
        throw engineFailure(info)
      }
    },
    map(action, params) {
      return mapAction(plugin, action, params)
    },
    /** 主路径：直接走引擎 request；绝不用 impl.runTool 的压缩结果。 */
    async invoke(action, params = {}, invokeOpts = {}) {
      const mapped = mapAction(plugin, action, params)
      const timeout = Number(invokeOpts.timeoutMs) > 0 ? Number(invokeOpts.timeoutMs) : 10 * 60 * 1000
      const requestOpts = {
        timeout,
        deadline: Number(invokeOpts.deadline) > 0 ? Number(invokeOpts.deadline) : Date.now() + timeout,
      }
      if (invokeOpts.signal) requestOpts.signal = invokeOpts.signal
      let pending
      try {
        pending = engine.request(mapped.cmd, mapped.args, requestOpts)
        if (!invokeOpts.signal) {
          return await pending
        }
        return await Promise.race([
          pending,
          new Promise((resolve, reject) => {
            const abort = () => reject(protocolError('cancelled', `run 已取消（插件 ${plugin} action ${action}）`))
            if (invokeOpts.signal.aborted) abort()
            else invokeOpts.signal.addEventListener('abort', abort, { once: true })
          }),
        ])
      } catch (error) {
        if (error && (error.code === 'cancelled' || error.code === 'timeout')) throw error
        const info = normalizeEngineError(error, plugin, `${action}→${mapped.cmd}`)
        throw engineFailure(info)
      } finally {
        // 避免宿主的 unhandledRejection：即使我们已 race 取消，底层 promise 也要有 catch
        if (pending && typeof pending.catch === 'function') pending.catch(() => {})
      }
    },
    async dispose() {
      try { await engine.dispose() } catch (error) {
        // dispose 失败不能污染 run 结论，但要留痕
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
      return { ok: true }
    },
    async probe() {
      try {
        const info = await this.start()
        return { ok: true, python: info && info.python, version: info && info.version, mode: info && info.mode }
      } catch (error) {
        return { ok: false, code: error.code || 'engine_error', error: error.message, details: error.details || null }
      }
    },
  }
  return adapter
}

/**
 * 静态探测（不启动 worker）：给 status/audit/suggest 用，快且无副作用文件。
 */
export async function probePlugins(opts = {}) {
  const results = {}
  for (const plugin of PLUGIN_IDS) {
    // eslint-disable-next-line no-await-in-loop
    const loaded = await loadEngineModule(plugin, opts)
    results[plugin] = loaded.ok
      ? { available: true, module_path: loaded.modulePath, package: PLUGIN_META[plugin].package }
      : { available: false, code: loaded.code || 'protocol_mismatch', error: loaded.error }
  }
  return results
}
