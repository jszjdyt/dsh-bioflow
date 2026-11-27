/**
 * dsh-bioflow — 浏览器端 UI（Client 半边）
 *
 * 形态：window.__ModuleLoader__.load({ id: 'dsh-bioflow', factory(require) {...} })，
 * 只 require('react')，不碰任何 @deepseek-ai Client 包（宿主版本一变就会炸）。
 * 数据面：全部走同源相对路径 /bioflow/*（dispatch 单一入口 + status/health/catalog/files/figures）。
 *
 * 视觉：淡蓝/天蓝科研指挥台；令牌见 BIOFLOW_UI_SPEC.md §1，类名一律 bf- 前缀。
 *
 * 文件分两层：
 *   1) 纯函数层（factory 之前）：设计令牌、状态/证据/数据源元数据、格式化、路径与 URL、
 *      返回结构规范化、请求体拼装、fetch 客户端、整份 CSS 文本。不碰 DOM，
 *      node 里挂到 globalThis.__BF_TEST__ 供自检。
 *   2) 浏览器层（factory 内）：React 函数组件 + hooks + 槽注册。
 *
 * 三条硬约束（写代码时反复对照）：
 *   - 任何接口字段缺失都不得渲染 "undefined"：展示一律走 asText/displayValue；
 *   - 首屏只发 catalog + status + health 三个请求，其余懒加载；轮询 >=1.5s 且 document.hidden 暂停；
 *   - 颜色只用 --bf-* 令牌（在 .bf-root 上定义），不散落硬编码色值。
 */
;(function () {
  'use strict'

  var NS = 'dsh-bioflow'
  var API = '/bioflow'
  var PLUGIN_VERSION = '0.1.0'

  // ==========================================================================
  // 设计令牌（JS 侧镜像，供内联样式/测试用；CSS 里在 .bf-root 上重新定义）
  // ==========================================================================
  var TOKENS = {
    'bf-bg-0': '#F2FAFF',
    'bf-bg-1': '#E6F4FB',
    'bf-bg-2': '#FFFFFF',
    'bf-ink-0': '#0B1E2D',
    'bf-ink-1': '#14324A',
    'bf-ink-2': '#4A6B85',
    'bf-line': '#C9E4F5',
    'bf-line-glow': '#7DD3FC',
    'bf-accent': '#0EA5E9',
    'bf-accent-2': '#38BDF8',
    'bf-accent-3': '#7DD3FC',
    'bf-ok': '#0D9488',
    'bf-warn': '#D97706',
    'bf-err': '#DC2626',
    'bf-blocked': '#7C3AED',
  }

  var FONT_LADDER = [11, 12, 13, 15, 18, 24]

  // ==========================================================================
  // 元数据：五个数据源 / 闸门 / 状态 / 证据种类 / 尺度 / 计划字段
  // ==========================================================================

  /** 右栏检索 Tab；顺序与 SPEC §3.4 一致。 */
  var SOURCE_TABS = [
    { id: 'geo', label: 'GEO', expect: '<8s', hint: 'NCBI GEO 系列（GSE）' },
    { id: 'pubmed', label: 'PubMed', expect: '<8s', hint: 'NCBI PubMed 文献' },
    { id: 'gdc', label: 'GDC', expect: '<8s', hint: 'GDC / TCGA 项目、STAR counts、临床字段' },
    { id: 'metabolights', label: 'MetaboLights', expect: '5–10s', hint: 'EBI MetaboLights 代谢组研究' },
    { id: 'cellxgene', label: 'CELLxGENE', expect: '预计 30–60s', hint: 'CELLxGENE Discover（慢是常态，不是故障）' },
  ]

  /** 闸门 id → 人话标题；未知 id 原样显示，不丢信息。 */
  var GATE_LABELS = {
    dataset_registered: '数据集已登记',
    sample_table: '样本表可知',
    sample_identity: '样本身份唯一',
    groups: '分组可用',
    contrast: '对比方向明确',
    replication: '每组独立 n ≥ 2',
    design_confounded: '设计不完全混杂',
    counts_verified: '数据尺度已验证',
    assay_supported: 'assay 受支持',
    method_compatible: '统计方法与尺度兼容',
    prerequisites: '前置产物齐全',
  }

  /** step 状态元数据：label 中文，tone 决定徽章/圆点颜色。 */
  var STEP_STATUS_META = {
    pending: { label: '待核对', tone: 'muted' },
    pending_review: { label: '待核对', tone: 'warn' },
    queued: { label: '排队', tone: 'muted' },
    running: { label: '运行', tone: 'run' },
    ok: { label: '成功', tone: 'ok' },
    partial: { label: '部分完成', tone: 'warn' },
    failed: { label: '失败', tone: 'err' },
    cancelled: { label: '已取消', tone: 'muted' },
    blocked: { label: 'blocked', tone: 'blocked' },
    skipped: { label: '跳过', tone: 'muted' },
    unknown: { label: '未知', tone: 'muted' },
  }

  var STEP_STATUS_ALIASES = {
    pending: 'pending', pending_review: 'pending_review', queued: 'queued', running: 'running',
    ok: 'ok', success: 'ok', succeeded: 'ok', partial: 'partial',
    failed: 'failed', failure: 'failed', error: 'failed', cancelled: 'cancelled',
    canceled: 'cancelled', blocked: 'blocked', skipped: 'skipped',
  }

  /** run 级状态 → step 元数据复用（succeeded 映射到 ok 色系）。 */
  var RUN_STATUS_ALIASES = {
    queued: 'queued', running: 'running', pending_review: 'pending_review',
    succeeded: 'ok', success: 'ok', ok: 'ok', partial: 'partial',
    failed: 'failed', cancelled: 'cancelled', blocked: 'blocked', unknown: 'unknown',
  }

  var EVIDENCE_KIND_META = {
    measured: { label: '实测', tone: 'ok', note: '统计检验的实测结果' },
    descriptive: { label: '描述性', tone: 'muted', note: '描述性数值，不做推断' },
    model_prediction: { label: '模型预测', tone: 'blocked', note: '模型预测，不是实验结论', warn: true },
    unknown: { label: '未标注', tone: 'muted', note: '引擎未回传 evidence_kind' },
  }

  var SCALE_META = {
    counts: { label: '原始 counts', tone: 'info' },
    raw_counts: { label: '原始 counts', tone: 'info' },
    log_expression: { label: 'log 表达', tone: 'muted' },
    log2: { label: 'log2 表达', tone: 'muted' },
    tpm: { label: 'TPM', tone: 'muted' },
    fpkm: { label: 'FPKM', tone: 'muted' },
    microarray: { label: '芯片', tone: 'muted' },
    star_counts: { label: 'STAR counts', tone: 'info' },
    metabolomics_profile: { label: '代谢组', tone: 'muted' },
    unknown: { label: '尺度未知', tone: 'warn' },
  }

  /** 产物清单（default deliverables）——与 deliver.mjs 的交付文件一一对应。 */
  var DELIVERABLES = [
    { key: 'manifest', label: 'manifest.json' },
    { key: 'design', label: 'design.tsv' },
    { key: 'qc', label: 'qc.tsv' },
    { key: 'results', label: 'results/*.tsv' },
    { key: 'figures', label: 'figures/' },
    { key: 'evidence', label: 'evidence.jsonl' },
    { key: 'methods', label: 'methods.md' },
  ]

  /** 模板兜底（catalog 不可用时仍能选；真实候选来自 ask.templates/catalog）。 */
  var TEMPLATE_FALLBACK = [
    { id: 'bulk-two-group', title: 'GEO/Bulk 两组或配对差异 + 富集', description: '差异表达 / 富集 / 火山图' },
    { id: 'scrna-composition', title: 'scRNA-seq 样本级细胞组成 + 定向 pseudobulk', description: '细胞比例差异 / 组成检验' },
  ]

  /**
   * 计划卡字段（SPEC §3.2 要求逐条可改 + 每字段一句“为什么需要”）。
   * kind 决定控件：select / contrast / toggle / number / text / fdr / deliverables。
   */
  var PLAN_FIELDS = [
    {
      key: 'dataset', label: '数据源', kind: 'select',
      why: '必须先有已登记数据：从 GEO/GDC/MetaboLights 下载后登记，或直接登记本地矩阵 + 样本表。',
    },
    {
      key: 'template', label: '队列 / 分析类型', kind: 'select',
      why: '决定整条流水线：bulk 两组或配对差异 → bulk-two-group；单细胞样本级细胞组成 → scrna-composition。',
    },
    {
      key: 'contrast', label: '分组与对照', kind: 'contrast',
      why: '比较方向必须明确（logFC = case − control）；两组写反，结论就反了。',
    },
    {
      key: 'paired', label: '配对', kind: 'toggle',
      why: '同一供体既有病例又有对照时选配对；否则按独立样本处理，统计模型不同。',
    },
    {
      key: 'endpoint', label: '终点', kind: 'text',
      why: '生存/随访分析需要明确终点（OS/PFS）与时间、事件列；没有随访就留空。',
    },
    {
      key: 'scale', label: '尺度', kind: 'select',
      why: 'counts 与 log 表达的统计方法不同；未验证尺度的推断会被 counts_verified 闸门拦下。',
    },
    {
      key: 'min_cells', label: '最小细胞数', kind: 'number',
      why: '单细胞比例检验的最小细胞数（默认 10），直接影响分母与哪些细胞类型可检验。',
    },
    {
      key: 'fdr_family', label: 'FDR 家族', kind: 'fdr',
      why: '多重校正的检验族与阈值（默认 BH FDR 0.05），会写进 methods 与 evidence 的判定线。',
    },
    {
      key: 'covariates', label: '协变量', kind: 'text',
      why: '要校正的批次/性别/年龄等列；与分组完全共线会被 design_confounded 闸门拦下。',
    },
    {
      key: 'deliverables', label: '产物', kind: 'deliverables',
      why: '默认输出 manifest / design / qc / results / figures / evidence / methods 全套；勾选只影响右栏优先展示。',
    },
  ]

  /** token 覆盖字段：改这些字段后要用 ask 重新生成 draft（confirm_token 会变）。 */
  var TOKEN_FIELDS = ['dataset', 'template', 'contrast', 'paired', 'scale', 'min_cells', 'fdr_family', 'covariates']

  /** 图片扩展名：判断 figure 能否直接进 <img>。 */
  var IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg)$/i

  // ==========================================================================
  // 基础工具（全部防御式：null/undefined 不进入渲染）
  // ==========================================================================

  function isNil(value) {
    return value === null || value === undefined
  }

  function asArray(value) {
    if (Array.isArray(value)) return value
    if (isNil(value)) return []
    return [value]
  }

  function asNumber(value, fallback) {
    var num = Number(value)
    return Number.isFinite(num) ? num : (fallback === undefined ? null : fallback)
  }

  function asText(value, fallback) {
    if (typeof value === 'string') return value.trim() ? value : (fallback === undefined ? '—' : fallback)
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : (fallback === undefined ? '—' : fallback)
    if (typeof value === 'boolean') return value ? '是' : '否'
    if (isNil(value)) return fallback === undefined ? '—' : fallback
    try {
      var text = JSON.stringify(value)
      return text && text !== '{}' && text !== '[]' ? text : (fallback === undefined ? '—' : fallback)
    } catch (error) {
      return fallback === undefined ? '—' : fallback
    }
  }

  /** 对象 → 一行人话（对象/数组用 JSON，布尔用是/否）。 */
  function displayValue(value) {
    if (isNil(value)) return '—'
    if (typeof value === 'string') return value.trim() ? value : '—'
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—'
    if (typeof value === 'boolean') return value ? '是' : '否'
    if (Array.isArray(value)) {
      var items = value.map(displayValue).filter(function (item) { return item !== '—' })
      return items.length ? items.join('、') : '—'
    }
    if (typeof value === 'object') {
      if (value.case !== undefined || value.control !== undefined) {
        return asText(value.case, '?') + ' vs ' + asText(value.control, '?')
      }
      if (value.label !== undefined) return asText(value.label, '—')
      try {
        var text = JSON.stringify(value)
        return text && text !== '{}' ? text : '—'
      } catch (error) {
        return '—'
      }
    }
    return '—'
  }

  /** JSON.stringify 之前剔掉 undefined（递归），避免出现 "undefined"。 */
  /** 中文输入法选词时按 Enter 不应提交（isComposing / 229 都要挡）。 */
  function isImeComposing(event) {
    return Boolean(event && (event.isComposing === true || event.keyCode === 229 || event.which === 229))
  }

  function dropUndefined(value) {
    if (Array.isArray(value)) return value.map(dropUndefined)
    if (value && typeof value === 'object') {
      var out = {}
      Object.keys(value).forEach(function (key) {
        if (value[key] !== undefined) out[key] = dropUndefined(value[key])
      })
      return out
    }
    return value
  }

  function safeJson(value, indent) {
    if (isNil(value)) return 'null'
    try {
      var text = JSON.stringify(dropUndefined(value), function (key, item) {
        if (item === undefined) return undefined
        if (typeof item === 'function') return '[function]'
        return item
      }, indent === undefined ? 2 : indent)
      return isNil(text) ? String(value) : text
    } catch (error) {
      return String(value)
    }
  }

  function truncate(text, limit) {
    var value = String(text === null || text === undefined ? '' : text)
    if (!limit || value.length <= limit) return value
    return value.slice(0, Math.max(0, limit - 1)) + '…'
  }

  /** 尾部截断：stderr / 错误日志只显示最后 N 字符（前面省略并注明）。 */
  function tail(text, limit) {
    var value = String(text === null || text === undefined ? '' : text)
    if (!limit || value.length <= limit) return value
    return '…（省略前 ' + (value.length - limit) + ' 字符）\n' + value.slice(value.length - limit)
  }

  function unique(list) {
    var seen = {}
    var out = []
    asArray(list).forEach(function (item) {
      if (isNil(item)) return
      var key = typeof item === 'object' ? safeJson(item, 0) : String(item)
      if (seen[key]) return
      seen[key] = true
      out.push(item)
    })
    return out
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value)
  }

  function parseDate(value) {
    if (isNil(value) || value === '') return null
    var date = value instanceof Date ? value : new Date(typeof value === 'number' ? value : String(value))
    return Number.isNaN(date.getTime()) ? null : date
  }

  /** 本地时区时间（YYYY-MM-DD HH:mm:ss）；无法解析时原样返回，不显示 NaN。 */
  function formatLocalTime(value) {
    var date = parseDate(value)
    if (!date) return isNil(value) || value === '' ? '—' : String(value)
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' '
      + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
  }

  function formatClock(value) {
    var date = parseDate(value)
    if (!date) return '—'
    return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
  }

  /** 相对时间：刚刚 / n 分钟前 / n 小时前 / 本地日期时间。 */
  function formatRelative(value, nowMs) {
    var date = parseDate(value)
    if (!date) return isNil(value) || value === '' ? '—' : String(value)
    var now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
    var diff = Math.max(0, now - date.getTime())
    if (diff < 60 * 1000) return '刚刚'
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前'
    return formatClock(value)
  }

  /** 持续时间：ms → "1.2 s" / "3 分 05 秒"。 */
  function formatDuration(ms) {
    if (isNil(ms) || ms === '') return '—'
    var value = Number(ms)
    if (!Number.isFinite(value) || value < 0) return '—'
    if (value < 1000) return Math.round(value) + ' ms'
    if (value < 60000) {
      var seconds = value / 1000
      return (seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))) + ' s'
    }
    var minutes = Math.floor(value / 60000)
    var rest = Math.round((value % 60000) / 1000)
    if (minutes < 60) return minutes + ' 分 ' + pad2(rest) + ' 秒'
    var hours = Math.floor(minutes / 60)
    return hours + ' 小时 ' + (minutes % 60) + ' 分'
  }

  function formatNumber(value, digits) {
    if (isNil(value) || value === '') return '—'
    var num = Number(value)
    if (!Number.isFinite(num)) return '—'
    var precision = Number.isInteger(digits) ? digits : 0
    return num.toFixed(precision)
  }

  function formatP(value) {
    if (isNil(value) || value === '') return '—'
    var num = Number(value)
    if (!Number.isFinite(num)) return '—'
    if (num < 0.001) return num.toExponential(1)
    return num.toFixed(3)
  }

  function formatBytes(bytes) {
    if (isNil(bytes) || bytes === '') return '—'
    var num = Number(bytes)
    if (!Number.isFinite(num) || num < 0) return '—'
    if (num < 1024) return num + ' B'
    var units = ['KB', 'MB', 'GB', 'TB']
    var value = num / 1024
    var index = 0
    while (value >= 1024 && index < units.length - 1) {
      value = value / 1024
      index += 1
    }
    return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[index]
  }

  function sha8(sha) {
    var text = String(sha === null || sha === undefined ? '' : sha)
    return text ? text.slice(0, 8) : '—'
  }

  /** 长 id 折叠（run_id / plan_id 等），等宽字体下不撑破布局。 */
  function shortId(id, keep) {
    var text = String(id === null || id === undefined ? '' : id)
    if (!text) return '—'
    var limit = keep || 22
    if (text.length <= limit) return text
    return text.slice(0, limit - 6) + '…' + text.slice(-4)
  }

  function fileNameOf(filePath) {
    var text = String(filePath === null || filePath === undefined ? '' : filePath)
    if (!text) return '—'
    var parts = text.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || text
  }

  function basenameNoExt(name) {
    var file = fileNameOf(name)
    var index = file.lastIndexOf('.')
    return index > 0 ? file.slice(0, index) : file
  }

  function percent(done, total) {
    var a = Number(done)
    var b = Number(total)
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((a / b) * 100)))
  }

  function isEmptyValue(value) {
    if (isNil(value)) return true
    if (typeof value === 'string') return !value.trim()
    if (Array.isArray(value)) return value.length === 0
    if (typeof value === 'object') return Object.keys(value).length === 0
    return false
  }

  // ==========================================================================
  // 路径与 URL（绝对路径 → dataRoot 下相对路径 → /bioflow/files/*）
  // ==========================================================================

  function normalizeSlashes(value) {
    return String(value === null || value === undefined ? '' : value).replace(/\\/g, '/')
  }

  /** 后端返回的绝对路径 → dataRoot 下相对路径；找不到就退回 /runs/ 之后的部分。 */
  function runRelativePath(absPath, dataRoot) {
    var text = normalizeSlashes(absPath)
    if (!text) return ''
    var root = normalizeSlashes(dataRoot).replace(/\/+$/, '')
    if (root) {
      if (text === root) return ''
      if (text.indexOf(root + '/') === 0) return text.slice(root.length + 1)
    }
    var marker = text.indexOf('/runs/')
    if (marker >= 0) return text.slice(marker + 1)
    if (text.indexOf('runs/') === 0) return text
    if (text.indexOf('/datasets/') >= 0) return text.slice(text.indexOf('/datasets/') + 1)
    return ''
  }

  function encodePathSegments(relative) {
    return normalizeSlashes(relative)
      .split('/')
      .filter(function (part) { return Boolean(part) })
      .map(function (part) { return encodeURIComponent(part) })
      .join('/')
  }

  function filesUrl(relative) {
    var encoded = encodePathSegments(relative)
    return encoded ? API + '/files/' + encoded : ''
  }

  function figureAliasUrl(runId, fileName) {
    var id = String(runId === null || runId === undefined ? '' : runId)
    var name = String(fileName === null || fileName === undefined ? '' : fileName)
    if (!id || !name) return ''
    return API + '/figures/' + encodeURIComponent(id) + '/' + encodeURIComponent(name)
  }

  /**
   * figure → <img src>。优先走 /bioflow/figures/<run_id>/<file> 别名，
   * 同时给出 /bioflow/files/* 兜底（别名路由不可用时 onError 切换）。
   */
  function figureSources(figure, dataRoot, runId) {
    var raw = figure && (figure.file || figure.path || figure.relativePath || '')
    var relative = runRelativePath(raw, dataRoot)
    var name = relative ? fileNameOf(relative) : fileNameOf(raw)
    var alias = figureAliasUrl(runId, name)
    var fallback = relative ? filesUrl(relative) : ''
    var src = alias || fallback
    return { src: src, fallback: fallback && fallback !== src ? fallback : '', relative: relative, name: name }
  }

  function isImageFile(filePath) {
    return IMAGE_EXT_RE.test(fileNameOf(filePath))
  }

  // ==========================================================================
  // 状态 / 健康 / 证据元数据
  // ==========================================================================

  function normalizeStepStatus(raw) {
    var key = String(raw === null || raw === undefined ? '' : raw).toLowerCase()
    return STEP_STATUS_ALIASES[key] || 'unknown'
  }

  function stepStatusMeta(raw) {
    return STEP_STATUS_META[normalizeStepStatus(raw)] || STEP_STATUS_META.unknown
  }

  function runTone(raw) {
    var normalized = RUN_STATUS_ALIASES[String(raw === null || raw === undefined ? '' : raw).toLowerCase()] || 'unknown'
    return STEP_STATUS_META[normalized] ? STEP_STATUS_META[normalized].tone : 'muted'
  }

  function runStatusLabel(raw) {
    var normalized = RUN_STATUS_ALIASES[String(raw === null || raw === undefined ? '' : raw).toLowerCase()] || 'unknown'
    return STEP_STATUS_META[normalized] ? STEP_STATUS_META[normalized].label : '未知'
  }

  function isActiveStatus(raw) {
    var status = String(raw === null || raw === undefined ? '' : raw).toLowerCase()
    return status === 'queued' || status === 'running' || status === 'pending_review'
  }

  function isTerminalStatus(raw) {
    var status = String(raw === null || raw === undefined ? '' : raw).toLowerCase()
    return status === 'succeeded' || status === 'partial' || status === 'failed' || status === 'cancelled' || status === 'blocked'
  }

  /** 时间线进度：成功步数 / 总步数。 */
  function stepProgress(steps) {
    var list = asArray(steps)
    var done = 0
    var failed = 0
    list.forEach(function (step) {
      var status = normalizeStepStatus(step && step.status)
      if (status === 'ok') done += 1
      if (status === 'failed') failed += 1
    })
    return { total: list.length, done: done, failed: failed, pct: percent(done, list.length) }
  }

  function healthMeta(status) {
    var key = String(status === null || status === undefined ? '' : status).toLowerCase()
    if (key === 'ok' || key === 'up' || key === 'healthy') return { tone: 'ok', label: '可用' }
    if (key === 'slow' || key === 'warn' || key === 'degraded') return { tone: 'warn', label: '慢' }
    if (key === 'down' || key === 'fail' || key === 'failed' || key === 'error') return { tone: 'err', label: '失败' }
    return { tone: 'muted', label: '未知' }
  }

  /** 健康灯 hover 文案：状态 + 上次耗时 + 预期 + reason。 */
  function healthTitle(sourceId, entry) {
    var tab = findSourceTab(sourceId)
    var name = tab ? tab.label : asText(sourceId, '数据源')
    if (!entry) return name + '：尚未探活'
    var meta = healthMeta(entry.status)
    var parts = [name + '：' + meta.label]
    if (Number.isFinite(Number(entry.latencyMs))) parts.push('上次耗时 ' + formatNumber(entry.latencyMs) + ' ms')
    if (entry.expected) parts.push('预期 ' + entry.expected)
    else if (tab && tab.expect) parts.push('预期 ' + tab.expect)
    if (entry.reason) parts.push('原因：' + entry.reason)
    return parts.join(' · ')
  }

  function findSourceTab(sourceId) {
    var key = String(sourceId === null || sourceId === undefined ? '' : sourceId).toLowerCase()
    for (var index = 0; index < SOURCE_TABS.length; index += 1) {
      if (SOURCE_TABS[index].id === key) return SOURCE_TABS[index]
    }
    return null
  }

  function scaleMeta(scale) {
    var key = String(scale === null || scale === undefined ? '' : scale).toLowerCase()
    if (!key) return { label: '尺度未知', tone: 'muted' }
    return SCALE_META[key] || { label: String(scale), tone: 'muted' }
  }

  function evidenceKindMeta(kind) {
    var key = String(kind === null || kind === undefined ? '' : kind).toLowerCase()
    return EVIDENCE_KIND_META[key] || EVIDENCE_KIND_META.unknown
  }

  function gateTitle(id) {
    var key = String(id === null || id === undefined ? '' : id)
    return GATE_LABELS[key] || key || '未知闸门'
  }

  // ==========================================================================
  // 返回结构规范化（后端缺字段一律给安全默认；绝不把 undefined 传到渲染层）
  // ==========================================================================

  function normalizeContrast(value) {
    if (!value || typeof value !== 'object') return null
    var caseGroup = asText(value.case, '')
    var controlGroup = asText(value.control, '')
    if (!caseGroup && !controlGroup) return null
    return {
      case: caseGroup,
      control: controlGroup,
      direction: asText(value.direction, caseGroup && controlGroup ? 'case_minus_control' : ''),
      needsConfirm: Boolean(value.needs_confirm),
      contrastId: asText(value.contrast_id, ''),
    }
  }

  function normalizeCandidates(value) {
    var out = []
    asArray(value).forEach(function (candidate) {
      if (isNil(candidate)) return
      if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
        out.push({ value: candidate, label: displayValue(candidate), detail: '' })
        return
      }
      if (typeof candidate !== 'object') return
      var candidateValue = candidate.value
      if (candidateValue === undefined) candidateValue = candidate.id
      if (candidateValue === undefined) candidateValue = candidate.label
      if (candidateValue === undefined) return
      out.push({
        value: candidateValue,
        label: asText(candidate.label !== undefined ? candidate.label : candidate.name, displayValue(candidateValue)),
        detail: asText(candidate.detail || candidate.description, ''),
      })
    })
    return out
  }

  function normalizeGates(value) {
    var out = []
    asArray(value).forEach(function (gate) {
      if (!gate) return
      if (typeof gate === 'string') {
        out.push({ id: gate, title: gateTitle(gate), status: 'fail', detail: '', level: '' })
        return
      }
      if (typeof gate !== 'object') return
      var id = asText(gate.id || gate.gate || gate.name, '')
      out.push({
        id: id,
        title: gateTitle(id),
        status: asText(gate.status, 'unknown'),
        detail: asText(gate.detail || gate.message, ''),
        level: asText(gate.level, ''),
        missing: asArray(gate.missing).map(function (item) { return asText(item, '') }).filter(Boolean),
      })
    })
    return out
  }

  function normalizePlanSteps(value) {
    return asArray(value).map(function (step) {
      var item = step && typeof step === 'object' ? step : {}
      return {
        stepId: asText(item.step_id || item.id, ''),
        plugin: asText(item.plugin, ''),
        action: asText(item.action, ''),
        optional: Boolean(item.optional),
        deliver: asText(item.deliver, ''),
        params: item.params && typeof item.params === 'object' ? item.params : null,
        status: normalizeStepStatus(item.status),
      }
    }).filter(function (step) { return Boolean(step.stepId || step.plugin) })
  }

  function normalizePlanSummary(plan) {
    var source = plan && typeof plan === 'object' ? plan : {}
    var gates = normalizeGates(source.gates)
    var failedGates = gates.filter(function (gate) {
      var status = String(gate.status).toLowerCase()
      return status === 'fail' || status === 'failed' || status === 'blocked'
    })
    return {
      planId: asText(source.plan_id, ''),
      template: asText(source.template, ''),
      status: asText(source.status, ''),
      datasetId: asText(source.dataset_id, ''),
      contrast: normalizeContrast(source.contrast),
      gates: gates,
      failedGates: failedGates,
      blocking: normalizeGates(source.blocking),
      steps: normalizePlanSteps(source.steps),
      statsPreview: normalizeStatsContract(source.stats_preview),
    }
  }

  /** 自然语言许愿 / plan 的返回 → 计划卡数据。 */
  function normalizeAsk(payload) {
    var source = payload && typeof payload === 'object' ? payload : {}
    var plan = source.plan && typeof source.plan === 'object' ? source.plan : {}
    var fields = source.fields && typeof source.fields === 'object' ? source.fields : {}
    var rawCandidates = source.candidates && typeof source.candidates === 'object' ? source.candidates : {}
    var candidates = {}
    Object.keys(rawCandidates).forEach(function (key) {
      candidates[key] = normalizeCandidates(rawCandidates[key])
    })
    var questions = asArray(source.questions).map(function (question) {
      var item = question && typeof question === 'object' ? question : {}
      return {
        field: asText(item.field, ''),
        question: asText(item.question, ''),
        candidates: normalizeCandidates(item.candidates),
      }
    }).filter(function (question) { return Boolean(question.field || question.question) })
    var planId = asText(source.plan_id || plan.plan_id, '')
    var confirmToken = asText(source.confirm_token || plan.confirm_token, '')
    return {
      ok: source.ok !== false,
      planId: planId,
      confirmToken: confirmToken,
      statsPreview: normalizeStatsContract(source.stats_preview),
      template: asText(fields.template || plan.template, ''),
      datasetId: asText(fields.dataset || plan.dataset_id, ''),
      contrast: normalizeContrast(fields.contrast || plan.contrast),
      fields: fields,
      missing: asArray(source.missing_fields || plan.missing_fields || source.missing).map(function (item) { return String(item) }),
      candidates: candidates,
      questions: questions,
      warnings: asArray(source.warnings).map(function (item) { return asText(item, '') }).filter(Boolean),
      summary: asText(source.summary, ''),
      next: asText(source.next, ''),
      draftStatus: asText(source.draft_status || plan.draft_of_status, ''),
      planStatus: asText(plan.status, ''),
      gates: normalizeGates(plan.gates),
      blocking: normalizeGates(source.blocking || plan.blocking),
      steps: normalizePlanSteps(plan.steps),
      llmUsed: Boolean(source.llm_used),
      rulesMatched: asArray(source.rules_matched).map(function (item) { return asText(item, '') }).filter(Boolean),
      limitations: asArray(plan.limitations || source.limitations).map(function (item) { return asText(item, '') }).filter(Boolean),
      datasetOptions: asArray(source.dataset_options),
      onlineCandidates: asArray(source.online_candidates),
      accessionUnregistered: asText(source.accession_unregistered, ''),
      ready: Boolean(planId && confirmToken),
      raw: source,
    }
  }

  /** 单字段「原始值」（fields / edit 共用的取值口径）。 */
  function fieldValueOf(key, fields) {
    var source = fields && typeof fields === 'object' ? fields : {}
    if (key === 'dataset') return source.dataset
    if (key === 'template') return source.template
    if (key === 'contrast') return source.contrast
    if (key === 'paired') return source.paired
    if (key === 'endpoint') return source.endpoint
    if (key === 'scale') return source.scale
    if (key === 'min_cells') return source.min_cells
    if (key === 'fdr_family') return source.fdr_family
    if (key === 'covariates') return source.covariates
    if (key === 'deliverables') return source.deliverables
    return source[key]
  }

  /** 单字段展示文案（contrast/paired/deliverables 走专用格式）。 */
  function fieldDisplay(key, value) {
    if (key === 'contrast') {
      var contrast = normalizeContrast(value)
      return contrast ? (contrast.case || '?') + ' vs ' + (contrast.control || '?') : '待定'
    }
    if (key === 'paired') return value === true ? '配对' : value === false ? '独立样本' : (isNil(value) ? '待定' : displayValue(value))
    if (key === 'min_cells') return isNil(value) || value === '' ? '默认 10' : displayValue(value)
    if (key === 'deliverables') {
      var list = asArray(value).map(function (item) { return asText(item, '') }).filter(Boolean)
      if (!list.length) return '全套（默认）'
      var labels = DELIVERABLES.filter(function (item) { return list.indexOf(item.key) >= 0 }).map(function (item) { return item.label })
      return labels.length ? labels.join('、') : list.join('、')
    }
    if (key === 'covariates') {
      var covariates = asArray(value).map(function (item) { return asText(item, '') }).filter(Boolean)
      return covariates.length ? covariates.join('、') : '无'
    }
    return displayValue(value)
  }

  /** 计划卡字段行：合并 ask 返回 + 用户本地编辑（edit 优先）。 */
  function planFieldRows(draft, edits) {
    var data = draft && typeof draft === 'object' ? draft : {}
    var fields = data.fields && typeof data.fields === 'object' ? data.fields : {}
    var localEdits = edits && typeof edits === 'object' ? edits : {}
    var missing = asArray(data.missing).map(function (item) { return String(item) })
    // 关键字段即便后端没列进 missing_fields，空值也按缺失处理（SPEC §3.2 琥珀色高亮）
    var requiredKeys = ['dataset', 'template', 'contrast', 'scale']
    return PLAN_FIELDS.map(function (definition) {
      var edited = Object.prototype.hasOwnProperty.call(localEdits, definition.key)
      var value = edited ? localEdits[definition.key] : fieldValueOf(definition.key, fields)
      var question = ''
      asArray(data.questions).some(function (item) {
        if (item && item.field === definition.key && item.question) {
          question = item.question
          return true
        }
        return false
      })
      var candidates = (data.candidates && data.candidates[definition.key]) || []
      if (!candidates.length && question === '' && definition.key === 'template') {
        candidates = TEMPLATE_FALLBACK.map(function (item) {
          return { value: item.id, label: item.title, detail: item.description }
        })
      }
      return {
        key: definition.key,
        label: definition.label,
        why: definition.why,
        kind: definition.kind,
        value: value,
        display: fieldDisplay(definition.key, value),
        missing: missing.indexOf(definition.key) >= 0
          || (requiredKeys.indexOf(definition.key) >= 0 && isEmptyValue(value) && !edited),
        edited: edited,
        empty: isEmptyValue(value),
        candidates: candidates,
        question: question,
      }
    })
  }

  /** 对比候选里出现的分组名（编辑用下拉候选）。 */
  function contrastGroupOptions(row) {
    var groups = []
    asArray(row && row.candidates).forEach(function (candidate) {
      var value = candidate && candidate.value
      if (value && typeof value === 'object') {
        if (value.case) groups.push(String(value.case))
        if (value.control) groups.push(String(value.control))
      } else if (typeof value === 'string') {
        groups.push(value)
      }
    })
    var current = normalizeContrast(row && row.value)
    if (current) {
      if (current.case) groups.push(current.case)
      if (current.control) groups.push(current.control)
    }
    return unique(groups)
  }

  /** "BH 0.05" ↔ {method, alpha}。 */
  function parseFdrFamily(value) {
    var fallback = { method: 'BH', alpha: 0.05 }
    if (!value) return fallback
    if (typeof value === 'object') {
      return {
        method: asText(value.method, fallback.method),
        alpha: asNumber(value.alpha, fallback.alpha),
      }
    }
    var text = String(value)
    var methodMatch = text.match(/(BH|BY|bonferroni|none|holm)/i)
    var alphaMatch = text.match(/([0-9]*\.?[0-9]+)/)
    return {
      method: methodMatch ? methodMatch[1].toUpperCase() : fallback.method,
      alpha: alphaMatch ? Number(alphaMatch[1]) : fallback.alpha,
    }
  }

  /** 表单 edit → ask 请求体覆盖字段。 */
  function buildAskOverrides(edit) {
    var source = edit && typeof edit === 'object' ? edit : {}
    var overrides = {}
    if (typeof source.dataset === 'string' && source.dataset.trim()) overrides.dataset = source.dataset.trim()
    if (typeof source.template === 'string' && source.template.trim()) overrides.template = source.template.trim()
    if (source.contrast && typeof source.contrast === 'object') {
      var caseGroup = asText(source.contrast.case, '')
      var controlGroup = asText(source.contrast.control, '')
      if (caseGroup) overrides.case = caseGroup
      if (controlGroup) overrides.control = controlGroup
    }
    if (typeof source.paired === 'boolean') overrides.paired = source.paired
    if (typeof source.scale === 'string' && source.scale.trim()) overrides.scale = source.scale.trim()
    if (source.min_cells !== undefined && source.min_cells !== null && source.min_cells !== '') {
      var minCells = asNumber(source.min_cells, null)
      if (minCells !== null) overrides.min_cells = minCells
    }
    if (source.fdr_family !== undefined && source.fdr_family !== null) {
      overrides.fdr = typeof source.fdr_family === 'object' ? source.fdr_family : parseFdrFamily(source.fdr_family)
    }
    if (Array.isArray(source.covariates)) {
      overrides.covariates = source.covariates.map(function (item) { return String(item) }).filter(Boolean)
    } else if (typeof source.covariates === 'string') {
      overrides.covariates = source.covariates.split(/[,，\s]+/).map(function (item) { return item.trim() }).filter(Boolean)
    }
    return overrides
  }

  /**
   * ask 请求体。need 是许愿原文；feedback 会拼进 need（让 agent 再想想）；
   * 计划卡上的编辑通过显式字段覆盖（与 opAsk 的入参一致）。
   */
  function buildAskBody(options) {
    var opts = options && typeof options === 'object' ? options : {}
    var text = String(opts.text === null || opts.text === undefined ? '' : opts.text).trim()
    var feedback = String(opts.feedback === null || opts.feedback === undefined ? '' : opts.feedback).trim()
    var endpointValue = opts.endpoint !== undefined ? opts.endpoint : (opts.edit ? opts.edit.endpoint : undefined)
    var endpoint = isNil(endpointValue) ? '' : String(endpointValue).trim()
    var need = text
    if (endpoint) need = need ? need + '；终点=' + endpoint : '终点=' + endpoint
    if (feedback) need = need ? need + '\n补充要求：' + feedback : '补充要求：' + feedback
    var overrides = buildAskOverrides(opts.edit)
    var body = {
      action: 'ask',
      need: need,
      text: need,
    }
    if (opts.dataset) body.dataset = String(opts.dataset)
    Object.keys(overrides).forEach(function (key) { body[key] = overrides[key] })
    return dropUndefined(body)
  }

  /** submit 请求体：必须带 plan_id + confirm_token + confirmed（SPEC §3.2）。 */
  function buildSubmitBody(draft) {
    var data = draft && typeof draft === 'object' ? draft : {}
    return dropUndefined({
      action: 'submit',
      plan_id: data.planId,
      confirm_token: data.confirmToken,
      confirmed: true,
      start: true,
    })
  }

  function buildSearchBody(options) {
    var opts = options && typeof options === 'object' ? options : {}
    return dropUndefined({
      action: 'search',
      term: String(opts.term === null || opts.term === undefined ? '' : opts.term).trim(),
      sources: [String(opts.source || 'geo')],
      limit: asNumber(opts.limit, 20),
    })
  }

  function buildDownloadBody(options) {
    var opts = options && typeof options === 'object' ? options : {}
    return dropUndefined({
      action: 'download',
      source: String(opts.source || ''),
      id: String(opts.id || ''),
      dest_dir: opts.destDir ? String(opts.destDir) : undefined,
    })
  }

  function buildRunStatusBody(runId) {
    return dropUndefined({ action: 'run_status', run_id: runId ? String(runId) : undefined })
  }

  function buildHealthBody(sources) {
    var list = asArray(sources).map(function (item) { return String(item) }).filter(Boolean)
    return dropUndefined({ action: 'health', sources: list.length ? list : undefined })
  }

  /** catalog 返回（约定 {ok, version, actions, templates, sources, data_root}）。 */
  function normalizeCatalog(payload) {
    var source = payload && typeof payload === 'object' ? payload : {}
    var templates = asArray(source.templates).map(function (template) {
      if (typeof template === 'string') {
        var fallback = TEMPLATE_FALLBACK.filter(function (item) { return item.id === template })[0]
        return { id: template, title: fallback ? fallback.title : template, description: fallback ? fallback.description : '' }
      }
      var item = template && typeof template === 'object' ? template : {}
      return {
        id: asText(item.id || item.template, ''),
        title: asText(item.title || item.label, asText(item.id, '模板')),
        description: asText(item.description, ''),
      }
    }).filter(function (template) { return Boolean(template.id) })
    var sources = asArray(source.sources).map(function (entry) {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object') return asText(entry.source || entry.id, '')
      return ''
    }).filter(Boolean)
    var plugins = asArray(source.plugins).map(function (entry) {
      var item = entry && typeof entry === 'object' ? entry : {}
      return {
        plugin: asText(item.plugin || item.id, ''),
        package: asText(item.package, ''),
        label: asText(item.label || item.name, asText(item.plugin || item.id, '')),
        available: Boolean(item.available),
        error: asText(item.error, ''),
      }
    }).filter(function (item) { return Boolean(item.plugin) })
    var gates = asArray(source.gates).map(function (entry) {
      if (typeof entry === 'string') return { id: entry, title: gateTitle(entry), description: '' }
      var item = entry && typeof entry === 'object' ? entry : {}
      var id = asText(item.id || item.gate, '')
      return { id: id, title: asText(item.title, gateTitle(id)), description: asText(item.description || item.detail || item.blocks, '') }
    }).filter(function (gate) { return Boolean(gate.id) })
    return {
      ok: source.ok !== false,
      version: asText(source.version, PLUGIN_VERSION),
      actions: asArray(source.actions).map(function (item) { return asText(item, '') }).filter(Boolean),
      templates: templates.length ? templates : TEMPLATE_FALLBACK.slice(),
      sources: sources.length ? sources : SOURCE_TABS.map(function (tab) { return tab.id }),
      plugins: plugins,
      gates: gates,
      dataRoot: asText(source.data_root || source.dataRoot, ''),
      raw: source,
    }
  }

  /** status 返回（只取 UI 需要的字段）。 */
  function normalizeStatus(payload) {
    var source = payload && typeof payload === 'object' ? payload : {}
    var runsByStatus = source.runs_by_status && typeof source.runs_by_status === 'object' ? source.runs_by_status : {}
    var plugins = asArray(source.plugins).map(function (plugin) {
      var item = plugin && typeof plugin === 'object' ? plugin : {}
      return {
        plugin: asText(item.plugin, ''),
        label: asText(item.label || item.package, asText(item.plugin, '')),
        available: Boolean(item.available),
        error: asText(item.error, ''),
      }
    })
    return {
      ok: source.ok !== false,
      version: asText(source.version, PLUGIN_VERSION),
      dataRoot: asText(source.data_root, ''),
      storeKind: asText(source.store_kind, ''),
      storeFile: asText(source.store_file, ''),
      storeWarnings: asArray(source.store_warnings).map(function (item) { return asText(item, '') }).filter(Boolean),
      datasets: asNumber(source.datasets, 0),
      plans: asNumber(source.plans, 0),
      searches: asNumber(source.searches, 0),
      runs: asNumber(source.runs, 0),
      runsByStatus: runsByStatus,
      plugins: plugins,
      sources: asArray(source.sources).map(function (entry) {
        var item = entry && typeof entry === 'object' ? entry : {}
        return {
          source: asText(item.source, ''),
          label: asText(item.label, ''),
          expected: asText(item.expected_time, ''),
        }
      }),
      tabs: asArray(source.tabs).map(function (item) { return asText(item, '') }).filter(Boolean),
      summary: asText(source.summary, ''),
      suggest: asText(source.suggest, ''),
      raw: source,
    }
  }

  /** health 返回 → {sources: {id: {status, latencyMs, reason, expected}}}。 */
  function normalizeHealth(payload) {
    var source = payload && typeof payload === 'object' ? payload : {}
    var rawSources = source.sources && typeof source.sources === 'object' ? source.sources : {}
    var normalized = {}
    Object.keys(rawSources).forEach(function (key) {
      var item = rawSources[key] && typeof rawSources[key] === 'object' ? rawSources[key] : {}
      normalized[key] = {
        source: asText(item.source || key, key),
        status: asText(item.status, 'unknown'),
        latencyMs: asNumber(item.latency_ms, null),
        reason: asText(item.reason, ''),
        expected: asText(item.expected, ''),
        cached: Boolean(item.cached),
      }
    })
    return {
      ok: source.ok !== false,
      sources: normalized,
      plugins: asArray(source.plugins).map(function (plugin) {
        var item = plugin && typeof plugin === 'object' ? plugin : {}
        return { plugin: asText(item.plugin, ''), available: Boolean(item.available), error: asText(item.error, '') }
      }),
      summary: asText(source.summary, ''),
      checkedAt: Date.now(),
    }
  }

  function normalizeRunRow(run) {
    var item = run && typeof run === 'object' ? run : {}
    return {
      runId: asText(item.run_id, ''),
      status: asText(item.status, 'unknown'),
      template: asText(item.template, ''),
      datasetId: asText(item.dataset_id, ''),
      createdAt: asText(item.created_at, ''),
      finishedAt: asText(item.finished_at, ''),
      error: asText(item.error, ''),
      zeroSignificant: typeof item.zero_significant === 'boolean' ? item.zero_significant : null,
      warnings: asArray(item.warnings).map(function (warning) { return asText(warning, '') }).filter(Boolean),
    }
  }

  function normalizeRuns(payload) {
    var source = payload && typeof payload === 'object' ? payload : {}
    return {
      ok: source.ok !== false,
      runs: asArray(source.runs).map(normalizeRunRow).filter(function (run) { return Boolean(run.runId) }),
      summary: asText(source.summary, ''),
    }
  }

  function normalizeStep(step) {
    var item = step && typeof step === 'object' ? step : {}
    var startedAt = asText(item.started_at, '')
    var finishedAt = asText(item.finished_at, '')
    var duration = asNumber(item.duration_ms, null)
    if (duration === null && startedAt && finishedAt) {
      var startDate = parseDate(startedAt)
      var endDate = parseDate(finishedAt)
      if (startDate && endDate) duration = Math.max(0, endDate.getTime() - startDate.getTime())
    }
    return {
      stepId: asText(item.step_id || item.id, ''),
      plugin: asText(item.plugin, ''),
      action: asText(item.action, ''),
      status: normalizeStepStatus(item.status),
      rawStatus: asText(item.status, 'unknown'),
      attempts: asNumber(item.attempts, 0),
      startedAt: startedAt,
      finishedAt: finishedAt,
      durationMs: duration,
      error: asText(item.error, ''),
      deliver: asText(item.deliver, ''),
      params: item.params && typeof item.params === 'object' ? item.params : null,
      stderr: asText(item.stderr || item.log_tail || item.logTail, ''),
    }
  }

  function normalizeTable(table) {
    var item = table && typeof table === 'object' ? table : {}
    return {
      tableId: asText(item.table_id || item.id, ''),
      title: asText(item.title, ''),
      rows: asNumber(item.rows, null),
      evidenceKind: asText(item.evidence_kind, ''),
      file: asText(item.file, ''),
    }
  }

  function normalizeFigure(figure) {
    var item = figure && typeof figure === 'object' ? figure : {}
    return {
      figureId: asText(item.figure_id || item.id, ''),
      title: asText(item.title, ''),
      kind: asText(item.kind, ''),
      dpi: asNumber(item.dpi, null),
      file: asText(item.file, ''),
      sourceTableIds: asArray(item.source_table_ids).map(function (id) { return asText(id, '') }).filter(Boolean),
      n: asNumber(item.n, null),
      denominator: asNumber(item.denominator !== undefined ? item.denominator : item.total, null),
      direction: asText(item.direction || item.comparison_direction, ''),
      evidenceKind: asText(item.evidence_kind, ''),
    }
  }

  /** run_status 返回 → 时间线 / 产物 / 证据共用模型。 */
  function normalizeRunStatus(payload) {
    var source = payload && typeof payload === 'object' ? payload : {}
    var run = source.run && typeof source.run === 'object' ? source.run : source
    var plan = normalizePlanSummary(run.plan || source.plan)
    var steps = asArray(run.steps || source.steps).map(normalizeStep)
    var status = asText(run.status || source.status, 'unknown')
    var blockedGates = plan.failedGates.slice()
    if (!blockedGates.length && run.blocked && typeof run.blocked === 'object') {
      blockedGates = normalizeGates(run.blocked.gates)
    }
    return {
      runId: asText(run.run_id || source.run_id, ''),
      status: status,
      tone: runTone(status),
      steps: steps,
      tables: asArray(run.tables || source.tables).map(normalizeTable),
      figures: asArray(run.figures || source.figures).map(normalizeFigure),
      plan: plan,
      next: asText(run.next || source.next, ''),
      summary: asText(source.summary || run.summary, ''),
      warnings: asArray(run.warnings).map(function (item) { return asText(item, '') }).filter(Boolean),
      error: asText(run.error, ''),
      zeroSignificant: typeof run.zero_significant === 'boolean' ? run.zero_significant : null,
      manifestSha: asText(run.manifest_sha256, ''),
      runDir: asText(run.run_dir, ''),
      artifacts: asArray(run.artifacts).map(function (artifact) {
        var item = artifact && typeof artifact === 'object' ? artifact : {}
        return {
          artifactId: asText(item.artifact_id || item.sha256, ''),
          kind: asText(item.kind, ''),
          path: asText(item.path, ''),
          sha256: asText(item.sha256, ''),
          bytes: asNumber(item.bytes, null),
        }
      }),
      blockedGates: blockedGates,
      statsContract: normalizeStatsContract(run.stats_contract || source.stats_contract),
      progress: stepProgress(steps),      blockedGates: blockedGates,
      progress: stepProgress(steps),
      updatedAtIso: asText(run.updated_at || run.created_at, ''),
      updatedAt: Date.now(),
      raw: source,
    }
  }


  /** run.stats_contract → UI 模型（缺失字段一律 null，绝不编默认值）。 */
  function normalizeStatsContract(value) {
    var source = value && typeof value === 'object' ? value : null
    if (!source) return null
    var contrast = source.contrast && typeof source.contrast === 'object' ? source.contrast : {}
    var design = source.design && typeof source.design === 'object' ? source.design : {}
    var inference = source.inference && typeof source.inference === 'object' ? source.inference : {}
    var fdr = inference.fdr && typeof inference.fdr === 'object' ? inference.fdr : {}
    var data = source.data && typeof source.data === 'object' ? source.data : {}
    var evidence = source.evidence && typeof source.evidence === 'object' ? source.evidence : {}
    var identity = source.identity && typeof source.identity === 'object' ? source.identity : {}
    var environment = source.environment && typeof source.environment === 'object' ? source.environment : {}
    return {
      schema: asText(source.schema, ''),
      runId: asText(source.run_id, ''),
      template: asText(source.template, ''),
      status: asText(source.status, ''),
      okToCite: source.ok_to_cite === true,
      contrast: {
        caseName: asText(contrast.case, ''),
        control: asText(contrast.control, ''),
        direction: asText(contrast.direction, ''),
        effectConvention: asText(contrast.effect_convention, ''),
      },
      design: {
        nSamples: asNumber(design.n_samples, null),
        nDonors: asNumber(design.n_donors, null),
        minGroupN: asNumber(design.min_group_n, null),
        paired: design.paired === true,
        pairColumn: asText(design.pair_column, ''),
        groupColumn: asText(design.group_column, ''),
        donorColumn: asText(design.donor_column, ''),
        covariates: asArray(design.covariates).map(function (item) { return asText(item, '') }).filter(Boolean),
        formula: asText(design.formula, ''),
        groups: asArray(design.groups).map(function (group) {
          var item = group && typeof group === 'object' ? group : {}
          return { name: asText(item.name, ''), nSamples: asNumber(item.n_samples, null), nDonors: asNumber(item.n_donors, null) }
        }),
      },
      inference: {
        tests: asArray(inference.tests).map(function (test) {
          var item = test && typeof test === 'object' ? test : {}
          return { stepId: asText(item.step_id, ''), plugin: asText(item.plugin, ''), method: asText(item.method, '') }
        }).filter(function (test) { return Boolean(test.method) }),
        fdr: {
          method: asText(fdr.method, ''),
          alpha: asNumber(fdr.alpha, null),
          nTests: asNumber(fdr.n_tests, null),
        },
        minReplicateNote: asText(inference.min_replicate_note, ''),
      },
      data: {
        datasetId: asText(data.dataset_id, ''),
        revision: asText(data.revision, ''),
        name: asText(data.name, ''),
        assay: asText(data.assay, ''),
        species: asText(data.species, ''),
        scale: asText(data.scale, ''),
        scaleVerified: data.scale_verified === true,
        nFiles: asNumber(data.n_files, null),
        hasClinical: data.has_clinical === true,
      },
      evidence: {
        nClaims: asNumber(evidence.n_claims, null),
        alpha: asNumber(evidence.alpha, null),
        zeroSignificant: evidence.zero_significant === true,
        kinds: evidence.kinds && typeof evidence.kinds === 'object' ? evidence.kinds : {},
      },
      identity: {
        contentHash: asText(identity.content_hash, ''),
        manifestSha: asText(identity.manifest_sha256, ''),
        runDir: asText(identity.run_dir, ''),
        seed: asNumber(identity.seed, null),
      },
      environment: {
        bioflowVersion: asText(environment.bioflow_version, ''),
        node: asText(environment.node, ''),
        platform: asText(environment.platform, ''),
        plugins: environment.plugins && typeof environment.plugins === 'object' ? environment.plugins : {},
      },
      reproduce: asArray(source.reproduce).map(function (item) { return asText(item, '') }).filter(Boolean),
      caveats: asArray(source.caveats).map(function (item) {
        var entry = item && typeof item === 'object' ? item : {}
        return { code: asText(entry.code, ''), level: asText(entry.level, 'info'), text: asText(entry.text, '') }
      }).filter(function (item) { return Boolean(item.text) }),
    }
  }
  function normalizeSearchItem(item) {
    var source = item && typeof item === 'object' ? item : {}
    return {
      source: asText(source.source, ''),
      id: asText(source.id, ''),
      title: asText(source.title, ''),
      summary: asText(source.summary || source.abstract, ''),
      species: asText(source.species, ''),
      nSamples: asNumber(source.n_samples, null),
      platform: asText(source.platform, ''),
      scale: asText(source.scale, ''),
      genome: asText(source.genome, ''),
      studyType: asText(source.study_type, ''),
      journal: asText(source.journal, ''),
      year: asNumber(source.year, null),
      doi: asText(source.doi, ''),
      authors: asText(source.authors, ''),
      openAccess: Boolean(source.open_access),
      attachments: asArray(source.attachments).map(function (entry) {
        var file = entry && typeof entry === 'object' ? entry : {}
        return { name: asText(file.name, ''), type: asText(file.type, ''), bytes: asNumber(file.bytes || file.size, null) }
      }),
      clinicalAvailable: Boolean(source.clinical_available),
      evidenceStrength: asText(source.evidence_strength, ''),
      url: asText(source.url, ''),
    }
  }

  /** search 返回 → 按源分组的条目 + 每源成败。 */
  function normalizeSearch(payload, requestedSource) {
    var source = payload && typeof payload === 'object' ? payload : {}
    var itemsRaw = source.items
    var grouped = {}
    if (Array.isArray(itemsRaw)) {
      var single = requestedSource || asText(source.source, 'unknown')
      grouped[single] = itemsRaw
    } else if (itemsRaw && typeof itemsRaw === 'object') {
      Object.keys(itemsRaw).forEach(function (key) { grouped[key] = asArray(itemsRaw[key]) })
    }
    var items = {}
    Object.keys(grouped).forEach(function (key) {
      items[key] = grouped[key].map(function (raw) {
        var item = normalizeSearchItem(raw)
        // 记录可能不回传 source，用分组 key 补齐（否则「加入下载」拿不到 source）
        if (!item.source) item.source = key
        return item
      }).filter(function (item) { return Boolean(item.id) })
    })
    var bySource = source.by_source && typeof source.by_source === 'object' ? source.by_source : {}
    var bySourceRows = {}
    Object.keys(bySource).forEach(function (key) {
      var row = bySource[key] && typeof bySource[key] === 'object' ? bySource[key] : {}
      bySourceRows[key] = {
        total: asNumber(row.total, null),
        fetched: asNumber(row.fetched, null),
        via: asText(row.via, ''),
        cached: Boolean(row.cached),
        slow: Boolean(row.slow),
        elapsedMs: asNumber(row.elapsed_ms, null),
        error: asText(row.error, ''),
      }
    })
    var failed = asArray(source.sources_failed).map(function (entry) {
      var item = entry && typeof entry === 'object' ? entry : {}
      return {
        source: asText(item.source, ''),
        reason: asText(item.reason, ''),
        code: asText(item.code, ''),
      }
    }).filter(function (item) { return Boolean(item.source) })
    if (!failed.length) {
      // 兼容只回传 by_source[source].error 的实现
      Object.keys(bySourceRows).forEach(function (key) {
        if (bySourceRows[key].error) failed.push({ source: key, reason: bySourceRows[key].error, code: 'source_error' })
      })
    }
    return {
      ok: source.ok !== false,
      searchId: asText(source.search_id, ''),
      query: asText(source.query, ''),
      items: items,
      bySource: bySourceRows,
      sourcesOk: asArray(source.sources_ok).map(function (entry) {
        if (typeof entry === 'string') return { source: entry, reason: '' }
        var item = entry && typeof entry === 'object' ? entry : {}
        return { source: asText(item.source, ''), reason: asText(item.reason, '') }
      }),
      sourcesFailed: failed,
      warnings: asArray(source.warnings).map(function (item) { return asText(item, '') }).filter(Boolean),
      summary: asText(source.summary, ''),
      next: asText(source.next, ''),
    }
  }

  function searchItemsFor(search, sourceId) {
    var data = search && typeof search === 'object' ? search : {}
    var items = data.items && typeof data.items === 'object' ? data.items : {}
    return asArray(items[String(sourceId || '')])
  }

  /** download 返回 → 下载队列行。 */
  function downloadRows(payload, request) {
    var source = payload && typeof payload === 'object' ? payload : {}
    var req = request && typeof request === 'object' ? request : {}
    var sourceId = asText(source.source || req.source, '')
    var recordId = asText(source.id || req.id, '')
    var reusedAll = Boolean(source.reused)
    return asArray(source.downloads).map(function (download, index) {
      var item = download && typeof download === 'object' ? download : {}
      var sha = asText(item.sha256, '')
      var name = asText(item.name, fileNameOf(item.path))
      if (name === '—') name = 'file-' + (index + 1)
      return {
        key: sourceId + '|' + recordId + '|' + name + '|' + sha8(sha),
        name: name,
        sourceId: sourceId,
        recordId: recordId,
        source: sourceId + '/' + recordId,
        bytes: asNumber(item.bytes, null),
        sha8: sha ? sha.slice(0, 8) : '—',
        sha256: sha,
        reused: Boolean(item.reused) || reusedAll,
        path: asText(item.path, ''),
        status: 'done',
        progress: 1,
        error: '',
      }
    })
  }

  function mergeDownloadRow(rows, row) {
    var list = asArray(rows).slice()
    var found = false
    for (var index = 0; index < list.length; index += 1) {
      if (list[index] && row && list[index].key === row.key) {
        list[index] = Object.assign({}, list[index], row)
        found = true
        break
      }
    }
    if (!found && row) list.unshift(row)
    return list
  }

  /** evidence 返回 → 证据列表 + 计数。 */
  function normalizeEvidence(payload) {
    var source = payload && typeof payload === 'object' ? payload : {}
    var records = asArray(source.records).map(function (record) {
      var item = record && typeof record === 'object' ? record : {}
      return {
        claimId: asText(item.claim_id, ''),
        evidenceKind: asText(item.evidence_kind, ''),
        claim: asText(item.claim, ''),
        runId: asText(item.run_id, ''),
        tableId: asText(item.table_id, ''),
        rowId: asNumber(item.row_id, null),
        figureId: asText(item.figure_id, ''),
        stepId: asText(item.step_id, ''),
        feature: asText(item.feature, ''),
        effect: asNumber(item.effect, null),
        p: asNumber(item.p, null),
        q: asNumber(item.q, null),
        n: asNumber(item.n, null),
        significant: typeof item.significant === 'boolean' ? item.significant : null,
        sourceTableIds: asArray(item.source_table_ids).map(function (id) { return asText(id, '') }).filter(Boolean),
      }
    }).filter(function (record) { return Boolean(record.claim || record.claimId) })
    var counts = source.counts && typeof source.counts === 'object' ? source.counts : {}
    return {
      ok: source.ok !== false,
      runId: asText(source.run_id, ''),
      file: asText(source.file, ''),
      records: records,
      total: asNumber(source.total, records.length),
      truncated: Boolean(source.truncated),
      counts: {
        measured: asNumber(counts.measured, 0),
        descriptive: asNumber(counts.descriptive, 0),
        model_prediction: asNumber(counts.model_prediction, 0),
      },
      zeroSignificant: typeof source.zero_significant === 'boolean' ? source.zero_significant : null,
      summary: asText(source.summary, ''),
    }
  }

  function filterEvidence(records, kind) {
    var list = asArray(records)
    if (!kind || kind === 'all') return list
    return list.filter(function (record) { return record && record.evidenceKind === kind })
  }

  /** 图中用于展示的 n / 分母 / 对比方向（缺字段一律显示 —，绝不伪造）。 */
  function figureMetaCells(figure, runStatus) {
    var item = figure && typeof figure === 'object' ? figure : {}
    var run = runStatus && typeof runStatus === 'object' ? runStatus : {}
    var contrast = run.plan && run.plan.contrast ? run.plan.contrast : null
    var direction = item.direction
    if (!direction && contrast) {
      direction = (contrast.case || '?') + ' → ' + (contrast.control || '?') + '（case − control）'
    }
    return [
      { key: 'figure_id', label: 'figure_id', value: asText(item.figureId, '—') },
      { key: 'n', label: 'n', value: isNil(item.n) ? '—' : formatNumber(item.n) },
      { key: 'denominator', label: '分母', value: isNil(item.denominator) ? '—' : formatNumber(item.denominator) },
      { key: 'direction', label: '对比方向', value: direction || '—' },
      { key: 'dpi', label: 'dpi', value: isNil(item.dpi) ? '—' : formatNumber(item.dpi) },
      { key: 'source', label: '来源表', value: item.sourceTableIds && item.sourceTableIds.length ? item.sourceTableIds.join('、') : '—' },
    ]
  }

  /** 解析 TSV 文本 → 表格预览（限制行/列，超长提示）。 */
  function parseTsvPreview(text, maxRows, maxCols) {
    var limitRows = maxRows || 40
    var limitCols = maxCols || 12
    var lines = String(text === null || text === undefined ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(function (line, index) {
      return line.length > 0 || index === 0
    })
    if (!lines.length) return { header: [], rows: [], totalRows: 0, truncatedRows: false, truncatedCols: false }
    var delimiter = '\t'
    if (lines[0].indexOf('\t') < 0 && lines[0].indexOf(',') >= 0) delimiter = ','
    var header = lines[0].split(delimiter)
    var truncatedCols = header.length > limitCols
    if (truncatedCols) header = header.slice(0, limitCols)
    var bodyRows = lines.slice(1)
    var truncatedRows = bodyRows.length > limitRows
    var rows = bodyRows.slice(0, limitRows).map(function (line) {
      var cells = line.split(delimiter)
      if (cells.length > limitCols) cells = cells.slice(0, limitCols)
      return cells
    })
    return {
      header: header,
      rows: rows,
      totalRows: bodyRows.length,
      truncatedRows: truncatedRows,
      truncatedCols: truncatedCols,
    }
  }

  // ==========================================================================
  // API 客户端（注入 fetch 便于自检；错误统一成 {code, message, details}）
  // ==========================================================================

  function apiError(code, message, details) {
    return { isApiError: true, code: code || 'error', message: String(message || '请求失败'), details: isNil(details) ? null : details }
  }

  function createApi(options) {
    var opts = options && typeof options === 'object' ? options : {}
    var base = opts.baseUrl || API
    var fetchImpl = opts.fetchImpl
    if (!fetchImpl && typeof fetch !== 'undefined') {
      fetchImpl = fetch.bind(typeof window !== 'undefined' && window ? window : globalThis)
    }

    function request(pathname, init) {
      if (typeof fetchImpl !== 'function') return Promise.reject(apiError('no_fetch', '当前环境没有 fetch'))
      var settings = Object.assign({
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
      }, init || {})
      return fetchImpl(base + pathname, settings).then(function (response) {
        var contentType = (response.headers && response.headers.get && response.headers.get('content-type')) || ''
        var isJson = contentType.indexOf('application/json') >= 0
        var bodyPromise = isJson
          ? response.json().catch(function () { return null })
          : response.text().then(function (text) { return { rawText: text } })
        return bodyPromise.then(function (body) {
          if (!response.ok) {
            var message = body && (body.message || body.error) ? (body.message || body.error) : (body && body.rawText ? String(body.rawText).slice(0, 2000) : 'HTTP ' + response.status)
            var details = body && typeof body === 'object' ? { status: response.status, body: body } : { status: response.status }
            if (body && body.details !== undefined) details.details = body.details
            throw apiError(body && body.error ? String(body.error) : 'http_' + response.status, message, details)
          }
          return body
        })
      }).catch(function (caught) {
        if (caught && caught.isApiError) throw caught
        var aborted = Boolean(caught && (caught.name === 'AbortError' || caught.code === 'ABORT_ERR'))
        throw apiError(aborted ? 'aborted' : 'network', String(caught && caught.message ? caught.message : caught), { aborted: aborted })
      })
    }

    return {
      base: base,
      request: request,
      dispatch: function (body, options) {
        var extra = options && typeof options === 'object' ? options : {}
        return request('/dispatch', Object.assign({
          method: 'POST',
          body: JSON.stringify(dropUndefined(body || {})),
        }, extra))
      },
      catalog: function () { return request('/catalog') },
      status: function () { return request('/status') },
      health: function (sources) {
        var list = asArray(sources).map(function (item) { return String(item) }).filter(Boolean)
        return request('/health' + (list.length ? '?sources=' + encodeURIComponent(list.join(',')) : ''))
      },
      fileText: function (relative) {
        var url = filesUrl(relative)
        if (!url) return Promise.reject(apiError('bad_path', '文件路径为空'))
        return request(url.slice(API.length)).then(function (body) {
          if (body && typeof body === 'object' && body.rawText !== undefined) return body.rawText
          return typeof body === 'string' ? body : safeJson(body)
        })
      },
      fileUrl: function (relative) { return filesUrl(relative) },
      figureUrl: function (runId, fileName) { return figureAliasUrl(runId, fileName) },
    }
  }

  // ==========================================================================
  // 样式表（.bf- 前缀；颜色只用 --bf-* 令牌，圆角/字号阶梯按 SPEC §1）
  // ==========================================================================
  var CSS_LINES = [
    /* 令牌 / 根 */
    '.bf-root{--bf-bg-0:#F1F9FF;--bf-bg-1:#E8F5FE;--bf-bg-2:#FFFFFF;--bf-ink-0:#071A29;--bf-ink-1:#10304A;--bf-ink-2:#527191;--bf-line:#CFE6F6;--bf-line-glow:#6FD3FC;--bf-accent:#0DA5EA;--bf-accent-2:#38BDF8;--bf-accent-3:#8ADCFD;--bf-ok:#0E9488;--bf-warn:#C9790A;--bf-err:#DC2626;--bf-blocked:#6D4AE0;--bf-glass:rgba(255,255,255,.82);--bf-shadow:0 1px 0 #FFFFFF inset,0 22px 48px -34px rgba(8,60,96,.42);--bf-glow:0 0 0 1px color-mix(in srgb,var(--bf-line-glow) 60%,transparent),0 0 26px -8px rgba(14,165,233,.55);--bf-radius:18px;--bf-mono:ui-monospace,"SF Mono",Menlo,monospace;--bf-sans:-apple-system,"PingFang SC","Helvetica Neue",sans-serif;position:relative;display:flex;flex-direction:column;height:auto;min-height:100vh;overflow-x:hidden;overflow-y:visible;background:radial-gradient(1200px 620px at 14% -12%,#D9F2FF 0%,rgba(217,242,255,0) 62%),radial-gradient(900px 520px at 102% -4%,#E7F8FF 0%,rgba(231,248,255,0) 58%),radial-gradient(700px 480px at 52% 108%,#EAF7FF 0%,rgba(234,247,255,0) 60%),linear-gradient(180deg,#F8FDFF 0%,#EEF8FE 100%);color:var(--bf-ink-1);font-family:var(--bf-sans);font-size:13px;line-height:1.55;-webkit-font-smoothing:antialiased}',
    '.bf-root *,.bf-root *::before,.bf-root *::after{box-sizing:border-box}',
    '.bf-root button,.bf-root input,.bf-root textarea,.bf-root select{font-family:inherit;font-size:inherit;line-height:1.5;color:inherit}',
    '.bf-root button{cursor:pointer}',
    '.bf-root :focus-visible{outline:2px solid var(--bf-line-glow);outline-offset:2px;border-radius:6px}',
    '.bf-root ::selection{background:color-mix(in srgb,var(--bf-accent) 26%,transparent)}',
    '.bf-root ::-webkit-scrollbar{width:8px;height:8px}',
    '.bf-root ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--bf-line-glow) 62%,var(--bf-line));border-radius:8px}',
    '.bf-root ::-webkit-scrollbar-track{background:transparent}',
    '.bf-mono{font-family:var(--bf-mono);font-variant-numeric:tabular-nums;letter-spacing:.02em}',
    /* 顶栏（深空底状态条） */
    '.bf-top{display:flex;flex-wrap:wrap;align-items:center;gap:10px;flex:none;padding:11px 16px;background:linear-gradient(180deg,#071A29 0%,#0B2437 100%);color:var(--bf-bg-1);border-bottom:1px solid color-mix(in srgb,var(--bf-line-glow) 55%,transparent);box-shadow:0 18px 36px -28px rgba(8,60,96,.9)}',
    '.bf-brand{display:flex;align-items:center;gap:9px;min-width:0}',
    '.bf-mark{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:none;border-radius:11px;border:1px solid color-mix(in srgb,var(--bf-accent-3) 55%,transparent);background:radial-gradient(circle at 30% 20%,rgba(125,211,252,.55),rgba(14,165,233,.18) 60%,rgba(7,26,41,.9));color:#EAF9FF;box-shadow:0 0 18px -4px rgba(56,189,248,.85)}',
    '.bf-title-block{display:flex;flex-direction:column;min-width:0}',
    '.bf-title{font-size:15px;font-weight:600;letter-spacing:.06em;white-space:nowrap;background:linear-gradient(92deg,#F2FBFF 0%,#9BE4FF 55%,#7DD3FC 100%);-webkit-background-clip:text;background-clip:text;color:transparent}',
    '.bf-subtitle{font-size:11px;color:color-mix(in srgb,var(--bf-bg-1) 72%,var(--bf-ink-2));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:44vw}',
    '.bf-top-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
    '.bf-top-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}',
    '.bf-sep{width:1px;height:16px;flex:none;background:color-mix(in srgb,var(--bf-line-glow) 40%,transparent)}',
    /* 状态胶囊 */
    '.bf-capsule{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--bf-accent-3) 45%,transparent);background:color-mix(in srgb,var(--bf-accent) 12%,transparent);color:var(--bf-bg-1);font-size:11px;white-space:nowrap}',
    '.bf-capsule b{font-weight:600}',
    '.bf-capsule .bf-mono{color:var(--bf-accent-3)}',
    '.bf-capsule-ok{border-color:color-mix(in srgb,var(--bf-ok) 62%,transparent);background:color-mix(in srgb,var(--bf-ok) 18%,transparent)}',
    '.bf-capsule-warn{border-color:color-mix(in srgb,var(--bf-warn) 70%,transparent);background:color-mix(in srgb,var(--bf-warn) 18%,transparent)}',
    '.bf-capsule-err{border-color:color-mix(in srgb,var(--bf-err) 70%,transparent);background:color-mix(in srgb,var(--bf-err) 18%,transparent)}',
    '.bf-capsule-blocked{border-color:color-mix(in srgb,var(--bf-blocked) 70%,transparent);background:color-mix(in srgb,var(--bf-blocked) 20%,transparent)}',
    '.bf-capsule-run{border-color:color-mix(in srgb,var(--bf-accent-2) 72%,transparent);background:color-mix(in srgb,var(--bf-accent) 22%,transparent)}',
    '.bf-dot{width:6px;height:6px;border-radius:50%;flex:none;background:currentColor;box-shadow:0 0 0 2px color-mix(in srgb,currentColor 22%,transparent)}',
    /* 健康灯（浅色药丸，蓝底上保证对比度） */
    '.bf-lamps{display:flex;align-items:center;gap:2px;flex-wrap:wrap;padding:3px 6px;border-radius:999px;background:color-mix(in srgb,var(--bf-bg-2) 95%,transparent);border:1px solid color-mix(in srgb,var(--bf-line-glow) 40%,transparent)}',
    '.bf-lamp{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;padding:2px 4px;border-radius:6px;font-size:11px;color:var(--bf-ink-2);white-space:nowrap}',
    '.bf-lamp:hover{background:color-mix(in srgb,var(--bf-accent-3) 22%,transparent)}',
    '.bf-lamp-dot{width:7px;height:7px;border-radius:50%;flex:none;background:currentColor;box-shadow:0 0 6px currentColor}',
    '.bf-env{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:46vw}',
    '.bf-env-path{font-family:var(--bf-mono);font-size:11px;color:var(--bf-accent-3);border:1px solid color-mix(in srgb,var(--bf-accent-3) 32%,transparent);border-radius:6px;padding:3px 7px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:color-mix(in srgb,var(--bf-bg-2) 8%,transparent)}',
    '.bf-env-path:hover{border-color:var(--bf-line-glow);background:color-mix(in srgb,var(--bf-accent-3) 20%,transparent)}',
    '.bf-env-meta{font-size:11px;color:color-mix(in srgb,var(--bf-bg-1) 66%,var(--bf-ink-2));white-space:nowrap}',
    /* 布局 */
    '.bf-body{flex:0 0 auto;display:grid;grid-template-columns:minmax(0,0.92fr) minmax(0,1.08fr);align-items:start;gap:14px;padding:14px;overflow:visible}',
    '.bf-side,.bf-main,.bf-right{min-width:0;min-height:0}',
    '.bf-side{display:flex;flex-direction:column;gap:12px;overflow:visible}.bf-side .bf-panel{min-height:0;flex:0 0 auto}',
    '.bf-main{display:flex;flex-direction:column;gap:12px;overflow-y:auto;padding-right:2px}',
    '.bf-right{display:flex;flex-direction:column;gap:12px;overflow-y:auto;padding-right:2px}',
    /* 面板：1px 发光顶线 + 8×8 网格底纹（SPEC §1 科幻感三件事之二） */
    '.bf-panel{position:relative;display:flex;flex-direction:column;min-height:0;border:1px solid var(--bf-line);border-radius:var(--bf-radius);background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(255,255,255,.9));box-shadow:var(--bf-shadow);overflow:hidden}',
    '.bf-panel::before{content:"";position:absolute;left:18px;right:18px;top:0;height:1px;background:linear-gradient(90deg,transparent,var(--bf-accent-3) 22%,var(--bf-accent-2) 50%,var(--bf-accent-3) 78%,transparent);opacity:.9;pointer-events:none}',
    '.bf-panel-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none;padding:11px 14px 9px;border-bottom:1px solid color-mix(in srgb,var(--bf-line) 70%,transparent);background:linear-gradient(180deg,rgba(255,255,255,.7),rgba(255,255,255,0))}',
    '.bf-panel-title{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;letter-spacing:.06em;color:var(--bf-ink-1)}',
    '.bf-panel-sub{font-size:11px;color:var(--bf-ink-2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.bf-panel-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}',
    '.bf-panel-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px}',
    '.bf-panel-body-flat{padding:0;gap:0}',
    '.bf-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
    '.bf-row-tight{gap:5px}',
    '.bf-col{display:flex;flex-direction:column;gap:6px;min-width:0}',
    '.bf-spacer{flex:1 1 auto}',
    '.bf-divider{height:1px;flex:none;background:var(--bf-line)}',
    '.bf-muted{font-size:11px;color:var(--bf-ink-2)}',
    '.bf-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
    '.bf-break{word-break:break-word;overflow-wrap:anywhere}',
    /* 按钮 */
    '.bf-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:0 12px;border-radius:10px;border:1px solid var(--bf-line);background:var(--bf-bg-2);color:var(--bf-ink-1);font-size:12px;font-weight:600;white-space:nowrap;transition:border-color .14s,background-color .14s,box-shadow .14s}',
    '.bf-btn:hover:not([disabled]){border-color:var(--bf-line-glow);box-shadow:0 0 12px -6px color-mix(in srgb,var(--bf-accent) 70%,transparent)}',
    '.bf-btn[disabled]{opacity:.5;cursor:not-allowed}',
    '.bf-btn-primary{background:var(--bf-accent);border-color:var(--bf-accent);color:var(--bf-ink-0)}',
    '.bf-btn-primary:hover:not([disabled]){background:var(--bf-accent-2);border-color:var(--bf-accent-2)}',
    '.bf-btn-ghost{background:transparent}',
    '.bf-btn-sm{min-height:24px;padding:0 9px;font-size:11px}',
    '.bf-btn-icon{width:28px;min-height:28px;padding:0}',
    '.bf-btn-danger{border-color:color-mix(in srgb,var(--bf-err) 45%,var(--bf-line));color:var(--bf-err)}',
    '.bf-top .bf-btn{background:transparent;border-color:color-mix(in srgb,var(--bf-accent-3) 42%,transparent);color:var(--bf-bg-1)}',
    '.bf-top .bf-btn:hover:not([disabled]){border-color:var(--bf-line-glow);box-shadow:0 0 12px -4px color-mix(in srgb,var(--bf-accent-2) 80%,transparent)}',
    /* 徽章 / 标签 */
    '.bf-badge{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:6px;border:1px solid var(--bf-line);background:var(--bf-bg-1);color:var(--bf-ink-1);font-size:11px;font-weight:600;white-space:nowrap}',
    '.bf-badge-ok{border-color:color-mix(in srgb,var(--bf-ok) 42%,var(--bf-line));background:color-mix(in srgb,var(--bf-ok) 10%,var(--bf-bg-2))}',
    '.bf-badge-warn{border-color:color-mix(in srgb,var(--bf-warn) 52%,var(--bf-line));background:color-mix(in srgb,var(--bf-warn) 9%,var(--bf-bg-2))}',
    '.bf-badge-err{border-color:color-mix(in srgb,var(--bf-err) 45%,var(--bf-line));background:color-mix(in srgb,var(--bf-err) 8%,var(--bf-bg-2))}',
    '.bf-badge-blocked{border-color:color-mix(in srgb,var(--bf-blocked) 45%,var(--bf-line));background:color-mix(in srgb,var(--bf-blocked) 8%,var(--bf-bg-2))}',
    '.bf-badge-run{border-color:color-mix(in srgb,var(--bf-accent) 50%,var(--bf-line));background:color-mix(in srgb,var(--bf-accent) 10%,var(--bf-bg-2))}',
    '.bf-badge-mono{font-family:var(--bf-mono);font-weight:400}',
    '.bf-tone-ok{color:var(--bf-ok)}',
    '.bf-tone-warn{color:var(--bf-warn)}',
    '.bf-tone-err{color:var(--bf-err)}',
    '.bf-tone-blocked{color:var(--bf-blocked)}',
    '.bf-tone-run{color:var(--bf-accent)}',
    '.bf-tone-muted{color:var(--bf-ink-2)}',
    '.bf-tag{border:1px solid var(--bf-line);border-radius:6px;background:var(--bf-bg-1);padding:0 5px;font-size:11px;color:var(--bf-ink-1);white-space:nowrap}',
    /* 输入 */
    '.bf-input,.bf-select{width:100%;min-height:30px;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-2);padding:4px 8px;font-size:12px;color:var(--bf-ink-1)}',
    '.bf-input-sm{min-height:26px;font-size:11px}',
    '.bf-input:focus,.bf-select:focus,.bf-textarea:focus{border-color:var(--bf-line-glow);outline:none}',
    '.bf-textarea{width:100%;min-height:76px;max-height:180px;resize:vertical;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-0);padding:8px 10px;font-size:12px;color:var(--bf-ink-1)}',
    '.bf-textarea::placeholder{color:color-mix(in srgb,var(--bf-ink-2) 78%,transparent)}',
    '.bf-field-error{border-color:var(--bf-warn)}',
    '.bf-kbd{font-family:var(--bf-mono);font-size:11px;border:1px solid var(--bf-line);border-bottom-width:2px;border-radius:6px;padding:0 4px;background:var(--bf-bg-1);color:var(--bf-ink-1)}',
    /* 左栏：对话 / 许愿 */
    '.bf-feed{flex:0 1 auto;min-height:120px;max-height:44vh;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:14px}',
    '.bf-msg{display:flex;flex-direction:column;gap:4px;max-width:94%;min-width:0}',
    '.bf-msg-role{font-size:10px;font-weight:600;color:var(--bf-ink-2);letter-spacing:.14em;text-transform:uppercase;padding:0 4px}',
    '.bf-msg-text{font-size:12.5px;color:var(--bf-ink-1);white-space:pre-wrap;word-break:break-word;line-height:1.6;border-radius:15px}',
    '.bf-msg-user{align-self:flex-end;align-items:flex-end}.bf-msg-user .bf-msg-text{background:linear-gradient(135deg,#0EA5E9,#38BDF8);color:#04222F;border:1px solid color-mix(in srgb,var(--bf-accent) 65%,transparent);border-bottom-right-radius:5px;padding:9px 13px;box-shadow:0 12px 24px -18px rgba(14,165,233,.9)}',
    '.bf-msg-agent{align-self:flex-start}.bf-msg-agent .bf-msg-text{background:rgba(255,255,255,.94);border:1px solid var(--bf-line);border-bottom-left-radius:5px;padding:9px 13px;box-shadow:0 1px 0 #FFFFFF inset,0 14px 26px -26px rgba(8,60,96,.55)}',
    '.bf-msg-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--bf-ink-2)}',
    '.bf-composer{flex:none;display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;background:linear-gradient(180deg,rgba(255,255,255,0),rgba(255,255,255,.6))}',
    '.bf-wish{position:relative;display:flex;flex-direction:column;gap:4px;padding:10px 12px 8px;border:1px solid var(--bf-line);border-radius:16px;background:linear-gradient(180deg,#FFFFFF,rgba(246,252,255,.96));box-shadow:0 1px 0 #FFFFFF inset,0 16px 32px -28px rgba(8,60,96,.55);transition:border-color .16s ease,box-shadow .16s ease}.bf-wish:focus-within{border-color:var(--bf-line-glow);box-shadow:var(--bf-glow),0 1px 0 #FFFFFF inset}',
    '.bf-wish-input{width:100%;min-height:46px;max-height:170px;resize:none;border:0;outline:none;background:transparent;padding:2px 0;font-size:13px;line-height:1.6;color:var(--bf-ink-1);font-family:var(--bf-sans)}.bf-wish-input::placeholder{color:color-mix(in srgb,var(--bf-ink-2) 72%,transparent)}.bf-wish-bar{display:flex;align-items:center;gap:8px;min-height:34px}.bf-send{width:34px;height:34px;flex:none;border-radius:12px;border:0;background:linear-gradient(135deg,var(--bf-accent-2),var(--bf-accent));color:#FFFFFF;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 10px 20px -10px rgba(14,165,233,.85);transition:transform .12s ease,box-shadow .12s ease}.bf-send:hover:not([disabled]){transform:translateY(-1px);box-shadow:0 14px 24px -12px rgba(14,165,233,.95)}.bf-send[disabled]{opacity:.42;box-shadow:none;cursor:not-allowed}.bf-chips{display:flex;gap:6px;flex-wrap:wrap}.bf-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--bf-line);background:rgba(255,255,255,.72);color:var(--bf-ink-1);font-size:11px;white-space:nowrap;transition:border-color .14s ease,background-color .14s ease,box-shadow .14s ease}.bf-chip:hover{border-color:var(--bf-line-glow);background:#FFFFFF;box-shadow:0 0 0 3px color-mix(in srgb,var(--bf-accent-3) 22%,transparent)}.bf-composer-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.bf-composer-hint{font-size:11px;color:var(--bf-ink-2);line-height:1.4}',
    '.bf-work{display:flex;flex-direction:column;gap:12px;min-height:0;overflow:visible;padding-right:2px}',
    '.bf-stack{display:flex;flex-direction:column;gap:10px;min-height:0}',
    '.bf-progress{position:relative;flex:none;display:flex;flex-direction:column;gap:8px;padding:2px 2px 9px;border:0;border-bottom:1px solid color-mix(in srgb,var(--bf-line) 80%,transparent);border-radius:0;background:transparent;box-shadow:none}',

    '.bf-progress-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:26px}',
    '.bf-progress-title{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:var(--bf-ink-1)}',
    '.bf-progress-idle-hint{font-size:11px;color:var(--bf-ink-2)}',
    '.bf-inline-stats{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}',
    '.bf-stat{display:inline-flex;align-items:baseline;gap:4px;font-size:11px;color:var(--bf-ink-2)}',
    '.bf-stat-label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--bf-ink-2);opacity:.85}',
    '.bf-stat b{font-size:13px;font-weight:600;color:var(--bf-ink-1);font-variant-numeric:tabular-nums}',
    '.bf-progress-actions-label{font-size:11px;color:var(--bf-ink-2)}',
    '.bf-progress-pct{font-size:11px;color:var(--bf-ink-2);letter-spacing:.06em}',
    '.bf-progress-bar{position:relative;height:4px;border-radius:999px;background:color-mix(in srgb,var(--bf-bg-1) 88%,var(--bf-line));overflow:hidden}',
    '.bf-progress-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--bf-accent-3),var(--bf-accent));box-shadow:0 0 12px -2px color-mix(in srgb,var(--bf-accent) 80%,transparent);transition:width .4s ease}',
    '.bf-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}',
    '.bf-kpi{display:flex;flex-direction:column;gap:1px;padding:7px 9px;border:1px solid color-mix(in srgb,var(--bf-line) 78%,transparent);border-radius:12px;background:rgba(255,255,255,.7);min-width:0}',
    '.bf-kpi-label{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--bf-ink-2)}',
    '.bf-kpi b{font-size:16px;font-weight:600;color:var(--bf-ink-1);font-variant-numeric:tabular-nums}',
    '.bf-kpi-sub{font-size:10px;color:var(--bf-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bf-pipe{flex:none;display:flex;align-items:flex-start;gap:0;overflow-x:auto;padding:2px 2px 4px}',
    '.bf-pipe-node{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:64px;flex:1 1 0}',
    '.bf-pipe-rail{display:flex;align-items:center;width:100%;justify-content:center}',
    '.bf-pipe-line{flex:1 1 auto;height:2px;background:color-mix(in srgb,var(--bf-line) 80%,transparent);min-width:8px}',
    '.bf-pipe-line-in{margin-right:-1px}.bf-pipe-line-out{margin-left:-1px}',
    '.bf-pipe-dot{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none;border-radius:50%;border:1px solid color-mix(in srgb,var(--bf-line) 90%,transparent);background:#FFFFFF;font-size:10px;font-weight:600;color:var(--bf-ink-2)}',
    '.bf-pipe-dot.bf-tone-ok{border-color:color-mix(in srgb,var(--bf-ok) 60%,transparent);background:color-mix(in srgb,var(--bf-ok) 14%,#FFFFFF);color:var(--bf-ok)}',
    '.bf-pipe-dot.bf-tone-err{border-color:color-mix(in srgb,var(--bf-err) 60%,transparent);background:color-mix(in srgb,var(--bf-err) 12%,#FFFFFF);color:var(--bf-err)}',
    '.bf-pipe-dot.bf-tone-run{border-color:color-mix(in srgb,var(--bf-accent) 70%,transparent);background:color-mix(in srgb,var(--bf-accent) 16%,#FFFFFF);color:var(--bf-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--bf-accent-3) 26%,transparent)}',
    '.bf-pipe-dot.bf-tone-muted{opacity:.55}',
    '.bf-pipe-label{font-size:10px;color:var(--bf-ink-2);max-width:100%;text-align:center;line-height:1.25}',
    '.bf-tabbar{display:flex;gap:6px;padding:2px;flex:none}',
    '.bf-tab{height:28px;padding:0 12px;border-radius:999px;border:1px solid var(--bf-line);background:rgba(255,255,255,.7);font-size:11.5px;font-weight:600;color:var(--bf-ink-2);transition:all .14s ease}',
    '.bf-tab:hover{color:var(--bf-ink-1);border-color:var(--bf-line-glow)}',
    '.bf-tab-on{color:#04222F;border-color:transparent;background:linear-gradient(135deg,var(--bf-accent-2),var(--bf-accent));box-shadow:0 8px 18px -12px rgba(14,165,233,.85)}',
    '.bf-wishdeck{flex:none}',
    '.bf-wishdeck-body{padding:10px 12px 12px;gap:9px;overflow:visible}',
    '.bf-progress-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.bf-outdir{max-width:260px;min-height:26px;font-size:11px}',
    '.bf-inline-error{margin-top:8px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--bf-err) 45%,var(--bf-line));border-radius:10px;background:color-mix(in srgb,var(--bf-err) 7%,#FFFFFF);color:var(--bf-err);font-size:11.5px}',
    '.bf-logic{display:flex;flex-direction:column;gap:12px;padding:14px;min-height:0;overflow-y:auto}',
    '.bf-logic-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.bf-logic-title{display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.bf-logic-status{font-size:11px;color:var(--bf-ok)}',
    '.bf-logic-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
    '.bf-logic-card{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--bf-line);border-radius:var(--bf-radius);background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(246,252,255,.9));box-shadow:var(--bf-shadow)}',
    '.bf-logic-card-head{display:flex;align-items:center;gap:8px}',
    '.bf-logic-step{font-size:11px;color:var(--bf-accent);letter-spacing:.14em}',
    '.bf-logic-card-title{font-size:13px;font-weight:600;color:var(--bf-ink-1)}',
    '.bf-logic-count{margin-left:auto;font-size:10px;color:var(--bf-ink-2)}',
    '.bf-logic-hint{margin:0;font-size:11px;color:var(--bf-ink-2);line-height:1.5}',
    '.bf-logic-input{width:100%;min-height:120px;resize:vertical;border:1px solid var(--bf-line);border-radius:12px;background:#FFFFFF;padding:9px 11px;font-size:12.5px;line-height:1.6;color:var(--bf-ink-1);outline:none}',
    '.bf-logic-input:focus{border-color:var(--bf-line-glow);box-shadow:var(--bf-glow)}',
    '.bf-logic-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.bf-clinical-grid{display:grid;grid-template-columns:minmax(0,0.95fr) minmax(0,1.05fr);gap:12px}',
    '.bf-healthline{display:inline-flex;align-items:center;gap:6px;padding:2px 4px;border:0;background:transparent;color:color-mix(in srgb,var(--bf-bg-1) 62%,transparent);font-size:11px;letter-spacing:.01em;cursor:pointer;border-radius:6px}',
    '.bf-healthline:hover{color:color-mix(in srgb,var(--bf-bg-1) 88%,transparent)}',
    '.bf-healthline-dot{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.9}',
    '.bf-healthline-sep{width:1px;height:10px;background:color-mix(in srgb,var(--bf-bg-1) 24%,transparent)}',
    '.bf-lamps-compact{display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border-radius:999px;border:1px solid var(--bf-line);background:rgba(255,255,255,.72);font-size:11px;color:var(--bf-ink-2);cursor:pointer}',
    '.bf-top-sep{width:1px;height:12px;background:var(--bf-line);display:inline-block}',
    '.bf-examples-toggle{align-self:flex-start}',
    '.bf-card-compact{padding:12px 14px}',
    '.bf-modal{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,#071A29 42%,transparent);backdrop-filter:blur(6px);padding:24px}',
    '.bf-modal-card{display:flex;flex-direction:column;width:min(760px,calc(100vw - 32px));max-height:calc(100vh - 64px);border:1px solid var(--bf-line);border-radius:18px;background:linear-gradient(180deg,#FFFFFF,rgba(246,252,255,.98));box-shadow:0 40px 90px -50px rgba(8,60,96,.7);overflow:hidden}',
    '.bf-modal-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid var(--bf-line)}',
    '.bf-modal-body{display:flex;flex-direction:column;gap:8px;padding:12px 14px;overflow-y:auto}',
    '.bf-paperfig{display:flex;flex-direction:column;gap:8px}',
    '.bf-paperfig-drag .bf-dropzone{border-color:var(--bf-accent);background:color-mix(in srgb,var(--bf-accent) 8%,#fff)}',
    '.bf-dropzone{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1.5px dashed color-mix(in srgb,var(--bf-line) 90%,var(--bf-accent));border-radius:10px;font-size:12px;color:var(--bf-ink-2);background:rgba(255,255,255,.6)}',
    '.bf-starters{margin-bottom:2px}',
    '.bf-health{display:flex;align-items:center;gap:8px;padding:8px 11px;border-radius:10px;font-size:11.5px;border:1px solid var(--bf-line);background:rgba(255,255,255,.75)}',
    '.bf-health-dot{width:9px;height:9px;border-radius:50%;flex:none;background:currentColor;box-shadow:0 0 8px currentColor}',
    '.bf-health-green{color:var(--bf-ok);border-color:color-mix(in srgb,var(--bf-ok) 40%,var(--bf-line));background:color-mix(in srgb,var(--bf-ok) 7%,#fff)}',
    '.bf-health-yellow{color:var(--bf-warn);border-color:color-mix(in srgb,var(--bf-warn) 45%,var(--bf-line));background:color-mix(in srgb,var(--bf-warn) 7%,#fff)}',
    '.bf-health-red{color:var(--bf-err);border-color:color-mix(in srgb,var(--bf-err) 45%,var(--bf-line));background:color-mix(in srgb,var(--bf-err) 6%,#fff)}',
    '.bf-gate-fixes{display:flex;flex-direction:column;gap:2px;margin-top:4px;font-size:11px;color:var(--bf-ok)}',
    '.bf-next{flex:none;display:flex;flex-direction:column;gap:8px;padding:11px 13px;border:1px solid var(--bf-line);border-radius:14px;background:linear-gradient(180deg,rgba(255,255,255,.95),rgba(240,250,255,.9))}',
    '.bf-next-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.bf-wizard{display:flex;flex-direction:column;gap:10px;padding:14px;min-height:0;overflow-y:auto}',
    '.bf-wizard-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    '.bf-wizard-steps{display:flex;gap:6px;flex-wrap:wrap}',
    '.bf-wizard-body{display:flex;flex-direction:column;gap:12px}',
    '.bf-wizard-split{display:grid;grid-template-columns:240px minmax(0,1fr);gap:12px;min-height:320px}',
    '.bf-wizard-side{display:flex;flex-direction:column;gap:5px;max-height:520px;overflow-y:auto}',
    '.bf-wizard-main{min-width:0;display:flex;flex-direction:column;gap:10px}',
    '.bf-wizard-picked{border-color:var(--bf-line-glow);box-shadow:0 0 0 3px color-mix(in srgb,var(--bf-accent-3) 16%,transparent)}',
    '.bf-chip-on{border-color:var(--bf-line-glow);background:color-mix(in srgb,var(--bf-accent-3) 18%,#FFFFFF);box-shadow:0 0 0 3px color-mix(in srgb,var(--bf-accent-3) 16%,transparent)}',
    '.bf-logic-preview{padding:11px 13px;border:1px dashed var(--bf-line);border-radius:12px;background:rgba(255,255,255,.75);font-size:12.5px;line-height:1.6;color:var(--bf-ink-1)}',
    '.bf-clinical-hit{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border:1px solid var(--bf-line);border-radius:10px;background:#FFFFFF}',
    '.bf-clinical-hit-title{font-size:12px;color:var(--bf-ink-1);line-height:1.45}',
    '.bf-clinical-hit-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:10.5px}',
    '.bf-joint{display:flex;flex-direction:column;min-height:0;border:1px solid var(--bf-line);border-radius:var(--bf-radius);background:linear-gradient(180deg,rgba(255,255,255,.95),rgba(246,252,255,.9));box-shadow:var(--bf-shadow);overflow:hidden}',
    '.bf-joint-body{display:flex;flex-direction:column;gap:12px;padding:12px 14px 14px;overflow-y:auto}',
    '.bf-joint-section{display:flex;flex-direction:column;gap:8px}',
    '.bf-joint-title{font-size:12px;font-weight:600;color:var(--bf-ink-1)}',
    '.bf-joint-list{display:flex;flex-direction:column;gap:5px;max-height:210px;overflow-y:auto}',
    '.bf-joint-row{display:flex;align-items:center;gap:8px;padding:6px 9px;border:1px solid var(--bf-line);border-radius:10px;background:#FFFFFF;font-size:11.5px;cursor:pointer}',
    '.bf-joint-row-on{border-color:var(--bf-line-glow);background:color-mix(in srgb,var(--bf-accent-3) 12%,#FFFFFF)}',
    '.bf-joint-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.bf-joint-field{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--bf-ink-2)}',
    '.bf-joint-result{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:1px solid color-mix(in srgb,var(--bf-ok) 40%,var(--bf-line));border-radius:10px;background:color-mix(in srgb,var(--bf-ok) 7%,#FFFFFF);font-size:11.5px}',
    '.bf-tpl{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--bf-line);border-radius:14px;background:linear-gradient(180deg,rgba(255,255,255,.9),rgba(241,250,255,.9))}',
    '.bf-tpl-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.bf-tpl-field{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--bf-ink-2);min-width:0}',
    '.bf-tpl-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.bf-feed-examples{display:flex;flex-direction:column;gap:6px;margin-top:10px}',
    '.bf-example{text-align:left;border:1px solid var(--bf-line);border-radius:12px;background:rgba(255,255,255,.8);padding:8px 10px;font-size:11.5px;color:var(--bf-ink-1);line-height:1.5}.bf-example:hover{border-color:var(--bf-line-glow);box-shadow:0 0 0 3px color-mix(in srgb,var(--bf-accent-3) 20%,transparent)}',
    /* 历史 run */
    '.bf-runlist{display:flex;flex-direction:column;gap:5px}',
    '.bf-runitem{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-2);padding:6px 8px}',
    '.bf-runitem:hover{border-color:var(--bf-line-glow)}',
    '.bf-runitem-on{border-color:var(--bf-accent);background:color-mix(in srgb,var(--bf-accent) 7%,var(--bf-bg-2))}',
    '.bf-runitem-main{display:flex;align-items:center;gap:6px;min-width:0}',
    '.bf-runitem-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--bf-ink-2)}',
    /* 计划卡 */
    '.bf-card{position:relative;flex:none;display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--bf-line);border-radius:14px;background:var(--bf-bg-2);box-shadow:var(--bf-shadow)}',
    '.bf-card-muted{background:color-mix(in srgb,var(--bf-bg-1) 62%,var(--bf-bg-2))}',
    '.bf-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.bf-card-title{display:inline-flex;align-items:center;gap:7px;font-size:15px;font-weight:600;color:var(--bf-ink-1)}',
    '.bf-fields{display:flex;flex-direction:column;gap:2px}',
    '.bf-field{display:grid;grid-template-columns:104px minmax(0,1fr);gap:4px 10px;padding:8px;border:1px solid transparent;border-radius:10px}',
    '.bf-field:hover{background:color-mix(in srgb,var(--bf-bg-1) 60%,transparent)}',
    '.bf-field-missing{border-color:color-mix(in srgb,var(--bf-warn) 55%,var(--bf-line));background:color-mix(in srgb,var(--bf-warn) 7%,var(--bf-bg-2))}',
    '.bf-field-label{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding-top:5px;font-size:12px;font-weight:600;color:var(--bf-ink-1)}',
    '.bf-field-body{display:flex;flex-direction:column;gap:3px;min-width:0}',
    '.bf-field-why{font-size:11px;line-height:1.45;color:var(--bf-ink-2)}',
    '.bf-field-miss-tag{font-size:11px;font-weight:600;color:var(--bf-ink-1);border:1px solid var(--bf-warn);border-radius:6px;padding:0 4px;background:color-mix(in srgb,var(--bf-warn) 12%,var(--bf-bg-2))}',
    '.bf-cands{display:flex;gap:5px;flex-wrap:wrap;margin-top:2px}',
    '.bf-cand{font-size:11px;border:1px dashed color-mix(in srgb,var(--bf-accent) 45%,var(--bf-line));background:color-mix(in srgb,var(--bf-accent) 7%,var(--bf-bg-2));color:var(--bf-ink-1);border-radius:6px;padding:2px 6px}',
    '.bf-cand:hover{border-style:solid;border-color:var(--bf-accent);background:color-mix(in srgb,var(--bf-accent) 14%,var(--bf-bg-2))}',
    '.bf-cand-on{border-style:solid;border-color:var(--bf-accent);background:color-mix(in srgb,var(--bf-accent) 18%,var(--bf-bg-2));font-weight:600}',
    '.bf-toggle{display:inline-flex;overflow:hidden;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-0);width:max-content}',
    '.bf-toggle button{border:0;background:transparent;padding:4px 12px;font-size:11px;font-weight:600;color:var(--bf-ink-2)}',
    '.bf-toggle button.bf-on{background:var(--bf-accent);color:var(--bf-ink-0)}',
    /* 空态 / 错误 / 骨架 / 进度 */
    '.bf-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:96px;padding:18px 12px;text-align:center;border:1px dashed var(--bf-line);border-radius:14px;background:color-mix(in srgb,var(--bf-bg-1) 45%,var(--bf-bg-2));color:var(--bf-ink-2)}',
    '.bf-empty-icon{display:inline-flex;color:var(--bf-accent);opacity:.8}',
    '.bf-empty-title{font-size:12px;font-weight:600;color:var(--bf-ink-1)}',
    '.bf-empty-sub{font-size:11px;color:var(--bf-ink-2);max-width:46ch;line-height:1.5}',
    '.bf-errorbar{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--bf-err) 45%,var(--bf-line));border-left:3px solid var(--bf-err);border-radius:10px;background:color-mix(in srgb,var(--bf-err) 5%,var(--bf-bg-2))}',
    '.bf-errorbar-head{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--bf-ink-1)}',
    '.bf-errorbar-msg{font-size:11px;color:var(--bf-ink-2);word-break:break-word}',
    '.bf-error-details summary{font-size:11px;color:var(--bf-ink-2);cursor:pointer}',
    '.bf-raw{margin:4px 0 0;padding:6px;border:1px solid var(--bf-line);border-radius:6px;background:var(--bf-bg-0);color:var(--bf-ink-2);font-family:var(--bf-mono);font-size:11px;line-height:1.45;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word}',
    '.bf-skeleton{display:flex;flex-direction:column;gap:6px}',
    '.bf-skel-line{height:10px;border-radius:6px;background:linear-gradient(90deg,color-mix(in srgb,var(--bf-bg-1) 90%,var(--bf-line)) 0%,var(--bf-bg-2) 40%,color-mix(in srgb,var(--bf-bg-1) 90%,var(--bf-line)) 80%);background-size:220% 100%;animation:bfShimmer 1.25s linear infinite}',
    '@keyframes bfShimmer{0%{background-position:120% 0}100%{background-position:-120% 0}}',
    '.bf-progressbar{position:relative;flex:1 1 auto;min-width:60px;height:6px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--bf-line) 62%,var(--bf-bg-2))}',
    '.bf-progressbar-fill{position:absolute;top:0;bottom:0;left:0;border-radius:999px;background:var(--bf-accent);transition:width .3s ease}',
    '.bf-progressbar-indet{position:absolute;top:0;bottom:0;width:38%;border-radius:999px;background:var(--bf-accent);animation:bfSlide 1.1s ease-in-out infinite}',
    '@keyframes bfSlide{0%{left:-40%}100%{left:102%}}',
    /* 时间线 */
    '.bf-timeline{display:flex;flex-direction:column;gap:6px}',
    '.bf-step{overflow:hidden;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-2)}',
    '.bf-step-open{border-color:color-mix(in srgb,var(--bf-accent) 45%,var(--bf-line))}',
    '.bf-step-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;padding:8px 10px;border:0;background:transparent;text-align:left}',
    '.bf-step-head:hover{background:color-mix(in srgb,var(--bf-bg-1) 70%,transparent)}',
    '.bf-step-index{width:20px;flex:none;font-family:var(--bf-mono);font-size:11px;color:var(--bf-ink-2)}',
    '.bf-step-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;color:var(--bf-ink-1)}',
    '.bf-step-plugin{font-family:var(--bf-mono);font-size:11px;color:var(--bf-ink-2)}',
    '.bf-step-right{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}',
    '.bf-step-time{font-family:var(--bf-mono);font-size:11px;color:var(--bf-ink-2)}',
    '.bf-step-chevron{display:inline-flex;color:var(--bf-ink-2);transition:transform .15s}',
    '.bf-step-chevron-on{transform:rotate(90deg)}',
    '.bf-step-body{display:flex;flex-direction:column;gap:8px;padding:0 10px 10px 38px}',
    '.bf-kv{display:grid;grid-template-columns:82px minmax(0,1fr);gap:3px 8px;font-size:11px}',
    '.bf-kv-k{color:var(--bf-ink-2)}',
    '.bf-kv-v{color:var(--bf-ink-1);font-family:var(--bf-mono);font-size:11px;word-break:break-word}',
    '.bf-pre{margin:0;padding:6px 8px;border:1px solid var(--bf-line);border-radius:6px;background:var(--bf-bg-0);color:var(--bf-ink-1);font-family:var(--bf-mono);font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}',
    '.bf-subhead{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--bf-ink-2)}',
    '.bf-gate{display:flex;flex-direction:column;gap:3px;padding:7px 9px;border:1px solid color-mix(in srgb,var(--bf-blocked) 40%,var(--bf-line));border-left:3px solid var(--bf-blocked);border-radius:10px;background:color-mix(in srgb,var(--bf-blocked) 6%,var(--bf-bg-2))}',
    '.bf-gate-id{font-family:var(--bf-mono);font-size:11px;font-weight:600;color:var(--bf-ink-1)}',
    '.bf-gate-detail{font-size:11px;color:var(--bf-ink-2)}',
    '.bf-warnbox{display:flex;flex-direction:column;gap:4px;padding:7px 9px;border:1px solid color-mix(in srgb,var(--bf-warn) 55%,var(--bf-line));border-radius:10px;background:color-mix(in srgb,var(--bf-warn) 7%,var(--bf-bg-2));font-size:11px;color:var(--bf-ink-1)}',
    /* 检索 */
    '.bf-tabs{display:flex;gap:4px;flex-wrap:wrap;padding:0 2px 6px;border-bottom:1px solid var(--bf-line)}',
    '.bf-tab{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border:1px solid transparent;border-bottom:2px solid transparent;border-radius:10px 10px 0 0;background:transparent;font-size:11px;font-weight:600;color:var(--bf-ink-2)}',
    '.bf-tab:hover{color:var(--bf-ink-1);background:color-mix(in srgb,var(--bf-bg-1) 70%,transparent)}',
    '.bf-tab-on{color:var(--bf-ink-1);border-bottom-color:var(--bf-accent);background:color-mix(in srgb,var(--bf-accent) 8%,transparent)}',
    '.bf-tab-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}',
    '.bf-results{display:flex;flex-direction:column;gap:6px}',
    '.bf-result{display:grid;grid-template-columns:16px minmax(0,1fr);gap:8px;padding:7px 9px;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-2);cursor:pointer}',
    '.bf-result:hover{border-color:var(--bf-line-glow)}',
    '.bf-result-on{border-color:var(--bf-accent);background:color-mix(in srgb,var(--bf-accent) 6%,var(--bf-bg-2))}',
    '.bf-check{width:14px;height:14px;margin:2px 0 0;accent-color:var(--bf-accent)}',
    '.bf-result-id{font-family:var(--bf-mono);font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--bf-ink-1);word-break:break-all}',
    '.bf-result-title{margin-top:1px;font-size:12px;line-height:1.4;color:var(--bf-ink-1);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.bf-result-meta{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px;font-size:11px;color:var(--bf-ink-2)}',
    /* 下载队列 */
    '.bf-dl{display:flex;flex-direction:column;gap:6px}',
    '.bf-dl-row{display:flex;flex-direction:column;gap:5px;padding:7px 9px;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-2)}',
    '.bf-dl-main{display:flex;align-items:center;gap:6px;min-width:0}',
    '.bf-dl-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;color:var(--bf-ink-1)}',
    '.bf-dl-meta{display:flex;gap:6px;flex-wrap:wrap;font-family:var(--bf-mono);font-size:11px;color:var(--bf-ink-2)}',
    '.bf-dl-err{font-size:11px;color:var(--bf-err)}',
    /* 产物与证据 */
    '.bf-entries{display:flex;flex-direction:column;gap:5px}',
    '.bf-entry{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:6px;align-items:center;width:100%;padding:6px 8px;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-2);text-align:left}',
    '.bf-entry:hover{border-color:var(--bf-line-glow);background:color-mix(in srgb,var(--bf-bg-1) 55%,var(--bf-bg-2))}',
    '.bf-entry-icon{display:inline-flex;color:var(--bf-accent)}',
    '.bf-entry-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--bf-mono);font-size:11px;font-weight:600;color:var(--bf-ink-1)}',
    '.bf-entry-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--bf-ink-2)}',
    '.bf-figgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:6px}',
    '.bf-figcard{display:flex;flex-direction:column;gap:3px;overflow:hidden;padding:4px;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-2);text-align:left}',
    '.bf-figcard:hover{border-color:var(--bf-line-glow)}',
    '.bf-figthumb{display:block;width:100%;height:68px;object-fit:cover;border:1px solid var(--bf-line);border-radius:6px;background:var(--bf-bg-0)}',
    '.bf-figcap{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--bf-mono);font-size:11px;color:var(--bf-ink-1)}',
    '.bf-figsub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--bf-ink-2)}',
    '.bf-evi{display:flex;flex-direction:column;gap:6px}',
    '.bf-evi-row{display:flex;flex-direction:column;gap:4px;padding:7px 9px;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-2)}',
    '.bf-evi-model{border-color:color-mix(in srgb,var(--bf-blocked) 50%,var(--bf-line));border-left:3px solid var(--bf-blocked);background:color-mix(in srgb,var(--bf-blocked) 6%,var(--bf-bg-2))}',
    '.bf-evi-claim{font-size:12px;line-height:1.4;color:var(--bf-ink-1);word-break:break-word}',
    '.bf-evi-ids{display:flex;gap:5px;flex-wrap:wrap;font-family:var(--bf-mono);font-size:11px;color:var(--bf-ink-2)}',
    '.bf-model-note{display:flex;align-items:center;gap:5px;padding:3px 6px;border:1px solid color-mix(in srgb,var(--bf-blocked) 40%,var(--bf-line));border-radius:6px;background:color-mix(in srgb,var(--bf-blocked) 8%,var(--bf-bg-2));font-size:11px;font-weight:600;color:var(--bf-blocked)}',
    '.bf-chipbar{display:flex;gap:4px;flex-wrap:wrap}',
    '.bf-note{font-size:11px;line-height:1.5;color:var(--bf-ink-2);border-left:2px solid var(--bf-accent-3);padding-left:7px}',
    /* 抽屉 / 大图 / 表格 / Toast */
    '.bf-drawer{position:fixed;inset:0;z-index:80;display:flex;align-items:stretch;justify-content:flex-end}',
    '.bf-drawer-back{position:absolute;inset:0;background:color-mix(in srgb,var(--bf-ink-0) 55%,transparent);backdrop-filter:blur(2px)}',
    '.bf-drawer-card{position:relative;display:flex;flex-direction:column;min-height:0;width:min(920px,calc(100vw - 32px));margin:16px 16px 16px auto;border:1px solid var(--bf-line-glow);border-radius:14px;background:var(--bf-bg-2);box-shadow:0 24px 60px -24px color-mix(in srgb,var(--bf-ink-0) 70%,transparent),var(--bf-shadow);overflow:hidden;animation:bfDrawerIn .18s ease}',
    '@keyframes bfDrawerIn{from{transform:translateY(8px);opacity:.3}to{transform:none;opacity:1}}',
    '.bf-drawer-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none;padding:10px 12px;border-bottom:1px solid var(--bf-line);background:var(--bf-bg-1)}',
    '.bf-drawer-title{display:flex;align-items:center;gap:6px;min-width:0;font-size:15px;font-weight:600;color:var(--bf-ink-1)}',
    '.bf-drawer-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:12px}',
    '.bf-figure-img{display:block;max-width:100%;height:auto;margin:0 auto;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-2)}',
    '.bf-figure-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px}',
    '.bf-meta-cell{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-0)}',
    '.bf-meta-k{font-size:11px;color:var(--bf-ink-2)}',
    '.bf-meta-v{font-family:var(--bf-mono);font-size:12px;color:var(--bf-ink-1);word-break:break-word}',
    '.bf-table-wrap{overflow:auto;max-height:62vh;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-2)}',
    '.bf-table{width:100%;border-collapse:collapse;font-family:var(--bf-mono);font-size:11px}',
    '.bf-table th,.bf-table td{padding:4px 8px;border-bottom:1px solid var(--bf-line);text-align:left;white-space:nowrap}',
    '.bf-table th{position:sticky;top:0;background:var(--bf-bg-1);color:var(--bf-ink-1);font-weight:600}',
    '.bf-table td{color:var(--bf-ink-1)}',
    '.bf-collapse{overflow:hidden;border:1px solid var(--bf-line);border-radius:10px;background:var(--bf-bg-0)}',
    '.bf-collapse-head{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border:0;background:transparent;text-align:left;font-size:11px;font-weight:600;color:var(--bf-ink-1)}',
    '.bf-collapse-body{padding:0 8px 8px;max-height:220px;overflow:auto}',
    '.bf-toast{position:fixed;left:50%;bottom:20px;z-index:90;transform:translateX(-50%);padding:7px 14px;border:1px solid var(--bf-line-glow);border-radius:10px;background:var(--bf-ink-0);color:var(--bf-bg-1);font-size:12px;box-shadow:0 12px 30px -14px color-mix(in srgb,var(--bf-ink-0) 80%,transparent);animation:bfToastIn .18s ease}',
    '@keyframes bfToastIn{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}',
    /* 响应式：1180px 以下折叠成上下两段（左+中 / 右） */
    '@media (max-width:1180px){.bf-root{height:auto;min-height:100%;overflow:visible}.bf-body{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;overflow:visible}.bf-side{min-height:600px}.bf-work{overflow:visible}.bf-drawer-card{width:calc(100vw - 24px);margin:12px}}',
    '@media (max-width:900px){.bf-body{grid-template-columns:minmax(0,1fr)}.bf-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.bf-subtitle{max-width:70vw}}',
    '@media (max-width:760px){.bf-field{grid-template-columns:minmax(0,1fr)}.bf-top{padding:8px 10px}.bf-body{padding:8px;gap:8px}.bf-env{max-width:80vw}}',
    /* 统计口径 */
    '.bf-contract-chips{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 4px}',
    '.bf-contract-chip{padding:1px 7px;border:1px solid var(--bf-line);border-radius:999px;font-family:var(--bf-mono);font-size:10.5px;color:var(--bf-ink-2);background:var(--bf-bg-2)}',
    '.bf-contract-chip-warn{border-color:color-mix(in srgb,var(--bf-warn) 55%,var(--bf-line));color:var(--bf-warn)}',
    '.bf-contract-grid{display:flex;flex-direction:column;gap:2px;padding:2px 0 6px}',
    '.bf-contract-value{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}',
    '.bf-contract-note{font-family:var(--bf-mono);font-size:10.5px;color:var(--bf-ink-2)}',
    '.bf-contract-row{align-items:flex-start}',
  ]

  var BF_UI_BUILD = 'UI 0.2.9 · 2026-11-26 17:05'
  // 侧栏/顶栏图标：用户提供的图（icon.svg 里同一张，base64 内嵌避免额外静态路由）
  var BF_ICON_DATA_URI = 'data:image/png;base64,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'

  var CSS_TEXT = CSS_LINES.join('\n')

  // ==========================================================================
  // __BF_TEST__：node 下的确定性自检出口（纯函数，不含 React/DOM）
  // ==========================================================================
  var BF_TEST = {
    NS: NS,
    API: API,
    PLUGIN_VERSION: PLUGIN_VERSION,
    TOKENS: TOKENS,
    FONT_LADDER: FONT_LADDER,
    SOURCE_TABS: SOURCE_TABS,
    GATE_LABELS: GATE_LABELS,
    STEP_STATUS_META: STEP_STATUS_META,
    EVIDENCE_KIND_META: EVIDENCE_KIND_META,
    SCALE_META: SCALE_META,
    DELIVERABLES: DELIVERABLES,
    TEMPLATE_FALLBACK: TEMPLATE_FALLBACK,
    PLAN_FIELDS: PLAN_FIELDS,
    TOKEN_FIELDS: TOKEN_FIELDS,
    CSS_TEXT: CSS_TEXT,
    // 工具
    isNil: isNil,
    asArray: asArray,
    asNumber: asNumber,
    asText: asText,
    displayValue: displayValue,
    dropUndefined: dropUndefined,
    safeJson: safeJson,
    truncate: truncate,
    tail: tail,
    unique: unique,
    parseDate: parseDate,
    formatLocalTime: formatLocalTime,
    formatClock: formatClock,
    formatRelative: formatRelative,
    formatDuration: formatDuration,
    formatNumber: formatNumber,
    formatP: formatP,
    formatBytes: formatBytes,
    sha8: sha8,
    shortId: shortId,
    fileNameOf: fileNameOf,
    basenameNoExt: basenameNoExt,
    percent: percent,
    isEmptyValue: isEmptyValue,
    // 路径 / URL
    runRelativePath: runRelativePath,
    encodePathSegments: encodePathSegments,
    filesUrl: filesUrl,
    figureAliasUrl: figureAliasUrl,
    figureSources: figureSources,
    isImageFile: isImageFile,
    // 元数据
    normalizeStepStatus: normalizeStepStatus,
    stepStatusMeta: stepStatusMeta,
    runTone: runTone,
    runStatusLabel: runStatusLabel,
    isActiveStatus: isActiveStatus,
    isTerminalStatus: isTerminalStatus,
    stepProgress: stepProgress,
    healthMeta: healthMeta,
    healthTitle: healthTitle,
    findSourceTab: findSourceTab,
    scaleMeta: scaleMeta,
    evidenceKindMeta: evidenceKindMeta,
    gateTitle: gateTitle,
    // 规范化
    normalizeContrast: normalizeContrast,
    normalizeCandidates: normalizeCandidates,
    normalizeGates: normalizeGates,
    normalizePlanSteps: normalizePlanSteps,
    normalizePlanSummary: normalizePlanSummary,
    normalizeStatsContract: normalizeStatsContract,
    normalizeAsk: normalizeAsk,
    fieldValueOf: fieldValueOf,
    fieldDisplay: fieldDisplay,
    planFieldRows: planFieldRows,
    contrastGroupOptions: contrastGroupOptions,
    parseFdrFamily: parseFdrFamily,
    buildAskOverrides: buildAskOverrides,
    buildAskBody: buildAskBody,
    buildSubmitBody: buildSubmitBody,
    buildSearchBody: buildSearchBody,
    buildDownloadBody: buildDownloadBody,
    buildRunStatusBody: buildRunStatusBody,
    buildHealthBody: buildHealthBody,
    normalizeCatalog: normalizeCatalog,
    normalizeStatus: normalizeStatus,
    normalizeHealth: normalizeHealth,
    normalizeRunRow: normalizeRunRow,
    normalizeRuns: normalizeRuns,
    normalizeStep: normalizeStep,
    normalizeTable: normalizeTable,
    normalizeFigure: normalizeFigure,
    normalizeRunStatus: normalizeRunStatus,
    normalizeSearchItem: normalizeSearchItem,
    normalizeSearch: normalizeSearch,
    searchItemsFor: searchItemsFor,
    downloadRows: downloadRows,
    mergeDownloadRow: mergeDownloadRow,
    normalizeEvidence: normalizeEvidence,
    filterEvidence: filterEvidence,
    figureMetaCells: figureMetaCells,
    parseTsvPreview: parseTsvPreview,
    // API
    apiError: apiError,
    createApi: createApi,
  }

  // ==========================================================================
  // 浏览器层
  // ==========================================================================

  function factory(require) {
    var React = require('react')
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useMemo = React.useMemo
    var useCallback = React.useCallback

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    function warn(message, error) {
      try { console.warn('[dsh-bioflow] ' + message, error || '') } catch (ignored) { /* ignore */ }
    }

    // ----------------------------------------------------------------------
    // 通用 hooks（轮询在 document.hidden 时暂停；Esc 关闭抽屉）
    // ----------------------------------------------------------------------
    function useLatest(value) {
      var ref = useRef(value)
      useEffect(function () { ref.current = value })
      return ref
    }

    /** 轮询：fn 存 ref 避免闭包过期；页面不可见时跳过这一跳（仍保留定时器，可见即恢复）。 */
    function usePoll(callback, intervalMs, enabled) {
      var callbackRef = useLatest(callback)
      var delay = Math.max(1500, asNumber(intervalMs, 2000))
      useEffect(function () {
        if (!enabled) return undefined
        var stopped = false
        var timer = null
        function schedule() {
          if (stopped) return
          timer = setTimeout(tick, delay)
        }
        function tick() {
          if (stopped) return
          var hidden = typeof document !== 'undefined' && document.hidden
          if (!hidden) {
            try { callbackRef.current() } catch (error) { warn('poll callback failed', error) }
          }
          schedule()
        }
        function onVisible() {
          if (typeof document !== 'undefined' && !document.hidden) {
            if (timer) clearTimeout(timer)
            tick()
          }
        }
        schedule()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return function () {
          stopped = true
          if (timer) clearTimeout(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [enabled, delay])
    }

    function useEscapeKey(active, onEscape) {
      var escapeRef = useLatest(onEscape)
      useEffect(function () {
        if (!active) return undefined
        function onKey(event) {
          if (event && (event.key === 'Escape' || event.keyCode === 27)) {
            try { escapeRef.current() } catch (error) { warn('escape handler failed', error) }
          }
        }
        if (typeof document !== 'undefined') document.addEventListener('keydown', onKey)
        return function () { if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey) }
      }, [active])
    }

    // ----------------------------------------------------------------------
    // 剪贴板（navigator.clipboard 不可用时退到 execCommand）
    // ----------------------------------------------------------------------
    function legacyCopy(value) {
      try {
        if (typeof document === 'undefined') return false
        var area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', 'readonly')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        var ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch (error) {
        return false
      }
    }

    function copyText(value) {
      var text = String(value === null || value === undefined ? '' : value)
      if (!text) return Promise.resolve(false)
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { return true }).catch(function () { return legacyCopy(text) })
      }
      return Promise.resolve(legacyCopy(text))
    }

    // ----------------------------------------------------------------------
    // 错误展示模型（接口失败必须有错误条 + 重试 + 原始错误折叠）
    // ----------------------------------------------------------------------
    function describeError(error) {
      if (!error) return { code: 'error', message: '未知错误', raw: '' }
      if (typeof error === 'string') return { code: 'error', message: error, raw: '' }
      var code = asText(error.code || error.error, 'error')
      var message = asText(error.message, '请求失败')
      var rawSource = error.details !== undefined && error.details !== null ? error.details : error
      return { code: code, message: message, raw: safeJson(rawSource) }
    }

    // ----------------------------------------------------------------------
    // 图标（内联 SVG，不引第三方）
    // ----------------------------------------------------------------------
    var ICON_PATHS = {
      flask: ['M9 3h6', 'M10 3v6L5 18a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18L14 9V3', 'M8 15h8'],
      chat: ['M21 11.5a8.5 8.5 0 0 1-8.5 8.5H7l-4 3v-5.2A8.5 8.5 0 1 1 21 11.5z'],
      search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
      download: ['M12 3v12', 'M8 11l4 4 4-4', 'M4 19h16'],
      upload: ['M12 21V9', 'M8 13l4-4 4 4', 'M4 5h16'],
      refresh: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4v4h-4'],
      copy: ['M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
      check: ['M20 6L9 17l-5-5'],
      close: ['M18 6L6 18', 'M6 6l12 12'],
      chevron: ['M9 6l6 6-6 6'],
      alert: ['M12 3l9 16H3z', 'M12 9v5', 'M12 17h.01'],
      info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 8h.01'],
      play: ['M7 4l13 8-13 8z'],
      stop: ['M6 6h12v12H6z'],
      clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
      file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
      folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
      image: ['M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M3 17l5-5 4 4 3-3 6 5'],
      list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
      shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4'],
      external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
      flow: ['M4 7h7', 'M4 12h11', 'M4 17h7', 'M17 9l4 3-4 3'],
      send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4z'],
      plus: ['M12 5v14', 'M5 12h14'],
      minus: ['M5 12h14'],
      filter: ['M3 5h18l-7 8v6l-4-2v-4z'],
      trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
    }

    function Icon(props) {
      var name = asText(props && props.name, 'file')
      var size = asNumber(props && props.size, 14)
      var paths = ICON_PATHS[name] || ICON_PATHS.file
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false', style: { display: 'block', flex: 'none' },
      }, paths.map(function (d, index) { return h('path', { key: index, d: d }) }))
    }

    // ----------------------------------------------------------------------
    // 基础展示组件
    // ----------------------------------------------------------------------
    function Badge(props) {
      var tone = asText(props && props.tone, '') 
      var className = 'bf-badge' + (tone && tone !== 'muted' ? ' bf-badge-' + tone : '') + (props && props.mono ? ' bf-badge-mono' : '')
      return h('span', { className: className, title: props && props.title ? String(props.title) : undefined },
        props && props.children)
    }

    function Dot(props) {
      return h('span', { className: 'bf-dot bf-tone-' + asText(props && props.tone, 'muted'), 'aria-hidden': 'true' })
    }

    function StatusBadge(props) {
      var status = props && props.status
      var meta = props && props.kind === 'run'
        ? { label: runStatusLabel(status), tone: runTone(status) }
        : stepStatusMeta(status)
      return h(Badge, { tone: meta.tone, title: asText(status, '') }, h(Dot, { tone: meta.tone }), meta.label)
    }

    function EmptyState(props) {
      return h('div', { className: 'bf-empty' },
        h('span', { className: 'bf-empty-icon' }, h(Icon, { name: asText(props && props.icon, 'info'), size: 20 })),
        h('div', { className: 'bf-empty-title' }, asText(props && props.title, '暂无内容')),
        props && props.sub ? h('div', { className: 'bf-empty-sub' }, String(props.sub)) : null,
        props && props.actions ? h('div', { className: 'bf-row bf-row-tight' }, props.actions) : null)
    }

    function ErrorBar(props) {
      var info = describeError(props && props.error)
      var canRetry = typeof (props && props.onRetry) === 'function'
      return h('div', { className: 'bf-errorbar', role: 'alert' },
        h('div', { className: 'bf-errorbar-head' },
          h('span', { className: 'bf-tone-err' }, h(Icon, { name: 'alert', size: 13 })),
          asText(props && props.title, '接口失败'),
          h('span', { className: 'bf-badge bf-badge-mono' }, info.code),
          canRetry ? h('button', { className: 'bf-btn bf-btn-sm bf-btn-ghost', style: { marginLeft: 'auto' }, onClick: props.onRetry },
            h(Icon, { name: 'refresh', size: 11 }), '重试') : null),
        h('div', { className: 'bf-errorbar-msg' }, info.message),
        info.raw ? h('details', { className: 'bf-error-details' },
          h('summary', null, '原始错误'),
          h('pre', { className: 'bf-raw' }, tail(info.raw, 4000))) : null)
    }

    function Skeleton(props) {
      var lines = Math.max(1, asNumber(props && props.lines, 3))
      var widths = ['92%', '76%', '84%', '68%', '88%']
      return h('div', { className: 'bf-skeleton', 'aria-label': asText(props && props.label, '加载中'), role: 'status' },
        widths.slice(0, lines).map(function (width, index) {
          return h('div', { key: index, className: 'bf-skel-line', style: { width: width, height: (props && props.thick ? 12 : 10) + 'px' } })
        }))
    }

    function ProgressBar(props) {
      var indeterminate = Boolean(props && props.indeterminate)
      var value = Math.max(0, Math.min(100, asNumber(props && props.value, 0)))
      return h('div', {
        className: 'bf-progressbar',
        role: 'progressbar',
        'aria-valuemin': 0, 'aria-valuemax': 100,
        'aria-valuenow': indeterminate ? undefined : value,
        title: asText(props && props.title, ''),
      }, indeterminate
        ? h('div', { className: 'bf-progressbar-indet' })
        : h('div', { className: 'bf-progressbar-fill', style: { width: value + '%' } }))
    }

    function Collapsible(props) {
      var openState = useState(Boolean(props && props.defaultOpen))
      var open = openState[0]
      var setOpen = openState[1]
      return h('div', { className: 'bf-collapse' },
        h('button', {
          type: 'button', className: 'bf-collapse-head',
          'aria-expanded': open ? 'true' : 'false',
          onClick: function () { setOpen(!open) },
        },
          h('span', { style: { display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' } }, h(Icon, { name: 'chevron', size: 11 })),
          asText(props && props.title, '展开查看'),
          props && props.meta ? h('span', { className: 'bf-badge bf-badge-mono', style: { marginLeft: 'auto' } }, String(props.meta)) : null),
        open ? h('div', { className: 'bf-collapse-body' }, props && props.children) : null)
    }

    function Mono(props) {
      return h('span', { className: 'bf-mono', title: props && props.title ? String(props.title) : undefined, style: props && props.style }, props && props.children)
    }

    /** 可点击复制的小 path（长路径等宽 + 省略，title 显示全路径）。 */
    function PathChip(props) {
      var text = String(props && props.path ? props.path : '')
      if (!text) return h('span', { className: 'bf-muted' }, asText(props && props.empty, '路径未知'))
      return h('button', {
        type: 'button', className: 'bf-env-path', title: asText(props && props.title, '点击复制：' + text),
        onClick: function () { if (typeof props.onCopy === 'function') props.onCopy(text) },
        style: props && props.inline ? { display: 'inline-block', maxWidth: '100%' } : undefined,
      }, props && props.label ? String(props.label) : shortId(text, props && props.keep ? props.keep : 46))
    }

    function CopyButton(props) {
      return h('button', {
        type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', title: asText(props && props.title, '复制'),
        onClick: function () { if (typeof props.onCopy === 'function') props.onCopy(String(props.text || '')) },
      }, h(Icon, { name: 'copy', size: 11 }), props && props.label ? String(props.label) : null)
    }

    function PreBlock(props) {
      var text = String(props && props.text !== undefined && props.text !== null ? props.text : '—')
      var limit = asNumber(props && props.limit, 6000)
      return h('pre', { className: 'bf-pre', style: props && props.style }, tail(text, limit))
    }

    function KvRow(props) {
      return h('div', { className: 'bf-kv' },
        h('span', { className: 'bf-kv-k' }, asText(props && props.label, '')),
        h('span', { className: 'bf-kv-v' }, asText(props && props.value, '—')))
    }

    // ----------------------------------------------------------------------
    // 顶栏
    // ----------------------------------------------------------------------
    function TopBar(props) {
      var status = props.status || {}
      var catalog = props.catalog || {}
      var health = props.health || { sources: {} }
      var activeRun = props.activeRun || null
      var dataRoot = asText(status.dataRoot || catalog.dataRoot, '')
      var pluginRows = asArray(catalog.plugins)
      var runMeta = activeRun ? { label: runStatusLabel(activeRun.status), tone: runTone(activeRun.status) } : null
      var capsuleTone = runMeta && runMeta.tone !== 'muted' ? '-' + runMeta.tone : ''
      var runsByStatus = status.runsByStatus || {}
      var activeCount = ['queued', 'running', 'pending_review'].reduce(function (sum, key) {
        return sum + (asNumber(runsByStatus[key], 0) || 0)
      }, 0)
      var sourceEntries = SOURCE_TABS.map(function (tab) {
        var entry = health.sources ? health.sources[tab.id] : null
        return { tab: tab, entry: entry, meta: healthMeta(entry && entry.status) }
      })
      var sourcesOk = sourceEntries.filter(function (row) { return row.meta.tone === 'ok' }).length
      var pluginsOk = pluginRows.filter(function (row) { return row.available }).length
      var healthDetail = sourceEntries.map(function (row) {
        return row.tab.label + '=' + row.meta.label
      }).concat(pluginRows.map(function (row) {
        return asText(row.label, row.plugin) + '=' + (row.available ? '可用' : '不可用')
      })).join('；')
      return h('header', { className: 'bf-top', role: 'banner' },
        h('div', { className: 'bf-brand' },
          h('span', { className: 'bf-mark', 'aria-hidden': 'true' },
            h('img', { src: BF_ICON_DATA_URI, alt: '', style: { width: 22, height: 22, borderRadius: 7, objectFit: 'cover', display: 'block' } })),
          h('div', { className: 'bf-title-block' },
            h('div', { className: 'bf-title' }, 'Bioflow ▸ 科研指挥台'),
            h('div', { className: 'bf-subtitle', title: asText(status.summary || catalog.summary, '') },
              asText(status.summary || catalog.summary, '许愿 → 计划（闸门）→ 不可变 run → 交付物与证据')))),

        activeRun ? h('button', {
          type: 'button',
          className: 'bf-capsule' + capsuleTone,
          title: '当前 run：' + asText(activeRun.runId, '') + ' · 点击定位到时间线',
          onClick: function () { if (typeof props.onFocusRun === 'function') props.onFocusRun() },
        },
          h(Dot, { tone: runMeta.tone === 'muted' ? 'run' : runMeta.tone }),
          h('span', null, 'run '),
          h('span', { className: 'bf-mono' }, shortId(activeRun.runId, 20)),
          h('b', null, runMeta.label),
          activeRun.progress && activeRun.progress.total
            ? h('span', { className: 'bf-mono' }, ' ' + activeRun.progress.done + '/' + activeRun.progress.total)
            : null)
          : h('span', { className: 'bf-capsule' },
            h(Dot, { tone: activeCount ? 'run' : 'ok' }),
            h('span', null, activeCount ? '进行中 ' + activeCount + ' 个 run' : '暂无进行中的 run')),

        h('button', {
          type: 'button', className: 'bf-healthline',
          title: '健康检查（点击打开数据源）：' + (healthDetail || '状态加载中'),
          onClick: function () {
            var firstBad = sourceEntries.filter(function (row) { return row.meta.tone !== 'ok' })[0]
            if (typeof props.onOpenSource === 'function') props.onOpenSource(firstBad ? firstBad.tab.id : (SOURCE_TABS[0] && SOURCE_TABS[0].id))
          },
        },
          h('span', { className: 'bf-healthline-dot bf-tone-' + (sourceEntries.length && sourcesOk === sourceEntries.length ? 'ok' : 'warn') }),
          h('span', null, sourceEntries.length ? '数据源 ' + sourcesOk + '/' + sourceEntries.length : '数据源 …'),
          h('span', { className: 'bf-healthline-sep', 'aria-hidden': 'true' }),
          h('span', { className: 'bf-healthline-dot bf-tone-' + (pluginRows.length && pluginsOk === pluginRows.length ? 'ok' : 'warn') }),
          h('span', null, pluginRows.length ? '工作台 ' + pluginsOk + '/' + pluginRows.length : '工作台 …')),

        dataRoot ? h('div', { className: 'bf-top-group bf-env', title: (status.storeKind ? status.storeKind + ' · ' : '') + 'v' + asText(status.version || catalog.version, PLUGIN_VERSION) },
          h(PathChip, { path: dataRoot, onCopy: props.onCopy, empty: '数据根未知' })) : null,

        h('div', { className: 'bf-top-actions' },
          h('button', { className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: props.onOpenTrash, title: '回收站：恢复或彻底删除已删除的 run' },
            h(Icon, { name: 'trash', size: 12 }), '回收站'),
          h('button', { className: 'bf-btn bf-btn-sm', onClick: props.onRefresh, title: '重新拉取状态与健康灯' },
            h(Icon, { name: 'refresh', size: 12 }), '刷新'),
          activeRun && isActiveStatus(activeRun.status)
            ? h('button', { className: 'bf-btn bf-btn-sm bf-btn-danger', onClick: props.onCancelRun, title: '取消当前 run（零写入）' },
              h(Icon, { name: 'stop', size: 11 }), '取消 run')
            : null))
    }

    // ----------------------------------------------------------------------
    // 左栏：对话 / 许愿 / 历史 run
    // ----------------------------------------------------------------------
    var ASK_PLACEHOLDER = '给 Bioflow 说一句话，例如：拿 GSE84433 的胃癌肝转移，按 NK 比例和原发比一下，出图'

    function MessageRow(props) {
      var message = props.message || {}
      var role = asText(message.role, 'agent')
      var isUser = role === 'user'
      var roleLabel = isUser ? '你' : role === 'system' ? '系统' : 'Bioflow'
      return h('div', { className: 'bf-msg ' + (isUser ? 'bf-msg-user' : 'bf-msg-agent') },
        h('div', { className: 'bf-msg-role' }, roleLabel),
        h('div', { className: 'bf-msg-text' }, asText(message.text, '—')),
        h('div', { className: 'bf-msg-meta' },
          h('span', { className: 'bf-mono' }, formatClock(message.at)),
          asArray(message.badges).map(function (badge, index) {
            return h(Badge, { key: index, tone: badge.tone || 'muted' }, asText(badge.label, ''))
          })))
    }

    var WISH_EXAMPLES = [
      '拿 GSE84433 的胃癌肝转移，按 NK 比例和原发比一下，出图',
      '先用 GEO 找胃癌肝转移的单细胞数据，再按供体做细胞组成比较',
      '把已登记的 bulk 数据做 tumor vs normal 差异表达 + KEGG 富集',
      '对已登记的单细胞做虚拟敲除，筛候选靶点（结果标注模型预测）',
    ]

    var WISH_FORMS = [
      { id: 'existing', label: '已有数据（已登记）' },
      { id: 'geo', label: 'GEO bulk' },
      { id: 'scrna', label: '单细胞 RNA' },
      { id: 'spatial', label: '空间转录组' },
      { id: 'metabolomics', label: '代谢组' },
      { id: 'virtualcell', label: '虚拟扰动' },
      { id: 'figure', label: '纯出图' },
    ]
    var WISH_GOALS = [
      { id: 'search', label: '先找数据' },
      { id: 'de', label: '差异表达 + 富集' },
      { id: 'composition', label: '细胞组成比较' },
      { id: 'spatial', label: '空间域 / 聚类' },
      { id: 'metabolomics', label: '代谢差异 + 通路' },
      { id: 'perturb', label: '虚拟扰动筛靶点' },
      { id: 'figure', label: '直接出图' },
    ]

    /** 套路 → 一句人话（只填进输入框，绝不自动提交）。 */
    function composeWish(form) {
      var disease = asText(form.disease, '').trim() || '胃癌肝转移'
      var target = asText(form.dataset, '').trim()
      var kase = asText(form.caseGroup, '').trim() || 'tumor'
      var control = asText(form.controlGroup, '').trim() || 'normal'
      var kind = asText(form.kind, 'existing')
      var goal = asText(form.goal, 'de')
      var lead = target
        ? '拿 ' + target
        : kind === 'existing'
          ? '用我已登记的数据'
          : kind === 'figure'
            ? '用我已登记的表'
            : '先找 ' + disease + ' 的 ' + asText((WISH_FORMS.filter(function (item) { return item.id === kind })[0] || {}).label, kind) + ' 数据'
      var goalText = {
        search: '，先给我候选数据集和尺度信息',
        de: '，按 ' + kase + ' vs ' + control + ' 做差异表达并做通路富集',
        composition: '，按 ' + kase + ' vs ' + control + ' 比较细胞类型比例（样本层），并做供体 pseudobulk',
        spatial: '，做空间聚类与空间域，再出空间高变基因图',
        metabolomics: '，按 ' + kase + ' vs ' + control + ' 做差异代谢物与通路富集',
        perturb: '，做 in silico 敲除扰动并给出候选靶点（标注 model_prediction）',
        figure: '，按分组出一张出版级图',
      }[goal] || '，先出分析计划给我确认'
      return lead + goalText + '，出图'
    }

    function TemplateWish(props) {
      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var formState = useState({ disease: '胃癌肝转移', kind: 'geo', goal: 'de', dataset: '', caseGroup: 'tumor', controlGroup: 'normal' })
      var form = formState[0]
      var setForm = formState[1]
      function patch(key, value) {
        setForm(function (previous) { return Object.assign({}, previous, { [key]: value }) })
      }
      function apply(presetKind, presetGoal) {
        var next = Object.assign({}, form, presetKind ? { kind: presetKind } : null, presetGoal ? { goal: presetGoal } : null)
        setForm(next)
        props.onCompose(composeWish(next))
      }
      return h('div', { className: 'bf-tpl' },
        h('div', { className: 'bf-chips' },
          h('span', { className: 'bf-composer-hint' }, '常用套路'),
          h('button', { type: 'button', className: 'bf-chip', onClick: function () { apply('geo', 'de') } }, 'GEO bulk 差异+富集'),
          h('button', { type: 'button', className: 'bf-chip', onClick: function () { apply('scrna', 'composition') } }, '单细胞组成'),
          h('button', { type: 'button', className: 'bf-chip', onClick: function () { apply('spatial', 'spatial') } }, '空间域'),
          h('button', { type: 'button', className: 'bf-chip', onClick: function () { apply('metabolomics', 'metabolomics') } }, '代谢差异'),
          h('button', { type: 'button', className: 'bf-chip', onClick: function () { apply('virtualcell', 'perturb') } }, '虚拟扰动'),
          h('div', { className: 'bf-spacer' }),
          h('button', {
            type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost',
            onClick: function () { setOpen(!open) }, 'aria-expanded': open ? 'true' : 'false',
          }, h(Icon, { name: open ? 'chevron' : 'plus', size: 11 }), open ? '收起自定义' : '自定义套路')),
        open
          ? h('div', { className: 'bf-tpl-grid' },
            h('label', { className: 'bf-tpl-field' }, '疾病 / 关键词',
              h('input', { className: 'bf-input bf-input-sm', value: form.disease, onChange: function (event) { patch('disease', event.target.value) }, placeholder: '如 胃癌肝转移 / lung adenocarcinoma' })),
            h('label', { className: 'bf-tpl-field' }, '数据形式',
              h('select', { className: 'bf-select bf-input-sm', value: form.kind, onChange: function (event) { patch('kind', event.target.value) } },
                WISH_FORMS.map(function (item) { return h('option', { key: item.id, value: item.id }, item.label) }))),
            h('label', { className: 'bf-tpl-field' }, '分析目标',
              h('select', { className: 'bf-select bf-input-sm', value: form.goal, onChange: function (event) { patch('goal', event.target.value) } },
                WISH_GOALS.map(function (item) { return h('option', { key: item.id, value: item.id }, item.label) }))),
            h('label', { className: 'bf-tpl-field' }, '数据集 / 编号（可空）',
              h('input', { className: 'bf-input bf-input-sm', value: form.dataset, onChange: function (event) { patch('dataset', event.target.value) }, placeholder: 'GSE#### / ds_xxx' })),
            h('label', { className: 'bf-tpl-field' }, '实验组',
              h('input', { className: 'bf-input bf-input-sm', value: form.caseGroup, onChange: function (event) { patch('caseGroup', event.target.value) }, placeholder: 'tumor' })),
            h('label', { className: 'bf-tpl-field' }, '对照组',
              h('input', { className: 'bf-input bf-input-sm', value: form.controlGroup, onChange: function (event) { patch('controlGroup', event.target.value) }, placeholder: 'normal' })),
            h('div', { className: 'bf-tpl-actions' },
              h('span', { className: 'bf-composer-hint' }, '只把话填进输入框，不提交'),
              h('div', { className: 'bf-spacer' }),
              h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', onClick: function () { props.onCompose(composeWish(form)); setOpen(false) } },
                h(Icon, { name: 'flow', size: 11 }), '套用成一句话')))
          : null)
    }

    function Composer(props) {
      var text = String(props.text || '')
      var asking = Boolean(props.asking)
      var onChange = props.onChange
      var onSend = props.onSend
      var inputRef = React.useRef ? React.useRef(null) : { current: null }
      function grow(element) {
        if (!element || !element.style) return
        element.style.height = 'auto'
        var height = Math.min(170, Math.max(46, element.scrollHeight || 46))
        element.style.height = height + 'px'
      }
      React.useEffect(function () {
        if (!text && inputRef.current && inputRef.current.focus) {
          try { inputRef.current.focus() } catch (error) { /* ignore */ }
        }
      }, [])
      function handleKeyDown(event) {
        if (!event) return
        if (isImeComposing(event)) return
        var enter = event.key === 'Enter' || event.keyCode === 13
        if (!enter) return
        if (event.shiftKey) return
        event.preventDefault()
        if (!asking && text.trim()) onSend()
      }
      return h('div', { className: 'bf-composer' },
        h('div', { className: 'bf-wish' },
          h('textarea', {
            ref: inputRef,
            className: 'bf-wish-input',
            value: text,
            rows: 2,
            placeholder: ASK_PLACEHOLDER,
            'aria-label': '许愿输入框',
            onChange: function (event) { onChange(event.target.value); grow(event.target) },
            onKeyDown: handleKeyDown,
          }),
          h('div', { className: 'bf-wish-bar' },
            h('span', { className: 'bf-composer-hint' },
              h('span', { className: 'bf-kbd' }, 'Enter'), ' 发送 · ',
              h('span', { className: 'bf-kbd' }, 'Shift'), '+', h('span', { className: 'bf-kbd' }, 'Enter'), ' 换行 · 只出 draft'),
            h('div', { className: 'bf-spacer' }),
            h('button', {
              type: 'button', className: 'bf-send', disabled: asking || !text.trim(),
              onClick: onSend, title: '发送（只生成 draft 计划，不会自动执行）', 'aria-label': '发送许愿',
            }, h(Icon, { name: asking ? 'refresh' : 'send', size: 15 })))),
        asking ? h('div', { className: 'bf-row bf-row-tight' },
          h(Icon, { name: 'refresh', size: 12 }), h('span', { className: 'bf-muted' }, '正在把这句话解析成 draft 计划…')) : null)
    }

    function HistoryPanel(props) {
      var runs = props.runs || []
      var loading = Boolean(props.loading)
      var error = props.error
      return h('div', { className: 'bf-panel', style: { flex: 'none', maxHeight: '132px' } },
        h('div', { className: 'bf-panel-head' },
          h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'clock', size: 12 }), '历史 run'),
          h('span', { className: 'bf-panel-sub' }, runs.length ? runs.length + ' 条' : '暂无'),
          h('div', { className: 'bf-panel-actions' },
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: props.onOpenTrash, title: '打开回收站（可恢复或彻底删除）' },
              h(Icon, { name: 'trash', size: 11 }), '回收站'),
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: props.onRefresh, title: '重新拉取 run 列表' },
              h(Icon, { name: 'refresh', size: 11 })))),
        h('div', { className: 'bf-panel-body' },
          error ? h(ErrorBar, { error: error, title: 'run 列表加载失败', onRetry: props.onRefresh }) : null,
          loading && !runs.length ? h(Skeleton, { lines: 2 }) : null,
          !loading && !runs.length && !error
            ? h('div', { className: 'bf-muted', style: { padding: '2px 2px 4px' } }, '暂无历史 run；提交计划后会出现在这里。')
            : h('div', { className: 'bf-runlist' }, runs.map(function (run) {
              var selected = run.runId === props.selectedRunId
              return h('div', {
                key: run.runId, role: 'button', tabIndex: 0,
                className: 'bf-runitem' + (selected ? ' bf-runitem-on' : ''),
                onClick: function () { props.onSelect(run.runId) },
                onKeyDown: function (event) { if (event && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); props.onSelect(run.runId) } },
                title: asText(run.runId, ''),
              },
                h('div', { className: 'bf-runitem-main' },
                  h(StatusBadge, { status: run.status, kind: 'run' }),
                  h('span', { className: 'bf-mono bf-truncate' }, shortId(run.runId, 26)),
                  run.zeroSignificant === true ? h(Badge, { tone: 'warn' }, '零显著') : null),
                h('div', { className: 'bf-runitem-sub' },
                  h('span', null, asText(run.template, '模板未知')),
                  h('span', null, formatClock(run.createdAt)),
                  run.datasetId ? h('span', { className: 'bf-mono' }, shortId(run.datasetId, 16)) : null,
                  h('div', { className: 'bf-spacer' }),
                  h('button', {
                    type: 'button', className: 'bf-btn bf-btn-sm bf-btn-danger',
                    title: '删除这条 run（移入 trash/runs，可恢复目录）',
                    onClick: function (event) {
                      if (event && event.stopPropagation) event.stopPropagation()
                      if (props.onDeleteRun) props.onDeleteRun(run.runId)
                    },
                  }, h(Icon, { name: 'trash', size: 10 }), '删除')))
            }))))
    }

    var FIGURE_PRESETS = [
      { id: 'proportion', label: '细胞比例箱线图（带 P 值）', need: '我想做细胞比例箱线图（组间比较带显著性），需要单细胞数据、细胞类型列和两组对比；先给候选数据和导入入口' },
      { id: 'volcano', label: '火山图 + 热图 + GO/KEGG 气泡图', need: '我想做火山图+热图+GO/KEGG 富集气泡图，需要 bulk 表达矩阵和两组分组；先给候选数据和导入入口' },
      { id: 'forest', label: '多队列森林图（Meta 合并）', need: '我想做多队列森林图（效应合并），需要至少两个可比队列和同一比较方向；先给候选队列' },
      { id: 'spatial', label: '空间分布 / 细胞共定位图', need: '我想做空间分布或细胞共定位图，需要空间转录组数据（Visium/Stereo-seq）；先给候选数据和导入入口' },
      { id: 'survival', label: '生存曲线 / 预后森林图', need: '我想做生存曲线或预后森林图，需要带随访（时间+事件）的队列；先给候选数据' },
      { id: 'umap', label: 'UMAP + Marker 点图', need: '我想做 UMAP 和 Marker 点图，需要单细胞数据并已有细胞类型注释；先给候选或导入入口' },
    ]

    // ----------------------------------------------------------------------
    // 从论文拆图：PMID / DOI / 本地 PDF / 粘贴图注 → 图注反推图型与许愿
    // ----------------------------------------------------------------------
    function PaperFigurePanel(props) {
      var api = props.api
      var modeState = useState(props.defaultMode || 'pmid')
      var mode = modeState[0]
      var setMode = modeState[1]
      var inputState = useState('')
      var input = inputState[0]
      var setInput = inputState[1]
      var captionState = useState('')
      var caption = captionState[0]
      var setCaption = captionState[1]
      var resultState = useState(props.initialResult ? { loading: false, error: null, data: props.initialResult } : { loading: false, error: null, data: null })
      var result = resultState[0]
      var setResult = resultState[1]

      var draggingState = useState(false)
      var dragging = draggingState[0]
      var setDragging = draggingState[1]
      function dispatchAction(action, body) {
        if (!api) return
        setResult({ loading: true, error: null, data: null })
        api.dispatch(Object.assign({ action: action, limit: 10 }, body)).then(function (data) {
          setResult({ loading: false, error: null, data: data })
        }).catch(function (problem) { setResult({ loading: false, error: problem, data: null }) })
      }
      function dispatch(body) { dispatchAction('paper_figures', body) }
      function handleFiles(fileList) {
        var files = Array.prototype.slice.call(fileList || [])
        if (!files.length) return
        var file = files[0]
        var isPdf = /pdf$/i.test(file.type || '') || /\.pdf$/i.test(file.name || '')
        var reader = new FileReader()
        if (isPdf) {
          if (file.size > 80 * 1024 * 1024) {
            setResult({ loading: false, error: { message: 'PDF 超过 80 MB，请拆分后再上传' }, data: null })
            return
          }
          reader.onload = function () { dispatchAction('paper_pdf', { pdf_base64: String(reader.result || ''), pdf_name: file.name }) }
        } else if (/^image\//i.test(file.type || '') || /\.(png|jpe?g|webp)$/i.test(file.name || '')) {
          if (file.size > 12 * 1024 * 1024) {
            setResult({ loading: false, error: { message: '图片超过 12 MB，请压缩后再上传' }, data: null })
            return
          }
          reader.onload = function () {
            dispatchAction('figure_from_image', {
              image_base64: String(reader.result || ''), image_name: file.name,
              figure_caption: asText(caption, '').trim() || undefined,
            })
          }
        } else {
          setResult({ loading: false, error: { message: '只支持 PDF 与 PNG/JPEG/WebP 图片' }, data: null })
          return
        }
        reader.onerror = function () { setResult({ loading: false, error: { message: '读取文件失败' }, data: null }) }
        reader.readAsDataURL(file)
      }
      function onDropFiles(event) {
        if (event && event.preventDefault) event.preventDefault()
        setDragging(false)
        var files = event && event.dataTransfer ? event.dataTransfer.files : null
        if (files && files.length) handleFiles(files)
      }
      // 宿主（Electron/聊天输入框）可能全局拦截文件拖放 → 在 window 捕获阶段接管。
      React.useEffect(function () {
        if (typeof window === 'undefined' || !window.addEventListener) return undefined
        function dragOver(event) {
          var types = event.dataTransfer && event.dataTransfer.types ? Array.prototype.slice.call(event.dataTransfer.types) : []
          if (types.indexOf('Files') < 0) return
          if (event.preventDefault) event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }
        function dragLeave(event) {
          if (!event || event.relatedTarget === null) setDragging(false)
        }
        function drop(event) {
          var files = event && event.dataTransfer ? event.dataTransfer.files : null
          if (!files || !files.length) { setDragging(false); return }
          if (event.preventDefault) event.preventDefault()
          if (event.stopPropagation) event.stopPropagation()
          setDragging(false)
          handleFiles(files)
        }
        function paste(event) {
          var items = event && event.clipboardData && event.clipboardData.items ? event.clipboardData.items : null
          if (!items) return
          var files = []
          for (var i = 0; i < items.length; i += 1) {
            var item = items[i]
            if (item.kind !== 'file') continue
            var file = item.getAsFile()
            if (file) files.push(file)
          }
          if (files.length) { event.preventDefault(); handleFiles(files) }
        }
        window.addEventListener('dragover', dragOver, true)
        window.addEventListener('dragleave', dragLeave, true)
        window.addEventListener('drop', drop, true)
        window.addEventListener('paste', paste, true)
        return function () {
          window.removeEventListener('dragover', dragOver, true)
          window.removeEventListener('dragleave', dragLeave, true)
          window.removeEventListener('drop', drop, true)
          window.removeEventListener('paste', paste, true)
        }
      }, [])
      function runFromInput() {
        var value = asText(input, '').trim()
        if (!value) return
        if (mode === 'doi') dispatch({ paper_doi: value })
        else if (mode === 'path') dispatch({ paper_path: value })
        else dispatch({ paper_pmid: value })
      }
      function runFromCaption() {
        var value = asText(caption, '').trim()
        if (!value) return
        dispatch({ figure_caption: value })
      }
      function runFromImageFile(event) {
        var file = event && event.target && event.target.files ? event.target.files[0] : null
        if (!file) return
        if (file.size > 12 * 1024 * 1024) {
          setResult({ loading: false, error: { message: '图片超过 12 MB，请压缩后再上传' }, data: null })
          return
        }
        var reader = new FileReader()
        reader.onload = function () {
          var dataUrl = String(reader.result || '')
          dispatch({ image_base64: dataUrl, image_name: file.name, figure_caption: asText(caption, '').trim() || undefined })
        }
        reader.onerror = function () { setResult({ loading: false, error: { message: '读取图片失败' }, data: null }) }
        reader.readAsDataURL(file)
      }
      var figures = asArray(result.data && result.data.figures)
      var dataFailed = result.data && result.data.ok === false
      return h('div', {
        className: 'bf-paperfig' + (dragging ? ' bf-paperfig-drag' : ''),
        onDragOver: function (event) { if (event && event.preventDefault) event.preventDefault(); setDragging(true) },
        onDragLeave: function () { setDragging(false) },
        onDrop: onDropFiles,
      },
        h('label', {
          className: 'bf-dropzone', htmlFor: 'bf-paper-file',
          style: { cursor: 'pointer' }, title: '点这里选择文件',
        },
          h(Icon, { name: 'upload', size: 13 }),
          h('span', null, '把论文 PDF / 图片拖到这里，或点这里选择；截图可直接 ⌘V 粘贴'),
          dragging ? h('b', { className: 'bf-tone-ok' }, '松手即可') : null),
        h('div', { className: 'bf-chips' },
          h('span', { className: 'bf-composer-hint' }, '来源'),
          [['pdf', '上传 PDF'], ['image', '上传图片'], ['pmid', 'PMID'], ['doi', 'DOI'], ['path', '本地 PDF 路径']].map(function (item) {
            return h('button', {
              key: item[0], type: 'button',
              className: 'bf-chip' + (mode === item[0] ? ' bf-chip-on' : ''),
              onClick: function () { setMode(item[0]) },
            }, item[1])
          })),
        mode === 'pdf'
          ? h('div', { className: 'bf-row' },
            h('input', {
              id: 'bf-paper-file',
              type: 'file', accept: 'application/pdf,.pdf', className: 'bf-input bf-input-sm',
              style: { flex: '1 1 240px' },
              onChange: function (event) { handleFiles(event && event.target ? event.target.files : null) },
            }),
            h('span', { className: 'bf-composer-hint' }, '选完自动开始识别：抽图注 + 内嵌图，前几张图走多模态'))
          : mode === 'image'
          ? h('div', { className: 'bf-row' },
            h('input', {
              type: 'file', accept: 'image/png,image/jpeg,image/webp', className: 'bf-input bf-input-sm',
              style: { flex: '1 1 240px' }, onChange: runFromImageFile,
            }),
            h('span', { className: 'bf-composer-hint' }, '交给宿主多模态模型看图（当前模型需支持图片输入）；可先在下面补图注提高准确率'))
          : h('div', { className: 'bf-row' },
            h('input', {
              className: 'bf-input bf-input-sm', style: { flex: '1 1 240px' },
              value: input,
              placeholder: mode === 'path' ? '/abs/path/paper.pdf' : mode === 'doi' ? '10.1038/s41586-...' : 'PMID（需 PMC 开放全文，如 24089192）',
              onChange: function (event) { setInput(event.target.value) },
              onKeyDown: function (event) { if (isImeComposing(event)) return; if (event.key === 'Enter') runFromInput() },
            }),
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', disabled: result.loading, onClick: runFromInput },
              h(Icon, { name: 'search', size: 11 }), result.loading ? '拆解中…' : '从论文拆图')),
        h('div', { className: 'bf-composer-hint', style: { marginTop: '6px' } }, '或者直接粘贴图注（不联网、最准）：'),
        h('div', { className: 'bf-row', style: { alignItems: 'flex-start' } },
          h('textarea', {
            className: 'bf-input bf-input-sm', rows: 4, style: { flex: '1 1 240px', resize: 'both', minHeight: '72px' },
            value: caption, placeholder: 'Figure 2. Kaplan-Meier survival curves of overall survival in gastric cancer (log-rank P=0.01)…',
            onChange: function (event) { setCaption(event.target.value) },
          }),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm', disabled: result.loading, onClick: runFromCaption }, '识别图注')),
        result.loading ? h(Skeleton, { lines: 3 }) : null,
        result.error ? h('div', { className: 'bf-inline-error' }, '拆解失败：' + asText(result.error.message || result.error, '未知错误')) : null,
        dataFailed ? h('div', { className: 'bf-inline-error' },
          asText(result.data.message || '识别失败', '识别失败'),
          result.data.next ? h('div', { className: 'bf-muted' }, '下一步：' + asText(result.data.next, '')) : null) : null,
        result.data && !figures.length
          ? h('div', { className: 'bf-inline-error' }, asText(result.data.summary, '没有拿到可用图注') + '（' + asArray(result.data.notes).join('；') + '）')
          : null,
        figures.length ? h('div', { className: 'bf-joint-list' },
          figures.map(function (figure) {
            return h('div', { key: figure.index + ':' + figure.label, className: 'bf-clinical-hit' },
              h('div', { className: 'bf-clinical-hit-title' },
                h('span', { className: 'bf-mono' }, asText(figure.label, 'Figure')),
                h('span', { className: 'bf-badge bf-badge-run' }, asText(figure.chart_label_zh, '未知图型')),
                figure.recognized_by === 'vision' ? h('span', { className: 'bf-badge bf-badge-ok' }, '多模态识别') : null,
                figure.plotlab_chart ? h('span', { className: 'bf-muted' }, ' · plotlab: ' + figure.plotlab_chart) : null,
                figure.template ? h('span', { className: 'bf-muted' }, ' · 模板 ' + figure.template) : null,
                figure.confidence !== undefined ? h('span', { className: 'bf-muted' }, ' · conf ' + figure.confidence) : null),
              figure.image_url ? h('img', {
                src: figure.image_url, alt: asText(figure.label, 'figure'),
                style: { maxWidth: '100%', maxHeight: '180px', borderRadius: '8px', border: '1px solid var(--bf-line)', margin: '4px 0' },
              }) : null,
              h('div', { className: 'bf-clinical-hit-meta bf-muted' },
                figure.page ? '第 ' + figure.page + ' 页 · ' : '',
                asText(figure.caption, '').slice(0, 260)),
              h('div', { className: 'bf-clinical-hit-meta bf-muted' }, '需要：' + asText(figure.need_data, '—')),
              h('div', { className: 'bf-joint-actions' },
                h('button', {
                  type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary',
                  onClick: function () { if (props.onCompose) props.onCompose(asText(figure.wish_text, '')); if (props.onClose) props.onClose() },
                }, h(Icon, { name: 'send', size: 11 }), '按这张图许愿')))
          })) : null)
    }

    /** 固定整屏弹层：Esc 关闭、点背景关闭、尺寸不超视口、内容自身滚动。 */
    function Overlay(props) {
      React.useEffect(function () {
        if (typeof window === 'undefined' || !window.addEventListener) return undefined
        function onKey(event) { if (event && (event.key === 'Escape' || event.keyCode === 27)) { if (props.onClose) props.onClose(event) } }
        window.addEventListener('keydown', onKey, true)
        return function () { window.removeEventListener('keydown', onKey, true) }
      }, [])
      return h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': asText(props.label, '弹窗'),
        style: {
          position: 'fixed', inset: 0, zIndex: 9999, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: '16px', boxSizing: 'border-box',
          background: 'rgba(7,26,41,.45)', backdropFilter: 'blur(6px)',
        },
        onClick: function (event) { if (props.onClose) props.onClose(event) },
      }, h('div', {
        style: {
          width: 'min(860px, calc(100vw - 32px))', maxWidth: 'calc(100vw - 32px)',
          height: 'auto', maxHeight: 'calc(100vh - 32px)', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          resize: 'both', minWidth: '420px', minHeight: '260px',
          background: '#fff', borderRadius: '18px', border: '1px solid var(--bf-line)',
          boxShadow: '0 40px 90px -50px rgba(8,60,96,.7)',
        },
        onClick: function (event) { if (event && event.stopPropagation) event.stopPropagation() },
      }, props.children))
    }

    function ChatColumn(props) {
      var messages = props.messages || []
      var figureState = useState(false)
      var figureOpen = figureState[0]
      var setFigureOpen = figureState[1]
      var figureModeState = useState('presets')
      var figureMode = figureModeState[0]
      var setFigureMode = figureModeState[1]
      var examplesState = useState(false)
      var showExamples = examplesState[0]
      var setShowExamples = examplesState[1]
      var hasConversation = messages.some(function (message) {
        return message && (message.role === 'user' || message.role === 'agent')
      })
      var feedRef = React.useRef ? React.useRef(null) : { current: null }
      React.useEffect(function () {
        var element = feedRef.current
        if (element) { try { element.scrollTop = element.scrollHeight } catch (error) { /* ignore */ } }
      }, [messages.length])
      return h('aside', { className: 'bf-side', 'aria-label': '许愿与引导' },
        h('section', { className: 'bf-panel bf-wishdeck' },
          h('div', { className: 'bf-panel-head' },
            h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'chat', size: 12 }), '许愿 · 引导'),
            h('span', { className: 'bf-panel-sub' }, '直接打字 · 只出 draft，不会自动跑 · ' + BF_UI_BUILD)),
          h('div', { className: 'bf-panel-body bf-wishdeck-body' },
            h('div', { className: 'bf-chips bf-starters' },
              h('span', { className: 'bf-composer-hint' }, '不知道从哪开始？'),
              h('button', { type: 'button', className: 'bf-chip', onClick: function () { if (props.onNavigate) props.onNavigate('wizard') } }, '我有数据'),
              h('button', { type: 'button', className: 'bf-chip', onClick: function () { if (props.onNavigate) props.onNavigate('guided') } }, '我只有方向'),
              h('button', { type: 'button', className: 'bf-chip', onClick: function () { props.onCompose('帮我找公共数据：先给候选队列和中文摘要，说明每个队列能回答什么、缺什么，再让我挑') } }, '帮我找数据'),
              h('button', { type: 'button', className: 'bf-chip', onClick: function () { setFigureOpen(true) } }, '照着图来'),
              h('button', {
                type: 'button', className: 'bf-chip bf-chip-on',
                onClick: function () { setFigureMode('paper'); setFigureOpen(true) },
              }, '论文 PDF / 图片')),
            figureOpen ? h(Overlay, {
              label: '照着图来', onClose: function () { setFigureOpen(false) },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '10px 14px', borderBottom: '1px solid var(--bf-line)', position: 'sticky', top: 0, background: '#fff', zIndex: 2 } },
                h('span', { style: { fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap' } }, '照着图来'),
                h('div', { className: 'bf-chips', style: { marginLeft: '4px' } },
                  h('button', { type: 'button', className: 'bf-chip' + (figureMode === 'presets' ? ' bf-chip-on' : ''), onClick: function () { setFigureMode('presets') } }, '常见图型'),
                  h('button', { type: 'button', className: 'bf-chip' + (figureMode === 'paper' ? ' bf-chip-on' : ''), onClick: function () { setFigureMode('paper') } }, '上传论文 PDF/图片')),
                h('div', { style: { flex: '1 1 auto' } }),
                h('button', {
                  type: 'button', className: 'bf-btn bf-btn-sm',
                  onClick: function () { setFigureOpen(false) }, title: '关闭（Esc）',
                }, h(Icon, { name: 'close', size: 12 }), '关闭 Esc')),
              h('div', { style: { padding: '10px 14px 4px' } },
                h('div', { className: 'bf-composer-hint', style: { marginBottom: '8px' } },
                  '怎么用：① 想好要哪类图 → 点「用这个图型」；② 论文里有现成图 → 点「上传论文 PDF/图片」，拖 PDF、选文件或 ⌘V 粘贴截图 → 多模态识别 → 点「按这张图许愿」。'),
                figureMode === 'presets'
                  ? h('button', {
                    type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', style: { marginBottom: '8px' },
                    onClick: function () { setFigureMode('paper') },
                  }, h(Icon, { name: 'upload', size: 12 }), '上传论文 PDF / 图片')
                  : null),
              h('div', { style: { padding: '4px 14px 10px', overflowY: 'auto', flex: '1 1 auto', minHeight: 0 } },
                figureMode === 'presets'
                  ? h('div', { className: 'bf-joint-list' }, FIGURE_PRESETS.map(function (preset) {
                    function pick() {
                      var text = asText(preset.need, '')
                      if (typeof props.onCompose === 'function') props.onCompose(text)
                      else if (typeof props.onTextChange === 'function') props.onTextChange(text)
                      setFigureOpen(false)
                    }
                    return h('div', { key: preset.id, className: 'bf-clinical-hit' },
                      h('div', { className: 'bf-clinical-hit-title', style: { whiteSpace: 'normal' } }, preset.label),
                      h('div', { className: 'bf-joint-actions' },
                        h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', onClick: pick }, '用这个图型'),
                        h('span', { className: 'bf-composer-hint' }, '点了就填进许愿框并关闭')))
                  }))
                  : h(PaperFigurePanel, {
                    api: props.api,
                    defaultMode: 'pdf',
                    onCompose: props.onCompose,
                    onClose: function () { setFigureOpen(false) },
                  })),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px', borderTop: '1px solid var(--bf-line)', background: '#fff', position: 'sticky', bottom: 0, zIndex: 2 } },
                figureMode === 'paper'
                  ? h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: function () { setFigureMode('presets') } }, '← 返回常见图型')
                  : h('span', { className: 'bf-composer-hint' }, '论文里有图？点右上「上传论文 PDF/图片」'),
                h('div', { style: { flex: '1 1 auto' } }),
                h('span', { className: 'bf-composer-hint' }, BF_UI_BUILD),
                h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: function () { setFigureOpen(false) } }, '关闭'))) : null,
            hasConversation ? null : h('button', {
              type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost bf-examples-toggle',
              onClick: function () { setShowExamples(!showExamples) },
            }, h(Icon, { name: showExamples ? 'chevron' : 'list', size: 11 }), showExamples ? '收起示例与套路' : '看示例 / 常用套路'),
            hasConversation || !showExamples ? null : h('div', { className: 'bf-feed-examples' },
              h('div', { className: 'bf-composer-hint' }, '点一个例子，或直接用下面的常用套路：'),
              WISH_EXAMPLES.slice(0, 3).map(function (example) {
                return h('button', { key: example, type: 'button', className: 'bf-example', onClick: function () { props.onCompose(example) } }, example)
              })),
            hasConversation || !showExamples ? null : h(TemplateWish, { onCompose: props.onCompose }),
            h(Composer, { text: props.text, onChange: props.onTextChange, onSend: props.onSend, asking: props.asking }))),
        h('section', { className: 'bf-panel', style: { flex: '1 1 auto', minHeight: 0 } },
          h('div', { className: 'bf-panel-head' },
            h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'flow', size: 12 }), '对话'),
            h('span', { className: 'bf-panel-sub' }, props.draftLabel ? String(props.draftLabel) : 'draft 会出现在右侧'),
            h('div', { className: 'bf-panel-actions' },
              h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: props.onClear, title: '清空对话（不影响已提交的 run）' },
                h(Icon, { name: 'trash', size: 11 }), '清空'))),
          h('div', { className: 'bf-feed', ref: feedRef }, messages.map(function (message, index) {
            return h(MessageRow, { key: message.id || index, message: message })
          }))),
        h(HistoryPanel, {
          onOpenTrash: props.onOpenTrash,
          runs: props.runs, loading: props.runsLoading, error: props.runsError,
          selectedRunId: props.selectedRunId, onSelect: props.onSelectRun, onRefresh: props.onRefreshRuns,
          onDeleteRun: props.onDeleteRun,
        }))
    }

    // ----------------------------------------------------------------------
    // 中栏：draft 计划卡
    // ----------------------------------------------------------------------
    function optionListFor(row, templates) {
      var options = asArray(row && row.candidates).map(function (candidate) {
        return {
          value: candidate.value,
          label: candidate.detail ? candidate.label + ' · ' + candidate.detail : candidate.label,
        }
      })
      if (!options.length && row && row.key === 'template') {
        options = asArray(templates).map(function (template) {
          return { value: template.id, label: template.title || template.id }
        })
      }
      if (!options.length && row && row.key === 'scale') {
        options = [
          { value: 'counts', label: '原始 counts（DESeq2/edgeR）' },
          { value: 'log_expression', label: 'log 表达（limma）' },
          { value: 'unknown', label: '不确定（只允许描述性分析）' },
        ]
      }
      return options
    }

    function SelectControl(props) {
      var row = props.row
      var options = optionListFor(row, props.templates)
      var current = isNil(row.value) ? '' : String(row.value)
      var hasCurrent = options.some(function (option) { return String(option.value) === current })
      var choices = options.slice()
      if (current && !hasCurrent) choices.unshift({ value: current, label: current + '（当前）' })
      return h('select', {
        className: 'bf-select' + (row.missing && !current ? ' bf-field-error' : ''),
        value: current,
        'aria-label': row.label,
        disabled: props.disabled,
        onChange: function (event) { props.onChange(event.target.value) },
      },
        h('option', { value: '' }, '— 待选择 —'),
        choices.map(function (option, index) {
          return h('option', { key: index, value: String(option.value) }, asText(option.label, String(option.value)))
        }))
    }

    function ContrastControl(props) {
      var row = props.row
      var groups = contrastGroupOptions(row)
      var current = normalizeContrast(row.value) || { case: '', control: '' }
      function pick(part, value) {
        var next = { case: current.case, control: current.control }
        next[part] = value
        props.onChange(next)
      }
      function renderSelect(part, value, labelText) {
        var choices = groups.slice()
        if (value && choices.indexOf(value) < 0) choices.push(value)
        return h('label', { className: 'bf-col', style: { flex: '1 1 120px', gap: '2px' } },
          h('span', { className: 'bf-muted' }, labelText),
          h('select', {
            className: 'bf-select bf-input-sm',
            value: value || '',
            disabled: props.disabled,
            'aria-label': row.label + ' ' + labelText,
            onChange: function (event) { pick(part, event.target.value) },
          },
            h('option', { value: '' }, '— 待选择 —'),
            choices.map(function (group) { return h('option', { key: group, value: group }, group) })))
      }
      return h('div', { className: 'bf-col', style: { gap: '4px' } },
        h('div', { className: 'bf-row bf-row-tight' },
          renderSelect('case', current.case, 'case（实验组）'),
          h('span', { className: 'bf-muted', style: { paddingTop: '12px' } }, 'vs'),
          renderSelect('control', current.control, 'control（对照组）')),
        h('div', { className: 'bf-muted' }, 'logFC = case − control；方向写反结论就反了'),
        asArray(row.candidates).length
          ? h('div', { className: 'bf-cands' }, asArray(row.candidates).map(function (candidate, index) {
            return h('button', {
              key: index, type: 'button', className: 'bf-cand' + (displayValue(candidate.value) === fieldDisplay('contrast', row.value) ? ' bf-cand-on' : ''),
              title: asText(candidate.detail, ''),
              onClick: function () { props.onPick(candidate) },
            }, asText(candidate.label, displayValue(candidate.value)))
          }))
          : null)
    }

    function FdrControl(props) {
      var row = props.row
      var value = parseFdrFamily(row.value)
      var methods = ['BH', 'BY', 'bonferroni', 'none']
      var alphas = [0.05, 0.01, 0.1, 0.2]
      if (alphas.indexOf(value.alpha) < 0 && Number.isFinite(Number(value.alpha))) alphas.push(Number(value.alpha))
      function update(patch) {
        props.onChange({ method: patch.method || value.method, alpha: patch.alpha !== undefined ? patch.alpha : value.alpha })
      }
      return h('div', { className: 'bf-row bf-row-tight' },
        h('select', {
          className: 'bf-select bf-input-sm', style: { width: 'auto' }, value: value.method, disabled: props.disabled,
          'aria-label': 'FDR 方法', onChange: function (event) { update({ method: event.target.value }) },
        }, methods.map(function (method) { return h('option', { key: method, value: method }, method) })),
        h('select', {
          className: 'bf-select bf-input-sm', style: { width: 'auto' }, value: String(value.alpha), disabled: props.disabled,
          'aria-label': 'FDR 阈值', onChange: function (event) { update({ alpha: Number(event.target.value) }) },
        }, alphas.map(function (alpha) { return h('option', { key: alpha, value: String(alpha) }, 'α = ' + alpha) })))
    }

    function DeliverablesControl(props) {
      var row = props.row
      var selected = asArray(row.value).map(function (item) { return String(item) })
      if (!selected.length) selected = DELIVERABLES.map(function (item) { return item.key })
      return h('div', { className: 'bf-cands' }, DELIVERABLES.map(function (item) {
        var on = selected.indexOf(item.key) >= 0
        return h('button', {
          key: item.key, type: 'button',
          className: 'bf-cand' + (on ? ' bf-cand-on' : ''),
          title: (on ? '点击取消：' : '点击选中：') + item.label,
          onClick: function () {
            var next = on
              ? selected.filter(function (key) { return key !== item.key })
              : selected.concat([item.key])
            props.onChange(next)
          },
        }, item.label)
      }))
    }

    function PlanField(props) {
      var row = props.row
      var disabled = Boolean(props.disabled)
      function renderControl() {
        if (row.kind === 'contrast') {
          return h(ContrastControl, {
            row: row, disabled: disabled,
            onChange: function (value) { props.onEdit(row.key, value) },
            onPick: function (candidate) { props.onEdit(row.key, candidate.value) },
          })
        }
        if (row.kind === 'toggle') {
          var paired = row.value === true
          return h('div', { className: 'bf-toggle', role: 'group', 'aria-label': row.label },
            h('button', { type: 'button', className: paired ? 'bf-on' : '', disabled: disabled, onClick: function () { props.onEdit(row.key, true) } }, '配对'),
            h('button', { type: 'button', className: paired ? '' : 'bf-on', disabled: disabled, onClick: function () { props.onEdit(row.key, false) } }, '独立样本'))
        }
        if (row.kind === 'number') {
          return h('input', {
            className: 'bf-input bf-input-sm', type: 'number', min: 1, step: 1,
            value: isNil(row.value) ? '' : String(row.value), disabled: disabled,
            'aria-label': row.label,
            placeholder: '默认 10',
            onChange: function (event) {
              var next = event.target.value === '' ? null : Number(event.target.value)
              props.onEdit(row.key, next)
            },
          })
        }
        if (row.kind === 'fdr') {
          return h(FdrControl, { row: row, disabled: disabled, onChange: function (value) { props.onEdit(row.key, value) } })
        }
        if (row.kind === 'deliverables') {
          return h(DeliverablesControl, { row: row, disabled: disabled, onChange: function (value) { props.onEdit(row.key, value) } })
        }
        if (row.kind === 'select') {
          return h(SelectControl, {
            row: row, templates: props.templates, disabled: disabled,
            onChange: function (value) { props.onEdit(row.key, value) },
          })
        }
        var textValue = row.key === 'covariates'
          ? asArray(row.value).join(', ')
          : (isNil(row.value) ? '' : String(row.value))
        return h('input', {
          className: 'bf-input bf-input-sm', type: 'text', value: textValue, disabled: disabled,
          'aria-label': row.label,
          placeholder: row.key === 'covariates' ? '逗号分隔，如 batch, sex（可留空）' : row.key === 'endpoint' ? '如 OS / PFS（可留空）' : '可留空',
          onChange: function (event) {
            var raw = event.target.value
            if (row.key === 'covariates') {
              props.onEdit(row.key, raw.split(/[,，\s]+/).map(function (item) { return item.trim() }).filter(Boolean))
            } else {
              props.onEdit(row.key, raw)
            }
          },
        })
      }
      return h('div', { className: 'bf-field' + (row.missing ? ' bf-field-missing' : '') },
        h('div', { className: 'bf-field-label' },
          atSign(row.label),
          row.missing ? h('span', { className: 'bf-field-miss-tag' }, '待补') : null,
          row.edited ? h('span', { className: 'bf-badge' }, '已改') : null),
        h('div', { className: 'bf-field-body' },
          renderControl(),
          h('div', { className: 'bf-field-why' }, row.why),
          row.question ? h('div', { className: 'bf-field-why bf-tone-warn' }, 'agent 追问：' + row.question) : null,
          !row.missing && !row.empty && row.display !== '—'
            ? h('div', { className: 'bf-field-why' }, '当前：' + row.display)
            : null,
          row.missing && row.candidates.length
            ? h('div', { className: 'bf-cands' }, row.candidates.slice(0, 8).map(function (candidate, index) {
              var on = displayValue(candidate.value) === row.display
              return h('button', {
                key: index, type: 'button',
                className: 'bf-cand' + (on ? ' bf-cand-on' : ''),
                title: asText(candidate.detail, ''),
                disabled: disabled,
                onClick: function () { props.onEdit(row.key, candidate.value) },
              }, asText(candidate.label, displayValue(candidate.value)))
            }))
            : null))
    }

    function atSign(text) {
      return h('span', null, asText(text, ''))
    }

    function PlanCard(props) {
      var draft = props.draft
      var submittedRunId = asText(props.submittedRunId, '')
      var submit = props.submit || {}
      var feedbackOpenState = useState(false)
      var feedbackOpen = feedbackOpenState[0]
      var setFeedbackOpen = feedbackOpenState[1]
      var feedbackTextState = useState('')
      var feedbackText = feedbackTextState[0]
      var setFeedbackText = feedbackTextState[1]

      if (!draft) {
        if (props.asking) {
          return h('div', { className: 'bf-card' },
            h('div', { className: 'bf-card-head' },
              h('span', { className: 'bf-card-title' }, h(Icon, { name: 'refresh', size: 14 }), '正在解析…'),
              h(Badge, { tone: 'run' }, '解析中')),
            h(Skeleton, { lines: 5, thick: true }),
            h('div', { className: 'bf-muted' }, '正在把许愿拆成 draft 计划草案；不会自动执行。'))
        }
        return h('div', { className: 'bf-card bf-card-compact' },
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, h(Icon, { name: 'shield', size: 14 }), '计划草案'),
            h(Badge, { tone: 'muted' }, '等待许愿')),
          h('div', { className: 'bf-muted', style: { padding: '2px 2px 8px', lineHeight: '1.6' } },
            props.statusSuggestion || '在左栏说一句话（Enter 发送）。只出 draft：字段逐条可改，缺的给候选；你确认后才提交成不可变 run。'))
      }

      var rows = planFieldRows(draft, props.edits)
      var missingCount = rows.filter(function (row) { return row.missing }).length
      var disabled = Boolean(submittedRunId) || Boolean(props.syncing) || Boolean(props.asking) || Boolean(submit.running)
      var blocked = asArray(props.submitBlocked)
      var submitError = props.submitError
      var statsPreview = draft.statsPreview || null
      var previewWarns = statsPreview ? asArray(statsPreview.caveats).filter(function (item) { return item.level === 'warn' }) : []
      var ready = Boolean(draft.planId && draft.confirmToken)
      var missingFields = asArray(draft.missing)
      var hardMissing = missingFields.some(function (field) { return field === 'dataset' || field === 'contrast' || field === 'template' })
      var healthLevel = blocked.length || hardMissing ? 'red' : (missingCount ? 'yellow' : 'green')
      var healthText = healthLevel === 'red'
        ? '红灯：还差关键条件，先补齐再提交'
        : healthLevel === 'yellow'
          ? '黄灯：可以跑，但还有字段建议确认'
          : '绿灯：条件齐备，可以确认运行'
      var firstQuestion = asArray(draft.questions)[0] || null
      var firstCandidates = firstQuestion ? asArray(firstQuestion.candidates).slice(0, 4) : []

      return h('div', { className: 'bf-card' + (submittedRunId ? ' bf-card-muted' : '') },
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, h(Icon, { name: 'shield', size: 15 }), '计划草案'),
          h(Badge, { tone: submittedRunId ? 'ok' : 'warn', mono: true }, submittedRunId ? '已提交' : 'draft · 待确认'),
          draft.template ? h(Badge, { mono: true }, draft.template) : null,
          missingCount ? h(Badge, { tone: 'warn' }, missingCount + ' 个字段待补') : h(Badge, { tone: 'ok' }, '字段齐备'),
          props.syncing ? h(Badge, { tone: 'run' }, h(Dot, { tone: 'run' }), '按改动重算') : null,
          props.asking ? h(Badge, { tone: 'run' }, h(Dot, { tone: 'run' }), '解析新许愿…') : null,
          h('div', { className: 'bf-panel-actions' },
            draft.planId ? h('span', { className: 'bf-row bf-row-tight' },
              h(Mono, { style: { fontSize: '11px', color: 'var(--bf-ink-2)' } }, 'plan ' + shortId(draft.planId, 22)),
              h(CopyButton, { text: draft.planId, onCopy: props.onCopy, title: '复制 plan_id' })) : null)),

        draft.summary ? h('div', { className: 'bf-note' }, draft.summary) : null,
        draft.warnings.length ? h('div', { className: 'bf-warnbox' },
          h('div', { className: 'bf-row bf-row-tight' }, h(Icon, { name: 'alert', size: 12 }), h('b', null, '解析提示')),
          draft.warnings.slice(0, 6).map(function (warning, index) {
            return h('div', { key: index }, '· ' + warning)
          })) : null,
        h('div', { className: 'bf-health bf-health-' + healthLevel },
          h('span', { className: 'bf-health-dot' }),
          h('span', null, healthText),
          h('div', { className: 'bf-spacer' }),
          missingFields.length ? h('span', { className: 'bf-muted' }, '待定：' + missingFields.join('、')) : null),
        statsPreview ? h(Collapsible, {
          title: '提交前口径预览（还来得及改）',
          meta: previewWarns.length ? previewWarns.length + ' 项待注意' : '无待注意项',
          defaultOpen: previewWarns.length > 0,
        }, h('div', { className: 'bf-col' },
          h(StatsChips, { contract: statsPreview }),
          previewWarns.length
            ? h('div', { className: 'bf-warnbox' },
              h('div', { className: 'bf-row bf-row-tight' }, h(Icon, { name: 'alert', size: 12 }), h('b', null, '现在改还来得及')),
              previewWarns.map(function (item, index) { return h('div', { key: index }, '· ' + item.text) }))
            : null,
          h('div', { className: 'bf-muted' },
            '这里显示的是「按当前字段提交会用什么统计口径」：对比方向、检验、校正家族与 alpha、每组样本/供体数、数据尺度是否已验证。提交后写进 manifest 与 evidence，run 完成可在右栏「口径」页签回查。')))
        : null,
        firstQuestion && firstCandidates.length ? h('div', { className: 'bf-warnbox' },
          h('div', { className: 'bf-row bf-row-tight' }, h(Icon, { name: 'chat', size: 12 }), h('b', null, '下一步只问一件事')),
          h('div', null, firstQuestion.question || ('请确认 ' + firstQuestion.field)),
          h('div', { className: 'bf-chips' }, firstCandidates.map(function (candidate, index) {
            return h('button', {
              key: index, type: 'button', className: 'bf-chip',
              onClick: function () { props.onEdit(firstQuestion.field, candidate.value) },
            }, asText(candidate.label, candidate.value))
          }))) : null,
        asArray(draft.limitations).length ? h('div', { className: 'bf-warnbox' },
          h('div', { className: 'bf-row bf-row-tight' }, h(Icon, { name: 'info', size: 12 }), h('b', null, '这次能回答什么 / 不能回答什么')),
          asArray(draft.limitations).map(function (item, index) { return h('div', { key: index }, '· ' + item) })) : null,
        blocked.length ? h('div', { className: 'bf-warnbox' },
          h('div', { className: 'bf-row bf-row-tight' }, h(Icon, { name: 'shield', size: 12 }), h('b', null, '被闸门拦下，不能提交')),
          blocked.map(function (gate, index) {
            return h('div', { key: index, className: 'bf-gate' },
              h('div', { className: 'bf-gate-id' }, asText(gate.id, 'gate') + ' · ' + asText(gate.title, '')),
              h('div', { className: 'bf-gate-detail' }, asText(gate.detail, '缺前置条件/参数')),
              asArray(gate.fixes).length ? h('div', { className: 'bf-gate-fixes' }, asArray(gate.fixes).map(function (fix, fixIndex) {
                return h('span', { key: fixIndex }, '→ ' + asText(fix, ''))
              })) : null)
          })) : null,
        submitError ? h(ErrorBar, { error: submitError, title: '提交失败', onRetry: props.onRetrySubmit }) : null,

        h('div', { className: 'bf-fields' }, rows.map(function (row) {
          return h(PlanField, {
            key: row.key, row: row, templates: props.templates, disabled: disabled,
            onEdit: props.onEdit,
          })
        })),

        draft.gates.length ? h(Collapsible, {
          title: '闸门预览（plan 阶段）',
          meta: draft.gates.filter(function (gate) { return gate.status !== 'pass' }).length + ' 项非 pass',
        }, h('div', { className: 'bf-col' }, draft.gates.map(function (gate, index) {
          var failed = ['fail', 'failed', 'blocked'].indexOf(String(gate.status)) >= 0
          return h('div', { key: index, className: 'bf-row bf-row-tight' },
            h(Badge, { tone: failed ? 'blocked' : 'ok' }, asText(gate.status, '?')),
            h(Mono, null, asText(gate.id, 'gate')),
            h('span', { className: 'bf-muted' }, asText(gate.detail, '')))
        }))) : null,

        submittedRunId
          ? h('div', { className: 'bf-warnbox' },
            h('div', { className: 'bf-row bf-row-tight' },
              h(Icon, { name: 'check', size: 13 }), h('b', null, '已提交 · run_id'),
              h(Mono, { title: submittedRunId }, submittedRunId),
              h(CopyButton, { text: submittedRunId, onCopy: props.onCopy, title: '复制 run_id' }),
              h('div', { className: 'bf-spacer' }),
              h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: props.onFocusTimeline }, '查看时间线')),
            props.submitReused ? h('div', { className: 'bf-muted' }, '同参数 run 已存在，已复用（幂等），不会重复执行。') : null,
            h('div', { className: 'bf-muted' }, '这张卡已冻结；改字段请重新许愿或点下方「让 agent 再想想」。'))
          : h('div', { className: 'bf-col' },
            feedbackOpen
              ? h('div', { className: 'bf-col' },
                h('textarea', {
                  className: 'bf-textarea', rows: 2, value: feedbackText,
                  placeholder: '告诉 agent 哪里不对 / 想怎么改，例如"对照组换成 adjacent，做配对，FDR 用 BY"',
                  'aria-label': '反馈给 agent',
                  onChange: function (event) { setFeedbackText(event.target.value) },
                }),
                h('div', { className: 'bf-row bf-row-tight' },
                  h('button', {
                    type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary',
                    disabled: props.syncing || !(feedbackText.trim() || Object.keys(props.edits || {}).length),
                    onClick: function () {
                      props.onRegenerate(feedbackText, Object.keys(props.edits || {}).length > 0)
                      setFeedbackText('')
                      setFeedbackOpen(false)
                    },
                  }, h(Icon, { name: 'refresh', size: 11 }), '重新生成草案'),
                  h('button', {
                    type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost',
                    onClick: function () { setFeedbackOpen(false) },
                  }, '收起')))
              : null,
            h('div', { className: 'bf-row' },
              h('button', {
                type: 'button', className: 'bf-btn bf-btn-primary',
                disabled: disabled || !ready,
                title: ready ? '带 plan_id + confirm_token 提交成不可变 run' : '缺少 plan_id / confirm_token，先让 agent 生成草案',
                onClick: props.onSubmit,
              }, submit.running ? h(Icon, { name: 'refresh', size: 12 }) : h(Icon, { name: 'play', size: 12 }),
                submit.running ? '提交中…' : '确认并提交'),
              h('button', {
                type: 'button', className: 'bf-btn',
                disabled: disabled,
                onClick: function () { setFeedbackOpen(!feedbackOpen) },
                title: '把反馈并进 ask，重新生成 draft（confirm_token 会更新）',
              }, h(Icon, { name: 'refresh', size: 12 }), '让 agent 再想想'),
              h('div', { className: 'bf-spacer' }),
              h('span', { className: 'bf-muted' }, '提交 = 冻结计划，写不可变 run；不会二次确认'))))
    }

    // ----------------------------------------------------------------------
    // 中栏：流水线时间线
    // ----------------------------------------------------------------------
    var STEP_ICONS = {
      ok: 'check', failed: 'alert', running: 'refresh', queued: 'clock',
      pending: 'info', pending_review: 'info', blocked: 'shield',
      cancelled: 'close', partial: 'alert', skipped: 'minus', unknown: 'info',
    }

    function stepDisplayName(step) {
      var item = step || {}
      if (item.stepId) return item.stepId
      var pieces = [asText(item.plugin, ''), asText(item.action, '')].filter(Boolean)
      return pieces.length ? pieces.join('.') : 'step'
    }

    function runParamsOf(runStatus) {
      var raw = runStatus && runStatus.raw ? runStatus.raw : {}
      var run = raw.run && typeof raw.run === 'object' ? raw.run : raw
      if (run.params && typeof run.params === 'object' && Object.keys(run.params).length) return run.params
      if (run.plan && run.plan.params && typeof run.plan.params === 'object' && Object.keys(run.plan.params).length) return run.plan.params
      return null
    }

    function findManifestStep(manifest, stepId) {
      var data = manifest && typeof manifest === 'object' && !manifest.raw ? manifest : null
      if (!data) return null
      var list = asArray(data.steps)
      for (var index = 0; index < list.length; index += 1) {
        if (list[index] && String(list[index].step_id || '') === String(stepId || '')) return list[index]
      }
      return null
    }

    function StepRow(props) {
      var step = props.step || {}
      var status = normalizeStepStatus(step.status)
      var meta = stepStatusMeta(status)
      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var manifestStep = props.manifestStep
      var planStep = props.planStep || null
      var params = step.params || (planStep && planStep.params) || null
      var stderr = step.stderr || step.error || ''
      var isFailed = status === 'failed'
      return h('div', { className: 'bf-step' + (open ? ' bf-step-open' : '') },
        h('button', {
          type: 'button', className: 'bf-step-head',
          'aria-expanded': open ? 'true' : 'false',
          onClick: function () {
            setOpen(!open)
            if (!open && typeof props.onExpand === 'function') props.onExpand()
          },
        },
          h('span', { className: 'bf-step-index' }, pad2(props.index + 1)),
          h('span', { className: 'bf-tone-' + meta.tone, style: { display: 'inline-flex' } },
            h(Icon, { name: STEP_ICONS[status] || 'info', size: 13 })),
          h('span', { className: 'bf-step-name', title: stepDisplayName(step) }, stepDisplayName(step)),
          h('span', { className: 'bf-step-plugin' },
            [asText(step.plugin, ''), asText(step.action, '')].filter(Boolean).join('.') || '—'),
          h('span', { className: 'bf-step-right' },
            step.attempts > 1 ? h(Badge, { mono: true }, '尝试 ' + step.attempts) : null,
            h(StatusBadge, { status: step.status }),
            h('span', { className: 'bf-step-time' }, step.durationMs !== null ? formatDuration(step.durationMs) : (isActiveStatus(step.status) ? '进行中' : '—')),
            h('span', { className: 'bf-step-chevron' + (open ? ' bf-step-chevron-on' : '') }, h(Icon, { name: 'chevron', size: 12 })))),

        open ? h('div', { className: 'bf-step-body' },
          h('div', { className: 'bf-kv' },
            h(KvRow, { label: 'step_id', value: asText(step.stepId, '—') }),
            h(KvRow, { label: 'plugin', value: asText(step.plugin, '—') }),
            h(KvRow, { label: 'action', value: asText(step.action, '—') }),
            h(KvRow, { label: 'deliver', value: asText(step.deliver, '—') }),
            h(KvRow, { label: '开始', value: step.startedAt ? formatLocalTime(step.startedAt) : '—' }),
            h(KvRow, { label: '结束', value: step.finishedAt ? formatLocalTime(step.finishedAt) : '—' }),
            h(KvRow, { label: '耗时', value: step.durationMs !== null ? formatDuration(step.durationMs) : '—' }),
            manifestStep ? h(KvRow, { label: '产物', value: '表 ' + asArray(manifestStep.tables).length + ' · 图 ' + asArray(manifestStep.figures).length }) : null),

          params
            ? h('div', { className: 'bf-col' },
              h('div', { className: 'bf-subhead' }, h(Icon, { name: 'list', size: 11 }), 'step params'),
              h(PreBlock, { text: safeJson(params), limit: 4000 }))
            : h('div', { className: 'bf-col' },
              h('div', { className: 'bf-subhead' }, h(Icon, { name: 'list', size: 11 }), 'step params'),
              h('div', { className: 'bf-muted' }, 'run_status 未回传该 step 的 params；展开查看本次 run 参数。'),
              props.runParams
                ? h(Collapsible, { title: '本次 run 参数', meta: 'plan.params', defaultOpen: false },
                  h(PreBlock, { text: safeJson(props.runParams), limit: 5000 }))
                : h('div', { className: 'bf-muted' }, '没有可显示的参数。')),

          isFailed
            ? h('div', { className: 'bf-warnbox' },
              h('div', { className: 'bf-row bf-row-tight' }, h(Icon, { name: 'alert', size: 12 }), h('b', null, '失败原因')),
              h('pre', { className: 'bf-pre' }, tail(asText(step.error, '引擎未返回 error'), 2400)),
              h('div', { className: 'bf-subhead' }, '下一步能做什么'),
              h('div', null, asText(props.runNext,
                '看 step.error；检查插件是否可用 / 数据尺度是否已验证 / 前置产物是否存在；修好后重新 plan→submit（同输入同 run 不会重复执行）。')))
            : null,

          h('div', { className: 'bf-col' },
            h('div', { className: 'bf-subhead' }, h(Icon, { name: 'file', size: 11 }), 'stderr / 日志尾部'),
            stderr
              ? h(PreBlock, { text: tail(stderr, 3000), limit: 3000 })
              : h('div', { className: 'bf-muted' }, '没有 stderr（本次步骤没有输出日志）。')),

          manifestStep
            ? h('div', { className: 'bf-row bf-row-tight' },
              asArray(manifestStep.tables).map(function (id, index) {
                return h(Badge, { key: 't' + index, mono: true }, asText(id, 'table'))
              }),
              asArray(manifestStep.figures).map(function (id, index) {
                return h(Badge, { key: 'f' + index, tone: 'run', mono: true }, asText(id, 'figure'))
              }))
            : null)
          : null)
    }

    function Timeline(props) {
      var runStatus = props.runStatus
      var loading = Boolean(props.loading)
      var error = props.error
      var steps = runStatus ? asArray(runStatus.steps) : []
      var progress = runStatus ? runStatus.progress : { done: 0, total: 0, pct: 0 }
      var active = runStatus && isActiveStatus(runStatus.status)
      var blockedGates = runStatus ? asArray(runStatus.blockedGates) : []
      var showEmpty = !loading && !runStatus && !error

      return h('div', { className: 'bf-panel', style: { flex: '1 1 auto', minHeight: '300px' }, ref: props.panelRef },
        h('div', { className: 'bf-panel-head' },
          h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'flow', size: 12 }), '流水线'),
          runStatus && runStatus.runId
            ? h('span', { className: 'bf-panel-sub' },
              h('span', { className: 'bf-mono' }, shortId(runStatus.runId, 26)),
              h('span', { className: 'bf-muted' }, ' · ' + formatRelative(runStatus.updatedAtIso, Date.now())))
            : h('span', { className: 'bf-panel-sub' }, '提交后逐步推进'),
          runStatus ? h(StatusBadge, { status: runStatus.status, kind: 'run' }) : null,
          h('div', { className: 'bf-panel-actions' },
            runStatus && progress.total
              ? h('span', { className: 'bf-row bf-row-tight', style: { minWidth: '124px' } },
                h(ProgressBar, { value: progress.pct, title: progress.done + '/' + progress.total })
                  , h('span', { className: 'bf-step-time' }, progress.done + '/' + progress.total))
              : null,
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: props.onRefresh, title: '刷新当前 run 状态' },
              h(Icon, { name: 'refresh', size: 11 })),
            runStatus && runStatus.runDir
              ? h('button', {
                type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost',
                title: '复制 run 目录绝对路径：' + runStatus.runDir,
                onClick: function () { props.onCopy(runStatus.runDir) },
              }, h(Icon, { name: 'copy', size: 11 }))
              : null,
            active
              ? h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-danger', onClick: props.onCancel },
                h(Icon, { name: 'stop', size: 11 }), '停止等待')
              : null)),

        h('div', { className: 'bf-panel-body' },
          error ? h(ErrorBar, { error: error, title: 'run_status 加载失败', onRetry: props.onRefresh }) : null,
          loading && !runStatus ? h(Skeleton, { lines: 4 }) : null,
          showEmpty
            ? h(EmptyState, {
              icon: 'flow',
              title: '时间线还是空的',
              sub: '确认计划提交后会生成不可变 run，每个 step 一行：状态徽章 + 耗时，点开看 params 与 stderr 尾部。',
            })
            : null,

          runStatus ? h('div', { className: 'bf-col' },
            runStatus.summary ? h('div', { className: 'bf-note' }, runStatus.summary) : null,
            runStatus.statsContract ? h(StatsChips, { contract: runStatus.statsContract }) : null,            runStatus.summary ? h('div', { className: 'bf-note' }, runStatus.summary) : null,
            runStatus.zeroSignificant === true
              ? h('div', { className: 'bf-warnbox' },
                h('div', { className: 'bf-row bf-row-tight' }, h(Icon, { name: 'alert', size: 12 }), h('b', null, '零显著')),
                h('div', null, '本次分析未检出显著结果（零显著）；这不等同于「无差异」，请结合 CI 与有效 n。'))
              : null,
            runStatus.error ? h('div', { className: 'bf-warnbox' },
              h('div', { className: 'bf-row bf-row-tight' }, h(Icon, { name: 'alert', size: 12 }), h('b', null, 'run 级错误')),
              h('div', { className: 'bf-break' }, runStatus.error)) : null,
            blockedGates.length ? h('div', { className: 'bf-col' },
              h('div', { className: 'bf-subhead' }, h(Icon, { name: 'shield', size: 11 }), '拦在哪条闸门 / 缺什么'),
              blockedGates.map(function (gate, index) {
                return h('div', { key: index, className: 'bf-gate' },
                  h('div', { className: 'bf-gate-id' }, asText(gate.id, 'gate') + ' · ' + asText(gate.title, '')),
                  h('div', { className: 'bf-gate-detail' }, asText(gate.detail, '缺前置条件/参数')))
              })) : null,
            runStatus.status === 'blocked' && !blockedGates.length
              ? h('div', { className: 'bf-warnbox' },
                h('div', { className: 'bf-row bf-row-tight' }, h(Icon, { name: 'shield', size: 12 }), h('b', null, 'run 被闸门拦下')),
                h('div', null, asText(runStatus.next, '看 gates；补样本表/尺度/对照重复后重新 plan。')))
              : null,
            runStatus.next
              ? h('div', { className: 'bf-note' }, '下一步：' + runStatus.next)
              : null,
            asArray(runStatus.warnings).length
              ? h(Collapsible, { title: 'run warnings', meta: String(runStatus.warnings.length) },
                h('div', { className: 'bf-col' }, runStatus.warnings.map(function (warning, index) {
                  return h('div', { key: index, className: 'bf-muted' }, '· ' + warning)
                })))
              : null,
            h('div', { className: 'bf-timeline' }, steps.map(function (step, index) {
              var planSteps = runStatus.plan ? asArray(runStatus.plan.steps) : []
              var planStep = planSteps.filter(function (item) { return item.stepId === step.stepId })[0] || null
              return h(StepRow, {
                key: asText(step.stepId, 'step-' + index), step: step, index: index,
                manifestStep: findManifestStep(props.manifest, step.stepId),
                planStep: planStep,
                runParams: runParamsOf(runStatus),
                runNext: runStatus.next,
                onExpand: props.onExpand,
              })
            })))
            : null))
    }

    // ----------------------------------------------------------------------
    // 右栏：数据源检索（五源 Tab）
    // ----------------------------------------------------------------------
    var SCALE_TONE_CLASS = { info: 'bf-badge-run', warn: 'bf-badge-warn', muted: '' }

    function SearchResultRow(props) {
      var item = props.item || {}
      var selected = Boolean(props.selected)
      var scale = scaleMeta(item.scale)
      var meta = []
      if (item.species) meta.push(h('span', { key: 'species', className: 'bf-tag' }, item.species))
      if (!isNil(item.nSamples)) meta.push(h('span', { key: 'n', className: 'bf-tag' }, 'n=' + formatNumber(item.nSamples)))
      if (item.platform) meta.push(h('span', { key: 'platform', className: 'bf-tag', title: item.platform }, item.platform))
      if (item.scale) meta.push(h('span', { key: 'scale', className: 'bf-badge ' + (SCALE_TONE_CLASS[scale.tone] || '') }, scale.label))
      if (item.studyType) meta.push(h('span', { key: 'study', className: 'bf-tag' }, item.studyType))
      meta.push(h('span', { key: 'clinical', className: 'bf-badge ' + (item.clinicalAvailable ? 'bf-badge-ok' : '') },
        item.clinicalAvailable ? '临床可用' : '无临床'))
      meta.push(h('span', { key: 'attach', className: 'bf-tag' },
        '附件 ' + (item.attachments.length ? item.attachments.length : '—')))
      if (item.openAccess) meta.push(h('span', { key: 'oa', className: 'bf-badge bf-badge-ok' }, '开放获取'))
      if (!isNil(item.year)) meta.push(h('span', { key: 'year', className: 'bf-tag' }, String(item.year)))
      if (item.journal) meta.push(h('span', { key: 'journal', className: 'bf-tag', title: item.journal }, item.journal))
      if (item.evidenceStrength) meta.push(h('span', { key: 'strength', className: 'bf-tag' }, item.evidenceStrength))

      return h('label', {
        className: 'bf-result' + (selected ? ' bf-result-on' : ''),
        title: asText(item.summary || item.title, asText(item.id, '')),
      },
        h('input', {
          type: 'checkbox', className: 'bf-check', checked: selected,
          'aria-label': '选择 ' + asText(item.id, ''),
          onChange: function () { props.onToggle(item) },
        }),
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'bf-result-id' }, asText(item.id, '—')),
          h('div', { className: 'bf-result-title' }, asText(item.title, '（无标题）')),
          h('div', { className: 'bf-result-meta' }, meta)))
    }

    function SourceSearch(props) {
      var tab = asText(props.tab, 'geo')
      var tabMeta = findSourceTab(tab) || SOURCE_TABS[0]
      var entry = props.health && props.health.sources ? props.health.sources[tab] : null
      var healthInfo = healthMeta(entry && entry.status)
      var state = (props.cache && props.cache[tab]) || { query: '', loading: false, error: null, data: null }
      var items = state.data ? searchItemsFor(state.data, tab) : []
      var selectedCount = Object.keys(props.selection || {}).length
      var probing = props.probe && props.probe.source === tab && props.probe.loading
      var failedForTab = state.data
        ? asArray(state.data.sourcesFailed).filter(function (item) { return item.source === tab })[0]
        : null
      return h('div', { className: 'bf-panel', style: { flex: '1 1 34%', minHeight: '220px' } },
        h('div', { className: 'bf-panel-head' },
          h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'search', size: 12 }), '数据源检索'),
          h('div', { className: 'bf-panel-actions' },
            h('button', {
              type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost',
              onClick: function () { props.onProbe(tab) },
              title: '重新探活当前数据源',
            }, h(Icon, { name: 'refresh', size: 11 }), '探活'))),
        h('div', { className: 'bf-tabs', role: 'tablist' },
          SOURCE_TABS.map(function (sourceTab) {
            var sourceEntry = props.health && props.health.sources ? props.health.sources[sourceTab.id] : null
            var sourceHealth = healthMeta(sourceEntry && sourceEntry.status)
            var on = sourceTab.id === tab
            return h('button', {
              key: sourceTab.id, type: 'button', role: 'tab',
              'aria-selected': on ? 'true' : 'false',
              className: 'bf-tab' + (on ? ' bf-tab-on' : ''),
              title: healthTitle(sourceTab.id, sourceEntry),
              onClick: function () { props.onTab(sourceTab.id) },
            },
              h('span', { className: 'bf-tab-dot bf-tone-' + sourceHealth.tone }),
              sourceTab.label)
          })),
        h('div', { className: 'bf-panel-body' },
          h('div', { className: 'bf-row bf-row-tight' },
            h('input', {
              className: 'bf-input', type: 'text',
              value: asText(props.queries ? props.queries[tab] : '', ''),
              placeholder: tab === 'pubmed' ? '关键词，如 gastric cancer liver metastasis' : tab === 'gdc' ? '如 TCGA-LUAD / lung adenocarcinoma' : tab === 'metabolights' ? '如 MTBLS1 / serum metabolomics' : '如 GSE84433 / gastric cancer',
              'aria-label': '检索词',
              onChange: function (event) { props.onQuery(tab, event.target.value) },
              onKeyDown: function (event) {
                if (isImeComposing(event)) return
                if (event && (event.key === 'Enter' || event.keyCode === 13)) {
                  event.preventDefault()
                  props.onSearch(tab)
                }
              },
            }),
            h('button', {
              type: 'button', className: 'bf-btn bf-btn-primary bf-btn-sm',
              disabled: state.loading,
              onClick: function () { props.onSearch(tab) },
            }, h(Icon, { name: 'search', size: 11 }), state.loading ? '检索中…' : '检索')),

          h('div', { className: 'bf-row bf-row-tight' },
            h('span', { className: 'bf-muted' }, '健康灯：'),
            h(Badge, { tone: healthInfo.tone === 'muted' ? 'muted' : healthInfo.tone }, h(Dot, { tone: healthInfo.tone }), healthInfo.label),
            h('span', { className: 'bf-muted' }, healthTitle(tab, entry)),
            probing ? h('span', { className: 'bf-muted' }, '探活中…') : null),
          state.data && state.data.bySource && state.data.bySource[tab]
            ? h('div', { className: 'bf-row bf-row-tight' },
              h('span', { className: 'bf-muted' },
                '本次检索：total ' + (isNil(state.data.bySource[tab].total) ? '—' : formatNumber(state.data.bySource[tab].total))
                + ' · via ' + asText(state.data.bySource[tab].via, '—')
                + (state.data.bySource[tab].cached ? ' · cached' : '')
                + (isNil(state.data.bySource[tab].elapsedMs) ? '' : ' · 耗时 ' + formatDuration(state.data.bySource[tab].elapsedMs))),
              state.data.bySource[tab].slow ? h(Badge, { tone: 'warn' }, '慢') : null)
            : null,
          tab === 'cellxgene' && (!entry || probing)
            ? h('div', { className: 'bf-warnbox' },
              h('div', { className: 'bf-row bf-row-tight' }, h(Icon, { name: 'clock', size: 12 }), h('b', null, 'CELLxGENE 慢是常态')),
              h('div', null, '预计 30–60s，不是故障；页面不会自动重试。点「探活」或直接检索时请耐心等待。'))
            : null,
          failedForTab && state.data
            ? h('div', { className: 'bf-warnbox' },
              h('div', { className: 'bf-row bf-row-tight' }, h(Icon, { name: 'alert', size: 12 }), h('b', null, '该源本次失败（其他源不受影响）')),
              h('div', null, (failedForTab.reason || failedForTab.code || '未知原因')))
            : null,
          props.probe && props.probe.source === tab && props.probe.error
            ? h(ErrorBar, { error: props.probe.error, title: '探活失败', onRetry: function () { props.onProbe(tab) } })
            : null,
          state.error ? h(ErrorBar, { error: state.error, title: '检索失败', onRetry: function () { props.onSearch(tab) } }) : null,
          state.loading && !items.length ? h(Skeleton, { lines: 4 }) : null,

          selectedCount
            ? h('div', { className: 'bf-row bf-row-tight' },
              h('span', { className: 'bf-muted' }, '已选 ' + selectedCount + ' 条'),
              h('button', {
                type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary',
                disabled: props.downloading,
                onClick: props.onAddToDownload,
              }, h(Icon, { name: 'download', size: 11 }), props.downloading ? '下载中…' : '加入下载'),
              h('button', {
                type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost',
                onClick: props.onClearSelection,
              }, '清空选择'))
            : null,

          items.length
            ? h('div', { className: 'bf-results' }, items.map(function (item) {
              var key = item.source + '|' + item.id
              return h(SearchResultRow, {
                key: key, item: item,
                selected: Boolean(props.selection && props.selection[key]),
                onToggle: props.onToggle,
              })
            }))
            : (state.data && !state.loading
              ? h(EmptyState, {
                icon: 'search',
                title: '没有结果',
                sub: '换个关键词；或者先看该源健康灯是不是红的（红=失败，鼠标悬停看 reason）。',
              })
              : null)))
    }

    // ----------------------------------------------------------------------
    // 右栏：下载队列
    // ----------------------------------------------------------------------
    function DownloadQueue(props) {
      var rows = asArray(props.rows)
      var running = rows.filter(function (row) { return row.status === 'running' }).length
      return h('div', { className: 'bf-panel', style: { flex: '0 0 auto', maxHeight: '232px' } },
        h('div', { className: 'bf-panel-head' },
          h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'download', size: 12 }), '下载队列'),
          h('span', { className: 'bf-panel-sub' }, running ? running + ' 个下载中' : rows.length ? rows.length + ' 个文件' : ''),
          h('div', { className: 'bf-panel-actions' },
            rows.length
              ? h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: props.onClearDone, title: '清空已完成/失败记录' },
                h(Icon, { name: 'trash', size: 11 }), '清空')
              : null)),
        h('div', { className: 'bf-panel-body' },
          !rows.length
            ? h(EmptyState, {
              icon: 'download',
              title: '队列是空的',
              sub: '在上方任一数据源勾选结果后点「加入下载」；同 hash 已存在会显示「已复用」而不是重复下载。',
            })
            : h('div', { className: 'bf-dl' }, rows.map(function (row) {
              var isRunning = row.status === 'running'
              var isError = row.status === 'error'
              return h('div', { key: row.key, className: 'bf-dl-row' },
                h('div', { className: 'bf-dl-main' },
                  h('span', { className: 'bf-tone-' + (isError ? 'err' : isRunning ? 'run' : 'ok'), style: { display: 'inline-flex' } },
                    h(Icon, { name: isError ? 'alert' : isRunning ? 'refresh' : 'check', size: 12 })),
                  h('span', { className: 'bf-dl-name', title: asText(row.name, '') }, asText(row.name, '—')),
                  row.reused ? h(Badge, { tone: 'ok' }, '已复用') : null,
                  row.path
                    ? h('button', {
                      type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost',
                      onClick: function () { props.onCopy(row.path) }, title: '复制文件路径：' + row.path,
                    }, h(Icon, { name: 'copy', size: 10 }))
                    : null,
                  isRunning
                    ? h('button', {
                      type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost',
                      onClick: function () { props.onCancel(row) },
                      title: '停止等待（客户端停止等待；后端 download 是一次性请求，不支持暂停续传）',
                    }, h(Icon, { name: 'close', size: 10 }), '停止等待')
                    : h('button', {
                      type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost',
                      onClick: function () { props.onRemove(row) }, title: '从队列移除（不动磁盘文件）',
                    }, h(Icon, { name: 'trash', size: 10 }))),
                h('div', { className: 'bf-dl-meta' },
                  h('span', null, asText(row.source, '—')),
                  h('span', null, formatBytes(row.bytes)),
                  h('span', null, 'sha ' + sha8(row.sha256)),
                  isError ? h('span', { className: 'bf-dl-err' }, asText(row.error, '下载失败')) : null),
                isRunning
                  ? h(ProgressBar, { indeterminate: true, title: '写入中（大小未知前为不定进度）' })
                  : h(ProgressBar, { value: isError ? 0 : 100, title: isError ? '失败' : '完成' }))
            }))))
    }

    // ----------------------------------------------------------------------
    // 右栏：产物与证据（manifest / design / results / figures / evidence / methods）
    // ----------------------------------------------------------------------
    function FigureImage(props) {
      var sources = figureSources(props.figure, props.dataRoot, props.runId)
      var srcState = useState(sources.src)
      var src = srcState[0]
      var setSrc = srcState[1]
      var brokenState = useState(false)
      var broken = brokenState[0]
      var setBroken = brokenState[1]
      useEffect(function () {
        setSrc(sources.src)
        setBroken(false)
      }, [sources.src])
      if (!src || broken) {
        return h('div', {
          className: props.className || 'bf-figthumb',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--bf-ink-2)' },
          title: '图片不可达（files/figures 路由返回失败）',
        }, h(Icon, { name: 'image', size: 18 }))
      }
      return h('img', {
        className: props.className || 'bf-figthumb',
        src: src,
        alt: asText(props.alt, 'figure'),
        loading: props.eager ? 'eager' : 'lazy',
        style: props.style,
        onError: function () {
          if (sources.fallback && src !== sources.fallback) setSrc(sources.fallback)
          else setBroken(true)
        },
      })
    }

    function FiguresGrid(props) {
      var figures = asArray(props.figures)
      if (!figures.length) {
        return h(EmptyState, {
          icon: 'image',
          title: '还没有图',
          sub: 'run 成功后 figures/ 下会按 step 生成 PNG（300dpi）；点缩略图看大图与 figure_id / n / 分母 / 对比方向。',
        })
      }
      return h('div', { className: 'bf-figgrid' }, figures.map(function (figure, index) {
        var cells = figureMetaCells(figure, props.runStatus)
        return h('button', {
          key: asText(figure.figureId, 'fig-' + index), type: 'button', className: 'bf-figcard',
          title: asText(figure.title || figure.figureId, 'figure'),
          onClick: function () { if (typeof props.onOpen === 'function') props.onOpen(figure) },
        },
          h(FigureImage, { figure: figure, runId: props.runId, dataRoot: props.dataRoot, alt: asText(figure.figureId, 'figure') }),
          h('span', { className: 'bf-figcap' }, asText(figure.figureId, '—')),
          h('span', { className: 'bf-figsub' }, 'n=' + cells[1].value + ' · 分母=' + cells[2].value),
          h('span', { className: 'bf-figsub', title: asText(cells[3].value, '') }, asText(cells[3].value, '方向 —')))
      }))
    }

    function evidenceFilterChips(evidence, filter, onFilter) {
      var counts = evidence && evidence.counts ? evidence.counts : { measured: 0, descriptive: 0, model_prediction: 0 }
      var total = evidence ? asNumber(evidence.total, 0) : 0
      var options = [
        { key: 'all', label: '全部', count: total },
        { key: 'measured', label: '实测', count: asNumber(counts.measured, 0) },
        { key: 'descriptive', label: '描述性', count: asNumber(counts.descriptive, 0) },
        { key: 'model_prediction', label: '模型预测', count: asNumber(counts.model_prediction, 0) },
      ]
      return h('div', { className: 'bf-chipbar' }, options.map(function (option) {
        return h('button', {
          key: option.key, type: 'button',
          className: 'bf-cand' + (filter === option.key ? ' bf-cand-on' : ''),
          onClick: function () { if (typeof onFilter === 'function') onFilter(option.key) },
        }, option.label + ' ' + formatNumber(option.count))
      }))
    }

    function EvidenceList(props) {
      var evidence = props.evidence
      var filter = props.filter || 'all'
      var records = evidence ? filterEvidence(evidence.records, filter) : []
      if (!evidence) return h(EmptyState, { icon: 'shield', title: '还没有 evidence', sub: 'evidence 跟着 run 走；run 成功后这里是 claim 索引（每条带 run_id / table_id / row_id）。' })
      return h('div', { className: 'bf-col' },
        evidenceFilterChips(evidence, filter, props.onFilter),
        evidence.zeroSignificant === true
          ? h('div', { className: 'bf-warnbox' },
            h('div', { className: 'bf-row bf-row-tight' }, h(Icon, { name: 'alert', size: 12 }), h('b', null, '零显著')),
            h('div', null, '本次分析未检出显著结果；这不等同于「无差异」。'))
          : null,
        evidence.truncated ? h('div', { className: 'bf-muted' }, '只展示前 ' + formatNumber(records.length) + ' 条（total ' + formatNumber(evidence.total) + '）；完整内容看 evidence.jsonl。') : null,
        records.length
          ? h('div', { className: 'bf-evi' }, records.map(function (record, index) {
            var meta = evidenceKindMeta(record.evidenceKind)
            var isModel = String(record.evidenceKind).toLowerCase() === 'model_prediction'
            return h('div', {
              key: asText(record.claimId, 'evi-' + index),
              className: 'bf-evi-row' + (isModel ? ' bf-evi-model' : ''),
            },
              h('div', { className: 'bf-row bf-row-tight' },
                h(Badge, { tone: meta.tone }, meta.label),
                isModel ? h('span', { className: 'bf-model-note' },
                  h(Icon, { name: 'alert', size: 11 }), '模型预测，不是实验结论') : null,
                record.significant === true ? h(Badge, { tone: 'ok' }, '显著') : null,
                record.significant === false ? h(Badge, null, '不显著') : null),
              h('div', { className: 'bf-evi-claim' }, asText(record.claim, '—')),
              h('div', { className: 'bf-evi-ids' },
                h('button', {
                  type: 'button', className: 'bf-tag bf-mono', title: '点击复制 claim_id',
                  onClick: function () { props.onCopy(record.claimId) },
                }, 'claim ' + shortId(record.claimId, 24)),
                record.runId
                  ? h('button', {
                    type: 'button', className: 'bf-tag bf-mono', title: '点击复制 run_id',
                    onClick: function () { props.onCopy(record.runId) },
                  }, 'run ' + shortId(record.runId, 16))
                  : null,
                record.tableId
                  ? h('button', {
                    type: 'button', className: 'bf-tag bf-mono', title: '打开对应 results 表',
                    onClick: function () { if (typeof props.onOpenTable === 'function') props.onOpenTable(record) },
                  }, record.tableId + ' · row ' + (isNil(record.rowId) ? '—' : record.rowId))
                  : null,
                record.figureId ? h('span', { className: 'bf-tag bf-mono' }, record.figureId) : null),
              (record.feature || record.effect !== null || record.q !== null || record.p !== null || record.n !== null)
                ? h('div', { className: 'bf-evi-ids' },
                  record.feature ? h('span', { className: 'bf-tag' }, record.feature) : null,
                  record.effect !== null ? h('span', { className: 'bf-tag' }, 'effect ' + formatNumber(record.effect, 3)) : null,
                  record.q !== null ? h('span', { className: 'bf-tag' }, 'q ' + formatP(record.q)) : null,
                  record.p !== null ? h('span', { className: 'bf-tag' }, 'p ' + formatP(record.p)) : null,
                  record.n !== null ? h('span', { className: 'bf-tag' }, 'n ' + formatNumber(record.n)) : null)
                : null)
          }))
          : h(EmptyState, { icon: 'list', title: filter === 'all' ? '没有索引到 claim' : '该类型没有条目', sub: 'evidence.jsonl 是 claim 索引；全量数值在 results/*.tsv（含 row_id）。' }))
    }


    // ----------------------------------------------------------------------
    // 统计口径卡：这次 run 的对比方向 / 检验 / 校正族 / 每组 n / 数据身份 / 产物哈希
    // ----------------------------------------------------------------------
    function StatsChips(props) {
      var contract = props.contract || {}
      var inference = contract.inference || {}
      var fdr = inference.fdr || {}
      var design = contract.design || {}
      var data = contract.data || {}
      var identity = contract.identity || {}
      var tests = asArray(inference.tests).map(function (test) { return test.method })
      var nLabel = asArray(design.groups).map(function (group) {
        return group.name + ' ' + (group.nSamples === null ? '?' : group.nSamples)
      }).join(' / ')
      var chips = [
        contract.contrast && contract.contrast.direction ? contract.contrast.direction : null,
        tests.length ? tests.join(' + ') : null,
        fdr.method ? fdr.method + (fdr.alpha === null ? '' : ' α=' + formatNumber(fdr.alpha, 3)) : null,
        nLabel || null,
        data.scale ? data.scale + (data.scaleVerified ? '（已验证）' : '（未验证）') : null,
        identity.contentHash ? 'hash ' + shortId(identity.contentHash, 8) : null,
      ].filter(Boolean)
      if (!chips.length) return null
      var warnCount = asArray(contract.caveats).filter(function (item) { return item.level === 'warn' }).length
      return h('div', { className: 'bf-contract-chips' },
        chips.map(function (chip, index) { return h('span', { key: index, className: 'bf-contract-chip' }, chip) }),
        warnCount ? h('span', { className: 'bf-contract-chip bf-contract-chip-warn' }, warnCount + ' 项口径待注意') : null)
    }

    function StatsContractCard(props) {
      var contract = props.contract || null
      if (!contract) {
        return h(EmptyState, {
          icon: 'shield',
          title: '还没有统计口径',
          sub: 'run 完成后这里会列出：对比方向、检验方法、多重校正家族与 alpha、每组 n、数据尺度验证状态、产物哈希。',
        })
      }
      var design = contract.design || {}
      var inference = contract.inference || {}
      var fdr = inference.fdr || {}
      var data = contract.data || {}
      var evidence = contract.evidence || {}
      var identity = contract.identity || {}
      var environment = contract.environment || {}
      var caveats = asArray(contract.caveats)
      var warns = caveats.filter(function (item) { return item.level === 'warn' })
      var infos = caveats.filter(function (item) { return item.level !== 'warn' })
      var groups = asArray(design.groups)
      var tests = asArray(inference.tests)
      var kinds = evidence.kinds || {}
      var pluginCount = Object.keys(environment.plugins || {}).length

      function row(label, value, extra) {
        return h('div', { className: 'bf-kv bf-contract-row' },
          h('span', { className: 'bf-kv-k' }, label),
          h('span', { className: 'bf-kv-v bf-contract-value' },
            h('span', null, value || '未记录'),
            extra || null))
      }

      return h('div', { className: 'bf-card bf-contract' },
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, h(Icon, { name: 'shield', size: 14 }), '统计口径'),
          contract.okToCite
            ? h(Badge, { tone: 'ok' }, '可引用：无待注意项')
            : h(Badge, { tone: 'warn' }, warns.length ? warns.length + ' 项待注意' : '存在提示项'),
          contract.template ? h(Badge, { mono: true }, contract.template) : null,
          h('div', { className: 'bf-panel-actions' },
            identity.contentHash
              ? h('span', { className: 'bf-row bf-row-tight' },
                h(Mono, { style: { fontSize: '11px', color: 'var(--bf-ink-2)' } }, 'hash ' + shortId(identity.contentHash, 16)),
                h(CopyButton, { text: identity.contentHash, onCopy: props.onCopy, title: '复制 content_hash（同一 run 反复导出稳定）' }))
              : null)),

        h('div', { className: 'bf-contract-grid' },
          row('对比方向', contract.contrast && contract.contrast.direction,
            contract.contrast && contract.contrast.effectConvention
              ? h('span', { className: 'bf-contract-note' }, contract.contrast.effectConvention) : null),
          row('检验方法', tests.length
            ? tests.map(function (test) { return test.method + (test.stepId ? '（' + test.stepId + '）' : '') }).join(' · ')
            : null),
          row('多重校正', fdr.method
            ? fdr.method + (fdr.alpha === null ? '' : ' · alpha=' + formatNumber(fdr.alpha, 3)) + (fdr.nTests === null ? ' · 族大小未记录' : ' · 检验族 ' + formatNumber(fdr.nTests))
            : null),
          row('每组 n', groups.length
            ? groups.map(function (group) {
              return group.name + ' ' + (group.nSamples === null ? '?' : group.nSamples) + (group.nDonors === null ? '' : '（' + group.nDonors + ' 供体）')
            }).join(' · ')
            : null),
          row('设计', [design.paired ? '配对（' + (design.pairColumn || '配对列未记录') + '）' : '独立样本',
            design.covariates && design.covariates.length ? '协变量 ' + design.covariates.join('、') : '无协变量',
            design.formula ? '公式 ' + design.formula : null].filter(Boolean).join(' · ')),
          row('数据身份', [data.datasetId, data.revision && data.revision !== data.datasetId ? 'rev ' + shortId(data.revision, 10) : null,
            data.assay, data.species, data.nFiles === null ? null : data.nFiles + ' 个文件', data.hasClinical ? '带临床' : null].filter(Boolean).join(' · ')),
          row('数据尺度', data.scale
            ? data.scale + (data.scaleVerified ? '（已验证）' : '（未验证：推断结论应降级为描述）')
            : null),
          row('证据', evidence.nClaims === null
            ? null
            : evidence.nClaims + ' 条 claim（实测 ' + formatNumber(kinds.measured, 0) + ' / 描述 ' + formatNumber(kinds.descriptive, 0) + ' / 模型预测 ' + formatNumber(kinds.model_prediction, 0) + '）' + (evidence.zeroSignificant ? ' · 零显著' : '')),
          row('执行环境', [environment.bioflowVersion ? 'bioflow ' + environment.bioflowVersion : null,
            environment.node ? 'node ' + environment.node : null, environment.platform,
            pluginCount ? pluginCount + ' 个插件' : null, design.formula || identity.seed === null ? null : 'seed ' + identity.seed].filter(Boolean).join(' · ')),
          row('产物身份', identity.manifestSha ? 'manifest ' + shortId(identity.manifestSha, 12) : null)),

        warns.length ? h('div', { className: 'bf-warnbox' },
          h('div', { className: 'bf-row bf-row-tight' }, h(Icon, { name: 'alert', size: 12 }), h('b', null, '引用前必须处理的 ' + warns.length + ' 项')),
          warns.map(function (item, index) {
            return h('div', { key: index }, '· ' + item.text)
          })) : null,
        infos.length ? h('div', { className: 'bf-note' },
          infos.map(function (item, index) { return h('div', { key: index }, '· ' + item.text) })) : null,

        contract.reproduce && contract.reproduce.length ? h(Collapsible, {
          title: '回查与复现命令',
          meta: contract.reproduce.length + ' 条',
        }, h('div', { className: 'bf-col' }, contract.reproduce.map(function (command, index) {
          return h('div', { key: index, className: 'bf-row bf-row-tight' },
            h(Mono, { style: { fontSize: '11px', wordBreak: 'break-all' } }, command),
            h(CopyButton, { text: command, onCopy: props.onCopy, title: '复制命令' }))
        }))) : null)
    }
    function FileEntries(props) {
      var runStatus = props.runStatus || {}
      var runId = props.runId
      var dataRoot = props.dataRoot
      var tables = asArray(runStatus.tables)
      var figures = asArray(runStatus.figures)
      var expandedState = useState('')
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]
      if (!runId) {
        return h(EmptyState, {
          icon: 'folder',
          title: '还没有 run',
          sub: '产物跟着 run 走：提交计划后这里出现 manifest.json / design.tsv / results/*.tsv / figures/ / evidence.jsonl / methods.md。',
        })
      }
      var focus = asArray(props.focusDeliverables).map(function (item) { return String(item) })
      var entries = [
        {
          key: 'manifest', icon: 'file', name: 'manifest.json',
          sub: '交付清单：参数、闸门、步骤产物索引与 sha256',
          onClick: function () { props.onOpenManifest() },
        },
        {
          key: 'design', icon: 'list', name: 'design.tsv',
          sub: '样本表 / 分组 / 排除原因（审计设计是否成立）',
          onClick: function () { props.onOpenText('design.tsv', 'runs/' + runId + '/design.tsv', 'table') },
        },
        {
          key: 'results', icon: 'list', name: 'results/*.tsv',
          sub: tables.length ? tables.length + ' 张结果表（含 row_id 可回查）' : '暂无可索引结果表',
          onClick: function () { setExpanded(expanded === 'results' ? '' : 'results') },
        },
        {
          key: 'figures', icon: 'image', name: 'figures/',
          sub: figures.length ? figures.length + ' 张图（PNG 300dpi）' : '暂无图',
          onClick: function () { if (typeof props.onShowFigures === 'function') props.onShowFigures() },
        },
        {
          key: 'evidence', icon: 'shield', name: 'evidence.jsonl',
          sub: 'claim 索引；model_prediction 单独醒目标记',
          onClick: function () { props.onOpenEvidence() },
        },
        {
          key: 'methods', icon: 'file', name: 'methods.md',
          sub: '由 manifest 自动生成的方法学（不外推）',
          onClick: function () { props.onOpenMethods() },
        },
      ]
      if (focus.length) {
        entries = entries.slice().sort(function (left, right) {
          var leftFocused = focus.indexOf(left.key) >= 0 ? 0 : 1
          var rightFocused = focus.indexOf(right.key) >= 0 ? 0 : 1
          return leftFocused - rightFocused
        })
      }
      return h('div', { className: 'bf-col' },
        h('div', { className: 'bf-entries' }, entries.map(function (entry) {
          return h('button', {
            key: entry.key, type: 'button', className: 'bf-entry',
            onClick: entry.onClick, title: entry.name + ' · ' + entry.sub,
          },
            h('span', { className: 'bf-entry-icon' }, h(Icon, { name: entry.icon, size: 14 })),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'bf-entry-name' }, entry.name),
              h('div', { className: 'bf-entry-sub' }, entry.sub)),
            h('span', { className: 'bf-muted bf-mono' }, entry.key === 'results' ? String(tables.length) : entry.key === 'figures' ? String(figures.length) : ''))
        })),
        expanded === 'results'
          ? h('div', { className: 'bf-entries' }, tables.map(function (table) {
            var kindMeta = evidenceKindMeta(table.evidenceKind)
            return h('button', {
              key: asText(table.tableId, 'table'), type: 'button', className: 'bf-entry',
              onClick: function () { props.onOpenTable(table) },
              title: '打开 ' + asText(table.tableId, 'table'),
            },
              h('span', { className: 'bf-entry-icon' }, h(Icon, { name: 'file', size: 12 })),
              h('div', { style: { minWidth: 0 } },
                h('div', { className: 'bf-entry-name' }, asText(table.tableId, 'table')),
                h('div', { className: 'bf-entry-sub' }, asText(table.title, '') + (isNil(table.rows) ? '' : ' · ' + formatNumber(table.rows) + ' 行'))),
              h(Badge, { tone: kindMeta.tone, mono: false }, kindMeta.label))
          }))
          : null,
        tables.length ? null : h('div', { className: 'bf-muted' }, '结果表索引来自 results/tables.index.json；run 还没成功或没有表时为空。'),
        dataRoot ? h('div', { className: 'bf-note' }, '产物都在数据根下：', h('span', { className: 'bf-mono' }, 'runs/' + runId + '/')) : null)
    }

    function metaCell(label, value) {
      return h('div', { className: 'bf-meta-cell' },
        h('span', { className: 'bf-meta-k' }, label),
        h('span', { className: 'bf-meta-v' }, asText(value, '—')))
    }

    function simpleTable(headers, rows) {
      return h('div', { className: 'bf-table-wrap' },
        h('table', { className: 'bf-table' },
          h('thead', null, h('tr', null, headers.map(function (header, index) {
            return h('th', { key: index }, asText(header, ''))
          }))),
          h('tbody', null, rows.map(function (row, rowIndex) {
            return h('tr', { key: rowIndex }, row.map(function (cell, cellIndex) {
              return h('td', { key: cellIndex }, asText(cell, '—'))
            }))
          }))))
    }

    function ManifestView(props) {
      var manifest = props.manifest
      if (!manifest) {
        return props.loading
          ? h(Skeleton, { lines: 5 })
          : (props.error ? h(ErrorBar, { error: props.error, title: 'manifest 加载失败', onRetry: props.onRetry }) : h(EmptyState, { icon: 'file', title: 'manifest 不可用' }))
      }
      if (manifest.raw) return h(PreBlock, { text: manifest.raw, limit: 20000 })
      var steps = asArray(manifest.steps)
      var artifacts = asArray(manifest.artifacts)
      return h('div', { className: 'bf-col' },
        props.loading ? h(Skeleton, { lines: 2 }) : null,
        h('div', { className: 'bf-figure-meta' },
          metaCell('run_id', asText(manifest.run_id, '—')),
          metaCell('template', asText(manifest.template, '—')),
          metaCell('status', asText(manifest.status, '—')),
          metaCell('seed', asText(manifest.seed, '—')),
          metaCell('zero_significant', manifest.zero_significant === true ? '是（零显著）' : manifest.zero_significant === false ? '否' : '—'),
          metaCell('contrast', manifest.contrast ? displayValue(manifest.contrast) : '—'),
          metaCell('dataset', manifest.dataset && manifest.dataset.dataset_id ? asText(manifest.dataset.dataset_id, '—') : '—'),
          metaCell('finished_at', manifest.finished_at ? formatLocalTime(manifest.finished_at) : '—')),
        steps.length
          ? h('div', { className: 'bf-col' },
            h('div', { className: 'bf-subhead' }, 'steps（每步的真实产物索引）'),
            simpleTable(
              ['step_id', 'plugin', 'action', 'status', 'tables', 'figures'],
              steps.map(function (step) {
                return [
                  asText(step.step_id, '—'), asText(step.plugin, '—'), asText(step.action, '—'),
                  asText(step.status, '—'),
                  asArray(step.tables).join('、') || '—',
                  asArray(step.figures).join('、') || '—',
                ]
              })))
          : null,
        artifacts.length
          ? h('div', { className: 'bf-col' },
            h('div', { className: 'bf-subhead' }, 'artifacts（sha256 前 8 位）'),
            simpleTable(
              ['path', 'bytes', 'sha256'],
              artifacts.map(function (artifact) {
                return [asText(artifact.relative_path || artifact.path, '—'), formatBytes(artifact.bytes), sha8(artifact.sha256)]
              })))
          : null,
        h(Collapsible, { title: '完整 manifest.json', meta: '只读' },
          h(PreBlock, { text: safeJson(manifest), limit: 24000 })))
    }

    function TablePreview(props) {
      var parsed = useMemo(function () { return parseTsvPreview(props.text, 40, 12) }, [props.text])
      var rawOpenState = useState(false)
      var rawOpen = rawOpenState[0]
      var setRawOpen = rawOpenState[1]
      if (!parsed.header.length && !parsed.rows.length) {
        return h(EmptyState, { icon: 'file', title: '文件是空的', sub: '可能是 0 行结果表，或取到的是非 TSV 内容。' })
      }
      return h('div', { className: 'bf-col' },
        h('div', { className: 'bf-muted' },
          '预览 ' + parsed.rows.length + ' 行'
          + (parsed.truncatedRows ? '（共 ' + parsed.totalRows + ' 行，已截断）' : '')
          + (parsed.truncatedCols ? ' · 列已截断' : '')),
        simpleTable(parsed.header, parsed.rows),
        h('button', {
          type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost',
          onClick: function () { setRawOpen(!rawOpen) },
        }, h(Icon, { name: rawOpen ? 'minus' : 'plus', size: 11 }), rawOpen ? '收起原始文本' : '查看原始 TSV'),
        rawOpen ? h(PreBlock, { text: props.text, limit: 24000 }) : null)
    }

    function ArtifactsBody(props) {
      var mode = asText(props.mode, 'files')
      var runId = asText(props.runId, '')
      if (!runId) {
        return h('div', { className: 'bf-muted', style: { padding: '10px 2px', lineHeight: '1.6' } },
          '还没有选中的 run。提交计划后会自动选中；也可以从左栏「历史 run」里点一个。')
      }
      var files = h(FileEntries, {
        runId: runId, runStatus: props.runStatus, dataRoot: props.dataRoot,
        focusDeliverables: props.focusDeliverables,
        onOpenManifest: props.onOpenManifest, onOpenText: props.onOpenText, onOpenTable: props.onOpenTable,
        onShowFigures: props.onShowFigures, onOpenEvidence: props.onOpenEvidence, onOpenMethods: props.onOpenMethods,
      })
      var figures = h(FiguresGrid, {
        figures: props.runStatus ? props.runStatus.figures : [], runStatus: props.runStatus,
        runId: runId, dataRoot: props.dataRoot, onOpen: props.onOpenFigure,
      })
      var evidenceBlock = props.evidenceLoading && !props.evidence
        ? h(Skeleton, { lines: 4 })
        : props.evidenceError
          ? h(ErrorBar, { error: props.evidenceError, title: 'evidence 加载失败', onRetry: props.onNeedEvidence })
          : h(EvidenceList, {
            evidence: props.evidence, filter: props.evidenceFilter,
            onFilter: props.onEvidenceFilter, onCopy: props.onCopy, onOpenTable: props.onOpenTable,
          })
      if (mode === 'figures') return figures
      if (mode === 'stats') return h(StatsContractCard, { contract: props.statsContract, onCopy: props.onCopy })
      if (mode === 'evidence') return evidenceBlock
      if (mode === 'all') {
        return h('div', { className: 'bf-col' },
          h('div', { className: 'bf-subhead' }, '统计口径'), h(StatsContractCard, { contract: props.statsContract, onCopy: props.onCopy }),
          h('div', { className: 'bf-subhead' }, '文件入口'), files,          h('div', { className: 'bf-subhead' }, '文件入口'), files,
          h('div', { className: 'bf-subhead' }, 'figures/'), figures,
          h('div', { className: 'bf-subhead' }, 'evidence.jsonl'), evidenceBlock)
      }
      return files
    }

    function ArtifactsPanel(props) {
      var modeState = useState('files')
      var mode = modeState[0]
      var setMode = modeState[1]
      function choose(next) {
        setMode(next)
        if (next === 'evidence' && typeof props.onNeedEvidence === 'function') props.onNeedEvidence()
      }
      return h('div', { className: 'bf-panel', style: { flex: '1 1 46%', minHeight: '260px' } },
        h('div', { className: 'bf-panel-head' },
          h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'folder', size: 12 }), '产物与证据'),
          h('span', { className: 'bf-panel-sub bf-mono' }, props.runId ? shortId(props.runId, 22) : '无 run'),
          h('div', { className: 'bf-panel-actions' },
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: props.onOpenArtifacts, title: '全屏查看产物与证据' },
              h(Icon, { name: 'external', size: 11 }), '全屏'),
            props.runId
              ? h(CopyButton, { text: props.runId, onCopy: props.onCopy, title: '复制 run_id' })
              : null)),
        h('div', { className: 'bf-panel-body' },
          h('div', { className: 'bf-tabs', role: 'tablist' },
            [
              { key: 'files', label: '文件' },
              { key: 'figures', label: '图' },
              { key: 'stats', label: '口径' },
              { key: 'evidence', label: '证据' },              { key: 'evidence', label: '证据' },
            ].map(function (tab) {
              return h('button', {
                key: tab.key, type: 'button', role: 'tab',
                'aria-selected': mode === tab.key ? 'true' : 'false',
                className: 'bf-tab' + (mode === tab.key ? ' bf-tab-on' : ''),
                onClick: function () { choose(tab.key) },
              }, tab.label)
            })),
          h(ArtifactsBody, Object.assign({}, props, {
            mode: mode,
            onShowFigures: function () { choose('figures') },
            onOpenEvidence: function () { choose('evidence'); props.onOpenEvidence() },
          }))))
    }

    // ----------------------------------------------------------------------
    // 抽屉（Esc 关闭；大图 / 文本 / 表格 / 证据 / 全屏产物）
    // ----------------------------------------------------------------------
    function Drawer(props) {
      var drawer = props.drawer
      if (!drawer) return null
      var kind = asText(drawer.kind, 'text')
      var title = asText(drawer.title, '查看')
      function bodyContent() {
        if (drawer.loading) return h(Skeleton, { lines: 5, thick: true })
        if (drawer.error) return h(ErrorBar, { error: drawer.error, title: '读取失败', onRetry: drawer.onRetry })
        if (kind === 'figure') {
          var figure = drawer.figure || {}
          var cells = figureMetaCells(figure, drawer.runStatus)
          var sources = figureSources(figure, props.dataRoot, drawer.runId)
          var missingN = isNil(figure.n) || isNil(figure.denominator)
          return h('div', { className: 'bf-col' },
            h(FigureImage, {
              figure: figure, runId: drawer.runId, dataRoot: props.dataRoot,
              className: 'bf-figure-img', eager: true, alt: asText(figure.figureId, 'figure'),
              style: { maxHeight: '58vh', width: 'auto' },
            }),
            h('div', { className: 'bf-figure-meta' }, cells.map(function (cell) {
              return h('div', { key: cell.key, className: 'bf-meta-cell' },
                h('span', { className: 'bf-meta-k' }, cell.label),
                h('span', { className: 'bf-meta-v' }, cell.value))
            })),
            figure.title ? h('div', { className: 'bf-note' }, figure.title) : null,
            missingN ? h('div', { className: 'bf-muted' }, '引擎未回传 n / 分母时这里显示 —，不做任何推断。') : null,
            sources.src
              ? h('a', { className: 'bf-btn bf-btn-sm bf-btn-ghost', href: sources.src, target: '_blank', rel: 'noreferrer' },
                h(Icon, { name: 'external', size: 11 }), '在新标签打开原图（300dpi PNG）')
              : h('div', { className: 'bf-muted' }, '没有可用的图片路径（figure.file 为空）。'))
        }
        if (kind === 'manifest') return h(ManifestView, { manifest: drawer.manifest, loading: drawer.loading, error: drawer.error })
        if (kind === 'evidence') {
          return h(EvidenceList, {
            evidence: drawer.evidence, filter: props.evidenceFilter || 'all',
            onFilter: props.onEvidenceFilter, onCopy: props.onCopy, onOpenTable: drawer.onOpenTable,
          })
        }
        if (kind === 'artifacts') return h(ArtifactsBody, Object.assign({}, drawer.artifactsProps, { mode: 'all' }))
        if (kind === 'methods' || kind === 'text') {
          var content = String(drawer.content === undefined || drawer.content === null ? '' : drawer.content)
          if (!content) return h(EmptyState, { icon: 'file', title: '文件为空或不可读' })
          if (drawer.mode === 'table') return h(TablePreview, { text: content })
          var shown = content
          if (/\.json$/i.test(asText(drawer.relative, ''))) {
            try { shown = safeJson(JSON.parse(content)) } catch (error) { shown = content }
          }
          return h('div', { className: 'bf-col' },
            content.length > 20000 ? h('div', { className: 'bf-muted' }, '内容较长（' + content.length + ' 字符），仅显示尾部 20000 字符。') : null,
            h(PreBlock, { text: shown, limit: 20000, style: { maxHeight: '64vh' } }))
        }
        return h(EmptyState, { icon: 'info', title: '没有可渲染的内容' })
      }
      return h('div', { className: 'bf-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { className: 'bf-drawer-back', onClick: props.onClose, 'aria-hidden': 'true' }),
        h('div', { className: 'bf-drawer-card' },
          h('div', { className: 'bf-drawer-head' },
            h('span', { className: 'bf-drawer-title' },
              h(Icon, { name: kind === 'figure' ? 'image' : kind === 'evidence' ? 'shield' : 'file', size: 15 }),
              h('span', { className: 'bf-truncate', title: title }, title)),
            h('div', { className: 'bf-panel-actions' },
              drawer.relative ? h(CopyButton, { text: drawer.relative, onCopy: props.onCopy, title: '复制相对路径' }) : null,
              drawer.relative ? h('a', {
                className: 'bf-btn bf-btn-sm bf-btn-ghost', href: filesUrl(drawer.relative),
                target: '_blank', rel: 'noreferrer', title: '在新标签打开原文件',
              }, h(Icon, { name: 'external', size: 11 }), '原文件') : null,
              h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: props.onClose, title: '关闭（Esc）' },
                h(Icon, { name: 'close', size: 12 }), '关闭'))),
          h('div', { className: 'bf-drawer-body' }, bodyContent())))
    }

    // ----------------------------------------------------------------------
    // 错误边界（唯一允许的 class 组件）
    // ----------------------------------------------------------------------
    class PluginErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: null }
        this.handleReset = this.handleReset.bind(this)
      }

      componentDidCatch(error) {
        this.setState({ failed: error })
      }

      handleReset() {
        this.setState({ failed: null })
      }

      render() {
        if (this.state.failed) {
          var message = String(this.state.failed && this.state.failed.message ? this.state.failed.message : this.state.failed)
          return h('div', { className: 'bf-root' },
            h('style', null, CSS_TEXT),
            h('div', { style: { padding: '24px' } },
              h(EmptyState, {
                icon: 'alert',
                title: 'Bioflow 页面渲染出错',
                sub: message,
                actions: [h('button', { type: 'button', className: 'bf-btn bf-btn-primary', onClick: this.handleReset }, '重试')],
              })))
        }
        return this.props.children
      }
    }

    // ----------------------------------------------------------------------
    // 主工作台：状态、轮询、所有数据动作
    // ----------------------------------------------------------------------
    // ----------------------------------------------------------------------
    // 右栏：进度 + 可视化（morph / snakefront 式 live dashboard）
    // ----------------------------------------------------------------------
    var RUN_STEP_TONE = { ok: 'ok', failed: 'err', cancelled: 'muted', running: 'run', pending: 'idle', queued: 'run', pending_review: 'idle' }

    function stepTone(status) {
      return RUN_STEP_TONE[String(status || '').toLowerCase()] || 'idle'
    }

    function ProgressStrip(props) {
      var runStatus = props.runStatus || null
      var plan = props.plan || null
      var steps = asArray(runStatus && runStatus.steps)
      var planSteps = steps.length ? steps : asArray(plan && plan.steps)
      var total = planSteps.length || 0
      var done = steps.filter(function (step) { return ['ok', 'failed', 'cancelled'].includes(String(step.status)) }).length
      var okCount = steps.filter(function (step) { return step.status === 'ok' }).length
      var failed = steps.filter(function (step) { return step.status === 'failed' }).length
      var pct = total ? Math.round((done / total) * 100) : 0
      var figures = asArray(runStatus && runStatus.figures)
      var tables = asArray(runStatus && runStatus.tables)
      var counts = props.evidenceCounts || null
      var zeroSignificant = Boolean(runStatus && runStatus.zeroSignificant)
      var hasRun = Boolean(runStatus)
      var evidenceTotal = counts ? (counts.measured || 0) + (counts.descriptive || 0) + (counts.model_prediction || 0) : null
      function stat(label, value, sub) {
        return h('span', { className: 'bf-stat', title: sub || '' },
          h('span', { className: 'bf-stat-label' }, label),
          h('b', null, value))
      }
      return h('div', { className: 'bf-progress' + (hasRun ? ' bf-progress-live' : ' bf-progress-idle') },
        h('div', { className: 'bf-progress-head' },
          h('span', { className: 'bf-progress-title' }, h(Icon, { name: 'flow', size: 12 }), '进度与产物'),
          runStatus ? h(StatusBadge, { status: runStatus.status, kind: 'run' }) : null,
          runStatus && runStatus.runId ? h('span', { className: 'bf-mono bf-muted' }, shortId(runStatus.runId, 18)) : null,
          zeroSignificant ? h(Badge, { tone: 'warn' }, '零显著') : null,
          h('div', { className: 'bf-spacer' }),
          hasRun
            ? h('div', { className: 'bf-inline-stats' },
              stat('步骤', total ? okCount + '/' + total : '—', failed ? failed + ' 步失败' : ''),
              stat('图', figures.length || '—', figures.length ? 'PNG 300dpi' : ''),
              stat('表', tables.length || '—', tables.length ? 'results/*.tsv' : ''),
              stat('证据', evidenceTotal === null ? '—' : String(evidenceTotal), counts && counts.model_prediction ? counts.model_prediction + ' 条模型预测' : ''),
              stat('闸门', String(props.blockedCount || 0), props.blockedCount ? 'blocked' : '未拦截'))
            : h('span', { className: 'bf-progress-idle-hint' }, '提交计划后这里会显示步骤 / 图 / 表 / 证据')),
        hasRun && total
          ? h('div', { className: 'bf-progress-bar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
            h('span', { className: 'bf-progress-fill', style: { width: pct + '%' } }))
          : null,
        hasRun ? h('div', { className: 'bf-progress-actions' },
          h('span', { className: 'bf-progress-actions-label' }, '输出到'),
          h('input', {
            className: 'bf-input bf-input-sm bf-outdir', value: asText(props.outputDir, ''),
            placeholder: '默认：run 旁 / 未设置',
            onChange: function (event) { if (props.onOutputDirChange) props.onOutputDirChange(event.target.value) },
          }),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', disabled: props.saving, onClick: props.onSaveOutputDir }, props.saving ? '保存中…' : '保存'),
          h('div', { className: 'bf-spacer' }),
          h('button', {
            type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary',
            disabled: props.exporting, onClick: props.onExport,
          }, h(Icon, { name: 'download', size: 11 }), props.exporting ? '导出中…' : '导出结果包')) : null)
    }

    function PipelineStrip(props) {
      var runStatus = props.runStatus || null
      var plan = props.plan || null
      var steps = asArray(runStatus && runStatus.steps)
      var list = steps.length ? steps : asArray(plan && plan.steps)
      if (!list.length) return null
      return h('div', { className: 'bf-pipe', 'aria-label': '流水线节点' }, list.map(function (step, index) {
        var status = step.status || (plan ? 'pending' : 'queued')
        var tone = stepTone(status)
        return h('div', { key: step.step_id || index, className: 'bf-pipe-node', title: asText(step.step_id, '') + ' · ' + asText(status, '') },
          h('div', { className: 'bf-pipe-rail' },
            index > 0 ? h('span', { className: 'bf-pipe-line bf-pipe-line-in bf-tone-' + tone }) : null,
            h('span', { className: 'bf-pipe-dot bf-tone-' + tone }, step.status === 'ok' ? '✓' : step.status === 'failed' ? '✕' : String(index + 1)),
            index < list.length - 1 ? h('span', { className: 'bf-pipe-line bf-pipe-line-out bf-tone-' + tone }) : null),
          h('span', { className: 'bf-pipe-label bf-truncate' }, asText(step.label || step.step_id, '')))
      }))
    }

    function WorkspaceTabs(props) {
      var tabState = useState('artifacts')
      var tab = tabState[0]
      var setTab = tabState[1]
      var tabs = [
        { id: 'artifacts', label: '产物与证据' },
        { id: 'sources', label: '数据源检索' },
        { id: 'downloads', label: '下载队列' },
        { id: 'joint', label: '联合分析' },
        { id: 'advisor', label: 'AI 挑数据' },
      ]
      return h('div', { className: 'bf-stack' },
        h('div', { className: 'bf-tabbar', role: 'tablist' }, tabs.map(function (item) {
          return h('button', {
            key: item.id, type: 'button', role: 'tab',
            'aria-selected': tab === item.id ? 'true' : 'false',
            className: 'bf-tab' + (tab === item.id ? ' bf-tab-on' : ''),
            onClick: function () { setTab(item.id) },
          }, item.label)
        })),
        tab === 'artifacts'
          ? h(ArtifactsPanel, props.artifacts)
          : tab === 'sources'
            ? h(SourceSearch, props.sources)
            : tab === 'joint'
              ? h(JointPanel, { api: props.api, onRefreshRuns: props.onRefreshRuns, onCompose: props.onCompose, onBackToWish: props.onBackToWish })
              : tab === 'advisor'
                ? h(AdvisorPanel, { api: props.api, onCompose: props.onCompose, onBackToWish: props.onBackToWish })
                : h(DownloadQueue, props.downloads))
    }

    // ----------------------------------------------------------------------
    // 思路链（独立页面）：问题 → 假设 → 生信证据 → 预期结果
    // ----------------------------------------------------------------------
    var LOGIC_SECTIONS = [
      { key: 'question', title: '要解决的问题', hint: '临床问题或科学问题，一句话说清（例如：胃癌肝转移中 NK 细胞为何失能？）', placeholder: '例如：胃癌肝转移（GC-LM）中 NK 细胞比例与功能是否系统性下降？' },
      { key: 'hypothesis', title: '假设的思路', hint: '可证伪的机制假设；写清"如果…那么…"和预期方向', placeholder: '例如：肝转移微环境通过 TGF-β 抑制 NK 的细胞毒程序；因此肝转移灶 NK 的 GZMB/IFNG 低于原发灶' },
      { key: 'evidence', title: '生物信息学证据', hint: '每条证据绑定数据集/run/表行或 PMID；模型预测必须标注', placeholder: '例如：GSE#### 的 pseudobulk 显示 tumor vs normal NK 的 GZMB logFC=-1.2（FDR 0.01）；PMID 12345678 报告同类方向' },
      { key: 'expected', title: '预期结果', hint: '做出来后应该看到什么（含阴性预期与判定阈值）', placeholder: '例如：若假设成立，肝转移 NK 的细胞毒评分下降 ≥0.5 SD，且与生存期负相关（HR>1）' },
    ]

    function logicStorageKey(dataRoot) {
      return 'bf-logic::' + String(dataRoot || 'default')
    }

    function readLogic(dataRoot) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return null
        var raw = window.localStorage.getItem(logicStorageKey(dataRoot))
        return raw ? JSON.parse(raw) : null
      } catch (error) { return null }
    }

    function writeLogic(dataRoot, value) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return false
        window.localStorage.setItem(logicStorageKey(dataRoot), JSON.stringify(value))
        return true
      } catch (error) { return false }
    }

    function LogicPage(props) {
      var seed = readLogic(props.dataRoot) || {}
      var logicState = useState({
        question: asText(seed.question, ''),
        hypothesis: asText(seed.hypothesis, ''),
        evidence: asText(seed.evidence, ''),
        expected: asText(seed.expected, ''),
      })
      var logic = logicState[0]
      var setLogic = logicState[1]
      var statusState = useState('')
      var status = statusState[0]
      var setStatus = statusState[1]
      function patch(key, value) { setLogic(function (previous) { return Object.assign({}, previous, { [key]: value }) }) }
      function save() {
        setStatus(writeLogic(props.dataRoot, logic) ? '已保存到本机（localStorage，按数据根隔离）' : '保存失败：当前环境没有 localStorage')
      }
      function toMarkdown() {
        return LOGIC_SECTIONS.map(function (section) {
          return '## ' + section.title + '\n' + (asText(logic[section.key], '').trim() || '（待补）')
        }).join('\n\n')
      }
      function copyMarkdown() {
        var text = toMarkdown()
        if (props.onCopy) props.onCopy(text)
        setStatus('思路链 Markdown 已复制')
      }
      function backToWish() {
        var parts = []
        LOGIC_SECTIONS.forEach(function (section) {
          var value = asText(logic[section.key], '').trim()
          if (value) parts.push(section.title + '：' + value)
        })
        var need = parts.length
          ? '基于我的思路链做分析计划：' + parts.join('；') + '。请先按这个思路找公共数据（GEO/PubMed/TCGA），再给出可执行的分析计划。'
          : '帮我从临床问题出发梳理思路链，再给分析计划。'
        save()
        if (props.onCompose) props.onCompose(need)
        props.onBack()
      }
      return h('div', { className: 'bf-logic' },
        h('div', { className: 'bf-logic-head' },
          h('div', { className: 'bf-logic-title' },
            h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'flow', size: 13 }), '思路链'),
            h('span', { className: 'bf-panel-sub' }, '问题 → 假设 → 生信证据 → 预期结果；独立页面，可复制成 Markdown 或带回许愿')),
          h('div', { className: 'bf-spacer' }),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: props.onBack }, h(Icon, { name: 'chevron', size: 11 }), '返回问题入手'),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: save }, h(Icon, { name: 'check', size: 11 }), '保存'),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: copyMarkdown }, h(Icon, { name: 'copy', size: 11 }), '复制 Markdown'),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', onClick: backToWish }, h(Icon, { name: 'send', size: 11 }), '带回许愿')),
        status ? h('div', { className: 'bf-logic-status' }, status) : null,
        h('div', { className: 'bf-logic-grid' }, LOGIC_SECTIONS.map(function (section, index) {
          var value = asText(logic[section.key], '')
          return h('section', { key: section.key, className: 'bf-logic-card' },
            h('div', { className: 'bf-logic-card-head' },
              h('span', { className: 'bf-logic-step bf-mono' }, String(index + 1).padStart(2, '0')),
              h('span', { className: 'bf-logic-card-title' }, section.title),
              h('span', { className: 'bf-logic-count bf-mono' }, value.trim() ? value.trim().split(/\n+/).length + ' 条' : '待补')),
            h('p', { className: 'bf-logic-hint' }, section.hint),
            h('textarea', {
              className: 'bf-logic-input', value: value,
              placeholder: section.placeholder, rows: 5,
              onChange: function (event) { patch(section.key, event.target.value) },
            }))
        })),
        h('div', { className: 'bf-logic-foot' },
          h('span', { className: 'bf-composer-hint' }, '提示：证据里的每条结论最好能对上 run_id/table_id/row_id 或 PMID；模型推演（虚拟扰动/签名映射）请标注"模型预测"。'),
          h('div', { className: 'bf-spacer' }),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: props.onBack }, '关闭')))
    }

    // ----------------------------------------------------------------------
    // 模式三：疾病引导 —— 选疾病 + 数据形式 + 目标 → 拼成一句许愿
    // ----------------------------------------------------------------------
    var DISEASE_PRESETS = [
      { id: 'gc-lm', disease: '胃癌肝转移', hint: 'GC-LM', data: 'scrna', goal: 'composition' },
      { id: 'luad', disease: '肺腺癌', hint: 'LUAD', data: 'bulk', goal: 'de' },
      { id: 'crc-lm', disease: '结直肠癌肝转移', hint: 'CRC-LM', data: 'bulk', goal: 'de' },
      { id: 'hcc', disease: '肝细胞癌', hint: 'HCC', data: 'bulk', goal: 'de' },
      { id: 'pdac', disease: '胰腺癌', hint: 'PDAC', data: 'spatial', goal: 'spatial' },
      { id: 'brca', disease: '乳腺癌', hint: 'BRCA', data: 'bulk', goal: 'de' },
    ]

    var KIND_LABELS = { bulk: 'bulk 转录组', scrna: '单细胞', spatial: '空间转录组', metabolomics: '代谢组', matrix: '矩阵', unknown: '未知' }

    function guidedKindLabel(kind) { return KIND_LABELS[kind] || KIND_LABELS.unknown }

    /** 不同类型 = 一脉相承的下一步（不是拼在一起做推断）。 */
    function chainHintFor(kind, primaryKind) {
      if (kind === 'scrna') return '把基准数据的差异结果/签名映射到单细胞队列（joint mode=signature，产物标 model_prediction）'
      if (kind === 'spatial') return '用空间队列做空间域/反卷积，与基准数据结果互相印证（不做跨模态合并推断）'
      if (kind === 'metabolomics') return '代谢组做通路层面的正交验证，不与 bulk 直接合并来做差异'
      if (kind === 'bulk' && primaryKind !== 'bulk') return 'bulk 作为独立验证队列：分别分析，再用 joint meta 合并效应'
      return '作为独立的验证队列，分别分析后按需 joint meta 合并'
    }

    function GuidedPage(props) {
      var api = props.api
      var formState = useState({ disease: '', goal: 'de', caseGroup: 'tumor', controlGroup: 'normal', place: '' })
      var form = formState[0]
      var setForm = formState[1]
      var datasetsState = useState({ loading: true, error: null, list: [] })
      var datasets = datasetsState[0]
      var setDatasets = datasetsState[1]
      var primaryState = useState('')
      var primaryId = primaryState[0]
      var setPrimaryId = primaryState[1]
      var addedState = useState([])
      var addedIds = addedState[0]
      var setAddedIds = addedState[1]
      var methodState = useState('quantile')
      var method = methodState[0]
      var setMethod = methodState[1]
      var busyState = useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var statusState = useState('')
      var status = statusState[0]
      var setStatus = statusState[1]
      var errorState = useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var onlineState = useState({ loading: false, error: null, data: null, term: '' })
      var online = onlineState[0]
      var setOnline = onlineState[1]
      var onlineStatusState = useState({})
      var onlineStatus = onlineStatusState[0]
      var setOnlineStatus = onlineStatusState[1]

      React.useEffect(function () {
        if (!api) return
        api.dispatch({ action: 'datasets', limit: 100 }).then(function (data) {
          var list = asArray(data && data.datasets)
          setDatasets({ loading: false, error: null, list: list })
          setPrimaryId(function (previous) { return previous || (list[0] ? list[0].dataset_id : '') })
        }).catch(function (problem) { setDatasets({ loading: false, error: problem, list: [] }) })
      }, [])

      function patch(key, value) { setForm(function (previous) { return Object.assign({}, previous, { [key]: value }) }) }
      function pickPreset(preset) {
        setForm(function (previous) { return Object.assign({}, previous, { disease: preset.disease, goal: preset.goal }) })
      }
      function byId(id) { return (datasets.list || []).find(function (row) { return row.dataset_id === id }) || null }
      function kindOf(id) { var row = byId(id); return (row && row.data_kind) || 'unknown' }
      function nOf(id) { var row = byId(id); return row ? row.n_samples : null }
      function groupsOf(id) { var row = byId(id); return asArray(row && row.groups) }
      function addDataset(id) {
        if (!id || id === primaryId || addedIds.indexOf(id) >= 0) return
        setAddedIds(function (previous) { return previous.concat([id]) })
      }
      function removeDataset(id) {
        setAddedIds(function (previous) { return previous.filter(function (item) { return item !== id }) })
      }
      function searchOnline() {
        if (!api) return
        var term = asText(online.term, '').trim() || asText(form.disease, '').trim() || asText(form.term, '').trim()
        if (!term) { setOnline(function (previous) { return Object.assign({}, previous, { error: { message: '先填疾病或检索词' } }) }); return }
        setOnline(function (previous) { return Object.assign({}, previous, { loading: true, error: null, data: null }) })
        api.dispatch({ action: 'advise', need: term, sources: ['geo', 'gdc', 'metabolights'], limit: 8 })
          .then(function (data) { setOnline({ loading: false, error: null, data: data, term: term }) })
          .catch(function (problem) { setOnline(function (previous) { return Object.assign({}, previous, { loading: false, error: problem }) }) })
      }
      function acquireOnline(item, asPrimary) {
        var key = asText(item.source, 'geo') + ':' + asText(item.dataset_id, '')
        if (!api || !key) return
        setOnlineStatus(function (previous) { return Object.assign({}, previous, { [key]: { stage: 'downloading' } }) })
        setStatus('正在下载 ' + asText(item.dataset_id, '') + ' …')
        api.dispatch({ action: 'download', source: item.source || 'geo', id: item.dataset_id }).then(function (download) {
          var artifacts = asArray(download && download.artifact_ids)
          if (!artifacts.length && download && download.artifacts) artifacts = asArray(download.artifacts).map(function (entry) { return entry.artifact_id || entry.id })
          if (!artifacts.length) throw { message: '下载没有返回 artifact_id' }
          setOnlineStatus(function (previous) { return Object.assign({}, previous, { [key]: { stage: 'registering' } }) })
          setStatus('下载完成，登记中（自动探测矩阵方向/尺度）…')
          return api.dispatch({ action: 'register', artifact_ids: artifacts, name: item.dataset_id, assay: 'auto' })
        }).then(function (result) {
          var dataset = result && result.dataset
          if (!dataset) throw { message: (result && result.summary) || '登记失败' }
          setOnlineStatus(function (previous) { return Object.assign({}, previous, { [key]: { stage: 'done', datasetId: dataset.dataset_id } }) })
          setStatus('已登记 ' + dataset.dataset_id + '：' + asText(result.summary, ''))
          if (asPrimary) setPrimaryId(dataset.dataset_id)
          else addDataset(dataset.dataset_id)
          api.dispatch({ action: 'datasets', limit: 100 }).then(function (data2) {
            var list = asArray(data2 && data2.datasets)
            setDatasets({ loading: false, error: null, list: list })
          }).catch(function () { /* ignore */ })
        }).catch(function (problem) {
          setOnlineStatus(function (previous) { return Object.assign({}, previous, { [key]: { stage: 'error', error: asText(problem && (problem.message || problem.error), '失败') } }) })
          setStatus('失败：' + asText(problem && (problem.message || problem.error), '未知错误'))
        })
      }
      var availableToAdd = (datasets.list || []).filter(function (row) {
        return row.dataset_id !== primaryId && addedIds.indexOf(row.dataset_id) < 0
      })
      var primaryKind = kindOf(primaryId)
      var entries = [primaryId].concat(addedIds).filter(Boolean).map(function (id) {
        var kind = kindOf(id)
        return {
          id: id, kind: kind, kindLabel: guidedKindLabel(kind),
          n: nOf(id), groups: groupsOf(id), isPrimary: id === primaryId,
          sameKind: Boolean(primaryId) && kind === primaryKind,
        }
      })
      var sameKindIds = entries.filter(function (item) { return item.sameKind }).map(function (item) { return item.id })
      var differentKind = entries.filter(function (item) { return !item.sameKind })
      var needsHarmonize = sameKindIds.length >= 2
      function templateForPrimary() {
        return primaryKind === 'scrna' ? 'scrna-composition' : primaryKind === 'spatial' ? 'spatial-domain' : primaryKind === 'metabolomics' ? 'metabolomics-de' : 'bulk-two-group'
      }

      function buildWish(mergedId) {
        var base = form.disease ? '针对' + form.disease + '，' : ''
        var primary = primaryId ? '以数据集 ' + primaryId : '用我已登记的数据'
        var design = '按 ' + (form.caseGroup || 'tumor') + ' vs ' + (form.controlGroup || 'normal') + ' 比较'
        var parts = [base + primary + '（' + guidedKindLabel(primaryKind) + '）为基准，' + design + '，模板 ' + templateForPrimary()]
        if (mergedId) {
          parts.push('其中同类型队列 ' + sameKindIds.join('、') + ' 已先 harmonize（method=' + method + '）去批次合并成数据集 ' + mergedId + '，请直接在这个合并数据集上继续分析')
        } else if (needsHarmonize) {
          parts.push('同类型队列 ' + sameKindIds.join('、') + ' 必须先 harmonize（method=' + method + '）去批次，合并成一个数据集后再分析（不要直接拼原始矩阵）')
        }
        if (differentKind.length) {
          parts.push('不同类型的数据按「一脉相承」处理：' + differentKind.map(function (item) {
            return item.id + '（' + item.kindLabel + '）' + chainHintFor(item.kind, primaryKind)
          }).join('；'))
        }
        return parts.join('；') + '。先出 draft 计划，缺的字段给我候选。'
      }

      function composeAndBack() {
        var text = buildWish('')
        if (props.onCompose) props.onCompose(text)
        if (props.onBack) props.onBack()
      }
      function harmonizeThenCompose() {
        if (!api || sameKindIds.length < 2) { composeAndBack(); return }
        setBusy('harmonize')
        setError(null)
        setStatus('正在去批次合并 ' + sameKindIds.length + ' 个同类型队列（' + method + '）…')
        api.dispatch({ action: 'harmonize', dataset_ids: sameKindIds, method: method, target_scale: 'log_expression' })
          .then(function (result) {
            setBusy('')
            if (!result || !result.merged_dataset_id) throw { message: (result && (result.merged_error || result.summary)) || '没有登记合并数据集' }
            setStatus('合并完成：' + result.merged_dataset_id)
            var text = buildWish(result.merged_dataset_id)
            if (props.onCompose) props.onCompose(text)
            if (props.onBack) props.onBack()
          })
          .catch(function (problem) {
            setBusy('')
            setError(problem)
            setStatus('合并失败：' + asText(problem && (problem.message || problem.error), '未知错误'))
          })
      }

      var datasetRows = (datasets.list || []).map(function (row) {
        return h('option', { key: row.dataset_id, value: row.dataset_id },
          shortId(row.dataset_id, 16) + ' · ' + asText(row.name, '') + ' · ' + guidedKindLabel(row.data_kind) + ' · n=' + asText(row.n_samples, '?'))
      })
      var entriesView = entries.map(function (item) {
        return h('div', { key: item.id, className: 'bf-clinical-hit' },
          h('div', { className: 'bf-clinical-hit-title' },
            h('span', { className: 'bf-mono' }, item.id),
            h('span', { className: 'bf-muted' }, ' · ' + item.kindLabel + ' · n=' + asText(item.n, '?') + (item.groups.length ? ' · 分组 ' + item.groups.join('/') : '')),
            h('span', { className: 'bf-badge ' + (item.sameKind ? 'bf-badge-warn' : 'bf-badge-run') }, item.isPrimary ? '基准' : item.sameKind ? '同类型：需去批次' : '不同类型：一脉相承')),
          !item.isPrimary ? h('div', { className: 'bf-joint-actions' },
            h('span', { className: 'bf-composer-hint' }, item.sameKind
              ? '同类型多队列直接合并会引入批次效应，必须先 harmonize 去批次'
              : '不同类型不合并做推断，而是作为下一步/验证：' + chainHintFor(item.kind, primaryKind)),
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: function () { removeDataset(item.id) } }, '移除')) : null)
      })

      return h('div', { className: 'bf-logic' },
        h('div', { className: 'bf-logic-head' },
          h('div', { className: 'bf-logic-title' },
            h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'flow', size: 13 }), '疾病引导'),
            h('span', { className: 'bf-panel-sub' }, '疾病 + 数据（可加号追加）→ 同类型去批次合并 / 不同类型一脉相承 → 生成计划许愿')),
          h('div', { className: 'bf-spacer' }),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: props.onBack }, h(Icon, { name: 'chevron', size: 11 }), '返回许愿'))),
        h('div', { className: 'bf-clinical-grid' },
          h('section', { className: 'bf-logic-card' },
            h('div', { className: 'bf-logic-card-head' }, h('span', { className: 'bf-logic-step bf-mono' }, '01'), h('span', { className: 'bf-logic-card-title' }, '疾病 / 场景')),
            h('label', { className: 'bf-tpl-field' }, '直接输入任意疾病（癌种 + 部位 + 场景都可以）',
              h('input', {
                className: 'bf-input', list: 'bf-disease-suggestions', value: form.disease,
                placeholder: '如 食管鳞癌新辅助治疗后 / 胃癌肝转移 / 胰腺癌肝转移',
                onChange: function (event) { patch('disease', event.target.value) },
              }),
              h('datalist', { id: 'bf-disease-suggestions' }, DISEASE_PRESETS.map(function (preset) {
                return h('option', { key: preset.id, value: preset.disease })
              }))),
            h('div', { className: 'bf-chips' },
              h('span', { className: 'bf-composer-hint' }, '常见（点一下填入，可改）：'),
              DISEASE_PRESETS.map(function (preset) {
                return h('button', { key: preset.id, type: 'button', className: 'bf-chip', onClick: function () { pickPreset(preset) } }, preset.disease)
              })),
            h('label', { className: 'bf-tpl-field' }, '数据（本地已登记；一个都没有就用下面的在线检索）',
              datasets.loading ? h('div', { className: 'bf-muted' }, '正在加载数据集…')
                : datasets.list.length
                  ? h('select', { className: 'bf-select bf-input-sm', value: primaryId, onChange: function (event) { setPrimaryId(event.target.value); setAddedIds([]) } }, datasetRows)
                  : h('div', { className: 'bf-muted' }, '本地还没有已登记数据——直接用下面「搜在线数据（GEO / TCGA / MetaboLights）」，选中会自动下载并登记。')),
            h('label', { className: 'bf-tpl-field' }, '＋ 从本地已登记里追加（在线数据用下面一栏）',
              h('div', { className: 'bf-row' },
                h('select', {
                  className: 'bf-select bf-input-sm', style: { flex: '1 1 220px' }, value: '',
                  onChange: function (event) { addDataset(event.target.value); event.target.value = '' },
                  disabled: !availableToAdd.length,
                },
                  h('option', { value: '' }, availableToAdd.length ? '选一个数据集追加…' : '没有可追加的数据集'),
                  availableToAdd.map(function (row) {
                    return h('option', { key: row.dataset_id, value: row.dataset_id },
                      row.dataset_id + ' · ' + asText(row.name, '') + ' · ' + guidedKindLabel(row.data_kind))
                  })))),
            h('div', { className: 'bf-tpl-field', style: { marginTop: '4px' } }, '或者直接从在线库选（GEO / TCGA-GDC / MetaboLights）'),
            h('div', { className: 'bf-row' },
              h('input', {
                className: 'bf-input bf-input-sm', style: { flex: '1 1 220px' },
                value: online.term, placeholder: '检索词，默认用上面的疾病（如 gastric cancer liver metastasis）',
                onChange: function (event) { setOnline(function (previous) { return Object.assign({}, previous, { term: event.target.value }) }) },
                onKeyDown: function (event) { if (isImeComposing(event)) return; if (event.key === 'Enter') searchOnline() },
              }),
              h('button', { type: 'button', className: 'bf-btn bf-btn-sm', disabled: online.loading, onClick: searchOnline },
                h(Icon, { name: 'search', size: 11 }), online.loading ? '检索中…' : '搜在线数据')),
            online.error ? h('div', { className: 'bf-inline-error' }, '在线检索失败：' + asText(online.error.message || online.error, '未知错误')) : null,
            online.loading ? h(Skeleton, { lines: 3 }) : null,
            online.data && asArray(online.data.recommendations).length ? h('div', { className: 'bf-joint-list' }, asArray(online.data.recommendations).map(function (item) {
              var key = asText(item.source, 'geo') + ':' + asText(item.dataset_id, '')
              var info = onlineStatus[key] || {}
              var summary = item.summary_zh || {}
              return h('div', { key: key, className: 'bf-clinical-hit' },
                h('div', { className: 'bf-clinical-hit-title' }, asText(summary.headline, asText(item.dataset_id, '')) + ' · 得分 ' + asText(item.score, 0)),
                h('div', { className: 'bf-clinical-hit-meta bf-muted' }, asText(summary.text, '')),
                h('div', { className: 'bf-joint-actions' },
                  info.stage === 'done'
                    ? h('span', { className: 'bf-mono bf-tone-ok' }, '已登记 ' + info.datasetId)
                    : h('button', {
                      type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary',
                      disabled: info.stage === 'downloading' || info.stage === 'registering',
                      onClick: function () { acquireOnline(item, true) },
                    }, h(Icon, { name: 'download', size: 11 }), info.stage === 'downloading' ? '下载中…' : info.stage === 'registering' ? '登记中…' : '设为基准数据（下载+登记）'),
                  info.stage === 'done'
                    ? h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: function () { addDataset(info.datasetId) } }, '加为追加数据')
                    : h('button', {
                      type: 'button', className: 'bf-btn bf-btn-sm',
                      disabled: info.stage === 'downloading' || info.stage === 'registering',
                      onClick: function () { acquireOnline(item, false) },
                    }, info.stage === 'downloading' ? '下载中…' : info.stage === 'registering' ? '登记中…' : '追加数据（下载+登记）'),
                  info.error ? h('span', { className: 'bf-tone-err' }, info.error) : null))
            })) : null,
            h('div', { className: 'bf-tpl-grid' },
              h('label', { className: 'bf-tpl-field' }, '实验组',
                h('input', { className: 'bf-input bf-input-sm', value: form.caseGroup, onChange: function (event) { patch('caseGroup', event.target.value) } })),
              h('label', { className: 'bf-tpl-field' }, '对照组',
                h('input', { className: 'bf-input bf-input-sm', value: form.controlGroup, onChange: function (event) { patch('controlGroup', event.target.value) } })),
              h('label', { className: 'bf-tpl-field' }, '分析目标',
                h('select', { className: 'bf-select bf-input-sm', value: form.goal, onChange: function (event) { patch('goal', event.target.value) } },
                  WISH_GOALS.map(function (item) { return h('option', { key: item.id, value: item.id }, item.label) }))),
              needsHarmonize ? h('label', { className: 'bf-tpl-field' }, '去批次方法',
                h('select', { className: 'bf-select bf-input-sm', value: method, onChange: function (event) { setMethod(event.target.value) } },
                  ['quantile', 'combat', 'scale_only', 'none'].map(function (item) { return h('option', { key: item, value: item }, item) }))) : null),
            needsHarmonize ? h('div', { className: 'bf-inline-error', style: { marginTop: '2px' } },
              '检测到 ' + sameKindIds.length + ' 个同类型队列（' + sameKindIds.join('、') + '）：直接合并会引入批次效应，必须先 harmonize 去批次再合并/联合。') : null),
          h('section', { className: 'bf-logic-card' },
            h('div', { className: 'bf-logic-card-head' }, h('span', { className: 'bf-logic-step bf-mono' }, '02'), h('span', { className: 'bf-logic-card-title' }, '已选数据与处理方式')),
            h('div', { className: 'bf-joint-list' }, entriesView.length ? entriesView : h('div', { className: 'bf-muted' }, '先在上面选一个本地数据，或直接搜在线数据；再用「＋ 追加」加其他队列。')),
            status ? h('div', { className: 'bf-logic-status' }, status) : null,
            error ? h('div', { className: 'bf-inline-error' }, '失败：' + asText(error.message || error.error || error, '未知错误')) : null,
            h('div', { className: 'bf-logic-card-head' }, h('span', { className: 'bf-logic-step bf-mono' }, '03'), h('span', { className: 'bf-logic-card-title' }, '将生成的计划许愿')),
            h('div', { className: 'bf-logic-preview' }, buildWish('')),
            h('div', { className: 'bf-joint-actions' },
              h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', disabled: Boolean(busy), onClick: composeAndBack },
                h(Icon, { name: 'send', size: 11 }), '生成计划许愿'),
              needsHarmonize ? h('button', { type: 'button', className: 'bf-btn bf-btn-sm', disabled: Boolean(busy), onClick: harmonizeThenCompose },
                h(Icon, { name: 'flow', size: 11 }), busy === 'harmonize' ? '去批次合并中…' : '先去批次合并，再生成计划') : null,
              h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: function () { if (props.onQuestion) props.onQuestion(form.disease) } }, '换成问题入手')),
            h('p', { className: 'bf-logic-hint' }, '同类型（多个 bulk）：必须先 harmonize 去批次再合并，不能直接拼矩阵；不同类型（bulk + 单细胞/空间/代谢）：按「一脉相承」串起来（映射/验证/正交），不做跨模态合并推断。')))
    }

    // ----------------------------------------------------------------------
    // 临床问题入手：临床现象 → 文献/数据核实 → 转成许愿或写入思路链
    // ----------------------------------------------------------------------
    var CLINICAL_SOURCES = [
      { id: 'pubmed', label: 'PubMed 文献' },
      { id: 'geo', label: 'GEO 队列' },
      { id: 'gdc', label: 'TCGA/GDC' },
      { id: 'metabolights', label: 'MetaboLights' },
    ]

    function ClinicalPage(props) {
      var api = props.api
      var formState = useState({ disease: '', phenomenon: '', endpoint: '', term: '' })
      var form = formState[0]
      var setForm = formState[1]
      var sourceState = useState({ pubmed: true, geo: true, gdc: false, metabolights: false })
      var sources = sourceState[0]
      var setSources = sourceState[1]
      var searchState = useState({ loading: false, error: null, data: null })
      var search = searchState[0]
      var setSearch = searchState[1]
      var statusState = useState('')
      var status = statusState[0]
      var setStatus = statusState[1]
      var topicsState = useState({ loading: false, error: null, data: null })
      var topics = topicsState[0]
      var setTopics = topicsState[1]

      function patch(key, value) {
        setForm(function (previous) { return Object.assign({}, previous, { [key]: value }) })
      }
      function loadTopics() {
        var disease = asText(form.disease, '').trim() || asText(form.term, '').trim()
        if (!disease || !api) { setTopics({ loading: false, error: { message: '先填疾病/场景' }, data: null }); return }
        setTopics({ loading: true, error: null, data: null })
        api.dispatch({ action: 'topics', disease: disease })
          .then(function (data) { setTopics({ loading: false, error: null, data: data }) })
          .catch(function (problem) { setTopics({ loading: false, error: problem, data: null }) })
      }
      function toggleSource(id) {
        setSources(function (previous) { return Object.assign({}, previous, { [id]: !previous[id] }) })
      }
      function chosenSources() {
        return CLINICAL_SOURCES.filter(function (item) { return sources[item.id] }).map(function (item) { return item.id })
      }
      function queryText() {
        var parts = [asText(form.term, '').trim() || asText(form.disease, '').trim(), asText(form.phenomenon, '').trim(), asText(form.endpoint, '').trim()]
        return parts.filter(Boolean).join(' ')
      }
      function doSearch() {
        if (!api) return
        var term = queryText()
        if (!term) { setSearch({ loading: false, error: { message: '先写一句临床现象（或疾病关键词）' }, data: null }); return }
        setSearch({ loading: true, error: null, data: null })
        setStatus('')
        api.dispatch({ action: 'search', term: term, sources: chosenSources(), limit: 8 })
          .then(function (data) { setSearch({ loading: false, error: null, data: data }) })
          .catch(function (problem) { setSearch({ loading: false, error: problem, data: null }) })
      }
      function pubmedItems() {
        var items = search.data && search.data.items
        return asArray(items && items.pubmed)
      }
      function geoItems() {
        var items = search.data && search.data.items
        return asArray(items && items.geo).concat(asArray(items && items.gdc))
      }
      function evidenceLines() {
        var lines = []
        pubmedItems().slice(0, 5).forEach(function (item) {
          var pmid = asText(item.id || item.pmid, '')
          if (!pmid) return
          lines.push(asText(item.title, '') + '（PMID ' + pmid + (item.year ? '，' + item.year : '') + '）')
        })
        geoItems().slice(0, 4).forEach(function (item) {
          var id = asText(item.id || item.gse, '')
          if (!id) return
          lines.push(id + '：' + asText(item.title, '') + (item.n_samples ? '（n=' + item.n_samples + '）' : ''))
        })
        return lines
      }
      function toWish() {
        var lines = evidenceLines()
        var need = '临床问题核实：'
          + (asText(form.disease, '').trim() ? '疾病/场景：' + asText(form.disease, '').trim() + '；' : '')
          + '临床现象：' + (asText(form.phenomenon, '').trim() || '（待补）') + '；'
          + (asText(form.endpoint, '').trim() ? '关注结局：' + asText(form.endpoint, '').trim() + '；' : '')
          + (lines.length ? '我已初步检索到：' + lines.join('；') + '。' : '')
          + '请核实这个临床现象是否已被文献和公共数据支持：给出支持/相反证据、证据强度、数据适配度（物种/样本量/终点/尺度），'
          + '再给出可执行的生信分析计划（先 search 选题，再 register/plan）。不确定的不要编造。'
        if (props.onCompose) props.onCompose(need)
        if (props.onBack) props.onBack()
      }
      function toLogic() {
        try {
          var current = readLogic(props.dataRoot) || {}
          var question = [asText(form.disease, '').trim(), asText(form.phenomenon, '').trim()].filter(Boolean).join('：')
          var existing = asText(current.question, '').trim()
          current.question = existing ? existing + '\n' + question : question
          writeLogic(props.dataRoot, current)
          setStatus('已写入思路链的「要解决的问题」')
        } catch (error) { setStatus('写入失败：' + asText(error && error.message, '未知错误')) }
      }

      var pubs = pubmedItems()
      var cohorts = geoItems()
      return h('div', { className: 'bf-logic' },
        h('div', { className: 'bf-logic-head' },
          h('div', { className: 'bf-logic-title' },
            h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'search', size: 13 }), '临床问题入手'),
            h('span', { className: 'bf-panel-sub' }, '先写临床现象 → 查文献与队列 → 一键转成核实许愿或写入思路链')),
          h('div', { className: 'bf-spacer' }),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: props.onBack }, h(Icon, { name: 'chevron', size: 11 }), '返回指挥台')),
        status ? h('div', { className: 'bf-logic-status' }, status) : null,
        h('div', { className: 'bf-clinical-grid' },
          h('section', { className: 'bf-logic-card' },
            h('div', { className: 'bf-logic-card-head' }, h('span', { className: 'bf-logic-step bf-mono' }, '01'), h('span', { className: 'bf-logic-card-title' }, '临床现象')),
            h('label', { className: 'bf-tpl-field' }, '疾病 / 场景',
              h('input', { className: 'bf-input bf-input-sm', value: form.disease, placeholder: '如 胃癌肝转移 / 肺腺癌脑转移', onChange: function (event) { patch('disease', event.target.value) } })),
            h('label', { className: 'bf-tpl-field' }, '现象（临床上观察到什么）',
              h('textarea', { className: 'bf-logic-input', style: { minHeight: '84px' }, value: form.phenomenon, placeholder: '如 肝转移患者外周血 NK 细胞比例下降、细胞毒基因表达低，且与预后差相关', onChange: function (event) { patch('phenomenon', event.target.value) } })),
            h('label', { className: 'bf-tpl-field' }, '关注结局 / 终点（可空）',
              h('input', { className: 'bf-input bf-input-sm', value: form.endpoint, placeholder: '如 OS / PFS / 治疗响应', onChange: function (event) { patch('endpoint', event.target.value) } })),
            h('label', { className: 'bf-tpl-field' }, '检索关键词（可空，默认拼上面三项）',
              h('input', { className: 'bf-input bf-input-sm', value: form.term, placeholder: '如 gastric cancer liver metastasis NK cell', onChange: function (event) { patch('term', event.target.value) } })),
            h('div', { className: 'bf-joint-actions' },
              h('button', { type: 'button', className: 'bf-btn bf-btn-sm', disabled: topics.loading, onClick: loadTopics },
                h(Icon, { name: 'search', size: 11 }), topics.loading ? '正在找选题…' : '给我几个选题（含近两年综述热点）')),
            topics.error ? h('div', { className: 'bf-inline-error' }, '选题检索失败：' + asText(topics.error.message || topics.error, '未知错误')) : null,
            topics.data ? h('div', { className: 'bf-joint-section' },
              h('div', { className: 'bf-joint-title' }, '候选临床现象 / 问题（点一个填入左侧）'),
              h('div', { className: 'bf-chips' }, asArray(topics.data.phenomena).map(function (item, index) {
                return h('button', {
                  key: item.id || index, type: 'button', className: 'bf-chip',
                  title: '点一下填入「现象」',
                  onClick: function () { patch('phenomenon', asText(item.text, '')) },
                }, asText(item.text, ''))
              })),
              asArray(topics.data.hot_topics).length ? h('div', { className: 'bf-joint-list' }, asArray(topics.data.hot_topics).map(function (paper, index) {
                return h('div', { key: paper.pmid || index, className: 'bf-clinical-hit' },
                  h('div', { className: 'bf-clinical-hit-title' }, asText(paper.title, '')),
                  h('div', { className: 'bf-clinical-hit-meta bf-muted' },
                    h('span', { className: 'bf-mono' }, paper.pmid ? 'PMID ' + paper.pmid : ''),
                    h('span', null, asText(paper.journal, '')),
                    h('span', null, asText(paper.year, ''))))
              })) : null) : null,
            h('div', { className: 'bf-joint-actions' },
              h('span', { className: 'bf-composer-hint' }, '数据源'),
              CLINICAL_SOURCES.map(function (item) {
                return h('label', { key: item.id, className: 'bf-joint-field' },
                  h('input', { type: 'checkbox', checked: Boolean(sources[item.id]), onChange: function () { toggleSource(item.id) } }),
                  item.label)
              })),
            h('div', { className: 'bf-joint-actions' },
              h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', disabled: search.loading, onClick: doSearch },
                h(Icon, { name: 'search', size: 11 }), search.loading ? '检索中…' : '查文献与队列'),
              h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: toLogic }, '写入思路链'),
              props.onLogic ? h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: function () { toLogic(); if (props.onLogic) props.onLogic() } }, '补充假设与预期 →') : null,
              h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: toWish }, h(Icon, { name: 'send', size: 11 }), '生成核实许愿')),
            search.error ? h('div', { className: 'bf-inline-error' }, '检索失败：' + asText(search.error.message || search.error, '未知错误')) : null),
          h('section', { className: 'bf-logic-card' },
            h('div', { className: 'bf-logic-card-head' }, h('span', { className: 'bf-logic-step bf-mono' }, '02'), h('span', { className: 'bf-logic-card-title' }, '文献与队列（检索结果）')),
            search.loading ? h(Skeleton, { lines: 4 }) : null,
            !search.loading && !search.data ? h('p', { className: 'bf-logic-hint' }, '还没有检索。填好现象后点「查文献与队列」，这里会列出 PubMed 命中与 GEO/GDC 候选，供你判断是否已有人报道、有没有可复用队列。') : null,
            pubs.length ? h('div', { className: 'bf-joint-section' },
              h('div', { className: 'bf-joint-title' }, 'PubMed · ' + pubs.length + ' 条'),
              h('div', { className: 'bf-joint-list' }, pubs.map(function (item) {
                var pmid = asText(item.id || item.pmid, '')
                return h('div', { key: pmid || asText(item.title, ''), className: 'bf-clinical-hit' },
                  h('div', { className: 'bf-clinical-hit-title' }, asText(item.title, '（无标题）')),
                  h('div', { className: 'bf-clinical-hit-meta bf-muted' },
                    h('span', { className: 'bf-mono' }, pmid ? 'PMID ' + pmid : ''),
                    h('span', null, asText(item.journal, '')),
                    h('span', null, asText(item.year, '')),
                    asArray(item.authors).slice(0, 2).map(function (author, index) { return h('span', { key: index }, asText(author, '')) })))
              }))) : null,
            cohorts.length ? h('div', { className: 'bf-joint-section' },
              h('div', { className: 'bf-joint-title' }, 'GEO / GDC · ' + cohorts.length + ' 个候选队列'),
              h('div', { className: 'bf-joint-list' }, cohorts.map(function (item) {
                var id = asText(item.id || item.gse, '')
                return h('div', { key: id, className: 'bf-clinical-hit' },
                  h('div', { className: 'bf-clinical-hit-title' }, h('span', { className: 'bf-mono' }, id || '—') + ' · ' + asText(item.title, '')),
                  h('div', { className: 'bf-clinical-hit-meta bf-muted' },
                    h('span', null, asText(item.species, '')),
                    h('span', null, item.n_samples ? 'n=' + item.n_samples : ''),
                    h('span', null, asText(item.platform, '')),
                    h('span', null, asText(item.scale && item.scale.type, ''))))
              }))) : null,
            search.data && !pubs.length && !cohorts.length ? h('p', { className: 'bf-logic-hint' }, '没有命中：换更通用的关键词，或减少限定词后重试。') : null,
            search.data && search.data.by_source ? h('p', { className: 'bf-logic-hint' },
              Object.keys(search.data.by_source).map(function (key) {
                var entry = search.data.by_source[key] || {}
                return key + '：' + asText(entry.total, 0) + ' 命中 / 取回 ' + asText(entry.fetched, 0)
              }).join(' · ')) : null)))
    }

    // ----------------------------------------------------------------------
    // AI 挑数据：给一句话 → 推荐数据集 + 文献线索 + 推荐方案 + 一键下载登记
    // ----------------------------------------------------------------------
    function AdvisorPanel(props) {
      var api = props.api
      var needState = useState('')
      var need = needState[0]
      var setNeed = needState[1]
      var runState = useState({ loading: false, error: null, data: null })
      var run = runState[0]
      var setRun = runState[1]
      var chainState = useState({})
      var chain = chainState[0]
      var setChain = chainState[1]
      var statusState = useState('')
      var status = statusState[0]
      var setStatus = statusState[1]

      function advise() {
        if (!api || !need.trim()) return
        setRun({ loading: true, error: null, data: null })
        setStatus('')
        api.dispatch({ action: 'advise', need: need.trim(), sources: ['geo', 'pubmed', 'gdc'], limit: 8 })
          .then(function (data) { setRun({ loading: false, error: null, data: data }) })
          .catch(function (problem) { setRun({ loading: false, error: problem, data: null }) })
      }
      function patchChain(id, value) {
        setChain(function (previous) { return Object.assign({}, previous, { [id]: Object.assign({}, previous[id], value) }) })
      }
      function acquire(recommendation) {
        var id = recommendation.dataset_id
        patchChain(id, { stage: 'downloading', error: null, datasetId: null })
        setStatus('正在下载 ' + id + ' …')
        api.dispatch({ action: 'download', source: recommendation.source, id: id })
          .then(function (download) {
            var artifacts = asArray(download && download.artifact_ids)
            if (!artifacts.length && download && download.artifacts) artifacts = asArray(download.artifacts).map(function (item) { return item.artifact_id || item.id })
            if (!artifacts.length) throw { message: '下载没有返回 artifact_id' }
            patchChain(id, { stage: 'registering' })
            setStatus('下载完成，正在登记并自动探测矩阵方向/尺度…')
            return api.dispatch({ action: 'register', artifact_ids: artifacts, name: id, assay: 'auto' })
          })
          .then(function (registered) {
            var dataset = registered && registered.dataset
            if (!dataset) throw { message: (registered && registered.summary) || '登记失败' }
            patchChain(id, { stage: 'done', datasetId: dataset.dataset_id, summary: registered.summary })
            setStatus('已登记 ' + dataset.dataset_id + '：' + asText(registered.summary, ''))
            if (props.onRefreshRuns) props.onRefreshRuns()
          })
          .catch(function (problem) {
            patchChain(id, { stage: 'error', error: asText(problem && (problem.message || problem.error), '失败') })
            setStatus('失败：' + asText(problem && (problem.message || problem.error), '未知错误'))
          })
      }
      function useForPlan(recommendation, datasetId) {
        var kind = asText(recommendation && recommendation.kind, 'bulk')
        var template = kind === 'scrna' ? 'scrna-composition' : kind === 'spatial' ? 'spatial-domain' : kind === 'metabolomics' ? 'metabolomics-de' : 'bulk-two-group'
        if (props.onCompose) props.onCompose('用数据集 ' + datasetId + ' 按 tumor vs normal 做分析（模板 ' + template + '），缺的字段给我候选，先出 draft 计划')
        if (props.onBackToWish) props.onBackToWish()
      }
      var data = run.data
      return h('div', { className: 'bf-joint' },
        h('div', { className: 'bf-panel-head' },
          h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'search', size: 12 }), 'AI 挑数据'),
          h('span', { className: 'bf-panel-sub' }, '给一句话：自动检索并排序候选队列、给文献线索、推荐模板与下一步')),
        h('div', { className: 'bf-joint-body' },
          h('div', { className: 'bf-joint-actions' },
            h('input', {
              className: 'bf-input bf-input-sm', style: { flex: '1 1 260px' }, value: need,
              placeholder: '如 胃癌肝转移 NK 细胞 单细胞 预后',
              onChange: function (event) { setNeed(event.target.value) },
              onKeyDown: function (event) { if (isImeComposing(event)) return; if (event.key === 'Enter') advise() },
            }),
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', disabled: run.loading, onClick: advise },
              h(Icon, { name: 'search', size: 11 }), run.loading ? '正在挑…' : '让 AI 挑数据')),
          status ? h('div', { className: 'bf-logic-status' }, status) : null,
          run.error ? h('div', { className: 'bf-inline-error' }, '失败：' + asText(run.error.message || run.error, '未知错误')) : null,
          run.loading ? h(Skeleton, { lines: 4 }) : null,
          data ? h('div', { className: 'bf-joint-section' },
            h('div', { className: 'bf-joint-title' }, '推荐（' + asArray(data.recommendations).length + '）· 检索词：' + asText(data.search_term, '')),
            h('div', { className: 'bf-joint-list' }, asArray(data.recommendations).map(function (recommendation, index) {
              var id = recommendation.dataset_id
              var state = chain[id] || {}
              return h('div', { key: id || index, className: 'bf-clinical-hit' },
                h('div', { className: 'bf-clinical-hit-title' },
                  h('span', { className: 'bf-mono' }, (index + 1) + '. ' + asText(id, '')),
                  h('span', { className: 'bf-muted' }, ' · ' + asText(recommendation.source, '') + ' · ' + asText(recommendation.kind, '') + ' · n=' + asText(recommendation.n_samples, '?'))),
                h('div', { className: 'bf-clinical-hit-meta bf-muted' },
                  h('span', { className: 'bf-badge bf-badge-run' }, '得分 ' + asText(recommendation.score, 0)),
                  asArray(recommendation.reasons).slice(0, 3).map(function (reason, i) { return h('span', { key: 'r' + i }, '✓ ' + asText(reason, '')) }),
                  asArray(recommendation.risks).slice(0, 2).map(function (risk, i) { return h('span', { key: 'k' + i, className: 'bf-tone-warn' }, '⚠ ' + asText(risk, '')) })),
                h('div', { className: 'bf-joint-actions' },
                  state.stage === 'done'
                    ? h('span', { className: 'bf-mono bf-tone-ok' }, state.datasetId)
                    : h('button', { type: 'button', className: 'bf-btn bf-btn-sm', disabled: state.stage === 'downloading' || state.stage === 'registering', onClick: function () { acquire(recommendation) } },
                      h(Icon, { name: 'download', size: 11 }), state.stage === 'downloading' ? '下载中…' : state.stage === 'registering' ? '登记中…' : '下载并登记'),
                  state.stage === 'done'
                    ? h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', onClick: function () { useForPlan(recommendation, state.datasetId) } }, h(Icon, { name: 'send', size: 11 }), '生成计划许愿')
                    : null,
                  state.error ? h('span', { className: 'bf-tone-err' }, state.error) : null))
            }))) : null,
          data && asArray(data.literature).length ? h('div', { className: 'bf-joint-section' },
            h('div', { className: 'bf-joint-title' }, '文献线索（别人做过什么）'),
            h('div', { className: 'bf-joint-list' }, asArray(data.literature).map(function (paper, index) {
              return h('div', { key: paper.pmid || index, className: 'bf-clinical-hit' },
                h('div', { className: 'bf-clinical-hit-title' }, asText(paper.title, '')),
                h('div', { className: 'bf-clinical-hit-meta bf-muted' },
                  h('span', { className: 'bf-mono' }, paper.pmid ? 'PMID ' + paper.pmid : ''),
                  h('span', null, asText(paper.journal, '')),
                  h('span', null, asText(paper.year, ''))))
            }))) : null,
          data && data.plan_hint ? h('div', { className: 'bf-joint-section' },
            h('div', { className: 'bf-joint-title' }, '推荐方案'),
            h('div', { className: 'bf-logic-preview' },
              h('div', null, '模板：' + asText(data.plan_hint.template, '')),
              h('div', null, '对照：' + asText(data.plan_hint.contrast_suggestion, '')),
              h('div', null, '要盯的闸门：' + asArray(data.plan_hint.gates_to_watch).join('、')),
              data.plan_hint.multi_dataset
                ? h('div', { className: 'bf-tone-warn' }, '多队列建议：' + asText(data.plan_hint.multi_dataset.suggestion, ''))
                : null)) : null,
          data && asArray(data.next_steps).length ? h('div', { className: 'bf-joint-section' },
            h('div', { className: 'bf-joint-title' }, '下一步怎么做'),
            h('div', { className: 'bf-joint-list' }, asArray(data.next_steps).map(function (step, index) {
              return h('div', { key: index, className: 'bf-clinical-hit' }, h('div', { className: 'bf-clinical-hit-title bf-mono' }, asText(step, '')))
            }))) : null))
    }

    // ----------------------------------------------------------------------
    // 候选数据集弹窗（中文摘要；问句里没点名时自动弹出）
    // ----------------------------------------------------------------------
    function DatasetPickerModal(props) {
      var options = asArray(props.options)
      if (!props.open) return null
      return h('div', { className: 'bf-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '候选数据集' },
        h('div', { className: 'bf-modal-card' },
          h('div', { className: 'bf-modal-head' },
            h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'list', size: 13 }), '候选数据集（中文摘要）'),
            h('span', { className: 'bf-panel-sub' }, '系统先替你挑了；点「用这个」就按它出计划，也可以换别的'),
            h('div', { className: 'bf-spacer' }),
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: props.onClose }, h(Icon, { name: 'close', size: 11 }), '关闭')),
          h('div', { className: 'bf-modal-body' }, options.length ? options.map(function (option) {
            var summary = option.summary_zh || {}
            var selected = option.dataset_id === props.currentId
            return h('div', { key: option.dataset_id, className: 'bf-clinical-hit' + (selected ? ' bf-wizard-picked' : '') },
              h('div', { className: 'bf-clinical-hit-title' }, asText(summary.headline, asText(option.dataset_id, ''))),
              h('div', { className: 'bf-clinical-hit-meta bf-muted' }, asText(summary.text, '')),
              asArray(summary.suitable).length ? h('div', { className: 'bf-clinical-hit-meta' }, asArray(summary.suitable).map(function (item, index) {
                return h('span', { key: 's' + index, className: 'bf-badge bf-badge-ok' }, '✓ ' + asText(item, ''))
              })) : null,
              asArray(summary.risks).length ? h('div', { className: 'bf-clinical-hit-meta' }, asArray(summary.risks).map(function (item, index) {
                return h('span', { key: 'r' + index, className: 'bf-tone-warn' }, '⚠ ' + asText(item, ''))
              })) : null,
              h('div', { className: 'bf-joint-actions' },
                h('button', {
                  type: 'button', className: 'bf-btn bf-btn-sm' + (selected ? '' : ' bf-btn-primary'),
                  onClick: function () { props.onPick(option.dataset_id) },
                }, selected ? '当前已选' : '用这个数据集出计划'),
                h('span', { className: 'bf-mono bf-muted' }, asText(option.dataset_id, ''))))
          }) : h('div', { className: 'bf-muted' }, '还没有已登记的数据集：先到「数据向导」或「AI 挑数据」里下载登记。'))))
    }

    // ----------------------------------------------------------------------
    // 回收站：列出被移入 trash/runs 的 run，可恢复或彻底删除
    // ----------------------------------------------------------------------
    function TrashModal(props) {
      var api = props.api
      var state = useState({ loading: false, error: null, items: [] })
      var trash = state[0]
      var setTrash = state[1]
      var busyState = useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]

      function reload() {
        if (!api) return
        setTrash(function (previous) { return Object.assign({}, previous, { loading: true, error: null }) })
        api.dispatch({ action: 'trash', trash_op: 'list' }).then(function (data) {
          setTrash({ loading: false, error: null, items: asArray(data && data.items) })
        }).catch(function (problem) { setTrash({ loading: false, error: problem, items: [] }) })
      }
      React.useEffect(function () { if (props.open) reload() }, [props.open])

      function runOp(trashOp, id) {
        if (!api) return
        setBusy(trashOp + ':' + (id || 'all'))
        api.dispatch({ action: 'trash', trash_op: trashOp, id: id }).then(function () {
          setBusy('')
          reload()
          if (props.onChanged) props.onChanged()
        }).catch(function (problem) {
          setBusy('')
          setTrash(function (previous) { return Object.assign({}, previous, { error: problem }) })
        })
      }

      if (!props.open) return null
      return h('div', { className: 'bf-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '回收站' },
        h('div', { className: 'bf-modal-card' },
          h('div', { className: 'bf-modal-head' },
            h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'trash', size: 13 }), '回收站'),
            h('span', { className: 'bf-panel-sub' }, '删除的 run 先移到这里；恢复会重建索引，彻底删除不可撤销'),
            h('div', { className: 'bf-spacer' }),
            trash.items.length ? h('button', {
              type: 'button', className: 'bf-btn bf-btn-sm bf-btn-danger', disabled: Boolean(busy),
              onClick: function () { runOp('empty') },
            }, busy === 'empty:all' ? '清空中…' : '清空回收站') : null,
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: props.onClose }, h(Icon, { name: 'close', size: 11 }), '关闭')),
          h('div', { className: 'bf-modal-body' },
            trash.error ? h('div', { className: 'bf-inline-error' }, '回收站读取失败：' + asText(trash.error.message || trash.error, '未知错误')) : null,
            trash.loading ? h(Skeleton, { lines: 3 }) : null,
            !trash.loading && !trash.items.length ? h('div', { className: 'bf-muted', style: { padding: '10px 2px' } }, '回收站是空的。') : null,
            trash.items.map(function (item) {
              var key = asText(item.run_id, '')
              return h('div', { key: key, className: 'bf-clinical-hit' },
                h('div', { className: 'bf-clinical-hit-title' },
                  h('span', { className: 'bf-mono' }, key),
                  h('span', { className: 'bf-muted' }, ' · ' + asText(item.status, '?') + ' · ' + asText(item.template, '模板未知'))),
                h('div', { className: 'bf-clinical-hit-meta bf-muted' },
                  h('span', null, '删除时间 ' + asText(formatClock(item.deleted_at), '未知')),
                  h('span', null, '大小 ' + Math.max(1, Math.round((Number(item.bytes) || 0) / 1024)) + ' KB'),
                  item.zero_significant === true ? h('span', { className: 'bf-tone-warn' }, '零显著') : null),
                h('div', { className: 'bf-joint-actions' },
                  h('button', {
                    type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', disabled: Boolean(busy),
                    onClick: function () { runOp('restore', key) },
                  }, h(Icon, { name: 'refresh', size: 11 }), busy === 'restore:' + key ? '恢复中…' : '恢复'),
                  h('button', {
                    type: 'button', className: 'bf-btn bf-btn-sm bf-btn-danger', disabled: Boolean(busy),
                    onClick: function () { runOp('purge', key) },
                  }, busy === 'purge:' + key ? '删除中…' : '彻底删除')))
            }))))
    }

    // ----------------------------------------------------------------------
    // 数据向导：候选 → 每个数据集一页（分组提案，只检查）→ 总结页 → 执行
    // ----------------------------------------------------------------------
    var GROUP_CASE_WORDS = /(tumou?r|case|disease|cancer|carcinoma|metasta|malignant|treated|resistant|progress)/i
    var GROUP_CONTROL_WORDS = /(normal|control|healthy|adjacent|para|non.?tumou?r|untreated|sensitive|benign|baseline)/i

    function proposeContrast(groups) {
      var list = (groups || []).filter(Boolean)
      if (list.length < 2) return null
      var score = function (name) { return GROUP_CONTROL_WORDS.test(name) ? -1 : GROUP_CASE_WORDS.test(name) ? 1 : 0 }
      var sorted = list.slice().sort(function (a, b) {
        var diff = score(b) - score(a)
        return diff !== 0 ? diff : String(a).localeCompare(String(b))
      })
      return { case: sorted[0], control: sorted[1], direction: 'case_minus_control' }
    }

    function templateForKind(kind) {
      return kind === 'scrna' ? 'scrna-composition' : kind === 'spatial' ? 'spatial-domain' : kind === 'metabolomics' ? 'metabolomics-de' : 'bulk-two-group'
    }

    function DataWizard(props) {
      var api = props.api
      var stepState = useState(1)
      var step = stepState[0]
      var setStep = stepState[1]
      var needState = useState(asText(props.seedText, ''))
      var need = needState[0]
      var setNeed = needState[1]
      var adviseState = useState({ loading: false, error: null, data: null })
      var advise = adviseState[0]
      var setAdvise = adviseState[1]
      var selectionState = useState({})       // key -> {checked, role}
      var selection = selectionState[0]
      var setSelection = selectionState[1]
      var registeredState = useState({ loading: true, list: [], error: null })
      var registered = registeredState[0]
      var setRegistered = registeredState[1]
      var acquiredState = useState({})        // key -> {stage, datasetId, error}
      var acquired = acquiredState[0]
      var setAcquired = acquiredState[1]
      var configState = useState({})          // datasetId -> {role, caseGroup, controlGroup, include}
      var config = configState[0]
      var setConfig = configState[1]
      var currentState = useState('')
      var current = currentState[0]
      var setCurrent = currentState[1]
      var mergeState = useState('joint')
      var mergeMode = mergeState[0]
      var setMergeMode = mergeState[1]
      var methodState = useState('quantile')
      var method = methodState[0]
      var setMethod = methodState[1]
      var busyState = useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var statusState = useState('')
      var status = statusState[0]
      var setStatus = statusState[1]
      var errorState = useState(null)
      var error = errorState[0]
      var setError = errorState[1]

      React.useEffect(function () {
        if (!api) return
        api.dispatch({ action: 'datasets', limit: 100 }).then(function (data) {
          setRegistered({ loading: false, error: null, list: asArray(data && data.datasets) })
        }).catch(function (problem) { setRegistered({ loading: false, error: problem, list: [] }) })
      }, [])

      function runAdvise() {
        if (!api || !need.trim()) return
        setAdvise({ loading: true, error: null, data: null })
        api.dispatch({ action: 'advise', need: need.trim(), sources: ['geo', 'pubmed', 'gdc'], limit: 8 })
          .then(function (data) { setAdvise({ loading: false, error: null, data: data }) })
          .catch(function (problem) { setAdvise({ loading: false, error: problem, data: null }) })
      }
      function toggle(key, checked) {
        setSelection(function (previous) {
          var next = Object.assign({}, previous)
          next[key] = { checked: checked, role: (previous[key] && previous[key].role) || 'single' }
          return next
        })
      }
      function setRole(key, role) {
        setSelection(function (previous) { return Object.assign({}, previous, { [key]: Object.assign({}, previous[key], { role: role, checked: true }) }) })
      }
      function chosenKeys() {
        return Object.keys(selection).filter(function (key) { return selection[key] && selection[key].checked })
      }
      function acquireByKey(key, source, id) {
        setAcquired(function (previous) { return Object.assign({}, previous, { [key]: { stage: 'downloading' } }) })
        setStatus('正在下载 ' + id + ' …')
        api.dispatch({ action: 'download', source: source, id: id }).then(function (download) {
          var artifacts = asArray(download && download.artifact_ids)
          if (!artifacts.length && download && download.artifacts) artifacts = asArray(download.artifacts).map(function (item) { return item.artifact_id || item.id })
          if (!artifacts.length) throw { message: '下载没有返回 artifact_id' }
          setAcquired(function (previous) { return Object.assign({}, previous, { [key]: { stage: 'registering' } }) })
          setStatus('下载完成，正在登记并自动探测方向/尺度…')
          return api.dispatch({ action: 'register', artifact_ids: artifacts, name: id, assay: 'auto' })
        }).then(function (result) {
          var dataset = result && result.dataset
          if (!dataset) throw { message: (result && result.summary) || '登记失败' }
          setAcquired(function (previous) { return Object.assign({}, previous, { [key]: { stage: 'done', datasetId: dataset.dataset_id } }) })
          setStatus('已登记 ' + dataset.dataset_id)
          setSelection(function (previous) { return Object.assign({}, previous, { [key]: Object.assign({}, previous[key], { checked: true }) }) })
          api.dispatch({ action: 'datasets', limit: 100 }).then(function (data) {
            setRegistered({ loading: false, error: null, list: asArray(data && data.datasets) })
          }).catch(function () { /* ignore */ })
        }).catch(function (problem) {
          setAcquired(function (previous) { return Object.assign({}, previous, { [key]: { stage: 'error', error: asText(problem && (problem.message || problem.error), '失败') } }) })
          setStatus('失败：' + asText(problem && (problem.message || problem.error), '未知错误'))
        })
      }

      // 汇总：已登记（可选执行）的数据集 + 建议配置
      var chosen = chosenKeys().map(function (key) {
        var candidate = null
        var items = advise.data ? asArray(advise.data.recommendations) : []
        for (var index = 0; index < items.length; index += 1) {
          if (items[index].source + ':' + items[index].dataset_id === key) { candidate = items[index]; break }
        }
        if (!candidate && key.indexOf('ds:') === 0) {
          var id = key.slice(3)
          var row = (registered.list || []).find(function (item) { return item.dataset_id === id })
          candidate = row ? { dataset_id: id, source: 'registered', title: row.name, n_samples: row.n_samples, kind: row.data_kind, groups: row.groups || [], score: null, reasons: ['已登记的数据集'], risks: [] } : null
        }
        var acquiredInfo = acquired[key] || {}
        var datasetId = acquiredInfo.datasetId || (key.indexOf('ds:') === 0 ? key.slice(3) : null)
        var cfg = (datasetId && config[datasetId]) || {}
        return {
          key: key, candidate: candidate, datasetId: datasetId,
          role: (selection[key] && selection[key].role) || 'single',
          caseGroup: cfg.caseGroup || null, controlGroup: cfg.controlGroup || null,
          include: cfg.include !== false,
        }
      }).filter(Boolean)
      var usable = chosen.filter(function (item) { return item.datasetId && item.include })
      var selectedDatasets = usable.map(function (item) { return item.datasetId })

      function openDataset(datasetId) {
        setCurrent(datasetId)
        if (config[datasetId]) return
        api.dispatch({ action: 'datasets', dataset_id: datasetId }).then(function (data) {
          var dataset = data && data.dataset
          if (!dataset) return
          var groups = [...new Set((asArray(dataset.design && dataset.design.samples)).map(function (sample) { return String(sample.group || '') }).filter(Boolean))]
          var proposal = proposeContrast(groups)
          setConfig(function (previous) {
            var next = Object.assign({}, previous)
            next[datasetId] = {
              role: (previous[datasetId] && previous[datasetId].role) || 'primary',
              include: true,
              groups,
              caseGroup: (previous[datasetId] && previous[datasetId].caseGroup) || (proposal ? proposal.case : ''),
              controlGroup: (previous[datasetId] && previous[datasetId].controlGroup) || (proposal ? proposal.control : ''),
              dataset,
            }
            return next
          })
        }).catch(function (problem) { setError(problem) })
      }
      function patchConfig(datasetId, patch) {
        setConfig(function (previous) { return Object.assign({}, previous, { [datasetId]: Object.assign({}, previous[datasetId], patch) }) })
      }

      function execute() {
        setError(null)
        if (!usable.length) { setError({ message: '还没有「已登记」的数据集：先在候选页点「下载并登记」，或直接选已登记数据集' }); return }
        var first = usable[0]
        var primaryCase = first.caseGroup || 'tumor'
        var primaryControl = first.controlGroup || 'normal'
        setBusy('execute')
        if (mergeMode === 'joint' && usable.length >= 2) {
          setStatus('正在合并 ' + usable.length + ' 个数据集（harmonize ' + method + '）…')
          api.dispatch({ action: 'harmonize', dataset_ids: usable.map(function (item) { return item.datasetId }), method: method, target_scale: 'log_expression' })
            .then(function (result) {
              setBusy('')
              if (!result || !result.merged_dataset_id) throw { message: (result && (result.merged_error || result.summary)) || '没有登记合并数据集' }
              setStatus('合并完成：' + result.merged_dataset_id + '，已生成计划许愿')
              var text = '用合并数据集 ' + result.merged_dataset_id + ' 按 ' + primaryCase + ' vs ' + primaryControl + ' 做分析，先出 draft 计划'
              if (props.onCompose) props.onCompose(text)
              if (props.onBack) props.onBack()
            }).catch(function (problem) {
              setBusy('')
              setError(problem)
              setStatus('合并失败：' + asText(problem && (problem.message || problem.error), '未知错误'))
            })
          return
        }
        setBusy('')
        var text = usable.length === 1
          ? '用数据集 ' + first.datasetId + ' 按 ' + primaryCase + ' vs ' + primaryControl + ' 做分析（模板 ' + templateForKind(first.candidate && first.candidate.kind) + '），先出 draft 计划'
          : '分别用数据集 ' + usable.map(function (item) { return item.datasetId }).join('、') + ' 各跑一次差异分析（按 ' + primaryCase + ' vs ' + primaryControl + '），做完用 joint meta 合并结果'
        if (props.onCompose) props.onCompose(text)
        if (props.onBack) props.onBack()
      }

      var stepTitles = ['① 选数据', '② 逐个检查', '③ 总结并执行']
      var currentConfig = current && config[current] ? config[current] : null
      return h('div', { className: 'bf-wizard' },
        h('div', { className: 'bf-wizard-head' },
          h('div', null,
            h('div', { className: 'bf-panel-title' }, h(Icon, { name: 'flow', size: 13 }), '数据向导'),
            h('div', { className: 'bf-panel-sub' }, 'AI 给候选 → 每个数据集一页（分组/对照先给提案，你检查）→ 总结页确认后执行')),
          h('div', { className: 'bf-spacer' }),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: props.onBack }, h(Icon, { name: 'chevron', size: 11 }), '返回许愿')),
        h('div', { className: 'bf-wizard-steps' }, stepTitles.map(function (title, index) {
          var active = step === index + 1
          return h('button', {
            key: title, type: 'button', className: 'bf-tab' + (active ? ' bf-tab-on' : ''),
            onClick: function () { setStep(index + 1) },
          }, title)
        })),
        status ? h('div', { className: 'bf-logic-status' }, status) : null,
        error ? h('div', { className: 'bf-inline-error' }, asText(error.message || error.error || error, '请求失败')) : null,

        step === 1 ? h('div', { className: 'bf-wizard-body' },
          h('div', { className: 'bf-joint-actions' },
            h('input', {
              className: 'bf-input bf-input-sm', style: { flex: '1 1 320px' }, value: need,
              placeholder: '说一句你要解决的问题，AI 会去找候选数据集',
              onChange: function (event) { setNeed(event.target.value) },
              onKeyDown: function (event) { if (isImeComposing(event)) return; if (event.key === 'Enter') runAdvise() },
            }),
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', disabled: advise.loading, onClick: runAdvise },
              h(Icon, { name: 'search', size: 11 }), advise.loading ? '正在挑…' : '让 AI 找候选')),
          advise.error ? h('div', { className: 'bf-inline-error' }, '检索失败：' + asText(advise.error.message || advise.error, '未知错误')) : null,
          h('div', { className: 'bf-joint-section' },
            h('div', { className: 'bf-joint-title' }, '候选数据集（勾选后选「单独」或「联合」）'),
            advise.loading ? h(Skeleton, { lines: 4 }) : null,
            h('div', { className: 'bf-joint-list' }, asArray(advise.data && advise.data.recommendations).map(function (item) {
              var key = item.source + ':' + item.dataset_id
              var chosenRow = selection[key] || {}
              var info = acquired[key] || {}
              return h('div', { key: key, className: 'bf-clinical-hit' + (chosenRow.checked ? ' bf-wizard-picked' : '') },
                h('label', { className: 'bf-joint-row' },
                  h('input', { type: 'checkbox', checked: Boolean(chosenRow.checked), onChange: function (event) { toggle(key, event.target.checked) } }),
                  h('span', { className: 'bf-mono' }, asText(item.dataset_id, '')),
                  h('span', { className: 'bf-truncate' }, asText(item.title, '')),
                  h('span', { className: 'bf-badge bf-badge-run' }, '得分 ' + asText(item.score, 0))),
                h('div', { className: 'bf-clinical-hit-meta bf-muted' },
                  h('span', null, asText(item.source, '') + ' · ' + asText(item.kind, '') + ' · n=' + asText(item.n_samples, '?')),
                  asArray(item.reasons).slice(0, 3).map(function (reason, i) { return h('span', { key: 'r' + i }, '✓ ' + asText(reason, '')) }),
                  asArray(item.risks).slice(0, 2).map(function (risk, i) { return h('span', { key: 'k' + i, className: 'bf-tone-warn' }, '⚠ ' + asText(risk, '')) })),
                h('div', { className: 'bf-joint-actions' },
                  h('label', { className: 'bf-joint-field' }, '用法',
                    h('select', { className: 'bf-select bf-input-sm', value: chosenRow.role || 'single', onChange: function (event) { setRole(key, event.target.value) } },
                      h('option', { value: 'single' }, '单独跑'),
                      h('option', { value: 'joint' }, '参与联合'))),
                  info.stage === 'done'
                    ? h('span', { className: 'bf-mono bf-tone-ok' }, info.datasetId)
                    : h('button', { type: 'button', className: 'bf-btn bf-btn-sm', disabled: info.stage === 'downloading' || info.stage === 'registering', onClick: function () { acquireByKey(key, item.source, item.dataset_id) } },
                      h(Icon, { name: 'download', size: 11 }), info.stage === 'downloading' ? '下载中…' : info.stage === 'registering' ? '登记中…' : '下载并登记'),
                  info.error ? h('span', { className: 'bf-tone-err' }, info.error) : null))
            }))),
          h('div', { className: 'bf-joint-section' },
            h('div', { className: 'bf-joint-title' }, '或者直接选已登记的数据集'),
            registered.loading ? h(Skeleton, { lines: 2 }) : h('div', { className: 'bf-joint-list' }, asArray(registered.list).map(function (row) {
              var key = 'ds:' + row.dataset_id
              var chosenRow = selection[key] || {}
              return h('label', { key: key, className: 'bf-joint-row' + (chosenRow.checked ? ' bf-joint-row-on' : '') },
                h('input', { type: 'checkbox', checked: Boolean(chosenRow.checked), onChange: function (event) { toggle(key, event.target.checked) } }),
                h('span', { className: 'bf-mono' }, shortId(row.dataset_id, 18)),
                h('span', { className: 'bf-truncate' }, asText(row.name, '')),
                h('span', { className: 'bf-muted' }, asText(row.data_kind, '') + ' · n=' + asText(row.n_samples, '?')))
            }))) ,
          h('div', { className: 'bf-joint-actions' },
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', disabled: !chosenKeys().length, onClick: function () { setStep(2) } },
              '下一步：逐个检查（' + chosenKeys().length + '）')))

        : step === 2 ? h('div', { className: 'bf-wizard-body' },
          h('div', { className: 'bf-wizard-split' },
            h('div', { className: 'bf-wizard-side' }, chosen.filter(function (item) { return item.datasetId }).map(function (item) {
              return h('button', {
                key: item.key, type: 'button',
                className: 'bf-runitem' + (current === item.datasetId ? ' bf-runitem-on' : ''),
                onClick: function () { openDataset(item.datasetId) },
              },
                h('div', { className: 'bf-runitem-main' },
                  h('span', { className: 'bf-mono' }, shortId(item.datasetId, 16)),
                  h('span', { className: 'bf-truncate' }, asText(item.candidate && item.candidate.title, ''))),
                h('div', { className: 'bf-runitem-sub' },
                  h('span', null, 'n=' + asText(item.candidate && item.candidate.n_samples, '?')),
                  h('span', null, asText(item.role, 'single'))))
            })),
            h('div', { className: 'bf-wizard-main' },
              !current ? h(EmptyState, { icon: 'list', title: '选一个数据集检查', sub: '左边是已勾选且已登记的数据集；点开后会先给分组/对照提案，你只需要检查确认。' })
                : !currentConfig ? h(Skeleton, { lines: 5 })
                  : h('div', { className: 'bf-joint-section' },
                    h('div', { className: 'bf-joint-title' }, asText(currentConfig.dataset && currentConfig.dataset.name, current)),
                    h('div', { className: 'bf-clinical-hit-meta bf-muted' },
                      h('span', null, 'n=' + asText(asArray(currentConfig.dataset && currentConfig.dataset.design && currentConfig.dataset.design.samples).length, '?')),
                      h('span', null, 'scale=' + asText(currentConfig.dataset && currentConfig.dataset.scale && currentConfig.dataset.scale.type, '?')),
                      h('span', null, 'transpose=' + asText(currentConfig.dataset && currentConfig.dataset.transpose, '?'))),
                    h('div', { className: 'bf-joint-title' }, '系统提案（请检查）'),
                    h('div', { className: 'bf-logic-preview' },
                      h('div', null, '分组：' + asArray(currentConfig.groups).join('、')),
                      h('div', null, '建议对照：' + asText(currentConfig.caseGroup, '?') + ' vs ' + asText(currentConfig.controlGroup, '?')),
                      h('div', null, '建议模板：' + templateForKind(currentConfig.dataset && currentConfig.dataset.data_kind))),
                    h('div', { className: 'bf-tpl-grid' },
                      h('label', { className: 'bf-tpl-field' }, '实验组',
                        h('select', { className: 'bf-select bf-input-sm', value: currentConfig.caseGroup, onChange: function (event) { patchConfig(current, { caseGroup: event.target.value }) } },
                          asArray(currentConfig.groups).map(function (group) { return h('option', { key: group, value: group }, group) }))),
                      h('label', { className: 'bf-tpl-field' }, '对照组',
                        h('select', { className: 'bf-select bf-input-sm', value: currentConfig.controlGroup, onChange: function (event) { patchConfig(current, { controlGroup: event.target.value }) } },
                          asArray(currentConfig.groups).map(function (group) { return h('option', { key: group, value: group }, group) }))),
                      h('label', { className: 'bf-tpl-field' }, '角色',
                        h('select', { className: 'bf-select bf-input-sm', value: currentConfig.role, onChange: function (event) { patchConfig(current, { role: event.target.value }) } },
                          h('option', { value: 'primary' }, '基准'),
                          h('option', { value: 'supplementary' }, '补充队列'))),
                      h('label', { className: 'bf-tpl-field' }, '是否纳入',
                        h('select', { className: 'bf-select bf-input-sm', value: currentConfig.include ? 'yes' : 'no', onChange: function (event) { patchConfig(current, { include: event.target.value === 'yes' }) } },
                          h('option', { value: 'yes' }, '纳入'),
                          h('option', { value: 'no' }, '排除')))),
                    h('div', { className: 'bf-joint-title' }, '样本（前 12 行）'),
                    h('div', { className: 'bf-clinical-hit-meta bf-muted' }, asArray(currentConfig.dataset && currentConfig.dataset.design && currentConfig.dataset.design.samples).slice(0, 12).map(function (sample, index) {
                      return h('span', { key: index }, asText(sample.sample_id, '') + '/' + asText(sample.group, '-'))
                    }))))),
          h('div', { className: 'bf-joint-actions' },
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: function () { setStep(1) } }, '上一步'),
            h('div', { className: 'bf-spacer' }),
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', disabled: !usable.length, onClick: function () { setStep(3) } }, '下一步：总结（' + usable.length + '）')))

        : h('div', { className: 'bf-wizard-body' },
          h('div', { className: 'bf-joint-section' },
            h('div', { className: 'bf-joint-title' }, '已选数据集与提案'),
            h('div', { className: 'bf-joint-list' }, usable.map(function (item) {
              var cfg = config[item.datasetId] || {}
              return h('div', { key: item.key, className: 'bf-clinical-hit' },
                h('div', { className: 'bf-clinical-hit-title' },
                  h('span', { className: 'bf-mono' }, item.datasetId),
                  h('span', { className: 'bf-muted' }, ' · n=' + asText(item.candidate && item.candidate.n_samples, '?') + ' · 分组 ' + asArray(cfg.groups).join('/') + ' · ' + asText(cfg.caseGroup, '?') + ' vs ' + asText(cfg.controlGroup, '?'))))
            }))),
          usable.length >= 2 ? h('div', { className: 'bf-joint-section' },
            h('div', { className: 'bf-joint-title' }, '这些数据集怎么用？'),
            h('div', { className: 'bf-joint-actions' },
              h('label', { className: 'bf-joint-field' }, h('input', { type: 'radio', checked: mergeMode === 'joint', onChange: function () { setMergeMode('joint') } }), '联合（先 harmonize 合并，再在合并数据集上跑）'),
              h('label', { className: 'bf-joint-field' }, h('input', { type: 'radio', checked: mergeMode === 'separate', onChange: function () { setMergeMode('separate') } }), '单独（各自跑，后续 meta 合并）'),
              mergeMode === 'joint' ? h('label', { className: 'bf-joint-field' }, '批次方法',
                h('select', { className: 'bf-select bf-input-sm', value: method, onChange: function (event) { setMethod(event.target.value) } },
                  ['quantile', 'combat', 'scale_only', 'none'].map(function (item) { return h('option', { key: item, value: item }, item) }))) : null)) : null,
          h('div', { className: 'bf-joint-section' },
            h('div', { className: 'bf-joint-title' }, '执行前检查'),
            h('div', { className: 'bf-logic-preview' },
              h('div', null, '模板：' + templateForKind(usable[0] && usable[0].candidate && usable[0].candidate.kind)),
              h('div', null, '对照：' + asText(usable[0] && (config[usable[0].datasetId] || {}).caseGroup, '?') + ' vs ' + asText(usable[0] && (config[usable[0].datasetId] || {}).controlGroup, '?')),
              h('div', null, '预计产物：manifest / design / qc / results/*.tsv / figures / evidence / methods'),
              h('div', null, '闸门：每组独立 n≥2；尺度需 verified；分组不能与批次完全共线'))),
          h('div', { className: 'bf-joint-actions' },
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: function () { setStep(2) } }, '上一步'),
            h('div', { className: 'bf-spacer' }),
            h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', disabled: Boolean(busy), onClick: execute },
              h(Icon, { name: 'send', size: 11 }), busy ? '处理中…' : mergeMode === 'joint' && usable.length >= 2 ? '合并并生成计划' : '生成计划'))))
    }

    // ----------------------------------------------------------------------
    // 联合分析：多数据集归一化 → 跨队列 meta / 出图
    // ----------------------------------------------------------------------
    function JointPanel(props) {
      var api = props.api
      var datasetsState = useState({ loading: true, error: null, list: [] })
      var datasets = datasetsState[0]
      var setDatasets = datasetsState[1]
      var runsState = useState({ loading: true, error: null, list: [] })
      var runs = runsState[0]
      var setRuns = runsState[1]
      var pickedState = useState({})
      var picked = pickedState[0]
      var setPicked = pickedState[1]
      var methodState = useState('quantile')
      var method = methodState[0]
      var setMethod = methodState[1]
      var modeState = useState('meta')
      var mode = modeState[0]
      var setMode = modeState[1]
      var busyState = useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var resultState = useState(null)
      var result = resultState[0]
      var setResult = resultState[1]
      var errorState = useState(null)
      var error = errorState[0]
      var setError = errorState[1]

      function toggle(kind, id) {
        setPicked(function (previous) {
          var key = kind + ':' + id
          var next = Object.assign({}, previous)
          if (next[key]) delete next[key]; else next[key] = true
          return next
        })
      }
      function pickedIds(kind) {
        return Object.keys(picked).filter(function (key) { return key.indexOf(kind + ':') === 0 }).map(function (key) { return key.slice(kind.length + 1) })
      }
      React.useEffect(function () {
        if (!api) return
        api.dispatch({ action: 'datasets', limit: 100 }).then(function (data) {
          setDatasets({ loading: false, error: null, list: asArray(data && data.datasets) })
        }).catch(function (problem) {
          setDatasets({ loading: false, error: problem, list: [] })
        })
        api.dispatch({ action: 'runs', limit: 50 }).then(function (data) {
          setRuns({ loading: false, error: null, list: asArray(data && data.runs) })
        }).catch(function (problem) {
          setRuns({ loading: false, error: problem, list: [] })
        })
      }, [])
      function runHarmonize() {
        var ids = pickedIds('ds')
        if (ids.length < 2) { setError({ message: '至少选 2 个数据集才能归一化' }); return }
        setBusy('harmonize')
        setError(null)
        api.dispatch({ action: 'harmonize', dataset_ids: ids, method: method }).then(function (data) {
          setBusy('')
          setResult({ kind: 'harmonize', data: data })
          if (props.onRefreshRuns) props.onRefreshRuns()
        }).catch(function (problem) { setBusy(''); setError(problem) })
      }
      function runJoint() {
        var runIds = pickedIds('run')
        if (runIds.length < 2) { setError({ message: '至少选 2 个 run 才能联合分析' }); return }
        setBusy('joint')
        setError(null)
        var body = mode === 'plot'
          ? { action: 'joint', mode: 'plot', runs: runIds.map(function (id) { return { run_id: id } }), chart: 'box' }
          : { action: 'joint', mode: 'meta', cohorts: runIds.map(function (id) { return { run_id: id } }) }
        api.dispatch(body).then(function (data) {
          setBusy('')
          setResult({ kind: 'joint', data: data })
          if (props.onRefreshRuns) props.onRefreshRuns()
        }).catch(function (problem) { setBusy(''); setError(problem) })
      }
      var datasetRows = datasets.list
      var runRows = runs.list.filter(function (run) { return ['succeeded', 'partial'].includes(String(run.status)) })
      var datasetSection = h('div', { className: 'bf-joint-section' },
        h('div', { className: 'bf-joint-title' }, '① 选择要归一化的数据集（≥2）'),
        datasets.loading
          ? h(Skeleton, { lines: 2 })
          : h('div', { className: 'bf-joint-list' },
            datasetRows.length
              ? datasetRows.map(function (dataset) {
                var id = asText(dataset.dataset_id || dataset.id, '')
                var checked = Boolean(picked['ds:' + id])
                return h('label', { key: id, className: 'bf-joint-row' + (checked ? ' bf-joint-row-on' : '') },
                  h('input', { type: 'checkbox', checked: checked, onChange: function () { toggle('ds', id) } }),
                  h('span', { className: 'bf-mono bf-truncate' }, shortId(id, 18)),
                  h('span', { className: 'bf-truncate' }, asText(dataset.name, '')),
                  h('span', { className: 'bf-muted' }, asText(dataset.data_kind, '') + ' · ' + asText(dataset.scale && dataset.scale.type, '') + ' · n=' + asText(dataset.n_samples, '?')))
              })
              : h('div', { className: 'bf-muted' }, '还没有登记数据集：先在「数据源检索」下载并登记，或用 register 导入本地数据。')),
        h('div', { className: 'bf-joint-actions' },
          h('label', { className: 'bf-joint-field' }, '批次方法',
            h('select', { className: 'bf-select bf-input-sm', value: method, onChange: function (event) { setMethod(event.target.value) } },
              ['quantile', 'combat', 'scale_only', 'none'].map(function (item) { return h('option', { key: item, value: item }, item) }))),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', disabled: busy === 'harmonize', onClick: runHarmonize },
            h(Icon, { name: 'flow', size: 11 }), busy === 'harmonize' ? '归一化中…' : '归一化所选数据集')))

      var runSection = h('div', { className: 'bf-joint-section' },
        h('div', { className: 'bf-joint-title' }, '② 选择要联合的 run（≥2）'),
        runs.loading
          ? h(Skeleton, { lines: 2 })
          : h('div', { className: 'bf-joint-list' },
            runRows.length
              ? runRows.map(function (run) {
                var id = asText(run.run_id, '')
                var checked = Boolean(picked['run:' + id])
                return h('label', { key: id, className: 'bf-joint-row' + (checked ? ' bf-joint-row-on' : '') },
                  h('input', { type: 'checkbox', checked: checked, onChange: function () { toggle('run', id) } }),
                  h('span', { className: 'bf-mono bf-truncate' }, shortId(id, 20)),
                  h('span', { className: 'bf-truncate' }, asText(run.template, '')),
                  h('span', { className: 'bf-muted' }, asText(run.status, '') + ' · ' + formatClock(run.created_at || run.createdAt)))
              })
              : h('div', { className: 'bf-muted' }, '还没有成功的 run：先跑完至少两个队列。')),
        h('div', { className: 'bf-joint-actions' },
          h('label', { className: 'bf-joint-field' }, '模式',
            h('select', { className: 'bf-select bf-input-sm', value: mode, onChange: function (event) { setMode(event.target.value) } },
              [['meta', 'meta 合并（fixed/random）'], ['plot', '统一出图（plotlab）']].map(function (pair) {
                return h('option', { key: pair[0], value: pair[0] }, pair[1])
              }))),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary', disabled: busy === 'joint', onClick: runJoint },
            h(Icon, { name: 'flow', size: 11 }), busy === 'joint' ? '合并中…' : '运行联合分析')))

      var mergedId = result && result.data ? asText(result.data.merged_dataset_id, '') : ''
      var resultBlock = result
        ? h('div', { className: 'bf-joint-result' },
          h('b', null, result.kind === 'harmonize' ? '归一化已提交：' : '联合分析已提交：'),
          h('span', { className: 'bf-mono' }, asText(result.data && result.data.run_id, '?')),
          h('span', { className: 'bf-muted' }, ' · ' + asText(result.data && result.data.status, '')),
          mergedId ? h('span', { className: 'bf-tone-ok' }, ' · 合并数据集 ' + mergedId) : null,
          (result.data && result.data.cross_dataset_inference_allowed === false)
            ? h('span', { className: 'bf-tone-warn' }, ' · 未校正，禁止合并推断')
            : null,
          mergedId
            ? h('button', {
              type: 'button', className: 'bf-btn bf-btn-sm bf-btn-primary',
              title: '用合并后的数据集继续跑差异/组成分析',
              onClick: function () {
                if (props.onCompose) props.onCompose('用合并数据集 ' + mergedId + ' 按 tumor vs normal 做差异表达并做通路富集，出图')
                if (props.onBackToWish) props.onBackToWish()
              },
            }, h(Icon, { name: 'send', size: 11 }), '用合并数据集继续跑')
            : null)
        : null

      return h('div', { className: 'bf-joint' },
        h('div', { className: 'bf-panel-head' },
          h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'flow', size: 12 }), '联合分析'),
          h('span', { className: 'bf-panel-sub' }, '多队列：先归一化，再 meta 合并或统一出图（跨数据集推断必须先校正）')),
        h('div', { className: 'bf-joint-body' },
          datasets.error ? h('div', { className: 'bf-inline-error' }, '数据集加载失败：' + asText(datasets.error.message, '')) : null,
          datasetSection,
          runSection,
          error ? h('div', { className: 'bf-inline-error' }, asText(error.message, '请求失败')) : null,
          resultBlock))
    }

    function WorkbenchBody() {
      var apiRef = useRef(null)
      if (!apiRef.current) apiRef.current = createApi()

      var catalogState = useState(null)
      var catalog = catalogState[0]
      var setCatalog = catalogState[1]
      var statusState = useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]
      var healthState = useState({ sources: {}, loading: true, error: null })
      var health = healthState[0]
      var setHealth = healthState[1]
      var bootState = useState({ loading: true, error: null })
      var boot = bootState[0]
      var setBoot = bootState[1]
      var overviewState = useState(null)
      var overviewError = overviewState[0]
      var setOverviewError = overviewState[1]
      var runsState = useState({ list: [], loading: false, error: null })
      var runs = runsState[0]
      var setRunsState = runsState[1]
      var selectedRunState = useState('')
      var selectedRunId = selectedRunState[0]
      var setSelectedRunId = selectedRunState[1]
      var runViewState = useState({ runId: '', loading: false, error: null, data: null })
      var runInfo = runViewState[0]
      var setRunInfo = runViewState[1]
      var manifestState = useState({ runId: '', loading: false, error: null, data: null })
      var manifest = manifestState[0]
      var setManifestState = manifestState[1]
      var evidenceState = useState({ runId: '', loading: false, error: null, data: null })
      var evidence = evidenceState[0]
      var setEvidenceState = evidenceState[1]
      var evidenceFilterState = useState('all')
      var evidenceFilter = evidenceFilterState[0]
      var setEvidenceFilter = evidenceFilterState[1]
      var messagesState = useState([{
        id: 'm-welcome', role: 'system', at: new Date().toISOString(),
        text: 'Bioflow 指挥台：先说人话许愿 → 得到 draft·待确认计划（字段可改，缺的琥珀色高亮）→ 确认并提交 → 看流水线与产物证据。首屏只拉 catalog / status / health 三个请求。',
      }])
      var messages = messagesState[0]
      var setMessages = messagesState[1]
      var askTextState = useState('')
      var askText = askTextState[0]
      var setAskText = askTextState[1]
      var askingState = useState(false)
      var asking = askingState[0]
      var setAsking = askingState[1]
      var draftState = useState(null)
      var draft = draftState[0]
      var setDraft = draftState[1]
      var editsState = useState({})
      var edits = editsState[0]
      var setEdits = editsState[1]
      var syncingState = useState(false)
      var syncing = syncingState[0]
      var setSyncing = syncingState[1]
      var askErrorState = useState(null)
      var askError = askErrorState[0]
      var setAskError = askErrorState[1]
      var submitState = useState({ running: false, error: null, blocked: [], runId: '', reused: false })
      var submit = submitState[0]
      var setSubmit = submitState[1]
      var sourceTabState = useState('geo')
      var sourceTab = sourceTabState[0]
      var setSourceTab = sourceTabState[1]
      var queryState = useState({ geo: '', pubmed: '', gdc: '', metabolights: '', cellxgene: '' })
      var sourceQueries = queryState[0]
      var setSourceQueries = queryState[1]
      var searchState = useState({})
      var searchCache = searchState[0]
      var setSearchCache = searchState[1]
      var selectionState = useState({})
      var selection = selectionState[0]
      var setSelection = selectionState[1]
      var probeState = useState({ source: '', loading: false, error: null })
      var probe = probeState[0]
      var setProbe = probeState[1]
      var downloadsState = useState([])
      var downloads = downloadsState[0]
      var setDownloads = downloadsState[1]
      var downloadingState = useState(false)
      var downloading = downloadingState[0]
      var setDownloading = downloadingState[1]
      var drawerState = useState(null)
      var drawer = drawerState[0]
      var setDrawer = drawerState[1]
      var toastState = useState('')
      var toast = toastState[0]
      var setToast = toastState[1]

      var pageState = useState(function () {
        try {
          if (typeof window !== 'undefined' && window.location) {
            var hash = String(window.location.hash || '')
            if (hash.indexOf('/clinical') >= 0 || hash.indexOf('/question') >= 0) return 'clinical'
            if (hash.indexOf('/guided') >= 0) return 'guided'
            if (hash.indexOf('/wizard') >= 0) return 'wizard'
            if (hash.indexOf('/logic') >= 0) return 'logic'
          }
        } catch (error) { /* ignore */ }
        return 'workbench'
      })
      var page = pageState[0]
      var setPage = pageState[1]
      function gotoPage(next) {
        setPage(next)
        try {
          if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
            window.history.replaceState(null, '', next === 'logic' ? '#/logic' : next === 'guided' ? '#/guided' : next === 'clinical' ? '#/question' : next === 'wizard' ? '#/wizard' : '#/')
          }
        } catch (error) { /* ignore */ }
      }

      var trashOpenState = useState(false)
      var trashOpen = trashOpenState[0]
      var setTrashOpen = trashOpenState[1]
      var nextWishState = useState({ runId: '', loading: false, directions: [], zero: false })
      var nextWish = nextWishState[0]
      var setNextWish = nextWishState[1]
      var pickerState = useState({ open: false, options: [], auto: false })
      var picker = pickerState[0]
      var setPicker = pickerState[1]
      var settingsState = useState({ output_dir: null, draft: null, saving: false })
      var settings = settingsState[0]
      var setSettings = settingsState[1]
      var exportingState = useState(false)
      var exporting = exportingState[0]
      var setExporting = exportingState[1]

      var lastQueryRef = useRef('')
      var editsRef = useLatest(edits)
      var draftRef = useLatest(draft)
      var submitRef = useLatest(submit)
      var askSeqRef = useRef(0)
      var resyncTimerRef = useRef(null)
      var toastTimerRef = useRef(null)
      var downloadAbortRef = useRef({})
      var drawerSeqRef = useRef(0)
      var timelineRef = useRef(null)
      var lastRunStatusRef = useRef({ runId: '', status: '' })

      function notify(message) {
        var text = String(message === null || message === undefined ? '' : message)
        if (!text) return
        setToast(text)
        if (toastTimerRef.current) {
          try { clearTimeout(toastTimerRef.current) } catch (error) { /* ignore */ }
        }
        toastTimerRef.current = setTimeout(function () { setToast('') }, 2400)
      }

      function handleCopy(value) {
        var text = String(value === null || value === undefined ? '' : value)
        if (!text) return
        copyText(text).then(function (ok) {
          notify(ok ? '已复制：' + shortId(text, 44) : '复制失败（浏览器限制）')
        })
      }

      function pushMessage(message) {
        var item = Object.assign({
          id: 'm' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
          at: new Date().toISOString(),
          role: 'agent',
        }, message || {})
        setMessages(function (previous) { return previous.concat([item]) })
      }

      var api = apiRef.current

      function refreshStatus(options) {
        var silent = Boolean(options && options.silent)
        return api.status().then(function (result) {
          setStatus(normalizeStatus(result))
          setOverviewError(null)
          return result
        }).catch(function (error) {
          setOverviewError(error)
          return null
        })
      }

      React.useEffect(function () {
        var run = selectedRunView
        var runId = run && run.runId ? run.runId : ''
        if (!runId || !api) return
        if (!['succeeded', 'partial'].includes(String(run.status || ''))) return
        if (nextWish.runId === runId || nextWish.loading) return
        setNextWish(function (previous) { return Object.assign({}, previous, { runId: runId, loading: true }) })
        api.dispatch({ action: 'suggest_next', run_id: runId }).then(function (data) {
          setNextWish({ runId: runId, loading: false, directions: asArray(data && data.directions), zero: Boolean(data && data.zero_significant) })
        }).catch(function () {
          setNextWish({ runId: runId, loading: false, directions: [], zero: false })
        })
      }, [selectedRunView && selectedRunView.runId, selectedRunView && selectedRunView.status])

      React.useEffect(function () {
        api.dispatch({ action: 'settings' }).then(function (data) {
          var output = data && data.settings ? data.settings.output_dir : null
          setSettings(function (previous) { return Object.assign({}, previous, { output_dir: output, draft: output }) })
        }).catch(function () { /* 设置读取失败不阻塞页面 */ })
      }, [])

      function pickDataset(datasetId) {
        setPicker(function (previous) { return Object.assign({}, previous, { open: false }) })
        var nextEdits = Object.assign({}, editsRef.current || {}, { dataset: datasetId })
        setEdits(nextEdits)
        if (lastQueryRef.current) runAsk(lastQueryRef.current, nextEdits, { silent: true })
      }

      function saveOutputDir() {
        setSettings(function (previous) { return Object.assign({}, previous, { saving: true }) })
        api.dispatch({ action: 'settings', output_dir: settings.draft === null ? '' : settings.draft }).then(function (data) {
          var output = data && data.settings ? data.settings.output_dir : null
          setSettings({ output_dir: output, draft: output, saving: false })
          setToast(output ? '输出目录已设为 ' + output : '已清除输出目录（默认导出到 run 旁）')
        }).catch(function (problem) {
          setSettings(function (previous) { return Object.assign({}, previous, { saving: false }) })
          setToast('保存失败：' + asText(problem && problem.message, '未知错误'))
        })
      }

      function exportRun() {
        if (!selectedRunId || exporting) return
        setExporting(true)
        api.dispatch({ action: 'export', run_id: selectedRunId, out_path: settings.output_dir || undefined }).then(function (data) {
          setExporting(false)
          var path = data && data.out_path ? data.out_path : ''
          setToast(path ? '结果包已导出到 ' + path : '导出完成（未设置输出目录，未复制结果包）')
        }).catch(function (problem) {
          setExporting(false)
          setToast('导出失败：' + asText(problem && problem.message, '未知错误'))
        })
      }

      function deleteRun(runId) {
        if (!runId) return
        var confirmed = true
        try { if (typeof window !== 'undefined' && window.confirm) confirmed = window.confirm('删除 run ' + shortId(runId, 20) + '？目录会移入 trash/runs（可手动恢复），记录会被移除。') } catch (error) { /* ignore */ }
        if (!confirmed) return
        api.dispatch({ action: 'delete', target: 'run', id: runId }).then(function (data) {
          setToast(asText(data && data.summary, '已删除'))
          if (selectedRunId === runId) setSelectedRunId('')
          loadRuns()
        }).catch(function (problem) {
          setToast('删除失败：' + asText(problem && problem.message, '未知错误'))
        })
      }

      function loadRuns() {
        setRunsState(function (previous) { return Object.assign({}, previous, { loading: true, error: null }) })
        return api.dispatch({ action: 'runs', limit: 20 }).then(function (result) {
          var normalized = normalizeRuns(result)
          setRunsState({ list: normalized.runs, loading: false, error: null })
          setSelectedRunId(function (previous) {
            if (previous) return previous
            var active = normalized.runs.filter(function (run) { return isActiveStatus(run.status) })[0]
            if (active) return active.runId
            return normalized.runs.length ? normalized.runs[0].runId : ''
          })
          return normalized
        }).catch(function (error) {
          setRunsState(function (previous) { return Object.assign({}, previous, { loading: false, error: error }) })
          return null
        })
      }

      function loadRunStatus(runId) {
        var id = String(runId === null || runId === undefined ? '' : runId)
        if (!id) return Promise.resolve(null)
        setRunInfo(function (previous) {
          var sameRun = previous && previous.runId === id
          return {
            runId: id,
            loading: !sameRun || !previous.data,
            error: null,
            data: sameRun ? previous.data : null,
          }
        })
        return api.dispatch(buildRunStatusBody(id)).then(function (result) {
          var normalized = normalizeRunStatus(result)
          setRunInfo({ runId: id, loading: false, error: null, data: normalized })
          return normalized
        }).catch(function (error) {
          setRunInfo(function (previous) {
            return Object.assign({}, previous, { runId: id, loading: false, error: error })
          })
          return null
        })
      }

      function ensureManifest(runId, force) {
        var id = String(runId === null || runId === undefined ? '' : runId)
        if (!id) return Promise.resolve(null)
        var current = manifest
        if (!force && current && current.runId === id && (current.data || current.error)) return Promise.resolve(current.data)
        setManifestState({ runId: id, loading: true, error: null, data: null })
        return api.fileText('runs/' + id + '/manifest.json').then(function (text) {
          var parsed = null
          try { parsed = JSON.parse(text) } catch (error) { parsed = null }
          var data = parsed && typeof parsed === 'object' ? parsed : { raw: String(text === null || text === undefined ? '' : text) }
          setManifestState({ runId: id, loading: false, error: null, data: data })
          return data
        }).catch(function (error) {
          setManifestState({ runId: id, loading: false, error: error, data: null })
          return null
        })
      }

      function ensureEvidence(runId, force) {
        var id = String(runId === null || runId === undefined ? '' : runId)
        if (!id) return Promise.resolve(null)
        var current = evidence
        if (!force && current && current.runId === id && (current.data || current.error)) return Promise.resolve(current.data)
        setEvidenceState({ runId: id, loading: true, error: null, data: null })
        return api.dispatch({ action: 'evidence', run_id: id, limit: 300 }).then(function (result) {
          var normalized = normalizeEvidence(result)
          setEvidenceState({ runId: id, loading: false, error: null, data: normalized })
          return normalized
        }).catch(function (error) {
          setEvidenceState({ runId: id, loading: false, error: error, data: null })
          return null
        })
      }

      function probeSource(source) {
        var id = String(source || '')
        if (!id) return
        setProbe({ source: id, loading: true, error: null })
        api.health([id]).then(function (result) {
          var normalized = normalizeHealth(result)
          setHealth(function (previous) {
            var sources = Object.assign({}, previous.sources || {}, normalized.sources)
            return { sources: sources, loading: false, error: null, summary: normalized.summary, checkedAt: normalized.checkedAt }
          })
          setProbe({ source: id, loading: false, error: null })
        }).catch(function (error) {
          setProbe({ source: id, loading: false, error: error })
          setHealth(function (previous) {
            var sources = Object.assign({}, previous.sources || {})
            sources[id] = { source: id, status: 'down', latencyMs: null, reason: describeError(error).message, expected: '' }
            return { sources: sources, loading: false, error: null, checkedAt: Date.now() }
          })
        })
      }

      function refreshAll() {
        setOverviewError(null)
        api.health(['geo', 'pubmed', 'gdc', 'metabolights']).then(function (result) {
          var normalized = normalizeHealth(result)
          setHealth(function (previous) {
            var sources = Object.assign({}, previous.sources || {}, normalized.sources)
            return { sources: sources, loading: false, error: null, summary: normalized.summary, checkedAt: normalized.checkedAt }
          })
        }).catch(function (error) {
          setHealth(function (previous) { return Object.assign({}, previous, { loading: false, error: error }) })
        })
        refreshStatus({}).then(function () { loadRuns(); notify('已刷新状态与健康灯') })
      }

      // ---- 首屏：只发 catalog + status + health 三个请求 ----
      useEffect(function () {
        var cancelled = false
        var errors = []
        var collected = { catalog: null, status: null, health: null }
        Promise.all([
          api.catalog().then(function (result) { collected.catalog = normalizeCatalog(result) }).catch(function (error) { errors.push({ label: 'catalog', error: error }) }),
          api.status().then(function (result) { collected.status = normalizeStatus(result) }).catch(function (error) { errors.push({ label: 'status', error: error }) }),
          api.health(['geo', 'pubmed', 'gdc', 'metabolights']).then(function (result) { collected.health = normalizeHealth(result) }).catch(function (error) { errors.push({ label: 'health', error: error }) }),
        ]).then(function () {
          if (cancelled) return
          setCatalog(collected.catalog || normalizeCatalog({ templates: TEMPLATE_FALLBACK }))
          if (collected.status) setStatus(collected.status)
          if (collected.health) {
            setHealth({ sources: collected.health.sources, loading: false, error: null, summary: collected.health.summary, checkedAt: collected.health.checkedAt })
          } else {
            setHealth({ sources: {}, loading: false, error: errors.filter(function (item) { return item.label === 'health' })[0] ? errors.filter(function (item) { return item.label === 'health' })[0].error : null })
          }
          setBoot({
            loading: false,
            error: errors.length
              ? { code: 'boot_partial', message: errors.map(function (item) { return item.label + '：' + describeError(item.error).message }).join('；'), details: errors.map(function (item) { return { label: item.label, error: item.error } }) }
              : null,
          })
        })
        return function () {
          cancelled = true
          if (toastTimerRef.current) { try { clearTimeout(toastTimerRef.current) } catch (error) { /* ignore */ } }
          if (resyncTimerRef.current) { try { clearTimeout(resyncTimerRef.current) } catch (error) { /* ignore */ } }
        }
      }, [])

      // 首屏之后：历史 run + CELLxGENE 空闲探活（不算首屏请求）
      useEffect(function () {
        if (boot.loading) return undefined
        loadRuns()
        var timer = setTimeout(function () {
          if (typeof document !== 'undefined' && document.hidden) return
          probeSource('cellxgene')
        }, 3000)
        return function () { clearTimeout(timer) }
      }, [boot.loading])

      // 选中 run 后立刻取状态；切 run 时清空 cache
      useEffect(function () {
        if (!selectedRunId) return
        lastRunStatusRef.current = { runId: selectedRunId, status: '' }
        loadRunStatus(selectedRunId)
      }, [selectedRunId])

      // 轮询：当前 run（2s，终态自动停）+ status（8s）+ runs 列表（15s）；全部隐藏时暂停
      usePoll(function () {
        if (selectedRunId) loadRunStatus(selectedRunId)
      }, 2000, Boolean(selectedRunId) && (!runInfo.data || isActiveStatus(runInfo.data.status)))
      usePoll(function () { refreshStatus({ silent: true }) }, 8000, !boot.loading)
      usePoll(function () { loadRuns() }, 15000, !boot.loading)

      // run 到终态时：刷新历史、拉 evidence、提示一次
      useEffect(function () {
        var data = runInfo.data
        if (!data) return
        var previous = lastRunStatusRef.current
        if (previous.runId === data.runId && previous.status === data.status) return
        lastRunStatusRef.current = { runId: data.runId, status: data.status }
        if (!isTerminalStatus(data.status)) return
        notify('run ' + shortId(data.runId, 22) + ' → ' + runStatusLabel(data.status))
        loadRuns()
        if (data.status === 'succeeded' || data.status === 'partial') ensureEvidence(data.runId, false)
      }, [runInfo.data])

      // ---- 许愿 / draft ----
      function runAsk(textValue, editValue, options) {
        var text = String(textValue === null || textValue === undefined ? '' : textValue).trim()
        if (!text) return
        var opts = options || {}
        var seq = askSeqRef.current + 1
        askSeqRef.current = seq
        if (opts.silent) setSyncing(true)
        else {
          setAsking(true)
          setAskError(null)
        }
        setSubmit({ running: false, error: null, blocked: [], runId: '', reused: false })
        var body = buildAskBody({
          text: text,
          edit: editValue,
          feedback: opts.feedback,
          endpoint: editValue ? editValue.endpoint : '',
        })
        api.dispatch(body).then(function (result) {
          if (askSeqRef.current !== seq) return
          var normalized = normalizeAsk(result)
          setDraft(normalized)
          var options = asArray(result && result.dataset_options)
          var autoSelected = Boolean(result && result.dataset_match && result.dataset_match.auto_selected)
          setPicker({ open: Boolean(autoSelected && options.length), options: options, auto: autoSelected })
          setAsking(false)
          setSyncing(false)
          setAskError(null)
          if (!opts.silent) {
            setMessages(function (previous) {
              return previous.concat([
                { id: 'm' + Date.now() + '-u', at: new Date().toISOString(), role: 'user', text: text },
                {
                  id: 'm' + Date.now() + '-a', at: new Date().toISOString(), role: 'agent',
                  text: normalized.summary || '已生成 draft 计划（待确认）',
                  badges: [{ label: 'draft · 待确认', tone: 'warn' }, normalized.template ? { label: normalized.template, tone: 'muted' } : null].filter(Boolean),
                },
              ])
            })
            setAskText('')
            setEdits({})
            lastQueryRef.current = text
          }
        }).catch(function (error) {
          if (askSeqRef.current !== seq) return
          setAsking(false)
          setSyncing(false)
          setAskError(error)
        })
      }

      function scheduleResync() {
        if (!lastQueryRef.current) return
        // 立刻置为「重算中」：confirm_token 只在 ask 返回后更新，避免旧 token 被提交
        setSyncing(true)
        if (resyncTimerRef.current) {
          try { clearTimeout(resyncTimerRef.current) } catch (error) { /* ignore */ }
        }
        resyncTimerRef.current = setTimeout(function () {
          if (!lastQueryRef.current) return
          if (submitRef.current && submitRef.current.runId) return
          runAsk(lastQueryRef.current, editsRef.current, { silent: true })
        }, 700)
      }

      function handleEdit(field, value) {
        setEdits(function (previous) {
          var next = Object.assign({}, previous)
          if (value === undefined) delete next[field]
          else next[field] = value
          return next
        })
        if (TOKEN_FIELDS.indexOf(field) >= 0) scheduleResync()
      }

      function handleSend() {
        var text = askText.trim()
        if (!text || asking) return
        runAsk(text, {}, {})
      }

      function handleRegenerate(feedback, hasEdits) {
        var base = lastQueryRef.current
        if (!base) return
        var note = hasEdits ? '（请保留我改过的字段）' : ''
        runAsk(base, hasEdits ? editsRef.current : {}, { feedback: String(feedback || '') + note })
      }

      function extractBlockedGates(error) {
        var details = error && error.details ? error.details : {}
        var body = details.body && typeof details.body === 'object' ? details.body : {}
        var inner = body.details && typeof body.details === 'object'
          ? body.details
          : (details.details && typeof details.details === 'object' ? details.details : {})
        var gates = inner.gates || body.gates || inner.blocking || body.blocking || inner.rows || []
        return normalizeGates(gates)
      }

      function handleSubmit() {
        var current = draftRef.current
        if (!current || !current.planId || !current.confirmToken) return
        setSubmit({ running: true, error: null, blocked: [], runId: '', reused: false })
        api.dispatch(buildSubmitBody(current)).then(function (result) {
          var runId = asText(result && result.run_id, '')
          setSubmit({ running: false, error: null, blocked: [], runId: runId, reused: Boolean(result && result.reused) })
          if (runId) {
            setSelectedRunId(runId)
            loadRuns()
            pushMessage({
              role: 'agent',
              text: asText(result && result.summary, '已提交 run ' + runId) + (result && result.reused ? '（同参数幂等复用）' : ''),
              badges: [{ label: 'run_id', tone: 'run' }, { label: runId, tone: 'muted' }],
            })
            notify('已提交：' + shortId(runId, 24))
            setTimeout(function () {
              if (timelineRef.current && timelineRef.current.scrollIntoView) {
                try { timelineRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch (error) { /* ignore */ }
              }
            }, 60)
          }
        }).catch(function (error) {
          setSubmit({ running: false, error: error, blocked: extractBlockedGates(error), runId: '', reused: false })
        })
      }

      function handleCancelRun() {
        var runId = runInfo.data ? runInfo.data.runId : selectedRunId
        if (!runId) return
        api.dispatch({ action: 'cancel', run_id: runId, reason: '用户在 UI 取消' }).then(function (result) {
          notify(asText(result && result.summary, '已请求取消'))
          loadRunStatus(runId)
          loadRuns()
        }).catch(function (error) {
          notify('取消失败：' + describeError(error).message)
        })
      }

      // ---- 检索 / 下载 ----
      function handleQuery(source, value) {
        setSourceQueries(function (previous) {
          var next = Object.assign({}, previous)
          next[source] = value
          return next
        })
      }

      function handleSearch(source) {
        var term = String(sourceQueries[source] || '').trim()
        if (!term) {
          notify('先输入检索词')
          return
        }
        setSearchCache(function (previous) {
          var next = Object.assign({}, previous)
          var old = next[source] || {}
          next[source] = { query: term, loading: true, error: null, data: old.data || null }
          return next
        })
        api.dispatch(buildSearchBody({ term: term, source: source })).then(function (result) {
          var normalized = normalizeSearch(result, source)
          setSearchCache(function (previous) {
            var next = Object.assign({}, previous)
            next[source] = { query: term, loading: false, error: null, data: normalized }
            return next
          })
          var failed = normalized.sourcesFailed.filter(function (item) { return item.source === source })[0]
          if (failed) {
            setHealth(function (previous) {
              var sources = Object.assign({}, previous.sources || {})
              if (!sources[source] || sources[source].status === 'unknown') {
                sources[source] = { source: source, status: 'down', latencyMs: null, reason: failed.reason || failed.code, expected: '' }
              }
              return Object.assign({}, previous, { sources: sources })
            })
          }
        }).catch(function (error) {
          setSearchCache(function (previous) {
            var next = Object.assign({}, previous)
            next[source] = { query: term, loading: false, error: error, data: null }
            return next
          })
        })
      }

      function handleToggleResult(item) {
        if (!item || !item.id) return
        var key = item.source + '|' + item.id
        setSelection(function (previous) {
          var next = Object.assign({}, previous)
          if (next[key]) delete next[key]
          else next[key] = { source: item.source, id: item.id, title: item.title }
          return next
        })
      }

      function downloadOne(item) {
        var key = item.source + '|' + item.id
        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null
        if (controller) downloadAbortRef.current[key] = controller
        var placeholder = {
          key: key, name: '下载中…', sourceId: item.source, recordId: item.id,
          source: item.source + '/' + item.id, bytes: null, sha8: '—', sha256: '',
          reused: false, path: '', status: 'running', progress: 0, error: '',
        }
        setDownloads(function (previous) { return mergeDownloadRow(previous, placeholder) })
        return api.dispatch(buildDownloadBody({ source: item.source, id: item.id }), controller ? { signal: controller.signal } : undefined).then(function (result) {
          delete downloadAbortRef.current[key]
          var rows = downloadRows(result, item)
          var failed = result && result.ok === false
          setDownloads(function (previous) {
            var next = asArray(previous).filter(function (row) { return row.key !== key })
            if (rows.length) {
              rows.forEach(function (row) { next = mergeDownloadRow(next, row) })
            } else {
              next = mergeDownloadRow(next, Object.assign({}, placeholder, {
                name: item.id,
                status: failed ? 'error' : 'done',
                progress: failed ? 0 : 1,
                error: failed ? asText(result && (result.summary || result.error), '下载不可用') : '',
              }))
            }
            return next
          })
        }).catch(function (error) {
          delete downloadAbortRef.current[key]
          var info = describeError(error)
          setDownloads(function (previous) {
            return mergeDownloadRow(previous, Object.assign({}, placeholder, {
              status: info.code === 'aborted' ? 'cancelled' : 'error',
              progress: 0,
              error: info.code === 'aborted' ? '已取消（客户端停止等待）' : info.message,
            }))
          })
        })
      }

      function handleDownloadSelected() {
        var items = Object.keys(selection).map(function (key) { return selection[key] })
        if (!items.length) return
        setSelection({})
        setDownloading(true)
        var chain = Promise.resolve()
        items.forEach(function (item) {
          chain = chain.then(function () { return downloadOne(item) })
        })
        chain.then(function () {
          setDownloading(false)
          notify('下载队列完成：' + items.length + ' 条记录')
          refreshStatus({ silent: true })
        })
      }

      function cancelDownload(row) {
        if (!row || !row.key) return
        var controller = downloadAbortRef.current[row.key]
        if (controller && controller.abort) {
          try { controller.abort() } catch (error) { /* ignore */ }
        }
        setDownloads(function (previous) {
          return mergeDownloadRow(previous, Object.assign({}, row, { status: 'cancelled', progress: 0, error: '已取消（服务端可能仍在写，队列不再等待）' }))
        })
      }

      function clearDoneDownloads() {
        setDownloads(function (previous) {
          return asArray(previous).filter(function (row) { return row.status === 'running' })
        })
      }

      function removeDownload(row) {
        if (!row || !row.key) return
        setDownloads(function (previous) {
          return asArray(previous).filter(function (item) { return item.key !== row.key })
        })
      }

      // ---- 产物 / 证据 / 抽屉 ----
      function openTextDrawer(title, relative, mode) {
        var seq = drawerSeqRef.current + 1
        drawerSeqRef.current = seq
        setDrawer({
          kind: 'text', title: title, relative: relative, mode: mode || 'text',
          loading: true, content: '', error: null,
          onRetry: function () { openTextDrawer(title, relative, mode) },
        })
        api.fileText(relative).then(function (text) {
          if (drawerSeqRef.current !== seq) return
          setDrawer(function (previous) {
            return previous ? Object.assign({}, previous, { loading: false, content: text, error: null }) : previous
          })
        }).catch(function (error) {
          if (drawerSeqRef.current !== seq) return
          setDrawer(function (previous) {
            return previous ? Object.assign({}, previous, { loading: false, error: error }) : previous
          })
        })
      }

      function openTableDrawer(table) {
        var item = table || {}
        var relative = runRelativePath(item.file, status ? status.dataRoot : '')
        if (!relative) {
          notify('找不到表文件路径（' + asText(item.tableId, 'table') + '）')
          return
        }
        openTextDrawer(asText(item.title, asText(item.tableId, 'results 表')), relative, 'table')
      }

      function openEvidenceTable(record) {
        var runId = selectedRunId
        var tables = runInfo.data ? runInfo.data.tables : []
        var table = tables.filter(function (item) { return item.tableId === record.tableId })[0]
        if (!table) {
          notify('找不到表 ' + asText(record.tableId, '') + '（可能该 run 没有索引）')
          return
        }
        openTableDrawer(table)
      }

      function openFigureDrawer(figure) {
        setDrawer({
          kind: 'figure', title: asText(figure && (figure.figureId || figure.title), 'figure'),
          figure: figure, runId: selectedRunId, runStatus: runInfo.data, loading: false, error: null,
        })
      }

      function openManifestDrawer() {
        var runId = selectedRunId
        if (!runId) return
        setDrawer({
          kind: 'manifest', title: 'manifest.json · ' + shortId(runId, 18),
          relative: 'runs/' + runId + '/manifest.json',
          manifest: manifest && manifest.runId === runId ? manifest.data : null,
          loading: !(manifest && manifest.runId === runId && manifest.data),
          error: manifest && manifest.runId === runId ? manifest.error : null,
          onRetry: function () { ensureManifest(runId, true) },
        })
        ensureManifest(runId, false)
      }

      function openMethodsDrawer() {
        var runId = selectedRunId
        if (!runId) return
        setDrawer({ kind: 'methods', title: 'methods.md · ' + shortId(runId, 18), relative: 'runs/' + runId + '/methods.md', loading: true, content: '', error: null, onRetry: openMethodsDrawer })
        api.dispatch({ action: 'methods', run_id: runId }).then(function (result) {
          setDrawer(function (previous) {
            if (!previous || previous.kind !== 'methods') return previous
            return Object.assign({}, previous, { loading: false, content: asText(result && result.content, ''), error: null })
          })
        }).catch(function (error) {
          setDrawer(function (previous) {
            if (!previous || previous.kind !== 'methods') return previous
            return Object.assign({}, previous, { loading: false, error: error })
          })
        })
      }

      function openEvidenceDrawer() {
        var runId = selectedRunId
        if (!runId) return
        setDrawer({
          kind: 'evidence', title: 'evidence.jsonl · ' + shortId(runId, 18),
          relative: 'runs/' + runId + '/evidence.jsonl',
          evidence: evidence && evidence.runId === runId ? evidence.data : null,
          loading: !(evidence && evidence.runId === runId && evidence.data),
          error: evidence && evidence.runId === runId ? evidence.error : null,
          onOpenTable: openEvidenceTable,
        })
        ensureEvidence(runId, false)
      }

      function openArtifactsDrawer() {
        setDrawer({
          kind: 'artifacts',
          title: '产物与证据 · ' + (selectedRunId ? shortId(selectedRunId, 20) : '无 run'),
          artifactsProps: {
            runId: selectedRunId, runStatus: runInfo.data, dataRoot: status ? status.dataRoot : '',
            manifest: manifest && manifest.runId === selectedRunId ? manifest.data : null,
            evidence: evidence && evidence.runId === selectedRunId ? evidence.data : null,
            evidenceLoading: evidence ? evidence.loading : false,
            evidenceError: evidence && evidence.runId === selectedRunId ? evidence.error : null,
            evidenceFilter: evidenceFilter,
            focusDeliverables: plannedDeliverables,
            onOpenManifest: openManifestDrawer,
            onOpenText: openTextDrawer,
            onOpenTable: openTableDrawer,
            onShowFigures: function () { },
            onOpenEvidence: openEvidenceDrawer,
            onOpenMethods: openMethodsDrawer,
            onOpenFigure: openFigureDrawer,
            onEvidenceFilter: setEvidenceFilter,
            onNeedEvidence: function () { ensureEvidence(selectedRunId, false) },
            onCopy: handleCopy,
          },
        })
      }

      function closeDrawer() {
        drawerSeqRef.current += 1
        setDrawer(null)
      }

      useEscapeKey(Boolean(drawer), closeDrawer)

      // 抽屉里的 manifest / evidence 快照跟随异步加载更新（值相等时不 setState，避免死循环）
      useEffect(function () {
        if (!drawer) return
        if (drawer.kind === 'manifest' && manifest && manifest.runId === selectedRunId) {
          setDrawer(function (previous) {
            if (!previous || previous.kind !== 'manifest') return previous
            if (previous.manifest === manifest.data && previous.loading === manifest.loading && previous.error === manifest.error) return previous
            return Object.assign({}, previous, { manifest: manifest.data, loading: manifest.loading, error: manifest.error })
          })
        }
        if (drawer.kind === 'evidence' && evidence && evidence.runId === selectedRunId) {
          setDrawer(function (previous) {
            if (!previous || previous.kind !== 'evidence') return previous
            if (previous.evidence === evidence.data && previous.error === evidence.error) return previous
            return Object.assign({}, previous, { evidence: evidence.data, loading: false, error: evidence.error })
          })
        }
      }, [manifest, evidence, drawer, selectedRunId])

      // ---- 渲染 ----
      var dataRoot = status ? status.dataRoot : (catalog ? catalog.dataRoot : '')
      var templates = catalog ? catalog.templates : TEMPLATE_FALLBACK
      var activeRun = runInfo.data && isActiveStatus(runInfo.data.status)
        ? runInfo.data
        : (runInfo.data || runs.list.filter(function (run) { return isActiveStatus(run.status) })[0] || null)
      var activeRunForBar = activeRun && activeRun.runId
        ? { runId: activeRun.runId, status: activeRun.status, progress: activeRun.progress }
        : null
      var selectedRunView = runInfo.data && runInfo.data.runId === selectedRunId ? runInfo.data : null
      var currentManifest = manifest && manifest.runId === selectedRunId ? manifest.data : null
      var currentEvidence = evidence && evidence.runId === selectedRunId ? evidence.data : null
      var plannedDeliverables = asArray(
        edits && Object.prototype.hasOwnProperty.call(edits, 'deliverables')
          ? edits.deliverables
          : (draft && draft.fields ? draft.fields.deliverables : [])
      ).map(function (item) { return String(item) })
      var evidenceLoading = Boolean(evidence && evidence.runId === selectedRunId && evidence.loading)
      var evidenceError = evidence && evidence.runId === selectedRunId ? evidence.error : null

      return h('div', { className: 'bf-root' },
        h('style', null, CSS_TEXT),
        h(TopBar, {
          status: status, catalog: catalog, health: health, activeRun: activeRunForBar,
          onCopy: handleCopy, onRefresh: refreshAll, onCancelRun: handleCancelRun,
          onOpenTrash: function () { setTrashOpen(true) },
          onFocusRun: function () {
            if (timelineRef.current && timelineRef.current.scrollIntoView) {
              try { timelineRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch (error) { /* ignore */ }
            }
          },
          onOpenSource: function (source) {
            setSourceTab(source)
            if (!health.sources || !health.sources[source]) probeSource(source)
          },
        }),
        boot.error || overviewError || health.error
          ? h('div', { style: { padding: '10px 12px 0' } },
            h(ErrorBar, {
              error: boot.error || overviewError || health.error,
              title: boot.error ? '首屏部分请求失败（仍可用）' : '状态 / 健康灯刷新失败',
              onRetry: function () { setBoot(function (previous) { return Object.assign({}, previous, { error: null }) }); refreshAll() },
            }))
          : null,

        h('div', { className: 'bf-top-group', style: { marginRight: 'auto' } },
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: function () { gotoPage('workbench') }, 'aria-pressed': page === 'workbench' ? 'true' : 'false' }, h(Icon, { name: 'chat', size: 11 }), '许愿'),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: function () { gotoPage('guided') }, 'aria-pressed': page === 'guided' ? 'true' : 'false' }, h(Icon, { name: 'flow', size: 11 }), '疾病引导'),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: function () { gotoPage('clinical') }, 'aria-pressed': page === 'clinical' ? 'true' : 'false' }, h(Icon, { name: 'search', size: 11 }), '问题入手'),
          h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: function () { gotoPage('wizard') }, 'aria-pressed': page === 'wizard' ? 'true' : 'false' }, h(Icon, { name: 'download', size: 11 }), '数据向导')),
        page === 'logic'
          ? h(LogicPage, {
            dataRoot: dataRoot,
            onBack: function () { gotoPage('workbench') },
            onCompose: function (text) { setAskText(text); gotoPage('workbench') },
            onCopy: handleCopy,
          })
          : page === 'guided'
            ? h(GuidedPage, {
              api: api,
              onBack: function () { gotoPage('workbench') },
              onQuestion: function (disease) { setAskText(''); gotoPage('clinical') },
              onCompose: function (text) { setAskText(text); gotoPage('workbench') },
            })
            : page === 'clinical'
              ? h(ClinicalPage, {
                api: api,
                dataRoot: dataRoot,
                onBack: function () { gotoPage('workbench') },
                onCompose: function (text) { setAskText(text); gotoPage('workbench') },
                onLogic: function () { gotoPage('logic') },
              })
              : page === 'wizard'
                ? h(DataWizard, {
                  api: api,
                  seedText: askText,
                  onBack: function () { gotoPage('workbench') },
                  onCompose: function (text) { setAskText(text); gotoPage('workbench') },
                })
                : h('div', { className: 'bf-body' },
          h(ChatColumn, {
            api: api,
            messages: messages, text: askText, onTextChange: setAskText, onSend: handleSend, asking: asking,
            onCompose: function (composed) { setAskText(composed) },
            onNavigate: gotoPage,
            draftLabel: draft ? (draft.missing.length ? draft.missing.length + ' 个字段待补' : 'draft 就绪') : '先出 draft，不会自动跑',
            runs: runs.list, runsLoading: runs.loading, runsError: runs.error,
            selectedRunId: selectedRunId,
            onSelectRun: function (runId) { setSelectedRunId(runId) },
            onRefreshRuns: loadRuns,
            onDeleteRun: deleteRun,
            onOpenTrash: function () { setTrashOpen(true) },
            onClear: function () {
              setMessages([{
                id: 'm-reset', role: 'system', at: new Date().toISOString(),
                text: '对话已清空（不影响已提交的 run）；可以重新许愿。',
              }])
              setDraft(null)
              setEdits({})
              setAskError(null)
              lastQueryRef.current = ''
            },
          }),

          h('div', { className: 'bf-work' },
            h(ProgressStrip, {
              runStatus: selectedRunView,
              plan: draft ? draft.plan : null,
              evidenceCounts: currentEvidence && currentEvidence.counts ? currentEvidence.counts : null,
              blockedCount: submit.blocked ? asArray(submit.blocked).length : 0,
              outputDir: settings.draft,
              saving: settings.saving,
              exporting: exporting,
              onOutputDirChange: function (value) { setSettings(function (previous) { return Object.assign({}, previous, { draft: value }) }) },
              onSaveOutputDir: saveOutputDir,
              onExport: exportRun,
            }),
            picker.options.length
              ? h('div', { className: 'bf-joint-actions', style: { flex: 'none' } },
                h('button', { type: 'button', className: 'bf-btn bf-btn-sm', onClick: function () { setPicker(function (previous) { return Object.assign({}, previous, { open: true }) }) } },
                  h(Icon, { name: 'list', size: 11 }), '候选数据集（' + picker.options.length + '，中文摘要）'),
                h('span', { className: 'bf-composer-hint' }, picker.auto ? '话里没点名数据集，系统已先替你选；点开可换' : '可随时换数据集'))
              : null,
            h(PlanCard, {
              draft: draft, edits: edits, asking: asking, syncing: syncing,
              templates: templates, statusSuggestion: status ? status.suggest : '',
              submit: submit, submitError: submit.error, submitBlocked: submit.blocked,
              submittedRunId: submit.runId, submitReused: submit.reused,
              onEdit: handleEdit, onSubmit: handleSubmit, onRetrySubmit: handleSubmit,
              onRegenerate: handleRegenerate, onCopy: handleCopy,
              onFocusTimeline: function () {
                if (timelineRef.current && timelineRef.current.scrollIntoView) {
                  try { timelineRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch (error) { /* ignore */ }
                }
              },
            }),
            askError ? h(ErrorBar, { error: askError, title: 'ask / draft 解析失败', onRetry: function () { runAsk(lastQueryRef.current || askText, editsRef.current, {}) } }) : null,
            draft || selectedRunView ? h(PipelineStrip, { runStatus: selectedRunView, plan: draft ? draft.plan : null }) : null,
            selectedRunId ? h(Timeline, {
              panelRef: timelineRef,
              runStatus: selectedRunView,
              loading: Boolean(runInfo.loading && (!runInfo.data || runInfo.runId === selectedRunId)),
              error: runInfo.error,
              manifest: currentManifest,
              onRefresh: function () { if (selectedRunId) loadRunStatus(selectedRunId) },
              onCancel: handleCancelRun,
              onCopy: handleCopy,
              onExpand: function () { if (selectedRunId) ensureManifest(selectedRunId, false) },
            }) : null,
            nextWish.directions.length ? h('div', { className: 'bf-next' },
              h('div', { className: 'bf-next-head' },
                h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'flow', size: 12 }), '顺着这次结果，继续许愿'),
                nextWish.zero ? h('span', { className: 'bf-muted' }, '当前阈值下无显著项；完整结果仍可导出') : null),
              h('div', { className: 'bf-chips' }, nextWish.directions.map(function (item) {
                return h('button', {
                  key: item.id, type: 'button', className: 'bf-chip',
                  onClick: function () { setAskText(asText(item.need, '')) },
                }, asText(item.label, ''))
              }))) : null,
            h(WorkspaceTabs, {
              api: api,
              onRefreshRuns: loadRuns,
              onCompose: function (text) { setAskText(text) },
              onBackToWish: function () { gotoPage('workbench') },
              artifacts: {
                runId: selectedRunId, runStatus: selectedRunView, dataRoot: dataRoot,
                manifest: currentManifest, evidence: currentEvidence,
                evidenceLoading: evidenceLoading, evidenceError: evidenceError,
                evidenceFilter: evidenceFilter, onEvidenceFilter: setEvidenceFilter,
                focusDeliverables: plannedDeliverables,
                onNeedEvidence: function () { if (selectedRunId) ensureEvidence(selectedRunId, false) },
                onNeedManifest: function () { if (selectedRunId) ensureManifest(selectedRunId, false) },
                onOpenManifest: openManifestDrawer,
                onOpenText: openTextDrawer,
                onOpenTable: openTableDrawer,
                onOpenFigure: openFigureDrawer,
                onOpenEvidence: openEvidenceDrawer,
                onOpenMethods: openMethodsDrawer,
                onOpenArtifacts: openArtifactsDrawer,
                onCopy: handleCopy,
              },
              sources: {
                tab: sourceTab, onTab: setSourceTab,
                health: health, probe: probe,
                queries: sourceQueries, onQuery: handleQuery, onSearch: handleSearch, onProbe: probeSource,
                cache: searchCache, selection: selection,
                onToggle: handleToggleResult, onClearSelection: function () { setSelection({}) },
                onAddToDownload: handleDownloadSelected, downloading: downloading,
              },
              downloads: {
                rows: downloads, onCancel: cancelDownload, onClearDone: clearDoneDownloads,
                onRemove: removeDownload, onCopy: handleCopy,
              },
            }))),

        h(TrashModal, {
          open: trashOpen, api: api,
          onClose: function () { setTrashOpen(false) },
          onChanged: function () { loadRuns() },
        }),
        h(DatasetPickerModal, {
          open: picker.open,
          options: picker.options,
          currentId: draft && draft.fields ? draft.fields.dataset : null,
          onPick: pickDataset,
          onClose: function () { setPicker(function (previous) { return Object.assign({}, previous, { open: false }) }) },
        }),
        h(Drawer, {
          drawer: drawer, onClose: closeDrawer, onCopy: handleCopy, dataRoot: dataRoot,
          evidenceFilter: evidenceFilter, onEvidenceFilter: setEvidenceFilter,
        }),
        toast ? h('div', { className: 'bf-toast', role: 'status' }, toast) : null)
    }

    function WorkbenchPage() {
      return h(PluginErrorBoundary, null, h(WorkbenchBody))
    }

    function SidebarIcon() {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } },
        h('img', {
          src: BF_ICON_DATA_URI, alt: '', 'aria-hidden': 'true',
          style: {
            display: 'inline-block', width: 20, height: 20, borderRadius: 6,
            objectFit: 'cover', border: '1px solid var(--dsw-alias-border-l1, #C9E4F5)',
            flex: '0 0 auto',
          },
        }),
        h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, DICT_ZH.nav))
    }

    // ----------------------------------------------------------------------
    // 槽注册（ns / key / id 按任务约定：dsh-bioflow · bioflow · bioflow）
    // ----------------------------------------------------------------------
    var DICT_ZH = { nav: '许愿式生物信息全自动分析平台', short: '许愿式分析', title: '许愿式生物信息全自动分析平台' }
    var DICT_EN = { nav: 'Wishful Bioinformatics Platform', short: 'Wishful', title: 'Wishful Bioinformatics Platform' }

    function apply(ctx) {
      var locale = ctx && ctx.locale
      if (locale && typeof locale.register === 'function') {
        var registerDictionaries = function () {
          try {
            return locale.register(NS, { zh: DICT_ZH, en: DICT_EN })
          } catch (error) {
            warn('failed to register locale dictionaries', error)
            return undefined
          }
        }
        try {
          if (typeof ctx.effect === 'function') ctx.effect(registerDictionaries, NS + ': locale')
          else registerDictionaries()
        } catch (error) { warn('failed to install locale effect', error) }
      }

      var slots = ctx && ctx.slots
      if (!slots && ctx && typeof ctx.get === 'function') {
        try { slots = ctx.get('slots') } catch (error) { slots = null }
      }
      if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
        warn('slots service unavailable; UI not registered')
        return
      }

      var disposers = []
      function keep(handle) {
        if (typeof handle === 'function') disposers.push(handle)
        return handle
      }
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return function () {
              while (disposers.length) {
                var dispose = disposers.pop()
                try { dispose() } catch (ignored) { /* ignore */ }
              }
            }
          }, NS + ': slot disposers')
        }
      } catch (error) { warn('failed to install slot cleanup', error) }

      try {
        keep(slots.inject('main', function () {
          return keep(slots.register({ name: 'main', key: 'bioflow', locale: NS }, WorkbenchPage))
        }))
      } catch (error) { warn('failed to register main slot', error) }

      try {
        keep(slots.inject('sidebar.panellist', function () {
          return keep(slots.register({
            name: 'sidebar.panellist',
            id: 'bioflow',
            order: 6,
            label: function () { return DICT_ZH.nav },
            locale: NS,
          }, SidebarIcon))
        }))
      } catch (error) { warn('failed to register sidebar.panellist slot', error) }
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply: apply,
      __test__: Object.assign({}, BF_TEST, {
        PluginErrorBoundary: PluginErrorBoundary,
        components: {
          WorkbenchPage: WorkbenchPage,
          WorkbenchBody: WorkbenchBody,
          TopBar: TopBar,
          ChatColumn: ChatColumn,
          PlanCard: PlanCard,
          Timeline: Timeline,
          SourceSearch: SourceSearch,
          DownloadQueue: DownloadQueue,
          ArtifactsPanel: ArtifactsPanel,
          StatsContractCard: StatsContractCard,
          StatsChips: StatsChips,
          Drawer: Drawer,
          ManifestView: ManifestView,
          EvidenceList: EvidenceList,
          FiguresGrid: FiguresGrid,
          SidebarIcon: SidebarIcon,
          PaperFigurePanel: PaperFigurePanel,
          GuidedPage: GuidedPage,
        },
      }),
    }
  }

  // ==========================================================================
  // 注册
  // ==========================================================================
  if (typeof window === 'undefined') {
    globalThis.__BF_TEST__ = BF_TEST
  } else if (window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({ id: NS, factory: factory })
  }
})()
