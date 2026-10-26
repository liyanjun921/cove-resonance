"""Integration tests for consent and one-time screenshot semantics. No Xiaomi or music APIs."""
import asyncio
import io
import json
import os
import sys
import time
import unittest
from pathlib import Path

os.environ["SNAPSHOT_OWNER_SECRET"] = "test_owner_" + "A" * 40
os.environ["SNAPSHOT_MCP_TOKEN"] = "test_mcp_" + "B" * 40
os.environ["SNAPSHOT_SESSION_SECRET"] = "test_session_" + "C" * 40
sys.path.insert(0, str(Path(__file__).parent))
import app as s
from PIL import Image


async def http(path, method="GET", body=b"", extra_headers=None):
    received = False
    messages = []

    async def receive():
        nonlocal received
        if received:
            return {"type": "http.disconnect"}
        received = True
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        messages.append(message)

    headers = [(b"host", b"example.onrender.com"),
               (b"origin", b"https://example.onrender.com")]
    if extra_headers:
        headers.extend((k.lower().encode(), v.encode()) for k, v in extra_headers.items())
    scope = {"type": "http", "path": path, "method": method,
             "query_string": b"", "headers": headers}
    await s.app(scope, receive, send)
    status = messages[0]["status"]
    text = messages[1]["body"]
    try:
        data = json.loads(text)
    except ValueError:
        data = text
    return status, data, messages[0]["headers"]


def img_bytes():
    im = Image.new("RGB", (60, 40), "#ffc9df")
    stream = io.BytesIO()
    im.save(stream, "JPEG")
    return stream.getvalue()


class ScreenshotTests(unittest.TestCase):
    def setUp(self):
        s.REQUESTS.clear()
        s.SUBSCRIPTIONS.clear()
        s.LOGIN_ATTEMPTS.clear()

    def test_tool_discovery_advertises_oauth_without_auth(self):
        tools = asyncio.run(s._list_tools())
        self.assertEqual(
            {tool.name for tool in tools},
            {"request_screen_snapshot", "get_screen_snapshot_status", "read_approved_screen_snapshot"},
        )
        for tool in tools:
            serialized = json.dumps(tool.model_dump(mode="json", by_alias=True))
            self.assertIn('"type": "oauth2"', serialized)
            self.assertIn("snapshot:request", serialized)
            self.assertIn("snapshot:read", serialized)

    def test_unauthorized_tool_call_returns_mcp_auth_challenge(self):
        from types import SimpleNamespace
        request = SimpleNamespace(params=SimpleNamespace(
            name="request_screen_snapshot",
            arguments={"reason": "请授权一张截图"},
        ))
        result = asyncio.run(s._call_tool_request(request))
        serialized = json.dumps(result.model_dump(mode="json", by_alias=True))
        self.assertIn("mcp/www_authenticate", serialized)
        self.assertIn("/.well-known/oauth-protected-resource/mcp", serialized)
        self.assertNotIn("request_id", serialized)

    def test_login_requires_secret_and_origin(self):
        payload = json.dumps({"secret":os.environ["SNAPSHOT_OWNER_SECRET"]}).encode()
        code, _, _ = asyncio.run(http("/api/login", "POST", json.dumps({"secret":"bad"}).encode()))
        self.assertEqual(code, 403)
        code, data, headers = asyncio.run(http("/api/login", "POST", payload))
        self.assertEqual(code, 200)
        self.assertTrue(data["ok"])
        self.assertTrue(any(k == b"set-cookie" for k, _ in headers))

    def test_pending_deny_and_no_image(self):
        response = asyncio.run(s.request_screen_snapshot("你愿意给我看一下屏幕吗？"))
        rid = response["request_id"]
        self.assertEqual(response["status"], "pending")
        self.assertEqual(asyncio.run(s.get_screen_snapshot_status(rid))["status"], "pending")
        details = asyncio.run(s.read_approved_screen_snapshot(rid))
        self.assertIn("pending", details[0].text)

    def test_expiry_removes_temp_file(self):
        response = asyncio.run(s.request_screen_snapshot("请你选择愿意分享的一张截图"))
        rid = response["request_id"]
        path = Path(__file__).parent / "test-expiring.jpg"
        path.write_bytes(img_bytes())
        try:
            s.REQUESTS[rid].path = str(path)
            s.REQUESTS[rid].state = "fulfilled"
            s.REQUESTS[rid].created -= 601
            s.cleanup()
            self.assertFalse(path.exists())
            self.assertEqual(s.REQUESTS[rid].state, "expired")
        finally:
            path.unlink(missing_ok=True)

    def test_owner_only_approve_and_one_read(self):
        rid = asyncio.run(s.request_screen_snapshot("想看一张你亲自确认的截图"))["request_id"]
        unauth, _, _ = asyncio.run(http("/api/requests/" + rid + "/prepare",
                                         "POST", b"", {"x-snapshot-action":"1"}))
        self.assertEqual(unauth, 401)

        login_payload = json.dumps({"secret":os.environ["SNAPSHOT_OWNER_SECRET"]}).encode()
        code, _, headers = asyncio.run(http("/api/login","POST",login_payload))
        self.assertEqual(code, 200)
        cookie = next(v.decode().split(";", 1)[0]
                      for k,v in headers if k == b"set-cookie")
        authorized = {"cookie":cookie, "x-snapshot-action":"1"}
        code, data, _ = asyncio.run(http("/api/requests/" + rid + "/prepare",
                                          "POST", b"", authorized))
        self.assertEqual(code, 200)
        ticket = data["upload_ticket"]
        image = img_bytes()
        bad = dict(authorized, **{"content-type":"image/jpeg","x-upload-ticket":"wrong"})
        code, _, _ = asyncio.run(http("/api/requests/" + rid + "/upload","POST",image,bad))
        self.assertEqual(code,409)
        good = dict(authorized,**{"content-type":"image/jpeg","x-upload-ticket":ticket})
        code, data, _ = asyncio.run(http("/api/requests/" + rid + "/upload","POST",image,good))
        self.assertEqual(code,200)
        self.assertEqual(data["status"],"fulfilled")
        file_path = s.REQUESTS[rid].path
        self.assertTrue(Path(file_path).exists())
        first = asyncio.run(s.read_approved_screen_snapshot(rid))
        self.assertEqual(first[1].type, "image")
        self.assertFalse(Path(file_path).exists())
        second = asyncio.run(s.read_approved_screen_snapshot(rid))
        self.assertNotEqual(len(second),2)
        self.assertIn("viewed",second[0].text)

if __name__ == "__main__":
    unittest.main()
