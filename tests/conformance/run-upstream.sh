#!/bin/sh
# Runs the upstream OpenFGA query suites against an external server.
# Usage: run-upstream.sh <target-url> <label> [suites]
#   suites: comma list of check,listobjects,listusers,check-matrix,listobjects-matrix (default: first three)
# Env: UPSTREAM_TAG (default v1.22.0), UPSTREAM_DIR (checkout location, default .upstream/<tag>)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
TAG="${UPSTREAM_TAG:-v1.22.0}"
DIR="${UPSTREAM_DIR:-$HERE/.upstream/$TAG}"
URL="${1:?target url}"; LABEL="${2:?label}"; SUITES="${3:-check,listobjects,listusers}"
if [ ! -d "$DIR/.git" ]; then
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --depth 1 --branch "$TAG" https://github.com/openfga/openfga.git "$DIR"
fi
mkdir -p "$DIR/tests/external" "$HERE/results"
cp "$HERE"/upstream/*.go "$DIR/tests/external/"
cd "$DIR"
CONF_TARGET_URL="$URL" CONF_SUITES="$SUITES" go test ./tests/external/ -count=1 -timeout 120m -json > "$HERE/results/upstream-$LABEL.jsonl" 2> "$HERE/results/upstream-$LABEL.stderr" || true
node "$HERE/summarize-upstream.mjs" "$HERE/results/upstream-$LABEL.jsonl" > "$HERE/results/upstream-$LABEL.summary.json"
head -40 "$HERE/results/upstream-$LABEL.summary.json"
