import {
  FOLDS, ENEMIES, BIOMES, SYNERGIES, META_UNLOCKS, RARITY, RELICS, BOSSES, isUnlocked,
} from "./content.js";
import { writeSave, unlock, grantDust } from "./save.js";
import { LanSession, WanSession, defaultLanUrl } from "./net/session.js";
import { NET } from "./net/protocol.js";

const KNOWN_UNLOCKS = new Set(META_UNLOCKS.map((u) => u.id));

export class UI {
  constructor({ save, audio, onStart, onCoopStart, getGame }) {
    this.save = save;
    this.audio = audio;
    this.onStart = onStart;
    this.onCoopStart = onCoopStart;
    this.getGame = getGame;
    this.atlasTab = "folds";
    this.session = null;

    this.els = {
      hud: document.getElementById("hud"),
      hp: document.getElementById("hp-fill"),
      mp: document.getElementById("mp-fill"),
      floor: document.getElementById("floor-label"),
      biome: document.getElementById("biome-label"),
      kills: document.getElementById("kill-label"),
      streak: document.getElementById("streak-label"),
      folds: document.getElementById("fold-slots"),
      relics: document.getElementById("relic-strip"),
      menu: document.getElementById("screen-menu"),
      pick: document.getElementById("screen-pick"),
      pickCards: document.getElementById("pick-cards"),
      pause: document.getElementById("screen-pause"),
      result: document.getElementById("screen-result"),
      resultTitle: document.getElementById("result-title"),
      resultSub: document.getElementById("result-sub"),
      resultRewards: document.getElementById("result-rewards"),
      atlas: document.getElementById("screen-atlas"),
      atlasGrid: document.getElementById("atlas-grid"),
      meta: document.getElementById("screen-meta"),
      metaGrid: document.getElementById("meta-grid"),
      metaDust: document.getElementById("meta-dust"),
      menuStats: document.getElementById("menu-stats"),
      toast: document.getElementById("toast"),
      coop: document.getElementById("screen-coop"),
      coopStatus: document.getElementById("coop-status"),
      coopPeers: document.getElementById("coop-peers"),
      coopUrl: document.getElementById("coop-url"),
      coopName: document.getElementById("coop-name"),
      coopCode: document.getElementById("coop-code"),
      coopStart: document.getElementById("btn-coop-start"),
    };

    this.els.coopUrl.value = defaultLanUrl();

    document.getElementById("btn-start").onclick = () => {
      this.audio.ui();
      this.hideAll();
      this.els.hud.classList.remove("hidden");
      this.onStart({ session: null, forceTutorial: false });
    };
    document.getElementById("btn-tutorial").onclick = () => {
      this.audio.ui();
      this.hideAll();
      this.els.hud.classList.remove("hidden");
      this.onStart({ session: null, forceTutorial: true });
    };
    document.getElementById("btn-coop").onclick = () => { this.audio.ui(); this.openCoop(); };
    document.getElementById("btn-atlas").onclick = () => { this.audio.ui(); this.openAtlas(); };
    document.getElementById("btn-meta").onclick = () => { this.audio.ui(); this.openMeta(); };
    document.getElementById("btn-atlas-back").onclick = () => { this.audio.ui(); this.showMenu(); };
    document.getElementById("btn-meta-back").onclick = () => { this.audio.ui(); this.showMenu(); };
    document.getElementById("btn-coop-back").onclick = () => {
      this.audio.ui();
      this.session?.close?.();
      this.session = null;
      this.showMenu();
    };
    document.getElementById("btn-resume").onclick = () => { this.audio.ui(); this.resume(); };
    document.getElementById("btn-quit").onclick = () => { this.audio.ui(); this.quitToMenu(); };
    document.getElementById("btn-result-ok").onclick = async () => {
      this.audio.ui();
      await writeSave(this.save);
      this.showMenu();
    };

    document.getElementById("btn-host").onclick = () => this.hostRoom();
    document.getElementById("btn-join").onclick = () => this.joinRoom();
    document.getElementById("btn-coop-start").onclick = () => this.beginCoopRun();
    document.getElementById("btn-wan-stub").onclick = () => this.tryWan();

    this.els.atlas.querySelectorAll(".tab").forEach((tab) => {
      tab.onclick = () => {
        this.audio.ui();
        this.atlasTab = tab.dataset.tab;
        this.els.atlas.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
        this.renderAtlas();
      };
    });

    this.game = null;
    this.refreshMenuStats();
  }

  setGame(game) { this.game = game; }

  hideAll() {
    for (const key of ["menu", "pick", "pause", "result", "atlas", "meta", "coop"]) {
      this.els[key].classList.add("hidden");
    }
  }

  showMenu() {
    this.hideAll();
    this.els.hud.classList.add("hidden");
    this.els.menu.classList.remove("hidden");
    this.refreshMenuStats();
    const g = this.getGame?.() || this.game;
    if (g) g.state = "idle";
  }

  refreshMenuStats() {
    const s = this.save;
    const unlocked = Object.keys(s.unlocked).length;
    this.els.menuStats.innerHTML = `
      <span class="stat-chip">折光尘 ${s.dust}</span>
      <span class="stat-chip">最佳层数 ${s.bestFloor}</span>
      <span class="stat-chip">累计击破 ${s.totalKills}</span>
      <span class="stat-chip">已解锁 ${unlocked}</span>
      <span class="stat-chip">局数 ${s.totalRuns}</span>
    `;
  }

  updateHud(game) {
    const p = game.player;
    if (!p) return;
    this.els.hp.style.transform = `scaleX(${Math.max(0, p.hp / p.stats.maxHp)})`;
    this.els.mp.style.transform = `scaleX(${Math.max(0, p.mp / p.stats.maxMp)})`;
    this.els.floor.textContent = `第 ${game.floor} / ${game.maxFloors} 层`;
    this.els.biome.textContent = game.biome.name;
    this.els.kills.textContent = `击破 ${game.kills}`;
    if (this.els.streak) {
      if (game.killStreak >= 5) {
        this.els.streak.classList.remove("hidden");
        this.els.streak.textContent = `连折 ${game.killStreak}`;
      } else {
        this.els.streak.classList.add("hidden");
      }
    }

    const counts = Object.create(null);
    for (const id of game.folds) counts[id] = (counts[id] || 0) + 1;
    this.els.folds.innerHTML = Object.entries(counts)
      .map(([id, n]) => `<div class="fold-chip">${FOLDS[id]?.name || id}${n > 1 ? ` ×${n}` : ""}</div>`)
      .join("");

    this.els.relics.innerHTML = game.relics
      .map((id) => `<div class="relic-chip">${RELICS[id]?.name || id}</div>`)
      .join("");
  }

  openPick(cards) {
    const g = this.game;
    if (g?.netRole === "client") {
      this.toast("等待主机选择折纹…");
      return;
    }
    this.els.pick.classList.remove("hidden");
    this.els.pickCards.innerHTML = cards.map((c) => `
      <button class="pick-card ${c.rarity}" data-id="${c.id}">
        <div class="rarity">${RARITY[c.rarity].name}</div>
        <h3>${c.name}</h3>
        <p>${c.desc}</p>
      </button>
    `).join("");
    this.els.pickCards.querySelectorAll(".pick-card").forEach((btn) => {
      btn.onclick = () => {
        this.audio.ui();
        this.game.choosePick(btn.dataset.id);
      };
    });
  }

  closePick() {
    this.els.pick.classList.add("hidden");
  }

  openPause() {
    if (!this.game || this.game.state !== "playing") return;
    this.game.state = "pause";
    this.els.pause.classList.remove("hidden");
  }

  resume() {
    this.els.pause.classList.add("hidden");
    if (this.game) this.game.state = "playing";
  }

  quitToMenu() {
    this.session?.close?.();
    this.showMenu();
  }

  async showResult(data) {
    this.els.result.classList.remove("hidden");
    this.els.resultTitle.textContent = data.won ? "织界成形" : "纸页溃散";
    this.els.resultSub.textContent = data.won
      ? `你折完了整本织界。第 ${data.floor} 层 · 击破 ${data.kills}`
      : `止步第 ${data.floor} 层 · 击破 ${data.kills}。溃散也是新的折痕。`;

    const granted = await grantDust(this.save, data.dust, data.won ? "clear" : "fail");
    this.els.resultRewards.innerHTML = `
      <div class="reward-item">局内折光尘 +${data.runDust}</div>
      <div class="reward-item">${data.won ? "通关奖励" : "残骸回收"} +${data.bonus}</div>
      <div class="reward-item">安全入账 +${granted} · 当前持有 ${this.save.dust}</div>
    `;
    if (data.won) this.audio.win();
    this.refreshMenuStats();
  }

  openAtlas() {
    this.hideAll();
    this.els.atlas.classList.remove("hidden");
    this.renderAtlas();
  }

  renderAtlas() {
    const s = this.save;
    let html = "";
    if (this.atlasTab === "folds") {
      html = Object.values(FOLDS).map((f) => {
        const seen = s.seen.folds[f.id];
        const unlocked = isUnlocked(s, f);
        return `<div class="atlas-card ${seen ? "" : "locked"}">
          <h4>${seen ? f.name : "？？？"}</h4>
          <p>${!unlocked ? "工坊未解锁" : seen ? f.desc : "尚未在局中遇见"}</p>
        </div>`;
      }).join("");
    } else if (this.atlasTab === "enemies") {
      const all = { ...ENEMIES, ...BOSSES };
      html = Object.values(all).map((e) => {
        const seen = s.seen.enemies[e.id] || s.seen.bosses?.[e.id];
        const unlocked = isUnlocked(s, e);
        return `<div class="atlas-card ${seen ? "" : "locked"}">
          <h4>${seen ? e.name : "？？？"}</h4>
          <p>${!unlocked ? "尚未编入轮转" : seen ? e.desc : "尚未交手"}</p>
        </div>`;
      }).join("");
    } else if (this.atlasTab === "biomes") {
      html = Object.values(BIOMES).map((b) => {
        const seen = s.seen.biomes[b.id];
        const unlocked = isUnlocked(s, b);
        return `<div class="atlas-card ${seen ? "" : "locked"}">
          <h4>${seen || unlocked ? b.name : "？？？"}</h4>
          <p>${!unlocked ? "工坊未解锁" : seen ? b.desc : "尚未踏入"}</p>
        </div>`;
      }).join("");
    } else {
      html = SYNERGIES.map((syn) => {
        const seen = s.seen.synergies[syn.id] || s.discoveredSynergies[syn.id];
        const unlocked = isUnlocked(s, syn);
        return `<div class="atlas-card ${seen ? "" : "locked"}">
          <h4>${seen ? syn.name : "未觉醒共鸣"}</h4>
          <p>${!unlocked ? "配方未发现" : seen ? `${syn.desc}<br/>需要：${syn.need.map((id) => FOLDS[id].name).join(" + ")}` : "凑齐折纹后觉醒"}</p>
        </div>`;
      }).join("");
    }
    this.els.atlasGrid.innerHTML = html;
  }

  openMeta() {
    this.hideAll();
    this.els.meta.classList.remove("hidden");
    this.renderMeta();
  }

  renderMeta() {
    this.els.metaDust.textContent = `折光尘：${this.save.dust}`;
    this.els.metaGrid.innerHTML = META_UNLOCKS.map((u) => {
      const owned = !!this.save.unlocked[u.id];
      const can = !owned && this.save.dust >= u.cost;
      return `<div class="meta-card">
        <h4>${u.name}</h4>
        <p>${u.desc}</p>
        <div class="cost">${owned ? "已织入" : `消耗 ${u.cost} 折光尘`}</div>
        <button class="btn ${owned ? "" : "primary"}" style="margin-top:10px" data-id="${u.id}" ${owned || !can ? "disabled" : ""}>
          ${owned ? "完成" : can ? "解锁" : "尘不足"}
        </button>
      </div>`;
    }).join("");

    this.els.metaGrid.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        const u = META_UNLOCKS.find((x) => x.id === id);
        if (!u || this.save.unlocked[id] || this.save.dust < u.cost) return;
        this.save.dust -= u.cost;
        const ok = await unlock(this.save, id, KNOWN_UNLOCKS);
        if (!ok) {
          this.save.dust += u.cost;
          this.toast("解锁被拒绝（安全校验）");
          return;
        }
        this.audio.pickup();
        this.toast(`解锁：${u.name}`);
        this.renderMeta();
        this.refreshMenuStats();
      };
    });
  }

  openCoop() {
    this.hideAll();
    this.els.coop.classList.remove("hidden");
    this.els.coopStatus.textContent = "未连接。先在一台电脑运行：npm i && npm run lan";
    this.els.coopPeers.innerHTML = "";
    this.els.coopStart.disabled = true;
  }

  async _makeLan() {
    const url = this.els.coopUrl.value.trim() || defaultLanUrl();
    const name = this.els.coopName.value.trim() || "折客";
    this.session?.close?.();
    this.session = new LanSession({ url, name });
    this._bindSession(this.session);
    return this.session;
  }

  _bindSession(session) {
    session.on(NET.JOINED, (msg) => {
      this.els.coopStatus.textContent = `已加入房间 ${msg.roomCode} · 你是${msg.role === "host" ? "主机（权威）" : "客机"}`;
      this.els.coopCode.value = msg.roomCode;
      this.renderPeers(msg.peers);
      this.els.coopStart.disabled = msg.role !== "host";
      if (msg.role !== "host") this.els.coopStart.textContent = "等待主机开始…";
      else this.els.coopStart.textContent = "全员就绪 · 开始";
    });
    session.on(NET.PEER_JOIN, (msg) => this.renderPeers(msg.peers));
    session.on(NET.PEER_LEFT, (msg) => this.renderPeers(msg.peers));
    session.on(NET.ROOM, (msg) => this.renderPeers(msg.peers));
    session.on(NET.ERROR, (msg) => {
      this.toast(msg.message || "联机错误");
      this.els.coopStatus.textContent = msg.message || "联机错误";
    });
    session.on(NET.START, () => {
      this.hideAll();
      this.els.hud.classList.remove("hidden");
      this.onCoopStart(session);
    });
    session.on(NET.SNAPSHOT, (msg) => {
      this.game?.applySnapshot?.(msg.snap);
    });
    session.on(NET.INPUT, (msg) => {
      if (msg.from) this.game?.onRemoteInput?.(msg.from, msg.input, msg.name);
    });
    session.on(NET.CHOOSE, (msg) => {
      if (session.role === "client" && msg.foldId && this.game) {
        if (!this.game.folds.includes(msg.foldId)) {
          this.game.addFold(msg.foldId);
        }
        this.toast(`主机选择：${FOLDS[msg.foldId]?.name || msg.foldId}`);
      }
    });
    session.on(NET.PICK, () => {
      if (session.role === "client") this.toast("等待主机选择折纹…");
    });
  }

  renderPeers(peers = []) {
    this.els.coopPeers.innerHTML = peers.map((p) =>
      `<span class="peer-chip">${p.name}${p.role === "host" ? " · 主机" : ""}</span>`).join("");
  }

  async hostRoom() {
    try {
      this.els.coopStatus.textContent = "正在创建房间…";
      const s = await this._makeLan();
      const { code } = await s.createRoom();
      this.toast(`房间 ${code} 已创建`);
    } catch (e) {
      this.els.coopStatus.textContent = e.message;
      this.toast(e.message);
    }
  }

  async joinRoom() {
    try {
      const code = this.els.coopCode.value.trim();
      if (!code) return this.toast("请填写房间码");
      this.els.coopStatus.textContent = "正在加入…";
      const s = await this._makeLan();
      await s.joinRoom(code);
      this.toast(`已加入 ${code}`);
    } catch (e) {
      this.els.coopStatus.textContent = e.message;
      this.toast(e.message);
    }
  }

  beginCoopRun() {
    if (!this.session || this.session.role !== "host") return;
    this.audio.ui();
    this.session.startGame(Math.random());
    this.hideAll();
    this.els.hud.classList.remove("hidden");
    this.onCoopStart(this.session);
  }

  async tryWan() {
    this.audio.ui();
    try {
      const wan = new WanSession({ url: "wss://example.invalid/wan", name: this.els.coopName.value || "折客" });
      await wan.connect();
    } catch (e) {
      this.toast(e.message || "外网联机尚未开放");
    }
  }

  toast(msg) {
    const el = this.els.toast;
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
  }
}
