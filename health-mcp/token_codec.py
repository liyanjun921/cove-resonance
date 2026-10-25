"""Private Xiaomi credential parser; no input or decoded content is ever logged.

Supports the exact QR export plus common clipboard formats. Only generic
failure codes may be returned to the owner via authenticated diagnostics.
"""
import base64
import binascii
import json
import re


def parse_token(value: str) -> tuple[bytes | None, str]:
    if not isinstance(value, str) or not value.strip():
        return None, "token_missing"
    s = value.strip()
    if len(s) > 32768:
        return None, "token_too_large"
    if s.startswith("MI_TOKEN_B64="):
        s = s[len("MI_TOKEN_B64="):].strip()

    for _ in range(3):
        # Accept raw JSON from a user's clipboard, or a JSON string wrapper.
        try:
            obj = json.loads(s)
        except (ValueError, TypeError):
            obj = None

        if isinstance(obj, dict):
            if "token_base64" in obj and isinstance(obj["token_base64"], str):
                s = obj["token_base64"].strip()
                continue
            # Xiaomi SDK AuthToken serializes to an object with these keys.
            if isinstance(obj.get("user_id"), str) and any(
                isinstance(obj.get(k), str) and obj.get(k)
                for k in ("service_token", "ssecurity", "pass_token")
            ):
                return json.dumps(obj, ensure_ascii=False).encode("utf-8"), "token_valid"
            return None, "token_json_not_xiaomi"
        if isinstance(obj, str):
            s = obj.strip()
            continue

        compact = re.sub(r"\\s+", "", s)
        try:
            raw = base64.b64decode(compact, validate=True)
        except (ValueError, binascii.Error):
            return None, "token_not_base64"
        try:
            s = raw.decode("utf-8")
        except UnicodeDecodeError:
            return None, "token_decoded_not_text"

    return None, "token_nested_too_deep"
