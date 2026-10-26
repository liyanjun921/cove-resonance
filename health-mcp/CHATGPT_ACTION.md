# ChatGPT GPT Action — Xiaomi Mi Fitness, no OAuth

The document provided by the owner uses a normal HTTP endpoint:
`GET /health?date=YYYY-MM-DD&type=all`. Our Render backend implements it.
This folder contains the matching OpenAPI schema in
`chatgpt-action-openapi.json`.

**Important:** An HTTP API does not automatically become a tool in the
ordinary ChatGPT conversation. A separate host integration is required.
A Custom GPT with Actions is one possible integration, if available on
the owner's account; this does **not** insert tools into an existing
ordinary chat thread. The portable private MCP plugin is another route,
but its expected ChatGPT API-key connection UI has *not* appeared,
so it should not be represented as connected.

## Set up an Action in a Custom GPT

1. From ChatGPT's desktop/web GPT editor, configure a new private Custom
   GPT. Do not publish it.
2. Under Actions, choose an option to create an Action from an OpenAPI schema.
   Use the contents of `chatgpt-action-openapi.json`, or import the file's
   GitHub raw URL when the editor supports URL imports.
3. Under the **GPT Action's own authentication settings** choose API Key
   authentication with Bearer scheme, and enter the value of the existing
   Render `HEALTH_MCP_BEARER_TOKEN` there. This is not the previous private
   plugin installation page, which did not show the required UI.
   Never put any token into the OpenAPI JSON, messages, or GitHub.
4. Save the Custom GPT privately; use its Action testing UI to query one
   date. Do not claim success until the Action's server response is seen.
5. The action is read only, and returns synced cloud data that may be stale.
   The owner can revoke Xiaomi family sharing at any time.

If the Action editor is unavailable or does not support API key storage,
stop without removing the backend's authorization. The provider's general
MCP/plugin installer and the GPT Actions editor are different UIs; do not
assume the former supports authentication just because the latter does.

## Security and troubleshooting

- `MI_TOKEN_B64` is Xiaomi session data and should never be provided to
  a GPT or copied into an Action. Only the server stores it.
- `HEALTH_SETUP_SECRET` is for the Xiaomi QR setup page, not GPT Actions.
- `HEALTH_MCP_BEARER_TOKEN` is the server's API access key. Put it only in
  the Action's credential field if the platform offers one. Rotating that key
  revokes the previous Action connection.
- A 401 means the HTTP caller has not supplied the recognized key.
- A 502 means the Xiaomi cloud call failed; do not infer the person has no
  activity or slept zero hours.
- `/healthz` checks that configuration exists, not whether a GPT is connected.
- Keep the existing RIVERSE music and General Bridge services untouched.

## Local OpenAPI schema sanity check

The Action file declares one `GET /health` with required `date` and `type`
parameters, possible values `all`, `sleep`, `heart_rate`, `steps`,
and an HTTP bearer security requirement. It includes no credentials.
