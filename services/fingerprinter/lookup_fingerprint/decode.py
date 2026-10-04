"""Decode untrusted audio to mono float32 at the canonical sample rate.

Uploads are untrusted input to ffmpeg, so decoding is fenced in: container whitelist,
byte cap, duration cap, optional wall-clock deadline, first audio stream only. PyAV
bundles its own ffmpeg libraries, so no system ffmpeg is required.

Errors carry a stable `code`. Callers relay the code (mapped to a public message by the
API's error catalogue) and log `detail` privately — never the exception text itself.
"""

from __future__ import annotations

import io
import time
from pathlib import Path

import av
import numpy as np

# PyAV/ffmpeg demuxer names we accept (MP4/M4A/3GP from phones, Ogg/WebM Opus, WAV, MP3, ADTS AAC, FLAC).
ALLOWED_FORMATS = frozenset({
    "mov,mp4,m4a,3gp,3g2,mj2",
    "ogg",
    "matroska,webm",
    "wav",
    "mp3",
    "aac",
    "flac",
})


class DecodeError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


def decode_audio(
    source: str | Path | bytes,
    sample_rate: int,
    *,
    maximum_seconds: float = 150.0,
    maximum_bytes: int = 25 * 1024 * 1024,
    deadline_seconds: float | None = None,
) -> np.ndarray:
    started_at = time.monotonic()
    if isinstance(source, (bytes, bytearray)):
        if len(source) > maximum_bytes:
            raise DecodeError("AUDIO_TOO_LARGE", f"{len(source)} bytes")
        handle: object = io.BytesIO(source)
    else:
        path = Path(source)
        size_bytes = path.stat().st_size
        if size_bytes > maximum_bytes:
            raise DecodeError("AUDIO_TOO_LARGE", f"{size_bytes} bytes")
        handle = str(path)

    try:
        container = av.open(handle, mode="r")
    except av.error.FFmpegError as error:
        raise DecodeError("DECODE_FAILED", type(error).__name__) from error

    chunks: list[np.ndarray] = []
    total_samples = 0
    maximum_samples = int(maximum_seconds * sample_rate)
    with container:
        if container.format.name not in ALLOWED_FORMATS:
            raise DecodeError("UNSUPPORTED_FORMAT", container.format.name)
        if not container.streams.audio:
            raise DecodeError("NO_AUDIO_STREAM")
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="flt", layout="mono", rate=sample_rate)
        try:
            for frame in container.decode(stream):
                for resampled_frame in resampler.resample(frame):
                    chunk = resampled_frame.to_ndarray().reshape(-1)
                    chunks.append(chunk)
                    total_samples += chunk.size
                if total_samples > maximum_samples:
                    raise DecodeError("AUDIO_TOO_LONG", f"> {maximum_seconds}s")
                if deadline_seconds is not None and time.monotonic() - started_at > deadline_seconds:
                    raise DecodeError("DECODE_TIMEOUT", f"> {deadline_seconds}s")
            for resampled_frame in resampler.resample(None):   # flush the resampler's tail
                chunk = resampled_frame.to_ndarray().reshape(-1)
                chunks.append(chunk)
                total_samples += chunk.size
        except av.error.FFmpegError as error:
            raise DecodeError("DECODE_FAILED", type(error).__name__) from error

    if total_samples == 0:
        raise DecodeError("EMPTY_AUDIO")
    return np.concatenate(chunks).astype(np.float32, copy=False)
