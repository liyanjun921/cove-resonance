# XLC Phone Activity – iOS Shortcuts MVP

Private, self-reported iPhone App Open / App Close events. No iOS remote access, no screenshots, no app content, no screen-time estimates. No changes to music, health, snapshot or General Bridge services.

## Deploy

Create a SEPARATE Render Docker web service based on repo liyanju921/cove-resonance, branch feat/private-phone-activity-bridge:
- Docker context: phone-activity
- Dockerfile path: phone-activity/Dockerfile
- Free Render plan for testing, Singapore region
- Set an independent secret environment variable PHONE_ACTIVITY_TOKEN to a random value **at least 32 characters long**. Never put it in screenshots, chat or GitHub.
- GET /healthz: {"ok":true,"ready":true,"storage":"ephemeral_sqlite"} after deployment and token setup.

## iPhone first test

Open Shortcuts → make a shortcut named Phone activity – Douyin open:
1. Add a URL action containing https://xlc-phone-activity.onrender.com/v1/activity.
2. Add Get Contents of URL, choose POST with Request Body set to JSON.
3. Add header X-Phone-Token: the secret from your Render Environment settings (do not paste it elsewhere).
4. Add three JSON fields, all Text: app = 抖音, event = open, device = iphone.
5. Add Quick Look for the result while testing. Press Play once. Expect {"ok":true,"recorded":true,...}.
6. Shortcuts → Automation → + → App → choose only 抖音 → Is Opened → Run Immediately → select the shortcut above.
7. Later create a corresponding close shortcut and automation by changing event to close. **Hard-code app** for each selected App rather than using Get Current App in close automation, which may report the newly foregrounded app.

GET private test: create a shortcut with GET https://xlc-phone-activity.onrender.com/v1/activity?limit=10 plus header X-Phone-Token and Quick Look.

## API

POST /v1/activity ; X-Phone-Token: secret ; Content-Type: application/json
{"app":"抖音","event":"open","device":"iphone"}

GET /v1/activity?limit=30 ; X-Phone-Token: secret

All timestamps are from server in UTC (at_utc). The service automatically discards events older than seven days; duplicate same-app same-event same-device events within three seconds are ignored. Records are based solely on Shortcut posts and may be missing offline or canceled events. Counts are not Apple's Screen Time and are not proof of what was displayed in an app.

## Security / persistence caveats

All activity data is protected with a server-side token and never publicly served; unauthorized access returns 401. Only selected app names, event types, a device label, and server receive time are stored. Logs suppress raw HTTP request data and secret headers. No user credentials are sent to an LLM and no outgoing callbacks occur.

**The Render free filesystem is ephemeral. Data will be LOST at service restart/suspend/redeploy.** The current design is a one-app connectivity test only. For genuine seven-day durable history, deploy persistent storage (e.g. supported database), add authenticated GET /v1/activity access to the user's private MCP, and validate ChatGPT tool discovery/calls before claiming autonomous check-ins. Do not combine this with existing music/health credentials.

Stopping phone automations stops new events. Clear/reset data by restarting the free service or implementing an authenticated delete endpoint before longer-term rollout.