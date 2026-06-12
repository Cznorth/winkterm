"""SSH connection configuration manager."""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

from backend.ssh.models import SSHConnection

logger = logging.getLogger("ssh_manager")

_MASKED_SECRET = "********"


def _secret_unchanged(value) -> bool:
    """An empty string or masked placeholder means the user did not change this secret."""
    if value is None:
        return True
    if value == "":
        return True
    if value == _MASKED_SECRET:
        return True
    return "****" in str(value)


class SSHConnectionManager:
    """SSH connection configuration manager."""

    _CONFIG_FILE = Path.home() / ".winkterm" / "config.json"

    @classmethod
    def _load_config(cls) -> dict:
        """Load the configuration file."""
        if cls._CONFIG_FILE.exists():
            try:
                return json.loads(cls._CONFIG_FILE.read_text(encoding="utf-8"))
            except Exception as e:
                logger.error(f"加载配置失败: {e}")
                return {}
        return {}

    @classmethod
    def _save_config(cls, config: dict) -> None:
        """Save the configuration file."""
        cls._CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        cls._CONFIG_FILE.write_text(
            json.dumps(config, indent=2, ensure_ascii=False),
            encoding="utf-8"
        )

    @classmethod
    def list_connections(cls) -> dict:
        """List all connections (passwords masked, runbook stripped)."""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])
        # Mask passwords
        for conn in connections:
            if conn.get("password"):
                conn["password"] = "********"
            if conn.get("passphrase"):
                conn["passphrase"] = "********"
            if conn.get("vnc_password"):
                conn["vnc_password"] = "********"
            # Drop the (potentially long) runbook body from the list; expose a
            # boolean flag instead. Fetch the full text via get_runbook.
            conn["has_runbook"] = bool(conn.pop("runbook", "").strip())
        return {"connections": connections}

    @classmethod
    def get_connection_dict(cls, conn_id: str, *, include_secrets: bool = False) -> Optional[dict]:
        """Get the connection dict; returns plaintext secrets when include_secrets=True."""
        config = cls._load_config()
        for conn_data in config.get("ssh_connections", []):
            if conn_data.get("id") == conn_id:
                if include_secrets:
                    return dict(conn_data)
                masked = dict(conn_data)
                for key in ("password", "passphrase", "vnc_password"):
                    if masked.get(key):
                        masked[key] = _MASKED_SECRET
                return masked
        return None

    @classmethod
    def get_connection(cls, conn_id: str) -> Optional[SSHConnection]:
        """Get connection details."""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])
        for conn_data in connections:
            if conn_data.get("id") == conn_id:
                return SSHConnection.from_dict(conn_data)
        return None

    @classmethod
    def create_connection(cls, data: dict) -> dict:
        """Create a connection."""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])

        conn = SSHConnection(**data)
        connections.append(conn.to_dict())
        config["ssh_connections"] = connections
        cls._save_config(config)

        logger.info(f"创建 SSH 连接: {conn.title} ({conn.host})")
        return {"success": True, "id": conn.id}

    @classmethod
    def update_connection(cls, conn_id: str, data: dict) -> dict:
        """Update a connection."""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])

        for i, conn in enumerate(connections):
            if conn.get("id") == conn_id:
                updates = dict(data)
                for secret_key in ("password", "passphrase", "vnc_password"):
                    if secret_key in updates and _secret_unchanged(updates[secret_key]):
                        updates.pop(secret_key)
                for key, value in updates.items():
                    conn[key] = value
                connections[i] = conn
                break

        config["ssh_connections"] = connections
        cls._save_config(config)
        logger.info(f"更新 SSH 连接: {conn_id}")
        return {"success": True}

    @classmethod
    def delete_connection(cls, conn_id: str) -> dict:
        """Delete a connection."""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])
        connections = [c for c in connections if c.get("id") != conn_id]
        config["ssh_connections"] = connections
        cls._save_config(config)
        logger.info(f"删除 SSH 连接: {conn_id}")
        return {"success": True}

    @classmethod
    def update_last_connected(cls, conn_id: str) -> None:
        """Update the last-connected time."""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])

        for conn in connections:
            if conn.get("id") == conn_id:
                conn["last_connected"] = datetime.now().isoformat()
                break

        config["ssh_connections"] = connections
        cls._save_config(config)

    @classmethod
    def get_runbook(cls, conn_id: str) -> Optional[dict]:
        """Get the ops runbook for a connection. None if the connection is missing."""
        config = cls._load_config()
        for conn in config.get("ssh_connections", []):
            if conn.get("id") == conn_id:
                return {
                    "id": conn_id,
                    "title": conn.get("title", ""),
                    "host": conn.get("host", ""),
                    "runbook": conn.get("runbook", ""),
                }
        return None

    @classmethod
    def update_runbook(cls, conn_id: str, runbook: str) -> dict:
        """Replace the ops runbook for a connection."""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])
        for conn in connections:
            if conn.get("id") == conn_id:
                conn["runbook"] = runbook
                config["ssh_connections"] = connections
                cls._save_config(config)
                logger.info(f"更新运维手册: {conn_id} ({len(runbook)} 字符)")
                return {"success": True}
        return {"success": False}

    @classmethod
    def import_from_electerm(cls, bookmarks: list[dict]) -> dict:
        """Import configuration from electerm."""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])
        imported = 0

        for bm in bookmarks:
            # Skip invalid entries
            if not bm.get("host"):
                continue

            # Check whether it already exists (by host+port+username)
            existing = any(
                c.get("host") == bm.get("host")
                and c.get("port") == bm.get("port", 22)
                and c.get("username") == bm.get("username")
                for c in connections
            )

            if not existing:
                conn = SSHConnection.from_electerm(bm)
                connections.append(conn.to_dict())
                imported += 1

        config["ssh_connections"] = connections
        cls._save_config(config)

        logger.info(f"导入 electerm 配置: {imported} 条")
        return {"success": True, "imported": imported}
