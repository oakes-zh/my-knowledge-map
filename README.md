# Personal Knowledge Base

基于 Dify 的个人知识库系统 —— 采集零散图片、文档、链接，AI 自动摘要/标签，语义检索，知识图谱归档。

## 核心概念：文件关键字 ≠ 归档路径

系统区分两个完全不同的概念：

- **文件关键字（keywords）**：文档的扁平、独立语义属性（`auto_tags` 自动识别 + `custom_tags` 自定义）。它们之间没有层级关系。
- **归档路径（archive path）**：LLM 对文档「主旨/概要」的**重新语义归纳**——一条从根目录出发、**3-4 级**的层级目录（领域 → 主题 → 分类 → 具体类别），层级由浅入深，用于知识图谱分类。它不是关键字列表本身，而是模型对若干文件共同特征的概括，例如关键字 `[发票, 增值税, 报销]` 可能归档为 `财务 → 票据 → 增值税 → 发票`。

入库时 LLM 依据「主旨/概要 + 关键字 + 标题」为每个文件生成 3-4 级路径；靠上的层级使用通用、稳定的领域术语，使多篇同类文档合并到同一分支，整棵树**逐渐开枝散叶**。已归档文件可随时通过「重新归档」按钮（`POST /documents/rearchive`，支持 `only_unfiled` 参数）让 LLM 重新归纳目录（失败时宁可不归档，也绝不把关键字原样当作目录层级）。

归档信息保存在一个**嵌套字典数据集**（`backend/data/archive_tree.json`）中，前端将其渲染为知识图谱树。**拖动节点会同时修改嵌套字典的结构与受影响文档的 `archive_path`**（由 `services/archive_store.py` 的 `rebuild_and_sync` 保证两者同步落盘）：

| 拖动操作 | 嵌套字典变化 | 文档信息变化 |
|---|---|---|
| 拖文档 → 分类 | 文档从原节点 `doc_ids` 移到目标节点 | 该文档 `archive_path` 重写 |
| 拖分类 → 分类 | 整棵子树 detach/attach | 子树内所有文档 `archive_path` 重写 |

每次结构变更后都会**自动剪除空目录**（既无文档也无子分类的节点，如文档全部移走后的旧分支、清空后的「未分类」桶），图谱中不会残留没有文件的目录。

## 架构

```
用户触点 (Web/插件/Bot)  →  FastAPI 预处理服务  →  Dify Knowledge API
         ↑                                              |
         └────────  Dify Chat API (RAG 检索回答)  ←──────┘
```

## 关键接口

- `GET /documents/archive-tree` — 返回嵌套字典归档树（知识图谱数据源）
- `POST /archive/move` — 拖动移动：`source_doc_id`（移文档）或 `source_node_id`（移子树）+ `target_node_id`，同步更新字典结构与文档 `archive_path`
- `POST /documents/rearchive` — 为每个文件重新归纳 3-4 级归档目录（`only_unfiled=true` 仅处理未分类文档）
- `POST /ingest/*` — 入库时由 LLM 重新语义归纳归档目录并放入归档树（持久化 `summary` 供重归档使用）
- `GET /documents` — 文档列表（含 `keywords`、`archive_path`、`summary`、`tree_path`）

## 快速开始

### 1. 环境准备

```bash
cp .env.example .env
# 填入你的 Dify API Key、Dataset ID 等
```

### 2. 启动服务

```bash
docker-compose up -d
```

### 3. 访问

- 前端: http://localhost:3100
- 后端 API 文档: http://localhost:8900/docs
- Dify 控制台: http://localhost:3000 (你已部署)

### 4. Chrome 插件安装

1. 打开 Chrome → `chrome://extensions`
2. 开启"开发者模式"
3. "加载已解压的扩展程序" → 选择 `chrome-extension/` 目录

## 目录结构

```
personal-kb/
├── docker-compose.yml       # 服务编排
├── .env.example             # 环境变量模板
├── frontend/                # Next.js 前端
├── backend/                 # FastAPI 预处理服务
├── chrome-extension/        # Chrome 剪藏插件
└── data/                    # 本地数据（上传文件等）
```

## 核心功能

- [x] 文本/笔记直接入库
- [x] 网页链接抓取入库
- [x] 图片 OCR 入库
- [x] PDF/Word 文档解析入库
- [x] 语义搜索 + AI 回答
- [x] Chrome 一键剪藏
- [x] 知识图谱可视化（归档树，拖动同步更新嵌套字典与归档路径）
- [ ] 微信 Bot 入口
