# Render 安全部署预案（独立 Fork）

本文件为部署准备，不表示已上线，也不表示 ChatGPT 已连通网易云。

## 使用前

- 从 Render 创建 Blueprint（仓库根目录 render.yaml）；先确认套餐和费用。常驻 NIM 长连接不应依赖会休眠的免费实例。
- 环境变量里填 `NETEASE_COOKIE=MUSIC_U=...`。建议专用网易云账号，**不要发到聊天或提交 GitHub**。
- `BRIDGE_PUBLIC_ORIGIN` 填 Render 实际 HTTPS 域名，不能含 `/mcp`。
- `COVE_MCP_ACCESS_TOKEN` 与 `BRIDGE_INGEST_TOKEN` 要分别保持为长随机密钥，不要复用。
- 镜像基于 Debian node:22-slim；不要改成 Alpine。

## 访问保护

生产环境：
- `/mcp` 和 `/mcp/music` 要求 `Authorization: Bearer <COVE_MCP_ACCESS_TOKEN>`；
- `POST /events` 要求 `Authorization: Bearer <BRIDGE_INGEST_TOKEN>`；
- 令牌缺失则拒绝请求，不可为了联通而取消防护；
- 公共 `GET /` 健康检查不包含凭据。

**重要：ChatGPT 客户端能否为自定义 MCP 附带固定 Bearer Token，需要在客户端实际确认。** 若连接流程不支持固定 Authorization header，不能把 token 嵌进 MCP URL 或移除鉴权；应改用与 ChatGPT 兼容的 OAuth 2.1 / 身份验证网关，完成后才能公网接入。这是本版部署的明确阻塞项。

本 Blueprint 不会自动创建 OAuth 网关，不保证完成 ChatGPT 侧 MCP 安装。ChatGPT 侧接入与 iOS Listener 仍需真实联调。

## 检查

1. 在测试环境运行 `npm test && npm run build`。
2. 登录 Render 确认服务 Ready，且访问根目录只看到基础健康状态。
3. 使用无凭证请求 MCP 应得到 401；使用正确凭证请求 MCP 不应再返回 401。
4. 完成认证兼容后，再分别测试 NIM 在线、网易云房间邀请、实时收消息和 PAUSE / PLAY 的真实回执。
5. Widget Listener 与 Long-wait 二选一，不能同时消费同一队列。

## 已知边界

- Queue 当前是内存队列：重启可能丢失未处理消息。
- 免费实例可能休眠；保持一起听长连接建议稳定常驻实例。
- 部署过程中不应在日志中输出 Cookie 或访问令牌。
- 测试以实际 iOS 网易云和 ChatGPT 客户端结果为准。
