/** 无分配对象池：acquire/release，避免 GC 尖刺；可选硬顶（满则复用最老） */
export class Pool {
  constructor(factory, initial = 64, maxLive = 0) {
    this.factory = factory;
    this.free = [];
    this.live = [];
    this.maxLive = maxLive | 0;
    for (let i = 0; i < initial; i++) this.free.push(factory());
  }

  acquire() {
    if (this.maxLive > 0 && this.live.length >= this.maxLive && !this.free.length) {
      const oldest = this.live[0];
      if (oldest) this.release(oldest);
    }
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

/** 均匀网格空间哈希，查询邻域 O(k)；桶复用 + 偏置键防负坐标碰撞 */
export class SpatialHash {
  constructor(cellSize = 96) {
    this.cellSize = cellSize;
    this.map = new Map();
    this.bucketPool = [];
  }

  key(cx, cy) {
    return ((cx + 1024) << 16) | ((cy + 1024) & 0xffff);
  }

  clear() {
    for (const bucket of this.map.values()) {
      bucket.length = 0;
      this.bucketPool.push(bucket);
    }
    this.map.clear();
  }

  insert(x, y, item) {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const k = this.key(cx, cy);
    let bucket = this.map.get(k);
    if (!bucket) {
      bucket = this.bucketPool.length ? this.bucketPool.pop() : [];
      this.map.set(k, bucket);
    }
    bucket.push(item);
  }

  query(x, y, radius, out) {
    out.length = 0;
    const cs = this.cellSize;
    const minX = Math.floor((x - radius) / cs);
    const maxX = Math.floor((x + radius) / cs);
    const minY = Math.floor((y - radius) / cs);
    const maxY = Math.floor((y + radius) / cs);
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
/** 归一化；传入 out 可避免分配。无 out 时返回新数组（勿复用共享缓冲，防连环调用串值） */
export function norm(x, y, out) {
  const l = Math.hypot(x, y) || 1;
  const nx = x / l;
  const ny = y / l;
  if (out) {
    out[0] = nx;
    out[1] = ny;
    return out;
  }
  return [nx, ny];
}
export function rand(a, b) { return a + Math.random() * (b - a); }
export function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
export function chance(p) { return Math.random() < p; }
