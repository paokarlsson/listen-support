import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TopicLayer, TOOL_NAME, API_URL } from '../docs/topics.js';

const toolResponse = (topics, usage = [1200, 80], now = '') => ({
  content: [{ type: 'tool_use', id: 't', name: TOOL_NAME, input: { now, topics } }],
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

test('byte av halveringstid behåller nuvarande vikter', () => {
  const { layer, clock } = layerWith(null, { halfLifeSeconds: 100 });
  layer.apply([{ label: 'Budget', weight: 1, keywords: [] }], 1000);
  clock.t = 1100;
  layer.setHalfLife(10);
  assert.ok(Math.abs(layer.current()[0].score - 0.5) < 1e-9);
  clock.t = 1110;
  assert.ok(Math.abs(layer.current()[0].score - 0.25) < 1e-9);
});

test('svaret ger en mening per ämne på lättläst svenska', async () => {
  let body;
  const { layer, clock } = layerWith(async (_u, init) => {
    body = JSON.parse(init.body);
    return json(200, toolResponse(
      [{ label: 'Kontorsflytten', summary: 'Flytten till nya kontoret blir i mars.', weight: 0.9, keywords: ['flytten'] }],
      [900, 60], 'Ni pratar om flytten till nya kontoret.',
    ));
  });
  await layer.refresh('flytten till nya kontoret blir i mars');
  const schema = body.tools[0].input_schema;
  assert.deepEqual(schema.required, ['topics']);
  assert.ok(schema.properties.topics.items.required.includes('summary'));
  assert.match(body.system, /lättläst svenska/);
  assert.equal(layer.current()[0].summary, 'Flytten till nya kontoret blir i mars.');
});

test('tom just-nu-mening behåller den förra, och av/på tömmer den', () => {
  const { layer } = layerWith(null);
  layer.apply({ now: 'Budgeten är tight.', topics: [] }, 1000);
  layer.apply({ now: '', topics: [] }, 1010);
  assert.equal(layer.now.text, 'Budgeten är tight.');
  layer.setEnabled(false);
  assert.equal(layer.now, null);
});

test('nyaste ämnet överst, och ordningen hoppar inte när ett gammalt ämne nämns igen', () => {
  const { layer } = layerWith(null);
  layer.apply({ now: '', topics: [{ label: 'Budget', summary: 'a', weight: 0.9, keywords: [] }] }, 1000);
  layer.apply({ now: '', topics: [{ label: 'Flytten', summary: 'b', weight: 0.9, keywords: [] }] }, 1010);
  layer.apply({ now: '', topics: [{ label: 'Semester', summary: 'c', weight: 0.9, keywords: [] }] }, 1020);
  assert.deepEqual(layer.current(1020).map((t) => t.label), ['Semester', 'Flytten', 'Budget']);
  // Budget pratas om igen: står kvar på sin plats men märks som aktuellt.
  layer.apply({ now: '', topics: [{ label: 'Budget', summary: 'a2', weight: 0.8, keywords: [] }] }, 1030);
  const list = layer.current(1031);
  assert.deepEqual(list.map((t) => t.label), ['Semester', 'Flytten', 'Budget']);
  assert.deepEqual(list.map((t) => t.active), [false, false, true]);
  assert.equal(list[2].summary, 'a2');
});

test('"pratas om nu" kräver tydlig vikt i senaste svaret och slocknar efter en stund', () => {
  const { layer } = layerWith(null, { activeSeconds: 90, activeWeight: 0.4 });
  layer.apply({ now: '', topics: [
    { label: 'Budget', summary: 'a', weight: 0.9, keywords: [] },
    { label: 'Väder', summary: 'b', weight: 0.1, keywords: [] }] }, 1000);
  const by = (t) => Object.fromEntries(layer.current(t).map((x) => [x.label, x.active]));
  assert.deepEqual(by(1000), { Budget: true, Väder: false });
  assert.deepEqual(by(1100), { Budget: false, Väder: false });
});

test('ämnen som inte nämnts på keepSeconds försvinner ur listan', () => {
  const { layer } = layerWith(null, { keepSeconds: 600 });
  layer.apply({ now: '', topics: [{ label: 'Budget', summary: 'a', weight: 1, keywords: [] }] }, 1000);
  assert.equal(layer.current(1599).length, 1);
  assert.equal(layer.current(1601).length, 0);
});

test('ämnena kan sparas och återställas (överlever omladdning)', () => {
  const { layer } = layerWith(null, { halfLifeSeconds: 60 });
  layer.apply({ now: 'Ni pratar om budgeten.', topics: [{ label: 'Budget', summary: 'Budgeten är tight.', weight: 1, keywords: ['budgeten'] }] }, 1000);
  layer.usage.calls = 3;
  const saved = JSON.parse(JSON.stringify(layer.serialize()));
  const { layer: fresh } = layerWith(null, { halfLifeSeconds: 60 });
  fresh.restore(saved);
  assert.equal(fresh.current(1060)[0].firstSeen, 1000);
  assert.equal(fresh.current(1060)[0].active, true);
  assert.deepEqual(fresh.now, { text: 'Ni pratar om budgeten.', at: 1000 });
  const [t] = fresh.current(1060);
  assert.equal(t.label, 'Budget');
  assert.equal(t.summary, 'Budgeten är tight.');
  assert.ok(Math.abs(t.score - 0.5) < 1e-9); // avklingningen fortsätter från sparad tid
  assert.equal(fresh.usage.calls, 3);
  fresh.restore({ topics: [{ label: '', score: 'x' }] });
  assert.equal(fresh.topics.size, 0); // trasig data ignoreras
});
