"use client";

import { useState, useRef } from "react";
import { searchStream } from "@/lib/api";
import { Icon } from "@/components/icons";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const answerRef = useRef("");

  const handleSearch = async () => {
    if (!query.trim() || loading) return;

    setLoading(true);
    setAnswer("");
    setSources([]);
    answerRef.current = "";

    await searchStream(
      query,
      conversationId,
      (chunk) => {
        answerRef.current += chunk;
        setAnswer(answerRef.current);
      },
      () => {
        setLoading(false);
      },
      (err) => {
        setAnswer(`Error: ${err}`);
        setLoading(false);
      },
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSearch();
    }
  };

  return (
    <div>
      {/* Page header */}
      <div style={{ marginBottom: "24px" }}>
        <h1 className="page-title" style={{ margin: 0 }}>语义搜索</h1>
        <p className="page-subtitle" style={{ margin: "4px 0 0" }}>
          用自然语言提问，从知识库中检索答案
        </p>
      </div>

      {/* Search bar (Dify chat-input look: large rounded field + primary button) */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "24px" }}>
        <input
          type="text"
          placeholder="用自然语言提问..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{ flex: 1, fontSize: "14px", padding: "10px 14px", borderRadius: "10px" }}
          disabled={loading}
        />
        <button
          className="btn-primary"
          style={{ height: "40px", padding: "0 18px", borderRadius: "10px" }}
          onClick={handleSearch}
          disabled={loading || !query.trim()}
        >
          {loading ? <span className="loading" /> : "搜索"}
        </button>
      </div>

      {/* Answer */}
      {answer && (
        <div className="card" style={{ marginBottom: "24px" }}>
          <div style={{
            fontSize: "12px",
            fontWeight: 600,
            color: "var(--text-tertiary)",
            marginBottom: "12px",
            letterSpacing: "0.02em",
          }}>
            AI 回答
          </div>
          <div style={{
            fontSize: "14px",
            lineHeight: 1.7,
            color: "var(--text-primary)",
            whiteSpace: "pre-wrap",
          }}>
            {answer}
            {loading && <span style={{ color: "var(--primary)" }}>▍</span>}
          </div>
        </div>
      )}

      {/* Sources */}
      {sources.length > 0 && (
        <div className="card">
          <div style={{
            fontSize: "12px",
            fontWeight: 600,
            color: "var(--text-tertiary)",
            marginBottom: "12px",
            letterSpacing: "0.02em",
          }}>
            引用来源
          </div>
          {sources.map((src, i) => (
            <div key={i} style={{
              padding: "10px 8px",
              borderRadius: "8px",
              marginBottom: i < sources.length - 1 ? "4px" : 0,
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#f9fafb"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ fontSize: "14px", fontWeight: 500, color: "var(--text-primary)" }}>
                {src.document_name || `来源 ${i + 1}`}
              </div>
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px", lineHeight: 1.6 }}>
                {src.content?.substring(0, 200)}...
              </div>
            </div>
          ))}
        </div>
      )}

      {!answer && !loading && (
        <div className="card" style={{
          textAlign: "center",
          padding: "48px 24px",
        }}>
          <div style={{
            width: "56px",
            height: "56px",
            margin: "0 auto 16px",
            borderRadius: "14px",
            border: "1px dashed var(--border-strong)",
            background: "#ffffff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-tertiary)",
            boxShadow: "var(--shadow-xs)",
          }}>
            <Icon name="search" size={26} color="#98a2b3" />
          </div>
          <div style={{ color: "var(--text-tertiary)", fontSize: "13px" }}>
            输入问题，从你的知识库中检索答案
          </div>
        </div>
      )}
    </div>
  );
}
