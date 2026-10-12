// =====================================================
//  world.js — terrain, lake, road, town, forest, wind
//  turbines, race gates, sky and clouds.
//  It also answers the physics questions:
//    "how high is the ground here?"  heightAt / groundHeightAt
//    "did the drone hit something?"  collide
// =====================================================

const WORLD_SEED = 1337;

const TERRAIN = {
  HALF: 800,        // detailed area is 1.6 km x 1.6 km
  CELL: 8,          // metres between detailed vertices
  OUTER_CELLS: 22,  // rings of growing cells for far mountains
  OUTER_END: 3200,  // terrain reaches 3.2 km from the centre
};

const HOME = { x: 0, z: 0 };
const TOWN = { x: 235, z: -70, r: 95 };
const LAKE = { x: -175, z: -240, r: 105 };
const FARM = { x: 340, z: 160 };
const PILOT_SPOT = { x: 4.5, z: 11 };
const GEOFENCE_RADIUS = 620;
const ALTITUDE_LIMIT = 120;
const TURBINE = { HEIGHT: 62, HUB_OFFSET: 3.4, BLADE: 27 };

// Direction sunlight travels (p5 space). Afternoon sun in
// the south-west sky, about 48 degrees above the horizon.
const SUN_DIR = vNorm(v3(0.45, 0.75, -0.48));

const SKY = {
  zenith: [0.29, 0.49, 0.8],
  horizon: [0.78, 0.85, 0.92],
  ground: [0.66, 0.72, 0.77],
};
// Haze is a touch darker and bluer than the sky at the horizon, so far
// ridges stay readable as silhouettes (aerial perspective).
const FOG_COLOR = [0.71, 0.79, 0.88];
const FOG_DENSITY = 0.0021;

const ROAD_POINTS = [
  [-660, 220], [-460, 170], [-300, 130], [-160, 80], [-60, 40],
  [40, 34], [140, 0], [235, -60], [320, -112], [440, -160], [640, -215],
];

// The race course: fly through the rings in order. Each ring faces
// along the line from the previous gate to the next one, so gate 1
// is straight ahead of the launch pad and the lap ends just south of it.
const GATE_LAYOUT = [
  { x: 0, z: -70, agl: 6 },      // 1  north of the pad
  { x: -70, z: -195, agl: 5 },   // 2  east shore of the lake
  { x: -285, z: -270, agl: 5 },  // 3  across the water
  { x: -330, z: -110, agl: 9 },  // 4  forest clearing
  { x: -170, z: 60, agl: 7 },    // 5  western meadow
  { x: 70, z: 150, agl: 6 },     // 6  south fields
  { x: 205, z: -35, agl: 11 },   // 7  over the town street
  { x: 45, z: -15, agl: 5 },     // 8  back past the pad
];

const WALL_COLORS = [
  [0.92, 0.89, 0.8], [0.94, 0.94, 0.92], [0.82, 0.8, 0.76],
  [0.93, 0.85, 0.63], [0.8, 0.56, 0.42], [0.72, 0.78, 0.8],
];
const ROOF_COLORS = [
  [0.26, 0.28, 0.31], [0.58, 0.24, 0.18], [0.4, 0.29, 0.21],
  [0.24, 0.31, 0.4], [0.33, 0.35, 0.32],
];
const CAR_COLORS = [
  [0.75, 0.12, 0.1], [0.12, 0.25, 0.55], [0.92, 0.92, 0.9],
  [0.6, 0.62, 0.65], [0.1, 0.1, 0.12], [0.9, 0.7, 0.12],
];


class World {
  constructor() {
    this.noise = new Noise2D(WORLD_SEED);
    this.rng = makeRng(WORLD_SEED * 7 + 3);
    this.time = 0;

    this.trees = [];
    this.rocks = [];
    this.buildings = [];
    this.solids = [];     // collision shapes
    this.flatTops = [];   // surfaces you can land on
    this.gates = [];
    this.turbines = [];
    this.fields = [];

    this.sockAngle = 0;
    this.sockLift = 0.2;

    this._queryStamp = 0;
    this._cand = [];
  }

  build() {
    this._initGrid();
    this.homeBase = this.rawHeight(HOME.x, HOME.z);
    this.townBase = this._averageRaw(TOWN.x, TOWN.z, 70);
    this.waterLevel = this.homeBase - 2.6;

    this._buildFields();
    this._buildRoadPath();
    this._fillHeights();
    this._layoutGates();

    this._placeHomeBase();
    this._placeTown();
    this._placeFarm();
    this._placeTurbines();
    this._placeTrees();
    this._placeRocks();

    this._buildTerrainMesh();
    this._buildStaticMesh();
    this._buildRoadMesh();
    this._buildWaterMesh();
    this._buildWindsockMesh();
    this._buildSky();
    this._buildClouds();
    this._buildMinimap();
    this._buildSpatialHash();

    const prng = makeRng(WORLD_SEED + 31);
    this.discGeo = makeSoftDisc(24);
    this.puffGeos = [0, 1, 2].map(() => makeSoftDisc(18, prng, 0.16));
  }


  // =====================================================
  // TERRAIN GRID
  // =====================================================

  _initGrid() {
    const { HALF, CELL, OUTER_CELLS, OUTER_END } = TERRAIN;
    const extra = OUTER_END - HALF;

    const reach = (growth) => {
      let s = 0;
      let gap = CELL;
      for (let k = 0; k < OUTER_CELLS; k++) {
        gap *= growth;
        s += gap;
      }
      return s;
    };

    let lo = 1.0001;
    let hi = 2;
    for (let it = 0; it < 50; it++) {
      const m = (lo + hi) / 2;
      if (reach(m) < extra) lo = m;
      else hi = m;
    }
    const growth = (lo + hi) / 2;

    const outer = [];
    let x = HALF;
    let gap = CELL;
    for (let k = 0; k < OUTER_CELLS; k++) {
      gap *= growth;
      x += gap;
      outer.push(x);
    }

    const coords = [];
    for (let k = outer.length - 1; k >= 0; k--) coords.push(-outer[k]);
    for (let v = -HALF; v <= HALF + 0.001; v += CELL) coords.push(v);
    for (const v of outer) coords.push(v);

    this.coords = Float64Array.from(coords);
    this.N = coords.length;
    this.innerStart = OUTER_CELLS;
    this.H = new Float32Array(this.N * this.N);
  }

  // Finds the grid cell containing coordinate v.
  // Result in this._ci (index) and this._ct (0..1 within the cell).
  _cell(v) {
    const c = this.coords;
    const n = this.N;
    let i;

    if (v > -TERRAIN.HALF && v < TERRAIN.HALF) {
      i = this.innerStart + Math.floor((v + TERRAIN.HALF) / TERRAIN.CELL);
    } else if (v <= c[0]) {
      this._ci = 0;
      this._ct = 0;
      return;
    } else if (v >= c[n - 1]) {
      this._ci = n - 2;
      this._ct = 1;
      return;
    } else {
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (c[m] <= v) lo = m;
        else hi = m;
      }
      i = lo;
    }

    this._ci = i;
    this._ct = (v - c[i]) / (c[i + 1] - c[i]);
  }

  // Terrain height at (x, z): interpolates the exact
  // triangles that are drawn, so collisions match the visuals.
  heightAt(x, z) {
    this._cell(x);
    const i = this._ci;
    const u = this._ct;
    this._cell(z);
    const j = this._ci;
    const v = this._ct;

    const N = this.N;
    const H = this.H;
    const k = j * N + i;
    const a = H[k];
    const b = H[k + 1];
    const c = H[k + N];
    const d = H[k + N + 1];

    if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
    return d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }

  normalAt(x, z) {
    const e = 1.5;
    const hx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const hz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    const l = Math.hypot(hx, 1, hz);
    return [-hx / l, 1 / l, -hz / l];
  }

  // Ground including rooftops, the helipad and the water tower.
  groundHeightAt(x, z) {
    let h = this.heightAt(x, z);
    for (const t of this.flatTops) {
      if (t.top > h && this._inTop(t, x, z)) h = t.top;
    }
    // the asphalt sits 20 cm above the terrain mesh
    if (this.roadInfo(x, z) < 3.1 && this._roadH + 0.2 > h) h = this._roadH + 0.2;
    return h;
  }

  _inTop(t, x, z) {
    const dx = x - t.x;
    const dz = z - t.z;
    if (Math.abs(dx) > t.reach || Math.abs(dz) > t.reach) return false;
    if (t.shape === 'circle') return dx * dx + dz * dz <= t.r * t.r;
    const lx = dx * t.cos - dz * t.sin;
    const lz = dx * t.sin + dz * t.cos;
    return Math.abs(lx) <= t.hw && Math.abs(lz) <= t.hd;
  }

  isOverWater(x, z) {
    const d = Math.hypot(x - LAKE.x, z - LAKE.z);
    return d < LAKE.r * 1.75 && this.heightAt(x, z) < this.waterLevel;
  }

  surfaceAt(x, z) {
    if (this.isOverWater(x, z)) return 'water';
    for (const t of this.flatTops) {
      if (this._inTop(t, x, z) && t.top >= this.heightAt(x, z)) return t.surface;
    }
    if (this.roadInfo(x, z) < 3.4) return 'road';

    const h = this.heightAt(x, z);
    if (h - this.homeBase > 255) return 'snow';
    if (this.normalAt(x, z)[1] < 0.8) return 'rock';
    if (this.fieldAt(x, z)) return 'dirt';
    if (h - this.waterLevel < 1.8 && Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r * 2) return 'sand';
    return 'grass';
  }


  // =====================================================
  // HEIGHT FUNCTION
  // =====================================================

  rawHeight(x, z) {
    const n = this.noise;
    const r = Math.hypot(x, z);

    // broad rolling hills + small undulations
    let h = n.fbm(x * 0.0021 + 3.1, z * 0.0021 - 7.7, 4) * 34;
    h += n.fbm(x * 0.0085 - 11.2, z * 0.0085 + 4.4, 3) * 6;

    // a ring of ridged mountains frames the valley
    const m = smoothstep01(340, 950, r);
    if (m > 0) {
      const ridge = 1 - Math.abs(n.fbm(x * 0.0032 + 21, z * 0.0032 - 13, 5));
      const vary = 0.75 + 0.25 * n.get(x * 0.001, z * 0.001);
      h += m * (60 + 340 * ridge * ridge) * vary;
    }

    // far peaks make a wall on the horizon
    h += smoothstep01(900, 2200, r) * 220;
    return h;
  }

  _averageRaw(cx, cz, radius) {
    let sum = 0;
    let count = 0;
    for (let a = -2; a <= 2; a++) {
      for (let b = -2; b <= 2; b++) {
        sum += this.rawHeight(cx + (a / 2) * radius, cz + (b / 2) * radius);
        count++;
      }
    }
    return sum / count;
  }

  lakeRadius(angle) {
    const n = this.noise.get(Math.cos(angle) * 1.3 + 9.1, Math.sin(angle) * 1.3 - 3.3);
    return LAKE.r * (1 + 0.24 * n);
  }

  // Terrain shaped by the launch field, town and lake.
  baseHeight(x, z) {
    let h = this.rawHeight(x, z);

    const dHome = Math.hypot(x - HOME.x, z - HOME.z);
    h = lerpNum(this.homeBase, h, smoothstep01(30, 80, dHome));

    const dTown = Math.hypot(x - TOWN.x, z - TOWN.z);
    h = lerpNum(this.townBase, h, smoothstep01(TOWN.r * 0.9, TOWN.r * 1.55, dTown));

    const dx = x - LAKE.x;
    const dz = z - LAKE.z;
    const dLake = Math.hypot(dx, dz);
    if (dLake < LAKE.r * 2) {
      const R = this.lakeRadius(Math.atan2(dz, dx));
      const bed = dLake < R
        ? this.waterLevel - 0.9 - 7 * (1 - (dLake / R) * (dLake / R))
        : this.waterLevel - 0.9 + (dLake - R) * 0.15;
      h = lerpNum(bed, h, smoothstep01(R * 0.9, R * 1.6, dLake));
    }

    return h;
  }

  // ...plus a flat bed under the road.
  shapedHeight(x, z) {
    const h = this.baseHeight(x, z);
    const d = this.roadInfo(x, z);
    if (d < 18) return lerpNum(this._roadH, h, smoothstep01(6, 18, d));
    return h;
  }

  _fillHeights() {
    const N = this.N;
    const C = this.coords;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        this.H[j * N + i] = this.shapedHeight(C[i], C[j]);
      }
    }
  }

  forestDensity(x, z) {
    return smoothstep01(0.02, 0.32, this.noise.fbm(x * 0.0055 + 50, z * 0.0055 - 20, 3));
  }


  // =====================================================
  // ROAD
  // =====================================================

  _buildRoadPath() {
    const pts = ROAD_POINTS;
    const xs = [];
    const zs = [];

    for (let s = 0; s < pts.length - 1; s++) {
      const p0 = pts[Math.max(0, s - 1)];
      const p1 = pts[s];
      const p2 = pts[s + 1];
      const p3 = pts[Math.min(pts.length - 1, s + 2)];
      const steps = Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 4);

      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        const cr = (a, b, c, d) =>
          0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        xs.push(cr(p0[0], p1[0], p2[0], p3[0]));
        zs.push(cr(p0[1], p1[1], p2[1], p3[1]));
      }
    }
    xs.push(pts[pts.length - 1][0]);
    zs.push(pts[pts.length - 1][1]);

    const n = xs.length;
    const raw = xs.map((x, i) => this.baseHeight(x, zs[i]));
    const hs = raw.map((_, i) => {
      let s = 0;
      let c = 0;
      for (let k = -10; k <= 10; k++) {
        s += raw[clampNum(i + k, 0, n - 1)];
        c++;
      }
      return s / c;
    });

    this.road = { xs, zs, hs, n };

    // 32 m buckets make nearest-segment queries fast
    this.roadBuckets = new Map();
    for (let i = 0; i < n - 1; i++) {
      const x0 = Math.floor((Math.min(xs[i], xs[i + 1]) - 20) / 32);
      const x1 = Math.floor((Math.max(xs[i], xs[i + 1]) + 20) / 32);
      const z0 = Math.floor((Math.min(zs[i], zs[i + 1]) - 20) / 32);
      const z1 = Math.floor((Math.max(zs[i], zs[i + 1]) + 20) / 32);

      for (let bx = x0; bx <= x1; bx++) {
        for (let bz = z0; bz <= z1; bz++) {
          const bucket = bx * 10007 + bz;
          if (!this.roadBuckets.has(bucket)) this.roadBuckets.set(bucket, []);
          this.roadBuckets.get(bucket).push(i);
        }
      }
    }
  }

  // Distance to the road centre line (and road height in this._roadH).
  roadInfo(x, z) {
    const list = this.roadBuckets.get(Math.floor(x / 32) * 10007 + Math.floor(z / 32));
    let best = Infinity;
    this._roadH = 0;
    if (!list) return best;

    const { xs, zs, hs } = this.road;
    for (const i of list) {
      const ax = xs[i];
      const az = zs[i];
      const dx = xs[i + 1] - ax;
      const dz = zs[i + 1] - az;
      const L2 = dx * dx + dz * dz || 1;
      const t = clampNum(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
      const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
      if (d < best) {
        best = d;
        this._roadH = lerpNum(hs[i], hs[i + 1], t);
      }
    }
    return best;
  }

  _roadFrameNear(x, z) {
    const { xs, zs, n } = this.road;
    let bi = 1;
    let bd = Infinity;
    for (let i = 1; i < n - 1; i++) {
      const d = Math.hypot(xs[i] - x, zs[i] - z);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    let dx = xs[bi + 1] - xs[bi - 1];
    let dz = zs[bi + 1] - zs[bi - 1];
    const l = Math.hypot(dx, dz);
    dx /= l;
    dz /= l;
    return { x: xs[bi], z: zs[bi], dx, dz, nx: -dz, nz: dx };
  }


  // =====================================================
  // FARM FIELDS
  // =====================================================

  _buildFields() {
    const rng = makeRng(WORLD_SEED + 99);
    const palette = [
      [0.8, 0.7, 0.38], [0.5, 0.63, 0.26], [0.46, 0.36, 0.25],
      [0.42, 0.57, 0.31], [0.7, 0.66, 0.36],
    ];
    const rot = 0.35;
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);

    for (let gx = -2; gx <= 2; gx++) {
      for (let gz = -1; gz <= 2; gz++) {
        if (rng() < 0.22) continue;
        const lx = gx * 62;
        const lz = gz * 58;
        this.fields.push({
          x: FARM.x + lx * cs + lz * sn,
          z: FARM.z - lx * sn + lz * cs,
          hw: 26 + rng() * 4,
          hd: 24 + rng() * 4,
          cos: cs,
          sin: sn,
          color: palette[Math.floor(rng() * palette.length)],
        });
      }
    }
  }

  fieldAt(x, z) {
    for (const f of this.fields) {
      const dx = x - f.x;
      const dz = z - f.z;
      const lx = dx * f.cos - dz * f.sin;
      const lz = dx * f.sin + dz * f.cos;
      if (Math.abs(lx) < f.hw && Math.abs(lz) < f.hd) return f;
    }
    return null;
  }


  // =====================================================
  // RACE GATES
  // =====================================================

  _layoutGates() {
    const n = GATE_LAYOUT.length;

    this.gates = GATE_LAYOUT.map((g, i) => {
      const prev = GATE_LAYOUT[(i - 1 + n) % n];
      const next = GATE_LAYOUT[(i + 1) % n];
      let dx = next.x - prev.x;
      let dz = next.z - prev.z;
      const l = Math.hypot(dx, dz);
      dx /= l;
      dz /= l;

      const ground = this.isOverWater(g.x, g.z) ? this.waterLevel : this.heightAt(g.x, g.z);
      return {
        index: i, x: g.x, z: g.z, ground,
        h: ground + g.agl,
        nx: dx, nz: dz,
        R: 4.2, tube: 0.22,
        angle: Math.atan2(dx, dz),
        water: this.isOverWater(g.x, g.z),
      };
    });

    for (const g of this.gates) {
      this.solids.push({
        type: 'cyl', kind: 'pole', x: g.x, z: g.z,
        y0: g.ground - 1, y1: g.h - g.R, r: 0.16, reach: 1,
      });
    }
  }

  distToCourse(x, z) {
    let best = Infinity;
    const n = this.gates.length;
    for (let i = 0; i < n; i++) {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % n];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const t = clampNum(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz), 0, 1);
      best = Math.min(best, Math.hypot(x - a.x - dx * t, z - a.z - dz * t));
    }
    return best;
  }


  // =====================================================
  // LAUNCH SITE
  // =====================================================

  _placeHomeBase() {
    const top = this.homeBase + 0.12;
    this.padTop = top;

    this.flatTops.push({
      x: HOME.x, z: HOME.z, hw: 3.5, hd: 3.5, cos: 1, sin: 0,
      reach: 5, top, shape: 'rect', surface: 'pad',
    });

    this.buildings.push({ kind: 'tent', x: 9, z: 14.5, base: this.heightAt(9, 14.5), rad: 3 });
    this.solids.push({
      type: 'box', kind: 'building', x: 9, z: 14.5,
      y0: this.homeBase - 1, y1: this.homeBase + 2.6,
      hw: 1.6, hd: 1.6, cos: 1, sin: 0, reach: 3,
    });

    this.sock = { x: -9, z: 7, base: this.heightAt(-9, 7) };
    this.solids.push({
      type: 'cyl', kind: 'pole', x: -9, z: 7,
      y0: this.sock.base - 1, y1: this.sock.base + 6, r: 0.1, reach: 1,
    });
  }


  // =====================================================
  // TOWN
  // =====================================================

  _placeTown() {
    const rng = this.rng;
    const placed = [];
    const frame = this._roadFrameNear(TOWN.x, TOWN.z);

    const canPlace = (x, z, rad) => {
      if (Math.hypot(x - TOWN.x, z - TOWN.z) > TOWN.r) return false;
      for (const p of placed) {
        if (Math.hypot(x - p.x, z - p.z) < rad + p.rad + 2.5) return false;
      }
      for (const g of this.gates) {
        if (Math.hypot(x - g.x, z - g.z) < 14 + rad) return false;
      }
      if (this.roadInfo(x, z) < rad + 4.5) return false;
      return true;
    };

    const at = (along, side) => ({
      x: frame.x + frame.dx * along + frame.nx * side,
      z: frame.z + frame.dz * along + frame.nz * side,
    });
    const roadRot = Math.atan2(frame.dx, frame.dz);

    // ---- landmarks first ----
    const church = at(8, -36);
    if (canPlace(church.x, church.z, 12)) {
      this.addChurch(church.x, church.z, roadRot);
      placed.push({ x: church.x, z: church.z, rad: 12 });
    }

    const tower = at(-22, 42);
    if (canPlace(tower.x, tower.z, 7)) {
      this.addWaterTower(tower.x, tower.z);
      placed.push({ x: tower.x, z: tower.z, rad: 7 });
    }

    for (const [along, side, w, d, h] of [[30, 19, 14, 18, 10.5], [-30, -18, 16, 12, 7.5], [52, -20, 12, 14, 13.5]]) {
      const p = at(along, side);
      const rad = Math.hypot(w, d) / 2;
      if (canPlace(p.x, p.z, rad)) {
        this.addBlock(p.x, p.z, w, d, h, roadRot);
        placed.push({ x: p.x, z: p.z, rad });
      }
    }

    // ---- houses along the road ----
    const { xs, zs, n } = this.road;
    let last = -99;

    for (let i = 1; i < n - 1; i++) {
      const x = xs[i];
      const z = zs[i];
      if (Math.hypot(x - TOWN.x, z - TOWN.z) > TOWN.r) continue;
      if (i - last < 4) continue;
      last = i;

      let dx = xs[i + 1] - xs[i - 1];
      let dz = zs[i + 1] - zs[i - 1];
      const l = Math.hypot(dx, dz);
      dx /= l;
      dz /= l;
      const nx = -dz;
      const nz = dx;

      for (const side of [-1, 1]) {
        for (const row of [0, 1]) {
          if (row === 1 && rng() < 0.35) continue;
          const off = (row === 0 ? 13.5 : 31) + rng() * 3;
          const jitter = (rng() - 0.5) * 4;
          const hx = x + nx * off * side + dx * jitter;
          const hz = z + nz * off * side + dz * jitter;
          const w = 7 + rng() * 3;
          const d = 8 + rng() * 4;
          const rad = Math.hypot(w, d) / 2;
          if (!canPlace(hx, hz, rad)) continue;

          const tall = rng() < 0.3;
          this.addHouse(hx, hz, w, d, tall ? 6 : 3.3, 2.2 + rng() * 1.2,
            Math.atan2(dx, dz) + (rng() - 0.5) * 0.08, rng);
          placed.push({ x: hx, z: hz, rad });
        }
      }

      // a parked car now and then
      if (rng() < 0.45) {
        const side = rng() < 0.5 ? -1 : 1;
        const cx = x + nx * 4.6 * side;
        const cz = z + nz * 4.6 * side;
        if (!placed.some((p) => Math.hypot(cx - p.x, cz - p.z) < p.rad + 3)) {
          this.addCar(cx, cz, Math.atan2(dx, dz), CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)]);
        }
      }
    }
  }

  _pushBox(kind, x, z, y0, y1, hw, hd, rot, landable = false) {
    this.solids.push({
      type: 'box', kind, x, z, y0, y1, hw, hd,
      cos: Math.cos(rot), sin: Math.sin(rot),
      reach: Math.hypot(hw, hd) + 1, landable,
    });
  }

  addHouse(x, z, w, d, wallH, roofH, rot, rng) {
    const base = this.heightAt(x, z) - 0.2;
    const wall = WALL_COLORS[Math.floor(rng() * WALL_COLORS.length)];
    const roof = ROOF_COLORS[Math.floor(rng() * ROOF_COLORS.length)];

    this.buildings.push({
      kind: 'house', x, z, w, d, wallH, roofH, rot, base, wall, roof,
      chimney: rng() < 0.4, rad: Math.hypot(w, d) / 2,
    });

    this._pushBox('building', x, z, base, base + wallH, w / 2, d / 2, rot);
    this.solids.push({
      type: 'roof', kind: 'building', x, z,
      y0: base + wallH, h: roofH, hw: w / 2 + 0.4, hd: d / 2 + 0.3,
      cos: Math.cos(rot), sin: Math.sin(rot), reach: Math.hypot(w, d) / 2 + 1,
    });
  }

  addBlock(x, z, w, d, h, rot) {
    const base = this.heightAt(x, z) - 0.2;
    this.buildings.push({ kind: 'block', x, z, w, d, h, rot, base, rad: Math.hypot(w, d) / 2 });
    this._pushBox('building', x, z, base, base + h, w / 2, d / 2, rot, true);
    this.flatTops.push({
      x, z, hw: w / 2 - 0.2, hd: d / 2 - 0.2,
      cos: Math.cos(rot), sin: Math.sin(rot),
      reach: Math.hypot(w, d) / 2 + 1, top: base + h + 0.6, shape: 'rect', surface: 'roof',
    });
  }

  addChurch(x, z, rot) {
    const base = this.heightAt(x, z) - 0.2;
    this.buildings.push({ kind: 'church', x, z, rot, base, rad: 12 });

    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    this._pushBox('building', x, z, base, base + 7, 5, 9, rot);
    this.solids.push({
      type: 'roof', kind: 'building', x, z, y0: base + 7, h: 5,
      hw: 5.4, hd: 9.3, cos: cs, sin: sn, reach: 11,
    });

    const tx = x + -11 * sn;
    const tz = z + -11 * cs;
    this._pushBox('building', tx, tz, base, base + 18, 2.2, 2.2, rot);
    this.solids.push({ type: 'cone', kind: 'building', x: tx, z: tz, y0: base + 18, y1: base + 25, r: 2.4, reach: 3 });
  }

  addWaterTower(x, z) {
    const base = this.heightAt(x, z) - 0.2;
    this.buildings.push({ kind: 'watertower', x, z, base, rad: 6 });

    for (const [ox, oz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
      this.solids.push({ type: 'cyl', kind: 'building', x: x + ox, z: z + oz, y0: base, y1: base + 21, r: 0.35, reach: 1 });
    }
    this.solids.push({
      type: 'cyl', kind: 'building', x, z, y0: base + 21, y1: base + 28, r: 4.6, reach: 6, landable: true,
    });
    this.flatTops.push({
      x, z, r: 4.4, reach: 5, top: base + 28.2, shape: 'circle', surface: 'roof', cos: 1, sin: 0,
    });
  }

  addCar(x, z, rot, color) {
    const base = this.heightAt(x, z);
    this.buildings.push({ kind: 'car', x, z, rot, base, color, rad: 2.4 });
    this._pushBox('car', x, z, base, base + 1.5, 0.9, 2.15, rot);
  }


  // =====================================================
  // FARM AND WIND TURBINES
  // =====================================================

  _placeFarm() {
    const rot = 0.35;
    const bx = 205;
    const bz = 120;
    const base = this.heightAt(bx, bz) - 0.3;
    this.buildings.push({ kind: 'barn', x: bx, z: bz, rot, base, rad: 11 });
    this._pushBox('building', bx, bz, base, base + 5.5, 6, 8, rot);
    this.solids.push({
      type: 'roof', kind: 'building', x: bx, z: bz, y0: base + 5.5, h: 4,
      hw: 6.5, hd: 8.4, cos: Math.cos(rot), sin: Math.sin(rot), reach: 11,
    });

    const sx = 216;
    const sz = 104;
    const sb = this.heightAt(sx, sz) - 0.3;
    this.buildings.push({ kind: 'silo', x: sx, z: sz, base: sb, rad: 4 });
    this.solids.push({ type: 'cyl', kind: 'building', x: sx, z: sz, y0: sb, y1: sb + 17.5, r: 3.1, reach: 4 });
  }

  _placeTurbines() {
    for (const [x, z] of [[365, -385], [440, -295], [290, -470], [500, -195]]) {
      const base = this.heightAt(x, z);
      this.turbines.push({
        x, z, base, hubH: base + TURBINE.HEIGHT,
        angle: this.rng() * FULL_TURN, yaw: -0.9,
      });
      this.solids.push({
        type: 'cyl', kind: 'turbine', x, z, y0: base - 1, y1: base + TURBINE.HEIGHT, r: 2, reach: 3,
      });
    }
  }

  turbineHub(t) {
    return {
      x: t.x - Math.sin(t.yaw) * TURBINE.HUB_OFFSET,
      y: t.hubH,
      z: t.z - Math.cos(t.yaw) * TURBINE.HUB_OFFSET,
    };
  }


  // =====================================================
  // FOREST AND ROCKS
  // =====================================================

  _nearBuilding(x, z, margin) {
    for (const b of this.buildings) {
      if (Math.hypot(x - b.x, z - b.z) < b.rad + margin) return true;
    }
    return false;
  }

  _placeTrees() {
    const rng = makeRng(WORLD_SEED + 5);
    const grid = new Map();
    const cellKey = (gx, gz) => gx * 4099 + gz;

    const tooClose = (x, z, minD) => {
      const gx = Math.floor(x / 6);
      const gz = Math.floor(z / 6);
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const list = grid.get(cellKey(gx + a, gz + b));
          if (!list) continue;
          for (const t of list) if (Math.hypot(t.x - x, t.z - z) < minD) return true;
        }
      }
      return false;
    };

    for (let tries = 0; tries < 30000 && this.trees.length < 1700; tries++) {
      const x = (rng() * 2 - 1) * 760;
      const z = (rng() * 2 - 1) * 760;
      if (Math.hypot(x, z) > 760) continue;
      if (rng() > 0.035 + 0.9 * this.forestDensity(x, z)) continue;
      if (Math.hypot(x - HOME.x, z - HOME.z) < 75) continue;
      if (Math.hypot(x - TOWN.x, z - TOWN.z) < TOWN.r + 12) continue;

      const h = this.heightAt(x, z);
      if (h < this.waterLevel + 1.2) continue;
      if (h - this.homeBase > 250) continue;
      if (this.normalAt(x, z)[1] < 0.8) continue;
      if (this.roadInfo(x, z) < 9) continue;
      if (this.distToCourse(x, z) < 11) continue;
      if (this.fieldAt(x, z)) continue;
      if (this._nearBuilding(x, z, 6)) continue;
      if (this.turbines.some((t) => Math.hypot(x - t.x, z - t.z) < 10)) continue;
      if (tooClose(x, z, 4.2)) continue;

      const conifer = h - this.homeBase > 45 || this.noise.get(x * 0.01 + 7, z * 0.01) > 0.15;
      const tree = {
        x, z, base: h - 0.3, conifer, tint: rng(),
        h: conifer ? 9 + rng() * 9 : 7 + rng() * 6,
        r: conifer ? 2.2 + rng() * 1.3 : 2.6 + rng() * 1.6,
        second: rng() < 0.55,
      };

      const k = cellKey(Math.floor(x / 6), Math.floor(z / 6));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(tree);
      this.trees.push(tree);

      this.solids.push({
        type: 'cyl', kind: 'tree', x, z, y0: tree.base, y1: tree.base + tree.h * 0.4, r: 0.35, reach: 1,
      });
      if (conifer) {
        this.solids.push({
          type: 'cone', kind: 'tree', x, z, y0: tree.base + tree.h * 0.18, y1: tree.base + tree.h,
          r: tree.r, reach: tree.r + 1,
        });
      } else {
        this.solids.push({
          type: 'ell', kind: 'tree', x, z, y: tree.base + tree.h * 0.66,
          rx: tree.r * 1.05, ry: tree.r * 1.05, reach: tree.r + 1.5,
        });
      }
    }
  }

  _placeRocks() {
    const rng = makeRng(WORLD_SEED + 8);
    for (let tries = 0; tries < 2000 && this.rocks.length < 80; tries++) {
      const x = (rng() * 2 - 1) * 700;
      const z = (rng() * 2 - 1) * 700;
      if (Math.hypot(x - HOME.x, z - HOME.z) < 60) continue;
      if (Math.hypot(x - TOWN.x, z - TOWN.z) < TOWN.r + 10) continue;
      const h = this.heightAt(x, z);
      if (h < this.waterLevel + 0.3) continue;
      if (this.roadInfo(x, z) < 8 || this.distToCourse(x, z) < 8) continue;
      const g = 0.4 + rng() * 0.12;
      this.rocks.push({ x, z, base: h, s: 0.8 + rng() * 1.8, color: [g, g * 0.98, g * 0.93] });
    }
  }


  // =====================================================
  // TERRAIN MESH
  // =====================================================

  _gridNormal(i, j) {
    const N = this.N;
    const H = this.H;
    const C = this.coords;
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(N - 1, i + 1);
    const j0 = Math.max(0, j - 1);
    const j1 = Math.min(N - 1, j + 1);
    const hx = (H[j * N + i1] - H[j * N + i0]) / (C[i1] - C[i0]);
    const hz = (H[j1 * N + i] - H[j0 * N + i]) / (C[j1] - C[j0]);
    const l = Math.hypot(hx, 1, hz);
    return [-hx / l, 1 / l, -hz / l];
  }

  colorAt(x, z, h, ny) {
    const n = this.noise;
    const rel = h - this.homeBase;

    // meadow: two greens mixed by soft patches
    const patch = n.fbm(x * 0.011 + 70, z * 0.011 - 30, 3) * 0.5 + 0.5;
    let r = lerpNum(0.33, 0.5, patch);
    let g = lerpNum(0.5, 0.55, patch);
    let b = lerpNum(0.2, 0.26, patch);

    // darker forest floor
    const forest = this.forestDensity(x, z) * 0.75;
    r = lerpNum(r, 0.22, forest);
    g = lerpNum(g, 0.35, forest);
    b = lerpNum(b, 0.16, forest);

    const field = this.fieldAt(x, z);
    if (field) {
      const v = 0.95 + 0.1 * n.get(x * 0.08, z * 0.08);
      r = field.color[0] * v;
      g = field.color[1] * v;
      b = field.color[2] * v;
    }

    // rock on steep or high ground
    const rock = clampNum(smoothstep01(0.86, 0.66, ny) + smoothstep01(150, 250, rel) * 0.7, 0, 1);
    r = lerpNum(r, 0.46, rock);
    g = lerpNum(g, 0.44, rock);
    b = lerpNum(b, 0.4, rock);

    // snow caps
    const snow = smoothstep01(255, 300, rel + n.get(x * 0.015, z * 0.015) * 30) * smoothstep01(0.55, 0.75, ny);
    r = lerpNum(r, 0.93, snow);
    g = lerpNum(g, 0.95, snow);
    b = lerpNum(b, 0.98, snow);

    // lake shore and lake bed
    const dw = h - this.waterLevel;
    if (dw < 2 && Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r * 2) {
      const sand = smoothstep01(2, 0.3, dw);
      r = lerpNum(r, 0.62, sand);
      g = lerpNum(g, 0.56, sand);
      b = lerpNum(b, 0.42, sand);
      if (dw < 0) {
        const deep = clampNum(-dw / 6, 0, 1);
        r = lerpNum(r, 0.2, deep);
        g = lerpNum(g, 0.26, deep);
        b = lerpNum(b, 0.22, deep);
      }
    }

    // gravel shoulders
    const rd = this.roadInfo(x, z);
    if (rd < 9) {
      const k = smoothstep01(9, 4, rd);
      r = lerpNum(r, 0.5, k);
      g = lerpNum(g, 0.46, k);
      b = lerpNum(b, 0.38, k);
    }

    // mown field around the launch pad
    const dHome = Math.hypot(x - HOME.x, z - HOME.z);
    if (dHome < 40) {
      const k = smoothstep01(40, 15, dHome) * 0.5;
      r = lerpNum(r, 0.42, k);
      g = lerpNum(g, 0.6, k);
      b = lerpNum(b, 0.27, k);
    }

    // worn ground in town
    const dTown = Math.hypot(x - TOWN.x, z - TOWN.z);
    if (dTown < TOWN.r) {
      const k = smoothstep01(TOWN.r, TOWN.r * 0.5, dTown) * 0.3;
      r = lerpNum(r, 0.48, k);
      g = lerpNum(g, 0.47, k);
      b = lerpNum(b, 0.36, k);
    }

    const j = n.get(x * 0.31 + 5, z * 0.31 - 5) * 0.035;
    return [r + j, g + j, b + j * 0.5];
  }

  _buildTerrainMesh() {
    const N = this.N;
    const H = this.H;
    const C = this.coords;
    const colors = new Float32Array(N * N * 3);

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const col = this.colorAt(C[i], C[j], H[k], this._gridNormal(i, j)[1]);
        colors[k * 3] = col[0];
        colors[k * 3 + 1] = col[1];
        colors[k * 3 + 2] = col[2];
      }
    }

    // contact shadows under trees (cheap ambient occlusion)
    const half = TERRAIN.HALF;
    const cell = TERRAIN.CELL;
    for (const t of this.trees) {
      const ci = this.innerStart + Math.round((t.x + half) / cell);
      const cj = this.innerStart + Math.round((t.z + half) / cell);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= N || j >= N) continue;
          const d = Math.hypot(C[i] - t.x, C[j] - t.z);
          const reach = t.r * 1.5;
          if (d > reach) continue;
          const f = Math.max(0.5, lerpNum(0.66, 1, d / reach));
          const k = (j * N + i) * 3;
          colors[k] *= f;
          colors[k + 1] *= f;
          colors[k + 2] *= f;
        }
      }
    }
    this.terrainColors = colors;

    const gb = new GeoBuilder();
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const nrm = this._gridNormal(i, j);
        gb.vert(C[i], H[k], C[j], nrm[0], nrm[1], nrm[2],
          [colors[k * 3], colors[k * 3 + 1], colors[k * 3 + 2]]);
      }
    }

    // Diagonal from b to c, matching heightAt().
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i;
        const b = a + 1;
        const c = a + N;
        const d = c + 1;
        gb.tri(a, c, b);
        gb.tri(b, c, d);
      }
    }

    this.terrainGeo = gb.toGeometry();
  }


  // =====================================================
  // STATIC OBJECTS (one merged mesh)
  // =====================================================

  _buildStaticMesh() {
    const gb = new GeoBuilder();
    const rng = makeRng(WORLD_SEED + 11);

    for (const t of this.trees) this._addTreeMesh(gb, t, rng);

    for (const r of this.rocks) {
      gb.blob(r.x, r.base + r.s * 0.2, r.z, r.s, r.s * 0.65, r.s * 0.9, r.color, rng, 0.25);
    }

    for (const b of this.buildings) this._addBuildingMesh(gb, b, rng);

    for (const t of this.turbines) {
      gb.box(t.x, t.base - 1, t.z, 7, 1.5, 7, [0.6, 0.6, 0.58]);
      gb.cylinder(t.x, t.base, t.z, 2.0, TURBINE.HEIGHT - 0.5, 14, [0.93, 0.94, 0.95], 1.25, true);
    }

    for (const g of this.gates) {
      if (g.water) {
        gb.cylinder(g.x, g.ground - 0.4, g.z, 0.7, 0.8, 12, [1, 0.48, 0.1]);
      } else {
        gb.box(g.x, g.ground - 0.1, g.z, 1.1, 0.25, 1.1, [0.35, 0.36, 0.38]);
      }
      gb.cylinder(g.x, g.ground, g.z, 0.13, g.h - g.R - g.ground, 8, [0.88, 0.88, 0.86]);
    }

    // windsock pole
    const s = this.sock;
    gb.cylinder(s.x, s.base, s.z, 0.07, 6, 8, [0.9, 0.9, 0.88], 0.05);

    this._addHelipad(gb);

    this.staticGeo = gb.toGeometry();
    this.staticTriangles = gb.faces.length;
  }

  _addTreeMesh(gb, t, rng) {
    const trunk = [0.33, 0.25, 0.18];

    if (t.conifer) {
      const g0 = lerpNum(0.13, 0.2, t.tint);
      const dark = [g0 * 0.9, g0 * 1.75 + 0.03, g0 * 0.95];
      const light = [dark[0] * 1.12, dark[1] * 1.12, dark[2] * 1.12];
      gb.cylinder(t.x, t.base, t.z, 0.28, t.h * 0.35, 6, trunk, 0.18, false);
      gb.cone(t.x, t.base + t.h * 0.18, t.z, t.r, t.h * 0.58, 8, dark);
      gb.cone(t.x, t.base + t.h * 0.45, t.z, t.r * 0.72, t.h * 0.55, 8, light);
    } else {
      const leaf = [lerpNum(0.24, 0.36, t.tint), lerpNum(0.4, 0.5, t.tint), lerpNum(0.16, 0.22, t.tint)];
      gb.cylinder(t.x, t.base, t.z, 0.3, t.h * 0.5, 6, trunk, 0.2, false);
      gb.blob(t.x, t.base + t.h * 0.62, t.z, t.r, t.r * 0.85, t.r, leaf, rng, 0.16);
      if (t.second) {
        gb.blob(
          t.x + (rng() - 0.5) * t.r * 0.8, t.base + t.h * 0.82, t.z + (rng() - 0.5) * t.r * 0.8,
          t.r * 0.62, t.r * 0.55, t.r * 0.62, leaf, rng, 0.18
        );
      }
    }
  }

  // Small dark box on a wall (windows, doors), in the
  // building's local frame: lx across, lz along, y up.
  _wallBox(gb, b, lx, y0, lz, w, h, d, c) {
    const cs = Math.cos(b.rot);
    const sn = Math.sin(b.rot);
    gb.box(b.x + lx * cs + lz * sn, y0, b.z - lx * sn + lz * cs, w, h, d, c, b.rot);
  }

  _addBuildingMesh(gb, b, rng) {
    const glass = [0.2, 0.25, 0.3];

    if (b.kind === 'house') {
      gb.box(b.x, b.base, b.z, b.w, b.wallH, b.d, b.wall, b.rot);
      gb.roof(b.x, b.base + b.wallH, b.z, b.w + 0.8, b.d + 0.6, b.roofH, b.roof, b.wall, b.rot);

      const floors = b.wallH > 4 ? [0.22, 0.62] : [0.38];
      const perSide = Math.max(1, Math.floor(b.d / 3.4));
      for (const f of floors) {
        const y = b.base + b.wallH * f;
        for (let k = 0; k < perSide; k++) {
          const lz = -b.d / 2 + (k + 0.5) * (b.d / perSide);
          this._wallBox(gb, b, b.w / 2, y, lz, 0.12, 1.15, 1.0, glass);
          this._wallBox(gb, b, -b.w / 2, y, lz, 0.12, 1.15, 1.0, glass);
        }
        this._wallBox(gb, b, 0, y, b.d / 2, 1.0, 1.15, 0.12, glass);
      }
      this._wallBox(gb, b, b.w / 2, b.base, 0, 0.14, 2.1, 1.0, [0.3, 0.2, 0.14]);

      if (b.chimney) {
        this._wallBox(gb, b, b.w * 0.2, b.base + b.wallH + b.roofH * 0.3, b.d * 0.25, 0.7, b.roofH * 0.9, 0.7, [0.45, 0.32, 0.28]);
      }
    } else if (b.kind === 'block') {
      const concrete = [0.78, 0.77, 0.74];
      gb.box(b.x, b.base, b.z, b.w, b.h, b.d, concrete, b.rot);
      gb.box(b.x, b.base + b.h, b.z, b.w + 0.3, 0.6, b.d + 0.3, [0.66, 0.66, 0.64], b.rot);

      for (let y = b.base + 1.1; y < b.base + b.h - 1.5; y += 3.2) {
        this._wallBox(gb, b, b.w / 2, y, 0, 0.12, 1.4, b.d - 1.6, glass);
        this._wallBox(gb, b, -b.w / 2, y, 0, 0.12, 1.4, b.d - 1.6, glass);
        this._wallBox(gb, b, 0, y, b.d / 2, b.w - 1.6, 1.4, 0.12, glass);
        this._wallBox(gb, b, 0, y, -b.d / 2, b.w - 1.6, 1.4, 0.12, glass);
      }
      this._wallBox(gb, b, b.w * 0.2, b.base + b.h + 0.6, -b.d * 0.2, 2.2, 1.3, 1.6, [0.55, 0.56, 0.58]);
    } else if (b.kind === 'church') {
      const stone = [0.86, 0.84, 0.79];
      const slate = [0.3, 0.32, 0.36];
      gb.box(b.x, b.base, b.z, 10, 7, 18, stone, b.rot);
      gb.roof(b.x, b.base + 7, b.z, 10.8, 18.6, 5, slate, stone, b.rot);
      for (let k = -2; k <= 2; k++) {
        this._wallBox(gb, b, 5, b.base + 2.2, k * 3.2, 0.12, 3, 1.1, glass);
        this._wallBox(gb, b, -5, b.base + 2.2, k * 3.2, 0.12, 3, 1.1, glass);
      }
      this._wallBox(gb, b, 0, b.base, -11, 4.4, 18, 4.4, stone);
      const cs = Math.cos(b.rot);
      const sn = Math.sin(b.rot);
      gb.cone(b.x - 11 * sn, b.base + 18, b.z - 11 * cs, 3.1, 7, 4, slate);
    } else if (b.kind === 'watertower') {
      const steel = [0.62, 0.66, 0.7];
      for (const [ox, oz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
        gb.cylinder(b.x + ox, b.base, b.z + oz, 0.35, 21.5, 6, steel);
      }
      gb.cylinder(b.x, b.base + 21, b.z, 4.6, 7, 20, [0.8, 0.84, 0.88]);
      gb.cylinder(b.x, b.base + 28, b.z, 4.8, 0.25, 20, [0.5, 0.52, 0.56]);
      gb.cylinder(b.x, b.base + 28.2, b.z, 0.5, 0.8, 8, steel);
    } else if (b.kind === 'barn') {
      gb.box(b.x, b.base, b.z, 12, 5.5, 16, [0.62, 0.2, 0.15], b.rot);
      gb.roof(b.x, b.base + 5.5, b.z, 13, 16.8, 4, [0.3, 0.3, 0.32], [0.62, 0.2, 0.15], b.rot);
      this._wallBox(gb, b, 0, b.base, 8, 4, 4, 0.15, [0.92, 0.9, 0.85]);
    } else if (b.kind === 'silo') {
      gb.cylinder(b.x, b.base, b.z, 3.1, 15, 16, [0.82, 0.83, 0.84]);
      gb.blob(b.x, b.base + 15, b.z, 3.15, 2.5, 3.15, [0.62, 0.64, 0.66], rng, 0);
    } else if (b.kind === 'car') {
      this._wallBox(gb, b, 0, b.base + 0.18, 0, 1.75, 0.2, 4.2, [0.1, 0.1, 0.1]);
      this._wallBox(gb, b, 0, b.base + 0.35, 0, 1.8, 0.7, 4.3, b.color);
      this._wallBox(gb, b, 0, b.base + 1.05, 0.2, 1.6, 0.6, 2.3, [b.color[0] * 0.8, b.color[1] * 0.8, b.color[2] * 0.8]);
      this._wallBox(gb, b, 0, b.base + 1.08, 0.2, 1.64, 0.45, 2.0, glass);
    } else if (b.kind === 'tent') {
      const leg = [0.75, 0.75, 0.75];
      for (const [ox, oz] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) {
        gb.box(b.x + ox, b.base, b.z + oz, 0.06, 2.2, 0.06, leg);
      }
      const top = b.base + 2.2;
      const tentBlue = [0.15, 0.36, 0.68];
      const c = [b.x, top + 0.2, b.z];
      const corners = [[b.x - 1.6, top, b.z - 1.6], [b.x + 1.6, top, b.z - 1.6], [b.x + 1.6, top, b.z + 1.6], [b.x - 1.6, top, b.z + 1.6]];
      const apex = [b.x, top + 0.9, b.z];
      for (let k = 0; k < 4; k++) gb.poly([corners[k], corners[(k + 1) % 4], apex], tentBlue, c);
      gb.box(b.x, b.base, b.z, 1.6, 0.75, 0.7, [0.85, 0.85, 0.82]);
    }
  }

  _addHelipad(gb) {
    const base = this.homeBase;
    const top = this.padTop;
    gb.box(HOME.x, base - 0.4, HOME.z, 7, top - base + 0.4, 7, [0.2, 0.21, 0.23]);

    const white = [0.93, 0.93, 0.9];
    gb.box(HOME.x - 0.9, top, HOME.z, 0.45, 0.012, 2.8, white);
    gb.box(HOME.x + 0.9, top, HOME.z, 0.45, 0.012, 2.8, white);
    gb.box(HOME.x, top, HOME.z, 1.4, 0.012, 0.45, white);
    gb.ring(HOME.x, top + 0.012, HOME.z, 2.6, 2.85, 40, [0.95, 0.78, 0.15]);

    // traffic cones mark the take-off area
    for (const [ox, oz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) {
      const h = this.heightAt(HOME.x + ox, HOME.z + oz);
      gb.cone(HOME.x + ox, h, HOME.z + oz, 0.17, 0.5, 8, [1, 0.45, 0.08], false);
    }
  }

  _buildRoadMesh() {
    const gb = new GeoBuilder();
    const { xs, zs, hs, n } = this.road;
    const asphalt = [0.22, 0.23, 0.25];
    const paint = [0.9, 0.88, 0.78];
    const half = 3.1;

    const frame = (i) => {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(n - 1, i + 1);
      let dx = xs[i1] - xs[i0];
      let dz = zs[i1] - zs[i0];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      return { nx: -dz, nz: dx };
    };

    for (let i = 0; i < n; i++) {
      const f = frame(i);
      const y = hs[i] + 0.2;
      const a = gb.vert(xs[i] + f.nx * half, y, zs[i] + f.nz * half, 0, 1, 0, asphalt);
      const b = gb.vert(xs[i] - f.nx * half, y, zs[i] - f.nz * half, 0, 1, 0, asphalt);
      if (i > 0) {
        gb.tri(a - 2, b - 2, a);
        gb.tri(b - 2, b, a);
      }
    }

    // dashed centre line
    for (let i = 0; i < n - 1; i += 2) {
      const f0 = frame(i);
      const f1 = frame(i + 1);
      const y0 = hs[i] + 0.23;
      const y1 = hs[i + 1] + 0.23;
      const w = 0.08;
      gb.poly([
        [xs[i] + f0.nx * w, y0, zs[i] + f0.nz * w],
        [xs[i + 1] + f1.nx * w, y1, zs[i + 1] + f1.nz * w],
        [xs[i + 1] - f1.nx * w, y1, zs[i + 1] - f1.nz * w],
        [xs[i] - f0.nx * w, y0, zs[i] - f0.nz * w],
      ], paint, [xs[i], y0 - 5, zs[i]]);
    }

    this.roadGeo = gb.toGeometry();
  }

  _buildWaterMesh() {
    const gb = new GeoBuilder();
    const col = [0.09, 0.25, 0.31, 0.9];
    const seg = 72;
    const centre = gb.vert(LAKE.x, this.waterLevel, LAKE.z, 0, 1, 0, col);
    const ring = gb.vertexCount;

    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * FULL_TURN;
      const R = this.lakeRadius(a) * 1.75;
      gb.vert(LAKE.x + Math.cos(a) * R, this.waterLevel, LAKE.z + Math.sin(a) * R, 0, 1, 0, col);
    }
    for (let i = 0; i < seg; i++) gb.tri(centre, ring + i, ring + i + 1);

    this.waterGeo = gb.toGeometry();
  }

  // Windsock: a striped cone along +Z (drawn with model()).
  _buildWindsockMesh() {
    const gb = new GeoBuilder();
    const seg = 12;
    const bands = 4;
    const sockLength = 1.8;

    for (let k = 0; k < bands; k++) {
      const z0 = (k / bands) * sockLength;
      const z1 = ((k + 1) / bands) * sockLength;
      const r0 = 0.32 - 0.16 * (k / bands);
      const r1 = 0.32 - 0.16 * ((k + 1) / bands);
      const c = k % 2 === 0 ? [1, 0.45, 0.08] : [0.95, 0.95, 0.93];
      const base = gb.vertexCount;

      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * FULL_TURN;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        gb.vert(ca * r0, sa * r0, z0, ca, sa, 0.1, c);
        gb.vert(ca * r1, sa * r1, z1, ca, sa, 0.1, c);
      }
      for (let i = 0; i < seg; i++) {
        const q = base + i * 2;
        gb.tri(q, q + 2, q + 1);
        gb.tri(q + 1, q + 2, q + 3);
      }
    }

    this.sockGeo = gb.toGeometry();
  }


  // =====================================================
  // SKY AND CLOUDS
  // =====================================================

  _buildSky() {
    const gb = new GeoBuilder();
    const lat = 18;
    const lon = 36;
    const toSun = [-SUN_DIR.x, SUN_DIR.y, -SUN_DIR.z]; // y-up direction to the sun

    for (let i = 0; i <= lat; i++) {
      const el = lerpNum(-Math.PI / 2, Math.PI / 2, i / lat);
      for (let j = 0; j <= lon; j++) {
        const az = (j / lon) * FULL_TURN;
        const x = Math.cos(el) * Math.cos(az);
        const y = Math.sin(el);
        const z = Math.cos(el) * Math.sin(az);

        let c;
        if (y >= 0) {
          const t = Math.pow(1 - y, 2.4);
          c = [0, 1, 2].map((k) => lerpNum(SKY.zenith[k], SKY.horizon[k], t));
        } else {
          const t = smoothstep01(0, -0.2, y);
          c = [0, 1, 2].map((k) => lerpNum(SKY.horizon[k], SKY.ground[k], t));
        }

        const sd = Math.max(0, x * toSun[0] + y * toSun[1] + z * toSun[2]);
        const glow = Math.pow(sd, 6) * 0.22;
        gb.vert(x, y, z, 0, 0, 0, [
          Math.min(1, c[0] + glow), Math.min(1, c[1] + glow * 0.86), Math.min(1, c[2] + glow * 0.62),
        ]);
      }
    }

    for (let i = 0; i < lat; i++) {
      for (let j = 0; j < lon; j++) {
        const a = i * (lon + 1) + j;
        const b = a + 1;
        const c = a + lon + 1;
        const d = c + 1;
        gb.tri(a, c, b);
        gb.tri(b, c, d);
      }
    }

    this.skyGeo = gb.toGeometry();
  }

  _buildClouds() {
    const rng = makeRng(WORLD_SEED + 21);
    this.clouds = [];

    for (let i = 0; i < 30; i++) {
      const c = {
        x: (rng() * 2 - 1) * 1700,
        z: (rng() * 2 - 1) * 1700,
        h: this.homeBase + 330 + rng() * 160,
        puffs: [],
      };
      const count = 6 + Math.floor(rng() * 5);
      const spread = 70 + rng() * 60;
      for (let k = 0; k < count; k++) {
        c.puffs.push({
          ox: (rng() * 2 - 1) * spread,
          oy: (rng() * 2 - 1) * 14 + (k % 3) * 6,
          oz: (rng() * 2 - 1) * spread * 0.6,
          s: 110 + rng() * 110,
          v: Math.floor(rng() * 3),
        });
      }
      this.clouds.push(c);
    }
  }


  // =====================================================
  // MINIMAP IMAGE (drawn once)
  // =====================================================

  _buildMinimap() {
    const size = 400;
    const extent = 680;
    const mpp = (extent * 2) / size;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const N = this.N;
    const C = this.terrainColors;

    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const x = -extent + (px + 0.5) * mpp;
        const z = -extent + (py + 0.5) * mpp;

        this._cell(x);
        const i = this._ci;
        const u = this._ct;
        this._cell(z);
        const j = this._ci;
        const v = this._ct;
        const k00 = (j * N + i) * 3;
        const k10 = k00 + 3;
        const k01 = k00 + N * 3;
        const k11 = k01 + 3;

        const hx = this.heightAt(x + mpp, z) - this.heightAt(x - mpp, z);
        const hz = this.heightAt(x, z + mpp) - this.heightAt(x, z - mpp);
        const shade = clampNum(1 + (-hx * 0.6 - hz * 0.8) / (2 * mpp), 0.6, 1.3);

        const o = (py * size + px) * 4;
        if (this.isOverWater(x, z)) {
          img.data[o] = 64;
          img.data[o + 1] = 122;
          img.data[o + 2] = 150;
        } else {
          for (let c = 0; c < 3; c++) {
            const val = lerpNum(lerpNum(C[k00 + c], C[k10 + c], u), lerpNum(C[k01 + c], C[k11 + c], u), v);
            img.data[o + c] = clampNum(val * shade * 255, 0, 255);
          }
        }
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const toPx = (x, z) => [(x + extent) / mpp, (z + extent) / mpp];

    ctx.fillStyle = 'rgba(20, 45, 25, 0.55)';
    for (const t of this.trees) {
      const [x, y] = toPx(t.x, t.z);
      ctx.beginPath();
      ctx.arc(x, y, 1.1, 0, FULL_TURN);
      ctx.fill();
    }

    ctx.strokeStyle = 'rgba(60, 60, 64, 0.9)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let i = 0; i < this.road.n; i++) {
      const [x, y] = toPx(this.road.xs[i], this.road.zs[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(235, 228, 214, 0.95)';
    for (const b of this.buildings) {
      if (b.kind === 'car') continue;
      const [x, y] = toPx(b.x, b.z);
      const s = Math.max(2, (b.rad * 1.3) / mpp);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-b.rot || 0);
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.restore();
    }

    this.map = { canvas, size, extent, mpp };
  }


  // =====================================================
  // COLLISIONS
  // =====================================================

  _buildSpatialHash() {
    this.hash = new Map();
    const cs = 24;
    for (const s of this.solids) {
      const x0 = Math.floor((s.x - s.reach) / cs);
      const x1 = Math.floor((s.x + s.reach) / cs);
      const z0 = Math.floor((s.z - s.reach) / cs);
      const z1 = Math.floor((s.z + s.reach) / cs);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
          const k = gx * 8191 + gz;
          if (!this.hash.has(k)) this.hash.set(k, []);
          this.hash.get(k).push(s);
        }
      }
    }
  }

  _nearbySolids(x, z) {
    const cs = 24;
    const gx = Math.floor(x / cs);
    const gz = Math.floor(z / cs);
    const out = this._cand;
    out.length = 0;
    const stamp = ++this._queryStamp;

    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const list = this.hash.get((gx + a) * 8191 + (gz + b));
        if (!list) continue;
        for (const s of list) {
          if (s._stamp !== stamp) {
            s._stamp = stamp;
            out.push(s);
          }
        }
      }
    }
    return out;
  }

  // Penetration depth of a sphere into a solid (y-up space).
  // Sets this._nx/_ny/_nz to the push-out direction.
  _penetration(s, x, y, z, rad) {
    const dx = x - s.x;
    const dz = z - s.z;
    if (Math.abs(dx) > s.reach + rad || Math.abs(dz) > s.reach + rad) return 0;

    if (s.type === 'box') {
      // Standing on a flat roof is handled as "ground".
      if (s.landable && y >= s.y1 - 0.02) return 0;

      const lx = dx * s.cos - dz * s.sin;
      const lz = dx * s.sin + dz * s.cos;
      const cx = clampNum(lx, -s.hw, s.hw);
      const cy = clampNum(y, s.y0, s.y1);
      const cz = clampNum(lz, -s.hd, s.hd);
      let ex = lx - cx;
      let ey = y - cy;
      let ez = lz - cz;
      let range = Math.hypot(ex, ey, ez);
      if (range > rad) return 0;

      if (range < 1e-6) {
        const px = s.hw - Math.abs(lx);
        const py = Math.min(y - s.y0, s.y1 - y);
        const pz = s.hd - Math.abs(lz);
        if (px <= py && px <= pz) {
          ex = Math.sign(lx) || 1; ey = 0; ez = 0; range = -px;
        } else if (pz <= py) {
          ex = 0; ey = 0; ez = Math.sign(lz) || 1; range = -pz;
        } else {
          ex = 0; ey = y - s.y0 < s.y1 - y ? -1 : 1; ez = 0; range = -py;
        }
      } else {
        ex /= range;
        ey /= range;
        ez /= range;
      }

      this._nx = ex * s.cos + ez * s.sin;
      this._ny = ey;
      this._nz = -ex * s.sin + ez * s.cos;
      return rad - range;
    }

    if (s.type === 'cyl' || s.type === 'cone') {
      if (s.landable && y >= s.y1 - 0.02) return 0;
      if (y < s.y0 - rad || y > s.y1 + rad) return 0;

      let R = s.r;
      if (s.type === 'cone') R = s.r * clampNum(1 - (y - s.y0) / (s.y1 - s.y0), 0, 1);

      const rh = Math.hypot(dx, dz);
      const cy = clampNum(y, s.y0, s.y1);
      if (rh > R || y < s.y0 || y > s.y1) {
        const k = rh > 1e-6 ? Math.min(rh, R) / rh : 0;
        const ex = dx - dx * k;
        const ey = y - cy;
        const ez = dz - dz * k;
        const range = Math.hypot(ex, ey, ez);
        if (range > rad || range < 1e-6) return 0;
        this._nx = ex / range;
        this._ny = ey / range;
        this._nz = ez / range;
        return rad - range;
      }

      const l = rh || 1;
      this._nx = dx / l;
      this._ny = 0;
      this._nz = dz / l;
      return rad + (R - rh);
    }

    if (s.type === 'ell') {
      const qx = dx / (s.rx + rad);
      const qy = (y - s.y) / (s.ry + rad);
      const qz = dz / (s.rx + rad);
      const q = Math.hypot(qx, qy, qz);
      if (q >= 1) return 0;
      const l = q || 1;
      this._nx = qx / l;
      this._ny = qy / l;
      this._nz = qz / l;
      return (1 - q) * Math.min(s.rx, s.ry);
    }

    if (s.type === 'roof') {
      const lx = dx * s.cos - dz * s.sin;
      const lz = dx * s.sin + dz * s.cos;
      const yr = y - s.y0;
      if (Math.abs(lz) > s.hd + rad || Math.abs(lx) > s.hw + rad) return 0;
      if (yr < -rad || yr > s.h + rad) return 0;

      const sx = Math.sign(lx) || 1;
      const nl = Math.hypot(s.h, s.hw);
      const range = (s.h * Math.abs(lx) + s.hw * yr - s.h * s.hw) / nl;
      if (range > rad) return 0;

      const nlx = (sx * s.h) / nl;
      const nly = s.hw / nl;
      this._nx = nlx * s.cos;
      this._ny = nly;
      this._nz = -nlx * s.sin;
      return rad - range;
    }

    return 0;
  }

  // Sphere vs. world objects. Returns { depth, nx, ny, nz, kind }
  // with a y-up normal, or null when nothing is touched.
  collide(pos, rad) {
    const x = pos.x;
    const y = -pos.y;
    const z = pos.z;
    let best = 0;
    let hit = null;

    for (const s of this._nearbySolids(x, z)) {
      const d = this._penetration(s, x, y, z, rad);
      if (d > best) {
        best = d;
        hit = { kind: s.kind, nx: this._nx, ny: this._ny, nz: this._nz };
      }
    }

    // race gate rings (torus)
    for (const g of this.gates) {
      const dx = x - g.x;
      const dy = y - g.h;
      const dz = z - g.z;
      if (Math.abs(dx) > 6 || Math.abs(dz) > 6 || Math.abs(dy) > 6) continue;
      const axial = dx * g.nx + dz * g.nz;
      const rx = dx - g.nx * axial;
      const rz = dz - g.nz * axial;
      const rho = Math.hypot(rx, dy, rz) || 1e-6;
      const ex = dx - (rx / rho) * g.R;
      const ey = dy - (dy / rho) * g.R;
      const ez = dz - (rz / rho) * g.R;
      const range = Math.hypot(ex, ey, ez) || 1e-6;
      const pen = g.tube + rad - range;
      if (pen > best) {
        best = pen;
        hit = { kind: 'gate', nx: ex / range, ny: ey / range, nz: ez / range };
      }
    }

    // spinning turbine blades
    for (const t of this.turbines) {
      if (Math.hypot(x - t.x, z - t.z) > 40) continue;
      const hub = this.turbineHub(t);
      for (let k = 0; k < 3; k++) {
        const phi = t.angle + (k * FULL_TURN) / 3;
        const bx = Math.sin(phi) * Math.cos(t.yaw);
        const by = Math.cos(phi);
        const bz = -Math.sin(phi) * Math.sin(t.yaw);
        const L = TURBINE.BLADE + 0.6;
        const s = clampNum((x - hub.x) * bx + (y - hub.y) * by + (z - hub.z) * bz, 0, L);
        const ex = x - (hub.x + bx * s);
        const ey = y - (hub.y + by * s);
        const ez = z - (hub.z + bz * s);
        const range = Math.hypot(ex, ey, ez) || 1e-6;
        const pen = rad + 0.8 - range;
        if (pen > best) {
          best = pen;
          hit = { kind: 'turbine', nx: ex / range, ny: ey / range, nz: ez / range };
        }
      }
    }

    if (!hit) return null;
    hit.depth = best;
    return hit;
  }


  // =====================================================
  // UPDATE + DRAW
  // =====================================================

  update(dt, env) {
    this.time += dt;
    const target = Math.atan2(env.windDir.x, env.windDir.z);

    for (const t of this.turbines) {
      t.yaw += wrapAngle(target - t.yaw) * Math.min(1, dt * 0.25);
      t.angle += dt * clampNum(env.baseSpeed / 7, 0.06, 1.6) * 1.15;
    }

    this.sockAngle += wrapAngle(target - this.sockAngle) * Math.min(1, dt * 2.5);
    this.sockLift = approach(this.sockLift, clampNum((env.baseSpeed * 0.75) / 8, 0.06, 1), 1.5, dt);

    for (const c of this.clouds) {
      c.x += env.windDir.x * env.baseSpeed * 0.6 * dt;
      c.z += env.windDir.z * env.baseSpeed * 0.6 * dt;
      if (c.x > 1800) c.x -= 3600;
      if (c.x < -1800) c.x += 3600;
      if (c.z > 1800) c.z -= 3600;
      if (c.z < -1800) c.z += 3600;
    }
  }

  // Billboard rotation so a plane() faces the camera.
  _faceCamera(cam, x, y, z) {
    const dx = cam.eye.x - x;
    const dy = cam.eye.y - y;
    const dz = cam.eye.z - z;
    rotateY(Math.atan2(dx, dz));
    rotateX(Math.atan2(-dy, Math.hypot(dx, dz)));
  }

  drawSky(cam, sh) {
    if (sh) sh.setUniform('uFogDensity', 0);

    push();
    translate(cam.eye.x, cam.eye.y, cam.eye.z);
    scale(3000);
    model(this.skyGeo);
    pop();

    const d = 2600;
    const sx = cam.eye.x - SUN_DIR.x * d;
    const sy = cam.eye.y - SUN_DIR.y * d;
    const sz = cam.eye.z - SUN_DIR.z * d;

    push();
    translate(sx, sy, sz);
    fill(255, 250, 236);
    sphere(30, 16, 10);
    pop();

    if (sh) {
      // warm halo around the sun
      push();
      translate(sx, sy, sz);
      this._faceCamera(cam, sx, sy, sz);
      scale(900);
      sh.setUniform('uColorMul', [1, 0.94, 0.82, 0.55]);
      model(this.discGeo);
      sh.setUniform('uColorMul', [1, 1, 1, 1]);
      pop();
      sh.setUniform('uFogDensity', FOG_DENSITY);
    }
  }


  drawTerrain(sh) {
    if (sh) sh.setUniform('uDetail', 1);
    model(this.terrainGeo);
    if (sh) sh.setUniform('uDetail', 0);
  }

  drawStatic(sh) {
    model(this.staticGeo);
    if (sh) sh.setUniform('uDetail', 0.35);
    model(this.roadGeo);
    if (sh) sh.setUniform('uDetail', 0);
  }

  drawDynamic(race) {
    const t = this.time;

    // ---- race gates ----
    for (const g of this.gates) {
      const isNext = g.index === race.next;
      const isAfter = g.index === (race.next + 1) % this.gates.length;
      const done = race.running && race.passed[g.index];

      push();
      translate(g.x, -g.h, g.z);
      rotateY(g.angle);
      if (isNext) {
        const p = 0.6 + 0.4 * Math.sin(t * 5);
        fill(255, 122, 26);
        emissiveMaterial(230 * p, 95 * p, 15 * p);
      } else if (done) {
        fill(110, 214, 130);
        emissiveMaterial(30, 90, 45);
      } else if (isAfter) {
        fill(240, 165, 95);
        emissiveMaterial(70, 35, 8);
      } else {
        fill(232, 232, 228);
      }
      torus(g.R, g.tube, 28, 8);
      pop();
    }

    // ---- wind turbine rotors ----
    for (const tb of this.turbines) {
      push();
      translate(tb.x, -(tb.base + TURBINE.HEIGHT), tb.z);
      rotateY(tb.yaw);
      fill(236, 238, 240);

      push();
      translate(0, -0.3, 1.2);
      box(2.6, 2.8, 7.5);
      pop();

      translate(0, -0.3, -TURBINE.HUB_OFFSET);
      push();
      rotateX(Math.PI / 2);
      cylinder(1.0, 1.6, 12, 1);
      pop();

      for (let k = 0; k < 3; k++) {
        push();
        rotateZ(tb.angle + (k * FULL_TURN) / 3);
        translate(0, -TURBINE.BLADE / 2 - 0.6, 0);
        box(1.5, TURBINE.BLADE, 0.35);
        pop();
      }
      pop();
    }

    // ---- windsock ----
    push();
    translate(this.sock.x, -(this.sock.base + 5.9), this.sock.z);
    rotateY(this.sockAngle);
    rotateX(-(1 - this.sockLift) * 1.2 + Math.sin(t * 3.1) * 0.04 * this.sockLift);
    model(this.sockGeo);
    pop();

    // ---- helipad edge lights (chasing green) ----
    const lit = Math.floor(t * 4) % 4;
    const corners = [[-3.35, -3.35], [3.35, -3.35], [3.35, 3.35], [-3.35, 3.35]];
    for (let k = 0; k < 4; k++) {
      push();
      translate(HOME.x + corners[k][0], -(this.padTop + 0.07), HOME.z + corners[k][1]);
      fill(60, 220, 110);
      if (k === lit) emissiveMaterial(80, 255, 140);
      else emissiveMaterial(10, 50, 25);
      sphere(0.08, 8, 6);
      pop();
    }
  }

  drawWater(sh) {
    push();
    specularMaterial(255, 250, 240);
    shininess(140);
    if (sh) sh.setUniform('uWater', 1);
    model(this.waterGeo);
    if (sh) sh.setUniform('uWater', 0);
    pop();
  }

  drawClouds(cam, sh) {
    const e = cam.eye;
    const order = this.clouds
      .map((c) => ({ c, d: (c.x - e.x) ** 2 + (c.z - e.z) ** 2 + (c.h + e.y) ** 2 }))
      .sort((a, b) => b.d - a.d);

    for (const { c } of order) {
      for (const p of c.puffs) {
        const x = c.x + p.ox;
        const y = -(c.h + p.oy);
        const z = c.z + p.oz;
        const shade = p.oy < 0 ? 0.88 : 1; // flat grey bellies, bright tops
        push();
        translate(x, y, z);
        this._faceCamera(cam, x, y, z);
        scale(p.s, p.s * 0.7, 1);
        emissiveMaterial(150, 152, 158);
        if (sh) sh.setUniform('uColorMul', [shade, shade, Math.min(1, shade + 0.04), 0.9]);
        model(this.puffGeos[p.v]);
        pop();
      }
    }
    if (sh) sh.setUniform('uColorMul', [1, 1, 1, 1]);
  }

}


// =====================================================
// RACE COURSE — lap timing through the gates
// =====================================================

class RaceCourse {
  constructor(world) {
    this.gates = world.gates;
    this.best = null;
    this.reset();
  }

  reset() {
    this.next = 0;
    this.lapStart = null;
    this.lastLap = null;
    this.awaitingFinish = false;
    this.passed = this.gates.map(() => false);
  }

  get running() {
    return this.lapStart !== null;
  }

  elapsed(now) {
    return this.lapStart === null ? 0 : now - this.lapStart;
  }

  // prev / cur are p5-space positions from the last frame and now.
  check(prev, cur, now) {
    const g = this.gates[this.next];
    const sPrev = (prev.x - g.x) * g.nx + (prev.z - g.z) * g.nz;
    const sCur = (cur.x - g.x) * g.nx + (cur.z - g.z) * g.nz;
    if (!(sPrev < 0 && sCur >= 0)) return null;

    const t = -sPrev / (sCur - sPrev);
    const qx = lerpNum(prev.x, cur.x, t);
    const qy = lerpNum(prev.y, cur.y, t);
    const qz = lerpNum(prev.z, cur.z, t);
    if (Math.hypot(qx - g.x, qy + g.h, qz - g.z) > g.R - g.tube - 0.1) return null;

    const idx = this.next;
    if (idx === 0) {
      let lap = null;
      if (this.lapStart !== null && this.awaitingFinish) {
        lap = now - this.lapStart;
        this.lastLap = lap;
        if (this.best === null || lap < this.best) this.best = lap;
      }
      this.lapStart = now;
      this.awaitingFinish = false;
      this.passed = this.gates.map((_, i) => i === 0);
      this.next = 1;
      return lap !== null
        ? { type: 'lap', time: lap, best: lap === this.best }
        : { type: 'start' };
    }

    this.passed[idx] = true;
    this.next = (idx + 1) % this.gates.length;
    if (this.next === 0) this.awaitingFinish = true;
    return { type: 'gate', index: idx };
  }
}
