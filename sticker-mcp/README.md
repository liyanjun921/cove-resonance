# 贴贴 · ChatGPT 私人表情包 MCP App

独立分支 `feat/sticker-ui-chatgpt`，独立 Render 服务 `xlc-stickers`。

## 工具与默认交互

- `search_stickers`：后台检索并返回候选元数据，不绑定图库 UI，因此正常搜索不会弹出图库。
- `send_sticker`：AI 选定一张图后调用，绑定 `ui://xlc-stickers/single.html`，只渲染这一张图片。
- `open_sticker_library`：只有用户明确要求浏览、查看全部或自己挑选时才调用，绑定 `ui://xlc-stickers/picker.html`。
- `list_sticker_categories`：按需返回分类和数量，不渲染 UI。

单图 UI 从 `structuredContent.image_url` 读取 HTTPS 图片地址，并只显示图片本身。它是 ChatGPT 回复里的 MCP App，不会代替用户在原生聊天输入框发送消息。客户端对 MCP App UI 的支持可能不同；优先在 ChatGPT 网页端验收，再测试 iOS。

## 部署

Render 环境变量：
- `MCP_PATH_KEY`：32+ 字符密码学随机密钥。
- `ADMIN_KEY`：与 MCP 密钥不同的 32+ 字符随机密钥。
- `PUBLIC_BASE_URL=https://xlc-stickers.onrender.com`

MCP 地址：`https://xlc-stickers.onrender.com/mcp/<MCP_PATH_KEY>`。这是高熵秘密路径，客户端可选「无需认证」，但完整地址本身必须保密。管理员页面：`https://xlc-stickers.onrender.com/library`。管理员密钥只在 Render Environment 中查看，不要粘贴到聊天。

修改 MCP 工具或 UI 后，等待 Render 部署成功，然后在 ChatGPT 连接器里刷新/重新连接，让客户端重新读取工具描述和 UI 资源。

## 图片与存储限制

图库支持 PNG/JPG/GIF/WebP，单图最大 6MB、3000×3000 像素。上传图片前需由用户主动授权。媒体 URL 使用短期签名链接。

**Render 免费磁盘是临时的**，重启或重新部署可能丢失上传文件；当前只适合测试，不适合存储珍贵图片。后续需要迁移到持久化数据库/对象存储。
