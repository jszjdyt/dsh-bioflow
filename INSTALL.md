# 安装 dsh-bioflow

许愿式生物信息全自动分析平台（Bioflow）是一个 **DSH Host 插件**（不是 MCP，也不是独立服务）：装进桌面版 profile 后，多出三个入口——对话里的 `bioflow` agent 工具、`bioflow` CLI、以及 `/bioflow/*` 路由后面的整页工作台。

## 0. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| DeepSeek Harness | 桌面版（本仓库对应的 `~/.dsh/profiles/desktop`） | 插件安装需要 **Full access** 权限 |
| Node.js | `>=18`（`package.json` 的 `engines`）；**推荐 22+** | 22+ 才有 `node:sqlite`；没有会自动退到 JSON 后端，功能一致只是并发/跨进程幂等弱一些 |
| Python 3 | 可选，但分析要用 | `numpy / pandas / scipy / scikit-learn / matplotlib`；六个工作台各自还可能要多装包（R 可选）。装之前照样能检索、登记、计划、审计 |
| 网络 | 可选 | 检索/下载公共库需要；纯本地数据不需要 |

> Bioflow 自己**不执行** Python：分析步骤全部转给六个工作台插件（`dsh-geobulk` / `dsh-singlecell` / `dsh-spatial` / `dsh-metabolomics` / `dsh-plotlab` / `dsh-virtualcell`）。所以「Python 没装好」只会让分析步骤 `failed`/`blocked`，不会让入口本身挂掉。

## 1. 安装

### 方式一：本地插件包安装（推荐）

在 Harness 里让 Agent 调 `plugin_manager`，或走「设置 → 插件 → 安装本地插件包」：

```text
plugin_manager action=install_bundle target=/Users/<you>/Desktop/deepseek harness/plugins/dsh-bioflow
```

`target` 必须是**插件目录的绝对路径**（含 `package.json` 的那一层，路径有空格也能装）。`package.json` 里已声明 `dsh.bundle.patch = ./cordis.patch.yml`，安装器据此把 `dsh-bioflow` 作为 bundle 挂进 profile 并启用。

安装完成后**重载宿主/页面**：左侧栏出现「许愿式生物信息分析」，对话工具表里出现 `bioflow`。

### 方式二：软链进 profile（本仓库六个工作台现在就是这么挂的）

看 `~/.dsh/profiles/desktop/package.json` 现状：六个兄弟插件都是 `link:` 依赖 + 在 `dsh.profile.bundles` 里登记。照同样方式加 Bioflow：

1. 编辑 `~/.dsh/profiles/desktop/package.json`，在 `dependencies` 里加：

```json
"dsh-bioflow": "link:/Users/<you>/Desktop/deepseek harness/plugins/dsh-bioflow"
```

2. 在 `dsh.profile.bundles` 数组里追加 `"dsh-bioflow"`；
3. 在 profile 目录执行 `npm install`（或让 Agent 用 `plugin_manager` 触发一次解析），确认 `node_modules/dsh-bioflow` 是指向源码目录的软链；
4. 重载宿主。

> 手改 profile 属于高级操作，容易和 `plugin_manager` 的状态打架；能用方式一就别手改。
> 本文写作时 `dsh-bioflow` **尚未**出现在 desktop profile 的依赖表里，需要按上面任一种方式加入后才会生效（未加载时 `/bioflow/status` 返回 404）。

## 2. 验证安装

### 2.1 CLI 自检（不依赖宿主是否加载）

```bash
cd "/Users/<you>/Desktop/deepseek harness"

# 1) 状态：数据根、存储后端、六个工作台插件是否可用
node plugins/dsh-bioflow/bin/bioflow.mjs status --json

# 2) 模板与高级方法
node plugins/dsh-bioflow/bin/bioflow.mjs templates --json

# 3) 确定性自检（状态一致性 / 产物哈希 / evidence 引用 / 插件协议 / staging 残留）
node plugins/dsh-bioflow/bin/bioflow.mjs audit --json
```

`status --json` 正常时的关键字段：

```json
{
  "ok": true,
  "store_kind": "sqlite",
  "data_root": "/Users/<you>/.dsh/bioflow",
  "plugins": [ { "plugin": "geobulk", "available": true, "error": null } ],
  "summary": "许愿式生物信息全自动分析平台 0.1.0 · sqlite 存储 · ... · 插件可用 6/6"
}
```

- `store_kind` 是 `sqlite` 或 `json`（Node <22 或设了 `BIOFLOW_STORE=json` 时）；
- `plugins[].available=false` 时有 `error` 与 `module_path`，按提示修（多数是插件目录没装在同一父目录下，或用 `pluginPaths` 指定）；
- 想临时用别处做数据根：所有 CLI 命令都吃 `--data-dir=/abs/path`。

### 2.2 回归测试

```bash
node --test plugins/dsh-bioflow/test/
```

> `test/` 目前为空（实现先落 `lib/`，测试随后补）。空目录时 Node 会把该路径当模块解析并报 `Cannot find module '.../test'`，这**不是**安装失败；此时用 2.1 的 `audit --json` 作为健康检查。测试文件落地后这条命令就是标准回归入口。

### 2.3 HTTP 路由（确认宿主已加载）

端口取当前 Web GUI 的地址栏端口（本文写作时是 `127.0.0.1:57105`，每次启动可能不同）。

```bash
PORT=57105

# 状态（GET）
curl -s "http://127.0.0.1:$PORT/bioflow/status" | head -c 400; echo

# 任意 action 走 dispatch（POST JSON；GET ?action= 也认，便于排查）
curl -s -X POST -H 'content-type: application/json' \
     -d '{"action":"templates"}' \
     "http://127.0.0.1:$PORT/bioflow/dispatch" | head -c 400; echo
```

- 两个都返回 JSON → 插件已加载；
- 返回 `404 {"error":"not_found"}` → 插件没被 profile 加载（回到第 1 节），不是路由写错。

其余路由：`/bioflow/catalog`（模板/数据源/高级动作目录）、`/bioflow/health`（数据源健康灯）、`/bioflow/figures/<run_id>/<file>`、`/bioflow/files/<rel>`（相对数据根的交付物）。

## 3. 卸载

```text
plugin_manager action=remove_bundle target=dsh-bioflow
```

或先停用保留配置：`plugin_manager action=set_bundle target=dsh-bioflow enabled=false`。

手改 profile 装的，反向操作：从 `dependencies` 删掉 `dsh-bioflow`、从 `dsh.profile.bundles` 删掉 `"dsh-bioflow"`，再 `npm install`。

**卸载不会删数据**。数据根在 `~/.dsh/bioflow`（见下），需要连数据一起清就手动删。

## 4. 数据根 `~/.dsh/bioflow`

```
~/.dsh/bioflow/
├── store.sqlite            # 记录库（Node 22+ 默认；WAL 模式，旁边可能有 -wal/-shm）
├── store.json              # 或 JSON 后端快照（BIOFLOW_STORE=json，或 Node <22）
├── journal.jsonl           # 仅 JSON 后端：append-only 日志，压缩时回灌快照
├── datasets/               # 预留目录（数据集 manifest 记在 store 里，这里当前不落文件）
├── plans/                  # 预留目录（计划记在 store 里）
├── searches/<search_id>/   # 每次检索的原始结果与 provenance
├── runs/<run_id>/          # 一个 run 一套不可变交付物
│   ├── manifest.json
│   ├── design.tsv
│   ├── qc.tsv
│   ├── results/
│   │   ├── <table_id>.tsv
│   │   ├── tables.index.json
│   │   └── steps/<step_id>.json        # 上游引擎原始返回，逐字节保存
│   ├── figures/<NN>_<kind>.png (+ .plotdata.json)
│   ├── evidence.jsonl
│   ├── methods.md
│   └── .staging/           # 只有取消/崩溃才可能残留（audit 会报）
├── cache/
│   ├── pubmed/             # PubMed 结果缓存（默认 7 天）
│   ├── downloads/          # 下载缓存与 index（同 hash 复用靠它）
│   └── search-engines/<plugin>/  # 检索用的临时 worker workdir
└── logs/events.jsonl       # 事件日志（每行一条 JSON）
```

清理建议（**先导出再删**）：

```bash
# 1) 先把要留的 run 打包出去
node plugins/dsh-bioflow/bin/bioflow.mjs export --run-id=<run_id> --out-path=/abs/keep

# 2) 删缓存是安全的（会重新下/重新查）
rm -rf ~/.dsh/bioflow/cache

# 3) 删 run = 删证据：manifest/表/图/evidence 一起没了，只删确认不要的
rm -rf ~/.dsh/bioflow/runs/<run_id>

# 4) 整体重来（数据集/计划/run 记录全清）
rm -rf ~/.dsh/bioflow
```

`runs/` 下的文件被哈希记账，手工改文件后 `audit` 与 `export` 会报 `hash_mismatch`——这是特性，不是 bug。

## 5. 常见安装问题

**Q：装完侧边栏没入口、`/bioflow/status` 404？**
插件没被 profile 加载。确认 `dsh-bioflow` 同时出现在 `dependencies` 与 `dsh.profile.bundles` 两处（只加一处不生效），并重载宿主。注意 `client.js`（浏览器整页）若没随包提供，侧栏入口不会出现，但工具/CLI/HTTP 仍然可用。

**Q：`status` 里 `plugins[]` 全是不 `available`？**
六个工作台插件要和 `dsh-bioflow` 装在同一父目录（默认 `plugins/` 同级），或用配置 `pluginPaths: { geobulk: "/abs/plugins/dsh-geobulk/lib/engine.mjs", ... }`、环境变量 `DSH_BIOFLOW_PLUGINS_DIR=/abs/plugins` 指定。每个引擎的契约见 `lib/adapters.mjs` 顶部注释。

**Q：`store_kind=json` 想换成 sqlite？**
升级到 Node 22+ 后删掉 `BIOFLOW_STORE` 环境变量即可（已有 `store.json` 不会自动迁移，重要数据先 `export`）。

**Q：Europe PMC / CELLxGENE 很慢或报超时？**
预期行为：Europe PMC 默认关闭（本机约 8s 超时）；CELLxGENE 默认关闭，显式开启后按 30–60s 等。用 `action=health` 看健康灯（ok/slow/down + 延迟）。

**Q：能不能不装 Python？**
可以做完「检索 → 下载 → 登记 → 计划/闸门 → 审计」，只是真正跑分析的步骤会失败。建议先装：`python3 -c "import numpy, pandas, scipy, sklearn, matplotlib"`。
