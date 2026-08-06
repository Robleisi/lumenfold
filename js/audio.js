/** 轻量程序音效，不依赖外部资源 */
export class AudioBus {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.master = 0.18;
    this.sfx = 1;
    this.muted = false;
  }

  applySettings(s) {
    this.muted = !!s.muted;
    this.enabled = !this.muted;
    this.master = Math.max(0, Math.min(1, (s.masterVol ?? 70) / 100)) * 0.28;
    this.sfx = Math.max(0, Math.min(1, (s.sfxVol ?? 100) / 100));
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
  hit() { this.tone({ freq: 180, dur: 0.07, type: "square", gain: 0.12, slide: -80 }); }
  dash() { this.tone({ freq: 320, dur: 0.12, type: "sine", gain: 0.16, slide: 260 }); }
  pickup() { this.tone({ freq: 520, dur: 0.08, type: "sine", gain: 0.14 }); this.tone({ freq: 780, dur: 0.1, type: "sine", gain: 0.1, delay: 0.05 }); }
  hurt() { this.tone({ freq: 110, dur: 0.18, type: "sawtooth", gain: 0.14, slide: -60 }); }
  win() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone({ freq: f, dur: 0.15, type: "sine", gain: 0.12, delay: i * 0.08 }));
  }
  ui() { this.tone({ freq: 440, dur: 0.04, type: "triangle", gain: 0.08 }); }
}
