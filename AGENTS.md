# Repository guidance

## Scope

- Keep `~/.codex` shared. Account switching may replace only `auth.json`; it must not move, copy, delete, or partition projects, tasks, sessions, plugins, configuration, or logs.
- Never commit credentials, `%APPDATA%/codex-usage-float`, `~/.codex/auth.json`, or captured response bodies. Build output remains ignored by default; commit a release EXE only when the repository owner explicitly requests it and the exact file has passed release checks with a documented SHA-256.
- Treat ChatGPT/Codex internal endpoints as optional data sources. Authentication or parsing failures must preserve the last known snapshot and surface a stale/reauth state.

## Required checks

Run before committing:

```powershell
npm run check
npm test
npm audit --audit-level=high
npm run build:dir
```

For account-switch changes, also verify the process manager detects both `ChatGPT.exe` and its `codex.exe app-server` descendant without stopping the active development session.

## Implementation conventions

- Use `src/lib/json-store.js` for JSON persistence; do not add direct read-modify-write helpers.
- Account credentials must be sealed through `src/lib/account-vault.js`. Do not introduce a plaintext fallback.
- Remote-page data must be bound to the active account identity before it reaches global state.
- Main-process IPC handlers must use `handleTrusted` and validate user-controlled identifiers or dimensions.
- Add or update a `node:test` regression test for persistence, process, concurrency, or migration changes.
