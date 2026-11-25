/**
 * 六个模板的结构测试（纯函数，不起引擎、不联网）。
 *
 * 这些断言保护的是「大门口」的核心承诺：六个工作台都能从一个模板被调度到，
 * 每步都是 {plugin, action, params} 的可透传形状，依赖顺序合法，证据类型不乱标。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildPlan, TEMPLATES, listTemplates, evaluateGates } from '../lib/plan.mjs'
import { PLUGIN_IDS } from '../lib/adapters.mjs'

/** 造一个「闸门都能过」的 dataset manifest（bulk）。 */
function datasetFor(kind, { scale = 'counts', n = 2, groups = ['tumor', 'normal'] } = {}) {
  const samples = []
  for (const group of groups) {
    for (let index = 1; index <= n; index += 1) {
      samples.push({ sample_id: `${group}_${index}`, group, donor_id: `D${index}`, batch: '', pair_id: '' })
    }
  }
  return {
    dataset_id: `ds_test_${kind}`,
    name: `test-${kind}`,
    data_kind: kind,
    assay: kind === 'bulk' ? 'rna_seq' : kind,
    scale: { type: scale, verified: true, evidence: '测试夹具' },
    transpose: true,
    data_format: 'auto',
    files: [{ name: 'matrix.tsv', path: '/tmp/does-not-exist.tsv', sha256: 'a'.repeat(64), bytes: 10, role: 'matrix' }],
    design: {
      samples,
      columns: { sample: 'sample', group: 'group', donor: 'donor' },
      group_column: 'group',
      donor_column: 'donor',
      paired: false,
      unresolved: [],
    },
  }
}

const CASES = [
  { template: 'bulk-two-group', kind: 'bulk', scale: 'counts' },
  { template: 'scrna-composition', kind: 'scrna', scale: 'counts' },
  { template: 'spatial-domain', kind: 'spatial', scale: 'counts' },
  { template: 'metabolomics-de', kind: 'metabolomics', scale: 'intensity' },
  { template: 'virtualcell-perturb', kind: 'scrna', scale: 'counts' },
  { template: 'plotlab-figure', kind: 'bulk', scale: 'counts' },
]

test('六个模板都在，且都有步构建器与交付物声明', () => {
  assert.equal(listTemplates().length, 6)
  for (const template of Object.values(TEMPLATES)) {
    assert.ok(Array.isArray(template.mandatory_gates) && template.mandatory_gates.length > 0, `${template.id} 缺 mandatory_gates`)
    assert.equal(typeof template.buildSteps, 'function', `${template.id} 缺 buildSteps`)
    assert.ok(template.title && template.description, `${template.id} 缺 title/description`)
  }
})

for (const item of CASES) {
  test(`模板结构：${item.template} 的步骤可透传且依赖顺序合法`, () => {
    const params = item.template === 'virtualcell-perturb'
      ? { gene: 'G1', mode: 'knockout', strength: 1 }
      : item.template === 'plotlab-figure'
        ? { chart: 'box' }
        : { contrast: { case: 'tumor', control: 'normal' } }
    const plan = buildPlan({ dataset: datasetFor(item.kind, { scale: item.scale }), template: item.template, params })
    assert.ok(plan.steps.length >= 2, `${item.template} 步骤太少`)
    assert.equal(plan.status, 'ready', `${item.template} 闸门未通过：${(plan.blocking || []).map((gate) => `${gate.id}:${gate.detail}`).join('；')}`)

    const seen = new Set()
    for (const step of plan.steps) {
      assert.ok(step.step_id, `${item.template} 有步骤缺 step_id`)
      assert.ok(step.plugin, `${item.template}/${step.step_id} 缺 plugin`)
      assert.ok(step.action, `${item.template}/${step.step_id} 缺 action`)
      assert.equal(typeof step.params, 'object', `${item.template}/${step.step_id} 的 params 必须是对象`)
      assert.ok(step.plugin === 'bioflow' || PLUGIN_IDS.includes(step.plugin), `${item.template}/${step.step_id} 插件未知：${step.plugin}`)
      for (const need of step.requires || []) {
        assert.ok(seen.has(need), `${item.template}/${step.step_id} 依赖了不在它之前的 ${need}`)
      }
      seen.add(step.step_id)
    }
  })
}

test('virtualcell-perturb：产物一律标 model_prediction，且不混入 measured', () => {
  const plan = buildPlan({
    dataset: datasetFor('scrna'),
    template: 'virtualcell-perturb',
    params: { gene: 'G1', mode: 'knockout' },
  })
  const downstream = plan.steps.filter((step) => ['grn', 'perturb', 'plot_perturb', 'plot_grn', 'insight'].includes(step.step_id))
  assert.ok(downstream.length >= 4)
  for (const step of downstream) {
    assert.equal(step.evidence_kind, 'model_prediction', `${step.step_id} 必须是 model_prediction`)
  }
  const qc = plan.steps.find((step) => step.step_id === 'qc')
  assert.equal(qc.evidence_kind, 'descriptive')
})

test('plotlab-figure：不做推断，尺度/重复闸门不拦（只要求登记与样本表）', () => {
  const dataset = datasetFor('bulk', { scale: 'unknown', n: 1 })
  dataset.scale = { type: 'unknown', verified: false }
  const plan = buildPlan({ dataset, template: 'plotlab-figure', params: { chart: 'bar' } })
  assert.equal(plan.status, 'ready', `描述性模板不应被推断闸门拦住：${(plan.blocking || []).map((gate) => gate.id).join('、')}`)
  const gates = plan.gates
  for (const id of ['counts_verified', 'contrast', 'replication']) {
    const gate = gates.find((entry) => entry.id === id)
    assert.ok(gate, `缺闸门 ${id}`)
    assert.equal(gate.blocking, false, `${id} 对描述性模板不应 blocking`)
  }
})

test('spatial-domain：无 contrast 也能 ready；缺数据登记时仍被拦', () => {
  const ready = buildPlan({ dataset: datasetFor('spatial'), template: 'spatial-domain', params: {} })
  assert.equal(ready.status, 'ready')
  const blocked = buildPlan({ dataset: null, template: 'spatial-domain', params: {} })
  assert.equal(blocked.status, 'blocked')
  assert.ok((blocked.blocking || []).some((gate) => gate.id === 'dataset_registered'))
})

test('evaluateGates：bulk 缺 contrast 方向 / 每组 n=1 仍然硬拦', () => {
  const noContrast = evaluateGates({ dataset: datasetFor('bulk'), template: 'bulk-two-group', params: {} })
  assert.equal(noContrast.status, 'blocked')
  assert.ok(noContrast.blocking.some((gate) => gate.id === 'contrast'))

  const single = evaluateGates({
    dataset: datasetFor('bulk', { n: 1 }),
    template: 'bulk-two-group',
    params: { contrast: { case: 'tumor', control: 'normal' } },
  })
  assert.equal(single.status, 'blocked')
  assert.ok(single.blocking.some((gate) => gate.id === 'replication'))
})
