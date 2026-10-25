# Cove Resonance · Render + ChatGPT OAuth 接入手册（个人版）

本文件是当前 Fork 的部署与联调说明。**代码自动测试通过不等于 ChatGPT 客户端已成功授权，更不等于网易云一起听已接通。**

## 一、架构

网易云一起听 → Cove Bridge (Render 常驻 Docker) → ChatGPT 自定义 MCP App

你的 Bridge 与网易云 NIM 长连接应在云端常驻。只部署一个实例，先不要启用多节点自动扩缩容。

## 二、准备 Render（不要求用户本机装 Node）

1. 在 GitHub 检查 PR 测试均通过后，合并到自己的主分支；或让 Render 指向经验证的功能分支。
2. Render → New → Blueprint → 连接自己的 \`liyanjun921/cove-resonance\`，它会读取仓库根目录的 \`render.yaml\`。
3. 查看套餐、区域、费用后再确定创建。网易云长连接不适合会自动休眠的免费实例。
4. 首次创建时填私密环境变量；切勿贴到 ChatGPT 对话、GitHub 文件或截图里：
   - \`BRIDGE_PUBLIC_ORIGIN\`：最终 Render HTTPS Origin，例 \`https://你的服务名.onrender.com\`，**不带** \`/mcp\`；
   - \`COVE_OAUTH_PASSWORD\`：自定 16 字符以上的独立强密码，**在 ChatGPT OAuth 页面手动输入，不是 ChatGPT 密码**；
   - \`COVE_OAUTH_SIGNING_SECRET\`：系统产生的随机长串，保持稳定，修改会导致已注册的 OAuth Client ID 失效；
   - \`COVE_MCP_ACCESS_TOKEN\`、\`BRIDGE_INGEST_TOKEN\`：不同的随机长串，Render 生成并保密；
   - \`NETEASE_COOKIE\`：专门的网易云账号 Cookie，通常是 \`MUSIC_U=...\`，只粘贴 Render 环境变量里；
   - \`NODE_ENV=production\`、\`TOGETHER_ENABLED=true\`。
5. 部署成功后，打开 \`https://你的域名/\`；返回 \`ok:true\` 代表 Bridge 服务在响应，**不代表音乐已连通**。

## 三、ChatGPT 连接

自定义 MCP 应使用以下 URL：

\`\`\`text
https://你的服务名.onrender.com/mcp/music
\`\`\`

Bridge 同时提供 OAuth discovery 与认证端点：
- \`/.well-known/oauth-protected-resource/mcp/music\`
- \`/.well-known/oauth-authorization-server\`
- \`/oauth/register\`
- \`/oauth/authorize\`
- \`/oauth/token\`

服务启用 OAuth 需要 HTTPS origin + 至少 16 字符的 owner password + 至少 32 字符的 signing secret。OAuth 使用 PKCE S256，Authorization Code 与一次性 Refresh Token（服务内存存储）。授权登录页确认用户自愿发起连接后，输入 **Cove Owner Password**。

**注意：**此 OAuth 实现是为个人单实例准备的最小版本，仍需真实 ChatGPT 客户端兼容测试。部分客户端对 OAuth 发现路径、动态注册、跨域元数据或授权页面有更严格要求。未经联调，不能声称已可直接使用。

## 四、认证与安全限制

- \`/mcp\` 与 \`/mcp/music\` 只有持有正确 static bearer token 或完成 OAuth 的访问者才能使用。
- OAuth token 按 MCP 路径限制资源（\`/mcp/music\` token 不可用于 \`/mcp\`）。
- 生产环境 \`POST /events\` 必须带 \`BRIDGE_INGEST_TOKEN\`。
- 未配置任何身份验证时，生产环境 **拒绝**访问 MCP。
- 使用 OAuth 时不要把明文 owner password、Access Token 或网易云 Cookie 放在网址参数里。
- OAuth 授权码和令牌状态存储于服务器内存。**每次 Render 重启/重新部署后可能需要重新授权 ChatGPT**；持久化身份和队列属于后续工程工作。
- 生产部署的安全性尚未经过外部审计，个人测试时建议独立网易云测试账号。

## 五、验证顺序

1. GitHub Actions：\`npm test\` 与 \`npm run build\` 成功；
2. Render 正常提供 HTTPS；
3. 未登录访问 \`/mcp/music\` 返回 HTTP 401 + \`WWW-Authenticate\`，不可回退为无鉴权开放；
4. ChatGPT 添加自定义 MCP 并实际完成 OAuth；
5. 网易云专用账号收到一起听邀请、进入房间，聊天收发成功；
6. 播放状态、PAUSE、RESUME、GOTO 等以 **真实网易云手机端回执**为准；
7. iOS、网页端分别测试 Widget/Long-wait；同一时刻只开启一种 Listener。

## 六、边界

- 本项目使用 \`node-nim\` 原生模块，应保留 Debian \`node:22-slim\` 镜像，不推荐 Alpine。
- 当前 Bridge 使用内存队列：重启会丢未处理的 pending events。
- Long-wait 不是永久后台任务，45 秒等待上限需要由调用侧按意愿继续。
- 部署、登录 Cookie、OAuth 客户端联调尚未在用户的真实 Render/ChatGPT/网易云账户完成。
