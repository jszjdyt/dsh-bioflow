/**
 * dsh-bioflow · RO-Crate 导出适配测试（node:test）
 *
 * 目标：结果包能被外部工具消费，必须有可校验的实体图，而不是「有个 json 文件」。
 * 覆盖：必需实体、引用完整性、文件 provenance、动作状态映射、校验器能抓坏 crate、
 * 预览页可读；以及导出链路真的把 ro-crate-metadata.json 写进包内且结构校验通过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProcessRunCrate,
  validateRoCrate,
  renderRoCratePreview,
  RO_CRATE_SCHEMA,
  RO_CRATE_CONTEXT,
  RO_CRATE_CONFORMS_TO,
  PROCESS_RUN_PROFILE,
} from '../lib/rocrate.mjs'

const MANIFEST = {
  schema_version: 1,
  run_id: 'run_a1b2c3',
  template: 'bulk-two-group',
  plan: {
    template: 'bulk-two-group',
    contrast: { case: 'tumor', control: 'normal' },
    params: { fdr: 'BH FDR 0.05', seed: 0 },
  },
  dataset: {
    dataset_id: 'ds_1',
    name: 'GSE_demo',
    assay: 'rna-seq',
    species: 'human',
    scale: { type: 'counts', verified: true },
    files: [{ name: 'counts.csv' }],
  },
  environment: {
    bioflow_version: '0.1.0',
    node: 'v22.0.0',
    platform: 'darwin-arm64',
    plugins: { 'dsh-geobulk': { ok: true, version: '0.1.2' } },
  },
  steps: [
    { step_id: 'de', plugin: 'dsh-geobulk', action: 'de', status: 'ok', started_at: '2026-11-27T10:00:01Z', finished_at: '2026-11-27T10:00:09Z', tables: ['de_results'], figures: ['volcano_1'] },
    { step_id: 'enrich', plugin: 'dsh-geobulk', action: 'enrich', status: 'failed', started_at: '2026-11-27T10:00:09Z', finished_at: '2026-11-27T10:00:11Z', error: '数据库不可用' },
  ],
  evidence: { records: 12, alpha: 0.05 },
  zero_significant: false,
  content_hash: 'b3d4f5a6',
  created_at: '2026-11-27T10:00:00Z',
  finished_at: '2026-11-27T10:00:20Z',
}

const FILES = [
  { path: 'manifest.json', sha256: 'aa11', bytes: 1000 },
  { path: 'results/de_results.tsv', sha256: 'bb22', bytes: 2048 },
  { path: 'figures/volcano_1.png', sha256: 'cc33', bytes: 4096 },
  { path: 'evidence.jsonl', sha256: 'dd44', bytes: 512 },
]
const TABLES_INDEX = {
  tables: [{ table_id: 'de_results', relative_path: 'results/de_results.tsv' }],
  figures: [{ figure_id: 'volcano_1', file: 'figures/volcano_1.png' }],
}

const RUN = {
  run_id: 'run_a1b2c3',
  status: 'partial',
  started_at: '2026-11-27T10:00:00Z',
  finished_at: '2026-11-27T10:00:20Z',
  manifest_sha256: 'ff00ff00',
}

function byId(crate, id) {
  return (crate['@graph'] || []).find((entity) => entity && entity['@id'] === id)
}

test('RO-Crate 1) 实体齐全：描述符 / root / 文件 / 软件 / 动作，且结构校验通过', () => {
  const crate = buildProcessRunCrate({ run: RUN, manifest: MANIFEST, files: FILES, tablesIndex: TABLES_INDEX })
  const check = validateRoCrate(crate)
  assert.deepEqual(check.issues, [], '合格 crate 不应有校验问题')
  assert.equal(check.ok, true)

  assert.equal(crate['@context'], RO_CRATE_CONTEXT)
  const descriptor = byId(crate, RO_CRATE_SCHEMA)
  assert.ok(descriptor, '必须有 ro-crate-metadata.json 实体')
  assert.deepEqual(descriptor.about, { '@id': './' })

  const root = byId(crate, './')
  assert.ok(root, '必须有 root Dataset')
  const conforms = root.conformsTo.map((item) => item['@id'])
  assert.ok(conforms.includes(RO_CRATE_CONFORMS_TO))
  assert.ok(conforms.includes(PROCESS_RUN_PROFILE))

  // 文件实体：每个导出文件都有 sha256 与 contentSize
  for (const file of FILES) {
    const entity = byId(crate, file.path)
    assert.ok(entity, `缺文件实体 ${file.path}`)
    assert.equal(entity['@type'], 'File')
    assert.equal(entity.sha256, file.sha256)
    assert.equal(entity.contentSize, file.bytes)
    assert.ok(root.hasPart.some((part) => part['@id'] === file.path))
  }
  // 输入数据集：作为独立实体描述来源，不把未导出文件伪装成包内文件
  const datasetEntity = byId(crate, '#dataset')
  assert.ok(datasetEntity, '缺输入数据集实体')
  assert.equal(datasetEntity.identifier, 'ds_1')
  assert.equal(datasetEntity['bioflow:scale'], 'counts')
  assert.deepEqual(byId(crate, '#run').object, [{ '@id': '#dataset' }])

  // 软件：bioflow + 插件版本
  assert.equal(byId(crate, '#bioflow').softwareVersion, '0.1.0')
  assert.equal(byId(crate, '#plugin-dsh-geobulk').softwareVersion, '0.1.2')
  // 动作：成功与失败状态要区分；step 产物要挂到 figure/table 对应文件
  const de = byId(crate, '#step-de')
  assert.ok(de)
  assert.deepEqual(de.actionStatus, { '@id': 'https://schema.org/CompletedActionStatus' })
  assert.ok(de.result.some((item) => item['@id'] === 'results/de_results.tsv'))
  assert.ok(de.result.some((item) => item['@id'] === 'figures/volcano_1.png'))
  const enrich = byId(crate, '#step-enrich')
  assert.deepEqual(enrich.actionStatus, { '@id': 'https://schema.org/FailedActionStatus' })
  assert.equal(enrich.error, '数据库不可用')
  // 计划参数作为 PropertyValue 保留
  const fdr = byId(crate, '#param-fdr')
  assert.ok(fdr && fdr.value === 'BH FDR 0.05')
})

test('RO-Crate 2) 校验器必须能抓住坏 crate（悬空引用/缺描述符/绝对路径/重复 id）', () => {
  const crate = buildProcessRunCrate({ run: RUN, manifest: MANIFEST, files: FILES, tablesIndex: TABLES_INDEX })

  const dangling = structuredClone(crate)
  byId(dangling, './').hasPart.push({ '@id': 'missing.tsv' })
  assert.ok(validateRoCrate(dangling).issues.some((issue) => issue.code === 'dangling_hasPart'))

  const noDescriptor = structuredClone(crate)
  noDescriptor['@graph'] = noDescriptor['@graph'].filter((entity) => entity['@id'] !== RO_CRATE_SCHEMA)
  assert.ok(validateRoCrate(noDescriptor).issues.some((issue) => issue.code === 'no_descriptor'))

  const absolute = structuredClone(crate)
  absolute['@graph'].push({ '@id': '/Users/someone/secret.tsv', '@type': 'File', contentSize: 1 })
  assert.ok(validateRoCrate(absolute).issues.some((issue) => issue.code === 'absolute_id'))

  const duplicated = structuredClone(crate)
  duplicated['@graph'].push({ '@id': 'manifest.json', '@type': 'File', contentSize: 1 })
  assert.ok(validateRoCrate(duplicated).issues.some((issue) => issue.code === 'duplicate_id'))

  const badContext = structuredClone(crate)
  badContext['@context'] = 'https://example.com/context'
  assert.ok(validateRoCrate(badContext).issues.some((issue) => issue.code === 'bad_context'))
})

test('RO-Crate 3) 预览页可读：标题/描述/实体表/元数据链接都在', () => {
  const crate = buildProcessRunCrate({ run: RUN, manifest: MANIFEST, files: FILES, tablesIndex: TABLES_INDEX })
  const html = renderRoCratePreview(crate)
  assert.match(html, /<!DOCTYPE html>/)
  assert.match(html, /GSE_demo/)
  assert.match(html, /ro-crate-metadata\.json/)
  assert.match(html, /results\/de_results\.tsv/)
  assert.match(html, new RegExp(RO_CRATE_CONFORMS_TO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('RO-Crate 4) 没有 plan/dataset 的最小 run 也能生成合法 crate（不编造字段）', () => {
  const crate = buildProcessRunCrate({ run: { run_id: 'run_min', status: 'succeeded' }, manifest: {}, files: [] })
  const check = validateRoCrate(crate)
  assert.deepEqual(check.issues, [])
  const root = byId(crate, './')
  assert.match(root.name, /run_min/)
  assert.equal(root.description, undefined, '没有可写信息时不要编造 description')
  assert.deepEqual(root.hasPart, [])
})
