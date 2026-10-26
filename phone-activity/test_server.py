"""Local HTTP integration tests for consent-scoped app event recording."""
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer

os.environ["PHONE_ACTIVITY_TOKEN"] = "example_not_a_real_secret_" + "x" * 40
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server


class PhoneActivityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        server.DB_PATH = Path(cls.temp.name) / "history.sqlite"
        server.init_db()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)
        cls.temp.cleanup()

    def request(self, method, path, payload=None, token=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=3)
        headers = {}
        if token:
            headers["X-Phone-Token"] = os.environ["PHONE_ACTIVITY_TOKEN"]
        body = None
        if payload is not None:
            body = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        try:
            conn.request(method, path, body=body, headers=headers)
            res = conn.getresponse()
            result = json.loads(res.read())
            return res.status, result
        finally:
            conn.close()

    def test_health_safe_and_private(self):
        status, data = self.request("GET", "/healthz", token=False)
        self.assertEqual(status, 200)
        self.assertTrue(data["ready"])
        self.assertEqual(data["storage"], "ephemeral_sqlite")
        for method in ("GET", "POST"):
            status, data = self.request(method, "/v1/activity", token=False)
            self.assertEqual(status, 401)
            self.assertEqual(data["error"], "authorization_required")

    def test_open_event_and_read_are_authenticated(self):
        status, data = self.request("POST", "/v1/activity",
                                    {"app":"抖音","event":"open","device":"iphone"})
        self.assertEqual(status, 200)
        self.assertTrue(data["recorded"])
        status, result = self.request("GET", "/v1/activity?limit=10")
        self.assertEqual(status, 200)
        self.assertTrue(any(x["app"] == "抖音" and x["event"] == "open"
                            for x in result["events"]))
        self.assertIn("at_utc", result["events"][0])

    def test_reject_unknown_event_and_no_content(self):
        for item in (
            {"app":"抖音","event":"reading_messages","device":"iphone"},
            {"app":"","event":"open"},
            {"app":"抖音","event":"open","device":""},
        ):
            status, _ = self.request("POST", "/v1/activity", item)
            self.assertEqual(status, 400)

    def test_duplicate_rejection(self):
        payload={"app":"example test","event":"close","device":"iphone"}
        status, d1=self.request("POST","/v1/activity",payload)
        self.assertEqual(status,200)
        self.assertTrue(d1["recorded"])
        status, d2=self.request("POST","/v1/activity",payload)
        self.assertFalse(d2["recorded"])
        self.assertTrue(d2["duplicate"])

    def test_prunes_old_events(self):
        with server.LOCK, server.sqlite3.connect(server.DB_PATH) as con:
            con.execute("INSERT INTO activity(recorded_at,app,event,device) VALUES (?,?,?,?)",
                        (int(time.time())-8*86400,"expired-old","open","iphone"))
        _, result=self.request("GET","/v1/activity")
        self.assertFalse(any(x["app"]=="expired-old" for x in result["events"]))


if __name__ == "__main__":
    unittest.main()
