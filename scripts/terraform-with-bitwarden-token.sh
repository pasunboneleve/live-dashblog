#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 BITWARDEN_ITEM_ID TERRAFORM_ARGUMENT..." >&2
  exit 64
fi

if [[ -z "${BW_SESSION:-}" ]]; then
  echo "Bitwarden is locked; set BW_SESSION from 'bw unlock --raw'." >&2
  exit 1
fi

command -v bw >/dev/null
command -v terraform >/dev/null

bitwarden_item_id="$1"
shift

CLOUDFLARE_API_TOKEN="$(bw get password "$bitwarden_item_id" --session "$BW_SESSION")"
export CLOUDFLARE_API_TOKEN
exec terraform "$@"
