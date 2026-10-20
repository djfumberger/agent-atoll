// Codex sessions, read from ~/.codex/sessions rollouts (plain or zstd-compressed .jsonl) into the same
// session shape scan.mjs produces, so Codex work joins the same islands. Cached by mtime+size.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';

const CODEX = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS = path.join(CODEX, 'sessions');
const CACHE_FILE = path.join(process.env.AGENT_ATOLL_HOME || path.join(os.homedir(), '.agent-atoll'), 'cache', 'codex.json');
const MAX_PARSE = 512 * 1024;
const PATH_RE = /(?<![\w.~-])(\/(?:Users|Volumes|home|opt|srv|var\/www)\/[^\s"'\\`|;,()<>*]{2,300})/g;
const READ_CMD = /^(?:\\"|")?(?:rg|grep|cat|sed -n|ls|find|head|tail|wc|nl|tree|git (?:log|show|diff|status|grep))\b/;

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}

let zstdCli;
function openRollout(file) {
  if (!file.endsWith('.zst')) return fs.createReadStream(file, { encoding: 'utf8' });
  if (zlib.createZstdDecompress) return fs.createReadStream(file).pipe(zlib.createZstdDecompress()).setEncoding('utf8');
  zstdCli ??= (() => { try { execFileSync('zstd', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (!zstdCli) return null;
  return spawn('zstd', ['-dcq', file], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout.setEncoding('utf8');
}

const userText = line => {
  if (line.length > MAX_PARSE) return null;
  try {
    const c = JSON.parse(line).payload.content;
    // Skip blocks the app injects (environment, browser state, referenced chats, review history).
    const t = (Array.isArray(c) ? c : []).filter(b => b.type === 'input_text').map(b => b.text.trim())
      .filter(x => x && !/^(<|## Referenced|# In app browser|The following is the Codex agent history)/.test(x));
    return t.length ? t.join('\n') : null;
  } catch { return null; }
};

async function summarise(file) {
  const st = fs.statSync(file);
  const key = `cx1:${st.mtimeMs}:${st.size}`;
  if (cache[file]?.key === key) return cache[file].data;
  const stream = openRollout(file);
  if (!stream) return null;
  const s = {
    id: null, cwd: null, start: null, end: null, userTurns: 0, assistantTurns: 0, tools: {}, toolErrors: 0,
    title: null, firstPrompt: null, lastPrompt: null, branches: {}, costUSD: 0, linesAdded: 0, linesRemoved: 0,
    touched: {}, subagents: 0, source: 'codex', parent: null, tokens: 0,
  };
  const tool = n => (s.tools[n] = (s.tools[n] || 0) + 1);
  for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
    const head = line.slice(0, 400);
    const ts = head.match(/^\{"timestamp":"([^"]+)"/)?.[1];
    if (ts) { const t = Date.parse(ts); if (!s.start || t < s.start) s.start = t; if (!s.end || t > s.end) s.end = t; }
    const m = head.match(/"type":"(\w+)","payload":\{"type":"(\w+)"/);
    const type = m?.[1] ?? head.match(/"type":"(\w+)"/)?.[1], ptype = m?.[2];
    if (type === 'session_meta') {
      try {
        const p = JSON.parse(line).payload;
        s.id = p.id; s.cwd = p.cwd; s.parent = p.parent_thread_id || null;
        if (p.thread_source && p.thread_source !== 'user') s.parent ??= p.session_id !== p.id ? p.session_id : null;
        if (p.git?.branch) s.branches[p.git.branch] = 1;
      } catch {}
    } else if (type === 'turn_context') {
      s.cwd ??= line.match(/"cwd":"([^"]+)"/)?.[1] ?? null;
    } else if (type === 'response_item' && ptype === 'message') {
      const role = head.match(/"role":"(\w+)"/)?.[1];
      if (role === 'assistant') s.assistantTurns++;
      else if (role === 'user') {
        const t = userText(line);
        if (t) { s.userTurns++; s.firstPrompt ??= t.slice(0, 280); s.lastPrompt = t.slice(0, 280); }
      }
    } else if (type === 'response_item' && (ptype === 'function_call' || ptype === 'custom_tool_call')) {
      const name = line.match(/"name":"([^"]+)"/)?.[1] ?? ptype;
      if (name === 'exec' || name === 'exec_command' || name === 'shell') {
        // One generic tool does everything in Codex; split it so islands get the same building mix as Claude's.
        if (line.includes('apply_patch')) {
          tool('apply_patch');
          s.linesAdded += (line.match(/\\n\+(?!\+\+)/g) || []).length;
          s.linesRemoved += (line.match(/\\n-(?!--)/g) || []).length;
        } else {
          const cmd = line.match(/"(?:arguments|input)":"(?:\{\\"(?:cmd|command)\\":\[?)?(.{0,80})/)?.[1] ?? '';
          tool(READ_CMD.test(cmd.replace(/^\\"(?:bash|zsh)\\",\\"-l?c\\",/, '')) ? 'search' : 'shell');
        }
      } else tool(name);
      for (const [, p] of line.matchAll(PATH_RE)) s.touched[p] = (s.touched[p] || 0) + 1;
    } else if (type === 'response_item' && (ptype === 'function_call_output' || ptype === 'custom_tool_call_output')) {
      if (/\\"exit_code\\":[1-9]|Exit code: [1-9]/.test(line)) s.toolErrors++;
    } else if (type === 'event_msg' && ptype === 'token_count') {
      const t = line.match(/"total_token_usage":\{"input_tokens":(\d+)[^}]*"output_tokens":(\d+)/);
      if (t) s.tokens = Math.max(s.tokens, +t[1] + +t[2]);
    }
  }
  s.id ??= path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl/)?.[1] ?? path.basename(file);
  s.mtime = st.mtimeMs;
  cache[file] = { key, data: s };
  return s;
}

function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/^rollout-.*\.jsonl(\.zst)?$/.test(e.name)) out.push(p);
  }
  return out;
}

function titles() {
  const out = {};
  try {
    for (const l of fs.readFileSync(path.join(CODEX, 'session_index.jsonl'), 'utf8').split('\n')) {
      try { const o = JSON.parse(l); if (o.thread_name) out[o.id] = o.thread_name; } catch {}
    }
  } catch {}
  return out;
}

export const hasCodex = () => fs.existsSync(SESSIONS);

// Top-level Codex sessions with titles; subagent / auto-review threads count toward their parent.
export async function scanCodex() {
  if (!hasCodex()) return [];
  const all = [];
  for (const f of walk(SESSIONS)) { const s = await summarise(f); if (s?.start && s.cwd) all.push(s); }
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  const byId = new Map(all.map(s => [s.id, s]));
  const t = titles();
  const top = [];
  for (const s of all) {
    const parent = s.parent && byId.get(s.parent);
    if (parent) { parent.subagents++; continue; }
    if (!s.userTurns) continue;
    top.push({ ...s, title: t[s.id] ?? null });
  }
  return top;
}

// Codex has no per-session status file; a plain (still uncompressed) rollout written in the last
// couple of minutes is a session at work. Returns live records shaped like scan.mjs's readLive().
export function readCodexLive() {
  if (!hasCodex()) return [];
  const now = Date.now(), out = [];
  const t = titles();
  for (const f of walk(SESSIONS)) {
    if (f.endsWith('.zst')) continue;
    const st = fs.statSync(f);
    if (now - st.mtimeMs > 120_000) continue;
    const len = Math.min(st.size, 128 * 1024), buf = Buffer.alloc(len), fd = fs.openSync(f, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const started = tail.lastIndexOf('"type":"task_started"'), done = Math.max(tail.lastIndexOf('"type":"task_complete"'), tail.lastIndexOf('"type":"turn_aborted"'));
    const id = cache[f]?.data?.id ?? path.basename(f).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl/)?.[1];
    const cwd = cache[f]?.data?.cwd ?? tail.match(/"cwd":"([^"]+)"/)?.[1];
    if (!id || !cwd) continue;
    const busy = started > done || now - st.mtimeMs < 20_000;
    const names = [...tail.matchAll(/"type":"(?:function_call|custom_tool_call)"[^\n]{0,200}?"name":"([^"]+)"/g)].map(m => m[1]);
    out.push({ pid: null, sessionId: id, cwd, status: busy ? 'busy' : 'idle', name: t[id] ?? 'Codex session', source: 'codex',
      startedAt: cache[f]?.data?.start ?? st.birthtimeMs, updatedAt: st.mtimeMs, tool: names.at(-1) ?? null, busy });
  }
  return out;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const t = Date.now();
  const s = await scanCodex();
  const tools = {};
  for (const x of s) for (const [k, n] of Object.entries(x.tools)) tools[k] = (tools[k] || 0) + n;
  console.log(`${s.length} codex sessions in ${new Set(s.map(x => x.cwd)).size} folders, ${Date.now() - t}ms`, tools);
  console.log(s.slice(-3).map(({ touched, ...x }) => x));
  console.log('live', readCodexLive());
}
