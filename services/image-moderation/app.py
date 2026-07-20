"""
FastAPI wrapper around the moderation pipeline.

Run:
    uvicorn app:app --host 127.0.0.1 --port 8501

Endpoints:
    GET  /                            -> simple drag-and-drop upload UI
    GET  /health                      -> liveness + configured backend
    POST /moderate         (multipart, field: file)          -> moderate one image
    POST /moderate-batch   (multipart, field: files)         -> moderate several

The Express backend calls /moderate with the uploaded bytes; see
`server/src/modules/infrastructure/services/image-moderation.service.ts`.
"""

from __future__ import annotations

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse, HTMLResponse

from moderation.config import settings
from moderation.service import get_moderator
from webui import INDEX_HTML

app = FastAPI(title="IstaSeva Image Moderation", version="0.1.0")


@app.get("/", response_class=HTMLResponse)
def index():
    """Simple drag-and-drop upload UI for manual testing."""
    return INDEX_HTML


@app.get("/health")
def health():
    return {
        "status": "ok",
        "nsfw_backend": settings.nsfw_backend,
        "thresholds": {
            "nsfw_block": settings.thresholds.nsfw_block,
            "nsfw_review": settings.thresholds.nsfw_review,
            "nudenet_explicit_min_score": settings.nudenet_explicit_min_score,
        },
    }


@app.post("/moderate")
async def moderate(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        return JSONResponse(status_code=400, content={"error": "empty file"})
    try:
        return get_moderator().moderate(data)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=500, content={"error": str(exc)})


@app.post("/moderate-batch")
async def moderate_batch(files: list[UploadFile] = File(...)):
    mod = get_moderator()
    out = []
    for f in files:
        data = await f.read()
        try:
            r = mod.moderate(data)
            r["filename"] = f.filename
            out.append(r)
        except Exception as exc:  # noqa: BLE001
            out.append({"filename": f.filename, "error": str(exc)})
    return {"results": out}
