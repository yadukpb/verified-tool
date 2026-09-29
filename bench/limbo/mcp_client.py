"""A minimal MCP client over stdio (newline-delimited JSON-RPC), stdlib only."""

from __future__ import annotations

import json
import queue
import subprocess
import threading
from typing import Any


class McpError(RuntimeError):
    pass


class McpClient:
    def __init__(self, cmd: list[str], env: dict[str, str], cwd: str, stderr_path: str | None = None) -> None:
        self._stderr = open(stderr_path, "w") if stderr_path else subprocess.DEVNULL
        self.proc = subprocess.Popen(
            cmd, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._stderr,
            text=True, bufsize=1,
        )
        self._lines: queue.Queue[str | None] = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()
        self._next = 0
        self.request("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "limbo-verified-tool", "version": "1.0"},
        })
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self._lines.put(line)
        self._lines.put(None)

    def _send(self, msg: dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def request(self, method: str, params: dict[str, Any], timeout: float = 120.0) -> dict[str, Any]:
        self._next += 1
        msg_id = self._next
        self._send({"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params})
        while True:
            try:
                line = self._lines.get(timeout=timeout)
            except queue.Empty:
                raise McpError(f"{method}: no response within {timeout}s") from None
            if line is None:
                raise McpError(f"{method}: gateway exited (code {self.proc.poll()})")
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)
            if msg.get("id") != msg_id:
                continue  # notifications, or replies to someone else
            if "error" in msg:
                raise McpError(f"{method}: {msg['error']}")
            return msg["result"]

    def list_tools(self) -> list[dict[str, Any]]:
        tools: list[dict[str, Any]] = []
        cursor = None
        while True:
            page = self.request("tools/list", {"cursor": cursor} if cursor else {})
            tools.extend(page["tools"])
            cursor = page.get("nextCursor")
            if not cursor:
                return tools

    def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return self.request("tools/call", {"name": name, "arguments": arguments})

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
            self.proc.wait()
        if self.proc.stdout:
            self.proc.stdout.close()
        if self._stderr is not subprocess.DEVNULL:
            self._stderr.close()
