# Look Up fingerprint workers (ingest and recognize) for Render: build from services/fingerprinter.
#   docker build -f worker.Dockerfile .
# PyAV's wheels bundle ffmpeg, so no system packages are needed. The worker holds no storage credentials: it
# downloads each recording through the short-lived address in its job.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY pyproject.toml ./
COPY lookup_fingerprint ./lookup_fingerprint
COPY workers ./workers
RUN pip install ".[worker]"
COPY start-workers.sh ./

# This image decodes untrusted audio: never run it as root.
RUN useradd --create-home --uid 10001 fingerprinter
USER fingerprinter

CMD ["sh", "/app/start-workers.sh"]
