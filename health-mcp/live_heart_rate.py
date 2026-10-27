"""Read only the owner's configured HypeRate stream; never log credentials."""
import asyncio
import datetime as dt
import json
import logging
import os
import re
from urllib.parse import urlencode

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

_gate = asyncio.Semaphore(1)
_logger = logging.getLogger("xlc.hyperate.private")
_logger.addHandler(logging.NullHandler())
_logger.propagate = False
LOCAL = dt.timezone(dt.timedelta(hours=8))


def _result(status, **fields):
    return {"source": "hyperate_bluetooth", "status": status,
            "queried_at": dt.datetime.now(LOCAL).isoformat(), **fields}


def _parse_sample(message, topic):
    try:
        frame = json.loads(message)
    except (ValueError, TypeError):
        return None
    if not isinstance(frame, dict) or frame.get("topic") != topic:
        return None
    payload = frame.get("payload")
    if not isinstance(payload, dict):
        return None
    if frame.get("event") == "phx_reply" and payload.get("status") == "error":
        return "rejected"
    if frame.get("event") != "hr_update":
        return None
    bpm = payload.get("hr")
    if isinstance(bpm, bool) or not isinstance(bpm, int) or not 1 <= bpm <= 65535:
        return None
    return bpm


async def _read(key, device_id, wait_seconds=15):
    topic = "hr:" + device_id
    url = "wss://app.hyperate.io/socket/websocket?" + urlencode({"token": key})
    async with connect(url, open_timeout=8, close_timeout=2,
                       logger=_logger, max_size=65536) as ws:
        await ws.send(json.dumps({"topic": topic, "event": "phx_join", "payload": {}, "ref": "1"}))
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait_seconds
        while loop.time() < deadline:
            try:
                message = await asyncio.wait_for(ws.recv(), min(8, deadline - loop.time()))
            except TimeoutError:
                if loop.time() >= deadline:
                    break
                await ws.send(json.dumps({"topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": "2"}))
                continue
            bpm = _parse_sample(message, topic)
            if bpm == "rejected":
                return _result("subscription_rejected", bpm=None)
            if bpm is not None:
                received = dt.datetime.now(LOCAL)
                return _result("received", bpm=bpm, received_at=received.isoformat(),
                               sampled_at=None,
                               note="A new stream update was received during this query. "
                                    "Reception time is not sensor measurement time. "
                                    "The provider supplies no verified sample timestamp; "
                                    "end-to-end latency is unknown. Not continuous GPT monitoring.")
    return _result("no_live_sample", bpm=None,
                   note="No new update arrived within the wait window. The phone may not be streaming; do not substitute an old value.")


async def get_live_heart_rate():
    key = os.getenv("HYPERATE_API_KEY", "").strip()
    device_id = os.getenv("HYPERATE_ID", "").strip()
    if not key or not device_id:
        return _result("not_configured", bpm=None)
    if not re.fullmatch(r"[A-Za-z0-9]{1,32}", device_id):
        return _result("invalid_device_configuration", bpm=None)
    try:
        async def bounded():
            async with _gate:
                return await _read(key, device_id)
        return await asyncio.wait_for(bounded(), 27)
    except InvalidStatus as exc:
        status = "authentication_failed" if exc.response.status_code in (401, 403) else "upstream_unavailable"
        return _result(status, bpm=None)
    except TimeoutError:
        return _result("query_timeout", bpm=None)
    except Exception:
        # WebSocket exceptions can include the credential-bearing URL.
        return _result("upstream_unavailable", bpm=None)
