FROM python:3.11-slim

WORKDIR /app

# System deps for pillow / onnxruntime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-nsfw.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# Uncomment to bake in the stronger NSFW model (larger image):
# RUN pip install --no-cache-dir -r requirements-nsfw.txt

# Warm the NudeNet ONNX weights into the image at build time. Without this the
# model downloads on the first /moderate call, which (a) fails in a runtime
# with no outbound internet and (b) adds cold-start latency to the first
# upload. Baking it means the container is self-contained and ready on boot.
RUN python -c "from nudenet import NudeDetector; NudeDetector()"

COPY moderation ./moderation
COPY app.py webui.py run_samples.py ./

EXPOSE 8501
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8501"]
