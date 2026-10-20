// Scans ~/.claude into a city model: projects -> sessions -> activity, plus live sessions.
// Transcripts are large (GBs), so each file is summarised once and cached by mtime+size.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { scanCodex } from './codex.mjs';

import { fileURLToPath } from 'node:url';

const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS = path.join(CLAUDE, 'projects');
const SESSIONS = path.join(CLAUDE, 'sessions');
const CACHE_FILE = path.join(process.env.AGENT_ATOLL_HOME || path.join(os.homedir(), '.agent-atoll'), 'cache', 'scan.json');

const TOOL_RE = /"type":"tool_use","id":"[^"]+","name":"([^"]+)"/g;
const PATH_RE = /"(?:file_path|path|notebook_path)":"(\/[^"]{1,300})"/g;
const MAX_PARSE = 512 * 1024;

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}

async function summariseTranscript(file) {
  const st = fs.statSync(file);
  const key = `v2:${st.mtimeMs}:${st.size}`;
  if (cache[file]?.key === key) return cache[file].data;

  const s = {
    id: path.basename(file, '.jsonl'), cwd: null, start: null, end: null,
    userTurns: 0, assistantTurns: 0, tools: {}, toolErrors: 0, title: null, firstPrompt: null,
    lastPrompt: null, branches: {}, costUSD: 0, linesAdded: 0, linesRemoved: 0,
    touched: {}, // absolute paths outside cwd -> count (for cross-project links)
  };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.startsWith('{"type":"api-request')) continue;
    if (line.startsWith('{"type":"ai-title"')) { s.title = JSON.parse(line).aiTitle; continue; }
    if (line.startsWith('{"type":"last-prompt"')) { s.lastPrompt = JSON.parse(line).lastPrompt; continue; }
    if (line.startsWith('{"type":"cost-state"')) {
      const c = JSON.parse(line);
      s.costUSD = c.totalCostUSD || 0; s.linesAdded = c.totalLinesAdded || 0; s.linesRemoved = c.totalLinesRemoved || 0;
      continue;
    }
    if (!line.startsWith('{"parentUuid')) continue;
    const isUser = line.includes('"type":"user"'), isAsst = line.includes('"type":"assistant"');
    if (!isUser && !isAsst) continue;
    const ts = line.match(/"timestamp":"([^"]+)"/)?.[1];
    if (ts) { const t = Date.parse(ts); if (!s.start || t < s.start) s.start = t; if (!s.end || t > s.end) s.end = t; }
    if (!s.cwd) s.cwd = line.match(/"cwd":"([^"]+)"/)?.[1] ?? null;
    const br = line.match(/"gitBranch":"([^"]*)"/)?.[1];
    if (br && br !== 'HEAD') s.branches[br] = (s.branches[br] || 0) + 1;
    if (isAsst) {
      s.assistantTurns++;
      for (const m of line.matchAll(TOOL_RE)) s.tools[m[1]] = (s.tools[m[1]] || 0) + 1;
      for (const m of line.matchAll(PATH_RE)) s.touched[m[1]] = (s.touched[m[1]] || 0) + 1;
    } else if (line.includes('"tool_result"')) {
      s.toolErrors += (line.match(/"is_error":true/g) || []).length;
    } else if (!line.includes('"isMeta":true')) {
      s.userTurns++;
      if (!s.firstPrompt && line.length < MAX_PARSE) {
        try {
          const c = JSON.parse(line).message?.content;
          const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.find(b => b.type === 'text')?.text : null;
          if (txt && !txt.startsWith('<')) s.firstPrompt = txt.slice(0, 280);
        } catch {}
      }
    }
  }
  // Subagents live in <session>/subagents/*.jsonl
  const subDir = path.join(path.dirname(file), s.id, 'subagents');
  s.subagents = fs.existsSync(subDir) ? fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl')).length : 0;
  s.mtime = st.mtimeMs;
  cache[file] = { key, data: s };
  return s;
}

export function readLive() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(SESSIONS).filter(f => /^\d+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8'));
      try { process.kill(o.pid, 0); } catch { continue; } // stale record, process gone
      out.push({ pid: o.pid, sessionId: o.sessionId, cwd: o.cwd, status: o.status, name: o.name,
        startedAt: o.startedAt, updatedAt: o.statusUpdatedAt || o.updatedAt });
    } catch {}
  }
  return out;
}

// Last tool used by a live session (tail of its transcript) — shown as the agent's speech bubble.
export function lastActivity(projectDirs, sessionId) {
  for (const dir of projectDirs) {
    const file = path.join(PROJECTS, dir, sessionId + '.jsonl');
    if (!fs.existsSync(file)) continue;
    const st = fs.statSync(file);
    const len = Math.min(st.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const tools = [...tail.matchAll(TOOL_RE)].map(m => m[1]);
    return { tool: tools.at(-1) ?? null, mtime: st.mtimeMs };
  }
  return null;
}

export async function scan() {
  // AGENT_ATOLL_SOURCES=claude,codex (default both) picks whose history becomes islands.
  const sources = (process.env.AGENT_ATOLL_SOURCES || 'claude,codex').split(',');
  const dirs = sources.includes('claude') && fs.existsSync(PROJECTS)
    ? fs.readdirSync(PROJECTS).filter(d => !d.startsWith('-private-') && fs.statSync(path.join(PROJECTS, d)).isDirectory()) : [];
  const byCwd = new Map();
  for (const dir of dirs) {
    const files = fs.readdirSync(path.join(PROJECTS, dir)).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const s = { ...await summariseTranscript(path.join(PROJECTS, dir, f)), source: 'claude' };
      if (!s.start || s.userTurns === 0) continue;
      const cwd = s.cwd || dir;
      if (!byCwd.has(cwd)) byCwd.set(cwd, { cwd, dirs: new Set(), sessions: [] });
      const p = byCwd.get(cwd);
      p.dirs.add(dir);
      p.sessions.push(s);
    }
  }
  if (sources.includes('codex')) {
    for (const { parent, ...s } of await scanCodex()) {
      if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, { cwd: s.cwd, dirs: new Set(), sessions: [] });
      byCwd.get(s.cwd).sessions.push(s);
    }
  }
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));

  const cwds = [...byCwd.keys()].sort((a, b) => b.length - a.length);
  const ownerOf = p => cwds.find(c => p === c || p.startsWith(c + '/'));

  const projects = [...byCwd.values()].map(p => {
    const links = {};
    const sessions = p.sessions.map(s => {
      for (const [file, n] of Object.entries(s.touched)) {
        const owner = ownerOf(file);
        if (owner && owner !== p.cwd && !owner.startsWith(p.cwd + '/') && !p.cwd.startsWith(owner + '/')) links[owner] = (links[owner] || 0) + n;
      }
      const { touched, ...rest } = s;
      return rest;
    }).sort((a, b) => a.start - b.start);
    const parent = cwds.filter(c => p.cwd.startsWith(c + '/')).sort((a, b) => b.length - a.length)[0] ?? null;
    return {
      cwd: p.cwd, name: path.basename(p.cwd), parent, dirs: [...p.dirs], links, sessions,
      start: sessions[0].start, end: Math.max(...sessions.map(s => s.end)),
    };
  });
  return { generatedAt: Date.now(), home: os.homedir(), projects, live: readLive() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const t = Date.now();
  const city = await scan();
  const n = city.projects.reduce((a, p) => a + p.sessions.length, 0);
  console.error(`scanned ${city.projects.length} projects, ${n} sessions, ${city.live.length} live in ${Date.now() - t}ms`);
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(city));
}
