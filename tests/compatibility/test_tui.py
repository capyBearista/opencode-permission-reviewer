"""Render the actual CLI plugin in a disposable PTY attached to a fresh host."""

import fcntl
from contextlib import contextmanager, ExitStack
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import termios
import time
from threading import Thread
import urllib.request
import pytest

V2_VERSIONS = (
    [os.environ["V2_HOST_VERSION"]]
    if os.environ.get("V2_HOST_VERSION")
    else ["2.2.0"]
)

from test_v2_reviewer import (
    model_server,
    v2_plugin_package,
)  # noqa: F401
from v2_decisions_fixture import (
    DECISIONS_URLS,
    DecisionsFixtureServer,
    v2_reviewer_config,
)


@pytest.fixture
def decisions_server():
    fixture = DecisionsFixtureServer()
    yield fixture
    fixture.close()


@contextmanager
def terminal(arguments, env):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    proc = subprocess.Popen(
        arguments,
        env={**env, "COLORTERM": "truecolor"},
        stdin=slave,
        stdout=slave,
        stderr=slave,
    )
    os.close(slave)
    output = bytearray()
    stop = False

    def read_terminal():
        while not stop:
            if not select.select([master], [], [], 0.1)[0]:
                continue
            try:
                chunk = os.read(master, 65536)
                if not chunk:
                    return
                output.extend(chunk)
                for query, response in [
                    (b"\x1b[c", b"\x1b[?1;2c"),
                    (b"\x1b[>c", b"\x1b[>0;276;0c"),
                    (b"\x1b[6n", b"\x1b[1;1R"),
                    (b"\x1b[?u", b"\x1b[?0u"),
                ]:
                    if query in chunk:
                        os.write(master, response)
            except OSError:
                return

    reader = Thread(target=read_terminal, daemon=True)
    reader.start()
    try:
        yield output, proc
    finally:
        stop = True
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        reader.join(timeout=1)
        os.close(master)


@pytest.mark.parametrize("version", V2_VERSIONS)
def test_tui_renders_review_state(
    launch_host, activate_host, model_server, decisions_server, version, tmp_path
):
    binary = os.environ[f"OPENCODE_V2_{version.replace('.', '_')}"]
    provider = {
        "providers": {
            "fixture": {
                "package": "@opencode/ai/providers/openai-compatible",
                "settings": {
                    "baseURL": model_server["url"],
                    "apiKey": "synthetic-fixture",
                },
                "models": {
                    "reviewer": {
                        "name": "Fixture reviewer",
                        "variants": [
                            {"id": "max", "settings": {}},
                            {"id": "medium", "settings": {}},
                        ],
                        "capabilities": {
                            "tools": True,
                            "input": ["text"],
                            "output": ["text"],
                        },
                        "limit": {"context": 32000, "output": 1000},
                    }
                },
            }
        }
    }
    decisions_server.set_default_mode("inconclusive")
    package = v2_plugin_package(tmp_path, decisions_server)
    config = {"plugins": [package]}
    reviewer = v2_reviewer_config(
        timeout_ms=10000,
        review_budget_ms=20000,
        reasoning_timeout_ms=10000,
    )
    host = launch_host(binary, config, reviewer=reviewer, global_config=provider)
    activate_host(host)

    def request(path, body=None):
        req = urllib.request.Request(
            host["url"] + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={**host["headers"], "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    session = request(
        "/api/session",
        {
            "title": "Reviewer UI fixture",
            "location": {"directory": str(host["project"])},
            "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}],
        },
    )
    session_id = session.get("data", session)["id"]
    # No cli.json: OpenCode 2.2.0 loads the TUI half from the opencode.json entry.
    arguments = [
        binary,
        "--server",
        host["url"],
        "--session",
        session_id,
        str(host["project"]),
    ]
    with ExitStack() as stack:
        terminals = [
            stack.enter_context(terminal(arguments, host["env"]))
            for _ in range(2)
        ]
        for output, proc in terminals:
            deadline = time.monotonic() + 15
            while (
                time.monotonic() < deadline
                and b"Reviewer UI fixture" not in output
                and proc.poll() is None
            ):
                time.sleep(0.1)
            assert proc.poll() is None, output.decode("utf-8", errors="replace")[-6000:]
        model_server["control"]["delay"] = 1
        outcome = request(
            f"/api/session/{session_id}/permission",
            {
                "action": "shell",
                "resources": ["printf *"],
                "metadata": {"command": "printf harmless"},
            },
        )
        assert outcome["data"]["effect"] == "allow"
        assert len(decisions_server.calls) == 1
        assert decisions_server.calls[0]["destination"] == DECISIONS_URLS[0]
        assert decisions_server.calls[0]["body"]["model"] == "jev-1.13-free"
        time.sleep(1)
        for index, (output, _proc) in enumerate(terminals):
            text = re.sub(
                r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode("utf-8", errors="replace")
            )
            (host["root"] / f"terminal-{index}.txt").write_text(text)
            assert "Reviewing this permission" in text, text[-6000:]
            assert "Review approved" in text, text[-6000:]
