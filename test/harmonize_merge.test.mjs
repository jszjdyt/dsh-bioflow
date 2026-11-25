/**
 * 合并数据集回归：两个 bulk 数据集 → harmonize(quantile) → 登记合并数据集 → plan ready。
 *
 * 这条链路曾经坏在矩阵方向（合并矩阵把特征名当样本列），结果 plan 被
 * sample_identity / groups 拦下。这里用纯 JS 数据跑通全链，不启动 Python。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as impl from '../lib/impl.mjs'
import { Store } from '../lib/store.mjs'

/** 造一份 genes × samples 的表达矩阵 + 样本表。 */
function makeDataset(dir, name, groups) {
  const samples = groups.map((group, index) => `${group}_${index + 1}`)
  const lines = ['gene\t' + samples.join('\t')]
  for (let gene = 0; gene < 60; gene += 1) {
    lines.push('G' + String(gene).padStart(4, '0') + '\t' + samples.map((_, index) => 100 + gene * 3 + index * 7).join('\t'))
  }
  const matrixFile = path.join(dir, `${name}.tsv`)
  writeFileSync(matrixFile, lines.join('\n') + '\n')
  const sheetFile = path.join(dir, `${name}-samples.tsv`)
  writeFileSync(sheetFile, 'sample\tgroup\n' + samples.map((sample, index) => `${sample}\t${groups[index]}`).join('\n') + '\n')
  return { matrixFile, sheetFile }
}

test('harmonize → merged dataset → plan 全链路（纯 JS）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bf-merge-'))
  const dataDir = path.join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const runtime = { version: 'test', config: { dataDir }, invocation: 'test' }
  try {
    const first = makeDataset(dataDir, 'cohortA', ['tumor', 'normal'])
    const second = makeDataset(dataDir, 'cohortB', ['tumor', 'tumor', 'normal', 'normal'])
    const registered = []
    for (const item of [first, second]) {
      const result = await impl.runTool(runtime, {
        action: 'register', path: item.matrixFile, sample_sheet: item.sheetFile,
        assay: 'rna-seq', verified: true,
      })
      assert.equal(result.ok, true, `register 失败：${result.summary}`)
      assert.equal(result.dataset.transpose, true, '基因×样本矩阵应自动判定 transpose=true')
      registered.push(result.dataset.dataset_id)
    }

    const harmonized = await impl.runTool(runtime, {
      action: 'harmonize', dataset_ids: registered, method: 'quantile', target_scale: 'log_expression',
    })
    assert.equal(harmonized.status, 'succeeded', `harmonize 失败：${harmonized.error || ''}`)
    assert.ok(harmonized.merged_dataset_id, '没有登记合并数据集')

    const store = new Store({ root: dataDir })
    const merged = store.getDataset(harmonized.merged_dataset_id)
    store.close()
    assert.ok(merged, '合并数据集不存在')
    // 2 + 4 = 6 个样本，方向必须是 基因×样本（transpose=true），分组要能对上
    assert.equal(merged.design.samples.length, 6, `合并样本数不对：${merged.design.samples.length}`)
    assert.equal(merged.transpose, true)
    const groups = [...new Set(merged.design.samples.map((sample) => sample.group).filter(Boolean))].sort()
    assert.deepEqual(groups, ['normal', 'tumor'])
    assert.equal(merged.design.unresolved.length, 0, `有样本没对上分组：${merged.design.unresolved.slice(0, 3).join('、')}`)
    // 合并矩阵表头第二列起必须是样本（不是 G0000 这类特征名）
    const matrixText = (await import('node:fs')).readFileSync(merged.files[0].path, 'utf8')
    const header = matrixText.split('\n', 1)[0].split('\t')
    assert.equal(header[0], 'gene')
    assert.ok(header.slice(1).every((name) => !/^G\d{4}$/.test(name)), '合并矩阵把特征名写进了样本列')

    const plan = await impl.runTool(runtime, {
      action: 'plan', dataset: harmonized.merged_dataset_id, template: 'bulk-two-group',
      case: 'tumor', control: 'normal',
    })
    assert.equal(plan.status, 'ready', `合并数据集 plan 未通过：${(plan.blocking || []).map((gate) => gate.id + ':' + gate.detail).join('；')}`)
    assert.ok(plan.plan.steps.some((step) => step.step_id === 'de'))
  } finally {
    try { await impl.disposeRuntime(runtime) } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true })
  }
})
