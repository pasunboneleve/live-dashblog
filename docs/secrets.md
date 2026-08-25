# Bitwarden secrets and machine recovery

Bitwarden is the source of truth. This repository does not use persistent `.env` or `.dev.vars` files. Both patterns are ignored as a defense against accidental creation.

## Prerequisites

Install `bw`, sign in to the correct Bitwarden server, and unlock the vault:

```bash
bw config server https://vault.bitwarden.com
bw login
export BW_SESSION="$(bw unlock --raw)"
```

The command substitution places the session key in the current shell without printing it as a standalone value. Do not enable shell tracing, paste the value into chat, save it in shell startup files, or redirect it to disk. Lock the vault when finished:

```bash
bw lock
unset BW_SESSION
```

## Worker application secrets

The current vertical slice has no required Worker secret. For a future declared binding, store one Bitwarden item whose password field contains only that value, then run:

```bash
scripts/put-worker-secret-from-bitwarden.sh SECRET_BINDING BITWARDEN_ITEM_ID
```

The script pipes `bw get password` directly into `wrangler secret put`. Neither command writes a persistent secret file, and the script never prints the value. Cloudflare documents CLI-to-Wrangler piping in its [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) and encrypts Worker secret bindings.

`wrangler secret put` changes remote state and deploys a new version. Run the script only after explicit authorization and after confirming the target Worker and Wrangler environment.

For a staged version that must not deploy immediately, use:

```bash
scripts/put-worker-secret-from-bitwarden.sh --staged SECRET_BINDING BITWARDEN_ITEM_ID
```

That form pipes to `wrangler versions secret put`; a later explicitly authorized versions deployment must select the created version.

## Terraform authentication

If Terraform is later added for DNS or custom-domain infrastructure, keep the Cloudflare API token in Bitwarden and run Terraform through:

```bash
scripts/terraform-with-bitwarden-token.sh BITWARDEN_ITEM_ID plan
```

The token exists only in the script process and Terraform child process. It is not a Terraform input variable and therefore is not intentionally written into state. Terraform may still persist sensitive resource attributes returned by providers; protect the state backend separately.

## New-machine recovery

1. Clone the repository and install Node.js, npm, Bitwarden CLI, and Terraform only if infrastructure work requires it.
2. Configure the correct Bitwarden server, run `bw login`, and unlock into `BW_SESSION` for the current shell.
3. Install dependencies with `npm install` and run `npm run check`.
4. Authenticate Wrangler separately only when remote Cloudflare work is authorized. Prefer Wrangler’s supported login or a least-privilege API token retrieved for the process.
5. Confirm the Worker name and environment before sending any application secret.
6. Lock Bitwarden and unset `BW_SESSION` after the operation.

If the Bitwarden account cannot be recovered, rotate the affected Cloudflare API token and each Worker secret from the upstream issuer. Do not reconstruct values from Terraform state, terminal history, logs, or old local files.
