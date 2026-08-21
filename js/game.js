import { Pool, SpatialHash, clamp, lerp, norm, rand, pick, chance, len } from "./util.js";
import { Particles } from "./particles.js";
import {
  FOLDS, RELICS, ENEMIES, BOSSES, BIOMES, SYNERGIES, RARITY, isUnlocked,
} from "./content.js";
import { markSeen, flushPendingSave } from "./save.js";
import { scaleForPlayers, computeFoldSeal, sealBalance } from "./net/protocol.js";
import { qualityPreset } from "./settings.js";
import { TouchControls } from "./touch-controls.js";

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

    this.particles = new Particles(900);
    this.bullets = new Pool(makeBullet, 160, 280);
    this.enemies = new Pool(makeEnemy, 96, 160);
    this.pickups = new Pool(makePickup, 48, 80);
    this.fields = new Pool(makeField, 40, 72);
    this.floats = new Pool(makeFloat, 48, 64);
    this.hash = new SpatialHash(96);
    this.queryBuf = [];
    this._bgGrad = null;
    this._bgGradKey = "";
    this.bgShards = 6;
    this.gfx = qualityPreset("med");
    this.roomKind = "combat";
    this.settings = null;

    this.keys = Object.create(null);
    this.mouse = { x: 0, y: 0, down: false, right: false };
    this.touch = null;
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
    this.remotes = new Map(); // id -> remote fighter
    this.remoteInputs = new Map();
    this.peerMeta = new Map(); // id -> { seal, unlocked, name, ... }
    this.hostSeal = 12;
    this.localSeal = 12;
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
    const q = qualityPreset(settings?.quality);
    this.gfx = q;
    this._dprCap = q.dprCap;
    this.particles.max = q.particles;
    this.particles.fxScale = q.fxScale ?? 1;
    this.particles.allowSparks = q.sparkParticles !== false;
    this.shakeMul = (settings?.screenShake === false ? 0 : 1) * q.shake;
    this.showFps = settings?.showFps !== false;
    this.reduceFlash = !!settings?.reduceFlash;
    this.drawTrails = q.trails;
    this.bgShards = q.bgShards ?? 6;
    this._bgGrad = null;
    this.resize();
  }

  setFlash(amount) {
    const mul = this.reduceFlash ? 0.22 : 1;
    this.flashAlpha = Math.max(this.flashAlpha, amount * mul);
  }

  setSession(session) {
    this.session = session;
    this.netRole = session?.role === "host" ? "host" : session?.role === "client" ? "client" : "solo";
    this.playerCount = session?.playerCount || 1;
    // 客机粒子跟主机快照，避免本地预测再刷一套导致画面不一致
    this.particles.suppressLocal = this.netRole === "client";
  }

  setTutorial(tutorial) {
    this.tutorial = tutorial;
  }

  setPeerMeta(playerId, meta) {
    if (!playerId || !meta) return;
    const cleaned = {
      name: String(meta.name || "折客").slice(0, 12),
      seal: Math.max(1, meta.seal | 0),
      unlocked: { ...(meta.unlocked || {}) },
      bestFloor: meta.bestFloor | 0,
      totalRuns: meta.totalRuns | 0,
    };
    this.peerMeta.set(playerId, cleaned);
    const r = this.remotes.get(playerId);
    if (r) this._applySealToRemote(r);
  }

  _hostSealValue() {
    return this.hostSeal || computeFoldSeal(this.save) || 12;
  }

  _applySealToRemote(r) {
    const meta = this.peerMeta.get(r.id);
    const hostSeal = this._hostSealValue();
    const guestSeal = meta?.seal ?? r.seal ?? hostSeal;
    const bal = sealBalance(guestSeal, hostSeal);
    r.seal = bal.seal;
    r.atkMul = bal.atkMul;
    r.hpMul = bal.hpMul;
    r.dmgTakenMul = bal.dmgTakenMul;
    r.unlocked = meta?.unlocked || r.unlocked || {};
    if (meta?.name) r.name = meta.name;
    // 刷新血量上限（保留当前比例）
    const ratio = r.maxHp > 0 ? clamp(r.hp / r.maxHp, 0, 1) : 1;
    this._rebuildRemoteCombat(r);
    r.hp = Math.max(1, Math.round(r.maxHp * ratio));
  }

  /** 客机战力：各自折纹/遗物 + 折印平衡（不再共享主机折纹） */
  _rebuildRemoteCombat(r) {
    const unlocks = r.unlocked || {};
    const fake = {
      stats: {
        maxHp: 120, maxMp: 100, damage: 16, fireRate: 0.16, moveSpeed: 250,
        dashCd: 0.7, dashSpeed: 660, dashDur: 0.15,
        extraShots: 0, spread: 0.05, pierce: 1, chain: 0,
        bulletSpeed: 560, ultDamage: 70, mpRegen: 16,
      },
      flags: {},
      hp: 120,
    };
    const folds = r.folds?.length ? r.folds : ["crease_bolt"];
    const counts = Object.create(null);
    for (const id of folds) counts[id] = (counts[id] || 0) + 1;
    for (const [id, n] of Object.entries(counts)) {
      FOLDS[id]?.apply(fake, n);
    }
    const relics = r.relics || ["first_crease"];
    if (relics.includes("first_crease")) fake.stats.damage *= 1.12;
    if (relics.includes("spare_ink") || unlocks.spare_ink) fake.stats.mpRegen += 10;

    const atkMul = r.atkMul ?? 1;
    const hpMul = r.hpMul ?? 1;
    fake.stats.damage *= atkMul;
    fake.stats.ultDamage *= atkMul;
    fake.stats.maxHp = Math.round(fake.stats.maxHp * hpMul);

    r.combat = fake.stats;
    r.flags = fake.flags;
    r.maxHp = fake.stats.maxHp;
    r.hasPhoenix = !!(unlocks.phoenix_fold || relics.includes("phoenix_fold"));
  }

  ensureRemote(fromId, name) {
    let r = this.remotes.get(fromId);
    if (r) return r;
    const meta = this.peerMeta.get(fromId);
    const unlocks = meta?.unlocked || {};
    r = {
      id: fromId,
      x: this.w * 0.5 + rand(-40, 40),
      y: this.h * 0.5 + rand(-40, 40),
      hp: 120, maxHp: 120, aimX: 1, aimY: 0,
      name: meta?.name || name || "折客",
      down: false,
      unlocked: unlocks,
      seal: meta?.seal || this._hostSealValue(),
      atkMul: 1, hpMul: 1, dmgTakenMul: 1,
      phoenixUsed: false,
      folds: ["crease_bolt"],
      relics: ["first_crease"],
      pickLeft: 0,
      picksTaken: 0,
      _offerIds: null,
      _admitted: false,
      _catchUp: false,
    };
    if (unlocks.starting_twin) r.folds.push("twin_refraction");
    if (unlocks.dusk_compass) r.relics.push("dusk_compass");
    if (unlocks.spare_ink) r.relics.push("spare_ink");
    if (unlocks.lucky_seam) r.relics.push("lucky_seam");
    if (unlocks.phoenix_fold) r.relics.push("phoenix_fold");
    this.remotes.set(fromId, r);
    this._applySealToRemote(r);
    r.hp = r.maxHp;
    return r;
  }

  _bindInput() {
    const codeOf = (e) => {
      if (e.code) return e.code;
      const k = e.key;
      if (k === "w" || k === "W") return "KeyW";
      if (k === "a" || k === "A") return "KeyA";
      if (k === "s" || k === "S") return "KeyS";
      if (k === "d" || k === "D") return "KeyD";
      if (k === " ") return "Space";
      return "";
    };
    const playing = () => this.state === "playing" || this.state === "pick";
    window.addEventListener("keydown", (e) => {
      // 联机大厅输入框抢焦点时，局内直接打回 canvas，避免 WASD 进文本框
      const tag = e.target?.tagName;
      if (playing() && (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable)) {
        e.target.blur?.();
        this.canvas?.focus?.();
      }
      if (e.isComposing) return;
      const code = codeOf(e);
      if (!code) return;
      this.keys[code] = true;
      if (code === "Escape" && this.state === "playing") this.hooks.onPause();
      if (code === "Space" || code === "ShiftLeft" || code === "ShiftRight") this._inputForceSend = true;
      if (code === "Space" || code === "ArrowUp" || code === "ArrowDown" || code === "ArrowLeft" || code === "ArrowRight") {
        if (playing()) e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.isComposing) return;
      const code = codeOf(e);
      if (code) {
        this.keys[code] = false;
        if (code === "Space" || code === "ShiftLeft" || code === "ShiftRight") this._inputForceSend = true;
      }
    });
    window.addEventListener("blur", () => {
      for (const k of Object.keys(this.keys)) this.keys[k] = false;
      this.mouse.down = false;
      this.mouse.right = false;
      this.touch?.resetAxes?.();
      this._inputForceSend = true;
      if (this.netRole === "client" && this.state === "playing") this._sendNetInput();
    });

    const syncPointer = (clientX, clientY) => {
      const rect = this.canvas.getBoundingClientRect();
      const rw = rect.width || 1;
      const rh = rect.height || 1;
      this.mouse.x = (clientX - rect.left) * (this.w / rw);
      this.mouse.y = (clientY - rect.top) * (this.h / rh);
    };

    // 绑到 window，避免教程遮罩挡住 canvas 导致无法瞄准射击
    window.addEventListener("mousemove", (e) => syncPointer(e.clientX, e.clientY));
    window.addEventListener("mousedown", (e) => {
      syncPointer(e.clientX, e.clientY);
      if (e.button === 0) { this.mouse.down = true; this._inputForceSend = true; }
      if (e.button === 2) { this.mouse.right = true; this._inputForceSend = true; }
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) { this.mouse.down = false; this._inputForceSend = true; }
      if (e.button === 2) { this.mouse.right = false; this._inputForceSend = true; }
    });
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // 触控双摇杆（左移右射）；未启用前保留单指瞄准开火兜底
    const app = document.getElementById("app") || document.body;
    this.touch = new TouchControls({
      root: app,
      onPause: () => {
        if (this.state === "playing") this.hooks.onPause?.();
      },
    });
    this.touch.preferArm();

    this.canvas.addEventListener("touchstart", (e) => {
      if (this.touch?.enabled) return;
      if (!e.touches.length) return;
      this.touch?.arm();
      const t = e.touches[0];
      syncPointer(t.clientX, t.clientY);
      this.mouse.down = true;
      this._inputForceSend = true;
      e.preventDefault();
    }, { passive: false });
    this.canvas.addEventListener("touchmove", (e) => {
      if (this.touch?.enabled) return;
      if (!e.touches.length) return;
      const t = e.touches[0];
      syncPointer(t.clientX, t.clientY);
      e.preventDefault();
    }, { passive: false });
    this.canvas.addEventListener("touchend", () => {
      if (this.touch?.enabled) return;
      this.mouse.down = false;
      this._inputForceSend = true;
    });
    this.canvas.addEventListener("touchcancel", () => {
      if (this.touch?.enabled) return;
      this.mouse.down = false;
      this._inputForceSend = true;
    });
  }

  /** 供 UI 同步：HUD / 遮罩显隐 */
  setTouchHud(open) {
    this.touch?.setHudOpen(open);
  }

  setTouchBlocked(blocked) {
    this.touch?.setBlocked(blocked);
  }

  resize() {
    const cap = this._dprCap || 2;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    this.dpr = dpr;
    this.viewW = window.innerWidth;
    this.viewH = window.innerHeight;
    // 客机锁定主机世界尺寸，避免两边分辨率不同导致人物画到屏外
    if (!(this.netRole === "client" && this._netWorldLocked)) {
      this.w = this.viewW;
      this.h = this.viewH;
    }
    this.canvas.width = (this.viewW * dpr) | 0;
    this.canvas.height = (this.viewH * dpr) | 0;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._bgGrad = null;
  }

  /** 客机采用主机权威世界坐标 */
  lockNetWorld(worldW, worldH) {
    const w = Math.max(320, worldW | 0);
    const h = Math.max(240, worldH | 0);
    const changed = !(this._netWorldLocked && this.w === w && this.h === h);
    this.w = w;
    this.h = h;
    this._netWorldLocked = true;
    if (changed) this._bgGrad = null;
    // 视口仍跟本机窗口走
    const cap = this._dprCap || 2;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    this.dpr = dpr;
    this.viewW = window.innerWidth;
    this.viewH = window.innerHeight;
    this.canvas.width = (this.viewW * dpr) | 0;
    this.canvas.height = (this.viewH * dpr) | 0;
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
    this._lastSnapAt = 0;
    this._lastSnapT = null;
    this._snapWarn = false;
    this._lastInputSentAt = 0;
    this._inputForceSend = false;
    this._netWorldLocked = false;
    // peerMeta 在开局前由联机大厅收集，开局保留
    this.localSeal = computeFoldSeal(this.save);
    this.hostSeal = this.netRole === "client"
      ? (this.hostSeal || this.localSeal)
      : this.localSeal;
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
    this.particles.suppressLocal = this.netRole === "client";
    this.picksTaken = 0;

    // 客机若已收到主机世界尺寸，先锁上再刷布局
    if (this.netRole === "client" && this._pendingWorldW && this._pendingWorldH) {
      this.lockNetWorld(this._pendingWorldW, this._pendingWorldH);
    } else {
      this.resize();
    }

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
    this.roomKind = "combat";
    // 保留画质/无障碍设置，不在此冲掉
    if (this.settings) this.applySettings(this.settings);

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
    this._applyStarterSeed();
    this.rebuildStats();
    this.player.hp = this.player.stats.maxHp;
    this.player.mp = this.player.stats.maxMp;

    this.pickBiome();
    this.state = "playing";
    this.touch?.preferArm();
    this.touch?.resetAxes();
    this.setTouchHud(true);
    this.setTouchBlocked(false);
    // 保持当前世界锁（客机）或刷新视口
    this.resize();
    // 客机等主机快照；主机/单机本地开房
    if (this.netRole !== "client") {
      if (this.netRole === "host") {
        for (const [id, meta] of this.peerMeta) {
          if (id === this.session?.playerId) continue;
          const r = this.ensureRemote(id, meta.name);
          r._admitted = true;
          r.picksTaken = 0;
        }
      }
      this.beginRoom(true);
    }
    this.hooks.onHud();
  }

  /**
   * 前几局赠送一条起步折纹（移速 / 散射 / 生存），避免未解锁时手感雷同。
   */
  _applyStarterSeed() {
    const runs = this.save.totalRuns | 0;
    if (runs >= 3) return;
    const pool = [
      { id: "origami_swift", tip: "新手种子：纸燕步" },
      { id: "twin_refraction", tip: "新手种子：双折射" },
      { id: "crease_armor", tip: "新手种子：叠甲" },
    ];
    // 已买「开局双折射」时，把散射位换成墨潮，避免叠两层 twin 却缺生存/输出变化
    if (this.save.unlocked.starting_twin) {
      pool[1] = { id: "prism_burst", tip: "新手种子：棱爆" };
    }
    const seed = pool[runs % pool.length];
    if (!seed || this.folds.includes(seed.id)) return;
    this.addFold(seed.id, false);
    this.hooks.toast?.(seed.tip);
  }

  /** 教程结束：清场 + 短无敌，避免跳过后站桩秒挂 */
  safeExitTutorial() {
    this.enemies.clear();
    this.bullets.clear();
    this.fields.clear();
    this.swarmLeft = 0;
    this.swarmCd = 1.2;
    this.waveTimer = 0.8;
    if (this.player) {
      this.player.inv = Math.max(this.player.inv || 0, 2.2);
      this.player.hp = Math.max(this.player.hp, Math.round(this.player.stats.maxHp * 0.85));
    }
    if (this.netRole !== "client" && this.state === "playing" && this.enemies.count === 0) {
      this.defer(0.4, () => {
        if (this.state !== "playing" || this.roomDone) return;
        if (this.enemies.count === 0 && this.swarmLeft <= 0) this.spawnWave(false);
      });
    }
    this.hooks.toast?.("教程结束 · 短暂无敌");
    this.hooks.onHud?.();
  }

  rebuildStats() {
    const p = this.player;
    const prevMax = p.stats?.maxHp || 120;
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
    // 最大生命上涨时只补差额，避免叠甲每次 rebuild 白嫖治疗
    const gained = p.stats.maxHp - prevMax;
    if (gained > 0) p.hp = Math.min(p.stats.maxHp, p.hp + gained);
    else p.hp = Math.min(p.hp, p.stats.maxHp);
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
    this._bgGrad = null;
    markSeen(this.save, "biomes", chosen);
  }

  refreshSynergies() {
    this.synergies = [];
    const have = new Set(this.folds);
    for (const syn of SYNERGIES) {
      // 局内凑齐即可觉醒；工坊解锁仅影响图鉴配方提示
      if (!syn.need.every((id) => have.has(id))) continue;
      this.synergies.push(syn.id);
      if (!this.save.discoveredSynergies[syn.id]) {
        this.save.discoveredSynergies[syn.id] = true;
        markSeen(this.save, "synergies", syn.id);
        this.hooks.toast(`共鸣觉醒：${syn.name}`);
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

    // 房间种类：休整 / 事件 / 精英 / 常规
    if (isBoss) this.roomKind = "boss";
    else if (!first && this.room === 2 && chance(0.5)) this.roomKind = "rest";
    else if (!first && this.room === 1 && this.floor >= 2 && chance(0.28)) this.roomKind = "event";
    else if (this.room === 3 && (this.relics.includes("dusk_compass") || chance(0.4))) this.roomKind = "elite";
    else this.roomKind = "combat";

    if (!first && this.player) {
      this.player.x = this.w * 0.5;
      this.player.y = this.h * 0.5;
      this.player.inv = 0.6;
    }

    if (this.roomKind === "rest") {
      const heal = Math.round(this.player.stats.maxHp * 0.35);
      this.player.hp = Math.min(this.player.stats.maxHp, this.player.hp + heal);
      this.spawnPickup(this.player.x, this.player.y - 40, "heal", heal);
      this.hooks.toast("休憩折页：折光回复，挑选折纹");
      this.hooks.onHud();
      this.roomDone = true;
      this.defer(0.35, () => this.onRoomCleared());
      return;
    }

    if (this.roomKind === "event") {
      if (chance(0.55)) {
        this.dustEarned += 22;
        this.spawnPickup(this.player.x, this.player.y - 30, "dust", 22);
        this.player.hp = Math.min(this.player.stats.maxHp, this.player.hp + 25);
        this.hooks.toast("赌尘折页：折光尘与生命回涌");
      } else {
        this.player.hp = Math.max(1, this.player.hp - 18);
        this.pendingPicks = Math.max(this.pendingPicks, 0);
        this._eventBonusPick = true;
        this.hooks.toast("诅咒折页：献血换一张额外折纹");
      }
      this.hooks.onHud();
      this.roomDone = true;
      this.defer(0.35, () => this.onRoomCleared());
      return;
    }

    if (isBoss) {
      this.spawnBoss();
    } else if (this.roomKind === "elite") {
      this.spawnWave(true);
      if (isUnlocked(this.save, ENEMIES.seam_knight)) this.spawnEnemy("seam_knight", true);
      this.hooks.toast("精英折页：强敌现身");
    } else {
      this.spawnWave(false);
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
      phase: 1, phaseCd: 2.2, skillCd: 3.5,
    });
    e.maxHp = e.hp;
    markSeen(this.save, "enemies", id);
    markSeen(this.save, "bosses", id);
    this.hooks.toast(`守门者降临：${def.name}`);
  }

  availableFolds(save = this.save) {
    return Object.values(FOLDS).filter((f) => isUnlocked(save, f));
  }

  availableRelics(save = this.save, relics = this.relics) {
    return Object.values(RELICS).filter((r) => {
      if (relics.includes(r.id)) return false;
      return isUnlocked(save, r);
    });
  }

  /** 选池跟个人解锁走；加成不是固定三选一，而是按各人解锁池加权抽取 */
  rollPicks(n = 3, save = this.save, folds = this.folds, relics = this.relics) {
    const pool = this.availableFolds(save);
    const relicPool = this.availableRelics(save, relics);
    const lucky = relics.includes("lucky_seam");
    const weights = pool.map((f) => {
      let w = f.rarity === "common" ? 50 : f.rarity === "rare" ? 28 : f.rarity === "epic" ? 14 : 6;
      if (lucky && f.rarity !== "common") w *= 1.55;
      if (folds.includes(f.id) && f.rarity === "legend") w *= 0.4;
      return w;
    });
    const picks = [];
    const used = new Set();
    if (relicPool.length && chance(0.18)) {
      const relic = pick(relicPool);
      picks.push({
        id: `relic:${relic.id}`,
        name: relic.name,
        desc: `遗物 · ${relic.desc}`,
        rarity: "epic",
        _relicId: relic.id,
      });
      used.add(picks[0].id);
    }
    for (let i = picks.length; i < n; i++) {
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
    this.setFlash(0.35);
    this.shake = 8;
    this.particles.burst(this.player.x, this.player.y, 30, {
      spdMin: 80, spdMax: 340, r: 255, g: 200, b: 100, spark: true,
    });
    this.hooks.toast?.(this.room > this.roomsPerFloor ? "守门者倒下 · 纸页翻开" : "房间折尽 · 各自选择折纹");

    if (this.room > this.roomsPerFloor) {
      if (this.floor >= this.maxFloors) {
        this.endRun(true);
        return;
      }
      this.floor++;
      this.room = 0;
      this.phoenixUsed = false;
      for (const r of this.remotes.values()) r.phoenixUsed = false;
      this.pickBiome();
    }
    this.pendingPicks = this.player.flags.extraPick ? 2 : 1;
    if (this._eventBonusPick) {
      this.pendingPicks++;
      this._eventBonusPick = false;
    }
    this.openPick();
  }

  openPick() {
    this.state = "pick";
    this.setTouchBlocked(true);
    this.hostPickDone = false;
    this.pickGrace = false;
    this.pickWaitT = 0;

    const myCards = this.rollPicks(3, this.save, this.folds, this.relics);
    this._offerIds = new Set(myCards.map((c) => c.id));
    this.hooks.onPick(myCards);

    if (this.netRole === "host") {
      const offers = {};
      offers[this.player.id] = myCards.map((c) => c.id);
      for (const [id, r] of this.remotes) {
        if (r.down) continue;
        const saveLike = { unlocked: r.unlocked || {} };
        if (!r.folds) r.folds = ["crease_bolt"];
        if (!r.relics) r.relics = ["first_crease"];
        r.pickLeft = r.folds.includes("cartographer") ? 2 : 1;
        const cards = this.rollPicks(3, saveLike, r.folds, r.relics);
        r._offerIds = new Set(cards.map((c) => c.id));
        offers[id] = cards.map((c) => c.id);
      }
      this.session?.send?.({ type: "pick", offers, pendingHint: 1 });
    }
  }

  /** 主机多选时只刷新自己的牌，不重置客机选池 */
  _openHostNextPick() {
    this.state = "pick";
    this.setTouchBlocked(true);
    const myCards = this.rollPicks(3, this.save, this.folds, this.relics);
    this._offerIds = new Set(myCards.map((c) => c.id));
    this.hooks.onPick(myCards);
  }

  _hydrateCards(ids) {
    return (ids || []).map((id) => {
      if (String(id).startsWith("relic:")) {
        const rid = String(id).slice(6);
        const relic = RELICS[rid];
        return relic ? { id, name: relic.name, desc: `遗物 · ${relic.desc}`, rarity: "epic" } : null;
      }
      return FOLDS[id] || null;
    }).filter(Boolean);
  }

  /** 客机收到专属选池 */
  receivePickOffer(ids, pending) {
    const cards = this._hydrateCards(ids);
    if (!cards.length) return;
    this.state = "pick";
    this.setTouchBlocked(true);
    this._offerIds = new Set(cards.map((c) => c.id));
    if (pending != null) this.pendingPicks = pending;
    else if (this.pendingPicks <= 0) this.pendingPicks = this.player.flags.extraPick ? 2 : 1;
    this.hooks.onPick(cards);
  }

  _applyPickToLocal(id) {
    if (String(id).startsWith("relic:")) {
      const rid = String(id).slice(6);
      if (RELICS[rid] && !this.relics.includes(rid)) {
        this.relics.push(rid);
        this.rebuildStats();
        this.hooks.toast(`获得遗物：${RELICS[rid].name}`);
        this.hooks.onHud();
      }
      return;
    }
    this.addFold(id);
  }

  _applyPickToRemote(r, id) {
    if (!r.folds) r.folds = ["crease_bolt"];
    if (!r.relics) r.relics = ["first_crease"];
    if (String(id).startsWith("relic:")) {
      const rid = String(id).slice(6);
      if (RELICS[rid] && !r.relics.includes(rid)) r.relics.push(rid);
    } else if (FOLDS[id]) {
      r.folds.push(id);
    }
    this._rebuildRemoteCombat(r);
  }

  choosePick(id) {
    if (this._offerIds && !this._offerIds.has(id)) {
      this.hooks.toast?.("无效的折纹选择");
      return;
    }

    // 客机：本地生效 + 上报主机，不推进房间
    if (this.netRole === "client") {
      this._applyPickToLocal(id);
      this.session?.sendChoose?.(id);
      this.pendingPicks--;
      this.picksTaken = (this.picksTaken || 0) + 1;
      this._offerIds = null;
      if (this.pendingPicks > 0) {
        this.hooks.toast?.("已选 · 等待下一张折纹…");
        // 下一张由主机再发 pick
        this.hooks.onPickClose();
        return;
      }
      this.hooks.onPickClose();
      this.state = "playing";
      this.setTouchBlocked(false);
      this.hooks.toast?.(this._catchUpJoin ? "补选完成 · 投入战斗" : "已选定 · 等待主机继续");
      this._catchUpJoin = false;
      return;
    }

    // 主机 / 单机
    this._applyPickToLocal(id);
    if (this.netRole === "host") {
      this.session?.send?.({ type: "choose", foldId: id, from: this.session.playerId, name: this.player.name, self: true });
    }
    this.pendingPicks--;
    this.picksTaken = (this.picksTaken || 0) + 1;
    if (this.pendingPicks > 0) {
      if (this.netRole === "host") this._openHostNextPick();
      else this.openPick();
      return;
    }

    if (this.netRole === "solo") {
      this.state = "playing";
      this.setTouchBlocked(false);
      this.hooks.onPickClose();
      this.beginRoom();
      return;
    }

    // 主机选完：无人在选则立刻继续，否则最多等 5 秒
    this.hostPickDone = true;
    this.hooks.onPickClose();
    this._tryFinishPickPhase();
  }

  onRemoteChoose(fromId, foldId, name) {
    if (this.netRole !== "host") return;
    if (!fromId || fromId === this.session?.playerId) return;
    const r = this.ensureRemote(fromId, name);
    if (r.pickLeft <= 0) return;
    if (r._offerIds && !r._offerIds.has(foldId)) {
      this.hooks.toast?.(`${r.name} 提交了无效选择`);
      return;
    }
    this._applyPickToRemote(r, foldId);
    r.pickLeft--;
    r.picksTaken = (r.picksTaken || 0) + 1;
    this.hooks.toast?.(`${r.name} 选定：${String(foldId).startsWith("relic:") ? RELICS[String(foldId).slice(6)]?.name : FOLDS[foldId]?.name || foldId}`);

    if (r.pickLeft > 0) {
      const saveLike = { unlocked: r.unlocked || {} };
      const cards = this.rollPicks(3, saveLike, r.folds, r.relics);
      r._offerIds = new Set(cards.map((c) => c.id));
      this.session?.send?.({
        type: "pick",
        offers: { [fromId]: cards.map((c) => c.id) },
        pendingHint: r.pickLeft,
        catchUp: !!r._catchUp,
      });
    } else {
      r._offerIds = null;
      if (r._catchUp) {
        r._catchUp = false;
        this.hooks.toast?.(`${r.name} 补选完成`);
      }
    }
    if (this.state === "pick") this._tryFinishPickPhase();
  }

  _remotesStillPicking() {
    for (const r of this.remotes.values()) {
      if (!r.down && r.pickLeft > 0) return true;
    }
    return false;
  }

  _tryFinishPickPhase() {
    if (this.netRole !== "host") return;
    if (!this.hostPickDone) return;
    if (!this._remotesStillPicking()) {
      this._endPickPhase();
      return;
    }
    if (!this.pickGrace) {
      this.pickGrace = true;
      this.pickWaitT = 5;
      this.hooks.toast?.("主机已选定 · 等待队友最多 5 秒");
    }
  }

  _updatePickWait(dt) {
    if (!this.pickGrace || !this.hostPickDone) return;
    if (!this._remotesStillPicking()) {
      this._endPickPhase();
      return;
    }
    this.pickWaitT -= dt;
    if (this.pickWaitT <= 0) {
      for (const r of this.remotes.values()) {
        if (r.pickLeft > 0) {
          r.pickLeft = 0;
          r._offerIds = null;
        }
      }
      this.hooks.toast?.("等待结束 · 继续前进");
      this._endPickPhase();
    }
  }

  _endPickPhase() {
    this.pickGrace = false;
    this.pickWaitT = 0;
    this.hostPickDone = false;
    this.state = "playing";
    this.setTouchBlocked(false);
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

  endRun(won, opts = {}) {
    if (this.state === "result") return;
    this.state = "result";
    this.setTouchBlocked(true);
    this.touch?.resetAxes();

    const payout = opts.bonus != null || opts.dust != null
      ? {
          runDust: opts.runDust ?? this.dustEarned,
          bonus: opts.bonus ?? 0,
          nurture: opts.nurture ?? 0,
          total: opts.dust ?? ((opts.runDust ?? this.dustEarned) + (opts.bonus ?? 0) + (opts.nurture ?? 0)),
        }
      : this._calcRunPayout(won);

    if (!opts.fromNet) {
      this.save.totalRuns++;
      this.save.totalKills += this.kills;
      this.save.bestFloor = Math.max(this.save.bestFloor, this.floor);
      flushPendingSave(this.save);
      if (this.netRole === "host") {
        this.session?.sendEnd?.({
          won, floor: this.floor, kills: this.kills,
          dust: payout.total, bonus: payout.bonus, runDust: payout.runDust, nurture: payout.nurture,
        });
      }
    } else {
      // 客机跟主机结算：只升本地履历，尘由 showResult 统一 grant
      this.save.totalRuns++;
      this.save.totalKills += (opts.kills ?? this.kills);
      this.save.bestFloor = Math.max(this.save.bestFloor, opts.floor ?? this.floor);
      flushPendingSave(this.save);
    }
    this.hooks.onResult({
      won,
      floor: opts.floor ?? this.floor,
      kills: opts.kills ?? this.kills,
      dust: payout.total,
      bonus: payout.bonus,
      nurture: payout.nurture,
      runDust: payout.runDust,
    });
  }

  /**
   * 结算尘：失败也有参与保底；前几局额外「安家」补贴，避免工坊永远尘不足。
   */
  _calcRunPayout(won) {
    const runDust = Math.max(0, this.dustEarned | 0);
    const floor = Math.max(1, this.floor | 0);
    const kills = Math.max(0, this.kills | 0);
    const roomProgress = Math.max(0, (this.room | 0) - 1);
    let bonus = 0;
    let nurture = 0;

    if (won) {
      bonus = 40 + floor * 8;
    } else {
      const salvage = Math.round(runDust * 0.22);
      const participate =
        12 +
        floor * 7 +
        Math.min(18, kills) +
        Math.min(15, roomProgress * 3);
      bonus = Math.max(salvage, participate);
    }

    const priorRuns = this.save.totalRuns | 0;
    if (!won && priorRuns < 3) {
      const target = priorRuns === 0 ? 36 : priorRuns === 1 ? 28 : 22;
      const projected = runDust + bonus;
      if (projected < target) nurture = target - projected;
    }

    return {
      runDust,
      bonus,
      nurture,
      total: runDust + bonus + nurture,
    };
  }

  removePeer(playerId) {
    if (!playerId) return;
    this.remotes.delete(playerId);
    this.remoteInputs.delete(playerId);
    this.peerMeta.delete(playerId);
    this.playerCount = 1 + [...this.remotes.values()].filter((x) => !x.down).length;
    if (this.state === "pick" && this.netRole === "host") {
      this._tryFinishPickPhase();
    }
  }

  /** 当前局内「已选 + 正在选」的最大进度，供中途加入补差 */
  _maxPickProgress(excludeId = null) {
    let m = this.picksTaken || 0;
    if (this.state === "pick") m += Math.max(0, this.pendingPicks | 0);
    for (const r of this.remotes.values()) {
      if (!r || r.id === excludeId) continue;
      let p = r.picksTaken || 0;
      if ((r.pickLeft | 0) > 0) p += r.pickLeft | 0;
      if (p > m) m = p;
    }
    return m;
  }

  _sendCatchUpPick(r) {
    if (!r || (r.pickLeft | 0) <= 0) return;
    const saveLike = { unlocked: r.unlocked || {} };
    if (!r.folds) r.folds = ["crease_bolt"];
    if (!r.relics) r.relics = ["first_crease"];
    const cards = this.rollPicks(3, saveLike, r.folds, r.relics);
    r._offerIds = new Set(cards.map((c) => c.id));
    this.session?.send?.({
      type: "pick",
      offers: { [r.id]: cards.map((c) => c.id) },
      pendingHint: r.pickLeft,
      catchUp: true,
    });
  }

  /**
   * 局中接纳新客机：同步进局，并按与主机/其他玩家的选卡进度差补选。
   */
  admitLatePeer(playerId, name) {
    if (this.netRole !== "host" || !playerId) return false;
    if (playerId === this.session?.playerId) return false;
    if (!(this.state === "playing" || this.state === "pick" || this.state === "pause")) return false;

    const r = this.ensureRemote(playerId, name);
    if (r._admitted) return false;
    r._admitted = true;
    r.down = false;
    r.picksTaken = r.picksTaken || 0;

    if (this.peerMeta.has(playerId)) this._applySealToRemote(r);

    const catchUp = Math.max(0, this._maxPickProgress(playerId) - (r.picksTaken || 0));
    r.pickLeft = catchUp;
    r._catchUp = catchUp > 0;

    const metas = {};
    for (const [id, meta] of this.peerMeta) metas[id] = meta;
    if (this.session.playerId) {
      metas[this.session.playerId] = metas[this.session.playerId] || {
        name: this.player?.name || this.session.name,
        seal: this.hostSeal,
        unlocked: this.save?.unlocked || {},
      };
    }

    this.session.startGame(Math.random(), {
      hostSeal: this.hostSeal,
      metas,
      worldW: this.w | 0,
      worldH: this.h | 0,
      lateJoin: true,
      catchUpPicks: catchUp,
    });
    this.session.sendSnapshot?.(this.buildSnapshot());

    if (catchUp > 0) {
      this._sendCatchUpPick(r);
      this.hooks.toast?.(`${r.name || name || "折客"} 中途加入 · 补选 ${catchUp} 张折纹`);
    } else {
      this.hooks.toast?.(`${r.name || name || "折客"} 中途加入`);
    }

    this.playerCount = 1 + [...this.remotes.values()].filter((x) => !x.down).length;
    return true;
  }

  /** 暂停/失焦时清键并强制上报，避免主机侧粘火 */
  clearNetIntent() {
    for (const k of Object.keys(this.keys)) this.keys[k] = false;
    this.mouse.down = false;
    this.mouse.right = false;
    this.touch?.resetAxes?.();
    this._touchFiring = false;
    this._inputForceSend = true;
    if (this.netRole === "client") this._sendNetInput();
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
    const tc = this.touch;
    if (tc?.enabled && (tc.moveX || tc.moveY)) {
      mx = tc.moveX;
      my = tc.moveY;
    }
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
      this.setFlash(0.28);
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
        const child = this.spawnEnemy(e.id === "paper_hydra" ? "paper_hydra" : "scrap_mite", false);
        if (child) {
          child.x = e.x + rand(-20, 20);
          child.y = e.y + rand(-20, 20);
          child.hp = e.maxHp * 0.35;
          child.maxHp = child.hp;
          child.r = Math.max(8, e.r * 0.55);
          child.color = e.color.slice();
          child.accent = (e.accent || [255, 180, 160]).slice();
          child.shape = e.shape || "hydra";
          child.split = false; // 子体不再分裂
          child.score = Math.max(1, (e.score * 0.4) | 0);
        }
      }
    }

    this.enemies.release(e);
    this.hooks.onHud();
  }

  hurtRemote(r, amount) {
    if (!r || r.down) return;
    const taken = amount * (r.dmgTakenMul ?? 1);
    r.hp = Math.max(0, (r.hp || 0) - taken);
    if (r.hp <= 0) {
      if (r.hasPhoenix && !r.phoenixUsed) {
        r.phoenixUsed = true;
        r.hp = 1;
        this.hooks.toast?.(`${r.name} 再生折发动`);
        return;
      }
      r.down = true;
      this.hooks.toast?.(`${r.name || "折客"} 倒地`);
    }
  }

  hurtPlayer(amount) {
    const p = this.player;
    if (this.tutorial?.active) return;
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
    if (this.state === "pick") {
      if (this.netRole === "host") {
        this._updatePickWait(dt);
        this.snapAcc += dt;
        if (this.snapAcc >= 0.15) {
          this.snapAcc = 0;
          this.session?.sendSnapshot?.(this.buildSnapshot());
        }
      }
      return;
    }
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

    // 客户端：本地预测移动 + 子弹外推；世界权威靠快照
    if (this.netRole === "client") {
      this.updatePlayer(dt, { predictOnly: true });
      this.updateBirds(dt);
      this._extrapolateClientWorld(dt);
      this.particles.update(dt);
      this.updateFloats(dt);
      this._sendNetInput();
      if (this._lastSnapAt && !this._snapWarn && performance.now() - this._lastSnapAt > 2500) {
        this._snapWarn = true;
        this.hooks.toast?.("长时间未收到主机快照，请确认中继仍在运行");
      }
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
    const tc = this.touch;
    if (tc?.enabled) {
      if (tc.moveX || tc.moveY) {
        mx = tc.moveX;
        my = tc.moveY;
      }
      if (tc.aiming) {
        const reach = 220;
        this.mouse.x = p.x + tc.aimX * reach;
        this.mouse.y = p.y + tc.aimY * reach;
        this.mouse.down = tc.fire;
        this._touchFiring = true;
      } else if (this._touchFiring) {
        this.mouse.down = false;
        this._touchFiring = false;
        if (mx || my) {
          this.mouse.x = p.x + mx * 180;
          this.mouse.y = p.y + my * 180;
        }
      } else if (!this.mouse.down && (mx || my)) {
        // 未拉射击摇杆时，朝移动方向瞄准，方便边跑边折冲
        this.mouse.x = p.x + mx * 180;
        this.mouse.y = p.y + my * 180;
      }
    }

    const wantDash = this.mouse.right || this.keys.ShiftLeft || this.keys.ShiftRight || !!tc?.dashHeld;
    const wantUlt = !!this.keys.Space || !!tc?.ultHeld;

    if (tc?.enabled) {
      const sig = `${tc.moveX.toFixed(2)},${tc.moveY.toFixed(2)},${tc.fire?1:0},${tc.dashHeld?1:0},${tc.ultHeld?1:0}`;
      if (sig !== this._touchSig) {
        this._touchSig = sig;
        this._inputForceSend = true;
      }
    }

    if (!opts.predictOnly) {
      if (this.mouse.down) this.firePlayer();
      if (wantDash) this.tryDash();
      if (wantUlt) this.tryUlt();
    } else {
      // 客机本地预测：开火/折冲立刻有反馈；权威仍由主机结算
      if (wantDash) this.tryDash();
      if (this.mouse.down) this.firePlayer();
      if (wantUlt) {
        this.tutorial?.note("ult");
        this._inputForceSend = true;
      }
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
      const target = this.nearestThreat(e.x, e.y);
      if (e.boss) {
        e.skillCd = Math.max(0, (e.skillCd || 0) - dt);
        const ratio = e.hp / Math.max(1, e.maxHp);
        const wantPhase = ratio < 0.33 ? 3 : ratio < 0.66 ? 2 : 1;
        if (wantPhase > (e.phase || 1)) {
          e.phase = wantPhase;
          this.hooks.toast?.(wantPhase === 2 ? `${e.name} · 第二折` : `${e.name} · 狂折`);
          this.setFlash(0.2);
          this.shake = Math.max(this.shake, 10);
          if (wantPhase === 2 && e.id === "hollow_cartographer") {
            for (let i = 0; i < 2; i++) {
              const clone = this.spawnEnemy("prism_sentry", false);
              if (clone) {
                clone.x = e.x + (i ? 80 : -80);
                clone.y = e.y + 40;
                clone.hp = Math.max(20, e.maxHp * 0.12);
                clone.maxHp = clone.hp;
                clone.color = e.color.slice();
              }
            }
          }
        }
        if (e.skillCd <= 0) {
          e.skillCd = e.phase >= 3 ? 2.2 : e.phase === 2 ? 3.0 : 4.0;
          this._bossSkill(e, target);
        }
      }
      const slowMul = e.slow > 0 ? 0.4 : 1;
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
          if (r.down) continue;
          if (len(e.x - r.x, e.y - r.y) < e.r + 14) {
            this.hurtRemote(r, e.damage * 0.35);
          }
        }
      }
    }
  }

  _bossSkill(e, target) {
    const tx = target?.x ?? this.player.x;
    const ty = target?.y ?? this.player.y;
    if (e.id === "folio_tyrant" || (e.phase >= 2 && e.id !== "lace_matron")) {
      // 砸落冲击波
      this.spawnField(tx, ty, {
        r: 70 + e.phase * 12, life: 0.45, kind: "burst",
        damage: e.damage * (0.8 + e.phase * 0.15), color: e.color.slice(),
      });
      this.particles.burst(tx, ty, 18, { r: e.color[0], g: e.color[1], b: e.color[2], spark: true });
    }
    if (e.id === "lace_matron" || e.phase >= 3) {
      // 光丝网减速
      this.spawnField(e.x, e.y, {
        r: 140 + e.phase * 20, life: 1.4, kind: "time",
        slow: 0.55, damage: e.damage * 0.12, color: [255, 200, 120],
      });
    }
    if (e.id === "final_origami" || e.phase >= 3) {
      for (let i = 0; i < 6 + e.phase * 2; i++) {
        const ang = (i / (6 + e.phase * 2)) * Math.PI * 2 + this.time;
        this.spawnBullet(e.x, e.y, Math.cos(ang), Math.sin(ang), {
          fromPlayer: false, damage: e.damage * 0.55, speed: 200 + e.phase * 30,
          color: e.accent || [255, 200, 140], r: 6, life: 2.2,
        });
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
        let hitSomeone = false;
        if (len(b.x - p.x, b.y - p.y) < p.r + b.r) {
          this.hurtPlayer(b.damage);
          this.bullets.release(b);
          hitSomeone = true;
        } else {
          for (const r of this.remotes.values()) {
            if (r.down) continue;
            if (len(b.x - r.x, b.y - r.y) < 14 + b.r) {
              this.hurtRemote(r, b.damage);
              this.bullets.release(b);
              hitSomeone = true;
              break;
            }
          }
        }
        if (hitSomeone) continue;
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
    const now = performance.now();
    // 按下/抬起开火必须立刻上报，否则短按会被 25ms 节流吃掉
    if (!this._inputForceSend && this._lastInputSentAt && now - this._lastInputSentAt < 25) return;
    this._inputForceSend = false;
    this._lastInputSentAt = now;
    this.session.sendInput({
      x: this.player.x, y: this.player.y,
      aimX: this.player.aimX, aimY: this.player.aimY,
      hp: this.player.hp,
      keys: {
        w: !!(this.keys.KeyW || this.keys.ArrowUp || (this.touch?.enabled && this.touch.moveY < -0.25)),
        s: !!(this.keys.KeyS || this.keys.ArrowDown || (this.touch?.enabled && this.touch.moveY > 0.25)),
        a: !!(this.keys.KeyA || this.keys.ArrowLeft || (this.touch?.enabled && this.touch.moveX < -0.25)),
        d: !!(this.keys.KeyD || this.keys.ArrowRight || (this.touch?.enabled && this.touch.moveX > 0.25)),
        fire: this.mouse.down,
        dash: this.mouse.right || this.keys.ShiftLeft || this.keys.ShiftRight || !!this.touch?.dashHeld,
        ult: !!this.keys.Space || !!this.touch?.ultHeld,
      },
      mx: this.mouse.x, my: this.mouse.y,
      moveX: this.touch?.enabled ? this.touch.moveX : 0,
      moveY: this.touch?.enabled ? this.touch.moveY : 0,
    });
  }

  /** 客机两帧快照之间：子弹按速度外推，避免整屏冻住 */
  _extrapolateClientWorld(dt) {
    for (const b of this.bullets.live) {
      b.x += (b.vx || 0) * dt;
      b.y += (b.vy || 0) * dt;
      b.life -= dt;
    }
    // 远端玩家若带速度则外推（applySnapshot 写入）
    for (const r of this.remotes.values()) {
      if (r.down) continue;
      if (r._vx || r._vy) {
        r.x += (r._vx || 0) * dt;
        r.y += (r._vy || 0) * dt;
      }
    }
  }

  onRemoteInput(fromId, input, name) {
    if (this.netRole !== "host") return;
    if (!fromId || fromId === this.session?.playerId) return;
    this.remoteInputs.set(fromId, { ...input, name: name || "折客", t: this.time });
    const r = this.ensureRemote(fromId, name);
    // 键控权威位移 + 适度贴合客机预测坐标，减少两边各走各的
    if (input.x != null && input.y != null) {
      const dx = input.x - r.x;
      const dy = input.y - r.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 280 * 280) {
        r.x = input.x;
        r.y = input.y;
      } else if (d2 > 12 * 12) {
        r.x = lerp(r.x, input.x, 0.4);
        r.y = lerp(r.y, input.y, 0.4);
      }
    }
    r.aimX = input.aimX ?? r.aimX;
    r.aimY = input.aimY ?? r.aimY;
    r.name = name || r.name;
    r.keys = input.keys || {};
    r._mx = input.mx; r._my = input.my;
    r._moveX = input.moveX || 0;
    r._moveY = input.moveY || 0;
  }

  updateRemotesFromInputs(dt) {
    for (const [id, r] of this.remotes) {
      if (r.down) continue;
      if (!r.combat) this._rebuildRemoteCombat(r);
      const st = r.combat;
      const moveSpd = (st.moveSpeed || 250) * 0.95;
      const fireRate = st.fireRate || 0.16;
      const dmg = st.damage || 15;
      const pierce = st.pierce || 1;
      const bulletSpd = st.bulletSpeed || 540;

      // 超时未收到输入则清意图，防断线/暂停粘火
      const inp = this.remoteInputs.get(id);
      if (!inp || this.time - (inp.t || 0) > 0.85) {
        r.keys = {};
      }

      if (r._fireCd > 0) r._fireCd -= dt;
      if (r._dashCd > 0) r._dashCd -= dt;
      if (r._ultCd > 0) r._ultCd -= dt;

      const k = r.keys || {};
      let mx = 0, my = 0;
      if (r._moveX || r._moveY) {
        mx = r._moveX || 0;
        my = r._moveY || 0;
      } else {
        if (k.w) my -= 1;
        if (k.s) my += 1;
        if (k.a) mx -= 1;
        if (k.d) mx += 1;
      }
      if (mx || my) {
        const [dx, dy] = norm(mx, my);
        r.x = clamp(r.x + dx * moveSpd * dt, 20, this.w - 20);
        r.y = clamp(r.y + dy * moveSpd * dt, 20, this.h - 20);
      }

      const [ax, ay] = norm((r._mx ?? r.x + r.aimX) - r.x, (r._my ?? r.y + r.aimY) - r.y);
      r.aimX = ax; r.aimY = ay;

      if (k.fire && (!r._fireCd || r._fireCd <= 0)) {
        r._fireCd = fireRate;
        const shots = 1 + (st.extraShots || 0);
        for (let i = 0; i < shots; i++) {
          const t = shots === 1 ? 0 : (i / (shots - 1) - 0.5) * 2;
          const ang = Math.atan2(ay, ax) + t * ((st.spread || 0.05) + 0.05);
          this.spawnBullet(r.x + Math.cos(ang) * 14, r.y + Math.sin(ang) * 14, Math.cos(ang), Math.sin(ang), {
            damage: dmg, speed: bulletSpd, pierce, color: [255, 210, 140],
          });
        }
      }
      if (k.dash && (!r._dashCd || r._dashCd <= 0)) {
        r._dashCd = st.dashCd || 0.75;
        r.x = clamp(r.x + ax * 90, 20, this.w - 20);
        r.y = clamp(r.y + ay * 90, 20, this.h - 20);
        this.spawnField(r.x, r.y, {
          r: 34, life: 0.3, kind: "crease",
          damage: dmg * 0.55, color: [160, 210, 220],
        });
        this.particles.burst(r.x, r.y, 10, { r: 160, g: 210, b: 220, spark: true, spdMin: 60, spdMax: 200 });
      }
      if (k.ult && (!r._ultCd || r._ultCd <= 0)) {
        r._ultCd = 4;
        const ultDmg = (st.ultDamage || 70) * 0.35;
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * Math.PI * 2;
          this.spawnBullet(r.x, r.y, Math.cos(ang), Math.sin(ang), {
            damage: ultDmg, speed: 380, life: 0.65, color: [140, 200, 230],
          });
        }
        this.particles.burst(r.x, r.y, 16, { r: 140, g: 200, b: 230, spark: true });
      }
    }
    this.playerCount = 1 + [...this.remotes.values()].filter((x) => !x.down).length;
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
      bullets.push([
        b.x|0, b.y|0, Math.round(b.vx), Math.round(b.vy), b.r|0,
        b.fromPlayer ? 1 : 0, b.color[0], b.color[1], b.color[2],
      ]);
    }
    const players = [{
      id: this.player.id, name: this.player.name,
      x: this.player.x|0, y: this.player.y|0,
      hp: this.player.hp|0, maxHp: this.player.stats.maxHp|0,
      aimX: +this.player.aimX.toFixed(2), aimY: +this.player.aimY.toFixed(2),
      seal: this.hostSeal|0,
      role: "host",
      folds: this.folds.slice(),
      relics: this.relics.slice(),
    }];
    for (const r of this.remotes.values()) {
      players.push({
        id: r.id, name: r.name, x: r.x|0, y: r.y|0,
        hp: r.hp|0, maxHp: r.maxHp|0, aimX: r.aimX, aimY: r.aimY,
        seal: r.seal|0, atkMul: r.atkMul, hpMul: r.hpMul, down: !!r.down,
        role: "client",
        folds: (r.folds || []).slice(),
        relics: (r.relics || []).slice(),
      });
    }
    // 粒子跟权威画面走；上限兼顾带宽（中继 48KB）
    const fxCap = Math.min(
      this.particles.max | 0 || 160,
      this.gfx?.id === "ultra" ? 320 : this.gfx?.id === "high" ? 220 : this.gfx?.id === "low" ? 80 : 160,
    );
    return {
      t: this.time, floor: this.floor, room: this.room, kills: this.kills,
      biome: this.biome.id, state: this.state,
      streak: this.killStreak,
      hostSeal: this.hostSeal,
      pickWaitT: this.pickGrace ? this.pickWaitT : 0,
      worldW: this.w|0,
      worldH: this.h|0,
      players, enemies, bullets,
      fx: this.particles.toSnapshot(fxCap),
    };
  }

  applySnapshot(snap) {
    if (!snap || this.netRole !== "client") return;
    this._lastSnapAt = performance.now();
    this._snapWarn = false;
    if (snap.worldW && snap.worldH) this.lockNetWorld(snap.worldW, snap.worldH);
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
    const prevRemotes = this.remotes;
    this.remotes = new Map();
    for (const pl of snap.players || []) {
      if (pl.id === this.session?.playerId) {
        if (this.player && pl.hp != null) {
          this.player.hp = pl.hp;
          if (pl.maxHp) this.player.stats.maxHp = pl.maxHp;
        }
        if (pl.seal) this.localSeal = pl.seal;
        // 主机权威同步自己的折纹（防不同步），选卡中不覆盖乐观选择
        if (pl.folds && this.state !== "pick") {
          const foldsSame = pl.folds.length === this.folds.length
            && pl.folds.every((id, i) => id === this.folds[i]);
          const nextRelics = pl.relics || this.relics;
          const relicsSame = nextRelics.length === this.relics.length
            && nextRelics.every((id, i) => id === this.relics[i]);
          if (!foldsSame || !relicsSame) {
            this.folds = pl.folds.slice();
            if (pl.relics) this.relics = pl.relics.slice();
            this.rebuildStats();
          }
        }
        // 与主机权威坐标和解：太远硬拉，近距软跟，避免「我在走但世界不理我」
        if (this.player && pl.x != null && pl.y != null) {
          const dx = pl.x - this.player.x;
          const dy = pl.y - this.player.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > 200 * 200) {
            this.player.x = pl.x;
            this.player.y = pl.y;
          } else if (d2 > 28 * 28) {
            this.player.x = lerp(this.player.x, pl.x, 0.45);
            this.player.y = lerp(this.player.y, pl.y, 0.45);
          }
        }
        continue;
      }
      const prev = prevRemotes.get(pl.id);
      let _vx = 0, _vy = 0;
      if (prev && snap.t != null && this._lastSnapT != null) {
        const dt = Math.max(0.016, (snap.t - this._lastSnapT) || 0.05);
        _vx = (pl.x - prev.x) / dt;
        _vy = (pl.y - prev.y) / dt;
      }
      this.remotes.set(pl.id, {
        ...pl,
        down: !!pl.down,
        folds: pl.folds || [],
        relics: pl.relics || ["first_crease"],
        _vx, _vy,
      });
    }
    this._lastSnapT = snap.t;
    if (snap.hostSeal) this.hostSeal = snap.hostSeal;
    // 主机权威粒子（缺省空数组时清掉，避免旧粒子残留）
    if (snap.fx) this.particles.applySnapshot(snap.fx);
    if (snap.state === "pick" && this.state === "playing") {
      this.hooks.toast?.("选择折纹中…");
    }
    this.hooks.onHud?.();
  }

  draw() {
    const ctx = this.ctx;
    const pal = this.biome.palette;
    const viewW = this.viewW || this.w;
    const viewH = this.viewH || this.h;
    const shakeAmt = this.shake * (this.shakeMul ?? 1);
    const sx = (Math.random() - 0.5) * shakeAmt;
    const sy = (Math.random() - 0.5) * shakeAmt;
    const scaleX = viewW / Math.max(1, this.w);
    const scaleY = viewH / Math.max(1, this.h);
    const needScale = this.netRole === "client" && this._netWorldLocked
      && (Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001);

    ctx.save();
    if (needScale) ctx.scale(scaleX, scaleY);
    ctx.translate(sx, sy);

    // background atmosphere（分辨率/生态变化时缓存渐变）
    const gfx = this.gfx || qualityPreset("med");
    if (gfx.softBg !== false) {
      const gradKey = `${this.w}|${this.h}|${pal.bg1}|${pal.bg2}`;
      if (!this._bgGrad || this._bgGradKey !== gradKey) {
        this._bgGradKey = gradKey;
        this._bgGrad = ctx.createRadialGradient(
          this.w * 0.3, this.h * 0.2, 0,
          this.w * 0.5, this.h * 0.5, Math.max(this.w, this.h) * 0.75,
        );
        this._bgGrad.addColorStop(0, pal.bg2);
        this._bgGrad.addColorStop(1, pal.bg1);
      }
      ctx.fillStyle = this._bgGrad;
    } else {
      ctx.fillStyle = pal.bg1;
    }
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
    if (gfx.vignette !== false) {
      ctx.fillStyle = pal.fog;
      ctx.fillRect(-20, -20, this.w + 40, this.h + 40);
      if (gfx.id === "ultra") {
        ctx.globalAlpha = 0.18;
        const edge = ctx.createRadialGradient(
          this.w * 0.5, this.h * 0.5, Math.min(this.w, this.h) * 0.28,
          this.w * 0.5, this.h * 0.5, Math.max(this.w, this.h) * 0.72,
        );
        edge.addColorStop(0, "rgba(0,0,0,0)");
        edge.addColorStop(1, "rgba(8,20,28,0.85)");
        ctx.fillStyle = edge;
        ctx.fillRect(-20, -20, this.w + 40, this.h + 40);
        ctx.globalAlpha = 1;
      }
    }

    ctx.restore();

    if (this.flashAlpha > 0) {
      ctx.fillStyle = `rgba(255, 220, 140, ${this.flashAlpha})`;
      ctx.fillRect(0, 0, viewW, viewH);
    }

    if (this.showFps) {
      ctx.fillStyle = "rgba(244,251,248,0.45)";
      ctx.font = "12px Noto Sans SC, sans-serif";
      ctx.textAlign = "right";
      const net = this.netRole === "solo" ? "单机" : this.netRole === "host" ? `主机×${this.playerCount}` : "客机";
      ctx.fillText(`${this.fps} FPS · ${net} · 粒子 ${this.particles.pool.count}`, viewW - 14, 22);
      try {
        this.canvas.dataset.fx = String(this.particles.pool.count);
        this.canvas.dataset.net = this.netRole;
      } catch { /* */ }
    }
    if (this.killStreak >= 5) {
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,210,122,0.95)";
      ctx.font = "600 22px Noto Sans SC, sans-serif";
      ctx.fillText(`${this.killStreak} 连折`, viewW * 0.5, 48);
      if (this.vacuumT > 0) {
        ctx.font = "12px Noto Sans SC, sans-serif";
        ctx.fillStyle = "rgba(244,251,248,0.7)";
        ctx.fillText("折光回涌 · 自动吸尘", viewW * 0.5, 68);
      }
    }
    if (this.clearFanfare > 0) {
      ctx.textAlign = "center";
      ctx.globalAlpha = Math.min(1, this.clearFanfare * 1.4);
      ctx.fillStyle = "#ffe1a0";
      ctx.font = "600 28px ZCOOL XiaoWei, Noto Sans SC, serif";
      ctx.fillText("纸页翻折", viewW * 0.5, viewH * 0.22);
      ctx.globalAlpha = 1;
    }
  }

  drawRemotes(ctx) {
    for (const r of this.remotes.values()) {
      if (r.x == null || r.y == null) continue;
      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.globalAlpha = r.down ? 0.35 : 0.95;
      // 主机用暖色菱形，和本机折纸区分开
      const isHost = r.role === "host";
      ctx.fillStyle = isHost ? "#ffe1a0" : "#9ad7ef";
      ctx.strokeStyle = isHost ? "#e89a2d" : "#2f8fbb";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -14); ctx.lineTo(12, 2); ctx.lineTo(0, 14); ctx.lineTo(-12, 2);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#f4fbf8";
      ctx.font = "11px Noto Sans SC, sans-serif";
      ctx.textAlign = "center";
      const tag = isHost ? " · 主机" : "";
      const seal = r.seal != null ? ` · 折印${r.seal}` : "";
      ctx.fillText(`${r.name || "折客"}${tag}${seal}`, 0, -20);
      if (r.atkMul != null && r.atkMul < 0.98) {
        ctx.fillStyle = "rgba(255,180,120,0.85)";
        ctx.font = "10px Noto Sans SC, sans-serif";
        ctx.fillText(`攻×${r.atkMul.toFixed(2)}`, 0, 24);
      } else if (r.hpMul != null && r.hpMul > 1.02) {
        ctx.fillStyle = "rgba(140,220,180,0.9)";
        ctx.font = "10px Noto Sans SC, sans-serif";
        ctx.fillText(`韧×${r.hpMul.toFixed(2)}`, 0, 24);
      }
      ctx.restore();
    }
  }

  drawCreaseGrid(ctx, pal) {
    const gfx = this.gfx || qualityPreset("med");
    const shards = this.bgShards ?? 0;
    if (gfx.creaseGrid === false && shards <= 0) return;

    ctx.save();
    if (gfx.creaseGrid !== false) {
      ctx.globalAlpha = gfx.id === "ultra" ? 0.18 : gfx.id === "high" ? 0.16 : 0.14;
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 1;
      const step = gfx.creaseStep || 96;
      const off = (this.time * 8) % step;
      ctx.beginPath();
      for (let x = -step + off; x < this.w + step; x += step) {
        ctx.moveTo(x, 0); ctx.lineTo(x + this.h * 0.15, this.h);
      }
      for (let y = -step + off * 0.5; y < this.h + step; y += step) {
        ctx.moveTo(0, y); ctx.lineTo(this.w, y + this.w * 0.08);
      }
      ctx.stroke();
    }

    // floating paper shards (decorative)
    if (shards > 0) {
      ctx.globalAlpha = gfx.id === "ultra" ? 0.14 : 0.1;
      ctx.fillStyle = "#f4fbf8";
      for (let i = 0; i < shards; i++) {
        const x = ((i * 137 + this.bgSeed * 13 + this.time * (8 + i)) % (this.w + 80)) - 40;
        const y = (Math.sin(this.time * 0.4 + i) * 0.5 + 0.5) * this.h;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(this.time * 0.2 + i);
        ctx.fillRect(-10, -6, 20, 12);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  drawPlayer(ctx) {
    const p = this.player;
    const gfx = this.gfx || qualityPreset("med");
    const pulse = 1 + Math.sin(this.time * 6) * 0.03;
    ctx.save();
    ctx.translate(p.x, p.y);
    if (gfx.entityGlow !== false) {
      if (gfx.playerAura) {
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = "#ffe1a0";
        ctx.beginPath();
        ctx.arc(0, 0, 38 * pulse, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = "#ffe1a0";
      ctx.beginPath();
      ctx.arc(0, 0, 26 * pulse, 0, Math.PI * 2);
      ctx.fill();
    }
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
    if (gfx.enemyDetail !== false) {
      ctx.beginPath();
      ctx.moveTo(0, -14); ctx.lineTo(0, 14);
      ctx.strokeStyle = "rgba(12,47,58,0.25)";
      ctx.stroke();
    }

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
    const gfx = this.gfx || qualityPreset("med");
    const glow = gfx.entityGlow !== false;
    const detail = gfx.enemyDetail !== false;
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

      if (glow) {
        ctx.globalAlpha = e.hidden ? 0.12 : (gfx.id === "ultra" ? 0.34 : 0.28);
        ctx.beginPath();
        ctx.arc(0, 0, e.r + (gfx.id === "ultra" ? 8 : 5), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.55)`;
        ctx.fill();
        ctx.globalAlpha = e.hidden ? 0.22 : 1;
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      }

      const shape = e.shape || (e.boss ? "boss" : e.ranged ? "drone" : "mite");
      this._drawEnemyShape(ctx, shape, e);

      if (detail) {
        ctx.fillStyle = `rgba(${a[0]},${a[1]},${a[2]},0.85)`;
        ctx.beginPath();
        ctx.arc(-e.r * 0.25, -e.r * 0.3, Math.max(2, e.r * 0.18), 0, Math.PI * 2);
        ctx.fill();
      }

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
    const detail = (this.gfx || qualityPreset("med")).enemyDetail !== false;
    ctx.beginPath();
    switch (shape) {
      case "drone":
      case "sentry":
        ctx.moveTo(0, -r);
        ctx.lineTo(r * 0.95, r * 0.7);
        ctx.lineTo(-r * 0.95, r * 0.7);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        if (detail) {
          ctx.beginPath();
          ctx.moveTo(0, -r);
          ctx.lineTo(0, -r - 6);
          ctx.stroke();
        }
        break;
      case "brute":
        ctx.rotate(0.2);
        ctx.rect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7);
        ctx.fill(); ctx.stroke();
        if (detail) {
          ctx.beginPath();
          ctx.moveTo(-r * 0.4, 0); ctx.lineTo(r * 0.4, 0);
          ctx.stroke();
        }
        break;
      case "wisp":
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        if (detail) {
          ctx.beginPath();
          ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      case "lurker":
        ctx.moveTo(-r, 0);
        ctx.quadraticCurveTo(0, -r * 1.2, r, 0);
        ctx.quadraticCurveTo(0, r * 0.7, -r, 0);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        break;
      case "hydra":
        for (let i = 0; i < (detail ? 3 : 1); i++) {
          const ang = -Math.PI / 2 + (i - 1) * 0.55;
          ctx.beginPath();
          if (detail) {
            ctx.ellipse(Math.cos(ang) * r * 0.35, Math.sin(ang) * r * 0.35, r * 0.55, r * 0.35, ang, 0, Math.PI * 2);
          } else {
            ctx.arc(0, 0, r, 0, Math.PI * 2);
          }
          ctx.fill(); ctx.stroke();
        }
        break;
      case "moth":
        if (detail) {
          ctx.ellipse(-r * 0.55, 0, r * 0.55, r * 0.35, -0.4, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
          ctx.beginPath();
          ctx.ellipse(r * 0.55, 0, r * 0.55, r * 0.35, 0.4, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
          ctx.beginPath();
          ctx.arc(0, 0, r * 0.28, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.arc(0, 0, r, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
        }
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
        for (let i = 0; i < (detail ? 5 : 4); i++) {
          const ang = (i / (detail ? 5 : 4)) * Math.PI * 2 + this.time;
          const rr = detail && (i % 2) ? r * 0.55 : r;
          const x = Math.cos(ang) * rr, y = Math.sin(ang) * rr;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        break;
      case "boss":
        for (let i = 0; i < (detail ? 6 : 4); i++) {
          const n = detail ? 6 : 4;
          const ang = (i / n) * Math.PI * 2 + this.time * 0.4;
          const rr = detail && (i % 2) ? e.r * 0.75 : e.r;
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
        if (detail) {
          ctx.fillStyle = ctx.strokeStyle;
          for (const s of [-1, 1]) {
            ctx.beginPath();
            ctx.arc(s * r * 0.7, r * 0.15, 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
    }
  }

  drawBullets(ctx) {
    const trails = this.drawTrails !== false;
    for (const b of this.bullets.live) {
      ctx.fillStyle = `rgb(${b.color[0]},${b.color[1]},${b.color[2]})`;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      if (!trails) continue;
      ctx.strokeStyle = `rgba(${b.color[0]},${b.color[1]},${b.color[2]},0.5)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - b.vx * 0.02, b.y - b.vy * 0.02);
      ctx.stroke();
    }
  }

  drawFields(ctx) {
    const detail = (this.gfx || qualityPreset("med")).fieldDetail !== false;
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
      if (detail) {
        const ticks = (this.gfx?.id === "ultra") ? 8 : 6;
        for (let i = 0; i < ticks; i++) {
          const ang = (i / ticks) * Math.PI * 2 + this.time * 2;
          ctx.beginPath();
          ctx.moveTo(f.x + Math.cos(ang) * (f.r - 4), f.y + Math.sin(ang) * (f.r - 4));
          ctx.lineTo(f.x + Math.cos(ang) * (f.r + 4), f.y + Math.sin(ang) * (f.r + 4));
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  drawCreaseTrails(ctx) {
    const ultra = this.gfx?.id === "ultra";
    for (const c of this.creaseTrails) {
      ctx.globalAlpha = clamp(c.life * 2, 0, ultra ? 0.65 : 0.5);
      ctx.strokeStyle = ultra ? "#e8f6ef" : "#d8ebe4";
      ctx.lineWidth = ultra ? 4.5 : 3;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r * (1.2 - c.life), 0, Math.PI * 2);
      ctx.stroke();
      if (ultra) {
        ctx.globalAlpha = clamp(c.life * 1.2, 0, 0.28);
        ctx.lineWidth = 8;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  drawPickups(ctx) {
    const glow = (this.gfx || qualityPreset("med")).pickupGlow;
    for (const u of this.pickups.live) {
      const bob = Math.sin(this.time * 5 + u.x) * 3;
      ctx.save();
      ctx.translate(u.x, u.y + bob);
      if (glow) {
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = u.kind === "dust" ? "#e89a2d" : "#3ecf9a";
        ctx.beginPath();
        ctx.arc(0, 0, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
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
