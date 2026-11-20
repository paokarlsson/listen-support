import math

import pytest

from app.config import KeywordConfig
from app.keywords import KeywordEngine, load_stopwords, tokenize


def engine(**kw):
    clock = {"t": 0.0}
    eng = KeywordEngine(KeywordConfig(**kw), clock=lambda: clock["t"])
    return eng, clock


def texts(terms):
    return [t["text"] for t in terms]


def test_tokenize_strips_punctuation_and_digits():
    assert tokenize("Budgeten, 2024: 15 % högre!? Nya-kontoret.") == [
        "budgeten", "högre", "nya-kontoret"
    ]


def test_stopwords_include_fillers():
    sw = load_stopwords()
    for w in ["och", "att", "det", "som", "liksom", "typ", "alltså", "eh"]:
        assert w in sw


def test_stopwords_and_short_words_are_filtered():
    eng, _ = engine()
    found = eng.add_text("Eh, alltså typ, det är ju så att vi ok")
    assert found == []
    assert eng.top() == []


def test_inflections_merge_and_most_common_surface_is_shown():
    eng, _ = engine()
    eng.add_text("budgeten budgeten budgetar budget")
    top = eng.top()
    assert len(top) == 1
    assert top[0]["text"] == "budgeten"
    assert top[0]["weight"] == 1.0


def test_bigram_needs_min_count():
    eng, _ = engine(bigram_min_count=2)
    eng.add_text("nya kontoret")
    assert "nya kontoret" not in texts(eng.top())
    eng.add_text("nya kontoret")
    assert "nya kontoret" in texts(eng.top())


def test_bigram_hides_words_only_seen_inside_it():
    eng, _ = engine()
    eng.add_text("nya kontoret. nya kontoret.")
    assert texts(eng.top()) == ["nya kontoret"]
    # "kontoret" nämns mycket på egen hand → visas också
    eng.add_text("kontoret kontoret kontoret kontoret")
    assert "kontoret" in texts(eng.top())


def test_weak_words_only_appear_in_bigrams():
    eng, _ = engine()
    eng.add_text("nya kontoret. nya möbler. nya datorer. nya kontoret.")
    shown = texts(eng.top())
    assert "nya" not in shown
    assert "nya kontoret" in shown


def test_bigram_does_not_span_stopwords():
    eng, _ = engine()
    eng.add_text("budget och flytten. budget och flytten, budget och flytten")
    assert all(t["kind"] == "word" for t in eng.top())


def test_bigram_does_not_span_sentences():
    eng, _ = engine()
    eng.add_text("Vi pratade om flytten. Budgeten är klar. Flytten! Budgeten.")
    assert all(t["kind"] == "word" for t in eng.top())


def test_decay_halves_after_half_life():
    eng, clock = engine(half_life_seconds=120)
    eng.add_text("budgeten")
    term = next(iter(eng.terms.values()))
    clock["t"] = 120
    assert term.score_at(clock["t"], eng.half_life) == pytest.approx(0.5)


def test_score_matches_sum_formula():
    eng, _ = engine(half_life_seconds=60)
    times = [0, 10, 45, 100]
    for t in times:
        eng.add_text("flytten", now=t)
    now = 130
    expected = sum(math.exp(-math.log(2) * (now - t) / 60) for t in times)
    term = next(iter(eng.terms.values()))
    assert term.score_at(now, eng.half_life) == pytest.approx(expected)


def test_recent_topic_overtakes_old_one():
    eng, clock = engine(half_life_seconds=60)
    eng.add_text("budgeten budgeten budgeten budgeten", now=0)
    eng.add_text("semestern semestern", now=180)
    clock["t"] = 180
    top = eng.top()
    assert top[0]["text"] == "semestern"
    assert top[1]["weight"] < 0.5


def test_old_terms_are_forgotten():
    eng, _ = engine(half_life_seconds=10, forget_below=0.01)
    eng.add_text("budgeten", now=0)
    eng.add_text("semestern", now=200)
    assert texts(eng.top(now=200)) == ["semestern"]
    assert len(eng.terms) == 1


def test_top_n_limits_and_weights_are_normalised():
    eng, _ = engine(top_n=3)
    eng.add_text("äpple äpple äpple äpple banan banan citron dadel fikon")
    top = eng.top()
    assert len(top) == 3
    assert top[0] == {"text": "äpple", "weight": 1.0, "kind": "word"}
    assert top[1]["weight"] == pytest.approx(0.5)
    assert all(0 <= t["weight"] <= 1 for t in top)


def test_set_half_life_keeps_current_scores():
    eng, clock = engine(half_life_seconds=100)
    eng.add_text("budgeten", now=0)
    clock["t"] = 100
    eng.set_half_life(10)
    term = next(iter(eng.terms.values()))
    assert term.score_at(100, eng.half_life) == pytest.approx(0.5)
    assert term.score_at(110, eng.half_life) == pytest.approx(0.25)


def test_reset_and_snapshot():
    eng, _ = engine()
    eng.add_text("budgeten budgetar")
    snap = eng.snapshot()
    assert snap[0]["count"] == 2
    assert snap[0]["forms"] == {"budgeten": 1, "budgetar": 1}
    eng.reset()
    assert eng.top() == [] and eng.snapshot() == []
