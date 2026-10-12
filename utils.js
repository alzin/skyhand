// =====================================================
//  utils.js — maths, filters, procedural textures and
//  a small mesh builder shared by every other file.
// =====================================================
//
//  COORDINATES (p5 WEBGL native)
//    +X = east (screen right)   +Y = DOWN   +Z = south
//    so "up" is -Y.  1 unit = 1 metre, time in seconds.
//
//  Heights and altitudes are always up-positive numbers
//  in this project. Convert to p5 space with  y = -height.

const G = 9.81;
const DEG = Math.PI / 180;
const FULL_TURN = Math.PI * 2;


// =====================================================
// SCALAR HELPERS
// =====================================================

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerpNum(a, b, t) {
  return a + (b - a) * t;
}

// Works with reversed edges too (edge0 > edge1).
function smoothstep01(edge0, edge1, x) {
  const t = clampNum((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Frame-rate independent smoothing toward a target.
// `rate` ≈ 1 / time-constant (per second).
function approach(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function wrapAngle(a) {
  while (a > Math.PI) a -= FULL_TURN;
  while (a < -Math.PI) a += FULL_TURN;
  return a;
}

// Radio-style stick shaping: dead-zone + expo curve.
function shapeStick(v, deadzone, expo) {
  const a = Math.abs(v);
  if (a <= deadzone) return 0;
  const t = Math.min(1, (a - deadzone) / (1 - deadzone));
  return Math.sign(v) * Math.pow(t, expo);
}


// =====================================================
// 3D VECTOR HELPERS (plain {x, y, z} objects)
// =====================================================

function v3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

function vAdd(a, b) {
  return v3(a.x + b.x, a.y + b.y, a.z + b.z);
}

function vSub(a, b) {
  return v3(a.x - b.x, a.y - b.y, a.z - b.z);
}

function vScale(a, s) {
  return v3(a.x * s, a.y * s, a.z * s);
}

function vDot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function vCross(a, b) {
  return v3(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x
  );
}

function vLen(a) {
  return Math.hypot(a.x, a.y, a.z);
}

function vNorm(a) {
  const l = vLen(a) || 1;
  return v3(a.x / l, a.y / l, a.z / l);
}

function vApproach(cur, target, rate, dt) {
  const k = 1 - Math.exp(-rate * dt);
  return v3(
    cur.x + (target.x - cur.x) * k,
    cur.y + (target.y - cur.y) * k,
    cur.z + (target.z - cur.z) * k
  );
}


// =====================================================
// ONE EURO FILTER
// Smooths jittery hand tracking while staying responsive
// when the hand moves fast (Casiez et al., CHI 2012).
// =====================================================

class OneEuroFilter {
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  alpha(dt, cutoff) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value, t) {
    if (this.x === null) {
      this.x = value;
      this.t = t;
      return value;
    }

    const dt = Math.max(1e-3, t - this.t);
    this.t = t;

    const speed = (value - this.x) / dt;
    this.dx = lerpNum(this.dx, speed, this.alpha(dt, this.dCutoff));

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x = lerpNum(this.x, value, this.alpha(dt, cutoff));

    return this.x;
  }
}


// =====================================================
// SEEDED RANDOM + GRADIENT NOISE
// (deterministic, so the world is the same every run)
// =====================================================

function makeRng(seed) {
  let s = seed >>> 0;

  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Noise2D {
  constructor(seed) {
    const rng = makeRng(seed);
    const p = new Uint8Array(256);

    for (let i = 0; i < 256; i++) p[i] = i;

    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }

    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];

    this.gx = new Float32Array(8);
    this.gy = new Float32Array(8);

    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * FULL_TURN + 0.3;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  // Perlin-style gradient noise, roughly in [-1, 1].
  get(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const P = this.perm;

    const h00 = P[P[X] + Y] & 7;
    const h10 = P[P[X + 1] + Y] & 7;
    const h01 = P[P[X] + Y + 1] & 7;
    const h11 = P[P[X + 1] + Y + 1] & 7;

    const n00 = this.gx[h00] * xf + this.gy[h00] * yf;
    const n10 = this.gx[h10] * (xf - 1) + this.gy[h10] * yf;
    const n01 = this.gx[h01] * xf + this.gy[h01] * (yf - 1);
    const n11 = this.gx[h11] * (xf - 1) + this.gy[h11] * (yf - 1);

    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

    return lerpNum(lerpNum(n00, n10, u), lerpNum(n01, n11, u), v) * 1.41;
  }

  // Fractal Brownian motion: several octaves of noise.
  fbm(x, y, octaves = 4) {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let total = 0;

    for (let i = 0; i < octaves; i++) {
      sum += amp * this.get(x * freq, y * freq);
      total += amp;
      amp *= 0.5;
      freq *= 2.03;
    }

    return sum / total;
  }
}


// =====================================================
// GEOMETRY BUILDER
// Thousands of trees, houses and rocks are merged into
// ONE p5.Geometry, so the GPU draws them in a single
// call. Shapes are authored Y-UP (easier to think in)
// and converted to p5's Y-down space when stored.
// =====================================================

class GeoBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.faces = [];
  }

  get vertexCount() {
    return this.pos.length / 3;
  }

  vert(x, y, z, nx, ny, nz, c) {
    this.pos.push(x, -y, z);
    this.nrm.push(nx, -ny, nz);
    this.col.push(c[0], c[1], c[2], c.length > 3 ? c[3] : 1);
    return this.pos.length / 3 - 1;
  }

  tri(a, b, c) {
    this.faces.push([a, b, c]);
  }

  // Flat polygon (3+ coplanar points). The normal is turned
  // to face away from `inside` (a point inside the solid).
  poly(points, c, inside) {
    const p0 = points[0];
    const p1 = points[1];
    const p2 = points[2];

    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    if (inside) {
      let cx = 0, cy = 0, cz = 0;
      for (const p of points) {
        cx += p[0];
        cy += p[1];
        cz += p[2];
      }
      cx /= points.length;
      cy /= points.length;
      cz /= points.length;

      const facing =
        nx * (cx - inside[0]) +
        ny * (cy - inside[1]) +
        nz * (cz - inside[2]);

      if (facing < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
    }

    const idx = points.map((p) => this.vert(p[0], p[1], p[2], nx, ny, nz, c));
    for (let i = 1; i < idx.length - 1; i++) this.tri(idx[0], idx[i], idx[i + 1]);
  }

  // Box standing on height y0, rotated `rot` radians about Y.
  box(cx, y0, cz, w, h, d, c, rot = 0, bottom = false) {
    const hw = w / 2, hd = d / 2, y1 = y0 + h;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const P = (lx, y, lz) => [cx + lx * cs + lz * sn, y, cz - lx * sn + lz * cs];

    const a = P(-hw, y0, -hd), b = P(hw, y0, -hd);
    const e = P(hw, y0, hd), f = P(-hw, y0, hd);
    const a2 = P(-hw, y1, -hd), b2 = P(hw, y1, -hd);
    const e2 = P(hw, y1, hd), f2 = P(-hw, y1, hd);
    const inside = [cx, (y0 + y1) / 2, cz];

    this.poly([a, b, b2, a2], c, inside);
    this.poly([b, e, e2, b2], c, inside);
    this.poly([e, f, f2, e2], c, inside);
    this.poly([f, a, a2, f2], c, inside);
    this.poly([a2, b2, e2, f2], c, inside);
    if (bottom) this.poly([a, b, e, f], c, inside);
  }

  // Gable roof on height y0; the ridge runs along local Z.
  roof(cx, y0, cz, w, d, h, roofCol, gableCol, rot = 0) {
    const hw = w / 2, hd = d / 2;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const P = (lx, y, lz) => [cx + lx * cs + lz * sn, y, cz - lx * sn + lz * cs];
    const inside = [cx, y0 + h * 0.3, cz];

    const l0 = P(-hw, y0, -hd), l1 = P(-hw, y0, hd);
    const r0 = P(hw, y0, -hd), r1 = P(hw, y0, hd);
    const t0 = P(0, y0 + h, -hd), t1 = P(0, y0 + h, hd);

    this.poly([l0, l1, t1, t0], roofCol, inside);
    this.poly([r0, t0, t1, r1], roofCol, inside);
    this.poly([l0, t0, r0], gableCol, inside);
    this.poly([l1, r1, t1], gableCol, inside);

    const under = [roofCol[0] * 0.55, roofCol[1] * 0.55, roofCol[2] * 0.55];
    this.poly([l0, r0, r1, l1], under, inside);
  }

  // Cylinder (optionally tapered) standing on y0.
  cylinder(cx, y0, cz, r0, h, seg, c, r1 = r0, capTop = true) {
    const y1 = y0 + h;
    const slope = (r0 - r1) / h;
    const nl = Math.hypot(1, slope);
    const base = this.vertexCount;

    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * FULL_TURN;
      const ca = Math.cos(a), sa = Math.sin(a);
      this.vert(cx + ca * r0, y0, cz + sa * r0, ca / nl, slope / nl, sa / nl, c);
      this.vert(cx + ca * r1, y1, cz + sa * r1, ca / nl, slope / nl, sa / nl, c);
    }

    for (let i = 0; i < seg; i++) {
      const k = base + i * 2;
      this.tri(k, k + 2, k + 1);
      this.tri(k + 1, k + 2, k + 3);
    }

    if (capTop && r1 > 0) {
      const centre = this.vert(cx, y1, cz, 0, 1, 0, c);
      const ring = this.vertexCount;

      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * FULL_TURN;
        this.vert(cx + Math.cos(a) * r1, y1, cz + Math.sin(a) * r1, 0, 1, 0, c);
      }
      for (let i = 0; i < seg; i++) this.tri(centre, ring + i, ring + i + 1);
    }
  }

  cone(cx, y0, cz, r, h, seg, c, capBottom = true) {
    const slope = r / h;
    const nl = Math.hypot(1, slope);

    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * FULL_TURN;
      const a1 = ((i + 1) / seg) * FULL_TURN;
      const am = (a0 + a1) / 2;

      const v0 = this.vert(cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r,
        Math.cos(a0) / nl, slope / nl, Math.sin(a0) / nl, c);
      const v1 = this.vert(cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r,
        Math.cos(a1) / nl, slope / nl, Math.sin(a1) / nl, c);
      const top = this.vert(cx, y0 + h, cz,
        Math.cos(am) / nl, slope / nl, Math.sin(am) / nl, c);

      this.tri(v0, v1, top);
    }

    if (capBottom) {
      const dark = [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6];
      const centre = this.vert(cx, y0, cz, 0, -1, 0, dark);
      const ring = this.vertexCount;

      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * FULL_TURN;
        this.vert(cx + Math.cos(a) * r, y0, cz + Math.sin(a) * r, 0, -1, 0, dark);
      }
      for (let i = 0; i < seg; i++) this.tri(centre, ring + i + 1, ring + i);
    }
  }

  // Flat ring lying on height y (helipad markings).
  ring(cx, y, cz, r0, r1, seg, c) {
    const base = this.vertexCount;

    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * FULL_TURN;
      const ca = Math.cos(a), sa = Math.sin(a);
      this.vert(cx + ca * r0, y, cz + sa * r0, 0, 1, 0, c);
      this.vert(cx + ca * r1, y, cz + sa * r1, 0, 1, 0, c);
    }

    for (let i = 0; i < seg; i++) {
      const k = base + i * 2;
      this.tri(k, k + 1, k + 2);
      this.tri(k + 1, k + 3, k + 2);
    }
  }

  // Lumpy, softly shaded blob (tree canopies, rocks).
  blob(cx, cy, cz, rx, ry, rz, c, rng, jitter = 0.14) {
    const ico = GeoBuilder.icosphere();
    const base = this.vertexCount;

    for (const v of ico.verts) {
      const k = 1 + (rng() * 2 - 1) * jitter;
      let nx = v[0] / rx, ny = v[1] / ry, nz = v[2] / rz;
      const nl = Math.hypot(nx, ny, nz) || 1;

      // Darker underneath: cheap self-shadowing.
      const shade = 0.72 + 0.28 * (v[1] * 0.5 + 0.5);

      this.vert(
        cx + v[0] * rx * k, cy + v[1] * ry * k, cz + v[2] * rz * k,
        nx / nl, ny / nl, nz / nl,
        [c[0] * shade, c[1] * shade, c[2] * shade]
      );
    }

    for (const f of ico.faces) this.tri(base + f[0], base + f[1], base + f[2]);
  }

  static icosphere() {
    if (GeoBuilder._ico) return GeoBuilder._ico;

    const t = (1 + Math.sqrt(5)) / 2;
    const unit = (p) => {
      const l = Math.hypot(p[0], p[1], p[2]);
      return [p[0] / l, p[1] / l, p[2] / l];
    };

    const verts = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ].map(unit);

    const faces = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
      [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
      [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];

    const cache = new Map();
    const mid = (a, b) => {
      const edge = a < b ? a * 1000 + b : b * 1000 + a;
      if (cache.has(edge)) return cache.get(edge);
      const va = verts[a], vb = verts[b];
      verts.push(unit([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]));
      cache.set(edge, verts.length - 1);
      return verts.length - 1;
    };

    const out = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      out.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }

    GeoBuilder._ico = { verts, faces: out };
    return GeoBuilder._ico;
  }

  toGeometry() {
    const g = new p5.Geometry(1, 1);
    const n = this.vertexCount;

    // p5 only reads .x/.y/.z from these, so plain objects are
    // much faster than creating 100k+ p5.Vector instances.
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      g.vertices.push({ x: this.pos[k], y: this.pos[k + 1], z: this.pos[k + 2] });
      g.vertexNormals.push({ x: this.nrm[k], y: this.nrm[k + 1], z: this.nrm[k + 2] });
    }

    g.vertexColors = this.col;
    g.faces = this.faces;
    return g;
  }
}


// =====================================================
// SOFT SHAPES (meshes instead of textures)
// Dust, spray, clouds and the sun's halo are discs whose
// vertex alpha fades to zero at the rim. The world shader's
// uColorMul uniform tints each one as it is drawn.
// =====================================================

// Disc of diameter 1 in the XY plane, facing +Z (like plane()).
function makeSoftDisc(seg = 20, rng = null, wobble = 0) {
  const gb = new GeoBuilder();
  const radius = [];
  for (let i = 0; i < seg; i++) radius.push(1 + (rng ? (rng() * 2 - 1) * wobble : 0));

  const centre = gb.vert(0, 0, 0, 0, 0, 1, [1, 1, 1, 1]);
  const mid = gb.vertexCount;
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * FULL_TURN;
    const k = radius[i % seg];
    gb.vert(Math.cos(t) * 0.26 * k, Math.sin(t) * 0.26 * k, 0, 0, 0, 1, [1, 1, 1, 0.72]);
  }
  const rim = gb.vertexCount;
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * FULL_TURN;
    const k = radius[i % seg];
    gb.vert(Math.cos(t) * 0.5 * k, Math.sin(t) * 0.5 * k, 0, 0, 0, 1, [1, 1, 1, 0]);
  }

  for (let i = 0; i < seg; i++) {
    gb.tri(centre, mid + i, mid + i + 1);
    gb.tri(mid + i, rim + i, rim + i + 1);
    gb.tri(mid + i, rim + i + 1, mid + i + 1);
  }
  return gb.toGeometry();
}
