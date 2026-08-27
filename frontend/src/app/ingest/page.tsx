"use client";

import { useState, useRef, useCallback } from "react";
import { ingestText, ingestURL, ingestFile } from "@/lib/api";

type Tab = "text" | "url" | "file" | "batch";

const ALLOWED_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".pdf", ".doc", ".docx", ".txt", ".md"];
const ACCEPT_STR = ".png,.jpg,.jpeg,.gif,.bmp,.webp,.pdf,.doc,.docx,.txt,.md";

interface BatchResult {
  filename: string;
  status: "success" | "duplicate" | "error";
  message: string;
  document_id?: string;
}

export default function IngestPage() {
  const [tab, setTab] = useState<Tab>("text");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");

  // Text form
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  // URL form
  const [url, setUrl] = useState("");

  // File form
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Batch form
  const batchRef = useRef<HTMLInputElement>(null);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [batchRunning, setBatchRunning] = useState(false);

  const handleIngest = async () => {
    setLoading(true);
    setError("");
    setResult(null);

    try {
      let res;
      if (tab === "text") {
        if (!content.trim()) throw new Error("内容不能为空");
        res = await ingestText(title, content);
      } else if (tab === "url") {
        if (!url.trim()) throw new Error("URL 不能为空");
        res = await ingestURL(url);
      } else if (tab === "file") {
        if (!selectedFile) throw new Error("请选择文件");
        res = await ingestFile(selectedFile);
      }
      setResult(res);
      // Reset form
      if (tab === "text") { setTitle(""); setContent(""); }
      if (tab === "url") setUrl("");
      if (tab === "file") { setSelectedFile(null); if (fileRef.current) fileRef.current.value = ""; }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Batch upload handler
  const handleBatchUpload = async () => {
    if (batchFiles.length === 0) return;
    setBatchRunning(true);
    setBatchResults([]);
    setBatchProgress({ current: 0, total: batchFiles.length });

    const results: BatchResult[] = [];

    for (let i = 0; i < batchFiles.length; i++) {
      const file = batchFiles[i];
      setBatchProgress({ current: i + 1, total: batchFiles.length });

      try {
        const res = await ingestFile(file);
        results.push({
          filename: file.name,
          status: res.success ? "success" : "duplicate",
          message: res.success ? "入库成功" : res.message || "内容重复",
          document_id: res.document_id,
        });
      } catch (e: any) {
        results.push({
          filename: file.name,
          status: "error",
          message: e.message,
        });
      }
      setBatchResults([...results]);
    }

    setBatchRunning(false);
  };

  // Drag & drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const relatedTarget = e.relatedTarget as Node | null;
    if (relatedTarget && e.currentTarget.contains(relatedTarget)) return;
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      // Check if multiple files dropped (batch)
      const validFiles = Array.from(files).filter(f => {
        const ext = "." + f.name.split(".").pop()?.toLowerCase() || "";
        return ALLOWED_EXTS.includes(ext);
      });

      if (validFiles.length === 0) {
        setError(`不支持的文件类型，支持 ${ALLOWED_EXTS.join(", ")}`);
        return;
      }

      if (validFiles.length === 1) {
        // Single file → file tab
        setSelectedFile(validFiles[0]);
        setTab("file");
      } else {
        // Multiple files → batch tab
        setBatchFiles(validFiles);
        setBatchResults([]);
        setTab("batch");
      }
    }
  }, []);

  // Handle folder selection
  const handleFolderSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const validFiles = Array.from(files).filter(f => {
      const ext = "." + f.name.split(".").pop()?.toLowerCase() || "";
      return ALLOWED_EXTS.includes(ext);
    });

    if (validFiles.length === 0) {
      setError("文件夹中没有可识别的文件类型");
      return;
    }

    setBatchFiles(validFiles);
    setBatchResults([]);
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "text", label: "文本笔记" },
    { key: "url", label: "网页链接" },
    { key: "file", label: "文件上传" },
    { key: "batch", label: "批量上传" },
  ];

  const successCount = batchResults.filter(r => r.status === "success").length;
  const dupCount = batchResults.filter(r => r.status === "duplicate").length;
  const errCount = batchResults.filter(r => r.status === "error").length;

  const labelStyle: React.CSSProperties = {
    fontSize: "13px",
    fontWeight: 500,
    display: "block",
    marginBottom: "6px",
    color: "var(--text-primary)",
  };

  const hintStyle: React.CSSProperties = {
    fontSize: "12px",
    color: "var(--text-secondary)",
  };

  return (
    <div>
      {/* Page header */}
      <div style={{ marginBottom: "24px" }}>
        <h1 className="page-title" style={{ margin: 0 }}>知识入库</h1>
        <p className="page-subtitle" style={{ margin: "4px 0 0" }}>
          支持文本、网页链接、单文件与文件夹批量导入，自动去重与语义打标
        </p>
      </div>

      {/* Tabs — Dify segmented control */}
      <div className="seg" style={{ marginBottom: "20px" }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`seg-item ${tab === t.key ? "active" : ""}`}
            onClick={() => { setTab(t.key); setError(""); setResult(null); }}
            disabled={loading || batchRunning}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Forms */}
      <div className="card" style={{ marginBottom: "20px" }}>
        {tab === "text" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div>
              <label style={labelStyle}>标题（可选）</label>
              <input
                type="text"
                placeholder="自动从内容截取"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={loading}
              />
            </div>
            <div>
              <label style={labelStyle}>内容</label>
              <textarea
                rows={8}
                placeholder="粘贴文本、笔记、代码片段..."
                value={content}
                onChange={(e) => setContent(e.target.value)}
                disabled={loading}
              />
            </div>

            {/* Drop zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`dropzone ${isDragging ? "dragging" : ""}`}
              style={{ padding: "16px" }}
              onClick={() => fileRef.current?.click()}
            >
              <span style={hintStyle}>
                或直接拖拽文件/文件夹到此处
              </span>
            </div>
          </div>
        )}

        {tab === "url" && (
          <>
            <div>
              <label style={labelStyle}>网页链接</label>
              <input
                type="url"
                placeholder="https://example.com/article"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={loading}
              />
              <p style={{ ...hintStyle, marginTop: "8px" }}>
                自动抓取网页正文，去除导航和广告
              </p>
            </div>

            {/* Drop zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`dropzone ${isDragging ? "dragging" : ""}`}
              style={{ padding: "16px", marginTop: "16px" }}
              onClick={() => fileRef.current?.click()}
            >
              <span style={hintStyle}>
                或直接拖拽文件/文件夹到此处
              </span>
            </div>
          </>
        )}

        {tab === "file" && (
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            className={`dropzone ${isDragging ? "dragging" : ""}`}
            style={{ padding: "40px 24px" }}
          >
            <input
              ref={fileRef}
              type="file"
              style={{ display: "none" }}
              onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
              accept={ACCEPT_STR}
            />
            {selectedFile ? (
              <div>
                <div style={{ fontSize: "14px", fontWeight: 500, color: "var(--text-primary)" }}>{selectedFile.name}</div>
                <div style={{ ...hintStyle, marginTop: "4px" }}>
                  {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                </div>
              </div>
            ) : (
              <div style={{ color: isDragging ? "var(--primary)" : "var(--text-secondary)", fontSize: "14px" }}>
                {isDragging ? "松手以上传" : "点击选择文件或拖拽到此区域"}
                {!isDragging && (
                  <div style={{ ...hintStyle, marginTop: "8px" }}>
                    支持 PNG/JPG/PDF/DOC/DOCX/TXT/MD
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === "batch" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {/* Folder selector */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`dropzone ${isDragging ? "dragging" : ""}`}
              style={{ padding: "28px" }}
              onClick={() => batchRef.current?.click()}
            >
              <input
                ref={batchRef}
                type="file"
                style={{ display: "none" }}
                onChange={handleFolderSelect}
                accept={ACCEPT_STR}
                /* @ts-ignore: webkitdirectory is non-standard but widely supported */
                webkitdirectory=""
                directory=""
                multiple
              />
              <div style={{ fontSize: "22px", marginBottom: "8px" }}>📁</div>
              <div style={{ fontSize: "14px", fontWeight: 500, color: isDragging ? "var(--primary)" : "var(--text-primary)" }}>
                {isDragging ? "松手以批量上传" : "点击选择文件夹"}
              </div>
              <div style={{ ...hintStyle, marginTop: "4px" }}>
                自动识别文件夹中所有支持的文件类型
              </div>
              <div style={{ ...hintStyle, marginTop: "4px", fontSize: "11px", color: "var(--text-tertiary)" }}>
                支持 {ALLOWED_EXTS.join(" / ")}，也可拖拽文件夹到此区域
              </div>
            </div>

            {/* File list preview */}
            {batchFiles.length > 0 && (
              <div>
                <div style={{ fontSize: "13px", fontWeight: 500, marginBottom: "8px", color: "var(--text-primary)" }}>
                  已选 {batchFiles.length} 个文件：
                </div>
                <div style={{
                  maxHeight: "200px",
                  overflowY: "auto",
                  border: "1px solid var(--border)",
                  borderRadius: "10px",
                  padding: "8px 12px",
                  background: "#f9fafb",
                }}>
                  {batchFiles.map((f, i) => (
                    <div key={i} style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "5px 0",
                      fontSize: "12px",
                      borderBottom: i < batchFiles.length - 1 ? "1px solid var(--border)" : undefined,
                    }}>
                      <span style={{ color: "var(--text-primary)" }}>{f.name}</span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {(f.size / 1024).toFixed(1)} KB
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Progress bar during batch upload */}
            {batchRunning && (
              <div>
                <div style={{ fontSize: "13px", marginBottom: "8px", color: "var(--text-primary)" }}>
                  正在入库… {batchProgress.current} / {batchProgress.total}
                </div>
                <div style={{
                  height: "6px",
                  borderRadius: "3px",
                  background: "#e9ebf0",
                  overflow: "hidden",
                }}>
                  <div style={{
                    height: "100%",
                    borderRadius: "3px",
                    background: "var(--primary-500)",
                    width: `${(batchProgress.current / batchProgress.total) * 100}%`,
                    transition: "width 0.3s",
                  }} />
                </div>
              </div>
            )}

            {/* Batch results */}
            {batchResults.length > 0 && (
              <div>
                <div style={{ fontSize: "13px", fontWeight: 500, marginBottom: "8px", display: "flex", gap: "10px", flexWrap: "wrap" }}>
                  <span style={{ color: "var(--text-primary)" }}>入库结果：</span>
                  <span className="badge-soft badge-green"> ✅ {successCount} 成功</span>
                  <span className="badge-soft badge-orange"> ⚠️ {dupCount} 重复</span>
                  {errCount > 0 && <span className="badge-soft badge-red"> ❌ {errCount} 失败</span>}
                </div>
                <div style={{
                  maxHeight: "250px",
                  overflowY: "auto",
                  border: "1px solid var(--border)",
                  borderRadius: "10px",
                  padding: "8px 12px",
                  background: "#f9fafb",
                }}>
                  {batchResults.map((r, i) => (
                    <div key={i} style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "5px 0",
                      fontSize: "12px",
                      borderBottom: i < batchResults.length - 1 ? "1px solid var(--border)" : undefined,
                    }}>
                      <span style={{
                        width: "20px",
                        textAlign: "center",
                        fontWeight: 600,
                      }}>
                        {r.status === "success" ? "✅" : r.status === "duplicate" ? "⚠️" : "❌"}
                      </span>
                      <span style={{ flex: 1, color: "var(--text-primary)" }}>{r.filename}</span>
                      <span style={{ color: "var(--text-secondary)" }}>{r.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Submit — different for batch vs single */}
      {tab === "batch" ? (
        batchFiles.length > 0 && !batchRunning && (
          <button
            className="btn-primary"
            onClick={handleBatchUpload}
            style={{ marginBottom: "20px" }}
          >
            开始批量入库 ({batchFiles.length} 个文件)
          </button>
        )
      ) : (
        <button
          className="btn-primary"
          onClick={handleIngest}
          disabled={loading}
          style={{ marginBottom: "20px" }}
        >
          {loading ? <span className="loading" /> : "入库"}
        </button>
      )}

      {/* Error */}
      {error && (
        <div className="notice notice-error" style={{ marginBottom: "12px" }}>{error}</div>
      )}

      {/* Result - Success (single file only) */}
      {tab !== "batch" && result && result.success && (
        <div className="notice notice-success" style={{ flexDirection: "column", alignItems: "flex-start", padding: "14px 16px" }}>
          <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px" }}>
            入库成功
          </div>
          <div style={{ fontSize: "13px" }}>
            <div><strong>标题:</strong> {result.title}</div>
            {result.summary && (
              <div style={{ marginTop: "8px" }}>
                <strong>摘要:</strong> {result.summary}
              </div>
            )}
            {result.tags && result.tags.length > 0 && (
              <div style={{ marginTop: "8px", display: "flex", alignItems: "center", flexWrap: "wrap" }}>
                <strong>标签:</strong>{" "}
                {result.tags.map((tag: string, i: number) => (
                  <span key={i} className="badge-soft badge-green" style={{ marginLeft: i === 0 ? "6px" : 0 }}>{tag}</span>
                ))}
              </div>
            )}
            <div style={{ marginTop: "8px", fontSize: "12px", opacity: 0.7 }}>
              Document ID: {result.document_id}
            </div>
          </div>
        </div>
      )}

      {/* Result - Duplicate (single file only) */}
      {tab !== "batch" && result && !result.success && (
        <div className="notice notice-warning" style={{ flexDirection: "column", alignItems: "flex-start", padding: "14px 16px" }}>
          <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px" }}>
            ⚠️ 内容重复
          </div>
          <div style={{ fontSize: "13px" }}>
            {result.message}
            <div style={{ marginTop: "8px", fontSize: "12px", opacity: 0.7 }}>
              已有文档 ID: {result.document_id}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
