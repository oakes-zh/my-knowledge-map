"use client";

import { useState, useRef } from "react";
import { searchStream } from "@/lib/api";

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
      <h1 style={{ fontSize: "24px", fontWeight: 600, margin: "0 0 1.5rem" }}>
        语义搜索
      </h1>

      {/* Search bar */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "1.5rem" }}>
        <input
          type="text"
          placeholder="用自然语言提问..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{ flex: 1 }}
          disabled={loading}
        />
        <button
          className="btn-primary"
          onClick={handleSearch}
          disabled={loading || !query.trim()}
        >
          {loading ? <span className="loading" /> : "搜索"}
        </button>
      </div>

      {/* Answer */}
      {answer && (
        <div className="card" style={{ marginBottom: "1.5rem" }}>
          <div style={{
            fontSize: "13px",
            fontWeight: 500,
            color: "var(--text-secondary)",
            marginBottom: "0.75rem",
          }}>
            AI 回答
          </div>
          <div style={{
            fontSize: "14px",
            lineHeight: 1.7,
            whiteSpace: "pre-wrap",
          }}>
            {answer}
            {loading && <span style={{ color: "#534AB7" }}>|</span>}
          </div>
        </div>
      )}

      {/* Sources */}
      {sources.length > 0 && (
        <div className="card">
          <div style={{
            fontSize: "13px",
            fontWeight: 500,
            color: "var(--text-secondary)",
            marginBottom: "0.75rem",
          }}>
            引用来源
          </div>
          {sources.map((src, i) => (
            <div key={i} style={{
              padding: "0.625rem 0",
              borderBottom: i < sources.length - 1 ? "1px solid var(--border)" : "none",
            }}>
              <div style={{ fontSize: "14px", fontWeight: 500 }}>
                {src.document_name || `来源 ${i + 1}`}
              </div>
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>
                {src.content?.substring(0, 200)}...
              </div>
            </div>
          ))}
        </div>
      )}

      {!answer && !loading && (
        <div style={{
          textAlign: "center",
          padding: "3rem 0",
          color: "var(--text-secondary)",
          fontSize: "14px",
        }}>
          输入问题，从你的知识库中检索答案
        </div>
      )}
    </div>
  );
}
