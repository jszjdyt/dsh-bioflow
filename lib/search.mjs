/**
 * dsh-bioflow — 检索编排 + 统一下载（供 tool / UI / CLI 共用）
 *
 * 职责：
 *   - 调 sources.mjs / pubmed.mjs 做多源检索，合并成一份带 provenance 的结果并落 search 记录；
 *   - 把 search/detail 的结果转成 download 任务（GDC counts 文件、CELLxGENE h5ad、GEO/MetaboLights 走插件引擎）；
 *   - 下载落 artifact 表（内容寻址 sha256），后续 register/plan 只引用 artifact_id；
 *   - 提供 dataset 文件冻结校验（submit 前重算 sha256，防止文件被换掉）。
 */

import path from 'node:path'
import { existsSync } from 'node:fs'
import {
  atomicWriteJson, ensureDir, fileSize, nowIso, safeName, sha256File, sha256Json, stableStringify,
} from './store.mjs'
import { SOURCE_IDS, DEFAULT_SEARCH_SOURCES } from './sources.mjs'

function searchError(code, message, details = {}) {
  const error = Object.assign(new Error(message), { code })
  error.details = details
  return error
}

/**
 * 多源检索 → 统一结果 + search_id。每个源独立失败，整体不因单源失败而失败。
 */
export async function performSearch({
  store,
  sourcesClient,
  pubmedClient = null,
  term,
  sources = DEFAULT_SEARCH_SOURCES,
  limit = 20,
  page = 0,
  species = 'all',
  includeAbstracts = false,
  hasClinical = false,
  europepmc = false,
  save = true,
} = {}) {
  if (!sourcesClient) throw searchError('unsupported', '检索客户端未初始化')
  const result = await sourcesClient.search({
    term, sources, limit, page, species, includeAbstracts, has_clinical: hasClinical,
  })
  const warnings = [...(result.warnings || [])]
  const provenance = [...(result.provenance || [])]
  if (europepmc && pubmedClient && typeof pubmedClient.searchEuropePmc === 'function') {
    const epmc = await pubmedClient.searchEuropePmc({ term, limit, page })
    if (epmc.error) {
      result.sources_failed.push({ source: 'europepmc', ...epmc.error })
      warnings.push(...(epmc.warnings || []))
    } else {
      result.results.europepmc = epmc
      result.by_source.europepmc = { total: epmc.total, fetched: epmc.fetched, via: epmc.via, cached: Boolean(epmc.cached), warnings: [] }
      result.sources_ok.push('europepmc')
      provenance.push(epmc.provenance)
    }
  }
  result.warnings = [...new Set(warnings)]
  result.provenance = provenance
  if (!save || !store) return result
  const searchId = `srch_${sha256Json({ term, sources: result.sources, limit, page, species, at: nowIso() }).slice(0, 12)}`
  const record = {
    schema_version: 1,
    search_id: searchId,
    created_at: nowIso(),
    query: result.query,
    sources: result.sources,
    sources_ok: result.sources_ok,
    sources_failed: result.sources_failed,
    by_source: result.by_source,
    warnings: result.warnings,
    provenance: result.provenance,
    // 全量 items 落盘（一个 source 一个文件，避免单条记录过大）
    result_files: [],
  }
  const dir = path.join(store.dirs.searches, searchId)
  ensureDir(dir)
  for (const [source, sourceResult] of Object.entries(result.results || {})) {
    const relative = `${source}.json`
    atomicWriteJson(path.join(dir, relative), {
      source,
      total: sourceResult.total,
      fetched: sourceResult.fetched,
      via: sourceResult.via || null,
      warnings: sourceResult.warnings || [],
      provenance: sourceResult.provenance || null,
      items: sourceResult.items || [],
    })
    record.result_files.push({ source, file: path.join(dir, relative) })
  }
  store.putSearch(record)
  return { ...result, search_id: searchId, saved: { search_id: searchId, dir } }
}

/** 取回一次检索的完整结果（重启后可用）。 */
export function loadSearchResults(store, searchId) {
  const record = store.getSearch(searchId)
  if (!record) throw searchError('not_found', `search 记录不存在：${searchId}`)
  const results = {}
  const { readJsonIfExists } = requireStore()
  for (const file of record.result_files || []) {
    const payload = readJsonIfExists(file.file)
    if (payload) results[payload.source] = payload
  }
  return { record, results }
}

function requireStore() {
  // 避免顶层循环：这里只用到一个小工具
  return { readJsonIfExists: (file) => {
    try { return JSON.parse(require('node:fs').readFileSync(file, 'utf8')) } catch { return null }
  } }
}

/**
 * 把「源 + id」解析成下载任务列表。
 * 返回 {tasks, source, id, item, note}。下载任务 = {url, filename, expected, headers, plugin?}
 */
export async function resolveDownloadTasks({ source, id, sourcesClient, pluginDownload = null, destDir, files = null, includeClinical = true } = {}) {
  if (!source || !id) throw searchError('bad_request', 'download 需要 source 与 id（如 {source:"gdc", id:"TCGA-LUAD"}）')
  const sourceId = String(source).toLowerCase()
  if (!SOURCE_IDS.includes(sourceId)) throw searchError('unsupported', `未知数据源 ${source}（可用：${SOURCE_IDS.join('、')}）`)

  if (sourceId === 'geo') {
    if (typeof pluginDownload !== 'function') {
      throw searchError('unsupported', 'GEO 下载需要 geobulk 插件引擎（geo_download）；插件不可用时请手动下载后用 action=register', { source: 'geo', id })
    }
    return { source: sourceId, id, mode: 'plugin', plugin: 'geobulk', action: 'download', params: { gse: String(id).toUpperCase(), destDir }, note: '由 geobulk 引擎 geo_download 处理（断点/限流/哈希由插件负责，bioflow 之后复核 sha256）' }
  }
  if (sourceId === 'metabolights') {
    if (typeof pluginDownload === 'function') {
      return { source: sourceId, id, mode: 'plugin', plugin: 'metabolomics', action: 'ml_download', params: { accession: String(id).toUpperCase(), destDir }, note: '优先由 metabolomics 引擎 ml_download 处理' }
    }
    const detail = await sourcesClient.detail({ source: sourceId, id, includeClinical: false })
    const item = (detail.items || [])[0]
    const attachments = (item && item.attachments) || []
    if (!attachments.length) throw searchError('not_found', `MetaboLights ${id} 没有可下载文件（插件不可用且 REST 文件清单为空）`)
    return {
      source: sourceId, id, mode: 'http',
      tasks: attachments.map((file) => ({ url: file.url, filename: safeName(file.name || path.basename(new URL(file.url).pathname)), expected: {}, headers: {} })),
      note: 'metabolomics 插件不可用，回退 MetaboLights REST 文件 URL',
    }
  }
  if (sourceId === 'gdc') {
    const detail = await sourcesClient.detail({ source: sourceId, id, includeClinical })
    const item = (detail.items || [])[0]
    if (!item) throw searchError('not_found', `GDC ${id} 没有详情`)
    let attachments = item.attachments || []
    if (Array.isArray(files) && files.length) {
      const wanted = new Set(files.map(String))
      attachments = attachments.filter((file) => wanted.has(file.name) || wanted.has(file.file_id))
    }
    if (!attachments.length) throw searchError('not_found', `GDC ${id} 没有匹配的 STAR counts 文件`)
    return {
      source: sourceId, id, mode: 'http', item,
      tasks: attachments.map((file) => ({
        url: file.url,
        filename: safeName(file.name || `${file.file_id}.tsv`),
        expected: { md5: file.md5, bytes: file.bytes },
        headers: {},
        meta: {
          case_submitter_id: file.case_submitter_id, sample_type: file.sample_type,
          data_type: file.data_type, workflow: file.workflow, file_id: file.file_id,
        },
      })),
      clinical: item.metadata && item.metadata.clinical ? item.metadata.clinical : null,
      note: 'GDC /data/<file_id> 下载；按 case+sample_type 去重（同 case 多 aliquot 只取一个文件）',
    }
  }
  if (sourceId === 'cellxgene') {
    const detail = await sourcesClient.detail({ source: sourceId, id })
    const item = (detail.items || [])[0]
    const datasetIds = (item && item.metadata && item.metadata.dataset_ids) || []
    const target = datasetIds[0] || (Array.isArray(files) ? String(files[0]) : null)
    if (!target) throw searchError('not_found', `CELLxGENE ${id} 没有 dataset_id，无法定位 h5ad`)
    const probe = await sourcesClient.probeCellxgeneH5ad({ datasetId: target })
    if (!probe.available) {
      return {
        source: sourceId, id, mode: 'unavailable', tasks: [],
        error: {
          code: 'source_unavailable',
          reason: probe.reason,
          message: probe.suggestion || 'CELLxGENE h5ad 主机本机不可达',
          probe,
        },
      }
    }
    return {
      source: sourceId, id, mode: 'http',
      tasks: [{ url: probe.url, filename: `${target}.h5ad`, expected: {}, headers: {} }],
      note: 'CELLxGENE h5ad 直链',
    }
  }
  throw searchError('unsupported', `数据源 ${source} 不支持下载（PubMed 是文献库）`)
}

/**
 * 执行下载：
 *   - plugin 模式：调用插件引擎下载，然后扫描 destDir 新文件做 sha256 并登记 artifact；
 *   - http 模式：走 download.mjs（断点/限流/md5/sha256 校验）。
 * 返回 {source, id, downloads:[meta], artifacts:[...], reused:boolean}
 */
export async function executeDownload({
  store,
  downloader,
  sourcesClient,
  source,
  id,
  destDir,
  files = null,
  pluginDownload = null,
  includeClinical = true,
  signal = null,
  onProgress = null,
} = {}) {
  const resolved = await resolveDownloadTasks({ source, id, sourcesClient, pluginDownload, destDir, files, includeClinical })
  if (resolved.mode === 'unavailable') {
    return { ok: false, source: resolved.source, id: resolved.id, downloads: [], artifacts: [], error: resolved.error }
  }
  const downloads = []
  const artifacts = []
  if (resolved.mode === 'plugin') {
    const before = new Set(listFilesRecursive(destDir))
    const result = await pluginDownload(resolved.plugin, resolved.action, resolved.params, { signal })
    const after = listFilesRecursive(destDir)
    const newFiles = after.filter((file) => !before.has(file))
    const candidates = newFiles.length ? newFiles : after
    for (const file of candidates) {
      const sha256 = await sha256File(file)
      const meta = {
        name: path.basename(file), path: file, bytes: fileSize(file), sha256,
        md5: null, etag: null, source: resolved.source, source_id: resolved.id,
        plugin: resolved.plugin, downloaded_at: nowIso(),
      }
      downloads.push({ ...meta, reused: false })
      artifacts.push(registerDownloadedArtifact(store, meta))
    }
    return {
      ok: true, source: resolved.source, id: resolved.id, mode: 'plugin',
      engine_result: summarizeEngineResult(result), downloads, artifacts,
      note: resolved.note,
      reused: downloads.length > 0 && newFiles.length === 0,
    }
  }
  ensureDir(destDir)
  for (const task of resolved.tasks) {
    const destPath = path.join(destDir, task.filename)
    if (signal && signal.aborted) throw searchError('cancelled', '下载已取消')
    const meta = await downloader.download({
      url: task.url, destPath, expected: task.expected || {}, signal,
      onProgress: onProgress ? (progress) => onProgress({ ...progress, file: task.filename, url: task.url }) : null,
      headers: task.headers || {},
    })
    const record = {
      ...meta,
      name: path.basename(destPath), path: destPath,
      source: resolved.source, source_id: resolved.id,
      data_meta: task.meta || null,
      clinical: resolved.clinical || null,
    }
    downloads.push(record)
    artifacts.push(registerDownloadedArtifact(store, record))
  }
  const allReused = downloads.length > 0 && downloads.every((item) => item.reused)
  return {
    ok: true, source: resolved.source, id: resolved.id, mode: 'http',
    downloads, artifacts, note: resolved.note, reused: allReused,
    clinical: resolved.clinical || null,
  }
}

function registerDownloadedArtifact(store, meta) {
  if (!store) return { artifact_id: meta.sha256, sha256: meta.sha256, path: meta.path, bytes: meta.bytes, name: meta.name }
  const { artifact, reused } = store.putArtifact({
    artifact_id: meta.sha256,
    sha256: meta.sha256,
    md5: meta.md5 || null,
    bytes: meta.bytes,
    name: meta.name,
    path: meta.path,
    kind: 'download',
    source: meta.source || null,
    url: meta.url || null,
    etag: meta.etag || null,
    meta: meta.data_meta || null,
  })
  return { artifact_id: artifact.artifact_id, sha256: artifact.sha256, path: artifact.path, bytes: artifact.bytes, name: artifact.name, reused: Boolean(reused) || Boolean(meta.reused) }
}

function listFilesRecursive(dir) {
  const out = []
  const walk = (current) => {
    if (!existsSync(current)) return
    const fs = require('node:fs')
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  walk(dir)
  return out.sort()
}

function summarizeEngineResult(result) {
  if (!result || typeof result !== 'object') return null
  const summary = {}
  for (const key of ['ok', 'job', 'files', 'downloaded', 'total_bytes', 'dest_dir', 'warnings']) {
    if (result[key] !== undefined) summary[key] = result[key]
  }
  return summary
}

/**
 * submit 前校验数据冻结：manifest 里的每个文件 sha256 必须与磁盘一致。
 * 返回 {ok, checked, mismatches, missing}。
 */
export async function verifyDatasetFiles(dataset) {
  const mismatches = []
  const missing = []
  let checked = 0
  for (const file of dataset.files || []) {
    const filePath = file.path
    if (!filePath || !existsSync(filePath)) { missing.push({ name: file.name, path: filePath }); continue }
    const actual = await sha256File(filePath)
    checked += 1
    if (actual !== file.sha256) mismatches.push({ name: file.name, path: filePath, expected: file.sha256, actual })
  }
  for (const artifactId of dataset.artifact_ids || []) {
    // 预留：直接按 artifact_id 引用时，用 store 查路径（由 impl 传入 dataset.artifact_paths）
    void artifactId
  }
  return { ok: mismatches.length === 0 && missing.length === 0, checked, mismatches, missing }
}

export function searchRecordSummary(record) {
  return {
    search_id: record.search_id,
    created_at: record.created_at,
    term: record.query && record.query.term,
    sources: record.sources,
    sources_ok: record.sources_ok,
    sources_failed: record.sources_failed,
    by_source: record.by_source,
  }
}
