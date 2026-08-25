#!/usr/bin/env bash

set -euo pipefail

: "${DEVLOOP_BROWSER_EVENTS_URL:?devloop browser reload URL is required}"

exec npx wrangler dev \
  --port 8787 \
  --var "DEVLOOP_BROWSER_EVENTS_URL:${DEVLOOP_BROWSER_EVENTS_URL}"
