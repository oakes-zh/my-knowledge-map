"""Local tag store for document metadata.

Stores auto-generated semantic tags and user custom tags per document.
Uses a simple JSON file for persistence.
"""

import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

STORE_PATH = Path(__file__).parent.parent / "data" / "tag_store.json"
MAX_TAGS = 15  # Support up to 15 tree levels


def _empty_entry() -> dict:
    return {"auto_tags": [], "custom_tags": [], "pdf_type": "", "archive_path": [], "summary": ""}


def _load_store() -> dict:
    """Load the tag store from JSON file."""
    if not STORE_PATH.exists():
        return {}
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load tag store: {e}")
        return {}


def _save_store(store: dict):
    """Save the tag store to JSON file."""
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(STORE_PATH, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=2)


def save_auto_tags(document_id: str, tags: list[str], pdf_type: str = "", summary: str = ""):
    """Save auto-generated semantic tags (and optional summary) for a document.

    The summary (主旨/概要) is persisted so the archive path can later be
    re-induced from it when re-archiving (rearchive).
    """
    store = _load_store()
    if document_id not in store:
        store[document_id] = _empty_entry()
    store[document_id]["auto_tags"] = tags[:MAX_TAGS]
    if pdf_type:
        store[document_id]["pdf_type"] = pdf_type
    if summary:
        store[document_id]["summary"] = summary
    _save_store(store)
    logger.info(f"Saved auto_tags for {document_id}: {tags[:MAX_TAGS]}, pdf_type: {pdf_type}")


def get_tags(document_id: str) -> dict:
    """Get auto_tags, custom_tags, pdf_type, archive_path, and summary for a document."""
    store = _load_store()
    entry = store.get(document_id, _empty_entry())
    return {
        "auto_tags": entry.get("auto_tags", []),
        "custom_tags": entry.get("custom_tags", []),
        "pdf_type": entry.get("pdf_type", ""),
        "archive_path": entry.get("archive_path", []),
        "summary": entry.get("summary", ""),
    }


def update_custom_tags(document_id: str, tags: list[str]) -> dict:
    """Update custom tags for a document. Max 15 tags."""
    store = _load_store()
    if document_id not in store:
        store[document_id] = _empty_entry()
    store[document_id]["custom_tags"] = tags[:MAX_TAGS]
    _save_store(store)
    logger.info(f"Updated custom_tags for {document_id}: {tags[:MAX_TAGS]}")
    return get_tags(document_id)


def delete_tags(document_id: str):
    """Delete tag data when a document is removed."""
    store = _load_store()
    if document_id in store:
        del store[document_id]
        _save_store(store)


def save_pdf_type(document_id: str, pdf_type: str):
    """Save pdf_type for a document (used for backfill)."""
    store = _load_store()
    if document_id not in store:
        store[document_id] = _empty_entry()
    store[document_id]["pdf_type"] = pdf_type
    _save_store(store)
    logger.info(f"Saved pdf_type for {document_id}: {pdf_type}")


def sync_archive_paths(paths_map: dict[str, list[str]]):
    """Rewrite the archive_path mirror for documents from the archive tree.

    Called by the archive store after ANY structural change (drag/move/place)
    so the nested dictionary and the per-document info stay synchronized.
    """
    store = _load_store()
    changed = False
    for doc_id, path in paths_map.items():
        if doc_id not in store:
            store[doc_id] = _empty_entry()
            changed = True
        if store[doc_id].get("archive_path", []) != path:
            store[doc_id]["archive_path"] = list(path)
            changed = True
    if changed:
        _save_store(store)


def compute_tree_path(auto_tags: list[str], custom_tags: list[str], archive_path: list[str] | None = None) -> str:
    """Compute the display path for a document.

    归档目录是 LLM 重新语义归纳的层级结构，与扁平关键字完全无关。因此只展示
    archive_path；没有归档路径的文档显示「未分类」，绝不把关键字列表当作
    归档目录展示（避免混为一谈）。
    """
    if archive_path:
        return " / ".join(archive_path)
    return "未分类"


def move_tag_branch(source_tag: str, target_tag: str) -> dict:
    """Associate all documents under source_tag with target_tag.

    In the flat keyword model, this means: "add target_tag to all docs that have source_tag".
    - If target_tag is '__root__': removes source_tag from all affected docs' custom_tags
    - Otherwise: adds target_tag to affected docs' custom_tags (does not remove source_tag)
    - Caps at MAX_TAGS

    Returns count of moved documents.
    """
    if source_tag == target_tag:
        return {"moved_count": 0, "doc_ids": [], "message": "source and target are the same"}

    store = _load_store()
    moved_docs = []

    for doc_id, entry in store.items():
        auto_tags = entry.get("auto_tags", [])
        custom_tags = entry.get("custom_tags", [])

        # Flat model: find docs where source_tag appears ANYWHERE in tags
        all_tags = custom_tags + auto_tags
        if source_tag not in all_tags:
            continue

        if target_tag == "__root__":
            # Move to root: remove source_tag from custom_tags
            new_custom = [t for t in custom_tags if t != source_tag]
        else:
            # Flat model: add target_tag (prepend), keep existing tags, dedupe
            remaining = [t for t in custom_tags if t != target_tag]
            new_custom = [target_tag] + remaining

        new_custom = new_custom[:MAX_TAGS]

        entry["custom_tags"] = new_custom
        moved_docs.append(doc_id)
        logger.info(f"Associated doc {doc_id} tag '{source_tag}' -> '{target_tag}'")

    _save_store(store)
    return {"moved_count": len(moved_docs), "doc_ids": moved_docs}


def move_document_to_tag(doc_id: str, target_tag: str) -> dict:
    """Move a single document to be under target_tag.

    If target_tag is '__root__': removes all custom_tags (moves to root).
    Otherwise: prepends target_tag to custom_tags (removing duplicates).
    """
    store = _load_store()
    if doc_id not in store:
        store[doc_id] = _empty_entry()

    entry = store[doc_id]
    custom_tags = entry.get("custom_tags", [])

    if target_tag == "__root__":
        # Move to root: clear custom tags
        new_custom: list[str] = []
    else:
        # Build new custom_tags: [target, ...remaining minus target]
        remaining = [t for t in custom_tags if t != target_tag]
        new_custom = [target_tag] + remaining

    new_custom = new_custom[:MAX_TAGS]

    entry["custom_tags"] = new_custom
    _save_store(store)
    logger.info(f"Moved doc {doc_id} to tag '{target_tag}'")
    return {"moved_count": 1, "doc_ids": [doc_id]}


def merge_tags_into_documents(documents: list[dict]) -> list[dict]:
    """Merge stored tags, archive path, and pdf_type into document list data."""
    store = _load_store()
    for doc in documents:
        doc_id = doc.get("id", "")
        entry = store.get(doc_id, _empty_entry())
        auto_tags = entry.get("auto_tags", [])
        custom_tags = entry.get("custom_tags", [])
        archive_path = entry.get("archive_path", [])
        doc["auto_tags"] = auto_tags
        doc["custom_tags"] = custom_tags
        doc["pdf_type"] = entry.get("pdf_type", "")
        doc["archive_path"] = archive_path
        doc["summary"] = entry.get("summary", "")
        # 文件关键字: flat, independent — the raw material of the archive path
        doc["keywords"] = list(dict.fromkeys(custom_tags + auto_tags))
        doc["tree_path"] = compute_tree_path(auto_tags, custom_tags, archive_path)
    return documents
