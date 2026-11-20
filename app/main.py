"""Starlette-app: statiska filer, WebSocket för ljud och REST för reset/export."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from starlette.applications import Starlette
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from .audio import AudioChunker, Chunk
from .config import ROOT, Config, load_config, load_env
from .topics import TopicLayer
from .transcriber import StubTranscriber, Transcriber, create_transcriber

log = logging.getLogger("talmoln")
STATIC = ROOT / "static"
PROMPT_CHARS = 200
MAX_BACKLOG = 3  # fler väntande bitar än så = vi ligger efter, släng de äldsta
TOPIC_CHECK_SECONDS = 1.0
_WORD_RE = re.compile(r"[^\W\d_]+")


@dataclass
class Segment:
    text: str
    received_at: float  # unix-tid när biten var färdiginspelad
    duration_s: float
    latency_ms: int


class Session:
    """Delat tillstånd: transkript, nyckelord och anslutna klienter."""

    def __init__(self, cfg: Config, transcriber: Transcriber | None = None, topics: TopicLayer | None = None):
        self.cfg = cfg
        self.topics = topics or TopicLayer(cfg.topics)
        self.words_since_topics = 0
        self.transcriber: Transcriber = transcriber or StubTranscriber()
        self.transcriber_error: str | None = None
        self.segments: list[Segment] = []
        self.clients: set[WebSocket] = set()
        self.queue: asyncio.Queue[tuple[Chunk, float]] = asyncio.Queue()
        self.started_at = time.time()
        self.busy = False

    # -- inställningar -----------------------------------------------------

    def settings(self) -> dict:
        return {
            "half_life": self.topics.cfg.half_life_seconds,
            "top_n": self.topics.cfg.max_words,
            "chunk_seconds": self.cfg.audio.chunk_seconds,
            "transcriber": self.transcriber.name,
            "transcriber_error": self.transcriber_error,
            "llm_enabled": self.topics.enabled,
            "llm_interval": self.topics.interval,
            "llm_available": self.topics.has_key,
        }

    def apply_settings(self, data: dict) -> None:
        if "half_life" in data:
            self.topics.set_half_life(min(3600.0, max(5.0, float(data["half_life"]))))
        if "top_n" in data:
            self.topics.cfg.max_words = int(min(150, max(3, int(data["top_n"]))))
        if "llm_enabled" in data:
            self.topics.set_enabled(bool(data["llm_enabled"]))
            log.info("Ämneslagret %s", "på" if self.topics.enabled else "av")
        if "llm_interval" in data:
            self.topics.interval = min(600.0, max(10.0, float(data["llm_interval"])))

    def reset(self) -> None:
        self.segments.clear()
        self.topics.reset()
        self.words_since_topics = 0
        while not self.queue.empty():
            self.queue.get_nowait()
        self.started_at = time.time()

    # -- vikter -------------------------------------------------------------

    def cloud_terms(self, now: float | None = None) -> list[dict]:
        """Det som visas i molnet – allt kommer från ämneslagret."""
        return self.topics.cloud_terms(now)

    def transcript_window(self, now: float | None = None) -> str:
        now = time.time() if now is None else now
        lines = [s.text for s in self.segments if s.received_at >= now - self.cfg.topics.window_seconds]
        text = "\n".join(lines)
        limit = self.cfg.topics.max_window_chars
        return text[-limit:] if len(text) > limit else text

    # -- kommunikation -----------------------------------------------------

    async def broadcast(self, msg: dict) -> None:
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def enqueue(self, chunk: Chunk) -> None:
        while self.queue.qsize() >= MAX_BACKLOG:
            self.queue.get_nowait()
            log.warning("Transkriberingen ligger efter – hoppar över en bit")
        self.queue.put_nowait((chunk, time.time()))

    # -- bakgrundsjobb -----------------------------------------------------

    async def transcribe_worker(self) -> None:
        while True:
            chunk, received_at = await self.queue.get()
            prompt = self.segments[-1].text[-PROMPT_CHARS:] if self.segments else ""
            self.busy = True
            try:
                text = await asyncio.to_thread(self.transcriber.transcribe, chunk.as_float32(), prompt)
            except Exception:
                log.exception("Transkribering misslyckades")
                text = ""
            finally:
                self.busy = False
            latency_ms = int((time.time() - received_at) * 1000)
            if not text:
                await self.broadcast({"type": "status", "event": "empty", "latency_ms": latency_ms,
                                      "backlog": self.queue.qsize()})
                continue
            seg = Segment(text=text, received_at=received_at, duration_s=chunk.duration_s, latency_ms=latency_ms)
            self.segments.append(seg)
            self.words_since_topics += len(_WORD_RE.findall(text))
            await self.broadcast({
                "type": "update",
                "segment": text,
                "terms": self.cloud_terms(),
                "llm": self.topics.info(),
                "latency_ms": latency_ms,
                "backlog": self.queue.qsize(),
            })

    async def ticker(self) -> None:
        """Skicka vikter regelbundet så att molnet avklingar även i tystnad."""
        while True:
            await asyncio.sleep(self.cfg.topics.tick_seconds)
            if self.clients and self.topics.topics:
                await self.broadcast({"type": "terms", "terms": self.cloud_terms(), "llm": self.topics.info()})

    async def topic_loop(self) -> None:
        """Fråga Claude om ämnen när intervallet gått och tillräckligt mycket nytt sagts."""
        while True:
            await asyncio.sleep(TOPIC_CHECK_SECONDS)
            if not self.topics.should_call(self.words_since_topics):
                continue
            transcript = self.transcript_window()
            if not transcript:
                continue
            self.words_since_topics = 0
            task = asyncio.create_task(self.topics.refresh(transcript))
            await self.broadcast({"type": "llm", "llm": self.topics.info()})
            try:
                await task
            except Exception:  # ska aldrig hända, men appen får inte dö av ämneslagret
                log.exception("Oväntat fel i ämneslagret")
            await self.broadcast({"type": "terms", "terms": self.cloud_terms(), "llm": self.topics.info()})


# -- routes ----------------------------------------------------------------

async def index(request):
    return FileResponse(STATIC / "index.html")


async def reset(request):
    session: Session = request.app.state.session
    session.reset()
    await session.broadcast({"type": "reset"})
    return JSONResponse({"ok": True})


async def export(request):
    session: Session = request.app.state.session
    now = time.time()
    body = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "settings": session.settings(),
        "segments": [
            {
                "t": round(s.received_at - session.started_at, 2),
                "at": datetime.fromtimestamp(s.received_at, timezone.utc).isoformat(),
                "text": s.text,
                "duration_s": round(s.duration_s, 2),
                "latency_ms": s.latency_ms,
            }
            for s in session.segments
        ],
        "transcript": " ".join(s.text for s in session.segments),
        "top": session.cloud_terms(now=now),
        "topics": [
            {"label": t.label, "score": round(t.score, 4), "keywords": t.keywords}
            for t in session.topics.current(now)
        ],
        "llm": session.topics.info(now),
    }
    headers = {}
    if request.query_params.get("download"):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        headers["Content-Disposition"] = f'attachment; filename="talmoln-{stamp}.json"'
    return JSONResponse(body, headers=headers)


async def ws_endpoint(ws: WebSocket):
    session: Session = ws.app.state.session
    await ws.accept()
    session.clients.add(ws)
    chunker = AudioChunker(session.cfg.audio)
    await ws.send_json({
        "type": "hello",
        "settings": session.settings(),
        "segments": [s.text for s in session.segments[-50:]],
        "terms": session.cloud_terms(),
        "llm": session.topics.info(),
    })
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                for chunk in chunker.feed(msg["bytes"]):
                    await _handle_chunk(session, ws, chunk, chunker)
            elif msg.get("text") is not None:
                await _handle_text(session, ws, chunker, msg["text"])
    except WebSocketDisconnect:
        pass
    finally:
        session.clients.discard(ws)


async def _handle_chunk(session: Session, ws: WebSocket, chunk: Chunk, chunker: AudioChunker) -> None:
    if chunk.voiced:
        session.enqueue(chunk)
    await ws.send_json({
        "type": "chunk",
        "duration_s": round(chunk.duration_s, 2),
        "voiced": chunk.voiced,
        "rms": round(chunk.rms, 1),
        "bytes_total": chunker.total_bytes,
        "backlog": session.queue.qsize() + (1 if session.busy else 0),
    })


async def _handle_text(session: Session, ws: WebSocket, chunker: AudioChunker, text: str) -> None:
    try:
        data = json.loads(text)
    except ValueError:
        return
    kind = data.get("type")
    if kind == "settings":
        session.apply_settings(data)
        await session.broadcast({"type": "settings", "settings": session.settings(),
                                 "terms": session.cloud_terms(), "llm": session.topics.info()})
    elif kind == "stop":
        chunk = chunker.flush()
        if chunk is not None:
            await _handle_chunk(session, ws, chunk, chunker)
    elif kind == "ping":
        await ws.send_json({"type": "pong"})


# -- app -------------------------------------------------------------------

def create_app(
    cfg: Config | None = None,
    transcriber: Transcriber | None = None,
    topics: TopicLayer | None = None,
) -> Starlette:
    if cfg is None:
        load_env()
        cfg = load_config()

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette):
        session = Session(cfg, transcriber, topics)
        if session.topics.has_key:
            log.info("Ämneslagret: %s, %s (modell %s)", "på" if session.topics.enabled else "av",
                     f"var {session.topics.interval:.0f}:e s", cfg.topics.model)
        else:
            log.info("Ämneslagret: av (ingen ANTHROPIC_API_KEY)")
        if transcriber is None:
            try:
                log.info("Laddar transkriberare (%s, %s)…", cfg.transcriber.backend, cfg.transcriber.model_path)
                session.transcriber = await asyncio.to_thread(create_transcriber, cfg.transcriber)
                log.info("Transkriberare redo: %s", session.transcriber.name)
            except Exception as exc:  # t.ex. modell saknas eller pywhispercpp ej installerat
                log.error("Kunde inte starta transkriberaren: %s", exc)
                session.transcriber = StubTranscriber()
                session.transcriber_error = str(exc)
        app.state.session = session
        tasks = [asyncio.create_task(session.transcribe_worker()),
                 asyncio.create_task(session.ticker()),
                 asyncio.create_task(session.topic_loop())]
        try:
            yield
        finally:
            for t in tasks:
                t.cancel()

    return Starlette(
        routes=[
            Route("/", index),
            Route("/reset", reset, methods=["POST"]),
            Route("/export", export, methods=["GET"]),
            WebSocketRoute("/ws", ws_endpoint),
            Mount("/static", StaticFiles(directory=STATIC), name="static"),
        ],
        lifespan=lifespan,
    )


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)  # loggar annars varje anrop
app = create_app()
