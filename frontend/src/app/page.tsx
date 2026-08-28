"use client";

import { useState, useEffect, useCallback } from "react";
import { listDocuments, getArchiveTree, rearchiveDocuments } from "@/lib/api";
import ArchiveTree from "@/components/ArchiveTree";
import { Icon } from "@/components/icons";

interface ArchiveTreeNode {
  id: string;
  name: string;
  kind: "root" | "category" | "document";
  doc_count?: number;
  children?: ArchiveTreeNode[];
}

export default function DashboardPage() {
  const [stats, setStats] = useState({ total: 0, loading: true });
  const [recentDocs, setRecentDocs] = useState<any[]>([]);
  const [treeData, setTreeData] = useState<ArchiveTreeNode | null>(null);
  const [treeLoading, setTreeLoading] = useState(true);
  const [error, setError] = useState("");
  const [treeError, setTreeError] = useState("");
  const [rearchiveState, setRearchiveState] = useState("");

  const loadTree = useCallback(async () => {
    try {
      const data = await getArchiveTree();
      setTreeData(data.tree || null);
      setTreeError("");
    } catch (e: any) {
      setTreeError(e.message);
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const handleRearchive = useCallback(async (onlyUnfiled: boolean) => {
    setRearchiveState("正在重新归档（LLM 重新语义归纳 3-4 级目录）...");
    try {
      const result = await rearchiveDocuments(onlyUnfiled);
      setRearchiveState(
        `已重新归档 ${result.count} 个文档：每个文件从根目录生成 3-4 级归档目录，嵌套字典与归档路径已同步`
      );
      await loadTree();
    } catch (e: any) {
      setRearchiveState(`重新归档失败: ${e.message}`);
    }
    setTimeout(() => setRearchiveState(""), 6000);
  }, [loadTree]);

  useEffect(() => {
    async function load() {
      try {
        const data = await listDocuments(1, 5);
        setRecentDocs(data.data || []);
        setStats({ total: data.total || 0, loading: false });
      } catch (e: any) {
        setError(e.message);
        setStats({ total: 0, loading: false });
      }
    }
    load();
    loadTree();
    // Auto-refresh tree every 30 seconds
    const interval = setInterval(loadTree, 30000);
    return () => clearInterval(interval);
  }, [loadTree]);

  return (
    <div>
      {/* Page header (Dify style: title + subtitle) */}
      <div style={{ marginBottom: "24px" }}>
        <h1 className="page-title" style={{ margin: 0 }}>Dashboard</h1>
        <p className="page-subtitle" style={{ margin: "4px 0 0" }}>
          知识总量、归档图谱与最近入库动态
        </p>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px", marginBottom: "24px" }}>
        <div className="card">
          <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>知识总量</div>
          <div style={{ fontSize: "28px", fontWeight: 600, marginTop: "4px", color: "var(--text-primary)" }}>
            {stats.loading ? <span className="loading" /> : stats.total}
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>最近入库</div>
          <div style={{ fontSize: "28px", fontWeight: 600, marginTop: "4px", color: "var(--text-primary)" }}>
            {recentDocs.length}
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>状态</div>
          <div style={{ marginTop: "10px" }}>
            <span className="badge-soft badge-blue">
              <span style={{
                display: "inline-block",
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "var(--primary)",
                boxShadow: "0 0 0 3px rgba(21, 90, 239, 0.18)",
              }} />
              运行中
            </span>
          </div>
        </div>
      </div>

      {/* Knowledge Graph (Archive Tree) */}
      <div className="card" style={{ marginBottom: "24px", minHeight: "300px", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", gap: "8px", flexWrap: "wrap" }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            知识图谱（归档树）
          </h2>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              className="btn-sm btn-sm-accent"
              onClick={() => handleRearchive(false)}
              title="为每个文件重新归纳 3-4 级归档路径（结合主旨/概要，从根目录开枝散叶）"
            >
              <Icon name="refresh" size={12} color="#155aef" /> 重新归档（3-4 级）
            </button>
            <button
              className="btn-sm btn-sm-tertiary"
              onClick={() => handleRearchive(true)}
              title="只为「未分类」的文档生成归档路径"
            >
              仅归档未分类
            </button>
            <button
              className="btn-sm btn-sm-secondary"
              onClick={loadTree}
            >
              <Icon name="refresh" size={12} color="#344054" /> 刷新
            </button>
          </div>
        </div>

        {rearchiveState && (
          <div
            className={`notice ${rearchiveState.includes("失败") ? "notice-error" : "notice-success"}`}
            style={{ marginBottom: "10px" }}
          >
            {rearchiveState}
          </div>
        )}

        <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "12px", lineHeight: 1.6 }}>
          归档目录是 LLM 对文件「主旨/概要」的重新语义归纳——层级由浅入深（领域 → 主题 → 分类 → 具体），与扁平的文件关键字完全是两回事。
          拖动分类或文档节点即可重新归档：后端会同时更新嵌套字典结构与相关文档的归档路径。
        </div>

        {treeLoading ? (
          <div style={{ textAlign: "center", padding: "3rem" }}>
            <span className="loading" />
          </div>
        ) : treeError ? (
          <div className="notice notice-error">{treeError}</div>
        ) : !treeData ? (
          <div style={{ color: "var(--text-secondary)", fontSize: "13px", textAlign: "center", padding: "2rem" }}>
            暂无知识条目，去入库页添加第一条吧
          </div>
        ) : (
          <ArchiveTree treeData={treeData} onTreeChanged={loadTree} />
        )}
      </div>

      {/* Recent documents */}
      <div className="card">
        <h2 className="section-title" style={{ margin: "0 0 12px" }}>
          最近入库
        </h2>
        {error && (
          <div className="notice notice-error" style={{ marginBottom: "8px" }}>{error}</div>
        )}
        {!error && recentDocs.length === 0 && !stats.loading && (
          <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
            暂无知识条目，去入库页添加第一条吧
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {recentDocs.map((doc) => (
            <div key={doc.id} style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 8px",
              borderRadius: "8px",
              transition: "background 0.15s ease",
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#f9fafb"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: "14px",
                  fontWeight: 500,
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {doc.name}
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
                  {doc.word_count || 0} 字 · {doc.hit_count || 0} 次检索
                </div>
              </div>
              <span className={`badge-soft ${doc.indexing_status === "completed" ? "badge-blue" : "badge-orange"}`}>
                {doc.indexing_status === "completed" ? <><Icon name="check" size={12} color="#155aef" /> 已索引</> : doc.indexing_status || "处理中"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
