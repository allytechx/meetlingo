/**
 * MeetLingo MVP - 前端主逻辑
 * 功能：录音、同传、双语字幕、语音播报、会议记录、AI纪要
 */

// ===== 全局状态 =====
const state = {
  currentView: 'setup',
  ws: null,
  mediaStream: null,
  audioContext: null,
  scriptProcessor: null,
  sourceNode: null,
  isRecording: false,
  isPaused: false,
  isMuted: false,
  currentSpeaker: 'other', // 'other' = 对方说话, 'me' = 我说话, 'auto' = 自动检测
  autoSpeaker: false,
  lastAutoSwitch: 0,
  analyserNode: null,
  meetingStartTime: null,
  timerInterval: null,
  segments: [],
  currentSegment: null,
  meetingId: null,
  meetingName: '',
  config: null,
  ttsAudioQueue: [],
  isPlayingTTS: false,
  markedSegments: new Set()
};

// ===== DOM 元素 =====
const $ = (id) => document.getElementById(id);
const views = {
  setup: $('view-setup'),
  meeting: $('view-meeting'),
  result: $('view-result')
};

// ===== 工具函数 =====
function showToast(msg, duration = 2500) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

function switchView(viewName) {
  Object.values(views).forEach(v => v.classList.remove('active'));
  views[viewName].classList.add('active');
  state.currentView = viewName;
}

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatDateTime(isoStr) {
  const d = new Date(isoStr);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ===== 音频处理 =====

/**
 * 初始化麦克风和音频处理
 */
async function initAudio() {
  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000
      }
    });

    state.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000
    });

    state.sourceNode = state.audioContext.createMediaStreamSource(state.mediaStream);

    // 添加音量分析节点
    state.analyserNode = state.audioContext.createAnalyser();
    state.analyserNode.fftSize = 256;
    state.sourceNode.connect(state.analyserNode);

    // 使用ScriptProcessorNode获取原始PCM数据
    state.scriptProcessor = state.audioContext.createScriptProcessor(4096, 1, 1);

    state.sourceNode.connect(state.scriptProcessor);
    state.scriptProcessor.connect(state.audioContext.destination);

    state.scriptProcessor.onaudioprocess = (e) => {
      if (!state.isRecording || state.isPaused || state.isMuted) return;

      const inputData = e.inputBuffer.getChannelData(0);
      // 重采样到16kHz并转换为16位PCM
      const pcm16 = resampleTo16kHzPCM16(inputData, e.inputBuffer.sampleRate);

      // 发送到后端（每包约100ms）
      if (pcm16.length > 0 && state.ws && state.ws.readyState === WebSocket.OPEN) {
        const base64 = arrayBufferToBase64(pcm16.buffer);
        state.ws.send(JSON.stringify({ type: 'audio', audio: base64 }));
      }
    };

    return true;
  } catch (e) {
    console.error('麦克风初始化失败:', e);
    showToast('无法访问麦克风，请检查权限设置');
    return false;
  }
}

/**
 * 将Float32音频数据重采样到16kHz并转换为16位PCM
 */
function resampleTo16kHzPCM16(float32Data, sourceSampleRate) {
  const targetSampleRate = 16000;
  const ratio = sourceSampleRate / targetSampleRate;
  const targetLength = Math.floor(float32Data.length / ratio);
  const pcm16 = new Int16Array(targetLength);

  for (let i = 0; i < targetLength; i++) {
    const sourceIndex = Math.floor(i * ratio);
    let sample = float32Data[sourceIndex] || 0;
    // 限幅
    sample = Math.max(-1, Math.min(1, sample));
    // 转换为16位整数
    pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
  }

  return pcm16;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * 播放TTS音频（PCM格式，24kHz）
 */
function playTTSAudio(base64Audio) {
  if (!base64Audio) return;

  try {
    const pcmData = new Int16Array(base64ToArrayBuffer(base64Audio));
    const sampleRate = 24000;
    const float32 = new Float32Array(pcmData.length);

    for (let i = 0; i < pcmData.length; i++) {
      float32[i] = pcmData[i] / (pcmData[i] < 0 ? 0x8000 : 0x7FFF);
    }

    if (!state.audioContext) {
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    const audioBuffer = state.audioContext.createBuffer(1, float32.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32);

    const source = state.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(state.audioContext.destination);
    source.start(0);
  } catch (e) {
    console.error('TTS播放失败:', e);
  }
}

function stopAudio() {
  if (state.scriptProcessor) {
    state.scriptProcessor.disconnect();
    state.scriptProcessor = null;
  }
  if (state.sourceNode) {
    state.sourceNode.disconnect();
    state.sourceNode = null;
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(t => t.stop());
    state.mediaStream = null;
  }
}

// ===== WebSocket 通信 =====

function connectWebSocket(config) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    console.log('[WS] 已连接');
    // 发送开始会话
    state.ws.send(JSON.stringify({ type: 'start', config }));
  };

  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (e) {
      console.error('WS消息解析失败:', e);
    }
  };

  state.ws.onerror = (e) => {
    console.error('[WS] 错误:', e);
  };

  state.ws.onclose = () => {
    console.log('[WS] 断开');
  };
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'session_started':
      console.log('[同传] 会话已启动');
      break;

    case 'source_partial':
      $('sourceText').textContent = msg.text;
      // 自动说话人检测
      autoDetectSpeaker(msg.text);
      break;

    case 'target_partial':
      $('targetText').textContent = msg.text;
      break;

    case 'segment_complete':
      addTranscriptItem(msg.segment);
      // 清空当前字幕
      $('sourceText').textContent = '等待说话...';
      $('targetText').textContent = '';
      break;

    case 'tts_audio':
      playTTSAudio(msg.audio);
      break;

    case 'session_finished':
      state.meetingId = msg.meetingId;
      console.log('[同传] 会话结束, meetingId:', msg.meetingId);
      break;

    case 'error':
      console.error('[同传] 错误:', msg.message);
      showToast(msg.message, 4000);
      break;

    case 'usage':
      // 计费信息，可用于显示
      break;
  }
}

function disconnectWebSocket() {
  if (state.ws) {
    if (state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'stop' }));
    }
    state.ws.close();
    state.ws = null;
  }
}

/**
 * 切换说话人（需要重新建立WebSocket连接，因为API不支持会话中切换语言）
 */
function switchSpeaker(speaker) {
  if (speaker === 'auto') {
    state.autoSpeaker = !state.autoSpeaker;
    if (state.autoSpeaker) {
      showToast('🤖 自动检测模式已开启');
    } else {
      showToast('自动检测模式已关闭');
    }
    updateSpeakerUI();
    return;
  }

  if (state.currentSpeaker === speaker) return;

  // 切换到手动模式时关闭自动
  state.autoSpeaker = false;
  state.currentSpeaker = speaker;
  updateSpeakerUI();

  // 重新连接WebSocket（切换语言方向）
  if (state.isRecording) {
    reconnectWithNewConfig();
  }
}

function buildConfig() {
  const sourceLang = $('sourceLang').value;
  const enableTTS = $('enableTTS').checked;

  let config;
  if (state.currentSpeaker === 'other') {
    // 对方说话：外语 → 中文，只用S2T（字幕模式）
    config = {
      mode: 's2t',
      source_language: sourceLang,
      target_language: 'zh'
    };
  } else {
    // 我说话：中文 → 外语，用S2S（字幕+语音播报）
    config = {
      mode: enableTTS ? 's2s' : 's2t',
      source_language: 'zh',
      target_language: sourceLang
    };
  }

  // 添加术语库
  const glossaryText = $('glossaryInput').value.trim();
  if (glossaryText) {
    const glossary = {};
    glossaryText.split('\n').forEach(line => {
      const parts = line.split('=');
      if (parts.length === 2) {
        glossary[parts[0].trim()] = parts[1].trim();
      }
    });
    if (Object.keys(glossary).length > 0) {
      config.glossary = glossary;
    }
  }

  return config;
}

// ===== 会议控制 =====

async function startMeeting() {
  const meetingName = $('meetingName').value.trim() || '未命名会议';
  state.meetingName = meetingName;
  state.segments = [];
  state.markedSegments.clear();

  // 初始化音频
  const audioOk = await initAudio();
  if (!audioOk) return;

  // 切换到会议界面
  $('meetingTitleDisplay').textContent = meetingName;
  $('transcriptList').innerHTML = '';
  $('sourceText').textContent = '等待对方说话...';
  $('targetText').textContent = '';
  switchView('meeting');

  // 开始计时
  state.meetingStartTime = Date.now();
  state.timerInterval = setInterval(() => {
    const elapsed = Date.now() - state.meetingStartTime;
    $('meetingTimer').textContent = formatTime(elapsed);
  }, 1000);

  // 启动音量指示器
  state.volumeInterval = setInterval(updateVolumeMeter, 100);

  // 开始录音和同传
  state.isRecording = true;
  state.currentSpeaker = 'other';
  state.autoSpeaker = false;
  updateSpeakerUI();
  state.config = buildConfig();
  connectWebSocket(state.config);

  showToast('会议已开始，点击切换说话人');
}

function pauseMeeting() {
  state.isPaused = !state.isPaused;
  const btn = $('btnPause');
  if (state.isPaused) {
    btn.innerHTML = '▶<span>继续</span>';
    showToast('已暂停');
  } else {
    btn.innerHTML = '⏸<span>暂停</span>';
    showToast('已继续');
  }
}

function muteMeeting() {
  state.isMuted = !state.isMuted;
  const btn = $('btnMute');
  if (state.isMuted) {
    btn.innerHTML = '🔊<span>取消静音</span>';
    showToast('麦克风已静音');
  } else {
    btn.innerHTML = '🔇<span>静音</span>';
    showToast('麦克风已恢复');
  }
}

function markCurrent() {
  // 标记最后一个segment
  if (state.segments.length > 0) {
    const lastIdx = state.segments.length - 1;
    state.markedSegments.add(lastIdx);
    const items = document.querySelectorAll('.transcript-item');
    if (items.length > 0) {
      items[items.length - 1].classList.add('marked');
    }
    showToast('已标记为重点');
  } else {
    showToast('暂无对话可标记');
  }
}

function endMeeting() {
  if (!confirm('确定要结束本次会议吗？')) return;

  state.isRecording = false;
  clearInterval(state.timerInterval);
  if (state.volumeInterval) clearInterval(state.volumeInterval);

  // 断开WebSocket
  disconnectWebSocket();

  // 停止音频
  stopAudio();

  // 等待一下让后端保存会议
  setTimeout(() => {
    loadMeetingResult();
  }, 500);
}

function addTranscriptItem(segment) {
  state.segments.push(segment);

  const list = $('transcriptList');
  const item = document.createElement('div');
  item.className = 'transcript-item';

  const timeStr = formatTime(segment.startTime || 0);
  const speakerLabel = state.currentSpeaker === 'other' ? '对方' : '我';

  item.innerHTML = `
    <div class="transcript-time">${timeStr} · ${speakerLabel}</div>
    <div class="transcript-source">${escapeHtml(segment.source || '')}</div>
    <div class="transcript-target">${escapeHtml(segment.target || '')}</div>
  `;

  list.appendChild(item);
  // 滚动到底部
  const scroll = $('transcriptScroll');
  scroll.scrollTop = scroll.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 检测文本是否为中文（通过中文字符比例）
 */
function isChineseText(text) {
  if (!text || text.length < 2) return false;
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  return chineseChars / text.length > 0.3;
}

/**
 * 自动说话人检测：根据识别到的原文语言自动切换
 */
function autoDetectSpeaker(sourceText) {
  if (!state.autoSpeaker || !state.isRecording) return;

  const now = Date.now();
  // 防止频繁切换（至少间隔3秒）
  if (now - state.lastAutoSwitch < 3000) return;

  const isChinese = isChineseText(sourceText);
  const shouldBeMe = isChinese;

  if (shouldBeMe && state.currentSpeaker !== 'me') {
    console.log('[自动检测] 检测到中文，切换为"我在说话"');
    state.currentSpeaker = 'me';
    state.lastAutoSwitch = now;
    updateSpeakerUI();
    reconnectWithNewConfig();
    showToast('🤖 自动切换：你在说话');
  } else if (!shouldBeMe && state.currentSpeaker !== 'other') {
    console.log('[自动检测] 检测到外语，切换为"对方在说话"');
    state.currentSpeaker = 'other';
    state.lastAutoSwitch = now;
    updateSpeakerUI();
    reconnectWithNewConfig();
    showToast('🤖 自动切换：对方在说话');
  }
}

function updateSpeakerUI() {
  $('btnSpeakerOther').classList.toggle('active', state.currentSpeaker === 'other');
  $('btnSpeakerMe').classList.toggle('active', state.currentSpeaker === 'me');
  $('btnSpeakerAuto').classList.toggle('active', state.autoSpeaker);
}

/**
 * 用新配置重新连接WebSocket
 */
function reconnectWithNewConfig() {
  if (!state.isRecording) return;
  disconnectWebSocket();
  setTimeout(() => {
    const config = buildConfig();
    connectWebSocket(config);
  }, 300);
}

/**
 * 更新音量指示器
 */
function updateVolumeMeter() {
  if (!state.analyserNode || !state.isRecording) return;

  const dataArray = new Uint8Array(state.analyserNode.frequencyBinCount);
  state.analyserNode.getByteFrequencyData(dataArray);
  const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
  const volumePercent = Math.min(100, (average / 128) * 100);

  const bar = $('volumeBar');
  const label = $('volumeLabel');
  if (bar) {
    bar.style.background = `linear-gradient(90deg, var(--success) ${volumePercent}%, var(--border) ${volumePercent}%)`;
  }
  if (label) {
    if (state.isMuted) {
      label.textContent = '已静音';
    } else if (volumePercent < 5) {
      label.textContent = '等待说话...';
    } else if (volumePercent > 70) {
      label.textContent = '音量过大';
    } else {
      label.textContent = '麦克风正常';
    }
  }
}

// ===== 会议结果页 =====

async function loadMeetingResult() {
  switchView('result');

  $('resultMeetingName').textContent = state.meetingName;
  const duration = state.meetingStartTime ? formatTime(Date.now() - state.meetingStartTime) : '00:00';
  $('resultMeta').textContent = `${formatDateTime(new Date().toISOString())} · 时长 ${duration} · ${state.segments.length} 段对话`;

  // 显示转录记录
  renderResultTranscript();

  // 隐藏纪要内容
  $('summaryContent').style.display = 'none';
  $('summaryLoading').style.display = 'none';
  $('btnGenerateSummary').disabled = false;
  $('btnGenerateSummary').textContent = '✨ 生成AI纪要';
}

function renderResultTranscript() {
  const container = $('resultTranscript');
  if (state.segments.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:#999;padding:20px;">暂无对话记录</div>';
    return;
  }

  container.innerHTML = state.segments.map((seg, i) => `
    <div class="result-transcript-item" ${state.markedSegments.has(i) ? 'style="border-left:3px solid #FF9500;padding-left:10px;"' : ''}>
      <div style="font-size:11px;color:#999;margin-bottom:4px;">
        ${formatTime(seg.startTime || 0)}
        ${state.markedSegments.has(i) ? ' ⭐重点' : ''}
      </div>
      <div style="font-size:13px;margin-bottom:3px;">${escapeHtml(seg.source || '')}</div>
      <div style="font-size:13px;color:#4F6EF7;">${escapeHtml(seg.target || '')}</div>
    </div>
  `).join('');
}

async function generateSummary() {
  if (!state.meetingId) {
    // 尝试从最新会议获取
    try {
      const resp = await fetch('/api/meetings');
      const meetings = await resp.json();
      if (meetings.length > 0) {
        state.meetingId = meetings[0].id;
      }
    } catch (e) {
      showToast('无法获取会议ID');
      return;
    }
  }

  if (!state.meetingId) {
    showToast('会议尚未保存，请稍候再试');
    return;
  }

  $('btnGenerateSummary').disabled = true;
  $('btnGenerateSummary').textContent = '生成中...';
  $('summaryLoading').style.display = 'flex';
  $('summaryContent').style.display = 'none';

  try {
    const resp = await fetch(`/api/meetings/${state.meetingId}/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await resp.json();

    if (resp.ok && data.summary) {
      $('summaryContent').innerHTML = data.summary;
      $('summaryContent').style.display = 'block';
      $('summaryLoading').style.display = 'none';
      showToast('纪要生成成功');
    } else {
      throw new Error(data.error || '生成失败');
    }
  } catch (e) {
    console.error('纪要生成失败:', e);
    $('summaryLoading').style.display = 'none';
    $('btnGenerateSummary').disabled = false;
    $('btnGenerateSummary').textContent = '✨ 生成AI纪要';
    showToast('纪要生成失败: ' + e.message, 4000);
  }
}

function exportTranscript() {
  if (state.segments.length === 0) {
    showToast('暂无记录可导出');
    return;
  }

  let text = `会议纪要：${state.meetingName}\n`;
  text += `时间：${formatDateTime(new Date().toISOString())}\n`;
  text += `共 ${state.segments.length} 段对话\n\n`;
  text += '='.repeat(50) + '\n\n';

  state.segments.forEach((seg, i) => {
    text += `[${formatTime(seg.startTime || 0)}]`;
    if (state.markedSegments.has(i)) text += ' ⭐重点';
    text += '\n';
    text += `原文: ${seg.source || ''}\n`;
    text += `译文: ${seg.target || ''}\n\n`;
  });

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.meetingName}_会议记录.txt`;
  a.click();
  URL.revokeObjectURL(url);

  showToast('已导出会议记录');
}

// ===== 历史会议 =====

async function loadHistory() {
  try {
    const resp = await fetch('/api/meetings');
    const meetings = await resp.json();
    const list = $('historyList');

    if (meetings.length === 0) {
      list.innerHTML = '<div class="history-empty">暂无历史会议</div>';
      return;
    }

    list.innerHTML = meetings.map(m => `
      <div class="history-item" data-id="${m.id}">
        <div class="history-item-title">${escapeHtml(m.id.substring(0, 8))} 会议</div>
        <div class="history-item-meta">
          ${formatDateTime(m.startTime)} · ${m.segmentCount} 段对话
          ${m.summary ? ' · ✅已生成纪要' : ''}
        </div>
      </div>
    `).join('');

    // 绑定点击事件
    list.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        loadHistoryMeeting(id);
      });
    });
  } catch (e) {
    console.error('加载历史失败:', e);
  }
}

async function loadHistoryMeeting(id) {
  try {
    const resp = await fetch(`/api/meetings/${id}`);
    const meeting = await resp.json();

    state.meetingId = meeting.id;
    state.meetingName = `历史会议 ${meeting.id.substring(0, 8)}`;
    state.segments = meeting.segments || [];
    state.markedSegments = new Set();

    switchView('result');
    $('resultMeetingName').textContent = state.meetingName;
    const duration = meeting.endTime ? formatTime(new Date(meeting.endTime) - new Date(meeting.startTime)) : '未知';
    $('resultMeta').textContent = `${formatDateTime(meeting.startTime)} · 时长 ${duration} · ${state.segments.length} 段对话`;

    renderResultTranscript();

    if (meeting.summary) {
      $('summaryContent').innerHTML = meeting.summary;
      $('summaryContent').style.display = 'block';
      $('btnGenerateSummary').textContent = '✨ 重新生成纪要';
    } else {
      $('summaryContent').style.display = 'none';
      $('btnGenerateSummary').textContent = '✨ 生成AI纪要';
    }
    $('summaryLoading').style.display = 'none';
    $('btnGenerateSummary').disabled = false;

  } catch (e) {
    showToast('加载会议失败');
  }
}

// ===== 事件绑定 =====

function bindEvents() {
  // 首页
  $('btnStart').addEventListener('click', startMeeting);
  $('btnRefreshHistory').addEventListener('click', loadHistory);

  // 会议中
  $('btnSpeakerAuto').addEventListener('click', () => switchSpeaker('auto'));
  $('btnSpeakerOther').addEventListener('click', () => switchSpeaker('other'));
  $('btnSpeakerMe').addEventListener('click', () => switchSpeaker('me'));
  $('btnEndMeeting').addEventListener('click', endMeeting);
  $('btnPause').addEventListener('click', pauseMeeting);
  $('btnMute').addEventListener('click', muteMeeting);
  $('btnMark').addEventListener('click', markCurrent);

  // 结果页
  $('btnBackHome').addEventListener('click', () => {
    switchView('setup');
    loadHistory();
  });
  $('btnGenerateSummary').addEventListener('click', generateSummary);
  $('btnExport').addEventListener('click', exportTranscript);
}

// ===== 初始化 =====

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadHistory();

  // 检查HTTPS（麦克风需要安全上下文）
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    showToast('提示：麦克风功能需要HTTPS或localhost环境', 5000);
  }
});
