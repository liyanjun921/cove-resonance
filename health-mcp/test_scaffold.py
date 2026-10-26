"""Offline tests: no Xiaomi account or medical data needed."""
import asyncio
import datetime as dt
import unittest
from unittest import mock
import app as health


class FakeClient:
    async def __aenter__(self):
        return self
    async def __aexit__(self, exc_type, exc, tb):
        return False
    async def get_sleep(self, uid, when):
        assert type(uid) is int and uid == 12345, (type(uid), uid)
        assert type(when) is dt.date and when == dt.date(2026, 10, 26), (type(when), when)
        return [{"minutes": 420}]


class ScaffoldTests(unittest.TestCase):
    def test_public_mcp_host_is_explicitly_allowed(self):
        security = health.mcp.settings.transport_security
        self.assertTrue(security.enable_dns_rebinding_protection)
        self.assertIn("xlc-mi-fitness-health-mcp.onrender.com", security.allowed_hosts)
        self.assertNotIn("*", security.allowed_hosts)

    def test_public_mode_only_bypasses_mcp(self):
        async def check(path, public):
            nested = mock.AsyncMock()
            send = mock.AsyncMock()
            with mock.patch.object(health, "PUBLIC_READ_ONLY", public):
                await health.PrivateGate(nested)({"type": "http", "path": path, "headers": [], "method": "GET"}, mock.AsyncMock(), send)
            return nested, send
        for path, public, allowed in [("/mcp", True, True), ("/mcp", False, False), ("/health", True, False), ("/health/status", True, False), ("/mcp/other", True, False)]:
            nested, send = asyncio.run(check(path, public))
            self.assertEqual(nested.await_count, int(allowed))
            if not allowed:
                self.assertEqual(send.call_args_list[0].args[0]["status"], 401)

    def test_date_validation(self):
        self.assertEqual(health._require_day("2026-10-26"), "2026-10-26")
        for bad in ["2026-02-30", "tomorrow", "2026/10/26", "2026-10-26 extra"]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                health._require_day(bad)

    def test_sleep_uses_real_sdk_types(self):
        with (
            mock.patch.object(health, "RELATIVE_UID", "12345"),
            mock.patch.object(health, "_token_file", return_value="/not-read"),
            mock.patch.object(health.MiHealthClient, "from_token", return_value=FakeClient()),
        ):
            result = asyncio.run(health._query("sleep", "2026-10-26"))
        self.assertEqual(result, {
            "date": "2026-10-26",
            "kind": "sleep",
            "data": [{"minutes": 420}],
        })

    def test_non_numeric_relative_uid_rejected(self):
        with mock.patch.object(health, "RELATIVE_UID", "not-a-number"):
            with self.assertRaisesRegex(RuntimeError, "positive integer"):
                asyncio.run(health._query("sleep", "2026-10-26"))

    def test_healthz_and_no_auth_fails_closed(self):
        async def request(path, authorization=None):
            sent = []
            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}
            async def send(msg):
                sent.append(msg)
            headers = [] if authorization is None else [(b"authorization", authorization)]
            await health.app({"type": "http", "path": path, "headers": headers,
                "method": "GET", "query_string": b"", "server": ("localhost", 8000),
                "client": ("localhost", 0), "scheme": "https",
                "http_version": "1.1"}, receive, send)
            return sent

        with mock.patch.object(health, "MCP_SECRET", ""):
            response = asyncio.run(request("/mcp"))
            self.assertEqual(response[0]["status"], 401)
        with mock.patch.object(health, "MCP_SECRET", "known-test-secret"):
            response = asyncio.run(request("/mcp", b"Bearer invalid"))
            self.assertEqual(response[0]["status"], 401)
        response = asyncio.run(request("/healthz"))
        self.assertEqual(response[0]["status"], 200)
        self.assertNotIn(b"token", response[1]["body"].lower())


if __name__ == "__main__":
    unittest.main()
