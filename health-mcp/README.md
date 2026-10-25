# XLC Private Mi Fitness Health MCP — first-stage implementation

**Status: development scaffold; NOT linked to ChatGPT, NOT deployed, and NOT yet tested with a real Xiaomi account.**

This folder is independent of the music MCP. Nothing here changes the running NetEase/Cove bridge.

## What it supports

Read-only MCP tools: `get_sleep(date)`, `get_heart_rate(date)`, `get_steps(date)`, and `get_daily_summary(date)`. Dates use `YYYY-MM-DD`. Each tool only reads the specific consented Mi Fitness relative from `MI_RELATIVE_UID`. Results come from the last synced Xiaomi cloud record; they are **not real-time vitals or medical diagnoses**.

Source SDK: [Misty02600/mi-fitness-python](https://github.com/Misty02600/mi-fitness-python) (GPL-3.0). This project uses the Python package as a dependency and does not copy its sources. The SDK talks to reverse-engineered, unofficial Xiaomi endpoints and can break if Xiaomi changes them. Review its license and applicable terms before redistribution.

**Compatibility:** Band model by itself is insufficient. The band must actually sync data to the **Mi Fitness / 小米运动健康** app. **Zepp Life / 原小米运动** is a different integration and this adapter does not support it.

## Setup prerequisites

1. One person's Xiaomi main account and band, already syncing into Mi Fitness.
2. A separate Xiaomi account used as a relative. Send the family/friends invitation; the main-account user must explicitly accept and enable only the health fields they want to share.
3. Scan the SDK's Xiaomi QR login with the device's system camera and obtain the *secondary account* token. Never paste a token, password or QR login link into a public repository, issue, PR, or ChatGPT conversation.
4. Determine the main account's relative UID using the SDK's `get_relatives()` after accepting the invitation. Do **not** use a random account UID.
5. Configure a separate HTTPS health server and secure client authentication. The existing music server is untouched.

## After accepting the Mi Fitness invitation

Run `verify_share.py` on a trusted machine after logging in with the **secondary** Xiaomi account using `login_once.py`. Its first pass returns the relative IDs without health values, allowing you to pick the correctly authorized account. Set `MI_RELATIVE_UID` privately and run again to verify that the consent includes exactly the requested sleep, heart-rate and step scopes. No actual health measurements are printed by this diagnostic.

Do not confuse the Xiaomi account login QR with a relative-sharing invitation. Authorization in the Mi Fitness app is still required.

## Local development

Needs Python 3.11+ (Dockerfile uses 3.12):

```sh
pip install -r requirements.txt
python login_once.py
```

The script saves `token.json` with file permissions `0600`. Store it only on a trusted machine. Set `MI_TOKEN_FILE` to an absolute private token file path; alternately put the base64 encoding of its raw JSON into the platform's **secret environment variable** `MI_TOKEN_B64`. Base64 is **not encryption**. Do not commit or print it.

```sh
export HEALTH_MCP_BEARER_TOKEN="<strong unique secret>"
export MI_RELATIVE_UID="<consented relative UID>"
export MI_TOKEN_FILE="/secure/private/token.json"
python app.py
```

Use `GET /healthz` to check deployment readiness; it deliberately does not expose secrets. `POST /mcp` is protected by `Authorization: Bearer <secret>`; unauthenticated requests return `401`, including if the token is missing.

## Render-style deployment

Create a **separate** web service with root directory `health-mcp/`, Docker runtime and the supplied Dockerfile. Use a dedicated domain and configure:

- `HEALTH_MCP_BEARER_TOKEN`: generated long random secret;
- `MI_RELATIVE_UID`: explicitly authorized relative account UID;
- `MI_TOKEN_B64`: QR-issued token JSON encoded as base64, stored only as a Render secret. Do not use `MI_TOKEN_FILE` unless secure persistent storage is mounted.

`/healthz` may respond `configured: false` until these values exist; do not interpret it as an end-to-end health read test. Never commit secrets.

## ChatGPT integration — not finished

The standalone server exposes a protected Streamable HTTP MCP endpoint at `/mcp`. **This bearer-gated development endpoint is not by itself proof that a ChatGPT private app can authenticate to it.** Before connecting the real ChatGPT user, implement and verify a ChatGPT-supported secure auth/OAuth flow or another supported credential integration. Do not temporarily remove the authentication gate or publish a no-auth health MCP just to get it to appear in ChatGPT.

The original requested outcome (the assistant reading the band without repeated screenshots) is only complete after:
- confirming the user's actual fitness app,
- live Xiaomi QR authorization and consent,
- authenticated MCP handshake inside ChatGPT,
- one successful actual sleep query and a consent/revoke test.

Scheduled/background reading is a separate feature: it must be verified that the scheduled task has access to this exact plugin; adding an MCP does **not** automatically enable reminders or periodic reads.

## Health and privacy expectations

- The user can revoke Mi Fitness family-share permission at any time.
- Restrict read fields and dates to only what was approved.
- Never log tokens, full health responses, or account identifiers.
- Keep tokens server-side; rotate the MCP secret if compromised.
- Don't interpret unsynced, missing or partial data as 0, and don't diagnose medical conditions using consumer-device readings.
