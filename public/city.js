import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

// ---------- config ----------
const DAY = 864e5;
const FLOOR = 0.22;
// Name-family aliases come from ~/.agent-atoll/config.json ("aliases": { "ac": "acme" }) via the city payload.
let FAMILY_ALIASES = {};
const CATEGORY = {
  Edit: 'build', Write: 'build', MultiEdit: 'build', NotebookEdit: 'build',
  Bash: 'run', Monitor: 'run', BashOutput: 'run',
  Read: 'read', Grep: 'read', Glob: 'read', WebFetch: 'read', WebSearch: 'read', LSP: 'read',
  Agent: 'agents', Task: 'agents', Workflow: 'agents',
  // Codex (codex.mjs splits its generic exec tool into apply_patch / search / shell)
  apply_patch: 'build', shell: 'run', js: 'run', write_stdin: 'run', search: 'read', web_search: 'read', view_image: 'read',
  spawn_agent: 'agents', wait_agent: 'agents', send_message: 'agents',
};
// Bash calls are cheap and plentiful; weight edits so "what got built" shows through.
const CATEGORY_WEIGHT = { build: 2, run: 0.7 };
const STYLE = {
  build:  { label: 'Building code', colors: ['#6f9fc7', '#5b8fb9', '#86b3d1', '#4f7ea8'], width: 0.64, hScale: 1.0 },
  run:    { label: 'Running commands', colors: ['#c0704f', '#a85d43', '#b88a5a'], width: 0.8, hScale: 0.55 },
  read:   { label: 'Research', colors: ['#e3d3ad', '#d8c49a', '#cdbb94'], width: 0.78, hScale: 0.6 },
  agents: { label: 'Orchestrating agents', colors: ['#a58fd0', '#8f7cc4'], width: 0.6, hScale: 1.1 },
  talk:   { label: 'Conversation', colors: ['#e8a0a0', '#f2c48d', '#b9d39a', '#e9e3d0'], width: 0.56, hScale: 0.5 },
};
const STATUS_COLOR = { busy: '#ffb547', idle: '#6ee08a', shell: '#8c8f96' };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hash = s => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };
const ago = t => { const d = (Date.now() - t) / 1000; return d < 90 ? `${d | 0}s` : d < 5400 ? `${(d / 60) | 0}m` : d < 129600 ? `${(d / 3600) | 0}h` : `${(d / 86400) | 0}d`; };
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const DAY_BG = new THREE.Color('#9cbfd4'), NIGHT_BG = new THREE.Color('#0b1222');
scene.background = DAY_BG.clone();

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
const controls = new MapControls(camera, renderer.domElement);
controls.enableRotate = false;
controls.zoomToCursor = true;
controls.enableDamping = true;
controls.minZoom = 0.25; controls.maxZoom = 10;
const view = { size: 34, az: Math.PI / 4, azTarget: Math.PI / 4, el: Math.PI / 6 }; // 30° = classic 2:1 sim-game dimetric

const hemi = new THREE.HemisphereLight('#fff6e6', '#5a6b50', 1.6);
const sun = new THREE.DirectionalLight('#fff1d6', 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(hemi, sun, sun.target);

const U = { time: { value: 1e9 }, night: { value: 0 }, grow: { value: 1 }, clock: { value: 0 } };

const gradient = new THREE.DataTexture(new Uint8Array([110, 185, 255]), 3, 1, THREE.RedFormat);
gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
gradient.needsUpdate = true;
const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap: gradient, ...extra });

// Injects growth (time travel), windows, night glow and crisp edges into toon materials.
function cityShader(mat, { grow = false, windows = false, appear = false } = {}) {
  mat.customProgramCacheKey = () => `city:${grow}:${windows}:${appear}`;
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { uTime: U.time, uNight: U.night, uGrow: U.grow });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aBorn; attribute float aLit; attribute float aSeed;
        uniform float uTime; uniform float uGrow;
        varying vec3 vLP; varying vec3 vScale; varying vec3 vN; varying float vLit; varying float vSeed;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float g = clamp((uTime - aBorn) / uGrow, 0.0, 1.0);
        ${grow ? 'transformed.y *= g * g * (3.0 - 2.0 * g); if (g <= 0.0) transformed *= 0.0;' : ''}
        ${appear ? 'transformed *= step(1.0, g);' : ''}
        #ifdef USE_INSTANCING
        vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        #else
        vScale = vec3(1.0);
        #endif
        vLP = position * vScale; vN = normal; vLit = aLit; vSeed = aSeed;`);
    if (!sh.fragmentShader) return;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight;
        varying vec3 vLP; varying vec3 vScale; varying vec3 vN; varying float vLit; varying float vSeed;
        float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float winGlow = 0.0;
        ${windows ? `
        vec3 an = abs(vN);
        if (an.y < 0.5) {
          float w = an.x > 0.5 ? vScale.z : vScale.x;
          float u = (an.x > 0.5 ? vLP.z : vLP.x) + w * 0.5;
          float cols = max(2.0, floor(w * 6.0));
          vec2 cell = vec2(u / w * cols, vLP.y / ${FLOOR.toFixed(3)});
          vec2 f = fract(cell);
          float win = step(0.22, f.x) * step(f.x, 0.78) * step(0.3, f.y) * step(f.y, 0.78)
                    * step(1.0, cell.y) * step(cell.y, vScale.y / ${FLOOR.toFixed(3)} - 0.5);
          float on = step(h21(floor(cell) + vec2(vSeed * 97.0, an.x * 13.0)), vLit);
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.24, 0.32, 0.42), vec3(0.06, 0.07, 0.1), uNight), win * 0.85);
          winGlow = win * on;
        }
        vec3 d = 0.5 * vScale - abs(vLP - vec3(0.0, 0.5 * vScale.y, 0.0));
        float e = 0.018;
        float edge = step(1.5, step(d.x, e) + step(d.y, e) + step(d.z, e));
        diffuseColor.rgb *= 1.0 - 0.5 * edge;` : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += winGlow * uNight * vec3(1.0, 0.76, 0.4) * 1.6;`);
  };
  return mat;
}

// Depth material that matches the growth transform, so unborn buildings don't cast shadows.
function depthFor(opts) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  cityShader(m, opts);
  const orig = m.onBeforeCompile;
  m.customProgramCacheKey = () => `depth:${!!opts.grow}:${!!opts.appear}`;
  m.onBeforeCompile = sh => { const f = sh.fragmentShader; sh.fragmentShader = ''; orig(sh); sh.fragmentShader = f; };
  return m;
}

// ---------- layout ----------
const SPIRAL = (() => {
  const R = 90, a = [];
  for (let x = -R; x <= R; x++) for (let z = -R; z <= R; z++) a.push([x, z, x * x + z * z * 1.15]);
  return a.sort((p, q) => p[2] - q[2]);
})();

function pack(items, margin) {
  const placed = [];
  for (const it of items) {
    for (const [cx, cz] of SPIRAL) {
      const x0 = cx - Math.floor(it.w / 2), z0 = cz - Math.floor(it.h / 2);
      const free = placed.every(p => x0 >= p.x0 + p.w + margin || p.x0 >= x0 + it.w + margin ||
                                     z0 >= p.z0 + p.h + margin || p.z0 >= z0 + it.h + margin);
      if (free) { placed.push({ x0, z0, w: it.w, h: it.h }); it.x0 = x0; it.z0 = z0; break; }
    }
  }
  const minX = Math.min(...placed.map(p => p.x0)), minZ = Math.min(...placed.map(p => p.z0));
  const maxX = Math.max(...placed.map(p => p.x0 + p.w)), maxZ = Math.max(...placed.map(p => p.z0 + p.h));
  for (const it of items) { it.x0 -= minX; it.z0 -= minZ; }
  return { w: maxX - minX, h: maxZ - minZ };
}

const categoryOf = s => {
  const score = {};
  for (const [t, n] of Object.entries(s.tools)) {
    const c = CATEGORY[t] ?? (t.startsWith('mcp__codegraph') ? 'read' : null);
    if (c) score[c] = (score[c] || 0) + n * (CATEGORY_WEIGHT[c] ?? 1);
  }
  if (s.subagents >= 3) return 'agents';
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : 'talk';
};

function buildModel(data) {
  FAMILY_ALIASES = data.aliases ?? {};
  const t0 = Math.min(...data.projects.map(p => p.start)) - DAY;
  const toDay = t => (t - t0) / DAY;
  const projects = data.projects.map(p => ({ ...p, live: [] }));
  const isAnc = (a, b) => b.startsWith(a + '/');
  for (const p of projects) p.hub = p.cwd === data.home || projects.filter(q => isAnc(p.cwd, q.cwd)).length >= 3;
  for (const p of projects) {
    p.eparent = p.hub ? null : projects.filter(q => !q.hub && isAnc(q.cwd, p.cwd)).sort((a, b) => b.cwd.length - a.cwd.length)[0] ?? null;
    p.children = [];
  }
  for (const p of projects) p.eparent?.children.push(p);
  const topOf = p => (p.eparent ? topOf(p.eparent) : p);

  // towns = a top-level repo plus its nested projects; regions = towns sharing a name family
  const towns = new Map();
  for (const p of projects) {
    const key = p.hub ? '__hub' : topOf(p).cwd;
    if (!towns.has(key)) towns.set(key, { key, districts: [] });
    towns.get(key).districts.push(p);
  }
  const regions = new Map();
  for (const t of towns.values()) {
    const top = t.key === '__hub' ? null : t.districts.find(d => !d.eparent);
    let fam = top ? top.name.toLowerCase().split(/[-_. ]/)[0] : '__hub';
    fam = FAMILY_ALIASES[fam] ?? fam;
    t.top = top;
    if (!regions.has(fam)) regions.set(fam, { fam, towns: [] });
    regions.get(fam).towns.push(t);
  }

  for (const p of projects) {
    p.side = Math.max(2, Math.ceil(Math.sqrt(p.sessions.length)));
    p.w = p.h = p.side + 1;
  }
  for (const t of towns.values()) {
    t.districts.sort((a, b) => (a === t.top ? -1 : b === t.top ? 1 : b.w - a.w));
    Object.assign(t, pack(t.districts, 1));
  }
  for (const r of regions.values()) {
    r.towns.sort((a, b) => b.w * b.h - a.w * a.h);
    Object.assign(r, pack(r.towns, 3));
    const n = r.towns.reduce((a, t) => a + t.districts.length, 0);
    const Name = r.fam.charAt(0).toUpperCase() + r.fam.slice(1);
    r.name = r.fam === '__hub' ? 'Downtown' : n >= 3 ? `${Name} Metro` : r.towns.length > 1 ? `${Name} Township` : null;
  }
  const regionList = [...regions.values()].sort((a, b) => (a.fam === '__hub' ? -1 : b.fam === '__hub' ? 1 : b.w * b.h - a.w * a.h));
  const world = pack(regionList, 6);

  // absolute coordinates
  const ox = -world.w / 2, oz = -world.h / 2;
  for (const r of regionList) {
    r.x = ox + r.x0; r.z = oz + r.z0;
    for (const t of r.towns) {
      t.x = r.x + t.x0; t.z = r.z + t.z0;
      for (const p of t.districts) {
        p.x = t.x + p.x0; p.z = t.z + p.z0;
        p.cx = p.x + p.w / 2; p.cz = p.z + p.h / 2;
        p.region = r; p.town = t;
        p.startDay = toDay(p.start);
      }
    }
  }

  // buildings: one per session, oldest at the district centre so towns grow outward
  const buildings = [];
  const now = Date.now();
  for (const p of projects) {
    const lots = [];
    for (let i = 0; i < p.side; i++) for (let j = 0; j < p.side; j++) lots.push([i, j, (i - (p.side - 1) / 2) ** 2 + (j - (p.side - 1) / 2) ** 2 + hash(p.cwd + i + ',' + j) * 0.3]);
    lots.sort((a, b) => a[2] - b[2]);
    p.lots = lots;
    p.buildings = [];
    p.sessions.forEach((s, k) => {
      const [i, j] = lots[k];
      const cat = categoryOf(s);
      const st = STYLE[cat];
      const floors = Math.min(36, 1 + Math.floor(Math.log2(1 + s.assistantTurns) * 1.6));
      const seed = hash(s.id);
      const ageDays = (now - s.end) / DAY;
      const b = {
        s, p, cat, seed,
        x: p.x + 1 + i, z: p.z + 1 + j,
        w: st.width * (0.9 + seed * 0.2), d: st.width * (0.9 + hash(s.id + 'd') * 0.2),
        h: Math.max(0.3, floors * FLOOR * st.hScale + 0.15),
        born: toDay(s.start),
        lit: ageDays < 1 ? 0.85 : ageDays < 7 ? 0.55 : ageDays < 30 ? 0.3 : 0.12,
        color: new THREE.Color(st.colors[Math.floor(seed * st.colors.length)]),
      };
      b.color.lerp(new THREE.Color('#9a9890'), Math.min(0.35, ageDays / 200)); // weathering
      p.buildings.push(b);
      buildings.push(b);
    });
    p.maxH = Math.max(0.5, ...p.buildings.map(b => b.h));
  }

  // cross-project links (a session in A touched files in B) become highways
  const byCwd = new Map(projects.map(p => [p.cwd, p]));
  const links = [];
  for (const p of projects) for (const [cwd, n] of Object.entries(p.links)) {
    const q = byCwd.get(cwd);
    if (!q || q.hub || p.hub || n < 4) continue;
    const ex = links.find(l => (l.a === q && l.b === p));
    if (ex) ex.n += n; else links.push({ a: p, b: q, n });
  }

  return { t0, toDay, projects, towns: [...towns.values()], regions: regionList, world, buildings, links, byCwd };
}

// ---------- scene construction ----------
const cityGroup = new THREE.Group();
scene.add(cityGroup);
let M = null; // current model
let bodyMesh = null, pickables = [];

function instanced(geo, mat, items, place, opts) {
  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  const born = new Float32Array(items.length), lit = new Float32Array(items.length), seed = new Float32Array(items.length);
  const m4 = new THREE.Matrix4();
  items.forEach((it, i) => {
    const r = place(it, m4);
    mesh.setMatrixAt(i, m4);
    mesh.setColorAt(i, r.color);
    born[i] = r.born ?? -1e6; lit[i] = r.lit ?? 0.3; seed[i] = r.seed ?? hash(String(i));
  });
  geo.setAttribute('aBorn', new THREE.InstancedBufferAttribute(born, 1));
  geo.setAttribute('aLit', new THREE.InstancedBufferAttribute(lit, 1));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.customDepthMaterial = depthFor(opts);
  return mesh;
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);

function buildScene(model) {
  cityGroup.clear();
  pickables = [];
  const { world, projects, buildings, regions, towns, links } = model;

  // island diorama on water
  const W = world.w + 18, H = world.h + 18;
  const groundMat = cityShader(toon('#7fb069'));
  groundMat.onBeforeCompile = (orig => sh => {
    orig(sh);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('float winGlow = 0.0;', `float winGlow = 0.0;
        vec2 gq = abs(fract(vWP.xz) - 0.5);
        diffuseColor.rgb *= 0.94 + 0.08 * h21(floor(vWP.xz)) - 0.07 * step(0.47, max(gq.x, gq.y));`);
  })(groundMat.onBeforeCompile);
  groundMat.customProgramCacheKey = () => 'ground';
  const dirt = toon('#8a6a4a');
  const island = new THREE.Mesh(new THREE.BoxGeometry(W, 1, H), [dirt, dirt, groundMat, dirt, dirt, dirt]);
  island.position.y = -0.5; island.receiveShadow = true;
  const water = new THREE.Mesh(new THREE.PlaneGeometry(W * 6, H * 6), toon('#3d7ea6'));
  water.rotation.x = -Math.PI / 2; water.position.y = -0.3;
  cityGroup.add(island, water);

  // region zoning patches
  for (const r of regions) {
    if (!r.name) continue;
    const m = new THREE.Mesh(new THREE.BoxGeometry(r.w + 2, 0.02, r.h + 2), toon(r.fam === '__hub' ? '#a9b59a' : '#93bf7a'));
    m.position.set(r.x + r.w / 2, 0.01, r.z + r.h / 2); m.receiveShadow = true;
    cityGroup.add(m);
  }

  // roads: child district -> parent district, and towns within a region chained by nearest neighbour
  const roadMat = toon('#4b4f55');
  const roadSegs = [];
  const road = (a, b) => roadSegs.push({ a, b, x1: a.cx, z1: a.cz, x2: b.cx, z2: b.cz });
  for (const p of projects) if (p.eparent) road(p, p.eparent);
  for (const r of regions) {
    const tops = r.towns.map(t => t.top ?? t.districts[0]);
    const inTree = [tops[0]];
    for (const t of tops.slice(1)) {
      const near = inTree.reduce((best, q) => (Math.hypot(q.cx - t.cx, q.cz - t.cz) < Math.hypot(best.cx - t.cx, best.cz - t.cz) ? q : best));
      road(t, near); inTree.push(t);
    }
  }
  for (const s of roadSegs) {
    const g = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(s.x2 - s.x1) + 0.45, 0.03, 0.45), roadMat);
    a.position.set((s.x1 + s.x2) / 2, 0.015, s.z1);
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.03, Math.abs(s.z2 - s.z1) + 0.45), roadMat);
    b.position.set(s.x2, 0.015, (s.z1 + s.z2) / 2);
    a.receiveShadow = b.receiveShadow = true;
    g.add(a, b);
    g.userData.showAfter = Math.max(s.a.startDay, s.b.startDay);
    cityGroup.add(g);
    s.mesh = g;
  }
  model.roads = roadSegs;

  // district pads (asphalt ring + concrete lot)
  const padMat = toon('#c9c3b4'), ringMat = toon('#4b4f55'), hubMat = toon('#d9cfa8');
  for (const p of projects) {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.BoxGeometry(p.w + 0.5, 0.05, p.h + 0.5), ringMat);
    ring.position.y = 0.025;
    const pad = new THREE.Mesh(new THREE.BoxGeometry(p.w - 0.1, 0.08, p.h - 0.1), p.hub ? hubMat : padMat);
    pad.position.y = 0.04;
    ring.receiveShadow = pad.receiveShadow = true;
    pad.userData.project = p;
    g.add(ring, pad);
    g.position.set(p.cx, 0, p.cz);
    g.userData.showAfter = p.startDay;
    cityGroup.add(g);
    p.pad = g;
    pickables.push(pad);
  }

  // buildings
  const bodyOpts = { grow: true, windows: true };
  bodyMesh = instanced(box(1, 1, 1), cityShader(toon('#ffffff'), bodyOpts), buildings, (b, m4) => {
    m4.compose(new THREE.Vector3(b.x, 0.08, b.z), new THREE.Quaternion(), new THREE.Vector3(b.w, b.h, b.d));
    return b;
  }, bodyOpts);
  cityGroup.add(bodyMesh);
  pickables.push(bodyMesh);

  const acc = { appear: true };
  const roofs = buildings.filter(b => b.cat === 'talk');
  if (roofs.length) cityGroup.add(instanced(new THREE.ConeGeometry(0.72, 0.4, 4).rotateY(Math.PI / 4).translate(0, 0.2, 0),
    cityShader(toon('#ffffff'), acc), roofs, (b, m4) => {
      m4.compose(new THREE.Vector3(b.x, 0.08 + b.h, b.z), new THREE.Quaternion(), new THREE.Vector3(b.w, 1, b.d));
      return { ...b, color: new THREE.Color(['#9b4a3c', '#6d4b3a', '#4f5d73'][Math.floor(b.seed * 3)]) };
    }, acc));
  const chimneys = buildings.filter(b => b.cat === 'run');
  if (chimneys.length) cityGroup.add(instanced(new THREE.CylinderGeometry(0.06, 0.08, 0.6, 8).translate(0, 0.3, 0),
    cityShader(toon('#ffffff'), acc), chimneys, (b, m4) => {
      m4.makeTranslation(b.x + b.w * 0.28, 0.08 + b.h, b.z - b.d * 0.25);
      return { ...b, color: new THREE.Color('#5b4b45') };
    }, acc));
  const helipads = buildings.filter(b => b.s.subagents > 0);
  if (helipads.length) cityGroup.add(instanced(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 12).translate(0, 0.02, 0),
    cityShader(toon('#ffffff'), acc), helipads, (b, m4) => {
      m4.makeTranslation(b.x, 0.08 + b.h, b.z);
      return { ...b, color: new THREE.Color('#e8e4d8') };
    }, acc));
  const masts = buildings.filter(b => b.cat === 'build' && b.h > 2.5);
  if (masts.length) cityGroup.add(instanced(new THREE.CylinderGeometry(0.015, 0.02, 0.8, 4).translate(0, 0.4, 0),
    cityShader(toon('#ffffff'), acc), masts, (b, m4) => {
      m4.makeTranslation(b.x - b.w * 0.2, 0.08 + b.h, b.z + b.d * 0.2);
      return { ...b, color: new THREE.Color('#c9cdd2') };
    }, acc));

  // trees on empty lots and open grass
  const trees = [];
  const occupied = (x, z) => regions.some(r => r.name && x > r.x - 1.5 && x < r.x + r.w + 1.5 && z > r.z - 1.5 && z < r.z + r.h + 1.5) ||
    projects.some(p => x > p.x - 0.6 && x < p.x + p.w + 0.6 && z > p.z - 0.6 && z < p.z + p.h + 0.6) ||
    roadSegs.some(s => (Math.abs(z - s.z1) < 0.6 && x > Math.min(s.x1, s.x2) - 0.6 && x < Math.max(s.x1, s.x2) + 0.6) ||
                       (Math.abs(x - s.x2) < 0.6 && z > Math.min(s.z1, s.z2) - 0.6 && z < Math.max(s.z1, s.z2) + 0.6));
  for (let x = -W / 2 + 1; x < W / 2 - 1; x += 1) for (let z = -H / 2 + 1; z < H / 2 - 1; z += 1) {
    const r = hash(`${x},${z}`);
    if (r < 0.22 && !occupied(x + 0.5, z + 0.5)) trees.push({ x: x + 0.5 + (r - 0.11) * 3, z: z + 0.5 + (hash(`${z},${x}`) - 0.5) * 0.6, s: 0.7 + r * 2, born: -1e6 });
  }
  for (const p of projects) p.lots.slice(p.sessions.length).forEach(([i, j], k) => {
    if (hash(p.cwd + k) < 0.7) trees.push({ x: p.x + 1 + i, z: p.z + 1 + j, s: 0.8, born: p.startDay });
  });
  const treeMesh = instanced(new THREE.ConeGeometry(0.22, 0.6, 6).translate(0, 0.42, 0), cityShader(toon('#ffffff'), acc), trees, (t, m4) => {
    m4.compose(new THREE.Vector3(t.x, 0, t.z), new THREE.Quaternion(), new THREE.Vector3(t.s, t.s, t.s));
    return { color: new THREE.Color().setHSL(0.27 + hash(t.x + ':' + t.z) * 0.08, 0.45, 0.32), born: t.born };
  }, acc);
  cityGroup.add(treeMesh);

  // highways between projects that touch each other's files
  model.highways = links.map(l => {
    const a = new THREE.Vector3(l.a.cx, 0.1, l.a.cz), b = new THREE.Vector3(l.b.cx, 0.1, l.b.cz);
    const dist = a.distanceTo(b);
    const mid = a.clone().lerp(b, 0.5).setY(1.5 + dist * 0.18);
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.05, 5), new THREE.MeshBasicMaterial({ color: '#f2e6c4', transparent: true, opacity: 0.55 }));
    cityGroup.add(tube);
    const cars = Math.min(8, 1 + Math.floor(Math.log2(l.n)));
    return { ...l, curve, tube, cars, showAfter: Math.max(l.a.startDay, l.b.startDay) };
  });
  const carCount = model.highways.reduce((a, h) => a + h.cars * 2, 0);
  model.carMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: '#ffffff' }), Math.max(1, carCount));
  let ci = 0;
  for (const h of model.highways) for (let k = 0; k < h.cars * 2; k++) model.carMesh.setColorAt(ci++, new THREE.Color(k % 2 ? '#ffd27a' : '#ff6b5a'));
  cityGroup.add(model.carMesh);

  // sun + shadow frustum to fit the island
  const R = Math.max(W, H) * 0.75;
  sun.position.set(R * 0.6, R, R * 0.35);
  Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: R * 4 });
  sun.shadow.camera.updateProjectionMatrix();

  buildLabels(model);
}

// ---------- live layer: workers, cranes, plumbobs ----------
const liveGroup = new THREE.Group();
scene.add(liveGroup);
const workerMesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.05, 0.1, 2, 6).translate(0, 0.13, 0), toon('#ffffff'), 256);
workerMesh.castShadow = true;
workerMesh.count = 0;
liveGroup.add(workerMesh);
let LIVE = [];
const cranes = new Map(), plumbobs = new Map();

function makeCrane(h) {
  const g = new THREE.Group(), y = toon('#f2b632'), k = toon('#3a3a3a');
  const mast = new THREE.Mesh(box(0.07, h, 0.07), y);
  const jib = new THREE.Group(); jib.position.y = h;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.07, 0.07), y); arm.position.x = 0.45;
  const cw = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.16), k); cw.position.x = -0.25;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), y); cab.position.y = -0.08;
  const line = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.7, 0.012), k); line.position.set(1.0, -0.35, 0);
  jib.add(arm, cw, cab, line);
  g.add(mast, jib);
  g.traverse(o => (o.castShadow = true));
  g.userData.jib = jib;
  return g;
}

function makePlumbob(color) {
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), new THREE.MeshBasicMaterial({ color }));
  m.scale.y = 1.7;
  return m;
}

function projectFor(cwd) {
  if (M.byCwd.has(cwd)) return M.byCwd.get(cwd);
  return M.projects.filter(p => cwd.startsWith(p.cwd + '/')).sort((a, b) => b.cwd.length - a.cwd.length)[0] ?? null;
}

function applyLive(list) {
  LIVE = list.map(s => ({ ...s, state: s.busy ? 'busy' : s.status === 'shell' ? 'shell' : 'idle', project: projectFor(s.cwd) })).filter(s => s.project);
  for (const p of M.projects) p.live = [];
  for (const s of LIVE) s.project.live.push(s);

  // cranes over buildings of busy sessions
  const want = new Set();
  for (const s of LIVE.filter(s => s.state === 'busy')) {
    want.add(s.sessionId);
    if (cranes.has(s.sessionId)) continue;
    const b = s.project.buildings.find(b => b.s.id === s.sessionId);
    const h = (b?.h ?? 0.5) + 1.2;
    const c = makeCrane(h);
    c.position.set((b?.x ?? s.project.cx) + (b ? b.w / 2 + 0.1 : 0), 0.08, (b?.z ?? s.project.cz) - (b ? b.d / 2 : 0));
    c.userData.top = h;
    liveGroup.add(c);
    cranes.set(s.sessionId, c);
  }
  for (const [id, c] of cranes) if (!want.has(id)) { liveGroup.remove(c); cranes.delete(id); }

  // plumbob over every district with live sessions: amber = working, green = waiting on you
  for (const p of M.projects) {
    const busy = p.live.some(s => s.state === 'busy'), idle = p.live.some(s => s.state === 'idle');
    const color = busy ? '#ffb547' : idle ? '#6ee08a' : null;
    let pb = plumbobs.get(p.cwd);
    if (!color) { if (pb) { liveGroup.remove(pb); plumbobs.delete(p.cwd); } continue; }
    if (!pb) { pb = makePlumbob(color); pb.position.set(p.cx, p.maxH + 1.4, p.cz); liveGroup.add(pb); plumbobs.set(p.cwd, pb); }
    pb.material.color.set(color);
    pb.userData.busy = busy;
  }

  // workers walk the district ring; busy ones hustle, idle ones loiter
  workerMesh.count = Math.min(256, LIVE.length);
  LIVE.slice(0, 256).forEach((s, i) => {
    workerMesh.setColorAt(i, new THREE.Color(STATUS_COLOR[s.state]));
    s.phase = hash(s.sessionId);
  });
  if (workerMesh.instanceColor) workerMesh.instanceColor.needsUpdate = true;
  renderRoster();
  renderStats();
  updateLabelCounts();
}

async function pollLive() {
  try {
    const r = await fetch('/api/live').then(r => r.json());
    const unknown = r.live.some(s => s.status !== 'shell' && !M.buildings.some(b => b.s.id === s.sessionId) && Date.now() - s.startedAt > 60_000);
    applyLive(r.live);
    if (unknown && Date.now() - lastCityLoad > 60_000) loadCity(true);
  } catch {}
}

// ---------- labels ----------
const labelsEl = $('#labels');
let labels = [];
function buildLabels(model) {
  labelsEl.innerHTML = '';
  labels = [];
  for (const r of model.regions) if (r.name) {
    const el = document.createElement('div'); el.className = 'lbl region'; el.textContent = r.name;
    labelsEl.append(el);
    labels.push({ el, kind: 'region', pos: new THREE.Vector3(r.x + r.w / 2, 0.2, r.z - 0.6), showAfter: Math.min(...r.towns.flatMap(t => t.districts.map(d => d.startDay))) });
  }
  for (const p of model.projects) {
    const el = document.createElement('div'); el.className = 'lbl district';
    labelsEl.append(el);
    labels.push({ el, kind: 'district', p, pos: new THREE.Vector3(p.cx, 0.1, p.z + p.h + 0.25), showAfter: p.startDay });
  }
  updateLabelCounts();
}
function updateLabelCounts() {
  for (const l of labels) if (l.kind === 'district') {
    const n = l.p.live.length, busy = l.p.live.filter(s => s.state === 'busy').length;
    l.el.innerHTML = esc(l.p.hub ? (l.p.cwd === M.home ? '~ home' : l.p.name + ' (root)') : l.p.name) +
      (n ? ` <span style="color:${busy ? 'var(--amber)' : 'var(--green)'}">●${n}</span>` : '');
  }
}
const bubbles = new Map();
function syncBubbles() {
  const want = new Set();
  for (const s of LIVE.filter(s => s.state === 'busy')) {
    want.add(s.sessionId);
    let el = bubbles.get(s.sessionId);
    if (!el) { el = document.createElement('div'); el.className = 'lbl bubble'; labelsEl.append(el); bubbles.set(s.sessionId, el); }
    el.textContent = s.tool ? `${s.tool}…` : 'thinking…';
  }
  for (const [id, el] of bubbles) if (!want.has(id)) { el.remove(); bubbles.delete(id); }
}

const tmpV = new THREE.Vector3();
function toScreen(v) {
  tmpV.copy(v).project(camera);
  return [(tmpV.x + 1) / 2 * innerWidth, (1 - tmpV.y) / 2 * innerHeight];
}
let showLabels = true;
function placeLabels() {
  const z = camera.zoom;
  for (const l of labels) {
    const vis = showLabels && U.time.value >= l.showAfter && (l.kind === 'region' ? z < 2.2 : z > 0.9 || l.p.live.length > 0);
    l.el.style.display = vis ? '' : 'none';
    if (!vis) continue;
    const [x, y] = toScreen(l.pos);
    l.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, 0)`;
  }
  syncBubbles();
  for (const [id, el] of bubbles) {
    const c = cranes.get(id);
    if (!c || !showLabels || !liveGroup.visible) { el.style.display = 'none'; continue; }
    el.style.display = '';
    const [x, y] = toScreen(tmpV.set(c.position.x, c.userData.top + 0.3, c.position.z));
    el.style.transform = `translate(${x - 8}px, ${y - 24}px)`;
  }
}

// ---------- retro post-processing: low-res render + ordered dither + posterize ----------
let retro = true;
const PX = 3;
const rt = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, samples: 0 });
const post = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { tDiffuse: { value: rt.texture }, uPx: { value: PX }, uLevels: { value: 14 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uPx; uniform float uLevels; varying vec2 vUv;
    float bayer(vec2 p) {
      int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0)), i = x + y * 4;
      int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
      for (int k = 0; k < 16; k++) if (k == i) return float(m[k]) / 16.0;
      return 0.0;
    }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = pow(max(c, 0.0), vec3(1.0 / 2.2));
      float b = bayer(floor(gl_FragCoord.xy / uPx)) - 0.5;
      c = floor(c * uLevels + b * 0.9 + 0.5) / uLevels;
      gl_FragColor = vec4(c, 1.0);
    }`,
  depthTest: false, depthWrite: false,
}));
const postScene = new THREE.Scene(); postScene.add(post);
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  const a = innerWidth / innerHeight;
  Object.assign(camera, { left: -view.size * a / 2, right: view.size * a / 2, top: view.size / 2, bottom: -view.size / 2 });
  camera.updateProjectionMatrix();
  const dpr = renderer.getPixelRatio();
  rt.setSize(Math.ceil(innerWidth * dpr / (PX * dpr)), Math.ceil(innerHeight * dpr / (PX * dpr)));
  post.material.uniforms.uPx.value = PX * dpr;
}
addEventListener('resize', resize);

// ---------- camera ----------
function camOffset(az) {
  const d = 300;
  return new THREE.Vector3(Math.cos(view.el) * Math.sin(az) * d, Math.sin(view.el) * d, Math.cos(view.el) * Math.cos(az) * d);
}
let fly = null;
function flyTo(x, z, zoom) {
  fly = { from: controls.target.clone(), to: new THREE.Vector3(x, 0, z), z0: camera.zoom, z1: zoom ?? Math.max(camera.zoom, 2.2), t: 0 };
}
function rotate(dir) { view.azTarget += dir * Math.PI / 2; }

// ---------- interaction ----------
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let hovered = -1, selected = null;
const tip = $('#tip');
function pick(e) {
  mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  for (const h of ray.intersectObjects(pickables, false)) {
    if (h.object === bodyMesh) { const b = M.buildings[h.instanceId]; if (b.born <= U.time.value) return { b }; }
    else if (h.object.userData.project && h.object.parent.visible) return { p: h.object.userData.project };
  }
  return null;
}
function setHover(i) {
  if (hovered === i) return;
  if (hovered >= 0) bodyMesh.setColorAt(hovered, M.buildings[hovered].color);
  hovered = i;
  if (i >= 0) bodyMesh.setColorAt(i, M.buildings[i].color.clone().lerp(new THREE.Color('#fff2c0'), 0.45));
  bodyMesh.instanceColor.needsUpdate = true;
}
let down = null;
renderer.domElement.addEventListener('pointerdown', e => (down = [e.clientX, e.clientY]));
renderer.domElement.addEventListener('pointermove', e => {
  if (!M || e.buttons) { tip.style.display = 'none'; return; }
  const hit = pick(e);
  setHover(hit?.b ? M.buildings.indexOf(hit.b) : -1);
  renderer.domElement.style.cursor = hit ? 'pointer' : '';
  if (!hit) { tip.style.display = 'none'; return; }
  tip.innerHTML = hit.b
    ? `<b>${esc(hit.b.s.title || hit.b.s.firstPrompt?.slice(0, 60) || 'Untitled session')}</b><br><span style="color:var(--dim)">${esc(hit.b.p.name)} · ${fmtDate(hit.b.s.start)} · ${STYLE[hit.b.cat].label}</span>`
    : `<b>${esc(hit.p.name)}</b><br><span style="color:var(--dim)">${hit.p.sessions.length} sessions${hit.p.live.length ? ` · ${hit.p.live.length} live` : ''}</span>`;
  Object.assign(tip.style, { display: 'block', left: e.clientX + 14 + 'px', top: e.clientY + 14 + 'px' });
});
renderer.domElement.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const hit = pick(e);
  if (hit?.b) showSession(hit.b); else if (hit?.p) showProject(hit.p); else closePanel();
});

// ---------- panels ----------
const panel = $('#panel'), pbody = $('#pbody');
function closePanel() { panel.style.display = 'none'; selected = null; }
$('#close').onclick = closePanel;

async function openTerminal(cwd, sessionId, agent) {
  const r = await fetch('/api/open', { method: 'POST', body: JSON.stringify({ cwd, sessionId, agent }) }).then(r => r.json());
  if (r.error) alert(r.error);
  else if (r.manual) { try { await navigator.clipboard.writeText(r.cmd); alert(`Copied to clipboard, paste it into a terminal:\n\n${r.cmd}`); } catch { prompt('Run this in a terminal:', r.cmd); } }
}
const resumeCmd = (cwd, id, agent) => `cd '${cwd.replace(/'/g, `'\\''`)}' && ${agent === 'codex' ? `codex${id ? ` resume ${id}` : ''}` : `claude${id ? ` --resume ${id}` : ''}`}`;
const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' };

function toolBar(tools) {
  const cats = {};
  for (const [t, n] of Object.entries(tools)) { const c = CATEGORY[t] ?? (t.startsWith('mcp__codegraph') ? 'read' : 'talk'); cats[c] = (cats[c] || 0) + n; }
  const total = Object.values(cats).reduce((a, b) => a + b, 0);
  if (!total) return '<div style="color:var(--dim)">No tool calls</div>';
  const segs = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  return `<div class="bar">${segs.map(([c, n]) => `<div style="flex:${n};background:${STYLE[c].colors[0]}"></div>`).join('')}</div>
    <div class="legend">${segs.map(([c, n]) => `<span><i style="background:${STYLE[c].colors[0]}"></i>${STYLE[c].label} ${n}</span>`).join('')}</div>`;
}

function showSession(b) {
  selected = b;
  const s = b.s, live = b.p.live.find(l => l.sessionId === s.id);
  const top = Object.entries(s.tools).sort((a, c) => c[1] - a[1]).slice(0, 6).map(([t, n]) => `${t} ${n}`).join(', ');
  pbody.innerHTML = `
    <h2>${esc(s.title || 'Untitled session')}</h2>
    <div class="sub"><a href="#" data-proj style="color:var(--blue)">${esc(b.p.name)}</a> · ${STYLE[b.cat].label}${s.source === 'codex' ? ' · Codex' : ''}</div>
    ${live ? `<div class="row" style="padding-left:0"><span class="dot" style="background:${STATUS_COLOR[live.state]}"></span>Live: ${live.state}${live.tool ? ` · last tool ${esc(live.tool)}` : ''} · ${live.pid ? `pid ${live.pid}` : AGENT_NAME[live.source]}</div>` : ''}
    ${s.firstPrompt ? `<div class="prompt">${esc(s.firstPrompt)}</div>` : ''}
    <div class="kv">
      <span>Started</span><span>${new Date(s.start).toLocaleString()}</span>
      <span>Last active</span><span>${ago(s.end)} ago</span>
      <span>Turns</span><span>${s.userTurns} prompts · ${s.assistantTurns} replies</span>
      ${s.source === 'codex' ? `<span>Tokens</span><span>${(s.tokens / 1e6).toFixed(1)}M</span>` : `<span>Cost</span><span>$${s.costUSD.toFixed(2)}</span>`}
      <span>Lines</span><span>+${s.linesAdded} / −${s.linesRemoved}</span>
      <span>Subagents</span><span>${s.subagents}</span>
      <span>Branches</span><span>${esc(Object.keys(s.branches).join(', ') || '—')}</span>
    </div>
    <h4>Activity</h4>${toolBar(s.tools)}
    <div style="color:var(--dim);font-size:11px;margin-top:4px">${esc(top)}</div>
    <div class="actions"><button data-open>Resume in ${s.source === 'codex' ? 'Codex' : 'Terminal'}</button><button data-copy>Copy command</button></div>
    <div class="mono" style="color:var(--dim);word-break:break-all">${esc(s.id)}</div>`;
  pbody.querySelector('[data-open]').onclick = () => openTerminal(b.p.cwd, s.id, s.source);
  pbody.querySelector('[data-copy]').onclick = () => navigator.clipboard.writeText(resumeCmd(b.p.cwd, s.id, s.source));
  pbody.querySelector('[data-proj]').onclick = e => { e.preventDefault(); showProject(b.p); };
  panel.style.display = 'block';
}

function showProject(p) {
  selected = p;
  const cost = p.sessions.reduce((a, s) => a + s.costUSD, 0);
  const allTools = {};
  for (const s of p.sessions) for (const [t, n] of Object.entries(s.tools)) allTools[t] = (allTools[t] || 0) + n;
  const linked = M.highways.filter(h => h.a === p || h.b === p).map(h => ({ q: h.a === p ? h.b : h.a, n: h.n })).sort((a, b) => b.n - a.n);
  const branches = new Set(p.sessions.flatMap(s => Object.keys(s.branches)));
  pbody.innerHTML = `
    <h2>${esc(p.name)}</h2>
    <div class="sub mono">${esc(p.cwd)}</div>
    <div class="kv">
      <span>Region</span><span>${esc(p.region.name || '—')}</span>
      <span>Founded</span><span>${fmtDate(p.start)}</span>
      <span>Last active</span><span>${ago(p.end)} ago</span>
      <span>Sessions</span><span>${p.sessions.length}</span>
      <span>Cost</span><span>$${cost.toFixed(2)}</span>
      <span>Branches</span><span>${esc([...branches].join(', ') || '—')}</span>
    </div>
    <div class="actions"><button data-new>New session in Terminal</button><button data-copy>Copy cd command</button></div>
    ${p.live.length ? `<h4>Live sessions</h4>${p.live.map(s => `<div class="row" data-sid="${s.sessionId}"><span class="dot" style="background:${STATUS_COLOR[s.state]}"></span><span class="nm">${esc(s.name)}</span><span class="meta">${s.state}${s.tool && s.state === 'busy' ? ' · ' + esc(s.tool) : ''} · ${ago(s.updatedAt)}</span></div>`).join('')}` : ''}
    <h4>Activity</h4>${toolBar(allTools)}
    ${p.eparent || p.children.length ? `<h4>Neighbourhood</h4>${[p.eparent, ...p.children].filter(Boolean).map(q => `<div class="row" data-cwd="${esc(q.cwd)}"><span class="nm">${q === p.eparent ? '↑ ' : '↳ '}${esc(q.name)}</span><span class="meta">${q.sessions.length} sessions</span></div>`).join('')}` : ''}
    ${linked.length ? `<h4>Highways (shared files)</h4>${linked.map(({ q, n }) => `<div class="row" data-cwd="${esc(q.cwd)}"><span class="nm">⇄ ${esc(q.name)}</span><span class="meta">${n} file refs</span></div>`).join('')}` : ''}
    <h4>Sessions</h4>
    ${[...p.buildings].sort((a, b) => b.s.end - a.s.end).map(b => `<div class="row" data-bid="${b.s.id}"><span class="dot" style="background:${STYLE[b.cat].colors[0]}"></span><span class="nm">${esc(b.s.title || b.s.firstPrompt?.slice(0, 50) || 'Untitled')}</span><span class="meta">${ago(b.s.end)}</span></div>`).join('')}`;
  pbody.querySelector('[data-new]').onclick = () => openTerminal(p.cwd);
  pbody.querySelector('[data-copy]').onclick = () => navigator.clipboard.writeText(resumeCmd(p.cwd));
  pbody.querySelectorAll('[data-cwd]').forEach(el => (el.onclick = () => { const q = M.byCwd.get(el.dataset.cwd); flyTo(q.cx, q.cz); showProject(q); }));
  pbody.querySelectorAll('[data-bid]').forEach(el => (el.onclick = () => { const b = p.buildings.find(b => b.s.id === el.dataset.bid); flyTo(b.x, b.z, Math.max(camera.zoom, 3)); showSession(b); }));
  pbody.querySelectorAll('[data-sid]').forEach(el => (el.onclick = () => { const b = p.buildings.find(b => b.s.id === el.dataset.sid); if (b) showSession(b); }));
  panel.style.display = 'block';
}

function renderRoster() {
  const groups = [['busy', 'Working'], ['idle', 'Waiting on you'], ['shell', 'Shells']];
  $('#roster').innerHTML = groups.map(([st, title]) => {
    const list = LIVE.filter(s => s.state === st).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!list.length) return '';
    return `<h3 class="pixel">${title} · ${list.length}</h3>` + list.map(s => `
      <div class="row" data-live="${s.sessionId}"><span class="dot" style="background:${STATUS_COLOR[st]}"></span>
      <span class="nm">${esc(s.name)}</span><span class="meta">${st === 'busy' && s.tool ? esc(s.tool) + ' · ' : ''}${ago(s.updatedAt)}</span></div>`).join('');
  }).join('') || '<div style="color:var(--dim)">No live sessions</div>';
  $('#roster').querySelectorAll('[data-live]').forEach(el => (el.onclick = () => {
    const s = LIVE.find(s => s.sessionId === el.dataset.live);
    const b = s.project.buildings.find(b => b.s.id === s.sessionId);
    flyTo(b?.x ?? s.project.cx, b?.z ?? s.project.cz, Math.max(camera.zoom, 2.6));
    b ? showSession(b) : showProject(s.project);
  }));
}

function renderStats() {
  const busy = LIVE.filter(s => s.state === 'busy').length, idle = LIVE.filter(s => s.state === 'idle').length;
  const cost = M.buildings.reduce((a, b) => a + b.s.costUSD, 0);
  $('#stats').innerHTML = `<span><b>${M.projects.length}</b> districts</span><span><b>${M.buildings.length}</b> buildings</span>
    <span><b style="color:var(--amber)">${busy}</b> working</span><span><b style="color:var(--green)">${idle}</b> waiting</span><span><b>$${cost.toFixed(0)}</b> invested</span>`;
}

// ---------- toolbar / timeline ----------
let nightTarget = 0;
const toggle = (id, on) => $(id).classList.toggle('on', on);
$('#night').onclick = () => { nightTarget = nightTarget ? 0 : 1; toggle('#night', !!nightTarget); };
$('#retro').onclick = () => { retro = !retro; toggle('#retro', retro); };
$('#lbls').onclick = () => { showLabels = !showLabels; toggle('#lbls', showLabels); };
$('#rotL').onclick = () => rotate(-1);
$('#rotR').onclick = () => rotate(1);
$('#search').onchange = e => {
  const p = M.projects.find(p => p.name === e.target.value || p.cwd === e.target.value);
  if (p) { flyTo(p.cx, p.cz); showProject(p); e.target.value = ''; e.target.blur(); }
};
const time = $('#time');
let playing = false;
function setTime(v) {
  U.time.value = v;
  time.value = v;
  $('#date').textContent = v >= +time.max - 0.01 ? 'today' : fmtDate(M.t0 + v * DAY);
}
time.oninput = () => { playing = false; $('#play').textContent = '▶'; setTime(+time.value); };
$('#play').onclick = () => {
  playing = !playing;
  $('#play').textContent = playing ? '❚❚' : '▶';
  if (playing && U.time.value >= +time.max - 0.01) setTime(0);
};
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'q') rotate(-1); else if (k === 'e') rotate(1);
  else if (k === 'n') $('#night').click(); else if (k === 'r') $('#retro').click(); else if (k === 'l') $('#lbls').click();
  else if (k === 'escape') closePanel();
  else if (k === ' ') { e.preventDefault(); $('#play').click(); }
});

// ---------- loading ----------
let lastCityLoad = 0;
async function loadCity(fresh) {
  lastCityLoad = Date.now();
  let data;
  try { data = await fetch('/api/city' + (fresh ? '?fresh' : '')).then(r => r.json()); }
  catch { $('#err').style.display = 'grid'; return; }
  const first = !M;
  M = buildModel(data);
  M.home = data.home;
  hovered = -1;
  buildScene(M);
  const maxDay = M.toDay(Date.now()) + 0.5;
  time.max = maxDay;
  U.grow.value = Math.max(0.4, maxDay / 80);
  if (first || !playing) setTime(maxDay);
  $('#projlist').innerHTML = M.projects.map(p => `<option value="${esc(p.name)}">`).join('');
  if (first) {
    camera.zoom = Math.min(1.6, 60 / Math.max(M.world.w, M.world.h));
    camera.updateProjectionMatrix();
  }
  await pollLive();
}

// ---------- frame loop ----------
const clock = new THREE.Clock();
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
  if (!M) return;

  if (playing) {
    const v = U.time.value + dt * (+time.max / 22);
    if (v >= +time.max) { playing = false; $('#play').textContent = '▶'; }
    setTime(Math.min(v, +time.max));
  }
  const tv = U.time.value;
  for (const p of M.projects) p.pad.visible = tv >= p.startDay;
  for (const r of M.roads) r.mesh.visible = tv >= r.mesh.userData.showAfter;
  const present = tv >= +time.max - 0.01;
  liveGroup.visible = present;

  // day / night
  U.night.value += (nightTarget - U.night.value) * Math.min(1, dt * 3);
  const n = U.night.value;
  scene.background.copy(DAY_BG).lerp(NIGHT_BG, n);
  hemi.intensity = 1.6 - 1.25 * n;
  sun.intensity = 2.4 - 2.0 * n;
  sun.color.set('#fff1d6').lerp(new THREE.Color('#8fa6ff'), n);

  // camera
  if (fly) {
    fly.t = Math.min(1, fly.t + dt * 1.6);
    const e = fly.t * fly.t * (3 - 2 * fly.t);
    controls.target.lerpVectors(fly.from, fly.to, e);
    camera.zoom = fly.z0 + (fly.z1 - fly.z0) * e;
    camera.updateProjectionMatrix();
    if (fly.t >= 1) fly = null;
  }
  view.az += (view.azTarget - view.az) * Math.min(1, dt * 6);
  controls.update();
  camera.position.copy(controls.target).add(camOffset(view.az));
  camera.lookAt(controls.target);
  sun.target.position.set(0, 0, 0);

  // highways traffic
  let ci = 0;
  for (const h of M.highways) {
    const vis = tv >= h.showAfter;
    h.tube.visible = vis;
    for (let k = 0; k < h.cars * 2; k++) {
      const dir = k % 2, u0 = (t * 0.05 * (1 + hash(h.a.cwd + k) * 0.5) + k / (h.cars * 2)) % 1, u = dir ? u0 : 1 - u0;
      h.curve.getPointAt(u, pos);
      const tan = h.curve.getTangentAt(u);
      q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), tan);
      pos.y += 0.09;
      m4.compose(pos, q, vis ? one : new THREE.Vector3(0, 0, 0));
      M.carMesh.setMatrixAt(ci++, m4);
    }
  }
  M.carMesh.instanceMatrix.needsUpdate = true;

  // workers
  LIVE.slice(0, 256).forEach((s, i) => {
    const p = s.project, per = 2 * (p.w + p.h + 1);
    const speed = s.state === 'busy' ? 0.9 : s.state === 'idle' ? 0.08 : 0;
    let d = ((s.phase * per + t * speed) % per + per) % per;
    const hw = p.w / 2 + 0.25, hh = p.h / 2 + 0.25;
    let x, z;
    if (d < 2 * hw) { x = -hw + d; z = -hh; } else if ((d -= 2 * hw) < 2 * hh) { x = hw; z = -hh + d; }
    else if ((d -= 2 * hh) < 2 * hw) { x = hw - d; z = hh; } else { d -= 2 * hw; x = -hw; z = hh - Math.min(d, 2 * hh); }
    const bob = s.state === 'busy' ? Math.abs(Math.sin(t * 12 + i)) * 0.04 : 0;
    m4.makeTranslation(p.cx + x, 0.05 + bob, p.cz + z);
    workerMesh.setMatrixAt(i, m4);
  });
  workerMesh.instanceMatrix.needsUpdate = true;
  for (const c of cranes.values()) c.userData.jib.rotation.y = Math.sin(t * 0.6 + c.position.x) * 1.4;
  for (const pb of plumbobs.values()) {
    pb.rotation.y += dt * (pb.userData.busy ? 3 : 0.8);
    pb.position.y += Math.sin(t * 2 + pb.position.x) * 0.003;
  }

  placeLabels();

  if (retro) {
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);
  } else {
    renderer.render(scene, camera);
  }
}

resize();
frame();
loadCity();
setInterval(pollLive, 3000);
setInterval(() => !playing && loadCity(), 5 * 60_000);
