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

## 图片与存储

- `stickers.json` 是持久化目录；旧图库的原图链接暂时保留为第三方 URL，尚未逐一验证。
- 新增图片会放在 `sticker-mcp/assets/`，通过公开 GitHub 原始文件地址加载；图片随 Git 提交保存，不依赖 Render 临时磁盘。
- 新图片目录项需要同时更新 `stickers.json`，并使用已提交图片的不可变 commit SHA 作为图片 URL 的版本段。
- ChatGPT 对话里上传图片后，可由维护流程提交到仓库并更新目录。`/library` 页面上的直接上传仍写入 Render 临时文件系统，仅适合临时测试；不要用它保存唯一原图。
- 支持 PNG/JPG/GIF/WebP，单图最大 6MB、3000×3000 像素。公开仓库意味着图片和文件名可被任何人访问，请勿上传隐私截图或不适合公开的内容。
