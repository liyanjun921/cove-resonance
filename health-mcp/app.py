"""Private, read-only Mi Fitness MCP adapter.

This is a deployment scaffold, not a live health integration. Requires a Xiaomi
family-share grant, a server-side token, a relative UID, and client auth.
Public read-only MCP access is opt-in with HEALTH_PUBLIC_READ_ONLY=true.
"""
import asyncio
import dataclasses
import datetime as dt
import enum
import hmac
import json
import os
from pathlib import Path
import tempfile
from typing import Any
from urllib.parse import parse_qs

import uvicorn
from mi_fitness import MiHealthClient
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from setup import check_data_state, setup_app
from token_codec import parse_token


MCP_SECRET = os.getenv("HEALTH_MCP_BEARER_TOKEN", "")
CHATGPT_SECRET = os.getenv("HEALTH_CHATGPT_TOKEN", "")
PUBLIC_READ_ONLY = os.getenv("HEALTH_PUBLIC_READ_ONLY", "false").lower() == "true"
RELATIVE_UID = os.getenv("MI_RELATIVE_UID", "").strip()
mcp = FastMCP(
    "XLC Private Mi Fitness Health",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/mcp",
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["xlc-mi-fitness-health-mcp.onrender.com",
                       "localhost:*", "127.0.0.1:*"],
        allowed_origins=["https://chatgpt.com", "https://www.chatgpt.com",
                         "http://localhost:*", "http://127.0.0.1:*"],
    ),
)
_token_path: str | None = None
# The integration queries modern Mi Fitness records in UTC+08:00, as the SDK does.
DISPLAY_TIMEZONE = dt.timezone(dt.timedelta(hours=8))
# This source's latest_hr.time was checked against the owner's Mi Fitness app.
# Scope the interpretation to this field; other metrics retain their encoding.
HEART_RATE_TIME_ENCODING = os.getenv("MI_HEART_RATE_TIME_ENCODING", "local_wall_clock")
if HEART_RATE_TIME_ENCODING not in {"local_wall_clock", "unix_seconds"}:
    raise ValueError("Unsupported MI_HEART_RATE_TIME_ENCODING")


def _timestamp_details(value: Any, now: dt.datetime,
                       encoding: str = "unix_seconds") -> dict[str, Any]:
    """Preserve raw time and explicitly report any source-specific correction."""
    result = {"raw": value, "unit": "seconds", "source_encoding": encoding}
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return {**result, "status": "missing_or_invalid"}
    try:
        instant = dt.datetime.fromtimestamp(value, tz=dt.timezone.utc)
        if encoding == "local_wall_clock":
            # Provider encoded local clock components as if they were UTC.
            instant = instant.replace(tzinfo=DISPLAY_TIMEZONE).astimezone(dt.timezone.utc)
            result["offset_correction_seconds"] = -28800
    except (OverflowError, OSError, ValueError):
        return {**result, "status": "out_of_range"}
    age = int((now - instant).total_seconds())
    return {**result, "unix_seconds": int(instant.timestamp()), "utc": instant.isoformat(),
            "local": instant.astimezone(DISPLAY_TIMEZONE).isoformat(),
            "age_seconds": age,
            "status": "future" if instant > now else "at_or_before_query"}


def _time_metadata(data: Any, now: dt.datetime) -> dict[str, Any]:
    """Separate daily buckets from sample times without exposing extra records."""
    timestamps = {}

    def visit(value, path):
        if isinstance(value, dict):
            for key, child in value.items():
                child_path = f"{path}.{key}"
                if key in {"time", "bedtime", "wake_up_time"}:
                    encoding = HEART_RATE_TIME_ENCODING if child_path.endswith(".latest_hr.time") else "unix_seconds"
                    timestamps[child_path] = _timestamp_details(child, now, encoding)
                else:
                    visit(child, child_path)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, f"{path}[{index}]")

    visit(data, "data")
    return {"timezone": "Asia/Shanghai", "queried_at_utc": now.isoformat(),
            "queried_at_local": now.astimezone(DISPLAY_TIMEZONE).isoformat(),
            "timestamps": timestamps,
            "note": "Data timestamps remain raw provider values. Use normalized "
                    "time_metadata.timestamps for displayed sample times and ages. "
                    "Heart-rate daily time is a bucket label, not a sample or sync time. "
                    "latest_hr.time uses the configured source encoding, confirmed "
                    "against the owner's Mi Fitness app for this integration. "
                    "Query time is not sync time. Future timestamps are unverified; "
                    "do not report them as current readings."}


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
    raw, token_code = parse_token(encoded)
    if raw is None:
        raise RuntimeError("Invalid server-side Mi Fitness token: " + token_code)
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
    data = _serialize(records)
    return {"date": day, "kind": kind, "data": data,
            "time_metadata": _time_metadata(data, dt.datetime.now(dt.timezone.utc))}


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



async def _health_http(scope, receive, send):
    """Tutorial-compatible GET /health?date=YYYY-MM-DD&type=all.

    Health readings are protected by the same bearer check as /mcp.
    No account ID or credentials are accepted through query parameters.
    """
    status = 200
    params = parse_qs(scope.get("query_string", b"").decode("ascii", "replace"))
    day = params.get("date", [""])[0]
    kind = params.get("type", ["all"])[0]
    kind_map = {"all": "daily_summary", "sleep": "sleep",
                "heart_rate": "heart_rate", "steps": "steps"}
    try:
        if kind not in kind_map:
            raise ValueError("unsupported type")
        result = await asyncio.wait_for(_query(kind_map[kind], day), timeout=35)
        body = json.dumps({"ok": True, **result}, ensure_ascii=False).encode("utf-8")
    except ValueError:
        status = 400
        body = b'{"ok":false,"error":"invalid_date_or_type"}'
    except (TimeoutError, Exception):
        # No raw provider errors or private health data in error responses.
        status = 502
        body = b'{"ok":false,"error":"provider_unavailable"}'
    await send({"type":"http.response.start","status":status,"headers":[
        (b"content-type",b"application/json; charset=utf-8"),
        (b"cache-control",b"no-store"),
        (b"x-content-type-options",b"nosniff"),
    ]})
    await send({"type":"http.response.body","body":body})


async def _private_status(send):
    """Authenticated diagnostics: permission and availability flags only."""
    result = await check_data_state()
    body = json.dumps(result, ensure_ascii=False).encode("utf-8")
    await send({"type": "http.response.start", "status": 200,
                "headers": [(b"content-type", b"application/json; charset=utf-8"),
                            (b"cache-control", b"no-store"),
                            (b"x-content-type-options", b"nosniff")]})
    await send({"type": "http.response.body", "body": body})


class PrivateGate:
    """Check a server-side bearer token before every MCP request.

    A real ChatGPT connection must support securely supplying credentials.
    Before that is configured, the health data endpoint remains closed.
    """

    def __init__(self, nested_app):
        self.nested_app = nested_app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            if scope.get("path", "") in ("/setup", "/setup/start", "/setup/status", "/setup/export", "/setup/forget", "/setup/check-data"):
                return await setup_app(scope, receive, send)
            if scope.get("path") == "/healthz":
                payload = json.dumps({
                    "ok": True,
                    "time_format_version": 2,
                    "timezone": "Asia/Shanghai",
                    "server_time": dt.datetime.now(DISPLAY_TIMEZONE).isoformat(),
                    "configured": bool(MCP_SECRET and RELATIVE_UID and
                                       (os.getenv("MI_TOKEN_FILE") or os.getenv("MI_TOKEN_B64"))),
                }).encode("utf-8")
                await send({"type": "http.response.start", "status": 200,
                            "headers": [(b"content-type", b"application/json"),
                                        (b"cache-control", b"no-store")]})
                await send({"type": "http.response.body", "body": payload})
                return
            # Owner-authorized public access applies only to the read-only MCP.
            # Setup, HTTP reads and diagnostics retain their existing authentication.
            if PUBLIC_READ_ONLY and scope.get("path") == "/mcp":
                return await self.nested_app(scope, receive, send)
            auth = next((v for k, v in scope.get("headers", []) if k.lower() == b"authorization"), b"")
            valid_keys = [key for key in (MCP_SECRET, CHATGPT_SECRET) if key]
            allowed = any(hmac.compare_digest(auth, ("Bearer " + key).encode("utf-8"))
                          for key in valid_keys)
            if not allowed:
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"application/json"),
                                        (b"cache-control", b"no-store"),
                                        (b"www-authenticate", b"Bearer")]})
                await send({"type": "http.response.body", "body": b'{"error":"unauthorized"}'})
                return
            if scope.get("path") == "/health" and scope.get("method") == "GET":
                return await _health_http(scope, receive, send)
            if scope.get("path") == "/health/status" and scope.get("method") == "GET":
                return await _private_status(send)
        await self.nested_app(scope, receive, send)


app = PrivateGate(mcp.streamable_http_app())

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")), access_log=False)
