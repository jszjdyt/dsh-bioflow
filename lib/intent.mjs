/**
 * dsh-bioflow — 自然语言 → 结构化 intent / draft plan
 *
 * 硬要求（lead 追加）：
 *   - 解析**不许直接执行**：一律返回 status=draft 的计划卡 + 需要确认的字段；
 *   - 缺关键信息时反问**最少**的问题，不许瞎猜；
 *   - 确定性规则优先；规则覆盖不了的才可选 LLM 兜底，LLM 输出只当建议，
 *     落成 plan 前做 schema 校验 + 闸门检查；
 *   - 计划带 confirm_token；确认前改任何字段 → 新 draft（新 token）。
 */

import { sha256Json, nowIso } from './store.mjs'
import { buildPlan, TEMPLATES, PLUGIN_IDS } from './plan.mjs'

export const INTENT_VERSION = 1

export const ALLOWED_TEMPLATES = Object.keys(TEMPLATES)
export const GOALS = ['de', 'composition', 'spatial', 'metabolomics', 'perturb', 'figure', 'harmonize', 'joint', 'search', 'unknown']

export const FIELD_HELP = {
  dataset: '必须先有已登记的数据（可从 GEO/GDC/MetaboLights 下载后 register，或直接 register 本地矩阵+样本表）',
  template: '决定分析流程：bulk 两组/配对差异→bulk-two-group；单细胞组成/pseudobulk→scrna-composition；空间→spatial-domain；代谢→metabolomics-de；虚拟扰动→virtualcell-perturb；纯出图→plotlab-figure',
  contrast: '比较方向必须明确：logFC = case - control；两组写反结论就反了',
  paired: '同一供体同时有两组样本时选配对；否则按独立样本处理',
  covariates: '要校正的批次/性别/年龄等列；与分组完全共线会被闸门拦下',
  endpoint: '生存/随访分析需要明确终点（OS/PFS）与时间/事件列',
  scale: 'counts 与 log 表达的统计方法不同；未验证尺度的推断会被闸门阻止',
  min_cells: '单细胞比例检验的最小细胞数（默认 10），影响分母与可检验的细胞类型',
  fdr_family: '多重校正的检验族与阈值（默认 BH FDR 0.05）',
  deliverables: '默认输出 manifest/design/qc/results/figures/evidence/methods 全套',
}

// 顺序即优先级：越具体的模态越靠前，避免「空间单细胞」「代谢差异」被通用规则抢走。
const TEMPLATE_RULES = [
  { pattern: /(空间转录组|空间组学|空间数据|空间域|空间高变|\bVisium\b|\bStereo.?seq\b|\bSlide.?seq\b|\bMERFISH\b|spatial)/i, template: 'spatial-domain', goal: 'spatial' },
  { pattern: /(代谢组|代谢物|代谢特征|LC.?MS|GC.?MS|\bNMR\b|m\/z|峰表|MetaboLights|\bMTBLS\d+)/i, template: 'metabolomics-de', goal: 'metabolomics' },
  { pattern: /(虚拟细胞|虚拟敲除|虚拟过表达|in.?silico|扰动|\bGRN\b|调控网络|敲除|knockout|knockdown|过表达|靶点|Perturb)/i, template: 'virtualcell-perturb', goal: 'perturb' },
  { pattern: /(差异表达|差异基因|差异分析|\bDEG\b|富集|火山图|GSEA|ORA)/i, template: 'bulk-two-group', goal: 'de' },
  { pattern: /(细胞类型|细胞组成|细胞比例|比例差异|pseudobulk|伪bulk|单细胞|scRNA|NK|CD8|T 细胞|T细胞|巨噬|中性粒|cluster)/i, template: 'scrna-composition', goal: 'composition' },
  { pattern: /(出图|作图|画图|绘图|可视化|画个|画张|\bplot\b|\bfigure\b|配色|字体|箱线图|火山图|热图|散点|柱状图)/i, template: 'plotlab-figure', goal: 'figure' },
]

const HARMONIZE_RE = /(归一化|标准化|批次|校正|ComBat|quantile|联合|合并|多队列|多数据集|harmonize)/i
const JOINT_RE = /(联合分析|meta.?分析|荟萃|跨队列|跨模态|签名|signature|多队列合并|联合出图)/i
const SEARCH_RE = /(检索|搜索|找数据|下载数据|有没有.*数据|GEO|TCGA|GDC|MetaboLights|CELLxGENE|文献)/i

const SOURCE_HINT_RULES = [
  { source: 'geo', pattern: /\bGSE\d{3,7}\b/i },
  { source: 'gdc', pattern: /\bTCGA-[A-Z0-9]{2,6}\b/i },
  { source: 'metabolights', pattern: /\bMTBLS\d+\b/i },
  { source: 'cellxgene', pattern: /CELLxGENE/i },
  { source: 'pubmed', pattern: /(PubMed|文献|paper)/i },
]

const CELL_TYPE_RE = /(NK\s*细胞?|CD8\+?\s*T\s*细胞?|CD4\+?\s*T\s*细胞?|T\s*细胞|B\s*细胞|巨噬细胞|单核细胞|中性粒细胞|树突状细胞|内皮细胞|成纤维细胞|上皮细胞|肿瘤细胞)/i
const GROUP_STOP = /^(?:一下|比较|对比|差异|看看|分析|出图|作图|画图|的|吗|呢|吧|啊)+$/i

function cleanGroup(text) {
  let value = String(text || '').trim()
  value = value.replace(/^[把拿将就按对用]+/, '').replace(/(?:的|了|一下|比较|对比|差异|分析|出图|作图|画图|看看)+$/g, '').trim()
  value = value.replace(/^(?:case|treatment|实验组|组)\s*[=:：]\s*/i, '')
  value = value.replace(/\s+/g, ' ')
  if (!value || GROUP_STOP.test(value)) return null
  return value.slice(0, 60)
}

/** 确定性规则解析一句话。 */
export function parseIntent({ text, datasets = [], datasetId = null, now = () => new Date() } = {}) {
  const raw = String(text || '').trim()
  if (!raw) throw Object.assign(new Error('许愿内容为空：需要一句话描述分析目标'), { code: 'bad_request' })
  const rules = []
  const warnings = []
  const intent = {
    version: INTENT_VERSION,
    raw_text: raw,
    at: now().toISOString(),
    goal: 'unknown',
    template: null,
    dataset_hint: datasetId || null,
    source_hint: null,
    search_terms: [],
    contrast: null,
    cell_type: null,
    design: { paired: false, covariates: [], endpoint: null },
    scale: null,
    min_cells: null,
    fdr_family: null,
    deliverables: ['manifest', 'design', 'qc', 'results', 'figures', 'evidence', 'methods'],
    rules_matched: rules,
    warnings,
  }

  // 1. 数据源提示
  for (const rule of SOURCE_HINT_RULES) {
    const match = raw.match(rule.pattern)
    if (match) {
      intent.source_hint = rule.source
      intent.source_value = match[0].toUpperCase ? match[0] : match[0]
      rules.push({ rule: 'source_hint', value: match[0], source: rule.source })
      break
    }
  }
  const gseMatch = raw.match(/\bGSE\d{3,7}\b/i)
  if (gseMatch) { intent.dataset_hint = intent.dataset_hint || gseMatch[0].toUpperCase(); intent.source_hint = 'geo' }
  const tcgaMatch = raw.match(/\bTCGA-[A-Z0-9]{2,6}\b/i)
  if (tcgaMatch) { intent.project_hint = tcgaMatch[0].toUpperCase(); intent.source_hint = 'gdc' }
  const mtblsMatch = raw.match(/\bMTBLS\d+\b/i)
  if (mtblsMatch) { intent.accession_hint = mtblsMatch[0].toUpperCase(); intent.source_hint = 'metabolights' }

  // 2. 模板 / 目标
  for (const rule of TEMPLATE_RULES) {
    if (rule.pattern.test(raw)) {
      intent.template = rule.template
      intent.goal = rule.goal
      rules.push({ rule: 'template', template: rule.template })
      break
    }
  }
  if (HARMONIZE_RE.test(raw)) {
    intent.goal = 'harmonize'
    rules.push({ rule: 'goal', value: 'harmonize' })
  }
  if (JOINT_RE.test(raw)) {
    intent.goal = 'joint'
    rules.push({ rule: 'goal', value: 'joint' })
  }
  if (!intent.template && SEARCH_RE.test(raw) && !datasets.length) {
    intent.goal = 'search'
    rules.push({ rule: 'goal', value: 'search' })
  }

  // 3. 细胞类型
  const cellTypeMatch = raw.match(CELL_TYPE_RE)
  if (cellTypeMatch) {
    intent.cell_type = cellTypeMatch[0].replace(/\s+/g, ' ').trim()
    rules.push({ rule: 'cell_type', value: intent.cell_type })
  }

  // 4. contrast（中文/英文多种句式；只取保守匹配，可疑时留给用户确认）
  const contrastPatterns = [
    /把\s*(?<case>.+?)\s*的\s*(?<cell>.+?)\s*(?:跟|和|与|比|vs\.?)\s*(?<control>.+?)\s*(?:比|比较|对比|差异|一下|$)/i,
    /(?<case>[^\s，,。；;]+?)\s*(?:vs\.?|VS|对比|相比|与|和|跟)\s*(?<control>[^\s，,。；;]+?)\s*(?:比较|对比|差异|比|$)/i,
    /按\s*(?<group>.+?)\s*(?:分组)?\s*(?:比较|对比)\s*(?<rest>.*)$/i,
  ]
  for (const pattern of contrastPatterns) {
    const match = raw.match(pattern)
    if (!match || !match.groups) continue
    const caseGroup = cleanGroup(match.groups.case)
    const controlGroup = cleanGroup(match.groups.control)
    if (caseGroup && controlGroup) {
      intent.contrast = { case: caseGroup, control: controlGroup, direction: 'case_minus_control', needs_confirm: true }
      rules.push({ rule: 'contrast', value: `${caseGroup} vs ${controlGroup}` })
      break
    }
  }

  // 5. 设计细节
  if (/(配对|paired)/i.test(raw)) { intent.design.paired = true; rules.push({ rule: 'design', value: 'paired' }) }
  const covariateMatch = raw.match(/(?:校正|协变量|adjusted for|covariates?)\s*[：:]?\s*([^\s，,。；;]+)/i)
  if (covariateMatch) {
    intent.design.covariates = covariateMatch[1].split(/[、,/]/).map((item) => item.trim()).filter(Boolean)
    rules.push({ rule: 'covariates', value: intent.design.covariates })
  }
  const endpointMatch = raw.match(/(\bOS\b|总生存|overall survival|\bPFS\b|无进展生存|progression.free)/i)
  if (endpointMatch) {
    intent.design.endpoint = /PFS|无进展/i.test(endpointMatch[0]) ? 'PFS' : 'OS'
    rules.push({ rule: 'endpoint', value: intent.design.endpoint })
  }
  const scaleMatch = raw.match(/(counts?|原始计数|TPM|log\s*表达|log2|芯片|microarray)/i)
  if (scaleMatch) {
    const token = scaleMatch[0].toLowerCase()
    intent.scale = token.startsWith('count') || token.includes('原始') ? 'counts' : token.includes('tpm') ? 'tpm' : token.includes('log') ? 'log_expression' : 'microarray'
    rules.push({ rule: 'scale', value: intent.scale })
  }
  const minCellsMatch = raw.match(/最少?\s*(\d+)\s*个?细胞|min_?cells?\s*[=:：]?\s*(\d+)/i)
  if (minCellsMatch) {
    intent.min_cells = Number(minCellsMatch[1] || minCellsMatch[2])
    rules.push({ rule: 'min_cells', value: intent.min_cells })
  }
  const fdrMatch = raw.match(/(?:FDR|q\s*值|校正)\s*[<≤=:：]?\s*(0?\.\d+)/i)
  if (fdrMatch) { intent.fdr_family = { method: 'BH', alpha: Number(fdrMatch[1]) }; rules.push({ rule: 'fdr', value: fdrMatch[1] }) }

  // 6. 检索词提取（给"先搜数据"用）
  const diseaseTerms = raw
    .replace(/(帮我把|帮我|请|把|拿|用|按|检索|搜索|查找|找|下载|数据|数据集|的|和|与|跟|比|一下|比较|对比|差异|分析|出图|作图|画图)/g, ' ')
    .split(/[\s，,。；;、]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !/^(GSE\d+|TCGA-[A-Z0-9]+)$/i.test(token))
  intent.search_terms = [...new Set(diseaseTerms)].slice(0, 4)
  if (intent.search_terms.length) rules.push({ rule: 'search_terms', value: intent.search_terms })

  return intent
}

/** 在已登记数据里找与 intent 匹配的数据集（不做网络检索）。 */
export function resolveIntentDataset(intent, datasets = []) {
  const hint = intent.dataset_hint
  if (hint) {
    const direct = datasets.find((dataset) => dataset.dataset_id === hint)
    if (direct) return { dataset: direct, matched_by: 'dataset_id', needs_confirm: false }
    const byGse = datasets.find((dataset) => (dataset.source && dataset.source.gse || '').toUpperCase() === String(hint).toUpperCase())
    if (byGse) return { dataset: byGse, matched_by: 'gse', needs_confirm: false }
    const byName = datasets.find((dataset) => String(dataset.name || '').toUpperCase().includes(String(hint).toUpperCase()))
    if (byName) return { dataset: byName, matched_by: 'name', needs_confirm: true }
  }
  const text = String(intent.raw_text || '').toLowerCase()
  const byText = datasets.filter((dataset) => {
    const name = String(dataset.name || '').toLowerCase()
    return name && name.length >= 3 && text.includes(name)
  })
  if (byText.length === 1) return { dataset: byText[0], matched_by: 'text', needs_confirm: true }
  if (datasets.length === 1) return { dataset: datasets[0], matched_by: 'only_dataset', needs_confirm: true }
  return { dataset: null, matched_by: null, needs_confirm: false }
}

/** 把 intent 的 case/control 与数据集真实分组对齐；对不上则返回候选。 */
/** 两组时自动判 case/control：先看词义（肿瘤/转移/耐药 vs 正常/对照/邻癌），否则按名称排序取前两组。 */
const CASE_WORDS = /(tumou?r|case|disease|cancer|carcinoma|metasta|malignant|treated|resistant|responder|progress)/i
const CONTROL_WORDS = /(normal|control|healthy|adjacent|para|non.?tumou?r|untreated|sensitive|benign|baseline)/i

function autoContrastFromGroups(groups) {
  const list = (groups || []).filter(Boolean)
  if (list.length !== 2) return null
  const score = (name) => (CONTROL_WORDS.test(name) ? -1 : CASE_WORDS.test(name) ? 1 : 0)
  const [a, b] = list
  let caseGroup = a
  let controlGroup = b
  if (score(a) < score(b) || (score(a) === score(b) && a > b)) { caseGroup = b; controlGroup = a }
  if (!caseGroup || !controlGroup || caseGroup === controlGroup) return null
  return { case: caseGroup, control: controlGroup, direction: 'case_minus_control', needs_confirm: true, auto: true }
}

export function alignContrast(intent, dataset) {
  const groups = dataset && dataset.design && Array.isArray(dataset.design.samples)
    ? [...new Set(dataset.design.samples.map((sample) => String(sample.group || '').trim()).filter(Boolean))]
    : []
  if (!intent.contrast) {
    // 许愿式：没写比较方向时，分组恰好两组就自动判方向（计划卡仍可改）
    const auto = autoContrastFromGroups(groups)
    if (auto) return { contrast: auto, groups, auto: true, reason: '数据里只有两组，已自动判定方向（可在计划卡里改）' }
    return { contrast: null, groups, reason: '未从文本中解析出比较方向，且数据分组不足以自动判定' }
  }
  const exact = (value) => groups.find((group) => group.toLowerCase() === String(value).toLowerCase())
  const fuzzy = (value) => groups.find((group) => group.includes(String(value)) || String(value).includes(group))
  const caseGroup = exact(intent.contrast.case) || fuzzy(intent.contrast.case)
  const controlGroup = exact(intent.contrast.control) || fuzzy(intent.contrast.control)
  if (caseGroup && controlGroup && caseGroup !== controlGroup) {
    return { contrast: { case: caseGroup, control: controlGroup, direction: intent.contrast.direction, needs_confirm: true }, groups, reason: '文本组名已对齐到数据分组' }
  }
  return {
    contrast: null,
    groups,
    reason: `文本里的组名对不上数据分组：case="${intent.contrast.case}" control="${intent.contrast.control}"；数据分组：${groups.join('、') || '无'}`,
  }
}

function candidatesFor(field, { intent, dataset, datasets }) {
  if (field === 'dataset') {
    return datasets.slice(0, 8).map((item) => ({
      value: item.dataset_id,
      label: `${item.name || item.dataset_id}${item.design && item.design.group_column ? `（分组 ${item.design.group_column}）` : ''}`,
      detail: `${item.n_samples || '?'} 样本 · ${item.assay || item.data_kind || '未知类型'}`,
    }))
  }
  if (field === 'template') {
    return ALLOWED_TEMPLATES.map((id) => ({ value: id, label: TEMPLATES[id].title, detail: TEMPLATES[id].description }))
  }
  if (field === 'contrast') {
    const groups = dataset && dataset.design && Array.isArray(dataset.design.samples)
      ? [...new Set(dataset.design.samples.map((sample) => String(sample.group || '').trim()).filter(Boolean))]
      : []
    const pairs = []
    for (const caseGroup of groups) {
      for (const controlGroup of groups) {
        if (caseGroup === controlGroup) continue
        pairs.push({ value: { case: caseGroup, control: controlGroup }, label: `${caseGroup} vs ${controlGroup}`, detail: `logFC = ${caseGroup} - ${controlGroup}` })
      }
    }
    return pairs.slice(0, 8)
  }
  if (field === 'scale') {
    return [
      { value: 'counts', label: '原始 counts', detail: '适用于 DESeq2/edgeR；需 verified=true' },
      { value: 'log_expression', label: 'log 表达', detail: '适用于 limma；需 verified=true' },
      { value: 'unknown', label: '不确定', detail: '会被 counts_verified 闸门拦下（只允许描述性分析）' },
    ]
  }
  if (field === 'paired') return [{ value: true, label: '配对' }, { value: false, label: '独立样本' }]
  return []
}

/** 由 intent 生成 draft 计划（永不直接执行）。 */
export function buildDraft({ intent, dataset = null, datasets = [], store = null, llmSuggestion = null, llmUsed = false, warnings: extraWarnings = [] } = {}) {
  const warnings = [...(intent.warnings || []), ...extraWarnings]
  const missing = []
  const questions = []
  let matchedTemplate = intent.template || (llmSuggestion && llmSuggestion.template) || null
  // 模板必须和数据集模态匹配：话里说"NK 细胞"但数据是 bulk 时，不能硬套 scrna 模板
  if (dataset && matchedTemplate && TEMPLATES[matchedTemplate]) {
    const requires = TEMPLATES[matchedTemplate].requires_kind || []
    const kind = String(dataset.data_kind || 'unknown')
    if (!requires.includes(kind) && !requires.includes('any')) {
      const byKind = { bulk: 'bulk-two-group', scrna: 'scrna-composition', spatial: 'spatial-domain', metabolomics: 'metabolomics-de' }
      const fallback = byKind[kind] || 'plotlab-figure'
      warnings.push(`模板 ${matchedTemplate} 需要 ${requires.join('/')} 数据，当前数据集是 ${kind}，已改用 ${fallback}`)
      matchedTemplate = fallback
    }
  }
  if (!dataset) missing.push('dataset')
  if (!matchedTemplate) missing.push('template')
  const aligned = dataset ? alignContrast(intent, dataset) : { contrast: null, groups: [], reason: '没有数据集，无法对齐分组' }
  const templateNeedsContrast = !(matchedTemplate && TEMPLATES[matchedTemplate] && TEMPLATES[matchedTemplate].requires_contrast === false)
  if (matchedTemplate && templateNeedsContrast && !aligned.contrast) missing.push('contrast')
  if (dataset && (!dataset.scale || !dataset.scale.type || dataset.scale.type === 'unknown')) missing.push('scale')

  const params = {
    seed: 0,
    contrast: aligned.contrast || undefined,
    paired: Boolean(intent.design.paired),
    covariates: intent.design.covariates || [],
    method: undefined,
  }
  for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key]
  if (intent.min_cells) params.min_cells = intent.min_cells
  if (intent.fdr_family) params.fdr = { method: intent.fdr_family.method, alpha: intent.fdr_family.alpha }

  let plan = null
  if (dataset && matchedTemplate) {
    try {
      plan = buildPlan({ dataset, template: matchedTemplate, params })
    } catch (error) {
      warnings.push(`计划构造失败：${error && error.message ? error.message : error}`)
    }
  }

  const fieldValues = {
    dataset: dataset ? dataset.dataset_id : null,
    template: matchedTemplate,
    contrast: aligned.contrast ? { case: aligned.contrast.case, control: aligned.contrast.control } : null,
    paired: Boolean(intent.design.paired),
    covariates: intent.design.covariates || [],
    endpoint: intent.design.endpoint || null,
    scale: dataset && dataset.scale ? dataset.scale.type || 'unknown' : null,
    min_cells: intent.min_cells || null,
    fdr_family: intent.fdr_family ? `${intent.fdr_family.method} ${intent.fdr_family.alpha}` : 'BH 0.05',
    deliverables: intent.deliverables,
  }

  const candidateMap = {}
  for (const field of missing) {
    candidateMap[field] = candidatesFor(field, { intent, dataset, datasets })
    const question = questionFor(field, { intent, dataset })
    if (question) questions.push({ field, question, candidates: candidateMap[field].slice(0, 6) })
  }

  const draftPlan = plan
    ? { ...plan, status: 'draft', draft: true, draft_of_status: plan.status }
    : {
      schema_version: 1,
      plan_id: `draft_${sha256Json({ fieldValues, intent: intent.raw_text }).slice(0, 12)}`,
      template: matchedTemplate,
      template_version: matchedTemplate && TEMPLATES[matchedTemplate] ? TEMPLATES[matchedTemplate].version : null,
      dataset_id: dataset ? dataset.dataset_id : null,
      dataset_revision: dataset ? dataset.dataset_id : null,
      seed: 0,
      contrast: aligned.contrast,
      params,
      steps: [],
      gates: [],
      blocking: [],
      status: 'draft',
      draft: true,
      created_at: nowIso(),
    }
  if (plan) {
    // draft 仍带上闸门结果，让用户看到会被哪条拦
    draftPlan.gates = plan.gates
    draftPlan.blocking = plan.blocking
    draftPlan.status = 'draft'
    draftPlan.draft_of_status = plan.status
    draftPlan.steps = plan.steps
  }

  const tokenPayload = {
    plan_id: draftPlan.plan_id,
    template: draftPlan.template,
    dataset_id: draftPlan.dataset_id,
    contrast: fieldValues.contrast,
    paired: fieldValues.paired,
    covariates: fieldValues.covariates,
    scale: fieldValues.scale,
    params,
    version: INTENT_VERSION,
  }
  const confirmToken = sha256Json(tokenPayload)
  const response = {
    ok: true,
    action: 'ask',
    status: 'draft',
    draft_status: plan ? plan.status : 'incomplete',
    confirm_token: confirmToken,
    intent,
    plan: draftPlan,
    fields: fieldValues,
    missing_fields: missing,
    questions,
    candidates: candidateMap,
    llm_used: Boolean(llmUsed),
    llm_suggestion: llmSuggestion || null,
    rules_matched: intent.rules_matched,
    warnings,
    summary: missing.length
      ? `draft 计划（待确认）：还缺 ${missing.map((field) => FIELD_HELP[field] ? field : field).join('、')}。补齐后 submit 需要带 confirm_token`
      : `draft 计划（待确认）：${matchedTemplate} · ${fieldValues.contrast ? `${fieldValues.contrast.case} vs ${fieldValues.contrast.control}` : '对比待定'}；确认后 submit（需 confirm_token）`,
    next: '用 action=ask（带 dataset/template/contrast 或 native 文本）改字段；确认后 action=submit 带 plan_id + confirm_token。',
  }
  return response
}

function questionFor(field, { intent, dataset }) {
  if (field === 'dataset') {
    const terms = intent.search_terms && intent.search_terms.length ? `（可先 action=search term="${intent.search_terms.join(' ')}"）` : ''
    return `用哪个已登记数据？当前没有匹配的数据集${terms}`
  }
  if (field === 'template') return '要做哪类分析？差异表达 / 单细胞细胞组成 / 多数据归一化 / 联合分析'
  if (field === 'contrast') {
    const groups = dataset && dataset.design ? [...new Set((dataset.design.samples || []).map((sample) => sample.group).filter(Boolean))] : []
    return `比较哪两组？logFC = case - control。${groups.length ? `数据里可选：${groups.join('、')}` : '数据还没有分组信息'}`
  }
  if (field === 'scale') return '数据尺度是原始 counts 还是 log 表达？（未验证时只能做描述性分析）'
  return null
}

/** 校验 confirm_token 是否对应当前计划字段。 */
export function verifyConfirmToken(plan, token) {
  if (!plan || !token) return { ok: false, reason: 'missing_token', message: 'submit 需要 plan 返回的 confirm_token' }
  const expected = plan.confirm_token || (plan.plan && plan.plan.confirm_token)
  if (expected) return expected === String(token)
    ? { ok: true }
    : { ok: false, reason: 'draft_changed', message: '计划字段已变化（新 draft），旧 confirm_token 失效；请重新确认' }
  // plan 来自 store：用字段重算
  const payload = {
    plan_id: plan.plan_id,
    template: plan.template,
    dataset_id: plan.dataset_id,
    contrast: plan.contrast ? { case: plan.contrast.case, control: plan.contrast.control } : null,
    paired: Boolean(plan.params && plan.params.paired),
    covariates: (plan.params && plan.params.covariates) || [],
    scale: plan.scale || (plan.params && plan.params.scale) || null,
    params: plan.params || {},
    version: INTENT_VERSION,
  }
  const recomputed = sha256Json(payload)
  return recomputed === String(token)
    ? { ok: true }
    : { ok: false, reason: 'draft_changed', message: '计划字段与 confirm_token 不一致（确认前改过字段），请重新生成 draft 并确认' }
}

/**
 * 可选 LLM 兜底：把 LLM 输出当建议，只接受白名单字段，并做严格 schema 校验。
 * resolver 由宿主注入（runtime.llmResolver），没有就不调用。
 */
export async function llmAssist({ resolver, text, dataset, datasets } = {}) {
  if (typeof resolver !== 'function') return { used: false, reason: 'no_llm_resolver' }
  let suggestion
  try {
    suggestion = await resolver({
      text,
      schema: {
        template: ALLOWED_TEMPLATES,
        contrast: { case: 'string', control: 'string' },
        paired: 'boolean',
        covariates: 'string[]',
        goal: GOALS,
      },
      context: {
        datasets: datasets.map((item) => ({ dataset_id: item.dataset_id, name: item.name, groups: item.design ? [...new Set((item.design.samples || []).map((sample) => sample.group).filter(Boolean))] : [] })),
      },
    })
  } catch (error) {
    return { used: false, reason: `llm_error: ${error && error.message ? error.message : error}` }
  }
  const warnings = []
  const clean = {}
  if (suggestion && ALLOWED_TEMPLATES.includes(suggestion.template)) clean.template = suggestion.template
  else if (suggestion && suggestion.template) warnings.push(`忽略 LLM 给出的非法 template=${suggestion.template}`)
  if (suggestion && suggestion.contrast && typeof suggestion.contrast === 'object') {
    const caseGroup = cleanGroup(suggestion.contrast.case)
    const controlGroup = cleanGroup(suggestion.contrast.control)
    if (caseGroup && controlGroup && caseGroup !== controlGroup) clean.contrast = { case: caseGroup, control: controlGroup }
    else warnings.push('忽略 LLM 给出的无效 contrast（缺 case/control 或两侧相同）')
  }
  if (suggestion && typeof suggestion.paired === 'boolean') clean.paired = suggestion.paired
  if (suggestion && Array.isArray(suggestion.covariates)) clean.covariates = suggestion.covariates.filter((item) => typeof item === 'string')
  return { used: true, suggestion: clean, warnings }
}
