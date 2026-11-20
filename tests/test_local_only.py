"""Allt körs lokalt – det enda som får gå över nätet är anropen till Anthropic."""
import re
from pathlib import Path

import pytest

from app.config import ROOT, TopicConfig, TranscriberConfig
from app.topics import TopicLayer
from app.transcriber import WhisperCppTranscriber

URL_RE = re.compile(r"""(?:src|href)\s*=\s*["'](?!/|#|data:)|url\(\s*["']?https?:|@import|https?://(?!localhost)""")


@pytest.mark.parametrize("path", sorted((ROOT / "static").glob("*")), ids=lambda p: p.name)
def test_static_files_load_nothing_from_the_internet(path: Path):
    text = path.read_text(encoding="utf-8")
    assert not URL_RE.findall(text), f"{path.name} refererar till något utanför servern"


@pytest.mark.parametrize("url", [
    "https://example.com/v1/messages",
    "http://api.anthropic.com/v1/messages",
    "https://api.anthropic.com.evil.test/v1/messages",
])
def test_topic_layer_only_talks_to_anthropic(url):
    with pytest.raises(ValueError):
        TopicLayer(TopicConfig(api_url=url), api_key="x")
    TopicLayer(TopicConfig(), api_key="x")  # standardadressen är tillåten


def test_whisper_never_downloads_a_model_by_name():
    # "base" vore ett giltigt modellnamn för pywhispercpp, som då skulle ladda ner den.
    with pytest.raises(FileNotFoundError):
        WhisperCppTranscriber(TranscriberConfig(model_path="base"))


def test_server_binds_to_localhost_by_default():
    from app.config import load_config
    assert load_config().server.host == "127.0.0.1"
