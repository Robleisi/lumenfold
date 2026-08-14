/** 简易 i18n：界面文案 */

const DICT = {
  zh: {
    brand_eyebrow: "纸页翻折 · 光在缝隙里生长",
    brand_title: "折光织界",
    brand_tagline: "把空间折出刃口。每一次溃败，都会在图鉴里留下新的折纹。",
    btn_start: "开始织界",
    btn_coop: "内网联机",
    btn_atlas: "折纹图鉴",
    btn_meta: "织造工坊",
    btn_settings: "设置",
    btn_tutorial: "再看教程",
    menu_foot: "割草向肉鸽 · 存档防篡改 · 内网/外网联机",
    btn_wan: "外网联机",
    settings_title: "设置",
    settings_lang: "语言",
    settings_master: "主音量",
    settings_sfx: "音效音量",
    settings_mute: "静音",
    settings_quality: "画质",
    settings_fps: "帧率上限",
    settings_show_fps: "显示帧数",
    settings_shake: "屏幕震动",
    settings_flash: "减弱闪光",
    quality_low: "低（更流畅）",
    quality_med: "中（推荐）",
    quality_high: "高（更精细）",
    fps_unlimited: "不限制",
    fps_30: "30 FPS",
    fps_60: "60 FPS",
    fps_120: "120 FPS",
    lang_zh: "简体中文",
    lang_en: "English",
    btn_back: "返回",
    btn_resume: "继续",
    btn_quit: "返回标题",
    btn_pause_settings: "设置",
    pause_title: "暂停",
    hint: "WASD 移动 · 鼠标/触控瞄准开火 · 右键/Shift 折冲 · 空格 大招 · Esc 暂停",
    toast_saved: "设置已保存",
    hp_label: "折光",
    mp_label: "墨能",
  },
  en: {
    brand_eyebrow: "Pages fold · light grows in the seams",
    brand_title: "Lumenfold",
    brand_tagline: "Fold space into blades. Every collapse leaves a new crease in your atlas.",
    btn_start: "Start Run",
    btn_coop: "LAN Co-op",
    btn_atlas: "Atlas",
    btn_meta: "Workshop",
    btn_settings: "Settings",
    btn_tutorial: "Replay Tutorial",
    menu_foot: "Horde roguelite · signed saves · LAN / WAN co-op",
    btn_wan: "Online Co-op",
    settings_title: "Settings",
    settings_lang: "Language",
    settings_master: "Master Volume",
    settings_sfx: "SFX Volume",
    settings_mute: "Mute",
    settings_quality: "Graphics",
    settings_fps: "FPS Cap",
    settings_show_fps: "Show FPS",
    settings_shake: "Screen Shake",
    settings_flash: "Reduce Flash",
    quality_low: "Low (smoother)",
    quality_med: "Medium (recommended)",
    quality_high: "High (prettier)",
    fps_unlimited: "Unlimited",
    fps_30: "30 FPS",
    fps_60: "60 FPS",
    fps_120: "120 FPS",
    lang_zh: "简体中文",
    lang_en: "English",
    btn_back: "Back",
    btn_resume: "Resume",
    btn_quit: "Quit to Title",
    btn_pause_settings: "Settings",
    pause_title: "Paused",
    hint: "WASD move · Mouse/touch aim & fire · RMB/Shift dash · Space ult · Esc pause",
    toast_saved: "Settings saved",
    hp_label: "Lumen",
    mp_label: "Ink",
  },
};

let lang = "zh";

export function setLang(l) {
  lang = DICT[l] ? l : "zh";
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
}

export function getLang() { return lang; }

export function t(key) {
  return (DICT[lang] && DICT[lang][key]) || DICT.zh[key] || key;
}

export function applyStaticI18n() {
  const map = [
    [".eyebrow", "brand_eyebrow"],
    ["#screen-menu h1", "brand_title"],
    [".tagline", "brand_tagline"],
    ["#btn-start", "btn_start"],
    ["#btn-coop", "btn_coop"],
    ["#btn-wan", "btn_wan"],
    ["#btn-atlas", "btn_atlas"],
    ["#btn-meta", "btn_meta"],
    ["#btn-settings", "btn_settings"],
    ["#btn-tutorial", "btn_tutorial"],
    [".menu-foot", "menu_foot"],
    ["#hint", "hint"],
    ["#screen-pause h2", "pause_title"],
    ["#btn-resume", "btn_resume"],
    ["#btn-quit", "btn_quit"],
    ["#btn-pause-settings", "btn_pause_settings"],
    ["#settings-title", "settings_title"],
    ["#btn-settings-back", "btn_back"],
    ["#label-lang", "settings_lang"],
    ["#label-master", "settings_master"],
    ["#label-sfx", "settings_sfx"],
    ["#label-mute", "settings_mute"],
    ["#label-quality", "settings_quality"],
    ["#label-fps", "settings_fps"],
    ["#label-show-fps", "settings_show_fps"],
    ["#label-shake", "settings_shake"],
    ["#label-flash", "settings_flash"],
    [".bar-wrap:first-child .bar-label", "hp_label"],
    [".bar-wrap:last-child .bar-label", "mp_label"],
  ];
  for (const [sel, key] of map) {
    const el = document.querySelector(sel);
    if (el) el.textContent = t(key);
  }
  const q = document.getElementById("set-quality");
  if (q) {
    q.options[0].text = t("quality_low");
    q.options[1].text = t("quality_med");
    q.options[2].text = t("quality_high");
  }
  const f = document.getElementById("set-fps");
  if (f) {
    f.options[0].text = t("fps_unlimited");
    f.options[1].text = t("fps_30");
    f.options[2].text = t("fps_60");
    f.options[3].text = t("fps_120");
  }
}
