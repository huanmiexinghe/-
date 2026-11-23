// 成就数据（对应计划书 9.4）

export interface AchievementDef {
  id: string;
  name: string;
  desc: string;
  icon: string;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'FIRST_STEP',       name: '第一步',       desc: '完成第 1 关', icon: '始' },
  { id: 'POLARITY_MASTER',  name: '极性大师',     desc: '单局连击达到 30', icon: '极' },
  { id: 'SPEED_DEMON',      name: '速度恶魔',     desc: '使用加速带通过第 26 关', icon: '速' },
  { id: 'NO_DEATH_RUN',     name: '无伤通关',     desc: '连续通关 5 关不死亡', icon: '韧' },
  { id: 'GRAVITY_DEFYER',   name: '违抗重力',     desc: '重力翻转状态下累计存活 5 秒', icon: '重' },
  { id: 'PORTAL_NINJA',     name: '传送忍者',     desc: '传送后 0.5 秒内切换极性', icon: '门' },
  { id: 'COMBO_KING',       name: '连击之王',     desc: '单局连击达到 50', icon: '王' },
  { id: 'ALL_CLEAR',        name: '全部通关',     desc: '通关全部常规关卡', icon: '全' },
  { id: 'PERFECTIONIST',    name: '完美主义者',   desc: '全部常规关卡都达到目标时间', icon: '满' },
  { id: 'ENDLESS_WARRIOR',  name: '无尽战士',     desc: '无尽模式存活超过 3 分钟', icon: '恒' },
  { id: 'ALL_STARS',        name: '全星收藏家',   desc: '全部常规关卡拿到 ★3', icon: '星' },
  { id: 'NO_DEATH_10',      name: '无伤十关',     desc: '10 个不同关卡以 0 死亡通关', icon: '十' },
  { id: 'ENDLESS_1000',     name: '无尽千里',     desc: '单局无尽跑过 1000 米', icon: '千' },
  { id: 'DAILY_7',          name: '每日七日',     desc: '连续 7 天完成每日挑战', icon: '日' },
  { id: 'PHASE_WALKER',     name: '相位行者',     desc: '累计穿过 50 面相位墙', icon: '相' },
];

export function getAchievement(id: string): AchievementDef | undefined {
  return ACHIEVEMENTS.find(a => a.id === id);
}
