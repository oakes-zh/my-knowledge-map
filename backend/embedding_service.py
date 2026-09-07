"""Embedding 服务：OpenAI 兼容 API（支持硅基流动 BAAI/bge-m3 或 OpenAI）"""
import httpx
import logging
from typing import List, Optional
from pathlib import Path

from config import settings

logger = logging.getLogger(__name__)


class EmbeddingService:
    """OpenAI 兼容 embedding API 客户端"""

    def __init__(
        self,
        base_url: str = getattr(settings, "embedding_base_url", "https://api.siliconflow.cn/v1"),
        api_key: str = getattr(settings, "embedding_api_key", ""),
        model: str = getattr(settings, "embedding_model", "BAAI/bge-m3"),
        dimensions: int = getattr(settings, "embedding_dimensions", 512)
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.dimensions = dimensions

    async def embed_text(self, text: str) -> List[float]:
        """
        对单段文本生成 embedding

        Args:
            text: 输入文本

        Returns:
            512 维向量（float）
        """
        if not text or len(text.strip()) == 0:
            raise ValueError("Text cannot be empty")

        if not self.api_key:
            raise RuntimeError("EMBEDDING_API_KEY 未配置，无法生成向量（请在 .env 中配置后重启）")

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.base_url}/embeddings",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": self.model,
                    "input": text,
                    "dimensions": self.dimensions
                }
            )
            response.raise_for_status()
            result = response.json()

        embedding = result["data"][0]["embedding"]
        if len(embedding) != self.dimensions:
            logger.warning(
                f"Expected {self.dimensions} dimensions, got {len(embedding)}"
            )
            # 截断或填充到目标维度
            if len(embedding) > self.dimensions:
                embedding = embedding[:self.dimensions]
            else:
                embedding = embedding + [0.0] * (self.dimensions - len(embedding))

        return embedding

    async def embed_texts(self, texts: List[str]) -> List[List[float]]:
        """
        批量生成 embedding（OpenAI 兼容 API 通常支持批量）

        Args:
            texts: 输入文本列表

        Returns:
            embedding 列表
        """
        if not texts:
            return []

        if not self.api_key:
            raise RuntimeError("EMBEDDING_API_KEY 未配置，无法生成向量（请在 .env 中配置后重启）")

        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{self.base_url}/embeddings",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": self.model,
                    "input": texts,
                    "dimensions": self.dimensions
                }
            )
            response.raise_for_status()
            result = response.json()

        embeddings = [d["embedding"] for d in result["data"]]

        # 确保所有向量维度一致（注意：必须写回列表，不能只重绑局部变量）
        for i, emb in enumerate(embeddings):
            if len(emb) > self.dimensions:
                embeddings[i] = emb[: self.dimensions]
            elif len(emb) < self.dimensions:
                embeddings[i] = emb + [0.0] * (self.dimensions - len(emb))

        return embeddings


# 全局实例
embedding_service = EmbeddingService()
