/**
 * MeetLingo MVP - 后端服务器
 * 功能：
 *   1. 静态文件服务（前端页面）
 *   2. WebSocket代理 → 火山引擎同传API
 *   3. 会议录音/转录存储
 *   4. AI会议纪要生成（豆包文本大模型）
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;
const MEETINGS_DIR = path.join(__dirname, 'meetings');

// 确保会议目录存在
if (!fs.existsSync(MEETINGS_DIR)) fs.mkdirSync(MEETINGS_DIR, { recursive: true });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 火山引擎同传API WebSocket代理
// ============================================================

const VOLC_AST_URL = 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate';

wss.on('connection', (clientWs, req) => {
  console.log('[Client] 前端已连接');
  let volcWs = null;
  let sessionId = null;
  let meetingData = {
    id: uuidv4(),
    startTime: new Date().toISOString(),
    segments: [],
    config: null
  };
  let currentSourceText = '';
  let currentTargetText = '';
  let currentSegment = null;

  // 接收前端消息
  clientWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'start':
          await startSession(msg.config);
          break;
        case 'audio':
          sendAudio(msg.audio); // base64编码的PCM数据
          break;
        case 'stop':
          finishSession();
          break;
        case 'ping':
          clientWs.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    } catch (e) {
      console.error('[Client] 消息处理错误:', e.message);
    }
  });

  clientWs.on('close', () => {
    console.log('[Client] 前端断开');
    if (volcWs && volcWs.readyState === WebSocket.OPEN) {
      try { volcWs.close(); } catch (e) {}
    }
    saveMeeting();
  });

  clientWs.on('error', (e) => {
    console.error('[Client] 错误:', e.message);
  });

  // 建立与火山引擎的连接
  async function startSession(config) {
    meetingData.config = config;
    sessionId = uuidv4();

    const appid = process.env.VOLC_APPID;
    const token = process.env.VOLC_ACCESS_TOKEN;

    if (!appid || !token || appid === 'your_app_id_here') {
      clientWs.send(JSON.stringify({
        type: 'error',
        message: '未配置火山引擎API密钥，请在.env文件中设置VOLC_APPID和VOLC_ACCESS_TOKEN'
      }));
      return;
    }

    // 构建鉴权URL
    const url = `${VOLC_AST_URL}?appid=${appid}&access_token=${token}`;

    console.log('[Volc] 正在连接同传API...');
    volcWs = new WebSocket(url, {
      headers: {
        'X-Api-App-Key': appid
      }
    });

    volcWs.on('open', () => {
      console.log('[Volc] 连接已建立，发送StartSession...');

      const startMsg = {
        request_meta: { session_id: sessionId },
        event: 'StartSession',
        user: { uid: 'meetlingo_' + Date.now(), did: 'web' },
        source_audio: { format: 'wav', rate: 16000, bits: 16, channel: 1 },
        target_audio: config.mode === 's2s' ? { format: 'pcm', rate: 24000 } : undefined,
        request: {
          mode: config.mode || 's2t',
          source_language: config.source_language || 'en',
          target_language: config.target_language || 'zh',
          speech_rate: 0,
          corpus: config.glossary ? {
            glossary_list: config.glossary
          } : {}
        }
      };

      volcWs.send(JSON.stringify(startMsg));
    });

    volcWs.on('message', (volcData) => {
      try {
        // 尝试解析为JSON（控制消息）
        const text = volcData.toString();
        const resp = JSON.parse(text);
        handleVolcResponse(resp);
      } catch (e) {
        // 二进制数据（TTS音频）
        if (volcData instanceof Buffer || volcData instanceof ArrayBuffer) {
          const base64 = Buffer.from(volcData).toString('base64');
          clientWs.send(JSON.stringify({ type: 'tts_audio', audio: base64 }));
        }
      }
    });

    volcWs.on('error', (e) => {
      console.error('[Volc] 错误:', e.message);
      clientWs.send(JSON.stringify({ type: 'error', message: '火山引擎连接错误: ' + e.message }));
    });

    volcWs.on('close', (code, reason) => {
      console.log('[Volc] 连接关闭:', code, reason?.toString());
    });
  }

  // 处理火山引擎返回
  function handleVolcResponse(resp) {
    const event = resp.event;
    // event可能是数字或字符串
    const eventNum = typeof event === 'number' ? event : parseInt(event);

    switch (eventNum) {
      case 150: // SessionStarted
        console.log('[Volc] 会话已启动');
        clientWs.send(JSON.stringify({ type: 'session_started' }));
        break;

      case 650: // SourceSubtitleStart
        currentSourceText = '';
        currentSegment = {
          startTime: resp.start_time || 0,
          speaker: 'unknown',
          source: '',
          target: '',
          spkChg: resp.spk_chg || false
        };
        break;

      case 651: // SourceSubtitleResponse
        if (resp.text) {
          currentSourceText = resp.text;
          clientWs.send(JSON.stringify({
            type: 'source_partial',
            text: resp.text
          }));
        }
        break;

      case 652: // SourceSubtitleEnd
        if (currentSegment) {
          currentSegment.source = resp.text || currentSourceText;
          currentSegment.endTime = resp.end_time || currentSegment.startTime;
        }
        break;

      case 653: // TranslationSubtitleStart
        currentTargetText = '';
        break;

      case 654: // TranslationSubtitleResponse
        if (resp.text) {
          currentTargetText = resp.text;
          clientWs.send(JSON.stringify({
            type: 'target_partial',
            text: resp.text
          }));
        }
        break;

      case 655: // TranslationSubtitleEnd
        if (currentSegment) {
          currentSegment.target = resp.text || currentTargetText;
          // 完整segment保存
          meetingData.segments.push({ ...currentSegment });
          clientWs.send(JSON.stringify({
            type: 'segment_complete',
            segment: currentSegment
          }));
          currentSegment = null;
        }
        break;

      case 350: // TTSSentenceStart
        clientWs.send(JSON.stringify({ type: 'tts_start' }));
        break;

      case 352: // TTSResponse - 音频数据在二进制消息中处理
        break;

      case 351: // TTSSentenceEnd
        clientWs.send(JSON.stringify({ type: 'tts_end' }));
        break;

      case 154: // UsageResponse
        if (resp.billing) {
          clientWs.send(JSON.stringify({ type: 'usage', billing: resp.billing }));
        }
        break;

      case 152: // SessionFinished
        console.log('[Volc] 会话正常结束');
        clientWs.send(JSON.stringify({ type: 'session_finished', meetingId: meetingData.id }));
        saveMeeting();
        break;

      case 153: // SessionFailed
        console.error('[Volc] 会话失败');
        clientWs.send(JSON.stringify({ type: 'error', message: '同传会话失败' }));
        break;

      default:
        // 其他事件忽略
        break;
    }
  }

  // 发送音频数据
  function sendAudio(base64Audio) {
    if (!volcWs || volcWs.readyState !== WebSocket.OPEN) return;

    const audioBuffer = Buffer.from(base64Audio, 'base64');

    const taskMsg = {
      event: 'TaskRequest',
      source_audio: { data: audioBuffer }
    };

    // 发送JSON+二进制混合格式
    // 先发送JSON头，再发送二进制
    volcWs.send(JSON.stringify(taskMsg));
  }

  // 结束会话
  function finishSession() {
    if (volcWs && volcWs.readyState === WebSocket.OPEN) {
      volcWs.send(JSON.stringify({ event: 'FinishSession' }));
    }
  }

  // 保存会议数据
  function saveMeeting() {
    if (meetingData.segments.length === 0) return;
    meetingData.endTime = new Date().toISOString();
    const filePath = path.join(MEETINGS_DIR, `${meetingData.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(meetingData, null, 2));
    console.log('[Meeting] 会议已保存:', meetingData.id, '共', meetingData.segments.length, '段');
  }
});

// ============================================================
// REST API
// ============================================================

// 获取会议列表
app.get('/api/meetings', (req, res) => {
  const files = fs.readdirSync(MEETINGS_DIR).filter(f => f.endsWith('.json'));
  const meetings = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(MEETINGS_DIR, f), 'utf8'));
    return {
      id: data.id,
      startTime: data.startTime,
      endTime: data.endTime,
      segmentCount: data.segments.length,
      config: data.config
    };
  }).sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  res.json(meetings);
});

// 获取单个会议详情
app.get('/api/meetings/:id', (req, res) => {
  const filePath = path.join(MEETINGS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '会议不存在' });
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  res.json(data);
});

// 生成AI会议纪要
app.post('/api/meetings/:id/summary', async (req, res) => {
  const filePath = path.join(MEETINGS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '会议不存在' });
  }

  const meeting = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const apiKey = process.env.ARK_API_KEY;
  const endpointId = process.env.ARK_MODEL_ENDPOINT_ID;

  if (!apiKey || apiKey === 'your_ark_api_key_here') {
    return res.status(400).json({ error: '未配置豆包文本大模型API密钥（ARK_API_KEY）' });
  }

  // 构建双语转录文本
  let transcript = '';
  meeting.segments.forEach((seg, i) => {
    transcript += `[${formatTime(seg.startTime)}] ${seg.source}\n`;
    transcript += `译文: ${seg.target}\n\n`;
  });

  const prompt = `你是一个专业的会议纪要助手。请根据以下双语会议转录，生成一份结构化的中文会议纪要。

会议信息：
- 开始时间：${meeting.startTime}
- 语言对：${meeting.config?.source_language || '?'} → ${meeting.config?.target_language || '?'}

会议转录：
${transcript}

请按以下格式输出（使用Markdown）：

## 会议摘要
（3-5句话概括会议核心内容）

## 关键信息
（提取所有数字、日期、金额、数量、承诺等关键信息，用列表呈现）

## 待办事项
（提取所有行动项，格式：- [ ] 任务内容 | 负责人 | 截止时间）

## 决议与共识
（列出会议达成的所有决议和共识）

## 双语完整转录
（保留原文和译文的时间轴对照格式）`;

  try {
    console.log('[Summary] 正在生成AI纪要...');
    const response = await axios.post(
      'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      {
        model: endpointId || 'doubao-pro-32k',
        messages: [
          { role: 'system', content: '你是一个专业的会议纪要助手，擅长从双语对话中提取关键信息、待办事项和决议。输出必须使用中文。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 4000
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    const summary = response.data.choices[0].message.content;

    // 保存纪要到会议文件
    meeting.summary = summary;
    meeting.summaryGeneratedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(meeting, null, 2));

    res.json({ summary, meetingId: meeting.id });
  } catch (e) {
    console.error('[Summary] 生成失败:', e.response?.data || e.message);
    res.status(500).json({ error: '纪要生成失败: ' + (e.response?.data?.error?.message || e.message) });
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    volcConfigured: !!(process.env.VOLC_APPID && process.env.VOLC_APPID !== 'your_app_id_here'),
    arkConfigured: !!(process.env.ARK_API_KEY && process.env.ARK_API_KEY !== 'your_ark_api_key_here'),
    meetings: fs.readdirSync(MEETINGS_DIR).filter(f => f.endsWith('.json')).length
  });
});

// 工具函数
function formatTime(ms) {
  if (!ms) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

server.listen(PORT, () => {
  console.log('========================================');
  console.log('  MeetLingo MVP 服务器已启动');
  console.log('  本地访问: http://localhost:' + PORT);
  console.log('  手机扫码需部署到公网或使用内网穿透');
  console.log('========================================');
  console.log('  配置状态:');
  console.log('    火山引擎同传API:', process.env.VOLC_APPID && process.env.VOLC_APPID !== 'your_app_id_here' ? '✅ 已配置' : '❌ 未配置');
  console.log('    豆包文本大模型:', process.env.ARK_API_KEY && process.env.ARK_API_KEY !== 'your_ark_api_key_here' ? '✅ 已配置' : '❌ 未配置');
  console.log('========================================');
});
