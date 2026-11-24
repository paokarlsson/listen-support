import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chunker, cleanText, countWords, SAMPLE_RATE } from '../docs/chunker.js';

const tone = (s, amp = 0.25) => Float32Array.from({ length: Math.round(s * SAMPLE_RATE) }, (_, i) => amp * Math.sin(2 * Math.PI * 220 * i / SAMPLE_RATE));
const silence = (s) => new Float32Array(Math.round(s * SAMPLE_RATE));
const concat = (...parts) => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const feedAll = (ch, audio, block = 1600) => { const out = []; for (let i = 0; i < audio.length; i += block) out.push(...ch.feed(audio.subarray(i, i + block))); return out; };

test('klipper vid första paus efter målängden', () => {
  const chunks = feedAll(new Chunker({ chunkSeconds: 6, maxChunkSeconds: 9 }), concat(tone(7), silence(0.5), tone(3)));
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].durationS >= 7 && chunks[0].durationS <= 7.1, chunks[0].durationS);
  assert.ok(chunks[0].voiced);
});

test('klipper vid maxlängd utan paus', () => {
  const chunks = feedAll(new Chunker({ chunkSeconds: 6, maxChunkSeconds: 9 }), tone(20));
  assert.equal(chunks.length, 2);
  for (const c of chunks) assert.ok(c.durationS >= 6.9 && c.durationS <= 9, c.durationS);
});

test('korta mål och maxlängder ger inga mikrobitar', () => {
  const chunks = feedAll(new Chunker({ chunkSeconds: 1, maxChunkSeconds: 1.5 }), tone(1.6));
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].durationS >= 0.5);
});

test('tystnad räknas inte som tal', () => {
  const chunks = feedAll(new Chunker(), silence(7));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].voiced, false);
});

test('flush lämnar ut resten och inget ljud tappas', () => {
  const ch = new Chunker();
  const audio = concat(tone(7), silence(0.5), tone(2));
  const chunks = feedAll(ch, audio);
  const rest = ch.flush();
  const total = chunks.reduce((n, c) => n + c.samples.length, 0) + rest.samples.length;
  assert.equal(total, audio.length);
  assert.equal(ch.flush(), null);
});

test('cleanText tar bort hallucinationer och ljudtaggar', () => {
  assert.equal(cleanText(' Textning.nu '), '');
  assert.equal(cleanText('[MUSIK] Hej budgeten. Tack för att ni tittade!'), 'Hej budgeten. !');
  assert.equal(cleanText('  vi pratar om flytten '), 'vi pratar om flytten');
  assert.equal(countWords('Vi måste prata om budgeten, 2024!'), 5);
});
