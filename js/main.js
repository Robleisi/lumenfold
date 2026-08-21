import { loadSave, writeSave } from "./save.js";
import { AudioBus } from "./audio.js";
import { Game } from "./game.js";
import { UI } from "./ui.js";
import { Tutorial } from "./tutorial.js";
import { LocalSession } from "./net/session.js";
import { loadSettings, saveSettings, qualityPreset } from "./settings.js";
import { setLang, applyStaticI18n, t } from "./i18n.js";
import { computeFoldSeal, sealBalance, buildPeerMeta } from "./net/protocol.js";

const canvas = document.getElementById("game");
const app = document.getElementById("app");
const audio = new AudioBus();
const settings = loadSettings();

setLang(settings.lang);
audio.applySettings(settings);
applyStaticI18n();

let save = await loadSave();
if (save._tampered) {
  console.warn("[lumenfold] save tamper detected, reset");
}

let game = null;
let tutorial = null;
let last = performance.now();
let running = true;
let fpsCap = settings.fpsCap || 0;
let frameBudget = 0;

function applyAllSettings(s, toast = false) {
  Object.assign(settings, s);
  saveSettings(settings);
  setLang(settings.lang);
  applyStaticI18n();
  audio.applySettings(settings);
  fpsCap = settings.fpsCap || 0;
  if (game) game.applySettings(settings);
  if (toast) ui.toast(t("toast_saved"));
}

function ensureGame() {
  if (game) return game;
  game = new Game(canvas, audio, save, {
    onHud: () => ui.updateHud(game),
    onPick: (cards) => ui.openPick(cards),
    onPickClose: () => ui.closePick(),
    onPause: () => ui.openPause(),
    onResult: async (data) => {
      // 统计已在 endRun 写入 save；由 showResult → grantDust 一次落盘
      ui.showResult(data);
    },
    toast: (msg) => ui.toast(msg),
  });
  game.applySettings(settings);
  tutorial = new Tutorial({
    root: app,
    save,
    audio,
    onComplete: async (skipped) => {
      game?.safeExitTutorial?.();
      await writeSave(save);
      if (skipped) ui.toast("已跳过教程");
    },
  });
  game.setTutorial(tutorial);
  ui.setGame(game);
  return game;
}

const ui = new UI({
  save,
  audio,
  settings,
  getGame: () => game,
  onSettingsChange: applyAllSettings,
  onStart: async ({ forceTutorial } = {}) => {
    audio.ensure();
    const g = ensureGame();
    g.setSession(new LocalSession());
    g.startRun();
    ui.updateHud(g);
    if (forceTutorial || tutorial.shouldAutoStart()) {
      tutorial.start();
    }
  },
  onCoopStart: (session, coopInfo = {}) => {
    audio.ensure();
    try { document.activeElement?.blur?.(); } catch { /* */ }
    const g = ensureGame();
    g.setSession(session);
    g.playerCount = Math.max(1, session.peers?.length || session.playerCount || 1);
    g.hostSeal = coopInfo.hostSeal || computeFoldSeal(save);
    g.localSeal = computeFoldSeal(save);
    g.peerMeta.clear();
    if (coopInfo.worldW && coopInfo.worldH) {
      g._pendingWorldW = coopInfo.worldW;
      g._pendingWorldH = coopInfo.worldH;
    }
    const metas = coopInfo.metas;
    if (metas && typeof metas.forEach === "function") {
      metas.forEach((meta, id) => g.setPeerMeta(id, meta));
    } else if (metas && typeof metas === "object") {
      for (const [id, meta] of Object.entries(metas)) g.setPeerMeta(id, meta);
    }
    // 确保本机进度也在表里
    if (session.playerId) {
      g.setPeerMeta(session.playerId, buildPeerMeta(save, session.name));
    }
    g._catchUpJoin = !!(coopInfo.lateJoin && (coopInfo.catchUpPicks | 0) > 0);
    g.startRun();
    try { canvas.focus({ preventScroll: true }); } catch { try { canvas.focus(); } catch { /* */ } }
    ui.updateHud(g);
    if (session.role === "host") {
      ui.toast(`联机开始 · ${g.playerCount} 人 · 主机折印 ${g.hostSeal} · 各自解锁进局`);
    } else if (coopInfo.lateJoin) {
      const n = coopInfo.catchUpPicks | 0;
      ui.toast(n > 0 ? `中途加入 · 需补选 ${n} 张折纹` : "中途加入 · 已同步");
    } else {
      const bal = sealBalance(g.localSeal, g.hostSeal);
      let tip = "已同步";
      if (bal.atkMul < 0.98) tip = `折印偏高，攻击×${bal.atkMul.toFixed(2)}`;
      else if (bal.hpMul > 1.02) tip = `折印偏低，韧性×${bal.hpMul.toFixed(2)}（减伤×${bal.dmgTakenMul.toFixed(2)}）`;
      ui.toast(`客机加入 · 折印 ${g.localSeal} vs 主机 ${g.hostSeal} · ${tip}`);
    }
  },
});

if (save._tampered) {
  ui.toast("检测到存档被篡改，已安全重置");
  delete save._tampered;
}

ui.showMenu();

window.addEventListener("resize", () => game && game.resize());

function frame(now) {
  const rawDt = Math.min(0.05, (now - last) / 1000);
  last = now;

  let dt = rawDt;
  if (fpsCap > 0) {
    frameBudget += rawDt;
    const step = 1 / fpsCap;
    if (frameBudget < step) {
      if (running) requestAnimationFrame(frame);
      return;
    }
    // 吃掉堆积，用固定步长推进模拟，避免限帧时半速
    while (frameBudget >= step * 3) frameBudget -= step;
    frameBudget -= step;
    dt = step;
  }

  if (game) {
    if (game.state === "playing" || game.state === "pick") game.update(dt);
    if (game.state !== "idle") game.draw();
    else drawMenuBackdrop(dt);
  } else {
    drawMenuBackdrop(dt);
  }
  if (running) requestAnimationFrame(frame);
}

let menuT = 0;
function drawMenuBackdrop(dt) {
  menuT += dt;
  const ctx = canvas.getContext("2d", { alpha: false });
  const dpr = Math.min(window.devicePixelRatio || 1, qualityPreset(settings.quality).dprCap);
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvas.width !== (w * dpr | 0) || canvas.height !== (h * dpr | 0)) {
    canvas.width = (w * dpr) | 0;
    canvas.height = (h * dpr) | 0;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#0a2731");
  g.addColorStop(0.5, "#15443f");
  g.addColorStop(1, "#1d4a3b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = "#e8b45a";
  ctx.lineWidth = 1;
  const step = 110;
  const off = (menuT * 12) % step;
  ctx.beginPath();
  for (let x = -step + off; x < w + step; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x + h * 0.18, h);
  }
  ctx.stroke();

  ctx.globalAlpha = 0.2;
  for (let i = 0; i < 5; i++) {
    const x = w * (0.2 + i * 0.15) + Math.sin(menuT * 0.7 + i) * 30;
    const y = h * (0.35 + Math.sin(menuT * 0.5 + i * 1.3) * 0.2);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(menuT * 0.3 + i);
    ctx.fillStyle = i % 2 ? "#f4fbf8" : "#e89a2d";
    ctx.beginPath();
    ctx.moveTo(0, -18); ctx.lineTo(16, 0); ctx.lineTo(0, 18); ctx.lineTo(-16, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

requestAnimationFrame(frame);
window.addEventListener("pointerdown", () => {
  audio.ensure();
  if (!game || game.state === "idle") audio.startBgm("menu");
}, { once: true });

// 自动化 / 调试只读入口
Object.defineProperty(window, "__lumenGame", {
  get: () => game,
  configurable: true,
});
