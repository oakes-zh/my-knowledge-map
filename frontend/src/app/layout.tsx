import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "Personal KB",
  description: "Personal Knowledge Base powered by Dify",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh">
      <body>
        <div style={{ display: "flex", minHeight: "100vh" }}>
          <Sidebar />
          <main style={{ flex: 1, padding: "2rem", maxWidth: "900px", margin: "0 auto", width: "100%" }}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
