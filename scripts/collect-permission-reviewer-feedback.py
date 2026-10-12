#!/usr/bin/env python3
"""Create a shareable, allowlisted summary of permission-reviewer audit records.

Does not export commands, paths, original session IDs, prompts, rationales, or
raw error strings. Inspect the output before sharing it.
"""
import argparse
from collections import Counter, deque
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path


def session_key(value):
    if not isinstance(value, str) or not value:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def summarize(record):
    warnings = record.get("warnings")
    warnings = warnings if isinstance(warnings, list) else []
    actor = record.get("actor") if isinstance(record.get("actor"), dict) else {}
    from_model = record.get("reviewerEscalatedFrom")
    from_model = from_model if isinstance(from_model, dict) else {}
    return {
        "timestamp": record.get("timestamp"),
        "reviewKey": session_key(record.get("reviewID")),
        "sessionKey": session_key(record.get("sessionID")),
        "hostVersion": record.get("hostVersion"),
        "pluginVersion": record.get("pluginVersion"),
        "configHashPrefix": str(record.get("effectiveConfigHash", ""))[:12],
        "nativeAction": record.get("nativeAction"),
        "outcome": record.get("outcome"),
        "decisionSource": record.get("decisionSource"),
        "application": record.get("application"),
        "reviewerModel": record.get("reviewerModel"),
        "escalatedFrom": from_model.get("model"),
        "confidence": record.get("confidence"),
        "riskLevel": record.get("riskLevel"),
        "evidenceCompleteness": record.get("evidenceCompleteness"),
        "delegationDepth": actor.get("delegationDepth"),
        "missingDelegationTask": any(
            "no delegation task located" in str(warning) for warning in warnings
        ),
        "otherWarningCount": sum(
            "no delegation task located" not in str(warning) for warning in warnings
        ),
        "durationMs": record.get("durationMs"),
        "reviewerMs": (record.get("timings") or {}).get("reviewerMs")
        if isinstance(record.get("timings"), dict) else None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input", type=Path,
        default=Path.home() / ".local/share/opencode/permission-reviewer-audit.jsonl",
        help="Path to the local JSONL audit file",
    )
    parser.add_argument(
        "--output", type=Path,
        default=Path("permission-reviewer-phase1-feedback.json"),
        help="Destination for sanitized JSON (default: working directory)",
    )
    parser.add_argument("--last", type=int, default=100, help="Recent records (1–1000)")
    args = parser.parse_args()
    if not 1 <= args.last <= 1000:
        parser.error("--last must be between 1 and 1000")
    entries = deque(maxlen=args.last)
    invalid = 0
    with args.input.expanduser().open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                invalid += 1
                continue
            if not isinstance(item, dict):
                invalid += 1
                continue
            entries.append(summarize(item))
    rows = list(entries)
    delegated = [row for row in rows if (row["delegationDepth"] or 0) > 0]
    summary = {
        "records": len(rows),
        "invalidLinesSkipped": invalid,
        "outcomes": dict(Counter(row["outcome"] for row in rows)),
        "reviewerModels": dict(Counter(row["reviewerModel"] for row in rows)),
        "delegatedReviews": len(delegated),
        "delegatedMissingTask": sum(row["missingDelegationTask"] for row in delegated),
        "delegatedToReasoningReviewer": sum(bool(row["escalatedFrom"]) for row in delegated),
        "failureSafeReviews": sum(row["decisionSource"] == "failure-safe" for row in rows),
    }
    output = {
        "format": "permission-reviewer-phase1-feedback-v1",
        "generatedUtc": datetime.now(timezone.utc).isoformat(),
        "summary": summary,
        "records": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Created {args.output.resolve()} ({len(rows)} records). Review before sharing.")


if __name__ == "__main__":
    main()
