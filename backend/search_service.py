"""搜索服务：FTS5 + BM25 + 余弦 + RRF 融合"""
import sqlite3
import logging
from typing import List, Dict, Any, Optional
import math

from storage import get_connection, bigrams
from vector_store import vector_store

logger = logging.getLogger(__name__)


def bm25_search(
    query: str,
    top_k: int = 30,
    archive_path: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    FTS5 BM25 检索

    Args:
        query: 查询文本
        top_k: 返回前 K 个结果
        archive_path: 可选，按归档路径过滤

    Returns:
        [{"chunk_id": int, "score": float, "text": str, "doc_id": str}, ...]
    """
    conn = get_connection()
    query_bigram = bigrams(query)

    # FTS5 BM25 检索
    # 注意：bm25() 是 FTS5 辅助函数，必须写成 bm25(chunks_fts)，
    # 不能写成别名调用 cfts.bm25(cfts)（会被解析为列名+括号 → 语法错误）。
    # bm25() 返回负值且越负越相关；子查询先按相关度排序，再 JOIN chunks 取正文。
    rows = conn.execute(
        """
        SELECT c.id AS chunk_id, c.doc_id, c.text, -f.s AS score
        FROM (
            SELECT rowid AS rid, bm25(chunks_fts) AS s
            FROM chunks_fts
            WHERE chunks_fts MATCH ?
            ORDER BY s ASC
        ) f
        JOIN chunks c ON c.id = f.rid
        """,
        (query_bigram,)
    ).fetchall()

    # 应用归档路径过滤
    if archive_path:
        filtered = []
        doc_ids = {r["doc_id"] for r in rows}
        doc_rows = conn.execute(
            "SELECT id, archive_path FROM documents WHERE id IN (" + ",".join("?" * len(doc_ids)) + ")",
            list(doc_ids)
        ).fetchall()
        doc_map = {r["id"]: r["archive_path"] for r in doc_rows}
        for r in rows:
            if doc_map.get(r["doc_id"], "").startswith(archive_path):
                filtered.append(r)
        rows = filtered

    results = [dict(r) for r in rows]
    return results[:top_k]


def rrf_fusion(
    bm25_results: List[Dict[str, Any]],
    vector_results: List[Dict[str, Any]],
    k: int = 60
) -> List[Dict[str, Any]]:
    """
    RRF 融合 BM25 和向量检索结果

    RRF 公式：score = 1 / (k + rank)

    Args:
        bm25_results: BM25 检索结果
        vector_results: 向量检索结果
        k: RRF 常数

    Returns:
        融合后的结果列表
    """
    # 创建 rank 映射
    bm25_rank = {r["chunk_id"]: i + 1 for i, r in enumerate(bm25_results)}
    vector_rank = {r["chunk_id"]: i + 1 for i, r in enumerate(vector_results)}

    # RRF 分数
    rrf_scores = {}
    for chunk_id, rank in bm25_rank.items():
        rrf_scores[chunk_id] = rrf_scores.get(chunk_id, 0) + 1.0 / (k + rank)

    for chunk_id, rank in vector_rank.items():
        rrf_scores[chunk_id] = rrf_scores.get(chunk_id, 0) + 1.0 / (k + rank)

    # 合并结果
    fused_results = []
    for chunk_id, score in rrf_scores.items():
        # 从 bm25 或 vector 结果中取完整信息（优先 bm25）
        bm25_result = next((r for r in bm25_results if r["chunk_id"] == chunk_id), None)
        vector_result = next((r for r in vector_results if r["chunk_id"] == chunk_id), None)

        if bm25_result:
            result = dict(bm25_result)
            result["score"] = score
            result["vector_score"] = vector_result["score"] if vector_result else 0
        elif vector_result:
            result = dict(vector_result)
            result["score"] = score
            result["vector_score"] = vector_result["score"]
        else:
            continue

        fused_results.append(result)

    fused_results.sort(key=lambda x: x["score"], reverse=True)
    return fused_results


async def search(
    query: str,
    top_k: int = 10,
    archive_path: Optional[str] = None,
    use_vector: bool = True
) -> List[Dict[str, Any]]:
    """
    混合检索（BM25 + 向量 + RRF 融合）

    Args:
        query: 查询文本
        top_k: 返回前 K 个结果
        archive_path: 可选，按归档路径过滤
        use_vector: 是否启用向量检索

    Returns:
        [{"chunk_id": int, "score": float, "text": str, "doc_id": str, "title": str}, ...]
    """
    # BM25 检索
    bm25_results = bm25_search(query, top_k * 2, archive_path)

    if not bm25_results:
        return []

    # 向量检索（可选）：embedding 不可用时（未配置 key / 网络异常）降级为纯 BM25
    if use_vector:
        # 生成查询 embedding
        from embedding_service import embedding_service
        try:
            query_vec = await embedding_service.embed_text(query)

            # 向量检索
            vector_results = vector_store.search(query_vec, top_k * 2)

            # RRF 融合
            results = rrf_fusion(bm25_results, vector_results, k=60)
        except Exception as e:
            logger.warning(f"向量检索不可用，降级为纯 BM25 检索：{e}")
            results = bm25_results
    else:
        results = bm25_results

    # 补充文档标题
    conn = get_connection()
    doc_ids = {r["doc_id"] for r in results}
    rows = conn.execute(
        "SELECT id, title FROM documents WHERE id IN (" + ",".join("?" * len(doc_ids)) + ")",
        list(doc_ids)
    ).fetchall()
    doc_map = {r["id"]: r["title"] for r in rows}

    for r in results:
        r["title"] = doc_map.get(r["doc_id"], "未知文档")

    return results[:top_k]


async def search_stream(
    query: str,
    top_k: int = 10,
    archive_path: Optional[str] = None,
    use_vector: bool = True
):
    """流式检索（SSE）"""
    results = await search(query, top_k, archive_path, use_vector)

    for result in results:
        yield result


def get_chunk_by_id(chunk_id: int) -> Optional[Dict[str, Any]]:
    """根据 chunk_id 获取分块"""
    conn = get_connection()
    row = conn.execute(
        "SELECT c.*, d.title, d.archive_path FROM chunks c JOIN documents d ON c.doc_id = d.id WHERE c.id = ?",
        (chunk_id,)
    ).fetchone()
    if not row:
        return None
    return dict(row)
