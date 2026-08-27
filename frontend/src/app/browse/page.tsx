"use client";

import { useState, useEffect } from "react";
import { listDocuments, deleteDocument, updateCustomTags } from "@/lib/api";

export default function BrowsePage() {
  const [docs, setDocs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");

  // Tag editing state: { docId: string showing input }
  const [editingDocId, setEditingDocId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");

  const load = async (p: number = 1) => {
    setLoading(true);
    setError("");
    try {
      const data = await listDocuments(p, 20);
      setDocs(data.data || []);
      setTotal(data.total || 0);
      setPage(p);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(1); }, []);

  const handleDelete = async (docId: string) => {
    if (!confirm("确认删除这条知识？")) return;
    try {
      await deleteDocument(docId);
      load(page);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleAddTag = async (docId: string) => {
    const doc = docs.find(d => d.id === docId);
    if (!doc) return;
    const newTag = tagInput.trim();
    if (!newTag) return;
    const currentCustom = doc.custom_tags || [];
    if (currentCustom.length >= 5) {
      setError("自定义标签最多 5 个");
      return;
    }
    if (currentCustom.includes(newTag)) {
      setTagInput("");
      setEditingDocId(null);
      return;
    }
    try {
      const result = await updateCustomTags(docId, [...currentCustom, newTag]);
      setDocs(docs.map(d => d.id === docId ? { ...d, custom_tags: result.custom_tags } : d));
      setTagInput("");
      setEditingDocId(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleRemoveTag = async (docId: string, tagToRemove: string) => {
    const doc = docs.find(d => d.id === docId);
    if (!doc) return;
    const updated = (doc.custom_tags || []).filter((t: string) => t !== tagToRemove);
    try {
      const result = await updateCustomTags(docId, updated);
      setDocs(docs.map(d => d.id === docId ? { ...d, custom_tags: result.custom_tags } : d));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const totalPages = Math.ceil(total / 20);

  return (
    <div>
      {/* Page header */}
      <div style={{ marginBottom: "24px" }}>
        <h1 className="page-title" style={{ margin: 0 }}>知识浏览</h1>
        <p className="page-subtitle" style={{ margin: "4px 0 0" }}>
          共 {total} 条知识，按入库时间排列
        </p>
      </div>

      {error && (
        <div className="notice notice-error" style={{ marginBottom: "16px" }}>{error}</div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}>
          <span className="loading" />
        </div>
      ) : docs.length === 0 ? (
        <div className="card" style={{ textAlign: "center", color: "var(--text-secondary)", fontSize: "14px", padding: "48px" }}>
          暂无知识条目
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {docs.map((doc) => (
              <div
                key={doc.id}
                className="card"
                style={{
                  padding: "16px 20px",
                  position: "relative",
                  transition: "box-shadow 0.15s ease, background 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.boxShadow = "var(--shadow-md)";
                  e.currentTarget.style.background = "#ffffff";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.boxShadow = "var(--shadow-xs)";
                  e.currentTarget.style.background = "var(--bg-primary)";
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
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
                    <div style={{
                      fontSize: "12px",
                      color: "var(--text-secondary)",
                      marginTop: "4px",
                      display: "flex",
                      gap: "12px",
                    }}>
                      <span>{doc.word_count || 0} 字</span>
                      <span>{doc.hit_count || 0} 次检索</span>
                      <span>{doc.created_at ? new Date(doc.created_at * 1000).toLocaleDateString("zh-CN") : ""}</span>
                    </div>

                    {/* 文件关键字: flat, independent attributes (auto-detected) */}
                    {doc.auto_tags && doc.auto_tags.length > 0 && (
                      <div style={{ display: "flex", gap: "6px", marginTop: "10px", flexWrap: "wrap", alignItems: "center" }}>
                        <span style={{ fontSize: "11px", color: "var(--text-tertiary)", fontWeight: 600, marginRight: "2px" }}>
                          关键字：
                        </span>
                        {doc.auto_tags.map((tag: string, i: number) => (
                          <span key={i} className="badge-soft badge-gray">{tag}</span>
                        ))}
                      </div>
                    )}

                    {/* Custom keywords (user-added, still flat) */}
                    {doc.custom_tags && doc.custom_tags.length > 0 && (
                      <div style={{ display: "flex", gap: "6px", marginTop: "6px", flexWrap: "wrap", alignItems: "center" }}>
                        <span style={{ fontSize: "11px", color: "var(--text-tertiary)", fontWeight: 600, marginRight: "2px" }}>
                          自定义：
                        </span>
                        {doc.custom_tags.map((tag: string, i: number) => (
                          <span
                            key={i}
                            className="badge-soft badge-green"
                            style={{ cursor: "pointer" }}
                            title="点击移除"
                            onClick={() => handleRemoveTag(doc.id, tag)}
                          >
                            {tag} ×
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Add custom tag input */}
                    {editingDocId === doc.id ? (
                      <div style={{ display: "flex", gap: "6px", marginTop: "8px", alignItems: "center" }}>
                        <input
                          type="text"
                          value={tagInput}
                          onChange={(e) => setTagInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleAddTag(doc.id);
                            if (e.key === "Escape") { setEditingDocId(null); setTagInput(""); }
                          }}
                          placeholder="输入标签"
                          autoFocus
                          style={{
                            fontSize: "12px",
                            padding: "2px 8px",
                            borderRadius: "6px",
                            width: "140px",
                            height: "26px",
                          }}
                        />
                        <button className="btn-sm btn-sm-accent" onClick={() => handleAddTag(doc.id)}>
                          添加
                        </button>
                        <button
                          className="btn-sm btn-sm-tertiary"
                          onClick={() => { setEditingDocId(null); setTagInput(""); }}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      (!(doc.custom_tags?.length >= 5)) && (
                        <div
                          onClick={() => { setEditingDocId(doc.id); setTagInput(""); }}
                          className="btn-sm btn-sm-accent"
                          style={{ marginTop: "6px", paddingLeft: 0 }}
                        >
                          + 添加标签
                        </div>
                      )
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    {/* PDF type label */}
                    {doc.pdf_type === "text" && (
                      <span className="badge-soft badge-blue">📝 文字PDF</span>
                    )}
                    {doc.pdf_type === "image" && (
                      <span className="badge-soft badge-orange">📷 扫描PDF</span>
                    )}
                    <span className={`badge-soft ${doc.indexing_status === "completed" ? "badge-green" : "badge-orange"}`}>
                      {doc.indexing_status === "completed" ? "已索引" : doc.indexing_status || ""}
                    </span>
                    <button className="btn-sm btn-sm-danger" onClick={() => handleDelete(doc.id)}>
                      删除
                    </button>
                  </div>
                </div>

                {/* Archive directory (LLM re-semantic hierarchy) - bottom right corner */}
                {doc.archive_path && doc.archive_path.length > 0 && (
                  <span
                    title={`归档目录：${doc.archive_path.join(" / ")}`}
                    className="badge-soft badge-purple"
                    style={{
                      position: "absolute",
                      bottom: "12px",
                      right: "16px",
                      maxWidth: "280px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      cursor: "default",
                    }}
                  >
                    📁 {doc.archive_path.join(" → ")}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: "12px",
              marginTop: "24px",
            }}>
              <button
                className="btn-secondary"
                onClick={() => load(page - 1)}
                disabled={page <= 1}
              >
                上一页
              </button>
              <span style={{
                fontSize: "13px",
                color: "var(--text-secondary)",
              }}>
                {page} / {totalPages}
              </span>
              <button
                className="btn-secondary"
                onClick={() => load(page + 1)}
                disabled={page >= totalPages}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
