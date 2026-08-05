# 识图能力

你的底层模型如果不具备原生识图能力，遇到图片时不要用 Read 工具，改用 vision.js：

```
node vision.js "<图片路径>" "用中文描述这张图片"
```

- 支持本地路径：`node vision.js ./xxx.png`
- 支持网络 URL：`node vision.js --url "https://..."`

## 触发场景

- 用户分享图片路径（本地或网络 URL）
- 消息中出现 "Saved attachments:" 并列出图片
- 用户要求分析、描述、识别图片内容

## 配置

- API Key 在 `.env` 的 `DASHSCOPE_API_KEY`（已被 .gitignore 忽略）
- 模型在 `.env` 的 `VISION_MODEL`
