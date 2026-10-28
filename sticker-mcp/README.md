# 贴贴 · ChatGPT 私人表情包 MVP

独立分支 `feat/sticker-ui-chatgpt`，独立 Render 服务 `xlc-stickers`。工具：`search_stickers`、`send_sticker`、`list_sticker_categories`；UI 资源：`ui://xlc-stickers/picker.html` (MCP Apps HTML)。

部署环境变量：`MCP_PATH_KEY`（32+字符密码学随机）、`ADMIN_KEY`（不同的32+随机）、`PUBLIC_BASE_URL=https://xlc-stickers.onrender.com`。不要把密钥写进代码。MCP 地址 `https://xlc-stickers.onrender.com/mcp/<MCP_PATH_KEY>`，仅为个人测试的**高熵秘密链接**，客户端可选「无需认证」，但不能公开链接。管理员页面 `https://xlc-stickers.onrender.com/library`，管理员密钥在 Render Environment 中查询，不粘贴到聊天。首次图库包含原创测试占位图；上传 PNG/JPG/GIF/WebP 必须由用户主动授权。

**限制：Render 免费磁盘是临时的，重启或重新部署会丢失上传文件；当前不适合存储珍贵图片。** 后续使用持久化数据库/对象存储。ChatGPT MCP 输出是工具图片，不能让插件代替用户作为聊天消息按下发送键。官方 UI 资源是否可见须在 ChatGPT 安装后测试；若没有渲染，可通过聊天直接调用 MCP 工具。
