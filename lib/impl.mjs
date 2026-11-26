/**
 * dsh-bioflow — 全部 action 实现（Agent 工具 / UI / CLI 共用这一份）
 *
 * 三条硬约束：
 *   1. 每个 run 每个插件一个临时 worker（workdir=<runDir>/engines/<plugin>），跑完/取消/失败统一 dispose；
 *   2. 不重算分析：step={plugin,action,params} 透传插件引擎，结果原样存档再抽表；
 *   3. 闸门真拦：blocked 就是 blocked，任何一步失败都不得整体 ok:true。
 *
 * 新增（lead 追加）：
 *   - ask：自然语言 → draft 计划（规则优先 + 可选 LLM 兜底；永不直接执行；confirm_token 确认后才 submit）；
 *   - 五源检索（GEO/PubMed/GDC/MetaboLights/CELLxGENE）+ provenance + 健康灯；
 *   - download：统一断点/限流/哈希 → artifact 表（内容寻址）；
 *   - harmonize / joint：内置计算步骤，与插件步骤共用同一 run/交付/证据流水线。
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import zlib from 'node:zlib'

import {
  Store, sha256File, sha256, safeName, nowIso, readJsonIfExists, stableStringify,
  idempotencyKey, storeError, atomicWriteJson, atomicWriteFile, ensureDir, fileSize, tableToTsv,
  parseDelimited, removeDir,
} from './store.mjs'
import * as P from './plan.mjs'
import * as A from './adapters.mjs'
import * as D from './deliver.mjs'
import * as E from './evidence.mjs'
import * as I from './intent.mjs'
import * as H from './harmonize.mjs'
import * as J from './joint.mjs'
import * as S from './search.mjs'
import { PubMedClient, createPubMedClient } from './pubmed.mjs'
import { createSourcesClient, SOURCE_IDS, DEFAULT_SEARCH_SOURCES, SOURCE_META } from './sources.mjs'
import { createDownloader } from './download.mjs'

export const VERSION = '0.1.0'
export const ACTIONS = [
  'status', 'templates', 'search', 'source_detail', 'health', 'download',
  'register', 'datasets', 'ask', 'plan', 'submit', 'runs', 'run_status', 'cancel',
  'export', 'evidence', 'methods', 'audit', 'suggest', 'harmonize', 'joint',
  'delete', 'trash', 'settings', 'advise', 'topics', 'suggest_next',
]

const TABLES = ['manifest.json', 'design.tsv', 'qc.tsv', 'results/*.tsv', 'figures/', 'evidence.jsonl', 'methods.md']

// ---------------------------------------------------------------------------
// runtime / store / 客户端
// ---------------------------------------------------------------------------

export function dataRoot(runtime) {
  const cfg = (runtime && runtime.config) || {}
  return cfg.dataDir || cfg.workdir || process.env.DSH_BIOFLOW_WORKDIR || path.join(os.homedir(), '.dsh', 'bioflow')
}

export function getStore(runtime) {
  if (runtime.store) return runtime.store
  runtime.store = new Store({ root: dataRoot(runtime), kind: (runtime.config && runtime.config.store) || 'auto' })
  return runtime.store
}

export function getFetch(runtime) {
  if (runtime.fetchImpl) return runtime.fetchImpl
  if (typeof runtime.config.fetchImpl === 'function') return runtime.config.fetchImpl
  return globalThis.fetch
}

function getPubMedClient(runtime, store) {
  if (runtime.pubmedClient) return runtime.pubmedClient
  const cfg = (runtime.config && runtime.config.pubmed) || {}
  runtime.pubmedClient = createPubMedClient({
    fetchImpl: getFetch(runtime),
    cacheDir: store.dirs.pubmed,
    ttlMs: Number(cfg.ttlMs) > 0 ? Number(cfg.ttlMs) : undefined,
    maxPerSec: Number(cfg.maxPerSec) > 0 ? Number(cfg.maxPerSec) : 3,
    apiKey: cfg.apiKey || process.env.NCBI_API_KEY || null,
    email: cfg.email || process.env.NCBI_EMAIL || null,
    europePmcTimeoutMs: Number(cfg.europePmcTimeoutMs) > 0 ? Number(cfg.europePmcTimeoutMs) : 8000,
    forwarder: cfg.forwarder || runtime.pubmedForwarder || null,
    log: (scope, message) => store.logEvent('pubmed', scope, { message }),
  })
  return runtime.pubmedClient
}

/**
 * 临时 adapter（检索/下载用）：不进 run，用完即 dispose。
 */
async function ephemeralAdapter(runtime, store, plugin) {
  runtime.ephemeralAdapters = runtime.ephemeralAdapters || new Map()
  if (runtime.ephemeralAdapters.has(plugin)) return runtime.ephemeralAdapters.get(plugin)
  const workdir = path.join(store.dirs.cache, 'search-engines', plugin)
  const adapter = typeof runtime.adapterFactory === 'function'
    ? await runtime.adapterFactory(plugin, { workdir, ephemeral: true })
    : await A.createAdapter(plugin, {
      workdir,
      config: (runtime.config && runtime.config.plugins && runtime.config.plugins[plugin]) || {},
      pluginPaths: (runtime.config && runtime.config.pluginPaths) || undefined,
      python: runtime.config && runtime.config.python,
    })
  runtime.ephemeralAdapters.set(plugin, adapter)
  return adapter
}

async function disposeEphemeral(runtime) {
  if (!runtime.ephemeralAdapters) return
  for (const adapter of runtime.ephemeralAdapters.values()) {
    try { await adapter.dispose() } catch { /* ignore */ }
  }
  runtime.ephemeralAdapters.clear()
}

function getSourcesClient(runtime, store) {
  const cfg = (runtime.config && runtime.config.sources) || {}
  return createSourcesClient({
    fetchImpl: getFetch(runtime),
    pubmedClient: getPubMedClient(runtime, store),
    adapterProvider: async (plugin) => {
      try {
        return await ephemeralAdapter(runtime, store, plugin)
      } catch (error) {
        store.logEvent('sources', 'adapter_unavailable', { plugin, error: String(error && error.message) })
        return null
      }
    },
    timeouts: cfg.timeouts || {},
    log: (scope, message) => store.logEvent('sources', scope, { message }),
  })
}

function getDownloader(runtime, store) {
  if (runtime.downloader) return runtime.downloader
  const cfg = (runtime.config && runtime.config.download) || {}
  runtime.downloader = createDownloader({
    cacheDir: path.join(store.dirs.cache, 'downloads'),
    fetchImpl: getFetch(runtime),
    ratePerSec: Number(cfg.ratePerSec) > 0 ? Number(cfg.ratePerSec) : 4,
    retries: Number.isInteger(cfg.retries) ? cfg.retries : 2,
    timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 120_000,
    log: (scope, message) => store.logEvent('download', scope, { message }),
  })
  return runtime.downloader
}

export function disposeRuntime(runtime) {
  if (!runtime) return
  try {
    for (const active of (runtime.activeRuns || new Map()).values()) {
      try { active.abort && active.abort.abort() } catch { /* ignore */ }
      try { for (const adapter of (active.adapters || new Map()).values()) adapter.dispose && adapter.dispose() } catch { /* ignore */ }
    }
    runtime.activeRuns && runtime.activeRuns.clear()
  } catch { /* ignore */ }
  try { if (runtime.store) runtime.store.close() } catch { /* ignore */ }
  runtime.store = null
  runtime.pubmedClient = null
  runtime.downloader = null
  runtime.ephemeralAdapters = null
  runtime.sourcesCache = null
  runtime.toolRegistered = false
  runtime.promptRegistered = false
}

// ---------------------------------------------------------------------------
// 分发
// ---------------------------------------------------------------------------

export async function runTool(runtime, args = {}) {
  const action = String(args.action || 'status')
  if (!ACTIONS.includes(action)) {
    throw storeError('bad_request', `未知 action ${action}，可用：${ACTIONS.join('、')}`)
  }
  const store = getStore(runtime)
  const handlers = {
    status: opStatus, templates: opTemplates, search: opSearch, source_detail: opSourceDetail,
    health: opHealth, download: opDownload, register: opRegister, datasets: opDatasets,
    ask: opAsk, plan: opPlan, submit: opSubmit, runs: opRuns, run_status: opRunStatus,
    cancel: opCancel, export: opExport, evidence: opEvidence, methods: opMethods,
    audit: opAudit, suggest: opSuggest, harmonize: opHarmonize, joint: opJoint,
    delete: opDelete, trash: opTrash, settings: opSettings, advise: opAdvise, topics: opTopics, suggest_next: opSuggestNext,
  }
  try {
    const result = await handlers[action](runtime, store, args)
    return sanitize(result)
  } finally {
    await disposeEphemeral(runtime)
  }
}

function sanitize(value, depth = 0) {
  if (depth > 30) return null
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1))
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      const item = value[key]
      if (item === undefined) continue
      out[key] = sanitize(item, depth + 1)
    }
    return out
  }
  return String(value)
}

// ---------------------------------------------------------------------------
// status / templates / datasets / suggest
// ---------------------------------------------------------------------------

async function opStatus(runtime, store) {
  const info = store.info()
  const plugins = await A.probePlugins({ pluginPaths: runtime.config && runtime.config.pluginPaths })
  const pluginRows = A.PLUGIN_IDS.map((plugin) => ({
    plugin,
    package: A.PLUGIN_META[plugin].package,
    label: A.PLUGIN_META[plugin].label,
    available: Boolean(plugins[plugin] && plugins[plugin].available),
    module_path: plugins[plugin] && plugins[plugin].module_path,
    error: plugins[plugin] && plugins[plugin].error || null,
  }))
  const healthCache = runtime.healthCache || null
  const result = {
    ok: true,
    action: 'status',
    version: VERSION,
    data_root: info.root,
    store_kind: info.kind,
    store_file: info.file,
    store_warnings: info.warnings,
    datasets: info.datasets,
    plans: info.plans,
    searches: info.searches,
    runs: info.runs,
    runs_by_status: info.runs_by_status,
    plugins: pluginRows,
    sources: SOURCE_IDS.map((source) => ({
      source, label: SOURCE_META[source].label,
      default_enabled: DEFAULT_SEARCH_SOURCES.includes(source),
      expected_time: source === 'cellxgene' ? '30–60s（默认关闭）' : source === 'metabolights' ? '5–10s' : '<8s',
    })),
    tabs: TABLES,
    summary: `许愿式生物信息全自动分析平台 ${VERSION} · ${info.kind} 存储 · 数据集 ${info.datasets} · plans ${info.plans} · runs ${info.runs} · 插件可用 ${pluginRows.filter((row) => row.available).length}/6`,
    suggest: info.datasets ? (info.runs ? '有 run 后可 run_status / evidence / export；新分析用 ask 或 plan。' : '用 plan 或 ask 出计划，确认后 submit。') : '先 search 找公共数据（GEO/GDC/MetaboLights）或 register 本地数据。',
  }
  if (healthCache) result.health = healthCache
  return result
}

function opTemplates() {
  const templates = P.listTemplates()
  return {
    ok: true, action: 'templates', templates,
    advanced: {
      harmonize: {
        action: 'harmonize',
        methods: H.HARMONIZE_METHODS,
        description: '多数据集特征对齐 + 批次评估 + 显式批次校正；未校正时禁止跨数据集合并推断',
        params: { dataset_ids: 'array', method: 'none|scale_only|quantile|combat', target_scale: H.TARGET_SCALES, aggregate: 'mean|max|sum', probe_map_file: 'path' },
      },
      joint: {
        action: 'joint',
        modes: J.JOINT_MODES,
        description: 'meta=多队列 fixed/random 合并；plot=统一走 plotlab；signature=bulk 签名→scRNA（model_prediction）',
        params: { mode: 'meta|plot|signature', cohorts: '[{run_id,table_id?}]', runs: '[{run_id,table_id?}]' },
      },
    },
    gates: P.listTemplates().map((template) => ({ template: template.id, gates: template.mandatory_gates })),
    summary: `模板：${templates.map((template) => template.id).join('、')}；高级：harmonize / joint（meta·plot·signature）`,
  }
}

/**
 * UI 首屏一次拿全：版本 / action 清单 / 六个模板 / 五个数据源 / 六个工作台接入状态 / 数据根。
 * 只做静态探测（probePlugins 不启动 Python worker），不读大文件，供 GET /bioflow/catalog。
 */
export async function buildCatalog(runtime) {
  const store = getStore(runtime)
  const info = store.info()
  const plugins = await A.probePlugins({ pluginPaths: runtime.config && runtime.config.pluginPaths })
  const pluginRows = A.PLUGIN_IDS.map((plugin) => ({
    plugin,
    package: A.PLUGIN_META[plugin].package,
    label: A.PLUGIN_META[plugin].label,
    available: Boolean(plugins[plugin] && plugins[plugin].available),
    module_path: plugins[plugin] && plugins[plugin].module_path,
    error: (plugins[plugin] && plugins[plugin].error) || null,
  }))
  return {
    ok: true,
    version: VERSION,
    platform: '许愿式生物信息全自动分析平台',
    display_name: '许愿式生物信息全自动分析平台',
    actions: ACTIONS,
    templates: P.listTemplates(),
    sources: SOURCE_IDS.map((source) => ({
      source,
      label: SOURCE_META[source].label,
      description: SOURCE_META[source].description,
      timeout_ms: SOURCE_META[source].timeout_ms,
      slow_ms: SOURCE_META[source].slow_ms,
      default_enabled: DEFAULT_SEARCH_SOURCES.includes(source),
    })),
    plugins: pluginRows,
    workbenches: {
      available: pluginRows.filter((row) => row.available).length,
      total: pluginRows.length,
      detail: pluginRows.map((row) => `${row.label}:${row.available ? 'ok' : 'missing'}`).join(' '),
    },
    deliverables: TABLES,
    gates: [
      { id: 'dataset_registered', blocks: '未登记/缺 sha256' },
      { id: 'sample_table', blocks: '样本表未知' },
      { id: 'sample_identity', blocks: '样本 ID 重复或与矩阵列对不上' },
      { id: 'groups', blocks: '分组缺失或只有 1 组（不需要组间比较的模板豁免）' },
      { id: 'contrast', blocks: '对比方向未定义（case/control）' },
      { id: 'replication', blocks: '每组独立生物学重复 n<2（描述性模板豁免）' },
      { id: 'design_confounded', blocks: '分组与批次/协变量完全共线' },
      { id: 'counts_verified', blocks: '尺度未验证或不在模板允许范围' },
      { id: 'assay_supported', blocks: '数据类型与模板不匹配' },
      { id: 'method_compatible', blocks: '统计方法与尺度不匹配' },
      { id: 'prerequisites', blocks: '前置产物/父 run 不可用' },
    ],
    data_root: info.root,
    store_kind: info.kind,
    counts: { datasets: info.datasets, plans: info.plans, searches: info.searches, runs: info.runs },
    routes: {
      dispatch: 'POST /bioflow/dispatch {action,...}',
      catalog: 'GET /bioflow/catalog',
      status: 'GET /bioflow/status',
      health: 'GET /bioflow/health?sources=geo,pubmed,gdc,metabolights,cellxgene',
      figures: 'GET /bioflow/figures/<run_id>/<file>',
      files: 'GET /bioflow/files/<dataRoot 相对路径>',
    },
  }
}

async function opDatasets(runtime, store, args) {
  if (args.dataset_id || args.dataset) {
    const dataset = store.getDataset(args.dataset_id || args.dataset)
    if (!dataset) throw storeError('not_found', `数据集不存在：${args.dataset_id || args.dataset}`)
    return { ok: true, action: 'datasets', dataset, summary: `数据集 ${dataset.dataset_id}：${dataset.name || ''}` }
  }
  const datasets = store.listDatasets({ limit: Number(args.limit) || 50 })
  return {
    ok: true, action: 'datasets',
    datasets: datasets.map((dataset) => ({
      dataset_id: dataset.dataset_id,
      name: dataset.name,
      assay: dataset.assay,
      data_kind: dataset.data_kind,
      n_samples: dataset.design ? (dataset.design.samples || []).length : null,
      groups: dataset.design ? [...new Set((dataset.design.samples || []).map((sample) => sample.group).filter(Boolean))] : [],
      scale: dataset.scale,
      files: (dataset.files || []).length,
      created_at: dataset.created_at,
    })),
    summary: `已登记数据集 ${datasets.length} 个`,
  }
}

async function opSuggest(runtime, store) {
  const datasets = store.listDatasets({ limit: 5 })
  const runs = store.listRuns({ limit: 5 })
  const suggestions = []
  if (!datasets.length) {
    suggestions.push({ id: 'search', title: '检索公共数据', detail: 'action=search term="gastric cancer liver metastasis" sources=["geo","gdc"]' })
    suggestions.push({ id: 'register', title: '登记本地数据', detail: 'action=register path=/abs/matrix.tsv sample_sheet=/abs/samples.tsv scale=counts verified=true' })
  } else if (!runs.length) {
    suggestions.push({ id: 'ask', title: '一句话出草稿计划', detail: 'action=ask need="把 GSE 里的肿瘤和正常比差异表达，出图"' })
    suggestions.push({ id: 'plan', title: '结构化计划', detail: `action=plan dataset=${datasets[0].dataset_id} template=bulk-two-group contrast={case,control}` })
  } else {
    const latest = store.getRun(runs[0].run_id)
    if (latest.status === 'blocked') suggestions.push({ id: 'fix-gates', title: '先修闸门', detail: 'action=run_status 看 gates；补样本表/尺度/对照组重复后再 plan' })
    if (latest.status === 'succeeded' || latest.status === 'partial') {
      suggestions.push({ id: 'export', title: '导出结果包', detail: `action=export run_id=${latest.run_id} out_path=<dir>` })
      suggestions.push({ id: 'evidence', title: '取证', detail: `action=evidence run_id=${latest.run_id}` })
      suggestions.push({ id: 'joint', title: '联合分析', detail: 'action=joint mode=meta cohorts=[{run_id:...},{run_id:...}]' })
    }
    if (latest.status === 'failed') suggestions.push({ id: 'diagnose', title: '看失败原因', detail: `action=run_status run_id=${latest.run_id}；看 steps[].error 与 stderr` })
  }
  return { ok: true, action: 'suggest', suggestions, summary: suggestions.map((item) => item.title).join('；') }
}

// ---------------------------------------------------------------------------
// ask（自然语言 → draft）
// ---------------------------------------------------------------------------

async function opAsk(runtime, store, args) {
  const text = args.need || args.query || args.text || args.utterance || args.query_nl || args.wish
  const datasets = store.listDatasets({ limit: 100 })
  let intent
  if (args.intent && typeof args.intent === 'object') {
    intent = args.intent
  } else {
    if (!text) throw storeError('bad_request', 'ask 需要 need/query（一句话，例如"把 GSE84433 的胃癌肝转移按 NK 比例和原发比一下，出图"）')
    intent = I.parseIntent({ text, datasets, datasetId: args.dataset || args.dataset_id || null })
  }
  // 编辑已有 draft：显式字段覆盖意图
  if (args.template && I.ALLOWED_TEMPLATES.includes(String(args.template))) intent.template = String(args.template)
  if (args.contrast && typeof args.contrast === 'object') intent.contrast = { case: args.contrast.case, control: args.contrast.control, direction: args.contrast.direction || 'case_minus_control', needs_confirm: true }
  if (args.case && args.control) intent.contrast = { case: String(args.case), control: String(args.control), direction: 'case_minus_control', needs_confirm: true }
  if (args.paired !== undefined) intent.design.paired = Boolean(args.paired)
  if (Array.isArray(args.covariates)) intent.design.covariates = args.covariates.map(String)
  if (args.min_cells !== undefined) intent.min_cells = Number(args.min_cells)
  if (args.fdr !== undefined) intent.fdr_family = typeof args.fdr === 'object' ? args.fdr : { method: 'BH', alpha: Number(args.fdr) }
  if (args.scale) intent.scale = String(args.scale)

  const warnings = []
  let resolved = I.resolveIntentDataset({ ...intent, dataset_hint: args.dataset || args.dataset_id || intent.dataset_hint }, datasets)
  let autoDataset = false
  const accessionText = (String(intent.raw_text || '').match(/\b(GSE\d{3,7}|TCGA-[A-Z0-9]{2,6}|MTBLS\d+)\b/i) || [])[0] || null
  let onlineCandidates = null
  if (!resolved.dataset && accessionText && !args.no_auto_dataset) {
    // 用户点名了编号但没登记：绝不拿本地不相关数据集顶替；去公共库查这个编号
    try {
      const found = await opAdvise(runtime, store, { need: intent.raw_text, term: accessionText, sources: ['geo', 'gdc', 'metabolights'], limit: 5 })
      onlineCandidates = found.recommendations || null
    } catch (error) { onlineCandidates = null }
    resolved = { dataset: null, matched_by: 'accession_unregistered', needs_confirm: true, accession: accessionText }
    warnings.push(`你点名的 ${accessionText} 还没有登记：已去公共库检索（见 online_candidates）。不会用本地数据集顶替；请先下载并登记。`)
  }
  if (!resolved.dataset && datasets.length && !args.no_auto_dataset && !accessionText) {
    // 许愿式：话里没点名数据集时，别回一句"缺 dataset"，直接挑一个最可用的已登记数据集
    const rank = (dataset) => {
      const samples = (dataset.design && Array.isArray(dataset.design.samples)) ? dataset.design.samples : []
      const groups = new Set(samples.map((sample) => String(sample.group || '').trim()).filter(Boolean))
      let score = 0
      if (groups.size >= 2) score += 30
      if (samples.length >= 2) score += 10
      if (dataset.scale && dataset.scale.verified) score += 8
      score += Math.min(10, Math.floor(samples.length / 4))
      return score
    }
    const ranked = datasets.slice().sort((left, right) => rank(right) - rank(left))
    const picked = ranked[0]
    if (picked) {
      autoDataset = true
      resolved = {
        dataset: picked, matched_by: 'auto', auto: true, needs_confirm: true,
        alternatives: ranked.slice(0, 5).map((dataset) => ({ dataset_id: dataset.dataset_id, name: dataset.name, n_samples: (dataset.design && dataset.design.samples || []).length, data_kind: dataset.data_kind })),
      }
    }
  }
  const datasetOptions = datasets.slice(0, 8).map((dataset) => {
    const groups = [...new Set(((dataset.design && dataset.design.samples) || []).map((sample) => String(sample.group || '').trim()).filter(Boolean))]
    const summaryZh = summarizeDatasetZh({
      dataset_id: dataset.dataset_id, source: 'registered', species: dataset.species,
      n_samples: (dataset.design && Array.isArray(dataset.design.samples)) ? dataset.design.samples.length : 0,
      scale: dataset.scale ? dataset.scale.type : null, groups,
      files: dataset.files, clinical: dataset.clinical,
    }, dataset.data_kind)
    return {
      dataset_id: dataset.dataset_id,
      name: dataset.name,
      n_samples: (dataset.design && Array.isArray(dataset.design.samples)) ? dataset.design.samples.length : 0,
      groups,
      data_kind: dataset.data_kind,
      scale: dataset.scale ? dataset.scale.type : null,
      verified: Boolean(dataset.scale && dataset.scale.verified),
      summary_zh: summaryZh,
    }
  })
  let llmUsed = false
  let llmSuggestion = null
  if (!intent.template && typeof runtime.llmResolver === 'function') {
    const assisted = await I.llmAssist({ resolver: runtime.llmResolver, text: intent.raw_text, dataset: resolved.dataset, datasets })
    if (assisted.used) {
      llmUsed = true
      llmSuggestion = assisted.suggestion
      warnings.push(...(assisted.warnings || []))
      if (assisted.suggestion && assisted.suggestion.template && !intent.template) intent.template = assisted.suggestion.template
      if (assisted.suggestion && assisted.suggestion.contrast && !intent.contrast) intent.contrast = { ...assisted.suggestion.contrast, needs_confirm: true }
      if (assisted.suggestion && assisted.suggestion.paired !== undefined) intent.design.paired = Boolean(assisted.suggestion.paired)
      if (assisted.suggestion && Array.isArray(assisted.suggestion.covariates) && !intent.design.covariates.length) intent.design.covariates = assisted.suggestion.covariates
    } else {
      warnings.push(`LLM 兜底未使用：${assisted.reason || '未配置'}`)
    }
  }
  // 模板/对照在 impl 侧再兜一次底：话里没点名时自动选数据集、自动判方向、模板与模态对齐。
  if (resolved.dataset) {
    const kind = String(resolved.dataset.data_kind || 'unknown')
    const templateDef = intent.template ? P.TEMPLATES[intent.template] : null
    const compatible = templateDef && (templateDef.requires_kind || []).some((need) => need === kind || need === 'any')
    if (!intent.template || !compatible) {
      const fallback = defaultTemplateFor(kind)
      if (intent.template && intent.template !== fallback) warnings.push(`模板 ${intent.template} 与数据模态 ${kind} 不匹配，已改用 ${fallback}`)
      intent.template = fallback
    }
    if (!intent.contrast) {
      const samples = (resolved.dataset.design && Array.isArray(resolved.dataset.design.samples)) ? resolved.dataset.design.samples : []
      const groups = [...new Set(samples.map((sample) => String(sample.group || '').trim()).filter(Boolean))]
      if (groups.length === 2) {
        const CONTROL = /(normal|control|healthy|adjacent|para|non.?tumou?r|untreated|sensitive|benign|baseline)/i
        const CASE = /(tumou?r|case|disease|cancer|carcinoma|metasta|malignant|treated|resistant|progress)/i
        const sorted = groups.slice().sort((left, right) => {
          const score = (name) => (CONTROL.test(name) ? -1 : CASE.test(name) ? 1 : 0)
          return score(right) - score(left) || String(left).localeCompare(String(right))
        })
        intent.contrast = { case: sorted[0], control: sorted[1], direction: 'case_minus_control', needs_confirm: true, auto: true }
        warnings.push(`数据里只有两组（${sorted[0]} / ${sorted[1]}），已自动判定方向，可在计划卡里改`)
      }
    }
  }
  const draft = I.buildDraft({ intent, dataset: resolved.dataset, datasets, llmUsed, llmSuggestion, warnings })
  draft.dataset_match = {
    dataset_id: resolved.dataset ? resolved.dataset.dataset_id : null,
    matched_by: resolved.matched_by,
    needs_confirm: resolved.needs_confirm,
    auto_selected: autoDataset,
    alternatives: resolved.alternatives || [],
  }
  draft.dataset_options = datasetOptions
  if (onlineCandidates) draft.online_candidates = onlineCandidates
  if (accessionText && !resolved.dataset) {
    draft.accession_unregistered = accessionText
    draft.missing_fields = [...new Set([...(draft.missing_fields || []), 'dataset'])]
    draft.next = `先下载并登记 ${accessionText}（download → register），再提交计划`
  }
  if (autoDataset) warnings.push(`没有从话里认出数据集，已自动选「${resolved.dataset.name || resolved.dataset.dataset_id}」（可在计划卡里换）`)
  if (resolved.needs_confirm && resolved.dataset) {
    draft.questions = [{ field: 'dataset', question: `用这个数据集吗：${resolved.dataset.name || resolved.dataset.dataset_id}？`, candidates: draft.candidates.dataset || [] }, ...(draft.questions || [])]
  }
  // draft 落盘，submit 用 plan_id + confirm_token
  const storedPlan = {
    ...draft.plan,
    confirm_token: draft.confirm_token,
    fields: draft.fields,
    missing_fields: draft.missing_fields,
    draft: true,
    status: 'draft',
    created_by: 'ask',
    intent,
    created_at: nowIso(),
  }
  store.putPlan(storedPlan)
  store.logEvent('ask', 'draft', { plan_id: storedPlan.plan_id, missing: draft.missing_fields })
  return {
    ...draft,
    action: 'ask',
    plan: storedPlan,
    plan_id: storedPlan.plan_id,
    status: 'draft',
    summary: draft.summary,
  }
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

async function opPlan(runtime, store, args) {
  if (args.need && !args.template && !args.steps) return opAsk(runtime, store, args)
  const datasets = store.listDatasets({ limit: 100 })
  let dataset = null
  if (args.dataset || args.dataset_id) {
    dataset = P.resolvePlanDataset(store, args.dataset || args.dataset_id)
  } else if (datasets.length === 1) {
    dataset = datasets[0]
  } else {
    throw storeError('prerequisite', `plan 需要 dataset（当前已登记 ${datasets.length} 个）`)
  }
  const params = { ...(args.params || {}) }
  for (const key of ['case', 'control', 'contrast', 'group_column', 'donor_column', 'paired', 'covariates', 'seed', 'min_cells', 'method', 'fdr', 'alpha', 'enrich_db', 'cell_type_column', 'resolution',
    // 新增四个模板的参数（空间/代谢/虚拟细胞/绘图）
    'gene', 'mode', 'strength', 'cluster', 'n_hvg', 'n_svg', 'n_domains', 'n_comp', 'n_features', 'chart', 'chart_params', 'style', 'roles', 'data_kind', 'slice_column']) {
    if (args[key] !== undefined) params[key] = args[key]
  }
  if (args.case || args.control) params.contrast = { case: args.case, control: args.control, direction: 'case_minus_control' }
  if (args.covariates !== undefined) params.covariates = Array.isArray(args.covariates) ? args.covariates : String(args.covariates).split(',')
  const template = args.template ? String(args.template) : (args.steps ? null : defaultTemplateFor(dataset.data_kind))
  const templateSource = args.template ? 'explicit' : template ? 'default_for_data_kind' : 'custom_steps'
  let plan
  if (args.steps) {
    plan = P.buildPlan({ dataset, template: null, params, customSteps: args.steps })
  } else {
    plan = P.buildPlan({ dataset, template, params, parentRun: args.parent_run || null, parentRunRecord: args.parent_run ? store.getRun(args.parent_run) : null })
  }
  const confirmToken = sha256(JSON.stringify({ plan_id: plan.plan_id, template: plan.template, dataset_id: plan.dataset_id, params: plan.params, seed: plan.seed, contrast: plan.contrast }))
  const stored = { ...plan, confirm_token: confirmToken, created_by: 'plan', created_at: nowIso() }
  store.putPlan(stored)
  return {
    ok: plan.status === 'ready',
    action: 'plan',
    status: plan.status,
    plan_id: stored.plan_id,
    confirm_token: confirmToken,
    plan: stored,
    blocking: plan.blocking,
    gates: plan.gates,
    template_source: templateSource,
    summary: plan.status === 'ready'
      ? `计划就绪（${plan.template}，${templateSource === 'default_for_data_kind' ? '按数据模态默认' : '显式指定'}），已写闸门 ${plan.gates.length} 条；提交需要 confirm_token`
      : `计划被闸门拦下：${(plan.blocking || []).map((gate) => `${gate.id}: ${gate.detail}`).join('；')}`,
    rows: (plan.gates || []).map((gate) => ({ gate: gate.id, status: gate.status, detail: gate.detail || '' })),
  }
}

// ---------------------------------------------------------------------------
// submit / executor (续跑入口见 startQueuedRun)
/** 续跑一条 pending_review/queued 的 run（不重新生成计划）。 */
async function startQueuedRun(runtime, store, args) {
  const runId = String(args.run_id || args.run)
  const run = store.getRun(runId)
  if (!run) throw storeError('not_found', `run 不存在：${runId}`)
  if (['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status)) {
    throw storeError('bad_transition', `run ${runId} 已是终态 ${run.status}；重新跑请用 action=submit 带 plan_id（失败/取消会自动产生新 run）`, { status: run.status })
  }
  runtime.backgroundRuns = runtime.backgroundRuns || new Map()
  const inFlight = runtime.backgroundRuns.get(runId)
  const plan = run.plan_id ? store.getPlan(run.plan_id) : null
  if (!plan) throw storeError('prerequisite', `run ${runId} 的计划 ${run.plan_id} 不存在，无法续跑`)
  const dataset = plan.dataset_id ? store.getDataset(plan.dataset_id) : null
  if (run.status === 'pending_review') store.transition(runId, 'queued')
  if (inFlight) {
    const finalRun = await inFlight
    return { ok: finalRun && finalRun.status === 'succeeded', action: 'submit', run_id: runId, run: store.getRun(runId), reused: true, status: (finalRun && finalRun.status) || store.getRun(runId).status, summary: `run ${runId} 已在执行（复用同一个执行任务）` }
  }
  const wait = args.wait !== undefined ? Boolean(args.wait) : (runtime.config && runtime.config.wait === true) || runtime.invocation === 'cli' || runtime.invocation === 'test'
  const task = executeRun(runtime, store, runId, plan, dataset).catch((error) => {
    try {
      const current = store.getRun(runId)
      if (current && !['failed', 'cancelled', 'succeeded', 'partial'].includes(current.status)) {
        store.transition(runId, 'failed', { error: String(error && error.message ? error.message : error) })
      }
    } catch { /* ignore */ }
    return { run_id: runId, status: 'failed', error: String(error && error.message ? error.message : error) }
  })
  runtime.backgroundRuns.set(runId, task)
  if (!wait) {
    return { ok: true, action: 'submit', run_id: runId, run: store.getRun(runId), reused: false, status: 'queued', summary: `run ${runId} 已开始执行；用 action=run_status 查看进度` }
  }
  const result = await task
  const finalRun = store.getRun(runId)
  return {
    ok: finalRun.status === 'succeeded',
    action: 'submit', run_id: runId, run: finalRun, reused: false,
    status: finalRun.status,
    summary: `run ${runId} → ${finalRun.status}${finalRun.error ? `（${finalRun.error}）` : ''}`,
    rows: (finalRun.steps || []).map((step) => ({ step: step.step_id, status: step.status, detail: step.error || '' })),
  }
}


// ---------------------------------------------------------------------------

function confirmGate(storedPlan, token, config = {}) {
  const expected = storedPlan.confirm_token
  if (!expected) return { ok: true }
  if (!token) {
    return {
      ok: false,
      code: 'confirm_required',
      message: '提交前需要用户确认：请把计划给用户看，然后用 action=submit 带 plan_id + confirm_token',
      details: { plan_id: storedPlan.plan_id, confirm_token: expected, status: storedPlan.status, summary: summarizePlan(storedPlan) },
    }
  }
  if (String(token) !== String(expected)) {
    return {
      ok: false,
      code: 'draft_changed',
      message: 'confirm_token 与当前计划不一致（确认前改过字段或 token 过期）；请重新 action=plan/ask 生成 draft 并确认',
      details: { plan_id: storedPlan.plan_id },
    }
  }
  return { ok: true }
}

function summarizePlan(plan) {
  return {
    plan_id: plan.plan_id,
    template: plan.template,
    status: plan.status,
    dataset_id: plan.dataset_id,
    contrast: plan.contrast,
    design: plan.design,
    gates: (plan.gates || []).filter((gate) => gate.status === 'fail').map((gate) => ({ id: gate.id, detail: gate.detail })),
    steps: (plan.steps || []).map((step) => ({
      step_id: step.step_id,
      plugin: step.plugin,
      action: step.action,
      optional: Boolean(step.optional),
      // UI 时间线展开要看每步参数（只读展示，不含 $RUN_DIR 之外的秘密）
      params: step.params || {},
      deliver: step.deliver || null,
      label: step.label || null,
    })),
    confirm_token: plan.confirm_token,
  }
}

async function opSubmit(runtime, store, args) {
  // 启动一条「待核对/排队」的 run（submit start:false 之后用它续跑，不重新 plan）。
  if (!args.plan_id && (args.run_id || args.run)) return startQueuedRun(runtime, store, args)
  let storedPlan = null
  if (args.plan_id) {
    storedPlan = store.getPlan(String(args.plan_id))
    if (!storedPlan) throw storeError('not_found', `plan 不存在：${args.plan_id}（先 action=plan 或 ask）`)
  } else {
    const planned = await opPlan(runtime, store, args)
    storedPlan = store.getPlan(planned.plan_id)
  }
  if (storedPlan.status === 'blocked') {
    const error = storeError('blocked', `计划被闸门拦下，不能提交：${(storedPlan.blocking || []).map((gate) => gate.id).join('、')}`, {
      plan_id: storedPlan.plan_id, blocking: storedPlan.blocking,
      gates: (storedPlan.gates || []).filter((gate) => gate.status === 'fail'),
    })
    throw error
  }
  const confirmation = confirmGate(storedPlan, args.confirm_token, (runtime.config || {}))
  if (!confirmation.ok) {
    const error = storeError(confirmation.code, confirmation.message, confirmation.details)
    throw error
  }
  const dataset = storedPlan.dataset_id ? store.getDataset(storedPlan.dataset_id) : null
  if (dataset) {
    const verification = await S.verifyDatasetFiles(dataset)
    if (!verification.ok) {
      throw storeError('artifact_mismatch', `数据文件哈希与登记时不一致（冻结失败）：${verification.mismatches.map((item) => item.name).join('、') || verification.missing.map((item) => item.name).join('、')}`, verification)
    }
  }
  const explicitKey = Boolean(args.idempotency_key)
  const baseKey = args.idempotency_key || idempotencyKey({
    dataset_id: storedPlan.dataset_id,
    dataset_revision: storedPlan.dataset_revision,
    plan_hash: storedPlan.plan_id,
    template: storedPlan.template,
    template_version: storedPlan.template_version,
    seed: storedPlan.seed,
    params: storedPlan.params,
    steps: (storedPlan.steps || []).map((step) => ({ plugin: step.plugin, action: step.action, params: step.params, optional: Boolean(step.optional) })),
    parent_run: storedPlan.parent_run || null,
  })
  const key = retryAwareKey(store, baseKey, storedPlan.plan_id, explicitKey)
  const runId = `run_${nowIso().replace(/[-:TZ.]/g, '').slice(0, 14)}_${sha256(key).slice(0, 8)}`
  const { run, reused } = store.createRun({
    run_id: runId,
    idempotency_key: key,
    status: args.start === false ? 'pending_review' : 'queued',
    plan_id: storedPlan.plan_id,
    plan_hash: storedPlan.plan_id,
    template: storedPlan.template,
    template_version: storedPlan.template_version,
    dataset_id: storedPlan.dataset_id,
    dataset_revision: storedPlan.dataset_revision,
    params: storedPlan.params,
    seed: storedPlan.seed,
    parent_run: storedPlan.parent_run || null,
  })
  if (reused) {
    return { ok: true, action: 'submit', run_id: run.run_id, run, reused: true, status: run.status, summary: `同参数 run 已存在：${run.run_id}` }
  }
  if (args.start === false) {
    return { ok: true, action: 'submit', run_id: run.run_id, run, reused: false, status: 'pending_review', summary: `计划已入队为待核对：${run.run_id}；确认后 action=submit run_id=${run.run_id} start=true` }
  }
  runtime.backgroundRuns = runtime.backgroundRuns || new Map()
  const wait = args.wait !== undefined
    ? Boolean(args.wait)
    : (runtime.config && runtime.config.wait === true) || runtime.invocation === 'cli' || runtime.invocation === 'test'
  const task = executeRun(runtime, store, run.run_id, storedPlan, dataset).catch((error) => {
    try {
      const current = store.getRun(run.run_id)
      if (current && !['failed', 'cancelled', 'succeeded', 'partial'].includes(current.status)) {
        store.transition(run.run_id, 'failed', { error: String(error && error.message ? error.message : error) })
      }
    } catch { /* ignore */ }
    return { run_id: run.run_id, status: 'failed', error: String(error && error.message ? error.message : error) }
  })
  runtime.backgroundRuns.set(run.run_id, task)
  if (wait) {
    const result = await task
    const finalRun = store.getRun(run.run_id)
    return {
      ok: finalRun.status === 'succeeded',
      action: 'submit',
      run_id: run.run_id,
      run: finalRun,
      reused: false,
      status: finalRun.status,
      summary: `run ${run.run_id} → ${finalRun.status}${finalRun.error ? `（${finalRun.error}）` : ''}`,
      rows: (finalRun.steps || []).map((step) => ({ step: step.step_id, status: step.status, detail: step.error || '' })),
    }
  }
  return {
    ok: true, action: 'submit', run_id: run.run_id, run, reused: false, status: 'queued',
    summary: `run 已入队：${run.run_id}；用 action=run_status 查看进度`,
  }
}

/** 一个 run 的执行器：每插件一个临时 worker，结束统一 dispose。 */
export /**
 * 清理本次 run 的临时目录。worker 刚 dispose 时子进程可能还在落最后一笔文件，
 * 所以 engines 删除带一次延迟重试（否则会留下空的 engines/<plugin> 目录被 audit 记成脏）。
 */
async function cleanRunScratch(runDir, { keepEngines = false, aggressive = false } = {}) {
  try { fs.rmSync(path.join(runDir, '.staging'), { recursive: true, force: true }) } catch { /* ignore */ }
  if (keepEngines) return
  const engines = path.join(runDir, 'engines')
  // 取消/失败时 worker 是被 kill 的：它可能还在启动（例如 Matplotlib 建字体缓存），
  // 会在我们删掉目录后再写一次。这里做有上限的复删，直到目录真正消失。
  const rounds = aggressive ? 12 : 1
  for (let round = 0; round < rounds; round += 1) {
    if (fs.existsSync(engines)) {
      try { fs.rmSync(engines, { recursive: true, force: true }) } catch { /* 下一轮再试 */ }
    }
    if (!aggressive) return
    // 不能「删掉就收工」：被 kill 的 worker 可能几十毫秒后又重建目录写日志。
    // 固定观察 ~3s，期间反复删除，最后一次删除之后自然结束。
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  try { fs.rmSync(engines, { recursive: true, force: true }) } catch { /* ignore */ }
}

async function executeRun(runtime, store, runId, plan, dataset) {
  const run = store.getRun(runId)
  if (!run) throw storeError('not_found', `run 不存在：${runId}`)
  const runDir = store.runDir(runId)
  ensureDir(runDir)
  const adapters = new Map()
  const adapterStatus = {}
  const abort = new AbortController()
  runtime.activeRuns = runtime.activeRuns || new Map()
  runtime.activeRuns.set(runId, { abort, adapters, plan })
  const stepOutputs = []
  const runWarnings = []
  let currentStepId = null
  try {
    store.transition(runId, 'running')
    for (const step of plan.steps) {
      currentStepId = step.step_id
      if (store.isCancelled(runId)) throw storeError('cancelled', 'run 已取消')
      const startedAt = nowIso()
      store.setStep(runId, {
        step_id: step.step_id, plugin: step.plugin, action: step.action,
        status: 'running', started_at: startedAt, deliver: step.deliver,
      })
      store.beginAttempt(runId, step.step_id)
      let staged = null
      try {
        const expandedStep = expandStepParams(step, { runDir })
        let result
        if (expandedStep.plugin === 'bioflow') {
          result = await runBuiltinStep(runtime, store, expandedStep, { runId, runDir, plan, dataset, signal: abort.signal })
        } else {
          if (!adapters.has(step.plugin)) {
            const adapterWorkdir = path.join(runDir, 'engines', step.plugin)
            const adapter = typeof runtime.adapterFactory === 'function'
              ? await runtime.adapterFactory(step.plugin, { workdir: adapterWorkdir, runId })
              : await A.createAdapter(step.plugin, {
                workdir: adapterWorkdir,
                config: pluginConfig(runtime, step.plugin),
                pluginPaths: runtime.config && runtime.config.pluginPaths,
                python: runtime.config && runtime.config.python,
              })
            adapters.set(step.plugin, adapter)
          }
          const adapter = adapters.get(step.plugin)
          const timeoutMs = Number(step.timeout_ms) > 0 ? Number(step.timeout_ms) : 30 * 60 * 1000
          // 必须用 expandedStep：$RUN_DIR 等占位符只有展开后的参数才能交给插件引擎
          result = await adapter.invoke(expandedStep.action, expandedStep.params || {}, {
            timeoutMs,
            deadline: Date.now() + timeoutMs,
            signal: abort.signal,
          })
          adapterStatus[step.plugin] = {
            module_path: adapter.modulePath,
            python: adapter.info && adapter.info.python,
            python_version: adapter.info && adapter.info.version,
            mode: adapter.info && adapter.info.mode,
            packages: adapter.info && adapter.info.packages,
          }
        }
        if (store.isCancelled(runId)) throw storeError('cancelled', 'run 已取消（步骤完成后丢弃产物）')
        staged = await D.stageStepResult({ run, runDir, plan, dataset, step: expandedStep, result })
        await D.commitStepResult({ store, run, runDir, staged, step: expandedStep })
        const stepRecord = store.setStep(runId, {
          step_id: step.step_id, plugin: expandedStep.plugin, action: expandedStep.action,
          status: 'ok', started_at: startedAt, finished_at: nowIso(), deliver: expandedStep.deliver,
        })
        stepOutputs.push({
          step: expandedStep, status: 'ok', result, tables: staged.tables, figures: staged.figures,
          summary: staged.summary, warnings: result && result.warnings ? result.warnings : [], stepRecord,
        })
        if (result && Array.isArray(result.warnings)) runWarnings.push(...result.warnings.map((warning) => `${step.step_id}: ${warning}`))
        store.logEvent('run', 'step_ok', { run_id: runId, step_id: step.step_id })
      } catch (error) {
        const cancelled = error && error.code === 'cancelled' || store.isCancelled(runId)
        if (staged) removeDir(staged.staging)
        store.setStep(runId, {
          step_id: step.step_id, plugin: step.plugin, action: step.action,
          status: cancelled ? 'cancelled' : 'failed', started_at: startedAt, finished_at: nowIso(),
          error: String(error && error.message ? error.message : error),
          deliver: step.deliver,
        })
        if (cancelled) throw error
        stepOutputs.push({
          step, status: 'failed', error: String(error && error.message ? error.message : error),
          code: (error && error.code) || 'engine_error', details: error && error.details ? error.details : null,
          tables: [], figures: [],
        })
        store.logEvent('run', 'step_failed', { run_id: runId, step_id: step.step_id, error: String(error && error.message ? error.message : error) })
        if (!step.optional) throw error
        runWarnings.push(`${step.step_id}（可选步骤）失败：${error && error.message ? error.message : error}`)
      }
    }
    const requiredFailed = stepOutputs.filter((output) => output.status === 'failed' && !(output.step && output.step.optional))
    const optionalFailed = stepOutputs.filter((output) => output.status === 'failed' && output.step && output.step.optional)
    const status = requiredFailed.length ? 'failed' : optionalFailed.length ? 'partial' : 'succeeded'
    const finalized = await D.finalizeRun({
      store, run: store.getRun(runId), plan, dataset, stepOutputs,
      environment: buildEnvironment(runtime, store, adapterStatus),
      status,
      warnings: runWarnings,
    })
    store.logEvent('run', 'finished', { run_id: runId, status, zero_significant: finalized.zero_significant })
    return {
      run_id: runId, status, ok: status === 'succeeded', zero_significant: finalized.zero_significant,
      manifest_sha256: finalized.manifest_sha256, evidence: finalized.evidence, steps: store.getRun(runId).steps,
    }
  } catch (error) {
    const cancelled = (error && error.code === 'cancelled') || store.isCancelled(runId)
    if (cancelled) {
      // 取消零写入：清理整个 staging，不写 manifest
      removeDir(path.join(runDir, '.staging'))
      store.logEvent('run', 'cancelled', { run_id: runId, step: currentStepId })
      throw storeError('cancelled', `run ${runId} 已取消（未提交任何产物）`)
    }
    // 必选步骤失败：仍要落一份「失败版」manifest/design/qc/methods，
    // 否则事后只有 job 状态，没有可诊断的步骤记录与已产出文件清单。
    try {
      const message = String(error && error.message ? error.message : error)
      runWarnings.push(`run 失败：${currentStepId ? `步骤 ${currentStepId}` : '执行器'}：${message}`)
      const failed = await D.finalizeRun({
        store,
        run: store.getRun(runId),
        plan,
        dataset,
        stepOutputs,
        environment: buildEnvironment(runtime, store, adapterStatus),
        status: 'failed',
        warnings: runWarnings,
      })
      store.logEvent('run', 'failed_manifest', { run_id: runId, manifest_sha256: failed.manifest_sha256 })
    } catch (finalizeError) {
      try { store.logEvent('run', 'failed_manifest_error', { run_id: runId, error: String(finalizeError && finalizeError.message ? finalizeError.message : finalizeError) }) } catch { /* ignore */ }
    }
    throw error
  } finally {
    for (const adapter of adapters.values()) {
      try { await adapter.dispose() } catch { /* ignore */ }
    }
    runtime.activeRuns.delete(runId)
    // 成功/失败/取消都清掉本次 run 的 staging 与插件 scratch，避免残留被 audit 记成脏状态。
    const finalStatus = (store.getRun(runId) || {}).status
    await cleanRunScratch(runDir, {
      keepEngines: Boolean(runtime.config && runtime.config.keepEngineScratch),
      aggressive: finalStatus === 'cancelled' || finalStatus === 'failed',
    })
  }
}

function pluginConfig(runtime, plugin) {
  const plugins = (runtime.config && runtime.config.plugins) || {}
  return plugins[plugin] && typeof plugins[plugin] === 'object' ? plugins[plugin] : {}
}

function expandStepParams(step, context) {
  const expand = (value) => {
    if (typeof value === 'string') return value.replace(/\$RUN_DIR/g, context.runDir)
    if (Array.isArray(value)) return value.map(expand)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [key, item] of Object.entries(value)) out[key] = expand(item)
      return out
    }
    return value
  }
  return { ...step, params: expand(step.params || {}) }
}

function buildEnvironment(runtime, store, adapterStatus) {
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    bioflow_version: VERSION,
    store_kind: store.kind,
    plugins: adapterStatus,
    builtin: ['harmonize', 'meta_analysis', 'joint_plot_prepare'],
    captured_at: nowIso(),
  }
}

// ---------------------------------------------------------------------------
// 内置计算步骤（不重算插件分析；这些是 bioflow 自己的归一化/合并）
// ---------------------------------------------------------------------------

async function runBuiltinStep(runtime, store, step, context) {
  const action = step.action
  const params = step.params || {}
  const staging = path.join(context.runDir, '.staging', safeName(step.step_id, 'step'))
  ensureDir(staging)
  if (action === 'harmonize') {
    return H.runHarmonize({ ...params, outdir: staging, log: (scope, message) => store.logEvent('harmonize', scope, { message }) })
  }
  if (action === 'meta_analysis') {
    return J.runMetaAnalysis({ store, ...params, outdir: staging })
  }
  if (action === 'joint_prepare') {
    return J.prepareJointPlotData({ store, ...params, outdir: staging })
  }
  throw storeError('unsupported', `未知内置步骤 ${action}（可用：harmonize/meta_analysis/joint_prepare）`)
}

// ---------------------------------------------------------------------------
// harmonize / joint actions
// ---------------------------------------------------------------------------

/**
 * 失败/取消过的同参数 run 允许重试：给幂等键加 `#retryN`，产生新 run_id。
 * 成功/部分成功的同参数 run 仍然复用（真正的幂等），不会重复跑。
 */
function retryAwareKey(store, baseKey, planId, explicit) {
  if (explicit) return baseKey
  const prior = store.listRuns({ limit: 1000 })
    .filter((run) => run.plan_id === planId && ['failed', 'cancelled'].includes(run.status)).length
  return prior ? `${baseKey}#retry${prior}` : baseKey
}

async function createInternalRun(runtime, store, { plan, dataset, label }) {
  const baseKey = idempotencyKey({ plan_hash: plan.plan_id, steps: plan.steps, template: plan.template, dataset_id: plan.dataset_id })
  const key = retryAwareKey(store, baseKey, plan.plan_id, false)
  const runId = `run_${nowIso().replace(/[-:TZ.]/g, '').slice(0, 14)}_${sha256(key).slice(0, 8)}`
  const { run, reused } = store.createRun({
    run_id: runId, idempotency_key: key, status: 'queued',
    plan_id: plan.plan_id, plan_hash: plan.plan_id, template: plan.template,
    template_version: plan.template_version, dataset_id: plan.dataset_id,
    dataset_revision: plan.dataset_revision, params: plan.params, seed: plan.seed,
  })
  if (reused) return { run, reused: true }
  const result = await executeRun(runtime, store, run.run_id, plan, dataset)
  return { run: store.getRun(run.run_id), reused: false, result, label }
}

/**
 * harmonize 之后把合并矩阵登记成一个「合并数据集」，后续 template 可以直接拿它跑分析。
 * 这样「多个数据集 → 校正 → 继续跑」是一条链，而不是校正完就没下文。
 */
async function registerMergedDataset(store, runId, datasets, { method, targetScale }) {
  const runDir = store.runDir(runId)
  const gz = path.join(runDir, 'results', 'harmonized_matrix.tsv.gz')
  if (!fs.existsSync(gz)) return null
  let text
  try { text = zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8') } catch { return null }
  const firstLine = String(text).split(/\r?\n/, 1)[0] || ''
  const delimiter = (firstLine.match(/\t/g) || []).length >= (firstLine.match(/,/g) || []).length ? '\t' : ','
  const sampleNames = firstLine.split(delimiter).slice(1).map((name) => name.trim()).filter(Boolean)
  const byDataset = new Map(datasets.map((dataset) => [dataset.dataset_id, dataset]))
  const samples = []
  const unresolved = []
  for (const rawName of [...new Set(sampleNames)]) {
    // harmonize 的合并矩阵列名形如 "<dataset_id>:<原样本名>"（也兼容 "__"）
    const match = rawName.match(/^(.*?)(?::|__)(.+)$/)
    const datasetId = match ? match[1] : null
    const originalId = match ? match[2] : rawName
    const dataset = datasetId ? byDataset.get(datasetId) : null
    const pool = dataset && Array.isArray(dataset.design && dataset.design.samples) ? dataset.design.samples : []
    const hit = pool.find((sample) => String(sample.sample_id) === originalId || String(sample.display_name || '') === originalId)
    if (!hit) {
      unresolved.push(rawName)
      samples.push({ sample_id: rawName, display_name: rawName, group: '', donor_id: '', batch: datasetId || '', pair_id: '' })
      continue
    }
    samples.push({
      sample_id: rawName,
      display_name: String(hit.display_name || originalId),
      group: String(hit.group || ''),
      donor_id: String(hit.donor_id || hit.donor || ''),
      batch: String(datasetId || ''),
      pair_id: String(hit.pair_id || ''),
    })
  }
  // 守恒检查：合并样本数必须等于各输入队列样本数之和；对不上就拒绝登记，避免串组
  const expected = datasets.reduce((sum, dataset) => {
    const pool = dataset.design && Array.isArray(dataset.design.samples) ? dataset.design.samples : []
    return sum + pool.length
  }, 0)
  if (expected && samples.length !== expected) {
    throw new Error(`合并样本数不守恒：输入合计 ${expected}，合并矩阵 ${samples.length}；拒绝登记（可能发生样本串组或对齐丢样）`)
  }
  if (unresolved.length) {
    throw new Error(`有 ${unresolved.length} 个合并样本无法按「dataset_id:原样本名」回查来源（例如 ${unresolved.slice(0, 3).join('、')}）；拒绝登记`)
  }
  const groups = [...new Set(samples.map((sample) => sample.group).filter(Boolean))]
  const scaleMap = { counts: 'counts', tpm: 'tpm', log_expression: 'log_expression', zscore: 'normalized_expression', none: 'normalized_expression' }
  const dsid = `ds_harm_${sha256(JSON.stringify({ run_id: runId, method, targetScale })).slice(0, 12)}`
  const existing = store.getDataset(dsid)
  if (existing) return { dataset: existing, reused: true }
  const dir = store.datasetDir(dsid)
  ensureDir(dir)
  const matrixPath = path.join(dir, 'harmonized_matrix.tsv')
  atomicWriteFile(matrixPath, text)
  const header = ['sample', 'group', 'donor', 'batch', 'source_dataset', 'source_sample']
  const lines = [header.join('\t')].concat(samples.map((sample) => {
    const parts = sample.sample_id.split(/:(.+)|__(.+)/)
    return [sample.sample_id, sample.group, sample.donor_id, sample.batch, sample.batch, parts[1] || parts[2] || sample.sample_id].join('\t')
  }))
  const sheetPath = path.join(dir, 'samples.tsv')
  atomicWriteFile(sheetPath, lines.join('\n') + '\n')
  const matrixSha = await sha256File(matrixPath)
  const manifest = {
    schema_version: 1,
    dataset_id: dsid,
    name: `merged:${datasets.map((item) => item.name || item.dataset_id).join(' + ')}`,
    created_at: nowIso(),
    source: { kind: 'harmonize', run_id: runId, method },
    assay: 'harmonized',
    data_kind: (datasets[0] && datasets[0].data_kind) || 'bulk',
    species: datasets[0] ? datasets[0].species : null,
    platform: null,
    reference: null,
    data_format: 'auto',
    transpose: true,
    scale: { type: scaleMap[String(targetScale || 'none')] || 'normalized_expression', verified: true, evidence: `harmonize 输出（method=${method}, target_scale=${targetScale || 'none'}）`, note: null },
    files: [{ path: matrixPath, name: 'harmonized_matrix.tsv', bytes: fileSize(matrixPath), sha256: matrixSha, artifact_id: matrixSha, role: 'matrix' }],
    sample_sheet: { path: sheetPath, sha256: await sha256File(sheetPath), columns: { sample: 'sample', group: 'group', donor: 'donor', batch: 'source_dataset' } },
    design: {
      group_column: 'group', donor_column: 'donor', batch_column: 'source_dataset', pair_column: null, paired: false,
      samples, columns: { sample: 'sample', group: 'group', donor: 'donor', batch: 'source_dataset', pair: null, material: null },
      unresolved: [],
      source_datasets: datasets.map((item) => item.dataset_id),
      source_mapping: samples.map((sample) => ({ merged_sample_id: sample.sample_id, source_dataset: sample.batch, source_sample: sample.display_name })),
    },
    conflicts: [],
    unverified: [],
    registered_at: nowIso(),
  }
  store.putDataset(manifest)
  store.logEvent('harmonize', 'merged_dataset', { dataset_id: dsid, run_id: runId, samples: samples.length })
  return {
    dataset: manifest, reused: false,
    summary: `合并数据集 ${dsid}：${samples.length} 样本 / ${groups.length ? groups.join('、') : '无分组'}（method=${method}）`,
  }
}

/**
 * 顺着这次结果继续许愿：读 run 的 manifest/results，给 2-4 个「下一步能做什么」，
 * 零显著时明确说「分析完成、当前阈值下无显著项」，不粉饰。
 */
async function opSuggestNext(runtime, store, args) {
  const runId = String(args.run_id || args.run || '')
  if (!runId) throw storeError('bad_request', 'suggest_next 需要 run_id')
  const run = store.getRun(runId)
  if (!run) throw storeError('not_found', `run 不存在：${runId}`)
  if (!['succeeded', 'partial'].includes(run.status)) {
    return { ok: false, action: 'suggest_next', run_id: runId, status: run.status, directions: [], summary: `run 状态 ${run.status}：先修好再谈下一步` }
  }
  const runDir = store.runDir(runId)
  const manifest = readJsonIfExists(path.join(runDir, 'manifest.json')) || {}
  const zero = Boolean(manifest.zero_significant)
  const index = readJsonIfExists(path.join(runDir, 'results', 'tables.index.json')) || {}
  const tables = Array.isArray(index.tables) ? index.tables : []
  const measured = tables.find((table) => table.evidence_kind === 'measured')
  let topFeatures = []
  if (measured && measured.file) {
    try {
      const parsed = parseDelimited(fs.readFileSync(path.join(runDir, measured.file), 'utf8'))
      const featureKey = parsed.header.find((key) => /gene|feature|symbol|metabolite|id/i.test(key)) || parsed.header[0]
      const effectKey = parsed.header.find((key) => /^log2?fc$|^logfc$|effect|estimate|coef/i.test(key))
      const rows = parsed.objects.slice()
      if (effectKey) rows.sort((left, right) => Math.abs(Number(right[effectKey]) || 0) - Math.abs(Number(left[effectKey]) || 0))
      topFeatures = rows.slice(0, 8).map((row) => String(row[featureKey] || '')).filter(Boolean)
    } catch { topFeatures = [] }
  }
  const directions = []
  if (zero) {
    directions.push(
      { id: 'qc-batch', label: '检查样本 QC 与批次分布', need: `对 run ${runId} 的样本做 QC 与批次诊断，看看是否批次/离群样本压掉了信号` },
      { id: 'trend', label: '看按效应量排序的 Top 趋势基因（探索性）', need: `列出 run ${runId} 按效应量排序的 Top 基因，标为探索性趋势、不称为显著` },
      { id: 'bigger', label: '换更大样本量的公共队列验证', need: '找同疾病、更大样本量、含相同分组的公共队列做验证（先给候选）' },
    )
  } else {
    if (topFeatures.length) directions.push({ id: 'top-genes', label: `拿 Top ${Math.min(8, topFeatures.length)} 个基因做通路富集/互作`, need: `用 run ${runId} 的 Top 基因（${topFeatures.slice(0, 5).join('、')}）做通路富集或互作分析，复用这次结果` })
    directions.push({ id: 'validate', label: '拿这批结果去独立队列验证', need: `把 run ${runId} 的差异结果拿到独立公共队列验证，先给候选数据集` })
    directions.push({ id: 'tcga', label: '看这些基因在 TCGA 的生存关联', need: `把 run ${runId} 的关键基因放到 TCGA 带随访队列里做生存关联（需临床终点）` })
    directions.push({ id: 'scrna', label: '在单细胞里看这些基因的表达', need: `把这些关键基因放到单细胞数据里看细胞类型与表达，先给候选单细胞队列` })
  }
  return {
    ok: true, action: 'suggest_next', run_id: runId, status: run.status, zero_significant: zero,
    summary: zero
      ? '分析已完成：当前阈值下 0 项显著；完整结果仍可导出。可以从 QC/批次、趋势基因、更大样本量队列继续。'
      : `已得到候选结果（${topFeatures.length ? 'Top 基因如 ' + topFeatures.slice(0, 3).join('、') : '结果表已就绪'}），可以接着做验证或锚定到单细胞/TCGA。`,
    directions,
    top_features: topFeatures,
  }
}

async function opHarmonize(runtime, store, args) {
  const datasetIds = Array.isArray(args.dataset_ids) ? args.dataset_ids : args.datasets || []
  if (!Array.isArray(datasetIds) || datasetIds.length < 2) {
    throw storeError('bad_request', 'harmonize 需要至少 2 个数据集：dataset_ids=[ds1, ds2]')
  }
  const method = String(args.method || '').toLowerCase()
  if (!H.HARMONIZE_METHODS.includes(method)) {
    throw storeError('bad_request', `批次校正方法必须显式选择：${H.HARMONIZE_METHODS.join(' / ')}（未校正也要写 method=none）`)
  }
  const datasets = datasetIds.map((id) => {
    const dataset = store.getDataset(id)
    if (!dataset) throw storeError('not_found', `数据集不存在：${id}`)
    return dataset
  })
  // 合并前设计检查：若每个队列都只有一组、且不同队列分属不同组，则分组与队列完全混杂
  const groupProfile = datasets.map((dataset) => {
    const samples = (dataset.design && Array.isArray(dataset.design.samples)) ? dataset.design.samples : []
    const groups = [...new Set(samples.map((sample) => String(sample.group || '').trim()).filter(Boolean))]
    return { dataset_id: dataset.dataset_id, groups, n_samples: samples.length }
  })
  const distinctGroups = [...new Set(groupProfile.flatMap((item) => item.groups))]
  const cohortConfounded = groupProfile.length >= 2
    && groupProfile.every((item) => item.groups.length <= 1)
    && distinctGroups.length >= 2
  if (cohortConfounded) {
    return {
      ok: false, action: 'harmonize', status: 'blocked',
      blocking: [{
        id: 'dataset_confounded',
        message_zh: '这些队列各自只含一个分组：合并后分不出疾病差异还是队列/批次差异，不能用来做跨队列比较。',
        fixes: ['改成在同一队列内比较', '换一个同时包含这两组的队列', '只做描述性联合出图（joint mode=plot）'],
        profile: groupProfile,
      }],
      summary: `拦截合并：${groupProfile.map((item) => `${item.dataset_id}=${item.groups.join('/') || '无分组'}`).join('；')}，分组与队列完全混杂`,
      next: '改用同一队列内比较，或换含双组的队列；不要用方法名把 cross_dataset_inference_allowed 强行置真',
    }
  }
  const prepared = datasets.map((dataset, index) => {
    const primary = P.selectPrimaryFile(dataset)
    return {
      dataset_id: dataset.dataset_id,
      name: dataset.name,
      path: primary ? primary.path : null,
      scale: dataset.scale ? dataset.scale.type : 'unknown',
      // dataset.transpose=true 表示「文件是 特征×样本」（各插件按此转置）；
      // harmonize 内部原生就是 特征×样本，所以这里要用**相反**的布尔值。
      transpose: !dataset.transpose,
      probe_map: args.probe_map_file || null,
      species: dataset.species,
      assay: dataset.assay,
    }
  })
  const planCore = {
    schema_version: 1,
    template: 'harmonize',
    template_version: 1,
    dataset_id: datasetIds.join('+'),
    dataset_revision: sha256(datasetIds.map((id) => store.getDataset(id).dataset_id).join('|')),
    seed: 0,
    contrast: null,
    design: null,
    params: { method, batch_corrected: method !== 'none', target_scale: args.target_scale || 'none', aggregate: args.aggregate || 'mean', dataset_ids: datasetIds, probe_map_file: args.probe_map_file || null },
    steps: [{
      step_id: 'harmonize',
      plugin: 'bioflow',
      action: 'harmonize',
      params: { datasets: prepared, method, target_scale: args.target_scale || 'none', aggregate: args.aggregate || 'mean', probe_map_file: args.probe_map_file || null },
      deliver: { kind: 'harmonize' },
      evidence_kind: 'descriptive',
      label: '多数据集归一化与批次评估',
    }],
    deliverables: TABLES,
  }
  const planId = sha256(JSON.stringify(planCore))
  const plan = { ...planCore, plan_id: planId, status: 'ready', gates: [{ id: 'harmonize_inputs', status: 'pass', blocking: false, detail: `${datasets.length} 个数据集；method=${method}` }], blocking: [], created_at: nowIso() }
  store.putPlan(plan)
  const execution = await createInternalRun(runtime, store, { plan, dataset: null, label: 'harmonize' })
  const finalRun = execution.run
  const tableRows = []
  try {
    const index = readJsonIfExists(path.join(store.runDir(finalRun.run_id), 'results', 'tables.index.json'))
    for (const table of (index && index.tables) || []) tableRows.push({ table_id: table.table_id, rows: table.rows, evidence_kind: table.evidence_kind })
  } catch { /* ignore */ }
  let merged = null
  if (finalRun.status === 'succeeded' && args.register_dataset !== false) {
    try { merged = await registerMergedDataset(store, finalRun.run_id, datasets, { method, targetScale: args.target_scale || 'none' }) }
    catch (error) { merged = { error: String(error && error.message ? error.message : error) } }
  }
  return {
    ok: finalRun.status === 'succeeded',
    action: 'harmonize',
    run_id: finalRun.run_id,
    status: finalRun.status,
    method,
    batch_corrected: method !== 'none',
    cross_dataset_inference_allowed: method !== 'none',
    plan_id: planId,
    reused: execution.reused,
    tables: tableRows,
    warnings: finalRun.warnings || [],
    merged_dataset_id: merged && merged.dataset ? merged.dataset.dataset_id : null,
    merged_dataset: merged && merged.dataset ? { dataset_id: merged.dataset.dataset_id, name: merged.dataset.name, n_samples: (merged.dataset.design.samples || []).length, groups: [...new Set((merged.dataset.design.samples || []).map((sample) => sample.group).filter(Boolean))] } : null,
    merged_error: merged && merged.error ? merged.error : null,
    summary: `harmonize（method=${method}）→ ${finalRun.status}；run_id=${finalRun.run_id}` + (merged && merged.dataset ? `；已登记合并数据集 ${merged.dataset.dataset_id}` : ''),
    next: merged && merged.dataset
      ? `用 action=plan dataset=${merged.dataset.dataset_id} template=bulk-two-group 继续跑（或 action=joint mode=meta/plot）`
      : (method === 'none' ? '未校正：跨数据集合并推断被禁止，只能描述性联合出图（action=joint mode=plot）' : '可继续 action=joint mode=meta / plot'),
    run: finalRun,
  }
}

function buildJointPlan({ mode, params }) {
  const planCore = {
    schema_version: 1,
    template: `joint-${mode}`,
    template_version: 1,
    dataset_id: null,
    dataset_revision: null,
    seed: 0,
    contrast: null,
    design: null,
    params,
    steps: [],
    deliverables: TABLES,
  }
  let steps = []
  if (mode === 'meta') {
    steps = [{
      step_id: 'meta_analysis', plugin: 'bioflow', action: 'meta_analysis',
      params: { cohorts: params.cohorts, alpha: params.alpha || 0.05, min_cohorts: params.min_cohorts || 2 },
      deliver: { kind: 'meta' }, evidence_kind: 'measured', label: '多队列 meta 分析',
    }]
  } else if (mode === 'plot') {
    steps = [
      {
        step_id: 'joint_prepare', plugin: 'bioflow', action: 'joint_prepare',
        params: { runs: params.runs, value_column: params.value_column || null, feature_limit: params.feature_limit || 2000 },
        deliver: { kind: 'plot_data' }, evidence_kind: 'descriptive', label: '准备联合出图数据',
      },
      {
        step_id: 'plot_open', plugin: 'plotlab', action: 'open',
        params: { path: '$RUN_DIR/results/joint_plot_data.tsv', kind: 'tidy', name: 'joint_plot' },
        requires: ['joint_prepare'], deliver: { kind: 'dataset' },
      },
      {
        step_id: 'plot', plugin: 'plotlab', action: 'plot',
        params: {
          chart: params.chart || 'box',
          roles: { x: 'cohort', y: 'value', group: 'cohort' },
          params: { add_points: true },
          style: { palette: 'okabe_ito', dpi: 300, title_size: 14, label_size: 12, tick_size: 10, fig_width: 7.2, fig_height: 4.6, stat_annot: true, p_adjust: 'bh' },
        },
        requires: ['plot_open'], deliver: { kind: 'figure' }, evidence_kind: 'descriptive', timeout_ms: 20 * 60 * 1000,
        label: '联合出图（plotlab）',
      },
    ]
  } else if (mode === 'signature') {
    const bulkDataset = params.bulkDataset
    const built = J.buildSignatureSteps({
      bulkDataset,
      scRefPath: params.sc_ref_path || null,
      scDatasetId: params.sc_dataset_id || null,
      genes: params.genes || [],
      params: params.scmap_params || {},
    })
    steps = built.steps
    planCore.params = { ...params, signature_warnings: built.warnings }
  } else {
    throw storeError('bad_request', `joint mode 只支持 ${J.JOINT_MODES.join(' / ')}`)
  }
  planCore.steps = steps
  const planId = sha256(JSON.stringify(planCore))
  return { ...planCore, plan_id: planId, status: 'ready', gates: [{ id: 'joint_inputs', status: 'pass', blocking: false, detail: `${mode} 输入检查通过` }], blocking: [], created_at: nowIso() }
}

async function opJoint(runtime, store, args) {
  const mode = String(args.mode || '').toLowerCase()
  if (!J.JOINT_MODES.includes(mode)) throw storeError('bad_request', `joint 需要 mode：${J.JOINT_MODES.join(' / ')}`)
  if (mode === 'meta') {
    const cohorts = Array.isArray(args.cohorts) ? args.cohorts : []
    if (cohorts.length < 2) throw storeError('bad_request', 'meta 需要至少 2 个 cohorts：[{run_id, table_id?}]')
    for (const cohort of cohorts) {
      const run = store.getRun(cohort.run_id)
      if (!run) throw storeError('not_found', `cohort run 不存在：${cohort.run_id}`)
      if (!['succeeded', 'partial'].includes(run.status)) throw storeError('prerequisite', `cohort run ${cohort.run_id} 状态 ${run.status}，不能用`)
      if (run.template === 'harmonize') {
        const batchCorrected = run.params && run.params.batch_corrected
        if (!batchCorrected && run.params && run.params.method === 'none') {
          throw storeError('prerequisite', `cohort run ${cohort.run_id} 是未校正的 harmonize；跨数据集合并推断被禁止`)
        }
      }
    }
    const plan = buildJointPlan({ mode, params: { cohorts, alpha: Number(args.alpha) || 0.05, min_cohorts: Number(args.min_cohorts) || 2 } })
    store.putPlan(plan)
    const execution = await createInternalRun(runtime, store, { plan, dataset: null, label: 'meta' })
    const finalRun = execution.run
    const index = readJsonIfExists(path.join(store.runDir(finalRun.run_id), 'results', 'tables.index.json')) || {}
    return {
      ok: finalRun.status === 'succeeded', action: 'joint', mode,
      run_id: finalRun.run_id, status: finalRun.status, plan_id: plan.plan_id,
      tables: (index.tables || []).map((table) => ({ table_id: table.table_id, rows: table.rows, evidence_kind: table.evidence_kind })),
      summary: `meta 分析（${cohorts.length} 队列）→ ${finalRun.status}；run_id=${finalRun.run_id}`,
      run: finalRun,
    }
  }
  if (mode === 'plot') {
    const runs = Array.isArray(args.runs) ? args.runs : []
    if (!runs.length) throw storeError('bad_request', 'plot 需要 runs：[{run_id, table_id?}]')
    for (const spec of runs) {
      const run = store.getRun(spec.run_id)
      if (!run) throw storeError('not_found', `run 不存在：${spec.run_id}`)
      if (!['succeeded', 'partial'].includes(run.status)) throw storeError('prerequisite', `run ${spec.run_id} 状态 ${run.status}，不能出图`)
    }
    const plan = buildJointPlan({
      mode,
      params: { runs, chart: args.chart || 'box', value_column: args.value_column || null, feature_limit: Number(args.feature_limit) || 2000 },
    })
    store.putPlan(plan)
    const execution = await createInternalRun(runtime, store, { plan, dataset: null, label: 'joint-plot' })
    const finalRun = execution.run
    const index = readJsonIfExists(path.join(store.runDir(finalRun.run_id), 'results', 'tables.index.json')) || {}
    return {
      ok: finalRun.status === 'succeeded', action: 'joint', mode,
      run_id: finalRun.run_id, status: finalRun.status, plan_id: plan.plan_id,
      figures: (index.figures || []).map((figure) => ({ figure_id: figure.figure_id, file: path.join(store.runDir(finalRun.run_id), figure.file), title: figure.title })),
      tables: (index.tables || []).map((table) => ({ table_id: table.table_id, rows: table.rows })),
      summary: `联合出图（${runs.length} 个 run）→ ${finalRun.status}；run_id=${finalRun.run_id}`,
      run: finalRun,
    }
  }
  // signature
  const bulkDataset = args.dataset ? store.getDataset(args.dataset) : (Array.isArray(args.dataset_ids) && args.dataset_ids[0] ? store.getDataset(args.dataset_ids[0]) : null)
  if (!bulkDataset) throw storeError('bad_request', 'signature 需要 dataset（bulk 数据）')
  if (!args.sc_ref_path && !args.sc_dataset_id) {
    return {
      ok: false, action: 'joint', mode, status: 'blocked',
      blocking: [{ id: 'sc_reference', detail: '跨模态签名映射需要单细胞参考：sc_ref_path（h5ad 绝对路径）或 sc_dataset_id（singlecell 工作台数据集）' }],
      summary: '签名映射被前置条件拦下：缺单细胞参考',
    }
  }
  const plan = buildJointPlan({
    mode,
    params: {
      bulkDataset,
      sc_ref_path: args.sc_ref_path || null,
      sc_dataset_id: args.sc_dataset_id || null,
      genes: Array.isArray(args.genes) ? args.genes : [],
      scmap_params: args.scmap_params || {},
    },
  })
  store.putPlan(plan)
  const execution = await createInternalRun(runtime, store, { plan, dataset: bulkDataset, label: 'signature' })
  const finalRun = execution.run
  return {
    ok: finalRun.status === 'succeeded', action: 'joint', mode,
    run_id: finalRun.run_id, status: finalRun.status, plan_id: plan.plan_id,
    evidence_kind: 'model_prediction',
    warning: '签名映射是模型预测（model_prediction），不是实验结论；稿件不得直接引用为实测证据',
    summary: `跨模态签名映射 → ${finalRun.status}；run_id=${finalRun.run_id}`,
    run: finalRun,
  }
}

// ---------------------------------------------------------------------------
// search / source detail / health / download
// ---------------------------------------------------------------------------

async function opSearch(runtime, store, args) {
  const sources = parseSources(args.sources, { defaultSources: DEFAULT_SEARCH_SOURCES })
  const sourcesClient = getSourcesClient(runtime, store)
  if (args.detail || (args.id && args.source)) {
    const detail = await sourcesClient.detail({
      source: String(args.source || args.detail.source).toLowerCase(),
      id: args.id || args.detail.id,
      includeClinical: args.include_clinical !== false,
    })
    return { ok: true, action: 'search', detail: true, ...detail, summary: `详情：${args.source}/${args.id} 返回 ${detail.items.length} 条` }
  }
  const term = args.term || args.query || args.q
  if (!term) throw storeError('bad_request', 'search 需要 term（关键词 / GSE / TCGA 项目号 / MTBLS）')
  const result = await S.performSearch({
    store,
    sourcesClient,
    pubmedClient: getPubMedClient(runtime, store),
    term,
    sources,
    limit: Number(args.limit) || 20,
    page: Number(args.page) || 0,
    species: args.species || 'all',
    includeAbstracts: Boolean(args.include_abstracts),
    hasClinical: Boolean(args.has_clinical),
    europepmc: Boolean(args.europepmc),
  })
  const itemsBySource = {}
  for (const [source, sourceResult] of Object.entries(result.results || {})) itemsBySource[source] = sourceResult.items || []
  return {
    ok: true,
    action: 'search',
    search_id: result.search_id,
    query: result.query,
    sources: result.sources,
    sources_ok: result.sources_ok,
    sources_failed: result.sources_failed,
    by_source: result.by_source,
    items: itemsBySource,
    provenance: result.provenance,
    warnings: result.warnings,
    summary: `检索「${term}」：${result.sources_ok.map((source) => `${source}=${(result.by_source[source] || {}).total ?? 0}`).join('、')}` +
      (result.sources_failed.length ? `；失败：${result.sources_failed.map((item) => `${item.source}(${item.reason || item.code})`).join('、')}` : ''),
    next: 'download 下载选中的记录 → register 登记 → ask/plan → submit',
  }
}

// ---------------------------------------------------------------------------
// 中文摘要（数据集/文献）——给"弹窗里看得懂"的候选信息
// ---------------------------------------------------------------------------
var SPECIES_ZH = { human: '人', 'homo sapiens': '人', mouse: '小鼠', 'mus musculus': '小鼠', rat: '大鼠' }
var SOURCE_ZH = { geo: 'GEO', gdc: 'TCGA/GDC', metabolights: 'MetaboLights', cellxgene: 'CELLxGENE', registered: '已登记' }
var KIND_ZH = { bulk: 'bulk 转录组', scrna: '单细胞 RNA', spatial: '空间转录组', metabolomics: '代谢组', matrix: '矩阵' }

function zhSpecies(value) {
  const key = String(value || '').toLowerCase()
  return SPECIES_ZH[key] || (value ? String(value) : '未知物种')
}

function summarizeDatasetZh(item, kind) {
  const source = String(item.source || 'registered')
  const sourceZh = SOURCE_ZH[source] || source
  const id = String(item.dataset_id || item.id || '')
  const species = zhSpecies(item.species)
  const n = Number(item.n_samples) || 0
  const scale = item.scale && item.scale.type ? item.scale.type : (typeof item.scale === 'string' ? item.scale : '')
  const kindZh = KIND_ZH[kind || item.kind] || KIND_ZH[item.data_kind] || '未知模态'
  const groups = asArrayLite(item.groups)
  const hasMatrix = Number(item.attachments || 0) > 0 || Boolean(item.files && item.files.length)
  const hasClinical = Boolean(item.clinical)
  const suitable = []
  if (groups.length >= 2) suitable.push('做组间比较（已有分组）')
  else if (n >= 8) suitable.push('可先看样本能否按临床分组')
  if (kindZh.indexOf('bulk') >= 0) suitable.push('差异表达 + 通路富集')
  if (kindZh.indexOf('单细胞') >= 0) suitable.push('细胞组成比较 + pseudobulk')
  if (hasClinical) suitable.push('生存/临床关联分析')
  if (n < 10) suitable.push('小队列，适合作为补充队列或合并分析')
  const risks = []
  if (n && n < 6) risks.push(`样本量仅 ${n}，两组比较很可能重复不足`)
  if (!hasMatrix) risks.push('没有看到可直接下载的矩阵/附件')
  if (!scale) risks.push('尺度未知，推断前需要确认 counts/log')
  if (!groups.length) risks.push('分组信息未知，登记时要给样本表')
  return {
    source: sourceZh,
    id,
    headline: `${sourceZh} ${id}｜${species}｜${n ? n + ' 样本' : '样本量未知'}｜${kindZh}`,
    text: [
      `${sourceZh} 的数据集 ${id}，物种 ${species}${n ? `，共 ${n} 个样本` : ''}，类型判断为${kindZh}${scale ? `，数据尺度 ${scale}` : ''}。`,
      groups.length ? `已识别分组：${groups.join('、')}。` : '尚未识别分组。',
      hasMatrix ? '有可下载/已登记的表达矩阵。' : '未看到矩阵附件。',
      hasClinical ? '带临床或随访信息，可用于生存/辅助分析。' : '未见临床/随访字段。',
      suitable.length ? `适合：${suitable.join('；')}。` : '',
      risks.length ? `注意：${risks.join('；')}。` : '',
    ].filter(Boolean).join(''),
    suitable,
    risks,
  }
}

/** 疾病 → 候选临床现象（模板）+ 近两年文献热点。 */
async function opTopics(runtime, store, args) {
  const disease = String(args.need || args.disease || args.query || '').trim()
  if (!disease) throw storeError('bad_request', 'topics 需要 disease/need（如 胃癌肝转移）')
  const templates = [
    { id: 'metastasis-immune', text: `${disease} 的转移灶与原发灶在免疫细胞组成上是否不同？` },
    { id: 'response', text: `${disease} 对一线治疗有响应和无响应的人，肿瘤微环境是否有差异？` },
    { id: 'prognosis', text: `${disease} 中某类免疫细胞比例下降是否与更差的预后相关？` },
    { id: 'resistance', text: `${disease} 复发/耐药人群是否存在可复现的表达或通路特征？` },
    { id: 'subtype', text: `${disease} 是否存在与治疗靶点相关的分子亚型？` },
    { id: 'biomarker', text: `${disease} 中某个基因/通路的表达能否作为疗效预测标志物？` },
  ]
  // 中文疾病名 → 英文检索词（PubMed 对中文支持差）；未知时保留原词并去掉标点
  const DISEASE_EN = [
    ['胃癌肝转移', 'gastric cancer liver metastasis'], ['胃癌', 'gastric cancer'], ['肝转移', 'liver metastasis'],
    ['结直肠癌', 'colorectal cancer'], ['肺腺癌', 'lung adenocarcinoma'], ['肺癌', 'lung cancer'],
    ['肝细胞癌', 'hepatocellular carcinoma'], ['胰腺癌', 'pancreatic cancer'], ['乳腺癌', 'breast cancer'],
    ['食管鳞癌', 'esophageal squamous cell carcinoma'], ['单细胞', 'single-cell'], ['免疫', 'immune'],
    ['耐药', 'drug resistance'], ['预后', 'prognosis'], ['转移', 'metastasis'],
  ]
  let english = String(disease || '')
  for (const [zh, en] of DISEASE_EN) english = english.split(zh).join(' ' + en + ' ')
  english = english.replace(/[，。；、]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!english || english === disease) english = disease
  let hot = []
  try {
    const client = getPubMedClient(runtime, store)
    const queried = await client.search({ term: `${english} AND (review[pt] OR systematic review[pt])`, limit: Number(args.limit) || 8 })
    hot = asArrayLite(queried && queried.items).slice(0, 6).map((item) => ({
      pmid: item.id || item.pmid || null,
      title: item.title || null,
      journal: item.journal || null,
      year: item.year || null,
      abstract: item.abstract ? String(item.abstract).slice(0, 240) : null,
    }))
  } catch (error) {
    hot = []
  }
  const phenomena = templates.concat(hot.slice(0, 3).map((paper, index) => ({
    id: 'hot-' + index,
    text: `文献热点（PMID ${paper.pmid || '?'}）：${paper.title || ''} —— 这个结论在 ${disease} 队列里能否复现？`,
  })))
  return {
    ok: true,
    action: 'topics',
    disease,
    phenomena,
    hot_topics: hot,
    summary: hot.length
      ? `${disease}：${phenomena.length} 个候选临床问题（含 ${hot.length} 篇近两年综述/系统综述热点）`
      : `${disease}：${phenomena.length} 个候选临床问题（模板生成；文献检索未返回结果）`,
    next: '挑一个现象 → 查文献与队列核实 → 写入思路链或生成核实许愿',
  }
}

/** 把一句人话拆成检索词（规则式，不依赖外部模型）。 */
function keywordsOf(text) {
  const stop = /^(帮我|请|把|拿|用|按|检索|搜索|找|下载|数据|数据集|分析|出图|作图|画图|比较|对比|差异|看看|一下|的|和|与|跟|比|vs|the|a|an|of|and|for|with|data|dataset|analysis)$/i
  return [...new Set(String(text || '')
    .split(/[\s,，。；;、/]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stop.test(token)))]
}

/** 从标题/摘要里推测数据模态，给模板推荐用。 */
function guessKindOfItem(item) {
  const text = `${item.title || ''} ${item.abstract || ''}`.toLowerCase()
  if (/single.?cell|scrna|sc-rna|10x|cell atlas/.test(text)) return 'scrna'
  if (/spatial|visium|stereo.?seq|slide.?seq|merfish/.test(text)) return 'spatial'
  if (/metabolom|metabolite|lc-?ms|gc-?ms|nmr/.test(text)) return 'metabolomics'
  return 'bulk'
}

/**
 * action=advise：AI 挑数据 + 辅助分析。
 * 不调用外部大模型：用可复现的确定性打分（命中度/样本量/矩阵/临床/物种/模态），
 * 每条推荐都给出「为什么」和「风险」，并附「下一步怎么做」的具体动作。
 */
async function opAdvise(runtime, store, args) {
  const rawNeed = String(args.need || args.query || args.term || args.text || '').trim()
  if (!rawNeed) throw storeError('bad_request', 'advise 需要 need/term（一句话描述你要解决的问题）')
  const keywords = keywordsOf(rawNeed)
  const accession = (rawNeed.match(/\b(GSE\d{3,7}|TCGA-[A-Z0-9]{2,6}|MTBLS\d+)\b/i) || [])[0] || null
  const term = args.term || (accession || (keywords.length ? keywords.join(' ') : rawNeed))
  const sources = parseSources(args.sources, { defaultSources: ['geo', 'pubmed', 'gdc', 'metabolights'] })
  const wantHuman = String(args.species || '').toLowerCase() === 'human'
  const result = await S.performSearch({
    store,
    sourcesClient: getSourcesClient(runtime, store),
    pubmedClient: getPubMedClient(runtime, store),
    term,
    sources,
    limit: Number(args.limit) || 12,
    page: 0,
    species: args.species || 'all',
    includeAbstracts: false,
    hasClinical: false,
    europepmc: false,
  })
  const itemsBySource = {}
  for (const [source, sourceResult] of Object.entries(result.results || {})) itemsBySource[source] = sourceResult.items || []
  const datasetItems = []
  for (const source of ['geo', 'gdc', 'metabolights', 'cellxgene']) {
    for (const item of asArrayLite(itemsBySource[source])) datasetItems.push(Object.assign({ source }, item))
  }
  const titleTokens = keywords.map((token) => token.toLowerCase())
  const recommendations = datasetItems.map((item) => {
    const reasons = []
    const risks = []
    let score = 0
    const nSamples = Number(item.n_samples) || 0
    const kind = guessKindOfItem(item)
    if (accession && String(item.id || '').toUpperCase() === accession.toUpperCase()) { score += 40; reasons.push('就是你点名的数据') }
    const title = String(item.title || '').toLowerCase()
    const hits = titleTokens.filter((token) => title.includes(token)).length
    if (hits) { score += Math.min(15, hits * 5); reasons.push(`标题命中 ${hits} 个关键词`) }
    if (wantHuman && /human|homo sapiens/i.test(String(item.species || ''))) { score += 10; reasons.push('人源') }
    else if (wantHuman && item.species && !/human|homo sapiens/i.test(String(item.species || ''))) risks.push(`物种是 ${item.species}，不是人`)
    if (nSamples >= 20) { score += 18; reasons.push(`样本量 ${nSamples}`) }
    else if (nSamples >= 8) { score += 10; reasons.push(`样本量 ${nSamples}`) }
    else if (nSamples > 0) { score -= 8; risks.push(`样本量仅 ${nSamples}，两组比较很可能重复不足（闸门会拦 n<2/组）`) }
    if (asArrayLite(item.attachments).length) { score += 6; reasons.push('有可下载矩阵/附件') } else risks.push('没看到可直接下载的矩阵')
    if (item.clinical || (item.metadata && item.metadata.clinical)) { score += 12; reasons.push('带临床信息（可做生存/辅助分析）') } else if (/survival|prognos|生存|预后/i.test(rawNeed)) risks.push('没看到临床/随访字段，生存分析可能缺终点')
    const scale = item.scale && item.scale.type ? String(item.scale.type) : ''
    if (scale) { score += 4; reasons.push(`尺度 ${scale}`) } else risks.push('尺度未知，推断前需要确认 counts/log')
    if (item.platform) { score += 2 }
    if (kind !== 'bulk') reasons.push(`模态像 ${kind}`)
    const summaryZh = summarizeDatasetZh({ dataset_id: item.id, source: item.source, species: item.species, n_samples: nSamples, scale: scale || (item.scale && item.scale.type) || null, attachments: asArrayLite(item.attachments).length, clinical: Boolean(item.clinical), groups: [] }, kind)
    return {
      dataset_id: item.id,
      source: item.source,
      summary_zh: summaryZh,
      title: item.title || null,
      species: item.species || null,
      n_samples: nSamples || null,
      platform: item.platform || null,
      scale: scale || null,
      kind,
      score: Math.max(0, Math.round(score)),
      reasons,
      risks,
      attachments: asArrayLite(item.attachments).length,
      clinical: Boolean(item.clinical),
    }
  }).sort((a, b) => b.score - a.score).slice(0, 8)

  const literature = asArrayLite(itemsBySource.pubmed).slice(0, 6).map((item) => ({
    pmid: item.id || item.pmid || null,
    title: item.title || null,
    journal: item.journal || null,
    year: item.year || null,
    authors: asArrayLite(item.authors).slice(0, 3),
  }))

  const top = recommendations[0] || null
  const templateByKind = { bulk: 'bulk-two-group', scrna: 'scrna-composition', spatial: 'spatial-domain', metabolomics: 'metabolomics-de' }
  const template = templateByKind[top ? top.kind : 'bulk'] || 'bulk-two-group'
  const smallCohorts = recommendations.filter((item) => item.n_samples && item.n_samples < 10).slice(0, 4)
  const planHint = {
    template,
    reason: top ? `首推 ${top.dataset_id}（${top.kind}，样本 ${top.n_samples || '?'}）→ 用 ${template}` : `没找到合适数据集，建议先换更通用的关键词`,
    contrast_suggestion: 'tumor vs normal（如果数据只有两组，ask 会自动判定方向）',
    gates_to_watch: smallCohorts.length ? ['replication：每组独立 n≥2', 'design_confounded：分组是否与批次共线', 'counts_verified：尺度'] : ['counts_verified', 'contrast'],
    multi_dataset: smallCohorts.length >= 2
      ? {
        suggestion: '这些队列单看样本量偏小，建议合并后再比较：先 harmonize 校正批次，再用登记出来的合并数据集继续跑',
        dataset_ids: smallCohorts.map((item) => item.dataset_id),
        action: `harmonize dataset_ids=[${smallCohorts.map((item) => `"${item.dataset_id}"`).join(', ')}] method=quantile → 得到 merged_dataset_id → plan dataset=<merged>`,
      }
      : null,
  }
  const nextSteps = []
  if (top) {
    nextSteps.push(`① 取数据：download source=${top.source} id=${top.dataset_id}（或用页面「下载并登记」一键）`)
    nextSteps.push(`② 登记：register artifact_ids=[下载产物] sample_sheet=<样本表>（能自动探测矩阵方向与尺度）`)
    nextSteps.push(`③ 出计划：plan dataset=<ds_xxx> template=${template} case=tumor control=normal（draft 只问缺的字段）`)
    if (planHint.multi_dataset) nextSteps.push(`④ 样本不够时走合并：${planHint.multi_dataset.action}`)
  } else {
    nextSteps.push('换更通用的关键词重试（疾病名 / 组织 / 技术），或放宽 sources 到 gdc/metabolights')
  }
  return {
    ok: true,
    action: 'advise',
    query: rawNeed,
    search_term: term,
    keywords,
    accession,
    recommendations,
    literature,
    plan_hint: planHint,
    next_steps: nextSteps,
    provenance: result.provenance,
    warnings: result.warnings,
    summary: top
      ? `推荐 ${top.dataset_id}（${top.kind}，样本 ${top.n_samples || '?'}，得分 ${top.score}）→ 模板 ${template}` + (planHint.multi_dataset ? '；另建议多队列合并' : '')
      : '没有找到匹配的数据集：建议换关键词或放宽数据源',
    next: nextSteps[0] || null,
  }
}

function asArrayLite(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  return [value]
}

function parseSources(value, { defaultSources }) {
  if (value === undefined || value === null || value === '') return [...defaultSources]
  const list = Array.isArray(value) ? value : String(value).split(/[,，\s]+/)
  return list.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
}

async function opSourceDetail(runtime, store, args) {
  const source = String(args.source || '').toLowerCase()
  const id = args.id || args.accession || args.project_id
  if (!source || !id) throw storeError('bad_request', 'source_detail 需要 source 与 id（如 {source:"gdc", id:"TCGA-LUAD"}）')
  const sourcesClient = getSourcesClient(runtime, store)
  const detail = await sourcesClient.detail({ source, id, includeClinical: args.include_clinical !== false })
  return { ok: true, action: 'source_detail', ...detail, summary: `${source}/${id}：${detail.items.length} 条详情` }
}

async function opHealth(runtime, store, args) {
  const sourcesClient = getSourcesClient(runtime, store)
  const requested = parseSources(args.sources, { defaultSources: SOURCE_IDS })
  const health = await sourcesClient.probeHealth({ sources: requested, force: Boolean(args.force) })
  const plugins = await A.probePlugins({ pluginPaths: runtime.config && runtime.config.pluginPaths })
  runtime.healthCache = { sources: health, plugins, checked_at: nowIso() }
  return {
    ok: true,
    action: 'health',
    sources: health,
    plugins: A.PLUGIN_IDS.map((plugin) => ({ plugin, available: Boolean(plugins[plugin] && plugins[plugin].available), error: plugins[plugin] && plugins[plugin].error || null })),
    summary: '健康灯：' + Object.values(health).map((item) => `${item.source}=${item.status}${item.latency_ms ? `(${item.latency_ms}ms)` : ''}`).join('、'),
  }
}

async function opDownload(runtime, store, args) {
  const source = String(args.source || '').toLowerCase()
  const id = args.id || args.gse || args.accession || args.project_id
  if (!source || !id) throw storeError('bad_request', 'download 需要 source 与 id（如 {source:"gdc", id:"TCGA-LUAD"} 或 {source:"geo", id:"GSE84433"}）')
  const destDir = path.resolve(args.dest_dir || args.destDir || path.join(store.dirs.root, 'downloads', `${source}-${id}`))
  ensureDir(destDir)
  const sourcesClient = getSourcesClient(runtime, store)
  const downloader = getDownloader(runtime, store)
  const pluginDownload = async (plugin, action, params, { signal } = {}) => {
    const adapter = await ephemeralAdapter(runtime, store, plugin)
    return adapter.invoke(action, params, { timeoutMs: 60 * 60 * 1000, signal })
  }
  let result
  try {
    result = await S.executeDownload({
      store, downloader, sourcesClient, source, id, destDir,
      files: args.files || null, pluginDownload, includeClinical: args.include_clinical !== false,
    })
  } catch (error) {
    if (error && error.code === 'source_unavailable') {
      return { ok: false, action: 'download', source, id, status: 'source_unavailable', error: error.details || { message: error.message }, summary: `下载不可用：${error.message}` }
    }
    throw error
  }
  return {
    ok: Boolean(result.ok), action: 'download', source, id,
    source_record: result, dest_dir: destDir,
    downloads: result.downloads || [], artifacts: result.artifacts || [],
    error: result.error || null,
    summary: result.ok
      ? `下载 ${source}/${id}：${(result.downloads || []).length} 个文件 → ${destDir}${result.reused ? '（同 hash 已复用）' : ''}`
      : `下载不可用：${(result.error && result.error.message) || '未知原因'}`,
    next: 'register 时用 artifact_ids / path 登记，再 plan',
  }
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

function parseSamplesInput(args, store) {
  let samples = args.samples
  if (typeof samples === 'string') {
    try { samples = JSON.parse(samples) } catch { samples = null }
  }
  const list = Array.isArray(samples) ? samples : []
  const out = []
  for (let index = 0; index < list.length; index += 1) {
    const sample = list[index]
    if (!sample || typeof sample !== 'object') continue
    const id = String(sample.sample_id || sample.id || sample.sample || sample.name || '').trim()
    if (!id) continue
    out.push({
      sample_id: id,
      display_name: sample.display_name || sample.name || id,
      group: sample.group !== undefined ? String(sample.group) : (sample.group_id !== undefined ? String(sample.group_id) : (sample.condition !== undefined ? String(sample.condition) : '')),
      donor_id: String(sample.donor_id || sample.donor || sample.patient || sample.subject || sample.participant || ''),
      batch: String(sample.batch || ''),
      pair_id: String(sample.pair_id || sample.pair || sample.paired_id || ''),
      material: String(sample.material || sample.tissue || ''),
    })
  }
  return out
}

/** 解析样本表（csv/tsv），列名别名映射。 */
function readSampleSheet(file) {
  if (!file) return null
  if (!fs.existsSync(file)) throw storeError('not_found', `样本表不存在：${file}`)
  const text = fs.readFileSync(file, 'utf8')
  return parseDelimited(text)
}

function normalizeDesignFromSheet(sheet, aliases = {}) {
  const header = sheet.header.map((key) => key.toLowerCase())
  const find = (names) => {
    for (const name of names) {
      const index = header.indexOf(name)
      if (index >= 0) return sheet.header[index]
    }
    return null
  }
  const sampleColumn = aliases.sample_column || find(['sample', 'sample_id', 'sampleid', 'gsm', 'barcode', 'id', 'sample_name', 'sample name'])
  const groupColumn = aliases.group_column || find(['group', 'condition', 'group_id', 'groupid', 'case_control', 'class', 'phenotype'])
  const donorColumn = aliases.donor_column || find(['donor', 'donor_id', 'donorid', 'patient', 'patient_id', 'participant', 'subject', 'subject_id', 'case_id', 'submitter_id'])
  const batchColumn = aliases.batch_column || find(['batch', 'batch_id', 'plate', 'library_batch', 'run'])
  const pairColumn = aliases.pair_column || find(['pair', 'pair_id', 'paired_id', 'patient_pair'])
  const materialColumn = aliases.material_column || find(['material', 'tissue', 'sample_type', 'source'])
  if (!sampleColumn) throw storeError('bad_request', `样本表缺少样本 ID 列（可用列：${sheet.header.slice(0, 12).join('、')}）`)
  const samples = sheet.objects.map((row, index) => {
    const sampleId = String(row[sampleColumn] || '').trim()
    if (!sampleId) return null
    return {
      sample_id: sampleId,
      display_name: String(row[aliases.display_column || sampleColumn] || sampleId),
      group: groupColumn ? String(row[groupColumn] || '').trim() : '',
      donor_id: donorColumn ? String(row[donorColumn] || '').trim() : '',
      batch: batchColumn ? String(row[batchColumn] || '').trim() : '',
      pair_id: pairColumn ? String(row[pairColumn] || '').trim() : '',
      material: materialColumn ? String(row[materialColumn] || '').trim() : '',
      row_index: index,
    }
  }).filter(Boolean)
  return {
    samples,
    columns: { sample: sampleColumn, group: groupColumn, donor: donorColumn, batch: batchColumn, pair: pairColumn, material: materialColumn },
  }
}

/**
 * 按已判定的矩阵方向取样本名：transpose=true（文件是 特征×样本）→ 表头列；
 * transpose=false（文件是 样本×特征）→ 首列值。身份核对必须与方向判定共用同一结果。
 */
function readMatrixSamplesByOrientation(file, transpose) {
  if (!file || !fs.existsSync(file)) return null
  if (!/\.(csv|tsv|txt)(\.gz)?$/i.test(file)) return null
  try {
    let text
    if (/\.gz$/i.test(file)) text = zlib.gunzipSync(fs.readFileSync(file)).slice(0, 400_000).toString('utf8')
    else text = fs.readFileSync(file, 'utf8').slice(0, 400_000)
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
    if (lines.length < 2) return null
    const delimiter = (lines[0].match(/\t/g) || []).length >= (lines[0].match(/,/g) || []).length ? '\t' : ','
    const header = lines[0].split(delimiter).map((value) => value.trim().replace(/^"|"$/g, ''))
    if (transpose) return header.slice(1).filter(Boolean)
    return lines.slice(1).map((line) => String(line.split(delimiter)[0] || '').trim().replace(/^"|"$/g, '')).filter(Boolean)
  } catch {
    return null
  }
}

function readMatrixHeaderSamples(file) {
  if (!file || !fs.existsSync(file)) return null
  if (!/\.(csv|tsv|txt)(\.gz)?$/i.test(file)) return null
  try {
    let text
    if (/\.gz$/i.test(file)) {
      text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').slice(0, 200_000)
    } else {
      text = fs.readFileSync(file, 'utf8').slice(0, 200_000)
    }
    const firstLine = text.split(/\r?\n/, 1)[0] || ''
    const delimiter = (firstLine.match(/\t/g) || []).length >= (firstLine.match(/,/g) || []).length ? '\t' : ','
    const columns = firstLine.split(delimiter).map((value) => value.trim().replace(/^"|"$/g, ''))
    return columns.slice(1)
  } catch {
    return null
  }
}

/**
 * 判断文本矩阵的方向（决定各插件 open 时的 transpose）。
 *
 * 六个插件的 open 同一语义：transpose=true 表示文件是「特征 × 样本」（需要转置）。
 * 判据按可靠性排序：
 *   1) 表头（除首列）与样本表 sample_id 大面积重合 → 列是样本 → transpose=true；
 *   2) 首列与 sample_id 重合 → 行是样本 → transpose=false；
 *   3) 没有样本表时看数值性 + 行列数：首列基本非数值、行数 ≥ 列数 → 更像「特征 × 样本」。
 * 显式传入的 transpose 永远优先。
 */
export function detectMatrixOrientation(file, sampleIds = []) {
  const unknown = { transpose: false, reason: 'not_text_matrix', n_rows: null, n_cols: null, header_matches_samples: null }
  if (!file || !fs.existsSync(file) || !/\.(csv|tsv|txt)(\.gz)?$/i.test(file)) return unknown
  let text
  try {
    if (/\.gz$/i.test(file)) text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').slice(0, 400_000)
    else text = fs.readFileSync(file, 'utf8').slice(0, 400_000)
  } catch { return { ...unknown, reason: 'unreadable' } }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length < 2) return { ...unknown, reason: 'too_short' }
  const delimiter = (lines[0].match(/\t/g) || []).length >= (lines[0].match(/,/g) || []).length ? '\t' : ','
  const header = lines[0].split(delimiter).map((value) => value.trim().replace(/^"|"$/g, ''))
  const probe = lines.slice(1, 200).map((line) => line.split(delimiter))
  const nCols = Math.max(...probe.map((cells) => cells.length))
  const nRows = lines.length - 1
  const wanted = new Set((sampleIds || []).map((id) => String(id).trim()).filter(Boolean))
  const headerCols = header.slice(1)
  const firstColumn = probe.map((cells) => String(cells[0] || '').trim())
  const headerHits = [...wanted].filter((id) => headerCols.includes(id)).length
  const rowHits = [...wanted].filter((id) => firstColumn.includes(id)).length
  const base = { n_rows: nRows, n_cols: nCols }
  const need = Math.max(2, Math.ceil(wanted.size * 0.5))
  if (wanted.size && headerHits >= need && headerHits > rowHits) {
    return { ...base, transpose: true, reason: `header_matches_sample_ids(${headerHits}/${wanted.size})`, header_matches_samples: true }
  }
  if (wanted.size && rowHits >= need && rowHits > headerHits) {
    return { ...base, transpose: false, reason: `first_column_matches_sample_ids(${rowHits}/${wanted.size})`, header_matches_samples: false }
  }
  const numericFirstColumn = firstColumn.filter((value) => value !== '' && Number.isFinite(Number(value))).length
  if (numericFirstColumn > firstColumn.length * 0.8) {
    return { ...base, transpose: false, reason: 'first_column_numeric', header_matches_samples: null }
  }
  return { ...base, transpose: nRows >= nCols, reason: `heuristic_rows_${nRows}_vs_cols_${nCols}`, header_matches_samples: null }
}

async function opRegister(runtime, store, args) {
  let targetPath = args.path || args.dir || null
  let source = null
  let clinicalData = null

  // 来源记录（GEO/GDC/MetaboLights）：允许通过 artifact_ids / source_item 链式登记
  const artifacts = Array.isArray(args.artifact_ids) ? args.artifact_ids : []
  if (!targetPath && artifacts.length) {
    const paths = []
    for (const artifactId of artifacts) {
      const artifact = store.getArtifact(artifactId)
      if (!artifact) throw storeError('not_found', `artifact 不存在：${artifactId}（先 action=download）`)
      paths.push(artifact.path)
    }
    targetPath = paths.length === 1 ? paths[0] : path.dirname(paths[0])
    source = { kind: 'artifact_chain', artifact_ids: artifacts }
  }
  if (!targetPath && args.source_item && typeof args.source_item === 'object') {
    // 直接消费 search/detail 返回的统一 item：从其 attachments 里取本地已下载文件
    const item = args.source_item
    if (item.attachments && item.attachments.length) {
      const local = item.attachments.map((file) => file.local_path).filter(Boolean)
      if (local.length) targetPath = local.length === 1 ? local[0] : path.dirname(local[0])
    }
    source = { kind: item.source || 'unknown', id: item.id, item }
    if (item.metadata && item.metadata.clinical) clinicalData = item.metadata.clinical
  }
  if (!targetPath && args.gse) throw storeError('bad_request', 'GEO 登记需要已下载文件：先 action=download source=geo id=GSEXXXXX，再用 artifact_ids 或 path 登记')
  if (!targetPath && args.accession) throw storeError('bad_request', 'MetaboLights 登记需要已下载文件：先 action=download source=metabolights id=MTBLS1，再用 artifact_ids 或 path 登记')
  if (!targetPath) throw storeError('bad_request', 'register 需要 path（文件/目录）或 artifact_ids（download 产出）')
  const abs = path.resolve(String(targetPath))
  if (!fs.existsSync(abs)) throw storeError('not_found', `路径不存在：${abs}`)
  const stat = fs.statSync(abs)
  const collected = []
  const addFile = async (file, role = 'data') => {
    const fileStat = fs.statSync(file)
    const sha = await sha256File(file)
    collected.push({
      path: file, name: path.basename(file), bytes: fileStat.size, sha256: sha,
      artifact_id: sha, role: roleForFile(file, role),
    })
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) {
      const file = path.join(abs, name)
      if (fs.statSync(file).isFile()) await addFile(file, 'data')
    }
  } else {
    await addFile(abs, 'data')
  }
  if (!collected.length) throw storeError('bad_request', `目录里没有可用文件：${abs}`)

  // 样本表 / 设计
  const sampleSheetPath = args.sample_sheet ? path.resolve(String(args.sample_sheet)) : null
  let design = {
    group_column: args.group_column || null,
    donor_column: args.donor_column || null,
    batch_column: args.batch_column || null,
    pair_column: args.pair_column || null,
    paired: Boolean(args.paired),
    formula: args.formula || null,
    samples: [],
    columns: {},
    unresolved: [],
  }
  const inlineSamples = parseSamplesInput(args, store)
  if (sampleSheetPath) {
    const sheet = readSampleSheet(sampleSheetPath)
    const normalized = normalizeDesignFromSheet(sheet, {
      sample_column: args.sample_column || null,
      group_column: args.group_column || null,
      donor_column: args.donor_column || null,
      batch_column: args.batch_column || null,
      pair_column: args.pair_column || null,
    })
    design.samples = normalized.samples
    design.columns = normalized.columns
    design.group_column = design.group_column || normalized.columns.group
    design.donor_column = design.donor_column || normalized.columns.donor
    design.batch_column = design.batch_column || normalized.columns.batch
    design.pair_column = design.pair_column || normalized.columns.pair
  } else if (inlineSamples.length) {
    design.samples = inlineSamples
  } else if (source && source.item && Array.isArray(source.item.metadata && source.item.metadata.sample_rows)) {
    design.samples = source.item.metadata.sample_rows
  }

  // GEO 元数据来源：sample sheet 可能不在本地 → 只记录来源信息，闸门会拦
  if (!design.samples.length && (args.gse || (source && source.kind === 'geo'))) {
    // 允许从参数 samples 之外的 GEO 元数据里推断；没有就留空，plan 闸门 sample_table 会拦
  }

  // 重复 / 对不上矩阵列
  const conflicts = []
  const seen = new Set()
  for (const sample of design.samples) {
    if (seen.has(sample.sample_id)) conflicts.push({ type: 'duplicate_sample_id', sample_id: sample.sample_id })
    seen.add(sample.sample_id)
  }
  const matrixFile = (collected.find((file) => /matrix|expr|counts|\.csv|\.tsv|\.txt|\.gz/i.test(file.name)) || collected[0]).path
  // 方向判定必须在身份核对之前（否则样本×特征矩阵会拿基因列去对样本表）
  const orientation = detectMatrixOrientation(matrixFile, design.samples.map((sample) => sample.sample_id))
  const transpose = args.transpose !== undefined && args.transpose !== null ? Boolean(args.transpose) : orientation.transpose
  const matrixSamples = readMatrixSamplesByOrientation(matrixFile, transpose)
  const _tidyDeclared = String(args.data_kind || args.kind || '').toLowerCase() === 'tidy'
  if (!_tidyDeclared && matrixSamples && matrixSamples.length) {
    const sampleIds = new Set(design.samples.map((sample) => sample.sample_id))
    if (sampleIds.size) {
      const unresolved = matrixSamples.filter((name) => !sampleIds.has(name))
      const missingInMatrix = [...sampleIds].filter((id) => !matrixSamples.includes(id))
      if (unresolved.length) design.unresolved = unresolved.slice(0, 50)
      if (missingInMatrix.length) design.unresolved = [...(design.unresolved || []), ...missingInMatrix.slice(0, 50)]
    }
    design.matrix_samples = matrixSamples
  }
  if (conflicts.length) {
    return {
      ok: false, action: 'register', status: 'design_conflict',
      conflicts, summary: `样本映射冲突：${conflicts.length} 个重复 sample_id（例如 ${conflicts.slice(0, 5).map((item) => item.sample_id).join('、')}）`,
      next: '修正样本表后重试；register 不会静默丢弃冲突样本',
    }
  }

  /** 从矩阵数值形态自动判断尺度（counts / log_expression / normalized_expression）。 */
  function inferScaleFromMatrix(file) {
    try {
      if (!file || !fs.existsSync(file)) return null
      let text
      if (/\.gz$/i.test(file)) text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').slice(0, 400_000)
      else text = fs.readFileSync(file, 'utf8').slice(0, 400_000)
      const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, 30)
      if (lines.length < 2) return null
      const delimiter = (lines[0].match(/\t/g) || []).length >= (lines[0].match(/,/g) || []).length ? '\t' : ','
      const values = []
      for (const line of lines.slice(1)) {
        const cells = line.split(delimiter).slice(1, 40)
        for (const cell of cells) {
          const value = Number(String(cell).trim().replace(/^"|"$/g, ''))
          if (Number.isFinite(value)) values.push(value)
        }
      }
      if (!values.length) return null
      const integers = values.filter((value) => Number.isInteger(value)).length
      const max = Math.max(...values)
      const min = Math.min(...values)
      // 只有「非负整数」才可能是原始 counts；负整数/小数一律只写「疑似」，verified=false 等用户确认
      if (min >= 0 && integers / values.length > 0.98) {
        return { type: 'counts', verified: true, evidence: '自动探测：非负整数（疑似 counts，可直接用于计数模型）' }
      }
      if (min < 0 || max <= 40) {
        return { type: 'log_expression', verified: false, evidence: '自动探测：存在负值或量级偏小，疑似已 log/标准化；**需要你确认尺度**后再做推断' }
      }
      return { type: 'normalized_expression', verified: false, evidence: '自动探测：非整数强度（疑似归一化表达）；需要确认尺度' }
    } catch { return null }
  }

  // 尺度声明：显式要求 verified 才能用于推断
  let scaleDeclaration
  if (args.scale && typeof args.scale === 'object') {
    scaleDeclaration = {
      type: String(args.scale.type || 'unknown').toLowerCase(),
      verified: args.scale.verified === true,
      evidence: args.scale.evidence || '用户声明',
      note: args.scale.note || null,
    }
  } else {
    const declared = String(args.scale || '').toLowerCase()
    const matrixForScale = (collected.find((file) => /matrix|expr|counts|expression|\.csv|\.tsv|\.txt/i.test(file.name)) || collected[0]).path
    const inferred = !declared ? inferScaleFromMatrix(matrixForScale) : null
    scaleDeclaration = {
      type: declared || (inferred ? inferred.type : 'unknown'),
      // 自动探测出的尺度可以参与推断（register 时显式给了 unknown 则不自动覆盖）
      verified: args.verified === true || args.scale_verified === true || Boolean(inferred && inferred.verified === true),
      evidence: args.scale_evidence || (args.verified === true ? '用户显式声明 verified=true' : (inferred ? inferred.evidence : null)),
      note: inferred && declared === 'unknown' ? '显式写了 unknown，未采用自动探测' : null,
    }
  }
  if (!['counts', 'tpm', 'log_expression', 'microarray', 'unknown', 'metabolomics_profile', 'normalized_expression', 'star_counts', 'intensity', 'peak_area', 'log2_intensity', 'abundance', 'none'].includes(scaleDeclaration.type)) {
    throw storeError('bad_request', `未知 scale=${scaleDeclaration.type}（counts/tpm/log_expression/microarray/unknown/metabolomics_profile/normalized_expression/star_counts/intensity/peak_area/log2_intensity/abundance/none）`)
  }

  const assay = args.assay || inferAssay(collected, args)
  const dataKind = args.data_kind || inferDataKind(assay, args)
  const filesFingerprint = collected.map((file) => `${file.name}:${file.sha256}`).sort().join('|')
  const designFingerprint = JSON.stringify({
    samples: design.samples.map((sample) => [sample.sample_id, sample.group, sample.donor_id, sample.batch, sample.pair_id]).sort(),
    columns: design.columns,
  })
  const datasetId = `ds_${sha256(JSON.stringify({
    files: filesFingerprint, design: designFingerprint, assay, scale: scaleDeclaration,
    data_kind: dataKind || args.data_kind || null,
    sample_sheet: sampleSheetPath ? await sha256File(sampleSheetPath) : null,
    platform: args.platform || null, reference: args.reference || null, transpose,
  })).slice(0, 16)}`
  const existing = store.getDataset(datasetId)
  if (existing) {
    return {
      ok: true, action: 'register', dataset: existing, reused: true,
      summary: `数据集已存在（同文件字节 + 同样本设计）：${datasetId}`,
      gates_preview: previewGates(existing, args),
    }
  }
  const dataset = {
    schema_version: 1,
    dataset_id: datasetId,
    name: args.name || (source && source.id) || path.basename(abs),
    created_at: nowIso(),
    source: source || { kind: args.source || 'local' },
    gse: args.gse || (source && source.id) || null,
    assay,
    data_kind: dataKind,
    species: args.species || null,
    platform: args.platform || (source && source.item && source.item.platform) || null,
    reference: args.reference || null,
    data_format: args.data_format || 'auto',
    transpose,
    orientation,
    scale: scaleDeclaration,
    files: collected,
    sample_sheet: sampleSheetPath ? { path: sampleSheetPath, sha256: await sha256File(sampleSheetPath), columns: design.columns } : null,
    clinical: args.clinical ? { path: path.resolve(String(args.clinical)), sha256: await sha256File(path.resolve(String(args.clinical))) } : (clinicalData ? { inline: true, rows: clinicalData } : null),
    design,
    conflicts,
    unverified: scaleDeclaration.verified ? [] : ['scale: 未声明 verified=true，推断步骤会被闸门阻止'],
    registered_at: nowIso(),
  }
  const { dataset: stored, reused } = store.putDataset(dataset)
  return {
    ok: true, action: 'register', dataset: stored, reused,
    summary: `已登记 ${datasetId}：${collected.length} 个文件，${design.samples.length || '未给'} 个样本，scale=${scaleDeclaration.type}（verified=${scaleDeclaration.verified}）`,
    gates_preview: previewGates(stored, args),
    next: design.samples.length ? 'action=plan dataset=' + datasetId + ' template=bulk-two-group contrast={case,control}' : '补样本表/分组后再 plan（样本表未知会被闸门拦下）',
  }
}

/**
 * 数据模态 → 默认模板（六个工作台各有入口；未知模态落到纯绘图）。
 */
export function defaultTemplateFor(dataKind) {
  switch (String(dataKind || '').toLowerCase()) {
    case 'scrna': return 'scrna-composition'
    case 'spatial': return 'spatial-domain'
    case 'metabolomics': return 'metabolomics-de'
    case 'bulk': return 'bulk-two-group'
    default: return 'plotlab-figure'
  }
}

function previewGates(dataset, args) {
  try {
    const plan = P.buildPlan({
      dataset,
      template: args.template || defaultTemplateFor(dataset.data_kind),
      params: { contrast: args.case && args.control ? { case: args.case, control: args.control } : undefined },
    })
    return { status: plan.status, blocking: plan.blocking }
  } catch (error) {
    return { status: 'unknown', error: String(error && error.message ? error.message : error) }
  }
}

function roleForFile(file, fallback) {
  const name = path.basename(file).toLowerCase()
  if (/series_matrix|matrix|expr|counts|expression/.test(name)) return 'matrix'
  if (/clinical|survival|follow/.test(name)) return 'clinical'
  if (/sample|metadata|sra|characteristics/.test(name)) return 'sample_sheet'
  return fallback
}

function inferAssay(files, args) {
  if (args.assay) return args.assay
  const names = files.map((file) => file.name.toLowerCase()).join(' ')
  if (/\.h5ad|10x|scrna|single/.test(names)) return 'scrna_seq'
  if (/visium|stereo|spatial/.test(names)) return 'spatial'
  if (/metabol|lc-?ms|gc-?ms/.test(names)) return 'metabolomics'
  if (/series_matrix|geo/.test(names)) return 'microarray_or_rnaseq'
  return 'unknown'
}

function inferDataKind(assay, args) {
  // 归一化：rna-seq / RNA seq / RNAseq / rna_seq 都当同一种写法
  const text = String(assay || '').toLowerCase().replace(/[\s\-_]+/g, '_')
  if (/scrna|single_?cell|single_?nucleus/.test(text)) return 'scrna'
  if (/spatial|visium|stereo_?seq|slide_?seq|merfish/.test(text)) return 'spatial'
  if (/metabol|lc_?ms|gc_?ms|nmr/.test(text)) return 'metabolomics'
  if (/bulk|rna_?seq|microarray|array|transcriptom/.test(text)) return 'bulk'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// runs / status / cancel
// ---------------------------------------------------------------------------

function runView(store, run, { withSteps = true, withManifest = false } = {}) {
  const runDir = store.runDir(run.run_id)
  const view = {
    run_id: run.run_id,
    status: run.status,
    ok: run.status === 'succeeded',
    template: run.template,
    plan_id: run.plan_id,
    dataset_id: run.dataset_id,
    dataset_revision: run.dataset_revision,
    seed: run.seed,
    created_at: run.created_at,
    updated_at: run.updated_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    error: run.error,
    warnings: run.warnings || [],
    zero_significant: run.zero_significant,
    manifest_sha256: run.manifest_sha256,
    run_dir: runDir,
    artifacts: (run.artifacts || []).map((artifact) => ({ artifact_id: artifact.artifact_id, kind: artifact.kind, path: artifact.relative_path, sha256: artifact.sha256, bytes: artifact.bytes })),
  }
  if (withSteps) {
    view.steps = (run.steps || []).map((step) => ({
      step_id: step.step_id, plugin: step.plugin, action: step.action, status: step.status,
      attempts: step.attempts || 0, started_at: step.started_at, finished_at: step.finished_at,
      error: step.error, deliver: step.deliver,
      duration_ms: step.started_at && step.finished_at ? Math.max(0, Date.parse(step.finished_at) - Date.parse(step.started_at)) : null,
    }))
  }
  if (withManifest) {
    const manifest = readJsonIfExists(path.join(runDir, 'manifest.json'))
    if (manifest) view.manifest = manifest
  }
  view.blocked = (run.status === 'blocked') ? { gates: [] } : null
  return view
}

async function opRuns(runtime, store, args) {
  const runs = store.listRuns({ limit: Number(args.limit) || 30, status: args.status || null, dataset_id: args.dataset_id || null })
  return {
    ok: true, action: 'runs',
    runs: runs.map((run) => runView(store, run, { withSteps: false })),
    summary: `runs ${runs.length} 个` + (runs.length ? `；最新 ${runs[0].run_id}（${runs[0].status}）` : ''),
  }
}

async function opRunStatus(runtime, store, args) {
  const runId = args.run_id || args.run || (store.listRuns({ limit: 1 })[0] || {}).run_id
  if (!runId) throw storeError('not_found', '还没有任何 run（先 action=plan → submit）')
  const run = store.getRun(runId)
  if (!run) throw storeError('not_found', `run 不存在：${runId}`)
  const view = runView(store, run, { withSteps: true, withManifest: true })
  const plan = run.plan_id ? store.getPlan(run.plan_id) : null
  const index = readJsonIfExists(path.join(store.runDir(runId), 'results', 'tables.index.json'))
  view.tables = index && index.tables ? index.tables.map((table) => ({ table_id: table.table_id, title: table.title, rows: table.rows, evidence_kind: table.evidence_kind, file: path.join(store.runDir(runId), table.relative_path) })) : []
  view.figures = index && index.figures ? index.figures.map((figure) => ({ figure_id: figure.figure_id, title: figure.title, kind: figure.kind, dpi: figure.dpi, file: path.join(store.runDir(runId), figure.file) })) : []
  view.plan = plan ? summarizePlan(plan) : null
  const failedSteps = (view.steps || []).filter((step) => step.status === 'failed')
  view.next = run.status === 'failed'
    ? `看 steps[].error；常见原因：插件不可用 / 数据尺度不对 / 前置产物缺失。修好后重新 plan→submit（同输入同 run 不会重复执行）`
    : run.status === 'cancelled'
      ? 'run 已取消；重新提交会创建新 run（旧 run 零产物，不会污染）'
      : run.status === 'blocked'
        ? '看 gates；补样本表/尺度/对照重复后重新 plan'
        : run.status === 'succeeded' || run.status === 'partial'
          ? 'action=evidence / methods / export 取证与导出'
          : '等待执行完成；可 action=cancel 取消'
  view.summary = `run ${runId}：${run.status}，步骤 ${(view.steps || []).filter((step) => step.status === 'ok').length}/${(view.steps || []).length} 成功` +
    (failedSteps.length ? `；失败 ${failedSteps.map((step) => step.step_id).join('、')}` : '')
  return { ok: run.status === 'succeeded', action: 'run_status', run: view, run_id: runId, status: run.status, summary: view.summary }
}

async function opCancel(runtime, store, args) {
  const runId = args.run_id || args.run
  if (!runId) throw storeError('bad_request', 'cancel 需要 run_id')
  const run = store.getRun(runId)
  if (!run) throw storeError('not_found', `run 不存在：${runId}`)
  const active = runtime.activeRuns && runtime.activeRuns.get(runId)
  if (active && active.abort) { try { active.abort.abort() } catch { /* ignore */ } }
  const result = store.cancelRun(runId, args.reason || '用户取消')
  return {
    ok: true, action: 'cancel', run_id: runId, changed: result.changed,
    status: result.run.status, reason: result.reason || null,
    summary: result.changed ? `已取消 ${runId}：后续产物不提交（零写入）` : `未取消：${result.reason}`,
  }
}

// ---------------------------------------------------------------------------
// export / evidence / methods / audit
// ---------------------------------------------------------------------------

async function verifyRunArtifacts(store, run) {
  const issues = []
  const files = []
  for (const artifact of run.artifacts || []) {
    const file = path.join(store.runDir(run.run_id), artifact.relative_path)
    if (!fs.existsSync(file)) { issues.push({ artifact_id: artifact.artifact_id, path: artifact.relative_path, issue: 'missing' }); continue }
    const actual = await sha256File(file)
    const ok = actual === artifact.sha256
    if (!ok) issues.push({ artifact_id: artifact.artifact_id, path: artifact.relative_path, issue: 'hash_mismatch', expected: artifact.sha256, actual })
    const bytes = fileSize(file)
    if (artifact.bytes && bytes !== artifact.bytes) issues.push({ artifact_id: artifact.artifact_id, path: artifact.relative_path, issue: 'size_mismatch', expected: artifact.bytes, actual: bytes })
    files.push({ artifact_id: artifact.artifact_id, path: artifact.relative_path, sha256: actual, bytes, ok })
  }
  return { ok: issues.length === 0, files, issues }
}

/** 导出记录文件：<root>/exports.jsonl（append-only，重复 content_hash 不重复记）。 */
function exportsFile(store) {
  return path.join(store.dirs.root, 'exports.jsonl')
}

function listExportRecords(store, runId = null) {
  const file = exportsFile(store)
  if (!fs.existsSync(file)) return []
  const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
  return runId ? records.filter((record) => record.run_id === runId) : records
}

function appendExportRecord(store, record) {
  try {
    const existing = listExportRecords(store).some((item) => item.export_id === record.export_id && item.run_id === record.run_id)
    if (existing) return
    fs.appendFileSync(exportsFile(store), JSON.stringify(record) + '\n', 'utf8')
  } catch { /* 记录失败不影响导出本身 */ }
}

function findExportRecord(store, exportId) {
  const records = listExportRecords(store)
  return records.slice().reverse().find((record) => record.export_id === exportId || record.content_hash === exportId) || null
}

/** 运行配置（输出目录等）：<dataRoot>/config.json。 */
function settingsFile(store) {
  return path.join(store.dirs.root, 'config.json')
}

export function readSettings(store) {
  const raw = readJsonIfExists(settingsFile(store)) || {}
  return {
    output_dir: raw.output_dir || null,
    download_dir: raw.download_dir || null,
    updated_at: raw.updated_at || null,
  }
}

async function opSettings(runtime, store, args) {
  const current = readSettings(store)
  let changed = false
  for (const key of ['output_dir', 'download_dir']) {
    if (args[key] === undefined) continue
    const raw = String(args[key] || '').trim()
    if (!raw) { current[key] = null; changed = true; continue }
    const abs = path.resolve(raw)
    try { ensureDir(abs) } catch (error) {
      throw storeError('bad_request', `目录不可用：${abs}（${error && error.message ? error.message : error}）`)
    }
    current[key] = abs
    changed = true
  }
  if (changed) {
    current.updated_at = nowIso()
    atomicWriteJson(settingsFile(store), current)
    store.logEvent('settings', 'update', current)
  }
  return {
    ok: true,
    action: 'settings',
    settings: current,
    file: settingsFile(store),
    summary: `输出目录：${current.output_dir || '（未设置，默认导出到 run 目录旁）'}；下载目录：${current.download_dir || '（默认）'}`,
  }
}

/**
 * 删除一条历史/结果：run 目录移入 <dataRoot>/trash/runs/<run_id>（或 purge 直接删），
 * 并移除 store 记录。运行中的 run 必须先 cancel —— 绝不删除正在写的目录。
 */
async function opDelete(runtime, store, args) {
  const target = String(args.target || args.kind || (args.run_id ? 'run' : args.dataset_id ? 'dataset' : 'run')).toLowerCase()
  const purge = args.purge === true
  if (target === 'run') {
    const runId = String(args.id || args.run_id || '')
    if (!runId) throw storeError('bad_request', 'delete target=run 需要 run_id（或 id）')
    const run = store.getRun(runId)
    if (!run) throw storeError('not_found', `run 不存在：${runId}`)
    if (['queued', 'running', 'pending_review'].includes(run.status)) {
      throw storeError('bad_request', `run ${runId} 状态 ${run.status}：先 action=cancel，再删除`)
    }
    const runDir = store.runDir(runId)
    let trashedTo = null
    if (fs.existsSync(runDir)) {
      if (purge) {
        fs.rmSync(runDir, { recursive: true, force: true })
      } else {
        trashedTo = path.join(store.dirs.root, 'trash', 'runs', runId)
        ensureDir(path.dirname(trashedTo))
        try { atomicWriteFile(path.join(runDir, 'run.record.json'), JSON.stringify(run, null, 2)) } catch { /* best effort */ }
        fs.renameSync(runDir, trashedTo)
      }
    }
    store.backend.remove('run', runId)
    store.logEvent('delete', 'run', { run_id: runId, purge, trashed_to: trashedTo })
    return {
      ok: true, action: 'delete', target: 'run', deleted: runId, purged: purge, trashed_to: trashedTo,
      summary: purge ? `已彻底删除 run ${runId}` : `run ${runId} 已移入回收站：${trashedTo}`,
      next: purge ? '不可恢复' : '恢复：trash --trash-op=restore --id=' + runId + '；彻底删除：trash --trash-op=purge',
    }
  }
  if (target === 'dataset') {
    const datasetId = String(args.id || args.dataset_id || '')
    if (!datasetId) throw storeError('bad_request', 'delete target=dataset 需要 dataset_id（或 id）')
    const dataset = store.getDataset(datasetId)
    if (!dataset) throw storeError('not_found', `数据集不存在：${datasetId}`)
    const usedByRuns = store.listRuns({ limit: 1000 }).filter((run) => run.dataset_id === datasetId)
    if (usedByRuns.length && !args.force) {
      throw storeError('bad_request', `数据集仍被 ${usedByRuns.length} 个 run 引用（如 ${usedByRuns[0].run_id}）；先删 run 或传 force=true`, { runs: usedByRuns.map((run) => run.run_id) })
    }
    store.backend.remove('dataset', datasetId)
    store.logEvent('delete', 'dataset', { dataset_id: datasetId })
    return { ok: true, action: 'delete', target: 'dataset', deleted: datasetId, summary: `已移除数据集记录 ${datasetId}（用户原始文件不会被删除）` }
  }
  if (target === 'export' || target === 'export_record') {
    const exportId = String(args.id || args.export_id || '')
    if (!exportId) throw storeError('bad_request', 'delete target=export 需要 export_id')
    const file = path.join(store.dirs.root, 'exports.jsonl')
    if (!fs.existsSync(file)) throw storeError('not_found', '没有导出记录')
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const kept = lines.filter((line) => {
      try { const record = JSON.parse(line); return record.export_id !== exportId && record.content_hash !== exportId } catch { return false }
    })
    const removed = lines.length - kept.length
    atomicWriteFile(file, kept.join('\n') + (kept.length ? '\n' : ''))
    return { ok: true, action: 'delete', target: 'export', deleted: exportId, removed, summary: `已删除 ${removed} 条导出记录 ${exportId}` }
  }
  throw storeError('bad_request', `delete 的 target 只支持 run / dataset / export，收到 ${target}`)
}

/**
 * 回收站：list / restore / purge / empty。
 * 删除 run 时会把完整的 run 记录一起写进 trash/runs/<run_id>/run.record.json，
 * 恢复时据此重建索引；老目录没有记录文件也能从 manifest 兜底。
 */
async function opTrash(runtime, store, args) {
  const op = String(args.trash_op || args.op || 'list').toLowerCase()
  const trashRoot = path.join(store.dirs.root, 'trash', 'runs')
  const readEntry = (runId) => {
    const dir = path.join(trashRoot, runId)
    let record = null
    const recordPath = path.join(dir, 'run.record.json')
    if (fs.existsSync(recordPath)) {
      try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) } catch { record = null }
    }
    let manifest = null
    const manifestPath = path.join(dir, 'manifest.json')
    if (fs.existsSync(manifestPath)) {
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { manifest = null }
    }
    let bytes = 0
    const walk = (target) => {
      let stat
      try { stat = fs.statSync(target) } catch { return }
      if (stat.isDirectory()) {
        for (const child of fs.readdirSync(target)) walk(path.join(target, child))
      } else bytes += stat.size
    }
    walk(dir)
    let deletedAt = null
    try { deletedAt = fs.statSync(dir).mtime.toISOString() } catch { deletedAt = null }
    return {
      run_id: runId,
      status: (record && record.status) || (manifest && manifest.status) || 'unknown',
      template: (record && record.template) || (manifest && manifest.template) || null,
      dataset_id: (record && record.dataset_id) || (manifest && manifest.dataset_id) || null,
      zero_significant: (record && record.zero_significant) ?? (manifest && manifest.zero_significant) ?? null,
      deleted_at: deletedAt,
      bytes,
      has_record: Boolean(record),
      dir,
    }
  }
  if (op === 'list') {
    const items = fs.existsSync(trashRoot)
      ? fs.readdirSync(trashRoot).filter((name) => {
        try { return fs.statSync(path.join(trashRoot, name)).isDirectory() } catch { return false }
      }).map(readEntry).sort((left, right) => String(right.deleted_at).localeCompare(String(left.deleted_at)))
      : []
    return {
      ok: true, action: 'trash', op: 'list', items,
      summary: items.length ? `回收站里有 ${items.length} 个 run（可恢复或彻底删除）` : '回收站是空的',
      next: items.length ? 'trash --trash-op=restore --id=<run_id> 恢复；--trash-op=purge 彻底删除；--trash-op=empty 清空' : null,
    }
  }
  if (op === 'restore') {
    const runId = String(args.id || args.run_id || '')
    if (!runId) throw storeError('bad_request', 'trash restore 需要 run_id（或 id）')
    const entry = readEntry(runId)
    if (!fs.existsSync(entry.dir)) throw storeError('not_found', `回收站里没有 run：${runId}`)
    const target = store.runDir(runId)
    if (fs.existsSync(target)) throw storeError('bad_request', `runs/ 下已存在同名 run：${runId}（先移走或改名）`)
    let record = null
    const recordPath = path.join(entry.dir, 'run.record.json')
    if (fs.existsSync(recordPath)) {
      try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) } catch { record = null }
    }
    fs.renameSync(entry.dir, target)
    let manifest = null
    try { manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8')) } catch { manifest = null }
    const now = nowIso()
    const restored = Object.assign({
      schema_version: 1,
      run_id: runId,
      idempotency_key: 'restored:' + runId,
      status: (manifest && manifest.status) || 'succeeded',
      status_history: [{ status: 'restored', at: now }],
      plan_id: (manifest && manifest.plan_id) || null,
      plan_hash: null,
      template: (manifest && manifest.template) || null,
      template_version: null,
      dataset_id: (manifest && manifest.dataset_id) || null,
      dataset_revision: null,
      params: {},
      seed: null,
      parent_run: null,
      created_at: (manifest && manifest.created_at) || now,
      updated_at: now,
      started_at: null,
      finished_at: (manifest && manifest.finished_at) || null,
      error: null,
      warnings: [],
      zero_significant: (manifest && manifest.zero_significant) ?? null,
      steps: (manifest && manifest.steps) || [],
      artifacts: (manifest && manifest.artifacts) || [],
      manifest_sha256: null,
      restored_from_trash: true,
    }, record || {}, { run_id: runId, updated_at: now })
    if (record && record.idempotency_key) restored.idempotency_key = record.idempotency_key
    store.backend.put('run', runId, restored)
    store.logEvent('trash', 'restore', { run_id: runId })
    return { ok: true, action: 'trash', op: 'restore', restored: runId, summary: `已恢复 run ${runId}（重新建立索引，可继续看结果）` }
  }
  if (op === 'purge') {
    const runId = String(args.id || args.run_id || '')
    if (!runId) throw storeError('bad_request', 'trash purge 需要 run_id（或 id）')
    const entry = readEntry(runId)
    if (!fs.existsSync(entry.dir)) throw storeError('not_found', `回收站里没有 run：${runId}`)
    fs.rmSync(entry.dir, { recursive: true, force: true })
    store.logEvent('trash', 'purge', { run_id: runId })
    return { ok: true, action: 'trash', op: 'purge', purged: runId, summary: `已彻底删除 run ${runId}（不可恢复）` }
  }
  if (op === 'empty') {
    let count = 0
    if (fs.existsSync(trashRoot)) {
      for (const name of fs.readdirSync(trashRoot)) {
        const target = path.join(trashRoot, name)
        try {
          if (fs.statSync(target).isDirectory()) { fs.rmSync(target, { recursive: true, force: true }); count += 1 }
        } catch { /* ignore */ }
      }
    }
    store.logEvent('trash', 'empty', { count })
    return { ok: true, action: 'trash', op: 'empty', purged: count, summary: `已清空回收站（${count} 个 run）` }
  }
  throw storeError('bad_request', `trash 的 op 只支持 list / restore / purge / empty，收到 ${op}`)
}

async function opExport(runtime, store, args) {
  // 回查模式：只给 export_id（重启后仍可查到导出记录）
  if (!args.run_id && !args.run && (args.export_id || args.export)) {
    const record = findExportRecord(store, String(args.export_id || args.export))
    if (!record) throw storeError('not_found', `导出记录不存在：${args.export_id || args.export}`)
    return {
      ok: record.ok, action: 'export', mode: 'lookup', run_id: record.run_id,
      content_hash: record.content_hash, export: record,
      summary: `导出记录 ${record.export_id}：run ${record.run_id}，${record.summary.files} 个文件，content_hash=${String(record.content_hash).slice(0, 12)}`,
    }
  }
  const runId = args.run_id || args.run
  if (!runId) throw storeError('bad_request', 'export 需要 run_id（或回查用 export_id）')
  const run = store.getRun(runId)
  if (!run) throw storeError('not_found', `run 不存在：${runId}`)
  const verification = await verifyRunArtifacts(store, run)
  const runDir = store.runDir(runId)
  const files = verification.files.map((file) => ({ ...file, abs_path: path.join(runDir, file.path) }))
  // 内容哈希：只由「文件路径 + 内容 sha256」与 manifest 决定，**不含 exported_at**，
  // 因此同一 run 反复导出得到同一个 content_hash（可用作结果包版本号）。
  const contentHash = sha256(stableStringify({
    schema_version: 1,
    run_id: runId,
    manifest_sha256: run.manifest_sha256,
    files: files.map((file) => [file.path, file.sha256, file.bytes || 0]).sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
  }))
  const exportRecord = {
    schema_version: 1,
    run_id: runId,
    export_id: `exp_${contentHash.slice(0, 12)}`,
    content_hash: contentHash,
    exported_at: nowIso(),
    status: run.status,
    ok: run.status === 'succeeded' && verification.ok,
    manifest_sha256: run.manifest_sha256,
    files,
    issues: verification.issues,
    summary: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + (file.bytes || 0), 0),
      verified: verification.ok,
    },
  }
  // 导出记录落盘（<root>/exports.jsonl，append-only；同一 content_hash 只记一次）
  appendExportRecord(store, exportRecord)
  let outPath = null
  const configuredOut = readSettings(store).output_dir
  const wantedOut = args.out_path ? String(args.out_path) : configuredOut
  if (wantedOut) {
    outPath = path.resolve(String(wantedOut))
    ensureDir(outPath)
    const bundleDir = path.join(outPath, `bioflow-${runId}`)
    ensureDir(bundleDir)
    for (const file of files) {
      const target = path.join(bundleDir, file.path)
      ensureDir(path.dirname(target))
      fs.copyFileSync(file.abs_path, target)
    }
    atomicWriteJson(path.join(bundleDir, 'export.json'), exportRecord)
    exportRecord.bundle_dir = bundleDir
  }
  return {
    ok: exportRecord.ok,
    action: 'export',
    run_id: runId,
    status: run.status,
    export: exportRecord,
    export_id: exportRecord.export_id,
    content_hash: contentHash,
    exports: listExportRecords(store, runId).slice(0, 20),
    out_path: outPath,
    summary: `导出 ${runId}：${files.length} 个文件，${verification.ok ? '哈希校验通过' : `${verification.issues.length} 个哈希问题`}；content_hash=${contentHash.slice(0, 12)}`,
    next: outPath ? `结果包在 ${outPath}` : '传 out_path 可把结果包复制到指定目录',
  }
}

async function opEvidence(runtime, store, args) {
  const runId = args.run_id || args.run
  if (!runId) throw storeError('bad_request', 'evidence 需要 run_id')
  const run = store.getRun(runId)
  if (!run) throw storeError('not_found', `run 不存在：${runId}`)
  // 写模式：claim → run_id/contrast_id/table_id/row_id/figure_id/PMID 绑定；
  // 校验模式：对已有 evidence.jsonl 逐条核引用。
  if (args.claim || args.claim_text) return writeEvidenceClaim(store, run, args)
  if (args.verify === true) return verifyEvidenceFile(store, run)
  const file = path.join(store.runDir(runId), 'evidence.jsonl')
  if (!fs.existsSync(file)) throw storeError('prerequisite', `run ${runId} 没有 evidence.jsonl（可能未成功完成或已取消）`)
  const limit = Math.max(1, Math.min(2000, Number(args.limit) || 200))
  const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
  let filtered = all
  if (args.table_id) filtered = filtered.filter((record) => record.table_id === args.table_id)
  if (args.row_id) filtered = filtered.filter((record) => Number(record.row_id) === Number(args.row_id))
  if (args.evidence_kind) filtered = filtered.filter((record) => record.evidence_kind === args.evidence_kind)
  if (args.contrast_id) filtered = filtered.filter((record) => record.contrast_id === args.contrast_id)
  const manifest = readJsonIfExists(path.join(store.runDir(runId), 'manifest.json'))
  return {
    ok: true, action: 'evidence', run_id: runId,
    file,
    records: filtered.slice(0, limit),
    total: filtered.length,
    truncated: filtered.length > limit,
    counts: {
      measured: all.filter((record) => record.evidence_kind === 'measured').length,
      descriptive: all.filter((record) => record.evidence_kind === 'descriptive').length,
      model_prediction: all.filter((record) => record.evidence_kind === 'model_prediction').length,
    },
    zero_significant: manifest ? manifest.zero_significant : run.zero_significant,
    summary: `evidence ${filtered.length}/${all.length} 条（measured ${all.filter((record) => record.evidence_kind === 'measured').length} / descriptive ${all.filter((record) => record.evidence_kind === 'descriptive').length} / model_prediction ${all.filter((record) => record.evidence_kind === 'model_prediction').length}）`,
  }
}

/** 读 run 的 tables.index.json（table_id → 行数/相对路径/证据类型）。 */
function readRunTablesIndex(store, runId) {
  const runDir = store.runDir(runId)
  const index = readJsonIfExists(path.join(runDir, 'results', 'tables.index.json')) || {}
  const tables = {}
  for (const table of Array.isArray(index.tables) ? index.tables : []) tables[table.table_id] = table
  const figures = Array.isArray(index.figures) ? index.figures : []
  return { index, tables, figures, runDir }
}

/**
 * 刷新 evidence.jsonl 在 manifest 里的哈希与 manifest.content_hash。
 * 追加 claim 后如果不刷新，export 的哈希校验会把 evidence.jsonl 判成 artifact_mismatch。
 */
async function refreshEvidenceManifest(store, runId) {
  const runDir = store.runDir(runId)
  const manifestPath = path.join(runDir, 'manifest.json')
  const manifest = readJsonIfExists(manifestPath)
  if (!manifest) return null
  const evidencePath = path.join(runDir, 'evidence.jsonl')
  if (!fs.existsSync(evidencePath)) return null
  const sha = await sha256File(evidencePath)
  const artifacts = (manifest.artifacts || []).map((item) => (item.relative_path === 'evidence.jsonl'
    ? { ...item, sha256: sha, artifact_id: sha, bytes: fileSize(evidencePath) }
    : item))
  const { content_hash: _dropped, ...rest } = manifest
  const next = { ...rest, artifacts }
  next.content_hash = sha256(stableStringify({ ...next, artifacts }))
  atomicWriteJson(manifestPath, next)
  const manifestSha = await sha256File(manifestPath)
  // run.artifacts 也要同步：export 的哈希校验走 run.artifacts（addArtifact 对终态 run 会拒绝写，
  // 所以这里用 patchRun 精确更新这两条，属于证据登记后的合法自愈，不是篡改产物）。
  const current = store.getRun(runId)
  const syncedArtifacts = (current.artifacts || []).map((item) => {
    if (item.relative_path === 'evidence.jsonl') {
      return { ...item, artifact_id: sha, sha256: sha, bytes: fileSize(evidencePath) }
    }
    if (item.relative_path === 'manifest.json') {
      return { ...item, artifact_id: manifestSha, sha256: manifestSha, bytes: fileSize(manifestPath) }
    }
    return item
  })
  store.patchRun(runId, { manifest_sha256: manifestSha, artifacts: syncedArtifacts })
  return { evidence_sha256: sha, manifest_sha256: manifestSha, content_hash: next.content_hash }
}

/** 规范化 PMID 列表：允许数组或逗号串；必须是数字。 */
function normalizePmids(value) {
  if (value === undefined || value === null || value === '') return []
  const raw = Array.isArray(value) ? value : String(value).split(/[,，\s]+/)
  const out = []
  for (const item of raw) {
    const text = String(item || '').trim().replace(/^PMID:?/i, '')
    if (!text) continue
    if (!/^\d{3,9}$/.test(text)) throw storeError('bad_request', `PMID 必须是数字：${item}`)
    if (!out.includes(text)) out.push(text)
  }
  return out
}

/** evidence 写模式：把一条 claim 绑定到 run/表行/图/文献，追加进 evidence.jsonl 并校验。 */
async function writeEvidenceClaim(store, run, args) {
  const runId = run.run_id
  if (!['succeeded', 'partial'].includes(run.status)) {
    throw storeError('prerequisite', `run ${runId} 状态 ${run.status}：只有 succeeded/partial 的 run 可以写证据`)
  }
  const text = String(args.claim || args.claim_text || '').trim()
  if (text.length < 6) throw storeError('bad_request', 'claim 太短：需要一句可回查的陈述（≥6 字）')
  const { tables, figures, runDir } = readRunTablesIndex(store, runId)
  const tableId = args.table_id ? String(args.table_id) : null
  const figureId = args.figure_id ? String(args.figure_id) : null
  const rowId = args.row_id === undefined || args.row_id === null ? null : Number(args.row_id)
  const evidenceKind = String(args.evidence_kind || 'measured')
  if (!E.EVIDENCE_KINDS.includes(evidenceKind)) throw storeError('bad_request', `evidence_kind 必须是 ${E.EVIDENCE_KINDS.join('/')}`)
  const problems = []
  if (!tableId && !figureId) problems.push('claim 必须绑定 table_id 或 figure_id（否则无法回查源表）')
  let rowCount = null
  if (tableId) {
    const table = tables[tableId]
    if (!table) problems.push(`run 里没有表 ${tableId}（可用：${Object.keys(tables).slice(0, 12).join('、') || '无'}）`)
    else {
      rowCount = Number(table.rows) || 0
      if (rowId !== null && (!Number.isFinite(rowId) || rowId < 1 || rowId > rowCount)) {
        problems.push(`row_id 超出范围：${tableId}#${rowId}（该表 ${rowCount} 行）`)
      }
    }
  }
  if (figureId && !figures.some((figure) => figure.figure_id === figureId)) {
    problems.push(`run 里没有图 ${figureId}（可用：${figures.slice(0, 8).map((figure) => figure.figure_id).join('、') || '无'}）`)
  }
  if (problems.length) {
    throw storeError('bad_request', `证据绑定校验失败：${problems.join('；')}`, { problems, table_id: tableId, row_id: rowId, figure_id: figureId })
  }
  const pmids = normalizePmids(args.pmids || args.pmid)
  const file = path.join(runDir, 'evidence.jsonl')
  const existing = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    : []
  const claimId = String(args.claim_id || `claim_${runId}_${sha256(text).slice(0, 10)}`)
  if (existing.some((record) => record.claim_id === claimId)) {
    throw storeError('draft_changed', `claim_id 已存在：${claimId}（换个 claim 文本或显式给 claim_id）`)
  }
  const record = {
    schema_version: 1,
    claim_id: claimId,
    evidence_kind: evidenceKind,
    claim: text,
    run_id: runId,
    dataset_id: run.dataset_id || null,
    dataset_revision: run.dataset_revision || null,
    plan_id: run.plan_id || null,
    contrast_id: args.contrast_id || null,
    table_id: tableId,
    row_id: rowId,
    figure_id: figureId,
    source_file: tableId && tables[tableId] ? tables[tableId].file : null,
    pmids,
    added_by: args.added_by || 'agent',
    added_at: nowIso(),
  }
  for (const key of Object.keys(record)) if (record[key] === null || record[key] === undefined) delete record[key]
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
  const refreshed = await refreshEvidenceManifest(store, runId)
  return {
    ok: true,
    action: 'evidence',
    mode: 'claim',
    run_id: runId,
    claim_id: claimId,
    record,
    pmids,
    manifest: refreshed,
    summary: `已写入 claim ${claimId}：绑定 ${[tableId && `${tableId}#${rowId ?? '-'}`, figureId && `figure ${figureId}`, pmids.length && `PMID ${pmids.join(',')}`].filter(Boolean).join(' / ')}（evidence_kind=${evidenceKind}）`,
    next: 'action=evidence verify=true 可复核全部 claim 的引用；导出的 evidence.jsonl 已含这条',
  }
}

/** evidence 校验模式：逐条核对 run/table/row/figure 引用。 */
function verifyEvidenceFile(store, run) {
  const runId = run.run_id
  const file = path.join(store.runDir(runId), 'evidence.jsonl')
  if (!fs.existsSync(file)) throw storeError('prerequisite', `run ${runId} 没有 evidence.jsonl`)
  const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const { tables, figures } = readRunTablesIndex(store, runId)
  const tableIndex = {}
  for (const [id, table] of Object.entries(tables)) tableIndex[id] = { rows: Number(table.rows) || 0 }
  const result = E.verifyEvidence(records, { tableIndex, figures })
  const withPmids = records.filter((record) => Array.isArray(record.pmids) && record.pmids.length).length
  return {
    ok: result.ok,
    action: 'evidence',
    mode: 'verify',
    run_id: runId,
    checked: result.checked,
    issues: result.issues,
    counts: {
      measured: records.filter((record) => record.evidence_kind === 'measured').length,
      descriptive: records.filter((record) => record.evidence_kind === 'descriptive').length,
      model_prediction: records.filter((record) => record.evidence_kind === 'model_prediction').length,
    },
    with_pmids: withPmids,
    summary: result.ok
      ? `evidence 引用校验通过：${result.checked} 条（其中 ${withPmids} 条绑定 PMID）`
      : `evidence 引用校验发现 ${result.issues.length} 个问题`,
  }
}

async function opMethods(runtime, store, args) {
  const runId = args.run_id || args.run
  if (!runId) throw storeError('bad_request', 'methods 需要 run_id')
  const run = store.getRun(runId)
  if (!run) throw storeError('not_found', `run 不存在：${runId}`)
  const file = path.join(store.runDir(runId), 'methods.md')
  if (!fs.existsSync(file)) throw storeError('prerequisite', `run ${runId} 没有 methods.md`)
  const content = fs.readFileSync(file, 'utf8')
  return {
    ok: true, action: 'methods', run_id: runId, file,
    content: args.full === false ? content.slice(0, 4000) : content,
    bytes: fileSize(file),
    summary: `methods.md：${file}`,
  }
}

async function opAudit(runtime, store) {
  const checks = []
  const info = store.info()
  checks.push({ id: 'store', level: 'ok', title: '存储可用', detail: `${info.kind} @ ${info.root}` })
  // run 状态一致性：ok=true 的 run 不能有失败步骤
  let badRuns = 0
  for (const run of store.listRuns({ limit: 500 })) {
    const failed = (run.steps || []).filter((step) => step.status === 'failed')
    if (failed.length && run.status === 'succeeded') { badRuns += 1; checks.push({ id: 'run_consistency', level: 'error', title: `run ${run.run_id} 状态与步骤不符`, detail: `${failed.length} 个失败步骤但 status=succeeded` }) }
  }
  if (!badRuns) checks.push({ id: 'run_consistency', level: 'ok', title: 'run 状态与步骤一致', detail: `${store.listRuns({ limit: 500 }).length} 个 run` })
  // 未完成 run（排队/运行）提示
  const active = store.listRuns({ limit: 500 }).filter((run) => ['queued', 'running', 'pending_review'].includes(run.status))
  if (active.length) checks.push({ id: 'active_runs', level: 'warn', title: `${active.length} 个 run 未完成`, detail: active.map((run) => `${run.run_id}=${run.status}`).join('、') })
  // 交付物哈希
  let checkedFiles = 0
  let badFiles = 0
  for (const run of store.listRuns({ limit: 50 })) {
    if (!['succeeded', 'partial', 'failed'].includes(run.status)) continue
    const verification = await verifyRunArtifacts(store, run)
    checkedFiles += verification.files.length
    if (!verification.ok) { badFiles += verification.issues.length; checks.push({ id: 'artifacts', level: 'error', title: `run ${run.run_id} 交付物哈希问题`, detail: JSON.stringify(verification.issues.slice(0, 3)) }) }
  }
  if (!badFiles) checks.push({ id: 'artifacts', level: 'ok', title: '交付物哈希一致', detail: `${checkedFiles} 个文件` })
  // 插件协议
  const plugins = await A.probePlugins({ pluginPaths: runtime.config && runtime.config.pluginPaths })
  const unavailable = Object.entries(plugins).filter(([, value]) => !value.available).map(([plugin]) => plugin)
  checks.push({
    id: 'plugins', level: unavailable.length ? 'warn' : 'ok',
    title: `插件可用 ${A.PLUGIN_IDS.length - unavailable.length}/${A.PLUGIN_IDS.length}`,
    detail: unavailable.length ? `不可用：${unavailable.join('、')}` : '全部协议检查通过',
  })
  // staging 残留
  let stagingLeft = 0
  for (const run of store.listRuns({ limit: 200 })) {
    const staging = path.join(store.runDir(run.run_id), '.staging')
    if (fs.existsSync(staging)) stagingLeft += 1
  }
  checks.push({ id: 'staging', level: stagingLeft ? 'warn' : 'ok', title: 'staging 残留', detail: stagingLeft ? `${stagingLeft} 个 run 有未清理 staging（取消/崩溃残留）` : '无' })
  // evidence 可回查
  let evidenceChecked = 0
  let evidenceIssues = 0
  for (const run of store.listRuns({ limit: 20 })) {
    const file = path.join(store.runDir(run.run_id), 'evidence.jsonl')
    if (!fs.existsSync(file)) continue
    const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    const index = readJsonIfExists(path.join(store.runDir(run.run_id), 'results', 'tables.index.json')) || { tables: [] }
    const tableIndex = {}
    for (const table of index.tables || []) tableIndex[table.table_id] = { rows: table.rows }
    const verification = E.verifyEvidence(records, { tableIndex, figures: index.figures || [] })
    evidenceChecked += records.length
    if (!verification.ok) { evidenceIssues += verification.issues.length; checks.push({ id: 'evidence', level: 'error', title: `run ${run.run_id} evidence 引用无效`, detail: JSON.stringify(verification.issues.slice(0, 3)) }) }
  }
  if (!evidenceIssues) checks.push({ id: 'evidence', level: 'ok', title: 'evidence 引用可回查', detail: `${evidenceChecked} 条` })
  const errors = checks.filter((check) => check.level === 'error').length
  const warns = checks.filter((check) => check.level === 'warn').length
  const score = Math.max(0, 100 - errors * 25 - warns * 5)
  return {
    ok: errors === 0,
    action: 'audit',
    score,
    level: errors ? 'error' : warns ? 'warn' : 'ok',
    checks,
    summary: `自检 ${score}/100：${errors} 个错误、${warns} 个警告；数据集 ${info.datasets}、runs ${info.runs}`,
    next: errors ? '先修 error 项（哈希/引用/状态一致性），再对外导出证据' : '可以对外交付；导出前再跑一次 audit',
  }
}

// ---------------------------------------------------------------------------
// 文件服务（UI 的 figures / manifest 预览）
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.json': 'application/json; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.gz': 'application/gzip',
}

/** 把 URL 里的相对路径安全解析到 dataRoot 下（只允许交付物/数据集目录）。 */
export function resolveServedPath(runtime, relative) {
  const root = path.resolve(dataRoot(runtime))
  const cleaned = decodeURIComponent(String(relative || '')).replace(/^\/+/, '')
  const abs = path.resolve(root, cleaned)
  if (!(abs === root || abs.startsWith(root + path.sep))) return null
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
  return abs
}

export function readServedFile(abs) {
  const ext = path.extname(abs).toLowerCase()
  return { path: abs, contentType: CONTENT_TYPES[ext] || 'application/octet-stream', bytes: fileSize(abs), buffer: fs.readFileSync(abs) }
}

// ---------------------------------------------------------------------------
// system prompt
// ---------------------------------------------------------------------------

/**
 * 宿主已有 pubmed 工具（dsh-pubmed 插件）时优先转发，结果注明 via=dsh-pubmed。
 *
 * 宿主工具的参数/返回结构不是本仓库的契约，所以这里做**保守多形状尝试**：
 *   - 依次试 {query}/{term}/{action:'search',query} 三种入参；
 *   - 返回体从 results/articles/items/records 或裸数组里取条目；
 *   - 任何一步失败都返回 null，pubmed.mjs 会自动回退到内置 E-utilities（绝不假装成功）。
 * 每条记录仍归一化成 bioflow 的字段，保证下游 provenance/证据链一致。
 */
export function ensurePubMedForwarder(runtime) {
  if (runtime.pubmedForwarder) return true
  try {
    const ctx = runtime.ctx
    const tools = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : ctx && ctx.tools
    if (!tools || typeof tools.get !== 'function') return false
    let tool = null
    for (const name of ['pubmed', 'pubmed_search', 'dsh-pubmed']) {
      try {
        const candidate = tools.get(name)
        if (candidate && typeof candidate.execute === 'function') { tool = candidate; break }
      } catch { /* 继续试下一个名字 */ }
    }
    if (!tool) return false
    runtime.pubmedForwarder = async ({ term, limit = 20, page = 0, includeAbstracts = false }) => {
      const attempts = [
        { query: term, limit, page, include_abstracts: includeAbstracts },
        { term, limit, page, include_abstracts: includeAbstracts },
        { action: 'search', query: term, limit, page, include_abstracts: includeAbstracts },
      ]
      let lastError = null
      for (const args of attempts) {
        try {
          const raw = await tool.execute(args, {})
          const items = pickPubMedItems(raw)
          if (!items) continue
          return {
            items: items.map(normalizeHostPubMedItem),
            total: Number((raw && (raw.total ?? raw.hit_count ?? raw.count)) || items.length) || items.length,
            via: 'dsh-pubmed',
            actual_query: (raw && (raw.actual_query || raw.querytranslation || raw.query)) || term,
            relaxed: Boolean(raw && raw.relaxed),
            warnings: [],
          }
        } catch (error) { lastError = error }
      }
      if (lastError) throw lastError
      return null
    }
    return true
  } catch {
    return false
  }
}

function pickPubMedItems(raw) {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== 'object') return null
  for (const key of ['items', 'results', 'articles', 'records', 'data', 'papers']) {
    if (Array.isArray(raw[key])) return raw[key]
  }
  return null
}

function normalizeHostPubMedItem(item) {
  if (!item || typeof item !== 'object') return { source: 'pubmed', id: String(item || ''), title: null }
  const pmid = item.pmid || item.id || item.uid || null
  const authorsRaw = Array.isArray(item.authors) ? item.authors : (item.author_list || [])
  const authors = authorsRaw
    .map((author) => (typeof author === 'string' ? author : author && (author.name || author.full_name || author.last_name) || null))
    .filter(Boolean)
  const truncated = authors.length > 3 ? [...authors.slice(0, 3), 'et al'] : authors
  return {
    source: 'pubmed',
    id: pmid ? String(pmid) : null,
    pmid: pmid ? String(pmid) : null,
    doi: item.doi || null,
    title: item.title || null,
    journal: item.journal || (item.journal_info && item.journal_info.title) || null,
    year: Number(item.year || item.pub_year || item.pubdate || 0) || null,
    authors: truncated,
    abstract: item.abstract || null,
    pubtype: item.pubtype || item.pub_type || null,
    openAccess: Boolean(item.openAccess || item.is_open_access || item.open_access),
    fullTextUrl: item.fullTextUrl || item.full_text_url || null,
  }
}

export function renderPromptSection(runtime) {
  const lines = [
    '许愿式生物信息全自动分析平台（Host 插件 dsh-bioflow）已加载：检索 → 下载/登记 → 计划（闸门）→ 提交 → 监控 → 导出 → 取证 是一条不可变流水线。',
    '用户要做跨插件分析、找公共数据（GEO/PubMed/GDC/TCGA/MetaboLights/CELLxGENE）、统一下载、多数据归一化或联合分析时，优先用 bioflow 工具。',
    '自然语言许愿先用 action=ask：它只返回 draft 计划（不会直接执行），缺字段会给最少的问题和候选；用户确认后用 submit 带 plan_id + confirm_token。',
    '闸门不过就是不过：样本表未知 / counts 未验证 / 每组独立 n<2 / 设计完全混杂 / contrast 方向不明 / 缺前置产物 → blocked，不要绕过。',
    '任何一步失败都不得整体 ok:true；取消的 run 零产物。模型推演类结果（virtualcell / 签名映射）标 evidence_kind=model_prediction，不是实验结论。',
    '典型链路：search → download（或 register 本地）→ ask/plan → submit → run_status → export/evidence/methods；多数据用 harmonize → joint。',
  ]
  const state = runtime.lastState
  if (state) lines.push(`当前：数据集 ${state.datasets} 个、runs ${state.runs} 个、最近状态 ${state.lastRunStatus || '—'}。`)
  return lines.join('\n')
}

export function ensurePromptSection(runtime) {
  if (runtime.promptRegistered) return runtime.promptRegistered
  try {
    const ctx = runtime.ctx
    const systemPrompt = ctx && typeof ctx.get === 'function' ? ctx.get('systemPrompt') : ctx && ctx.systemPrompt
    if (!systemPrompt || typeof systemPrompt.section !== 'function') { runtime.promptRegistered = false; return false }
    const dispose = systemPrompt.section({
      name: 'dsh-bioflow-entry',
      order: 762,
      text: () => renderPromptSection(runtime),
    })
    runtime.promptRegistered = typeof dispose === 'function' ? dispose : true
    return true
  } catch (error) {
    runtime.promptRegistered = false
    try { console.warn('[dsh-bioflow] prompt section unavailable:', error && error.message ? error.message : error) } catch { /* ignore */ }
    return false
  }
}

// ---------------------------------------------------------------------------
// Agent 工具
// ---------------------------------------------------------------------------

export function buildToolDefinition(hostRuntime) {
  return {
    name: 'bioflow',
    description:
      'Bioflow 统一分析入口（本机 Host 插件）：把「找数据 → 下载/登记 → 计划（统计闸门）→ 不可变 run → 交付物/取证」串成一条流水线。' +
      '数据源：GEO（geobulk 引擎优先）、PubMed、GDC/TCGA、MetaboLights、CELLxGENE（默认关闭；很慢，显式开启）。' +
      'action: status=工作台/插件/数据源状态; templates=模板与高级方法; search=多源检索（term，sources 默认 ["geo","pubmed","gdc","metabolights"]，每源独立失败，返回 sources_ok/sources_failed 与 provenance）; source_detail=单条记录详情（GDC 会带 STAR counts 文件+临床字段）; health=五源健康灯+插件协议检查; ' +
      'download=统一下载（source+id，断点/限流/md5-sha256/同 hash 复用，落 artifact 表）; register=登记本地文件或 artifact 链（path/artifact_ids/sample_sheet/samples/scale/verified；自动探测矩阵方向 transpose）；ask/query=自然语言许愿→draft 计划（不直接执行，缺字段给最少问题与候选，带 confirm_token）；' + '六个模板把六个工作台都接进来：bulk-two-group / scrna-composition / spatial-domain / metabolomics-de / virtualcell-perturb（产物一律 model_prediction）/ plotlab-figure（纯出图，不受推断闸门限制）；' +
      'plan=结构化计划（跑闸门：样本表未知/counts 未验证/每组独立 n<2/设计完全混杂/contrast 未定义→status=blocked；零显著会正常放行）; submit=提交（必须带 plan 返回的 confirm_token；wait=true 等执行完）; runs/run_status/cancel=队列与运行监控; export=结果包+稳定 content_hash+哈希校验; evidence=证据索引/写 claim（claim+table_id+row_id+figure_id+pmids）/verify=true 校验引用（model_prediction 单独标记）; methods=methods.md; ' +
      'harmonize=多数据集特征对齐+批次评估+显式批次校正（method 必填）; joint=联合分析（mode=meta 多队列 fixed/random、plot 统一走 plotlab、signature 跨模态签名→scRNA，model_prediction）; settings=读写默认输出/下载目录（output_dir/download_dir）; delete=删除历史（target=run 默认移入 trash/runs，purge=true 彻底删；dataset 需先删引用或 force；export 删导出记录，用户原始文件不删）; audit=确定性自检; suggest=下一步。' +
      '返回的 manifest/design.tsv/results/figures/evidence 都在 run 目录里，绝对路径可直接读；图默认 PNG 300dpi，图内文字英文。',
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: '要执行的操作' },
      dataset: { type: 'string', description: '数据集 id（ds_xxx）或 GSE 等提示' },
      dataset_id: { type: 'string', description: '数据集 id（等价 dataset）' },
      dataset_ids: { type: 'array', items: { type: 'string' }, description: 'harmonize 的多个数据集 id' },
      template: { type: 'string', description: '模板 id（见 action=templates）：bulk-two-group（bulk 差异+富集）/ scrna-composition（单细胞组成+pseudobulk）/ spatial-domain（空间域）/ metabolomics-de（代谢差异）/ virtualcell-perturb（虚拟扰动，model_prediction）/ plotlab-figure（纯出图）' },
      need: { type: 'string', description: 'action=ask 的一句话需求（中文/英文均可）' },
      query: { type: 'string', description: 'action=ask 的许愿文本（等价 need）；search 用 term' },
      gene: { type: 'string', description: 'virtualcell-perturb 的扰动基因（留空自动选 hub TF）' },
      strength: { type: 'number', description: 'virtualcell 扰动强度（默认 1.0）' },
      n_hvg: { type: 'number', description: 'singlecell/spatial/virtualcell 高变基因数' },
      n_domains: { type: 'number', description: 'spatial-domain 的空间域数量' },
      n_svg: { type: 'number', description: 'spatial-domain 的空间高变基因数' },
      chart_params: { type: 'object', additionalProperties: true, description: 'plotlab-figure 的 chart 参数' },
      style: { type: 'object', additionalProperties: true, description: 'plotlab 样式：palette/font/title_size/colors…' },
      roles: { type: 'object', additionalProperties: true, description: 'plotlab 列角色 {x,y,group,color,size,facet}' },
      data_kind: { type: 'string', description: 'register 时显式指定数据模态：bulk/scrna/spatial/metabolomics' },
      term: { type: 'string', description: 'action=search 的检索词（关键词 / GSE / TCGA 项目号 / MTBLS）' },
      sources: { type: 'array', items: { type: 'string' }, description: 'action=search/health 的数据源；默认 ["geo","pubmed","gdc","metabolights"]；cellxgene 需显式开启（30–60s）' },
      limit: { type: 'number', description: '每源返回条数（默认 20）' },
      page: { type: 'number', description: '分页（从 0 开始）' },
      species: { type: 'string', description: '物种过滤：human/mouse/all' },
      include_abstracts: { type: 'boolean', description: 'PubMed 是否取摘要（多一次 efetch）' },
      europepmc: { type: 'boolean', description: '是否额外查 Europe PMC（默认关，本机 8s 超时）' },
      source: { type: 'string', description: 'download/source_detail 的数据源：geo/gdc/metabolights/cellxgene' },
      id: { type: 'string', description: 'download/source_detail 的记录 id（GSE…/TCGA-…/MTBLS…/dataset_id）' },
      dest_dir: { type: 'string', description: '下载目录（默认 ~/.dsh/bioflow/downloads/<source>-<id>）' },
      path: { type: 'string', description: 'action=register 的本地文件/目录绝对路径' },
      artifact_ids: { type: 'array', items: { type: 'string' }, description: 'action=register 用 download 产出的 artifact_id 链式登记' },
      sample_sheet: { type: 'string', description: '样本信息表绝对路径（csv/tsv；自动识别 sample/group/donor/batch/pair 别名）' },
      samples: { type: 'array', items: { type: 'object' }, description: '内联样本表 [{sample_id,group,donor_id,batch,pair_id}]（也接受 JSON 字符串）' },
      scale: { type: 'string', description: '数据尺度：counts/tpm/log_expression/microarray/unknown' },
      verified: { type: 'boolean', description: '是否已验证尺度（未验证时推断步骤会被闸门拦下）' },
      assay: { type: 'string', description: 'assay：rna-seq/microarray/scrna/spatial/metabolomics' },
      group_column: { type: 'string', description: '分组列名' },
      donor_column: { type: 'string', description: '供体/患者列名' },
      batch_column: { type: 'string', description: '批次列名' },
      pair_column: { type: 'string', description: '配对 ID 列名' },
      paired: { type: 'boolean', description: '配对设计' },
      case: { type: 'string', description: 'contrast 的实验组' },
      control: { type: 'string', description: 'contrast 的对照组' },
      contrast: { type: 'object', additionalProperties: true, description: '{case,control}；logFC = case - control' },
      covariates: { type: 'array', items: { type: 'string' }, description: '协变量列名' },
      params: { type: 'object', additionalProperties: true, description: '模板/高级方法参数（method/min_cells/seed/alpha/target_scale 等）' },
      plan_id: { type: 'string', description: 'submit/export 用的计划 id' },
      confirm_token: { type: 'string', description: 'submit 必填：plan/ask 返回的确认令牌（用户确认后原样传回）' },
      run_id: { type: 'string', description: 'run_status/cancel/export/evidence/methods 的 run id' },
      wait: { type: 'boolean', description: 'submit 是否等待执行完成（CLI 默认 true；Agent 默认 false）' },
      out_path: { type: 'string', description: 'action=export 的结果包输出目录' },
      mode: { type: 'string', enum: ['meta', 'plot', 'signature', 'knockout', 'knockdown', 'overexpression'], description: 'joint 模式（meta/plot/signature）或 virtualcell 扰动方式（knockout/knockdown/overexpression）' },
      cohorts: { type: 'array', items: { type: 'object' }, description: 'meta 队列：[{run_id, table_id?, label?}]' },
      runs: { type: 'array', items: { type: 'object' }, description: 'plot 输入：[{run_id, table_id?}]' },
      method: { type: 'string', description: 'harmonize 的批次方法（none/scale_only/quantile/combat，必填）' },
      target_scale: { type: 'string', description: 'harmonize 目标尺度（counts/tpm/log_expression/zscore/none）' },
      chart: { type: 'string', description: 'joint plot 的 chart（plotlab 图表 id，默认 box）' },
      evidence_kind: { type: 'string', description: 'evidence 过滤/写入的证据类型：measured/descriptive/model_prediction' },
      table_id: { type: 'string', description: 'evidence 过滤/绑定的表 id' },
      claim: { type: 'string', description: 'action=evidence 写模式：一条可回查的 claim（必须绑定 table_id 或 figure_id）' },
      pmids: { type: 'array', items: { type: 'string' }, description: 'action=evidence 写模式：该 claim 引用的 PMID 列表' },
      figure_id: { type: 'string', description: 'evidence 绑定的图 id（fig_xxx）' },
      row_id: { type: 'number', description: 'evidence 绑定的行号（1-based，对应 results/*.tsv 的 row_id）' },
      contrast_id: { type: 'string', description: 'evidence 过滤/绑定的对比 id（如 tumor_vs_normal）' },
      verify: { type: 'boolean', description: 'action=evidence 校验模式：逐条核对 run/table/row/figure 引用' },
      limit_rows: { type: 'number', description: '预览行数' },
      target: { type: 'string', enum: ['run', 'dataset', 'export'], description: 'action=delete 的删除对象' },
      advise_need: { type: 'string', description: 'action=advise 的一句话问题/需求（也接受 need/query）；返回推荐数据集、文献线索、推荐方案与下一步' },
      disease: { type: 'string', description: 'action=topics 的疾病/场景（如 胃癌肝转移）；返回候选临床问题与近两年综述热点' },
      trash_op: { type: 'string', enum: ['list', 'restore', 'purge', 'empty'], description: 'action=trash 的子操作：list 列回收站 / restore 恢复 / purge 彻底删除 / empty 清空' },
      purge: { type: 'boolean', description: 'delete run 时 true=彻底删除（默认移入 trash/runs）' },
      force: { type: 'boolean', description: 'delete dataset 时允许删除仍被 run 引用的数据集记录' },
      register_dataset: { type: 'boolean', description: 'harmonize 后是否把合并矩阵登记成数据集（默认 true；登记后可直接 plan 继续跑）' },
      output_dir: { type: 'string', description: 'action=settings：默认导出目录（export 未给 out_path 时用）；传空字符串清除' },
      download_dir: { type: 'string', description: 'action=settings：默认下载目录' },
      export_id: { type: 'string', description: 'action=export 回查 / action=delete 删除导出记录' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const text = value && typeof value.summary === 'string' ? value.summary : JSON.stringify(value)
        const blocked = value && Array.isArray(value.blocking) && value.blocking.length
          ? '\n闸门：' + value.blocking.map((gate) => `${gate.id}: ${gate.detail}`).join('；')
          : ''
        return [{ type: 'text', text: String(text) + blocked }]
      },
    },
    execute: async (args) => {
      const fresh = await import(new URL(`./impl.mjs?rev=${Date.now()}-${Math.random().toString(36).slice(2)}`, import.meta.url).href)
      return fresh.runTool(hostRuntime, args || {})
    },
  }
}

export function ensureToolRegistered(runtime) {
  if (runtime.toolRegistered) return runtime.toolRegistered
  try {
    const ctx = runtime.ctx
    const tools = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : ctx && ctx.tools
    if (!tools || typeof tools.register !== 'function') { runtime.toolRegistered = false; return false }
    const dispose = tools.register(buildToolDefinition(runtime))
    runtime.toolRegistered = typeof dispose === 'function' ? dispose : true
    return true
  } catch (error) {
    runtime.toolRegistered = false
    try { console.warn('[dsh-bioflow] agent tool unavailable:', error && error.message ? error.message : error) } catch { /* ignore */ }
    return false
  }
}
