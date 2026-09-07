from pydantic_settings import BaseSettings
from pathlib import Path

# 项目根目录（backend/ 的上一级）下的 .env
# 后端进程从 backend/ 目录启动，pydantic 的相对 env_file 会解析到
# backend/.env（不存在），导致根目录 .env 从未被加载——这里显式指向根目录。
ROOT_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    # Backend
    backend_host: str = "0.0.0.0"
    backend_port: int = 8900

    # LLM（OpenAI 兼容协议，支持 DeepSeek / 智谱 GLM / OpenAI 等）
    # llm_api_key 优先；留空时回退到 deepseek_api_key（兼容旧配置）
    llm_base_url: str = "https://api.deepseek.com/v1"
    llm_model: str = "deepseek-chat"
    llm_api_key: str = ""
    deepseek_api_key: str = ""

    # Embedding (OpenAI 兼容)
    embedding_base_url: str = "https://api.siliconflow.cn/v1"
    embedding_api_key: str = ""
    embedding_model: str = "BAAI/bge-m3"
    embedding_dimensions: int = 512

    # Storage
    kb_db_path: str = "./kb.db"
    chunk_size: int = 512
    chunk_overlap: int = 50

    # File Upload
    upload_dir: str = "./uploads"
    max_file_size_mb: int = 20

    # Frontend
    frontend_dir: str = "./frontend"

    class Config:
        env_file = str(ROOT_ENV_FILE)
        # .env 里允许存在 config 未定义的变量（如历史遗留的 DIFY_*、
        # OCR_* 等），忽略之，避免后端启动即崩
        extra = "ignore"


settings = Settings()
UPLOAD_PATH = Path(settings.upload_dir)
UPLOAD_PATH.mkdir(parents=True, exist_ok=True)
KB_DB_PATH = Path(settings.kb_db_path)
