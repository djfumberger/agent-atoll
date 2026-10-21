import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// ---------- config ----------
// A page can set window.ISLES_DEMO = { api(path, body), onReady(ctx) } to run on sample data with no server (the landing page does).
const DEMO = window.ISLES_DEMO;
const api = (path, body) => DEMO ? DEMO.api(path, body)
  : fetch(path, body ? { method: 'POST', body: JSON.stringify(body) } : undefined).then(r => r.json());
const DAY = 864e5;
const PLATEAU = 0.42;            // grass height
const SLOT = 0.74;               // sunflower spiral spacing for buildings (leaves room for streets)
const MAX_ISL = 96, MAX_BOATS = 32;
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
const CATEGORY_WEIGHT = { build: 2, run: 0.7 };
const STYLE = {
  build:  { label: 'Building code', swatch: '#6fa8dc' },
  run:    { label: 'Running commands', swatch: '#c8743f' },
  read:   { label: 'Research', swatch: '#d9c9a0' },
  agents: { label: 'Orchestrating agents', swatch: '#e05a4f' },
  talk:   { label: 'Conversation', swatch: '#9ccf7a' },
};
const STATUS_COLOR = { busy: '#ffbf5a', idle: '#7be08f', shell: '#9aa3ab' };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };
const rng = seed => { let t = Math.floor(seed * 4294967296) >>> 0; return () => { t = (t + 0x6D2B79F5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; };
const pick = (r, a) => a[Math.floor(r() * a.length)];
const ago = t => { const d = (Date.now() - t) / 1000; return d < 90 ? `${d | 0}s` : d < 5400 ? `${(d / 60) | 0}m` : d < 129600 ? `${(d / 3600) | 0}h` : `${(d / 86400) | 0}d`; };
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });

// Island outline: shared by terrain, prop placement and the water shader (keep in sync with GLSL `shape`).
const shape = (th, s) => 1 + 0.10 * Math.sin(3 * th + s * 6.283) + 0.06 * Math.sin(5 * th + s * 12.1) + 0.04 * Math.sin(2 * th + s * 3.3);
const radiusFor = n => Math.max(2.2, (SLOT * Math.sqrt(n + 0.5) + 0.5) / 0.55);
// Height across the island, t = distance / shoreline radius.
function heightAt(t) {
  if (t < 0.64) return PLATEAU;
  if (t < 0.78) { const u = (t - 0.64) / 0.14; return PLATEAU - (PLATEAU - 0.17) * (0.5 - 0.5 * Math.cos(Math.PI * u)); }
  if (t < 1.0) return 0.17 * (1 - (t - 0.78) / 0.22) ** 1.3;
  return -Math.min(0.9, (t - 1.0) * 3.2);
}

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const DAY_FOG = new THREE.Color('#2a6fa8'), NIGHT_FOG = new THREE.Color('#07162a');
scene.background = DAY_FOG.clone();
scene.fog = new THREE.Fog(DAY_FOG.clone(), 60, 200);

const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 1200);
camera.position.set(40, 48, 40);
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 6; controls.maxDistance = 260;
controls.minPolarAngle = 0.35; controls.maxPolarAngle = 1.12;
controls.zoomToCursor = true;

const hemi = new THREE.HemisphereLight('#dff1ff', '#4f6b3a', 1.15);
const sun = new THREE.DirectionalLight('#fff0d0', 3.0);
const SUN_DIR = new THREE.Vector3(-0.55, 0.75, 0.38).normalize();
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.03;
scene.add(hemi, sun, sun.target);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.5, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// shared uniforms: uTime = history time in days (timeline), uClock = wall clock seconds
const U = { time: { value: 1e9 }, grow: { value: 1 }, night: { value: 0 }, clock: { value: 0 } };

// ---------- prop materials: per-vertex growth + glow ----------
// Each merged vertex knows its prop's origin and birth day, so a whole island is a couple of draw calls
// yet every building can pop up (with a little overshoot) when the timeline reaches it.
function propMaterial({ leaf = false, scaleOrigin = false, uR = { value: 1 } } = {}) {
  const key = `prop:${leaf}:${scaleOrigin}`;
  const vtx = sh => {
    Object.assign(sh.uniforms, { uTime: U.time, uGrow: U.grow, uNight: U.night, uClock: U.clock, uR });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aOrigin; attribute float aBorn; attribute float aGlow;
        uniform float uTime, uGrow, uR, uClock;
        varying float vGlow; varying vec3 vOrig;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float g = clamp((uTime - aBorn) / uGrow, 0.0, 1.0);
        float s = g >= 1.0 ? 1.0 : 1.0 + 2.70158 * pow(g - 1.0, 3.0) + 1.70158 * pow(g - 1.0, 2.0);
        vec3 o = aOrigin;
        vec3 base = ${scaleOrigin ? 'vec3(o.x * uR, o.y, o.z * uR)' : 'o'};
        vec3 off = transformed - o;
        ${leaf ? 'off.y += sin(uClock * 1.6 + o.x * 3.0 + o.z * 2.0) * 0.03 * max(0.0, length(off.xz) - 0.15);' : ''}
        transformed = base + off * s;
        if (g <= 0.0) transformed = vec3(0.0, -60.0, 0.0);
        vGlow = aGlow; vOrig = o;`);
  };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.82, metalness: 0, side: leaf ? THREE.DoubleSide : THREE.FrontSide });
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = sh => {
    vtx(sh);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight, uClock; varying float vGlow; varying vec3 vOrig;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vGlow > 1.5) totalEmissiveRadiance += diffuseColor.rgb * (2.2 + 0.6 * sin(uClock * 13.0 + vOrig.x * 7.0) * sin(uClock * 7.0 + vOrig.z * 5.0));
        else if (vGlow > 0.75) totalEmissiveRadiance += vec3(1.0, 0.68, 0.32) * 2.6 * uNight;`);
  };
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: mat.side });
  depth.customProgramCacheKey = () => 'depth' + key;
  depth.onBeforeCompile = vtx;
  return { mat, depth, uR };
}

// ---------- prop kit ----------
const ONE = new THREE.Vector3(1, 1, 1), Y = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const clean = g => { g = g.index ? g.toNonIndexed() : g.clone(); for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); return g; };

const G = {
  box: clean(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)),
  cyl: clean(new THREE.CylinderGeometry(1, 1, 1, 8).translate(0, 0.5, 0)),
  cylHi: clean(new THREE.CylinderGeometry(1, 1, 1, 14).translate(0, 0.5, 0)),
  taper: clean(new THREE.CylinderGeometry(0.62, 1, 1, 12).translate(0, 0.5, 0)),
  cone4: clean(new THREE.ConeGeometry(1, 1, 4).rotateY(Math.PI / 4).translate(0, 0.5, 0)),
  cone8: clean(new THREE.ConeGeometry(1, 1, 10).translate(0, 0.5, 0)),
  roof: clean(new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-0.5, 0), new THREE.Vector2(0.5, 0), new THREE.Vector2(0, 0.5)]), { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5)),
  dome: clean(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2)),
  ball: clean(new THREE.IcosahedronGeometry(1, 1)),
  rocks: [0, 1, 2, 3].map(i => {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const p = g.attributes.position, r = rng(0.13 * (i + 1));
    const seen = new Map();
    for (let k = 0; k < p.count; k++) {
      const key = `${p.getX(k).toFixed(3)},${p.getY(k).toFixed(3)},${p.getZ(k).toFixed(3)}`;
      if (!seen.has(key)) seen.set(key, 0.75 + r() * 0.45);
      const f = seen.get(key);
      p.setXYZ(k, p.getX(k) * f, Math.max(-0.3, p.getY(k) * f * 0.8), p.getZ(k) * f);
    }
    return clean(g);
  }),
  frond: (() => {
    const g = new THREE.PlaneGeometry(1, 0.34, 8, 2).translate(0.5, 0, 0).rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), z = p.getZ(k);
      const w = 0.2 + Math.sin(Math.PI * Math.min(1, x * 1.1)) * 0.95;
      p.setXYZ(k, x, -0.62 * x * x - Math.abs(z * w) * 0.5, z * w);
    }
    g.computeVertexNormals();
    return clean(g);
  })(),
};

class Kit {
  constructor() { this.solid = []; this.leaf = []; this.frame(0, 0, 0); this.born = 0; }
  // Start a prop: its origin is where it grows from; parts are positioned relative to it (rotated by ry).
  frame(x, y, z, ry = 0) {
    this.origin = new THREE.Vector3(x, y, z);
    this.base = new THREE.Matrix4().compose(this.origin, _q.setFromAxisAngle(Y, ry), ONE);
    return this;
  }
  add(geo, color, x, y, z, sx = 1, sy = 1, sz = 1, { rx = 0, ry = 0, rz = 0, glow = 0, leaf = false } = {}) {
    const g = geo.clone();
    _m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
    g.applyMatrix4(this.base.clone().multiply(_m));
    const n = g.attributes.position.count, c = new THREE.Color(color), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.toArray(col, i * 3);
    this.push(g, col, glow, leaf);
  }
  // A v2 house piece (see loadHouses) at height y: role colours (some tinted per building), each window pane lit or not.
  piece(name, y, { ry = 0, tint = {}, lit = 0, r = Math.random } = {}) {
    const m = HM.models[name], g = m.geo.clone(), n = m.role.length;
    _m.compose(_v.set(0, y, 0), _q.setFromAxisAngle(Y, ry), ONE);
    g.applyMatrix4(this.base.clone().multiply(_m));
    const pal = HM.roles.map((k, i) => (tint[k] ? new THREE.Color(tint[k]) : HM.def[i]));
    const on = Array.from({ length: m.panes }, () => (r() < lit ? 1 : 0.5));
    const col = new Float32Array(n * 3), glow = new Float32Array(n);
    for (let i = 0; i < n; i++) { pal[m.role[i]].toArray(col, i * 3); if (m.pane[i] >= 0) glow[i] = on[m.pane[i]]; }
    this.push(g, col, glow, false);
    return HM.meta[name];
  }
  push(g, col, glow, leaf) {   // glow: a constant, or per-vertex Float32Array
    const n = g.attributes.position.count;
    const org = new Float32Array(n * 3), born = new Float32Array(n).fill(this.born), gl = glow instanceof Float32Array ? glow : new Float32Array(n).fill(glow);
    for (let i = 0; i < n; i++) this.origin.toArray(org, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aOrigin', new THREE.BufferAttribute(org, 3));
    g.setAttribute('aBorn', new THREE.BufferAttribute(born, 1));
    g.setAttribute('aGlow', new THREE.BufferAttribute(gl, 1));
    (leaf ? this.leaf : this.solid).push(g);
  }
  build(mats) {
    const out = [];
    for (const [list, m] of [[this.solid, mats.solid], [this.leaf, mats.leaf]]) {
      if (!list.length) continue;
      const mesh = new THREE.Mesh(mergeGeometries(list), m.mat);
      mesh.customDepthMaterial = m.depth;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      out.push(mesh);
    }
    return out;
  }
}

// ---------- houses: Blender models by default; ?houses=classic keeps the original box prefabs ----------
// Built in Blender by tools/blender/build_houses.py, baked by tools/bake-houses.mjs into models/houses.json: low-poly,
// a little organic, every face tagged with a material role (wall, roof, wood, trim, stone, door, glass, accent, metal).
const HOUSES = new URLSearchParams(location.search).get('houses') !== 'classic';
let HM = null;
async function loadHouses() {
  const j = await fetch('models/houses.json').then(r => r.json());
  const glass = j.roles.indexOf('glass');
  HM = { meta: j.meta, roles: j.roles, def: j.roles.map(n => new THREE.Color(j.colors[n])), models: {} };
  for (const [name, m] of Object.entries(j.models)) {
    // window panes = glass triangles joined by shared vertices, so each window lights up on its own
    const up = new Map(), find = v => { while (up.get(v) !== v) v = up.get(v); return v; };
    for (let i = 0; i < m.idx.length; i += 3) if (m.role[m.idx[i]] === glass) {
      const t = m.idx.slice(i, i + 3);
      for (const v of t) if (!up.has(v)) up.set(v, v);
      up.set(find(t[1]), find(t[0])); up.set(find(t[2]), find(t[0]));
    }
    const n = m.idx.length, pos = new Float32Array(n * 3), role = new Uint8Array(n), pane = new Int16Array(n).fill(-1), ids = new Map();
    m.idx.forEach((v, i) => {
      for (let k = 0; k < 3; k++) pos[i * 3 + k] = m.pos[v * 3 + k];
      role[i] = m.role[v];
      if (up.has(v)) { const p = find(v); if (!ids.has(p)) ids.set(p, ids.size); pane[i] = ids.get(p); }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();   // non-indexed, so these are the flat face normals
    HM.models[name] = { geo, role, pane, panes: ids.size };
  }
}
// Stack pieces bottom-up (storeys turn 180° at random so towers don't repeat); returns the top height and the last piece's meta.
function hStack(k, r, lit, kind, names) {
  const [w, f, st] = V2[kind], tint = { wall: w && pick(r, w), roof: f && pick(r, f), stone: st && pick(r, st), wood: pick(r, WOOD), accent: pick(r, ACCENTS) };
  let y = 0, m;
  names.forEach((nm, i) => { m = k.piece(nm, y, { ry: i && i < names.length - 1 && r() < 0.5 ? Math.PI : 0, tint, lit, r }); y += m.storey || 0; });
  return { top: y + m.h, m };
}

// ---------- prefabs (all relative to the current kit frame, ground at y=0) ----------
const WOOD = ['#8b5a2b', '#7a4c22'], ROOFS = ['#b5532f', '#3f7f8c', '#d1802e', '#6b5b95', '#a33b3b'], WALLS = ['#f3ead8', '#ecd9b6', '#dfe8e3', '#f2d8c6', '#e3e9f0'];
const GLASS = '#2a3a4c';
// v2 houses: per-type [wall, roof, stone] families (close to the procedural prefabs'; workshops get lighter plaster so their
// timber frame reads, and brick or stone chimneys); accents are flowers, shutters and awnings
const V2 = { tent: [['#e9dcc0', '#d9c39a', '#e7cfa2'], null], cabin: [null, ['#9a4e2a', '#7c4a2c', '#a8612f']], house: [WALLS, ROOFS],
  tower: [['#e7ecef', '#d5dfe6', '#efe6d6', '#c7d6e2'], ['#4f6475', '#6b5b95', '#3f7f8c']],
  workshop: [['#efdcb8', '#e8c99a', '#f1e4cc', '#e6b98a'], ['#56606b', '#3f7f8c', '#8a4a2c', '#5f6f4a'], ['#9a958c', '#9c5f48', '#a8826a']], round: [['#e2d6bd', '#d6c8a8', '#ece4d2'], ['#4a78b0']] };
const ACCENTS = ['#d9534f', '#e0a73a', '#3f7f8c', '#5b8c5a', '#c06c9b'];

function windows(k, w, d, y, count, lit, r) {
  for (let i = 0; i < count; i++) {
    const u = (i + 0.5) / count - 0.5;
    const g = r() < lit ? 1 : 0.5;
    k.add(G.box, GLASS, u * w * 0.8, y, d / 2 + 0.005, 0.09, 0.12, 0.02, { glow: g });
    k.add(G.box, GLASS, u * w * 0.8, y, -d / 2 - 0.005, 0.09, 0.12, 0.02, { glow: r() < lit ? 1 : 0.5 });
  }
  k.add(G.box, GLASS, w / 2 + 0.005, y, 0, 0.02, 0.12, 0.09, { glow: r() < lit ? 1 : 0.5 });
  k.add(G.box, GLASS, -w / 2 - 0.005, y, 0, 0.02, 0.12, 0.09, { glow: r() < lit ? 1 : 0.5 });
}

function campfire(k, x, z) {
  for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2; k.add(G.rocks[i % 4], '#8d8f93', x + Math.cos(a) * 0.17, 0.02, z + Math.sin(a) * 0.17, 0.05, 0.05, 0.05); }
  for (let i = 0; i < 3; i++) k.add(G.cyl, '#6b4423', x, 0.03, z, 0.03, 0.34, 0.03, { rz: Math.PI / 2 - 0.25, ry: i * 2.1 });
  k.add(G.cone8, '#ff7a1a', x, 0.02, z, 0.09, 0.26, 0.09, { glow: 2 });
  k.add(G.cone8, '#ffd23a', x, 0.02, z, 0.05, 0.17, 0.05, { glow: 2 });
}
function tent(k, r) {
  if (HM) { const t = hStack(k, r, 0, 'tent', [pick(r, ['tent_a', 'tent_b'])]).top; campfire(k, 0.45, 0.25); return t + 0.1; }
  k.add(G.cone4, pick(r, ['#e9dcc0', '#d9c39a', '#e7cfa2']), 0, 0, 0, 0.36, 0.5, 0.36);
  k.add(G.box, '#5a3b22', 0, 0, 0.2, 0.12, 0.2, 0.04);
  campfire(k, 0.45, 0.25);
  k.add(G.cyl, '#6b4423', -0.4, 0, 0.3, 0.06, 0.12, 0.06);       // stump seat
  k.add(G.box, '#8b5a2b', 0.05, 0, -0.42, 0.16, 0.14, 0.12);       // crate
  return 0.55;
}
function cabin(k, r, lit) {
  if (HM) return hStack(k, r, lit, 'cabin', [pick(r, ['cabin_a', 'cabin_b', 'cabin_c'])]).top + 0.1;
  const w = 0.6, d = 0.5, h = 0.4;
  for (let i = 0; i < 4; i++) k.add(G.box, WOOD[i % 2], 0, i * h / 4, 0, w, h / 4, d);
  k.add(G.roof, pick(r, ['#9a4e2a', '#7c4a2c', '#a8612f']), 0, h, 0, w + 0.18, 0.62, d + 0.14);
  k.add(G.box, '#9a958c', w * 0.25, h + 0.05, -0.1, 0.1, 0.32, 0.1);
  k.add(G.box, '#4a2f1a', 0, 0, d / 2 + 0.01, 0.13, 0.24, 0.02);
  windows(k, w, d, 0.2, 1, lit, r);
  if (r() < 0.6) k.add(G.box, '#8b5a2b', -w / 2 - 0.12, 0, 0.12, 0.12, 0.12, 0.12);   // barrel-ish crate
  return h + 0.3;
}
function house(k, r, lit, floors) {
  if (HM) return hStack(k, r, lit, 'house', [pick(r, ['house_ground_a', 'house_ground_b']), ...(floors > 1 ? [pick(r, ['house_upper_a', 'house_upper_b'])] : []), pick(r, ['house_roof_a', 'house_roof_b', 'house_roof_c'])]).top + 0.05;
  const w = 0.62, d = 0.52, fh = 0.34, h = fh * floors;
  k.add(G.box, pick(r, WALLS), 0, 0, 0, w, h, d);
  k.add(G.box, '#c9c1b2', 0, 0, 0, w + 0.03, 0.06, d + 0.03);
  k.add(G.roof, pick(r, ROOFS), 0, h, 0, w + 0.14, 0.6, d + 0.12);
  k.add(G.box, '#5a3b22', 0, 0, d / 2 + 0.01, 0.13, 0.22, 0.02);
  for (let f = 0; f < floors; f++) windows(k, w, d, f * fh + 0.17, 2, lit, r);
  if (r() < 0.5) k.add(G.box, '#a9a39a', -w * 0.25, h + 0.08, 0.05, 0.08, 0.28, 0.08);
  return h + 0.3;
}
function tower(k, r, lit, floors) {
  if (HM) { const fl = pick(r, ['tower_floor_a', 'tower_floor_b']); return hStack(k, r, lit, 'tower', ['tower_base', ...Array.from({ length: floors - 1 }, () => (r() < 0.7 ? fl : 'tower_floor_a')), pick(r, ['tower_top_a', 'tower_top_b'])]).top; }
  const w = 0.62, fh = 0.3, h = fh * floors;
  const wall = pick(r, ['#e7ecef', '#d5dfe6', '#efe6d6', '#c7d6e2']);
  k.add(G.box, '#bfb7a8', 0, 0, 0, w + 0.06, 0.12, w + 0.06);
  k.add(G.box, wall, 0, 0, 0, w, h, w);
  for (let f = 0; f < floors; f++) windows(k, w, w, f * fh + 0.16, 3, lit, r);
  k.add(G.box, pick(r, ['#4f6475', '#6b5b95', '#3f7f8c']), 0, h, 0, w + 0.04, 0.06, w + 0.04);
  k.add(G.box, '#c9cdd2', 0.1, h + 0.06, -0.08, 0.2, 0.14, 0.2);
  if (floors > 5) k.add(G.cyl, '#d0d4d8', -0.15, h + 0.06, 0.15, 0.015, 0.7, 0.015);
  return h + 0.2;
}
function workshop(k, r, lit, big) {
  if (HM) { const { top, m } = hStack(k, r, lit, 'workshop', [big ? 'workshop_big' : pick(r, ['workshop_a', 'workshop_b'])]); return { h: top, smoke: new THREE.Vector3(...m.smoke) }; }
  const w = big ? 0.78 : 0.66, d = 0.52, h = big ? 0.5 : 0.36;
  k.add(G.box, pick(r, ['#c4784a', '#d9c4a0', '#b8643c', '#e0b07a']), 0, 0, 0, w, h, d);
  k.add(G.roof, pick(r, ['#56606b', '#3f7f8c', '#8a4a2c', '#5f6f4a']), 0, h, 0, d + 0.1, 0.4, w + 0.1, { ry: Math.PI / 2 });
  k.add(G.box, '#3b2a1e', -w * 0.15, 0, d / 2 + 0.01, 0.28, 0.26, 0.02);
  windows(k, w, d, h * 0.6, 2, lit, r);
  const cx = w * 0.3, cz = -d * 0.2, ch = h + (big ? 0.75 : 0.5);
  k.add(G.cyl, '#7d3a28', cx, 0, cz, 0.07, ch, 0.07);
  k.add(G.cyl, '#5b2a1d', cx, ch - 0.06, cz, 0.085, 0.06, 0.085);
  return { h: h + 0.35, smoke: new THREE.Vector3(cx, ch + 0.05, cz) };
}
function roundTower(k, r, lit, floors) {
  if (HM) return hStack(k, r, lit, 'round', ['roundtower_base', ...Array.from({ length: floors - 1 }, () => pick(r, ['roundtower_floor_a', 'roundtower_floor_b'])), floors > 1 ? 'roundtower_dome' : 'roundtower_cone']).top + 0.1;
  const h = 0.32 * floors + 0.2;
  k.add(G.cylHi, pick(r, ['#e2d6bd', '#d6c8a8', '#ece4d2']), 0, 0, 0, 0.3, h, 0.3);
  for (let f = 0; f < floors; f++) for (let i = 0; i < 4; i++) {
    const a = i / 4 * Math.PI * 2 + f * 0.6;
    k.add(G.box, GLASS, Math.cos(a) * 0.3, f * 0.32 + 0.2, Math.sin(a) * 0.3, 0.06, 0.12, 0.06, { ry: -a, glow: r() < lit ? 1 : 0.5 });
  }
  if (floors > 1) k.add(G.dome, '#4a78b0', 0, h, 0, 0.3, 0.26, 0.3);
  else k.add(G.cone8, '#4a78b0', 0, h, 0, 0.36, 0.4, 0.36);
  return h + 0.35;
}
function lighthouse(k, r, floors) {
  const segs = Math.max(3, Math.min(7, floors + 1)), sh = 0.24;
  k.add(G.cyl, '#9a958c', 0, 0, 0, 0.34, 0.1, 0.34);
  for (let i = 0; i < segs; i++) {
    const s0 = 0.27 - i * 0.012;
    k.add(G.taper, i % 2 ? '#c8382e' : '#f4f1ea', 0, 0.1 + i * sh, 0, s0, sh, s0);
  }
  const top = 0.1 + segs * sh;
  k.add(G.cyl, '#2f3439', 0, top, 0, 0.24, 0.04, 0.24);
  k.add(G.cyl, '#ffe08a', 0, top + 0.04, 0, 0.13, 0.18, 0.13, { glow: 2 });
  k.add(G.cone8, '#c8382e', 0, top + 0.22, 0, 0.17, 0.2, 0.17);
  return top + 0.45;
}
function palm(k, r, s = 1) {
  const lean = (r() - 0.5) * 0.5, dir = r() * Math.PI * 2, segs = 6, sh = 0.17 * s;
  let x = 0, z = 0;
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    k.add(G.cyl, i % 2 ? '#7a5130' : '#8f6038', x, i * sh, z, 0.055 * s * (1 - t * 0.3), sh * 1.05, 0.055 * s * (1 - t * 0.3), { rz: lean * 0.4 * Math.cos(dir), rx: lean * 0.4 * Math.sin(dir) });
    x += Math.cos(dir) * lean * 0.08 * (i + 1) * s * 0.4; z += Math.sin(dir) * lean * 0.08 * (i + 1) * s * 0.4;
  }
  const ty = segs * sh, n = 7, rot = r() * 6;
  for (let i = 0; i < n; i++) k.add(G.frond, i % 2 ? '#5aa83a' : '#4c9431', x, ty, z, 0.75 * s, 0.75 * s, 0.75 * s, { ry: rot + i / n * Math.PI * 2, rz: 0.25, leaf: true });
  for (let i = 0; i < 3; i++) k.add(G.ball, '#6b4a22', x + Math.cos(i * 2.1) * 0.05 * s, ty - 0.06 * s, z + Math.sin(i * 2.1) * 0.05 * s, 0.04 * s, 0.04 * s, 0.04 * s);
}
function bush(k, r, s = 1) {
  const c = pick(r, ['#3f8f3a', '#4d9b3c', '#357f34']);
  k.add(G.ball, c, 0, 0.05, 0, 0.18 * s, 0.15 * s, 0.18 * s);
  k.add(G.ball, c, 0.12 * s, 0.03, 0.06 * s, 0.12 * s, 0.1 * s, 0.12 * s);
  if (r() < 0.4) for (let i = 0; i < 3; i++) k.add(G.ball, pick(r, ['#e05a7a', '#f2c14e', '#ffffff']), (r() - 0.5) * 0.25 * s, 0.17 * s, (r() - 0.5) * 0.25 * s, 0.025, 0.025, 0.025);
}
function rockPile(k, r, s = 1) {
  const n = 2 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const sc = (0.12 + r() * 0.16) * s;
    k.add(G.rocks[Math.floor(r() * 4)], pick(r, ['#7d8186', '#8e9196', '#6d7176']), (r() - 0.5) * 0.4 * s, sc * 0.2, (r() - 0.5) * 0.4 * s, sc, sc * 0.9, sc, { ry: r() * 6 });
  }
}
function dock(k, r, len) {
  const planks = Math.floor(len / 0.13);
  for (let i = 0; i < planks; i++) k.add(G.box, i % 2 ? '#a0703f' : '#8f6236', 0, 0.12, 0.1 + i * 0.13, 0.42, 0.04, 0.12);
  for (let i = 0; i <= planks; i += 4) for (const sx of [-0.2, 0.2]) k.add(G.cyl, '#6b4423', sx, -0.3, 0.1 + i * 0.13, 0.03, 0.55, 0.03);
}

// ---------- layout ----------
const CANDS = (() => {
  const a = [];
  for (let x = -170; x <= 170; x++) for (let z = -170; z <= 170; z++) a.push([x, z, x * x + z * z]);
  return a.sort((p, q) => p[2] - q[2]);
})();
function packCircles(items, gap) {
  const placed = [];
  for (const it of items) for (const [x, z] of CANDS) {
    if (placed.every(p => Math.hypot(p.ox - x, p.oz - z) >= p.r + it.r + gap)) { it.ox = x; it.oz = z; placed.push(it); break; }
  }
  const cx = placed.reduce((a, p) => a + p.ox, 0) / placed.length, cz = placed.reduce((a, p) => a + p.oz, 0) / placed.length;
  for (const p of placed) { p.ox -= cx; p.oz -= cz; }
  return Math.max(...placed.map(p => Math.hypot(p.ox, p.oz) + p.r));
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
  const projects = data.projects.map(p => ({ ...p, live: [], seed: hash(p.cwd) }));
  const isAnc = (a, b) => b.startsWith(a + '/');
  for (const p of projects) p.hub = p.cwd === data.home || projects.filter(q => isAnc(p.cwd, q.cwd)).length >= 3;
  for (const p of projects) {
    p.eparent = p.hub ? null : projects.filter(q => !q.hub && isAnc(q.cwd, p.cwd)).sort((a, b) => b.cwd.length - a.cwd.length)[0] ?? null;
    p.children = [];
    p.R = radiusFor(p.sessions.length);
    p.startDay = toDay(p.start);
    p.bornDays = p.sessions.map(s => toDay(s.start));
  }
  for (const p of projects) p.eparent?.children.push(p);
  const topOf = p => (p.eparent ? topOf(p.eparent) : p);

  // towns: a top island with satellites (nested projects) joined by bridges
  const towns = new Map();
  for (const p of projects) {
    const key = p.hub ? '__hub' : topOf(p).cwd;
    if (!towns.has(key)) towns.set(key, { key, members: [] });
    towns.get(key).members.push(p);
  }
  for (const t of towns.values()) {
    const placed = [];
    const put = (p, x, z) => { p.lx = x; p.lz = z; placed.push(p); };
    const fits = (p, x, z) => placed.every(q => Math.hypot(q.lx - x, q.lz - z) >= q.R + p.R + 1.4);
    const satellites = (parent) => {
      for (const c of parent.children.sort((a, b) => b.R - a.R)) {
        let done = false;
        for (let extra = 0; !done && extra < 30; extra += 0.8) for (let j = 0; j < 24 && !done; j++) {
          const a = c.seed * 6.283 + j * 2.39996, dist = parent.R + c.R + 2.2 + extra;
          const x = parent.lx + Math.cos(a) * dist, z = parent.lz + Math.sin(a) * dist;
          if (fits(c, x, z)) { put(c, x, z); done = true; }
        }
        satellites(c);
      }
    };
    if (t.key === '__hub') {
      const items = t.members.map(p => ({ p, r: p.R }));
      packCircles(items, 3.5);
      for (const it of items) put(it.p, it.ox, it.oz);
    } else {
      t.top = t.members.find(p => !p.eparent);
      put(t.top, 0, 0);
      satellites(t.top);
    }
    t.r = Math.max(...t.members.map(p => Math.hypot(p.lx, p.lz) + p.R));
  }
  // archipelagos: towns sharing a name family
  const regions = new Map();
  for (const t of towns.values()) {
    let fam = t.top ? t.top.name.toLowerCase().split(/[-_. ]/)[0] : '__hub';
    fam = FAMILY_ALIASES[fam] ?? fam;
    if (!regions.has(fam)) regions.set(fam, { fam, towns: [] });
    regions.get(fam).towns.push(t);
  }
  for (const r of regions.values()) {
    r.towns.sort((a, b) => b.r - a.r);
    r.r = packCircles(r.towns, 4.5);
    const n = r.towns.reduce((a, t) => a + t.members.length, 0);
    const Name = r.fam.charAt(0).toUpperCase() + r.fam.slice(1);
    r.name = r.fam === '__hub' ? 'Home Isles' : n >= 3 ? `${Name} Archipelago` : r.towns.length > 1 ? `${Name} Isles` : null;
  }
  const regionList = [...regions.values()].sort((a, b) => (a.fam === '__hub' ? -1 : b.fam === '__hub' ? 1 : b.r - a.r));
  const worldR = packCircles(regionList, 9);
  for (const r of regionList) for (const t of r.towns) for (const p of t.members) {
    p.cx = r.ox + t.ox + p.lx; p.cz = r.oz + t.oz + p.lz;
    p.region = r; p.town = t;
  }
  for (const r of regionList) { r.cx = r.ox; r.cz = r.oz; }

  // buildings: one per session on a sunflower spiral; the island matures from camp → cabins → houses → towers
  const now = Date.now(), buildings = [];
  for (const p of projects) {
    p.buildings = p.sessions.map((s, k) => {
      const a = k * 2.39996 + p.seed * 6.283, rad = k === 0 ? 0 : SLOT * Math.sqrt(k + 0.5);
      const ageDays = (now - s.end) / DAY;
      return {
        s, p, k, cat: categoryOf(s),
        lx: Math.cos(a) * rad, lz: Math.sin(a) * rad, ry: -a + Math.PI / 2,
        born: toDay(s.start), seed: hash(s.id),
        lit: ageDays < 1 ? 0.9 : ageDays < 7 ? 0.6 : ageDays < 30 ? 0.35 : 0.15,
        floors: 1 + Math.floor(Math.log2(1 + s.assistantTurns) / 1.6),
      };
    });
    buildings.push(...p.buildings);
  }

  const byCwd = new Map(projects.map(p => [p.cwd, p]));
  const links = [];
  for (const p of projects) for (const [cwd, n] of Object.entries(p.links)) {
    const q = byCwd.get(cwd);
    if (!q || q.hub || p.hub || n < 4) continue;
    const ex = links.find(l => l.a === q && l.b === p);
    if (ex) ex.n += n; else links.push({ a: p, b: q, n, kind: 'trade' });
  }
  // ferries chain the towns of each archipelago
  for (const r of regionList) {
    const tops = r.towns.map(t => t.top ?? t.members[0]);
    for (let i = 1; i < tops.length; i++) {
      const near = tops.slice(0, i).reduce((b, q) => (Math.hypot(q.cx - tops[i].cx, q.cz - tops[i].cz) < Math.hypot(b.cx - tops[i].cx, b.cz - tops[i].cz) ? q : b));
      if (!links.some(l => (l.a === near && l.b === tops[i]) || (l.b === near && l.a === tops[i]))) links.push({ a: tops[i], b: near, n: 1, kind: 'ferry' });
    }
  }
  return { t0, toDay, projects, regions: regionList, towns: [...towns.values()], worldR, buildings, links, byCwd };
}

// ---------- terrain ----------
const RINGS = [0, 0.12, 0.25, 0.38, 0.5, 0.58, 0.64, 0.68, 0.72, 0.75, 0.78, 0.82, 0.86, 0.9, 0.94, 0.97, 1.0, 1.04, 1.1, 1.18, 1.3];
function islandGeometry(seed) {
  const SEG = 96, pos = [], col = [], idx = [];
  const grassA = new THREE.Color('#6fb24a'), grassB = new THREE.Color('#5ea33f'), edge = new THREE.Color('#4f8f37');
  const sand = new THREE.Color('#efd9a0'), wet = new THREE.Color('#d6b878'), under = new THREE.Color('#c9b07a');
  const c = new THREE.Color();
  for (let i = 0; i < RINGS.length; i++) for (let j = 0; j < SEG; j++) {
    const th = j / SEG * Math.PI * 2, t = RINGS[i], f = shape(th, seed) * t;
    const x = Math.cos(th) * f, z = Math.sin(th) * f;
    let y = heightAt(t);
    if (t < 0.64) y += 0.025 * Math.sin(x * 5 + seed * 9) * Math.sin(z * 4 - seed * 5);
    pos.push(x, y, z);
    const n = 0.5 + 0.5 * Math.sin(x * 7.1 + seed * 20) * Math.sin(z * 6.3 - seed * 11);
    if (t < 0.7) c.copy(grassA).lerp(grassB, n);
    else if (t < 0.76) c.copy(edge);
    else if (t < 0.93) c.copy(sand).lerp(wet, n * 0.25);
    else if (t <= 1.0) c.copy(wet);
    else c.copy(under);
    col.push(c.r, c.g, c.b);
  }
  for (let i = 0; i < RINGS.length - 1; i++) for (let j = 0; j < SEG; j++) {
    const a = i * SEG + j, b = i * SEG + (j + 1) % SEG, cc = (i + 1) * SEG + j, d = (i + 1) * SEG + (j + 1) % SEG;
    idx.push(a, b, cc, b, d, cc);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
// ---------- baked textures (tileable, generated once on the CPU) ----------
// uTex: R = fbm noise, G = voronoi lace (foam), B = caustic network, A = white noise (sparkles).
// uNrm: wave normal map from a periodic fbm height field. All 256², mipmapped, repeat-wrapped.
function bakeWaterTextures() {
  const N = 256, lerp = (a, b, t) => a + (b - a) * t, sm = t => t * t * (3 - 2 * t);
  const lattice = (g, seed) => { const r = rng(seed), a = new Float32Array(g * g); for (let i = 0; i < a.length; i++) a[i] = r(); return a; };
  const pnoise = (x, y, g, lat) => {
    const fx = x * g, fy = y * g, ix = Math.floor(fx), iy = Math.floor(fy), tx = sm(fx - ix), ty = sm(fy - iy);
    const at = (i, j) => lat[((j % g) + g) % g * g + ((i % g) + g) % g];
    return lerp(lerp(at(ix, iy), at(ix + 1, iy), tx), lerp(at(ix, iy + 1), at(ix + 1, iy + 1), tx), ty);
  };
  const fbm = (x, y, octs) => { let v = 0, w = 0; for (const [g, lat, a] of octs) { v += pnoise(x, y, g, lat) * a; w += a; } return v / w; };
  const octA = [[4, lattice(4, 0.11), 0.5], [8, lattice(8, 0.22), 0.25], [16, lattice(16, 0.33), 0.125], [32, lattice(32, 0.44), 0.0625]];
  const octN = [[8, lattice(8, 0.55), 0.5], [16, lattice(16, 0.66), 0.3], [32, lattice(32, 0.77), 0.2]];
  const cells = (c, seed) => { const r = rng(seed), pts = []; for (let j = 0; j < c; j++) for (let i = 0; i < c; i++) pts.push([(i + r()) / c, (j + r()) / c]); return { c, pts }; };
  const vor = (x, y, { c, pts }) => {
    let f1 = 9, f2 = 9;
    const ci = Math.floor(x * c), cj = Math.floor(y * c);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = ci + di, j = cj + dj, wi = ((i % c) + c) % c, wj = ((j % c) + c) % c;
      const [px, py] = pts[wj * c + wi], qx = px + (i - wi) / c, qy = py + (j - wj) / c;
      const d = Math.hypot(qx - x, qy - y) * c;
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return f2 - f1;
  };
  const laceCells = cells(10, 0.9), causticCells = cells(6, 0.8), white = rng(0.5);
  const tex = new Uint8Array(N * N * 4), height = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, i = (y * N + x) * 4;
    tex[i] = fbm(u, v, octA) * 255;
    tex[i + 1] = (1 - Math.min(1, Math.max(0, (vor(u, v, laceCells) - 0.03) / 0.09))) * 255;
    tex[i + 2] = Math.pow(1 - Math.min(1, vor(u, v, causticCells) / 0.35), 3) * 255;
    tex[i + 3] = white() * 255;
    height[y * N + x] = fbm(u, v, octN);
  }
  const nrm = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const h = (a, b) => height[((b + N) % N) * N + ((a + N) % N)];
    const dx = (h(x + 1, y) - h(x - 1, y)) * 6, dy = (h(x, y + 1) - h(x, y - 1)) * 6, l = Math.hypot(dx, dy, 1), i = (y * N + x) * 4;
    nrm[i] = (-dx / l * 0.5 + 0.5) * 255; nrm[i + 1] = (-dy / l * 0.5 + 0.5) * 255; nrm[i + 2] = (1 / l * 0.5 + 0.5) * 255; nrm[i + 3] = 255;
  }
  const mk = data => {
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
    return t;
  };
  return { tex: mk(tex), nrm: mk(nrm) };
}
const WATER_TEX = bakeWaterTextures();

// Terrain: below the waterline sand darkens with depth and catches animated caustics.
const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
terrainMat.onBeforeCompile = sh => {
  Object.assign(sh.uniforms, { uTex: { value: WATER_TEX.tex }, uClock: U.clock });
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCW;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vCW; uniform sampler2D uTex; uniform float uClock;')
    .replace('#include <color_fragment>', `#include <color_fragment>
      if (vCW.y < 0.03) {
        float u = clamp(-vCW.y / 0.9, 0.0, 1.0), tm = mod(uClock, 1000.0);
        vec2 c = vCW.xz * 0.09;
        float ca = min(texture2D(uTex, c + tm * vec2(0.012, 0.008)).b, texture2D(uTex, c * 1.31 - tm * vec2(0.01, -0.007)).b);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.36, 0.48), u * 0.65) + ca * (1.0 - u * 0.7) * 0.55;
      }`);
};

// ---------- ocean ----------
// Distance-to-shore is baked into a half-float texture whenever an island's size changes
// (R = signed distance, BA = gradient), so the water pass is a handful of texture fetches.
const SHAPE_GLSL = `float shape(float th, float s) { return 1.0 + 0.10 * sin(3.0 * th + s * 6.283) + 0.06 * sin(5.0 * th + s * 12.1) + 0.04 * sin(2.0 * th + s * 3.3); }`;
const SDF_RES = 1024;
const sdfRT = new THREE.WebGLRenderTarget(SDF_RES, SDF_RES, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
const waterUniforms = {
  uClock: U.clock, uNight: U.night,
  uIsl: { value: Array.from({ length: MAX_ISL }, () => new THREE.Vector4(0, 0, -1, 0)) }, uCount: { value: 0 },
  uBoats: { value: Array.from({ length: MAX_BOATS }, () => new THREE.Vector4()) }, uBoatCount: { value: 0 },
  uFogColor: { value: new THREE.Color() }, uFogNear: { value: 60 }, uFogFar: { value: 200 }, uSunDir: { value: SUN_DIR },
  uSdf: { value: sdfRT.texture }, uWorldMin: { value: new THREE.Vector2(-150, -150) }, uWorldSize: { value: new THREE.Vector2(300, 300) },
  uTex: { value: WATER_TEX.tex }, uNrm: { value: WATER_TEX.nrm },
  uStorm: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) }, uStormCount: { value: 0 },
};
const sdfBake = new FullScreenQuad(new THREE.ShaderMaterial({
  uniforms: { uIsl: waterUniforms.uIsl, uCount: waterUniforms.uCount, uWorldMin: waterUniforms.uWorldMin, uWorldSize: waterUniforms.uWorldSize },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `
    #define MAX_ISL ${MAX_ISL}
    uniform vec4 uIsl[MAX_ISL]; uniform int uCount; uniform vec2 uWorldMin, uWorldSize; varying vec2 vUv;
    ${SHAPE_GLSL}
    float sdf(vec2 p) {
      float d = 60.0;
      for (int i = 0; i < MAX_ISL; i++) {
        if (i >= uCount) break;
        vec4 I = uIsl[i];
        if (I.z <= 0.0) continue;
        vec2 q = p - I.xy; float L = length(q);
        if (L - I.z * 1.25 > d) continue;
        d = min(d, L - I.z * shape(atan(q.y, q.x), I.w));
      }
      return d;
    }
    void main() {
      vec2 p = uWorldMin + vUv * uWorldSize; float e = uWorldSize.x / ${SDF_RES}.0;
      float d = sdf(p);
      vec2 g = vec2(sdf(p + vec2(e, 0.0)) - d, sdf(p + vec2(0.0, e)) - d);
      gl_FragColor = vec4(d, 0.0, normalize(g + 1e-6));
    }`,
}));
let sdfKey = '';
function bakeShoreField() {
  const key = waterUniforms.uIsl.value.slice(0, waterUniforms.uCount.value).map(v => v.z.toFixed(2)).join();
  if (key === sdfKey) return;
  sdfKey = key;
  renderer.setRenderTarget(sdfRT);
  sdfBake.render(renderer);
  renderer.setRenderTarget(null);
}

const water = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
  uniforms: waterUniforms, transparent: true, depthWrite: false,
  vertexShader: `varying vec3 vWP; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `
    #define MAX_BOATS ${MAX_BOATS}
    uniform float uClock, uNight, uFogNear, uFogFar; uniform vec3 uFogColor, uSunDir;
    uniform vec4 uBoats[MAX_BOATS]; uniform int uBoatCount;
    uniform sampler2D uSdf, uTex, uNrm; uniform vec2 uWorldMin, uWorldSize;
    uniform vec4 uStorm[8]; uniform int uStormCount;
    varying vec3 vWP;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    // depth fade: turquoise shallows → mid blue → deep blue (smooth, no banding)
    vec3 depthColor(float d) {
      vec3 c = mix(vec3(0.30, 0.86, 0.80), vec3(0.10, 0.55, 0.78), smoothstep(0.0, 2.6, d));
      return mix(c, vec3(0.06, 0.30, 0.58), smoothstep(1.5, 8.0, d));
    }
    void main() {
      vec2 p = vWP.xz;
      float tm = mod(uClock, 1000.0);
      vec2 suv = (p - uWorldMin) / uWorldSize;
      vec4 S = texture2D(uSdf, suv);
      float inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
      float d = mix(60.0, S.r, inside);
      vec2 toShore = -S.ba;
      float camDist = length(vWP - cameraPosition);

      float n = texture2D(uTex, p * 0.035 + tm * vec2(0.006, 0.004)).r;
      vec3 col = depthColor(d);
      float shim = texture2D(uTex, p * 0.09 + tm * vec2(0.01, 0.007)).b * texture2D(uTex, p * 0.13 - tm * vec2(0.008, 0.01)).r;
      col += (1.0 - smoothstep(0.0, 3.0, d)) * shim * 0.25;
      // darker, greyer water under rain clouds and storms
      for (int i = 0; i < 8; i++) {
        if (i >= uStormCount) break;
        float f = (1.0 - smoothstep(uStorm[i].z * 0.5, uStorm[i].z * 1.4, length(p - uStorm[i].xy))) * uStorm[i].w;
        col = mix(col, col * vec3(0.55, 0.62, 0.7), f * 0.75);
      }
      float alpha = mix(0.38, 0.97, smoothstep(0.0, 2.6, d));

      // waves: two scrolling normal taps, calm in the shallows and faded with distance (no far shimmer)
      vec2 uv = p; mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
      vec3 a = texture2D(uNrm, uv * 0.045 + tm * vec2(0.011, 0.006)).rgb, c2 = texture2D(uNrm, r * uv * 0.071 - tm * vec2(0.008, -0.01)).rgb;
      float k = 0.9 * (1.0 - smoothstep(60.0, 200.0, camDist)) * (0.35 + 0.65 * smoothstep(0.0, 3.0, d));
      vec2 tl = (a.rg + c2.rg - 1.0) * k;
      vec3 N = normalize(vec3(tl.x, 1.0, tl.y));
      vec3 V = normalize(cameraPosition - vWP), H = normalize(uSunDir + V);
      float nh = max(dot(N, H), 0.0);

      // foam: contact line, rings rolling toward shore, lace, open-water whitecaps
      float lace = texture2D(uTex, p * 0.11 + n * 0.18 + tm * vec2(0.004, -0.003)).g;
      // thin swells rippling outward from the shore, broken up by noise
      float band = fract(d * 0.75 - tm * 0.28);
      float ring = smoothstep(0.0, 0.04, band) * (1.0 - smoothstep(0.06, 0.16, band)) * (1.0 - smoothstep(0.4, 2.6, d))
                 * step(0.5, texture2D(uTex, p * 0.75 + tm * 0.025).r) * 0.85;
      float contact = 1.0 - smoothstep(0.12, 0.38 + 0.4 * n, d + 0.08 * sin(tm * 1.4 + n * 9.0));
      float foam = max(contact, max(ring, lace * (1.0 - smoothstep(0.05, 1.6 + n, d))));
      vec2 sp = p * vec2(0.9, 1.8) + vec2(tm * 0.35, 0.0);
      vec2 cell = floor(sp), f = fract(sp); float h = hash(cell);
      float life = smoothstep(0.0, 0.5, sin(tm * 0.7 + h * 40.0));
      foam = max(foam, step(0.965, h) * (1.0 - smoothstep(0.06, 0.12, length((f - 0.5) * vec2(1.0, 2.2)))) * life * 0.75 * smoothstep(1.5, 4.0, d));

      // boat and seaplane wakes (V-shaped Kelvin trail + bow foam)
      for (int i = 0; i < MAX_BOATS; i++) {
        if (i >= uBoatCount) break;
        vec4 B = uBoats[i];
        vec2 dir = B.zw; float sp2 = length(dir);
        vec2 q = p - B.xy;
        foam = max(foam, (1.0 - smoothstep(0.12, 0.3, length(q))) * 0.8);
        if (sp2 < 0.01) continue;
        dir /= sp2;
        float along = -dot(q, dir), lat = abs(dot(q, vec2(-dir.y, dir.x)));
        if (along > 0.0 && along < 3.5) {
          float v = 1.0 - smoothstep(0.03, 0.09 + along * 0.02, abs(lat - along * 0.3));
          float cc = 1.0 - smoothstep(0.05, 0.12, lat);
          foam = max(foam, max(v, cc * 0.6) * (1.0 - along / 3.5) * min(1.0, sp2 * 3.0) * (0.6 + 0.4 * lace));
        }
      }

      // ripples as soft light and shade only (no sun glare)
      float glints = 1.0 - smoothstep(0.0, 1.5, foam);
      col *= 0.9 + 0.2 * clamp(dot(N, uSunDir) * 1.6 - 0.6, 0.0, 1.0);

      col = mix(col, vec3(0.96, 0.99, 1.0), clamp(foam, 0.0, 1.0));
      alpha = max(alpha, foam);

      // night: darker, bluer water and a broken moon path toward the camera
      col *= mix(1.0, 0.38, uNight);
      col = mix(col, col * vec3(0.55, 0.75, 1.35), uNight);
      vec3 fwd = normalize(vec3(V.x, 0.0, V.z)), side = vec3(-fwd.z, 0.0, fwd.x);
      vec3 Hm = normalize(normalize(vec3(0.3, 0.55, -0.6)) + V) - N;
      float moon = exp(-pow(dot(Hm, side) * 14.0, 2.0) - pow(dot(Hm, fwd) * 3.0, 2.0));
      col += vec3(0.75, 0.82, 1.0) * step(0.35, moon * (0.4 + n)) * uNight * 0.8 * glints;

      col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, camDist));
      gl_FragColor = vec4(pow(col, vec3(2.2)), alpha);
    }`,
}));
water.renderOrder = 1;
scene.add(water);


// ---------- world construction ----------
const world = new THREE.Group();
scene.add(world);
let M = null;
const sharedMats = { solid: propMaterial(), leaf: propMaterial({ leaf: true }) };

function shorePoint(p, angle, t = 0.97) {
  const R = p.R * shape(angle, p.seed) * t;
  return new THREE.Vector3(p.cx + Math.cos(angle) * R, 0, p.cz + Math.sin(angle) * R);
}

function buildWorld(model) {
  world.clear();
  const { projects, links } = model;

  for (const p of projects) {
    const r = rng(p.seed);
    const g = new THREE.Group();
    g.position.set(p.cx, 0, p.cz);
    const terrain = new THREE.Mesh(islandGeometry(p.seed), terrainMat);
    terrain.receiveShadow = true;
    terrain.castShadow = true;
    g.add(terrain);

    // town: one structure per session, fixed in world units
    const town = new Kit();
    for (const b of p.buildings) {
      town.born = b.born;
      town.frame(b.lx, PLATEAU, b.lz, b.ry);
      const br = rng(b.seed), tier = b.k < 3 ? 0 : b.k < 10 ? 1 : 2;
      let res;
      if (b.k === 0) res = tent(town, br);
      else if (b.cat === 'agents') res = lighthouse(town, br, b.floors);
      else if (tier === 0) res = b.cat === 'run' ? workshop(town, br, b.lit, false) : cabin(town, br, b.lit);
      else if (b.cat === 'run') res = workshop(town, br, b.lit, tier === 2);
      else if (b.cat === 'read') res = roundTower(town, br, b.lit, Math.min(tier === 2 ? 4 : 2, b.floors));
      else if (b.cat === 'build' && tier === 2) res = tower(town, br, b.lit, Math.min(12, b.floors + 1));
      else res = house(town, br, b.lit, Math.min(2, Math.max(1, b.floors - 1)));
      b.h = typeof res === 'number' ? res : res.h;
      if (b.s.source === 'codex' && b.k > 0) {   // Codex sessions fly a pennant
        town.add(G.box, '#3a3f45', 0.16, b.h - 0.3, 0.12, 0.025, 0.42, 0.025);
        town.add(G.box, '#f4f6f8', 0.25, b.h - 0.02, 0.12, 0.17, 0.11, 0.015);
        town.add(G.box, '#1d2125', 0.25, b.h - 0.02, 0.122, 0.07, 0.05, 0.015);
      }
      if (res.smoke) b.smoke = res.smoke.clone().applyAxisAngle(Y, b.ry).add(new THREE.Vector3(b.lx, PLATEAU, b.lz));
      if (b.k === 0) b.smoke = new THREE.Vector3(0.45, 0.25, 0.25).applyAxisAngle(Y, b.ry).add(new THREE.Vector3(b.lx, PLATEAU, b.lz));
      // a few bushes around the newer lots
      if (br() < 0.5) { town.frame(b.lx + (br() - 0.5) * 0.9, PLATEAU, b.lz + (br() - 0.5) * 0.9); bush(town, br, 0.7); }
    }
    // streets: each building joins the nearest older one, laid from the old lot toward the new,
    // so a settlement reads as one connected place; towns get cobbles and a central square
    const big = p.sessions.length >= 11;
    const pathCol = big ? ['#c2baa9', '#b1a897'] : ['#c9a46a', '#bd975d'];
    for (const b of p.buildings.slice(1)) {
      const prev = p.buildings.slice(0, b.k).reduce((a, c) => (Math.hypot(c.lx - b.lx, c.lz - b.lz) < Math.hypot(a.lx - b.lx, a.lz - b.lz) ? c : a));
      street(town, prev.lx, prev.lz, b.lx, b.lz, b.born, big ? 0.24 : 0.15, pathCol);
    }
    if (big) {
      town.born = p.bornDays[10];
      town.frame(0, PLATEAU, 0);
      town.add(G.cylHi, '#c9c1b0', 0, 0, 0, 0.95, 0.03, 0.95);
      town.add(G.cylHi, '#b1a897', 0, 0, 0, 0.7, 0.035, 0.7);
    }
    g.add(...town.build(sharedMats));

    // rim decor: positions in unit-island coords so it rides the shoreline as the island grows
    const uR = { value: p.R };
    const mats = { solid: propMaterial({ scaleOrigin: true, uR }), leaf: propMaterial({ leaf: true, scaleOrigin: true, uR }) };
    const rim = new Kit();
    const unit = (th, t) => { const f = shape(th, p.seed) * t; return [Math.cos(th) * f, heightAt(t), Math.sin(th) * f]; };
    const palms = Math.round(3 + p.R * 1.4);
    for (let i = 0; i < palms; i++) {
      const th = r() * Math.PI * 2, t = 0.72 + r() * 0.16;
      rim.born = p.bornDays[Math.min(p.bornDays.length - 1, Math.floor(r() * Math.min(4, p.bornDays.length)))];
      rim.frame(...unit(th, t)); palm(rim, r, 0.9 + r() * 0.5);
    }
    for (let i = 0; i < Math.round(2 + p.R); i++) {
      const th = r() * Math.PI * 2, t = 0.84 + r() * 0.22;
      rim.born = p.startDay; rim.frame(...unit(th, t)); rockPile(rim, r, 1 + r());
    }
    for (let i = 0; i < Math.round(3 + p.R * 1.5); i++) {
      const th = r() * Math.PI * 2, t = 0.6 + r() * 0.12;
      rim.born = p.startDay; rim.frame(...unit(th, t)); bush(rim, r, 0.8 + r() * 0.5);
    }
    // dock facing the open sea (away from the town centre)
    const away = Math.atan2(p.cz - (p.town.top?.cz ?? 0), p.cx - (p.town.top?.cx ?? 0)) || p.seed * 6.283;
    p.dockAngle = away + (r() - 0.5) * 0.8;
    rim.born = p.bornDays[Math.min(1, p.bornDays.length - 1)] + 0.01;
    const [dx, , dz] = unit(p.dockAngle, 0.9);
    rim.frame(dx, 0, dz, -p.dockAngle + Math.PI / 2);
    dock(rim, r, 1.4);
    for (let i = 0; i <= 12; i++) {
      const t = 0.45 + i / 12 * 0.43, [ux, uy, uz] = unit(p.dockAngle, t);
      rim.frame(ux, uy + 0.015, uz, -p.dockAngle + Math.PI / 2);
      rim.add(G.box, i % 2 ? pathCol[0] : pathCol[1], 0, 0, 0, big ? 0.26 : 0.18, 0.02, 0.24);
    }
    p.dockUnit = new THREE.Vector3(dx, 0, dz);
    g.add(...rim.build(mats));

    // moored rowboat
    p.rowboat = makeRowboat(pick(r, ['#9a5b32', '#b5532f', '#3f7f8c']));
    g.add(p.rowboat);
    p.group = g; p.terrain = terrain; p.uR = uR; p.Rcur = 0;
    world.add(g);
  }

  // bridges between parent and satellite islands, built plank by plank
  const bridges = new Kit();
  for (const p of projects) if (p.eparent) {
    const q = p.eparent, ang = Math.atan2(p.cz - q.cz, p.cx - q.cx);
    const A = shorePoint(q, ang, 0.86), B = shorePoint(p, ang + Math.PI, 0.86);
    const len = A.distanceTo(B), n = Math.max(4, Math.floor(len / 0.16)), dir = B.clone().sub(A).normalize();
    const ry = Math.atan2(dir.x, dir.z);
    for (let i = 0; i <= n; i++) {
      const u = i / n, pos = A.clone().lerp(B, u);
      const y = 0.22 + Math.sin(Math.PI * u) * 0.3;
      bridges.born = p.startDay + u * 1.2 * U.grow.value + 0.02;
      bridges.frame(pos.x, y, pos.z, ry);
      bridges.add(G.box, i % 2 ? '#a0703f' : '#8f6236', 0, 0, 0, 0.5, 0.04, 0.15);
      if (i % 4 === 0) for (const sx of [-0.24, 0.24]) {
        bridges.add(G.cyl, '#6b4423', sx, -y - 0.4, 0, 0.025, y + 0.62, 0.025);
        if (i < n) bridges.add(G.cyl, '#d8c49a', sx, 0.2, 0, 0.008, 4 * len / n, 0.008, { rx: Math.PI / 2 - Math.atan2(Math.sin(Math.PI * (u + 2 / n)) * 0.3 - Math.sin(Math.PI * u) * 0.3, 4 * len / n) });
      }
    }
  }
  const bridgeMeshes = bridges.build(sharedMats);
  if (bridgeMeshes.length) world.add(...bridgeMeshes);

  // sailing routes: trade (shared files) uses sailboats, ferries link an archipelago's towns
  model.routes = links.map(l => {
    const ang = Math.atan2(l.b.cz - l.a.cz, l.b.cx - l.a.cx);
    const A = shorePoint(l.a, ang, 1.35), B = shorePoint(l.b, ang + Math.PI, 1.35);
    const mid = A.clone().lerp(B, 0.5), perp = new THREE.Vector3(-(B.z - A.z), 0, B.x - A.x).normalize();
    mid.addScaledVector(perp, (hash(l.a.cwd + l.b.cwd) - 0.5) * A.distanceTo(B) * 0.5);
    const curve = new THREE.QuadraticBezierCurve3(A, mid, B);
    const count = l.kind === 'trade' ? Math.min(3, 1 + Math.floor(Math.log2(l.n) / 2)) : 1;
    const boats = [];
    for (let i = 0; i < count; i++) {
      const b = l.kind === 'trade' ? makeSailboat(pick(rng(hash(l.a.cwd + i)), ['#ffffff', '#ffe9c2', '#f2d1c9'])) : makeRowboat('#8f6236', true);
      world.add(b);
      boats.push({ mesh: b, phase: hash(l.b.cwd + i), speed: (l.kind === 'trade' ? 0.9 : 0.6) / curve.getLength() });
    }
    const lane = seaLane(curve, l);
    world.add(lane);
    return { ...l, curve, boats, lane, showAfter: Math.max(l.a.startDay, l.b.startDay) };
  });

  buildLabels(model);
  spawnStaticNpcs(model);
}

function street(k, x1, z1, x2, z2, born, w, cols) {
  const L = Math.hypot(x2 - x1, z2 - z1), n = Math.max(1, Math.round(L / 0.3)), ry = Math.atan2(x2 - x1, z2 - z1);
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    k.born = born - 0.15 * U.grow.value * (1 - u);     // paved from the old lot toward the new one
    k.frame(x1 + (x2 - x1) * u, PLATEAU + 0.02, z1 + (z2 - z1) * u, ry);
    k.add(G.box, cols[i % 2], 0, 0, 0, w, 0.02, L / n + 0.01);
  }
}

// Shipping lane: dashed foam line on the water, wider for heavier traffic; strong trade routes get buoys.
const laneMat = { trade: new THREE.MeshBasicMaterial({ color: '#f2fbff', transparent: true, opacity: 0.32, depthWrite: false }),
                  ferry: new THREE.MeshBasicMaterial({ color: '#f2fbff', transparent: true, opacity: 0.18, depthWrite: false }) };
const buoyMats = ['#e0483e', '#f4f1ea'].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
function seaLane(curve, l) {
  const g = new THREE.Group();
  const len = curve.getLength(), w = l.kind === 'trade' ? 0.04 + 0.022 * Math.log2(l.n) : 0.04;
  const dashes = [], pt = new THREE.Vector3(), tn = new THREE.Vector3();
  const n = Math.floor(len / 0.55);
  for (let i = 1; i < n; i++) {
    const u = i / n;
    curve.getPointAt(u, pt); curve.getTangentAt(u, tn);
    dashes.push(new THREE.PlaneGeometry(w, 0.2).rotateX(-Math.PI / 2).rotateY(Math.atan2(tn.x, tn.z)).translate(pt.x, 0.015, pt.z));
  }
  if (dashes.length) {
    const m = new THREE.Mesh(mergeGeometries(dashes), laneMat[l.kind]);
    m.renderOrder = 2;
    g.add(m);
  }
  if (l.kind === 'trade' && l.n >= 16) {
    const every = 5, count = Math.floor(len / every);
    for (let i = 1; i < count; i++) {
      const u = i / count;
      curve.getPointAt(u, pt); curve.getTangentAt(u, tn);
      const side = i % 2 ? 1 : -1, off = w / 2 + 0.3;
      const b = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.22, 10), buoyMats[0]);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.08, 0.06, 10), buoyMats[1]);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshStandardMaterial({ color: '#ffe08a', emissive: '#ffb347', emissiveIntensity: 0 }));
      band.position.y = 0.05; lamp.position.y = 0.15;
      b.add(body, band, lamp);
      b.position.set(pt.x - tn.z * off * side, 0, pt.z + tn.x * off * side);
      b.traverse(o => (o.castShadow = true));
      b.userData = { phase: hash(l.a.cwd + i), lamp };
      g.add(b);
    }
  }
  return g;
}

// Boat hull: a box pinched to a bow at +z and narrowed along the keel. Forward is +z.
function hullGeometry(len, width, depth) {
  const g = new THREE.BoxGeometry(width, depth, len, 1, 1, 4).translate(0, depth / 2 - depth * 0.55, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const u = z / (len / 2);                       // -1 stern … +1 bow
    const pinch = u > 0 ? 1 - u * u * 0.95 : 1 - u * u * 0.25;
    x *= pinch;
    if (y < 0) { x *= 0.45; z *= 0.88; }
    if (u > 0.9) y += 0.04;                          // raised bow
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}
function makeRowboat(color, withRower) {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(hullGeometry(0.6, 0.26, 0.14), new THREE.MeshStandardMaterial({ color, roughness: 0.8, flatShading: true }));
  const inside = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.02, 0.4), new THREE.MeshStandardMaterial({ color: '#5a3b22' }));
  inside.position.y = 0.055;
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 0.06), new THREE.MeshStandardMaterial({ color: '#c49a6c' }));
  seat.position.y = 0.075;
  g.add(hull, inside, seat);
  if (withRower) {
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.07, 2, 6), new THREE.MeshStandardMaterial({ color: '#e0d2b4' }));
    body.position.y = 0.14;
    g.add(body);
  }
  g.traverse(o => (o.castShadow = true));
  g.userData.kind = 'row';
  return g;
}
function makeSailboat(sail) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: '#8a5530', roughness: 0.8, flatShading: true });
  const hull = new THREE.Mesh(hullGeometry(0.8, 0.3, 0.18), new THREE.MeshStandardMaterial({ color: '#3f6f8c', roughness: 0.7, flatShading: true }));
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.5), wood);
  deck.position.y = 0.075;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.8, 6), wood);
  mast.position.set(0, 0.47, 0.06);
  const sailGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.14, 0.07), new THREE.Vector3(0, 0.84, 0.065), new THREE.Vector3(0, 0.14, -0.32)]);
  sailGeo.computeVertexNormals();
  const s = new THREE.Mesh(sailGeo, new THREE.MeshStandardMaterial({ color: sail, side: THREE.DoubleSide, roughness: 0.9 }));
  s.position.x = 0.02;
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.08), new THREE.MeshStandardMaterial({ color: '#e05a4f', side: THREE.DoubleSide }));
  flag.position.set(0, 0.84, -0.01); flag.rotation.y = Math.PI / 2;
  g.add(hull, deck, mast, s, flag);
  g.traverse(o => (o.castShadow = true));
  g.userData.kind = 'sail';
  return g;
}

// ---------- live layer ----------
const liveGroup = new THREE.Group();
scene.add(liveGroup);
const villagerGeo = mergeGeometries([new THREE.CapsuleGeometry(0.055, 0.1, 2, 8).translate(0, 0.11, 0), new THREE.SphereGeometry(0.05, 10, 8).translate(0, 0.25, 0)]);
const villagers = new THREE.InstancedMesh(villagerGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), 256);
villagers.castShadow = true;
villagers.count = 0;
liveGroup.add(villagers);
let LIVE = [];
const markers = new Map(), scaffolds = new Map();

function markerTexture(symbol, color) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(0,0,0,0.25)'; x.beginPath(); x.arc(64, 68, 50, 0, 7); x.fill();
  x.fillStyle = color; x.beginPath(); x.arc(64, 62, 50, 0, 7); x.fill();
  x.lineWidth = 6; x.strokeStyle = '#fff8e6'; x.stroke();
  x.fillStyle = '#1d2a33'; x.font = '700 72px Fredoka, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(symbol, 64, 66);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const MARK = { busy: markerTexture('⚙', '#ffbf5a'), idle: markerTexture('!', '#7be08f') };

function makeScaffold(h) {
  const g = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: '#d9a441', roughness: 0.8 });
  for (const [x, z] of [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, h, 5), m); pole.position.set(x, h / 2, z); g.add(pole);
  }
  for (let y = 0.3; y < h; y += 0.35) for (const [x, z, ry] of [[0, -0.42, 0], [0, 0.42, 0], [-0.42, 0, Math.PI / 2], [0.42, 0, Math.PI / 2]]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.025, 0.025), m); bar.position.set(x, y, z); bar.rotation.y = ry; g.add(bar);
  }
  g.traverse(o => (o.castShadow = true));
  return g;
}

function projectFor(cwd) {
  if (M.byCwd.has(cwd)) return M.byCwd.get(cwd);
  return M.projects.filter(p => cwd.startsWith(p.cwd + '/')).sort((a, b) => b.cwd.length - a.cwd.length)[0] ?? null;
}

function applyLive(list) {
  LIVE = list.map(s => ({ ...s, state: s.busy ? 'busy' : s.status === 'shell' ? 'shell' : 'idle', project: projectFor(s.cwd) })).filter(s => s.project);
  for (const p of M.projects) p.live = [];
  for (const s of LIVE) { s.project.live.push(s); s.phase = hash(s.sessionId); s.building = s.project.buildings.find(b => b.s.id === s.sessionId); }

  const want = new Set();
  for (const s of LIVE.filter(s => s.state === 'busy' && s.building)) {
    want.add(s.sessionId);
    if (scaffolds.has(s.sessionId)) continue;
    const b = s.building, sc = makeScaffold(b.h + 0.1);
    sc.position.set(s.project.cx + b.lx, PLATEAU, s.project.cz + b.lz);
    sc.rotation.y = b.ry;
    liveGroup.add(sc);
    scaffolds.set(s.sessionId, sc);
  }
  for (const [id, sc] of scaffolds) if (!want.has(id)) { liveGroup.remove(sc); scaffolds.delete(id); }

  // quest-style markers: ⚙ working, ! waiting on you
  for (const p of M.projects) {
    const st = p.live.some(s => s.state === 'busy') ? 'busy' : p.live.some(s => s.state === 'idle') ? 'idle' : null;
    let mk = markers.get(p.cwd);
    if (!st) { if (mk) { liveGroup.remove(mk); markers.delete(p.cwd); } continue; }
    if (!mk) { mk = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false })); mk.renderOrder = 10; liveGroup.add(mk); markers.set(p.cwd, mk); }
    mk.material.map = MARK[st]; mk.material.needsUpdate = true;
    const top = Math.max(1.2, ...p.buildings.map(b => b.h ?? 0)) + PLATEAU;
    mk.userData = { p, base: top + 0.9, st };
  }

  villagers.count = Math.min(256, LIVE.length);
  LIVE.slice(0, 256).forEach((s, i) => villagers.setColorAt(i, new THREE.Color(STATUS_COLOR[s.state])));
  if (villagers.instanceColor) villagers.instanceColor.needsUpdate = true;
  syncLiveNpcs();
  renderRoster(); renderStats(); updateLabelCounts();
}

let lastCityLoad = 0;
async function pollLive() {
  if (!M?.projects.length) return;
  try {
    const r = await api('/api/live');
    const unknown = r.live.some(s => s.status !== 'shell' && !M.buildings.some(b => b.s.id === s.sessionId) && Date.now() - s.startedAt > 60_000);
    applyLive(r.live);
    if (unknown && Date.now() - lastCityLoad > 60_000) loadWorld(true);
  } catch {}
}

// ---------- smoke ----------
const SMOKE_N = 700;
const smokeGeo = new THREE.BufferGeometry();
const smokePos = new Float32Array(SMOKE_N * 3), smokeLife = new Float32Array(SMOKE_N).fill(1), smokeSize = new Float32Array(SMOKE_N), smokeShade = new Float32Array(SMOKE_N);
smokeGeo.setAttribute('position', new THREE.BufferAttribute(smokePos, 3));
smokeGeo.setAttribute('aLife', new THREE.BufferAttribute(smokeLife, 1));
smokeGeo.setAttribute('aShade', new THREE.BufferAttribute(smokeShade, 1));
const smoke = new THREE.Points(smokeGeo, new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, uniforms: { uNight: U.night, uScale: { value: 400 } },
  vertexShader: `attribute float aLife; attribute float aShade; uniform float uScale; varying float vLife; varying float vShade;
    void main() { vLife = aLife; vShade = aShade; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
      gl_PointSize = (0.08 + aLife * 0.35) * uScale / -mv.z; }`,
  fragmentShader: `uniform float uNight; varying float vLife; varying float vShade;
    void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
      float a = (1.0 - smoothstep(0.2, 0.5, d)) * (1.0 - vLife) * 0.55;
      vec3 c = mix(vec3(0.95), vec3(0.55), vShade) * mix(1.0, 0.3, uNight);
      gl_FragColor = vec4(pow(c, vec3(2.2)), a); }`,
}));
smoke.frustumCulled = false;
scene.add(smoke);
let smokeNext = 0;
function emitSmoke(x, y, z, shade) {
  const i = smokeNext = (smokeNext + 1) % SMOKE_N;
  smokePos.set([x + (Math.random() - 0.5) * 0.05, y, z + (Math.random() - 0.5) * 0.05], i * 3);
  smokeLife[i] = 0; smokeShade[i] = shade;
}

// ---------- labels ----------
const labelsEl = $('#labels');
let labels = [];
function buildLabels(model) {
  labelsEl.innerHTML = ''; labels = [];
  for (const r of model.regions) if (r.name) {
    const el = document.createElement('div'); el.className = 'lbl region'; el.textContent = r.name; labelsEl.append(el);
    labels.push({ el, kind: 'region', r, pos: new THREE.Vector3(r.cx, 0, r.cz - r.r * 0.7) });
  }
  for (const p of model.projects) {
    const el = document.createElement('div'); el.className = 'lbl island'; labelsEl.append(el);
    labels.push({ el, kind: 'island', p, pos: new THREE.Vector3(p.cx, 0.2, p.cz) });
  }
  updateLabelCounts();
}
function updateLabelCounts() {
  for (const l of labels) if (l.kind === 'island') {
    const n = l.p.live.length, busy = l.p.live.some(s => s.state === 'busy');
    l.el.innerHTML = esc(l.p.hub ? (l.p.cwd === M.home ? '~ home' : l.p.name) : l.p.name) + (n ? `<span class="n" style="color:${busy ? 'var(--amber)' : 'var(--green)'}">●${n}</span>` : '');
  }
}
const bubbles = new Map();
const tmpV = new THREE.Vector3();
function toScreen(v) {
  tmpV.copy(v).project(camera);
  return tmpV.z > 1 ? null : [(tmpV.x + 1) / 2 * innerWidth, (1 - tmpV.y) / 2 * innerHeight];
}
// Labels: all island names, only the hovered island's name, or none.
const LABEL_MODES = ['all', 'hover', 'off'];
let labelMode = 'all', hoverIsland = null;
try { labelMode = LABEL_MODES.includes(localStorage.getItem('isles.labels')) ? localStorage.getItem('isles.labels') : 'all'; } catch {}
function placeLabels(camDist) {
  for (const l of labels) {
    let vis = labelMode !== 'off';
    if (l.kind === 'region') vis &&= camDist > 55;
    else if (labelMode === 'hover') vis &&= l.p === hoverIsland && l.p.Rcur > 0.3;
    else vis &&= l.p.Rcur > 0.3 && (camDist < 110 || l.p.live.length > 0);
    const s = vis && toScreen(l.kind === 'island' ? tmpV.set(l.p.cx, 0.2, l.p.cz + l.p.Rcur * 1.05) : l.pos);
    if (!s) { l.el.style.display = 'none'; continue; }
    l.el.style.display = '';
    l.el.style.transform = `translate(${s[0]}px, ${s[1]}px) translate(-50%, -50%)`;
  }
  const want = new Set();
  if (labelMode !== 'off' && liveGroup.visible) for (const s of LIVE) if (s.state === 'busy' && s.building) {
    want.add(s.sessionId);
    let el = bubbles.get(s.sessionId);
    if (!el) { el = document.createElement('div'); el.className = 'lbl bubble'; labelsEl.append(el); bubbles.set(s.sessionId, el); }
    el.textContent = s.tool ? `${s.tool.replace(/^mcp__[^_]+__/, '').slice(0, 24)}…` : 'thinking…';
    const sc = toScreen(tmpV.set(s.project.cx + s.building.lx, PLATEAU + s.building.h + 0.35, s.project.cz + s.building.lz));
    el.style.display = sc ? '' : 'none';
    if (sc) el.style.transform = `translate(${sc[0]}px, ${sc[1]}px) translate(-50%, -100%)`;
  }
  for (const [id, el] of bubbles) if (!want.has(id)) { el.remove(); bubbles.delete(id); }
}

// ---------- interaction ----------
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(), box3 = new THREE.Box3(), hitP = new THREE.Vector3();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), -PLATEAU);
const selRing = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffe08a', transparent: true, opacity: 0.9, depthWrite: false }));
selRing.visible = false; scene.add(selRing);
const hoverRing = selRing.clone(); hoverRing.material = selRing.material.clone(); hoverRing.material.opacity = 0.5; scene.add(hoverRing);
const tip = $('#tip');

function pickAt(e) {
  mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const npc = pickNpc();
  if (npc) return { npc, p: npc.p };
  const hot = pickHot();
  if (hot) return { hot, p: hot.p };
  let best = null, bestD = Infinity;
  for (const b of M.buildings) {
    if (b.born > U.time.value) continue;
    const x = b.p.cx + b.lx, z = b.p.cz + b.lz;
    box3.min.set(x - 0.38, PLATEAU, z - 0.38); box3.max.set(x + 0.38, PLATEAU + b.h, z + 0.38);
    if (ray.ray.intersectBox(box3, hitP)) { const d = hitP.distanceTo(ray.ray.origin); if (d < bestD) { bestD = d; best = { b }; } }
  }
  if (best) return best;
  if (ray.ray.intersectPlane(ground, hitP)) for (const p of M.projects) {
    if (p.Rcur <= 0) continue;
    const dx = hitP.x - p.cx, dz = hitP.z - p.cz;
    if (Math.hypot(dx, dz) < p.Rcur * shape(Math.atan2(dz, dx), p.seed) * 0.95) return { p };
  }
  return null;
}
const ringAt = (ring, b) => { ring.visible = !!b; if (b) ring.position.set(b.p.cx + b.lx, PLATEAU + 0.02, b.p.cz + b.lz); };

let down = null;
renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; if (tour) { endTour(); down = null; } });
renderer.domElement.addEventListener('pointermove', e => {
  if (!M || e.buttons) { tip.style.display = 'none'; return; }
  const hit = pickAt(e);
  ringAt(hoverRing, hit?.b);
  hoverIsland = hit?.p ?? hit?.b?.p ?? null;
  renderer.domElement.style.cursor = hit ? 'pointer' : '';
  if (!hit) { tip.style.display = 'none'; return; }
  tip.innerHTML = hit.hot ? hit.hot.tip() : hit.npc ? `<b>${esc(hit.npc.name)}</b><br><span style="color:var(--dim)">${ROLES[hit.npc.role].title} · click to talk</span>`
    : hit.b
    ? `<b>${esc(hit.b.s.title || hit.b.s.firstPrompt?.slice(0, 60) || 'Untitled session')}</b><br><span style="color:var(--dim)">${esc(hit.b.p.name)} · ${fmtDate(hit.b.s.start)} · ${STYLE[hit.b.cat].label}</span>`
    : `<b>${weatherOf(hit.p).icon} ${esc(hit.p.name)}</b><br><span style="color:var(--dim)">${hit.p.sessions.length} sessions${hit.p.live.length ? ` · ${hit.p.live.length} live` : ''} · ${esc(weatherOf(hit.p).reason)}</span>`;
  Object.assign(tip.style, { display: 'block', left: e.clientX + 14 + 'px', top: e.clientY + 14 + 'px' });
});
renderer.domElement.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const hit = pickAt(e);
  if (hit?.hot) hit.hot.click();
  else if (hit?.npc) openDialog(hit.npc);
  else if (hit?.b) showSession(hit.b); else if (hit?.p) showProject(hit.p); else { closePanel(); closeDialog(); }
});

// ---------- villagers you can talk to ----------
// Elders/keepers live by the campfire, harbourmasters on the dock, foremen beside busy builds and
// messengers walk the island when sessions are waiting. Their opening lines come straight from the
// records; "Ask…" questions go to a tool-less `claude -p` on the server, answered in character.
const NAMES = ['Maren', 'Tobias', 'Ondine', 'Pip', 'Hollis', 'Wren', 'Bramble', 'Juniper', 'Cosmo', 'Isla', 'Fenn', 'Marlo', 'Sable', 'Rook', 'Tilly', 'Otto', 'Nell', 'Bastian', 'Coral', 'Dory', 'Quill', 'Hazel', 'Barnaby', 'Mags', 'Perrin', 'Saffi', 'Gus', 'Lark'];
const ROLES = {
  elder:     { title: 'Village Elder', body: '#7b5ea7', icon: '🧙', accent: '#b89cff' },
  keeper:    { title: 'Island Keeper', body: '#5f8f4e', icon: '🌴', accent: '#9ccf7a' },
  harbour:   { title: 'Harbourmaster', body: '#2f5d8a', icon: '⚓', accent: '#6fb8ff' },
  foreman:   { title: 'Foreman', body: '#d98b2b', icon: '🔨', accent: '#ffbf5a' },
  messenger: { title: 'Messenger', body: '#3f9b6a', icon: '✉️', accent: '#7be08f' },
  crier:     { title: 'Town Crier', body: '#a33b3b', icon: '🔔', accent: '#ffcf6b' },
};
const npcGroup = new THREE.Group();
scene.add(npcGroup);
let NPCS = [];
const npcMats = {}, nmat = c => (npcMats[c] ??= new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, flatShading: true }));
const NG = {
  body: new THREE.CapsuleGeometry(0.075, 0.13, 3, 10).translate(0, 0.145, 0),
  head: new THREE.SphereGeometry(0.068, 12, 10).translate(0, 0.33, 0),
  eyes: new THREE.BoxGeometry(0.07, 0.016, 0.01).translate(0, 0.34, 0.064),
  cone: new THREE.ConeGeometry(0.075, 0.2, 10).translate(0, 0.47, 0),
  brim: new THREE.CylinderGeometry(0.12, 0.12, 0.012, 14).translate(0, 0.375, 0),
  crown: new THREE.CylinderGeometry(0.055, 0.066, 0.06, 12).translate(0, 0.405, 0),
  dome: new THREE.SphereGeometry(0.078, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.36, 0),
  peak: new THREE.BoxGeometry(0.08, 0.012, 0.06).translate(0, 0.38, 0.07),
  feather: new THREE.BoxGeometry(0.012, 0.12, 0.03).translate(0.05, 0.46, -0.02),
  bag: new THREE.BoxGeometry(0.05, 0.07, 0.05).translate(0.09, 0.13, 0),
  staff: new THREE.CylinderGeometry(0.01, 0.01, 0.5, 5).translate(0.11, 0.22, 0.03),
  hammer: new THREE.BoxGeometry(0.05, 0.03, 0.03).translate(0.1, 0.27, 0.06),
  tricorn: new THREE.ConeGeometry(0.12, 0.07, 3).translate(0, 0.405, 0),
  bell: new THREE.ConeGeometry(0.035, 0.06, 10).translate(0.11, 0.25, 0.05),
  scroll: new THREE.CylinderGeometry(0.018, 0.018, 0.12, 8).rotateZ(Math.PI / 2).translate(-0.09, 0.2, 0.06),
};
const SKIN = ['#f1c9a5', '#d9a47c', '#a8714f', '#e8b892'];
function makeNpcMesh(role, seed) {
  const g = new THREE.Group(), add = (geo, c) => { const m = new THREE.Mesh(geo, nmat(c)); m.castShadow = true; g.add(m); };
  add(NG.body, ROLES[role].body); add(NG.head, SKIN[Math.floor(seed * 4)]); add(NG.eyes, '#2a2420');
  if (role === 'elder') { add(NG.brim, '#4f3a73'); add(NG.cone, '#5d4489'); add(NG.staff, '#6b4423'); }
  if (role === 'keeper') { add(NG.brim, '#e2c27a'); add(NG.crown, '#d6b468'); }
  if (role === 'harbour') { add(NG.crown, '#1f3550'); add(NG.peak, '#1f3550'); }
  if (role === 'foreman') { add(NG.dome, '#ffd23a'); add(NG.hammer, '#7a7f86'); }
  if (role === 'messenger') { add(NG.crown, '#2f6e4c'); add(NG.feather, '#e05a4f'); add(NG.bag, '#8b5a2b'); }
  if (role === 'crier') { add(NG.tricorn, '#2a2420'); add(NG.bell, '#ffcc33'); add(NG.scroll, '#f4ead6'); }
  g.scale.setScalar(1.3);
  return g;
}
const SPEECH = { talk: markerTexture('…', '#fff8e6'), ask: markerTexture('?', '#ffd27a'), news: markerTexture('!', '#7be08f') };

function addNpc(key, role, p, extra = {}) {
  const seed = hash(key), mesh = makeNpcMesh(role, seed);
  const mark = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false }));
  mark.renderOrder = 9; mark.scale.set(0.22, 0.22, 1);
  const npc = { key, role, p, name: NAMES[Math.floor(seed * NAMES.length)], seed, mesh, mark, history: [], pos: new THREE.Vector3(), ...extra };
  npcGroup.add(mesh, mark);
  NPCS.push(npc);
  return npc;
}
function removeNpc(npc) { npcGroup.remove(npc.mesh, npc.mark); NPCS = NPCS.filter(n => n !== npc); }

function spawnStaticNpcs(model) {
  npcGroup.clear(); NPCS = [];
  const home = model.projects.find(p => p.cwd === M.home) ?? model.projects.find(p => p.hub) ?? model.projects[0];
  if (home) addNpc('crier', 'crier', home);
  for (const p of model.projects) {
    addNpc(p.cwd + ':elder', p.sessions.length >= 3 ? 'elder' : 'keeper', p);
    if (model.routes.some(r => r.a === p || r.b === p) || p.eparent || p.children.length) addNpc(p.cwd + ':harbour', 'harbour', p);
  }
}
function syncLiveNpcs() {
  const want = new Set();
  for (const s of LIVE) {
    if (s.state === 'busy' && s.building) {
      const key = s.sessionId + ':foreman'; want.add(key);
      const n = NPCS.find(n => n.key === key);
      if (n) n.s = s; else addNpc(key, 'foreman', s.project, { s });
    }
  }
  for (const p of M.projects) if (p.live.some(s => s.state === 'idle')) {
    const key = p.cwd + ':messenger'; want.add(key);
    if (!NPCS.some(n => n.key === key)) addNpc(key, 'messenger', p);
  }
  for (const n of [...NPCS]) if ((n.role === 'foreman' || n.role === 'messenger') && !want.has(n.key)) { if (dlg.npc === n) closeDialog(); removeNpc(n); }
}

const _dock = new THREE.Vector3();
function npcPlacement(n, t) {
  const p = n.p, out = new THREE.Vector3(Math.cos(p.dockAngle), 0, Math.sin(p.dockAngle));
  if (n.role === 'crier') {
    const camp = p.buildings[0], v = new THREE.Vector3(-0.85, 0, 0.5).applyAxisAngle(Y, camp.ry);
    const ring = Math.max(0, Math.sin(t * 1.3)) > 0.97 ? Math.abs(Math.sin(t * 30)) * 0.04 : 0;
    return { x: p.cx + camp.lx + v.x, y: PLATEAU + ring, z: p.cz + camp.lz + v.z, face: Math.atan2(v.x, v.z) };
  }
  if (n.role === 'elder' || n.role === 'keeper') {
    const camp = p.buildings[0];
    const v = new THREE.Vector3(0.78, 0, 0.55).applyAxisAngle(Y, camp.ry);
    return { x: p.cx + camp.lx + v.x, y: PLATEAU, z: p.cz + camp.lz + v.z, face: Math.atan2(-v.x, -v.z) + Math.sin(t * 0.4 + n.seed * 9) * 0.5 };
  }
  if (n.role === 'harbour') {
    _dock.copy(p.dockUnit).multiplyScalar(p.Rcur).addScaledVector(out, 0.3).add(new THREE.Vector3(-out.z, 0, out.x).multiplyScalar(0.12));
    return { x: p.cx + _dock.x, y: 0.16, z: p.cz + _dock.z, face: Math.atan2(out.x, out.z) + Math.sin(t * 0.3 + n.seed * 7) * 0.8 };
  }
  if (n.role === 'foreman') {
    const b = n.s.building, v = new THREE.Vector3(0, 0, 0.62).applyAxisAngle(Y, b.ry + 0.6);
    return { x: p.cx + b.lx + v.x, y: PLATEAU + Math.abs(Math.sin(t * 6 + n.seed * 9)) * 0.03, z: p.cz + b.lz + v.z, face: Math.atan2(-v.x, -v.z) };
  }
  // messenger strolls a loop through the settlement
  const r = Math.max(0.9, SLOT * Math.sqrt(p.sessions.length) * 0.75), a = n.seed * 6.283 + t * 0.25 / r;
  return { x: p.cx + Math.cos(a) * r, y: PLATEAU + Math.abs(Math.sin(t * 7)) * 0.015, z: p.cz + Math.sin(a) * r, face: Math.atan2(-Math.sin(a), Math.cos(a)) };
}

let chatter = null, chatterNext = 4;
function updateNpcs(t, dt, camDist, present) {
  npcGroup.visible = present;
  for (const n of NPCS) {
    const vis = present && n.p.group.visible && n.p.Rcur > 0.8 * radiusFor(n.p.sessions.length);
    n.mesh.visible = vis;
    if (!vis) { n.mark.visible = false; continue; }
    if (dlg.npc !== n) n.place = npcPlacement(n, t);
    const pl = n.place;
    n.pos.set(pl.x, pl.y, pl.z);
    n.mesh.position.copy(n.pos);
    if (dlg.npc === n) {
      const toCam = Math.atan2(camera.position.x - pl.x, camera.position.z - pl.z);
      n.mesh.rotation.y += (toCam - n.mesh.rotation.y) * Math.min(1, dt * 6);
      n.mesh.position.y += Math.abs(Math.sin(t * 10)) * (dlg.typing ? 0.02 : 0);
    } else n.mesh.rotation.y = pl.face;
    n.mark.visible = camDist < 45 && dlg.npc !== n;
    n.mark.material.map = SPEECH[speechKind(n)];
    n.mark.position.set(pl.x, pl.y + 0.78 + Math.sin(t * 2.5 + n.seed * 9) * 0.04, pl.z);
  }
  // ambient chatter: now and then a nearby villager mutters a line
  chatterNext -= dt;
  if (chatter && t > chatter.until) { chatter.el.remove(); chatter = null; }
  if (!chatter && chatterNext < 0 && camDist < 32 && !dlg.npc) {
    chatterNext = 5 + Math.random() * 5;
    const near = NPCS.filter(n => n.mesh.visible && toScreen(n.pos));
    if (near.length) {
      const n = near[Math.floor(Math.random() * near.length)], el = document.createElement('div');
      el.className = 'lbl bubble'; el.textContent = pick(Math.random, idleLines(n));
      labelsEl.append(el);
      chatter = { n, el, until: t + 4 };
    }
  }
  if (chatter) {
    const s = toScreen(tmpV.copy(chatter.n.pos).setY(chatter.n.pos.y + 0.75));
    chatter.el.style.display = s && labelMode !== 'off' ? '' : 'none';
    if (s) chatter.el.style.transform = `translate(${s[0]}px, ${s[1]}px) translate(-50%, -100%)`;
  }
}
function pickNpc() {
  let best = null, bestD = Infinity;
  for (const n of NPCS) {
    if (!n.mesh.visible) continue;
    tmpV.copy(n.pos).setY(n.pos.y + 0.28);
    const d = ray.ray.distanceToPoint(tmpV), along = tmpV.distanceTo(ray.ray.origin);
    if (d < 0.2 && along < bestD) { bestD = along; best = n; }
  }
  return best;
}

// --- what villagers know ---
const daysSince = t => Math.floor((Date.now() - t) / DAY);
const stageOf = n => (n < 2 ? 'campsite' : n < 4 ? 'outpost' : n < 11 ? 'village' : n < 25 ? 'town' : 'city');
const latestOf = p => [...p.buildings].sort((a, b) => b.s.end - a.s.end)[0];
const branchesOf = p => [...new Set(p.sessions.flatMap(s => Object.keys(s.branches)))];
const routesOf = p => M.routes.filter(r => r.a === p || r.b === p).map(r => ({ q: r.a === p ? r.b : r.a, r })).sort((a, b) => b.r.n - a.r.n);
const titleOf = b => b?.s.title || b?.s.firstPrompt?.slice(0, 60) || 'an untitled build';
function speechKind(n) {
  if (n.role === 'messenger' || n.role === 'crier') return 'news';
  if ((n.role === 'elder' || n.role === 'keeper') && (daysSince(n.p.end) > 14 || branchesOf(n.p).length > 1)) return 'ask';
  return 'talk';
}
function idleLines(n) {
  const p = n.p, l = latestOf(p);
  return {
    elder: [`${p.sessions.length} buildings and counting.`, `I remember when this was just a tent.`, `"${titleOf(l)}" — fine work, that.`],
    keeper: ['Quiet out here…', 'Think anyone will build here again?', 'Nice spot for a campfire.'],
    harbour: routesOf(p).length ? [`Cargo bound for ${routesOf(p)[0].q.name}!`, 'Tide looks good today.', 'Mind the buoys.'] : ['Tide looks good today.'],
    foreman: [`Running ${n.s?.tool || 'something'}…`, 'Hammer, hammer, hammer.', 'Nearly there! Probably.'],
    messenger: [`${p.live.filter(s => s.state === 'idle').length} letters for you!`, 'Someone\'s waiting on a reply…', 'Special delivery!'],
    crier: ['Hear ye, hear ye!', `${LIVE.filter(s => s.state === 'idle').length} sessions await your reply!`, ...M.projects.filter(q => weatherOf(q).kind === 'storm').map(q => `Storm warning over ${q.name}!`), 'Read all about it! (press G)'],
  }[n.role];
}

function scriptFor(n) {
  const p = n.p, l = latestOf(p), days = daysSince(p.end), br = branchesOf(p);
  const resumeChoice = (label, id) => ({ label, act: () => openTerminal(p.cwd, id) });
  const askChoice = (label, q) => ({ label, ask: q });
  const show = b => ({ label: `Show me “${titleOf(b).slice(0, 34)}”`, act: () => { flyTo(p.cx + b.lx, p.cz + b.lz, 12); showSession(b); closeDialog(); } });
  if (n.role === 'crier') {
    const busy = LIVE.filter(s => s.state === 'busy'), waiting = LIVE.filter(s => s.state === 'idle').sort((a, b) => a.updatedAt - b.updatedAt);
    const storms = M.projects.filter(q => weatherOf(q).kind === 'storm'), rainy = M.projects.filter(q => weatherOf(q).kind === 'rain');
    const prs = Object.values(HEALTH).flatMap(h => h.prs || []), crates = Object.values(HEALTH).reduce((a, h) => a + (h.dirty || 0), 0);
    const longest = waiting[0];
    let text = `Hear ye, hear ye! ${busy.length ? `${busy.length} crew${busy.length > 1 ? 's' : ''} hard at work` : 'All crews are resting'}, and ${waiting.length} session${waiting.length === 1 ? '' : 's'} await${waiting.length === 1 ? 's' : ''} your reply across ${new Set(waiting.map(s => s.project)).size} islands.`;
    text += storms.length ? ` Storm warning over ${storms.map(q => q.name).join(', ')}!` : ' Fair skies over every build.';
    if (rainy.length) text += ` Showers on ${rainy.slice(0, 3).map(q => q.name).join(', ')}.`;
    if (prs.length) text += ` ${prs.length} of your ships ride at anchor awaiting review${prs.some(x => x.checks === 'fail') ? ', some flying red flags' : ''}.`;
    if (crates) text += ` ${crates} crates of uncommitted changes sit on the docks.`;
    if (longest) text += ` Longest wait: ${longest.name}, ${ago(longest.updatedAt)}.`;
    return { text, choices: [
      askChoice('📰 Read today’s Gazette', "Read me today's Gazette."),
      ...(storms[0] ? [{ label: `Fly to the storm over ${storms[0].name}`, act: () => { closeDialog(); flyTo(storms[0].cx, storms[0].cz, Math.max(18, storms[0].R * 4)); showProject(storms[0]); } }] : []),
      ...(longest ? [{ label: `Take me to ${longest.project.name}`, act: () => { const m = NPCS.find(x => x.p === longest.project && x.role === 'messenger'); if (m) openDialog(m); else { closeDialog(); flyTo(longest.project.cx, longest.project.cz); showProject(longest.project); } } }] : []),
      askChoice('What should I do first today?', 'Looking across all the islands, what should I do first today, and why?'),
    ] };
  }
  if (n.role === 'elder') {
    const biggest = [...p.buildings].sort((a, b) => b.s.assistantTurns - a.s.assistantTurns)[0];
    let text = `Welcome to ${p.name}! We've been settled since ${fmtDate(p.start)}, and with ${p.sessions.length} buildings we're a proper ${stageOf(p.sessions.length)} now.`;
    text += days > 14 ? ` Though it's been ${days} days since anyone built here… is this island finished, or only resting?` : ` Newest is "${titleOf(l)}", raised ${ago(l.s.end)} ago.`;
    const wx = weatherOf(p);
    if (wx.kind === 'storm') text += ` Mind the storm overhead — it rolled in when ${wx.reason}.`;
    if (wx.kind === 'rain') text += ` It's been drizzly lately: ${wx.reason}.`;
    if (br.length > 1) text += ` I count ${br.length} branches about the place — ${br.slice(0, 4).join(', ')}. Any of them ready to merge?`;
    return { text, choices: [
      askChoice('Tell me this island’s story', 'Tell me the story of this island so far: how it began, how it grew, and the big moments.'),
      askChoice('What happened recently?', 'What has been happening here recently? Summarise the last few sessions.'),
      askChoice('What should I work on next?', 'Based on the records, what looks unfinished, and what would you suggest I work on next here?'),
      show(biggest),
      { label: 'Start a new session here', act: () => openTerminal(p.cwd) },
    ] };
  }
  if (n.role === 'keeper') {
    const first = p.buildings[0];
    let text = `Oh, a visitor! This little island only has ${p.sessions.length === 1 ? 'a campsite' : `${p.sessions.length} buildings`} so far.`;
    if (first.s.firstPrompt) text += ` It all began when you asked: “${first.s.firstPrompt.replace(/\s+/g, ' ').slice(0, 140)}${first.s.firstPrompt.length > 140 ? '…' : ''}”`;
    if (days > 7) text += ` Nobody's been back for ${days} days. Shall we build something?`;
    return { text, choices: [
      askChoice('What is this place for?', 'What is this project, from what you can tell? What was being attempted here?'),
      resumeChoice('Resume the last session', l.s.id),
      { label: 'Start a new session here', act: () => openTerminal(p.cwd) },
    ] };
  }
  if (n.role === 'harbour') {
    const routes = routesOf(p), bridged = [p.eparent, ...p.children].filter(Boolean);
    let text = 'Ahoy!';
    if (routes.length) {
      const top = routes[0];
      text += ` Ships sail from here to ${routes.length} island${routes.length > 1 ? 's' : ''}. Busiest run is to ${top.q.name}${top.r.kind === 'trade' ? ` — ${top.r.n} file references in the cargo logs` : ', the archipelago ferry'}.`;
    }
    if (bridged.length) text += ` And there's a bridge over to ${bridged.map(q => q.name).join(' and ')}.`;
    const hh = HEALTH[p.cwd];
    if (hh?.prs?.length) text += ` ${hh.prs.length} of your ships lie at anchor waiting for review: ${hh.prs.slice(0, 3).map(x => `#${x.number} “${x.title.slice(0, 40)}”${x.checks === 'fail' ? ' (red flag!)' : ''}`).join(', ')}.`;
    if (hh?.dirty) text += ` ${hh.dirty} crate${hh.dirty > 1 ? 's' : ''} of uncommitted changes piled on the dock${hh.dirty > 15 ? ' — it’s getting crowded' : ''}.`;
    if (hh?.ahead) text += ` A cargo boat sits loaded with ${hh.ahead} unpushed commit${hh.ahead > 1 ? 's' : ''}.`;
    if (text === 'Ahoy!') text += ' Quiet harbour today.';
    const dests = [...routes.map(r => r.q), ...bridged].slice(0, 3);
    return { text, choices: [
      ...(routes[0]?.r.kind === 'trade' ? [askChoice(`Why do we trade with ${routes[0].q.name}?`, `Why does this island share files with ${routes[0].q.name}? What gets shipped back and forth, judging by the records?`)] : []),
      ...(HEALTH[p.cwd]?.prs || []).slice(0, 2).map(x => ({ label: `Board ship #${x.number}`, act: () => window.open(x.url, '_blank') })),
      ...dests.map(q => ({ label: `Sail to ${q.name}`, act: () => { closeDialog(); flyTo(q.cx, q.cz, Math.max(18, q.R * 4)); showProject(q); } })),
    ] };
  }
  if (n.role === 'foreman') {
    const s = n.s, b = s.building;
    return { text: `Hard hats on! We're working on “${titleOf(b)}”. Last thing I saw the crew do was ${s.tool || 'think very hard'}, and we've been at it since ${ago(s.startedAt)} ago.`, choices: [
      resumeChoice('Jump into that session', s.sessionId),
      askChoice('What are we building?', `What is the session "${titleOf(b)}" working on, and how is it going so far?`),
      show(b),
    ] };
  }
  // messenger
  const waiting = p.live.filter(s => s.state === 'idle').sort((a, b) => a.updatedAt - b.updatedAt);
  const listed = waiting.slice(0, 4).map(s => {
    const b = s.building;
    return `• ${b ? `“${titleOf(b).slice(0, 48)}”` : s.name} — waiting ${ago(s.updatedAt)}${b?.s.lastPrompt ? `, last you said: “${b.s.lastPrompt.replace(/\s+/g, ' ').slice(0, 70)}…”` : ''}`;
  });
  return { text: `Message for you! ${waiting.length} session${waiting.length > 1 ? 's are' : ' is'} waiting for your reply on ${p.name}:\n${listed.join('\n')}${waiting.length > 4 ? `\n…and ${waiting.length - 4} more.` : ''}\nShall I take you to one?`, choices: [
    ...waiting.slice(0, 3).map(s => resumeChoice(`Reply to ${s.building ? titleOf(s.building).slice(0, 28) : s.name}`, s.sessionId)),
    askChoice('Which one matters most?', 'Several sessions here are waiting on me. Which one looks most important to get back to, and why?'),
  ] };
}

// --- dialogue box ---
const dlg = { npc: null, typing: false, timer: null };
const dEl = $('#dialog');
function say(text) {
  clearInterval(dlg.timer);
  const el = dEl.querySelector('.say');
  let i = 0;
  dlg.typing = true;
  dlg.full = text;
  dlg.timer = setInterval(() => {
    i += 2;
    el.textContent = text.slice(0, i);
    if (i >= text.length) { clearInterval(dlg.timer); dlg.typing = false; }
  }, 16);
}
dEl.querySelector('.say').onclick = () => { if (dlg.typing) { clearInterval(dlg.timer); dlg.typing = false; dEl.querySelector('.say').textContent = dlg.full; } };
function renderChoices(choices) {
  const box = dEl.querySelector('.choices');
  box.innerHTML = '';
  for (const c of choices) {
    const b = document.createElement('button');
    b.textContent = (c.ask ? '💬 ' : '▸ ') + c.label;
    b.onclick = () => (c.ask ? askNpc(c.label, c.ask) : c.act());
    box.append(b);
  }
}
function openDialog(n) {
  dlg.npc = n;
  const R = ROLES[n.role];
  dEl.querySelector('.portrait').textContent = R.icon;
  dEl.querySelector('.portrait').style.background = R.accent;
  const place = n.role === 'crier' ? 'the Home Isles' : n.p.name;
  dEl.querySelector('.who').innerHTML = `<b class="title">${esc(n.name)}</b> <span>${R.title} of ${esc(place)}</span>`;
  dEl.querySelector('input').placeholder = n.role === 'crier' ? `Ask ${n.name} anything about the isles…` : `Ask ${n.name} anything about ${n.p.name}…`;
  const sc = scriptFor(n);
  dlg.choices = sc.choices;
  renderChoices(sc.choices);
  dEl.style.display = 'flex';
  say(sc.text);
  flyTo(n.pos.x, n.pos.z, 7.5);
  panel.style.display = 'none';
}
function closeDialog() { dlg.npc = null; clearInterval(dlg.timer); dlg.typing = false; dEl.style.display = 'none'; }
dEl.querySelector('.dclose').onclick = closeDialog;
async function askNpc(label, question) {
  const n = dlg.npc;
  if (!n) return;
  const el = dEl.querySelector('.say'), choices = dEl.querySelector('.choices');
  clearInterval(dlg.timer);
  el.innerHTML = `<span class="you">${esc(label)}</span><span class="thinking">${esc(n.name)} is thinking</span>`;
  choices.querySelectorAll('button').forEach(b => (b.disabled = true));
  try {
    const r = await api(n.role === 'crier' ? '/api/crier' : '/api/npc', { cwd: n.p.cwd, role: n.role, name: n.name, question, history: n.history });
    if (r.error) throw new Error(r.error);
    n.history.push({ q: question, a: r.text });
    if (dlg.npc === n) say(r.text);
  } catch (e) {
    if (dlg.npc === n) say(`${n.name} scratches their head. (Couldn't reach Claude: ${e.message})`);
  }
  if (dlg.npc === n) renderChoices(dlg.choices);
}
dEl.querySelector('form').onsubmit = e => {
  e.preventDefault();
  const input = dEl.querySelector('input'), q = input.value.trim();
  if (!q) return;
  input.value = '';
  askNpc(q, q);
};

// ---------- seaplane tour ----------
// A seaplane takes off from where you're looking, swoops around a handful of islands (busy ones
// first, then ones waiting on you, the biggest, the newest, and a few quiet ones), with a caption
// card per stop. The camera chases it; any click, drag or Esc hands control back.
function makeSeaplane() {
  const g = new THREE.Group(), m = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, flatShading: true });
  const red = m('#d9483b'), cream = m('#f4ead6'), dark = m('#2f3439'), glass = m('#7fc6e8');
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); o.castShadow = true; g.add(o); return o; };
  add(new THREE.CylinderGeometry(0.16, 0.1, 1.3, 10).rotateX(Math.PI / 2), red, 0, 0, 0);          // fuselage, nose at +z
  add(new THREE.SphereGeometry(0.16, 10, 8), red, 0, 0, 0.65);
  add(new THREE.SphereGeometry(0.12, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), glass, 0, 0.1, 0.3);  // canopy
  add(new THREE.BoxGeometry(2.0, 0.04, 0.34), cream, 0, 0.17, 0.2);                                 // wing
  add(new THREE.BoxGeometry(0.7, 0.03, 0.2), cream, 0, 0.05, -0.62);                                // tailplane
  add(new THREE.BoxGeometry(0.03, 0.3, 0.22), red, 0, 0.18, -0.6);                                  // fin
  for (const s of [-1, 1]) {
    add(new THREE.CapsuleGeometry(0.06, 0.8, 3, 8).rotateX(Math.PI / 2), cream, s * 0.35, -0.42, 0.1);   // floats
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.4, 4), dark, s * 0.35, -0.2, 0.25);
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.4, 4), dark, s * 0.35, -0.2, -0.1);
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 4), dark, s * 0.55, 0.0, 0.2, 0, 0, s * 0.5);    // wing struts
  }
  const prop = new THREE.Group();
  prop.position.z = 0.82;
  for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.42, 0.015), dark); b.position.y = 0.0; b.rotation.z = i * 2.094; b.geometry.translate(0, 0.2, 0); prop.add(b); }
  g.add(prop);
  g.userData.prop = prop;
  g.scale.setScalar(0.9);
  return g;
}
const seaplane = makeSeaplane();
seaplane.visible = false;
scene.add(seaplane);

let tour = null;
const tourCard = $('#tourcard');
function tourStops() {
  const ps = M.projects.filter(p => p.sessions.length);
  const picked = [], take = (list, n) => { for (const p of list) { if (picked.length >= 99 || n <= 0) break; if (!picked.includes(p)) { picked.push(p); n--; } } };
  take(ps.filter(p => p.live.some(s => s.state === 'busy')), 3);
  take(ps.filter(p => p.live.some(s => s.state === 'idle')).sort((a, b) => b.live.length - a.live.length), 2);
  take([...ps].sort((a, b) => b.sessions.length - a.sessions.length), 2);
  take([...ps].sort((a, b) => b.start - a.start), 1);
  take([...ps].sort(() => Math.random() - 0.5).filter(p => p.sessions.length <= 3), 2);
  // fly them in a sensible order: nearest-neighbour from where the camera is looking
  const order = [], left = [...picked];
  let at = { cx: controls.target.x, cz: controls.target.z };
  while (left.length) {
    left.sort((a, b) => Math.hypot(a.cx - at.cx, a.cz - at.cz) - Math.hypot(b.cx - at.cx, b.cz - at.cz));
    at = left.shift(); order.push(at);
  }
  return order;
}
function startTour() {
  if (!M || tour) return;
  closeDialog(); closePanel();
  const stops = tourStops();
  if (!stops.length) return;
  const pts = [], marks = [];
  const alt = 3.2;
  const start = controls.target.clone();
  pts.push(start.clone().setY(0.15), start.clone().add(new THREE.Vector3(1.5, 0.8, 1.5)));    // take-off run
  let prev = start;
  for (const p of stops) {
    const r = p.R + 3.5, inA = Math.atan2(prev.z - p.cz, prev.x - p.cx);
    marks.push({ p, from: pts.length });
    for (let k = 0; k <= 4; k++) {                    // 240° sweep around the island
      const a = inA + (k / 4) * Math.PI * 1.33;
      pts.push(new THREE.Vector3(p.cx + Math.cos(a) * r, alt, p.cz + Math.sin(a) * r));
    }
    marks.at(-1).to = pts.length;
    prev = new THREE.Vector3(p.cx, 0, p.cz);
  }
  const last = stops.at(-1);
  pts.push(new THREE.Vector3(last.cx + last.R + 6, 1.2, last.cz + last.R + 6), new THREE.Vector3(last.cx + last.R + 9, 0.12, last.cz + last.R + 8));   // splash-down
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.3);
  const len = curve.getLength();
  for (const mk of marks) { mk.u0 = (mk.from - 0.5) / (pts.length - 1); mk.u1 = mk.to / (pts.length - 1); }
  tour = { curve, len, marks, d: 0, stop: null, camPos: camera.position.clone(), look: controls.target.clone(), roll: 0 };
  seaplane.visible = true;
  controls.enabled = false;
  $('#tour').classList.add('on');
}
function endTour() {
  if (!tour) return;
  const look = tour.look.clone().setY(0);
  tour = null;
  seaplane.visible = false;
  tourCard.style.display = 'none';
  controls.target.copy(look);
  controls.enabled = true;
  $('#tour').classList.remove('on');
}
function tourCaption(p) {
  const role = p.sessions.length >= 3 ? 'elder' : 'keeper';
  const n = NPCS.find(n => n.p === p && n.role === role) ?? { role, p, name: '' };
  const first = scriptFor(n).text.split(/(?<=[.!?…])\s+/).slice(0, 2).join(' ');
  const busy = p.live.filter(s => s.state === 'busy').length, idle = p.live.filter(s => s.state === 'idle').length;
  tourCard.innerHTML = `<div class="title">${esc(p.name)}</div>
    <div class="meta">${stageOf(p.sessions.length)} · ${p.sessions.length} building${p.sessions.length > 1 ? 's' : ''} · last active ${ago(p.end)} ago${busy ? ` · <span style="color:var(--amber)">${busy} working</span>` : ''}${idle ? ` · <span style="color:var(--green)">${idle} waiting</span>` : ''}</div>
    <div class="line">${n.name ? `<b>${esc(n.name)}:</b> ` : ''}“${esc(first)}”</div>`;
  tourCard.style.display = 'block';
  tourCard.style.animation = 'none'; void tourCard.offsetWidth; tourCard.style.animation = '';
}
const _tp = new THREE.Vector3(), _tt = new THREE.Vector3(), _tt2 = new THREE.Vector3(), _tc = new THREE.Vector3();
function updateTour(dt, t) {
  const tr = tour;
  const speed = tr.d < 3 ? 2.5 + tr.d * 1.5 : 6.5;
  tr.d += dt * speed;
  const u = Math.min(1, tr.d / tr.len);
  tr.curve.getPointAt(u, _tp); tr.curve.getTangentAt(u, _tt); tr.curve.getTangentAt(Math.min(1, u + 0.01), _tt2);
  _tp.y = Math.max(0.12, _tp.y);
  seaplane.position.copy(_tp);
  const yaw = Math.atan2(_tt.x, _tt.z), turn = Math.atan2(_tt.x * _tt2.z - _tt.z * _tt2.x, _tt.x * _tt2.x + _tt.z * _tt2.z);
  tr.roll += (THREE.MathUtils.clamp(-turn * 18, -0.5, 0.5) - tr.roll) * Math.min(1, dt * 2);
  seaplane.rotation.set(0, 0, 0);
  seaplane.rotateY(yaw); seaplane.rotateX(-Math.asin(THREE.MathUtils.clamp(_tt.y, -1, 1))); seaplane.rotateZ(tr.roll);
  seaplane.userData.prop.rotation.z += dt * 40;
  if (_tp.y < 0.3 && u < 0.98 && u > 0.02) {} // skimming
  if (seaplane.position.y < 0.2 && waterUniforms.uBoatCount.value < MAX_BOATS)
    waterUniforms.uBoats.value[waterUniforms.uBoatCount.value++].set(_tp.x, _tp.z, _tt.x * 1.5, _tt.z * 1.5);

  // which island are we showing?
  const mk = tr.marks.find(m => u >= m.u0 && u <= m.u1);
  if (mk && tr.stop !== mk.p) { tr.stop = mk.p; tourCaption(mk.p); }
  if (!mk && tr.stop && u > tr.marks.at(-1).u1) { tr.stop = null; tourCard.style.display = 'none'; }

  // chase camera: behind and above the plane, looking between the plane and the island it's circling
  // calm follow camera: high and behind, heading smoothed heavily, always looking at the plane itself
  const head = _tt.clone().setY(0).normalize();
  tr.fwd ??= head.clone();
  tr.fwd.lerp(head, Math.min(1, dt * 0.7)).normalize();
  tr.planeS ??= _tp.clone();
  tr.planeS.lerp(_tp, Math.min(1, dt * 4));
  tr.look.lerp(_tc.copy(tr.planeS).addScaledVector(tr.fwd, 1.5).add(new THREE.Vector3(0, -0.6, 0)), Math.min(1, dt * 3));
  const want = tr.planeS.clone().addScaledVector(tr.fwd, -7.5).add(new THREE.Vector3(0, 4.6, 0));
  want.y = Math.max(want.y, 2);
  tr.camPos.lerp(want, Math.min(1, dt * (tr.d < 6 ? 1.2 : 2.2)));
  camera.position.copy(tr.camPos);
  camera.lookAt(tr.look);
  if (u >= 1) endTour();
}

// ---------- weather & harbour life ----------
// Weather comes from repo health: failing CI = thunderstorm, failing PR checks or an error-heavy recent
// session = rain, untouched for 3+ weeks = fog. The harbour shows git state: a crate per uncommitted file,
// a cargo boat loaded with a barrel per unpushed commit, a ship at anchor per open PR (flag = checks)
// and buried treasure for stashes.
let HEALTH = {}, healthKey = '', showWeather = true;
const weatherGroup = new THREE.Group();
scene.add(weatherGroup);
let WX = [], HOT = [];

function weatherOf(p) {
  const h = HEALTH[p.cwd];
  if (h?.ci?.conclusion === 'failure') return { kind: 'storm', icon: '⛈️', reason: `CI failing on ${h.ci.branch} (${h.ci.workflow})` };
  const failingPr = h?.prs?.find(x => x.checks === 'fail');
  if (failingPr) return { kind: 'rain', icon: '🌧️', reason: `checks failing on PR #${failingPr.number}` };
  const recent = [...p.sessions].sort((a, b) => b.end - a.end).slice(0, 3).filter(s => Date.now() - s.end < 7 * DAY);
  const errs = recent.reduce((a, s) => a + (s.toolErrors || 0), 0), calls = recent.reduce((a, s) => a + Object.values(s.tools).reduce((x, y) => x + y, 0), 0);
  if (errs >= 8 && errs / Math.max(1, calls) > 0.12) return { kind: 'rain', icon: '🌧️', reason: `recent sessions hit ${errs} tool errors` };
  if (daysSince(p.end) > 21) return { kind: 'fog', icon: '🌫️', reason: `untouched for ${daysSince(p.end)} days` };
  return { kind: 'clear', icon: '☀️', reason: 'fair weather' };
}

const CLOUD_GEO = new THREE.IcosahedronGeometry(1, 1);
const fogTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.5, 'rgba(240,246,250,0.45)'); g.addColorStop(1, 'rgba(240,246,250,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();

function makeCloud(kind, R, seed) {
  const g = new THREE.Group(), r = rng(seed);
  const mat = new THREE.MeshStandardMaterial({ color: kind === 'storm' ? '#6d7680' : '#c3ccd5', roughness: 1, flatShading: true, emissive: '#c9d8ff', emissiveIntensity: 0, transparent: true, opacity: 0.92 });
  const n = 6 + Math.floor(r() * 3), s0 = Math.min(1.25, 0.4 + R * 0.09) * (kind === 'storm' ? 1.15 : 1);
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(CLOUD_GEO, mat), s = s0 * (0.6 + r() * 0.6);
    m.position.set((r() - 0.5) * s0 * 3, (r() - 0.3) * s0 * 0.5, (r() - 0.5) * s0 * 1.8);
    m.scale.set(s * 1.25, s * 0.75, s);
    m.castShadow = true;
    g.add(m);
  }
  g.userData.mat = mat;
  return g;
}
function makeRain(count, radius, height, color) {
  const pos = new Float32Array(count * 6), r = Math.random;
  for (let i = 0; i < count; i++) {
    const a = r() * 6.283, d = Math.sqrt(r()) * radius, y = r() * height;
    pos.set([Math.cos(a) * d, y, Math.sin(a) * d, Math.cos(a) * d + 0.03, y + 0.28, Math.sin(a) * d], i * 6);
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }));
  lines.frustumCulled = false;
  lines.userData = { count, radius, height };
  return lines;
}
function makeBolt() {
  const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(10 * 3), 3));
  const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#fffbe0' }));
  l.visible = false; l.frustumCulled = false;
  return l;
}
const crateMat = [new THREE.MeshStandardMaterial({ color: '#a8743f', roughness: 0.9, flatShading: true }), new THREE.MeshStandardMaterial({ color: '#6b4423', roughness: 0.9 })];
function makeCrates(n) {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const layer = Math.floor(i / 6), j = i % 6, s = 0.17;
    const x = (j % 3) * 0.19 + layer * 0.05, z = Math.floor(j / 3) * 0.19 + layer * 0.05, y = layer * s;
    const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat[0]); c.position.set(x, y + s / 2, z); c.rotation.y = (i * 0.37) % 0.3;
    const band = new THREE.Mesh(new THREE.BoxGeometry(s + 0.006, 0.03, s + 0.006), crateMat[1]); band.position.copy(c.position); band.rotation.y = c.rotation.y;
    c.castShadow = true;
    g.add(c, band);
  }
  return g;
}
function makeChest(stash) {
  const g = new THREE.Group(), wood = new THREE.MeshStandardMaterial({ color: '#7a4b27', flatShading: true }), gold = new THREE.MeshStandardMaterial({ color: '#ffcc33', emissive: '#a8740c', emissiveIntensity: 0.4, metalness: 0.6, roughness: 0.35 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.17), wood); box.position.y = 0.07;
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.26, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), wood); lid.position.set(0, 0.14, -0.02); lid.rotation.x = -0.9;
  const trim = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.025, 0.175), gold); trim.position.y = 0.1;
  g.add(box, lid, trim);
  const coins = Math.min(14, stash + 2), r = rng(stash * 0.123);
  for (let i = 0; i < coins; i++) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.008, 10), gold); c.position.set((r() - 0.5) * 0.4, 0.005 + r() * 0.02, 0.14 + r() * 0.15); c.rotation.set(r() * 0.4, r() * 6, r() * 0.4); g.add(c); }
  if (stash > 3) { const pile = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.08, 10), gold); pile.position.set(0, 0.17, 0.0); g.add(pile); }
  g.traverse(o => (o.castShadow = true));
  return g;
}
function makeCargoBoat(barrels) {
  const b = makeSailboat('#f2e3c6');
  const mat = new THREE.MeshStandardMaterial({ color: '#8a5530', flatShading: true });
  for (let i = 0; i < barrels; i++) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.1, 8), mat);
    c.position.set((i % 2 ? 0.05 : -0.05), 0.13, -0.2 + Math.floor(i / 2) * 0.1); c.castShadow = true; b.add(c);
  }
  return b;
}
const CHECK_COLOR = { pass: '#4caf50', fail: '#e05a4f', pending: '#ffbf5a' };
function makePrShip(pr) {
  const s = makeSailboat(pr.draft ? '#e8e2d4' : '#ffffff');
  const [, , , sail, flag] = s.children;
  if (pr.draft) sail.scale.set(1, 0.35, 0.6);
  flag.material.color.set(CHECK_COLOR[pr.checks] ?? '#cfd8dc');
  flag.scale.setScalar(1.8);
  s.scale.setScalar(1.6);
  return s;
}

function applyHealth(h) {
  const key = JSON.stringify(h);
  HEALTH = h;
  if (key === healthKey || !M) return;
  healthKey = key;
  weatherGroup.clear(); WX = []; HOT = [];
  const stormUniforms = [];
  for (const p of M.projects) {
    const hh = HEALTH[p.cwd], w = weatherOf(p), e = { p, w, h: hh, items: [] };
    const top = Math.max(1.2, ...p.buildings.map(b => b.h ?? 0)) + PLATEAU;
    if (w.kind === 'storm' || w.kind === 'rain') {
      e.cloud = makeCloud(w.kind, p.R, p.seed);
      e.cloudY = top + 3.6;
      e.rain = makeRain(w.kind === 'storm' ? 320 : 170, Math.min(p.R * 0.7, 4), e.cloudY - 0.3, w.kind === 'storm' ? '#c5d6ec' : '#d8e8f8');
      weatherGroup.add(e.cloud, e.rain);
      if (w.kind === 'storm') { e.bolt = makeBolt(); e.nextBolt = 1 + Math.random() * 3; weatherGroup.add(e.bolt); }
      HOT.push({ p, r: Math.min(1.6, 0.5 + p.R * 0.15), at: v => v.copy(e.cloud.position), tip: () => `<b>${w.icon} ${esc(p.name)}</b><br><span style="color:var(--dim)">${esc(w.reason)}</span>`, click: () => showProject(p) });
    }
    if (w.kind === 'fog') {
      e.fog = [];
      const r = rng(p.seed + 0.5);
      for (let i = 0; i < 9; i++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: fogTex, transparent: true, opacity: 0.5, depthWrite: false, fog: false }));
        s.userData = { a: i / 9 * 6.283 + r(), d: 0.55 + r() * 0.5, y: 0.5 + r() * 0.9, sc: 3 + r() * 3, sp: (r() - 0.5) * 0.06 };
        e.fog.push(s); weatherGroup.add(s);
      }
    }
    if (hh?.repo) {
      const out = () => new THREE.Vector3(Math.cos(p.dockAngle), 0, Math.sin(p.dockAngle));
      if (hh.dirty) {
        const crates = makeCrates(Math.min(18, hh.dirty));
        e.items.push({ obj: crates, place: (o, R) => { const a = p.dockAngle + 0.32, f = shape(a, p.seed) * 0.83 * R; o.position.set(p.cx + Math.cos(a) * f, heightAt(0.83), p.cz + Math.sin(a) * f); o.rotation.y = -p.dockAngle; } });
        HOT.push({ p, r: 0.35, at: v => v.copy(crates.position).add(new THREE.Vector3(0.2, 0.2, 0.1)), tip: () => `<b>📦 ${hh.dirty} uncommitted file${hh.dirty > 1 ? 's' : ''}</b><br><span style="color:var(--dim)">${esc(p.name)} · on ${esc(hh.branch ?? '?')}</span>`, click: () => showProject(p) });
      }
      if (hh.ahead) {
        const boat = makeCargoBoat(Math.min(6, hh.ahead));
        e.items.push({ obj: boat, bob: true, place: (o, R) => { const ou = out(), tip = p.dockUnit.clone().multiplyScalar(R).addScaledVector(ou, 1.15).add(new THREE.Vector3(ou.z, 0, -ou.x).multiplyScalar(0.5)); o.position.set(p.cx + tip.x, 0.02, p.cz + tip.z); o.userData.yaw = -p.dockAngle; } });
        HOT.push({ p, r: 0.45, at: v => v.copy(boat.position).setY(0.3), tip: () => `<b>🛶 ${hh.ahead} unpushed commit${hh.ahead > 1 ? 's' : ''}</b><br><span style="color:var(--dim)">cargo waiting to sail from ${esc(hh.branch ?? '?')}</span>`, click: () => showProject(p) });
      }
      (hh.prs || []).slice(0, 5).forEach((pr, k, all) => {
        const ship = makePrShip(pr);
        const a = p.dockAngle + (k - (all.length - 1) / 2) * 0.5;
        e.items.push({ obj: ship, bob: true, place: (o, R) => { const d = R * shape(a, p.seed) * 1.3 + 1.6; o.position.set(p.cx + Math.cos(a) * d, 0.02, p.cz + Math.sin(a) * d); o.userData.yaw = -a + Math.PI / 2 + 0.4; } });
        HOT.push({ p, r: 0.7, at: v => v.copy(ship.position).setY(0.6), tip: () => `<b>⛵ PR #${pr.number}${pr.draft ? ' (draft)' : ''}</b> ${esc(pr.title)}<br><span style="color:var(--dim)">${esc(pr.branch)} · checks ${pr.checks ?? 'none'} · click to open on GitHub</span>`, click: () => window.open(pr.url, '_blank') });
      });
      if (hh.stash) {
        const chest = makeChest(hh.stash);
        e.items.push({ obj: chest, place: (o, R) => { const a = p.dockAngle + Math.PI * 0.75, f = shape(a, p.seed) * 0.84 * R; o.position.set(p.cx + Math.cos(a) * f, heightAt(0.84), p.cz + Math.sin(a) * f); o.rotation.y = -a - Math.PI / 2; } });
        HOT.push({ p, r: 0.3, at: v => v.copy(chest.position).setY(chest.position.y + 0.12), tip: () => `<b>💰 ${hh.stash} stash${hh.stash > 1 ? 'es' : ''} buried here</b><br><span style="color:var(--dim)">${esc(p.name)} · git stash list</span>`, click: () => showProject(p) });
      }
      for (const it of e.items) weatherGroup.add(it.obj);
      if ((hh.prs?.length || hh.dirty || hh.ahead) && !NPCS.some(n => n.p === p && n.role === 'harbour')) addNpc(p.cwd + ':harbour', 'harbour', p);
    }
    WX.push(e);
  }
  if (panel.style.display === 'block' && currentProject) showProject(currentProject);
  updateLabelCounts();
}

const _wv = new THREE.Vector3();
function updateWeather(t, dt, present) {
  weatherGroup.visible = present;
  let si = 0;
  for (const e of WX) {
    const p = e.p, vis = p.group.visible, R = p.Rcur;
    const wvis = vis && showWeather;
    if (e.cloud) {
      e.cloud.visible = e.rain.visible = wvis;
      e.cloud.position.set(p.cx + Math.sin(t * 0.15 + p.seed * 9) * 0.6, e.cloudY + Math.sin(t * 0.5 + p.seed) * 0.12, p.cz + Math.cos(t * 0.12 + p.seed * 5) * 0.4);
      e.rain.position.set(e.cloud.position.x, 0, e.cloud.position.z);
      if (wvis) {
        const pos = e.rain.geometry.attributes.position.array, { count, radius, height } = e.rain.userData, fall = dt * (e.w.kind === 'storm' ? 11 : 8);
        for (let i = 0; i < count; i++) {
          const o = i * 6;
          pos[o + 1] -= fall; pos[o + 4] -= fall;
          if (pos[o + 1] < 0) { const a = Math.random() * 6.283, d = Math.sqrt(Math.random()) * radius; pos[o] = Math.cos(a) * d; pos[o + 2] = Math.sin(a) * d; pos[o + 3] = pos[o] + 0.03; pos[o + 5] = pos[o + 2]; pos[o + 1] = height; pos[o + 4] = height + 0.28; }
        }
        e.rain.geometry.attributes.position.needsUpdate = true;
      }
      if (e.bolt && wvis) {
        e.nextBolt -= dt;
        const m = e.cloud.userData.mat;
        m.emissiveIntensity = Math.max(0, m.emissiveIntensity - dt * 8);
        if (e.bolt.visible && t > e.boltUntil) e.bolt.visible = false;
        if (e.nextBolt < 0) {
          e.nextBolt = 2.5 + Math.random() * 5;
          const a = Math.random() * 6.283, d = Math.random() * R * 0.5;
          const x0 = e.cloud.position.x, y0 = e.cloudY - 0.4, z0 = e.cloud.position.z, x1 = p.cx + Math.cos(a) * d, z1 = p.cz + Math.sin(a) * d;
          const arr = e.bolt.geometry.attributes.position.array;
          for (let i = 0; i < 10; i++) { const u = i / 9; arr.set([x0 + (x1 - x0) * u + (i && i < 9 ? (Math.random() - 0.5) * 0.5 : 0), y0 + (PLATEAU - y0) * u, z0 + (z1 - z0) * u + (i && i < 9 ? (Math.random() - 0.5) * 0.5 : 0)], i * 3); }
          e.bolt.geometry.attributes.position.needsUpdate = true;
          e.bolt.visible = true; e.boltUntil = t + 0.14; m.emissiveIntensity = 3;
        }
      }
      if (wvis && si < 8) waterUniforms.uStorm.value[si++].set(p.cx, p.cz, R * 1.6, e.w.kind === 'storm' ? 1 : 0.55);
    }
    if (e.fog) for (const s of e.fog) {
      s.visible = wvis;
      const u = s.userData; u.a += u.sp * dt;
      s.position.set(p.cx + Math.cos(u.a) * R * u.d, u.y + Math.sin(t * 0.3 + u.a) * 0.1, p.cz + Math.sin(u.a) * R * u.d);
      s.scale.set(u.sc * Math.max(0.6, R / 4), u.sc * 0.45 * Math.max(0.6, R / 4), 1);
    }
    for (const it of e.items) {
      it.obj.visible = vis;
      it.place(it.obj, R);
      if (it.bob) { it.obj.position.y = 0.02 + Math.sin(t * 1.5 + it.obj.position.x) * 0.03; it.obj.rotation.set(Math.sin(t * 1.2 + it.obj.position.z) * 0.05, it.obj.userData.yaw ?? 0, Math.sin(t * 1.1 + it.obj.position.x) * 0.06); }
    }
  }
  waterUniforms.uStormCount.value = si;
}
function pickHot() {
  let best = null, bestD = Infinity;
  for (const h of HOT) {
    if (!h.p.group.visible || !weatherGroup.visible) continue;
    h.at(_wv);
    const d = ray.ray.distanceToPoint(_wv), along = _wv.distanceTo(ray.ray.origin);
    if (d < h.r && along < bestD) { bestD = along; best = h; }
  }
  return best;
}
async function pollHealth() { if (!M?.projects.length) return; try { applyHealth(await api('/api/health')); } catch {} }

// ---------- camera moves ----------
let fly = null;
function flyTo(x, z, dist) {
  const off = camera.position.clone().sub(controls.target);
  const d1 = dist ?? Math.min(off.length(), 26);
  fly = { from: controls.target.clone(), to: new THREE.Vector3(x, 0, z), d0: off.length(), d1, dir: off.normalize(), t: 0 };
}

// ---------- panels ----------
const panel = $('#panel'), pbody = $('#pbody');
function closePanel() { panel.style.display = 'none'; selRing.visible = false; currentProject = null; }
$('#close').onclick = closePanel;
async function openTerminal(cwd, sessionId, agent) {
  const r = await api('/api/open', { cwd, sessionId, agent });
  if (r.error) alert(r.error);
  else if (r.manual) { try { await navigator.clipboard.writeText(r.cmd); alert(`Copied to clipboard, paste it into a terminal:\n\n${r.cmd}`); } catch { prompt('Run this in a terminal:', r.cmd); } }
}
const resumeCmd = (cwd, id, agent) => `cd '${cwd.replace(/'/g, `'\\''`)}' && ${agent === 'codex' ? `codex${id ? ` resume ${id}` : ''}` : `claude${id ? ` --resume ${id}` : ''}`}`;
const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' };
function toolBar(tools) {
  const cats = {};
  for (const [t, n] of Object.entries(tools)) { const c = CATEGORY[t] ?? (t.startsWith('mcp__codegraph') ? 'read' : 'talk'); cats[c] = (cats[c] || 0) + n; }
  const segs = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  if (!segs.length) return '<div style="color:var(--dim)">No tool calls</div>';
  return `<div class="bar">${segs.map(([c, n]) => `<div style="flex:${n};background:${STYLE[c].swatch}"></div>`).join('')}</div>
    <div class="legend">${segs.map(([c, n]) => `<span><i style="background:${STYLE[c].swatch}"></i>${STYLE[c].label} ${n}</span>`).join('')}</div>`;
}
function showSession(b) {
  ringAt(selRing, b);
  const s = b.s, live = b.p.live.find(l => l.sessionId === s.id);
  const top = Object.entries(s.tools).sort((a, c) => c[1] - a[1]).slice(0, 6).map(([t, n]) => `${t} ${n}`).join(', ');
  pbody.innerHTML = `
    <h2 class="title">${esc(s.title || 'Untitled session')}</h2>
    <div class="sub"><a href="#" data-proj>${esc(b.p.name)}</a> · ${STYLE[b.cat].label}${s.source === 'codex' ? ' · Codex' : ''}</div>
    ${live ? `<div class="row" style="padding-left:0"><span class="dot" style="background:${STATUS_COLOR[live.state]}"></span>Live: ${live.state === 'idle' ? 'waiting on you' : live.state}${live.tool ? ` · last tool ${esc(live.tool)}` : ''} · ${live.pid ? `pid ${live.pid}` : AGENT_NAME[live.source]}</div>` : ''}
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
    <h4 class="title">Activity</h4>${toolBar(s.tools)}
    <div style="color:var(--dim);font-size:11px;margin-top:4px">${esc(top)}</div>
    <div class="actions"><button data-open>Resume in ${s.source === 'codex' ? 'Codex' : 'Terminal'}</button><button data-copy>Copy command</button></div>
    <div class="mono" style="color:var(--dim);word-break:break-all">${esc(s.id)}</div>`;
  pbody.querySelector('[data-open]').onclick = () => openTerminal(b.p.cwd, s.id, s.source);
  pbody.querySelector('[data-copy]').onclick = () => navigator.clipboard.writeText(resumeCmd(b.p.cwd, s.id, s.source));
  pbody.querySelector('[data-proj]').onclick = e => { e.preventDefault(); showProject(b.p); };
  panel.style.display = 'block';
}
let currentProject = null;
function harbourHtml(p) {
  const h = HEALTH[p.cwd], w = weatherOf(p);
  if (!h) return `<h4 class="title">Harbour & weather</h4><div style="color:var(--dim)">${w.icon} ${esc(w.reason)} · checking the harbour…</div>`;
  if (!h.repo) return `<h4 class="title">Harbour & weather</h4><div style="color:var(--dim)">${w.icon} ${esc(w.reason)} · not a git repo</div>`;
  return `<h4 class="title">Harbour & weather</h4><div class="kv">
    <span>Weather</span><span>${w.icon} ${esc(w.reason)}</span>
    <span>Branch</span><span>${esc(h.branch ?? '—')}${h.behind ? ` · ${h.behind} behind` : ''}</span>
    <span>📦 Crates</span><span>${h.dirty} uncommitted file${h.dirty === 1 ? '' : 's'}${h.untracked ? ` (${h.untracked} new)` : ''}</span>
    <span>🛶 Cargo</span><span>${h.ahead} unpushed commit${h.ahead === 1 ? '' : 's'}${h.upstream ? '' : ' · no upstream'}</span>
    ${h.stash ? `<span>💰 Treasure</span><span>${h.stash} stash${h.stash > 1 ? 'es' : ''}</span>` : ''}
    ${h.lastCommit ? `<span>Last commit</span><span>${ago(h.lastCommit.at)} ago · ${esc(h.lastCommit.subject.slice(0, 60))}</span>` : ''}
    ${h.ci ? `<span>CI</span><span><a href="${esc(h.ci.url)}" target="_blank">${esc(h.ci.workflow)}: ${esc(h.ci.conclusion || h.ci.status)}</a> · ${ago(h.ci.at)} ago</span>` : ''}
  </div>${(h.prs || []).map(pr => `<div class="row" onclick="window.open('${esc(pr.url)}','_blank')"><span class="dot" style="background:${CHECK_COLOR[pr.checks] ?? '#cfd8dc'}"></span><span class="nm">⛵ #${pr.number} ${esc(pr.title)}</span><span class="meta">${pr.draft ? 'draft · ' : ''}${pr.checks ?? 'no checks'}</span></div>`).join('')}`;
}
function showProject(p) {
  currentProject = p;
  selRing.visible = false;
  const cost = p.sessions.reduce((a, s) => a + s.costUSD, 0), allTools = {};
  for (const s of p.sessions) for (const [t, n] of Object.entries(s.tools)) allTools[t] = (allTools[t] || 0) + n;
  const routes = M.routes.filter(r => r.a === p || r.b === p).map(r => ({ q: r.a === p ? r.b : r.a, r })).sort((a, b) => b.r.n - a.r.n);
  const branches = new Set(p.sessions.flatMap(s => Object.keys(s.branches)));
  const codexN = p.sessions.filter(s => s.source === 'codex').length;
  const stage = p.sessions.length < 2 ? 'Campsite' : p.sessions.length < 4 ? 'Outpost' : p.sessions.length < 11 ? 'Village' : p.sessions.length < 25 ? 'Town' : 'City';
  pbody.innerHTML = `
    <h2 class="title">${esc(p.name)}</h2>
    <div class="sub mono">${esc(p.cwd)}</div>
    <div class="kv">
      <span>Settlement</span><span>${stage}${p.region.name ? ` · ${esc(p.region.name)}` : ''}</span>
      <span>Founded</span><span>${fmtDate(p.start)}</span>
      <span>Last active</span><span>${ago(p.end)} ago</span>
      <span>Sessions</span><span>${p.sessions.length}${codexN ? ` · ${codexN === p.sessions.length ? 'all' : codexN} Codex` : ''}</span>
      <span>Cost</span><span>$${cost.toFixed(2)}</span>
      <span>Branches</span><span>${esc([...branches].join(', ') || '—')}</span>
    </div>
    <div class="actions"><button data-new>New session in Terminal</button><button data-copy>Copy cd command</button></div>
    ${harbourHtml(p)}
    ${p.live.length ? `<h4 class="title">Live sessions</h4>${p.live.map(s => `<div class="row" data-sid="${s.sessionId}"><span class="dot" style="background:${STATUS_COLOR[s.state]}"></span><span class="nm">${esc(s.name)}</span><span class="meta">${s.state === 'idle' ? 'waiting' : s.state}${s.tool && s.state === 'busy' ? ' · ' + esc(s.tool) : ''} · ${ago(s.updatedAt)}</span></div>`).join('')}` : ''}
    <h4 class="title">Activity</h4>${toolBar(allTools)}
    ${p.eparent || p.children.length ? `<h4 class="title">Bridges</h4>${[p.eparent, ...p.children].filter(Boolean).map(q => `<div class="row" data-cwd="${esc(q.cwd)}"><span class="nm">${q === p.eparent ? '↑ ' : '↳ '}${esc(q.name)}</span><span class="meta">${q.sessions.length} sessions</span></div>`).join('')}` : ''}
    ${routes.length ? `<h4 class="title">Sea routes</h4>${routes.map(({ q, r }) => `<div class="row" data-cwd="${esc(q.cwd)}"><span class="nm">${r.kind === 'trade' ? '⛵' : '🚣'} ${esc(q.name)}</span><span class="meta">${r.kind === 'trade' ? `${r.n} file refs` : 'ferry'}</span></div>`).join('')}` : ''}
    <h4 class="title">Buildings</h4>
    ${[...p.buildings].sort((a, b) => b.s.end - a.s.end).map(b => `<div class="row" data-bid="${b.s.id}"><span class="dot" style="background:${STYLE[b.cat].swatch}"></span><span class="nm">${esc(b.s.title || b.s.firstPrompt?.slice(0, 50) || 'Untitled')}</span><span class="meta">${b.s.source === 'codex' ? 'Codex · ' : ''}${ago(b.s.end)}</span></div>`).join('')}`;
  pbody.querySelector('[data-new]').onclick = () => openTerminal(p.cwd);
  pbody.querySelector('[data-copy]').onclick = () => navigator.clipboard.writeText(resumeCmd(p.cwd));
  pbody.querySelectorAll('[data-cwd]').forEach(el => (el.onclick = () => { const q = M.byCwd.get(el.dataset.cwd); flyTo(q.cx, q.cz); showProject(q); }));
  pbody.querySelectorAll('[data-bid]').forEach(el => (el.onclick = () => { const b = p.buildings.find(b => b.s.id === el.dataset.bid); flyTo(p.cx + b.lx, p.cz + b.lz, 14); showSession(b); }));
  pbody.querySelectorAll('[data-sid]').forEach(el => (el.onclick = () => { const b = p.buildings.find(b => b.s.id === el.dataset.sid); if (b) showSession(b); }));
  panel.style.display = 'block';
}
function renderRoster() {
  const groups = [['busy', 'Working'], ['idle', 'Waiting on you'], ['shell', 'Shells']];
  $('#roster').innerHTML = groups.map(([st, title]) => {
    const list = LIVE.filter(s => s.state === st).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!list.length) return '';
    return `<h3 class="title">${title} · ${list.length}</h3>` + list.map(s => `
      <div class="row" data-live="${s.sessionId}"><span class="dot" style="background:${STATUS_COLOR[st]}"></span>
      <span class="nm">${esc(s.name)}</span><span class="meta">${st === 'busy' && s.tool ? esc(s.tool) + ' · ' : ''}${ago(s.updatedAt)}</span></div>`).join('');
  }).join('') || '<div style="color:var(--dim)">No live sessions</div>';
  $('#roster').querySelectorAll('[data-live]').forEach(el => (el.onclick = () => {
    const s = LIVE.find(s => s.sessionId === el.dataset.live), b = s.building;
    flyTo(s.project.cx + (b?.lx ?? 0), s.project.cz + (b?.lz ?? 0), 16);
    b ? showSession(b) : showProject(s.project);
  }));
}
function renderStats() {
  const busy = LIVE.filter(s => s.state === 'busy').length, idle = LIVE.filter(s => s.state === 'idle').length;
  const cities = M.projects.filter(p => p.sessions.length >= 11).length;
  $('#stats').innerHTML = `<span><b>${M.projects.length}</b> islands</span><span><b>${cities}</b> towns</span><span><b>${M.buildings.length}</b> buildings</span>
    <span><b style="color:var(--amber)">${busy}</b> working</span><span><b style="color:var(--green)">${idle}</b> waiting</span>`;
}

// ---------- toolbar / timeline ----------
let nightTarget = 0, playing = false;
const toggle = (id, on) => $(id).classList.toggle('on', on);
$('#tour').onclick = () => (tour ? endTour() : startTour());
$('#gazette').onclick = () => { const c = NPCS.find(n => n.role === 'crier'); if (c) { if (tour) endTour(); openDialog(c); } };
$('#weather').onclick = () => { showWeather = !showWeather; toggle('#weather', showWeather); };
$('#night').onclick = () => { nightTarget = nightTarget ? 0 : 1; toggle('#night', !!nightTarget); };
function setLabelMode(m) {
  labelMode = m;
  $('#lbls').textContent = `Labels: ${{ all: 'All', hover: 'Hover', off: 'Off' }[m]}`;
  toggle('#lbls', m !== 'off');
  try { localStorage.setItem('isles.labels', m); } catch {}
}
setLabelMode(labelMode);
$('#lbls').onclick = () => setLabelMode(LABEL_MODES[(LABEL_MODES.indexOf(labelMode) + 1) % 3]);
$('#search').onchange = e => {
  const p = M.projects.find(p => p.name === e.target.value || p.cwd === e.target.value);
  if (p) { flyTo(p.cx, p.cz, Math.max(18, p.R * 4)); showProject(p); e.target.value = ''; e.target.blur(); }
};
const time = $('#time');
function setTime(v) {
  U.time.value = v; time.value = v;
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
  if (k === 'n') $('#night').click(); else if (k === 'l') $('#lbls').click();
  else if (k === 't') tour ? endTour() : startTour();
  else if (k === 'g') $('#gazette').click();
  else if (k === 'w') $('#weather').click();
  else if (k === 'escape') { if (tour) endTour(); else if (dlg.npc) closeDialog(); else closePanel(); }
  else if (k === ' ') { e.preventDefault(); $('#play').click(); }
});

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  smoke.material.uniforms.uScale.value = innerHeight * renderer.getPixelRatio() / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}
addEventListener('resize', resize);

// ---------- loading ----------
async function loadWorld(fresh) {
  lastCityLoad = Date.now();
  let data;
  try { data = await api('/api/city' + (fresh ? '?fresh' : '')); }
  catch { $('#err').style.display = 'grid'; return; }
  for (const el of ['#empty', '#stats', '#roster']) $(el).style.visibility = '';
  $('#empty').style.display = data.projects.length ? 'none' : 'grid';
  if (!data.projects.length) for (const el of ['#stats', '#roster']) $(el).style.visibility = 'hidden';
  if (HOUSES && !HM) await loadHouses().catch(e => console.warn('house models unavailable, using classic', e));
  const first = !M;
  const prevR = new Map(M ? M.projects.map(p => [p.cwd, p.Rcur]) : []);
  M = buildModel(data);
  M.home = data.home;
  const maxDay = M.toDay(Date.now()) + 0.5;
  time.max = maxDay;
  U.grow.value = Math.max(0.3, maxDay / 90);
  buildWorld(M);
  const span = 2 * (M.worldR + 25);
  waterUniforms.uWorldMin.value.set(-span / 2, -span / 2); waterUniforms.uWorldSize.value.set(span, span); sdfKey = '';
  for (const p of M.projects) p.Rcur = prevR.get(p.cwd) ?? 0;
  if (first || !playing) setTime(maxDay);
  $('#projlist').innerHTML = M.projects.map(p => `<option value="${esc(p.name)}">`).join('');
  if (first) {
    const d = Math.min(220, Math.max(40, M.worldR * 1.9));
    controls.target.set(0, 0, 0);
    camera.position.set(d * 0.55, d * 0.68, d * 0.55);
  }
  await pollLive();
  healthKey = '';
  await pollHealth();
  if (first) DEMO?.onReady?.({ M, camera, controls, renderer, flyTo });
}

// ---------- frame loop ----------
const clock = new THREE.Clock(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), tan = new THREE.Vector3();
const bornCount = (p, tv) => { let n = 0; for (const d of p.bornDays) if (d <= tv) n++; return n; };
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
  U.clock.value = t;
  if (!M) return;

  if (playing) {
    const v = U.time.value + dt * (+time.max / 25);
    if (v >= +time.max) { playing = false; $('#play').textContent = '▶'; }
    setTime(Math.min(v, +time.max));
  }
  const tv = U.time.value, present = tv >= +time.max - 0.01;

  // islands swell as sessions accumulate
  let ii = 0;
  for (const p of M.projects) {
    const n = bornCount(p, tv), target = n ? radiusFor(n) : 0;
    p.Rcur += (target - p.Rcur) * Math.min(1, dt * 4);
    if (Math.abs(target - p.Rcur) < 0.002) p.Rcur = target;
    p.group.visible = p.Rcur > 0.02;
    p.terrain.scale.set(p.Rcur, Math.min(1, p.Rcur / 1.5), p.Rcur);
    p.uR.value = p.Rcur;
    if (ii < MAX_ISL) waterUniforms.uIsl.value[ii++].set(p.cx, p.cz, p.Rcur, p.seed);
    // moored rowboat bobbing at the dock tip
    const dockTip = p.dockUnit.clone().multiplyScalar(p.Rcur);
    const out = new THREE.Vector3(Math.cos(p.dockAngle), 0, Math.sin(p.dockAngle));
    p.rowboat.visible = n >= 2;
    p.rowboat.position.copy(dockTip).addScaledVector(out, 1.1).add(new THREE.Vector3(-out.z, 0, out.x).multiplyScalar(0.45));
    p.rowboat.position.y = 0.03 + Math.sin(t * 1.6 + p.seed * 10) * 0.025;
    p.rowboat.rotation.set(Math.sin(t * 1.3 + p.seed * 7) * 0.06, -p.dockAngle, Math.sin(t * 1.1 + p.seed) * 0.05);
  }
  waterUniforms.uCount.value = ii;
  bakeShoreField();

  // boats along sea routes (they pause at each end, as if loading cargo)
  let bi = 0;
  for (const r of M.routes) {
    const vis = tv >= r.showAfter;
    r.lane.visible = vis;
    if (vis) for (const b of r.lane.children) if (b.userData.lamp) {
      b.position.y = Math.sin(t * 1.8 + b.userData.phase * 9) * 0.03;
      b.rotation.z = Math.sin(t * 1.4 + b.userData.phase * 5) * 0.12;
      b.userData.lamp.material.emissiveIntensity = U.night.value * (2 + Math.sin(t * 3 + b.userData.phase * 9));
    }
    for (const b of r.boats) {
      b.mesh.visible = vis;
      if (!vis) continue;
      const cyc = (t * b.speed * 0.5 + b.phase) % 2, leg = cyc < 1 ? cyc : 2 - cyc;
      const u = THREE.MathUtils.smootherstep(Math.min(1, Math.max(0, (leg - 0.08) / 0.84)), 0, 1);
      r.curve.getPointAt(u, pos); r.curve.getTangentAt(u, tan);
      if (cyc >= 1) tan.negate();
      const moving = leg > 0.1 && leg < 0.9;
      b.mesh.position.set(pos.x, 0.02 + Math.sin(t * 2 + b.phase * 9) * 0.03, pos.z);
      b.mesh.rotation.set(Math.sin(t * 1.7 + b.phase * 5) * 0.07, Math.atan2(tan.x, tan.z), Math.sin(t * 1.3 + b.phase) * 0.05);
      if (bi < MAX_BOATS) waterUniforms.uBoats.value[bi++].set(pos.x, pos.z, moving ? tan.x * 0.8 : 0, moving ? tan.z * 0.8 : 0);
    }
  }
  waterUniforms.uBoatCount.value = bi;

  // day / night
  U.night.value += (nightTarget - U.night.value) * Math.min(1, dt * 2.5);
  const n = U.night.value;
  scene.background.copy(DAY_FOG).lerp(NIGHT_FOG, n);
  scene.fog.color.copy(scene.background);
  waterUniforms.uFogColor.value.copy(scene.background).convertLinearToSRGB();
  hemi.intensity = 1.15 - 0.95 * n;
  sun.intensity = 3.0 - 2.6 * n;
  sun.color.set('#fff0d0').lerp(new THREE.Color('#7f9cff'), n);
  bloom.strength = 0.3 + n * 0.7;

  // camera: fly-to, then keep the shadow frustum hugging the view
  if (tour) updateTour(dt, t);
  else if (fly) {
    fly.t = Math.min(1, fly.t + dt * 1.4);
    const e = fly.t * fly.t * (3 - 2 * fly.t);
    controls.target.lerpVectors(fly.from, fly.to, e);
    camera.position.copy(controls.target).addScaledVector(fly.dir, fly.d0 + (fly.d1 - fly.d0) * e);
    if (fly.t >= 1) fly = null;
  }
  if (!tour) controls.update();
  const camDist = tour ? camera.position.distanceTo(tour.look) : camera.position.distanceTo(controls.target);
  scene.fog.near = camDist * 1.1; scene.fog.far = camDist * 3.2;
  waterUniforms.uFogNear.value = scene.fog.near; waterUniforms.uFogFar.value = scene.fog.far;
  const ext = THREE.MathUtils.clamp(camDist * 0.75, 8, 110);
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).addScaledVector(SUN_DIR, 120);
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 300 });
  sun.shadow.camera.updateProjectionMatrix();

  // live layer
  liveGroup.visible = present;
  LIVE.slice(0, 256).forEach((s, i) => {
    const p = s.project;
    let x, z, y = PLATEAU, hop = 0;
    if (s.state === 'busy' && s.building) {      // hammering beside their building
      const a = s.phase * 6.283 + Math.sin(t * 0.7 + i) * 0.4;
      x = p.cx + s.building.lx + Math.cos(a) * 0.55; z = p.cz + s.building.lz + Math.sin(a) * 0.55;
      hop = Math.abs(Math.sin(t * 9 + i)) * 0.06;
    } else if (s.state === 'busy') {             // wandering the plateau
      const a = s.phase * 6.283 + t * 0.4;
      x = p.cx + Math.cos(a) * p.Rcur * 0.45; z = p.cz + Math.sin(a) * p.Rcur * 0.45;
      hop = Math.abs(Math.sin(t * 8 + i)) * 0.04;
    } else {                                      // waiting at the end of the dock
      const k = p.live.indexOf(s), tip = p.dockUnit.clone().multiplyScalar(p.Rcur);
      const out = new THREE.Vector3(Math.cos(p.dockAngle), 0, Math.sin(p.dockAngle));
      tip.addScaledVector(out, 0.2 + (k % 8) * 0.17);
      x = p.cx + tip.x + (k % 2 ? 0.1 : -0.1); z = p.cz + tip.z; y = 0.14;
      hop = s.state === 'idle' ? Math.max(0, Math.sin(t * 3 + i)) * 0.03 : 0;
    }
    if (s.state === 'busy' && s.building) m4.makeScale(0, 0, 0);   // the foreman villager stands in
    else m4.makeTranslation(x, y + hop, z);
    villagers.setMatrixAt(i, m4);
  });
  villagers.instanceMatrix.needsUpdate = true;
  for (const mk of markers.values()) {
    const { p, base, st } = mk.userData;
    mk.visible = !tour && camera.position.distanceTo(mk.position) > 10;
    mk.position.set(p.cx, base + Math.sin(t * 2.2 + p.seed * 9) * 0.12, p.cz);
    const s = (st === 'busy' ? 0.75 : 0.85) * (1 + Math.sin(t * 4) * (st === 'idle' ? 0.06 : 0));
    mk.scale.set(s, s, 1);
  }

  // smoke from campfires (always) and from chimneys of working sessions
  if (Math.random() < dt * 60) for (const p of M.projects) {
    if (!p.group.visible) continue;
    const camp = p.buildings[0];
    if (camp?.smoke && Math.random() < 0.08) emitSmoke(p.cx + camp.smoke.x, camp.smoke.y + 0.25, p.cz + camp.smoke.z, 0.1);
  }
  if (present) for (const s of LIVE) if (s.state === 'busy' && s.building?.smoke && Math.random() < dt * 14) {
    const b = s.building; emitSmoke(s.project.cx + b.smoke.x, b.smoke.y, s.project.cz + b.smoke.z, 0.5);
  }
  for (let i = 0; i < SMOKE_N; i++) if (smokeLife[i] < 1) {
    smokeLife[i] = Math.min(1, smokeLife[i] + dt * 0.35);
    smokePos[i * 3] += dt * 0.12; smokePos[i * 3 + 1] += dt * 0.45; smokePos[i * 3 + 2] += dt * 0.05;
  }
  smokeGeo.attributes.position.needsUpdate = true; smokeGeo.attributes.aLife.needsUpdate = true; smokeGeo.attributes.aShade.needsUpdate = true;

  updateNpcs(t, dt, camDist, present);
  updateWeather(t, dt, present);
  placeLabels(camDist);
  composer.render();
}

window.__isles = { get M() { return M; }, get NPCS() { return NPCS; }, get touring() { return !!tour; }, openDialog, closeDialog, startTour, endTour, flyTo,
  dbg: () => ({ plane: seaplane.position.toArray().map(v => +v.toFixed(2)), vis: seaplane.visible, look: tour?.look.toArray().map(v => +v.toFixed(2)), ndc: seaplane.position.clone().project(camera).toArray().map(v => +v.toFixed(2)), parent: seaplane.parent?.type, cam: camera.position.toArray().map(v => +v.toFixed(2)), d: tour?.d, len: tour?.len }) };

resize();
frame();
loadWorld();
setInterval(pollLive, 3000);
setInterval(pollHealth, 30_000);
setInterval(() => !playing && loadWorld(), 5 * 60_000);
setInterval(() => M && !M.projects.length && loadWorld(true), 30_000);   // empty sea: look for a first island
