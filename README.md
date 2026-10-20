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
| `--city` | The original isometric city view instead of islands |
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
node server.mjs                # city on :4777
node site/build.mjs            # landing page + tarball into site/dist (SITE_URL=… to change the install URL)
```

---

## Claude City (original concept)

Your Claude Code history drawn as an isometric sim-city. Each project is a district, each session is a building, and live agents are workers and cranes on the streets.

```
node server.mjs        # → http://localhost:4777  (first scan of ~/.claude takes ~10s, then cached)
node scan.mjs --json   # dump the city model
```

No dependencies. Three.js loads from a CDN. The server only listens on 127.0.0.1.

## The metaphor

| Claude Code concept | In the city | Source |
|---|---|---|
| Project (cwd) | **District**: a concrete block ringed by road. It gets bigger as sessions pile up | `~/.claude/projects/*/*.jsonl` → `cwd` |
| Nested project (`repo/packages/x`) | **Neighbourhood** next to its parent, joined by a street | path nesting |
| Name family (`acme-*`, `tide-*`) | **Region**: a zoned patch of land with a name ("Acme Metro") | first name token (`"aliases"` in the config folds e.g. `ac` → `acme`) |
| `~` and workspace roots | **Downtown** at the centre of the map | a project that contains 3 or more other projects |
| Session | **Building**. Oldest sessions sit at the district centre, so towns grow outward | one transcript |
| Session length | Height (floors ≈ log of assistant turns) | |
| What the session did | Building type: blue glass office (edits), brick factory with chimney (Bash), sandstone civic (Read/Grep/Web), purple tower with helipad (subagents), house with a roof (just talking) | tool-use counts |
| Recency | Lit windows at night. Old buildings fade toward grey | session end time |
| Cross-project work | **Highway** arcs with traffic, when a session in A read or edited files in B | `file_path` args that point outside the cwd |
| Live session | **Worker** walking the district: amber = working, green = waiting on you, grey = shell | `~/.claude/sessions/<pid>.json` + pid liveness |
| Busy session | **Construction crane** on its building, with a bubble naming the current tool | `status: busy`, or the transcript was written in the last 20s |
| District with live sessions | Floating **plumbob**. Amber spins fast; green means it's your turn | |
| History | **Timeline** scrubber and ▶ replay that grow the city in the order sessions happened | session start times |

## What works today

- Real data from `~/.claude`: about 57 districts, 211 buildings, 58 live sessions. Live state polls every 3s, and new sessions trigger a rescan.
- Toon-shaded instanced buildings with procedural windows and edge outlines in the shader, time-based growth, and shadows.
- **Retro** mode renders at 1/3 resolution, then applies a 4×4 Bayer dither and posterize for a SimCity 2000 feel. **Night** mode shows lit windows for recent activity.
- A roster of live sessions grouped as Working / Waiting on you / Shells. Click one to fly to it.
- Click a building to see the session: title, first prompt, turns, cost, lines changed, tool mix and branches. **Resume in Terminal** runs `osascript` → `claude --resume <id>`.
- Click a district to see the project: live sessions, neighbourhood, highways, and the session list. **New session in Terminal** is there too.
- Q/E rotate in 90° steps, N night, R retro, L labels, Space replay.

## Directions worth exploring

**Make the management loop tighter.** At the moment the city is mostly a viewer. The useful version is a control room:
- *Waiting on you* should be the loudest signal: a green plumbob plus a chime, and a district that dims the longer it waits. Notification hooks (`Notification` / `Stop`) could push this instantly instead of polling.
- Reply from the city. Live session records have `messagingSocketPath` and `peerProtocol`, so a session could get messages without switching terminals. That needs research into the peer protocol.
- Embed a terminal with xterm.js and a PTY bridge, so clicking a building opens its session in a side pane.

**Richer life on the streets.**
- Subagents as drones taking off from the helipad and flying to the districts whose files they touch. `subagents/*.meta.json` has their descriptions.
- Tool calls as vehicles: Bash = trucks, Web = planes landing at an airport district, MCP servers = utility buildings on the edge of town with power lines to the districts that use them.
- Worktrees and branches as **suburbs**: small satellite blocks branching off the main district, which merge back (get demolished) when the branch merges.
- Cost and token spend as land value or zoning colour, like the SimCity overlay maps (toggle: activity / cost / age / errors).

**Spatial relationships.** Layout is hierarchical spiral packing right now (district → town → region → world). Alternatives:
- A force-directed layout that uses highway weights, so projects that share files drift together and *neighbours really are related*.
- Git remotes, package.json deps, or shared MCP config as extra edge types: rail lines vs highways.
- Stable placement: persist each district's position once assigned, so the map never reshuffles as it grows, like a real city.

**Art direction options.**
1. *Current: toon and dither.* Cheap, readable, scales to thousands of buildings with instancing.
2. *Pre-rendered sprite atlas* (classic SC2000 / OpenTTD). Generate building sprites per style and size with the image model, then draw them as billboards. This has the most charm, but rotation needs four sprite sets.
3. *Low-poly kits* (Kenney city kit, glTF) with a palette-quantize pass. More detail without hand-modelling.
4. *Engine switch* (Godot / Bevy) only if this becomes a native always-on desktop app. The data layer (`scan.mjs`) carries over either way.

**Packaging.** It could become an Electron or Tauri menubar app with an always-on-top mini city, or a Claude Code *mod* panel that sits beside the chat.

## Files

- `scan.mjs`: streams transcripts (with a regex fast path, since they total 3GB+), summarises each session, caches by mtime and size in `.cache/scan.json`, reads live sessions, and computes cross-project links.
- `server.mjs`: `/api/city`, `/api/live`, `POST /api/open`, and static files.
- `public/city.js`: layout, scene, shaders, live layer, UI.
