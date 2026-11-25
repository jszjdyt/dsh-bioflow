/**
 * dsh-bioflow / PubMed 真实网络测试 —— 默认跳过
 *
 * 默认跑（node --test ...）绝不联网；只有显式设置 BIOFLOW_LIVE=1 才发真实请求：
 *   BIOFLOW_LIVE=1 node --test plugins/dsh-bioflow/test/live.pubmed.mjs
 *
 * 用真实 NCBI E-utilities 检索一个胃癌肝转移 NK 细胞主题，验证链路能通、pmid 是数字。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PubMedClient, createPubMedClient } from '../lib/pubmed.mjs'

const LIVE = process.env.BIOFLOW_LIVE === '1'
const QUERY = 'gastric cancer liver metastasis NK cell'

test('live：真实检索 "gastric cancer liver metastasis NK cell" 返回 ≥1 条且 pmid 是数字', {
  skip: LIVE ? false : '默认跳过（联网测试；设置 BIOFLOW_LIVE=1 才执行）',
  timeout: 60_000,
}, async () => {
  assert.equal(process.env.BIOFLOW_LIVE, '1', '该用例只应在 BIOFLOW_LIVE=1 时执行')
  const client = createPubMedClient({ cacheDir: null })
  assert.ok(client instanceof PubMedClient)

  const result = await client.search({ term: QUERY, limit: 5, includeAbstracts: true })

  assert.ok(Array.isArray(result.items), 'items 应为数组')
  assert.ok(result.items.length >= 1, `应至少返回 1 条记录，实际 ${result.items.length}`)
  for (const item of result.items) {
    assert.equal(item.source, 'pubmed')
    assert.match(String(item.pmid), /^\d+$/, `pmid 必须是纯数字：${item.pmid}`)
    assert.equal(typeof item.title, 'string')
  }
  assert.equal(result.via, 'builtin')
  assert.equal(result.provenance.library, 'pubmed')
  assert.equal(result.provenance.query, QUERY)
  assert.equal(typeof result.provenance.total, 'number')
  console.log(`[live] total=${result.provenance.total} retrieved=${result.items.length} 首条=${result.items[0].title}`)
})
