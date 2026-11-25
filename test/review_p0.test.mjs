/**
 * 评审 P0 回归：矩阵方向一致性、尺度不误判、合并前混杂拦截、合并样本逐队列映射。
 * 全部离线（纯 JS harmonize，不启 Python）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as impl from '../lib/impl.mjs'
import { Store } from '../lib/store.mjs'
import { evaluateGates, buildPlan } from '../lib/plan.mjs'

function runtimeWith(dir) {
  return { version: 'test', config: { dataDir: dir }, invocation: 'test' }
}

/** genes × samples 矩阵（正向：transpose=true）。 */
function writeGenesBySamples(dir, name, samples, geneCount = 40, offset = 0) {
  const lines = ['gene\t' + samples.join('\t')]
  for (let gene = 0; gene < geneCount; gene += 1) {
    lines.push('G' + String(gene).padStart(4, '0') + '\t' + samples.map((_, index) => 100 + gene + index * (3 + offset)).join('\t'))
  }
  const file = path.join(dir, `${name}.tsv`)
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

/** samples × genes 矩阵（反向：transpose=false）。 */
function writeSamplesByGenes(dir, name, samples, geneCount = 30) {
  const header = ['sample', ...Array.from({ length: geneCount }, (_, index) => 'G' + String(index).padStart(4, '0'))]
  const lines = [header.join('\t')]
  samples.forEach((sample, index) => {
    lines.push([sample, ...Array.from({ length: geneCount }, (_, gene) => 50 + gene + index * 7)].join('\t'))
  })
  const file = path.join(dir, `${name}.tsv`)
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function writeSheet(dir, name, samples, groups) {
  const file = path.join(dir, `${name}.tsv`)
  writeFileSync(file, 'sample\tgroup\n' + samples.map((sample, index) => `${sample}\t${groups[index]}`).join('\n') + '\n')
  return file
}

async function register(runtime, matrix, sheet, extra = {}) {
  const result = await impl.runTool(runtime, Object.assign({ action: 'register', path: matrix, sample_sheet: sheet, assay: 'rna-seq' }, extra))
  assert.equal(result.ok, true, `register 失败：${result.summary}`)
  return result.dataset
}

test('尺度：非负整数→counts(verified)；负整数/小数→疑似 log 且不 verified', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bf-scale-'))
  try {
    const runtime = runtimeWith(root)
    const samples = ['S1', 'S2', 'S3', 'S4']
    const sheet = writeSheet(root, 'sheet', samples, ['tumor', 'tumor', 'normal', 'normal'])
    const ints = await register(runtime, writeGenesBySamples(root, 'ints', samples), sheet)
    assert.equal(ints.scale.type, 'counts')
    assert.equal(ints.scale.verified, true)

    const negative = path.join(root, 'neg.tsv')
    writeFileSync(negative, ['gene\tS1\tS2\tS3\tS4', 'G1\t-2\t-1\t0\t1', 'G2\t-3\t-2\t-1\t0', 'G3\t-1\t-1\t1\t2'].join('\n') + '\n')
    const negDataset = await register(runtimeWith(path.join(root, 'neg-root')), negative, sheet)
    assert.notEqual(negDataset.scale.type, 'counts', '负整数不能被当成 counts')
    assert.equal(negDataset.scale.verified, false, '负整数必须等用户确认尺度')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('矩阵方向：样本×基因矩阵（transpose=false）不拿基因列去对样本表', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bf-orient-'))
  try {
    const runtime = runtimeWith(root)
    const samples = ['A1', 'A2', 'B1', 'B2']
    const matrix = writeSamplesByGenes(root, 'samples_by_genes', samples)
    const sheet = writeSheet(root, 'sheet', samples, ['tumor', 'tumor', 'normal', 'normal'])
    const dataset = await register(runtime, matrix, sheet)
    assert.equal(dataset.transpose, false, '样本×基因矩阵应判定 transpose=false')
    assert.deepEqual(dataset.design.unresolved, [], `身份核对误判：${dataset.design.unresolved.slice(0, 5).join('、')}`)
    const plan = buildPlan({ dataset, template: 'bulk-two-group', params: { contrast: { case: 'tumor', control: 'normal' } } })
    assert.equal(plan.status, 'ready', `方向正确时 plan 应 ready：${(plan.blocking || []).map((gate) => gate.id + ':' + gate.detail).join('；')}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('合并前检查：A 全肿瘤 / B 全正常 → harmonize 直接拦截，不生成跨队列推断', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bf-confound-'))
  try {
    const runtime = runtimeWith(root)
    const aSamples = ['A1', 'A2']
    const bSamples = ['B1', 'B2']
    const a = await register(runtime, writeGenesBySamples(root, 'a', aSamples, 20, 1), writeSheet(root, 'a-sheet', aSamples, ['tumor', 'tumor']))
    const b = await register(runtime, writeGenesBySamples(root, 'b', bSamples, 20, 2), writeSheet(root, 'b-sheet', bSamples, ['normal', 'normal']))
    const result = await impl.runTool(runtime, { action: 'harmonize', dataset_ids: [a.dataset_id, b.dataset_id], method: 'quantile' })
    assert.equal(result.ok, false, '完全混杂时 harmonize 不应 ok:true')
    assert.equal(result.status, 'blocked')
    assert.ok(Array.isArray(result.blocking) && result.blocking.some((gate) => gate.id === 'dataset_confounded'))
    assert.equal(result.merged_dataset_id || null, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('合并映射：两个队列重复样本名 S1–S4，逐队列回填分组，不得串组', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bf-mapping-'))
  try {
    const runtime = runtimeWith(root)
    const sheetA = writeSheet(root, 'sheet-a', ['S1', 'S2', 'S3', 'S4'], ['tumor', 'tumor', 'normal', 'normal'])
    const sheetB = writeSheet(root, 'sheet-b', ['S1', 'S2', 'S3', 'S4'], ['tumor', 'normal', 'tumor', 'normal'])
    const a = await register(runtime, writeGenesBySamples(root, 'a', ['S1', 'S2', 'S3', 'S4'], 30, 1), sheetA)
    const b = await register(runtime, writeGenesBySamples(root, 'b', ['S1', 'S2', 'S3', 'S4'], 30, 2), sheetB)
    const result = await impl.runTool(runtime, { action: 'harmonize', dataset_ids: [a.dataset_id, b.dataset_id], method: 'quantile', target_scale: 'log_expression' })
    assert.equal(result.status, 'succeeded', `合并失败：${result.summary}`)
    assert.ok(result.merged_dataset_id, '没有登记合并数据集')
    const store = new Store({ root })
    const merged = store.getDataset(result.merged_dataset_id)
    store.close()
    assert.equal(merged.design.samples.length, 8, '8 个样本（4+4）')
    const groupOf = (sampleId) => (merged.design.samples.find((sample) => sample.sample_id === sampleId) || {}).group
    assert.equal(groupOf(`${a.dataset_id}:S2`), 'tumor')
    assert.equal(groupOf(`${a.dataset_id}:S3`), 'normal')
    assert.equal(groupOf(`${b.dataset_id}:S2`), 'normal', 'B 队列 S2 不能被 A 的分组覆盖')
    assert.equal(groupOf(`${b.dataset_id}:S3`), 'tumor')
    assert.equal(merged.design.source_mapping.length, 8)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('闸门人话：失败闸门带 fixes 补救动作', () => {
  const dataset = {
    dataset_id: 'ds_demo',
    data_kind: 'bulk',
    scale: { type: 'counts', verified: true },
    files: [{ name: 'm.tsv', path: '/tmp/none.tsv', sha256: 'a'.repeat(64) }],
    design: {
      samples: [{ sample_id: 'S1', group: 'tumor' }, { sample_id: 'S2', group: 'normal' }],
      columns: { sample: 'sample', group: 'group' },
    },
  }
  const result = evaluateGates({ dataset, template: 'bulk-two-group', params: { contrast: { case: 'tumor', control: 'normal' } } })
  const replication = result.gates.find((gate) => gate.id === 'replication')
  assert.ok(Array.isArray(replication.fixes) && replication.fixes.length >= 2, 'replication 闸门应带补救动作')
})
