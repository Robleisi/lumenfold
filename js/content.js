/** 全部可解锁内容：折纹 / 敌人 / 生态 / 共鸣 / 工坊 */

export const RARITY = {
  common: { id: "common", name: "寻常", color: "#5f7d76" },
  rare: { id: "rare", name: "稀有", color: "#2f7fbb" },
  epic: { id: "epic", name: "史诗", color: "#c46b1e" },
  legend: { id: "legend", name: "传说", color: "#c4473d" },
};

export const FOLDS = {
  crease_bolt: {
    id: "crease_bolt", name: "折刃", rarity: "common",
    desc: "基础折光弹。叠层提高射速与穿透感。",
    type: "weapon", unlock: true,
    apply(p, stacks = 1) { p.stats.damage += 2 * stacks; p.stats.fireRate *= 1 - 0.06 * stacks; },
  },
  twin_refraction: {
    id: "twin_refraction", name: "双折射", rarity: "common",
    desc: "额外射出一道折射弹，扇形张开。",
    type: "weapon", unlock: true,
    apply(p, stacks = 1) { p.stats.extraShots += stacks; p.stats.spread += 0.08 * stacks; },
  },
  ink_tide: {
    id: "ink_tide", name: "墨潮", rarity: "rare",
    desc: "攻击附带墨渍，减速并持续掉血。",
    type: "weapon", unlock: true,
    apply(p) { p.flags.inkTide = true; p.stats.damage += 1; },
  },
  origami_swift: {
    id: "origami_swift", name: "纸燕步", rarity: "common",
    desc: "移速提升，折冲冷却缩短。",
    type: "mobility", unlock: true,
    apply(p, stacks = 1) { p.stats.moveSpeed += 28 * stacks; p.stats.dashCd *= 1 - 0.12 * stacks; },
  },
  prism_burst: {
    id: "prism_burst", name: "棱爆", rarity: "rare",
    desc: "击杀时爆发折光碎片。",
    type: "onKill", unlock: true,
    apply(p) { p.flags.prismBurst = true; },
  },
  crease_armor: {
    id: "crease_armor", name: "叠甲", rarity: "common",
    desc: "最大折光提升，受伤后短暂加速。首次获得时回复等量生命。",
    type: "defense", unlock: true,
    apply(p, stacks = 1) { p.stats.maxHp += 18 * stacks; p.flags.hurtHaste = true; },
  },
  solar_lace: {
    id: "solar_lace", name: "日丝", rarity: "epic",
    desc: "普攻留下灼热光丝，敌人路过受伤。",
    type: "weapon", unlockNeeded: "solar_lace",
    apply(p) { p.flags.solarLace = true; },
  },
  time_crease: {
    id: "time_crease", name: "时褶", rarity: "epic",
    desc: "折冲瞬间局部减速敌影。",
    type: "mobility", unlockNeeded: "time_crease",
    apply(p) { p.flags.timeCrease = true; },
  },
  mirror_skin: {
    id: "mirror_skin", name: "镜肤", rarity: "rare",
    desc: "受击有概率折射伤害并反弹弹道。",
    type: "defense", unlockNeeded: "mirror_skin",
    apply(p) { p.flags.mirrorSkin = true; },
  },
  flock_fold: {
    id: "flock_fold", name: "群折", rarity: "epic",
    desc: "召唤纸鸟协战，叠层增加鸟数。",
    type: "summon", unlockNeeded: "flock_fold",
    apply(p, stacks = 1) { p.flags.birds = (p.flags.birds || 0) + stacks; },
  },
  void_seam: {
    id: "void_seam", name: "虚缝", rarity: "legend",
    desc: "大招撕裂虚缝，拉扯并重创范围内敌影。",
    type: "ultimate", unlockNeeded: "void_seam",
    apply(p) { p.flags.voidSeam = true; p.stats.ultDamage += 40; },
  },
  jade_bloom: {
    id: "jade_bloom", name: "翠绽", rarity: "rare",
    desc: "拾取折光尘时回复生命并短暂无敌帧延长。",
    type: "utility", unlockNeeded: "jade_bloom",
    apply(p) { p.flags.jadeBloom = true; },
  },
  chain_fold: {
    id: "chain_fold", name: "连锁折", rarity: "epic",
    desc: "弹道命中后弹射至附近敌人。",
    type: "weapon", unlockNeeded: "chain_fold",
    apply(p, stacks = 1) { p.stats.chain += stacks; },
  },
  amber_heart: {
    id: "amber_heart", name: "琥珀心", rarity: "legend",
    desc: "低血量时伤害与射速大幅提升。",
    type: "defense", unlockNeeded: "amber_heart",
    apply(p) { p.flags.amberHeart = true; },
  },
  cartographer: {
    id: "cartographer", name: "绘页者", rarity: "rare",
    desc: "房间清扫后额外获得一张折纹选择。",
    type: "utility", unlockNeeded: "cartographer",
    apply(p) { p.flags.extraPick = true; },
  },
  gravity_pleat: {
    id: "gravity_pleat", name: "引力褶", rarity: "epic",
    desc: "大招附带向心牵引。",
    type: "ultimate", unlockNeeded: "gravity_pleat",
    apply(p) { p.flags.gravityPleat = true; },
  },
};

export const RELICS = {
  first_crease: { id: "first_crease", name: "初折残页", desc: "开局额外 +10% 伤害。", unlock: true },
  dusk_compass: { id: "dusk_compass", name: "暮色罗盘", desc: "精英房出现率提升。", unlockNeeded: "dusk_compass" },
  spare_ink: { id: "spare_ink", name: "余墨壶", desc: "墨能回复加快。", unlockNeeded: "spare_ink" },
  lucky_seam: { id: "lucky_seam", name: "幸缝针", desc: "稀有以上折纹权重上升。", unlockNeeded: "lucky_seam" },
  phoenix_fold: { id: "phoenix_fold", name: "再生折", desc: "每层首次致命伤改为残留 1 点折光。", unlockNeeded: "phoenix_fold" },
};

export const ENEMIES = {
  scrap_mite: {
    id: "scrap_mite", name: "纸屑螨",
    desc: "成群贴近撕咬的碎纸生物——割草主力粮草。",
    unlock: true, hp: 14, speed: 88, damage: 5, radius: 10, score: 1,
    color: [236, 96, 78], accent: [255, 210, 190], shape: "mite",
  },
  stitch_drone: {
    id: "stitch_drone", name: "缝线蜂",
    desc: "保持距离，射出缓慢墨线（准头一般）。",
    unlock: true, hp: 18, speed: 64, damage: 6, radius: 12, score: 2, ranged: true,
    color: [32, 186, 214], accent: [200, 250, 255], shape: "drone",
  },
  fold_brute: {
    id: "fold_brute", name: "厚页蛮",
    desc: "缓慢冲撞，血量仍偏脆，适合风筝。",
    unlock: true, hp: 48, speed: 50, damage: 11, radius: 18, score: 3, charge: true,
    color: [196, 92, 42], accent: [255, 200, 140], shape: "brute",
  },
  glass_wisp: {
    id: "glass_wisp", name: "玻焰",
    desc: "飘忽不定，死亡时碎裂溅射。",
    unlockNeeded: "glass_wisp", hp: 12, speed: 115, damage: 5, radius: 9, score: 2, explode: true,
    color: [255, 214, 64], accent: [255, 255, 220], shape: "wisp",
  },
  ink_lurker: {
    id: "ink_lurker", name: "潜墨",
    desc: "短暂隐匿后从侧翼突袭。",
    unlockNeeded: "ink_lurker", hp: 26, speed: 105, damage: 9, radius: 13, score: 3, stealth: true,
    color: [56, 48, 92], accent: [255, 120, 170], shape: "lurker",
  },
  prism_sentry: {
    id: "prism_sentry", name: "棱哨",
    desc: "三角驻守，折射弹幕偏慢且发散。",
    unlockNeeded: "prism_sentry", hp: 36, speed: 38, damage: 7, radius: 15, score: 4, ranged: true, spread: true,
    color: [56, 120, 255], accent: [180, 220, 255], shape: "sentry",
  },
  paper_hydra: {
    id: "paper_hydra", name: "纸海德拉",
    desc: "被击败后分裂成两只较小体。",
    unlockNeeded: "paper_hydra", hp: 42, speed: 62, damage: 8, radius: 16, score: 5, split: true,
    color: [220, 64, 72], accent: [255, 180, 160], shape: "hydra",
  },
  aurora_moth: {
    id: "aurora_moth", name: "极光蛾",
    desc: "高速盘旋，留下光尘。",
    unlockNeeded: "aurora_moth", hp: 16, speed: 130, damage: 6, radius: 11, score: 3, orbit: true,
    color: [90, 220, 110], accent: [220, 255, 200], shape: "moth",
  },
  seam_knight: {
    id: "seam_knight", name: "缝隙骑士",
    desc: "少见精英，格挡正面弹道。",
    unlockNeeded: "seam_knight", hp: 110, speed: 70, damage: 13, radius: 17, score: 8, elite: true, block: true,
    color: [255, 176, 48], accent: [255, 245, 210], shape: "knight",
  },
  eclipse_weaver: {
    id: "eclipse_weaver", name: "蚀日织者",
    desc: "深层梦魇，仍偏人海中的尖子。",
    unlockNeeded: "eclipse_weaver", hp: 140, speed: 80, damage: 14, radius: 20, score: 12, elite: true, ranged: true,
    color: [72, 36, 48], accent: [255, 80, 100], shape: "weaver",
  },
};

export const BOSSES = {
  folio_tyrant: {
    id: "folio_tyrant", name: "册页暴君",
    desc: "第一纪元守门者：厚重折页砸落与扇形墨刃。",
    unlock: true, hp: 620, speed: 46, damage: 14, radius: 34,
    color: [48, 110, 128], accent: [120, 220, 210], shape: "boss",
  },
  lace_matron: {
    id: "lace_matron", name: "丝网主母",
    desc: "以光丝织网困住猎物。",
    unlockNeeded: "boss_lace", hp: 820, speed: 55, damage: 13, radius: 30,
    color: [230, 170, 70], accent: [255, 240, 180], shape: "boss",
  },
  hollow_cartographer: {
    id: "hollow_cartographer", name: "空心制图师",
    desc: "改写房间折痕，召唤镜像分身。",
    unlockNeeded: "boss_hollow", hp: 1050, speed: 64, damage: 15, radius: 28,
    color: [70, 150, 190], accent: [200, 240, 255], shape: "boss",
  },
  final_origami: {
    id: "final_origami", name: "终极折神",
    desc: "万页归一。击败它以见证完整织界。",
    unlockNeeded: "boss_final", hp: 1500, speed: 72, damage: 17, radius: 36,
    color: [235, 100, 70], accent: [255, 210, 160], shape: "boss",
  },
};

export const BIOMES = {
  sun_paper: {
    id: "sun_paper", name: "日光纸原",
    desc: "暖光铺开的第一页，折痕尚浅。",
    unlock: true,
    palette: { bg1: "#1a4a45", bg2: "#2f6b55", accent: "#e8b45a", fog: "rgba(232,180,90,0.05)" },
    enemyPool: ["scrap_mite", "stitch_drone", "fold_brute"],
  },
  teal_marsh: {
    id: "teal_marsh", name: "青墨泽",
    desc: "潮气浸透纸纤维，潜影出没。",
    unlockNeeded: "biome_marsh",
    palette: { bg1: "#0f3a42", bg2: "#1d5a55", accent: "#7fd0c0", fog: "rgba(80,180,170,0.06)" },
    enemyPool: ["scrap_mite", "ink_lurker", "stitch_drone", "glass_wisp"],
  },
  prism_archive: {
    id: "prism_archive", name: "棱镜档案馆",
    desc: "几何书架林立，弹道被反复折射。",
    unlockNeeded: "biome_archive",
    palette: { bg1: "#12384a", bg2: "#2a5f78", accent: "#8ad0ef", fog: "rgba(120,200,230,0.06)" },
    enemyPool: ["prism_sentry", "glass_wisp", "stitch_drone", "aurora_moth"],
  },
  ember_atelier: {
    id: "ember_atelier", name: "余烬作坊",
    desc: "未熄的折火在桌案上爬行。",
    unlockNeeded: "biome_atelier",
    palette: { bg1: "#3a2a1c", bg2: "#5a3a22", accent: "#ff9a4a", fog: "rgba(255,140,60,0.06)" },
    enemyPool: ["fold_brute", "paper_hydra", "glass_wisp", "seam_knight"],
  },
  night_folio: {
    id: "night_folio", name: "夜册深庭",
    desc: "终焉之页。折神在此醒来。",
    unlockNeeded: "biome_night",
    palette: { bg1: "#0b1a28", bg2: "#163044", accent: "#d8c4a0", fog: "rgba(200,210,230,0.05)" },
    enemyPool: ["eclipse_weaver", "seam_knight", "aurora_moth", "prism_sentry", "paper_hydra"],
  },
};

export const SYNERGIES = [
  {
    id: "syn_prism_ink", name: "墨棱协奏",
    need: ["ink_tide", "prism_burst"],
    desc: "墨渍敌人被击杀时棱爆范围扩大并留下减速场。",
    unlockNeeded: "syn_prism_ink",
  },
  {
    id: "syn_bird_swift", name: "燕阵",
    need: ["flock_fold", "origami_swift"],
    desc: "纸鸟继承你的移速加成，并在折冲时齐射。",
    unlockNeeded: "syn_bird_swift",
  },
  {
    id: "syn_time_chain", name: "迟滞连锁",
    need: ["time_crease", "chain_fold"],
    desc: "弹射目标会被短暂时褶冻结。",
    unlockNeeded: "syn_time_chain",
  },
  {
    id: "syn_void_gravity", name: "塌缩缝",
    need: ["void_seam", "gravity_pleat"],
    desc: "虚缝中心形成短暂黑洞，结束后爆炸。",
    unlockNeeded: "syn_void_gravity",
  },
  {
    id: "syn_amber_mirror", name: "琥珀镜心",
    need: ["amber_heart", "mirror_skin"],
    desc: "低血量时反弹概率提升至必反一次。",
    unlockNeeded: "syn_amber_mirror",
  },
];

function withImpact(list) {
  return list.map((u) => {
    if (u.impact) return u;
    if (u.kind === "enemy" || u.kind === "boss" || u.kind === "biome") {
      return { ...u, impact: "challenge" };
    }
    return { ...u, impact: "power" };
  });
}

export const META_UNLOCKS = withImpact([
  { id: "solar_lace", name: "日丝", kind: "fold", cost: 40, desc: "解锁折纹：日丝" },
  { id: "time_crease", name: "时褶", kind: "fold", cost: 55, desc: "解锁折纹：时褶" },
  { id: "mirror_skin", name: "镜肤", kind: "fold", cost: 50, desc: "解锁折纹：镜肤" },
  { id: "flock_fold", name: "群折", kind: "fold", cost: 70, desc: "解锁折纹：群折" },
  { id: "jade_bloom", name: "翠绽", kind: "fold", cost: 45, desc: "解锁折纹：翠绽" },
  { id: "chain_fold", name: "连锁折", kind: "fold", cost: 80, desc: "解锁折纹：连锁折" },
  { id: "void_seam", name: "虚缝", kind: "fold", cost: 100, desc: "解锁折纹：虚缝" },
  { id: "amber_heart", name: "琥珀心", kind: "fold", cost: 110, desc: "解锁折纹：琥珀心" },
  { id: "gravity_pleat", name: "引力褶", kind: "fold", cost: 90, desc: "解锁折纹：引力褶" },
  { id: "cartographer", name: "绘页者", kind: "fold", cost: 65, desc: "解锁折纹：绘页者" },
  { id: "glass_wisp", name: "玻焰", kind: "enemy", cost: 30, desc: "敌影加入轮转：玻焰（增加挑战）" },
  { id: "ink_lurker", name: "潜墨", kind: "enemy", cost: 35, desc: "敌影加入轮转：潜墨（增加挑战）" },
  { id: "prism_sentry", name: "棱哨", kind: "enemy", cost: 45, desc: "敌影加入轮转：棱哨（增加挑战）" },
  { id: "paper_hydra", name: "纸海德拉", kind: "enemy", cost: 60, desc: "敌影加入轮转：纸海德拉（增加挑战）" },
  { id: "aurora_moth", name: "极光蛾", kind: "enemy", cost: 50, desc: "敌影加入轮转：极光蛾（增加挑战）" },
  { id: "seam_knight", name: "缝隙骑士", kind: "enemy", cost: 75, desc: "敌影加入轮转：缝隙骑士（增加挑战）" },
  { id: "eclipse_weaver", name: "蚀日织者", kind: "enemy", cost: 95, desc: "敌影加入轮转：蚀日织者（增加挑战）" },
  { id: "biome_marsh", name: "青墨泽", kind: "biome", cost: 40, desc: "解锁生态层：青墨泽（增加挑战）" },
  { id: "biome_archive", name: "棱镜档案馆", kind: "biome", cost: 70, desc: "解锁生态层：棱镜档案馆（增加挑战）" },
  { id: "biome_atelier", name: "余烬作坊", kind: "biome", cost: 100, desc: "解锁生态层：余烬作坊（增加挑战）" },
  { id: "biome_night", name: "夜册深庭", kind: "biome", cost: 140, desc: "解锁生态层：夜册深庭（增加挑战）" },
  { id: "boss_lace", name: "丝网主母", kind: "boss", cost: 85, desc: "更深的守门者苏醒（增加挑战）" },
  { id: "boss_hollow", name: "空心制图师", kind: "boss", cost: 120, desc: "档案馆最深处的守门者（增加挑战）" },
  { id: "boss_final", name: "终极折神", kind: "boss", cost: 180, desc: "开放最终挑战" },
  { id: "dusk_compass", name: "暮色罗盘", kind: "relic", cost: 50, desc: "遗物：精英更常见" },
  { id: "spare_ink", name: "余墨壶", kind: "relic", cost: 40, desc: "遗物：墨能回复" },
  { id: "lucky_seam", name: "幸缝针", kind: "relic", cost: 70, desc: "遗物：高稀有权重" },
  { id: "phoenix_fold", name: "再生折", kind: "relic", cost: 130, desc: "遗物：每层一次免死" },
  { id: "syn_prism_ink", name: "共鸣：墨棱", kind: "synergy", cost: 60, desc: "发现共鸣配方" },
  { id: "syn_bird_swift", name: "共鸣：燕阵", kind: "synergy", cost: 75, desc: "发现共鸣配方" },
  { id: "syn_time_chain", name: "共鸣：迟滞连锁", kind: "synergy", cost: 90, desc: "发现共鸣配方" },
  { id: "syn_void_gravity", name: "共鸣：塌缩缝", kind: "synergy", cost: 110, desc: "发现共鸣配方" },
  { id: "syn_amber_mirror", name: "共鸣：琥珀镜心", kind: "synergy", cost: 100, desc: "发现共鸣配方" },
  { id: "starting_twin", name: "开局双折射", kind: "meta", cost: 60, desc: "新局自带一层双折射" },
  { id: "dust_magnet", name: "尘吸", kind: "meta", cost: 80, desc: "局内折光尘掉落 +25%" },
  { id: "deep_pages", name: "深页", kind: "meta", cost: 150, desc: "每局层数上限 +2（最多 12）" },
]);

/** 工坊分类文案 */
export const META_KIND_LABEL = {
  fold: "折纹",
  enemy: "敌影",
  biome: "生态层",
  boss: "守门者",
  relic: "遗物",
  synergy: "共鸣",
  meta: "永久强化",
};

/** 工坊影响：power=增强构筑，challenge=增加遭遇难度 */
export const META_IMPACT_LABEL = {
  power: "增强构筑",
  challenge: "增加挑战",
};

/** 新手优先推荐解锁顺序（便宜、立刻改变手感） */
export const META_STARTER_IDS = [
  "glass_wisp",
  "spare_ink",
  "solar_lace",
  "biome_marsh",
  "jade_bloom",
  "ink_lurker",
  "mirror_skin",
  "starting_twin",
];

export function isUnlocked(save, item) {
  if (item.unlock) return true;
  if (!item.unlockNeeded) return true;
  return !!save.unlocked[item.unlockNeeded];
}
