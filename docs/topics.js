// Ämneslagret: skickar senaste minuternas transkript till Claude och får tillbaka
// ämnen med vikter. Anropet går direkt från webbläsaren till Anthropic.
//
// Svaret kommer som strukturerad JSON via ett verktyg (`report_topics`) med
// `strict: true`, så att det alltid går att tolka. Alla fel fångas här: appen ska
// aldrig krascha på grund av API:t. Vid fel behålls senaste ämnen och de avklingar.

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2026-10-21';
export const TOOL_NAME = 'report_topics';

export const DEFAULT_TOPICS = {
  model: 'claude-haiku-5-5',
  intervalSeconds: 10,
  minNewWords: 8,
  windowSeconds: 120,
  maxWindowChars: 8000,
  maxTopics: 8,
  timeoutSeconds: 15,
  maxTokens: 1024,
  halfLifeSeconds: 120,
  forgetBelow: 0.05,
  showKeywords: false,
  keywordFactor: 0.45,
  maxWords: 40,
};

const SYSTEM_PROMPT = (maxTopics) => `\
Du hjälper en person med nedsatt kognitiv förmåga att hänga med i ett samtal. Du får \
ett löpande transkript av samtalet på svenska. Det är automatiskt transkriberat och \
innehåller därför fel.

Svara med:
- now: en mening som säger vad samtalet handlar om just nu, alltså i det senaste avsnittet.
- topics: de 1–${maxTopics} ämnen som samtalet handlar om, viktigast först. För varje ämne:
  - label: ett kort namn, 1–3 ord.
  - summary: en mening om vad som sägs om ämnet.
  - weight: 0–1, hur mycket det pratas om ämnet i det senaste avsnittet.
  - keywords: ord ur transkriptet som hör till ämnet.

Skriv på lättläst svenska:
- Högst 15 ord per mening.
- Vanliga, konkreta ord. Inga förkortningar, inga facktermer.
- Säg vad som faktiskt sägs: vem, vad, när. Skriv till exempel \
"Flytten till nya kontoret blir i mars." och inte "Samtalet berör en flytt."
- Tilltala inte läsaren och skriv inte "transkriptet".

Återanvänd namnen från föregående ämneslista när ämnet är detsamma, så att det är lätt \
att känna igen. Hitta inte på något som inte sägs. Gissa inte när transkriptet är \
otydligt: hoppa över det. Om det inte går att säga vad samtalet handlar om, låt now \
vara tom och returnera en tom lista.

Svara genom att anropa verktyget report_topics.`;

export const TOOL = {
  name: TOOL_NAME,
  description: 'Rapportera vilka ämnen samtalet handlar om just nu.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['now', 'topics'],
    properties: {
      now: { type: 'string', description: 'En mening på lättläst svenska: vad samtalet handlar om just nu.' },
      topics: {
        type: 'array',
        description: 'Ämnen, viktigast först.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'summary', 'weight', 'keywords'],
          properties: {
            label: { type: 'string', description: 'Kort ämnesnamn, 1–3 ord, svenska.' },
            summary: { type: 'string', description: 'En mening på lättläst svenska om vad som sägs om ämnet.' },
            weight: { type: 'number', description: '0–1: hur mycket det pratas om ämnet just nu.' },
            keywords: {
              type: 'array',
              description: 'Ord ur transkriptet som hör till ämnet.',
              items: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

export class TopicError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status; // 'offline' | 'error'
  }
}

const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export class TopicLayer {
  constructor(opts = {}, { fetchFn, clock } = {}) {
    this.cfg = { ...DEFAULT_TOPICS, ...opts };
    this.apiKey = '';
    this.enabled = true;
    this.fetch = fetchFn || ((...a) => fetch(...a));
    this.clock = clock || (() => Date.now() / 1000);
    this.topics = new Map(); // norm(label) → { label, score, updated, keywords, summary }
    this.now = null;         // { text, at }: vad samtalet handlar om just nu
    this.status = 'pending';
    this.lastError = null;
    this.lastSuccess = null;
    this.lastAttempt = 0;
    this.inFlight = false;
    this.resetUsage();
  }

  // -- tillstånd ------------------------------------------------------------

  get hasKey() { return !!this.apiKey; }
  get active() { return this.enabled && this.hasKey; }

  setApiKey(key) {
    this.apiKey = (key || '').trim();
    if (this.status !== 'ok') { this.status = 'pending'; this.lastError = null; }
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) { this.topics.clear(); this.now = null; } // integritet: allt från Claude försvinner direkt
  }

  resetUsage() {
    this.usage = { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
  }

  reset() {
    this.topics.clear();
    this.now = null;
    this.lastSuccess = null;
    this.lastAttempt = 0;
    this.resetUsage();
    if (this.status === 'ok') this.status = 'pending';
  }

  info(now = this.clock()) {
    let status = this.status;
    let reason = this.lastError;
    if (!this.hasKey) { status = 'off'; reason = 'no_key'; }
    else if (!this.enabled) { status = 'off'; reason = 'disabled'; }
    return {
      status,
      reason,
      enabled: this.enabled,
      hasKey: this.hasKey,
      model: this.cfg.model,
      lastUpdateS: this.lastSuccess === null ? null : Math.round(now - this.lastSuccess),
      busy: this.inFlight,
      usage: { ...this.usage },
    };
  }

  shouldCall(newWords, now = this.clock()) {
    return this.active && !this.inFlight
      && newWords >= this.cfg.minNewWords
      && now - this.lastAttempt >= this.cfg.intervalSeconds;
  }

  scoreAt(t, now) {
    const dt = Math.max(0, now - t.updated);
    return t.score * Math.exp(-Math.LN2 * dt / this.cfg.halfLifeSeconds);
  }

  setHalfLife(seconds, now = this.clock()) {
    for (const t of this.topics.values()) {
      t.score = this.scoreAt(t, now);
      t.updated = now;
    }
    this.cfg.halfLifeSeconds = Math.max(5, Number(seconds));
  }

  /** Ämnen med avklingad poäng, starkast först. Döda ämnen rensas bort. */
  current(now = this.clock()) {
    const out = [];
    for (const [key, t] of this.topics) {
      const s = this.scoreAt(t, now);
      if (s < this.cfg.forgetBelow) { this.topics.delete(key); continue; }
      out.push({ label: t.label, score: s, keywords: t.keywords, summary: t.summary || '' });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Det som visas i molnet: ämnesnamn som stora ord och ämnenas ord runt omkring. */
  cloudTerms(now = this.clock()) {
    const topics = this.enabled ? this.current(now) : [];
    if (!topics.length) return [];
    const rows = new Map();
    for (const t of topics) rows.set(norm(t.label), { text: t.label, weight: t.score, kind: 'topic', topic: t.label });
    if (this.cfg.showKeywords) {
      for (const t of topics) {
        for (const kw of t.keywords) {
          const key = norm(kw);
          const w = t.score * this.cfg.keywordFactor;
          if (!key || (rows.has(key) && rows.get(key).weight >= w)) continue;
          rows.set(key, { text: kw, weight: w, kind: 'keyword', topic: t.label });
        }
      }
    }
    const out = [...rows.values()]
      .sort((a, b) => b.weight - a.weight || (a.kind === 'topic' ? -1 : 1) - (b.kind === 'topic' ? -1 : 1) || a.text.localeCompare(b.text))
      .slice(0, this.cfg.maxWords);
    const top = out[0].weight || 1;
    for (const r of out) r.weight = Math.round((r.weight / top) * 10000) / 10000;
    return out;
  }

  // -- anrop ----------------------------------------------------------------

  /** Fråga Claude om ämnen. Returnerar true om ämnena uppdaterades. Kastar aldrig. */
  async refresh(transcript, now = this.clock()) {
    if (!this.active || this.inFlight) return false;
    this.inFlight = true;
    this.lastAttempt = now;
    let result;
    try {
      result = await this.call(transcript, now);
    } catch (err) {
      this.usage.failed++;
      this.status = err instanceof TopicError ? err.status : 'error';
      this.lastError = err.message || String(err);
      console.warn('Ämneslagret:', this.status, this.lastError);
      return false;
    } finally {
      this.inFlight = false;
    }
    if (!this.enabled) return false; // avslaget medan anropet pågick: släng svaret
    this.apply(result, this.clock());
    this.status = 'ok';
    this.lastError = null;
    this.lastSuccess = this.clock();
    return true;
  }

  buildRequest(transcript, now = this.clock()) {
    const previous = this.current(now).map((t) => ({
      label: t.label, weight: Math.round(t.score * 100) / 100, keywords: t.keywords.slice(0, 8),
    }));
    const user = 'Föregående ämneslista (återanvänd namnen när ämnet är detsamma):\n'
      + `${previous.length ? JSON.stringify(previous) : '(inga ännu)'}\n\n`
      + 'Transkript, äldst först (de sista raderna är det senaste avsnittet):\n'
      + `<transkript>\n${transcript}\n</transkript>`;
    return {
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens,
      system: SYSTEM_PROMPT(this.cfg.maxTopics),
      tools: [TOOL],
      // Haiku 5.5 tillåter ett tvingat verktygsanrop; svaret blir då alltid ett report_topics-anrop.
      tool_choice: { type: 'tool', name: TOOL_NAME },
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: user }],
    };
  }

  headers() {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      // Krävs för anrop direkt från en webbsida. Nyckeln syns för skript på sidan,
      // därför: använd en egen nyckel med låg utgiftsgräns.
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  async call(transcript, now) {
    const body = this.buildRequest(transcript, now);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutSeconds * 1000);
    const started = performance.now();
    let resp;
    try {
      resp = await this.fetch(API_URL, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: ctrl.signal,
      });
    } catch (err) {
      // Nätverksfel (inget nät, DNS, CORS) och timeout.
      throw new TopicError('offline', err.name === 'AbortError' ? 'Timeout' : (err.message || 'Nätverksfel'));
    } finally {
      clearTimeout(timer);
    }

    if (resp.status !== 200) throw new TopicError('error', `HTTP ${resp.status}: ${await errorMessage(resp)}`);
    let data;
    try { data = await resp.json(); } catch { throw new TopicError('error', 'Ogiltig JSON i svaret'); }

    const u = data.usage || {};
    this.usage.calls++;
    this.usage.inputTokens += u.input_tokens || 0;
    this.usage.outputTokens += u.output_tokens || 0;
    console.info(`Ämneslagret: ${u.input_tokens || 0} tokens in, ${u.output_tokens || 0} ut, `
      + `${((performance.now() - started) / 1000).toFixed(1)} s (sessionen: ${this.usage.inputTokens} in, `
      + `${this.usage.outputTokens} ut, ${this.usage.calls} anrop)`);

    if (data.stop_reason === 'refusal') throw new TopicError('error', 'Claude avböjde förfrågan');
    for (const block of data.content || []) {
      if (block.type === 'tool_use' && block.name === TOOL_NAME && Array.isArray(block.input?.topics)) {
        return block.input;
      }
    }
    throw new TopicError('error', `Inget ${TOOL_NAME}-anrop i svaret (stop_reason=${data.stop_reason})`);
  }

  /** Kolla att nyckeln fungerar utan att kosta något (listar modeller). */
  async testKey() {
    try {
      const resp = await this.fetch('https://api.anthropic.com/v1/models?limit=1', { headers: this.headers() });
      if (resp.ok) return { ok: true, message: 'Nyckeln fungerar.' };
      return { ok: false, message: `HTTP ${resp.status}: ${await errorMessage(resp)}` };
    } catch (err) {
      return { ok: false, message: `Nätverksfel: ${err.message}` };
    }
  }

  // -- sammanvägning över tid --------------------------------------------------

  /** Väv in ett nytt svar: blanda med de avklingade gamla vikterna och fånga namnbyten.
   *  Tar emot verktygets indata ({ now, topics }) eller bara listan med ämnen. */
  apply(result, now) {
    const rawTopics = Array.isArray(result) ? result : result?.topics;
    if (!Array.isArray(result) && typeof result?.now === 'string') {
      const text = result.now.trim();
      if (text) this.now = { text, at: now };
    }
    const cleaned = [];
    for (const item of (rawTopics || []).slice(0, this.cfg.maxTopics)) {
      if (!item || typeof item !== 'object') continue;
      const label = String(item.label || '').trim();
      if (!label) continue;
      let weight = Number(item.weight);
      if (!Number.isFinite(weight)) weight = 0;
      weight = Math.min(1, Math.max(0, weight));
      const kws = (Array.isArray(item.keywords) ? item.keywords : []).map((k) => String(k).trim()).filter(Boolean);
      const summary = String(item.summary || '').trim();
      cleaned.push({ label, weight, kws, summary });
    }
    const used = new Set();
    for (const { label, weight, kws, summary } of cleaned) {
      let key = norm(label);
      let existing = this.topics.get(key);
      if (!existing) {
        const match = this.matchByKeywords(kws, used);
        if (match) {
          console.info(`Ämneslagret: '${label}' tolkas som befintliga '${match.label}'`);
          existing = match;
          key = norm(match.label);
        }
      }
      used.add(key);
      if (!existing) {
        this.topics.set(key, { label, score: weight, updated: now, keywords: kws, summary });
      } else {
        existing.score = 0.5 * this.scoreAt(existing, now) + 0.5 * weight;
        existing.updated = now;
        if (kws.length) existing.keywords = kws;
        if (summary) existing.summary = summary;
      }
    }
  }

  /** Hitta ett befintligt ämne med i stort sett samma ord (Claude har bytt namn). */
  matchByKeywords(kws, exclude) {
    const fresh = new Set(kws.map((k) => k.toLowerCase()));
    if (!fresh.size) return null;
    let best = null;
    let bestScore = 0;
    for (const [key, t] of this.topics) {
      if (exclude.has(key) || !t.keywords.length) continue;
      const old = new Set(t.keywords.map((k) => k.toLowerCase()));
      let inter = 0;
      for (const k of fresh) if (old.has(k)) inter++;
      const jaccard = inter / (fresh.size + old.size - inter);
      if (jaccard > bestScore) { best = t; bestScore = jaccard; }
    }
    return bestScore >= 0.5 ? best : null;
  }
}

async function errorMessage(resp) {
  try {
    const data = await resp.json();
    const e = data.error || {};
    return [e.type, e.message].filter(Boolean).join(': ');
  } catch {
    return '';
  }
}
