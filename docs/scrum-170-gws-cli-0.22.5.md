# SCRUM-170: vendored gws CLI 0.13.2 → 0.22.5 verification report

Branch: `chore/gws-cli-0.22.5`, off `main` at f8e8e48. One change: the
binary pin. No `src/` file is touched.

Versions this report depends on: upstream release `v0.22.5` (published
2026-03-31), replacing `v0.13.2` (2026-03-12); verification ran 2026-08-28
on macOS arm64 and, via Docker, Ubuntu 22.04 and 24.04 x86_64.

## Lead: this is NOT ready to merge as a pure pin bump

Three things HQ has to decide before this ships. None of them is fixed here,
because each is a second change hiding inside the first.

1. **`spawnAuthForUrl` is broken by 0.22.5.** 0.13.2 printed the OAuth URL
   on **stderr**; 0.22.5 prints it on **stdout**. `src/gws-client.ts`
   listens on stderr only, so on the new binary it times out after 10 s and
   resolves `undefined`. Consequences: `extension.ts` never opens the
   browser on first run (the login process keeps running in the background,
   invisible), and `gws_auth_setup action=login` returns "Authentication
   login triggered. If a browser window didn't open, check the server logs"
   instead of the URL. Silent degradation, not a crash. Verified on both
   binaries with the same call. The fix is a one-line change in
   `gws-client.ts`, a file the SCRUM-167 session also cares about, so it is
   reported, not made.
2. **0.22.x deletes the user's credentials when the OS keychain read fails.**
   On macOS the keychain entry is ACL'd to the executable that created it, so
   the *first run of a new binary* triggers a keychain prompt; if that prompt
   is cancelled (or the process is non-interactive, e.g. a sandboxed
   extension), the binary removes `credentials.enc` and `token_cache.json`
   ("removing undecryptable credentials file"). The user is then logged out
   for **every** gws binary on the machine, and **rolling back the pin does
   not restore auth**, the credentials are gone. This happened during this
   verification (see Incident). It does not affect Linux, which keeps the
   file-based key. Whether it affects the gateway depends on where the
   gateway runs; whether it affects `.mcpb` users on macOS is near-certain.
3. **The Linux binary now needs glibc ≥ 2.39.** 0.13.2 needed 2.34. 0.22.5
   fails to start on Ubuntu 22.04 (2.35) and Debian bookworm / `node:20` /
   `node:22` images (2.36): `GLIBC_2.39 not found`, exit 1 before any gws
   code runs. Ubuntu 24.04 works. If the gateway container is on any of the
   former, this deploy is a hard outage of every tool. Upstream also
   publishes a `x86_64-unknown-linux-musl` build with no glibc floor;
   switching target is a decision, not a bump.

Everything below is the evidence.

## Changelog review, 0.13.3 → 0.22.5, every entry adjudicated

Source: upstream `CHANGELOG.md` at the 0.22.5 release, read in full for this
range. "Breaking" here means "changes something this repo observes".

| Version | Entry | Affects us? | Why |
|---|---|---|---|
| 0.13.3 | `repeated: true` in schema; JSON arrays expand into repeated query params | No (now over-guarded) | `assertScalarParams` in `gws-client.ts` still rejects array params before the call. The binary can now carry them; our guard is stricter than needed, not wrong. Follow-up, not this branch. |
| 0.13.3 | `+append --json-values` multi-row fix | No | We do not use the sheets `+append` helper (only `gmail +send/+reply/+forward`, `drive +upload`). |
| 0.13.3 | People scopes mapped for `-s people` | No | We pass explicit `--scopes`; `-s` is only the fallback for unknown service names. |
| 0.13.3 | calendar `+agenda` timezone; chat `+send` path validation; docs typos; triage tests | No | Helpers we do not call. |
| 0.14.0 | `--upload-content-type`; media Content-Type now inferred from file extension | **Behaviour change, low impact** | Only `gmail_save_attachment_to_drive` uploads (`drive +upload`). It passes an explicit mimeType; inference only applies when it is absent. Not live-tested (see below). |
| 0.14.0 | Streamed multipart uploads | No | Internal; same wire format. |
| 0.15.0 | `GOOGLE_WORKSPACE_CLI_LOG*` env vars | No, with a caveat | Off by default. We forward `process.env` to the binary, so a user who sets `GOOGLE_WORKSPACE_CLI_LOG` gets logs on stderr, and `errorDetail()` prefers stderr. Cosmetic noise in error messages only. |
| 0.16.0 | Calendar helpers use the account timezone (extra Settings API call) | No | We do not call calendar helpers; `calendar_*` tools use the raw API. |
| 0.16.0 | RFC 2047 encoding of non-ASCII display names | Yes, benign | Applies to `gmail +send/+reply/+forward`, which we use. Fixes mojibake; no argument changes. |
| 0.17.0 | Meet conferencing in `calendar +insert` | No | Helper not used. |
| 0.17.0 | Atomic-write / TOCTOU fix; Retry-After cap; `--upload`/`--output` path validation | No | `--upload` gets a file the tool itself just wrote; no `--output`. |
| 0.17.0 | **Stderr hygiene: `error[variant]:` labels on stderr; diagnostics moved to stderr; auth failures in helpers now propagate as auth errors instead of proceeding unauthenticated** | **Yes, the stderr format change** | Verified: validation errors now carry a stderr line (`error[validation]: …`) where 0.13.2 had none. Exit codes are unchanged. `exec()` behaviour: code 3 → `Validation error: error[validation]: …` (label now doubled, still the real message); code 1 → stdout JSON still present and still parsed first; code 2 → fixed message, unchanged. **No path turns a failure into a success.** No ANSI escapes reach us when stderr is a pipe (positive control: escapes DO appear under a pty). Helpers proceeding unauthenticated is now an exit-2 instead of a confusing API error, an improvement. |
| 0.17.0 | Input validation rejects zero-width / bidi / U+2028-2029 characters | **Tested, does not fire on request bodies** | `--json` bodies and `--params` values containing U+200B, U+202E and U+2028 pass `--dry-run` on both binaries with identical output. The validation applies to resource identifiers, not to document text. A body with those characters would have been the breaking case; it is not. |
| 0.18.0 | From header auto-populated from send-as settings (extra `sendAs.list` call) | **Yes, unverified** | Every `gmail_send/reply/forward` now makes one more API call under `gmail.modify`, which the sendAs read methods accept. Could not live-test: no credentials, and no live send was attempted. |
| 0.18.0 | Mail helpers migrated to `mail-builder`; `--attach`; `+read`; `thread_id` optional | **Yes, wire-level change, flags compatible** | Every flag `gmail.ts` passes (`--to`, `--subject`, `--body`, `--cc`, `--bcc`, `--html`, `--message-id`) is listed in 0.22.5 `--help` and accepted by `+send/+reply/+forward --dry-run` through the compiled client. Option-set diff old→new: `+send` lost `--json` (never passed by us) and all three gained `--attach`/`--draft`/`--from`; `+forward` gained `--no-original-attachments`; `drive +upload` is identical. The request itself changed: 0.13.2 POSTed a base64 `raw` JSON body to `/gmail/v1/users/me/messages/send`; 0.22.5 sends a multipart upload to `/upload/gmail/v1/users/me/messages/send` and the dry-run no longer exposes the MIME. Same API resource comes back, so `gmail_send/reply/forward` should be unaffected, but this is exactly the class that only a live send proves, and none was possible. |
| 0.18.0 | Output sanitisation of API error bodies and query echo | No (error text only) | Applies to stderr diagnostics, not to stdout JSON data. Dry-run bodies round-trip unchanged. |
| 0.18.1 | SIGTERM in `+watch`/`+subscribe` | No | Not used. |
| 0.19.0 | `gws auth` subcommands reparsed with clap | **Checked, compatible** | `auth login --scopes <csv>`, `-s <csv>`, `auth status`, `auth logout` all still exist with the same shapes. `--scopes` is honoured (URL shows exactly the requested scopes plus openid/userinfo; 0.22.5 also adds `userinfo.profile`, which 0.13.2 did not). |
| 0.19.0 | auth error propagation; `mask_secret` panic fix; SKILL.md YAML | No | Internal / docs. |
| 0.20.0 | **`+forward` now includes original attachments by default** | **Yes, user-visible semantic change** | `gmail_forward` uses `gmail +forward`. After this bump a forward carries the original attachments unless `--no-original-attachments` is passed, which our tool does not. This matches Gmail's web behaviour but is a change in what the tool does. HQ decides whether to expose or pin the flag; not done here. |
| 0.20.1 | 10 s connect timeout | Yes, benign | A slow connect now fails fast with a message our `TRANSIENT_PATTERNS` do not match, so it surfaces as a plain (non-retryable) error. Not wrong, just not classified. |
| 0.21.0–0.21.2 | Library crate split, "zero behavioral changes"; crates.io publishing | No | Packaging. |
| 0.22.0 | `--draft` on mail helpers | No | Additive. |
| 0.22.1, 0.22.3 | Skills sync | No | Generated docs. |
| 0.22.2 | Proxy-aware OAuth flows | **Suspected cause of item 1** | The login URL moved from stderr to stdout somewhere in 0.14–0.22; this or 0.19.0 is the likely origin. Effect verified regardless of origin. |
| 0.22.3 | **Strict OS keychain on macOS/Windows; deletes `.encryption_key` fallback on successful login** | **Yes, item 2** | Combined with the 0.13.1 "remove undecryptable credentials" recovery, a keychain read failure becomes credential deletion. Observed. |
| 0.22.3 | `script` service registered | No | Additive. |
| 0.22.4 | **cargo-dist dropped; release assets renamed `google-workspace-cli-<target>`; tarballs contain a bare `gws`** | **Yes, the download script** | A `VERSION=` bump alone 404s. `scripts/download-binaries.sh` now maps the asset names and extracts each tarball into its own `gws-<target>/` dir so the paths `gws-client.ts` (and SCRUM-167's `gws-guard.sh`) resolve are unchanged. `curl -f` added so a 404 fails the build instead of writing an HTML page as the archive. This is the only code change on the branch. |
| 0.22.5 | cargo-audit, cargo-deny, TOML skills registry, npm checksum verification, pinned cross-rs | No | Supply-chain hygiene upstream; nothing at runtime. |

Not in the changelog but observed: Linux glibc floor 2.34 → 2.39 (item 3);
arm64 macOS binary 12.3 MB → 15.4 MB, `bin/` 52 MB → 65 MB.

## `src/gws-client.ts` blast radius, what was checked and how

Every check had its failure condition written down before it ran.

| # | Check | Fails if | Result |
|---|---|---|---|
| C1 | `--version` | not `gws 0.22.5` | pass, all three runnable platforms |
| C2 | exit-code table in `--help` | codes 0–5 absent or re-meaning'd | pass, identical meanings |
| C3 | `auth login` flags | `--scopes`/`-s` gone | pass |
| C4 | bad `--params` JSON, unknown service, unknown helper flag | exit ≠ 3 or no diagnostic | pass: exit 3, stdout JSON + new stderr label |
| C5 | ANSI escapes on piped stderr | any `\x1b` | pass (0); positive control under a pty: 2 |
| C6 | zero-width / bidi / U+2028 in `--json` and `--params`, `--dry-run` | new binary exits 3 where old exited 0 | pass, identical output both binaries |
| C7 | API-error envelope (exit 1, JSON on stdout) | body moves off stdout | **not verified live** (no credentials); auth-error envelope (exit 2) verified identical |
| C8 | byte-identical envelope on identical read calls | any diff | **not verified live**; dry-run envelopes identical |
| C9 | new binary reads existing creds without re-login | logged out / files deleted | **FAIL**, see Incident |
| C10 | login URL on stderr within 10 s | URL on stdout only | **FAIL**, item 1 |
| C11 | `pnpm test` with `bin/` at 0.22.5 | any red or any skipped | pass: 11 files, 216 tests, 0 skipped, after `pnpm install --frozen-lockfile` on a clean worktree. **The suite never spawns the binary** (fake clients, `exec` swapped); green proves compile + handler logic, nothing about 0.22.5. |
| C12 | compiled `server/gws-client.js` driven against 0.22.5 | thrown where success expected, or vice-versa | pass for: `exec --version`, unknown service, bad params, no-creds (exit 2 → "authentication required"), dry-run success envelope, helper bad flag, `authStatus`, `--page-all --page-limit` accepted, and `+send` (plain and `--html`), `+reply`, `+forward` dry-runs with the exact flag sets `gmail.ts` builds |
| C13 | Linux binary in Docker | fails to start / different behaviour | **fails to start on Ubuntu 22.04** (item 3); on 24.04 identical exit codes, labels, dry-run URL to 0.13.2. Both binaries need system CA certificates equally. |

Windows: archive layout verified (`gws.exe` at zip root, lands at
`bin/gws.exe` as `gws-client.ts` expects); binary not executed.

## Services exercised end to end against 0.22.5

**None.** After the incident below there were no credentials on the machine,
and the OAuth flow needs a browser I cannot drive. Every service, Gmail,
Calendar, Drive, Contacts, Sheets, Docs, Slides, Tasks, generic API, is
**untested live** on the new binary. What is covered is everything up to the
network: argument assembly, exit-code mapping, error parsing, dry-run request
construction. What is not covered is the one thing a version bump most needs:
response shapes from Google as rendered by the new binary. Treat every
service as unproven.

## Checksums

Yes, the release publishes them: a `.sha256` beside every asset. All four
archives this repo uses were verified, and the hashes also match GitHub's
own asset digests:

```
1d2a9ffd5bc9b2c2c4b48630daf082fad13d9e57d741988a2c248eed562f7dac  google-workspace-cli-aarch64-apple-darwin.tar.gz
51f9bd731404d4bba26c36e2e30dd68c56dccd1f834c01252cb0b14d6a6544b2  google-workspace-cli-x86_64-apple-darwin.tar.gz
de78ecdbd2f1a84cca0063a7ecbc440240fc14b6ebccbb17f4646b792a8c5c1f  google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz
407705d695dc83d48b1c5f50d71b5aa64095bf6f17d5b439b2e9a373bbe67ec2  google-workspace-cli-x86_64-pc-windows-msvc.zip
```

(The Windows `.sha256` file has a CRLF line ending, so `shasum -c` reports
"no such file"; the hash itself matches.) The binaries the modified script
produced are byte-identical to the ones extracted from the verified archives.
The script does **not** verify checksums itself, that would be a second
change; recommended as a follow-up, ideally pinning the four hashes above.

## Incident: local CLI login destroyed during verification

All probes ran the new binary against a *copy* of the config directory,
through an exported env var. One parallel shell call (the pty positive
control for C5) did not carry that export, so the 0.22.5 binary ran once
against the real `~/.config/gws`. The keychain prompt was cancelled
(non-interactive), and the binary deleted `credentials.enc` and
`token_cache.json`. The Homebrew `gws` on that machine, and every other
session using that config dir, is logged out until `gws auth login` is
re-run. No backup existed. The affected session working SCRUM-167 was
notified. This is my error in execution, and it is also the strongest
evidence for item 2: it is exactly what a macOS `.mcpb` user will hit on
first launch after the upgrade.

## Boundary

**Proven**
- 0.22.5 binaries download, verify, extract into the expected layout, and run on macOS arm64 and Linux with glibc ≥ 2.39.
- Exit codes 0–5 keep their meanings; the code-2/3/4 branches in `exec()` behave as before through the compiled module.
- API and auth error bodies still land as JSON on stdout; stderr gained a labelled line, nothing was removed. No failure becomes a success.
- Unicode validation does not reject request bodies.
- `auth login` still accepts our flag shapes and honours `--scopes`.
- The unit suite is green, and irrelevant to the binary.

**Unsure**
- Every live response shape (C7/C8/C12-live), untested.
- `gmail +send/+reply/+forward` after the mail-builder migration and the extra sendAs call.
- Whether the gateway host meets glibc 2.39, and whether it is macOS (keychain) or Linux (file key).
- Windows binary runtime.

**Deliberately not done**
- No change to `src/gws-client.ts` (login URL stream), reported, item 1.
- No `--no-original-attachments` on `gmail_forward`, reported, 0.20.0.
- No relaxation of `assertScalarParams`, reported, 0.13.3.
- No checksum pinning in the download script.
- No switch to the musl build.
- No `.mcpbignore` entry for `docs/`: this file ships inside the extension bundle, which is why it carries rules and hashes and nothing else.
- Not merged, not deployed. The Drive rename/copy work for SCRUM-170 on its own branch is untouched.
