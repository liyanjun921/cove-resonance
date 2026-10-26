# XLC Private Mi Fitness Health MCP

**Status (2026-10-26):** Render's isolated health service is live. An authenticated, real Xiaomi family-share check succeeds for sleep, heart rate and steps. On 2026-10-26 the four MCP tools completed real nonempty reads for 2026-10-25 from an external MCP client. **Official ChatGPT installation, API-key connection, and scheduled-task use are not yet verified.** Two legacy private plugin packages had static headers removed and their former keys were revoked; use the API-key plugin described below.

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

## Browser-only Xiaomi login (no terminal required)

The optional HTTPS page `/setup` is disabled until you personally set a secret:
- Open the dedicated health service in Render → **Environment**, add `HEALTH_SETUP_SECRET` with a new random password of **at least 24 characters**; never send it in chat or commit it to GitHub.
- Deploy/restart the service to apply that new secret.
- Visit `https://xlc-mi-fitness-health-mcp.onrender.com/setup` and enter your private `HEALTH_SETUP_SECRET`.
- Click **获取小号登录二维码** and scan with the secondary Xiaomi account using the system camera on another device. Do not scan using your primary account.
- Once granted, the page shows relative UID(s) and the shared field names (without medical measurements). Verify the right primary relative.
- Use **复制一次性凭证** and immediately paste the base64 value into Render Environment variable `MI_TOKEN_B64`, then set `MI_RELATIVE_UID` to the consenting primary account's relative UID. Base64 is not encryption; do not paste it into chat.
- On Render restart, use `/healthz` (which only exposes a configured boolean) to check that all server secrets exist. Do not configure the ChatGPT integration until private client authentication is implemented and tested.
- After successful configuration, remove or rotate `HEALTH_SETUP_SECRET` to disable the page. The in-memory credentials disappear on restart or after ten minutes.

The setup page never copies Xiaomi tokens to GitHub. It does briefly keep the secondary-account token in memory and shows it to an administrator with the secret; only enable it while actively onboarding. Do not use any shared passwords for this setup page.

## Private ChatGPT plugin and authentication

**ChatGPT connection remains pending.** The existing private plugin package at https://chatgpt.com/plugins/plugins_6ade9d80ff408191ac4be50f6dd7aedf declares `auth.type: api_key`, but the current ChatGPT plugin connection form does not expose a field for a fixed API key. The manifest schema accepts this declaration; it does not guarantee a usable ChatGPT connection UI. Do not ask the owner to paste `HEALTH_CHATGPT_TOKEN` into chat or to disable server authentication. See the official [plugin packaging authentication limitations](https://developers.openai.com/plugins/build/plugins) and [MCP authentication guide](https://developers.openai.com/plugins/build/auth).

To use the health MCP in ordinary ChatGPT conversations, implement a supported OAuth 2.1 authorization-code + PKCE flow with a real authorization server and protected-resource metadata, then update the **existing** private plugin to OAuth and complete its connection. The four protected tools must then be tested in a normal ChatGPT chat and the hourly task separately. No such ChatGPT-hosted connection has yet been verified.

The service accepts two distinct Bearer secrets: `HEALTH_MCP_BEARER_TOKEN` for operator tests and `HEALTH_CHATGPT_TOKEN` for the prior experiment. Both were rotated on 2026-10-26. The previous static plugin keys return HTTP 401. Keep existing authentication in place while changing the ChatGPT integration.

The MCP host allowlist includes this service's exact Render domain. A prior public MCP handshake returned HTTP 421 `Invalid Host header`; this was fixed with DNS rebinding protection still enabled. A direct authenticated MCP client has initialized and called all four tools successfully. This **does not establish** ChatGPT app access.

A guarded `GET /health/status` uses a valid service Bearer key and returns only share-permission and data-availability flags, not measurements or identifiers. `GET /healthz` reports basic configuration. Anonymous access to `/health/status`, `/health`, and `/mcp` is denied with HTTP 401.

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

The standalone server exposes a protected Streamable HTTP MCP endpoint at `/mcp`, and a direct client has authenticated and called all four tools. **This is not proof of a connected ChatGPT app.** Install and connect the existing API-key plugin securely in ChatGPT, then run each tool in a normal chat before claiming that integration works. Do not temporarily remove the authentication gate or publish a no-auth health MCP just to get it to appear in ChatGPT.

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
