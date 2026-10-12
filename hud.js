// =====================================================
//  hud.js — flight display drawn on a 2D canvas that
//  sits on top of the 3D view (crisp text, cheap to draw)
// =====================================================

const UI = {
  ink: 'rgba(14, 26, 36, 0.6)',
  inkHover: 'rgba(28, 48, 64, 0.82)',
  line: 'rgba(255, 255, 255, 0.13)',
  text: '#f2f6f9',
  dim: 'rgba(242, 246, 249, 0.64)',
  faint: 'rgba(242, 246, 249, 0.35)',
  signal: '#ff7a1a', // hi-vis orange, like the windsock and gates
  lichen: '#8fd694',
  sky: '#8cc4ff',
  amber: '#ffc845',
  alert: '#ff5a4f',
};

const FONT_NUM = '"Barlow Condensed", "Arial Narrow", sans-serif';
const FONT_TEXT = '"Barlow", "Segoe UI", system-ui, sans-serif';

const STATE_LABELS = {
  DISARMED: 'Ready to fly',
  ARMING: 'Starting motors',
  TAKEOFF: 'Taking off',
  FLYING: 'Flying',
  LANDING: 'Landing',
  LANDED: 'Landed',
  RTH: 'Returning home',
  CRASHED: 'Crashed',
};

const STATE_COLORS = {
  DISARMED: UI.sky, ARMING: UI.amber, TAKEOFF: UI.lichen, FLYING: UI.lichen,
  LANDING: UI.amber, LANDED: UI.sky, RTH: UI.signal, CRASHED: UI.alert,
};

const CAMERA_LABELS = { chase: 'Chase', fpv: 'FPV', gimbal: 'Gimbal', pilot: 'Pilot', intro: 'Chase' };


class HUD {
  constructor() {
    this.canvas = document.getElementById('hud');
    this.ctx = this.canvas.getContext('2d');
    this.toasts = [];
    this.buttons = [];
    this.hover = null;
    this.flash = 0;
    this.onAction = null;
    this.onWheel = null;
    this.handRect = { x: 0, y: 0, w: 0, h: 0 };
    this.resize();

    this.canvas.addEventListener('pointerdown', (e) => this.pointer(e, true));
    this.canvas.addEventListener('pointermove', (e) => this.pointer(e, false));
    this.canvas.addEventListener('wheel', (e) => {
      if (this.onWheel) this.onWheel(e.deltaY);
      e.preventDefault();
    }, { passive: false });
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';

    // Lay out on a 1280 x 760 design and scale to fit.
    this.s = clampNum(Math.min(this.W / 1280, this.H / 760), 0.6, 1.35);
    this.VW = this.W / this.s;
    this.VH = this.H / this.s;
  }

  pointer(e, down) {
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / this.s;
    const y = (e.clientY - r.top) / this.s;
    const b = this.buttons.find((k) => x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h);
    this.hover = b ? b.id : null;
    this.canvas.style.cursor = b ? 'pointer' : 'default';
    if (down && b && this.onAction) this.onAction(b.id);
  }

  toast(message, tone = 'info', seconds = 2.6) {
    const last = this.toasts[this.toasts.length - 1];
    if (last && last.text === message) {
      last.t = Math.min(last.t, 0.2);
      return;
    }
    this.toasts.push({ text: message, tone, t: 0, life: seconds });
    if (this.toasts.length > 3) this.toasts.shift();
  }


  // =====================================================
  // DRAWING HELPERS
  // =====================================================

  rr(x, y, w, h, r) {
    const c = this.ctx;
    c.beginPath();
    if (c.roundRect) {
      c.roundRect(x, y, w, h, r);
    } else {
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }
  }

  panel(x, y, w, h, r = 10, fill = UI.ink) {
    const c = this.ctx;
    this.rr(x, y, w, h, r);
    c.fillStyle = fill;
    c.fill();
    c.strokeStyle = UI.line;
    c.lineWidth = 1;
    c.stroke();
  }

  label(str, x, y, size, col = UI.text, weight = 600, font = FONT_TEXT, align = 'left') {
    const c = this.ctx;
    c.font = `${weight} ${size}px ${font}`;
    c.fillStyle = col;
    c.textAlign = align;
    c.textBaseline = 'alphabetic';
    c.fillText(str, x, y);
  }

  measure(str, size, weight = 600, font = FONT_TEXT) {
    this.ctx.font = `${weight} ${size}px ${font}`;
    return this.ctx.measureText(str).width;
  }

  formatTime(t) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
  }


  // =====================================================
  // FRAME
  // =====================================================

  draw(S, dt) {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.buttons = [];
    if (S.intro) return;

    // world-space markers use real screen pixels
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawMarkers(S);
    if (S.cam.mode === 'fpv' || S.cam.mode === 'gimbal') this.drawReticle(S);

    // the rest is laid out on the scaled design grid
    c.setTransform(this.dpr * this.s, 0, 0, this.dpr * this.s, 0, 0);
    this.drawStatus(S);
    this.drawCompass(S);
    this.drawChips(S);
    this.drawRace(S);
    this.drawButtons(S);
    this.drawHandPanel(S);
    this.drawSticks(S);
    this.drawMinimap(S);
    this.drawTelemetry(S);
    this.drawToasts(dt);
    if (S.drone.state === 'CRASHED') this.drawCrash(S);
    this.label(`${Math.round(S.fps)} fps`, this.VW - 18, this.VH - 16, 12, UI.faint, 500, FONT_NUM, 'right');

    if (this.flash > 0) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.fillStyle = `rgba(255,255,255,${this.flash})`;
      c.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.flash = Math.max(0, this.flash - dt * 2.5);
    }
  }


  // =====================================================
  // TOP ROW
  // =====================================================

  drawStatus(S) {
    const c = this.ctx;
    const d = S.drone;
    const stateText = STATE_LABELS[d.state] || d.state;
    const w1 = this.measure(stateText, 16) + 46;

    this.panel(18, 16, w1, 34, 17);
    c.fillStyle = STATE_COLORS[d.state] || UI.text;
    c.beginPath();
    c.arc(37, 33, 5, 0, FULL_TURN);
    c.fill();
    this.label(stateText, 51, 38, 16);

    const mode = `${d.mode.label} mode`;
    const w2 = this.measure(mode, 15, 500) + 28;
    this.panel(18 + w1 + 8, 16, w2, 34, 17);
    this.label(mode, 18 + w1 + 22, 38, 15, UI.dim, 500);
  }

  drawCompass(S) {
    const c = this.ctx;
    const w = 380;
    const h = 30;
    const cx = this.VW / 2;
    const x = cx - w / 2;
    const y = 16;
    const heading = S.drone.heading;
    const ppd = w / 110;

    this.panel(x, y, w, h, 8);
    c.save();
    this.rr(x, y, w, h, 8);
    c.clip();

    const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    c.strokeStyle = 'rgba(242,246,249,0.5)';
    c.lineWidth = 1;
    for (let deg = Math.floor((heading - 60) / 5) * 5; deg <= heading + 60; deg += 5) {
      const sx = cx + (deg - heading) * ppd;
      const nd = ((deg % 360) + 360) % 360;
      const major = nd % 45 === 0;
      const mid = nd % 15 === 0;
      c.beginPath();
      c.moveTo(sx, y + h);
      c.lineTo(sx, y + h - (major ? 10 : mid ? 7 : 4));
      c.stroke();
      if (major) {
        this.label(names[nd], sx, y + 16, 14, nd === 0 ? UI.signal : UI.text, 700, FONT_NUM, 'center');
      } else if (mid) {
        this.label(String(nd), sx, y + 15, 11, UI.dim, 500, FONT_NUM, 'center');
      }
    }

    const tag = (wx, wz, tagColor, tagText) => {
      const bearing = (Math.atan2(wx - S.drone.pos.x, -(wz - S.drone.pos.z)) / DEG + 360) % 360;
      const rel = clampNum(((bearing - heading + 540) % 360) - 180, -53, 53);
      const sx = cx + rel * ppd;
      c.fillStyle = tagColor;
      this.rr(sx - 9, y + 2, 18, 13, 4);
      c.fill();
      this.label(tagText, sx, y + 13, 11, '#0e1a24', 700, FONT_NUM, 'center');
    };
    tag(HOME.x, HOME.z, UI.sky, 'H');
    const g = S.world.gates[S.race.next];
    tag(g.x, g.z, UI.signal, String(g.index + 1));
    c.restore();

    c.fillStyle = UI.signal;
    c.beginPath();
    c.moveTo(cx, y + h - 6);
    c.lineTo(cx - 6, y + h + 3);
    c.lineTo(cx + 6, y + h + 3);
    c.closePath();
    c.fill();

    this.panel(cx - 26, y + h + 6, 52, 20, 6);
    this.label(`${Math.round(heading) % 360}°`, cx, y + h + 21, 14, UI.text, 600, FONT_NUM, 'center');
  }

  drawChips(S) {
    const c = this.ctx;
    const y = 16;
    const h = 34;
    let right = this.VW - 18;

    // ---- battery ----
    const d = S.drone;
    const b = d.battery;
    const bColor = b < 15 ? UI.alert : b < 30 ? UI.amber : UI.text;
    const pct = `${Math.ceil(b)}%`;
    const mins = d.airborne ? `${Math.max(0, Math.floor(d.remainingSeconds / 60))} min left` : '';
    let w = 34 + this.measure(pct, 17, 600, FONT_NUM) + (mins ? this.measure(mins, 13, 500) + 10 : 0) + 18;
    let x = right - w;
    this.panel(x, y, w, h, 17);
    c.strokeStyle = bColor;
    c.lineWidth = 1.5;
    c.strokeRect(x + 12, y + 11, 18, 12);
    c.fillStyle = bColor;
    c.fillRect(x + 30, y + 14, 2, 6);
    c.fillRect(x + 14, y + 13, 14 * clampNum(b / 100, 0, 1), 8);
    this.label(pct, x + 38, y + 23, 17, bColor, 600, FONT_NUM);
    if (mins) this.label(mins, x + 38 + this.measure(pct, 17, 600, FONT_NUM) + 10, y + 22, 13, UI.dim, 500);
    right = x - 8;

    // ---- wind (arrow shows where it blows, relative to the drone) ----
    const ws = `${S.env.windSpeed.toFixed(1)} m/s`;
    w = 40 + this.measure(ws, 15, 600, FONT_NUM) + 16;
    x = right - w;
    this.panel(x, y, w, h, 17);
    const bearing = Math.atan2(S.env.windDir.x, -S.env.windDir.z) / DEG;
    c.save();
    c.translate(x + 20, y + 17);
    c.rotate((bearing - d.heading) * DEG);
    c.strokeStyle = UI.text;
    c.fillStyle = UI.text;
    c.lineWidth = 1.8;
    c.beginPath();
    c.moveTo(0, 7);
    c.lineTo(0, -5);
    c.stroke();
    c.beginPath();
    c.moveTo(0, -8);
    c.lineTo(-4, -2);
    c.lineTo(4, -2);
    c.closePath();
    c.fill();
    c.restore();
    this.label(ws, x + 36, y + 23, 15, UI.text, 600, FONT_NUM);
    right = x - 8;

    // ---- control link ----
    const hc = S.hands;
    let linkText;
    let linkColor;
    if (S.input === 'keyboard') {
      linkText = 'Keyboard';
      linkColor = UI.sky;
    } else if (hc.status === 'error') {
      linkText = hc.error;
      linkColor = UI.alert;
    } else if (hc.cameraFailed) {
      linkText = 'No camera';
      linkColor = UI.alert;
    } else if (!hc.modelReady) {
      linkText = 'Loading hand model';
      linkColor = UI.amber;
    } else if (hc.handVisible) {
      linkText = `Hand ${Math.round(hc.fps)} fps`;
      linkColor = UI.lichen;
    } else {
      linkText = 'Show your hand';
      linkColor = UI.amber;
    }
    w = 30 + this.measure(linkText, 14, 600) + 16;
    x = right - w;
    this.panel(x, y, w, h, 17);
    c.fillStyle = linkColor;
    for (let i = 0; i < 3; i++) {
      const on = linkColor === UI.lichen || linkColor === UI.sky || i === 0;
      c.globalAlpha = on ? 1 : 0.3;
      c.fillRect(x + 12 + i * 4, y + 22 - i * 4, 3, 4 + i * 4);
    }
    c.globalAlpha = 1;
    this.label(linkText, x + 30, y + 22, 14, UI.text, 600);
  }

  drawRace(S) {
    const r = S.race;
    const cx = this.VW / 2;
    const y = 78;
    const n = r.gates.length;

    if (!r.running) {
      const t = 'Fly through gate 1 to start a lap';
      const w = this.measure(t, 14, 500) + 28;
      this.panel(cx - w / 2, y, w, 28, 14, 'rgba(14,26,36,0.45)');
      this.label(t, cx, y + 19, 14, UI.dim, 500, FONT_TEXT, 'center');
      return;
    }

    const gateText = r.awaitingFinish ? 'Finish at gate 1' : `Gate ${r.next + 1} of ${n}`;
    const time = this.formatTime(r.elapsed(S.now));
    const best = r.best !== null ? `Best ${this.formatTime(r.best)}` : '';
    const w1 = this.measure(gateText, 15, 600);
    const w2 = this.measure(time, 20, 600, FONT_NUM);
    const w3 = best ? this.measure(best, 14, 500, FONT_NUM) : 0;
    const w = w1 + w2 + w3 + (best ? 60 : 44);
    let x = cx - w / 2;

    this.panel(x, y, w, 30, 15);
    x += 16;
    this.label(gateText, x, y + 20, 15, UI.signal, 600);
    x += w1 + 14;
    this.label(time, x, y + 22, 20, UI.text, 600, FONT_NUM);
    x += w2 + 14;
    if (best) this.label(best, x, y + 20, 14, UI.dim, 500, FONT_NUM);
  }


  // =====================================================
  // LEFT: ACTION BUTTONS
  // =====================================================

  drawButtons(S) {
    const c = this.ctx;
    const d = S.drone;
    const primary = {
      DISARMED: 'Take off', ARMING: 'Starting', TAKEOFF: 'Land', FLYING: 'Land',
      LANDING: 'Keep flying', LANDED: 'Take off', RTH: 'Land now', CRASHED: 'Reset drone',
    }[d.state];

    const list = [
      { id: 'takeoff', label: primary, key: 'Space', accent: true },
      { id: 'rth', label: d.state === 'RTH' ? 'Cancel return' : 'Return home', key: 'H' },
      { id: 'camera', label: `Camera: ${CAMERA_LABELS[S.cam.mode]}`, key: 'C' },
      { id: 'mode', label: `Mode: ${d.mode.label}`, key: 'F' },
      { id: 'hands', label: S.hands.twoHand ? 'Two hands' : 'One hand', key: 'T' },
      { id: 'wind', label: `Wind: ${S.windName}`, key: 'G' },
      { id: 'reset', label: 'Reset', key: 'R' },
      { id: 'help', label: 'Help', key: 'I' },
    ];

    const x = 18;
    const w = 176;
    const h = 36;
    let y = 66;

    for (const b of list) {
      const hover = this.hover === b.id;
      this.panel(x, y, w, h, 10, hover ? UI.inkHover : UI.ink);
      if (b.accent) {
        c.fillStyle = UI.signal;
        this.rr(x + 1, y + 7, 4, h - 14, 2);
        c.fill();
      }
      this.label(b.label, x + 14, y + 23, 15, UI.text, 600);

      const kw = this.measure(b.key, 11, 600, FONT_NUM) + 10;
      c.strokeStyle = UI.faint;
      c.lineWidth = 1;
      this.rr(x + w - kw - 10, y + 10, kw, 17, 4);
      c.stroke();
      this.label(b.key, x + w - 10 - kw / 2, y + 23, 11, UI.dim, 600, FONT_NUM, 'center');

      this.buttons.push({ id: b.id, x, y, w, h });
      y += h + 7;
    }
  }


  // =====================================================
  // RIGHT: HAND CAMERA + STICKS
  // =====================================================

  drawHandPanel(S) {
    const c = this.ctx;
    const hc = S.hands;
    const w = 272;
    const h = 204;
    const x = this.VW - 18 - w;
    const y = 62;
    this.handRect = { x, y, w, h };

    c.save();
    this.rr(x, y, w, h, 12);
    c.fillStyle = '#0e1a24';
    c.fill();
    c.clip();

    const v = hc.video && hc.video.elt;
    if (v && hc.cameraReady && v.readyState >= 2) {
      c.save();
      c.translate(x + w, y);
      c.scale(-1, 1);
      c.drawImage(v, 0, 0, w, h);
      c.restore();
      c.fillStyle = 'rgba(14,26,36,0.3)';
      c.fillRect(x, y, w, h);
    } else {
      const msg = hc.cameraFailed ? 'Camera unavailable' : 'Waiting for camera';
      this.label(msg, x + w / 2, y + h / 2 - 4, 15, UI.dim, 500, FONT_TEXT, 'center');
      if (hc.cameraFailed) {
        this.label('Fly with W A S D and the arrow keys', x + w / 2, y + h / 2 + 18, 13, UI.faint, 500, FONT_TEXT, 'center');
      }
    }

    const T = HAND_TUNING;
    const px = (nx) => x + nx * w;
    const py = (ny) => y + ny * h;

    const zone = (n) => {
      const zx = px(n.x);
      const zy = py(n.y);
      const rx = T.posRange * w;
      const ry = T.posRange * h;
      c.strokeStyle = 'rgba(242,246,249,0.4)';
      c.lineWidth = 1;
      c.setLineDash([4, 4]);
      c.strokeRect(zx - rx, zy - ry, rx * 2, ry * 2);
      c.setLineDash([]);
      c.fillStyle = 'rgba(242,246,249,0.1)';
      c.fillRect(zx - rx * T.deadzone, zy - ry * T.deadzone, rx * 2 * T.deadzone, ry * 2 * T.deadzone);
      return { zx, zy, rx, ry };
    };

    if (!hc.twoHand) {
      const z = zone(hc.neutral);
      this.label('Climb', z.zx, z.zy - z.ry - 5, 11, UI.dim, 600, FONT_TEXT, 'center');
      this.label('Descend', z.zx, z.zy + z.ry + 13, 11, UI.dim, 600, FONT_TEXT, 'center');

      if (hc.primary && hc.handVisible && hc.primary.fx !== undefined) {
        const hx = px(hc.primary.fx);
        const hy = py(hc.primary.fy);
        c.strokeStyle = UI.signal;
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(z.zx, z.zy);
        c.lineTo(hx, hy);
        c.stroke();
        c.fillStyle = UI.signal;
        c.beginPath();
        c.arc(hx, hy, 4, 0, FULL_TURN);
        c.fill();
      }
    } else {
      const zl = zone(hc.neutralL);
      const zr = zone(hc.neutralR);
      this.label('Climb / turn', zl.zx, zl.zy - zl.ry - 5, 11, UI.dim, 600, FONT_TEXT, 'center');
      this.label('Forward / slide', zr.zx, zr.zy - zr.ry - 5, 11, UI.dim, 600, FONT_TEXT, 'center');
    }

    // skeletons
    const colors = { fly: UI.lichen, pinch: UI.signal, brake: UI.sky, none: UI.text };
    for (const hand of hc.hands) {
      const p = hand.pts;
      c.strokeStyle = colors[hc.gesture] || UI.text;
      c.lineWidth = 2;
      c.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        c.moveTo(px(p[a].x), py(p[a].y));
        c.lineTo(px(p[b].x), py(p[b].y));
      }
      c.stroke();
      c.fillStyle = UI.text;
      for (const q of p) c.fillRect(px(q.x) - 1.5, py(q.y) - 1.5, 3, 3);
    }

    if (hc.pinchActive && hc.primary) {
      const p = hc.primary.pts;
      const mx = px((p[4].x + p[8].x) / 2);
      const my = py((p[4].y + p[8].y) / 2);
      c.strokeStyle = 'rgba(255,255,255,0.3)';
      c.lineWidth = 4;
      c.beginPath();
      c.arc(mx, my, 15, 0, FULL_TURN);
      c.stroke();
      c.strokeStyle = UI.signal;
      c.beginPath();
      c.arc(mx, my, 15, -Math.PI / 2, -Math.PI / 2 + FULL_TURN * hc.pinchProgress);
      c.stroke();
    }

    // caption
    const grounded = ['DISARMED', 'LANDED', 'CRASHED'].includes(S.drone.state);
    let caption;
    if (hc.cameraFailed || hc.status === 'error') caption = 'Use the keyboard to fly';
    else if (!hc.modelReady) caption = 'Loading hand tracking';
    else if (!hc.handVisible) caption = 'Show an open hand';
    else if (hc.gesture === 'pinch') caption = grounded ? 'Keep pinching to take off' : 'Keep pinching to land';
    else if (hc.gesture === 'brake') caption = 'Fist: braking and hovering';
    else caption = grounded ? 'Pinch and hold to take off' : 'Flying with your hand';

    const grad = c.createLinearGradient(0, y + h - 40, 0, y + h);
    grad.addColorStop(0, 'rgba(14,26,36,0)');
    grad.addColorStop(1, 'rgba(14,26,36,0.85)');
    c.fillStyle = grad;
    c.fillRect(x, y + h - 40, w, 40);
    this.label(caption, x + 12, y + h - 12, 14, UI.text, 600);
    c.restore();

    c.strokeStyle = UI.line;
    c.lineWidth = 1;
    this.rr(x, y, w, h, 12);
    c.stroke();
  }

  drawSticks(S) {
    const { x, y, w, h } = this.handRect;
    const top = y + h + 10;
    const ph = 126;
    this.panel(x, top, w, ph, 12);

    const s = S.sticks;
    const cy = top + 56;
    this.stick(x + w * 0.27, cy, 40, s.yaw, s.throttle);
    this.stick(x + w * 0.73, cy, 40, s.roll, s.pitch);
    this.label('Climb and turn', x + w * 0.27, top + ph - 10, 12, UI.dim, 500, FONT_TEXT, 'center');
    this.label('Forward and slide', x + w * 0.73, top + ph - 10, 12, UI.dim, 500, FONT_TEXT, 'center');

    const src = { hand: 'Hand', keyboard: 'Keyboard', autopilot: 'Autopilot' }[S.input];
    this.label(src, x + w / 2, top + 18, 11, UI.faint, 600, FONT_TEXT, 'center');
  }

  stick(cx, cy, r, sx, sy) {
    const c = this.ctx;
    c.fillStyle = 'rgba(0,0,0,0.25)';
    c.beginPath();
    c.arc(cx, cy, r, 0, FULL_TURN);
    c.fill();
    c.strokeStyle = UI.line;
    c.lineWidth = 1;
    c.stroke();

    c.strokeStyle = 'rgba(242,246,249,0.18)';
    c.beginPath();
    c.moveTo(cx - r, cy);
    c.lineTo(cx + r, cy);
    c.moveTo(cx, cy - r);
    c.lineTo(cx, cy + r);
    c.stroke();

    const kx = cx + sx * r * 0.8;
    const ky = cy - sy * r * 0.8;
    const active = Math.hypot(sx, sy) > 0.03;
    c.strokeStyle = active ? UI.signal : UI.faint;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(kx, ky);
    c.stroke();
    c.fillStyle = active ? UI.signal : UI.text;
    c.beginPath();
    c.arc(kx, ky, 8, 0, FULL_TURN);
    c.fill();
  }


  // =====================================================
  // BOTTOM: MINIMAP + TELEMETRY
  // =====================================================

  drawMinimap(S) {
    const c = this.ctx;
    const size = 176;
    const x = 18;
    const y = this.VH - 18 - size;
    const mm = S.world.map;
    const d = S.drone;
    const view = 440; // metres across
    const mpx = size / view;

    c.save();
    this.rr(x, y, size, size, 14);
    c.fillStyle = '#23331f';
    c.fill();
    c.clip();

    const srcPerM = mm.size / (mm.extent * 2);
    c.globalAlpha = 0.95;
    c.drawImage(
      mm.canvas,
      (d.pos.x - view / 2 + mm.extent) * srcPerM,
      (d.pos.z - view / 2 + mm.extent) * srcPerM,
      view * srcPerM, view * srcPerM,
      x, y, size, size
    );
    c.globalAlpha = 1;

    const toMap = (wx, wz) => [x + size / 2 + (wx - d.pos.x) * mpx, y + size / 2 + (wz - d.pos.z) * mpx];

    const [hx, hy] = toMap(HOME.x, HOME.z);
    c.strokeStyle = 'rgba(255,90,79,0.65)';
    c.lineWidth = 1.5;
    c.setLineDash([5, 4]);
    c.beginPath();
    c.arc(hx, hy, GEOFENCE_RADIUS * mpx, 0, FULL_TURN);
    c.stroke();
    c.setLineDash([]);

    const gates = S.world.gates;
    c.strokeStyle = 'rgba(255,122,26,0.45)';
    c.beginPath();
    gates.forEach((g, i) => {
      const [gx, gy] = toMap(g.x, g.z);
      if (i === 0) c.moveTo(gx, gy);
      else c.lineTo(gx, gy);
    });
    c.closePath();
    c.stroke();

    for (const g of gates) {
      const [gx, gy] = toMap(g.x, g.z);
      const next = g.index === S.race.next;
      const done = S.race.running && S.race.passed[g.index];
      c.fillStyle = next ? UI.signal : done ? UI.lichen : 'rgba(242,246,249,0.85)';
      c.beginPath();
      c.arc(gx, gy, next ? 7 : 5.5, 0, FULL_TURN);
      c.fill();
      this.label(String(g.index + 1), gx, gy + 3.5, 10, '#0e1a24', 700, FONT_NUM, 'center');
    }

    c.fillStyle = UI.sky;
    c.beginPath();
    c.arc(hx, hy, 7, 0, FULL_TURN);
    c.fill();
    this.label('H', hx, hy + 4, 11, '#0e1a24', 700, FONT_NUM, 'center');

    // camera view cone
    const fx = -S.cam.Z.x;
    const fz = -S.cam.Z.z;
    const look = Math.atan2(fx, -fz);
    const half = Math.atan(Math.tan(S.cam.fov / 2) * (S.cam.aspect || 1.6));
    c.fillStyle = 'rgba(242,246,249,0.14)';
    c.beginPath();
    c.moveTo(x + size / 2, y + size / 2);
    c.arc(x + size / 2, y + size / 2, 46, look - half - Math.PI / 2, look + half - Math.PI / 2);
    c.closePath();
    c.fill();

    c.save();
    c.translate(x + size / 2, y + size / 2);
    c.rotate(d.heading * DEG);
    c.fillStyle = UI.signal;
    c.strokeStyle = '#0e1a24';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(0, -9);
    c.lineTo(6.5, 7);
    c.lineTo(0, 3.5);
    c.lineTo(-6.5, 7);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
    c.restore();

    c.strokeStyle = UI.line;
    this.rr(x, y, size, size, 14);
    c.stroke();
    this.label('N', x + size / 2, y + 15, 12, UI.text, 700, FONT_NUM, 'center');
  }

  drawTelemetry(S) {
    const c = this.ctx;
    const d = S.drone;
    const w = 560;
    const h = 76;
    const x = this.VW / 2 - w / 2;
    const y = this.VH - 18 - h;
    this.panel(x, y, w, h, 14);

    this.attitude(x + 44, y + h / 2, 28, d.pitch, d.roll);

    const climb = Math.abs(d.vSpeed) < 0.05 ? 0 : d.vSpeed;
    const items = [
      ['Height', Math.max(0, d.agl).toFixed(1), 'm'],
      ['Speed', (d.speed * 3.6).toFixed(0), 'km/h'],
      ['Climb', (climb >= 0 ? '+' : '') + climb.toFixed(1), 'm/s'],
      ['Home', d.distHome.toFixed(0), 'm'],
    ];

    const colW = (w - 100) / 4;
    let cx = x + 94;
    for (const [name, value, unit] of items) {
      this.label(name, cx, y + 27, 13, UI.dim, 500);
      this.label(value, cx, y + 60, 30, UI.text, 600, FONT_NUM);
      const vw = this.measure(value, 30, 600, FONT_NUM);
      this.label(unit, cx + vw + 4, y + 60, 14, UI.dim, 500, FONT_NUM);
      cx += colW;
    }

    if (d.agl > ALTITUDE_LIMIT - 5) {
      c.fillStyle = UI.amber;
      this.label('Altitude limit', x + 94, y + h - 4, 11, UI.amber, 600);
    }
  }

  attitude(cx, cy, r, pitch, roll) {
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.arc(cx, cy, r, 0, FULL_TURN);
    c.clip();
    c.translate(cx, cy);
    c.rotate(-roll);
    const off = clampNum(pitch / (45 * DEG), -1, 1) * r * 0.9;
    c.fillStyle = '#4f86c6';
    c.fillRect(-r * 2, -r * 2 - off, r * 4, r * 2);
    c.fillStyle = '#7a5a3a';
    c.fillRect(-r * 2, -off, r * 4, r * 2);
    c.strokeStyle = '#ffffff';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(-r * 2, -off);
    c.lineTo(r * 2, -off);
    c.stroke();
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(255,255,255,0.6)';
    for (const deg of [-20, -10, 10, 20]) {
      const yy = -off - (deg / 45) * r * 0.9;
      const half = Math.abs(deg) === 10 ? 7 : 11;
      c.beginPath();
      c.moveTo(-half, yy);
      c.lineTo(half, yy);
      c.stroke();
    }
    c.restore();

    c.strokeStyle = UI.signal;
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(cx - 15, cy);
    c.lineTo(cx - 6, cy);
    c.lineTo(cx, cy + 5);
    c.lineTo(cx + 6, cy);
    c.lineTo(cx + 15, cy);
    c.stroke();
    c.strokeStyle = UI.line;
    c.lineWidth = 1;
    c.beginPath();
    c.arc(cx, cy, r, 0, FULL_TURN);
    c.stroke();
  }


  // =====================================================
  // MESSAGES
  // =====================================================

  drawToasts(dt) {
    const c = this.ctx;
    let y = this.VH * 0.2;
    const border = { info: UI.line, good: UI.lichen, warn: UI.amber, alert: UI.alert };

    for (const t of this.toasts) {
      t.t += dt;
      const a = Math.min(1, t.t * 6) * clampNum((t.life - t.t) * 3, 0, 1);
      if (a <= 0) continue;
      c.globalAlpha = a;
      const w = this.measure(t.text, 17, 600) + 36;
      const x = this.VW / 2 - w / 2;
      this.rr(x, y, w, 38, 19);
      c.fillStyle = 'rgba(14,26,36,0.78)';
      c.fill();
      c.strokeStyle = border[t.tone] || UI.line;
      c.lineWidth = t.tone === 'info' ? 1 : 2;
      c.stroke();
      this.label(t.text, this.VW / 2, y + 25, 17, UI.text, 600, FONT_TEXT, 'center');
      c.globalAlpha = 1;
      y += 46;
    }
    this.toasts = this.toasts.filter((t) => t.t < t.life);
  }

  drawCrash(S) {
    const w = 440;
    const h = 92;
    const x = this.VW / 2 - w / 2;
    const y = this.VH * 0.42;
    this.rr(x, y, w, h, 16);
    this.ctx.fillStyle = 'rgba(14,26,36,0.82)';
    this.ctx.fill();
    this.ctx.strokeStyle = UI.alert;
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
    this.label(S.crashText, this.VW / 2, y + 38, 22, UI.text, 600, FONT_TEXT, 'center');
    this.label('Press R, pinch, or choose Reset drone to try again', this.VW / 2, y + 66, 14, UI.dim, 500, FONT_TEXT, 'center');
  }


  // =====================================================
  // IN-WORLD MARKERS (real screen pixels)
  // =====================================================

  drawMarkers(S) {
    const c = this.ctx;
    const k = this.s;
    const W = this.W;
    const H = this.H;
    const margin = 70 * k;
    const d = S.drone;

    // ---- next gate ----
    const g = S.world.gates[S.race.next];
    const p = S.project(g.x, -g.h, g.z);
    const range = Math.hypot(g.x - d.pos.x, -g.h - d.pos.y, g.z - d.pos.z);
    const gateLabel = `Gate ${g.index + 1}  ${range.toFixed(0)} m`;
    c.font = `600 ${13 * k}px ${FONT_TEXT}`;
    c.textAlign = 'center';

    if (p.front && p.x > margin && p.x < W - margin && p.y > margin && p.y < H - margin) {
      const r = 9 * k;
      c.strokeStyle = UI.signal;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(p.x, p.y - r);
      c.lineTo(p.x + r, p.y);
      c.lineTo(p.x, p.y + r);
      c.lineTo(p.x - r, p.y);
      c.closePath();
      c.stroke();
      c.fillStyle = 'rgba(14,26,36,0.6)';
      const tw = c.measureText(gateLabel).width + 14 * k;
      c.fillRect(p.x - tw / 2, p.y + r + 6 * k, tw, 20 * k);
      c.fillStyle = UI.signal;
      c.fillText(gateLabel, p.x, p.y + r + 21 * k);
    } else {
      const ang = Math.atan2(p.y - H / 2, p.x - W / 2);
      const ex = W / 2 + Math.cos(ang) * (W / 2 - margin);
      const ey = H / 2 + Math.sin(ang) * (H / 2 - margin);
      c.save();
      c.translate(ex, ey);
      c.rotate(ang);
      c.fillStyle = UI.signal;
      c.beginPath();
      c.moveTo(14 * k, 0);
      c.lineTo(-6 * k, -9 * k);
      c.lineTo(-6 * k, 9 * k);
      c.closePath();
      c.fill();
      c.restore();
      c.fillStyle = UI.signal;
      c.fillText(gateLabel, ex - Math.cos(ang) * 34 * k, ey - Math.sin(ang) * 24 * k + 4 * k);
    }

    // ---- home marker ----
    if (d.distHome > 20) {
      const hp = S.project(HOME.x, -(S.world.padTop + 0.5), HOME.z);
      if (hp.front && hp.x > 0 && hp.x < W && hp.y > 0 && hp.y < H) {
        c.fillStyle = UI.sky;
        c.beginPath();
        c.arc(hp.x, hp.y, 9 * k, 0, FULL_TURN);
        c.fill();
        c.fillStyle = '#0e1a24';
        c.font = `700 ${12 * k}px ${FONT_NUM}`;
        c.fillText('H', hp.x, hp.y + 4 * k);
      }
    }

    // ---- pilot view: bracket around the drone ----
    if (S.cam.mode === 'pilot' && !d.sunk) {
      const dp = S.project(d.pos.x, d.pos.y, d.pos.z);
      if (dp.front) {
        const r = Math.max(12 * k, (0.5 / Math.max(dp.depth, 0.1)) * (H / 2) / S.cam.tanHalf);
        c.strokeStyle = UI.text;
        c.lineWidth = 1.5;
        const L = r * 0.45;
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          c.beginPath();
          c.moveTo(dp.x + sx * r, dp.y + sy * (r - L));
          c.lineTo(dp.x + sx * r, dp.y + sy * r);
          c.lineTo(dp.x + sx * (r - L), dp.y + sy * r);
          c.stroke();
        }
        c.font = `600 ${12 * k}px ${FONT_TEXT}`;
        c.fillStyle = UI.text;
        c.fillText(`${dp.depth.toFixed(0)} m away, ${Math.max(0, d.agl).toFixed(0)} m up`, dp.x, dp.y + r + 16 * k);
      }
    }
  }

  drawReticle(S) {
    const c = this.ctx;
    const k = this.s;
    const cx = this.W / 2;
    const cy = this.H / 2;
    c.strokeStyle = 'rgba(255,255,255,0.75)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(cx, cy, 6 * k, 0, FULL_TURN);
    c.moveTo(cx - 26 * k, cy);
    c.lineTo(cx - 12 * k, cy);
    c.moveTo(cx + 12 * k, cy);
    c.lineTo(cx + 26 * k, cy);
    c.stroke();
  }
}
