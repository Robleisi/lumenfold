import { NET, encode, decode, MAX_PLAYERS } from "./protocol.js";

/**
 * 会话抽象：
 * - LocalSession：单机
 * - LanSession：连内网中继，主机权威
 * - WanSession：外网预留（同协议，换 endpoint）
 */
export class LocalSession {
  constructor() {
    this.mode = "local";
    this.role = "solo";
    this.playerId = "local";
    this.peers = [];
    this.roomCode = null;
    this.connected = true;
  }
  async connect() { return this; }
  async createRoom() { return { code: null }; }
  async joinRoom() { throw new Error("单机模式无需加入房间"); }
  send() {}
  on() {}
  close() {}
  get playerCount() { return 1; }
}

export class LanSession {
  /**
   * @param {{ url: string, name?: string, onEvent?: Function }} opts
   */
  constructor(opts) {
    this.mode = "lan";
    this.url = opts.url;
    this.name = opts.name || "折客";
    this.onEvent = opts.onEvent || (() => {});
    this.role = "client";
    this.playerId = null;
    this.roomCode = null;
    this.peers = [];
    this.connected = false;
    this.ws = null;
    this._handlers = new Map();
  }

  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this._handlers.get(type)?.delete(fn);
  }

  emit(type, data) {
    this.onEvent(type, data);
    const set = this._handlers.get(type);
    if (set) for (const fn of set) fn(data);
  }

  get playerCount() {
    return Math.max(1, this.peers.length);
  }

  async connect() {
    if (this.ws && this.connected) return this;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error("连接超时，请确认内网中继已启动")), 5000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.connected = true;
        this.send({ type: NET.HELLO, name: this.name, client: "lumenfold", proto: 1 });
        resolve(this);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("无法连接内网中继"));
      };
      ws.onclose = () => {
        this.connected = false;
        this.emit("close", {});
      };
      ws.onmessage = (ev) => {
        const msg = decode(ev.data);
        if (!msg) return;
        this._handle(msg);
      };
    });
    return this;
  }

  _handle(msg) {
    if (msg.type === NET.JOINED) {
      this.playerId = msg.playerId;
      this.role = msg.role;
      this.roomCode = msg.roomCode;
      this.peers = msg.peers || [];
    }
    if (msg.type === NET.PEER_JOIN || msg.type === NET.PEER_LEFT || msg.type === NET.ROOM) {
      if (msg.peers) this.peers = msg.peers;
    }
    if (msg.type === NET.PING) {
      this.send({ type: NET.PONG, t: msg.t });
    }
    this.emit(msg.type, msg);
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(encode(msg));
  }

  async createRoom() {
    await this.connect();
    return new Promise((resolve, reject) => {
      const off = this.on(NET.JOINED, (msg) => {
        off();
        resolve({ code: msg.roomCode, role: msg.role });
      });
      const offErr = this.on(NET.ERROR, (msg) => {
        off(); offErr();
        reject(new Error(msg.message || "建房失败"));
      });
      this.send({ type: NET.JOIN, create: true, name: this.name });
    });
  }

  async joinRoom(code) {
    await this.connect();
    return new Promise((resolve, reject) => {
      const off = this.on(NET.JOINED, (msg) => {
        off(); offErr();
        resolve({ code: msg.roomCode, role: msg.role });
      });
      const offErr = this.on(NET.ERROR, (msg) => {
        off(); offErr();
        reject(new Error(msg.message || "加入失败"));
      });
      this.send({ type: NET.JOIN, roomCode: String(code).toUpperCase(), name: this.name });
    });
  }

  startGame(seed) {
    this.send({ type: NET.START, seed });
  }

  sendInput(input) {
    this.send({ type: NET.INPUT, input, t: performance.now() });
  }

  sendSnapshot(snap) {
    if (this.role !== "host") return;
    this.send({ type: NET.SNAPSHOT, snap });
  }

  sendChoose(foldId) {
    this.send({ type: NET.CHOOSE, foldId });
  }

  close() {
    try { this.ws?.close(); } catch { /* */ }
    this.connected = false;
  }
}

/** 外网预留：协议同 LanSession，仅 endpoint / 鉴权不同 */
export class WanSession extends LanSession {
  constructor(opts) {
    super(opts);
    this.mode = "wan";
  }

  async connect() {
    // 预留：未来在此加账号 token、TLS、匹配服
    this.emit(NET.WAN_RESERVE, {
      message: "外网联机接口已预留。当前请使用内网中继，或等待正式匹配服。",
    });
    if (!this.url || this.url.includes("example.invalid")) {
      throw new Error("外网联机尚未开放（接口已预留）");
    }
    return super.connect();
  }
}

export function defaultLanUrl() {
  const host = location.hostname || "127.0.0.1";
  const port = 8787;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // 页面若在 https，需另配 wss；本地开发用 ws
  if (location.protocol === "https:") return `${proto}://${host}:${port}`;
  return `ws://${host === "localhost" || host === "127.0.0.1" ? "127.0.0.1" : host}:${port}`;
}

export { MAX_PLAYERS };
