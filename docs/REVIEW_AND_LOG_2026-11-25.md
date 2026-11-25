# dsh-bioflow 开发记录：许愿式生物信息全自动分析平台

> 记录时间：2026-11-25 深夜（Asia/Shanghai）
> 插件目录：`plugins/dsh-bioflow`（工具名 `bioflow`，数据根默认 `~/.dsh/bioflow`）
> 产品名：**许愿式生物信息全自动分析平台**

---

## 0. 一句话结论

把「六个工作台（geobulk / singlecell / spatial / metabolomics / plotlab / virtualcell）」包成一个统一入口：
**自然语言许愿 → 自动挑数据（中文摘要弹窗）→ draft 计划（字段先提案、人只检查）→ 不可变 run → 交付物与证据链**；
支持 **多数据集合并**（同类型先去批次再合并、不同类型一脉相承）与 **问题入手**（临床现象 → 文献/队列核实 → 思路链）。

---

## 1. 背景与目标

- 用户诉求：一个「大门口」——接上现有的单细胞 / bulk / 绘图 / 虚拟细胞 / 空间 / 代谢六个工作台；
  能接 PubMed、GEO、TCGA/GDC、MetaboLights、CELLxGENE；统一下载；多数据归一化与联合分析出图。
- 不是「再写一个分析脚本」：**分析仍由六个插件引擎执行**，bioflow 只做编排、计划、闸门、交付与证据。
- 三条硬约束（贯穿始终）：
  1. 每个 run 每个插件起一个临时 worker（`<runDir>/engines/<plugin>`，结束 / 取消统一 dispose）；
  2. 不重算分析：step = `{plugin, action, params}` 透传给插件引擎，原始返回存档再抽表；
  3. 闸门真拦：样本表未知 / 尺度未验证 / 每组 n<2 / 完全混杂 / 缺对照方向 / 缺前置产物 → `blocked`；
     任何一步失败不得整体 `ok:true`；取消零写入；模型推演标 `model_prediction`。

---

## 2. 交付物清单

```
plugins/dsh-bioflow/
  package.json            # name=dsh-bioflow；exports "./client"；dsh.client(web)；bin=bioflow
  cordis.patch.yml        # insert id/name=dsh-bioflow
  index.js                # /bioflow/* 路由 + bioflow 工具 + prompt section + 卸载 dispose
  client.js               # 前端整页（三模式 + 数据向导 + 工作区看板；纯 require('react')）
  bin/bioflow.mjs         # CLI（与工具/HTTP 同一 runTool）
  lib/
    impl.mjs              # 24 个 action 的实现（唯一操作实现）
    adapters.mjs          # 六插件 engine 适配层（动态 import + 容错 + per-run worker）
    plan.mjs              # 6 个模板 + 12 条闸门 + 步骤冻结
    deliver.mjs           # manifest/design/qc/results/figures/evidence/methods
    store.mjs             # 状态机 + 幂等 + 内容寻址 + JSON/SQLite 双后端
    evidence.mjs          # claim 索引与引用校验
    search.mjs            # 统一检索/下载前置
    sources.mjs           # GEO / PubMed / GDC / MetaboLights / CELLxGENE
    pubmed.mjs            # NCBI E-utilities + Europe PMC + 缓存/限速/宿主转发
    harmonize.mjs         # 多数据集特征对齐 + 批次评估 + 校正
    joint.mjs             # meta / plot / signature
    intent.mjs            # 自然语言 → intent / draft
    download.mjs          # 统一下载（断点/限流/哈希/复用）
  locale/{zh,en}.json     # 侧栏与页面文案
  docs/DETAIL.md          # 维护者文档（含本轮实现真相附录）
  test/                   # 9 个测试文件（node:test，全部离线）
```

侧栏入口：`sidebar.panellist` id=`bioflow`，label=**许愿式生物信息全自动分析平台**，main 页 key=`bioflow`。
已接入宿主 profile：`~/.dsh/profiles/desktop/node_modules/dsh-bioflow` 软链 +
profile `package.json` 的 `dependencies` / `dsh.profile.bundles`。

---

## 3. 整体逻辑链

```
             ┌──────────────── 输入层（三个模式 + 数据向导）────────────────┐
             │ 许愿        疾病引导                问题入手                 │
             │ 一句话  →  疾病+主队列+追加数据  →  临床现象→查文献/队列     │
             │            (同类型去批次 / 异类一脉相承)  → 候选临床问题     │
             └───────────────┬──────────────────────────────────────────────┘
                             ↓
   advise（AI 挑数据）→ 候选数据集（中文摘要：物种/样本/模态/分组/矩阵/临床/适合/风险）
                             ↓
   ask：自动选数据集 + 自动判对照 + 模板与模态对齐 → draft 计划（人只检查）
                             ↓
   plan：冻结计划（模板步骤 / contrast / design / seed / FDR family / 产物清单 / 闸门）
                             ↓
   submit（confirm_token）→ run（每插件临时 worker）→ steps → results/figures/evidence/methods
                             ↓
   export（content_hash + 导出记录）· evidence（claim + PMID）· methods
```

多数据集分支：

```
两个以上「同类型」队列（如多个 bulk）
  → harmonize（quantile / combat / scale_only；特征对齐 + 批次评估）
  → 登记「合并数据集」ds_harm_xxx（矩阵方向=基因×样本，样本表带分组）
  → plan dataset=ds_harm_xxx → 继续跑（实测 7/7 步 succeeded）

「不同类型」队列（bulk + 单细胞 / 空间 / 代谢）
  → 不做跨模态合并推断，按「一脉相承」：
     单细胞：主队列差异/签名 → joint signature 映射（model_prediction）
     空间  ：空间域/反卷积与主队列互相印证
     代谢  ：通路层面正交验证
     bulk  ：独立验证队列，分别分析后 joint meta 合并效应
```

---

## 4. 本轮对话需求 → 改动映射

| # | 用户反馈 / 需求 | 落地改动 |
|---|---|---|
| 1 | 插件要有左侧栏入口、淡蓝天蓝科幻感 UI | `client.js` 整页 + 侧栏槽位 + 设计令牌；后续按反馈重做视觉（极光底、玻璃面板、去掉方格底纹） |
| 2 | 侧栏名字不对 | `DICT_ZH.nav` 由 `Bioflow` 改为「许愿式生物信息全自动分析平台」；locale 同步 |
| 3 | 「我在哪许愿？」输入在页面最底部、和引导分离 | 左栏上半改为「许愿台」：例子 + 常用套路 + 自定义套路 + 输入框在同一块；Enter 发送 / Shift+Enter 换行 |
| 4 | 风格丑，要有美感的科幻感 | 页面极光渐变、面板玻璃化 + 发光发丝线、聊天气泡（用户右/Bioflow 左）、渐变发送键；参考 morph / snakefront / depictio / graphsight |
| 5 | 布局应「一半许愿+引导，一半进度+可视化」 | 两栏：左许愿/引导/历史，右进度看板（KPI + 进度条 + 流水线节点 + 计划卡 + 时间线 + 产物/数据源/下载/联合分析/AI 挑数据 Tab） |
| 6 | 历史/结果可删除、可指定输出位置 | 新增 `delete`（run 默认进 `trash/runs`、`purge=true` 彻底删；dataset 需 force；export 记录可删）与 `settings`（`output_dir`/`download_dir`，export 默认输出到这里）；UI 历史每条带删除、进度区带输出目录与导出按钮 |
| 7 | 多数据集联合分析 / 样本量不够要合并 | harmonize 成功后登记「合并数据集」`ds_harm_*`；联合分析 Tab 支持多选数据集归一化 + 多 run meta/plot；合并后可直接 plan 继续跑 |
| 8 | 许愿后还要手填尺度/分组/对照 | register 未给 scale 时**自动探测**（整数→counts、负值/小量级→log、非整数→normalized）；数据只有两组时**自动判对照**；模板与数据模态不匹配时**自动回退** |
| 9 | 许愿后「啥都没有」，我的数据集呢？ | ask 自动选最可用的已登记数据集（有≥2组/样本多/尺度已验证优先）；返回 `dataset_options` 与中文摘要；draft 直接 ready |
| 10 | 自动挑数据集应弹窗 + 中文总结 | 新增「候选数据集（中文摘要）」弹窗：来源/编号/物种/样本量/模态 + 中文概括 + ✓适合/⚠风险 + 「用这个数据集出计划」；`summary_zh` 由后端生成 |
| 11 | 疾病引导只有几个病，要能自己输入 | 疾病改为自由输入（datalist 建议，可任意病种/场景），预设只是快捷填入 |
| 12 | 疾病引导要能「＋追加数据」并区分同类型/不同类型 | 主队列选择 + `＋追加数据`；同类型标黄「需去批次」并强制 harmonize（可选方法，一键先合并再出计划）；不同类型标蓝「一脉相承」并给出对应串联说明；许愿文本自动写明处理方式 |
| 13 | 问题入手模式要有提示 + 热门临床现象 | 新增 `topics` 动作：模板候选临床问题 + 近两年 PubMed 综述/系统综述热点（中文概括 + PMID），点选填入「现象」；随后可查文献与队列核实 |
| 14 | 思路链独立页面（问题→假设→证据→预期） | `#/logic` 独立页，四块可编辑、保存 localStorage、复制 Markdown、带回许愿 |
| 15 | GitHub 同步 | 受网络/代理限制未完成（见 §9）；本地已可提交 |

---

## 5. 关键实现与本轮修掉的真 bug

### 5.1 编排与执行
- `executeRun`：per-run adapter 缓存、`finally` 统一 dispose、取消零写入（staging 清理）、必选步骤失败仍写**失败版 manifest/design/qc/methods**。
- 修复 `adapter.invoke(step.action, step.params)` 误用未展开参数 → 改用 `expandedStep`（joint plot 的 `$RUN_DIR` 才能展开）。
- 内置步骤（harmonize / meta_analysis / joint_prepare）自拷贝 bug：`copyIntoStaging` 在 `source===dest` 时不再 copyFile。
- joint 表与 artifact 同路径冲突（ENOENT）→ 表 id 改为 `joint_plot_table`，staging 做路径去重。
- joint 列名归一化：`P.Value` / `adj.P.Val` 等可识别。
- 失败/取消后允许重试：幂等键对 `failed/cancelled` 自动加 `#retryN`，成功 run 严格复用。
- `pending_review` 死状态：`submit run_id=...` 可续跑排队 run。

### 5.2 多数据集合并（核心修复）
- **根因**：`harmonize` 的 `transpose` 语义与各插件相反。`dataset.transpose=true` 表示文件是「特征×样本」，而 harmonize 内部原生就是特征×样本，却把 `true` 又当「需要转置」，导致合并矩阵把**特征名写进样本列**（`ds_xxx:G0000…`），合并后 300 个“样本”、分组全空。
- **修复**：`opHarmonize` 传 `transpose: !dataset.transpose`。
- **合并数据集登记**：读合并矩阵表头取样本名 → 回填原数据集分组（支持 `ds:ID` 前缀/后缀匹配、单组回填）→ 写 `datasets/ds_harm_*/harmonized_matrix.tsv` + `samples.tsv` → 写 dataset manifest（transpose=true、scale 映射 `target_scale`、`design.samples` 带 group/donor）。
- **验证**：两个 bulk → harmonize(quantile, log_expression) → `ds_harm_...`（10 样本、tumor/normal）→ plan ready → submit **7/7 步 succeeded**，manifest/design/qc/results(3 表)/figures(9 图)/evidence(41 条，20 条 measured)/methods 齐全，31 个 artifact。
- 回归测试：`test/harmonize_merge.test.mjs`（纯 JS，不启 Python）。

### 5.3 许愿自动化
- `ask`：无匹配数据集时自动挑「最可用」已登记数据集（组数/样本量/尺度加权），返回 `dataset_match.auto_selected` 与 `dataset_options`（含中文摘要）。
- 模板与模态对齐：话里说「NK 细胞」但数据是 bulk → 自动回落 `bulk-two-group`。
- 对照自动判定（仅两组）：词义优先（肿瘤/转移/耐药 vs 正常/邻癌/对照），其次名称排序。
- `register` 自动探测矩阵方向（表头 vs 样本表匹配）+ 自动探测尺度（未显式给 scale 时）。

### 5.4 数据与检索
- 跨进程读一致性：SQLite 后端直读（不再用构造时内存快照）、JSON 后端按文件大小变化重载、`busy_timeout=5000`；宿主与 CLI 共用数据根能互相看到。
- PubMed：E-utilities + 缓存 7 天 + 令牌桶（无 key 3/s、有 key 10/s）+ provenance；
  宿主有 `pubmed` 工具时优先转发（`via=dsh-pubmed`），失败回退内置。
- `advise`：确定性打分（点名/标题命中/人源/样本量/矩阵/临床/尺度/模态），每条给「为什么/风险」，并给推荐模板、要盯的闸门、多队列合并建议、下一步命令。
- `topics`：中文疾病名→英文检索词，返回模板临床问题 + 近两年综述热点。

### 5.5 已知的插件侧兼容（bioflow 不改它们的代码）
- `dsh-metabolomics`：传 `group_col` 给 open 会触发 `TypeError: 'DataFrame' object is not callable`（`mb_registry.py:1483`）→ 模板不传 group_col，分组走 `samples(op=update)`。
- `dsh-metabolomics`：`de` 只接受 `limma/welch/wilcoxon`，传 `auto` 报未知方法 → 只透传受支持方法。
- R `ropls::opls` 要求样本行数 > CV 折数：4 样本时 PLS-DA/VIP 失败（optional → run=partial，原因可见）。
- geobulk：`de` 前置 `filter→normalize`；singlecell/spatial：`cluster` 前置 `neighbors`（模板已补全依赖链）。

---

## 6. 验证证据

### 6.1 自动化测试（`node --test plugins/dsh-bioflow/test/*.test.mjs`）
```
ℹ tests 59   ℹ pass 58   ℹ fail 0   ℹ skipped 1（live PubMed，默认不联网）
```
覆盖：store 状态机/非法迁移/幂等/取消零写入/重启读回/内容寻址、register 同字节幂等/改字节新 id、
plan 闸门（n=1、完全混杂、缺 contrast、零显著放行）、deliver stub adapter 六件套+sha256、
export 双次同 hash+重启可查、pubmed 归一化/缓存/TTL/限速/provenance、模板结构 6 模板+依赖顺序+model_prediction、
工具接线 8 项（schema/prompt/catalog/未知 action/证据绑定/宿主 pubmed 转发）、合并数据集全链路。

### 6.2 真实引擎运行（本机 Python 3.14.2）
- 两个 bulk → harmonize → `ds_harm_f69214c24132` → plan ready（12 闸门全过）→ submit：**open/design/qc/filter/normalize/de/enrich 全 ok**。
- 产物：manifest（status=succeeded、zero_significant=true）、design.tsv、qc.tsv、results/{de,qc,filter_summary}.tsv、
  figures 9 张 PNG(300dpi)、evidence.jsonl 41 条（20 measured）、methods.md；31 个 artifact 哈希全部与磁盘一致。
- 早前：geobulk bulk 7/7、harmonize 两数据集、joint meta、joint plot（走 plotlab 出图）均 succeeded；
  metabolomics required 全 ok（plsda/VIP 因 4 样本 CV 折数不足失败 → partial）。

### 6.3 宿主实测（`curl http://127.0.0.1:57105/bioflow/dispatch`）
- `ask`：「用我的数据集做胃癌肝转移 NK 细胞分析并出图」→ `draft ready / missing []`，
  自动选 `ds_f016e35d13e601e4`、模板 `bulk-two-group`、对照 `tumor vs normal`，返回 2 条带中文摘要的候选。
- `advise`：「胃癌肝转移 单细胞 NK 细胞 预后」→ 推荐 `GSE275647`（人源、216 样本）等，附理由/风险/文献/下一步。
- `topics`：「胃癌肝转移」→ 9 个候选临床问题 + 6 篇近两年综述热点（PMID 等）。
- `figures` / `files` / `catalog` / `status` 路由均 200；侧栏与页面已在宿主加载。

---

## 7. 使用指南（最短路径）

1. **许愿**（顶栏「许愿」）：直接打字 / 点例子 / 常用套路 → 自动弹「候选数据集（中文摘要）」→ 用哪个点哪个
   → 计划卡里分组、对照、模板都已提案 → 「确认并提交」。
2. **疾病引导**：输任意疾病 → 选主队列 → `＋追加数据`：
   - 同类型（多个 bulk）→ 标黄「需去批次」→ 选方法 →「先去批次合并，再生成计划」；
   - 不同类型（单细胞/空间/代谢）→ 标蓝「一脉相承」→ 按提示串成下一步；
   - 也可直接「生成计划许愿」。
3. **问题入手**：填疾病 →「给我几个选题」→ 点一个临床现象 →「查文献与队列」→ 结果可「写入思路链」或「生成核实许愿」。
4. **数据向导**（顶栏）：候选 → 逐个数据集页面（分组/对照提案，只检查）→ 总结页（联合/单独）→ 执行。
5. **CLI**：`node bin/bioflow.mjs <action> --k=v --json`，同一 `runTool`；退出码 0/2。
6. 结果：`~/.dsh/bioflow/runs/<run_id>/`；导出默认到 `settings.output_dir`；
   删除 run 默认进 `trash/runs/`（`purge=true` 才彻底删）。

### 动作一览（24 个）
`status / templates / search / source_detail / health / download / register / datasets / ask / advise / topics /
plan / submit / runs / run_status / cancel / export / evidence / methods / audit / suggest /
harmonize / joint / delete / settings`

---

## 8. 未完成 / 下一步 TODO

1. **spatial-domain / virtualcell-perturb 的真实引擎端到端**（需 Visium 目录或 h5ad；模板结构与闸门已测）。
2. **UI 浏览器实机验收**：无 Playwright/截图能力；布局按 1440/1180/900 断点实现，需人工过一遍。
3. **宿主热加载限制**：`impl.mjs` 会按 mtime 重载，但其依赖模块（store/intent 等）会被 ESM 缓存；
   改依赖后需重启 DSH 才全部生效（客户端刷新即可）。
4. GDC/TCGA、MetaboLights、CELLxGENE 仅打通检索/下载/登记链路，未做真实大文件下载 e2e；
   Europe PMC 本机 8s 超时默认关闭，其字段归一化未完全对齐。
5. 下载无「暂停/续传」协议（只有取消）；UI 的取消只停客户端等待。
6. 步骤级 stderr 未落文件（时间线展开只有 error）。
7. `runtime.llmResolver`（LLM 兜底）未接线；`adapterFactory` 仅测试注入。
8. 思路链目前存 localStorage（按数据根隔离），尚未成为 run 交付物。
9. **GitHub 同步未完成**（见下）。

---

## 9. GitHub 同步状态（重要）

- 本机 `git` 的全局代理指向 `http://127.0.0.1:7897`，该代理当前**不可用**；而直连 `https://github.com` 是通的（curl 200）。
- `plugins/dsh-bioflow/.git` 已存在（本地仓库），但**没有 remote**；`dsh-bioinformatics-plugins` 只有索引（README + plugins.json）。
- 本机存在 GitHub HTTPS 凭据（`git credential fill` 返回 `username=x-access-token`），因此**代理恢复 / 或在命令里临时绕过代理后可以直接推**：
  ```bash
  cd "plugins/dsh-bioflow"
  git -c http.proxy= -c https.proxy= remote add origin https://github.com/jszjdyt/dsh-bioflow.git
  git add -A && git commit -m "feat(bioflow): 许愿式生物信息全自动分析平台 v0.1.0"
  git -c http.proxy= -c https.proxy= push -u origin HEAD
  ```
  （若远端仓库尚未创建，需要先在 GitHub 上建空仓库；浏览器已登录但 git 推送仍需仓库存在。）
- 建议同时更新索引 `dsh-bioinformatics-plugins` 的 `plugins.json` 与 README，把 bioflow 加为第 10 个插件。

---

## 10. 常用命令

```bash
# 测试
node --test plugins/dsh-bioflow/test/*.test.mjs

# CLI
node bin/bioflow.mjs status --json
node bin/bioflow.mjs advise --need="胃癌肝转移 单细胞 NK 细胞" --json
node bin/bioflow.mjs topics --disease="胃癌肝转移" --json
node bin/bioflow.mjs ask --query="用我的数据集做差异分析并出图" --json
node bin/bioflow.mjs harmonize --dataset-ids='["ds_a","ds_b"]' --method=quantile --target-scale=log_expression --json
node bin/bioflow.mjs plan --dataset=ds_harm_xxx --template=bulk-two-group --case=tumor --control=normal --json
node bin/bioflow.mjs submit --plan-id=<id> --confirm-token=<token> --json
node bin/bioflow.mjs export --run-id=<run> --json
node bin/bioflow.mjs settings --output-dir=/path/to/out --json
node bin/bioflow.mjs delete --target=run --id=<run> --json

# 宿主接口
curl -s http://127.0.0.1:57105/bioflow/status
curl -s http://127.0.0.1:57105/bioflow/catalog
curl -s -X POST -H 'content-type: application/json' \
  -d '{"action":"ask","need":"用我的数据集做差异分析"}' \
  http://127.0.0.1:57105/bioflow/dispatch
```

---

## 11. 关键决策与教训

- **不要把「填表单」当许愿**：能自动推的（尺度、对照、模板、数据集）全部先推，人只检查；
  推不了才问，并给候选。
- **闸门宁可 blocked**：n<2、完全混杂、尺度未验证、缺对照方向一律拦；零显著正常放行并导出。
- **合并 ≠ 拼接**：同类型多队列必须先 harmonize 去批次；不同类型不合并推断，走「一脉相承」。
- **证据链可回查**：每条 claim 绑 run/table/row/figure，能绑 PMID；模型预测单独标 `model_prediction`。
- **图片/表格/Draft 都是产物**：manifest、design、qc、results、figures、evidence、methods 缺一不可；
  失败也要留下可诊断的失败版清单。

---

## 12. 评审 P0 修复（GPT UX review + Gemini 产品方案落地）

### 已落地

1. **零门槛起手式**：许愿台新增「我有数据 / 我只有方向 / 帮我找数据 / 照着图来」四个入口；
   「照着图来」提供 6 张出图样式卡（比例箱线、火山+热图+富集、森林图、空间、生存、UMAP），
   选图后反推需要什么数据并生成许愿文本。
2. **活体愿望卡体检灯**：计划卡顶部显示 绿/黄/红 三色健康灯（缺 dataset/contrast/闸门=红；仅缺建议字段=黄），
   并列出待定字段；被闸门拦下时每条闸门直接给出**中文补救动作**（→ 增加重复 / 换队列 / 确认尺度…）。
3. **一次只问一件事**：draft 有缺失时，只展示第一个问题 + 2–4 个候选按钮，点选即更新并重算，
   不再一次性甩一整张表。
4. **顺着结果继续许愿**：run 成功后自动请求 `suggest_next`，出现「检查 QC/批次、看趋势 Top 基因、
   独立队列验证、TCGA 生存、单细胞表达」等按钮，点一下填入许愿框；零显著时明确写「当前阈值下 0 项显著」。
5. **中文输入法保护**：所有 Enter 提交（许愿、在线检索、AI 挑数据、向导）都判断 `isComposing/229`，
   选词不会误触发。
6. **下载按钮改文案**：「停止等待」（后端 download 仍是一次性请求，不支持暂停续传）。

### 跟主流程修掉的高危 Bug（均有回归测试）

1. **点名编号不再静默回落**：`ask` 遇到未登记的 GSE/TCGA/MTBLS 编号时，不再拿本地数据集顶替；
   改走公共库检索并返回 `online_candidates`，保持「缺 dataset」并提示先下载登记。
2. **矩阵方向一致性**：方向判定提前到身份核对之前；`transpose=false`（样本×基因）用首列取样本，
   不再拿基因列去对样本表造成 `sample_identity` 误拦。
3. **尺度不再靠数值硬猜 verified**：只有「非负整数」才自动判为 counts 且 verified=true；
   负整数/小数一律判为疑似 log/归一化、verified=false，需用户确认后才能做推断。
4. **多队列混杂拦截**：合并前检查「队列×分组」，若每个队列只有一组且分属不同组 → `status=blocked`，
   明确写「分不清疾病差异还是队列差异」，不再凭方法名把 `cross_dataset_inference_allowed` 置真。
5. **合并样本逐队列映射**：合并矩阵列名按 `dataset_id:原样本名` 显式回填分组/供体/批次，
   检查样本数守恒；去掉后缀搜索与单组回填，杜绝重复样本名串组。
6. **单细胞模板参数**：比例检验传入所选两组与目标细胞类型、明确分母；
   **无供体列时不再生成 `unit:'cell'` 的 pseudobulk 伪重复步骤**，改为在计划里写限制说明。

### 测试

`node --test plugins/dsh-bioflow/test/*.test.mjs` → **64 项 / 63 通过 / 1 skip（live PubMed）/ 0 失败**；
新增 `test/review_p0.test.mjs` 5 项：尺度、方向、混杂拦截、跨队列映射、闸门补救动作。

### 仍未做（明确 TODO）

- 图形化本地导入（首屏拖文件 → 列映射修复卡）；当前仍走 `register` 接口/CLI。
- `dataset_probe`（「这套数据现在能做什么」）与批量「1 问题 × 多队列」。
- 单细胞引擎层面只比所选两组的比例检验（当前引擎会对比全部分组，计划里已写限制）。
- 研究脉络条替代独立思路链页（P2）；导出「思路链.md」并进结果包。
