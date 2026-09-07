"""Archive tree store — the nested dictionary that maps to the knowledge graph.

Key concepts (per product design)
---------------------------------
* 文件关键字 (keywords): flat, *independent* semantic attributes of a document.
  They live in ``tag_store`` as ``auto_tags`` + ``custom_tags`` and are NOT
  hierarchical. They are the raw material, not the filing system.

* 归档路径 (archive path): the LLM's *induction and re-refinement* of a
  document's common attributes into a HIERARCHICAL path (list of levels).
  These levels are deliberately NOT the same as the keyword list — they are a
  re-categorization produced by the model.

* 归档树 (archive tree): a single nested dictionary (the knowledge graph).
  Each node is ``{id, name, doc_ids, children}``. The tree is the **source of
  truth for structure**; every document's ``archive_path`` (a list of node
  names from root to the node that holds it) is a *derived mirror*, rewritten
  into ``tag_store`` on every structural change so the two never drift apart.

Why a nested dict (not a flat tag map)
---------------------------------------
Dragging a category node must relocate a whole subtree and re-stamp the archive
path of every document beneath it. A recursive nested structure makes that a
single detach/attach plus one tree walk — and the walk is also what keeps the
per-document ``archive_path`` synchronized.
"""

import json
import logging
import uuid
from pathlib import Path
from typing import Optional

from services.tag_store import sync_archive_paths

logger = logging.getLogger(__name__)

STORE_PATH = Path(__file__).parent.parent / "data" / "archive_tree.json"
ROOT_ID = "root"


# --------------------------------------------------------------------------- #
# Low-level persistence
# --------------------------------------------------------------------------- #

def _new_id() -> str:
    return "n_" + uuid.uuid4().hex[:12]


def _empty_tree() -> dict:
    return {"id": ROOT_ID, "name": "知识库", "doc_ids": [], "children": {}}


def _load_tree() -> dict:
    """Load the nested archive tree; return a fresh root if missing/corrupt."""
    if not STORE_PATH.exists():
        return _empty_tree()
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or data.get("id") != ROOT_ID:
            return _empty_tree()
        data.setdefault("doc_ids", [])
        data.setdefault("children", {})
        return data
    except Exception as e:
        logger.error(f"Failed to load archive tree: {e}")
        return _empty_tree()


def _save_tree(tree: dict):
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(STORE_PATH, "w", encoding="utf-8") as f:
        json.dump(tree, f, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------------- #
# Tree traversal helpers (operate on a plain nested dict)
# --------------------------------------------------------------------------- #

def find_node(tree: dict, node_id: str) -> Optional[dict]:
    """Depth-first lookup of a node by id (returns the node dict or None)."""
    if tree.get("id") == node_id:
        return tree
    for child in tree.get("children", {}).values():
        found = find_node(child, node_id)
        if found:
            return found
    return None


def find_parent(tree: dict, node_id: str, parent: Optional[dict] = None) -> Optional[dict]:
    """Return the parent node dict for ``node_id`` (None for the root)."""
    if tree.get("id") == node_id:
        return parent
    for child in tree.get("children", {}).values():
        found = find_parent(child, node_id, tree)
        if found is not None or (child.get("id") == node_id):
            return found if found is not None else tree
    return None


def _find_child_by_name(node: dict, name: str) -> Optional[dict]:
    """Find a direct child of ``node`` whose name matches (case-insensitive).

    Reusing a node by name is what lets documents with shared attributes
    consolidate into the same category — the model's "归纳".
    """
    target = (name or "").strip().lower()
    for child in node.get("children", {}).values():
        if child.get("name", "").strip().lower() == target:
            return child
    return None


def _ensure_path(tree: dict, levels: list[str]) -> str:
    """Make sure ``levels`` exists as a branch; return the leaf node id.

    Operates in-place on ``tree`` (does NOT save). Creates nodes only when a
    same-named sibling does not already exist.
    """
    cur = tree
    for raw in levels:
        name = (raw or "").strip()
        if not name:
            continue
        child = _find_child_by_name(cur, name)
        if child is None:
            child = {"id": _new_id(), "name": name, "doc_ids": [], "children": {}}
            cur["children"][child["id"]] = child
        cur = child
    return cur["id"]


def _remove_doc_everywhere(tree: dict, doc_id: str):
    """Delete ``doc_id`` from every node's doc_ids (a doc lives in one place)."""
    for doc in list(tree.get("doc_ids", [])):
        if doc == doc_id:
            tree["doc_ids"].remove(doc_id)
    for child in tree.get("children", {}).values():
        _remove_doc_everywhere(child, doc_id)


def _collect_doc_ids(node: dict, acc: Optional[set] = None) -> set:
    if acc is None:
        acc = set()
    for d in node.get("doc_ids", []):
        acc.add(d)
    for child in node.get("children", {}).values():
        _collect_doc_ids(child, acc)
    return acc


def _collect_all_doc_ids(tree: dict) -> set:
    return _collect_doc_ids(tree)


# --------------------------------------------------------------------------- #
# Synchronization: the nested dict is authoritative, doc.archive_path is mirror
# --------------------------------------------------------------------------- #

def _prune_empty_nodes(node: dict) -> bool:
    """Recursively remove category nodes that hold no documents and no children.

    Bottom-up: returns True when ``node`` itself became empty, so the caller
    can delete it from its parent's ``children``. The root is never removed.

    An empty directory is one with ``doc_ids == []`` AND ``children == {}`` —
    a node that only routes to deeper categories is NOT empty and is kept.
    Nodes marked ``pinned`` (user-created via the graph's right-click menu)
    are NEVER auto-pruned: the user explicitly asked for them.
    """
    for child_id in list(node.get("children", {}).keys()):
        child = node["children"][child_id]
        if _prune_empty_nodes(child):
            del node["children"][child_id]
    if (
        node["id"] != ROOT_ID
        and not node.get("pinned")
        and not node.get("doc_ids")
        and not node.get("children")
    ):
        return True
    return False


def prune_empty_nodes() -> dict:
    """Load the tree, drop empty directories, persist only if anything changed."""
    tree = _load_tree()
    before = json.dumps(tree, ensure_ascii=False, sort_keys=True)
    _prune_empty_nodes(tree)
    if json.dumps(tree, ensure_ascii=False, sort_keys=True) != before:
        _save_tree(tree)
    return tree


def rebuild_and_sync(tree: dict) -> dict:
    """Prune empty directories, persist the tree, and rewrite doc archive_paths.

    Called at the end of EVERY structural mutation (place/move/delete), so the
    nested dict on disk never contains empty folders and the per-document
    ``archive_path`` mirror stays in lock-step with it. Returns
    ``{doc_id: [level, ...]}``.
    """
    _prune_empty_nodes(tree)
    _save_tree(tree)

    paths: dict[str, list[str]] = {}

    def walk(node: dict, acc: list[str]):
        path = acc + ([node["name"]] if node["id"] != ROOT_ID else [])
        for doc_id in node.get("doc_ids", []):
            paths[doc_id] = path
        for child in node.get("children", {}).values():
            walk(child, path)

    walk(tree, [])
    sync_archive_paths(paths)
    return paths


# --------------------------------------------------------------------------- #
# Public mutations — each one mutates the nested dict AND syncs doc info
# --------------------------------------------------------------------------- #

def place_document(doc_id: str, levels: list[str]) -> str:
    """File a document under the category branch described by ``levels``.

    Removes the doc from any previous location first, so a document has exactly
    one archive path. Returns the leaf node id.
    """
    tree = _load_tree()
    leaf_id = _ensure_path(tree, levels)
    _remove_doc_everywhere(tree, doc_id)
    leaf = find_node(tree, leaf_id)
    if doc_id not in leaf["doc_ids"]:
        leaf["doc_ids"].append(doc_id)
    rebuild_and_sync(tree)
    logger.info(f"Placed doc {doc_id} at archive path {levels}")
    return leaf_id


def move_document(doc_id: str, target_node_id: str) -> dict:
    """Drag a document onto a category (or root). Changes the doc's archive_path."""
    tree = _load_tree()
    target = find_node(tree, target_node_id)
    if target is None:
        raise ValueError(f"target node {target_node_id} not found")
    _remove_doc_everywhere(tree, doc_id)
    if doc_id not in target["doc_ids"]:
        target["doc_ids"].append(doc_id)
    rebuild_and_sync(tree)
    logger.info(f"Moved doc {doc_id} -> node {target_node_id}")
    return {"moved_count": 1, "doc_ids": [doc_id]}


def move_node(source_node_id: str, target_node_id: str) -> dict:
    """Drag a category subtree onto another category (or root).

    Re-attaches the whole subtree and re-stamps ``archive_path`` for every
    document beneath it — the nested structure and document info change together.
    """
    if source_node_id == target_node_id:
        return {"moved_count": 0, "doc_ids": [], "message": "source and target are the same"}

    tree = _load_tree()
    source = find_node(tree, source_node_id)
    if source is None:
        raise ValueError(f"source node {source_node_id} not found")
    if source_node_id == ROOT_ID:
        raise ValueError("cannot move the root node")

    # Guard against cycles: target must not be the source or inside it.
    if find_node(source, target_node_id) is not None:
        raise ValueError("cannot move a node into its own descendant")

    target = find_node(tree, target_node_id)
    if target is None:
        raise ValueError(f"target node {target_node_id} not found")

    # Detach from current parent.
    parent = find_parent(tree, source_node_id)
    if parent is None:
        raise ValueError("source has no parent")
    del parent["children"][source_node_id]

    # Attach under target (reuse id key keeps the subtree intact).
    target["children"][source_node_id] = source
    moved = _collect_doc_ids(source)
    rebuild_and_sync(tree)
    logger.info(f"Moved subtree {source_node_id} ({len(moved)} docs) -> {target_node_id}")
    return {"moved_count": len(moved), "doc_ids": list(moved)}


def rename_node(node_id: str, new_name: str) -> dict:
    """Rename a category node (right-click menu → 重命名).

    The node id and its children stay intact; every document beneath the node
    gets its ``archive_path`` re-stamped via rebuild_and_sync, so the nested
    dict and the doc info change together.
    """
    new_name = (new_name or "").strip()
    if not new_name:
        raise ValueError("目录名称不能为空")
    if len(new_name) > 30:
        raise ValueError("目录名称过长（最多 30 字）")

    tree = _load_tree()
    node = find_node(tree, node_id)
    if node is None:
        raise ValueError(f"node {node_id} not found")
    if node_id == ROOT_ID:
        raise ValueError("不能重命名根目录")

    old_name = node["name"]
    if old_name == new_name:
        return {"renamed": False, "node_id": node_id, "name": new_name}

    # Names must be unique among siblings (ensure_path consolidates by name).
    parent = find_parent(tree, node_id)
    if parent is not None and _find_child_by_name(parent, new_name) is not None:
        raise ValueError(f"同级目录已存在同名「{new_name}」")

    node["name"] = new_name
    rebuild_and_sync(tree)
    logger.info(f"Renamed node {node_id}: {old_name} -> {new_name}")
    return {"renamed": True, "node_id": node_id, "old_name": old_name, "name": new_name}


def create_node(parent_node_id: str, name: str) -> dict:
    """Create a new (empty) subdirectory under ``parent_node_id``.

    Used by the graph's right-click menu (新建子目录). Empty directories are
    auto-pruned by rebuild_and_sync only when they lose both docs and children,
    so a freshly created folder stays until the user files docs into it.
    """
    name = (name or "").strip()
    if not name:
        raise ValueError("目录名称不能为空")
    if len(name) > 30:
        raise ValueError("目录名称过长（最多 30 字）")

    tree = _load_tree()
    parent = find_node(tree, parent_node_id) if parent_node_id else tree
    if parent is None:
        raise ValueError(f"parent node {parent_node_id} not found")
    if _find_child_by_name(parent, name) is not None:
        raise ValueError(f"同级目录已存在同名「{name}」")

    # pinned: user-created directories survive the empty-directory auto-prune
    node = {"id": _new_id(), "name": name, "doc_ids": [], "children": {}, "pinned": True}
    parent["children"][node["id"]] = node
    rebuild_and_sync(tree)
    logger.info(f"Created node {node['id']} ({name}) under {parent_node_id}")
    return {"node_id": node["id"], "name": name, "parent_node_id": parent_node_id}


def delete_node(node_id: str) -> dict:
    """Delete a directory subtree (right-click menu → 删除目录).

    Refuses when the subtree still contains documents — move them away first.
    User-created (pinned) empty folders can always be deleted this way.
    """
    tree = _load_tree()
    node = find_node(tree, node_id)
    if node is None:
        raise ValueError(f"node {node_id} not found")
    if node_id == ROOT_ID:
        raise ValueError("不能删除根目录")
    if _collect_doc_ids(node):
        raise ValueError("目录非空：请先移走其中的文档（含子目录）")

    parent = find_parent(tree, node_id)
    if parent is None:
        raise ValueError("node has no parent")
    name = node.get("name", "")
    del parent["children"][node_id]
    rebuild_and_sync(tree)
    logger.info(f"Deleted node {node_id} ({name})")
    return {"deleted": True, "node_id": node_id, "name": name}


def remove_document(doc_id: str):
    """Drop a document from the archive tree (e.g. on deletion)."""
    tree = _load_tree()
    _remove_doc_everywhere(tree, doc_id)
    rebuild_and_sync(tree)


def reconcile_orphans(tree: dict, doc_ids: list[str]) -> bool:
    """Place documents that are not yet in the tree under a '未分类' bucket.

    Used so legacy documents (ingested before archive paths existed) and any
    doc the LLM failed to classify still appear in the graph. Returns True if
    anything was added.
    """
    present = _collect_all_doc_ids(tree)
    missing = [d for d in doc_ids if d not in present]
    if not missing:
        return False
    leaf_id = _ensure_path(tree, ["未分类"])
    leaf = find_node(tree, leaf_id)
    for d in missing:
        if d not in leaf["doc_ids"]:
            leaf["doc_ids"].append(d)
    rebuild_and_sync(tree)
    logger.info(f"Reconciled {len(missing)} orphan docs under 未分类")
    return True


# --------------------------------------------------------------------------- #
# Serialization for the frontend knowledge-graph tree
# --------------------------------------------------------------------------- #

def serialize(tree: dict, doc_map: dict) -> dict:
    """Convert the nested dict into a graph the frontend can render.

    Documents become leaf children (kind="document") of their category node, so
    keywords can be shown distinctly from the path that contains them.
    """

    def descendant_doc_count(node: dict) -> int:
        count = len(node.get("doc_ids", []))
        for child in node.get("children", {}).values():
            count += descendant_doc_count(child)
        return count

    def conv(node: dict) -> dict:
        is_root = node["id"] == ROOT_ID
        children = []
        # Sub-categories first
        for child in node.get("children", {}).values():
            children.append(conv(child))
        # Documents as leaf children
        for doc_id in node.get("doc_ids", []):
            d = doc_map.get(doc_id)
            if not d:
                continue
            children.append({
                "id": doc_id,
                "name": d.get("name") or d.get("title") or "未命名",
                "kind": "document",
                "word_count": d.get("word_count", 0),
                "pdf_type": d.get("pdf_type", ""),
                "keywords": d.get("keywords", []),
                "archive_path": d.get("archive_path", []),
            })
        return {
            "id": node["id"],
            "name": node["name"],
            "kind": "root" if is_root else "category",
            "pinned": node.get("pinned", False),
            "doc_count": descendant_doc_count(node),
            "children": children,
        }

    return conv(tree)


def get_root() -> dict:
    return _load_tree()
