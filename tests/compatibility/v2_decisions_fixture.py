"""Test-only V2 Decisions fixtures and a fixed-destination fetch interposer."""

from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time
import urllib.parse
import urllib.request


DECISIONS_URLS = (
    "https://opencode.ai/zen/v1/systemone",
    "https://openrouter.ai/api/alpha/decisions",
)
ZEN_MODEL = "jev-1.13-free"
SYSTEM_ONE_QUESTION_NAMES = (
    "outcome",
    "risk_level",
    "user_authorization",
    "scope_alignment",
    "evidence_completeness",
    "primary_basis",
    "material_authorization",
    "within_intent_scope",
    "unauthorized_data_loss",
    "untrusted_sensitive_disclosure",
    "excessive_credential_access",
    "unauthorized_security_change",
    "unauthorized_external_mutation",
    "essential_evidence_missing",
    "absolute_policy_deny",
)
_REASONING_MODEL = {
    "model": "fixture/reviewer",
    "variant": "medium",
    "outputFormat": "json_schema",
    "timeoutMs": 5000,
}


def v2_reviewer_config(
    *,
    output_format="json_schema",
    reasoning_timeout_ms=5000,
    decision_models=None,
    decision_max_attempts=2,
    decision_attempt_timeout_ms=5000,
    timeout_ms=5000,
    review_budget_ms=15000,
    **overrides,
):
    """Build the trusted V2 host config; never select a route via legacy `model`."""
    return {
        "decisionModels": list(
            ["opencode/jev-1.13-free"] if decision_models is None else decision_models
        ),
        "reasoningModels": [
            {
                **_REASONING_MODEL,
                "outputFormat": output_format,
                "timeoutMs": reasoning_timeout_ms,
            }
        ],
        "decisionMaxAttempts": decision_max_attempts,
        "decisionAttemptTimeoutMs": decision_attempt_timeout_ms,
        "timeoutMs": timeout_ms,
        "reviewBudgetMs": review_budget_ms,
        **overrides,
    }


def decisions_response(questions, mode="allow"):
    """Answer the exact question object sent by the built Decisions transport."""
    if not isinstance(questions, dict) or set(questions) != set(
        SYSTEM_ONE_QUESTION_NAMES
    ):
        raise ValueError("fixture requires the exact 15 native System One questions")
    if mode == "invalid":
        return {
            "model": ZEN_MODEL,
            "usage": {"input_tokens": 1, "output_tokens": 0},
            "answers": {},
        }
    if mode not in {"allow", "deny", "inconclusive"}:
        raise ValueError(f"unsupported fixture decision mode: {mode}")

    selected = {
        "outcome": "deny" if mode == "deny" else "allow",
        "risk_level": "high" if mode == "deny" else "low",
        "user_authorization": "low" if mode == "deny" else "high",
        "scope_alignment": "misaligned" if mode == "deny" else "aligned",
        "evidence_completeness": (
            "partial" if mode == "inconclusive" else "sufficient"
        ),
        "primary_basis": "destructive_effect"
        if mode == "deny"
        else "authorized_routine",
    }
    answers = {}
    for name, question in questions.items():
        if question.get("type") == "noul":
            answers[name] = {
                "type": "noul",
                "noul": 1
                if name in {"material_authorization", "within_intent_scope"}
                and mode != "deny"
                else 0,
            }
            continue
        if question.get("type") != "choice" or not isinstance(
            question.get("criteria"), dict
        ):
            raise ValueError(f"fixture received an unknown question shape: {name}")
        choices = list(question["criteria"])
        choice = selected[name]
        if choice not in choices:
            raise ValueError(
                f"fixture answer is not allowed for native question: {name}"
            )
        if mode == "inconclusive" and name == "outcome":
            probabilities = {
                item: {"allow": 0.55, "deny": 0.35, "escalate": 0.1}[item]
                for item in choices
            }
        else:
            probabilities = {item: 1.0 if item == choice else 0.0 for item in choices}
        answers[name] = {
            "type": "choice",
            "choice": choice,
            "confidence": 0.6 if mode == "inconclusive" and name == "outcome" else 1.0,
            "probabilities": probabilities,
        }
    return {
        "model": ZEN_MODEL,
        "usage": {"input_tokens": 1, "output_tokens": 1},
        "answers": answers,
    }


def _fixture_url(value):
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or parsed.port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/")
    ):
        raise ValueError(
            "Decisions fixture endpoint must be an explicit local 127.0.0.1 HTTP URL"
        )
    return value


def _wrapper_source(actual_entrypoint, fixture_url):
    route_table = json.dumps(dict.fromkeys(DECISIONS_URLS, fixture_url))
    actual_url = json.dumps(actual_entrypoint.as_uri())
    return f"""import actualPlugin from {actual_url};

const ROUTES = new Map(Object.entries({route_table}));
if (!actualPlugin || typeof actualPlugin.setup !== "function")
  throw new Error("Built permission reviewer entrypoint has no V2 setup function");

async function setup(...args) {{
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") throw new Error("Host fetch is unavailable");

  const isolatedFetch = async (input, init) => {{
    const requestedURL = input instanceof Request ? input.url : String(input);
    const fixtureURL = ROUTES.get(requestedURL);
    if (fixtureURL === undefined) return originalFetch.call(globalThis, input, init);

    const request = new Request(input, init);
    const relay = await originalFetch.call(globalThis, fixtureURL, {{
      method: "POST",
      headers: {{ "content-type": "application/json" }},
      body: JSON.stringify({{
        destination: requestedURL,
        method: request.method,
        headers: {{
          authorizationPresent: request.headers.has("authorization"),
          contentType: request.headers.get("content-type"),
          opencodeClient: request.headers.get("x-opencode-client"),
        }},
        redirect: init?.redirect ?? "follow",
        body: await request.clone().text(),
      }}),
      redirect: "error",
      signal: init?.signal ?? request.signal,
    }});
    const envelope = await relay.json();
    if (!Number.isInteger(envelope?.status) || typeof envelope.body !== "string")
      throw new Error("Local Decisions fixture returned an invalid response envelope");
    return new Response(envelope.body, {{
      status: envelope.status,
      headers: envelope.headers ?? {{ "content-type": "application/json" }},
    }});
  }};

  globalThis.fetch = isolatedFetch;
  let dispose;
  try {{
    dispose = await actualPlugin.setup(...args);
  }} catch (error) {{
    if (globalThis.fetch === isolatedFetch) globalThis.fetch = originalFetch;
    throw error;
  }}

  let disposed = false;
  return async (...disposeArgs) => {{
    if (disposed) return;
    disposed = true;
    try {{
      if (typeof dispose === "function") await dispose(...disposeArgs);
    }} finally {{
      if (globalThis.fetch === isolatedFetch) globalThis.fetch = originalFetch;
    }}
  }};
}}

export default {{ ...actualPlugin, setup }};
"""


def create_plugin_wrapper(tmp_path, package_root, fixture_url):
    """Create a V2 host package that loads the built package and only relays fixed URLs."""
    fixture_url = _fixture_url(fixture_url)
    package_root = Path(package_root).resolve()
    actual_entrypoint = package_root / "dist" / "index.js"
    actual_tui_entrypoint = package_root / "dist" / "tui" / "tui.tsx"
    if not actual_entrypoint.is_file():
        raise FileNotFoundError(
            f"built package entrypoint is missing: {actual_entrypoint}"
        )
    if not actual_tui_entrypoint.is_file():
        raise FileNotFoundError(
            f"built package TUI entrypoint is missing: {actual_tui_entrypoint}"
        )
    wrapper = Path(tmp_path) / "v2-decisions-fixture-plugin"
    wrapper.mkdir()
    (wrapper / "package.json").write_text(
        json.dumps(
            {
                "name": "permission-reviewer-v2-decisions-fixture",
                "version": "1.0.0",
                "type": "module",
                "main": "./index.js",
                "exports": {
                    ".": "./index.js",
                    "./server": "./index.js",
                    "./tui": "./tui.tsx",
                    "./package.json": "./package.json",
                },
            }
        ),
        encoding="utf-8",
    )
    (wrapper / "index.js").write_text(
        _wrapper_source(actual_entrypoint, fixture_url), encoding="utf-8"
    )
    (wrapper / "tui.tsx").write_text(
        f'export {{ default }} from "{actual_tui_entrypoint.as_uri()}";',
        encoding="utf-8",
    )
    return wrapper


class DecisionsFixtureServer:
    """Loopback-only deterministic response server used by the test plugin wrapper."""

    def __init__(self):
        self._lock = threading.Lock()
        self._responses = deque()
        self._calls = []
        self._errors = []
        self._default_mode = "allow"
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                try:
                    payload = json.loads(
                        self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    )
                    native_body = json.loads(payload.get("body", ""))
                    destination = payload.get("destination")
                    valid = (
                        self.path == "/intercept"
                        and payload.get("method") == "POST"
                        and destination in DECISIONS_URLS
                        and isinstance(native_body, dict)
                        and native_body.get("model")
                    )
                    if not valid:
                        raise ValueError(
                            "fixture accepts only fixed native Decisions requests"
                        )
                    call = {
                        "destination": destination,
                        "body": native_body,
                        "authorizationPresent": payload.get("headers", {}).get(
                            "authorizationPresent", False
                        ),
                    }
                    with owner._lock:
                        owner._calls.append(call)
                        plan = (
                            owner._responses.popleft()
                            if owner._responses
                            else {
                                "mode": owner._default_mode,
                                "status": 200,
                                "delay": 0,
                            }
                        )
                    if plan["delay"]:
                        time.sleep(plan["delay"])
                    if plan["status"] == 200:
                        response_body = plan.get("body")
                        if response_body is None:
                            response_body = decisions_response(
                                native_body.get("questions"), plan["mode"]
                            )
                        encoded = json.dumps(response_body)
                    else:
                        response_body = plan.get(
                            "body",
                            {"error": {"message": "synthetic fixture HTTP error"}},
                        )
                        encoded = (
                            response_body
                            if isinstance(response_body, str)
                            else json.dumps(response_body)
                        )
                    envelope = {
                        "status": plan["status"],
                        "body": encoded,
                        "headers": {"content-type": "application/json"},
                    }
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header(
                        "Content-Length", str(len(json.dumps(envelope).encode()))
                    )
                    self.end_headers()
                    self.wfile.write(json.dumps(envelope).encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except Exception as error:
                    with owner._lock:
                        owner._errors.append(str(error))
                    encoded = json.dumps(
                        {
                            "status": 400,
                            "body": json.dumps(
                                {
                                    "error": {
                                        "message": "synthetic fixture rejected request"
                                    }
                                }
                            ),
                            "headers": {"content-type": "application/json"},
                        }
                    ).encode()
                    try:
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(encoded)))
                        self.end_headers()
                        self.wfile.write(encoded)
                    except (BrokenPipeError, ConnectionResetError):
                        pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_port}/intercept"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def calls(self):
        with self._lock:
            return list(self._calls)

    @property
    def errors(self):
        with self._lock:
            return list(self._errors)

    def enqueue(self, mode="allow", *, delay=0):
        if mode not in {"allow", "deny", "inconclusive", "invalid"}:
            raise ValueError(f"unsupported fixture decision mode: {mode}")
        with self._lock:
            self._responses.append({"mode": mode, "status": 200, "delay": delay})

    def set_default_mode(self, mode):
        if mode not in {"allow", "deny", "inconclusive", "invalid"}:
            raise ValueError(f"unsupported fixture decision mode: {mode}")
        with self._lock:
            self._default_mode = mode

    def enqueue_http_error(self, status, body=None):
        if not 400 <= status <= 599:
            raise ValueError("fixture HTTP error status must be between 400 and 599")
        with self._lock:
            self._responses.append(
                {
                    "mode": "allow",
                    "status": status,
                    "delay": 0,
                    **({"body": body} if body is not None else {}),
                }
            )

    def request_for_test(self, payload):
        request = urllib.request.Request(
            self.url,
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def close(self):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)
