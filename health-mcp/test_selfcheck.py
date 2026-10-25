"""Offline security and contract checks for /setup/check-data."""
import asyncio
import base64
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from httpx import ASGITransport, AsyncClient
import setup


class FakeXiaomiClient:
    def __init__(self, shared=None):
        self.shared = shared or {"sleep", "heart_rate", "steps"}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get_relatives(self):
        return [SimpleNamespace(relative_uid=12345)]

    async def get_shared_data_types(self, uid):
        assert uid == 12345
        return list(self.shared)

    async def get_latest_daily_summary(self, uid):
        assert uid == 12345
        return SimpleNamespace(
            sleep=SimpleNamespace(score=99, private_measurement="do not show"),
            heart_rate=SimpleNamespace(bpm=85),
            steps=None,
        )


def token_env():
    return {
        "HEALTH_SETUP_SECRET": "test-secret-thirty-two-characters",
        "MI_RELATIVE_UID": "12345",
        "MI_TOKEN_B64": base64.b64encode(b'{"user_id":"test","service_token":"sdk-token"}').decode(),
    }


class HealthReadDiagnosticTests(unittest.TestCase):
    def call(self, secret=None):
        async def execute():
            async with AsyncClient(transport=ASGITransport(app=setup.setup_app),
                                   base_url="http://local") as client:
                headers={} if not secret else {"x-health-setup-secret": secret}
                r=await client.post("/setup/check-data", headers=headers)
                return r.status_code, r.json()
        return asyncio.run(execute())

    def test_rejects_unauthenticated(self):
        with patch.dict(os.environ, token_env()):
            status, payload=self.call()
        self.assertEqual(status,401)
        self.assertEqual(payload,{"error":"unauthorized"})

    def test_does_not_return_health_values(self):
        with patch.dict(os.environ, token_env()):
            with patch.object(setup.MiHealthClient,"from_token",return_value=FakeXiaomiClient()):
                status, payload=self.call("test-secret-thirty-two-characters")
        self.assertEqual(status,200)
        self.assertEqual(payload["code"],"read_succeeded")
        self.assertEqual(payload["available"],{
            "sleep":True, "heart_rate":True, "steps":False})
        out=json.dumps(payload)
        for private in ["99", "85", "12345", "sdk-token", "private_measurement"]:
            self.assertNotIn(private,out)

    def test_missing_share_is_reported_without_read(self):
        with patch.dict(os.environ, token_env()):
            with patch.object(setup.MiHealthClient,"from_token",
                              return_value=FakeXiaomiClient({"sleep"})):
                status, payload=self.call("test-secret-thirty-two-characters")
        self.assertEqual(status,200)
        self.assertEqual(payload["code"],"scopes_missing")
        self.assertEqual(payload["missing"],["heart_rate","steps"])

if __name__=="__main__":
    unittest.main()
