/**
 * MeetBuddy MVP - 前端主逻辑
 */

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
  currentSpeaker: 'other',
  analyserNode: null,
  meetingStartTime: null,
  timerInterval: null,
  segments: [],
  currentSegment: null,
  meetingId: null,
  meetingName: '',
  config: null,
  ttsAudioQueue: [],
  isPlayingTTS: false
};

const $ = (id) => document.getElementById(id);
const views = {
  setup: $('view-setup'),
  meeting: $('view-meeting'),
  result: $('view-result')
};

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

// ===== 音频处理 =====

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

    state.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    state.sourceNode = state.audioContext.createMediaStreamSource(state.mediaStream);
    state.analyserNode = state.audioContext.createAnalyser();
    state.analyserNode.fftSize = 256;
    state.sourceNode.connect(state.analyserNode);

    state.scriptProcessor = state.audioContext.createScriptProcessor(4096, 1, 1);
    state.sourceNode.connect(state.scriptProcessor);
    state.scriptProcessor.connect(state.audioContext.destination);

    state.scriptProcessor.onaudioprocess = (e) => {
      if (!state.isRecording || state.isPaused || state.isMuted) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const pcm16 = resampleTo16kHzPCM16(inputData, e.inputBuffer.sampleRate);

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

function resampleTo16kHzPCM16(float32Data, sourceSampleRate) {
  const targetSampleRate = 16000;
  const ratio = sourceSampleRate / targetSampleRate;
  const targetLength = Math.floor(float32Data.length / ratio);
  const pcm16 = new Int16Array(targetLength);

  for (let i = 0; i < targetLength; i++) {
    const sourceIndex = Math.floor(i * ratio);
    let sample = float32Data[sourceIndex] || 0;
    sample = Math.max(-1, Math.min(1, sample));
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

// ===== WebSocket 通信 =====

function connectWebSocket(config) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    console.log('[WS] 已连接');
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
    showToast('连接错误，请检查网络');
  };

  state.ws.onclose = () => {
    console.log('[WS] 断开');
  };
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'session_started':
      console.log('[WS] 会话已启动');
      showToast('同传已启动');
      break;

    case 'source_partial':
      $('sourceText').textContent = msg.text || '';
      break;

    case 'target_partial':
      $('targetText').textContent = msg.text || '';
      break;

    case 'segment_complete':
      addTranscriptSegment(msg.segment);
      $('sourceText').textContent = '等待说话...';
      $('targetText').textContent = '';
      break;

    case 'tts_audio':
      playTTSAudio(msg.audio);
      break;

    case 'error':
      console.error('[WS] 错误:', msg.message);
      showToast(msg.message || '同传错误', 5000);
      break;

    case 'session_finished':
      state.meetingId = msg.meetingId;
      break;
  }
}

function addTranscriptSegment(segment) {
  state.segments.push(segment);

  const list = $('transcriptList');
  const item = document.createElement('div');
  item.className = 'transcript-item';

  const sourceDiv = document.createElement('div');
  sourceDiv.className = 'transcript-source';
  sourceDiv.textContent = segment.source || '';

  const targetDiv = document.createElement('div');
  targetDiv.className = 'transcript-target';
  targetDiv.textContent = segment.target || '';

  item.appendChild(sourceDiv);
  item.appendChild(targetDiv);
  list.appendChild(item);

  $('transcriptScroll').scrollTop = $('transcriptScroll').scrollHeight;
}

// ===== 说话人切换 =====

function updateSpeakerUI() {
  document.querySelectorAll('.speaker-btn').forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset.speaker === state.currentSpeaker) {
      btn.classList.add('active');
    }
  });
}

function switchSpeaker(speaker) {
  if (state.currentSpeaker === speaker) return;

  state.currentSpeaker = speaker;
  updateSpeakerUI();

  // 重新建立WebSocket连接，切换语言方向
  if (state.ws) {
    state.ws.close();
  }

  state.config = buildConfig();
  connectWebSocket(state.config);

  showToast(speaker === 'other' ? '已切换：对方说话（外语→中文）' : '已切换：我说话（中文→外语）');
}

function buildConfig() {
  const sourceLang = $('sourceLang').value;
  const enableTTS = $('enableTTS').checked;

  if (state.currentSpeaker === 'other') {
    return {
      mode: enableTTS ? 's2s' : 's2t',
      source_language: sourceLang,
      target_language: 'zh'
    };
  } else {
    return {
      mode: enableTTS ? 's2s' : 's2t',
      source_language: 'zh',
      target_language: sourceLang
    };
  }
}

// ===== 音量指示器 =====

function updateVolumeMeter() {
  if (!state.analyserNode) return;

  const dataArray = new Uint8Array(state.analyserNode.frequencyBinCount);
  state.analyserNode.getByteFrequencyData(dataArray);

  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i];
  }
  const average = sum / dataArray.length;
  const percentage = Math.min(100, (average / 128) * 100);

  $('volumeBar').style.width = percentage + '%';

  if (state.isMuted) {
    $('volumeLabel').textContent = '已静音';
  } else if (percentage > 5) {
    $('volumeLabel').textContent = '麦克风正常';
  } else {
    $('volumeLabel').textContent = '等待声音...';
  }
}

// ===== 会议控制 =====

async function startMeeting() {
  const meetingName = $('meetingName').value.trim() || '未命名会议';
  state.meetingName = meetingName;
  state.segments = [];

  const audioOk = await initAudio();
  if (!audioOk) return;

  $('meetingTitleDisplay').textContent = meetingName;
  $('transcriptList').innerHTML = '';
  $('sourceText').textContent = '等待说话...';
  $('targetText').textContent = '';
  switchView('meeting');

  state.meetingStartTime = Date.now();
  state.timerInterval = setInterval(() => {
    const elapsed = Date.now() - state.meetingStartTime;
    $('meetingTimer').textContent = formatTime(elapsed);
  }, 1000);

  state.volumeInterval = setInterval(updateVolumeMeter, 100);

  state.isRecording = true;
  state.currentSpeaker = 'other';
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

function endMeeting() {
  state.isRecording = false;

  if (state.ws) {
    state.ws.send(JSON.stringify({ type: 'stop' }));
    setTimeout(() => {
      if (state.ws) state.ws.close();
    }, 1000);
  }

  if (state.timerInterval) clearInterval(state.timerInterval);
  if (state.volumeInterval) clearInterval(state.volumeInterval);

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(track => track.stop());
  }

  showResultPage();
}

function showResultPage() {
  $('resultMeetingName').textContent = state.meetingName;
  const duration = state.meetingStartTime ? formatTime(Date.now() - state.meetingStartTime) : '00:00';
  $('resultMeta').textContent = `时长: ${duration} | 共 ${state.segments.length} 段对话`;

  const transcriptDiv = $('resultTranscript');
  transcriptDiv.innerHTML = '';

  if (state.segments.length === 0) {
    transcriptDiv.innerHTML = '<div class="history-empty">暂无对话记录</div>';
  } else {
    state.segments.forEach(seg => {
      const item = document.createElement('div');
      item.className = 'transcript-item';
      item.innerHTML = `
        <div class="transcript-source">${escapeHtml(seg.source || '')}</div>
        <div class="transcript-target">${escapeHtml(seg.target || '')}</div>
      `;
      transcriptDiv.appendChild(item);
    });
  }

  $('summaryContent').style.display = 'none';
  $('summaryLoading').style.display = 'none';
  switchView('result');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== AI纪要 =====

async function generateSummary() {
  if (!state.meetingId) {
    showToast('会议ID不存在，请重新开始会议');
    return;
  }

  $('summaryLoading').style.display = 'flex';
  $('summaryContent').style.display = 'none';
  $('btnGenerateSummary').disabled = true;

  try {
    const response = await fetch(`/api/meetings/${state.meetingId}/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await response.json();

    if (response.ok) {
      $('summaryContent').innerHTML = data.summary;
      $('summaryContent').style.display = 'block';
      showToast('AI纪要生成成功');
    } else {
      showToast(data.error || '纪要生成失败', 5000);
    }
  } catch (e) {
    console.error('纪要生成失败:', e);
    showToast('网络错误，请重试', 5000);
  } finally {
    $('summaryLoading').style.display = 'none';
    $('btnGenerateSummary').disabled = false;
  }
}

// ===== 导出记录 =====

function exportTranscript() {
  let text = `会议名称: ${state.meetingName}\n`;
  text += `时间: ${new Date().toLocaleString()}\n`;
  text += `共 ${state.segments.length} 段对话\n\n`;
  text += '='.repeat(50) + '\n\n';

  state.segments.forEach((seg, i) => {
    text += `【第${i + 1}段】\n`;
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
    const response = await fetch('/api/meetings');
    const meetings = await response.json();

    const list = $('historyList');
    if (meetings.length === 0) {
      list.innerHTML = '<div class="history-empty">暂无历史会议</div>';
      return;
    }

    list.innerHTML = '';
    meetings.forEach(m => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const date = new Date(m.startTime).toLocaleString();
      item.innerHTML = `
        <div class="history-name">${escapeHtml(m.id.substring(0, 8))}...</div>
        <div class="history-meta">${date} | ${m.segmentCount}段</div>
      `;
      list.appendChild(item);
    });
  } catch (e) {
    console.error('加载历史失败:', e);
  }
}

// ===== 事件绑定 =====

document.addEventListener('DOMContentLoaded', () => {
  $('btnStart').addEventListener('click', startMeeting);
  $('btnEndMeeting').addEventListener('click', endMeeting);
  $('btnPause').addEventListener('click', pauseMeeting);
  $('btnMute').addEventListener('click', muteMeeting);
  $('btnGenerateSummary').addEventListener('click', generateSummary);
  $('btnExport').addEventListener('click', exportTranscript);
  $('btnBackHome').addEventListener('click', () => {
    switchView('setup');
    loadHistory();
  });
  $('btnRefreshHistory').addEventListener('click', loadHistory);

  document.querySelectorAll('.speaker-btn').forEach(btn => {
    btn.addEventListener('click', () => switchSpeaker(btn.dataset.speaker));
  });

  loadHistory();
});
