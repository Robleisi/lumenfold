/** 网络协议：内网可用，外网接口预留同一套消息 */

export const NET = {
  HELLO: "hello",
  JOIN: "join",
  JOINED: "joined",
  ROOM: "room",
  PEER_JOIN: "peer_join",
  PEER_LEFT: "peer_left",
  START: "start",
  INPUT: "input",
  SNAPSHOT: "snapshot",
  PICK: "pick",
  CHOOSE: "choose",
  CHAT: "chat",
  META: "meta",
  ERROR: "error",
  PING: "ping",
  PONG: "pong",
  END: "end",
  WAN_RESERVE: "wan_reserve",
  /** 主机短暂掉线，房间进入宽限期 */
  HOST_AWAY: "host_away",
  /** 主机在宽限期内重入 */
  HOST_BACK: "host_back",
  /** 主机广播暂停/继续（权威） */
  PAUSE: "pause",
  RESUME: "resume",
};

export const MAX_PLAYERS = 4;

export function encode(msg) {
  return JSON.stringify(msg);
}

export function decode(raw) {
  try { return JSON.parse(raw); }
  catch { return null; }
}

/** 难度随人数放大：人海更多，单体仍偏脆（割草向） */
export function scaleForPlayers(playerCount) {
  const n = Math.max(1, Math.min(MAX_PLAYERS, playerCount | 0));
  return {
    players: n,
    enemyCountMul: 1 + (n - 1) * 0.55,
    enemyHpMul: 1 + (n - 1) * 0.22,
    enemyDmgMul: 1 + (n - 1) * 0.12,
    spawnRateMul: 1 + (n - 1) * 0.4,
    eliteChanceMul: Math.max(0.35, 1 - (n - 1) * 0.15),
  };
}

/**
 * 折印：局外战力摘要（解锁 + 履历）
 * 联机用它做强弱平衡，便于老带新。
 */
export function computeFoldSeal(save) {
  if (!save) return 10;
  const u = save.unlocked || {};
  let s = 12;
  s += Object.keys(u).length * 2.5;
  s += Math.min(36, (save.bestFloor | 0) * 3.5);
  s += Math.min(18, Math.floor((save.totalRuns | 0) * 0.45));
  s += Math.min(14, Math.floor((save.dust | 0) / 90));
  if (u.starting_twin) s += 4;
  if (u.phoenix_fold) s += 6;
  if (u.deep_pages) s += 7;
  if (u.void_seam) s += 5;
  if (u.boss_final) s += 9;
  if (u.biome_night) s += 5;
  return Math.max(8, Math.round(s));
}

/** 从存档抽出联机用的个人进度包 */
export function buildPeerMeta(save, name = "折客") {
  const unlocked = { ...(save?.unlocked || {}) };
  return {
    name: String(name || "折客").slice(0, 12),
    seal: computeFoldSeal(save),
    unlocked,
    bestFloor: save?.bestFloor | 0,
    totalRuns: save?.totalRuns | 0,
  };
}

/**
 * 相对主机折印的平衡：
 * - 客机更强 → 只削攻击（越多削越多，上限约 28%）
 * - 客机更弱 → 加生命 + 减伤（不抬攻击），便于被带飞
 */
export function sealBalance(guestSeal, hostSeal) {
  const host = Math.max(1, hostSeal | 0);
  const guest = Math.max(0, guestSeal | 0);
  const delta = (guest - host) / host;

  let atkMul = 1;
  let hpMul = 1;
  let dmgTakenMul = 1;

  if (delta > 0.02) {
    const nerf = Math.min(0.28, delta * 0.42);
    atkMul = 1 - nerf;
  } else if (delta < -0.02) {
    const deficit = -delta;
    hpMul = 1 + Math.min(0.35, deficit * 0.5);
    dmgTakenMul = 1 - Math.min(0.22, deficit * 0.36);
  }

  return {
    atkMul: +atkMul.toFixed(3),
    hpMul: +hpMul.toFixed(3),
    dmgTakenMul: +dmgTakenMul.toFixed(3),
    seal: guest,
    hostSeal: host,
    delta: +delta.toFixed(3),
  };
}
