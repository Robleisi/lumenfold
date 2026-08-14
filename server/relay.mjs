/**
 * 折光织界 · 联机中继（内网 / 外网同一套协议）
 *
 * 用法：
 *   npm run lan          # 仅中继 ws://0.0.0.0:8787
 *   npm run wan          # 中继 + 静态页面（适合公网一台机部署）
 *
 * 环境变量：
 *   LUMENFOLD_PORT=8787
 *   LUMENFOLD_SERVE_STATIC=1|0   （wan 默认 1，lan 默认 0）
 *   LUMENFOLD_PUBLIC_WS=wss://your.domain/   写入 /relay-info 供前端默认填入
 */
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { networkInterfaces } from "os";
import { createReadStream, existsSync, statSync } from "fs";
import { extname, join, normalize, sep } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const PORT = Number(process.env.LUMENFOLD_PORT || 8787);
const SERVE_STATIC = String(process.env.LUMENFOLD_SERVE_STATIC ?? "0") !== "0";
const PUBLIC_WS = process.env.LUMENFOLD_PUBLIC_WS || "";
const MAX_PLAYERS = 4;
const MAX_MSG_BYTES = 48_000;
const ROOM_IDLE_MS = 30 * 60_000;

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

function localIps() {
  const nets = networkInterfaces();
  const out = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) out.push(n.address);
    }
  }
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
      // 仍在冷却则再挂一次
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
  "hello", "join", "snapshot", "start", "pick", "input", "choose", "chat", "ping", "pong", "meta", "end",
]);

function safePath(urlPath) {
  let p = decodeURIComponent((urlPath || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  p = normalize(p).replace(/^(\.\.[/\\])+/, "");
  const full = join(ROOT, p);
  if (!full.startsWith(ROOT + sep) && full !== ROOT) return null;
  return full;
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res) {
  const full = safePath(req.url || "/");
  if (!full || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const type = MIME[extname(full)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
  createReadStream(full).pipe(res);
}

const httpServer = createServer((req, res) => {
  const url = req.url || "/";

  if (url.startsWith("/health")) {
    return sendJson(res, 200, {
      ok: true,
      rooms: rooms.size,
      service: "lumenfold-relay",
      serveStatic: SERVE_STATIC,
      players: [...rooms.values()].reduce((n, r) => n + r.peers.size, 0),
    });
  }

  if (url.startsWith("/relay-info")) {
    const ips = localIps();
    return sendJson(res, 200, {
      port: PORT,
      publicWs: PUBLIC_WS || null,
      suggested: PUBLIC_WS || (ips[0] ? `ws://${ips[0]}:${PORT}` : `ws://127.0.0.1:${PORT}`),
      lan: ips.map((ip) => `ws://${ip}:${PORT}`),
      local: `ws://127.0.0.1:${PORT}`,
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

  if (SERVE_STATIC) return serveStatic(req, res);

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("折光织界联机中继运行中。游戏内填写本机 ws/wss 地址即可。\n");
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MSG_BYTES });

wss.on("connection", (ws) => {
  const player = {
    id: `p_${Math.random().toString(36).slice(2, 9)}`,
    name: "折客",
    ws,
    role: "client",
    roomCode: null,
    _rate: Object.create(null),
  };

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
      if (msg.create) {
        let c = code();
        while (rooms.has(c)) c = code();
        player.role = "host";
        player.roomCode = c;
        const room = { hostId: player.id, peers: new Map([[player.id, player]]), lastActive: Date.now() };
        rooms.set(c, room);
        send(ws, { type: "joined", playerId: player.id, role: "host", roomCode: c, peers: peerList(room) });
        return;
      }
      const c = String(msg.roomCode || "").toUpperCase().slice(0, 8);
      const room = rooms.get(c);
      if (!room) return send(ws, { type: "error", message: "房间不存在" });
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

    if (msg.type === "snapshot" || msg.type === "start" || msg.type === "pick" || msg.type === "end") {
      if (player.id !== room.hostId) {
        return send(ws, { type: "error", message: "仅主机可下发权威状态" });
      }
      const minMs = msg.type === "snapshot" ? 40 : msg.type === "end" ? 500 : 200;
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
      // choose 要允许连点多选，限流放宽；失败则短延迟重发最新
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
      if (!allowRate(player, msg.type, 120)) return;
      if (player.id === room.hostId) {
        broadcast(room, forward, player.id);
      } else {
        send(host.ws, forward);
      }
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
    const room = player.roomCode ? rooms.get(player.roomCode) : null;
    if (!room) return;
    room.peers.delete(player.id);
    if (player.id === room.hostId) {
      broadcast(room, { type: "error", message: "主机已离开，房间关闭" });
      for (const p of room.peers.values()) {
        p.roomCode = null;
        try { p.ws.close(); } catch { /* */ }
      }
      rooms.delete(player.roomCode);
      return;
    }
    broadcast(room, { type: "peer_left", peers: peerList(room), playerId: player.id });
    if (room.peers.size === 0) rooms.delete(player.roomCode);
  });
});

setInterval(() => {
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

httpServer.listen(PORT, "0.0.0.0", () => {
  const ips = localIps();
  console.log(`折光织界联机中继 :${PORT}  static=${SERVE_STATIC ? "on" : "off"}`);
  console.log(`本机页面: http://127.0.0.1:${PORT}/`);
  console.log(`本机中继: ws://127.0.0.1:${PORT}`);
  for (const ip of ips) {
    console.log(`局域网页: http://${ip}:${PORT}/`);
    console.log(`局域网继: ws://${ip}:${PORT}`);
  }
  if (PUBLIC_WS) console.log(`公网 WS: ${PUBLIC_WS}`);
  console.log("健康检查: /health   中继信息: /relay-info");
});
