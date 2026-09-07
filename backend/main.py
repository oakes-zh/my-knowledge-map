import os
import json
import logging
import shutil
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from config import settings, UPLOAD_PATH
from utils.text_cleaner import clean_text, get_file_extension
from services.document_parser import extract_text
from services.url_fetcher import fetch_url_content
from services.llm_processor import summarize_text, auto_tag, archive_path, answer as llm_answer
from services.tag_store import save_auto_tags, get_tags, update_custom_tags, delete_tags, merge_tags_into_documents, save_pdf_type, move_tag_branch, move_document_to_tag
from services.archive_store import (
    place_document,
    move_document,
    move_node,
    rename_node,
    create_node,
    delete_node,
    remove_document,
    reconcile_orphans,
    serialize,
    prune_empty_nodes,
    ROOT_ID,
 )
from services.hash_store import (
    compute_text_hash,
    compute_file_hash,
    find_duplicate,
    save_hash,
    delete_hash,
 )
from storage import (
    init_db,
    get_connection,
    insert_document,
    insert_chunks,
    delete_document,
    list_documents,
    get_chunks_by_doc_id,
    get_archive_node,
    set_archive_node,
    get_archive_path,
    set_archive_path,
    get_doc_count,
    get_chunk_count,
)
from chunking import chunk_text
from embedding_service import embedding_service
from vector_store import vector_store
from search_service import search, search_stream, get_chunk_by_id

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)


async def _safe_embed(text: str):
    """生成 embedding；未配置 key 或调用失败时降级返回 None。

    返回 None 时调用方只入库文档+分块、跳过向量，从而让「缺 key / 网络不通」
    不会把整个入库请求打挂（HTTP 500）。文档仍可被全文检索。
    """
    if not getattr(settings, "embedding_api_key", ""):
        logger.warning("EMBEDDING_API_KEY 未配置，跳过向量生成（文档仍可全文检索）")
        return None
    try:
        return await embedding_service.embed_text(text)
    except Exception as e:
        logger.error(f"Embedding 生成失败（文档仍正常入库）: {e}")
        return None
logger = logging.getLogger(__name__)

app = FastAPI(title="Personal KB - Local Storage", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==================== Models ====================

class IngestTextRequest(BaseModel):
    title: str = ""
    content: str
    source: str = "manual"


class IngestURLRequest(BaseModel):
    url: str


class SearchRequest(BaseModel):
    query: str
    conversation_id: str = ""
    user: str = "default"


class ScopedSearchRequest(BaseModel):
    query: str
    doc_ids: list[str] = []
    scope_name: str = ""
    conversation_id: str = ""
    user: str = "default"


class IngestResponse(BaseModel):
    success: bool
    document_id: Optional[str] = None
    title: str = ""
    summary: str = ""
    tags: list[str] = []
    pdf_type: str = ""  # 'text', 'image', or '' for non-PDF
    message: str = ""


class UpdateTagsRequest(BaseModel):
    custom_tags: list[str]


class MoveNodeRequest(BaseModel):
    source_tag: str = ""
    source_doc_id: str = ""
    target_tag: str


class ArchiveMoveRequest(BaseModel):
    source_node_id: str = ""
    source_doc_id: str = ""
    target_node_id: str = ROOT_ID


class RenameNodeRequest(BaseModel):
    node_id: str
    name: str


class CreateNodeRequest(BaseModel):
    parent_node_id: str = ROOT_ID
    name: str


class DeleteNodeRequest(BaseModel):
    node_id: str


# ==================== Routes ====================


async def _archive_document(doc_id: str, text: str, tags: list[str], summary: str = "", title: str = ""):
    """Induce a 3-4 level archive path and file the document into the archive tree.

    文件关键字 (tags) 是扁平、独立的属性；归档路径是 LLM 对文档「主旨/概要」
    的归纳与再提炼——一条从根目录出发、逐级开枝散叶的层级路径（3-4 级），
    而不是关键字列表本身。归档动作会同时改变嵌套字典结构与文档的
    archive_path（由 archive_store 保证同步）。

    归档失败不影响入库结果：文档已落库，仅记录日志并由归档树的
    reconcile_orphans 兜底归入「未分类」。
    """
    try:
        # LLM 归纳层级路径（list[str]，顶层 → 底层）
        levels = await archive_path(text, tags, summary=summary, title=title)
        if levels:
            place_document(doc_id, levels)
            logger.info(f"Archived document {doc_id}: path={' / '.join(levels)}")
        else:
            logger.info(f"Archive induction empty for {doc_id}; will reconcile as 未分类")
    except Exception as e:
        logger.error(f"Failed to archive document {doc_id}: {e}")


@app.on_event("startup")
async def startup_event():
    """启动时初始化数据库"""
    init_db()
    logger.info("Database initialized")


@app.get("/health")
async def health():
    """健康检查"""
    conn = get_connection()
    return {
        "status": "ok",
        "vector_store": "numpy_cosine",
        "llm_provider": settings.llm_base_url,
        "llm_model": settings.llm_model,
        "llm_key_configured": bool(
            getattr(settings, "llm_api_key", "") or getattr(settings, "deepseek_api_key", "")
        ),
        "embedding_provider": settings.embedding_base_url,
        "embedding_model": settings.embedding_model,
        "embedding_key_configured": bool(settings.embedding_api_key),
        "embedding_dim": settings.embedding_dimensions,
        "doc_count": get_doc_count(conn),
        "chunk_count": get_chunk_count(conn)
    }


# ==================== Ingest Routes ====================


@app.post("/ingest/text", response_model=IngestResponse)
async def ingest_text(req: IngestTextRequest):
    """Ingest raw text directly into the knowledge base."""
    try:
        # 清洗文本
        text = clean_text(req.content)
        if not text:
            raise HTTPException(status_code=400, detail="Empty content after cleaning")

        # 计算哈希
        content_hash = compute_text_hash(text)

        # 检查重复
        if find_duplicate(content_hash):
            raise HTTPException(status_code=400, detail="Document already exists")

        # 生成文档 ID
        import uuid
        doc_id = str(uuid.uuid4())

        # LLM 归类
        tags_result = await auto_tag(text, num_tags=5)
        tags = tags_result[:5] if tags_result else []

        # LLM 摘要
        summary_result = await summarize_text(text, max_length=200)
        summary = summary_result[:200] if summary_result else ""

        # 插入文档元数据
        insert_document(
            doc_id=doc_id,
            title=req.title or "未命名文档",
            content_hash=content_hash,
            source=req.source,
            doc_type="text",
            summary=summary,
            keywords=tags,
            word_count=len(text)
        )

        # 分块
        chunks = chunk_text(text, chunk_size=settings.chunk_size, overlap=settings.chunk_overlap)

        # 生成 embedding 并插入分块（embedding 失败则降级：仍入库，仅无向量）
        if chunks:
            chunk_ids = insert_chunks(doc_id, chunks, embedding_model=settings.embedding_model)
            embedding_vec = await _safe_embed(chunks[0])
            if embedding_vec is not None:
                vector_store.save_embedding(chunk_ids[0], embedding_vec)

        # 记录内容哈希，供后续去重
        save_hash(doc_id, content_hash)

        # 归档
        await _archive_document(doc_id, text, tags, summary, req.title or "未命名文档")

        # 保存标签
        save_auto_tags(doc_id, tags, pdf_type="")

        return IngestResponse(
            success=True,
            document_id=doc_id,
            title=req.title or "未命名文档",
            summary=summary,
            tags=tags,
            pdf_type="",
            message="Document ingested successfully"
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to ingest text: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ingest/url", response_model=IngestResponse)
async def ingest_url(req: IngestURLRequest):
    """Ingest URL content into the knowledge base."""
    try:
        # 获取 URL 内容
        content = await fetch_url_content(req.url)
        if not content:
            raise HTTPException(status_code=400, detail="Failed to fetch URL content")

        # 使用文本入库接口
        return await ingest_text(IngestTextRequest(
            title=req.url,
            content=content,
            source="url"
        ))

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to ingest URL {req.url}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ingest/file", response_model=IngestResponse)
async def ingest_file(file: UploadFile = File(...)):
    """Ingest uploaded file into the knowledge base."""
    import uuid
    import glob as _glob

    tmp_path = None
    try:
        # 读取文件
        content = await file.read()
        filename = file.filename or "unknown"

        # 解析文件类型
        ext = get_file_extension(filename)
        doc_type = ext if ext in ["pdf", "docx", "txt"] else "text"

        # 把字节先落盘到一个用 UUID 命名的临时文件：
        # 1) extract_text 需要的是「文件路径」而非字节，直接传字节会被 fitz 当成文件名；
        # 2) 原始上传文件名可能超长（>255 字节），导致 [Errno 63] File name too long。
        suffix = f".{ext}" if ext else ""
        doc_id = str(uuid.uuid4())
        tmp_path = UPLOAD_PATH / f"{doc_id}{suffix}"
        with open(tmp_path, "wb") as f:
            f.write(content)

        # 解析文件内容（统一走文件路径；extract_text 是 async，且所有分支都返回
        # (text, pdf_type) 元组 —— 因此一律 await 并取 [0]，避免把元组当字符串用）
        parsed = await extract_text(str(tmp_path), ext)
        text = parsed[0] if isinstance(parsed, tuple) else parsed

        if not text or len(text.strip()) < 10:
            raise HTTPException(status_code=400, detail="File content is empty or too short")

        # 计算哈希（注意：compute_file_hash 接收的是「文件路径」，不是字节；
        # 直接传字节会被当成路径打开，而 PDF 字节里含 \x00 会触发 embedded null byte）
        content_hash = compute_file_hash(str(tmp_path))

        # 检查重复
        if find_duplicate(content_hash):
            raise HTTPException(status_code=400, detail="File already exists")

        # 生成文档 ID
        import uuid
        doc_id = str(uuid.uuid4())

        # LLM 归类
        tags_result = await auto_tag(text, num_tags=5)
        tags = tags_result[:5] if tags_result else []

        # LLM 摘要
        summary_result = await summarize_text(text, max_length=200)
        summary = summary_result[:200] if summary_result else ""

        # 插入文档元数据
        insert_document(
            doc_id=doc_id,
            title=filename,
            content_hash=content_hash,
            source="file",
            doc_type=doc_type,
            summary=summary,
            keywords=tags,
            word_count=len(text)
        )

        # 分块
        chunks = chunk_text(text, chunk_size=settings.chunk_size, overlap=settings.chunk_overlap)

        # 生成 embedding 并插入分块（embedding 失败则降级：仍入库，仅无向量）
        if chunks:
            chunk_ids = insert_chunks(doc_id, chunks, embedding_model=settings.embedding_model)
            embedding_vec = await _safe_embed(chunks[0])
            if embedding_vec is not None:
                vector_store.save_embedding(chunk_ids[0], embedding_vec)

        # 记录内容哈希，供后续去重
        save_hash(doc_id, content_hash)

        # 归档
        await _archive_document(doc_id, text, tags, summary, filename)

        # 保存标签
        save_auto_tags(doc_id, tags, pdf_type=doc_type)

        return IngestResponse(
            success=True,
            document_id=doc_id,
            title=filename,
            summary=summary,
            tags=tags,
            pdf_type=doc_type,
            message="File ingested successfully"
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to ingest file {file.filename}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # 清理临时文件，以及 PDF 渲染可能产生的分页图（file_path + "_page_N.png"）
        # 尽力而为：清理失败绝不能把已成功的入库变成 500，
        # 所以这里接住包括 SystemExit 在内的一切异常（某些运行环境的
        # os.remove 会被安全钩子拦截并抛 SystemExit）。
        if tmp_path is not None:
            for _p in [tmp_path, *_glob.glob(str(tmp_path) + "_page_*.png")]:
                try:
                    os.remove(_p)
                except BaseException:
                    pass


def _fetch_all_documents() -> list[dict]:
    """读取本地全部文档。

    旧实现依赖 Dify 分页（最多 5 页 × 20 条）；迁移到本地 SQLite 后
    没有分页上限，一次取回即可。
    """
    result = list_documents(page=1, limit=10000)
    return result.get("data", [])


@app.get("/documents/archive-tree")
async def documents_archive_tree():
    """返回归档树——嵌套字典映射出的知识图谱。

    归档路径的各个层级是 LLM 对文件共有属性的归纳与再提炼，
    与扁平的关键字 (auto_tags/custom_tags) 是两个不同的概念。
    """
    try:
        all_docs = merge_tags_into_documents(_fetch_all_documents())

        # 剪除空的陈旧目录，再把没有归档路径的孤儿文档归入「未分类」
        tree = prune_empty_nodes()
        reconcile_orphans(tree, [d.get("id", "") for d in all_docs if d.get("id")])
        # 重新合并，使 reconcile 写入的 archive_path 反映到文档上
        all_docs = merge_tags_into_documents(all_docs)

        doc_map = {d.get("id", ""): d for d in all_docs if d.get("id")}
        return {
            "total_docs": len(all_docs),
            "tree": serialize(tree, doc_map),
        }
    except Exception as e:
        logger.error(f"Build archive tree failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/documents/tree")
async def documents_tree():
    """兼容旧接口：把归档树摊平成旧的 tag 树结构。

    真正的知识图谱是 /documents/archive-tree，此接口仅保留向后兼容。
    """
    try:
        data = await documents_archive_tree()
        flat: list[dict] = []

        def flatten(node: dict, depth: int):
            for child in node.get("children", []):
                if child.get("kind") == "document":
                    continue
                flat.append({
                    "name": child.get("name", ""),
                    "tag_type": "custom" if depth < 3 else "auto",
                    "children": [
                        {"id": c["id"], "name": c["name"], "word_count": c.get("word_count", 0),
                         "pdf_type": c.get("pdf_type", "")}
                        for c in child.get("children", []) if c.get("kind") == "document"
                    ],
                })
                flatten(child, depth + 1)

        flatten(data["tree"], 1)
        return {"total_docs": data["total_docs"], "tree": flat}
    except Exception as e:
        logger.error(f"Build legacy tree failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/documents/rearchive")
async def rearchive_documents(only_unfiled: bool = False):
    """为每个文件重新归纳 3-4 级归档路径（结合主旨/概要，从根目录开枝散叶）。

    - only_unfiled=false（默认）: 重新归档全部文档
    - only_unfiled=true: 只重新归档尚未有归档路径（未分类）的文档
    """
    try:
        all_docs = merge_tags_into_documents(_fetch_all_documents())
        updated: list[dict] = []
        for doc in all_docs:
            doc_id = doc.get("id", "")
            if not doc_id:
                continue
            archive_path_cur = doc.get("archive_path", []) or []
            if only_unfiled and archive_path_cur:
                continue  # 已有归档路径，跳过

            levels = await archive_path(
                "",
                keywords=doc.get("keywords", []),
                summary=doc.get("summary", ""),
                title=doc.get("name") or doc.get("title", ""),
            )
            if levels:
                place_document(doc_id, levels)
                updated.append({"doc_id": doc_id, "path": levels})

        logger.info(f"Re-archived {len(updated)} documents")
        return {"count": len(updated), "updated": updated}
    except Exception as e:
        logger.error(f"Re-archive failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/documents/{document_id}")
async def delete_document_api(document_id: str):
    """Delete a document by ID."""
    try:
        delete_document(document_id)
        delete_hash(document_id)
        delete_tags(document_id)
        # 同步把文档从归档树摘除，避免留下幽灵 doc_id（目录会因此
        # 明明看着空却删不掉——_collect_doc_ids 仍能数到它）。
        try:
            remove_document(document_id)
        except Exception as ae:
            logger.warning(f"Remove doc from archive tree failed: {ae}")
        return {"success": True, "message": f"Document {document_id} deleted"}
    except Exception as e:
        logger.error(f"Failed to delete document {document_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search")
async def search_api(req: SearchRequest):
    """Semantic search with hybrid BM25 + vector + RRF fusion."""
    try:
        results = await search(req.query, top_k=10, archive_path=None)

        # 补充 chunk 信息
        for r in results:
            r["chunk_id"] = r.pop("chunk_id")  # 重命名

        return {"results": results}

    except Exception as e:
        logger.error(f"Search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search/stream")
async def search_stream_api(req: SearchRequest):
    """Stream search results (SSE)."""
    try:
        async def event_generator():
            results = await search(req.query, top_k=10, archive_path=None)
            for r in results:
                r["chunk_id"] = r.pop("chunk_id")
                yield f"data: {__import__('json').dumps(r)}\n\n"

        return StreamingResponse(event_generator(), media_type="text/event-stream")

    except Exception as e:
        logger.error(f"Stream search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/documents")
async def list_documents_api(page: int = 1, limit: int = 20, archive_path: Optional[str] = None):
    """List documents with optional archive path filter."""
    try:
        result = list_documents(page=page, limit=limit, archive_path=archive_path)
        # 合并 tag_store 中的标签/归档路径/pdf_type；并补齐前端依赖的
        # 旧版（Dify 时代）字段：name 与 indexing_status。本地入库管道
        # 是同步完成的——出现在列表里的文档必然已索引完成。
        result["data"] = merge_tags_into_documents(result.get("data", []))
        for doc in result["data"]:
            doc.setdefault("name", doc.get("title", "未命名"))
            doc["indexing_status"] = "completed"
        return result

    except Exception as e:
        logger.error(f"Failed to list documents: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/chunks/{chunk_id}")
async def get_chunk_api(chunk_id: int):
    """Get a chunk by ID."""
    try:
        chunk = get_chunk_by_id(chunk_id)
        if not chunk:
            raise HTTPException(status_code=404, detail="Chunk not found")
        return chunk
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get chunk {chunk_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/documents/{document_id}/tags")
async def update_document_tags(document_id: str, req: UpdateTagsRequest):
    """更新文档的自定义标签（最多 15 个）。"""
    if len(req.custom_tags) > 15:
        raise HTTPException(status_code=400, detail="Max 15 custom tags allowed")
    try:
        return update_custom_tags(document_id, req.custom_tags)
    except Exception as e:
        logger.error(f"Update tags failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/tree/move")
async def move_tree_node(req: MoveNodeRequest):
    """把标签分支或文档移动到新的父标签下。"""
    if not req.target_tag:
        raise HTTPException(status_code=400, detail="target_tag is required")
    try:
        if req.source_doc_id:
            result = move_document_to_tag(req.source_doc_id, req.target_tag)
        elif req.source_tag:
            result = move_tag_branch(req.source_tag, req.target_tag)
        else:
            raise HTTPException(status_code=400, detail="Must provide source_tag or source_doc_id")
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Tree move failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/archive/move")
async def archive_move(req: ArchiveMoveRequest):
    """在归档树内移动节点（拖放）。

    拖动会「同时」改变嵌套字典结构与受影响文档的 archive_path，
    由 archive_store 保证两者同步落盘。
    """
    if not req.target_node_id:
        raise HTTPException(status_code=400, detail="target_node_id is required")
    try:
        if req.source_doc_id:
            result = move_document(req.source_doc_id, req.target_node_id)
        elif req.source_node_id:
            result = move_node(req.source_node_id, req.target_node_id)
        else:
            raise HTTPException(status_code=400, detail="Must provide source_node_id or source_doc_id")
        return result
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Archive move failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/archive/rename")
async def archive_rename(req: RenameNodeRequest):
    """重命名目录节点。该节点下所有文档的 archive_path 会同步重写。"""
    try:
        return rename_node(req.node_id, req.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Rename node failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/archive/create-node")
async def archive_create_node(req: CreateNodeRequest):
    """在指定目录下新建子目录（带 pinned 标记，不会因暂时为空而被自动剪除）。"""
    try:
        return create_node(req.parent_node_id, req.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Create node failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/archive/delete-node")
async def archive_delete_node(req: DeleteNodeRequest):
    """删除目录。目录及其子目录中不能有文档。"""
    try:
        return delete_node(req.node_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Delete node failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search/scoped/stream")
async def search_scoped_stream(req: ScopedSearchRequest):
    """范围检索问答：仅在给定文档集合内检索，再流式返回答案（SSE）。

    先做本地混合检索（BM25 + 向量 + RRF），把结果过滤到 doc_ids 范围内，
    再将上下文注入 prompt，由 LLM 仅依据该上下文作答。
    """
    def _join_chunks(chunks: list[tuple[str, str]]) -> str:
        parts = []
        for name, content in chunks:
            label = f"【{name}】" if name else "【内容】"
            parts.append(f"{label}\n{content[:800]}")
        return "\n\n".join(parts)

    async def event_generator():
        try:
            doc_set = {d for d in req.doc_ids if d}
            if not doc_set:
                yield f"data: {json.dumps({'answer': '未指定检索范围。'})}\n\n"
                return

            # 1) 本地混合检索，再按范围过滤
            results = await search(req.query, top_k=30)
            chunks: list[tuple[str, str]] = [
                (r.get("title", ""), (r.get("text") or "").strip())
                for r in results
                if r.get("doc_id") in doc_set and (r.get("text") or "").strip()
            ]

            # 2) 检索无命中时，退化为直接取范围内文档的前若干分块
            if not chunks:
                for did in list(doc_set)[:8]:
                    try:
                        for c in (get_chunks_by_doc_id(did) or [])[:5]:
                            content = (c.get("text") or "").strip()
                            if content:
                                chunks.append((c.get("title", ""), content))
                    except Exception as e:
                        logger.warning(f"Chunk dump failed for {did}: {e}")

            context = _join_chunks(chunks)
            if not context:
                yield f"data: {json.dumps({'answer': '当前范围内没有可检索的内容，请换个目录/文件或问题。'})}\n\n"
                return

            prompt = (
                "你是知识库问答助手。请**仅依据**以下【范围内文档内容】回答用户问题，"
                "不得编造、不得引用范围之外的信息；若内容不足以回答，请直接说明。\n\n"
                f"【范围】{req.scope_name or '指定范围'}\n\n"
                f"【范围内文档内容】\n{context}\n\n"
                f"【用户问题】{req.query}"
            )
            text = await llm_answer(
                prompt,
                system_prompt="你是知识库问答助手，严格依据给定的资料回答，不编造。",
                max_tokens=1000,
            )
            yield f"data: {json.dumps({'answer': text or '未能生成回答，请稍后重试。'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
