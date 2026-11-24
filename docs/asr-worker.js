// Web Worker som kör Whisper i webbläsaren med transformers.js (ONNX Runtime).
// Modellen laddas ner från Hugging Face första gången och cachas sedan av
// webbläsaren. transformers.js och ONNX Runtimes WebAssembly-filer hämtas från
// jsDelivr, låsta till en exakt version. (Biblioteket ligger inte i repot:
// GitHubs skanner tar modellnamnet "Mistral3ForConditionalGeneration" för en
// API-nyckel och stoppar pushen.)
//
// Meddelanden in:  { type: 'load', models: [modelId, ...], device: 'auto'|'webgpu'|'wasm' }
//                  { type: 'transcribe', id, audio: Float32Array (16 kHz) }
// Meddelanden ut:  { type: 'progress', model, loaded, total, progress }
//                  { type: 'ready', model, device, dtype, fallback }
//                  { type: 'error', stage, message }
//                  { type: 'result', id, text, ms }

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';

env.allowLocalModels = false; // modeller hämtas alltid från Hugging Face (och cachas)
env.useBrowserCache = true;

// Flera trådar kräver cross-origin isolation (ordnas av coi-serviceworker.js).
const MAX_THREADS = self.crossOriginIsolated ? Math.max(1, Math.min(4, (self.navigator?.hardwareConcurrency || 2) - 1)) : 1;
env.backends.onnx.wasm.numThreads = MAX_THREADS;

let asr = null;

async function hasWebGPU() {
  try {
    return !!(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

// Kombinationer att prova, bäst först. Alla modeller har inte alla kvantiseringar.
function attempts(device) {
  if (device === 'webgpu') {
    return [
      { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
      { device: 'webgpu', dtype: 'fp32' },
      { device: 'wasm', dtype: 'q8' },
      { device: 'wasm', dtype: 'fp32' },
    ];
  }
  return [{ device: 'wasm', dtype: 'q8' }, { device: 'wasm', dtype: 'fp32' }];
}

async function load(models, device) {
  const dev = device === 'auto' || !device ? ((await hasWebGPU()) ? 'webgpu' : 'wasm') : device;
  const errors = [];
  for (const [i, model] of models.entries()) {
    for (const opt of attempts(dev)) {
     for (const threads of opt.device === 'wasm' && MAX_THREADS > 1 ? [MAX_THREADS, 1] : [MAX_THREADS]) {
      env.backends.onnx.wasm.numThreads = threads;
      try {
        asr = await pipeline('automatic-speech-recognition', model, {
          device: opt.device,
          dtype: opt.dtype,
          progress_callback: (p) => {
            if (p.status === 'progress_total') {
              self.postMessage({ type: 'progress', model, loaded: p.loaded, total: p.total, progress: p.progress });
            }
          },
        });
        self.postMessage({
          type: 'ready', model, device: opt.device, dtype: opt.dtype, fallback: i > 0, errors,
          threads: opt.device === 'wasm' ? threads : null,
          isolated: !!self.crossOriginIsolated, cores: self.navigator?.hardwareConcurrency || null,
        });
        return;
      } catch (err) {
        const msg = `${model} (${opt.device}, ${JSON.stringify(opt.dtype)}, ${threads} trådar): ${err?.message || err}`;
        console.warn('Kunde inte ladda', msg);
        errors.push(msg);
      }
     }
    }
  }
  self.postMessage({ type: 'error', stage: 'load', message: errors.join('\n') });
}

async function transcribe(id, audio) {
  const t0 = performance.now();
  try {
    const out = await asr(audio, { language: 'swedish', task: 'transcribe' });
    self.postMessage({ type: 'result', id, text: (out?.text || '').trim(), ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ type: 'error', stage: 'transcribe', id, message: err?.message || String(err) });
  }
}

// Meddelanden behandlas ett i taget så att två transkriberingar aldrig körs samtidigt.
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(() => {
    if (data.type === 'load') return load(data.models, data.device);
    if (data.type === 'transcribe') {
      if (!asr) {
        self.postMessage({ type: 'error', stage: 'transcribe', id: data.id, message: 'Modellen är inte laddad' });
        return undefined;
      }
      return transcribe(data.id, data.audio);
    }
    return undefined;
  });
};
