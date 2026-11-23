// 存档系统：localStorage（v2）
//
// 迁移策略：保留原键 magnetic_rush_save_v1，写入时升级为 version=2 的新结构。
// - 只做一次幂等迁移，读取失败或写入失败都不清空旧档
// - 旧档已通关的关卡补 1 星（历史成绩无法反推晶片/连击，按最低星级回填）
// - 未知/缺失字段一律回退默认值，旧玩家的进度、跳关次数、特殊物品均保留

import { GAME_CONFIG } from '../data/config';

const SAVE_KEY = 'magnetic_rush_save_v1';
const SAVE_VERSION = 2;

export interface LevelRecord {
  completed: boolean;
  skipped: boolean;
  bestTime: number;   // 秒，0 = 无记录
  bestCombo: number;
  stars: number;      // 0–3
  zeroDeath: boolean;// 是否以 0 死亡通关
}

export interface DailyRecord {
  /** 最后一次完成的本地日期 YYYY-MM-DD */
  date: string;
  bestDistance: number; // px
  bestTime: number;     // 秒
  bestCombo: number;
  completed: boolean;   // 当天是否已完成（领奖）
  /** 连续完成天数 */
  streak: number;
  /** 上一次完成的本地日期，用于连续天数判定 */
  lastDate: string;
}

export interface SaveData {
  version: number;
  levels: Record<number, LevelRecord>;
  skipCharges: number;
  totalCompleted: number;
  maxComboEver: number;
  muted: boolean;
  volume: number;             // 0–1 主音量
  /** 画面震动（显示设置，关闭后不触发屏幕抖动） */
  shake: boolean;
  /** 速度感：速度线 + 角色前倾 + 加速瞬间震屏 */
  fxSpeed: boolean;
  endlessBestTime: number;    // 无尽模式最长存活（秒）
  endlessBestDistance: number; // 无尽模式最远距离（px）
  noDeathStreak: number;      // 当前连续无伤通关数
  specialItems: string[];     // 已获得特殊物品 id
  specialCleared: number[];   // 已通关特殊关卡 id
  easterEggCompleted: boolean;// 彩蛋关通关
  tutorialDone: boolean;      // 新手教程已完成
  daily: DailyRecord;
  /** 累计穿过的相位墙数量（FR-13 成就用） */
  phaseWallsPassed: number;
  /** 磁芯累计数量（每日/无尽发放，P2 外观暂未消耗） */
  cores: number;
}

const TOTAL_SPECIAL_ITEMS = 3;

const DEFAULT_DAILY: DailyRecord = {
  date: '',
  bestDistance: 0,
  bestTime: 0,
  bestCombo: 0,
  completed: false,
  streak: 0,
  lastDate: '',
};

const DEFAULT_SAVE: SaveData = {
  version: SAVE_VERSION,
  levels: {},
  skipCharges: 1,
  totalCompleted: 0,
  maxComboEver: 0,
  muted: false,
  volume: 0.5,
  shake: true,
  fxSpeed: true,
  endlessBestTime: 0,
  endlessBestDistance: 0,
  noDeathStreak: 0,
  specialItems: [],
  specialCleared: [],
  easterEggCompleted: false,
  tutorialDone: false,
  daily: DEFAULT_DAILY,
  phaseWallsPassed: 0,
  cores: 0,
};

/** 本地时区的 YYYY-MM-DD */
export function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 相对给定日期的前一天本地日期 */
export function prevLocalDate(dateStr: string): string {
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return '';
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  d.setDate(d.getDate() - 1);
  return localDate(d);
}

function clampVolume(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_SAVE.volume;
  return Math.max(0, Math.min(1, n));
}

function normalizeLevels(raw: unknown): Record<number, LevelRecord> {
  const src = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const out: Record<number, LevelRecord> = {};
  for (const [key, val] of Object.entries(src)) {
    const id = Number(key);
    if (!Number.isFinite(id) || !val || typeof val !== 'object') continue;
    const r = val as Record<string, unknown>;
    const bestTime = Number(r.bestTime);
    const bestCombo = Number(r.bestCombo);
    const completed = !!r.completed;
    const starsRaw = Number(r.stars);
    out[id] = {
      completed,
      skipped: !!r.skipped,
      bestTime: Number.isFinite(bestTime) && bestTime > 0 ? bestTime : 0,
      bestCombo: Number.isFinite(bestCombo) && bestCombo > 0 ? bestCombo : 0,
      // 迁移回填：旧档通关过的关卡至少 1 星；新档保留历史最高
      stars: Number.isFinite(starsRaw) && starsRaw > 0
        ? Math.min(3, Math.floor(starsRaw))
        : (completed ? 1 : 0),
      zeroDeath: !!r.zeroDeath,
    };
  }
  return out;
}

function normalizeDaily(raw: unknown): DailyRecord {
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return {
    date: typeof r.date === 'string' ? r.date : '',
    bestDistance: num(r.bestDistance),
    bestTime: num(r.bestTime),
    bestCombo: num(r.bestCombo),
    completed: !!r.completed,
    streak: num(r.streak),
    lastDate: typeof r.lastDate === 'string' ? r.lastDate : '',
  };
}

export class SaveSystem {
  data: SaveData;

  private static _instance: SaveSystem | null = null;
  static get(): SaveSystem {
    return SaveSystem._instance ??= new SaveSystem();
  }

  constructor() {
    this.data = this.load();
  }

  private load(): SaveData {
    let parsed: Record<string, unknown> | null = null;
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      const fresh = structuredClone(DEFAULT_SAVE);
      return fresh;
    }
    // 合并默认值 + 逐字段归一化；未知字段丢弃，缺失字段保留默认
    const data: SaveData = {
      ...structuredClone(DEFAULT_SAVE),
      ...parsed,
      levels: normalizeLevels(parsed.levels),
      daily: normalizeDaily(parsed.daily),
      version: SAVE_VERSION,
      volume: clampVolume(parsed.volume),
      muted: !!parsed.muted,
      shake: typeof parsed.shake === 'boolean' ? parsed.shake : true,
      fxSpeed: typeof parsed.fxSpeed === 'boolean' ? parsed.fxSpeed : true,
      specialItems: Array.isArray(parsed.specialItems) ? parsed.specialItems.filter(x => typeof x === 'string') : [],
      specialCleared: Array.isArray(parsed.specialCleared)
        ? parsed.specialCleared.map(Number).filter(n => Number.isFinite(n))
        : [],
      skipCharges: Number.isFinite(Number(parsed.skipCharges)) ? Math.max(0, Number(parsed.skipCharges)) : DEFAULT_SAVE.skipCharges,
      totalCompleted: Number.isFinite(Number(parsed.totalCompleted)) ? Math.max(0, Number(parsed.totalCompleted)) : 0,
      maxComboEver: Number.isFinite(Number(parsed.maxComboEver)) ? Math.max(0, Number(parsed.maxComboEver)) : 0,
      noDeathStreak: Number.isFinite(Number(parsed.noDeathStreak)) ? Math.max(0, Number(parsed.noDeathStreak)) : 0,
      phaseWallsPassed: Number.isFinite(Number(parsed.phaseWallsPassed)) ? Math.max(0, Number(parsed.phaseWallsPassed)) : 0,
      cores: Number.isFinite(Number(parsed.cores)) ? Math.max(0, Number(parsed.cores)) : 0,
    };
    // 幂等迁移：写回一次升级后的结构；写入失败不影响当前内存数据
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch { /* 隐私模式下静默失败，保留内存态 */ }
    return data;
  }

  save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.data));
    } catch { /* 隐私模式下静默失败 */ }
  }

  getLevel(id: number): LevelRecord {
    return this.data.levels[id] ?? {
      completed: false, skipped: false, bestTime: 0, bestCombo: 0, stars: 0, zeroDeath: false,
    };
  }

  /**
   * 记录通关。
   * @param stars 本局星级 0–3（只写更高值，低星不覆盖历史）
   * @param zeroDeath 本局是否 0 死亡通关
   * @returns 是否刷新了最佳时间
   */
  recordCompletion(id: number, time: number, combo: number, stars = 0, zeroDeath = false): boolean {
    const rec = this.getLevel(id);
    const isNewRecord = rec.bestTime === 0 || time < rec.bestTime;
    rec.completed = true;
    rec.skipped = false;
    if (rec.bestTime === 0 || time < rec.bestTime) rec.bestTime = time;
    if (combo > rec.bestCombo) rec.bestCombo = combo;
    rec.stars = Math.max(rec.stars, Math.max(0, Math.min(3, Math.floor(stars))));
    if (zeroDeath) rec.zeroDeath = true;
    this.data.levels[id] = rec;
    if (combo > this.data.maxComboEver) this.data.maxComboEver = combo;

    // 重新统计通关数 & 每5关奖励跳关机会
    const completedCount = Object.values(this.data.levels).filter(l => l.completed).length;
    if (completedCount > this.data.totalCompleted) {
      const before = Math.floor(this.data.totalCompleted / 5);
      const after = Math.floor(completedCount / 5);
      if (after > before) {
        this.data.skipCharges = Math.min(3, this.data.skipCharges + (after - before));
      }
      this.data.totalCompleted = completedCount;
    }
    this.save();
    return isNewRecord;
  }

  recordSkip(id: number): boolean {
    if (this.data.skipCharges <= 0) return false;
    this.data.skipCharges--;
    const rec = this.getLevel(id);
    rec.skipped = true;
    this.data.levels[id] = rec;
    this.save();
    return true;
  }

  isUnlocked(id: number): boolean {
    if (id === 1) return true;
    const prev = this.getLevel(id - 1);
    return prev.completed || prev.skipped;
  }

  /** 记录特殊物品获得；返回本次是否新获得 */
  collectSpecialItem(itemId: string): boolean {
    if (this.data.specialItems.includes(itemId)) return false;
    this.data.specialItems.push(itemId);
    this.save();
    return true;
  }

  /** 记录特殊关卡通关 */
  recordSpecialClear(levelId: number) {
    if (!this.data.specialCleared.includes(levelId)) {
      this.data.specialCleared.push(levelId);
      this.save();
    }
  }

  /** 集齐全部特殊物品 → 彩蛋关解锁 */
  get easterEggUnlocked(): boolean {
    return this.data.specialItems.length >= TOTAL_SPECIAL_ITEMS;
  }

  /** 已获得星星总数（选关/主菜单统计用） */
  totalStars(): number {
    return Object.values(this.data.levels).reduce((sum, r) => sum + Math.max(0, Math.min(3, r.stars ?? 0)), 0);
  }

  /** 累计穿过相位墙（FR-13 成就） */
  addPhaseWallPassed(count = 1) {
    this.data.phaseWallsPassed += count;
    this.save();
  }

  /** 记录无尽成绩（只升不降） */
  recordEndless(timeSec: number, distance: number, combo: number) {
    let changed = false;
    if (timeSec > this.data.endlessBestTime) { this.data.endlessBestTime = timeSec; changed = true; }
    if (distance > this.data.endlessBestDistance) { this.data.endlessBestDistance = distance; changed = true; }
    if (combo > this.data.maxComboEver) { this.data.maxComboEver = combo; changed = true; }
    if (changed) this.save();
  }

  /**
   * 记录每日挑战成绩。
   * @returns firstCompletion 当天是否首次完成（用于发磁芯）；newRecord 是否刷新当日最好
   */
  recordDaily(distance: number, timeSec: number, combo: number, today = localDate()): {
    firstCompletion: boolean; newRecord: boolean; streak: number; coresAwarded: number;
  } {
    const d = this.data.daily;
    const isToday = d.date === today;
    const firstCompletion = !(isToday && d.completed);
    const newRecord = firstCompletion
      || distance > d.bestDistance
      || (distance === d.bestDistance && timeSec > d.bestTime);

    if (firstCompletion) {
      // 连续天数：昨天完成过则 +1，否则重新计数
      if (d.lastDate && d.lastDate === prevLocalDate(today)) d.streak = Math.max(1, d.streak) + 1;
      else if (d.lastDate === today) d.streak = Math.max(1, d.streak);
      else d.streak = 1;
      d.lastDate = today;
      d.completed = true;
      d.date = today;
      d.bestDistance = distance;
      d.bestTime = timeSec;
      d.bestCombo = combo;
      const reward = GAME_CONFIG.DAILY_FIRST_CLEAR_CORES;
      this.data.cores += reward;
      this.save();
      return { firstCompletion: true, newRecord: true, streak: d.streak, coresAwarded: reward };
    }

    // 当天重复挑战：只更新最好成绩，不发磁芯
    if (distance > d.bestDistance) d.bestDistance = distance;
    if (timeSec > d.bestTime) d.bestTime = timeSec;
    if (combo > d.bestCombo) d.bestCombo = combo;
    if (newRecord) this.save();
    return { firstCompletion: false, newRecord, streak: d.streak, coresAwarded: 0 };
  }

  reset() {
    this.data = structuredClone(DEFAULT_SAVE);
    this.save();
  }
}
