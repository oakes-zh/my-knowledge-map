"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/", label: "Dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
  { href: "/search", label: "搜索", icon: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" },
  { href: "/ingest", label: "入库", icon: "M12 4v16m8-8H4" },
  { href: "/browse", label: "浏览", icon: "M4 6h16M4 10h16M4 14h16M4 18h16" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      style={{
        width: "220px",
        minWidth: "220px",
        padding: "16px 12px",
        borderRight: "1px solid var(--border-subtle)",
        background: "var(--bg-primary)",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      }}
    >
      {/* Logo — Dify style mark */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "8px 8px 20px",
        }}
      >
        <div
          style={{
            width: "28px",
            height: "28px",
            borderRadius: "8px",
            background: "linear-gradient(135deg, #2970ff 0%, #155aef 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#ffffff",
            fontSize: "14px",
            fontWeight: 700,
            boxShadow: "var(--shadow-sm)",
          }}
        >
          K
        </div>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>
            Personal KB
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "1px" }}>
            知识库工作台
          </div>
        </div>
      </div>

      {navItems.map((item) => {
        const isActive = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`nav-item ${isActive ? "active" : ""}`}
          >
            <svg
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={1.8}
              style={{ flexShrink: 0 }}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
            </svg>
            {item.label}
          </Link>
        );
      })}

      <div style={{ marginTop: "auto", padding: "0 8px" }}>
        <div
          style={{
            fontSize: "11px",
            color: "var(--text-tertiary)",
            padding: "12px 0 4px",
            borderTop: "1px solid var(--border-subtle)",
          }}
        >
          Powered by Dify
        </div>
      </div>
    </aside>
  );
}
