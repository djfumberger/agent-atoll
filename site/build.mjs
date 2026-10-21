// Builds the landing site into site/dist: the real islands page running on demo data with a hero on
// top, plus a copy of the npm tarball
// (`npx <site>/agent-atoll.tgz`) as a fallback to `npx agent-atoll`.
// SITE_URL=https://agent-atoll.pages.dev node site/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SITE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SITE), APP = path.join(ROOT, 'islands', 'public'), OUT = path.join(SITE, 'dist');
const SITE_URL = (process.env.SITE_URL || 'https://agent-atoll.pages.dev').replace(/\/$/, '');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const landing = fs.readFileSync(path.join(SITE, 'landing.html'), 'utf8').replaceAll('__SITE__', SITE_URL);
const swap = (from, to) => { if (!html.includes(from)) throw new Error(`index.html changed: missing ${from}`); html = html.replace(from, to); };
swap('<title>Agent Atoll</title>', `<title>Agent Atoll</title>
<meta name="description" content="Your Claude Code and Codex projects as a living archipelago. Runs locally with one npx command.">
<meta property="og:title" content="Agent Atoll"><meta property="og:description" content="Your agents, as a living archipelago.">
<meta property="og:image" content="${SITE_URL}/og.png"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="favicon.svg">`);
swap('<script type="module" src="islands.js"></script>', `${landing}\n<script src="demo.js"></script>\n<script type="module" src="islands.js"></script>`);
fs.writeFileSync(path.join(OUT, 'index.html'), html);

fs.copyFileSync(path.join(APP, 'islands.js'), path.join(OUT, 'islands.js'));
fs.cpSync(path.join(APP, 'models'), path.join(OUT, 'models'), { recursive: true });
fs.copyFileSync(path.join(SITE, 'demo.js'), path.join(OUT, 'demo.js'));
// favicon: the header's mark, cream on a deep-sea tile, with a heavier stroke so it survives 16px
const mark = landing.match(/<svg class="mark"[^]*?>([^]*?)<\/svg>/)[1].replaceAll('currentColor', '#fff8ea').replace('stroke-width="310"', 'stroke-width="400"');
fs.writeFileSync(path.join(OUT, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-700 -800 4865 4865"><rect x="-700" y="-800" width="4865" height="4865" rx="1050" fill="#0b2a4a"/><g fill="none">${mark}</g></svg>`);
if (fs.existsSync(path.join(SITE, 'og.png'))) fs.copyFileSync(path.join(SITE, 'og.png'), path.join(OUT, 'og.png'));

const tgz = execFileSync('npm', ['pack', '--silent', '--pack-destination', OUT], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop();
fs.renameSync(path.join(OUT, tgz), path.join(OUT, 'agent-atoll.tgz'));
fs.writeFileSync(path.join(OUT, '_headers'), `/agent-atoll.tgz\n  Content-Type: application/gzip\n  Cache-Control: no-cache\n`);
console.log(`built ${OUT} for ${SITE_URL}:`, fs.readdirSync(OUT).join(', '));
