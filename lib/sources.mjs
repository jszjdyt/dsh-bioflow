/**
 * dsh-bioflow — 公共数据库统一检索层
 *
 * 已实测事实（任务单/lead 复测）：
 *   - GEO: 走 geobulk 引擎 geo_search；插件不可用时内置 NCBI E-utilities 直连回退。
 *   - PubMed: lib/pubmed.mjs（E-utilities + 缓存 + 限速）。
 *   - GDC/TCGA: https://api.gdc.cancer.gov 可用（本机 3.2s）→ 内置客户端，projects/files/cases。
 *   - MetaboLights: /ws/studies 可用但慢（本机 7.6s）→ 优先 metabolomics 插件引擎，回退内置 REST，超时 ≥20s。
 *   - CELLxGENE: curation API 很慢（本机 30s，200）；默认关闭，显式开启时超时 60s；
 *     h5ad 直链主机 datasets.cellxgene.cziscience.com 本机不可达 → 下载报 source_unavailable，不让整个请求失败。
 *
 * 统一 item schema（所有源）：
 *   source / id / title / species / n_samples / platform / scale / attachments /
 *   clinical_available / evidence_kind / evidence_strength / url / summary /
 *   metadata / provenance
 *
 * 每个源独立超时、独立失败；search 返回 sources_ok / sources_failed。
 * fetch 可注入（单测用 stub，不联网）；BIOFLOW_LIVE=1 才跑真实请求测试。
 */

import { nowIso, sha256Json, stableStringify } from './store.mjs'
import { TokenBucket, anySignal } from './download.mjs'
import { relaxQuery } from './pubmed.mjs'

export const SOURCE_IDS = ['geo', 'pubmed', 'gdc', 'metabolights', 'cellxgene']
export const DEFAULT_SEARCH_SOURCES = ['geo', 'pubmed', 'gdc', 'metabolights']
export const SOURCE_META = {
  geo: { label: 'GEO', timeout_ms: 30_000, slow_ms: 8_000, description: 'NCBI GEO 系列（GSE）' },
  pubmed: { label: 'PubMed', timeout_ms: 20_000, slow_ms: 6_000, description: 'NCBI PubMed 文献' },
  gdc: { label: 'GDC/TCGA', timeout_ms: 20_000, slow_ms: 8_000, description: 'GDC projects / STAR counts / 临床随访' },
  metabolights: { label: 'MetaboLights', timeout_ms: 25_000, slow_ms: 12_000, description: 'EBI MetaboLights 代谢组研究' },
  cellxgene: { label: 'CELLxGENE', timeout_ms: 60_000, slow_ms: 15_000, description: 'CELLxGENE Discover（预计 30–60s，默认关闭）' },
}

export const GDC_BASE = 'https://api.gdc.cancer.gov'
export const METABOLIGHTS_BASE = 'https://www.ebi.ac.uk/metabolights/ws'
export const CELLXGENE_BASE = 'https://api.cellxgene.cziscience.com/curation/v1'
export const CELLXGENE_H5AD_HOST = 'https://datasets.cellxgene.cziscience.com'
export const EUtils_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
export const GDC_STAR_WORKFLOW = 'STAR - Counts'
export const GDC_COUNTS_DATA_TYPE = 'Gene Expression Quantification'

function sourceError(code, message, details = {}) {
  const error = Object.assign(new Error(message), { code })
  error.details = details
  return error
}

function isAbort(error) {
  return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR' || /abort/i.test(String(error.message || ''))))
}

/** 统一 item（缺失字段显式 null，绝不留 undefined）。 */
export function unifiedItem(source, partial = {}) {
  const attachments = Array.isArray(partial.attachments) ? partial.attachments : []
  const clinicalAvailable = partial.clinical_available === undefined
    ? attachments.some((file) => /clinical|survival|follow/i.test(String(file.type || file.name || '')))
    : Boolean(partial.clinical_available)
  const hasMatrix = attachments.some((file) => /matrix|counts|h5ad|expression|archive/i.test(String(file.type || file.name || '')))
  let strength = partial.evidence_strength
  if (!strength) strength = clinicalAvailable && hasMatrix ? 'matrix+clinical' : hasMatrix ? 'matrix' : 'metadata'
  return {
    source,
    id: String(partial.id || ''),
    title: partial.title ? String(partial.title) : null,
    summary: partial.summary ? String(partial.summary).slice(0, 2000) : null,
    species: partial.species ? String(partial.species) : null,
    n_samples: Number.isFinite(Number(partial.n_samples)) ? Number(partial.n_samples) : null,
    platform: partial.platform ? String(partial.platform) : null,
    scale: partial.scale ? String(partial.scale) : null,
    attachments,
    clinical_available: clinicalAvailable,
    evidence_kind: partial.evidence_kind || 'dataset_record',
    evidence_strength: strength,
    url: partial.url || null,
    metadata: partial.metadata && typeof partial.metadata === 'object' ? partial.metadata : {},
    provenance: partial.provenance || null,
  }
}

function provenance(source, request, extra = {}) {
  const originalQuery = request.term || request.id || null
  const actualQuery = extra.actual_query || originalQuery
  return {
    source,
    db: source,
    // 任务书字段名（与 pubmed.mjs buildProvenance 对齐）：原始 query / 实际 query / 库 / 取回条数
    query: originalQuery,
    effective_query: actualQuery,
    library: source,
    retrieved: extra.fetched || 0,
    original_query: originalQuery,
    actual_query: actualQuery,
    at: nowIso(),
    total: extra.total || 0,
    fetched: extra.fetched || 0,
    page: request.page || 0,
    page_size: request.limit || 20,
    relaxed: Boolean(extra.relaxed),
    via: extra.via || 'builtin',
    cached: Boolean(extra.cached),
    url: extra.url || null,
    elapsed_ms: extra.elapsed_ms || 0,
    endpoint: extra.endpoint || null,
  }
}

function safeNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  return [value]
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function fetchWithTimeout(fetchImpl, url, { timeoutMs, signal = null, headers = {}, method = 'GET', body = undefined } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const merged = signal ? anySignal([signal, controller.signal]) : controller.signal
  const started = Date.now()
  try {
    const response = await fetchImpl(url, { method, headers: { accept: 'application/json, text/plain, */*', ...headers }, body, signal: merged, redirect: 'follow' })
    const text = await response.text()
    return { response, text, elapsedMs: Date.now() - started, url: response.url || url }
  } finally {
    clearTimeout(timer)
  }
}

function parseJson(text, source) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw sourceError('bad_response', `${SOURCE_META[source] ? SOURCE_META[source].label : source} 返回非 JSON：${String(text || '').slice(0, 160)}`)
  }
}

// ---------------------------------------------------------------------------
// GEO（插件优先，内置 E-utilities 回退）
// ---------------------------------------------------------------------------

function geoItemFromPlugin(item, request, extra) {
  const attachments = []
  if (item.has_matrix !== false) {
    attachments.push({
      name: `${item.gse || item.id}_series_matrix.txt.gz`,
      type: 'matrix',
      host: 'ncbi-geo',
      url: item.gse ? `https://ftp.ncbi.nlm.nih.gov/geo/series/${String(item.gse).slice(0, -3)}nnn/${item.gse}/matrix/` : null,
      resolution: 'plugin_geo_download',
    })
  }
  if (item.has_clinical) attachments.push({ name: 'sample_metadata/clinical', type: 'clinical', host: 'ncbi-geo', resolution: 'plugin_geo_download' })
  return unifiedItem('geo', {
    id: item.gse || item.id,
    title: item.title,
    summary: item.summary,
    species: item.species,
    n_samples: item.n_samples,
    platform: item.platform,
    scale: item.scale || 'unknown',
    attachments,
    clinical_available: Boolean(item.has_clinical),
    evidence_kind: 'dataset_record',
    url: item.gse ? `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${item.gse}` : null,
    metadata: {
      gse: item.gse || item.id,
      study_type: item.study_type || null,
      release: item.release || null,
      disease: item.disease || null,
      tags: item.tags || [],
      has_matrix: item.has_matrix ?? null,
      has_clinical: item.has_clinical ?? null,
    },
    provenance: provenance('geo', request, {
      total: extra.total, fetched: extra.fetched, via: extra.via,
      actual_query: extra.actual_query, relaxed: extra.relaxed, elapsed_ms: extra.elapsed_ms, url: extra.url,
    }),
  })
}

async function eutilsJson(fetchImpl, bucket, path, params, { timeoutMs, signal, source }) {
  const url = new URL(`${EUtils_BASE}/${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  url.searchParams.set('tool', 'dsh-bioflow')
  if (process.env.NCBI_EMAIL) url.searchParams.set('email', process.env.NCBI_EMAIL)
  if (process.env.NCBI_API_KEY) url.searchParams.set('api_key', process.env.NCBI_API_KEY)
  await bucket.acquire()
  const { text, response, elapsedMs } = await fetchWithTimeout(fetchImpl, url.toString(), { timeoutMs, signal })
  if (!response.ok) throw sourceError('http_error', `NCBI HTTP ${response.status}`, { status: response.status, body: text.slice(0, 300) })
  let payload
  try { payload = JSON.parse(text) } catch { throw sourceError('bad_response', `NCBI 返回非 JSON：${text.slice(0, 160)}`) }
  return { payload, url: url.toString(), elapsedMs }
}

function geoItemFromGds(record, request, extra) {
  const accession = String(record.accession || record.gse || '')
  const nSamples = safeNumber(record.n_samples) || (Array.isArray(record.samples) ? record.samples.length : null)
  const platform = asArray(record.gpl).join(', ') || null
  return unifiedItem('geo', {
    id: accession || `GDS${record.uid || ''}`,
    title: record.title,
    summary: record.summary,
    species: record.taxon || null,
    n_samples: nSamples,
    platform,
    scale: 'unknown',
    attachments: nSamples
      ? [{ name: `${accession}_series_matrix`, type: 'matrix', host: 'ncbi-geo', url: null, resolution: 'plugin_geo_download' }]
      : [],
    clinical_available: null,
    metadata: {
      gse: accession,
      gds_type: record.gdstype || null,
      release: record.pdat || null,
      pubmedids: asArray(record.pubmedids).map(String),
      ftplink: record.ftplink || null,
      suppfile: record.suppfile || null,
    },
    url: accession ? `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${accession}` : null,
    provenance: provenance('geo', request, extra),
  })
}

async function searchGeoDirect({ fetchImpl, bucket, term, limit, page, species = 'all', timeoutMs, signal, request }) {
  const started = Date.now()
  const base = String(term || '').trim()
  const queryParts = [base]
  if (species && species !== 'all') queryParts.push(`"${species}"[Organism]`)
  let query = queryParts.join(' AND ')
  const searched = await eutilsJson(fetchImpl, bucket, 'esearch.fcgi', {
    db: 'gds', term: query, retmax: limit, retstart: page * limit, retmode: 'json',
  }, { timeoutMs, signal, source: 'geo' })
  let ids = (searched.payload.esearchresult && searched.payload.esearchresult.idlist) || []
  let total = Number((searched.payload.esearchresult && searched.payload.esearchresult.count) || 0)
  let actualQuery = searched.payload.esearchresult && searched.payload.esearchresult.querytranslation || query
  let relaxed = false
  if (!ids.length && total === 0) {
    const relaxedQuery = relaxQuery(base)
    if (relaxedQuery) {
      const retry = await eutilsJson(fetchImpl, bucket, 'esearch.fcgi', {
        db: 'gds', term: relaxedQuery, retmax: limit, retstart: page * limit, retmode: 'json',
      }, { timeoutMs, signal, source: 'geo' })
      const retryIds = (retry.payload.esearchresult && retry.payload.esearchresult.idlist) || []
      if (retryIds.length) {
        ids = retryIds
        total = Number(retry.payload.esearchresult.count || retryIds.length)
        actualQuery = retry.payload.esearchresult.querytranslation || relaxedQuery
        relaxed = true
      }
    }
  }
  let records = []
  if (ids.length) {
    const summary = await eutilsJson(fetchImpl, bucket, 'esummary.fcgi', {
      db: 'gds', id: ids.join(','), retmode: 'json',
    }, { timeoutMs, signal, source: 'geo' })
    const result = summary.payload.result || {}
    records = (result.uids || ids).map((uid) => result[uid]).filter(Boolean)
  }
  const items = records.map((record) => geoItemFromGds(record, request, {
    total, fetched: records.length, via: 'ncbi-eutils-direct', actual_query: actualQuery, relaxed, elapsed_ms: Date.now() - started, url: searched.url,
  }))
  return {
    source: 'geo', total, fetched: items.length, page, items,
    via: 'ncbi-eutils-direct', warnings: [],
    provenance: provenance('geo', request, { total, fetched: items.length, via: 'ncbi-eutils-direct', actual_query: actualQuery, relaxed, elapsed_ms: Date.now() - started, url: searched.url }),
  }
}

// ---------------------------------------------------------------------------
// GDC / TCGA
// ---------------------------------------------------------------------------

function gdcFiltersProject(projectId) {
  return JSON.stringify({ op: 'and', content: [{ op: 'in', content: { field: 'projects.project_id', value: [projectId] } }] })
}

export function tcgaBarcodeParts(submitterId) {
  const parts = String(submitterId || '').split('-')
  return {
    project: parts[0] ? `${parts[0]}-${parts[1] || ''}` : null,
    tss: parts[1] || null,
    participant: parts[2] || null,
    sample: parts[3] || null,
    portion: parts[4] || null,
    analyte: parts[5] || null,
    plate: parts[6] || null,
    center: parts[7] || null,
    case_submitter_id: parts.length >= 3 ? parts.slice(0, 3).join('-') : String(submitterId || ''),
  }
}

/** 同 case 多 aliquot → 每个 (case, sample_type) 只保留一个文件（按 file_id 排序取最小，确定性）。 */
export function dedupeGdcFiles(files) {
  const groups = new Map()
  for (const file of files) {
    const cases = asArray(file.cases)
    const caseEntry = cases[0] || {}
    const samples = asArray(caseEntry.samples)
    const sampleType = samples[0] && samples[0].sample_type ? String(samples[0].sample_type) : 'unknown'
    const caseId = caseEntry.submitter_id || caseEntry.case_id || file.case_submitter_id || 'unknown'
    const key = `${caseId}::${sampleType}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ file, caseId, caseEntry, samples, sampleType })
  }
  const kept = []
  const dropped = []
  for (const [key, list] of groups) {
    list.sort((a, b) => String(a.file.file_id).localeCompare(String(b.file.file_id)))
    kept.push({ ...list[0], key, n_aliquots: list.length })
    for (const extra of list.slice(1)) dropped.push(extra)
  }
  return { kept, dropped, cases: new Set(kept.map((item) => item.caseId)).size }
}

function gdcFileAttachment(item, projectId) {
  const file = item.file
  return {
    name: file.file_name || `${file.file_id}.tsv`,
    type: 'matrix',
    host: 'gdc',
    url: `${GDC_BASE}/data/${file.file_id}`,
    file_id: file.file_id,
    md5: file.md5sum || null,
    bytes: safeNumber(file.file_size),
    project_id: projectId,
    case_submitter_id: item.caseId,
    sample_type: item.sampleType,
    workflow: (file.analysis && file.analysis.workflow_type) || null,
    data_type: file.data_type || null,
  }
}

async function gdcRequest(fetchImpl, pathname, params, { timeoutMs, signal, source = 'gdc' }) {
  const url = new URL(`${GDC_BASE}${pathname}`)
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  const { response, text, elapsedMs } = await fetchWithTimeout(fetchImpl, url.toString(), { timeoutMs, signal })
  if (!response.ok) throw sourceError('http_error', `GDC HTTP ${response.status}`, { status: response.status, body: text.slice(0, 300) })
  const payload = parseJson(text, 'gdc')
  if (payload && payload.error) throw sourceError('bad_response', `GDC 返回错误：${String(payload.error).slice(0, 200)}`)
  return { data: (payload && payload.data) || {}, pagination: (payload && payload.data && payload.data.pagination) || {}, url: url.toString(), elapsedMs }
}

const GDC_PROJECT_FIELDS = ['project_id', 'name', 'primary_site', 'disease_type', 'summary', 'program.name', 'dbgap_accession_number']
const GDC_FILE_FIELDS = ['file_id', 'file_name', 'md5sum', 'file_size', 'data_type', 'experimental_strategy',
  'analysis.workflow_type', 'cases.case_id', 'cases.submitter_id', 'cases.samples.sample_type', 'cases.samples.submitter_id']
const GDC_CASE_FIELDS = ['case_id', 'submitter_id', 'demographic.vital_status', 'demographic.days_to_death',
  'demographic.days_to_last_follow_up', 'demographic.gender', 'demographic.race', 'diagnoses.age_at_diagnosis',
  'diagnoses.tumor_stage', 'diagnoses.primary_diagnosis', 'samples.sample_type']

function gdcProjectItem(project) {
  return unifiedItem('gdc', {
    id: project.project_id,
    title: project.name || project.project_id,
    summary: project.summary,
    species: 'Homo sapiens',
    n_samples: null,
    platform: (project.program && project.program.name) || 'GDC',
    scale: 'star_counts',
    attachments: [],
    clinical_available: true,
    evidence_kind: 'dataset_record',
    url: `https://portal.gdc.cancer.gov/projects/${project.project_id}`,
    metadata: {
      project_id: project.project_id,
      primary_site: asArray(project.primary_site),
      disease_type: asArray(project.disease_type),
      dbgap_accession_number: project.dbgap_accession_number || null,
      workflow: GDC_STAR_WORKFLOW,
      detail_hint: 'search {detail:{source:"gdc", id:"<project_id>"}} 获取 counts 文件与临床字段',
    },
    provenance: null,
  })
}

async function searchGdc({ fetchImpl, term, limit, page, timeoutMs, signal, request }) {
  const started = Date.now()
  const text = String(term || '').trim()
  const projectMatch = text.match(/TCGA-[A-Z0-9]{2,6}/i)
  const { data, pagination, url } = await gdcRequest(fetchImpl, '/projects', {
    size: projectMatch ? 10 : 200,
    from: 0,
    fields: GDC_PROJECT_FIELDS.join(','),
    ...(projectMatch ? { filters: gdcFiltersProject(projectMatch[0].toUpperCase()) } : {}),
  }, { timeoutMs, signal })
  let projects = asArray(data.hits)
  if (!projectMatch) {
    const needle = text.toLowerCase()
    projects = projects.filter((project) => {
      const haystack = [project.project_id, project.name, project.primary_site, project.disease_type, project.summary]
        .flat().join(' ').toLowerCase()
      return !needle || needle.split(/\s+/).filter(Boolean).every((token) => haystack.includes(token))
    })
  }
  const total = projectMatch ? projects.length : projects.length
  const start = page * limit
  const pageItems = projects.slice(start, start + limit)
  const items = pageItems.map((project) => gdcProjectItem(project))
  for (const item of items) {
    item.provenance = provenance('gdc', request, {
      total, fetched: items.length, via: 'gdc-api',
      actual_query: projectMatch ? projectMatch[0].toUpperCase() : text,
      elapsed_ms: Date.now() - started, url,
    })
  }
  return {
    source: 'gdc', total, fetched: items.length, page, items,
    via: 'gdc-api', warnings: projects.length > 200 ? ['GDC 项目数超过 200，只扫描了前 200 个'] : [],
    provenance: provenance('gdc', request, {
      total, fetched: items.length, via: 'gdc-api',
      actual_query: projectMatch ? projectMatch[0].toUpperCase() : text,
      elapsed_ms: Date.now() - started, url,
    }),
  }
}

async function gdcDetail({ fetchImpl, id, timeoutMs, signal, request, includeClinical = true }) {
  const projectId = String(id || '').trim().toUpperCase()
  if (!projectId) throw sourceError('bad_request', 'GDC detail 需要 project_id（如 TCGA-LUAD）')
  const started = Date.now()
  const filesResult = await gdcRequest(fetchImpl, '/files', {
    filters: JSON.stringify({
      op: 'and',
      content: [
        { op: 'in', content: { field: 'cases.project.project_id', value: [projectId] } },
        { op: 'in', content: { field: 'data_type', value: [GDC_COUNTS_DATA_TYPE] } },
        { op: 'in', content: { field: 'analysis.workflow_type', value: [GDC_STAR_WORKFLOW] } },
      ],
    }),
    size: 2000,
    fields: GDC_FILE_FIELDS.join(','),
    expand: 'cases,cases.samples',
  }, { timeoutMs, signal })
  const rawFiles = asArray(filesResult.data.hits)
  const deduped = dedupeGdcFiles(rawFiles)
  const attachments = deduped.kept.map((entry) => gdcFileAttachment(entry, projectId))
  const sampleTypes = [...new Set(deduped.kept.map((entry) => entry.sampleType))]
  let clinical = null
  if (includeClinical) {
    try {
      const casesResult = await gdcRequest(fetchImpl, '/cases', {
        filters: gdcFiltersProject(projectId),
        size: 2000,
        fields: GDC_CASE_FIELDS.join(','),
        expand: 'demographic,diagnoses,samples',
      }, { timeoutMs, signal })
      clinical = asArray(casesResult.data.hits).map((entry) => normalizeGdcCase(entry))
    } catch (error) {
      clinical = null
      // 临床失败不影响 counts 文件
      clinical = { error: String(error && error.message ? error.message : error) }
    }
  }
  const item = unifiedItem('gdc', {
    id: projectId,
    title: projectId,
    species: 'Homo sapiens',
    n_samples: deduped.cases,
    platform: `GDC / ${GDC_STAR_WORKFLOW}`,
    scale: 'star_counts',
    attachments,
    clinical_available: clinical && !Array.isArray(clinical) ? false : Boolean(clinical && clinical.length),
    evidence_kind: 'dataset_record',
    url: `https://portal.gdc.cancer.gov/projects/${projectId}`,
    metadata: {
      project_id: projectId,
      counts_files: rawFiles.length,
      deduped_files: attachments.length,
      dropped_duplicate_aliquots: deduped.dropped.length,
      sample_types: sampleTypes,
      n_cases: deduped.cases,
      workflow: GDC_STAR_WORKFLOW,
      clinical,
    },
    provenance: provenance('gdc', request, { total: attachments.length, fetched: attachments.length, via: 'gdc-api', elapsed_ms: Date.now() - started }),
  })
  return {
    source: 'gdc', total: 1, fetched: 1, page: 0, items: [item], via: 'gdc-api', warnings: [],
    provenance: item.provenance,
  }
}

export function normalizeGdcCase(entry) {
  const demographic = entry.demographic || {}
  const diagnoses = asArray(entry.diagnoses)[0] || {}
  const samples = asArray(entry.samples)
  const barcode = tcgaBarcodeParts(entry.submitter_id)
  const vitalStatus = demographic.vital_status || null
  const daysToDeath = safeNumber(demographic.days_to_death)
  const daysToFollowUp = safeNumber(demographic.days_to_last_follow_up)
  let osTime = null
  let osEvent = null
  if (vitalStatus) {
    osEvent = /dead|deceased/i.test(vitalStatus) ? 1 : 0
    osTime = osEvent === 1 ? daysToDeath : daysToFollowUp
  } else if (daysToDeath !== null || daysToFollowUp !== null) {
    osEvent = daysToDeath !== null ? 1 : 0
    osTime = daysToDeath !== null ? daysToDeath : daysToFollowUp
  }
  return {
    case_id: entry.case_id,
    case_submitter_id: entry.submitter_id || barcode.case_submitter_id,
    project_id: barcode.project,
    participant: barcode.participant,
    gender: demographic.gender || null,
    race: demographic.race || null,
    tumor_stage: diagnoses.tumor_stage || null,
    primary_diagnosis: diagnoses.primary_diagnosis || null,
    age_at_diagnosis_days: safeNumber(diagnoses.age_at_diagnosis),
    vital_status: vitalStatus,
    days_to_death: daysToDeath,
    days_to_last_follow_up: daysToFollowUp,
    os_time_days: osTime,
    os_event: osEvent,
    sample_types: samples.map((sample) => sample.sample_type).filter(Boolean),
  }
}

// ---------------------------------------------------------------------------
// MetaboLights
// ---------------------------------------------------------------------------

function mlItemFromObject(entry, request, extra = {}) {
  const id = entry.accession || entry.study_id || entry.id || entry.mtbls_id || ''
  const attachments = asArray(entry.files || entry.fileList || []).map((file) => {
    if (typeof file === 'string') return { name: file, type: 'supplementary', host: 'metabolights', url: `${METABOLIGHTS_BASE}/studies/${id}/files/${file}`, resolution: 'plugin_ml_download' }
    return {
      name: file.name || file.fileName || file.filename || 'file',
      type: /\.(mzml|mzxml|raw|cdf)$/i.test(String(file.name || file.fileName || '')) ? 'raw' : 'supplementary',
      host: 'metabolights',
      url: `${METABOLIGHTS_BASE}/studies/${id}/files/${file.name || file.fileName || ''}`,
      bytes: safeNumber(file.size || file.fileSize),
    }
  })
  const species = entry.organism || entry.species || entry.organisms || null
  const technique = entry.technique || entry.assay || entry.technology || entry.technology_platform || null
  const nSamples = safeNumber(entry.numSamples || entry.n_samples || entry.samples_count) || (Array.isArray(entry.samples) ? entry.samples.length : null)
  return unifiedItem('metabolights', {
    id,
    title: entry.title || entry.studyTitle || entry.name || id,
    summary: entry.description || entry.studyAbstract || entry.summary || null,
    species: Array.isArray(species) ? species.join(', ') : species,
    n_samples: nSamples,
    platform: technique,
    scale: 'metabolomics_profile',
    attachments,
    clinical_available: Boolean(entry.clinical || entry.hasClinical),
    evidence_kind: 'dataset_record',
    url: id ? `https://www.ebi.ac.uk/metabolights/${id}` : null,
    metadata: {
      accession: id,
      technique,
      public_release_date: entry.publicReleaseDate || entry.releaseDate || entry.public_release_date || null,
      submission_date: entry.submissionDate || null,
      study_status: entry.studyStatus || entry.status || null,
      _raw_keys: undefined,
    },
    provenance: provenance('metabolights', request, extra),
  })
}

async function mlRestStudies(fetchImpl, { term, limit, page, timeoutMs, signal }) {
  const attempts = []
  const tryUrls = [
    `${METABOLIGHTS_BASE}/studies/search?searchTerm=${encodeURIComponent(term)}&page=${page}&pageSize=${limit}`,
    `${METABOLIGHTS_BASE}/studies?searchTerm=${encodeURIComponent(term)}&page=${page}&pageSize=${limit}`,
    `${METABOLIGHTS_BASE}/studies?page=${page}&pageSize=${Math.max(limit, 100)}`,
  ]
  let lastError = null
  for (const url of tryUrls) {
    try {
      const { response, text, elapsedMs } = await fetchWithTimeout(fetchImpl, url, { timeoutMs, signal })
      attempts.push({ url, status: response.status, elapsed_ms: elapsedMs })
      if (!response.ok) continue
      const payload = JSON.parse(text)
      const content = payload.content || payload.studies || payload.data || payload
      const entries = Array.isArray(content) ? content : []
      const objects = entries.map((entry) => (typeof entry === 'string' ? { accession: entry } : entry))
      const needle = String(term || '').toLowerCase()
      const filtered = needle
        ? objects.filter((entry) => {
          const haystack = `${entry.accession || entry.id || ''} ${entry.title || entry.studyTitle || ''} ${entry.description || ''}`.toLowerCase()
          return needle.split(/\s+/).filter(Boolean).every((token) => haystack.includes(token))
        })
        : objects
      return { entries: filtered, total: Number(payload.total || payload.totalStudies || filtered.length), url, elapsedMs, attempts }
    } catch (error) {
      lastError = error
      attempts.push({ url, error: String(error && error.message ? error.message : error) })
    }
  }
  throw sourceError('source_unavailable', `MetaboLights 检索不可用：${lastError ? lastError.message : '所有候选端点都失败'}`, { attempts })
}

async function searchMetabolights({ fetchImpl, adapterProvider, term, limit, page, timeoutMs, signal, request }) {
  const started = Date.now()
  // 优先走 metabolomics 插件引擎（ml_search）
  if (adapterProvider) {
    try {
      const adapter = await adapterProvider('metabolomics')
      if (adapter) {
        const result = await adapter.invoke('ml_search', { query: term, limit, page }, { timeoutMs, signal })
        const rawItems = asArray(result.items || result.studies || [])
        const items = rawItems.slice(0, limit).map((entry) => mlItemFromObject(entry, request, {
          total: result.total, fetched: rawItems.length, via: 'metabolomics-plugin', elapsed_ms: Date.now() - started,
        }))
        return {
          source: 'metabolights', total: Number(result.total || items.length), fetched: items.length, page, items,
          via: 'metabolomics-plugin', warnings: result.warnings || [],
          provenance: provenance('metabolights', request, { total: Number(result.total || items.length), fetched: items.length, via: 'metabolomics-plugin', elapsed_ms: Date.now() - started }),
        }
      }
    } catch (error) {
      // 插件失败 → 回退 REST，但记录 warning
      const fallback = await searchMetabolightsRest({ fetchImpl, term, limit, page, timeoutMs, signal, request, started })
      fallback.warnings = [`metabolomics 插件 ml_search 失败（${error.message}），已回退 MetaboLights REST`, ...(fallback.warnings || [])]
      return fallback
    }
  }
  return searchMetabolightsRest({ fetchImpl, term, limit, page, timeoutMs, signal, request, started })
}

function itemsLength(value) { return Array.isArray(value) ? value.length : 0 }

async function searchMetabolightsRest({ fetchImpl, term, limit, page, timeoutMs, signal, request, started }) {
  const rest = await mlRestStudies(fetchImpl, { term, limit, page, timeoutMs, signal })
  const items = rest.entries.slice(0, limit).map((entry) => mlItemFromObject(entry, request, {
    total: rest.total, fetched: rest.entries.length, via: 'metabolights-rest', elapsed_ms: Date.now() - started, url: rest.url,
  }))
  return {
    source: 'metabolights', total: rest.total, fetched: items.length, page, items,
    via: 'metabolights-rest', warnings: [],
    provenance: provenance('metabolights', request, {
      total: rest.total, fetched: items.length, via: 'metabolights-rest',
      elapsed_ms: Date.now() - started, url: rest.url, endpoint: rest.attempts,
    }),
  }
}

async function mlDetail({ fetchImpl, adapterProvider, id, timeoutMs, signal, request }) {
  const accession = String(id || '').trim().toUpperCase()
  if (!accession) throw sourceError('bad_request', 'MetaboLights detail 需要 accession（如 MTBLS1）')
  if (adapterProvider) {
    try {
      const adapter = await adapterProvider('metabolomics')
      if (adapter) {
        const result = await adapter.invoke('ml_detail', { accession }, { timeoutMs, signal })
        const item = mlItemFromObject({ ...(result.study || result), accession }, request, { via: 'metabolomics-plugin', total: 1, fetched: 1 })
        return { source: 'metabolights', total: 1, fetched: 1, page: 0, items: [item], via: 'metabolomics-plugin', warnings: result.warnings || [], provenance: item.provenance }
      }
    } catch (error) {
      const item = await mlDetailRest({ fetchImpl, accession, timeoutMs, signal, request })
      item.warnings = [`metabolomics 插件 ml_detail 失败（${error.message}），已回退 REST`]
      return item
    }
  }
  return mlDetailRest({ fetchImpl, accession, timeoutMs, signal, request })
}

async function mlDetailRest({ fetchImpl, accession, timeoutMs, signal, request }) {
  const started = Date.now()
  const studyUrls = [
    `${METABOLIGHTS_BASE}/studies/${accession}`,
    `${METABOLIGHTS_BASE}/studies/public/study/${accession}`,
  ]
  let study = null
  let endpoint = null
  let lastError = null
  for (const url of studyUrls) {
    try {
      const { response, text } = await fetchWithTimeout(fetchImpl, url, { timeoutMs, signal })
      if (!response.ok) continue
      const payload = JSON.parse(text)
      study = payload.content || payload.study || payload
      endpoint = url
      break
    } catch (error) { lastError = error }
  }
  if (!study) throw sourceError('source_unavailable', `MetaboLights 研究 ${accession} 不可用：${lastError ? lastError.message : '端点均失败'}`)
  let files = []
  for (const url of [`${METABOLIGHTS_BASE}/studies/${accession}/files`, `${METABOLIGHTS_BASE}/studies/${accession}/files/list`]) {
    try {
      const { response, text } = await fetchWithTimeout(fetchImpl, url, { timeoutMs, signal })
      if (!response.ok) continue
      const payload = JSON.parse(text)
      const content = payload.content || payload.files || payload
      files = Array.isArray(content) ? content : []
      if (files.length) break
    } catch { /* 文件清单失败不影响详情 */ }
  }
  const entry = { ...(typeof study === 'object' ? study : {}), accession, files }
  const item = mlItemFromObject(entry, request, { via: 'metabolights-rest', total: 1, fetched: 1, elapsed_ms: Date.now() - started, url: endpoint })
  return { source: 'metabolights', total: 1, fetched: 1, page: 0, items: [item], via: 'metabolights-rest', warnings: [], provenance: item.provenance }
}

// ---------------------------------------------------------------------------
// CELLxGENE
// ---------------------------------------------------------------------------

function cxgItem(collection, request, extra = {}) {
  const datasets = asArray(collection.datasets)
  const attachments = []
  for (const dataset of datasets) {
    const datasetId = dataset.dataset_id || dataset.id
    if (!datasetId) continue
    attachments.push({
      name: `${datasetId}.h5ad`,
      type: 'h5ad',
      host: 'cellxgene',
      url: `${CELLXGENE_H5AD_HOST}/${datasetId}.h5ad`,
      dataset_id: datasetId,
      note: 'h5ad 直链主机本机不可达（探测 3s 000）→ 下载会返回 source_unavailable',
      cell_count: safeNumber(dataset.cell_count),
    })
  }
  const species = [...new Set(datasets.flatMap((dataset) => asArray(dataset.organism)))].filter(Boolean)
  const tissues = [...new Set(datasets.flatMap((dataset) => asArray(dataset.tissue)))].filter(Boolean)
  const assays = [...new Set(datasets.flatMap((dataset) => asArray(dataset.assay)))].filter(Boolean)
  return unifiedItem('cellxgene', {
    id: collection.collection_id || collection.id,
    title: collection.name || collection.title,
    summary: collection.description,
    species: species.join(', ') || null,
    n_samples: datasets.reduce((sum, dataset) => sum + (safeNumber(dataset.cell_count) || 0), 0) || null,
    platform: assays.join(', ') || null,
    scale: 'normalized_expression',
    attachments,
    clinical_available: false,
    evidence_kind: 'dataset_record',
    url: collection.collection_id ? `https://cellxgene.cziscience.com/collections/${collection.collection_id}` : null,
    metadata: {
      collection_id: collection.collection_id || collection.id,
      doi: collection.doi || null,
      n_datasets: datasets.length,
      tissues,
      assays,
      dataset_ids: attachments.map((file) => file.dataset_id),
      note: 'CELLxGENE 慢（本机 30–60s），默认不开启',
    },
    provenance: provenance('cellxgene', request, extra),
  })
}

async function searchCellxgene({ fetchImpl, term, limit, page, timeoutMs, signal, request }) {
  const started = Date.now()
  const url = new URL(`${CELLXGENE_BASE}/collections`)
  url.searchParams.set('visibility', 'PUBLIC')
  url.searchParams.set('page_size', String(Math.max(limit, 200)))
  url.searchParams.set('page', String(page + 1))
  try {
    const { response, text, elapsedMs } = await fetchWithTimeout(fetchImpl, url.toString(), { timeoutMs, signal })
    if (!response.ok) {
      return {
        source: 'cellxgene', total: 0, fetched: 0, page, items: [],
        via: 'cellxgene-curation-api', warnings: [`CELLxGENE HTTP ${response.status}`],
        error: { code: 'source_unavailable', reason: 'http_error', status: response.status, suggestion: '稍后重试或改用 GEO/GDC' },
        provenance: provenance('cellxgene', request, { total: 0, fetched: 0, via: 'cellxgene-curation-api', elapsed_ms: elapsedMs, url: url.toString() }),
      }
    }
    const payload = JSON.parse(text)
    const collections = asArray(payload.collections || payload)
    const needle = String(term || '').toLowerCase()
    const filtered = collections.filter((collection) => {
      const haystack = `${collection.name || ''} ${collection.description || ''} ${collection.doi || ''}`.toLowerCase()
      return !needle || needle.split(/\s+/).filter(Boolean).every((token) => haystack.includes(token))
    })
    const items = filtered.slice(0, limit).map((collection) => cxgItem(collection, request, {
      total: filtered.length, fetched: Math.min(filtered.length, limit), via: 'cellxgene-curation-api',
      elapsed_ms: elapsedMs, url: url.toString(),
    }))
    return {
      source: 'cellxgene', total: filtered.length, fetched: items.length, page, items,
      via: 'cellxgene-curation-api', warnings: [], slow: elapsedMs > 10_000, elapsed_ms: elapsedMs,
      provenance: provenance('cellxgene', request, {
        total: filtered.length, fetched: items.length, via: 'cellxgene-curation-api', elapsed_ms: elapsedMs, url: url.toString(),
      }),
    }
  } catch (error) {
    const reason = isAbort(error) ? 'timeout' : 'network'
    return {
      source: 'cellxgene', total: 0, fetched: 0, page, items: [],
      via: 'cellxgene-curation-api',
      warnings: [`CELLxGENE 不可用（${reason}）：本机实测该源 30–60s，或所需网络被限制；不影响其它源`],
      error: {
        code: 'source_unavailable', reason,
        suggestion: 'CELLxGENE 很慢（预计 30–60s）或网络受限；可用 GDC/GEO 替代，或稍后重试。',
      },
      provenance: provenance('cellxgene', request, { total: 0, fetched: 0, via: 'cellxgene-curation-api', elapsed_ms: Date.now() - started, url: url.toString() }),
    }
  }
}

/** h5ad 主机可用性探测（默认 5s；失败返回 source_unavailable，不抛）。 */
async function probeCellxgeneH5ad({ fetchImpl, datasetId, timeoutMs = 5_000, signal = null }) {
  const url = `${CELLXGENE_H5AD_HOST}/${datasetId}.h5ad`
  try {
    const { response, elapsedMs } = await fetchWithTimeout(fetchImpl, url, { timeoutMs, signal, method: 'HEAD' })
    if (!response.ok) {
      return { available: false, url, code: 'source_unavailable', reason: `http_${response.status}`, elapsed_ms: elapsedMs }
    }
    return { available: true, url, code: 'ok', elapsed_ms: elapsedMs }
  } catch (error) {
    return {
      available: false, url, code: 'source_unavailable',
      reason: isAbort(error) ? 'host_timeout' : 'host_unreachable',
      elapsed_ms: timeoutMs,
      suggestion: 'CELLxGENE h5ad 直链主机 datasets.cellxgene.cziscience.com 本机不可达；请用 GDC/GEO 或手动下载到本地后 action=register。',
    }
  }
}

// ---------------------------------------------------------------------------
// SourcesClient
// ---------------------------------------------------------------------------

export class SourcesClient {
  constructor({
    fetchImpl = null,
    pubmedClient = null,
    adapterProvider = null,
    bucket = null,
    timeouts = {},
    log = null,
    now = () => Date.now(),
  } = {}) {
    this.fetch = fetchImpl || globalThis.fetch
    if (typeof this.fetch !== 'function') throw sourceError('unsupported', '当前运行时没有 fetch，无法检索公共数据库')
    this.pubmed = pubmedClient
    this.adapterProvider = typeof adapterProvider === 'function' ? adapterProvider : null
    this.bucket = bucket || new TokenBucket({ ratePerSec: 3, burst: 3 })
    this.timeouts = {
      geo: Number(timeouts.geo) > 0 ? Number(timeouts.geo) : SOURCE_META.geo.timeout_ms,
      pubmed: Number(timeouts.pubmed) > 0 ? Number(timeouts.pubmed) : SOURCE_META.pubmed.timeout_ms,
      gdc: Number(timeouts.gdc) > 0 ? Number(timeouts.gdc) : SOURCE_META.gdc.timeout_ms,
      metabolights: Number(timeouts.metabolights) > 0 ? Number(timeouts.metabolights) : SOURCE_META.metabolights.timeout_ms,
      cellxgene: Number(timeouts.cellxgene) > 0 ? Number(timeouts.cellxgene) : SOURCE_META.cellxgene.timeout_ms,
    }
    this.log = typeof log === 'function' ? log : () => {}
    this.now = now
    this.healthCache = new Map()
  }

  /** 单源检索；永不抛（除参数错误），失败进 sources_failed。 */
  async searchSource(source, request, { signal = null } = {}) {
    const started = Date.now()
    try {
      if (source === 'geo') {
        if (this.adapterProvider) {
          try {
            const adapter = await this.adapterProvider('geobulk')
            if (adapter) {
              const result = await adapter.invoke('search', {
                term: request.term,
                species: request.species || 'all',
                limit: request.limit,
                page: request.page,
                has_clinical: Boolean(request.has_clinical),
              }, { timeoutMs: this.timeouts.geo, signal })
              const items = asArray(result.items).slice(0, request.limit).map((item) => geoItemFromPlugin(item, request, {
                total: result.total, fetched: asArray(result.items).length,
                via: 'geobulk-plugin',
                actual_query: result.used_term || result.query_en || result.query || request.term,
                relaxed: Boolean(result.relaxed),
                elapsed_ms: Date.now() - started,
              }))
              return {
                source, total: Number(result.total || items.length), fetched: items.length, page: request.page, items,
                via: 'geobulk-plugin', warnings: result.translate_warning ? [result.translate_warning] : [],
                provenance: provenance('geo', request, {
                  total: Number(result.total || items.length), fetched: items.length, via: 'geobulk-plugin',
                  actual_query: result.used_term || result.query_en || result.query || request.term,
                  relaxed: Boolean(result.relaxed), elapsed_ms: Date.now() - started,
                }),
              }
            }
          } catch (error) {
            this.log('sources', `geobulk 插件 search 失败，回退 E-utilities：${error.message}`)
            const direct = await searchGeoDirect({
              fetchImpl: this.fetch, bucket: this.bucket, term: request.term, limit: request.limit,
              page: request.page, species: request.species, timeoutMs: this.timeouts.geo, signal, request,
            })
            direct.warnings = [`geobulk 插件不可用（${error.message}），已回退 NCBI E-utilities 直连`, ...(direct.warnings || [])]
            return direct
          }
        }
        return await searchGeoDirect({
          fetchImpl: this.fetch, bucket: this.bucket, term: request.term, limit: request.limit,
          page: request.page, species: request.species, timeoutMs: this.timeouts.geo, signal, request,
        })
      }
      if (source === 'pubmed') {
        if (!this.pubmed) throw sourceError('unsupported', 'PubMed 客户端未初始化')
        const result = await this.pubmed.search({
          term: request.term, limit: request.limit, page: request.page,
          includeAbstracts: Boolean(request.include_abstracts), signal,
        })
        return {
          source, total: result.total, fetched: result.fetched, page: request.page, items: result.items,
          via: result.via, warnings: result.warnings || [], cached: Boolean(result.cached), provenance: result.provenance,
        }
      }
      if (source === 'gdc') {
        return await searchGdc({
          fetchImpl: this.fetch, term: request.term, limit: request.limit, page: request.page,
          timeoutMs: this.timeouts.gdc, signal, request,
        })
      }
      if (source === 'metabolights') {
        return await searchMetabolights({
          fetchImpl: this.fetch, adapterProvider: this.adapterProvider, term: request.term,
          limit: request.limit, page: request.page, timeoutMs: this.timeouts.metabolights, signal, request,
        })
      }
      if (source === 'cellxgene') {
        return await searchCellxgene({
          fetchImpl: this.fetch, term: request.term, limit: request.limit, page: request.page,
          timeoutMs: this.timeouts.cellxgene, signal, request,
        })
      }
      throw sourceError('unsupported', `未知数据源 ${source}（可用：${SOURCE_IDS.join('、')}）`)
    } catch (error) {
      if (error && error.code === 'bad_request') throw error
      const reason = isAbort(error) ? 'timeout' : (error.code || 'network')
      return {
        source, total: 0, fetched: 0, page: request.page, items: [],
        via: 'builtin', warnings: [`${source} 检索失败：${String(error.message || error)}`],
        error: { code: error.code || 'network', reason, message: String(error.message || error), suggestion: '换更宽的关键词，或改用其它数据源' },
        provenance: provenance(source, request, {
          total: 0, fetched: 0, via: 'builtin', elapsed_ms: Date.now() - started,
        }),
      }
    }
  }

  /**
   * 统一检索：每个源独立超时/失败；返回 sources_ok / sources_failed。
   */
  async search({
    term,
    sources = DEFAULT_SEARCH_SOURCES,
    limit = 20,
    page = 0,
    species = 'all',
    includeAbstracts = false,
    has_clinical = false,
    europepmc = false,
    signal = null,
  } = {}) {
    const wanted = (Array.isArray(sources) && sources.length ? sources : DEFAULT_SEARCH_SOURCES)
      .map((source) => String(source).toLowerCase())
      .filter((source, index, list) => SOURCE_IDS.includes(source) && list.indexOf(source) === index)
    const bad = (Array.isArray(sources) ? sources : []).filter((source) => !SOURCE_IDS.includes(String(source).toLowerCase()))
    const request = {
      term: String(term || '').trim(), limit: Math.max(1, Math.min(100, Number(limit) || 20)),
      page: Math.max(0, Number(page) || 0), species, include_abstracts: includeAbstracts, has_clinical,
    }
    if (!request.term) throw sourceError('bad_request', 'search 需要 term（检索关键词 / GSE / TCGA 项目号）')
    const started = Date.now()
    const settled = await Promise.all(wanted.map(async (source) => {
      try { return await this.searchSource(source, request, { signal }) } catch (error) {
        return {
          source, total: 0, fetched: 0, page: request.page, items: [],
          error: { code: error.code || 'network', reason: String(error.message || error) },
          warnings: [String(error.message || error)],
          provenance: provenance(source, request, { total: 0, fetched: 0 }),
        }
      }
    }))
    const bySource = {}
    const sourcesOk = []
    const sourcesFailed = []
    const provenanceAll = []
    const warnings = []
    for (const result of settled) {
      bySource[result.source] = {
        total: result.total, fetched: result.fetched, via: result.via || null,
        cached: Boolean(result.cached), slow: Boolean(result.slow),
        elapsed_ms: result.provenance ? result.provenance.elapsed_ms : null,
        error: result.error || null,
        warnings: result.warnings || [],
      }
      if (result.error || (!result.items.length && result.error)) sourcesFailed.push({ source: result.source, ...(result.error || {}) })
      else sourcesOk.push(result.source)
      if (result.provenance) provenanceAll.push(result.provenance)
      warnings.push(...(result.warnings || []))
    }
    for (const source of bad) sourcesFailed.push({ source, code: 'unsupported', reason: `未知数据源（可用：${SOURCE_IDS.join('、')}）` })
    return {
      query: {
        term: request.term, species: request.species, limit: request.limit, page: request.page,
        sources: wanted, include_abstracts: Boolean(includeAbstracts),
        europepmc: Boolean(europepmc),
        at: nowIso(), elapsed_ms: Date.now() - started,
      },
      results: settled.reduce((acc, result) => {
        acc[result.source] = result
        return acc
      }, {}),
      by_source: bySource,
      sources: wanted,
      sources_ok: sourcesOk,
      sources_failed: sourcesFailed,
      warnings: [...new Set(warnings)],
      provenance: provenanceAll,
      default_sources: DEFAULT_SEARCH_SOURCES,
    }
  }

  /** 单条详情（GEO/GDC/MetaboLights），供 download/register 链消费。 */
  async detail({ source, id, includeClinical = true, signal = null } = {}) {
    const request = { term: id, limit: 1, page: 0 }
    if (source === 'gdc') {
      return gdcDetail({ fetchImpl: this.fetch, id, timeoutMs: this.timeouts.gdc, signal, request, includeClinical })
    }
    if (source === 'metabolights') {
      return mlDetail({ fetchImpl: this.fetch, adapterProvider: this.adapterProvider, id, timeoutMs: this.timeouts.metabolights, signal, request })
    }
    if (source === 'geo') {
      const gse = String(id || '').toUpperCase()
      if (this.adapterProvider) {
        try {
          const adapter = await this.adapterProvider('geobulk')
          if (adapter) {
            const result = await adapter.invoke('detail', { gse }, { timeoutMs: this.timeouts.geo, signal })
            const item = geoItemFromPlugin({
              gse, title: result.title, summary: result.summary, species: result.species,
              n_samples: result.n_samples, platform: result.platform, has_clinical: result.has_clinical,
              has_matrix: true, study_type: result.study_type, release: result.release,
            }, request, { total: 1, fetched: 1, via: 'geobulk-plugin' })
            item.attachments = asArray(result.files || result.suggested_files || []).map((file) => ({
              name: typeof file === 'string' ? file : (file.name || file.file || 'file'),
              type: /matrix/i.test(String(typeof file === 'string' ? file : file.name)) ? 'matrix' : 'supplementary',
              host: 'ncbi-geo',
              url: typeof file === 'string' ? null : (file.url || null),
              resolution: 'plugin_geo_download',
            }))
            item.metadata.geo_files = result.files || null
            item.metadata.suggested = result.suggested || null
            return { source: 'geo', total: 1, fetched: 1, page: 0, items: [item], via: 'geobulk-plugin', warnings: [], provenance: item.provenance }
          }
        } catch (error) {
          this.log('sources', `geobulk detail 失败：${error.message}`)
        }
      }
      // 直连回退：复用 esearch + esummary
      const request2 = { ...request, term: gse }
      const direct = await searchGeoDirect({
        fetchImpl: this.fetch, bucket: this.bucket, term: gse, limit: 1, page: 0, species: 'all',
        timeoutMs: this.timeouts.geo, signal, request: request2,
      })
      return { ...direct, total: direct.items.length, fetched: direct.items.length }
    }
    if (source === 'cellxgene') {
      const result = await searchCellxgene({ fetchImpl: this.fetch, term: String(id || ''), limit: 1, page: 0, timeoutMs: this.timeouts.cellxgene, signal, request })
      return result
    }
    throw sourceError('unsupported', `detail 不支持数据源 ${source}`)
  }

  /** 数据源健康灯：ok / slow / down。缓存 60s。 */
  async probeHealth({ sources = SOURCE_IDS, force = false, signal = null } = {}) {
    const now = this.now()
    const results = {}
    for (const source of sources) {
      const cached = this.healthCache.get(source)
      if (!force && cached && now - cached.at < 60_000) { results[source] = { ...cached.health, cached: true }; continue }
      const started = Date.now()
      let health
      try {
        if (source === 'geo' || source === 'pubmed') {
          const db = source === 'geo' ? 'gds' : 'pubmed'
          const url = `${EUtils_BASE}/einfo.fcgi?db=${db}&retmode=json&tool=dsh-bioflow`
          const { response, text } = await fetchWithTimeout(this.fetch, url, { timeoutMs: 10_000, signal })
          if (!response.ok) throw sourceError('http_error', `HTTP ${response.status}`)
          parseJson(text, source)
          health = { source, status: 'ok', latency_ms: Date.now() - started, reason: null }
        } else if (source === 'gdc') {
          const { response } = await fetchWithTimeout(this.fetch, `${GDC_BASE}/projects?size=1&fields=project_id`, { timeoutMs: 10_000, signal })
          if (!response.ok) throw sourceError('http_error', `HTTP ${response.status}`)
          health = { source, status: 'ok', latency_ms: Date.now() - started, reason: null }
        } else if (source === 'metabolights') {
          const { response } = await fetchWithTimeout(this.fetch, `${METABOLIGHTS_BASE}/studies?pageSize=1`, { timeoutMs: 25_000, signal })
          if (!response.ok) throw sourceError('http_error', `HTTP ${response.status}`)
          const latency = Date.now() - started
          health = { source, status: latency > SOURCE_META.metabolights.slow_ms ? 'slow' : 'ok', latency_ms: latency, reason: latency > SOURCE_META.metabolights.slow_ms ? `本机实测约 7.6s，较慢（${latency}ms）` : null, expected: '较慢，正常 5–10s' }
        } else if (source === 'cellxgene') {
          const { response } = await fetchWithTimeout(this.fetch, `${CELLXGENE_BASE}/collections?visibility=PUBLIC&page_size=1`, { timeoutMs: 60_000, signal })
          if (!response.ok) throw sourceError('http_error', `HTTP ${response.status}`)
          const latency = Date.now() - started
          health = {
            source,
            status: latency > SOURCE_META.cellxgene.slow_ms ? 'slow' : 'ok',
            latency_ms: latency,
            reason: latency > SOURCE_META.cellxgene.slow_ms ? `本机实测 30–60s，较慢（${latency}ms）` : null,
            expected: '预计 30–60s，默认关闭',
          }
        } else {
          health = { source, status: 'down', latency_ms: null, reason: '未知数据源' }
        }
      } catch (error) {
        const isTimeout = isAbort(error)
        health = {
          source,
          status: 'down',
          latency_ms: Date.now() - started,
          reason: isTimeout ? 'timeout' : String(error.message || error),
          code: isTimeout ? 'timeout' : (error.code || 'network'),
        }
      }
      this.healthCache.set(source, { at: now, health })
      results[source] = health
    }
    return results
  }

  async probeCellxgeneH5ad({ datasetId, timeoutMs = 5_000, signal = null }) {
    return probeCellxgeneH5ad({ fetchImpl: this.fetch, datasetId, timeoutMs, signal })
  }
}

export function createSourcesClient(opts = {}) {
  return new SourcesClient(opts)
}

export { searchGeoDirect, searchGdc, gdcDetail, searchMetabolights, searchCellxgene, probeCellxgeneH5ad }
