/** 无分配对象池：acquire/release，避免 GC 尖刺 */
export class Pool {
  constructor(factory, initial = 64) {
    this.factory = factory;
    this.free = [];
    this.live = [];
    for (let i = 0; i < initial; i++) this.free.push(factory());
  }

  acquire() {
    const obj = this.free.length ? this.free.pop() : this.factory();
    obj.active = true;
    this.live.push(obj);
    return obj;
  }

  release(obj) {
    obj.active = false;
    const i = this.live.indexOf(obj);
    if (i >= 0) {
      const last = this.live.pop();
      if (i < this.live.length) this.live[i] = last;
    }
    this.free.push(obj);
  }

  releaseDead(isDead) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const o = this.live[i];
      if (isDead(o)) {
        o.active = false;
        this.live[i] = this.live[this.live.length - 1];
        this.live.pop();
        this.free.push(o);
      }
    }
  }

  clear() {
    while (this.live.length) {
      const o = this.live.pop();
      o.active = false;
      this.free.push(o);
    }
  }

  get count() { return this.live.length; }
}

/** 均匀网格空间哈希，查询邻域 O(k) */
export class SpatialHash {
  constructor(cellSize = 96) {
    this.cellSize = cellSize;
    this.map = new Map();
  }

  key(cx, cy) { return (cx << 16) ^ (cy & 0xffff); }

  clear() { this.map.clear(); }

  insert(x, y, item) {
    const cx = (x / this.cellSize) | 0;
    const cy = (y / this.cellSize) | 0;
    const k = this.key(cx, cy);
    let bucket = this.map.get(k);
    if (!bucket) {
      bucket = [];
      this.map.set(k, bucket);
    }
    bucket.push(item);
  }

  query(x, y, radius, out) {
    out.length = 0;
    const cs = this.cellSize;
    const minX = ((x - radius) / cs) | 0;
    const maxX = ((x + radius) / cs) | 0;
    const minY = ((y - radius) / cs) | 0;
    const maxY = ((y + radius) / cs) | 0;
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const bucket = this.map.get(this.key(cx, cy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out;
  }
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function len(x, y) { return Math.hypot(x, y); }
export function norm(x, y) {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}
export function rand(a, b) { return a + Math.random() * (b - a); }
export function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
export function chance(p) { return Math.random() < p; }
