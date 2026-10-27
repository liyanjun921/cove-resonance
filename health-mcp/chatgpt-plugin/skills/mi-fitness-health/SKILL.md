---
name: mi-fitness-health
description: Read authorized Xiaomi Mi Fitness sleep, heart rate, steps or daily summaries when relevant to the user's request or explicitly authorized health check.
---

# 小米手环健康

Use get_sleep, get_heart_rate, get_steps or get_daily_summary with an explicit YYYY-MM-DD date in the user's timezone. The owner authorized no-login read-only MCP access on 2026-10-26. Do not request API keys or OAuth for this connection. Xiaomi credentials remain server-side; never disclose them.

Report only actual returned records with their date and synchronization limitations. Distinguish empty results, errors and stale records; never diagnose. Keep readings out of music services and General Bridge. Use only the data needed for the request.

When tools are unavailable, say so. Do not equate server tests with ChatGPT tool calls or claim background monitoring without a verified scheduled run. This plugin does not itself schedule or wake ChatGPT.
