/**
 * dsh-bioflow — 证据索引（evidence.jsonl）
 *
 * 每条证据绑定：run_id / contrast_id / table_id / row_id / figure_id，
 * 并区分 evidence_kind：
 *   measured         实测（差异、富集、组成、meta 分析…）
 *   descriptive      描述性（QC、样本设计、批次评估）
 *   model_prediction 模型预测（VirtualCell 扰动、跨模态签名映射…）—— 不得混入实测证据
 *
 * 证据索引不是结果表的副本：全量数值在 results/*.tsv；这里索引"可被引用的 claim"。
 * 对超大结果表只索引显著行 + 每表前 N 行，并在 coverage 里写清 rows_total / rows_indexed
 * （截断必须显式，不能悄悄丢）。
 */

import { sha256Json, stableStringify } from './store.mjs'

export const EVIDENCE_SCHEMA_VERSION = 1
export const EVIDENCE_KINDS = ['measured', 'descriptive', 'model_prediction']
export const DEFAULT_INDEX_LIMIT = 500
export const DEFAULT_SIGNIFICANCE_Q = 0.05

const FEATURE_KEYS = ['gene', 'feature', 'gene_id', 'gene_symbol', 'cell_type', 'pathway', 'term', 'metabolite',
  'feature_id', 'protein', 'transcript', 'module', 'cluster', 'label', 'name', 'id']
const EFFECT_KEYS = ['log2fc', 'logfc', 'logfc_mean', 'effect', 'estimate', 'coef', 'coefficient', 'delta', 'mean_diff',
  'log2foldchange', 'stat', 't_stat', 'z', 'score', 'auc', 'hr', 'odds_ratio']
const P_KEYS = ['p', 'pval', 'p_value', 'pval_raw', 'p_value_raw']
const Q_KEYS = ['pval_adj', 'padj', 'q', 'qval', 'fdr', 'p_adj', 'adj_p', 'q_value', 'p_adjusted']
const N_KEYS = ['n', 'n_samples', 'n_cells', 'n_genes', 'n_in', 'n_out', 'n_donors', 'n_per_group', 'n_obs', 'n_features']
const DIRECTION_KEYS = ['direction', 'sign', 'updown', 'trend']

function keysOf(table) {
  const columns = table && Array.isArray(table.columns) ? table.columns : []
  const fromColumns = columns.map((column) => String(column.key ?? column).toLowerCase())
  const fromRows = table && Array.isArray(table.rows) && table.rows.length && !Array.isArray(table.rows[0])
    ? Object.keys(table.rows[0]).map((key) => key.toLowerCase())
    : []
  return [...new Set([...fromColumns, ...fromRows])]
}

function findKey(keys, candidates) {
  for (const candidate of candidates) if (keys.includes(candidate)) return candidate
  for (const key of keys) if (candidates.some((candidate) => key.endsWith(`_${candidate}`) || key.startsWith(`${candidate}_`))) return key
  return null
}

function valueAt(row, key) {
  if (!key) return null
  if (Array.isArray(row)) return null
  if (row && Object.prototype.hasOwnProperty.call(row, key)) return row[key]
  const lower = Object.keys(row || {}).find((candidate) => candidate.toLowerCase() === key)
  return lower ? row[lower] : null
}

function numeric(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = String(value).trim()
  if (!text) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

/** 判定一张表是否含推断统计（p/q/effect），并给出索引用的列名。 */
export function describeTable(table) {
  const keys = keysOf(table)
  const feature = findKey(keys, FEATURE_KEYS)
  const effect = findKey(keys, EFFECT_KEYS)
  const p = findKey(keys, P_KEYS)
  const q = findKey(keys, Q_KEYS)
  const n = findKey(keys, N_KEYS)
  const direction = findKey(keys, DIRECTION_KEYS)
  const rows = Array.isArray(table.rows) ? table.rows : []
  const inferential = Boolean(q || p || effect)
  return { keys, feature, effect, p, q, n, direction, rows: rows.length, inferential }
}

export function tableColumns(table) {
  if (Array.isArray(table.columns) && table.columns.length) {
    return table.columns.map((column, index) => {
      if (typeof column === 'string') return { key: column, label: column }
      return {
        key: String(column.key ?? column.id ?? `col_${index}`),
        label: String(column.label ?? column.title ?? column.key ?? `col_${index}`),
      }
    })
  }
  const rows = Array.isArray(table.rows) ? table.rows : []
  if (rows.length && !Array.isArray(rows[0])) {
    return Object.keys(rows[0]).map((key) => ({ key, label: key }))
  }
  return []
}

/** 行 → {key: value} 对象（兼容插件返回的数组行）。 */
export function rowObject(table, row) {
  if (row && typeof row === 'object' && !Array.isArray(row)) return row
  const columns = tableColumns(table)
  const object = {}
  columns.forEach((column, index) => {
    object[column.key] = Array.isArray(row) ? row[index] : undefined
  })
  return object
}

function claimText(table, row, keys, contrastId) {
  const feature = keys.feature ? valueAt(row, keys.feature) : null
  const effect = keys.effect ? numeric(valueAt(row, keys.effect)) : null
  const q = keys.q ? numeric(valueAt(row, keys.q)) : null
  const p = keys.p ? numeric(valueAt(row, keys.p)) : null
  const direction = keys.direction ? valueAt(row, keys.direction) : null
  const label = table.title || table.table_id || 'result'
  const subject = feature === null || feature === undefined || String(feature).trim() === ''
    ? label
    : String(feature)
  const parts = [subject]
  if (direction) parts.push(String(direction))
  if (contrastId) parts.push(`[${contrastId}]`)
  if (effect !== null) parts.push(`effect=${effect}`)
  if (q !== null) parts.push(`q=${q}`)
  else if (p !== null) parts.push(`p=${p}`)
  return parts.join(' ')
}

function significanceOf(table, row, keys, alpha) {
  const q = keys.q ? numeric(valueAt(row, keys.q)) : null
  if (q !== null) return { significant: q <= alpha, q, p: keys.p ? numeric(valueAt(row, keys.p)) : null }
  const p = keys.p ? numeric(valueAt(row, keys.p)) : null
  if (p !== null) return { significant: p <= alpha, q: null, p }
  return { significant: false, q: null, p: null }
}

/**
 * 从已抽好的表清单构建证据记录。
 * @param {object} input
 * @param {object} input.run
 * @param {object} input.plan
 * @param {Array} input.tables  [{table_id,title,columns,rows,evidence_kind,contrast_id,step_id,file?}]
 * @param {Array} input.figures [{figure_id,title,kind,relative_path,source_table_ids}]
 * @param {Array} input.steps   [{step_id,status,plugin,action}]
 * @param {number} input.alpha
 * @param {number} input.limit  每表最多索引行数
 */
export function buildEvidence({ run, plan, tables = [], figures = [], steps = [], alpha = DEFAULT_SIGNIFICANCE_Q, limit = DEFAULT_INDEX_LIMIT }) {
  const records = []
  const coverage = []
  const contrastId = plan && plan.contrast ? plan.contrast.contrast_id : null
  const runId = run.run_id
  const datasetId = run.dataset_id
  const datasetRevision = run.dataset_revision

  for (const table of tables) {
    const rows = Array.isArray(table.rows) ? table.rows : []
    const shape = describeTable(table)
    const tableId = table.table_id
    const tableKind = table.evidence_kind || (shape.inferential ? 'measured' : 'descriptive')
    const tableContrast = table.contrast_id || contrastId
    const indexed = []
    const significantRows = []
    rows.forEach((row, index) => {
      const object = rowObject(table, row)
      const sig = shape.inferential ? significanceOf(table, object, shape, alpha) : null
      if (sig && sig.significant) significantRows.push(index)
    })
    const indexSet = new Set()
    for (const index of significantRows.slice(0, limit)) indexSet.add(index)
    for (let index = 0; index < Math.min(rows.length, Math.min(20, limit)); index += 1) indexSet.add(index)
    for (const index of [...indexSet].sort((a, b) => a - b)) indexed.push(index)

    for (const index of indexed) {
      const object = rowObject(table, rows[index])
      const sig = shape.inferential ? significanceOf(table, object, shape, alpha) : null
      const record = {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        claim_id: `${runId}:${tableId}:${index + 1}`,
        evidence_kind: tableKind,
        claim: tableKind === 'descriptive'
          ? `${table.title || tableId} 描述性数值`
          : claimText(table, object, shape, tableContrast),
        run_id: runId,
        dataset_id: datasetId,
        dataset_revision: datasetRevision,
        plan_id: run.plan_id,
        contrast_id: tableContrast,
        table_id: tableId,
        row_id: index + 1,
        step_id: table.step_id || null,
        plugin: table.plugin || null,
        feature: shape.feature ? valueAt(object, shape.feature) : null,
        effect: shape.effect ? numeric(valueAt(object, shape.effect)) : null,
        p: sig ? sig.p : null,
        q: sig ? sig.q : null,
        n: shape.n ? numeric(valueAt(object, shape.n)) : null,
        significant: sig ? sig.significant : null,
        source_file: table.relative_path || null,
        figure_ids: [],
      }
      records.push(stripNulls(record))
    }
    coverage.push({
      table_id: tableId,
      title: table.title || null,
      evidence_kind: tableKind,
      rows_total: rows.length,
      rows_indexed: indexed.length,
      truncated: indexed.length < rows.length,
      significant_rows: significantRows.length,
      source_file: table.relative_path || null,
    })
  }

  // 图：一条记录绑定它引用的源表；没有源表的图不伪造 claim
  for (const figure of figures) {
    const record = {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      claim_id: `${runId}:figure:${figure.figure_id}`,
      evidence_kind: figure.evidence_kind || 'descriptive',
      claim: `图 ${figure.figure_id}：${figure.title || figure.kind || ''}`,
      run_id: runId,
      dataset_id: datasetId,
      dataset_revision: datasetRevision,
      plan_id: run.plan_id,
      contrast_id: figure.contrast_id || contrastId,
      table_id: null,
      row_id: null,
      figure_id: figure.figure_id,
      source_table_ids: figure.source_table_ids || [],
      source_file: figure.relative_path || null,
    }
    records.push(stripNulls(record))
  }

  const stepsMissing = (steps || []).filter((step) => step.status === 'failed' && EVIDENCE_KINDS.includes(step.evidence_kind || ''))
  const summary = {
    records: records.length,
    measured: records.filter((item) => item.evidence_kind === 'measured').length,
    descriptive: records.filter((item) => item.evidence_kind === 'descriptive').length,
    model_prediction: records.filter((item) => item.evidence_kind === 'model_prediction').length,
    figures: figures.length,
    coverage,
    failed_steps: stepsMissing.map((step) => step.step_id),
    alpha,
    note: 'evidence.jsonl 是 claim 索引；全量数值在 results/*.tsv（含 row_id 与 table index）。',
  }
  return { records, summary }
}

function stripNulls(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value === null || value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    out[key] = value
  }
  return out
}

export function renderEvidenceJsonl(records) {
  return (records || []).map((record) => JSON.stringify(record)).join('\n') + ((records || []).length ? '\n' : '')
}

/** 审计用：证据引用的表/行/图是否真实存在。 */
export function verifyEvidence(records, { tableIndex = {}, figures = [] } = {}) {
  const issues = []
  const figureIds = new Set(figures.map((figure) => figure.figure_id))
  for (const record of records || []) {
    if (!record.run_id) issues.push({ claim_id: record.claim_id, issue: '缺 run_id' })
    if (!record.evidence_kind || !EVIDENCE_KINDS.includes(record.evidence_kind)) {
      issues.push({ claim_id: record.claim_id, issue: `非法 evidence_kind=${record.evidence_kind}` })
    }
    if (record.table_id) {
      const table = tableIndex[record.table_id]
      if (!table) {
        issues.push({ claim_id: record.claim_id, issue: `引用的表不存在：${record.table_id}` })
      } else if (!record.row_id || record.row_id < 1 || record.row_id > table.rows) {
        issues.push({ claim_id: record.claim_id, issue: `row_id 超出范围：${record.table_id}#${record.row_id}` })
      }
    }
    if (record.figure_id && !figureIds.has(record.figure_id)) {
      issues.push({ claim_id: record.claim_id, issue: `引用的图不存在：${record.figure_id}` })
    }
  }
  return { ok: issues.length === 0, issues, checked: (records || []).length }
}

export function evidenceDigest(records) {
  return sha256Json((records || []).map((record) => record.claim_id + ':' + stableStringify(record)))
}
