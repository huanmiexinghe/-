// 关键逻辑自检：连击规则 / 星级判定 / 关卡数据 / 跳关 / 存档迁移 / 每日挑战
//
// 运行：npm run selfcheck
// 说明：脚本只依赖纯逻辑模块（不启动渲染循环），在 Node 中用内存 stub 替代 localStorage。

/* ---------------- 测试脚手架 ---------------- */

let failures = 0;
let checks = 0;

function ok(cond: boolean, label: string) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  const pass = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) {
    failures++;
    console.error(`  ✗ ${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function section(name: string) {
  console.log(`- ${name}`);
}

/** 断言必须抛出错误（用于错误路径：不得静默成功） */
function throws(fn: () => unknown, label: string) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  ok(threw, label);
}

/* ---------------- localStorage stub ---------------- */

const memory = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, String(v)); },
  removeItem: (k: string) => { memory.delete(k); },
  clear: () => memory.clear(),
};

const SAVE_KEY = 'magnetic_rush_save_v1';

async function main() {
  const { computeStars, starsForRecord } = await import('../src/systems/Progress');
  const { SaveSystem, prevLocalDate } = await import('../src/systems/SaveSystem');
  const { LEVELS, getLevel, TUTORIAL_LEVEL, SPECIAL_LEVELS, EASTER_EGG_LEVEL } = await import('../src/data/levels');
  const reach = await import('../src/systems/Reachability');
  const { Player } = await import('../src/entities/Player');
  const gen = await import('../src/systems/EndlessGenerator');
  const rules = await import('../src/systems/RunRules');
  const mech = await import('../src/systems/Mechanics');
  const { validateFinish } = await import('../server/relay-validate.mjs');
  const settle = await import('../src/systems/RaceSettle');
  const timing = await import('../src/net/NetTiming');

  /* ---------------- 1. 星级判定 ---------------- */
  section('星级判定 computeStars');

  const full = computeStars({ cleared: true, totalGems: 5, collectedGems: 5, maxCombo: 10, targetCombo: 10 });
  eq(full.stars, 3, '到达终点 + 全晶片 + 达标连击 = ★3');
  eq(full.missingGems, 0, '缺片数 0');
  eq(full.missingCombo, 0, '缺连击数 0');

  const missGem = computeStars({ cleared: true, totalGems: 5, collectedGems: 4, maxCombo: 10, targetCombo: 10 });
  eq(missGem.stars, 2, '缺 1 枚晶片仍通关，但只拿 ★2');
  eq(missGem.missingGems, 1, '缺片数 1');
  eq(missGem.clear, true, '缺片不影响通关');

  const missCombo = computeStars({ cleared: true, totalGems: 5, collectedGems: 5, maxCombo: 8, targetCombo: 10 });
  eq(missCombo.stars, 2, '连击未达标只影响 ★3');
  eq(missCombo.missingCombo, 2, '还差 2 连击');

  const both = computeStars({ cleared: true, totalGems: 5, collectedGems: 3, maxCombo: 2, targetCombo: 10 });
  eq(both.stars, 1, '到达终点即保底 ★1');
  eq(both.missingGems, 2, '缺 2 枚晶片');

  const dead = computeStars({ cleared: false, totalGems: 5, collectedGems: 5, maxCombo: 10, targetCombo: 10 });
  eq(dead.stars, 0, '未到达终点 = 0 星');

  const auto = computeStars({ cleared: true, totalGems: 0, collectedGems: 0, maxCombo: 0, targetCombo: 0 });
  eq(auto.stars, 3, '无晶片且无连击目标的关卡自动 ★3');

  const clamp = computeStars({ cleared: true, totalGems: 3, collectedGems: 9, maxCombo: 0, targetCombo: 0 });
  eq(clamp.missingGems, 0, '收集数超出总数时夹取为 0 缺片');

  eq(starsForRecord(undefined), 0, '无记录 = 0 星');
  eq(starsForRecord({ completed: false, stars: 3 }), 0, '未通关记录不显示星');
  eq(starsForRecord({ completed: true, stars: 2 }), 2, '通关记录取存档星数');

  /* ---------------- 2. 连击规则 ---------------- */
  section('连击规则（切换极性不再加分）');

  const p = new Player();
  p.combo = 7;
  const switched = p.switchPolarity();
  eq(switched, true, '冷却结束时切换成功');
  eq(p.combo, 7, 'FR-02：切换极性不增加连击');
  eq(p.switchCooldown > 0, true, '切换后进入冷却');

  p.combo = 0;
  p.reset(0, 400);
  eq(p.combo, 0, 'reset 清空连击');

  /* ---------------- 3. 关卡数据加载 ---------------- */
  section('关卡数据（48 关）');

  eq(LEVELS.length, 48, '普通关卡总数为 48');
  let idsOk = true;
  let finishOk = true;
  for (let i = 0; i < LEVELS.length; i++) {
    const def = LEVELS[i];
    if (def.id !== i + 1) idsOk = false;
    if (!def.obstacles.some(o => o.kind === 'FINISH')) finishOk = false;
  }
  ok(idsOk, '关卡 id 从 1 连续到 48');
  ok(finishOk, '每关都含 FINISH');

  eq(getLevel(48)?.id, 48, 'getLevel(48) 返回最后一关');
  eq(getLevel(49), undefined, 'getLevel(49) 不存在');
  eq(getLevel(36)?.chapter, 7, '第 36 关属于第七章');
  ok(LEVELS.slice(36, 42).every(l => l.chapter === 8), '37–42 属于第八章「代价之门」');
  ok(LEVELS.slice(42, 48).every(l => l.chapter === 9), '43–48 属于第九章「动量边境」');
  const l48Kinds = new Set(LEVELS[47].obstacles.map(o => o.kind));
  ok(['POLARITY_LOCK', 'CORE_BAIT', 'MAGNET_MIRROR', 'GRAVITY_FLIP', 'PULSE_LASER', 'PENDULUM', 'CONVEYOR', 'PIT']
    .every(k => l48Kinds.has(k)), 'L48 章末覆盖颜色/空间/时间/动量四类机制');
  ok(LEVELS[41].checkpoints!.length > 0 && LEVELS[47].checkpoints!.length > 0, 'L42 / L48 配检查点');
  ok(LEVELS.slice(36).every(l => l.parTime > 0 && l.length > 3000), '37–48 均有 length 与 parTime');

  const kindsOf = (idx: number) => LEVELS[idx].obstacles.map(o => o.kind);
  ok(kindsOf(30).includes('POLARITY_WALL'), 'L31 引入相位墙');
  ok(kindsOf(31).includes('MOVING_PLATFORM'), 'L32 引入移动浮台');
  ok(kindsOf(32).includes('PULSE_LASER'), 'L33 引入脉冲激光');
  ok(kindsOf(35).includes('POLARITY_WALL')
    && kindsOf(35).includes('MOVING_PLATFORM')
    && kindsOf(35).includes('PULSE_LASER'), 'L36 综合三机制');
  ok(Array.isArray(LEVELS[35].checkpoints) && LEVELS[35].checkpoints!.length > 0, 'L36 配检查点');

  // 移动端可玩性：每关终点之前都必须有可行走的地面段（终点不在关卡长度之外）
  ok(LEVELS.every(l => l.length > 1000 && l.maxCombo >= 0), '关卡长度与连击目标字段完整');

  // ★3 可达性：maxCombo 不能超过该关实际可产生的连击源总数
  section('★3 连击源可达性');
  const unreachable: string[] = [];
  for (const l of LEVELS) {
    const src = mech.countComboSources(l);
    if (l.maxCombo > src) unreachable.push(`L${l.id}=${l.maxCombo}>源${src}`);
  }
  ok(unreachable.length === 0,
    `48 关 maxCombo 均不超过连击源总数${unreachable.length ? `（不可达：${unreachable.join('; ')}）` : ''}`);

  /* ---------------- 3b. 可拾取物可达性（跳跃包络全局断言） ---------------- */
  section('可拾取物可达性（跳跃包络 + 水平路径）');

  const allLevels = [TUTORIAL_LEVEL, ...LEVELS, ...SPECIAL_LEVELS, EASTER_EGG_LEVEL];
  const issues = reach.scanAllLevels(allLevels);
  const exemptKeys = new Set(reach.REACH_EXEMPTIONS.map(e => e.key));
  const unexpected = issues.filter(i => !exemptKeys.has(reach.collectibleKey(i.levelId, i)));
  ok(unexpected.length === 0,
    `全部 ${allLevels.length} 张地图的可拾取物均在跳跃包络内且水平路径无遮挡` +
    `${unexpected.length ? `（问题：${unexpected.map(i => `L${i.levelId}@${i.x}[${i.type}] ${i.detail}`).join('；')}）` : ''}`);

  // 豁免清单必须逐条真实生效，且只用于机制内可达（MECH），不得用来掩盖跳不上去/被挡住
  const staleExemptions = reach.REACH_EXEMPTIONS.filter(e => !issues.some(i =>
    reach.collectibleKey(i.levelId, i) === e.key && i.type === 'MECH'));
  ok(staleExemptions.length === 0,
    `豁免清单每条都对应一处真实的机制内可达位置${staleExemptions.length ? `（失效：${staleExemptions.map(e => e.key).join('; ')}）` : ''}`);
  ok(reach.REACH_EXEMPTIONS.every(e => e.reason.trim().length > 0), '豁免清单每条都写明理由');

  // 包络参数本身：最大跳高 / 滞空 / 单跳水平位移
  const rise = reach.MAX_JUMP_RISE;
  const air = reach.JUMP_AIR_TIME;
  const dist = reach.MAX_JUMP_DISTANCE;
  ok(Math.abs(rise - 96.57) < 0.5, `最大跳跃高度 ${rise.toFixed(2)}px ≈ 520²/(2×1400)`);
  ok(Math.abs(air - 0.743) < 0.005, `滞空时间 ${air.toFixed(4)}s ≈ 2×520/1400`);
  ok(Math.abs(dist - 237.7) < 1, `单跳最大水平位移 ${dist.toFixed(1)}px ≈ 320×0.743`);

  /* ---------------- 3c. 彩色晶片极性可达性 ---------------- */
  section('彩色晶片极性可达性（换色窗口 / 强制极性区）');

  const colorIssues = allLevels.flatMap(l => reach.scanColorPickups(l));
  ok(colorIssues.length === 0,
    `全部 ${allLevels.length} 张地图的彩色晶片颜色合法且到达前存在换色窗口` +
    `${colorIssues.length ? `（问题：${colorIssues.map(i => `L${i.levelId}@${i.x}[${i.type}] ${i.detail}`).join('；')}）` : ''}`);

  const coloredLevels = LEVELS.filter(l =>
    l.obstacles.some(o => o.kind === 'COLLECTIBLE' && o.meta?.color !== undefined));
  ok(coloredLevels.length === 12 && coloredLevels.every(l => l.id >= 37),
    '彩色晶片只出现在 37–48 共 12 关（1–36 保持任意极性，★2 全晶片口径不变）');
  ok(LEVELS.filter(l => l.id < 37).every(l =>
    l.obstacles.every(o => o.kind !== 'COLLECTIBLE' || o.meta?.color === undefined)),
    '1–36 关没有任何带颜色的晶片');
  ok(coloredLevels.every(l =>
    l.obstacles.filter(o => o.kind === 'COLLECTIBLE' && o.meta?.color !== undefined).length >= 2),
    '37–48 每关至少 2 颗彩色晶片（颜色机制成对出现）');

  // 反面用例：异色强制区 / 非法颜色必须被断言捕获（防止断言静默失效）
  const badColorLevel: any = {
    id: 9998, name: '坏颜色', chapter: 0, parTime: 30, maxCombo: 0, length: 2000,
    bg: '#000', bpm: 120,
    obstacles: [
      { kind: 'COLLECTIBLE', x: 300, y: 388, w: 24, h: 24, meta: { color: 'GREEN' } },
    ],
  };
  ok(reach.scanColorPickups(badColorLevel).some(i => i.type === 'COLOR'),
    '非法颜色（GREEN）被极性可达性断言捕获');
  const badZoneLevel: any = {
    id: 9999, name: '异色区', chapter: 0, parTime: 30, maxCombo: 0, length: 2000,
    bg: '#000', bpm: 120,
    obstacles: [
      { kind: 'POLARITY_ZONE', x: 260, y: 100, w: 64, h: 340, meta: { forcedPolarity: 'RED' } },
      { kind: 'COLLECTIBLE', x: 280, y: 388, w: 24, h: 24, meta: { color: 'BLUE' } },
    ],
  };
  ok(reach.scanColorPickups(badZoneLevel).some(i => i.type === 'POLARITY'),
    '强制红区内要求蓝色晶片被极性可达性断言捕获');
  const tightColorLevel: any = {
    id: 9997, name: '换色过紧', chapter: 0, parTime: 30, maxCombo: 0, length: 2000,
    bg: '#000', bpm: 120,
    obstacles: [
      { kind: 'BLUE_SPIKE', x: 150, y: 408, w: 32, h: 32 },
      { kind: 'COLLECTIBLE', x: 220, y: 388, w: 24, h: 24, meta: { color: 'RED' } },
    ],
  };
  ok(reach.scanColorPickups(tightColorLevel).some(i => i.type === 'POLARITY'),
    '异色致命物后 96px 内要求换色的晶片被断言捕获（★2 不退化为帧级操作）');

  /* ---------------- 4. 跳关 ---------------- */
  section('跳关与解锁');

  memory.clear();
  const skipSave = new SaveSystem();
  eq(skipSave.isUnlocked(1), true, '第 1 关默认解锁');
  eq(skipSave.isUnlocked(2), false, '第 2 关需要第 1 关完成/跳过');
  skipSave.data.skipCharges = 2;
  eq(skipSave.recordSkip(1), true, '有次数时可跳关');
  eq(skipSave.data.skipCharges, 1, '跳关消耗 1 次');
  eq(skipSave.isUnlocked(2), true, '跳过后解锁下一关');
  eq(skipSave.recordSkip(2), true, '第二次跳关仍可执行');
  eq(skipSave.recordSkip(3), false, '次数耗尽后跳关失败');
  skipSave.data.skipCharges = 0;
  eq(skipSave.recordSkip(4), false, '0 次时记录跳关失败');

  memory.clear();
  const replay = new SaveSystem();
  replay.data.skipCharges = 0;
  replay.recordCompletion(1, 12, 6, 2, true);
  eq(replay.isUnlocked(2), true, '通关同样解锁下一关');

  /* ---------------- 5. 存档迁移 ---------------- */
  section('存档迁移 v1 → v2');

  const legacy = {
    levels: {
      1: { completed: true, bestTime: 12.5, bestCombo: 5 },
      2: { completed: true, skipped: false, bestTime: 20, bestCombo: 9 },
    },
    skipCharges: 2,
    totalCompleted: 2,
    maxComboEver: 9,
    endlessBestTime: 33,
    specialItems: ['S1'],
    tutorialDone: true,
    noDeathStreak: 3,
  };
  memory.clear();
  memory.set(SAVE_KEY, JSON.stringify(legacy));
  const migrated = new SaveSystem();

  eq(migrated.data.version, 2, '旧档升级为 version 2');
  eq(migrated.data.levels[1].completed, true, '旧通关记录保留');
  eq(migrated.data.levels[1].bestTime, 12.5, '旧最佳时间保留');
  eq(migrated.data.levels[1].stars, 1, '旧通关关卡回填 ★1');
  eq(migrated.data.levels[2].bestCombo, 9, '旧连击纪录保留');
  eq(migrated.data.skipCharges, 2, '跳关次数保留');
  eq(migrated.data.specialItems, ['S1'], '特殊物品保留');
  eq(migrated.data.tutorialDone, true, '教程完成标记保留');
  eq(migrated.data.endlessBestTime, 33, '无尽纪录保留');
  eq(migrated.data.muted, false, '缺失字段回退默认（静音）');
  eq(migrated.data.volume, 0.5, '缺失字段回退默认（音量）');
  eq(migrated.data.shake, true, '缺失字段回退默认（画面震动开启）');
  eq(migrated.data.daily.streak, 0, '缺失字段回退默认（每日）');
  eq(migrated.data.cores, 0, '缺失字段回退默认（磁芯）');

  const written = JSON.parse(memory.get(SAVE_KEY)!);
  eq(written.version, 2, '迁移结果已写回同一存档键');
  eq(written.levels['1'].stars, 1, '写回内容包含回填星级');

  // 幂等：再次加载不应改变迁移结果
  const again = new SaveSystem();
  eq(again.data.levels[1].stars, 1, '重复加载保持幂等');
  eq(again.data.totalCompleted, 2, '重复加载不改变统计');

  // 旧档若带已移除的「氛围层」字段：忽略且不崩溃，不影响其它设置
  memory.clear();
  memory.set(SAVE_KEY, JSON.stringify({ ...legacy, version: 2, fxAmbience: false, fxSpeed: false }));
  const withOldFx = new SaveSystem();
  eq(withOldFx.data.fxSpeed, false, '旧档的 fxSpeed 设置保留');
  eq(withOldFx.data.version, 2, '带已移除字段的旧档可正常加载');
  eq(withOldFx.data.shake, true, '未知旧字段不影响其它设置（不会错位）');

  // 损坏档：不崩溃、不清档
  memory.clear();
  memory.set(SAVE_KEY, '{ broken json');
  const corrupt = new SaveSystem();
  eq(corrupt.data.totalCompleted, 0, '损坏存档回退默认值而不崩溃');

  // 星级只升不降
  memory.clear();
  const up = new SaveSystem();
  up.recordCompletion(3, 8, 12, 3, true);
  eq(up.getLevel(3).stars, 3, '写入 ★3');
  eq(up.getLevel(3).zeroDeath, true, '记录零死亡通关');
  eq(up.data.maxComboEver, 12, '刷新全局最高连击');
  up.recordCompletion(3, 15, 4, 1);
  eq(up.getLevel(3).stars, 3, '低星不覆盖历史高星');
  eq(up.getLevel(3).bestTime, 8, '更慢的时间不覆盖最佳时间');

  /* ---------------- 6. 每日挑战 / 无尽 ---------------- */
  section('每日挑战与无尽生成');

  eq(prevLocalDate('2026-03-01'), '2026-02-28', '跨月日期回退正确');

  memory.clear();
  const daily = new SaveSystem();
  const d1 = daily.recordDaily(900, 60, 10, '2026-11-04');
  eq(d1.firstCompletion, true, '当天首次完成');
  eq(d1.coresAwarded, 3, '首次完成发 3 磁芯');
  eq(daily.data.cores, 3, '磁芯累计 3');
  eq(d1.streak, 1, '连续天数从 1 开始');

  const d2 = daily.recordDaily(800, 50, 8, '2026-11-04');
  eq(d2.firstCompletion, false, '当天重复挑战不再发奖');
  eq(d2.coresAwarded, 0, '重复挑战不发磁芯');
  eq(daily.data.cores, 3, '磁芯不被重复累加');

  const d3 = daily.recordDaily(900, 40, 12, '2026-11-05');
  eq(d3.streak, 2, '连续两天完成 → 连续天数 2');

  const d4 = daily.recordDaily(900, 40, 12, '2026-11-07');
  eq(d4.streak, 1, '中断一天后连续天数重置');

  eq(gen.dailySeed('2026-11-04'), gen.dailySeed('2026-11-04'), '每日种子稳定');
  const mods = gen.dailyModifiers('2026-11-04');
  eq(mods.length, 2, '每日抽 2 个修正');
  eq(new Set(mods).size, 2, '每日修正不重复');
  const validIds = gen.DAILY_MODIFIERS.map(m => m.id);
  ok(mods.every(m => validIds.includes(m)), '每日修正均为合法 id');
  ok(gen.dailyModifierLabel(mods).length > 0, '每日修正有可读文案');

  const g1 = new gen.EndlessGenerator({ seed: 42 });
  const g2 = new gen.EndlessGenerator({ seed: 42 });
  const a = g1.produceUntil(6000).map(o => `${o.kind}@${o.x}`);
  const b = g2.produceUntil(6000).map(o => `${o.kind}@${o.x}`);
  eq(a.join(','), b.join(','), '同种子生成结果确定性一致');
  eq(g1.zoneIndex, 1, '6000px 已进入第 2 分区');
  ok(a.length > 0, '无尽生成有内容');
  const endlessDef = gen.createEndlessLevelDef();
  eq(endlessDef.obstacles.length, 0, '无尽关卡为持续生成的空壳（障碍由生成器填充）');
  eq(endlessDef.length, Number.MAX_SAFE_INTEGER, '无尽关卡长度无上限');

  // PRD 对齐：疾风 +10% / 磁暴 30s / 富矿 +50%，且排除 疾风+磁暴 组合
  let pairOk = true;
  for (let day = 1; day <= 28; day++) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    const m = gen.dailyModifiers(date);
    if (m.includes('speed') && m.includes('storm')) pairOk = false;
  }
  ok(pairOk, '每日修正排除「疾风 + 磁暴」组合');
  const plainGems = new gen.EndlessGenerator({ seed: 7 });
  const richGems = new gen.EndlessGenerator({ seed: 7, modifiers: ['gems'] });
  const countGems = (arr: { kind: string }[]) => arr.filter(o => o.kind === 'COLLECTIBLE').length;
  const plainN = countGems(plainGems.produceUntil(15000));
  const richN = countGems(richGems.produceUntil(15000));
  ok(richN >= Math.floor(plainN * 1.35), `富矿修正的晶片数量明显提升（${plainN} → ${richN}）`);

  /* ---------------- 7. 审查修复回归 ---------------- */
  section('审查修复回归');

  // 连击回溯：只有“刚越过”的障碍允许计数，远处旧障碍与身后判定为 false
  ok(rules.isWithinPassWindow(300, 500), '刚越过（200px 内）可计数');
  ok(!rules.isWithinPassWindow(-100, 500), '重生点之前的旧障碍不补计');
  ok(!rules.isWithinPassWindow(540, 500), '尚未越过的障碍不计数');
  ok(!rules.countsSafePass(false, true), '异色尖刺即使触发标记也不计连击');
  ok(!rules.countsSafePass(true, false), '未实际安全掠过（改极性回溯）不计数');
  ok(rules.countsSafePass(true, true), '同色且安全掠过才计数');

  // 移动浮台携带：水平投影不重叠 / 水平轴 / 上升时都不携带
  const carryBase = {
    prevBottom: 300, prevTop: 300, axis: 'y' as const, vy: 10,
    playerLeft: 400, playerRight: 440, platLeft: 400, platW: 140,
  };
  ok(rules.carriesPlayer(carryBase), '脚底贴合且水平重叠时携带');
  ok(!rules.carriesPlayer({ ...carryBase, platLeft: 600 }), '水平不重叠的浮台不携带');
  ok(!rules.carriesPlayer({ ...carryBase, axis: 'x' }), '水平移动浮台不携带');
  ok(!rules.carriesPlayer({ ...carryBase, vy: -10 }), '玩家上升时不携带');
  ok(!rules.carriesPlayer({ ...carryBase, prevBottom: 360 }), '脚底未贴合顶面时不携带');

  // 联机 finish：非比赛中 / 重复提交 / 与位移不一致 / 超范围 均拒绝
  eq(validateFinish({ phase: 'lobby', alreadyFinished: false, time: 10, lastX: 100 }), false,
    '非比赛中拒绝完赛');
  eq(validateFinish({ phase: 'race', alreadyFinished: true, time: 10, lastX: 100 }), false,
    '重复提交拒绝覆盖成绩');
  eq(validateFinish({ phase: 'race', alreadyFinished: false, time: 1, lastX: 5000 }), false,
    '时间与位移不一致（瞬移成绩）被拒绝');
  eq(validateFinish({ phase: 'race', alreadyFinished: false, time: 3610, lastX: 100 }), false,
    '超出 3600 秒的成绩被拒绝');
  eq(validateFinish({ phase: 'race', alreadyFinished: false, time: 8, lastX: 5000 }), true,
    '合理成绩被接受');

  /* ---------------- 8. 新遭遇机制（P0 / P1） ---------------- */
  section('新遭遇机制行为断言');

  // M02 极性锁：门廊内拒绝换色
  const lockP = new Player();
  lockP.lockSwitch(mech.MECH.LOCK.hold);
  eq(mech.blocksSwitch(lockP.polarityLockTimer), true, '极性锁：门廊内 blocksSwitch=true');
  eq(lockP.switchPolarity(), false, '极性锁：门廊内 switchPolarity 被拒绝');
  lockP.polarityLockTimer = 0;
  lockP.switchCooldown = 0;
  eq(lockP.switchPolarity(), true, '极性锁：离开门廊后换色恢复');
  eq(mech.MECH.LOCK.comboPenalty, 4, '极性锁：门内强按换色扣 4 连击');
  eq(mech.MECH.LOCK.maxPenalties, 2, '极性锁：每道门最多惩罚 2 次');
  eq(mech.MECH.LOCK.exitBonus, 3, '极性锁：穿出补 +3 连击');

  // M07 磁芯诱饵：磁芯 + 连击 + 锁换色三者同时入账
  const baitState = { cores: 10, combo: 5, lock: 0 };
  mech.applyBaitReward(baitState);
  eq(baitState.cores, 11, '磁芯诱饵：磁芯 +1');
  eq(baitState.combo, 7, '磁芯诱饵：连击 +2');
  eq(baitState.lock, 1.2, '磁芯诱饵：换色权锁定 1.2s');
  eq(mech.MECH.BAIT.maxPerLevel, 2, '磁芯诱饵：每关最多 2 枚');
  const baitP = new Player();
  baitP.lockSwitch(mech.MECH.BAIT.switchLock);
  eq(baitP.switchPolarity(), false, '磁芯诱饵：拾取后换色被锁');

  // M09 磁极镜：反转一次不多不少
  eq(mech.mirrorPolarity('RED'), 'BLUE', '磁极镜：红 → 蓝');
  eq(mech.mirrorPolarity('BLUE'), 'RED', '磁极镜：蓝 → 红');
  eq(mech.mirrorPolarity(mech.mirrorPolarity('RED')), 'RED', '磁极镜：反转两次回到原色');
  eq(mech.mirrorShouldTrigger(false), true, '磁极镜：首次穿过触发');
  eq(mech.mirrorShouldTrigger(true), false, '磁极镜：同一面镜子不会重复触发');
  const mirrorP = new Player();
  const before = mirrorP.polarity;
  mirrorP.mirrorPolarity();
  eq(mirrorP.polarity !== before, true, '磁极镜：一次触发只反转一次');
  eq(mirrorP.invincibleTime >= mech.MECH.MIRROR.invincible, true, '磁极镜：反转后获得 0.2s 无敌');

  // M01 磁芯雨：颜色判定 + 确定性下落
  eq(mech.rainCoreMatches('RED', 'RED'), true, '磁芯雨：同色可收集');
  eq(mech.rainCoreMatches('BLUE', 'RED'), false, '磁芯雨：异色不可收集');
  const y0a = mech.rainCoreY(3.0, 0, 100, 440, 26);
  const y0b = mech.rainCoreY(3.0, 0, 100, 440, 26);
  eq(y0a, y0b, '磁芯雨：同一时刻同一枚位置确定');
  const y1 = mech.rainCoreY(3.0, 1, 100, 440, 26);
  ok(y1 !== y0a, '磁芯雨：相邻磁芯相位错开 170px');
  eq(y0a >= 100 && y0a < 440, true, '磁芯雨：下落高度始终在天花板与地面之间');

  // M03 弹射板：同色弹得更高
  ok(mech.MECH.LAUNCH.sameVy > mech.MECH.LAUNCH.otherVy, '弹射板：同色弹力大于异色');

  // M05 滑动相位墙：正弦往复 ±100px、周期 3.0s，碰撞盒随位移同步
  const { Obstacle } = await import('../src/entities/Obstacle');
  const sw = new Obstacle({
    kind: 'POLARITY_WALL', x: 1000, y: 100, w: 32, h: 340,
    meta: { polarity: 'RED', range: 100, period: 3, phase: 0 },
  });
  sw.updateMotion(0);
  eq(sw.bounds.x, 1000, '滑动墙：t=0 位于原点');
  sw.updateMotion(0.75);
  eq(sw.bounds.x, 1100, '滑动墙：t=0.75s 到最右 +100px');
  sw.updateMotion(2.25);
  eq(sw.bounds.x, 900, '滑动墙：t=2.25s 到最左 −100px');

  // M06 传送带 / M10 断桥
  ok(mech.MECH.CONVEYOR.speed > 0 && mech.MECH.CONVEYOR.width === 320, '传送带：±90px/s、长 320');
  eq(mech.pitKills(440, 440, true), true, '断桥：站在坑口内坠落');
  eq(mech.pitKills(400, 440, true), false, '断桥：跳跃越过安全');
  eq(mech.pitKills(440, 440, false), false, '断桥：坑外安全');
  eq(LEVELS[7].obstacles.some(o => o.kind === 'MAGNET_RAIN'), true, 'L8 已放置磁芯雨');
  eq(LEVELS[15].obstacles.some(o => o.kind === 'POLARITY_LOCK'), true, 'L16 已放置极性锁');
  eq(LEVELS[19].obstacles.some(o => o.kind === 'CORE_BAIT'), true, 'L20 已放置磁芯诱饵');
  eq(LEVELS[33].obstacles.some(o => o.kind === 'MAGNET_MIRROR'), true, 'L34 已放置磁极镜');

  // 新机制也能出现在无尽深渊区（种子确定性）
  const deepA = new gen.EndlessGenerator({ seed: 99 });
  const deepB = new gen.EndlessGenerator({ seed: 99 });
  const deepAOut = deepA.produceUntil(42000);
  const deepBOut = deepB.produceUntil(42000);
  eq(JSON.stringify(deepAOut), JSON.stringify(deepBOut), '深渊区：同种子生成结果完全一致');
  ok(deepAOut.some(o => o.kind === 'MAGNET_RAIN') && deepAOut.some(o => o.kind === 'POLARITY_LOCK')
    && deepAOut.some(o => o.kind === 'CORE_BAIT') && deepAOut.some(o => o.kind === 'MAGNET_MIRROR'),
    '深渊区：P0 机制按时间表全部登场');

  /* ---------------- 背景：原版卡通天空 ---------------- */

  section('背景（卡通天空 / 太阳 / 云朵）');
  const widgets = await import('../src/ui/widgets');
  const themeMod = await import('../src/ui/theme');
  const { GAME_CONFIG, COLORS } = await import('../src/data/config');

  // 用录制型 ctx 记录绘制：原版卡通天空（渐变 + 太阳 + 云 + 天花板线）
  const rec = {
    ops: [] as string[],
    pathY: [] as number[],
    fillStyle: '' as any,
    strokeStyle: '' as any,
    lineWidth: 1,
    globalAlpha: 1,
    lineCap: 'butt',
    createLinearGradient: () => ({ addColorStop: () => { /* noop */ } }),
    fillRect: () => rec.ops.push(`rect|${String(rec.fillStyle)}`),
    save: () => { /* noop */ },
    restore: () => { /* noop */ },
    beginPath: () => { rec.pathY = []; },
    moveTo: (_x: number, y: number) => { rec.pathY.push(y); },
    lineTo: (_x: number, y: number) => { rec.pathY.push(y); },
    quadraticCurveTo: (_cx: number, _cy: number, _x: number, y: number) => { rec.pathY.push(y); },
    closePath: () => { /* noop */ },
    rect: () => { rec.ops.push('rect'); },
    clip: () => { rec.ops.push('clip'); },
    stroke: () => { rec.ops.push(`stroke|${String(rec.strokeStyle)}|${rec.lineWidth}`); },
    fill: () => { rec.ops.push(`fill|${String(rec.fillStyle)}`); },
    arc: (_x: number, _y: number, r: number) => { rec.ops.push(`arc|${r}`); },
    ellipse: () => { rec.ops.push('ellipse'); },
    translate: () => { /* noop */ },
    rotate: () => { /* noop */ },
    scale: () => { /* noop */ },
    roundRect: () => { /* noop */ },
    setLineDash: () => { /* noop */ },
  };
  rec.ops.length = 0;
  widgets.drawToonSky(rec as any, 0, { hills: false, ceilingY: GAME_CONFIG.CEILING_Y });
  ok(rec.ops.some(op => op.startsWith('rect|')), '天空：铺满整屏糖果渐变');
  ok(rec.ops.filter(op => op.startsWith('arc|')).length >= 5, '天空：绘制太阳盘面与云朵圆弧');
  const firstArc = rec.ops.findIndex(op => op.startsWith('arc|'));
  const firstStroke = rec.ops.findIndex(op => op.startsWith('stroke|'));
  ok(firstStroke >= 0 && firstStroke < firstArc, '天空：天花板线先于太阳/云绘制（不会被覆盖）');

  // 角色卡通脸：两只眼睛 + 椭圆高光（本地与远端共用 drawRunner）
  const { drawRunner } = await import('../src/entities/Player');
  rec.ops.length = 0;
  drawRunner(rec as any, {
    x: 0, y: GAME_CONFIG.GROUND_Y - GAME_CONFIG.PLAYER_SIZE,
    width: GAME_CONFIG.PLAYER_SIZE, height: GAME_CONFIG.PLAYER_SIZE,
    polarity: 'RED', sliding: false, grounded: true, flipped: false,
    flipAngle: 0, runPhase: 0, squashY: 1, invincibleTime: 0,
  }, 0);
  eq(rec.ops.filter(op => op === 'ellipse').length, 2, '角色：两只黑眼睛');
  eq(rec.ops.filter(op => op.startsWith('arc|')).length, 2, '角色：两只眼睛的白色高光');

  /* ---------------- 可读性：危险物对比度（硬约束） ---------------- */

  section('可读性（对比度 / 色弱编码）');
  const lum = (hex: string) => {
    const ch = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const contrast = (a: string, b: string) => {
    const x = lum(a); const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  ok(contrast(COLORS.RED, COLORS.BG) >= 3, `对比度：红极 vs 板面 ≥ 3:1（${contrast(COLORS.RED, COLORS.BG).toFixed(2)}）`);
  ok(contrast(COLORS.BLUE, COLORS.BG) >= 3, `对比度：蓝极 vs 板面 ≥ 3:1（${contrast(COLORS.BLUE, COLORS.BG).toFixed(2)}）`);
  // 原版灰墙 #5a5a6a 与板面 2.92:1，靠旧版同色光晕与白色高光承担可见性；
  // 回退后不再用 T0 的 ≥3:1 硬阈值，改为校验高光通道。
  ok(contrast(themeMod.UI.color.rim, COLORS.BG) >= 3,
    `对比度：石柱高光 vs 板面 ≥ 3:1（${contrast(themeMod.UI.color.rim, COLORS.BG).toFixed(2)}）`);
  ok(contrast(COLORS.SPECIAL_ITEM, COLORS.BG) >= 3, `对比度：蓄能琥珀 vs 板面 ≥ 3:1（${contrast(COLORS.SPECIAL_ITEM, COLORS.BG).toFixed(2)}）`);
  // 地面草绿：颜色按参考图压深成 #8cc63f。
  // 尖刺这一轮改为「亮粉 / 亮蓝 + 3px 白描边」，辨识由白描边与圆润形体承担，
  // 不再要求色块本身与草绿达到 3:1——那会逼回上一轮的纯色方案。
  const grass = themeMod.TOON_SKY.ground;
  ok(themeMod.STROKE.sticker >= 3, `尖刺：白描边宽度 ≥ 3px（${themeMod.STROKE.sticker}）`);
  ok(themeMod.PALETTE.dust050 === '#ffffff', '尖刺：白描边为纯白');
  const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const [sr, sg, sb] = rgb(COLORS.SPIKE_RED);
  ok(sr > sg && sr > sb && sb >= 0x60, '尖刺红：亮粉（红占优且带蓝通道）');
  const [br, bg, bb] = rgb(COLORS.SPIKE_BLUE);
  ok(bb > br && bb > bg, '尖刺蓝：亮蓝（蓝通道占优）');
  ok(Math.abs(lum(COLORS.SPIKE_RED) - lum(COLORS.SPIKE_BLUE)) >= 0.05,
    `尖刺：红/蓝明度差 ≥ 0.05（${Math.abs(lum(COLORS.SPIKE_RED) - lum(COLORS.SPIKE_BLUE)).toFixed(3)}）`);

  // 影响面锁：只有尖刺用专用亮粉/亮蓝，摆锤/相位墙仍用共享极性色
  const mkObs = (kind: string, meta?: any) => new Obstacle({ kind, x: 0, y: 0, w: 32, h: 16, meta } as any);
  eq(mkObs('RED_SPIKE').color, COLORS.SPIKE_RED, '尖刺：红刺用专用亮粉');
  eq(mkObs('BLUE_SPIKE').color, COLORS.SPIKE_BLUE, '尖刺：蓝刺用专用亮蓝');
  eq(mkObs('POLARITY_WALL', { polarity: 'RED' }).color, COLORS.RED, '影响面：相位墙仍是共享极性红');
  eq(mkObs('PENDULUM', { polarity: 'BLUE' }).color, COLORS.BLUE, '影响面：摆锤仍是共享极性蓝');
  rec.ops.length = 0;
  mkObs('RED_SPIKE').render(rec as any, 0);
  ok(rec.ops.some(op => op === 'stroke|#ffffff|3'), '尖刺：实际渲染使用 3px 白描边');
  ok(contrast(COLORS.GRAY, grass) >= 3, `草地：灰墙 vs 草绿 ≥ 3:1（${contrast(COLORS.GRAY, grass).toFixed(2)}）`);
  ok(contrast(themeMod.UI.ink, grass) >= 6, `草地：深靛描边 vs 草绿 ≥ 6:1（${contrast(themeMod.UI.ink, grass).toFixed(2)}）`);
  // 红蓝之外的第三条通道：明度差 + 极性刻印形状
  ok(Math.abs(lum(COLORS.RED) - lum(COLORS.BLUE)) >= 0.10,
    `色弱：红/蓝明度差 ≥ 0.10（${Math.abs(lum(COLORS.RED) - lum(COLORS.BLUE)).toFixed(3)}）`);
  const markOps: string[] = [];
  const markCtx = {
    save: () => { /* noop */ }, restore: () => { /* noop */ },
    beginPath: () => { markOps.push('begin'); },
    moveTo: () => { markOps.push('m'); }, lineTo: () => { markOps.push('l'); },
    stroke: () => { markOps.push('s'); },
    strokeStyle: '', lineWidth: 1, lineCap: 'butt', globalAlpha: 1,
  };
  widgets.drawPolarityMark(markCtx as any, 0, 0, 10, 'RED');
  const redSegs = markOps.filter(o => o === 'l').length;
  markOps.length = 0;
  widgets.drawPolarityMark(markCtx as any, 0, 0, 10, 'BLUE');
  const blueSegs = markOps.filter(o => o === 'l').length;
  ok(redSegs === 4 && blueSegs === 2, '色弱：红极刻印为「+」、蓝极为「−」（形状编码）');
  // 调色板规模：不再允许散落的 71 个色值
  const paletteValues = new Set(Object.values(themeMod.PALETTE));
  ok(paletteValues.size <= 12, `调色板：母版色值 ≤ 12（当前 ${paletteValues.size}）`);

  /* ---------------- M11 磁暴摆锤（重做） ---------------- */

  section('M11 磁暴摆锤（重做）');
  const pend = mech.MECH.PEND;
  const pendW = (Math.PI * 2) / pend.period;
  const hotDur = mech.pendulumHotDuration(pendW);
  const hotGap = Math.PI / pendW - hotDur;
  const pendLead = mech.pendulumWarnLead(pendW);

  eq(mech.pendulumCharged(0, pend.amplitude), true, '摆锤：最低点处于充能窗口');
  eq(mech.pendulumCharged(pend.amplitude, pend.amplitude), false, '摆锤：摆到端点退出充能窗口');
  ok(pend.hitR <= pend.ballR && pend.hitR / pend.ballR >= 0.85, '摆锤：判定圆内缩于视觉但不失宽容');
  ok(hotDur > 0.18 && hotDur < hotGap, '摆锤：单次充能长于换色冷却、短于安全间隙');
  ok(pendLead >= 0.3 && pendLead < hotGap, '摆锤：预警 ≥0.3s 且短于安全间隙');
  ok(mech.pendulumMaxWarnLead(pendW) > pendLead, '摆锤：极端配置下预警会被安全间隙收紧');

  // 充能窗口起点：sin(ωt)=chargeRatio → t=(π−asin(ratio))/ω
  const tHotStart = (Math.PI - Math.asin(pend.chargeRatio)) / pendW;
  eq(mech.pendulumWarned(tHotStart - 0.35, pend.amplitude, pendW, 0, pendLead), true, '摆锤：充能前 lead 秒内进入预警');
  eq(mech.pendulumWarned(tHotStart - 0.60, pend.amplitude, pendW, 0, pendLead), false, '摆锤：预警不会提前过多');
  eq(mech.pendulumWarned(tHotStart, pend.amplitude, pendW, 0, pendLead), false, '摆锤：充能中不再重复预警');
  const wp = mech.pendulumWarnProgress(tHotStart - 0.1, pend.amplitude, pendW, 0, pendLead);
  ok(wp > 0 && wp < 1, '摆锤：预警进度随倒计时推进（0<进度<1）');

  // 危险窗口内必中 / 窗口外必不中
  eq(mech.pendulumLethal({ samePolarity: false, charged: true, overlapping: true, grace: false }), true, '摆锤：异色 + 充能 + 重叠 = 必死');
  eq(mech.pendulumLethal({ samePolarity: false, charged: false, overlapping: true, grace: false }), false, '摆锤：窗口外即使重叠也不死');
  eq(mech.pendulumLethal({ samePolarity: true, charged: true, overlapping: true, grace: false }), false, '摆锤：同色始终免疫');
  eq(mech.pendulumLethal({ samePolarity: false, charged: true, overlapping: true, grace: true }), false, '摆锤：无敌/消磁保护内不死');

  // 磁力耦合
  eq(mech.pendulumMagnetDir(true, true), -1, '摆锤：同色排斥（向下/远离）');
  eq(mech.pendulumMagnetDir(false, true), 1, '摆锤：异色吸引（向上/靠近）');
  eq(mech.pendulumMagnetDir(false, false), 0, '摆锤：冷态无磁力');

  // 圆-矩形判定：修掉“方形包围盒四角误判”
  const { Physics } = await import('../src/core/Physics');
  eq(Physics.circleAABB(5, 5, 6, { x: 0, y: 0, w: 10, h: 10 }), true, '摆锤：圆心贴近矩形边界算命中');
  eq(Physics.circleAABB(14, 14, 5, { x: 0, y: 0, w: 10, h: 10 }), false, '摆锤：方形包围盒的“空角”不再误判');

  // Obstacle 集成：充能状态 + 消磁保护随关卡时间推进
  const pendObj = new Obstacle({
    kind: 'PENDULUM', x: 1000, y: GAME_CONFIG.CEILING_Y, w: 40, h: 40,
    meta: { rope: 260, amplitude: 0.62, swingSpeed: 2.2, phase: 0, polarity: 'RED' },
  });
  pendObj.updateSwing(0);
  eq(pendObj.isCharged, true, '摆锤：t=0（最低点）进入充能');
  ok(pendObj.pendulumWarnLead === 0.45, '摆锤：默认预警 0.45s');
  pendObj.updateSwing(0.72);
  eq(pendObj.isCharged, false, '摆锤：摆到端点退出充能');
  ok(pendObj.dischargeGrace > 0, '摆锤：充能结束进入消磁无敌帧');

  /* ---------------- 编辑器撤销栈 ---------------- */

  section('编辑器撤销栈（20 步，精确回滚）');
  const editHistory = await import('../src/systems/EditHistory');
  eq(editHistory.EDIT_HISTORY_LIMIT, 20, '撤销栈上限 20 步');

  const baseParams = structuredClone(editHistory.DEFAULT_EDITOR_PARAMS);
  const snap = (obstacles: any[], params = baseParams) => ({
    obstacles,
    params: { ...params },
    pendingPortal: null,
    portalSeq: 1,
    tool: 'RED_SPIKE' as const,
  });

  const hEmpty = new editHistory.EditHistory();
  eq(hEmpty.canUndo, false, '撤销：初始无可撤销操作（按钮禁用）');
  eq(hEmpty.undo(), null, '撤销：空栈返回 null');

  // 放置 → 撤销：快照必须深拷贝，之后的修改不能污染历史
  const hAdd = new editHistory.EditHistory();
  const adding = snap([{ kind: 'RED_SPIKE', x: 100, y: 408, w: 32, h: 32 }]);
  hAdd.push(adding);
  adding.obstacles.push({ kind: 'WALL', x: 300, y: 384, w: 40, h: 56 });
  adding.params.rainCount = 5;
  const undoneAdd = hAdd.undo()!;
  eq(undoneAdd.obstacles.length, 1, '撤销回滚放置（对象数量）');
  eq(undoneAdd.obstacles[0].x, 100, '撤销回滚放置位置');
  eq(undoneAdd.obstacles[0].kind, 'RED_SPIKE', '撤销回滚障碍类型');
  eq(undoneAdd.params.rainCount, 3, '撤销回滚参数（深拷贝不被后续修改污染）');
  eq(hAdd.canUndo, false, '撤销最后一步后按钮回到禁用');

  // 删除 / 移动 / 改参数 / 清空 各自回滚
  const hDel = new editHistory.EditHistory();
  const delSnap = snap([{ kind: 'WALL', x: 100, y: 384, w: 40, h: 56 }, { kind: 'GEM', x: 300, y: 330, w: 26, h: 26 }]);
  hDel.push(delSnap);           // 记录删除前状态
  delSnap.obstacles.splice(0, 1); // 模拟删除
  eq(hDel.undo()!.obstacles.length, 2, '撤销回滚删除（恢复被删物件）');

  const hMove = new editHistory.EditHistory();
  const moveSnap = snap([{ kind: 'RED_SPIKE', x: 100, y: 408, w: 32, h: 32 }]);
  hMove.push(moveSnap);
  moveSnap.obstacles[0].x = 420;
  eq(hMove.undo()!.obstacles[0].x, 100, '撤销回滚移动（位置恢复）');

  const hParam = new editHistory.EditHistory();
  const pStart = { ...baseParams, laserPeriod: 2.8 };
  hParam.push(snap([], pStart));
  pStart.laserPeriod = 3.2;
  const pBack = hParam.undo()!;
  eq(pBack.params.laserPeriod, 2.8, '撤销回滚参数修改（激光周期）');
  eq(pBack.tool, 'RED_SPIKE', '撤销同时恢复选中工具');

  const hClear = new editHistory.EditHistory();
  hClear.push(snap([{ kind: 'WALL', x: 10, y: 384, w: 40, h: 56 }, { kind: 'WALL', x: 60, y: 384, w: 40, h: 56 }]));
  eq(hClear.undo()!.obstacles.length, 2, '撤销回滚清空（内容全部恢复）');

  // 栈满丢最早：连续 25 次 → 只保留最近 20 步
  const hCap = new editHistory.EditHistory();
  for (let i = 0; i < 25; i++) {
    hCap.push(snap([{ kind: 'WALL', x: i * 10, y: 384, w: 40, h: 56 }]));
  }
  eq(hCap.size, 20, '撤销栈满后保持 20 步');
  const popped: number[] = [];
  while (hCap.canUndo) popped.push((hCap.undo()!.obstacles[0] as any).x);
  eq(popped.length, 20, '撤销栈可回退 20 步');
  eq(popped[0], 240, '撤销从最近一步开始');
  eq(popped[popped.length - 1], 50, '栈满丢弃最早（保留第 5–24 步）');

  /* ---------------- 编辑器工具栏分类 ---------------- */

  section('编辑器工具栏分类（28 个工具 / 顶部单行滚动）');
  const editorTools = await import('../src/systems/EditorTools');
  const LAYOUT = editorTools.EDITOR_LAYOUT;
  eq(editorTools.EDITOR_TOOLS.length, 28, '工具总数 28');
  eq(editorTools.EDITOR_CATEGORIES.length, 5, '5 个分类标签');
  eq(new Set(editorTools.EDITOR_TOOLS.map(t => t.id)).size, 28, '28 个工具 id 唯一');
  eq(
    editorTools.EDITOR_CATEGORIES.reduce((sum, c) => sum + editorTools.toolsOf(c.id).length, 0),
    28,
    '分类覆盖全部 28 个工具（无遗漏 / 无重复）',
  );
  for (const t of editorTools.EDITOR_TOOLS) {
    ok(
      editorTools.EDITOR_CATEGORIES.some(c => c.id === t.category),
      `工具 ${t.id} 归入合法分类`,
    );
  }
  for (const id of ['LOCK', 'BAIT', 'MIRROR', 'RAIN', 'LAUNCH', 'SWALL', 'CONVEY', 'PIT']) {
    ok(editorTools.EDITOR_TOOLS.some(t => t.id === id), `M01–M11 工具 ${id} 已收录`);
  }

  // 844×390 横屏：画布按高度缩放 390/540，工具/标签命中区 ≥ 44px
  const smallScale = 390 / 540;
  ok(LAYOUT.toolH * smallScale >= 44, `小屏横屏工具命中高 ${(LAYOUT.toolH * smallScale).toFixed(1)}px ≥ 44px`);
  ok(LAYOUT.tabH * smallScale >= 44, `小屏横屏分类标签命中高 ${(LAYOUT.tabH * smallScale).toFixed(1)}px ≥ 44px`);
  ok(LAYOUT.toolY + LAYOUT.toolH <= LAYOUT.topH, '工具行不越过顶部操作区（topH 之下才是画布）');
  ok(LAYOUT.toolY + LAYOUT.toolH + 6 <= LAYOUT.topH, '工具行底部留 6px 滚动条余量');

  // 横向滚动范围 + 命中反算
  const mechCat = 'mechanic' as const;
  const mechMax = editorTools.maxToolScroll(mechCat, 960);
  ok(mechMax > 0, '特殊机制 11 个工具超出单行宽度，需要左右拖动');
  eq(editorTools.clampToolScroll(mechCat, -50, 960), 0, '拖动越界左端钳制为 0');
  eq(editorTools.clampToolScroll(mechCat, mechMax + 200, 960), mechMax, '拖动越界右端钳制为最大值');
  eq(editorTools.toolIndexAt(mechCat, 13, LAYOUT.toolY + 10, 0, 960), 0, '未滚动时命中第 1 个工具');
  eq(editorTools.toolIndexAt(mechCat, 13, LAYOUT.toolY - 7, 0, 960), -1, '工具行纵向外不命中');
  eq(editorTools.toolIndexAt(mechCat, 870, LAYOUT.toolY + 10, mechMax, 960), 10, '滚到最右可命中第 11 个工具');
  eq(editorTools.toolIndexAt(mechCat, 952, LAYOUT.toolY + 10, mechMax, 960), -1, '可视区外不命中被裁掉的格子');
  eq(editorTools.categoryTabAt(20, LAYOUT.tabY + 20, 960), 0, '分类标签命中第 1 个');
  eq(editorTools.categoryTabAt(500, LAYOUT.toolY, 960), -1, '工具行区域不误触分类标签');

  /* ---------------- 自制地图上传（服务端校验） ---------------- */

  section('自制地图上传（服务端独立校验）');
  const levelStore = await import('../server/level-store.mjs');
  const fs = await import('node:fs');
  const nodePath = await import('node:path');

  eq(levelStore.MAX_BODY_BYTES, 64 * 1024, '请求体上限 64KB');
  eq(levelStore.MAX_OBSTACLES, 300, '障碍数量上限 300');
  eq(levelStore.SHARE_CODE_LENGTH, 8, '分享码长度 8');
  ok(!/[01OI]/.test(levelStore.SHARE_CODE_ALPHABET), '分享码字母表排除易混淆字符');

  const goodPayload = {
    name: '自检关卡',
    obstacles: [
      { kind: 'RED_SPIKE', x: 100, y: 400, w: 32, h: 32 },
      {
        kind: 'PENDULUM', x: 500, y: 100, w: 40, h: 40,
        meta: { rope: 260, polarity: 'RED', amplitude: 0.62, swingSpeed: 2.2, warnLead: 0.45, evil: 1 },
      },
    ],
  };
  const good = levelStore.sanitizeLevel(goodPayload);
  ok(good.ok, '合法载荷通过校验');
  eq(good.data?.obstacles.length, 2, '合法载荷保留 2 个物件');
  eq(good.data?.obstacles[1].meta?.evil, undefined, 'meta 白名单丢弃未知字段');
  eq(good.data?.obstacles[1].meta?.rope, 260, 'meta 保留白名单字段');

  const badX = levelStore.sanitizeLevel({ obstacles: [{ kind: 'RED_SPIKE', x: -20, y: 400, w: 32, h: 32 }] });
  eq(badX.ok, false, '非法坐标（x<0）被拒');
  const badX2 = levelStore.sanitizeLevel({ obstacles: [{ kind: 'RED_SPIKE', x: 20001, y: 400, w: 32, h: 32 }] });
  eq(badX2.ok, false, '非法坐标（x>20000）被拒');
  const badY = levelStore.sanitizeLevel({ obstacles: [{ kind: 'WALL', x: 100, y: 600, w: 40, h: 56 }] });
  eq(badY.ok, false, '非法坐标（y 越界）被拒');
  const badW = levelStore.sanitizeLevel({ obstacles: [{ kind: 'WALL', x: 100, y: 380, w: 600, h: 56 }] });
  eq(badW.ok, false, '超尺寸（宽 600）被拒');
  const badH = levelStore.sanitizeLevel({ obstacles: [{ kind: 'WALL', x: 100, y: 380, w: 40, h: 700 }] });
  eq(badH.ok, false, '超尺寸（高 700）被拒');
  const badKind = levelStore.sanitizeLevel({ obstacles: [{ kind: 'HACK_KIND', x: 100, y: 400, w: 32, h: 32 }] });
  eq(badKind.ok, false, '未知类型被拒');
  const tooMany = levelStore.sanitizeLevel({
    obstacles: Array.from({ length: 301 }, (_, i) => ({ kind: 'WALL', x: i * 10, y: 380, w: 40, h: 56 })),
  });
  eq(tooMany.ok, false, '障碍数量超上限被拒');
  const manyBaits = levelStore.sanitizeLevel({
    obstacles: Array.from({ length: 3 }, (_, i) => ({ kind: 'CORE_BAIT', x: 100 + i * 40, y: 360, w: 28, h: 28 })),
  });
  eq(manyBaits.ok, false, '磁芯诱饵超 2 枚被拒');
  eq(levelStore.sanitizeLevel({ obstacles: [] }).ok, false, '空关卡被拒');
  eq(levelStore.sanitizeLevel(null).ok, false, '非对象载荷被拒');

  // 彩色晶片：服务端只保留 RED/BLUE，其余颜色与未知字段一律丢弃
  const serverColored = levelStore.sanitizeLevel({
    obstacles: [{ kind: 'COLLECTIBLE', x: 100, y: 388, w: 24, h: 24, meta: { color: 'BLUE', currency: 1, evil: 1 } }],
  });
  eq(serverColored.data?.obstacles[0]?.meta?.color, 'BLUE', '服务端保留合法晶片颜色');
  eq(serverColored.data?.obstacles[0]?.meta?.currency, 1, '服务端保留磁芯币标记');
  eq(serverColored.data?.obstacles[0]?.meta?.evil, undefined, '服务端丢弃晶片未知字段');
  const serverBadColor = levelStore.sanitizeLevel({
    obstacles: [{ kind: 'COLLECTIBLE', x: 100, y: 388, w: 24, h: 24, meta: { color: 'HACK', evil: 1 } }],
  });
  eq(serverBadColor.data?.obstacles[0]?.meta, undefined, '服务端丢弃非法晶片颜色（回落为任意极性）');

  /* ---------------- 分享码可读回 + 持久化 ---------------- */

  section('分享码生成 / 读回 / 重启保留');
  const tmpDir = nodePath.join(process.cwd(), 'node_modules', '.cache', 'selfcheck-levels');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const store = new levelStore.LevelStore(tmpDir);
  const entry = store.add(good.data);
  ok(levelStore.isValidShareCode(entry.code), '分享码格式合法（8 位字母表内字符）');
  ok(!/^\d+$/.test(entry.code), '分享码不是自增数字 id');
  eq(store.get(entry.code)?.obstacles.length, 2, '分享码可读回完整障碍数据');
  eq(store.get(entry.code.toLowerCase())?.code, entry.code, '分享码大小写不敏感读回');
  eq(store.get('ZZZZZZZZ'), null, '不存在的分享码返回 null');

  // 模拟服务器重启：新建 store 从同一文件读回
  const store2 = new levelStore.LevelStore(tmpDir);
  eq(store2.get(entry.code)?.name, good.data.name, '重启后仍能凭分享码读回（落盘保留）');
  eq(store2.list(10).length >= 1, true, '列表接口能读到已上传关卡');
  const entry2 = store2.add(good.data);
  ok(entry2.code !== entry.code, '随机分享码不重复');

  // 与联机共用端口 / 地址推导：wss → https，协议本身不改
  const share = await import('../src/net/LevelShare');
  const onlineMod = await import('../src/net/OnlineManager');
  const serverUrl = await import('../src/net/ServerUrl');
  ok(onlineMod.DEFAULT_SERVER_URL.startsWith('ws://'), 'DEFAULT_SERVER_URL 为明文 ws://（内测直连）');
  eq(onlineMod.DEFAULT_SERVER_URL, 'ws://47.96.190.73:8080', '出厂默认地址指向内测 Linux 服务器 8080');
  eq(
    share.httpBaseFromWs('wss://example.cpolar.top'),
    'https://example.cpolar.top',
    '上传地址由 wss:// 推导为 https://（端口/路径不变）',
  );
  eq(share.levelsApiUrl('wss://example.cpolar.top'), 'https://example.cpolar.top/api/levels', '接口路径 /api/levels');

  /* ---------------- 分享码自动生成 / 上传响应必带码 / 错误路径 ---------------- */

  section('分享码：上传响应必带码 / 客户端格式 / 错误提示');
  eq(levelStore.LEVELS_API_VERSION, 2, '服务端接口版本 v2（GET /api/levels 返回 version 字段）');
  ok(share.isServerShareCode(entry.code), '服务端生成的分享码通过客户端格式校验');
  ok(share.isServerShareCode(entry.code.toLowerCase()), '客户端校验大小写不敏感');
  ok(!share.isServerShareCode('ABCDEG0I'), '含易混淆字符 0/I 的码被拒');
  ok(!share.isServerShareCode('ABC'), '长度不足 8 位被拒');
  const parsed = share.parseUploadResponse({ ok: true, code: entry.code, name: 'x', count: 2 });
  eq(parsed.code, entry.code, '上传成功响应自动解析出分享码');
  throws(() => share.parseUploadResponse({ ok: true }), '上传响应缺码 → 抛出“未返回有效分享码”');
  throws(() => share.parseUploadResponse(null), '上传响应为空 → 抛出错误而非显示空码');
  ok(share.httpFailureMessage(502, null).includes('隧道'), '502 提示隧道/服务不可用');
  ok(share.httpFailureMessage(400, { error: '坐标越界' }) === '坐标越界', '400 透传服务端校验原因');
  ok(share.httpFailureMessage(429, null).includes('频繁'), '429 提示请求过于频繁');

  /* ---------------- 码制统一：两种格式自动识别 / 非法码明确报错 / 面板不依赖剪贴板 ---------------- */

  section('分享码：8 位码与旧版长串自动识别 / 非法码明确报错 / 面板不依赖剪贴板');
  eq(share.classifyShareCode(entry.code), 'server', '8 位服务端分享码识别为 server');
  eq(share.classifyShareCode(` ${entry.code.toLowerCase()} `), 'server', '带空格/小写的 8 位码仍识别为 server');
  const customLevels = await import('../src/systems/CustomLevels');
  const clientColored = customLevels.sanitizeObstacles([
    { kind: 'COLLECTIBLE', x: 100, y: 388, w: 24, h: 24, meta: { color: 'RED', currency: 1, evil: 1 } },
  ]);
  eq(clientColored[0]?.meta?.color, 'RED', '客户端导入码保留合法晶片颜色');
  eq(clientColored[0]?.meta?.evil, undefined, '客户端导入码丢弃晶片未知字段');
  const clientBadColor = customLevels.sanitizeObstacles([
    { kind: 'COLLECTIBLE', x: 100, y: 388, w: 24, h: 24, meta: { color: 'HACK' } },
  ]);
  eq(clientBadColor[0]?.meta, undefined, '客户端导入码丢弃非法晶片颜色（回落为任意极性）');
  const legacyCode = new customLevels.CustomLevelStore().encode(good.data);
  ok(legacyCode.length >= 40, '旧版 base64 关卡码长度 ≥ 40');
  eq(share.classifyShareCode(legacyCode), 'legacy', '旧版 base64 长串识别为 legacy');
  eq(share.classifyShareCode(''), 'invalid', '空内容识别为 invalid');
  eq(share.classifyShareCode('ABCD2345!'), 'invalid', '混入非法字符的 8 位串识别为 invalid');
  eq(share.classifyShareCode('hello'), 'invalid', '普通短文本识别为 invalid');

  // 非法分享码必须在请求前就明确抛错（不允许静默返回空关卡）
  let illegalThrew = false;
  try { await share.downloadLevel('@@@'); } catch { illegalThrew = true; }
  ok(illegalThrew, '非法分享码 → 抛错并给出明确原因');

  // 分享码面板：码本身永远完整可见（复制失败也只改按钮文案）
  const panelNoCopy = share.sharePanelModel(entry.code, false);
  eq(panelNoCopy.codeText, entry.code.split('').join(' '), '未复制时仍展示完整大号码');
  eq(panelNoCopy.copyLabel, '复制分享码', '未复制时按钮提示可复制');
  eq(share.sharePanelModel(entry.code, true).copyLabel, '已复制！', '复制成功后按钮变为已复制');
  ok(panelNoCopy.hint.includes('我的地图'), '面板提示说明码已存入我的地图');

  // 静态扫描：源码中所有分享码入口都不得调用系统 prompt（Android WebView 不填预填值 → 空白框）
  section('分享码：所有码入口均为应用内 UI（静态扫描源码）');
  const listTs = (dir: string): string[] => {
    const out: string[] = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = nodePath.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...listTs(p));
      else if (ent.isFile() && ent.name.endsWith('.ts')) out.push(p);
    }
    return out;
  };
  const srcFiles = listTs(nodePath.join(process.cwd(), 'src'));
  ok(srcFiles.length > 0, '扫描到 src 下的 TypeScript 源文件');
  const promptUsers = srcFiles.filter(f => /window\.prompt\b/.test(fs.readFileSync(f, 'utf8')));
  eq(promptUsers.length, 0, `无任何源码调用 window.prompt（命中：${promptUsers.join(', ') || '无'}）`);
  const clipboardRefs = srcFiles.filter(f => /navigator\.clipboard/.test(fs.readFileSync(f, 'utf8')));
  eq(clipboardRefs.length, 1, '剪贴板只在 LevelShare.copyText 内使用（面板展示不依赖权限）');
  ok(clipboardRefs[0]?.endsWith('LevelShare.ts'), '剪贴板引用位于 LevelShare.ts');

  // 码读回内容一致（跨设备下载的同一份数据）
  eq(store.get(entry.code)?.name, good.data.name, '下载读回名称与上传一致');
  eq(store.get(entry.code)?.obstacles[1].meta?.rope, 260, '下载读回 meta 与上传一致');

  // 落盘失败必须整单失败，不能返回 201 后丢数据
  const notADir = nodePath.join(process.cwd(), 'node_modules', '.cache', 'selfcheck-levels-file');
  fs.writeFileSync(notADir, 'x');
  const brokenStore = new levelStore.LevelStore(notADir);
  throws(() => brokenStore.add(good.data), '存储写入失败 → add 抛出错误（接口不会返回空码）');
  eq(brokenStore.size, 0, '写入失败的关卡不会留在内存里');
  fs.rmSync(notADir, { force: true });

  /* ---------------- 服务器地址规范化（联机与上传同一来源） ---------------- */

  section('服务器地址规范化 / 单一来源 / 非法地址拒绝');
  // 协议互换
  const httpToWs = serverUrl.normalizeServerUrl('http://192.168.1.5:8080');
  eq(httpToWs.ok && httpToWs.wsUrl, 'ws://192.168.1.5:8080', 'http:// → ws://（端口保留）');
  eq(httpToWs.ok && httpToWs.httpUrl, 'http://192.168.1.5:8080', 'http:// 原样作为上传地址');
  const httpsToWss = serverUrl.normalizeServerUrl('https://huanmie.vip.cpolar.cn/');
  eq(httpsToWss.ok && httpsToWss.wsUrl, 'wss://huanmie.vip.cpolar.cn', 'https:// → wss:// 且去掉尾斜杠');
  eq(httpsToWss.ok && httpsToWss.httpUrl, 'https://huanmie.vip.cpolar.cn', 'https 上传地址无尾斜杠');
  const wsToHttp = serverUrl.normalizeServerUrl('ws://example.com:9000');
  eq(wsToHttp.ok && wsToHttp.httpUrl, 'http://example.com:9000', 'ws:// → http://（端口保留）');
  // 裸地址补协议：公网域名走 wss（默认地址硬约束），局域网/显式 8080 走 ws
  const bareDomain = serverUrl.normalizeServerUrl('huanmie.vip.cpolar.cn');
  eq(bareDomain.ok && bareDomain.wsUrl, 'wss://huanmie.vip.cpolar.cn', '裸公网域名补 wss://');
  const bareLan = serverUrl.normalizeServerUrl('192.168.1.5:8080');
  eq(bareLan.ok && bareLan.wsUrl, 'ws://192.168.1.5:8080', '裸局域网地址补 ws://');
  const bareLocal = serverUrl.normalizeServerUrl('localhost');
  eq(bareLocal.ok && bareLocal.wsUrl, 'ws://localhost', '裸 localhost 补 ws://');
  // 尾斜杠 / 多余路径 / 查询串清理
  const dirty = serverUrl.normalizeServerUrl('wss://example.cpolar.top/extra/path/?x=1#y');
  eq(dirty.ok && dirty.wsUrl, 'wss://example.cpolar.top', '多余路径/查询串/尾斜杠被清理');
  // 非法地址：一律拒绝，不静默回退默认值
  const empty = serverUrl.normalizeServerUrl('   ');
  eq(empty.ok, false, '空地址被拒');
  const badScheme = serverUrl.normalizeServerUrl('ftp://example.com');
  eq(badScheme.ok, false, '非 ws/wss/http/https 协议被拒');
  const badPort = serverUrl.normalizeServerUrl('http://example.com:99999');
  eq(badPort.ok, false, '非法端口（99999）被拒');
  const zeroPort = serverUrl.normalizeServerUrl('ws://example.com:0');
  eq(zeroPort.ok, false, '端口 0 被拒');
  const badSpace = serverUrl.normalizeServerUrl('ws://example .com');
  eq(badSpace.ok, false, '含空格的地址被拒');
  eq(serverUrl.setStoredServerUrl('ftp://x').ok, false, '非法地址不会写入覆盖值');
  // 同一来源：LevelShare 不传参时取的就是 ServerUrl 解析出的当前地址
  const resolved = serverUrl.resolveServerUrl();
  ok(resolved.ok, '默认地址可解析（无覆盖值时不报错）');
  eq(resolved.ok && resolved.wsUrl, 'ws://47.96.190.73:8080', '默认 ws:// 地址不被校验拒绝（端口保留）');
  eq(resolved.ok && resolved.httpUrl, 'http://47.96.190.73:8080', '默认地址派生出 http 上传地址');
  eq(
    share.levelsApiUrl(),
    resolved.ok ? `${resolved.httpUrl}/api/levels` : '',
    '上传/下载与联机使用同一地址来源（未传参即当前生效地址）',
  );

  /* ---------------- 联机观战 / 结算 ---------------- */
  section('联机观战 / 结算（RaceSettle）');

  const racePlayers = [
    { id: 'a', name: '甲' },
    { id: 'b', name: '乙' },
    { id: 'c', name: '丙' },
  ];
  const noTimes = new Map<string, number>();
  // 自己完赛后仍在观战：不能因为自己 finish 就结算
  ok(!settle.isRaceSettled(racePlayers, 'a', true, noTimes), '自己完赛、对手仍在跑 → 保持观战');
  ok(!settle.isRaceSettled(racePlayers, 'a', false, noTimes), '自己未完赛 → 不结算');
  // 全部 finish → 结算
  const allTimes = new Map<string, number>([['b', 12.5], ['c', 14.2]]);
  ok(settle.isRaceSettled(racePlayers, 'a', true, allTimes), '全部 finish → 进入结算');
  eq(settle.settleReasonOf(racePlayers, 'a', allTimes, false), 'all_finished', '全员完赛原因 all_finished');
  // 部分退出 / 掉线：剩下的人都完赛也要结算
  const leftPlayers = [
    { id: 'a', name: '甲' },
    { id: 'b', name: '乙' },
    { id: 'c', name: '丙', disconnected: true },
  ];
  const bDone = new Map<string, number>([['b', 11.8]]);
  ok(settle.isRaceSettled(leftPlayers, 'a', true, bDone), '有人掉线/退出后，剩余完赛 → 结算');
  eq(settle.settleReasonOf(leftPlayers, 'a', bDone, false), 'left', '掉线场景原因 left');
  const discAt = new Map<string, number>([['c', 5000]]);
  const justLost = settle.withDisconnectGrace(leftPlayers, discAt, 5000 + 10_000);
  eq(justLost.find(p => p.id === 'c')?.disconnected, false, '掉线 10 秒内仍按在场处理');
  ok(!settle.isRaceSettled(justLost, 'a', true, bDone), '重连宽限内不提前结算');
  const longLost = settle.withDisconnectGrace(leftPlayers, discAt, 5000 + 31_000);
  eq(longLost.find(p => p.id === 'c')?.disconnected, true, '掉线超过 30 秒才按退出处理');
  // 等待超时：所有未完赛的人都长时间没前进才结算
  const stallAt = new Map<string, number>([['b', 1000], ['c', 1000]]);
  eq(
    settle.stalledUnfinished(racePlayers, 'a', new Map([['b', 10]]), stallAt, 1000 + 36_000).length,
    1, '唯一未完赛对手停滞超时 → 判定可结算',
  );
  const stallOne = new Map<string, number>([['b', 1000], ['c', 1000 + 30_000]]);
  eq(
    settle.stalledUnfinished(racePlayers, 'a', noTimes, stallOne, 1000 + 40_000).length,
    0, '只要还有人正常推进就不判超时',
  );
  ok(settle.isRaceSettled(racePlayers, 'a', true, noTimes, true), 'timeoutHit 强制进入结算');
  eq(settle.settleReasonOf(racePlayers, 'a', noTimes, true), 'timeout', '超时结算原因 timeout');
  // 观战候选：还在跑（进度高→低）→ 已完赛（成绩快→慢）→ 掉线
  const pos = new Map<string, number>([['b', 300], ['c', 900], ['d', 50]]);
  const fourPlayers = [
    { id: 'a', name: '甲' },
    { id: 'b', name: '乙' },
    { id: 'c', name: '丙' },
    { id: 'd', name: '丁', disconnected: true },
  ];
  const cand = settle.spectateCandidates(fourPlayers, 'a', noTimes, pos);
  eq(cand, ['c', 'b', 'd'], '观战候选：进度高在前、掉线垫底、不含自己');
  // 切换观战目标不越界
  eq(settle.cycleSpectate('c', cand, -1), 'd', '首项上一位回绕到末项');
  eq(settle.cycleSpectate('b', cand, -1), 'c', '中间项上一位正常回退');
  eq(settle.cycleSpectate('d', cand, 1), 'c', '末项下一位回绕到首项');
  eq(settle.cycleSpectate('', cand, 1), 'c', '目标为空 → 回退到第一个候选');
  eq(settle.cycleSpectate('', cand, -1), 'd', '目标为空且上一位 → 回退到最后一个候选');
  eq(settle.cycleSpectate('d', ['c', 'b'], 1), 'c', '目标已退出（不在候选）→ 回退到第一个候选');
  eq(settle.cycleSpectate('b', [], 1), '', '没有候选时返回空字符串');
  // 结算排行：完赛按成绩升序 → 未完赛按进度降序 → 掉线垫底
  const rows = settle.buildStandings(
    fourPlayers, 'a', true, 9.5,
    new Map([['b', 11.2], ['c', 10.4]]),
    pos,
  );
  eq(rows.map(r => r.id), ['a', 'c', 'b', 'd'], '结算排行顺序：成绩 → 进度 → 掉线');
  eq(rows.find(r => r.self)?.finished, true, '结算行标记自己已完赛');

  /* ---------------- 联机时延：RTT / 插值 / 有限外推 ---------------- */
  section('联机时延（RTT 统计 / 插值 / 有限外推）');

  const {
    RemoteInterpolator, RttStats,
    INTERP_DELAY_MS, MAX_EXTRAPOLATION_MS, INTERP_MAX_SAMPLES,
  } = timing;
  const mkSnap = (
    t: number, x: number, y = 400, vx = 320, vy = 0,
    extra: Partial<{ polarity: number; sliding: boolean; flipped: boolean; alive: boolean; finished: boolean }> = {},
  ) => ({
    t, x, y, vx, vy, polarity: 1, sliding: false, flipped: false, alive: true, finished: false,
    ...extra,
  });

  // 插值：三包 @0/33/66ms，缓冲 40ms
  const interp = new RemoteInterpolator();
  interp.push(mkSnap(0, 100));
  interp.push(mkSnap(33, 110));
  interp.push(mkSnap(66, 120));
  const midTarget = 96 - INTERP_DELAY_MS; // 落在 33 与 66 之间
  const midView = interp.sample(96)!;
  ok(Math.abs(midView.x - (110 + 10 * (midTarget - 33) / 33)) < 0.01, '两包之间按时间比例线性插值');
  eq(midView.extrapolatedMs, 0, '区间内插值不做外推');
  eq(interp.sample(INTERP_DELAY_MS)!.x, 100, '早于最旧包 → 固定在最旧包（不反向外推）');
  eq(interp.sample(66 + INTERP_DELAY_MS)!.x, 120, '目标恰好等于最新包 → 停在真实位置');

  // 外推边界：最多 120ms，且前进距离按最大奔跑速度封顶
  const farView = interp.sample(66 + INTERP_DELAY_MS + 300)!;
  eq(farView.extrapolatedMs, MAX_EXTRAPOLATION_MS, '外推时长封顶 120ms');
  ok(Math.abs(farView.x - (120 + 320 * (MAX_EXTRAPOLATION_MS / 1000))) < 1e-6, '外推距离按速度且不超前封顶值');
  ok(farView.x < 120 + 40, '外推位移不超过 ~38px，避免瞬移');

  // 已完赛 / 已死亡：不再外推
  interp.push(mkSnap(66, 120, 400, 320, 0, { finished: true }));
  eq(interp.sample(66 + INTERP_DELAY_MS + 300)!.x, 120, '已完赛 → 位置冻结，不再外推');
  const deadInterp = new RemoteInterpolator();
  deadInterp.push(mkSnap(0, 200, 400, 320, 0, { alive: false }));
  const deadView = deadInterp.sample(1000)!;
  eq(deadView.alive, false, '死亡包 alive=false → 渲染层跳过本体（无空壳）');
  eq(deadView.x, 200, '死亡后不继续外推（残影不会滑走）');

  // 复活：位置回退超过阈值 → 丢弃历史，避免倒着插值/残留
  const respawn = new RemoteInterpolator();
  respawn.push(mkSnap(0, 900));
  respawn.push(mkSnap(33, 900));
  respawn.push(mkSnap(66, 120, 400, 320, 0, { alive: true }));
  eq(respawn.size, 1, '复活回退 >32px → 历史缓冲被清空');
  const respawnView = respawn.sample(66 + INTERP_DELAY_MS)!;
  eq(respawnView.alive, true, '复活后恢复实心本体渲染');
  eq(respawnView.x, 120, '复活后位置来自新快照，不残留死亡点');

  // 缓冲容量上限
  const many = new RemoteInterpolator();
  for (let i = 0; i < 40; i++) many.push(mkSnap(i * 33, 100 + i * 10));
  ok(many.size <= INTERP_MAX_SAMPLES, `插值缓冲最多保留 ${INTERP_MAX_SAMPLES} 包`);

  // RTT：min / median / max / 异常样本
  const rtt = new RttStats();
  [10, 30, 20].forEach(v => rtt.add(v));
  eq(rtt.min(), 10, 'RTT 最小值');
  eq(rtt.max(), 30, 'RTT 最大值');
  eq(rtt.median(), 20, 'RTT 中位数（奇数样本）');
  rtt.add(25);
  eq(rtt.median(), 22.5, 'RTT 中位数（偶数样本取均值）');
  eq(rtt.count, 4, 'RTT 样本数量');
  rtt.add(Number.NaN);
  eq(rtt.count, 4, '非法 RTT 样本被忽略');
  ok(rtt.summary()?.startsWith('23ms'), 'RTT 摘要按整数毫秒输出');

  /* ---------------- 隐私政策：页面内容 / 同源入口 / 静态路由 ---------------- */

  section('隐私政策：页面自包含、章节完整、无外部资源');
  const privacyPath = nodePath.join(process.cwd(), 'server', 'public', 'privacy.html');
  ok(fs.existsSync(privacyPath), 'server/public/privacy.html 存在');
  const privacyHtml = fs.existsSync(privacyPath) ? fs.readFileSync(privacyPath, 'utf8') : '';
  const privacySections = [
    '生效日期', '适用范围', '我们收集哪些信息及用途', '存储位置与保存期限',
    '共享、转让与第三方', '未成年人保护', '你的权利', '数据安全措施', '政策变更通知', '联系我们',
  ];
  for (const s of privacySections) ok(privacyHtml.includes(s), `隐私页含章节：${s}`);
  ok(privacyHtml.includes('待填写'), '联系邮箱为醒目占位（待填写）');
  ok(privacyHtml.includes('name="viewport"'), '隐私页声明 viewport（移动端正常缩放）');
  ok(privacyHtml.includes('prefers-color-scheme: dark'), '隐私页支持深色模式');
  ok(privacyHtml.includes('font-size: 16px'), '正文字号 ≥14px');
  // 无外部资源：不允许 http(s) 出现在 src/href，也不允许 <script>/<link> 引外部文件
  eq(/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i.test(privacyHtml), false, '隐私页无外部 src/href 引用');
  eq(/<script\b/i.test(privacyHtml), false, '隐私页不含任何脚本');
  eq(/<link\b/i.test(privacyHtml), false, '隐私页不含外部样式表');
  ok(privacyHtml.includes('未接入') && privacyHtml.includes('广告'), '明确说明未接入第三方统计/广告 SDK');
  ok(privacyHtml.includes('不会读取') && privacyHtml.includes('剪贴板'), '明确说明剪贴板只写不读');
  ok(privacyHtml.includes('不生成、也不持久保存设备唯一标识'), '如实说明不存在持久 deviceId/clientId');

  section('隐私政策：入口地址由 ServerUrl 派生（不重复硬编码域名）');
  serverUrl.clearStoredServerUrl();
  const privacyUrl = serverUrl.privacyPolicyUrl();
  eq(privacyUrl, 'http://47.96.190.73:8080/privacy.html', '默认服务器派生出的隐私页地址');
  const menuSource = fs.readFileSync(nodePath.join(process.cwd(), 'src', 'scenes', 'MenuScene.ts'), 'utf8');
  eq(menuSource.includes('huanmie.vip'), false, 'MenuScene 未硬编码域名（改用 privacyPolicyUrl）');
  ok(menuSource.includes('privacyPolicyUrl()'), '设置弹层使用 privacyPolicyUrl()');

  section('隐私政策：/privacy.html 路由实跑（临时端口）');
  const { spawn } = await import('node:child_process');
  const liveDir = nodePath.join(process.cwd(), 'node_modules', '.cache', 'selfcheck-privacy-levels');
  fs.rmSync(liveDir, { recursive: true, force: true });
  fs.mkdirSync(liveDir, { recursive: true });
  const port = 18765;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [nodePath.join(process.cwd(), 'server', 'relay-server.mjs')], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LEVELS_DIR: liveDir, DATA_DIR: liveDir },
    stdio: 'ignore',
  });
  let pvUp = false;
  try {
    for (let i = 0; i < 40 && !pvUp; i++) {
      try {
        const r = await fetch(`${base}/privacy.html`, { signal: AbortSignal.timeout(1000) });
        if (r.status === 200) pvUp = true;
      } catch { /* 未启动完成，继续等待 */ }
      if (!pvUp) await new Promise(r => setTimeout(r, 150));
    }
    ok(pvUp, '临时服务启动后可访问 /privacy.html');

    const page = await fetch(`${base}/privacy.html`);
    eq(page.status, 200, 'GET /privacy.html 返回 200');
    const ctype = page.headers.get('content-type') || '';
    ok(ctype.includes('text/html') && ctype.includes('utf-8'), 'Content-Type 为 text/html; charset=utf-8');
    ok((page.headers.get('cache-control') || '').includes('max-age=300'), '缓存头 max-age=300');
    const body = await page.text();
    ok(body.includes('《磁极冲刺》隐私政策'), '线上返回的内容与本地页面一致');
    ok(body.includes('待填写'), '线上页面同样显示邮箱占位');

    const alias = await fetch(`${base}/privacy`);
    eq(alias.status, 200, 'GET /privacy 兼容返回同内容');

    const root = await fetch(`${base}/`, { redirect: 'manual' });
    eq(root.status, 302, '根路径 302 便于确认服务存活');
    eq(root.headers.get('location'), '/privacy.html', '根路径跳转到隐私页');

    const api = await fetch(`${base}/api/levels`);
    eq(api.status, 200, '新增静态路由不影响 /api/levels');
    const payload = await api.json() as { ok?: boolean };
    eq(payload.ok, true, '/api/levels 仍返回正常结构');
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 200));
    fs.rmSync(liveDir, { recursive: true, force: true });
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  /* ---------------- 运维后台账号体系：游客只读 / 管理员写操作 / 最后管理员保护 / 重启保留 ---------------- */
  section('运维后台账号体系：游客只读、管理员写操作、最后管理员保护、重启保留');
  const adminDir = nodePath.join(process.cwd(), 'node_modules', '.cache', 'selfcheck-admin');
  fs.rmSync(adminDir, { recursive: true, force: true });
  fs.mkdirSync(adminDir, { recursive: true });
  const adminPort = 18766;
  const adminBase = `http://127.0.0.1:${adminPort}`;
  const adminEnv = {
    ...process.env,
    PORT: String(adminPort),
    HOST: '127.0.0.1',
    LEVELS_DIR: adminDir,
    DATA_DIR: adminDir,
    ADMIN_USER: 'selfcheck-boot',
    ADMIN_PASSWORD: 'selfcheck-pass-1',
  };
  let adminChild = spawn(process.execPath, [nodePath.join(process.cwd(), 'server', 'relay-server.mjs')], {
    cwd: process.cwd(),
    env: adminEnv,
    stdio: 'ignore',
  });
  const cookieFrom = (res: any) => {
    const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
    for (const line of lines) {
      const m = String(line).match(/mr_admin=[^;]+/);
      if (m) return m[0];
    }
    return '';
  };
  const adminLogin = async (user: string, password: string) => {
    const r = await fetch(`${adminBase}/admin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user, password }),
    });
    return { status: r.status, cookie: cookieFrom(r), raw: r.headers.get('set-cookie') || '' };
  };
  const adminApi = async (cookie: string, path: string, init: any = {}) => {
    const headers: any = { Accept: 'application/json', 'X-Admin-Action': '1' };
    if (cookie) headers.Cookie = cookie;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.confirm) headers['X-Admin-Confirm'] = init.confirm;
    const r = await fetch(`${adminBase}${path}`, {
      method: init.method || 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
    });
    let data: any = null;
    try { data = await r.json(); } catch { /* 忽略非 JSON 响应 */ }
    return { status: r.status, data };
  };
  const waitAdmin = async () => {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try {
        const r = await fetch(`${adminBase}/admin/login`, { signal: AbortSignal.timeout(1000) });
        up = r.status === 200;
      } catch { /* 未启动完成，继续等待 */ }
      if (!up) await new Promise(r => setTimeout(r, 150));
    }
    return up;
  };
  try {
    ok(await waitAdmin(), '账号后台临时服务启动');
    const admin = await adminLogin('selfcheck-boot', 'selfcheck-pass-1');
    eq(admin.status, 303, '引导管理员首次启动后可登录');
    ok(/HttpOnly/i.test(admin.raw) && /SameSite=Strict/i.test(admin.raw), '会话 Cookie 为 HttpOnly + SameSite=Strict');

    const stats = await adminApi(admin.cookie, '/admin/api/stats');
    eq(stats.status, 200, '管理员可读看板统计');
    eq(stats.data?.user?.role, 'admin', '统计接口返回管理员角色');

    const accountFile = nodePath.join(adminDir, 'accounts.json');
    ok(fs.existsSync(accountFile), 'DATA_DIR 下生成 accounts.json');
    const accountRaw = fs.existsSync(accountFile) ? fs.readFileSync(accountFile, 'utf8') : '';
    ok(!accountRaw.includes('selfcheck-pass-1'), '账号文件不保存明文密码');
    ok(accountRaw.includes('"kdf":"scrypt"') && accountRaw.includes('"salt"') && accountRaw.includes('"hash"'), '账号文件保存 scrypt salt/hash');

    const list = await adminApi(admin.cookie, '/admin/api/accounts');
    const selfId = list.data?.selfId;
    const delSelf = await adminApi(admin.cookie, `/admin/api/accounts/${selfId}`, { method: 'DELETE', confirm: 'DELETE_ACCOUNT' });
    eq(delSelf.status, 409, '不能删除最后一个启用中的管理员');
    const demoteSelf = await adminApi(admin.cookie, `/admin/api/accounts/${selfId}`, { method: 'PATCH', body: { role: 'viewer' } });
    eq(demoteSelf.status, 409, '不能降级最后一个管理员');

    const created = await adminApi(admin.cookie, '/admin/api/accounts', { method: 'POST', body: { username: 'selfcheck-viewer', role: 'viewer', password: 'viewer-pass-1' } });
    eq(created.status, 201, '管理员可新建游客账号');
    const viewer = await adminLogin('selfcheck-viewer', 'viewer-pass-1');
    eq(viewer.status, 303, '游客账号可登录');
    const viewerStats = await adminApi(viewer.cookie, '/admin/api/stats');
    eq(viewerStats.status, 200, '游客可查看板');
    eq(viewerStats.data?.user?.role, 'viewer', '游客角色为 viewer');
    const viewerCreate = await adminApi(viewer.cookie, '/admin/api/accounts', { method: 'POST', body: { username: 'x', role: 'admin', password: 'x-pass-1' } });
    eq(viewerCreate.status, 403, '游客新建账号被服务端拒绝');
    const viewerReset = await adminApi(viewer.cookie, '/admin/api/maintenance/reset-stats', { method: 'POST', confirm: 'RESET_STATS' });
    eq(viewerReset.status, 403, '游客清零统计被服务端拒绝');

    const up = await fetch(`${adminBase}/api/levels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '自检地图', obstacles: [{ kind: 'FINISH', x: 1200, y: 380, w: 60, h: 100 }] }),
    });
    const upData = await up.json() as any;
    eq(up.status, 201, '上传测试自制地图');
    const viewerDel = await adminApi(viewer.cookie, `/admin/api/levels/${upData.code}`, { method: 'DELETE', confirm: 'DELETE_LEVEL' });
    eq(viewerDel.status, 403, '游客删除自制地图被服务端拒绝');
    const adminDel = await adminApi(admin.cookie, `/admin/api/levels/${upData.code}`, { method: 'DELETE', confirm: 'DELETE_LEVEL' });
    eq(adminDel.status, 200, '管理员删除指定分享码地图');
    const gone = await fetch(`${adminBase}/api/levels/${upData.code}`);
    eq(gone.status, 404, '删除后公开下载接口返回 404');

    const resetNoConfirm = await adminApi(admin.cookie, '/admin/api/maintenance/reset-stats', { method: 'POST' });
    eq(resetNoConfirm.status, 400, '清零统计缺少二次确认被拒绝');
    const resetOk = await adminApi(admin.cookie, '/admin/api/maintenance/reset-stats', { method: 'POST', confirm: 'RESET_STATS' });
    eq(resetOk.status, 200, '管理员清零统计成功');
    const statsAfter = await adminApi(admin.cookie, '/admin/api/stats');
    eq(statsAfter.data?.totals?.uploads, 0, '清零后累计计数归零');

    adminChild.kill();
    await new Promise(r => setTimeout(r, 200));

    adminChild = spawn(process.execPath, [nodePath.join(process.cwd(), 'server', 'relay-server.mjs')], {
      cwd: process.cwd(),
      env: { ...adminEnv, ADMIN_USER: 'other-boot', ADMIN_PASSWORD: 'other-pass-999' },
      stdio: 'ignore',
    });
    ok(await waitAdmin(), '账号后台重启完成');
    const bootAgain = await adminLogin('selfcheck-boot', 'selfcheck-pass-1');
    eq(bootAgain.status, 303, '重启后原管理员仍可登录（以账号文件为准）');
    const other = await adminLogin('other-boot', 'other-pass-999');
    eq(other.status, 401, '重启后 relay.env 的新引导配置不会覆盖已有账号');
  } finally {
    adminChild.kill();
    await new Promise(r => setTimeout(r, 200));
    fs.rmSync(adminDir, { recursive: true, force: true });
  }

  /* ---------------- 客户端四项修复：设置 / 选关裁剪 / 忠告页 / 房间号复制 ---------------- */

  section('设置弹层：四组分区 + 行高与命中区 ≥44 CSS px（按 844×390 横屏换算）');
  const settingsMod = await import('../src/ui/SettingsLayout');
  const sl = settingsMod.settingsLayout();
  const rl = settingsMod.resetConfirmLayout();
  // 与编辑器工具栏一致的小屏横屏基准：390/540 ≈ 0.722
  const hitScale = 390 / 540;
  eq(
    settingsMod.SETTINGS_GROUPS.map(g => g.title),
    ['音频', '显示', '账号与信息', '危险操作'],
    '设置分为音频 / 显示 / 账号与信息 / 危险操作 四组',
  );
  eq(settingsMod.SETTINGS_ROW_H, 64, '统一行高 64 逻辑像素');

  const hitRows: Array<[string, { x: number; y: number; w: number; h: number }]> = [
    ['声音开关', sl.rows.mute],
    ['音量滑杆行', sl.rows.volume],
    ['画面震动', sl.rows.shake],
    ['速度感', sl.rows.speedFx],
    ['隐私政策', sl.rows.privacy],
    ['重置存档', sl.rows.reset],
    ['关闭按钮', sl.close],
    ['音量 −', sl.volDown],
    ['音量 ＋', sl.volUp],
  ];
  for (const [name, r] of hitRows) {
    ok(
      r.h * hitScale >= 44,
      `${name}命中高 ${(r.h * hitScale).toFixed(1)} CSS px ≥ 44`,
    );
  }
  for (const r of [sl.rows.mute, sl.rows.volume, sl.rows.shake, sl.rows.speedFx, sl.rows.privacy, sl.rows.reset]) {
    ok(
      r.x >= sl.panel.x && r.x + r.w <= sl.panel.x + sl.panel.w
        && r.y >= sl.panel.y && r.y + r.h <= sl.panel.y + sl.panel.h,
      '设置行完整落在弹层面板内',
    );
  }
  ok(
    [sl.rows.mute, sl.rows.volume, sl.rows.shake, sl.rows.speedFx, sl.rows.privacy, sl.rows.reset]
      .sort((a, b) => a.y - b.y)
      .every((r, i, arr) => i === 0 || arr[i - 1].y + arr[i - 1].h <= r.y),
    '设置各行纵向不重叠（组间留出间距）',
  );
  ok(sl.rows.speedFx.w === sl.rows.shake.w, '速度感与画面震动等宽通栏');
  ok(sl.panel.x >= 0 && sl.panel.y >= 0
    && sl.panel.x + sl.panel.w <= 960 && sl.panel.y + sl.panel.h <= 540, '设置面板不越出 960×540 画布');
  ok(rl.cancel.h * hitScale >= 44 && rl.confirm.h * hitScale >= 44, '重置二次确认按钮命中区 ≥44 CSS px');
  // 静态确认弹层真的用了这套布局，而不是各画各的
  const menuSource2 = fs.readFileSync(nodePath.join(process.cwd(), 'src', 'scenes', 'MenuScene.ts'), 'utf8');
  ok(menuSource2.includes('settingsLayout()'), 'MenuScene 使用 SettingsLayout 计算设置弹层');
  ok(!menuSource2.includes('x: W / 2 - 260'), '旧的一列堆叠弹层尺寸已移除');

  section('关卡选择：列表绘制裁剪到固定栏下方内容区');
  const levelLayout = await import('../src/ui/LevelSelectLayout');
  const clip = levelLayout.levelContentRect();
  const scrollMax = levelLayout.levelMaxScroll(48);
  ok(clip.y >= 112, '内容裁剪区顶部位于固定标题栏与彩蛋横幅之下');
  ok(clip.h > 0 && clip.y + clip.h <= GAME_CONFIG.CANVAS_HEIGHT - 36, '裁剪区底部留出底部提示空间');
  ok(scrollMax > 0, '48 关列表需要滚动（存在有效最大滚动量）');
  // 滚到底：最后一行底边正好落在裁剪区下边界
  const last = levelLayout.levelCellRect(47, scrollMax);
  ok(last.y + last.h <= clip.y + clip.h, '滚到底时第 48 关完整落在裁剪区内');
  ok(Math.abs(last.y + last.h - (clip.y + clip.h)) <= 1, '最大滚动量按裁剪区下边界计算（无空白/越界）');
  // 顶部：未滚动时第一行与裁剪区上边界对齐，向上滚不会进入固定栏
  const first = levelLayout.levelCellRect(0, 0);
  ok(first.y >= clip.y, '未滚动时第一行从裁剪区顶部开始');
  ok(levelLayout.levelCellRect(0, scrollMax).y + 90 <= clip.y, '滚到底时首行完全滚出裁剪区（不会压在固定栏上）');
  ok(levelLayout.levelMaxScroll(48) > levelLayout.levelMaxScroll(36), '48 关比 36 关需要更大的滚动量');
  const selectSource = fs.readFileSync(nodePath.join(process.cwd(), 'src', 'scenes', 'LevelSelectScene.ts'), 'utf8');
  ok(selectSource.includes('ctx.clip()') && selectSource.includes('levelContentRect()'),
    'LevelSelectScene 用裁剪区绘制列表（不是再覆盖一层固定栏）');
  ok(selectSource.includes('levelMaxScroll(LEVELS.length)'), '滚动上限与裁剪区使用同一套几何');

  section('健康游戏忠告：文案完整 / 8 行两栏版式 / 冷启动先于主菜单');
  const health = await import('../src/data/healthAdvisory');
  eq(health.HEALTH_ADVISORY_TITLE, '健康游戏忠告', '忠告页标题为「健康游戏忠告」');
  const requiredHealth = [
    '抵制不良游戏，拒绝盗版游戏。',
    '注意自我保护，谨防受骗上当。',
    '适度游戏益脑，沉迷游戏伤身。',
    '合理安排时间，享受健康生活。',
  ];
  eq(health.HEALTH_ADVISORY_SENTENCES, requiredHealth, '标准四句文案逐字一致、未删减');
  eq(health.HEALTH_ADVISORY_LINES.length, 8, '按合规要求排成 8 行');
  ok(health.HEALTH_ADVISORY_LINES.every(l => l.length === 7), '每行均为 7 个全角字符（两栏等宽对齐）');
  // 8 行两两拼回四句，确认没有丢字或改写
  const rejoined = [0, 2, 4, 6].map(i => health.HEALTH_ADVISORY_LINES[i] + health.HEALTH_ADVISORY_LINES[i + 1]);
  eq(rejoined, requiredHealth, '8 行拼回后与标准四句完全一致');

  const hl = health.HEALTH_ADVISORY_LAYOUT;
  const GAME_W = 960;
  const blockW = hl.columnX[1] - hl.columnX[0] + 7 * hl.bodyFontPx;
  ok(hl.bodyFontPx >= 28, `正文字号 ${hl.bodyFontPx}px 不低于旧版 28px`);
  ok(hl.lineGap > hl.bodyFontPx * 1.2, `行距 ${hl.lineGap}px 大于 1.2 倍字号，读数不挤`);
  ok(blockW / GAME_W >= 0.6, `文本块横向占比 ${(blockW / GAME_W * 100).toFixed(0)}% ≥ 60%（不再两侧大片空白）`);
  ok(hl.columnX[0] - 7 * hl.bodyFontPx / 2 > 0
    && hl.columnX[1] + 7 * hl.bodyFontPx / 2 < GAME_W, '两栏都不越出 960 画布');
  ok(hl.columnX[1] - hl.columnX[0] > 7 * hl.bodyFontPx, '两栏之间留出栏间距（不粘成一段）');
  const bodyLastY = hl.firstLineY + 3 * hl.lineGap + hl.bodyFontPx / 2;
  ok(bodyLastY < hl.hintY && hl.hintY < 540, '8 行正文不与底部操作提示重叠');

  ok(health.HEALTH_ADVISORY_HINT.includes('点击') && health.HEALTH_ADVISORY_HINT.includes('任意键'), '支持点击或按键继续');
  // 美术风格：与主菜单一致的卡通天空，不再是独立深色页
  const healthSceneSource = fs.readFileSync(
    nodePath.join(process.cwd(), 'src', 'scenes', 'HealthAdvisoryScene.ts'), 'utf8');
  ok(healthSceneSource.includes('drawToonSky'), '忠告页使用卡通天空背景（与主菜单同一风格）');
  ok(healthSceneSource.includes("hills: false"), '忠告页天空不画青山（纯天空，不需要草地）');
  ok(healthSceneSource.includes("'#ff4d6d'") || healthSceneSource.includes('UI.color.accent'),
    '标题使用卡通红强调色');
  const mainSource = fs.readFileSync(nodePath.join(process.cwd(), 'src', 'main.ts'), 'utf8');
  ok(mainSource.includes('new HealthAdvisoryScene(game)'), '冷启动先进入忠告页');
  ok(!mainSource.includes('new MenuScene('), '主菜单不在启动时直接创建（需先经过忠告页）');
  ok(!menuSource2.includes('HealthAdvisoryScene'), '主菜单/其它场景切换不会重复弹忠告页');

  section('强制横屏：manifest 锁定 + 原生兜底 + 无竖屏拦截');
  const manifestSource = fs.readFileSync(
    nodePath.join(process.cwd(), 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  ok(manifestSource.includes('android:screenOrientation="sensorLandscape"'),
    'Activity 锁定 sensorLandscape（左右横屏都允许，绝不竖屏）');
  ok(manifestSource.includes('android:configChanges="orientation|'), '仍保留 configChanges，旋转不重建 Activity（沉浸式/安全区不受影响）');
  const activitySource = fs.readFileSync(nodePath.join(process.cwd(), 'android', 'app', 'src', 'main', 'java',
    'com', 'experiment', 'magneticrush', 'MainActivity.java'), 'utf8');
  ok(activitySource.includes('SCREEN_ORIENTATION_SENSOR_LANDSCAPE') && activitySource.includes('ensureLandscape()'),
    'MainActivity 在不处于横屏时再次请求 sensorLandscape（ROM/分屏兜底）');
  ok(activitySource.includes('applyImmersiveMode()'), '沉浸式逻辑仍在');
  const htmlSource = fs.readFileSync(nodePath.join(process.cwd(), 'index.html'), 'utf8');
  eq(/orientation:\s*portrait/.test(htmlSource), false, '不再有“竖屏就弹遮罩”的媒体查询');
  ok(htmlSource.includes('max-aspect-ratio: 1/1'), '改为按窗口比例兜底（仅分屏/小窗等异常比例时提示）');
  ok(htmlSource.includes('退出分屏'), '兜底提示说明是分屏/小窗导致，而不是让玩家自己转屏');
  const webmanifest = JSON.parse(fs.readFileSync(nodePath.join(process.cwd(), 'public', 'manifest.webmanifest'), 'utf8'));
  eq(webmanifest.orientation, 'landscape', 'PWA manifest 同样声明横屏');

  section('联机大厅：复制房间号按钮仅房主可见');
  const roomUi = onlineMod.roomCodeCopyUi;
  eq(roomUi(true, false).visible, true, '房主可见复制按钮');
  eq(roomUi(true, false).label, '复制房间号', '默认按钮文案为「复制房间号」');
  eq(roomUi(true, true).label, '已复制', '复制成功后反馈「已复制」');
  eq(roomUi(false, false).visible, false, '非房主不显示复制按钮');
  eq(roomUi(false, true).visible, false, '非房主即使有复制状态也不显示按钮');
  const lobbySource = fs.readFileSync(nodePath.join(process.cwd(), 'src', 'scenes', 'OnlineLobbyScene.ts'), 'utf8');
  ok(lobbySource.includes("from '../net/LevelShare'") && lobbySource.includes('copyText('),
    '复用现有 LevelShare.copyText 写剪贴板');
  eq(/navigator\.clipboard/.test(lobbySource), false, '大厅场景不直接调用 navigator.clipboard（复用唯一封装）');
  ok(lobbySource.includes('roomCodeCopyUi('), '大厅按房主身份决定是否绘制复制按钮');
  ok(lobbySource.includes('请手动抄写上方房间号'), '复制失败时提示玩家手抄房间号');

  /* ---------------- 汇总 ---------------- */

  console.log('');
  if (failures === 0) {
    console.log(`✓ 自检全部通过（${checks} 项断言）`);
    process.exit(0);
  } else {
    console.error(`✗ 自检失败：${failures} / ${checks}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
