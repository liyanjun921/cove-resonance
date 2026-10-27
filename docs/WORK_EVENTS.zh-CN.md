# 谢临川 Work Events（待端到端验收）

这是与 `/mcp/bridge` Listener、`/mcp/music`、RIVERSE 部署隔离的新 Host Adapter。它使用 Work MCP Events 的 `server/discover`、`events/list`、`events/subscribe`、`events/unsubscribe`，把认证的外部消息和定时信号发到 **订阅它的 Work 对话**。无需手机卡片在线；不保证模型每次都会主动发言，由对话订阅时的指令决定。

## 组件与边界

- `POST /mcp/work`：需要 `WORK_EVENTS_MCP_TOKEN`；只提供 `general.message`、`work.wake` 两种 webhook 事件。订阅时验证签名回调；订阅与待投递事件写到独立 Supabase 项目。
- `POST /work/events`：需要服务端 `WORK_EVENTS_INGEST_TOKEN`。Body `{"eventId":"provider-stable-id","source":"pwa.chat","text":"..."}`；提供稳定 ID，避免外部重试造成重复发言。此入口不能直接放进浏览器 JS。
- `POST /work/tick`：需要 `WORK_EVENTS_TICK_TOKEN`。在上海 01:00–09:00 不生成 `work.wake`，其余时间按 UTC 15 分钟时间窗生成稳定 ID，并尝试发出积压事件。
- Supabase `work_event_subscriptions` / `work_event_deliveries`：RLS 拒绝普通客户端。专用 Edge Function 以服务端权限访问数据库，桥只持有独立随机 Token，数据库最高权限密钥不进入 Render。发送失败有有限重试，稳定 `eventId` 供接收方去重；服务休眠时已有事件仍在数据库中。订阅 30 天到期，ChatGPT 应在 `refreshBefore` 前刷新。

**当前状态：代码和本地测试已备好；数据库、定时调用、Render 配置及 Work 对话订阅尚待部署和真实验收。** 不应把代码通过测试等同于后台已唤醒。

## 部署顺序

1. 在专用 Supabase 项目上执行 `work-events/001_schema.sql` 和 `003_store_proxy.sql`，部署 `work-events/store-proxy/index.ts`，关闭 Edge Function 的平台 JWT 校验，由函数内部验证独立 Token；确认安全检查。不要复用其他业务项目。
2. 生成四个不同的随机 Token。仅把 Store Token 的 SHA-256 摘要写入 `work_event_bridge_auth`，把明文设置到独立 Render 服务的 `WORK_EVENTS_STORE_TOKEN`，把函数地址设为 `WORK_EVENTS_STORE_URL`；另外设置 `WORK_EVENTS_MCP_TOKEN`、`WORK_EVENTS_TICK_TOKEN`、`WORK_EVENTS_INGEST_TOKEN`，然后打开 `WORK_EVENTS_ENABLED=true`。保持 `BRIDGE_ISOLATED_MODE=true`、`BRIDGE_WAKE_ENABLED=false`，停用旧 Listener 定时唤醒 `BRIDGE_LISTENER_WAKE_ENABLED=false`。
3. 回调目标默认只接受 `chatgpt.com`、`openai.com` 及其子域；如果 Work 回调使用别的官方域，经核验后加入 `WORK_EVENTS_CALLBACK_HOSTS`。回调只接受 HTTPS、公开 IP，不跟随重定向。
4. 在专用 Supabase Vault 中创建 `xlc_work_tick`，值与 Render 的 `WORK_EVENTS_TICK_TOKEN` 一致，再执行 `work-events/002_schedule.sql`。检查 `cron.job_run_details` 与 `net._http_response`，确认 15 分钟任务实际运行。
5. 创建或更新专用 Work 插件，把认证的 `/mcp/work` 作为 MCP 2.0 入口；在 Work 对话订阅 `general.message` 与 `work.wake`，明确何时发言。保持旧插件 Listener 关闭。
6. 用认证的外部测试消息提交稳定 `eventId`，确认 Work 对话收到内容；重复提交相同 ID，应只投递一次。测试订阅、取消订阅、服务重启、冷启动、失败重试、静默时段和一轮真实 15 分钟唤醒。

**限制**：Render 免费实例冷启动会增加首次投递延迟；Supabase 免费项目和定时任务的可用性受平台限制，不能承诺严格准点或永久在线。定时检查只发信号，服务端不知道用户在 Work 对话中的最后活跃时间，是否联系用户要由对话上下文和订阅指令判断。当前独立通道没有向外部 Gateway 回信的持久化出站接口，外部消息触发的是 Work 对话，不代表已回复到原平台。
