"""Look Up fingerprinting core (landmark algorithm after Dejavu, MIT — see config.py)."""

from .align import Candidate, MatchResult, align, decide, rank_candidates
from .config import FINGERPRINT_VERSION, FingerprintParameters, MatchThresholds
from .decode import DecodeError, decode_audio
from .fingerprint import Fingerprint, fingerprint
from .index import Matches, MemoryIndex, PostgresIndex
from .matcher import CLIP_MAXIMUM_BYTES, CLIP_MAXIMUM_SECONDS, DuplicateCheck, Matcher, Recognition

__all__ = [
    "CLIP_MAXIMUM_BYTES", "CLIP_MAXIMUM_SECONDS", "Candidate", "DecodeError", "FINGERPRINT_VERSION", "DuplicateCheck", "Fingerprint", "FingerprintParameters", "MatchResult",
    "MatchThresholds", "Matcher", "Matches", "MemoryIndex", "PostgresIndex", "Recognition",
    "align", "decide", "decode_audio", "fingerprint", "rank_candidates",
]
