# 谢临川 × 瑞幸：独立认证适配服务

## 当前状态

已验证真实 ChatGPT OAuth、工具发现、上海大学店门店查询、生椰拿铁搜索、商品详情和订单预览（测试当时 ¥14.94）。
下单保护代码已通过本地 mock 测试：独立 OAuth 下单权限、签名预览、原生逐单确认、前后价格核验和重复提交拦截。
**真实创建订单、客户端原生确认表单和支付/取餐状态尚待用户明确确认后的端到端验证；取消订单仍禁用。**

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
- 同一 MCP 地址同时兼容旧式 initialize 会话和 2026-07-28 的 server/discover、逐请求能力声明与 MRTR 原生确认。新版客户端的能力、requestState 与 inputResponses 不转发给瑞幸；服务独立维持瑞幸旧版传输会话。旧连接只在实际声明表单能力时发送旧式确认请求，新连接使用签名且一次性消费的 MRTR 确认状态。
- 启动时仅执行一次 initialize / initialized / tools/list 连接自检，并尽力关闭自检会话；日志仅含状态、工具名称及必填参数名，不执行 tools/call、不记录凭据或私人订单。
- 只代理实际 tools/list 返回的工具；查询保留官方 inputSchema。createOrder 使用最小安全包装，只接收签名预览凭据，向上游传递的门店、商品、坐标和优惠严格来自已核对的预览。ChatGPT 缓存工具 Schema、在新会话直接调用工具时，服务会先自动从瑞幸重新发现工具；并发首个查询共享一次发现请求，发现失败时不会执行工具。
- 开放六项实际存在的查询与预览工具；仅在官方实际提供兼容 createOrder Schema 时显示受保护的创建工具。
- 取消和未知工具始终阻止。旧 luckin:read 凭据不能创建订单；新 luckin:order 权限必须经 OAuth 登录另行同意。
- 没有请求正文、授权头、支付数据、地址或身份信息日志；响应额外去除服务端 Secret 原文。
- 连接诊断记录固定路由、请求方法分类、状态码、固定错误原因及 RPC 方法分类，用于区分请求未到达、登录拒绝、换码失败和 MCP 初始化失败；Origin 只记录同源/ChatGPT/不透明/缺失/其他分类。日志不包含完整 URL、查询串、请求头值、正文、授权码、凭据、口令、state、客户端标识或商品/订单参数。`/health` 返回诊断版本以核对部署。
- 不存在匿名使用瑞幸 Token 的路径；公开端点仅为健康检查、说明和 OAuth 发现/登录。

## 创建订单保护

1. 真实 previewOrder 成功后生成十分钟有效的签名预览凭据，绑定当前 OAuth 客户端、瑞幸授权、当前服务启动周期、门店、商品规格、数量、优惠及金额。凭据不是瑞幸 Token，也不能用于读取其他数据。
2. 助手先展示准确订单并等待用户明确确认；createOrder 另外要求 luckin:read + luckin:order 权限。
3. 旧协议在初始化时、新协议在每个请求的标准元数据中核对客户端表单能力；未声明时拒绝创建。模型传入的布尔值或“用户已确认”文字不能替代原生表单答复。OpenAI 新版扩展表单按官方 MRTR 格式返回，真实表单 Schema 放在扩展元数据中；空 acceptance 不会放行。
4. 原生表单显示完整订单摘要，confirmed 默认 false。旧式响应必须匹配原登录、会话及服务端请求 ID；MRTR 响应必须匹配签名状态、原登录、预览和当前启动周期，并单次消费。只有 action=accept 且 confirmed=true 才可继续。拒绝、取消、空答复、确认超时均不下单。
5. 确认前后各重新预览一次；门店、规格、数量、优惠或金额变化时要求重新预览并确认。
6. 每份凭据只使用一次。并发提交按门店与商品规格数量拦截；成功后十分钟内相同订单阻止再次创建，结果不明时同进程阻止二十四小时。任何创建错误或超时均不自动重试。
7. **去重记录保存在内存中，不是持久订单账本。** 服务重启后所有旧预览凭据失效，不能继续原次提交。此前若存在结果不明的提交，即使服务重启，也必须先在瑞幸核对是否已生成，再考虑新的预览和确认；不得把重启当作解除未知状态的办法。
8. 官方查询工具只接受 orderId；超时未取得订单 ID 时不能声称已通过 MCP 查询到结果，需用户在瑞幸自行核对。服务不代付、不输入支付密码、不自动取消订单。

查询凭据升级下单权限可能触发一次新的 OAuth 登录。工具及 Schema 更新后，ChatGPT 的自定义 MCP 连接也可能需要刷新工具列表；不能把服务部署成功视为客户端已获得创建工具。

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
6. 刷新客户端工具，验证单独下单授权及原生表单能力；不支持确认时保持拒绝创建。
7. 展示具体门店、商品、规格、数量和金额；明确确认后才创建；付款仍由用户完成。

必须继续遵守创建超时不重试、先核对是否已生成、取消需确认具体订单等要求。
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
