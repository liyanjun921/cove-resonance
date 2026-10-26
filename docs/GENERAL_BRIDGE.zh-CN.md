# 通用消息桥（测试版，独立于网易云）

这份实现参考 [mcp-app-message-bridge](https://github.com/wynsyl1014/mcp-app-message-bridge) 的三层分工：外部 Gateway / 后端队列、官方对话内的 MCP App Listener、AI 回复的外部出站接口。

## 现有结构

- `/mcp/music`：**原封不动**保留网易云专用操作与事件。
- `/mcp/bridge`：通用 Listener、事件同步、去重、回复工具，不再暴露网易云歌曲和播放工具。
- `POST /events`：通用外部事件入口；事件源不要用 `netease.` 开头。
- `GET /external/replies?eventId=...`：外部 Gateway 轮询回复（不返回其他事件的消息）。
- `POST /external/activity`：外部 Gateway 报告用户活跃，供可选 Wake Worker 判断静默。

**写入和读取接口都要求** `Authorization: Bearer <BRIDGE_INGEST_TOKEN>`。该 Token 只能保存在服务端，不允许放在网页 JS、MCP UI、聊天或提交到 GitHub。没有配置 Token 时通用 HTTP API 默认拒绝访问。

## 外部消息如何往返

1. 可信 Gateway 收到 PWA、其他聊天平台或网站的消息。
2. Gateway 带安全 Token 请求 `POST /events`，Body 例如：
   `{"eventId":"unique-message-1","source":"pwa.chat","text":"Hello"}`。
3. 已由用户主动开启的 ChatGPT **通用 Listener** 从队列领取事件；先 `ui/update-model-context` 再 `ui/message`，Host 可能要求人工确认。
4. AI 按模型上下文调用 `cove_bridge_reply({messages:[...]})`；工具只写入 `external.inbox`，**不会发给网易云**。
5. Gateway 带相同 Token 请求 `GET /external/replies?eventId=unique-message-1`。读到 `completed:true` 后，Gateway 才自行把回复送回对应 PWA / 聊天平台。

外部前端如需直接收发，仍要配自己的登录鉴权 Gateway。**不要从浏览器直接调用带主密钥的接口。**

## 唤醒事件

`BRIDGE_WAKE_ENABLED` 默认为 `false`。只有显式设为 `true` 才启动 Wake Worker，每分钟评估一次：

- 新加坡时区 01:00–09:00 不唤醒；
- 最新 *由外部 Gateway 报告的* 用户活跃后至少 45 分钟；
- Worker 两次入队至少隔 60 分钟；
- 唤醒使用 `wake.heartbeat` + state stream，旧的 pending 唤醒会被合并；
- 生成 Wake 事件不意味着已进入 ChatGPT、也不意味着 AI 已向用户发送消息。

**限制**：Worker 看不到 ChatGPT 官方聊天里用户刚发的消息。正式开启前，必须让可信 Gateway 提供可靠的活跃同步，否则不能拿它替代 Scheduled Tasks 的真实静默判断。Wake Worker 和回复队列当前都是进程内存，重启会丢状态，尚非无人值守的生产级系统。手机系统也可能挂起 Listener。

## 验收顺序

1. 执行 `npm run typecheck && npm test && npm run build`；
2. 部署后检查 `/mcp/bridge` 初始化与 `tools/list`，同时确认网易云工具**没有**出现在通用入口；
3. 未授权调用 `POST /events`、`GET /external/replies` 应是 `401`；
4. 启动 Listener，并用服务端 Gateway 带 Token 提交一条非网易云测试事件；
5. 确认当前官方对话收到 `ui/message`，必要时人工确认；
6. 确认 AI 调用了 `cove_bridge_reply` 且 `GET /external/replies` 返回 `completed:true`；
7. Wake Worker **保持关闭**，直到实际活跃度同步与队列持久化方案完成。

仓库代码写入与单元测试并不等于上述真实端到端验收。不要把 Host 接收、模型回复、Gateway 送达混为一次成功。

## Listener 发送失败诊断

通用 Listener 会把 `ui/message` 返回的错误消息和数字错误码保留在卡片中，后续空队列轮询不会清除它。这个错误可能来自用户取消、Host 拒绝或不支持该调用，不能统一解释为用户点了取消。事件仍保持终态，不会自动释放重发。

`cove_bridge_test_status` 的 `completed` 只表示收件箱回复完成；`endedWithoutReply:true` 表示事件已终止但未发送回复。对这种事件调用通用 `cove_bridge_reply` 会明确报错，不再声称“已送达，重复发送已拦截”。队列的历史 `delivered` 计数仍包含终态事件，不能作为 ChatGPT 前台消息或外部回复成功的验收依据。
