/**
 * 折光织界 · 联机中继（内网 / 外网同一套协议）
 *
 * 用法：
 *   npm run lan          # 仅中继 ws://0.0.0.0:8787
 *   npm run wan          # 中继 + 静态页面（适合公网一台机部署）
 *   import { startRelay } from "./relay.mjs"  # Electron / 程序内启动
 *
 * 环境变量：
 *   LUMENFOLD_PORT=8787
 *   LUMENFOLD_SERVE_STATIC=1|0   （wan 默认 1，lan 默认 0）
 *   LUMENFOLD_PUBLIC_WS=wss://your.domain/   写入 /relay-info 供前端默认填入
 *   LUMENFOLD_ROOT=...          静态资源根目录（打包后由 Electron 传入）
 */
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { networkInterfaces } from "os";
import { createReadStream, existsSync, statSync } from "fs";
import { extname, join, normalize, sep } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..");

const MAX_PLAYERS = 4;
const MAX_MSG_BYTES = 48_000;
const ROOM_IDLE_MS = 30 * 60_000;
/** 主机掉线宽限：期间可用 hostKey 重入，客机先等待不立刻结算 */
const HOST_GRACE_MS = 20_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** @type {import("http").Server | null} */
let httpServer = null;
/** @type {WebSocketServer | null} */
let wss = null;
/** @type {ReturnType<typeof setInterval> | null} */
let idleTimer = null;
/** @type {{ port: number, serveStatic: boolean, publicWs: string, root: string } | null} */
let runtime = null;
const rooms = new Map();

function code() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
  return s;
}

function peerList(room) {
  return [...room.peers.values()].map((p) => ({ id: p.id, name: p.name, role: p.role }));
}

function broadcast(room, msg, exceptId = null) {
  const raw = JSON.stringify(msg);
  if (raw.length > MAX_MSG_BYTES) {
    console.warn(`[relay] drop oversized ${msg.type} (${raw.length} > ${MAX_MSG_BYTES})`);
    return;
  }
  for (const p of room.peers.values()) {
    if (exceptId && p.id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(raw);
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export function localIps() {
  const nets = networkInterfaces();
  const out = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) out.push(n.address);
    }
  }
  // 优先常见局域网段，避免 Windows Hyper-V/WSL 虚拟网卡排在最前
  const rank = (ip) => {
    if (ip.startsWith("192.168.")) return 0;
    if (ip.startsWith("10.")) return 1;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
    return 3;
  };
  out.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return out;
}

function touch(room) {
  room.lastActive = Date.now();
}

function allowRate(player, type, minMs) {
  if (!player._rate) player._rate = Object.create(null);
  const now = Date.now();
  const last = player._rate[type] || 0;
  if (now - last < minMs) return false;
  player._rate[type] = now;
  return true;
}

/** 输入合并：限流期内只保留最新一包，到期再发给主机，避免键位粘滞 */
function queueInput(player, room, forward) {
  player._pendingInput = forward;
  if (player._inputFlush) return;
  const wait = Math.max(0, 20 - (Date.now() - (player._rate?.input || 0)));
  player._inputFlush = setTimeout(() => {
    player._inputFlush = null;
    const msg = player._pendingInput;
    player._pendingInput = null;
    if (!msg || !player.roomCode) return;
    const r = rooms.get(player.roomCode);
    if (!r) return;
    if (!allowRate(player, "input", 20)) {
      queueInput(player, r, msg);
      return;
    }
    const host = r.peers.get(r.hostId);
    if (!host) return;
    if (player.id === r.hostId) broadcast(r, msg, player.id);
    else if (host.ws.readyState === 1) host.ws.send(JSON.stringify(msg));
  }, wait);
}

const ALLOWED = new Set([
  "hello", "join", "snapshot", "start", "pick", "input", "choose", "chat",
  "ping", "pong", "meta", "end", "pause", "resume",
]);

function hostKey() {
  return `hk_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function clearHostGraceTimer(room) {
  if (room?._hostGraceTimer) {
    clearTimeout(room._hostGraceTimer);
    room._hostGraceTimer = null;
  }
}

function clearHostGrace(room) {
  clearHostGraceTimer(room);
  if (room) {
    room.awaitingHost = false;
    room.hostGraceUntil = 0;
  }
}

function closeOrphanRoom(room, code) {
  if (!rooms.has(code) || rooms.get(code) !== room) return;
  if (!room.awaitingHost) return;
  broadcast(room, { type: "error", message: "主机已离开，房间关闭" });
  for (const p of room.peers.values()) {
    p.roomCode = null;
    try { p.ws.close(); } catch { /* */ }
  }
  rooms.delete(code);
}

function safePath(urlPath, root) {
  let p = decodeURIComponent((urlPath || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  p = normalize(p).replace(/^(\.\.[/\\])+/, "");
  const full = join(root, p);
  if (!full.startsWith(root + sep) && full !== root) return null;
  return full;
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res, root) {
  const full = safePath(req.url || "/", root);
  if (!full || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const type = MIME[extname(full)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
  createReadStream(full).pipe(res);
}

function buildInfo() {
  if (!runtime) return null;
  const ips = localIps();
  const { port, publicWs, serveStatic } = runtime;
  return {
    port,
    preferPort: runtime.preferPort ?? port,
    serveStatic,
    publicWs: publicWs || null,
    suggested: publicWs || (ips[0] ? `ws://${ips[0]}:${port}` : `ws://127.0.0.1:${port}`),
    lan: ips.map((ip) => `ws://${ip}:${port}`),
    local: `ws://127.0.0.1:${port}`,
    page: `http://127.0.0.1:${port}/`,
    maxPlayers: MAX_PLAYERS,
    rooms: rooms.size,
  };
}

export function getRelayInfo() {
  return buildInfo();
}

export function isRelayRunning() {
  return !!httpServer && !!runtime;
}

function attachWsHandlers(server) {
  const sock = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

  sock.on("connection", (ws) => {
    const player = {
      id: `p_${Math.random().toString(36).slice(2, 9)}`,
      name: "折客",
      ws,
      role: "client",
      roomCode: null,
      _rate: Object.create(null),
    };

    ws.on("error", (err) => {
      console.warn(`[relay] socket error ${player.id}:`, err?.message || err);
    });

    ws.on("message", (buf) => {
      if (buf.length > MAX_MSG_BYTES) {
        return send(ws, { type: "error", message: "消息过大" });
      }
      let msg;
      try { msg = JSON.parse(String(buf)); }
      catch { return send(ws, { type: "error", message: "坏消息" }); }

      if (!msg || typeof msg.type !== "string" || !ALLOWED.has(msg.type)) {
        return send(ws, { type: "error", message: "未知消息类型" });
      }

      if (msg.type === "hello") {
        if (!allowRate(player, "hello", 500)) return;
        player.name = String(msg.name || "折客").slice(0, 12);
        return;
      }

      if (msg.type === "join") {
        if (!allowRate(player, "join", 800)) return;
        if (player.roomCode) return;

        // 主机宽限期内用 hostKey 重入
        if (msg.reclaim && msg.hostKey) {
          const c = String(msg.roomCode || "").toUpperCase().slice(0, 8);
          const room = rooms.get(c);
          if (!room || !room.awaitingHost) {
            return send(ws, { type: "error", message: "无法重连主机（房间已关闭或未处于等待）" });
          }
          if (room.hostKey !== String(msg.hostKey)) {
            return send(ws, { type: "error", message: "主机密钥无效" });
          }
          clearHostGrace(room);
          player.role = "host";
          player.roomCode = c;
          player.name = String(msg.name || player.name).slice(0, 12);
          room.hostId = player.id;
          room.peers.set(player.id, player);
          touch(room);
          send(ws, {
            type: "joined",
            playerId: player.id,
            role: "host",
            roomCode: c,
            peers: peerList(room),
            hostKey: room.hostKey,
            reclaimed: true,
          });
          broadcast(room, { type: "host_back", peers: peerList(room), playerId: player.id }, player.id);
          return;
        }

        if (msg.create) {
          let c = code();
          while (rooms.has(c)) c = code();
          player.role = "host";
          player.roomCode = c;
          const hk = hostKey();
          const room = {
            hostId: player.id,
            peers: new Map([[player.id, player]]),
            lastActive: Date.now(),
            hostKey: hk,
            awaitingHost: false,
            hostGraceUntil: 0,
            _hostGraceTimer: null,
          };
          rooms.set(c, room);
          send(ws, {
            type: "joined",
            playerId: player.id,
            role: "host",
            roomCode: c,
            peers: peerList(room),
            hostKey: hk,
          });
          return;
        }
        const c = String(msg.roomCode || "").toUpperCase().slice(0, 8);
        const room = rooms.get(c);
        if (!room) return send(ws, { type: "error", message: "房间不存在" });
        if (room.awaitingHost) {
          return send(ws, { type: "error", message: "主机短暂离线，请稍后再加入" });
        }
        if (room.peers.size >= MAX_PLAYERS) return send(ws, { type: "error", message: "房间已满" });
        player.role = "client";
        player.roomCode = c;
        player.name = String(msg.name || player.name).slice(0, 12);
        room.peers.set(player.id, player);
        touch(room);
        send(ws, { type: "joined", playerId: player.id, role: "client", roomCode: c, peers: peerList(room) });
        broadcast(room, { type: "peer_join", peers: peerList(room), player: { id: player.id, name: player.name } });
        return;
      }

      const room = player.roomCode ? rooms.get(player.roomCode) : null;
      if (!room) return;
      touch(room);

      if (msg.type === "snapshot" || msg.type === "start" || msg.type === "pick" || msg.type === "end"
        || msg.type === "pause" || msg.type === "resume") {
        if (player.id !== room.hostId) {
          return send(ws, { type: "error", message: "仅主机可下发权威状态" });
        }
        if (room.awaitingHost) return;
        const minMs = msg.type === "snapshot" ? 45
          : msg.type === "end" ? 500
            : msg.type === "pause" || msg.type === "resume" ? 120
              : 200;
        if (!allowRate(player, msg.type, minMs)) return;
        broadcast(room, msg, player.id);
        return;
      }

      if (msg.type === "input" || msg.type === "choose" || msg.type === "chat") {
        const host = room.peers.get(room.hostId);
        if (!host) return;
        const forward = { ...msg, from: player.id, name: player.name };
        if (typeof forward.text === "string") forward.text = forward.text.slice(0, 120);
        if (msg.type === "input") {
          if (allowRate(player, "input", 20)) {
            if (player.id === room.hostId) broadcast(room, forward, player.id);
            else send(host.ws, forward);
          } else {
            queueInput(player, room, forward);
          }
          return;
        }
        if (msg.type === "choose") {
          if (allowRate(player, "choose", 40)) {
            if (player.id === room.hostId) broadcast(room, forward, player.id);
            else send(host.ws, forward);
          } else {
            player._pendingChoose = forward;
            if (!player._chooseFlush) {
              player._chooseFlush = setTimeout(() => {
                player._chooseFlush = null;
                const m = player._pendingChoose;
                player._pendingChoose = null;
                if (!m || !player.roomCode) return;
                const r = rooms.get(player.roomCode);
                if (!r) return;
                if (!allowRate(player, "choose", 40)) return;
                const h = r.peers.get(r.hostId);
                if (!h) return;
                if (player.id === r.hostId) broadcast(r, m, player.id);
                else if (h.ws.readyState === 1) h.ws.send(JSON.stringify(m));
              }, 45);
            }
          }
          return;
        }
        // chat：全员可见
        if (!allowRate(player, "chat", 200)) return;
        broadcast(room, forward, player.id);
        return;
      }

      if (msg.type === "ping") {
        if (!allowRate(player, "ping", 200)) return;
        send(ws, { type: "pong", t: msg.t });
        return;
      }

      if (msg.type === "meta") {
        if (!allowRate(player, "meta", 300)) return;
        broadcast(room, {
          type: "meta",
          from: player.id,
          name: player.name,
          meta: msg.meta,
        }, null);
        return;
      }

      if (msg.type === "pong") return;
    });

    ws.on("close", () => {
      if (player._inputFlush) {
        clearTimeout(player._inputFlush);
        player._inputFlush = null;
      }
      if (player._chooseFlush) {
        clearTimeout(player._chooseFlush);
        player._chooseFlush = null;
      }
      player._pendingInput = null;
      player._pendingChoose = null;
      const roomCode = player.roomCode;
      const room = roomCode ? rooms.get(roomCode) : null;
      if (!room) return;
      room.peers.delete(player.id);
      if (player.id === room.hostId) {
        // 宽限：客机等待，主机可用 hostKey 重入
        if (room.peers.size === 0) {
          clearHostGrace(room);
          rooms.delete(roomCode);
          return;
        }
        clearHostGraceTimer(room);
        room.awaitingHost = true;
        room.hostGraceUntil = Date.now() + HOST_GRACE_MS;
        room._hostGraceTimer = setTimeout(() => closeOrphanRoom(room, roomCode), HOST_GRACE_MS);
        broadcast(room, {
          type: "host_away",
          graceMs: HOST_GRACE_MS,
          roomCode,
          message: "主机短暂离线，正在等待重连…",
        });
        return;
      }
      broadcast(room, { type: "peer_left", peers: peerList(room), playerId: player.id });
      if (room.peers.size === 0) {
        clearHostGrace(room);
        rooms.delete(roomCode);
      }
    });
  });

  return sock;
}

function tryListen(server, port, host = "0.0.0.0") {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListen);
      reject(err);
    };
    const onListen = () => {
      server.off("error", onError);
      resolve(port);
    };
    server.once("error", onError);
    server.once("listening", onListen);
    server.listen(port, host);
  });
}

/**
 * @param {{
 *   port?: number,
 *   serveStatic?: boolean,
 *   publicWs?: string,
 *   root?: string,
 *   fallbackPorts?: number[],
 * }} [opts]
 */
export async function startRelay(opts = {}) {
  if (httpServer && runtime) return buildInfo();

  const preferPort = opts.port ?? Number(process.env.LUMENFOLD_PORT || 8787);
  const serveStaticFlag = opts.serveStatic ?? (String(process.env.LUMENFOLD_SERVE_STATIC ?? "0") !== "0");
  const publicWs = opts.publicWs ?? process.env.LUMENFOLD_PUBLIC_WS ?? "";
  const root = opts.root || process.env.LUMENFOLD_ROOT || DEFAULT_ROOT;
  const candidates = [
    preferPort,
    ...(opts.fallbackPorts || [8788, 8789, 8790, 8791]),
  ].filter((p, i, arr) => Number.isFinite(p) && p > 0 && arr.indexOf(p) === i);

  const server = createServer((req, res) => {
    const url = req.url || "/";
    const info = buildInfo();

    if (url.startsWith("/health")) {
      return sendJson(res, 200, {
        ok: true,
        rooms: rooms.size,
        service: "lumenfold-relay",
        serveStatic: runtime?.serveStatic ?? false,
        players: [...rooms.values()].reduce((n, r) => n + r.peers.size, 0),
      });
    }

    if (url.startsWith("/relay-info")) {
      return sendJson(res, 200, info || {
        port: preferPort,
        publicWs: publicWs || null,
        suggested: publicWs || `ws://127.0.0.1:${preferPort}`,
        lan: localIps().map((ip) => `ws://${ip}:${preferPort}`),
        local: `ws://127.0.0.1:${preferPort}`,
        maxPlayers: MAX_PLAYERS,
      });
    }

    if (url.startsWith("/rooms")) {
      const list = [...rooms.entries()].map(([c, r]) => ({
        code: c,
        players: r.peers.size,
        host: [...r.peers.values()].find((p) => p.id === r.hostId)?.name || "?",
      }));
      return sendJson(res, 200, { rooms: list });
    }

    if (runtime?.serveStatic) return serveStatic(req, res, root);

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("折光织界联机中继运行中。游戏内填写本机 ws/wss 地址即可。\n");
  });

  let boundPort = null;
  let lastErr = null;
  for (const port of candidates) {
    try {
      boundPort = await tryListen(server, port);
      break;
    } catch (err) {
      lastErr = err;
      if (err?.code !== "EADDRINUSE") {
        try { server.close(); } catch { /* */ }
        throw err;
      }
    }
  }
  if (boundPort == null) {
    try { server.close(); } catch { /* */ }
    throw lastErr || new Error("无法绑定中继端口");
  }

  runtime = {
    port: boundPort,
    preferPort: preferPort,
    serveStatic: serveStaticFlag,
    publicWs,
    root,
  };
  httpServer = server;
  wss = attachWsHandlers(server);

  idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [c, room] of rooms) {
      if (now - (room.lastActive || 0) > ROOM_IDLE_MS) {
        for (const p of room.peers.values()) {
          try { p.ws.close(); } catch { /* */ }
        }
        rooms.delete(c);
      }
    }
  }, 60_000);

  const info = buildInfo();
  console.log(`折光织界联机中继 :${boundPort}  static=${serveStaticFlag ? "on" : "off"}`);
  console.log(`本机页面: http://127.0.0.1:${boundPort}/`);
  console.log(`本机中继: ws://127.0.0.1:${boundPort}`);
  for (const ip of localIps()) {
    console.log(`局域网页: http://${ip}:${boundPort}/`);
    console.log(`局域网继: ws://${ip}:${boundPort}`);
  }
  if (publicWs) console.log(`公网 WS: ${publicWs}`);
  console.log("健康检查: /health   中继信息: /relay-info");
  return info;
}

export async function stopRelay() {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
  for (const room of rooms.values()) {
    for (const p of room.peers.values()) {
      try { p.ws.close(); } catch { /* */ }
    }
  }
  rooms.clear();
  if (wss) {
    await new Promise((resolve) => wss.close(() => resolve()));
    wss = null;
  }
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(() => resolve()));
    httpServer = null;
  }
  runtime = null;
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  await startRelay();
}
