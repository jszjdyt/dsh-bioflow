/**
 * dsh-bioflow — 持久化层（run / step / attempt / artifact / dataset / plan / search）
 *
 * 设计要点（任务单 §7「跨插件修复排在接口实现前半程」）：
 *   - 主实现 node:sqlite（Node 22+ 内置，本机 v26 可用）；不可用时自动降级到
 *     JSON 快照 + append-only journal（同一套接口，两条都测）。
 *   - 状态机显式：pending_review → queued → running → succeeded|partial|failed|cancelled。
 *     非法迁移抛 bad_transition；终态不可再变。
 *   - 幂等：idempotency_key 唯一；同 key 直接返回已有 run，不重复执行。
 *   - 取消零写入：所有产物先写 .staging；提交前 assertWritable()，取消后拒绝提交，
 *     并把 staging 删除。run 目录不会出现 results/figures/manifest。
 *   - 内容寻址：artifact_id = sha256(bytes)，manifest/export 都用它校验。
 *
 * 本文件只依赖 node 内置模块，可被 test/*.test.mjs 直接 import。
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1
export const RUN_ID_PREFIX = 'run'
export const RUN_STATUSES = ['pending_review', 'queued', 'running', 'partial', 'succeeded', 'failed', 'cancelled']
export const TERMINAL_STATUSES = ['succeeded', 'partial', 'failed', 'cancelled']

/** 允许的状态迁移。终态出边为空 = 不可再改。 */
export const TRANSITIONS = {
  pending_review: ['queued', 'cancelled'],
  queued: ['running', 'cancelled', 'failed'],
  running: ['succeeded', 'partial', 'failed', 'cancelled'],
  succeeded: [],
  partial: [],
  failed: [],
  cancelled: [],
}

export function canTransition(from, to) {
  const allowed = TRANSITIONS[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

export function nowIso() {
  return new Date().toISOString()
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

export function sha256Json(value) {
  return sha256(stableStringify(value))
}

/** 递归排序 key 的稳定序列化；undefined 一律省略，NaN/Infinity 转 null。 */
export function stableStringify(value, depth = 0) {
  if (depth > 40) return '"[depth]"'
  if (value === undefined) return 'null'
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (type === 'string' || type === 'boolean' || type === 'bigint') return JSON.stringify(value)
  if (type === 'function' || type === 'symbol') return 'null'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item, depth + 1)).join(',') + ']'
  if (type === 'object') {
    const keys = Object.keys(value).sort()
    const parts = []
    for (const key of keys) {
      if (value[key] === undefined) continue
      parts.push(JSON.stringify(key) + ':' + stableStringify(value[key], depth + 1))
    }
    return '{' + parts.join(',') + '}'
  }
  return JSON.stringify(String(value))
}

export async function sha256File(file) {
  const { createReadStream } = await import('node:fs')
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 小文件（tsv/png/manifest）同步哈希；大文件走 sha256File。 */
export function sha256FileSync(file) {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return hash.digest('hex')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function atomicWriteFile(file, data) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, buffer)
    try { fsyncSync(fd) } catch { /* 部分文件系统不支持 */ }
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
  return file
}

export function atomicWriteJson(file, value) {
  return atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n')
}

export function readJsonIfExists(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function removeDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

export function cleanStaging(dir) {
  removeDir(dir)
}

export function safeName(name, fallback = 'item', max = 120) {
  const base = path.basename(String(name || fallback))
  const cleaned = base
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, max)
  return cleaned || fallback
}

export function fileSize(file) {
  try { return statSync(file).size } catch { return 0 }
}

// ---------------------------------------------------------------------------
// 幂等键
// ---------------------------------------------------------------------------

/**
 * 幂等键：输入版本 + 完整计划 + 模板版本 + 参数 + 随机种子。
 * 任何一项变化都是新 run；相同输入重提直接复用旧 run（不重复执行）。
 */
export function idempotencyKey(input) {
  return sha256(stableStringify({
    dataset_id: input.dataset_id || null,
    dataset_revision: input.dataset_revision || null,
    plan_hash: input.plan_hash || null,
    template: input.template || null,
    template_version: input.template_version ?? null,
    seed: input.seed ?? null,
    params: input.params || {},
    steps: input.steps || null,
    parent_run: input.parent_run || null,
  }))
}

// ---------------------------------------------------------------------------
// 取消标记错误
// ---------------------------------------------------------------------------

export function cancelledError(message = 'run 已取消') {
  return Object.assign(new Error(message), { code: 'cancelled' })
}

export function storeError(code, message, details) {
  const error = Object.assign(new Error(message), { code })
  if (details && typeof details === 'object') error.details = details
  return error
}

// ---------------------------------------------------------------------------
// 文本表格（无第三方 CSV 库）
// ---------------------------------------------------------------------------

/** 引号感知的定界文本解析；支持 CRLF、BOM、引号内换行。 */
export function parseDelimited(text, delimiter) {
  let input = String(text || '')
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1)
  const delim = delimiter || sniffDelimiter(input)
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1 } else { inQuotes = false }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') { inQuotes = true; continue }
    if (ch === delim) { row.push(field); field = ''; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    if (ch === '\r') continue
    field += ch
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  while (rows.length && rows[rows.length - 1].every((value) => String(value).trim() === '')) rows.pop()
  if (!rows.length) return { delimiter: delim, header: [], rows: [], objects: [] }
  const header = rows[0].map((value) => String(value).trim())
  const objects = rows.slice(1).map((values) => {
    const object = {}
    header.forEach((key, index) => { object[key] = values[index] === undefined ? '' : values[index] })
    return object
  })
  return { delimiter: delim, header, rows: rows.slice(1), objects }
}

export function sniffDelimiter(text) {
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || ''
  const candidates = [
    [',', (firstLine.match(/,/g) || []).length],
    ['\t', (firstLine.match(/\t/g) || []).length],
    [';', (firstLine.match(/;/g) || []).length],
  ]
  candidates.sort((a, b) => b[1] - a[1])
  return candidates[0][1] > 0 ? candidates[0][0] : ','
}

export function normalizeColumnSpec(columns) {
  return (columns || []).map((column, index) => {
    if (typeof column === 'string') return { key: column, label: column, type: 'string' }
    const key = String(column.key ?? column.id ?? column.name ?? `col_${index}`)
    return {
      key,
      label: String(column.label ?? column.title ?? key),
      type: String(column.type ?? 'string'),
      unit: column.unit,
    }
  })
}

/**
 * 表格 → TSV。rows 可以是对象数组，也可以是数组的数组（按 columns 顺序）。
 * 每个数据行追加稳定 row_id；调用方可额外传入 contrast / evidence_kind 等固定列。
 * 只有一行表头：不再输出「标签行」——普通 TSV 解析器会把第二行当数据（见 docs/DETAIL.md §2.2）。
 */
export function tableToTsv(columns, rows, extraColumns = []) {
  const spec = normalizeColumnSpec(columns)
  const header = [...spec.map((column) => column.key), ...extraColumns.map((column) => column.key), 'row_id']
  const lines = [header.join('\t')]
  const dataRows = Array.isArray(rows) ? rows : []
  dataRows.forEach((row, index) => {
    const values = []
    if (Array.isArray(row)) {
      for (let i = 0; i < spec.length; i += 1) values.push(row[i])
    } else if (row && typeof row === 'object') {
      for (const column of spec) values.push(row[column.key])
    }
    for (const column of extraColumns) {
      // extra 列可以是常量（{key, value}，例如 table_id / contrast_id / evidence_kind），
      // 也可以从数据行里取（{key}）。此前只支持后者，导致常量列总是空值。
      if (column && Object.prototype.hasOwnProperty.call(column, 'value')) values.push(column.value)
      else values.push(row && typeof row === 'object' ? row[column.key] : undefined)
    }
    values.push(index + 1)
    lines.push(values.map((value) => tsvCell(value)).join('\t'))
  })
  return lines.join('\n') + '\n'
}

export function tsvCell(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ''
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)))
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return value.map((item) => tsvCell(item)).join(';')
  if (typeof value === 'object') return JSON.stringify(value)
  // TSV 里不允许裸 tab / 换行
  return String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
}

/** 从列名猜测单位/类型，仅用于展示。 */
export function columnTypeOf(key) {
  const lower = String(key || '').toLowerCase()
  if (/(^|_)(p|pval|p_value|pval_adj|q|fdr|padj)$/.test(lower) || lower.includes('pval') || lower.includes('fdr')) return 'pvalue'
  if (/(^|_)(log2fc|logfc|log2foldchange|effect|coef|estimate|stat|t_stat|z)$/.test(lower)) return 'effect'
  if (/(^|_)(n|n_samples|n_cells|count|donor|patient|replicate)/.test(lower)) return 'n'
  return 'number'
}

// ---------------------------------------------------------------------------
// 存储后端
// ---------------------------------------------------------------------------

const RECORD_KINDS = ['run', 'dataset', 'plan', 'search', 'artifact', 'meta']

class RecordBackend {
  constructor(root) {
    this.root = root
    this.kind = 'base'
    this.records = new Map(RECORD_KINDS.map((kind) => [kind, new Map()]))
    this.idemIndex = new Map()
    this.writeCount = 0
    this.warnings = []
  }

  all(kind) {
    return [...(this.records.get(kind) || new Map()).values()]
  }

  get(kind, id) {
    return (this.records.get(kind) || new Map()).get(id) || null
  }

  put(kind, id, body) {
    const bucket = this.records.get(kind)
    if (!bucket) throw new Error(`未知记录类型 ${kind}`)
    bucket.set(id, body)
    this.writeCount += 1
    this.persist(kind, id, body)
    if (kind === 'run' && body && body.idempotency_key) {
      this.idemIndex.set(body.idempotency_key, body.run_id)
    }
  }

  remove(kind, id) {
    const bucket = this.records.get(kind)
    if (bucket) bucket.delete(id)
  }

  findRunByIdempotencyKey(key) {
    const id = this.idemIndex.get(key)
    return id ? this.get('run', id) : null
  }

  loadFrom(records) {
    for (const kind of RECORD_KINDS) {
      const map = this.records.get(kind)
      map.clear()
      for (const body of records[kind] || []) map.set(body[recordIdField(kind)], body)
    }
    this.idemIndex.clear()
    for (const run of this.all('run')) {
      if (run.idempotency_key) this.idemIndex.set(run.idempotency_key, run.run_id)
    }
  }

  persist() { /* 子类实现 */ }
  close() { /* 子类实现 */ }
}

function recordIdField(kind) {
  if (kind === 'run') return 'run_id'
  if (kind === 'dataset') return 'dataset_id'
  if (kind === 'plan') return 'plan_id'
  if (kind === 'search') return 'search_id'
  if (kind === 'artifact') return 'artifact_id'
  return 'key'
}

/** SQLite 后端：records(kind,id,body) + runs.idempotency_key 唯一索引。 */
class SqliteBackend extends RecordBackend {
  constructor(root, DatabaseSync) {
    super(root)
    this.kind = 'sqlite'
    this.file = path.join(root, 'store.sqlite')
    ensureDir(root)
    this.db = new DatabaseSync(this.file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        body TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE TABLE IF NOT EXISTS idem (
        key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    this.load()
  }

  load() {
    const records = Object.fromEntries(RECORD_KINDS.map((kind) => [kind, []]))
    for (const row of this.db.prepare('SELECT kind,id,body FROM records').all()) {
      try {
        records[row.kind].push(JSON.parse(row.body))
      } catch { /* 跳过损坏行 */ }
    }
    this.loadFrom(records)
  }

  /**
   * 读一律走 SQLite，不用构造时的内存快照：
   * 宿主里的 bioflow 与另一个进程里的 CLI 共用一个 store.sqlite，
   * 内存快照会让两边互相看不见对方刚写的 dataset/run（实测宿主一直显示 runs=0）。
   */
  all(kind) {
    const rows = this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY at').all(kind)
    const out = []
    for (const row of rows) {
      try { out.push(JSON.parse(row.body)) } catch { /* 跳过损坏行 */ }
    }
    return out
  }

  get(kind, id) {
    const row = this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, String(id))
    if (!row) return null
    try { return JSON.parse(row.body) } catch { return null }
  }

  persist(kind, id, body) {
    this.db.prepare('INSERT INTO records(kind,id,body,at) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body, at=excluded.at')
      .run(kind, id, JSON.stringify(body), nowIso())
    if (kind === 'run' && body.idempotency_key) {
      this.db.prepare('INSERT OR IGNORE INTO idem(key,run_id) VALUES(?,?)').run(body.idempotency_key, body.run_id)
    }
  }

  /** 跨进程幂等：另一个进程（CLI）可能先建了同 key 的 run。 */
  findRunByIdempotencyKey(key) {
    const hit = this.idemIndex.get(key)
    if (hit) return this.get('run', hit)
    const row = this.db.prepare('SELECT run_id FROM idem WHERE key=?').get(key)
    if (!row) return null
    const record = this.db.prepare("SELECT body FROM records WHERE kind='run' AND id=?").get(row.run_id)
    if (!record) return null
    try {
      const body = JSON.parse(record.body)
      this.records.get('run').set(body.run_id, body)
      this.idemIndex.set(key, body.run_id)
      return body
    } catch {
      return null
    }
  }

  /** 删除记录：读走 DB，所以必须真的 DELETE（不能只删内存）。 */
  remove(kind, id) {
    const key = String(id)
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, key)
    if (kind === 'run') this.db.prepare('DELETE FROM idem WHERE run_id=?').run(key)
    const bucket = this.records.get(kind)
    if (bucket) bucket.delete(key)
  }

  close() {
    try { this.db.close() } catch { /* ignore */ }
  }
}

/** JSON 后端：快照 + append-only journal；journal 过长时压缩回快照。 */
class JsonBackend extends RecordBackend {
  constructor(root) {
    super(root)
    this.kind = 'json'
    this.file = path.join(root, 'store.json')
    this.journalFile = path.join(root, 'journal.jsonl')
    ensureDir(root)
    this.journalLines = 0
    this.load()
  }

  /** store.json / journal 被别的进程改过就重载（CLI 与宿主共用数据根时必需）。 */
  maybeReload() {
    try {
      const stamp = `${fileSize(this.file)}:${fileSize(this.journalFile)}`
      if (this.stamp === stamp) return
      this.stamp = stamp
      this.load()
    } catch { /* 读失败保持现状 */ }
  }

  all(kind) {
    this.maybeReload()
    return super.all(kind)
  }

  get(kind, id) {
    this.maybeReload()
    return super.get(kind, id)
  }

  load() {
    const snapshot = readJsonIfExists(this.file)
    if (snapshot && snapshot.records) this.loadFrom(snapshot.records)
    let raw = ''
    try { raw = readFileSync(this.journalFile, 'utf8') } catch { raw = '' }
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (!text) continue
      let entry
      try { entry = JSON.parse(text) } catch { continue }
      if (!entry || !entry.kind || !entry.id) continue
      if (entry.op === 'put') {
        const bucket = this.records.get(entry.kind)
        if (bucket) bucket.set(entry.id, entry.body)
        if (entry.kind === 'run' && entry.body && entry.body.idempotency_key) {
          this.idemIndex.set(entry.body.idempotency_key, entry.body.run_id)
        }
      } else if (entry.op === 'remove') {
        const bucket = this.records.get(entry.kind)
        if (bucket) bucket.delete(entry.id)
      }
      this.journalLines += 1
    }
  }

  persist(kind, id, body) {
    appendFileSync(this.journalFile, JSON.stringify({ op: 'put', kind, id, body, at: nowIso() }) + '\n')
    this.journalLines += 1
    if (this.journalLines >= 500) this.compact()
  }

  remove(kind, id, body) {
    super.remove(kind, id)
    appendFileSync(this.journalFile, JSON.stringify({ op: 'remove', kind, id, at: nowIso() }) + '\n')
  }

  compact() {
    const records = {}
    for (const kind of RECORD_KINDS) records[kind] = this.all(kind)
    atomicWriteJson(this.file, { schema_version: SCHEMA_VERSION, kind: 'snapshot', at: nowIso(), records })
    atomicWriteFile(this.journalFile, '')
    this.journalLines = 0
  }

  close() {
    try { this.compact() } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Store（业务接口，两个后端共用）
// ---------------------------------------------------------------------------

export class Store {
  constructor({ root, kind = 'auto', log = null } = {}) {
    this.root = root || path.join(os.homedir(), '.dsh', 'bioflow')
    ensureDir(this.root)
    this.log = typeof log === 'function' ? log : () => {}
    this.backend = openBackend(this.root, kind, this.log)
    this.dirs = {
      root: this.root,
      datasets: path.join(this.root, 'datasets'),
      plans: path.join(this.root, 'plans'),
      searches: path.join(this.root, 'searches'),
      runs: path.join(this.root, 'runs'),
      cache: path.join(this.root, 'cache'),
      pubmed: path.join(this.root, 'cache', 'pubmed'),
      logs: path.join(this.root, 'logs'),
    }
    for (const dir of Object.values(this.dirs)) ensureDir(dir)
    this.closed = false
  }

  get kind() { return this.backend.kind }
  get warnings() { return this.backend.warnings }

  // -- 生命周期 -----------------------------------------------------------
  close() {
    if (this.closed) return
    this.closed = true
    try { this.backend.close() } catch (error) { this.log('store', `close 失败：${error && error.message}`) }
  }

  info() {
    const runs = this.backend.all('run')
    const byStatus = {}
    for (const run of runs) byStatus[run.status] = (byStatus[run.status] || 0) + 1
    return {
      kind: this.kind,
      root: this.root,
      file: this.backend.file || null,
      datasets: this.backend.all('dataset').length,
      plans: this.backend.all('plan').length,
      searches: this.backend.all('search').length,
      runs: runs.length,
      runs_by_status: byStatus,
      warnings: this.warnings,
    }
  }

  // -- datasets -----------------------------------------------------------
  putDataset(manifest) {
    const id = manifest.dataset_id
    if (!id) throw storeError('bad_request', 'dataset manifest 缺少 dataset_id')
    const existing = this.backend.get('dataset', id)
    const record = { ...manifest, updated_at: nowIso(), created_at: (existing && existing.created_at) || manifest.created_at || nowIso() }
    this.backend.put('dataset', id, record)
    return { dataset: record, reused: Boolean(existing) }
  }

  getDataset(id) {
    return this.backend.get('dataset', String(id || ''))
  }

  listDatasets({ limit = 50 } = {}) {
    return this.backend.all('dataset')
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit)
  }

  // -- plans --------------------------------------------------------------
  putPlan(plan) {
    if (!plan.plan_id) throw storeError('bad_request', 'plan 缺少 plan_id')
    this.backend.put('plan', plan.plan_id, plan)
    return plan
  }

  getPlan(id) {
    return this.backend.get('plan', String(id || ''))
  }

  // -- searches -----------------------------------------------------------
  putSearch(record) {
    if (!record.search_id) throw storeError('bad_request', 'search 缺少 search_id')
    this.backend.put('search', record.search_id, record)
    return record
  }

  getSearch(id) {
    return this.backend.get('search', String(id || ''))
  }

  // -- runs ---------------------------------------------------------------
  /** 新建 run；同 idempotency_key 已存在则复用（reused: true）。 */
  createRun(input) {
    const key = input.idempotency_key || idempotencyKey(input)
    const existing = this.backend.findRunByIdempotencyKey(key)
    if (existing) return { run: this.getRun(existing.run_id), reused: true }
    const now = nowIso()
    const status = input.status || 'queued'
    if (!RUN_STATUSES.includes(status)) throw storeError('bad_request', `未知 run 状态 ${status}`)
    const run = {
      schema_version: SCHEMA_VERSION,
      run_id: input.run_id,
      idempotency_key: key,
      status,
      status_history: [{ status, at: now }],
      plan_id: input.plan_id || null,
      plan_hash: input.plan_hash || null,
      template: input.template || null,
      template_version: input.template_version ?? null,
      dataset_id: input.dataset_id || null,
      dataset_revision: input.dataset_revision || null,
      params: input.params || {},
      seed: input.seed ?? null,
      parent_run: input.parent_run || null,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
      error: null,
      warnings: [],
      zero_significant: null,
      steps: [],
      artifacts: [],
      manifest_sha256: null,
    }
    if (!run.run_id) throw storeError('bad_request', 'createRun 需要 run_id')
    this.backend.put('run', run.run_id, run)
    return { run: this.getRun(run.run_id), reused: false }
  }

  getRun(runId) {
    return this.backend.get('run', String(runId || ''))
  }

  listRuns({ limit = 30, status = null, dataset_id = null } = {}) {
    return this.backend.all('run')
      .filter((run) => (status ? run.status === status : true))
      .filter((run) => (dataset_id ? run.dataset_id === dataset_id : true))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit)
  }

  /** 原子状态迁移；返回更新后的 run。非法迁移抛 bad_transition。 */
  transition(runId, to, extra = {}) {
    const run = this.getRun(runId)
    if (!run) throw storeError('not_found', `run 不存在：${runId}`)
    if (!RUN_STATUSES.includes(to)) throw storeError('bad_request', `未知状态 ${to}`)
    if (run.status === to) return run
    if (!canTransition(run.status, to)) {
      throw storeError('bad_transition', `run ${runId} 不能从 ${run.status} 迁移到 ${to}`, {
        from: run.status, to, allowed: TRANSITIONS[run.status],
      })
    }
    const now = nowIso()
    run.status = to
    run.updated_at = now
    run.status_history = [...(run.status_history || []), { status: to, at: now }]
    if (to === 'running' && !run.started_at) run.started_at = now
    if (TERMINAL_STATUSES.includes(to)) run.finished_at = now
    if (extra.error !== undefined) run.error = extra.error
    if (extra.warnings) run.warnings = [...(run.warnings || []), ...extra.warnings]
    if (extra.zero_significant !== undefined) run.zero_significant = extra.zero_significant
    if (extra.manifest_sha256 !== undefined) run.manifest_sha256 = extra.manifest_sha256
    this.backend.put('run', run.run_id, run)
    return this.getRun(run.run_id)
  }

  /** 请求取消：pending_review/queued/running → cancelled。终态返回原记录。 */
  cancelRun(runId, reason = '用户取消') {
    const run = this.getRun(runId)
    if (!run) throw storeError('not_found', `run 不存在：${runId}`)
    if (TERMINAL_STATUSES.includes(run.status)) {
      return { run, changed: false, reason: `run 已是终态 ${run.status}` }
    }
    const updated = this.transition(runId, 'cancelled', { error: reason })
    return { run: updated, changed: true }
  }

  isCancelled(runId) {
    const run = this.getRun(runId)
    return Boolean(run && run.status === 'cancelled')
  }

  /** 取消零写入的守卫：取消后（或不存在）拒绝一切产物提交。 */
  assertWritable(runId) {
    const run = this.getRun(runId)
    if (!run) throw storeError('not_found', `run 不存在：${runId}`)
    if (run.status === 'cancelled') throw cancelledError(`run ${runId} 已取消，拒绝写入产物`)
    if (TERMINAL_STATUSES.includes(run.status)) {
      throw storeError('bad_transition', `run ${runId} 已结束（${run.status}），拒绝写入产物`)
    }
    return run
  }

  // -- steps / attempts ---------------------------------------------------
  setStep(runId, step) {
    const run = this.getRun(runId)
    if (!run) throw storeError('not_found', `run 不存在：${runId}`)
    if (!run.steps) run.steps = []
    const index = run.steps.findIndex((item) => item.step_id === step.step_id)
    const now = nowIso()
    if (index >= 0) {
      const previous = run.steps[index]
      run.steps[index] = {
        ...previous,
        ...step,
        attempts: previous.attempts || 0,
        started_at: step.started_at !== undefined ? step.started_at : previous.started_at,
        updated_at: now,
      }
      if (step.status === 'running' && !run.steps[index].started_at) run.steps[index].started_at = now
    } else {
      run.steps.push({
        step_id: step.step_id,
        plugin: step.plugin || null,
        action: step.action || null,
        status: step.status || 'pending',
        attempts: 0,
        started_at: step.status === 'running' ? now : null,
        finished_at: TERMINAL_STATUSES.includes(step.status) ? now : null,
        error: step.error || null,
        deliver: step.deliver || null,
        created_at: now,
        updated_at: now,
      })
    }
    run.updated_at = now
    this.backend.put('run', run.run_id, run)
    return run.steps.find((item) => item.step_id === step.step_id)
  }

  /** 通用字段补丁（证据登记后刷新 manifest_sha256 等）；不允许改 status / status_history。 */
  patchRun(runId, patch = {}) {
    const run = this.getRun(runId)
    if (!run) throw storeError('not_found', `run 不存在：${runId}`)
    const next = { ...run, ...patch }
    next.run_id = run.run_id
    next.status = run.status
    next.status_history = run.status_history
    next.created_at = run.created_at
    next.updated_at = nowIso()
    this.backend.put('run', run.run_id, next)
    return next
  }

  beginAttempt(runId, stepId) {
    const run = this.getRun(runId)
    if (!run) throw storeError('not_found', `run 不存在：${runId}`)
    const step = (run.steps || []).find((item) => item.step_id === stepId)
    if (!step) throw storeError('not_found', `step 不存在：${stepId}`)
    step.attempts = (step.attempts || 0) + 1
    step.status = 'running'
    step.started_at = step.started_at || nowIso()
    run.updated_at = nowIso()
    this.backend.put('run', run.run_id, run)
    return step.attempts
  }

  // -- artifacts ----------------------------------------------------------
  /** 登记交付物；artifact_id = sha256(bytes)。取消/终态后拒绝。 */
  addArtifact(runId, artifact) {
    const run = this.assertWritable(runId)
    if (!artifact || !artifact.sha256) throw storeError('bad_request', 'artifact 需要 sha256')
    const list = run.artifacts || []
    const existing = list.find((item) => item.relative_path === artifact.relative_path)
    const record = {
      artifact_id: artifact.sha256,
      kind: artifact.kind || 'file',
      name: artifact.name || path.basename(artifact.relative_path || ''),
      relative_path: artifact.relative_path,
      sha256: artifact.sha256,
      bytes: artifact.bytes ?? 0,
      at: nowIso(),
    }
    if (existing) Object.assign(existing, record)
    else list.push(record)
    run.artifacts = list
    run.updated_at = nowIso()
    this.backend.put('run', run.run_id, run)
    return record
  }

  /**
   * 两种用法共用同一个方法名（历史上曾被重复定义，后者覆盖前者，导致
   * finalizeRun 里 store.listArtifacts(run_id) 拿不到 results/steps 等 run 产物）：
   *   - 传 run_id 字符串 → 该 run 已登记的交付物；
   *   - 传 {limit} 或不传 → 内容寻址的全局下载产物（putArtifact）。
   */
  listArtifacts(runIdOrOptions) {
    if (typeof runIdOrOptions === 'string') {
      const run = this.getRun(runIdOrOptions)
      return run ? run.artifacts || [] : []
    }
    const { limit = 100 } = runIdOrOptions || {}
    return this.backend.all('artifact')
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit)
  }

  // -- 下载产物（不属于某个 run 的 artifact，内容寻址） -------------------
  putArtifact(artifact) {
    if (!artifact || !artifact.sha256) throw storeError('bad_request', 'artifact 需要 sha256')
    const artifactId = artifact.artifact_id || artifact.sha256
    const record = {
      schema_version: SCHEMA_VERSION,
      artifact_id: artifactId,
      sha256: artifact.sha256,
      md5: artifact.md5 || null,
      bytes: artifact.bytes ?? 0,
      name: artifact.name || path.basename(artifact.path || artifactId),
      path: artifact.path || null,
      kind: artifact.kind || 'file',
      source: artifact.source || null,
      url: artifact.url || null,
      etag: artifact.etag || null,
      meta: artifact.meta || null,
      created_at: artifact.created_at || nowIso(),
      updated_at: nowIso(),
    }
    const existing = this.backend.get('artifact', artifactId)
    const merged = existing ? { ...existing, ...record, created_at: existing.created_at } : record
    this.backend.put('artifact', artifactId, merged)
    return { artifact: merged, reused: Boolean(existing) }
  }

  getArtifact(artifactId) {
    return this.backend.get('artifact', String(artifactId || ''))
  }

  // -- 运行目录（文件系统） ------------------------------------------------
  runDir(runId) {
    return path.join(this.dirs.runs, String(runId))
  }

  datasetDir(datasetId) {
    return path.join(this.dirs.datasets, String(datasetId))
  }

  planFile(planId) {
    return path.join(this.dirs.plans, `${planId}.json`)
  }

  searchFile(searchId) {
    return path.join(this.dirs.searches, `${searchId}.json`)
  }

  pubmedCacheFile(key) {
    return path.join(this.dirs.pubmed, `${key}.json`)
  }

  logEvent(scope, kind, detail = {}) {
    const line = JSON.stringify({ at: nowIso(), scope, kind, detail })
    try {
      ensureDir(this.dirs.logs)
      appendFileSync(path.join(this.dirs.logs, 'events.jsonl'), line + '\n')
    } catch { /* 日志失败不影响业务 */ }
    try { this.log(scope, `${kind} ${stableStringify(detail)}`) } catch { /* ignore */ }
  }
}

function openBackend(root, kind, log) {
  const wanted = String(kind || process.env.BIOFLOW_STORE || 'auto').toLowerCase()
  if (wanted === 'json') return new JsonBackend(root)
  let sqliteAvailable = false
  try {
    // eslint-disable-next-line no-new-func
    sqliteAvailable = Boolean(requireSqlite())
  } catch { sqliteAvailable = false }
  if (wanted === 'sqlite' && !sqliteAvailable) {
    throw storeError('unsupported', '当前 Node 不支持 node:sqlite（需要 Node 22+），请设置 BIOFLOW_STORE=json')
  }
  let sqliteError = null
  if (sqliteAvailable) {
    try {
      return new SqliteBackend(root, requireSqlite())
    } catch (error) {
      sqliteError = error
      log('store', `SQLite 打开失败，降级 JSON+journal：${error && error.message}`)
    }
  }
  const backend = new JsonBackend(root)
  // 警告必须说真话：模块不可用 / 打开失败（权限、损坏、目录不可写）是两回事。
  backend.warnings.push(sqliteError
    ? `node:sqlite 打开 ${path.join(root, 'store.sqlite')} 失败（${sqliteError && sqliteError.message}），已降级 JSON+journal 存储`
    : 'node:sqlite 不可用（Node < 22），已降级 JSON+journal 存储')
  return backend
}

let sqliteModule
function requireSqlite() {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = createRequire(import.meta.url)('node:sqlite')
    } catch {
      sqliteModule = null
    }
  }
  if (!sqliteModule || !sqliteModule.DatabaseSync) return null
  return sqliteModule.DatabaseSync
}

// ---------------------------------------------------------------------------
// 打开入口
// ---------------------------------------------------------------------------

export function openStore(opts = {}) {
  return new Store(opts)
}

export default openStore
