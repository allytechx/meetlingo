# MeetBuddy - 会议同传助手

面对面会议实时同传：双向语音翻译 + 双语记录 + AI会议纪要。

## 功能

- 🎙 实时语音同传（中↔外）
- 📝 双语字幕实时显示
- 🔊 翻译结果语音播报（S2S模式）
- 💾 会议记录自动保存
- 🤖 AI会议纪要自动生成

## 技术栈

- 后端：Node.js + Express + WebSocket
- 前端：原生 HTML/CSS/JS
- 同传API：火山引擎豆包同声传译2.0（Protobuf二进制协议）
- 纪要API：火山引擎方舟豆包大模型

## 部署

### 环境变量

在 Render 控制台 → Environment 中配置：

| 变量名 | 说明 |
|--------|------|
| `VOLC_ACCESS_TOKEN` | 火山引擎同传API Key |
| `ARK_API_KEY` | 火山引擎方舟API Key |
| `ARK_MODEL_ENDPOINT_ID` | 方舟模型接入点ID |

### Render 部署

1. Fork 本仓库
2. Render → New → Web Service → 连接仓库
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. 配置环境变量
6. 部署完成

## 使用

1. 手机访问部署后的网址
2. 输入会议名称，选择语言
3. 点击「开始会议」，允许麦克风权限
4. 点击「对方」/「我」切换说话人
5. 会议结束后点击「结束」，查看记录和AI纪要
