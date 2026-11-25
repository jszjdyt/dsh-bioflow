/**
 * dsh-bioflow — PubMed / Europe PMC 客户端
 *
 * 已勘察事实：NCBI E-utilities 本机可达；Europe PMC 8s 超时（很可能被墙）→ 默认关闭，
 * 仅显式 sources 里带 europepmc 才请求，失败只记 warning，不影响整体 search。
 *
 * 要求：
 *   - esearch / esummary / efetch；tool=dsh-bioflow；可选 email / NCBI_API_KEY；
 *   - 无 key ≤3 req/s 令牌桶（复用 download.mjs 的 TokenBucket）；
 *   - 缓存 ~/.dsh/bioflow/cache/pubmed/<sha256>.json，TTL 7 天，命中标 cached:true；
 *   - provenance：原 query / 实际 query / 时间 / 库 / 命中数 / 取回数 / 分页 / 是否放宽；
 *   - 宿主若有 pubmed 工具则优先转发（标 via:builtin|dsh-pubmed）。
 *
 * fetch 可注入：单测用 stub，绝不联网；真实请求只在 BIOFLOW_LIVE=1 的测试里跑。
 */

import { atomicWriteJson, ensureDir, nowIso, readJsonIfExists, sha256Json, stableStringify } from './store.mjs'
import { TokenBucket, anySignal } from './download.mjs'

export const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const NCBI_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
export const EUROPEPMC_BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest'
export const TOOL_NAME = 'dsh-bioflow'
/** NCBI 速率硬上限：无 key 3 req/s，有 key 10 req/s（任何配置都不得越过）。 */
export const NCBI_RATE_LIMITS = { withoutKey: 3, withKey: 10 }
/** 归一化记录里作者最多保留前 N 位，超出的用 et al 收尾。 */
export const AUTHOR_PREVIEW_LIMIT = 3

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'with', 'by', 'from',
  '的', '和', '与', '在', '对', '把', '用', '中', '了', '是', '按', '比较'])

function httpError(code, message, details = {}) {
  const error = Object.assign(new Error(message), { code })
  error.details = details
  return error
}

function stripTags(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)) } catch { return '' }
    })
    .replace(/&#(\d+);/g, (_, code) => {
      try { return String.fromCodePoint(Number(code)) } catch { return '' }
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function xmlAll(xml, tag) {
  const out = []
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')
  let match
  while ((match = pattern.exec(xml)) !== null) out.push(match[1])
  return out
}

function xmlOne(xml, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  return match ? match[1] : null
}

/** 确定性放宽：去掉引号短语 + 去停用词后取前 5 个词 OR。只用于零命中时，provenance 会标明。 */
export function relaxQuery(term) {
  const text = String(term || '')
  const withoutQuotes = text.replace(/"[^"]*"/g, (phrase) => phrase.replace(/"/g, ''))
  const tokens = withoutQuotes
    .split(/[\s,，;；、]+/)
    .map((token) => token.replace(/[^\w\u4e00-\u9fa5-]/g, ''))
    .filter((token) => token && !STOPWORDS.has(token.toLowerCase()))
  const unique = [...new Set(tokens)].slice(0, 6)
  if (!unique.length) return null
  return unique.join(' OR ')
}

export function normalizePubMedRecord(summary = {}, extra = {}) {
  const record = summary && typeof summary === 'object' ? summary : {}
  const names = Array.isArray(record.authors)
    ? record.authors
      .map((author) => (author && typeof author === 'object' ? asText(author.name || author.fullname) : asText(author)))
      .filter(Boolean)
    : []
  const authors = names.length > AUTHOR_PREVIEW_LIMIT
    ? [...names.slice(0, AUTHOR_PREVIEW_LIMIT), 'et al']
    : names
  const pubdate = String(record.pubdate || record.pubDate || '')
  const yearMatch = pubdate.match(/\b(1[89]\d\d|20\d\d)\b/)
  const elocation = asText(record.elocationid)
  const elocationDoi = elocation && /^doi:/i.test(elocation) ? elocation.replace(/^doi:\s*/i, '') || null : null
  const doi = elocationDoi || articleIdOf(record, 'doi') || asText(record.doi)
  // 开放获取判据：esummary.articleids 里有 PMC 号 = PMC 有免费全文；更强的 OA 判定需要额外服务，这里不做。
  const pmcId = asText(extra.pmcId) || articleIdOf(record, 'pmc') || asText(record.pmcid)
  const pubtypes = Array.isArray(record.pubtype)
    ? record.pubtype.map((type) => asText(type)).filter(Boolean)
    : (asText(record.pubtype) ? [asText(record.pubtype)] : [])
  const uid = asText(record.uid || record.pmid || extra.pmid)
  return {
    source: 'pubmed',
    id: uid || '',
    title: stripTags(record.title),
    abstract: extra.abstract ? stripTags(extra.abstract) : null,
    authors,
    journal: asText(record.fulljournalname) || asText(record.source),
    year: yearMatch ? Number(yearMatch[1]) : null,
    doi: doi || null,
    pmid: uid || null,
    pubtype: pubtypes[0] || null,
    pubtypes,
    openAccess: Boolean(pmcId),
    fullTextUrl: pmcId ? `https://pmc.ncbi.nlm.nih.gov/articles/${normalizePmcId(pmcId)}/` : null,
    url: uid ? `https://pubmed.ncbi.nlm.nih.gov/${uid}/` : null,
    species: null,
    n_samples: null,
    platform: null,
    scale: null,
    attachments: [],
    clinical_available: null,
    evidence_kind: 'literature',
    evidence_strength: 'metadata',
    ...extra.overrides,
  }
}

function asText(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

/** 从 esummary.articleids（形如 [{idtype:"pmc", value:"PMC123"}]）里取指定类型的 id。 */
function articleIdOf(record, type) {
  const list = Array.isArray(record && record.articleids) ? record.articleids : []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    if (String(entry.idtype || entry.IdType || '').toLowerCase() !== type) continue
    const value = asText(entry.value || entry.Value)
    if (value) return value
  }
  return null
}

function normalizePmcId(pmcId) {
  const text = String(pmcId).trim()
  return /^PMC/i.test(text) ? text.toUpperCase() : `PMC${text}`
}

function normalizeEuropePmcRecord(result) {
  return {
    source: 'europepmc',
    id: String(result.id || result.pmid || ''),
    title: stripTags(result.title),
    abstract: result.abstractText ? stripTags(result.abstractText) : null,
    authors: String(result.authorString || '').split(',').map((name) => name.trim()).filter(Boolean).slice(0, 20),
    journal: result.journalTitle || null,
    year: Number(result.pubYear) || null,
    doi: result.doi || null,
    pmid: result.pmid || null,
    url: result.id ? `https://europepmc.org/article/${result.source || 'MED'}/${result.id}` : null,
    species: null,
    n_samples: null,
    platform: null,
    scale: null,
    attachments: [],
    clinical_available: null,
    evidence_kind: 'literature',
    evidence_strength: 'metadata',
  }
}

/**
 * 统一 provenance：任务书要求的字段名（query / effective_query / at / library / total / retrieved /
 * page / relaxed）放前面，同时保留 sources.mjs / UI 已在用的旧字段名（original_query / actual_query /
 * db / fetched / page_size），两边取值一致。
 */
function buildProvenance({
  library = 'pubmed',
  query,
  effectiveQuery = query,
  total = 0,
  retrieved = 0,
  page = 0,
  pageSize = 20,
  relaxed = false,
  via = 'builtin',
  cached = false,
  url = null,
  elapsedMs = 0,
} = {}) {
  return {
    library,
    query,
    effective_query: effectiveQuery,
    at: nowIso(),
    total,
    retrieved,
    page,
    page_size: pageSize,
    relaxed,
    via,
    cached,
    url,
    elapsed_ms: elapsedMs,
    // 兼容旧字段名
    source: library,
    db: library,
    original_query: query,
    actual_query: effectiveQuery,
    fetched: retrieved,
  }
}

export class PubMedClient {
  constructor({
    fetchImpl = null,
    cacheDir = null,
    ttlMs = DEFAULT_CACHE_TTL_MS,
    maxPerSec = 3,
    apiKey = process.env.NCBI_API_KEY || null,
    email = process.env.NCBI_EMAIL || null,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = 20_000,
    europePmcTimeoutMs = 8_000,
    baseUrl = NCBI_BASE,
    europePmcBaseUrl = EUROPEPMC_BASE,
    log = null,
    forwarder = null,
  } = {}) {
    this.fetch = fetchImpl || globalThis.fetch
    if (typeof this.fetch !== 'function') throw httpError('unsupported', '当前运行时没有 fetch，无法访问 PubMed')
    this.cacheDir = cacheDir
    if (cacheDir) ensureDir(cacheDir)
    this.ttlMs = ttlMs
    // NCBI 硬上限：无 key 3 req/s、有 key 10 req/s；配置只能更慢，不能越线。
    const requestedPerSec = Number(maxPerSec) > 0 ? Number(maxPerSec) : NCBI_RATE_LIMITS.withoutKey
    this.maxPerSec = apiKey
      ? NCBI_RATE_LIMITS.withKey
      : Math.min(NCBI_RATE_LIMITS.withoutKey, requestedPerSec)
    this.apiKey = apiKey
    this.email = email
    this.now = now
    this.sleep = sleep
    this.timeoutMs = timeoutMs
    this.europePmcTimeoutMs = europePmcTimeoutMs
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.europePmcBaseUrl = europePmcBaseUrl.replace(/\/$/, '')
    this.log = typeof log === 'function' ? log : () => {}
    this.forwarder = typeof forwarder === 'function' ? forwarder : null
    this.bucket = new TokenBucket({ ratePerSec: this.maxPerSec, burst: Math.max(1, Math.ceil(this.maxPerSec)), now, sleep })
    this.requests = 0
  }

  cacheKey(request) {
    return sha256Json({ db: 'pubmed-client', version: 1, ...request })
  }

  readCache(key) {
    if (!this.cacheDir) return null
    const file = `${this.cacheDir}/${key}.json`
    const payload = readJsonIfExists(file)
    // 结构不完整（缺 cached_at / value）的文件按未命中处理，不能让它把检索打崩。
    if (!payload || !payload.cached_at || !payload.value) return null
    const age = this.now() - Date.parse(payload.cached_at)
    if (!Number.isFinite(age) || age > this.ttlMs) return null
    return payload
  }

  writeCache(key, payload) {
    if (!this.cacheDir) return
    atomicWriteJson(`${this.cacheDir}/${key}.json`, { cached_at: new Date(this.now()).toISOString(), ...payload })
  }

  buildUrl(pathname, params) {
    const url = new URL(`${this.baseUrl}/${pathname}`)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    url.searchParams.set('tool', TOOL_NAME)
    if (this.email) url.searchParams.set('email', String(this.email))
    if (this.apiKey) url.searchParams.set('api_key', String(this.apiKey))
    return url.toString()
  }

  async request(url, { timeoutMs = null, signal = null } = {}) {
    await this.bucket.acquire()
    this.requests += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs)
    const merged = signal ? anySignal([signal, controller.signal]) : controller.signal
    try {
      const response = await this.fetch(url, { signal: merged, headers: { accept: 'application/json, text/xml, text/plain' } })
      const text = await response.text()
      if (!response.ok) {
        throw httpError('http_error', `PubMed HTTP ${response.status}`, { url: url.replace(/api_key=[^&]+/, 'api_key=***'), status: response.status, body: text.slice(0, 300) })
      }
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  async esearch({ term, retmax = 20, retstart = 0, sort = 'relevance', mindate = null, maxdate = null, signal = null, timeoutMs = null }) {
    const url = this.buildUrl('esearch.fcgi', {
      db: 'pubmed', term, retmax, retstart, retmode: 'json', sort,
      mindate: mindate || undefined, maxdate: maxdate || undefined,
      datetype: mindate || maxdate ? 'pdat' : undefined,
    })
    const text = await this.request(url, { signal, timeoutMs })
    let payload
    try { payload = JSON.parse(text) } catch (error) {
      throw httpError('bad_response', `PubMed esearch 返回非 JSON：${text.slice(0, 160)}`, { url })
    }
    const result = (payload && payload.esearchresult) || {}
    return {
      count: Number(result.count || 0),
      ids: Array.isArray(result.idlist) ? result.idlist.map(String) : [],
      querytranslation: result.querytranslation || null,
      querykey: result.querykey || null,
      url,
    }
  }

  async esummary(ids, { signal = null } = {}) {
    if (!ids.length) return new Map()
    const url = this.buildUrl('esummary.fcgi', { db: 'pubmed', id: ids.join(','), retmode: 'json' })
    const text = await this.request(url, { signal })
    const payload = JSON.parse(text)
    const result = payload.result || {}
    const map = new Map()
    for (const uid of result.uids || ids) {
      const record = result[uid]
      if (record) map.set(String(uid), record)
    }
    return map
  }

  async efetchAbstracts(ids, { signal = null } = {}) {
    if (!ids.length) return new Map()
    const url = this.buildUrl('efetch.fcgi', { db: 'pubmed', id: ids.join(','), retmode: 'xml', rettype: 'abstract' })
    const xml = await this.request(url, { signal })
    const map = new Map()
    const articles = xmlAll(xml, 'PubmedArticle')
    for (const article of articles) {
      const pmid = stripTags(xmlOne(article, 'PMID') || '')
      if (!pmid) continue
      const abstractParts = xmlAll(article, 'AbstractText').map((part) => stripTags(part)).filter(Boolean)
      map.set(pmid, abstractParts.join(' '))
    }
    return map
  }

  /**
   * 主入口：PubMed 检索（带缓存 / 限速 / provenance / 零命中放宽）。
   */
  async search({ term, limit = 20, page = 0, sort = 'relevance', includeAbstracts = false, signal = null } = {}) {
    if (!term || !String(term).trim()) throw httpError('bad_request', 'PubMed 检索需要 term')
    const original = String(term).trim()
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20))
    const safePage = Math.max(0, Number(page) || 0)
    const key = this.cacheKey({ original, limit: safeLimit, page: safePage, sort, includeAbstracts })
    const cached = this.readCache(key)
    if (cached) {
      return {
        ...cached.value,
        cached: true,
        provenance: { ...cached.value.provenance, cached: true, at: cached.value.provenance.at },
      }
    }
    if (this.forwarder) {
      try {
        const forwarded = await this.forwarder({ term: original, limit: safeLimit, page: safePage, sort, includeAbstracts })
        if (forwarded && Array.isArray(forwarded.items)) {
          const forwardedTotal = Number(forwarded.total || forwarded.items.length)
          const forwardedVia = forwarded.via || 'builtin'
          const value = {
            source: 'pubmed',
            total: forwardedTotal,
            fetched: forwarded.items.length,
            page: safePage,
            items: forwarded.items,
            via: forwardedVia,
            warnings: forwarded.warnings || [],
            provenance: buildProvenance({
              query: original,
              effectiveQuery: forwarded.actual_query || original,
              total: forwardedTotal,
              retrieved: forwarded.items.length,
              page: safePage,
              pageSize: safeLimit,
              relaxed: Boolean(forwarded.relaxed),
              via: forwardedVia,
              url: null,
              elapsedMs: 0,
            }),
          }
          this.writeCache(key, { value })
          return value
        }
      } catch (error) {
        this.log('pubmed', `宿主 pubmed 工具转发失败，回退 HTTP：${error && error.message}`)
      }
    }

    const started = this.now()
    const retstart = safePage * safeLimit
    const searchResult = await this.esearch({ term: original, retmax: safeLimit, retstart, sort, signal })
    // effective query 以“实际执行成功的那次检索”为准：放宽后会改成放宽 query 的 translation。
    let effectiveQuery = searchResult.querytranslation || original
    let relaxed = false
    let ids = searchResult.ids
    let total = searchResult.count
    if (!ids.length && total === 0) {
      const relaxedQuery = relaxQuery(original)
      if (relaxedQuery && relaxedQuery !== original) {
        const retry = await this.esearch({ term: relaxedQuery, retmax: safeLimit, retstart, sort, signal })
        if (retry.ids.length) {
          ids = retry.ids
          total = retry.count
          effectiveQuery = retry.querytranslation || relaxedQuery
          relaxed = true
        }
      }
    }
    const summaries = await this.esummary(ids, { signal })
    let abstracts = new Map()
    if (includeAbstracts && ids.length) {
      try {
        abstracts = await this.efetchAbstracts(ids, { signal })
      } catch (error) {
        this.log('pubmed', `efetch 摘要失败（只返回元数据）：${error && error.message}`)
      }
    }
    const items = ids.map((id) => {
      const summary = summaries.get(String(id)) || { uid: id, title: '' }
      return normalizePubMedRecord(summary, { abstract: abstracts.get(String(id)), overrides: { via: 'builtin' } })
    })
    const elapsedMs = this.now() - started
    const via = 'builtin'
    const value = {
      source: 'pubmed',
      total,
      fetched: items.length,
      page: safePage,
      items,
      via,
      warnings: [],
      provenance: buildProvenance({
        query: original,
        effectiveQuery,
        total,
        retrieved: items.length,
        page: safePage,
        pageSize: safeLimit,
        relaxed,
        via,
        url: searchResult.url.replace(/api_key=[^&]+/, 'api_key=***'),
        elapsedMs,
      }),
    }
    this.writeCache(key, { value })
    return value
  }

  /** Europe PMC（默认关闭；失败只返回 warning，不抛）。 */
  async searchEuropePmc({ term, limit = 20, page = 0, signal = null } = {}) {
    const original = String(term || '').trim()
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20))
    const safePage = Math.max(0, Number(page) || 0)
    const key = this.cacheKey({ europepmc: original, limit: safeLimit, page: safePage })
    const cached = this.readCache(key)
    if (cached) {
      return { ...cached.value, cached: true, provenance: { ...cached.value.provenance, cached: true } }
    }
    const url = new URL(`${this.europePmcBaseUrl}/search`)
    url.searchParams.set('query', original)
    url.searchParams.set('format', 'json')
    url.searchParams.set('pageSize', String(safeLimit))
    url.searchParams.set('page', String(safePage + 1))
    url.searchParams.set('resultType', 'core')
    const started = this.now()
    try {
      const text = await this.request(url.toString(), { timeoutMs: this.europePmcTimeoutMs, signal })
      const payload = JSON.parse(text)
      const results = (payload.resultList && payload.resultList.result) || []
      const items = results.map(normalizeEuropePmcRecord)
      const total = Number(payload.hitCount || items.length)
      const value = {
        source: 'europepmc',
        total,
        fetched: items.length,
        page: safePage,
        items,
        via: 'europepmc-rest',
        warnings: [],
        provenance: buildProvenance({
          library: 'europepmc',
          query: original,
          effectiveQuery: original,
          total,
          retrieved: items.length,
          page: safePage,
          pageSize: safeLimit,
          via: 'europepmc-rest',
          url: url.toString(),
          elapsedMs: this.now() - started,
        }),
      }
      this.writeCache(key, { value })
      return value
    } catch (error) {
      return {
        source: 'europepmc',
        total: 0,
        fetched: 0,
        page: safePage,
        items: [],
        via: 'europepmc-rest',
        warnings: [`Europe PMC 不可用（${error && error.name === 'AbortError' ? '超时' : (error && error.message) || '网络错误'}）`],
        error: { code: error && error.name === 'AbortError' ? 'timeout' : 'network', message: String(error && error.message ? error.message : error) },
        provenance: buildProvenance({
          library: 'europepmc',
          query: original,
          total: 0,
          retrieved: 0,
          page: safePage,
          pageSize: safeLimit,
          via: 'europepmc-rest',
          url: url.toString(),
          elapsedMs: this.now() - started,
        }),
      }
    }
  }

  /**
   * 组合检索：pubmed + 可选 europepmc；两个源独立失败。
   * 只有显式 `sources` 里含 'europepmc'（或 europepmc:true）才会请求 Europe PMC；默认绝不请求。
   */
  async searchAll({ term, limit = 20, page = 0, includeAbstracts = false, europepmc = false, sources = null, signal = null } = {}) {
    const wanted = Array.isArray(sources) && sources.length
      ? [...new Set(sources.map((source) => String(source).toLowerCase()))]
      : null
    const wantPubMed = wanted ? wanted.includes('pubmed') : true
    const wantEuropePmc = wanted ? wanted.includes('europepmc') : europepmc === true
    const output = { items: [], sources_ok: [], sources_failed: [], warnings: [], provenance: [] }
    if (wantPubMed) {
      try {
        const pubmed = await this.search({ term, limit, page, includeAbstracts, signal })
        output.items.push(...pubmed.items)
        output.sources_ok.push('pubmed')
        output.provenance.push(pubmed.provenance)
        output.warnings.push(...(pubmed.warnings || []))
        output.pubmed = { total: pubmed.total, fetched: pubmed.fetched, via: pubmed.via, cached: Boolean(pubmed.cached) }
      } catch (error) {
        output.sources_failed.push({ source: 'pubmed', code: error.code || 'network', reason: String(error.message || error) })
        output.pubmed = { total: 0, fetched: 0, error: String(error.message || error) }
      }
    }
    if (wantEuropePmc) {
      const epmc = await this.searchEuropePmc({ term, limit, page, signal })
      output.items.push(...epmc.items)
      if (epmc.error) output.sources_failed.push({ source: 'europepmc', code: epmc.error.code, reason: epmc.error.message })
      else output.sources_ok.push('europepmc')
      output.provenance.push(epmc.provenance)
      output.warnings.push(...(epmc.warnings || []))
      output.europepmc = { total: epmc.total, fetched: epmc.fetched }
    }
    return output
  }
}

export function createPubMedClient(opts = {}) {
  return new PubMedClient(opts)
}
