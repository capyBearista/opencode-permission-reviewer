"""Local executable evidence from installed packages through fresh host reviews."""

import json
import os
from pathlib import Path
import subprocess
import urllib.request

import pytest
from test_v2_reviewer import (
    V2_VERSIONS,
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


@pytest.mark.parametrize("version", V2_VERSIONS)
def test_local_executable_evidence_reaches_the_reviewer(
    launch_host, activate_host, model_server, decisions_server, version, tmp_path
):
    binary = os.environ[f"OPENCODE_V2_{version.replace('.', '_')}"]
    package = os.environ.get(
        "PLUGIN_PACKAGE_PATH", str(Path(__file__).resolve().parents[2])
    )
    model = {"name": "Fixture", "limit": {"context": 64000, "output": 1000}}
    decisions_server.set_default_mode("inconclusive")
    package = v2_plugin_package(tmp_path, decisions_server)
    config = {"plugins": [package]}
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
                        **model,
                        "variants": [{"id": "medium", "settings": {}}],
                        "capabilities": {
                            "tools": True,
                            "input": ["text"],
                            "output": ["text"],
                        },
                    }
                },
            }
        }
    }
    reviewer = v2_reviewer_config(
        timeout_ms=15000,
        review_budget_ms=30000,
        reasoning_timeout_ms=15000,
    )
    host = launch_host(binary, config, reviewer=reviewer, global_config=provider)
    activate_host(host)
    project = host["project"]
    (project / "--actual.js").write_text('console.log("ACTUAL_EXECUTED_SENTINEL")')
    (project / "argument.js").write_text('console.log("UNEXECUTED_ARGUMENT_SENTINEL")')
    for name in ("first", "second"):
        (project / name).mkdir()
        (project / name / "task.js").write_text(
            f'console.log("{name.upper()}_EXECUTED_SENTINEL")'
        )
    for args in [
        ["init"],
        ["config", "user.email", "fixture@example.invalid"],
        ["config", "user.name", "Fixture"],
        ["commit", "--allow-empty", "-m", "fixture"],
        ["remote", "add", "origin", "https://local.example.invalid/project.git"],
    ]:
        subprocess.run(["git", *args], cwd=project, check=True, capture_output=True)

    def request(path, body):
        req = urllib.request.Request(
            host["url"] + path,
            data=json.dumps(body).encode(),
            headers={**host["headers"], "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=45) as response:
            value = json.load(response)
            return value.get("data", value)

    for command, included in [
        ("printf node ./argument.js", []),
        ("ssh fixture.invalid node ./argument.js", []),
        ("node --eval=0 ./argument.js", []),
        ("node --conditions ./argument.js ./--actual.js", ["ACTUAL_EXECUTED_SENTINEL"]),
        ("node -- --actual.js ./argument.js", ["ACTUAL_EXECUTED_SENTINEL"]),
        (
            "(cd first && node task.js) && (cd second && node task.js)",
            ["FIRST_EXECUTED_SENTINEL", "SECOND_EXECUTED_SENTINEL"],
        ),
        ("ssh fixture.invalid git push origin", []),
        ("git push origin", ["https://local.example.invalid/project.git"]),
    ]:
        before = len(model_server["calls"])
        decisions_before = len(decisions_server.calls)
        session = request(
            "/api/session",
            {
                "title": "Local evidence fixture",
                "location": {"directory": str(project)},
                "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}],
            },
        )
        request(
            f"/api/session/{session['id']}/permission",
            {
                "action": "shell",
                "resources": [command],
                "metadata": {"command": command},
            },
        )
        assert len(decisions_server.calls) == decisions_before + 1, command
        assert decisions_server.calls[-1]["destination"] == DECISIONS_URLS[0]
        assert decisions_server.calls[-1]["body"]["model"] == "jev-1.13-free"
        calls = [
            call
            for call in model_server["calls"][before:]
            if call.get("model") == "reviewer"
        ]
        assert calls, command
        text = json.dumps(calls[-1]["messages"])
        for expected in included:
            assert expected in text, (command, text)
        for excluded in {
            "ACTUAL_EXECUTED_SENTINEL",
            "UNEXECUTED_ARGUMENT_SENTINEL",
            "FIRST_EXECUTED_SENTINEL",
            "SECOND_EXECUTED_SENTINEL",
            "https://local.example.invalid/project.git",
        } - set(included):
            assert excluded not in text, (command, text)
