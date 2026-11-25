#!/usr/bin/env node
/**
 * bioflow CLI —— 与 agent 工具同一套 lib 函数（lib/impl.mjs runTool）。
 *
 * 用法：
 *   node bin/bioflow.mjs <action> [--k=v ...] [--json] [--data-dir=/abs/path]
 *   node bin/bioflow.mjs status --json
 *   node bin/bioflow.mjs register --path=/abs/data.csv --group-column=group --sample-sheet=/abs/s.tsv
 *   node bin/bioflow.mjs plan --dataset=ds_xxx --template=bulk-two-group --case=tumor --control=normal
 *   node bin/bioflow.mjs submit --plan-id=<id>
 *   node bin/bioflow.mjs search --sources=pubmed,gdc --query="gastric cancer liver metastasis"
 *
 * 退出码：0 成功；2 被闸门拦截或执行失败（输出里带原因）；1 参数/内部错误。
 */
import * as impl from '../lib/impl.mjs'

const argv = process.argv.slice(2)
// 子命令与 action 同名；CLI 侧允许 run-status 这种连字符写法 → 统一成 run_status。
const rawAction = (argv.shift() || 'status').replace(/^--\s*/, '').trim()
const action = rawAction.toLowerCase().replace(/-/g, '_')
const args = {}
let asJson = false
if (action === 'help' || action === '--help' || rawAction === '-h') {
  process.stdout.write([
    '用法: node bin/bioflow.mjs <cmd> [--k=v ...] [--json] [--data-dir=/abs/path]',
    'cmd: status | search | register | plan | submit | run-status | runs | cancel | export | evidence |',
    '     methods | templates | audit | suggest | datasets | health | download | ask | harmonize | joint',
    '退出码: 0 成功；2 被闸门拦 / 执行失败 / 参数错误（stdout 仍有 JSON，stderr 放日志）',
  ].join('\n') + '\n')
  process.exit(0)
}
for (const raw of argv) {
  if (!raw.startsWith('--')) continue
  const eq = raw.indexOf('=')
  const key = (eq < 0 ? raw.slice(2) : raw.slice(2, eq)).replace(/-/g, '_')
  if (key === 'json') { asJson = true; continue }
  const value = eq < 0 ? true : coerce(raw.slice(eq + 1))
  args[key] = value
}
const dataDir = args.data_dir
delete args.data_dir

function coerce(text) {
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
    try { return JSON.parse(text) } catch { return text }
  }
  return text
}

const runtime = { version: '0.1.0', config: dataDir ? { dataDir } : {}, ctx: null, invocation: 'cli' }

try {
  const result = await impl.runTool(runtime, { action, ...args })
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result === undefined ? null : result, null, 2)}\n`)
  } else {
    process.stdout.write(`${render(action, result)}\n`)
  }
  const blocked = result && (result.status === 'blocked' || result.ok === false)
  impl.disposeRuntime(runtime)
  process.exit(blocked ? 2 : 0)
} catch (error) {
  const payload = {
    ok: false,
    error: (error && error.code) || 'internal_error',
    message: String(error && error.message ? error.message : error),
    details: (error && error.details) || null,
  }
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`)
  impl.disposeRuntime(runtime)
  process.exit(2)
}

function render(kind, result) {
  if (result == null) return `${kind}: (空结果)`
  if (typeof result === 'string') return result
  const lines = []
  if (result.summary) lines.push(result.summary)
  if (Array.isArray(result.rows)) {
    for (const row of result.rows.slice(0, 40)) lines.push('· ' + (typeof row === 'string' ? row : JSON.stringify(row)))
    if (result.rows.length > 40) lines.push(`… 共 ${result.rows.length} 行`)
  }
  if (!lines.length) return JSON.stringify(result, null, 2)
  return lines.join('\n')
}
