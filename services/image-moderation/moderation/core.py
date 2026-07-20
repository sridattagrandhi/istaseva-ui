"""
Pure decision logic for image moderation (no ML dependencies).

Turns an explicit-content (NSFW) score into a final verdict. Kept dependency-free
so the policy is unit-testable without any model weights.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Thresholds:
    """Tunable decision thresholds for the explicit-content score in [0, 1]."""

    nsfw_block: float = 0.85       # >= this -> hard block
    nsfw_review: float = 0.50      # >= this -> send to human review
    suggestive_review: float = 0.60  # covered/intimate detection >= this -> review


@dataclass
class ModerationResult:
    verdict: str                       # "allow" | "review" | "block"
    reasons: list[str] = field(default_factory=list)
    scores: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"verdict": self.verdict, "reasons": self.reasons, "scores": self.scores}


def decide(
    nsfw_score: float,
    suggestive_score: float = 0.0,
    thresholds: Thresholds = Thresholds(),
) -> ModerationResult:
    """Map explicit/suggestive content scores to a verdict.

    Policy:
      * nsfw >= nsfw_block               -> block  (explicit_content)
      * nsfw >= nsfw_review              -> review (possible_explicit_content)
      * suggestive >= suggestive_review  -> review (suggestive_content)
      * otherwise                        -> allow  (ok)
    """
    scores = {
        "nsfw": round(float(nsfw_score), 4),
        "suggestive": round(float(suggestive_score), 4),
    }

    if nsfw_score >= thresholds.nsfw_block:
        return ModerationResult("block", ["explicit_content"], scores)
    if nsfw_score >= thresholds.nsfw_review:
        return ModerationResult("review", ["possible_explicit_content"], scores)
    if suggestive_score >= thresholds.suggestive_review:
        return ModerationResult("review", ["suggestive_content"], scores)
    return ModerationResult("allow", ["ok"], scores)
