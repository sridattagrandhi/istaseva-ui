# IstaSeva Image Moderation

Local FastAPI service for screening listing photos before the API persists them.

## What It Checks

- Explicit / NSFW image content with NudeNet (local ONNX). This is the whole
  scope for now — it catches the "explicit photo instead of a listing photo" case.

Category relevance ("does this photo actually look like a cab?") is planned for a
later iteration and is intentionally not included here.

The Express API calls this service only when `IMAGE_MODERATION_URL` is set. If it
is blank, uploads behave as they do today.

## Run Locally

```bash
cd services/image-moderation
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app:app --host 127.0.0.1 --port 8501
```

On macOS/Linux, use `.venv/bin/python` instead of `.venv/Scripts/python`.

Then set the API environment:

```bash
IMAGE_MODERATION_URL=http://127.0.0.1:8501
IMAGE_MODERATION_FAIL_CLOSED=true
```

## Rollout Notes

- `IMAGE_MODERATION_FAIL_CLOSED=false` lets uploads through if the service is
  unavailable.
- `IMAGE_MODERATION_FAIL_CLOSED=true` rejects listing images when the service is
  unavailable.
- `NSFW_BACKEND=auto` prefers NudeNet, then Falconsai if installed.
- `NUDENET_EXPLICIT_MIN_SCORE=0.35` controls NudeNet's explicit detection cutoff.
