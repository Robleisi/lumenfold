import {
  FOLDS, ENEMIES, BIOMES, SYNERGIES, META_UNLOCKS, RARITY, RELICS, BOSSES, isUnlocked,
  META_KIND_LABEL, META_STARTER_IDS, META_IMPACT_LABEL,
} from "./content.js";
import { writeSave, grantDust, purchaseUnlock } from "./save.js";
import { LanSession, WanSession, defaultLanUrl, resolveWanUrl, saveWanUrl } from "./net/session.js";
import { NET, buildPeerMeta, computeFoldSeal, sealBalance } from "./net/protocol.js";

const KNOWN_UNLOCKS = new Set(META_UNLOCKS.map((u) => u.id));

export class UI {
  constructor({ save, audio, onStart, onCoopStart, getGame, settings, onSettingsChange }) {
    this.save = save;
    this.audio = audio;
    this.onStart = onStart;
    this.onCoopStart = onCoopStart;
    this.getGame = getGame;
    this.settings = settings;
    this.onSettingsChange = onSettingsChange;
    this.atlasTab = "folds";
    this.metaTab = "recommend";
    this.session = null;
    this.settingsFrom = "menu";

    this.els = {
      hud: document.getElementById("hud"),
      hp: document.getElementById("hp-fill"),
      mp: document.getElementById("mp-fill"),
      floor: document.getElementById("floor-label"),
      room: document.getElementById("room-label"),
      biome: document.getElementById("biome-label"),
      kills: document.getElementById("kill-label"),
      streak: document.getElementById("streak-label"),
      pickWait: document.getElementById("pick-wait-label"),
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
      metaTabs: document.getElementById("meta-tabs"),
      metaTip: document.getElementById("meta-tip"),
      menuStats: document.getElementById("menu-stats"),
      toast: document.getElementById("toast"),
      coop: document.getElementById("screen-coop"),
      coopStatus: document.getElementById("coop-status"),
      coopShare: document.getElementById("coop-share"),
      coopShareText: document.getElementById("coop-share-text"),
      coopPeers: document.getElementById("coop-peers"),
      coopUrl: document.getElementById("coop-url"),
      coopName: document.getElementById("coop-name"),
      coopCode: document.getElementById("coop-code"),
      coopStart: document.getElementById("btn-coop-start"),
      coopChatLog: document.getElementById("coop-chat-log"),
      coopChatInput: document.getElementById("coop-chat-input"),
      settings: document.getElementById("screen-settings"),
    };

    this.els.coopUrl.value = defaultLanUrl();
    this.coopMode = "lan"; // lan | wan
    this._sharePayload = "";
    this._shareUrl = "";

    document.getElementById("btn-start").onclick = () => {
      this.audio.ui();
      this.audio.startBgm?.("battle");
      this.hideAll();
      this.els.hud.classList.remove("hidden");
      this.onStart({ session: null, forceTutorial: false });
      this.getGame?.()?.setTouchHud?.(true);
    };
    document.getElementById("btn-tutorial").onclick = () => {
      this.audio.ui();
      this.audio.startBgm?.("battle");
      this.hideAll();
      this.els.hud.classList.remove("hidden");
      this.onStart({ session: null, forceTutorial: true });
      this.getGame?.()?.setTouchHud?.(true);
    };
    document.getElementById("btn-coop").onclick = () => { this.audio.ui(); this.openCoop("lan"); };
    document.getElementById("btn-wan").onclick = () => { this.audio.ui(); this.openCoop("wan"); };
    document.getElementById("btn-atlas").onclick = () => { this.audio.ui(); this.openAtlas(); };
    document.getElementById("btn-meta").onclick = () => { this.audio.ui(); this.openMeta(); };
    document.getElementById("btn-settings").onclick = () => { this.audio.ui(); this.openSettings("menu"); };
    document.getElementById("btn-pause-settings").onclick = () => { this.audio.ui(); this.openSettings("pause"); };
    document.getElementById("btn-settings-back").onclick = () => {
      this.audio.ui();
      this.commitSettings();
      if (this.settingsFrom === "pause") {
        this.hideAll();
        this.els.pause.classList.remove("hidden");
      } else {
        this.showMenu();
      }
    };
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
      // 联机局结束后断开，避免房间挂着、迟到者卡在「等待主机」
      if (this.session && this.session.mode !== "local") {
        this.session.close?.();
        this.session = null;
      }
      this.showMenu();
    };

    document.getElementById("btn-host").onclick = () => this.hostRoom();
    document.getElementById("btn-join").onclick = () => this.joinRoom();
    document.getElementById("btn-coop-start").onclick = () => this.beginCoopRun();
    document.getElementById("btn-coop-copy").onclick = () => this.copyShareInfo();
    document.getElementById("btn-coop-chat")?.addEventListener("click", () => this.sendCoopChat());
    this.els.coopChatInput?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.sendCoopChat();
      }
    });
    document.getElementById("coop-url").onchange = () => {
      if (this.coopMode === "wan") saveWanUrl(this.els.coopUrl.value.trim());
    };

    this._bindSettingsControls();

    this.els.atlas.querySelectorAll(".tab").forEach((tab) => {
      tab.onclick = () => {
        this.audio.ui();
        this.atlasTab = tab.dataset.tab;
        this.els.atlas.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
        this.renderAtlas();
      };
    });

    this.els.metaTabs?.querySelectorAll(".tab").forEach((tab) => {
      tab.onclick = () => {
        this.audio.ui();
        this.metaTab = tab.dataset.tab;
        this.els.metaTabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
        this.renderMeta();
      };
    });

    this.game = null;
    this.refreshMenuStats();
  }

  _bindSettingsControls() {
    const syncVal = (id, em) => {
      const el = document.getElementById(id);
      const lab = document.getElementById(em);
      if (el && lab) lab.textContent = el.value;
    };
    document.getElementById("set-master").oninput = () => {
      syncVal("set-master", "set-master-val");
      this.commitSettings(false);
    };
    document.getElementById("set-sfx").oninput = () => {
      syncVal("set-sfx", "set-sfx-val");
      this.commitSettings(false);
    };
    document.getElementById("set-bgm").oninput = () => {
      syncVal("set-bgm", "set-bgm-val");
      this.commitSettings(false);
    };
    for (const id of ["set-lang", "set-mute", "set-quality", "set-fps", "set-show-fps", "set-shake", "set-flash", "set-challenge"]) {
      const el = document.getElementById(id);
      if (el) el.onchange = () => this.commitSettings(true);
    }
  }

  fillSettingsForm() {
    const s = this.settings;
    document.getElementById("set-lang").value = s.lang || "zh";
    document.getElementById("set-master").value = s.masterVol ?? 70;
    document.getElementById("set-master-val").textContent = String(s.masterVol ?? 70);
    document.getElementById("set-sfx").value = s.sfxVol ?? 100;
    document.getElementById("set-sfx-val").textContent = String(s.sfxVol ?? 100);
    document.getElementById("set-bgm").value = s.bgmVol ?? 55;
    document.getElementById("set-bgm-val").textContent = String(s.bgmVol ?? 55);
    document.getElementById("set-mute").checked = !!s.muted;
    document.getElementById("set-quality").value = s.quality || "med";
    document.getElementById("set-fps").value = String(s.fpsCap ?? 0);
    document.getElementById("set-show-fps").checked = s.showFps !== false;
    document.getElementById("set-shake").checked = s.screenShake !== false;
    document.getElementById("set-flash").checked = !!s.reduceFlash;
    const ch = document.getElementById("set-challenge");
    if (ch) ch.checked = s.challengePool !== false;
  }

  readSettingsForm() {
    return {
      ...this.settings,
      lang: document.getElementById("set-lang").value,
      masterVol: Number(document.getElementById("set-master").value),
      sfxVol: Number(document.getElementById("set-sfx").value),
      bgmVol: Number(document.getElementById("set-bgm").value),
      muted: document.getElementById("set-mute").checked,
      quality: document.getElementById("set-quality").value,
      fpsCap: Number(document.getElementById("set-fps").value),
      showFps: document.getElementById("set-show-fps").checked,
      screenShake: document.getElementById("set-shake").checked,
      reduceFlash: document.getElementById("set-flash").checked,
      challengePool: document.getElementById("set-challenge")?.checked !== false,
    };
  }

  commitSettings(toast = false) {
    Object.assign(this.settings, this.readSettingsForm());
    this.onSettingsChange?.(this.settings, toast);
  }

  openSettings(from = "menu") {
    this.settingsFrom = from;
    this.hideAll();
    this.fillSettingsForm();
    this.els.settings.classList.remove("hidden");
  }

  setGame(game) { this.game = game; }

  hideAll() {
    for (const key of ["menu", "pick", "pause", "result", "atlas", "meta", "coop", "settings"]) {
      this.els[key].classList.add("hidden");
    }
  }

  showMenu() {
    this.hideAll();
    this.els.hud.classList.add("hidden");
    this.els.menu.classList.remove("hidden");
    this.refreshMenuStats();
    this.clearShareInfo();
    this.audio?.startBgm?.("menu");
    const g = this.getGame?.() || this.game;
    if (g) {
      g.state = "idle";
      g.setTouchHud?.(false);
      g.setTouchBlocked?.(true);
      g.touch?.resetAxes?.();
    }
  }

  refreshMenuStats() {
    const s = this.save;
    const unlocked = Object.keys(s.unlocked).length;
    const seal = computeFoldSeal(s);
    this.els.menuStats.innerHTML = `
      <span class="stat-chip">折印 ${seal}</span>
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
    if (this.els.room) {
      const kindMap = {
        combat: "战斗",
        rest: "休憩",
        event: "事件",
        elite: "精英",
        boss: "守门",
      };
      const kind = kindMap[game.roomKind] || "战斗";
      if (game.room > game.roomsPerFloor) {
        this.els.room.textContent = `守门 · ${kind}`;
      } else {
        const n = Math.max(1, game.room | 0);
        this.els.room.textContent = `房 ${n}/${game.roomsPerFloor} · ${kind}`;
      }
    }
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
    if (this.els.pickWait) {
      const tip = game.pickStatusSummary?.() || "";
      if (tip) {
        this.els.pickWait.classList.remove("hidden");
        this.els.pickWait.textContent = tip;
      } else {
        this.els.pickWait.classList.add("hidden");
      }
    }

    const counts = Object.create(null);
    for (const id of game.folds) counts[id] = (counts[id] || 0) + 1;
    const foldEntries = Object.entries(counts);
    const compact = document.body.classList.contains("touch-ui") && foldEntries.length > 4;
    this.els.folds.classList.toggle("compact", compact);
    this.els.folds.innerHTML = foldEntries
      .map(([id, n]) => {
        const name = FOLDS[id]?.name || id;
        const label = compact ? name.slice(0, 1) : name;
        const title = `${name}${n > 1 ? ` ×${n}` : ""}`;
        return `<div class="fold-chip" title="${title}">${label}${n > 1 ? `×${n}` : ""}</div>`;
      })
      .join("");

    this.els.relics.innerHTML = game.relics
      .map((id) => `<div class="relic-chip">${RELICS[id]?.name || id}</div>`)
      .join("");
  }

  openPick(cards) {
    if (!cards?.length) return;
    this.els.pick.classList.remove("hidden");
    let subtitle = "";
    if (this.game?.netRole === "client") {
      subtitle = `<p class="muted small" style="margin:0 0 8px">你的专属选池（按你的解锁）</p>`;
    } else if (this.game?.netRole === "host") {
      subtitle = `<p class="muted small" id="pick-wait-sub" style="margin:0 0 8px">各自选折纹 · 你选完后最多等队友 5 秒</p>`;
    }
    this.els.pickCards.innerHTML = subtitle + cards.map((c) => `
      <button class="pick-card ${c.rarity}" data-id="${c.id}">
        <div class="rarity">${RARITY[c.rarity]?.name || ""}</div>
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
    // 客机不能权威暂停；按 Esc 只清本地意图并提示
    if (this.game.netRole === "client") {
      this.game.clearNetIntent?.();
      this.toast("联机中请由主机暂停");
      return;
    }
    this.game.state = "pause";
    this.game.setTouchBlocked?.(true);
    this.els.pause.classList.remove("hidden");
    this.game.clearNetIntent?.();
    if (this.game.netRole === "host") {
      this.session?.sendPause?.(true);
      this.toast("已暂停 · 已通知队友");
    }
  }

  openNetPause() {
    if (!this.game) return;
    this.game.setTouchBlocked?.(true);
    this.els.pause.classList.remove("hidden");
    const title = this.els.pause.querySelector("h2");
    if (title) title.textContent = "主机已暂停";
    this.toast("主机已暂停");
  }

  resume() {
    this.els.pause.classList.add("hidden");
    const title = this.els.pause.querySelector("h2");
    if (title) title.textContent = "暂停";
    if (this.game) {
      if (this.game.netRole === "client" && this.game._netPaused) {
        this.toast("等待主机继续…");
        this.els.pause.classList.remove("hidden");
        if (title) title.textContent = "主机已暂停";
        return;
      }
      this.game.state = "playing";
      this.game._netPaused = false;
      this.game.setTouchBlocked?.(false);
      if (this.game.netRole === "host") this.session?.sendPause?.(false);
    }
  }

  resumeFromNet() {
    this.els.pause.classList.add("hidden");
    const title = this.els.pause.querySelector("h2");
    if (title) title.textContent = "暂停";
    if (this.game) {
      this.game.state = "playing";
      this.game._netPaused = false;
      this.game.setTouchBlocked?.(false);
    }
    this.toast("主机已继续");
  }

  quitToMenu() {
    this.session?.close?.();
    this.session = null;
    this.showMenu();
  }

  async showResult(data) {
    this.els.result.classList.remove("hidden");
    this.els.resultTitle.textContent = data.won ? "织界成形" : "纸页溃散";
    this.els.resultSub.textContent = data.won
      ? `你折完了整本织界。第 ${data.floor} 层 · 击破 ${data.kills}`
      : `止步第 ${data.floor} 层 · 击破 ${data.kills}。溃散也是新的折痕。`;

    const granted = await grantDust(this.save, data.dust, data.won ? "clear" : "fail");
    const nurture = data.nurture | 0;
    this.els.resultRewards.innerHTML = `
      <div class="reward-item">局内折光尘 +${data.runDust}</div>
      <div class="reward-item">${data.won ? "通关奖励" : "残骸回收"} +${data.bonus}</div>
      ${nurture > 0 ? `<div class="reward-item highlight">新手安家 +${nurture}</div>` : ""}
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
        const reveal = unlocked || seen;
        return `<div class="atlas-card ${reveal ? "" : "locked"}">
          <h4>${reveal ? f.name : "？？？"}</h4>
          <p>${!unlocked ? "工坊未解锁" : seen ? f.desc : "已解锁 · 局中遇见后写入详记"}</p>
        </div>`;
      }).join("");
    } else if (this.atlasTab === "enemies") {
      const all = { ...ENEMIES, ...BOSSES };
      html = Object.values(all).map((e) => {
        const seen = s.seen.enemies[e.id] || s.seen.bosses?.[e.id];
        const unlocked = isUnlocked(s, e);
        const reveal = unlocked || seen;
        return `<div class="atlas-card ${reveal ? "" : "locked"}">
          <h4>${reveal ? e.name : "？？？"}</h4>
          <p>${!unlocked ? "尚未编入轮转" : seen ? e.desc : "已编入 · 交手后写入详记"}</p>
        </div>`;
      }).join("");
    } else if (this.atlasTab === "biomes") {
      html = Object.values(BIOMES).map((b) => {
        const seen = s.seen.biomes[b.id];
        const unlocked = isUnlocked(s, b);
        return `<div class="atlas-card ${seen || unlocked ? "" : "locked"}">
          <h4>${seen || unlocked ? b.name : "？？？"}</h4>
          <p>${!unlocked ? "工坊未解锁" : seen ? b.desc : "已解锁 · 踏入后写入详记"}</p>
        </div>`;
      }).join("");
    } else {
      html = SYNERGIES.map((syn) => {
        const seen = s.seen.synergies[syn.id] || s.discoveredSynergies[syn.id];
        const recipeKnown = isUnlocked(s, syn) || seen;
        return `<div class="atlas-card ${seen ? "" : "locked"}">
          <h4>${seen ? syn.name : "未觉醒共鸣"}</h4>
          <p>${seen
            ? `${syn.desc}<br/>需要：${syn.need.map((id) => FOLDS[id].name).join(" + ")}`
            : recipeKnown
              ? `配方提示：${syn.need.map((id) => FOLDS[id].name).join(" + ")}`
              : "局内凑齐对应折纹即可觉醒；工坊可提前解锁配方提示"}</p>
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
    const dust = this.save.dust | 0;
    this.els.metaDust.textContent = `折光尘：${dust}`;

    const starterSet = new Set(META_STARTER_IDS);
    const annotate = (u) => {
      const owned = !!this.save.unlocked[u.id];
      const can = !owned && dust >= u.cost;
      const short = Math.max(0, u.cost - dust);
      const starter = starterSet.has(u.id) && !owned;
      return { u, owned, can, short, starter };
    };

    let list = META_UNLOCKS.map(annotate);
    if (this.metaTab === "recommend") {
      list = list
        .filter((x) => !x.owned && (x.starter || x.can || x.u.cost <= dust + 40))
        .sort((a, b) => {
          if (a.can !== b.can) return a.can ? -1 : 1;
          if (a.starter !== b.starter) return a.starter ? -1 : 1;
          return a.u.cost - b.u.cost;
        })
        .slice(0, 8);
      if (this.els.metaTip) {
        this.els.metaTip.textContent = dust <= 0
          ? "先打一局攒尘。失败也有保底，首局大约能解锁最便宜的一项。"
          : "优先解锁这些，立刻改变下一局的手感。";
      }
    } else if (this.metaTab === "owned") {
      list = list.filter((x) => x.owned);
      if (this.els.metaTip) this.els.metaTip.textContent = "已织入的内容会永久出现在之后的局中。";
    } else {
      list = list
        .filter((x) => x.u.kind === this.metaTab)
        .sort((a, b) => {
          if (a.owned !== b.owned) return a.owned ? 1 : -1;
          if (a.can !== b.can) return a.can ? -1 : 1;
          return a.u.cost - b.u.cost;
        });
      if (this.els.metaTip) {
        this.els.metaTip.textContent = `${META_KIND_LABEL[this.metaTab] || ""} · 买得起的排在前面`;
      }
    }

    if (!list.length) {
      this.els.metaGrid.innerHTML = `<div class="meta-empty">这一栏暂时没有可显示的项目。</div>`;
      return;
    }

    this.els.metaGrid.innerHTML = list.map(({ u, owned, can, short, starter }) => {
      let btnLabel = "解锁";
      if (owned) btnLabel = "完成";
      else if (!can) btnLabel = short > 0 ? `还差 ${short}` : "尘不足";
      const impact = u.impact || (u.kind === "enemy" || u.kind === "boss" || u.kind === "biome" ? "challenge" : "power");
      const impactLab = META_IMPACT_LABEL[impact] || "";
      return `<div class="meta-card ${owned ? "owned" : ""} ${starter && !owned ? "recommend" : ""} ${can ? "affordable" : ""} impact-${impact}">
        ${starter && !owned ? `<div class="meta-badge">推荐</div>` : ""}
        ${impactLab ? `<div class="meta-impact">${impactLab}</div>` : ""}
        <h4>${u.name}</h4>
        <p>${u.desc}</p>
        <div class="cost">${owned ? "已织入" : `消耗 ${u.cost} 折光尘`}</div>
        <button class="btn ${owned ? "" : "primary"}" style="margin-top:10px" data-id="${u.id}" ${owned || !can ? "disabled" : ""}>
          ${btnLabel}
        </button>
      </div>`;
    }).join("");

    this.els.metaGrid.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        const u = META_UNLOCKS.find((x) => x.id === id);
        if (!u || this.save.unlocked[id] || this.save.dust < u.cost) return;
        const ok = await purchaseUnlock(this.save, id, u.cost, KNOWN_UNLOCKS);
        if (!ok) {
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

  isDesktop() {
    return !!window.lumenfold?.isDesktop;
  }

  async openCoop(mode = "lan") {
    this.coopMode = mode === "wan" ? "wan" : "lan";
    this.hideAll();
    this.els.coop.classList.remove("hidden");
    this.els.coopPeers.innerHTML = "";
    if (this.els.coopChatLog) this.els.coopChatLog.innerHTML = "";
    this.els.coopStart.disabled = true;
    this.clearShareInfo();
    const title = document.getElementById("coop-title");
    const desc = document.getElementById("coop-desc");
    const hint = document.getElementById("coop-hint");
    if (this.coopMode === "wan") {
      title.textContent = "外网联机";
      desc.textContent = "连接公网中继后创建/加入房间。HTTPS 页面必须使用 wss://。好友打开同一部署网址最省事。";
      hint.textContent = "部署：npm run wan（或 Docker）。也可填别人提供的 wss 地址。支持 ?relay=wss://…";
      this.els.coopStatus.textContent = "正在解析外网中继…";
      try {
        const url = await resolveWanUrl();
        this.els.coopUrl.value = url;
        this.els.coopStatus.textContent = `就绪 · ${url}`;
      } catch {
        this.els.coopUrl.value = "";
        this.els.coopStatus.textContent = "请手动填写 wss:// 中继地址";
      }
    } else if (this.isDesktop()) {
      title.textContent = "内网联机";
      desc.textContent = "安装版会自动启动本机中继。点「创建房间」后，用「复制给好友」分享地址与房间码。";
      hint.textContent = "好友：在联机页填主机给出的 ws://局域网IP:端口，再输入房间码加入。";
      this.els.coopStatus.textContent = "正在启动本机中继…";
      try {
        const info = await window.lumenfold.ensureRelay();
        this.els.coopUrl.value = info.local || defaultLanUrl();
        const share = info.suggested || info.local;
        this._shareUrl = share;
        const prefer = info.preferPort || 8787;
        let status = `中继已就绪 · 本机 ${info.local} · 好友填 ${share}`;
        if (info.port && prefer && info.port !== prefer) {
          status += `（${prefer} 占用，已改用 ${info.port}）`;
        }
        this.els.coopStatus.textContent = status;
      } catch (e) {
        this.els.coopUrl.value = defaultLanUrl();
        this.els.coopStatus.textContent = e?.message || "本机中继启动失败";
      }
    } else {
      title.textContent = "内网联机";
      desc.textContent = "同一局域网内：一人 npm run lan，其余填 ws://主机局域网IP:8787。";
      hint.textContent = "本机开发也可用 npm run wan，然后填 ws://127.0.0.1:8787。";
      this.els.coopUrl.value = defaultLanUrl();
      this.els.coopStatus.textContent = "未连接。先在一台电脑运行：npm run lan";
    }
  }

  clearShareInfo() {
    this._sharePayload = "";
    this._shareUrl = "";
    if (this.els.coopShare) this.els.coopShare.classList.add("hidden");
    if (this.els.coopShareText) this.els.coopShareText.textContent = "";
  }

  setShareInfo({ url, code, note = "" }) {
    if (!url || !code || !this.els.coopShare) return;
    this._shareUrl = url;
    const lines = [
      `折光织界 · 联机`,
      `中继：${url}`,
      `房间码：${code}`,
    ];
    if (note) lines.push(note);
    this._sharePayload = lines.join("\n");
    this.els.coopShareText.textContent = this._sharePayload;
    this.els.coopShare.classList.remove("hidden");
  }

  async copyShareInfo() {
    const text = this._sharePayload || this.els.coopShareText?.textContent || "";
    if (!text.trim()) {
      this.toast("还没有可分享的房间信息");
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      this.audio.ui();
      this.toast("已复制给好友");
    } catch {
      this.toast("复制失败，请手动选中分享框");
    }
  }

  async _makeSession() {
    const url = this.els.coopUrl.value.trim() || (this.coopMode === "wan" ? await resolveWanUrl() : defaultLanUrl());
    const name = this.els.coopName.value.trim() || "折客";
    this.session?.close?.();
    if (this.coopMode === "wan") {
      saveWanUrl(url);
      this.session = new WanSession({ url, name });
    } else {
      this.session = new LanSession({ url, name });
    }
    this._bindSession(this.session);
    return this.session;
  }

  _bindSession(session) {
    session.on(NET.JOINED, (msg) => {
      this.els.coopStatus.textContent = `已加入房间 ${msg.roomCode} · 你是${msg.role === "host" ? "主机（权威）" : "客机"} · 折印 ${computeFoldSeal(this.save)}`;
      this.els.coopCode.value = msg.roomCode;
      this.renderPeers(msg.peers);
      this.els.coopStart.disabled = msg.role !== "host";
      if (msg.role !== "host") this.els.coopStart.textContent = "等待主机开始…";
      else this.els.coopStart.textContent = "全员就绪 · 开始";
      if (msg.role === "host") {
        const url = this._shareUrl || this.els.coopUrl.value.trim() || defaultLanUrl();
        this.setShareInfo({ url, code: msg.roomCode });
      }
      // 入房后广播各自解锁进度 / 折印
      this._publishMeta(session);
      this._peerMetaCache = this._peerMetaCache || new Map();
      if (session.playerId) {
        this._peerMetaCache.set(session.playerId, buildPeerMeta(this.save, session.name));
      }
    });
    session.on(NET.PEER_JOIN, (msg) => {
      this.renderPeers(msg.peers);
      this._publishMeta(session);
      // 局中加入：等 meta 到齐后再接纳（解锁池影响补选）
      if (session.role === "host" && msg.player?.id) {
        this._queueLateAdmit(msg.player.id, msg.player.name);
      }
    });
    session.on(NET.PEER_LEFT, (msg) => {
      this.renderPeers(msg.peers);
      if (msg.playerId && this._peerMetaCache) this._peerMetaCache.delete(msg.playerId);
      const g = this.game || this.getGame?.();
      if (g && (g.state === "playing" || g.state === "pick" || g.state === "pause")) {
        g.removePeer?.(msg.playerId);
        this.toast("队友已离开");
      }
    });
    session.on(NET.ROOM, (msg) => this.renderPeers(msg.peers));
    session.on(NET.META, (msg) => {
      if (!msg.from || !msg.meta) return;
      this._peerMetaCache = this._peerMetaCache || new Map();
      this._peerMetaCache.set(msg.from, msg.meta);
      this.game?.setPeerMeta?.(msg.from, msg.meta);
      this.renderPeers(session.peers);
      if (session.role === "host" && this._lateAdmitPending?.has(msg.from)) {
        this._flushLateAdmit(msg.from);
      }
    });
    session.on(NET.ERROR, (msg) => {
      this.toast(msg.message || "联机错误");
      this.els.coopStatus.textContent = msg.message || "联机错误";
      // 主机宽限期耗尽：局内收束
      if (String(msg.message || "").includes("主机已离开")) {
        this._clearReconnect();
        const g = this.game || this.getGame?.();
        if (g && (g.state === "playing" || g.state === "pick" || g.state === "pause")) {
          g._awaitingHost = false;
          g.endRun?.(false, { fromNet: true, dust: g.dustEarned, bonus: 0 });
        }
      }
    });
    session.on(NET.HOST_AWAY, (msg) => {
      const g = this.game || this.getGame?.();
      if (g) g._awaitingHost = true;
      const sec = Math.round((msg.graceMs || 20000) / 1000);
      this.toast(msg.message || `主机短暂离线，${sec}s 内可重连`);
      this.els.coopStatus.textContent = `等待主机重连（${sec}s）…`;
    });
    session.on(NET.HOST_BACK, () => {
      const g = this.game || this.getGame?.();
      if (g) {
        g._awaitingHost = false;
        g._snapWarn = false;
        g._lastSnapAt = performance.now();
      }
      this.toast("主机已重连");
      this.els.coopStatus.textContent = "主机已回来";
    });
    session.on(NET.PAUSE, () => {
      const g = this.game || this.getGame?.();
      if (!g || g.netRole !== "client") return;
      if (g.state === "playing") {
        g._netPaused = true;
        g.state = "pause";
        this.openNetPause();
      }
    });
    session.on(NET.RESUME, () => {
      const g = this.game || this.getGame?.();
      if (!g || g.netRole !== "client") return;
      g._netPaused = false;
      this.resumeFromNet();
    });
    session.on(NET.CHAT, (msg) => {
      this.appendCoopChat(msg.name || "折客", msg.text || "");
    });
    session.on("close", (info) => {
      if (info?.intentional) return;
      const g = this.game || this.getGame?.();
      if (g && (g.state === "playing" || g.state === "pick" || g.state === "pause")) {
        this._tryReconnectDuringRun(session, g);
        return;
      }
    });
    session.on(NET.START, (msg) => {
      const g0 = this.game || this.getGame?.();
      // 主机为中途加入者重发的 START：已在局内的端忽略
      if (g0 && (g0.state === "playing" || g0.state === "pick" || g0.state === "pause" || g0.state === "result")) {
        return;
      }
      try { document.activeElement?.blur?.(); } catch { /* */ }
      this.hideAll();
      this.els.hud.classList.remove("hidden");
      // 开局前把缓存的折印灌进即将创建的 Game
      if (msg.hostSeal) this._pendingHostSeal = msg.hostSeal;
      if (msg.metas) {
        this._peerMetaCache = this._peerMetaCache || new Map();
        for (const [id, meta] of Object.entries(msg.metas)) {
          this._peerMetaCache.set(id, meta);
        }
      }
      this._pendingCatchUp = msg.catchUpPicks | 0;
      this._pendingLateJoin = !!msg.lateJoin;
      this.onCoopStart(session, {
        hostSeal: msg.hostSeal,
        metas: this._peerMetaCache,
        worldW: msg.worldW,
        worldH: msg.worldH,
        lateJoin: !!msg.lateJoin,
        catchUpPicks: msg.catchUpPicks | 0,
      });
    });
    session.on(NET.END, (msg) => {
      if (session.role !== "client") return;
      const g = this.game || this.getGame?.();
      if (!g || g.state === "result") return;
      g.endRun?.(!!msg.won, {
        fromNet: true,
        floor: msg.floor,
        kills: msg.kills,
        dust: msg.dust,
        bonus: msg.bonus,
        runDust: msg.runDust,
        nurture: msg.nurture | 0,
      });
    });
    session.on(NET.SNAPSHOT, (msg) => {
      const g = this.game || this.getGame?.();
      g?.applySnapshot?.(msg.snap);
    });
    session.on(NET.INPUT, (msg) => {
      const g = this.game || this.getGame?.();
      if (msg.from) g?.onRemoteInput?.(msg.from, msg.input, msg.name);
    });
    session.on(NET.CHOOSE, (msg) => {
      if (!this.game) return;
      // 主机收到客机选择
      if (session.role === "host" && msg.from && msg.from !== session.playerId) {
        this.game.onRemoteChoose(msg.from, msg.foldId, msg.name);
        return;
      }
      // 客机只看别人选了什么（不影响自己的构筑）
      if (session.role === "client" && msg.foldId && msg.from !== session.playerId) {
        const id = msg.foldId;
        const label = String(id).startsWith("relic:")
          ? RELICS[String(id).slice(6)]?.name
          : FOLDS[id]?.name;
        this.toast(`${msg.name || "队友"} 选定：${label || id}`);
      }
    });
    session.on(NET.PICK, (msg) => {
      if (session.role !== "client" || !this.game) return;
      const myId = session.playerId;
      const ids = msg.offers?.[myId] || msg.cards;
      if (!ids?.length) return;
      const hint = msg.pendingHint | 0;
      if (hint > 0) {
        this.game.pendingPicks = hint;
      } else if (this.game.state !== "pick") {
        this.game.pendingPicks = this.game.player.flags.extraPick ? 2 : 1;
      } else if (this.game.pendingPicks <= 0) {
        this.game.pendingPicks = 1;
      }
      if (msg.catchUp) {
        this.game._catchUpJoin = true;
        this.toast(`补选折纹 · 还剩 ${this.game.pendingPicks} 张`);
      }
      this.game.receivePickOffer(ids, this.game.pendingPicks);
    });
  }

  sendCoopChat() {
    const input = this.els.coopChatInput;
    if (!input || !this.session) return;
    const text = input.value.trim();
    if (!text) return;
    this.session.sendChat?.(text);
    this.appendCoopChat(this.session.name || "我", text, true);
    input.value = "";
  }

  appendCoopChat(name, text, self = false) {
    const log = this.els.coopChatLog;
    if (!log || !text) return;
    const line = document.createElement("div");
    line.className = `chat-line${self ? " self" : ""}`;
    line.textContent = `${name}：${text}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 40) log.removeChild(log.firstChild);
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnecting = false;
  }

  async _tryReconnectDuringRun(session, g) {
    if (this._reconnecting) return;
    this._reconnecting = true;
    const isHost = session.role === "host";
    const code = session.roomCode;
    const hostKey = session.hostKey;
    this.toast(isHost ? "连接中断，正在尝试重连…" : "连接中断，正在尝试重连…");
    if (g) g._awaitingHost = true;

    const deadline = Date.now() + 18000;
    const tick = async () => {
      if (!this._reconnecting) return;
      if (Date.now() > deadline) {
        this._clearReconnect();
        this.toast("重连超时");
        if (g) {
          g._awaitingHost = false;
          g.endRun?.(false, { fromNet: true, dust: g.dustEarned, bonus: 0 });
        }
        return;
      }
      try {
        if (isHost) {
          await session.reclaimRoom(code, hostKey);
          if (g) {
            g._awaitingHost = false;
            g._lastSnapAt = performance.now();
            if (g.player && session.playerId) g.player.id = session.playerId;
            session.sendSnapshot?.(g.buildSnapshot?.());
          }
        } else {
          await session.rejoinRoom(code);
          if (g) {
            g._awaitingHost = false;
            g._lastSnapAt = performance.now();
            if (g.player && session.playerId) g.player.id = session.playerId;
          }
        }
        this.toast("重连成功");
        this._clearReconnect();
      } catch (e) {
        this.toast(e.message || "重连失败，稍后重试…");
        this._reconnectTimer = setTimeout(tick, 2200);
      }
    };
    this._reconnectTimer = setTimeout(tick, 500);
  }

  _queueLateAdmit(playerId, name) {
    const g = this.game || this.getGame?.();
    if (!g || !(g.state === "playing" || g.state === "pick" || g.state === "pause")) return;
    this._lateAdmitPending = this._lateAdmitPending || new Map();
    this._lateAdmitPending.set(playerId, name || "折客");
    // meta 可能已到；否则短等再接纳
    if (this._peerMetaCache?.has(playerId)) {
      this._flushLateAdmit(playerId);
      return;
    }
    clearTimeout(this._lateAdmitTimers?.[playerId]);
    this._lateAdmitTimers = this._lateAdmitTimers || {};
    this._lateAdmitTimers[playerId] = setTimeout(() => this._flushLateAdmit(playerId), 280);
  }

  _flushLateAdmit(playerId) {
    if (!this._lateAdmitPending?.has(playerId)) return;
    const name = this._lateAdmitPending.get(playerId);
    this._lateAdmitPending.delete(playerId);
    if (this._lateAdmitTimers?.[playerId]) {
      clearTimeout(this._lateAdmitTimers[playerId]);
      delete this._lateAdmitTimers[playerId];
    }
    const g = this.game || this.getGame?.();
    if (!g || this.session?.role !== "host") return;
    if (!(g.state === "playing" || g.state === "pick" || g.state === "pause")) return;
    const meta = this._peerMetaCache?.get(playerId);
    if (meta) g.setPeerMeta?.(playerId, meta);
    g.admitLatePeer?.(playerId, name);
  }

  _publishMeta(session) {
    const meta = buildPeerMeta(this.save, session.name || this.els.coopName.value);
    session.sendMeta(meta);
  }

  renderPeers(peers = []) {
    let hostSeal = computeFoldSeal(this.save);
    if (this.session?.role !== "host" && this._peerMetaCache) {
      for (const p of peers) {
        if (p.role === "host" && this._peerMetaCache.has(p.id)) {
          hostSeal = this._peerMetaCache.get(p.id).seal || hostSeal;
        }
      }
    } else if (this.session?.role === "host") {
      hostSeal = computeFoldSeal(this.save);
    }

    this.els.coopPeers.innerHTML = peers.map((p) => {
      const meta = this._peerMetaCache?.get(p.id);
      const seal = meta?.seal ?? (p.id === this.session?.playerId ? computeFoldSeal(this.save) : "?");
      let tag = "";
      if (p.role !== "host" && typeof seal === "number") {
        const bal = sealBalance(seal, hostSeal);
        if (bal.atkMul < 0.98) tag = ` · 抑攻${Math.round((1 - bal.atkMul) * 100)}%`;
        else if (bal.hpMul > 1.02) tag = ` · 加韧${Math.round((bal.hpMul - 1) * 100)}%`;
      }
      return `<span class="peer-chip">${p.name}${p.role === "host" ? " · 主机" : ""} · 折印 ${seal}${tag}</span>`;
    }).join("");
  }

  async hostRoom() {
    try {
      this.els.coopStatus.textContent = "正在创建房间…";
      let shareUrl = null;
      let portNote = "";
      if (this.coopMode === "lan" && this.isDesktop()) {
        const info = await window.lumenfold.ensureRelay();
        this.els.coopUrl.value = info.local || this.els.coopUrl.value;
        shareUrl = info.suggested || info.local;
        const prefer = info.preferPort || 8787;
        if (info.port && prefer && info.port !== prefer) {
          portNote = `${prefer} 占用，已改用 ${info.port}`;
        }
      }
      const s = await this._makeSession();
      const { code } = await s.createRoom();
      const url = shareUrl || this.els.coopUrl.value.trim() || defaultLanUrl();
      this._shareUrl = url;
      if (shareUrl || this.coopMode === "lan") {
        this.els.coopStatus.textContent = `房间 ${code} · 你是主机 · 好友填 ${url}`;
        this.setShareInfo({ url, code, note: portNote });
      } else {
        this.els.coopStatus.textContent = `房间 ${code} · 你是主机`;
        this.setShareInfo({ url, code });
      }
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
      const s = await this._makeSession();
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
    this.audio.startBgm?.("battle");
    try { document.activeElement?.blur?.(); } catch { /* */ }
    this._publishMeta(this.session);
    const hostSeal = computeFoldSeal(this.save);
    const metas = {};
    if (this.session.playerId) {
      metas[this.session.playerId] = buildPeerMeta(this.save, this.session.name);
    }
    for (const [id, meta] of this._peerMetaCache || []) {
      metas[id] = meta;
    }
    const worldW = window.innerWidth | 0;
    const worldH = window.innerHeight | 0;
    this.session.startGame(Math.random(), { hostSeal, metas, worldW, worldH });
    this.hideAll();
    this.els.hud.classList.remove("hidden");
    this.onCoopStart(this.session, {
      hostSeal,
      metas: this._peerMetaCache,
      worldW,
      worldH,
    });
    this.getGame?.()?.setTouchHud?.(true);
  }

  async tryWan() {
    this.openCoop("wan");
  }

  toast(msg) {
    const el = this.els.toast;
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
  }
}
