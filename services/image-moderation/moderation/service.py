"""
Orchestration: image bytes -> explicit-content verdict.

Single entry point used by the FastAPI app and the CLI sample runner.
"""

from __future__ import annotations

import io
import time

from PIL import Image

from .config import settings
from .core import decide
from .models import get_nsfw


class Moderator:
    def __init__(self) -> None:
        self._nsfw = None

    def _load(self):
        if self._nsfw is None:
            self._nsfw = get_nsfw()

    def moderate(self, image_bytes: bytes) -> dict:
        self._load()
        t0 = time.time()

        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        nsfw_score = self._nsfw.nsfw_score(image)
        suggestive_score = getattr(self._nsfw, "last_suggestive_score", 0.0)

        result = decide(
            nsfw_score=nsfw_score,
            suggestive_score=suggestive_score,
            thresholds=settings.thresholds,
        )

        payload = result.to_dict()
        detections = getattr(self._nsfw, "last_detections", None)
        if detections is not None:
            payload["scores"]["nsfw_detections"] = detections[:5]
        payload["models"] = {"nsfw": getattr(self._nsfw, "name", type(self._nsfw).__name__)}
        payload["elapsed_ms"] = round((time.time() - t0) * 1000, 1)
        return payload


_moderator: Moderator | None = None


def get_moderator() -> Moderator:
    global _moderator
    if _moderator is None:
        _moderator = Moderator()
    return _moderator
