# Working on Agent Atoll

```
node islands/server.mjs        # the app on :4778, reading your own history
node site/build.mjs            # landing page + tarball into site/dist (SITE_URL=… to change the install URL)
```

## Files

- `bin/agent-atoll.mjs`: the CLI. Parses options, starts the server and opens the browser.
- `server.mjs`: a local HTTP server that serves the app and its JSON APIs (`/api/city`, `/api/live`, `/api/health`, `/api/npc`, `/api/crier`, `POST /api/open`, `POST /api/focus`).
- `scan.mjs` and `codex.mjs`: read Claude Code and Codex history into projects, sessions and live state, cached in `~/.agent-atoll`.
- `health.mjs`: git status plus GitHub PRs and CI via `gh`, which drive the weather and harbour life.
- `npc.mjs`: villager and town-crier answers via a tool-less `claude -p`.
- `islands/public/`: the Three.js app (`islands.js`) and its baked building models. `islands/README.md` covers how the islands are built.
- `tools/`: the Blender house generator and the model baker.
- `site/`: the landing page with its sample-data demo.

## Codex

Sessions come from `~/.codex/sessions` (plain or `.zst` rollouts). They join the same islands as Claude sessions, fly a small pennant, and resume with `codex resume <id>`. Codex has no live-status file, so a rollout written in the last two minutes counts as live.
