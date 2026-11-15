"""Scan first-party tracked text, including dist, without printing credentials.

This is not a history/deployment/secret-store audit. Exit nonzero on privileged
JWTs, sb_secret credentials, private-key headers or browser privileged-env use.
"""
from pathlib import Path
import base64
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
paths = subprocess.check_output(
    ["git", "-C", str(ROOT), "ls-files", "-z"], text=True
).split("\0")
findings = []
scanned = 0
browser_scanned = 0
public_jwt_references = 0

for path in paths:
    if not path or path.startswith("node_modules/"):
        continue
    file = ROOT / path
    if not file.is_file():
        continue
    data = file.read_bytes()
    if b"\0" in data:
        continue
    scanned += 1
    browser_scanned += int(path.startswith(("src/", "dist/", "public/")))
    text = data.decode("utf-8", errors="replace")
    for match in re.finditer(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", text):
        try:
            payload = json.loads(base64.urlsafe_b64decode(match[0].split(".")[1] + "==="))
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        if payload.get("role") == "service_role":
            findings.append((path, text[:match.start()].count("\n") + 1, "service-role JWT"))
        elif payload.get("role") == "anon":
            public_jwt_references += 1
    for pattern, kind in [
        (r"\bsb_secret_[A-Za-z0-9_-]{20,}\b", "server secret credential"),
        (r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", "private key"),
    ]:
        for match in re.finditer(pattern, text):
            findings.append((path, text[:match.start()].count("\n") + 1, kind))
    if path.startswith(("src/", "dist/", "public/")):
        for match in re.finditer(
            r"(?:import\.meta\.env\.|process\.env\.)"
            r"([A-Z0-9_]*(?:SERVICE_ROLE|SECRET_KEY)[A-Z0-9_]*)", text
        ):
            findings.append((path, text[:match.start()].count("\n") + 1, "privileged browser environment reference"))

print(json.dumps({
    "tracked_first_party_text_files": scanned,
    "browser_source_artifact_text_files": browser_scanned,
    "public_anon_jwt_references": public_jwt_references,
    "privileged_findings": [
        {"file": p, "line": line, "kind": kind} for p, line, kind in findings
    ],
    "values_printed": False,
}, indent=2))
raise SystemExit(bool(findings))
