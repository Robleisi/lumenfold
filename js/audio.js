/** 轻量程序音效 + 简易循环 BGM，不依赖外部资源 */
export class AudioBus {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.master = 0.18;
    this.sfx = 1;
    this.bgm = 0.55;
    this.muted = false;
    this._bgmMode = null;
    this._bgmNodes = null;
    this._bgmTimer = null;
  }

  applySettings(s) {
    this.muted = !!s.muted;
    this.enabled = !this.muted;
    this.master = Math.max(0, Math.min(1, (s.masterVol ?? 70) / 100)) * 0.28;
    this.sfx = Math.max(0, Math.min(1, (s.sfxVol ?? 100) / 100));
    this.bgm = Math.max(0, Math.min(1, (s.bgmVol ?? 55) / 100));
    this._refreshBgmGain();
    if (this.muted) this.stopBgm(true);
    else if (this._bgmMode) this.startBgm(this._bgmMode);
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  tone({ freq = 440, dur = 0.08, type = "sine", gain = 0.2, slide = 0, delay = 0 }) {
    if (!this.enabled || this.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const vol = Math.max(0.0001, gain * this.master * this.sfx);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  shoot() { this.tone({ freq: 680, dur: 0.05, type: "triangle", gain: 0.15, slide: -220 }); }
  hit() {
    const now = performance.now();
    if (now - (this._lastHitAt || 0) < 45) return;
    this._lastHitAt = now;
    this.tone({ freq: 180, dur: 0.07, type: "square", gain: 0.1, slide: -80 });
  }
  dash() { this.tone({ freq: 320, dur: 0.12, type: "sine", gain: 0.16, slide: 260 }); }
  pickup() { this.tone({ freq: 520, dur: 0.08, type: "sine", gain: 0.14 }); this.tone({ freq: 780, dur: 0.1, type: "sine", gain: 0.1, delay: 0.05 }); }
  hurt() { this.tone({ freq: 110, dur: 0.18, type: "sawtooth", gain: 0.14, slide: -60 }); }
  win() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone({ freq: f, dur: 0.15, type: "sine", gain: 0.12, delay: i * 0.08 }));
  }
  ui() { this.tone({ freq: 440, dur: 0.04, type: "triangle", gain: 0.08 }); }

  /** @param {"menu"|"battle"|null} mode */
  startBgm(mode) {
    if (!mode) return this.stopBgm();
    this._bgmMode = mode;
    if (this.muted || this.bgm <= 0.01) {
      this.stopBgm(true);
      return;
    }
    const ctx = this.ensure();
    if (!ctx) return;
    if (this._bgmNodes?.mode === mode) {
      this._refreshBgmGain();
      return;
    }
    this.stopBgm(true);
    const master = ctx.createGain();
    master.gain.value = this._bgmGainValue();
    master.connect(ctx.destination);

    const specs = mode === "battle"
      ? [
          { freq: 110, type: "sine", gain: 0.22 },
          { freq: 164.81, type: "triangle", gain: 0.1 },
          { freq: 246.94, type: "sine", gain: 0.07 },
        ]
      : [
          { freq: 130.81, type: "sine", gain: 0.18 },
          { freq: 196, type: "sine", gain: 0.1 },
          { freq: 261.63, type: "triangle", gain: 0.06 },
        ];

    const oscs = specs.map((s) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      osc.type = s.type;
      osc.frequency.value = s.freq;
      g.gain.value = s.gain;
      lfo.frequency.value = mode === "battle" ? 0.18 : 0.08;
      lfoGain.gain.value = mode === "battle" ? 4.5 : 2.2;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      osc.connect(g);
      g.connect(master);
      osc.start();
      lfo.start();
      return { osc, g, lfo };
    });

    this._bgmNodes = { mode, master, oscs };
  }

  stopBgm(keepMode = false) {
    if (this._bgmTimer) {
      clearInterval(this._bgmTimer);
      this._bgmTimer = null;
    }
    if (this._bgmNodes) {
      try {
        for (const n of this._bgmNodes.oscs) {
          n.osc.stop();
          n.lfo.stop();
        }
      } catch { /* */ }
      try { this._bgmNodes.master.disconnect(); } catch { /* */ }
      this._bgmNodes = null;
    }
    if (!keepMode) this._bgmMode = null;
  }

  _bgmGainValue() {
    return Math.max(0.0001, this.master * this.bgm * 0.55);
  }

  _refreshBgmGain() {
    if (!this._bgmNodes) return;
    const ctx = this.ctx;
    if (!ctx) return;
    this._bgmNodes.master.gain.setTargetAtTime(this._bgmGainValue(), ctx.currentTime, 0.05);
  }
}
