// =====================================================
//  SKYHAND — fly a drone with your hand
//  p5.js 2.x + ml5.js handPose
// =====================================================
//
//  utils.js   maths, filters, textures, mesh builder
//  world.js   terrain, town, lake, forest, sky, race course
//  drone.js   physics, flight controller, model, particles
//  hands.js   webcam hand tracking -> virtual sticks
//  audio.js   synthesised rotor sound
//  hud.js     flight display
//  sketch.js  main loop, cameras, input (this file)

let world;
let drone;
let race;
let effects;
let hands;
let hud;
let sfx;
let worldShader = null;

let started = false;
let showHelp = false;
let photoPending = false;
let crashText = '';
let inputSource = 'hand';
let fpsSmooth = 60;

const keys = {};
const kb = { pitch: 0, roll: 0, yaw: 0, throttle: 0 };
const settings = { wind: 1 };

const WIND_LEVELS = [
  { name: 'Calm', base: 0.6, gust: 0.8, turb: 0.12 },
  { name: 'Breezy', base: 4.0, gust: 2.5, turb: 0.45 },
  { name: 'Gusty', base: 7.0, gust: 5.0, turb: 0.95 },
];

const env = {
  wind: v3(),               // air velocity at the drone (p5 space)
  windDir: { x: 1, z: 0 },  // horizontal direction it blows toward
  windSpeed: 0,             // at the drone's height
  baseSpeed: 0,             // without height shear
  turbulence: 0,
};

const CAMERA_MODES = ['chase', 'fpv', 'gimbal', 'pilot'];
const CAMERA_HINTS = {
  chase: 'Chase camera',
  fpv: 'FPV camera: tilts with the drone',
  gimbal: 'Gimbal camera: stays level',
  pilot: 'Pilot view: watching from the ground',
};

const cam = {
  mode: 'intro',
  eye: v3(6, -3, 8),
  center: v3(0, -1, 0),
  up: v3(0, 1, 0),
  fov: 52 * DEG,
  near: 0.12,
  far: 4500,
  aspect: 1.6,
  chaseDist: 3.4,
  followYaw: 0,
  gimbalYaw: 0,
  orbit: 0.6,
  shake: 0,
  X: v3(1, 0, 0),
  Y: v3(0, 1, 0),
  Z: v3(0, 0, 1),
  tanHalf: Math.tan(26 * DEG),
};

const CRASH_TEXT = {
  tree: 'Crashed into a tree',
  building: 'Hit a building',
  car: 'Hit a parked car',
  pole: 'Clipped a pole',
  gate: 'Clipped a race gate',
  turbine: 'Struck by a turbine blade',
  ground: 'Hit the ground too hard',
  water: 'Splash! It went into the lake',
};


// =====================================================
// SETUP
// =====================================================

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  setAttributes('antialias', true);
  pixelDensity(1);
  textureMode(NORMAL);
  noStroke();

  world = new World();
  world.build();

  drone = new Drone(world);
  race = new RaceCourse(world);
  effects = new Effects();
  effects.init();

  hud = new HUD();
  hud.onAction = onAction;
  hud.onWheel = (dy) => {
    cam.chaseDist = clampNum(cam.chaseDist * (dy > 0 ? 1.1 : 0.9), 1.8, 14);
  };

  sfx = new DroneAudio();

  hands = new HandControl();
  hands.onPinchHold = () => {
    if (started) primaryAction(true);
  };
  hands.start();

  worldShader = createWorldShader();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });
  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
  });

  document.getElementById('start-button').addEventListener('click', startFlying);
  document.getElementById('help-close').addEventListener('click', () => toggleHelp(false));
  document.getElementById('help').addEventListener('click', (e) => {
    if (e.target.id === 'help') toggleHelp(false);
  });
}

// p5's own lit material + three hooks:
//   * distance fog that thins with height (aerial perspective)
//   * fine grass/asphalt detail so the ground reads up close
//   * animated ripples + reflections on the lake
function createWorldShader() {
  try {
    const s = baseMaterialShader().modify({
      uniforms: {
        'vec3 uFogColor': () => FOG_COLOR,
        'float uFogDensity': FOG_DENSITY,
        'vec4 uColorMul': [1, 1, 1, 1],
        'float uFogBase': () => world.homeBase,
        'float uDetail': 0,
        'float uWater': 0,
        'float uTime': 0,
      },
      vertexDeclarations: 'OUT vec3 vWorldPos;',
      fragmentDeclarations: `
        IN vec3 vWorldPos;
        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
                     mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
        }
      `,
      'Vertex getWorldInputs': `(Vertex inputs) {
        vWorldPos = inputs.position;
        return inputs;
      }`,
      'Inputs getPixelInputs': `(Inputs inputs) {
        inputs.color *= uColorMul;
        inputs.ambientMaterial *= uColorMul.rgb;
        if (uDetail > 0.0) {
          vec2 p = vWorldPos.xz;
          float n = vnoise(p * 0.45) * 0.55 + vnoise(p * 1.9) * 0.3 + vnoise(p * 6.0) * 0.15;
          float patches = vnoise(p * 0.06);
          inputs.color.rgb *= 1.0 + (n - 0.5) * 0.42 * uDetail;
          inputs.color.rgb = mix(inputs.color.rgb, inputs.color.rgb * vec3(1.1, 1.05, 0.82),
                                 smoothstep(0.6, 0.85, patches) * 0.5 * uDetail);
          inputs.ambientMaterial = inputs.color.rgb;
        }
        if (uWater > 0.5) {
          vec2 p = vWorldPos.xz;
          float t = uTime;
          float dx = sin(p.x * 0.55 + t * 1.25) * 0.5 + sin((p.x + p.y) * 1.3 - t * 1.9) * 0.3
                   + sin(p.x * 3.1 + p.y * 1.7 + t * 2.7) * 0.2;
          float dz = sin(p.y * 0.62 - t * 1.05) * 0.5 + sin((p.y - p.x) * 1.15 + t * 1.6) * 0.3
                   + sin(p.y * 2.9 - p.x * 1.3 - t * 2.4) * 0.2;
          vec3 nWorld = normalize(vec3(dx * 0.14, -1.0, dz * 0.14));
          inputs.normal = normalize((uViewMatrix * vec4(nWorld, 0.0)).xyz);
          vec3 V = normalize(-vViewPosition);
          float fresnel = pow(1.0 - clamp(dot(inputs.normal, V), 0.0, 1.0), 4.0);
          inputs.color.rgb = mix(inputs.color.rgb, uFogColor, fresnel * 0.8);
          inputs.ambientMaterial = inputs.color.rgb;
          inputs.color.a = mix(inputs.color.a, 1.0, fresnel);
        }
        return inputs;
      }`,
      'vec4 getFinalColor': `(vec4 color, vec2 texCoord) {
        float d = length(vViewPosition);
        float height = -vWorldPos.y - uFogBase;
        float density = uFogDensity * mix(1.0, 0.45, smoothstep(40.0, 420.0, height));
        float f = 1.0 - exp(-pow(d * density, 2.0));
        color.rgb = mix(color.rgb, uFogColor, clamp(f, 0.0, 1.0));
        return color;
      }`,
    });

    shader(s); // compile now so any problem shows up here
    resetShader();
    return s;
  } catch (e) {
    console.warn('World shader unavailable, drawing without fog:', e);
    resetShader();
    return null;
  }
}


// =====================================================
// DRAW LOOP
// =====================================================

function draw() {
  const dt = Math.min(deltaTime / 1000, 0.1);
  const now = millis() / 1000;
  fpsSmooth = lerpNum(fpsSmooth, frameRate() || 60, 0.05);

  updateWind(now);
  hands.update(dt);
  const sticks = readSticks(dt);

  drone.update(dt, sticks, env);
  handleDroneEvents();
  if (drone.airborne) {
    const ev = race.check(drone.prevPos, drone.pos, now);
    if (ev) onRaceEvent(ev);
  }

  world.update(dt, env);
  effects.update(dt, drone, world);
  updateCamera(dt);
  renderScene();

  if (photoPending) {
    photoPending = false;
    saveCanvas(`skyhand-${Date.now()}`, 'jpg');
    hud.flash = 0.85;
    sfx.play('shutter');
    hud.toast('Photo saved', 'good');
  }

  hud.draw(hudState(sticks, now), dt);
  sfx.update(drone, cam);
  if (!started) updateChecklist();
}

function renderScene() {
  const gl = drawingContext;
  background(FOG_COLOR[0] * 255, FOG_COLOR[1] * 255, FOG_COLOR[2] * 255);
  perspective(cam.fov, width / height, cam.near, cam.far);
  camera(
    cam.eye.x, cam.eye.y, cam.eye.z,
    cam.center.x, cam.center.y, cam.center.z,
    cam.up.x, cam.up.y, cam.up.z
  );
  noStroke();

  // 1. sky dome and sun: no fog, no lighting. Everything in the
  //    frame uses the same shader, which keeps WebGL state tidy.
  if (worldShader) shader(worldShader);
  else resetShader();
  noLights();
  world.drawSky(cam, worldShader);

  // 2. sunlight, blue sky fill from the other side, ambient
  ambientLight(92, 100, 118);
  directionalLight(255, 244, 226, SUN_DIR.x, SUN_DIR.y, SUN_DIR.z);
  directionalLight(62, 76, 104, -SUN_DIR.x * 0.6, 0.75, -SUN_DIR.z * 0.6);

  if (worldShader) worldShader.setUniform('uTime', world.time);

  // 3. solid world
  const onboard = cam.mode === 'fpv' || cam.mode === 'gimbal';
  world.drawTerrain(worldShader);
  world.drawStatic(worldShader);
  world.drawDynamic(race);
  if (!onboard) drone.draw(world.time);

  // 4. see-through things, without writing depth
  gl.depthMask(false);
  world.drawWater(worldShader);
  world.drawClouds(cam, worldShader);
  drone.drawShadow(worldShader);
  effects.draw(cam, worldShader);
  if (!onboard) drone.drawProps();
  gl.depthMask(true);
}


// =====================================================
// WIND
// =====================================================

function updateWind(t) {
  const L = WIND_LEVELS[settings.wind];
  const n = world.noise;

  const dir = -0.65 + n.get(t * 0.02, 3.3) * 0.6; // from the south-west, wandering
  const gust = (n.get(t * 0.35, 7.7) + 0.6 * n.get(t * 1.1, -2.2)) / 1.6;
  const base = Math.max(0, L.base + L.gust * gust);
  const shear = 0.55 + 0.45 * clampNum(Math.max(0, drone.agl) / 25, 0, 1); // calmer near the ground
  const speed = base * shear;

  env.windDir.x = Math.cos(dir);
  env.windDir.z = Math.sin(dir);
  env.wind.x = env.windDir.x * speed;
  env.wind.z = env.windDir.z * speed;
  env.wind.y = n.get(t * 0.6, 12.1) * L.turb * 0.8;
  env.windSpeed = speed;
  env.baseSpeed = base;
  env.turbulence = L.turb * (0.6 + 0.4 * Math.abs(gust));
}


// =====================================================
// INPUT
// =====================================================

function readSticks(dt) {
  const target = {
    pitch: (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0),
    roll: (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0),
    yaw: (keys.ArrowRight || keys.KeyE ? 1 : 0) - (keys.ArrowLeft || keys.KeyQ ? 1 : 0),
    throttle: (keys.ArrowUp ? 1 : 0) - (keys.ArrowDown ? 1 : 0),
  };
  if (!started) {
    for (const k in target) target[k] = 0;
  }

  // keys ramp like a real stick instead of snapping
  for (const k in kb) kb[k] = approach(kb[k], target[k], 7, dt);
  const kbActive = Object.values(kb).some((v) => Math.abs(v) > 0.02);

  const sticks = kbActive ? { ...kb } : started ? hands.sticks : { ...ZERO_STICKS };
  inputSource = ['TAKEOFF', 'LANDING', 'RTH'].includes(drone.state)
    ? 'autopilot'
    : kbActive ? 'keyboard' : 'hand';
  return sticks;
}

function onKeyDown(e) {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
  if (e.repeat) return;

  if (!started) {
    if (e.code === 'Enter' || e.code === 'Space') startFlying();
    return;
  }

  switch (e.code) {
    case 'Space': primaryAction(false); break;
    case 'KeyH': toggleRTH(); break;
    case 'KeyC': cycleCamera(); break;
    case 'KeyF': cycleMode(); break;
    case 'KeyT': toggleHands(); break;
    case 'KeyG': cycleWind(); break;
    case 'KeyR': resetDrone(); break;
    case 'KeyP': photoPending = true; break;
    case 'KeyM': hud.toast(sfx.toggleMute() ? 'Sound off' : 'Sound on'); break;
    case 'KeyI': toggleHelp(); break;
    case 'Escape': toggleHelp(false); break;
  }
}

function onAction(id) {
  sfx.play('click');
  switch (id) {
    case 'takeoff': primaryAction(false); break;
    case 'rth': toggleRTH(); break;
    case 'camera': cycleCamera(); break;
    case 'mode': cycleMode(); break;
    case 'hands': toggleHands(); break;
    case 'wind': cycleWind(); break;
    case 'reset': resetDrone(); break;
    case 'help': toggleHelp(); break;
  }
}

// Space bar, the big button and the pinch gesture all do
// "the obvious next thing": take off, land, or reset.
function primaryAction(fromGesture) {
  switch (drone.state) {
    case 'DISARMED':
    case 'LANDED':
      if (fromGesture && hands.calibrate()) {
        hud.toast('Centre set: this hand pose means hover', 'info', 3);
      }
      drone.arm();
      break;
    case 'TAKEOFF':
    case 'FLYING':
    case 'RTH':
      drone.land();
      break;
    case 'LANDING':
      drone.cancelLanding();
      break;
    case 'CRASHED':
      resetDrone();
      break;
  }
}

function toggleRTH() {
  if (drone.state === 'RTH') drone.cancelRTH();
  else if (['FLYING', 'LANDING', 'TAKEOFF'].includes(drone.state)) drone.startRTH('user');
  else hud.toast('Take off first');
}

function cycleCamera() {
  const i = CAMERA_MODES.indexOf(cam.mode);
  cam.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
  if (cam.mode === 'pilot') cam.center = v3(drone.pos.x, drone.pos.y, drone.pos.z);
  hud.toast(CAMERA_HINTS[cam.mode]);
}

function cycleMode() {
  const i = MODE_ORDER.indexOf(drone.mode.key);
  drone.mode = FLIGHT_MODES[MODE_ORDER[(i + 1) % MODE_ORDER.length]];
  drone.hold = null;
  drone.altHold = null;
  const hints = {
    CINE: 'Cine mode: slow and smooth',
    NORMAL: 'Normal mode: holds its position',
    SPORT: 'Sport mode: fast, up to 68 km/h',
    ATTI: 'Attitude mode: no position hold, it drifts',
  };
  hud.toast(hints[drone.mode.key], 'info', 3);
}

function toggleHands() {
  hands.setTwoHand(!hands.twoHand);
  hud.toast(hands.twoHand ? 'Two hands: left climbs and turns, right flies' : 'One hand control', 'info', 3.5);
}

function cycleWind() {
  settings.wind = (settings.wind + 1) % WIND_LEVELS.length;
  hud.toast(`Wind: ${WIND_LEVELS[settings.wind].name}`);
}

function resetDrone() {
  drone.reset();
  race.reset();
  effects.parts.length = 0;
  crashText = '';
  cam.followYaw = drone.yaw;
  cam.gimbalYaw = drone.yaw;
  hud.toast('Fresh battery, drone back on the pad', 'good');
}

function toggleHelp(force) {
  showHelp = force === undefined ? !showHelp : force;
  document.getElementById('help').classList.toggle('hidden', !showHelp);
}

function startFlying() {
  if (started) return;
  started = true;
  sfx.init();
  document.getElementById('start').classList.add('hidden');
  cam.mode = 'chase';
  cam.followYaw = drone.yaw;
  const handReady = hands.modelReady && !hands.cameraFailed;
  hud.toast(handReady ? 'Pinch and hold to take off' : 'Press Space to take off', 'info', 5);
}


// =====================================================
// EVENTS
// =====================================================

function handleDroneEvents() {
  for (const e of drone.events) {
    switch (e.type) {
      case 'arming': sfx.play('arm'); hud.toast('Starting motors'); break;
      case 'takeoff': hud.toast('Taking off'); break;
      case 'hovering': hud.toast('Hovering: you have control', 'good'); break;
      case 'landing': hud.toast('Landing'); break;
      case 'landed': hud.toast('Landed', 'good'); break;
      case 'disarmed': sfx.play('disarm'); break;
      case 'resume': hud.toast('Landing cancelled'); break;
      case 'rth':
        sfx.play('warn');
        hud.toast(e.reason === 'battery' ? 'Battery low: returning home' : 'Returning home', 'warn', 3.5);
        break;
      case 'rthCancel': hud.toast('Return home cancelled'); break;
      case 'lowBattery': sfx.play('warn'); hud.toast('Battery at 25%: head home soon', 'warn', 4); break;
      case 'forcedLanding': hud.toast('Battery empty: landing now', 'alert', 4); break;
      case 'noBattery': hud.toast('Battery empty: press R for a fresh one', 'alert', 4); break;
      case 'altLimit': hud.toast('Altitude limit: 120 m above ground', 'warn'); break;
      case 'geofence': hud.toast('Edge of the flying area', 'warn'); break;
      case 'bump': sfx.play('bump'); break;
      case 'thud': sfx.play('thud'); break;
      case 'splash':
        sfx.play('splash');
        effects.burst(drone.pos.x, -world.waterLevel, drone.pos.z, 'water');
        break;
      case 'crash':
        crashText = CRASH_TEXT[e.kind] || 'Crashed';
        if (e.kind !== 'water') {
          sfx.play('crash');
          effects.burst(drone.pos.x, drone.pos.y, drone.pos.z, 'debris');
        }
        cam.shake = clampNum(e.speed / 8, 0.3, 1);
        race.reset();
        break;
    }
  }
  drone.events.length = 0;
}

function onRaceEvent(ev) {
  if (ev.type === 'start') {
    sfx.play('gate');
    hud.toast('Lap started: gate 2 is next', 'good');
  } else if (ev.type === 'gate') {
    sfx.play('gate');
    hud.toast(`Gate ${ev.index + 1} cleared`, 'good', 1.6);
  } else if (ev.type === 'lap') {
    sfx.play('lap');
    hud.toast(`Lap time ${hud.formatTime(ev.time)}${ev.best ? ', a new best' : ''}`, 'good', 4);
  }
}


// =====================================================
// CAMERAS
// =====================================================

function updateCamera(dt) {
  const d = drone;
  const p = d.pos;
  let up = v3(0, 1, 0); // p5's "up" argument points to screen-down
  let fov = 60 * DEG;
  let near = 0.12;

  if (d.state !== 'CRASHED') {
    cam.followYaw += wrapAngle(d.yaw - cam.followYaw) * (1 - Math.exp(-3.5 * dt));
  }

  switch (cam.mode) {
    case 'intro': {
      cam.orbit += dt * 0.12;
      const eye = v3(p.x + Math.sin(cam.orbit) * 7.5, p.y - 2.4, p.z + Math.cos(cam.orbit) * 7.5);
      cam.eye = vApproach(cam.eye, eye, 3, dt);
      cam.center = vApproach(cam.center, v3(p.x, p.y - 0.4, p.z), 5, dt);
      fov = 52 * DEG;
      break;
    }

    case 'chase': {
      const speed = d.speed;
      const range = cam.chaseDist + speed * 0.09;
      const lift = 0.8 + cam.chaseDist * 0.2 + speed * 0.025;
      const fx = -Math.sin(cam.followYaw);
      const fz = -Math.cos(cam.followYaw);
      const eye = v3(p.x - fx * range, p.y - lift, p.z - fz * range);
      const ground = -world.groundHeightAt(eye.x, eye.z) - 0.8;
      if (eye.y > ground) eye.y = ground;

      cam.eye = vApproach(cam.eye, eye, 6, dt);
      cam.center = vApproach(cam.center, v3(p.x + fx * 2.2, p.y - 0.3, p.z + fz * 2.2), 10, dt);
      const floor2 = -world.groundHeightAt(cam.eye.x, cam.eye.z) - 0.6;
      if (cam.eye.y > floor2) cam.eye.y = floor2;
      fov = (58 + Math.min(speed, 20) * 0.8) * DEG; // wider at speed
      break;
    }

    case 'fpv': {
      // camera bolted to the frame with 18 degrees of up-tilt
      const U = d.bodyUp();
      const F = d.bodyForward();
      const tilt = 18 * DEG;
      const dir = vAdd(vScale(F, Math.cos(tilt)), vScale(U, Math.sin(tilt)));
      const camUp = vSub(vScale(U, Math.cos(tilt)), vScale(F, Math.sin(tilt)));
      cam.eye = vAdd(vAdd(p, vScale(F, 0.22)), vScale(U, 0.03));
      cam.center = vAdd(cam.eye, dir);
      up = vScale(camUp, -1);
      fov = 86 * DEG;
      near = 0.08;

      const vib = 0.0025 * clampNum(d.thrust / (DRONE.MASS * G), 0, 2);
      cam.center.x += (Math.random() - 0.5) * vib;
      cam.center.y += (Math.random() - 0.5) * vib;
      break;
    }

    case 'gimbal': {
      cam.gimbalYaw += wrapAngle(d.yaw - cam.gimbalYaw) * (1 - Math.exp(-2.5 * dt));
      const fx = -Math.sin(cam.gimbalYaw);
      const fz = -Math.cos(cam.gimbalYaw);
      const tilt = 12 * DEG;
      cam.eye = v3(p.x + fx * 0.15, p.y + 0.12, p.z + fz * 0.15);
      cam.center = v3(
        cam.eye.x + fx * Math.cos(tilt),
        cam.eye.y + Math.sin(tilt),
        cam.eye.z + fz * Math.cos(tilt)
      );
      fov = 72 * DEG;
      near = 0.08;
      break;
    }

    case 'pilot': {
      // you, standing next to the launch pad, watching it fly
      const base = world.heightAt(PILOT_SPOT.x, PILOT_SPOT.z);
      cam.eye = v3(PILOT_SPOT.x, -(base + 1.7), PILOT_SPOT.z);
      cam.center = vApproach(cam.center, p, 7, dt);
      const range = vLen(vSub(p, cam.eye));
      fov = clampNum(62 - (range - 15) * 0.25, 24, 62) * DEG;
      near = 0.3;
      break;
    }
  }

  if (cam.shake > 0) {
    const s = cam.shake * 0.12;
    cam.center.x += (Math.random() - 0.5) * s;
    cam.center.y += (Math.random() - 0.5) * s;
    cam.center.z += (Math.random() - 0.5) * s;
    cam.shake = Math.max(0, cam.shake - dt * 1.5);
  }

  const onboard = cam.mode === 'fpv' || cam.mode === 'gimbal';
  cam.fov = approach(cam.fov, fov, onboard ? 20 : 3, dt);
  cam.near = near;
  cam.up = up;
  cam.aspect = width / height;

  // camera basis (same maths as p5's camera()) for HUD markers
  const Z = vNorm(vSub(cam.eye, cam.center));
  const X = vNorm(vCross(cam.up, Z));
  cam.X = X;
  cam.Y = vCross(Z, X);
  cam.Z = Z;
  cam.tanHalf = Math.tan(cam.fov / 2);
}

// World point -> screen pixel (for HUD markers).
function projectPoint(x, y, z) {
  const dx = x - cam.eye.x;
  const dy = y - cam.eye.y;
  const dz = z - cam.eye.z;
  const xc = dx * cam.X.x + dy * cam.X.y + dz * cam.X.z;
  const yc = dx * cam.Y.x + dy * cam.Y.y + dz * cam.Y.z;
  const depth = -(dx * cam.Z.x + dy * cam.Z.y + dz * cam.Z.z);

  if (depth > 0.05) {
    return {
      x: width / 2 + (xc / depth / (cam.tanHalf * cam.aspect)) * (width / 2),
      y: height / 2 + (yc / depth / cam.tanHalf) * (height / 2),
      depth,
      front: true,
    };
  }

  // behind the camera: only the direction matters
  const l = Math.hypot(xc, yc);
  if (l < 1e-4) return { x: width / 2, y: height * 2, depth, front: false };
  return { x: width / 2 + (xc / l) * width, y: height / 2 + (yc / l) * height, depth, front: false };
}


// =====================================================
// HUD + START SCREEN
// =====================================================

function hudState(sticks, now) {
  return {
    drone, world, hands, race, cam, env, now, sticks,
    fps: fpsSmooth,
    input: inputSource,
    windName: WIND_LEVELS[settings.wind].name,
    intro: !started,
    crashText,
    project: projectPoint,
  };
}

function updateChecklist() {
  setCheck('check-camera',
    hands.cameraReady ? 'done' : hands.cameraFailed ? 'fail' : 'wait',
    hands.cameraFailed ? 'No camera found. You can still fly with the keyboard.' : null);
  setCheck('check-model',
    hands.modelReady ? 'done' : hands.status === 'error' ? 'fail' : 'wait',
    hands.status === 'error' ? `${hands.error}. Check your internet connection.` : null);
  setCheck('check-hand', hands.handVisible ? 'done' : 'wait', null);
}

function setCheck(id, state, note) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.dataset.state !== state) el.dataset.state = state;
  if (note) {
    const n = el.querySelector('.note');
    if (n && n.textContent !== note) n.textContent = note;
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  hud.resize();
}
