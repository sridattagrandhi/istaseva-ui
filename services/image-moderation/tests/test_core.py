"""
Unit tests for the pure decision logic. These run WITHOUT any model weights.

Run:  python -m pytest tests/test_core.py -q
"""

from moderation.core import Thresholds, decide

TH = Thresholds()


def test_explicit_image_is_blocked():
    r = decide(nsfw_score=0.97, thresholds=TH)
    assert r.verdict == "block"
    assert "explicit_content" in r.reasons


def test_clean_image_is_allowed():
    r = decide(nsfw_score=0.01, thresholds=TH)
    assert r.verdict == "allow"
    assert r.reasons == ["ok"]


def test_borderline_nsfw_goes_to_review():
    r = decide(nsfw_score=0.62, thresholds=TH)
    assert r.verdict == "review"
    assert "possible_explicit_content" in r.reasons


def test_boundaries():
    assert decide(0.85, thresholds=TH).verdict == "block"     # exactly at block threshold
    assert decide(0.50, thresholds=TH).verdict == "review"    # exactly at review threshold
    assert decide(0.4999, thresholds=TH).verdict == "allow"


def test_scores_reported():
    r = decide(0.33, thresholds=TH)
    assert r.scores["nsfw"] == 0.33


def test_suggestive_image_goes_to_review():
    # Covered/intimate imagery (e.g. lingerie): no explicit score, but the
    # suggestive detector fires — must not be allowed as a listing photo.
    r = decide(nsfw_score=0.0, suggestive_score=0.70, thresholds=TH)
    assert r.verdict == "review"
    assert "suggestive_content" in r.reasons
    assert r.scores["suggestive"] == 0.70


def test_suggestive_below_threshold_is_allowed():
    r = decide(nsfw_score=0.0, suggestive_score=0.38, thresholds=TH)
    assert r.verdict == "allow"


def test_explicit_outranks_suggestive():
    r = decide(nsfw_score=0.9, suggestive_score=0.9, thresholds=TH)
    assert r.verdict == "block"
    assert "explicit_content" in r.reasons
