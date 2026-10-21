# Agent Atoll

Your Claude Code and Codex history as a living archipelago. Every project folder is an island, every session a building, live agents build in real time, and repo health shows up as weather and harbour life.

![Agent Atoll](https://raw.githubusercontent.com/djfumberger/agent-atoll/main/docs/screenshot.png)

## Run it

```
npx agent-atoll
```

That's it. Your browser opens on your own archipelago. You need Node 18 or newer.

Everything stays on your machine: it reads `~/.claude` and `~/.codex` and uploads nothing. The first run takes a minute to scan your history, and later runs are quick.

Want a look first? Try the demo with sample projects at https://agent-atoll.pages.dev

## What you can do

- **Explore.** Drag to pan, right-drag to orbit, scroll to zoom. Click an island or a building for its sessions and stats.
- **Watch agents work.** Live sessions put up scaffolding and show the tool they're using. The list on the left shows who's working and who's waiting on you.
- **Jump to an agent.** Click ↗ next to a live agent to bring its terminal tab to the front.
- **Resume a session.** Open any building and pick "Resume in Terminal".
- **Read the weather.** A failing CI run brings storms, open PRs anchor as ships, and uncommitted work piles up as crates on the docks.
- **Talk to the locals.** Click a villager to ask about the project, or read the town crier's Gazette for a summary of everything.
- **Take the tour.** Hop in the seaplane for a flight over your busiest islands.

## Options

```
npx agent-atoll --only claude        # just Claude Code (or --only codex)
npx agent-atoll --exclude scratch,tmp
npx agent-atoll --port 5000 --no-open
```

To always hide some projects, or to group related repos into one archipelago, create `~/.agent-atoll/config.json`:

```json
{
  "exclude": ["scratch", "/Users/you/old-stuff"],
  "aliases": { "ac": "acme" }
}
```

With that alias, `ac-api` and `acme-web` share an archipelago.

## Optional extras

- **`gh` CLI, logged in:** PR ships and CI storms.
- **`claude` on your PATH:** villagers and the town crier can answer questions.
- **`zstd`:** needed to read compressed Codex history on Node versions older than 23.8.

Opening and focusing terminals works on macOS (Terminal.app and iTerm2 get the exact tab). On other systems, "Resume" copies the command for you to paste instead.

## License

MIT. Want to hack on it? See [CONTRIBUTING.md](CONTRIBUTING.md).
