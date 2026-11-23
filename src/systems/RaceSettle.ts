// 联机完赛后的观战/结算纯逻辑：不依赖 DOM，便于 selfcheck 断言
// 目标：全部完赛、部分退出/掉线、等待超时都能进入结算；观战目标越界能自动回退

export interface RacePlayerLite {
  id: string;
  name: string;
  disconnected?: boolean;
}

export interface RaceResultRow {
  id: string;
  name: string;
  finished: boolean;
  time: number;
  self: boolean;
  /** 世界坐标 x（用于 "各自进度"；未知为 0） */
  progress: number;
}

export type SettleReason = 'all_finished' | 'timeout' | 'left';

/** 等待超时（服务端看门狗之前，客户端先兜底，避免旧服务端永久卡住） */
export const SETTLE_TIMEOUT_MS = 65_000;
/** 对手长时间没有前进（挂机/卡住）的判定阈值，与服务端看门狗一致 */
export const RACE_STALL_MS = 35_000;
/** 掉线宽限：与服务端 30 秒重连窗口一致，窗口内仍算“还在场” */
export const DISCONNECT_GRACE_MS = 30_000;

/**
 * 是否该进结算：
 * - 自己必须已经完赛（未完赛的人仍在比赛，不应被结算）
 * - 其他人要么已完赛、要么已掉线（30 秒重连窗口内也算，超时后会被移出 players）
 * - timeoutHit = true 时强制结算（有人一直不动）
 */
export function isRaceSettled(
  players: readonly RacePlayerLite[],
  selfId: string,
  selfFinished: boolean,
  finishTimes: ReadonlyMap<string, number>,
  timeoutHit = false,
): boolean {
  if (!selfFinished) return false;
  if (timeoutHit) return true;
  return players
    .filter(p => p.id !== selfId)
    .every(p => finishTimes.has(p.id) || !!p.disconnected);
}

/** 结算原因：全员完赛 / 超时 / 有人退出后剩余人都完赛 */
export function settleReasonOf(
  players: readonly RacePlayerLite[],
  selfId: string,
  finishTimes: ReadonlyMap<string, number>,
  timeoutHit: boolean,
): SettleReason {
  if (timeoutHit) return 'timeout';
  const others = players.filter(p => p.id !== selfId);
  if (others.every(p => finishTimes.has(p.id))) return 'all_finished';
  return 'left';
}

/**
 * 观战候选：除自己外的人。
 * 排序：仍在跑的按进度从高到低 → 已完赛按成绩 → 掉线的放最后（可能还在重连）
 */
export function spectateCandidates(
  players: readonly RacePlayerLite[],
  selfId: string,
  finishTimes: ReadonlyMap<string, number>,
  positions: ReadonlyMap<string, number>,
): string[] {
  const others = players.filter(p => p.id !== selfId);
  const running = others
    .filter(p => !p.disconnected && !finishTimes.has(p.id))
    .sort((a, b) => (positions.get(b.id) ?? 0) - (positions.get(a.id) ?? 0));
  const done = others
    .filter(p => !p.disconnected && finishTimes.has(p.id))
    .sort((a, b) => (finishTimes.get(a.id) ?? 0) - (finishTimes.get(b.id) ?? 0));
  const offline = others.filter(p => p.disconnected);
  return [...running, ...done, ...offline].map(p => p.id);
}

/**
 * 切换观战目标（dir > 0 下一位，dir < 0 上一位）。
 * 目标为空 / 已不在候选（玩家退出、房间变化）时回退到边界候选，不越界。
 */
export function cycleSpectate(current: string, candidates: readonly string[], dir: number): string {
  if (candidates.length === 0) return '';
  const step = dir >= 0 ? 1 : -1;
  const idx = candidates.indexOf(current);
  if (idx < 0) {
    if (!current) return step > 0 ? candidates[0] : candidates[candidates.length - 1];
    // 当前目标已退出：回退到第一个候选（保持可预期）
    return candidates[0];
  }
  return candidates[(idx + step + candidates.length) % candidates.length];
}

/**
 * 掉线宽限：把“刚掉线、还在 30 秒重连窗口内”的人当成仍在场，
 * 避免一次网络抖动就让观战者提前进结算。
 */
export function withDisconnectGrace(
  players: readonly RacePlayerLite[],
  disconnectedAt: ReadonlyMap<string, number>,
  now: number,
  graceMs = DISCONNECT_GRACE_MS,
): RacePlayerLite[] {
  return players.map(p => {
    if (!p.disconnected) return p;
    const at = disconnectedAt.get(p.id);
    if (at === undefined) return p;
    return now - at >= graceMs ? p : { ...p, disconnected: false };
  });
}

/**
 * 观战时的“等待超时”判定：所有仍在跑的对手都超过 stallMs 没前进时返回他们。
 * 只要还有一人在推进就返回空数组（不能把正在正常比赛的人结算掉）。
 * lastProgressAt 没有记录时视为“刚开始计时”，不算停滞。
 */
export function stalledUnfinished(
  players: readonly RacePlayerLite[],
  selfId: string,
  finishTimes: ReadonlyMap<string, number>,
  lastProgressAt: ReadonlyMap<string, number>,
  now: number,
  stallMs = RACE_STALL_MS,
): string[] {
  const running = players.filter(
    p => p.id !== selfId && !finishTimes.has(p.id) && !p.disconnected,
  );
  if (running.length === 0) return [];
  const stalled = running.filter(p => {
    const at = lastProgressAt.get(p.id);
    return at !== undefined && now - at >= stallMs;
  });
  return stalled.length === running.length ? stalled.map(p => p.id) : [];
}

/** 结算/排行榜：完赛按成绩升序 → 未完成按进度降序 → 掉线未完成垫底 */
export function buildStandings(
  players: readonly RacePlayerLite[],
  selfId: string,
  selfFinished: boolean,
  selfTime: number,
  finishTimes: ReadonlyMap<string, number>,
  positions: ReadonlyMap<string, number>,
): RaceResultRow[] {
  const rows: RaceResultRow[] = players.map(p => {
    const self = p.id === selfId;
    const finished = self ? selfFinished : finishTimes.has(p.id);
    const time = self ? (selfFinished ? selfTime : 0) : (finishTimes.get(p.id) ?? 0);
    const progress = self ? (positions.get(selfId) ?? 0) : (positions.get(p.id) ?? 0);
    return { id: p.id, name: p.name, finished, time, self, progress };
  });
  return rows.sort((a, b) => {
    if (a.finished && b.finished) return a.time - b.time;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.progress - a.progress;
  });
}
