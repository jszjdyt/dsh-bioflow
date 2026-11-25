/**
 * dsh-bioflow — joint：多队列 meta 分析 / 跨模态签名映射 / 联合出图
 *
 * 三种联合（lead 追加的硬要求）：
 *   a. meta：逐队列 DE → fixed / random effect 合并，报 I²、异质性、每队列 n；
 *   b. signature：bulk 签名 → scRNA 打分（走 geobulk 已有 scmap 路径），evidence_kind=model_prediction；
 *   c. plot：统一走 plotlab，每个面板的 plot data 与统计表同源可回查。
 *
 * 数值表带 table_id/row_id/contrast/effect/SE/p/q/FDR family/有效 n（由 deliver 统一补）。
 * 未做批次校正的跨数据集合并推断在 run 层被 blocked（见 impl 的 joint 闸门）。
 */

import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import {
  atomicWriteFile, ensureDir, nowIso, parseDelimited, safeName, sha256File, tsvCell,
} from './store.mjs'

export const JOINT_MODES = ['meta', 'signature', 'plot']
export const META_EFFECT_MODELS = ['fixed', 'random', 'both']

function jointError(code, message, details = {}) {
  const error = Object.assign(new Error(message), { code })
  error.details = details
  return error
}

// ---------------------------------------------------------------------------
// 统计分布（无第三方库）
// ---------------------------------------------------------------------------

/** 标准正态 CDF（Abramowitz-Stegun 7.1.26 误差函数近似）。 */
export function normalCdf(z) {
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * y)
}

export function normalP(z) {
  const cdf = normalCdf(Math.abs(z))
  return Math.max(0, Math.min(1, 2 * (1 - cdf)))
}

/** 标准正态分位数（Acklam 近似，|误差|<1.2e-9）。 */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw jointError('bad_request', `normalQuantile 需要 0<p<1，收到 ${p}`)
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const plow = 0.02425
  const phigh = 1 - plow
  let q
  let r
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  q = p - 0.5
  r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** Benjamini-Hochberg FDR（完整检验族；不预先剔除）。 */
export function bhFdr(pvalues) {
  const indexed = pvalues.map((value, index) => ({ value: Number.isFinite(value) ? value : 1, index }))
  indexed.sort((a, b) => a.value - b.value)
  const n = indexed.length
  const adjusted = new Array(n)
  let previous = 1
  for (let rank = n - 1; rank >= 0; rank -= 1) {
    const item = indexed[rank]
    const q = Math.min(previous, (item.value * n) / (rank + 1))
    adjusted[item.index] = Math.min(1, Math.max(0, q))
    previous = q
  }
  return adjusted
}

// ---------------------------------------------------------------------------
// 读 run 的结果表
// ---------------------------------------------------------------------------

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 读一个 run 的 tables.index.json。 */
export function loadRunTables(store, runId) {
  const run = store.getRun(runId)
  if (!run) throw jointError('not_found', `run 不存在：${runId}`)
  const indexFile = path.join(store.runDir(runId), 'results', 'tables.index.json')
  if (!existsSync(indexFile)) throw jointError('prerequisite', `run ${runId} 没有结果表索引（可能未成功完成）`)
  const index = readJson(indexFile)
  if (!index || !Array.isArray(index.tables)) throw jointError('prerequisite', `run ${runId} 的结果表索引损坏`)
  return { run, index }
}

/** 读 run 里某张表（table_id 省略时取第一张含 effect/p 的实测表）。 */
export function loadRunTable(store, runId, tableId = null) {
  const { run, index } = loadRunTables(store, runId)
  const entries = index.tables.filter((table) => table.relative_path && existsSync(path.join(store.runDir(runId), table.relative_path)))
  if (!entries.length) throw jointError('prerequisite', `run ${runId} 没有可读的 results/*.tsv`)
  const candidates = tableId ? entries.filter((table) => table.table_id === tableId) : entries
  if (tableId && !candidates.length) {
    throw jointError('not_found', `run ${runId} 没有 table_id=${tableId}；可用：${entries.map((table) => table.table_id).join('、')}`)
  }
  const scored = candidates.map((entry) => {
    const columns = (entry.columns || []).map((column) => normKey(column.key || column))
    const hasEffect = columns.some((key) => /log2?fc|effect|estimate|coef|score|delta|meandiff/.test(key))
    const hasP = columns.some((key) => /^(p|pvalue|pval|pvaladj|padj|adjpval|q|qval|fdr|rawp)$/.test(key) || /pval|padj|fdr/.test(key))
    return { entry, score: (hasEffect ? 2 : 0) + (hasP ? 1 : 0) }
  })
  scored.sort((a, b) => b.score - a.score)
  const entry = scored[0].entry
  const file = path.join(store.runDir(runId), entry.relative_path)
  const parsed = parseDelimited(readFileSync(file, 'utf8'))
  return { run, index, table: entry, columns: parsed.header, rows: parsed.objects, file }
}

/** 列名归一化：小写并去掉空格/点/下划线/横线，让 P.Value、adj.P.Val、log2FC 都能命中。 */
function normKey(value) {
  return String(value || '').toLowerCase().replace(/[\s._\-/]+/g, '')
}

function pickColumn(columns, patterns) {
  for (const pattern of patterns) {
    const hit = columns.find((column) => pattern.test(normKey(column)))
    if (hit) return hit
  }
  return null
}

export function describeCohortTable(loaded) {
  const columns = loaded.columns.map((column) => String(column))
  return {
    feature: pickColumn(columns, [/^gene$/, /^geneid$/, /^genesymbol$/, /^symbol$/, /^feature(id)?$/, /^metabolite$/, /^protein$/, /^id$/]),
    effect: pickColumn(columns, [/^log2fc$/, /^logfc$/, /^log2foldchange$/, /^effect(size)?$/, /^estimate$/, /^coef$/, /^meandiff$/, /^delta$/, /^score$/]),
    se: pickColumn(columns, [/^se$/, /^stderr(or)?$/, /^standarderror$/, /^lfcse$/, /^selogfc$/, /^ci$/]),
    p: pickColumn(columns, [/^p$/, /^pvalue$/, /^pval$/, /^rawp$/, /^pwt$/]),
    q: pickColumn(columns, [/^padj$/, /^adjp$/, /^adjpval$/, /^pvaladj$/, /^pvalueadj$/, /^adjpvalue$/, /^q$/, /^qval$/, /^fdr$/]),
    n: pickColumn(columns, [/^n$/, /^nsamples$/, /^nin$/, /^npergroup$/, /^nobs$/]),
  }
}

// ---------------------------------------------------------------------------
// meta-analysis
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {object} input.store
 * @param {Array} input.cohorts [{run_id, table_id?, label?, effect_col?, se_col?, n_col?, n?}]
 * @param {string} input.outdir
 */
export async function runMetaAnalysis({ store, cohorts = [], outdir, alpha = 0.05, min_cohorts = 2, log = null } = {}) {
  if (!Array.isArray(cohorts) || cohorts.length < 2) {
    throw jointError('bad_request', 'meta 分析需要至少 2 个队列（cohorts: [{run_id, table_id?}]）')
  }
  ensureDir(outdir)
  const warnings = []
  const cohortData = []
  const cohortRows = []
  for (const cohort of cohorts) {
    const loaded = loadRunTable(store, cohort.run_id, cohort.table_id)
    const shape = describeCohortTable(loaded)
    const effectColumn = cohort.effect_col || shape.effect
    const seColumn = cohort.se_col || shape.se
    const pColumn = cohort.p || shape.p
    const nColumn = cohort.n_col || shape.n
    const featureColumn = cohort.feature_col || shape.feature
    if (!featureColumn) throw jointError('prerequisite', `队列 ${cohort.run_id} 的表缺少基因/特征列`)
    if (!effectColumn) throw jointError('prerequisite', `队列 ${cohort.run_id} 的表缺少 effect 列（log2FC/effect/estimate/coef）`)
    if (!seColumn && !pColumn) throw jointError('prerequisite', `队列 ${cohort.run_id} 的表需要 SE 或 p 值列才能合并`)
    const label = cohort.label || loaded.run.dataset_id || cohort.run_id
    const labelSafe = safeName(label, 'cohort')
    const methods = new Set()
    const rows = []
    let seDerived = 0
    for (const row of loaded.rows) {
      const feature = String(row[featureColumn] || '').trim()
      if (!feature) continue
      const effect = Number(row[effectColumn])
      if (!Number.isFinite(effect)) continue
      let se = seColumn ? Number(row[seColumn]) : Number.NaN
      if (!Number.isFinite(se) || se <= 0) {
        const p = pColumn ? Number(row[pColumn]) : Number.NaN
        if (Number.isFinite(p) && p > 0 && p <= 1) {
          const z = Math.abs(normalQuantile(p / 2))
          if (z > 0) { se = Math.abs(effect) / z; seDerived += 1 }
        }
      }
      if (!Number.isFinite(se) || se <= 0) continue
      const n = nColumn ? Number(row[nColumn]) : (cohort.n ?? null)
      rows.push({ feature, effect, se, p: pColumn ? Number(row[pColumn]) : null, n: Number.isFinite(n) ? n : null })
    }
    if (seDerived) warnings.push(`队列 ${label}：${seDerived} 个基因缺 SE，按 effect/p 反推 SE（假设 p 来自正态近似）`)
    cohortData.push({ run_id: cohort.run_id, label, labelSafe, table: loaded.table, rows, methods })
    cohortRows.push({
      cohort: label, run_id: cohort.run_id, table_id: loaded.table.table_id,
      rows: loaded.rows.length, usable_genes: rows.length, se_derived: seDerived,
      effect_col: effectColumn, se_col: seColumn || `derived_from_p:${pColumn}`, n_col: nColumn || null,
      n: cohort.n || (rows.find((row) => row.n !== null) || {}).n || null,
      method: (loaded.run.plan && loaded.run.plan.params && loaded.run.plan.params.method) || null,
    })
    if (log) log('meta', `cohort ${label}: ${rows.length} usable genes`)
  }

  // 逐基因合并
  const byFeature = new Map()
  for (const cohort of cohortData) {
    for (const row of cohort.rows) {
      if (!byFeature.has(row.feature)) byFeature.set(row.feature, [])
      byFeature.get(row.feature).push({ ...row, cohort: cohort.label, labelSafe: cohort.labelSafe })
    }
  }
  const resultRows = []
  let tested = 0
  for (const [feature, entries] of byFeature) {
    if (entries.length < Math.min(min_cohorts, cohortData.length)) continue
    tested += 1
    let weightSum = 0
    let weightedEffect = 0
    for (const entry of entries) {
      const weight = 1 / (entry.se * entry.se)
      weightSum += weight
      weightedEffect += weight * entry.effect
    }
    const fixedEffect = weightedEffect / weightSum
    const fixedSe = Math.sqrt(1 / weightSum)
    const fixedZ = fixedSe > 0 ? fixedEffect / fixedSe : 0
    const fixedP = normalP(fixedZ)
    let qStat = 0
    for (const entry of entries) qStat += (1 / (entry.se * entry.se)) * ((entry.effect - fixedEffect) ** 2)
    const df = Math.max(1, entries.length - 1)
    const i2 = qStat > 0 ? Math.max(0, (qStat - df) / qStat) : 0
    const c = weightSum - entries.reduce((sum, entry) => sum + (1 / (entry.se * entry.se)) ** 2, 0) / weightSum
    const tau2 = c > 0 ? Math.max(0, (qStat - df) / c) : 0
    let randomWeightSum = 0
    let randomWeighted = 0
    for (const entry of entries) {
      const weight = 1 / (entry.se * entry.se + tau2)
      randomWeightSum += weight
      randomWeighted += weight * entry.effect
    }
    const randomEffect = randomWeighted / randomWeightSum
    const randomSe = Math.sqrt(1 / randomWeightSum)
    const randomZ = randomSe > 0 ? randomEffect / randomSe : 0
    const randomP = normalP(randomZ)
    const row = {
      gene: feature,
      k: entries.length,
      effect_fixed: fixedEffect,
      se_fixed: fixedSe,
      z_fixed: fixedZ,
      p_fixed: fixedP,
      effect_random: randomEffect,
      se_random: randomSe,
      z_random: randomZ,
      p_random: randomP,
      q_fixed: null,
      q_random: null,
      Q: qStat,
      I2: i2,
      tau2,
      direction: fixedEffect > 0 ? 'up' : fixedEffect < 0 ? 'down' : 'flat',
      n_total: entries.reduce((sum, entry) => sum + (entry.n || 0), 0) || null,
    }
    for (const cohort of cohortData) {
      const entry = entries.find((item) => item.cohort === cohort.label)
      row[`effect_${cohort.labelSafe}`] = entry ? entry.effect : null
      row[`se_${cohort.labelSafe}`] = entry ? entry.se : null
    }
    resultRows.push(row)
  }
  const qFixed = bhFdr(resultRows.map((row) => row.p_fixed))
  const qRandom = bhFdr(resultRows.map((row) => row.p_random))
  resultRows.forEach((row, index) => {
    row.q_fixed = qFixed[index]
    row.q_random = qRandom[index]
    row.significant_fixed = row.q_fixed <= alpha
    row.significant_random = row.q_random <= alpha
  })
  resultRows.sort((a, b) => Math.abs(b.effect_fixed) - Math.abs(a.effect_fixed))
  const nSigFixed = resultRows.filter((row) => row.significant_fixed).length
  const nSigRandom = resultRows.filter((row) => row.significant_random).length
  const nHeterogeneous = resultRows.filter((row) => row.I2 > 0.5).length
  const effectCols = cohortData.map((cohort) => `effect_${cohort.labelSafe}`)
  const seCols = cohortData.map((cohort) => `se_${cohort.labelSafe}`)
  const columns = [
    col('gene', 'Gene'),
    col('k', 'Cohorts', 'number'),
    col('effect_fixed', 'Fixed-effect log2FC', 'number'),
    col('se_fixed', 'Fixed-effect SE', 'number'),
    col('p_fixed', 'Fixed-effect p', 'number'),
    col('q_fixed', 'Fixed-effect FDR', 'number'),
    col('effect_random', 'Random-effect log2FC', 'number'),
    col('se_random', 'Random-effect SE', 'number'),
    col('p_random', 'Random-effect p', 'number'),
    col('q_random', 'Random-effect FDR', 'number'),
    ...effectCols.flatMap((key, index) => [col(key, `log2FC · ${cohortData[index].label}`, 'number'), col(seCols[index], `SE · ${cohortData[index].label}`, 'number')]),
    col('Q', 'Q (heterogeneity)', 'number'),
    col('I2', 'I²', 'number'),
    col('tau2', 'tau²', 'number'),
    col('n_total', 'Total n', 'number'),
    col('direction', 'Direction'),
  ]
  const cohortTable = {
    id: 'meta_cohorts', table_id: 'meta_cohorts', title: 'Meta-analysis cohorts',
    columns: [
      col('cohort', 'Cohort'), col('run_id', 'Run'), col('table_id', 'Table'),
      col('rows', 'Rows in table', 'number'), col('usable_genes', 'Usable genes', 'number'),
      col('se_derived', 'SE derived from p', 'number'), col('effect_col', 'Effect column'),
      col('se_col', 'SE column'), col('n_col', 'n column'), col('n', 'n', 'number'), col('method', 'Method'),
    ],
    rows: cohortRows,
  }
  const metaTable = {
    id: 'meta_analysis', table_id: 'meta_analysis', title: 'Multi-cohort meta-analysis (fixed + random effects)',
    columns,
    rows: resultRows,
    note: 'fixed effect = inverse-variance weighted mean；random effect = DerSimonian-Laird tau²；I² 为异质性。',
  }
  const overallTable = {
    id: 'meta_overall', table_id: 'meta_overall', title: 'Meta-analysis overall',
    columns: [
      col('cohorts', 'Cohorts', 'number'), col('genes_tested', 'Genes tested', 'number'),
      col('significant_fixed', 'FDR≤alpha (fixed)', 'number'), col('significant_random', 'FDR≤alpha (random)', 'number'),
      col('heterogeneous_I2_gt_0_5', 'I²>0.5 genes', 'number'), col('alpha', 'alpha', 'number'),
      col('fdr_family', 'FDR family'),
    ],
    rows: [{
      cohorts: cohortData.length, genes_tested: tested, significant_fixed: nSigFixed,
      significant_random: nSigRandom, heterogeneous_I2_gt_0_5: nHeterogeneous,
      alpha, fdr_family: `BH over ${tested} genes with k>=${Math.min(min_cohorts, cohortData.length)} cohorts`,
    }],
  }
  if (!tested) warnings.push('没有任何基因出现在 ≥2 个队列：无法合并（检查基因 ID 是否统一）')
  if (!nSigFixed && !nSigRandom && tested) warnings.push('零显著：meta 合并后没有基因达到 FDR 阈值（这是合法结果，不代表无差异）')
  return {
    ok: true,
    method: 'inverse-variance meta-analysis (fixed) + DerSimonian-Laird (random)',
    summary: {
      title: `Meta-analysis：${cohortData.length} 个队列 × ${tested} 个可合并基因`,
      bullets: [
        `fixed effect FDR≤${alpha}：${nSigFixed} 个；random effect：${nSigRandom} 个`,
        `异质性 I²>0.5：${nHeterogeneous} 个基因`,
        `每队列可用基因：${cohortRows.map((row) => `${row.cohort}=${row.usable_genes}`).join('、')}`,
      ],
    },
    metrics: {
      cohorts: cohortData.length, genes_tested: tested, significant_fixed: nSigFixed,
      significant_random: nSigRandom, heterogeneous: nHeterogeneous, alpha,
    },
    tables: [metaTable, cohortTable, overallTable],
    figures: [],
    warnings,
    data: { cohorts: cohortRows, alpha, fdr_family: `BH over ${tested} genes` },
  }
}

// ---------------------------------------------------------------------------
// 联合出图数据准备（交给 plotlab 渲染）
// ---------------------------------------------------------------------------

/**
 * 把多个 run 的结果表拼成一张 tidy 表，供 plotlab 出图。
 * 每个面板的 plot data 与统计表同源：TSV + tables.index.json 一起交付。
 */
export async function prepareJointPlotData({ store, runs = [], outdir, value_column = null, group_column = 'cohort', feature_limit = 2000 } = {}) {
  if (!Array.isArray(runs) || runs.length < 1) throw jointError('bad_request', 'joint plot 需要 runs [{run_id, table_id?}]')
  ensureDir(outdir)
  const rows = []
  const warnings = []
  const cohortSummary = []
  for (const runSpec of runs) {
    const loaded = loadRunTable(store, runSpec.run_id, runSpec.table_id)
    const shape = describeCohortTable(loaded)
    const valueColumn = value_column || shape.effect || shape.p
    if (!valueColumn) throw jointError('prerequisite', `run ${runSpec.run_id} 的表找不到可画图的数值列`)
    const label = runSpec.label || loaded.run.dataset_id || runSpec.run_id
    const featureColumn = shape.feature || loaded.columns[0]
    const sorted = loaded.rows.map((row) => ({
      feature: String(row[featureColumn] || ''),
      value: Number(row[valueColumn]),
      q: shape.q ? Number(row[shape.q]) : null,
      p: shape.p ? Number(row[shape.p]) : null,
      significant: (shape.q ? Number(row[shape.q]) : shape.p ? Number(row[shape.p]) : 1) <= (runSpec.alpha || 0.05),
    })).filter((row) => row.feature && Number.isFinite(row.value))
    sorted.sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    const kept = sorted.slice(0, feature_limit)
    if (kept.length < sorted.length) warnings.push(`run ${label}：只画 |effect| 前 ${feature_limit} 个特征（共 ${sorted.length}）`)
    for (const row of kept) {
      rows.push({ cohort: label, run_id: runSpec.run_id, table_id: loaded.table.table_id, feature: row.feature, value: row.value, p: row.p, q: row.q, significant: row.significant })
    }
    cohortSummary.push({ cohort: label, run_id: runSpec.run_id, table_id: loaded.table.table_id, rows: loaded.rows.length, plotted: kept.length, value_column: valueColumn })
  }
  const file = path.join(outdir, 'joint_plot_data.tsv')
  const header = ['cohort', 'feature', 'value', 'p', 'q', 'significant', 'run_id', 'table_id']
  const lines = [header.join('\t')]
  for (const row of rows) {
    lines.push([row.cohort, row.feature, tsvCell(row.value), tsvCell(row.p), tsvCell(row.q), row.significant ? 'yes' : 'no', row.run_id, row.table_id].join('\t'))
  }
  atomicWriteFile(file, lines.join('\n') + '\n')
  const sha = await sha256File(file)
  const table = {
    // table_id 与 artifact 文件名必须错开：两者都叫 joint_plot_data 会写同一个 results/ 路径，
    // commit 时先 move 表、再 move artifact 就会 ENOENT（joint plot 曾因此必挂）。
    id: 'joint_plot_table', table_id: 'joint_plot_table', title: 'Joint plot data (tidy)',
    columns: [
      col('cohort', 'Cohort'), col('feature', 'Feature'), col('value', 'Value', 'number'),
      col('p', 'p', 'number'), col('q', 'FDR', 'number'), col('significant', 'Significant'),
      col('run_id', 'Run'), col('table_id', 'Table'),
    ],
    rows,
    note: '联合出图的 plot data；与 results/joint_plot_data.tsv 同源，plotlab 直接读这个文件。',
  }
  return {
    ok: true,
    summary: { title: `联合出图数据：${cohortSummary.length} 个队列 × ${rows.length} 行`, bullets: [`数据文件：${file}`] },
    metrics: { cohorts: cohortSummary.length, rows: rows.length, value_column: value_column || 'auto' },
    tables: [table],
    figures: [],
    warnings,
    artifacts: [{ source: file, relative_path: 'results/joint_plot_data.tsv', kind: 'plot_data', name: 'joint_plot_data.tsv', sha256: sha }],
    data: { file, sha256: sha, cohort_summary: cohortSummary, plotlab_roles: { x: 'cohort', y: 'value', group: 'cohort' } },
  }
}

// ---------------------------------------------------------------------------
// 跨模态签名映射（走 geobulk 已有 scmap 路径）
// ---------------------------------------------------------------------------

/**
 * 构造 signature mapping 计划步骤。执行交给 geobulk 引擎（不重算分析）。
 * @returns {steps, warnings, blocked?}
 */
export function buildSignatureSteps({ bulkDataset, scRefPath = null, scDatasetId = null, genes = [], params = {} } = {}) {
  const warnings = []
  const steps = []
  const primary = Array.isArray(bulkDataset && bulkDataset.files) ? bulkDataset.files[0] : null
  steps.push({
    step_id: 'open_bulk',
    plugin: 'geobulk',
    action: 'open',
    params: { path: primary ? primary.path : undefined, name: bulkDataset ? bulkDataset.name : 'bulk', sample_sheet: bulkDataset && bulkDataset.sample_sheet ? bulkDataset.sample_sheet.path : undefined },
    deliver: { kind: 'dataset' },
  })
  if (!scRefPath && !scDatasetId) {
    return {
      steps,
      warnings,
      blocked: {
        id: 'sc_reference',
        detail: '跨模态签名映射需要单细胞参考：传 sc_ref_path（h5ad）或先在 singlecell 工作台打开数据集并用 sc_dataset_id 拉取',
      },
    }
  }
  steps.push({
    step_id: 'attach_sc',
    plugin: 'geobulk',
    action: 'sc_attach',
    params: scRefPath ? { ref_path: scRefPath } : { sc_dataset: scDatasetId },
    requires: ['open_bulk'],
    deliver: { kind: 'attach' },
  })
  steps.push({
    step_id: 'scmap',
    plugin: 'geobulk',
    action: 'run',
    params: {
      step: 'scmap',
      params: {
        ...(Array.isArray(genes) && genes.length ? { genes } : {}),
        ...(params && typeof params === 'object' ? params : {}),
      },
    },
    requires: ['attach_sc'],
    deliver: { kind: 'signature' },
    evidence_kind: 'model_prediction',
    timeout_ms: 60 * 60 * 1000,
  })
  warnings.push('签名映射结果属于模型预测（model_prediction），不是实测证据；稿件 Results 不得直接引用')
  return { steps, warnings }
}

function col(key, label, type = 'string') { return { key, label, type } }
