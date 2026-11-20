"""Nyckelordsmotor: stoppord + svensk Snowball-stamning + viktad frekvens med
tidsavklingning.

    score(term) = Σ exp(-ln2 · (nu - t_i) / halveringstid)   för varje förekomst i

Summan hålls inkrementellt: vid varje uppdatering skrivs den gamla poängen ner
med avklingningen sedan förra uppdateringen och den nya förekomsten läggs till.
Det ger exakt samma resultat som summan ovan så länge halveringstiden är konstant.
"""
from __future__ import annotations

import math
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import snowballstemmer

from .config import KeywordConfig

_WORD_RE = re.compile(r"[^\W\d_]+(?:-[^\W\d_]+)*")
_CLAUSE_RE = re.compile(r"[.,!?;:…–—()\[\]\"]+")
_STOPWORDS_FILE = Path(__file__).with_name("stopwords_sv.txt")
_WEAKWORDS_FILE = Path(__file__).with_name("weakwords_sv.txt")


def load_wordlist(path: Path) -> set[str]:
    words: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0]
        words.update(w.strip().lower() for w in line.split() if w.strip())
    return words


def load_stopwords(path: Path = _STOPWORDS_FILE) -> set[str]:
    return load_wordlist(path)


def load_weakwords(path: Path = _WEAKWORDS_FILE) -> set[str]:
    return load_wordlist(path)


def tokenize(text: str) -> list[str]:
    """Gemener, inga skiljetecken eller siffror."""
    return _WORD_RE.findall(text.lower())


def clauses(text: str) -> list[list[str]]:
    """Dela upp i satsdelar vid skiljetecken. Bigram bildas bara inom en satsdel."""
    return [toks for part in _CLAUSE_RE.split(text) if (toks := tokenize(part))]


@dataclass
class Term:
    key: str
    kind: str  # "word" | "bigram"
    score: float = 0.0
    updated: float = 0.0
    count: int = 0
    surfaces: Counter = field(default_factory=Counter)
    parts: tuple[str, ...] = ()  # stammar för bigram

    def score_at(self, now: float, half_life: float) -> float:
        dt = max(0.0, now - self.updated)
        return self.score * math.exp(-math.log(2) * dt / half_life)

    def add(self, now: float, half_life: float, surface: str) -> None:
        self.score = self.score_at(now, half_life) + 1.0
        self.updated = now
        self.count += 1
        self.surfaces[surface] += 1

    @property
    def text(self) -> str:
        # Vanligaste ytformen; vid lika vinner den som sågs först.
        return self.surfaces.most_common(1)[0][0]


class KeywordEngine:
    def __init__(
        self,
        cfg: KeywordConfig,
        stopwords: set[str] | None = None,
        weakwords: set[str] | None = None,
        clock=time.time,
    ):
        self.half_life = cfg.half_life_seconds
        self.top_n = cfg.top_n
        self.min_len = cfg.min_word_length
        self.bigram_min_count = cfg.bigram_min_count
        self.forget_below = cfg.forget_below
        self.stopwords = stopwords if stopwords is not None else load_stopwords()
        # Svaga ord bildar bigram men räknas inte som egna begrepp.
        self.weakwords = weakwords if weakwords is not None else load_weakwords()
        self.clock = clock
        self._stemmer = snowballstemmer.stemmer("swedish")
        self._stem_cache: dict[str, str] = {}
        self.terms: dict[str, Term] = {}

    # -- inställningar -----------------------------------------------------

    def set_half_life(self, seconds: float, now: float | None = None) -> None:
        """Byt halveringstid. Nuvarande poäng behålls och avklingar sedan i ny takt."""
        now = self.clock() if now is None else now
        for t in self.terms.values():
            t.score = t.score_at(now, self.half_life)
            t.updated = now
        self.half_life = max(1.0, float(seconds))

    def reset(self) -> None:
        self.terms.clear()

    # -- inmatning ---------------------------------------------------------

    def stem(self, word: str) -> str:
        s = self._stem_cache.get(word)
        if s is None:
            s = self._stemmer.stemWord(word)
            self._stem_cache[word] = s
        return s

    def is_content(self, word: str) -> bool:
        return len(word) >= self.min_len and word not in self.stopwords

    def add_text(self, text: str, now: float | None = None) -> list[str]:
        """Lägg till en transkriberad bit. Returnerar de nyckelord som hittades."""
        now = self.clock() if now is None else now
        found: list[str] = []
        for tokens in clauses(text):
            self._add_clause(tokens, now, found)
        self._forget(now)
        return found

    def _add_clause(self, tokens: list[str], now: float, found: list[str]) -> None:
        prev: str | None = None  # föregående innehållsord (bryts av stoppord)
        for tok in tokens:
            if not self.is_content(tok):
                prev = None
                continue
            stem = self.stem(tok)
            if tok not in self.weakwords:
                self._bump(stem, "word", tok, now)
                found.append(tok)
            if prev is not None:
                pstem = self.stem(prev)
                if pstem != stem and not (prev in self.weakwords and tok in self.weakwords):
                    self._bump(f"{pstem} {stem}", "bigram", f"{prev} {tok}", now, (pstem, stem))
            prev = tok

    def _bump(self, key: str, kind: str, surface: str, now: float, parts: tuple[str, ...] = ()) -> None:
        term = self.terms.get(key)
        if term is None:
            term = self.terms[key] = Term(key=key, kind=kind, parts=parts or (key,))
        term.add(now, self.half_life, surface)

    def _forget(self, now: float) -> None:
        dead = [k for k, t in self.terms.items() if t.score_at(now, self.half_life) < self.forget_below]
        for k in dead:
            del self.terms[k]

    # -- utdata ------------------------------------------------------------

    def top(self, n: int | None = None, now: float | None = None) -> list[dict]:
        """Topp-N begrepp med vikter normaliserade till 0–1."""
        now = self.clock() if now is None else now
        n = self.top_n if n is None else n
        scored: list[tuple[float, Term]] = []
        bigram_scores: dict[str, float] = {}

        for t in self.terms.values():
            s = t.score_at(now, self.half_life)
            if s < self.forget_below:
                continue
            if t.kind == "bigram":
                if t.count < self.bigram_min_count:
                    continue
                for p in t.parts:
                    bigram_scores[p] = max(bigram_scores.get(p, 0.0), s)
            scored.append((s, t))

        # Ett enskilt ord som nästan bara förekommer inuti ett visat bigram
        # ("kontoret" i "nya kontoret") döljs, så att begreppet inte visas två gånger.
        result = [
            (s, t) for s, t in scored
            if not (t.kind == "word" and s <= bigram_scores.get(t.key, 0.0) * 1.1)
        ]
        result.sort(key=lambda st: (-st[0], st[1].text))
        result = result[:n]
        if not result:
            return []
        top_score = result[0][0]
        return [
            {"text": t.text, "weight": round(s / top_score, 4), "kind": t.kind}
            for s, t in result
        ]

    def snapshot(self, now: float | None = None) -> list[dict]:
        """Alla kända begrepp med rå poäng, för export."""
        now = self.clock() if now is None else now
        rows = [
            {
                "text": t.text,
                "stem": t.key,
                "kind": t.kind,
                "count": t.count,
                "score": round(t.score_at(now, self.half_life), 4),
                "forms": dict(t.surfaces.most_common()),
            }
            for t in self.terms.values()
        ]
        rows.sort(key=lambda r: -r["score"])
        return rows
