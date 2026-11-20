"""Wrapper runt whisper.cpp.

Tre backends:
- WhisperCppTranscriber: pywhispercpp (rekommenderat).
- CliTranscriber: reservplan som anropar en manuellt byggd `whisper-cli`.
- StubTranscriber: ingen transkribering, för fas 1 och felsökning.
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
import tempfile
import threading
import wave
from pathlib import Path

import numpy as np

from .config import ROOT, TranscriberConfig

log = logging.getLogger("talmoln.transcriber")

# Fraser som Whisper ofta "hallucinerar" ur tystnad eller brus (inlärda från
# undertexter). De tas bort ur resultatet.
_HALLUCINATIONS = [
    r"textning\.nu",
    r"svensktextning\.nu",
    r"undertext(?:er|ning)? (?:från|av) [\w\.\- ]+",
    r"amara\.org[\w\- ]*",
    r"tack för att (?:ni|du) (?:har )?(?:tittat|tittade|lyssnat|lyssnade)",
    r"glöm inte att prenumerera[\w ,!]*",
    r"prenumerera på kanalen[\w ,!]*",
]
_HALLU_RE = re.compile("|".join(_HALLUCINATIONS), re.IGNORECASE)
_BRACKETS_RE = re.compile(r"\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+")


def clean_text(text: str) -> str:
    text = _BRACKETS_RE.sub(" ", text)
    text = _HALLU_RE.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()
    # Bara skiljetecken kvar? Då är det tomt.
    if not re.search(r"\w", text):
        return ""
    return text


class Transcriber:
    name = "base"

    def transcribe(self, audio: np.ndarray, prompt: str = "") -> str:  # float32, 16 kHz
        raise NotImplementedError


class StubTranscriber(Transcriber):
    name = "stub"

    def transcribe(self, audio: np.ndarray, prompt: str = "") -> str:
        return ""


class WhisperCppTranscriber(Transcriber):
    name = "whispercpp"

    def __init__(self, cfg: TranscriberConfig):
        from pywhispercpp.model import Model  # importeras sent: tung och valfri

        model_path = _resolve_model(cfg.model_path)
        self.cfg = cfg
        self._lock = threading.Lock()
        self._model = Model(
            str(model_path),
            redirect_whispercpp_logs_to=None,
            n_threads=cfg.threads,
            language=cfg.language,
            translate=False,
            print_progress=False,
            print_realtime=False,
            print_timestamps=False,
            no_context=True,
            single_segment=False,
            suppress_blank=True,
        )

    def transcribe(self, audio: np.ndarray, prompt: str = "") -> str:
        params = {}
        if prompt and self.cfg.use_prompt:
            params["initial_prompt"] = prompt
        with self._lock:
            segments = self._model.transcribe(audio, **params)
        return clean_text(" ".join(s.text for s in segments))


class CliTranscriber(Transcriber):
    """Anropar `whisper-cli` (byggt med cmake) via subprocess."""

    name = "cli"

    def __init__(self, cfg: TranscriberConfig):
        self.cfg = cfg
        self.model_path = _resolve_model(cfg.model_path)

    def transcribe(self, audio: np.ndarray, prompt: str = "") -> str:
        pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
        fd, wav_path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            with wave.open(wav_path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(16000)
                w.writeframes(pcm.tobytes())
            cmd = [
                self.cfg.cli_binary,
                "-m", str(self.model_path),
                "-f", wav_path,
                "-l", self.cfg.language,
                "-t", str(self.cfg.threads),
                "-nt",   # inga tidsstämplar
                "-np",   # inga extra utskrifter
            ]
            if prompt and self.cfg.use_prompt:
                cmd += ["--prompt", prompt]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if res.returncode != 0:
                log.error("whisper-cli misslyckades: %s", res.stderr.strip()[-500:])
                return ""
            return clean_text(res.stdout)
        finally:
            os.unlink(wav_path)


def _resolve_model(path: str) -> Path:
    p = Path(path)
    if not p.is_absolute():
        p = ROOT / p
    if not p.exists():
        raise FileNotFoundError(
            f"Hittar ingen modell på {p}. Ladda ner en med scripts/download_model.sh "
            f"eller ändra transcriber.model_path i config.toml."
        )
    return p


def create_transcriber(cfg: TranscriberConfig) -> Transcriber:
    if cfg.backend == "stub":
        return StubTranscriber()
    if cfg.backend == "cli":
        return CliTranscriber(cfg)
    if cfg.backend == "whispercpp":
        return WhisperCppTranscriber(cfg)
    raise ValueError(f"Okänd transcriber.backend: {cfg.backend!r}")
