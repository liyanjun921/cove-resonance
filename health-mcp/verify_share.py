"""Verify the *secondary* Xiaomi account can see shared health data.

Only run after the user approves sharing through Mi Fitness. This prints
permission metadata and no heart-rate/sleep measurements.
"""
import asyncio
import os
from pathlib import Path

from mi_fitness import MiHealthClient

EXPECTED = {"sleep", "heart_rate", "steps"}


async def check_share(token_file: str) -> dict[str, object]:
    async with MiHealthClient.from_token(token_file) as client:
        relatives = await client.get_relatives()
        if not relatives:
            return {"ok": False, "reason": "no_relatives", "relative_count": 0}

        expected_uid = os.getenv("MI_RELATIVE_UID", "").strip()
        if not expected_uid:
            return {
                "ok": False,
                "reason": "select_relative_uid_locally",
                "relative_count": len(relatives),
                "relative_ids": [r.relative_uid for r in relatives],
            }
        if not expected_uid.isdigit() or int(expected_uid) <= 0:
            return {"ok": False, "reason": "invalid_relative_uid"}

        uid = int(expected_uid)
        if uid not in {r.relative_uid for r in relatives}:
            return {"ok": False, "reason": "relative_not_found"}

        shared = set(await client.get_shared_data_types(uid))
        permitted = sorted(shared & EXPECTED)
        missing = sorted(EXPECTED - shared)
        return {
            "ok": not missing,
            "relative_found": True,
            "allowed": permitted,
            "missing": missing,
            "reason": None if not missing else "permission_missing",
        }


if __name__ == "__main__":
    token_file = os.getenv("MI_TOKEN_FILE", "token.json")
    if not Path(token_file).is_file():
        raise SystemExit("Missing private Xiaomi token file. Run login_once.py first.")
    from pprint import pprint
    pprint(asyncio.run(check_share(token_file)))
