#!/bin/sh
set -eu

if [ -n "${OPENAI_API_KEY:-}" ] && [ -n "${OPENAI_BASE_URL:-}" ] && [ -n "${OPENAI_MODEL:-}" ]; then
  exec node dist/src/acceptance/realtime-e2e.js
fi

if ! command -v envars >/dev/null 2>&1; then
  echo "BrowserSilo E2E needs OPENAI_API_KEY, OPENAI_BASE_URL, and OPENAI_MODEL, or the envars CLI." >&2
  exit 1
fi

exec envars run \
  --namespace browsersilo \
  --keys OPENAI_API_KEY,OPENAI_BASE_URL,OPENAI_MODEL \
  --reason 'Run the BrowserSilo public-gateway release test' \
  -- node dist/src/acceptance/realtime-e2e.js
