# Look Up fingerprint engine — Phase 0 benchmark image.
# Python 3.12 is the version the Render worker will run. PyAV wheels bundle ffmpeg, so no apt packages.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY pyproject.toml ./
COPY lookup_fingerprint ./lookup_fingerprint
COPY bench ./bench
COPY tests ./tests
RUN pip install ".[postgres,dev]"

# This image decodes untrusted audio: never run it as root.
RUN useradd --create-home --uid 10001 fingerprinter
USER fingerprinter

ENTRYPOINT ["python", "-m"]
CMD ["bench.run", "--help"]
