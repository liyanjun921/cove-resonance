# Alipay runtime probe — experimental

Isolated, free-plan compatibility diagnostic for the official Alipay CLI. It does not integrate with or import Cove Bridge, Music tools, event queues, existing adapters or their credentials.

The process runs exactly one `alipay-bot check-wallet --json` per start. HTTP routes only expose sanitized runtime booleans and numeric codes. No HTTP route can request authorization, bind a wallet, submit payment, run custom commands or repeat the query. No secrets or personal data belong in this source tree or service environment.

The reviewed installer is `@alipay/agent-payment@1.0.28`; the vendor CLI release content is locked to `0.4.9`. The unmodified official SDK decides how to handle its security components. Native dependency warnings and gateway transport failures are reported separately. No security component is replaced or disabled.

Render: `free`, Singapore, dedicated service and branch, no disk, no paid resources. Temporary filesystem state is acceptable only because wallet authorization and payments are absent. This must never be used as a long-lived wallet executor.

Verification:

```sh
node --test aipay-runtime-probe/test.mjs
npm test
npm run build
git diff --check
```

After deployment, verify `live` and inspect `/status`. A live HTTP server is not proof that the CLI can authorize a wallet. Only the real query and transport result establish what worked. Dispose of or suspend the diagnostic after deciding on the runtime; do not fold this experiment into working Bridge paths.
