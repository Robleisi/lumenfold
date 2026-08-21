import { Pool, rand } from "./util.js";

function makeParticle() {
  return {
    active: false,
    x: 0, y: 0, vx: 0, vy: 0,
    life: 0, maxLife: 0,
    size: 2, growth: 0,
    r: 255, g: 200, b: 80, a: 1,
    drag: 0.98, gravity: 0,
    spark: false,
    _css: "",
    _key: 0,
  };
}

/** 固定上限粒子系统，满了就复用最老的 */
export class Particles {
  constructor(max = 500) {
    this.max = max;
    this.pool = new Pool(makeParticle, max);
    /** 客机也可本地刷粒子（联机不再同步粒子载荷） */
    this.suppressLocal = false;
    /** 画质：爆发数量倍率 / 是否画火花线 */
    this.fxScale = 1;
    this.allowSparks = true;
    /** 低画质用方块代替圆，减少路径开销 */
    this.useRects = false;
    while (this.pool.free.length < max) this.pool.free.push(makeParticle());
  }

  clear() { this.pool.clear(); }

  spawn(opts) {
    if (this.suppressLocal && !opts?.net) return null;
    let p;
    if (this.pool.count >= this.max) {
      p = this.pool.live[0];
      this.pool.release(p);
      p = this.pool.acquire();
    } else {
      p = this.pool.acquire();
    }
    p.x = opts.x; p.y = opts.y;
    p.vx = opts.vx || 0; p.vy = opts.vy || 0;
    p.life = opts.life || 0.5;
    p.maxLife = opts.maxLife != null ? opts.maxLife : p.life;
    if (p.maxLife < p.life) p.maxLife = p.life;
    p.size = opts.size || 3;
    p.growth = opts.growth || 0;
    p.r = opts.r ?? 232; p.g = opts.g ?? 154; p.b = opts.b ?? 45; p.a = opts.a ?? 1;
    p.drag = opts.drag ?? 0.97;
    p.gravity = opts.gravity ?? 0;
    p.spark = this.allowSparks && !!opts.spark;
    p._css = `rgb(${p.r | 0},${p.g | 0},${p.b | 0})`;
    // 粗量化颜色键，便于批绘制
    p._key = ((p.r >> 3) << 10) | ((p.g >> 3) << 5) | (p.b >> 3) | (p.spark ? 0x8000 : 0);
    return p;
  }

  burst(x, y, n, style = {}) {
    if (this.suppressLocal) return;
    const count = Math.max(0, Math.round(n * (this.fxScale ?? 1)));
    for (let i = 0; i < count; i++) {
      const ang = rand(0, Math.PI * 2);
      const spd = rand(style.spdMin ?? 40, style.spdMax ?? 220);
      this.spawn({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life: rand(style.lifeMin ?? 0.25, style.lifeMax ?? 0.7),
        size: rand(style.sizeMin ?? 2, style.sizeMax ?? 5),
        growth: style.growth ?? -2,
        r: style.r ?? 232, g: style.g ?? 180, b: style.b ?? 70,
        a: style.a ?? 1,
        drag: style.drag ?? 0.94,
        gravity: style.gravity ?? 0,
        spark: style.spark,
      });
    }
  }

  trail(x, y, vx, vy, style = {}) {
    if (this.suppressLocal) return;
    if ((this.fxScale ?? 1) < 0.5 && Math.random() > (this.fxScale ?? 1) * 1.4) return;
    this.spawn({
      x: x + rand(-2, 2),
      y: y + rand(-2, 2),
      vx: -vx * 0.15 + rand(-20, 20),
      vy: -vy * 0.15 + rand(-20, 20),
      life: rand(0.15, 0.35),
      size: rand(2, 4),
      growth: -4,
      r: style.r ?? 180, g: style.g ?? 230, b: style.b ?? 210,
    });
  }

  /**
   * 压缩联机快照（已默认不传；保留接口兼容）。
   * [x,y,vx,vy,life40,max40,size4,r,g,b,flags]
   */
  toSnapshot(limit = 80) {
    const live = this.pool.live;
    const n = Math.min(live.length, Math.max(0, limit | 0));
    if (!n) return [];
    const start = live.length - n;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = live[start + i];
      const growthBits = Math.max(0, Math.min(15, (Math.round(p.growth) + 8))) & 15;
      out[i] = [
        p.x | 0, p.y | 0,
        Math.round(p.vx), Math.round(p.vy),
        Math.max(1, Math.round(p.life * 40)),
        Math.max(1, Math.round(p.maxLife * 40)),
        Math.max(1, Math.round(p.size * 4)),
        p.r | 0, p.g | 0, p.b | 0,
        (p.spark ? 1 : 0) | (growthBits << 1),
      ];
    }
    return out;
  }

  applySnapshot(rows) {
    this.clear();
    if (!rows?.length) return;
    const prev = this.suppressLocal;
    this.suppressLocal = false;
    try {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 10) continue;
        const flags = row[10] | 0;
        const growth = ((flags >> 1) & 15) - 8;
        const life = (row[4] || 1) / 40;
        const maxLife = Math.max(life, (row[5] || row[4] || 1) / 40);
        this.spawn({
          net: true,
          x: row[0], y: row[1],
          vx: row[2], vy: row[3],
          life, maxLife,
          size: (row[6] || 8) / 4,
          r: row[7], g: row[8], b: row[9],
          spark: !!(flags & 1),
          growth,
          drag: 0.94,
          a: 1,
        });
      }
    } finally {
      this.suppressLocal = prev;
    }
  }

  update(dt) {
    const live = this.pool.live;
    const frames = dt * 60;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        live[i] = live[live.length - 1];
        live.pop();
        this.pool.free.push(p);
        continue;
      }
      const drag = Math.pow(p.drag, frames);
      p.vx *= drag;
      p.vy = p.vy * drag + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size += p.growth * dt;
      if (p.size < 0.2) p.size = 0.2;
    }
  }

  draw(ctx) {
    const live = this.pool.live;
    const n = live.length;
    if (!n) {
      ctx.globalAlpha = 1;
      return;
    }

    // 按颜色键排序后批绘，减少 fillStyle 切换
    if (n > 24) {
      live.sort((a, b) => a._key - b._key);
    }

    const useRects = this.useRects || (this.fxScale ?? 1) < 0.55;
    let lastCss = "";
    let batchOpen = false;

    const flushDots = () => {
      if (batchOpen) {
        ctx.fill();
        batchOpen = false;
      }
    };

    for (let i = 0; i < n; i++) {
      const p = live[i];
      const t = p.life / p.maxLife;
      const alpha = p.a * t;
      if (p._css !== lastCss) {
        flushDots();
        lastCss = p._css;
        ctx.fillStyle = lastCss;
        ctx.strokeStyle = lastCss;
      }
      ctx.globalAlpha = alpha;

      if (p.spark) {
        flushDots();
        ctx.lineWidth = Math.max(1, p.size * 0.5);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
        ctx.stroke();
      } else if (useRects) {
        flushDots();
        const s = Math.max(1.2, p.size * 1.6);
        ctx.fillRect(p.x - s * 0.5, p.y - s * 0.5, s, s);
      } else {
        if (!batchOpen) {
          ctx.beginPath();
          batchOpen = true;
        }
        ctx.moveTo(p.x + p.size, p.y);
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      }
    }
    flushDots();
    ctx.globalAlpha = 1;
  }
}
