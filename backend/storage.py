"""SQLite 存储层：单文件 kb.db 承载所有元数据、分块、全文索引、向量"""
import sqlite3
import json
import logging
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Dict, Any

logger = logging.getLogger(__name__)

DEFAULT_DB_PATH = Path("./kb.db")
CHUNK_SIZE = 512
CHUNK_OVERLAP = 50

def bigrams(text: str) -> str:
    """将文本转换为 bigram 展开字符串（用于 FTS5 中文检索）"""
    import re
    s = re.sub(r"\s+", "", text)
    if len(s) < 2:
        return s
    # 中文按字 bigram，英文单词保持原样
    out = []
    for run in re.findall(r"[\u4e00-\u9fff]+|[A-Za-z0-9]+", s):
        if re.match(r"[\u4e00-\u9fff]", run) and len(run) >= 2:
            out += [run[i:i+2] for i in range(len(run)-1)]
        else:
            out.append(run)
    return " ".join(out)


def init_db(db_path: Path = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """初始化数据库，创建所有表"""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # 创建 documents 表
    conn.execute("""
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            source TEXT DEFAULT 'manual',
            source_url TEXT,
            doc_type TEXT DEFAULT 'text',
            content_hash TEXT UNIQUE,
            archive_path TEXT,
            archive_node_id TEXT,
            summary TEXT,
            keywords JSON,
            pdf_type TEXT,
            word_count INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)

    # 创建 chunks 表
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            text TEXT NOT NULL,
            embedding BLOB,
            embedding_model TEXT,
            FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
        )
    """)

    # 创建 archive_nodes 表
    conn.execute("""
        CREATE TABLE IF NOT EXISTS archive_nodes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id TEXT,
            position INTEGER DEFAULT 0,
            FOREIGN KEY (parent_id) REFERENCES archive_nodes(id) ON DELETE CASCADE
        )
    """)

    # 创建 FTS5 全文索引表
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            text,
            tokenize='unicode61',
            content='chunks',
            content_rowid='id'
        )
    """)

    # 创建元信息表
    conn.execute("""
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)

    # 插入根节点
    conn.execute("""
        INSERT OR IGNORE INTO archive_nodes (id, name, parent_id, position)
        VALUES ('root', '知识库', NULL, 0)
    """)

    # 记录 schema 版本
    conn.execute("""
        INSERT OR REPLACE INTO meta (key, value)
        VALUES ('schema_version', '2.0')
    """)

    conn.commit()
    logger.info(f"Database initialized at {db_path}")
    return conn


def get_connection(db_path: Path = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """获取数据库连接（线程不安全，每个请求创建新连接）"""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def get_doc_count(conn: sqlite3.Connection) -> int:
    """获取文档总数"""
    return conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]


def get_chunk_count(conn: sqlite3.Connection) -> int:
    """获取分块总数"""
    return conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]


def get_archive_node(doc_id: str, conn: sqlite3.Connection) -> Optional[str]:
    """获取文档的归档节点 ID"""
    row = conn.execute(
        "SELECT archive_node_id FROM documents WHERE id = ?",
        (doc_id,)
    ).fetchone()
    return row["archive_node_id"] if row else None


def set_archive_node(doc_id: str, node_id: str, conn: sqlite3.Connection) -> None:
    """设置文档的归档节点"""
    conn.execute(
        "UPDATE documents SET archive_node_id = ? WHERE id = ?",
        (node_id, doc_id)
    )
    conn.commit()


def get_archive_path(doc_id: str, conn: sqlite3.Connection) -> Optional[str]:
    """获取文档的归档路径"""
    row = conn.execute(
        "SELECT archive_path FROM documents WHERE id = ?",
        (doc_id,)
    ).fetchone()
    return row["archive_path"] if row else None


def set_archive_path(doc_id: str, path: str, conn: sqlite3.Connection) -> None:
    """设置文档的归档路径"""
    conn.execute(
        "UPDATE documents SET archive_path = ? WHERE id = ?",
        (path, doc_id)
    )
    conn.commit()


def insert_document(
    doc_id: str,
    title: str,
    content_hash: str,
    source: str = "manual",
    source_url: str = "",
    doc_type: str = "text",
    summary: str = "",
    keywords: Optional[List[str]] = None,
    pdf_type: str = "",
    word_count: int = 0,
    archive_path: str = "",
    archive_node_id: str = "",
    conn: Optional[sqlite3.Connection] = None
) -> None:
    """插入文档元数据"""
    conn = conn or get_connection()
    now = datetime.now().isoformat()
    keywords_json = json.dumps(keywords or [])

    conn.execute("""
        INSERT INTO documents (
            id, title, source, source_url, doc_type, content_hash,
            archive_path, archive_node_id, summary, keywords,
            pdf_type, word_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        doc_id, title, source, source_url, doc_type, content_hash,
        archive_path, archive_node_id, summary, keywords_json,
        pdf_type, word_count, now, now
    ))
    conn.commit()


def get_document(doc_id: str, conn: Optional[sqlite3.Connection] = None) -> Optional[Dict[str, Any]]:
    """获取文档元数据"""
    conn = conn or get_connection()
    row = conn.execute(
        "SELECT * FROM documents WHERE id = ?",
        (doc_id,)
    ).fetchone()
    if not row:
        return None

    doc = dict(row)
    doc["keywords"] = json.loads(doc["keywords"]) if doc["keywords"] else []
    return doc


def list_documents(
    page: int = 1,
    limit: int = 20,
    archive_path: Optional[str] = None,
    conn: Optional[sqlite3.Connection] = None
) -> Dict[str, Any]:
    """获取文档列表（支持按归档路径过滤）"""
    conn = conn or get_connection()

    query = "SELECT * FROM documents WHERE 1=1"
    params = []

    if archive_path:
        query += " AND archive_path LIKE ?"
        params.append(f"{archive_path}%")

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
    params.extend([limit, (page - 1) * limit])

    rows = conn.execute(query, params).fetchall()
    total = conn.execute(
        "SELECT COUNT(*) FROM documents WHERE 1=1" +
        (" AND archive_path LIKE ?" if archive_path else ""),
        params[:-2]
    ).fetchone()[0]

    docs = [dict(r) for r in rows]
    for doc in docs:
        doc["keywords"] = json.loads(doc["keywords"]) if doc["keywords"] else []

    return {
        "data": docs,
        "total": total,
        "page": page,
        "limit": limit,
        "has_more": total > (page * limit)
    }


def insert_chunk(
    doc_id: str,
    seq: int,
    text: str,
    embedding: Optional[bytes] = None,
    embedding_model: Optional[str] = None,
    conn: Optional[sqlite3.Connection] = None
) -> int:
    """插入分块，同时更新 FTS5 索引"""
    conn = conn or get_connection()

    chunk_id = conn.execute(
        """
        INSERT INTO chunks (doc_id, seq, text, embedding, embedding_model)
        VALUES (?, ?, ?, ?, ?)
        """,
        (doc_id, seq, text, embedding, embedding_model)
    ).lastrowid

    # 同步到 FTS5（外部内容表，用 rowid 而非 id 列）
    conn.execute(
        "INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)",
        (chunk_id, bigrams(text))
    )
    conn.commit()

    return chunk_id


def insert_chunks(
    doc_id: str,
    texts: List[str],
    embedding_model: Optional[str] = None,
    conn: Optional[sqlite3.Connection] = None
) -> List[int]:
    """批量插入分块"""
    conn = conn or get_connection()
    chunk_ids = []

    for i, text in enumerate(texts):
        chunk_id = insert_chunk(doc_id, i, text, None, embedding_model, conn)
        chunk_ids.append(chunk_id)

    return chunk_ids


def delete_document(doc_id: str, conn: Optional[sqlite3.Connection] = None) -> None:
    """删除文档（级联删除 chunks 和 chunks_fts）"""
    conn = conn or get_connection()
    # 先取出待删 chunk 的 (rowid, text)，用于清理外部内容 FTS5 索引
    rows = conn.execute(
        "SELECT id, text FROM chunks WHERE doc_id = ?", (doc_id,)
    ).fetchall()
    # 必须先发 FTS 'delete' 指令再删 chunks 行；且传入的 text 必须与
    # 入库时索引的值（bigrams 展开）完全一致——FTS5 外部内容表对
    # 不一致的 delete 值会抛 "database disk image is malformed"。
    for cid, ctext in rows:
        conn.execute(
            "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)",
            (cid, bigrams(ctext or "")),
        )
    conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
    conn.commit()


def get_chunks_by_doc_id(
    doc_id: str,
    limit: int = 100,
    conn: Optional[sqlite3.Connection] = None
) -> List[Dict[str, Any]]:
    """获取文档的所有分块"""
    conn = conn or get_connection()
    rows = conn.execute(
        """
        SELECT id, doc_id, seq, text, embedding, embedding_model
        FROM chunks
        WHERE doc_id = ?
        ORDER BY seq
        LIMIT ?
        """,
        (doc_id, limit)
    ).fetchall()

    return [dict(r) for r in rows]


def get_chunk_by_id(chunk_id: int, conn: Optional[sqlite3.Connection] = None) -> Optional[Dict[str, Any]]:
    """根据 chunk_id 获取分块"""
    conn = conn or get_connection()
    row = conn.execute(
        "SELECT * FROM chunks WHERE id = ?",
        (chunk_id,)
    ).fetchone()
    return dict(row) if row else None


def get_embedding_model(conn: Optional[sqlite3.Connection] = None) -> Optional[str]:
    """获取当前 embedding 模型"""
    conn = conn or get_connection()
    row = conn.execute(
        "SELECT value FROM meta WHERE key = ?",
        ("embedding_model",)
    ).fetchone()
    return row["value"] if row else None


def set_embedding_model(model: str, conn: Optional[sqlite3.Connection] = None) -> None:
    """设置 embedding 模型"""
    conn = conn or get_connection()
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        ("embedding_model", model)
    )
    conn.commit()


def get_embedding_dim(conn: Optional[sqlite3.Connection] = None) -> Optional[int]:
    """获取 embedding 维度"""
    conn = conn or get_connection()
    row = conn.execute(
        "SELECT value FROM meta WHERE key = ?",
        ("embedding_dim",)
    ).fetchone()
    return int(row["value"]) if row else None


def set_embedding_dim(dim: int, conn: Optional[sqlite3.Connection] = None) -> None:
    """设置 embedding 维度"""
    conn = conn or get_connection()
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        ("embedding_dim", dim)
    )
    conn.commit()


def get_db_path() -> Path:
    """获取数据库路径"""
    return DEFAULT_DB_PATH
