// 联机消息的基础校验（纯函数，便于单测）
// 位移/时间一致性用物理最高速度估算：明显快于理论极限的成绩直接丢弃。

export const MAX_SPEED_PX_PER_SEC = 1400;

/** 完赛成绩是否可被接受：比赛中、未提交过、时间合理且与位移一致 */
export function validateFinish({
  phase,
  alreadyFinished,
  time,
  lastX,
  maxSpeed = MAX_SPEED_PX_PER_SEC,
}) {
  if (phase !== 'race') return false;
  if (alreadyFinished) return false;
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > 3600) return false;
  if (time + 0.5 < lastX / maxSpeed) return false;
  return true;
}
