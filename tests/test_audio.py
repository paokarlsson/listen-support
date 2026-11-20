import numpy as np

from app.audio import AudioChunker
from app.config import AudioConfig

SR = 16000


def tone(seconds, amp=8000, freq=220):
    t = np.arange(int(seconds * SR)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype("<i2")


def silence(seconds):
    return np.zeros(int(seconds * SR), dtype="<i2")


def feed_all(chunker, samples, block=1600):
    out = []
    raw = samples.tobytes()
    for i in range(0, len(raw), block * 2):
        out += chunker.feed(raw[i : i + block * 2])
    return out


def test_cuts_at_first_pause_after_target_length():
    ch = AudioChunker(AudioConfig(chunk_seconds=6, max_chunk_seconds=9))
    audio = np.concatenate([tone(7), silence(0.5), tone(3)])
    chunks = feed_all(ch, audio)
    assert len(chunks) == 1
    assert 7.0 <= chunks[0].duration_s <= 7.1
    assert chunks[0].voiced


def test_cuts_at_max_length_without_pause():
    ch = AudioChunker(AudioConfig(chunk_seconds=6, max_chunk_seconds=9))
    chunks = feed_all(ch, tone(20))
    assert len(chunks) == 2
    for c in chunks:
        assert 6.9 <= c.duration_s <= 9.0


def test_silence_is_not_voiced():
    ch = AudioChunker(AudioConfig(chunk_seconds=6))
    chunks = feed_all(ch, silence(7))
    assert len(chunks) == 1
    assert not chunks[0].voiced


def test_odd_byte_boundaries_are_handled():
    ch = AudioChunker(AudioConfig(chunk_seconds=1, max_chunk_seconds=1.5))
    raw = np.concatenate([tone(1.2), silence(0.3)]).tobytes()
    out = []
    for i in range(0, len(raw), 333):  # udda blockstorlek
        out += ch.feed(raw[i : i + 333])
    total = sum(len(c.samples) for c in out) + len(ch._buf)
    assert total == len(raw) // 2
    assert out[0].samples[:100].tolist() == np.frombuffer(raw[:200], "<i2").tolist()


def test_flush_returns_rest():
    ch = AudioChunker(AudioConfig(chunk_seconds=6))
    assert feed_all(ch, tone(2)) == []
    rest = ch.flush()
    assert rest is not None and rest.voiced
    assert abs(rest.duration_s - 2) < 0.01
    assert ch.flush() is None
