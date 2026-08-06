import { Pool, SpatialHash, clamp, lerp, norm, rand, pick, chance, len } from "./util.js";
import { Particles } from "./particles.js";
import {
  FOLDS, RELICS, ENEMIES, BOSSES, BIOMES, SYNERGIES, RARITY, isUnlocked,
} from "./content.js";
import { markSeen } from "./save.js";
import { scaleForPlayers } from "./net/protocol.js";

function makeBullet() {
  return {
    active: false, x: 0, y: 0, vx: 0, vy: 0, r: 4, damage: 10,
    life: 1, pierce: 0, chain: 0, fromPlayer: true, ink: false, lace: false,
    hit: null, color: [255, 200, 80],
  };
}
function makeEnemy() {
  return {
    active: false, id: "", x: 0, y: 0, vx: 0, vy: 0, r: 12,
    hp: 10, maxHp: 10, damage: 8, speed: 80, score: 1,
    flash: 0, cd: 0, stateT: 0, elite: false, boss: false,
    ranged: false, charge: false, explode: false, stealth: false,
    spread: false, split: false, orbit: false, block: false,
    hidden: false, ang: 0, color: [100, 140, 130], accent: [255, 255, 255],
    shape: "mite", slow: 0, burn: 0, name: "",
  };
}
function makePickup() {
  return { active: false, x: 0, y: 0, kind: "dust", value: 1, life: 0, r: 8 };
}
function makeField() {
  return {
    active: false, x: 0, y: 0, r: 40, life: 0.5, kind: "lace",
    damage: 0, slow: 0, pull: 0, color: [255, 180, 80],
  };
}
function makeFloat() {
  return { active: false, x: 0, y: 0, vy: -40, text: "", life: 0.8, color: "#fff" };
}

export class Game {
  constructor(canvas, audio, save, hooks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    this.audio = audio;
    this.save = save;
    this.hooks = hooks;

    this.w = 0; this.h = 0;
    this.dpr = 1;
    this.time = 0;
    this.shake = 0;
    this.state = "idle"; // idle | playing | pick | pause | result

    this.particles = new Particles(560);
    this.bullets = new Pool(makeBullet, 160);
    this.enemies = new Pool(makeEnemy, 96);
    this.pickups = new Pool(makePickup, 48);
    this.fields = new Pool(makeField, 40);
    this.floats = new Pool(makeFloat, 48);
    this.hash = new SpatialHash(96);
    this.queryBuf = [];

    this.keys = Object.create(null);
    this.mouse = { x: 0, y: 0, down: false, right: false };
    this._bindInput();

    this.player = null;
    this.folds = [];
    this.relics = [];
    this.synergies = [];
    this.floor = 1;
    this.maxFloors = 8;
    this.biome = BIOMES.sun_paper;
    this.room = 0;
    this.roomsPerFloor = 4;
    this.kills = 0;
    this.dustEarned = 0;
    this.waveTimer = 0;
    this.clearDelay = 0;
    this.roomDone = false;
    this.pendingPicks = 0;
    this.phoenixUsed = false;
    this.birds = [];
    this.creaseTrails = [];
    this.bgSeed = 1;
    this.fps = 60;
    this._frames = 0;
    this._fpsT = 0;

    // 割草手感 / 联机
    this.playerCount = 1;
    this.netRole = "solo"; // solo | host | client
    this.session = null;
    this.remotes = new Map(); // id -> {x,y,hp,aimX,aimY,name}
    this.remoteInputs = new Map();
    this.killStreak = 0;
    this.streakTimer = 0;
    this.hitstop = 0;
    this.swarmLeft = 0;
    this.swarmCd = 0;
    this.snapAcc = 0;
    this.tutorial = null;
    this.easyEarly = true;
    this.flashAlpha = 0;
    this.vacuumT = 0;
    this.delayed = [];
    this.clearFanfare = 0;

    this.resize();
  }

  applySettings(settings) {
    this.settings = settings;
    const q = settings?.quality === "low" ? { dprCap: 1, particles: 220, shake: 0.45, trails: false }
      : settings?.quality === "high" ? { dprCap: 2, particles: 560, shake: 1, trails: true }
        : { dprCap: 1.5, particles: 400, shake: 0.75, trails: true };
    this._dprCap = q.dprCap;
    this.particles.max = q.particles;
    this.shakeMul = (settings?.screenShake === false ? 0 : 1) * q.shake;
    this.showFps = settings?.showFps !== false;
    this.reduceFlash = !!settings?.reduceFlash;
    this.drawTrails = q.trails;
    this.resize();
  }

  setSession(session) {
    this.session = session;
    this.netRole = session?.role === "host" ? "host" : session?.role === "client" ? "client" : "solo";
    this.playerCount = session?.playerCount || 1;
  }

  setTutorial(tutorial) {
    this.tutorial = tutorial;
  }

  _bindInput() {
    window.addEventListener("keydown", (e) => {
      this.keys[e.code] = true;
      if (e.code === "Escape" && this.state === "playing") this.hooks.onPause();
      if (e.code === "Space") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => { this.keys[e.code] = false; });
    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = (e.clientX - rect.left) * (this.w / rect.width);
      this.mouse.y = (e.clientY - rect.top) * (this.h / rect.height);
    });
    this.canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.mouse.down = true;
      if (e.button === 2) this.mouse.right = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouse.down = false;
      if (e.button === 2) this.mouse.right = false;
    });
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  resize() {
    const cap = this._dprCap || 2;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    this.dpr = dpr;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = (this.w * dpr) | 0;
    this.canvas.height = (this.h * dpr) | 0;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  startRun() {
    this.particles.clear();
    this.bullets.clear();
    this.enemies.clear();
    this.pickups.clear();
    this.fields.clear();
    this.floats.clear();
    this.creaseTrails.length = 0;
    this.birds.length = 0;
    this.remotes.clear();
    this.remoteInputs.clear();
    this.killStreak = 0;
    this.streakTimer = 0;
    this.hitstop = 0;
    this.flashAlpha = 0;
    this.vacuumT = 0;
    this.clearFanfare = 0;
    this.delayed.length = 0;

    this.playerCount = this.session?.playerCount || 1;
    this.netRole = this.session?.role === "host" ? "host"
      : this.session?.role === "client" ? "client" : "solo";

    this.maxFloors = 8 + (this.save.unlocked.deep_pages ? 2 : 0);
    this.floor = 1;
    this.room = 0;
    this.kills = 0;
    this.dustEarned = 0;
    this.folds = [];
    this.relics = ["first_crease"];
    if (this.save.unlocked.dusk_compass) this.relics.push("dusk_compass");
    if (this.save.unlocked.spare_ink) this.relics.push("spare_ink");
    if (this.save.unlocked.lucky_seam) this.relics.push("lucky_seam");
    if (this.save.unlocked.phoenix_fold) this.relics.push("phoenix_fold");
    this.synergies = [];
    this.phoenixUsed = false;
    this.bgSeed = Math.random() * 1000;
    this.easyEarly = true;
    this.settings = null;
    this.shakeMul = 1;
    this.showFps = true;
    this.reduceFlash = false;
    this.drawTrails = true;

    // 开局偏爽：射速更快、伤害够清杂兵
    this.player = {
      x: this.w * 0.5 + (Math.random() - 0.5) * 40,
      y: this.h * 0.5 + (Math.random() - 0.5) * 40,
      r: 14, hp: 120, inv: 0, dashCd: 0, dashT: 0,
      fireCd: 0, ultCd: 0, mp: 100,
      aimX: 1, aimY: 0,
      stats: {
        maxHp: 120, maxMp: 100, damage: 16, fireRate: 0.16, moveSpeed: 250,
        dashCd: 0.7, dashSpeed: 660, dashDur: 0.15,
        extraShots: 0, spread: 0.05, pierce: 1, chain: 0,
        bulletSpeed: 560, ultDamage: 70, mpRegen: 16,
      },
      flags: {},
      name: this.session?.name || "织者",
      id: this.session?.playerId || "local",
    };

    if (this.save.unlocked.starting_twin) this.addFold("twin_refraction", false);
    this.addFold("crease_bolt", false);
    this.rebuildStats();
    this.player.hp = this.player.stats.maxHp;
    this.player.mp = this.player.stats.maxMp;

    this.pickBiome();
    this.state = "playing";
    if (this.netRole !== "client") this.beginRoom(true);
    this.hooks.onHud();
  }

  rebuildStats() {
    const p = this.player;
    p.stats = {
      maxHp: 120, maxMp: 100, damage: 16, fireRate: 0.16, moveSpeed: 250,
      dashCd: 0.7, dashSpeed: 660, dashDur: 0.15,
      extraShots: 0, spread: 0.05, pierce: 1, chain: 0,
      bulletSpeed: 560, ultDamage: 70, mpRegen: 16,
    };
    p.flags = {};
    const counts = Object.create(null);
    for (const id of this.folds) counts[id] = (counts[id] || 0) + 1;
    for (const [id, n] of Object.entries(counts)) {
      const fold = FOLDS[id];
      if (fold) fold.apply(p, n);
    }
    if (this.relics.includes("first_crease")) p.stats.damage *= 1.12;
    if (this.relics.includes("spare_ink")) p.stats.mpRegen += 10;
    // 连杀爽感：短暂射速加成在 update 里吃 streak
    this.refreshSynergies();
    if (p.flags.birds) this.ensureBirds(p.flags.birds);
  }

  pickBiome() {
    const order = ["sun_paper", "teal_marsh", "prism_archive", "ember_atelier", "night_folio"];
    const idx = clamp(((this.floor - 1) / Math.max(1, this.maxFloors - 1)) * (order.length - 1), 0, order.length - 1) | 0;
    let chosen = order[idx];
    for (let i = idx; i >= 0; i--) {
      const b = BIOMES[order[i]];
      if (isUnlocked(this.save, b)) { chosen = order[i]; break; }
    }
    this.biome = BIOMES[chosen];
    markSeen(this.save, "biomes", chosen);
  }

  refreshSynergies() {
    this.synergies = [];
    const have = new Set(this.folds);
    for (const syn of SYNERGIES) {
      if (!isUnlocked(this.save, syn)) continue;
      if (syn.need.every((id) => have.has(id))) {
        this.synergies.push(syn.id);
        if (!this.save.discoveredSynergies[syn.id]) {
          this.save.discoveredSynergies[syn.id] = true;
          markSeen(this.save, "synergies", syn.id);
          this.hooks.toast(`共鸣觉醒：${syn.name}`);
        }
      }
    }
  }

  ensureBirds(n) {
    while (this.birds.length < n) {
      this.birds.push({ ang: Math.random() * Math.PI * 2, orbit: 42 + this.birds.length * 14, fireCd: rand(0.2, 0.8) });
    }
    this.birds.length = n;
  }

  addFold(id, announce = true) {
    this.folds.push(id);
    markSeen(this.save, "folds", id);
    this.rebuildStats();
    if (announce) this.hooks.toast(`获得折纹：${FOLDS[id].name}`);
    this.hooks.onHud();
  }

  beginRoom(first = false) {
    if (this.netRole === "client") return;
    this.enemies.clear();
    this.bullets.clear();
    this.fields.clear();
    this.clearDelay = 0;
    this.roomDone = false;
    this.waveTimer = 0;
    this.swarmLeft = 0;
    this.swarmCd = 0;
    this.room++;
    const isBoss = this.room > this.roomsPerFloor;
    if (isBoss) {
      this.spawnBoss();
    } else {
      this.spawnWave(false);
    }
    if (!first && this.player) {
      this.player.x = this.w * 0.5;
      this.player.y = this.h * 0.5;
      this.player.inv = 0.6;
    }
    this.hooks.onHud();
  }

  /** 人海刷怪：首波 + 持续补兵，精英极少 */
  spawnWave(eliteChance) {
    const scale = scaleForPlayers(this.playerCount);
    const pool = this.biome.enemyPool.filter((id) => isUnlocked(this.save, ENEMIES[id]));
    const usable = pool.length ? pool : ["scrap_mite", "stitch_drone"];
    // 偏好杂兵
    const fodder = usable.filter((id) => !ENEMIES[id].elite && id !== "fold_brute");
    const fodderPool = fodder.length ? fodder : usable;

    const early = this.floor <= 2 ? 1.15 : 1;
    const base = (10 + this.floor * 2 + this.room * 2) * early;
    const count = Math.round(base * scale.enemyCountMul);

    for (let i = 0; i < count; i++) {
      const id = chance(0.72) ? pick(fodderPool) : pick(usable);
      this.spawnEnemy(id, false);
    }

    // 后续陆续冒出的补波（割草不断粮）
    this.swarmLeft = Math.round((8 + this.floor * 3) * scale.spawnRateMul);
    this.swarmCd = 0.55;

    const eliteBase = this.relics.includes("dusk_compass") ? 0.08 : 0.035;
    const wantElite = eliteChance || (chance(eliteBase * scale.eliteChanceMul) && this.floor >= 3);
    if (wantElite && isUnlocked(this.save, ENEMIES.seam_knight)) {
      this.spawnEnemy("seam_knight", true);
    }
  }

  edgePos() {
    const side = (Math.random() * 4) | 0;
    const m = 40;
    if (side === 0) return [rand(m, this.w - m), -20];
    if (side === 1) return [rand(m, this.w - m), this.h + 20];
    if (side === 2) return [-20, rand(m, this.h - m)];
    return [this.w + 20, rand(m, this.h - m)];
  }

  spawnEnemy(id, forceElite = false) {
    const def = ENEMIES[id];
    if (!def) return null;
    const scale = scaleForPlayers(this.playerCount);
    const e = this.enemies.acquire();
    const [x, y] = this.edgePos();
    // 前两层更脆；多人略加血但仍偏人海
    const floorScale = 0.75 + (this.floor - 1) * 0.1;
    const earlyMul = this.floor <= 2 ? 0.72 : 1;
    Object.assign(e, {
      id, name: def.name, x, y, vx: 0, vy: 0,
      r: def.radius * (forceElite || def.elite ? 1.2 : 1),
      hp: def.hp * floorScale * earlyMul * scale.enemyHpMul * (forceElite || def.elite ? 1.55 : 1),
      maxHp: 0,
      damage: def.damage * (0.75 + this.floor * 0.06) * scale.enemyDmgMul,
      speed: def.speed * (this.floor <= 2 ? 0.9 : 1),
      score: def.score * (forceElite || def.elite ? 3 : 1),
      flash: 0, cd: rand(0.4, 1.4), stateT: rand(0, 2),
      elite: !!(forceElite || def.elite), boss: false,
      ranged: !!def.ranged, charge: !!def.charge, explode: !!def.explode,
      stealth: !!def.stealth, spread: !!def.spread, split: !!def.split,
      orbit: !!def.orbit, block: !!def.block,
      hidden: false, ang: Math.random() * Math.PI * 2,
      color: def.color.slice(),
      accent: (def.accent || [255, 240, 220]).slice(),
      shape: def.shape || "mite",
      slow: 0, burn: 0,
      // 弹道准度：早期很歪
      accuracy: this.floor <= 2 ? 0.35 : this.floor <= 4 ? 0.55 : 0.72,
      bulletSpeed: this.floor <= 2 ? 170 : 200 + this.floor * 10,
    });
    e.maxHp = e.hp;
    markSeen(this.save, "enemies", id);
    return e;
  }

  spawnBoss() {
    const list = ["folio_tyrant", "lace_matron", "hollow_cartographer", "final_origami"];
    let id = list[clamp(this.floor - 1, 0, list.length - 1)];
    for (let i = clamp(this.floor - 1, 0, list.length - 1); i >= 0; i--) {
      if (isUnlocked(this.save, BOSSES[list[i]])) { id = list[i]; break; }
    }
    const def = BOSSES[id];
    const scale = scaleForPlayers(this.playerCount);
    const e = this.enemies.acquire();
    const floorScale = 0.85 + (this.floor - 1) * 0.12;
    Object.assign(e, {
      id, name: def.name, x: this.w * 0.5, y: this.h * 0.28,
      vx: 0, vy: 0, r: def.radius,
      hp: def.hp * floorScale * scale.enemyHpMul,
      maxHp: 0,
      damage: def.damage * scale.enemyDmgMul, speed: def.speed * 0.92,
      score: 40 + this.floor * 10,
      flash: 0, cd: 1.2, stateT: 0, elite: true, boss: true,
      ranged: true, charge: true, explode: false, stealth: false,
      spread: true, split: false, orbit: false, block: false,
      hidden: false, ang: 0,
      color: def.color.slice(),
      accent: (def.accent || [255, 240, 220]).slice(),
      shape: def.shape || "boss",
      slow: 0, burn: 0,
      accuracy: 0.55, bulletSpeed: 210,
    });
    e.maxHp = e.hp;
    markSeen(this.save, "enemies", id);
    markSeen(this.save, "bosses", id);
    this.hooks.toast(`守门者降临：${def.name}`);
  }

  availableFolds() {
    return Object.values(FOLDS).filter((f) => isUnlocked(this.save, f));
  }

  rollPicks(n = 3) {
    const pool = this.availableFolds();
    const lucky = this.relics.includes("lucky_seam");
    const weights = pool.map((f) => {
      let w = f.rarity === "common" ? 50 : f.rarity === "rare" ? 28 : f.rarity === "epic" ? 14 : 6;
      if (lucky && f.rarity !== "common") w *= 1.55;
      if (this.folds.includes(f.id) && f.rarity === "legend") w *= 0.4;
      return w;
    });
    const picks = [];
    const used = new Set();
    for (let i = 0; i < n; i++) {
      let total = 0;
      for (let j = 0; j < pool.length; j++) if (!used.has(pool[j].id)) total += weights[j];
      if (total <= 0) break;
      let r = Math.random() * total;
      for (let j = 0; j < pool.length; j++) {
        if (used.has(pool[j].id)) continue;
        r -= weights[j];
        if (r <= 0) { picks.push(pool[j]); used.add(pool[j].id); break; }
      }
    }
    return picks;
  }

  onRoomCleared() {
    const streakBonus = Math.min(20, (this.killStreak / 5) | 0);
    const base = 8 + this.floor * 2 + this.room + streakBonus;
    const mult = this.save.unlocked.dust_magnet ? 1.25 : 1;
    const dust = Math.round(base * mult);
    this.dustEarned += dust;
    this.spawnPickup(this.player.x, this.player.y - 30, "dust", dust);
    this.vacuumT = 1.2;
    this.clearFanfare = 0.9;
    this.flashAlpha = 0.35;
    this.shake = 8;
    this.particles.burst(this.player.x, this.player.y, 30, {
      spdMin: 80, spdMax: 340, r: 255, g: 200, b: 100, spark: true,
    });
    this.hooks.toast?.(this.room > this.roomsPerFloor ? "守门者倒下 · 纸页翻开" : "房间折尽 · 选择折纹");

    if (this.room > this.roomsPerFloor) {
      if (this.floor >= this.maxFloors) {
        this.endRun(true);
        return;
      }
      this.floor++;
      this.room = 0;
      this.phoenixUsed = false;
      this.pickBiome();
      this.pendingPicks = this.player.flags.extraPick ? 2 : 1;
      this.openPick();
      return;
    }
    this.pendingPicks = this.player.flags.extraPick ? 2 : 1;
    this.openPick();
  }

  openPick() {
    this.state = "pick";
    const cards = this.rollPicks(3);
    if (this.netRole === "host") {
      this.session?.send?.({ type: "pick", cards: cards.map((c) => c.id) });
    }
    this.hooks.onPick(cards);
  }

  choosePick(id) {
    this.addFold(id);
    if (this.netRole === "host") {
      this.session?.sendChoose?.(id);
    }
    this.pendingPicks--;
    if (this.pendingPicks > 0) {
      this.openPick();
      return;
    }
    this.state = "playing";
    this.hooks.onPickClose();
    this.beginRoom();
  }

  /** 延迟事件队列（替代 setTimeout，切后台/暂停更稳） */
  defer(sec, fn) {
    this.delayed.push({ t: sec, fn });
  }

  pumpDelayed(dt) {
    for (let i = this.delayed.length - 1; i >= 0; i--) {
      this.delayed[i].t -= dt;
      if (this.delayed[i].t <= 0) {
        const fn = this.delayed[i].fn;
        this.delayed.splice(i, 1);
        try { fn(); } catch { /* */ }
      }
    }
  }

  nearestThreat(fromX, fromY) {
    let best = this.player;
    let bestD = len(this.player.x - fromX, this.player.y - fromY);
    for (const r of this.remotes.values()) {
      const d = len(r.x - fromX, r.y - fromY);
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  endRun(won) {
    this.state = "result";
    const bonus = won ? 40 + this.floor * 8 : Math.round(this.dustEarned * 0.15);
    const total = this.dustEarned + bonus;
    this.save.totalRuns++;
    this.save.totalKills += this.kills;
    this.save.bestFloor = Math.max(this.save.bestFloor, this.floor);
    this.hooks.onResult({
      won, floor: this.floor, kills: this.kills,
      dust: total, bonus, runDust: this.dustEarned,
    });
  }

  spawnPickup(x, y, kind, value) {
    const p = this.pickups.acquire();
    p.x = x; p.y = y; p.kind = kind; p.value = value; p.life = 12; p.r = kind === "dust" ? 9 : 11;
  }

  spawnField(x, y, opts) {
    const f = this.fields.acquire();
    f.x = x; f.y = y;
    f.r = opts.r || 50;
    f.life = opts.life || 0.6;
    f.kind = opts.kind || "lace";
    f.damage = opts.damage || 0;
    f.slow = opts.slow || 0;
    f.pull = opts.pull || 0;
    f.color = opts.color || [255, 180, 80];
  }

  floatText(x, y, text, color = "#fff7d6") {
    const f = this.floats.acquire();
    f.x = x; f.y = y; f.vy = -48; f.text = text; f.life = 0.7; f.color = color;
  }

  firePlayer() {
    const p = this.player;
    if (p.fireCd > 0) return;
    let rate = p.stats.fireRate;
    if (p.flags.amberHeart && p.hp / p.stats.maxHp < 0.35) rate *= 0.65;
    if (this.killStreak >= 8) rate *= 0.82;
    if (this.killStreak >= 20) rate *= 0.85;
    p.fireCd = rate;

    const [ax, ay] = norm(this.mouse.x - p.x, this.mouse.y - p.y);
    p.aimX = ax; p.aimY = ay;
    const shots = 1 + p.stats.extraShots;
    const spread = p.stats.spread + (shots - 1) * 0.05;
    let dmg = p.stats.damage;
    if (p.flags.amberHeart && p.hp / p.stats.maxHp < 0.35) dmg *= 1.45;
    if (this.killStreak >= 12) dmg *= 1.1;

    for (let i = 0; i < shots; i++) {
      const t = shots === 1 ? 0 : (i / (shots - 1) - 0.5) * 2;
      const ang = Math.atan2(ay, ax) + t * spread;
      this.spawnBullet(p.x + Math.cos(ang) * 16, p.y + Math.sin(ang) * 16, Math.cos(ang), Math.sin(ang), {
        damage: dmg,
        speed: p.stats.bulletSpeed,
        pierce: p.stats.pierce,
        chain: p.stats.chain,
        ink: !!p.flags.inkTide,
        lace: !!p.flags.solarLace,
        color: p.flags.inkTide ? [40, 90, 110] : [255, 200, 90],
      });
    }
    this.audio.shoot();
    this.tutorial?.note("shoot");
    this.particles.burst(p.x + ax * 14, p.y + ay * 14, 3, {
      spdMin: 20, spdMax: 80, lifeMin: 0.1, lifeMax: 0.25, sizeMin: 1.5, sizeMax: 3,
      r: 255, g: 210, b: 120, spark: true,
    });
  }

  spawnBullet(x, y, dx, dy, opts) {
    const b = this.bullets.acquire();
    const spd = opts.speed || 500;
    b.x = x; b.y = y; b.vx = dx * spd; b.vy = dy * spd;
    b.r = opts.r || 4.5; b.damage = opts.damage || 10;
    b.life = opts.life || 1.15; b.pierce = opts.pierce || 0;
    b.chain = opts.chain || 0; b.fromPlayer = opts.fromPlayer !== false;
    b.ink = !!opts.ink; b.lace = !!opts.lace;
    b.hit = opts.hit || null;
    b.color = opts.color || [255, 200, 80];
    return b;
  }

  tryDash() {
    const p = this.player;
    if (p.dashCd > 0 || p.dashT > 0) return;
    let mx = 0, my = 0;
    if (this.keys.KeyW || this.keys.ArrowUp) my -= 1;
    if (this.keys.KeyS || this.keys.ArrowDown) my += 1;
    if (this.keys.KeyA || this.keys.ArrowLeft) mx -= 1;
    if (this.keys.KeyD || this.keys.ArrowRight) mx += 1;
    if (!mx && !my) { mx = p.aimX; my = p.aimY; }
    const [dx, dy] = norm(mx, my);
    p.dashT = p.stats.dashDur;
    p.dashCd = p.stats.dashCd;
    p.inv = Math.max(p.inv, p.stats.dashDur + 0.05);
    p._dashX = dx; p._dashY = dy;
    this.audio.dash();
    this.tutorial?.note("dash");

    // crease trail damage
    this.creaseTrails.push({ x: p.x, y: p.y, life: 0.45, r: 28 });
    this.spawnField(p.x, p.y, { r: 36, life: 0.35, kind: "crease", damage: p.stats.damage * 0.55, color: [200, 230, 210] });

    if (p.flags.timeCrease) {
      this.spawnField(p.x, p.y, { r: 120, life: 0.7, kind: "time", slow: 0.65, color: [120, 190, 210] });
    }
    if (this.synergies.includes("syn_bird_swift")) {
      for (const bird of this.birds) {
        const bx = p.x + Math.cos(bird.ang) * bird.orbit;
        const by = p.y + Math.sin(bird.ang) * bird.orbit;
        const [ax, ay] = norm(this.mouse.x - bx, this.mouse.y - by);
        this.spawnBullet(bx, by, ax, ay, { damage: p.stats.damage * 0.6, speed: 480, color: [180, 230, 200] });
      }
    }
    this.particles.burst(p.x, p.y, 14, {
      spdMin: 80, spdMax: 260, r: 180, g: 230, b: 210, spark: true, lifeMin: 0.2, lifeMax: 0.45,
    });
    this.shake = Math.max(this.shake, 4);
  }

  tryUlt() {
    const p = this.player;
    if (p.ultCd > 0 || p.mp < 45) return;
    p.mp -= 45;
    p.ultCd = 3.2;
    const dmg = p.stats.ultDamage;
    if (p.flags.voidSeam || p.flags.gravityPleat) {
      const pull = (p.flags.gravityPleat || this.synergies.includes("syn_void_gravity")) ? 420 : 0;
      this.spawnField(p.x, p.y, {
        r: 150, life: 0.85, kind: "void", damage: dmg * 0.15, pull, color: [60, 80, 100],
      });
      for (const e of this.enemies.live) {
        const d = len(e.x - p.x, e.y - p.y);
        if (d < 160) this.damageEnemy(e, dmg * (1 - d / 200), true);
      }
      if (this.synergies.includes("syn_void_gravity")) {
        const x = p.x, y = p.y;
        this.defer(0.7, () => {
          if (this.state !== "playing") return;
          this.spawnField(x, y, { r: 130, life: 0.25, kind: "burst", damage: dmg * 0.4, color: [255, 140, 80] });
          this.particles.burst(x, y, 28, { spdMin: 100, spdMax: 360, r: 255, g: 150, b: 80, spark: true });
          this.shake = 10;
        });
      }
    } else {
      // default prism fan
      for (let i = 0; i < 10; i++) {
        const ang = (i / 10) * Math.PI * 2;
        this.spawnBullet(p.x, p.y, Math.cos(ang), Math.sin(ang), {
          damage: dmg * 0.45, speed: 400, life: 0.7, color: [255, 190, 100],
        });
      }
    }
    this.particles.burst(p.x, p.y, 24, { spdMin: 60, spdMax: 280, r: 255, g: 200, b: 100, spark: true });
    this.shake = 8;
    this.audio.pickup();
    this.tutorial?.note("ult");
  }

  damageEnemy(e, amount, crit = false) {
    if (!e.active) return;
    const before = e.hp;
    e.hp -= amount;
    e.flash = 0.1;
    this.floatText(e.x, e.y - e.r, `${amount | 0}`, crit ? "#ffd27a" : "#f4fbf8");
    if (e.hp <= 0) {
      const overkill = amount - before;
      if (overkill > 8 && this.killStreak >= 3) {
        const splash = Math.min(overkill * 0.55, this.player.stats.damage * 0.7);
        const toKill = [];
        for (const o of this.enemies.live) {
          if (o === e || !o.active) continue;
          if (len(o.x - e.x, o.y - e.y) < 70) {
            o.hp -= splash;
            o.flash = 0.08;
            if (o.hp <= 0) toKill.push(o);
          }
        }
        for (const o of toKill) this.killEnemy(o);
        this.particles.burst(e.x, e.y, 8, { spdMin: 40, spdMax: 160, r: 255, g: 180, b: 80, spark: true });
      }
      this.killEnemy(e);
    }
  }

  killEnemy(e) {
    if (!e.active) return;
    e.active = false;
    this.kills++;
    this.killStreak++;
    this.streakTimer = 2.4;
    this.audio.hit();

    this.hitstop = Math.min(0.07, 0.018 + (e.elite || e.boss ? 0.035 : 0) + Math.min(0.02, this.killStreak * 0.001));
    this.shake = Math.max(this.shake, e.boss ? 12 : e.elite ? 7 : 3 + Math.min(7, this.killStreak * 0.12));
    this.particles.burst(e.x, e.y, e.boss ? 40 : e.elite ? 24 : 10 + Math.min(16, this.killStreak), {
      spdMin: 60, spdMax: 320,
      r: e.color[0], g: e.color[1], b: e.color[2],
      spark: true, lifeMin: 0.2, lifeMax: 0.55,
    });

    if (this.killStreak === 8 || this.killStreak === 20 || this.killStreak === 40) {
      this.vacuumT = Math.max(this.vacuumT, 1.4);
      this.flashAlpha = 0.28;
      this.spawnField(this.player.x, this.player.y, {
        r: 90 + this.killStreak, life: 0.28, kind: "burst",
        damage: this.player.stats.damage * (0.35 + this.killStreak * 0.01),
        color: [255, 200, 110],
      });
      this.floatText(this.player.x, this.player.y - 36, `${this.killStreak} 连折！`, "#ffd27a");
      this.hooks.toast?.(`${this.killStreak} 连折 · 折光回涌`);
    } else if (this.killStreak === 10 || this.killStreak === 25 || this.killStreak === 50) {
      this.floatText(this.player.x, this.player.y - 36, `${this.killStreak} 连折！`, "#ffd27a");
    }

    if (this.killStreak >= 6) this.vacuumT = Math.max(this.vacuumT, 0.55);

    const streakMul = 1 + Math.min(0.5, this.killStreak * 0.015);
    const dust = Math.round((e.score + (e.boss ? 8 : 0)) * (this.save.unlocked.dust_magnet ? 1.25 : 1) * streakMul);
    this.dustEarned += dust;
    if (chance(0.6) || e.elite || e.boss) this.spawnPickup(e.x, e.y, "dust", Math.max(1, (dust / 2) | 0));
    if (chance(0.14)) this.spawnPickup(e.x + rand(-10, 10), e.y + rand(-10, 10), "heal", 14);

    if (this.player.flags.prismBurst) {
      const big = this.synergies.includes("syn_prism_ink") && e.slow > 0;
      this.spawnField(e.x, e.y, {
        r: big ? 90 : 55, life: 0.3, kind: "burst",
        damage: this.player.stats.damage * 0.55,
        slow: big ? 0.4 : 0,
        color: [255, 190, 90],
      });
    }
    if (e.explode) {
      this.spawnField(e.x, e.y, { r: 60, life: 0.25, kind: "burst", damage: e.damage, color: [255, 210, 120] });
    }
    if (e.split && e.r > 10) {
      for (let i = 0; i < 2; i++) {
        const child = this.spawnEnemy("scrap_mite", false);
        if (child) {
          child.x = e.x + rand(-20, 20);
          child.y = e.y + rand(-20, 20);
          child.hp = e.maxHp * 0.35;
          child.maxHp = child.hp;
          child.r = e.r * 0.55;
          child.color = e.color.slice();
          child.split = false;
        }
      }
    }

    this.enemies.release(e);
    this.hooks.onHud();
  }

  hurtPlayer(amount) {
    const p = this.player;
    if (p.inv > 0 || p.dashT > 0) return;
    if (p.flags.mirrorSkin && chance(this.synergies.includes("syn_amber_mirror") && p.hp / p.stats.maxHp < 0.35 ? 1 : 0.35)) {
      this.floatText(p.x, p.y - 20, "折射", "#9ad7ef");
      this.particles.burst(p.x, p.y, 10, { r: 140, g: 210, b: 230, spark: true });
      p.inv = 0.25;
      return;
    }
    p.hp -= amount;
    p.inv = 0.7;
    this.shake = 10;
    this.audio.hurt();
    if (p.flags.hurtHaste) p._haste = 1.2;
    this.particles.burst(p.x, p.y, 16, { r: 226, g: 91, b: 74, spark: true });
    if (p.hp <= 0) {
      if (this.relics.includes("phoenix_fold") && !this.phoenixUsed) {
        this.phoenixUsed = true;
        p.hp = 1;
        p.inv = 2;
        this.hooks.toast("再生折发动：残页重续");
        return;
      }
      this.endRun(false);
    }
    this.hooks.onHud();
  }

  update(dt) {
    if (this.state !== "playing") return;
    dt = Math.min(dt, 0.033);

    if (this.hitstop > 0) {
      this.hitstop -= dt;
      // 顿帧期间仍画粒子衰减感：只推进时间极少
      dt *= 0.15;
    }

    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 28);
    this.streakTimer -= dt;
    if (this.streakTimer <= 0) this.killStreak = 0;
    this.vacuumT = Math.max(0, this.vacuumT - dt);
    this.flashAlpha = Math.max(0, this.flashAlpha - dt * 1.8);
    this.clearFanfare = Math.max(0, this.clearFanfare - dt);
    this.pumpDelayed(dt);

    this._frames++;
    this._fpsT += dt;
    if (this._fpsT >= 0.4) {
      this.fps = Math.round(this._frames / this._fpsT);
      this._frames = 0;
      this._fpsT = 0;
    }

    // 客户端：本地预测移动，开火交给主机权威
    if (this.netRole === "client") {
      this.updatePlayer(dt, { predictOnly: true });
      this.updateBirds(dt);
      this.particles.update(dt);
      this.updateFloats(dt);
      this._sendNetInput();
      return;
    }

    this.updatePlayer(dt);
    this.updateRemotesFromInputs(dt);
    this.updateBirds(dt);
    this.updateSwarm(dt);
    this.updateEnemies(dt);
    this.updateBullets(dt);
    this.updateFields(dt);
    this.updatePickups(dt);
    this.updateFloats(dt);
    this.particles.update(dt);

    for (let i = this.creaseTrails.length - 1; i >= 0; i--) {
      this.creaseTrails[i].life -= dt;
      if (this.creaseTrails[i].life <= 0) this.creaseTrails.splice(i, 1);
    }

    if (this.enemies.count === 0 && this.swarmLeft <= 0 && !this.roomDone) {
      this.clearDelay += dt;
      if (this.clearDelay > 0.55) {
        this.roomDone = true;
        this.onRoomCleared();
      }
    }

    if (this.netRole === "host") {
      this.snapAcc += dt;
      if (this.snapAcc >= 0.05) {
        this.snapAcc = 0;
        this.session?.sendSnapshot?.(this.buildSnapshot());
      }
    }
  }

  updateSwarm(dt) {
    if (this.swarmLeft <= 0 || this.room > this.roomsPerFloor) return;
    this.swarmCd -= dt;
    if (this.swarmCd > 0) return;
    const scale = scaleForPlayers(this.playerCount);
    this.swarmCd = 0.45 / scale.spawnRateMul;
    const pool = this.biome.enemyPool.filter((id) => isUnlocked(this.save, ENEMIES[id]) && !ENEMIES[id].elite);
    const usable = pool.length ? pool : ["scrap_mite"];
    const n = Math.min(this.swarmLeft, 2 + (this.playerCount > 1 ? 1 : 0));
    for (let i = 0; i < n; i++) {
      this.spawnEnemy(pick(usable), false);
      this.swarmLeft--;
    }
  }

  updatePlayer(dt, opts = {}) {
    const p = this.player;
    p.fireCd = Math.max(0, p.fireCd - dt);
    p.dashCd = Math.max(0, p.dashCd - dt);
    p.ultCd = Math.max(0, p.ultCd - dt);
    p.inv = Math.max(0, p.inv - dt);
    p._haste = Math.max(0, (p._haste || 0) - dt);
    p.mp = Math.min(p.stats.maxMp, p.mp + p.stats.mpRegen * dt);

    let mx = 0, my = 0;
    if (this.keys.KeyW || this.keys.ArrowUp) my -= 1;
    if (this.keys.KeyS || this.keys.ArrowDown) my += 1;
    if (this.keys.KeyA || this.keys.ArrowLeft) mx -= 1;
    if (this.keys.KeyD || this.keys.ArrowRight) mx += 1;

    if (!opts.predictOnly) {
      if (this.mouse.down) this.firePlayer();
      if (this.mouse.right || this.keys.ShiftLeft || this.keys.ShiftRight) this.tryDash();
      if (this.keys.Space) this.tryUlt();
    } else {
      // 客机仍给教程/手感反馈：本地折冲位移，攻击只上报
      if (this.mouse.right || this.keys.ShiftLeft || this.keys.ShiftRight) this.tryDash();
      if (this.mouse.down) this.tutorial?.note("shoot");
      if (this.keys.Space) this.tutorial?.note("ult");
    }

    if (p.dashT > 0) {
      p.dashT -= dt;
      p.x += p._dashX * p.stats.dashSpeed * dt;
      p.y += p._dashY * p.stats.dashSpeed * dt;
      this.particles.trail(p.x, p.y, p._dashX * 200, p._dashY * 200, { r: 200, g: 235, b: 220 });
      if (p.flags.solarLace) {
        this.spawnField(p.x, p.y, { r: 22, life: 0.55, kind: "lace", damage: p.stats.damage * 0.12, color: [255, 180, 70] });
      }
    } else if (mx || my) {
      const [dx, dy] = norm(mx, my);
      let spd = p.stats.moveSpeed * (p._haste > 0 ? 1.35 : 1);
      p.x += dx * spd * dt;
      p.y += dy * spd * dt;
      this.tutorial?.note("move");
      if ((this._frames & 1) === 0 && this.drawTrails !== false) this.particles.trail(p.x, p.y, dx * 80, dy * 80, { r: 170, g: 210, b: 200 });
    }

    p.x = clamp(p.x, p.r + 8, this.w - p.r - 8);
    p.y = clamp(p.y, p.r + 8, this.h - p.r - 8);
    const [ax, ay] = norm(this.mouse.x - p.x, this.mouse.y - p.y);
    p.aimX = ax; p.aimY = ay;
  }

  updateBirds(dt) {
    const p = this.player;
    for (const bird of this.birds) {
      bird.ang += dt * 2.4;
      bird.fireCd -= dt;
      const bx = p.x + Math.cos(bird.ang) * bird.orbit;
      const by = p.y + Math.sin(bird.ang) * bird.orbit;
      bird.x = bx; bird.y = by;
      if (bird.fireCd <= 0 && this.enemies.count) {
        bird.fireCd = 0.85;
        let target = null, best = 1e9;
        for (const e of this.enemies.live) {
          const d = (e.x - bx) ** 2 + (e.y - by) ** 2;
          if (d < best) { best = d; target = e; }
        }
        if (target) {
          const [dx, dy] = norm(target.x - bx, target.y - by);
          this.spawnBullet(bx, by, dx, dy, {
            damage: p.stats.damage * 0.45, speed: 420, color: [170, 220, 200], r: 3.5,
          });
        }
      }
    }
  }

  updateEnemies(dt) {
    this.hash.clear();
    for (const e of this.enemies.live) this.hash.insert(e.x, e.y, e);

    for (const e of this.enemies.live) {
      e.flash = Math.max(0, e.flash - dt);
      e.slow = Math.max(0, e.slow - dt);
      if (e.burn > 0) {
        e.burn -= dt;
        if ((this.time * 10 | 0) !== ((this.time - dt) * 10 | 0)) {
          this.damageEnemy(e, 2.2);
          if (!e.active) continue;
        }
      }
      e.cd = Math.max(0, e.cd - dt);
      e.stateT += dt;
      const slowMul = e.slow > 0 ? 0.4 : 1;
      const target = this.nearestThreat(e.x, e.y);
      let tx = target.x, ty = target.y;
      if (e.orbit) {
        e.ang += dt * 1.6;
        tx = target.x + Math.cos(e.ang) * 160;
        ty = target.y + Math.sin(e.ang) * 160;
      }
      if (e.stealth) {
        e.hidden = (e.stateT % 3.5) < 1.1;
      }
      const [dx, dy] = norm(tx - e.x, ty - e.y);
      let spd = e.speed * slowMul;
      if (e.charge && e.stateT % 4 > 3) spd *= 2.3;

      if (e.ranged) {
        const dist = len(target.x - e.x, target.y - e.y);
        if (dist < 220) { e.x -= dx * spd * 0.7 * dt; e.y -= dy * spd * 0.7 * dt; }
        else { e.x += dx * spd * 0.5 * dt; e.y += dy * spd * 0.5 * dt; }
        if (e.cd <= 0 && !e.hidden) {
          e.cd = e.boss ? 0.7 : e.spread ? 1.35 : 1.7;
          const shots = e.spread || e.boss ? (e.boss ? 5 : 3) : 1;
          const acc = e.accuracy ?? 0.6;
          const bspd = e.bulletSpeed ?? (180 + this.floor * 8);
          for (let i = 0; i < shots; i++) {
            const t = shots === 1 ? 0 : (i / (shots - 1) - 0.5);
            const miss = (1 - acc) * rand(-0.55, 0.55);
            const ang = Math.atan2(target.y - e.y, target.x - e.x) + t * 0.5 + miss;
            this.spawnBullet(e.x, e.y, Math.cos(ang), Math.sin(ang), {
              fromPlayer: false, damage: e.damage * 0.65, speed: bspd,
              color: [80, 160, 170], r: 5, life: 2.4,
            });
          }
        }
      } else {
        e.x += dx * spd * dt;
        e.y += dy * spd * dt;
      }

      e.x = clamp(e.x, 20, this.w - 20);
      e.y = clamp(e.y, 20, this.h - 20);

      // 碰到任一玩家
      if (!e.hidden) {
        if (len(e.x - this.player.x, e.y - this.player.y) < e.r + this.player.r - 2) {
          this.hurtPlayer(e.damage);
        }
        for (const r of this.remotes.values()) {
          if (len(e.x - r.x, e.y - r.y) < e.r + 14) {
            r.hp = Math.max(0, (r.hp || 100) - e.damage * 0.35);
          }
        }
      }
    }
  }

  updateBullets(dt) {
    const p = this.player;
    const live = this.bullets.live;
    for (let i = live.length - 1; i >= 0; i--) {
      const b = live[i];
      b.life -= dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if ((this._frames & 1) === 0) {
        this.particles.trail(b.x, b.y, b.vx, b.vy, {
          r: b.color[0], g: b.color[1], b: b.color[2],
        });
      }
      if (b.life <= 0 || b.x < -40 || b.y < -40 || b.x > this.w + 40 || b.y > this.h + 40) {
        this.bullets.release(b);
        continue;
      }

      if (b.fromPlayer) {
        this.hash.query(b.x, b.y, 48, this.queryBuf);
        let hit = null;
        for (let q = 0; q < this.queryBuf.length; q++) {
          const e = this.queryBuf[q];
          if (!e.active || e.hidden) continue;
          if (b.hit === e) continue;
          const d = len(e.x - b.x, e.y - b.y);
          if (d < e.r + b.r) {
            if (e.block) {
              const [fx, fy] = norm(b.vx, b.vy);
              const [ex, ey] = norm(e.x - p.x, e.y - p.y);
              if (fx * ex + fy * ey > 0.35) continue; // frontal block
            }
            hit = e; break;
          }
        }
        if (hit) {
          this.damageEnemy(hit, b.damage);
          if (b.ink && hit.active) {
            hit.slow = Math.max(hit.slow, 1.4);
            hit.burn = Math.max(hit.burn, 1.6);
          }
          if (b.lace) {
            this.spawnField(b.x, b.y, { r: 18, life: 1.1, kind: "lace", damage: b.damage * 0.08, color: [255, 170, 70] });
          }
          if (this.synergies.includes("syn_time_chain") && b.chain > 0 && hit.active) {
            hit.slow = Math.max(hit.slow, 0.9);
          }
          if (b.chain > 0) {
            let next = null, best = 1e9;
            for (const e of this.enemies.live) {
              if (e === hit || !e.active) continue;
              const d = (e.x - b.x) ** 2 + (e.y - b.y) ** 2;
              if (d < best && d < 220 * 220) { best = d; next = e; }
            }
            if (next) {
              const [dx, dy] = norm(next.x - b.x, next.y - b.y);
              b.vx = dx * 520; b.vy = dy * 520;
              b.chain--; b.hit = hit; b.life = Math.max(b.life, 0.35);
              continue;
            }
          }
          if (b.pierce > 0) { b.pierce--; b.hit = hit; }
          else this.bullets.release(b);
        }
      } else {
        if (len(b.x - p.x, b.y - p.y) < p.r + b.r) {
          this.hurtPlayer(b.damage);
          this.bullets.release(b);
        }
      }
    }
  }

  updateFields(dt) {
    for (let i = this.fields.live.length - 1; i >= 0; i--) {
      const f = this.fields.live[i];
      f.life -= dt;
      if (f.life <= 0) { this.fields.release(f); continue; }
      for (const e of this.enemies.live) {
        const d = len(e.x - f.x, e.y - f.y);
        if (d > f.r) continue;
        if (f.slow) e.slow = Math.max(e.slow, f.slow);
        if (f.pull) {
          const [dx, dy] = norm(f.x - e.x, f.y - e.y);
          e.x += dx * f.pull * dt * (1 - d / f.r);
          e.y += dy * f.pull * dt * (1 - d / f.r);
        }
        if (f.damage > 0) {
          // tick ~10/s
          if (((this.time * 10) | 0) !== (((this.time - dt) * 10) | 0)) {
            this.damageEnemy(e, f.damage);
          }
        }
      }
    }
  }

  updatePickups(dt) {
    const p = this.player;
    const magnetR = this.vacuumT > 0 ? 420 : (this.killStreak >= 5 ? 200 : 130);
    const magnetSpd = this.vacuumT > 0 ? 620 : (this.killStreak >= 5 ? 380 : 280);
    for (let i = this.pickups.live.length - 1; i >= 0; i--) {
      const u = this.pickups.live[i];
      u.life -= dt;
      if (u.life <= 0) { this.pickups.release(u); continue; }
      const d = len(u.x - p.x, u.y - p.y);
      if (d < magnetR) {
        const [dx, dy] = norm(p.x - u.x, p.y - u.y);
        const pull = magnetSpd * (this.vacuumT > 0 ? 1.2 : 1);
        u.x += dx * pull * dt;
        u.y += dy * pull * dt;
      }
      if (d < p.r + u.r + 4) {
        if (u.kind === "dust") {
          this.audio.pickup();
          if (p.flags.jadeBloom) {
            p.hp = Math.min(p.stats.maxHp, p.hp + 4);
            p.inv = Math.max(p.inv, 0.35);
          }
          // 连折时拾取回一点墨能
          if (this.killStreak >= 5) p.mp = Math.min(p.stats.maxMp, p.mp + 1.5);
        } else if (u.kind === "heal") {
          p.hp = Math.min(p.stats.maxHp, p.hp + u.value);
          this.audio.pickup();
        }
        this.particles.burst(u.x, u.y, 8, { r: 255, g: 210, b: 120, spdMin: 20, spdMax: 100 });
        this.pickups.release(u);
        this.hooks.onHud();
      }
    }
  }

  updateFloats(dt) {
    for (let i = this.floats.live.length - 1; i >= 0; i--) {
      const f = this.floats.live[i];
      f.life -= dt;
      f.y += f.vy * dt;
      if (f.life <= 0) this.floats.release(f);
    }
  }

  /* —— 联机：主机权威快照 —— */
  _sendNetInput() {
    if (!this.session || this.netRole === "solo" || !this.player) return;
    this.session.sendInput({
      x: this.player.x, y: this.player.y,
      aimX: this.player.aimX, aimY: this.player.aimY,
      hp: this.player.hp,
      keys: {
        w: !!(this.keys.KeyW || this.keys.ArrowUp),
        s: !!(this.keys.KeyS || this.keys.ArrowDown),
        a: !!(this.keys.KeyA || this.keys.ArrowLeft),
        d: !!(this.keys.KeyD || this.keys.ArrowRight),
        fire: this.mouse.down,
        dash: this.mouse.right || this.keys.ShiftLeft || this.keys.ShiftRight,
        ult: !!this.keys.Space,
      },
      mx: this.mouse.x, my: this.mouse.y,
    });
  }

  onRemoteInput(fromId, input, name) {
    if (this.netRole !== "host") return;
    if (!fromId || fromId === this.session?.playerId) return;
    this.remoteInputs.set(fromId, { ...input, name: name || "折客", t: this.time });
    let r = this.remotes.get(fromId);
    if (!r) {
      r = { id: fromId, x: input.x || this.w * 0.5, y: input.y || this.h * 0.5, hp: 120, aimX: 1, aimY: 0, name: name || "折客" };
      this.remotes.set(fromId, r);
    }
    r.x = input.x ?? r.x;
    r.y = input.y ?? r.y;
    r.aimX = input.aimX ?? r.aimX;
    r.aimY = input.aimY ?? r.aimY;
    r.hp = input.hp ?? r.hp;
    r.name = name || r.name;
    r._fire = !!input.keys?.fire;
    r._dash = !!input.keys?.dash;
    r._ult = !!input.keys?.ult;
    r._mx = input.mx; r._my = input.my;
  }

  updateRemotesFromInputs(dt) {
    for (const [, r] of this.remotes) {
      if (r._fireCd > 0) r._fireCd -= dt;
      if (r._dashCd > 0) r._dashCd -= dt;
      if (r._ultCd > 0) r._ultCd -= dt;

      if (r._fire && (!r._fireCd || r._fireCd <= 0)) {
        r._fireCd = 0.16;
        const [ax, ay] = norm((r._mx ?? r.x + r.aimX) - r.x, (r._my ?? r.y + r.aimY) - r.y);
        this.spawnBullet(r.x + ax * 14, r.y + ay * 14, ax, ay, {
          damage: 15, speed: 540, pierce: 1, color: [255, 210, 140],
        });
      }
      if (r._dash && (!r._dashCd || r._dashCd <= 0)) {
        r._dashCd = 0.75;
        const [ax, ay] = norm(r.aimX || 1, r.aimY || 0);
        r.x = clamp(r.x + ax * 90, 20, this.w - 20);
        r.y = clamp(r.y + ay * 90, 20, this.h - 20);
        this.spawnField(r.x, r.y, { r: 34, life: 0.3, kind: "crease", damage: 10, color: [160, 210, 220] });
        this.particles.burst(r.x, r.y, 10, { r: 160, g: 210, b: 220, spark: true, spdMin: 60, spdMax: 200 });
      }
      if (r._ult && (!r._ultCd || r._ultCd <= 0)) {
        r._ultCd = 4;
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * Math.PI * 2;
          this.spawnBullet(r.x, r.y, Math.cos(ang), Math.sin(ang), {
            damage: 22, speed: 380, life: 0.65, color: [140, 200, 230],
          });
        }
        this.particles.burst(r.x, r.y, 16, { r: 140, g: 200, b: 230, spark: true });
      }
    }
    this.playerCount = 1 + this.remotes.size;
  }

  buildSnapshot() {
    const enemies = [];
    for (const e of this.enemies.live) {
      enemies.push([
        e.x|0, e.y|0, e.hp|0, e.maxHp|0, e.r|0,
        e.color[0], e.color[1], e.color[2],
        e.elite ? 1 : 0, e.boss ? 1 : 0, e.hidden ? 1 : 0,
      ]);
    }
    const bullets = [];
    for (const b of this.bullets.live) {
      bullets.push([b.x|0, b.y|0, b.vx|0, b.vy|0, b.r|0, b.fromPlayer ? 1 : 0, b.color[0], b.color[1], b.color[2]]);
    }
    const players = [{
      id: this.player.id, name: this.player.name,
      x: this.player.x|0, y: this.player.y|0,
      hp: this.player.hp|0, aimX: +this.player.aimX.toFixed(2), aimY: +this.player.aimY.toFixed(2),
    }];
    for (const r of this.remotes.values()) {
      players.push({ id: r.id, name: r.name, x: r.x|0, y: r.y|0, hp: r.hp|0, aimX: r.aimX, aimY: r.aimY });
    }
    return {
      t: this.time, floor: this.floor, room: this.room, kills: this.kills,
      biome: this.biome.id, state: this.state,
      streak: this.killStreak,
      players, enemies, bullets,
      folds: this.folds.slice(),
    };
  }

  applySnapshot(snap) {
    if (!snap || this.netRole !== "client") return;
    this.floor = snap.floor;
    this.room = snap.room;
    this.kills = snap.kills;
    if (snap.streak != null) this.killStreak = snap.streak;
    if (snap.biome && BIOMES[snap.biome]) this.biome = BIOMES[snap.biome];

    // 重建敌人池（客户端只渲染）
    this.enemies.clear();
    for (const row of snap.enemies || []) {
      const e = this.enemies.acquire();
      Object.assign(e, {
        x: row[0], y: row[1], hp: row[2], maxHp: row[3], r: row[4],
        color: [row[5], row[6], row[7]], elite: !!row[8], boss: !!row[9], hidden: !!row[10],
        flash: 0, slow: 0, burn: 0, active: true,
        id: "sync", name: "", speed: 0, damage: 0, cd: 999, stateT: 0,
        ranged: false, charge: false, explode: false, stealth: false,
        spread: false, split: false, orbit: false, block: false, ang: 0,
      });
    }
    this.bullets.clear();
    for (const row of snap.bullets || []) {
      const b = this.bullets.acquire();
      Object.assign(b, {
        x: row[0], y: row[1], vx: row[2], vy: row[3], r: row[4],
        fromPlayer: !!row[5], color: [row[6], row[7], row[8]],
        damage: 0, life: 1, pierce: 0, chain: 0, ink: false, lace: false, hit: null,
      });
    }
    this.remotes.clear();
    for (const pl of snap.players || []) {
      if (pl.id === this.session?.playerId) continue;
      this.remotes.set(pl.id, { ...pl });
    }
    if (snap.folds) this.folds = snap.folds.slice();
    if (snap.state === "pick" && this.state === "playing") {
      this.hooks.toast?.("等待主机选择折纹…");
    }
    this.hooks.onHud?.();
  }

  draw() {
    const ctx = this.ctx;
    const pal = this.biome.palette;
    const shakeAmt = this.shake * (this.shakeMul ?? 1);
    const sx = (Math.random() - 0.5) * shakeAmt;
    const sy = (Math.random() - 0.5) * shakeAmt;

    ctx.save();
    ctx.translate(sx, sy);

    // background atmosphere
    const g = ctx.createRadialGradient(this.w * 0.3, this.h * 0.2, 0, this.w * 0.5, this.h * 0.5, Math.max(this.w, this.h) * 0.75);
    g.addColorStop(0, pal.bg2);
    g.addColorStop(1, pal.bg1);
    ctx.fillStyle = g;
    ctx.fillRect(-20, -20, this.w + 40, this.h + 40);

    this.drawCreaseGrid(ctx, pal);
    this.drawFields(ctx);
    this.drawCreaseTrails(ctx);
    this.particles.draw(ctx);
    this.drawPickups(ctx);
    this.drawEnemies(ctx);
    this.drawBullets(ctx);
    this.drawBirds(ctx);
    this.drawRemotes(ctx);
    this.drawPlayer(ctx);
    this.drawFloats(ctx);

    // vignette
    ctx.fillStyle = pal.fog;
    ctx.fillRect(-20, -20, this.w + 40, this.h + 40);

    ctx.restore();

    if (this.flashAlpha > 0) {
      ctx.fillStyle = `rgba(255, 220, 140, ${this.flashAlpha})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    if (this.showFps) {
      ctx.fillStyle = "rgba(244,251,248,0.45)";
      ctx.font = "12px Noto Sans SC, sans-serif";
      ctx.textAlign = "right";
      const net = this.netRole === "solo" ? "单机" : this.netRole === "host" ? `主机×${this.playerCount}` : "客机";
      ctx.fillText(`${this.fps} FPS · ${net} · 粒子 ${this.particles.pool.count}`, this.w - 14, 22);
    }
    if (this.killStreak >= 5) {
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,210,122,0.95)";
      ctx.font = "600 22px Noto Sans SC, sans-serif";
      ctx.fillText(`${this.killStreak} 连折`, this.w * 0.5, 48);
      if (this.vacuumT > 0) {
        ctx.font = "12px Noto Sans SC, sans-serif";
        ctx.fillStyle = "rgba(244,251,248,0.7)";
        ctx.fillText("折光回涌 · 自动吸尘", this.w * 0.5, 68);
      }
    }
    if (this.clearFanfare > 0) {
      ctx.textAlign = "center";
      ctx.globalAlpha = Math.min(1, this.clearFanfare * 1.4);
      ctx.fillStyle = "#ffe1a0";
      ctx.font = "600 28px ZCOOL XiaoWei, Noto Sans SC, serif";
      ctx.fillText("纸页翻折", this.w * 0.5, this.h * 0.22);
      ctx.globalAlpha = 1;
    }
  }

  drawRemotes(ctx) {
    for (const r of this.remotes.values()) {
      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = "#9ad7ef";
      ctx.strokeStyle = "#2f8fbb";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -14); ctx.lineTo(12, 2); ctx.lineTo(0, 14); ctx.lineTo(-12, 2);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#f4fbf8";
      ctx.font = "11px Noto Sans SC, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(r.name || "折客", 0, -20);
      ctx.restore();
    }
  }

  drawCreaseGrid(ctx, pal) {
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 1;
    const step = 96;
    const off = (this.time * 8) % step;
    ctx.beginPath();
    for (let x = -step + off; x < this.w + step; x += step) {
      ctx.moveTo(x, 0); ctx.lineTo(x + this.h * 0.15, this.h);
    }
    for (let y = -step + off * 0.5; y < this.h + step; y += step) {
      ctx.moveTo(0, y); ctx.lineTo(this.w, y + this.w * 0.08);
    }
    ctx.stroke();

    // floating paper shards (decorative, few)
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = "#f4fbf8";
    for (let i = 0; i < 8; i++) {
      const x = ((i * 137 + this.bgSeed * 13 + this.time * (8 + i)) % (this.w + 80)) - 40;
      const y = (Math.sin(this.time * 0.4 + i) * 0.5 + 0.5) * this.h;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(this.time * 0.2 + i);
      ctx.fillRect(-10, -6, 20, 12);
      ctx.restore();
    }
    ctx.restore();
  }

  drawPlayer(ctx) {
    const p = this.player;
    const pulse = 1 + Math.sin(this.time * 6) * 0.03;
    ctx.save();
    ctx.translate(p.x, p.y);
    // soft glow
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = "#ffe1a0";
    ctx.beginPath();
    ctx.arc(0, 0, 26 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = p.inv > 0 ? 0.55 + Math.sin(this.time * 30) * 0.25 : 1;

    // origami body — diamond fold
    ctx.fillStyle = "#f4fbf8";
    ctx.strokeStyle = "#e89a2d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -14); ctx.lineTo(12, 2); ctx.lineTo(0, 14); ctx.lineTo(-12, 2);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // crease highlight
    ctx.beginPath();
    ctx.moveTo(0, -14); ctx.lineTo(0, 14);
    ctx.strokeStyle = "rgba(12,47,58,0.25)";
    ctx.stroke();

    // aim fold tip
    ctx.rotate(Math.atan2(p.aimY, p.aimX));
    ctx.fillStyle = "#e89a2d";
    ctx.beginPath();
    ctx.moveTo(16, 0); ctx.lineTo(8, -5); ctx.lineTo(8, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawBirds(ctx) {
    for (const bird of this.birds) {
      if (bird.x == null) continue;
      ctx.save();
      ctx.translate(bird.x, bird.y);
      ctx.rotate(bird.ang);
      ctx.fillStyle = "#d8ebe4";
      ctx.strokeStyle = "#2f8f7a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(8, 0); ctx.lineTo(-6, -5); ctx.lineTo(-2, 0); ctx.lineTo(-6, 5);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }

  drawEnemies(ctx) {
    for (const e of this.enemies.live) {
      if (e.hidden) ctx.globalAlpha = 0.22;
      else ctx.globalAlpha = 1;
      ctx.save();
      ctx.translate(e.x, e.y);
      const c = e.flash > 0 ? [255, 245, 220] : e.color;
      const a = e.accent || [255, 255, 255];
      const stroke = e.elite || e.boss
        ? `rgb(${a[0]},${a[1]},${a[2]})`
        : `rgba(${a[0]},${a[1]},${a[2]},0.95)`;
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = e.boss ? 3 : 2.2;

      // 外圈光晕，提高素体辨识
      ctx.globalAlpha = e.hidden ? 0.12 : 0.28;
      ctx.beginPath();
      ctx.arc(0, 0, e.r + 5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.55)`;
      ctx.fill();
      ctx.globalAlpha = e.hidden ? 0.22 : 1;
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;

      const shape = e.shape || (e.boss ? "boss" : e.ranged ? "drone" : "mite");
      this._drawEnemyShape(ctx, shape, e);

      // 高光点，进一步区分
      ctx.fillStyle = `rgba(${a[0]},${a[1]},${a[2]},0.85)`;
      ctx.beginPath();
      ctx.arc(-e.r * 0.25, -e.r * 0.3, Math.max(2, e.r * 0.18), 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();

      if (e.elite || e.boss) {
        const bw = e.boss ? 64 : 36;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(e.x - bw / 2, e.y - e.r - 12, bw, 4);
        ctx.fillStyle = e.boss ? "#e89a2d" : "#7fd0c0";
        ctx.fillRect(e.x - bw / 2, e.y - e.r - 12, bw * clamp(e.hp / e.maxHp, 0, 1), 4);
      }
      ctx.globalAlpha = 1;
    }
  }

  _drawEnemyShape(ctx, shape, e) {
    const r = e.r;
    ctx.beginPath();
    switch (shape) {
      case "drone":
      case "sentry":
        ctx.moveTo(0, -r);
        ctx.lineTo(r * 0.95, r * 0.7);
        ctx.lineTo(-r * 0.95, r * 0.7);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        // 触角
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.lineTo(0, -r - 6);
        ctx.stroke();
        break;
      case "brute":
        ctx.rotate(0.2);
        ctx.rect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-r * 0.4, 0); ctx.lineTo(r * 0.4, 0);
        ctx.stroke();
        break;
      case "wisp":
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "lurker":
        ctx.moveTo(-r, 0);
        ctx.quadraticCurveTo(0, -r * 1.2, r, 0);
        ctx.quadraticCurveTo(0, r * 0.7, -r, 0);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        break;
      case "hydra":
        for (let i = 0; i < 3; i++) {
          const ang = -Math.PI / 2 + (i - 1) * 0.55;
          ctx.beginPath();
          ctx.ellipse(Math.cos(ang) * r * 0.35, Math.sin(ang) * r * 0.35, r * 0.55, r * 0.35, ang, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
        }
        break;
      case "moth":
        ctx.ellipse(-r * 0.55, 0, r * 0.55, r * 0.35, -0.4, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(r * 0.55, 0, r * 0.55, r * 0.35, 0.4, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.28, 0, Math.PI * 2);
        ctx.fill();
        break;
      case "knight":
        ctx.moveTo(0, -r);
        ctx.lineTo(r * 0.75, -r * 0.2);
        ctx.lineTo(r * 0.45, r);
        ctx.lineTo(-r * 0.45, r);
        ctx.lineTo(-r * 0.75, -r * 0.2);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        break;
      case "weaver":
        for (let i = 0; i < 5; i++) {
          const ang = (i / 5) * Math.PI * 2 + this.time;
          const rr = i % 2 ? r * 0.55 : r;
          const x = Math.cos(ang) * rr, y = Math.sin(ang) * rr;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        break;
      case "boss":
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * Math.PI * 2 + this.time * 0.4;
          const rr = e.r * (i % 2 ? 0.75 : 1);
          const x = Math.cos(ang) * rr, y = Math.sin(ang) * rr;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        break;
      case "mite":
      default:
        ctx.rotate(e.ang * 0.2 + this.time * 0.5);
        ctx.moveTo(0, -r);
        ctx.lineTo(r, 0);
        ctx.lineTo(0, r);
        ctx.lineTo(-r, 0);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        // 小足点
        ctx.fillStyle = ctx.strokeStyle;
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(s * r * 0.7, r * 0.15, 2, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
    }
  }

  drawBullets(ctx) {
    for (const b of this.bullets.live) {
      ctx.fillStyle = `rgb(${b.color[0]},${b.color[1]},${b.color[2]})`;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      // crease streak
      ctx.strokeStyle = `rgba(${b.color[0]},${b.color[1]},${b.color[2]},0.5)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - b.vx * 0.02, b.y - b.vy * 0.02);
      ctx.stroke();
    }
  }

  drawFields(ctx) {
    for (const f of this.fields.live) {
      const t = clamp(f.life, 0, 1);
      ctx.globalAlpha = 0.18 + 0.25 * t;
      ctx.strokeStyle = `rgb(${f.color[0]},${f.color[1]},${f.color[2]})`;
      ctx.fillStyle = `rgba(${f.color[0]},${f.color[1]},${f.color[2]},0.12)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * (0.85 + (1 - t) * 0.2), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // origami ring ticks
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + this.time * 2;
        ctx.beginPath();
        ctx.moveTo(f.x + Math.cos(ang) * (f.r - 4), f.y + Math.sin(ang) * (f.r - 4));
        ctx.lineTo(f.x + Math.cos(ang) * (f.r + 4), f.y + Math.sin(ang) * (f.r + 4));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  drawCreaseTrails(ctx) {
    for (const c of this.creaseTrails) {
      ctx.globalAlpha = clamp(c.life * 2, 0, 0.5);
      ctx.strokeStyle = "#d8ebe4";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r * (1.2 - c.life), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawPickups(ctx) {
    for (const u of this.pickups.live) {
      const bob = Math.sin(this.time * 5 + u.x) * 3;
      ctx.save();
      ctx.translate(u.x, u.y + bob);
      if (u.kind === "dust") {
        ctx.fillStyle = "#e89a2d";
        ctx.beginPath();
        ctx.moveTo(0, -7); ctx.lineTo(6, 0); ctx.lineTo(0, 7); ctx.lineTo(-6, 0);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = "#3ecf9a";
        ctx.beginPath();
        ctx.arc(0, 0, 7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawFloats(ctx) {
    ctx.font = "600 13px Noto Sans SC, sans-serif";
    ctx.textAlign = "center";
    for (const f of this.floats.live) {
      ctx.globalAlpha = clamp(f.life * 1.4, 0, 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }
}
