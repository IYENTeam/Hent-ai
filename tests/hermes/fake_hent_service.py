from __future__ import annotations

import json
import threading
from collections.abc import Callable, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Union
from urllib.parse import urlparse

ResponseBody = Union[bytes, dict[str, object]]
HandlerResult = tuple[int, Mapping[str, str], ResponseBody]
RequestHandler = Callable[[str, str, bytes, Mapping[str, str]], HandlerResult]


class FakeHentService:
    def __init__(self, handler: RequestHandler):
        self.handler = handler
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None

    def __enter__(self) -> str:
        handler = self.handler

        class LocalRequestHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                self._handle()

            def do_GET(self) -> None:
                self._handle()

            def log_message(self, format: str, *args: object) -> None:
                return

            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                request_body = self.rfile.read(length) if length else b""
                parsed = urlparse(self.path)
                status, response_headers, response_body = handler(
                    self.command,
                    parsed.path,
                    request_body,
                    {key: value for key, value in self.headers.items()},
                )
                if isinstance(response_body, dict):
                    response_body = json.dumps(response_body).encode("utf-8")
                self.send_response(status)
                for name, value in response_headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(response_body)))
                self.end_headers()
                self.wfile.write(response_body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), LocalRequestHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        address = self.server.server_address
        if not isinstance(address, tuple) or len(address) < 2:
            raise RuntimeError("fake service did not bind to a TCP address")
        host, port = str(address[0]), int(address[1])
        return f"http://{host}:{port}"

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        assert self.server is not None
        assert self.thread is not None
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
