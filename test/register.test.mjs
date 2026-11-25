/**
 * dsh-bioflow · register（数据登记）测试（node:test）
 *
 * 覆盖 BIO_P0_BACKLOG §7 datasets.register 的「文件字节 + 样本表共同决定数据身份」：
 * 同字节重复登记幂等、改一个字节即新版本、登记结果里的 sha256 与真实文件一致。
 * 全部离线：自建 mkdtemp 根，不联网、不 spawn python。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as impl from '../lib/impl.mjs'

const MATRIX = [
  'gene,S1,S2,S3,S4',
  'G1,10,12,30,31',
  'G2,5,6,9,10',
  'G3,100,90,120,130',
  '',
].join('\n')

const SAMPLE_SHEET = [
  'sample,group,donor',
  'S1,normal,D1',
  'S2,normal,D2',
  'S3,tumor,D3',
  'S4,tumor,D4',
  '',
].join('\n')

function sha256OfFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 建一个独立临时工作区：数据文件 + 样本表 + 只用于测试的 runtime（dataDir 在临时根里）。 */
function setupWorkspace(t, tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-bioflow-register-${tag}-`))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const matrixPath = path.join(dataDir, 'counts.csv')
  const sampleSheetPath = path.join(dataDir, 'samples.csv')
  fs.writeFileSync(matrixPath, MATRIX)
  fs.writeFileSync(sampleSheetPath, SAMPLE_SHEET)
  const runtime = {
    version: 'test',
    invocation: 'test',
    config: { dataDir: path.join(root, 'store') },
  }
  t.after(() => {
    impl.disposeRuntime(runtime)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, dataDir, matrixPath, sampleSheetPath, runtime }
}

function register(runtime, { matrixPath, sampleSheetPath }) {
  return impl.runTool(runtime, {
    action: 'register',
    path: matrixPath,
    sample_sheet: sampleSheetPath,
    sample_column: 'sample',
    group_column: 'group',
    donor_column: 'donor',
    scale: { type: 'counts', verified: true },
    data_kind: 'bulk',
    assay: 'bulk_rna_seq',
    name: 'register-test',
  })
}

test('7) 同一份文件字节重复 register → 同一个 dataset / artifact 内容 id（幂等）', async (t) => {
  const workspace = setupWorkspace(t, 'idempotent')
  const first = await register(workspace.runtime, workspace)
  const second = await register(workspace.runtime, workspace)

  assert.equal(first.ok, true)
  assert.equal(first.reused, false)
  assert.equal(second.ok, true)
  assert.equal(second.reused, true, '同文件字节 + 同样本表应复用已登记数据集')
  assert.equal(second.dataset.dataset_id, first.dataset.dataset_id, 'dataset_id 应相同')
  assert.equal(second.dataset.files.length, 1)
  assert.equal(second.dataset.files[0].sha256, first.dataset.files[0].sha256)
  assert.equal(second.dataset.files[0].artifact_id, first.dataset.files[0].artifact_id, 'artifact 内容 id 应相同')

  const store = impl.getStore(workspace.runtime)
  assert.equal(store.listDatasets({ limit: 10 }).length, 1, '不应登记出第二个数据集')
})

test('8) 改一个字节 → 新的 dataset / artifact 内容 id', async (t) => {
  const workspace = setupWorkspace(t, 'modified')
  const first = await register(workspace.runtime, workspace)
  const originalBytes = fs.readFileSync(workspace.matrixPath, 'utf8')

  const modifiedBytes = originalBytes.replace('G1,10,12,30,31', 'G1,10,13,30,31')
  assert.notEqual(modifiedBytes, originalBytes, '夹具必须真的改了一个字节')
  fs.writeFileSync(workspace.matrixPath, modifiedBytes)

  const second = await register(workspace.runtime, workspace)
  assert.equal(second.reused, false, '文件内容变了就不是同一数据集')
  assert.notEqual(second.dataset.dataset_id, first.dataset.dataset_id, 'dataset_id 必须变化')
  assert.notEqual(second.dataset.files[0].sha256, first.dataset.files[0].sha256, 'artifact sha256 必须变化')
  assert.notEqual(second.dataset.files[0].artifact_id, first.dataset.files[0].artifact_id)

  const store = impl.getStore(workspace.runtime)
  assert.equal(store.listDatasets({ limit: 10 }).length, 2, '旧版本仍可按旧 dataset_id 检索')
})

test('9) 登记结果里的 sha256 与实际文件 sha256 一致', async (t) => {
  const workspace = setupWorkspace(t, 'hash')
  const result = await register(workspace.runtime, workspace)
  const expected = sha256OfFile(workspace.matrixPath)

  assert.equal(result.dataset.files.length, 1)
  assert.equal(result.dataset.files[0].name, 'counts.csv')
  assert.match(result.dataset.files[0].sha256, /^[0-9a-f]{64}$/)
  assert.equal(result.dataset.files[0].sha256, expected, '登记 sha256 必须等于磁盘实际 sha256')
  assert.equal(result.dataset.files[0].artifact_id, expected, 'artifact_id 应使用内容哈希')
  assert.equal(result.dataset.files[0].bytes, fs.statSync(workspace.matrixPath).size)
  assert.equal(result.dataset.sample_sheet.sha256, sha256OfFile(workspace.sampleSheetPath))
})
