// 联机管理器：WebSocket 客户端单例
// 连接中转服务器，处理房间/状态消息，提供事件订阅
// 轻量增强：30 秒断线重连、房主重赛、4 条快捷短语、基础成绩校验

export type LevelPick =
  | { kind: 'builtin'; id: number }
  | { kind: 'custom'; name: string; code: string };

import { RemoteInterpolator, RttStats, INTERP_DELAY_MS } from './NetTiming';

/** 默认服务器地址由 ServerUrl 统一维护（联机与地图上传共用同一来源），这里只做转出 */
export { DEFAULT_SERVER_URL } from './ServerUrl';

/** 快捷短语：只发送序号，由服务器映射为固定文案（不接收自由文本） */
export const QUICK_PHRASES = ['冲啊！', '稳住！', '好险！', '终点见！'] as const;

/**
 * 房间号复制入口的可见性与文案：
 * 只有房主需要把房间号发出去，非房主不显示复制按钮；
 * 复制成功后按钮短暂变为「已复制」。
 */
export function roomCodeCopyUi(isHost: boolean, copied: boolean) {
  return {
    visible: isHost,
    label: copied ? '已复制' : '复制房间号',
  };
}

const RECONNECT_WINDOW_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** 状态上报节流：30 次/秒（每包约 100B，单玩家带宽约 3KB/s） */
const STATE_MIN_INTERVAL_MS = 33;
/** RTT 探测周期 */
const PING_INTERVAL_MS = 1_000;

export interface NetPlayer {
  id: string;
  name: string;
  ready: boolean;
  host: boolean;
  /** 断开连接但在重连窗口内保留席位 */
  disconnected?: boolean;
}

export interface NetState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  polarity: number;
  finished: boolean;
  time: number;
  /** 当前连击（观战面板展示用；旧服务端不校验也不影响转发） */
  combo?: number;
  /** 存活（死亡动画期间为 false）：远端据此隐藏本体，避免残留空壳 */
  alive?: boolean;
  /** 滑行中（旧服务端会原样转发；旧客户端忽略） */
  sliding?: boolean;
  /** 重力倒挂 */
  flipped?: boolean;
}

type Listener = (data: any) => void;

class OnlineManager {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();

  /** 服务端在 hello 中下发的一次性公开 id（roomInfo 里只出现这个 id） */
  selfId = '';
  /** 服务端下发的会话令牌：只用于 30 秒内重连恢复席位，不对外广播 */
  private clientToken = '';
  /** 服务器时钟与本地时钟的偏移（毫秒），倒计时以服务器时间为准 */
  private serverOffset = 0;
  private selfName = '玩家';
  private lastUrl = '';
  private intentionalClose = false;
  private reconnectTimer: number | null = null;
  private reconnectStartedAt = 0;
  private reconnectAttempt = 0;
  private lastStateAt = 0;
  private lastSentX = 0;
  private pingTimer: number | null = null;

  room = '';
  phase: 'lobby' | 'race' = 'lobby';
  players: NetPlayer[] = [];
  pick: LevelPick = { kind: 'builtin', id: 1 };
  startAt = 0;
  lastError = '';
  reconnecting = false;
  /** 服务端判定本局结束（全员完赛 / 超时）后置 true，用于结算界面 */
  raceOver = false;
  raceEndReason = '';
  raceResults: { id: string; name: string; time: number; finished: boolean }[] = [];

  // 其他玩家实时状态
  remoteStates = new Map<string, NetState>();
  finishTimes = new Map<string, number>();
  /** 每个远端玩家的插值缓冲（按本地接收时钟） */
  private interps = new Map<string, RemoteInterpolator>();
  /** ping/pong 往返时延统计 */
  rtt = new RttStats();
  /** 当前插值缓冲时长（HUD 展示用） */
  readonly interpDelayMs = INTERP_DELAY_MS;

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }
  get inRoom() { return this.room !== ''; }
  get isHost() { return this.players.find(p => p.id === this.selfId)?.host ?? false; }

  connect(url: string): Promise<void> {
    this.lastUrl = url;
    this.intentionalClose = false;
    return this.openSocket(url, true);
  }

  private openSocket(url: string, rejectOnFail: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        // 构造 WebSocket 就抛错：地址语法错误，或被 WebView 拦截混合内容（https 页面连 ws://）
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        const hint = /insecure|mixed content|SecurityError/i.test(detail)
          ? '；安全页面(https)不能连明文 ws://，请改用 wss:// 地址'
          : '';
        reject(new Error(`地址无效（尝试连接 ${url}）：${detail}${hint}`));
        return;
      }
      this.ws = ws;
      let opened = false;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      // 所有连接（含重连）都必须有超时：否则 socket 长期 CONNECTING 会让重连循环永久挂起
      const timer = setTimeout(() => {
        if (opened) return;
        try { ws.close(); } catch { /* ignore */ }
        fail(new Error('连接超时，请检查服务器是否已启动'));
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        // 旧 socket 的迟到事件不能污染新连接状态
        if (this.ws !== ws) { try { ws.close(); } catch { /* ignore */ } return; }
        opened = true;
        if (!settled) { settled = true; clearTimeout(timer); resolve(); }
        this.startPing();
        const wasReconnecting = this.reconnecting;
        this.reconnecting = false;
        this.reconnectAttempt = 0;
        // 重连成功：用服务端下发的会话令牌恢复原席位（不暴露真实 id）
        if (wasReconnecting && this.room && this.clientToken) {
          this.send({ type: 'resume', token: this.clientToken, code: this.room, name: this.selfName });
          this.emit('reconnected', { room: this.room });
        }
      };
      ws.onerror = () => {
        if (!opened) fail(new Error(rejectOnFail ? '连接失败，请检查服务器地址与端口' : '重连失败'));
      };
      ws.onclose = (ev) => {
        if (!opened) {
          // 连接阶段就被关闭：多半是协议不对（wss/ws 与隧道类型不匹配）或地址错误
          fail(new Error(`连接被关闭(code=${ev.code})，确认地址协议正确（wss:// 或 ws://）`));
          return;
        }
        if (this.ws !== ws) return; // 旧 socket 关闭，不影响当前连接
        this.ws = null;
        this.stopPing();
        this.emit('closed', null);
        if (this.intentionalClose) {
          this.room = '';
          this.players = [];
          return;
        }
        // 非主动断开且仍在房间：进入 30 秒重连窗口
        if (this.room) this.scheduleReconnect();
      };
      ws.onmessage = (ev) => {
        if (this.ws !== ws) return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this.handle(msg);
      };
    });
  }

  /** 断线重连：1s → 2s → 4s → 8s，最长 30 秒 */
  private scheduleReconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.reconnectStartedAt = Date.now();
    this.reconnectAttempt = 0;
    this.emit('reconnecting', { room: this.room });
    const tryOnce = async () => {
      if (!this.reconnecting) return;
      if (Date.now() - this.reconnectStartedAt > RECONNECT_WINDOW_MS) {
        this.reconnecting = false;
        this.room = '';
        this.players = [];
        this.emit('reconnect_failed', null);
        return;
      }
      const delay = Math.min(8000, 1000 * Math.pow(2, this.reconnectAttempt));
      this.reconnectTimer = window.setTimeout(async () => {
        this.reconnectAttempt++;
        try {
          await this.openSocket(this.lastUrl, false);
        } catch {
          tryOnce();
        }
      }, delay);
    };
    tryOnce();
  }

  /** RTT 探测：每 1 秒一次，服务端 pong 原样带回时间戳 */
  private startPing() {
    this.stopPing();
    const ping = () => this.send({ type: 'ping', t: Date.now() });
    ping();
    this.pingTimer = window.setInterval(ping, PING_INTERVAL_MS);
  }

  private stopPing() {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** 取某个远端玩家的插值/外推后状态（渲染用；排名等进度仍用原始包） */
  sampleRemote(id: string, now = performance.now()) {
    return this.interps.get(id)?.sample(now) ?? null;
  }

  /** HUD 文案：没有 pong 时（旧服务端）返回 null */
  rttSummary(): string | null {
    return this.rtt.summary();
  }

  disconnect() {
    this.intentionalClose = true;
    this.reconnecting = false;
    this.stopPing();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }

  private send(obj: any) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  createRoom(name: string) {
    this.selfName = name || '玩家';
    this.send({ type: 'create', name: this.selfName, token: this.clientToken });
  }

  joinRoom(code: string, name: string) {
    this.selfName = name || '玩家';
    this.send({ type: 'join', code: code.toUpperCase(), name: this.selfName, token: this.clientToken });
  }

  /** 服务器时钟（用于倒计时，避免本地时钟快慢造成抢跑） */
  now(): number {
    return Date.now() + this.serverOffset;
  }

  selectLevel(pick: LevelPick) {
    this.send({ type: 'select_level', pick });
  }

  setReady(ready: boolean) {
    this.send({ type: 'ready', ready });
  }

  requestStart() {
    this.send({ type: 'start' });
  }

  /** 复活回检查点后重置“进度单调”基线，否则被钳在死亡点，远端会看到超前位置 */
  resetSendBaseline() {
    this.lastSentX = 0;
  }

  /** 基础校验：坐标/时间必须是有限值；进度单调递增；最多 30 次/秒 */
  sendState(s: NetState) {
    const nums = [s.x, s.y, s.vx, s.vy, s.polarity, s.time];
    if (!nums.every(v => Number.isFinite(v))) return;
    const now = performance.now();
    if (now - this.lastStateAt < STATE_MIN_INTERVAL_MS) return;
    this.lastStateAt = now;
    // 进度不能倒退（瞬移/作弊最常见形态）；服务器也会再次校验
    const x = Math.max(0, Math.min(10_000_000, Math.max(s.x, this.lastSentX)));
    this.lastSentX = x;
    this.send({
      type: 'state',
      data: { ...s, x, time: Math.max(0, Math.min(3600, s.time)) },
    });
  }

  sendFinish(time: number) {
    if (!Number.isFinite(time)) return;
    this.send({ type: 'finish', time: Math.max(0, Math.min(3600, time)) });
  }

  /** 房主重赛：回到大厅并重置准备状态 */
  rematch() {
    this.send({ type: 'rematch' });
  }

  /** 快捷短语（只发序号） */
  sendPhrase(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= QUICK_PHRASES.length) return;
    this.send({ type: 'phrase', index });
  }

  backToLobby() {
    this.send({ type: 'back_to_lobby' });
  }

  /**
   * 主动离开房间（任何玩家都能用，比赛中也可）：先通知服务端移除席位，
   * 再清本地状态。旧服务端会忽略未知的 leave 消息，本地仍能正常回大厅。
   */
  leaveRoomRemote() {
    this.send({ type: 'leave' });
    this.leaveRoom();
  }

  /** 清空远端状态与插值缓冲：换局/回大厅/离开房间时调用，避免残留空壳 */
  private clearRemotes() {
    this.remoteStates.clear();
    this.interps.clear();
  }

  leaveRoom() {
    this.room = '';
    this.players = [];
    this.clearRemotes();
    this.finishTimes.clear();
    this.raceOver = false;
    this.raceEndReason = '';
    this.raceResults = [];
    this.lastSentX = 0;
  }

  on(event: string, fn: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  private emit(event: string, data: any) {
    this.listeners.get(event)?.forEach(fn => fn(data));
  }

  /** 房间成员变化后，丢弃已不在房间里的人的成绩/位置缓存 */
  private pruneToPlayers() {
    const ids = new Set(this.players.map(p => p.id));
    this.finishTimes.forEach((_v, id) => { if (!ids.has(id)) this.finishTimes.delete(id); });
    this.remoteStates.forEach((_v, id) => { if (!ids.has(id)) this.remoteStates.delete(id); });
    this.interps.forEach((_v, id) => { if (!ids.has(id)) this.interps.delete(id); });
  }

  private handle(msg: any) {
    switch (msg.type) {
      case 'hello':
        // 身份由服务端下发：selfId 是房间内公开别名，token 仅用于重连
        if (typeof msg.id === 'string') this.selfId = msg.id;
        if (typeof msg.token === 'string') this.clientToken = msg.token;
        if (Number.isFinite(Number(msg.serverNow))) {
          this.serverOffset = Number(msg.serverNow) - Date.now();
        }
        this.emit('hello', msg);
        break;
      case 'created':
        this.room = msg.code;
        this.emit('room', msg);
        break;
      case 'joined':
        this.room = msg.code;
        this.emit('room', msg);
        break;
      case 'room':
        this.players = msg.players || [];
        this.phase = msg.phase || 'lobby';
        this.pick = msg.pick || this.pick;
        this.startAt = msg.startAt || 0;
        // 有人退出/被移除后，清掉他的残留成绩与位置，避免排行榜出现幽灵玩家
        this.pruneToPlayers();
        this.emit('lobby', msg);
        break;
      case 'start':
        this.phase = 'race';
        this.startAt = msg.startAt;
        this.pick = msg.pick;
        this.lastSentX = 0;
        this.raceOver = false;
        this.raceEndReason = '';
        this.raceResults = [];
        if (Number.isFinite(Number(msg.serverNow))) {
          this.serverOffset = Number(msg.serverNow) - Date.now();
        }
        this.emit('start', msg);
        break;
      case 'state': {
        // 服务器已校验；客户端再做一次防御性截断
        if (![msg.x, msg.y, msg.vx, msg.vy, msg.polarity, msg.time].every((v: unknown) => Number.isFinite(Number(v)))) return;
        const state: NetState = {
          x: Number(msg.x), y: Number(msg.y), vx: Number(msg.vx), vy: Number(msg.vy),
          polarity: Number(msg.polarity), finished: !!msg.finished, time: Number(msg.time),
          combo: Number.isFinite(Number(msg.combo)) ? Number(msg.combo) : 0,
          alive: msg.alive === undefined ? true : !!msg.alive,
          sliding: !!msg.sliding,
          flipped: !!msg.flipped,
        };
        this.remoteStates.set(msg.from, state);
        let interp = this.interps.get(msg.from);
        if (!interp) { interp = new RemoteInterpolator(); this.interps.set(msg.from, interp); }
        interp.push({
          t: performance.now(),
          x: state.x, y: state.y, vx: state.vx, vy: state.vy,
          polarity: state.polarity,
          sliding: state.sliding!, flipped: state.flipped!,
          alive: state.alive!, finished: state.finished,
        });
        break;
      }
      case 'pong':
        // 服务端原样回带时间戳（旧服务端不回复，HUD 显示 —）
        if (Number.isFinite(Number(msg.t))) this.rtt.add(Date.now() - Number(msg.t));
        break;
      case 'finish':
        if (!Number.isFinite(Number(msg.time))) return;
        this.finishTimes.set(msg.from, Number(msg.time));
        this.emit('finish', msg);
        break;
      case 'race_end':
        // 服务端判定本局结束（全员完赛 / 超时有人不动），携带最终成绩
        this.raceOver = true;
        this.raceEndReason = typeof msg.reason === 'string' ? msg.reason : 'all_finished';
        this.raceResults = Array.isArray(msg.results)
          ? msg.results.filter((r: any) => r && typeof r.id === 'string').map((r: any) => ({
              id: String(r.id),
              name: String(r.name ?? '玩家'),
              time: Number.isFinite(Number(r.time)) ? Number(r.time) : 0,
              finished: !!r.finished,
            }))
          : [];
        this.emit('race_end', msg);
        break;
      case 'phrase':
        this.emit('phrase', msg);
        break;
      case 'rematch':
        this.phase = 'lobby';
        this.startAt = 0;
        this.finishTimes.clear();
        this.clearRemotes();
        this.raceOver = false;
        this.raceEndReason = '';
        this.raceResults = [];
        this.emit('rematch', msg);
        break;
      case 'back_to_lobby':
        // 房主结束比赛：所有人都要回大厅，而不只是广播房间信息
        this.phase = 'lobby';
        this.startAt = 0;
        this.finishTimes.clear();
        this.clearRemotes();
        this.raceOver = false;
        this.raceEndReason = '';
        this.raceResults = [];
        this.emit('back_to_lobby', msg);
        break;
      case 'error':
        this.lastError = msg.code;
        this.emit('error', msg.code);
        break;
      case 'closed':
        this.emit('closed', null);
        break;
    }
  }
}

export const online = new OnlineManager();
