"""Ämneslagret: skickar senaste minuternas transkript till Claude och får tillbaka
ämnen med vikter.

Anropet görs direkt mot Messages API med httpx. Vi använder inte anthropic-SDK:n
eftersom den drar in pydantic-core (Rust), som är jobbigt att bygga i Termux.

Svaret kommer som strukturerad JSON via ett verktyg (`report_topics`) med
`strict: true`, så att det alltid går att tolka. Allt fel fångas här: appen ska
aldrig krascha på grund av API:t. Vid fel behålls senaste ämnen och de avklingar.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import time
from dataclasses import dataclass, field

import httpx

from .config import TopicConfig

log = logging.getLogger("talmoln.topics")

ANTHROPIC_VERSION = "2026-10-21"
TOOL_NAME = "report_topics"

SYSTEM_PROMPT = """\
Du får ett löpande transkript av ett samtal på svenska, transkriberat automatiskt \
och därför med fel. Identifiera de 3–{max_topics} ämnen som samtalet handlar om just nu. \
Ge varje ämne ett kort namn (1–3 ord, svenska), en vikt 0–1 efter hur mycket det \
pratas om det i det senaste avsnittet, och de ord ur transkriptet som hör till ämnet. \
Återanvänd namn från föregående ämneslista när ämnet är detsamma. \
Hitta inte på ämnen som inte nämns. Om transkriptet är för kort eller osammanhängande \
för att säga något om, returnera färre ämnen eller en tom lista.

Svara genom att anropa verktyget report_topics."""

TOOL = {
    "name": TOOL_NAME,
    "description": "Rapportera vilka ämnen samtalet handlar om just nu.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["topics"],
        "properties": {
            "topics": {
                "type": "array",
                "description": "Ämnen, viktigast först.",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["label", "weight", "keywords"],
                    "properties": {
                        "label": {"type": "string", "description": "Kort ämnesnamn, 1–3 ord, svenska."},
                        "weight": {"type": "number", "description": "0–1: hur mycket det pratas om ämnet just nu."},
                        "keywords": {
                            "type": "array",
                            "description": "Ord ur transkriptet som hör till ämnet.",
                            "items": {"type": "string"},
                        },
                    },
                },
            }
        },
    },
}


class TopicError(Exception):
    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status  # "offline" | "error"


@dataclass
class Topic:
    label: str
    score: float
    updated: float
    keywords: list[str] = field(default_factory=list)

    def score_at(self, now: float, half_life: float) -> float:
        dt = max(0.0, now - self.updated)
        return self.score * math.exp(-math.log(2) * dt / half_life)


def _norm(label: str) -> str:
    return re.sub(r"\s+", " ", label.strip().lower())


class TopicLayer:
    def __init__(
        self,
        cfg: TopicConfig,
        api_key: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        clock=time.time,
    ):
        self.cfg = cfg
        self.api_key = api_key if api_key is not None else os.environ.get("ANTHROPIC_API_KEY", "").strip()
        self.enabled = cfg.enabled
        self.interval = cfg.interval_seconds
        self.clock = clock
        self._transport = transport
        self.topics: dict[str, Topic] = {}
        self.reset_usage()
        self.status = "pending"
        self.last_error: str | None = None
        self.last_success: float | None = None
        self.last_attempt: float = 0.0
        self.in_flight = False

    # -- tillstånd ---------------------------------------------------------

    @property
    def has_key(self) -> bool:
        return bool(self.api_key)

    @property
    def active(self) -> bool:
        return self.enabled and self.has_key

    def reset_usage(self) -> None:
        self.usage = {"calls": 0, "failed": 0, "input_tokens": 0, "output_tokens": 0}

    def reset(self) -> None:
        self.topics.clear()
        self.last_success = None
        self.last_attempt = 0.0
        self.reset_usage()
        if self.status == "ok":
            self.status = "pending"

    def set_enabled(self, on: bool) -> None:
        self.enabled = bool(on)
        if not self.enabled:
            # Integritet: när lagret slås av försvinner även Claudes ämnen.
            self.topics.clear()

    def info(self, now: float | None = None) -> dict:
        now = self.clock() if now is None else now
        if not self.has_key:
            status, reason = "off", "no_key"
        elif not self.enabled:
            status, reason = "off", "disabled"
        else:
            status, reason = self.status, self.last_error
        return {
            "status": status,
            "reason": reason,
            "enabled": self.enabled,
            "has_key": self.has_key,
            "model": self.cfg.model,
            "interval": self.interval,
            "last_update_s": None if self.last_success is None else round(now - self.last_success),
            "busy": self.in_flight,
            "usage": dict(self.usage),
        }

    def should_call(self, new_words: int, now: float | None = None) -> bool:
        now = self.clock() if now is None else now
        return (
            self.active
            and not self.in_flight
            and new_words >= self.cfg.min_new_words
            and now - self.last_attempt >= self.interval
        )

    def set_half_life(self, seconds: float, now: float | None = None) -> None:
        """Byt halveringstid. Nuvarande vikter behålls och avklingar sedan i ny takt."""
        now = self.clock() if now is None else now
        for t in self.topics.values():
            t.score = t.score_at(now, self.cfg.half_life_seconds)
            t.updated = now
        self.cfg.half_life_seconds = max(5.0, float(seconds))

    def cloud_terms(self, now: float | None = None, max_words: int | None = None) -> list[dict]:
        """Det som visas i molnet: ämnesnamn som stora ord och ämnenas ord runt
        omkring. Vikter normaliseras till 0–1. `topic` anger vilket ämne ett ord
        hör till, så att klienten kan färga dem lika."""
        now = self.clock() if now is None else now
        max_words = max_words or self.cfg.max_words
        topics = self.current(now) if self.enabled else []
        if not topics:
            return []
        rows: dict[str, dict] = {}
        for t in topics:
            rows[_norm(t.label)] = {"text": t.label, "weight": t.score, "kind": "topic", "topic": t.label}
        if self.cfg.show_keywords:
            for t in topics:
                for kw in t.keywords:
                    key = _norm(kw)
                    w = t.score * self.cfg.keyword_factor
                    if key in rows and rows[key]["weight"] >= w:
                        continue
                    rows[key] = {"text": kw, "weight": w, "kind": "keyword", "topic": t.label}
        out = sorted(rows.values(), key=lambda r: (-r["weight"], r["kind"] != "topic", r["text"]))[:max_words]
        top = out[0]["weight"] or 1.0
        for r in out:
            r["weight"] = round(r["weight"] / top, 4)
        return out

    def current(self, now: float | None = None) -> list[Topic]:
        """Ämnen med avklingad poäng, starkast först. Döda ämnen rensas bort."""
        now = self.clock() if now is None else now
        hl = self.cfg.half_life_seconds
        out = []
        for key, t in list(self.topics.items()):
            s = t.score_at(now, hl)
            if s < self.cfg.forget_below:
                del self.topics[key]
                continue
            out.append(Topic(label=t.label, score=s, updated=now, keywords=t.keywords))
        out.sort(key=lambda t: -t.score)
        return out

    # -- anrop -------------------------------------------------------------

    async def refresh(self, transcript: str, now: float | None = None) -> bool:
        """Fråga Claude om ämnen. Returnerar True om ämnena uppdaterades."""
        now = self.clock() if now is None else now
        if not self.active or self.in_flight:
            return False
        self.in_flight = True
        self.last_attempt = now
        try:
            result = await self._call(transcript, now)
        except TopicError as exc:
            self.usage["failed"] += 1
            self.status = exc.status
            self.last_error = str(exc)
            log.warning("Ämneslagret: %s (%s)", exc.status, exc)
            return False
        finally:
            self.in_flight = False
        # Om lagret slogs av medan anropet pågick slänger vi svaret.
        if not self.enabled:
            return False
        self.apply(result, self.clock())
        self.status = "ok"
        self.last_error = None
        self.last_success = self.clock()
        return True

    def build_request(self, transcript: str, now: float) -> dict:
        previous = [
            {"label": t.label, "weight": round(t.score, 2), "keywords": t.keywords[:8]}
            for t in self.current(now)
        ]
        user = (
            "Föregående ämneslista (återanvänd namnen när ämnet är detsamma):\n"
            f"{json.dumps(previous, ensure_ascii=False) if previous else '(inga ännu)'}\n\n"
            "Transkript, äldst först (de sista raderna är det senaste avsnittet):\n"
            f"<transkript>\n{transcript}\n</transkript>"
        )
        return {
            "model": self.cfg.model,
            "max_tokens": self.cfg.max_tokens,
            "system": SYSTEM_PROMPT.format(max_topics=self.cfg.max_topics),
            "tools": [TOOL],
            # Haiku 5.5 tillåter ett tvingat verktygsanrop; svaret blir då alltid ett report_topics-anrop.
            "tool_choice": {"type": "tool", "name": TOOL_NAME},
            "output_config": {"effort": "low"},
            "messages": [{"role": "user", "content": user}],
        }

    async def _call(self, transcript: str, now: float) -> list[dict]:
        body = self.build_request(transcript, now)
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        }
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=self.cfg.timeout_seconds, transport=self._transport) as client:
                resp = await client.post(self.cfg.api_url, json=body, headers=headers)
        except (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError) as exc:
            raise TopicError("offline", f"{type(exc).__name__}: {exc}") from exc
        except httpx.HTTPError as exc:
            raise TopicError("error", f"{type(exc).__name__}: {exc}") from exc

        if resp.status_code != 200:
            raise TopicError("error", f"HTTP {resp.status_code}: {_error_message(resp)}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise TopicError("error", "Ogiltig JSON i svaret") from exc

        usage = data.get("usage") or {}
        self.usage["calls"] += 1
        self.usage["input_tokens"] += int(usage.get("input_tokens") or 0)
        self.usage["output_tokens"] += int(usage.get("output_tokens") or 0)
        log.info(
            "Ämneslagret: %d tokens in, %d ut, %.1f s (sessionen totalt: %d in, %d ut, %d anrop)",
            usage.get("input_tokens", 0), usage.get("output_tokens", 0), time.monotonic() - started,
            self.usage["input_tokens"], self.usage["output_tokens"], self.usage["calls"],
        )

        if data.get("stop_reason") == "refusal":
            raise TopicError("error", "Claude avböjde förfrågan")
        for block in data.get("content") or []:
            if block.get("type") == "tool_use" and block.get("name") == TOOL_NAME:
                topics = (block.get("input") or {}).get("topics")
                if isinstance(topics, list):
                    return topics
        raise TopicError("error", f"Inget {TOOL_NAME}-anrop i svaret (stop_reason={data.get('stop_reason')})")

    # -- sammanvägning över tid -----------------------------------------------

    def apply(self, raw_topics: list[dict], now: float) -> None:
        """Väv in ett nytt svar. Vikterna blandas med de avklingade gamla så att
        molnet ändras mjukt, och namnbyten för samma ämne fångas upp."""
        hl = self.cfg.half_life_seconds
        cleaned = []
        for item in raw_topics[: self.cfg.max_topics]:
            if not isinstance(item, dict):
                continue
            label = str(item.get("label") or "").strip()
            if not label:
                continue
            try:
                weight = float(item.get("weight", 0))
            except (TypeError, ValueError):
                weight = 0.0
            weight = min(1.0, max(0.0, weight))
            kws = [str(k).strip() for k in item.get("keywords") or [] if str(k).strip()]
            cleaned.append((label, weight, kws))

        used: set[str] = set()
        for label, weight, kws in cleaned:
            key = _norm(label)
            existing = self.topics.get(key)
            if existing is None:
                existing = self._match_by_keywords(kws, exclude=used)
                if existing is not None:
                    log.info("Ämneslagret: '%s' tolkas som befintliga '%s'", label, existing.label)
                    key = _norm(existing.label)
            used.add(key)
            if existing is None:
                self.topics[key] = Topic(label=label, score=weight, updated=now, keywords=kws)
            else:
                old = existing.score_at(now, hl)
                existing.score = 0.5 * old + 0.5 * weight
                existing.updated = now
                existing.keywords = kws or existing.keywords

    def _match_by_keywords(self, kws: list[str], exclude: set[str]) -> Topic | None:
        """Hitta ett befintligt ämne med i stort sett samma nyckelord (Claude har bytt namn)."""
        new = {k.lower() for k in kws}
        if not new:
            return None
        best, best_score = None, 0.0
        for key, t in self.topics.items():
            if key in exclude:
                continue
            old = {k.lower() for k in t.keywords}
            if not old:
                continue
            jaccard = len(new & old) / len(new | old)
            if jaccard > best_score:
                best, best_score = t, jaccard
        return best if best_score >= 0.5 else None


def _error_message(resp: httpx.Response) -> str:
    try:
        err = resp.json().get("error") or {}
        return f"{err.get('type', '')}: {err.get('message', '')}".strip(": ")
    except ValueError:
        return resp.text[:200]
