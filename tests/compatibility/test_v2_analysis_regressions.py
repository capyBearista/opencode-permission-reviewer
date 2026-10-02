import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

import pytest

from test_v2_reviewer import V2_VERSIONS, model_server


@pytest.mark.parametrize("host_version", V2_VERSIONS)
def test_current_bundle_regressions(launch_host, activate_host, model_server, host_version):
    package = str(Path(__file__).resolve().parents[2])
    provider = {"providers": {"fixture": {
        "package": "@opencode/ai/providers/openai-compatible",
        "settings": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
        "models": {"reviewer": {"name": "Fixture reviewer",
            "variants": [{"id": "max", "settings": {}}, {"id": "medium", "settings": {}}],
            "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
            "limit": {"context": 32000, "output": 1000}}},
    }}}
    binary = os.environ[f"OPENCODE_V2_{host_version.replace('.', '_')}"]
    package = os.environ.get("PLUGIN_PACKAGE_PATH", package)
    host = launch_host("v2", binary, {"plugins": [package]},
        reviewer={"model": "fixture/reviewer", "timeoutMs": 5000, "reviewBudgetMs": 15000},
        global_config=provider)
    activate_host(host, "v2")
    for args in [["init"], ["config", "user.email", "fixture@example.invalid"],
                 ["config", "user.name", "Fixture"], ["commit", "--allow-empty", "-m", "fixture"],
                 ["remote", "add", "origin", "https://original.example.invalid/repo.git"]]:
        subprocess.run(["git", *args], cwd=host["project"], check=True, capture_output=True)

    def request(path, body):
        req = urllib.request.Request(host["url"] + path, data=json.dumps(body).encode(),
            headers={**host["headers"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)["data"]

    for command, expected in [
        ("bash -ce 'rm -rf /'", "brake"),
        ("env --unset FIXTURE_VAR -S 'rm -rf /'", "brake"),
        ("cp --target-directory /etc ./fixture.txt", "external"),
        ("cp -at /etc ./fixture.txt", "external"),
        ("mv -Z /etc/fixture.txt ./fixture.txt", "external"),
        ("rename old new /etc/old ./old", "external"),
        ("cd elsewhere; cd sub && python fixture.py", "unresolved"),
        ("git push --repo=https://override.example.invalid/repo.git main", "override"),
    ]:
        before = len(model_server["calls"])
        session = request("/api/session", {"title": "Regression fixture",
            "location": {"directory": str(host["project"])},
            "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]})
        result = request(f"/api/session/{session['id']}/permission", {
            "action": "shell", "resources": [command], "metadata": {"command": command}})
        if expected == "brake":
            assert result["effect"] == "deny"
            assert len(model_server["calls"]) == before
            continue
        assert len(model_server["calls"]) > before, result
        text = "\n".join(
            message["content"] if isinstance(message.get("content"), str)
            else "\n".join(part.get("text", "") for part in message.get("content", []) if isinstance(part, dict))
            for message in model_server["calls"][-1]["messages"])
        if expected == "external":
            assert '"externalWrite":true' in re.sub(r"\s+", "", text), text
        if expected == "unresolved":
            assert "working directory" in text and "unresolved" in text, text
        if expected == "override":
            assert '"input": "https://override.example.invalid/repo.git"' in text, text
