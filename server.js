/**
 * MeetBuddy MVP - 后端服务器
 * 功能：
 *   1. 静态文件服务（前端页面）
 *   2. WebSocket代理 → 火山引擎同传API（Protobuf二进制协议）
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
const protobuf = require('protobufjs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;
const MEETINGS_DIR = path.join(__dirname, 'meetings');

if (!fs.existsSync(MEETINGS_DIR)) fs.mkdirSync(MEETINGS_DIR, { recursive: true });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Protobuf 消息定义
// ============================================================

const protoDefinition = `
syntax = "proto3";

message RequestMeta {
  string session_id = 1;
}

message User {
  string uid = 1;
  string did = 2;
}

message AudioConfig {
  string format = 1;
  string codec = 2;
  int32 rate = 3;
  int32 bits = 4;
  int32 channel = 5;
  bytes binary_data = 6;
}

message TargetAudioConfig {
  string format = 1;
  int32 rate = 2;
}

message Corpus {
  map<string, string> glossary_list = 1;
  repeated string hot_words_list = 2;
}

message Request {
  string mode = 1;
  bool is_custom_speaker = 2;
  int32 speech_rate = 3;
  string source_language = 4;
  string target_language = 5;
  Corpus corpus = 6;
  string speaker_id = 7;
}

message ClientMessage {
  RequestMeta request_meta = 1;
  int32 event = 2;
  User user = 3;
  AudioConfig source_audio = 4;
  TargetAudioConfig target_audio = 5;
  Request request = 6;
}

message ResponseMeta {
  string session_id = 1;
  int32 status_code = 2;
  string message = 3;
}

message BillingItem {
  string unit = 1;
  double quantity = 2;
}

message Billing {
  repeated BillingItem items = 1;
  int32 duration_msec = 2;
}

message ServerMessage {
  ResponseMeta response_meta = 1;
  int32 event = 2;
  int32 start_time = 3;
  int32 end_time = 4;
  string text = 5;
  bool spk_chg = 6;
  bytes data = 7;
  Billing billing = 8;
  int32 muted_duration_ms = 9;
}
`;

const root = protobuf.parse(protoDefinition).root;
const ClientMessage = root.lookupType('ClientMessage');
const ServerMessage = root.lookupType('ServerMessage');

// ============================================================
// 火山引擎同传API WebSocket代理
// ============================================================

const VOLC_AST_URL = 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate';

wss.on('connection', (clientWs) => {
  console.log('[Client] 前端已连接');
  let volcWs = null;
  let sessionId = null;
  let sessionStarted = false;
  let meetingData = {
    id: uuidv4(),
    startTime: new Date().toISOString(),
    segments: [],
    config: null
  };
  let currentSourceText = '';
  let currentTargetText = '';
  let currentSegment = null;

  clientWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'start':
          await startSession(msg.config);
          break;
        case 'audio':
          sendAudio(msg.audio);
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

  async function startSession(config) {
    meetingData.config = config;
    sessionId = uuidv4();
    sessionStarted = false;

    const apiKey = process.env.VOLC_ACCESS_TOKEN;

    if (!apiKey || apiKey === 'your_access_token_here' || apiKey === 'placeholder') {
      clientWs.send(JSON.stringify({
        type: 'error',
        message: '未配置火山引擎API密钥，请在Render环境变量中设置VOLC_ACCESS_TOKEN'
      }));
      return;
    }

    console.log('[Volc] 正在连接同传API (新版鉴权 + Protobuf协议)...');
    volcWs = new WebSocket(VOLC_AST_URL, {
      headers: {
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': 'volc.service_type.10053'
      }
    });

    volcWs.on('open', () => {
      console.log('[Volc] WebSocket连接已建立，发送StartSession...');

      const startMsg = {
        requestMeta: { sessionId: sessionId },
        event: 100,
        user: { uid: 'meetbuddy_' + Date.now(), did: 'web' },
        sourceAudio: { format: 'wav', rate: 16000, bits: 16, channel: 1 },
        targetAudio: { format: 'pcm', rate: 24000 },
        request: {
          mode: config.mode || 's2s',
          sourceLanguage: config.source_language || 'en',
          targetLanguage: config.target_language || 'zh',
          speakerId: 'zh_female_vv_uranus_bigtts'
        }
      };

      const errMsg = ClientMessage.verify(startMsg);
      if (errMsg) {
        console.error('[Volc] Protobuf消息验证失败:', errMsg);
        return;
      }

      const message = ClientMessage.create(startMsg);
      const buffer = ClientMessage.encode(message).finish();
      console.log('[Volc] StartSession消息内容:', JSON.stringify(startMsg, null, 2));
      console.log('[Volc] StartSession原始数据(hex):', buffer.toString('hex'));
      volcWs.send(buffer);
      console.log('[Volc] StartSession已发送, 长度:', buffer.length, 'bytes');
    });

    volcWs.on('message', (volcData) => {
      try {
        if (volcData instanceof Buffer || volcData instanceof ArrayBuffer) {
          const buffer = Buffer.from(volcData);

          try {
            const message = ServerMessage.decode(buffer);
            const resp = ServerMessage.toObject(message, { longs: String, enums: String, bytes: Buffer });

            console.log('[Volc] 收到消息, event:', resp.event, ', text:', resp.text ? resp.text.substring(0, 80) : '(无)');
            console.log('[Volc] 完整响应:', JSON.stringify({
              event: resp.event,
              responseMeta: resp.responseMeta,
              startTime: resp.startTime,
              endTime: resp.endTime,
              text: resp.text ? resp.text.substring(0, 100) : null,
              hasData: resp.data && resp.data.length > 0
            }));

            if (resp.responseMeta && resp.responseMeta.statusCode && resp.responseMeta.statusCode !== 20000000) {
              console.error('[Volc] API错误码:', resp.responseMeta.statusCode, ', 消息:', resp.responseMeta.message);
              clientWs.send(JSON.stringify({
                type: 'error',
                message: '同传API错误: ' + (resp.responseMeta.message || '错误码 ' + resp.responseMeta.statusCode)
              }));
              return;
            }

            handleVolcResponse(resp);
          } catch (decodeErr) {
            console.log('[Volc] Protobuf反序列化失败，可能是纯音频数据，长度:', buffer.length);
            console.log('[Volc] 原始数据(hex):', buffer.toString('hex').substring(0, 200));
            const base64 = buffer.toString('base64');
            clientWs.send(JSON.stringify({ type: 'tts_audio', audio: base64 }));
          }
        }
      } catch (e) {
        console.error('[Volc] 消息处理错误:', e.message);
      }
    });

    volcWs.on('error', (e) => {
      console.error('[Volc] 错误:', e.message);
      clientWs.send(JSON.stringify({ type: 'error', message: '火山引擎连接错误: ' + e.message }));
    });

    volcWs.on('close', (code, reason) => {
      console.log('[Volc] 连接关闭, code:', code, ', reason:', reason?.toString());
    });
  }

  function handleVolcResponse(resp) {
    const eventNum = resp.event;

    switch (eventNum) {
      case 150: // SessionStarted
        sessionStarted = true;
        console.log('[Volc] 会话已启动 ✅');
        clientWs.send(JSON.stringify({ type: 'session_started' }));
        break;

      case 650: // SourceSubtitleStart
        currentSourceText = '';
        currentSegment = {
          startTime: resp.startTime || 0,
          speaker: 'unknown',
          source: '',
          target: '',
          spkChg: resp.spkChg || false
        };
        break;

      case 651: // SourceSubtitleResponse
        if (resp.text) {
          currentSourceText = resp.text;
          clientWs.send(JSON.stringify({ type: 'source_partial', text: resp.text }));
        }
        break;

      case 652: // SourceSubtitleEnd
        if (currentSegment) {
          currentSegment.source = resp.text || currentSourceText;
          currentSegment.endTime = resp.endTime || currentSegment.startTime;
        }
        break;

      case 653: // TranslationSubtitleStart
        currentTargetText = '';
        break;

      case 654: // TranslationSubtitleResponse
        if (resp.text) {
          currentTargetText = resp.text;
          clientWs.send(JSON.stringify({ type: 'target_partial', text: resp.text }));
        }
        break;

      case 655: // TranslationSubtitleEnd
        if (currentSegment) {
          currentSegment.target = resp.text || currentTargetText;
          meetingData.segments.push({ ...currentSegment });
          clientWs.send(JSON.stringify({ type: 'segment_complete', segment: currentSegment }));
          currentSegment = null;
        }
        break;

      case 350: // TTSSentenceStart
        clientWs.send(JSON.stringify({ type: 'tts_start' }));
        break;

      case 352: // TTSResponse
        if (resp.data && resp.data.length > 0) {
          const base64 = Buffer.from(resp.data).toString('base64');
          clientWs.send(JSON.stringify({ type: 'tts_audio', audio: base64 }));
        }
        break;

      case 351: // TTSSentenceEnd
        clientWs.send(JSON.stringify({ type: 'tts_end' }));
        break;

      case 154: // UsageResponse
        if (resp.billing) {
          console.log('[Volc] 计费信息:', JSON.stringify(resp.billing));
        }
        break;

      case 152: // SessionFinished
        console.log('[Volc] 会话正常结束');
        clientWs.send(JSON.stringify({ type: 'session_finished', meetingId: meetingData.id }));
        saveMeeting();
        break;

      case 153: // SessionFailed
        console.error('[Volc] 会话失败');
        console.error('[Volc] SessionFailed完整响应:', JSON.stringify(resp, null, 2));
        if (resp.responseMeta) {
          console.error('[Volc] 错误码:', resp.responseMeta.statusCode, ', 错误消息:', resp.responseMeta.message);
        }
        clientWs.send(JSON.stringify({
          type: 'error',
          message: '同传会话失败: ' + (resp.responseMeta?.message || '请检查API密钥和服务开通状态')
        }));
        break;

      default:
        console.log('[Volc] 未处理的事件类型:', eventNum);
        break;
    }
  }

  function sendAudio(base64Audio) {
    if (!volcWs || volcWs.readyState !== WebSocket.OPEN) return;
    if (!sessionStarted) {
      console.log('[Volc] 等待SessionStarted，暂不发送音频');
      return;
    }

    try {
      const audioBuffer = Buffer.from(base64Audio, 'base64');
      const taskMsg = {
        requestMeta: { sessionId: sessionId },
        event: 200,
        user: { uid: 'meetbuddy_' + Date.now(), did: 'web' },
        sourceAudio: { binaryData: audioBuffer }
      };

      const errMsg = ClientMessage.verify(taskMsg);
      if (errMsg) {
        console.error('[Volc] TaskRequest验证失败:', errMsg);
        return;
      }

      const message = ClientMessage.create(taskMsg);
      const buffer = ClientMessage.encode(message).finish();
      volcWs.send(buffer);
    } catch (e) {
      console.error('[Volc] 发送音频失败:', e.message);
    }
  }

  function finishSession() {
    if (volcWs && volcWs.readyState === WebSocket.OPEN) {
      try {
        const finishMsg = {
          requestMeta: { sessionId: sessionId },
          event: 102,
          user: { uid: 'meetbuddy_' + Date.now(), did: 'web' }
        };
        const errMsg = ClientMessage.verify(finishMsg);
        if (!errMsg) {
          const message = ClientMessage.create(finishMsg);
          const buffer = ClientMessage.encode(message).finish();
          volcWs.send(buffer);
          console.log('[Volc] FinishSession已发送');
        }
      } catch (e) {
        console.error('[Volc] 发送FinishSession失败:', e.message);
      }
    }
  }

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

app.get('/api/meetings/:id', (req, res) => {
  const filePath = path.join(MEETINGS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '会议不存在' });
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  res.json(data);
});

app.post('/api/meetings/:id/summary', async (req, res) => {
  const filePath = path.join(MEETINGS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '会议不存在' });
  }

  const meeting = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const apiKey = process.env.ARK_API_KEY;
  const endpointId = process.env.ARK_MODEL_ENDPOINT_ID;

  if (!apiKey || apiKey === 'your_ark_api_key_here' || apiKey === 'placeholder') {
    return res.status(400).json({ error: '未配置豆包文本大模型API密钥（ARK_API_KEY）' });
  }

  let transcript = '';
  meeting.segments.forEach((seg) => {
    transcript += `${seg.source}\n`;
    transcript += `译文: ${seg.target}\n\n`;
  });

  const prompt = `你是一个专业的会议纪要助手。请根据以下双语会议转录，生成一份结构化的中文会议纪要。

会议转录：
${transcript}

请按以下格式输出（使用Markdown）：

## 会议摘要
（3-5句话概括会议核心内容）

## 关键信息
（提取所有数字、日期、金额、数量、承诺等关键信息，用列表呈现）

## 待办事项
（提取所有行动项，格式：- [ ] 任务内容）

## 决议与共识
（列出会议达成的所有决议和共识）

## 双语完整转录
（保留原文和译文的对照格式）`;

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
    meeting.summary = summary;
    meeting.summaryGeneratedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(meeting, null, 2));

    res.json({ summary, meetingId: meeting.id });
  } catch (e) {
    console.error('[Summary] 生成失败:', e.response?.data || e.message);
    res.status(500).json({ error: '纪要生成失败: ' + (e.response?.data?.error?.message || e.message) });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    volcConfigured: !!(process.env.VOLC_ACCESS_TOKEN && process.env.VOLC_ACCESS_TOKEN !== 'your_access_token_here' && process.env.VOLC_ACCESS_TOKEN !== 'placeholder'),
    arkConfigured: !!(process.env.ARK_API_KEY && process.env.ARK_API_KEY !== 'your_ark_api_key_here' && process.env.ARK_API_KEY !== 'placeholder'),
    meetings: fs.readdirSync(MEETINGS_DIR).filter(f => f.endsWith('.json')).length
  });
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log('  MeetBuddy MVP 服务器已启动');
  console.log('  本地访问: http://localhost:' + PORT);
  console.log('========================================');
  console.log('  配置状态:');
  console.log('    火山引擎同传API:', (process.env.VOLC_ACCESS_TOKEN && process.env.VOLC_ACCESS_TOKEN !== 'your_access_token_here' && process.env.VOLC_ACCESS_TOKEN !== 'placeholder') ? '✅ 已配置' : '❌ 未配置');
  console.log('    豆包文本大模型:', (process.env.ARK_API_KEY && process.env.ARK_API_KEY !== 'your_ark_api_key_here' && process.env.ARK_API_KEY !== 'placeholder') ? '✅ 已配置' : '❌ 未配置');
  console.log('    Protobuf协议: ✅ 已启用');
  console.log('========================================');
});
