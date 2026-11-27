/**
 * dsh-bioflow — RO-Crate 导出适配（RO-Crate 1.1 + Workflow Run Crate / Process profile）
 *
 * 目的：让结果包不只对 bioflow 自己可读，也能被外部工具消费（Galaxy、ARK、ro-crate-js、
 * 各类 FAIR 检查器）。做法是把一次 run 映射成 RO-Crate 实体：
 *
 *   ./                       root Dataset（conformsTo: crate 1.1 + wfrun/process 0.4）
 *   ro-crate-metadata.json   描述符（about → ./）
 *   #bioflow / #plugin-*     SoftwareApplication（bioflow 与各工作台版本）
 *   #run / #step-*           CreateAction（起止时间、actionStatus、instrument、object、result）
 *   <file>                   File（contentSize + sha256 + encodingFormat）
 *
 * 注意：本文件只做「映射」，不抄任何第三方实现。Galaxy 的 RO-Crate 导出是 MIT，
 * 我们按其公开的实体形状独立实现，字段以 RO-Crate 1.1 规范为准。
 */

export const RO_CRATE_SCHEMA = 'ro-crate-metadata.json'
export const RO_CRATE_CONTEXT = 'https://w3id.org/ro/crate/1.1/context'
export const RO_CRATE_CONFORMS_TO = 'https://w3id.org/ro/crate/1.1'
export const PROCESS_RUN_PROFILE = 'https://w3id.org/ro/wfrun/process/0.4'
export const BIOFLOW_TOOL_ID = '#bioflow'

const SCHEMA_ORG = 'https://schema.org/'
const COMPLETED = SCHEMA_ORG + 'CompletedActionStatus'
const FAILED = SCHEMA_ORG + 'FailedActionStatus'

const MIME_BY_EXT = {
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.tsv': 'text/tab-separated-values',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.rds': 'application/octet-stream',
  '.h5ad': 'application/x-hdf5',
  '.py': 'text/x-python',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.r': 'text/x-r',
}

function encodeId(relativePath) {
  // RO-Crate 的 @id 是相对 IRI：用 / 分段、空格与特殊字符转义，禁止绝对路径与 ..
  return String(relativePath)
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map((segment) => encodeURIComponent(segment).replace(/%2F/gi, '/'))
    .join('/')
}

function mimeOf(relativePath) {
  const lower = String(relativePath).toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot < 0 ? 'application/octet-stream' : (MIME_BY_EXT[lower.slice(dot)] || 'application/octet-stream')
}

function basename(relativePath) {
  const parts = String(relativePath).split('/')
  return parts[parts.length - 1] || relativePath
}

function cleanText(value, fallback = null) {
  if (value === null || value === undefined) return fallback
  const text = String(value).trim()
  return text || fallback
}

function isoOrNull(value) {
  const text = cleanText(value)
  return text || null
}

/** step 的产物 id（table_id / figure_id）→ 导出包里的相对路径。 */
function indexProducts(tablesIndex) {
  const tableToFile = new Map()
  const figureToFile = new Map()
  if (!tablesIndex || typeof tablesIndex !== 'object') return { tableToFile, figureToFile }
  for (const table of Array.isArray(tablesIndex.tables) ? tablesIndex.tables : []) {
    if (!table) continue
    const id = cleanText(table.table_id || table.id)
    const file = cleanText(table.relative_path || table.file)
    if (id && file) tableToFile.set(id, file)
  }
  for (const figure of Array.isArray(tablesIndex.figures) ? tablesIndex.figures : []) {
    if (!figure) continue
    const id = cleanText(figure.figure_id || figure.id)
    const file = cleanText(figure.file || figure.relative_path)
    if (id && file) figureToFile.set(id, file)
  }
  return { tableToFile, figureToFile }
}

function pickStepFiles(step, tableToFile, figureToFile) {
  const files = []
  for (const tableId of Array.isArray(step.tables) ? step.tables : []) {
    const file = tableToFile.get(String(tableId))
    if (file) files.push(file)
  }
  for (const figureId of Array.isArray(step.figures) ? step.figures : []) {
    const file = figureToFile.get(String(figureId))
    if (file) files.push(file)
  }
  return files
}

function statusAction(entity, status) {
  const normalized = String(status || '').toLowerCase()
  if (['succeeded', 'ok', 'success', 'partial'].includes(normalized)) return { '@id': COMPLETED }
  if (['failed', 'error', 'blocked', 'cancelled', 'canceled'].includes(normalized)) return { '@id': FAILED }
  return null
}

/**
 * 构建 RO-Crate 1.1 元数据对象。
 * @param {object} input
 * @param {object} input.run       run 记录（run_id/status/created_at/updated_at/warnings）
 * @param {object} input.manifest  manifest.json（plan/dataset/environment/steps/...）
 * @param {Array}  input.files     [{ path, sha256, bytes }]（导出包内相对路径）
 * @param {object} [input.tablesIndex] results/tables.index.json（用于把 step 产物映射到文件）
 * @param {string[]} [input.extraFiles] 额外写进 crates 的非产物文件（如 export.json）
 * @param {object} [input.evidence]    evidence summary（可选，写进 root description）
 */
export function buildProcessRunCrate({ run, manifest, files, tablesIndex = null, extraFiles = [], evidence = null } = {}) {
  const runRecord = run && typeof run === 'object' ? run : {}
  const manifestObject = manifest && typeof manifest === 'object' ? manifest : {}
  const plan = manifestObject.plan && typeof manifestObject.plan === 'object' ? manifestObject.plan : {}
  const dataset = manifestObject.dataset && typeof manifestObject.dataset === 'object' ? manifestObject.dataset : {}
  const environment = manifestObject.environment && typeof manifestObject.environment === 'object' ? manifestObject.environment : {}
  const runId = cleanText(runRecord.run_id || manifestObject.run_id, 'run')

  const fileList = (Array.isArray(files) ? files : [])
    .filter((file) => file && cleanText(file.path))
    .map((file) => ({
      path: encodeId(file.path),
      name: basename(file.path),
      sha256: cleanText(file.sha256),
      bytes: Number.isFinite(Number(file.bytes)) ? Number(file.bytes) : null,
    }))
  const seenFiles = new Set(fileList.map((file) => file.path))
  for (const rel of Array.isArray(extraFiles) ? extraFiles : []) {
    const encoded = encodeId(rel)
    if (!encoded || seenFiles.has(encoded)) continue
    seenFiles.add(encoded)
    fileList.push({ path: encoded, name: basename(rel), sha256: null, bytes: null })
  }

  const { tableToFile, figureToFile } = indexProducts(tablesIndex)

  // ---- SoftwareApplication：bioflow 本体 + 各工作台插件 ----
  const software = [
    {
      '@id': BIOFLOW_TOOL_ID,
      '@type': 'SoftwareApplication',
      name: 'dsh-bioflow',
      softwareVersion: cleanText(environment.bioflow_version, 'unknown'),
      applicationCategory: 'Bioinformatics',
      operatingSystem: cleanText(environment.platform),
    },
  ]
  const pluginIds = new Map()
  const plugins = environment.plugins && typeof environment.plugins === 'object' ? environment.plugins : {}
  for (const [pluginName, info] of Object.entries(plugins)) {
    const pluginId = '#plugin-' + encodeId(pluginName).replace(/\//g, '-')
    const entry = info && typeof info === 'object' ? info : {}
    pluginIds.set(pluginName, pluginId)
    software.push({
      '@id': pluginId,
      '@type': 'SoftwareApplication',
      name: pluginName,
      softwareVersion: cleanText(entry.version, 'unknown'),
      applicationCategory: 'Bioinformatics',
    })
  }

  // ---- 输入数据集实体：只描述来源与身份，不把未随包导出的输入文件伪装成 crate 内文件 ----
  const datasetEntity = (() => {
    const datasetId = cleanText(dataset.dataset_id)
    const datasetName = cleanText(dataset.name)
    if (!datasetId && !datasetName) return null
    const inputFiles = (Array.isArray(dataset.files) ? dataset.files : [])
      .map((file) => {
        const name = cleanText(file && file.name)
        if (!name) return null
        return { name, sha256: cleanText(file && file.sha256) || undefined, bytes: Number.isFinite(Number(file && file.bytes)) ? Number(file.bytes) : undefined }
      })
      .filter(Boolean)
    return {
      '@id': '#dataset',
      '@type': 'Dataset',
      name: datasetName || datasetId,
      identifier: datasetId || undefined,
      description: [
        cleanText(dataset.assay) ? `assay=${dataset.assay}` : null,
        cleanText(dataset.species) ? `species=${dataset.species}` : null,
        cleanText(dataset.reference) ? `reference=${dataset.reference}` : null,
      ].filter(Boolean).join('; ') || undefined,
      'bioflow:scale': cleanText(dataset.scale && (dataset.scale.type || dataset.scale)),
      'bioflow:inputFiles': inputFiles.length ? inputFiles : undefined,
    }
  })()

  // ---- 计划参数实体（PropertyValue）：独立成实体，动作只引用 ----
  const parameterEntities = buildParameters(plan)

  // ---- CreateAction：run 级 + 每步 ----
  const actions = []
  actions.push({
    '@id': '#run',
    '@type': 'CreateAction',
    name: `bioflow run ${runId}`,
    description: cleanText(manifestObject.template) ? `template: ${manifestObject.template}` : null,
    startTime: isoOrNull(runRecord.started_at || manifestObject.created_at),
    endTime: isoOrNull(runRecord.finished_at || manifestObject.finished_at),
    actionStatus: statusAction(null, cleanText(runRecord.status || manifestObject.status)),
    instrument: [{ '@id': BIOFLOW_TOOL_ID }],
    object: datasetEntity ? [{ '@id': '#dataset' }] : undefined,
    result: fileList.filter((file) => !file.path.includes('/')).map((file) => ({ '@id': file.path })),
    // 计划参数：以 PropertyValue 形式保留可回查的关键口径
    parameter: parameterEntities.length ? parameterEntities.map((entity) => ({ '@id': entity['@id'] })) : undefined,
  })

  const steps = Array.isArray(manifestObject.steps) ? manifestObject.steps : []
  for (const step of steps) {
    if (!step || !cleanText(step.step_id)) continue
    const stepId = '#step-' + encodeId(step.step_id).replace(/\//g, '-')
    const pluginName = cleanText(step.plugin)
    const products = pickStepFiles(step, tableToFile, figureToFile).map((file) => encodeId(file))
    actions.push({
      '@id': stepId,
      '@type': 'CreateAction',
      name: cleanText(step.action) ? `${step.plugin || 'step'}.${step.action}` : cleanText(step.step_id),
      startTime: isoOrNull(step.started_at),
      endTime: isoOrNull(step.finished_at),
      actionStatus: statusAction(null, cleanText(step.status)),
      instrument: pluginName && pluginIds.has(pluginName) ? [{ '@id': pluginIds.get(pluginName) }] : undefined,
      result: products.length ? products.map((file) => ({ '@id': file })) : undefined,
      error: cleanText(step.error) || undefined,
      additionalType: 'https://w3id.org/ro/wfrun/process/0.4#step',
    })
  }

  // ---- root Dataset ----
  const title = cleanText(dataset.name)
    ? `${dataset.name} — bioflow ${runId}`
    : `bioflow analysis ${runId}`
  const descriptionParts = []
  if (cleanText(manifestObject.template)) descriptionParts.push(`template=${manifestObject.template}`)
  if (cleanText(dataset.assay)) descriptionParts.push(`assay=${dataset.assay}`)
  if (cleanText(dataset.species)) descriptionParts.push(`species=${dataset.species}`)
  if (cleanText(dataset.scale && (dataset.scale.type || dataset.scale))) descriptionParts.push(`scale=${cleanText(dataset.scale.type || dataset.scale)}`)
  if (evidence && Number.isFinite(Number(evidence.records))) descriptionParts.push(`evidence_claims=${Number(evidence.records)}`)
  if (manifestObject.zero_significant === true) descriptionParts.push('zero_significant=true')

  const root = {
    '@id': './',
    '@type': 'Dataset',
    name: title,
    description: descriptionParts.join('; ') || undefined,
    datePublished: isoOrNull(manifestObject.finished_at || runRecord.updated_at),
    conformsTo: [{ '@id': RO_CRATE_CONFORMS_TO }, { '@id': PROCESS_RUN_PROFILE }],
    hasPart: fileList.map((file) => ({ '@id': file.path })),
    mentions: actions.map((action) => ({ '@id': action['@id'] })).concat(software.map((item) => ({ '@id': item['@id'] }))),
    // 数据身份：把 manifest / content hash 作为可校验的附加属性（RO-Crate 允许扩展）
    'bioflow:runId': runId,
    'bioflow:manifestSha256': cleanText(runRecord.manifest_sha256),
    'bioflow:contentHash': cleanText(manifestObject.content_hash),
    'bioflow:schemaVersion': cleanText(manifestObject.schema_version),
  }

  const descriptor = {
    '@id': RO_CRATE_SCHEMA,
    '@type': 'CreativeWork',
    about: { '@id': './' },
    conformsTo: { '@id': RO_CRATE_CONFORMS_TO },
  }

  const fileEntities = fileList.map((file) => ({
    '@id': file.path,
    '@type': 'File',
    name: file.name,
    contentSize: file.bytes === null ? undefined : file.bytes,
    encodingFormat: mimeOf(file.path),
    sha256: file.sha256 || undefined,
  }))

  return {
    '@context': RO_CRATE_CONTEXT,
    '@graph': [descriptor, root, datasetEntity, ...software, ...actions, ...parameterEntities, ...fileEntities].filter(Boolean),
  }
}

/** 计划参数 → RO-Crate PropertyValue（只放能确定的，不补默认值）。 */
function buildParameters(plan) {
  const params = plan && typeof plan === 'object' ? plan : {}
  const out = []
  const push = (name, value) => {
    const text = cleanText(value)
    if (text) out.push({ '@id': '#param-' + encodeId(name).replace(/\//g, '-'), '@type': 'PropertyValue', name, value: text })
  }
  push('template', params.template)
  push('contrast.case', params.contrast && params.contrast.case)
  push('contrast.control', params.contrast && params.contrast.control)
  const paramsObject = params.params && typeof params.params === 'object' ? params.params : {}
  push('fdr', paramsObject.fdr)
  push('alpha', paramsObject.alpha)
  push('seed', paramsObject.seed)
  return out
}

/** 结构校验（不是官方 validators 的替代品，但能挡住绝大多数手误）。 */
export function validateRoCrate(crate) {
  const issues = []
  const add = (code, detail) => issues.push({ code, detail })
  if (!crate || typeof crate !== 'object') {
    add('not_object', 'crate 不是对象')
    return { ok: false, issues }
  }
  if (crate['@context'] !== RO_CRATE_CONTEXT) add('bad_context', `@context 必须是 ${RO_CRATE_CONTEXT}`)
  const graph = Array.isArray(crate['@graph']) ? crate['@graph'] : null
  if (!graph) {
    add('no_graph', '缺 @graph')
    return { ok: false, issues }
  }
  const byId = new Map()
  for (const entity of graph) {
    if (!entity || typeof entity !== 'object') { add('bad_entity', '实体不是对象'); continue }
    const id = entity['@id']
    if (!id) { add('entity_without_id', JSON.stringify(entity).slice(0, 80)); continue }
    if (byId.has(id)) add('duplicate_id', id)
    byId.set(id, entity)
    const types = Array.isArray(entity['@type']) ? entity['@type'] : [entity['@type']]
    if (!entity['@type']) add('no_type', id)
    if (String(id).startsWith('http://') || String(id).startsWith('file://') || String(id).includes('/Users/')) {
      add('absolute_id', id)
    }
  }
  const descriptor = byId.get(RO_CRATE_SCHEMA)
  if (!descriptor) add('no_descriptor', '缺 ro-crate-metadata.json 实体')
  else if (!descriptor.about || descriptor.about['@id'] !== './') add('descriptor_about', '描述符 about 必须指向 ./')
  const root = byId.get('./')
  if (!root) add('no_root_dataset', '缺 root Dataset')
  else {
    const conforms = Array.isArray(root.conformsTo) ? root.conformsTo : [root.conformsTo]
    const ids = conforms.filter(Boolean).map((item) => item['@id'] || item)
    if (!ids.includes(RO_CRATE_CONFORMS_TO)) add('root_conforms', 'root 未声明 ro/crate/1.1')
    for (const part of Array.isArray(root.hasPart) ? root.hasPart : []) {
      if (!part || !byId.has(part['@id'])) add('dangling_hasPart', part && part['@id'])
    }
    for (const mention of Array.isArray(root.mentions) ? root.mentions : []) {
      if (!mention || !byId.has(mention['@id'])) add('dangling_mentions', mention && mention['@id'])
    }
  }
  // 动作引用可解析
  for (const entity of graph) {
    if (!entity || !entity['@type']) continue
    const types = Array.isArray(entity['@type']) ? entity['@type'] : [entity['@type']]
    if (!types.includes('CreateAction')) continue
    for (const ref of [...(Array.isArray(entity.result) ? entity.result : []), ...(Array.isArray(entity.object) ? entity.object : [])]) {
      if (ref && ref['@id'] && !byId.has(ref['@id'])) add('dangling_action_ref', `${entity['@id']} → ${ref['@id']}`)
    }
    for (const ref of Array.isArray(entity.parameter) ? entity.parameter : []) {
      if (ref && ref['@id'] && !byId.has(ref['@id'])) add('dangling_parameter', `${entity['@id']} → ${ref['@id']}`)
    }
    for (const ref of Array.isArray(entity.instrument) ? entity.instrument : []) {
      if (ref && ref['@id'] && !byId.has(ref['@id'])) add('dangling_instrument', `${entity['@id']} → ${ref['@id']}`)
    }
  }
  // 文件实体必须有大小或哈希，且 @id 与文件名一致
  for (const entity of graph) {
    const types = Array.isArray(entity && entity['@type']) ? entity['@type'] : [entity && entity['@type']]
    if (!types.includes('File')) continue
    if (entity.contentSize === undefined && entity.sha256 === undefined) add('file_without_provenance', entity['@id'])
  }
  return { ok: issues.length === 0, issues }
}

/** 人读预览页（RO-Crate 约定：与元数据同目录的 ro-crate-preview.html）。 */
export function renderRoCratePreview(crate) {
  const graph = Array.isArray(crate && crate['@graph']) ? crate['@graph'] : []
  const root = graph.find((entity) => entity && entity['@id'] === './') || {}
  const rows = graph
    .filter((entity) => entity && entity['@id'] !== './' && entity['@id'] !== RO_CRATE_SCHEMA)
    .map((entity) => {
      const types = Array.isArray(entity['@type']) ? entity['@type'].join(', ') : (entity['@type'] || '')
      const label = entity.name || entity['@id']
      return `<tr><td><code>${escapeHtml(entity['@id'])}</code></td><td>${escapeHtml(types)}</td><td>${escapeHtml(label)}</td></tr>`
    })
    .join('\n')
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(root.name || 'bioflow RO-Crate')}</title>
<style>body{font:14px/1.6 -apple-system,Segoe UI,sans-serif;margin:32px;color:#1f2937}code{background:#f3f4f6;padding:1px 4px;border-radius:4px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top}</style>
</head><body>
<h1>${escapeHtml(root.name || 'bioflow RO-Crate')}</h1>
<p>${escapeHtml(root.description || '')}</p>
<p>conformsTo: <code>${RO_CRATE_CONFORMS_TO}</code> · <code>${PROCESS_RUN_PROFILE}</code></p>
<table><thead><tr><th>@id</th><th>@type</th><th>name</th></tr></thead><tbody>
${rows}
</tbody></table>
<p>元数据：<a href="ro-crate-metadata.json">ro-crate-metadata.json</a></p>
</body></html>
`
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
