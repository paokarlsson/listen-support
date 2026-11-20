// Mikrofon → AudioWorklet → WebSocket, och rendering av transkript och ordmoln.
import { WordCloud } from './cloud.js';

const $ = (id) => document.getElementById(id);
const cloud = new WordCloud($('cloud'));

const state = {
  ws: null,
  recording: false,
  audio: null,      // { ctx, stream, node }
  wakeLock: null,
  reconnectDelay: 500,
  lastLatency: null,
  backlog: 0,
  sentBytes: 0,
  llm: null,
};

// ---------------------------------------------------------------- WebSocket

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    state.reconnectDelay = 500;
    setStatus();
  };
  ws.onclose = () => {
    state.ws = null;
    setStatus();
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 8000);
  };
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
}

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function handleMessage(msg) {
  if (msg.llm) renderLlm(msg.llm);
  switch (msg.type) {
    case 'hello':
      applySettings(msg.settings);
      $('transcript').replaceChildren();
      msg.segments.forEach(addSegment);
      renderTerms(msg.terms);
      break;
    case 'update':
      addSegment(msg.segment);
      renderTerms(msg.terms);
      state.lastLatency = msg.latency_ms;
      state.backlog = msg.backlog;
      updateInfo();
      break;
    case 'terms':
      renderTerms(msg.terms);
      break;
    case 'chunk':
      state.backlog = msg.backlog;
      updateInfo();
      break;
    case 'status':
      if (msg.latency_ms != null) state.lastLatency = msg.latency_ms;
      state.backlog = msg.backlog ?? state.backlog;
      updateInfo();
      break;
    case 'settings':
      applySettings(msg.settings);
      renderTerms(msg.terms);
      break;
    case 'reset':
      $('transcript').replaceChildren();
      cloud.clear();
      renderTerms([]);
      break;
  }
}

// ---------------------------------------------------------------- Mikrofon

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showWarning('Mikrofonen är inte tillgänglig. Öppna sidan via http://localhost:8000 i Chrome.');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    showWarning(`Fick inte använda mikrofonen: ${err.message}`);
    return;
  }

  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: 16000 }); // Chrome omsamplar åt oss
  } catch {
    ctx = new AudioContext(); // workleten omsamplar då själv
  }
  if (ctx.state === 'suspended') await ctx.resume();
  await ctx.audioWorklet.addModule('/static/pcm-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-processor');
  node.port.onmessage = ({ data }) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(data.pcm);
      state.sentBytes += data.pcm.byteLength;
    }
    $('level').style.width = `${Math.min(100, Math.sqrt(data.level) * 180)}%`;
  };
  // Noden måste vara kopplad till grafen för att köras; tyst förstärkare till högtalaren.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node).connect(mute).connect(ctx.destination);

  state.audio = { ctx, stream, node };
  state.recording = true;
  $('mic').setAttribute('aria-pressed', 'true');
  $('mic').setAttribute('aria-label', 'Stoppa mikrofonen');
  $('empty')?.remove();
  requestWakeLock();
  setStatus();
}

async function stopMic() {
  const a = state.audio;
  state.audio = null;
  state.recording = false;
  if (a) {
    a.node.port.onmessage = null;
    a.stream.getTracks().forEach((t) => t.stop());
    await a.ctx.close();
  }
  send({ type: 'stop' }); // servern transkriberar det som återstår i bufferten
  $('mic').setAttribute('aria-pressed', 'false');
  $('mic').setAttribute('aria-label', 'Starta mikrofonen');
  $('level').style.width = '0';
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  setStatus();
}

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* inte kritiskt */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.recording && !state.wakeLock) requestWakeLock();
});

// ---------------------------------------------------------------- Rendering

function renderTerms(terms) {
  if (terms?.length) $('empty')?.remove();
  cloud.update(terms || []);
}

function addSegment(text) {
  const box = $('transcript');
  const p = document.createElement('p');
  p.textContent = text;
  box.appendChild(p);
  while (box.childElementCount > 50) box.firstElementChild.remove();
  box.scrollTop = box.scrollHeight;
}

function setStatus() {
  const el = $('status');
  el.classList.toggle('online', !!state.ws && state.ws.readyState === WebSocket.OPEN);
  el.classList.toggle('recording', state.recording);
  $('status-text').textContent = !state.ws
    ? 'Frånkopplad'
    : state.recording ? 'Lyssnar' : 'Redo';
}

function updateInfo() {
  const parts = [];
  if (state.lastLatency != null) parts.push(`${(state.lastLatency / 1000).toFixed(1)} s`);
  if (state.backlog > 1) parts.push(`kö ${state.backlog}`);
  $('info').textContent = parts.join(' · ');
}

function setCloudNotice(text) {
  const el = $('notice');
  el.textContent = text;
  el.hidden = !text;
}

function showWarning(text) {
  const el = $('warning');
  el.textContent = text;
  el.hidden = !text;
}

const LLM_TEXT = {
  ok: 'Ämnen',
  pending: 'Ämnen…',
  offline: 'Ämnen offline',
  error: 'Ämnen: fel',
  off: 'Ämnen av',
};

function renderLlm(llm) {
  state.llm = llm;
  const el = $('llm');
  el.dataset.status = llm.status;
  el.dataset.busy = llm.busy ? 'true' : 'false';
  $('llm-text').textContent = LLM_TEXT[llm.status] || 'Ämnen';
  let title = `Ämneslagret (${llm.model})`;
  if (llm.last_update_s != null) title += ` · uppdaterat för ${llm.last_update_s} s sedan`;
  if (llm.reason && llm.status !== 'off') title += ` · ${llm.reason}`;
  el.title = title;

  const cb = $('llm-enabled');
  cb.checked = llm.enabled && llm.has_key;
  cb.disabled = !llm.has_key;
  $('llm-note').textContent = llm.has_key
    ? 'Skickar transkriberad text (aldrig ljud) till Anthropic.'
    : 'Ingen API-nyckel. Lägg ANTHROPIC_API_KEY i .env och starta om servern.';
  // Molnet kommer helt från Claude: säg varför det är tomt när lagret inte kan köras.
  const blocked = !llm.has_key
    ? 'Ordmolnet kräver Claude: lägg ANTHROPIC_API_KEY i .env och starta om servern. Transkriptet fungerar ändå.'
    : !llm.enabled ? 'Ämnen med Claude är avslaget, så molnet är tomt. Slå på det under ⚙️.' : '';
  setCloudNotice(blocked);
  const u = llm.usage || {};
  $('llm-usage').textContent = u.calls || u.failed
    ? `Den här sessionen: ${u.calls} anrop, ${u.input_tokens} tokens in, ${u.output_tokens} ut` +
      (u.failed ? `, ${u.failed} misslyckade` : '') + '.'
    : '';
}

// ---------------------------------------------------------------- Inställningar

function applySettings(s) {
  if (!s) return;
  $('half-life').value = s.half_life;
  $('half-life-out').textContent = `${Math.round(s.half_life)} s`;
  $('top-n').value = s.top_n;
  $('top-n-out').textContent = s.top_n;
  if (s.llm_interval != null) {
    $('llm-interval').value = s.llm_interval;
    $('llm-interval-out').textContent = `${Math.round(s.llm_interval)} s`;
  }
  if (s.transcriber_error) {
    showWarning(`Transkriberingen är avstängd: ${s.transcriber_error}`);
  } else if (s.transcriber === 'stub') {
    showWarning('Transkriberaren körs i stub-läge (ingen Whisper). Ljudet tas emot men inget skrivs ut.');
  } else {
    showWarning('');
  }
}

let settingsTimer;
function sendSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    send({
      type: 'settings',
      half_life: Number($('half-life').value),
      top_n: Number($('top-n').value),
      llm_interval: Number($('llm-interval').value),
    });
  }, 250);
}

$('half-life').addEventListener('input', (e) => {
  $('half-life-out').textContent = `${e.target.value} s`;
  sendSettings();
});
$('top-n').addEventListener('input', (e) => {
  $('top-n-out').textContent = e.target.value;
  sendSettings();
});

$('llm-interval').addEventListener('input', (e) => {
  $('llm-interval-out').textContent = `${e.target.value} s`;
  sendSettings();
});
$('llm-enabled').addEventListener('change', (e) => {
  send({ type: 'settings', llm_enabled: e.target.checked });
});
$('llm').addEventListener('click', () => $('settings').showModal());

const SHOW_KEY = 'talmoln.showTranscript';
function setShowTranscript(on) {
  document.body.classList.toggle('no-transcript', !on);
  $('show-transcript').checked = on;
  try { localStorage.setItem(SHOW_KEY, on ? '1' : '0'); } catch { /* ignoreras */ }
}
try { setShowTranscript(localStorage.getItem(SHOW_KEY) !== '0'); } catch { setShowTranscript(true); }
$('show-transcript').addEventListener('change', (e) => setShowTranscript(e.target.checked));

$('settings-btn').addEventListener('click', () => $('settings').showModal());

$('reset').addEventListener('click', async () => {
  if (!confirm('Nollställa transkript och ordmoln?')) return;
  await fetch('/reset', { method: 'POST' });
  $('settings').close();
});

$('export').addEventListener('click', async () => {
  const res = await fetch('/export?download=1');
  const blob = await res.blob();
  const name = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'talmoln.json';
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('mic').addEventListener('click', () => (state.recording ? stopMic() : startMic()));

connect();
