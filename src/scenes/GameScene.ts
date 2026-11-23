// 游戏主场景（普通关卡 / 无尽模式 / 自定义关卡 / 特殊关卡）

import { Scene } from '../core/Scene';
import { Game } from '../core/Game';
import { Player, drawRunner } from '../entities/Player';
import { Obstacle } from '../entities/Obstacle';
import { ParticleSystem } from '../core/ParticleSystem';
import { Physics } from '../core/Physics';
import { GAME_CONFIG, COLORS, Polarity, polarityColor } from '../data/config';
import { getLevel, getSpecialLevel, LevelDef } from '../data/levels';
import { SaveSystem, localDate } from '../systems/SaveSystem';
import { computeStars, StarResult } from '../systems/Progress';
import { isWithinPassWindow, countsSafePass, carriesPlayer } from '../systems/RunRules';
import { MECH, rainCoreY, pitKills, blocksSwitch, rainCoreMatches, mirrorShouldTrigger, pendulumLethal, pendulumMagnetDir } from '../systems/Mechanics';
import {
  EndlessGenerator, createEndlessLevelDef,
  dailySeed, dailyModifiers, dailyModifierLabel, DailyModifierId,
} from '../systems/EndlessGenerator';
import { CustomLevelData, CustomLevelStore, customToLevelDef } from '../systems/CustomLevels';
import { withAlpha, rainbow } from '../utils/Color';
import { AABB } from '../utils/Math';
import { ResultScene } from './ResultScene';
import { LevelSelectScene } from './LevelSelectScene';
import { MenuScene } from './MenuScene';
import { OnlineLobbyScene } from './OnlineLobbyScene';
import { isCoarsePointer } from '../utils/Device';
import { online, LevelPick, NetPlayer, QUICK_PHRASES } from '../net/OnlineManager';
import {
  isRaceSettled, settleReasonOf, spectateCandidates, cycleSpectate, buildStandings,
  stalledUnfinished, withDisconnectGrace,
  SETTLE_TIMEOUT_MS, RACE_STALL_MS,
  RaceResultRow, SettleReason,
} from '../systems/RaceSettle';
import { UI, PALETTE, STROKE, TOON_SKY } from '../ui/theme';
import { drawToonSky, toonShape, drawStickerText, drawButton, drawPolarityMark } from '../ui/widgets';

type PlayState = 'PLAYING' | 'DYING' | 'PAUSED' | 'WINNING' | 'COUNTDOWN' | 'FINISHED';
type GameMode = 'NORMAL' | 'ENDLESS' | 'DAILY' | 'CUSTOM' | 'SPECIAL' | 'ONLINE';

/** 观战时手动平移的最大偏移（避免把画面拖到没有场景的空处） */
const SPECTATE_PAN_MAX = 520;
/** 键盘平移速度（像素/秒） */
const SPECTATE_PAN_SPEED = 420;

/** 进入特殊星门时保存的原关卡快照，特殊关结束后据此继续 */
export interface ResumeSnapshot {
  levelId: number;
  playerX: number;
  playerY: number;
  vy: number;
  polarity: Polarity;
  gravityFlipped: boolean;
  combo: number;
  /** 进门前的最高连击：返回原关卡时不能只按当前 combo 恢复 */
  runMaxCombo?: number;
  time: number;
  cameraX: number;
  /** 与 obstacles 同序：哪些晶片/星核已拾取 */
  collected: boolean[];
  /** 使用过的星门在 obstacles 中的下标（恢复时保持灰化，避免重新吸入） */
  doorIndex: number;
}

export interface GameSceneOptions {
  levelId?: number;
  def?: LevelDef;
  endless?: boolean;
  customData?: CustomLevelData;
  returnScene?: () => Scene;
  /** 从星门进入特殊关时携带的原关卡快照 */
  enterFrom?: ResumeSnapshot;
  /** 从特殊关返回时恢复的快照 */
  resume?: ResumeSnapshot;
  /** 联机模式 */
  online?: { pick: LevelPick; startAt: number };
  /** 每日挑战：3 分钟固定种子无尽 */
  daily?: boolean;
}

export class GameScene extends Scene {
  private player = new Player();
  private obstacles: Obstacle[] = [];
  private particles = new ParticleSystem();
  /** 每帧复用的浮台 AABB 缓冲（避免高频分配） */
  private platBuf: AABB[] = [];
  private platPool: AABB[] = [];
  private level!: LevelDef;
  private save = SaveSystem.get();

  private mode: GameMode;
  private opts: GameSceneOptions;
  private generator: EndlessGenerator | null = null;

  private state: PlayState = 'PLAYING';
  private cameraX = 0;
  private time = 0;
  private deathTimer = 0;
  private consecutiveDeaths = 0;
  private showSkipHint = false;
  private flashAlpha = 0;
  /** 死亡顿帧剩余时间（秒）：仅离线关卡生效，联机不能让本地卡顿影响公平 */
  private hitStop = 0;
  private pausedSelection = 0;
  private passedObstacles = new Set<Obstacle>();
  private milestoneHit = new Set<number>();
  /** M02 当前所在的极性锁门（用于门内换色惩罚与出门奖励） */
  private activeLockGate: Obstacle | null = null;
  /** 每道极性锁已触发的惩罚次数 */
  private lockPenalties = new Map<Obstacle, number>();
  /** 彩色晶片的"颜色不符"提示节流（每颗晶片 1.2s 一次，避免刷屏） */
  private colorBlockAt = new Map<Obstacle, number>();

  // 收集物
  private totalGems = 0;
  private collectedGems = 0;
  private starCollected = false;

  // 检查点（教程关等带 checkpoints 的关卡：死亡回到最近教学段起点）
  private checkpointX = 100;

  // 横幅提示
  private bannerText = '';
  private bannerTimer = 0;

  // 成就统计
  private deathsInLevel = 0;
  private usedBoostThisLevel = false;
  private lastPortalTime = -999;
  private flippedSurvivalTime = 0;
  private resultSent = false;

  // 联机模式
  private onlineStartAt = 0;
  private onlineSentFinish = false;
  private onlineStateTimer = 0;

  // 联机观战（自己已完赛、别人还在跑）
  private selfFinished = false;
  /** 远端玩家动画/拖尾缓存（按 id，离开房间时清理） */
  private remoteAnim = new Map<string, {
    phase: number;
    lastX: number;
    trail: { x: number; y: number; polarity: number; sliding: boolean; flipped: boolean }[];
    trailAt: number;
  }>();
  private lastRemoteFrameAt = 0;
  /** 正在跟随的观战目标（空 = 没有可看的人） */
  private spectateId = '';
  /** 观战时手动平移的相机偏移（正 = 往右看） */
  private spectatePan = 0;
  private spectateDragX: number | null = null;
  /** 上一次看到的对手 x，用于判断“还有没有在前进” */
  private spectateSeenX = new Map<string, number>();
  /** 每个未完成对手最后一次前进的时刻（挂机超时判定） */
  private stallAt = new Map<string, number>();
  /** 对手掉线的首次观测时刻（用于 30 秒重连宽限） */
  private remoteDiscAt = new Map<string, number>();
  private disconnectedAt = 0;

  // 联机结算
  private settled = false;
  private settleReason: SettleReason = 'all_finished';
  private settleRows: RaceResultRow[] = [];
  private rankExpanded = false;

  // 星级 / 连击目标（FR-01 / FR-02）
  private runMaxCombo = 0;
  private starResult: StarResult | null = null;
  private finishHintShown = false;

  // 跳关二次确认（触屏与键盘共用）
  private skipConfirmUntil = -1;
  private skipBtnRect: { x: number; y: number; w: number; h: number } | null = null;

  // 每日挑战
  private dailyMods: DailyModifierId[] = [];
  private dailyEndAt = 0;
  private dailySpeedMul = 1;
  private dailyStormInterval = GAME_CONFIG.ENDLESS_STORM_INTERVAL;

  // 无尽磁暴事件
  private stormActive = false;
  private stormNextAt = GAME_CONFIG.ENDLESS_STORM_INTERVAL;
  private stormEndsAt = 0;

  /** 场景已退出标记：用于取消 win() 的延迟跳转回调，避免陈旧场景改状态 */
  private disposed = false;

  constructor(private game: Game, opts: GameSceneOptions) {
    super();
    this.opts = opts;
    if (opts.online) this.mode = 'ONLINE';
    else if (opts.daily) this.mode = 'DAILY';
    else if (opts.endless) this.mode = 'ENDLESS';
    else if (opts.resume) this.mode = 'NORMAL';
    else if (opts.customData) this.mode = 'CUSTOM';
    else if (opts.def?.special) this.mode = 'SPECIAL';
    else if (opts.def) this.mode = 'CUSTOM';
    else this.mode = 'NORMAL';
  }

  onEnter() {
    this.game.input.setTouchLayout('game');
    this.game.input.onTap = (x, y) => this.handleTap(x, y);

    if (this.mode === 'ONLINE') {
      const pick = this.opts.online!.pick;
      if (pick.kind === 'builtin') {
        const def = getLevel(pick.id);
        if (!def) { this.game.switchScene(new MenuScene(this.game)); return; }
        this.level = def;
      } else {
        const data = new CustomLevelStore().decode(pick.code);
        if (!data) { this.game.switchScene(new MenuScene(this.game)); return; }
        this.level = customToLevelDef(structuredClone(data));
      }
      this.obstacles = this.toObstacles(this.level);
      this.onlineStartAt = this.opts.online!.startAt;
      this.state = 'COUNTDOWN';
      online.remoteStates.clear();
      online.finishTimes.clear();
      this.remoteAnim.clear();
      this.lastRemoteFrameAt = 0;
      online.phase = 'race';
      this.phraseMsg = '';
      // 观战 / 结算状态每局重置（场景可能被复用或从结算返回大厅后重进）
      this.selfFinished = false;
      this.settled = false;
      this.settleRows = [];
      this.rankExpanded = false;
      this.settleReason = 'all_finished';
      this.spectateId = '';
      this.spectatePan = 0;
      this.spectateDragX = null;
      this.spectateSeenX.clear();
      this.stallAt.clear();
      this.remoteDiscAt.clear();
      this.disconnectedAt = 0;
      // 观战拖拽：游戏布局下不会回调 onPointerDown，完赛时切到菜单布局即可拖动/点击
      this.game.input.onPointerDown = (x: number) => {
        if (this.state === 'FINISHED' && !this.settled) this.spectateDragX = x;
      };
      this.game.input.onMove = (x: number) => {
        if (this.spectateDragX === null) return;
        const dx = x - this.spectateDragX;
        this.spectateDragX = x;
        this.panSpectate(-dx);
      };
      this.game.input.onPointerUp = () => { this.spectateDragX = null; };
      this.onlineUnsubs.push(online.on('phrase', (m: any) => {
        this.phraseMsg = `${m.name}: ${m.text}`;
        this.phraseUntil = Date.now() + 2500;
      }));
      this.onlineUnsubs.push(online.on('race_end', () => {
        // 服务端判定本局结束：全员完赛 / 有人长时间不动。
        // 自己可能还在跑（被看门狗判超时），也要立刻进结算，不能继续空跑。
        if (this.mode !== 'ONLINE' || this.settled) return;
        if (this.state === 'PLAYING' || this.state === 'COUNTDOWN') {
          this.state = 'FINISHED';
          this.selfFinished = false;
          this.game.input.setTouchLayout('menu');
        }
        const r = online.raceEndReason;
        this.enterSettlement(r === 'timeout' ? 'timeout' : (r === 'left' ? 'left' : 'all_finished'));
      }));
      this.onlineUnsubs.push(online.on('back_to_lobby', () => {
        this.disposed = true;
        this.game.switchScene(new OnlineLobbyScene(this.game));
      }));
      this.onlineUnsubs.push(online.on('rematch', () => {
        if (this.disposed) return;
        this.disposed = true;
        this.game.switchScene(new OnlineLobbyScene(this.game));
      }));
      this.onlineUnsubs.push(online.on('reconnecting', () => this.showBanner('网络中断，正在重连…', 2.5)));
      this.onlineUnsubs.push(online.on('reconnect_failed', () => {
        this.showBanner('重连失败，已退出房间', 3);
        if (this.state === 'FINISHED' && !this.settled) this.enterSettlement('left');
      }));
    } else if (this.mode === 'ENDLESS') {
      this.level = createEndlessLevelDef();
      this.generator = new EndlessGenerator();
      this.obstacles = [];
      this.extendEndless(1400);
    } else if (this.mode === 'DAILY') {
      // 每日挑战：固定种子 + 两个修正，3 分钟后结算
      const date = localDate();
      this.dailyMods = dailyModifiers(date);
      // 与 PRD 对齐：疾风 +10%、磁暴 30 秒一次
      this.dailySpeedMul = this.dailyMods.includes('speed') ? 1.10 : 1;
      this.dailyStormInterval = this.dailyMods.includes('storm')
        ? 30
        : GAME_CONFIG.ENDLESS_STORM_INTERVAL;
      this.dailyEndAt = GAME_CONFIG.DAILY_DURATION;
      this.stormNextAt = this.dailyStormInterval;
      this.level = createEndlessLevelDef('每日挑战', 165);
      this.generator = new EndlessGenerator({ seed: dailySeed(date), modifiers: this.dailyMods });
      this.obstacles = [];
      this.extendEndless(1400);
    } else if (this.opts.resume) {
      const def = getLevel(this.opts.resume.levelId);
      if (!def) {
        this.game.switchScene(new MenuScene(this.game));
        return;
      }
      this.level = def;
      this.obstacles = this.toObstacles(this.level);
    } else if (this.opts.def) {
      this.level = this.opts.def;
      this.obstacles = this.toObstacles(this.level);
    } else {
      const def = getLevel(this.opts.levelId ?? 1);
      if (!def) {
        this.game.switchScene(new LevelSelectScene(this.game));
        return;
      }
      this.level = def;
      this.obstacles = this.toObstacles(def);
    }

    this.totalGems = this.obstacles.filter(o => o.kind === 'COLLECTIBLE' && !o.meta?.currency).length;
    this.respawn(true);
    this.time = 0;
    this.consecutiveDeaths = 0;
    this.showSkipHint = false;
    this.deathsInLevel = 0;
    this.usedBoostThisLevel = false;
    this.flippedSurvivalTime = 0;
    this.resultSent = false;
    this.runMaxCombo = 0;
    this.starResult = null;
    this.finishHintShown = false;
    this.skipConfirmUntil = -1;
    this.stormActive = false;
    this.stormEndsAt = 0;
    this.stormNextAt = this.dailyStormInterval;
    this.bannerText = '';
    this.bannerTimer = 0;

    if (this.opts.resume) this.applyResume(this.opts.resume);

    this.game.audio.startMusic(this.mode === 'ENDLESS' ? 174 : this.level.bpm);
  }

  private toObstacles(def: LevelDef): Obstacle[] {
    return def.obstacles.map(o => new Obstacle({
      kind: o.kind,
      x: o.x,
      y: o.y ?? (GAME_CONFIG.GROUND_Y - 32),
      w: o.w ?? 32,
      h: o.h ?? 32,
      meta: o.meta,
    }));
  }

  /** 从星门快照恢复原关卡进度 */
  private applyResume(s: ResumeSnapshot) {
    const p = this.player;
    p.reset(s.playerX, s.playerY);
    p.x = s.playerX;
    p.y = s.playerY;
    p.vy = s.vy;
    p.polarity = s.polarity;
    p.combo = s.combo;
    if (s.gravityFlipped) p.applyGravityFlip();
    p.invincibleTime = 0.5;
    this.time = s.time;
    this.cameraX = s.cameraX;
    let gems = 0;
    this.obstacles.forEach((o, i) => {
      if (s.collected[i]) {
        o.collected = true;
        if (o.kind === 'COLLECTIBLE') gems++;
      }
    });
    this.collectedGems = gems;
    this.starCollected = false;
    this.runMaxCombo = Math.max(this.runMaxCombo, s.combo, s.runMaxCombo ?? 0);
    if (s.doorIndex >= 0 && this.obstacles[s.doorIndex]) {
      this.obstacles[s.doorIndex].triggered = true;
    }
  }

  onExit() {
    this.disposed = true;
    for (const un of this.onlineUnsubs) un();
    this.onlineUnsubs = [];
    this.game.input.setTouchLayout('menu');
    this.game.input.onTap = null;
    this.game.input.onPointerDown = null;
    this.game.input.onMove = null;
    this.game.input.onPointerUp = null;
    this.game.audio.stopMusic();
  }

  /** 暂停菜单条目（触屏索引 / 键盘选择共用同一份列表） */
  private pauseItems(): { label: string; action: 'resume' | 'replay' | 'back' | 'quit' | 'skip' }[] {
    if (this.mode === 'ONLINE') {
      return [
        { label: '继续游戏', action: 'resume' },
        { label: '退出比赛', action: 'quit' },
      ];
    }
    const items: { label: string; action: 'resume' | 'replay' | 'back' | 'skip' }[] = [
      { label: '继续游戏', action: 'resume' },
      { label: '重新开始', action: 'replay' },
      { label: this.mode === 'NORMAL' ? '返回选关' : '返回菜单', action: 'back' },
    ];
    if (this.mode === 'NORMAL' && this.showSkipHint && this.save.data.skipCharges > 0) {
      const confirming = Date.now() <= this.skipConfirmUntil;
      items.push({
        label: confirming ? '再点一次确认跳过' : `跳过本关（剩 ${this.save.data.skipCharges} 次）`,
        action: 'skip',
      });
    }
    return items;
  }

  /** 触屏点击：暂停菜单 / 跳关胶囊 / 联机观战与结算按钮 */
  private handleTap(x: number, y: number) {
    const inRect = (b: { x: number; y: number; w: number; h: number } | null) =>
      !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

    if (this.mode === 'ONLINE') {
      // 结算界面：三个出口 + 排行详情；其余点击不穿透，避免误触背后的比赛
      if (this.settled) {
        if (inRect(this.settleLobbyBtn)) {
          this.game.audio.playUIClick();
          this.exitToLobby();
          return;
        }
        if (inRect(this.settleRematchBtn)) {
          this.game.audio.playUIClick();
          this.requestRematch();
          return;
        }
        if (inRect(this.settleRankBtn)) {
          this.game.audio.playUIClick();
          this.rankExpanded = !this.rankExpanded;
          return;
        }
        return;
      }
      // 观战界面：切换目标 / 平移视角 / 房主结束·重赛 / 非房主退出
      if (this.state === 'FINISHED') {
        if (inRect(this.spectatePrevBtn)) {
          this.game.audio.playUIClick();
          this.shiftSpectate(-1);
          return;
        }
        if (inRect(this.spectateNextBtn)) {
          this.game.audio.playUIClick();
          this.shiftSpectate(1);
          return;
        }
        if (inRect(this.spectateExitBtn)) {
          this.game.audio.playUIClick();
          online.leaveRoomRemote();
          this.disposed = true;
          this.game.switchScene(new OnlineLobbyScene(this.game));
          return;
        }
        if (inRect(this.rematchBtn)) {
          this.game.audio.playUIClick();
          online.rematch();
          this.disposed = true;
          this.game.switchScene(new OnlineLobbyScene(this.game));
          return;
        }
        if (inRect(this.finishBtn)) {
          this.game.audio.playUIClick();
          online.backToLobby();
          this.disposed = true;
          this.game.switchScene(new OnlineLobbyScene(this.game));
          return;
        }
        // 点排行行 = 直接切到该玩家观战
        for (const row of this.spectateRowRects) {
          if (inRect(row.rect)) {
            this.game.audio.playUIClick();
            this.selectSpectate(row.id);
            return;
          }
        }
        return;
      }
      // 快捷短语（比赛中）
      if (this.state === 'PLAYING') {
        for (let i = 0; i < this.phraseRects.length; i++) {
          if (inRect(this.phraseRects[i])) {
            this.game.audio.playUIClick();
            online.sendPhrase(i);
            return;
          }
        }
      }
    }
    // 触屏跳关胶囊（游玩中即可点击）
    if (this.state === 'PLAYING' && this.skipBtnRect) {
      const b = this.skipBtnRect;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        this.game.audio.playUIClick();
        this.requestSkip();
        return;
      }
    }
    if (this.state !== 'PAUSED') return;
    // 左上角：返回主菜单
    if (x >= 12 && x <= 118 && y >= 12 && y <= 54) {
      this.game.audio.playUIClick();
      this.game.switchScene(new MenuScene(this.game));
      return;
    }
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;
    const items = this.pauseItems();
    for (let i = 0; i < items.length; i++) {
      const cy = H / 2 + i * 50;
      if (Math.abs(x - W / 2) < 170 && Math.abs(y - cy) < 26) {
        this.pausedSelection = i;
        this.execPauseSelection();
        return;
      }
    }
  }

  /* ---------------- 联机观战 / 结算 ---------------- */

  /** 回大厅：房主广播结束比赛，其他人只把自己移出房间（避免留下幽灵席位） */
  private exitToLobby() {
    if (online.isHost) online.backToLobby();
    else online.leaveRoomRemote();
    this.disposed = true;
    this.game.switchScene(new OnlineLobbyScene(this.game));
  }

  /** 再来一局：只有房主能发起，非房主提示等待（房主重赛后会自动跟随回大厅） */
  private requestRematch() {
    if (!online.isHost) {
      this.showBanner('等待房主发起重赛…', 2.5);
      return;
    }
    online.rematch();
    this.disposed = true;
    this.game.switchScene(new OnlineLobbyScene(this.game));
  }

  /** 当前可观战的人（还在跑 → 已完赛 → 掉线） */
  private spectateCandidatesNow(): string[] {
    const positions = new Map<string, number>();
    for (const p of online.players) {
      positions.set(p.id, p.id === online.selfId ? this.player.x : (online.remoteStates.get(p.id)?.x ?? 0));
    }
    return spectateCandidates(online.players, online.selfId, online.finishTimes, positions);
  }

  /** 切换观战目标；目标为空/已退出时由 cycleSpectate 回退，不会越界 */
  private shiftSpectate(dir: number) {
    const list = this.spectateCandidatesNow();
    const next = cycleSpectate(this.spectateId, list, dir);
    if (next && next !== this.spectateId) {
      this.spectateId = next;
      this.spectatePan = 0;
    }
  }

  private selectSpectate(id: string) {
    if (!id || id === online.selfId) return;
    if (!this.spectateCandidatesNow().includes(id)) return;
    this.spectateId = id;
    this.spectatePan = 0;
  }

  private panSpectate(delta: number) {
    this.spectatePan = Math.max(-SPECTATE_PAN_MAX, Math.min(SPECTATE_PAN_MAX, this.spectatePan + delta));
  }

  /** 观战相机：跟随观战目标 + 手动平移；目标无状态时退回自己的终点位置 */
  private updateSpectateCamera(dt: number) {
    const st = this.spectateId ? online.remoteStates.get(this.spectateId) : undefined;
    const anchorX = st ? st.x : this.player.x;
    const targetX = Math.max(0, anchorX - GAME_CONFIG.CANVAS_WIDTH * GAME_CONFIG.CAMERA_OFFSET_X + this.spectatePan);
    const k = 1 - Math.exp(-GAME_CONFIG.CAMERA_SMOOTH * dt);
    this.cameraX += (targetX - this.cameraX) * k;
    this.cameraX = Math.max(0, this.cameraX);
  }

  /** 记录对手推进时刻（用于“有人一直不动”的等待超时） */
  private refreshSpectateTracking(now: number) {
    for (const p of online.players) {
      if (p.id === online.selfId) continue;
      const st = online.remoteStates.get(p.id);
      const prev = this.spectateSeenX.get(p.id);
      if (st && (prev === undefined || st.x > prev + 2)) {
        if (prev !== undefined) this.stallAt.set(p.id, now);
        this.spectateSeenX.set(p.id, st.x);
      } else if (prev === undefined) {
        this.spectateSeenX.set(p.id, st?.x ?? 0);
      }
      if (!this.stallAt.has(p.id)) this.stallAt.set(p.id, now);
    }
  }

  /** 完赛后的每帧：观战输入、进度跟踪、结算判定（不读移动输入，避免影响比赛） */
  private updateFinished(dt: number) {
    const input = this.game.input;
    this.particles.update(dt);
    if (this.bannerTimer > 0) this.bannerTimer -= dt;
    if (this.phraseMsg && Date.now() > this.phraseUntil) this.phraseMsg = '';

    if (this.settled) {
      // 结算界面：键盘出口，触屏之外也能离开
      if (input.isKeyPressed('Enter')) {
        this.game.audio.playUIClick();
        this.exitToLobby();
        return;
      }
      if (input.isKeyPressed('KeyR')) {
        this.requestRematch();
        return;
      }
      if (input.isKeyPressed('KeyL')) {
        this.rankExpanded = !this.rankExpanded;
        this.game.audio.playUIClick();
      }
      return;
    }

    // 观战：←→/AD 平移视角，↑↓/WS 切换对象，1–4 直选，L 复位视角
    const now = Date.now();
    if (input.isKeyDown('ArrowLeft') || input.isKeyDown('KeyA')) this.panSpectate(-SPECTATE_PAN_SPEED * dt);
    if (input.isKeyDown('ArrowRight') || input.isKeyDown('KeyD')) this.panSpectate(SPECTATE_PAN_SPEED * dt);
    if (input.isKeyPressed('ArrowUp') || input.isKeyPressed('KeyW')) this.shiftSpectate(-1);
    if (input.isKeyPressed('ArrowDown') || input.isKeyPressed('KeyS')) this.shiftSpectate(1);
    if (input.isKeyPressed('KeyL')) this.spectatePan = 0;
    for (let i = 0; i < 4; i++) {
      if (input.isKeyPressed(`Digit${i + 1}`)) {
        const id = this.spectateCandidatesNow()[i];
        if (id) this.selectSpectate(id);
      }
    }

    // 目标已退出/被移除：回退到仍在场的第一个候选，避免相机停在空处
    if (this.spectateId) {
      const list = this.spectateCandidatesNow();
      if (!list.includes(this.spectateId)) {
        this.spectateId = list[0] ?? '';
        this.spectatePan = 0;
      }
    }

    this.refreshSpectateTracking(now);
    this.updateSpectateCamera(dt);
    this.sendOnlineState(dt);
    this.tickSettle();
  }

  /** 结算判定用的玩家列表：刚掉线（30 秒重连窗口内）的人仍按“在场”算 */
  private playersWithDisconnectGrace(now: number) {
    for (const p of online.players) {
      if (p.disconnected) {
        if (!this.remoteDiscAt.has(p.id)) this.remoteDiscAt.set(p.id, now);
      } else {
        this.remoteDiscAt.delete(p.id);
      }
    }
    return withDisconnectGrace(online.players, this.remoteDiscAt, now);
  }

  /** 结算判定：服务端 race_end 优先；否则本地兜底（全员完赛/掉线/挂机超时） */
  private tickSettle() {
    const now = Date.now();
    if (online.raceOver) {
      const r = online.raceEndReason;
      this.enterSettlement(r === 'timeout' ? 'timeout' : (r === 'left' ? 'left' : 'all_finished'));
      return;
    }
    const players = this.playersWithDisconnectGrace(now);
    const stalled = stalledUnfinished(
      players, online.selfId, online.finishTimes, this.stallAt, now, RACE_STALL_MS,
    );
    if (stalled.length > 0) {
      this.enterSettlement('timeout');
      return;
    }
    if (isRaceSettled(players, online.selfId, true, online.finishTimes)) {
      this.enterSettlement(settleReasonOf(players, online.selfId, online.finishTimes, false));
      return;
    }
    // 自己掉线时看不到任何进度：重连窗口彻底失败后强制结算，避免永远停在观战
    if (online.reconnecting) {
      if (this.disconnectedAt === 0) this.disconnectedAt = now;
      else if (now - this.disconnectedAt >= SETTLE_TIMEOUT_MS) this.enterSettlement('left');
    } else {
      this.disconnectedAt = 0;
    }
  }

  private enterSettlement(reason: SettleReason) {
    if (this.settled) return;
    this.settled = true;
    this.settleReason = reason;
    this.spectateDragX = null;
    this.spectateId = '';
    // 服务端结算结果优先补全成绩；旧服务端没有 race_end 时退回本地缓存
    const times = new Map<string, number>(online.finishTimes);
    for (const r of online.raceResults) {
      if (r.finished && !times.has(r.id)) times.set(r.id, r.time);
    }
    const positions = new Map<string, number>();
    for (const p of online.players) {
      positions.set(p.id, p.id === online.selfId ? this.player.x : (online.remoteStates.get(p.id)?.x ?? 0));
    }
    const selfTime = times.get(online.selfId) ?? this.time;
    this.settleRows = buildStandings(
      online.players, online.selfId, this.selfFinished, selfTime, times, positions,
    );
    this.game.audio.playWin();
  }

  /** 跳关：首次请求进入 3 秒确认窗口，第二次才真正执行 */
  private requestSkip(): boolean {
    if (this.mode !== 'NORMAL' || !this.showSkipHint || this.save.data.skipCharges <= 0) return false;
    if (Date.now() <= this.skipConfirmUntil) {
      return this.doSkip();
    }
    this.skipConfirmUntil = Date.now() + GAME_CONFIG.CONFIRM_WINDOW * 1000;
    this.showBanner(`再点一次跳过本关（${GAME_CONFIG.CONFIRM_WINDOW.toFixed(0)} 秒内有效）`, 2.2);
    return false;
  }

  private doSkip(): boolean {
    if (!this.save.recordSkip(this.level.id)) return false;
    this.skipConfirmUntil = -1;
    this.game.audio.playUIClick();
    const next = getLevel(this.level.id + 1);
    if (next) this.game.switchScene(new GameScene(this.game, { levelId: next.id }));
    else this.game.switchScene(new LevelSelectScene(this.game));
    return true;
  }

  /** 当前星级（通关时计算并缓存） */
  private starResultNow(): StarResult {
    return computeStars({
      cleared: true,
      totalGems: this.totalGems,
      collectedGems: this.collectedGems,
      maxCombo: this.runMaxCombo,
      targetCombo: this.level.maxCombo,
    });
  }

  private respawn(first = false) {
    const sx = first ? 100 : this.checkpointX;
    const sy = GAME_CONFIG.GROUND_Y - GAME_CONFIG.PLAYER_SIZE;
    this.player.reset(sx, sy);
    // 复活位置可能大幅回退：同步重置联机进度基线并立刻上报，避免远端看到“尸体位置”超前
    if (this.mode === 'ONLINE') {
      online.resetSendBaseline();
      this.onlineStateTimer = 1;
    }
    // 检查点关卡（教程）复活给 1 秒无敌（尖刺免伤，柱子恒致命不变），避免复活即死循环
    if (!first && this.level.checkpoints) this.player.invincibleTime = 1.0;
    this.particles.clear();
    this.hitStop = 0;
    this.colorBlockAt.clear();
    this.cameraX = Math.max(0, sx - 200);
    this.state = 'PLAYING';
    // 检查点复活：保留检查点之前已收集的晶片/星核（自动奔跑无法回头重拾）
    const keepBehind = !first && !!this.level.checkpoints;
    for (const o of this.obstacles) {
      if (keepBehind && (o.kind === 'COLLECTIBLE' || o.kind === 'SPECIAL_ITEM') && o.x < sx) {
        continue;
      }
      o.triggered = false;
      o.collected = false;
      o.locked = false;
      o.rewarded = false;
      o.rainHits = 0;
    }
    this.activeLockGate = null;
    this.lockPenalties.clear();
    // 重生点之前的障碍直接标记为已越过：不清空后放任回溯，否则首帧会把
    // 检查点之前的同色尖刺/灰墙/摆锤一次性补计成连击。
    this.passedObstacles.clear();
    for (const o of this.obstacles) {
      if (o.x + o.w < sx) this.passedObstacles.add(o);
    }
    this.milestoneHit.clear();
    this.flippedSurvivalTime = 0;
    this.collectedGems = this.obstacles.filter(o => o.kind === 'COLLECTIBLE' && o.collected).length;
    this.starCollected = this.obstacles.some(o => o.kind === 'SPECIAL_ITEM' && o.collected);
    if (first) {
      this.time = 0;
      this.checkpointX = 100;
    }
  }

  /** 无尽模式：向前增量生成 + 回收远处障碍 */
  private extendEndless(targetX: number) {
    if (!this.generator) return;
    const configs = this.generator.produceUntil(targetX);
    for (const c of configs) this.obstacles.push(new Obstacle(c));
    // 回收屏幕后方很远的障碍，控制内存
    const cutoff = this.cameraX - 1200;
    if (this.obstacles.length > 0 && this.obstacles[0].x < cutoff) {
      const kept = this.obstacles.filter(o => xOf(o) >= cutoff);
      for (const o of this.obstacles) {
        if (xOf(o) < cutoff) this.passedObstacles.delete(o);
      }
      this.obstacles = kept;
    }
  }

  private showBanner(text: string, dur = 1.6) {
    this.bannerText = text;
    this.bannerTimer = dur;
  }

  /** M02 门廊内强按换色：拒绝 + 扣连击 + 加冷却（每道门最多 2 次） */
  private onLockedSwitchAttempt(gate: Obstacle) {
    const used = this.lockPenalties.get(gate) ?? 0;
    if (used >= MECH.LOCK.maxPenalties) {
      this.showBanner('极性锁：换色被拒绝', 0.9);
      return;
    }
    this.lockPenalties.set(gate, used + 1);
    this.player.combo = Math.max(0, this.player.combo - MECH.LOCK.comboPenalty);
    this.player.switchCooldown = Math.max(this.player.switchCooldown, MECH.LOCK.cooldownPenalty);
    this.particles.sparks(this.player.centerX, this.player.centerY, COLORS.GRAY, 6);
    this.game.renderer.shake.trigger(2, 5);
    this.showBanner(`极性锁：换色被拒绝 −${MECH.LOCK.comboPenalty} 连击`, 1.2);
  }

  private die() {
    if (!this.player.alive) return;
    this.player.die();
    this.state = 'DYING';
    this.deathTimer = 0;
    this.consecutiveDeaths++;
    this.deathsInLevel++;
    this.flippedSurvivalTime = 0;
    if (this.mode === 'NORMAL' && this.consecutiveDeaths >= GAME_CONFIG.SKIP_THRESHOLD) {
      this.showSkipHint = true;
    }
    this.particles.deathBurst(this.player.centerX, this.player.centerY, polarityColor(this.player.polarity));
    this.game.renderer.shake.trigger(5, 10);
    this.flashAlpha = 0.12;
    // 顿帧 60ms：撞击瞬间冻结，紧接着碎片炸开（联机不做，避免本地掉帧影响同局公平）
    if (this.mode !== 'ONLINE') this.hitStop = 0.06;
    this.game.audio.playDeath();
  }

  private win() {
    if (this.mode === 'ONLINE') {
      if (this.state === 'FINISHED') return;
      this.state = 'FINISHED';
      this.selfFinished = true;
      this.starResult = this.starResultNow();
      // 观战初始化：以完赛时刻作为“对手多久没前进”的计时起点
      const now = Date.now();
      this.spectateSeenX.clear();
      this.stallAt.clear();
      for (const p of online.players) {
        if (p.id === online.selfId) continue;
        this.stallAt.set(p.id, now);
        this.spectateSeenX.set(p.id, online.remoteStates.get(p.id)?.x ?? 0);
      }
      this.disconnectedAt = 0;
      this.spectateId = this.spectateCandidatesNow()[0] ?? '';
      this.spectatePan = 0;
      if (!this.onlineSentFinish) {
        this.onlineSentFinish = true;
        online.sendFinish(this.time);
      }
      // 完赛后不再需要虚拟按键：切菜单布局，才能拖动画面 / 点排行行与出口按钮
      this.game.input.setTouchLayout('menu');
      this.game.audio.playWin();
      return;
    }
    this.state = 'WINNING';
    this.game.audio.playWin();
    this.game.audio.stopMusic();

    if (this.mode === 'NORMAL') {
      const sr = this.starResultNow();
      this.starResult = sr;
      const isNewRecord = this.save.recordCompletion(
        this.level.id, this.time, this.runMaxCombo, sr.stars, this.deathsInLevel === 0,
      );
      this.game.achievements?.onLevelComplete(this.level.id, this.time, this.deathsInLevel, this.usedBoostThisLevel);
      setTimeout(() => {
        if (this.resultSent || this.disposed) return;
        this.resultSent = true;
        const next = getLevel(this.level.id + 1);
        this.game.switchScene(new ResultScene(this.game, {
          mode: 'NORMAL',
          level: this.level,
          clearTime: this.time,
          combo: this.runMaxCombo,
          isNewRecord,
          stars: sr.stars,
          starDetail: sr,
          primary: next
            ? { label: '下一关', factory: () => new GameScene(this.game, { levelId: next.id }) }
            : { label: '关卡选择', factory: () => new LevelSelectScene(this.game) },
          secondary: { label: '关卡选择', factory: () => new LevelSelectScene(this.game) },
          tertiary: { label: '主菜单', factory: () => new MenuScene(this.game) },
        }));
      }, 800);
    } else if (this.mode === 'SPECIAL') {
      if (this.level.id === 200) {
        this.save.data.easterEggCompleted = true;
        this.save.save();
      } else {
        this.save.recordSpecialClear(this.level.id);
      }
      const from = this.opts.enterFrom;
      setTimeout(() => {
        if (this.resultSent || this.disposed) return;
        this.resultSent = true;
        this.game.switchScene(new ResultScene(this.game, {
          mode: 'SPECIAL',
          level: this.level,
          clearTime: this.time,
          combo: this.runMaxCombo,
          isNewRecord: false,
          info: this.level.id === 200
            ? '✦ 你征服了磁极圣殿！'
            : (this.starCollected ? '✦ 星核已回收' : '特殊关卡完成'),
          primary: from
            ? { label: '返回原关卡', factory: () => new GameScene(this.game, { resume: from }) }
            : { label: '主菜单', factory: () => new MenuScene(this.game) },
          secondary: { label: '再战一次', factory: () => this.buildReplay() },
          tertiary: { label: '主菜单', factory: () => new MenuScene(this.game) },
        }));
      }, 800);
    } else {
      // 自定义关卡 / 新手教程（id 0）
      const isTutorial = this.level.id === 0;
      if (isTutorial && !this.save.data.tutorialDone) {
        this.save.data.tutorialDone = true;
        this.save.save();
      }
      setTimeout(() => {
        if (this.resultSent || this.disposed) return;
        this.resultSent = true;
        this.game.switchScene(new ResultScene(this.game, {
          mode: 'CUSTOM',
          level: this.level,
          clearTime: this.time,
          combo: this.runMaxCombo,
          isNewRecord: false,
          info: isTutorial ? '教程完成！正式关卡现在开始' : undefined,
          primary: isTutorial
            ? { label: '进入第 1 关', factory: () => new GameScene(this.game, { levelId: 1 }) }
            : { label: '重玩', factory: () => this.buildReplay() },
          secondary: isTutorial
            ? { label: '重玩教程', factory: () => this.buildReplay() }
            : {
              label: '返回',
              factory: () => this.opts.returnScene ? this.opts.returnScene() : new MenuScene(this.game),
            },
          tertiary: { label: '主菜单', factory: () => new MenuScene(this.game) },
        }));
      }, 800);
    }
  }

  private buildReplay(): Scene {
    if (this.mode === 'ENDLESS') return new GameScene(this.game, { endless: true });
    if (this.mode === 'DAILY') return new GameScene(this.game, { daily: true });
    if (this.mode === 'SPECIAL') {
      return new GameScene(this.game, { def: this.opts.def, enterFrom: this.opts.enterFrom });
    }
    if (this.mode === 'CUSTOM') {
      return new GameScene(this.game, {
        def: this.opts.def,
        customData: this.opts.customData,
        returnScene: this.opts.returnScene,
      });
    }
    return new GameScene(this.game, { levelId: this.level.id });
  }

  private endEndlessRun() {
    if (this.resultSent) return;
    this.resultSent = true;
    const distance = Math.round(this.player.x / 50); // 50px = 1m
    const isRecord = this.time > this.save.data.endlessBestTime;
    this.save.recordEndless(this.time, this.player.x, this.runMaxCombo);
    this.game.achievements?.onEndlessRun(this.time, this.player.x);
    this.game.audio.stopMusic();
    this.game.switchScene(new ResultScene(this.game, {
      mode: 'ENDLESS',
      level: this.level,
      clearTime: this.time,
      combo: this.runMaxCombo,
      isNewRecord: isRecord,
      distance,
      bestTime: this.save.data.endlessBestTime,
      bestDistance: Math.round(this.save.data.endlessBestDistance / 50),
      primary: { label: '再来一次', factory: () => new GameScene(this.game, { endless: true }) },
      secondary: { label: '主菜单', factory: () => new MenuScene(this.game) },
      tertiary: { label: '关卡选择', factory: () => new LevelSelectScene(this.game) },
    }));
  }

  /** 每日挑战结算（死亡或 3 分钟到） */
  private endDailyRun(finished: boolean) {
    if (this.resultSent) return;
    this.resultSent = true;
    const distance = Math.round(this.player.x / 50);
    const rec = this.save.recordDaily(this.player.x, this.time, this.runMaxCombo);
    this.game.achievements?.onDailyRun(rec.streak);
    this.game.audio.stopMusic();
    this.game.switchScene(new ResultScene(this.game, {
      mode: 'DAILY',
      level: this.level,
      clearTime: this.time,
      combo: this.runMaxCombo,
      isNewRecord: rec.newRecord,
      distance,
      bestDistance: Math.round(this.save.data.daily.bestDistance / 50),
      bestTime: this.save.data.daily.bestTime,
      info: finished ? '3 分钟到！每日挑战完成' : '挑战结束',
      daily: {
        firstCompletion: rec.firstCompletion,
        streak: rec.streak,
        coresAwarded: rec.coresAwarded,
        modifiers: this.dailyMods,
      },
      primary: { label: '再来一次', factory: () => new GameScene(this.game, { daily: true }) },
      secondary: { label: '主菜单', factory: () => new MenuScene(this.game) },
      tertiary: { label: '关卡选择', factory: () => new LevelSelectScene(this.game) },
    }));
  }

  update(dt: number) {
    const input = this.game.input;

    if (input.isPressed('PAUSE')) {
      if (this.state === 'PLAYING') {
        this.state = 'PAUSED'; this.pausedSelection = 0;
        this.game.input.setTouchLayout('menu');
        this.game.audio.playUIClick();
      }
      else if (this.state === 'PAUSED') {
        this.state = 'PLAYING';
        this.game.input.setTouchLayout('game');
        this.game.audio.playUIClick();
      }
      return;
    }

    if (this.state === 'PAUSED') {
      this.updatePauseMenu();
      return;
    }

    // 死亡顿帧：撞击瞬间冻结世界与粒子，让“碎了”这件事被看见
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      return;
    }

    if (this.state === 'WINNING') {
      this.particles.update(dt);
      return;
    }

    if (this.state === 'COUNTDOWN') {
      // 用服务器时钟校正倒计时：本地时钟快 3 秒也不允许抢跑
      const remaining = Math.ceil((this.onlineStartAt - online.now()) / 1000);
      if (remaining <= 0) {
        this.state = 'PLAYING';
        this.time = 0;
        this.game.audio.playUIClick();
      }
      this.particles.update(dt);
      return;
    }

    if (this.state === 'FINISHED') {
      this.updateFinished(dt);
      return;
    }

    if (this.state === 'DYING') {
      this.deathTimer += dt;
      this.particles.update(dt);
      // 死亡动画期间继续广播 alive=false：远端立刻隐藏本体，不留空壳
      if (this.mode === 'ONLINE') this.sendOnlineState(dt);
      if (this.deathTimer >= GAME_CONFIG.RESPAWN_DELAY) {
        if (this.mode === 'ENDLESS') this.endEndlessRun();
        else if (this.mode === 'DAILY') this.endDailyRun(false);
        else this.respawn();
      }
      this.updateCamera(dt);
      return;
    }

    // ---- PLAYING ----
    this.time += dt;
    if (this.bannerTimer > 0) this.bannerTimer -= dt;

    // 每日挑战：倒计时结束即结算
    if (this.mode === 'DAILY' && this.time >= this.dailyEndAt) {
      this.endDailyRun(true);
      return;
    }

    // 无尽 / 每日：磁暴事件（跳过冷却，仅在事件期间提速）
    if (this.mode === 'ENDLESS' || this.mode === 'DAILY') {
      this.updateStorm();
    }

    // 检查点：推进到最近已过的教学段起点（仅定义了 checkpoints 的关卡生效）
    const cps = this.level.checkpoints;
    if (cps) {
      const px = this.player.x;
      for (const cp of cps) {
        if (px >= cp && cp > this.checkpointX) this.checkpointX = cp;
      }
    }

    // 联机：发送状态
    if (this.mode === 'ONLINE') {
      this.sendOnlineState(dt);
    }

    // 无尽 / 每日：速度随时间递增（每40秒 +8%，上限 2.0x；磁暴期额外 +12%）
    if (this.mode === 'ENDLESS' || this.mode === 'DAILY') {
      let mul = Math.min(
        GAME_CONFIG.ENDLESS_MAX_SPEED_FACTOR,
        1 + Math.floor(this.time / GAME_CONFIG.ENDLESS_SPEED_STEP_SECONDS) * GAME_CONFIG.ENDLESS_SPEED_STEP,
      );
      if (this.mode === 'DAILY') mul *= this.dailySpeedMul;
      if (this.stormActive) mul += GAME_CONFIG.ENDLESS_STORM_SPEED_BONUS;
      this.player.externalSpeedMul = mul;
      this.extendEndless(this.player.x + 2600);
    }

    // 联机快捷短语（键盘 1–4；触屏由 HUD 胶囊处理）
    if (this.mode === 'ONLINE') {
      for (let i = 0; i < QUICK_PHRASES.length; i++) {
        if (input.isKeyPressed(`Digit${i + 1}`)) online.sendPhrase(i);
      }
      if (this.phraseMsg && Date.now() > this.phraseUntil) this.phraseMsg = '';
    }

    // 跳关（仅普通关卡）：K 与触屏共用二次确认
    if (this.mode === 'NORMAL' && input.isKeyPressed('KeyK')) {
      this.requestSkip();
    }

    const p = this.player;

    if (input.isPressed('SWITCH')) {
      if (blocksSwitch(p.polarityLockTimer)) {
        if (this.activeLockGate) this.onLockedSwitchAttempt(this.activeLockGate);
      } else if (p.switchPolarity()) {
        this.game.audio.playSwitch(p.polarity);
        this.particles.switchRing(p.centerX, p.centerY, polarityColor(p.polarity));
        this.checkComboMilestone();
        this.game.achievements?.onSwitch(p.combo, this.time - this.lastPortalTime < 0.5);
      }
    }
    if (input.isPressed('JUMP')) {
      if (p.jump()) this.game.audio.playJump();
    }
    if (input.isPressed('SLIDE')) {
      if (p.slide()) this.game.audio.playSlide();
    }

    // 动态障碍（摆锤 / 移动浮台）：先于碰撞、磁力与支撑判定更新
    const prevBottom = p.y + p.height;
    let carryDy = 0;
    let carried = false;
    for (const o of this.obstacles) {
      if (o.kind !== 'PENDULUM' && o.kind !== 'MOVING_PLATFORM' && o.kind !== 'POLARITY_WALL') continue;
      const prevTop = o.y + o.oy;
      o.updateMotion(this.time);
      // 垂直浮台携带玩家：只认“真正支撑玩家”的那一块。
      // 必须同时满足：垂直往复、水平投影重叠、玩家脚底贴合旧顶面、正在下落。
      // 否则高度区间重叠的多个平台会把 dy 累加，产生“幻影携带”。
      if (!carried && o.kind === 'MOVING_PLATFORM' && p.alive
        && carriesPlayer({
          prevBottom, prevTop,
          axis: (o.meta?.axis ?? 'y') as 'x' | 'y',
          vy: p.vy,
          playerLeft: p.x, playerRight: p.x + p.width,
          platLeft: o.x + o.ox, platW: o.w,
        })) {
        carryDy = (o.y + o.oy) - prevTop;
        carried = true;
      }
    }
    if (carried) p.y += carryDy;

    // M06 极性传送带：在玩家位移前注入水平附加速度
    if (p.alive) {
      for (const o of this.obstacles) {
        if (o.kind !== 'CONVEYOR') continue;
        const b = o.bounds;
        if (p.x + p.width > b.x && p.x < b.x + b.w
          && p.y + p.height >= b.y - 2 && p.y <= b.y + b.h) {
          p.conveyorVx += (o.meta?.speed ?? MECH.CONVEYOR.speed) * (o.meta?.dir ?? 1);
        }
      }
    }

    // 收集玩家附近的浮空平台顶面（供单向支撑判定）
    // 复用缓冲区与 AABB，避免每帧为每个平台新建对象（GC 抖动）
    this.platBuf.length = 0;
    for (const o of this.obstacles) {
      if ((o.kind === 'PLATFORM' || o.kind === 'MOVING_PLATFORM')
        && o.x + o.ox < p.x + 120 && o.x + o.ox + o.w > p.x - 80) {
        const idx = this.platBuf.length;
        let slot = this.platPool[idx];
        if (!slot) {
          slot = { x: 0, y: 0, w: 0, h: 0 };
          this.platPool[idx] = slot;
        }
        slot.x = o.x + o.ox;
        slot.y = o.y + o.oy;
        slot.w = o.w;
        slot.h = o.h;
        this.platBuf.push(slot);
      }
    }
    const { landed } = p.update(dt, GAME_CONFIG.GROUND_Y, GAME_CONFIG.CEILING_Y, this.platBuf);
    if (landed) this.game.audio.playLand();

    // 磁暴摆锤：异极相吸、同极相斥（仅施垂直力，不破坏自动奔跑）
    this.applyPendulumForces(dt);

    // 重力翻转存活计时（单局累计，死亡才清零；供“违抗重力”成就判定）
    if (p.gravityFlipped && p.alive) {
      this.flippedSurvivalTime += dt;
      this.game.achievements?.onFlippedTime(this.flippedSurvivalTime);
    }

    if (p.consumeTrail() && p.alive) {
      const trailCount = p.combo >= 10 ? 2 : 1;
      const color = p.combo >= 50 ? rainbow(this.time) : polarityColor(p.polarity);
      this.particles.trail(p.x, p.centerY, color, trailCount);
      if (p.speedBoostTimer > 0) this.particles.boostStreak(p.x + 20, p.centerY, COLORS.SPEED_BOOST);
    }

    this.updateFinishHint();
    this.checkObstacles();
    this.particles.update(dt);
    this.updateCamera(dt);
    this.flashAlpha = Math.max(0, this.flashAlpha - dt * 2);
  }

  /** 磁暴事件：每 N 秒来一次，持续 12 秒；期间速度 +12% */
  private updateStorm() {
    if (this.stormActive) {
      if (this.time >= this.stormEndsAt) {
        this.stormActive = false;
        this.stormNextAt = this.time + this.dailyStormInterval;
        this.showBanner('磁暴结束', 1.4);
      }
      return;
    }
    if (this.time >= this.stormNextAt) {
      this.stormActive = true;
      this.stormEndsAt = this.time + GAME_CONFIG.ENDLESS_STORM_DURATION;
      this.showBanner('⚠ 磁暴来袭：注意摆锤', 1.8);
      this.game.renderer.shake.trigger(4, 12);
    }
  }

  /** 终点前 900px 的一次性晶片提示（缺片只影响 ★2，不再重开） */
  private updateFinishHint() {
    if (this.mode !== 'NORMAL' || this.finishHintShown) return;
    const finishX = this.level.obstacles.find(o => o.kind === 'FINISH')?.x;
    if (!finishX) return;
    if (this.player.x < finishX - GAME_CONFIG.FINISH_GEM_HINT_DISTANCE) return;
    this.finishHintShown = true;
    const missing = this.totalGems - this.collectedGems;
    this.showBanner(
      missing > 0
        ? `终点在前！还缺 ${missing} 枚晶片（只影响 ★2）`
        : '终点在前！晶片已集齐',
      2.2,
    );
  }

  /** 有效事件加连击（切换极性不再加分） */
  private addCombo(n = 1) {
    const p = this.player;
    p.combo += n;
    if (p.combo > this.runMaxCombo) this.runMaxCombo = p.combo;
    this.checkComboMilestone();
  }

  private applyPendulumForces(dt: number) {
    const p = this.player;
    const range = MECH.PEND.magnetRange;
    for (const o of this.obstacles) {
      if (o.kind !== 'PENDULUM') continue;
      // 冷态无磁力：只在充能窗口生效，配合预警给玩家明确反应窗口
      const dir = pendulumMagnetDir(o.polarity === p.polarity, o.isCharged);
      if (dir === 0) continue;
      const dx = o.ballCX - p.centerX;
      if (dx < -range || dx > range) continue;
      const dy = o.ballCY - p.centerY;
      const d = Math.hypot(dx, dy);
      if (d >= range || d < 0.001) continue;
      const strength = MECH.PEND.magnetForce * (1 - d / range) * 0.85;
      p.vy += dir * (dy / d) * strength * dt;
      const cap = GAME_CONFIG.MAX_FALL_SPEED;
      p.vy = Math.max(-cap, Math.min(cap, p.vy));
      // 水平耦合：同色被推离球体，异色被拉向球体（±40px/s，只改变节奏不直接致死）
      const towardBall = Math.sign(dx) || 1;
      p.magnetVx += (dir < 0 ? -towardBall : towardBall) * MECH.PEND.pushVx;
    }
  }

  private updatePauseMenu() {
    const input = this.game.input;
    const count = this.pauseItems().length;
    if (this.pausedSelection >= count) this.pausedSelection = 0;
    if (input.isKeyPressed('ArrowUp') || input.isKeyPressed('KeyW')) {
      this.pausedSelection = (this.pausedSelection + count - 1) % count;
      this.game.audio.playUIClick();
    } else if (input.isKeyPressed('ArrowDown') || input.isKeyPressed('KeyS')) {
      this.pausedSelection = (this.pausedSelection + 1) % count;
      this.game.audio.playUIClick();
    } else if (input.isKeyPressed('Enter')) {
      this.execPauseSelection();
    }
  }

  private execPauseSelection() {
    const items = this.pauseItems();
    const item = items[this.pausedSelection] ?? items[0];
    this.game.audio.playUIClick();
    switch (item.action) {
      case 'resume': {
        this.state = 'PLAYING';
        this.game.input.setTouchLayout('game');
        break;
      }
      case 'quit': {
        // 主动退出比赛：通知服务端移除席位（保留连接，回大厅后可直接再看房间）
        online.leaveRoomRemote();
        this.game.switchScene(new OnlineLobbyScene(this.game));
        break;
      }
      case 'replay': {
        this.game.switchScene(this.buildReplay());
        break;
      }
      case 'skip': {
        this.requestSkip();
        this.pausedSelection = Math.min(this.pausedSelection, this.pauseItems().length - 1);
        break;
      }
      case 'back':
      default: {
        if (this.mode === 'NORMAL') this.game.switchScene(new LevelSelectScene(this.game));
        else if (this.opts.returnScene) this.game.switchScene(this.opts.returnScene());
        else this.game.switchScene(new MenuScene(this.game));
        break;
      }
    }
  }

  private checkObstacles() {
    const p = this.player;
    const pb = p.bounds;
    const range = MECH.PEND.magnetRange;

    for (const o of this.obstacles) {
      // 视距外快速跳过；摆锤按摆球位置判定
      if (o.kind === 'PENDULUM') {
        if (o.ballCX < p.x - range || o.ballCX > p.x + range + 120) {
          if (o.ballCX < p.x - 40 && o.ballCX >= p.x - 400
            && !this.passedObstacles.has(o) && p.alive) {
            this.passedObstacles.add(o);
            this.addCombo();
          }
          continue;
        }
      } else {
        // 越过后记一次连击。判定必须早于「视距外快速跳过」，
        // 否则右边缘落在身后 100px 内的障碍会被整段 continue 掉，永远漏计连击。
        if (isWithinPassWindow(o.viewRight, p.x)
          && !this.passedObstacles.has(o) && p.alive) {
          if (o.kind === 'RED_SPIKE' || o.kind === 'BLUE_SPIKE') {
            // 只有同色且当时确实安全掠过/接触过才计数：
            // o.triggered 由同色掠过帧写入，避免之后改极性回溯补计。
            if (countsSafePass(o.polarity === p.polarity, o.triggered)) {
              this.passedObstacles.add(o);
              this.addCombo();
            }
          } else if (o.kind === 'WALL') {
            this.passedObstacles.add(o);
            this.addCombo();
          } else if (o.kind === 'POLARITY_WALL' && o.polarity === p.polarity && o.triggered) {
            this.passedObstacles.add(o);
            this.addCombo();
            this.save.addPhaseWallPassed(1);
            this.game.achievements?.onPhaseWall(this.save.data.phaseWallsPassed);
          }
        }
        if (o.viewLeft > p.x + 200 || o.viewRight < p.x - 100) continue;
      }

      switch (o.kind) {
        case 'RED_SPIKE':
        case 'BLUE_SPIKE': {
          const hits = Physics.AABBShrink(pb, o.bounds, 4);
          if (!hits) {
            // 跳过同色尖刺也算安全通过：在水平掠过的那一帧打标记，
            // 之后即使改极性也不会被“越过后补计”误算。
            if (o.polarity === p.polarity
              && pb.x + pb.w >= o.x && pb.x <= o.x + o.w) {
              o.triggered = true;
            }
            break;
          }
          if (o.polarity === p.polarity) {
            if (!o.triggered) {
              o.triggered = true;
              this.particles.sparks(p.centerX, p.centerY + 10, o.color, 5);
            }
          } else if (p.invincibleTime <= 0) {
            this.die();
            return;
          }
          break;
        }
        case 'WALL': {
          // 实体磁能柱：任何状态下撞上都死亡（无敌帧/切换容错不能穿过实体）
          if (Physics.AABBShrink(pb, o.bounds, 3)) {
            this.die();
            return;
          }
          break;
        }
        case 'COMBO_GATE': {
          const req = o.meta?.required ?? 10;
          if (o.triggered) break; // 已开启的门可安全穿过
          if (!Physics.AABBShrink(pb, o.bounds, 3)) break;
          if (p.combo >= req) {
            o.triggered = true;
            this.particles.comboBurst(p.centerX, p.centerY, COLORS.GRAVITY);
            this.game.audio.playPortal();
            this.showBanner(`连击 ×${req} 达成：捷径开启！`, 1.6);
          } else {
            // 连击不足：等同实体墙，即死
            this.die();
            return;
          }
          break;
        }
        case 'POLARITY_WALL': {
          if (o.triggered) break;
          if (!Physics.AABBShrink(pb, o.bounds, 2)) break;
          if (o.polarity === p.polarity) {
            // 同色穿过：标记 + 粒子；连击在越过时统一结算
            o.triggered = true;
            this.particles.sparks(p.centerX, p.centerY, o.color, 7);
          } else {
            // 异色立即致命，无视切换/传送无敌（FR-06 明确的硬规则）
            this.die();
            return;
          }
          break;
        }
        case 'PULSE_LASER': {
          // 仅激活态致死；预警/关闭可安全通过
          if (o.laserState(this.time) !== 2) break;
          if (Physics.AABBShrink(pb, o.bounds, 3) && p.invincibleTime <= 0) {
            this.die();
            return;
          }
          break;
        }
        case 'PENDULUM': {
          // M11 重做：同色永远免疫；异色仅在充能窗口 + 判定圆命中时致死，
          // 充能结束后的 0.15s 消磁保护避免“刚离开光束又被扫到”的随机死。
          const samePolarity = o.polarity === p.polarity;
          const overlapping = Physics.circleAABB(o.ballCX, o.ballCY, MECH.PEND.hitR, pb);
          const grace = p.invincibleTime > 0 || o.dischargeGrace > 0;
          if (pendulumLethal({ samePolarity, charged: o.isCharged, overlapping, grace })) {
            this.die();
            return;
          }
          break;
        }
        case 'PORTAL_A':
        case 'PORTAL_B': {
          if (o.triggered) break;
          if (!Physics.AABB(pb, o.bounds)) break;
          const target = this.obstacles.find(t => t !== o
            && t.kind === o.kind
            && t.meta?.portalId === o.meta?.portalId);
          if (!target) break;
          // 同色圆环配对，两端同时标记（一次性使用，防止来回弹）
          o.triggered = true;
          target.triggered = true;
          // 仅贴天花板的门算“高位门”（平台上门按地面门处理，不传天花板）
          const sourceHigh = o.y <= GAME_CONFIG.CEILING_Y + 8;
          const targetHigh = target.y <= GAME_CONFIG.CEILING_Y + 8;
          this.particles.portalSwirl(p.centerX, p.centerY, o.color);
          p.x = target.x + target.w / 2 - p.width / 2;
          p.vy = 0;
          if (sourceHigh !== targetHigh) p.applyGravityFlip();
          // 落地：高位门贴天花板；其余站门底（地面门=地面，平台门=平台面）
          p.y = targetHigh
            ? GAME_CONFIG.CEILING_Y
            : target.y + target.h - GAME_CONFIG.PLAYER_SIZE;
          p.invincibleTime = Math.max(p.invincibleTime, 0.35);
          this.lastPortalTime = this.time;
          this.particles.portalSwirl(p.centerX, p.centerY, target.color);
          this.game.audio.playPortal();
          this.addCombo(2);
          break;
        }
        case 'POLARITY_ZONE': {
          if (o.triggered) break;
          if (!Physics.AABB(pb, o.bounds)) break;
          o.triggered = true;
          const before = p.polarity;
          p.forcePolarity(o.meta?.forcedPolarity ?? (p.polarity === 'RED' ? 'BLUE' : 'RED'));
          if (p.polarity !== before) {
            this.particles.switchRing(p.centerX, p.centerY, polarityColor(p.polarity));
            this.game.audio.playPolarityZone();
            // 强制极性区：成功按区域要求切换（安全通过）+1
            this.addCombo();
          }
          break;
        }
        case 'GRAVITY_FLIP': {
          if (o.triggered) break;
          if (!Physics.AABB(pb, o.bounds)) break;
          o.triggered = true;
          p.applyGravityFlip();
          p.invincibleTime = Math.max(p.invincibleTime, 0.2);
          this.game.renderer.shake.trigger(4, 8);
          this.game.audio.playFlip();
          break;
        }
        case 'SPEED_BOOST': {
          if (o.triggered) break;
          if (!Physics.AABB(pb, o.bounds)) break;
          o.triggered = true;
          p.applyBoost(o.meta?.multiplier ?? 2, o.meta?.duration ?? 3);
          this.usedBoostThisLevel = true;
          // 加速瞬间轻推相机：速度变化要有体感，但仍尊重“画面震动”开关
          if (this.save.data.fxSpeed) this.game.renderer.shake.trigger(3, 8);
          this.game.audio.playBoost();
          break;
        }
        case 'COLLECTIBLE': {
          if (o.collected) break;
          if (!Physics.AABBShrink(pb, o.bounds, 5)) break;
          // 彩色晶片：极性不符时不吃，但必须有可见反馈（晃动 + 提示），不能静默穿过
          const need = o.meta?.color === 'RED' || o.meta?.color === 'BLUE' ? o.meta.color : null;
          if (need && need !== p.polarity) {
            const last = this.colorBlockAt.get(o) ?? -99;
            if (this.time - last > 1.2) {
              this.colorBlockAt.set(o, this.time);
              o.bumpUntil = this.time + 0.35;
              this.particles.sparks(o.x + o.w / 2, o.y + o.h / 2, polarityColor(need), 4);
              this.showBanner(`需要${need === 'RED' ? '红' : '蓝'}色极性才能拾取`, 0.9);
            }
            break;
          }
          o.collected = true;
          this.collectedGems++;
          if (o.meta?.currency) {
            // 无尽 / 每日的磁芯：写入累计磁芯，不计入关卡晶片
            this.save.data.cores += 1;
            this.save.save();
          }
          const gemColor = need ? polarityColor(need) : COLORS.COLLECTIBLE;
          this.particles.sparks(o.x + o.w / 2, o.y + o.h / 2, gemColor, 9);
          this.particles.switchRing(o.x + o.w / 2, o.y + o.h / 2, gemColor);
          this.game.audio.playCollect();
          this.addCombo();
          break;
        }
        case 'SPECIAL_ITEM': {
          if (o.collected) break;
          if (!Physics.AABBShrink(pb, o.bounds, 4)) break;
          o.collected = true;
          this.starCollected = true;
          this.addCombo();
          this.particles.comboBurst(p.centerX, p.centerY, COLORS.SPECIAL_ITEM);
          if (this.mode === 'SPECIAL') {
            const itemId = o.meta?.itemId;
            if (itemId) {
              const isNew = this.save.collectSpecialItem(itemId);
              if (isNew) {
                this.game.audio.playSpecialItem();
                this.game.toasts.push(o.meta?.itemName ?? '特殊星核', '特殊物品已回收', '核');
                if (this.save.easterEggUnlocked) {
                  this.game.toasts.push('磁极圣殿', '集齐三颗星核，彩蛋关卡解锁！', '殿');
                  this.game.audio.playAchievement();
                }
              } else {
                this.game.audio.playCollect();
              }
            } else {
              this.game.audio.playSpecialItem();
            }
          } else {
            // 自定义关卡中的星核仅作奖杯，不写入存档
            this.game.audio.playSpecialItem();
            this.showBanner('✦ 获得星核（自定义关卡）');
          }
          break;
        }
        case 'SPECIAL_DOOR': {
          if (o.triggered) break;
          if (!Physics.AABBShrink(pb, o.bounds, 4)) break;
          // 教程演示门：只展示与说明，不传送（横幅限频，避免每帧重复）
          if (o.meta?.demo === true) {
            if (this.bannerTimer <= 0.05) {
              this.showBanner('✦ 特殊星门：正式关卡中会通往隐藏特殊地图（此处仅演示）', 2);
              this.game.audio.playSpecialDoor();
            }
            break;
          }
          const targetId = o.meta?.targetId;
          if (!targetId) break;
          const specialDef = getSpecialLevel(targetId);
          if (!specialDef) break;
          o.triggered = true;
          this.game.audio.playSpecialDoor();
          this.particles.portalSwirl(p.centerX, p.centerY, COLORS.SPECIAL_DOOR);
          const snapshot: ResumeSnapshot = {
            levelId: this.level.id,
            playerX: p.x,
            playerY: p.y,
            vy: p.vy,
            polarity: p.polarity,
            gravityFlipped: p.gravityFlipped,
            combo: p.combo,
            runMaxCombo: this.runMaxCombo,
            time: this.time,
            cameraX: this.cameraX,
            collected: this.obstacles.map(ob => ob.collected),
            doorIndex: this.obstacles.indexOf(o),
          };
          this.game.switchScene(new GameScene(this.game, { def: specialDef, enterFrom: snapshot }));
          return;
        }
        case 'CONVEYOR':
          // 附加速度已在玩家位移前注入，无需碰撞处理
          break;
        case 'MAGNET_RAIN': {
          // M01 磁芯雨：同色可收集，异色穿过无惩罚
          if (!p.alive) break;
          const count = o.meta?.count ?? MECH.RAIN.count;
          const base: Polarity = o.meta?.polarity === 'BLUE' ? 'BLUE' : 'RED';
          const r = MECH.RAIN.hitRadius;
          for (let i = 0; i < count; i++) {
            if (o.rainHits & (1 << i)) continue;
            const cx = o.x + 20 + i * MECH.RAIN.gap;
            const cy = rainCoreY(this.time, i, GAME_CONFIG.CEILING_Y, GAME_CONFIG.GROUND_Y, MECH.RAIN.size);
            const core = { x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
            if (!Physics.AABB(pb, core)) continue;
            const corePolarity: Polarity = i % 2 === 0
              ? base
              : (base === 'RED' ? 'BLUE' : 'RED');
            if (!rainCoreMatches(corePolarity, p.polarity)) continue;
            o.rainHits |= 1 << i;
            this.save.data.cores += MECH.RAIN.cores;
            this.save.save();
            this.particles.sparks(cx, cy, corePolarity === 'RED' ? COLORS.RED : COLORS.BLUE, 7);
            this.game.audio.playCollect();
            this.addCombo(MECH.RAIN.combo);
          }
          break;
        }
        case 'POLARITY_LOCK': {
          // M02 极性锁：门廊内锁换色；安全穿出补给连击
          if (Physics.AABB(pb, o.bounds)) {
            o.triggered = true;
            this.activeLockGate = o;
            p.lockSwitch(0.1);
          } else if (this.activeLockGate === o) {
            this.activeLockGate = null;
            o.triggered = false;
            if (!o.rewarded && p.alive) {
              o.rewarded = true;
              this.addCombo(MECH.LOCK.exitBonus);
              this.particles.comboBurst(p.centerX, p.centerY, UI.color.lemon);
              this.showBanner(`穿出极性锁 · 连击 +${MECH.LOCK.exitBonus}`, 1.2);
            }
          }
          break;
        }
        case 'CORE_BAIT': {
          // M07 磁芯诱饵：磁芯币 + 连击，换色权锁定 1.2s
          if (o.collected) break;
          if (!Physics.AABBShrink(pb, o.bounds, 4)) break;
          o.collected = true;
          this.save.data.cores += MECH.BAIT.cores;
          this.save.save();
          p.lockSwitch(MECH.BAIT.switchLock);
          this.addCombo(MECH.BAIT.combo);
          this.particles.comboBurst(p.centerX, p.centerY, COLORS.COLLECTIBLE);
          this.game.audio.playCollect();
          this.showBanner(`磁芯诱饵 · 换色锁定 ${MECH.BAIT.switchLock}s`, 1.2);
          break;
        }
        case 'MAGNET_MIRROR': {
          // M09 磁极镜：强制反转一次（triggered 保证不会重复触发）
          if (!mirrorShouldTrigger(o.triggered)) break;
          if (!Physics.AABB(pb, o.bounds)) break;
          o.triggered = true;
          p.mirrorPolarity();
          this.addCombo(MECH.MIRROR.combo);
          this.particles.switchRing(p.centerX, p.centerY, polarityColor(p.polarity));
          this.game.audio.playSwitch(p.polarity);
          break;
        }
        case 'LAUNCH_PAD': {
          // M03 极性弹射板：同色高弹、异色低弹
          if (o.triggered) break;
          if (!Physics.AABBShrink(pb, o.bounds, 3)) break;
          o.triggered = true;
          const same = (o.meta?.polarity === 'BLUE' ? 'BLUE' : 'RED') === p.polarity;
          const force = same ? MECH.LAUNCH.sameVy : MECH.LAUNCH.otherVy;
          p.vy = (p.gravityFlipped ? 1 : -1) * force;
          p.isGrounded = false;
          p.invincibleTime = Math.max(p.invincibleTime, MECH.LAUNCH.invincible);
          this.particles.sparks(p.centerX, p.y + p.height, o.color, same ? 10 : 5);
          this.game.audio.playJump();
          break;
        }
        case 'PIT': {
          // M10 断桥：站在坑口内即坠落（跳跃越过安全）
          const overlapX = p.x + p.width > o.x + 4 && p.x < o.x + o.w - 4;
          if (pitKills(p.y + p.height, GAME_CONFIG.GROUND_Y, overlapX) && p.invincibleTime <= 0) {
            this.die();
            return;
          }
          break;
        }
        case 'FINISH': {
          if (p.x + p.width < o.x) break;
          // 到达终点即通关；缺片只影响 ★2，不再整关重开
          this.win();
          return;
        }
      }
    }
  }

  private checkComboMilestone() {
    const c = this.player.combo;
    const milestones = [5, 10, 20, 30, 50];
    for (const m of milestones) {
      if (c >= m && !this.milestoneHit.has(m)) {
        this.milestoneHit.add(m);
        this.game.audio.playComboMilestone();
        this.flashAlpha = 0.15;
        if (m >= 30) {
          this.particles.comboBurst(this.player.centerX, this.player.centerY, polarityColor(this.player.polarity));
          this.game.renderer.shake.trigger(3, 8);
        }
      }
    }
  }

  /**
   * 速度线：只在速度明显高于跑速时出现，且画在障碍之前（世界层最底）。
   * 位置由世界坐标固定间距生成，随相机自然向左流动，不用随机避免抖动。
   * 白色低透明 + 不进入地面与天花板 40px 内，保证不与尖刺/相位墙抢注意力。
   */
  private renderSpeedLines(ctx: CanvasRenderingContext2D) {
    if (!this.save.data.fxSpeed) return;
    const spd = this.player.speed;
    const base = GAME_CONFIG.RUN_SPEED * 1.15;
    if (spd < base) return;
    const k = Math.min(1, (spd - base) / (GAME_CONFIG.RUN_SPEED * 1.1));
    const y0 = GAME_CONFIG.CEILING_Y + 44;
    const y1 = GAME_CONFIG.GROUND_Y - 56;
    const span = 132;
    const start = Math.floor((this.cameraX - 140) / span) * span;
    ctx.save();
    ctx.strokeStyle = UI.color.rim;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.07 + 0.11 * k;
    ctx.lineWidth = 2;
    for (let i = 0; i < 11; i++) {
      const wx = start + i * span + ((i * 47) % span);
      const y = y0 + ((i * 73) % (y1 - y0));
      const len = (54 + (i % 4) * 26) * (0.7 + 0.5 * k);
      ctx.beginPath();
      ctx.moveTo(wx, y);
      ctx.lineTo(wx + len, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private updateCamera(dt: number) {
    const offsetX = GAME_CONFIG.CANVAS_WIDTH * GAME_CONFIG.CAMERA_OFFSET_X;
    // 速度前瞻：高于跑速时相机往前多给最多 40px，让加速段“先看到再撞上”
    const fast = this.save.data.fxSpeed
      ? Math.min(40, Math.max(0, this.player.speed - GAME_CONFIG.RUN_SPEED) * 0.15)
      : 0;
    const targetX = this.player.x + fast - offsetX;
    const k = 1 - Math.exp(-GAME_CONFIG.CAMERA_SMOOTH * dt);
    this.cameraX += (targetX - this.cameraX) * k;
    this.cameraX = Math.max(0, this.cameraX);
  }

  /** 联机：以 30Hz 发送本地状态（约 3KB/s/人；旧服务端原样转发，无需改协议） */
  private sendOnlineState(dt: number) {
    this.onlineStateTimer += dt;
    if (this.onlineStateTimer < 1 / 30) return;
    this.onlineStateTimer = 0;
    const p = this.player;
    online.sendState({
      x: p.x, y: p.y, vx: p.speed, vy: p.vy,
      polarity: p.polarity === 'RED' ? 1 : -1,
      finished: this.state === 'FINISHED',
      time: this.time,
      combo: p.combo,
      alive: p.alive,
      sliding: p.isSliding,
      flipped: p.gravityFlipped,
    });
  }

  render(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.GROUND_Y + 60;

    this.game.renderer.clear(this.level?.bg ?? COLORS.BG);
    this.renderBackground(ctx);
    this.game.renderer.pushCamera(this.cameraX, 0);

    // 速度线：画在障碍之前（世界层最底），永远不压住危险物
    this.renderSpeedLines(ctx);

    for (const o of this.obstacles) {
      // 摆锤锚点离屏但摆球可能甩入视野，给足余量
      if (o.kind === 'PENDULUM') {
        if (o.x < this.cameraX - 320 || o.x > this.cameraX + W + 320) continue;
      } else if (o.x + o.w < this.cameraX - 100 || o.x > this.cameraX + W + 100) continue;
      o.render(ctx, this.time);
    }

    if (this.level?.tutorials) {
      const touchHints: Record<string, string> = {
        '按 空格 切换极性！同色即安全': '点右下 ● 切换极性！同色即安全',
        '按 ↑ 跳跃，滑过灰墙！': '左下 ▲ 跳跃，按钮上下滑滑过灰墙！',
      };
      // 相邻提示（x 间距 <340）错行显示，避免文字互叠
      let lastX = -Infinity;
      let lastRow = 1;
      for (const t of this.level.tutorials) {
        if (t.x < this.cameraX - 200 || t.x > this.cameraX + W + 200) continue;
        const row = (t.x - lastX < 340 && lastRow === 0) ? 1 : 0;
        lastX = t.x;
        lastRow = row;
        const dist = Math.abs(this.player.x - t.x);
        const a = dist < 400 ? 1 : 0.5;
        const mapped = touchHints[t.text];
        const text = isCoarsePointer() ? (t.touch ?? mapped ?? t.text) : t.text;
        // 下移到 HUD 胶囊下方，避免与顶部胶囊重叠
        drawStickerText(ctx, text, t.x, GAME_CONFIG.CEILING_Y - 20 + row * 28, {
          font: `bold 18px ${UI.font.ui}`,
          fill: withAlpha(UI.color.gold, a),
          stroke: withAlpha(UI.color.rim, a),
          lineWidth: 6,
          align: 'center',
        });
      }
    }

    // 联机：远端玩家先画（本地角色后画，重叠时本地始终在最上层）
    if (this.mode === 'ONLINE') this.renderRemotePlayers(ctx);

    this.player.render(ctx, this.time, this.player.combo >= 50, this.save.data.fxSpeed);

    this.particles.render(ctx);
    this.game.renderer.popCamera();

    if (this.mode === 'ONLINE' && this.state === 'FINISHED') {
      // 完赛后不再画比赛 HUD，避免和观战/结算面板叠在一起
      if (this.settled) this.renderSettlement(ctx);
      else this.renderSpectate(ctx);
    } else {
      this.renderHUD(ctx);
      if (this.mode === 'ONLINE') {
        if (this.state === 'COUNTDOWN') this.renderCountdown(ctx);
        else this.renderOnlineHUD(ctx);
      }
    }

    if (this.state !== 'PAUSED' && this.state !== 'FINISHED') this.renderTouchControls(ctx);

    if (this.flashAlpha > 0) {
      ctx.fillStyle = withAlpha(UI.paper, this.flashAlpha);
      ctx.fillRect(0, 0, W, H);
    }
    if (this.state === 'DYING') {
      // 红色只压边缘：中心保持清晰，避免整屏变红盖住障碍与落点
      const a = Math.min(1, this.deathTimer / GAME_CONFIG.RESPAWN_DELAY);
      const halo = ctx.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 0.82);
      halo.addColorStop(0, withAlpha(PALETTE.red, 0));
      halo.addColorStop(1, withAlpha(PALETTE.red, 0.5 * (1 - a)));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, W, H);
    }
    if (this.state === 'PAUSED') this.renderPause(ctx);
  }

  private renderBackground(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;
    const groundY = GAME_CONFIG.GROUND_Y;

    // 原版卡通天空：太阳 + 云朵（游戏内不画远山，避免干扰跑道读取）
    drawToonSky(ctx, this.time, {
      hills: false,
      ceilingY: GAME_CONFIG.CEILING_Y,
      groundY,
    });

    // 地面：亮草绿硬分界（参考图没有白色唇边和雾），顶边一档深绿 + 零星草簇
    ctx.fillStyle = TOON_SKY.ground;
    ctx.fillRect(0, groundY, W, H - groundY);
    ctx.fillStyle = TOON_SKY.groundEdge;
    ctx.fillRect(0, groundY, W, 3);

    // 草簇：屏幕空间固定位置，两片叶子一组，高低错落
    ctx.strokeStyle = TOON_SKY.groundEdge;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let i = 0; i < 16; i++) {
      const gx = 24 + i * 61 + (i % 3) * 9;
      const gh = 7 + ((i * 37) % 6);
      ctx.beginPath();
      ctx.moveTo(gx, groundY + 1);
      ctx.lineTo(gx - 4, groundY - gh);
      ctx.moveTo(gx, groundY + 1);
      ctx.lineTo(gx + 4, groundY - gh + 2);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  /** 手机端虚拟按键（仅触屏设备显示） */
  private renderTouchControls(ctx: CanvasRenderingContext2D) {
    if (!isCoarsePointer()) return;
    const z = this.game.input.touchZones;
    const active = this.game.input.activeZones();

    // 卡通圆形按钮：底部硬投影 + 深靛描边 + 扁平填充；按下时下沉 3px
    const roundBtn = (c: { cx: number; cy: number; r: number }, fill: string, pressed: boolean) => {
      ctx.beginPath();
      ctx.arc(c.cx, c.cy + 4, c.r, 0, Math.PI * 2);
      ctx.fillStyle = UI.shadow;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(c.cx, c.cy + (pressed ? 3 : 0), c.r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      // 参考图：按钮边缘是细深线，不再用 4px 厚描边
      ctx.strokeStyle = UI.ink;
      ctx.lineWidth = 3;
      ctx.stroke();
    };

    // 左下：跳跃 / 下滑（白圆 + 红色三角，白底上红色才看得见）
    const jumpPressed = active.has('jump');
    roundBtn(z.jump, jumpPressed ? withAlpha(UI.paper, 0.82) : UI.paper, jumpPressed);
    drawStickerText(ctx, '▲', z.jump.cx, z.jump.cy - 8, {
      font: `bold 30px ${UI.font.ui}`, fill: COLORS.RED, align: 'center', baseline: 'middle',
    });
    drawStickerText(ctx, '跳跃 · 下滑', z.jump.cx, z.jump.cy + 24, {
      font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: UI.paper, stroke: UI.ink, lineWidth: 4,
      align: 'center', baseline: 'middle',
    });

    // 右下：切换极性（极性色圆 + 白色刻印）
    const switchPressed = active.has('switch');
    const pc = polarityColor(this.player.polarity);
    roundBtn(z.switch, switchPressed ? withAlpha(pc, 0.78) : pc, switchPressed);
    // 极性按钮：颜色 + 刻印两条通道；刻印与文字统一白色，配细深线保证在红/蓝底都可读
    drawPolarityMark(ctx, z.switch.cx, z.switch.cy - 8, 22, this.player.polarity, 1);
    drawStickerText(ctx, '切换极性', z.switch.cx, z.switch.cy + 24, {
      font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: UI.paper, stroke: UI.ink, lineWidth: 4,
      align: 'center', baseline: 'middle',
    });

    // 右上：暂停（圆角卡通 chip）
    const b = z.pause;
    const pausePressed = active.has('pause');
    const pen = pausePressed ? 3 : 0;
    toonShape(ctx, { x: b.x, y: b.y + 4, w: b.w, h: b.h }, {
      fill: UI.shadow, lineWidth: 0, radius: 12,
    });
    toonShape(ctx, { x: b.x, y: b.y + pen, w: b.w, h: b.h }, {
      fill: pausePressed ? withAlpha(UI.paper, 0.82) : UI.paper, stroke: UI.ink, lineWidth: 3, radius: 12,
    });
    drawStickerText(ctx, '❚❚', b.x + b.w / 2, b.y + pen + b.h / 2 + 1, {
      font: `bold 20px ${UI.font.ui}`, fill: UI.color.text, align: 'center', baseline: 'middle',
    });
  }

  private renderHUD(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const p = this.player;
    const pc = polarityColor(p.polarity);

    // ── 左上：连击胶囊（白底 + 深靛描边）
    const comboNum = `${p.combo}`;
    ctx.font = `bold 26px ${UI.font.ui}`;
    const numW = ctx.measureText(comboNum).width;
    ctx.font = `bold ${UI.size.small}px ${UI.font.ui}`;
    const lblW = ctx.measureText('连击').width;
    const comboW = 24 + numW + 8 + lblW + 20;
    toonShape(ctx, { x: 20, y: 18, w: comboW, h: 44 }, {
      fill: UI.paper, stroke: UI.ink, lineWidth: 3, radius: UI.radius.pill, shadow: 5,
    });
    const comboColor = p.combo >= 50 ? UI.color.grape : (p.combo > 0 ? pc : UI.color.sub);
    drawStickerText(ctx, comboNum, 44, 41, {
      font: `bold 26px ${UI.font.ui}`, fill: comboColor, align: 'left', baseline: 'middle',
    });
    drawStickerText(ctx, '连击', 44 + numW + 8, 43, {
      font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: UI.color.sub, align: 'left', baseline: 'middle',
    });
    // ★3 连击目标（把 level.maxCombo 从闲置字段变成可见目标）
    if (this.mode === 'NORMAL' && this.level.maxCombo > 0) {
      const reached = this.runMaxCombo >= this.level.maxCombo;
      drawStickerText(ctx, `★3 ${this.runMaxCombo}/${this.level.maxCombo}`, 24, 76, {
        font: `bold ${UI.size.tiny}px ${UI.font.ui}`,
        fill: reached ? UI.color.success : UI.color.sub,
        stroke: UI.color.rim, lineWidth: 4, align: 'left', baseline: 'middle',
      });
    }

    // ── 顶部中间：极性胶囊（极性色填充 + 白描边 + 左白圆点 + 白字）
    const polW = 132;
    const polH = 40;
    const polX = W / 2 - polW / 2;
    const polY = 16;
    toonShape(ctx, { x: polX, y: polY, w: polW, h: polH }, {
      fill: pc, stroke: PALETTE.dust050, lineWidth: STROKE.sticker, radius: UI.radius.pill, shadow: 5,
    });
    ctx.beginPath();
    ctx.arc(polX + 28, polY + polH / 2, 9, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.dust050;
    ctx.fill();
    drawPolarityMark(
      ctx, polX + 28, polY + polH / 2, 11, this.player.polarity, 1,
    );
    // 白字 + 细深靛描边：蓝底上纯白字对比不足，用字边承担可读性
    drawStickerText(ctx, p.polarity === 'RED' ? '红极' : '蓝极', polX + 46, polY + polH / 2 + 1, {
      font: `bold ${UI.size.body}px ${UI.font.ui}`, fill: PALETTE.dust050,
      stroke: UI.ink, lineWidth: 3, align: 'left', baseline: 'middle',
    });

    // ── 右上：计时 / 晶片 / 无尽速度（右对齐 W-64，避开触屏暂停按钮）
    const rightX = W - 64;
    const timeText = this.mode === 'DAILY'
      ? `${Math.max(0, this.dailyEndAt - this.time).toFixed(1)}s`
      : `${this.time.toFixed(2)}s`;
    // 参考图：右上为大号白字计时，深靛描边保证压在天空上也可读
    drawStickerText(ctx, timeText, rightX, 34, {
      font: `bold 28px ${UI.font.mono}`, fill: PALETTE.dust050, stroke: UI.ink, lineWidth: 6,
      align: 'right', baseline: 'middle',
    });
    if (this.mode === 'ENDLESS') {
      drawStickerText(ctx, `速度 x${p.externalSpeedMul.toFixed(1)}`, rightX, 58, {
        font: `bold ${UI.size.small}px ${UI.font.mono}`, fill: withAlpha(UI.color.rim, 0.78), stroke: UI.ink, lineWidth: 4, align: 'right', baseline: 'middle',
      });
    } else if (this.mode === 'DAILY') {
      drawStickerText(ctx, `◆ 磁芯 ${this.save.data.cores}`, rightX, 58, {
        font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: UI.color.gold, stroke: UI.color.rim, lineWidth: 4, align: 'right', baseline: 'middle',
      });
    } else if (this.totalGems > 0) {
      const done = this.collectedGems >= this.totalGems;
      drawStickerText(ctx, `◆ ${this.collectedGems}/${this.totalGems}`, rightX, 58, {
        font: `bold 17px ${UI.font.ui}`,
        fill: done ? COLORS.COLLECTIBLE : withAlpha(COLORS.COLLECTIBLE, 0.9),
        stroke: UI.color.text, lineWidth: 3, align: 'right', baseline: 'middle',
      });
    }

    // ── 底部：圆角卡通进度条 + 模式行
    const touch = isCoarsePointer();
    const barX = touch ? 196 : 20;
    const barW = touch ? W - 196 * 2 : W - 40;
    const barH = 14;
    const barY = GAME_CONFIG.CANVAS_HEIGHT - 28;
    const modeY = barY - 11;

    let ratio: number;
    let fillColor: string;
    if (this.mode === 'ENDLESS' || this.mode === 'DAILY') {
      ratio = (p.x / 50 / 500) % 1; // 每500m一个循环
      fillColor = this.mode === 'DAILY' ? UI.color.gold : COLORS.BLUE;
    } else {
      const finishX = this.level.obstacles.find(o => o.kind === 'FINISH')?.x ?? this.level.obstacles[this.level.obstacles.length - 1]?.x ?? 1;
      ratio = Math.min(1, p.x / finishX);
      fillColor = COLORS.PROGRESS_FILL;
    }
    toonShape(ctx, { x: barX, y: barY, w: barW, h: barH }, {
      fill: COLORS.PROGRESS_BG, stroke: UI.ink, lineWidth: 3, radius: UI.radius.pill,
    });
    if (ratio > 0) {
      const fw = Math.max(barH, barW * ratio);
      toonShape(ctx, { x: barX, y: barY, w: fw, h: barH }, {
        fill: fillColor, lineWidth: 0, radius: UI.radius.pill,
      });
    }

    // 模式行（进度条上方）
    let modeText: string;
    let modeColor: string = UI.color.sub;
    if (this.mode === 'ENDLESS') {
      modeText = `无尽狂奔 · ${Math.round(p.x / 50)}m · ${this.generator?.zoneName ?? '基础'}`;
      modeColor = this.stormActive ? COLORS.RED : UI.color.sky;
    } else if (this.mode === 'DAILY') {
      modeText = `每日挑战 · ${Math.round(p.x / 50)}m · ${dailyModifierLabel(this.dailyMods)}`;
      modeColor = UI.color.gold;
    } else if (this.mode === 'SPECIAL') {
      modeText = `特殊地图 · ${this.level.name} · 目标 ${this.level.parTime}s`;
      modeColor = UI.color.grape;
    } else if (this.mode === 'CUSTOM') {
      modeText = `${this.level.name} · 目标 ${this.level.parTime}s`;
    } else {
      modeText = `第${this.level.id}关 · ${this.level.name} · 目标 ${this.level.parTime}s`;
    }
    drawStickerText(ctx, modeText, W / 2, modeY, {
      font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: modeColor, stroke: UI.color.rim, lineWidth: 5, align: 'center', baseline: 'middle',
    });

    // 加速中 / 重力反转
    if (p.speedBoostTimer > 0) {
      drawStickerText(ctx, '加速中', W / 2, 74, {
        font: `bold ${UI.size.body}px ${UI.font.ui}`, fill: UI.color.accent, stroke: UI.color.rim, lineWidth: 6, align: 'center', baseline: 'middle',
      });
    }
    if (p.gravityFlipped) {
      drawStickerText(ctx, `重力反转 ${this.flippedSurvivalTime.toFixed(1)}s`, W / 2, 96, {
        font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: UI.color.success, stroke: UI.color.rim, lineWidth: 5, align: 'center', baseline: 'middle',
      });
    }

    // 横幅提示（晶片不足等）
    if (this.bannerTimer > 0) {
      const a = Math.min(1, this.bannerTimer / 0.4);
      drawStickerText(ctx, this.bannerText, W / 2, 150, {
        font: `bold 24px ${UI.font.ui}`, fill: withAlpha(UI.color.gold, a), stroke: withAlpha(UI.color.rim, a), lineWidth: 7, align: 'center', baseline: 'middle',
      });
    }

    // 连续失败可跳关：触屏胶囊（可点击）/ 键鼠 K（同样二次确认）
    const canSkip = this.mode === 'NORMAL' && this.showSkipHint
      && this.save.data.skipCharges > 0 && this.state === 'PLAYING';
    this.skipBtnRect = null;
    if (canSkip) {
      const confirming = Date.now() <= this.skipConfirmUntil;
      const label = confirming
        ? '再点一次确认跳过'
        : `跳过本关 · 剩 ${this.save.data.skipCharges} 次`;
      if (isCoarsePointer()) {
        const rect = { x: W / 2 - 122, y: GAME_CONFIG.CANVAS_HEIGHT - 98, w: 244, h: 38 };
        this.skipBtnRect = rect;
        drawButton(ctx, rect, label, { variant: 'primary', fontSize: UI.size.small });
      } else {
        const a = 0.7 + Math.sin(this.time * 5) * 0.3;
        drawStickerText(ctx, `连续失败${this.consecutiveDeaths}次 — 按 K 两次${label}`, W / 2, GAME_CONFIG.CANVAS_HEIGHT - 62, {
          font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: withAlpha(UI.color.gold, a), stroke: withAlpha(UI.color.rim, a), lineWidth: 5, align: 'center', baseline: 'middle',
        });
      }
    }
    // 第 1 关操作提示（触屏版位置抬高于虚拟按键之上）
    if (this.mode === 'NORMAL' && this.time < 3.5 && this.level.id === 1) {
      const a = Math.min(1, (3.5 - this.time) * 2);
      const hint = isCoarsePointer()
        ? '右下 ● 切换极性　左下 ▲ 跳跃（按钮上向下滑=滑行）　右上 ⏸ 暂停'
        : '空格=切换极性  ↑=跳跃  ↓=滑行  Esc=暂停';
      drawStickerText(ctx, hint, W / 2, isCoarsePointer() ? 470 : 452, {
        font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: withAlpha(UI.color.text, a), stroke: withAlpha(UI.color.rim, a), lineWidth: 5, align: 'center', baseline: 'middle',
      });
    }
  }

  /**
   * 联机：完整绘制其他玩家的实心本体（与本地角色同一套 drawRunner：极性色、眼睛、投影、白描边）。
   * 位置来自 30Hz 状态包的插值/有限外推；低透明度剪影只作为可选运动拖尾，绝不替代本体。
   */
  private renderRemotePlayers(ctx: CanvasRenderingContext2D) {
    const now = performance.now();
    const dt = this.lastRemoteFrameAt ? Math.min(0.05, (now - this.lastRemoteFrameAt) / 1000) : 0.016;
    this.lastRemoteFrameAt = now;
    const seen = new Set<string>();

    for (const [id, raw] of online.remoteStates) {
      if (id === online.selfId) continue;
      seen.add(id);
      const view = online.sampleRemote(id, now);
      let anim = this.remoteAnim.get(id);
      if (!anim) {
        anim = { phase: 0, lastX: view?.x ?? raw.x, trail: [], trailAt: 0 };
        this.remoteAnim.set(id, anim);
      }
      if (!view) continue;

      // 死亡/等待复活：不画本体，同时清空拖尾，避免留下空壳或残影
      if (!view.alive) { anim.trail.length = 0; continue; }

      const moved = Math.abs(view.x - anim.lastX) > 0.5;
      if (moved) anim.phase += dt * 8;
      anim.lastX = view.x;

      const size = GAME_CONFIG.PLAYER_SIZE;
      const h = view.sliding ? GAME_CONFIG.PLAYER_SLIDE_HEIGHT : size;
      const top = view.flipped ? view.y : view.y + size - h;
      const pol: Polarity = view.polarity > 0 ? 'RED' : 'BLUE';
      const color = polarityColor(pol);

      // 可选运动拖尾：低透明度剪影，落后于本体
      if (moved && now - anim.trailAt >= 45) {
        anim.trailAt = now;
        anim.trail.push({
          x: view.x, y: view.y, polarity: view.polarity,
          sliding: view.sliding, flipped: view.flipped,
        });
        while (anim.trail.length > 4) anim.trail.shift();
      }
      for (let i = 0; i < anim.trail.length; i++) {
        const tr = anim.trail[i];
        const th = tr.sliding ? GAME_CONFIG.PLAYER_SLIDE_HEIGHT : size;
        const tTop = tr.flipped ? tr.y : tr.y + size - th;
        ctx.save();
        ctx.globalAlpha = 0.10 + i * 0.03;
        ctx.beginPath();
        ctx.roundRect(tr.x, tTop, size, th, Math.min(size, th) * 0.32);
        ctx.fillStyle = polarityColor(tr.polarity > 0 ? 'RED' : 'BLUE');
        ctx.fill();
        ctx.restore();
      }

      // 本体：实心、极性色、朝向/跑步姿态、脚下投影（与本地一致）
      drawRunner(ctx, {
        x: view.x, y: view.y, width: size, height: h,
        polarity: pol,
        sliding: view.sliding,
        grounded: view.flipped
          ? view.y <= GAME_CONFIG.CEILING_Y + 1
          : view.y + size >= GAME_CONFIG.GROUND_Y - 1,
        flipped: view.flipped,
        flipAngle: view.flipped ? Math.PI : 0,
        runPhase: anim.phase,
        squashY: 1,
        invincibleTime: 0,
        ring: true,
      }, this.time);

      // 名字标签：与本地角色完全重叠时也能一眼分辨（+白色外描边）
      const label = online.players.find(pp => pp.id === id)?.name ?? '玩家';
      const labelY = view.flipped ? view.y + h + 12 : top - 12;
      ctx.save();
      drawStickerText(ctx, label, view.x + size / 2, labelY, {
        font: `bold 12px ${UI.font.ui}`, fill: color,
        stroke: UI.color.rim, lineWidth: 5, align: 'center', baseline: 'middle',
      });
      ctx.restore();
    }

    // 离场/回大厅/观战切人后不再保留动画与拖尾缓存
    for (const id of [...this.remoteAnim.keys()]) {
      if (!seen.has(id)) this.remoteAnim.delete(id);
    }
  }

  /** 联机：3秒倒计时 */
  private renderCountdown(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;
    const remaining = Math.max(0, Math.ceil((this.onlineStartAt - online.now()) / 1000));
    ctx.fillStyle = UI.color.overlay;
    ctx.fillRect(0, 0, W, H);
    // 巨大贴纸数字（最后一秒变绿）
    drawStickerText(ctx, remaining > 0 ? String(remaining) : 'GO!', W / 2, H / 2 + 6, {
      font: `bold ${remaining <= 1 ? 130 : 104}px ${UI.font.ui}`,
      fill: remaining <= 1 ? UI.color.success : UI.color.accent,
      stroke: UI.color.rim,
      lineWidth: 16,
      align: 'center',
      baseline: 'middle',
    });
  }

  /** 联机：实时榜单 + 快捷短语（比赛进行中） */
  private renderOnlineHUD(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;
    this.renderRankCard(ctx, this.buildRankRows(), 68);

    // 调试/感知信息：RTT 往返时延（min–max）+ 当前插值缓冲
    const rttText = online.rttSummary();
    drawStickerText(ctx, rttText ? `RTT ${rttText}` : 'RTT —（旧服务器）', 16, 82, {
      font: `${UI.size.tiny}px ${UI.font.mono}`, fill: UI.color.sub,
      stroke: UI.color.rim, lineWidth: 4, align: 'left', baseline: 'middle',
    });
    drawStickerText(ctx, `插值 ${online.interpDelayMs}ms · 30Hz`, 16, 100, {
      font: `${UI.size.tiny}px ${UI.font.mono}`, fill: UI.color.sub,
      stroke: UI.color.rim, lineWidth: 4, align: 'left', baseline: 'middle',
    });

    // 比赛中：快捷短语胶囊（触屏可点，键盘 1–4）
    this.finishBtn = null;
    this.rematchBtn = null;
    this.spectateExitBtn = null;
    this.spectatePrevBtn = null;
    this.spectateNextBtn = null;
    this.spectateRowRects = [];
    this.phraseRects = [];
    if (this.state === 'PLAYING') {
      const chipW = 112;
      const gap = 8;
      const total = QUICK_PHRASES.length * chipW + (QUICK_PHRASES.length - 1) * gap;
      const x0 = W / 2 - total / 2;
      QUICK_PHRASES.forEach((text, i) => {
        // 上移一条，避开底部模式文字（基线约 501）
        const rect = { x: x0 + i * (chipW + gap), y: H - 104, w: chipW, h: 30 };
        this.phraseRects.push(rect);
        drawButton(ctx, rect, text, { variant: 'ghost', fontSize: 14 });
      });
    }
    if (this.phraseMsg) {
      drawStickerText(ctx, this.phraseMsg, W / 2, 150, {
        font: `bold ${UI.size.body}px ${UI.font.ui}`, fill: UI.color.accent,
        stroke: UI.color.rim, lineWidth: 6, align: 'center', baseline: 'middle',
      });
    }
    if (online.reconnecting) {
      drawStickerText(ctx, '⚠ 正在重连…', W / 2, 118, {
        font: `bold ${UI.size.body}px ${UI.font.ui}`, fill: COLORS.RED,
        stroke: UI.color.rim, lineWidth: 6, align: 'center', baseline: 'middle',
      });
    }
  }

  /** 右上角排名卡（比赛与观战共用）；返回每行的点击矩形，观战时可点行切换对象 */
  private renderRankCard(
    ctx: CanvasRenderingContext2D,
    rows: { id: string; name: string; self: boolean; finished: boolean; time: number; progress: number }[],
    cardY: number,
  ): { id: string; rect: { x: number; y: number; w: number; h: number } }[] {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const cardW = 224;
    const cardX = W - 12 - cardW;
    const rowH = 28;
    const cardH = 56 + rows.length * rowH;
    toonShape(ctx, { x: cardX, y: cardY, w: cardW, h: cardH }, {
      fill: UI.paper, stroke: UI.ink, lineWidth: 3, radius: UI.radius.md, shadow: 6,
    });
    drawStickerText(ctx, '实时排名', cardX + 16, cardY + 24, {
      font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: UI.color.text, align: 'left', baseline: 'middle',
    });
    const rowY0 = cardY + 46;
    const rects: { id: string; rect: { x: number; y: number; w: number; h: number } }[] = [];
    rows.forEach((r, i) => {
      const ry = rowY0 + i * rowH + 2;
      const nameColor = r.self ? UI.color.dangerInk : (r.finished ? UI.color.successInk : UI.color.text);
      const nameFont = r.self ? `bold ${UI.size.small}px ${UI.font.ui}` : `${UI.size.small}px ${UI.font.ui}`;
      drawStickerText(ctx, `${i + 1}. ${r.name}${r.self ? '（你）' : ''}`, cardX + 16, ry + 12, {
        font: nameFont, fill: nameColor, align: 'left', baseline: 'middle',
      });
      drawStickerText(ctx, r.finished ? `${r.time.toFixed(2)}s` : `${Math.max(0, Math.round(r.progress / 50))}m`, cardX + cardW - 14, ry + 12, {
        font: `${UI.size.tiny}px ${UI.font.mono}`, fill: UI.color.sub, align: 'right', baseline: 'middle',
      });
      rects.push({ id: r.id, rect: { x: cardX, y: ry - 2, w: cardW, h: rowH } });
    });
    return rects;
  }

  /** 联机观战：自己的成绩 + 正在看谁（进度/连击/距离）+ 切换与出口按钮 */
  private renderSpectate(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;
    const rows = this.buildRankRows();
    this.spectateRowRects = this.renderRankCard(ctx, rows, 68);

    // 左上：自己的成绩
    const own = { x: 20, y: 18, w: 272, h: 92 };
    toonShape(ctx, own, { fill: UI.paper, stroke: UI.ink, lineWidth: 3, radius: UI.radius.md, shadow: 6 });
    drawStickerText(ctx, '✓ 你已完赛', own.x + 14, own.y + 24, {
      font: `bold ${UI.size.body}px ${UI.font.ui}`, fill: UI.color.successInk, align: 'left', baseline: 'middle',
    });
    const stars = (this.starResult ?? this.starResultNow()).stars;
    drawStickerText(ctx, `用时 ${this.time.toFixed(2)}s · ★${stars}`, own.x + 14, own.y + 50, {
      font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: UI.color.text, align: 'left', baseline: 'middle',
    });
    drawStickerText(ctx, `最高连击 ${this.runMaxCombo}`, own.x + 14, own.y + 74, {
      font: `${UI.size.small}px ${UI.font.ui}`, fill: UI.color.sub, align: 'left', baseline: 'middle',
    });

    // 底部：观战面板
    const target = online.players.find(p => p.id === this.spectateId);
    const st = this.spectateId ? online.remoteStates.get(this.spectateId) : undefined;
    const finishX = this.levelFinishX();
    const running = online.players.filter(
      p => p.id !== online.selfId && !online.finishTimes.has(p.id) && !p.disconnected,
    ).length;
    const panel = { x: 20, y: H - 168, w: 470, h: 92 };
    toonShape(ctx, panel, { fill: UI.paper, stroke: UI.ink, lineWidth: 3, radius: UI.radius.md, shadow: 6 });
    drawStickerText(ctx, '正在观战', panel.x + 14, panel.y + 22, {
      font: `bold ${UI.size.tiny}px ${UI.font.ui}`, fill: UI.color.sub, align: 'left', baseline: 'middle',
    });
    drawStickerText(ctx, target ? target.name : '暂无可观战的玩家', panel.x + 14, panel.y + 44, {
      font: `bold ${UI.size.body}px ${UI.font.ui}`, fill: target ? UI.color.accent : UI.color.sub,
      align: 'left', baseline: 'middle',
    });
    let detail = `剩余 ${running} 人仍在跑`;
    if (target) {
      const px = st?.x ?? this.player.x;
      const dist = Math.max(0, Math.round((finishX - px) / 50));
      const combo = st?.combo ?? 0;
      const finished = online.finishTimes.has(target.id);
      detail = finished
        ? `已完成 · 用时 ${(online.finishTimes.get(target.id) ?? 0).toFixed(2)}s`
        : `进度 ${Math.max(0, Math.round(px / 50))}m · 距终点 ${dist}m · 连击 ${combo}`;
    }
    drawStickerText(ctx, detail, panel.x + 14, panel.y + 68, {
      font: `${UI.size.small}px ${UI.font.ui}`, fill: UI.color.sub, align: 'left', baseline: 'middle',
    });

    // 上一位 / 下一位
    const btnY = H - 66;
    this.spectatePrevBtn = { x: 20, y: btnY, w: 104, h: 42 };
    this.spectateNextBtn = { x: 132, y: btnY, w: 104, h: 42 };
    const hasTarget = this.spectateRowRects.length > 0;
    drawButton(ctx, this.spectatePrevBtn, '‹ 上一位', {
      variant: 'ghost', state: hasTarget ? 'normal' : 'disabled', fontSize: UI.size.small,
    });
    drawButton(ctx, this.spectateNextBtn, '下一位 ›', {
      variant: 'ghost', state: hasTarget ? 'normal' : 'disabled', fontSize: UI.size.small,
    });

    // 出口：房主可结束比赛/发起重赛，其他人退出回大厅
    this.spectateExitBtn = null;
    if (online.isHost) {
      this.finishBtn = { x: W - 452, y: btnY, w: 220, h: 42 };
      this.rematchBtn = { x: W - 232, y: btnY, w: 212, h: 42 };
      drawButton(ctx, this.finishBtn, '结束比赛', { variant: 'ghost', fontSize: UI.size.small });
      drawButton(ctx, this.rematchBtn, '发起重赛', { variant: 'primary', state: 'hover', fontSize: UI.size.small });
    } else {
      this.finishBtn = null;
      this.rematchBtn = null;
      this.spectateExitBtn = { x: W - 232, y: btnY, w: 212, h: 42 };
      drawButton(ctx, this.spectateExitBtn, '退出回大厅', { variant: 'ghost', fontSize: UI.size.small });
    }

    // 操作提示（键盘 + 触屏）
    drawStickerText(ctx,
      isCoarsePointer() ? '拖动画面平移视角 · 点排行行或上下按钮切换观战' : '←→ 平移 · ↑↓ 切换 · 1–4 直选 · L 复位',
      W / 2, H - 92, {
      font: `${UI.size.tiny}px ${UI.font.ui}`, fill: withAlpha(UI.color.text, 0.75),
      stroke: UI.color.rim, lineWidth: 4, align: 'center', baseline: 'middle',
    });
    if (this.bannerTimer > 0) {
      const a = Math.min(1, this.bannerTimer / 0.4);
      drawStickerText(ctx, this.bannerText, W / 2, 24, {
        font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: withAlpha(UI.color.gold, a),
        stroke: withAlpha(UI.color.rim, a), lineWidth: 5, align: 'center', baseline: 'middle',
      });
    }
    if (online.reconnecting) {
      drawStickerText(ctx, '⚠ 正在重连…', W / 2, 46, {
        font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: COLORS.RED,
        stroke: UI.color.rim, lineWidth: 5, align: 'center', baseline: 'middle',
      });
    }
  }

  /** 联机结算：本局排行 + 回到大厅 / 再来一局 / 查看排行 */
  private renderSettlement(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;
    ctx.fillStyle = UI.color.overlay;
    ctx.fillRect(0, 0, W, H);

    const cardW = 660;
    const cardH = 430;
    const cardX = W / 2 - cardW / 2;
    const cardY = 60;
    toonShape(ctx, { x: cardX, y: cardY, w: cardW, h: cardH }, {
      fill: UI.paper, stroke: UI.ink, lineWidth: 4, radius: UI.radius.xl, shadow: 9,
    });

    drawStickerText(ctx, '本局结算', W / 2, cardY + 36, {
      font: `bold ${UI.size.title}px ${UI.font.ui}`, fill: UI.color.dangerInk,
      stroke: UI.color.rim, lineWidth: 6, align: 'center', baseline: 'middle',
    });
    const reasonText = this.settleReason === 'timeout'
      ? '等待超时：有人长时间未前进，已自动结算'
      : (this.settleReason === 'left' ? '有玩家退出或掉线，本局已结束' : '全员完赛');
    drawStickerText(ctx, reasonText, W / 2, cardY + 66, {
      font: `${UI.size.small}px ${UI.font.ui}`, fill: UI.color.sub, align: 'center', baseline: 'middle',
    });

    // 自己的名次与成绩
    const myIdx = this.settleRows.findIndex(r => r.self);
    const stars = (this.starResult ?? this.starResultNow()).stars;
    if (myIdx >= 0) {
      const mine = this.settleRows[myIdx];
      const line = mine.finished
        ? `第 ${myIdx + 1} 名 · 用时 ${this.time.toFixed(2)}s · ★${stars} · 最高连击 ${this.runMaxCombo}`
        : `未完成（第 ${myIdx + 1} 名）· 进度 ${Math.max(0, Math.round(mine.progress / 50))}m · 最高连击 ${this.runMaxCombo}`;
      drawStickerText(ctx, line, W / 2, cardY + 98, {
        font: `bold ${UI.size.body}px ${UI.font.ui}`, fill: UI.color.text,
        stroke: UI.color.rim, lineWidth: 5, align: 'center', baseline: 'middle',
      });
    }

    // 排行详情（按需展开，避免结算页默认过于拥挤）
    if (this.rankExpanded) {
      const tableX = cardX + 34;
      const tableW = cardW - 68;
      const rowY0 = cardY + 140;
      drawStickerText(ctx, '本局排行', tableX, rowY0 - 16, {
        font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: UI.color.sub, align: 'left', baseline: 'middle',
      });
      this.settleRows.forEach((r, i) => {
        const ry = rowY0 + i * 34;
        if (i % 2 === 0) {
          ctx.fillStyle = withAlpha(UI.color.text, 0.06);
          ctx.fillRect(tableX - 8, ry, tableW + 16, 30);
        }
        drawStickerText(ctx, `${i + 1}. ${r.name}${r.self ? '（你）' : ''}`, tableX, ry + 15, {
          font: r.self ? `bold ${UI.size.small}px ${UI.font.ui}` : `${UI.size.small}px ${UI.font.ui}`,
          fill: r.self ? UI.color.accent : UI.color.text, align: 'left', baseline: 'middle',
        });
        drawStickerText(ctx, r.finished ? `${r.time.toFixed(2)}s` : `进度 ${Math.max(0, Math.round(r.progress / 50))}m`, tableX + tableW, ry + 15, {
          font: `${UI.size.tiny}px ${UI.font.mono}`,
          fill: r.finished ? UI.color.success : UI.color.sub, align: 'right', baseline: 'middle',
        });
      });
    } else {
      drawStickerText(ctx, '三种出口任选：回大厅 / 再来一局 / 查看完整排行', W / 2, cardY + 190, {
        font: `${UI.size.body}px ${UI.font.ui}`, fill: UI.color.sub, align: 'center', baseline: 'middle',
      });
      drawStickerText(ctx, isCoarsePointer() ? '点下方按钮操作' : 'Enter 回大厅 · R 再来一局 · L 查看排行', W / 2, cardY + 224, {
        font: `${UI.size.small}px ${UI.font.ui}`, fill: UI.color.sub, align: 'center', baseline: 'middle',
      });
    }

    // 三个出口按钮
    const btnY = cardY + cardH - 58;
    const btnW = 196;
    const gap = 16;
    const x0 = cardX + (cardW - (btnW * 3 + gap * 2)) / 2;
    this.settleLobbyBtn = { x: x0, y: btnY, w: btnW, h: 44 };
    this.settleRematchBtn = { x: x0 + btnW + gap, y: btnY, w: btnW, h: 44 };
    this.settleRankBtn = { x: x0 + (btnW + gap) * 2, y: btnY, w: btnW, h: 44 };
    drawButton(ctx, this.settleLobbyBtn, '返回大厅', { variant: 'ghost', fontSize: UI.size.body });
    drawButton(ctx, this.settleRematchBtn, online.isHost ? '再来一局' : '等待房主重赛', {
      variant: 'primary',
      state: online.isHost ? 'hover' : 'disabled',
      fontSize: UI.size.body,
    });
    drawButton(ctx, this.settleRankBtn, this.rankExpanded ? '收起排行' : '查看排行', {
      variant: 'ghost', fontSize: UI.size.body,
    });

    if (this.bannerTimer > 0) {
      const a = Math.min(1, this.bannerTimer / 0.4);
      drawStickerText(ctx, this.bannerText, W / 2, 34, {
        font: `bold ${UI.size.body}px ${UI.font.ui}`, fill: withAlpha(UI.color.gold, a),
        stroke: withAlpha(UI.color.rim, a), lineWidth: 6, align: 'center', baseline: 'middle',
      });
    }
    if (online.reconnecting) {
      drawStickerText(ctx, '⚠ 正在重连…', W / 2, 8, {
        font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: COLORS.RED,
        stroke: UI.color.rim, lineWidth: 5, align: 'center', baseline: 'middle',
      });
    }
  }

  /** 关卡终点 x（用于观战面板的“距终点”） */
  private levelFinishX(): number {
    return this.level.obstacles.find(o => o.kind === 'FINISH')?.x
      ?? this.level.obstacles[this.level.obstacles.length - 1]?.x
      ?? 1;
  }


  private finishBtn: { x: number; y: number; w: number; h: number } | null = null;
  private rematchBtn: { x: number; y: number; w: number; h: number } | null = null;
  private spectateExitBtn: { x: number; y: number; w: number; h: number } | null = null;
  private spectatePrevBtn: { x: number; y: number; w: number; h: number } | null = null;
  private spectateNextBtn: { x: number; y: number; w: number; h: number } | null = null;
  private spectateRowRects: { id: string; rect: { x: number; y: number; w: number; h: number } }[] = [];
  private settleLobbyBtn: { x: number; y: number; w: number; h: number } | null = null;
  private settleRematchBtn: { x: number; y: number; w: number; h: number } | null = null;
  private settleRankBtn: { x: number; y: number; w: number; h: number } | null = null;
  private phraseRects: { x: number; y: number; w: number; h: number }[] = [];
  private phraseMsg = '';
  private phraseUntil = 0;
  private onlineUnsubs: (() => void)[] = [];

  private buildRankRows() {
    const players = online.players;
    const me = online.selfId;
    return players.map(p => {
      const st = online.remoteStates.get(p.id);
      const finished = p.id === me ? this.state === 'FINISHED' : (st?.finished ?? false);
      const time = p.id === me ? (this.state === 'FINISHED' ? this.time : 0) : (online.finishTimes.get(p.id) ?? st?.time ?? 0);
      const progress = p.id === me ? this.player.x : (st?.x ?? 0);
      return { id: p.id, name: p.name, self: p.id === me, finished, time, progress };
    }).sort((a, b) => {
      if (a.finished && b.finished) return a.time - b.time;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
  }

  private renderPause(ctx: CanvasRenderingContext2D) {
    const W = GAME_CONFIG.CANVAS_WIDTH;
    const H = GAME_CONFIG.CANVAS_HEIGHT;
    ctx.fillStyle = UI.color.overlay;
    ctx.fillRect(0, 0, W, H);

    // 居中白色大卡通卡（厚描边 + 硬投影）
    const items = this.pauseItems();
    const cardW = 440;
    const cardH = 210 + items.length * 50;
    const card = { x: W / 2 - cardW / 2, y: H / 2 - cardH / 2 - 10, w: cardW, h: cardH };
    toonShape(ctx, card, { fill: UI.paper, stroke: UI.ink, lineWidth: 4, radius: UI.radius.xl, shadow: 8 });

    // 标题
    drawStickerText(ctx, '暂停', W / 2, H / 2 - 78, {
      font: `bold ${UI.size.title}px ${UI.font.ui}`, fill: UI.color.accent, stroke: UI.color.rim, lineWidth: 7, align: 'center', baseline: 'middle',
    });

    // 选项（y = H/2 + i*50，handleTap / updatePauseMenu 依赖此坐标）
    items.forEach((item, i) => {
      const cy = H / 2 + i * 50;
      const sel = i === this.pausedSelection;
      drawButton(ctx, { x: W / 2 - 170, y: cy - 22, w: 340, h: 44 }, item.label, {
        variant: sel ? 'primary' : 'ghost', state: sel ? 'hover' : 'normal', fontSize: 22,
      });
    });

    // 左上角返回主菜单（命中区 (12,12)-(118,54)）
    drawButton(ctx, { x: 12, y: 12, w: 106, h: 42 }, '← 主菜单', { variant: 'ghost', fontSize: UI.size.body });

    // 底部提示
    drawStickerText(ctx,
      isCoarsePointer() ? '点击选项确认 · 左上角返回主菜单' : '↑↓ 选择 · 回车 确认 · Esc 继续',
      W / 2, H - 44, {
      font: `bold ${UI.size.small}px ${UI.font.ui}`, fill: UI.color.sub, stroke: UI.color.rim, lineWidth: 5, align: 'center', baseline: 'middle',
    });
  }
}

/** 障碍最右端世界坐标（摆锤按摆球扫到的最右点估算） */
function xOf(o: Obstacle): number {
  if (o.kind === 'PENDULUM') return o.ballCX + o.ballR + 60;
  return o.x + o.w;
}
