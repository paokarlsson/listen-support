"""Slår ihop ämnen (Claude) och nyckelord (snabba lagret) till en vikttabell.

- Ämnen blir de stora orden: de räknas i full skala (`topic_boost`), nyckelord
  skalas ned med `keyword_scale`.
- Nyckelord som redan ingår i ett ämne (samma stam som ett av ämnets ord eller
  dess namn) tonas ned med `covered_keyword_factor`, så att samma sak inte syns dubbelt.
- Allt normaliseras till 0–1 och kapas till topp-N.

Utan ämnen returneras nyckelorden oförändrade (snabba lagret ensamt).
"""
from __future__ import annotations

from typing import Callable, Iterable

from .config import TopicConfig
from .keywords import tokenize
from .topics import Topic


def _stems(text: str, stem: Callable[[str], str]) -> set[str]:
    return {stem(tok) for tok in tokenize(text)}


def merge(
    keywords: list[dict],
    topics: Iterable[Topic],
    cfg: TopicConfig,
    top_n: int,
    stem: Callable[[str], str],
) -> list[dict]:
    topics = [t for t in topics if t.score > 0]
    if not topics:
        return [{"text": k["text"], "weight": k["weight"], "kind": "keyword"} for k in keywords[:top_n]]

    covered: set[str] = set()
    for t in topics:
        covered |= _stems(t.label, stem)
        for kw in t.keywords:
            covered |= _stems(kw, stem)

    rows: list[dict] = []
    topic_names = set()
    for t in topics:
        topic_names.add(t.label.lower())
        rows.append({"text": t.label, "weight": min(1.0, t.score) * cfg.topic_boost, "kind": "topic"})

    for k in keywords:
        if k["text"].lower() in topic_names:
            continue
        w = k["weight"] * cfg.keyword_scale
        stems = _stems(k["text"], stem)
        if stems and stems <= covered:
            w *= cfg.covered_keyword_factor
        rows.append({"text": k["text"], "weight": w, "kind": "keyword"})

    rows.sort(key=lambda r: (-r["weight"], r["kind"] != "topic", r["text"]))
    rows = rows[:top_n]
    top = rows[0]["weight"] if rows and rows[0]["weight"] > 0 else 1.0
    for r in rows:
        r["weight"] = round(r["weight"] / top, 4)
    return rows
