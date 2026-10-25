"""No Xiaomi account needed: parser does not expose credentials to users."""
import base64
import json
import unittest
from token_codec import parse_token


class CredentialParserTests(unittest.TestCase):
    def setUp(self):
        self.record = {"user_id": "test-user", "service_token": "secret-x", "ssecurity": "secret-y"}
        self.raw = json.dumps(self.record)
        self.b64 = base64.b64encode(self.raw.encode()).decode()

    def test_qr_export(self):
        raw, code = parse_token(self.b64)
        self.assertEqual(code, "token_valid")
        self.assertEqual(json.loads(raw), self.record)

    def test_common_clipboard_formats(self):
        examples = [
            self.raw,
            self.b64[:12] + "\n" + self.b64[12:],
            json.dumps(self.b64),
            json.dumps({"token_base64": self.b64}),
            "MI_TOKEN_B64=" + self.b64,
            base64.b64encode(self.b64.encode()).decode(),
        ]
        for sample in examples:
            with self.subTest(index=len(sample)):
                raw, code = parse_token(sample)
                self.assertEqual(code, "token_valid")
                self.assertEqual(json.loads(raw), self.record)

    def test_invalid_values(self):
        self.assertEqual(parse_token("")[1], "token_missing")
        self.assertEqual(parse_token("not a credential!!")[1], "token_not_base64")
        self.assertEqual(parse_token(json.dumps({"hello": "world"}))[1], "token_json_not_xiaomi")


if __name__ == "__main__":
    unittest.main()
