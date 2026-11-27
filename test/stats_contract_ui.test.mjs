/**
 * dsh-bioflow · 统计口径 UI 测试（node:test）
 *
 * 口径卡的价值在于「进 UI 后仍然说人话」：
 *   · 齐全的 run 要能看到对比方向、检验、校正、每组 n、哈希；
 *   · 有缺陷的 run 必须把 warn caveat 顶到卡面上，而不是折叠起来；
 *   · 卡片里不能出现 button 套 button（历史上真实踩过）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function createHarness() {
  const hooks = []
  let cursor = 0
  const react = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2).flat(Infinity)
      return { type, props: Object.assign({}, props || {}, { children }) }
    },
    Fragment: 'fragment',
    Component: class { constructor(props) { this.props = props || {} } setState() {} render() { return null } },
    useState(init) { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof init === 'function' ? init() : init; return [hooks[index], () => {}] },
    useEffect() {}, useLayoutEffect() {},
    useRef(init) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: init === undefined ? null : init }; return hooks[index] },
    useMemo(fn) { cursor++; return fn() }, useCallback(fn) { cursor++; return fn },
    useReducer(reducer, init) { return [init, () => {}] },
    createContext(value) { return { Provider: 'provider', Consumer: 'consumer', value } },
    memo: (component) => component,
    forwardRef: (component) => component,
  }
  return { react, resetCursor: () => { cursor = 0 } }
}

function expand(node) {
  if (node === null || node === undefined || node === false) return { type: 'text', text: '' }
  if (typeof node === 'string' || typeof node === 'number') return { type: 'text', text: String(node) }
  if (Array.isArray(node)) return { type: 'frag', children: node.map(expand) }
  if (typeof node.type === 'function') {
    try { return expand(node.type(node.props)) } catch (error) { return { type: 'error', text: error.message } }
  }
  if (node.type === 'fragment') return { type: 'frag', children: (node.props.children || []).map(expand) }
  const props = node.props || {}
  return { type: node.type, props, children: (props.children || []).map(expand) }
}

function textOf(node) {
  if (!node) return ''
  if (node.type === 'text' || node.type === 'error') return node.text
  if (node.type === 'frag') return (node.children || []).map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

function findNestedButtons(node, insideButton = false, out = []) {
  if (!node || node.type === 'text' || node.type === 'error') return out
  if (node.type === 'frag') { (node.children || []).forEach((child) => findNestedButtons(child, insideButton, out)); return out }
  const isButton = node.type === 'button'
  if (isButton && insideButton) out.push(textOf(node).slice(0, 40))
  ;(node.children || []).forEach((child) => findNestedButtons(child, insideButton || isButton, out))
  return out
}

async function loadTestExports() {
  const harness = createHarness()
  let spec = null
  globalThis.window = {
    location: { hash: '#/' },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
    __ModuleLoader__: { load(captured) { spec = captured } },
    localStorage: { getItem: () => null, setItem() {} },
  }
  globalThis.document = globalThis.window.document
  await import(pathToFileURL(path.join(ROOT, 'client.js')).href + `?contract=${Date.now()}`)
  const module = spec.factory((name) => {
    if (name === 'react') return harness.react
    throw new Error(`unexpected require ${name}`)
  })
  harness.resetCursor()
  return module.__test__
}

const RAW_CONTRACT = {
  schema: 'bioflow.stats_contract/1',
  run_id: 'run_a1b2c3d4',
  template: 'bulk-two-group',
  status: 'succeeded',
  ok_to_cite: false,
  contrast: { case: 'tumor', control: 'normal', direction: 'tumor - normal', effect_convention: 'logFC = case - control' },
  design: {
    n_samples: 6, n_donors: 6, min_group_n: 3, paired: false, pair_column: null,
    covariates: ['batch'], formula: null,
    groups: [
      { name: 'normal', n_samples: 3, n_donors: 3 },
      { name: 'tumor', n_samples: 3, n_donors: 3 },
    ],
  },
  inference: {
    tests: [{ step_id: 'de', plugin: 'dsh-geobulk', method: 'limma-voom' }],
    fdr: { method: 'BH', alpha: 0.05, n_tests: null },
    min_replicate_note: '每组独立生物学重复 n>=2',
  },
  data: { dataset_id: 'ds_1', revision: 'ds_1', assay: 'rna-seq', species: 'human', scale: 'log_expression', scale_verified: false, n_files: 2 },
  evidence: { n_claims: 12, kinds: { measured: 10, descriptive: 0, model_prediction: 2 }, zero_significant: false },
  identity: { content_hash: 'b3d4f5a6c7d8', manifest_sha256: 'ff00ff00ff00ff00', run_dir: '/runs/run_a1b2c3d4', seed: 42 },
  environment: { bioflow_version: '0.1.0', node: 'v22.0.0', platform: 'darwin-arm64', plugins: { 'dsh-geobulk': { ok: true } } },
  reproduce: ['node bin/bioflow.mjs run-status --run-id=run_a1b2c3d4 --json'],
  caveats: [
    { code: 'scale_unverified', level: 'warn', text: '数据尺度 log_expression 未验证（verified≠true）：推断类结论应降级为描述。' },
    { code: 'fdr_family_unknown', level: 'info', text: '未记录多重校正的检验族大小（n_tests）。' },
    { code: 'model_prediction_present', level: 'warn', text: '证据里有 2 条模型预测：它们是假说，不是实验结论。' },
  ],
}

test('口径卡：对比/检验/校正/每组 n/数据尺度/哈希 全部上屏', async () => {
  const exports = await loadTestExports()
  const contract = exports.normalizeStatsContract(RAW_CONTRACT)
  assert.ok(contract, 'normalizeStatsContract 应能解析契约')
  const tree = expand(exports.components.StatsContractCard({ contract, onCopy() {} }))
  const text = textOf(tree)

  assert.match(text, /统计口径/)
  assert.match(text, /tumor - normal/)
  assert.match(text, /logFC = case - control/)
  assert.match(text, /limma-voom/)
  assert.match(text, /BH/)
  assert.match(text, /normal 3/)
  assert.match(text, /batch/, '协变量必须可见')
  assert.match(text, /log_expression/)
  assert.match(text, /未验证/, '未验证尺度必须显式')
  assert.match(text, /2 项待注意/, 'warn 数量必须是标题徽章')
  assert.match(text, /模型预测/, '模型预测 caveat 必须上屏')
  assert.match(text, /hash b3d4f5a6/, 'content_hash 必须可见')
  assert.deepEqual(findNestedButtons(tree), [], '口径卡不得出现 button 套 button')
})

test('口径卡：空契约给空状态而不是报错；纯文本降级不影响渲染', async () => {
  const exports = await loadTestExports()
  const empty = expand(exports.components.StatsContractCard({ contract: null, onCopy() {} }))
  assert.match(textOf(empty), /还没有统计口径/)

  const richText = textOf(expand(exports.components.StatsChips({ contract: exports.normalizeStatsContract(RAW_CONTRACT) })))
  assert.match(richText, /tumor - normal/)
  assert.match(richText, /2 项口径待注意/)
})

test('计划卡：提交前就能看到口径预览与待注意项', async () => {
  const exports = await loadTestExports()
  const draft = {
    planId: 'plan_9f8e7d',
    confirmToken: 'token_abc',
    template: 'bulk-two-group',
    summary: 'GSE 演示：两组差异 + 富集',
    warnings: [],
    limitations: [],
    missing: [],
    questions: [],
    gates: [{ id: 'counts_verified', status: 'pass', detail: '已声明 counts 并通过验证' }],
    fields: { dataset: 'ds_1', template: 'bulk-two-group', contrast: 'tumor - normal', scale: 'counts' },
    candidates: {},
    statsPreview: exports.normalizeStatsContract({ ...RAW_CONTRACT, phase: 'plan', ok_to_cite: false }),
  }
  const tree = expand(exports.components.PlanCard({
    draft, edits: {}, templates: [], submit: {}, submitBlocked: [],
    onEdit() {}, onCopy() {}, onSubmit() {}, onRetrySubmit() {}, onRegenerate() {}, onFocusTimeline() {},
  }))
  const text = textOf(tree)
  assert.match(text, /提交前口径预览/)
  assert.match(text, /现在改还来得及/, 'warn 必须在计划阶段就顶出来')
  assert.match(text, /模型预测/)
  assert.deepEqual(findNestedButtons(tree), [], '计划卡不得出现 button 套 button')
})
