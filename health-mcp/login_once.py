"""Run in a trusted Python environment, never on a public web page.
Uses the SDK's QR login. Copy the resulting token.json into a *secret* store,
not into GitHub or a chat. The system camera scans the Xiaomi QR code.
"""
import asyncio
import os
from mi_fitness import XiaomiAuth

async def main():
    output = os.environ.get("MI_TOKEN_FILE", "token.json")
    async with XiaomiAuth() as auth:
        await auth.login_qr()
        auth.save_token(output)
        os.chmod(output, 0o600)
        print("Token saved locally. Keep it private; do not commit or share.")

if __name__ == "__main__":
    asyncio.run(main())
