// 运维统计持久化（只读看板的数据源）
//
// 隐私约束：只落盘“计数”和“按天计数”，绝不保存 IP、昵称、会话 token 原文或任何可识别个人的信息。
// 存储：与 levels.json 同一目录（LEVELS_DIR）下的 stats.json，写入方式同样是
//     先写 *.tmp → fs.renameSync 原子替换，断电/重启不会写坏原文件。

import fs from 'node:fs';
import path from 'node:path';

export const STATS_FILE = 'stats.json';
/** 只保留最近 30 天的按天数据（防止文件无限增长） */
export const KEEP_DAYS = 30;
const FLUSH_DEBOUNCE_MS = 800;
const PERIODIC_FLUSH_MS = 15_000;

/** bump(kind) → 累计字段 / 按天字段 */
const TOTAL_KEY = {
  room: 'roomsTotal',
  session: 'sessionsTotal',
  match: 'matchesTotal',
  completion: 'completionsTotal',
  upload: 'uploadsTotal',
  download: 'downloadsTotal',
};
const DAY_KEY = {
  room: 'rooms',
  session: 'sessions',
  match: 'matches',
  completion: 'completions',
  upload: 'uploads',
  download: 'downloads',
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 本地时区的 YYYY-MM-DD（看板按服务器本地日期分天） */
export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function emptyDay() {
  return {
    rooms: 0, sessions: 0, matches: 0,
    completions: 0, uploads: 0, downloads: 0, peakPlayers: 0,
  };
}

function int(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export class StatsStore {
  /**
   * @param {string} dir 数据目录（与 levels.json 同目录）
   */
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, STATS_FILE);
    this.totals = {
      roomsTotal: 0,
      sessionsTotal: 0,
      matchesTotal: 0,
      completionsTotal: 0,
      uploadsTotal: 0,
      downloadsTotal: 0,
      peakPlayers: 0,
      peakAt: 0,
    };
    this.days = new Map();
    this.dirty = false;
    this.flushTimer = null;
    this.load();
    this.periodic = setInterval(() => {
      if (this.dirty) this.flush();
    }, PERIODIC_FLUSH_MS);
    if (this.periodic.unref) this.periodic.unref();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const t = raw?.totals ?? {};
      for (const k of Object.keys(this.totals)) this.totals[k] = int(t[k]);
      const days = raw?.days ?? {};
      for (const [key, value] of Object.entries(days)) {
        if (!DAY_RE.test(key) || !value || typeof value !== 'object') continue;
        this.days.set(key, {
          rooms: int(value.rooms), sessions: int(value.sessions), matches: int(value.matches),
          completions: int(value.completions), uploads: int(value.uploads),
          downloads: int(value.downloads), peakPlayers: int(value.peakPlayers),
        });
      }
      this.prune();
    } catch {
      // 文件不存在或损坏：从 0 开始，不影响服务启动
    }
  }

  prune() {
    const keys = [...this.days.keys()].sort();
    while (keys.length > KEEP_DAYS) this.days.delete(keys.shift());
  }

  touchDay() {
    const key = dayKey();
    let day = this.days.get(key);
    if (!day) {
      day = emptyDay();
      this.days.set(key, day);
      this.prune();
    }
    return day;
  }

  /**
   * 计数 +1（也允许 -1，用于撤回过早创建的临时会话；结果不会低于 0）。
   * @param {'room'|'session'|'match'|'completion'|'upload'|'download'} kind
   */
  bump(kind, delta = 1) {
    const totalKey = TOTAL_KEY[kind];
    const dayField = DAY_KEY[kind];
    if (!totalKey || !Number.isFinite(delta) || delta === 0) return;
    this.totals[totalKey] = Math.max(0, this.totals[totalKey] + delta);
    const day = this.touchDay();
    day[dayField] = Math.max(0, day[dayField] + delta);
    this.scheduleFlush();
  }

  /** 观察当前在线人数，刷新历史峰值（含发生时间） */
  observePlayers(count) {
    const n = int(count);
    const day = this.touchDay();
    let changed = false;
    if (n > day.peakPlayers) {
      day.peakPlayers = n;
      changed = true;
    }
    if (n > this.totals.peakPlayers) {
      this.totals.peakPlayers = n;
      this.totals.peakAt = Date.now();
      changed = true;
    }
    if (changed) this.scheduleFlush();
  }

  /** 最近 N 天（按日期升序，最后一项是今天） */
  lastDays(count = 7) {
    const out = [];
    const today = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const key = dayKey(d);
      out.push({ date: key, ...(this.days.get(key) ?? emptyDay()) });
    }
    return out;
  }

  summary(lastDays = 7) {
    return { totals: { ...this.totals }, last7: this.lastDays(lastDays) };
  }

  /** 管理员清零：累计计数与按天数据全部归零并立即落盘；失败时回滚内存并返回 false */
  reset() {
    const prevTotals = { ...this.totals };
    const prevDays = new Map(this.days);
    for (const k of Object.keys(this.totals)) this.totals[k] = 0;
    this.days.clear();
    this.dirty = true;
    if (!this.flush()) {
      this.totals = prevTotals;
      this.days = prevDays;
      this.dirty = true;
      return false;
    }
    return true;
  }

  scheduleFlush() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /** 原子落盘：tmp + rename；失败时保留 dirty，周期任务会重试 */
  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const payload = JSON.stringify({
        v: 1,
        updatedAt: Date.now(),
        totals: this.totals,
        days: Object.fromEntries(this.days),
      });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      return true;
    } catch (err) {
      console.error(`[stats] 落盘失败：${err.message}`);
      return false;
    }
  }

  close() {
    if (this.periodic) {
      clearInterval(this.periodic);
      this.periodic = null;
    }
    this.flush();
  }
}
