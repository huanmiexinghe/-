// 健康游戏忠告（冷启动时展示一次）
//
// 文案为新闻出版署规定的四句标准表述，界面按「每句拆成上下半句」排成 8 行。
// 拆开后每行都是 7 个全角字符，两栏各 4 行形成整齐的等宽文本块，
// 在 960×540 逻辑画布上横向铺开（每行 7 × 38px ≈ 266px），
// 与主菜单相同的卡通天空底 + 糖果色文字，不再是独立深色页。

export const HEALTH_ADVISORY_TITLE = '健康游戏忠告';

/** 标准四句（完整表述，含标点） */
export const HEALTH_ADVISORY_SENTENCES = [
  '抵制不良游戏，拒绝盗版游戏。',
  '注意自我保护，谨防受骗上当。',
  '适度游戏益脑，沉迷游戏伤身。',
  '合理安排时间，享受健康生活。',
];

/** 实际渲染的 8 行：按逗号拆成上下半句，每行 7 个全角字符 */
export const HEALTH_ADVISORY_LINES = [
  '抵制不良游戏，',
  '拒绝盗版游戏。',
  '注意自我保护，',
  '谨防受骗上当。',
  '适度游戏益脑，',
  '沉迷游戏伤身。',
  '合理安排时间，',
  '享受健康生活。',
];

/** 版式：两栏 × 4 行，供场景与 selfcheck 共用 */
export const HEALTH_ADVISORY_LAYOUT = {
  titleY: 104,
  ruleY: 164,
  columnX: [310, 650] as [number, number],
  dividerX: 480,
  dividerTop: 196,
  dividerBottom: 430,
  firstLineY: 220,
  lineGap: 60,
  bodyFontPx: 36,
  hintY: 480,
};

export const HEALTH_ADVISORY_HINT = '点击屏幕或按任意键继续';
