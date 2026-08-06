import { Pool, rand } from "./util.js";

function makeParticle() {
  return {
    active: false,
    x: 0, y: 0, vx: 0, vy: 0,
    life: 0, maxLife: 0,
    size: 2, growth: 0,
    r: 255, g: 200, b: 80, a: 1,
    drag: 0.98, gravity: 0,
    spark: false, soft: true,
  };
}

/** 固定上限粒子系统，满了就复用最老的 */
export class Particles {
  constructor(max = 500) {
    this.max = max;
    this.pool = new Pool(makeParticle, max);
    while (this.pool.free.length < max) this.pool.free.push(makeParticle());
  }

  clear() { this.pool.clear(); }

  spawn(opts) {
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
    p.maxLife = p.life;
    p.size = opts.size || 3;
    p.growth = opts.growth || 0;
    p.r = opts.r ?? 232; p.g = opts.g ?? 154; p.b = opts.b ?? 45; p.a = opts.a ?? 1;
    p.drag = opts.drag ?? 0.97;
    p.gravity = opts.gravity ?? 0;
    p.spark = !!opts.spark;
    p.soft = opts.soft !== false;
    return p;
  }

  burst(x, y, n, style = {}) {
    for (let i = 0; i < n; i++) {
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
        soft: style.soft,
      });
    }
  }

  trail(x, y, vx, vy, style = {}) {
    this.spawn({
      x: x + rand(-2, 2),
      y: y + rand(-2, 2),
      vx: -vx * 0.15 + rand(-20, 20),
      vy: -vy * 0.15 + rand(-20, 20),
      life: rand(0.15, 0.35),
      size: rand(2, 4),
      growth: -4,
      r: style.r ?? 180, g: style.g ?? 230, b: style.b ?? 210,
      soft: true,
    });
  }

  update(dt) {
    const live = this.pool.live;
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
      p.vx *= p.drag;
      p.vy = p.vy * p.drag + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size += p.growth * dt;
      if (p.size < 0.2) p.size = 0.2;
    }
  }

  draw(ctx) {
    const live = this.pool.live;
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      const t = p.life / p.maxLife;
      const a = p.a * t;
      ctx.globalAlpha = a;
      if (p.spark) {
        ctx.strokeStyle = `rgb(${p.r|0},${p.g|0},${p.b|0})`;
        ctx.lineWidth = Math.max(1, p.size * 0.5);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgb(${p.r|0},${p.g|0},${p.b|0})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}
