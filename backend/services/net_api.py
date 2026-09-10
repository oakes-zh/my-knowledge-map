"""网络层弹性请求助手。

httpx 的 trust_env 决定是否读取环境代理变量（HTTP_PROXY / HTTPS_PROXY …）。
真实机器上的常见故障：后端继承了一个**已经失效的代理**（例如 WorkBuddy 沙箱临时
注入的 5xxxx 端口代理，会话结束后即不可达），导致所有出去的 LLM / Embedding 请求
抛 `All connection attempts failed`——表现为「入库成功但 LLM 标签/摘要/向量全空」。

解决思路：先按环境代理发起请求（trust_env=True，覆盖系统代理/显式代理）；
若因连接类错误失败，再回退到直连（trust_env=False）重试一次。
这样无论走 Clash、显式代理还是国内直连，至少有一条路能通。
"""
import httpx

logger = __import__("logging").getLogger(__name__)


async def post_json(
    url: str,
    *,
    headers: dict,
    json: dict,
    timeout: int = 60,
) -> dict:
    """POST JSON，先走环境代理，连接失败再回退直连。返回解析后的 JSON。"""
    last_err: Exception | None = None
    for trust_env in (True, False):
        try:
            async with httpx.AsyncClient(timeout=timeout, trust_env=trust_env) as client:
                resp = await client.post(url, headers=headers, json=json)
                resp.raise_for_status()
                return resp.json()
        except httpx.TransportError as e:
            # 连接性/超时等传输层错误：视作代理不通，回退下一个策略。
            last_err = e
            logger.debug(
                "网络请求失败 trust_env=%s 将重试：%s (%s)",
                trust_env, url, type(e).__name__,
            )
            continue
        except httpx.HTTPStatusError:
            # 认证/业务错误（4xx/5xx）是"连上了但被拒"，重试直连没有意义，直接抛出。
            raise
    raise last_err  # type: ignore[misc]
