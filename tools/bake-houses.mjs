// Bakes the v2 house GLBs from tools/blender/build_houses.py into islands/public/models/houses.json.
// Pure Node (the GLBs have no textures): per model `pos` (shared vertices, 4 decimals), `idx` and a per-vertex
// `role` index into `roles`; `colors` holds each role's default colour (from the GLB materials) and `meta` the
// storey heights and smoke points. Normals are left out: the islands material is flat shaded, so runtime
// recomputes face normals from the triangles, which keeps the file about a third of the size.
// It also lints every model, and the stacked combinations, for duplicate and coplanar-overlapping faces (z-fighting).
//   node tools/bake-houses.mjs
import fs from 'node:fs';

const SRC = new URL('./blender/out/', import.meta.url);
const meta = JSON.parse(fs.readFileSync(new URL('meta.json', SRC)));
const roles = Object.keys(meta.roles);
const colors = {};
const lin2srgb = c => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
const hex = rgb => '#' + rgb.map(c => lin2srgb(c).toString(16).padStart(2, '0')).join('');

function readGlb(file) {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12), json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
  const bin = buf.subarray(20 + jsonLen + 8);
  const acc = i => {
    const a = json.accessors[i], v = json.bufferViews[a.bufferView], n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
    const T = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
    const off = bin.byteOffset + (v.byteOffset || 0) + (a.byteOffset || 0);
    return new T(bin.buffer.slice(off, off + a.count * n * T.BYTES_PER_ELEMENT));
  };
  const tris = [];   // [[x,y,z]*3, role]
  for (const node of json.nodes) {
    if (node.mesh === undefined) continue;
    if (node.rotation || node.scale || node.matrix) throw new Error(`${file}: node has a transform; apply it in Blender`);
    const t = node.translation || [0, 0, 0];
    for (const pr of json.meshes[node.mesh].primitives) {
      const mat = json.materials[pr.material], role = mat.name;
      if (!roles.includes(role)) throw new Error(`${file}: unknown material ${role}`);
      colors[role] ??= hex(mat.pbrMetallicRoughness.baseColorFactor.slice(0, 3));
      const P = acc(pr.attributes.POSITION), I = acc(pr.indices);
      for (let i = 0; i < I.length; i += 3) tris.push([[0, 1, 2].map(k => [0, 1, 2].map(c => P[I[i + k] * 3 + c] + t[c])), role]);
    }
  }
  return tris;
}

const r4 = v => Math.round(v * 1e4) / 1e4;
const models = {}, soups = {};
let report = [];
for (const name of Object.keys(meta.models)) {
  const tris = readGlb(new URL(name + '.glb', SRC));
  soups[name] = tris;
  const pos = [], role = [], idx = [], seen = new Map(), faces = new Set();
  let dupes = 0, degen = 0;
  for (const [pts, rl] of tris) {
    const ids = pts.map(p => {
      const q = p.map(r4), key = q.join(',') + '|' + rl;
      if (!seen.has(key)) { seen.set(key, pos.length / 3); pos.push(...q); role.push(roles.indexOf(rl)); }
      return seen.get(key);
    });
    if (new Set(ids).size < 3) { degen++; continue; }
    const fk = [...ids].sort((a, b) => a - b).join(',');
    if (faces.has(fk)) { dupes++; continue; }
    faces.add(fk);
    idx.push(...ids);
  }
  models[name] = { pos, idx, role };
  report.push(`${name.padEnd(20)} ${String(idx.length / 3).padStart(4)} tris ${String(pos.length / 3).padStart(4)} verts${dupes ? ` ${dupes} DUPLICATE` : ''}${degen ? ` ${degen} degenerate dropped` : ''}`);
}

// ---- z-fight lint: two triangles in (nearly) the same plane whose interiors overlap
const sub = (a, b) => a.map((v, i) => v - b[i]), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
function overlap2d(A, B) {   // separating axis test on two 2D triangles, shrunk a hair so shared edges don't count
  const shrink = T => { const c = [(T[0][0] + T[1][0] + T[2][0]) / 3, (T[0][1] + T[1][1] + T[2][1]) / 3]; return T.map(p => [c[0] + (p[0] - c[0]) * 0.97, c[1] + (p[1] - c[1]) * 0.97]); };
  A = shrink(A); B = shrink(B);
  for (const T of [A, B]) for (let i = 0; i < 3; i++) {
    const p = T[i], q = T[(i + 1) % 3], ax = [q[1] - p[1], p[0] - q[0]];
    const pa = A.map(v => v[0] * ax[0] + v[1] * ax[1]), pb = B.map(v => v[0] * ax[0] + v[1] * ax[1]);
    if (Math.max(...pa) <= Math.min(...pb) + 1e-7 || Math.max(...pb) <= Math.min(...pa) + 1e-7) return false;
  }
  return true;
}
function lint(tris, eps = +(process.env.EPS || 0.003)) {
  const T = tris.map(([p, role]) => { const n = cross(sub(p[1], p[0]), sub(p[2], p[0])); const a = Math.hypot(...n) / 2; return { p, role, n: a > 1e-9 ? norm(n) : null, a }; }).filter(t => t.n && t.a > 2e-6);
  const box = t => [0, 1, 2].map(c => [Math.min(...t.p.map(v => v[c])), Math.max(...t.p.map(v => v[c]))]);
  T.forEach(t => (t.b = box(t)));
  let hits = [];
  for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
    const s = T[i], t = T[j];
    if (s.b.some((r, c) => r[1] < t.b[c][0] - eps || t.b[c][1] < r[0] - eps)) continue;
    if (Math.abs(dot(s.n, t.n)) < 0.999) continue;
    if (Math.max(...t.p.map(v => Math.abs(dot(sub(v, s.p[0]), s.n)))) > eps) continue;
    const u = norm(sub(s.p[1], s.p[0])), w = cross(s.n, u), to2 = v => [dot(sub(v, s.p[0]), u), dot(sub(v, s.p[0]), w)];
    if (overlap2d(s.p.map(to2), t.p.map(to2))) hits.push([s.role, s.p, t.role, t.p]);
  }
  return hits;
}
const stack = names => { let y = 0; const out = []; for (const n of names) { for (const [p, r] of soups[n]) out.push([p.map(v => [v[0], v[1] + y, v[2]]), r]); y += meta.models[n].storey || 0; } return out; };
const rotY = (tris, k) => tris.map(([p, r]) => [p.map(([x, y, z]) => (k % 2 ? [-x, y, -z] : [x, y, z])), r]);
const checks = Object.keys(meta.models).map(n => [n, soups[n]]);
const kinds = { house: ['house_ground', 'house_upper', 'house_roof'], tower: ['tower_base', 'tower_floor', 'tower_top'], round: ['roundtower_base', 'roundtower_floor', 'roundtower_dome|roundtower_cone'] };
const of = re => Object.keys(meta.models).filter(n => new RegExp('^(' + re + ')').test(n));
for (const [g, u, top] of Object.values(kinds)) for (const a of of(g)) for (const b of of(u)) for (const c of of(top)) {
  checks.push([`${a}+${b}+${c}`, stack([a, b, c])], [`${a}+${c}`, stack([a, c])]);
  if (g !== 'house_ground') for (const b2 of of(u)) checks.push([`${b}+${b2}(flipped)`, [...soups[b], ...rotY(soups[b2], 1).map(([p, r]) => [p.map(v => [v[0], v[1] + (meta.models[b].storey || 0), v[2]]), r])]]);
}
let bad = 0;
const seenCheck = new Set();
for (const [n, tris] of checks) {
  if (seenCheck.has(n)) continue; seenCheck.add(n);
  const hits = lint(tris);
  if (hits.length) { bad++; report.push(`Z-FIGHT ${n}: ${hits.length} pairs` + (process.env.VERBOSE ? `, e.g. ${hits.slice(0, 3).map(h => `${h[0]} ${JSON.stringify(h[1].map(v => v.map(r4)))} / ${h[2]} ${JSON.stringify(h[3].map(v => v.map(r4)))}`).join('  ||  ')}` : '')); }
}
report.push(`${checks.length - [...seenCheck].length ? '' : ''}z-fight lint: ${seenCheck.size} models/stacks checked, ${bad} with overlapping coplanar faces`);

const dest = new URL('../islands/public/models/houses.json', import.meta.url);
const out = { note: 'Generated by tools/blender/build_houses.py + tools/bake-houses.mjs; do not edit by hand.', roles, colors, meta: Object.fromEntries(Object.entries(meta.models).map(([k, v]) => [k, { ...v, tris: undefined }])), models };
fs.writeFileSync(dest, JSON.stringify(out));
console.log(report.join('\n'));
console.log(`wrote ${dest.pathname}: ${(fs.statSync(dest).size / 1024).toFixed(0)} KB`);
