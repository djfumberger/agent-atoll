# Agent Atoll

Your Claude Code and Codex history as a living archipelago. Every project folder is an island, every session a building, live agents build in real time, and repo health shows up as weather and harbour life.

## Quick start

```
npx https://agent-atoll.pages.dev/agent-atoll.tgz
# or straight from this repo
npx github:djfumberger/agent-atoll
```

Demo with sample projects: https://agent-atoll.pages.dev

You need Node 18 or newer. It runs locally on `127.0.0.1`, reads `~/.claude` and `~/.codex`, and uploads nothing. The first run scans your history, which can take a minute. After that it's cached in `~/.agent-atoll`.

| Option | |
|---|---|
| `--only claude` / `--only codex` | Show just one agent's history (default: both) |
| `--exclude a,b` | Hide projects by folder name or absolute path (also `~/.agent-atoll/config.json`: `{"exclude": [...]}`) |

`~/.agent-atoll/config.json` can also hold `"aliases": { "ac": "acme" }` so `ac-api` and `acme-web` share one archipelago.
| `--port <n>` | Port to try first (default 4778; the next free port is used if it's taken) |
| `--no-open` | Don't open the browser |

Optional extras:
- **`gh` CLI** (logged in): PR ships and CI storms.
- **`claude` on PATH**: villagers and the town crier can talk.
- **`zstd`**: needed on Node versions without built-in zstd, to read compressed Codex history.

"Resume in Terminal" opens Terminal.app on macOS. Elsewhere it copies the command for you to paste.

**Codex:** sessions come from `~/.codex/sessions` (plain or `.zst` rollouts). They join the same islands as Claude sessions, fly a small pennant, and resume with `codex resume <id>`. Codex has no live-status file, so a rollout written in the last two minutes counts as live.

## Development

```
node islands/server.mjs        # islands on :4778
node site/build.mjs            # landing page + tarball into site/dist (SITE_URL=… to change the install URL)
```

## Files

- `bin/agent-atoll.mjs`: the CLI. Parses options, starts the server and opens the browser.
- `server.mjs`: a local HTTP server that serves the app and its JSON APIs (`/api/city`, `/api/live`, `/api/health`, `/api/npc`, `/api/crier`, `POST /api/open`).
- `scan.mjs` and `codex.mjs`: read Claude Code and Codex history into projects, sessions and live state, cached in `~/.agent-atoll`.
- `health.mjs`: git status plus GitHub PRs and CI via `gh`, which drive the weather and harbour life.
- `npc.mjs`: villager and town-crier answers via a tool-less `claude -p`.
- `islands/public/`: the Three.js app (`islands.js`) and its baked building models.
- `tools/`: the Blender house generator and the model baker.
- `site/`: the landing page with its sample-data demo (`node site/build.mjs`).
