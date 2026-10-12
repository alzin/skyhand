// =====================================================
//  audio.js — synthesised rotor sound (Web Audio API)
// =====================================================
//
//  Each motor = sawtooth + triangle at its blade-pass
//  frequency (rpm / 60 x 2 blades). Four slightly
//  different speeds give the real "beating" drone hum.
//  Filtered noise adds the rush of prop wash. From the
//  pilot's view on the ground you also get distance
//  fade, air absorption, stereo panning and Doppler.

class DroneAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3.5;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // drone -> bus -> air absorption -> stereo pan -> master
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.air = ctx.createBiquadFilter();
    this.air.type = 'lowpass';
    this.air.frequency.value = 9000;
    this.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    this.bus.connect(this.air);
    if (this.pan) {
      this.air.connect(this.pan);
      this.pan.connect(this.master);
    } else {
      this.air.connect(this.master);
    }

    this.motors = [];
    for (let i = 0; i < 4; i++) {
      const saw = ctx.createOscillator();
      const tri = ctx.createOscillator();
      const lp = ctx.createBiquadFilter();
      const g = ctx.createGain();
      const triGain = ctx.createGain();

      saw.type = 'sawtooth';
      tri.type = 'triangle';
      saw.frequency.value = 60;
      tri.frequency.value = 120;
      lp.type = 'lowpass';
      lp.Q.value = 0.8;
      lp.frequency.value = 900;
      g.gain.value = 0;
      triGain.gain.value = 0.5;

      saw.connect(lp);
      tri.connect(triGain);
      triGain.connect(lp);
      lp.connect(g);
      g.connect(this.bus);
      saw.start();
      tri.start();
      this.motors.push({ saw, tri, lp, g });
    }

    this.noiseBuf = this.makeNoise(2);

    this.wash = ctx.createBufferSource();
    this.wash.buffer = this.noiseBuf;
    this.wash.loop = true;
    this.washBP = ctx.createBiquadFilter();
    this.washBP.type = 'bandpass';
    this.washBP.frequency.value = 700;
    this.washBP.Q.value = 0.7;
    this.washGain = ctx.createGain();
    this.washGain.gain.value = 0;
    this.wash.connect(this.washBP);
    this.washBP.connect(this.washGain);
    this.washGain.connect(this.bus);
    this.wash.start();

    // air rushing past the camera in FPV
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = this.noiseBuf;
    this.windSrc.loop = true;
    this.windSrc.playbackRate.value = 0.7;
    this.windLP = ctx.createBiquadFilter();
    this.windLP.type = 'lowpass';
    this.windLP.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(this.windLP);
    this.windLP.connect(this.windGain);
    this.windGain.connect(this.master);
    this.windSrc.start();

    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, ctx.currentTime, 0.4);
    this.ready = true;
  }

  makeNoise(seconds) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ready) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.1);
    }
    return this.muted;
  }

  update(drone, cam) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;

    const dx = drone.pos.x - cam.eye.x;
    const dy = drone.pos.y - cam.eye.y;
    const dz = drone.pos.z - cam.eye.z;
    const range = Math.max(0.3, Math.hypot(dx, dy, dz));
    const onboard = cam.mode === 'fpv' || cam.mode === 'gimbal';

    const away = (drone.vel.x * dx + drone.vel.y * dy + drone.vel.z * dz) / range;
    const doppler = onboard ? 1 : clampNum(343 / (343 + away), 0.85, 1.18);
    const level = onboard ? 0.5 : clampNum(3.5 / (range + 1.5), 0, 1);
    const cutoff = onboard ? 9000 : clampNum(12000 / (1 + range / 18), 500, 9000);
    let pan = 0;
    if (!onboard && cam.X) pan = clampNum((dx * cam.X.x + dy * cam.X.y + dz * cam.X.z) / range, -1, 1) * 0.8;

    const running = drone.motorRPM.some((r) => r > 50);
    this.bus.gain.setTargetAtTime(running ? level : 0, t, 0.08);
    this.air.frequency.setTargetAtTime(cutoff, t, 0.1);
    if (this.pan) this.pan.pan.setTargetAtTime(pan, t, 0.1);

    let avg = 0;
    for (let i = 0; i < 4; i++) {
      const rpm = drone.motorRPM[i];
      const m = this.motors[i];
      const f = Math.max(20, (rpm / 60) * 2 * doppler);
      avg += rpm / 4;
      m.saw.frequency.setTargetAtTime(f, t, 0.04);
      m.tri.frequency.setTargetAtTime(f * 2.02, t, 0.04);
      m.lp.frequency.setTargetAtTime(300 + rpm * 0.32, t, 0.05);
      m.g.gain.setTargetAtTime(0.11 * Math.pow(rpm / DRONE.MAX_RPM, 1.5), t, 0.05);
    }
    this.washGain.gain.setTargetAtTime(0.22 * Math.pow(avg / DRONE.MAX_RPM, 2), t, 0.08);
    this.washBP.frequency.setTargetAtTime(400 + avg * 0.15, t, 0.1);

    const airflow = onboard ? clampNum(drone.speed / 18, 0, 1) : 0;
    this.windGain.gain.setTargetAtTime(0.3 * airflow * airflow, t, 0.2);
    this.windLP.frequency.setTargetAtTime(300 + airflow * 1400, t, 0.2);
  }

  tone(freq, start, dur, type = 'sine', vol = 0.12, slideTo = 0) {
    const ctx = this.ctx;
    const t = ctx.currentTime + start;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  noise(start, dur, freq, vol, type = 'lowpass') {
    const ctx = this.ctx;
    const t = ctx.currentTime + start;
    const src = ctx.createBufferSource();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    src.buffer = this.noiseBuf;
    f.type = type;
    f.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  play(name) {
    if (!this.ready || this.muted) return;

    switch (name) {
      case 'arm':
        this.tone(523, 0, 0.12);
        this.tone(659, 0.14, 0.12);
        this.tone(784, 0.28, 0.22);
        break;
      case 'disarm':
        this.tone(784, 0, 0.12);
        this.tone(523, 0.14, 0.22);
        break;
      case 'gate':
        this.tone(880, 0, 0.12, 'triangle', 0.14);
        this.tone(1320, 0.1, 0.24, 'triangle', 0.12);
        break;
      case 'lap':
        [660, 880, 1100, 1320].forEach((f, i) => this.tone(f, i * 0.09, 0.26, 'triangle', 0.12));
        break;
      case 'warn':
        this.tone(1046, 0, 0.1, 'square', 0.05);
        this.tone(1046, 0.18, 0.1, 'square', 0.05);
        break;
      case 'crash':
        this.noise(0, 0.7, 900, 0.5);
        this.tone(90, 0, 0.5, 'sine', 0.35, 40);
        break;
      case 'splash':
        this.noise(0, 1.0, 1800, 0.35, 'bandpass');
        break;
      case 'thud':
        this.noise(0, 0.15, 300, 0.25);
        break;
      case 'bump':
        this.noise(0, 0.08, 600, 0.12);
        break;
      case 'shutter':
        this.noise(0, 0.05, 3000, 0.22, 'highpass');
        this.noise(0.08, 0.04, 2500, 0.16, 'highpass');
        break;
      case 'click':
        this.tone(1500, 0, 0.04, 'square', 0.03);
        break;
    }
  }
}
