import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TopicLayer, TOOL_NAME, API_URL } from '../docs/topics.js';

const toolResponse = (topics, usage = [1200, 80]) => ({
  content: [{ type: 'tool_use', id: 't', name: TOOL_NAME, input: { topics } }],
  stop_reason: 'tool_use', usage: { input_tokens: usage[0], output_tokens: usage[1] },
});
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function layerWith(handler, cfg = {}) {
  const clock = { t: 1000 };
  const layer = new TopicLayer(cfg, { fetchFn: handler, clock: () => clock.t });
  layer.setApiKey('test-key');
  return { layer, clock };
}

test('anropet ser rätt ut och svaret tolkas', async () => {
  let seen;
  const { layer } = layerWith(async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return json(200, toolResponse([
      { label: 'Kontorsflytten', weight: 0.9, keywords: ['flytten', 'nya kontoret'] },
      { label: 'Budget', weight: 0.6, keywords: ['budgeten'] },
    ]));
  });
  assert.equal(await layer.refresh('vi måste prata om budgeten för nya kontoret'), true);
  assert.equal(seen.url, API_URL);
  assert.equal(seen.init.headers['x-api-key'], 'test-key');
  assert.equal(seen.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.ok(seen.init.headers['anthropic-version']);
  assert.equal(seen.body.model, 'claude-haiku-5-5');
  assert.equal(seen.body.tools[0].strict, true);
  assert.deepEqual(seen.body.tool_choice, { type: 'tool', name: TOOL_NAME });
  assert.ok(!('temperature' in seen.body));
  assert.deepEqual(layer.current().map((t) => t.label), ['Kontorsflytten', 'Budget']);
  const info = layer.info();
  assert.equal(info.status, 'ok');
  assert.deepEqual(info.usage, { calls: 1, failed: 0, inputTokens: 1200, outputTokens: 80 });
});

test('föregående ämnen skickas med', async () => {
  const bodies = [];
  const { layer, clock } = layerWith(async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    return json(200, toolResponse([{ label: 'Budget', weight: 0.8, keywords: ['budgeten'] }]));
  });
  await layer.refresh('budgeten');
  clock.t += 60;
  await layer.refresh('budgeten igen');
  assert.match(bodies[0].messages[0].content, /\(inga ännu\)/);
  assert.match(bodies[1].messages[0].content, /"label":"Budget"/);
});

const failures = [
  ['nätverksfel', async () => { throw new TypeError('Failed to fetch'); }, 'offline'],
  ['timeout', async (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))), 'offline'],
  ['429', async () => json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'lugn' } }), 'error'],
  ['529', async () => json(529, { type: 'error', error: { type: 'overloaded_error', message: 'full' } }), 'error'],
  ['inget verktygsanrop', async () => json(200, { content: [{ type: 'text', text: 'hej' }], stop_reason: 'end_turn', usage: {} }), 'error'],
  ['avböjd', async () => json(200, { content: [], stop_reason: 'refusal', usage: {} }), 'error'],
];
for (const [name, handler, status] of failures) {
  test(`fel (${name}) behåller gamla ämnen och kastar aldrig`, async () => {
    const { layer, clock } = layerWith(handler, { timeoutSeconds: 0.05 });
    layer.apply([{ label: 'Budget', weight: 1, keywords: ['budgeten'] }], clock.t);
    clock.t += 120;
    assert.equal(await layer.refresh('text'), false);
    assert.equal(layer.info().status, status);
    assert.equal(layer.usage.failed, 1);
    const kept = layer.current();
    assert.deepEqual(kept.map((t) => t.label), ['Budget']);
    assert.ok(Math.abs(kept[0].score - 0.5) < 1e-9);
  });
}

test('shouldCall följer intervall, ord, nyckel och av/på', async () => {
  const { layer, clock } = layerWith(async () => json(200, toolResponse([])), { intervalSeconds: 45, minNewWords: 40 });
  assert.ok(layer.shouldCall(40));
  assert.ok(!layer.shouldCall(39));
  await layer.refresh('x');
  assert.ok(!layer.shouldCall(100));
  clock.t += 45;
  assert.ok(layer.shouldCall(100));
  layer.setEnabled(false);
  assert.ok(!layer.shouldCall(100));
  assert.equal(layer.info().reason, 'disabled');
  const nokey = new TopicLayer();
  assert.ok(!nokey.shouldCall(1000));
  assert.equal(nokey.info().reason, 'no_key');
  assert.equal(await nokey.refresh('x'), false);
});

test('vikter blandas och omdöpta ämnen känns igen', () => {
  const { layer } = layerWith(null, { halfLifeSeconds: 60 });
  layer.apply([{ label: 'Kontorsflytten', weight: 1, keywords: ['flytten', 'nya kontoret', 'lokal'] }], 0);
  layer.apply([{ label: 'Flytt till nytt kontor', weight: 0.2, keywords: ['flytten', 'nya kontoret', 'lokal'] }], 60);
  const t = layer.current(60);
  assert.deepEqual(t.map((x) => x.label), ['Kontorsflytten']);
  assert.ok(Math.abs(t[0].score - (0.25 + 0.1)) < 1e-9);
});

test('molnet: ämnen störst, ord grupperade under starkaste ämnet', () => {
  const { layer } = layerWith(null, { keywordFactor: 0.5 });
  layer.apply([
    { label: 'Kontorsflytten', weight: 1, keywords: ['flytten', 'nya kontoret'] },
    { label: 'Budget', weight: 0.6, keywords: ['budgeten', 'flytten'] },
  ], 1000);
  const rows = layer.cloudTerms();
  assert.deepEqual(rows[0], { text: 'Kontorsflytten', weight: 1, kind: 'topic', topic: 'Kontorsflytten' });
  assert.equal(rows[1].text, 'Budget');
  const by = Object.fromEntries(rows.map((r) => [r.text, r]));
  assert.deepEqual(by.flytten, { text: 'flytten', weight: 0.5, kind: 'keyword', topic: 'Kontorsflytten' });
  assert.equal(by.budgeten.topic, 'Budget');
  assert.equal(rows.length, 5);
  layer.setEnabled(false);
  assert.deepEqual(layer.cloudTerms(), []);
});

test('byte av halveringstid behåller nuvarande vikter', () => {
  const { layer, clock } = layerWith(null, { halfLifeSeconds: 100 });
  layer.apply([{ label: 'Budget', weight: 1, keywords: [] }], 1000);
  clock.t = 1100;
  layer.setHalfLife(10);
  assert.ok(Math.abs(layer.current()[0].score - 0.5) < 1e-9);
  clock.t = 1110;
  assert.ok(Math.abs(layer.current()[0].score - 0.25) < 1e-9);
});
