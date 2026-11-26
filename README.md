# 许愿式生物信息全自动分析平台（Bioflow）

**一句话**：把「单细胞 / Bulk / 绘图 / 虚拟细胞 / 空间 / 代谢」六个工作台收进同一个大门口。你用一句中文许愿，它把这句话变成**可回查的冻结计划**，跑成**不可变的 run**，最后交出一份**证据包**——每个数字都能顺着 `run_id → table_id → row_id → figure_id` 查回源表。

它不自己重算生物学：分析交给六个工作台各自的引擎（Python/R），Bioflow 只负责「找数据 → 登记版本 → 定统计设计 → 过闸门 → 编排步骤 → 归档证据」。

---

## 论文拆图（paper_figures）

给一个 PMID（走 PMC 开放全文）、DOI、本地 PDF 路径，或直接粘贴图注，返回：

- 图注原文 + 识别出的图型（KM/森林/火山/热图/UMAP/富集/空间/ROC/箱线…）
- 需要的数据与建议模板（`bulk-two-group` / `scrna-composition` / `spatial-domain` / `plotlab-figure`）
- `plotlab` 图表 id 与角色建议（能直接出图的）
- 一句可执行的 `wish_text`（含原图注，可回查）

**真正看图（多模态）**：给一张论文截图（PNG/JPEG/WebP，UI 直接选文件，或 `image_path`/`image_base64`），
`figure_from_image` 会把图片交给宿主当前的多模态模型（`ctx.get('llm')` + `attachments.saveImage`），
返回图型、横纵轴、分组/颜色、图里能看到的统计信息、需要的数据与可执行许愿；图片保存在 `<数据根>/uploads/figures/` 留痕。
模型不支持图片输入时会明确报 `unsupported`，不会退化成瞎猜。

**整篇 PDF（上传/拖拽）**：`paper_pdf` 接 PDF 上传（UI 支持拖拽或选文件），用 PyMuPDF 抽每页图注 + 内嵌位图
（带页码与 bbox，抽出的图保存到 `uploads/figures/`），并对前几张图跑多模态识别；矢量图/扫描版抽不到位图时
退化为图注拆解并写明原因。实测 2.6 MB、13 页论文 → 8 张图（图注+图+多模态描述）。

说明：图注拆解只读文字；`unknown` 一律如实返回，不硬编。CLI：
`node bin/bioflow.mjs paper-figures --paper-pmid=<PMID>` 或 `--figure-caption="Figure 2. Kaplan-Meier …"`。

---

## 装了什么

| 入口 | 形态 | 说明 |
|---|---|---|
| **`bioflow` agent 工具** | 对话里调用 | 30 个 action，和页面按钮、CLI 共用同一份 `lib/impl.mjs` |
| **`bioflow` CLI** | `bin/bioflow.mjs` | 同一套函数、同一份数据根，适合脚本与排查 |
| **HTTP 路由** | `/bioflow/*` | `dispatch` / `catalog` / `status` / `health` / `figures/<run_id>/<file>` / `files/<rel>` |
| **左侧栏整页 UI** | 淡蓝/天蓝科幻风 | 「许愿式生物信息分析」整页：左栏许愿、中栏计划与流水线、右栏数据源/下载/产物证据；规格见仓库根 [`BIOFLOW_UI_SPEC.md`](../../BIOFLOW_UI_SPEC.md) |

> 浏览器侧入口文件是 `client.js`（`package.json` 的 `exports["./client"]` 指向它）。当前 checkout 若还没包含 `client.js`，工具与 CLI 覆盖全部能力，只差那一层页面壳。

`bioflow` 工具的 30 个 action，一句话版：

| action | 一句话 |
|---|---|
| `status` | 工作台状态：数据根、数据集/计划/run 数量、六个兄弟插件是否可用 |
| `templates` | 可用模板 + `harmonize`/`joint` 高级方法清单 |
| `search` | 五源检索，返回统一 item、`sources_ok`/`sources_failed`、provenance、`search_id` |
| `source_detail` | 单条记录详情（GDC 会带 STAR counts 文件与临床字段） |
| `health` | 五个数据源健康灯（ok/slow/down + 延迟）+ 插件协议检查 |
| `download` | 统一下载：断点续传、限流、sha256/md5、同 hash 复用，落 artifact 表 |
| `register` | 登记本地文件或 artifact 链，冻结 assay/尺度/样本表/临床与数据集 revision |
| `datasets` | 列出/读取已登记数据集 |
| `ask` | 自然语言许愿 → **draft 计划**（永不直接执行），缺字段给最少的问题与候选 |
| `plan` | 结构化计划：跑闸门，`status=ready` 才可提交 |
| `submit` | 提交（必须带 `plan_id` + `confirm_token`；CLI 默认等执行完） |
| `runs` / `run_status` | 队列与单个 run 的步骤、产物、失败原因、下一步建议 |
| `cancel` | 取消：清理 staging，**零产物写入** |
| `export` | 结果包 + 逐文件哈希校验 + 稳定的 `content_hash`（同一 run 反复导出恒定，可当版本号），可复制到指定目录 |
| `evidence` | 证据索引（measured / descriptive / model_prediction 分开计数）；可写 claim（绑定 `table_id`/`row_id`/`figure_id` + `pmids`）并 `verify:true` 复核引用 |
| `methods` | 读回 `methods.md` |
| `audit` | 确定性自检（状态一致性、产物哈希、evidence 引用、插件协议、staging 残留） |
| `suggest` | 基于当前状态建议下一步 |
| `harmonize` | 多数据集特征对齐 + 批次评估 + **显式**批次校正 |
| `joint` | 联合分析：`meta` 多队列合并 / `plot` 统一走 PlotLab / `signature` 跨模态签名（模型预测） |

---

## 六个工作台 = 六个模板

模板把「哪个工作台、什么数据、跑哪几步、哪些闸门必须过」固化下来；具体清单以 `bioflow action=templates` 的返回为准（模板版本随计划一起冻结）。

| 模板 id | 工作台 | 做什么 |
|---|---|---|
| `bulk-two-group` | GEO Bulk | 两组或配对差异表达（对比方向必须明确）→ 功能富集 |
| `scrna-composition` | SingleCell | 样本级细胞类型组成检验 + 指定细胞类型的供体 pseudobulk |
| `spatial-domain` | Spatial | QC → 聚类 → Moran's I 空间高变基因 → 空间域 → 空间图（**描述性**，不做组间推断） |
| `metabolomics-de` | Metabolomics | 特征表导入 → QC/归一化 → 差异代谢物 → 通路富集 → 标志物筛选 |
| `virtualcell-perturb` | VirtualCell | 状态表征 → GRN → 虚拟扰动 → 扰动响应图（下游结论全部 `model_prediction`） |
| `plotlab-figure` | PlotLab | 任意已登记表格 → 出版级图（300 dpi PNG + plot data）+ 可复现代码（描述性，不做统计推断） |

后三个模板在模板层就声明了「不做组间推断」，所以分组/对照/生物学重复不构成闸门（`plotlab-figure` 连表达尺度也不要求）；这是**模板声明的例外**，不是闸门被绕过。

---

## 五个公共数据源 + 统一整备

- **GEO**（GSE，插件引擎优先，内置 NCBI E-utilities 回退）
- **PubMed**（E-utilities：esearch/esummary/efetch，结果缓存，限速）
- **GDC / TCGA**（projects / files / cases，STAR counts + 临床随访）
- **MetaboLights**（EBI，代谢组研究；较慢）
- **CELLxGENE**（默认**关闭**，实测 30–60s，显式开启）

四层整备，全部落在同一个 run 体系里：

1. **统一检索**：五源各自超时、各自失败，合并成同一种 item（`id/title/species/n_samples/platform/scale/attachments/clinical_available/evidence_strength/provenance`），并落 `search_id`。
2. **统一下载**：断点续传 + 限流 + 哈希校验 + 同 hash 复用；结果进 artifact 表（内容寻址），后续只用 `artifact_id` 引用，不再猜路径。
3. **`harmonize`**：多数据集先对齐特征 ID/探针与尺度，报告对齐率与丢失；批次评估前后各一次；校正方法必须显式（`none` / `scale_only` / `quantile` / `combat`）。**未校正时禁止跨数据集合并推断**（`cross_dataset_inference_allowed=false`）。
4. **`joint`**：`meta`（逐队列效应 → fixed/random 合并，报 I²、异质性与每队列 n）、`plot`（统一走 PlotLab，面板与统计表同源）、`signature`（bulk 签名映射到单细胞，**模型预测**，不是实验结论）。

---

## 快速开始

### ① 对话里用工具（Agent 视角）

```text
bioflow action=search term="gastric cancer liver metastasis" sources=["geo","gdc"] limit=5
bioflow action=download source=geo id=GSE84433
bioflow action=register path=/abs/data/GSE84433/matrix.tsv sample_sheet=/abs/samples.tsv \
        scale=counts verified=true assay=rna_seq group_column=group donor_column=donor
bioflow action=ask need="把肿瘤和正常比差异表达，做 KEGG 富集，出图"
bioflow action=submit plan_id=<ask 返回的 plan_id> confirm_token=<ask 返回的 confirm_token>
bioflow action=run_status run_id=<run_id>
bioflow action=export run_id=<run_id> out_path=/abs/out
```

`ask` 只给 **draft·待确认** 计划卡，不会自己开跑；确认后才 `submit`。

### ② 命令行（同一套实现）

```bash
# 数据根默认 ~/.dsh/bioflow，可用 --data-dir 指定
node plugins/dsh-bioflow/bin/bioflow.mjs register \
  --path=/abs/matrix.tsv --sample-sheet=/abs/samples.tsv \
  --group-column=group --donor-column=donor \
  --scale=counts --verified=true --assay=rna_seq

node plugins/dsh-bioflow/bin/bioflow.mjs plan \
  --dataset=ds_xxxxxxxxxxxxxxxx --template=bulk-two-group \
  --case=tumor --control=normal --json

node plugins/dsh-bioflow/bin/bioflow.mjs submit \
  --plan-id=<plan_id> --confirm-token=<confirm_token>

node plugins/dsh-bioflow/bin/bioflow.mjs run_status --run-id=<run_id>
node plugins/dsh-bioflow/bin/bioflow.mjs audit --json
```

CLI 子命令就是 action 名（`run_status` 和 `run-status` 两种写法都认，内部统一转下划线；`node plugins/dsh-bioflow/bin/bioflow.mjs help` 看用法）：`status | templates | search | source_detail | health | download | register | datasets | ask | advise | topics | paper_figures | figure_from_image | paper_pdf | plan | submit | runs | run_status | cancel | export | evidence | methods | audit | suggest | suggest_next | harmonize | joint | delete | trash | settings`。退出码：`0` 成功；`2` 被闸门拦下或执行失败（stdout/stderr 里带原因）。

### ③ 页面（左侧栏整页）

左侧栏点「许愿式生物信息分析」→ 左下许愿框里写人话，例如：

```text
拿 GSE84433 的胃癌肝转移，按 NK 比例和原发比一下，出图
```

出的是 **draft 计划卡**（标 `draft·待确认`），字段逐条可改、缺字段给候选；点「确认并提交」后出现 `run_id`，中栏时间线逐步推进，右栏出 `figures/` 缩略图与 evidence 条目。

---

## 硬规则摘要

1. **闸门真拦**（六条硬闸门，`status=blocked` 就是不能提交）：

   | 闸门 | 含义 |
   |---|---|
   | `sample_table` | 样本表未知（没有 `design.samples`）→ 拦 |
   | `counts_verified` | 数据尺度未验证（没显式声明 `scale` + `verified=true`）→ 拦 |
   | `replication` | 每组独立生物学重复 `n<2`（配对设计要求 ≥2 对跨组配对）→ 拦 |
   | `design_confounded` | 分组与批次/协变量完全共线，模型不可识别 → 拦 |
   | `contrast` | 对比方向未定义（`{case, control}` 必须同时给且不同）→ 拦 |
   | `prerequisites` | 缺前置产物或父 run 未成功 → 拦 |

   另有 `dataset_registered` / `sample_identity` / `groups` / `assay_supported` 等基础闸门同样参与强制判定；`seed` 始终记录。零显著**不是**闸门（分析成功但没显著结果照常交付，并在 manifest 标 `zero_significant=true`）。
   例外只有一种，且写死在模板里：`spatial-domain` / `virtualcell-perturb` / `plotlab-figure` 声明不做组间推断，因此 `groups` / `contrast` / `replication`（`plotlab-figure` 还含 `counts_verified`）不构成闸门——它们在结果里显示为「该模板不需要」，而不是被跳过不记。

2. **任何一步失败都不得整体 `ok:true`。** 必需步骤失败 → run 直接 `failed` 并保留错误；只有可选步骤失败才是 `partial`。
3. **取消零写入。** 取消后清空 staging，不写 `results/`、`figures/`、`manifest.json`；已终态的 run 拒绝再写产物。
4. **模型预测单独标。** VirtualCell 扰动、跨模态签名映射等一律 `evidence_kind=model_prediction`，不得混进实测证据，稿件不能直接当实验结果引用。
5. **计划冻结、run 不可变。** 计划带 `confirm_token`；确认前改任何字段都会换 token（提交时报 `draft_changed`）。同输入同参数靠幂等键复用一个 run，不会重复计算。

---

## 交付物（六件套）

每个 run 的产物都在 `~/.dsh/bioflow/runs/<run_id>/`，文件逐个记账（sha256 + 字节数），`export` 时再校验一遍。

| 文件 | 一句话 |
|---|---|
| `manifest.json` | run 身份证：schema、`run_id`、数据集 revision 与输入文件哈希、环境与插件版本、参数、种子、每步状态、warnings、闸门、产物哈希清单与 `content_hash` |
| `design.tsv` | 样本设计：sample / 分组 / 供体 / 批次 / 配对 / 材料、`role=case\|control\|other`、每组样本数与供体数、是否纳入及排除原因 |
| `qc.tsv` | 质控长表：QC / 过滤 / 标准化 / 聚类等步骤的指标，带 `table_id` + `row_id` |
| `results/*.tsv` | 全量受检结果：稳定 `table_id`/`row_id`、`contrast_id`、效应量与单位、SE/CI、p/q 与 FDR family、有效 n；零与 NA 分开；另有 `results/tables.index.json` 与逐字节保存的 `results/steps/<step>.json` |
| `figures/` | 300 dpi PNG（图内文字英文）+ 有出图数据时附同名 `.plotdata.json`；`results/tables.index.json` 里每图记 `figure_id`、`title`、`dpi`、`source_table_ids`、sha256；图注的 n、分母、方向与源表一致 |
| `evidence.jsonl` + `methods.md` | claim 索引（`run_id/table_id/row_id/figure_id` + `evidence_kind`，可再绑 PMID）+ 可直接进论文的英文 Methods 段落；`export` 会给整个结果包一个稳定 `content_hash` |

**只有 `succeeded` / `partial` 的 run 才有完整六件套。** `failed` 的 run 会保留失败前已完成步骤的 `results/*.tsv`、`results/steps/<step>.json`、`figures/` 供诊断，但没有 `manifest.json` / `design.tsv` / `qc.tsv` / `evidence.jsonl` / `methods.md`（`evidence`/`methods` 会报 `prerequisite`）；`cancelled` 的 run 零产物。

论文/图表流程请只读 `evidence.jsonl` + `results/*.tsv` 取证；探索性结果和模型假说可以进讨论，但稿件 Results 只引用 `measured` 且能回查的条目。

---

## 常见问题

**Q1：左侧栏没有入口、对话里也没有 `bioflow` 工具，怎么诊断？**
先看装没装、有没有重载宿主：`node plugins/dsh-bioflow/bin/bioflow.mjs status --json` 能跑说明代码没问题；再 `curl -s http://127.0.0.1:<GUI端口>/bioflow/status`——404 基本等于插件没被 profile 加载。安装步骤见 [INSTALL.md](INSTALL.md)。

**Q2：报「Python 未就绪 / 插件不可用」怎么办？**
`bioflow action=status` 的 `plugins[]` 里每个工作台都有 `available` 与 `error`；`action=health` 再看数据源。Python 找不到时在插件配置里给绝对路径（或按各工作台文档设环境变量）。**没装 Python 也能用**：检索、登记、计划、闸门、审计都是纯 Node（GDC/CELLxGENE 的下载走 HTTP；GEO/MetaboLights 的下载要借对应工作台引擎），只有真正跑分析的步骤会 `failed`/`blocked`，且错误可诊断。

**Q3：Europe PMC 老是超时，是不是坏了？**
不是。Europe PMC 本机实测约 8s 超时，所以默认关闭（`europepmc=false`），只查 PubMed；要查就显式打开，失败只记 warning，不影响其它源。CELLxGENE 同理：默认关闭，开启后请按 30–60s 预期等待。

**Q4：为什么图在 `~/.dsh/bioflow/runs/<run_id>/figures/`，而不是某个临时目录？**
因为交付物必须能回查：一个 run 一个目录、文件带哈希、被 `manifest.json` 记账，`export` 时才整体复制出去。上游工作台的临时 workdir 每个 run 独立创建、跑完销毁，**不会**被当成交付目录。

**Q5：计划为什么被 `blocked`？**
看 `plan` 返回的 `blocking`：缺样本表就补 `sample_sheet`/`samples`；尺度没验证就 `scale=counts verified=true`；每组只有 1 个样本就补重复；批次与分组完全共线就去掉批次列或换设计；对比没写清楚就给 `{case, control}`。

**Q6：同一批数据重跑会不会重复算一遍？**
不会。幂等键吃 `dataset revision + 计划 + 模板版本 + 参数 + 种子 + 步骤`，同参数同输入直接返回已有 `run_id`（`reused=true`）。要真重跑就改参数或种子。

---

## 目录

```text
index.js              Host 入口：/bioflow/* 路由 + bioflow 工具 + prompt section（薄壳）
lib/impl.mjs          全部 action 实现（HTTP / 工具 / CLI 共用）；run 执行器与闸门提交
lib/plan.mjs          模板、闸门评估（纯函数）、计划构造
lib/adapters.mjs      六个工作台引擎适配（每 run 每插件一个临时 worker）
lib/deliver.mjs       交付物生成（staging → commit → manifest/design/qc/evidence/methods）
lib/evidence.mjs      证据索引与引用校验
lib/store.mjs         存储（node:sqlite 优先、JSON 兜底）、状态机、哈希与原子写
lib/search.mjs        多源检索编排 + 下载任务 + 文件冻结校验
lib/sources.mjs       五源统一客户端与健康灯
lib/pubmed.mjs        PubMed E-utilities 客户端（缓存/限速/放宽检索）
lib/download.mjs      统一下载器（断点/限流/哈希/复用）
lib/harmonize.mjs     多数据归一化与显式批次校正
lib/joint.mjs         meta 合并 / 联合出图数据 / 签名映射
lib/intent.mjs        自然语言 → intent → draft 计划（规则优先，LLM 可选兜底）
bin/bioflow.mjs       CLI（与工具同一个 runTool）
locale/zh.json|en.json 插件条目与侧边栏文案
icon.svg              侧边栏图标（48×48，淡蓝天蓝）
docs/DETAIL.md        维护者文档：模块分工、状态机、路由、扩展方式
```

## 相关文档

- [INSTALL.md](INSTALL.md) — 安装、依赖、验证命令、卸载、数据根清理
- [docs/DETAIL.md](docs/DETAIL.md) — 维护者细节：状态机、每个 action 的参数与返回、路由、扩展
- 仓库根 [`BIOFLOW_UI_SPEC.md`](../../BIOFLOW_UI_SPEC.md) — 页面规格与验收清单
- 仓库根 [`BIO_P0_BACKLOG.md`](../../BIO_P0_BACKLOG.md) §7 — 统一入口与任务执行的原始约定

## License

MIT
