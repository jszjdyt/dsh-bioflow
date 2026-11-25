# dsh-bioflow · 维护者细节

面向改这个插件的人。用户文档看 [README.md](../README.md)，装/卸看 [INSTALL.md](../INSTALL.md)，页面规格看仓库根 `BIOFLOW_UI_SPEC.md`。

Bioflow 的定位是**编排器**，不是分析引擎：它不做统计，只做「找数据 → 登记版本 → 定设计 → 过闸门 → 编排步骤 → 归档证据」。所有数值来自六个工作台插件的引擎返回，Bioflow 只抽取、格式化、记账。

```
index.js (Host 薄壳)                     CLI bin/bioflow.mjs
   /bioflow/* 路由 ─┐                    ┌─ runTool(runtime, args)
   bioflow 工具 ────┼──> lib/impl.mjs ───┤
   prompt section ──┘                    └─ executeRun → adapters → 工作台引擎
                                              ↓
                                    plan → deliver → evidence → store
```

---

## 1. 模块职责分工

| 模块 | 行数 | 职责 | 不做什么 |
|---|---|---|---|
| `index.js` | ~170 | Host 半边：挂 `/bioflow` 前缀路由、注册 `bioflow` 工具与 prompt section、卸载时关 store/abort 所有 run；用 `?rev=<mtime>` 绕开 ESM 缓存 | 不写业务逻辑；不缓存结果 |
| `lib/impl.mjs` | ~2200 | 全部 action 的入口（`runTool` 分发到 `opX()`）、run 执行器 `executeRun`、内置步骤（harmonize/meta/joint_prepare）、文件服务、工具定义与 prompt 文本 | 不实现统计；不做格式解析细节（交给 deliver） |
| `lib/adapters.mjs` | ~420 | 六插件引擎适配：定位 `lib/engine.mjs`、校验契约（`createEngine` 等必需导出/成员）、`mapAction` 把 action 映射到各插件三分裂的命令命名空间、`invoke` 带超时 + abort、错误信封归一化 | 不 import 插件内部实现；协议不符一律 `protocol_mismatch` |
| `lib/plan.mjs` | ~1460 | 模板 `TEMPLATES`、闸门 `evaluateGates`（纯函数）、计划构造 `buildPlan`、`listTemplates`、`resolvePlanDataset` | 不做 IO、不启动引擎（方便单测） |
| `lib/deliver.mjs` | ~840 | 交付物：`stageStepResult`（抽表/抽图，写 `.staging`）→ `commitStepResult`（原子搬进 `runDir`）→ `finalizeRun`（design/qc/tables.index/evidence/methods/manifest + 逐文件哈希） | 不重算数值；不把上游 workdir 当交付目录 |
| `lib/evidence.mjs` | ~290 | claim 索引：从结果表抽「可被引用的行」，绑定 `run_id/contrast_id/table_id/row_id/figure_id`，区分 `measured` / `descriptive` / `model_prediction`；`verifyEvidence` 校验引用 | 不是结果表副本（全量数值在 `results/*.tsv`） |
| `lib/store.mjs` | ~920 | 记录库（`node:sqlite` 优先，JSON 快照+journal 兜底）、状态机 `TRANSITIONS`、原子写、哈希、TSV 序列化、`runDir/datasetDir` 等布局、事件日志 | 不判断业务状态是否「合理」，只拒绝非法迁移 |
| `lib/search.mjs` | ~350 | 多源检索编排（`performSearch` → `search_id` + provenance）、把结果转下载任务（`resolveDownloadTasks` / `executeDownload`）、登记前的文件冻结校验 `verifyDatasetFiles` | 不直接发 HTTP（HTTP 在 sources/pubmed/download） |
| `lib/sources.mjs` | ~1140 | 五源统一客户端：统一 item schema、每源独立超时/降级、GEO 插件优先 + E-utilities 回退、GDC/MetaboLights/CELLxGENE 客户端、健康灯 `probeHealth` | 不做下载落盘（下载器负责） |
| `lib/pubmed.mjs` | ~580 | PubMed E-utilities 客户端：esearch/esummary/efetch、7 天缓存、限速（无 key 3/s，有 key ≥10/s）、零命中时确定性放宽 `relaxQuery`、Europe PMC 可选 | 不把 Europe PMC 失败当整体失败（只记 warning） |
| `lib/download.mjs` | ~330 | 统一下载器：`.part` → 校验 sha256/md5/size → 原子 rename、Range 断点续传（`If-Range` + 416 处理）、TokenBucket 限流、同 hash 复用、路径冲突显式报错 | 不管 artifact 登记（search/executor 做） |
| `lib/harmonize.mjs` | ~740 | 多数据集对齐（特征 ID/探针/尺度）→ 批次评估 → 显式校正（`none/scale_only/quantile/combat`）；`combat` 是 location/scale 版本，方法名写 `combat-lite` | 不读 h5ad/10x（只读文本矩阵，二进制先由工作台导出） |
| `lib/joint.mjs` | ~490 | `meta`（fixed/random 合并 + I² + 异质性）、`signature`（bulk→scRNA，`model_prediction`）、`plot`（准备联合出图数据） | 不自己画图（`plot` 模式走 plotlab） |
| `lib/intent.mjs` | ~460 | 自然语言 → intent → draft 计划：确定性规则优先、缺字段只问最少的问题并给候选、可选 LLM 兜底（只当建议）、draft 带 `confirm_token` | **绝不**直接提交或执行 |
| `bin/bioflow.mjs` | ~90 | CLI：`<action> --k=v ... --json --data-dir=<abs>`，与工具共用 `runTool` | 不做第二套逻辑 |

---

## 2. 三条硬设计决定的落点

### 2.1 每个 run 每个插件一个临时 worker

- 位置：`impl.executeRun`。第一次用到某插件时建 adapter：
  `workdir = <runDir>/engines/<plugin>`（**绝不跨 run 复用**），通过 `A.createAdapter(plugin, {workdir, config, pluginPaths, python})` 交给插件的 `lib/engine.mjs`。
- 生命周期：`finally` 里对所有 adapter `dispose()`（POSIX 下引擎用 detached + 负 pid 杀进程组）；
  除非配置 `keepEngineScratch=true`，否则 `rm -rf <runDir>/engines`。
- 检索/下载用的「临时 adapter」是另一条路：`ephemeralAdapter`（`<dataRoot>/cache/search-engines/<plugin>`），每次 `runTool` 结束在 `finally` 里 `disposeEphemeral`。
- 为什么要这样：上游插件的 `prepareWorkdir` 会删 `<workdir>/figures/*.png`，用共享 workdir 会串图；并发 run 也会互相踩。交付物一律从 `runDir` 出，不从 workdir 出。

### 2.2 透传不重算

- step 形状固定：`{step_id, plugin, action, params, requires[], optional, timeout_ms, deliver, evidence_kind, label}`；
  `expandStepParams` 把字符串里的 `$RUN_DIR` 替换成当前 run 目录（用于 `joint plot` 那种「上一步产物 → 下一步输入」的接线）。
- `adapter.invoke(action, params)` 的返回原样落 `results/steps/<step_id>.json`（逐字节、未重算）；
  `deliver.mjs` 只做**抽取与格式转换**：递归找表格状节点（`extractTables`）和图路径（`extractFigures`），转 TSV、算哈希、进索引。
- 结果表自描述：每张表一个 `results/<table_id>.tsv`，元数据（标题、evidence_kind、contrast_id、列类型）在 `results/tables.index.json`；不往 TSV 里塞注释行（会被普通解析器当数据）。
- `qc.tsv` 是「所有 QC/过滤/标准化/聚类类表」的长表合并；一个 QC 表都没有时只有表头 + 一行 `table_id=none,row_id=0` 占位（不是坏数据）。
- 内置步骤只有三个：`harmonize`、`meta_analysis`、`joint_prepare`（`runBuiltinStep`）。它们是 Bioflow 自己的归一化/合并/出图数据准备，不是对工作台分析的重算。

### 2.3 闸门真拦

- 位置：`plan.evaluateGates`（纯函数）。共 12 条闸门（`GATE_TITLES`），`status: 'fail' && blocking !== false` 即阻断；
  模板另有 `mandatory_gates` 白名单（`buildPlan` 里 `mandatoryFails` 再判一次）。
- **模板声明式的例外**（不是绕过）：模板可写 `requires_groups:false` / `requires_contrast:false` / `requires_replication:false` / `requires_scale:[]`，
  对应闸门仍会出现在 `gates[]` 里，只是 `status:'pass'` 且 `detail` 写明「该模板不需要」（空间域 / 虚拟扰动 / 纯绘图用这个口子）。
  `requires_scale` 同时决定 `counts_verified` 的判定：`[]` 表示不依赖表达尺度，非空数组则要求 `verified===true` 且 `scale.type` 在允许范围内。
- 三道防线：
  1. `plan` / `ask` 返回 `status=blocked` + 逐条 `blocking[{id, detail}]`，UI 必须显示「拦在哪条、缺什么」；
  2. `submit` 拿到已存计划后再查 `storedPlan.status === 'blocked'` → 抛 `blocked`；
  3. `submit` 前 `S.verifyDatasetFiles(dataset)` 重算输入文件 sha256，不一致抛 `artifact_mismatch`（冻结数据版本，防止「登记后文件被换掉」）。
- `confirm_token`：`plan` / `ask` 生成 `sha256(plan_id + template + dataset_id + params + seed + contrast)`；`submit` 必须带，缺失 → `confirm_required`，不一致 → `draft_changed`。目的：**用户确认的是这一版计划**，确认前改字段就换 token。
- 零显著不是闸门：分析成功但全部 q>0.05 照常交付，`finalizeRun` 在 manifest 写 `zero_significant=true`，`evidence` 里也带出来。判断依据是含推断统计（p/q 列）且 `evidence_kind !== descriptive` 的表。

---

## 3. run 生命周期状态机

状态集合与迁移表在 `lib/store.mjs`：

```js
RUN_STATUSES = ['pending_review','queued','running','partial','succeeded','failed','cancelled']

TRANSITIONS = {
  pending_review: ['queued', 'cancelled'],
  queued:         ['running', 'cancelled', 'failed'],
  running:        ['succeeded', 'partial', 'failed', 'cancelled'],
  succeeded:      [],
  partial:        [],
  failed:         [],
  cancelled:      [],
}
```

- 终态出边为空 = 不可再改；`store.transition` 非法迁移抛 `bad_transition`（附 `from/to/allowed`）。
- `cancelRun`：非终态 → `cancelled`；已是终态返回 `changed:false` + 原因。
- **取消零写入**：`assertWritable` 拒绝一切已取消/已终态 run 的产物提交；`executeRun` 的 catch 在取消时 `rm -rf <runDir>/.staging` 并不写 manifest；每个 step 结束后还会再查一次 `isCancelled`，取消了就丢弃刚拿到的产物。
- 正常路径：`submit` 建 run（`queued` 或 `start:false` 时 `pending_review`）→ `executeRun` 开始 `running` → 全部必需步骤成功 `succeeded`，有可选步骤失败 `partial`。
- 失败路径：必需步骤抛错 → 直接抛给 `opSubmit` 的兜底，run 标 `failed` 并写 `error`；**不执行 `finalizeRun`**。
  失败的 run 里，失败之前已成功步骤的产物是**逐步骤提交**的，会留在 run 目录（`results/*.tsv`、`results/steps/<step>.json`、`figures/`），供诊断与复盘；
  但汇总层不会出现：没有 `manifest.json` / `design.tsv` / `qc.tsv` / `evidence.jsonl` / `methods.md`。
  所以「完整取证」只对 `succeeded` / `partial` 有意义：`evidence` / `methods` 对 failed run 直接报 `prerequisite`（文件不存在）；
  `export` 仍会把已提交步骤的文件按哈希列出来，但 `ok:false`（因为 run 不是 succeeded），不会冒充成功交付。
- 幂等键：`dataset_id + dataset_revision + plan_hash + template(+version) + seed + params + steps + parent_run`；`store.createRun` 命中返回 `reused:true`，同参数不会重复跑。

---

## 4. 数据根与 run 目录

默认 `~/.dsh/bioflow`（`runtime.config.dataDir|workdir` → 环境变量 `DSH_BIOFLOW_WORKDIR` → `~/.dsh/bioflow`）。存储后端 `auto`：有 `node:sqlite` 用 sqlite（`store.sqlite`，WAL），否则 JSON（`store.json` + `journal.jsonl`）。完整目录树与清理见 [INSTALL.md §4](../INSTALL.md)。

一句话要点：**记录**（dataset/plan/run/artifact/search）在 store 里；**字节**（下载、交付物、检索快照、缓存）在文件系统里，交付物只认 `runs/<run_id>/`。`datasets/`、`plans/` 是预留目录，当前不落文件。

run 目录固定形状：

```
runs/<run_id>/
├── manifest.json          # 最后写：不能自引用，所以先收集 artifacts 再加 content_hash
├── design.tsv  qc.tsv
├── results/<table_id>.tsv  results/tables.index.json  results/steps/<step_id>.json
├── figures/<NN>_<name>.png（图有 plot_data 时附 <NN>_<name>.plotdata.json；name 取图 kind，缺省用源文件名短哈希）
├── evidence.jsonl  methods.md
├── .staging/<step_id>/    # 只有取消/崩溃才残留（audit 会 warn）
└── engines/<plugin>/      # 运行期临时 worker；除非 keepEngineScratch，否则 finally 删掉
```

---

## 5. 模板

`lib/plan.mjs` 的 `TEMPLATES` 是唯一事实来源；`bioflow action=templates` 与 `/bioflow/catalog` 都直接列它（`listTemplates()`）。
每个模板 = `{id, version, title, description, data_kind, requires_kind, requires_scale, default_params, param_schema, buildSteps, mandatory_gates}`，
外加三个可选的「闸门开关」`requires_contrast / requires_groups / requires_replication`（默认 true）以及 `inference`、`evidence_kind`。

| 模板 id | 工作台（plugin） | 主要步骤（step_id） | 强制闸门 |
|---|---|---|---|
| `bulk-two-group` | `geobulk` | `open → design → qc → filter → normalize → de → enrich(可选)` | 11 条（含 `method_compatible`） |
| `scrna-composition` | `singlecell` | `open → design → qc → filter → normalize → hvg → pca → neighbors → cluster → embed(可选) → composition(可选) → pseudobulk(可选)` | 10 条 |
| `spatial-domain` | `spatial` | `open → design(有样本表才加) → qc → filter → normalize → hvg → pca → neighbors → cluster → svg(可选) → domains(可选) → plot_domain(可选) → plot_svg(可选) → audit(可选)` | 7 条；`requires_groups/contrast/replication=false`（空间域是描述性） |
| `metabolomics-de` | `metabolomics` | `open → design → qc → filter → impute(可选) → normalize → transform(可选) → pca(可选) → plsda(可选) → de → enrich(可选) → biomarker(可选) → VIP/火山图(可选) → audit(可选)` | 10 条；`requires_scale` 接受 `intensity/peak_area/counts/log_expression/none` |
| `virtualcell-perturb` | `virtualcell` | `open → qc → state → grn → perturb → plot_perturb(可选) → plot_grn(可选) → insight(可选)` | 5 条；`requires_contrast/groups/replication=false`、`evidence_kind=model_prediction` |
| `plotlab-figure` | `plotlab` | `open → plot → code(可选)` | 3 条（`dataset_registered/sample_table/prerequisites`）；`requires_scale=[]`、`inference:false` |

- 步骤里的 `deliver.kind` 决定交付归类（`qc/design/de/figure/...`）；可选步骤标 `optional:true`，失败只把 run 降级为 `partial`。
- 需要前一步产物做输入时用 `requires:['prev_step']` + 参数里写 `$RUN_DIR/results/<file>`（`expandStepParams` 会替换）。
- 闸门不用模板作者手写：`evaluateGates` 跑全套，模板只声明哪些必须过、哪些不适用。
- 模板版本参与幂等键，改行为必须 `version+1`；`evidence_kind` 可由模板兜底（如虚拟细胞），步骤里也能逐条覆盖。

---

## 6. 每个 action 的参数与返回

约定：参数都可用 `dataset` 兼容 `dataset_id`；返回统一带 `ok`、`action`、`summary`（一行中文），列表类还带 `rows`（CLI 直接渲染）。

| action | 主要参数 | 返回要点 |
|---|---|---|
| `status` | — | `version/data_root/store_kind/store_file/store_warnings/datasets/plans/searches/runs/runs_by_status/plugins[]/sources[]/tabs/summary/suggest`；若之前调过 `health` 附带 `health` |
| `templates` | — | `templates[]`（含 `param_schema`、`mandatory_gates`、`requires_contrast/groups/replication`、`requires_scale`、`inference`、`evidence_kind`）、`advanced.harmonize{methods,params}`、`advanced.joint{modes,params}`、`gates[]{template,gates}` |
| `search` | `term`(或 `query`/`q`)、`sources[]`（默认 geo,pubmed,gdc,metabolights）、`limit=20`、`page=0`、`species=all`、`include_abstracts`、`has_clinical`、`europepmc`；或 `detail:true`+`source`+`id` | `search_id/query/sources/sources_ok/sources_failed/by_source/items{source:[item]}/provenance/warnings/next` |
| `source_detail` | `source`、`id`(或 `accession`/`project_id`)、`include_clinical` | 统一 item + `items[]` 详情（GDC 带 STAR counts 文件与临床字段） |
| `health` | `sources[]`（默认全部五源）、`force` | `sources{source:{status:ok|slow|down, latency_ms, reason, expected}}`、`plugins[]`；缓存 60s |
| `download` | `source`、`id`(或 `gse`/`accession`/`project_id`)、`dest_dir`、`files[]`、`include_clinical` | `source_record/dest_dir/downloads[]/artifacts[]`；源不可用时 `ok:false,status:'source_unavailable'`（不抛错） |
| `register` | `path`(或 `dir`/`artifact_ids[]`/`source_item`)、`sample_sheet`、`samples[]`(或 JSON 串)、`sample_column/group_column/donor_column/batch_column/pair_column`、`paired`、`formula`、`scale`(+`verified`/`scale_evidence` 或对象 `{type,verified,evidence,note}`)、`assay`、`data_kind`、`species`、`platform`、`reference`、`data_format`、`transpose`、`clinical`、`name` | `dataset{dataset_id, revision, scale, design, files[], conflicts[], unverified[], orientation}`、`reused`、`gates_preview{status,blocking}`；样本 ID 重复时 `status:'design_conflict'`（不静默丢样本）。`transpose` 没给时按「矩阵表头 vs 样本 ID」自动判定并记在 `orientation`。`scale.type` 接受 `counts/tpm/log_expression/microarray/normalized_expression/star_counts/metabolomics_profile/intensity/peak_area/log2_intensity/abundance/none/unknown`（报错文案只列了前 5 个，已过时） |
| `datasets` | `dataset_id`（省略=列表）、`limit` | 单个 `dataset`，或 `datasets[]` 摘要 |
| `ask` | `need`(或 `text`/`utterance`/`query_nl`)、`dataset`、`intent{}`；可用 `template/contrast/case/control/paired/covariates/min_cells/fdr/scale` 覆盖草稿字段 | `status:'draft'`、`plan_id`、`confirm_token`、`plan`、`fields[]`、`missing_fields[]`、`questions[{field,question,candidates[]}]`、`candidates`、`dataset_match`、`warnings` |
| `plan` | `dataset`、`template`、`params{}`，常用顶层：`case/control/contrast/covariates/paired/seed/min_cells/method/fdr/alpha/enrich_db/cell_type_column/resolution`；自定义用 `steps[]`；`parent_run` | `plan_id`、`confirm_token`、`status(ready|blocked)`、`plan`（含 `steps/design/params/contrast/deliverables`）、`gates[]`、`blocking[]`、`rows[]` |
| `submit` | `plan_id`（省略则先 `plan`）、`confirm_token`、`start:false`（入队为 `pending_review`）、`wait`（CLI/测试默认 true）、`idempotency_key` | `run_id`、`run`、`status`、`reused`；`wait=true` 时附 `rows[]`（每步状态） |
| `runs` | `limit=30`、`status`、`dataset_id` | `runs[]`（不含步骤明细） |
| `run_status` | `run_id`（省略=最新一个） | `run{status,steps[],tables[],figures[],plan,manifest,run_dir,artifacts[],next,warnings}` |
| `cancel` | `run_id`、`reason` | `changed`、`status`；`changed:false` 时给原因（已是终态） |
| `export` | `run_id`、`out_path` | `export{files[],issues[],summary{files,bytes,verified},content_hash}`、`content_hash`、`bundle_dir`；哈希不一致列在 `issues`。`content_hash` 只由「文件路径+内容 sha256+manifest」决定、**不含 `exported_at`**，同一 run 反复导出恒定，可当结果包版本号 |
| `evidence` | 三种模式：① 默认列 `run_id`、`table_id`/`row_id`/`evidence_kind`/`contrast_id`、`limit`(≤2000)；② 校验 `verify:true`；③ 写入 claim：`claim`(或 `claim_text`，≥6 字) + `table_id` 或 `figure_id`(可带 `row_id`)、`pmids`(数组/逗号串/`PMID:` 前缀均可)、`evidence_kind`、`claim_id`、`contrast_id`、`added_by` | ① `file/records[]/total/truncated/counts{measured,descriptive,model_prediction}/zero_significant`；② `mode:'verify'`、`checked/issues[]/counts/with_pmids`；③ `mode:'claim'`、`claim_id/record/manifest{evidence_sha256,manifest_sha256,content_hash}`（写后会刷新 manifest 里 evidence 的哈希，避免 export 判 artifact_mismatch）。写入只允许 `succeeded/partial` |
| `methods` | `run_id`、`full:false`（截 4000 字） | `content`、`bytes`、`file` |
| `audit` | — | `score(0–100)/level(ok|warn|error)/checks[]`（store、run 状态一致性、artifact 哈希、插件协议、staging 残留、evidence 引用） |
| `suggest` | — | `suggestions[{id,title,detail}]`（按当前数据集/run 状态给） |
| `harmonize` | `dataset_ids[]`(≥2)、`method`（**必填** `none/scale_only/quantile/combat`）、`target_scale`（`counts/tpm/log_expression/zscore/none`）、`aggregate`（mean/max/sum）、`probe_map_file` | `run_id`、`status`、`method`、`batch_corrected`、`cross_dataset_inference_allowed`、`tables[]`、`warnings[]`、`next` |
| `joint` | `mode=meta`：`cohorts[{run_id,table_id?}]`(≥2)、`alpha`、`min_cohorts`；`mode=plot`：`runs[{run_id,table_id?}]`、`chart`、`value_column`、`feature_limit`；`mode=signature`：`dataset`、`sc_ref_path` 或 `sc_dataset_id`、`genes[]`、`scmap_params{}` | `run_id`、`status`、`tables[]`（meta）、`figures[]`（plot）、`evidence_kind:'model_prediction'`+warning（signature）；缺单细胞参考时签名模式返回 `status:'blocked'` |

错误统一形状：`{ok:false, error:<code>, message, details}`，抛错用 `storeError(code, message, details)`。常用 code：`bad_request` / `blocked` / `confirm_required` / `draft_changed` / `not_found` / `prerequisite` / `artifact_mismatch` / `bad_transition` / `cancelled` / `source_unavailable` / `unsupported`。（`register` 的样本冲突不抛错，返回 `status:'design_conflict'`。）

---

## 7. HTTP 路由

`index.js` 是唯一的路由层，全部前缀 `/bioflow`；除 `figures/`、`files/`、`catalog` 外都直接或间接走 `impl.runTool`，所以**页面 / 工具 / CLI 永远只有一套实现**。

| 路由 | 方法 | 行为 |
|---|---|---|
| `/bioflow/dispatch` | POST（也接受 GET `?action=`） | body 是 `{action, ...args}`，原样送 `impl.runTool`。主路径 |
| `/bioflow/catalog` | GET | `impl.buildCatalog(runtime)`：UI 首屏一次拿全——`version/platform/actions/templates[]/sources[]/plugins[]/workbenches{available,total,detail}/deliverables[]/gates[]/data_root/store_kind/counts{datasets,plans,searches,runs}/routes`。只做静态探测（`probePlugins` 不启动 Python worker） |
| `/bioflow/status` | GET | 等价 `{action:'status'}`（`/bioflow/` 也返回同一份路由清单） |
| `/bioflow/health` | GET | `{action:'health'}`；`?sources=geo,gdc` 过滤，`?sources=all` 表示全部 |
| `/bioflow/figures/<run_id>/<file>` | GET | 映射到 `<dataRoot>/runs/<run_id>/figures/<file>`，走 `resolveServedPath` 做路径越界检查 |
| `/bioflow/files/<rel>` | GET | `<rel>` 相对数据根解析（`decodeURIComponent` 后必须仍在 root 内且是文件），用于 manifest/results/evidence 下载 |

- 响应统一 `cache-control: no-store`；`figures`/`files` 按扩展名给 `content-type`（png/pdf/svg/json/tsv/jsonl/md/md/txt）。
- 错误码 → HTTP：`bad_request`/`blocked`/`confirm_required`/`draft_changed` → 400；`not_found` → 404；`source_unavailable` → 503；其余 500。body 是 `{error, message, details}`。
- `dispatch` 另外认 `/bioflow/api` 这个别名（历史兼容）；`/bioflow/` 会被根路由先接走，返回路由清单而不是 dispatch。

---

## 8. CLI 与工具的等价关系

`bin/bioflow.mjs` 就三件事：解析参数 → `impl.runTool(runtime, {action, ...args})` → 渲染/退出。

```
node bin/bioflow.mjs <action> [--k=v ...] [--json] [--data-dir=/abs/path]
```

- `<action>` 与工具 action **同名**；CLI 侧大小写不敏感、`-` 会归一成 `_`（`run-status` → `run_status`），另有 `help` 子命令打印用法。
- `--k=v` 的键名同样会把 `-` 换成 `_`（`--plan-id` → `plan_id`），值按 `true/false/null/数字/JSON` 尝试解析；
- runtime 的 `invocation='cli'` 让 `submit` 默认 `wait=true`（同步跑完再返回），Agent 调用默认不等待、`queue` 后靠 `run_status` 轮询；
- `--json` 输出原始 JSON，否则渲染 `summary` + 最多 40 行 `rows`；
- 退出码：成功 0；结果 `status==='blocked'` 或 `ok===false` → 2；抛错 → 2（错误 JSON 打到 stderr）。

自动化脚本里推荐直接 `status --json` / `plan --json` / `audit --json`，字段与工具返回一致。

---

## 9. 扩展方式

### 9.1 接一个新工作台插件

1. `lib/adapters.mjs`：`PLUGIN_META` 加 `{package, engine: 'lib/engine.mjs', python, label}`；`PLUGIN_IDS` 加 id；
   若该插件的 action 命名与引擎命令不一致，在 `CMD_ALIASES` 里加映射（现状：geobulk/spatial/metabolomics 走 `cmd_*`，singlecell 把 `samples` 拆 op，plotlab 的 cmd 名 = action，virtualcell 是 step 导向）。
2. 引擎必须满足契约（`REQUIRED_ENGINE_EXPORTS` / `REQUIRED_ENGINE_MEMBERS`）：`createEngine`、`pythonCandidates`、`probePython`、`findPython`、`prepareWorkdir`、`defaultWorkdir`；实例有 `workdir/dirs/request/start/dispose/status/progress/info/running/scriptPath`。不符 → `protocol_mismatch`（`status` / `audit` 会显示 reason）。
3. 若该插件的结果要进证据包：给它一个默认 `evidence_kind`（`plan.normalizeCustomSteps` 里 `virtualcell` 已默认 `model_prediction`，其余默认 `measured`），必要时在 `deliver.extractTables/extractFigures` 里补形状识别。
4. 若要在 UI/目录里露出：在 `buildCatalog` 里加一份描述（模板 id、数据源、高级动作）。

### 9.2 加一个模板

在 `lib/plan.mjs` 的 `TEMPLATES` 里加一项：

```js
'my-template': {
  id, version, title, description,
  data_kind, requires_kind: [...], requires_scale: [...],
  default_params: { seed: 0, ... },
  param_schema: { contrast: {type:'object', required:true, ...}, ... },
  buildSteps: (dataset, params) => [ /* step 数组 */ ],
  mandatory_gates: ['dataset_registered','sample_table','sample_identity','groups','contrast','replication','design_confounded','counts_verified','assay_supported','prerequisites'],
  // 可选：标注「不做组间推断」，对应闸门记为不适用（不是跳过）
  requires_contrast: false, requires_groups: false, requires_replication: false,
  inference: false,          // 纯描述性模板（如 plotlab-figure）
  evidence_kind: 'model_prediction', // 模板级证据类型兜底（如 virtualcell-perturb）
}
```

- step 里用 `deliver.kind` 告诉 deliver「这是 qc/design/de/figure/…」，可选步骤标 `optional:true`（失败只降级为 `partial`）；
- 需要前一步产物做输入时用 `requires:['prev_step']` + 参数里写 `$RUN_DIR/results/<file>`（`expandStepParams` 会替换）；
- 闸门不用自己写：`evaluateGates` 会自动跑全套，模板只声明哪些是强制的、哪些不适用（`requires_*`）；
- 模板版本参与幂等键，改行为要 `version+1`；加完模板后 `/bioflow/catalog` 与 `action=templates` 自动带上，不用改 UI。

---

## 10. 已知缺口与待办

- `test/` 目前为空：实现先落 `lib/`，回归用例待补（补上后 `node --test test/` 生效，`audit` 现在是确定性自检的兜底）。
- `client.js` 尚未随包提供：`package.json` 的 `exports["./client"]` 已指向它，`locale/*.json` 已按插件条目约定写好（`meta.title/description/detail` + `nav/title/subtitle` 及页面文案键），页面壳落地后直接消费。
- `pending_review` 状态目前没有「启动」入口：`submit start:false` 会把 run 入队为待核对，但 `opSubmit` 只认 `plan_id`，用 `run_id` 再提交会走成「重新 plan」（返回的提示也这么写，容易误导）。真要用这条路径，需要给 `opSubmit` 加 `run_id + start=true` 的分支并 `store.transition(queued)`。
- `inferDataKind` 只认 `rna_seq` 这类下划线写法：`assay=rna-seq` 会落到 `unknown` 并被 `assay_supported` 拦下（工具描述里写的是 `rna-seq`）。要么统一用下划线，要么在 `inferDataKind` 里先做 `-` → `_` 归一。
- `bin/bioflow.mjs` 顶部注释写「退出码 1 = 参数/内部错误」，实际只有 0（成功）与 2（被拦/失败/抛错）两种；以代码为准，注释待修。
- `GET /bioflow/` 根路由返回的 `routes` 清单还是 `['dispatch','status','figures','files']`，漏了 `catalog`/`health`/`api` 别名；以本文 §7 的表为准。
- 注入点未接线：`runtime.llmResolver`（自然语言兜底）、`runtime.pubmedForwarder`（把 PubMed 交给宿主的 pubmed 工具转发）、`runtime.adapterFactory`（测试替身）都只是 hook，`index.js` 没有注入任何实现，所以线上不会走 LLM 兜底、也不会复用宿主 pubmed 工具（内置 E-utilities 直连）。要启用就在 `apply()` 里按需挂上。
- `action=evidence` 的写/校验模式（`claim`/`verify`/`pmids`/`claim_id`/`figure_id`）在 `lib/impl.mjs` 已实现并可通过 CLI/HTTP 直接调，但 `bioflow` 工具的 `parameters` schema **没有暴露**这些字段，工具描述仍只写「证据索引」——agent 从工具表里看不到写证据能力。补 schema + 工具描述即可。
- 取消后同计划重提**不会**起新 run：幂等键不含 run 状态，`submit` 会命中那条已 `cancelled` 的记录并原样返回（`reused:true`）。而 `run_status` 的提示文案写的是「重新提交会创建新 run」，两处不一致。要真重跑得改参数/种子，或给取消路径加「幂等键 + attempt」。
- `datasets/`、`plans/` 目录建了但没落文件（记录都在 store 里）；如要做「可拷走的计划快照」，这两处是现成的落点。
- 本轮实测：`plotlab-figure` 在本地 3×4 小表上端到端成功（`open → plot → code`，六件套齐全、`evidence` 追加 claim + verify 通过、`export` 两次 `content_hash` 一致）；`bulk-two-group` 用同一小表跑到 `de` 因样本不足失败（run=failed、错误可诊断、无汇总层文件）。
- `spatial-domain` / `metabolomics-de` / `virtualcell-perturb` 三个模板还没有真实数据端到端跑过（真实队列验收在 M1/M2 阶段）；`mandatory_gates` 是否够严以实际跑批结果再调。

---

## 附录 · 交付时核对过的实现真相（2026-11-25）

- **跨进程可见性**：`lib/store.mjs` 的 SQLite 后端读走 `SELECT`（不是构造时的内存快照），JSON 后端按 `store.json`/`journal.jsonl` 的 size 变化重载；`PRAGMA busy_timeout=5000`。宿主进程与 CLI 共用一个数据根时，两边能互相看到 dataset/run。
- **证据写入**：`action=evidence` 支持写模式（`claim` + `table_id`/`row_id`/`figure_id` + `pmids`）与 `verify:true`；追加后会重算 `evidence.jsonl` 的 sha256、manifest `content_hash` 与 run.artifacts，导出哈希校验仍通过。
- **失败交付**：必选步骤失败也会调用 `finalizeRun(status=failed)`，落 manifest/design/qc/evidence/methods，并记录失败步骤与原因；取消仍是**零写入**。
- **重试语义**：幂等键对 `failed`/`cancelled` 的同参数 run 自动加 `#retryN`，产生新 run；成功的 run 仍严格复用。
- **导出**：`content_hash` 只由「路径 + 文件 sha256 + manifest_sha256」决定（不含 `exported_at`），并 append 到 `<dataRoot>/exports.jsonl`，可用 `export_id` 重启后回查。
- **PubMed 转发**：`ensurePubMedForwarder(runtime)` 在宿主存在 `pubmed` 工具时装上转发器（`via=dsh-pubmed`），失败自动回退内置 E-utilities。
- **插件侧已知问题（bioflow 不改它们，只做兼容）**：
  - `dsh-metabolomics` `mb_registry.build_dataset`：传 `group_col` 会把 DataFrame 当函数调（`TypeError: 'DataFrame' object is not callable`）→ 模板改为 open 不传 group_col，分组走 `samples(op=update)`；
  - `dsh-metabolomics` `de` 只接受 `limma/welch/wilcoxon`（`auto` 报未知方法）→ 模板只在显式给受支持方法时透传；
  - R `ropls::opls` 要求样本行数 > 交叉验证折数，4 样本时 PLS-DA/VIP 失败（optional 步骤 → run=partial，原因可见）；
  - `dsh-geobulk` / `dsh-singlecell` / `dsh-spatial` 的步骤前置链必须补全（geobulk: qc→filter→normalize→de；singlecell/spatial: normalize→hvg→pca→neighbors→cluster）。
