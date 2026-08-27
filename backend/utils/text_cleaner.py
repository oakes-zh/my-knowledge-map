import re


def clean_text(text: str) -> str:
    """Clean and normalize extracted text."""
    if not text:
        return ""

    # Remove excessive whitespace
    lines = [line.strip() for line in text.split("\n")]
    text = "\n".join(line for line in lines if line)

    # Remove control characters (keep newlines and tabs)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)

    # Collapse multiple spaces
    text = re.sub(r"[ \t]+", " ", text)

    # Collapse 3+ newlines to 2
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()


def truncate_for_preview(text: str, max_chars: int = 500) -> str:
    """Truncate text for preview display."""
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "..."


def get_file_extension(filename: str) -> str:
    """Get lowercase file extension without the dot."""
    import os

    _, ext = os.path.splitext(filename)
    return ext.lstrip(".").lower()
