/**
 * dsh-bioflow · 持久化层测试（node:test）
 *
 * 覆盖 BIO_P0_BACKLOG §7 的「不可变 run / 状态机 / 幂等 / 取消零写入 / 内容寻址 / 重启恢复」。
 * 全部离线：每个 test 自建 fs.mkdtemp 根，结束清理；不联网、不 spawn python。
 * import 面向 lib/store.mjs 与 lib/deliver.mjs（提交守卫）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Store } from '../lib/store.mjs'
import { stageStepResult, commitStepResult } from '../lib/deliver.mjs'

/**
 * 每个 test 一个独立临时根 + 一个统一清理钩子。
 * 清理顺序固定为「先 close（JSON 后端 close 会 compact 回快照）→ 再删目录」，
 * 否则 close 可能在已删除的根上重建目录，留下临时垃圾。
 */
function makeWorkspace(t, tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-bioflow-store-${tag}-`))
  const opened = []
  t.after(() => {
    for (const store of opened.reverse()) {
      try { store.close() } catch { /* ignore */ }
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    /** kind=auto 时本机走 sqlite，无 sqlite 时自动降级 JSON。 */
    open(kind = 'auto') {
      const store = new Store({ root, kind })
      opened.push(store)
      return store
    },
  }
}

test('1) 合法迁移链 pending_review→queued→running→succeeded 全部成功，且状态落盘', (t) => {
  const workspace = makeWorkspace(t, 'chain')
  const store = workspace.open()

  const created = store.createRun({ run_id: 'run_chain', status: 'pending_review', dataset_id: 'ds_1', seed: 0 })
  assert.equal(created.run.status, 'pending_review')

  assert.equal(store.transition('run_chain', 'queued').status, 'queued')
  assert.equal(store.transition('run_chain', 'running').status, 'running')
  const done = store.transition('run_chain', 'succeeded')
  assert.equal(done.status, 'succeeded')
  assert.deepEqual(
    done.status_history.map((entry) => entry.status),
    ['pending_review', 'queued', 'running', 'succeeded'],
  )
  assert.ok(done.started_at, 'running 迁移应写 started_at')
  assert.ok(done.finished_at, '终态应写 finished_at')

  // 落盘：同一 root 重新打开（新 Store 实例）能读回终态，而不是只在内存里
  const reopened = workspace.open()
  const persisted = reopened.getRun('run_chain')
  assert.equal(persisted.status, 'succeeded')
  assert.equal(persisted.status_history.length, 4)
})

test('2) 非法迁移（succeeded→running、pending_review→running）抛 code=bad_transition 且状态不变', (t) => {
  const store = makeWorkspace(t, 'transition').open()

  store.createRun({ run_id: 'run_illegal', status: 'pending_review' })
  assert.throws(
    () => store.transition('run_illegal', 'running'),
    (error) => error.code === 'bad_transition',
    'pending_review→running 必须被拒',
  )
  assert.equal(store.getRun('run_illegal').status, 'pending_review')

  store.transition('run_illegal', 'queued')
  store.transition('run_illegal', 'running')
  store.transition('run_illegal', 'succeeded')
  assert.throws(
    () => store.transition('run_illegal', 'running'),
    (error) => error.code === 'bad_transition',
    'succeeded→running 必须被拒',
  )
  assert.equal(store.getRun('run_illegal').status, 'succeeded', '非法迁移后状态保持 succeeded')
})

test('3) 同 idempotency key 重复 createRun 返回同一个 run_id，不新建第二个', (t) => {
  const store = makeWorkspace(t, 'idem').open()

  const first = store.createRun({
    run_id: 'run_idem_1', status: 'queued', idempotency_key: 'IDEM-KEY-1', dataset_id: 'ds_1', seed: 0,
  })
  const second = store.createRun({
    run_id: 'run_idem_2', status: 'queued', idempotency_key: 'IDEM-KEY-1', dataset_id: 'ds_1', seed: 0,
  })
  assert.equal(first.reused, false)
  assert.equal(second.reused, true, '同 key 的第二次 createRun 应复用')
  assert.equal(second.run.run_id, first.run.run_id)
  assert.equal(store.getRun('run_idem_2'), null, '不应创建第二个 run')
  assert.equal(store.listRuns({ limit: 20 }).length, 1)
})

test('4) 取消后零写入：cancelRun → assertWritable 抛 cancelled，提交被拒，run 目录没有 manifest', async (t) => {
  const store = makeWorkspace(t, 'cancel').open()

  store.createRun({ run_id: 'run_cancel', status: 'queued' })
  store.transition('run_cancel', 'running')
  const run = store.getRun('run_cancel')
  const runDir = store.runDir('run_cancel')
  const step = { step_id: 'qc', plugin: 'geobulk', action: 'run', params: {}, deliver: { kind: 'qc' } }
  const result = {
    ok: true,
    tables: [{ id: 'qc_metrics', title: 'QC', columns: [{ key: 'sample_id' }], rows: [{ sample_id: 'S1' }] }],
    figures: [],
    summary: 'stub',
  }
  // 先 stage（允许写 .staging），再取消，然后尝试提交
  const staged = await stageStepResult({ run, runDir, plan: { contrast: null }, dataset: null, step, result })

  const cancelled = store.cancelRun('run_cancel', '测试取消')
  assert.equal(cancelled.changed, true)
  assert.equal(cancelled.run.status, 'cancelled')

  assert.throws(
    () => store.assertWritable('run_cancel'),
    (error) => error.code === 'cancelled',
    '取消后 assertWritable 必须抛 code=cancelled',
  )
  await assert.rejects(
    commitStepResult({ store, run, runDir, staged, step }),
    (error) => error.code === 'cancelled',
    '取消后 commitStepResult 必须拒绝写入 run 目录',
  )
  assert.throws(
    () => store.addArtifact('run_cancel', { relative_path: 'results/x.tsv', sha256: 'deadbeef' }),
    (error) => error.code === 'cancelled',
  )

  assert.equal(fs.existsSync(path.join(runDir, 'manifest.json')), false, '取消后 run 目录不应有 manifest.json')
  assert.equal(fs.existsSync(path.join(runDir, 'results')), false, '取消后不应有已提交的 results/')
  assert.equal(fs.existsSync(path.join(runDir, 'figures')), false, '取消后不应有已提交的 figures/')
})

test('5) crash 后重启：同一 root 新建 Store 实例能读回 run 与 steps/artifacts（非内存态）', (t) => {
  const workspace = makeWorkspace(t, 'restart')
  const first = workspace.open()

  first.createRun({ run_id: 'run_crash', status: 'queued', dataset_id: 'ds_1', seed: 3 })
  first.transition('run_crash', 'running')
  first.setStep('run_crash', { step_id: 'open', plugin: 'geobulk', action: 'open', status: 'running' })
  assert.equal(first.beginAttempt('run_crash', 'open'), 1)
  first.setStep('run_crash', {
    step_id: 'open', plugin: 'geobulk', action: 'open', status: 'ok', finished_at: new Date().toISOString(),
  })
  const artifact = first.addArtifact('run_crash', {
    relative_path: 'results/qc.tsv', sha256: 'f'.repeat(64), bytes: 42, kind: 'table',
  })
  // 不调用 close()：模拟进程崩溃（没有 compact / flush 机会）
  const second = workspace.open()
  const recovered = second.getRun('run_crash')

  assert.ok(recovered, '新 Store 实例必须能读回 run')
  assert.equal(recovered.status, 'running')
  assert.equal(recovered.steps.length, 1)
  assert.equal(recovered.steps[0].step_id, 'open')
  assert.equal(recovered.steps[0].status, 'ok')
  assert.equal(recovered.steps[0].attempts, 1)
  assert.equal(recovered.artifacts.length, 1)
  assert.equal(recovered.artifacts[0].relative_path, 'results/qc.tsv')
  assert.equal(recovered.artifacts[0].sha256, artifact.sha256)
})

test('6) 内容寻址：putArtifact 同一 sha256 幂等，不同 sha256 得到不同 id', (t) => {
  const workspace = makeWorkspace(t, 'artifact')
  const store = workspace.open()

  const shaA = 'a'.repeat(64)
  const shaB = 'b'.repeat(64)
  const first = store.putArtifact({ sha256: shaA, bytes: 10, path: '/data/a.tsv', name: 'a.tsv' })
  const again = store.putArtifact({ sha256: shaA, bytes: 10, path: '/data/a.tsv', name: 'a.tsv' })
  const other = store.putArtifact({ sha256: shaB, bytes: 20, path: '/data/b.tsv', name: 'b.tsv' })

  assert.equal(first.artifact.artifact_id, shaA, 'artifact_id 应是内容哈希')
  assert.equal(again.reused, true, '同 sha256 再次登记应复用')
  assert.equal(again.artifact.artifact_id, first.artifact.artifact_id)
  assert.notEqual(other.artifact.artifact_id, first.artifact.artifact_id, '不同 sha256 必须得到不同 id')
  assert.equal(store.listArtifacts({ limit: 10 }).length, 2)

  // 内容寻址记录也落盘：重启后仍能按 id 查到
  const reopened = workspace.open()
  assert.equal(reopened.getArtifact(shaA).sha256, shaA)
})

test('7b) JSON 降级后端同样持久化 run/steps/artifacts（store.mjs 声称两个后端都可用）', (t) => {
  const workspace = makeWorkspace(t, 'json')
  const store = workspace.open('json')
  assert.equal(store.kind, 'json', '显式 kind=json 应使用 JSON+journal 后端')

  store.createRun({ run_id: 'run_json', status: 'queued' })
  store.transition('run_json', 'running')
  store.setStep('run_json', { step_id: 'qc', plugin: 'geobulk', action: 'run', status: 'ok' })
  store.addArtifact('run_json', { relative_path: 'results/qc.tsv', sha256: 'c'.repeat(64), bytes: 7 })

  const reopened = workspace.open('json')
  const recovered = reopened.getRun('run_json')
  assert.equal(recovered.status, 'running')
  assert.equal(recovered.steps[0].step_id, 'qc')
  assert.equal(recovered.artifacts[0].sha256, 'c'.repeat(64))
})
