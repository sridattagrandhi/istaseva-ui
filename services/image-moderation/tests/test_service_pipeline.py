"""
End-to-end pipeline test with a FAKE detector (no weights downloaded).

Validates the bytes -> PIL -> nsfw -> decide -> JSON glue. Runs anywhere.

Run:  python -m pytest tests/test_service_pipeline.py -q
"""

import io

from PIL import Image

from moderation.service import Moderator


def _png_bytes(color=(200, 200, 200)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), color).save(buf, format="PNG")
    return buf.getvalue()


class _FakeNsfw:
    name = "fake-nsfw"

    def __init__(self, score, detections=None):
        self._score = score
        self.last_detections = detections or []

    def nsfw_score(self, image):
        return self._score


def _run(nsfw, detections=None):
    m = Moderator()
    m._nsfw = _FakeNsfw(nsfw, detections)
    return m.moderate(_png_bytes())


def test_pipeline_allows_clean():
    r = _run(0.02)
    assert r["verdict"] == "allow"
    assert r["scores"]["nsfw"] == 0.02
    assert r["models"]["nsfw"] == "fake-nsfw"
    assert "elapsed_ms" in r


def test_pipeline_blocks_explicit():
    r = _run(0.96, detections=[{"class": "MALE_GENITALIA_EXPOSED", "score": 0.9}])
    assert r["verdict"] == "block"
    assert "explicit_content" in r["reasons"]
    assert r["scores"]["nsfw_detections"][0]["class"] == "MALE_GENITALIA_EXPOSED"


def test_pipeline_reviews_borderline():
    r = _run(0.55)
    assert r["verdict"] == "review"
