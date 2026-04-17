"""SSH 连接配置管理器。"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

from backend.ssh.models import SSHConnection

logger = logging.getLogger("ssh_manager")


class SSHConnectionManager:
    """SSH 连接配置管理器。"""

    _CONFIG_FILE = Path.home() / ".winkterm" / "config.json"

    @classmethod
    def _load_config(cls) -> dict:
        """加载配置文件。"""
        if cls._CONFIG_FILE.exists():
            try:
                return json.loads(cls._CONFIG_FILE.read_text(encoding="utf-8"))
            except Exception as e:
                logger.error(f"加载配置失败: {e}")
                return {}
        return {}

    @classmethod
    def _save_config(cls, config: dict) -> None:
        """保存配置文件。"""
        cls._CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        cls._CONFIG_FILE.write_text(
            json.dumps(config, indent=2, ensure_ascii=False),
            encoding="utf-8"
        )

    @classmethod
    def list_connections(cls) -> dict:
        """列出所有连接（密码脱敏）。"""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])
        # 脱敏密码
        for conn in connections:
            if conn.get("password"):
                conn["password"] = "********"
            if conn.get("passphrase"):
                conn["passphrase"] = "********"
        return {"connections": connections}

    @classmethod
    def get_connection(cls, conn_id: str) -> Optional[SSHConnection]:
        """获取连接详情。"""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])
        for conn_data in connections:
            if conn_data.get("id") == conn_id:
                return SSHConnection.from_dict(conn_data)
        return None

    @classmethod
    def create_connection(cls, data: dict) -> dict:
        """创建连接。"""
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
        """更新连接。"""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])

        for i, conn in enumerate(connections):
            if conn.get("id") == conn_id:
                # 更新字段
                for key, value in data.items():
                    conn[key] = value
                connections[i] = conn
                break

        config["ssh_connections"] = connections
        cls._save_config(config)
        logger.info(f"更新 SSH 连接: {conn_id}")
        return {"success": True}

    @classmethod
    def delete_connection(cls, conn_id: str) -> dict:
        """删除连接。"""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])
        connections = [c for c in connections if c.get("id") != conn_id]
        config["ssh_connections"] = connections
        cls._save_config(config)
        logger.info(f"删除 SSH 连接: {conn_id}")
        return {"success": True}

    @classmethod
    def update_last_connected(cls, conn_id: str) -> None:
        """更新最后连接时间。"""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])

        for conn in connections:
            if conn.get("id") == conn_id:
                conn["last_connected"] = datetime.now().isoformat()
                break

        config["ssh_connections"] = connections
        cls._save_config(config)

    @classmethod
    def import_from_electerm(cls, bookmarks: list[dict]) -> dict:
        """从 electerm 导入配置。"""
        config = cls._load_config()
        connections = config.get("ssh_connections", [])
        imported = 0

        for bm in bookmarks:
            # 跳过无效项
            if not bm.get("host"):
                continue

            # 检查是否已存在（按 host+port+username 判断）
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
