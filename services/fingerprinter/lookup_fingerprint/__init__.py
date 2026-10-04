"""Look Up fingerprinting core (landmark algorithm after Dejavu, MIT — see config.py)."""

from .align import Candidate, MatchResult, align, decide, rank_candidates
from .config import FingerprintParameters, MatchThresholds
from .decode import DecodeError, decode_audio
from .fingerprint import Fingerprint, fingerprint
from .index import Matches, MemoryIndex, PostgresIndex
from .matcher import DuplicateCheck, Matcher, Recognition

__all__ = [
    "Candidate", "DecodeError", "DuplicateCheck", "Fingerprint", "FingerprintParameters", "MatchResult",
    "MatchThresholds", "Matcher", "Matches", "MemoryIndex", "PostgresIndex", "Recognition",
    "align", "decide", "decode_audio", "fingerprint", "rank_candidates",
]
