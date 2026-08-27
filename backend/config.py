from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    # Dify
    dify_base_url: str = "http://localhost:3000/v1"
    dify_knowledge_api_key: str = ""
    dify_chat_api_key: str = ""
    dify_dataset_id: str = ""

    # Backend
    backend_host: str = "0.0.0.0"
    backend_port: int = 8900

    # LLM
    llm_provider: str = "dify"
    openai_api_key: str = ""
    deepseek_api_key: str = ""

    # OCR
    ocr_engine: str = "paddle"
    ocr_lang: str = "ch"

    # Storage
    upload_dir: str = "./uploads"
    max_file_size_mb: int = 20

    class Config:
        env_file = ".env"


settings = Settings()
UPLOAD_PATH = Path(settings.upload_dir)
UPLOAD_PATH.mkdir(parents=True, exist_ok=True)
