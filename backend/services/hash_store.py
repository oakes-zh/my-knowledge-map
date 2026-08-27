"""Hash-based deduplication store.

Stores a SHA-256 content hash per document_id so we can detect duplicate
uploads / text submissions and skip re-ingesting.

Uses a simple JSON file for persistence (same pattern as tag_store).
"""

import hashlib
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

STORE_PATH = Path(__file__).parent.parent / "data" / "hash_store.json"


def _load_store() -> dict:
    """Load {hash: document_id} mapping."""
    if not STORE_PATH.exists():
        return {}
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load hash store: {e}")
        return {}


def _save_store(store: dict):
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(STORE_PATH, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=2)


def compute_text_hash(text: str) -> str:
    """Return SHA-256 hex digest of normalized text.

    Normalization: strip whitespace and lowercase so that trivial formatting
    differences (extra spaces / newlines / case) still match.
    """
    normalized = "".join(text.split()).lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def compute_file_hash(file_path: str) -> str:
    """Return SHA-256 hex digest of file bytes (exact binary match)."""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def find_duplicate(content_hash: str) -> str | None:
    """Return the existing document_id if this hash already exists, else None."""
    store = _load_store()
    return store.get(content_hash)


def save_hash(document_id: str, content_hash: str):
    """Record a hash -> document_id mapping after successful ingest."""
    store = _load_store()
    store[content_hash] = document_id
    _save_store(store)
    logger.info(f"Saved hash {content_hash[:12]}… -> {document_id}")


def delete_hash(document_id: str):
    """Remove all hash entries pointing to this document_id (on delete)."""
    store = _load_store()
    to_remove = [h for h, did in store.items() if did == document_id]
    for h in to_remove:
        del store[h]
    if to_remove:
        _save_store(store)
        logger.info(f"Removed {len(to_remove)} hash entry(ies) for {document_id}")
