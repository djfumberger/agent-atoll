// Sample archipelago for the landing page: a made-up developer's projects, generated relative to now,
// fed to islands.js through window.ISLES_DEMO in place of the local server's API.
(() => {
  const DAY = 864e5, NOW = Date.now(), HOME = '/home/you';
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(rnd() * 16).toString(16));

  const MIX = {
    build: { Edit: 40, Write: 8, Read: 22, Bash: 12, Grep: 8 },
    run: { Bash: 45, Read: 12, Edit: 8, Monitor: 3 },
    read: { Read: 40, Grep: 25, Glob: 8, WebFetch: 6, Edit: 3 },
    agents: { Agent: 10, Read: 20, Edit: 12, Bash: 10 },
  };
  const TITLES = {
    harbor: ['Set up the monorepo', 'Sketch the data model', 'Add auth with magic links', 'Fix flaky upload test', 'Offline sync for drafts', 'Realtime cursors', 'Dark mode pass', 'Speed up cold start', 'Migrate to Postgres 17', 'Billing webhooks', 'Search with trigram index', 'Audit log export', 'Rate limiting', 'Onboarding checklist', 'Refactor permissions', 'Image pipeline', 'Fix timezone bug in digests', 'Keyboard shortcuts', 'Accessibility sweep', 'Ship v1.0'],
    web: ['Landing hero', 'Dashboard layout', 'Settings forms', 'Command palette', 'Charts for usage', 'Responsive nav'],
    server: ['Job queue', 'Health checks', 'Websocket gateway', 'Retry policies', 'Structured logs'],
    'tide-api': ['Bootstrap API', 'OpenAPI spec', 'Pagination', 'Auth middleware', 'Caching layer', 'Fix N+1 queries', 'Webhooks v2', 'Load test'],
    'tide-web': ['Component library', 'Table virtualisation', 'Form validation', 'E2E tests', 'Empty states'],
    'tide-docs': ['Docs site', 'API reference', 'Quickstart guide'],
    'lumen-app': ['Photo grid', 'Editing tools', 'Export presets', 'Sync with iCloud', 'Crash on large RAW files', 'Filters gallery'],
    'lumen-ios': ['SwiftUI shell', 'Camera capture', 'Widgets', 'TestFlight build'],
    'pixel-forge': ['Sprite packer', 'Palette quantiser', 'CLI flags', 'Animated GIF export'],
    'garden-bot': ['Moisture sensor reader', 'Watering schedule', 'Telegram alerts'],
    'paper-planes': ['Physics sim', 'Wind field shader', 'Score board', 'Touch controls'],
    'recipe-box': ['Parse recipe URLs', 'Shopping list'],
    notes: ['Markdown preview', 'Backlinks', 'Daily notes'],
    dotfiles: ['zsh cleanup', 'Neovim config'],
    'weather-cli': ['Forecast command'],
    you: ['Tidy up projects folder', 'Script to back up configs'],
  };
  // [path, sessions, first active (days ago), last active (days ago), main kinds, share of Codex sessions]
  const SPEC = [
    ['code/harbor', 34, 88, 0, ['build', 'build', 'build', 'run', 'run', 'read', 'agents'], 0.15],
    ['code/harbor/web', 9, 60, 1, ['build', 'build', 'read'], 0],
    ['code/harbor/server', 7, 55, 2, ['run', 'build'], 0.3],
    ['code/tide-api', 16, 80, 1, ['build', 'run', 'read'], 0],
    ['code/tide-web', 11, 70, 0, ['build', 'build', 'read'], 0.2],
    ['code/tide-docs', 4, 40, 9, ['read', 'build'], 0],
    ['code/lumen-app', 14, 75, 0, ['build', 'run'], 0],
    ['code/lumen-ios', 6, 45, 3, ['build', 'run'], 0],
    ['code/pixel-forge', 8, 66, 5, ['build', 'run'], 0.5],
    ['code/garden-bot', 5, 50, 12, ['run', 'build'], 0],
    ['code/paper-planes', 6, 30, 0, ['build', 'read'], 1],
    ['code/recipe-box', 3, 35, 18, ['build'], 0],
    ['code/notes', 4, 58, 7, ['build', 'read'], 0],
    ['code/dotfiles', 2, 85, 40, ['run'], 0],
    ['code/weather-cli', 1, 20, 20, ['build'], 0],
    ['', 2, 90, 6, ['run'], 0],
  ];

  const projects = SPEC.map(([rel, n, first, last, kinds, codex]) => {
    const cwd = rel ? `${HOME}/${rel}` : HOME, name = cwd.split('/').pop();
    const titles = TITLES[name] ?? TITLES.you;
    const sessions = [];
    for (let i = 0; i < n; i++) {
      const u = n === 1 ? 1 : i / (n - 1), eased = Math.pow(u, 0.75);
      const start = NOW - (first - (first - last) * eased) * DAY - rnd() * 0.3 * DAY - (i === n - 1 ? 0 : 2 * 3600e3);
      const kind = pick(kinds), turns = 6 + Math.floor(rnd() * (kind === 'agents' ? 120 : 70)), tools = {};
      for (const [t, w] of Object.entries(MIX[kind])) if (rnd() < 0.9) tools[t] = Math.max(1, Math.round(w * turns / 60 * (0.5 + rnd())));
      const title = titles[i % titles.length] + (i >= titles.length ? ' (part 2)' : '');
      const src = rnd() < codex ? 'codex' : 'claude';
      if (src === 'codex') { const m = { Edit: 'apply_patch', Write: 'apply_patch', Bash: 'shell', Read: 'search', Grep: 'search', Glob: 'search', Agent: 'spawn_agent' }; for (const k of Object.keys(tools)) if (m[k]) { tools[m[k]] = (tools[m[k]] || 0) + tools[k]; delete tools[k]; } }
      sessions.push({
        id: uuid(), cwd, start, end: Math.min(NOW - 60e3, start + (0.3 + rnd() * 3) * 3600e3), userTurns: Math.ceil(turns / 5), assistantTurns: turns,
        tools, toolErrors: Math.floor(rnd() * 3), title, firstPrompt: `${title}. Keep it simple and add tests.`, lastPrompt: 'Looks good, commit it.',
        branches: { main: 1 }, costUSD: src === 'claude' ? +(turns * 0.04 * (0.5 + rnd())).toFixed(2) : 0, tokens: src === 'codex' ? turns * 90e3 : 0,
        linesAdded: Math.floor(turns * 9 * rnd()), linesRemoved: Math.floor(turns * 3 * rnd()), subagents: kind === 'agents' && rnd() < 0.5 ? 3 + Math.floor(rnd() * 4) : 0, source: src, mtime: NOW,
      });
    }
    return { cwd, name, parent: null, links: {}, dirs: [], sessions, start: sessions[0].start, end: Math.max(...sessions.map(s => s.end)) };
  });
  const P = n => projects.find(p => p.name === n);
  for (const p of projects) p.parent = projects.filter(q => p.cwd.startsWith(q.cwd + '/')).sort((a, b) => b.cwd.length - a.cwd.length)[0]?.cwd ?? null;
  for (const [a, b, n] of [['harbor', 'tide-api', 40], ['lumen-app', 'lumen-ios', 22], ['harbor', 'pixel-forge', 12], ['tide-web', 'tide-api', 18]]) { P(a).links[P(b).cwd] = n; P(b).links[P(a).cwd] = n; }

  // Who's at work right now: a few sessions on the featured island, plus some elsewhere.
  const latest = (n, k) => [...P(n).sessions].sort((a, b) => b.start - a.start).slice(0, k);
  const LIVE = [
    ...latest('harbor', 3).map(s => ({ s, busy: true })), { s: latest('harbor', 4)[3], busy: false },
    { s: latest('tide-web', 1)[0], busy: true }, { s: latest('lumen-app', 1)[0], busy: false }, { s: latest('paper-planes', 1)[0], busy: true },
  ];
  for (const l of LIVE) l.s.end = NOW - 30e3;
  for (const p of projects) p.end = Math.max(...p.sessions.map(s => s.end));
  const TOOLS = ['Edit', 'Bash', 'Read', 'Grep', 'Edit', 'Write', 'Agent', 'WebFetch', 'Bash'];
  const live = () => LIVE.map(({ s, busy }, i) => ({
    pid: s.source === 'codex' ? null : 4100 + i, sessionId: s.id, cwd: s.cwd, status: busy ? 'busy' : 'idle', name: `${s.cwd.split('/').pop()}-${s.id.slice(0, 2)}`,
    startedAt: s.start, updatedAt: busy ? NOW : NOW - (8 + i) * 60e3, source: s.source, busy,
    tool: busy ? (s.source === 'codex' ? pick(['apply_patch', 'shell', 'search']) : pick(TOOLS)) : null,
  }));

  const repo = (name, o = {}) => ({ repo: true, top: P(name).cwd, branch: 'main', dirty: 0, untracked: 0, ahead: 0, behind: 0, upstream: true, stash: 0,
    lastCommit: { at: NOW - 3 * 3600e3, subject: 'wip' }, github: `you/${name}`, prs: [], ci: { conclusion: 'success', status: 'completed', workflow: 'CI', branch: 'main', url: '#', at: NOW - 5 * 3600e3 }, ghKnown: true, ...o });
  const pr = (number, title, checks, draft = false) => ({ number, title, checks, draft, url: '#', branch: 'feature', updatedAt: new Date(NOW).toISOString() });
  const health = {
    [P('harbor').cwd]: repo('harbor', { dirty: 9, untracked: 2, ahead: 3, lastCommit: { at: NOW - 40 * 60e3, subject: 'Realtime cursors: presence channel' }, prs: [pr(128, 'Offline sync for drafts', 'pass'), pr(131, 'Realtime cursors', 'pending', true)] }),
    [P('tide-api').cwd]: repo('tide-api', { ci: { conclusion: 'failure', status: 'completed', workflow: 'CI', branch: 'main', url: '#', at: NOW - 2 * 3600e3 } }),
    [P('tide-web').cwd]: repo('tide-web', { dirty: 4, prs: [pr(57, 'Table virtualisation', 'pass')] }),
    [P('lumen-app').cwd]: repo('lumen-app', { dirty: 6, ahead: 1 }),
    [P('lumen-ios').cwd]: repo('lumen-ios', { prs: [pr(12, 'Home screen widgets', 'fail')] }),
    [P('pixel-forge').cwd]: repo('pixel-forge', { dirty: 14, ahead: 3, stash: 2 }),
    [P('paper-planes').cwd]: repo('paper-planes', { dirty: 3 }),
  };

  const GAZETTE = `Hear ye! The Harbor Gazette for today:
• Three crews hard at work on harbor, where realtime cursors are going up fast.
• Storm over tide-api! CI failed on main two hours ago.
• Rain on lumen-ios: checks failing on PR #12, "Home screen widgets".
• Two ships anchored off harbor await review: #128 (all green) and draft #131.
• 14 crates piled on the pixel-forge docks, plus buried treasure (2 stashes).
• The dotfiles isle lies in fog, untouched for 40 days.
Start with the tide-api storm: everything downstream sails through it.`;
  const DEMO_REPLY = 'This is a demo isle with made-up projects. Install Agent Atoll and I\'ll answer from your own project history: what was built, what\'s waiting, and what to do next.';

  window.ISLES_DEMO = {
    async api(path, body) {
      if (path.startsWith('/api/city')) return { generatedAt: NOW, home: HOME, projects, live: live() };
      if (path === '/api/live') return { now: Date.now(), live: live() };
      if (path === '/api/health') return health;
      if (path === '/api/crier') return { text: /gazette/i.test(body?.question ?? '') ? GAZETTE : DEMO_REPLY };
      if (path === '/api/npc') return { text: DEMO_REPLY };
      if (path === '/api/focus') return { error: 'In the demo there is no terminal to focus. Install it and this jumps to the tab your agent is running in.' };
      if (path === '/api/open') return { error: 'In the demo there is no terminal to open. Install it to resume your own sessions.' };
      return {};
    },
    onReady: ctx => window.dispatchEvent(new CustomEvent('isles-ready', { detail: ctx })),
  };
})();
