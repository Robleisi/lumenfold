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
  ERROR: "error",
  PING: "ping",
  PONG: "pong",
  WAN_RESERVE: "wan_reserve",
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
