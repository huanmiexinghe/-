// 星级与连击目标口径（纯函数，便于自检）
//
// stars = clear ? 1 + allGems + comboGoal : 0
// - ★1：到达终点即获得
// - ★2：收集本关全部晶片（无晶片的关卡自动满足）
// - ★3：本局最高连击达到关卡 maxCombo（maxCombo = 0 视为自动满足）

export interface StarInput {
  cleared: boolean;
  totalGems: number;
  collectedGems: number;
  maxCombo: number;
  targetCombo: number;
}

export interface StarResult {
  stars: number;
  clear: boolean;
  allGems: boolean;
  comboGoal: boolean;
  /** 还缺多少枚晶片（0 表示已满） */
  missingGems: number;
  /** 距离 ★3 还差多少连击（0 表示已达成） */
  missingCombo: number;
}

export function computeStars(input: StarInput): StarResult {
  const total = Math.max(0, Math.floor(input.totalGems));
  const collected = Math.min(total, Math.max(0, Math.floor(input.collectedGems)));
  const allGems = total === 0 || collected >= total;
  const target = Math.max(0, Math.floor(input.targetCombo));
  const comboGoal = target === 0 || input.maxCombo >= target;
  const clear = input.cleared;
  const stars = clear ? 1 + (allGems ? 1 : 0) + (comboGoal ? 1 : 0) : 0;
  return {
    stars,
    clear,
    allGems,
    comboGoal,
    missingGems: total - collected,
    missingCombo: Math.max(0, target - Math.max(0, input.maxCombo)),
  };
}

/** 从存档记录读取已获得的星数（未通关为 0） */
export function starsForRecord(rec: { completed: boolean; stars?: number } | undefined | null): number {
  if (!rec || !rec.completed) return 0;
  return Math.max(0, Math.min(3, Math.floor(rec.stars ?? 1)));
}
