import logging
from typing import Optional
from config import settings

logger = logging.getLogger(__name__)


async def extract_text_from_image(file_path: str) -> str:
    """Extract text from an image using configured OCR engine."""
    engine = settings.ocr_engine

    if engine == "paddle":
        try:
            from paddleocr import PaddleOCR

            ocr = PaddleOCR(use_angle_cls=True, lang=settings.ocr_lang, show_log=False)
            result = ocr.ocr(file_path, cls=True)
            texts = []
            for line in result[0] if result else []:
                if line and len(line) >= 2:
                    texts.append(line[1][0])
            return "\n".join(texts)
        except ImportError:
            logger.warning("PaddleOCR not installed, falling back to tesseract")
            engine = "tesseract"

    if engine == "tesseract":
        try:
            import pytesseract
            from PIL import Image

            img = Image.open(file_path)
            return pytesseract.image_to_string(img, lang=settings.ocr_lang)
        except ImportError:
            logger.error("Neither PaddleOCR nor pytesseract is installed")
            return ""

    return ""


async def detect_pdf_type(file_path: str) -> str:
    """Detect whether a PDF is text-based or image-based (scanned).

    Heuristic:
    - For each page, compute text_ratio = text_char_count / (page_area_in_pts * 0.01)
    - If average text_ratio across pages > threshold → 'text'
    - Otherwise → 'image' (needs OCR)
    """
    try:
        import fitz

        doc = fitz.open(file_path)
        total_chars = 0
        total_area = 0.0
        pages_with_images = 0
        num_pages = len(doc)

        for page in doc:
            text = page.get_text().strip()
            total_chars += len(text)
            rect = page.rect
            total_area += rect.width * rect.height
            if page.get_images(full=True):
                pages_with_images += 1

        doc.close()

        if num_pages == 0:
            return "text"

        # Heuristic 1: very little text per page → scanned
        avg_chars_per_page = total_chars / num_pages
        if avg_chars_per_page < 30:
            return "image"

        # Heuristic 2: most pages have images but almost no text → scanned
        image_page_ratio = pages_with_images / num_pages
        if image_page_ratio > 0.8 and avg_chars_per_page < 100:
            return "image"

        # Otherwise assume text PDF
        return "text"

    except Exception as e:
        logger.error(f"PDF type detection failed: {e}")
        return "text"  # default fallback


async def extract_text_from_pdf(file_path: str) -> tuple[str, str]:
    """Extract text from PDF. Returns (text, pdf_type).

    Auto-routes: text PDF → direct extraction, image PDF → OCR each page.
    """
    try:
        import fitz  # PyMuPDF

        pdf_type = await detect_pdf_type(file_path)

        if pdf_type == "text":
            doc = fitz.open(file_path)
            texts = []
            for page in doc:
                texts.append(page.get_text())
            doc.close()
            return "\n\n".join(texts), pdf_type

        # Image PDF: render each page as image → OCR
        doc = fitz.open(file_path)
        ocr_texts = []
        for page_num in range(len(doc)):
            page = doc[page_num]
            # Render at 200 DPI for good OCR quality
            pix = page.get_pixmap(matrix=fitz.Matrix(200 / 72, 200 / 72))
            img_path = file_path + f"_page_{page_num}.png"
            pix.save(img_path)

            # OCR the rendered page
            ocr_result = await extract_text_from_image(img_path)
            if ocr_result.strip():
                ocr_texts.append(ocr_result)

            # Clean up temp image
            import os
            try:
                os.remove(img_path)
            except:
                pass

        doc.close()
        return "\n\n".join(ocr_texts), pdf_type

    except Exception as e:
        logger.error(f"PDF extraction failed: {e}")
        return "", "text"


async def extract_text_from_docx(file_path: str) -> str:
    """Extract text from .docx files."""
    try:
        from docx import Document

        doc = Document(file_path)
        return "\n\n".join(para.text for para in doc.paragraphs if para.text.strip())
    except ImportError:
        logger.warning("python-docx not installed, trying basic extraction")
        return ""
    except Exception as e:
        logger.error(f"DOCX extraction failed: {e}")
        return ""


async def extract_text_from_doc(file_path: str) -> str:
    """Extract text from legacy .doc (Word 97-2003) files via antiword."""
    import subprocess, shutil

    if not shutil.which("antiword"):
        logger.error("antiword not installed, cannot parse .doc files")
        return ""
    try:
        result = subprocess.run(
            ["antiword", file_path],
            capture_output=True,
            text=True,
            timeout=30,
        )
        text = result.stdout.strip()
        if not text and result.stderr:
            logger.warning(f"antiword stderr: {result.stderr}")
        return text
    except Exception as e:
        logger.error(f"DOC extraction failed: {e}")
        return ""


async def extract_text(file_path: str, file_type: str) -> tuple[str, str]:
    """Route to the correct extraction function based on file type.

    Returns (text, pdf_type) where pdf_type is 'text'/'image' for PDFs,
    or '' for non-PDF files.
    """
    file_type = file_type.lower()

    if file_type in ("png", "jpg", "jpeg", "gif", "bmp", "webp"):
        text = await extract_text_from_image(file_path)
        return text, ""
    elif file_type == "pdf":
        return await extract_text_from_pdf(file_path)
    elif file_type == "docx":
        text = await extract_text_from_docx(file_path)
        return text, ""
    elif file_type == "doc":
        text = await extract_text_from_doc(file_path)
        return text, ""
    elif file_type in ("txt", "md"):
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read(), ""
    else:
        logger.warning(f"Unsupported file type: {file_type}")
        return "", ""
