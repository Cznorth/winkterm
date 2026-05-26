"""VNC module: VNC over SSH tunnel via WebSocket."""

from backend.vnc.proxy import VNCProxy, VNCProxyError
from backend.vnc.handler import VNCWSHandler

__all__ = ["VNCProxy", "VNCProxyError", "VNCWSHandler"]
