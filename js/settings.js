/** 本地设置：与存档分离，避免被存档校验影响 */

const KEY = "lumenfold_settings_v1";

/**
 * 画质档位：low = 帧数优先，ultra = 精细特效。
 * 逻辑层共用，仅影响分辨率、粒子与绘制开销。
 */
export const QUALITY = {
  low: {
    id: "low",
    dprCap: 1,
    particles: 120,
    shake: 0.25,
    trails: false,
    bgShards: 0,
    creaseGrid: false,
    creaseStep: 96,
    softBg: false,
    vignette: false,
    entityGlow: false,
    enemyDetail: false,
    fieldDetail: false,
    playerAura: false,
    pickupGlow: false,
    sparkParticles: false,
    fxScale: 0.35,
  },
  med: {
    id: "med",
    dprCap: 1.5,
    particles: 360,
    shake: 0.7,
    trails: true,
    bgShards: 5,
    creaseGrid: true,
    creaseStep: 96,
    softBg: true,
    vignette: true,
    entityGlow: true,
    enemyDetail: true,
    fieldDetail: true,
    playerAura: false,
    pickupGlow: false,
    sparkParticles: true,
    fxScale: 0.85,
  },
  high: {
    id: "high",
    dprCap: 2,
    particles: 560,
    shake: 1,
    trails: true,
    bgShards: 10,
    creaseGrid: true,
    creaseStep: 80,
    softBg: true,
    vignette: true,
    entityGlow: true,
    enemyDetail: true,
    fieldDetail: true,
    playerAura: true,
    pickupGlow: true,
    sparkParticles: true,
    fxScale: 1.2,
  },
  ultra: {
    id: "ultra",
    dprCap: 2.5,
    particles: 900,
    shake: 1.2,
    trails: true,
    bgShards: 18,
    creaseGrid: true,
    creaseStep: 64,
    softBg: true,
    vignette: true,
    entityGlow: true,
    enemyDetail: true,
    fieldDetail: true,
    playerAura: true,
    pickupGlow: true,
    sparkParticles: true,
    fxScale: 1.75,
  },
};

export const QUALITY_ORDER = ["low", "med", "high", "ultra"];

export const FPS_CAPS = [0, 30, 60, 120]; // 0 = 不限制

const defaults = () => ({
  lang: "zh",
  masterVol: 70,
  sfxVol: 100,
  bgmVol: 55,
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
    const merged = { ...defaults(), ...JSON.parse(raw) };
    if (!QUALITY[merged.quality]) merged.quality = "med";
    return merged;
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
