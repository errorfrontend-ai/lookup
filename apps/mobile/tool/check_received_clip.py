"""Checks the clip file the real recorder sent from the emulator to the fake API (design §4.7 step 4):
AAC in an MP4/M4A container, 16,000 Hz, one channel, 7.5 to 8.5 seconds, and a file of no more than
32,768 bytes. On a real phone the length must be 7.5 to 8.5 seconds. The emulator's virtual microphone
hands the recorder more audio than real time (Android logs a buffer overflow as recording starts), so the
emulator run allows up to 10.5 seconds with --longest-seconds; the recorder itself runs 8 seconds of
wall-clock time there too. It reads only the last clip the fake saved, not the request that carried it: the size of
every whole recognize request (S4-REQUEST-02) is checked by run_emulator_tests.py from the fake's
request log.

Run with the fingerprinter's Python, which has PyAV:
    ..\\..\\services\\fingerprinter\\.venv\\Scripts\\python tool/check_received_clip.py <clip.m4a> [--longest-seconds 10.5]
Exits 1 and names each problem when the clip is not what the app should record.
"""

from __future__ import annotations

import sys
from pathlib import Path

import av

MAXIMUM_CLIP_BYTES = 32_768
EXPECTED_SAMPLE_RATE = 16_000
SHORTEST_SECONDS = 7.5
LONGEST_SECONDS = 8.5


def problems_with_clip(path: Path, longest_seconds: float = LONGEST_SECONDS) -> list[str]:
    problems: list[str] = []
    size = path.stat().st_size
    if size > MAXIMUM_CLIP_BYTES:
        problems.append(f'the clip is {size} bytes, over {MAXIMUM_CLIP_BYTES}')
    with av.open(str(path)) as container:
        if container.format.name.split(',')[0] not in ('mov', 'mp4'):
            problems.append(f'the container is {container.format.name}, not MP4/M4A')
        audio_streams = [stream for stream in container.streams if stream.type == 'audio']
        if len(audio_streams) != 1:
            return problems + [f'the clip has {len(audio_streams)} audio streams, not one']
        stream = audio_streams[0]
        if stream.codec_context.name != 'aac':
            problems.append(f'the codec is {stream.codec_context.name}, not AAC')
        if stream.codec_context.sample_rate != EXPECTED_SAMPLE_RATE:
            problems.append(f'the sample rate is {stream.codec_context.sample_rate} Hz, not {EXPECTED_SAMPLE_RATE}')
        channels = stream.codec_context.layout.nb_channels
        if channels != 1:
            problems.append(f'the clip has {channels} channels, not one')
        decoded_samples = sum(frame.samples for frame in container.decode(stream))
    seconds = decoded_samples / EXPECTED_SAMPLE_RATE
    if not SHORTEST_SECONDS <= seconds <= longest_seconds:
        problems.append(f'the clip is {seconds:.2f} s long, not {SHORTEST_SECONDS}-{longest_seconds} s')
    return problems


def main() -> int:
    arguments = sys.argv[1:]
    longest_seconds = LONGEST_SECONDS
    if len(arguments) == 3 and arguments[1] == '--longest-seconds':
        longest_seconds = float(arguments[2])
        arguments = arguments[:1]
    if len(arguments) != 1:
        print(__doc__)
        return 2
    path = Path(arguments[0])
    problems = problems_with_clip(path, longest_seconds)
    for problem in problems:
        print(f'clip check failed: {problem}')
    if not problems:
        print(f'clip check passed: {path.stat().st_size} bytes of AAC, {EXPECTED_SAMPLE_RATE} Hz, one channel')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
