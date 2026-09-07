"""向量存储：numpy 暴力余弦检索"""
import sqlite3
import logging
import struct
from typing import List, Dict, Any, Optional
import numpy as np

from storage import get_connection

logger = logging.getLogger(__name__)


class VectorStore:
    """基于 numpy 暴力余弦的向量存储"""

    def __init__(self, db_path: str = "./kb.db"):
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self.dim = self._get_dim()

    def _get_dim(self) -> int:
        """获取 embedding 维度"""
        try:
            row = self.conn.execute(
                "SELECT value FROM meta WHERE key = ?",
                ("embedding_dim",)
            ).fetchone()
            return int(row["value"]) if row else 512
        except sqlite3.OperationalError:
            return 512

    def _vector_to_blob(self, vector: List[float]) -> bytes:
        """向量转 BLOB（float32）"""
        return struct.pack(f"{len(vector)}f", *vector)

    def _blob_to_vector(self, blob: bytes) -> np.ndarray:
        """BLOB 转向量"""
        return np.frombuffer(blob, dtype=np.float32)

    def save_embedding(self, chunk_id: int, vector: List[float]) -> None:
        """保存 embedding"""
        blob = self._vector_to_blob(vector)
        self.conn.execute(
            "UPDATE chunks SET embedding = ? WHERE id = ?",
            (blob, chunk_id)
        )
        self.conn.commit()

    def load_embeddings(self, chunk_ids: List[int]) -> Dict[int, np.ndarray]:
        """批量加载 embedding"""
        placeholders = ",".join("?" * len(chunk_ids))
        rows = self.conn.execute(
            f"SELECT id, embedding FROM chunks WHERE id IN ({placeholders})",
            chunk_ids
        ).fetchall()

        result = {}
        for row in rows:
            chunk_id = row["id"]
            blob = row["embedding"]
            result[chunk_id] = self._blob_to_vector(blob)

        return result

    def cosine_similarity(self, vec1: np.ndarray, vec2: np.ndarray) -> float:
        """计算余弦相似度"""
        dot = np.dot(vec1, vec2)
        norm1 = np.linalg.norm(vec1)
        norm2 = np.linalg.norm(vec2)
        if norm1 == 0 or norm2 == 0:
            return 0.0
        return dot / (norm1 * norm2)

    def search(
        self,
        query_vector: List[float],
        top_k: int = 10,
        chunk_ids: Optional[List[int]] = None
    ) -> List[Dict[str, Any]]:
        """
        向量检索（暴力余弦）

        Args:
            query_vector: 查询向量
            top_k: 返回前 K 个结果
            chunk_ids: 可选过滤，只在这些 chunk_id 中搜索

        Returns:
            [{"chunk_id": int, "score": float, "text": str}, ...]
        """
        # 加载所有 embedding（实际应用中可缓存）
        rows = self.conn.execute(
            "SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL"
        ).fetchall()

        if chunk_ids:
            rows = [r for r in rows if r["id"] in chunk_ids]

        query_vec = np.array(query_vector, dtype=np.float32)

        # 计算相似度
        results = []
        for row in rows:
            chunk_id = row["id"]
            blob = row["embedding"]
            vec = self._blob_to_vector(blob)
            score = self.cosine_similarity(query_vec, vec)
            results.append({
                "chunk_id": chunk_id,
                "score": score,
                "text": self.conn.execute(
                    "SELECT text FROM chunks WHERE id = ?",
                    (chunk_id,)
                ).fetchone()["text"]
            })

        # 排序并取 Top K
        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:top_k]

    def get_chunk_count(self) -> int:
        """获取分块总数"""
        return self.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]

    def get_doc_count(self) -> int:
        """获取文档总数"""
        return self.conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]

    def close(self) -> None:
        """关闭连接"""
        self.conn.close()


# 全局实例
vector_store = VectorStore()
