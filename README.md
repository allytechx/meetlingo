# 译会 MeetLingo MVP

面对面会议实时同传 + 双语记录 + AI会议纪要

## 功能

- 🎙 实时语音同传（支持11种外语 ↔ 中文）
- 🔊 中文→外语语音播报（S2S模式）
- 📝 双语字幕实时显示
- 🤖 自动说话人检测（根据语言自动切换方向）
- ⭐ 标记重点对话
- 📋 会后AI生成会议纪要（摘要+关键信息+待办+决议）
- 📥 导出会议记录

## 支持语言

英语、德语、法语、西班牙语、日语、韩语、俄语、意大利语、葡萄牙语、荷兰语、阿拉伯语

> 语音播报（S2S）支持：中/英/德/法/西/日/葡/印尼语

## 快速开始

### 本地运行

```bash
npm install
cp .env.example .env
# 编辑 .env 填入火山引擎API密钥
node server.js
```

访问 http://localhost:3000

### 部署到 Render

1. 将代码上传到 GitHub
2. 在 Render 连接仓库
3. 配置环境变量（4个API密钥）
4. 部署完成

## API密钥获取

需要4个环境变量：

| 变量名 | 说明 | 获取地址 |
|--------|------|----------|
| VOLC_APPID | 火山引擎语音技术AppID | https://console.volcengine.com/speech/service/8 |
| VOLC_ACCESS_TOKEN | 火山引擎语音技术AccessToken | 同上 |
| ARK_API_KEY | 火山引擎方舟API Key | https://console.volcengine.com/ark |
| ARK_MODEL_ENDPOINT_ID | 方舟模型接入点ID（推荐doubao-pro-32k） | 同上 |

## 技术栈

- 后端：Node.js + Express + ws (WebSocket)
- 前端：原生 HTML/CSS/JavaScript + Web Audio API
- AI：火山引擎豆包同传大模型 + 豆包文本大模型

## 项目结构

```
├── server.js          # 后端服务器
├── package.json       # 依赖配置
├── render.yaml        # Render部署配置
├── .env.example       # 环境变量模板
├── .gitignore         # Git忽略规则
├── public/            # 前端文件
│   ├── index.html     # 页面
│   ├── app.js         # 前端逻辑
│   └── style.css      # 样式
└── meetings/          # 会议记录存储（JSON）
```
