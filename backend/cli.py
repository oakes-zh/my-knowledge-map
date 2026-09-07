"""CLI 命令：kb serve"""
import uvicorn
from pathlib import Path
import logging

from config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def serve():
    """启动 KB 服务"""
    logger.info(f"Starting Personal KB server on {settings.backend_host}:{settings.backend_port}")

    uvicorn.run(
        "main:app",
        host=settings.backend_host,
        port=settings.backend_port,
        reload=True
    )


def init_db():
    """初始化数据库"""
    from storage import init_db
    init_db()
    print("Database initialized successfully!")


if __name__ == "__main__":
    serve()
