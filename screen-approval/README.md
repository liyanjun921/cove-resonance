# XLC · 截图查岗 — iPhone PWA + Consent-only MCP

New, isolated screenshot-approval service. No modifications to RIVERSE music, General Bridge, or Xiaomi health. iOS cannot be remotely screen-captured through this PWA. The owner must manually choose a file, review it, and confirm upload.

## Features

- MCP tools: request_screen_snapshot(reason), get_screen_snapshot_status(request_id), read_approved_screen_snapshot(request_id).
- Every request lasts 10 minutes; may be denied or allowed once.
- PWA: private login, incoming applications, manual image selection, local preview, explicit confirmation, denial, optional Web Push subscription.
- Protected MCP: `/mcp` requires a valid owner-approved OAuth access token, with the previous legacy Bearer key supported for migration. Never expose either key in plugin manifests.
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

ChatGPT MCP config uses URL ending in `/mcp` with **OAuth** instead of an API-key prompt. The owner installs/connects the private plugin, opens the authorization screen at this service, enters their existing `SNAPSHOT_OWNER_SECRET` privately, and presses **我同意连接 ChatGPT**. Authorization server discovery at `/.well-known/oauth-authorization-server`, protected resource metadata at `/.well-known/oauth-protected-resource`, dynamic public client registration, PKCE S256, short-lived access tokens and refresh tokens are implemented. If ChatGPT does not show a connection prompt, report the platform connector state; do not turn the endpoint public.

OAuth sign-in accepts only HTTPS redirect URIs hosted on `chatgpt.com` or `chat.openai.com`, uses one-time expiring authorization codes, and does not grant any screenshot until the user separately confirms the specific image in the iPhone PWA. The login password is kept only in Render secrets and sent only to this service. OAuth access tokens expire after 1 hour; refresh tokens after 30 days. Token revocation is achieved by rotating `SNAPSHOT_OAUTH_SIGNING_SECRET` (if configured) or `SNAPSHOT_SESSION_SECRET`, which logs out all clients. This MVP keeps authorization codes in memory: server restart during a login can require a fresh authorization attempt.

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
