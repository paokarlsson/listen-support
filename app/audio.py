"""PCM-buffert, chunkning och enkel energibaserad VAD.

Klienten skickar rå int16 LE, 16 kHz mono. Vi samlar ljudet och klipper ut bitar
om ungefär `chunk_seconds`. För att inte klippa mitt i ord väntar vi efter
målängden på en tyst ram (under VAD-tröskeln) och klipper där. Om ingen paus kommer
innan `max_chunk_seconds` klipper vi i den tystaste ramen inom sökfönstret.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import AudioConfig

FRAME_MS = 20
MIN_VOICED_MS = 300


@dataclass
class Chunk:
    samples: np.ndarray  # int16
    start_s: float       # position i strömmen (sekunder sedan start/reset)
    voiced: bool
    rms: float

    @property
    def duration_s(self) -> float:
        return len(self.samples) / 16000

    def as_float32(self) -> np.ndarray:
        return self.samples.astype(np.float32) / 32768.0


def frame_rms(samples: np.ndarray, frame_len: int) -> np.ndarray:
    """RMS per hel ram (int16-skala)."""
    n = len(samples) // frame_len
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    frames = samples[: n * frame_len].astype(np.float32).reshape(n, frame_len)
    return np.sqrt(np.mean(frames * frames, axis=1))


class AudioChunker:
    def __init__(self, cfg: AudioConfig):
        self.cfg = cfg
        self.sr = cfg.sample_rate
        self.frame_len = self.sr * FRAME_MS // 1000
        self.chunk_len = int(cfg.chunk_seconds * self.sr)
        self.max_len = max(int(cfg.max_chunk_seconds * self.sr), self.chunk_len)
        self.search_len = int(cfg.cut_search_seconds * self.sr)
        self.reset()

    def reset(self) -> None:
        self._buf = np.zeros(0, dtype=np.int16)
        self._odd = b""
        self._consumed = 0  # samples som redan lämnats ut
        self.total_bytes = 0

    @property
    def buffered_seconds(self) -> float:
        return len(self._buf) / self.sr

    def feed(self, data: bytes) -> list[Chunk]:
        self.total_bytes += len(data)
        data = self._odd + data
        if len(data) % 2:
            self._odd, data = data[-1:], data[:-1]
        else:
            self._odd = b""
        if data:
            self._buf = np.concatenate([self._buf, np.frombuffer(data, dtype="<i2")])

        out: list[Chunk] = []
        while True:
            cut = self._find_cut()
            if cut is None:
                break
            out.append(self._emit(cut))
        return out

    def flush(self) -> Chunk | None:
        """Lämna ut det som finns kvar (t.ex. när mikrofonen stängs)."""
        if len(self._buf) < self.frame_len * 5:
            self._buf = np.zeros(0, dtype=np.int16)
            return None
        return self._emit(len(self._buf))

    # -- internt -----------------------------------------------------------

    def _find_cut(self) -> int | None:
        n = len(self._buf)
        if n < self.chunk_len:
            return None
        fl = self.frame_len
        # 1) Efter målängden: klipp i första tysta ram.
        start = self.chunk_len // fl * fl
        end = min(n, self.max_len)
        rms = frame_rms(self._buf[start:end], fl)
        quiet = np.nonzero(rms < self.cfg.vad_rms_threshold)[0]
        if len(quiet):
            return start + int(quiet[0]) * fl + fl // 2
        # 2) Ingen paus före maxlängden: klipp i tystaste ram i sökfönstret.
        if n >= self.max_len:
            # Sökfönstret slutar vid maxlängden men börjar aldrig före halva målängden.
            s = max(self.chunk_len // 2, self.max_len - self.search_len) // fl * fl
            rms = frame_rms(self._buf[s : self.max_len], fl)
            if len(rms) == 0:
                return self.max_len
            return s + int(np.argmin(rms)) * fl + fl // 2
        return None

    def _emit(self, cut: int) -> Chunk:
        samples, self._buf = self._buf[:cut].copy(), self._buf[cut:]
        start_s = self._consumed / self.sr
        self._consumed += len(samples)
        rms_frames = frame_rms(samples, self.frame_len)
        voiced_frames = int(np.sum(rms_frames >= self.cfg.vad_rms_threshold))
        voiced = voiced_frames * FRAME_MS >= MIN_VOICED_MS
        rms = float(np.sqrt(np.mean(samples.astype(np.float32) ** 2))) if len(samples) else 0.0
        return Chunk(samples=samples, start_s=start_s, voiced=voiced, rms=rms)
