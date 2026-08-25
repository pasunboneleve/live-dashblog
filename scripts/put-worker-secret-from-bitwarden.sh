#!/usr/bin/env bash
set -euo pipefail

wrangler_secret_command=(secret put)
if [[ "${1:-}" == "--staged" ]]; then
  wrangler_secret_command=(versions secret put)
  shift
fi

if [[ $# -ne 2 ]]; then
  echo "usage: $0 [--staged] SECRET_BINDING BITWARDEN_ITEM_ID" >&2
  exit 64
fi

if [[ -z "${BW_SESSION:-}" ]]; then
  echo "Bitwarden is locked; set BW_SESSION from 'bw unlock --raw'." >&2
  exit 1
fi

command -v bw >/dev/null
command -v npx >/dev/null

secret_binding="$1"
bitwarden_item_id="$2"

bw get password "$bitwarden_item_id" --session "$BW_SESSION" \
  | npx wrangler "${wrangler_secret_command[@]}" "$secret_binding"
