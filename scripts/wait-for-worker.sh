#!/usr/bin/env bash

set -euo pipefail

for _attempt in {1..120}; do
  if curl --fail --silent --output /dev/null http://127.0.0.1:8787/__ready; then
    exit 0
  fi
  sleep 0.25
done

echo "Worker did not become ready within 30 seconds" >&2
exit 1
