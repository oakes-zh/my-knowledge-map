"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { hierarchy, tree } from "d3-hierarchy";
import {
  moveArchiveNode,
  renameArchiveNode,
  createArchiveNode,
  deleteArchiveNode,
  deleteDocument,
} from "@/lib/api";

/**
 * ArchiveTree — renders the archive tree (the nested dictionary mapped to the
 * knowledge graph) and lets the user drag nodes to reorganize it.
 *
 * Concept: 归档路径 ≠ 文件关键字
 *  - 文件关键字 (keywords): flat, independent attributes of a document.
 *  - 归档路径 (archive path): the hierarchy induced by the LLM from the
 *    documents' common attributes — the levels of the nested dictionary.
 *
 * Dragging a node mutates the nested dictionary AND the affected documents'
 * archive_path on the backend (kept in sync by archive_store). This component
 * only triggers the move and reloads.
 */

interface ArchiveNodeData {
  id: string;
  name: string;
  kind: "root" | "category" | "document";
  doc_count?: number;
  pinned?: boolean;
  word_count?: number;
  pdf_type?: string;
  keywords?: string[];
  archive_path?: string[];
  children?: ArchiveNodeData[];
}

interface D3Node {
  data: ArchiveNodeData;
  x: number;
  y: number;
  children?: D3Node[];
  parent?: D3Node;
}

interface ArchiveTreeProps {
  treeData: ArchiveNodeData;
  onTreeChanged?: () => void;
}

const COLORS = {
  root: "#4F46E5",
  rootText: "#FFFFFF",
  category: "#0F766E",
  categoryLight: "#F0FDFA",
  document: "#3B82F6",
  documentLight: "#EFF6FF",
  edge: "#D1D5DB",
  dragSource: "#FCA5A5",
  dropTarget: "#F59E0B",
  keyword: "#7C3AED",
  keywordLight: "#F5F3FF",
};

// 层级由浅入深: categories get progressively lighter colors with depth, so the
// broad (shallow) levels read darkest and specific (deep) levels fade lighter.
const CATEGORY_DEPTH_COLORS = ["#0F766E", "#0D9488", "#0EA5A5", "#14B8A6", "#2DD4BF", "#5EEAD4"];
const LEVEL_LABELS = ["根", "领域", "主题", "分类", "具体", "更细"];

const NODE_HEIGHT = 24;
const NODE_PADDING_X = 9;
const NODE_PADDING_X_DOC = 7;
const LEVEL_GAP = 120; // vertical spacing between levels
const SIBLING_GAP = 37;
// 每深入一层，节点统一向右平移的缩进量（胶囊变宽后，为层级间连线预留宽度）
const LEVEL_INDENT = 36;
const FONT_SIZE = 8;
const FONT_SIZE_DOC = 7;
const MOVE_THRESHOLD = 6;

function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) w += fontSize;
    else w += fontSize * 0.6;
  }
  return w;
}

function getNodeWidth(name: string, isDoc: boolean, isRoot: boolean, keywordCount: number = 0): number {
  const fontSize = isDoc ? FONT_SIZE_DOC : isRoot ? FONT_SIZE + 1 : FONT_SIZE;
  const textW = estimateTextWidth(name, fontSize);
  const badgeW = keywordCount > 0 ? 18 : 0;
  if (isDoc) {
    return Math.max(textW + NODE_PADDING_X_DOC * 2 + 40 + badgeW, 60);
  }
  if (isRoot) {
    return Math.max(textW + NODE_PADDING_X * 2, 90);
  }
  // 文件夹胶囊：右侧需要容纳「文件数徽标 + 折叠开关」，原先右侧拥挤；
  // 按要求扩大到原来的两倍宽。
  const base = Math.max(textW + NODE_PADDING_X * 2, 60);
  return base * 2;
}

function MenuItem({ children, danger, onClick }: { children: React.ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "6px 10px",
        borderRadius: 6,
        cursor: "pointer",
        color: danger ? "#B91C1C" : "#334155",
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = danger ? "#FEF2F2" : "#F1F5F9"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      {children}
    </div>
  );
}

export default function ArchiveTree({ treeData, onTreeChanged }: ArchiveTreeProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ x: 60, y: 0, scale: 1 });
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Selected document detail: keywords (flat) vs archive path (hierarchy)
  const [selectedDoc, setSelectedDoc] = useState<ArchiveNodeData | null>(null);

  // Selected folder (category) detail: single-click shows directory status,
  // double-click toggles collapse.
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Custom right-click context menu (browser menu is suppressed)
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
    kind: string;
    name: string;
    pinned?: boolean;
  } | null>(null);
  const [menuDialog, setMenuDialog] = useState<{ mode: "rename" | "create"; nodeId: string } | null>(null);
  const [menuInput, setMenuInput] = useState("");
  const [menuBusy, setMenuBusy] = useState("");

  const [dragSource, setDragSource] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moveStatus, setMoveStatus] = useState<string>("");

  const dragRef = useRef({
    active: false,
    pending: false,
    sourceKey: "",
    sourceNodeId: "",
    sourceDocId: "",
    sourceKind: "",
    startX: 0,
    startY: 0,
    _cleanup: null as (() => void) | null,
    _cancelActivation: null as (() => void) | null,
  });

  // Unified Escape handling — closes popups in priority order BEFORE
  // exiting fullscreen: 输入弹窗 → 右键菜单 → 文件夹/文件详情面板 → 全屏。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menuDialog) {
        setMenuDialog(null);
        return;
      }
      if (contextMenu) {
        setContextMenu(null);
        return;
      }
      if (selectedCategoryId) {
        setSelectedCategoryId(null);
        return;
      }
      if (selectedDoc) {
        setSelectedDoc(null);
        return;
      }
      if (isFullscreen) setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuDialog, contextMenu, selectedCategoryId, selectedDoc, isFullscreen]);

  // Re-fit tree on fullscreen toggle
  useEffect(() => {
    if (!containerRef.current || !root || !isFullscreen) return;
    const timer = setTimeout(() => {
      if (!containerRef.current || !root) return;
      const rect = containerRef.current.getBoundingClientRect();
      let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
      root.each((node: any) => {
        const nw = getNodeWidth(node.data.name, node.data.kind === "document", !node.parent, node.data.keywords?.length || 0);
        const sh = node.depth * LEVEL_INDENT; // 层级右缩进
        // top-down: siblings on Y (horizontal), depth on X (vertical)
        minY = Math.min(minY, node.y + sh); maxY = Math.max(maxY, node.y + sh + nw);
        minX = Math.min(minX, node.x - NODE_HEIGHT / 2); maxX = Math.max(maxX, node.x + NODE_HEIGHT / 2);
      });
      const treeW = maxY - minY + 40, treeH = maxX - minX + NODE_HEIGHT + 20;
      const scale = Math.min((rect.width - 80) / treeW, (rect.height - 80) / treeH, 1);
      setTransform({ x: 60 - minY * scale, y: (rect.height - treeH * scale) / 2 - minX * scale + 20, scale });
    }, 100);
    return () => clearTimeout(timer);
  }, [isFullscreen]);

  // Build d3 hierarchy from the serialized nested dict
  const buildHierarchy = useCallback(() => {
    if (!treeData || !treeData.id) return null;
    const clone = (nodes: ArchiveNodeData[] | undefined): any[] | undefined =>
      nodes
        ? nodes.map(n => ({ ...n, children: n.children ? clone(n.children) : undefined }))
        : undefined;
    const rootData: any = { ...treeData, children: clone(treeData.children) };
    const root = hierarchy<any>(rootData);
    const treeLayout = tree<any>()
      .nodeSize([SIBLING_GAP, LEVEL_GAP])
      // @ts-ignore
      .separation((a: any, b: any) => (a.parent === b.parent ? 1 : 1.3));
    treeLayout(root);

    const applyCollapse = (node: any) => {
      if (node.children && node.children.length > 0) {
        if (collapsedNodes.has(node.data.id)) {
          node.children = undefined;
        } else {
          node.children.forEach(applyCollapse);
        }
      }
    };
    applyCollapse(root);
    return root;
  }, [treeData, collapsedNodes]);

  const root = buildHierarchy();

  // Auto-fit on data change
  useEffect(() => {
    if (!containerRef.current || !root) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0) return;
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    root.each((node: any) => {
      const nw = getNodeWidth(node.data.name, node.data.kind === "document", !node.parent, node.data.keywords?.length || 0);
      const sh = node.depth * LEVEL_INDENT; // 层级右缩进
      minY = Math.min(minY, node.y + sh);
      maxY = Math.max(maxY, node.y + sh + nw);
      minX = Math.min(minX, node.x - NODE_HEIGHT / 2);
      maxX = Math.max(maxX, node.x + NODE_HEIGHT / 2);
    });
    const treeW = maxY - minY + 40;
    const treeH = maxX - minX + NODE_HEIGHT + 20;
    const scaleX = (rect.width - 80) / treeW;
    const scaleY = (rect.height - 80) / treeH;
    const scale = Math.min(scaleX, scaleY, 1);
    setTransform({
      x: 60 - minY * scale,
      y: (rect.height - treeH * scale) / 2 - minX * scale + 20,
      scale,
    });
  }, [treeData]);

  // Prevent page scroll on wheel (zoom instead)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      setTransform(prev => {
        const newScale = Math.min(Math.max(prev.scale * zoomFactor, 0.1), 5);
        return {
          x: mouseX - (mouseX - prev.x) * (newScale / prev.scale),
          y: mouseY - (mouseY - prev.y) * (newScale / prev.scale),
          scale: newScale,
        };
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // ========== DRAG SYSTEM ==========

  const cleanupDrag = useCallback(() => {
    const d = dragRef.current;
    if (d._cleanup) {
      d._cleanup();
      d._cleanup = null;
    }
    if (d._cancelActivation) {
      d._cancelActivation();
      d._cancelActivation = null;
    }
    d.active = false;
    d.pending = false;
    setDragSource(null);
    setDropTarget(null);
  }, []);

  const isDescendantOf = useCallback((ancestorKey: string, maybeDescendantKey: string): boolean => {
    // Locate the source node, then search ONLY its own subtree. The old
    // implementation walked the whole tree, so ANY folder->folder drag was
    // wrongly rejected as "into its own descendant".
    let ancestor: any = null;
    root.each((n: any) => {
      if (n.data.id === ancestorKey) ancestor = n;
    });
    if (!ancestor) return false;
    const walk = (node: any): boolean => {
      for (const c of node.children || []) {
        if (c.data.id === maybeDescendantKey || walk(c)) return true;
      }
      return false;
    };
    return walk(ancestor);
  }, [root]);

  const isValidDrop = useCallback((targetData: ArchiveNodeData | null | undefined, sourceKey: string, sourceKind: string): boolean => {
    if (!targetData) return false;
    if (targetData.kind === "document") return false; // only categories/root accept drops
    if (targetData.id === sourceKey) return false; // not onto itself
    if (sourceKind === "category" && isDescendantOf(sourceKey, targetData.id)) return false; // no cycles
    return true;
  }, [isDescendantOf]);

  const startDrag = useCallback(() => {
    const d = dragRef.current;
    d.active = true;
    d.pending = false;
    setDragSource(d.sourceKey);

    const onMove = (e: MouseEvent) => {
      if (!d.active) return;
      const g = (e.target as Element).closest("[data-node-key]") as HTMLElement | null;
      if (!g) {
        setDropTarget(null);
        return;
      }
      const targetData: ArchiveNodeData | null = g.dataset.nodeKind
        ? {
            id: g.dataset.nodeKey || "",
            name: g.dataset.nodeName || "",
            kind: (g.dataset.nodeKind || "category") as any,
          }
        : null;
      if (isValidDrop(targetData, d.sourceKey, d.sourceKind)) {
        setDropTarget(targetData!.id);
      } else {
        setDropTarget(null);
      }
    };

    const onUp = async (e: MouseEvent) => {
      if (!d.active) return;
      const g = (e.target as Element).closest("[data-node-key]") as HTMLElement | null;
      const targetData: ArchiveNodeData | null = g?.dataset.nodeKind
        ? {
            id: g.dataset.nodeKey || "",
            name: g.dataset.nodeName || "",
            kind: (g.dataset.nodeKind || "category") as any,
          }
        : null;

      if (isValidDrop(targetData, d.sourceKey, d.sourceKind) && targetData) {
        setMoveStatus("正在移动...");
        try {
          const result = await moveArchiveNode(
            d.sourceKind === "category" ? d.sourceNodeId : "",
            d.sourceKind === "document" ? d.sourceDocId : "",
            targetData.id,
          );
          setMoveStatus(
            `已将 ${result.moved_count} 个文档移到「${targetData.name}」：嵌套字典结构与归档路径已同步更新`,
          );
          if (onTreeChanged) onTreeChanged();
        } catch (err: any) {
          setMoveStatus(`移动失败: ${err.message}`);
        }
        setTimeout(() => setMoveStatus(""), 4000);
      }

      d.active = false;
      setDragSource(null);
      setDropTarget(null);
      if (d._cleanup) {
        d._cleanup();
        d._cleanup = null;
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    d._cleanup = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [isValidDrop, onTreeChanged]);

  useEffect(() => {
    return () => cleanupDrag();
  }, [cleanupDrag]);

  const handleNodeMouseDown = useCallback((e: React.MouseEvent, node: any) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setContextMenu(null);
    setMenuDialog(null);
    const isRoot = !node.parent;
    if (isRoot) return;

    const d = dragRef.current;
    if (d._cancelActivation) {
      d._cancelActivation();
      d._cancelActivation = null;
    }
    d.sourceKey = node.data.id;
    d.sourceNodeId = node.data.kind === "category" ? node.data.id : "";
    d.sourceDocId = node.data.kind === "document" ? node.data.id : "";
    d.sourceKind = node.data.kind;
    d.startX = e.clientX;
    d.startY = e.clientY;
    d.pending = true;
    d.active = false;

    // Movement-based activation: drag starts as soon as the pointer moves
    // past the threshold (no long-press needed). A plain click (no movement)
    // still toggles collapse / selects a document.
    const onMove = (ev: MouseEvent) => {
      const dd = dragRef.current;
      if (dd.active || !dd.pending) return;
      const dx = ev.clientX - dd.startX;
      const dy = ev.clientY - dd.startY;
      if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        dd._cancelActivation = null;
        startDrag();
      }
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      dragRef.current._cancelActivation = null;
      dragRef.current.pending = false;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    d._cancelActivation = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [startDrag]);

  const handleNodeMouseEnter = useCallback((node: any) => {
    if (!dragRef.current.active) setHoveredNode(node.data.id);
  }, []);

  const handleNodeMouseLeave = useCallback(() => {
    if (!dragRef.current.active) setHoveredNode(null);
  }, []);

  // ========== CONTAINER PAN ==========
  const [panning, setPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });

  const handleContainerMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (dragRef.current.active) return;
    setContextMenu(null);
    setMenuDialog(null);
    setPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y };
  }, [transform]);

  const handleContainerMouseMove = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current;
    if (d.pending || d.active) return; // node drag in progress — pan disabled
    if (!panning) return;
    setTransform(prev => ({
      ...prev,
      x: panStart.current.tx + (e.clientX - panStart.current.x),
      y: panStart.current.ty + (e.clientY - panStart.current.y),
    }));
  }, [panning]);

  const handleContainerMouseUp = useCallback(() => {
    const d = dragRef.current;
    if (d._cancelActivation) {
      d._cancelActivation();
      d._cancelActivation = null;
    }
    d.pending = false;
    setPanning(false);
  }, []);

  const toggleCollapse = useCallback((node: any) => {
    if (node.data.kind === "document") return;
    setCollapsedNodes(prev => {
      const next = new Set(prev);
      if (next.has(node.data.id)) next.delete(node.data.id);
      else next.add(node.data.id);
      return next;
    });
  }, []);

  // Single click on a folder → show directory status panel. Deferred briefly
  // so a double-click (collapse/expand) can cancel it.
  const handleCategoryClick = useCallback((node: any) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      setSelectedDoc(null);
      setSelectedCategoryId(node.data.id);
    }, 240);
  }, []);

  // Double click on a folder → collapse / expand.
  const handleCategoryDoubleClick = useCallback((node: any) => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    toggleCollapse(node);
  }, [toggleCollapse]);

  // ========== CUSTOM RIGHT-CLICK CONTEXT MENU ==========

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setMenuDialog(null);
    setMenuBusy("");
  }, []);

  // Suppress the browser menu and show our own, positioned at the cursor.
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (dragRef.current.active) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width - 190));
    const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height - 250));
    const g = (e.target as Element).closest("[data-node-key]") as HTMLElement | null;
    if (!g) {
      // Right-click on empty canvas → create a top-level category
      setContextMenu({ x, y, nodeId: "root", kind: "root", name: "知识库" });
    } else {
      setContextMenu({
        x,
        y,
        nodeId: g.dataset.nodeKey || "",
        kind: g.dataset.nodeKind || "",
        name: g.dataset.nodeName || "",
        pinned: g.dataset.nodePinned === "1",
      });
    }
    setMenuDialog(null);
    setMenuInput("");
    setMenuBusy("");
  }, []);

  const submitMenuAction = useCallback(async (name: string) => {
    if (!menuDialog || !contextMenu) return;
    const mode = menuDialog.mode;
    setMenuBusy(mode === "rename" ? "重命名中..." : "创建中...");
    try {
      if (mode === "rename") {
        await renameArchiveNode(menuDialog.nodeId, name);
      } else {
        await createArchiveNode(menuDialog.nodeId, name);
      }
      closeContextMenu();
      if (onTreeChanged) onTreeChanged();
    } catch (err: any) {
      setMenuBusy(`操作失败: ${err.message}`);
    }
  }, [menuDialog, contextMenu, closeContextMenu, onTreeChanged]);

  const handleMenuMoveToRoot = useCallback(async () => {
    if (!contextMenu) return;
    setMenuBusy("移动中...");
    try {
      await moveArchiveNode(contextMenu.nodeId, "", "root");
      closeContextMenu();
      if (onTreeChanged) onTreeChanged();
    } catch (err: any) {
      setMenuBusy(`移动失败: ${err.message}`);
    }
  }, [contextMenu, closeContextMenu, onTreeChanged]);

  const handleMenuToggleCollapse = useCallback(() => {
    if (!contextMenu) return;
    const id = contextMenu.nodeId;
    setCollapsedNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    closeContextMenu();
  }, [contextMenu, closeContextMenu]);

  const handleMenuDeleteNode = useCallback(async () => {
    if (!contextMenu) return;
    if (!confirm(`确认删除目录「${contextMenu.name}」？（目录必须为空，请先移走其中的文档）`)) return;
    setMenuBusy("删除中...");
    try {
      await deleteArchiveNode(contextMenu.nodeId);
      setSelectedCategoryId(null);
      closeContextMenu();
      if (onTreeChanged) onTreeChanged();
    } catch (err: any) {
      setMenuBusy(`删除失败: ${err.message}`);
    }
  }, [contextMenu, closeContextMenu, onTreeChanged]);

  const handleMenuDeleteDoc = useCallback(async () => {
    if (!contextMenu) return;
    if (!confirm(`确认删除文档「${contextMenu.name}」？`)) return;
    setMenuBusy("删除中...");
    try {
      await deleteDocument(contextMenu.nodeId);
      setSelectedDoc(null);
      closeContextMenu();
      if (onTreeChanged) onTreeChanged();
    } catch (err: any) {
      setMenuBusy(`删除失败: ${err.message}`);
    }
  }, [contextMenu, closeContextMenu, onTreeChanged]);

  // Clear any pending single-click timer on unmount
  useEffect(() => {
    return () => {
      if (clickTimer.current) {
        clearTimeout(clickTimer.current);
        clickTimer.current = null;
      }
    };
  }, []);

  if (!root) return null;

  // --- Edges ---
  const edges: { sx: number; sy: number; tx: number; ty: number; key: string }[] = [];
  root.links().forEach((link: any) => {
    const s = link.source as any;
    const t = link.target as any;
    const sw = getNodeWidth(s.data.name, s.data.kind === "document", !s.parent, s.data.keywords?.length || 0);
    // top-down: parent right edge → child; 层级右缩进保证连线长度不被压缩
    edges.push({
      sx: s.y + s.depth * LEVEL_INDENT + sw,
      sy: s.x,
      tx: t.y + t.depth * LEVEL_INDENT,
      ty: t.x,
      key: `${s.data.id}-${t.data.id}`,
    });
  });

  const nodes: any[] = [];
  root.each((node: any) => nodes.push(node));

  // Horizontal extent of the whole tree (incl. 层级右缩进), for the depth
  // guides that visualize 层级由浅入深.
  let extentMinY = Infinity, extentMaxY = -Infinity;
  root.each((n: any) => {
    const nw = getNodeWidth(n.data.name, n.data.kind === "document", !n.parent, n.data.keywords?.length || 0);
    extentMinY = Math.min(extentMinY, n.y + n.depth * LEVEL_INDENT);
    extentMaxY = Math.max(extentMaxY, n.y + n.depth * LEVEL_INDENT + nw);
  });
  const maxDepth = root.height || 0;

  const dragSubtreeKeys = useRef<Set<string>>(new Set());
  if (dragSource) {
    dragSubtreeKeys.current.clear();
    root.each((n: any) => {
      if (n.data.id === dragSource) {
        const collect = (node: any) => {
          dragSubtreeKeys.current.add(node.data.id);
          if (node.children) node.children.forEach(collect);
        };
        collect(n);
      }
    });
  }

  const docCountForNode = (node: any): number => {
    let c = 0;
    const walk = (n: any) => {
      if (n.data.kind === "document") c += 1;
      if (n.children) n.children.forEach(walk);
    };
    walk(node);
    return c;
  };

  return (
    <div
      ref={containerRef}
      style={{
        width: isFullscreen ? "100vw" : "100%",
        height: isFullscreen ? "100vh" : "520px",
        position: isFullscreen ? "fixed" : "relative",
        top: isFullscreen ? 0 : undefined,
        left: isFullscreen ? 0 : undefined,
        zIndex: isFullscreen ? 9999 : undefined,
        overflow: "hidden",
        cursor: dragSource ? "move" : panning ? "grabbing" : "grab",
        borderRadius: isFullscreen ? 0 : "8px",
        background: "#FAFBFC",
        userSelect: "none", WebkitUserSelect: "none",
        MozUserSelect: "none", msUserSelect: "none",
      }}
      onMouseDown={handleContainerMouseDown}
      onMouseMove={handleContainerMouseMove}
      onMouseUp={handleContainerMouseUp}
      onMouseLeave={handleContainerMouseUp}
      onContextMenu={handleContextMenu}
      onClick={() => {
        // Click on empty canvas closes the detail panels (node clicks stopPropagation)
        setSelectedDoc(null);
        setSelectedCategoryId(null);
      }}
    >
      <svg ref={svgRef} width="100%" height="100%" style={{ display: "block", userSelect: "none" }}>
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="2" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="dropGlow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
          {/* Depth guides: 层级由浅入深 — root at top, levels go down */}
          {Array.from({ length: maxDepth + 1 }, (_, d) => {
            const gy = d * LEVEL_GAP;
            const label = LEVEL_LABELS[d] || `L${d + 1}`;
            return (
              <g key={`lvl-${d}`} style={{ pointerEvents: "none" }}>
                <line
                  x1={extentMinY - 26} x2={extentMaxY + 26} y1={gy} y2={gy}
                  stroke={d === 0 ? "#C7D2FE" : "#E2E8F0"}
                  strokeWidth={1}
                  strokeDasharray={d === 0 ? "none" : "3 4"}
                />
                <text
                  x={extentMinY - 30} y={gy} dy="0.35em" textAnchor="end"
                  style={{
                    fontSize: d === 0 ? "9px" : "8px",
                    fill: d === 0 ? "#6366F1" : "#94A3B8",
                    fontWeight: d === 0 ? 700 : 500,
                    userSelect: "none",
                  }}
                >
                  {label}
                </text>
              </g>
            );
          })}

          {edges.map(edge => {
            const midX = (edge.sx + edge.tx) / 2;
            const isDragEdge = dragSource && edge.key.includes(dragSource);
            return (
              <path
                key={edge.key}
                d={`M ${edge.sx} ${edge.sy} C ${midX} ${edge.sy}, ${midX} ${edge.ty}, ${edge.tx} ${edge.ty}`}
                fill="none"
                stroke={isDragEdge ? COLORS.dragSource : COLORS.edge}
                strokeWidth={isDragEdge ? 2 : 1.5}
                opacity={isDragEdge ? 0.7 : 0.55}
              />
            );
          })}

          {nodes.map(node => {
            const isRoot = !node.parent;
            const isDoc = node.data.kind === "document";
            const isCat = node.data.kind === "category";
            const nodeKey = node.data.id;
            const hasChildren = !!node.children && node.children.length > 0;
            const isCollapsible = !isDoc && (hasChildren || collapsedNodes.has(nodeKey));
            const isHovered = hoveredNode === nodeKey;
            const isDragSrc = dragSource === nodeKey;
            const isInDragSubtree = dragSource && dragSubtreeKeys.current.has(nodeKey);
            const isDropTarget = dropTarget === nodeKey;

            let bgColor: string, borderColor: string, textColor: string;
            if (isRoot) {
              bgColor = COLORS.root; borderColor = COLORS.root; textColor = COLORS.rootText;
            } else if (isCat) {
              // 层级由浅入深: 上层(浅层)深色, 下层(深层)渐浅
              const depthColor = CATEGORY_DEPTH_COLORS[Math.min(node.depth - 1, CATEGORY_DEPTH_COLORS.length - 1)];
              bgColor = COLORS.categoryLight; borderColor = depthColor; textColor = depthColor;
            } else {
              bgColor = COLORS.documentLight; borderColor = COLORS.document; textColor = "#1E40AF";
            }
            if (isDragSrc || isInDragSubtree) {
              borderColor = COLORS.dragSource;
              bgColor = "#FEF2F2";
            }
            if (isDropTarget) {
              borderColor = COLORS.dropTarget;
              bgColor = "#FFFBEB";
            }

            const fontSize = isDoc ? FONT_SIZE_DOC : isRoot ? FONT_SIZE + 1 : FONT_SIZE;
            const nw = getNodeWidth(node.data.name, isDoc, isRoot, node.data.keywords?.length || 0);
            const nh = NODE_HEIGHT;
            // top-down: cx = sibling position (horizontal), cy = depth (vertical).
            // 层级右缩进：每深入一层，节点统一向右平移 LEVEL_INDENT。
            const levelShift = node.depth * LEVEL_INDENT;
            const cx = node.y + levelShift;
            const cy = node.x - nh / 2;
            const docCount = isCat ? (node.data.doc_count ?? docCountForNode(node)) : 0;
            // 文件夹胶囊：只在右侧加宽（base 为原宽，整宽 = base*2）。
            // 名称保持在左侧 base 区域居中（cx + nw/4 = cx + base/2），
            // 右侧扩展区留给「文件数 + 折叠开关」，左缘位置不变。
            const labelX = isCat ? cx + nw / 4 : cx + nw / 2;

            return (
              <g
                key={nodeKey}
                data-node-key={nodeKey}
                data-node-kind={isRoot ? "root" : isDoc ? "document" : "category"}
                data-node-name={node.data.name}
                data-node-pinned={isCat && node.data.pinned ? "1" : "0"}
                onClick={(e) => {
                  e.stopPropagation();
                  if (dragRef.current.active) return;
                  if (isDoc) {
                    // Single click on a document → keyword/path detail panel
                    if (clickTimer.current) {
                      clearTimeout(clickTimer.current);
                      clickTimer.current = null;
                    }
                    setSelectedDoc(node.data);
                    setSelectedCategoryId(null);
                    return;
                  }
                  if (isRoot) return;
                  // Single click on a folder → directory status panel
                  handleCategoryClick(node);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (dragRef.current.active) return;
                  if (!isDoc && !isRoot) handleCategoryDoubleClick(node);
                }}
                onMouseEnter={() => handleNodeMouseEnter(node)}
                onMouseLeave={handleNodeMouseLeave}
                onMouseDown={(e) => handleNodeMouseDown(e, node)}
                style={{
                  cursor: dragSource
                    ? (isDoc ? "not-allowed" : (isDropTarget ? "copy" : "move"))
                    : isCollapsible ? "pointer" : "default",
                  opacity: isDragSrc || isInDragSubtree ? 0.6 : 1,
                }}
              >
                <rect
                  x={cx} y={cy} width={nw} height={nh}
                  rx={nh / 2} ry={nh / 2}
                  fill={bgColor} stroke={borderColor}
                  strokeWidth={isDropTarget ? 3 : isHovered ? 2.5 : 1.5}
                  filter={isDropTarget ? "url(#dropGlow)" : isHovered ? "url(#glow)" : undefined}
                  style={{ transition: "stroke-width 0.15s, filter 0.15s" }}
                />

                {isDoc ? (
                  <g style={{ pointerEvents: "none" }}>
                    <text x={cx + NODE_PADDING_X_DOC + 2} y={cy + nh / 2} dy="0.35em"
                      style={{ fontSize: `${fontSize}px`, fill: textColor, fontWeight: 600, userSelect: "none" }}>
                      {node.data.pdf_type === "image" ? "📷" : node.data.pdf_type === "text" ? "📝" : "📄"}
                    </text>
                    <text x={cx + NODE_PADDING_X_DOC + 20} y={cy + nh / 2} dy="0.35em"
                      style={{ fontSize: `${fontSize}px`, fill: textColor, fontWeight: 500, userSelect: "none" }}>
                      {node.data.name.length > 11 ? node.data.name.slice(0, 11) + "…" : node.data.name}
                    </text>
                    {(node.data.keywords || []).length > 0 && (
                      <text x={cx + nw - NODE_PADDING_X_DOC} y={cy + nh / 2} dy="0.35em" textAnchor="end"
                        style={{ fontSize: "8px", fill: COLORS.keyword, fontWeight: 700, userSelect: "none" }}>
                        🏷{(node.data.keywords || []).length}
                      </text>
                    )}
                  </g>
                ) : (
                  <g style={{ pointerEvents: "none" }}>
                    <text x={labelX} y={cy + nh / 2} dy="0.35em" textAnchor="middle"
                      style={{ fontSize: `${fontSize}px`, fill: textColor, fontWeight: isRoot ? 700 : 600, userSelect: "none" }}>
                      {isRoot ? "📚 " : "📁 "}{node.data.name}
                    </text>
                    {isCat && docCount > 0 && (
                      <text x={cx + nw - 20} y={cy + nh / 2} dy="0.35em" textAnchor="end"
                        style={{ fontSize: "8px", fill: "#9CA3AF", fontWeight: 600, userSelect: "none" }}>
                        {docCount}
                      </text>
                    )}
                  </g>
                )}

                {isCollapsible && (
                  <g style={{ pointerEvents: "none" }}>
                    <circle cx={cx + nw - 4} cy={cy + nh / 2} r={8} fill="white" stroke={borderColor} strokeWidth={1.5} />
                    <text x={cx + nw - 4} y={cy + nh / 2} textAnchor="middle" dy="0.35em"
                      style={{ fontSize: "10px", fill: borderColor, fontWeight: 700, userSelect: "none" }}>
                      {collapsedNodes.has(nodeKey) ? "+" : "−"}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Concept banner */}
      <div style={{
        position: "absolute", top: "12px", left: "12px", right: "12px",
        display: "flex", gap: "16px", fontSize: "11px", flexWrap: "wrap",
        color: "var(--text-secondary)", background: "rgba(255,255,255,0.94)",
        padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--border)",
        userSelect: "none",
      }}>
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ display: "inline-block", width: 28, height: 10, borderRadius: 5, background: COLORS.category }} />归档分类
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ display: "inline-block", width: 28, height: 10, borderRadius: 5, background: COLORS.document }} />文档
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: COLORS.keywordLight, border: `1px solid ${COLORS.keyword}` }} />文件关键字（🏷n）
        </span>
        <span>单击分类看目录信息 · 双击折叠/展开 · 拖拽移动 · 右键操作菜单</span>
      </div>

      {/* Selected document detail: keywords vs archive path */}
      {selectedDoc && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
          position: "absolute", right: "12px", top: "52px", width: "280px",
          background: "rgba(255,255,255,0.97)", borderRadius: "8px",
          border: "1px solid var(--border)", boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
          padding: "12px 14px", fontSize: "12px", userSelect: "none", zIndex: 5,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <span style={{ fontWeight: 600, fontSize: "13px", color: "#1E40AF" }}>
              {selectedDoc.name}
            </span>
            <button onClick={() => setSelectedDoc(null)}
              style={{ border: "none", background: "transparent", cursor: "pointer", color: "#9CA3AF", fontSize: "14px" }}>
              ✕
            </button>
          </div>

          <div style={{ marginBottom: "8px" }}>
            <div style={{ fontSize: "10px", color: "#9CA3AF", fontWeight: 600, marginBottom: "4px" }}>
              归档目录（层级由浅入深 · LLM 重新语义归纳）
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" }}>
              {(selectedDoc.archive_path && selectedDoc.archive_path.length > 0
                ? selectedDoc.archive_path
                : ["未分类"]
              ).map((level, i, arr) => (
                <span key={i} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <span style={{
                    fontSize: "11px", padding: "2px 8px", borderRadius: "4px",
                    background: COLORS.categoryLight, color: COLORS.category,
                    border: `1px solid ${COLORS.category}33`, lineHeight: "18px",
                  }}>
                    📁 {level}
                  </span>
                  {i < arr.length - 1 && <span style={{ color: "#9CA3AF" }}>→</span>}
                </span>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize: "10px", color: "#9CA3AF", fontWeight: 600, marginBottom: "4px" }}>
              文件关键字（扁平、独立属性）
            </div>
            {(selectedDoc.keywords && selectedDoc.keywords.length > 0) ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                {selectedDoc.keywords.map((k, i) => (
                  <span key={i} style={{
                    fontSize: "11px", padding: "2px 8px", borderRadius: "4px",
                    background: COLORS.keywordLight, color: COLORS.keyword,
                    border: `1px solid ${COLORS.keyword}33`, lineHeight: "18px",
                  }}>
                    🏷 {k}
                  </span>
                ))}
              </div>
            ) : (
              <span style={{ color: "#9CA3AF", fontSize: "11px" }}>（暂无关键字）</span>
            )}
          </div>

          {selectedDoc.word_count !== undefined && (
            <div style={{ marginTop: "8px", fontSize: "11px", color: "#9CA3AF" }}>
              {selectedDoc.word_count} 字
              {selectedDoc.pdf_type === "text" ? " · 文字PDF" : selectedDoc.pdf_type === "image" ? " · 扫描PDF" : ""}
            </div>
          )}
        </div>
      )}

      {/* Selected folder (category): directory status — what's inside */}
      {selectedCategoryId && (() => {
        let catNode: any = null;
        root.each((n: any) => {
          if (n.data.id === selectedCategoryId) catNode = n;
        });
        if (!catNode || catNode.data.kind !== "category") return null;
        const data = catNode.data as ArchiveNodeData;
        const subs = (data.children || []).filter(c => c.kind === "category");
        const docs = (data.children || []).filter(c => c.kind === "document");
        const crumbs: string[] = [];
        let p = catNode.parent;
        while (p && p.data.kind !== "root") {
          crumbs.unshift(p.data.name);
          p = p.parent;
        }
        const depthLabel = LEVEL_LABELS[catNode.depth] || `L${catNode.depth + 1}`;
        const totalDocs = data.doc_count ?? docs.length;
        return (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
            position: "absolute", right: "12px", top: "52px", width: "300px", maxHeight: "380px", overflowY: "auto",
            background: "rgba(255,255,255,0.97)", borderRadius: "8px",
            border: "1px solid var(--border)", boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            padding: "12px 14px", fontSize: "12px", userSelect: "none", zIndex: 5,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
              <span style={{ fontWeight: 600, fontSize: "13px", color: COLORS.category, display: "flex", alignItems: "center", gap: "6px" }}>
                📁 {data.name}
                <span style={{
                  fontSize: "10px", padding: "1px 6px", borderRadius: "3px",
                  background: COLORS.categoryLight, color: COLORS.category, border: `1px solid ${COLORS.category}33`,
                }}>
                  {depthLabel}
                </span>
              </span>
              <button onClick={() => setSelectedCategoryId(null)}
                style={{ border: "none", background: "transparent", cursor: "pointer", color: "#9CA3AF", fontSize: "14px" }}>
                ✕
              </button>
            </div>

            {crumbs.length > 0 && (
              <div style={{ marginBottom: "8px", fontSize: "11px", color: "#9CA3AF", display: "flex", flexWrap: "wrap", gap: "2px", alignItems: "center" }}>
                {crumbs.map((n, i) => (
                  <span key={i} style={{ display: "flex", alignItems: "center", gap: "2px" }}>
                    {n}
                    <span style={{ margin: "0 2px" }}>→</span>
                  </span>
                ))}
                <span style={{ color: COLORS.category, fontWeight: 600 }}>{data.name}</span>
              </div>
            )}

            <div style={{
              display: "flex", gap: "12px", marginBottom: "8px", fontSize: "11px",
              background: "#F8FAFC", borderRadius: "6px", padding: "6px 10px",
            }}>
              <span><b style={{ fontSize: "14px", color: COLORS.category }}>{totalDocs}</b> 个文件</span>
              <span><b style={{ fontSize: "14px", color: COLORS.category }}>{subs.length}</b> 个子目录</span>
              <span><b style={{ fontSize: "14px", color: COLORS.category }}>{docs.length}</b> 直属文件</span>
            </div>

            {subs.length > 0 && (
              <div style={{ marginBottom: "8px" }}>
                <div style={{ fontSize: "10px", color: "#9CA3AF", fontWeight: 600, marginBottom: "4px" }}>包含的子目录</div>
                {subs.map(s => (
                  <div key={s.id} onClick={(e) => { e.stopPropagation(); setSelectedCategoryId(s.id); }}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "4px 8px", borderRadius: "4px", cursor: "pointer",
                      background: "#FFFFFF", border: "1px solid #F1F5F9", marginBottom: "2px",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = COLORS.categoryLight; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "#FFFFFF"; }}
                  >
                    <span style={{ color: COLORS.category, fontWeight: 500 }}>📁 {s.name}</span>
                    <span style={{ fontSize: "11px", color: "#94A3B8" }}>{s.doc_count ?? 0} 个文件 ›</span>
                  </div>
                ))}
              </div>
            )}

            {docs.length > 0 && (
              <div style={{ marginBottom: "4px" }}>
                <div style={{ fontSize: "10px", color: "#9CA3AF", fontWeight: 600, marginBottom: "4px" }}>本目录文件</div>
                {docs.map(d => (
                  <div key={d.id} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "4px 8px", borderRadius: "4px", marginBottom: "2px",
                    background: "#FFFFFF", border: "1px solid #F1F5F9",
                  }}>
                    <span style={{ color: "#1E40AF", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "190px" }}>
                      {d.pdf_type === "image" ? "📷" : d.pdf_type === "text" ? "📝" : "📄"} {d.name}
                    </span>
                    {d.keywords && d.keywords.length > 0 && (
                      <span style={{ fontSize: "10px", color: COLORS.keyword, fontWeight: 600 }}>🏷{d.keywords.length}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {subs.length === 0 && docs.length === 0 && (
              <div style={{ color: "#9CA3AF", fontSize: "11px", padding: "4px 0" }}>（空目录）</div>
            )}

            <div style={{ marginTop: "8px", fontSize: "10px", color: "#CBD5E1", textAlign: "center" }}>
              双击折叠 / 展开 · 单击子目录下钻
            </div>
          </div>
        );
      })()}

      {/* Move status toast */}
      {moveStatus && (
        <div style={{
          position: "absolute", top: "12px", left: "50%", transform: "translateX(-50%)",
          background: moveStatus.includes("失败") ? "#FEF2F2" : "#F0FDF4",
          color: moveStatus.includes("失败") ? "#991B1B" : "#166534",
          border: `1px solid ${moveStatus.includes("失败") ? "#FCA5A5" : "#BBF7D0"}`,
          borderRadius: "6px", padding: "8px 16px", fontSize: "13px",
          fontWeight: 500, boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
          zIndex: 10, userSelect: "none",
        }}>
          {moveStatus}
        </div>
      )}

      {dragSource && !moveStatus && (
        <div style={{
          position: "absolute", top: "12px", left: "50%", transform: "translateX(-50%)",
          background: "#EFF6FF", color: "#1E40AF", border: "1px solid #BFDBFE",
          borderRadius: "6px", padding: "8px 16px", fontSize: "13px",
          fontWeight: 500, boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
          zIndex: 10, userSelect: "none",
        }}>
          拖拽到目标分类后松开（会同步更新嵌套字典与文档归档路径）
        </div>
      )}

      {/* Controls */}
      <div style={{ position: "absolute", bottom: "12px", right: "12px", display: "flex", flexDirection: "column", gap: "4px" }}>
        {[
          { label: "⛶", title: isFullscreen ? "退出全屏" : "全屏", action: () => setIsFullscreen(f => !f) },
          { label: "+", title: "放大", action: () => setTransform(p => ({ ...p, scale: Math.min(p.scale * 1.3, 5) })) },
          { label: "−", title: "缩小", action: () => setTransform(p => ({ ...p, scale: Math.max(p.scale / 1.3, 0.1) })) },
          { label: "⊞", title: "重置视图", action: () => {
            if (!containerRef.current || !root) return;
            const rect = containerRef.current.getBoundingClientRect();
            let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
            root.each((node: any) => {
              const nw = getNodeWidth(node.data.name, node.data.kind === "document", !node.parent, node.data.keywords?.length || 0);
              const sh = node.depth * LEVEL_INDENT;
              minY = Math.min(minY, node.y + sh); maxY = Math.max(maxY, node.y + sh + nw);
              minX = Math.min(minX, node.x - NODE_HEIGHT / 2); maxX = Math.max(maxX, node.x + NODE_HEIGHT / 2);
            });
            const treeW = maxY - minY + 40, treeH = maxX - minX + NODE_HEIGHT + 20;
            const scale = Math.min((rect.width - 80) / treeW, (rect.height - 80) / treeH, 1);
            setTransform({ x: 60 - minY * scale, y: (rect.height - treeH * scale) / 2 - minX * scale + 20, scale });
          }},
        ].map((btn, i) => (
          <button key={i} onClick={(e) => { e.stopPropagation(); btn.action(); }}
            style={{
              width: "32px", height: "32px", borderRadius: "6px",
              border: "1px solid var(--border)", background: "white",
              cursor: "pointer", fontSize: "16px",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
            }}
          >{btn.label}</button>
        ))}
      </div>

      {/* Custom right-click context menu (browser menu suppressed) */}
      {contextMenu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
          style={{
            position: "absolute", left: contextMenu.x, top: contextMenu.y, zIndex: 30,
            minWidth: 180, background: "white", borderRadius: "8px",
            border: "1px solid var(--border)", boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
            padding: "4px", fontSize: "12px", userSelect: "none",
          }}
        >
          <div style={{
            padding: "5px 10px", color: "#64748B", fontSize: "11px",
            borderBottom: "1px solid #F1F5F9", marginBottom: "4px",
            display: "flex", alignItems: "center", gap: "6px", maxWidth: 200,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            <span>{contextMenu.kind === "document" ? "📄" : contextMenu.kind === "root" ? "📚" : "📁"}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{contextMenu.name}</span>
            {contextMenu.pinned && <span title="手动创建的目录（不会被自动清理）">📌</span>}
          </div>

          {contextMenu.kind === "category" && (
            <>
              <MenuItem onClick={() => { setMenuDialog({ mode: "rename", nodeId: contextMenu.nodeId }); setMenuInput(contextMenu.name); }}>
                ✏️ 重命名
              </MenuItem>
              <MenuItem onClick={() => { setMenuDialog({ mode: "create", nodeId: contextMenu.nodeId }); setMenuInput(""); }}>
                📁+ 新建子目录
              </MenuItem>
              <MenuItem onClick={handleMenuMoveToRoot}>⬆️ 移动到根目录</MenuItem>
              <MenuItem onClick={handleMenuToggleCollapse}>⇅ 折叠 / 展开</MenuItem>
              <MenuItem danger onClick={handleMenuDeleteNode}>🗑 删除目录</MenuItem>
            </>
          )}
          {contextMenu.kind === "document" && (
            <MenuItem danger onClick={handleMenuDeleteDoc}>🗑 删除文档</MenuItem>
          )}
          {contextMenu.kind === "root" && (
            <MenuItem onClick={() => { setMenuDialog({ mode: "create", nodeId: "root" }); setMenuInput(""); }}>
              📁+ 新建根目录分类
            </MenuItem>
          )}

          {menuBusy && (
            <div style={{
              padding: "4px 10px", fontSize: "11px",
              color: menuBusy.includes("失败") ? "#991B1B" : "#0F766E",
            }}>
              {menuBusy}
            </div>
          )}
        </div>
      )}

      {/* Rename / create dialog */}
      {menuDialog && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
          style={{
            position: "absolute",
            left: (contextMenu ? contextMenu.x : 12),
            top: (contextMenu ? contextMenu.y : 12) + 44,
            zIndex: 31, width: 210, background: "white", borderRadius: "8px",
            border: "1px solid var(--border)", boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
            padding: "10px", fontSize: "12px", userSelect: "none",
          }}
        >
          <div style={{ fontSize: "11px", color: "#64748B", marginBottom: "6px" }}>
            {menuDialog.mode === "rename" ? "✏️ 重命名目录" : "📁+ 新建子目录"}
          </div>
          <input
            autoFocus
            value={menuInput}
            onChange={(e) => setMenuInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.stopPropagation(); submitMenuAction(menuInput.trim()); }
              if (e.key === "Escape") { e.stopPropagation(); setMenuDialog(null); }
            }}
            placeholder={menuDialog.mode === "rename" ? "新目录名" : "目录名"}
            maxLength={30}
            style={{
              width: "100%", boxSizing: "border-box", padding: "4px 8px",
              borderRadius: "4px", border: "1px solid #CBD5E1", outline: "none", fontSize: "12px",
            }}
          />
          <div style={{ display: "flex", gap: "6px", marginTop: "8px", justifyContent: "flex-end" }}>
            <button
              onClick={() => setMenuDialog(null)}
              style={{ fontSize: "11px", padding: "3px 10px", borderRadius: "4px", border: "1px solid var(--border)", background: "white", cursor: "pointer" }}
            >
              取消
            </button>
            <button
              onClick={() => submitMenuAction(menuInput.trim())}
              disabled={!menuInput.trim()}
              style={{
                fontSize: "11px", padding: "3px 10px", borderRadius: "4px", border: "none",
                background: menuInput.trim() ? "#0F766E" : "#CBD5E1", color: "white", cursor: menuInput.trim() ? "pointer" : "not-allowed",
              }}
            >
              确定
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
