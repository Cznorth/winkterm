"""SSH 文件传输服务。"""

from __future__ import annotations

import logging
import posixpath
import stat
from collections.abc import Callable
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterator

import paramiko

from backend.ssh.models import SSHConnection

logger = logging.getLogger("ssh_file_transfer")


class SSHFileTransferError(Exception):
    """SSH 文件传输异常。"""


class SSHFileNotFoundError(SSHFileTransferError):
    """远端文件不存在。"""


class SSHInvalidPathError(SSHFileTransferError):
    """路径不合法。"""


class SSHFileExistsError(SSHFileTransferError):
    """目标文件已存在。"""


class SSHFileTransfer:
    """SSH 文件传输服务。"""

    CHUNK_SIZE = 64 * 1024
    TEXT_PREVIEW_LIMIT = 1024 * 1024
    TEXT_ENCODINGS = ("utf-8", "utf-8-sig", "gb18030")

    @classmethod
    def _connect(cls, conn: SSHConnection) -> tuple[paramiko.SSHClient, paramiko.SFTPClient]:
        """建立 SFTP 连接。"""
        client = paramiko.SSHClient()
        client.load_system_host_keys()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

        connect_kwargs: dict = {
            "hostname": conn.host,
            "port": conn.port,
            "username": conn.username,
            "timeout": 15,
            "banner_timeout": 15,
            "auth_timeout": 15,
            "allow_agent": False,
            "look_for_keys": False,
        }

        if conn.auth_type == "password":
            connect_kwargs["password"] = conn.password or ""
        else:
            if conn.private_key_path:
                connect_kwargs["key_filename"] = str(Path(conn.private_key_path).expanduser())
            if conn.passphrase:
                connect_kwargs["passphrase"] = conn.passphrase
            if not conn.private_key_path:
                connect_kwargs["allow_agent"] = True
                connect_kwargs["look_for_keys"] = True

        try:
            client.connect(**connect_kwargs)
            return client, client.open_sftp()
        except Exception as exc:
            client.close()
            raise SSHFileTransferError(str(exc)) from exc

    @staticmethod
    def _clean_remote_path(path: str) -> str:
        remote_path = path.strip().replace("\\", "/")
        if not remote_path:
            raise SSHInvalidPathError("远端路径不能为空")
        return remote_path

    @classmethod
    def _resolve_remote_path(cls, sftp: paramiko.SFTPClient, path: str) -> str:
        """解析远端路径。"""
        remote_path = cls._clean_remote_path(path)
        current_dir = sftp.normalize(".")

        if remote_path == "~":
            return current_dir
        if remote_path.startswith("~/"):
            return posixpath.join(current_dir, remote_path[2:])
        if remote_path.startswith("/"):
            return remote_path
        return posixpath.join(current_dir, remote_path)

    @classmethod
    def _resolve_remote_upload_path(
        cls,
        sftp: paramiko.SFTPClient,
        remote_path: str,
        file_name: str,
    ) -> str:
        """解析上传目标路径。"""
        candidate = cls._resolve_remote_path(sftp, remote_path)

        if candidate.endswith("/"):
            return posixpath.join(candidate.rstrip("/"), file_name)

        try:
            attr = sftp.stat(candidate)
            if stat.S_ISDIR(attr.st_mode):
                return posixpath.join(candidate.rstrip("/"), file_name)
        except FileNotFoundError:
            pass
        except OSError:
            pass

        return candidate

    @staticmethod
    def _join_remote_path(base_path: str, name: str) -> str:
        """拼接远端路径。"""
        if base_path == "/":
            return f"/{name}"
        return posixpath.join(base_path.rstrip("/"), name)

    @staticmethod
    def _looks_like_binary(data: bytes) -> bool:
        """粗略判断是否为二进制内容。"""
        if not data:
            return False
        if b"\x00" in data:
            return True

        control_chars = sum(
            1 for byte in data
            if byte < 32 and byte not in (9, 10, 13)
        )
        return control_chars / max(len(data), 1) > 0.2

    @classmethod
    def _ensure_upload_destination(
        cls,
        sftp: paramiko.SFTPClient,
        destination: str,
        overwrite: bool,
    ) -> None:
        """校验上传目标是否允许写入。"""
        try:
            attr = sftp.stat(destination)
        except FileNotFoundError:
            return
        except OSError as exc:
            raise SSHFileTransferError(str(exc)) from exc

        if stat.S_ISDIR(attr.st_mode):
            raise SSHInvalidPathError(f"目标路径是目录，无法覆盖: {destination}")

        if not overwrite:
            raise SSHFileExistsError(f"目标文件已存在: {destination}")

    @classmethod
    def _assert_remote_file(cls, sftp: paramiko.SFTPClient, remote_path: str) -> paramiko.SFTPAttributes:
        """校验远端路径是文件。"""
        try:
            attr = sftp.stat(remote_path)
        except FileNotFoundError as exc:
            raise SSHFileNotFoundError(f"远端文件不存在: {remote_path}") from exc
        except OSError as exc:
            raise SSHFileTransferError(str(exc)) from exc

        if stat.S_ISDIR(attr.st_mode):
            raise SSHInvalidPathError(f"远端路径是目录，不是文件: {remote_path}")
        return attr

    @classmethod
    def _assert_remote_directory(cls, sftp: paramiko.SFTPClient, remote_path: str) -> paramiko.SFTPAttributes:
        """校验远端路径是目录。"""
        try:
            attr = sftp.stat(remote_path)
        except FileNotFoundError as exc:
            raise SSHFileNotFoundError(f"远端目录不存在: {remote_path}") from exc
        except OSError as exc:
            raise SSHFileTransferError(str(exc)) from exc

        if not stat.S_ISDIR(attr.st_mode):
            raise SSHInvalidPathError(f"远端路径不是目录: {remote_path}")
        return attr

    @classmethod
    def list_directory(cls, conn: SSHConnection, remote_path: str | None = None) -> dict:
        """列出远端目录。"""
        client, sftp = cls._connect(conn)
        try:
            target_path = cls._resolve_remote_path(sftp, remote_path or ".")
            normalized = sftp.normalize(target_path)
            cls._assert_remote_directory(sftp, normalized)

            items = []
            for entry in sftp.listdir_attr(normalized):
                item_path = cls._join_remote_path(normalized, entry.filename)
                modified_at = None
                if getattr(entry, "st_mtime", None):
                    modified_at = datetime.fromtimestamp(entry.st_mtime).isoformat()

                items.append({
                    "name": entry.filename,
                    "path": item_path,
                    "is_dir": stat.S_ISDIR(entry.st_mode),
                    "size": None if stat.S_ISDIR(entry.st_mode) else entry.st_size,
                    "modified_at": modified_at,
                    "permissions": stat.filemode(entry.st_mode),
                })

            items.sort(key=lambda item: (not item["is_dir"], item["name"].lower()))

            parent_path = None
            if normalized != "/":
                parent_path = posixpath.dirname(normalized.rstrip("/")) or "/"

            return {
                "path": normalized,
                "parent_path": parent_path,
                "items": items,
            }
        except SSHFileTransferError:
            raise
        except Exception as exc:
            raise SSHFileTransferError(str(exc)) from exc
        finally:
            sftp.close()
            client.close()

    @classmethod
    def create_directory(cls, conn: SSHConnection, remote_path: str) -> str:
        """创建远端目录。"""
        client, sftp = cls._connect(conn)
        try:
            target_path = cls._resolve_remote_path(sftp, remote_path)
            sftp.mkdir(target_path)
            return sftp.normalize(target_path)
        except SSHFileTransferError:
            raise
        except OSError as exc:
            raise SSHFileTransferError(str(exc)) from exc
        finally:
            sftp.close()
            client.close()

    @classmethod
    def upload_file_obj(
        cls,
        conn: SSHConnection,
        file_obj: BinaryIO,
        remote_path: str,
        file_name: str,
        file_size: int | None = None,
        progress_callback: Callable[[int, int], None] | None = None,
        overwrite: bool = False,
    ) -> str:
        """上传类文件对象到远端。"""
        client, sftp = cls._connect(conn)
        try:
            destination = cls._resolve_remote_upload_path(sftp, remote_path, file_name)
            cls._ensure_upload_destination(sftp, destination, overwrite)
            if file_size is None:
                try:
                    current_pos = file_obj.tell()
                    file_obj.seek(0, 2)
                    file_size = file_obj.tell()
                    file_obj.seek(current_pos)
                except Exception:
                    file_size = 0

            file_obj.seek(0)
            sftp.putfo(
                file_obj,
                destination,
                file_size=file_size or 0,
                callback=progress_callback,
            )
            logger.info("上传文件成功: %s -> %s@%s:%s", file_name, conn.username, conn.host, destination)
            return destination
        except SSHFileTransferError:
            raise
        except Exception as exc:
            raise SSHFileTransferError(str(exc)) from exc
        finally:
            sftp.close()
            client.close()

    @classmethod
    def upload_local_file(
        cls,
        conn: SSHConnection,
        local_path: str,
        remote_path: str,
        progress_callback: Callable[[int, int], None] | None = None,
        overwrite: bool = False,
    ) -> str:
        """从本地路径上传文件到远端。"""
        local_file = Path(local_path).expanduser().resolve()
        if not local_file.exists() or not local_file.is_file():
            raise SSHInvalidPathError(f"本地文件不存在: {local_file}")

        with local_file.open("rb") as fp:
            return cls.upload_file_obj(
                conn,
                fp,
                remote_path,
                local_file.name,
                file_size=local_file.stat().st_size,
                progress_callback=progress_callback,
                overwrite=overwrite,
            )

    @classmethod
    def download_to_local_file(
        cls,
        conn: SSHConnection,
        remote_path: str,
        local_path: str,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> str:
        """下载远端文件到本地路径。"""
        destination = Path(local_path).expanduser()
        destination.parent.mkdir(parents=True, exist_ok=True)

        client, sftp = cls._connect(conn)
        try:
            source = cls._resolve_remote_path(sftp, remote_path)
            cls._assert_remote_file(sftp, source)
            sftp.get(source, str(destination), callback=progress_callback)
            logger.info("下载文件成功: %s@%s:%s -> %s", conn.username, conn.host, source, destination)
            return source
        except SSHFileTransferError:
            raise
        except Exception as exc:
            raise SSHFileTransferError(str(exc)) from exc
        finally:
            sftp.close()
            client.close()

    @classmethod
    def read_text_file(cls, conn: SSHConnection, remote_path: str) -> dict:
        """读取文本文件用于预览/编辑。"""
        client, sftp = cls._connect(conn)
        try:
            source = cls._resolve_remote_path(sftp, remote_path)
            attr = cls._assert_remote_file(sftp, source)

            if attr.st_size > cls.TEXT_PREVIEW_LIMIT:
                raise SSHInvalidPathError("当前仅支持预览和编辑 1 MB 以内的文本文件")

            with sftp.file(source, "rb") as remote_file:
                data = remote_file.read(cls.TEXT_PREVIEW_LIMIT + 1)

            if len(data) > cls.TEXT_PREVIEW_LIMIT:
                raise SSHInvalidPathError("当前仅支持预览和编辑 1 MB 以内的文本文件")

            if cls._looks_like_binary(data[: min(len(data), 8192)]):
                raise SSHInvalidPathError("当前文件不是可预览的文本文件")

            decoded = None
            used_encoding = None
            for encoding in cls.TEXT_ENCODINGS:
                try:
                    decoded = data.decode(encoding)
                    used_encoding = encoding
                    break
                except UnicodeDecodeError:
                    continue

            if decoded is None or used_encoding is None:
                raise SSHInvalidPathError("当前文件编码暂不支持在线预览")

            return {
                "path": source,
                "encoding": used_encoding,
                "content": decoded,
                "size": attr.st_size,
            }
        except SSHFileTransferError:
            raise
        except Exception as exc:
            raise SSHFileTransferError(str(exc)) from exc
        finally:
            sftp.close()
            client.close()

    @classmethod
    def write_text_file(
        cls,
        conn: SSHConnection,
        remote_path: str,
        content: str,
        encoding: str = "utf-8",
    ) -> dict:
        """保存文本文件。"""
        if encoding not in cls.TEXT_ENCODINGS:
            raise SSHInvalidPathError("当前仅支持 utf-8、utf-8-sig 和 gb18030 编码")

        data = content.encode(encoding)
        if len(data) > cls.TEXT_PREVIEW_LIMIT:
            raise SSHInvalidPathError("当前仅支持保存 1 MB 以内的文本文件")

        client, sftp = cls._connect(conn)
        try:
            target = cls._resolve_remote_path(sftp, remote_path)
            if target.endswith("/"):
                raise SSHInvalidPathError("保存路径必须是文件，不能是目录")

            with sftp.file(target, "wb") as remote_file:
                remote_file.write(data)

            return {
                "path": target,
                "encoding": encoding,
                "size": len(data),
            }
        except SSHFileTransferError:
            raise
        except Exception as exc:
            raise SSHFileTransferError(str(exc)) from exc
        finally:
            sftp.close()
            client.close()

    @classmethod
    def delete_paths(cls, conn: SSHConnection, paths: list[str]) -> dict:
        """删除远端文件或目录。"""
        if not paths:
            raise SSHInvalidPathError("请选择要删除的文件")

        client, sftp = cls._connect(conn)
        deleted: list[str] = []

        def remove_recursive(target_path: str) -> None:
            try:
                attr = sftp.stat(target_path)
            except FileNotFoundError as exc:
                raise SSHFileNotFoundError(f"目标不存在: {target_path}") from exc
            except OSError as exc:
                raise SSHFileTransferError(str(exc)) from exc

            if stat.S_ISDIR(attr.st_mode):
                for entry in sftp.listdir_attr(target_path):
                    child_path = cls._join_remote_path(target_path, entry.filename)
                    remove_recursive(child_path)
                sftp.rmdir(target_path)
            else:
                sftp.remove(target_path)

        try:
            for path in paths:
                target = cls._resolve_remote_path(sftp, path)
                remove_recursive(target)
                deleted.append(target)

            return {
                "deleted_paths": deleted,
            }
        except SSHFileTransferError:
            raise
        except Exception as exc:
            raise SSHFileTransferError(str(exc)) from exc
        finally:
            sftp.close()
            client.close()

    @classmethod
    def create_download_stream(
        cls,
        conn: SSHConnection,
        remote_path: str,
    ) -> tuple[Iterator[bytes], str, int | None]:
        """创建下载流。"""
        client, sftp = cls._connect(conn)
        remote_file = None

        try:
            source = cls._resolve_remote_path(sftp, remote_path)
            attr = cls._assert_remote_file(sftp, source)
            remote_file = sftp.file(source, "rb")
            file_name = PurePosixPath(source).name or "download"
            file_size = getattr(attr, "st_size", None)
        except SSHFileTransferError:
            if remote_file is not None:
                remote_file.close()
            sftp.close()
            client.close()
            raise
        except Exception as exc:
            if remote_file is not None:
                remote_file.close()
            sftp.close()
            client.close()
            raise SSHFileTransferError(str(exc)) from exc

        def iterator() -> Iterator[bytes]:
            try:
                while True:
                    chunk = remote_file.read(cls.CHUNK_SIZE)
                    if not chunk:
                        break
                    yield chunk
            finally:
                try:
                    remote_file.close()
                finally:
                    sftp.close()
                    client.close()

        return iterator(), file_name, file_size
