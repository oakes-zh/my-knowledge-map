import os
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
from services.dify_client import dify_client
from services.document_parser import extract_text
from services.url_fetcher import fetch_url_content
from services.llm_processor import summarize_text, auto_tag, archive_path
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

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Personal KB - Preprocessing Service", version="0.1.0")

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


# ==================== Routes ====================


async def _archive_document(doc_id: str, text: str, tags: list[str], summary: str = "", title: str = ""):
    """Induce a 3-4 level archive path and file the document into the archive tree.

    文件关键字 (tags) 是扁平、独立的属性；归档路径是 LLM 对文档「主旨/概要」
    的归纳与再提炼——一条从根目录出发、逐级开枝散叶的层级路径（3-4 级），
    而不是关键字列表本身。归档动作会同时改变嵌套字典结构与文档的
    archive_path（由 archive_store 保证同步）。
    """
    try:
        levels = await archive_path(text, tags, summary=summary, title=title)
        if levels:
            place_document(doc_id, levels)
            logger.info(f"Archived {doc_id} -> {' / '.join(levels)}")
        else:
            logger.info(f"No archive path induced for {doc_id}, will reconcile as 未分类")
    except Exception as e:
        logger.warning(f"Archive placement failed for {doc_id}: {e}")


@app.get("/health")
async def health():
    return {"status": "ok", "dify_base_url": settings.dify_base_url}


@app.post("/ingest/text", response_model=IngestResponse)
async def ingest_text(req: IngestTextRequest):
    """Ingest raw text directly into the knowledge base."""
    text = clean_text(req.content)
    if not text:
        raise HTTPException(status_code=400, detail="Empty content after cleaning")

    # Dedup: check if identical content already ingested
    content_hash = compute_text_hash(text)
    existing_id = find_duplicate(content_hash)
    if existing_id:
        logger.info(f"Duplicate text detected, skipping ingest. Existing doc: {existing_id}")
        return IngestResponse(
            success=False,
            document_id=existing_id,
            title=req.title or text[:50],
            message="内容重复，已跳过入库（知识库中已存在相同内容）",
        )

    title = req.title or text[:50]

    try:
        summary = await summarize_text(text)
        tags = await auto_tag(text)

        result = await dify_client.create_document_by_text(
            name=title,
            text=text,
        )

        doc_id = result.get("document", {}).get("id", "")
        logger.info(f"Ingested text: {title} -> {doc_id}")

        # Persist auto tags and hash locally
        if tags and doc_id:
            save_auto_tags(doc_id, tags, summary=summary)
        if doc_id:
            save_hash(doc_id, content_hash)

        # File the document into the archive tree (LLM-induced 3-4 level hierarchy)
        if doc_id:
            await _archive_document(doc_id, text, tags, summary=summary, title=title)

        return IngestResponse(
            success=True,
            document_id=doc_id,
            title=title,
            summary=summary,
            tags=tags,
            message="Text ingested successfully",
        )
    except Exception as e:
        logger.error(f"Text ingestion failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ingest/url", response_model=IngestResponse)
async def ingest_url(req: IngestURLRequest):
    """Fetch a URL, extract content, and ingest into the knowledge base."""
    fetched = await fetch_url_content(req.url)
    text = clean_text(fetched["content"])

    if not text or len(text) < 20:
        raise HTTPException(status_code=400, detail="Could not extract meaningful content from URL")

    # Dedup: check if identical content already ingested
    content_hash = compute_text_hash(text)
    existing_id = find_duplicate(content_hash)
    if existing_id:
        logger.info(f"Duplicate URL content detected, skipping ingest. Existing doc: {existing_id}")
        return IngestResponse(
            success=False,
            document_id=existing_id,
            title=fetched["title"],
            message="内容重复，已跳过入库（知识库中已存在相同内容）",
        )

    title = fetched["title"]

    try:
        summary = await summarize_text(text)
        tags = await auto_tag(text)

        # Prepend source URL for traceability
        full_text = f"Source URL: {req.url}\n\n{text}"

        result = await dify_client.create_document_by_text(
            name=title,
            text=full_text,
        )

        doc_id = result.get("document", {}).get("id", "")
        logger.info(f"Ingested URL: {title} -> {doc_id}")

        # Persist auto tags and hash locally
        if tags and doc_id:
            save_auto_tags(doc_id, tags, summary=summary)
        if doc_id:
            save_hash(doc_id, content_hash)

        # File the document into the archive tree (LLM-induced 3-4 level hierarchy)
        if doc_id:
            await _archive_document(doc_id, text, tags, summary=summary, title=title)

        return IngestResponse(
            success=True,
            document_id=doc_id,
            title=title,
            summary=summary,
            tags=tags,
            message="URL content ingested successfully",
        )
    except Exception as e:
        logger.error(f"URL ingestion failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ingest/file", response_model=IngestResponse)
async def ingest_file(file: UploadFile = File(...)):
    """Upload a file (image/PDF/doc), extract text, and ingest into the knowledge base."""
    ext = get_file_extension(file.filename)

    # Save to temp location
    temp_path = UPLOAD_PATH / f"temp_{file.filename}"
    with open(temp_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    try:
        # Dedup: compute file hash first (exact binary match)
        file_hash = compute_file_hash(str(temp_path))
        existing_id = find_duplicate(file_hash)
        if existing_id:
            logger.info(f"Duplicate file detected, skipping ingest. Existing doc: {existing_id}")
            return IngestResponse(
                success=False,
                document_id=existing_id,
                title=file.filename or "",
                message="文件重复，已跳过入库（知识库中已存在相同文件）",
            )

        # Extract text based on file type (returns (text, pdf_type) for PDFs)
        text, pdf_type = await extract_text(str(temp_path), ext)
        text = clean_text(text)

        if not text or len(text) < 10:
            raise HTTPException(status_code=400, detail=f"Could not extract text from {ext} file")

        # Also check text-level dedup for extracted content
        content_hash = compute_text_hash(text)
        existing_text_id = find_duplicate(content_hash)
        if existing_text_id:
            logger.info(f"Duplicate file content detected, skipping ingest. Existing doc: {existing_text_id}")
            return IngestResponse(
                success=False,
                document_id=existing_text_id,
                title=file.filename or "",
                message="文件内容重复，已跳过入库（知识库中已存在相同内容）",
            )

        title = file.filename or text[:50]

        # For PDF and text files, can upload directly to Dify
        if ext in ("pdf", "txt", "md"):
            result = await dify_client.create_document_by_file(
                file_path=str(temp_path),
                name=title,
            )
            doc_id = result.get("document", {}).get("id", "")
        else:
            # For images (after OCR) or docx, push as text
            summary = await summarize_text(text)
            result = await dify_client.create_document_by_text(
                name=title,
                text=text,
            )
            doc_id = result.get("document", {}).get("id", "")

        summary = await summarize_text(text)
        tags = await auto_tag(text)

        # Persist auto tags, both hashes, and pdf_type locally
        if tags and doc_id:
            save_auto_tags(doc_id, tags, pdf_type=pdf_type, summary=summary)
        if doc_id:
            save_hash(doc_id, file_hash)
            save_hash(doc_id, content_hash)

        # File the document into the archive tree (LLM-induced 3-4 level hierarchy)
        if doc_id:
            await _archive_document(doc_id, text, tags, summary=summary, title=title)

        logger.info(f"Ingested file: {title} -> {doc_id} (pdf_type={pdf_type})")

        return IngestResponse(
            success=True,
            document_id=doc_id,
            title=title,
            summary=summary,
            tags=tags,
            pdf_type=pdf_type,
            message=f"File ({ext}) ingested successfully",
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"File ingestion failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Clean up temp file
        if temp_path.exists():
            os.remove(temp_path)


@app.post("/search")
async def search(req: SearchRequest):
    """Search the knowledge base via Dify Chat API (RAG)."""
    try:
        result = await dify_client.chat(
            query=req.query,
            user=req.user,
            conversation_id=req.conversation_id,
        )
        return result
    except Exception as e:
        logger.error(f"Search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search/stream")
async def search_stream(req: SearchRequest):
    """Stream search results via SSE."""
    import json

    async def event_generator():
        try:
            url = f"{settings.dify_base_url.rstrip('/')}/chat-messages"
            headers = {"Authorization": f"Bearer {settings.dify_chat_api_key}"}
            payload = {
                "inputs": {},
                "query": req.query,
                "response_mode": "streaming",
                "user": req.user,
            }
            if req.conversation_id:
                payload["conversation_id"] = req.conversation_id

            import httpx
            async with httpx.AsyncClient(timeout=120) as client:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
                    async for line in resp.aiter_lines():
                        if line.startswith("data: "):
                            yield f"{line}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/search/scoped/stream")
async def search_scoped_stream(req: ScopedSearchRequest):
    """Scoped RAG: retrieve only within the given documents, then stream an answer.

    Retrieval uses Dify's retrieve API (each record carries ``document_id``) and is
    filtered to ``doc_ids``; the answer is streamed through the chat app with the
    scoped context injected into the query, instructing the model to answer only
    from that context.
    """
    import json

    def _join_chunks(chunks: list[tuple[str, str]]) -> str:
        parts = []
        for name, content in chunks:
            label = f"【{name}】" if name else "【内容】"
            parts.append(f"{label}\n{content[:800]}")
        return "\n\n".join(parts)

    async def _build_context() -> str:
        doc_set = {d for d in req.doc_ids if d}
        if not doc_set:
            return ""
        # 1) Semantic retrieval, filtered to the scoped documents.
        try:
            data = await dify_client.retrieve(req.query, top_k=30)
            records = data.get("records", []) or []
            chunks: list[tuple[str, str]] = []
            for r in records:
                seg = r.get("segment") or {}
                doc = seg.get("document") or {}
                did = seg.get("document_id") or doc.get("id")
                if did in doc_set:
                    content = (seg.get("content") or "").strip()
                    if content:
                        chunks.append((doc.get("name", ""), content))
            if chunks:
                return _join_chunks(chunks)
        except Exception as e:
            logger.warning(f"Scoped retrieve failed, falling back to segment dump: {e}")
        # 2) Fallback: dump top segments of each scoped document (cap 8 docs).
        chunks = []
        for did in list(doc_set)[:8]:
            try:
                segs = await dify_client.list_document_segments(did, limit=20)
                for seg in (segs.get("data") or [])[:5]:
                    content = (seg.get("content") or "").strip()
                    if content:
                        chunks.append(((seg.get("document") or {}).get("name", ""), content))
            except Exception as e:
                logger.warning(f"Segment dump failed for {did}: {e}")
        return _join_chunks(chunks)

    async def event_generator():
        try:
            context = await _build_context()
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
            url = f"{settings.dify_base_url.rstrip('/')}/chat-messages"
            headers = {"Authorization": f"Bearer {settings.dify_chat_api_key}"}
            payload = {
                "inputs": {},
                "query": prompt,
                "response_mode": "streaming",
                "user": req.user,
            }
            if req.conversation_id:
                payload["conversation_id"] = req.conversation_id

            import httpx
            async with httpx.AsyncClient(timeout=120) as client:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
                    async for line in resp.aiter_lines():
                        if line.startswith("data: "):
                            yield f"{line}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/documents")
async def list_documents(page: int = 1, limit: int = 20):
    """List documents in the Dify knowledge base, with merged tags."""
    try:
        result = await dify_client.list_documents(page=page, limit=limit)
        if "data" in result:
            result["data"] = merge_tags_into_documents(result["data"])
        return result
    except Exception as e:
        logger.error(f"List documents failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def _fetch_all_documents() -> list[dict]:
    """Fetch all documents from Dify (up to 100)."""
    all_docs: list[dict] = []
    for page in range(1, 6):
        result = await dify_client.list_documents(page=page, limit=20)
        docs = result.get("data", [])
        all_docs.extend(docs)
        if not result.get("has_more", False):
            break
    return all_docs


@app.get("/documents/archive-tree")
async def documents_archive_tree():
    """Return the archive tree — the nested dictionary mapped to the knowledge graph.

    归档路径的各个层级是 LLM 对文件共有属性的归纳与再提炼，它与扁平的文件关键字
    (auto_tags/custom_tags) 是两个不同的概念。这里的树就是那个嵌套字典数据集。
    """
    try:
        all_docs = merge_tags_into_documents(await _fetch_all_documents())

        # Prune stale empty directories (no docs, no children), then reconcile
        # legacy/orphan docs (no archive path yet) under 未分类
        tree = prune_empty_nodes()
        reconcile_orphans(tree, [d.get("id", "") for d in all_docs if d.get("id")])
        # Re-merge so archive_path written by reconciliation is reflected
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
    """Legacy endpoint: derive a flat tag tree from the archive tree.

    Kept for backward compatibility. The real knowledge graph is
    ``/documents/archive-tree``.
    """
    try:
        data = await documents_archive_tree()
        # Flatten the archive tree into the old shape: every category whose path
        # has <= 3 levels becomes a top-level branch (custom-style), documents
        # become leaves under their immediate category.
        flat: list[dict] = []

        def flatten(node: dict, depth: int):
            if node.get("kind") == "document":
                return
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

    每个文档都会由 LLM 依据「主旨/概要 + 关键字 + 标题」重新归纳层级路径，
    并重新放入嵌套字典归档树；place_document 会同步重写各文档的 archive_path。
    """
    try:
        all_docs = merge_tags_into_documents(await _fetch_all_documents())
        updated: list[dict] = []
        for doc in all_docs:
            doc_id = doc.get("id", "")
            if not doc_id:
                continue
            archive_path_cur = doc.get("archive_path", []) or []
            if only_unfiled and archive_path_cur:
                continue  # skip docs that already have a path

            levels = await archive_path(
                "",
                keywords=doc.get("keywords", []),
                summary=doc.get("summary", ""),
                title=doc.get("name", ""),
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
async def delete_document(document_id: str):
    """Delete a document from the knowledge base."""
    try:
        result = await dify_client.delete_document(document_id)
        delete_tags(document_id)  # Clean up local tag data
        delete_hash(document_id)   # Clean up local hash data
        remove_document(document_id)  # Remove from archive tree (nested dict)
        return result
    except Exception as e:
        logger.error(f"Delete document failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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


@app.put("/documents/{document_id}/tags")
async def update_document_tags(document_id: str, req: UpdateTagsRequest):
    """Update custom tags for a document. Max 15 tags."""
    if len(req.custom_tags) > 15:
        raise HTTPException(status_code=400, detail="Max 5 custom tags allowed")
    try:
        return update_custom_tags(document_id, req.custom_tags)
    except Exception as e:
        logger.error(f"Update tags failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/tree/move")
async def move_tree_node(req: MoveNodeRequest):
    """Move a tag branch or document to a new parent tag in the tree.

    - If source_doc_id is provided: moves a single document under target_tag
    - If source_tag is provided: moves all documents under that tag to target_tag
    """
    if not req.target_tag:
        raise HTTPException(status_code=400, detail="target_tag is required")

    try:
        if req.source_doc_id:
            result = move_document_to_tag(req.source_doc_id, req.target_tag)
        elif req.source_tag:
            result = move_tag_branch(req.source_tag, req.target_tag)
        else:
            raise HTTPException(status_code=400, detail="Must provide source_tag or source_doc_id")

        logger.info(f"Tree move: source_tag={req.source_tag}, doc_id={req.source_doc_id}, target={req.target_tag}, moved={result['moved_count']}")
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Tree move failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/archive/move")
async def archive_move(req: ArchiveMoveRequest):
    """Move a node inside the archive tree (the nested dictionary).

    拖动操作会「同时」改变嵌套字典的结构与受影响文档的 archive_path：
    - source_doc_id: 把文档拖到某个分类节点下（改该文档的归档路径）
    - source_node_id: 把整个分类子树拖到另一个分类下（改子树内所有文档的归档路径）
    两者由 archive_store 保证同步落盘。
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

        logger.info(f"Archive move: node={req.source_node_id}, doc={req.source_doc_id}, target={req.target_node_id}, moved={result['moved_count']}")
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
    """重命名目录节点（右键菜单）。

    节点 id 与子结构不变，但该节点下所有文档的 archive_path 会同步重写，
    嵌套字典与文档信息保持一致。
    """
    try:
        return rename_node(req.node_id, req.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Rename node failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/archive/create-node")
async def archive_create_node(req: CreateNodeRequest):
    """在指定目录下新建子目录（右键菜单）。

    新建目录带 pinned 标记：不会因为暂时为空而被自动剪除，
    用户可用右键菜单「删除目录」清理。
    """
    try:
        return create_node(req.parent_node_id, req.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Create node failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/archive/delete-node")
async def archive_delete_node(req: DeleteNodeRequest):
    """删除目录（右键菜单）。目录及其子目录中不能有文档。"""
    try:
        return delete_node(req.node_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Delete node failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/documents/backfill-pdf-types")
async def backfill_pdf_types():
    """Retroactively detect and save pdf_type for existing PDF documents.

    Uses Dify document metadata (word_count + extension) as heuristic:
    - PDF with word_count >= 50 → text (Dify extracted text successfully)
    - PDF with word_count < 50 → image (likely scanned, needs OCR)
    - Non-PDF files → skip (pdf_type stays '')
    """
    try:
        all_docs = []
        for page in range(1, 6):
            result = await dify_client.list_documents(page=page, limit=20)
            docs = result.get("data", [])
            all_docs.extend(docs)
            if not result.get("has_more", False):
                break

        updated = []
        for doc in all_docs:
            doc_id = doc.get("id", "")
            ext = (doc.get("data_source_detail_dict", {})
                       .get("upload_file", {})
                       .get("extension", ""))

            if ext != "pdf":
                continue  # Skip non-PDF files

            # Check if pdf_type already set
            tags = get_tags(doc_id)
            if tags.get("pdf_type"):
                continue  # Already has pdf_type

            # Heuristic: use word_count from Dify
            word_count = doc.get("word_count", 0)
            pdf_type = "text" if word_count >= 50 else "image"

            save_pdf_type(doc_id, pdf_type)
            updated.append({
                "doc_id": doc_id,
                "name": doc.get("name", ""),
                "word_count": word_count,
                "pdf_type": pdf_type,
            })
            logger.info(f"Backfilled pdf_type for {doc.get('name', '')}: {pdf_type} (word_count={word_count})")

        return {"updated": updated, "count": len(updated)}
    except Exception as e:
        logger.error(f"Backfill pdf_type failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.backend_host, port=settings.backend_port)
