"""SSH 文件传输任务管理。"""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path, PurePosixPath

from backend.ssh.file_transfer import SSHFileTransfer
from backend.ssh.models import SSHConnection


@dataclass
class TransferJob:
    """文件传输任务。"""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    direction: str = ""
    file_name: str = ""
    status: str = "pending"
    progress: float = 0.0
    bytes_transferred: int = 0
    total_bytes: int | None = None
    error: str | None = None
    remote_path: str | None = None
    local_path: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "direction": self.direction,
            "file_name": self.file_name,
            "status": self.status,
            "progress": self.progress,
            "bytes_transferred": self.bytes_transferred,
            "total_bytes": self.total_bytes,
            "error": self.error,
            "remote_path": self.remote_path,
            "local_path": self.local_path,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class TransferJobManager:
    """文件传输任务管理器。"""

    _jobs: dict[str, TransferJob] = {}
    _lock = threading.Lock()

    @classmethod
    def _touch(cls, job: TransferJob) -> None:
        job.updated_at = datetime.now().isoformat()

    @classmethod
    def _create_job(
        cls,
        direction: str,
        file_name: str,
        remote_path: str | None = None,
        local_path: str | None = None,
    ) -> TransferJob:
        job = TransferJob(
            direction=direction,
            file_name=file_name,
            remote_path=remote_path,
            local_path=local_path,
        )
        with cls._lock:
            cls._jobs[job.id] = job
        return job

    @classmethod
    def _update_progress(cls, job_id: str, transferred: int, total: int) -> None:
        with cls._lock:
            job = cls._jobs.get(job_id)
            if not job:
                return
            job.status = "running"
            job.bytes_transferred = transferred
            job.total_bytes = total
            job.progress = round((transferred / total) * 100, 1) if total > 0 else 0.0
            cls._touch(job)

    @classmethod
    def _mark_success(cls, job_id: str) -> None:
        with cls._lock:
            job = cls._jobs.get(job_id)
            if not job:
                return
            job.status = "success"
            if job.total_bytes is not None:
                job.bytes_transferred = job.total_bytes
            job.progress = 100.0
            cls._touch(job)

    @classmethod
    def _mark_error(cls, job_id: str, message: str) -> None:
        with cls._lock:
            job = cls._jobs.get(job_id)
            if not job:
                return
            job.status = "error"
            job.error = message
            cls._touch(job)

    @classmethod
    def get_job(cls, job_id: str) -> dict | None:
        with cls._lock:
            job = cls._jobs.get(job_id)
            return job.to_dict() if job else None

    @classmethod
    def start_download_job(cls, conn: SSHConnection, remote_path: str, local_path: str) -> dict:
        """启动本地下载任务。"""
        file_name = PurePosixPath(remote_path).name or "download"
        job = cls._create_job(
            direction="download",
            file_name=file_name,
            remote_path=remote_path,
            local_path=local_path,
        )

        def worker() -> None:
            try:
                SSHFileTransfer.download_to_local_file(
                    conn,
                    remote_path,
                    local_path,
                    progress_callback=lambda transferred, total: cls._update_progress(job.id, transferred, total),
                )
                cls._mark_success(job.id)
            except Exception as exc:
                cls._mark_error(job.id, str(exc))

        threading.Thread(target=worker, daemon=True).start()
        return job.to_dict()

    @classmethod
    def start_upload_job(
        cls,
        conn: SSHConnection,
        local_path: str,
        remote_path: str,
        overwrite: bool = False,
    ) -> dict:
        """启动本地上传任务。"""
        file_name = Path(local_path).name or "upload"
        job = cls._create_job(
            direction="upload",
            file_name=file_name,
            remote_path=remote_path,
            local_path=local_path,
        )

        def worker() -> None:
            try:
                SSHFileTransfer.upload_local_file(
                    conn,
                    local_path,
                    remote_path,
                    progress_callback=lambda transferred, total: cls._update_progress(job.id, transferred, total),
                    overwrite=overwrite,
                )
                cls._mark_success(job.id)
            except Exception as exc:
                cls._mark_error(job.id, str(exc))

        threading.Thread(target=worker, daemon=True).start()
        return job.to_dict()
