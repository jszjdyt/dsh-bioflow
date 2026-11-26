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
      progress: stepProgress(steps),
      updatedAtIso: asText(run.updated_at || run.created_at, ''),
      updatedAt: Date.now(),
      raw: source,
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
    '.bf-root{--bf-bg-0:#F1F9FF;--bf-bg-1:#E8F5FE;--bf-bg-2:#FFFFFF;--bf-ink-0:#071A29;--bf-ink-1:#10304A;--bf-ink-2:#527191;--bf-line:#CFE6F6;--bf-line-glow:#6FD3FC;--bf-accent:#0DA5EA;--bf-accent-2:#38BDF8;--bf-accent-3:#8ADCFD;--bf-ok:#0E9488;--bf-warn:#C9790A;--bf-err:#DC2626;--bf-blocked:#6D4AE0;--bf-glass:rgba(255,255,255,.82);--bf-shadow:0 1px 0 #FFFFFF inset,0 22px 48px -34px rgba(8,60,96,.42);--bf-glow:0 0 0 1px color-mix(in srgb,var(--bf-line-glow) 60%,transparent),0 0 26px -8px rgba(14,165,233,.55);--bf-radius:18px;--bf-mono:ui-monospace,"SF Mono",Menlo,monospace;--bf-sans:-apple-system,"PingFang SC","Helvetica Neue",sans-serif;position:relative;display:flex;flex-direction:column;height:100%;min-height:calc(100vh - 72px);overflow:hidden;background:radial-gradient(1200px 620px at 14% -12%,#D9F2FF 0%,rgba(217,242,255,0) 62%),radial-gradient(900px 520px at 102% -4%,#E7F8FF 0%,rgba(231,248,255,0) 58%),radial-gradient(700px 480px at 52% 108%,#EAF7FF 0%,rgba(234,247,255,0) 60%),linear-gradient(180deg,#F8FDFF 0%,#EEF8FE 100%);color:var(--bf-ink-1);font-family:var(--bf-sans);font-size:13px;line-height:1.55;-webkit-font-smoothing:antialiased}',
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
    '.bf-body{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,0.92fr) minmax(0,1.08fr);gap:14px;padding:14px;overflow:hidden}',
    '.bf-side,.bf-main,.bf-right{min-width:0;min-height:0}',
    '.bf-side{display:flex;flex-direction:column;gap:12px;overflow:hidden}.bf-side .bf-panel{min-height:200px}',
    '.bf-main{display:flex;flex-direction:column;gap:12px;overflow-y:auto;padding-right:2px}',
    '.bf-right{display:flex;flex-direction:column;gap:12px;overflow-y:auto;padding-right:2px}',
    /* 面板：1px 发光顶线 + 8×8 网格底纹（SPEC §1 科幻感三件事之二） */
    '.bf-panel{position:relative;display:flex;flex-direction:column;min-height:0;border:1px solid var(--bf-line);border-radius:var(--bf-radius);background:linear-gradient(180deg,rgba(255,255,255,.95),rgba(255,255,255,.82));backdrop-filter:blur(14px) saturate(1.05);box-shadow:var(--bf-shadow);overflow:hidden}',
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
    '.bf-feed{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:14px}',
    '.bf-msg{display:flex;flex-direction:column;gap:4px;max-width:94%;min-width:0}',
    '.bf-msg-role{font-size:10px;font-weight:600;color:var(--bf-ink-2);letter-spacing:.14em;text-transform:uppercase;padding:0 4px}',
    '.bf-msg-text{font-size:12.5px;color:var(--bf-ink-1);white-space:pre-wrap;word-break:break-word;line-height:1.6;border-radius:15px}',
    '.bf-msg-user{align-self:flex-end;align-items:flex-end}.bf-msg-user .bf-msg-text{background:linear-gradient(135deg,#0EA5E9,#38BDF8);color:#04222F;border:1px solid color-mix(in srgb,var(--bf-accent) 65%,transparent);border-bottom-right-radius:5px;padding:9px 13px;box-shadow:0 12px 24px -18px rgba(14,165,233,.9)}',
    '.bf-msg-agent{align-self:flex-start}.bf-msg-agent .bf-msg-text{background:rgba(255,255,255,.94);border:1px solid var(--bf-line);border-bottom-left-radius:5px;padding:9px 13px;box-shadow:0 1px 0 #FFFFFF inset,0 14px 26px -26px rgba(8,60,96,.55)}',
    '.bf-msg-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--bf-ink-2)}',
    '.bf-composer{flex:none;display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;background:linear-gradient(180deg,rgba(255,255,255,0),rgba(255,255,255,.6))}',
    '.bf-wish{position:relative;display:flex;flex-direction:column;gap:4px;padding:10px 12px 8px;border:1px solid var(--bf-line);border-radius:16px;background:linear-gradient(180deg,#FFFFFF,rgba(246,252,255,.96));box-shadow:0 1px 0 #FFFFFF inset,0 16px 32px -28px rgba(8,60,96,.55);transition:border-color .16s ease,box-shadow .16s ease}.bf-wish:focus-within{border-color:var(--bf-line-glow);box-shadow:var(--bf-glow),0 1px 0 #FFFFFF inset}',
    '.bf-wish-input{width:100%;min-height:46px;max-height:170px;resize:none;border:0;outline:none;background:transparent;padding:2px 0;font-size:13px;line-height:1.6;color:var(--bf-ink-1);font-family:var(--bf-sans)}.bf-wish-input::placeholder{color:color-mix(in srgb,var(--bf-ink-2) 72%,transparent)}.bf-wish-bar{display:flex;align-items:center;gap:8px;min-height:34px}.bf-send{width:34px;height:34px;flex:none;border-radius:12px;border:0;background:linear-gradient(135deg,var(--bf-accent-2),var(--bf-accent));color:#FFFFFF;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 10px 20px -10px rgba(14,165,233,.85);transition:transform .12s ease,box-shadow .12s ease}.bf-send:hover:not([disabled]){transform:translateY(-1px);box-shadow:0 14px 24px -12px rgba(14,165,233,.95)}.bf-send[disabled]{opacity:.42;box-shadow:none;cursor:not-allowed}.bf-chips{display:flex;gap:6px;flex-wrap:wrap}.bf-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--bf-line);background:rgba(255,255,255,.72);color:var(--bf-ink-1);font-size:11px;white-space:nowrap;transition:border-color .14s ease,background-color .14s ease,box-shadow .14s ease}.bf-chip:hover{border-color:var(--bf-line-glow);background:#FFFFFF;box-shadow:0 0 0 3px color-mix(in srgb,var(--bf-accent-3) 22%,transparent)}.bf-composer-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.bf-composer-hint{font-size:11px;color:var(--bf-ink-2);line-height:1.4}',
    '.bf-work{display:flex;flex-direction:column;gap:12px;min-height:0;overflow-y:auto;padding-right:2px}',
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
  ]

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
          h('span', { className: 'bf-mark', 'aria-hidden': 'true' }, h(Icon, { name: 'flask', size: 16 })),
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
              return h('button', {
                key: run.runId, type: 'button',
                className: 'bf-runitem' + (selected ? ' bf-runitem-on' : ''),
                onClick: function () { props.onSelect(run.runId) },
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

    function ChatColumn(props) {
      var messages = props.messages || []
      var figureState = useState(false)
      var figureOpen = figureState[0]
      var setFigureOpen = figureState[1]
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
            h('span', { className: 'bf-panel-sub' }, '直接打字 · 只出 draft，不会自动跑')),
          h('div', { className: 'bf-panel-body bf-wishdeck-body' },
            h('div', { className: 'bf-chips bf-starters' },
              h('span', { className: 'bf-composer-hint' }, '不知道从哪开始？'),
              h('button', { type: 'button', className: 'bf-chip', onClick: function () { if (props.onNavigate) props.onNavigate('wizard') } }, '我有数据'),
              h('button', { type: 'button', className: 'bf-chip', onClick: function () { if (props.onNavigate) props.onNavigate('guided') } }, '我只有方向'),
              h('button', { type: 'button', className: 'bf-chip', onClick: function () { props.onCompose('帮我找公共数据：先给候选队列和中文摘要，说明每个队列能回答什么、缺什么，再让我挑') } }, '帮我找数据'),
              h('button', { type: 'button', className: 'bf-chip', onClick: function () { setFigureOpen(true) } }, '照着图来')),
            figureOpen ? h('div', { className: 'bf-modal', role: 'dialog', 'aria-label': '照着图来' },
              h('div', { className: 'bf-modal-card' },
                h('div', { className: 'bf-modal-head' },
                  h('span', { className: 'bf-panel-title' }, h(Icon, { name: 'image', size: 13 }), '照着图来：你想要哪张图？'),
                  h('div', { className: 'bf-spacer' }),
                  h('button', { type: 'button', className: 'bf-btn bf-btn-sm bf-btn-ghost', onClick: function () { setFigureOpen(false) } }, h(Icon, { name: 'close', size: 11 }), '关闭')),
                h('div', { className: 'bf-modal-body' }, FIGURE_PRESETS.map(function (preset) {
                  return h('button', {
                    key: preset.id, type: 'button', className: 'bf-example',
                    onClick: function () { props.onCompose(preset.need); setFigureOpen(false) },
                  }, preset.label)
                })))) : null,
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
      if (mode === 'evidence') return evidenceBlock
      if (mode === 'all') {
        return h('div', { className: 'bf-col' },
          h('div', { className: 'bf-subhead' }, '文件入口'), files,
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
              { key: 'evidence', label: '证据' },
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
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', {
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 20, height: 20, borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l1, #C9E4F5)',
            background: 'var(--dsw-alias-bg-layer-2, #E6F4FB)',
            color: 'var(--dsw-alias-brand-primary, #0EA5E9)',
          },
        }, h(Icon, { name: 'flask', size: 12 })),
        h('span', null, 'Bioflow'))
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
          Drawer: Drawer,
          ManifestView: ManifestView,
          EvidenceList: EvidenceList,
          FiguresGrid: FiguresGrid,
          SidebarIcon: SidebarIcon,
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
