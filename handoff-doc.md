# Personal KB 本地化架构交接文档

> 创建时间：2026-09-03
> 更新时间：2026-09-04
> 状态：方案已确认，开始实施

---

## 1. 项目背景

**Personal Knowledge Base** 是一个基于 Dify 的个人知识库系统，用于采集零散图片、文档、链接，实现 AI 自动摘要/标签、语义检索和知识图谱归档。

### 当前状态（2026-09-04）

- **数据规模**：约 10 篇文档（SwiftUI、HDC命令、租赁合同、电子发票、热量缺口等）
- **现有技术栈**：Dify + Weaviate + 前端（Next.js + Tailwind）
- **问题**：依赖复杂、Dify 部署麻烦、无法完全掌控数据

### 新目标

**完全本地化、可分发、无 Docker、无 Dify**

---

## 2. 新架构

```
┌────────────────────────────────────────────┐
│  浏览器 / Chrome 插件                        │
└──────────────────┬─────────────────────────┘
                   │  单端口 :8900
┌──────────────────▼─────────────────────────┐
│  FastAPI 单进程（uvicorn）                   │
│  ├── 静态托管 next build 产物 (/)           │
│  └── /api/*  REST + SSE                    │
│         │                                  │
│  ┌──────▼───────────────────────────────┐  │
│  │  kb.db  ← 整个知识库就是这一个文件      │  │
│  │  documents / chunks / archive_nodes  │  │
│  │  chunks_fts (FTS5 + bigram) + BLOB向量│  │
│  └──────────────────────────────────────┘  │
│         │                                  │
│  检索 = BM25(FTS5) ⊗ 余弦(numpy) → RRF 融合 │
│  特定目录检索 = SQL WHERE archive_path LIKE │
└────────────────────────────────────────────┘
          │ 仅 LLM/Embedding 走 API
   ┌──────▼───────┐
   │ DeepSeek(归类) │  Embedding(OpenAI 兼容)
   └───────────────┘
```

### 技术栈

| 组件 | 技术选型 | 说明 |
|---|---|---|
| 数据存储 | SQLite (stdlib) | 单文件 `kb.db`，包含元数据/分块/FTS5/向量 |
| 全文检索 | FTS5 + bigram 展开 | 解决中文检索问题 |
| 向量检索 | numpy 暴力余弦 | 20k chunks @512d = 1.7ms 查询，精确无 ANN 误差 |
| LLM | DeepSeek (chat) | 归类、摘要、回答 |
| Embedding | OpenAI 兼容 API | 硅基流动 BAAI/bge-m3 或 OpenAI text-embedding-3-small |
| 前端 | Next.js 静态导出 | 无运行时 Node，FastAPI 直接托管 |
| 部署 | pip install + CLI | `kb serve` 一键启动 |

---

## 3. 核心设计

### 3.1 SQLite 数据模型

```sql
documents(
  id TEXT PRIMARY KEY,          -- 本地生成 ULID
  title TEXT,
  source TEXT,
  source_url TEXT,
  doc_type TEXT,                -- text/pdf/image/url
  content_hash TEXT UNIQUE,     -- 去重
  archive_path TEXT,            -- '财务/票据/增值税'
  archive_node_id TEXT,
  summary TEXT,
  keywords JSON,                -- JSON array
  pdf_type TEXT,
  word_count INT,
  created_at, updated_at
)

chunks(
  id INTEGER PRIMARY KEY,
  doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  seq INT,
  text TEXT,
  embedding BLOB,               -- float32 归一化
  embedding_model TEXT          -- 维度/版本校验
)

archive_nodes(id TEXT PK, name, parent_id, position)

chunks_fts USING fts5(
  text,
  tokenize='unicode61',
  content='chunks'
)

meta(key TEXT PK, value TEXT)   -- embedding_model / dim / schema_version
```

### 3.2 中文 FTS5 解决方案

**问题**：FTS5 默认 `unicode61` 对中文是失效的，`trigram` 对 2 字词失效。

**解决**：bigram 展开 + unicode61
- 入库时将文本切成重叠二元组（"增值税发票报销" → "增值 值税 税发 发票 票报 报销"）
- 查询时同样展开
- 支持单字（padding 为空格）和 2+ 字词

**验证**：
```
bigram('发票') → '发 票'
bigram('增值税发票报销') → '增值 值税 税发 发票 票报 报销'
查询 '发票' → 命中 doc1
查询 '报销' → 命中 doc3, doc1
```

### 3.3 向量检索（numpy 暴力）

- **维度**：512（text-embedding-3-small 支持 `dimensions` 参数）
- **存储**：chunks 表 embedding 列存 float32 BLOB
- **查询**：numpy 矩阵乘法（O(n) 全量计算，但 20k chunks @512d 仅 1.7ms）
- **优点**：精确检索，无 ANN 近似误差，零额外依赖

**性能数据**：
```
chunks=20000 dim=1536: load 79ms | query 6.8ms | mem 123MB
chunks=20000 dim= 512: load 29ms | query 1.7ms | mem  41MB
```

### 3.4 混合检索

```python
# 1. BM25 (FTS5)
bm25_scores = fts.search(query, top_k=30)

# 2. 余弦相似度
cosine_scores = vector_search(query_embedding, top_k=30)

# 3. RRF 融合
final_scores = rrf_fusion(bm25_scores, cosine_scores, k=60)
```

### 3.5 特定目录检索

```sql
SELECT c.id, c.text
FROM chunks c
JOIN documents d ON d.id = c.doc_id
WHERE d.archive_path LIKE '财务/%'
   OR d.id IN (SELECT doc_id FROM archive_nodes WHERE id = ?)
```

---

## 4. 依赖清单

| 依赖 | 版本 | 说明 |
|---|---|---|
| fastapi | 0.111.0 | Web 框架 |
| uvicorn[standard] | 0.30.1 | ASGI 服务器 |
| httpx | 0.27.0 | LLM/Embedding API 调用 |
| python-multipart | 0.0.9 | 文件上传 |
| pydantic | 2.7.1 | 数据验证 |
| pydantic-settings | 2.2.1 | 配置管理 |
| PyMuPDF | 1.24.5 | PDF 解析 |
| beautifulsoup4 | 4.12.3 | HTML 解析 |
| lxml | 5.2.2 | XML 解析 |
| Pillow | 10.3.0 | 图片处理 |
| numpy | 2.2.6 | 向量计算（唯一新增） |

**移除依赖**：无（httpx 保留给 LLM 调用）

---

## 5. 配置

### 5.1 .env.example

```bash
# Backend
BACKEND_PORT=8900
BACKEND_HOST=0.0.0.0

# LLM (DeepSeek)
DEEPSEEK_API_KEY=your_deepseek_api_key

# Embedding (OpenAI 兼容)
EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1  # 或 https://api.openai.com/v1
EMBEDDING_API_KEY=your_embedding_api_key
EMBEDDING_MODEL=BAAI/bge-m3  # 或 text-embedding-3-small
EMBEDDING_DIMENSIONS=512

# Storage
KB_DB_PATH=./kb.db
CHUNK_SIZE=512
CHUNK_OVERLAP=50

# File Upload
UPLOAD_DIR=./data/uploads
MAX_FILE_SIZE_MB=20

# Frontend (静态导出)
NEXT_PUBLIC_API_URL=/api/backend
```

### 5.2 前端配置

前端使用 `/api/backend` 前缀，通过 FastAPI 的 rewrite 或直接代理。

---

## 6. 实施计划

### P0: 核心存储与检索

| 任务 | 内容 | 文件 |
|---|---|---|
| P0-1 | SQLite schema 初始化 | `backend/storage.py` |
| P0-2 | 分块服务（固定窗口 + overlap） | `backend/chunking.py` |
| P0-3 | Embedding 服务 | `backend/embedding_service.py` |
| P0-4 | 向量存储（numpy 暴力） | `backend/vector_store.py` |
| P0-5 | 全文检索（FTS5 + bigram） | `backend/search_service.py` |
| P0-6 | 混合检索（RRF 融合） | `backend/search_service.py` |

### P1: 入库接口替换

| 任务 | 内容 | 文件 |
|---|---|---|
| P1-1 | 文本入库 | `main.py` |
| P1-2 | URL 抓取入库 | `main.py` |
| P1-3 | 文件入库 | `main.py` |
| P1-4 | 删除文档 | `main.py` |
| P1-5 | 标签管理 | `main.py` |

### P2: 检索接口替换

| 任务 | 内容 | 文件 |
|---|---|---|
| P2-1 | 语义检索 | `main.py` |
| P2-2 | 流式检索 | `main.py` |
| P2-3 | 特定目录检索 | `main.py` |
| P2-4 | 文档列表 | `main.py` |

### P3: 清理与分发

| 任务 | 内容 | 文件 |
|---|---|---|
| P3-1 | 删除 dify_client.py | 删除 |
| P3-2 | 更新 requirements.txt | 删除 Dify 依赖 |
| P3-3 | CLI 命令 `kb serve` | 新建 `cli.py` |
| P3-4 | 前端静态导出 | `frontend/next.config.js` |
| P3-5 | 单进程部署脚本 | `start.sh` |

### P4: 验证

| 任务 | 内容 | 状态 |
|---|---|---|
| P4-1 | 重新入库 10 篇文档 | 待执行 |
| P4-2 | 检索质量验证 | 待执行 |
| P4-3 | 前端集成测试 | 待执行 |

---

## 7. 关键决策

### Q1: 为什么不用 ChromaDB？

- **依赖重**：ChromaDB 需要安装 `onnxruntime`、`tokenizers`、`grpcio` 等，数百 MB
- **可移植性问题**：macOS 系统 Python 默认禁用 SQLite 扩展加载，`sqlite-vec` 无法使用
- **性能足够**：20k chunks @512d 暴力检索仅需 1.7ms，精确无 ANN 误差
- **零依赖**：numpy 是唯一新增依赖，通用 wheel

### Q2: 为什么不用 trigram 分词器？

- trigram 无法处理 2 字词（中文最常见）
- bigram 展开 + unicode61 可完美支持 1-2+ 字查询

### Q3: 为什么不迁移 Dify 数据？

- Dify 的分块是内部的，Weaviate 的向量难以导出
- 10 篇文档重新入库成本几乎为 0
- 重新入库可修正 chunking 和归档路径

### Q4: DeepSeek 没有 embeddings API 怎么办？

- Embedding 使用 OpenAI 兼容 API（硅基流动 BAAI/bge-m3 或 OpenAI text-embedding-3-small）
- DeepSeek 仅用于 chat（归类、摘要、回答）

---

## 8. 启动方式

### 方式 1: pip 安装 + CLI（推荐）

```bash
# 安装依赖
cd backend
pip install -r requirements.txt

# 启动服务
kb serve
```

浏览器自动打开 `http://localhost:8900`

### 方式 2: 手动启动

```bash
cd backend
uvicorn main:app --host 0.0.0.0 --port 8900
```

前端通过静态文件托管。

---

## 9. 测试验证

### 健康检查

```bash
curl http://localhost:8900/health
```

预期响应：
```json
{
  "status": "ok",
  "vector_store": "numpy_cosine",
  "llm_provider": "deepseek",
  "embedding_provider": "openai-compatible",
  "doc_count": 0
}
```

### 功能测试

```bash
# 文本入库
curl -X POST http://localhost:8900/ingest/text \
  -H "Content-Type: application/json" \
  -d '{"title": "测试文档", "content": "这是一个测试内容"}'

# 搜索
curl -X POST http://localhost:8900/search \
  -H "Content-Type: application/json" \
  -d '{"query": "测试"}'

# 特定目录检索
curl -X POST http://localhost:8900/search/scoped/stream \
  -H "Content-Type: application/json" \
  -d '{"query": "发票", "archive_path": "财务/票据/增值税"}'
```

---

## 10. 风险与注意事项

### 风险

1. **嵌入模型成本** - OpenAI 兼容 API 按调用计费
2. **中文分词准确性** - bigram 展开可能不如专业分词器
3. **向量维度** - 512 维是 trade-off，可能影响检索质量

### 注意事项

1. **备份数据** - `kb.db` 备份 = 完整知识库备份
2. **测试环境** - 先用少量文档测试
3. **逐步迁移** - 10 篇文档可全部重新入库

---

## 11. 后续优化

- [ ] 支持更多嵌入模型（Jina、BGE-M3）
- [ ] 添加缓存层提升性能
- [ ] 支持多用户权限管理
- [ ] 添加 Webhook 通知功能
- [ ] 支持文档版本控制

---

## 12. 联系方式

如有问题，请参考以下文件：
- 完整实施计划: `/Users/oakes.zh/.local/share/opencode/plans/2026-09-03-dify-decoupling.md`
- 原始代码: `/Users/oakes.zh/Documents/claude_workspace/personal-kb/`

---

**文档版本**: v2.0
**最后更新**: 2026-09-04
**实施状态**: 进行中
