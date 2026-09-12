#!/usr/bin/env bash
# Playwright e2e runner (docs/spec/05-TEST-STRATEGY.md §6.1, adapted).
#   scripts/e2e.sh                 -> full suite (tests/e2e/**/*.spec.ts)
#   scripts/e2e.sh smoke           -> @smoke subset
#   scripts/e2e.sh grep "<regex>"  -> tests whose title matches
#   scripts/e2e.sh file <path>     -> one spec file (or a folder)
#   scripts/e2e.sh report          -> serve the last HTML report
#   scripts/e2e.sh update-visual   -> refresh @visual snapshots
# Env: E2E_PORT (3005), E2E_WORKERS (2), E2E_RETRIES (1), E2E_TYPECHECK=0 to skip tsc, CI=1 for CI defaults,
#      PW_ARGS="..." for extra playwright flags (e.g. PW_ARGS="--trace on").
# The Playwright webServer starts `next dev -p $E2E_PORT` when nothing listens there and reuses a running one.
set -euo pipefail
cd "$(dirname "$0")/.."

export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/root/.cache/ms-playwright}"
export NEXT_TELEMETRY_DISABLED=1
export NEXT_PUBLIC_ATC_TEST=1
export E2E_PORT="${E2E_PORT:-3005}"

MODE="${1:-full}"
ARGS=()
case "$MODE" in
  smoke)         ARGS+=(--grep "@smoke") ;;
  grep)          ARGS+=(--grep "${2:?usage: e2e.sh grep <regex>}") ;;
  file)          ARGS+=("${2:?usage: e2e.sh file <spec>}") ;;
  update-visual) ARGS+=(--grep "@visual" --update-snapshots) ;;
  report)        exec npx playwright show-report playwright-report ;;
  full)          ;;
  *)             echo "unknown mode: $MODE (full | smoke | grep <re> | file <spec> | update-visual | report)"; exit 2 ;;
esac

if [ "${E2E_TYPECHECK:-1}" = "1" ]; then
  echo "== typecheck (tsc --noEmit)"
  npx tsc --noEmit
fi

# Fail fast when the port is held by something that is not a Next dev server we can reuse.
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${E2E_PORT} "; then
  if ! curl -sf -o /dev/null "http://localhost:${E2E_PORT}/" ; then
    echo "port ${E2E_PORT} is busy but does not answer HTTP; stop that process first"; exit 2
  fi
  echo "== reusing the server on :${E2E_PORT}"
fi

echo "== playwright test ${ARGS[*]:-} ${PW_ARGS:-}"
# shellcheck disable=SC2086
npx playwright test "${ARGS[@]}" ${PW_ARGS:-}
STATUS=$?
echo "report: playwright-report/index.html   artifacts: test-results/"
exit $STATUS
