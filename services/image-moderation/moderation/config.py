"""
Runtime configuration for the image-moderation service (NudeNet explicit check).
"""

from __future__ import annotations

import os

from .core import Thresholds


class Settings:
    def __init__(self) -> None:
        # "auto" -> NudeNet if importable, else Falconsai (transformers) if present.
        self.nsfw_backend = os.getenv("NSFW_BACKEND", "auto").lower()
        # NudeNet object-confidence at/above which an explicit detection is a hard block.
        self.nudenet_explicit_min_score = float(os.getenv("NUDENET_EXPLICIT_MIN_SCORE", "0.35"))
        self.thresholds = Thresholds(
            nsfw_block=float(os.getenv("NSFW_BLOCK", Thresholds.nsfw_block)),
            nsfw_review=float(os.getenv("NSFW_REVIEW", Thresholds.nsfw_review)),
            suggestive_review=float(os.getenv("NSFW_SUGGESTIVE_REVIEW", Thresholds.suggestive_review)),
        )


settings = Settings()
