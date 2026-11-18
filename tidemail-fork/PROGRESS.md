# Fork PROGRESS — tidemail "Sign in with Google"

Updated: 2026-11-10

## Objective

Build a fork of tidemail (/home/backup/Projects/tidemail-fork) whose add-account
flow signs in to Gmail via browser OAuth ("sign up directly with gmail -> opens
on browser").

## Status: implemented, awaiting user verification

- [x] Research provider reality (Gmail app password OK; Proton Bridge only;
      Tuta no public IMAP).
- [x] Copy upstream to fork, base commit b67a117.
- [x] `--enable-google-oauth` startup flag -> forces GoogleDisabled=false.
- [x] Scopes + `auth.TokenEmail` from id_token.
- [x] Form autofill + auto-trigger browser sign-in on Gmail.
- [x] Build + full `go test ./...` green.

## Next steps (user action required)

1. Create Google Cloud OAuth desktop client (Google Cloud Console), add
   `http://127.0.0.1:<port>/oauth/callback`... (actual: set authorized redirect to
   `http://localhost` loopback — tidemail uses `http://127.0.0.1:PORT/oauth/callback`).
2. Put client ID/secret in `/home/backup/.config/tidemail/config.toml`
   `[oauth] google_client_id` / `google_client_secret`.
3. Run fork binary with `--enable-google-oauth`.
4. Add Gmail account -> browser opens -> approve -> account saved.

## Fork deltas vs upstream b67a117

- main.go: `--enable-google-oauth` flag; Google gate now turns on when any
  whole client exists (env, `-ldflags`-bundled, or `[oauth]` in config) — no
  flag needed once a client is saved.
- internal/auth/google.go: scopes + TokenEmail.
- internal/ui/msgs.go: OAuth2DoneMsg.Email.
- internal/ui/google_signin.go: emit token email.
- internal/ui/account_manager.go: autofill + autoGoogleSignIn + discovery hook.
- internal/ui/model.go + account_discovery_test.go: applyDiscovery signature.
