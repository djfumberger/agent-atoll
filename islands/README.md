# Agent Atoll

Your coding-agent history, drawn as an archipelago. A project starts as a tiny sandbar with a tent and campfire, and grows into an outpost, then a village, a town, and finally a city as sessions accumulate.

```
node islands/server.mjs   # → http://localhost:4778
```

It reuses `../scan.mjs` and the API from `../server.mjs`. Only the front end differs.

| Claude Code | On the islands |
|---|---|
| Project | Island. The radius grows with the session count, and the coastline is a noise shape seeded from the path |
| Session | A structure on a sunflower spiral from the centre. The first is a tent and campfire, then cabins, then pastel houses, then towers. Bash-heavy sessions become workshops with chimneys, research sessions round towers, and sessions with 3+ subagents lighthouses |
| Nested project | Satellite island joined by a wooden bridge, built plank by plank when it's founded |
| Name family | Archipelago ("Tide Archipelago" for `tide-api`, `tide-web`, …) with a ferry rowboat between its towns |
| Cross-project file refs | Trade route with sailboats, which pause at each end as if loading cargo |
| Busy session | Scaffolding around its building, chimney smoke, a hammering villager, a ⚙ marker and a tool bubble |
| Waiting on you | Villager waiting at the end of the dock, with a green ! marker |
| History | ▶ replay. Islands rise out of the sea and swell as sessions arrive |

Rendering notes:
- Props are merged per island (a few draw calls each). Every vertex carries its prop's origin and birth day, so growth with a pop and overshoot runs in the vertex shader.
- Rim decor (palms, rocks, dock) is stored in unit-island coordinates, so it rides the shoreline as the island grows.
- The ocean is one shader. It computes the distance to every island's analytic coastline (the same `shape()` as the terrain), and uses it for the turquoise shallows, Voronoi lace foam, incoming swells, whitecaps, boat wakes and sun glints.
- Rendering uses ACES tone mapping, soft shadows that follow the camera, and bloom for campfires and lit windows at night (N).

## Villagers

Click a villager to talk. Their opening lines and buttons come from your session records. **Ask…** (and the 💬 options) sends the question to a tool-less, non-persisted `claude -p --model haiku` (`npc.mjs`; override with `NPC_MODEL`). It gets a records sheet: session titles and prompts, dates, cost, branches, links, live state, and the README. Those runs execute from `/private/tmp/agent-atoll-npc`, so they never become islands.

| Villager | Where | Knows / asks |
|---|---|---|
| Elder (3+ sessions) / Keeper | by the campfire | the island's story, what's recent, what to do next; asks about stale islands and unmerged branches |
| Harbourmaster | on the dock | sea routes and bridges, why islands trade files; "Sail to …" |
| Foreman | next to a busy build | what's being built right now; jump into that session |
| Messenger | walking the streets | every session waiting on you, with your last message; "Reply to …" resumes it |

## Weather & harbour life

Repo health comes from `../health.mjs`. Local git state is refreshed every 30s. Your open PRs and the latest CI run come from `gh` every 5 minutes, three repos at a time. The page polls `/api/health`.

| Signal | On the island |
|---|---|
| Latest CI run on the current branch failed | ⛈️ thunderstorm: dark cloud, heavy rain, lightning, darker water |
| One of your PRs has failing checks, or recent sessions hit lots of tool errors | 🌧️ rain cloud |
| Untouched for 3+ weeks | 🌫️ fog drifting around the coast |
| Uncommitted files | 📦 a crate per file stacked by the dock (up to 18) |
| Unpushed commits | 🛶 a cargo boat moored at the dock with a barrel per commit |
| Your open PRs | ⛵ ships at anchor offshore. The flag shows checks (green / red / amber), and drafts have furled sails. Click to open on GitHub |
| Stashes | 💰 buried treasure on the beach |

Hover anything for details. The project panel has a *Harbour & weather* section. **Weather (W)** hides the clouds.

## Town crier

Nell (or whoever's on duty) stands on the Home Isles with a bell and a scroll. The opening line is instant, built from the data: who's working, who's waiting, storm warnings, ships at anchor, crates on the docks, the longest wait. **📰 Read today's Gazette** sends a digest of the last three days across every island (sessions, errors, health) to Claude, and gets back headline-style news. **📰 Gazette (G)** in the toolbar takes you straight to the crier. The digest is cached in 4-hour blocks.

## Other controls

- **✈ Tour (T)**: a seaplane flies past busy islands, ones waiting on you, the biggest, the newest and a few quiet ones, with a caption from each island's elder. Click, drag or press Esc to take back control.
- **Labels** cycles All → Hover (only the island under the pointer) → Off. The choice is remembered.
- **Excluding projects**: list names or absolute paths in `~/.agent-atoll/config.json` under `"exclude"`, or pass `--exclude a,b`. Nested projects go too. This applies to both apps.

## Water

Distance-to-shore is baked into a 1024² half-float texture whenever an island changes size. Before this, every pixel looped over every island. Noise, lace, caustics and the wave normal map are tileable textures generated once at startup. The seabed gets animated caustics in the terrain shader, and the pixel ratio is capped at 1.5.

## Building models

Houses, cabins, workshops, towers and tents are low-poly models built in Blender by `tools/blender/build_houses.py`. It's one seeded script, so the output is deterministic. Every face carries a material role (wall, roof, wood, trim, stone, door, glass, accent or metal), so the app tints walls and roofs per building and lights each window at night. Towers and houses are stacked from storey pieces to match the session's size.

```
/Applications/Blender.app/Contents/MacOS/Blender -b --python tools/blender/build_houses.py   # → tools/blender/out/*.glb + preview.png
node tools/bake-houses.mjs                                                                   # → islands/public/models/houses.json
```

Add `?houses=classic` to the URL to see the original box-built prefabs. The app also falls back to those if the model file is missing.
