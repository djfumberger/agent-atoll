// Villagers that talk about a project: builds a records sheet from the scanned data and asks a
// tool-less, non-persisted `claude -p` to answer in character. Runs from a scratch cwd so these
// chats never show up as projects themselves.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const WORKDIR = path.join(os.tmpdir(), 'agent-atoll-npc');
const MODEL = process.env.NPC_MODEL || 'haiku';
const cache = new Map();

const PERSONA = {
  elder: 'the village elder, who remembers the whole history of the island and gives wise, practical advice',
  keeper: 'the island keeper of a small, young island, friendly and curious about what it will become',
  harbour: 'the harbourmaster, who knows every sea route, which islands trade files with this one, and why',
  foreman: 'the construction foreman, busy overseeing the build that is happening right now',
  messenger: 'the messenger, who carries word of sessions that are waiting for the traveller to reply',
  crier: 'the town crier of the Home Isles, who rings a bell and reads the daily Gazette covering every island',
};

const day = t => new Date(t).toISOString().slice(0, 10);

function readme(cwd) {
  for (const f of ['README.md', 'CLAUDE.md', 'readme.md']) {
    try { return fs.readFileSync(path.join(cwd, f), 'utf8').slice(0, 2500); } catch {}
  }
  return null;
}

function healthLines(h) {
  if (!h) return [];
  if (!h.repo) return ['Not a git repository.'];
  const out = [`Git: on branch ${h.branch ?? '?'}; ${h.dirty} uncommitted file(s)${h.untracked ? ` (${h.untracked} untracked)` : ''}; ${h.ahead} unpushed commit(s)${h.behind ? `, ${h.behind} behind` : ''}${h.stash ? `; ${h.stash} stash(es)` : ''}.`];
  if (h.lastCommit) out.push(`Last commit ${day(h.lastCommit.at)}: "${h.lastCommit.subject}"`);
  if (h.ci) out.push(`Latest CI run on ${h.ci.branch} (${h.ci.workflow}): ${h.ci.conclusion || h.ci.status} on ${day(h.ci.at)}`);
  if (h.prs?.length) out.push(`Your open PRs: ${h.prs.map(p => `#${p.number} "${p.title}"${p.draft ? ' (draft)' : ''}${p.checks ? ` [checks ${p.checks}]` : ''}`).join('; ')}`);
  else if (h.github && h.ghKnown) out.push('No open PRs of yours.');
  return out;
}

export function projectRecords(p, city, live, health) {
  const cost = p.sessions.reduce((a, s) => a + s.costUSD, 0);
  const branches = [...new Set(p.sessions.flatMap(s => Object.keys(s.branches)))];
  const links = Object.entries(p.links).filter(([c]) => c !== city.home).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const children = city.projects.filter(q => q.parent === p.cwd).map(q => q.name);
  const recent = [...p.sessions].sort((a, b) => b.end - a.end).slice(0, 14);
  const codexN = p.sessions.filter(s => s.source === 'codex').length;
  const lines = [
    `Island (project): ${p.name}`, `Path: ${p.cwd}`,
    `Founded ${day(p.start)}, last active ${day(p.end)} (today is ${day(Date.now())})`,
    `${p.sessions.length} sessions${codexN ? ` (${codexN} with OpenAI Codex, the rest with Claude Code)` : ''}, $${cost.toFixed(2)} spent on Claude, +${p.sessions.reduce((a, s) => a + s.linesAdded, 0)}/-${p.sessions.reduce((a, s) => a + s.linesRemoved, 0)} lines`,
    branches.length ? `Git branches seen: ${branches.join(', ')}` : null,
    children.length ? `Satellite islands (nested projects): ${children.join(', ')}` : null,
    links.length ? `Shares files with: ${links.map(([c, n]) => `${path.basename(c)} (${n} refs)`).join(', ')}` : null,
    ...healthLines(health),
    live.length ? `Live sessions right now:\n${live.map(s => `- ${s.name}: ${s.busy ? `working (last tool ${s.tool || '?'})` : s.status === 'shell' ? 'shell' : 'waiting for the user'}, updated ${day(s.updatedAt)}`).join('\n')}` : 'No live sessions right now.',
    `Recent sessions (newest first):`,
    ...recent.map(s => {
      const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t}×${n}`).join(' ');
      return `- ${day(s.start)} "${s.title || 'untitled'}"${s.source === 'codex' ? ' (Codex)' : ''} — ${s.assistantTurns} replies${s.toolErrors ? `, ${s.toolErrors} tool errors` : ''}${tools ? `, ${tools}` : ''}${s.firstPrompt ? `\n  first ask: ${s.firstPrompt.replace(/\s+/g, ' ').slice(0, 220)}` : ''}${s.lastPrompt && s.lastPrompt !== s.firstPrompt ? `\n  last ask: ${s.lastPrompt.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
    }),
  ];
  const rd = readme(p.cwd);
  if (rd) lines.push(`README excerpt:\n${rd}`);
  return lines.filter(Boolean).join('\n');
}

function run(system, prompt) {
  fs.mkdirSync(WORKDIR, { recursive: true });
  return new Promise((resolve, reject) => {
    const c = spawn('claude', ['-p', '--model', MODEL, '--tools', '', '--no-session-persistence', '--system-prompt', system], { cwd: WORKDIR });
    let out = '', err = '';
    const timer = setTimeout(() => c.kill(), 90_000);
    c.stdout.on('data', d => (out += d));
    c.stderr.on('data', d => (err += d));
    c.on('error', e => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'the claude CLI is not on PATH' : e.message)); });
    c.on('close', code => { clearTimeout(timer); code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(err.trim() || `claude exited ${code}`)); });
    c.stdin.end(prompt);
  });
}

export async function askVillager({ project, city, live, health, role, name, question, history = [] }) {
  const key = JSON.stringify([project.cwd, project.end, role, question, history]);
  if (cache.has(key)) return cache.get(key);
  const system = `You are ${name}, ${PERSONA[role] ?? PERSONA.keeper}, on the island "${project.name}" in Agent Atoll: a cozy archipelago where every island is one of the traveller's coding projects and every building is a coding-agent session (Claude Code, or Codex where noted) they ran there.
Speak in character: warm, a touch whimsical, but concrete and useful. Use the island records below as your only source of facts; quote real session titles and dates. If the records don't say, admit you don't know rather than inventing.
Keep answers to 2-4 short sentences (up to 6 if asked for a summary or plan). Plain text only, no markdown, no lists.`;
  const convo = history.map(h => `Traveller: ${h.q}\n${name}: ${h.a}`).join('\n');
  const prompt = `ISLAND RECORDS\n${projectRecords(project, city, live, health)}\n\n${convo ? convo + '\n' : ''}Traveller: ${question}\n${name}:`;
  const text = await run(system, prompt);
  cache.set(key, text);
  return text;
}

// The town crier's Gazette: one call over a digest of every island's recent activity and health.
export async function askCrier({ city, live, health, name, question, history = [] }) {
  const since = Date.now() - 3 * 864e5;
  const digest = city.projects.map(p => {
    const recent = p.sessions.filter(s => s.end > since).sort((a, b) => b.end - a.end);
    const waiting = live.filter(s => (s.cwd === p.cwd || s.cwd.startsWith(p.cwd + '/')) && !s.busy && s.status !== 'shell');
    const busy = live.filter(s => (s.cwd === p.cwd || s.cwd.startsWith(p.cwd + '/')) && s.busy);
    const h = health[p.cwd];
    const notes = healthLines(h).filter(l => !/^Not a git/.test(l) && !/No open PRs/.test(l));
    if (!recent.length && !waiting.length && !busy.length && !(h && (h.ci?.conclusion === 'failure' || h.prs?.length || h.dirty > 20))) return null;
    return [`## ${p.name} (${p.sessions.length} sessions, last active ${day(p.end)})`,
      busy.length ? `Working now: ${busy.map(s => `${s.name} (${s.tool || '…'})`).join(', ')}` : null,
      waiting.length ? `Waiting on the traveller: ${waiting.length} session(s)` : null,
      ...recent.slice(0, 5).map(s => `- ${day(s.end)} "${s.title || 'untitled'}"${s.source === 'codex' ? ' [Codex]' : ''} (${s.assistantTurns} replies${s.toolErrors ? `, ${s.toolErrors} errors` : ''})`),
      ...notes].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n');
  const key = JSON.stringify(['crier', day(Date.now()), new Date().getHours() >> 2, question, history]);
  if (cache.has(key)) return cache.get(key);
  const system = `You are ${name}, ${PERSONA.crier}, in Agent Atoll: a cozy archipelago where every island is one of the traveller's coding projects, every building a coding-agent session (Claude Code or Codex), ships at anchor are open pull requests, storms are failing CI, and crates on the docks are uncommitted changes.
Speak like a cheerful town crier ("Hear ye!") but be concrete and useful: real island names, real session titles, real numbers, from the digest only. Never invent.
For the Gazette: 4-7 short headline-style lines, most important first (storms, things waiting on the traveller, big progress), each on its own line starting with "• ", then one closing line suggesting what to do first. For other questions: 2-4 sentences. Plain text, no markdown.`;
  const convo = history.map(h => `Traveller: ${h.q}\n${name}: ${h.a}`).join('\n');
  const text = await run(system, `TODAY: ${day(Date.now())}\nDIGEST OF THE LAST 3 DAYS\n${digest || '(quiet: nothing happened)'}\n\n${convo ? convo + '\n' : ''}Traveller: ${question}\n${name}:`);
  cache.set(key, text);
  return text;
}
