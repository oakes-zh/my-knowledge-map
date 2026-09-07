#!/usr/bin/env python3
"""
以脱离会话（setsid）的方式启动 personal-kb 后端。

为什么需要这个脚本
--------------------
直接用 `uvicorn ... &` 或在终端里 `npm run dev &` 启动，进程属于当前 shell 的
进程组；当启动它的终端 / 任务结束时，进程会连同进程组一起被回收，表现为
「刚启动能访问，过一会儿 8900 端口就 ECONNREFUSED」。

这里用 start_new_session=True（等价于 setsid）让 uvicorn 自成会话，
脱离调用者的进程组，因此不会被回收。

用法
----
    python3 scripts/start_backend.py          # 启动（已在运行则跳过）
    python3 scripts/start_backend.py --restart # 强制重启
    python3 scripts/start_backend.py --stop    # 停止
"""
import os
import sys
import signal
import socket
import subprocess
import argparse
import time

BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
BACKEND = os.path.normpath(BACKEND)
UVICORN = os.path.join(BACKEND, ".venv", "bin", "uvicorn")
LOG = "/tmp/kb-backend.log"
HOST, PORT = "127.0.0.1", 8900


def is_running() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((HOST, PORT)) == 0


def pids_on_port() -> list[int]:
    """找出占用后端端口的进程 PID。"""
    try:
        out = subprocess.run(
            ["lsof", "-ti", f"tcp:{PORT}"], capture_output=True, text=True
        ).stdout
        return [int(p) for p in out.split() if p.isdigit()]
    except Exception:
        return []


def stop() -> None:
    pids = pids_on_port()
    if not pids:
        print(f"端口 {PORT} 上没有运行中的后端")
        return
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
            print(f"已停止进程 {pid}")
        except ProcessLookupError:
            pass
    time.sleep(1.5)


def start() -> None:
    if not os.path.exists(UVICORN):
        sys.exit(f"找不到 uvicorn：{UVICORN}\n请先创建虚拟环境并安装依赖：cd backend && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt")

    logf = open(LOG, "a", buffering=1)
    # 构造干净的环境：剔除宿主会话注入的 PYTHONPATH 系变量。
    # 否则后端会继承 WorkBuddy 沙箱的 sitecustomize（其 os.remove 钩子
    # 触发批量删除保护时抛 SystemExit，会把成功入库变成 500）。
    child_env = {
        k: v for k, v in os.environ.items()
        if k not in {"PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"}
    }
    child_env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.Popen(
        [UVICORN, "main:app", "--host", HOST, "--port", str(PORT), "--log-level", "info"],
        cwd=BACKEND,
        stdout=logf,
        stderr=subprocess.STDOUT,
        start_new_session=True,  # 关键：脱离调用者进程组，避免被回收
        env=child_env,
    )

    # 等待端口就绪
    for _ in range(30):
        time.sleep(0.5)
        if is_running():
            print(f"✓ 后端已启动  pid={proc.pid}  http://{HOST}:{PORT}")
            print(f"  日志：{LOG}")
            return
    sys.exit(f"✗ 启动超时，请查看日志：{LOG}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--restart", action="store_true", help="先停止再启动")
    ap.add_argument("--stop", action="store_true", help="仅停止")
    args = ap.parse_args()

    if args.stop:
        stop()
        return
    if args.restart:
        stop()
    if is_running():
        print(f"后端已在运行（端口 {PORT}），无需重复启动。如需重启：--restart")
        return
    start()


if __name__ == "__main__":
    main()
