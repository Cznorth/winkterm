"""Async SSH one-shot run jobs: submit a command, poll the result later.

Motivation: the synchronous ``POST /api/agent/ssh/{id}/run`` blocks the HTTP
request until the command finishes. Behind a reverse proxy with a ~60s gateway
timeout, long commands (package installs, mysqldump, docker build, large copies)
return 504 even though they keep running on the host. These jobs decouple the
two: the submit call returns a ``job_id`` immediately and the command continues
in the backend event loop; the caller polls ``GET /api/agent/jobs/{id}``.

The worker runs as an asyncio task on the FastAPI event loop (the terminal
session API is async and loop-bound), so ``submit`` must be called from within a
running loop -- which the async route handlers always are.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from typing import Awaitable, Callable, Optional


def _now() -> str:
    return datetime.now().isoformat()


class RunJob:
    """A single async run job. Mutated in place by its worker coroutine."""

    # status: running | success | failed | timeout | canceled | error
    def __init__(self, conn_id: str, command_preview: str) -> None:
        self.id = uuid.uuid4().hex
        self.conn_id = conn_id
        self.command_preview = command_preview
        self.status = "running"
        self.exit_code: Optional[int] = None
        self.ok: Optional[bool] = None
        self.stdout = ""
        self.reason: Optional[str] = None
        self.error: Optional[str] = None
        self.terminal_id: Optional[str] = None
        self.created_at = _now()
        self.updated_at = self.created_at
        self.task: Optional[asyncio.Task] = None

    def set_terminal(self, terminal_id: str) -> None:
        self.terminal_id = terminal_id
        self.updated_at = _now()

    def finish(self, result: dict) -> None:
        """Record a completed exec() result."""
        self.stdout = result.get("stdout", "")
        self.exit_code = result.get("exit_code")
        self.ok = result.get("ok")
        self.reason = result.get("reason")
        if result.get("ok"):
            self.status = "success"
        elif result.get("reason") == "timeout":
            self.status = "timeout"
        else:
            self.status = "failed"
        self.updated_at = _now()

    def fail(self, message: str) -> None:
        self.status = "error"
        self.error = message
        self.updated_at = _now()

    def cancel_state(self) -> None:
        self.status = "canceled"
        self.updated_at = _now()

    def to_dict(self) -> dict:
        return {
            "job_id": self.id,
            "conn_id": self.conn_id,
            "command": self.command_preview,
            "status": self.status,
            "done": self.status != "running",
            "exit_code": self.exit_code,
            "ok": self.ok,
            "stdout": self.stdout,
            "reason": self.reason,
            "error": self.error,
            "terminal_id": self.terminal_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


# A worker takes the job and drives it to completion, mutating it in place.
Worker = Callable[[RunJob], Awaitable[None]]


class RunJobManager:
    """In-memory async run job registry.

    Mirrors :class:`TransferJobManager` but for command execution, and uses
    asyncio tasks (not threads) because the underlying session API is loop-bound.
    """

    _jobs: "dict[str, RunJob]" = {}
    _max_jobs = 200

    @classmethod
    def submit(cls, conn_id: str, command_preview: str, worker: Worker) -> dict:
        """Create a job and schedule its worker on the current event loop."""
        job = RunJob(conn_id, command_preview)
        cls._jobs[job.id] = job
        cls._evict()
        job.task = asyncio.create_task(cls._run(job, worker))
        return job.to_dict()

    @classmethod
    async def _run(cls, job: RunJob, worker: Worker) -> None:
        try:
            await worker(job)
        except asyncio.CancelledError:
            job.cancel_state()
            raise
        except Exception as exc:  # noqa: BLE001 - surface any worker failure to the caller
            job.fail(str(exc))

    @classmethod
    def get(cls, job_id: str) -> Optional[dict]:
        job = cls._jobs.get(job_id)
        return job.to_dict() if job else None

    @classmethod
    def list(cls) -> list[dict]:
        return [j.to_dict() for j in cls._jobs.values()]

    @classmethod
    def cancel(cls, job_id: str) -> Optional[dict]:
        job = cls._jobs.get(job_id)
        if not job:
            return None
        if job.task and not job.task.done():
            job.task.cancel()
        return job.to_dict()

    @classmethod
    def _evict(cls) -> None:
        """Cap memory: drop the oldest finished jobs once over the limit."""
        if len(cls._jobs) <= cls._max_jobs:
            return
        finished = [j for j in cls._jobs.values() if j.status != "running"]
        finished.sort(key=lambda j: j.updated_at)
        overflow = len(cls._jobs) - cls._max_jobs
        for job in finished[:overflow]:
            cls._jobs.pop(job.id, None)
