"""Starlette-app: statiska filer, WebSocket för ljud och REST för reset/export."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from starlette.applications import Starlette
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from .audio import AudioChunker, Chunk
from .config import ROOT, Config, load_config
from .keywords import KeywordEngine
from .transcriber import StubTranscriber, Transcriber, create_transcriber

log = logging.getLogger("talmoln")
STATIC = ROOT / "static"
PROMPT_CHARS = 200
MAX_BACKLOG = 3  # fler väntande bitar än så = vi ligger efter, släng de äldsta


@dataclass
class Segment:
    text: str
    received_at: float  # unix-tid när biten var färdiginspelad
    duration_s: float
    latency_ms: int


class Session:
    """Delat tillstånd: transkript, nyckelord och anslutna klienter."""

    def __init__(self, cfg: Config, transcriber: Transcriber | None = None):
        self.cfg = cfg
        self.engine = KeywordEngine(cfg.keywords)
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
            "half_life": self.engine.half_life,
            "top_n": self.engine.top_n,
            "chunk_seconds": self.cfg.audio.chunk_seconds,
            "transcriber": self.transcriber.name,
            "transcriber_error": self.transcriber_error,
        }

    def apply_settings(self, data: dict) -> None:
        if "half_life" in data:
            self.engine.set_half_life(min(3600.0, max(5.0, float(data["half_life"]))))
        if "top_n" in data:
            self.engine.top_n = int(min(150, max(5, int(data["top_n"]))))

    def reset(self) -> None:
        self.engine.reset()
        self.segments.clear()
        while not self.queue.empty():
            self.queue.get_nowait()
        self.started_at = time.time()

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
            # Ordet räknas från när det sades, inte när transkriberingen blev klar.
            self.engine.add_text(text, now=received_at)
            await self.broadcast({
                "type": "update",
                "segment": text,
                "terms": self.engine.top(),
                "latency_ms": latency_ms,
                "backlog": self.queue.qsize(),
            })

    async def ticker(self) -> None:
        """Skicka vikter regelbundet så att molnet avklingar även i tystnad."""
        while True:
            await asyncio.sleep(self.cfg.keywords.tick_seconds)
            if self.clients and self.engine.terms:
                await self.broadcast({"type": "terms", "terms": self.engine.top()})


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
        "top": session.engine.top(now=now),
        "terms": session.engine.snapshot(now=now),
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
        "terms": session.engine.top(),
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
                                 "terms": session.engine.top()})
    elif kind == "stop":
        chunk = chunker.flush()
        if chunk is not None:
            await _handle_chunk(session, ws, chunk, chunker)
    elif kind == "ping":
        await ws.send_json({"type": "pong"})


# -- app -------------------------------------------------------------------

def create_app(cfg: Config | None = None, transcriber: Transcriber | None = None) -> Starlette:
    cfg = cfg or load_config()

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette):
        session = Session(cfg, transcriber)
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
                 asyncio.create_task(session.ticker())]
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
app = create_app()
