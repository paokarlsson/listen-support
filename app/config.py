"""Läser config.toml och fyller i standardvärden."""
from __future__ import annotations

import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8000


@dataclass
class TranscriberConfig:
    backend: str = "whispercpp"  # whispercpp | cli | stub
    model_path: str = "models/ggml-base.bin"
    language: str = "sv"
    threads: int = 4
    cli_binary: str = "whisper-cli"
    use_prompt: bool = True


@dataclass
class AudioConfig:
    sample_rate: int = 16000
    chunk_seconds: float = 6.0
    max_chunk_seconds: float = 9.0
    cut_search_seconds: float = 2.0
    vad_rms_threshold: float = 250.0


@dataclass
class KeywordConfig:
    half_life_seconds: float = 120.0
    top_n: int = 40
    min_word_length: int = 3
    bigram_min_count: int = 2
    forget_below: float = 0.01
    tick_seconds: float = 2.0


@dataclass
class TopicConfig:
    # Ämneslagret (Claude). Kräver ANTHROPIC_API_KEY i miljön eller i .env.
    enabled: bool = True              # startläge; kan slås av/på i gränssnittet
    model: str = "claude-haiku-5-5"
    interval_seconds: float = 45.0
    min_new_words: int = 40
    window_seconds: float = 180.0
    max_window_chars: int = 8000
    max_topics: int = 8
    timeout_seconds: float = 15.0
    max_tokens: int = 1024
    # Hur ämnens vikt avklingar mellan anropen.
    half_life_seconds: float = 120.0
    forget_below: float = 0.05
    # Sammanslagning med nyckelorden (merge.py)
    topic_boost: float = 1.0          # ämnen räknas i full skala ...
    keyword_scale: float = 0.6        # ... nyckelord skalas ned så att ämnena blir störst
    covered_keyword_factor: float = 0.35  # nyckelord som ingår i ett ämne tonas ned
    api_url: str = "https://api.anthropic.com/v1/messages"


@dataclass
class Config:
    server: ServerConfig = field(default_factory=ServerConfig)
    transcriber: TranscriberConfig = field(default_factory=TranscriberConfig)
    audio: AudioConfig = field(default_factory=AudioConfig)
    keywords: KeywordConfig = field(default_factory=KeywordConfig)
    topics: TopicConfig = field(default_factory=TopicConfig)


def load_env(path: Path | None = None) -> None:
    """Läs .env i projektroten (påverkar inte variabler som redan är satta)."""
    path = path or ROOT / ".env"
    if not path.exists():
        return
    try:
        from dotenv import load_dotenv
    except ImportError:  # python-dotenv saknas: enkel egen tolkning
        import os

        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip().removeprefix("export ").strip()
            os.environ.setdefault(key, value.strip().strip("'\""))
        return
    load_dotenv(path, override=False)


def _fill(cls, data: dict):
    known = {f.name for f in fields(cls)}
    unknown = set(data) - known
    if unknown:
        raise ValueError(f"Okända nycklar i [{cls.__name__}]: {sorted(unknown)}")
    return cls(**data)


def load_config(path: str | Path | None = None) -> Config:
    path = Path(path) if path else ROOT / "config.toml"
    if not path.exists():
        return Config()
    with open(path, "rb") as fh:
        raw = tomllib.load(fh)
    return Config(
        server=_fill(ServerConfig, raw.get("server", {})),
        transcriber=_fill(TranscriberConfig, raw.get("transcriber", {})),
        audio=_fill(AudioConfig, raw.get("audio", {})),
        keywords=_fill(KeywordConfig, raw.get("keywords", {})),
        topics=_fill(TopicConfig, raw.get("topics", {})),
    )
