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
      <h1 style={{ fontSize: "24px", fontWeight: 600, margin: "0 0 1.5rem" }}>
        知识浏览
      </h1>

      {error && (
        <div className="card" style={{ borderColor: "#F7C1C1", background: "#FCEBEB", marginBottom: "1rem" }}>
          <div style={{ fontSize: "13px", color: "#A32D2D" }}>{error}</div>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}>
          <span className="loading" />
        </div>
      ) : docs.length === 0 ? (
        <div className="card" style={{ textAlign: "center", color: "var(--text-secondary)", fontSize: "14px" }}>
          暂无知识条目
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {docs.map((doc) => (
              <div key={doc.id} className="card" style={{ padding: "1rem 1.25rem", position: "relative" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: "14px",
                      fontWeight: 500,
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
                      <div style={{ display: "flex", gap: "6px", marginTop: "8px", flexWrap: "wrap", alignItems: "center" }}>
                        <span style={{ fontSize: "10px", color: "#999", fontWeight: 600, marginRight: "2px" }}>
                          关键字：
                        </span>
                        {doc.auto_tags.map((tag: string, i: number) => (
                          <span key={i} style={{
                            fontSize: "12px",
                            padding: "2px 8px",
                            borderRadius: "4px",
                            background: "#F0F0F0",
                            color: "#666",
                            lineHeight: "20px",
                          }}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Custom keywords (user-added, still flat) */}
                    {doc.custom_tags && doc.custom_tags.length > 0 && (
                      <div style={{ display: "flex", gap: "6px", marginTop: "6px", flexWrap: "wrap", alignItems: "center" }}>
                        <span style={{ fontSize: "10px", color: "#999", fontWeight: 600, marginRight: "2px" }}>
                          自定义：
                        </span>
                        {doc.custom_tags.map((tag: string, i: number) => (
                          <span key={i} style={{
                            fontSize: "12px",
                            padding: "2px 8px",
                            borderRadius: "4px",
                            background: "#D3F0E5",
                            color: "#085041",
                            lineHeight: "20px",
                            cursor: "pointer",
                          }}
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
                      <div style={{ display: "flex", gap: "6px", marginTop: "6px", alignItems: "center" }}>
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
                            borderRadius: "4px",
                            border: "1px solid #ccc",
                            outline: "none",
                            width: "120px",
                            height: "24px",
                          }}
                        />
                        <button
                          onClick={() => handleAddTag(doc.id)}
                          style={{ fontSize: "12px", padding: "2px 8px", borderRadius: "4px", background: "#D3F0E5", color: "#085041", border: "none", cursor: "pointer" }}
                        >
                          添加
                        </button>
                        <button
                          onClick={() => { setEditingDocId(null); setTagInput(""); }}
                          style={{ fontSize: "12px", padding: "2px 8px", borderRadius: "4px", background: "#F0F0F0", color: "#666", border: "none", cursor: "pointer" }}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      (!(doc.custom_tags?.length >= 5)) && (
                        <div
                          onClick={() => { setEditingDocId(doc.id); setTagInput(""); }}
                          style={{
                            fontSize: "12px",
                            marginTop: "6px",
                            color: "#999",
                            cursor: "pointer",
                          }}
                        >
                          + 添加标签
                        </div>
                      )
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                    {/* PDF type label */}
                    {doc.pdf_type === "text" && (
                      <span style={{
                        fontSize: "11px",
                        padding: "2px 6px",
                        borderRadius: "3px",
                        background: "#E8F0FE",
                        color: "#1A73E8",
                        lineHeight: "18px",
                      }}>
                        📝 文字PDF
                      </span>
                    )}
                    {doc.pdf_type === "image" && (
                      <span style={{
                        fontSize: "11px",
                        padding: "2px 6px",
                        borderRadius: "3px",
                        background: "#FFF3E0",
                        color: "#E65100",
                        lineHeight: "18px",
                      }}>
                        📷 扫描PDF
                      </span>
                    )}
                    <div style={{
                      fontSize: "12px",
                      fontWeight: 500,
                      color: doc.indexing_status === "completed" ? "#1D9E75" : "#BA7517",
                    }}>
                      {doc.indexing_status === "completed" ? "已索引" : doc.indexing_status || ""}
                    </div>
                    {/* Archive directory (LLM re-semantic hierarchy) - bottom right corner */}
                    {doc.archive_path && doc.archive_path.length > 0 && (
                      <span
                        title={`归档目录：${doc.archive_path.join(" / ")}`}
                        style={{
                          position: "absolute",
                          bottom: "8px",
                          right: "12px",
                          fontSize: "11px",
                          padding: "2px 7px",
                          borderRadius: "3px",
                          background: "#F0FDFA",
                          color: "#0F766E",
                          lineHeight: "18px",
                          maxWidth: "260px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          cursor: "default",
                        }}
                      >
                        📁 归档目录：{doc.archive_path.join(" → ")}
                      </span>
                    )}
                    <button
                      onClick={() => handleDelete(doc.id)}
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        color: "#A32D2D",
                        fontSize: "12px",
                        padding: "4px",
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{
              display: "flex",
              justifyContent: "center",
              gap: "8px",
              marginTop: "1.5rem",
            }}>
              <button
                className="btn-secondary"
                onClick={() => load(page - 1)}
                disabled={page <= 1}
              >
                上一页
              </button>
              <span style={{
                padding: "0.5rem 1rem",
                fontSize: "14px",
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
