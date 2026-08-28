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

// Dify palette (packages/dify-ui light theme)
const COLORS = {
  root: "#155aef",          // Dify primary-600
  rootText: "#FFFFFF",
  category: "#2970ff",      // Dify primary-500 (base for legends/panels)
  categoryLight: "#eef4ff", // Dify indigo-50
  document: "#98a2b3",      // Dify gray-400 — docs are neutral, structure is colored
  documentLight: "#f9fafb", // Dify gray-50
  edge: "#d0d5dd",          // Dify gray-300
  dragSource: "#f04438",    // Dify error
  dropTarget: "#f79009",    // Dify warning
  keyword: "#7c3aed",       // Dify purple
  keywordLight: "#f6f5ff",  // Dify purple-50
};

// 层级由浅入深: categories get progressively lighter colors with depth, so the
// broad (shallow) levels read darkest and specific (deep) levels fade lighter.
// Ramp follows Dify's accent family: blue → sky → indigo → violet.
const CATEGORY_DEPTH_COLORS = ["#2970ff", "#0ba5ec", "#444ce7", "#7c3aed", "#6938ef", "#8098f9"];
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

// ===== 图标体系：Remix Icon 4.x 官方路径（Dify 同款图标集），24x24 viewBox，单色 =====
// 全部图标统一取自同一图标集，保证风格一致（线条粗细/圆角/留白完全统一）。
// 来源: remixicon.com (Apache-2.0)，经 https://api.iconify.design/ri 取回原始 path。
const ICONS = {
  // 目录 / 知识库位置
  folder: "M12.414 5H21a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h7.414zM4 7v12h16V7z",
  folderAdd: "M12.414 5H21a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h7.414zM4 5v14h16V7h-8.414l-2-2zm7 7V9h2v3h3v2h-3v3h-2v-3H8v-2z",
  // 文档（默认 / 文字型 / 扫描型）
  file: "M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z",
  fileText: "M21 8v12.993A1 1 0 0 1 20.007 22H3.993A.993.993 0 0 1 3 21.008V2.992C3 2.455 3.449 2 4.002 2h10.995zm-2 1h-5V4H5v16h14zM8 7h3v2H8zm0 4h8v2H8zm0 4h8v2H8z",
  image: "M2.992 21A.993.993 0 0 1 2 20.007V3.993A1 1 0 0 1 2.992 3h18.016c.548 0 .992.445.992.993v16.014a1 1 0 0 1-.992.993zM20 15V5H4v14L14 9zm0 2.828l-6-6L6.828 19H20zM8 11a2 2 0 1 1 0-4a2 2 0 0 1 0 4",
  // 关键字标签
  tag: "m10.904 2.1l9.9 1.414l1.414 9.9l-9.192 9.192a1 1 0 0 1-1.415 0l-9.9-9.9a1 1 0 0 1 0-1.413zm.707 2.122L3.833 12l8.485 8.485l7.779-7.778l-1.061-7.425zm2.122 6.363a2 2 0 1 1 2.828-2.828a2 2 0 0 1-2.828 2.829",
  // 知识库根节点（数据库）
  db: "M5 12.5c0 .313.461.858 1.53 1.393C7.914 14.585 9.877 15 12 15s4.086-.415 5.47-1.107c1.069-.535 1.53-1.08 1.53-1.393v-2.171C17.35 11.349 14.827 12 12 12s-5.35-.652-7-1.671zm14 2.829C17.35 16.349 14.827 17 12 17s-5.35-.652-7-1.671V17.5c0 .313.461.858 1.53 1.393C7.914 19.585 9.877 20 12 20s4.086-.415 5.47-1.107c1.069-.535 1.53-1.08 1.53-1.393zM3 17.5v-10C3 5.015 7.03 3 12 3s9 2.015 9 4.5v10c0 2.485-4.03 4.5-9 4.5s-9-2.015-9-4.5m9-7.5c2.123 0 4.086-.415 5.47-1.107C18.539 8.358 19 7.813 19 7.5s-.461-.858-1.53-1.393C16.086 5.415 14.123 5 12 5s-4.086.415-5.47 1.107C5.461 6.642 5 7.187 5 7.5s.461.858 1.53 1.393C7.914 9.585 9.877 10 12 10",
  // 菜单操作
  edit: "M6.414 15.89L16.556 5.748l-1.414-1.414L5 14.476v1.414zm.829 2H3v-4.243L14.435 2.212a1 1 0 0 1 1.414 0l2.829 2.829a1 1 0 0 1 0 1.414zM3 19.89h18v2H3z",
  up: "M13 7.828V20h-2V7.828l-5.364 5.364l-1.414-1.414L12 4l7.778 7.778l-1.414 1.414z",
  fold: "m11.95 7.95l-1.414 1.414L8 6.828V20H6V6.828L3.466 9.364L2.05 7.95L7 3zm10 8.1L17 21l-4.95-4.95l1.414-1.414l2.537 2.536L16 4h2v13.172l2.536-2.536z",
  trash: "M17 6h5v2h-2v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8H2V6h5V3a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1zm1 2H6v12h12zm-9 3h2v6H9zm4 0h2v6h-2zM9 4v2h6V4z",
  pin: "m13.827 1.69l8.486 8.485l-1.415 1.414l-.707-.707l-4.242 4.243l-.707 3.536l-1.415 1.414l-4.242-4.243l-4.95 4.95l-1.414-1.414l4.95-4.95l-4.243-4.243l1.414-1.414l3.536-.707l4.242-4.243l-.707-.707zm.707 3.536l-4.67 4.67l-2.822.565l6.5 6.5l.564-2.822l4.671-4.67z",
  // 通用控件
  close: "m12 10.587l4.95-4.95l1.414 1.414l-4.95 4.95l4.95 4.95l-1.415 1.414l-4.95-4.95l-4.949 4.95l-1.414-1.415l4.95-4.95l-4.95-4.95L7.05 5.638z",
  fullscreen: "M8 3v2H4v4H2V3zM2 21v-6h2v4h4v2zm20 0h-6v-2h4v-4h2zm0-12h-2V5h-4V3h6z",
  fullscreenExit: "M18 7h4v2h-6V3h2zM8 9H2V7h4V3h2zm10 8v4h-2v-6h6v2zM8 15v6H6v-4H2v-2z",
  plus: "M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z",
  minus: "M5 11v2h14v-2z",
  refresh: "M5.463 4.433A9.96 9.96 0 0 1 12 2c5.523 0 10 4.477 10 10c0 2.136-.67 4.116-1.81 5.74L17 12h3A8 8 0 0 0 6.46 6.228zm13.074 15.134A9.96 9.96 0 0 1 12 22C6.477 22 2 17.523 2 12c0-2.136.67-4.116 1.81-5.74L7 12H4a8 8 0 0 0 13.54 5.772z",
};

// HTML 浮层（详情面板 / 右键菜单 / 弹窗 / 控件按钮）用的内联图标
function Ico({ name, size = 12, color = "#667085", style }: {
  name: keyof typeof ICONS;
  size?: number;
  color?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      style={{ flexShrink: 0, display: "inline-block", verticalAlign: "middle", ...style }}>
      <path d={ICONS[name]} fill={color} />
    </svg>
  );
}

function MenuItem({ children, danger, onClick }: { children: React.ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "6px 10px",
        borderRadius: 6,
        cursor: "pointer",
        color: danger ? "#d92d20" : "#344054",
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = danger ? "#fef3f2" : "#f2f4f7"; }}
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
        background: "#fcfcfd",
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
                  stroke={d === 0 ? "#b2ccff" : "#eaecf0"}
                  strokeWidth={1}
                  strokeDasharray={d === 0 ? "none" : "3 4"}
                />
                <text
                  x={extentMinY - 30} y={gy} dy="0.35em" textAnchor="end"
                  style={{
                    fontSize: d === 0 ? "9px" : "8px",
                    fill: d === 0 ? "#155aef" : "#98a2b3",
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
              bgColor = COLORS.documentLight; borderColor = COLORS.document; textColor = "#344054";
            }
            if (isDragSrc || isInDragSubtree) {
              borderColor = COLORS.dragSource;
              bgColor = "#fef3f2";
            }
            if (isDropTarget) {
              borderColor = COLORS.dropTarget;
              bgColor = "#fffaeb";
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
                    {/* 文档类型图标：Remix file-text / image / file（文字型 / 扫描型 / 默认） */}
                    <g transform={`translate(${cx + 8}, ${cy + nh / 2 - 5.2}) scale(0.44)`}>
                      <path
                        d={node.data.pdf_type === "image" ? ICONS.image : node.data.pdf_type === "text" ? ICONS.fileText : ICONS.file}
                        fill={textColor} />
                    </g>
                    <text x={cx + NODE_PADDING_X_DOC + 20} y={cy + nh / 2} dy="0.35em"
                      style={{ fontSize: `${fontSize}px`, fill: textColor, fontWeight: 500, userSelect: "none" }}>
                      {node.data.name.length > 11 ? node.data.name.slice(0, 11) + "…" : node.data.name}
                    </text>
                    {(node.data.keywords || []).length > 0 && (
                      <>
                        {/* 关键字数量：Remix price-tag 图标 + 数字 */}
                        <g transform={`translate(${cx + nw - NODE_PADDING_X_DOC - 21}, ${cy + nh / 2 - 4}) scale(0.33)`}>
                          <path d={ICONS.tag} fill={COLORS.keyword} />
                        </g>
                        <text x={cx + nw - NODE_PADDING_X_DOC} y={cy + nh / 2} dy="0.35em" textAnchor="end"
                          style={{ fontSize: "8px", fill: COLORS.keyword, fontWeight: 700, userSelect: "none" }}>
                          {(node.data.keywords || []).length}
                        </text>
                      </>
                    )}
                  </g>
                ) : (
                  <g style={{ pointerEvents: "none" }}>
                    {/* 根节点=Remix database；目录（知识库位置）=Remix folder */}
                    <g transform={`translate(${labelX - estimateTextWidth(node.data.name, fontSize) / 2 - 15}, ${cy + nh / 2 - 5}) scale(0.42)`}>
                      <path d={isRoot ? ICONS.db : ICONS.folder} fill={isRoot ? COLORS.rootText : textColor} />
                    </g>
                    <text x={labelX} y={cy + nh / 2} dy="0.35em" textAnchor="middle"
                      style={{ fontSize: `${fontSize}px`, fill: textColor, fontWeight: isRoot ? 700 : 600, userSelect: "none" }}>
                      {node.data.name}
                    </text>
                    {isCat && docCount > 0 && (
                      <text x={cx + nw - 20} y={cy + nh / 2} dy="0.35em" textAnchor="end"
                        style={{ fontSize: "8px", fill: "#98a2b3", fontWeight: 600, userSelect: "none" }}>
                        {docCount}
                      </text>
                    )}
                  </g>
                )}

                {isCollapsible && (
                  <g style={{ pointerEvents: "none" }}>
                    <circle cx={cx + nw - 4} cy={cy + nh / 2} r={8} fill="white" stroke={borderColor} strokeWidth={1.5} />
                    <g transform={`translate(${cx + nw - 4 - 5}, ${cy + nh / 2 - 5}) scale(0.42)`}>
                      <path d={collapsedNodes.has(nodeKey) ? ICONS.plus : ICONS.minus} fill={borderColor} />
                    </g>
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
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: COLORS.keywordLight, border: `1px solid ${COLORS.keyword}` }} />
          文件关键字（<Ico name="tag" size={9} color={COLORS.keyword} />n）
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
            <span style={{ fontWeight: 600, fontSize: "13px", color: "#155aef" }}>
              {selectedDoc.name}
            </span>
            <button onClick={() => setSelectedDoc(null)}
              style={{ border: "none", background: "transparent", cursor: "pointer", color: "#98a2b3", display: "flex", alignItems: "center" }}>
              <Ico name="close" size={13} />
            </button>
          </div>

          <div style={{ marginBottom: "8px" }}>
            <div style={{ fontSize: "10px", color: "#98a2b3", fontWeight: 600, marginBottom: "4px" }}>
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
                    display: "inline-flex", alignItems: "center", gap: "4px",
                  }}>
                    <Ico name="folder" size={11} color={COLORS.category} />
                    {level}
                  </span>
                  {i < arr.length - 1 && <span style={{ color: "#98a2b3" }}>→</span>}
                </span>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize: "10px", color: "#98a2b3", fontWeight: 600, marginBottom: "4px" }}>
              文件关键字（扁平、独立属性）
            </div>
            {(selectedDoc.keywords && selectedDoc.keywords.length > 0) ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                {selectedDoc.keywords.map((k, i) => (
                  <span key={i} style={{
                    fontSize: "11px", padding: "2px 8px", borderRadius: "4px",
                    background: COLORS.keywordLight, color: COLORS.keyword,
                    border: `1px solid ${COLORS.keyword}33`, lineHeight: "18px",
                    display: "inline-flex", alignItems: "center", gap: "4px",
                  }}>
                    <Ico name="tag" size={10} color={COLORS.keyword} />
                    {k}
                  </span>
                ))}
              </div>
            ) : (
              <span style={{ color: "#98a2b3", fontSize: "11px" }}>（暂无关键字）</span>
            )}
          </div>

          {selectedDoc.word_count !== undefined && (
            <div style={{ marginTop: "8px", fontSize: "11px", color: "#98a2b3" }}>
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
                <Ico name="folder" size={13} color={COLORS.category} />
                {data.name}
                <span style={{
                  fontSize: "10px", padding: "1px 6px", borderRadius: "3px",
                  background: COLORS.categoryLight, color: COLORS.category, border: `1px solid ${COLORS.category}33`,
                }}>
                  {depthLabel}
                </span>
              </span>
              <button onClick={() => setSelectedCategoryId(null)}
                style={{ border: "none", background: "transparent", cursor: "pointer", color: "#98a2b3", display: "flex", alignItems: "center" }}>
                <Ico name="close" size={13} />
              </button>
            </div>

            {crumbs.length > 0 && (
              <div style={{ marginBottom: "8px", fontSize: "11px", color: "#98a2b3", display: "flex", flexWrap: "wrap", gap: "2px", alignItems: "center" }}>
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
              background: "#f9fafb", borderRadius: "6px", padding: "6px 10px",
            }}>
              <span><b style={{ fontSize: "14px", color: COLORS.category }}>{totalDocs}</b> 个文件</span>
              <span><b style={{ fontSize: "14px", color: COLORS.category }}>{subs.length}</b> 个子目录</span>
              <span><b style={{ fontSize: "14px", color: COLORS.category }}>{docs.length}</b> 直属文件</span>
            </div>

            {subs.length > 0 && (
              <div style={{ marginBottom: "8px" }}>
                <div style={{ fontSize: "10px", color: "#98a2b3", fontWeight: 600, marginBottom: "4px" }}>包含的子目录</div>
                {subs.map(s => (
                  <div key={s.id} onClick={(e) => { e.stopPropagation(); setSelectedCategoryId(s.id); }}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "4px 8px", borderRadius: "4px", cursor: "pointer",
                      background: "#FFFFFF", border: "1px solid #f2f4f7", marginBottom: "2px",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = COLORS.categoryLight; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "#FFFFFF"; }}
                  >
                    <span style={{ color: COLORS.category, fontWeight: 500, display: "flex", alignItems: "center", gap: "4px" }}>
                      <Ico name="folder" size={11} color={COLORS.category} />
                      {s.name}
                    </span>
                    <span style={{ fontSize: "11px", color: "#98a2b3" }}>{s.doc_count ?? 0} 个文件 ›</span>
                  </div>
                ))}
              </div>
            )}

            {docs.length > 0 && (
              <div style={{ marginBottom: "4px" }}>
                <div style={{ fontSize: "10px", color: "#98a2b3", fontWeight: 600, marginBottom: "4px" }}>本目录文件</div>
                {docs.map(d => (
                  <div key={d.id} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "4px 8px", borderRadius: "4px", marginBottom: "2px",
                    background: "#FFFFFF", border: "1px solid #f2f4f7",
                  }}>
                    <span style={{ color: "#344054", display: "flex", alignItems: "center", gap: "5px", overflow: "hidden", maxWidth: "190px" }}>
                      <Ico name="file" size={10} color="#98a2b3" />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
                    </span>
                    {d.keywords && d.keywords.length > 0 && (
                      <span style={{ fontSize: "10px", color: COLORS.keyword, fontWeight: 600, display: "flex", alignItems: "center", gap: "2px" }}>
                        <Ico name="tag" size={9} color={COLORS.keyword} />
                        {d.keywords.length}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {subs.length === 0 && docs.length === 0 && (
              <div style={{ color: "#98a2b3", fontSize: "11px", padding: "4px 0" }}>（空目录）</div>
            )}

            <div style={{ marginTop: "8px", fontSize: "10px", color: "#d0d5dd", textAlign: "center" }}>
              双击折叠 / 展开 · 单击子目录下钻
            </div>
          </div>
        );
      })()}

      {/* Move status toast */}
      {moveStatus && (
        <div className={`notice ${moveStatus.includes("失败") ? "notice-error" : "notice-success"}`}
          style={{
          position: "absolute", top: "12px", left: "50%", transform: "translateX(-50%)",
          boxShadow: "var(--shadow-md)",
          zIndex: 10, userSelect: "none",
        }}>
          {moveStatus}
        </div>
      )}

      {dragSource && !moveStatus && (
        <div className="notice notice-info"
          style={{
          position: "absolute", top: "12px", left: "50%", transform: "translateX(-50%)",
          boxShadow: "var(--shadow-md)",
          zIndex: 10, userSelect: "none",
        }}>
          拖拽到目标分类后松开（会同步更新嵌套字典与文档归档路径）
        </div>
      )}

      {/* Controls */}
      <div style={{ position: "absolute", bottom: "12px", right: "12px", display: "flex", flexDirection: "column", gap: "4px" }}>
        {[
          { label: <Ico name={isFullscreen ? "fullscreenExit" : "fullscreen"} size={14} />, title: isFullscreen ? "退出全屏" : "全屏", action: () => setIsFullscreen(f => !f) },
          { label: <Ico name="plus" size={14} />, title: "放大", action: () => setTransform(p => ({ ...p, scale: Math.min(p.scale * 1.3, 5) })) },
          { label: <Ico name="minus" size={14} />, title: "缩小", action: () => setTransform(p => ({ ...p, scale: Math.max(p.scale / 1.3, 0.1) })) },
          { label: <Ico name="refresh" size={14} />, title: "重置视图", action: () => {
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
              width: "32px", height: "32px", borderRadius: "8px",
              border: "0.5px solid rgba(16, 24, 40, 0.14)", background: "white",
              cursor: "pointer", fontSize: "15px", color: "#344054",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "var(--shadow-xs)",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#f9fafb"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "white"; }}
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
            padding: "5px 10px", color: "#667085", fontSize: "11px",
            borderBottom: "1px solid #f2f4f7", marginBottom: "4px",
            display: "flex", alignItems: "center", gap: "6px", maxWidth: 200,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            <span style={{ display: "flex", alignItems: "center" }}>
              {contextMenu.kind === "document"
                ? <Ico name="file" size={12} color="#667085" />
                : contextMenu.kind === "root"
                  ? <Ico name="db" size={12} color="#155aef" />
                  : <Ico name="folder" size={12} color={COLORS.category} />}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{contextMenu.name}</span>
            {contextMenu.pinned && <span title="手动创建的目录（不会被自动清理）"><Ico name="pin" size={11} color="#f79009" /></span>}
          </div>

          {contextMenu.kind === "category" && (
            <>
              <MenuItem onClick={() => { setMenuDialog({ mode: "rename", nodeId: contextMenu.nodeId }); setMenuInput(contextMenu.name); }}>
                <Ico name="edit" size={11} /> 重命名
              </MenuItem>
              <MenuItem onClick={() => { setMenuDialog({ mode: "create", nodeId: contextMenu.nodeId }); setMenuInput(""); }}>
                <Ico name="folderAdd" size={11} /> 新建子目录
              </MenuItem>
              <MenuItem onClick={handleMenuMoveToRoot}><Ico name="up" size={11} /> 移动到根目录</MenuItem>
              <MenuItem onClick={handleMenuToggleCollapse}><Ico name="fold" size={11} /> 折叠 / 展开</MenuItem>
              <MenuItem danger onClick={handleMenuDeleteNode}><Ico name="trash" size={11} color="#d92d20" /> 删除目录</MenuItem>
            </>
          )}
          {contextMenu.kind === "document" && (
            <MenuItem danger onClick={handleMenuDeleteDoc}><Ico name="trash" size={11} color="#d92d20" /> 删除文档</MenuItem>
          )}
          {contextMenu.kind === "root" && (
            <MenuItem onClick={() => { setMenuDialog({ mode: "create", nodeId: "root" }); setMenuInput(""); }}>
              <Ico name="folderAdd" size={11} /> 新建根目录分类
            </MenuItem>
          )}

          {menuBusy && (
            <div style={{
              padding: "4px 10px", fontSize: "11px",
              color: menuBusy.includes("失败") ? "#991B1B" : "#155aef",
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
          <div style={{ fontSize: "11px", color: "#667085", marginBottom: "6px", display: "flex", alignItems: "center", gap: "5px" }}>
            {menuDialog.mode === "rename"
              ? <><Ico name="edit" size={11} /> 重命名目录</>
              : <><Ico name="folderAdd" size={11} /> 新建子目录</>}
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
              borderRadius: "4px", border: "1px solid #d0d5dd", outline: "none", fontSize: "12px",
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
                background: menuInput.trim() ? "#155aef" : "#d0d5dd", color: "white", cursor: menuInput.trim() ? "pointer" : "not-allowed",
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
