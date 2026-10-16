"""Rehearse migration and rollback in one disposable profile without rewriting history."""

import json
import os
from pathlib import Path
import time
import urllib.parse
import urllib.request

import pytest
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
    fixture.set_default_mode("inconclusive")
    yield fixture
    fixture.close()


def test_profile_rollback_preserves_config_sessions_and_audit(
    launch_host, activate_host, model_server, request, tmp_path
):
    package = os.environ.get(
        "PLUGIN_PACKAGE_PATH", str(Path(__file__).resolve().parents[2])
    )
    v1 = os.environ["OPENCODE_V1_1_18_32"]
    v2 = os.environ["OPENCODE_V2_2_0_3"]
    config_v1 = {
        "plugin": [[package, {"model": "fixture/reviewer"}]],
        "permission": {"bash": "ask"},
    }
    provider_v1 = {
        "provider": {
            "fixture": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Fixture",
                "options": {
                    "baseURL": model_server["url"],
                    "apiKey": "synthetic-fixture",
                },
                "models": {
                    name: {"name": name, "limit": {"context": 32000, "output": 1000}}
                    for name in ["reviewer", "driver"]
                },
            }
        }
    }
    provider_v2 = {
        "providers": {
            "fixture": {
                "package": "@opencode/ai/providers/openai-compatible",
                "settings": {
                    "baseURL": model_server["url"],
                    "apiKey": "synthetic-fixture",
                },
                "models": {
                    "reviewer": {
                        "name": "Reviewer",
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
    settings = {"model": "fixture/reviewer", "timeoutMs": 10000}
    pytest_request = request

    def request(host, generation, path, body=None):
        query = (
            "?" + urllib.parse.urlencode({"directory": str(host["project"])})
            if generation == "v1"
            else ""
        )
        req = urllib.request.Request(
            host["url"] + path + query,
            data=None if body is None else json.dumps(body).encode(),
            headers={**host["headers"], "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=40) as response:
            return json.load(response)

    original = launch_host(
        "v1",
        v1,
        config_v1,
        reviewer=settings,
        global_config=provider_v1,
        profile="rollback",
    )
    activate_host(original, "v1")
    session = request(
        original, "v1", "/session", {"title": "Preserved rollback session"}
    )
    project_config = original["project"] / "opencode.json"
    global_config = original["root"] / "config" / "opencode" / "opencode.json"
    backups = {path: path.read_bytes() for path in [project_config, global_config]}
    for path, content in backups.items():
        path.with_suffix(".json.rollback-backup").write_bytes(content)
    audit = original["root"] / "reviewer-audit.jsonl"
    historical = (
        json.dumps(
            {
                "schemaVersion": 2,
                "requestID": "fixture_history",
                "sessionID": "fixture_history",
                "permission": "bash",
                "outcome": "allow",
                "reason": "Preserved synthetic history",
                "timestamp": "2026-01-01T00:00:00.000Z",
                "durationMs": 1,
            }
        )
        + "\n"
    )
    audit.write_text(historical)
    original["stop"]()

    decisions = pytest_request.getfixturevalue("decisions_server")
    decisions.set_default_mode("inconclusive")
    v2_package = v2_plugin_package(tmp_path, decisions)
    migrated = launch_host(
        "v2",
        v2,
        {"plugins": [v2_package]},
        reviewer=v2_reviewer_config(
            timeout_ms=10000,
            review_budget_ms=20000,
            reasoning_timeout_ms=10000,
        ),
        global_config=provider_v2,
        profile="rollback",
    )
    activate_host(migrated, "v2")
    operation = request(
        migrated,
        "v2",
        "/api/session",
        {
            "title": "Migration check",
            "location": {"directory": str(migrated["project"])},
            "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}],
        },
    )["data"]
    result = request(
        migrated,
        "v2",
        f"/api/session/{operation['id']}/permission",
        {
            "action": "shell",
            "resources": ["printf *"],
            "metadata": {"command": "printf safe"},
        },
    )
    assert result["data"]["effect"] == "allow"
    assert len(decisions.calls) == 1
    assert decisions.calls[0]["destination"] == DECISIONS_URLS[0]
    assert decisions.calls[0]["body"]["model"] == "jev-1.13-free"
    v2_record = None
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        v2_record = next(
            (
                json.loads(line)
                for line in audit.read_text().splitlines()
                if json.loads(line).get("sessionID") == operation["id"]
            ),
            None,
        )
        if v2_record:
            break
        time.sleep(0.02)
    assert v2_record
    assert v2_record["decisionAttempts"][0]["model"] == "opencode/jev-1.13-free"
    assert v2_record["decisionAttempts"][0]["requestSent"] is True
    assert v2_record["decisionAttempts"][0]["responseModel"] == "jev-1.13-free"
    assert v2_record["reviewerModel"] == "fixture/reviewer"
    assert v2_record["responseModel"] == "jev-1.13-free"
    migrated["stop"]()

    for path, content in backups.items():
        path.write_bytes(content)
    restored = launch_host("v1", v1, None, reviewer=settings, profile="rollback")
    for path, content in backups.items():
        assert path.read_bytes() == content
        assert path.with_suffix(".json.rollback-backup").read_bytes() == content
    assert (
        request(restored, "v1", f"/session/{session['id']}")["title"]
        == "Preserved rollback session"
    )
    request(
        restored,
        "v1",
        f"/session/{session['id']}/message",
        {
            "model": {"providerID": "fixture", "modelID": "driver"},
            "parts": [
                {"type": "text", "text": "Print the fixture marker with bash once"}
            ],
        },
    )
    messages = request(restored, "v1", f"/session/{session['id']}/message")
    assert any(
        part.get("state", {}).get("status") == "completed"
        and "COMPATIBILITY_EXECUTED" in part.get("state", {}).get("output", "")
        for message in messages
        for part in message.get("parts", [])
    )
    assert audit.read_text().startswith(historical)
    records = [json.loads(line) for line in audit.read_text().splitlines()]
    assert {record.get("hostGeneration") for record in records} >= {"v1", "v2"}
