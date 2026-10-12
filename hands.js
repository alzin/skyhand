// =====================================================
//  hands.js — webcam + ml5 handPose -> virtual sticks
// =====================================================
//
//  ONE HAND (default)
//    raise / lower hand ........ climb / descend
//    tilt fingers to screen .... fly forward (tilt back = reverse)
//    tilt like a steering wheel  turn
//    move hand left / right .... slide sideways
//    pinch and hold ............ take off / land
//    fist ...................... brake and hover
//
//  TWO HANDS (like a real radio, "Mode 2")
//    left hand:  up/down = climb, left/right = turn
//    right hand: up/down = forward/back, left/right = slide

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

const HAND_TUNING = {
  posRange: 0.13,        // hand travel (fraction of frame) for full stick
  pitchRange: 30 * DEG,  // finger tilt for full forward / back
  turnRange: 35 * DEG,   // steering-wheel tilt for full turn rate
  deadzone: 0.2,
  expo: 1.55,
  pinchOn: 0.032,        // thumb-index distance (m) to start a pinch
  pinchOff: 0.05,
  pinchHold: 0.8,        // seconds to hold for take-off / landing
  lostAfter: 0.25,       // seconds without a hand -> failsafe
};

const ZERO_STICKS = { pitch: 0, roll: 0, yaw: 0, throttle: 0 };


class HandControl {
  constructor() {
    this.status = 'idle'; // idle | loading | ready | error
    this.cameraReady = false;
    this.cameraFailed = false;
    this.modelReady = false;
    this.error = '';
    this.video = null;
    this.model = null;
    this.startedAt = 0;

    this.twoHand = false;
    this.hands = [];
    this.primary = null;
    this.lastSeen = -10;
    this.fps = 0;
    this._fpsCount = 0;
    this._fpsTime = 0;

    this.raw = { ...ZERO_STICKS };
    this.sticks = { ...ZERO_STICKS };
    this.neutral = { x: 0.5, y: 0.56, pitch: 0, tilt: 0 };
    this.neutralL = { x: 0.27, y: 0.58 };
    this.neutralR = { x: 0.73, y: 0.58 };

    this.gesture = 'none'; // none | fly | pinch | brake
    this.pinchActive = false;
    this.pinchStart = 0;
    this.pinchProgress = 0;
    this.pinchLatched = false;
    this.fist = false;
    this.onPinchHold = null;

    this.f = {
      x: new OneEuroFilter(1.4, 0.8),
      y: new OneEuroFilter(1.4, 0.8),
      pitch: new OneEuroFilter(1.1, 0.5),
      tilt: new OneEuroFilter(1.1, 0.5),
      lx: new OneEuroFilter(1.4, 0.8),
      ly: new OneEuroFilter(1.4, 0.8),
      rx: new OneEuroFilter(1.4, 0.8),
      ry: new OneEuroFilter(1.4, 0.8),
    };
  }

  now() {
    return performance.now() / 1000;
  }

  get handVisible() {
    return this.now() - this.lastSeen < HAND_TUNING.lostAfter;
  }

  start() {
    this.startedAt = this.now();
    try {
      this.video = createCapture({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      this.video.hide();
      this.video.elt.addEventListener('loadeddata', () => {
        this.cameraReady = true;
      });
    } catch (e) {
      console.warn('Camera unavailable:', e);
      this.cameraFailed = true;
    }
    this.loadModel();
  }

  async loadModel() {
    if (typeof ml5 === 'undefined') {
      this.status = 'error';
      this.error = 'ml5.js did not load';
      return;
    }

    this.status = 'loading';
    try {
      // With p5 2.x, ml5.handPose() returns a Promise.
      let loaded = ml5.handPose({ maxHands: 2, flipped: false });
      if (loaded && typeof loaded.then === 'function') loaded = await loaded;
      if (loaded && loaded.ready && typeof loaded.ready.then === 'function') await loaded.ready;

      this.model = loaded;
      this.modelReady = true;
      this.status = 'ready';
      if (this.video) this.model.detectStart(this.video, (results) => this.onResults(results));
    } catch (e) {
      console.error(e);
      this.status = 'error';
      this.error = 'Hand model failed to load';
    }
  }


  // =====================================================
  // DETECTION RESULTS (≈30 per second)
  // =====================================================

  onResults(results) {
    const t = this.now();

    this._fpsCount++;
    if (t - this._fpsTime >= 1) {
      this.fps = this._fpsCount / (t - this._fpsTime);
      this._fpsCount = 0;
      this._fpsTime = t;
    }

    const el = this.video.elt;
    const vw = el.width || el.videoWidth || 640;
    const vh = el.height || el.videoHeight || 480;

    const hands = [];
    for (const h of results || []) {
      if (!h.keypoints || h.keypoints.length < 21) continue;
      if (!h.keypoints3D || h.keypoints3D.length < 21) continue;
      hands.push(this.measure(h, vw, vh));
    }

    this.hands = hands;
    if (hands.length) this.lastSeen = t;
    this.interpret(t);
  }

  measure(h, vw, vh) {
    // Mirror x so the preview behaves like a mirror.
    const pts = h.keypoints.map((p) => ({ x: 1 - p.x / vw, y: p.y / vh }));
    const p3 = h.keypoints3D.map((p) => ({ x: -p.x, y: p.y, z: p.z }));
    const d3 = (a, b) => Math.hypot(p3[a].x - p3[b].x, p3[a].y - p3[b].y, p3[a].z - p3[b].z);

    let cx = 0;
    let cy = 0;
    for (const i of [0, 5, 9, 13, 17]) {
      cx += pts[i].x;
      cy += pts[i].y;
    }
    cx /= 5;
    cy /= 5;

    // Forward tilt from 3D: fingers leaning toward the camera
    // have smaller z than the wrist.
    const uy = p3[9].y - p3[0].y;
    const uz = p3[9].z - p3[0].z;
    const pitch = Math.atan2(-uz, -uy);

    // Steering-wheel tilt in the picture (+ = tilted to your right).
    // Measured in pixels so the camera's 4:3 shape doesn't squash it.
    const tilt = Math.atan2((pts[9].x - pts[0].x) * vw, -(pts[9].y - pts[0].y) * vh);

    // How curled each finger is: tip distance / knuckle distance
    // from the wrist (~2 when straight, ~1 when curled).
    const curl = (tip, knuckle) => d3(tip, 0) / Math.max(1e-4, d3(knuckle, 0));
    const curlIndex = curl(8, 5);
    const others = (curl(12, 9) + curl(16, 13) + curl(20, 17)) / 3;

    return { pts, cx, cy, pitch, tilt, pinch: d3(4, 8), curlIndex, others };
  }

  interpret(t) {
    const T = HAND_TUNING;
    const hands = this.hands;

    // keep following the same hand when two are visible
    let primary = null;
    if (hands.length) {
      primary = hands[0];
      if (this.primary && hands.length > 1) {
        const d = (h) => Math.hypot(h.cx - this.primary.cx, h.cy - this.primary.cy);
        primary = hands.reduce((a, b) => (d(b) < d(a) ? b : a));
      }
    }
    this.primary = primary;

    if (primary) {
      primary.fx = this.f.x.filter(primary.cx, t);
      primary.fy = this.f.y.filter(primary.cy, t);
      primary.fpitch = this.f.pitch.filter(primary.pitch, t);
      primary.ftilt = this.f.tilt.filter(primary.tilt, t);
    }

    // ---- gestures (any visible hand) ----
    let pinching = false;
    let fist = false;
    for (const h of hands) {
      const pinchLimit = this.pinchActive ? T.pinchOff : T.pinchOn;
      if (h.pinch < pinchLimit && h.others > 1.35) {
        pinching = true;
      } else if (h.others < (this.fist ? 1.42 : 1.25) && h.curlIndex < 1.5) {
        fist = true;
      }
    }

    if (pinching) {
      if (!this.pinchActive) {
        this.pinchActive = true;
        this.pinchStart = t;
      }
      this.pinchProgress = clampNum((t - this.pinchStart) / T.pinchHold, 0, 1);
      if (this.pinchProgress >= 1 && !this.pinchLatched) {
        this.pinchLatched = true;
        if (this.onPinchHold) this.onPinchHold();
      }
    } else {
      this.pinchActive = false;
      this.pinchProgress = 0;
      this.pinchLatched = false;
    }

    this.fist = fist && !pinching;
    this.gesture = !hands.length ? 'none' : pinching ? 'pinch' : this.fist ? 'brake' : 'fly';

    // ---- sticks ----
    const out = { ...ZERO_STICKS };
    const shape = (v) => shapeStick(clampNum(v, -1, 1), T.deadzone, T.expo);

    if (this.gesture === 'fly') {
      if (!this.twoHand) {
        const h = primary;
        const n = this.neutral;
        out.roll = shape((h.fx - n.x) / T.posRange);
        out.throttle = shape((n.y - h.fy) / T.posRange);
        out.pitch = shape((h.fpitch - n.pitch) / T.pitchRange);
        out.yaw = shape((h.ftilt - n.tilt) / T.turnRange);
      } else {
        const { L, R } = this.splitHands();
        if (L) {
          const x = this.f.lx.filter(L.cx, t);
          const y = this.f.ly.filter(L.cy, t);
          out.yaw = shape((x - this.neutralL.x) / T.posRange);
          out.throttle = shape((this.neutralL.y - y) / T.posRange);
        }
        if (R) {
          const x = this.f.rx.filter(R.cx, t);
          const y = this.f.ry.filter(R.cy, t);
          out.roll = shape((x - this.neutralR.x) / T.posRange);
          out.pitch = shape((this.neutralR.y - y) / T.posRange);
        }
      }
    }

    this.raw = out;
  }

  splitHands() {
    const hands = this.hands;
    if (hands.length >= 2) {
      const sorted = [...hands].sort((a, b) => a.cx - b.cx);
      return { L: sorted[0], R: sorted[sorted.length - 1] };
    }
    if (hands.length === 1) {
      return hands[0].cx < 0.5 ? { L: hands[0], R: null } : { L: null, R: hands[0] };
    }
    return { L: null, R: null };
  }

  // Called every frame: smooth sticks, failsafe on hand loss.
  update(dt) {
    const lost = !this.handVisible;
    if (lost) {
      this.raw = { ...ZERO_STICKS };
      if (this.modelReady) this.gesture = 'none';
      this.pinchActive = false;
      this.pinchProgress = 0;
      this.pinchLatched = false;
    }

    const rate = lost ? 4 : 14;
    for (const k of ['pitch', 'roll', 'yaw', 'throttle']) {
      this.sticks[k] = approach(this.sticks[k], this.raw[k], rate, dt);
    }

    if (!this.cameraReady && !this.cameraFailed && this.now() - this.startedAt > 15) {
      this.cameraFailed = true;
    }
  }

  // Use the hand's current pose as "centre sticks".
  calibrate() {
    const h = this.primary;
    if (!h || !this.handVisible) return false;

    if (!this.twoHand) {
      this.neutral.x = clampNum(h.fx ?? h.cx, 0.25, 0.75);
      this.neutral.y = clampNum(h.fy ?? h.cy, 0.3, 0.78);
      this.neutral.pitch = clampNum(h.fpitch ?? h.pitch, -0.3, 0.3);
      this.neutral.tilt = clampNum(h.ftilt ?? h.tilt, -0.3, 0.3);
    } else {
      const { L, R } = this.splitHands();
      if (L) this.neutralL = { x: clampNum(L.cx, 0.1, 0.45), y: clampNum(L.cy, 0.3, 0.78) };
      if (R) this.neutralR = { x: clampNum(R.cx, 0.55, 0.9), y: clampNum(R.cy, 0.3, 0.78) };
    }
    return true;
  }

  setTwoHand(on) {
    this.twoHand = on;
    for (const k in this.f) this.f[k].reset();
    this.raw = { ...ZERO_STICKS };
  }
}
