import httpx
import logging
from typing import Optional
from config import settings

logger = logging.getLogger(__name__)


class DifyClient:
    """Dify Knowledge + Chat API client."""

    def __init__(self):
        self.base_url = settings.dify_base_url.rstrip("/")
        self.knowledge_key = settings.dify_knowledge_api_key
        self.chat_key = settings.dify_chat_api_key
        self.dataset_id = settings.dify_dataset_id

    # ---------- Knowledge API ----------

    async def create_document_by_text(
        self,
        name: str,
        text: str,
        indexing_technique: str = "high_quality",
        process_rule: Optional[dict] = None,
    ) -> dict:
        """Create a document in the Dify knowledge base from raw text."""
        url = f"{self.base_url}/datasets/{self.dataset_id}/document/create-by-text"
        headers = {"Authorization": f"Bearer {self.knowledge_key}"}
        payload = {
            "name": name[:100],
            "text": text,
            "indexing_technique": indexing_technique,
            "process_rule": process_rule or {"mode": "automatic"},
        }
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            return resp.json()

    async def create_document_by_file(
        self, file_path: str, name: Optional[str] = None
    ) -> dict:
        """Upload a file directly to the Dify knowledge base."""
        import os

        url = f"{self.base_url}/datasets/{self.dataset_id}/document/create-by-file"
        headers = {"Authorization": f"Bearer {self.knowledge_key}"}
        filename = name or os.path.basename(file_path)

        async with httpx.AsyncClient(timeout=120) as client:
            with open(file_path, "rb") as f:
                files = {"file": (filename, f)}
                data = {
                    "name": filename,
                    "indexing_technique": "high_quality",
                    "process_rule": '{"mode": "automatic"}',
                }
                resp = await client.post(url, files=files, data=data, headers=headers)
                resp.raise_for_status()
                return resp.json()

    async def list_documents(self, page: int = 1, limit: int = 20) -> dict:
        """List documents in the knowledge base."""
        url = f"{self.base_url}/datasets/{self.dataset_id}/documents"
        headers = {"Authorization": f"Bearer {self.knowledge_key}"}
        params = {"page": page, "limit": limit}
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, headers=headers, params=params)
            resp.raise_for_status()
            return resp.json()

    async def delete_document(self, document_id: str) -> dict:
        url = f"{self.base_url}/datasets/{self.dataset_id}/documents/{document_id}"
        headers = {"Authorization": f"Bearer {self.knowledge_key}"}
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.delete(url, headers=headers)
            resp.raise_for_status()
            # Dify returns 204 No Content on successful delete
            if resp.status_code == 204 or not resp.text:
                return {"success": True, "document_id": document_id}
            return resp.json()

    # ---------- Chat API ----------

    async def chat(
        self,
        query: str,
        user: str = "default",
        conversation_id: str = "",
        stream: bool = False,
    ) -> dict:
        """Send a chat message with RAG retrieval."""
        url = f"{self.base_url}/chat-messages"
        headers = {"Authorization": f"Bearer {self.chat_key}"}
        payload = {
            "inputs": {},
            "query": query,
            "response_mode": "streaming" if stream else "blocking",
            "user": user,
        }
        if conversation_id:
            payload["conversation_id"] = conversation_id

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            return resp.json()


dify_client = DifyClient()
