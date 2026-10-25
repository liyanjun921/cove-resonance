"""Private, read-only Mi Fitness MCP adapter.

This is a deployment scaffold, not a live health integration. Requires a Xiaomi
family-share grant, a server-side token, a relative UID, and client auth.
Never expose this as a public unauthenticated MCP endpoint.
"""
import base64
import dataclasses
import datetime as dt
import enum
import hmac
import json
import os
from pathlib import Path
import tempfile
from typing import Any

import uvicorn
from mi_fitness import MiHealthClient
from mcp.server.fastmcp import FastMCP
from setup import setup_app


MCP_SECRET = os.getenv("HEALTH_MCP_BEARER_TOKEN", "")
RELATIVE_UID = os.getenv("MI_RELATIVE_UID", "").strip()
mcp = FastMCP(
    "XLC Private Mi Fitness Health",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/mcp",
)
_token_path: str | None = None


def _require_day(value: str) -> str:
    if len(value) != 10:
        raise ValueError("Date must use YYYY-MM-DD")
    try:
        return dt.date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise ValueError("Date must use a real YYYY-MM-DD calendar date") from exc


def _token_file() -> str:
    """Resolve a private file without returning credentials to the model."""
    global _token_path
    if _token_path:
        return _token_path
    file_name = os.getenv("MI_TOKEN_FILE", "").strip()
    if file_name:
        path = Path(file_name)
        if not path.is_file():
            raise RuntimeError("Configured token file not found")
        _token_path = str(path)
        return _token_path
    encoded = os.getenv("MI_TOKEN_B64", "").strip()
    if not encoded:
        raise RuntimeError("Mi Fitness login not configured")
    try:
        raw = base64.b64decode(encoded, validate=True)
        json.loads(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("Invalid server-side Mi Fitness token") from exc
    fd, filename = tempfile.mkstemp(prefix="mi-health-", suffix=".json")
    with os.fdopen(fd, "wb") as fh:
        fh.write(raw)
    os.chmod(filename, 0o600)
    _token_path = filename
    return filename


def _serialize(obj: Any) -> Any:
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, (dt.datetime, dt.date, dt.time)):
        return obj.isoformat()
    if isinstance(obj, enum.Enum):
        return _serialize(obj.value)
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return _serialize(dataclasses.asdict(obj))
    if hasattr(obj, "model_dump"):
        return _serialize(obj.model_dump(mode="json"))
    if isinstance(obj, dict):
        return {str(k): _serialize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_serialize(x) for x in obj]
    return str(obj)


async def _query(kind: str, date: str) -> dict[str, Any]:
    day = _require_day(date)
    if not RELATIVE_UID:
        raise RuntimeError("Authorized Mi Fitness relative UID is not configured")
    try:
        relative_uid = int(RELATIVE_UID)
        if relative_uid <= 0:
            raise ValueError()
    except ValueError as exc:
        raise RuntimeError("Configured relative UID must be a positive integer") from exc
    query_date = dt.date.fromisoformat(day)
    token_path = _token_file()
    async with MiHealthClient.from_token(token_path) as client:
        if kind == "sleep":
            records = await client.get_sleep(relative_uid, query_date)
        elif kind == "heart_rate":
            records = await client.get_heart_rate(relative_uid, query_date)
        elif kind == "steps":
            records = await client.get_steps(relative_uid, query_date)
        elif kind == "daily_summary":
            records = await client.get_daily_summary(relative_uid, query_date)
        else:
            raise ValueError("Unsupported data type")
    return {"date": day, "kind": kind, "data": _serialize(records)}


@mcp.tool()
async def get_sleep(date: str) -> dict[str, Any]:
    """Read the consenting relative's synchronized sleep data for YYYY-MM-DD."""
    return await _query("sleep", date)


@mcp.tool()
async def get_heart_rate(date: str) -> dict[str, Any]:
    """Read the consenting relative's synchronized daily heart-rate data."""
    return await _query("heart_rate", date)


@mcp.tool()
async def get_steps(date: str) -> dict[str, Any]:
    """Read the consenting relative's synchronized daily steps and distance."""
    return await _query("steps", date)


@mcp.tool()
async def get_daily_summary(date: str) -> dict[str, Any]:
    """Read the consenting relative's sleep, heart rate and steps summary."""
    return await _query("daily_summary", date)


class PrivateGate:
    """Check a server-side bearer token before every MCP request.

    A real ChatGPT connection must support securely supplying credentials.
    Before that is configured, the health data endpoint remains closed.
    """

    def __init__(self, nested_app):
        self.nested_app = nested_app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            if scope.get("path", "") in ("/setup", "/setup/start", "/setup/status", "/setup/export", "/setup/forget"):
                return await setup_app(scope, receive, send)
            if scope.get("path") == "/healthz":
                payload = json.dumps({
                    "ok": True,
                    "configured": bool(MCP_SECRET and RELATIVE_UID and
                                       (os.getenv("MI_TOKEN_FILE") or os.getenv("MI_TOKEN_B64"))),
                }).encode("utf-8")
                await send({"type": "http.response.start", "status": 200,
                            "headers": [(b"content-type", b"application/json"),
                                        (b"cache-control", b"no-store")]})
                await send({"type": "http.response.body", "body": payload})
                return
            auth = next((v for k, v in scope.get("headers", []) if k.lower() == b"authorization"), b"")
            expected = ("Bearer " + MCP_SECRET).encode("utf-8")
            if not MCP_SECRET or not hmac.compare_digest(auth, expected):
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"application/json"),
                                        (b"cache-control", b"no-store"),
                                        (b"www-authenticate", b"Bearer")]})
                await send({"type": "http.response.body", "body": b'{"error":"unauthorized"}'})
                return
        await self.nested_app(scope, receive, send)


app = PrivateGate(mcp.streamable_http_app())

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")), access_log=False)
