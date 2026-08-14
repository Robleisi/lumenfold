/** 存档完整性：设备盐 + HMAC，防本地误改（单机软防护，非权威防作弊） */

const SAVE_KEY = "lumenfold_save_v2";
const LEGACY_KEY = "lumenfold_save_v1";
const DEVICE_KEY = "lumenfold_device_v1";
const AUDIT_KEY = "lumenfold_audit_v1";

/** 混淆盐：仅提高篡改成本，真正权威在联机主机/未来外网服 */
const APP_PEPPER = "Lumenfold·折光织界·v2·纸页不可私改";

const defaultSave = () => ({
  v: 2,
  dust: 0,
  totalRuns: 0,
  bestFloor: 0,
  totalKills: 0,
  unlocked: {},
  seen: { folds: {}, enemies: {}, biomes: {}, synergies: {}, bosses: {} },
  discoveredSynergies: {},
  tutorialDone: false,
  tutorialStep: 0,
  lastDustGrant: 0,
  lastWriteAt: 0,
  nonce: 0,
});

function canonical(obj) {
  const { sig, ...rest } = obj;
  return JSON.stringify(sortKeys(rest));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

async function getDeviceSecret() {
  let raw = localStorage.getItem(DEVICE_KEY);
  if (!raw) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    raw = btoa(String.fromCharCode(...bytes));
    localStorage.setItem(DEVICE_KEY, raw);
  }
  return raw;
}

async function hmacHex(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret + "|" + APP_PEPPER),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function audit(event, detail = {}) {
  try {
    const list = JSON.parse(localStorage.getItem(AUDIT_KEY) || "[]");
    list.push({ t: Date.now(), event, ...detail });
    while (list.length > 40) list.shift();
    localStorage.setItem(AUDIT_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

function clampSaveNumbers(save) {
  save.dust = Math.max(0, Math.min(500000, save.dust | 0));
  save.totalRuns = Math.max(0, Math.min(100000, save.totalRuns | 0));
  save.bestFloor = Math.max(0, Math.min(99, save.bestFloor | 0));
  save.totalKills = Math.max(0, Math.min(50_000_000, save.totalKills | 0));
  save.nonce = Math.max(0, save.nonce | 0);
  if (typeof save.unlocked !== "object" || !save.unlocked) save.unlocked = {};
  const keys = Object.keys(save.unlocked);
  if (keys.length > 80) {
    const trimmed = {};
    for (const k of keys.slice(0, 80)) trimmed[k] = true;
    save.unlocked = trimmed;
  }
  return save;
}

function mergeSeen(dataSeen) {
  const base = defaultSave().seen;
  const src = dataSeen || {};
  return {
    folds: { ...base.folds, ...(src.folds || {}) },
    enemies: { ...base.enemies, ...(src.enemies || {}) },
    biomes: { ...base.biomes, ...(src.biomes || {}) },
    synergies: { ...base.synergies, ...(src.synergies || {}) },
    bosses: { ...base.bosses, ...(src.bosses || {}) },
  };
}

function mergeLoaded(data) {
  const base = defaultSave();
  return clampSaveNumbers({
    ...base,
    ...data,
    unlocked: data.unlocked || {},
    seen: mergeSeen(data.seen),
    discoveredSynergies: data.discoveredSynergies || {},
  });
}

export async function loadSave() {
  try {
    let raw = localStorage.getItem(SAVE_KEY);
    if (!raw) {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const data = mergeLoaded(JSON.parse(legacy));
        await writeSave(data);
        localStorage.removeItem(LEGACY_KEY);
        audit("migrate_v1");
        return data;
      }
      return defaultSave();
    }
    const parsed = JSON.parse(raw);
    const secret = await getDeviceSecret();
    const expect = await hmacHex(canonical(parsed), secret);
    if (!parsed.sig || parsed.sig !== expect) {
      audit("tamper_detected", { reason: "bad_sig" });
      localStorage.removeItem(SAVE_KEY);
      const fresh = defaultSave();
      await writeSave(fresh);
      return { ...fresh, _tampered: true };
    }
    const save = mergeLoaded(parsed);
    if (save.lastWriteAt && Date.now() + 60_000 < save.lastWriteAt) {
      audit("clock_rollback");
    }
    return save;
  } catch (e) {
    audit("load_error", { message: String(e) });
    return defaultSave();
  }
}

export async function writeSave(save) {
  const data = clampSaveNumbers({ ...save });
  delete data._tampered;
  data.lastWriteAt = Date.now();
  data.nonce = (data.nonce | 0) + 1;
  const secret = await getDeviceSecret();
  const payload = { ...data };
  delete payload.sig;
  payload.sig = await hmacHex(canonical(payload), secret);
  localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
  Object.assign(save, payload);
}

/** 局内尘只能通过受控接口增加，带软上限（可被改客户端绕过，属单机软防） */
export async function grantDust(save, amount, reason = "run") {
  const n = Math.max(0, Math.min(500, Math.round(amount)));
  const now = Date.now();
  if (save.lastDustGrant && now - save.lastDustGrant < 400 && n > 80) {
    audit("dust_rate_limit", { reason, n });
    return 0;
  }
  save.dust += n;
  save.lastDustGrant = now;
  await writeSave(save);
  return n;
}

export async function unlock(save, id, knownIds) {
  if (knownIds && !knownIds.has(id)) {
    audit("unlock_reject", { id });
    return false;
  }
  save.unlocked[id] = true;
  await writeSave(save);
  return true;
}

/** 扣尘 + 解锁同一落盘，避免只扣尘未解锁 */
export async function purchaseUnlock(save, id, cost, knownIds) {
  if (knownIds && !knownIds.has(id)) {
    audit("unlock_reject", { id });
    return false;
  }
  if (save.unlocked[id]) return true;
  const price = Math.max(0, cost | 0);
  if (save.dust < price) return false;
  save.dust -= price;
  save.unlocked[id] = true;
  await writeSave(save);
  return true;
}

let _seenDirty = false;
let _seenTimer = null;
let _seenSaveRef = null;

/** 图鉴标记：内存立即生效，合并 debounce 写档 */
export function markSeen(save, category, id) {
  if (!save.seen[category]) save.seen[category] = {};
  if (save.seen[category][id]) return false;
  save.seen[category][id] = true;
  _seenDirty = true;
  _seenSaveRef = save;
  if (_seenTimer) clearTimeout(_seenTimer);
  _seenTimer = setTimeout(() => {
    _seenTimer = null;
    if (_seenDirty && _seenSaveRef) {
      _seenDirty = false;
      writeSave(_seenSaveRef);
    }
  }, 600);
  return true;
}

export async function flushPendingSave(save) {
  if (_seenTimer) {
    clearTimeout(_seenTimer);
    _seenTimer = null;
  }
  if (_seenDirty) {
    _seenDirty = false;
    await writeSave(save || _seenSaveRef);
  }
}

export function getAuditLog() {
  try { return JSON.parse(localStorage.getItem(AUDIT_KEY) || "[]"); }
  catch { return []; }
}

export { defaultSave };
