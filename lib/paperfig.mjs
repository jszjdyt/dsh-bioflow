/**
 * dsh-bioflow — 论文图注拆解
 *
 * 目标：从论文里拿到图注（PMC 全文 XML / 本地 PDF 文本 / 用户粘贴），
 * 判断「这张图像什么图、需要什么数据、对应哪个模板/图表」，生成一句
 * 可执行的许愿，而不是伪造视觉识别。纯函数、可单测、不联网。
 */

const CHART_RULES = [  {
    id: 'forest',
    label: '森林图 / 效应量合并',
    pattern: /forest plot|forestplot|odds ratio|hazard ratio.*forest|meta-analysis|pooled (effect|estimate)|fixed-effect|random-effect/i,
    dataKind: 'bulk',
    template: 'bulk-two-group',
    plotlab: 'forest',
    roles: { x: 'effect', y: 'feature', group: 'cohort' },
    needData: '多个队列的效应量（logFC/HR + 置信区间）',
  },
  {
    id: 'km',
    label: 'Kaplan-Meier 生存曲线',
    pattern: /kaplan|survival curve|survival analysis|overall survival|progression-free|disease-free|hazard ratio|log-rank|km curve|\bOS\b|\bPFS\b/i,
    dataKind: 'bulk',
    template: 'bulk-two-group',
    plotlab: 'km',
    roles: { x: 'time', y: 'survival', group: 'group' },
    needData: '带随访（时间 + 事件）的队列',
  },
  {
    id: 'volcano',
    label: '火山图（差异表达）',
    pattern: /volcano|volcano plot|differential(ly)? expressed|log2? ?fold.?change|logFC|fold change.*p.?value|up-?regulated|down-?regulated/i,
    dataKind: 'bulk',
    template: 'bulk-two-group',
    plotlab: null,
    roles: { x: 'logFC', y: '-log10(p)', color: 'direction' },
    needData: '两组 bulk 表达矩阵 + 分组',
  },
  {
    id: 'enrichment',
    label: 'GO/KEGG 富集气泡图 / 条形图',
    pattern: /GO enrichment|KEGG|gene ontology|pathway enrichment|GSEA|enrichment (dot|bar)|biological process|reactome|hallmark/i,
    dataKind: 'bulk',
    template: 'bulk-two-group',
    plotlab: 'dotplot',
    roles: { x: 'gene_ratio', y: 'term', size: 'count', color: 'p_adjust' },
    needData: '一份差异基因列表（通常接在差异分析后）',
  },
  {
    id: 'heatmap',
    label: '表达热图（聚类）',
    pattern: /heatmap|heat map|clustering.*expression|z-?score.*gene|expression profile/i,
    dataKind: 'bulk',
    template: 'bulk-two-group',
    plotlab: 'heatmap',
    roles: { x: 'sample', y: 'feature', color: 'expression' },
    needData: '表达矩阵 + 样本注释（分组/批次）',
  },
  {
    id: 'umap',
    label: 'UMAP/t-SNE 降维图',
    pattern: /\bUMAP\b|\bt-SNE\b|tSNE|dimensionality reduction|embedding plot/i,
    dataKind: 'scrna',
    template: 'scrna-composition',
    plotlab: null,
    roles: { x: 'UMAP_1', y: 'UMAP_2', color: 'cell_type' },
    needData: '单细胞表达矩阵（含细胞类型注释更好）',
  },
  {
    id: 'dotplot',
    label: 'Marker 点图',
    pattern: /dot ?plot|marker gene|gene expression dot|average expression|percent expressed/i,
    dataKind: 'scrna',
    template: 'scrna-composition',
    plotlab: 'dotplot',
    roles: { x: 'gene', y: 'cell_type', size: 'pct_expressed', color: 'avg_expression' },
    needData: '单细胞数据 + 细胞类型列 + marker 基因',
  },
  {
    id: 'composition',
    label: '细胞比例箱线/条形图',
    pattern: /cell (type )?(proportion|fraction|composition|abundance)|proportion of .*cells|immune cell infiltration|CIBERSORT|cell composition/i,
    dataKind: 'scrna',
    template: 'scrna-composition',
    plotlab: 'box',
    roles: { x: 'group', y: 'proportion', color: 'cell_type' },
    needData: '单细胞数据 + 分组 + 细胞类型列（最好有供体）',
  },
  {
    id: 'spatial',
    label: '空间分布 / 空间域图',
    pattern: /spatial (transcriptomics|distribution|domain|map)|visium|stereo-?seq|spatial niche|co-?localization|spatial expression/i,
    dataKind: 'spatial',
    template: 'spatial-domain',
    plotlab: null,
    roles: { x: 'x', y: 'y', color: 'domain' },
    needData: '空间转录组数据（Visium/Stereo-seq/h5ad + 坐标）',
  },
  {
    id: 'roc',
    label: 'ROC 曲线',
    pattern: /\bROC\b|AUC|receiver operating|diagnostic performance|sensitivity and specificity/i,
    dataKind: 'bulk',
    template: 'plotlab-figure',
    plotlab: 'roc',
    roles: { x: 'fpr', y: 'tpr', group: 'model' },
    needData: '带二分类标签的样本 + 预测分数/表达量',
  },
  {
    id: 'box',
    label: '箱线/小提琴图（组间比较）',
    pattern: /box ?plot|violin|bar plot.*(group|expression)|error bar|scatter.*group|comparison between|significance.*p\s*[<＝=]/i,
    dataKind: 'bulk',
    template: 'plotlab-figure',
    plotlab: 'box',
    roles: { x: 'group', y: 'value', color: 'group' },
    needData: 'tidy 数据（分组列 + 数值列）',
  },
  {
    id: 'pca',
    label: 'PCA / 样本聚类',
    pattern: /principal component|\bPCA\b|sample clustering|batch effect.*PCA|unsupervised clustering/i,
    dataKind: 'bulk',
    template: 'plotlab-figure',
    plotlab: 'pca',
    roles: { x: 'PC1', y: 'PC2', color: 'group' },
    needData: '表达矩阵 + 样本表（分组/批次）',
  },
  {
    id: 'corr',
    label: '相关性热图 / 散点相关',
    pattern: /correlation (heatmap|matrix|analysis)|spearman|pearson|co-?expression|correlat(ed|ion) with/i,
    dataKind: 'bulk',
    template: 'plotlab-figure',
    plotlab: 'corr',
    roles: { x: 'feature_a', y: 'feature_b', color: 'r' },
    needData: 'tidy 数据（两组数值列，或宽表）',
  },
  {
    id: 'bar',
    label: '柱状/条形图',
    pattern: /bar (chart|graph|plot)|column chart|stacked bar|mean .*error/i,
    dataKind: 'bulk',
    template: 'plotlab-figure',
    plotlab: 'bar',
    roles: { x: 'group', y: 'value', color: 'group' },
    needData: 'tidy 数据（分组 + 数值）',
  },
  {
    id: 'scatter',
    label: '散点/气泡图',
    pattern: /scatter ?plot|bubble plot|dot plot.*correlat|x-?axis.*y-?axis/i,
    dataKind: 'bulk',
    template: 'plotlab-figure',
    plotlab: 'scatter',
    roles: { x: 'x', y: 'y', color: 'group' },
    needData: 'tidy 数据（两列数值 + 可选分组）',
  },
  {
    id: 'line',
    label: '折线 / 趋势图',
    pattern: /line (chart|graph|plot)|time course|trend over|kinetics|dose[- ]response curve/i,
    dataKind: 'bulk',
    template: 'plotlab-figure',
    plotlab: 'line',
    roles: { x: 'time', y: 'value', group: 'group' },
    needData: 'tidy 数据（时间/剂量 + 数值 + 分组）',
  },
]

const CHART_FALLBACK = {
  id: 'unknown',
  label: '未识别的图型',
  dataKind: 'unknown',
  template: 'plotlab-figure',
  plotlab: null,
  roles: {},
  needData: '需要先说明：横轴、纵轴、分组分别是什么',
}

const ABBREVIATIONS = [
  [/\bFig\.(?=\s|\d)/gi, 'Figure'],
  [/\bFig(?=\s*\d)/g, 'Figure'],
  [/DEGs?/g, 'differentially expressed genes'],
  [/TME/g, 'tumor microenvironment'],
  [/NK\b/g, 'NK cells'],
]

function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)) } catch { return '' }
    })
    .replace(/&#(\d+);/g, (_, code) => {
      try { return String.fromCodePoint(Number(code)) } catch { return '' }
    })
}

function stripTags(text) {
  return decodeEntities(String(text || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/**
 * 从 PMC 全文 XML 里抽图注。
 * 只依赖 <fig> / <label> / <caption> 结构；不看图本身。
 */
export function parseFiguresFromPmcXml(xml, { limit = 12 } = {}) {
  const source = String(xml || '')
  const figures = []
  const pattern = /<fig\b[^>]*>([\s\S]*?)<\/fig>/gi
  let match
  let index = 0
  while ((match = pattern.exec(source)) !== null && figures.length < limit) {
    index += 1
    const body = match[1]
    const labelMatch = /<label\b[^>]*>([\s\S]*?)<\/label>/i.exec(body)
    const captionMatch = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(body)
    const caption = stripTags(captionMatch ? captionMatch[1] : body)
    const label = stripTags(labelMatch ? labelMatch[1] : '') || `Figure ${index}`
    if (!caption) continue
    figures.push({ index: figures.length + 1, label: label.replace(/\.$/, ''), caption })
  }
  return figures
}

/**
 * 从 PDF 提取的纯文本里找图注：以 "Figure N" / "Fig. N" 开头，收下一段。
 * 只做保守的启发式；找不到就返回空（不猜）。
 */
export function extractCaptionsFromText(text, { limit = 12 } = {}) {
  const raw = String(text || '').replace(/\r/g, '')
  const lines = raw.split('\n')
  const figures = []
  let current = null
  const flush = () => {
    if (!current) return
    const caption = current.parts.join(' ').replace(/\s+/g, ' ').trim()
    if (caption.length >= 20) figures.push({ index: figures.length + 1, label: current.label, caption: caption.slice(0, 1200) })
    current = null
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const heading = /^(fig(?:ure)?\.?\s*([0-9]+[a-z]?))\b[:.\s-]*(.*)$/i.exec(trimmed)
    if (heading) {
      flush()
      current = { label: `Figure ${heading[2]}`, parts: heading[3] ? [heading[3]] : [] }
      continue
    }
    if (current) {
      if (/^(table|references|supplementary)\b/i.test(trimmed)) { flush(); continue }
      if (current.parts.join(' ').length > 1400) { flush(); continue }
      current.parts.push(trimmed)
    }
    if (figures.length >= limit) break
  }
  flush()
  return figures.slice(0, limit)
}

/** 图注 → 图型/数据/模板/许愿文本。 */
export function classifyCaption(caption) {
  const text = String(caption || '')
  for (const rule of CHART_RULES) {
    if (rule.pattern.test(text)) {
      return buildBlueprint(rule, text)
    }
  }
  return buildBlueprint(CHART_FALLBACK, text)
}

function buildBlueprint(rule, caption) {
  const cleaned = ABBREVIATIONS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), String(caption || ''))
  const short = cleaned.length > 220 ? cleaned.slice(0, 220) + '…' : cleaned
  const wish = rule.id === 'unknown'
    ? `论文图注：${short}\n这张图没认出来：请先根据图注判断横轴/纵轴/分组，缺的话问我；然后给出计划并出同类型图。`
    : `参照论文里的「${rule.label}」做一张同类型图。\n原图注：${short}\n请反推需要的数据（${rule.needData}）、分组和统计方法；我还没给数据就先用已登记数据或给候选，最后用同图型出图。`
  return {
    chart: rule.id,
    chart_label_zh: rule.label,
    data_kind: rule.dataKind,
    template: rule.template,
    plotlab_chart: rule.plotlab,
    roles_hint: rule.roles,
    need_data: rule.needData,
    wish_text: wish,
    confidence: rule.id === 'unknown' ? 0 : 0.72,
  }
}

export const CHART_IDS = CHART_RULES.map((rule) => rule.id)
