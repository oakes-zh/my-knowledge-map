const API_BASE = "/api/backend";

export async function ingestText(title: string, content: string, source: string = "manual") {
  const resp = await fetch(`${API_BASE}/ingest/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, content, source }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function ingestURL(url: string) {
  const resp = await fetch(`${API_BASE}/ingest/url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function ingestFile(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const resp = await fetch(`${API_BASE}/ingest/file`, {
    method: "POST",
    body: formData,
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function searchKnowledge(query: string, conversationId: string = "") {
  const resp = await fetch(`${API_BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, conversation_id: conversationId }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function listDocuments(page: number = 1, limit: number = 20) {
  const resp = await fetch(`${API_BASE}/documents?page=${page}&limit=${limit}`);
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function getDocumentTree() {
  const resp = await fetch(`${API_BASE}/documents/tree`);
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function getArchiveTree() {
  const resp = await fetch(`${API_BASE}/documents/archive-tree`);
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function rearchiveDocuments(onlyUnfiled: boolean = false) {
  const resp = await fetch(`${API_BASE}/documents/rearchive?only_unfiled=${onlyUnfiled}`, {
    method: "POST",
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function deleteDocument(documentId: string) {
  const resp = await fetch(`${API_BASE}/documents/${documentId}`, { method: "DELETE" });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function updateCustomTags(documentId: string, customTags: string[]) {
  const resp = await fetch(`${API_BASE}/documents/${documentId}/tags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ custom_tags: customTags }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function moveArchiveNode(sourceNodeId: string, sourceDocId: string, targetNodeId: string) {
  const resp = await fetch(`${API_BASE}/archive/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_node_id: sourceNodeId, source_doc_id: sourceDocId, target_node_id: targetNodeId }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function renameArchiveNode(nodeId: string, name: string) {
  const resp = await fetch(`${API_BASE}/archive/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, name }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function createArchiveNode(parentNodeId: string, name: string) {
  const resp = await fetch(`${API_BASE}/archive/create-node`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent_node_id: parentNodeId, name }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function deleteArchiveNode(nodeId: string) {
  const resp = await fetch(`${API_BASE}/archive/delete-node`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: nodeId }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

export async function searchStream(
  query: string,
  conversationId: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
) {
  try {
    const resp = await fetch(`${API_BASE}/search/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, conversation_id: conversationId }),
    });

    const reader = resp.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) return;

    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.error) {
              onError(data.error);
            } else if (data.answer) {
              onChunk(data.answer);
            }
          } catch {
            // partial JSON, skip
          }
        }
      }
    }
    onDone();
  } catch (e: any) {
    onError(e.message);
  }
}
