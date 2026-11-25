/**
 * dsh-bioflow · 计划闸门测试（node:test）
 *
 * 覆盖 BIO_P0_BACKLOG §7 runs.plan 的「设计无法识别 / 重复不足 / contrast 方向未定义 → 阻止推断步骤」，
 * 以及「零显著不是闸门」。数据夹具先 register（带样本表的 CSV），再走 action=plan。
 * 全部离线：自建 mkdtemp 根，不联网、不 spawn python。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as impl from '../lib/impl.mjs'

const MATRIX_GENES = ['G1,10,12,30,31', 'G2,5,6,9,10', 'G3,100,90,120,130']

/**
 * 造一个 bulk 数据集：矩阵列名 = matrixSamples，样本表列由 samples 的键决定。
 * samples: [{ sample, group, donor, batch? }, ...]
 */
async function setupDataset(t, tag, samples) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-bioflow-plan-${tag}-`))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const matrixSamples = samples.map((sample) => sample.sample)
  const matrixPath = path.join(dataDir, 'counts.csv')
  fs.writeFileSync(matrixPath, ['gene,' + matrixSamples.join(','), ...MATRIX_GENES, ''].join('\n'))
  const sheetHeader = Object.keys(samples[0])
  const sampleSheetPath = path.join(dataDir, 'samples.csv')
  fs.writeFileSync(sampleSheetPath, [
    sheetHeader.join(','),
    ...samples.map((sample) => sheetHeader.map((key) => sample[key]).join(',')),
    '',
  ].join('\n'))

  const runtime = {
    version: 'test',
    invocation: 'test',
    config: { dataDir: path.join(root, 'store') },
  }
  t.after(() => {
    impl.disposeRuntime(runtime)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const registered = await impl.runTool(runtime, {
    action: 'register',
    path: matrixPath,
    sample_sheet: sampleSheetPath,
    sample_column: 'sample',
    group_column: 'group',
    donor_column: sheetHeader.includes('donor') ? 'donor' : undefined,
    batch_column: sheetHeader.includes('batch') ? 'batch' : undefined,
    scale: { type: 'counts', verified: true },
    data_kind: 'bulk',
    assay: 'bulk_rna_seq',
    name: `plan-${tag}`,
  })
  assert.equal(registered.ok, true, `register 应成功：${registered.summary}`)
  return { root, runtime, datasetId: registered.dataset.dataset_id }
}

function plan(runtime, datasetId, extra = {}) {
  return impl.runTool(runtime, {
    action: 'plan', dataset: datasetId, template: 'bulk-two-group', ...extra,
  })
}

const LEGAL_SAMPLES = [
  { sample: 'S1', group: 'normal', donor: 'D1', batch: 'b1' },
  { sample: 'S2', group: 'normal', donor: 'D2', batch: 'b2' },
  { sample: 'S3', group: 'tumor', donor: 'D3', batch: 'b1' },
  { sample: 'S4', group: 'tumor', donor: 'D4', batch: 'b2' },
]

test('10) 每组独立 n=1 → status=blocked，replication 闸门指出哪组重复不足', async (t) => {
  const { runtime, datasetId } = await setupDataset(t, 'n1', [
    { sample: 'S1', group: 'normal', donor: 'D1' },
    { sample: 'S2', group: 'tumor', donor: 'D2' },
  ])
  const planned = await plan(runtime, datasetId, { case: 'tumor', control: 'normal' })

  assert.equal(planned.ok, false)
  assert.equal(planned.status, 'blocked')
  const replication = planned.gates.find((gate) => gate.id === 'replication')
  assert.ok(replication, '必须有 replication 闸门')
  assert.equal(replication.status, 'fail')
  assert.match(replication.title, /重复/, '闸门标题应说明是独立重复不足')
  assert.match(replication.detail, /n≥2/, '详情应给出 n≥2 的判据')
  assert.match(replication.detail, /normal=1/, '详情应点名哪一组独立 n=1')
  assert.match(replication.detail, /tumor=1/, '详情应点名哪一组独立 n=1')
  assert.ok(planned.blocking.some((item) => item.id === 'replication'), 'blocking 里应能定位到这条闸门')
  // 拦的是推断步骤：计划里仍有 de（差异表达）步骤，只是 plan 状态 blocked
  assert.ok(planned.plan.steps.some((step) => step.deliver && step.deliver.kind === 'de'),
    '被拦住的应是差异表达步骤（计划步骤仍可见以便定位）')
})

test('11) 完全混杂（分组 100% 由 batch 决定 → 设计不可识别）→ blocked', async (t) => {
  const { runtime, datasetId } = await setupDataset(t, 'confounded', [
    { sample: 'S1', group: 'normal', donor: 'D1', batch: 'b1' },
    { sample: 'S2', group: 'normal', donor: 'D2', batch: 'b1' },
    { sample: 'S3', group: 'tumor', donor: 'D3', batch: 'b2' },
    { sample: 'S4', group: 'tumor', donor: 'D4', batch: 'b2' },
  ])
  const planned = await plan(runtime, datasetId, { case: 'tumor', control: 'normal' })

  assert.equal(planned.status, 'blocked')
  const confounded = planned.gates.find((gate) => gate.id === 'design_confounded')
  assert.ok(confounded, '必须有 design_confounded 闸门')
  assert.equal(confounded.status, 'fail')
  assert.match(confounded.detail, /完全混杂|共线|不可识别/)
  assert.ok(planned.blocking.some((item) => item.id === 'design_confounded'))
  // 重复并不缺：确认拦的是混杂而不是 n 小
  const replication = planned.gates.find((gate) => gate.id === 'replication')
  assert.equal(replication.status, 'pass', '每组 n=2，重复闸门应通过')
})

test('12) contrast 缺方向（没给 case/control）→ blocked', async (t) => {
  const { runtime, datasetId } = await setupDataset(t, 'no-contrast', LEGAL_SAMPLES)
  const planned = await plan(runtime, datasetId)

  assert.equal(planned.status, 'blocked')
  const contrast = planned.gates.find((gate) => gate.id === 'contrast')
  assert.ok(contrast, '必须有 contrast 闸门')
  assert.equal(contrast.status, 'fail')
  assert.match(contrast.detail, /case.*control|方向/, '详情应要求同时给出 case 与 control')
  assert.equal(planned.plan.contrast, null, '未定义方向时计划里不应出现 contrast')
  assert.ok(planned.blocking.some((item) => item.id === 'contrast'))
})

test('13) 零显著放行：设计合法、输入合法 → plan 不被拦（ready），不因预测零显著而 blocked', async (t) => {
  const { runtime, datasetId } = await setupDataset(t, 'legal', LEGAL_SAMPLES)
  const planned = await plan(runtime, datasetId, { case: 'tumor', control: 'normal' })

  assert.equal(planned.status, 'ready')
  assert.equal(planned.ok, true)
  assert.deepEqual(planned.blocking, [], 'ready 的计划不应有 blocking 条目')
  assert.equal(planned.gates.filter((gate) => gate.status === 'fail').length, 0, '不应有 fail 闸门')
  assert.equal(planned.plan.status, 'ready')
  assert.equal(planned.plan.contrast.contrast_id, 'tumor_vs_normal')
  assert.equal(planned.plan.contrast.case, 'tumor')
  assert.equal(planned.plan.contrast.control, 'normal')
  assert.equal(planned.plan.contrast.direction, 'case_minus_control', '方向必须是 case - control')
  assert.ok(planned.confirm_token, 'ready 计划应给出 confirm_token 供用户确认')
})
