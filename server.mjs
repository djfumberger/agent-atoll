// Local-only server: serves the city UI, the scanned model, live session state,
// and a couple of actions (resume / open a session in Terminal).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scan, readLive, lastActivity } from './scan.mjs';
import { readCodexLive } from './codex.mjs';
import { askVillager, askCrier } from './npc.mjs';
import { healthFor } from './health.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let ROOT = path.join(HERE, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

// ~/.agent-atoll/config.json → { "exclude": ["project-name" | "/abs/path", …], "aliases": { "ac": "acme" } }.
// Excluded projects take their nested projects with them; aliases fold name prefixes into one archipelago.
// AGENT_ATOLL_EXCLUDE (comma-separated, set by --exclude) adds to the list.
export const DATA_DIR = process.env.AGENT_ATOLL_HOME || path.join(os.homedir(), '.agent-atoll');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } };
function excluder() {
  let list = (process.env.AGENT_ATOLL_EXCLUDE || '').split(',').map(s => s.trim()).filter(Boolean);
  list = list.concat(readConfig().exclude ?? []);
  return cwd => list.some(e => e.startsWith('/') ? cwd === e || cwd.startsWith(e + '/')
    : cwd.split('/').some((seg, i, a) => seg === e && i === a.length - 1) || cwd.includes('/' + e + '/'));
}

let city = null, scanning = null;
async function getCity(force) {
  if (city && !force && Date.now() - city.generatedAt < 30_000) return city;
  scanning ??= scan().then(c => {
    const excluded = excluder();
    c.projects = c.projects.filter(p => !excluded(p.cwd));
    for (const p of c.projects) for (const k of Object.keys(p.links)) if (excluded(k)) delete p.links[k];
    c.live = c.live.filter(s => !excluded(s.cwd));
    c.aliases = readConfig().aliases ?? {};
    return (city = c);
  }).finally(() => (scanning = null));
  return scanning;
}

const dirFor = cwd => cwd.replace(/[^A-Za-z0-9-]/g, '-');

function live() {
  const codex = (process.env.AGENT_ATOLL_SOURCES || 'claude,codex').includes('codex') ? readCodexLive() : [];
  return readLive().map(s => ({ ...s, source: 'claude' })).map(s => {
    const act = lastActivity([dirFor(s.cwd)], s.sessionId);
    // A transcript written in the last 20s means the agent is working even if status lags.
    const writing = act && Date.now() - act.mtime < 20_000;
    return { ...s, tool: act?.tool ?? null, busy: s.status === 'busy' || !!writing };
  }).concat(codex);
}

const shq = s => `'${s.replace(/'/g, `'\\''`)}'`;
const asq = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// macOS opens a Terminal window; elsewhere the client copies the command instead.
function openTerminal(cwd, sessionId, agent) {
  const cmd = `cd ${shq(cwd)} && ${agent === 'codex' ? `codex${sessionId ? ` resume ${sessionId}` : ''}` : `claude${sessionId ? ` --resume ${sessionId}` : ''}`}`;
  if (process.platform !== 'darwin') return Promise.resolve({ manual: true, cmd });
  return new Promise((res, rej) => execFile('osascript', [
    '-e', `tell application "Terminal" to do script "${asq(cmd)}"`,
    '-e', 'tell application "Terminal" to activate',
  ], err => (err ? rej(err) : res({ cmd }))));
}

const readBody = async req => { let b = ''; for await (const chunk of req) b += chunk; return JSON.parse(b || '{}'); };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/city') return json(res, 200, await getCity(url.searchParams.has('fresh')));
    if (url.pathname === '/api/live') { const ex = excluder(); return json(res, 200, { now: Date.now(), live: live().filter(s => !ex(s.cwd)) }); }
    if (url.pathname === '/api/open' && req.method === 'POST') {
      const { cwd, sessionId, agent } = await readBody(req);
      const c = await getCity();
      if (!c.projects.some(p => p.cwd === cwd)) return json(res, 400, { error: 'unknown project' });
      if (sessionId && !/^[0-9a-f-]{36}$/.test(sessionId)) return json(res, 400, { error: 'bad session id' });
      return json(res, 200, { ok: true, ...await openTerminal(cwd, sessionId, agent) });
    }
    if (url.pathname === '/api/npc' && req.method === 'POST') {
      const b = await readBody(req);
      const c = await getCity();
      const project = c.projects.find(p => p.cwd === b.cwd);
      if (!project) return json(res, 400, { error: 'unknown project' });
      const history = (Array.isArray(b.history) ? b.history : []).slice(-6).map(h => ({ q: String(h.q).slice(0, 500), a: String(h.a).slice(0, 1500) }));
      const text = await askVillager({
        project, city: c, health: healthFor([project.cwd])[project.cwd], role: String(b.role), name: String(b.name).slice(0, 40), question: String(b.question || '').slice(0, 500), history,
        live: live().filter(s => s.cwd === project.cwd || s.cwd.startsWith(project.cwd + '/')),
      });
      return json(res, 200, { text });
    }
    if (url.pathname === '/api/health') { const c = await getCity(); return json(res, 200, healthFor(c.projects.map(p => p.cwd))); }
    if (url.pathname === '/api/crier' && req.method === 'POST') {
      const b = await readBody(req), c = await getCity(), ex = excluder();
      const history = (Array.isArray(b.history) ? b.history : []).slice(-6).map(h => ({ q: String(h.q).slice(0, 500), a: String(h.a).slice(0, 2000) }));
      const text = await askCrier({ city: c, live: live().filter(s => !ex(s.cwd)), health: healthFor(c.projects.map(p => p.cwd)),
        name: String(b.name).slice(0, 40), question: String(b.question || '').slice(0, 500), history });
      return json(res, 200, { text });
    }
    const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

// Serves `publicDir` on the first free port from `port` up; resolves with the port actually used.
export function start({ port = 4777, publicDir = ROOT, tries = 20 } = {}) {
  ROOT = publicDir;
  return new Promise((resolve, reject) => {
    const attempt = p => {
      server.once('error', e => (e.code === 'EADDRINUSE' && p < port + tries ? attempt(p + 1) : reject(e)));
      server.listen(p, '127.0.0.1', () => { getCity(); resolve(p); });
    };
    attempt(port);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const p = await start({ port: Number(process.env.PORT || 4777) });
  console.log(`Claude City → http://localhost:${p}`);
}
