/**
 * dsh-bioflow — 交付物生成（manifest / design.tsv / qc.tsv / results/*.tsv / figures / evidence / methods）
 *
 * 三条硬设计决定之二「不重算分析」的落点：
 *   step = {plugin, action, params} 的结果原样存 results/steps/<step>.json，
 *   这里只做**抽取与格式转换**，不重跑任何统计；数值全部来自插件引擎返回。
 *
 * 取消零写入：所有文件先写 runDir/.staging/<step>/，提交前 store.assertWritable()，
 * 取消后抛 cancelled 并清 staging；run 目录不会出现 results/figures/manifest。
 *
 * 图默认只出 PNG（用户固定偏好 300dpi 由插件负责）；图内文字英文由插件负责。
 * bioflow 自己绝不把上游 workdir 当交付目录（plotlab prepareWorkdir 会删 figures/*.png）。
 */

import path from 'node:path'
import {
  createWriteStream, existsSync, readFileSync, renameSync, rmSync, statSync,
} from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createReadStream } from 'node:fs'
import {
  atomicWriteFile, atomicWriteJson, ensureDir, fileSize, nowIso, safeName, sha256File,
  tableToTsv, normalizeColumnSpec, parseDelimited, stableStringify, sha256Json, tsvCell, removeDir,
} from './store.mjs'
import { buildEvidence, describeTable, renderEvidenceJsonl, tableColumns, rowObject } from './evidence.mjs'

export const DELIVER_SCHEMA_VERSION = 1

const IMAGE_EXT = /\.(png|jpe?g|svg|pdf|webp)$/i
const TABLE_ID_MAX = 80

function slug(text, fallback = 'table') {
  const value = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, TABLE_ID_MAX)
  return value || fallback
}

function uniqueId(base, used) {
  let id = base
  let index = 2
  while (used.has(id)) { id = `${base}_${index}`; index += 1 }
  used.add(id)
  return id
}

// ---------------------------------------------------------------------------
// 结果抽取
// ---------------------------------------------------------------------------

/** 递归收集结果里的表格（插件信封不完全统一，容忍 tables / 任意 {columns,rows}）。 */
export function extractTables(result, context = {}) {
  const tables = []
  const seen = new Set()
  const used = new Set()
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    const candidate = tableShaped(node)
    if (candidate) {
      const id = uniqueId(slug(candidate.id || candidate.title || 'table'), used)
      tables.push(normalizeTable(candidate, context, id))
      // 表格对象内部不再往下走，避免把单元格里的对象当表
      return
    }
    for (const key of Object.keys(node)) {
      const value = node[key]
      if (key === 'columns' || key === 'rows' || key === 'cells') continue
      walk(value, depth + 1)
    }
  }
  walk(result, 0)
  return tables
}

function tableShaped(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null
  const hasRows = Array.isArray(node.rows) && node.rows.length >= 0 && (node.rows.length > 0 || Array.isArray(node.columns))
  const hasColumns = Array.isArray(node.columns) && node.columns.length > 0
  if (!hasRows || !hasColumns) return null
  // data/plotdata 之类的对象也可能有 columns/rows，但它们同样可以当表交付
  return node
}

function normalizeTable(table, context, id) {
  const columns = normalizeColumnSpec(table.columns)
  const rows = Array.isArray(table.rows) ? table.rows : []
  const evidenceKind = inferEvidenceKind(table, context)
  return {
    table_id: id,
    title: String(table.title || table.label || id),
    note: table.note || table.description || null,
    columns,
    rows,
    evidence_kind: evidenceKind,
    contrast_id: table.contrast_id || (context.deliver && context.deliver.contrast && context.plan && context.plan.contrast
      ? context.plan.contrast.contrast_id
      : null),
    step_id: context.step ? context.step.step_id : null,
    plugin: context.step ? context.step.plugin : null,
    units: table.units || null,
  }
}

function inferEvidenceKind(table, context) {
  const deliver = context.deliver || {}
  const step = context.step || {}
  if (table.evidence_kind) return table.evidence_kind
  if (deliver.evidence_kind) return deliver.evidence_kind
  if (step.evidence_kind) return step.evidence_kind
  if (step.plugin === 'virtualcell') return 'model_prediction'
  const id = String(table.id || table.title || '').toLowerCase()
  const kind = String(deliver.kind || '')
  if (['qc', 'design', 'dataset', 'filter', 'normalize', 'cluster', 'embed', 'harmonize', 'batch'].includes(kind)) return 'descriptive'
  if (['de', 'enrich', 'composition', 'pseudobulk', 'meta'].includes(kind)) return 'measured'
  const shape = describeTable({
    columns: normalizeColumnSpec(table.columns),
    rows: table.rows,
  })
  if (!shape.inferential) return 'descriptive'
  if (/^(qc|sample|design|batch|filter|normalize|cluster|embed|summary)/.test(id)) return 'descriptive'
  return 'measured'
}

/** 递归收集结果里的图文件（只认真实存在的图片路径）。 */
export function extractFigures(result, context = {}) {
  const figures = []
  const seen = new Set()
  const seenFiles = new Set()
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    const file = node.file || node.path || node.file_path || node.output || null
    if (typeof file === 'string' && IMAGE_EXT.test(file) && existsSync(file)) {
      if (!seenFiles.has(file)) {
        seenFiles.add(file)
        figures.push({
          source_path: file,
          kind: node.kind || node.type || null,
          title: node.title || node.label || node.caption || path.basename(file),
          caption: node.caption || null,
          format: path.extname(file).slice(1).toLowerCase(),
          plot_data: node.plot_data || node.plotdata || null,
          table_id: node.table_id || null,
          source_table_ids: Array.isArray(node.source_table_ids) ? node.source_table_ids : [],
          width: node.width || null,
          height: node.height || null,
          dpi: node.dpi || null,
        })
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'file' || key === 'path') continue
      walk(node[key], depth + 1)
    }
  }
  walk(result, 0)
  // 关联本 step 的表格：没有显式 source_table_ids 时，把 step 全部表挂上（保守，不丢可回查性）
  const stepTableIds = context.tableIds || []
  for (const figure of figures) {
    if (!figure.source_table_ids.length && stepTableIds.length) figure.source_table_ids = [...stepTableIds]
    figure.step_id = context.step ? context.step.step_id : null
    figure.contrast_id = figure.contrast_id || (context.plan && context.plan.contrast ? context.plan.contrast.contrast_id : null)
    figure.evidence_kind = figure.evidence_kind || (context.step && context.step.evidence_kind) || 'descriptive'
  }
  return figures
}

// ---------------------------------------------------------------------------
// 文件写入（全部先 staging，再 commit）
// ---------------------------------------------------------------------------

export function stagingDirFor(runDir, stepId) {
  return path.join(runDir, '.staging', safeName(stepId, 'step'))
}

/** 抽 step 结果到 staging：raw json + tables + figures。 */
export async function stageStepResult({ run, runDir, plan, dataset, step, result }) {
  const staging = stagingDirFor(runDir, step.step_id)
  ensureDir(staging)
  const tables = extractTables(result, { step, plan, deliver: step.deliver, dataset })
  const figures = extractFigures(result, { step, plan, tableIds: tables.map((table) => table.table_id), dataset })

  const raw = {
    schema_version: DELIVER_SCHEMA_VERSION,
    run_id: run.run_id,
    step_id: step.step_id,
    plugin: step.plugin,
    action: step.action,
    params: step.params,
    recorded_at: nowIso(),
    result,
  }
  const rawFile = path.join(staging, 'step.json')
  atomicWriteJson(rawFile, raw)

  const tableFiles = []
  for (const table of tables) {
    const columns = table.columns.map((column) => ({
      key: column.key,
      label: column.label || column.key,
      type: column.type || 'string',
    }))
    // 每行都要能回查：table_id 与 contrast/evidence 上下文作为常量列写入（row_id 由 tableToTsv 追加）。
    // 之前 extra 只按键名从数据行取值，而数据行里没有这些字段，导致 contrast_id 列恒为空。
    const extra = [{ key: 'table_id', label: 'table_id', value: table.table_id }]
    if (table.contrast_id) extra.push({ key: 'contrast_id', label: 'contrast_id', value: table.contrast_id })
    if (table.evidence_kind) extra.push({ key: 'evidence_kind', label: 'evidence_kind', value: table.evidence_kind })
    const tsv = tableToTsv(columns, table.rows, extra)
    const relative = `results/${table.table_id}.tsv`
    const file = path.join(staging, path.basename(relative))
    atomicWriteFile(file, decorateTsv(tsv, table))
    tableFiles.push({ table, relative, file })
  }

  const figureFiles = []
  for (let index = 0; index < figures.length; index += 1) {
    const figure = figures[index]
    const stem = `${String(index + 1).padStart(2, '0')}_${slug(figure.kind || path.basename(figure.source_path, path.extname(figure.source_path)), 'figure')}`
    const ext = path.extname(figure.source_path).toLowerCase() || '.png'
    const relative = `figures/${stem}${ext}`
    const file = await copyIntoStaging(figure.source_path, staging, path.basename(relative))
    figure.figure_id = `fig_${step.step_id}_${index + 1}`
    figure.relative_path = relative
    figure.bytes = fileSize(file)
    figure.sha256 = await sha256File(file)
    figureFiles.push({ figure, relative, file })
    if (figure.plot_data) {
      const dataRelative = `figures/${stem}.plotdata.json`
      atomicWriteJson(path.join(staging, path.basename(dataRelative)), {
        figure_id: figure.figure_id,
        title: figure.title,
        kind: figure.kind,
        source: figure.source_path,
        plot_data: figure.plot_data,
      })
      figureFiles.push({ figure, relative: dataRelative, file: path.join(staging, path.basename(dataRelative)), auxiliary: true })
    }
  }

  const tablesIndex = {
    schema_version: DELIVER_SCHEMA_VERSION,
    run_id: run.run_id,
    step_id: step.step_id,
    plugin: step.plugin,
    action: step.action,
    tables: tables.map((table) => ({
      table_id: table.table_id,
      title: table.title,
      note: table.note,
      evidence_kind: table.evidence_kind,
      contrast_id: table.contrast_id,
      columns: table.columns,
      rows: table.rows.length,
      file: `results/${table.table_id}.tsv`,
    })),
    figures: figures.map((figure) => ({
      figure_id: figure.figure_id,
      title: figure.title,
      kind: figure.kind,
      format: figure.format,
      file: figure.relative_path,
      source_table_ids: figure.source_table_ids,
      dpi: figure.dpi,
    })),
  }
  // 额外产物（如 harmonize 的归一化矩阵 .tsv.gz）：result.artifacts 显式声明
  const extraFiles = []
  // 防御：与表/图同路径的附加产物不再重复登记（否则 commit 会把同一文件 move 两次）
  const stagedPaths = new Set([...tableFiles.map((item) => item.relative), ...figureFiles.map((item) => item.relative)])
  for (const entry of Array.isArray(result && result.artifacts) ? result.artifacts : []) {
    if (!entry || !entry.source || !existsSync(entry.source)) continue
    let relative = String(entry.relative_path || `results/${safeName(entry.name || path.basename(entry.source), 'artifact')}`)
    relative = relative.replace(/^\.?\.?\//, '').replace(/^\.?\//, '')
    if (!relative.startsWith('results/') && !relative.startsWith('artifacts/')) relative = `results/${path.basename(relative)}`
    if (stagedPaths.has(relative)) continue
    stagedPaths.add(relative)
    const file = await copyIntoStaging(entry.source, staging, path.basename(relative))
    extraFiles.push({
      relative,
      file,
      kind: entry.kind || 'artifact',
      name: entry.name || path.basename(relative),
      bytes: fileSize(file),
    })
  }

  const indexFile = path.join(staging, 'tables.index.json')
  atomicWriteJson(indexFile, tablesIndex)

  return {
    staging,
    rawFile,
    tables,
    figures,
    tableFiles,
    figureFiles,
    extraFiles,
    indexFile,
    tablesIndex,
    summary: summarizeResult(result),
  }
}

function decorateTsv(tsv, table) {
  // 让每个结果表自描述：标题/说明/证据类型放注释行会被普通 TSV 解析器当数据，
  // 所以元数据放 results/<table>.meta.json；这里保持纯数据表。
  return tsv
}

/**
 * 把文件放进 staging。内置步骤（harmonize/joint_prepare）产出的文件本来就在 staging 里，
 * 这时 source === dest：copyFile 到同一路径会把目标截断后再读，结果文件消失
 * （joint plot 的 `rename ... joint_plot_data.tsv → ENOENT` 就是这么来的）。
 */
async function copyIntoStaging(source, staging, name) {
  const dest = path.join(staging, name)
  ensureDir(path.dirname(dest))
  if (path.resolve(source) === path.resolve(dest)) return dest
  await copyFile(source, dest)
  return dest
}

async function copyFile(source, dest) {
  ensureDir(path.dirname(dest))
  await pipeline(createReadStream(source), createWriteStream(dest))
}

function summarizeResult(result) {
  if (!result || typeof result !== 'object') return null
  const summary = {}
  if (result.summary && typeof result.summary === 'object') summary.summary = result.summary
  if (typeof result.method === 'string') summary.method = result.method
  if (result.metrics && typeof result.metrics === 'object') summary.metrics = result.metrics
  if (result.warnings && Array.isArray(result.warnings)) summary.warnings = result.warnings.slice(0, 20)
  if (result.dataset && typeof result.dataset === 'object') {
    summary.dataset = {
      id: result.dataset.id, name: result.dataset.name,
      n_samples: result.dataset.n_samples, n_genes: result.dataset.n_genes,
      n_obs: result.dataset.n_obs, n_vars: result.dataset.n_vars,
      groups: result.dataset.groups, steps: result.dataset.steps,
    }
  }
  return summary
}

/**
 * 提交 staging → run 目录。取消/失败后拒绝写入并清 staging。
 * @returns {Array} 已登记 artifacts
 */
export async function commitStepResult({ store, run, runDir, staged, step }) {
  store.assertWritable(run.run_id)
  const committed = []
  const move = async (from, relative) => {
    store.assertWritable(run.run_id)
    const to = path.join(runDir, relative)
    ensureDir(path.dirname(to))
    atomicMove(from, to)
    const sha = await sha256File(to)
    return {
      kind: relative.startsWith('figures/') ? 'figure' : relative.startsWith('results/steps/') ? 'step_result' : 'table',
      relative_path: relative,
      sha256: sha,
      bytes: fileSize(to),
      name: path.basename(relative),
    }
  }

  const stepRelative = `results/steps/${safeName(step.step_id, 'step')}.json`
  const rawTo = path.join(runDir, stepRelative)
  ensureDir(path.dirname(rawTo))
  atomicMove(staged.rawFile, rawTo)
  committed.push({ kind: 'step_result', relative_path: stepRelative, sha256: await sha256File(rawTo), bytes: fileSize(rawTo), name: path.basename(stepRelative) })

  for (const item of staged.tableFiles) committed.push(await move(item.file, item.relative))
  for (const item of staged.figureFiles) committed.push(await move(item.file, item.relative))
  for (const item of staged.extraFiles || []) {
    const artifact = await move(item.file, item.relative)
    artifact.kind = item.kind || artifact.kind
    artifact.name = item.name || artifact.name
    committed.push(artifact)
  }
  const indexRelative = `results/steps/${safeName(step.step_id, 'step')}.tables.json`
  const indexTo = path.join(runDir, indexRelative)
  atomicMove(staged.indexFile, indexTo)
  committed.push({ kind: 'table_index', relative_path: indexRelative, sha256: await sha256File(indexTo), bytes: fileSize(indexTo), name: path.basename(indexRelative) })

  removeDir(staged.staging)
  for (const artifact of committed) store.addArtifact(run.run_id, artifact)
  return committed
}

export function atomicMove(from, to) {
  ensureDir(path.dirname(to))
  try {
    renameSync(from, to)
  } catch (error) {
    // 跨设备（staging 与 run 同盘，理论不会发生）：退化为 copy + unlink
    if (error && error.code === 'EXDEV') {
      atomicWriteFile(to, readFileSync(from))
      rmSync(from, { force: true })
    } else {
      throw error
    }
  }
}

// ---------------------------------------------------------------------------
// design.tsv / qc.tsv
// ---------------------------------------------------------------------------

export function designRows(dataset, plan) {
  const design = (dataset && dataset.design) || {}
  const samples = Array.isArray(design.samples) ? design.samples : []
  const groupCounts = new Map()
  const donorCounts = new Map()
  for (const sample of samples) {
    const group = String(sample.group ?? '')
    if (!group) continue
    groupCounts.set(group, (groupCounts.get(group) || 0) + 1)
    const donor = String(sample.donor_id || sample.donor || sample.sample_id || sample.name || '')
    if (!donorCounts.has(group)) donorCounts.set(group, new Set())
    donorCounts.get(group).add(donor)
  }
  const contrast = plan && plan.contrast ? plan.contrast : null
  return samples.map((sample) => {
    const group = String(sample.group ?? '')
    const role = contrast
      ? (group === contrast.case ? 'case' : group === contrast.control ? 'control' : 'other')
      : (group ? 'group' : 'unknown')
    return {
      sample_id: sample.sample_id ?? sample.id ?? sample.name ?? '',
      display_name: sample.display_name || sample.name || '',
      group,
      donor_id: sample.donor_id || sample.donor || '',
      batch: sample.batch || '',
      pair_id: sample.pair_id || sample.pair || '',
      material: sample.material || sample.tissue || '',
      role,
      n_group_samples: groupCounts.get(group) || 0,
      n_group_donors: donorCounts.has(group) ? donorCounts.get(group).size : 0,
      included: sample.included === false ? 'no' : 'yes',
      exclusion_reason: sample.exclusion_reason || sample.reason || '',
    }
  })
}

export function writeDesignTsv(runDir, dataset, plan) {
  const rows = designRows(dataset, plan)
  // row_id 显式成列：design.tsv 每行的引用锚点（证据/图注都用它定位样本）。
  const columns = ['row_id', 'sample_id', 'display_name', 'group', 'donor_id', 'batch', 'pair_id', 'material',
    'role', 'n_group_samples', 'n_group_donors', 'included', 'exclusion_reason']
  // 单行表头（普通 TSV 解析器可直接读；标签行会被当数据）
  const lines = [columns.join('\t')]
  rows.forEach((row, index) => {
    const cells = columns.map((column) => tsvCell(column === 'row_id' ? index + 1 : row[column]))
    lines.push(cells.join('\t'))
  })
  const file = path.join(runDir, 'design.tsv')
  atomicWriteFile(file, lines.join('\n') + '\n')
  return { file, relative: 'design.tsv', rows: rows.length }
}

function sampleKeyOfRow(row) {
  const keys = Object.keys(row || {})
  const key = keys.find((name) => /^(sample|sample_id|sample_name|barcode|gsm|donor)$/i.test(name))
  return key ? String(row[key]) : null
}

export function writeQcTsv(runDir, stepOutputs) {
  const qcTables = []
  for (const output of stepOutputs) {
    if (!output || !Array.isArray(output.tables)) continue
    const deliverKind = output.step && output.step.deliver ? String(output.step.deliver.kind || '') : ''
    for (const table of output.tables) {
      const id = String(table.table_id || table.title || '').toLowerCase()
      if (['qc', 'filter', 'normalize', 'cluster', 'embed'].includes(deliverKind) || /qc|quality|filter|sample|细胞|质控/.test(id)) {
        qcTables.push({ ...table, step_id: output.step ? output.step.step_id : null })
      }
    }
  }
  const columns = []
  const seen = new Set(['table_id', 'row_id'])
  for (const table of qcTables) {
    for (const column of table.columns || []) {
      const key = String(column.key)
      if (!seen.has(key)) { seen.add(key); columns.push({ key, label: column.label || key }) }
    }
  }
  // 单行表头（与 results/*.tsv、design.tsv 一致；标签行会被普通解析器当数据行）
  const lines = [['table_id', ...columns.map((column) => column.key), 'row_id'].join('\t')]
  for (const table of qcTables) {
    const tableColumnsSpec = table.columns || []
    const rows = Array.isArray(table.rows) ? table.rows : []
    rows.forEach((row, index) => {
      const object = rowObject({ columns: tableColumnsSpec }, row)
      const values = [table.table_id, ...columns.map((column) => tsvCell(object[column.key])), String(index + 1)]
      lines.push(values.join('\t'))
    })
  }
  if (!qcTables.length) {
    lines.push(['none', ...columns.map(() => ''), '0'].join('\t'))
  }
  const file = path.join(runDir, 'qc.tsv')
  atomicWriteFile(file, lines.join('\n') + '\n')
  return { file, relative: 'qc.tsv', tables: qcTables.length, metrics: columns.length }
}

// ---------------------------------------------------------------------------
// methods.md
// ---------------------------------------------------------------------------

export function renderMethods({ run, plan, dataset, manifest, stepOutputs }) {
  const lines = []
  lines.push('# Methods · ' + run.run_id)
  lines.push('')
  lines.push('> 本文件由 dsh-bioflow 从 manifest 与各步骤真实返回值生成；数值与方法名来自引擎返回，不手工补写。')
  lines.push('')
  lines.push('## 数据与版本')
  lines.push('')
  if (dataset) {
    lines.push(`- 数据集：${dataset.name || dataset.dataset_id}（dataset_id \`${dataset.dataset_id}\`，revision \`${dataset.dataset_id}\`）`)
    lines.push(`- 来源：${(dataset.source && dataset.source.kind) || 'local'}${dataset.source && dataset.source.gse ? ` / ${dataset.source.gse}` : ''}`)
    lines.push(`- 物种/平台/assay：${dataset.species || '未声明'} / ${dataset.platform || '未声明'} / ${dataset.assay || '未声明'}`)
    lines.push(`- 尺度：${(dataset.scale && dataset.scale.type) || 'unknown'}（verified=${Boolean(dataset.scale && dataset.scale.verified)}）`)
    for (const file of dataset.files || []) {
      lines.push(`- 文件：\`${file.name}\` sha256=\`${file.sha256}\`（${file.bytes || 0} B）`)
    }
  } else {
    lines.push('- 数据集：未绑定（联合分析/内置计算）')
  }
  lines.push('')
  lines.push('## 设计')
  lines.push('')
  if (plan && plan.design) {
    const design = plan.design
    lines.push(`- 分组列：${design.group_column || '—'}；供体列：${design.donor_column || '—'}；配对：${design.paired ? '是' : '否'}`)
    lines.push(`- 组与样本数：${Object.entries(design.n_per_group || {}).map(([group, n]) => `${group}=${n}`).join('、') || '—'}`)
    lines.push(`- 每组独立样本（供体）：${Object.entries(design.donors_per_group || {}).map(([group, n]) => `${group}=${n}`).join('、') || '—'}`)
    lines.push(`- contrast：${design.contrast || '未定义'}`)
    lines.push(`- 协变量：${(design.covariates || []).join('、') || '无'}`)
  }
  lines.push('')
  lines.push('## 步骤与方法')
  lines.push('')
  for (const output of stepOutputs) {
    const step = output.step
    const summary = output.summary || {}
    lines.push(`### ${step.step_id} · ${step.plugin} / ${step.action}`)
    lines.push('')
    lines.push(`- 状态：${output.status || 'ok'}`)
    if (summary.method) lines.push(`- 方法：${summary.method}`)
    if (summary.summary && summary.summary.title) lines.push(`- 摘要：${summary.summary.title}`)
    if (summary.summary && Array.isArray(summary.summary.bullets) && summary.summary.bullets.length) {
      for (const bullet of summary.summary.bullets.slice(0, 6)) lines.push(`  - ${bullet}`)
    }
    if (summary.metrics) lines.push(`- 指标：\`${stableStringify(summary.metrics).slice(0, 600)}\``)
    const tables = (output.tables || []).map((table) => `${table.table_id}(${table.rows.length} 行)`).join('、')
    if (tables) lines.push(`- 结果表：${tables}`)
    const figures = (output.figures || []).map((figure) => figure.figure_id).join('、')
    if (figures) lines.push(`- 图：${figures}`)
    if (output.warnings && output.warnings.length) lines.push(`- warnings：${output.warnings.slice(0, 6).join('；')}`)
    lines.push('')
  }
  lines.push('## 统计与多重校正')
  lines.push('')
  lines.push(`- FDR 检验族与阈值：${(plan && plan.params && plan.params.fdr) || 'BH FDR 0.05（由引擎默认实现）'}；evidence alpha=${manifest.evidence.alpha}`)
  lines.push('- 全量统计表保留 p/q/effect/有效 n；零显著是合法结果（不伪造显著项）。')
  lines.push('')
  lines.push('## 闸门与限制')
  lines.push('')
  const failedGates = (plan && plan.gates ? plan.gates : []).filter((gate) => gate.status === 'fail')
  if (failedGates.length) for (const gate of failedGates) lines.push(`- 未通过：${gate.title} — ${gate.detail}`)
  else lines.push('- 计划闸门在提交前全部通过。')
  if (manifest.zero_significant === true) lines.push('- 本次分析未检出显著结果（零显著）；这不等同于"无差异"，见各表的 CI 与有效 n。')
  for (const warning of manifest.warnings || []) lines.push(`- warning：${warning}`)
  lines.push('')
  lines.push('## 环境')
  lines.push('')
  lines.push(`- Node ${manifest.environment.node}；bioflow ${manifest.environment.bioflow_version}；平台 ${manifest.environment.platform}`)
  for (const [plugin, info] of Object.entries(manifest.environment.plugins || {})) {
    lines.push(`- ${plugin}: ${info.module_path || '—'}${info.python ? `；python ${info.python_version || ''}` : ''}`)
  }
  lines.push('')
  lines.push('## 可回查性')
  lines.push('')
  lines.push(`- manifest.json：run_id \`${run.run_id}\`，plan_id \`${run.plan_id}\``)
  lines.push('- results/*.tsv + results/tables.index.json：table_id / row_id / contrast_id / FDR 家族；evidence.jsonl 的 claim 绑定这些行。')
  lines.push('- 原始引擎返回：results/steps/<step>.json（逐字节保存，未重算）。')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

/**
 * 写全部交付物并给出终态。
 * @param {object} input
 * @param {object} input.store
 * @param {object} input.run
 * @param {object} input.plan
 * @param {object} input.dataset
 * @param {Array} input.stepOutputs [{step,status,result,tables,figures,summary,warnings,error,stepRecord}]
 * @param {object} input.environment
 * @param {string} input.status succeeded|partial|failed
 * @param {Array} input.warnings
 */
export async function finalizeRun({ store, run, plan, dataset, stepOutputs, environment, status, warnings = [] }) {
  store.assertWritable(run.run_id)
  const runDir = store.runDir(run.run_id)
  ensureDir(runDir)

  const design = writeDesignTsv(runDir, dataset, plan)
  const qc = writeQcTsv(runDir, stepOutputs)

  // 结果表：从 stepOutputs 汇总（commit 阶段已写 results/*.tsv；这里生成索引与 meta）
  const tables = []
  const figures = []
  const indexedTables = []
  for (const output of stepOutputs) {
    for (const table of output.tables || []) {
      tables.push(table)
      indexedTables.push({
        table_id: table.table_id,
        title: table.title,
        evidence_kind: table.evidence_kind,
        contrast_id: table.contrast_id,
        rows: table.rows.length,
        columns: table.columns,
        step_id: table.step_id,
        relative_path: `results/${table.table_id}.tsv`,
      })
    }
    for (const figure of output.figures || []) figures.push(figure)
  }
  const tableIndex = {
    schema_version: DELIVER_SCHEMA_VERSION,
    run_id: run.run_id,
    generated_at: nowIso(),
    tables: indexedTables,
    figures: figures.map((figure) => ({
      figure_id: figure.figure_id,
      title: figure.title,
      kind: figure.kind,
      format: figure.format,
      file: figure.relative_path,
      dpi: figure.dpi,
      source_table_ids: figure.source_table_ids,
      sha256: figure.sha256,
    })),
  }
  atomicWriteJson(path.join(runDir, 'results', 'tables.index.json'), tableIndex)

  const evidence = buildEvidence({
    run, plan,
    tables: tables.map((table) => ({ ...table, relative_path: `results/${table.table_id}.tsv` })),
    figures,
    steps: stepOutputs.map((output) => ({ ...output.step, status: output.status })),
    alpha: Number(plan && plan.params && plan.params.alpha) > 0 ? Number(plan.params.alpha) : 0.05,
    limit: Number(plan && plan.params && plan.params.evidence_limit) > 0 ? Number(plan.params.evidence_limit) : 500,
  })
  atomicWriteFile(path.join(runDir, 'evidence.jsonl'), renderEvidenceJsonl(evidence.records))

  // 零显著判定：只针对含推断统计的实测/预测表
  const inferential = tables.filter((table) => {
    const shape = describeTable(table)
    return shape.inferential && table.evidence_kind !== 'descriptive'
  })
  let zeroSignificant = null
  if (inferential.length) {
    zeroSignificant = true
    for (const table of inferential) {
      const shape = describeTable(table)
      for (const row of table.rows) {
        const object = rowObject(table, row)
        const q = shape.q ? Number(object[shape.q]) : null
        const p = shape.p ? Number(object[shape.p]) : null
        if (Number.isFinite(q) && q <= 0.05) { zeroSignificant = false; break }
        if (!Number.isFinite(q) && Number.isFinite(p) && p <= 0.05) { zeroSignificant = false; break }
      }
      if (!zeroSignificant) break
    }
  }

  const manifest = {
    schema_version: DELIVER_SCHEMA_VERSION,
    run_id: run.run_id,
    plan_id: run.plan_id,
    // 冻结的完整计划（模板/步骤/参数/闸门/contrast）：manifest 单文件即可复现，不必回查 store。
    plan: plan || null,
    template: run.template,
    template_version: run.template_version,
    dataset: dataset ? {
      dataset_id: dataset.dataset_id,
      revision: dataset.dataset_id,
      name: dataset.name,
      source: dataset.source,
      assay: dataset.assay,
      species: dataset.species,
      platform: dataset.platform,
      reference: dataset.reference,
      scale: dataset.scale,
      files: (dataset.files || []).map((file) => ({ name: file.name, path: file.path, bytes: file.bytes, sha256: file.sha256, artifact_id: file.artifact_id })),
      clinical: dataset.clinical || null,
      sample_sheet: dataset.sample_sheet || null,
    } : null,
    environment: environment || {},
    params: (plan && plan.params) || run.params || {},
    seed: run.seed,
    contrast: (plan && plan.contrast) || null,
    design: (plan && plan.design) || null,
    gates: (plan && plan.gates) || [],
    steps: stepOutputs.map((output) => ({
      step_id: output.step.step_id,
      plugin: output.step.plugin,
      action: output.step.action,
      status: output.status,
      optional: Boolean(output.step.optional),
      deliver: output.step.deliver || null,
      started_at: output.stepRecord ? output.stepRecord.started_at : null,
      finished_at: output.stepRecord ? output.stepRecord.finished_at : null,
      error: output.error || null,
      tables: (output.tables || []).map((table) => table.table_id),
      figures: (output.figures || []).map((figure) => figure.figure_id),
    })),
    warnings: [...new Set([...(warnings || []), ...(run.warnings || [])])],
    status,
    ok: status === 'succeeded',
    zero_significant: zeroSignificant,
    evidence: evidence.summary,
    deliverables: {
      manifest: 'manifest.json',
      design: design.relative,
      qc: qc.relative,
      results: 'results/*.tsv',
      tables_index: 'results/tables.index.json',
      figures: 'figures/',
      evidence: 'evidence.jsonl',
      methods: 'methods.md',
    },
    parent_run: run.parent_run || null,
    created_at: run.created_at,
    finished_at: nowIso(),
    artifacts: [],
  }

  const methods = renderMethods({ run, plan, dataset, manifest, stepOutputs })
  atomicWriteFile(path.join(runDir, 'methods.md'), methods)

  // 收集交付文件 + 哈希（manifest 自身最后写，不能自引用）
  const deliverFiles = []
  const addFile = async (relative) => {
    const file = path.join(runDir, relative)
    if (!existsSync(file)) return
    deliverFiles.push({
      artifact_id: await sha256File(file),
      kind: relative.startsWith('figures/') ? 'figure'
        : relative === 'manifest.json' ? 'manifest'
          : relative === 'evidence.jsonl' ? 'evidence'
            : relative === 'methods.md' ? 'methods'
              : relative.endsWith('.tsv') ? 'table' : 'file',
      relative_path: relative,
      sha256: await sha256File(file),
      bytes: fileSize(file),
      name: path.basename(relative),
    })
  }
  await addFile('design.tsv')
  await addFile('qc.tsv')
  await addFile('results/tables.index.json')
  await addFile('evidence.jsonl')
  await addFile('methods.md')
  // step 原始返回与结果表/图：从 store artifacts 里补齐
  for (const artifact of store.listArtifacts(run.run_id)) {
    if (!deliverFiles.some((item) => item.relative_path === artifact.relative_path)) {
      deliverFiles.push({ ...artifact })
    }
  }
  for (const output of stepOutputs) {
    for (const figure of output.figures || []) {
      if (figure.relative_path && !deliverFiles.some((item) => item.relative_path === figure.relative_path)) {
        await addFile(figure.relative_path)
      }
    }
  }
  manifest.artifacts = deliverFiles
    .filter((item) => item.relative_path !== 'manifest.json')
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path))
  manifest.content_hash = sha256Json({ ...manifest, artifacts: manifest.artifacts })

  const manifestPath = path.join(runDir, 'manifest.json')
  atomicWriteJson(manifestPath, manifest)
  const manifestSha = await sha256File(manifestPath)

  // 把最终交付文件（design/qc/tables.index/evidence/methods）也登记成 run artifact。
  // 此前它们只写进 manifest.artifacts，run.artifacts 里没有，导致 action=export 只导出
  // 步骤产物（results/steps、results/*.tsv、figures），漏掉这几份核心交付物。
  for (const item of manifest.artifacts) {
    store.addArtifact(run.run_id, {
      kind: item.kind,
      relative_path: item.relative_path,
      sha256: item.sha256,
      bytes: item.bytes,
      name: item.name,
    })
  }

  // 登记 manifest 自身（此时 run 仍可写）
  const manifestArtifact = {
    kind: 'manifest',
    relative_path: 'manifest.json',
    sha256: manifestSha,
    bytes: fileSize(manifestPath),
    name: 'manifest.json',
  }
  store.addArtifact(run.run_id, manifestArtifact)
  const finalRun = store.transition(run.run_id, status, {
    zero_significant: zeroSignificant,
    manifest_sha256: manifestSha,
    error: status === 'failed' ? (stepOutputs.find((output) => output.status === 'failed') || {}).error || '步骤失败' : null,
  })
  return { run: finalRun, manifest, manifest_sha256: manifestSha, evidence: evidence.summary, zero_significant: zeroSignificant, runDir }
}

// ---------------------------------------------------------------------------
// 读回（export / evidence 用）
// ---------------------------------------------------------------------------

export function readRunTablesFile(store, runId) {
  const file = path.join(store.runDir(runId), 'results', 'tables.index.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function readDelimitedFile(file) {
  try { return parseDelimited(readFileSync(file, 'utf8')) } catch { return null }
}
