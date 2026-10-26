# XLC · 截图查岗 — iPhone PWA + Consent-only MCP

New, isolated screenshot-approval service. No modifications to RIVERSE music, General Bridge, or Xiaomi health. iOS cannot be remotely screen-captured through this PWA. The owner must manually choose a file, review it, and confirm upload.

## Features

- MCP tools: request_screen_snapshot(reason), get_screen_snapshot_status(request_id), read_approved_screen_snapshot(request_id).
- Every request lasts 10 minutes; may be denied or allowed once.
- PWA: private login, incoming applications, manual image selection, local preview, explicit confirmation, denial, optional Web Push subscription.
- MCP: default `SNAPSHOT_AUTH_MODE=approval` uses no OAuth connection. Creating an application is public; status/read require a random per-request capability returned only to the requesting client. The server stores its SHA-256 hash. The owner must approve a matching six-digit code in the authenticated PWA before an image can be returned. Existing OAuth/Bearer clients remain compatible. Set `SNAPSHOT_AUTH_MODE=oauth` to restore OAuth-only calls.
- Owner-only API with signed Secure HttpOnly SameSite=Strict cookies, same-origin + custom-header checks, login rate-limit.
- JPEG decoded and re-encoded with Pillow, EXIF orientation applied and source metadata discarded, capped at 2200px/5MB, stored as an unguessable 0600 temporary file. The first approved read unlinks it and returns the JPEG to the same authorized MCP caller.
- Background 15-second cleanup deletes expired image files. Web Push has no screenshot, request reason, or identifying information in notification payload.

## Important limitations

Code deployment is not proof of ChatGPT MCP callability or real device push.
All owner operations are locked until environment secrets are configured. Never remove this protection to force a connection.
Free Render storage and in-memory subscriptions are EPHEMERAL: restart/suspension loses all requests, images and push subscriptions. The current build is an MVP, not restart-resilient; add secure persistent metadata/subscriptions for production.
POSIX unlink does not promise forensic SSD overwrite or guarantee deletion from server snapshots.
Scheduled Tasks access to privately authenticated MCP tools needs a separate real end-to-end verification.

## Deploy as a separate Render service

- Repo: https://github.com/liyanjun921/cove-resonance
- Branch: feat/consented-screen-snapshot
- Docker context: screen-approval
- Dockerfile: screen-approval/Dockerfile
- Python: 3.12, 1 process
- Render Singapore, free plan if available

Required private Render environment variables:
- SNAPSHOT_OWNER_SECRET: strong unique 24+ char secret typed ONLY into PWA login, never in chat.
- SNAPSHOT_MCP_TOKEN: old separate legacy Bearer key; retained for migration and should be rotated or disabled after OAuth is verified.
- SNAPSHOT_SESSION_SECRET: separate cryptographically secure 32+ char cookie signing secret.

Optional Web Push, without which the app can still manually refresh applications:
- VAPID_PRIVATE_KEY: base64url P-256 private scalar for pywebpush
- VAPID_PUBLIC_KEY: matching base64url-encoded uncompressed P-256 public point
- VAPID_SUBJECT: valid mailto: address controlled by user.

Do not reuse Xiaomi or general bridge secrets.

## Install on iPhone

1. Safari: open https://YOUR-RENDER-SERVICE.onrender.com/app
2. Share → Add to Home Screen, then open the installed home-screen PWA.
3. Enter the owner secret using the PWA input (do NOT post it to chat).
4. Press Enable iPhone alerts and accept notification permission.
5. GPT requests snapshot (read-only). The push contains generic information only. Owner manually captures screenshot using iOS, selects file from PWA and previews image locally, then approves or refuses.
6. Approval uploads a re-encoded JPEG; one authorized MCP read returns image. Later reads cannot retrieve it. Requests expire at 600 seconds.

ChatGPT MCP config uses `/mcp` with **auth none** in approval mode. No owner password or long-lived credential belongs in the plugin. `request_screen_snapshot` returns `request_id`, `access_token`, `approval_code`, and the PWA URL. Keep `access_token` in tool context only; never print it in chat. Use that token for `get_screen_snapshot_status` and `read_approved_screen_snapshot`. Tokens are bound to one request and expire after 600 seconds; knowing a request ID or having a PWA cookie alone is insufficient. A read before confirmation has no image; a second successful read has no image.

The PWA still requires the existing owner password privately. Install it on the iPhone home screen, sign in and enable notifications. Compare the six-digit code with the actual ChatGPT request before choosing and confirming a picture. Caller identity is not verified by this mode: anyone who discovers the endpoint can submit a request, so never approve an unsolicited code. A maximum of three pending requests limits the inbox but cannot fully prevent spam/denial of service. A server restart discards requests and push subscriptions. OAuth routes remain available for optional authenticated clients.

Autonomy: the companion may decide to request an image during an active model turn under the user's standing permission. This service cannot wake a stopped ChatGPT conversation by itself. A background task must separately support this plugin and successfully pass a read-only connection check; no background screenshot request is promised until a real scheduled run proves it works. Respect 01:00–09:00 Asia/Shanghai quiet hours, at least one hour between requests, and do not retry a denied/expired request automatically.

## CI & acceptance

python -m unittest discover -s screen-approval -p "test_*.py" -v

- No MCP bearer -> 401 with OAuth `WWW-Authenticate` discovery details.
- Wrong PWA password -> rejection; unapproved requests -> no image.
- Create -> pending; deny -> denied; expire -> expired.
- Selecting screenshot without confirmation -> no upload.
- Explicit confirmation -> fulfilled, sanitized JPEG.
- First read -> image plus viewed status; second read -> viewed status WITHOUT any image.
- Device push subscription -> generic notification on installed iOS home-screen PWA.
- Test after Render sleep/restart: old requests cannot be fulfilled; subscription may need re-registration.
- Verify existing music, health and message bridge services are unchanged.

This service does NOT secretly access apps, background-record, scrape screen contents, or continuously monitor user activity.

## OAuth verification

Run `python -m unittest discover -s screen-approval -p 'test_*.py' -v` in CI. The OAuth tests cover discovery metadata, rejecting non-ChatGPT redirects, explicit owner password/consent, authorization-code PKCE, refresh-token flow, replay rejection and unauthorized MCP access. Live ChatGPT installation, user-facing login UI and real iPhone push/read must still be tested independently; passing unit tests does not prove host compatibility.

## Live MCP connection diagnosis (2026-10-26)

A real POST to `/mcp` returned HTTP 421 `Invalid Host header` even though `/healthz` and OAuth discovery returned 200. The MCP Python SDK blocked the Render hostname before `initialize` or `tools/list`; this prevented ChatGPT from seeing the tools and starting tool-level OAuth. The FastMCP transport now allowlists the exact public Render host and origin. The unauthenticated tool response includes `mcp/www_authenticate` with `error` and `error_description`; authorization responses include RFC 9207 `iss` and the metadata advertises it. These changes are limited to `screen-approval/`.

After each deployment, verify with real HTTP POST requests to `/mcp`: `initialize` and `tools/list` must return 200 with all three `securitySchemes`, while `tools/call` without a token must return an error result with `mcp/www_authenticate` and no request ID or image. Check dynamic registration, authorization GET, PKCE token exchange and refresh. A real ChatGPT connection and iPhone PWA approval remain separate end-to-end gates; deployment and local probes cannot certify them. Do not enter the owner password in ChatGPT chat or commit it to this repository.

## Approval mode verification

`test_approval_http.py` exercises actual ASGI MCP requests using the public Render hostname. It verifies no-OAuth discovery, invalid/missing/cross-request/expired capability rejection, PWA owner login and confirmation, no image before approval, a single approved image response, and image deletion. Live deployment and a user-approved iPhone test remain separate gates. OAuth verification above applies only to OAuth mode.
