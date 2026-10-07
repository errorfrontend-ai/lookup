"""Decoding and fingerprinting run in a pool of separate processes.

The work is CPU-bound, so in the worker's own process it would stall the queue connection and the
heartbeat. A separate process can also be abandoned: when a task overruns its hard time cap (a file
built to make the decoder hang), the whole pool is replaced and its processes are terminated, which a
thread could never be.
"""

from __future__ import annotations

import asyncio
import multiprocessing
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from typing import Any


class EngineTaskTimedOut(Exception):
    """A task ran past its hard cap; its process was terminated."""


class EnginePool:
    def __init__(self, process_count: int, initializer: Callable[..., None], initializer_arguments: tuple = ()) -> None:
        self._process_count = process_count
        self._initializer = initializer
        self._initializer_arguments = initializer_arguments
        self._executor = self._new_executor()

    def _new_executor(self) -> ProcessPoolExecutor:
        return ProcessPoolExecutor(
            max_workers=self._process_count, initializer=self._initializer, initargs=self._initializer_arguments,
            mp_context=multiprocessing.get_context("spawn"))

    async def run(self, function: Callable[..., Any], *arguments: Any, timeout_seconds: float) -> Any:
        for attempt in (1, 2):
            executor = self._executor
            try:
                # Submitting is inside the guard too: a pool whose process died while idle is broken
                # from the moment it is next used, and must be replaced, not left failing every job.
                future = asyncio.get_running_loop().run_in_executor(executor, function, *arguments)
                return await asyncio.wait_for(future, timeout=timeout_seconds)
            except TimeoutError:
                self._replace_executor(executor)
                raise EngineTaskTimedOut() from None
            except BrokenProcessPool:
                # The pool broke under this task: another task's overrun replaced it, or a process died.
                # This task did nothing wrong, so it runs once more on a fresh pool.
                self._replace_executor(executor)
                if attempt == 1:
                    continue
                raise
        raise AssertionError("unreachable")

    async def warm_up(self, function: Callable[[], Any], timeout_seconds: float = 120.0) -> None:
        """Starts every process (each imports the engine) before the first job waits on it."""
        await asyncio.gather(*(self.run(function, timeout_seconds=timeout_seconds) for _ in range(self._process_count)))

    def _replace_executor(self, stuck_executor: ProcessPoolExecutor) -> None:
        if stuck_executor is not self._executor:
            return  # already replaced by another task's overrun
        self._executor = self._new_executor()
        for process in list(getattr(stuck_executor, "_processes", {}).values()):
            process.terminate()
        stuck_executor.shutdown(wait=False, cancel_futures=True)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)
