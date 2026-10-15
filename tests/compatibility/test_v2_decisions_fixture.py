import json
import subprocess

import pytest
from v2_decisions_fixture import (
    DECISIONS_URLS,
    SYSTEM_ONE_QUESTION_NAMES,
    DecisionsFixtureServer,
    create_plugin_wrapper,
    decisions_response,
    v2_reviewer_config,
)


CHOICES = {
    "outcome": ["allow", "deny", "escalate"],
    "risk_level": ["low", "medium", "high", "critical"],
    "user_authorization": ["high", "medium", "low", "unknown"],
    "scope_alignment": ["aligned", "partial", "misaligned", "unknown"],
    "evidence_completeness": ["sufficient", "partial", "insufficient", "unknown"],
    "primary_basis": [
        "authorized_routine",
        "authorized_reversible_change",
        "insufficient_authorization",
        "scope_mismatch",
        "insufficient_evidence",
        "destructive_effect",
        "credential_or_private_data",
        "security_or_privilege_change",
        "external_or_remote_effect",
        "trusted_policy_restriction",
        "conflicting_evidence",
    ],
}
NOULS = {
    "material_authorization",
    "within_intent_scope",
    "unauthorized_data_loss",
    "untrusted_sensitive_disclosure",
    "excessive_credential_access",
    "unauthorized_security_change",
    "unauthorized_external_mutation",
    "essential_evidence_missing",
    "absolute_policy_deny",
}


def system_one_questions():
    questions = {
        name: (
            {"type": "noul"}
            if name in NOULS
            else {
                "type": "choice",
                "criteria": {choice: "fixture" for choice in CHOICES[name]},
            }
        )
        for name in SYSTEM_ONE_QUESTION_NAMES
    }
    assert len(questions) == 15
    return questions


def test_decision_responses_match_native_questions_and_support_policy_reasoning():
    questions = system_one_questions()
    assert set(questions) == set(SYSTEM_ONE_QUESTION_NAMES)

    allow = decisions_response(questions, "allow")
    assert allow["model"] == "jev-1.13-free"
    assert set(allow["answers"]) == set(questions)
    assert allow["answers"]["outcome"]["choice"] == "allow"
    assert allow["answers"]["evidence_completeness"]["choice"] == "sufficient"

    inconclusive = decisions_response(questions, "inconclusive")
    assert inconclusive["model"] == "jev-1.13-free"
    assert inconclusive["answers"]["outcome"]["choice"] == "allow"
    assert inconclusive["answers"]["outcome"]["confidence"] < 0.7
    assert inconclusive["answers"]["evidence_completeness"]["choice"] == "partial"
    assert decisions_response(questions, "invalid")["answers"] == {}


def test_v2_config_selects_decisions_and_reasoning_models_without_legacy_model():
    config = v2_reviewer_config(
        output_format="text",
        decision_models=["opencode/jev-1.13-free"],
        reasoning_timeout_ms=12000,
    )
    assert config["decisionModels"] == ["opencode/jev-1.13-free"]
    assert config["reasoningModels"] == [
        {
            "model": "fixture/reviewer",
            "variant": "medium",
            "outputFormat": "text",
            "timeoutMs": 12000,
        }
    ]
    assert config["decisionMaxAttempts"] == 2
    assert config["decisionAttemptTimeoutMs"] == 5000
    assert "model" not in config
    assert v2_reviewer_config(decision_models=[])["decisionModels"] == []


def test_v2_plugin_package_path_is_json_serializable_for_host_config(
    tmp_path, monkeypatch
):
    from test_v2_reviewer import v2_plugin_package

    package_root = tmp_path / "built-package"
    (package_root / "dist" / "tui").mkdir(parents=True)
    (package_root / "dist" / "index.js").write_text(
        'export default { id: "actual", async setup() {} };', encoding="utf-8"
    )
    (package_root / "dist" / "tui" / "tui.tsx").write_text(
        "export default {};", encoding="utf-8"
    )
    monkeypatch.setenv("PLUGIN_PACKAGE_PATH", str(package_root))
    fixture = DecisionsFixtureServer()
    try:
        plugin = v2_plugin_package(tmp_path, fixture)
        encoded = json.dumps({"plugins": [plugin]})
        assert json.loads(encoded) == {"plugins": [plugin]}
        assert isinstance(plugin, str)
    finally:
        fixture.close()


def test_fixture_server_returns_only_scripted_local_decision_responses():
    fixture = DecisionsFixtureServer()
    try:
        fixture.enqueue_http_error(
            503, {"error": {"message": "synthetic fixture unavailable"}}
        )
        response = fixture.request_for_test(
            {
                "destination": DECISIONS_URLS[0],
                "method": "POST",
                "body": json.dumps(
                    {"model": "jev-1.13-free", "questions": system_one_questions()}
                ),
            }
        )
        assert response["status"] == 503
        assert "synthetic fixture unavailable" in response["body"]
        assert fixture.calls[0]["destination"] == DECISIONS_URLS[0]
        assert fixture.calls[0]["body"]["model"] == "jev-1.13-free"
        assert "authorization" not in fixture.calls[0]
        rejected = fixture.request_for_test(
            {
                "destination": "https://example.invalid/not-a-decisions-route",
                "method": "POST",
                "body": json.dumps(
                    {"model": "jev-1.13-free", "questions": system_one_questions()}
                ),
            }
        )
        assert rejected["status"] == 400
        assert len(fixture.calls) == 1
    finally:
        fixture.close()


def test_wrapper_intercepts_only_fixed_decisions_urls_and_restores_fetch(tmp_path):
    package = tmp_path / "built-package"
    dist = package / "dist"
    dist.mkdir(parents=True)
    (dist / "tui").mkdir()
    (dist / "tui" / "tui.tsx").write_text(
        "export default { slots: {} };", encoding="utf-8"
    )
    (dist / "index.js").write_text(
        """
export default {
  id: "actual-built-plugin",
  async setup() {
    for (const url of [
      "https://opencode.ai/zen/v1/systemone",
      "https://openrouter.ai/api/alpha/decisions",
    ]) {
      const response = await fetch(url, { method: "POST", headers: { "x-test": "fixture" }, body: "{}", redirect: "error" });
      await response.text();
    }
    await fetch("http://127.0.0.1:45000/host", { method: "GET" });
    return async () => {};
  },
};
""",
        encoding="utf-8",
    )
    fixture_url = "http://127.0.0.1:45001/intercept"
    with pytest.raises(ValueError, match="127.0.0.1"):
        create_plugin_wrapper(tmp_path, package, "http://example.invalid/intercept")
    wrapper = create_plugin_wrapper(tmp_path, package, fixture_url)
    script = f"""
const fixtureURL = {json.dumps(fixture_url)};
const calls = [];
const original = async (input, init) => {{
  const url = String(input);
  calls.push({{ url, method: init?.method, body: init?.body }});
  if (url === fixtureURL) {{
    const payload = JSON.parse(init.body);
    return Response.json({{ status: 200, body: JSON.stringify({{ destination: payload.destination }}), headers: {{}} }});
  }}
  return new Response("host passthrough", {{ status: 200 }});
}};
globalThis.fetch = original;
const {{ default: plugin }} = await import({json.dumps((wrapper / "index.js").as_uri())});
if (plugin.id !== "actual-built-plugin") throw new Error("wrapper replaced the actual plugin identity");
const cleanup = await plugin.setup({{}});
const patched = globalThis.fetch !== original;
await cleanup();
console.log(JSON.stringify({{ calls, patched, restored: globalThis.fetch === original }}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    output = json.loads(result.stdout)
    assert output["patched"] and output["restored"]
    assert [call["url"] for call in output["calls"]] == [
        fixture_url,
        fixture_url,
        "http://127.0.0.1:45000/host",
    ]
    relay_payloads = [json.loads(call["body"]) for call in output["calls"][:2]]
    assert [payload["destination"] for payload in relay_payloads] == list(
        DECISIONS_URLS
    )
    assert all(payload["redirect"] == "error" for payload in relay_payloads)


def test_wrapper_preserves_the_built_tui_entrypoint(tmp_path):
    package = tmp_path / "built-package"
    tui = package / "dist" / "tui" / "tui.tsx"
    tui.parent.mkdir(parents=True)
    (package / "dist" / "index.js").write_text(
        'export default { id: "actual", async setup() {} };', encoding="utf-8"
    )
    tui.write_text("export default { slots: {} };", encoding="utf-8")
    wrapper = create_plugin_wrapper(
        tmp_path, package, "http://127.0.0.1:45003/intercept"
    )

    metadata = json.loads((wrapper / "package.json").read_text())
    assert metadata["exports"]["./tui"] == "./tui.tsx"
    assert (wrapper / "tui.tsx").read_text().strip() == (
        f'export {{ default }} from "{tui.as_uri()}";'
    )


def test_wrapper_fixture_failure_cannot_fall_through_to_a_provider(tmp_path):
    package = tmp_path / "built-package"
    dist = package / "dist"
    dist.mkdir(parents=True)
    (dist / "tui").mkdir()
    (dist / "tui" / "tui.tsx").write_text(
        "export default { slots: {} };", encoding="utf-8"
    )
    (dist / "index.js").write_text(
        'export default { id: "actual", async setup() {} };', encoding="utf-8"
    )
    fixture_url = "http://127.0.0.1:45002/intercept"
    wrapper = create_plugin_wrapper(tmp_path, package, fixture_url)
    script = f"""
const fixtureURL = {json.dumps(fixture_url)};
const calls = [];
const original = async input => {{ calls.push(String(input)); throw new Error("fixture offline"); }};
globalThis.fetch = original;
const {{ default: plugin }} = await import({json.dumps((wrapper / "index.js").as_uri())});
const cleanup = await plugin.setup({{}});
try {{ await globalThis.fetch({json.dumps(DECISIONS_URLS[0])}, {{ method: "POST", body: "{{}}" }}); }}
catch (error) {{ if (error.message !== "fixture offline") throw error; }}
await cleanup();
console.log(JSON.stringify({{ calls }}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(result.stdout)["calls"] == [fixture_url]
