/**
 * dsh-bioflow · 交付物测试（node:test）
 *
 * 覆盖 BIO_P0_BACKLOG「每个正式任务的交付物」表：
 *   manifest.json / design.tsv / qc.tsv / results/*.tsv / evidence.jsonl / methods.md。
 * 用注入的 stub 适配器跑完整个 run（runtime.adapterFactory），**不启动 python、不联网**，
 * 引擎返回的数值原样进入交付物，因此可以逐字段断言交付契约。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as impl from '../lib/impl.mjs'
import { atomicMove, readDelimitedFile, readRunTablesFile } from '../lib/deliver.mjs'

const MATRIX = [
  'gene,S1,S2,S3,S4',
  'G1,10,12,30,31',
  'G2,5,6,9,10',
  'G3,100,90,120,130',
  '',
].join('\n')

// 合法设计：2 组 × 2 独立供体，batch 与分组交叉（不混杂）
const SAMPLE_SHEET = [
  'sample,group,donor,batch',
  'S1,normal,D1,b1',
  'S2,normal,D2,b2',
  'S3,tumor,D3,b1',
  'S4,tumor,D4,b2',
  '',
].join('\n')

function sha256OfFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function walkFiles(dir, prefix = '') {
  const out = []
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    const relative = prefix ? `${prefix}/${name}` : name
    if (fs.statSync(full).isDirectory()) out.push(...walkFiles(full, relative))
    else out.push(relative)
  }
  return out
}

/** 单行表头 TSV → { header, rows: [{key: value}] }（results/design/qc 都必须是单行表头）。 */
function readTsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
  const header = lines[0].split('\t')
  const rows = lines.slice(1).map((line) => {
    const values = line.split('\t')
    return Object.fromEntries(header.map((key, index) => [key, values[index]]))
  })
  return { header, rows }
}

/** stub 引擎：按 step 返回固定的表/图，deliver 只做抽取与格式转换。 */
function stubResult(step, figurePath) {
  const envelope = (tables, figures = []) => ({ ok: true, tables, figures, summary: `stub ${step}`, method: 'stub-engine' })
  if (step === 'open') {
    return envelope([{
      id: 'dataset_summary', title: '数据集摘要',
      columns: [{ key: 'metric' }, { key: 'value' }],
      rows: [{ metric: 'n_genes', value: 3 }, { metric: 'n_samples', value: 4 }],
    }])
  }
  if (step === 'samples') {
    return envelope([{
      id: 'design_overview', title: '样本设计',
      columns: [{ key: 'group' }, { key: 'n' }],
      rows: [{ group: 'normal', n: 2 }, { group: 'tumor', n: 2 }],
    }])
  }
  if (step === 'qc') {
    return envelope([{
      id: 'qc_metrics', title: '样本质控',
      columns: [{ key: 'sample_id' }, { key: 'n_genes' }, { key: 'pct_mt' }],
      rows: [{ sample_id: 'S1', n_genes: 1000, pct_mt: 3.2 }, { sample_id: 'S2', n_genes: 990, pct_mt: 4.1 }],
    }])
  }
  if (step === 'filter') {
    return envelope([{ id: 'filter_summary', title: '过滤', columns: [{ key: 'kept' }], rows: [{ kept: 3 }] }])
  }
  if (step === 'normalize') {
    return envelope([{ id: 'normalize_summary', title: '标准化', columns: [{ key: 'method' }], rows: [{ method: 'stub-norm' }] }])
  }
  if (step === 'de') {
    return envelope(
      [{
        id: 'de_results', title: '差异表达',
        columns: [
          { key: 'gene' }, { key: 'effect' }, { key: 'p' }, { key: 'q' },
          { key: 'n' }, { key: 'fdr_family' },
        ],
        rows: [
          { gene: 'G1', effect: 1.5, p: 0.01, q: 0.02, n: 2, fdr_family: 'de_all' },
          { gene: 'G2', effect: -0.8, p: 0.2, q: 0.4, n: 2, fdr_family: 'de_all' },
          { gene: 'G3', effect: 0.0, p: 0.9, q: 0.95, n: 2, fdr_family: 'de_all' },
        ],
      }],
      [{ file: figurePath, kind: 'volcano', title: 'Volcano', caption: 'stub volcano' }],
    )
  }
  if (step === 'enrich') {
    return envelope([{
      id: 'enrich_results', title: '功能富集',
      columns: [{ key: 'term' }, { key: 'p' }, { key: 'q' }],
      rows: [{ term: 'Cell cycle', p: 0.02, q: 0.05 }],
    }])
  }
  return envelope([{ id: `${step}_table`, title: step, columns: [{ key: 'value' }], rows: [{ value: 1 }] }])
}

/**
 * 跑一个完整 run：register → plan → submit(wait)。
 * failRequired / failOptional 从计划步骤里反查要注入失败的 step，不硬编码模板步骤名。
 */
async function runBioflow(t, tag, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-bioflow-deliver-${tag}-`))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const matrixPath = path.join(dataDir, 'counts.csv')
  const sampleSheetPath = path.join(dataDir, 'samples.csv')
  fs.writeFileSync(matrixPath, MATRIX)
  fs.writeFileSync(sampleSheetPath, SAMPLE_SHEET)
  const figurePath = path.join(root, 'stub-volcano.png')
  fs.writeFileSync(figurePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]))

  const fail = { step: null }
  const runtime = {
    version: 'test',
    invocation: 'test',
    config: { dataDir: path.join(root, 'store') },
    adapterFactory: async (plugin) => ({
      plugin,
      modulePath: '<stub>',
      info: {},
      async invoke(action, params = {}) {
        const step = params.step || action
        if (fail.step && step === fail.step) {
          throw Object.assign(new Error(`stub 引擎在 ${step} 步骤失败`), { code: 'engine_error' })
        }
        return stubResult(step, figurePath)
      },
      async dispose() {},
    }),
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
    donor_column: 'donor',
    batch_column: 'batch',
    scale: { type: 'counts', verified: true },
    data_kind: 'bulk',
    assay: 'bulk_rna_seq',
    name: `deliver-${tag}`,
  })
  assert.equal(registered.ok, true, `register 应成功：${registered.summary}`)

  const planned = await impl.runTool(runtime, {
    action: 'plan',
    dataset: registered.dataset.dataset_id,
    template: 'bulk-two-group',
    case: 'tumor',
    control: 'normal',
  })
  assert.equal(planned.status, 'ready', `计划应 ready：${JSON.stringify(planned.blocking)}`)

  if (options.failRequired) {
    const requiredStep = planned.plan.steps.find((step) => step.deliver && step.deliver.kind === 'de')
    assert.ok(requiredStep, 'bulk 模板应有差异表达（de）步骤')
    fail.step = (requiredStep.params && requiredStep.params.step) || requiredStep.action
  }
  if (options.failOptional) {
    const optionalStep = planned.plan.steps.find((step) => step.optional === true)
    assert.ok(optionalStep, 'bulk 模板应有可选步骤，用于验证 partial')
    fail.step = (optionalStep.params && optionalStep.params.step) || optionalStep.action
  }

  const submitted = await impl.runTool(runtime, {
    action: 'submit', plan_id: planned.plan_id, confirm_token: planned.confirm_token, wait: true,
  })
  const store = impl.getStore(runtime)
  const runDir = store.runDir(submitted.run_id)
  return { root, runtime, store, planned, submitted, runId: submitted.run_id, runDir, failStep: fail.step }
}

test('14) run 目录里 manifest.json / design.tsv / qc.tsv / results/*.tsv / evidence.jsonl / methods.md 齐全', async (t) => {
  const context = await runBioflow(t, 'files')
  assert.equal(context.submitted.ok, true, `run 应成功：${context.submitted.summary}`)
  assert.equal(context.submitted.status, 'succeeded')

  for (const relative of ['manifest.json', 'design.tsv', 'qc.tsv', 'evidence.jsonl', 'methods.md']) {
    assert.equal(fs.existsSync(path.join(context.runDir, relative)), true, `${relative} 应存在`)
  }
  const resultsDir = path.join(context.runDir, 'results')
  const resultTables = fs.readdirSync(resultsDir).filter((name) => name.endsWith('.tsv'))
  assert.ok(resultTables.length >= 1, 'results/ 下应有 *.tsv 结果表')
  assert.ok(fs.existsSync(path.join(resultsDir, 'tables.index.json')), 'results/tables.index.json 应存在')
})

test('15) manifest.json 字段完整：schema/run/dataset revision/plan/steps/warnings/artifact 哈希/environment/created_at', async (t) => {
  const context = await runBioflow(t, 'manifest')
  const manifest = JSON.parse(fs.readFileSync(path.join(context.runDir, 'manifest.json'), 'utf8'))

  assert.ok(Number.isInteger(manifest.schema_version) && manifest.schema_version >= 1, 'schema_version 应是正整数')
  assert.equal(manifest.run_id, context.runId)
  assert.equal(manifest.ok, true)
  assert.equal(manifest.status, 'succeeded')
  assert.equal(manifest.dataset.dataset_id, context.planned.plan.dataset_id)
  assert.ok(manifest.dataset.revision, '必须记录 dataset revision')

  // 冻结的完整计划（模板/步骤/参数/闸门）必须进 manifest，重启后单文件可复现
  assert.ok(manifest.plan, 'manifest 必须内嵌 plan')
  assert.equal(manifest.plan.plan_id, manifest.plan_id)
  assert.equal(manifest.plan.template, 'bulk-two-group')
  assert.ok(Array.isArray(manifest.plan.steps) && manifest.plan.steps.length > 0)

  // 逐步状态
  assert.ok(Array.isArray(manifest.steps) && manifest.steps.length > 0)
  for (const step of manifest.steps) {
    assert.ok(step.step_id, '每个 step 必须有 step_id')
    assert.ok(['ok', 'failed', 'cancelled'].includes(step.status), `step ${step.step_id} 状态非法：${step.status}`)
  }

  assert.ok(Array.isArray(manifest.warnings))
  assert.ok(manifest.environment, '必须记录运行环境')
  assert.ok(manifest.environment.node, 'environment.node')
  assert.ok(manifest.environment.bioflow_version, 'environment.bioflow_version')
  assert.ok(manifest.environment.platform, 'environment.platform')
  assert.ok(manifest.created_at && !Number.isNaN(Date.parse(manifest.created_at)), 'created_at 应是可解析时间')

  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, '必须记录产物及哈希')
  for (const artifact of manifest.artifacts) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/, `${artifact.relative_path} 应带 sha256`)
  }
})

test('16) manifest 里每个 artifact 的 sha256 与磁盘实际文件重算一致（且覆盖全部交付文件）', async (t) => {
  const context = await runBioflow(t, 'hashes')
  const manifest = JSON.parse(fs.readFileSync(path.join(context.runDir, 'manifest.json'), 'utf8'))
  const diskFiles = walkFiles(context.runDir).filter((relative) => relative !== 'manifest.json').sort()
  const listed = new Map(manifest.artifacts.map((artifact) => [artifact.relative_path, artifact.sha256]))

  assert.deepEqual([...listed.keys()].sort(), diskFiles,
    'manifest.artifacts 必须覆盖 run 目录里全部交付文件（manifest.json 自身除外）')
  for (const relative of diskFiles) {
    const actual = sha256OfFile(path.join(context.runDir, relative))
    assert.equal(actual, listed.get(relative), `${relative} 的 sha256 应与磁盘一致`)
  }
})

test('17) design.tsv 含组/每组独立 n/纳排；results/*.tsv 每行有 table_id/row_id/contrast/effect/p/q/fdr_family/有效 n', async (t) => {
  const context = await runBioflow(t, 'tables')

  // design.tsv：单行表头 + 每个样本一行
  const design = readTsv(path.join(context.runDir, 'design.tsv'))
  for (const column of ['sample_id', 'group', 'donor_id', 'role', 'n_group_samples', 'n_group_donors', 'included', 'exclusion_reason']) {
    assert.ok(design.header.includes(column), `design.tsv 缺少列 ${column}`)
  }
  assert.equal(design.rows.length, 4, 'design.tsv 应有 4 个样本行')
  for (const row of design.rows) {
    const expectedRole = row.group === 'tumor' ? 'case' : row.group === 'normal' ? 'control' : 'other'
    assert.equal(row.role, expectedRole, `${row.sample_id} 的研究角色应为 ${expectedRole}`)
    assert.equal(Number(row.n_group_samples), 2, '每组独立样本数应写进每一行')
    assert.equal(Number(row.n_group_donors), 2, '每组独立供体数应写进每一行')
    assert.equal(row.included, 'yes', '纳入状态应写进每一行')
  }

  // results/*.tsv：找推断结果表（de），逐行检查可回查字段
  const resultsDir = path.join(context.runDir, 'results')
  const inferential = fs.readdirSync(resultsDir)
    .filter((name) => name.endsWith('.tsv'))
    .map((name) => ({ name, ...readTsv(path.join(resultsDir, name)) }))
    .find((table) => ['effect', 'p', 'q', 'fdr_family', 'n'].every((key) => table.header.includes(key)))
  assert.ok(inferential, '应有一张含 effect/p/q/fdr_family/n 的推断结果表')
  const tableId = inferential.name.replace(/\.tsv$/, '')
  for (const column of ['table_id', 'row_id', 'contrast_id', 'effect', 'p', 'q', 'fdr_family', 'n']) {
    assert.ok(inferential.header.includes(column), `results/${inferential.name} 缺少列 ${column}`)
  }
  assert.equal(inferential.rows.length, 3, '结果表应有引擎返回的 3 行数据（不得掺入标签行）')
  inferential.rows.forEach((row, index) => {
    assert.equal(row.table_id, tableId, '每行必须回指 table_id')
    assert.equal(row.row_id, String(index + 1), 'row_id 必须从 1 起稳定递增')
    assert.equal(row.contrast_id, 'tumor_vs_normal', '每行必须带 contrast 方向')
    assert.ok(Number.isFinite(Number(row.effect)), `effect 应为数值：${row.effect}`)
    assert.ok(Number.isFinite(Number(row.p)), `p 应为数值：${row.p}`)
    assert.ok(Number.isFinite(Number(row.q)), `q 应为数值：${row.q}`)
    assert.ok(Number.isFinite(Number(row.n)) && Number(row.n) >= 2, `有效 n 应为数值：${row.n}`)
    assert.equal(row.fdr_family, 'de_all', '每行必须带 FDR 家族')
  })
})

test('18a) 必选步骤失败 → run 不是 ok:true（status=failed），失败步骤与原因可见', async (t) => {
  const context = await runBioflow(t, 'required-fail', { failRequired: true })

  assert.equal(context.submitted.ok, false, '必选步骤失败不得整体 ok:true')
  assert.equal(context.submitted.status, 'failed')
  assert.match(String(context.submitted.run.error || ''), /stub 引擎在 .* 步骤失败/, 'run.error 应记录可诊断原因')

  const status = await impl.runTool(context.runtime, { action: 'run_status', run_id: context.runId })
  assert.equal(status.status, 'failed')
  assert.equal(status.ok, false)
  const failedSteps = status.run.steps.filter((step) => step.status === 'failed')
  assert.equal(failedSteps.length, 1, '应恰好有一个失败步骤')
  assert.match(String(failedSteps[0].error || ''), /stub 引擎在 .* 步骤失败/)
})

test('18b) 可选步骤失败 → status=partial，manifest 记录失败步骤与 warnings', async (t) => {
  const context = await runBioflow(t, 'optional-fail', { failOptional: true })

  assert.equal(context.submitted.ok, false, 'partial 不得整体 ok:true')
  assert.equal(context.submitted.status, 'partial')

  const manifest = JSON.parse(fs.readFileSync(path.join(context.runDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.status, 'partial')
  assert.equal(manifest.ok, false)
  const failedSteps = manifest.steps.filter((step) => step.status === 'failed')
  assert.equal(failedSteps.length, 1, 'manifest 必须记录失败步骤')
  assert.match(String(failedSteps[0].error || ''), /stub 引擎在 .* 步骤失败/)
  assert.ok(manifest.warnings.some((warning) => warning.includes(failedSteps[0].step_id)),
    'manifest.warnings 应点明失败的步骤')
  assert.equal(fs.existsSync(path.join(context.runDir, 'evidence.jsonl')), true, 'partial 也应留下证据索引')
})

test('18c) 必选步骤失败时 run 目录也应有 manifest（已知缺口：需 lead 改 impl.mjs executeRun）', {
  skip: 'impl.mjs executeRun 在必选步骤失败时直接 throw，不调用 finalizeRun，run 目录没有 manifest/design/qc/evidence；见报告',
}, async (t) => {
  const context = await runBioflow(t, 'required-fail-manifest', { failRequired: true })
  assert.equal(fs.existsSync(path.join(context.runDir, 'manifest.json')), true)
})

test('22) atomicMove 在普通路径下可用（staging → runDir 同盘 rename；跨设备 EXDEV 不可模拟）', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bioflow-deliver-move-'))
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }) })

  const source = path.join(root, '.staging', 'qc', 'qc_metrics.tsv')
  fs.mkdirSync(path.dirname(source), { recursive: true })
  const content = 'sample_id\tn_genes\nS1\t1000\n'
  fs.writeFileSync(source, content)
  const target = path.join(root, 'runs', 'run_move', 'results', 'qc_metrics.tsv')

  atomicMove(source, target)
  assert.equal(fs.existsSync(source), false, '提交后 staging 文件应被移走')
  assert.equal(fs.readFileSync(target, 'utf8'), content, '移动后内容必须逐字节一致')
  assert.equal(sha256OfFile(target), createHash('sha256').update(content).digest('hex'))
})

test('23) readRunTablesFile / readDelimitedFile 能直接读回交付物（ESM 下不再依赖 require）', async (t) => {
  const context = await runBioflow(t, 'readback')

  const index = readRunTablesFile(context.store, context.runId)
  assert.ok(index, 'readRunTablesFile 应返回 results/tables.index.json')
  assert.equal(index.run_id, context.runId)
  assert.ok(Array.isArray(index.tables) && index.tables.length > 0, '表索引应包含结果表')

  const design = readDelimitedFile(path.join(context.runDir, 'design.tsv'))
  assert.ok(design, 'readDelimitedFile 应能解析 design.tsv')
  assert.ok(design.header.includes('sample_id'))
  assert.equal(design.objects.length, 4, 'design.tsv 应解析出 4 个样本对象（单行表头）')
})
