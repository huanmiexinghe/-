// 全局配置参数（对应计划书 9.1 / 9.2 / 9.3）

export const GAME_CONFIG = {
  // 画面
  CANVAS_WIDTH: 960,
  CANVAS_HEIGHT: 540,
  GROUND_Y: 440,          // 地面线（逻辑坐标）
  CEILING_Y: 100,         // 天花板线

  // 玩家
  PLAYER_SIZE: 40,
  PLAYER_SLIDE_HEIGHT: 24,
  RUN_SPEED: 320,
  JUMP_FORCE: -520,
  GRAVITY: 1400,
  MAX_FALL_SPEED: 800,
  SLIDE_DURATION: 0.6,
  SLIDE_COOLDOWN: 0.3,
  SWITCH_COOLDOWN: 0.18,
  // 切换极性后的短暂容错时间；必须严格 < SWITCH_COOLDOWN，
  // 否则狂点切换可持续刷新无敌帧（实体柱子在碰撞中无视此容错）
  SWITCH_GRACE_TIME: 0.1,

  // 摄像机
  CAMERA_SMOOTH: 5,
  CAMERA_OFFSET_X: 0.35,

  // 连击速度加成
  COMBO_SPEED_BONUS_20: 0.05,
  COMBO_SPEED_BONUS_30: 0.10,
  COMBO_SPEED_BONUS_50: 0.15,

  // 加速带
  SPEED_BOOST_MULTIPLIER: 2.0,
  SPEED_BOOST_DURATION: 3.0,

  // 磁暴摆锤（M11）的数值统一收口在 systems/Mechanics.ts 的 MECH.PEND，
  // 避免两处常量漂移（旧版的 PENDULUM_MAGNET_* 已移除）

  // 死亡/重生
  RESPAWN_DELAY: 0.5,
  DEATH_EFFECT_DURATION: 0.2,

  // 跳关
  SKIP_THRESHOLD: 3,
  SKIP_CHARGES_PER_5_LEVELS: 1,
  MAX_SKIP_CHARGES: 3,
  /** 跳关/重开等破坏性操作的二次确认窗口（秒） */
  CONFIRM_WINDOW: 3.0,

  // 移动浮台（FR-06）
  MOVING_PLATFORM_RANGE_MIN: 60,
  MOVING_PLATFORM_RANGE_MAX: 140,
  MOVING_PLATFORM_PERIOD_MIN: 2.4,
  MOVING_PLATFORM_PERIOD_MAX: 4.0,

  // 脉冲激光（FR-06）
  PULSE_LASER_PERIOD_MIN: 2.4,
  PULSE_LASER_PERIOD_MAX: 3.2,
  PULSE_LASER_WARN: 0.8,
  PULSE_LASER_ON_MIN: 0.4,
  PULSE_LASER_ON_MAX: 0.6,
  PULSE_LASER_HEIGHT: 42,

  // 终点提示（FR-03）
  FINISH_GEM_HINT_DISTANCE: 900,

  // 无尽模式 2.0（FR-07）
  ENDLESS_MAX_SPEED_FACTOR: 2.0,
  ENDLESS_SPEED_STEP_SECONDS: 40,
  ENDLESS_SPEED_STEP: 0.08,
  ENDLESS_STORM_INTERVAL: 50,
  ENDLESS_STORM_DURATION: 12,
  ENDLESS_STORM_SPEED_BONUS: 0.12,
  ENDLESS_ZONE_SAFE_CORRIDOR: 600,

  // 每日挑战（FR-08）
  DAILY_DURATION: 180,
  DAILY_MODIFIER_COUNT: 2,
  DAILY_FIRST_CLEAR_CORES: 3,

  // 音频
  MASTER_VOLUME: 0.5,
};

// 卡通配色：明亮糖果色 + 深靛描边；红/蓝极性沿用原版高饱和色。
export const COLORS = {
  BG: '#0a0a0f',
  RED: '#ff2d5e',
  BLUE: '#00d4ff',
  /** 尖刺专用色：按参考图取更亮的粉红/亮蓝，靠白描边承担辨识 */
  SPIKE_RED: '#f2637e',
  SPIKE_BLUE: '#5aa9f0',
  GRAY: '#5a5a6a',
  PORTAL_A: '#b026ff',
  PORTAL_B: '#00ffa3',
  REVERSE_ZONE: '#ffd700',
  SPEED_BOOST: '#ffffff',
  GRAVITY: '#00ff41',
  SAFE_ZONE: '#2a2a3a',
  UI_TEXT: '#ffffff',
  UI_SUBTEXT: '#888899',
  PROGRESS_BG: '#1a1a2a',
  PROGRESS_FILL: '#ff2d5e',
  COLLECTIBLE: '#ffd700',
  SPECIAL_ITEM: '#ff8a3d',
  SPECIAL_DOOR: '#c77dff',
  PLATFORM: '#39d0c0',
  LASER: '#00d4ff',
  MOVING_PLATFORM: '#39d0c0',
  PIT: '#0a0a0f',
} as const;

export const KEY_BINDINGS = {
  SWITCH_POLARITY: ['Space'],
  JUMP: ['ArrowUp', 'KeyW'],
  SLIDE: ['ArrowDown', 'KeyS'],
  PAUSE: ['Escape', 'KeyP'],
  CONFIRM: ['Enter', 'Space'],
} as const;

export type Polarity = 'RED' | 'BLUE';
export type ObstacleType =
  | 'RED_SPIKE' | 'BLUE_SPIKE' | 'BLUE_LASER' | 'WALL'
  | 'PORTAL_A' | 'PORTAL_B'
  | 'POLARITY_ZONE' | 'SPLIT_PATH'
  | 'GRAVITY_FLIP' | 'SPEED_BOOST' | 'FINISH';

export function polarityColor(p: Polarity): string {
  return p === 'RED' ? COLORS.RED : COLORS.BLUE;
}
