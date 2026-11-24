// Ljudet lämnar aldrig telefonen. Vår egen kod får bara anropa Anthropic och läsa
// transformers.js från jsDelivr (låst version). Modellen hämtas från Hugging Face
// och ONNX Runtime från jsDelivr av biblioteket självt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const DOCS = new URL('../docs/', import.meta.url);
const ALLOWED = new Set(['api.anthropic.com', 'cdn.jsdelivr.net']);
const files = readdirSync(DOCS).filter((f) => /\.(js|html|css)$/.test(f));

for (const f of files) {
  test(`${f} anropar bara tillåtna värdar`, () => {
    const text = readFileSync(new URL(f, DOCS), 'utf8');
    const code = text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    const hosts = new Set([...code.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)].map((m) => m[1]));
    for (const h of hosts) assert.ok(ALLOWED.has(h), `${f} anropar ${h}`);
    assert.doesNotMatch(text, /(?:src|href)\s*=\s*["']https?:/, `${f} laddar något utifrån i HTML`);
  });
}

test('biblioteket är låst till en exakt version', () => {
  const worker = readFileSync(new URL('asr-worker.js', DOCS), 'utf8');
  assert.match(worker, /@huggingface\/transformers@\d+\.\d+\.\d+\//);
});
