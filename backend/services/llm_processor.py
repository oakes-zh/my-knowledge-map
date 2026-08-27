import httpx
import logging
from config import settings

logger = logging.getLogger(__name__)


async def summarize_text(text: str, max_length: int = 200) -> str:
    """Generate a summary of the text using LLM.

    Uses Dify's completion API or direct OpenAI/DeepSeek API.
    """
    if not text or len(text) < 50:
        return text[:max_length] if text else ""

    provider = settings.llm_provider

    if provider == "dify":
        return await _summarize_via_dify(text, max_length)
    elif provider == "openai":
        return await _summarize_via_openai(text, max_length)
    elif provider == "deepseek":
        return await _summarize_via_deepseek(text, max_length)
    else:
        # Fallback: simple truncation
        return text[:max_length] + "..."


async def auto_tag(text: str, num_tags: int = 5) -> list[str]:
    """Generate tags for the text using LLM."""
    if not text or len(text) < 20:
        return []

    provider = settings.llm_provider

    if provider == "dify":
        return await _tag_via_dify(text, num_tags)
    elif provider == "openai":
        return await _tag_via_openai(text, num_tags)
    elif provider == "deepseek":
        return await _tag_via_deepseek(text, num_tags)
    else:
        return []


async def archive_path(
    text: str = "",
    keywords: list[str] | None = None,
    summary: str = "",
    title: str = "",
    max_levels: int = 4,
    min_levels: int = 3,
) -> list[str]:
    """Induce a 3-4 level HIERARCHICAL archive path via LLM re-semantic induction.

    归档目录 ≠ 文件关键字。文件关键字是扁平的独立属性；归档目录的每一级都是
    模型对文档「主旨/概要」**重新语义归纳**的产物——由浅入深（领域 → 主题 →
    分类 → 具体类别）的层级路径，禁止原样照搬关键字列表。例如
    keywords [发票, 增值税, 报销] → archive path ["财务", "票据", "增值税", "发票"]。

    层级由浅入深、上层术语通用稳定：多篇同类文档会合并进同一分支，整棵树从
    根目录逐渐开枝散叶（宽度由小到大）。

    Returns the LLM-induced levels (top → bottom). On failure returns [] —
    the document is left unarchived (reconciled as 未分类) rather than
    polluting the directory with raw keywords.
    """
    keywords = list(keywords or [])
    if not text and not summary and not keywords and not title:
        return []

    # 主旨/概要 is the primary material; content snippet is secondary
    material = (summary or "").strip() or (title or "").strip() or text[:1200]

    prompt = (
        "你是一名知识库归档专家。请先把握下面文档的「主旨/概要」，再从知识库"
        f"根目录出发，为其设计一条 {min_levels}-{max_levels} 级的归档目录路径"
        "（由浅入深），用于知识图谱的树形归档。\n"
        "要求：\n"
        "1. 每一级都是你对文档主旨的**重新语义归纳**，生成通用化的类别名称，"
        "严禁把文件关键字原样当作归档层级；\n"
        "2. 层级由浅入深：从宽泛的领域/主题开始，逐级具体，最终指向文档所属的"
        "具体类别；\n"
        "3. 靠上的层级必须使用通用、稳定的领域术语（让多篇同类文档合并进同一"
        "分支，整棵树逐渐开枝散叶），避免「其他」「未分类」「杂项」等无意义词；\n"
        "4. 各层级不要重复；\n"
        f"5. 只输出用「 / 」分隔的 {min_levels}-{max_levels} 个层级，不要编号、"
        "不要解释、不要额外内容。\n"
        "示例：财务 / 票据 / 增值税 / 发票\n\n"
        f"文档标题：{title or '（无）'}\n"
        f"文件关键字（仅供参考，不可照搬）：{', '.join(keywords) or '（无）'}\n"
        f"主旨/概要：{(material or '（无）')[:1000]}"
    )

    try:
        provider = settings.llm_provider
        if provider == "dify":
            raw = await _complete_via_dify(prompt, max_tokens=60)
        elif provider == "openai":
            raw = await _complete_via_openai(prompt, max_tokens=60)
        elif provider == "deepseek":
            raw = await _complete_via_deepseek(prompt, max_tokens=60)
        else:
            return []

        # Parse levels: tolerate / ／ 、 → \n as separators
        for sep in ("／", "→", "、", "，", "\n", ">"):
            raw = raw.replace(sep, "/")
        raw_levels = [l.strip(" 　·.-•") for l in raw.split("/") if l.strip()]
        raw_levels = [l for l in raw_levels if l and l not in ("：", ":", "-", "—")]

        # Dedupe (preserving order) and cap at max_levels — but never inject
        # raw keywords: the directory is the LLM's re-semantic induction.
        levels: list[str] = []
        for l in raw_levels:
            if l not in levels:
                levels.append(l)
        levels = levels[:max_levels]

        return levels
    except Exception as e:
        logger.error(f"Archive path induction failed: {e}")
        return []


async def _complete_via_dify(prompt: str, max_tokens: int = 60) -> str:
    url = f"{settings.dify_base_url.rstrip('/')}/chat-messages"
    headers = {"Authorization": f"Bearer {settings.dify_chat_api_key}"}
    payload = {
        "inputs": {},
        "query": prompt,
        "response_mode": "blocking",
        "user": "system",
    }
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        return data.get("answer", "")


async def _complete_via_openai(prompt: str, max_tokens: int = 60) -> str:
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": "你是知识库归档助手，只输出归档路径层级。"},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tokens,
    }
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


async def _complete_via_deepseek(prompt: str, max_tokens: int = 60) -> str:
    url = "https://api.deepseek.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.deepseek_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "deepseek-chat",
        "messages": [
            {"role": "system", "content": "你是知识库归档助手，只输出归档路径层级。"},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tokens,
    }
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


async def _summarize_via_dify(text: str, max_length: int) -> str:
    try:
        url = f"{settings.dify_base_url.rstrip('/')}/chat-messages"
        headers = {"Authorization": f"Bearer {settings.dify_chat_api_key}"}
        payload = {
            "inputs": {},
            "query": f"请对以下内容进行中文摘要，控制在{max_length}字以内：\n\n{text[:4000]}",
            "response_mode": "blocking",
            "user": "system",
        }
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return data.get("answer", text[:max_length])
    except Exception as e:
        logger.error(f"Dify summarize failed: {e}")
        return text[:max_length] + "..."


async def _tag_via_dify(text: str, num_tags: int) -> list[str]:
    try:
        url = f"{settings.dify_base_url.rstrip('/')}/chat-messages"
        headers = {"Authorization": f"Bearer {settings.dify_chat_api_key}"}
        payload = {
            "inputs": {},
            "query": f"为以下内容生成{num_tags}个中文语义关键词标签，用逗号分隔，不要编号：\n\n{text[:4000]}",
            "response_mode": "blocking",
            "user": "system",
        }
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            answer = data.get("answer", "")
            # Split by both Chinese and English commas
            raw = answer.replace("\n", ",").replace("，", ",")
            tags = [t.strip() for t in raw.split(",") if t.strip()]
            return tags[:num_tags]
    except Exception as e:
        logger.error(f"Dify tagging failed: {e}")
        return []


async def _summarize_via_openai(text: str, max_length: int) -> str:
    try:
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {settings.openai_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": f"Summarize the text in Chinese within {max_length} characters."},
                {"role": "user", "content": text[:4000]},
            ],
            "max_tokens": max_length,
        }
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]
    except Exception as e:
        logger.error(f"OpenAI summarize failed: {e}")
        return text[:max_length] + "..."


async def _tag_via_openai(text: str, num_tags: int) -> list[str]:
    try:
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {settings.openai_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": f"Generate {num_tags} tags in Chinese. Return only comma-separated tags."},
                {"role": "user", "content": text[:4000]},
            ],
            "max_tokens": 100,
        }
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            answer = data["choices"][0]["message"]["content"]
            tags = [t.strip() for t in answer.replace("\n", ",").split(",") if t.strip()]
            return tags[:num_tags]
    except Exception as e:
        logger.error(f"OpenAI tagging failed: {e}")
        return []


async def _summarize_via_deepseek(text: str, max_length: int) -> str:
    try:
        url = "https://api.deepseek.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {settings.deepseek_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": "deepseek-chat",
            "messages": [
                {"role": "system", "content": f"Summarize the text in Chinese within {max_length} characters."},
                {"role": "user", "content": text[:4000]},
            ],
            "max_tokens": max_length,
        }
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]
    except Exception as e:
        logger.error(f"DeepSeek summarize failed: {e}")
        return text[:max_length] + "..."


async def _tag_via_deepseek(text: str, num_tags: int) -> list[str]:
    try:
        url = "https://api.deepseek.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {settings.deepseek_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": "deepseek-chat",
            "messages": [
                {"role": "system", "content": f"Generate {num_tags} tags in Chinese. Return only comma-separated tags."},
                {"role": "user", "content": text[:4000]},
            ],
            "max_tokens": 100,
        }
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            answer = data["choices"][0]["message"]["content"]
            tags = [t.strip() for t in answer.replace("\n", ",").split(",") if t.strip()]
            return tags[:num_tags]
    except Exception as e:
        logger.error(f"DeepSeek tagging failed: {e}")
        return []
