/**
 * dsh-bioflow — harmonize：多数据归一化 + 批次评估 + 显式批次校正
 *
 * 硬要求（lead 追加）：
 *   - 多数据集先对齐特征/基因 ID、探针映射、单位与尺度（counts/TPM/log/芯片），报告对齐率与丢失；
 *   - 批次评估（PCA / kBET 代理指标）前后各一次；
 *   - 批次校正必须显式选择方法（none / scale_only / quantile / combat），方法名、参数、
 *     是否校正写入 manifest；未校正时禁止跨数据集合并推断（结果里给 cross_dataset_inference_allowed=false）。
 *
 * 实现边界（诚实标注）：
 *   - 只读文本矩阵（csv/tsv/txt，可 .gz）；h5ad/10x 请先用插件导出成矩阵或走 singlecell 工作台；
 *   - combat 是 location/scale 调整（无经验贝叶斯收缩），方法名里写明 combat-lite，不冒充官方 ComBat。
 *
 * 输出：tables（对齐率、样本质控、批次指标、基因效应）+ 归一化矩阵 .tsv.gz（artifact）。
 */

import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  atomicWriteFile, ensureDir, fileSize, nowIso, parseDelimited, safeName, sha256File, tsvCell,
} from './store.mjs'

export const HARMONIZE_METHODS = ['none', 'scale_only', 'quantile', 'combat']
export const TARGET_SCALES = ['counts', 'tpm', 'log_expression', 'zscore', 'none']
export const COMBAT_LABEL = 'combat-lite (location/scale, no empirical-Bayes shrinkage)'
const MAX_CELLS = 20_000_000
const MAX_FEATURES = 60_000

function harmonizeError(code, message, details = {}) {
  const error = Object.assign(new Error(message), { code })
  error.details = details
  return error
}

// ---------------------------------------------------------------------------
// 读矩阵
// ---------------------------------------------------------------------------

function readTextMaybeGz(file) {
  const buffer = readFileSync(file)
  if (/\.gz$/i.test(file)) {
    try { return gunzipSync(buffer).toString('utf8') } catch (error) {
      throw harmonizeError('bad_request', `gzip 解压失败：${file}（${error.message}）`)
    }
  }
  return buffer.toString('utf8')
}

/** 读一个文本矩阵 → {features, samples, matrix: Float64Array[]}。 */
export function readMatrixFile(file, { delimiter = null, transpose = false, featureColumn = null, maxRows = null } = {}) {
  if (!existsSync(file)) throw harmonizeError('not_found', `矩阵文件不存在：${file}`)
  const size = fileSize(file)
  if (size > 300 * 1024 * 1024) throw harmonizeError('unsupported', `矩阵文件过大（${Math.round(size / 1048576)} MB > 300 MB 上限）：${file}`)
  const text = readTextMaybeGz(file)
  const parsed = parseDelimited(text, delimiter || undefined)
  if (parsed.header.length < 2) throw harmonizeError('bad_request', `矩阵至少需要 2 列（特征 + 样本）：${file}`)
  const header = parsed.header
  let featureIndex = 0
  if (featureColumn) {
    const index = header.findIndex((key) => key.toLowerCase() === String(featureColumn).toLowerCase())
    if (index < 0) throw harmonizeError('bad_request', `找不到特征列 ${featureColumn}；表头：${header.slice(0, 8).join('、')}`)
    featureIndex = index
  } else {
    // 常见：首列名为 gene/feature/id/symbol，或首格为空
    const first = String(header[0] || '').toLowerCase()
    if (!/gene|feature|id|symbol|probe| metabolite|protein|transcript/.test(first) && header[0] !== '') {
      // 首行首列看起来是样本名 → 可能需要转置
      const numericColumns = header.filter((key) => /^[A-Za-z0-9_.-]+$/.test(key) && !/gene|feature|id/i.test(key)).length
      if (numericColumns >= header.length - 1) transpose = !transpose
    }
  }
  const featureNames = []
  const sampleNames = []
  const rows = []
  for (const row of parsed.rows) {
    const feature = String(row[featureIndex] || '').trim()
    if (!feature) continue
    featureNames.push(feature)
    rows.push(row)
    if (maxRows && featureNames.length >= maxRows) break
  }
  if (!featureNames.length) throw harmonizeError('bad_request', `矩阵没有数据行：${file}`)
  const valueColumns = header.map((_, index) => index).filter((index, position) => index !== featureIndex && position !== 0 || (featureIndex !== 0))
  // 简洁：除特征列外全部当样本
  const colIndexes = header.map((key, index) => ({ key, index })).filter((item) => item.index !== featureIndex)
  for (const item of colIndexes) sampleNames.push(item.key)
  let matrix = rows.map((row) => {
    const values = new Float64Array(colIndexes.length)
    colIndexes.forEach((item, position) => {
      const raw = row[item.index]
      const value = raw === '' || raw === null || raw === undefined ? Number.NaN : Number(String(raw).replace(/,/g, ''))
      values[position] = Number.isFinite(value) ? value : Number.NaN
    })
    return values
  })
  let features = featureNames
  let samples = sampleNames
  if (transpose) {
    const transposed = []
    for (let s = 0; s < samples.length; s += 1) {
      const row = new Float64Array(features.length)
      for (let f = 0; f < features.length; f += 1) row[f] = matrix[f][s]
      transposed.push(row)
    }
    const oldSamples = samples
    samples = features
    features = oldSamples
    matrix = transposed
  }
  if (features.length * samples.length > MAX_CELLS) {
    throw harmonizeError('unsupported', `矩阵规模 ${features.length}×${samples.length} 超过 ${MAX_CELLS.toLocaleString()} 单元格上限；请先过滤特征`)
  }
  return { file, features, samples, matrix, size_bytes: size }
}

// ---------------------------------------------------------------------------
// 特征对齐
// ---------------------------------------------------------------------------

export function normalizeFeatureName(name) {
  return String(name || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\.\d+$/, '')
    .replace(/\s+/g, '')
    .toUpperCase()
}

export function readProbeMap(file) {
  if (!file) return null
  if (!existsSync(file)) throw harmonizeError('not_found', `探针映射文件不存在：${file}`)
  const parsed = parseDelimited(readTextMaybeGz(file))
  if (parsed.header.length < 2) throw harmonizeError('bad_request', '探针映射表至少需要 2 列（probe, gene）')
  const probeKey = parsed.header.find((key) => /probe|id/i.test(key)) || parsed.header[0]
  const geneKey = parsed.header.find((key) => /gene|symbol/i.test(key)) || parsed.header[1]
  const map = new Map()
  for (const row of parsed.objects) {
    const probe = normalizeFeatureName(row[probeKey])
    const gene = normalizeFeatureName(row[geneKey])
    if (probe && gene) map.set(probe, gene)
  }
  return { map, probe_key: probeKey, gene_key: geneKey, size: map.size }
}

/** 一个矩阵 → 对齐后的 {features, samples, matrix}。 */
export function alignMatrix(input, { probeMap = null, aggregate = 'mean' } = {}) {
  const { features, samples, matrix } = input
  const groups = new Map() // canonical gene -> {indices, rows}
  const unmatched = []
  let mappedByProbe = 0
  let featuresTotal = 0
  for (let index = 0; index < features.length; index += 1) {
    featuresTotal += 1
    const raw = normalizeFeatureName(features[index])
    let canonical = raw
    if (probeMap && probeMap.map.has(raw)) { canonical = probeMap.map.get(raw); mappedByProbe += 1 }
    if (!canonical) { unmatched.push(features[index]); continue }
    if (!groups.has(canonical)) groups.set(canonical, [])
    groups.get(canonical).push(index)
  }
  const canonicalFeatures = [...groups.keys()]
  const output = canonicalFeatures.map((gene) => {
    const indices = groups.get(gene)
    const row = new Float64Array(samples.length)
    for (let s = 0; s < samples.length; s += 1) {
      const values = indices.map((index) => matrix[index][s]).filter((value) => Number.isFinite(value))
      if (!values.length) { row[s] = Number.NaN; continue }
      if (aggregate === 'max') row[s] = Math.max(...values)
      else if (aggregate === 'sum') row[s] = values.reduce((sum, value) => sum + value, 0)
      else row[s] = values.reduce((sum, value) => sum + value, 0) / values.length
    }
    return row
  })
  let merged = 0
  for (const indices of groups.values()) merged += Math.max(0, indices.length - 1)
  return {
    features: canonicalFeatures,
    samples,
    matrix: output,
    stats: {
      features_total: featuresTotal,
      features_mapped: canonicalFeatures.length,
      features_unmatched: featuresTotal - canonicalFeatures.length - merged,
      features_merged_duplicates: merged,
      mapped_by_probe: mappedByProbe,
      unmatched_examples: unmatched.slice(0, 10),
      sample_unmatched: [],
    },
  }
}

// ---------------------------------------------------------------------------
// 统计工具
// ---------------------------------------------------------------------------

function mean(values) {
  let sum = 0
  let count = 0
  for (const value of values) if (Number.isFinite(value)) { sum += value; count += 1 }
  return count ? sum / count : Number.NaN
}

function variance(values, avg = null) {
  const m = avg === null ? mean(values) : avg
  let sum = 0
  let count = 0
  for (const value of values) if (Number.isFinite(value)) { sum += (value - m) ** 2; count += 1 }
  return count > 1 ? sum / (count - 1) : 0
}

export function log2(x) { return Math.log(Math.max(x, 1e-12)) / Math.LN2 }

function topVariableGenes(aligned, n = 2000) {
  const scores = []
  for (let f = 0; f < aligned.features.length; f += 1) {
    const row = aligned.matrix[f]
    const values = row.filter((value) => Number.isFinite(value))
    scores.push({ index: f, sd: Math.sqrt(variance(values)) })
  }
  scores.sort((a, b) => b.sd - a.sd)
  return scores.slice(0, Math.min(n, scores.length)).map((item) => item.index)
}

/** 样本级 PCA（幂迭代求前 2 个主成分，确定性）。 */
export function samplePca(aligned, { nGenes = 2000, components = 2 } = {}) {
  const geneIndexes = topVariableGenes(aligned, nGenes)
  const nSamples = aligned.samples.length
  const values = []
  for (let s = 0; s < nSamples; s += 1) values.push(geneIndexes.map((f) => aligned.matrix[f][s]))
  const centered = []
  for (let g = 0; g < geneIndexes.length; g += 1) {
    const column = values.map((row) => row[g]).filter((value) => Number.isFinite(value))
    const m = mean(column)
    for (let s = 0; s < nSamples; s += 1) values[s][g] = (values[s][g] - m) || 0
  }
  const projected = Array.from({ length: nSamples }, () => new Array(components).fill(0))
  const residual = values.map((row) => row.slice())
  for (let c = 0; c < components; c += 1) {
    let vector = new Array(geneIndexes.length).fill(0).map((_, index) => Math.sin(index * 0.7 + c) + 1)
    let norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
    vector = vector.map((value) => value / norm)
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const next = new Array(geneIndexes.length).fill(0)
      for (let s = 0; s < nSamples; s += 1) {
        const row = residual[s]
        let dot = 0
        for (let g = 0; g < row.length; g += 1) dot += row[g] * vector[g]
        projected[s][c] = dot
        for (let g = 0; g < row.length; g += 1) next[g] += dot * row[g]
      }
      norm = Math.sqrt(next.reduce((sum, value) => sum + value * value, 0)) || 1
      vector = next.map((value) => value / norm)
    }
    for (let s = 0; s < nSamples; s += 1) {
      const row = residual[s]
      for (let g = 0; g < row.length; g += 1) row[g] -= projected[s][c] * vector[g]
    }
  }
  return { components: projected, genes_used: geneIndexes.length }
}

/**
 * 批次评估（PCA + kBET 代理）：
 *   - nn_mixing：每个样本 k 近邻里同数据集的平均占比（越低越混合）；
 *   - separation_ratio：数据集质心间距离 / 数据集内平均距离（越大越分离）。
 */
export function batchMetrics(aligned, labels, { stage = 'before', k = 5 } = {}) {
  const pca = samplePca(aligned)
  const points = pca.components
  const labelSet = [...new Set(labels)]
  const metrics = []
  for (let i = 0; i < labels.length; i += 1) {
    const distances = points.map((point, j) => ({
      j,
      d: i === j ? Infinity : Math.hypot(point[0] - points[i][0], point[1] - points[i][1]),
    })).sort((a, b) => a.d - b.d)
    const neighbors = distances.slice(0, k)
    const same = neighbors.filter((item) => labels[item.j] === labels[i]).length
    const expected = labels.length > 1 ? (labels.filter((label) => label === labels[i]).length - 1) / (labels.length - 1) : 1
    metrics.push({ sample_index: i, nn_same_label: neighbors.length ? same / neighbors.length : 0, expected_same_label: expected })
  }
  const perDataset = {}
  for (const label of labelSet) {
    const own = metrics.filter((item) => labels[item.sample_index] === label)
    const centroids = [0, 1].map((component) => mean(own.map((item) => points[item.sample_index][component])))
    const spread = own.length
      ? mean(own.map((item) => Math.hypot(points[item.sample_index][0] - centroids[0], points[item.sample_index][1] - centroids[1])))
      : 0
    perDataset[label] = {
      dataset: label,
      stage,
      n_samples: own.length,
      pc1_mean: centroids[0],
      pc2_mean: centroids[1],
      nn_mixing: mean(own.map((item) => item.nn_same_label)),
      expected_mixing: mean(own.map((item) => item.expected_same_label)),
      within_spread: spread,
    }
  }
  let separation = null
  const centroids = labelSet.map((label) => [perDataset[label].pc1_mean, perDataset[label].pc2_mean])
  if (labelSet.length >= 2) {
    const between = []
    for (let i = 0; i < centroids.length; i += 1) {
      for (let j = i + 1; j < centroids.length; j += 1) {
        between.push(Math.hypot(centroids[i][0] - centroids[j][0], centroids[i][1] - centroids[j][1]))
      }
    }
    const within = mean(Object.values(perDataset).map((item) => item.within_spread))
    separation = within > 0 ? mean(between) / within : null
  }
  return {
    per_dataset: Object.values(perDataset),
    overall: {
      stage,
      n_samples: labels.length,
      n_datasets: labelSet.length,
      mean_nn_mixing: mean(metrics.map((item) => item.nn_same_label)),
      mean_expected_mixing: mean(metrics.map((item) => item.expected_same_label)),
      separation_ratio: separation,
      genes_used: pca.genes_used,
      k,
    },
    points,
  }
}

// ---------------------------------------------------------------------------
// 尺度转换 / 批次校正
// ---------------------------------------------------------------------------

function scaleToTarget(aligned, from, target) {
  const warnings = []
  if (target === 'none' || target === from) return { aligned, warnings }
  if (target === 'log_expression') {
    if (from === 'counts' || from === 'unknown') {
      const matrix = aligned.matrix.map((row) => {
        const rowSum = row.reduce((sum, value) => sum + (Number.isFinite(value) ? Math.max(0, value) : 0), 0)
        const cpmFactor = rowSum > 0 ? 1e6 / rowSum : 1
        return row.map((value) => log2((Number.isFinite(value) ? Math.max(0, value) : 0) * cpmFactor + 1))
      })
      warnings.push(`尺度转换：${from} → log2(CPM+1)（逐样本按行和归一）`)
      return { aligned: { ...aligned, matrix }, warnings }
    }
    if (from === 'log_expression') return { aligned, warnings }
  }
  if (target === 'tpm') {
    if (from === 'counts' || from === 'unknown') {
      const matrix = aligned.matrix.map((row) => {
        const rowSum = row.reduce((sum, value) => sum + (Number.isFinite(value) ? Math.max(0, value) : 0), 0)
        return row.map((value) => (Number.isFinite(value) && rowSum > 0 ? (Math.max(0, value) / rowSum) * 1e6 : 0))
      })
      warnings.push(`尺度转换：${from} → TPM 近似（逐样本按行和归一；不是转录本长度校正的严格 TPM）`)
      return { aligned: { ...aligned, matrix }, warnings }
    }
    throw harmonizeError('unsupported', `无法从 ${from} 转换到 TPM（不做不可逆转换）`)
  }
  if (target === 'zscore') {
    const matrix = aligned.matrix.map((row) => {
      const values = row.filter((value) => Number.isFinite(value))
      const m = mean(values)
      const sd = Math.sqrt(variance(values)) || 1
      return row.map((value) => (Number.isFinite(value) ? (value - m) / sd : 0))
    })
    warnings.push('尺度转换：逐基因 z-score（会丢失绝对表达量）')
    return { aligned: { ...aligned, matrix }, warnings }
  }
  if (target === 'counts') {
    throw harmonizeError('unsupported', `不能从 ${from} 反推原始 counts（不可逆）；请保留原始 counts 文件或改用 log 表达模板`, { from, target })
  }
  return { aligned, warnings }
}

/** 每数据集样本级缩放（scale_only）：按中位行和（或库大小）缩放。 */
function scaleOnly(datasets) {
  const scaled = []
  const reference = mean(datasets.map((dataset) => median(dataset.aligned.matrix.map((row) => row.reduce((sum, value) => sum + (Number.isFinite(value) ? Math.max(0, value) : 0), 0)))))
  for (const dataset of datasets) {
    const rowSums = dataset.aligned.matrix.map((row) => row.reduce((sum, value) => sum + (Number.isFinite(value) ? Math.max(0, value) : 0), 0))
    const med = median(rowSums)
    const factor = med > 0 ? reference / med : 1
    const matrix = dataset.aligned.matrix.map((row) => row.map((value) => (Number.isFinite(value) ? value * factor : 0)))
    scaled.push({ ...dataset, aligned: { ...dataset.aligned, matrix } })
  }
  return { datasets: scaled, reference }
}

/** 样本级分位数归一化（quantile）：每个数据集的排序向量对齐到全局平均参考。 */
function quantileNormalize(datasets) {
  const nGenes = Math.min(...datasets.map((dataset) => dataset.aligned.features.length))
  const refSums = new Array(nGenes).fill(0)
  let refCount = 0
  for (const dataset of datasets) {
    for (let s = 0; s < dataset.aligned.samples.length; s += 1) {
      const column = dataset.aligned.matrix.map((row) => row[s])
      const sorted = column.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
      if (sorted.length < nGenes) continue
      const trimmed = sorted.slice(sorted.length - nGenes)
      for (let g = 0; g < nGenes; g += 1) refSums[g] += trimmed[g]
      refCount += 1
    }
  }
  if (!refCount) return { datasets, reference: null }
  const reference = refSums.map((value) => value / refCount)
  const normalized = datasets.map((dataset) => {
    const matrix = dataset.aligned.matrix.map((row) => row.slice())
    for (let s = 0; s < dataset.aligned.samples.length; s += 1) {
      const indexes = matrix.map((row, index) => ({ index, value: row[s] }))
        .filter((item) => Number.isFinite(item.value))
        .sort((a, b) => a.value - b.value)
      const drop = Math.max(0, indexes.length - nGenes)
      indexes.slice(0, drop).forEach((item) => { matrix[item.index][s] = Number.NaN })
      const kept = indexes.slice(drop)
      kept.forEach((item, rank) => { matrix[item.index][s] = reference[rank] })
    }
    return { ...dataset, aligned: { ...dataset.aligned, matrix } }
  })
  return { datasets: normalized, reference }
}

/** combat-lite：逐基因 location/scale 调整（batch mean → grand mean；batch sd → pooled sd）。 */
function combatLite(datasets) {
  const nGenes = Math.min(...datasets.map((dataset) => dataset.aligned.features.length))
  const grand = []
  const pooled = []
  for (let g = 0; g < nGenes; g += 1) {
    const all = []
    for (const dataset of datasets) {
      for (let s = 0; s < dataset.aligned.samples.length; s += 1) {
        const value = dataset.aligned.matrix[g][s]
        if (Number.isFinite(value)) all.push(value)
      }
    }
    grand.push(mean(all))
    pooled.push(Math.sqrt(variance(all)) || 1)
  }
  const adjusted = datasets.map((dataset) => {
    const matrix = dataset.aligned.matrix.map((row) => row.slice())
    for (let g = 0; g < nGenes; g += 1) {
      const values = []
      for (let s = 0; s < dataset.aligned.samples.length; s += 1) {
        const value = dataset.aligned.matrix[g][s]
        if (Number.isFinite(value)) values.push(value)
      }
      const batchMean = mean(values)
      const batchSd = Math.sqrt(variance(values)) || 1
      for (let s = 0; s < dataset.aligned.samples.length; s += 1) {
        const value = dataset.aligned.matrix[g][s]
        matrix[g][s] = Number.isFinite(value)
          ? ((value - batchMean) / batchSd) * pooled[g] + grand[g]
          : grand[g]
      }
    }
    return { ...dataset, aligned: { ...dataset.aligned, matrix } }
  })
  return { datasets: adjusted }
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return Number.NaN
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 执行 harmonize。
 * @param {object} input
 * @param {Array} input.datasets [{dataset_id, name, path, scale, transpose, probe_map, species, assay}]
 * @param {string} input.method none|scale_only|quantile|combat
 * @param {string} input.target_scale counts|tpm|log_expression|zscore|none
 * @param {string} input.aggregate mean|max|sum
 * @param {string} input.outdir 输出目录（run 的 staging 目录由 executor 给）
 * @param {boolean} input.allow_descriptive_only 未校正时是否仍允许描述性联合（默认 true）
 */
export async function runHarmonize({
  datasets = [],
  method = 'none',
  target_scale = 'none',
  aggregate = 'mean',
  probe_map_file = null,
  outdir,
  allow_descriptive_only = true,
  reference_dataset = null,
  log = null,
} = {}) {
  const warnings = []
  if (!Array.isArray(datasets) || datasets.length < 2) {
    throw harmonizeError('bad_request', 'harmonize 需要至少 2 个数据集（dataset_ids）')
  }
  const cleanMethod = String(method || 'none').toLowerCase()
  if (!HARMONIZE_METHODS.includes(cleanMethod)) {
    throw harmonizeError('bad_request', `未知批次校正方法 ${method}（可用：${HARMONIZE_METHODS.join('、')}）`)
  }
  const target = String(target_scale || 'none').toLowerCase()
  if (!TARGET_SCALES.includes(target)) throw harmonizeError('bad_request', `未知目标尺度 ${target_scale}（可用：${TARGET_SCALES.join('、')}）`)
  if (cleanMethod === 'none') warnings.push('未做批次校正：跨数据集合并推断被禁止（只能描述性联合出图）')
  if (cleanMethod === 'combat') warnings.push(`combat 使用 ${COMBAT_LABEL}；不是 Bioconductor sva::ComBat 的完整实现`)

  ensureDir(outdir)
  const probeMap = probe_map_file ? readProbeMap(probe_map_file) : null
  if (probeMap) warnings.push(`探针映射：${probeMap.size} 条（${probeMap.probe_key}→${probeMap.gene_key}）`)

  const prepared = []
  const alignmentRows = []
  for (const dataset of datasets) {
    if (!dataset.path || !existsSync(dataset.path)) {
      throw harmonizeError('not_found', `数据集 ${dataset.dataset_id || dataset.name} 的矩阵文件不存在：${dataset.path || '未提供 path'}`)
    }
    const raw = readMatrixFile(dataset.path, { transpose: Boolean(dataset.transpose) })
    const aligned = alignMatrix(raw, { probeMap, aggregate })
    const scaleFrom = String(dataset.scale || 'unknown').toLowerCase()
    const converted = scaleToTarget(aligned, scaleFrom, target === 'none' ? scaleFrom : target)
    warnings.push(...converted.warnings)
    const finalAligned = converted.aligned
    prepared.push({
      dataset_id: dataset.dataset_id || dataset.name,
      name: dataset.name || dataset.dataset_id,
      scale_from: scaleFrom,
      scale_to: target === 'none' ? scaleFrom : target,
      aligned: finalAligned,
      samples: finalAligned.samples,
    })
    alignmentRows.push({
      dataset_id: dataset.dataset_id || dataset.name,
      dataset_name: dataset.name || '',
      features_total: aligned.stats.features_total,
      features_mapped: aligned.stats.features_mapped,
      alignment_rate: aligned.stats.features_total ? aligned.stats.features_mapped / aligned.stats.features_total : 0,
      features_merged_duplicates: aligned.stats.features_merged_duplicates,
      mapped_by_probe: aligned.stats.mapped_by_probe,
      unmatched_examples: aligned.stats.unmatched_examples.join(';'),
      scale_from: scaleFrom,
      scale_to: target === 'none' ? scaleFrom : target,
      n_samples: finalAligned.samples.length,
    })
  }

  // 特征交集（跨数据集联合矩阵）
  const featureSets = prepared.map((dataset) => new Set(dataset.aligned.features))
  const common = [...featureSets[0]].filter((gene) => featureSets.every((set) => set.has(gene)))
  warnings.push(`跨数据集特征交集：${common.length} 个（各数据集映射后 ${featureSets.map((set) => set.size).join(' / ')}）`)
  if (common.length < 100) warnings.push('共同特征少于 100 个：联合结果可信度很低，请检查基因 ID 体系/探针映射')

  // 组装联合矩阵（行=common genes，列=所有样本）
  const labels = []
  const sampleNames = []
  const columns = []
  for (const dataset of prepared) {
    const indexOf = new Map(dataset.aligned.features.map((gene, index) => [gene, index]))
    for (let s = 0; s < dataset.aligned.samples.length; s += 1) {
      labels.push(dataset.dataset_id)
      sampleNames.push(`${dataset.dataset_id}:${dataset.aligned.samples[s]}`)
      columns.push(common.map((gene) => dataset.aligned.matrix[indexOf.get(gene)][s]))
    }
  }
  let joint = { features: common, samples: sampleNames, matrix: common.map((_, geneIndex) => Float64Array.from(columns.map((column) => column[geneIndex]))) }

  // 批次指标 before
  const before = batchMetrics(joint, labels, { stage: 'before' })
  if (log) log('harmonize', `before separation_ratio=${before.overall.separation_ratio} nn_mixing=${before.overall.mean_nn_mixing}`)

  // 校正
  let corrected = prepared.map((dataset) => dataset)
  let correction = { method: cleanMethod, applied: cleanMethod !== 'none', label: cleanMethod }
  if (cleanMethod === 'scale_only') {
    const result = scaleOnly(prepared)
    corrected = result.datasets
    correction = { method: 'scale_only', applied: true, reference_median_sum: result.reference, label: 'scale_only (median row-sum scaling)' }
  } else if (cleanMethod === 'quantile') {
    const result = quantileNormalize(prepared)
    corrected = result.datasets
    correction = { method: 'quantile', applied: true, reference_genes: result.reference ? result.reference.length : 0, label: 'quantile (sample-level across genes)' }
  } else if (cleanMethod === 'combat') {
    const result = combatLite(prepared)
    corrected = result.datasets
    correction = { method: 'combat', applied: true, label: COMBAT_LABEL }
  }

  // 重组联合矩阵（校正后）
  if (cleanMethod !== 'none') {
    const rebuiltColumns = []
    for (const dataset of corrected) {
      const indexOf = new Map(dataset.aligned.features.map((gene, index) => [gene, index]))
      for (let s = 0; s < dataset.aligned.samples.length; s += 1) {
        rebuiltColumns.push(common.map((gene) => dataset.aligned.matrix[indexOf.get(gene)][s]))
      }
    }
    joint = { ...joint, matrix: common.map((_, geneIndex) => Float64Array.from(rebuiltColumns.map((column) => column[geneIndex]))) }
  }
  const after = batchMetrics(joint, labels, { stage: 'after' })

  // 输出归一化矩阵
  const matrixFile = path.join(outdir, 'harmonized_matrix.tsv.gz')
  const lines = []
  const header = ['gene', ...sampleNames.map((name) => name.replace(/[\t\n]/g, ' '))]
  lines.push(header.join('\t'))
  for (let g = 0; g < common.length; g += 1) {
    const row = [common[g]]
    for (let s = 0; s < joint.samples.length; s += 1) row.push(tsvCell(joint.matrix[g][s]))
    lines.push(row.join('\t'))
  }
  atomicWriteFile(matrixFile, gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
  const matrixSha = await sha256File(matrixFile)

  // 表
  const batchRows = [...before.per_dataset.map((item) => ({ ...item, stage: 'before' })),
    ...after.per_dataset.map((item) => ({ ...item, stage: 'after' }))]
  const sampleRows = []
  for (const dataset of corrected) {
    const matrix = dataset.aligned.matrix
    for (let s = 0; s < dataset.aligned.samples.length; s += 1) {
      let nonzero = 0
      let sum = 0
      for (let g = 0; g < matrix.length; g += 1) {
        const value = matrix[g][s]
        if (Number.isFinite(value) && value !== 0) { nonzero += 1; sum += value }
      }
      sampleRows.push({
        dataset_id: dataset.dataset_id, sample: dataset.aligned.samples[s],
        n_features_total: matrix.length, n_nonzero: nonzero,
        sum: sum, mean: nonzero ? sum / matrix.length : 0,
      })
    }
  }
  const datasetLabelRows = prepared.map((dataset, index) => ({
    dataset_id: dataset.dataset_id, dataset_name: dataset.name,
    n_samples: dataset.aligned.samples.length,
    scale_from: dataset.scale_from, scale_to: dataset.scale_to,
    alignment_rate: alignmentRows[index].alignment_rate,
    label: labels.filter((label) => label === dataset.dataset_id).length,
  }))

  const tables = [
    table('feature_alignment', 'Feature ID alignment', [
      col('dataset_id', 'Dataset'), col('dataset_name', 'Name'),
      col('features_total', 'Features in file', 'number'), col('features_mapped', 'Mapped features', 'number'),
      col('alignment_rate', 'Alignment rate', 'number'), col('features_merged_duplicates', 'Merged duplicates', 'number'),
      col('mapped_by_probe', 'Mapped by probe map', 'number'), col('unmatched_examples', 'Unmatched examples'),
      col('scale_from', 'Scale from'), col('scale_to', 'Scale to'), col('n_samples', 'n samples', 'number'),
    ], alignmentRows, '对齐后按规范基因 ID 去重（重复特征按 aggregate 合并）；未映射特征不进入联合矩阵。'),
    table('dataset_labels', 'Dataset labels', [
      col('dataset_id', 'Dataset'), col('dataset_name', 'Name'), col('n_samples', 'n samples', 'number'),
      col('scale_from', 'Scale from'), col('scale_to', 'Scale to'), col('alignment_rate', 'Alignment rate', 'number'),
    ], datasetLabelRows),
    table('batch_metrics', 'Batch metrics before/after correction', [
      col('stage', 'Stage'), col('dataset', 'Dataset'), col('n_samples', 'n samples', 'number'),
      col('pc1_mean', 'PC1 mean', 'number'), col('pc2_mean', 'PC2 mean', 'number'),
      col('nn_mixing', 'kNN same-dataset fraction', 'number'), col('expected_mixing', 'Expected fraction', 'number'),
      col('within_spread', 'Within-dataset spread', 'number'),
    ], batchRows, 'kNN mixing 越低越混合；PCA 用 top 2000 变异特征。'),
    table('batch_overall', 'Batch assessment overall', [
      col('stage', 'Stage'), col('n_samples', 'n samples', 'number'), col('n_datasets', 'n datasets', 'number'),
      col('mean_nn_mixing', 'Mean kNN same-dataset fraction', 'number'),
      col('mean_expected_mixing', 'Expected under full mixing', 'number'),
      col('separation_ratio', 'Separation ratio (between/within)', 'number'),
      col('genes_used', 'Genes used', 'number'),
    ], [before.overall, after.overall]),
    table('sample_qc', 'Per-sample QC after correction', [
      col('dataset_id', 'Dataset'), col('sample', 'Sample'), col('n_features_total', 'Features', 'number'),
      col('n_nonzero', 'Nonzero', 'number'), col('sum', 'Sum', 'number'), col('mean', 'Mean', 'number'),
    ], sampleRows),
    table('correction_params', 'Batch correction method', [
      col('method', 'Method'), col('applied', 'Applied'), col('label', 'Implementation label'),
      col('reference_genes', 'Reference genes', 'number'), col('reference_median_sum', 'Reference median sum', 'number'),
    ], [{ method: correction.method, applied: correction.applied, label: correction.label, reference_genes: correction.reference_genes || null, reference_median_sum: correction.reference_median_sum || null }], '未校正（method=none）时禁止跨数据集合并推断；可描述性联合出图。'),
  ]

  const summary = {
    n_datasets: prepared.length,
    n_common_features: common.length,
    n_samples: sampleNames.length,
    method: correction.method,
    method_label: correction.label,
    batch_corrected: correction.applied,
    target_scale: target,
    cross_dataset_inference_allowed: correction.applied,
    allow_descriptive_only: Boolean(allow_descriptive_only),
    separation_ratio_before: before.overall.separation_ratio,
    separation_ratio_after: after.overall.separation_ratio,
    mean_nn_mixing_before: before.overall.mean_nn_mixing,
    mean_nn_mixing_after: after.overall.mean_nn_mixing,
    matrix_file: matrixFile,
    matrix_sha256: matrixSha,
    samples: sampleNames,
    labels,
    created_at: nowIso(),
  }

  return {
    ok: true,
    method: correction.applied ? correction.label : 'none',
    summary: {
      title: `harmonize：${prepared.length} 个数据集 × ${common.length} 个共同特征 × ${sampleNames.length} 个样本`,
      bullets: [
        `批次校正：${correction.label}${correction.applied ? '' : '（未校正 → 跨数据集合并推断被禁止）'}`,
        `特征交集 ${common.length}；对齐率 ${alignmentRows.map((row) => `${row.dataset_id}=${(row.alignment_rate * 100).toFixed(1)}%`).join('、')}`,
        `分离度 before=${before.overall.separation_ratio == null ? 'NA' : before.overall.separation_ratio.toFixed(2)} / after=${after.overall.separation_ratio == null ? 'NA' : after.overall.separation_ratio.toFixed(2)}`,
      ],
    },
    metrics: {
      n_datasets: prepared.length, n_common_features: common.length, n_samples: sampleNames.length,
      batch_corrected: correction.applied, separation_ratio_before: before.overall.separation_ratio,
      separation_ratio_after: after.overall.separation_ratio,
    },
    tables,
    figures: [],
    warnings,
    artifacts: [{
      source: matrixFile,
      relative_path: 'results/harmonized_matrix.tsv.gz',
      kind: 'harmonized_matrix',
      name: 'harmonized_matrix.tsv.gz',
      sha256: matrixSha,
      bytes: fileSize(matrixFile),
    }],
    data: {
      method: correction.method,
      method_label: correction.label,
      batch_corrected: correction.applied,
      target_scale: target,
      aggregate,
      feature_intersection: common.length,
      matrix_file: matrixFile,
      matrix_sha256: matrixSha,
      samples: sampleNames,
      labels,
    },
  }
}

function col(key, label, type = 'string') { return { key, label, type } }
function table(id, title, columns, rows, note = null) { return { id, table_id: id, title, columns, rows, note } }

export default runHarmonize
