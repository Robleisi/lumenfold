/** 本地设置：与存档分离，避免被存档校验影响 */

const KEY = "lumenfold_settings_v1";

export const QUALITY = {
  low: { id: "low", dprCap: 1, particles: 220, shake: 0.45, trails: false, bgShards: 3 },
  med: { id: "med", dprCap: 1.5, particles: 400, shake: 0.75, trails: true, bgShards: 6 },
  high: { id: "high", dprCap: 2, particles: 560, shake: 1, trails: true, bgShards: 8 },
};

export const FPS_CAPS = [0, 30, 60, 120]; // 0 = 不限制

const defaults = () => ({
  lang: "zh",
  masterVol: 70,
  sfxVol: 100,
  muted: false,
  quality: "med",
  fpsCap: 0,
  showFps: true,
  screenShake: true,
  reduceFlash: false,
});

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    return { ...defaults(), ...JSON.parse(raw) };
  } catch {
    return defaults();
  }
}

export function saveSettings(settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}

export function qualityPreset(id) {
  return QUALITY[id] || QUALITY.med;
}
