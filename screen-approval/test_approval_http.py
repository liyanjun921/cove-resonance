"""Exercise the real public-host MCP transport and per-request approval boundary."""
import asyncio
import base64
import io
import json
import os
import unittest

os.environ.setdefault("SNAPSHOT_OWNER_SECRET", "test_owner_" + "A" * 40)
os.environ.setdefault("SNAPSHOT_SESSION_SECRET", "test_session_" + "C" * 40)
import app as s
import httpx
from PIL import Image


class ApprovalHTTPTests(unittest.TestCase):
    def test_approval_capability_and_single_image_read(self):
        async def run():
            s.REQUESTS.clear()
            s.SUBSCRIPTIONS.clear()
            origin = "https://xlc-consent-snapshot.onrender.com"
            async with s.mcp.session_manager.run():
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=s.app), base_url=origin) as c:
                    async def rpc(method, params):
                        r = await c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                                         headers={"Accept": "application/json, text/event-stream"})
                        self.assertEqual(r.status_code, 200)
                        return r.json()["result"]

                    await rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})
                    tools = await rpc("tools/list", {})
                    self.assertEqual(len(tools["tools"]), 3)
                    async def call(name, args):
                        return await rpc("tools/call", {"name": name, "arguments": args})
                    r = await call("request_screen_snapshot", {"reason": "Approve this test screenshot"})
                    request = r["structuredContent"]
                    rid, token = request["request_id"], request["access_token"]
                    self.assertNotEqual(token, s.REQUESTS[rid].capability_hash)
                    credentials = {"request_id": rid, "access_token": token}
                    for args in ({"request_id": rid}, {"request_id": rid, "access_token": "bad" * 16}):
                        self.assertTrue((await call("read_approved_screen_snapshot", args))["isError"])
                    pending = await call("read_approved_screen_snapshot", credentials)
                    self.assertFalse(any(x["type"] == "image" for x in pending["content"]))
                    self.assertIn("pending", pending["content"][0]["text"])
                    other = (await call("request_screen_snapshot", {"reason": "Another separate request"}))["structuredContent"]
                    self.assertTrue((await call("read_approved_screen_snapshot", {"request_id": rid, "access_token": other["access_token"]}))["isError"])
                    action = {"Origin": origin, "X-Snapshot-Action": "1"}
                    self.assertEqual((await c.post(f"/api/requests/{rid}/prepare", headers=action)).status_code, 401)
                    login = await c.post("/api/login", json={"secret": s.OWNER_SECRET}, headers={"Origin": origin})
                    self.assertEqual(login.status_code, 200)
                    listing = (await c.get("/api/requests")).json()
                    self.assertEqual(listing["requests"][0]["approval_code"], request["approval_code"])
                    self.assertNotIn(token, json.dumps(listing))
                    ticket = (await c.post(f"/api/requests/{rid}/prepare", headers=action)).json()["upload_ticket"]
                    data = io.BytesIO()
                    Image.new("RGB", (20, 20), "blue").save(data, "JPEG")
                    upload = await c.post(f"/api/requests/{rid}/upload", content=data.getvalue(),
                                          headers={**action, "Content-Type": "image/jpeg", "X-Upload-Ticket": ticket})
                    self.assertEqual(upload.status_code, 200)
                    # PWA cookie alone does not grant MCP read access.
                    self.assertTrue((await call("read_approved_screen_snapshot", {"request_id": rid}))["isError"])
                    first = await call("read_approved_screen_snapshot", credentials)
                    self.assertEqual(sum(x["type"] == "image" for x in first["content"]), 1)
                    self.assertIsNone(s.REQUESTS[rid].path)
                    second = await call("read_approved_screen_snapshot", credentials)
                    self.assertFalse(any(x["type"] == "image" for x in second["content"]))
                    s.REQUESTS[other["request_id"]].created -= 601
                    self.assertTrue((await call("get_screen_snapshot_status", {"request_id": other["request_id"], "access_token": other["access_token"]}))["isError"])
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
