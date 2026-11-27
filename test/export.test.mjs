/**
 * dsh-bioflow · runs.export 测试（node:test）
 *
 * 覆盖 BIO_P0_BACKLOG §7 runs.export：「完整结果包与资源 ID；以内容 hash 校验文件，支持重启后查看」。
 * 用注入的 stub 适配器跑完整个 run（runtime.adapterFactory），不启动 python、不联网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as impl from '../lib/impl.mjs'
import { validateRoCrate } from '../lib/rocrate.mjs'

const MATRIX = [
  'gene,S1,S2,S3,S4',
  'G1,10,12,30,31',
  'G2,5,6,9,10',
  '',
].join('\n')

const SAMPLE_SHEET = [
  'sample,group,donor,batch',
  'S1,normal,D1,b1',
  'S2,normal,D2,b2',
  'S3,tumor,D3,b1',
  'S4,tumor,D4,b2',
  '',
].join('\n')

const CORE_DELIVERABLES = ['manifest.json', 'design.tsv', 'qc.tsv', 'evidence.jsonl', 'methods.md']

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

/**
 * 导出内容的稳定哈希：只取可复现字段（run/dataset/manifest 哈希 + 文件内容哈希），
 * 明确排除 exported_at 之类易变字段。两次导出必须得到同一个值。
 */
function exportContentDigest(record) {
  const payload = {
    run_id: record.run_id,
    status: record.status,
    manifest_sha256: record.manifest_sha256,
    files: record.files
      .map((file) => [file.path, file.sha256, file.bytes])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    issues: record.issues,
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function stubResult(step, figurePath) {
  const envelope = (tables, figures = []) => ({ ok: true, tables, figures, summary: `stub ${step}` })
  if (step === 'de') {
    return envelope(
      [{
        id: 'de_results', title: '差异表达',
        columns: [{ key: 'gene' }, { key: 'effect' }, { key: 'p' }, { key: 'q' }, { key: 'n' }, { key: 'fdr_family' }],
        rows: [
          { gene: 'G1', effect: 1.5, p: 0.01, q: 0.02, n: 2, fdr_family: 'de_all' },
          { gene: 'G2', effect: -0.8, p: 0.2, q: 0.4, n: 2, fdr_family: 'de_all' },
        ],
      }],
      [{ file: figurePath, kind: 'volcano', title: 'Volcano' }],
    )
  }
  if (step === 'qc') {
    return envelope([{
      id: 'qc_metrics', title: '样本质控',
      columns: [{ key: 'sample_id' }, { key: 'n_genes' }],
      rows: [{ sample_id: 'S1', n_genes: 1000 }, { sample_id: 'S2', n_genes: 990 }],
    }])
  }
  return envelope([{ id: `${step}_table`, title: step, columns: [{ key: 'value' }], rows: [{ value: 1 }] }])
}

/** register → plan → submit(wait) 跑完一个成功 run，返回新 runtime 所需信息。 */
async function runBioflow(t, tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-bioflow-export-${tag}-`))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const matrixPath = path.join(dataDir, 'counts.csv')
  const sampleSheetPath = path.join(dataDir, 'samples.csv')
  fs.writeFileSync(matrixPath, MATRIX)
  fs.writeFileSync(sampleSheetPath, SAMPLE_SHEET)
  const figurePath = path.join(root, 'stub-volcano.png')
  fs.writeFileSync(figurePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 9, 9]))

  const runtime = {
    version: 'test',
    invocation: 'test',
    config: { dataDir: path.join(root, 'store') },
    adapterFactory: async (plugin) => ({
      plugin,
      modulePath: '<stub>',
      info: {},
      async invoke(action, params = {}) { return stubResult(params.step || action, figurePath) },
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
    name: `export-${tag}`,
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
  const submitted = await impl.runTool(runtime, {
    action: 'submit', plan_id: planned.plan_id, confirm_token: planned.confirm_token, wait: true,
  })
  assert.equal(submitted.status, 'succeeded', `run 应成功：${submitted.summary}`)

  const store = impl.getStore(runtime)
  return {
    root,
    runtime,
    store,
    storeRoot: runtime.config.dataDir,
    submitted,
    runId: submitted.run_id,
    runDir: store.runDir(submitted.run_id),
  }
}

test('19) 同一 run 连续两次 export → 导出内容哈希相同（不含时间戳等易变字段）', async (t) => {
  const context = await runBioflow(t, 'stable')

  const first = await impl.runTool(context.runtime, { action: 'export', run_id: context.runId })
  const second = await impl.runTool(context.runtime, { action: 'export', run_id: context.runId })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.ok(first.export.exported_at, '导出记录带 exported_at（易变字段，不参与内容哈希）')
  assert.equal(
    exportContentDigest(first.export),
    exportContentDigest(second.export),
    '同一 run 两次导出的内容哈希必须一致',
  )
  // 逐文件哈希也必须逐个相同
  assert.deepEqual(
    first.export.files.map((file) => [file.path, file.sha256, file.bytes]),
    second.export.files.map((file) => [file.path, file.sha256, file.bytes]),
  )
  assert.equal(first.export.manifest_sha256, sha256OfFile(path.join(context.runDir, 'manifest.json')),
    '导出记录里的 manifest sha256 应等于磁盘真实哈希')
})

test('20) 导出包里的文件哈希与磁盘一致（且是完整结果包）', async (t) => {
  const context = await runBioflow(t, 'pack')
  const outPath = path.join(context.root, 'exports')
  const exported = await impl.runTool(context.runtime, {
    action: 'export', run_id: context.runId, out_path: outPath,
  })
  assert.equal(exported.ok, true)
  assert.ok(exported.out_path, '应返回导出目录')

  const bundleDir = path.join(outPath, `bioflow-${context.runId}`)
  const exportRecord = JSON.parse(fs.readFileSync(path.join(bundleDir, 'export.json'), 'utf8'))
  assert.equal(exportRecord.run_id, context.runId)
  assert.equal(exportRecord.files.length, exported.export.files.length)

  for (const record of exportRecord.files) {
    const diskSha = sha256OfFile(path.join(context.runDir, record.path))
    const bundleSha = sha256OfFile(path.join(bundleDir, record.path))
    assert.equal(diskSha, record.sha256, `${record.path} 导出记录的哈希应等于磁盘`)
    assert.equal(bundleSha, diskSha, `${record.path} 导出包内文件必须与磁盘逐字节一致`)
  }
  // 完整结果包：核心交付物不能漏
  for (const relative of CORE_DELIVERABLES) {
    assert.equal(fs.existsSync(path.join(bundleDir, relative)), true, `导出包应包含 ${relative}`)
  }
  // 包内文件必须覆盖 run 目录全部交付文件（manifest.json 也在内；允许包内额外附带 export.json 元数据）
  // 导出包现在额外带 RO-Crate 元数据与预览页（契约扩展，不只是元数据文件）
  const RO_CRATE_FILES = ['export.json', 'ro-crate-metadata.json', 'ro-crate-preview.html']
  const bundleFiles = walkFiles(bundleDir).filter((name) => !RO_CRATE_FILES.includes(name))
  const runFiles = walkFiles(context.runDir)
  for (const relative of runFiles) {
    assert.ok(bundleFiles.includes(relative), `导出包缺文件：${relative}`)
  }
  assert.ok(bundleFiles.every((relative) => runFiles.includes(relative)),
    '导出包不应夹带 run 目录之外的未知文件')

  // RO-Crate 集成：包内实体图必须可校验，并与导出记录一致
  const cratePath = path.join(bundleDir, 'ro-crate-metadata.json')
  assert.equal(fs.existsSync(cratePath), true, '导出包必须包含 ro-crate-metadata.json')
  const crate = JSON.parse(fs.readFileSync(cratePath, 'utf8'))
  const crateCheck = validateRoCrate(crate)
  assert.deepEqual(crateCheck.issues, [], `RO-Crate 结构校验应通过：${JSON.stringify(crateCheck.issues)}`)
  assert.equal(exportRecord.ro_crate && exportRecord.ro_crate.valid, true, 'export.json 应记录 RO-Crate 校验结果')
  assert.equal(fs.existsSync(path.join(bundleDir, 'ro-crate-preview.html')), true, '导出包应包含人读预览页')
})

test('21) 重启（新 runtime/store 实例）后仍能按 run_id 查到导出记录', async (t) => {
  const context = await runBioflow(t, 'restart')
  const outPath = path.join(context.root, 'exports-restart')
  const before = await impl.runTool(context.runtime, {
    action: 'export', run_id: context.runId, out_path: outPath,
  })
  assert.equal(before.ok, true)
  const digestBefore = exportContentDigest(before.export)

  // 新 runtime 实例：同一 dataDir，模拟进程重启后只剩落盘状态
  const restarted = { version: 'test', invocation: 'test', config: { dataDir: context.storeRoot } }
  t.after(() => impl.disposeRuntime(restarted))
  const after = await impl.runTool(restarted, { action: 'export', run_id: context.runId })

  assert.equal(after.ok, true, '重启后必须能按 run_id 导出')
  assert.equal(after.export.run_id, context.runId)
  assert.equal(after.export.files.length, before.export.files.length, '重启后导出的文件清单应一致')
  assert.equal(after.export.manifest_sha256, before.export.manifest_sha256)
  assert.equal(exportContentDigest(after.export), digestBefore, '重启前后导出内容哈希必须一致')

  // 之前写出的结果包记录仍在磁盘上，且哈希与 run 目录一致
  const bundleDir = path.join(outPath, `bioflow-${context.runId}`)
  const exportRecord = JSON.parse(fs.readFileSync(path.join(bundleDir, 'export.json'), 'utf8'))
  assert.equal(exportRecord.files.length, before.export.files.length)
  for (const record of exportRecord.files) {
    assert.equal(sha256OfFile(path.join(context.runDir, record.path)), record.sha256)
  }
})
