// 成就系统：解锁判定 + 持久化 + 通知联动

import { ACHIEVEMENTS, AchievementDef } from '../data/achievements';
import { LEVELS } from '../data/levels';
import { SaveSystem } from './SaveSystem';
import { ToastManager } from './ToastManager';
import { AudioSystem } from '../core/Audio';

const ACH_KEY = 'magnetic_rush_achievements_v1';

export class AchievementSystem {
  private unlocked = new Set<string>();
  private toasts: ToastManager;
  private audio: AudioSystem;

  constructor(toasts: ToastManager, audio: AudioSystem, private save: SaveSystem) {
    this.toasts = toasts;
    this.audio = audio;
    this.load();
  }

  private load() {
    try {
      const raw = localStorage.getItem(ACH_KEY);
      if (raw) {
        const ids: string[] = JSON.parse(raw).unlocked ?? [];
        ids.forEach(id => this.unlocked.add(id));
      }
    } catch { /* ignore */ }
  }

  private persist() {
    try {
      localStorage.setItem(ACH_KEY, JSON.stringify({ unlocked: [...this.unlocked] }));
    } catch { /* ignore */ }
  }

  isUnlocked(id: string): boolean {
    return this.unlocked.has(id);
  }

  count(): number {
    return this.unlocked.size;
  }

  list(): { def: AchievementDef; unlocked: boolean }[] {
    return ACHIEVEMENTS.map(def => ({ def, unlocked: this.unlocked.has(def.id) }));
  }

  private unlock(id: string) {
    if (this.unlocked.has(id)) return;
    const def = ACHIEVEMENTS.find(a => a.id === id);
    if (!def) return;
    this.unlocked.add(id);
    this.persist();
    this.audio.playAchievement();
    this.toasts.push(def.name, def.desc, def.icon);
  }

  // ---- 事件钩子（由 GameScene 调用）----

  /** 切换极性。combo：切换后连击数；justTeleported：是否在传送后0.5s内 */
  onSwitch(combo: number, justTeleported: boolean) {
    if (combo >= 30) this.unlock('POLARITY_MASTER');
    if (combo >= 50) this.unlock('COMBO_KING');
    if (justTeleported) this.unlock('PORTAL_NINJA');
  }

  /** 重力翻转状态累计存活秒数（死亡清零） */
  onFlippedTime(seconds: number) {
    if (seconds >= 5) this.unlock('GRAVITY_DEFYER');
  }

  /** 通关一关 */
  onLevelComplete(levelId: number, time: number, deathsInLevel: number, usedBoost: boolean) {
    if (levelId === 1) this.unlock('FIRST_STEP');

    // 连续无伤通关
    if (deathsInLevel === 0) {
      this.save.data.noDeathStreak += 1;
    } else {
      this.save.data.noDeathStreak = 0;
    }
    this.save.save();
    if (this.save.data.noDeathStreak >= 5) this.unlock('NO_DEATH_RUN');

    if (levelId === 26 && usedBoost) this.unlock('SPEED_DEMON');

    this.checkGlobalClears();
  }

  /** 无尽模式结算；distancePx 为本局最远距离（px） */
  onEndlessRun(timeSec: number, distancePx = 0) {
    if (timeSec >= 180) this.unlock('ENDLESS_WARRIOR');
    if (distancePx >= 1000 * 50) this.unlock('ENDLESS_1000');
  }

  /** 每日挑战结算 */
  onDailyRun(streak: number) {
    if (streak >= 7) this.unlock('DAILY_7');
  }

  /** 相位墙累计穿过数量 */
  onPhaseWall(totalPassed: number) {
    if (totalPassed >= 50) this.unlock('PHASE_WALKER');
  }

  /** 全局通关类成就（每次通关后重算） */
  checkGlobalClears() {
    const recs = this.save.data.levels;
    const total = LEVELS.length;
    const normalClears = LEVELS.filter(l => recs[l.id]?.completed).length;
    if (normalClears >= total) {
      this.unlock('ALL_CLEAR');
      const allPar = LEVELS.every(l => {
        const r = recs[l.id];
        return !!r && r.bestTime > 0 && r.bestTime <= l.parTime;
      });
      if (allPar) this.unlock('PERFECTIONIST');
      const allStars = LEVELS.every(l => {
        const r = recs[l.id];
        return !!r && r.completed && (r.stars ?? 0) >= 3;
      });
      if (allStars) this.unlock('ALL_STARS');
    }

    const zeroDeathCount = LEVELS.filter(l => recs[l.id]?.completed && recs[l.id]?.zeroDeath).length;
    if (zeroDeathCount >= 10) this.unlock('NO_DEATH_10');

    if (this.save.data.phaseWallsPassed >= 50) this.unlock('PHASE_WALKER');
  }
}
