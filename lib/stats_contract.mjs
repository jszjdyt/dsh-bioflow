/**
 * dsh-bioflow — 统计口径契约（stats contract）
 *
 * 解决的问题：run 成功了，但「这次到底用了什么统计设定」散落在 params、design、
 * environment、evidence 与各步骤返回值里，UI 与 agent 都很难一句话答出来：
 *   · 对比方向是 case - control 还是反过来？
 *   · 校正的是哪个检验族、多少条、alpha 多少？
 *   · 每组几个样本、几个供体？声明了配对但配对列是什么？
 *   · 数据尺度验证过没有？这批产物能不能锁定到某个 content_hash？
 *
 * 本模块只做「搬运 + 显式化」：所有字段都从已冻结的 plan / manifest / dataset 里取，
 * 取不到就写 null 并进 caveats，**不补默认值、不猜方法名**。
 * 这一点和 P0 审计的口径一致——宁可显式写「未知」，也不让读者误以为已核验。
 */

export const STATS_CONTRACT_SCHEMA = 'bioflow.stats_contract/1'

const DE_TOKENS = /(logfc|log2fc|fold|差异|differential|de\b)/i

/**
 * 是否为「差异类」计划：模板名带 de/logfc/fold/two-group，或存在 de/differential 步骤。
 * 只有确认是差异类时才声明 logFC 口径，避免给空间/组成/纯绘图 run 硬套。
 */
function isDifferentialPlan(plan, template) {
  if (DE_TOKENS.test(String(template || ''))) return true
  for (const step of asArray(plan && plan.steps)) {
    const item = asObject(step) || {}
    const action = String(item.action || '')
    const stepId = String(item.step_id || item.id || '')
    if (/^(de|deg|differential)$/i.test(action)) return true
    if (/(^|[-_.])(de|deg|differential)($|[-_.])/i.test(stepId)) return true
  }
  return false
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function text(value) {
  if (value === null || value === undefined) return null
  const out = String(value).trim()
  return out ? out : null
}

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** dataset.scale 在不同版本里可能是字符串或 { type, verified, evidence } 对象。 */
function readScale(dataset) {
  const raw = dataset ? dataset.scale : null
  if (!raw) return { type: null, verified: null, evidence: null }
  if (typeof raw === 'string') return { type: text(raw), verified: null, evidence: null }
  const scale = asObject(raw) || {}
  return {
    type: text(scale.type || scale.value || scale.name),
    verified: typeof scale.verified === 'boolean' ? scale.verified : null,
    evidence: text(scale.evidence || scale.source),
  }
}

/** 从冻结计划里收集「每个分析步骤声明的方法名」，不覆盖、不改写。 */
function collectTests(plan) {
  const tests = []
  const seen = new Set()
  const push = (entry) => {
    const key = `${entry.step_id || ''}|${entry.method}`
    if (!entry.method || seen.has(key)) return
    seen.add(key)
    tests.push(entry)
  }
  const planParams = asObject(plan && plan.params) || {}
  const topMethod = text(planParams.test || planParams.method || planParams.de_method)
  if (topMethod) push({ step_id: null, plugin: null, action: null, method: topMethod, source: 'plan.params' })
  for (const step of asArray(plan && plan.steps)) {
    const item = asObject(step) || {}
    const params = asObject(item.params) || {}
    // 模板 step 的参数可能再嵌一层（如 de: { step:'de', params:{ method:'deseq2' } }）
    const nested = asObject(params.params) || {}
    const method = text(params.test || params.method || params.de_method || params.engine
      || nested.test || nested.method || nested.de_method || nested.engine)
    if (!method) continue
    push({
      step_id: text(item.step_id || item.id),
      plugin: text(item.plugin),
      action: text(item.action),
      method,
      source: 'plan.steps[].params',
    })
  }
  return tests
}

/** 读 plan.design（summarizeDesign 产出）里的每组件本数与供体数。 */
function readDesign(design) {
  const source = asObject(design) || {}
  const nPerGroup = asObject(source.n_per_group) || {}
  const donorsPerGroup = asObject(source.donors_per_group) || {}
  const names = [...new Set([...Object.keys(nPerGroup), ...Object.keys(donorsPerGroup)])]
  const groups = names.map((name) => ({
    name,
    n_samples: num(nPerGroup[name]),
    n_donors: num(donorsPerGroup[name]),
  }))
  const sampleCounts = groups.map((group) => group.n_samples).filter((value) => value !== null)
  const donorCounts = groups.map((group) => group.n_donors).filter((value) => value !== null)
  return {
    groups,
    total_samples: num(source.n_samples) ?? (sampleCounts.length ? sampleCounts.reduce((sum, value) => sum + value, 0) : null),
    total_donors: donorCounts.length ? donorCounts.reduce((sum, value) => sum + value, 0) : null,
    min_group_n: sampleCounts.length ? Math.min(...sampleCounts) : null,
    group_column: text(source.group_column),
    donor_column: text(source.donor_column),
    batch_column: text(source.batch_column),
    pair_column: text(source.pair_column),
    paired: typeof source.paired === 'boolean' ? source.paired : null,
    covariates: asArray(source.covariates).map((item) => text(item)).filter(Boolean),
    formula: text(source.formula),
  }
}

function readFdr(plan, manifest, evidenceSummary) {
  const params = asObject(plan && plan.params) || {}
  const raw = params.fdr ?? params.fdr_method ?? params.correction
  let method = null
  let alpha = num(params.alpha ?? params.fdr_alpha)
  let source = 'plan'
  const known = /^(BH|BY|bonferroni|holm|hochberg|fdr|benjamini|storey)/i
  if (typeof raw === 'string') {
    method = text(raw)
    const match = raw.match(/(0?\.\d+)/)
    if (alpha === null && match) alpha = Number(match[1])
    const token = raw.trim().match(known)
    if (token) method = token[1].toUpperCase() === 'BENJAMINI' ? 'BH' : token[1]
  } else if (typeof raw === 'number') {
    alpha = alpha === null ? raw : alpha
  } else if (raw && typeof raw === 'object') {
    method = text(raw.method || raw.name)
    alpha = alpha ?? num(raw.alpha)
  }
  if (alpha === null) alpha = num(evidenceSummary && evidenceSummary.alpha)
  // 计划里没有显式校正方法时，按引擎默认（methods.md 记载为 BH）记录，并标明来源，
  // 不假装是用户选的——这样 q 值口径既可回查，也不会天天误报「缺失」。
  if (!method) {
    method = 'BH'
    source = 'engine_default'
  }
  const family = asObject(params.fdr_family) || {}
  const nTests = num(params.fdr_family_n ?? family.n ?? params.n_tests)
  return {
    method,
    alpha,
    n_tests: nTests,
    family: text(params.fdr_family_scope || family.scope || family.description),
    source,
  }
}

/** 回查命令：run 阶段给 run-status/methods/evidence；计划阶段给可复现 plan 命令。 */
function buildReproduce(runRecord, plan, phase) {
  const runId = text(runRecord && runRecord.run_id)
  if (runId) {
    return [
      `node bin/bioflow.mjs run-status --run-id=${runId} --json`,
      `node bin/bioflow.mjs methods --run-id=${runId}`,
      `node bin/bioflow.mjs evidence --run-id=${runId} --json`,
    ]
  }
  const planObject = asObject(plan) || {}
  const datasetId = text(runRecord && runRecord.dataset_id) || text(planObject.dataset_id)
  if (!datasetId || phase !== 'plan') return []
  const parts = [`node bin/bioflow.mjs plan --dataset=${datasetId}`]
  if (text(planObject.template)) parts.push(`--template=${text(planObject.template)}`)
  const contrast = asObject(planObject.contrast) || {}
  if (text(contrast.case)) parts.push(`--case=${text(contrast.case)}`)
  if (text(contrast.control)) parts.push(`--control=${text(contrast.control)}`)
  return [parts.join(' ')]
}

function buildCaveats({ manifest, design, scale, fdr, tests, evidenceSummary, contract, phase = 'run' }) {
  const caveats = []
  const add = (code, level, textValue) => caveats.push({ code, level, text: textValue })

  if (phase === 'plan') {
    // 计划阶段（pre-flight）：只提示「提交前还能改什么」，不把还没发生的事说成缺失。
    add('plan_preview', 'info', '这是提交前的口径预览：产物哈希与 evidence 计数在 run 完成后写入。')
  } else if (!manifest) {
    add('no_manifest', 'warn', 'run 尚未产出 manifest：统计口径只能从计划推断，产物不可锁定。')
  }
  if (!scale.type) add('scale_unknown', 'warn', '未记录数据尺度（scale）：差异类结论无法确认是在 counts / log / 比值哪一层上算的。')
  else if (scale.verified !== true) {
    add('scale_unverified', 'warn', `数据尺度 ${scale.type} 未验证（verified≠true）：推断类结论应降级为描述，不要当实测结论引用。`)
  }
  if (!fdr.method) add('fdr_unknown', 'warn', '未记录多重校正方法：q/p 值按引擎默认行为解释，回查时无法确认检验族。')
  else if (fdr.source === 'engine_default') add('fdr_engine_default', 'info', `多重校正方法取引擎默认（${fdr.method}）：计划未显式指定，methods.md 与 evidence alpha 记录阈值。`)
  if (fdr.n_tests === null) add('fdr_family_unknown', 'info', '未记录多重校正的检验族大小（n_tests）：无法核对 BH 家族是否被缩小。')
  if (design.paired === true && !design.pair_column) {
    add('paired_without_pair_column', 'warn', '设计声明为配对，但没有记录配对列（pair_column）：配对检验实际可能退化为独立比较。')
  }
  if (design.covariates.length && !design.formula) {
    add('covariates_without_formula', 'warn', `声明了协变量（${design.covariates.join('、')}）但没有记录实际公式：协变量是否真的进入模型不可回查。`)
  }
  if (design.min_group_n !== null && design.min_group_n < 2) {
    add('min_group_n_below_2', 'warn', `存在每组样本数 ${design.min_group_n} 的组：生物学重复不足，组间比较不应作为推断结论。`)
  }
  const donors = design.groups.map((group) => group.n_donors).filter((value) => value !== null)
  if (donors.length && Math.min(...donors) < 2) {
    add('donor_replication_low', 'warn', '存在供体数 <2 的组：以细胞为重复算出的 p 值不能当作生物学重复证据。')
  }
  if (!tests.length) add('test_unknown', 'info', '未在计划里记录检验方法名：只能依据引擎返回值与 methods.md 判断。')
  const modelPredictions = num(evidenceSummary && evidenceSummary.model_prediction) ?? 0
  if (modelPredictions > 0) {
    add('model_prediction_present', 'warn', `证据里有 ${modelPredictions} 条模型预测（model_prediction）：它们是假说，不是实验结论。`)
  }
  if (manifest && manifest.zero_significant === true) {
    add('zero_significant', 'info', '本次零显著：不代表「无差异」，请结合效应量与置信区间。')
  }
  const failed = asArray(evidenceSummary && evidenceSummary.failed_steps)
  if (failed.length) add('failed_steps', 'warn', `有步骤失败：${failed.join('、')}；对应证据缺失，不应外推。`)
  const coverage = asObject(evidenceSummary && evidenceSummary.coverage)
  if (coverage && num(coverage.rows_total) !== null && num(coverage.rows_indexed) !== null && coverage.rows_indexed < coverage.rows_total) {
    add('evidence_truncated', 'info', `证据索引被截断（${coverage.rows_indexed}/${coverage.rows_total} 行）：全量数值见 results/*.tsv。`)
  }
  if (phase !== 'plan' && !contract.identity.content_hash) {
    add('no_content_hash', 'warn', '缺 content_hash：这批产物无法按内容锁定，跨机器比对只能靠 manifest_sha256。')
  }
  return caveats
}

/**
 * 构建一次 run 的统计口径契约。
 * @param {object} input
 * @param {object} input.run           run 记录（含 run_id/status/template/dataset_id/plan_id）
 * @param {object} [input.manifest]    已冻结的 manifest.json（无则按未完成处理）
 * @param {object} [input.plan]        冻结的 plan 记录（manifest.plan 优先）
 * @param {object} [input.dataset]     dataset 记录（manifest.dataset 优先）
 */
export function buildStatsContract({ run, manifest = null, plan = null, dataset = null, phase = 'run' } = {}) {
  const runRecord = asObject(run) || {}
  const manifestObject = asObject(manifest)
  const frozenPlan = asObject(manifestObject && manifestObject.plan) || asObject(plan)
  const frozenDataset = asObject(manifestObject && manifestObject.dataset) || asObject(dataset)
  const evidenceSummary = asObject(manifestObject && manifestObject.evidence) || null
  const environment = asObject(manifestObject && manifestObject.environment) || {}

  const design = readDesign(frozenPlan && frozenPlan.design)
  const scale = readScale(frozenDataset)
  const tests = collectTests(frozenPlan)
  const fdr = readFdr(frozenPlan, manifestObject, evidenceSummary)

  const contrastRaw = asObject(frozenPlan && frozenPlan.contrast) || asObject(manifestObject && manifestObject.contrast) || {}
  const caseName = text(contrastRaw.case)
  const controlName = text(contrastRaw.control)
  const templateName = text(runRecord.template || (frozenPlan && frozenPlan.template))
  const contrast = {
    case: caseName,
    control: controlName,
    direction: caseName && controlName ? `${caseName} - ${controlName}` : null,
    // 只有能确认是差异类计划时才声明 logFC 口径，避免给图/组成类 run 硬套。
    effect_convention: caseName && controlName && isDifferentialPlan(frozenPlan, templateName) ? 'logFC = case - control' : null,
  }

  const contract = {
    schema: STATS_CONTRACT_SCHEMA,
    phase: phase === 'plan' ? 'plan' : 'run',
    run_id: text(runRecord.run_id),
    plan_id: text(runRecord.plan_id || (frozenPlan && frozenPlan.plan_id)),
    template: templateName,
    status: text(runRecord.status),
    contrast,
    design: {
      n_samples: design.total_samples,
      n_donors: design.total_donors,
      min_group_n: design.min_group_n,
      group_column: design.group_column,
      donor_column: design.donor_column,
      batch_column: design.batch_column,
      pair_column: design.pair_column,
      paired: design.paired,
      covariates: design.covariates,
      formula: design.formula,
      groups: design.groups,
    },
    inference: {
      tests,
      fdr,
      min_replicate_note: '每组独立生物学重复 n>=2；以细胞/spot 为重复不构成生物学重复',
    },
    data: {
      dataset_id: text(frozenDataset && frozenDataset.dataset_id) || text(runRecord.dataset_id),
      revision: text(frozenDataset && frozenDataset.revision) || text(runRecord.dataset_revision),
      name: text(frozenDataset && frozenDataset.name),
      assay: text(frozenDataset && frozenDataset.assay),
      species: text(frozenDataset && frozenDataset.species),
      platform: text(frozenDataset && frozenDataset.platform),
      reference: text(frozenDataset && frozenDataset.reference),
      scale: scale.type,
      scale_verified: scale.verified,
      scale_evidence: scale.evidence,
      n_files: asArray(frozenDataset && frozenDataset.files).length || null,
      has_clinical: Boolean(frozenDataset && frozenDataset.clinical),
      sample_sheet: text(frozenDataset && frozenDataset.sample_sheet),
    },
    evidence: {
      alpha: fdr.alpha,
      n_claims: num(evidenceSummary && evidenceSummary.records),
      kinds: {
        measured: num(evidenceSummary && evidenceSummary.measured),
        descriptive: num(evidenceSummary && evidenceSummary.descriptive),
        model_prediction: num(evidenceSummary && evidenceSummary.model_prediction),
      },
      zero_significant: manifestObject ? manifestObject.zero_significant === true : null,
      coverage: asObject(evidenceSummary && evidenceSummary.coverage),
    },
    identity: {
      content_hash: text(manifestObject && manifestObject.content_hash),
      manifest_sha256: text(runRecord.manifest_sha256) || text(manifestObject && manifestObject.manifest_sha256),
      run_dir: text(runRecord.run_dir),
      seed: num(runRecord.seed ?? (manifestObject && manifestObject.seed)),
    },
    environment: {
      bioflow_version: text(environment.bioflow_version),
      node: text(environment.node),
      platform: text(environment.platform),
      plugins: asObject(environment.plugins) || null,
      captured_at: text(environment.captured_at),
    },
    reproduce: buildReproduce(runRecord, frozenPlan, phase),
    caveats: [],
  }

  contract.caveats = buildCaveats({ manifest: manifestObject, design, scale, fdr, tests, evidenceSummary, contract, phase })
  // 计划阶段一律不可引用（还没跑、没有产物哈希）；run 阶段只要没有 warn 就可引用。
  contract.ok_to_cite = phase !== 'plan' && contract.caveats.every((item) => item.level !== 'warn')
  return contract
}
