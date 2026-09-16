#!/usr/bin/env bash
# Usage: bash scripts/ci-smoke-hindsight-agent-bridge.sh BINARY EXPECTED_VERSION
# Exercises a compiled bridge's offline diagnostic without real credentials.
# Requires only standard runner utilities and Python 3's standard library.

set -euo pipefail

if [[ $# -ne 2 || -z "${1:-}" || -z "${2:-}" ]]; then
	echo "usage: ci-smoke-hindsight-agent-bridge.sh BINARY EXPECTED_VERSION" >&2
	exit 1
fi
BINARY="$1"
EXPECTED_VERSION="$2"
if [[ ! -f "$BINARY" || ! -x "$BINARY" ]]; then
	echo "ci-smoke-hindsight-agent-bridge: executable not found: $BINARY" >&2
	exit 1
fi
if [[ "$BINARY" != /* ]]; then
	BINARY="$PWD/$BINARY"
fi

umask 077
runtime_dir="$(mktemp -d)"
cleanup() {
	rm -rf "$runtime_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$runtime_dir/home" "$runtime_dir/xdg/config" "$runtime_dir/xdg/data" \
	"$runtime_dir/xdg/cache" "$runtime_dir/xdg/state" "$runtime_dir/xdg/runtime" \
	"$runtime_dir/tmp" "$runtime_dir/bridge-smoke/.git"
cat >"$runtime_dir/config.json" <<'JSON'
{
  "apiToken": "offline-token",
  "apiUrl": "http://127.0.0.1:9999",
  "bankId": "coding-agents",
  "mentalModelsEnabled": false,
  "scoping": "per-project-tagged"
}
JSON
chmod 600 "$runtime_dir/config.json"

run_bridge() {
	# Do not pass inherited credentials or configuration to the compiled binary.
	env -i PATH="$PATH" HOME="$runtime_dir/home" TMPDIR="$runtime_dir/tmp" \
		XDG_CONFIG_HOME="$runtime_dir/xdg/config" XDG_DATA_HOME="$runtime_dir/xdg/data" \
		XDG_CACHE_HOME="$runtime_dir/xdg/cache" XDG_STATE_HOME="$runtime_dir/xdg/state" \
		XDG_RUNTIME_DIR="$runtime_dir/xdg/runtime" HINDSIGHT_BRIDGE_CONFIG="$runtime_dir/config.json" \
		"$BINARY" "$@"
}

run_bridge --version >"$runtime_dir/version.txt" 2>"$runtime_dir/version.stderr" || {
	status=$?
	echo "ci-smoke-hindsight-agent-bridge: --version failed (exit $status)" >&2
	exit "$status"
}
# Deliberately omit --online: diagnosis must not contact the configured API.
run_bridge diagnose --cwd "$runtime_dir/bridge-smoke" --json \
	>"$runtime_dir/diagnose.json" 2>"$runtime_dir/diagnose.stderr" || {
	status=$?
	echo "ci-smoke-hindsight-agent-bridge: offline diagnose failed (exit $status)" >&2
	exit "$status"
}

python3 - "$runtime_dir" "$EXPECTED_VERSION" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
expected_version = sys.argv[2]


def fail(message):
    sys.exit(f"ci-smoke-hindsight-agent-bridge: {message}")


outputs = {
    name: (root / name).read_text()
    for name in ("version.txt", "version.stderr", "diagnose.json", "diagnose.stderr")
}
if any("offline-token" in output for output in outputs.values()):
    fail("offline credentials leaked in binary output")
if outputs["version.txt"].strip() != expected_version:
    fail("--version does not match EXPECTED_VERSION")
try:
    diagnostic = json.loads(outputs["diagnose.json"])
except ValueError:
    fail("offline diagnose did not return valid JSON")
if not isinstance(diagnostic, dict):
    fail("offline diagnose must return a JSON object")
# Check decoded JSON as well, so escaped credential text cannot evade detection.
decoded = json.dumps(diagnostic, ensure_ascii=False)
if "offline-token" in decoded or "apiToken" in decoded:
    fail("offline credentials leaked in diagnostic JSON")
expected = {
    "version": expected_version,
    "configMode": "0600",
    "apiOrigin": "http://127.0.0.1:9999",
    "bankId": "coding-agents",
    "projectTag": "project:bridge-smoke",
    "recallTagsMatch": "any",
    "observationScopes": [["project:bridge-smoke"]],
}
for key, value in expected.items():
    if diagnostic.get(key) != value:
        fail(f"offline diagnose returned an unexpected {key}")
for key, path in (("configPath", root / "config.json"), ("primaryRoot", root / "bridge-smoke")):
    value = diagnostic.get(key)
    if not isinstance(value, str) or pathlib.Path(value).resolve() != path.resolve():
        fail(f"offline diagnose returned an unexpected {key}")
if "reachable" in diagnostic or "mentalModelIds" in diagnostic:
    fail("offline diagnose unexpectedly returned online results")
print(f"ci-smoke-hindsight-agent-bridge: version {expected_version} and offline project scope verified")
PY
