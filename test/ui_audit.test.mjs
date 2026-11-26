/**
 * UI 结构自查（离线）：防止再出现「弹层被困在面板里」「button 套 button」这类真实交互故障。
 *
 * 1) CSS 守卫：任何可能创建 fixed 包含块的属性（backdrop-filter / filter / transform / perspective / will-change）
 *    不允许出现在 .bf-panel 这类包裹层上——上一版弹层被困左栏就是 backdrop-filter 导致。
 * 2) 渲染树守卫：渲染 WorkbenchBody / ChatColumn，检查不存在嵌套 button、fixed 元素不在含包含块的祖先里。
 * 3) 交互冒烟：点「论文 PDF / 图片」→ 弹层出现（role=dialog）→ 有拖拽区 / 上传 PDF / 上传图片。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(path.join(ROOT, 'client.js'), 'utf8')

// ---------------------------------------------------------------------------
// 极简 React 桩（带状态），用于展开渲染树
// ---------------------------------------------------------------------------
function createHarness() {
  let hooks = []
  let cursor = 0
  const react = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2).flat(Infinity)
      return { type, props: Object.assign({}, props || {}, { children }) }
    },
    Fragment: 'fragment',
    Component: class { constructor(props) { this.props = props || {}; this.state = {} } setState() {} render() { return null } },
    useState(init) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof init === 'function' ? init() : init
      const set = (value) => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }
      return [hooks[index], set]
    },
    useEffect() {}, useLayoutEffect() {},
    useRef(init) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: init === undefined ? null : init }; return hooks[index] },
    useMemo(fn) { cursor++; return fn() }, useCallback(fn) { cursor++; return fn },
    useReducer(reducer, init) { return [init, () => {}] },
    createContext(value) { return { Provider: 'provider', Consumer: 'consumer', value } },
    memo: (component) => component,
    forwardRef: (component) => component,
  }
  return { react, resetCursor: () => { cursor = 0 }, hooks }
}

function expand(node) {
  if (node === null || node === undefined || node === false) return { type: 'text', text: '' }
  if (typeof node === 'string' || typeof node === 'number') return { type: 'text', text: String(node) }
  if (Array.isArray(node)) return { type: 'frag', children: node.map(expand) }
  if (typeof node.type === 'function') {
    const isClass = node.type.prototype && node.type.prototype.render
    try { return expand(isClass ? new node.type(node.props).render() : node.type(node.props)) }
    catch (error) { return { type: 'error', text: error.message } }
  }
  if (node.type === 'fragment') return { type: 'frag', children: (node.props.children || []).map(expand) }
  const props = node.props || {}
  return {
    type: node.type,
    props: props,
    children: (props.children || []).map(expand),
  }
}

function textOf(node) {
  if (!node) return ''
  if (node.type === 'text' || node.type === 'error') return node.text
  if (node.type === 'frag') return (node.children || []).map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

function findClickable(node, needle, out = []) {
  if (!node || node.type === 'text' || node.type === 'error') return out
  if (node.type === 'frag') { (node.children || []).forEach((child) => findClickable(child, needle, out)); return out }
  if (typeof node.props.onClick === 'function' && textOf(node).includes(needle)) out.push(node)
  ;(node.children || []).forEach((child) => findClickable(child, needle, out))
  // 文本最短的优先：避免匹配到带 onClick 的祖先（如弹层遮罩），真实点击会命中最内层目标
  return out.sort((left, right) => textOf(left).length - textOf(right).length)
}

/** 找出嵌套 button（button 的后代里还有 button 即非法结构）。 */
function findNestedButtons(node, insideButton = false, out = []) {
  if (!node || node.type === 'text' || node.type === 'error') return out
  if (node.type === 'frag') {
    (node.children || []).forEach((child) => findNestedButtons(child, insideButton, out))
    return out
  }
  const isButton = node.type === 'button'
  if (isButton && insideButton) out.push(textOf(node).slice(0, 40))
  ;(node.children || []).forEach((child) => findNestedButtons(child, insideButton || isButton, out))
  return out
}

/** fixed 元素是否落在会创建包含块的祖先里（filter/backdrop-filter/transform/perspective/will-change）。 */
const CONTAINING_BLOCK_PROPS = ['backdropFilter', 'filter', 'transform', 'perspective', 'willChange']
function findTrappedFixed(node, containing = null, out = []) {
  if (!node || node.type === 'text' || node.type === 'error') return out
  if (node.type === 'frag') {
    (node.children || []).forEach((child) => findTrappedFixed(child, containing, out))
    return out
  }
  const style = (node.props && node.props.style) || {}
  if (style.position === 'fixed' && containing) out.push({ text: textOf(node).slice(0, 30), ancestor: containing })
  let nextContaining = containing
  for (const property of CONTAINING_BLOCK_PROPS) {
    const value = style[property]
    if (value && value !== 'none' && value !== 'auto' && value !== 'normal') {
      nextContaining = containing || `${node.type}.${property}=${value}`
    }
  }
  ;(node.children || []).forEach((child) => findTrappedFixed(child, nextContaining, out))
  return out
}

async function loadComponents() {
  const harness = createHarness()
  let spec = null
  globalThis.window = {
    location: { hash: '#/' },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
    __ModuleLoader__: { load(captured) { spec = captured } },
    localStorage: { getItem: () => null, setItem() {} },
  }
  globalThis.document = globalThis.window.document
  await import(pathToFileURL(path.join(ROOT, 'client.js')).href + `?audit=${Date.now()}`)
  const module = spec.factory((name) => {
    if (name === 'react') return harness.react
    throw new Error(`unexpected require ${name}`)
  })
  return { components: module.__test__.components, harness }
}

function stubApi() {
  return {
    dispatch: () => Promise.resolve({ ok: true, datasets: [], runs: [], figures: [], items: [] }),
    fileText: () => Promise.resolve('{}'),
    url: () => '',
  }
}

test('CSS 守卫：包裹层（.bf-panel）不得含 filter/backdrop-filter/transform 等 fixed 包含块属性', () => {
  const panelRules = [...SOURCE.matchAll(/\.bf-panel\{([^}]*)\}/g)].map((match) => match[1])
  assert.ok(panelRules.length >= 1, '应能找到 .bf-panel 规则')
  for (const rule of panelRules) {
    for (const property of ['backdrop-filter', 'filter:', 'transform:', 'perspective:', 'will-change']) {
      assert.ok(!rule.includes(property), `.bf-panel 不应包含 ${property}（会让内部 position:fixed 弹层被困在面板里）`)
    }
  }
  // 弹层实现必须用 viewport 级 fixed
  assert.ok(/position: 'fixed'/.test(SOURCE), 'Overlay 应使用 position: fixed')
  assert.ok(/zIndex: 9999/.test(SOURCE), 'Overlay 应在最高层')
  assert.ok(/Escape/.test(SOURCE), '弹层应支持 Esc 关闭')
})

test('CSS 守卫：整页允许上下滚动（不锁死一屏）', () => {
  const rootRule = (SOURCE.match(/\.bf-root\{([^}]*)\}/) || [])[1] || ''
  assert.ok(rootRule.includes('height:auto'), '.bf-root 应使用 height:auto，让页面按内容长高')
  assert.ok(!/height:100%/.test(rootRule), '.bf-root 不应锁 height:100%')
  assert.ok(/overflow-y:visible/.test(rootRule) || /overflow-y:auto/.test(rootRule), '.bf-root 应允许纵向滚动/溢出可见')
  const bodyRule = (SOURCE.match(/\.bf-body\{([^}]*)\}/) || [])[1] || ''
  assert.ok(!/overflow:hidden/.test(bodyRule), '.bf-body 不应 overflow:hidden（会裁掉内容并逼出内层滚动）')
  const workRule = (SOURCE.match(/\.bf-work\{([^}]*)\}/) || [])[1] || ''
  assert.ok(!/overflow-y:auto/.test(workRule), '.bf-work 不应自己滚动，交给整页滚动')
})

test('渲染树守卫：全页不存在嵌套 button，fixed 弹层不在包含块祖先里', async () => {
  const { components, harness } = await loadComponents()
  harness.resetCursor()
  const tree = expand(harness.react.createElement(components.WorkbenchBody, { api: stubApi(), onCopy() {} }))
  assert.notEqual(tree.type, 'error', 'WorkbenchBody 渲染不应抛错：' + (tree.text || ''))
  assert.deepEqual(findNestedButtons(tree), [], '不应出现 button 套 button（会导致点击与结构异常）')
  assert.deepEqual(findTrappedFixed(tree), [], 'position:fixed 弹层不应位于含 filter/backdrop-filter/transform 的祖先内')
})

test('交互冒烟：「论文 PDF / 图片」一按即开上传面板（含拖拽区/上传 PDF/上传图片）', async () => {
  const { components, harness } = await loadComponents()
  const composed = []
  const renderChat = () => {
    harness.resetCursor()
    return expand(harness.react.createElement(components.ChatColumn, {
      api: stubApi(), messages: [], text: '', onTextChange() {}, onSend() {}, asking: false,
      onCompose: (text) => composed.push(text), onNavigate() {}, draftLabel: '', runs: [], runsLoading: false,
      runsError: null, selectedRunId: '', onSelectRun() {}, onRefreshRuns() {}, onDeleteRun() {}, onOpenTrash() {}, onClear() {},
    }))
  }
  let tree = renderChat()
  const starter = findClickable(tree, '论文 PDF / 图片')[0]
  assert.ok(starter, '首屏应有「论文 PDF / 图片」入口')
  starter.props.onClick()
  tree = renderChat()
  assert.ok(findClickable(tree, '关闭')[0], '点击后应出现弹层（有关闭按钮）')
  const text = textOf(tree)
  assert.ok(text.includes('拖到这里'), '弹层应有拖拽区')
  assert.ok(text.includes('上传 PDF'), '弹层应有上传 PDF')
  assert.ok(text.includes('上传图片'), '弹层应有上传图片')
  assert.ok(text.includes('PMID') && text.includes('DOI'), '还应支持 PMID / DOI 输入')

  const presetTab = findClickable(tree, '常见图型')[0]
  assert.ok(presetTab, '应能切回常见图型')
  presetTab.props.onClick()
  tree = renderChat()
  const pick = findClickable(tree, '用这个图型')[0]
  assert.ok(pick, '常见图型应有「用这个图型」按钮')
  pick.props.onClick()
  assert.equal(composed.length, 1, '点「用这个图型」应把许愿文本填进输入框')
})
