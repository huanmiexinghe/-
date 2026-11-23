// 编辑器撤销栈：保存「变更前」的完整快照，最多 20 步，栈满丢最早
//
// 快照包含障碍数组、参数面板、传送门配对状态与序号，
// 因此放置 / 删除 / 移动 / 改参数 / 清空都能精确回滚，无需重新载入关卡。
// 只做撤销；redo 未实现——如需扩展，在 undo() 返回当前状态快照并维护第二个栈即可。

import type { CustomObstacleDto } from './CustomLevels';
import type { ToolId } from './EditorTools';

export interface EditorParams {
  mplatAxis: 'x' | 'y';
  mplatRange: number;
  mplatPeriod: number;
  wallPolarity: 'RED' | 'BLUE';
  laserOrientation: 'V' | 'H';
  laserPeriod: number;
  boostMul: number;
  boostDur: number;
  rainPolarity: 'RED' | 'BLUE';
  rainCount: number;
  /** 晶片颜色：ANY = 任意极性可拾取 */
  gemColor: 'ANY' | 'RED' | 'BLUE';
  launchPolarity: 'RED' | 'BLUE';
  slideRange: number;
  slidePeriod: number;
  conveyorDir: 1 | -1;
  conveyorSpeed: number;
  pitWidth: number;
  pendAmplitude: number;
  pendPeriod: number;
  pendWarn: number;
  comboRequired: number;
}

export interface PortalPending {
  id: number;
  kind: 'PORTAL_A' | 'PORTAL_B';
}

export interface EditorSnapshot {
  obstacles: CustomObstacleDto[];
  params: EditorParams;
  pendingPortal: PortalPending | null;
  portalSeq: number;
  /** 当前选中工具也随快照回滚，撤销后面板与选中态一致 */
  tool: ToolId;
}

export const EDIT_HISTORY_LIMIT = 20;

export const DEFAULT_EDITOR_PARAMS: EditorParams = {
  mplatAxis: 'y',
  mplatRange: 90,
  mplatPeriod: 3,
  wallPolarity: 'RED',
  laserOrientation: 'V',
  laserPeriod: 2.8,
  boostMul: 2,
  boostDur: 3,
  rainPolarity: 'RED',
  rainCount: 3,
  gemColor: 'ANY',
  launchPolarity: 'RED',
  slideRange: 100,
  slidePeriod: 3,
  conveyorDir: 1,
  conveyorSpeed: 90,
  pitWidth: 180,
  pendAmplitude: 0.62,
  pendPeriod: 2.86,
  pendWarn: 0.45,
  comboRequired: 5,
};

export class EditHistory {
  private stack: EditorSnapshot[] = [];

  constructor(readonly limit: number = EDIT_HISTORY_LIMIT) { }

  /** 记录「变更前」状态；深拷贝，调用后修改原对象不会污染历史 */
  push(snapshot: EditorSnapshot) {
    this.stack.push(structuredClone(snapshot));
    if (this.stack.length > this.limit) this.stack.shift();
  }

  /** 弹出最近一步并返回快照；无历史时返回 null */
  undo(): EditorSnapshot | null {
    return this.stack.pop() ?? null;
  }

  get canUndo(): boolean {
    return this.stack.length > 0;
  }

  get size(): number {
    return this.stack.length;
  }

  clear() {
    this.stack = [];
  }
}
