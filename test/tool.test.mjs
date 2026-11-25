/**
 * 工具接线测试：`bioflow` agent 工具 / prompt section / catalog 契约。
 *
 * 这里不启动 Python、不联网、不跑分析：只验证宿主看到的东西是完整的，
 * 以及「工具 / HTTP / CLI 共用 runTool」这一条没有被破坏。
 *
 * 覆盖：
 *   - 注册名、action 枚举与 ACTIONS 一致、参数 schema 合法（无 JSON Schema 保留字冲突）
 *   - prompt section 有 name/order/text
 *   - buildCatalog：六个模板 / 五个数据源 / 六个工作台 / 闸门清单 / 六条路由
 *   - 未知 action 报 bad_request，不静默返回 ok
 *   - evidence 写模式：claim 不绑定表/图必须被拒（避免无法回查的 claim）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as impl from '../lib/impl.mjs'
import { PLUGIN_IDS } from '../lib/adapters.mjs'

function makeRuntime() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bf-tool-'))
  const registered = { tool: null, section: null }
  const ctx = {
    get: (name) => {
      if (name === 'tools') return { register: (definition) => { registered.tool = definition; return () => {} } }
      if (name === 'systemPrompt') return { section: (section) => { registered.section = section; return () => {} } }
      return null
    },
  }
  const runtime = { version: 'test', config: { dataDir: dir }, ctx, invocation: 'test' }
  return { runtime, registered, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('工具接线：注册名 bioflow，action 枚举与 ACTIONS 完全一致', () => {
  const { runtime, registered, cleanup } = makeRuntime()
  try {
    assert.equal(impl.ensureToolRegistered(runtime), true)
    assert.ok(registered.tool, '没有注册 tool')
    assert.equal(registered.tool.name, 'bioflow')
    const action = registered.tool.parameters.action
    assert.deepEqual(action.enum, impl.ACTIONS)
    for (const required of ['status', 'templates', 'search', 'register', 'plan', 'submit', 'runs', 'run_status', 'cancel', 'export', 'evidence', 'methods', 'audit', 'suggest']) {
      assert.ok(impl.ACTIONS.includes(required), `ACTION 缺少 v1 必需的 ${required}`)
    }
  } finally { cleanup() }
})

test('工具接线：参数 schema 每个字段都声明类型，且不使用 JSON Schema 保留字作参数名', () => {
  const { runtime, registered, cleanup } = makeRuntime()
  const reserved = new Set(['type', 'enum', 'const', 'properties', 'required', 'items', 'additionalProperties', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'])
  try {
    impl.ensureToolRegistered(runtime)
    // 宿主接受「扁平参数表」形式（与 dsh-plotlab 一致）：parameters 直接是 {参数名: schema}
    const params = registered.tool.parameters
    assert.equal(typeof params, 'object')
    assert.ok(!('type' in params), 'parameters 不应再包一层 JSON Schema 根')
    const names = Object.keys(params)
    assert.ok(names.length > 30, `参数太少：${names.length}`)
    for (const name of names) {
      assert.ok(!reserved.has(name), `参数名 ${name} 是保留字`)
      assert.equal(typeof params[name].type, 'string', `参数 ${name} 缺 type`)
    }
    assert.equal(typeof registered.tool.execute, 'function')
    assert.equal(registered.tool.output.schema.type, 'object')
    assert.equal(typeof registered.tool.output.render, 'function')
  } finally { cleanup() }
})

test('prompt section：注册且有 name / order / text', () => {
  const { runtime, registered, cleanup } = makeRuntime()
  try {
    assert.equal(impl.ensurePromptSection(runtime), true)
    assert.ok(registered.section)
    assert.equal(typeof registered.section.name, 'string')
    assert.ok(registered.section.name.length > 0)
    assert.equal(typeof registered.section.order, 'number')
    const text = typeof registered.section.text === 'function' ? registered.section.text() : registered.section.text
    assert.match(text, /许愿式生物信息全自动分析平台/)
    assert.match(text, /ask/)
  } finally { cleanup() }
})

test('catalog：六个模板 / 五个数据源 / 六个工作台 / 闸门清单 / 路由', async () => {
  const { runtime, cleanup } = makeRuntime()
  try {
    const catalog = await impl.buildCatalog(runtime)
    assert.equal(catalog.ok, true)
    assert.equal(catalog.platform, '许愿式生物信息全自动分析平台')
    const templateIds = catalog.templates.map((item) => item.id).sort()
    assert.deepEqual(templateIds, ['bulk-two-group', 'metabolomics-de', 'plotlab-figure', 'scrna-composition', 'spatial-domain', 'virtualcell-perturb'])
    assert.deepEqual(catalog.sources.map((item) => item.source), ['geo', 'pubmed', 'gdc', 'metabolights', 'cellxgene'])
    assert.deepEqual(catalog.plugins.map((row) => row.plugin), PLUGIN_IDS)
    assert.ok(catalog.gates.length >= 10)
    for (const id of ['dataset_registered', 'sample_table', 'contrast', 'replication', 'design_confounded', 'counts_verified']) {
      assert.ok(catalog.gates.some((gate) => gate.id === id), `闸门清单缺少 ${id}`)
    }
    for (const route of ['dispatch', 'catalog', 'status', 'health', 'figures', 'files']) {
      assert.ok(catalog.routes[route], `路由表缺少 ${route}`)
    }
    assert.deepEqual(catalog.deliverables, ['manifest.json', 'design.tsv', 'qc.tsv', 'results/*.tsv', 'figures/', 'evidence.jsonl', 'methods.md'])
  } finally { cleanup() }
})

test('未知 action 必须报错，不能返回 ok:true', async () => {
  const { runtime, cleanup } = makeRuntime()
  try {
    await assert.rejects(
      () => impl.runTool(runtime, { action: 'definitely_not_an_action' }),
      (error) => error && error.code === 'bad_request' && /未知 action/.test(error.message),
    )
  } finally { cleanup() }
})

test('evidence 写模式：claim 不绑定表/图会被拒绝（回查性硬约束）', async () => {
  const { runtime, cleanup } = makeRuntime()
  try {
    await assert.rejects(
      () => impl.runTool(runtime, { action: 'evidence', run_id: 'run_not_exist', claim: '一个没有出处的主张' }),
      (error) => error && ['not_found', 'prerequisite'].includes(error.code),
    )
  } finally { cleanup() }
})

test('宿主 pubmed 工具：存在时安装 forwarder，结果 via=dsh-pubmed 且作者截断为前 3 + et al', async () => {
  const executor = { calls: [], execute: async (args) => { executor.calls.push(args); return { total: 7, results: [{ pmid: '123', title: 'T', authors: ['A', 'B', 'C', 'D'], journal: 'J', year: 2024, doi: '10/x' }] } } }
  const runtime = { ctx: { get: (name) => (name === 'tools' ? { get: (toolName) => (toolName === 'pubmed' ? executor : null) } : null) }, config: {} }
  assert.equal(impl.ensurePubMedForwarder(runtime), true)
  const out = await runtime.pubmedForwarder({ term: 'nk cell', limit: 5 })
  assert.equal(out.via, 'dsh-pubmed')
  assert.equal(out.total, 7)
  assert.deepEqual(out.items[0].authors, ['A', 'B', 'C', 'et al'])
  assert.equal(out.items[0].pmid, '123')
  assert.equal(executor.calls.length, 1)
  // 二次调用不重复安装
  const before = runtime.pubmedForwarder
  impl.ensurePubMedForwarder(runtime)
  assert.equal(runtime.pubmedForwarder, before)
})

test('宿主没有 pubmed 工具时不安装 forwarder（交给内置 E-utilities）', () => {
  const runtime = { ctx: { get: () => null }, config: {} }
  assert.equal(impl.ensurePubMedForwarder(runtime), false)
  assert.equal(runtime.pubmedForwarder, undefined)
})
