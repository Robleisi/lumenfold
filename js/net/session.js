import { NET, encode, decode, MAX_PLAYERS } from "./protocol.js";
import { defaultLanUrl, resolveWanUrl, saveWanUrl } from "./config.js";

/**
 * 会话抽象：
 * - LocalSession：单机
 * - LanSession：内网中继
 * - WanSession：外网（同协议，更长超时 + 心跳）
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
   * @param {{ url: string, name?: string, onEvent?: Function, connectTimeoutMs?: number }} opts
   */
  constructor(opts) {
    this.mode = "lan";
    this.url = opts.url;
    this.name = opts.name || "折客";
    this.onEvent = opts.onEvent || (() => {});
    this.connectTimeoutMs = opts.connectTimeoutMs || 5000;
    this.role = "client";
    this.playerId = null;
    this.roomCode = null;
    this.peers = [];
    this.connected = false;
    this.ws = null;
    this._handlers = new Map();
    this._pingTimer = null;
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
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* */ }
        reject(new Error(this.mode === "wan"
          ? "外网中继连接超时，请检查地址 / 防火墙 / 是否已部署"
          : "连接超时，请确认中继已启动（npm run lan / npm run wan）"));
      }, this.connectTimeoutMs);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        this.send({ type: NET.HELLO, name: this.name, client: "lumenfold", proto: 1, mode: this.mode });
        this._startHeartbeat();
        resolve(this);
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(this.mode === "wan" ? "无法连接外网中继" : "无法连接内网中继"));
      };
      ws.onclose = () => {
        this.connected = false;
        this._stopHeartbeat();
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

  _startHeartbeat() {
    this._stopHeartbeat();
    this._pingTimer = setInterval(() => {
      if (!this.connected) return;
      this.send({ type: NET.PING, t: Date.now() });
    }, 12000);
  }

  _stopHeartbeat() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
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
        off(); offErr();
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

  startGame(seed, extra = {}) {
    this.send({ type: NET.START, seed, ...extra });
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

  sendMeta(meta) {
    this.send({ type: NET.META, meta });
  }

  sendEnd(payload) {
    if (this.role !== "host") return;
    this.send({ type: NET.END, ...payload });
  }

  close() {
    this._stopHeartbeat();
    try { this.ws?.close(); } catch { /* */ }
    this.connected = false;
  }
}

/** 外网：同协议；默认解析公网 / 同域中继 */
export class WanSession extends LanSession {
  constructor(opts) {
    super({ ...opts, connectTimeoutMs: opts.connectTimeoutMs || 12000 });
    this.mode = "wan";
  }

  async connect() {
    if (!this.url) {
      this.url = await resolveWanUrl();
    }
    if (!this.url || this.url.includes("example.invalid")) {
      throw new Error("请填写有效的外网中继地址（wss://…）");
    }
    // https 页面禁止连 ws://
    if (location.protocol === "https:" && this.url.startsWith("ws://")) {
      throw new Error("当前是 HTTPS 页面，外网中继必须使用 wss://（带 TLS）");
    }
    saveWanUrl(this.url);
    return super.connect();
  }
}

export { defaultLanUrl, resolveWanUrl, saveWanUrl, MAX_PLAYERS };
