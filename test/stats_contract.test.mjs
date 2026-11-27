/**
 * dsh-bioflow · 统计口径契约测试（node:test）
 *
 * 契约的职责是「显式化」，不是「补全」：能从冻结产物里取到的字段必须原样搬运，
 * 取不到必须写 null 并进 caveats。这里用最小 manifest 夹具把三类情况钉死：
 *   1) 齐全 → ok_to_cite=true，方向/每组 n/检验/校正/哈希都能回查；
 *   2) 有缺陷 → 对应 warn caveat 必须出现，ok_to_cite=false；
 *   3) 未完成 → no_manifest 警告，不抛错。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildStatsContract, STATS_CONTRACT_SCHEMA } from '../lib/stats_contract.mjs'

function baseManifest(overrides = {}) {
  const manifest = {
    schema_version: 1,
    run_id: 'run_a1b2c3',
    plan_id: 'plan_9f8e7d',
    template: 'bulk-two-group',
    plan: {
      plan_id: 'plan_9f8e7d',
      template: 'bulk-two-group',
      params: { fdr: 'BH FDR 0.05' },
      contrast: { case: 'tumor', control: 'normal', direction: 'case_minus_control' },
      design: {
        group_column: 'group',
        donor_column: 'donor',
        pair_column: null,
        paired: false,
        covariates: [],
        groups: ['normal', 'tumor'],
        n_per_group: { normal: 3, tumor: 3 },
        donors_per_group: { normal: 3, tumor: 3 },
        n_samples: 6,
        contrast: 'tumor - normal',
      },
      steps: [
        { step_id: 'de', plugin: 'dsh-geobulk', action: 'de', params: { method: 'limma-voom' } },
        { step_id: 'enrich', plugin: 'dsh-geobulk', action: 'enrich', params: {} },
      ],
    },
    dataset: {
      dataset_id: 'ds_1',
      revision: 'ds_1',
      name: 'GSE_demo',
      assay: 'rna-seq',
      species: 'human',
      platform: 'GPL570',
      scale: { type: 'counts', verified: true, evidence: '用户声明' },
      files: [{ name: 'counts.csv', sha256: 'aa' }],
      clinical: null,
      sample_sheet: '/data/samples.csv',
    },
    environment: {
      bioflow_version: '0.1.0',
      node: 'v22.0.0',
      platform: 'darwin-arm64',
      plugins: { 'dsh-geobulk': { ok: true, version: '0.1.2' } },
      captured_at: '2026-11-27T10:00:00Z',
    },
    evidence: {
      records: 12,
      measured: 12,
      descriptive: 0,
      model_prediction: 0,
      figures: 3,
      alpha: 0.05,
      coverage: { rows_total: 120, rows_indexed: 120 },
      failed_steps: [],
    },
    zero_significant: false,
    content_hash: 'b3d4f5a6c7d8e9f0',
    seed: 42,
  }
  return deepMerge(manifest, overrides)
}

function deepMerge(target, patch) {
  if (!patch || typeof patch !== 'object') return target
  const out = Array.isArray(target) ? target.slice() : { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(out[key] || {}, value)
    } else {
      out[key] = value
    }
  }
  return out
}

const RUN = {
  run_id: 'run_a1b2c3',
  plan_id: 'plan_9f8e7d',
  template: 'bulk-two-group',
  status: 'succeeded',
  dataset_id: 'ds_1',
  dataset_revision: 'ds_1',
  seed: 42,
  manifest_sha256: 'ff00ff00ff00ff00',
  run_dir: '/runs/run_a1b2c3',
}

test('统计口径 1) 齐全 manifest：方向 / 每组 n / 检验 / 校正 / 哈希都可回查', () => {
  const contract = buildStatsContract({ run: RUN, manifest: baseManifest() })

  assert.equal(contract.schema, STATS_CONTRACT_SCHEMA)
  assert.equal(contract.contrast.case, 'tumor')
  assert.equal(contract.contrast.control, 'normal')
  assert.equal(contract.contrast.direction, 'tumor - normal')
  assert.equal(contract.contrast.effect_convention, 'logFC = case - control')

  assert.equal(contract.design.n_samples, 6)
  assert.equal(contract.design.n_donors, 6)
  assert.equal(contract.design.min_group_n, 3)
  assert.equal(contract.design.groups.length, 2)

  assert.equal(contract.inference.tests.length, 1, '只应记录真正声明了方法的步骤')
  assert.equal(contract.inference.tests[0].method, 'limma-voom')
  assert.equal(contract.inference.fdr.alpha, 0.05)
  assert.match(String(contract.inference.fdr.method), /BH/)

  assert.equal(contract.data.scale, 'counts')
  assert.equal(contract.data.scale_verified, true)
  assert.equal(contract.identity.content_hash, 'b3d4f5a6c7d8e9f0')
  assert.equal(contract.identity.manifest_sha256, 'ff00ff00ff00ff00')
  assert.equal(contract.evidence.n_claims, 12)
  assert.equal(contract.environment.bioflow_version, '0.1.0')

  assert.deepEqual(contract.caveats.filter((item) => item.level === 'warn'), [], '齐全数据不应有 warn')
  assert.equal(contract.ok_to_cite, true)
  assert.equal(contract.reproduce.length, 3)
  assert.ok(contract.reproduce[0].includes('run-status --run-id=run_a1b2c3'))
})

test('统计口径 2) 尺度未验证 / 配对缺列 / 模型预测 / n<2 / 缺哈希 → 全部进 caveats 且不可引用', () => {
  const manifest = baseManifest({
    dataset: { scale: { type: 'log_expression', verified: false } },
    plan: {
      design: {
        paired: true,
        pair_column: null,
        n_per_group: { normal: 1, tumor: 3 },
        donors_per_group: { normal: 1, tumor: 3 },
        n_samples: 4,
      },
      params: { fdr: null },
    },
    evidence: { model_prediction: 2, measured: 10, records: 12 },
    content_hash: null,
  })
  const contract = buildStatsContract({ run: RUN, manifest })
  const codes = contract.caveats.map((item) => item.code)

  assert.ok(codes.includes('scale_unverified'), 'log 尺度未验证必须警告')
  assert.ok(codes.includes('paired_without_pair_column'), '配对缺配对列必须警告')
  assert.ok(codes.includes('min_group_n_below_2'), '每组 n<2 必须警告')
  assert.ok(codes.includes('donor_replication_low'), '供体数<2 必须警告')
  assert.ok(codes.includes('model_prediction_present'), '模型预测必须标注')
  assert.ok(codes.includes('no_content_hash'), '缺 content_hash 必须警告')
  // fdr 未显式指定时应回落到「引擎默认 BH」并标明来源，而不是报缺失（methods.md 记载默认 BH）
  assert.equal(contract.inference.fdr.method, 'BH')
  assert.equal(contract.inference.fdr.source, 'engine_default')
  assert.ok(codes.includes('fdr_engine_default'), '引擎默认校正必须标明来源')
  assert.ok(!codes.includes('fdr_unknown'), '已标来源时不应再报「方法未知」')
  assert.equal(contract.ok_to_cite, false)
  assert.equal(contract.evidence.kinds.model_prediction, 2)
})

test('统计口径 3) 未完成 run：不抛错，no_manifest 警告 + 空身份字段', () => {
  const contract = buildStatsContract({ run: { run_id: 'run_x', status: 'running' }, manifest: null })

  assert.equal(contract.run_id, 'run_x')
  assert.equal(contract.status, 'running')
  assert.equal(contract.identity.content_hash, null)
  assert.equal(contract.ok_to_cite, false)
  assert.ok(contract.caveats.some((item) => item.code === 'no_manifest'))
  assert.equal(contract.reproduce.length, 3, '即使未完成也应能给出回查命令')
})

test('统计口径 4) 证据索引被截断时必须显式说明，不能静默', () => {
  const manifest = baseManifest({
    evidence: { coverage: { rows_total: 1200, rows_indexed: 500 } },
  })
  const contract = buildStatsContract({ run: RUN, manifest })
  const truncated = contract.caveats.find((item) => item.code === 'evidence_truncated')

  assert.ok(truncated, '截断必须有 caveat')
  assert.match(truncated.text, /500\/1200/)
})

test('统计口径 5) 计划阶段 phase=plan：给出 preflight 提示，但不把未发生的产物说成缺失', () => {
  const contract = buildStatsContract({
    run: { run_id: null, plan_id: 'plan_9f8e7d', template: 'bulk-two-group', status: 'ready', dataset_id: 'ds_1' },
    plan: baseManifest().plan,
    dataset: baseManifest().dataset,
    phase: 'plan',
  })
  const codes = contract.caveats.map((item) => item.code)

  assert.equal(contract.phase, 'plan')
  assert.equal(contract.identity.content_hash, null)
  assert.ok(codes.includes('plan_preview'), '计划阶段必须有 preflight 提示')
  assert.ok(!codes.includes('no_manifest'), '计划阶段不应报「缺 manifest」')
  assert.ok(!codes.includes('no_content_hash'), '计划阶段不应报「缺 content_hash」')
  assert.equal(contract.ok_to_cite, false, '计划阶段不可引用（还没跑）')
  // 但设计/校正/尺度这些「提交前可改」的字段必须照常算出
  assert.equal(contract.design.min_group_n, 3)
  assert.equal(contract.inference.fdr.alpha, 0.05)
  assert.equal(contract.data.scale_verified, true)
  assert.equal(contract.inference.tests[0].method, 'limma-voom')
})
