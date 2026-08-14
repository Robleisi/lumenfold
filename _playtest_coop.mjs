/**
 * Coop / relay playtest: protocol + dual-browser UI flow.
 * Usage: node _playtest_coop.mjs
 * Expects wan/lan relay on :8787 (starts one if LUMEN_START_RELAY=1).
 */
import { chromium } from "playwright";
import WebSocket from "ws";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const PORT = Number(process.env.LUMENFOLD_PORT || 8787);
const BASE = process.env.LUMEN_URL || `http://127.0.0.1:${PORT}`;
const WS = process.env.LUMEN_WS || `ws://127.0.0.1:${PORT}`;
const OUT = join(process.cwd(), "_playtest_out");
mkdirSync(OUT, { recursive: true });

const findings = [];
const checks = [];

function log(...a) {
  console.log("[coop]", ...a);
}
function ok(name, detail = "") {
  checks.push({ name, pass: true, detail });
  log("PASS", name, detail);
}
function fail(name, detail = "") {
  checks.push({ name, pass: false, detail });
  findings.push({ severity: "fail", name, detail });
  log("FAIL", name, detail);
}
function warn(name, detail = "") {
  checks.push({ name, pass: "warn", detail });
  findings.push({ severity: "warn", name, detail });
  log("WARN", name, detail);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function wsOnce(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      reject(new Error("ws connect timeout"));
    }, timeoutMs);
    ws.on("open", () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

function waitMsg(ws, pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error("waitMsg timeout"));
    }, timeoutMs);
    function onMsg(buf) {
      let msg;
      try { msg = JSON.parse(String(buf)); } catch { return; }
      if (!pred(msg)) return;
      clearTimeout(t);
      ws.off("message", onMsg);
      resolve(msg);
    }
    ws.on("message", onMsg);
  });
}

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function ensureRelay() {
  try {
    const h = await fetchJson("/health");
    if (h.ok) {
      ok("relay-already-up", JSON.stringify(h));
      return null;
    }
  } catch { /* start */ }
  log("starting wan relay…");
  const child = spawn(process.execPath, ["server/wan.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, LUMENFOLD_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let boot = "";
  child.stdout.on("data", (d) => { boot += d; process.stdout.write(`[relay] ${d}`); });
  child.stderr.on("data", (d) => { boot += d; process.stderr.write(`[relay:err] ${d}`); });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const h = await fetchJson("/health");
      if (h.ok) {
        ok("relay-started", JSON.stringify(h));
        return child;
      }
    } catch { /* retry */ }
  }
  fail("relay-start", boot.slice(0, 400));
  throw new Error("relay failed to start");
}

async function testProtocol() {
  log("--- protocol ---");
  // health + relay-info
  const health = await fetchJson("/health");
  if (health.ok && health.service === "lumenfold-relay") ok("health", JSON.stringify(health));
  else fail("health", JSON.stringify(health));

  const info = await fetchJson("/relay-info");
  if (info.local?.includes("ws://") && info.port === PORT) ok("relay-info", JSON.stringify(info));
  else fail("relay-info", JSON.stringify(info));

  // host create + client join
  const host = await wsOnce(WS);
  const client = await wsOnce(WS);
  host.send(JSON.stringify({ type: "hello", name: "主机测", client: "lumenfold", proto: 1 }));
  client.send(JSON.stringify({ type: "hello", name: "客机测", client: "lumenfold", proto: 1 }));

  const joinedP = waitMsg(host, (m) => m.type === "joined");
  host.send(JSON.stringify({ type: "join", create: true, name: "主机测" }));
  const joined = await joinedP;
  if (joined.role === "host" && joined.roomCode && joined.peers?.length === 1) {
    ok("host-create", joined.roomCode);
  } else fail("host-create", JSON.stringify(joined));

  const code = joined.roomCode;
  const peerJoinP = waitMsg(host, (m) => m.type === "peer_join");
  const clientJoinedP = waitMsg(client, (m) => m.type === "joined");
  client.send(JSON.stringify({ type: "join", roomCode: code, name: "客机测" }));
  const [peerJoin, clientJoined] = await Promise.all([peerJoinP, clientJoinedP]);
  if (clientJoined.role === "client" && clientJoined.roomCode === code) ok("client-join", code);
  else fail("client-join", JSON.stringify(clientJoined));
  if (peerJoin.peers?.length === 2) ok("peer-join-broadcast", `${peerJoin.peers.length}`);
  else fail("peer-join-broadcast", JSON.stringify(peerJoin));

  // meta broadcast both ways
  const metaOnClient = waitMsg(client, (m) => m.type === "meta" && m.name === "主机测");
  host.send(JSON.stringify({ type: "meta", meta: { name: "主机测", seal: 40, unlocked: {} } }));
  const meta1 = await metaOnClient;
  if (meta1.meta?.seal === 40) ok("meta-host-to-client");
  else fail("meta-host-to-client", JSON.stringify(meta1));

  // only host may start/snapshot/end
  const errP = waitMsg(client, (m) => m.type === "error");
  client.send(JSON.stringify({ type: "start", seed: 1 }));
  const err = await errP;
  if (String(err.message || "").includes("仅主机")) ok("client-cannot-start", err.message);
  else fail("client-cannot-start", JSON.stringify(err));

  // start reaches client
  const startP = waitMsg(client, (m) => m.type === "start");
  host.send(JSON.stringify({
    type: "start", seed: 0.42,
    hostSeal: 40, worldW: 1280, worldH: 720,
    metas: { [joined.playerId]: { name: "主机测", seal: 40 } },
  }));
  const start = await startP;
  if (start.seed === 0.42 && start.worldW === 1280) ok("start-forward", JSON.stringify({ seed: start.seed }));
  else fail("start-forward", JSON.stringify(start));

  // input from client reaches host only
  const inputP = waitMsg(host, (m) => m.type === "input");
  let leakedToClient = false;
  const leakHandler = (buf) => {
    try {
      const m = JSON.parse(String(buf));
      if (m.type === "input") leakedToClient = true;
    } catch { /* */ }
  };
  client.on("message", leakHandler);
  client.send(JSON.stringify({
    type: "input",
    input: { x: 100, y: 200, keys: { w: true, fire: true } },
    t: 1,
  }));
  const input = await inputP;
  await sleep(80);
  client.off("message", leakHandler);
  if (input.from === clientJoined.playerId && input.input?.x === 100) ok("input-to-host");
  else fail("input-to-host", JSON.stringify(input));
  if (!leakedToClient) ok("input-not-broadcast-to-peers");
  else fail("input-not-broadcast-to-peers", "client saw peer input");

  // snapshot host -> client
  const snapP = waitMsg(client, (m) => m.type === "snapshot");
  host.send(JSON.stringify({
    type: "snapshot",
    snap: { t: 1, floor: 1, room: 0, kills: 3, players: [], enemies: [], bullets: [] },
  }));
  const snap = await snapP;
  if (snap.snap?.kills === 3) ok("snapshot-forward");
  else fail("snapshot-forward", JSON.stringify(snap));

  // choose coalescing under rate limit
  const chooses = [];
  const chooseCollect = (buf) => {
    try {
      const m = JSON.parse(String(buf));
      if (m.type === "choose") chooses.push(m);
    } catch { /* */ }
  };
  host.on("message", chooseCollect);
  for (let i = 0; i < 5; i++) {
    client.send(JSON.stringify({ type: "choose", foldId: `fold_${i}` }));
  }
  await sleep(250);
  host.off("message", chooseCollect);
  if (chooses.length >= 1 && chooses.length <= 5) {
    ok("choose-rate", `got ${chooses.length}/5`);
  } else fail("choose-rate", `got ${chooses.length}`);
  // last pending should eventually surface (coalesce)
  const last = chooses[chooses.length - 1];
  if (last && (last.foldId === "fold_4" || chooses.some((c) => c.foldId === "fold_4"))) {
    ok("choose-latest-preserved", last.foldId);
  } else warn("choose-latest-preserved", `last=${last?.foldId} all=${chooses.map((c) => c.foldId).join(",")}`);

  // room full (need 3 more to hit 4 — already 2)
  const extras = [];
  for (let i = 0; i < 2; i++) {
    const ws = await wsOnce(WS);
    extras.push(ws);
    const jp = waitMsg(ws, (m) => m.type === "joined" || m.type === "error");
    ws.send(JSON.stringify({ type: "hello", name: `P${i}` }));
    ws.send(JSON.stringify({ type: "join", roomCode: code, name: `P${i}` }));
    await jp;
  }
  const over = await wsOnce(WS);
  const overP = waitMsg(over, (m) => m.type === "error" || m.type === "joined");
  over.send(JSON.stringify({ type: "join", roomCode: code, name: "溢出" }));
  const overMsg = await overP;
  if (overMsg.type === "error" && String(overMsg.message).includes("满")) ok("room-full");
  else fail("room-full", JSON.stringify(overMsg));

  // host leave closes room for clients
  const closeErrP = waitMsg(client, (m) => m.type === "error" && String(m.message || "").includes("主机"));
  host.close();
  try {
    const closeErr = await closeErrP;
    ok("host-leave-closes", closeErr.message);
  } catch (e) {
    fail("host-leave-closes", String(e.message || e));
  }

  for (const ws of [client, over, ...extras]) {
    try { ws.close(); } catch { /* */ }
  }

  // bad room code
  const ghost = await wsOnce(WS);
  const badP = waitMsg(ghost, (m) => m.type === "error");
  ghost.send(JSON.stringify({ type: "join", roomCode: "ZZZZZ", name: "ghost" }));
  const bad = await badP;
  if (String(bad.message).includes("不存在")) ok("bad-room-code");
  else fail("bad-room-code", JSON.stringify(bad));
  ghost.close();

  // oversized message must not crash the relay process
  const fat = await wsOnce(WS);
  let fatClosed = false;
  fat.on("close", () => { fatClosed = true; });
  fat.on("error", () => { /* expected */ });
  try {
    fat.send("x".repeat(60_000));
  } catch { /* client may throw */ }
  await sleep(400);
  // relay still alive?
  try {
    const h2 = await fetchJson("/health");
    if (h2.ok) ok("oversized-no-crash", `closed=${fatClosed}`);
    else fail("oversized-no-crash", JSON.stringify(h2));
  } catch (e) {
    fail("oversized-no-crash", `relay dead: ${e.message || e}`);
  }
  try { fat.close(); } catch { /* */ }
}

async function launchBrowser() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      const b = await chromium.launch({ headless: true, channel });
      log("browser", channel);
      return b;
    } catch { /* */ }
  }
  return chromium.launch({ headless: true });
}

async function prepPage(context, name) {
  const page = await context.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleMsgs = [];
  const pageErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleMsgs.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page._coopMeta = { name, consoleMsgs, pageErrors };
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(() => {
    try {
      localStorage.setItem("lumenfold_settings_v1", JSON.stringify({
        lang: "zh", masterVol: 0, sfxVol: 0, muted: true,
        quality: "low", fpsCap: 0, showFps: true,
        screenShake: false, reduceFlash: true,
      }));
    } catch { /* */ }
  });
  await page.reload({ waitUntil: "networkidle" });
  await sleep(400);
  return page;
}

async function shot(page, name) {
  const path = join(OUT, `coop-${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function testUiCoop(browser) {
  log("--- ui dual browser ---");
  const hostCtx = await browser.newContext();
  const clientCtx = await browser.newContext();
  const host = await prepPage(hostCtx, "host");
  const client = await prepPage(clientCtx, "client");

  // open LAN coop (same as WAN when using wan server)
  await host.click("#btn-coop");
  await sleep(300);
  await shot(host, "01-host-lobby");

  // URL should default to ws://127.0.0.1:8787 when page is on 8787
  const hostUrl = await host.inputValue("#coop-url");
  if (hostUrl.includes("8787") || hostUrl.includes(String(PORT))) ok("ui-default-url", hostUrl);
  else warn("ui-default-url", hostUrl);

  await host.fill("#coop-name", "主机A");
  await host.click("#btn-host");
  await host.waitForFunction(() => {
    const s = document.getElementById("coop-status")?.textContent || "";
    return s.includes("已加入") || s.includes("主机");
  }, null, { timeout: 10000 }).catch(() => null);

  const hostStatus = await host.textContent("#coop-status");
  const roomCode = (await host.inputValue("#coop-code")).trim();
  if (roomCode && hostStatus.includes("主机")) ok("ui-host-created", `${roomCode} | ${hostStatus}`);
  else fail("ui-host-created", `${roomCode} | ${hostStatus}`);

  await client.click("#btn-coop");
  await sleep(300);
  await client.fill("#coop-name", "客机B");
  await client.fill("#coop-url", WS);
  await client.fill("#coop-code", roomCode);
  await client.click("#btn-join");
  await client.waitForFunction(() => {
    const s = document.getElementById("coop-status")?.textContent || "";
    return s.includes("已加入") || s.includes("客机");
  }, null, { timeout: 10000 }).catch(() => null);

  const clientStatus = await client.textContent("#coop-status");
  if (clientStatus.includes("客机")) ok("ui-client-joined", clientStatus);
  else fail("ui-client-joined", clientStatus);

  // peers chips on both
  await sleep(500);
  const hostPeers = await host.textContent("#coop-peers");
  const clientPeers = await client.textContent("#coop-peers");
  if (hostPeers?.includes("主机A") && hostPeers?.includes("客机B")) ok("ui-host-peers", hostPeers);
  else fail("ui-host-peers", hostPeers);
  if (clientPeers?.includes("主机A") && clientPeers?.includes("客机B")) ok("ui-client-peers", clientPeers);
  else fail("ui-client-peers", clientPeers);

  await shot(host, "02-host-ready");
  await shot(client, "03-client-ready");

  // start run
  const startDisabled = await host.isDisabled("#btn-coop-start");
  if (!startDisabled) ok("ui-host-can-start");
  else fail("ui-host-can-start", "start disabled");

  await host.click("#btn-coop-start");
  await sleep(800);

  // skip tutorial if any
  for (const p of [host, client]) {
    const skip = p.locator("#tut-skip");
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
      await sleep(300);
    }
  }

  await shot(host, "04-host-inrun");
  await shot(client, "05-client-inrun");

  const hostHud = await host.evaluate(() => ({
    hudHidden: document.getElementById("hud")?.classList.contains("hidden"),
    menuHidden: document.getElementById("screen-menu")?.classList.contains("hidden"),
    floor: document.getElementById("floor-label")?.textContent,
    kills: document.getElementById("kill-label")?.textContent,
  }));
  const clientHud = await client.evaluate(() => ({
    hudHidden: document.getElementById("hud")?.classList.contains("hidden"),
    menuHidden: document.getElementById("screen-menu")?.classList.contains("hidden"),
    floor: document.getElementById("floor-label")?.textContent,
    kills: document.getElementById("kill-label")?.textContent,
  }));

  if (!hostHud.hudHidden && hostHud.menuHidden) ok("ui-host-in-run", JSON.stringify(hostHud));
  else fail("ui-host-in-run", JSON.stringify(hostHud));
  if (!clientHud.hudHidden && clientHud.menuHidden) ok("ui-client-in-run", JSON.stringify(clientHud));
  else fail("ui-client-in-run", JSON.stringify(clientHud));

  // keep players alive for mid-join checks
  await host.evaluate(() => {
    const g = window.__lumenGame;
    if (g?.player) g.player.inv = 999;
  });
  await client.evaluate(() => {
    const g = window.__lumenGame;
    if (g?.player) g.player.inv = 999;
  });

  // probe live game state
  const probe = async (page) => page.evaluate(() => ({
    hasCanvas: !!document.getElementById("game"),
    hudFloor: document.getElementById("floor-label")?.textContent,
    hudKills: document.getElementById("kill-label")?.textContent,
    pickOpen: !document.getElementById("screen-pick")?.classList.contains("hidden"),
    toast: document.getElementById("toast")?.textContent || "",
    resultHidden: document.getElementById("screen-result")?.classList.contains("hidden"),
    menuHidden: document.getElementById("screen-menu")?.classList.contains("hidden"),
  }));

  // short combat (invuln on)
  const hostBox = await host.locator("#game").boundingBox();
  const clientBox = await client.locator("#game").boundingBox();
  if (!hostBox || !clientBox) {
    fail("canvas-boxes", "missing");
  } else {
    const hcx = hostBox.x + hostBox.width * 0.55;
    const hcy = hostBox.y + hostBox.height * 0.5;
    const ccx = clientBox.x + clientBox.width * 0.55;
    const ccy = clientBox.y + clientBox.height * 0.5;

    await host.mouse.move(hcx + 80, hcy);
    await host.mouse.down();
    await client.mouse.move(ccx - 60, ccy);
    await client.mouse.down();

    for (let i = 0; i < 20; i++) {
      const phase = i / 5;
      await host.keyboard.down(i % 2 ? "KeyD" : "KeyW");
      await client.keyboard.down(i % 2 ? "KeyA" : "KeyS");
      await host.mouse.move(hcx + Math.cos(phase) * 160, hcy + Math.sin(phase) * 100);
      await client.mouse.move(ccx + Math.sin(phase) * 160, ccy + Math.cos(phase) * 100);
      await sleep(100);
      await host.keyboard.up("KeyD");
      await host.keyboard.up("KeyW");
      await client.keyboard.up("KeyA");
      await client.keyboard.up("KeyS");
    }
    await host.mouse.up();
    await client.mouse.up();
  }

  await shot(host, "06-host-combat");
  await shot(client, "07-client-combat");

  const afterHost = await probe(host);
  const afterClient = await probe(client);
  log("after combat host", afterHost);
  log("after combat client", afterClient);

  const fxHost = Number(await host.locator("#game").getAttribute("data-fx")) || 0;
  const fxClient = Number(await client.locator("#game").getAttribute("data-fx")) || 0;
  log("fx counts", { fxHost, fxClient });
  if (fxHost > 0 && fxClient > 0 && Math.abs(fxHost - fxClient) <= Math.max(40, fxHost * 0.55)) {
    ok("client-particles-synced", `host=${fxHost} client=${fxClient}`);
  } else if (fxClient > 0) {
    warn("client-particles-synced", `host=${fxHost} client=${fxClient}`);
  } else {
    fail("client-particles-synced", `host=${fxHost} client=${fxClient}`);
  }

  // kills should progress on host; client HUD should roughly track
  const hostKills = Number(String(afterHost.hudKills || "").replace(/\D/g, "")) || 0;
  const clientKills = Number(String(afterClient.hudKills || "").replace(/\D/g, "")) || 0;
  if (hostKills > 0) ok("host-kills", String(hostKills));
  else warn("host-kills", "0 kills in ~4s (may be unlucky)");
  if (Math.abs(hostKills - clientKills) <= 5 || (hostKills > 0 && clientKills > 0)) {
    ok("client-kills-synced", `host=${hostKills} client=${clientKills}`);
  } else warn("client-kills-synced", `host=${hostKills} client=${clientKills}`);

  // mid-join: inject host pick progress, late peer should enter + catch-up picks
  await host.evaluate(() => {
    const g = window.__lumenGame;
    if (!g) return;
    g.picksTaken = 3;
    if (g.player) g.player.inv = 999;
  });
  const hostAlive = await host.evaluate(() => window.__lumenGame?.state);
  log("host state before late join", hostAlive);
  const late = await prepPage(await browser.newContext(), "late");
  await late.click("#btn-coop");
  await sleep(200);
  await late.fill("#coop-url", WS);
  await late.fill("#coop-code", roomCode);
  await late.fill("#coop-name", "迟到");
  await late.click("#btn-join");
  await late.waitForFunction(() => {
    const hud = document.getElementById("hud");
    return hud && !hud.classList.contains("hidden");
  }, null, { timeout: 10000 }).catch(() => null);
  await sleep(900);

  const lateProbe = await late.evaluate(() => ({
    status: document.getElementById("coop-status")?.textContent,
    hudHidden: document.getElementById("hud")?.classList.contains("hidden"),
    pickOpen: !document.getElementById("screen-pick")?.classList.contains("hidden"),
    toast: document.getElementById("toast")?.textContent || "",
    catchUp: window.__lumenGame?._catchUpJoin,
    pending: window.__lumenGame?.pendingPicks,
    net: window.__lumenGame?.netRole,
    state: window.__lumenGame?.state,
  }));
  const hostAfterLate = await host.evaluate(() => {
    const g = window.__lumenGame;
    const lateRemote = [...(g?.remotes?.values?.() || [])].find((r) => r.name === "迟到" || r._catchUp);
    return {
      state: g?.state,
      playerCount: g?.playerCount,
      remotes: g?.remotes?.size,
      latePickLeft: lateRemote?.pickLeft,
      lateCatchUp: lateRemote?._catchUp,
      lateName: lateRemote?.name,
      hostStillPlaying: g?.state === "playing" || g?.state === "pick",
    };
  });
  log("late join probe", lateProbe);
  log("host after late", hostAfterLate);
  await shot(late, "08b-late-join");

  if (!lateProbe.hudHidden && lateProbe.net === "client") {
    ok("midgame-join-entered", JSON.stringify({ toast: lateProbe.toast, pending: lateProbe.pending, state: lateProbe.state }));
  } else {
    fail("midgame-join-entered", JSON.stringify(lateProbe));
  }
  if (hostAfterLate.hostStillPlaying && (hostAfterLate.remotes | 0) >= 2) {
    ok("midgame-join-host-kept-run", JSON.stringify(hostAfterLate));
  } else {
    fail("midgame-join-host-kept-run", JSON.stringify(hostAfterLate));
  }
  if (lateProbe.pickOpen || (lateProbe.pending | 0) >= 3 || lateProbe.catchUp || (hostAfterLate.latePickLeft | 0) >= 3) {
    ok("midgame-catchup-picks", JSON.stringify({
      pickOpen: lateProbe.pickOpen,
      pending: lateProbe.pending,
      catchUp: lateProbe.catchUp,
      hostLateLeft: hostAfterLate.latePickLeft,
    }));
  } else {
    fail("midgame-catchup-picks", JSON.stringify({ lateProbe, hostAfterLate }));
  }

  if (lateProbe.pickOpen) {
    const card = late.locator("#pick-cards .pick-card").first();
    if (await card.count()) {
      await card.click();
      await sleep(500);
      ok("midgame-catchup-choose-click", "clicked");
    }
  }

  // WAN path: open wan lobby and check auto URL via /relay-info
  const wanPage = await prepPage(await browser.newContext(), "wan");
  await wanPage.click("#btn-wan");
  await sleep(600);
  const wanUrl = await wanPage.inputValue("#coop-url");
  const wanStatus = await wanPage.textContent("#coop-status");
  if (wanUrl.startsWith("ws://") || wanUrl.startsWith("wss://")) ok("wan-url-resolved", wanUrl);
  else fail("wan-url-resolved", `${wanUrl} | ${wanStatus}`);
  await shot(wanPage, "08-wan-lobby");

  // disconnect host mid-run → client should get end/toast
  await hostCtx.close();
  await sleep(1200);
  const clientAfterHostGone = await client.evaluate(() => ({
    status: document.getElementById("coop-status")?.textContent,
    toast: document.getElementById("toast")?.textContent,
    resultHidden: document.getElementById("screen-result")?.classList.contains("hidden"),
    menuHidden: document.getElementById("screen-menu")?.classList.contains("hidden"),
    hudHidden: document.getElementById("hud")?.classList.contains("hidden"),
  }));
  log("client after host gone", clientAfterHostGone);
  if (
    String(clientAfterHostGone.toast || "").includes("主机") ||
    String(clientAfterHostGone.toast || "").includes("中断") ||
    clientAfterHostGone.resultHidden === false ||
    clientAfterHostGone.menuHidden === false
  ) {
    ok("host-disconnect-handled", JSON.stringify(clientAfterHostGone));
  } else {
    fail("host-disconnect-handled", JSON.stringify(clientAfterHostGone));
  }

  await shot(client, "09-after-host-left");

  // collect page errors
  for (const p of [client, wanPage, late]) {
    const meta = p._coopMeta;
    if (!meta) continue;
    if (meta.pageErrors.length) fail(`pageerror-${meta.name}`, meta.pageErrors.slice(0, 3).join(" | "));
    else ok(`no-pageerror-${meta.name}`);
    const interesting = meta.consoleMsgs.filter((m) => !/favicon|404|ERR_CONNECTION/.test(m));
    if (interesting.length) warn(`console-${meta.name}`, interesting.slice(0, 5).join(" | "));
  }

  await clientCtx.close();
  await wanPage.context().close();
  await late.context().close();
}

async function main() {
  const relayChild = await ensureRelay();
  try {
    await testProtocol();
    const browser = await launchBrowser();
    try {
      await testUiCoop(browser);
    } finally {
      await browser.close();
    }
  } finally {
    if (relayChild) {
      relayChild.kill();
      await sleep(300);
    }
  }

  const report = {
    base: BASE,
    ws: WS,
    at: new Date().toISOString(),
    passed: checks.filter((c) => c.pass === true).length,
    failed: checks.filter((c) => c.pass === false).length,
    warnings: checks.filter((c) => c.pass === "warn").length,
    checks,
    findings,
  };
  writeFileSync(join(OUT, "coop-report.json"), JSON.stringify(report, null, 2));
  log("=== SUMMARY ===");
  log(`pass=${report.passed} fail=${report.failed} warn=${report.warnings}`);
  for (const f of findings) log(`[${f.severity}] ${f.name}: ${f.detail}`);
  if (report.failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
