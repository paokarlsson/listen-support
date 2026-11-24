// Talmoln i webbläsaren: mikrofon → AudioWorklet → chunkning → Whisper (Web Worker)
// → transkript → Claude (ämnen) → ordmoln. Ingen server behövs.
import { Chunker, cleanText, countWords } from './chunker.js';
import { TopicLayer } from './topics.js';

const $ = (id) => document.getElementById(id);
const MAX_BACKLOG = 3;            // fler väntande bitar än så = vi ligger efter, släng de äldsta
// en bit som tar längre tid än så: Whisper har hängt sig (testerna kan korta tiden)
const TRANSCRIBE_TIMEOUT_S = window.__TALMOLN_TIMEOUT_S__ || 45;
const AUDIO_SILENT_S = 4;         // inga ljudblock på så länge: mikrofonen har stannat
const AUDIO_ZERO_S = 6;           // bara exakta nollor så länge: mikrofonen levererar inget
const AUDIO_RESTART_GAP_S = 20;   // starta inte om mikrofonen oftare än så
const WATCHDOG_MS = 2000;
const FALLBACK_MODELS = ['onnx-community/whisper-base', 'Xenova/whisper-base'];
const KEY_STORAGE = 'talmoln.apiKey';
const SETTINGS_STORAGE = 'talmoln.settings';
const SESSION_STORAGE = 'talmoln.session';  // samtalet, så att det överlever en omladdning
const MAX_SAVED_SEGMENTS = 1000;

// ---------------------------------------------------------------- Lagring

const store = {
  get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
  set(area, key, value) { try { window[area].setItem(key, value); } catch { /* privat läge m.m. */ } },
  del(area, key) { try { window[area].removeItem(key); } catch { /* ignoreras */ } },
};

const SETTINGS_VERSION = 2;
const DEFAULT_SETTINGS = {
  v: SETTINGS_VERSION, keepMinutes: 15, maxShown: 8, interval: 10, llmEnabled: true,
  model: 'KBLab/kb-whisper-base', showTranscript: true, showSummaries: true,
  theme: 'auto', textSize: 'normal', reduceMotion: false,
};
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...settings, ...JSON.parse(store.get('localStorage', SETTINGS_STORAGE) || '{}') }; } catch { /* ignoreras */ }
if (settings.v !== SETTINGS_VERSION) {
  // Version 2: snabbare standardintervall för Claude.
  settings = { ...settings, v: SETTINGS_VERSION, interval: DEFAULT_SETTINGS.interval };
}
const saveSettings = () => store.set('localStorage', SETTINGS_STORAGE, JSON.stringify(settings));

/** Tema, textstorlek och rörelser sätts på <html> så att CSS kan följa dem. */
function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.size = settings.textSize;
  root.dataset.motion = settings.reduceMotion ? 'reduced' : 'auto';
}
applyAppearance();

function loadKey() {
  return store.get('localStorage', KEY_STORAGE) || store.get('sessionStorage', KEY_STORAGE) || '';
}

// ---------------------------------------------------------------- Tillstånd

// Ett ämne behåller sin färg (samma färg för samma namn).
const PALETTE = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'];
function topicColor(name) {
  let h = 2166136261;
  for (const ch of String(name).toLowerCase()) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return `var(${PALETTE[(h >>> 0) % PALETTE.length]})`;
}
const topics = new TopicLayer({
  keepSeconds: settings.keepMinutes * 60, maxShown: settings.maxShown, intervalSeconds: settings.interval,
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
  busySince: 0,
  lastAudioAt: 0,
  lastSoundAt: 0,       // senaste block som inte var helt tyst (en riktig mikrofon brusar alltid)
  lastAudioRestart: 0,
  restarting: false,
  workerRestarts: 0,
  slowChunks: 0,        // bitar i rad som tog längre tid att transkribera än de var långa
  log: [],
};

// ---------------------------------------------------------------- Diagnostik

function log(msg) {
  const line = `${new Date().toTimeString().slice(0, 8)} ${msg}`;
  console.info('[talmoln]', msg);
  state.log.push(line);
  if (state.log.length > 200) state.log.shift();
  const el = $('diag-log');
  if (el && $('settings').open) el.textContent = state.log.slice(-60).join('\n');
}
window.addEventListener('error', (e) => log(`Fel: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => log(`Fel: ${e.reason?.message || e.reason}`));

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
  log(`Laddar Whisper (${settings.model})`);
  worker.onmessage = ({ data }) => { if (state.asr.worker === worker) onWorkerMessage(data); };
  worker.onerror = (e) => {
    if (state.asr.worker !== worker) return;
    e.preventDefault?.();
    if (state.asr.status === 'ready') {
      // Kraschade mitt i (t.ex. slut på minne): starta om, modellen finns i cachen.
      restartWorker(`Whisper-workern kraschade: ${e.message || 'okänt fel'}`);
      return;
    }
    state.asr.status = 'error';
    // Vanligaste orsaken: biblioteket kunde inte hämtas från jsDelivr (inget nät).
    state.asr.error = e.message || 'kunde inte hämta transformers.js från cdn.jsdelivr.net';
    log(`Whisper kunde inte starta: ${state.asr.error}`);
    renderAsr();
  };
  const models = [settings.model, ...FALLBACK_MODELS.filter((m) => m !== settings.model)];
  worker.postMessage({ type: 'load', models, device: 'auto' });
  renderAsr();
}

/** Släng en hängd eller kraschad worker och starta en ny. Bitar i kön behålls. */
function restartWorker(reason) {
  log(`${reason} – startar om Whisper`);
  state.workerRestarts++;
  try { state.asr.worker?.terminate?.(); } catch { /* redan död */ }
  state.asr.worker = null;
  state.busy = false;
  state.pending.clear();
  if (state.workerRestarts > 3) {
    state.asr.status = 'error';
    state.asr.error = 'Whisper har hängt sig flera gånger. Välj KB-Whisper tiny under Inställningar och ladda om sidan.';
    renderAsr();
    return;
  }
  ensureModel();
}

function onWorkerMessage(msg) {
  if (msg.type === 'progress') {
    state.asr.progress = msg;
    renderAsr();
  } else if (msg.type === 'ready') {
    Object.assign(state.asr, { status: 'ready', model: msg.model, device: msg.device, fallback: msg.fallback, threads: msg.threads });
    log(`Whisper redo: ${msg.model} på ${msg.device} (${JSON.stringify(msg.dtype)})`
      + (msg.device === 'wasm' ? `, ${msg.threads} trådar av ${msg.cores ?? '?'} kärnor, isolerad: ${msg.isolated ? 'ja' : 'nej'}` : ''));
    for (const e of msg.errors || []) log(`  provade först: ${e}`);
    renderAsr();
    pump();
  } else if (msg.type === 'error' && msg.stage === 'load') {
    Object.assign(state.asr, { status: 'error', error: msg.message });
    log(`Whisper kunde inte laddas: ${msg.message}`);
    renderAsr();
  } else if (msg.type === 'error') {
    log(`Transkribering misslyckades: ${msg.message}`);
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
    log('Transkriberingen ligger efter – hoppar över en bit');
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
  state.busySince = Date.now() / 1000;
  state.asr.worker.postMessage({ type: 'transcribe', id, audio: chunk.samples }, [chunk.samples.buffer]);
  updateInfo();
}

function onTranscript({ id, text, ms }) {
  const chunk = state.pending.get(id);
  state.pending.delete(id);
  state.busy = false;
  state.workerRestarts = 0;
  if (chunk) {
    // Hinner telefonen med? Tar en bit längre tid än den är lång växer kön.
    state.slowChunks = ms > chunk.durationS * 1000 ? state.slowChunks + 1 : 0;
    adaptChunkLength(ms / 1000, chunk.durationS);
    if (state.slowChunks === 3) {
      log(`Whisper är för långsam: ${(ms / 1000).toFixed(1)} s för ${chunk.durationS.toFixed(1)} s ljud`);
    }
    state.lastLatency = Math.round((Date.now() / 1000 - chunk.receivedAt) * 1000);
    const clean = cleanText(text || '');
    if (clean) {
      state.segments.push({ text: clean, at: chunk.receivedAt, durationS: chunk.durationS, latencyMs: state.lastLatency });
      state.wordsSinceTopics += countWords(clean);
      addSegment(clean);
      saveSession();
    }
  }
  updateInfo();
  pump();
  maybeRefreshTopics();
}

/** Whisper räknar alltid på ett 30-sekundersfönster, så en bit kostar ungefär lika mycket
 *  oavsett längd. Korta bitar ger snabbare svar på en snabb telefon; på en långsam telefon
 *  måste bitarna vara minst så långa som det tar att transkribera dem, annars växer kön.
 *  Därför sätts längden efter hur lång tid Whisper faktiskt tar (3–25 s). */
const MIN_CHUNK_S = 3;
const MAX_CHUNK_S = 25;
function adaptChunkLength(tookS, durationS) {
  const cur = state.chunker.cfg.chunkSeconds;
  let next = cur;
  if (tookS > durationS * 0.8) {
    next = Math.min(MAX_CHUNK_S, Math.max(cur + 1, Math.ceil(tookS * 1.3)));
  } else if (tookS < durationS * 0.4 && cur > MIN_CHUNK_S) {
    next = Math.max(MIN_CHUNK_S, Math.ceil(Math.max(tookS * 1.5, cur * 0.7)));
  }
  if (next !== cur) {
    state.chunker.setChunkSeconds(next, Math.min(next + 3, 28));
    log(`Ljudbitar: ${next} s (Whisper tog ${tookS.toFixed(1)} s för ${durationS.toFixed(1)} s ljud)`);
  }
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
  renderSummaries();
  renderLlm();
  saveSession();
}

// ---------------------------------------------------------------- Spara samtalet

let saveTimer = null;
/** Spara samtalet i webbläsaren (fördröjt, så att det inte sker för ofta). */
function saveSession(immediately = false) {
  clearTimeout(saveTimer);
  if (!immediately) { saveTimer = setTimeout(() => saveSession(true), 500); return; }
  let segments = state.segments.slice(-MAX_SAVED_SEGMENTS);
  for (let attempt = 0; attempt < 4; attempt++) {
    const data = {
      v: 1, savedAt: Date.now() / 1000, startedAt: state.startedAt,
      wordsSinceTopics: state.wordsSinceTopics, segments, topics: topics.serialize(),
    };
    try {
      window.localStorage.setItem(SESSION_STORAGE, JSON.stringify(data));
      return;
    } catch (err) {
      // Fullt: spara färre av de äldsta meningarna.
      if (!segments.length) { log(`Kunde inte spara samtalet: ${err.message}`); return; }
      segments = segments.slice(Math.floor(segments.length / 2));
    }
  }
}

function restoreSession() {
  let data;
  try { data = JSON.parse(window.localStorage.getItem(SESSION_STORAGE) || 'null'); } catch { data = null; }
  if (!data || data.v !== 1) return;
  state.segments = Array.isArray(data.segments) ? data.segments.filter((x) => typeof x?.text === 'string') : [];
  if (Number.isFinite(data.startedAt)) state.startedAt = data.startedAt;
  state.wordsSinceTopics = Number(data.wordsSinceTopics) || 0;
  topics.restore(data.topics);
  for (const seg of state.segments.slice(-50)) addSegment(seg.text);
  renderSummaries();
  if (state.segments.length || topics.topics.size) {
    log(`Samtalet återställt: ${state.segments.length} meningar, ${topics.topics.size} ämnen`);
  }
}

function clearSession() {
  clearTimeout(saveTimer);
  store.del('localStorage', SESSION_STORAGE);
}

// Spara direkt när sidan stängs eller laddas om.
window.addEventListener('pagehide', () => saveSession(true));

// ---------------------------------------------------------------- Mikrofon

/** Öppna mikrofonen och ljudgrafen. Kastar vid fel. */
async function openAudio() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let ctx;
  try { ctx = new AudioContext({ sampleRate: 16000 }); } catch { ctx = new AudioContext(); }
  if (ctx.state === 'suspended') await ctx.resume();
  await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-processor');
  node.port.onmessage = ({ data }) => {
    state.lastAudioAt = Date.now() / 1000;
    if (data.level > 0) state.lastSoundAt = state.lastAudioAt;
    for (const chunk of state.chunker.feed(data.pcm)) if (chunk.voiced) enqueue(chunk);
    $('level').style.width = `${Math.min(100, Math.sqrt(data.level) * 180)}%`;
  };
  // Noden måste vara kopplad till grafen för att köras; tyst förstärkare till högtalaren.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node).connect(mute).connect(ctx.destination);

  // Android kan pausa ljudet (skärmen släckt, samtal, annan app tar mikrofonen).
  ctx.onstatechange = () => {
    log(`Ljudet: ${ctx.state}`);
    if (state.recording && ctx.state !== 'running' && ctx.state !== 'closed' && document.visibilityState === 'visible') {
      ctx.resume().catch(() => {});
    }
    setStatus();
  };
  for (const track of stream.getAudioTracks()) {
    track.onended = () => { log('Mikrofonen stängdes av systemet'); if (state.recording) restartAudio('mikrofonen stängdes'); };
    track.onmute = () => log('Mikrofonen tystades av systemet');
    track.onunmute = () => log('Mikrofonen är tillbaka');
  }
  log(`Mikrofonen öppnad (${ctx.sampleRate} Hz)`);
  return { ctx, stream, node };
}

async function closeAudio(a) {
  if (!a) return;
  a.node.port.onmessage = null;
  a.ctx.onstatechange = null;
  for (const t of a.stream.getTracks()) { t.onended = null; t.stop(); }
  try { await a.ctx.close(); } catch { /* redan stängd */ }
}

/** Stäng och öppna mikrofonen igen. Ljud som redan samlats behålls. */
async function restartAudio(reason) {
  if (state.restarting || !state.recording) return;
  state.restarting = true;
  state.lastAudioRestart = Date.now() / 1000;
  log(`Startar om mikrofonen (${reason})`);
  const old = state.audio;
  state.audio = null;
  await closeAudio(old);
  try {
    state.audio = await openAudio();
    state.lastAudioAt = state.lastSoundAt = Date.now() / 1000;
  } catch (err) {
    log(`Kunde inte öppna mikrofonen igen: ${err.message}`);
    showWarning(`Mikrofonen stannade och kunde inte startas igen (${err.message}). Tryck på Starta.`);
    await stopMic();
  } finally {
    state.restarting = false;
  }
}

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showWarning('Mikrofonen är inte tillgänglig. Sidan måste öppnas via https:// (t.ex. GitHub Pages) eller localhost.');
    return;
  }
  ensureModel();
  try {
    state.audio = await openAudio();
  } catch (err) {
    log(`Fick inte använda mikrofonen: ${err.message}`);
    showWarning(`Fick inte använda mikrofonen: ${err.message}`);
    return;
  }
  state.lastAudioAt = state.lastSoundAt = Date.now() / 1000;
  state.recording = true;
  setMicButton();
  renderSummaries();
  requestWakeLock();
  setStatus();
}

async function stopMic() {
  const a = state.audio;
  state.audio = null;
  state.recording = false;
  await closeAudio(a);
  log('Mikrofonen stoppad');
  const rest = state.chunker.flush(); // transkribera det som återstår
  if (rest?.voiced) enqueue(rest);
  setMicButton();
  renderSummaries();
  $('level').style.width = '0';
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  setStatus();
}

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
    state.wakeLock?.addEventListener('release', () => { state.wakeLock = null; });
  } catch (err) {
    log(`Kunde inte hålla skärmen tänd: ${err.message}`);
  }
}
document.addEventListener('visibilitychange', () => {
  log(document.visibilityState === 'visible' ? 'Sidan syns igen' : 'Sidan dold (skärmen släckt eller annan app)');
  if (document.visibilityState === 'visible' && state.recording) {
    if (!state.wakeLock) requestWakeLock();
    const ctx = state.audio?.ctx;
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    state.lastAudioAt = state.lastSoundAt = Date.now() / 1000; // ge ljudet en chans innan vakten slår till
  }
  setStatus();
});

// Vakten: upptäcker att mikrofonen eller Whisper har stannat och startar om dem.
function watchdog() {
  const now = Date.now() / 1000;
  if (state.recording && state.audio && !state.restarting && document.visibilityState === 'visible') {
    const track = state.audio.stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') {
      restartAudio('mikrofonspåret är stängt');
    } else if (now - state.lastAudioAt > AUDIO_SILENT_S) {
      restartAudio(`inga ljudblock på ${Math.round(now - state.lastAudioAt)} s`);
    } else if (now - state.lastSoundAt > AUDIO_ZERO_S && now - state.lastAudioRestart > AUDIO_RESTART_GAP_S) {
      restartAudio(`mikrofonen har bara gett tystnad i ${Math.round(now - state.lastSoundAt)} s${track.muted ? ' (tystad av systemet)' : ''}`);
    }
  }
  if (state.busy && now - state.busySince > TRANSCRIBE_TIMEOUT_S) {
    restartWorker(`En transkribering har tagit över ${TRANSCRIBE_TIMEOUT_S} s`);
  }
  updateInfo();
  setStatus();
}

// ---------------------------------------------------------------- Rendering

function setMicButton() {
  const on = state.recording;
  $('mic').classList.toggle('recording', on);
  $('mic-label').textContent = on ? 'Stoppa' : 'Starta';
  $('mic-icon').setAttribute('href', on ? '#i-stop' : '#i-mic');
}

function ago(seconds) {
  if (seconds < 15) return 'nyss';
  if (seconds < 90) return `för ${Math.round(seconds / 5) * 5} sekunder sedan`;
  return `för ${Math.round(seconds / 60)} minuter sedan`;
}

let shownNow = '';
function renderSummaries() {
  const nowS = Date.now() / 1000;
  const card = $('now-card');
  const now = topics.now;
  card.classList.toggle('waiting', !now);
  if (!now) {
    const waiting = state.recording
      ? 'Lyssnar. Efter några meningar står det här vad samtalet handlar om.'
      : 'Tryck på Starta och börja prata. Efter några meningar står det här vad samtalet handlar om.';
    if (shownNow !== waiting) { shownNow = waiting; $('now-text').textContent = waiting; }
    $('now-age').textContent = '';
    card.classList.remove('stale');
  } else {
    if (now.text !== shownNow) {
      shownNow = now.text;
      $('now-text').textContent = now.text;
      card.classList.remove('fresh');
      void card.offsetWidth; // starta om animationen
      card.classList.add('fresh');
    }
    const age = nowS - now.at;
    $('now-age').textContent = `Uppdaterat ${ago(age)}`;
    card.classList.toggle('stale', age > 90);
  }
  renderTopics(nowS);
}

function topicWhen(t, nowS) {
  if (t.active) return null; // visas som märket "Pratas om nu"
  const since = nowS - t.lastMentioned;
  return since < 60 ? 'Nämndes nyss' : `Nämndes ${ago(since)}`;
}

/** Ämneskorten: nyaste ämnet överst. Byggs bara om när något har ändrats. */
let knownTopics = new Set();
function renderTopics(nowS = Date.now() / 1000) {
  const list = $('topic-list');
  const items = topics.enabled ? topics.current(nowS).slice(0, topics.cfg.maxShown) : [];
  const view = items.map((t) => ({ ...t, when: topicWhen(t, nowS) }));
  const key = view.map((t) => `${t.label}|${t.summary}|${t.active}|${t.when}`).join('\n');
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  const seen = new Set();
  list.replaceChildren(...view.map((t) => {
    seen.add(t.label);
    const li = document.createElement('li');
    li.className = 'topic';
    if (!knownTopics.has(t.label) && knownTopics.size) li.classList.add('new');
    if (!t.active && nowS - t.lastMentioned > 5 * 60) li.classList.add('old');
    li.style.setProperty('--topic-color', topicColor(t.label));
    const head = Object.assign(document.createElement('div'), { className: 't-head' });
    head.append(Object.assign(document.createElement('h3'), { className: 't-label', textContent: t.label }));
    head.append(t.active
      ? Object.assign(document.createElement('span'), { className: 't-badge', textContent: 'Pratas om nu' })
      : Object.assign(document.createElement('span'), { className: 't-when', textContent: t.when }));
    li.append(head);
    if (t.summary) li.append(Object.assign(document.createElement('p'), { className: 't-summary', textContent: t.summary }));
    return li;
  }));
  knownTopics = seen.size ? seen : knownTopics;
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
  const paused = state.recording && (document.visibilityState !== 'visible'
    || (state.audio && state.audio.ctx.state !== 'running') || state.restarting);
  $('status').classList.add('online');
  $('status').classList.toggle('recording', state.recording && !paused);
  $('status-text').textContent = !state.recording ? 'Redo' : paused ? 'Pausad' : 'Lyssnar';
}

function updateInfo() {
  const parts = [];
  if (state.lastLatency != null) parts.push(`${(state.lastLatency / 1000).toFixed(1)} s`);
  const backlog = state.queue.length + (state.busy ? 1 : 0);
  if (backlog > 1) parts.push(`kö ${backlog}`);
  const busyFor = state.busy ? Date.now() / 1000 - state.busySince : 0;
  if (busyFor > 3) parts.push(`skriver… ${Math.round(busyFor)} s`);
  $('info').textContent = parts.join(' · ');
  if (state.slowChunks >= 3 && state.asr.status === 'ready' && !settings.model.includes('tiny')
      && state.chunker.cfg.chunkSeconds >= MAX_CHUNK_S) {
    showWarning('Telefonen hinner inte transkribera i realtid. Välj KB-Whisper tiny under Inställningar.');
  }
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
    box.querySelector('[role=progressbar]').setAttribute('aria-valuenow', String(Math.round(p?.progress ?? 0)));
    $('model-text').textContent = p?.total
      ? `Laddar ${MODEL_NAMES[p.model] || p.model}: ${Math.round(p.progress)} % (${MB(p.loaded)} av ${MB(p.total)})`
      : 'Förbereder taligenkänningen…';
    $('asr-status').textContent = 'Laddar modellen. Första gången hämtas den från Hugging Face, sedan finns den i webbläsaren.';
  } else {
    box.hidden = true;
  }
  if (a.status === 'ready') {
    const name = MODEL_NAMES[a.model] || a.model;
    const where = a.device === 'webgpu' ? 'grafikprocessorn (WebGPU)'
      : `processorn (WebAssembly, ${a.threads > 1 ? `${a.threads} kärnor` : '1 kärna'})`;
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
    ? 'Ordmolnet kommer från Claude. Ange din Anthropic API-nyckel under Inställningar. Det som sägs skrivs ut ändå.'
    : !llm.enabled ? 'Ämnen med Claude är avslaget, så molnet är tomt. Slå på det under Inställningar.'
      : llm.status === 'error' ? `Claude svarade med ett fel: ${llm.reason}` : '');
}

function setNotice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
function showWarning(text) { $('warning').textContent = text; $('warning').hidden = !text; }

// ---------------------------------------------------------------- Inställningar

function applySettingsToUi() {
  $('theme').value = settings.theme;
  $('text-size').value = settings.textSize;
  $('reduce-motion').checked = settings.reduceMotion;
  $('keep-min').value = settings.keepMinutes;
  $('keep-min-out').textContent = `${settings.keepMinutes} minuterna`;
  $('max-shown').value = settings.maxShown;
  $('max-shown-out').textContent = settings.maxShown;
  $('llm-interval').value = settings.interval;
  $('llm-interval-out').textContent = `${settings.interval} s`;
  $('asr-model').value = settings.model;
  $('show-transcript').checked = settings.showTranscript;
  document.body.classList.toggle('no-transcript', !settings.showTranscript);
  $('show-summaries').checked = settings.showSummaries;
  document.body.classList.toggle('no-summaries', !settings.showSummaries);
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
bindRange('keep-min', 'keep-min-out', 'keepMinutes', (v) => { topics.cfg.keepSeconds = v * 60; renderSummaries(); }, ' minuterna');
bindRange('max-shown', 'max-shown-out', 'maxShown', (v) => { topics.cfg.maxShown = v; renderSummaries(); });
bindRange('llm-interval', 'llm-interval-out', 'interval', (v) => { topics.cfg.intervalSeconds = v; }, ' s');

$('llm-enabled').addEventListener('change', (e) => {
  settings.llmEnabled = e.target.checked;
  saveSettings();
  topics.setEnabled(e.target.checked);
  renderSummaries();
  renderLlm();
  saveSession();
});

$('asr-model').addEventListener('change', (e) => {
  settings.model = e.target.value;
  saveSettings();
  if (state.asr.worker) {
    // Byt modell: starta en ny worker. Ljud som väntar ligger kvar i kön.
    state.workerRestarts = 0;
    state.slowChunks = 0;
    restartWorker('Bytt modell');
    state.workerRestarts = 0;
  }
});

for (const [id, key] of [['theme', 'theme'], ['text-size', 'textSize']]) {
  $(id).addEventListener('change', (e) => {
    settings[key] = e.target.value;
    saveSettings();
    applyAppearance();
  });
}
$('reduce-motion').addEventListener('change', (e) => {
  settings.reduceMotion = e.target.checked;
  saveSettings();
  applyAppearance();
});

$('show-summaries').addEventListener('change', (e) => {
  settings.showSummaries = e.target.checked;
  saveSettings();
  document.body.classList.toggle('no-summaries', !e.target.checked);
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

function openSettings() {
  applySettingsToUi();
  $('diag-log').textContent = state.log.slice(-60).join('\n') || '(inget ännu)';
  $('settings').showModal();
}
$('settings-btn').addEventListener('click', openSettings);
$('llm').addEventListener('click', openSettings);
$('copy-log').addEventListener('click', async () => {
  const text = [
    `Talmoln ${new Date().toISOString()}`,
    `Webbläsare: ${navigator.userAgent}`,
    `Whisper: ${state.asr.model} på ${state.asr.device} (${state.asr.status})`,
    `Kö: ${state.queue.length}, upptagen: ${state.busy}, ljud: ${state.audio?.ctx.state || '-'}`,
    '', ...state.log,
  ].join('\n');
  try { await navigator.clipboard.writeText(text); $('copy-log').textContent = 'Kopierat!'; } catch { $('copy-log').textContent = 'Kunde inte kopiera'; }
  setTimeout(() => { $('copy-log').textContent = 'Kopiera loggen'; }, 2000);
});

$('reset').addEventListener('click', () => {
  if (!confirm('Nollställa samtalet? Det som sagts, ämnena och Just nu tas bort från den här enheten.')) return;
  clearSession();
  state.segments = [];
  state.wordsSinceTopics = 0;
  state.queue = [];
  state.startedAt = Date.now() / 1000;
  topics.reset();
  $('transcript').replaceChildren();
  renderSummaries();
  renderLlm();
  log('Samtalet nollställt');
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
    now: topics.now?.text || null,
    topics: topics.current(now).map((t) => ({
      label: t.label, summary: t.summary, keywords: t.keywords,
      first_seen: new Date(t.firstSeen * 1000).toISOString(),
      last_mentioned: new Date(t.lastMentioned * 1000).toISOString(),
    })),
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
restoreSession();
setStatus();
setMicButton();
renderLlm();
renderSummaries();
setInterval(maybeRefreshTopics, 1000);
setInterval(watchdog, WATCHDOG_MS);
setInterval(() => { if (topics.topics.size || topics.now) renderSummaries(); renderLlm(); }, 2000);
