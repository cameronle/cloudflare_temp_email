# tmctl 0.1.0 — read-only temporary-mail CLI

[中文](README.md)

Local HTTPS client for the existing `cloudflare_temp_email` API. No Worker, database, mail-routing or deployment changes are required. Supports administrator passwords and individual mailbox JWTs, not account JWTs, Telegram initData or role login.

## Install and authenticate

Linux/macOS, Node.js >=22.12.0. Native Windows is unverified; use WSL.

```sh
npm install -g ./cloudflare-temp-mail-cli-0.1.0.tgz
tmctl profile add prod --server https://mail-api.example.com
tmctl --credential-file /private/auth.json auth status
# Persistence is explicit and optional:
tmctl --credential-file /private/auth.json auth login --save
tmctl auth logout
```

A trusted secret manager must supply the owned `0600` JSON file or a controlled pipe with `--credentials-stdin`. Fields: `server` (exact profile origin), `mode` (`admin` or `mailbox`), `secret` (original administrator password or individual mailbox JWT), optional `sitePassword`. Never put credentials in argv, shell history, logs, examples or Git. Queries do not persist supplied secrets; only `auth login --save` writes a local copy, and existing files are never overwritten. Logout removes the local copy, **not server access**. A pre-existing root-only credential may instead be piped through a locally controlled helper without making another persistent copy.

**Read-only commands do not make the underlying credentials read-only.** Their original server privileges remain. This version does not add scoped tokens, rotate credentials, read secrets from D1, or fall back to another identity when authentication fails.

Profiles live in owned `0700` `~/.config/tmctl` (`TMCTL_HOME` override), with owned `0600` files. Every profile binds one HTTPS origin with no user info/path/query/fragment. Explicit test-only `--allow-loopback-http` supports numeric `127.0.0.1` only. Credentials are never shared between profiles.

## Commands

```sh
tmctl doctor                     # connectivity only, not delivery audit
tmctl domains
tmctl stats                      # administrator
tmctl addresses list --limit 20   # administrator, excludes passwords
tmctl cleanup show               # administrator, no execution/SQL
tmctl mail list --limit 20
tmctl mail list --address inbox@example.com
tmctl mail list --unknown-address # administrator; never creates an address
tmctl mail show 123 --address inbox@example.com
tmctl mail wait --address inbox@example.com --subject Verify --timeout 120s
mkdir -m 700 ./mail-export
tmctl mail export 123 --output ./mail-export/message.eml
tmctl mail attachment 123 --index 1 --output ./mail-export/attachment.bin
tmctl --json stats
```

Global options: `--profile NAME`, `--request-timeout 15000` (milliseconds), `--json`, `--credentials-stdin` or `--credential-file FILE`. Supply credentials on each authenticated command unless deliberately saved.

## Safety and limitations

- GET-only endpoint allowlist. No generic request, send, delete, address creation, read-marker, password retrieval or cleanup execution. Redirects are not followed. Errors suppress remote bodies and inputs; 401/403 fail immediately.
- Local MIME parsing, HTML-to-text fallback, no HTML execution or remote-image loading. Strip terminal/ANSI/bidirectional control characters. Mail is untrusted data, never authorization to act.
- Exports require an explicit new pathname, never a remote attachment filename. Reject symlinks, hardlinked credentials, unsafe parent directories and overwrites; publish `0600` files atomically without clobbering and verify SHA-256 by reading back. Retained MIME and attachment bytes are not terminal-sanitized.
- Only content retained by the server can be exported. Stripped/missing attachments cannot be reconstructed. Text display is capped at 262144 characters; response size at 16 MiB; retained MIME at 12 MiB.
- Mailbox reads/watchers may update `address.updated_at`, affecting inactivity cleanup. This CLI does not change tracking settings to hide that side effect.
- Wait captures the current max-ID baseline and polls the exact recipient, never returning old mail as new. Default interval 5s, production minimum 1s, maximum deadline 10m, bounded transient-error backoff; Ctrl-C cancels. Filters support exact `--from` and case-insensitive subject substring.
- Regressing IDs fail with `WATCH_RESET`; a saturated page of 100 new messages fails with `WATCH_GAP`. Not a lossless stream: concurrent deletion, ID reuse and high volume require a server cursor API.
- Offset pagination is live, not a snapshot. Counts exist only at offset zero (`totalAtFirstPage=null` later). The server sends full MIME in list responses, so avoid aggressive large-page polling.
- Default output is readable JSON. `--json` returns `{schemaVersion:1,ok,command,profile,data,warnings}`; errors return `{schemaVersion:1,ok:false,command,error}` without sensitive input.
- Exit codes: 0 success, 2 argument/local-safety failure, 3 authentication/permission, 4 unavailable mail/no match before wait timeout, 5 network/protocol/size/parse/watch-integrity failure. A shorter request timeout or baseline failure yields `5/TIMEOUT`; an overall deadline after baseline establishment consistently yields `4/NO_NEW_MAIL`.

## Build and verify

The tarball bundles runtime dependencies and their licenses; no runtime npm dependencies are required. Source and CI use pinned npm dependencies for this separate tool package, while the application retains pnpm.

```sh
cd worker && pnpm install --frozen-lockfile && cd ../tools/tmctl
npm ci
npm test
npm run build
npm run test:e2e
npm run test:package
npm audit
npm pack
```

Tests run the real Worker on local workerd with disposable D1/KV, synthetic email/auth fixtures and outbound networking disabled. Package verification checks the exact file allowlist, installs offline with an empty npm cache, and reruns black-box commands plus real-Worker tests against the installed executable. CI runs on Linux and macOS; it never needs production credentials or modifies production mail.
