"""SSH 连接数据模型。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Optional
import uuid


@dataclass
class SSHConnection:
    """SSH 连接配置。"""

    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    title: str = ""
    host: str = ""
    port: int = 22
    username: str = ""
    auth_type: Literal["password", "key"] = "password"

    # 密码认证
    password: Optional[str] = None

    # 密钥认证
    private_key_path: Optional[str] = None
    passphrase: Optional[str] = None

    # 显示选项
    color: Optional[str] = None
    group: Optional[str] = None

    # 元数据
    created_at: datetime = field(default_factory=datetime.now)
    last_connected: Optional[datetime] = None

    def to_dict(self) -> dict:
        """转换为字典。"""
        return {
            "id": self.id,
            "title": self.title,
            "host": self.host,
            "port": self.port,
            "username": self.username,
            "auth_type": self.auth_type,
            "password": self.password,
            "private_key_path": self.private_key_path,
            "passphrase": self.passphrase,
            "color": self.color,
            "group": self.group,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "last_connected": self.last_connected.isoformat() if self.last_connected else None,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SSHConnection":
        """从字典创建。"""
        return cls(
            id=data.get("id", str(uuid.uuid4())[:8]),
            title=data.get("title", ""),
            host=data.get("host", ""),
            port=data.get("port", 22),
            username=data.get("username", ""),
            auth_type=data.get("auth_type", "password"),
            password=data.get("password"),
            private_key_path=data.get("private_key_path"),
            passphrase=data.get("passphrase"),
            color=data.get("color"),
            group=data.get("group"),
            created_at=datetime.fromisoformat(data["created_at"]) if data.get("created_at") else datetime.now(),
            last_connected=datetime.fromisoformat(data["last_connected"]) if data.get("last_connected") else None,
        )

    @classmethod
    def from_electerm(cls, bookmark: dict) -> "SSHConnection":
        """从 electerm bookmark 创建。"""
        return cls(
            id=bookmark.get("id", str(uuid.uuid4())[:8]),
            title=bookmark.get("title", "") or bookmark.get("host", "未命名"),
            host=bookmark.get("host", ""),
            port=bookmark.get("port", 22),
            username=bookmark.get("username", ""),
            auth_type="password" if bookmark.get("authType") == "password" else "key",
            password=bookmark.get("password"),
            private_key_path=bookmark.get("privateKeyPath"),
            color=bookmark.get("color"),
        )
