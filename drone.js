// =====================================================
//  drone.js — quadcopter physics, flight controller,
//  autopilot (take-off, landing, return home), 3D model,
//  ground shadow and rotor-wash particles.
// =====================================================
//
//  How it flies (like a real drone):
//  sticks -> desired velocity -> desired tilt -> the body
//  tilts (with inertia) -> the thrust vector tilts -> the
//  horizontal part of thrust accelerates the drone, while
//  drag and wind push back.

const DRONE = {
  MASS: 2.6,               // kg (camera drone, ~0.64 m wide)
  THRUST_TO_WEIGHT: 2.5,
  ARM: 0.32,               // centre -> motor (m)
  LEG_HEIGHT: 0.215,       // centre -> bottom of the skids
  RADIUS: 0.36,            // collision sphere
  DRAG_LINEAR: 0.16,
  DRAG_QUAD_H: 0.035,
  DRAG_QUAD_V: 0.09,
  HOVER_RPM: 4800,
  IDLE_RPM: 1500,
  STEP: 1 / 120,           // physics runs at a fixed 120 Hz
};
DRONE.MAX_THRUST = DRONE.MASS * G * DRONE.THRUST_TO_WEIGHT;
DRONE.MAX_RPM = DRONE.HOVER_RPM * Math.sqrt(DRONE.THRUST_TO_WEIGHT);

// vmax m/s, tilt deg, yaw deg/s, climb/descend m/s,
// gain = how hard it chases the stick, wn = attitude stiffness
const FLIGHT_MODES = {
  CINE: { key: 'CINE', label: 'Cine', vmax: 5, tilt: 15, yaw: 45, climb: 2.5, descend: 1.5, gain: 1.3, wn: 7, hold: true },
  NORMAL: { key: 'NORMAL', label: 'Normal', vmax: 10, tilt: 25, yaw: 90, climb: 4, descend: 3, gain: 1.9, wn: 9, hold: true },
  SPORT: { key: 'SPORT', label: 'Sport', vmax: 19, tilt: 38, yaw: 150, climb: 6, descend: 4.5, gain: 2.6, wn: 12, hold: true },
  ATTI: { key: 'ATTI', label: 'Attitude', vmax: 0, tilt: 30, yaw: 110, climb: 4, descend: 3, gain: 0, wn: 9, hold: false },
};
const MODE_ORDER = ['CINE', 'NORMAL', 'SPORT', 'ATTI'];

// Motor layout (X frame): 0 front-left, 1 front-right, 2 rear-left, 3 rear-right
const MOTORS = [[-0.226, -0.226], [0.226, -0.226], [-0.226, 0.226], [0.226, 0.226]];

// The drone's silhouette lying flat (y = 0), used as its ground
// shadow. Darkness is baked into the vertex alpha.
function makeShadowGeometry() {
  const gb = new GeoBuilder();
  const flat = (x, z, a) => gb.vert(x, 0, z, 0, 1, 0, [0, 0, 0, a]);
  const fan = (cx, cz, rx, rz, inner, outer) => {
    const c = flat(cx, cz, inner);
    const ring = gb.vertexCount;
    for (let i = 0; i <= 20; i++) {
      const t = (i / 20) * FULL_TURN;
      flat(cx + Math.cos(t) * rx, cz + Math.sin(t) * rz, outer);
    }
    for (let i = 0; i < 20; i++) gb.tri(c, ring + i, ring + i + 1);
  };

  for (const [mx, mz] of MOTORS) fan(mx, mz, 0.17, 0.17, 0.42, 0.14); // blurred props

  const L = 0.235;
  const w = 0.018;
  for (const s of [1, -1]) {                                       // carbon arms
    const len = Math.hypot(L, L);
    const nx = (-s * L / len) * w;
    const nz = (L / len) * w;
    const a = flat(-L + nx, -s * L + nz, 0.95);
    const b = flat(L + nx, s * L + nz, 0.95);
    const c = flat(L - nx, s * L - nz, 0.95);
    const e = flat(-L - nx, -s * L - nz, 0.95);
    gb.tri(a, b, c);
    gb.tri(a, c, e);
  }

  fan(0, 0, 0.13, 0.2, 0.95, 0.8);                                 // body
  return gb.toGeometry();
}


class Drone {
  constructor(world) {
    this.world = world;
    this.mode = FLIGHT_MODES.NORMAL;
    this.events = [];
    this.motorRPM = [0, 0, 0, 0];
    this.propAngle = [0, 0.7, 1.4, 2.1];
    this.rng = makeRng(99);
    this.shadowGeo = makeShadowGeometry();
    this.reset();
  }

  reset() {
    const top = this.world.groundHeightAt(HOME.x, HOME.z);
    this.home = { x: HOME.x, z: HOME.z, ground: top };
    this.pos = v3(HOME.x, -(top + DRONE.LEG_HEIGHT), HOME.z);
    this.prevPos = v3(this.pos.x, this.pos.y, this.pos.z);
    this.vel = v3();

    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.yawRate = 0;
    this.pitchRate = 0;
    this.rollRate = 0;
    this.thrust = 0;
    this.thrustCmd = 0;

    this.state = 'DISARMED';
    this.stateTime = 0;
    this.battery = 100;
    this.drainRate = 0.09;

    this.onGround = true;
    this.agl = 0;
    this.groundH = top;
    this.velI = { x: 0, z: 0 };
    this.vzI = 0;
    this.hold = null;
    this.holdTimer = 0;
    this.altHold = null;
    this.rth = null;
    this.crash = null;
    this.sunk = false;
    this.spin = { p: 0, r: 0, y: 0 };
    this.touchTimer = 0;
    this.lastBump = -10;
    this.flags = { low: false, critical: false, alt: false, fence: false };
    this.acc = 0;
    this.time = 0;
    this.motorRPM.fill(0);
  }


  // =====================================================
  // STATE + COMMANDS
  // =====================================================

  setState(s) {
    this.state = s;
    this.stateTime = 0;
  }

  emit(type, data = {}) {
    this.events.push({ type, ...data });
  }

  get airborne() {
    return ['TAKEOFF', 'FLYING', 'LANDING', 'RTH'].includes(this.state);
  }

  get motorsOn() {
    return this.state !== 'DISARMED' && this.state !== 'CRASHED';
  }

  arm() {
    if (this.state !== 'DISARMED' && this.state !== 'LANDED') return;
    if (this.battery < 5) {
      this.emit('noBattery');
      return;
    }
    this.hold = { x: this.pos.x, z: this.pos.z };
    this.setState('ARMING');
    this.emit('arming');
  }

  land() {
    if (['FLYING', 'TAKEOFF', 'RTH'].includes(this.state)) {
      this.rth = null;
      this.hold = { x: this.pos.x, z: this.pos.z };
      this.setState('LANDING');
      this.emit('landing');
    }
  }

  cancelLanding() {
    if (this.state === 'LANDING' && this.battery > 5) {
      this.altHold = null;
      this.setState('FLYING');
      this.emit('resume');
    }
  }

  startRTH(reason = 'user') {
    if (!['FLYING', 'LANDING', 'TAKEOFF'].includes(this.state)) return;
    this.rth = { phase: 'CLIMB', reason };
    this.hold = { x: this.pos.x, z: this.pos.z };
    this.setState('RTH');
    this.emit('rth', { reason });
  }

  cancelRTH() {
    if (this.state !== 'RTH') return;
    this.rth = null;
    this.altHold = null;
    this.hold = null;
    this.setState('FLYING');
    this.emit('rthCancel');
  }


  // =====================================================
  // TELEMETRY
  // =====================================================

  get speed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  get vSpeed() {
    return -this.vel.y;
  }

  get distHome() {
    return Math.hypot(this.pos.x - HOME.x, this.pos.z - HOME.z);
  }

  // Compass heading in degrees, 0 = north, 90 = east.
  get heading() {
    return (((-this.yaw / DEG) % 360) + 360) % 360;
  }

  // Height above the take-off point (what drone apps show as "H").
  get altitude() {
    return -this.pos.y - DRONE.LEG_HEIGHT - this.home.ground;
  }

  get remainingSeconds() {
    return this.battery / Math.max(0.01, this.drainRate);
  }


  // =====================================================
  // BODY AXES (derived from yaw -> pitch -> roll)
  // =====================================================

  bodyUp() {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    const sr = Math.sin(this.roll), cr = Math.cos(this.roll);
    return v3(sr * cy - cr * sp * sy, -cr * cp, -sr * sy - cr * sp * cy);
  }

  bodyForward() {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    return v3(-cp * sy, sp, -cp * cy);
  }

  bodyRight() {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    const sr = Math.sin(this.roll), cr = Math.cos(this.roll);
    return v3(cr * cy + sr * sp * sy, sr * cp, -cr * sy + sr * sp * cy);
  }


  // =====================================================
  // UPDATE (fixed-step physics)
  // =====================================================

  update(dt, sticks, env) {
    this.prevPos = v3(this.pos.x, this.pos.y, this.pos.z);
    this.acc += Math.min(dt, 0.1);

    while (this.acc >= DRONE.STEP) {
      this.step(DRONE.STEP, sticks, env);
      this.acc -= DRONE.STEP;
    }

    for (let i = 0; i < 4; i++) {
      const dir = i === 0 || i === 3 ? 1 : -1;
      this.propAngle[i] += (this.motorRPM[i] / 60) * FULL_TURN * dt * dir;
    }
  }

  step(dt, sticks, env) {
    this.time += dt;
    this.stateTime += dt;

    if (this.state === 'CRASHED') {
      this.stepCrashed(dt);
      return;
    }

    const gH = this.world.groundHeightAt(this.pos.x, this.pos.z);
    this.groundH = gH;
    this.agl = -this.pos.y - DRONE.LEG_HEIGHT - gH;

    let cmd;
    switch (this.state) {
      case 'DISARMED':
        this.stepGrounded(dt, 0);
        return;

      case 'ARMING':
        if (this.stateTime > 1.3) {
          this.altHold = null;
          this.setState('TAKEOFF');
          this.emit('takeoff');
        }
        this.stepGrounded(dt, DRONE.IDLE_RPM + this.stateTime * 300);
        return;

      case 'LANDED':
        if (this.stateTime > 1.2) {
          this.setState('DISARMED');
          this.emit('disarmed');
        }
        this.stepGrounded(dt, DRONE.IDLE_RPM * clampNum(1 - this.stateTime / 1.2, 0, 1));
        return;

      case 'TAKEOFF':
        cmd = this.takeoffCommand();
        break;
      case 'LANDING':
        cmd = this.landingCommand(sticks);
        break;
      case 'RTH':
        cmd = this.rthCommand();
        break;
      default:
        cmd = this.pilotCommand(sticks, this.mode, dt);
    }

    this.flightControl(dt, cmd, env);
    this.integrate(dt, env);
    this.handleContacts(dt, sticks);
    this.drainBattery(dt);
  }

  stepGrounded(dt, rpm) {
    const gH = this.world.groundHeightAt(this.pos.x, this.pos.z);
    this.pos.y = -(gH + DRONE.LEG_HEIGHT);
    this.vel.x = 0;
    this.vel.y = 0;
    this.vel.z = 0;
    this.pitch = approach(this.pitch, 0, 8, dt);
    this.roll = approach(this.roll, 0, 8, dt);
    this.pitchRate = 0;
    this.rollRate = 0;
    this.yawRate = 0;
    this.thrust = 0;
    this.vzI = 0;
    this.velI.x = 0;
    this.velI.z = 0;
    this.onGround = true;
    this.agl = 0;
    for (let i = 0; i < 4; i++) this.motorRPM[i] = approach(this.motorRPM[i], rpm, 6, dt);
    if (rpm > 0) this.drainBattery(dt);
  }


  // =====================================================
  // COMMANDS: what should the flight controller aim for?
  // { vx, vz } desired ground velocity, vUp climb rate,
  // yawRate, or attitude {pitch, roll} in Attitude mode.
  // =====================================================

  _flatAxes() {
    return {
      fx: -Math.sin(this.yaw), fz: -Math.cos(this.yaw),
      rx: Math.cos(this.yaw), rz: -Math.sin(this.yaw),
    };
  }

  takeoffCommand() {
    const target = 2.5;
    const vUp = clampNum((target - this.agl) * 1.6, -1, 1.8);

    if ((Math.abs(this.agl - target) < 0.15 && Math.abs(this.vel.y) < 0.3) || this.stateTime > 7) {
      this.setState('FLYING');
      this.emit('hovering');
      this.altHold = -this.pos.y;
      this.hold = { x: this.pos.x, z: this.pos.z };
    }

    return {
      vx: clampNum(this.hold.x - this.pos.x, -1, 1),
      vz: clampNum(this.hold.z - this.pos.z, -1, 1),
      vUp, yawRate: 0, attitude: null,
    };
  }

  pilotCommand(s, mode, dt) {
    const a = this._flatAxes();
    const cmd = { vx: 0, vz: 0, vUp: 0, yawRate: -s.yaw * mode.yaw * DEG, attitude: null };

    // ---- vertical: stick = climb rate, centred = hold altitude ----
    if (Math.abs(s.throttle) > 0.04) {
      cmd.vUp = s.throttle > 0 ? s.throttle * mode.climb : s.throttle * mode.descend;
      this.altHold = null;
    } else {
      if (this.altHold === null && Math.abs(this.vel.y) < 0.5) this.altHold = -this.pos.y;
      cmd.vUp = this.altHold === null ? 0 : clampNum((this.altHold + this.pos.y) * 1.5, -2, 2);
    }

    // ---- legal altitude limit above the ground below you ----
    if (this.agl > ALTITUDE_LIMIT - 1 && cmd.vUp > 0) {
      cmd.vUp = Math.min(cmd.vUp, (ALTITUDE_LIMIT - this.agl) * 1.2);
      if (!this.flags.alt) {
        this.flags.alt = true;
        this.emit('altLimit');
      }
    } else if (this.agl < ALTITUDE_LIMIT - 10) {
      this.flags.alt = false;
    }

    // ---- horizontal ----
    let sp = s.pitch;
    let sr = s.roll;
    const stickMag = Math.hypot(sp, sr);
    if (stickMag > 1) {
      sp /= stickMag;
      sr /= stickMag;
    }

    if (mode.hold) {
      const centred = Math.abs(sp) < 0.04 && Math.abs(sr) < 0.04;
      if (centred) {
        this.holdTimer += dt;
        if (!this.hold && this.holdTimer > 0.15 && this.speed < 1.2) {
          this.hold = { x: this.pos.x, z: this.pos.z };
        }
      } else {
        this.holdTimer = 0;
        this.hold = null;
      }

      if (this.hold) {
        // GPS position hold: lean into the wind, stay put
        cmd.vx = clampNum(this.hold.x - this.pos.x, -2.5, 2.5);
        cmd.vz = clampNum(this.hold.z - this.pos.z, -2.5, 2.5);
      } else {
        cmd.vx = (a.fx * sp + a.rx * sr) * mode.vmax;
        cmd.vz = (a.fz * sp + a.rz * sr) * mode.vmax;
      }
    } else {
      // Attitude mode: sticks set the tilt directly, nothing
      // stops the drift except drag. Real pilots train in this.
      cmd.attitude = { pitch: sp * mode.tilt * DEG, roll: sr * mode.tilt * DEG };
    }

    this.applyGeofence(cmd);
    return cmd;
  }

  applyGeofence(cmd) {
    const dx = this.pos.x - HOME.x;
    const dz = this.pos.z - HOME.z;
    const d = Math.hypot(dx, dz);

    if (d > GEOFENCE_RADIUS - 25) {
      const nx = dx / d;
      const nz = dz / d;

      if (cmd.attitude && d > GEOFENCE_RADIUS) {
        cmd.attitude = null;
        cmd.vx = 0;
        cmd.vz = 0;
      }
      if (!cmd.attitude) {
        const outward = cmd.vx * nx + cmd.vz * nz;
        if (outward > 0) {
          const k = clampNum((GEOFENCE_RADIUS - d) / 25, 0, 1);
          cmd.vx -= nx * outward * (1 - k);
          cmd.vz -= nz * outward * (1 - k);
        }
        if (d > GEOFENCE_RADIUS) {
          cmd.vx -= nx * (d - GEOFENCE_RADIUS) * 0.6;
          cmd.vz -= nz * (d - GEOFENCE_RADIUS) * 0.6;
        }
      }
      if (!this.flags.fence) {
        this.flags.fence = true;
        this.emit('geofence');
      }
    } else if (d < GEOFENCE_RADIUS - 60) {
      this.flags.fence = false;
    }
  }

  landingCommand(s) {
    if (!this.hold) this.hold = { x: this.pos.x, z: this.pos.z };

    // small corrections are allowed while landing
    const a = this._flatAxes();
    if (Math.abs(s.pitch) > 0.1 || Math.abs(s.roll) > 0.1) {
      this.hold.x += (a.fx * s.pitch + a.rx * s.roll) * 1.5 * DRONE.STEP;
      this.hold.z += (a.fz * s.pitch + a.rz * s.roll) * 1.5 * DRONE.STEP;
    }

    return {
      vx: clampNum(this.hold.x - this.pos.x, -2, 2),
      vz: clampNum(this.hold.z - this.pos.z, -2, 2),
      vUp: -clampNum(this.agl * 0.45 + 0.35, 0.45, 2.8),
      yawRate: -s.yaw * 40 * DEG,
      attitude: null,
    };
  }

  rthCommand() {
    const r = this.rth;
    const alt = -this.pos.y;
    const dx = HOME.x - this.pos.x;
    const dz = HOME.z - this.pos.z;
    const range = Math.hypot(dx, dz);
    if (r.targetAlt === undefined) r.targetAlt = Math.max(alt, this.home.ground + 35);

    const safeAlt = Math.max(r.targetAlt, this.groundH + 18);
    const faceHome = Math.atan2(-dx, -dz);
    const yawErr = wrapAngle(faceHome - this.yaw);
    const cmd = { vx: 0, vz: 0, vUp: 0, yawRate: 0, attitude: null };

    if (r.phase === 'CLIMB') {
      cmd.vUp = clampNum((safeAlt - alt) * 1.2, -2, 4);
      cmd.yawRate = clampNum(yawErr * 1.5, -1.5, 1.5);
      cmd.vx = clampNum(this.hold.x - this.pos.x, -2, 2);
      cmd.vz = clampNum(this.hold.z - this.pos.z, -2, 2);
      if (alt > safeAlt - 1.5) r.phase = 'RETURN';
    } else if (r.phase === 'RETURN') {
      cmd.yawRate = clampNum(yawErr * 1.5, -1.5, 1.5);
      const speed = Math.min(12, range * 0.45) * (Math.abs(yawErr) < 0.6 ? 1 : 0.3);
      cmd.vx = (dx / (range || 1)) * speed;
      cmd.vz = (dz / (range || 1)) * speed;
      cmd.vUp = clampNum((safeAlt - alt) * 1.0, -3, 3);
      if (range < 2) r.phase = 'DESCEND';
    } else {
      cmd.vx = clampNum((HOME.x - this.pos.x) * 1.2, -1.5, 1.5);
      cmd.vz = clampNum((HOME.z - this.pos.z) * 1.2, -1.5, 1.5);
      cmd.vUp = -clampNum(this.agl * 0.4 + 0.5, 0.5, 3.5);
      if (this.agl < 4) {
        this.rth = null;
        this.hold = { x: HOME.x, z: HOME.z };
        this.setState('LANDING');
        this.emit('landing');
      }
    }

    return cmd;
  }


  // =====================================================
  // FLIGHT CONTROLLER + BODY DYNAMICS
  // =====================================================

  flightControl(dt, cmd, env) {
    const mode = this.mode;

    // ---- yaw ----
    this.yawRate = approach(this.yawRate, cmd.yawRate, 6, dt);
    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);

    // ---- horizontal: velocity error -> acceleration -> tilt ----
    const manual = this.state === 'FLYING';
    const tiltMax = (manual ? mode.tilt : 22) * DEG;
    let pitchT;
    let rollT;

    if (cmd.attitude) {
      pitchT = cmd.attitude.pitch;
      rollT = cmd.attitude.roll;
      this.velI.x = 0;
      this.velI.z = 0;
    } else {
      const gain = manual ? Math.max(mode.gain, 1.5) : 1.8;
      const ex = cmd.vx - this.vel.x;
      const ez = cmd.vz - this.vel.z;
      this.velI.x = clampNum(this.velI.x + ex * dt, -6, 6);
      this.velI.z = clampNum(this.velI.z + ez * dt, -6, 6);

      let ax = ex * gain + this.velI.x * 0.55;
      let az = ez * gain + this.velI.z * 0.55;
      const aMax = G * Math.tan(tiltMax);
      const aMag = Math.hypot(ax, az);
      if (aMag > aMax) {
        ax *= aMax / aMag;
        az *= aMax / aMag;
      }

      const a = this._flatAxes();
      const aF = ax * a.fx + az * a.fz;
      const aR = ax * a.rx + az * a.rz;
      pitchT = Math.atan2(aF, G);
      rollT = Math.atan2(aR * Math.cos(pitchT), G);
    }
    pitchT = clampNum(pitchT, -tiltMax, tiltMax);
    rollT = clampNum(rollT, -tiltMax, tiltMax);

    // ---- attitude: 2nd-order response (inertia + controller) ----
    const wn = mode.wn;
    const zeta = 0.72;
    const n = this.world.noise;
    const gustP = n.get(this.time * 2.7, 11.3) * env.turbulence * 9;
    const gustR = n.get(this.time * 2.9, -7.1) * env.turbulence * 9;

    this.pitchRate += (wn * wn * (pitchT - this.pitch) - 2 * zeta * wn * this.pitchRate + gustP) * dt;
    this.rollRate += (wn * wn * (rollT - this.roll) - 2 * zeta * wn * this.rollRate + gustR) * dt;
    this.pitch += this.pitchRate * dt;
    this.roll += this.rollRate * dt;

    // ---- vertical speed -> total thrust ----
    const vUp = -this.vel.y;
    const ev = cmd.vUp - vUp;
    this.vzI = clampNum(this.vzI + ev * dt, -4, 4);
    const aUp = ev * 3.2 + this.vzI * 1.3;
    const tilt = Math.max(0.45, Math.cos(this.pitch) * Math.cos(this.roll));
    this.thrustCmd = clampNum((DRONE.MASS * (G + aUp)) / tilt, 0, DRONE.MAX_THRUST);
    this.thrust = approach(this.thrust, this.thrustCmd, 16, dt); // motor spool-up lag

    // ---- individual motor speeds (sound + props) ----
    const base = DRONE.HOVER_RPM * Math.sqrt(Math.max(0.02, this.thrust / (DRONE.MASS * G)));
    const P = (pitchT - this.pitch) * 900;
    const R = (rollT - this.roll) * 900;
    const Y = (cmd.yawRate - this.yawRate) * 120;
    const rpmCap = DRONE.MAX_RPM * 1.05;
    this.motorRPM[0] = clampNum(base - P + R + Y, 0, rpmCap);
    this.motorRPM[1] = clampNum(base - P - R - Y, 0, rpmCap);
    this.motorRPM[2] = clampNum(base + P + R - Y, 0, rpmCap);
    this.motorRPM[3] = clampNum(base + P - R + Y, 0, rpmCap);
  }

  integrate(dt, env) {
    const U = this.bodyUp();

    // ground effect: a cushion of air right above the ground
    let ge = 1;
    if (this.agl < 2) ge = 1 + 0.16 / (1 + Math.pow(Math.max(this.agl, 0) / 0.35, 2));

    const T = this.thrust * ge;
    const m = DRONE.MASS;
    const rx = this.vel.x - env.wind.x;
    const ry = this.vel.y - env.wind.y;
    const rz = this.vel.z - env.wind.z;
    const rh = Math.hypot(rx, rz);

    const fx = T * U.x - DRONE.DRAG_LINEAR * rx - DRONE.DRAG_QUAD_H * rh * rx;
    const fz = T * U.z - DRONE.DRAG_LINEAR * rz - DRONE.DRAG_QUAD_H * rh * rz;
    const fy = T * U.y + m * G - DRONE.DRAG_LINEAR * ry - DRONE.DRAG_QUAD_V * Math.abs(ry) * ry;

    this.vel.x += (fx / m) * dt;
    this.vel.y += (fy / m) * dt;
    this.vel.z += (fz / m) * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
  }


  // =====================================================
  // CONTACTS: ground, water, trees, buildings...
  // =====================================================

  handleContacts(dt, sticks) {
    const w = this.world;
    const gH = w.groundHeightAt(this.pos.x, this.pos.z);
    const bottom = -this.pos.y - DRONE.LEG_HEIGHT;
    this.onGround = false;

    if (w.isOverWater(this.pos.x, this.pos.z) && bottom < w.waterLevel) {
      this.doCrash('water');
      return;
    }

    if (bottom <= gH) {
      const vDown = this.vel.y;
      const tilt = Math.acos(clampNum(Math.cos(this.pitch) * Math.cos(this.roll), -1, 1));
      if (vDown > 3.5 || this.speed > 5.5 || tilt > 0.75) {
        this.doCrash('ground');
        return;
      }

      this.pos.y = -(gH + DRONE.LEG_HEIGHT);
      if (this.vel.y > 0) this.vel.y = 0;
      const f = Math.exp(-6 * dt);
      this.vel.x *= f;
      this.vel.z *= f;
      this.vzI = Math.max(this.vzI, 0);
      this.onGround = true;
      this.agl = 0;

      if (this.state === 'LANDING') {
        this.setState('LANDED');
        this.emit('landed');
      } else if (this.state === 'FLYING') {
        // holding "descend" on the ground stops the motors
        if (sticks.throttle < -0.5) {
          this.touchTimer += dt;
          if (this.touchTimer > 0.9) {
            this.setState('LANDED');
            this.emit('landed');
          }
        } else {
          this.touchTimer = 0;
        }
      }
    } else {
      this.touchTimer = 0;
    }

    const hit = w.collide(this.pos, DRONE.RADIUS);
    if (hit) {
      const nx = hit.nx;
      const ny = -hit.ny;
      const nz = hit.nz;
      const vn = this.vel.x * nx + this.vel.y * ny + this.vel.z * nz;
      const speed = vLen(this.vel);

      if (-vn > 2.2 || speed > 4.5) {
        this.doCrash(hit.kind, { x: nx, y: ny, z: nz });
        return;
      }

      // gentle touch: slide off it
      this.pos.x += nx * hit.depth;
      this.pos.y += ny * hit.depth;
      this.pos.z += nz * hit.depth;
      if (vn < 0) {
        this.vel.x -= nx * vn * 1.4;
        this.vel.y -= ny * vn * 1.4;
        this.vel.z -= nz * vn * 1.4;
      }
      if (this.time - this.lastBump > 0.5) {
        this.lastBump = this.time;
        this.emit('bump', { kind: hit.kind });
      }
    }
  }

  doCrash(kind, normal = null) {
    if (this.state === 'CRASHED') return;
    const speed = vLen(this.vel);
    this.crash = { kind, speed, time: 0, settled: false, splashed: false };
    this.rth = null;
    this.setState('CRASHED');
    this.thrust = 0;
    this.thrustCmd = 0;
    this.spin = {
      p: (this.rng() - 0.5) * 14,
      r: (this.rng() - 0.5) * 14,
      y: (this.rng() - 0.5) * 6,
    };

    if (normal) {
      const vn = this.vel.x * normal.x + this.vel.y * normal.y + this.vel.z * normal.z;
      if (vn < 0) {
        this.vel.x -= normal.x * vn * 1.35;
        this.vel.y -= normal.y * vn * 1.35;
        this.vel.z -= normal.z * vn * 1.35;
      }
    } else if (kind === 'ground') {
      this.vel.y = -Math.abs(this.vel.y) * 0.3;
    }

    this.emit('crash', { kind, speed });
  }

  stepCrashed(dt) {
    const w = this.world;
    const c = this.crash;
    c.time += dt;
    for (let i = 0; i < 4; i++) this.motorRPM[i] = approach(this.motorRPM[i], 0, 5, dt);
    if (this.sunk) return;

    this.vel.y += G * dt;
    const drag = Math.exp(-0.4 * dt);
    this.vel.x *= drag;
    this.vel.z *= drag;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
    this.pitch += this.spin.p * dt;
    this.roll += this.spin.r * dt;
    this.yaw += this.spin.y * dt;

    // in the lake: it sinks
    if (w.isOverWater(this.pos.x, this.pos.z) && -this.pos.y < w.waterLevel + 0.1) {
      if (!c.splashed) {
        c.splashed = true;
        this.emit('splash');
      }
      const k = Math.exp(-3 * dt);
      this.vel.x *= k;
      this.vel.z *= k;
      this.vel.y = Math.min(this.vel.y, 0.35);
      this.spin.p *= k;
      this.spin.r *= k;
      this.spin.y *= k;
      if (-this.pos.y < w.waterLevel - 1.4) this.sunk = true;
      return;
    }

    // tumbling onto the ground
    const gH = w.groundHeightAt(this.pos.x, this.pos.z);
    if (-this.pos.y - 0.12 < gH) {
      this.pos.y = -(gH + 0.12);
      if (this.vel.y > 1.2) {
        this.vel.y *= -0.3;
        this.vel.x *= 0.55;
        this.vel.z *= 0.55;
        this.spin.p *= 0.5;
        this.spin.r *= 0.5;
        this.spin.y *= 0.5;
        this.emit('thud');
      } else {
        this.vel.y = 0;
        const f = Math.exp(-5 * dt);
        this.vel.x *= f;
        this.vel.z *= f;
        this.spin.p = 0;
        this.spin.r = 0;
        this.spin.y *= Math.exp(-4 * dt);
        this.pitch = approach(this.pitch, Math.round(this.pitch / Math.PI) * Math.PI, 5, dt);
        this.roll = approach(this.roll, Math.round(this.roll / Math.PI) * Math.PI, 5, dt);
        c.settled = true;
      }
    }

    // slide down trees and walls instead of passing through
    const hit = w.collide(this.pos, 0.25);
    if (hit) {
      const ny = -hit.ny;
      this.pos.x += hit.nx * hit.depth;
      this.pos.y += ny * hit.depth;
      this.pos.z += hit.nz * hit.depth;
      const vn = this.vel.x * hit.nx + this.vel.y * ny + this.vel.z * hit.nz;
      if (vn < 0) {
        this.vel.x -= hit.nx * vn * 1.2;
        this.vel.y -= ny * vn * 1.2;
        this.vel.z -= hit.nz * vn * 1.2;
      }
    }
  }

  drainBattery(dt) {
    // rotor power grows with thrust^1.5
    const rate = 0.006 + 0.00072 * Math.pow(this.thrust, 1.5);
    this.drainRate = approach(this.drainRate, rate, 0.5, dt);
    this.battery = Math.max(0, this.battery - rate * dt);

    if (this.battery < 25 && !this.flags.low) {
      this.flags.low = true;
      this.emit('lowBattery');
    }
    if (this.battery < 12 && !this.flags.critical && this.airborne) {
      this.flags.critical = true;
      if (this.distHome > 30 && this.state !== 'RTH' && this.state !== 'LANDING') this.startRTH('battery');
      else if (this.state === 'FLYING') this.land();
    }
    if (this.battery < 3 && (this.state === 'FLYING' || this.state === 'RTH')) {
      this.rth = null;
      this.land();
      this.emit('forcedLanding');
    }
  }


  // =====================================================
  // DRAWING
  // =====================================================

  _applyTransform() {
    translate(this.pos.x, this.pos.y, this.pos.z);
    rotateY(this.yaw);
    rotateX(this.pitch);
    rotateZ(this.roll);
  }

  _led(x, z, c) {
    push();
    translate(x, 0.035, z);
    fill(c[0], c[1], c[2]);
    emissiveMaterial(c[0], c[1], c[2]);
    sphere(0.015, 6, 4);
    pop();
  }

  draw(time) {
    if (this.sunk) return;
    push();
    this._applyTransform();

    // ---- body shell ----
    push();
    fill(236, 238, 240);
    specularMaterial(90);
    shininess(35);
    ellipsoid(0.13, 0.05, 0.2, 18, 10);
    pop();

    push();
    translate(0, 0.035, 0);
    fill(52, 55, 60);
    box(0.17, 0.05, 0.27);
    pop();

    // battery with a hi-vis stripe
    push();
    translate(0, -0.06, 0.02);
    fill(44, 46, 50);
    box(0.095, 0.04, 0.17);
    translate(0, 0, 0.075);
    fill(255, 122, 26);
    box(0.097, 0.042, 0.02);
    pop();

    // obstacle sensors on the nose
    push();
    translate(0, 0, -0.2);
    fill(18, 20, 24);
    box(0.08, 0.025, 0.02);
    pop();

    // ---- carbon arms ----
    fill(36, 37, 41);
    push();
    rotateY(Math.PI / 4);
    box(0.66, 0.022, 0.032);
    pop();
    push();
    rotateY(-Math.PI / 4);
    box(0.66, 0.022, 0.032);
    pop();

    // ---- motors ----
    for (const [mx, mz] of MOTORS) {
      push();
      translate(mx, -0.03, mz);
      fill(64, 66, 72);
      cylinder(0.034, 0.045, 12, 1);
      translate(0, -0.03, 0);
      fill(178, 180, 186);
      specularMaterial(160);
      shininess(60);
      cylinder(0.03, 0.014, 12, 1);
      pop();
    }

    // ---- landing gear ----
    fill(40, 42, 46);
    for (const sx of [-1, 1]) {
      for (const sz of [-0.07, 0.07]) {
        push();
        translate(sx * 0.115, 0.115, sz);
        box(0.012, 0.15, 0.012);
        pop();
      }
      push();
      translate(sx * 0.115, 0.205, 0);
      rotateX(Math.PI / 2);
      cylinder(0.009, 0.36, 8, 1);
      pop();
    }

    // ---- stabilised gimbal camera (stays level) ----
    push();
    translate(0, 0.07, -0.13);
    fill(30, 31, 35);
    box(0.03, 0.03, 0.03);
    translate(0, 0.035, 0);
    rotateZ(-this.roll);
    rotateX(-this.pitch);
    rotateX(8 * DEG);
    fill(46, 48, 53);
    box(0.065, 0.05, 0.06);
    translate(0, 0, -0.035);
    rotateX(Math.PI / 2);
    fill(12, 13, 16);
    specularMaterial(220);
    shininess(90);
    cylinder(0.019, 0.016, 14, 1);
    pop();

    // ---- navigation lights: red left, green right, white strobes ----
    if (this.state !== 'CRASHED') {
      this._led(-0.226, -0.226, [255, 40, 30]);
      this._led(0.226, -0.226, [40, 255, 90]);
      if (time % 1 < 0.08) {
        this._led(-0.226, 0.226, [255, 255, 255]);
        this._led(0.226, 0.226, [255, 255, 255]);
      }
    }

    pop();
  }

  // Props are drawn in the transparent pass: at speed they
  // blur into discs, like on camera.
  drawProps() {
    if (this.sunk) return;
    push();
    this._applyTransform();

    for (let i = 0; i < 4; i++) {
      const [mx, mz] = MOTORS[i];
      const rpm = this.motorRPM[i];
      push();
      translate(mx, -0.072, mz);

      if (rpm < 900) {
        rotateY(this.propAngle[i]);
        fill(28, 29, 32);
        box(0.34, 0.004, 0.026);
      } else {
        const k = clampNum((rpm - 900) / 2500, 0, 1);
        fill(30, 31, 35, 40 + 50 * k);
        cylinder(0.17, 0.003, 28, 1);
        rotateY(this.propAngle[i] * 0.012 + i);
        fill(25, 26, 30, 150 * (1 - k) + 40);
        box(0.34, 0.004, 0.026);
      }
      pop();
    }

    pop();
  }

  // Shadow: follow the sun ray from the drone down to the
  // ground, then lay the silhouette flat on the surface there.
  drawShadow(sh) {
    if (this.sunk) return;
    const w = this.world;
    // the shadow lands on the water surface over the lake
    const surface = (x, z) => (w.isOverWater(x, z) ? w.waterLevel : w.groundHeightAt(x, z));
    const groundAt = (x, z) => -surface(x, z);

    let t = 0;
    let hitT = -1;
    for (let i = 0; i < 90; i++) {
      t += 1.2;
      if (this.pos.y + SUN_DIR.y * t >= groundAt(this.pos.x + SUN_DIR.x * t, this.pos.z + SUN_DIR.z * t)) {
        let lo = t - 1.2;
        let hi = t;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) / 2;
          const below = this.pos.y + SUN_DIR.y * mid >= groundAt(this.pos.x + SUN_DIR.x * mid, this.pos.z + SUN_DIR.z * mid);
          if (below) hi = mid;
          else lo = mid;
        }
        hitT = hi;
        break;
      }
    }
    if (hitT < 0) return;

    // sharp near the ground, fading out as the drone climbs
    const lift = hitT * SUN_DIR.y;
    const shadeAlpha = clampNum(1 - lift / 45, 0, 1) * 0.75;
    if (shadeAlpha < 0.02) return;

    const cx = this.pos.x + SUN_DIR.x * hitT;
    const cz = this.pos.z + SUN_DIR.z * hitT;
    const top = surface(cx, cz);

    // follow the slope of the land (rooftops stay flat)
    let hx = 0;
    let hz = 0;
    if (top < w.heightAt(cx, cz) + 0.3) {
      const n = w.normalAt(cx, cz);
      hx = -n[0] / n[1];
      hz = -n[2] / n[1];
    }

    push();
    translate(cx, -top - 0.07, cz);
    rotateX(Math.atan(hz));
    rotateZ(-Math.atan(hx));
    rotateY(this.yaw);
    scale(1 + lift * 0.013); // softer and wider when high
    if (sh) sh.setUniform('uColorMul', [1, 1, 1, shadeAlpha]);
    model(this.shadowGeo);
    if (sh) sh.setUniform('uColorMul', [1, 1, 1, 1]);
    pop();
  }
}


// =====================================================
// PARTICLES — rotor wash dust, lake spray, crash debris
// =====================================================

const SURFACE_DUST = {
  water: { c: [236, 242, 248], a: 0.55, rate: 1.3 },
  sand: { c: [196, 178, 140], a: 0.5, rate: 1.1 },
  dirt: { c: [168, 140, 104], a: 0.5, rate: 1.1 },
  road: { c: [150, 146, 138], a: 0.3, rate: 0.6 },
  pad: { c: [160, 160, 156], a: 0.25, rate: 0.5 },
  roof: { c: [170, 170, 166], a: 0.22, rate: 0.4 },
  rock: { c: [160, 152, 140], a: 0.32, rate: 0.6 },
  snow: { c: [250, 252, 255], a: 0.6, rate: 1.2 },
  grass: { c: [150, 158, 118], a: 0.22, rate: 0.5 },
};

class Effects {
  constructor() {
    this.parts = [];
    this.max = 260;
    this.disc = null;
    this.washAcc = 0;
    this.rng = makeRng(4242);
  }

  init() {
    this.disc = makeSoftDisc(16);
  }

  add(p) {
    if (this.parts.length >= this.max) this.parts.shift();
    this.parts.push(p);
  }

  burst(x, y, z, kind) {
    const r = this.rng;
    const splash = kind === 'water';
    const n = splash ? 50 : 36;

    for (let i = 0; i < n; i++) {
      const a = r() * FULL_TURN;
      const s = (splash ? 2 : 1.5) + r() * 4;
      this.add({
        x, y, z,
        vx: Math.cos(a) * s,
        vy: -(splash ? 3 + r() * 5 : 1 + r() * 3),
        vz: Math.sin(a) * s,
        age: 0,
        life: 0.8 + r() * 1.2,
        size: splash ? 0.5 + r() * 0.8 : 0.4 + r() * 1.0,
        grow: splash ? 1.2 : 2.2,
        grav: splash ? 9 : 1.5,
        drag: 1.5,
        c: splash ? [235, 242, 248] : [120, 112, 100],
        a: splash ? 0.7 : 0.55,
      });
    }
  }

  update(dt, drone, world) {
    // ---- rotor wash near the surface ----
    if (drone.motorsOn && drone.state !== 'LANDED' && !drone.sunk) {
      const water = world.isOverWater(drone.pos.x, drone.pos.z);
      const surfaceH = water ? world.waterLevel : world.groundHeightAt(drone.pos.x, drone.pos.z);
      const above = -drone.pos.y - DRONE.LEG_HEIGHT - surfaceH;

      if (above < 3.5) {
        const kind = water ? 'water' : world.surfaceAt(drone.pos.x, drone.pos.z);
        const s = SURFACE_DUST[kind] || SURFACE_DUST.grass;
        const power = clampNum(drone.thrust / (DRONE.MASS * G), 0.25, 1.6);
        const strength = clampNum(1 - above / 3.5, 0, 1) * power;
        this.washAcc += dt * 70 * strength * s.rate;

        const r = this.rng;
        while (this.washAcc > 1) {
          this.washAcc -= 1;
          const a = r() * FULL_TURN;
          const d = 0.3 + r() * 0.9;
          const sp = (2 + r() * 4) * strength + 0.5;
          this.add({
            x: drone.pos.x + Math.cos(a) * d,
            y: -(surfaceH + 0.15),
            z: drone.pos.z + Math.sin(a) * d,
            vx: Math.cos(a) * sp + drone.vel.x * 0.3,
            vy: -(0.3 + r() * 0.9),
            vz: Math.sin(a) * sp + drone.vel.z * 0.3,
            age: 0,
            life: 0.6 + r() * 0.9,
            size: 0.35 + r() * 0.6,
            grow: 1.8,
            grav: water ? 3 : -0.2,
            drag: 2.2,
            c: s.c,
            a: s.a,
          });
        }
      } else {
        this.washAcc = 0;
      }
    }

    // ---- move + fade ----
    const keep = [];
    for (const p of this.parts) {
      p.age += dt;
      if (p.age >= p.life) continue;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vz *= k;
      p.vy = p.vy * k + p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      keep.push(p);
    }
    this.parts = keep;
  }

  draw(cam, sh) {
    for (const p of this.parts) {
      const t = p.age / p.life;
      const fade = Math.min(1, t * 6) * (1 - t);
      const dx = cam.eye.x - p.x;
      const dy = cam.eye.y - p.y;
      const dz = cam.eye.z - p.z;

      push();
      translate(p.x, p.y, p.z);
      rotateY(Math.atan2(dx, dz));
      rotateX(Math.atan2(-dy, Math.hypot(dx, dz)));
      scale(p.size * (1 + t * p.grow));
      emissiveMaterial(60, 60, 60);
      if (sh) sh.setUniform('uColorMul', [p.c[0] / 255, p.c[1] / 255, p.c[2] / 255, p.a * fade]);
      model(this.disc);
      pop();
    }
    if (sh) sh.setUniform('uColorMul', [1, 1, 1, 1]);
  }


}
