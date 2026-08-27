import httpx
import logging
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)


async def fetch_url_content(url: str) -> dict:
    """Fetch and extract main content from a URL.

    Returns:
        dict with keys: title, content, url
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    }

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            html = resp.text

        soup = BeautifulSoup(html, "lxml")

        # Remove noise
        for tag in soup.find_all(["script", "style", "nav", "footer", "aside", "iframe"]):
            tag.decompose()

        title = soup.find("title")
        title_text = title.get_text(strip=True) if title else url

        # Try to find main content area
        main = soup.find("main") or soup.find("article") or soup.find("div", class_="content")
        if main:
            content = main.get_text(separator="\n", strip=True)
        else:
            content = soup.get_text(separator="\n", strip=True)

        # Clean up excessive whitespace
        lines = [line.strip() for line in content.split("\n") if line.strip()]
        content = "\n".join(lines)

        return {
            "title": title_text,
            "content": content,
            "url": url,
        }

    except Exception as e:
        logger.error(f"URL fetch failed for {url}: {e}")
        return {
            "title": url,
            "content": "",
            "url": url,
        }
