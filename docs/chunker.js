// Chunkning av 16 kHz float32-ljud med enkel energibaserad VAD.
//
// Vi samlar ljudet och klipper ut bitar om ungefär `chunkSeconds`. För att inte
// klippa mitt i ord väntar vi efter målängden på en tyst ram (under VAD-tröskeln)
// och klipper där. Kommer ingen paus före `maxChunkSeconds` klipper vi i den
// tystaste ramen inom sökfönstret.

export const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const MIN_VOICED_MS = 300;

export const DEFAULT_AUDIO = {
  chunkSeconds: 4,
  maxChunkSeconds: 7,
  cutSearchSeconds: 1.5,
  // RMS i float-skala (0–1). Motsvarar 250 i int16-skala.
  vadThreshold: 250 / 32768,
};

export function frameRms(samples, frameLen, start = 0, end = samples.length) {
  const n = Math.floor((end - start) / frameLen);
  const out = new Float32Array(Math.max(0, n));
  for (let f = 0; f < n; f++) {
    let sum = 0;
    const s = start + f * frameLen;
    for (let i = s; i < s + frameLen; i++) sum += samples[i] * samples[i];
    out[f] = Math.sqrt(sum / frameLen);
  }
  return out;
}

export class Chunker {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULT_AUDIO, ...opts };
    this.frameLen = (SAMPLE_RATE * FRAME_MS) / 1000;
    this.setChunkSeconds(this.cfg.chunkSeconds, this.cfg.maxChunkSeconds);
    this.reset();
  }

  /** Ändra bitarnas längd medan ljudet strömmar (används för att anpassa sig efter telefonens fart). */
  setChunkSeconds(seconds, maxSeconds = seconds + 3) {
    this.cfg.chunkSeconds = seconds;
    this.cfg.maxChunkSeconds = maxSeconds;
    this.chunkLen = Math.round(seconds * SAMPLE_RATE);
    this.maxLen = Math.max(Math.round(maxSeconds * SAMPLE_RATE), this.chunkLen);
    this.searchLen = Math.round(this.cfg.cutSearchSeconds * SAMPLE_RATE);
  }

  reset() {
    this.buf = new Float32Array(0);
    this.consumed = 0;
  }

  get bufferedSeconds() {
    return this.buf.length / SAMPLE_RATE;
  }

  /** Lägg till ljud. Returnerar färdiga bitar: { samples, startS, durationS, voiced, rms }. */
  feed(samples) {
    const merged = new Float32Array(this.buf.length + samples.length);
    merged.set(this.buf, 0);
    merged.set(samples, this.buf.length);
    this.buf = merged;
    const out = [];
    for (let cut = this.findCut(); cut !== null; cut = this.findCut()) out.push(this.emit(cut));
    return out;
  }

  /** Lämna ut det som finns kvar (t.ex. när mikrofonen stängs). */
  flush() {
    if (this.buf.length < this.frameLen * 5) {
      this.buf = new Float32Array(0);
      return null;
    }
    return this.emit(this.buf.length);
  }

  findCut() {
    const n = this.buf.length;
    if (n < this.chunkLen) return null;
    const fl = this.frameLen;
    // 1) Efter målängden: klipp i första tysta ram.
    const start = Math.floor(this.chunkLen / fl) * fl;
    const end = Math.min(n, this.maxLen);
    const rms = frameRms(this.buf, fl, start, end);
    for (let i = 0; i < rms.length; i++) {
      if (rms[i] < this.cfg.vadThreshold) return start + i * fl + fl / 2;
    }
    // 2) Ingen paus före maxlängden: klipp i tystaste ram i sökfönstret,
    //    som aldrig börjar före halva målängden.
    if (n >= this.maxLen) {
      const s = Math.floor(Math.max(this.chunkLen / 2, this.maxLen - this.searchLen) / fl) * fl;
      const r = frameRms(this.buf, fl, s, this.maxLen);
      if (r.length === 0) return this.maxLen;
      let best = 0;
      for (let i = 1; i < r.length; i++) if (r[i] < r[best]) best = i;
      return s + best * fl + fl / 2;
    }
    return null;
  }

  emit(cut) {
    const samples = this.buf.slice(0, cut);
    this.buf = this.buf.slice(cut);
    const startS = this.consumed / SAMPLE_RATE;
    this.consumed += samples.length;
    const rmsFrames = frameRms(samples, this.frameLen);
    let voicedFrames = 0;
    for (const r of rmsFrames) if (r >= this.cfg.vadThreshold) voicedFrames++;
    let sum = 0;
    for (const v of samples) sum += v * v;
    return {
      samples,
      startS,
      durationS: samples.length / SAMPLE_RATE,
      voiced: voicedFrames * FRAME_MS >= MIN_VOICED_MS,
      rms: samples.length ? Math.sqrt(sum / samples.length) : 0,
    };
  }
}

// Fraser som Whisper ofta "hallucinerar" ur tystnad eller brus (inlärda från undertexter).
const HALLUCINATIONS = [
  String.raw`textning\.nu`,
  String.raw`svensktextning\.nu`,
  String.raw`undertext(?:er|ning)? (?:från|av) [\p{L}\.\- ]+`,
  String.raw`amara\.org[\p{L}\- ]*`,
  String.raw`tack för att (?:ni|du) (?:har )?(?:tittat|tittade|lyssnat|lyssnade)`,
  String.raw`glöm inte att prenumerera[\p{L} ,!]*`,
  String.raw`prenumerera på kanalen[\p{L} ,!]*`,
];
const HALLU_RE = new RegExp(HALLUCINATIONS.join('|'), 'giu');
const BRACKETS_RE = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/gu;

export function cleanText(text) {
  let t = text.replace(BRACKETS_RE, ' ').replace(HALLU_RE, ' ');
  t = t.replace(/\s+/gu, ' ').trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

export function countWords(text) {
  return (text.match(/\p{L}+/gu) || []).length;
}
