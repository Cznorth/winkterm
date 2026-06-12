"""SSH connection data models."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Optional
import uuid


@dataclass
class SSHConnection:
    """SSH connection configuration."""

    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    title: str = ""
    host: str = ""
    port: int = 22
    username: str = ""
    auth_type: Literal["password", "key"] = "password"

    # Password authentication
    password: Optional[str] = None

    # Key authentication
    private_key_path: Optional[str] = None
    passphrase: Optional[str] = None

    # VNC (via SSH tunnel)
    vnc_port: int = 5901
    vnc_password: Optional[str] = None

    # Display options
    color: Optional[str] = None
    group: Optional[str] = None

    # Ops runbook (markdown notes for this server; edited by user or agent)
    runbook: str = ""

    # Metadata
    created_at: datetime = field(default_factory=datetime.now)
    last_connected: Optional[datetime] = None

    def to_dict(self) -> dict:
        """Convert to a dictionary."""
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
            "vnc_port": self.vnc_port,
            "vnc_password": self.vnc_password,
            "color": self.color,
            "group": self.group,
            "runbook": self.runbook,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "last_connected": self.last_connected.isoformat() if self.last_connected else None,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SSHConnection":
        """Create from a dictionary."""
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
            vnc_port=data.get("vnc_port", 5901),
            vnc_password=data.get("vnc_password"),
            color=data.get("color"),
            group=data.get("group"),
            runbook=data.get("runbook", ""),
            created_at=datetime.fromisoformat(data["created_at"]) if data.get("created_at") else datetime.now(),
            last_connected=datetime.fromisoformat(data["last_connected"]) if data.get("last_connected") else None,
        )

    @classmethod
    def from_electerm(cls, bookmark: dict) -> "SSHConnection":
        """Create from an electerm bookmark."""
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
