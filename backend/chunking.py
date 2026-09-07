"""分块服务：固定窗口 + overlap"""
from typing import List


def chunk_text(
    text: str,
    chunk_size: int = 512,
    overlap: int = 50
) -> List[str]:
    """
    将文本切分为固定窗口的分块，带重叠

    Args:
        text: 输入文本
        chunk_size: 分块大小（字符数）
        overlap: 重叠长度（字符数）

    Returns:
        分块列表
    """
    if not text:
        return []

    chunks = []
    start = 0
    text_len = len(text)

    while start < text_len:
        end = start + chunk_size
        chunk = text[start:end].strip()

        if not chunk:
            # 跳过空分块
            start += 1
            continue

        chunks.append(chunk)

        # 如果还有剩余文本，移动到重叠位置
        if end < text_len:
            start = end - overlap
        else:
            break

    return chunks
