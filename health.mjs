// Repo health per project, for weather and harbour life: local git state (cheap, refreshed often)
// plus GitHub PRs and CI via `gh` (network, refreshed slowly, a few at a time). Never blocks:
// callers get whatever is cached and a refresh is kicked off in the background.
import { execFile } from 'node:child_process';

const GIT_TTL = 30_000, GH_TTL = 5 * 60_000, GH_CONCURRENCY = 3;
const cache = new Map();   // cwd -> { git, gh, gitAt, ghAt }
const inflight = new Set();
let ghRunning = 0;
const ghQueue = [];

const run = (cmd, args, cwd, timeout = 8000) => new Promise(resolve =>
  execFile(cmd, args, { cwd, timeout, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? null : stdout.toString())));

async function gitState(cwd) {
  const inside = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  if (!inside) return { repo: false };
  const top = inside.trim();
  const [status, log, stash, remote] = await Promise.all([
    run('git', ['status', '--porcelain=v1', '-b', '--', '.'], cwd),
    run('git', ['log', '-1', '--format=%ct%x09%s'], cwd),
    top === cwd ? run('git', ['stash', 'list'], cwd) : Promise.resolve(''),
    run('git', ['remote', 'get-url', 'origin'], cwd),
  ]);
  const lines = (status ?? '').split('\n').filter(Boolean);
  const head = lines[0]?.startsWith('##') ? lines.shift() : '';
  const branch = head.match(/^## (?:No commits yet on )?([^.\s]+)/)?.[1] ?? null;
  const [ts, subject] = (log ?? '').trim().split('\t');
  const gh = remote?.trim().match(/github\.com[:/]([^/]+\/[^/.\s]+?)(?:\.git)?$/)?.[1] ?? null;
  return {
    repo: true, top, branch,
    dirty: lines.length,
    untracked: lines.filter(l => l.startsWith('??')).length,
    ahead: Number(head.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(head.match(/behind (\d+)/)?.[1] ?? 0),
    upstream: head.includes('...'),
    stash: (stash ?? '').split('\n').filter(Boolean).length,
    lastCommit: ts ? { at: Number(ts) * 1000, subject } : null,
    github: gh,
  };
}

const rollup = checks => {
  if (!checks?.length) return null;
  const st = checks.map(c => c.conclusion || c.state || c.status);
  if (st.some(s => /FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED/.test(s))) return 'fail';
  if (st.some(s => /PENDING|IN_PROGRESS|QUEUED|EXPECTED|WAITING/.test(s))) return 'pending';
  return 'pass';
};

async function ghState(cwd, repo, branch) {
  const [prs, runs] = await Promise.all([
    run('gh', ['pr', 'list', '--repo', repo, '--author', '@me', '--state', 'open', '--limit', '6',
      '--json', 'number,title,isDraft,url,headRefName,statusCheckRollup,updatedAt'], cwd, 15000),
    branch ? run('gh', ['run', 'list', '--repo', repo, '--branch', branch, '--limit', '1',
      '--json', 'conclusion,status,workflowName,headBranch,url,createdAt'], cwd, 15000) : Promise.resolve('[]'),
  ]);
  let pr = [], ci = null;
  try { pr = JSON.parse(prs ?? '[]').map(p => ({ number: p.number, title: p.title, draft: p.isDraft, url: p.url, branch: p.headRefName, checks: rollup(p.statusCheckRollup), updatedAt: p.updatedAt })); } catch {}
  try { const r = JSON.parse(runs ?? '[]')[0]; if (r) ci = { conclusion: r.conclusion || null, status: r.status, workflow: r.workflowName, branch: r.headBranch, url: r.url, at: Date.parse(r.createdAt) }; } catch {}
  return { prs: pr, ci, ok: prs !== null };
}

function pumpGh() {
  while (ghRunning < GH_CONCURRENCY && ghQueue.length) {
    const job = ghQueue.shift();
    ghRunning++;
    job().finally(() => { ghRunning--; pumpGh(); });
  }
}

function refresh(cwd) {
  if (inflight.has(cwd)) return;
  inflight.add(cwd);
  const entry = cache.get(cwd) ?? {};
  cache.set(cwd, entry);
  (async () => {
    if (!entry.gitAt || Date.now() - entry.gitAt > GIT_TTL) { entry.git = await gitState(cwd); entry.gitAt = Date.now(); }
    const g = entry.git;
    if (g?.github && (!entry.ghAt || Date.now() - entry.ghAt > GH_TTL)) {
      entry.ghAt = Date.now();   // claim the slot so we don't queue twice
      ghQueue.push(async () => { entry.gh = await ghState(cwd, g.github, g.branch); entry.ghAt = Date.now(); });
      pumpGh();
    }
  })().finally(() => inflight.delete(cwd));
}

// Returns { cwd: { ...git, prs, ci } } for whatever is known now, refreshing stale entries in the background.
export function healthFor(cwds) {
  const out = {};
  for (const cwd of cwds) {
    refresh(cwd);
    const e = cache.get(cwd);
    if (e?.git) out[cwd] = { ...e.git, prs: e.gh?.prs ?? [], ci: e.gh?.ci ?? null, ghKnown: !!e.gh };
  }
  return out;
}
