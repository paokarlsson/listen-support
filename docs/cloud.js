// Levande ordmoln utan beroenden.
//
// Varje ord är ett absolut positionerat <span>. Vid varje uppdatering placeras
// orden i viktordning: ett ord som redan finns stannar kvar på sin plats om den
// fortfarande är ledig, annars letar vi längs en spiral efter närmaste lediga
// plats. Storlek, position och opacitet animeras med CSS-transitioner, så
// molnet "andas" i stället för att ritas om från noll varje gång.

const PALETTE = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'];
const PAD = 4; // px luft runt varje ord

/** Färgen för ett ämne (samma i molnet och i listan). */
export function topicColor(name) {
  return `var(${PALETTE[hash(String(name).toLowerCase()) % PALETTE.length]})`;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class WordCloud {
  constructor(container) {
    this.el = container;
    this.words = new Map(); // text → { el, x, y, w, h, size }
    this.terms = [];
    this.ctx = document.createElement('canvas').getContext('2d');
    this.font = getComputedStyle(container).fontFamily || 'sans-serif';
    this.ro = new ResizeObserver(() => this.layout(true));
    this.ro.observe(container);
  }

  update(terms) {
    this.terms = terms || [];
    this.layout(false);
  }

  clear() {
    this.terms = [];
    for (const w of this.words.values()) w.el.remove();
    this.words.clear();
  }

  measure(text, size, weight) {
    this.ctx.font = `${weight} ${size}px ${this.font}`;
    return { w: this.ctx.measureText(text).width + PAD * 2, h: size * 1.15 + PAD * 2 };
  }

  layout(fresh) {
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (!W || !H) return;

    // Skala typsnittet efter ytan och antalet ord.
    const n = Math.max(this.terms.length, 1);
    const maxSize = Math.min(W / 5.5, H / 4, 30 + 260 / Math.sqrt(n));
    const minSize = Math.max(11, maxSize * 0.18);

    const placed = [];
    const seen = new Set();

    for (const term of this.terms) {
      const text = term.text;
      seen.add(text);
      const weight = Math.max(0, Math.min(1, term.weight));
      let size = minSize + (maxSize - minSize) * Math.pow(weight, 0.75);
      const fw = term.kind === 'topic' ? 800 : weight > 0.6 ? 700 : weight > 0.3 ? 600 : 500;

      let w = this.words.get(text);
      if (!w) {
        const el = document.createElement('span');
        el.className = 'word entering';
        el.textContent = text;
        this.el.appendChild(el);
        w = { el, x: null, y: null };
        this.words.set(text, w);
      }
      // Ett ämne och dess ord får samma färg, så att de syns som en grupp.
      const isTopic = term.kind === 'topic';
      w.el.classList.toggle('topic', isTopic);
      w.el.style.color = topicColor(term.topic || text);

      // Försök några gånger med mindre storlek om ordet inte får plats.
      let spot = null;
      let box;
      for (let attempt = 0; attempt < 3 && !spot; attempt++) {
        box = this.measure(text, size, fw);
        if (box.w > W) { size *= W / box.w * 0.95; continue; }
        const hint = !fresh && w.x !== null ? { x: w.x, y: w.y } : null;
        spot = this.findSpot(box, hint, placed, W, H);
        if (!spot) size *= 0.8;
      }

      if (!spot) {
        w.el.classList.add('hidden');
        continue;
      }
      placed.push({ x: spot.x - box.w / 2, y: spot.y - box.h / 2, w: box.w, h: box.h });
      w.x = spot.x;
      w.y = spot.y;
      w.el.classList.remove('hidden');
      w.el.style.fontSize = `${size.toFixed(1)}px`;
      w.el.style.fontWeight = fw;
      w.el.style.left = `${spot.x.toFixed(1)}px`;
      w.el.style.top = `${spot.y.toFixed(1)}px`;
      w.el.style.opacity = (0.55 + 0.45 * weight).toFixed(2);
      if (w.el.classList.contains('entering')) {
        // Låt webbläsaren rita startläget innan vi tonar in.
        requestAnimationFrame(() => requestAnimationFrame(() => w.el.classList.remove('entering')));
      }
    }

    // Ord som inte längre är med tonas ut och tas bort.
    for (const [text, w] of this.words) {
      if (seen.has(text)) continue;
      this.words.delete(text);
      w.el.classList.add('leaving');
      setTimeout(() => w.el.remove(), 900);
    }
  }

  findSpot(box, hint, placed, W, H) {
    const fits = (cx, cy) => {
      const x = cx - box.w / 2;
      const y = cy - box.h / 2;
      if (x < 0 || y < 0 || x + box.w > W || y + box.h > H) return false;
      for (const p of placed) {
        if (x < p.x + p.w && x + box.w > p.x && y < p.y + p.h && y + box.h > p.y) return false;
      }
      return true;
    };

    const cx0 = hint ? hint.x : W / 2;
    const cy0 = hint ? hint.y : H / 2;
    if (fits(cx0, cy0)) return { x: cx0, y: cy0 };

    // Arkimedisk spiral, utsträckt efter ytans proportioner.
    const aspect = W / H;
    const maxR = Math.hypot(W, H);
    const step = 0.35;
    for (let t = step; ; t += step) {
      const r = 3 * t;
      if (r > maxR) break;
      const cx = cx0 + r * Math.cos(t) * Math.sqrt(aspect);
      const cy = cy0 + r * Math.sin(t) / Math.sqrt(aspect);
      if (fits(cx, cy)) return { x: cx, y: cy };
    }
    return null;
  }
}
