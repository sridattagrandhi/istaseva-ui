"""
NSFW / explicit-content detectors.

Heavy imports (nudenet / transformers) are done lazily inside the classes so the
pure logic + tests import without any model weights present. Weights download on
first use on a machine with internet access.

Backends:
  * "nudenet"   — NudeNet v3 ONNX detector. Local, torch-free. Default.
  * "falconsai" — Falconsai/nsfw_image_detection ViT via transformers (optional,
    needs `transformers` + `torch`). Stronger whole-image NSFW classifier.
"""

from __future__ import annotations

import io
from functools import lru_cache

from PIL import Image

from .config import settings


# NudeNet exposed-body-part classes we treat as explicit.
NUDENET_EXPLICIT_CLASSES = {
    "BUTTOCKS_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "ANUS_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
}

# Covered-but-intimate classes: lingerie/swimwear-style imagery. Not explicit
# nudity, but not listing-photo material either — these map to the "review"
# verdict (which the upload gate rejects). Deliberately excludes broad classes
# like BELLY_EXPOSED / ARMPITS_* that are normal in everyday Indian dress.
NUDENET_SUGGESTIVE_CLASSES = {
    "FEMALE_GENITALIA_COVERED",
    "FEMALE_BREAST_COVERED",
    "BUTTOCKS_COVERED",
    "ANUS_COVERED",
}


class NudeNetNsfw:
    name = "NudeNet 3.x ONNX"

    def __init__(self) -> None:
        self._detector = None
        self.last_detections: list[dict] = []
        self.last_suggestive_score: float = 0.0

    def _ensure(self):
        if self._detector is None:
            from nudenet import NudeDetector  # type: ignore

            self._detector = NudeDetector()
        return self._detector

    def nsfw_score(self, image: Image.Image) -> float:
        detector = self._ensure()
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        detections = detector.detect(buf.getvalue())
        flagged = [
            {"class": row.get("class"), "score": float(row.get("score", 0.0)), "box": row.get("box")}
            for row in detections
            if row.get("class") in NUDENET_EXPLICIT_CLASSES
            or row.get("class") in NUDENET_SUGGESTIVE_CLASSES
        ]
        self.last_detections = sorted(flagged, key=lambda r: r["score"], reverse=True)
        explicit = [r for r in self.last_detections if r["class"] in NUDENET_EXPLICIT_CLASSES]
        suggestive = [r for r in self.last_detections if r["class"] in NUDENET_SUGGESTIVE_CLASSES]
        self.last_suggestive_score = suggestive[0]["score"] if suggestive else 0.0
        top_score = explicit[0]["score"] if explicit else 0.0
        # Hard-block once NudeNet crosses its object-confidence threshold.
        return 1.0 if top_score >= settings.nudenet_explicit_min_score else top_score


class FalconsaiNsfw:
    name = "Falconsai/nsfw_image_detection"

    def __init__(self) -> None:
        self._pipe = None
        self.last_detections = None
        self.last_suggestive_score: float = 0.0

    def _ensure(self):
        if self._pipe is None:
            from transformers import pipeline  # type: ignore

            self._pipe = pipeline("image-classification", model="Falconsai/nsfw_image_detection")
        return self._pipe

    def nsfw_score(self, image: Image.Image) -> float:
        pipe = self._ensure()
        out = pipe(image)  # [{'label': 'nsfw'|'normal', 'score': ...}, ...]
        for row in out:
            if str(row["label"]).lower() == "nsfw":
                return float(row["score"])
        for row in out:
            if str(row["label"]).lower() == "normal":
                return float(1.0 - row["score"])
        return 0.0


def _nudenet_available() -> bool:
    try:
        import nudenet  # noqa: F401
        return True
    except Exception:
        return False


def _falconsai_available() -> bool:
    try:
        import transformers  # noqa: F401
        return True
    except Exception:
        return False


@lru_cache(maxsize=1)
def get_nsfw():
    """Return a detector exposing ``nsfw_score(image) -> float`` plus a ``name``."""
    backend = settings.nsfw_backend
    if backend == "auto":
        backend = "nudenet" if _nudenet_available() else "falconsai"

    if backend == "falconsai":
        return FalconsaiNsfw()
    return NudeNetNsfw()
