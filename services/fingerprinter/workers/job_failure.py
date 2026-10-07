"""A job that fails says why with a code only.

BullMQ stores `str(error)` as the job's failure reason, which the API reads. `JobFailure` makes that
exactly the code, so no exception text, class name, path or traceback can travel back to the API.
"""

from __future__ import annotations


class JobFailure(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code

    def __str__(self) -> str:
        return self.code
