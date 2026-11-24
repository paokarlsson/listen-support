// AudioWorkletProcessor: mikrofonljud (valfri samplingsfrekvens) → float32 mono @ 16 kHz.
// Skickar block om 100 ms till huvudtråden tillsammans med en nivåmätning.

const TARGET_RATE = 16000;
const BLOCK = 1600; // 100 ms @ 16 kHz

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // `sampleRate` är global i worklet-scope
    this.pos = 0;   // fraktionell läsposition i inkommande ström
    this.prev = 0;  // sista samplet från förra blocket (för interpolation)
    this.out = new Float32Array(BLOCK);
    this.n = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    const len = ch.length;

    if (this.ratio === 1) {
      for (let i = 0; i < len; i++) this.push(ch[i]);
    } else {
      // Linjär interpolation. Index -1 motsvarar this.prev.
      while (this.pos < len - 1) {
        const i = Math.floor(this.pos);
        const frac = this.pos - i;
        const a = i < 0 ? this.prev : ch[i];
        const b = ch[i + 1];
        this.push(a + (b - a) * frac);
        this.pos += this.ratio;
      }
      this.pos -= len;
      this.prev = ch[len - 1];
    }
    return true;
  }

  push(v) {
    if (v > 1) v = 1; else if (v < -1) v = -1;
    this.sumSq += v * v;
    this.out[this.n++] = v;
    if (this.n === BLOCK) {
      const level = Math.sqrt(this.sumSq / BLOCK);
      this.port.postMessage({ pcm: this.out, level }, [this.out.buffer]);
      this.out = new Float32Array(BLOCK);
      this.n = 0;
      this.sumSq = 0;
    }
  }
}

registerProcessor('pcm-processor', PcmProcessor);
