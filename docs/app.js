// Talmoln i webbläsaren: mikrofon → AudioWorklet → chunkning → Whisper (Web Worker)
// → transkript → Claude (ämnen) → ordmoln. Ingen server behövs.
import { WordCloud } from './cloud.js';
import { Chunker, cleanText, countWords } from './chunker.js';
import { TopicLayer } from './topics.js';

const $ = (id) => document.getElementById(id);
const MAX_BACKLOG = 3;            // fler väntande bitar än så = vi ligger efter, släng de äldsta
const FALLBACK_MODELS = ['onnx-community/whisper-base', 'Xenova/whisper-base'];
const KEY_STORAGE = 'talmoln.apiKey';
const SETTINGS_STORAGE = 'talmoln.settings';

// ---------------------------------------------------------------- Lagring

const store = {
  get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
  set(area, key, value) { try { window[area].setItem(key, value); } catch { /* privat läge m.m. */ } },
  del(area, key) { try { window[area].removeItem(key); } catch { /* ignoreras */ } },
};

const DEFAULT_SETTINGS = {
  halfLife: 120, maxWords: 40, interval: 20, llmEnabled: true,
  model: 'KBLab/kb-whisper-base', showTranscript: true,
};
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...settings, ...JSON.parse(store.get('localStorage', SETTINGS_STORAGE) || '{}') }; } catch { /* ignoreras */ }
const saveSettings = () => store.set('localStorage', SETTINGS_STORAGE, JSON.stringify(settings));

function loadKey() {
  return store.get('localStorage', KEY_STORAGE) || store.get('sessionStorage', KEY_STORAGE) || '';
}

// ---------------------------------------------------------------- Tillstånd

const cloud = new WordCloud($('cloud'));
const topics = new TopicLayer({
  halfLifeSeconds: settings.halfLife, maxWords: settings.maxWords, intervalSeconds: settings.interval,
});
topics.setApiKey(loadKey());
topics.setEnabled(settings.llmEnabled);

const state = {
  recording: false,
  audio: null,
  wakeLock: null,
  chunker: new Chunker(),
  queue: [],            // ljudbitar som väntar på Whisper
  busy: false,
  nextId: 1,
  pending: new Map(),   // id → bit som transkriberas
  segments: [],
  wordsSinceTopics: 0,
  startedAt: Date.now() / 1000,
  lastLatency: null,
  asr: { worker: null, status: 'idle', model: null, device: null, error: null },
};

// ---------------------------------------------------------------- Whisper

function createWorker() {
  // Testkrok: ersätter Whisper med en låtsasversion (används bara av testerna).
  if (window.__TALMOLN_FAKE_ASR__) return window.__TALMOLN_FAKE_ASR__();
  return new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
}

function ensureModel() {
  if (state.asr.worker) return;
  const worker = createWorker();
  state.asr = { worker, status: 'loading', model: settings.model, device: null, error: null };
  worker.onmessage = ({ data }) => onWorkerMessage(data);
  worker.onerror = (e) => {
    state.asr.status = 'error';
    // Vanligaste orsaken: biblioteket kunde inte hämtas från jsDelivr (inget nät).
    state.asr.error = e.message || 'kunde inte hämta transformers.js från cdn.jsdelivr.net';
    renderAsr();
  };
  const models = [settings.model, ...FALLBACK_MODELS.filter((m) => m !== settings.model)];
  worker.postMessage({ type: 'load', models, device: 'auto' });
  renderAsr();
}

function onWorkerMessage(msg) {
  if (msg.type === 'progress') {
    state.asr.progress = msg;
    renderAsr();
  } else if (msg.type === 'ready') {
    Object.assign(state.asr, { status: 'ready', model: msg.model, device: msg.device, fallback: msg.fallback });
    console.info('Whisper redo:', msg.model, msg.device, msg.dtype, msg.errors);
    renderAsr();
    pump();
  } else if (msg.type === 'error' && msg.stage === 'load') {
    Object.assign(state.asr, { status: 'error', error: msg.message });
    renderAsr();
  } else if (msg.type === 'error') {
    console.warn('Transkribering misslyckades:', msg.message);
    state.pending.delete(msg.id);
    state.busy = false;
    pump();
  } else if (msg.type === 'result') {
    onTranscript(msg);
  }
}

function enqueue(chunk) {
  chunk.receivedAt = Date.now() / 1000;
  state.queue.push(chunk);
  while (state.queue.length > MAX_BACKLOG) {
    state.queue.shift();
    console.warn('Transkriberingen ligger efter – hoppar över en bit');
  }
  pump();
  updateInfo();
}

function pump() {
  if (state.busy || state.asr.status !== 'ready' || !state.queue.length) return;
  const chunk = state.queue.shift();
  const id = state.nextId++;
  state.pending.set(id, chunk);
  state.busy = true;
  state.asr.worker.postMessage({ type: 'transcribe', id, audio: chunk.samples }, [chunk.samples.buffer]);
  updateInfo();
}

function onTranscript({ id, text }) {
  const chunk = state.pending.get(id);
  state.pending.delete(id);
  state.busy = false;
  if (chunk) {
    state.lastLatency = Math.round((Date.now() / 1000 - chunk.receivedAt) * 1000);
    const clean = cleanText(text || '');
    if (clean) {
      state.segments.push({ text: clean, at: chunk.receivedAt, durationS: chunk.durationS, latencyMs: state.lastLatency });
      state.wordsSinceTopics += countWords(clean);
      addSegment(clean);
    }
  }
  updateInfo();
  pump();
  maybeRefreshTopics();
}

// ---------------------------------------------------------------- Claude

function transcriptWindow() {
  const since = Date.now() / 1000 - topics.cfg.windowSeconds;
  const text = state.segments.filter((s) => s.at >= since).map((s) => s.text).join('\n');
  const limit = topics.cfg.maxWindowChars;
  return text.length > limit ? text.slice(-limit) : text;
}

async function maybeRefreshTopics() {
  if (!topics.shouldCall(state.wordsSinceTopics)) return;
  const transcript = transcriptWindow();
  if (!transcript) return;
  state.wordsSinceTopics = 0;
  const req = topics.refresh(transcript);
  renderLlm();
  await req;
  renderCloud();
  renderLlm();
}

// ---------------------------------------------------------------- Mikrofon

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showWarning('Mikrofonen är inte tillgänglig. Sidan måste öppnas via https:// (t.ex. GitHub Pages) eller localhost.');
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
  ensureModel();

  let ctx;
  try { ctx = new AudioContext({ sampleRate: 16000 }); } catch { ctx = new AudioContext(); }
  if (ctx.state === 'suspended') await ctx.resume();
  await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-processor');
  node.port.onmessage = ({ data }) => {
    for (const chunk of state.chunker.feed(data.pcm)) if (chunk.voiced) enqueue(chunk);
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
  const rest = state.chunker.flush(); // transkribera det som återstår
  if (rest?.voiced) enqueue(rest);
  $('mic').setAttribute('aria-pressed', 'false');
  $('mic').setAttribute('aria-label', 'Starta mikrofonen');
  $('level').style.width = '0';
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  setStatus();
}

async function requestWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* inte kritiskt */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.recording && !state.wakeLock) requestWakeLock();
});

// ---------------------------------------------------------------- Rendering

function renderCloud() {
  const terms = topics.cloudTerms();
  if (terms.length) $('empty')?.remove();
  cloud.update(terms);
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
  $('status').classList.add('online');
  $('status').classList.toggle('recording', state.recording);
  $('status-text').textContent = state.recording ? 'Lyssnar' : 'Redo';
}

function updateInfo() {
  const parts = [];
  if (state.lastLatency != null) parts.push(`${(state.lastLatency / 1000).toFixed(1)} s`);
  const backlog = state.queue.length + (state.busy ? 1 : 0);
  if (backlog > 1) parts.push(`kö ${backlog}`);
  $('info').textContent = parts.join(' · ');
}

const MB = (b) => `${Math.round(b / 1e6)} MB`;
const MODEL_NAMES = {
  'KBLab/kb-whisper-base': 'KB-Whisper base', 'KBLab/kb-whisper-tiny': 'KB-Whisper tiny',
  'onnx-community/whisper-base': 'Whisper base', 'onnx-community/whisper-tiny': 'Whisper tiny',
  'Xenova/whisper-base': 'Whisper base',
};

function renderAsr() {
  const a = state.asr;
  const box = $('model-progress');
  if (a.status === 'loading') {
    box.hidden = false;
    const p = a.progress;
    $('model-bar').style.width = `${p?.progress ?? 0}%`;
    $('model-text').textContent = p?.total
      ? `Laddar ${MODEL_NAMES[p.model] || p.model}: ${Math.round(p.progress)} % (${MB(p.loaded)} av ${MB(p.total)})`
      : 'Förbereder taligenkänningen…';
    $('asr-status').textContent = 'Laddar modellen. Första gången hämtas den från Hugging Face, sedan finns den i webbläsaren.';
  } else {
    box.hidden = true;
  }
  if (a.status === 'ready') {
    const name = MODEL_NAMES[a.model] || a.model;
    const where = a.device === 'webgpu' ? 'grafikprocessorn (WebGPU)' : 'processorn (WebAssembly)';
    $('asr-status').textContent = `Använder ${name} på ${where}.`;
    showWarning(a.fallback
      ? `${MODEL_NAMES[settings.model] || settings.model} gick inte att ladda i webbläsaren, så ${name} används i stället (sämre svenska).`
      : '');
  } else if (a.status === 'error') {
    $('asr-status').textContent = 'Modellen kunde inte laddas.';
    showWarning(`Taligenkänningen kunde inte starta. Kontrollera nätet och ladda om sidan. (${a.error.split('\n')[0]})`);
  }
}

const LLM_TEXT = { ok: 'Ämnen', pending: 'Ämnen…', offline: 'Ämnen offline', error: 'Ämnen: fel', off: 'Ämnen av' };

function renderLlm() {
  const llm = topics.info();
  const el = $('llm');
  el.dataset.status = llm.status;
  el.dataset.busy = llm.busy ? 'true' : 'false';
  $('llm-text').textContent = LLM_TEXT[llm.status] || 'Ämnen';
  let title = `Ämnen (${llm.model})`;
  if (llm.lastUpdateS != null) title += ` · uppdaterat för ${llm.lastUpdateS} s sedan`;
  if (llm.reason && llm.status !== 'off') title += ` · ${llm.reason}`;
  el.title = title;

  $('llm-enabled').checked = llm.enabled;
  $('llm-enabled').disabled = !llm.hasKey;
  const u = llm.usage;
  $('llm-usage').textContent = u.calls || u.failed
    ? `Den här sessionen: ${u.calls} anrop, ${u.inputTokens} tokens in, ${u.outputTokens} ut`
      + (u.failed ? `, ${u.failed} misslyckade` : '') + '.'
    : '';
  setNotice(!llm.hasKey
    ? 'Ordmolnet kommer från Claude. Ange din Anthropic API-nyckel under ⚙️. Transkriptet fungerar ändå.'
    : !llm.enabled ? 'Ämnen med Claude är avslaget, så molnet är tomt. Slå på det under ⚙️.'
      : llm.status === 'error' ? `Claude svarade med ett fel: ${llm.reason}` : '');
}

function setNotice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
function showWarning(text) { $('warning').textContent = text; $('warning').hidden = !text; }

// ---------------------------------------------------------------- Inställningar

function applySettingsToUi() {
  $('half-life').value = settings.halfLife;
  $('half-life-out').textContent = `${settings.halfLife} s`;
  $('top-n').value = settings.maxWords;
  $('top-n-out').textContent = settings.maxWords;
  $('llm-interval').value = settings.interval;
  $('llm-interval-out').textContent = `${settings.interval} s`;
  $('asr-model').value = settings.model;
  $('show-transcript').checked = settings.showTranscript;
  document.body.classList.toggle('no-transcript', !settings.showTranscript);
  $('api-key').value = topics.apiKey;
  $('remember-key').checked = !!store.get('localStorage', KEY_STORAGE) || !topics.apiKey;
  $('key-status').textContent = topics.apiKey ? 'En nyckel är sparad.' : '';
}

function bindRange(id, outId, key, apply, suffix = '') {
  $(id).addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $(outId).textContent = `${v}${suffix}`;
    settings[key] = v;
    saveSettings();
    apply(v);
  });
}
bindRange('half-life', 'half-life-out', 'halfLife', (v) => { topics.setHalfLife(v); renderCloud(); }, ' s');
bindRange('top-n', 'top-n-out', 'maxWords', (v) => { topics.cfg.maxWords = v; renderCloud(); });
bindRange('llm-interval', 'llm-interval-out', 'interval', (v) => { topics.cfg.intervalSeconds = v; }, ' s');

$('llm-enabled').addEventListener('change', (e) => {
  settings.llmEnabled = e.target.checked;
  saveSettings();
  topics.setEnabled(e.target.checked);
  renderCloud();
  renderLlm();
});

$('asr-model').addEventListener('change', (e) => {
  settings.model = e.target.value;
  saveSettings();
  if (state.asr.worker) {
    // Byt modell: starta en ny worker. Ljud som väntar ligger kvar i kön.
    state.asr.worker.terminate?.();
    state.asr.worker = null;
    state.busy = false;
    state.pending.clear();
    ensureModel();
  }
});

$('show-transcript').addEventListener('change', (e) => {
  settings.showTranscript = e.target.checked;
  saveSettings();
  document.body.classList.toggle('no-transcript', !e.target.checked);
});

function saveKey() {
  const key = $('api-key').value.trim();
  store.del('localStorage', KEY_STORAGE);
  store.del('sessionStorage', KEY_STORAGE);
  if (key) store.set($('remember-key').checked ? 'localStorage' : 'sessionStorage', KEY_STORAGE, key);
  topics.setApiKey(key);
  $('key-status').textContent = key
    ? ($('remember-key').checked ? 'Sparad på den här enheten.' : 'Sparad tills fliken stängs.')
    : 'Ingen nyckel.';
  renderLlm();
}
$('save-key').addEventListener('click', saveKey);
$('test-key').addEventListener('click', async () => {
  saveKey();
  if (!topics.hasKey) return;
  $('key-status').textContent = 'Testar…';
  const res = await topics.testKey();
  $('key-status').textContent = res.message;
});
$('forget-key').addEventListener('click', () => {
  $('api-key').value = '';
  saveKey();
});

$('settings-btn').addEventListener('click', () => { applySettingsToUi(); $('settings').showModal(); });
$('llm').addEventListener('click', () => { applySettingsToUi(); $('settings').showModal(); });

$('reset').addEventListener('click', () => {
  if (!confirm('Nollställa transkript och ordmoln?')) return;
  state.segments = [];
  state.wordsSinceTopics = 0;
  state.queue = [];
  state.startedAt = Date.now() / 1000;
  topics.reset();
  $('transcript').replaceChildren();
  cloud.clear();
  renderLlm();
  $('settings').close();
});

$('export').addEventListener('click', () => {
  const now = Date.now() / 1000;
  const body = {
    exported_at: new Date().toISOString(),
    settings: { ...settings, whisper: { model: state.asr.model, device: state.asr.device } },
    segments: state.segments.map((s) => ({
      t: Math.round((s.at - state.startedAt) * 100) / 100,
      at: new Date(s.at * 1000).toISOString(),
      text: s.text,
      duration_s: Math.round(s.durationS * 100) / 100,
      latency_ms: s.latencyMs,
    })),
    transcript: state.segments.map((s) => s.text).join(' '),
    top: topics.cloudTerms(now),
    topics: topics.current(now).map((t) => ({ label: t.label, score: Math.round(t.score * 1e4) / 1e4, keywords: t.keywords })),
    llm: topics.info(now),
  };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-');
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `talmoln-${stamp}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('mic').addEventListener('click', () => (state.recording ? stopMic() : startMic()));

// ---------------------------------------------------------------- Start

applySettingsToUi();
setStatus();
renderLlm();
setInterval(maybeRefreshTopics, 1000);
setInterval(() => { if (topics.topics.size) renderCloud(); renderLlm(); }, 2000);
