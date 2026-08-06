/**
 * 折光织界 · 内网中继（主机权威，中继只转发 + 房间管理）
 * 用法：node server/lan-relay.mjs
 * 默认 ws://0.0.0.0:8787
 */
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { networkInterfaces } from "os";

const PORT = Number(process.env.LUMENFOLD_PORT || 8787);
const MAX_PLAYERS = 4;

const rooms = new Map(); // code -> { hostId, peers: Map(id, {id,name,ws,role}) }

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

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, service: "lumenfold-lan-relay" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("折光织界内网中继运行中。请用游戏内「内网联机」连接。\n");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const player = {
    id: `p_${Math.random().toString(36).slice(2, 9)}`,
    name: "折客",
    ws,
    role: "client",
    roomCode: null,
  };

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(String(buf)); }
    catch { return send(ws, { type: "error", message: "坏消息" }); }

    if (msg.type === "hello") {
      player.name = String(msg.name || "折客").slice(0, 12);
      return;
    }

    if (msg.type === "join") {
      if (player.roomCode) return;
      if (msg.create) {
        let c = code();
        while (rooms.has(c)) c = code();
        player.role = "host";
        player.roomCode = c;
        const room = { hostId: player.id, peers: new Map([[player.id, player]]) };
        rooms.set(c, room);
        send(ws, { type: "joined", playerId: player.id, role: "host", roomCode: c, peers: peerList(room) });
        return;
      }
      const c = String(msg.roomCode || "").toUpperCase();
      const room = rooms.get(c);
      if (!room) return send(ws, { type: "error", message: "房间不存在" });
      if (room.peers.size >= MAX_PLAYERS) return send(ws, { type: "error", message: "房间已满" });
      player.role = "client";
      player.roomCode = c;
      player.name = String(msg.name || player.name).slice(0, 12);
      room.peers.set(player.id, player);
      send(ws, { type: "joined", playerId: player.id, role: "client", roomCode: c, peers: peerList(room) });
      broadcast(room, { type: "peer_join", peers: peerList(room), player: { id: player.id, name: player.name } });
      return;
    }

    const room = player.roomCode ? rooms.get(player.roomCode) : null;
    if (!room) return;

    // 主机权威：只有 host 的 snapshot/start/pick 广播；客户端 input/choose 转给 host
    if (msg.type === "snapshot" || msg.type === "start" || msg.type === "pick") {
      if (player.id !== room.hostId) {
        return send(ws, { type: "error", message: "仅主机可下发权威状态" });
      }
      broadcast(room, msg, player.id);
      return;
    }

    if (msg.type === "input" || msg.type === "choose" || msg.type === "chat") {
      const host = room.peers.get(room.hostId);
      if (!host) return;
      const forward = { ...msg, from: player.id, name: player.name };
      if (player.id === room.hostId) {
        // host 自己的 input 也回给自己逻辑层（本机已处理），只转给他人若需要
        broadcast(room, forward, player.id);
      } else {
        send(host.ws, forward);
      }
      return;
    }

    if (msg.type === "ping") {
      send(ws, { type: "pong", t: msg.t });
    }
  });

  ws.on("close", () => {
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

httpServer.listen(PORT, "0.0.0.0", () => {
  const ips = localIps();
  console.log(`折光织界内网中继已启动 :${PORT}`);
  console.log(`本机: ws://127.0.0.1:${PORT}`);
  for (const ip of ips) console.log(`局域网: ws://${ip}:${PORT}`);
});
