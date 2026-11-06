#!/usr/bin/env bash
set -euo pipefail

if (($# != 0)); then
  printf '%s\n' 'Usage: bash scripts/ci/browser.bash (from a disposable source checkout)' >&2
  exit 2
fi

state="$(mktemp -d "${TMPDIR:-/tmp}/work-hub-browser-ci.XXXXXX")"
trap 'rm -rf -- "$state"' EXIT
mkdir -p "$state/home" "$state/tmp" test-results/browser-ci

env -i PATH="$PATH" HOME="$state/home" TMPDIR="$state/tmp" CI=true GIT_MASTER=1 \
  DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH="$state/browsers" \
  PLAYWRIGHT_JSON_OUTPUT_NAME="$PWD/test-results/browser-ci/results.json" \
  bash -euo pipefail -c '
    . /etc/os-release
    case "$ID:$VERSION_ID" in
      ubuntu:24.04|debian:12) ;;
      *) printf "%s\n" "Browser CI requires Ubuntu 24.04 or Debian 12 with apt and root/passwordless sudo." >&2; exit 2 ;;
    esac
    expected_node="$(<.node-version)"
    if [[ "$(node -p process.versions.node)" != "$expected_node" ]]; then
      printf "Browser CI requires Node %s from .node-version.\n" "$expected_node" >&2
      exit 2
    fi
    node --version
    npm --version
    npm ci --no-audit --no-fund
    npm exec --no -- playwright --version
    npm exec --no -- playwright install --with-deps chromium
    npm run build
    npm run test:browser -- --forbid-only --retries=0 --reporter=line,json
    node scripts/ci/browser-report.ts test-results/browser-ci/results.json
  '
