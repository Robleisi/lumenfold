/** 外网 / 内网中继地址解析 */

const STORAGE_KEY = "lumenfold_wan_relay_v1";

export function loadSavedWanUrl() {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function saveWanUrl(url) {
  try {
    if (url) localStorage.setItem(STORAGE_KEY, url);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* */ }
}

/** 同域部署时：页面 http(s) → 对应 ws(s) */
export function sameOriginWsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

export function defaultLanUrl() {
  const host = location.hostname || "127.0.0.1";
  const port = 8787;
  if (location.protocol === "https:") {
    // https 静态站无法直连明文 ws；提示用户填 wss
    return `wss://${host}`;
  }
  const h = host === "localhost" || host === "127.0.0.1" ? "127.0.0.1" : host;
  // 开发：页面在 5173，中继默认 8787
  if (location.port && location.port !== String(port) && location.port !== "") {
    return `ws://${h}:${port}`;
  }
  return `ws://${h}${location.port ? `:${location.port}` : `:${port}`}`;
}

export async function resolveWanUrl() {
  const saved = loadSavedWanUrl();
  if (saved) return saved;

  // 查询参数优先：?relay=wss://...
  try {
    const q = new URLSearchParams(location.search).get("relay");
    if (q) {
      saveWanUrl(q);
      return q;
    }
  } catch { /* */ }

  // 同域 /relay-info（npm run wan 部署时）
  try {
    const res = await fetch("/relay-info", { cache: "no-store" });
    if (res.ok) {
      const info = await res.json();
      if (info.publicWs) return info.publicWs;
      // 页面与中继同端口
      if (info.port && String(info.port) === String(location.port || info.port)) {
        return sameOriginWsUrl();
      }
      if (info.suggested) return info.suggested;
    }
  } catch { /* 静态托管无此接口 */ }

  return sameOriginWsUrl();
}
