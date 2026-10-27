"""Synthetic protocol tests; no real keys or health data."""
import asyncio
import json
import os
import unittest
from unittest.mock import AsyncMock, patch
import live_heart_rate as live


class LiveTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_and_invalid_configuration(self):
        with patch.dict(os.environ, {"HYPERATE_API_KEY": "", "HYPERATE_ID": ""}):
            self.assertEqual((await live.get_live_heart_rate())["status"], "not_configured")
        with patch.dict(os.environ, {"HYPERATE_API_KEY": "test-secret", "HYPERATE_ID": "other/path"}):
            self.assertEqual((await live.get_live_heart_rate())["status"], "invalid_device_configuration")

    async def test_live_frame_and_join(self):
        ws = AsyncMock()
        ws.recv.side_effect = [json.dumps({"event": "phx_reply", "topic": "hr:TEST", "payload": {"status": "ok"}}),
                               json.dumps({"event": "hr_update", "topic": "hr:TEST", "payload": {"hr": 75}})]
        cm = AsyncMock()
        cm.__aenter__.return_value = ws
        with patch.object(live, "connect", return_value=cm):
            result = await live._read("synthetic-secret", "TEST")
        self.assertEqual(result["bpm"], 75)
        self.assertEqual(result["status"], "received")
        self.assertIsNone(result["sampled_at"])
        self.assertNotIn("synthetic-secret", json.dumps(result))
        self.assertEqual(json.loads(ws.send.call_args_list[0].args[0])["topic"], "hr:TEST")

    async def test_rejected_and_no_sample(self):
        ws = AsyncMock()
        cm = AsyncMock()
        cm.__aenter__.return_value = ws
        ws.recv.return_value = json.dumps({"topic": "hr:TEST", "event": "phx_reply", "payload": {"status": "error"}})
        with patch.object(live, "connect", return_value=cm):
            self.assertEqual((await live._read("test", "TEST"))["status"], "subscription_rejected")
            async def blocked():
                await asyncio.sleep(1)
            ws.recv.side_effect = blocked
            result = await live._read("test", "TEST", wait_seconds=0.01)
            self.assertEqual(result["status"], "no_live_sample")
            self.assertIsNone(result["bpm"])

    async def test_error_never_exposes_secret(self):
        with patch.dict(os.environ, {"HYPERATE_API_KEY": "test-secret", "HYPERATE_ID": "TEST"}), patch.object(live, "_read", side_effect=RuntimeError("url?token=test-secret")):
            result = await live.get_live_heart_rate()
        self.assertEqual(result["status"], "upstream_unavailable")
        self.assertNotIn("test-secret", json.dumps(result))

    async def test_parse_ignores_other_streams_and_bad_data(self):
        for frame in ({}, [], {"topic": "hr:OTHER", "event": "hr_update", "payload": {"hr": 70}},
                      {"topic": "hr:TEST", "event": "hr_update", "payload": {"hr": True}},
                      {"topic": "hr:TEST", "event": "hr_update", "payload": {"hr": 0}}):
            self.assertIsNone(live._parse_sample(json.dumps(frame), "hr:TEST"))

if __name__ == "__main__":
    unittest.main()
