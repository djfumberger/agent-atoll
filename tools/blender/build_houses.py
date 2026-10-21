# Builds Agent Atoll's v2 houses procedurally: low-poly, flat-shaded, a little organic (leaning plaster,
# sagging roofs, chunky chimneys, stone plinths, recessed windows). Every face carries one material
# "role" (wall, roof, wood, trim, stone, door, glass, accent, metal) that islands.js tints at runtime.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/blender/build_houses.py
#
# Writes tools/blender/out/<model>.glb, out/meta.json (storey heights, smoke points) and
# out/preview.png (a contact sheet). Then run `node tools/bake-houses.mjs` to refresh models/houses.json.
#
# Geometry is written in scene coordinates (x right, y up, +z = front/door) and converted to Blender's
# Z-up on the way in, so the glTF exporter hands three.js the same numbers. Randomness is seeded per model.
# Z-fighting rules: no two faces share a plane where they overlap. Parts that meet intersect instead
# (frames sink into walls, roofs swallow wall tops), stackable walls are open tubes whose seams hide
# under a band, and window panes sit recessed inside their frames.
import bpy, math, random, json, os
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)

ROLES = {'wall': '#f3ead8', 'roof': '#b5532f', 'wood': '#8b5a2b', 'trim': '#5e3d24', 'stone': '#a39d92',
         'door': '#4a2f1a', 'glass': '#2a3a4c', 'accent': '#d9534f', 'metal': '#3a3f45'}
RN = list(ROLES)
UP = Vector((0, 1, 0))


def V(x, y, z): return Vector((x, y, z))
def lerp(a, b, t): return a + (b - a) * t


def newell(pts):
    n = Vector((0, 0, 0))
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        n.x += (a.y - b.y) * (a.z + b.z); n.y += (a.z - b.z) * (a.x + b.x); n.z += (a.x - b.x) * (a.y + b.y)
    return n


def mean(pts): return sum(pts, Vector()) / len(pts)


class Part:
    """A model under construction: a soup of polygons, each with a role."""
    def __init__(s, seed):
        s.v, s.f, s.rng = [], [], random.Random(seed)

    def j(s, a): return (s.rng.random() * 2 - 1) * a
    def jit(s, ring, a, ay=0.0): return [p + V(s.j(a), s.j(ay), s.j(a)) for p in ring]

    def face(s, pts, role, want):
        """Add a polygon facing `want` (orientation fixed up by the hint); drops degenerate corners."""
        out = []
        for p in pts:
            if out and (out[-1] - p).length < 1e-7: continue
            out.append(p.copy())
        while len(out) > 1 and (out[0] - out[-1]).length < 1e-7: out.pop()
        if len(out) < 3: return
        n = newell(out)
        if n.length < 1e-9: return
        if n.dot(want) < 0: out.reverse()
        base = len(s.v); s.v.extend(out)
        s.f.append((list(range(base, base + len(out))), role))

    def shell(s, rings, role, cap0=True, cap1=True, center=None, caps=None):
        """Loft through rings of equal length. role may be fn(i, j) -> role or None (skip that quad).
        cap0/cap1 close the ends (True, or a role name). Faces point away from `center`."""
        rings = [[p if isinstance(p, Vector) else V(*p) for p in r] for r in rings]
        c = center if center is not None else mean([p for r in rings for p in r])
        n = len(rings[0])
        for i in range(len(rings) - 1):
            for j in range(n):
                k = (j + 1) % n
                rl = role(i, j) if callable(role) else role
                if rl is None: continue
                q = [rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]]
                s.face(q, rl, mean(q) - c)
        cr = caps or (role if isinstance(role, str) else None)
        for on, r in ((cap0, rings[0]), (cap1, rings[-1])):
            if on: s.face(r, on if isinstance(on, str) else cr, mean(r) - c)

    def rim(s, outer, inner, deep, role, reveal, floor, n):
        """A recess: a flat rim from outer to inner ring, reveal walls back to deep ring, and a floor."""
        dc = mean(deep)
        for j in range(len(outer)):
            k = (j + 1) % len(outer)
            s.face([outer[j], outer[k], inner[k], inner[j]], role[j] if isinstance(role, list) else role, n)
            q = [inner[j], inner[k], deep[k], deep[j]]
            s.face(q, reveal[j] if isinstance(reveal, list) else reveal, dc - mean(q))
        if floor: s.face(deep, floor, n)

    def tris(s): return sum(len(f) - 2 for f, _ in s.f)


# ---------------------------------------------------------------- primitives
def rect(cx, cz, w, d, y):
    return [V(cx - w / 2, y, cz - d / 2), V(cx + w / 2, y, cz - d / 2), V(cx + w / 2, y, cz + d / 2), V(cx - w / 2, y, cz + d / 2)]


def ngon(cx, cz, r, y, n, rot=0.0):
    return [V(cx + math.sin(rot + 2 * math.pi * k / n) * r, y, cz + math.cos(rot + 2 * math.pi * k / n) * r) for k in range(n)]


def box(P, x0, x1, y0, y1, z0, z1, role, cap0=False, cap1=True, ja=0.0, jtop=0.0):
    b, t = rect((x0 + x1) / 2, (z0 + z1) / 2, x1 - x0, z1 - z0, y0), rect((x0 + x1) / 2, (z0 + z1) / 2, x1 - x0, z1 - z0, y1)
    P.shell([P.jit(b, ja), P.jit(t, ja, jtop)], role, cap0, cap1)


def frame_of(c, n):
    n = V(*n).normalized(); return V(*c), n, UP.cross(n)


def obox(P, c, n, u0, u1, v0, v1, d0, d1, role, caps=(True, True), ja=0.0):
    """Box in a wall's frame: u along the wall (rightwards seen from outside), v up, d out of the wall."""
    c, n, rt = frame_of(c, n)
    ring = lambda v: [c + rt * u0 + UP * v + n * d0, c + rt * u1 + UP * v + n * d0, c + rt * u1 + UP * v + n * d1, c + rt * u0 + UP * v + n * d1]
    P.shell([P.jit(ring(v0), ja), P.jit(ring(v1), ja)], role, *caps)


def beam(P, a, b, w, t, nrm, role, caps=True):
    """A square-ish beam from a to b, `w` wide across and `t` thick along nrm."""
    a, b = V(*a), V(*b); ax = (b - a).normalized(); nrm = V(*nrm).normalized()
    side = ax.cross(nrm).normalized(); nrm = side.cross(ax).normalized()
    ring = lambda c: [c - side * w / 2 - nrm * t / 2, c + side * w / 2 - nrm * t / 2, c + side * w / 2 + nrm * t / 2, c - side * w / 2 + nrm * t / 2]
    P.shell([ring(a), ring(b)], role, caps, caps)


def tube(P, a, b, r0, r1, n, role, caps=True, rot=0.0, mid=None):
    """An n-sided log/pipe from a to b; `mid` = list of (t, radius) extra rings (barrel bulge)."""
    a, b = V(*a), V(*b); ax = (b - a).normalized()
    h = V(0, 1, 0) if abs(ax.y) < 0.9 else V(1, 0, 0)
    e1 = ax.cross(h).normalized(); e2 = ax.cross(e1)
    ring = lambda c, r: [c + (e1 * math.cos(rot + 2 * math.pi * k / n) + e2 * math.sin(rot + 2 * math.pi * k / n)) * r for k in range(n)]
    rs = [(0, r0)] + (mid or []) + [(1, r1)]
    P.shell([ring(a.lerp(b, t), r) for t, r in rs], role, caps, caps)


def blob(P, c, r, role, sy=0.8):
    c = V(*c); rot = P.rng.random()
    mid = P.jit(ngon(c.x, c.z, r, c.y, 4, rot), r * 0.25, r * 0.15)
    P.shell([[c - V(0, r * sy, 0)] * 4, mid, [c + V(P.j(r * .2), r * sy, P.j(r * .2))] * 4], role, False, False)


def pebble(P, c, sx, sy, sz, role='stone'):
    """A rounded, irregular stone: three 4-rings twisted 45 degrees from each other."""
    c = V(*c); rot = P.rng.random() * math.pi
    def ring(y, r, a): return [V(c.x + math.sin(a + k * math.pi / 2) * sx * r * (1 + P.j(0.18)), c.y + y * sy + P.j(sy * 0.12),
                                 c.z + math.cos(a + k * math.pi / 2) * sz * r * (1 + P.j(0.18))) for k in range(4)]
    P.shell([ring(-0.75, 0.62, rot), ring(0.0, 1.0, rot + math.pi / 4), ring(0.8, 0.58, rot)], role, True, True)


def opening(P, c, n, w, h, out=0.03, back=0.035, fw=0.018, fb=None, recess=0.016, pane='glass', frame='trim', sill_role=None, bevel=False):
    """A frame block standing proud of a wall with a recessed pane (or door leaf). c = centre on the wall.
    bevel: the frame slopes straight down to the pane (fewer faces) instead of a flat frame plus reveal."""
    c, n, rt = frame_of(c, n)
    q = lambda u, v, d: c + rt * u + UP * v + n * d
    W, Ht = w / 2 + fw, h / 2 + fw
    Hb = h / 2 + (fw if fb is None else fb)
    of = [q(-W, -Hb, out), q(W, -Hb, out), q(W, Ht, out), q(-W, Ht, out)]
    P.shell([[q(-W, -Hb, -back), q(W, -Hb, -back), q(W, Ht, -back), q(-W, Ht, -back)], of], frame, False, False, center=c)
    inn = [q(-w / 2, -h / 2, out), q(w / 2, -h / 2, out), q(w / 2, h / 2, out), q(-w / 2, h / 2, out)]
    dp = [p - n * recess for p in inn]
    if bevel: inn = dp   # reveal quads collapse to nothing and are dropped
    low = sill_role or frame
    P.rim(of, inn, dp, [low, frame, frame, frame], [low, frame, frame, frame], pane, n)


def window(P, c, n, w=0.1, h=0.13, shutters=None, flowers=False, sill='stone', frame='trim', fw=0.018, sw=0.5):
    opening(P, c, n, w, h, fw=fw, frame=frame, bevel=True)
    W, Ht = w / 2 + fw, h / 2 + fw
    if sill: obox(P, c, n, -W - 0.014, W + 0.014, -Ht - 0.022, -Ht + 0.006, -0.02, 0.048, sill, caps=(False, True))
    if shutters:
        for sg in (-1, 1):
            u0, u1 = sorted((sg * (W - 0.006), sg * (W + w * sw)))
            obox(P, c, n, u0, u1, -Ht - 0.006, Ht - 0.008, -0.008, 0.016, shutters)
    if flowers:
        y0 = -Ht - (0.012 if sill else -0.012) - 0.052   # top sinks into the sill/frame, never level with it
        obox(P, c, n, -W - 0.008, W + 0.008, y0, y0 + 0.052, -0.028, 0.062, 'wood')
        cc, nn, rt = frame_of(c, n)
        k = 4
        for i in range(k):
            u = lerp(-W + 0.02, W - 0.02, i / (k - 1))
            blob(P, cc + rt * u + UP * (y0 + 0.056) + nn * (0.034 + P.j(0.01)), 0.024 + P.j(0.005), 'accent')


def door(P, c_bottom, n, w=0.13, h=0.21, frame='trim', fw=0.022):
    c = V(*c_bottom) + UP * (h / 2)
    opening(P, c, n, w, h, out=0.042, fw=fw, fb=0.012, recess=0.02, pane='door', frame=frame, sill_role='stone')
    # a plank or two and a knob on the leaf
    cc, nn, rt = frame_of(c, n)
    beam(P, cc + rt * (-w / 2 - 0.004) + UP * (h * 0.18) + nn * 0.024, cc + rt * (w / 2 + 0.004) + UP * (h * 0.18) + nn * 0.024, 0.022, 0.012, nn, frame)
    blob(P, cc + rt * (w * 0.3) + nn * 0.028, 0.009, 'metal', sy=1)


def lantern(P, c, n):
    """A wall lantern on a bracket (its glass glows like a window)."""
    c, n, rt = frame_of(c, n)
    beam(P, c - n * 0.02 + UP * 0.012, c + n * 0.06 + UP * 0.012, 0.012, 0.012, UP, 'metal')
    b = c + n * 0.06 - UP * 0.05
    P.shell([rect(b.x, b.z, 0.034, 0.034, b.y), rect(b.x, b.z, 0.034, 0.034, b.y + 0.045)], 'glass', 'metal', False)
    P.shell([rect(b.x, b.z, 0.05, 0.05, b.y + 0.043), [b + UP * 0.075] * 4], 'metal', True, False)


def chimney(P, rings_spec, top, cw, lean=0.012, role='stone', jt=0.004):
    """A tapering stack through rings_spec [(x, z, w, d, y)], then a crown with a sooty flue at `top`.
    Returns the flue mouth (for smoke)."""
    lx, lz = P.j(lean), P.j(lean)
    rings = [P.jit(rect(x, z, w, d, y), jt) for x, z, w, d, y in rings_spec]
    x, z, w, d, _ = rings_spec[-1]
    cx, cz = x + lx, z + lz
    rings.append(rect(cx, cz, cw[0] - 0.03, cw[1] - 0.03, top - 0.03))
    P.shell(rings, role, False, False)
    b, t = rect(cx, cz, cw[0], cw[1], top - 0.04), rect(cx, cz, cw[0], cw[1], top)
    P.shell([b, t], role, True, False)
    inn, deep = rect(cx, cz, cw[0] - 0.036, cw[1] - 0.036, top), rect(cx, cz, cw[0] - 0.036, cw[1] - 0.036, top - 0.03)
    P.rim(t, inn, deep, role, role, 'metal', UP)
    return [round(cx, 4), round(top + 0.03, 4), round(cz, 4)]


def gable_roof(P, span, length, axis='x', rise=0.24, eave=(0.08, 0.08), over=0.05, tv=0.034, sag=0.012, uc=0.0,
               origin=(0, 0, 0), gable='wall', ridge='trim', role='roof', ej=0.006, courses=3, cd=0.012):
    """Two sagging slabs meeting at a ridge, sized for a wall top `span` wide (across) and `length` long.
    The slabs' undersides cross the wall line just below the wall top, so walls end inside the roof.
    Each slab is `courses` overlapping shingle courses, each one stepped up by cd (they intersect, never lie flush).
    axis = direction of the ridge. Gable end walls (pentagons) sit 8mm inside the wall faces below."""
    ox, oy, oz = origin
    M = (lambda u, y, s: V(ox + s, oy + y, oz + u)) if axis == 'x' else (lambda u, y, s: V(ox + u, oy + y, oz + s))
    ywt = tv - 0.012
    L = length / 2 + over
    ss = [-L, -L / 3, L / 3, L]
    R = lambda s: rise - sag * (1 - (s / L) ** 2)
    m = {}
    for side in (-1, 1):
        e = eave[0 if side < 0 else 1]
        m[side] = (rise - ywt) / (span / 2 - side * uc)
        eav = [(side * (span / 2 + e), ywt - m[side] * e + P.j(ej)) for s in ss]
        # course joints (and the 0.07-lower step faces) kept clear of the wall line and the gable's hidden sides
        avoid = [e / (span / 2 + e), (e + 0.025) / (span / 2 + e)]
        cuts = [c / courses for c in range(1, courses)]
        for k, b in enumerate(cuts):
            while any(abs(b - f) < 0.05 or abs(b - 0.07 - f) < 0.05 for f in avoid): b += 0.03
            cuts[k] = b
        cuts = [0.07] + cuts + [1.0]
        for c in range(courses):
            f0, f1 = cuts[c] - 0.07, cuts[c + 1]
            rings = []
            Lc = L - 0.009 * c   # each course a touch shorter, so their gable-end caps never share a plane
            for (ue, ye), s in zip(eav, [-Lc, -L / 3, L / 3, Lc]):
                p0 = (lerp(ue, uc, f0), lerp(ye, R(s), f0)); p1 = (lerp(ue, uc, f1), lerp(ye, R(s), f1))
                lo, hi = c * cd * 0.5 - tv, c * cd
                rings.append([M(p0[0], p0[1] + lo, s), M(p0[0], p0[1] + hi, s), M(p1[0], p1[1] + hi, s), M(p1[0], p1[1] + lo, s)])
            top = c == courses - 1
            P.shell(rings, lambda i, j: None if j == 2 and top else role, True, True, caps=role)
    if ridge:
        d = 0.02
        rt = (courses - 1) * cd + 0.004
        P.shell([[M(uc - d, R(s) + rt, s), M(uc, R(s) + rt + d, s), M(uc + d, R(s) + rt, s), M(uc, R(s) + rt - d, s)]
                 for s in [-L - 0.012, -L / 3, L / 3, L + 0.012]], ridge, True, True)
    if gable:
        a = span / 2 - 0.025   # well inside the walls so its hidden sides stay clear of anything fixed to them
        yl, yr = ywt - tv / 2 + m[-1] * (span / 2 - a), ywt - tv / 2 + m[1] * (span / 2 - a)
        pent = lambda s: [M(-a, -0.014, s), M(a, -0.014, s), M(a, yr, s), M(uc, rise - tv / 2 - 0.002, s), M(-a, yl, s)]
        sg = length / 2 - 0.008
        P.shell([pent(-sg), pent(sg)], gable, True, True)
    return {'slope': m, 'L': L, 'ywt': ywt}


def hip_roof(P, w, d, rise, eave=0.07, rl=0.2, tv=0.03, ye=-0.03, origin=(0, 0, 0), role='roof', ej=0.01, axis='x'):
    """A hipped (rl > 0) or pyramid (rl = 0) roof over a w x d wall top."""
    ox, oy, oz = origin
    W, D = w / 2 + eave, d / 2 + eave
    top = [V(ox - W, oy + ye + P.j(ej), oz - D), V(ox + W, oy + ye + P.j(ej), oz - D), V(ox + W, oy + ye + P.j(ej), oz + D), V(ox - W, oy + ye + P.j(ej), oz + D)]
    bot = [p - V(0, tv, 0) for p in top]
    a, b = (V(-rl / 2, 0, 0), V(rl / 2, 0, 0)) if axis == 'x' else (V(0, 0, rl / 2), V(0, 0, -rl / 2))
    o = V(ox, oy + rise, oz)
    ridge = [o + a, o + b, o + b, o + a] if axis == 'x' else [o + b, o + b, o + a, o + a]
    P.shell([bot, top, ridge], role, True, False)


def walls(P, specs, role='wall', n=None):
    """An open wall tube: specs = [(y, w, d, jitter)] (or (y, r, jitter) with n sides for round towers)."""
    if n: rings = [P.jit(ngon(0, 0, r, y, n, -math.pi / n), j) for y, r, j in specs]
    else: rings = [P.jit(rect(0, 0, w, d, y), j) for y, w, d, j in specs]
    P.shell(rings, role, False, False)


def on_face(side, along, y, hx, hz):
    """Point on a rectangular wall (front=+z) and its outward normal; `along` runs rightwards seen from outside."""
    return {'front': ((along, y, hz), (0, 0, 1)), 'back': ((-along, y, -hz), (0, 0, -1)),
            'right': ((hx, y, -along), (1, 0, 0)), 'left': ((-hx, y, along), (-1, 0, 0))}[side]


def corner_posts(P, b, t, w=0.032, role='trim'):
    """Posts along the four corners of a wall tube, bottom ring b to top ring t (same corner order)."""
    for p, q in zip(b, t):
        beam(P, p, q, w, w, V(p.x, 0, p.z), role)


# ---------------------------------------------------------------- props
def barrel(P, x, z, r=0.055, h=0.13):
    tube(P, (x, -0.01, z), (x, h, z), r * 0.85, r * 0.85, 6, 'wood', mid=[(0.5, r)])
    y = -0.01 + (h + 0.01) * 0.72
    tube(P, (x, y - 0.01, z), (x, y + 0.01, z), r * 0.98, r * 0.98, 6, 'metal', caps=False)


def crate(P, x, z, s=0.1, ry=0.0, y=0.0):
    c, n = V(x, y, z), V(math.sin(ry), 0, math.cos(ry))
    obox(P, c, n, -s / 2, s / 2, -0.01, s, -s / 2, s / 2, 'wood', ja=0.003)
    for sg in (-1, 1):   # chunky corner battens
        obox(P, c, n, sg * s / 2 - 0.012, sg * s / 2 + 0.012, -0.005, s + 0.004, -s / 2 - 0.006, s / 2 + 0.006, 'trim')


def stump(P, x, z, r=0.06, h=0.1):
    tube(P, (x, -0.02, z), (x, h, z), r * 1.15, r, 6, 'wood', rot=P.rng.random())


# ---------------------------------------------------------------- models
MODELS, META = {}, {}


def model(name, seed, **meta):
    def deco(fn):
        P = Part(seed)
        extra = fn(P) or {}
        MODELS[name] = P
        META[name] = {**meta, **extra}
        return fn
    return deco


# --- houses: plaster cottages; ground + upper storeys stack, a roof caps them -----------------------
HH = 0.34                      # storey height
HTW, HTD = 0.58, 0.48          # every storey ends at this wall-top footprint, so all roofs fit all storeys


def house_ground(P, v):
    box(P, -0.325, 0.325, -0.04, 0.06, -0.275, 0.275, 'stone', ja=0.006, jtop=0.008)            # plinth
    for x, z in ((-0.33, 0.21), (0.31, -0.25), (-0.3, -0.27), (0.33, 0.24)):                        # chunky footing stones
        pebble(P, (x + P.j(0.02), 0.03, z), 0.06, 0.045, 0.05)
    walls(P, [(0.02, 0.6, 0.5, 0.004), (0.18, 0.597, 0.497, 0.004), (HH, HTW, HTD, 0)])
    hx = lambda y: lerp(0.3, HTW / 2, y / HH); hz = lambda y: lerp(0.25, HTD / 2, y / HH)
    f = lambda side, a, y: on_face(side, a, y, hx(y), hz(y))
    dx = -0.13 if v == 'a' else 0.0
    door(P, (dx, 0.08, hz(0.18)), (0, 0, 1))
    box(P, dx - 0.1, dx + 0.1, -0.03, 0.035, hz(0) - 0.02, hz(0) + 0.09, 'stone', ja=0.006)       # door step
    if v == 'a':
        window(P, *f('front', 0.15, 0.2), shutters='wood', flowers=True)
        lantern(P, (dx - 0.115, 0.27, hz(0.27)), (0, 0, 1))
        for side in ('left', 'right'): window(P, *f(side, 0.0, 0.2))
        for a in (-0.15, 0.15): window(P, *f('back', a, 0.2))
    else:
        for a in (-0.19, 0.19):
            c, n = f('front', a, 0.2)
            window(P, c, n, w=0.09, shutters=None, flowers=a > 0)
        # a striped awning over the door: accent and plaster strips
        c, n, rt = frame_of((0, 0.335, hz(0.33)), (0, 0, 1))
        k, w0 = 5, 0.26
        for i in range(k):
            u0, u1 = -w0 / 2 + w0 * i / k, -w0 / 2 + w0 * (i + 1) / k
            acc = i % 2 == 0
            if not acc: u0, u1 = u0 - 0.004, u1 + 0.004
            dr = (n * 0.14 - UP * 0.07).normalized()
            a0 = c + rt * ((u0 + u1) / 2) - n * 0.02 - dr * (0 if acc else 0.01)
            a1 = c + rt * ((u0 + u1) / 2) - n * 0.02 + n * 0.14 - UP * 0.07 - dr * (0 if acc else 0.008)
            beam(P, a0, a1, u1 - u0, 0.026 if acc else 0.014, UP, 'accent' if acc else 'wall')
        for sg in (-1, 1):
            beam(P, c + rt * (sg * 0.105) - UP * 0.06, c + rt * (sg * 0.105) + n * 0.11 - UP * 0.055, 0.014, 0.014, rt, 'trim')
        for side in ('left', 'right'): window(P, *f(side, 0.06 if side == 'left' else -0.06, 0.2), shutters='wood')
        window(P, *f('back', 0.0, 0.2))
        barrel(P, 0.37, -0.12)
    return {'h': HH, 'storey': HH}


def house_upper(P, v):
    # a jettied upper storey: overhangs the ground floor on a beam, then leans back in to the shared wall top
    box(P, -0.322, 0.322, -0.036, 0.004, -0.272, 0.272, 'trim', cap0=True, ja=0.002)
    b, t = rect(0, 0, 0.625, 0.525, -0.02), rect(0, 0, HTW, HTD, HH)
    walls(P, [(-0.02, 0.625, 0.525, 0.003), (0.17, 0.606, 0.506, 0.004), (HH, HTW, HTD, 0)])
    hx = lambda y: lerp(0.3125, HTW / 2, (y + 0.02) / (HH + 0.02)); hz = lambda y: lerp(0.2625, HTD / 2, (y + 0.02) / (HH + 0.02))
    f = lambda side, a, y: on_face(side, a, y, hx(y), hz(y))
    if v == 'a':   # half-timbered
        corner_posts(P, b, t, 0.034)
        for side in ('front', 'back', 'left', 'right'):
            y = 0.055 if side in ('front', 'back') else 0.045   # rails cross at the corners, so not at the same height
            c, n = f(side, 0, y)
            span = (hx(y) if side in ('front', 'back') else hz(y))
            cc, nn, rt = frame_of(c, n)
            beam(P, cc - rt * (span + 0.012) + nn * 0.003, cc + rt * (span + 0.012) + nn * 0.003, 0.026, 0.032, nn, 'trim', caps=False)
        for side in ('front', 'back'):
            c0, n = f(side, 0, 0.06); c1, _ = f(side, 0, HH - 0.01)
            beam(P, V(*c0) + V(*n) * 0.003, V(*c1) + V(*n) * 0.003, 0.026, 0.03, n, 'trim')
        for side in ('left', 'right'):
            for sg in (-1, 1):
                c0, n = f(side, sg * 0.2, 0.06); c1, _ = f(side, sg * 0.1, 0.26)
                beam(P, V(*c0) + V(*n) * 0.003, V(*c1) + V(*n) * 0.003, 0.022, 0.03, n, 'trim')
        for a in (-0.14, 0.14): window(P, *f('front', a, 0.18), shutters='wood' if a < 0 else None, flowers=a > 0)
        for a in (-0.14, 0.14): window(P, *f('back', a, 0.18))
        for side in ('left', 'right'): window(P, *f(side, 0.0, 0.18))
    else:
        for a in (-0.14, 0.14): window(P, *f('front', a, 0.18), shutters='accent', flowers=True)
        for a in (-0.14, 0.14): window(P, *f('back', a, 0.18), shutters='accent')
        for side in ('left', 'right'): window(P, *f(side, 0.0, 0.18))
    return {'h': HH, 'storey': HH}


for v, sd in (('a', 11), ('b', 12)):
    model(f'house_ground_{v}', sd, kind='house')(lambda P, v=v: house_ground(P, v))
    model(f'house_upper_{v}', sd + 10, kind='house')(lambda P, v=v: house_upper(P, v))


@model('house_roof_a', 31, kind='house')
def _(P):   # long gable, eaves over the door, a chimney on the back slope
    gable_roof(P, HTD, HTW, 'x', rise=0.25, eave=(0.075, 0.09), over=0.055, uc=0.012, sag=0.014)
    chimney(P, [(-0.17, -0.09, 0.09, 0.09, -0.02)], 0.38, (0.12, 0.12))
    return {'h': 0.29}


@model('house_roof_b', 32, kind='house')
def _(P):   # steep gable facing front with a little attic window
    gable_roof(P, HTW, HTD, 'z', rise=0.32, eave=(0.07, 0.06), over=0.06, uc=-0.01, sag=0.012)
    window(P, (0, 0.1, HTD / 2 - 0.008), (0, 0, 1), w=0.08, h=0.08, sill=None)
    chimney(P, [(0.17, -0.1, 0.09, 0.09, -0.02)], 0.4, (0.12, 0.12))
    return {'h': 0.35}


@model('house_roof_c', 33, kind='house')
def _(P):   # hipped cottage roof
    hip_roof(P, HTW, HTD, 0.27, eave=0.07, rl=0.18)
    chimney(P, [(0.14, 0.06, 0.09, 0.09, -0.02)], 0.36, (0.12, 0.12))
    return {'h': 0.28}


# --- cabins: logs or planks, 1 storey ---------------------------------------------------------------
def log_walls(P, W, D, courses=4, r=0.047, step=0.084, y0=0.05, cx=0.0, eaves='x'):
    """Crossed log courses. Logs running under the eaves (`eaves` = ridge axis) get shorter near the top,
    or their ends would poke through the sloping roof."""
    for i in range(courses):
        k = courses - 1 - i
        short = (0.0, 0.016)[k] if k < 2 else None   # overhang of the top two courses (ends sit near a crossing log's axis, clear of its facets)
        for sg in (-1, 1):
            y = y0 + i * step + P.j(0.003)
            e0, e1 = (0.09, 0.065) if (i + (sg > 0)) % 2 else (0.065, 0.09)   # staggered ends: neighbouring caps never line up
            a0, a1 = (e0, e1) if eaves == 'x' or short is None else (short, short)
            tube(P, (cx - W / 2 - a0 + P.j(0.003), y, sg * D / 2), (cx + W / 2 + a1 + P.j(0.003), y + P.j(0.004), sg * D / 2),
                 r + P.j(0.004), r + P.j(0.004), 5, 'wood', rot=math.pi / 2 + (i % 2) * 0.31 + P.j(0.08))
            y = y0 + step / 2 + i * step + P.j(0.003)
            a0, a1 = (e1, e0) if eaves == 'z' or short is None else (short, short)
            tube(P, (cx + sg * W / 2, y, -D / 2 - a0 + P.j(0.003)), (cx + sg * W / 2, y + P.j(0.004), D / 2 + a1 + P.j(0.003)),
                 r + P.j(0.004), r + P.j(0.004), 5, 'wood', rot=(i % 2) * 0.31 + P.j(0.08))
    return y0 + step / 2 + (courses - 1) * step   # wall line (centre of the top side log)


@model('cabin_a', 41, kind='cabin')
def _(P):   # log cabin with a fieldstone chimney
    cx, W, D = 0.05, 0.5, 0.42
    top = log_walls(P, W, D, cx=cx)
    door(P, (cx - 0.08, 0.025, D / 2 + 0.03), (0, 0, 1), h=0.22)
    window(P, (cx + 0.13, 0.2, D / 2 + 0.03), (0, 0, 1), shutters='trim', sill='wood')
    window(P, (cx + W / 2 + 0.03, 0.2, 0.0), (1, 0, 0), sill='wood')
    window(P, (cx, 0.2, -D / 2 - 0.03), (0, 0, -1), sill='wood')
    gable_roof(P, D, W, 'x', rise=0.25, eave=(0.1, 0.1), over=0.11, sag=0.02, origin=(cx, top, 0), gable='wood', ej=0.01, courses=2)
    x = cx - W / 2 - 0.07
    chimney(P, [(x, 0.02, 0.15, 0.17, -0.03), (x, 0.02, 0.14, 0.16, 0.24), (x + 0.015, 0.02, 0.1, 0.11, 0.36)], top + 0.36, (0.13, 0.14), role='stone', jt=0.008)
    for i in range(3): pebble(P, (x + P.j(0.05), 0.03, 0.12 + P.j(0.03) - i * 0.12), 0.05, 0.04, 0.045)
    stump(P, cx + 0.3, 0.3)
    return {'h': top + 0.27}


@model('cabin_b', 42, kind='cabin')
def _(P):   # plank cabin with a deep porch roof on posts
    W, D, H, zc = 0.5, 0.36, 0.34, -0.06
    box(P, -W / 2 - 0.02, W / 2 + 0.02, -0.04, 0.04, zc - D / 2 - 0.02, zc + D / 2 + 0.02, 'stone', ja=0.005, jtop=0.006)
    b = [p + V(0, 0, zc) for p in rect(0, 0, W, D, 0.0)]; t = [p + V(0, 0, zc) for p in rect(0, 0, W, D, H)]
    P.shell([P.jit(b, 0.004), t], 'wood', False, False)
    corner_posts(P, b, t, 0.036)
    for side, hx, hz in (('back', W / 2, D / 2), ('left', W / 2, D / 2), ('right', W / 2, D / 2)):
        span = hx if side in ('front', 'back') else hz
        for a in (-span * 0.72, span * 0.74):   # battens
            c, n = on_face(side, a, 0, hx, hz); c = V(*c) + V(0, 0, zc)
            beam(P, c + V(*n) * 0.003 + UP * 0.03, c + V(*n) * 0.003 + UP * (H - 0.03), 0.018, 0.026, n, 'trim')
    fz = zc + D / 2
    box(P, -W / 2 - 0.01, W / 2 + 0.01, -0.03, 0.05, fz - 0.03, fz + 0.17, 'wood', ja=0.003)            # porch deck
    door(P, (-0.1, 0.075, fz), (0, 0, 1), h=0.2)
    window(P, (0.11, 0.2, fz), (0, 0, 1), sill='wood', flowers=True)
    window(P, (W / 2, 0.2, zc), (1, 0, 0), sill='wood')
    window(P, (-W / 2, 0.2, zc), (-1, 0, 0), sill='wood')
    gable_roof(P, D, W, 'x', rise=0.22, eave=(0.07, 0.2), over=0.06, sag=0.016, uc=-0.02, origin=(0, H, zc), gable='wood', ej=0.008)
    for x in (-W / 2 + 0.02, W / 2 - 0.02):   # porch posts up to the long front eave
        beam(P, (x, 0.04, fz + 0.15), (x, H - 0.1, fz + 0.15), 0.03, 0.03, (0, 0, 1), 'wood')
    tube(P, (W / 2 - 0.1, 0.25, zc - 0.05), (W / 2 - 0.1, H + 0.3, zc - 0.05), 0.022, 0.022, 6, 'metal')   # stove pipe
    tube(P, (W / 2 - 0.1, H + 0.29, zc - 0.05), (W / 2 - 0.1, H + 0.33, zc - 0.05), 0.034, 0.034, 6, 'metal')
    crate(P, -W / 2 - 0.06, fz + 0.06, 0.08, ry=0.3)
    return {'h': H + 0.3}


@model('cabin_c', 43, kind='cabin')
def _(P):   # log cabin, gable to the front, woodpile under a lean-to
    cx, W, D = -0.05, 0.44, 0.48
    top = log_walls(P, W, D, cx=cx, eaves='z')
    door(P, (cx, 0.025, D / 2 + 0.03), (0, 0, 1), h=0.22)
    window(P, (cx - W / 2 - 0.03, 0.2, -0.06), (-1, 0, 0), sill='wood', shutters='trim', flowers=True)
    window(P, (cx, 0.2, -D / 2 - 0.03), (0, 0, -1), sill='wood')
    gable_roof(P, W, D, 'z', rise=0.27, eave=(0.1, 0.1), over=0.11, sag=0.018, origin=(cx, top, 0), gable='wood', ej=0.01, courses=2)
    window(P, (cx, top + 0.09, D / 2 + 0.002), (0, 0, 1), w=0.07, h=0.07, sill=None, frame='trim')
    # woodpile under a little lean-to on the right
    x0 = cx + W / 2 + 0.06
    for i, (yy, zz) in enumerate(((0.035, -0.12), (0.035, -0.04), (0.035, 0.04), (0.1, -0.08), (0.1, 0.0))):
        tube(P, (x0 + P.j(0.01), yy, zz - 0.07), (x0 + P.j(0.01), yy + P.j(0.006), zz + 0.07), 0.034, 0.034, 5, 'wood', rot=P.rng.random())
    for z in (-0.17, 0.09):
        beam(P, (x0 + 0.06, -0.02, z), (x0 + 0.06, 0.22, z), 0.022, 0.022, (1, 0, 0), 'trim')
    beam(P, (cx + W / 2 + 0.02, 0.29, -0.04), (x0 + 0.1, 0.22, -0.04), 0.3, 0.02, (0.5, 1, 0), 'roof')
    return {'h': top + 0.33}


# --- tents ------------------------------------------------------------------------------------------
@model('tent_a', 51, kind='tent')
def _(P):   # A-frame canvas tent, ridge front-to-back, flaps tied open
    span, L, rise, tv = 0.44, 0.25, 0.38, 0.014
    ss = [-L, -L / 3, L / 3, L]
    R = lambda s: rise - 0.02 * (1 - (s / L) ** 2)
    m = (rise + 0.03) / (span / 2)
    for side in (-1, 1):
        rings = []
        for s in ss:
            fl = 0.015 * (1 - (s / L) ** 2) + P.j(0.006)    # canvas bellies out between the poles
            rings.append([V(side * (span / 2 + fl), -0.03, s), V(side * (span / 2 + fl) - side * tv, -0.03, s), V(0, R(s) - tv * 1.2, s), V(0, R(s), s)])
        P.shell(rings, lambda i, j: None if j == 2 else 'wall', True, True, caps='wall')
    tri = lambda s, inset: [V(-(span / 2 - inset) + 0.02, 0.004, s), V(span / 2 - inset - 0.02, 0.004, s), V(0, rise - tv * 0.6 - inset * m, s)]
    P.shell([tri(-L + 0.012, 0.0), tri(-L + 0.024, 0.0)], 'wall', True, True)           # back wall
    P.shell([tri(L - 0.05, 0.0), tri(L - 0.04, 0.0)], 'door', True, True)              # dark doorway
    for sg in (-1, 1):   # tied-back flaps
        a, b, c = V(0, rise - 0.02, L), V(sg * (span / 2 - 0.01), -0.02, L), V(sg * 0.1, 0.004, L + 0.07)
        nn = (b - a).cross(c - a).normalized() * 0.006
        P.shell([[a - nn, b - nn, c - nn], [a + nn, b + nn, c + nn]], 'wall', True, True)
    for s in (-L - 0.005, L + 0.005):
        tube(P, (0, -0.02, s), (0, rise + 0.07, s), 0.012, 0.01, 4, 'wood', rot=math.pi / 4)
    tube(P, (-0.16, 0.03, L + 0.06), (0.0, 0.03, L + 0.1), 0.03, 0.03, 6, 'accent')        # bedroll
    crate(P, -0.34, -0.18, 0.11, ry=0.4)
    stump(P, -0.38, 0.3)
    return {'h': rise + 0.12}


@model('tent_b', 52, kind='tent')
def _(P):   # round bell tent on a centre pole
    n, r = 8, 0.25
    P.shell([ngon(0, 0, r, -0.02, n, -math.pi / n), P.jit(ngon(0, 0, r, 0.17, n, -math.pi / n), 0.004)], 'wall', False, False)
    cone = [P.jit(ngon(0, 0, 0.3, 0.135, n, -math.pi / n), 0.006, 0.006), P.jit(ngon(0, 0, 0.3, 0.155, n, -math.pi / n), 0.004, 0.004),
            P.jit(ngon(0.005, 0, 0.17, 0.32, n, -math.pi / n), 0.006), [V(0.01, 0.5, 0)] * n]
    P.shell(cone, 'wall', True, False)
    opening(P, (0, 0.075, r * math.cos(math.pi / n)), (0, 0, 1), 0.1, 0.14, out=0.02, fw=0.012, fb=0.004, recess=0.03, pane='door', frame='wall', sill_role='wall')
    tube(P, (-0.085, 0.16, r * math.cos(math.pi / n) + 0.03), (0.085, 0.16, r * math.cos(math.pi / n) + 0.03), 0.018, 0.018, 6, 'wall')   # rolled flap
    tube(P, (0.01, 0.44, 0), (0.01, 0.58, 0), 0.012, 0.009, 4, 'wood')
    blob(P, (0.01, 0.6, 0), 0.02, 'accent', sy=1.2)
    for a in (0.9, 2.4, 3.9, 5.3):   # tent pegs
        tube(P, (math.sin(a) * 0.38, -0.02, math.cos(a) * 0.38), (math.sin(a) * 0.38, 0.05, math.cos(a) * 0.38), 0.01, 0.008, 4, 'wood')
    crate(P, -0.33, -0.2, 0.1, ry=0.7)
    stump(P, -0.38, 0.3)
    return {'h': 0.62}


# --- workshops: timber-framed plaster, big stone chimney --------------------------------------------
def workshop(P, W, D, H, cx, big=False, lean_to=False):
    box(P, cx - W / 2 - 0.02, cx + W / 2 + 0.02, -0.04, 0.05, -D / 2 - 0.02, D / 2 + 0.02, 'stone', ja=0.005, jtop=0.007)
    b = [p + V(cx, 0, 0) for p in rect(0, 0, W, D, 0.01)]; t = [p + V(cx, 0, 0) for p in rect(0, 0, W, D, H)]
    P.shell([P.jit(b, 0.004), P.jit([p + V(0, -H / 2, 0) for p in t], 0.004), t], 'wall', False, False)
    corner_posts(P, b, t, 0.04)
    hx, hz = W / 2, D / 2
    def f(side, a, y):
        c, n = on_face(side, a, y, hx, hz); return V(*c) + V(cx, 0, 0), V(*n)
    rails = [0.085, H - 0.04] + ([H * 0.5] if big else [])
    for side in ('front', 'back', 'left', 'right'):
        span = hx if side in ('front', 'back') else hz
        for y in rails:
            if side == 'front' and y < 0.1: continue
            y += 0.0 if side in ('front', 'back') else 0.008   # rails cross at the corners, so not at the same height
            c, n = f(side, 0, y)
            cc, nn, rt = frame_of(c, n)
            beam(P, cc - rt * (span + 0.01) + nn * 0.003, cc + rt * (span + 0.01) + nn * 0.003, 0.03, 0.032, nn, 'trim', caps=False)   # ends hide in the posts
    for side in ('back', 'left') + (('right',) if not big else ()):
        span = hx if side in ('front', 'back') else hz
        c0, n = f(side, -span + 0.02, 0.1); c1, _ = f(side, -span * 0.62, H * (0.48 if big else 0.95) - 0.03)
        beam(P, c0 + n * 0.003, c1 + n * 0.003, 0.026, 0.024, n, 'trim')
    # barn door with a Z brace
    dw, dh, dx = 0.2, (0.19 if big else 0.24), cx - W * 0.16   # the leaf stays below the timber rails
    c, n = f('front', dx - cx, 0.075)
    door(P, c, n, w=dw, h=dh, fw=0.026)
    cd = c + n * 0.04 + UP * (dh * 0.5)   # Z brace sits proud of the leaf and its cross plank
    rt = UP.cross(n)
    beam(P, cd - rt * (dw / 2 - 0.02) - UP * (dh / 2 - 0.05), cd + rt * (dw / 2 - 0.02) + UP * (dh / 2 - 0.05), 0.022, 0.012, n, 'trim')
    window(P, *f('front', W * 0.25, H * (0.3 if big else 0.55)), w=0.1, h=0.12, flowers=not big)
    if big:   # ground-floor windows fit between the sill rail and the mid rail
        for side in ('back', 'left'): window(P, *f(side, 0.0, 0.188), h=0.11)
    else:
        for a in (-W * 0.21, W * 0.21): window(P, *f('back', a, H * 0.55))
        window(P, *f('left', 0.0, H * 0.55), shutters='wood')
    return f


@model('workshop_a', 61, kind='workshop')
def _(P):
    W, D, H, cx = 0.54, 0.44, 0.38, -0.05
    workshop(P, W, D, H, cx)
    g = gable_roof(P, D, W, 'x', rise=0.23, eave=(0.08, 0.08), over=0.06, sag=0.012, origin=(cx, H, 0))
    x = cx + W / 2 + 0.05
    smoke = chimney(P, [(x, -0.02, 0.15, 0.17, -0.03), (x, -0.02, 0.14, 0.16, 0.22), (x - 0.025, -0.02, 0.085, 0.095, 0.34)], H + 0.42,
                    (0.12, 0.13), jt=0.004, lean=0.006)
    barrel(P, cx - W / 2 - 0.02, D / 2 + 0.06)
    crate(P, cx + 0.08, D / 2 + 0.1, 0.09, ry=0.2)
    return {'h': H + 0.42, 'smoke': smoke}


@model('workshop_b', 62, kind='workshop')
def _(P):   # narrower shop with a lean-to over a workbench and anvil
    W, D, H, cx = 0.46, 0.44, 0.38, 0.02
    workshop(P, W, D, H, cx)
    gable_roof(P, D, W, 'x', rise=0.23, eave=(0.08, 0.08), over=0.06, sag=0.014, origin=(cx, H, 0), uc=0.015)
    x0 = cx - W / 2
    beam(P, (x0 + 0.03, H - 0.06, 0.0), (x0 - 0.17, H - 0.16, 0.0), 0.5, 0.022, (-0.5, 1, 0), 'roof')       # lean-to
    for z in (-0.2, 0.2):
        beam(P, (x0 - 0.14, -0.02, z), (x0 - 0.14, H - 0.14, z), 0.026, 0.026, (1, 0, 0), 'wood')
    obox(P, (x0 - 0.1, 0, 0.0), (-1, 0, 0), -0.12, 0.12, 0.11, 0.135, -0.035, 0.035, 'wood')            # bench top
    for z in (-0.09, 0.09):
        obox(P, (x0 - 0.1, 0, z), (-1, 0, 0), -0.012, 0.012, -0.01, 0.12, -0.026, 0.026, 'wood')
    obox(P, (x0 - 0.09, 0, -0.17), (-1, 0, 0), -0.03, 0.03, -0.01, 0.07, -0.025, 0.025, 'wood')           # anvil on a block
    obox(P, (x0 - 0.09, 0, -0.17), (-1, 0, 0), -0.05, 0.05, 0.06, 0.1, -0.018, 0.018, 'metal')
    x = cx + W / 2 + 0.05
    smoke = chimney(P, [(x, 0.02, 0.15, 0.17, -0.03), (x, 0.02, 0.14, 0.16, 0.2), (x - 0.025, 0.02, 0.085, 0.095, 0.32)], H + 0.46,
                    (0.12, 0.13), jt=0.004, lean=0.006)
    return {'h': H + 0.46, 'smoke': smoke}


@model('workshop_big', 63, kind='workshop')
def _(P):   # two levels with a loft door and hoist beam
    W, D, H, cx = 0.56, 0.48, 0.58, -0.05
    f = workshop(P, W, D, H, cx, big=True)
    gable_roof(P, D, W, 'x', rise=0.25, eave=(0.08, 0.08), over=0.06, sag=0.016, origin=(cx, H, 0), courses=2)
    c, n = f('front', -W * 0.16, H * 0.62)
    door(P, c, n, w=0.14, h=0.16)
    beam(P, c + UP * 0.215 - n * 0.03, c + UP * 0.215 + n * 0.16, 0.032, 0.032, UP, 'wood')
    tube(P, c + UP * 0.205 + n * 0.14, c + UP * 0.06 + n * 0.14, 0.004, 0.004, 4, 'metal', caps=False)
    window(P, *f('front', W * 0.3, H * 0.75), w=0.1, h=0.12)
    window(P, *f('back', 0.0, H * 0.75))
    window(P, *f('left', 0.0, H * 0.75))
    x = cx + W / 2 + 0.05
    smoke = chimney(P, [(x, -0.02, 0.16, 0.18, -0.03), (x, -0.02, 0.15, 0.17, 0.34), (x - 0.025, -0.02, 0.095, 0.105, 0.48)], H + 0.5,
                    (0.13, 0.14), jt=0.004, lean=0.006)
    barrel(P, cx - W / 2 - 0.01, D / 2 + 0.06)
    return {'h': H + 0.5, 'smoke': smoke}


# --- square towers: base + stacked floors + top -------------------------------------------------------
TW, TF, TB = 0.62, 0.30, 0.36


def quoins(P, y0, y1, flip=False):
    for k, (sx, sz) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
        long_x = (k % 2 == 0) != flip
        a, b = (0.1, 0.07) if long_x else (0.07, 0.1)
        x, z = sx * (TW / 2 - a / 2 + 0.014), sz * (TW / 2 - b / 2 + 0.014)
        box(P, x - a / 2, x + a / 2, y0, y1, z - b / 2, z + b / 2, 'stone', cap0=True, ja=0.004)


def band(P, s=TW + 0.035, y0=-0.016, y1=0.022, role='stone'):
    box(P, -s / 2, s / 2, y0, y1, -s / 2, s / 2, role, cap0=True, ja=0.002)


@model('tower_base', 71, kind='tower')
def _(P):
    box(P, -0.35, 0.35, -0.04, 0.07, -0.35, 0.35, 'stone', ja=0.008, jtop=0.01)
    walls(P, [(0.0, TW, TW, 0.004), (TB, TW, TW, 0)])
    quoins(P, 0.095, 0.17); quoins(P, 0.185, 0.26, True)
    h = TW / 2
    door(P, (0, 0.1, h), (0, 0, 1), w=0.14, h=0.2, frame='stone', fw=0.03)
    obox(P, (0, 0.33, h), (0, 0, 1), -0.13, 0.13, -0.035, -0.01, -0.02, 0.12, 'accent')   # flat canopy
    for sg in (-1, 1): beam(P, (sg * 0.1, 0.26, h - 0.01), (sg * 0.1, 0.3, h + 0.1), 0.014, 0.014, (1, 0, 0), 'metal')
    for side in ('left', 'right', 'back'): window(P, *on_face(side, 0, 0.2, h, h))
    return {'h': TB, 'storey': TB}


def tower_floor(P, v):
    band(P)
    walls(P, [(0.0, TW, TW, 0), (TF / 2, TW + 0.004, TW + 0.004, 0.003), (TF, TW, TW, 0)])
    quoins(P, 0.04, 0.12, v == 'b')
    for side in ('front', 'back', 'left', 'right'):
        for a in (-0.11, 0.11):
            fancy = v == 'b' and side == 'front'
            window(P, *on_face(side, a, 0.16, TW / 2, TW / 2), w=0.09, h=0.13, shutters='accent' if fancy else None, flowers=fancy, sw=0.38)
    return {'h': TF, 'storey': TF}


model('tower_floor_a', 72, kind='tower')(lambda P: tower_floor(P, 'a'))
model('tower_floor_b', 73, kind='tower')(lambda P: tower_floor(P, 'b'))


@model('tower_top_a', 74, kind='tower')
def _(P):   # keep: corbelled parapet with merlons, a flag
    band(P, TW + 0.04)
    o, i = 0.68, 0.56
    P.shell([P.jit(rect(0, 0, o, o, 0.0), 0.003), rect(0, 0, o, o, 0.12)], 'wall', True, False)
    P.rim(rect(0, 0, o, o, 0.12), rect(0, 0, i, i, 0.12), rect(0, 0, i, i, 0.05), 'stone', 'wall', 'roof', UP)
    for x, z in ((1, 1), (1, -1), (-1, -1), (-1, 1), (1, 0), (0, -1), (-1, 0), (0, 1)):   # merlons, a touch proud of the parapet
        hx = 0.04 if x else 0.06; hz = 0.04 if z else 0.06
        box(P, x * 0.31 - hx, x * 0.31 + hx, 0.1, 0.2 + P.j(0.008), z * 0.31 - hz, z * 0.31 + hz, 'wall', cap0=True, ja=0.003)
    tube(P, (-0.12, 0.04, -0.12), (-0.12, 0.62, -0.12), 0.012, 0.01, 4, 'metal')
    P.shell([[V(-0.12, 0.6, -0.124), V(-0.12, 0.48, -0.124), V(0.1, 0.55, -0.124)], [V(-0.12, 0.6, -0.116), V(-0.12, 0.48, -0.116), V(0.1, 0.55, -0.116)]], 'accent')
    hip_roof(P, 0.16, 0.16, 0.16, eave=0.02, rl=0.0, origin=(0.12, 0.05, 0.12), ye=0.0)    # stair hut
    box(P, 0.06, 0.18, 0.04, 0.06, 0.06, 0.18, 'wall', cap1=False)
    return {'h': 0.62}


@model('tower_top_b', 75, kind='tower')
def _(P):   # steep pyramid roof with a finial
    band(P, TW + 0.04)
    hip_roof(P, TW, TW, 0.42, eave=0.07, rl=0.0, ye=-0.02, tv=0.035)
    tube(P, (0, 0.36, 0), (0, 0.56, 0), 0.012, 0.008, 4, 'metal')
    blob(P, (0, 0.5, 0), 0.025, 'accent', sy=1)
    obox(P, (0, 0.1, 0.24), (0, 0, 1), -0.06, 0.06, -0.06, 0.06, -0.06, 0.07, 'wall')               # dormer
    window(P, (0, 0.11, 0.31), (0, 0, 1), w=0.07, h=0.08, sill=None)
    gable_roof(P, 0.12, 0.14, 'z', rise=0.07, eave=(0.02, 0.02), over=0.02, tv=0.02, sag=0, origin=(0, 0.16, 0.255), gable=None, ridge=None, courses=1)
    return {'h': 0.56}


# --- round towers: observatory / library -------------------------------------------------------------
RN_, RR, RB, RF = 10, 0.3, 0.36, 0.32


def facet(k, y, r=RR):
    a = 2 * math.pi * k / RN_
    ap = r * math.cos(math.pi / RN_)
    return (math.sin(a) * ap, y, math.cos(a) * ap), (math.sin(a), 0, math.cos(a))


def wall_stones(P, ks, ys):
    for k, y in zip(ks, ys):
        c, n = facet(k + 0.5 + P.j(0.15), y)
        pebble(P, V(*c) + V(*n) * 0.0, 0.045, 0.03, 0.045)


@model('roundtower_base', 81, kind='round')
def _(P):
    P.shell([P.jit(ngon(0, 0, 0.345, -0.04, RN_, -math.pi / RN_), 0.006), P.jit(ngon(0, 0, 0.34, 0.06, RN_, -math.pi / RN_), 0.006, 0.008)], 'stone', False, True)
    for k in range(9):
        a = 2 * math.pi * (k + 0.5) / 9 + 0.3
        if abs(math.atan2(math.sin(a), math.cos(a))) < 0.5: continue    # keep the doorstep clear
        pebble(P, (math.sin(a) * 0.35, 0.03, math.cos(a) * 0.35), 0.075 + P.j(0.015), 0.05, 0.06)
    walls(P, [(0.0, RR + 0.004, 0.004), (0.18, RR + 0.006, 0.004), (RB, RR, 0)], n=RN_)
    c, n = facet(0, 0.095)
    door(P, c, n, w=0.12, h=0.18, frame='stone', fw=0.026)
    obox(P, (c[0], 0.31, c[2]), n, -0.11, 0.11, -0.02, 0.0, -0.02, 0.1, 'accent')
    for k in (3, 7): window(P, *facet(k, 0.22), w=0.08, h=0.12)
    wall_stones(P, [1, 4, 6, 8], [0.12, 0.28, 0.1, 0.26])
    return {'h': RB, 'storey': RB}


def round_floor(P, v):
    P.shell([P.jit(ngon(0, 0, RR + 0.022, -0.016, RN_, -math.pi / RN_), 0.003), ngon(0, 0, RR + 0.022, 0.024, RN_, -math.pi / RN_)], 'stone', True, True)
    walls(P, [(0.0, RR, 0), (RF / 2, RR + 0.006, 0.004), (RF, RR, 0)], n=RN_)
    ks = (0, 3, 6) if v == 'a' else (1, 5, 8)
    for k in ks: window(P, *facet(k, 0.16), w=0.08, h=0.13, shutters='wood' if v == 'b' and k == 1 else None)
    wall_stones(P, [k + 1 for k in ks], [0.08 + P.rng.random() * 0.15 for _ in ks])
    return {'h': RF, 'storey': RF}


model('roundtower_floor_a', 82, kind='round')(lambda P: round_floor(P, 'a'))
model('roundtower_floor_b', 83, kind='round')(lambda P: round_floor(P, 'b'))


@model('roundtower_dome', 84, kind='round')
def _(P):   # observatory dome with a slit and a telescope
    P.shell([P.jit(ngon(0, 0, RR + 0.03, -0.016, RN_, -math.pi / RN_), 0.003), ngon(0, 0, RR + 0.03, 0.03, RN_, -math.pi / RN_)], 'stone', True, True)
    rings = [ngon(0, 0, (RR + 0.01) * math.cos(t), 0.02 + (RR + 0.01) * 0.85 * math.sin(t), RN_, -math.pi / RN_) for t in (0, 0.5, 1.0)]
    P.shell(rings + [[V(0, 0.02 + (RR + 0.01) * 0.85, 0)] * RN_], 'roof', False, False)
    pts = [(0, 0.02 + (RR + 0.01) * 0.85 * math.sin(t) + 0.004, (RR + 0.012) * math.cos(t)) for t in (0.15, 0.6, 1.2)]
    strip = lambda p, nr: [V(-0.03, p[1], p[2]) - nr * 0.015, V(0.03, p[1], p[2]) - nr * 0.015, V(0.03, p[1], p[2]) + nr * 0.015, V(-0.03, p[1], p[2]) + nr * 0.015]
    P.shell([strip(p, V(0, p[1] - 0.02, p[2]).normalized()) for p in pts], 'metal', True, True)
    tube(P, (0, 0.18, 0.12), (0.0, 0.33, 0.34), 0.03, 0.026, 6, 'metal')
    tube(P, (0, 0.32, 0.325), (0.0, 0.345, 0.36), 0.036, 0.036, 6, 'trim')
    return {'h': 0.32}


@model('roundtower_cone', 85, kind='round')
def _(P):   # a witch-hat roof with a crooked tip
    P.shell([P.jit(ngon(0, 0, RR + 0.022, -0.016, RN_, -math.pi / RN_), 0.003), ngon(0, 0, RR + 0.022, 0.024, RN_, -math.pi / RN_)], 'stone', True, True)
    rings = [P.jit(ngon(0, 0, 0.39, -0.025, RN_, -math.pi / RN_), 0.004, 0.008), P.jit(ngon(0, 0, 0.39, 0.005, RN_, -math.pi / RN_), 0.004, 0.008),
             ngon(0, 0, 0.27, 0.13, RN_, -math.pi / RN_), ngon(0.012, 0, 0.15, 0.32, RN_, -math.pi / RN_),
             ngon(0.04, 0, 0.06, 0.5, RN_, -math.pi / RN_), [V(0.09, 0.6, 0)] * RN_]
    P.shell(rings, 'roof', True, False)
    blob(P, (0.095, 0.61, 0), 0.022, 'accent', sy=1.1)
    window(P, *facet(0, 0.1, 0.24), w=0.06, h=0.07, sill=None)
    return {'h': 0.62}


# ---------------------------------------------------------------- Blender plumbing
def srgb2lin(c): return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
def hexlin(h): return tuple(srgb2lin(int(h[i:i + 2], 16) / 255) for i in (1, 3, 5))


def materials():
    mats = {}
    for name, hx in ROLES.items():
        m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        bsdf.inputs['Base Color'].default_value = (*hexlin(hx), 1)
        bsdf.inputs['Roughness'].default_value = 0.85
        m.diffuse_color = (*hexlin(hx), 1)
        mats[name] = m
    return mats


def to_object(name, P, mats):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(p.x, -p.z, p.y) for p in P.v], [], [f for f, _ in P.f])
    for r in RN: me.materials.append(mats[r])
    for poly, (_, role) in zip(me.polygons, P.f): poly.material_index = RN.index(role)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = materials()
    objs = {}
    for name, P in MODELS.items():
        ob = to_object(name, P, mats)
        objs[name] = ob
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True); bpy.context.view_layer.objects.active = ob
        bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, name + '.glb'), export_format='GLB', use_selection=True,
                                  export_yup=True, export_apply=True, export_texcoords=False, export_normals=False,
                                  export_materials='EXPORT')
        META[name]['tris'] = P.tris()
        print(f'{name:22s} {P.tris():4d} tris')
    json.dump({'roles': ROLES, 'models': META}, open(os.path.join(OUT, 'meta.json'), 'w'), indent=1)
    preview(objs, mats)


def preview(objs, mats):
    """Contact sheet: assembled buildings in rows, rendered from the front-right and back-left."""
    for ob in objs.values(): ob.hide_render = True
    sc = bpy.context.scene
    rows = [
        [['tent_a'], ['tent_b'], ['cabin_a'], ['cabin_b'], ['cabin_c']],
        [['house_ground_a', 'house_roof_a'], ['house_ground_b', 'house_upper_a', 'house_roof_b'], ['house_ground_a', 'house_upper_b', 'house_roof_c'],
         ['house_ground_b', 'house_roof_b'], ['house_ground_b', 'house_upper_b', 'house_roof_a']],
        [['workshop_a'], ['workshop_b'], ['workshop_big'], ['roundtower_base', 'roundtower_cone'], ['roundtower_base', 'roundtower_floor_a', 'roundtower_floor_b', 'roundtower_dome']],
        [['tower_base', 'tower_floor_a', 'tower_top_b'], ['tower_base', 'tower_floor_a', 'tower_floor_b', 'tower_floor_a', 'tower_top_a'],
         ['tower_base'] + ['tower_floor_a', 'tower_floor_b'] * 4 + ['tower_top_b']],
    ]
    placed = []
    lm = bpy.data.materials.new('label'); lm.diffuse_color = (0.08, 0.1, 0.12, 1)
    for ri, row in enumerate(rows):
        for ci, stack in enumerate(row):
            x, z, y = ci * 1.15, ri * 1.35, 0.0
            for k, name in enumerate(stack):
                o = bpy.data.objects.new(f'pv_{ri}_{ci}_{k}', objs[name].data)
                o.location = (x, -z, y)
                if name.startswith('tower_floor') or name.startswith('roundtower_floor'): o.rotation_euler.z = k * math.pi
                sc.collection.objects.link(o); placed.append(o)
                y += META[name].get('storey', 0)
            cu = bpy.data.curves.new(f'lb_{ri}_{ci}', 'FONT'); cu.body = ' + '.join(n.replace('house_', '').replace('roundtower_', 'rt_').replace('tower_', 't_') for n in dict.fromkeys(stack)); cu.size = 0.07; cu.align_x = 'CENTER'
            cu.materials.append(lm)
            t = bpy.data.objects.new(f'lbo_{ri}_{ci}', cu); t.location = (x, -z - 0.5, 0.001); sc.collection.objects.link(t); placed.append(t)
    bpy.context.view_layer.update()
    coords = [o.matrix_world @ Vector(c) for o in placed for c in o.bound_box]
    gm = bpy.data.materials.new('ground'); gm.diffuse_color = (*hexlin('#8fbf6a'), 1)
    bpy.ops.mesh.primitive_plane_add(size=20, location=(2.3, -2.0, -0.002))
    bpy.context.object.data.materials.append(gm)
    sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading
    sh.light, sh.color_type, sh.show_shadows, sh.show_cavity = 'STUDIO', 'MATERIAL', True, False
    sc.display.shadow_shift = 0.1
    sc.render.resolution_x, sc.render.resolution_y = 1800, 1200
    sc.render.film_transparent = False
    sc.world = sc.world or bpy.data.worlds.new('w')
    sh.background_type = 'VIEWPORT'; sh.background_color = hexlin('#bfe3ef')
    cam = bpy.data.cameras.new('cam'); co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
    cam.type = 'ORTHO'
    shots = []
    for i, rz in enumerate((math.radians(28), math.radians(28 + 180))):
        co.rotation_euler = (math.radians(58), 0, rz)
        bpy.context.view_layer.update()
        loc, scale = co.camera_fit_coords(bpy.context.evaluated_depsgraph_get(), [c for v in coords for c in v])
        co.location = loc; cam.ortho_scale = scale * 1.03
        p = os.path.join(OUT, f'_view{i}.png'); sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        shots.append(p)
    # stack the two views into one sheet
    import numpy as np
    ims = [bpy.data.images.load(p) for p in shots]
    w, h = ims[0].size
    px = [np.array(im.pixels[:]).reshape(h, w, 4) for im in ims]
    sheet = np.concatenate([px[1], px[0]], axis=0)   # image rows run bottom-up
    out = bpy.data.images.new('sheet', w, h * 2)
    out.pixels = sheet.ravel()
    out.filepath_raw = os.path.join(OUT, 'preview.png'); out.file_format = 'PNG'; out.save()
    for p in shots: os.remove(p)
    print('preview', os.path.join(OUT, 'preview.png'))


main()
