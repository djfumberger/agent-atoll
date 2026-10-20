#!/usr/bin/env node
// agent-atoll: your Claude Code and Codex projects as a living archipelago. Starts the local server and opens the browser.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HELP = `agent-atoll — see your Claude Code and Codex projects as islands (or a city)

Usage: npx agent-atoll [options]

  --city             the original isometric city view instead of the islands
  --port <n>         port to try first (default 4778, or 4777 for --city)
  --exclude <a,b>    hide projects by folder name or absolute path
  --only <agent>     just claude or just codex (default: both, whichever you have)
  --no-open          don't open a browser
  -h, --help         show this help

Reads ~/.claude and ~/.codex (or $CLAUDE_CONFIG_DIR / $CODEX_HOME). Everything stays on your machine.
Settings and cache live in ~/.agent-atoll (config.json: { "exclude": [...] }).
Optional extras: the gh CLI (PR ships, CI storms), claude on PATH (talking villagers),
and zstd on older Node versions (compressed Codex history).`;

let opts;
try {
  opts = parseArgs({ options: {
    city: { type: 'boolean' }, only: { type: 'string' }, port: { type: 'string' }, exclude: { type: 'string' },
    'no-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } }).values;
} catch (e) { console.error(`${e.message}\n\n${HELP}`); process.exit(1); }
if (opts.help) { console.log(HELP); process.exit(0); }

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) { console.error('agent-atoll needs Node 18 or newer.'); process.exit(1); }
if (opts.exclude) process.env.AGENT_ATOLL_EXCLUDE = opts.exclude;
if (opts.only) {
  if (!['claude', 'codex'].includes(opts.only)) { console.error('--only takes claude or codex'); process.exit(1); }
  process.env.AGENT_ATOLL_SOURCES = opts.only;
}

const { start, DATA_DIR } = await import('../server.mjs');
const publicDir = fileURLToPath(new URL(opts.city ? '../public' : '../islands/public', import.meta.url));
const port = await start({ port: Number(opts.port || (opts.city ? 4777 : 4778)), publicDir });
const url = `http://localhost:${port}`;
console.log(`${opts.city ? 'Claude City' : 'Agent Atoll'} → ${url}\nScanning your coding-agent history (the first run can take a minute; cached in ${DATA_DIR}). Ctrl+C to stop.`);

if (!opts['no-open']) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  execFile(cmd, args, () => {});
}
