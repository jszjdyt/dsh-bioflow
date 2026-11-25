/**
 * dsh-bioflow / PubMed 客户端内置测试 —— 完全离线
 *
 * 做法：
 *   - createPubMedClient 注入 stub fetch（记录全部 URL / 调用时刻），绝不联网；
 *   - 注入假的 now/sleep 时钟：令牌桶的等待只推进虚拟时间，测试不真的 sleep；
 *   - 每个用例用独立临时 cacheDir，结束统一清理。
 *
 * 运行：node --test plugins/dsh-bioflow/test/pubmed.test.mjs
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  DEFAULT_CACHE_TTL_MS,
  NCBI_BASE,
  TOOL_NAME,
  createPubMedClient,
  normalizePubMedRecord,
  relaxQuery,
} from '../lib/pubmed.mjs'

// ---------------------------------------------------------------------------
// 夹具（真实 esummary / efetch 形状的最小样本）
// ---------------------------------------------------------------------------

const TERM = 'gastric cancer liver metastasis NK cell'
const PMIDS = ['40000001', '40000002']
const EXPECTED_RELAXED = 'gastric OR cancer OR liver OR metastasis OR NK OR cell'

const DOCSUM_A = {
  uid: '40000001',
  title: 'NK cells in <i>gastric</i> cancer &amp; liver metastasis',
  pubdate: '2023 Nov 12',
  fulljournalname: 'Journal of Experimental Medicine',
  source: 'J Exp Med',
  elocationid: 'doi: 10.1084/jem.20230001',
  authors: [
    { name: 'Alice A', authtype: 'Author' },
    { name: 'Bob B' },
    { name: 'Carol C' },
    { name: 'Dave D' },
  ],
  pubtype: ['Journal Article', 'Review'],
  articleids: [
    { idtype: 'pubmed', value: '40000001' },
    { idtype: 'doi', value: '10.1084/jem.20230001' },
    { idtype: 'pmc', value: 'PMC1234567' },
  ],
}

const DOCSUM_B = {
  uid: '40000002',
  title: 'T cell exhaustion in liver metastases',
  pubdate: '2019',
  fulljournalname: 'Immunity',
  source: 'Immunity',
  authors: [{ name: 'Eve E' }, { name: 'Frank F' }],
  pubtype: ['Journal Article'],
  articleids: [
    { idtype: 'pubmed', value: '40000002' },
    { idtype: 'doi', value: '10.1016/j.immuni.2019.01.001' },
  ],
}

const DOCSUMS = { [PMIDS[0]]: DOCSUM_A, [PMIDS[1]]: DOCSUM_B }

const ABSTRACT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>40000001</PMID>
      <Article>
        <Abstract>
          <AbstractText Label="BACKGROUND">NK cells accumulate in liver metastases.</AbstractText>
          <AbstractText>They express <i>IFNG</i> &amp; CXCR3.</AbstractText>
        </Abstract>
      </Article>
    </MedlineCitation>
    <PubmedData>
      <ArticleIdList><ArticleId IdType="pubmed">40000001</ArticleId></ArticleIdList>
    </PubmedData>
  </PubmedArticle>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>40000002</PMID>
      <Article>
        <Abstract><AbstractText>T cells become exhausted in liver metastases.</AbstractText></Abstract>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>`

// ---------------------------------------------------------------------------
// 基础设施：响应、stub fetch、假时钟、临时 cacheDir
// ---------------------------------------------------------------------------

function jsonResponse(value) {
  return { ok: true, status: 200, async text() { return JSON.stringify(value) } }
}

function xmlResponse(value) {
  return { ok: true, status: 200, async text() { return value } }
}

const START = Date.parse('2026-01-05T00:00:00.000Z')

/** 虚拟时钟：sleep 只推进虚拟时间，不产生真实等待。 */
function fakeClock(start = START) {
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; return ms },
  }
  return clock
}

/**
 * stub fetch：按 URL 分派 esearch / esummary / efetch / europepmc，并记录每个请求与调用时刻。
 * 默认 europepmc 处理器缺失时直接抛错（模拟“被墙/超时”）。
 */
function makeFetchStub(handlers = {}) {
  const calls = []
  async function fetchImpl(url) {
    const href = String(url)
    const parsed = new URL(href)
    calls.push({ url: href, at: handlers.clock ? handlers.clock.t : null })
    if (parsed.host.endsWith('ebi.ac.uk')) {
      if (typeof handlers.europepmc === 'function') return handlers.europepmc(parsed, calls)
      throw new Error('Europe PMC 不可达（stub 默认失败）')
    }
    if (parsed.pathname.endsWith('/esearch.fcgi')) {
      const nth = calls.filter((call) => call.url.includes('esearch.fcgi')).length - 1
      const value = typeof handlers.esearch === 'function'
        ? handlers.esearch(parsed, nth)
        : (handlers.esearch || { count: '0', idlist: [] })
      return jsonResponse({ esearchresult: value })
    }
    if (parsed.pathname.endsWith('/esummary.fcgi')) {
      const records = typeof handlers.esummary === 'function'
        ? handlers.esummary(parsed)
        : (handlers.esummary || {})
      return jsonResponse({ result: { uids: Object.keys(records), ...records } })
    }
    if (parsed.pathname.endsWith('/efetch.fcgi')) {
      const xml = typeof handlers.efetch === 'function' ? handlers.efetch(parsed) : (handlers.efetch || '')
      return xmlResponse(xml)
    }
    throw new Error(`stub 收到未预期 URL：${href}`)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/** PubMed 正常两命中场景的默认处理器。 */
function pubmedHandlers(overrides = {}) {
  return {
    esearch: () => ({ count: '2', idlist: [...PMIDS], querytranslation: null }),
    esummary: () => ({ ...DOCSUMS }),
    efetch: () => ABSTRACT_XML,
    ...overrides,
  }
}

const tempDirs = []

/**
 * 建客户端：默认显式清空 apiKey/email，避免机器上的 NCBI_API_KEY 环境变量影响用例。
 */
function makeClient({ clock, fetchImpl, ...options } = {}) {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'dsh-pubmed-'))
  tempDirs.push(cacheDir)
  return createPubMedClient({
    fetchImpl,
    cacheDir,
    apiKey: null,
    email: null,
    ...(clock ? { now: clock.now, sleep: clock.sleep } : {}),
    ...options,
  })
}

function searchOnce({ handlers = pubmedHandlers(), clock = fakeClock(), options = {}, searchOptions = {} } = {}) {
  const stub = makeFetchStub({ ...handlers, clock })
  const client = makeClient({ clock, fetchImpl: stub, ...options })
  return { stub, client, clock, run: () => client.search({ term: TERM, limit: 5, ...searchOptions }) }
}

/** 断言相邻请求间隔：越过 burst 之后每个间隔 ≥ minGap（允许 20% 误差）。 */
function assertMinGaps(times, burst, minGap, label = '') {
  assert.ok(times.length > burst, `${label} 请求数 ${times.length} 不足以越过 burst ${burst}`)
  const gaps = times.slice(1).map((time, index) => time - times[index])
  const steady = gaps.slice(burst - 1)
  for (const gap of steady) {
    assert.ok(gap >= minGap * 0.8, `${label} 相邻请求间隔 ${gap}ms 低于阈值 ${(minGap * 0.8).toFixed(1)}ms`)
    assert.ok(gap <= minGap * 4, `${label} 相邻请求间隔 ${gap}ms 异常偏大`)
  }
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. 归一化
// ---------------------------------------------------------------------------

test('归一化：esearch + esummary + efetch → 记录字段齐全、类型正确、authors 截断为前 3 + et al', async () => {
  const { run, stub } = searchOnce({ searchOptions: { includeAbstracts: true } })
  const result = await run()

  assert.equal(stub.calls.length, 3, '应分别是 esearch / esummary / efetch 三个请求')
  assert.equal(result.items.length, 2)

  const [first, second] = result.items

  // --- 第一条：有 PMC 全文、4 个作者、带 HTML/实体的标题 ---
  assert.equal(first.source, 'pubmed')
  assert.equal(first.id, PMIDS[0])
  assert.equal(typeof first.pmid, 'string')
  assert.equal(first.pmid, PMIDS[0])
  assert.equal(typeof first.doi, 'string')
  assert.equal(first.doi, '10.1084/jem.20230001')
  assert.equal(typeof first.title, 'string')
  assert.equal(first.title, 'NK cells in gastric cancer & liver metastasis')
  assert.equal(first.journal, 'Journal of Experimental Medicine')
  assert.equal(typeof first.year, 'number')
  assert.equal(first.year, 2023)
  assert.ok(Array.isArray(first.authors))
  assert.deepEqual(first.authors, ['Alice A', 'Bob B', 'Carol C', 'et al'])
  assert.equal(typeof first.abstract, 'string')
  assert.equal(first.abstract, 'NK cells accumulate in liver metastases. They express IFNG & CXCR3.')
  assert.equal(first.pubtype, 'Journal Article')
  assert.deepEqual(first.pubtypes, ['Journal Article', 'Review'])
  assert.equal(first.openAccess, true)
  assert.equal(typeof first.openAccess, 'boolean')
  assert.equal(typeof first.fullTextUrl, 'string')
  assert.match(first.fullTextUrl, /^https:\/\/pmc\.ncbi\.nlm\.nih\.gov\/articles\/PMC1234567\/$/)
  assert.equal(first.url, `https://pubmed.ncbi.nlm.nih.gov/${PMIDS[0]}/`)
  assert.equal(first.evidence_kind, 'literature')

  // --- 第二条：2 个作者不截断、doi 从 articleids 回退、非开放获取 ---
  assert.equal(second.pmid, PMIDS[1])
  assert.deepEqual(second.authors, ['Eve E', 'Frank F'])
  assert.equal(second.year, 2019)
  assert.equal(second.doi, '10.1016/j.immuni.2019.01.001', 'elocationid 缺失时应从 articleids 取 doi')
  assert.equal(second.title, 'T cell exhaustion in liver metastases')
  assert.equal(second.abstract, 'T cells become exhausted in liver metastases.')
  assert.equal(second.openAccess, false)
  assert.equal(second.fullTextUrl, null)
  assert.equal(second.doi, '10.1016/j.immuni.2019.01.001')
})

test('归一化：normalizePubMedRecord 直接调用（3 个作者不截断、空记录字段为 null/[]）', () => {
  const three = normalizePubMedRecord({
    uid: 7,
    title: 'x',
    pubdate: '2020',
    authors: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    pubtype: ['Journal Article'],
  })
  assert.deepEqual(three.authors, ['A', 'B', 'C'])
  assert.equal(three.id, '7')
  assert.equal(three.pmid, '7')
  assert.equal(three.year, 2020)
  assert.equal(three.pubtype, 'Journal Article')
  assert.equal(three.openAccess, false)
  assert.equal(three.fullTextUrl, null)

  const empty = normalizePubMedRecord({ uid: '8', title: 'y' })
  assert.deepEqual(empty.authors, [])
  assert.equal(empty.year, null)
  assert.equal(empty.doi, null)
  assert.equal(empty.journal, null)
  assert.equal(empty.pubtype, null)
  assert.equal(empty.openAccess, false)
  assert.equal(empty.fullTextUrl, null)
})

// ---------------------------------------------------------------------------
// 2. 缓存命中
// ---------------------------------------------------------------------------

test('缓存：同一 query 第二次 cached:true，且不再发起 fetch', async () => {
  const { stub, client, run } = searchOnce()

  const first = await run()
  assert.ok(!first.cached, '首次请求不应标记缓存命中')
  assert.equal(stub.calls.length, 2, '首次应只有 esearch + esummary')
  const callsAfterFirst = stub.calls.length

  const second = await run()
  assert.equal(second.cached, true)
  assert.equal(second.provenance.cached, true)
  assert.equal(stub.calls.length, callsAfterFirst, '缓存命中不得新增 fetch')
  assert.deepEqual(second.items.map((item) => item.pmid), first.items.map((item) => item.pmid))

  // 缓存文件名 = sha256(query + params).json，且带 cached_at
  const files = readdirSync(client.cacheDir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^[0-9a-f]{64}\.json$/)
  const payload = JSON.parse(readFileSync(path.join(client.cacheDir, files[0]), 'utf8'))
  assert.ok(payload.cached_at, '缓存应记录 cached_at')
  assert.equal(payload.value.items.length, 2)
})

test('缓存：结构不完整的缓存文件按未命中处理（重新取，不抛错）', async () => {
  const clock = fakeClock()
  const stub = makeFetchStub({ ...pubmedHandlers(), clock })
  const client = makeClient({ clock, fetchImpl: stub })
  const key = client.cacheKey({ original: TERM, limit: 5, page: 0, sort: 'relevance', includeAbstracts: false })
  writeFileSync(path.join(client.cacheDir, `${key}.json`), JSON.stringify({ cached_at: new Date(clock.t - 1000).toISOString() }))

  const result = await client.search({ term: TERM, limit: 5 })
  assert.equal(result.items.length, 2)
  assert.ok(!result.cached, '坏缓存不应被当成命中')
  assert.equal(stub.calls.length, 2, '坏缓存不应阻止重新请求')
})

// ---------------------------------------------------------------------------
// 3. TTL
// ---------------------------------------------------------------------------

test('TTL：7 天内命中、8 天后过期重新取（fetch +2）', async () => {
  assert.equal(DEFAULT_CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000)
  const clock = fakeClock()
  const stub = makeFetchStub({ ...pubmedHandlers(), clock })
  const client = makeClient({ clock, fetchImpl: stub })

  const first = await client.search({ term: TERM, limit: 5 })
  assert.ok(!first.cached)
  const callsAfterFirst = stub.calls.length
  assert.equal(callsAfterFirst, 2)

  clock.t += 6 * 24 * 60 * 60 * 1000 // 6 天：仍命中
  const fresh = await client.search({ term: TERM, limit: 5 })
  assert.equal(fresh.cached, true)
  assert.equal(stub.calls.length, callsAfterFirst)

  clock.t += 2 * 24 * 60 * 60 * 1000 // 累计 8 天：过期
  const expired = await client.search({ term: TERM, limit: 5 })
  assert.ok(!expired.cached, '过期缓存不能算命中')
  assert.equal(stub.calls.length, callsAfterFirst + 2, '过期后应重新 esearch + esummary')
})

// ---------------------------------------------------------------------------
// 4. 限速（注入假时钟，不真的 sleep）
// ---------------------------------------------------------------------------

test('限速：无 api key 时连续请求间隔 ≥ 1/3 s（±20%）', async () => {
  const clock = fakeClock()
  const stub = makeFetchStub({ clock, esearch: () => ({ count: '0', idlist: [] }) })
  const client = makeClient({ clock, fetchImpl: stub })

  for (let index = 0; index < 9; index += 1) {
    await client.esearch({ term: 'nk cell' })
  }
  const times = stub.calls.map((call) => call.at)
  assert.equal(times.length, 9)
  assertMinGaps(times, Math.ceil(3), 1000 / 3, '无 key')
  // 整体：越过 burst 的 6 次请求至少花掉 6 * 1/3 s
  assert.ok(times[times.length - 1] - times[0] >= 6 * (1000 / 3) * 0.8)
})

test('限速：有 api key 时阈值放宽到 1/10 s', async () => {
  const clock = fakeClock()
  const stub = makeFetchStub({ clock, esearch: () => ({ count: '0', idlist: [] }) })
  const client = makeClient({ clock, fetchImpl: stub, apiKey: 'TEST-KEY' })
  assert.equal(client.maxPerSec, 10, '带 key 的默认速率应为 10 req/s')

  for (let index = 0; index < 14; index += 1) {
    await client.esearch({ term: 'nk cell' })
  }
  const times = stub.calls.map((call) => call.at)
  assert.equal(times.length, 14)
  assertMinGaps(times, 10, 1000 / 10, '有 key')
})

test('限速：maxPerSec 不得越过 NCBI 上限（无 key 3 / 有 key 10）', async () => {
  const clock = fakeClock()

  const noKeyStub = makeFetchStub({ clock, esearch: () => ({ count: '0', idlist: [] }) })
  const noKey = makeClient({ clock, fetchImpl: noKeyStub, maxPerSec: 50 })
  assert.equal(noKey.maxPerSec, 3, '无 key 时配置再高也不能超过 3 req/s')
  for (let index = 0; index < 5; index += 1) await noKey.esearch({ term: 'nk cell' })
  assertMinGaps(noKeyStub.calls.map((call) => call.at), 3, 1000 / 3, '无 key 上限')

  const keyedStub = makeFetchStub({ clock, esearch: () => ({ count: '0', idlist: [] }) })
  const keyed = makeClient({ clock, fetchImpl: keyedStub, apiKey: 'TEST-KEY', maxPerSec: 50 })
  assert.equal(keyed.maxPerSec, 10, '有 key 时配置再高也不能超过 10 req/s')
  for (let index = 0; index < 12; index += 1) await keyed.esearch({ term: 'nk cell' })
  assertMinGaps(keyedStub.calls.map((call) => call.at), 10, 1000 / 10, '有 key 上限')
})

// ---------------------------------------------------------------------------
// 5. provenance
// ---------------------------------------------------------------------------

test('provenance：query / effective_query / at / library / total / retrieved / page / relaxed', async () => {
  const clock = fakeClock()
  const translation = 'gastric cancer[Title/Abstract] AND liver metastasis[Title/Abstract]'
  const stub = makeFetchStub({
    clock,
    esearch: () => ({ count: '37', idlist: [...PMIDS], querytranslation: translation }),
    esummary: () => ({ ...DOCSUMS }),
  })
  const client = makeClient({ clock, fetchImpl: stub })

  const result = await client.search({ term: TERM, limit: 5, page: 1 })
  const prov = result.provenance

  assert.equal(prov.query, TERM)
  assert.equal(prov.effective_query, translation)
  assert.equal(prov.library, 'pubmed')
  assert.equal(prov.total, 37)
  assert.equal(prov.retrieved, 2)
  assert.equal(prov.page, 1)
  assert.equal(prov.page_size, 5)
  assert.equal(prov.relaxed, false)
  assert.equal(prov.cached, false)
  assert.equal(prov.via, 'builtin')
  assert.equal(typeof prov.at, 'string')
  assert.ok(Number.isFinite(Date.parse(prov.at)), 'at 应为可解析的时间')
  assert.equal(typeof prov.elapsed_ms, 'number')
  assert.ok(prov.elapsed_ms >= 0)
  assert.ok(prov.url.startsWith(NCBI_BASE), 'provenance.url 应记录实际请求 URL')

  // 结果顶层与旧字段名（sources.mjs 在用）保持兼容
  assert.equal(result.via, 'builtin')
  assert.equal(result.total, 37)
  assert.equal(result.fetched, 2)
  assert.equal(prov.original_query, TERM)
  assert.equal(prov.actual_query, translation)
  assert.equal(prov.db, 'pubmed')
  assert.equal(prov.fetched, 2)

  // 分页参数确实进了 esearch
  const esearchCall = stub.calls.find((call) => call.url.includes('esearch.fcgi'))
  const url = new URL(esearchCall.url)
  assert.equal(url.searchParams.get('db'), 'pubmed')
  assert.equal(url.searchParams.get('tool'), TOOL_NAME)
  assert.equal(url.searchParams.get('retmax'), '5')
  assert.equal(url.searchParams.get('retstart'), '5')
  assert.equal(url.searchParams.get('retmode'), 'json')
})

// ---------------------------------------------------------------------------
// 6. 零命中放宽
// ---------------------------------------------------------------------------

test('零命中放宽：relaxed=true，effective_query 是放宽后的实际 query', async () => {
  assert.equal(relaxQuery(TERM), EXPECTED_RELAXED)
  const clock = fakeClock()
  const stub = makeFetchStub({
    clock,
    esearch: (parsed, nth) => (nth === 0
      ? { count: '0', idlist: [], querytranslation: 'zero-hit translation' }
      : { count: '2', idlist: [...PMIDS], querytranslation: null }),
    esummary: () => ({ ...DOCSUMS }),
  })
  const client = makeClient({ clock, fetchImpl: stub })

  const result = await client.search({ term: TERM, limit: 5 })
  assert.equal(result.provenance.relaxed, true)
  assert.equal(result.provenance.query, TERM)
  assert.notEqual(result.provenance.effective_query, TERM)
  assert.equal(result.provenance.effective_query, EXPECTED_RELAXED, '放宽后应报告实际执行(querytranslation of retry)，而不是首次零命中的翻译')
  assert.equal(result.provenance.total, 2)
  assert.equal(result.provenance.retrieved, 2)
  assert.equal(result.items.length, 2)

  const esearchCalls = stub.calls.filter((call) => call.url.includes('esearch.fcgi'))
  assert.equal(esearchCalls.length, 2)
  assert.equal(new URL(esearchCalls[1].url).searchParams.get('term'), EXPECTED_RELAXED)
})

// ---------------------------------------------------------------------------
// 7. Europe PMC 默认关闭
// ---------------------------------------------------------------------------

test('Europe PMC：默认不请求（无 ebi.ac.uk），显式 sources 含 europepmc 才请求且失败不影响整体', async () => {
  const clock = fakeClock()

  // 默认：既不走 searchAll 也不走单个 search
  const defaultStub = makeFetchStub({ ...pubmedHandlers(), clock })
  const defaultClient = makeClient({ clock, fetchImpl: defaultStub })
  const byDefault = await defaultClient.searchAll({ term: TERM, limit: 5 })
  assert.ok(defaultStub.calls.length > 0)
  assert.ok(defaultStub.calls.every((call) => !/ebi\.ac\.uk/.test(call.url)), '默认绝不请求 Europe PMC')
  assert.deepEqual(byDefault.sources_ok, ['pubmed'])
  assert.equal(byDefault.items.length, 2)

  const singleStub = makeFetchStub({ ...pubmedHandlers(), clock })
  const singleClient = makeClient({ clock, fetchImpl: singleStub })
  await singleClient.search({ term: TERM, limit: 5 })
  assert.ok(singleStub.calls.every((call) => !/ebi\.ac\.uk/.test(call.url)))

  // 显式 sources 含 europepmc：请求了，但失败只记 warning
  const failedStub = makeFetchStub({
    ...pubmedHandlers(),
    clock,
    europepmc: () => { throw new Error('connect timeout（stub）') },
  })
  const failedClient = makeClient({ clock, fetchImpl: failedStub })
  const withEpmc = await failedClient.searchAll({ term: TERM, limit: 5, sources: ['pubmed', 'europepmc'] })
  assert.ok(failedStub.calls.some((call) => /ebi\.ac\.uk/.test(call.url)), '显式开启后应请求 Europe PMC')
  assert.ok(withEpmc.sources_ok.includes('pubmed'))
  const failed = withEpmc.sources_failed.find((entry) => entry.source === 'europepmc')
  assert.ok(failed, 'Europe PMC 失败应出现在 sources_failed')
  assert.equal(failed.code, 'network')
  assert.equal(withEpmc.items.length, 2, 'Europe PMC 失败不得影响 PubMed 结果')
  assert.ok(withEpmc.warnings.some((warning) => /Europe PMC/.test(warning)))
  assert.equal(withEpmc.europepmc.total, 0)

  // 显式开启且成功：结果合并
  const okStub = makeFetchStub({
    ...pubmedHandlers(),
    clock,
    europepmc: () => jsonResponse({
      hitCount: 12,
      resultList: {
        result: [{
          id: '99900001', source: 'MED', pmid: '99900001', title: 'Europe PMC paper',
          authorString: 'A, B, C, D', journalTitle: 'Lancet', pubYear: '2022',
          doi: '10.9999/epmc.1', abstractText: 'from europepmc',
        }],
      },
    }),
  })
  const okClient = makeClient({ clock, fetchImpl: okStub })
  const combined = await okClient.searchAll({ term: TERM, limit: 5, europepmc: true })
  assert.ok(combined.sources_ok.includes('europepmc'))
  assert.equal(combined.items.length, 3)
  assert.ok(combined.items.some((item) => item.source === 'europepmc'))
  assert.ok(combined.provenance.some((entry) => entry.library === 'europepmc'))

  // Europe PMC 缓存：两次同参调用只请求一次；命中时 cached 与 provenance.cached 同步为 true
  const callsAfterCombined = okStub.calls.length
  const epmcCached = await okClient.searchEuropePmc({ term: TERM, limit: 5 })
  assert.equal(epmcCached.cached, true)
  assert.equal(epmcCached.provenance.cached, true, '缓存命中时 provenance.cached 也要标 true')
  const epmcCachedNumberish = await okClient.searchEuropePmc({ term: TERM, limit: '5', page: '0' })
  assert.equal(epmcCachedNumberish.cached, true, 'limit/page 的字符串形式应命中同一缓存键')
  assert.equal(okStub.calls.length, callsAfterCombined, 'Europe PMC 缓存命中不得新增 fetch')
})

// ---------------------------------------------------------------------------
// 8. via
// ---------------------------------------------------------------------------

test('via：NCBI 直连结果注明 builtin', async () => {
  const { run } = searchOnce()
  const result = await run()
  assert.equal(result.via, 'builtin')
  assert.equal(result.provenance.via, 'builtin')
  assert.ok(result.items.every((item) => item.via === 'builtin'))
})

// ---------------------------------------------------------------------------
// 9. NCBI 请求参数与 API key 脱敏
// ---------------------------------------------------------------------------

test('NCBI 参数：tool=dsh-bioflow、可选 email / api_key，provenance.url 里 key 打码', async () => {
  const clock = fakeClock()
  const stub = makeFetchStub({ ...pubmedHandlers(), clock })
  const client = makeClient({ clock, fetchImpl: stub, apiKey: 'SECRET-KEY', email: 'someone@example.org' })

  const result = await client.search({ term: TERM, limit: 2, includeAbstracts: true })
  assert.equal(stub.calls.length, 3)
  for (const call of stub.calls) {
    const url = new URL(call.url)
    assert.equal(url.searchParams.get('tool'), TOOL_NAME)
    assert.equal(url.searchParams.get('api_key'), 'SECRET-KEY')
    assert.equal(url.searchParams.get('email'), 'someone@example.org')
  }
  assert.ok(!result.provenance.url.includes('SECRET-KEY'), 'provenance 里不能出现明文 api key')
  assert.ok(result.provenance.url.includes('api_key=***'))

  // 未配置时不得出现这两个参数
  const plainStub = makeFetchStub({ ...pubmedHandlers(), clock })
  const plain = makeClient({ clock, fetchImpl: plainStub })
  await plain.search({ term: TERM, limit: 2 })
  for (const call of plainStub.calls) {
    const url = new URL(call.url)
    assert.equal(url.searchParams.get('api_key'), null)
    assert.equal(url.searchParams.get('email'), null)
  }
})
