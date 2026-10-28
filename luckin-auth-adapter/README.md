# 谢临川 × 瑞幸：独立认证适配服务（阶段 B）

## 当前状态

本版本解决 ChatGPT OAuth 与瑞幸静态 Bearer 请求头之间的连接方式差异。
已在本地通过 OAuth 与 MCP 代理测试；测试中的上游明确为 mock，不能作为瑞幸真实连接成功的证据。
本服务已独立部署到 Render。真实 tools/list、门店查询、商品查询和订单预览须分别以实际响应验收，服务上线不能代替接口验证。
**创建和取消订单在此版本中始终禁用；没有环境变量可绕过。**

## 已核对的真实配置

- 上游：`https://gwmcp.lkcoffee.com/order/user/mcp`
- 传输：Streamable HTTP
- 认证：`Authorization: Bearer <瑞幸 Token>`
- 不保存用户真实 Token；用户提供的配置已脱敏。
- 官方端点无 Token 初始化的实测：HTTP 401，`oauth token is not found`。
- 401 提供的 OAuth 发现地址在测试环境返回 HTTP 403，不能据此保证瑞幸支持完整的 ChatGPT OAuth 流程。

## 实现

ChatGPT → 本服务 OAuth 授权 → 服务端加入瑞幸 Bearer → 瑞幸官方 MCP。

- 动态客户端注册仅允许 ChatGPT 的生产回调地址；不获取任意客户端 URL。
- 登录页 CSP 明确允许 ChatGPT 回调域名，避免 Chromium 阻止成功提交后的 303 回跳；应用仍按注册信息精确校验回调路径。
- OAuth 授权码 + PKCE S256；资源、客户端、回调地址绑定；授权码 120 秒内单次使用。
- 登录使用独立连接口令、同源检查、每次授权独立的签名表单及 CSRF Cookie，并限制尝试次数。此口令不是瑞幸 Token。
- 未过期的签名表单可跨服务重启验证；多个授权页的 Cookie 不会互相覆盖。Cookie 被阻止时，只有 Origin 精确匹配且 Fetch Metadata 明确表示同源原生表单导航，才可继续校验连接口令；跨站请求仍被拒绝。
- 访问凭据有效 24 小时，不提供可重用的非轮换刷新凭据；过期后需要重新连接。
- 注册的客户端使用签名标识，服务重启后仍有效。签名密钥轮换会撤销已签发的访问凭据和客户端标识。
- MCP 会话在内存中按连接隔离；重启或休眠后旧会话返回 404，由客户端重新初始化。
- 支持 JSON 与 SSE 上游响应；没有自动重试。
- 启动时仅执行一次 initialize / initialized / tools/list 连接自检，并尽力关闭自检会话；日志仅含状态、工具名称及必填参数名，不执行 tools/call、不记录凭据或私人订单。
- 只代理实际 tools/list 返回的工具；保留官方 inputSchema。
- 仅开放 queryShopList、searchProductForMcp、switchProduct、queryProductDetailInfo、previewOrder、queryOrderDetailInfo 中实际存在的工具。
- 过滤并阻止 createOrder、cancelOrder 和未知工具；阻止绕过列表直接调用。
- 没有请求正文、授权头、支付数据、地址或身份信息日志；响应额外去除服务端 Secret 原文。
- OAuth 调试日志仅记录“签发授权码”与“签发访问凭据”两个阶段及时间，不记录授权码、凭据、口令、state 或客户端标识。
- 不存在匿名使用瑞幸 Token 的路径；公开端点仅为健康检查、说明和 OAuth 发现/登录。

## 隔离部署

GitHub 连接工具不支持创建新仓库，因此使用现有 `cove-resonance` 仓库的独立新分支
`feat/luckin-auth-adapter` 与 `luckin-auth-adapter/` 目录，新建独立 Render Web Service。
不更新 main 或现有服务使用的任何分支，不触发其他项目部署。
用户已明确选择 Render 的 `My Workspace`。

Render 设置：

| 项目 | 值 |
|---|---|
| Runtime | Docker，最终以非 root 用户运行 |
| Docker context | `luckin-auth-adapter` |
| Dockerfile | `luckin-auth-adapter/Dockerfile` |
| Build | Docker 多阶段构建执行 `npm test` 与 `npm run check` |
| Start | `node server.mjs` |
| Plan | free（首次连接可能需等待唤醒；付费升级另行决定） |
| Health check | `/health` |
| Region | 选择用户确认工作区中适合的新加坡区域，或与相关服务所在区一致 |

仅在该服务的 Render Environment 填写：

| 变量 | 要求 |
|---|---|
| `LUCKIN_TOKEN` | 瑞幸原始 Token，可省略 Bearer 前缀；不要引号、反引号、换行或占位符 |
| `OWNER_LOGIN_SECRET` | 独立随机连接口令，至少 32 字符，用于 OAuth 登录页 |
| `ADAPTER_SIGNING_KEY` | 另一份独立随机密钥，至少 32 字符；不得与连接口令相同 |

Render 自动提供 `RENDER_EXTERNAL_URL`。如使用自定义域名，可显式填写 `PUBLIC_BASE_URL` 为 HTTPS 源地址，不含路径。
应用不提供瑞幸 Token 输入网页、不把 Token 交给 ChatGPT、不在仓库保存任何真实凭据。

配置后在 Render 选择 Save and deploy；启动成功不等于瑞幸接口已验证。

## ChatGPT 连接（部署完成后）

- URL：`https://实际服务域名/mcp`
- Authentication：OAuth
- 使用服务公开的 DCR 注册流程，不填写虚构的 Client ID 或 Client Secret。
- OAuth 页面只填写 `OWNER_LOGIN_SECRET`。
- 安装并在谢临川窗口调用后，用真实 tools/list 验证工具发现。

## 验收顺序

1. 未认证 `/mcp` 返回 401，不能触达瑞幸。
2. OAuth 发现、注册、登录、回调和 PKCE 交换通过。
3. 使用真实瑞幸 Token 初始化并发现实际工具，记录真实参数 Schema。
4. 用户提供门店或地理位置后，再查询真实门店；不推测用户位置。
5. 商品搜索、详情、规格及预览返回真实价格。
6. 根据真实接口和 ChatGPT 实际确认机制完成交易确认接入，之后才考虑开放写工具。
7. 展示具体门店、商品、规格、数量和金额；明确确认后才创建；付款仍由用户完成。

后续版本必须继续遵守创建超时不重试、先核对是否已生成、取消需确认具体订单等要求。
本阶段不声明订单创建或订单查询验收已完成。

## 本地开发验证

用户无需在自己的电脑安装 Node.js。以下命令仅供工程环境与 Render 自动构建使用：

```sh
npm test
npm run check
```

代码仅使用 Node 内置模块，无外部 npm 运行依赖。

工程环境有 Playwright 与 Chromium 时，可额外运行 `node test/oauth-browser.mjs`。
该测试使用本地模拟凭据，并仅在测试服务层把浏览器的回调接收地址映射到本地；应用的注册回调 URI、issuer、state、PKCE 和换码参数仍按 ChatGPT 回调规则验证。
它覆盖原生表单提交、CSP、303 跨源回跳、正常 Cookie 与 Cookie 被阻止两条路径，不替代用户的真实 ChatGPT 授权验收。
