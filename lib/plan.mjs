/**
 * dsh-bioflow — 任务计划与闸门（真拦）
 *
 * 三个硬设计决定里「闸门真拦」的落点：
 *   样本表未知 / counts 未验证 / 每组独立 n<2 / 设计完全混杂 /
 *   contrast 方向未定义 / 缺前置产物 → status=blocked + 逐条原因。
 *   零显著不是闸门（分析成功但没显著结果 → 放行，由 deliver 标记 zero_significant）。
 *
 * 本模块是纯函数：输入已登记的 dataset manifest + 模板 + 参数，输出可复现 plan。
 * 不做 IO、不启动引擎，方便单测。
 */

import { sha256Json, stableStringify, nowIso } from './store.mjs'

export const PLAN_SCHEMA_VERSION = 1
export const TEMPLATE_VERSION = 1

export const PLUGIN_IDS = ['geobulk', 'singlecell', 'spatial', 'metabolomics', 'plotlab', 'virtualcell']

export const DELIVERABLES = [
  'manifest.json',
  'design.tsv',
  'qc.tsv',
  'results/*.tsv',
  'figures/',
  'evidence.jsonl',
  'methods.md',
]

// 每条闸门对应的中文补救动作（UI 直接渲染成按钮；不带 CLI 命令）
const GATE_FIXES = {
  dataset_registered: ['重新登记数据文件（会自动算 sha256）', '检查文件是否被移动或修改'],
  sample_table: ['提供样本表（sample + group 两列即可）', '导入带分组的样本表'],
  sample_identity: ['修正样本 ID 映射', '切换矩阵行列方向后再试', '检查矩阵表头/首列是否被当成样本'],
  groups: ['在样本表里补 group 列', '改用带分组的数据'],
  contrast: ['选两组做对照', '指定哪组是实验组、哪组是对照'],
  replication: ['增加生物学重复（每组独立样本 ≥2）', '改用配对设计', '只做描述性出图（不做推断）'],
  design_confounded: ['在同一队列内比较', '换一个同时包含两组的队列', '只做描述性展示'],
  counts_verified: ['确认这是原始 counts', '确认这是 log/标准化表达', '只做描述性出图'],
  assay_supported: ['换与数据模态匹配的模板', '导入该模板需要的模态'],
  method_compatible: ['改用与该尺度匹配的统计方法', '转换尺度后重试'],
  prerequisites: ['先跑完前置步骤', '检查父 run 是否成功'],
  seed: ['设置随机种子'],
}

const GATE_TITLES = {
  dataset_registered: '数据已登记且哈希完整',
  sample_table: '样本表已知',
  sample_identity: '样本 ID 唯一且能对上矩阵列',
  groups: '分组存在且 ≥2 组',
  contrast: 'contrast 方向已定义',
  replication: '每组独立生物学重复 n≥2',
  design_confounded: '设计未完全混杂',
  counts_verified: '数据尺度已验证（counts / log 表达）',
  assay_supported: '数据类型与模板匹配',
  method_compatible: '统计方法与数据尺度匹配',
  prerequisites: '前置产物/父 run 可用',
  seed: '随机种子已固化',
}

function gate(id, status, detail, extra = {}) {
  return {
    id,
    title: GATE_TITLES[id] || id,
    status,
    blocking: status === 'fail' && extra.blocking !== false,
    detail,
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'blocking')),
  }
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && String(value) !== ''))]
}

function normalizeGroup(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function designSamples(dataset) {
  const design = (dataset && dataset.design) || {}
  return Array.isArray(design.samples) ? design.samples.filter(Boolean) : []
}

/** register 产出的 design.columns 是 {sample,group,donor,...} 映射，不保证是数组。 */
function designColumnNames(dataset) {
  const columns = (dataset && dataset.design && dataset.design.columns) || null
  if (Array.isArray(columns)) return columns.map((column) => String(column ?? '')).filter(Boolean)
  if (columns && typeof columns === 'object') return Object.values(columns).filter(Boolean).map((column) => String(column))
  return []
}

function sampleColumnName(sample) {
  return normalizeGroup(sample.sample_id ?? sample.id ?? sample.sample ?? sample.name)
}

function sampleGroup(sample) {
  return normalizeGroup(sample.group ?? sample.group_id ?? sample.condition)
}

function donorOf(sample) {
  const donor = sample.donor_id ?? sample.donor ?? sample.patient ?? sample.participant ?? sample.subject
  return normalizeGroup(donor) || sampleColumnName(sample)
}

function pairOf(sample) {
  return normalizeGroup(sample.pair_id ?? sample.pair ?? sample.paired_id)
}

function groupSummary(dataset) {
  const samples = designSamples(dataset)
  const groups = new Map()
  for (const sample of samples) {
    const group = sampleGroup(sample)
    if (!group) continue
    if (!groups.has(group)) groups.set(group, { group, samples: [], donors: new Set(), pairs: new Set() })
    const entry = groups.get(group)
    entry.samples.push(sampleColumnName(sample))
    entry.donors.add(donorOf(sample))
    const pair = pairOf(sample)
    if (pair) entry.pairs.add(pair)
  }
  return groups
}

function crossTab(samples, column) {
  const table = new Map()
  for (const sample of samples) {
    const group = sampleGroup(sample)
    const value = normalizeGroup(sample[column])
    if (!group || !value) continue
    if (!table.has(value)) table.set(value, new Map())
    const row = table.get(value)
    row.set(group, (row.get(group) || 0) + 1)
  }
  return table
}

/** 每个 level 是否只对应一个 group（完全可分 → 混杂）。 */
function perfectlySeparates(samples, column) {
  const table = crossTab(samples, column)
  if (table.size < 2) return { separates: false, detail: '只有一个水平，无混杂' , table }
  const levels = [...table.entries()]
  const singleGroupEach = levels.every(([, row]) => {
    const groups = [...row.keys()].filter((group) => (row.get(group) || 0) > 0)
    return groups.length === 1
  })
  return {
    separates: singleGroupEach,
    detail: levels.map(([level, row]) => `${level}:${[...row.entries()].map(([group, n]) => `${group}=${n}`).join('/')}`).join('；'),
    table,
  }
}

function selectPrimaryFile(dataset) {
  const files = Array.isArray(dataset && dataset.files) ? dataset.files : []
  if (!files.length) return null
  const scored = files.map((file) => {
    const name = String(file.name || file.path || '')
    let score = 0
    if (file.role === 'matrix') score += 100
    if (/series_matrix|matrix|expr|counts|expression/i.test(name)) score += 30
    if (/\.(csv|tsv|txt|xlsx|h5ad|h5|mtx)(\.gz)?$/i.test(name)) score += 10
    if (/\.pdf$|\.png$|\.jpg$/i.test(name)) score -= 100
    return { file, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored[0].score > 0 ? scored[0].file : files[0]
}

function datasetKind(dataset) {
  const declared = String((dataset && dataset.data_kind) || (dataset && dataset.assay) || '').toLowerCase()
  if (/scrna|single|10x|h5ad/.test(declared)) return 'scrna'
  if (/spatial|visium|stereo/.test(declared)) return 'spatial'
  if (/metabol/.test(declared)) return 'metabolomics'
  if (/bulk|rna_seq|microarray|array/.test(declared)) return 'bulk'
  const name = String((dataset && dataset.name) || '')
  if (/scrna|single|10x|h5ad/i.test(name)) return 'scrna'
  return 'unknown'
}

function methodCompatibility(dataset, method) {
  const scaleType = String(((dataset || {}).scale || {}).type || 'unknown').toLowerCase()
  const m = String(method || '').toLowerCase()
  if (!m) return { ok: false, detail: '未指定统计方法', needed: null }
  if (['deseq2', 'edger', 'deseq', 'edger_ql'].includes(m)) {
    if (scaleType === 'counts') return { ok: true, detail: `${m} 需要原始 counts，数据已声明 counts` }
    return { ok: false, detail: `${m} 需要原始 counts，数据尺度为 ${scaleType}（应改用 limma 或重新登记 counts）`, needed: 'counts' }
  }
  if (['limma', 'limma_voom', 'limma_trend', 'wilcoxon', 't_test'].includes(m)) {
    if (scaleType === 'counts') {
      return { ok: true, detail: `${m} 可用；counts 数据建议 limma-voom`, warning: true }
    }
    if (scaleType === 'log_expression') return { ok: true, detail: `${m} 与 log 表达尺度匹配` }
    return { ok: false, detail: `数据尺度未知（${scaleType}），无法证明 ${m} 前提`, needed: 'known' }
  }
  return { ok: true, detail: `未知方法 ${m}，交由插件自检` }
}

function pickMethod(dataset, requested) {
  if (requested) return String(requested)
  const scaleType = String(((dataset || {}).scale || {}).type || '').toLowerCase()
  if (scaleType === 'counts') return 'deseq2'
  if (scaleType === 'log_expression') return 'limma'
  return 'deseq2'
}

/**
 * 评估全部闸门。
 * @returns {{gates: Array, status: 'ready'|'blocked', blocking: Array}}
 */
export function evaluateGates({ dataset, template, params = {}, steps = [], parentRun = null, parentRunRecord = null }) {
  const gates = []
  const samples = designSamples(dataset)
  const groups = groupSummary(dataset)
  const groupNames = [...groups.keys()]
  const kind = datasetKind(dataset)
  const templateDef = TEMPLATES[template] || null
  const contrast = normalizeContrast(params)

  // 1. 数据登记 + 文件哈希
  if (!dataset) {
    gates.push(gate('dataset_registered', 'fail', '没有找到已登记的数据集（先 action=register）'))
  } else {
    const files = Array.isArray(dataset.files) ? dataset.files : []
    const missing = files.filter((file) => !file || !file.sha256)
    if (!files.length) gates.push(gate('dataset_registered', 'fail', '数据集 manifest 没有任何文件记录'))
    else if (missing.length) gates.push(gate('dataset_registered', 'fail', `${missing.length} 个文件缺少 sha256`))
    else gates.push(gate('dataset_registered', 'pass', `${files.length} 个文件均有 sha256；dataset_id=${dataset.dataset_id}`))
  }

  // 2. 样本表
  if (!samples.length) {
    gates.push(gate('sample_table', 'fail', '样本表未知：manifest 没有 design.samples（register 时提供 sample_sheet 或 samples）'))
  } else {
    gates.push(gate('sample_table', 'pass', `${samples.length} 个样本；列：${designColumnNames(dataset).join('、') || '—'}`))
  }

  // 3. 样本 ID 唯一 / 能对上矩阵列
  const ids = samples.map(sampleColumnName)
  const duplicates = unique(ids.filter((id, index) => ids.indexOf(id) !== index))
  const emptyIds = ids.filter((id) => !id).length
  const unresolved = (dataset && dataset.design && dataset.design.unresolved) || []
  if (duplicates.length || emptyIds) {
    gates.push(gate('sample_identity', 'fail', `样本 ID 重复：${duplicates.join('、') || '—'}；缺失 ID ${emptyIds} 个`, { duplicates }))
  } else if (unresolved.length) {
    gates.push(gate('sample_identity', 'fail', `样本表与矩阵列对不上：${unresolved.slice(0, 8).join('、')}`, { unresolved }))
  } else {
    gates.push(gate('sample_identity', 'pass', `${ids.length} 个样本 ID 唯一`))
  }

  // 4. 分组（模板可声明不需要：空间域/虚拟扰动/纯绘图）
  if (templateDef && templateDef.requires_groups === false) {
    const detail = groupNames.length
      ? `该模板不做组间比较，分组非必需（当前 ${groupNames.length} 组：${groupNames.join('、')}）`
      : '该模板不做组间比较，分组非必需'
    gates.push(gate('groups', 'pass', detail, { blocking: false }))
  } else if (!groupNames.length) {
    gates.push(gate('groups', 'fail', '没有任何样本带分组信息（group 列）'))
  } else if (groupNames.length < 2) {
    gates.push(gate('groups', 'fail', `只有 1 个分组（${groupNames[0]}），无法比较`))
  } else {
    gates.push(gate('groups', 'pass', `${groupNames.length} 组：${groupNames.join('、')}`))
  }

  // 5. contrast（模板可声明不需要：空间域/虚拟扰动/纯绘图没有对照方向）
  if (templateDef && templateDef.requires_contrast === false) {
    gates.push(gate('contrast', 'pass', '该模板不做组间差异比较，无需 contrast 方向', { blocking: false }))
  } else if (!contrast.ok) {
    gates.push(gate('contrast', 'fail', contrast.detail))
  } else if (groupNames.length && (!groupNames.includes(contrast.case) || !groupNames.includes(contrast.control))) {
    gates.push(gate('contrast', 'fail', `contrast 的组不在数据里：case=${contrast.case}、control=${contrast.control}；实际分组 ${groupNames.join('、')}`))
  } else {
    gates.push(gate('contrast', 'pass', `logFC = ${contrast.case} - ${contrast.control}（direction=${contrast.direction}）`))
  }

  // 6. 生物学重复（模板可声明不需要：空间域/虚拟扰动/纯绘图）
  if (templateDef && templateDef.requires_replication === false) {
    gates.push(gate('replication', 'pass', '该模板不做组间推断，生物学重复数不构成闸门', { blocking: false }))
  } else if (samples.length) {
    const perGroup = {}
    for (const [name, entry] of groups) perGroup[name] = { samples: entry.samples.length, donors: entry.donors.size }
    const independent = (name) => {
      const entry = groups.get(name)
      if (!entry) return 0
      return dataset.design && dataset.design.donor_column ? entry.donors.size : entry.samples.length
    }
    if (dataset.design && dataset.design.paired) {
      const relevant = groupNames.filter((name) => !contrast.ok || name === contrast.case || name === contrast.control)
      const pairs = new Set()
      for (const name of relevant) {
        for (const pair of (groups.get(name) || { pairs: new Set() }).pairs) pairs.add(pair)
      }
      let spanning = 0
      if (contrast.ok) {
        const casePairs = new Set()
        for (const sample of samples) {
          if (sampleGroup(sample) !== contrast.case) continue
          const pair = pairOf(sample)
          if (pair) casePairs.add(pair)
        }
        for (const sample of samples) {
          if (sampleGroup(sample) !== contrast.control) continue
          const pair = pairOf(sample)
          if (pair && casePairs.has(pair)) spanning += 1
        }
      }
      if (spanning < 2) {
        gates.push(gate('replication', 'fail', `配对设计要求 ≥2 对同时覆盖 case/control 的配对样本，实际 ${spanning} 对`))
      } else {
        gates.push(gate('replication', 'pass', `配对设计：${spanning} 对；每组独立 n：${JSON.stringify(perGroup)}`))
      }
    } else {
      const needed = contrast.ok ? [contrast.case, contrast.control] : groupNames
      const weak = needed
        .map((name) => ({ name, n: independent(name) }))
        .filter((item) => item.n < 2)
      if (weak.length) {
        gates.push(gate('replication', 'fail', `每组独立生物学重复 n≥2 不满足：${weak.map((item) => `${item.name}=${item.n}`).join('、')}`, { per_group: perGroup }))
      } else {
        gates.push(gate('replication', 'pass', `每组独立 n：${needed.map((name) => `${name}=${independent(name)}`).join('、')}（按 ${dataset.design && dataset.design.donor_column ? '供体' : '样本'} 计）`, { per_group: perGroup }))
      }
    }
  }

  // 7. 完全混杂
  const confoundProblems = []
  const design = (dataset && dataset.design) || {}
  if (samples.length >= 2) {
    if (design.batch_column) {
      const result = perfectlySeparates(samples, design.batch_column)
      if (result.separates) confoundProblems.push(`分组与批次完全混杂（${design.batch_column}：${result.detail}）`)
    }
    if (design.paired && design.donor_column) {
      const donorGroups = new Map()
      for (const sample of samples) {
        const donor = donorOf(sample)
        if (!donorGroups.has(donor)) donorGroups.set(donor, new Set())
        donorGroups.get(donor).add(sampleGroup(sample))
      }
      const spanning = [...donorGroups.values()].filter((set) => set.size > 1).length
      if (spanning === 0) confoundProblems.push(`声明了配对设计，但没有一个供体同时出现在两个组（n=${donorGroups.size} 个供体各只属于一组）`)
    }
    const covariates = Array.isArray(params.covariates) ? params.covariates : []
    for (const column of covariates) {
      const result = perfectlySeparates(samples, column)
      if (result.separates) confoundProblems.push(`协变量 ${column} 与分组完全共线（${result.detail}），模型不可识别`)
    }
    if (groupNames.length > 1 && samples.every((sample) => sampleGroup(sample) === sampleGroup(samples[0]))) {
      confoundProblems.push('所有样本同组')
    }
  }
  if (confoundProblems.length) gates.push(gate('design_confounded', 'fail', confoundProblems.join('；')))
  else if (samples.length) gates.push(gate('design_confounded', 'pass', '未检测到分组×批次/协变量完全共线'))

  // 8. 尺度验证（模板声明 requires_scale=[] 表示不做推断/不依赖表达尺度）
  const scale = (dataset && dataset.scale) || {}
  const scaleType = String(scale.type || 'unknown').toLowerCase()
  const requiresScale = templateDef && Array.isArray(templateDef.requires_scale)
    ? templateDef.requires_scale
    : ['counts', 'log_expression']
  if (requiresScale.length === 0) {
    gates.push(gate('counts_verified', 'pass', '该模板只做描述性展示/不依赖表达尺度，尺度非闸门', { blocking: false }))
  } else if (scale.verified === true && requiresScale.includes(scaleType)) {
    gates.push(gate('counts_verified', 'pass', `已声明 ${scaleType} 尺度并通过验证（verified=true，依据：${scale.evidence || '用户声明'}）`))
  } else if (scale.verified === true) {
    gates.push(gate('counts_verified', 'fail', `数据尺度 ${scaleType} 不在模板允许范围（${requiresScale.join('/')}）：需要先转换到可比较尺度`))
  } else {
    gates.push(gate('counts_verified', 'fail', `数据尺度未验证：type=${scaleType}、verified=${Boolean(scale.verified)}。派生推断步骤被阻止（register 时显式声明 scale 并 verified=true）`))
  }

  // 9. 数据类型 / 方法匹配
  if (templateDef) {
    if (templateDef.requires_kind.includes(kind) || templateDef.requires_kind.includes('any')) {
      gates.push(gate('assay_supported', 'pass', `数据类型 ${kind} 与模板 ${template} 匹配`))
    } else {
      gates.push(gate('assay_supported', 'fail', `模板 ${template} 需要 ${templateDef.requires_kind.join('/')} 数据，当前 ${kind}`))
    }
  }
  const method = pickMethod(dataset, params.method)
  if (template === 'bulk-two-group') {
    const compatible = methodCompatibility(dataset, method)
    gates.push(gate('method_compatible', compatible.ok ? 'pass' : 'fail', compatible.detail))
  } else if (method) {
    gates.push(gate('method_compatible', 'pass', `方法 ${method}`))
  }

  // 10. 前置产物 / 父 run
  const prerequisiteProblems = []
  const stepIds = new Set()
  for (const step of steps) {
    const requires = Array.isArray(step.requires) ? step.requires : []
    for (const need of requires) if (!stepIds.has(need)) prerequisiteProblems.push(`step ${step.step_id} 依赖的 ${need} 不在它之前`)
    stepIds.add(step.step_id)
  }
  if (parentRun) {
    if (!parentRunRecord) prerequisiteProblems.push(`父 run ${parentRun} 不存在`)
    else if (!['succeeded', 'partial'].includes(parentRunRecord.status)) {
      prerequisiteProblems.push(`父 run ${parentRun} 状态 ${parentRunRecord.status}，不能作为前置产物`)
    }
  }
  if (prerequisiteProblems.length) gates.push(gate('prerequisites', 'fail', prerequisiteProblems.join('；')))
  else gates.push(gate('prerequisites', 'pass', parentRun ? `父 run ${parentRun} 可用` : '模板步骤顺序满足依赖'))

  // 11. 种子
  const seed = Number.isInteger(params.seed) ? params.seed : 0
  gates.push(gate('seed', 'pass', `seed=${seed}（写入计划与幂等键）`))

  const withFixes = gates.map((item) => (GATE_FIXES[item.id] ? { ...item, fixes: GATE_FIXES[item.id] } : item))
  const blocking = withFixes.filter((item) => item.blocking)
  return { gates: withFixes, status: blocking.length ? 'blocked' : 'ready', blocking }
}

function normalizeContrast(params = {}) {
  const raw = params.contrast || params.comparison || null
  if (!raw) {
    return { ok: false, detail: 'contrast 未定义：需要 {case, control} 明确比较方向（如 {"case":"tumor","control":"normal"}）' }
  }
  if (Array.isArray(raw)) {
    return { ok: false, detail: 'contrast 不能用无序数组（方向未定义），请写成 {case, control}' }
  }
  if (typeof raw !== 'object') return { ok: false, detail: 'contrast 必须是 {case, control} 对象' }
  const caseGroup = normalizeGroup(raw.case ?? raw.group1 ?? raw.treatment ?? raw.case_group)
  const controlGroup = normalizeGroup(raw.control ?? raw.group2 ?? raw.reference ?? raw.control_group)
  const direction = String(raw.direction || params.direction || 'case_minus_control')
  if (!caseGroup || !controlGroup) {
    return { ok: false, detail: 'contrast 需要同时给出 case 与 control（方向必须明确）' }
  }
  if (caseGroup === controlGroup) return { ok: false, detail: `contrast 两侧都是 ${caseGroup}，方向无效` }
  if (!['case_minus_control', 'control_minus_case', 'log2fc_case_vs_control'].includes(direction)) {
    return { ok: false, detail: `未知 direction=${direction}（允许 case_minus_control / control_minus_case）` }
  }
  return { ok: true, case: caseGroup, control: controlGroup, direction, contrast_id: `${caseGroup}_vs_${controlGroup}` }
}

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

function buildBulkSteps(dataset, params, gates) {
  const design = dataset.design || {}
  const contrast = normalizeContrast(params)
  const seed = Number.isInteger(params.seed) ? params.seed : 0
  const method = pickMethod(dataset, params.method)
  const primary = selectPrimaryFile(dataset)
  const openKind = params.data_kind === 'matrix' ? 'matrix' : 'tidy'
  const openParams = {
    path: primary ? primary.path : undefined,
    name: dataset.name,
    transpose: (String((dataset && dataset.data_kind) || '') === 'tidy' ? false : Boolean(dataset.transpose)),
    sample_sheet: dataset.sample_sheet ? dataset.sample_sheet.path : undefined,
    clinical: dataset.clinical ? dataset.clinical.path : undefined,
    species: dataset.species || 'auto',
    data_format: dataset.data_format || 'auto',
  }
  for (const key of Object.keys(openParams)) if (openParams[key] === undefined) delete openParams[key]

  const samplesUpdate = designSamples(dataset).map((sample) => ({
    id: sampleColumnName(sample),
    name: sample.display_name || sampleColumnName(sample),
    group: sampleGroup(sample),
  }))
  const deParams = {
    group_col: design.group_column || 'group',
    case: contrast.ok ? contrast.case : undefined,
    control: contrast.ok ? contrast.control : undefined,
    paired: Boolean(design.paired),
    covariates: Array.isArray(params.covariates) ? params.covariates : [],
    method,
    seed,
  }
  for (const key of Object.keys(deParams)) if (deParams[key] === undefined) delete deParams[key]

  return [
    {
      step_id: 'open',
      plugin: 'geobulk',
      action: 'open',
      params: openParams,
      deliver: { kind: 'dataset' },
      timeout_ms: 20 * 60 * 1000,
      label: '导入数据到 bulk 引擎',
    },
    {
      step_id: 'design',
      plugin: 'geobulk',
      action: 'samples',
      params: { op: 'update', samples: samplesUpdate, groups: [...groupSummary(dataset).keys()] },
      deliver: { kind: 'design' },
      requires: ['open'],
      label: '写入样本分组',
    },
    {
      step_id: 'qc',
      plugin: 'geobulk',
      action: 'run',
      params: { step: 'qc', params: {} },
      deliver: { kind: 'qc' },
      requires: ['design'],
      timeout_ms: 30 * 60 * 1000,
      label: 'QC 与样本质控',
    },
    {
      step_id: 'filter',
      plugin: 'geobulk',
      action: 'run',
      params: { step: 'filter', params: {} },
      deliver: { kind: 'filter' },
      requires: ['qc'],
      timeout_ms: 30 * 60 * 1000,
      label: '低表达过滤',
    },
    {
      step_id: 'normalize',
      plugin: 'geobulk',
      action: 'run',
      params: { step: 'normalize', params: {} },
      deliver: { kind: 'normalize' },
      requires: ['filter'],
      timeout_ms: 30 * 60 * 1000,
      label: '标准化',
    },
    {
      step_id: 'de',
      plugin: 'geobulk',
      action: 'run',
      params: { step: 'de', params: deParams },
      deliver: { kind: 'de', contrast: true },
      requires: ['normalize'],
      timeout_ms: 60 * 60 * 1000,
      label: '差异表达',
    },
    {
      step_id: 'enrich',
      plugin: 'geobulk',
      action: 'run',
      params: { step: 'enrich', params: { db: params.enrich_db || 'kegg' } },
      deliver: { kind: 'enrich', optional: true },
      requires: ['de'],
      optional: true,
      timeout_ms: 30 * 60 * 1000,
      label: '功能富集',
    },
  ]
}

function buildSingleCellSteps(dataset, params, gates) {
  const design = dataset.design || {}
  const contrast = normalizeContrast(params)
  const seed = Number.isInteger(params.seed) ? params.seed : 0
  const primary = selectPrimaryFile(dataset)
  const openParams = {
    path: primary ? primary.path : undefined,
    paths: Array.isArray(dataset.files) && dataset.files.length > 1 && dataset.merge_files ? dataset.files.map((file) => file.path) : undefined,
    name: dataset.name,
    transpose: (String((dataset && dataset.data_kind) || '') === 'tidy' ? false : Boolean(dataset.transpose)),
    data_format: dataset.data_format || 'auto',
    species: dataset.species || 'auto',
  }
  for (const key of Object.keys(openParams)) if (openParams[key] === undefined) delete openParams[key]
  const cellTypeColumn = String(params.cell_type_column || 'cell_type')
  const groupColumn = design.group_column || 'group'
  const donorColumn = design.donor_column || ''
  return [
    {
      step_id: 'open',
      plugin: 'singlecell',
      action: 'open',
      params: openParams,
      deliver: { kind: 'dataset' },
      timeout_ms: 30 * 60 * 1000,
      label: '导入单细胞数据',
    },
    {
      step_id: 'design',
      plugin: 'singlecell',
      action: 'samples',
      params: {
        op: 'update',
        samples: designSamples(dataset).map((sample) => ({
          id: sample.sample_id || sample.file || sampleColumnName(sample),
          name: sample.display_name || sampleColumnName(sample),
          group: sampleGroup(sample),
        })),
        groups: [...groupSummary(dataset).keys()],
      },
      deliver: { kind: 'design' },
      requires: ['open'],
      label: '写入样本分组',
    },
    {
      step_id: 'qc',
      plugin: 'singlecell',
      action: 'run',
      params: { step: 'qc', params: {} },
      deliver: { kind: 'qc' },
      requires: ['design'],
      timeout_ms: 30 * 60 * 1000,
      label: '单细胞 QC',
    },
    {
      step_id: 'filter',
      plugin: 'singlecell',
      action: 'run',
      params: { step: 'filter', params: {} },
      deliver: { kind: 'filter' },
      requires: ['qc'],
      label: '过滤低质量细胞',
    },
    {
      step_id: 'normalize',
      plugin: 'singlecell',
      action: 'run',
      params: { step: 'normalize', params: {} },
      deliver: { kind: 'normalize' },
      requires: ['filter'],
      label: '标准化',
    },
    {
      step_id: 'hvg',
      plugin: 'singlecell',
      action: 'run',
      params: { step: 'hvg', params: { n_top_genes: Number(params.n_top_genes || 2000) } },
      deliver: { kind: 'hvg' },
      requires: ['normalize'],
      timeout_ms: 30 * 60 * 1000,
      label: '高变基因',
    },
    {
      step_id: 'pca',
      plugin: 'singlecell',
      action: 'run',
      params: { step: 'pca', params: { n_pcs: Number(params.n_pcs || 30) } },
      deliver: { kind: 'pca' },
      requires: ['hvg'],
      timeout_ms: 30 * 60 * 1000,
      label: 'PCA',
    },
    {
      step_id: 'neighbors',
      plugin: 'singlecell',
      action: 'run',
      params: { step: 'neighbors', params: { n_neighbors: Number(params.n_neighbors || 15) } },
      deliver: { kind: 'neighbors' },
      requires: ['pca'],
      timeout_ms: 30 * 60 * 1000,
      label: '邻接图',
    },
    {
      step_id: 'cluster',
      plugin: 'singlecell',
      action: 'run',
      params: { step: 'cluster', params: { resolution: params.resolution ?? 0.8 } },
      deliver: { kind: 'cluster' },
      requires: ['neighbors'],
      timeout_ms: 30 * 60 * 1000,
      label: '聚类',
    },
    {
      step_id: 'embed',
      plugin: 'singlecell',
      action: 'run',
      params: { step: 'embed', params: { layout: 'umap' } },
      deliver: { kind: 'embed' },
      requires: ['cluster'],
      optional: true,
      label: '二维嵌入',
    },
    {
      step_id: 'composition',
      plugin: 'singlecell',
      action: 'analysis',
      params: {
        analysis: 'proportion_test',
        params: {
          group: groupColumn,
          cell_type: cellTypeColumn,
          min_cells: Number(params.min_cells || 10),
          // 明确所选两组与目标细胞类型；引擎暂不支持只比两组时，计划里会写清限制
          group1: contrast.ok ? contrast.case : undefined,
          group2: contrast.ok ? contrast.control : undefined,
          target_cell_type: params.cell_type || undefined,
          denominator: params.denominator || 'all_cells',
        },
      },
      deliver: { kind: 'composition', contrast: true },
      requires: ['cluster'],
      optional: true,
      timeout_ms: 30 * 60 * 1000,
      label: '细胞类型比例差异（样本层）',
    },
    ...(donorColumn ? [{
      step_id: 'pseudobulk',
      plugin: 'singlecell',
      action: 'analysis',
      params: {
        analysis: 'de_group',
        params: {
          group: groupColumn,
          cell_type: cellTypeColumn,
          group1: contrast.ok ? contrast.case : undefined,
          group2: contrast.ok ? contrast.control : undefined,
          unit: donorColumn ? 'donor' : 'cell',
          donor: donorColumn || undefined,
          donor_min_cells: Number(params.donor_min_cells || 3),
          top_n: Number(params.top_n || 50),
        },
      },
      deliver: { kind: 'pseudobulk', contrast: true },
      requires: ['cluster'],
      optional: true,
      timeout_ms: 60 * 60 * 1000,
      label: '同细胞类型组间差异（供体 pseudobulk）',
    }] : []),
  ]
}

// ---------------------------------------------------------------------------
// 空间 / 代谢 / 虚拟细胞 / 绘图：把另外四个工作台也接进大门口
//
// 四个模板与上面两个同构：每步就是 {plugin, action, params}，透传给对应插件
// 引擎（bioflow 不重算任何统计）。只有第一个 open 步骤把登记的数据导入该插件
// 的 run 级临时 worker；worker 在 run 结束时统一 dispose。
// ---------------------------------------------------------------------------

/** 空间转录组：QC → 过滤 → 标准化 → 聚类 → 空间高变基因 → 空间域 → 图。 */
function buildSpatialSteps(dataset, params, gates) {
  const design = dataset.design || {}
  const primary = selectPrimaryFile(dataset)
  const openParams = {
    path: primary ? primary.path : undefined,
    name: dataset.name,
    data_format: dataset.data_format || 'auto',
    species: dataset.species || 'auto',
    transpose: (String((dataset && dataset.data_kind) || '') === 'tidy' ? false : Boolean(dataset.transpose)),
    sample_sheet: dataset.sample_sheet ? dataset.sample_sheet.path : undefined,
  }
  for (const key of Object.keys(openParams)) if (openParams[key] === undefined) delete openParams[key]
  const samples = designSamples(dataset)
  const steps = [
    {
      step_id: 'open',
      plugin: 'spatial',
      action: 'open',
      params: openParams,
      deliver: { kind: 'dataset' },
      timeout_ms: 30 * 60 * 1000,
      label: '导入空间数据',
    },
  ]
  if (samples.length) {
    steps.push({
      step_id: 'design',
      plugin: 'spatial',
      action: 'samples',
      params: {
        op: 'update',
        samples: samples.map((sample) => ({
          id: sample.sample_id || sample.file || sampleColumnName(sample),
          name: sample.display_name || sampleColumnName(sample),
          group: sampleGroup(sample),
        })),
        groups: [...groupSummary(dataset).keys()],
      },
      deliver: { kind: 'design' },
      requires: ['open'],
      label: '写入切片/样本分组',
    })
  }
  const afterDesign = samples.length ? 'design' : 'open'
  steps.push(
    {
      step_id: 'qc',
      plugin: 'spatial',
      action: 'run',
      params: { step: 'qc', params: {} },
      deliver: { kind: 'qc' },
      requires: [afterDesign],
      timeout_ms: 30 * 60 * 1000,
      label: '空间 QC',
    },
    {
      step_id: 'filter',
      plugin: 'spatial',
      action: 'run',
      params: { step: 'filter', params: {} },
      deliver: { kind: 'filter' },
      requires: ['qc'],
      label: '过滤低质量 spot',
    },
    {
      step_id: 'normalize',
      plugin: 'spatial',
      action: 'run',
      params: { step: 'normalize', params: {} },
      deliver: { kind: 'normalize' },
      requires: ['filter'],
      label: '标准化',
    },
    {
      step_id: 'hvg',
      plugin: 'spatial',
      action: 'run',
      params: { step: 'hvg', params: { n_top_genes: Number(params.n_hvg ?? 2000) } },
      deliver: { kind: 'hvg' },
      requires: ['normalize'],
      timeout_ms: 30 * 60 * 1000,
      label: '高变基因',
    },
    {
      step_id: 'pca',
      plugin: 'spatial',
      action: 'run',
      params: { step: 'pca', params: { n_pcs: Number(params.n_pcs || 30) } },
      deliver: { kind: 'pca' },
      requires: ['hvg'],
      timeout_ms: 30 * 60 * 1000,
      label: 'PCA',
    },
    {
      step_id: 'neighbors',
      plugin: 'spatial',
      action: 'run',
      params: { step: 'neighbors', params: {} },
      deliver: { kind: 'neighbors' },
      requires: ['pca'],
      timeout_ms: 30 * 60 * 1000,
      label: '空间邻接图',
    },
    {
      step_id: 'cluster',
      plugin: 'spatial',
      action: 'run',
      params: { step: 'cluster', params: { resolution: Number(params.resolution ?? 1.0) } },
      deliver: { kind: 'cluster' },
      requires: ['neighbors'],
      timeout_ms: 30 * 60 * 1000,
      label: '空间聚类',
    },
    {
      step_id: 'svg',
      plugin: 'spatial',
      action: 'run',
      params: { step: 'svg', params: { n_top: Number(params.n_svg ?? 2000) } },
      deliver: { kind: 'svg' },
      requires: ['normalize'],
      optional: true,
      timeout_ms: 30 * 60 * 1000,
      label: "空间高变基因（Moran's I）",
    },
    {
      step_id: 'domains',
      plugin: 'spatial',
      action: 'run',
      params: { step: 'domains', params: { n_domains: Number(params.n_domains ?? 6) } },
      deliver: { kind: 'domains' },
      requires: ['cluster'],
      optional: true,
      timeout_ms: 30 * 60 * 1000,
      label: '空间域',
    },
    {
      step_id: 'plot_domain',
      plugin: 'spatial',
      action: 'plot',
      params: { kind: 'domain_map' },
      deliver: { kind: 'figure' },
      requires: ['cluster'],
      optional: true,
      label: '空间域图',
    },
    {
      step_id: 'plot_svg',
      plugin: 'spatial',
      action: 'plot',
      params: { kind: 'svg_map' },
      deliver: { kind: 'figure' },
      requires: ['svg'],
      optional: true,
      label: '空间高变基因图',
    },
    {
      step_id: 'audit',
      plugin: 'spatial',
      action: 'audit',
      params: {},
      deliver: { kind: 'audit' },
      requires: ['cluster'],
      optional: true,
      label: '空间自检',
    },
  )
  return steps
}

/** 代谢组：QC → 过滤 → 补缺 → 归一化 → 变换 → PCA → PLS-DA → 差异 → 富集 → 标志物 → 图。 */
function buildMetabolomicsSteps(dataset, params, gates) {
  const design = dataset.design || {}
  const contrast = normalizeContrast(params)
  const primary = selectPrimaryFile(dataset)
  const groupColumn = design.group_column || 'group'
  // 注意：这里**故意不传 group_col**。dsh-metabolomics 的 mb_registry.build_dataset
  // （lib/mb_registry.py:1483）在 group_col 存在时会把 DataFrame 属性当函数调，抛
  // TypeError: 'DataFrame' object is not callable —— 这是插件侧 bug，bioflow 不修改它，
  // 改为在下一步 samples(op=update) 里写分组（同样能建立 dataset.group_key）。
  const openParams = {
    path: primary ? primary.path : undefined,
    name: dataset.name,
    data_format: dataset.data_format || 'auto',
    transpose: (String((dataset && dataset.data_kind) || '') === 'tidy' ? false : Boolean(dataset.transpose)),
    sample_sheet: dataset.sample_sheet ? dataset.sample_sheet.path : undefined,
    sheet: dataset.sheet || undefined,
  }
  for (const key of Object.keys(openParams)) if (openParams[key] === undefined) delete openParams[key]
  const samples = designSamples(dataset)
  // dsh-metabolomics 的 de 只认 limma/welch/wilcoxon（传 auto 会被判「未知方法」），
  // 所以这里不写 method 就让它用引擎默认，只有用户显式给了受支持方法才透传。
  const deMethod = ['limma', 'welch', 'wilcoxon'].includes(String(params.method || '').toLowerCase())
    ? String(params.method).toLowerCase()
    : undefined
  const deParams = {
    group_col: groupColumn,
    case: contrast.ok ? contrast.case : undefined,
    control: contrast.ok ? contrast.control : undefined,
    method: deMethod,
  }
  for (const key of Object.keys(deParams)) if (deParams[key] === undefined) delete deParams[key]
  const steps = [
    {
      step_id: 'open',
      plugin: 'metabolomics',
      action: 'open',
      params: openParams,
      deliver: { kind: 'dataset' },
      timeout_ms: 30 * 60 * 1000,
      label: '导入代谢特征表',
    },
  ]
  if (samples.length) {
    steps.push({
      step_id: 'design',
      plugin: 'metabolomics',
      action: 'samples',
      params: {
        op: 'update',
        samples: samples.map((sample) => ({
          id: sampleColumnName(sample),
          name: sample.display_name || sampleColumnName(sample),
          group: sampleGroup(sample),
        })),
        groups: [...groupSummary(dataset).keys()],
      },
      deliver: { kind: 'design' },
      requires: ['open'],
      label: '写入样本分组',
    })
  }
  const prev = samples.length ? 'design' : 'open'
  const chain = ['qc', 'filter', 'impute', 'normalize', 'transform', 'pca']
  let requires = prev
  for (const step of chain) {
    steps.push({
      step_id: step,
      plugin: 'metabolomics',
      action: 'run',
      params: { step, params: {} },
      deliver: { kind: step },
      requires: [requires],
      optional: ['impute', 'transform', 'pca'].includes(step),
      timeout_ms: 30 * 60 * 1000,
      label: `代谢流程 ${step}`,
    })
    requires = step
  }
  steps.push(
    {
      step_id: 'plsda',
      plugin: 'metabolomics',
      action: 'run',
      params: { step: 'plsda', params: { n_comp: Number(params.n_comp ?? 2) } },
      deliver: { kind: 'plsda' },
      requires: ['pca'],
      optional: true,
      timeout_ms: 30 * 60 * 1000,
      label: 'PLS-DA / OPLS-DA',
    },
    {
      step_id: 'de',
      plugin: 'metabolomics',
      action: 'run',
      params: { step: 'de', params: deParams },
      deliver: { kind: 'de', contrast: true },
      requires: ['normalize'],
      timeout_ms: 30 * 60 * 1000,
      label: '差异代谢物',
    },
    {
      step_id: 'enrich',
      plugin: 'metabolomics',
      action: 'run',
      params: { step: 'enrich', params: { db: params.enrich_db || 'kegg' } },
      deliver: { kind: 'enrich', contrast: true },
      requires: ['de'],
      optional: true,
      timeout_ms: 30 * 60 * 1000,
      label: '通路富集（Mummichog/ORA）',
    },
    {
      step_id: 'biomarker',
      plugin: 'metabolomics',
      action: 'run',
      params: { step: 'biomarker', params: { n_features: Number(params.n_features ?? 20) } },
      deliver: { kind: 'biomarker' },
      requires: ['de'],
      optional: true,
      timeout_ms: 30 * 60 * 1000,
      label: '标志物筛选',
    },
    {
      step_id: 'plot_vip',
      plugin: 'metabolomics',
      action: 'plot',
      params: { kind: 'vip_bar' },
      deliver: { kind: 'figure' },
      requires: ['plsda'],
      optional: true,
      label: 'VIP 图',
    },
    {
      step_id: 'plot_volcano',
      plugin: 'metabolomics',
      action: 'plot',
      params: { kind: 'volcano_de' },
      deliver: { kind: 'figure' },
      requires: ['de'],
      optional: true,
      label: '差异火山图',
    },
    {
      step_id: 'audit',
      plugin: 'metabolomics',
      action: 'audit',
      params: {},
      deliver: { kind: 'audit' },
      requires: ['de'],
      optional: true,
      label: '代谢自检',
    },
  )
  return steps
}

/** 虚拟细胞：QC → 状态 → GRN → 虚拟扰动 → 图。全部产物标 model_prediction。 */
function buildVirtualcellSteps(dataset, params, gates) {
  const primary = selectPrimaryFile(dataset)
  const openParams = {
    path: primary ? primary.path : undefined,
    name: dataset.name,
    data_format: dataset.data_format || 'auto',
    transpose: (String((dataset && dataset.data_kind) || '') === 'tidy' ? false : Boolean(dataset.transpose)),
  }
  for (const key of Object.keys(openParams)) if (openParams[key] === undefined) delete openParams[key]
  const gene = params.gene || null
  const mode = params.mode || 'knockout'
  const strength = Number.isFinite(Number(params.strength)) ? Number(params.strength) : 1
  return [
    {
      step_id: 'open',
      plugin: 'virtualcell',
      action: 'open',
      params: openParams,
      deliver: { kind: 'dataset' },
      evidence_kind: 'model_prediction',
      timeout_ms: 30 * 60 * 1000,
      label: '导入单细胞表达谱到虚拟细胞引擎',
    },
    {
      step_id: 'qc',
      plugin: 'virtualcell',
      action: 'run',
      params: { step: 'qc', params: {} },
      deliver: { kind: 'qc' },
      evidence_kind: 'descriptive',
      requires: ['open'],
      timeout_ms: 30 * 60 * 1000,
      label: '虚拟细胞 QC',
    },
    {
      step_id: 'state',
      plugin: 'virtualcell',
      action: 'run',
      params: { step: 'state', params: { n_hvg: Number(params.n_hvg ?? 2000), resolution: Number(params.resolution ?? 0.8) } },
      deliver: { kind: 'state' },
      evidence_kind: 'descriptive',
      requires: ['qc'],
      timeout_ms: 60 * 60 * 1000,
      label: '细胞状态表征',
    },
    {
      step_id: 'grn',
      plugin: 'virtualcell',
      action: 'run',
      params: { step: 'grn', params: {} },
      deliver: { kind: 'grn' },
      evidence_kind: 'model_prediction',
      requires: ['state'],
      timeout_ms: 60 * 60 * 1000,
      label: '基因调控网络推断',
    },
    {
      step_id: 'perturb',
      plugin: 'virtualcell',
      action: 'run',
      params: { step: 'perturb', params: { gene: gene || undefined, mode, strength } },
      deliver: { kind: 'perturb', evidence_kind: 'model_prediction' },
      evidence_kind: 'model_prediction',
      requires: ['grn'],
      timeout_ms: 60 * 60 * 1000,
      label: '虚拟扰动（in silico）',
    },
    {
      step_id: 'plot_perturb',
      plugin: 'virtualcell',
      action: 'plot',
      params: { kind: 'perturb_waterfall' },
      deliver: { kind: 'figure' },
      evidence_kind: 'model_prediction',
      requires: ['perturb'],
      optional: true,
      label: '扰动响应图',
    },
    {
      step_id: 'plot_grn',
      plugin: 'virtualcell',
      action: 'plot',
      params: { kind: 'grn_hub_bar' },
      deliver: { kind: 'figure' },
      evidence_kind: 'model_prediction',
      requires: ['grn'],
      optional: true,
      label: 'GRN hub 图',
    },
    {
      step_id: 'insight',
      plugin: 'virtualcell',
      action: 'run',
      params: { step: 'insight', params: {} },
      deliver: { kind: 'insight' },
      evidence_kind: 'model_prediction',
      requires: ['perturb'],
      optional: true,
      label: '智能分析（结论+靶点+局限）',
    },
  ]
}

/** 绘图：登记一份 tidy 表 → plotlab 出图 + 可复现代码（描述性，不做推断）。 */
function buildPlotlabSteps(dataset, params, gates) {
  const primary = selectPrimaryFile(dataset)
  const chart = String(params.chart || 'bar')
  const openKind = params.data_kind === 'matrix' ? 'matrix' : 'tidy'
  const openParams = {
    path: primary ? primary.path : undefined,
    name: dataset.name,
    data_format: dataset.data_format || 'auto',
    kind: openKind,
    sheet: dataset.sheet || undefined,
    transpose: (String((dataset && dataset.data_kind) || '') === 'tidy' ? false : Boolean(dataset.transpose)),
    sample_sheet: dataset.sample_sheet ? dataset.sample_sheet.path : undefined,
  }
  for (const key of Object.keys(openParams)) if (openParams[key] === undefined) delete openParams[key]
  return [
    {
      step_id: 'open',
      plugin: 'plotlab',
      action: 'open',
      params: openParams,
      deliver: { kind: 'dataset' },
      timeout_ms: 20 * 60 * 1000,
      label: '导入绘图数据',
    },
    {
      step_id: 'plot',
      plugin: 'plotlab',
      action: 'plot',
      params: {
        chart,
        params: params.chart_params && typeof params.chart_params === 'object' ? params.chart_params : {},
        style: params.style && typeof params.style === 'object' ? params.style : {},
        roles: params.roles && typeof params.roles === 'object' ? params.roles : {},
      },
      deliver: { kind: 'figure' },
      requires: ['open'],
      timeout_ms: 30 * 60 * 1000,
      label: `出图（${chart}）`,
    },
    {
      step_id: 'code',
      plugin: 'plotlab',
      action: 'code',
      params: { what: 'plot' },
      deliver: { kind: 'code' },
      requires: ['plot'],
      optional: true,
      label: '可复现绘图代码',
    },
  ]
}

export const TEMPLATES = {
  'bulk-two-group': {
    id: 'bulk-two-group',
    version: TEMPLATE_VERSION,
    title: 'GEO/Bulk 两组或配对差异 + 富集',
    description: '导入已登记 bulk 矩阵 → 写入样本分组 → QC → 差异表达（contrast 方向明确）→ 富集。输出 design/qc/全量结果表/图/证据。',
    data_kind: 'bulk',
    requires_kind: ['bulk'],
    requires_scale: ['counts', 'log_expression'],
    default_params: { method: null, paired: false, covariates: [], enrich_db: 'kegg', seed: 0 },
    param_schema: {
      contrast: { type: 'object', required: true, description: '{case, control} 明确方向；logFC = case - control' },
      method: { type: 'string', enum: ['deseq2', 'edger', 'limma', 'limma_voom'], description: '缺省按尺度选：counts→deseq2，log→limma' },
      paired: { type: 'boolean', description: '配对设计（需 sample 表有 pair_id）' },
      covariates: { type: 'array', description: '协变量列名（进入设计公式，并与分组做共线性检查）' },
      enrich_db: { type: 'string', description: '富集数据库（kegg/go/…，由 geobulk 支持为准）' },
      seed: { type: 'number', description: '随机种子（参与幂等键）' },
    },
    buildSteps: buildBulkSteps,
    // 这些闸门必须 pass 才能提交
    mandatory_gates: ['dataset_registered', 'sample_table', 'sample_identity', 'groups', 'contrast', 'replication', 'design_confounded', 'counts_verified', 'assay_supported', 'method_compatible', 'prerequisites'],
  },
  'scrna-composition': {
    id: 'scrna-composition',
    version: TEMPLATE_VERSION,
    title: 'scRNA-seq 样本级细胞组成 + 定向 pseudobulk',
    description: '导入单细胞对象 → 写入样本分组 → QC/过滤/标准化/聚类 → 细胞类型比例检验（样本层）+ 指定细胞类型供体 pseudobulk 差异。',
    data_kind: 'scrna',
    requires_kind: ['scrna'],
    requires_scale: ['counts'],
    default_params: { cell_type_column: 'cell_type', resolution: 0.8, min_cells: 10, seed: 0 },
    param_schema: {
      contrast: { type: 'object', required: true, description: '{case, control}；比较方向 case - control' },
      cell_type_column: { type: 'string', description: '细胞类型列（默认 cell_type）' },
      resolution: { type: 'number', description: '聚类分辨率（默认 0.8）' },
      min_cells: { type: 'number', description: '最小组细胞数' },
      donor_min_cells: { type: 'number', description: '每个供体最少细胞数' },
      seed: { type: 'number' },
    },
    buildSteps: buildSingleCellSteps,
    mandatory_gates: ['dataset_registered', 'sample_table', 'sample_identity', 'groups', 'contrast', 'replication', 'design_confounded', 'counts_verified', 'assay_supported', 'prerequisites'],
  },
  'spatial-domain': {
    id: 'spatial-domain',
    version: TEMPLATE_VERSION,
    title: '空间转录组：QC → 聚类 → 空间高变基因 → 空间域',
    description: '导入已登记的空间数据（Visium/Stereo-seq/h5ad）→ QC/过滤/标准化/聚类 → Moran\'s I 空间高变基因 → 空间域 → 空间图。空间域注释是描述性结果，不做组间推断。',
    data_kind: 'spatial',
    requires_kind: ['spatial'],
    requires_scale: ['counts', 'log_expression'],
    default_params: { n_domains: 6, resolution: 1.0, n_svg: 2000, seed: 0 },
    param_schema: {
      n_domains: { type: 'number', description: '空间域数量（默认 6）' },
      resolution: { type: 'number', description: '聚类分辨率（默认 1.0）' },
      n_svg: { type: 'number', description: '空间高变基因数量（默认 2000）' },
      slice_column: { type: 'string', description: '切片列名（多切片时用于分组）' },
      seed: { type: 'number' },
    },
    buildSteps: buildSpatialSteps,
    // 空间域不是组间比较：分组/对照/重复不是必需闸门，但数据登记、样本表、尺度仍必须过。
    requires_contrast: false,
    requires_groups: false,
    requires_replication: false,
    mandatory_gates: ['dataset_registered', 'sample_table', 'sample_identity', 'design_confounded', 'counts_verified', 'assay_supported', 'prerequisites'],
  },
  'metabolomics-de': {
    id: 'metabolomics-de',
    version: TEMPLATE_VERSION,
    title: '代谢组：QC → 归一化 → 差异代谢物 → 通路富集 → 标志物',
    description: '导入 LC-MS/GC-MS/NMR 特征表 → 样品 QC/特征过滤/缺失填补/归一化/变换 → PCA/PLS-DA → 差异代谢物（contrast 方向明确）→ 通路富集与标志物筛选。',
    data_kind: 'metabolomics',
    requires_kind: ['metabolomics'],
    requires_scale: ['intensity', 'peak_area', 'counts', 'log_expression', 'none'],
    default_params: { method: 'auto', enrich_db: 'kegg', n_comp: 2, n_features: 20, seed: 0 },
    param_schema: {
      contrast: { type: 'object', required: true, description: '{case, control} 明确方向；logFC = case - control' },
      method: { type: 'string', description: '差异方法（默认 auto，由代谢引擎按数据分布选）' },
      enrich_db: { type: 'string', description: '富集库（kegg 等，以代谢引擎支持为准）' },
      n_comp: { type: 'number', description: 'PLS-DA 成分数' },
      n_features: { type: 'number', description: '标志物数量' },
      seed: { type: 'number' },
    },
    buildSteps: buildMetabolomicsSteps,
    mandatory_gates: ['dataset_registered', 'sample_table', 'sample_identity', 'groups', 'contrast', 'replication', 'design_confounded', 'counts_verified', 'assay_supported', 'prerequisites'],
  },
  'virtualcell-perturb': {
    id: 'virtualcell-perturb',
    version: TEMPLATE_VERSION,
    title: '虚拟细胞：状态表征 → GRN → 虚拟扰动（模型预测）',
    description: '导入单细胞表达谱 → QC/状态表征 → 基因调控网络 → in silico 敲除/过表达 → 扰动响应图与智能分析。**全部下游结论是 model_prediction，不是实验结论。**',
    data_kind: 'scrna',
    requires_kind: ['scrna'],
    requires_scale: ['counts', 'log_expression'],
    default_params: { n_hvg: 2000, resolution: 0.8, mode: 'knockout', strength: 1, seed: 0 },
    param_schema: {
      gene: { type: 'string', description: '扰动基因（留空由引擎自动选 hub TF）' },
      mode: { type: 'string', enum: ['knockout', 'knockdown', 'overexpression'], description: '扰动方式' },
      strength: { type: 'number', description: '扰动强度（默认 1.0）' },
      n_hvg: { type: 'number', description: '高变基因数' },
      resolution: { type: 'number', description: '状态聚类分辨率' },
      seed: { type: 'number' },
    },
    buildSteps: buildVirtualcellSteps,
    // 虚拟扰动不是组间实测比较：不需要对照方向与生物学重复；产物一律 model_prediction。
    requires_contrast: false,
    requires_groups: false,
    requires_replication: false,
    evidence_kind: 'model_prediction',
    mandatory_gates: ['dataset_registered', 'sample_table', 'counts_verified', 'assay_supported', 'prerequisites'],
  },
  'plotlab-figure': {
    id: 'plotlab-figure',
    version: TEMPLATE_VERSION,
    title: '绘图：任意已登记表格 → 出版级图 + 可复现代码',
    description: '导入 tidy/matrix 表 → 按 chart 出图（PNG 300dpi）→ 生成可复现 Python 代码。只做描述性展示，不做统计推断，因此不受 counts 尺度/重复闸门限制。',
    data_kind: 'any',
    requires_kind: ['any', 'bulk', 'scrna', 'spatial', 'metabolomics', 'unknown'],
    requires_scale: [],
    inference: false,
    default_params: { chart: 'bar', seed: 0 },
    param_schema: {
      chart: { type: 'string', description: '图表 id（bar/box/scatter/heatmap/volcano/de_heatmap 等，见 plotlab action=charts）' },
      chart_params: { type: 'object', description: '图表参数' },
      style: { type: 'object', description: '样式覆盖（palette/font/title_size/colors…）' },
      roles: { type: 'object', description: '列角色 {x,y,group,color,size,facet}' },
      seed: { type: 'number' },
    },
    buildSteps: buildPlotlabSteps,
    requires_contrast: false,
    requires_groups: false,
    requires_replication: false,
    mandatory_gates: ['dataset_registered', 'sample_table', 'prerequisites'],
  },
}

/**
 * 人话限制说明：解释「这次能回答什么、不能回答什么」，避免用户把描述性结果当推断。
 */
function buildLimitations({ dataset, template, steps, params }) {
  const limitations = []
  if (!dataset) return limitations
  const design = dataset.design || {}
  const samples = Array.isArray(design.samples) ? design.samples : []
  const groups = [...new Set(samples.map((sample) => String(sample.group || '').trim()).filter(Boolean))]
  if (template === 'scrna-composition') {
    if (!design.donor_column) limitations.push('缺少「患者/供体」列：不做细胞层伪重复推断；比例检验按细胞计只作描述性参考，不会出 pseudobulk 推断。')
    if (groups.length > 2) limitations.push(`数据里有 ${groups.length} 个分组：比例检验会对比全部分组；如需只比较 ${params && params.contrast ? params.contrast.case + ' vs ' + params.contrast.control : '两组'}，请先在数据里筛选。`)
    if (!samples.length) limitations.push('没有样本表：只能做描述性展示，不能做样本级比较。')
  }
  if (template === 'bulk-two-group' && (!dataset.scale || dataset.scale.verified !== true)) {
    limitations.push('数据尺度尚未确认：差异分析的方法与结果口径会受影响，请先确认 counts / log。')
  }
  return limitations
}

export function listTemplates() {
  return Object.values(TEMPLATES).map((template) => ({
    id: template.id,
    version: template.version,
    title: template.title,
    description: template.description,
    data_kind: template.data_kind,
    requires_scale: template.requires_scale,
    default_params: template.default_params,
    param_schema: template.param_schema,
    mandatory_gates: template.mandatory_gates,
    // 闸门开关：模板声明「不需要」的条件不再拦（空间域/虚拟扰动/纯绘图）
    requires_contrast: template.requires_contrast !== false,
    requires_groups: template.requires_groups !== false,
    requires_replication: template.requires_replication !== false,
    requires_scale: Array.isArray(template.requires_scale) ? template.requires_scale : null,
    inference: template.inference !== false,
    evidence_kind: template.evidence_kind || null,
  }))
}

// ---------------------------------------------------------------------------
// 计划构造
// ---------------------------------------------------------------------------

/**
 * 构造不可变 plan。
 * @param {object} input
 * @param {object} input.dataset 已登记的 dataset manifest
 * @param {string} input.template 模板 id（或 null，用自定义 steps）
 * @param {object} input.params 模板参数
 * @param {Array} input.customSteps 自定义 steps
 * @param {string} input.parentRun
 * @param {object} input.parentRunRecord
 */
export function buildPlan(input) {
  const {
    dataset,
    template: templateId,
    params = {},
    customSteps = null,
    parentRun = null,
    parentRunRecord = null,
  } = input || {}
  const template = templateId ? TEMPLATES[templateId] : null
  if (templateId && !template) {
    throw Object.assign(new Error(`未知模板 ${templateId}，可用：${Object.keys(TEMPLATES).join('、')}`), { code: 'bad_request' })
  }
  if (!template && !Array.isArray(customSteps)) {
    throw Object.assign(new Error('计划需要 template 或自定义 steps'), { code: 'bad_request' })
  }
  const seed = Number.isInteger(params.seed) ? params.seed : 0
  const baseParams = { ...(template ? template.default_params : {}), ...params, seed }
  const contrast = normalizeContrast(baseParams)
  // 没有 dataset 时不要调 buildSteps：各 builder 都要读 dataset.design，
  // 之前 dataset=null 会直接 TypeError，把「缺数据登记」这条闸门变成崩溃。
  const steps = template
    ? (dataset ? template.buildSteps(dataset, baseParams, []) : [])
    : normalizeCustomSteps(customSteps)
  const { gates, status, blocking } = evaluateGates({
    dataset, template: templateId, params: baseParams, steps, parentRun, parentRunRecord,
  })
  // 模板未通过的强制闸门 → 阻止（自定义计划只拦通用闸门）
  const mandatory = template ? template.mandatory_gates : ['dataset_registered', 'sample_table', 'sample_identity', 'groups', 'contrast', 'replication', 'design_confounded', 'counts_verified', 'prerequisites']
  const mandatoryFails = gates.filter((item) => item.status === 'fail' && mandatory.includes(item.id))
  const finalStatus = mandatoryFails.length || blocking.length ? 'blocked' : 'ready'
  const planCore = {
    schema_version: PLAN_SCHEMA_VERSION,
    template: template ? template.id : 'custom',
    template_version: template ? template.version : 0,
    dataset_id: dataset ? dataset.dataset_id : null,
    dataset_revision: dataset ? dataset.dataset_id : null,
    parent_run: parentRun,
    seed,
    contrast: contrast.ok
      ? { contrast_id: contrast.contrast_id, case: contrast.case, control: contrast.control, direction: contrast.direction }
      : null,
    design: summarizeDesign(dataset, baseParams),
    steps,
    params: baseParams,
    deliverables: DELIVERABLES,
    limitations: buildLimitations({ dataset, template: template ? template.id : null, steps, params: baseParams }),
  }
  const planId = sha256Json(planCore)
  const plan = {
    ...planCore,
    plan_id: planId,
    status: finalStatus,
    blocking: blocking.map((item) => ({ id: item.id, detail: item.detail })),
    gates,
    created_at: nowIso(),
  }
  return plan
}

function normalizeCustomSteps(customSteps) {
  return (customSteps || []).map((step, index) => {
    const plugin = String(step.plugin || '')
    if (!PLUGIN_IDS.includes(plugin)) {
      throw Object.assign(new Error(`step ${index + 1} 的 plugin=${plugin} 不受支持（可用：${PLUGIN_IDS.join('、')}）`), { code: 'bad_request' })
    }
    if (!step.action) throw Object.assign(new Error(`step ${index + 1} 缺少 action`), { code: 'bad_request' })
    return {
      step_id: String(step.step_id || `step_${index + 1}`),
      plugin,
      action: String(step.action),
      params: step.params && typeof step.params === 'object' ? step.params : {},
      deliver: step.deliver && typeof step.deliver === 'object' ? step.deliver : null,
      requires: Array.isArray(step.requires) ? step.requires : [],
      optional: Boolean(step.optional),
      timeout_ms: Number(step.timeout_ms) > 0 ? Number(step.timeout_ms) : 30 * 60 * 1000,
      evidence_kind: step.evidence_kind || (plugin === 'virtualcell' ? 'model_prediction' : 'measured'),
      label: step.label || null,
    }
  })
}

function summarizeDesign(dataset, params) {
  if (!dataset) return null
  const design = dataset.design || {}
  const groups = groupSummary(dataset)
  const nPerGroup = {}
  const donorsPerGroup = {}
  for (const [name, entry] of groups) {
    nPerGroup[name] = entry.samples.length
    donorsPerGroup[name] = entry.donors.size
  }
  const contrast = normalizeContrast(params)
  return {
    group_column: design.group_column || null,
    donor_column: design.donor_column || null,
    batch_column: design.batch_column || null,
    pair_column: design.pair_column || null,
    paired: Boolean(design.paired),
    covariates: Array.isArray(params.covariates) ? params.covariates : [],
    formula: design.formula || null,
    groups: [...groups.keys()],
    n_per_group: nPerGroup,
    donors_per_group: donorsPerGroup,
    n_samples: designSamples(dataset).length,
    contrast: contrast.ok ? `${contrast.case} - ${contrast.control}` : null,
  }
}

/**
 * 自定义计划里也允许「直接借用」模板步骤：把 dataset 里的路径解析出来。
 */
export function resolvePlanDataset(store, datasetId) {
  const dataset = store.getDataset(datasetId)
  if (!dataset) {
    throw Object.assign(new Error(`数据集 ${datasetId} 不存在（先 action=register）`), { code: 'not_found' })
  }
  return dataset
}

export { selectPrimaryFile, datasetKind, groupSummary, normalizeContrast, methodCompatibility }
