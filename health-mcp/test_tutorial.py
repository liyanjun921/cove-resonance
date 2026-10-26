"""Tutorial HTTP route and private bearer auth without OAuth."""
import asyncio
import json
import unittest
from unittest import mock
from urllib.parse import urlencode
import app as health


async def request(path, token="", query=""):
    sent = []
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}
    async def send(message):
        sent.append(message)
    headers = [(b"authorization", ("Bearer " + token).encode())] if token else []
    await health.app({
        "type":"http", "path":path, "method":"GET",
        "query_string": query.encode(), "headers":headers,
        "server":("localhost",8000), "client":("localhost",8000),
        "scheme":"https", "http_version":"1.1",
    },receive,send)
    return sent


class TutorialRouteTests(unittest.TestCase):
    def test_status_is_private_and_contains_only_availability(self):
        async def fake_status():
            return {"ok": True, "code": "read_succeeded", "available": {
                "sleep": True, "heart_rate": True, "steps": False}}
        with mock.patch.object(health, "MCP_SECRET", "owner-key"), \
             mock.patch.object(health, "check_data_state", side_effect=fake_status):
            denied = asyncio.run(request("/health/status"))
            allowed = asyncio.run(request("/health/status", "owner-key"))
        self.assertEqual(denied[0]["status"], 401)
        self.assertEqual(allowed[0]["status"], 200)
        self.assertEqual(json.loads(allowed[1]["body"])["available"]["steps"], False)
        self.assertIn((b"cache-control", b"no-store"), allowed[0]["headers"])

    def test_no_anonymous_health_read(self):
        with mock.patch.object(health,"MCP_SECRET","owner-key"), mock.patch.object(health,"CHATGPT_SECRET","chatgpt-key"):
            result=asyncio.run(request("/health", query="date=2026-10-26&type=all"))
            self.assertEqual(result[0]["status"],401)

    def test_separate_static_bearer_reads_without_oauth(self):
        async def fake_query(kind, date):
            self.assertEqual(kind,"daily_summary")
            self.assertEqual(date,"2026-10-26")
            return {"kind":kind, "date":date, "data":{"steps":100}}
        with mock.patch.object(health,"MCP_SECRET","owner-key"), mock.patch.object(health,"CHATGPT_SECRET","chatgpt-key"), mock.patch.object(health,"_query",side_effect=fake_query):
            result=asyncio.run(request("/health","chatgpt-key","date=2026-10-26&type=all"))
        self.assertEqual(result[0]["status"],200)
        content=json.loads(result[1]["body"])
        self.assertEqual(content["data"],{"steps":100})
        self.assertNotIn("cache",content)
        self.assertIn((b"cache-control",b"no-store"),result[0]["headers"])

    def test_invalid_parameters(self):
        with mock.patch.object(health,"MCP_SECRET","owner-key"), mock.patch.object(health,"CHATGPT_SECRET",""):
            result=asyncio.run(request("/health","owner-key","date=no&type=all"))
            self.assertEqual(result[0]["status"],400)
            result=asyncio.run(request("/health","owner-key","date=2026-10-26&type=token"))
            self.assertEqual(result[0]["status"],400)

    def test_chatgpt_bearer_not_accepted_when_unset(self):
        with mock.patch.object(health,"MCP_SECRET","owner-key"), mock.patch.object(health,"CHATGPT_SECRET",""):
            result=asyncio.run(request("/health","chatgpt-key","date=2026-10-26&type=all"))
            self.assertEqual(result[0]["status"],401)


if __name__=="__main__":
    unittest.main()
