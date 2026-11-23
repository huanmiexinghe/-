// 联机竞速中转服务器：只转发房间消息，不跑游戏逻辑
// 启动：cd server && npm install && npm start（默认端口 8080）
// 无公网 IP 部署：云电脑上跑本服务 + cpolar HTTP 隧道穿透到本机 8080
//   另开窗口执行 cpolar http 8080，本服务会自动探测并打印 wss://xxx.cpolar.top 公网地址

import { WebSocketServer } from 'ws';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateFinish } from './relay-validate.mjs';
import {
  LevelStore, RateLimiter, createLevelHttpHandler, LEVELS_API_VERSION,
} from './level-store.mjs';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
// 监听地址：默认 0.0.0.0（保留局域网直连）；服务器部署设 HOST=127.0.0.1，只让 cpolar 本机回源
const HOST = process.env.HOST || '0.0.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// 自制关卡：HTTP 接口与 WS 共用端口；数据落在 server/data/levels.json（重启保留）
const levelStore = new LevelStore(process.env.LEVELS_DIR || path.join(HERE, 'data'));
const uploadLimiter = new RateLimiter({ limit: 6, windowMs: 10 * 60 * 1000 });
const readLimiter = new RateLimiter({ limit: 120, windowMs: 10 * 60 * 1000 });
const handleLevelHttp = createLevelHttpHandler({ store: levelStore, uploadLimiter, readLimiter });

const httpServer = http.createServer((req, res) => {
  Promise.resolve(handleLevelHttp(req, res)).then(handled => {
    if (handled) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Magnetic Rush relay');
  }).catch(err => {
    console.error(`[relay] HTTP 处理异常：${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ ok: false, error: '服务器内部错误' }));
  });
});
const wss = new WebSocketServer({ server: httpServer });

// 端口冲突时优雅报错，避免未捕获异常直接崩溃
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[relay] 启动失败：端口 ${PORT} 已被占用`);
    console.error('[relay] 请先杀掉占用进程：netstat -ano | findstr :' + PORT);
    console.error('[relay] 或换一个端口：PORT=9000 npm start（记得同步改隧道本地端口）');
  } else {
    console.error(`[relay] 启动错误：${err.message}`);
  }
  process.exit(1);
});
httpServer.listen(PORT, HOST, () => {
  console.log(`[relay] Magnetic Rush online server listening on ws://${HOST}:${PORT}`);
  console.log(`[relay] 自制关卡接口：http://${HOST}:${PORT}/api/levels（v${LEVELS_API_VERSION}，存 ${levelStore.size} 张，目录 ${levelStore.dir}）`);
  // 只有监听 0.0.0.0 时才有局域网直连入口；绑 127.0.0.1 时不打印，避免误导
  if (HOST !== '0.0.0.0') return;
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family === 'IPv4' && !n.internal) {
        console.log(`[relay] 局域网直连地址：ws://${n.address}:${PORT}`);
      }
    }
  }
});

/**
 * 房间：{ code, hostId, players: Map<publicId,{name,ready,disconnected,token}>, phase, pick, startAt, lastX, timers, finished }
 * 身份：客户端永远不能自报 id；
 *   - 连接建立时服务端下发 hello { token, id, serverNow }
 *   - token 只用于 30 秒内重连恢复席位，绝不写进 roomInfo
 *   - roomInfo 中只出现公开别名 id，房主用同一个 id 标识
 */
const rooms = new Map();
/** sessionToken -> { token, publicId, roomCode, ws, name, closedAt } */
const sessions = new Map();

function randCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function randPublicId() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = 'p';
  for (let i = 0; i < 7; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch { }
}

function sendToPlayer(room, pid, msg) {
  const p = room.players.get(pid);
  if (!p) return;
  const s = sessions.get(p.token);
  if (s?.ws) send(s.ws, msg);
}

function broadcast(room, msg, exceptId = null) {
  for (const id of room.players.keys()) {
    if (id !== exceptId) sendToPlayer(room, id, msg);
  }
}

function roomInfo(room) {
  return {
    type: 'room',
    code: room.code,
    phase: room.phase,
    pick: room.pick,
    startAt: room.startAt,
    players: [...room.players.entries()].map(([id, p]) => ({
      id, name: p.name, ready: p.ready, host: id === room.hostId, disconnected: !!p.disconnected,
    })),
  };
}

// 快捷短语：服务器白名单，只接受序号
const QUICK_PHRASES = ['冲啊！', '稳住！', '好险！', '终点见！'];
const PLAYER_RECONNECT_GRACE_MS = 30_000;
// 本局看门狗：某人连续这么久没有前进（lastX 不涨）就视为卡住/挂机
const RACE_STALL_MS = 35_000;
const RACE_WATCH_TICK_MS = 5_000;

wss.on('connection', (ws) => {
  /** 本连接的会话：create/join 前由服务端创建，客户端无法伪造 */
  const session = {
    token: randomUUID(),
    publicId: randPublicId(),
    roomCode: '',
    ws,
    name: '玩家',
    closedAt: 0,
  };
  sessions.set(session.token, session);
  send(ws, { type: 'hello', token: session.token, id: session.publicId, serverNow: Date.now() });
  console.log(`[relay] 新连接（当前 ${wss.clients.size} 个）`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const currentRoom = session.roomCode ? rooms.get(session.roomCode) ?? null : null;
    const myId = session.publicId;

    switch (msg.type) {
      // RTT 探测：原样回带客户端时间戳（不需要房间；旧客户端不会发送此消息）
      case 'ping': {
        if (typeof msg.t !== 'number' || !Number.isFinite(msg.t)) return;
        send(ws, { type: 'pong', t: msg.t, serverNow: Date.now() });
        return;
      }
      // 重连：用旧会话 token 把身份迁移到当前 socket
      case 'resume': {
        const token = String(msg.token || '');
        const old = sessions.get(token);
        if (!old || old === session || Date.now() - (old.closedAt || 0) > PLAYER_RECONNECT_GRACE_MS) {
          send(ws, { type: 'error', code: 'RESUME_FAILED' });
          return;
        }
        if (old.ws && old.ws !== ws) { try { old.ws.close(); } catch { /* ignore */ } }
        // 丢弃当前临时身份，改用旧身份（房主席位/房间都随 publicId 恢复）
        sessions.delete(session.token);
        session.token = old.token;
        session.publicId = old.publicId;
        session.name = old.name;
        session.roomCode = old.roomCode;
        session.closedAt = 0;
        old.ws = null;
        sessions.set(session.token, session);
        // 身份已迁移到旧会话：把旧公开 id 重新下发给客户端（房主判定依赖它）
        send(ws, { type: 'hello', token: session.token, id: session.publicId, serverNow: Date.now() });

        const room = session.roomCode ? rooms.get(session.roomCode) : null;
        const resumedId = session.publicId;
        if (room && room.players.has(resumedId)) {
          const p = room.players.get(resumedId);
          const timer = room.timers.get(resumedId);
          if (timer) { clearTimeout(timer); room.timers.delete(resumedId); }
          p.disconnected = false;
          // 刚重连的玩家先重置“有进度”计时，避免看门狗把他误判成挂机直接结算
          if (room.phase === 'race') room.progressAt.set(resumedId, Date.now());
          if (typeof msg.name === 'string' && msg.name.trim()) p.name = msg.name.trim().slice(0, 12);
          send(ws, { type: 'joined', code: room.code });
          broadcast(room, roomInfo(room));
          console.log(`[relay] ${p.name} 重连回 ${room.code}`);
        } else {
          session.roomCode = '';
          send(ws, { type: 'error', code: 'ROOM_NOT_FOUND' });
        }
        return;
      }
      case 'create': {
        if (currentRoom) leaveRoom(session, currentRoom);
        if (typeof msg.name === 'string' && msg.name.trim()) session.name = msg.name.trim().slice(0, 12);
        let code;
        do { code = randCode(); } while (rooms.has(code));
        const room = {
          code, hostId: myId,
          players: new Map([[myId, { name: session.name, ready: false, disconnected: false, token: session.token }]]),
          phase: 'lobby', pick: { kind: 'builtin', id: 1 }, startAt: 0,
          lastX: new Map(),
          timers: new Map(),
          finished: new Map(),
          // 本局结算：raceEnded 只广播一次；progressAt 记录每人最后一次“有进度”的时刻，
          // 用于“有人一直不动”的看门狗（超过 RACE_STALL_MS 没前进就判超时结束）
          raceEnded: false,
          raceStartedAt: 0,
          progressAt: new Map(),
          raceTimer: null,
        };
        rooms.set(code, room);
        session.roomCode = code;
        console.log(`[relay] 建房 ${code}（房主 ${session.name}）`);
        send(ws, { type: 'created', code });
        broadcast(room, roomInfo(room));
        break;
      }
      case 'join': {
        const code = (msg.code || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, { type: 'error', code: 'ROOM_NOT_FOUND' }); return; }
        if (typeof msg.name === 'string' && msg.name.trim()) session.name = msg.name.trim().slice(0, 12);
        // 断线重连（resume 已完成身份迁移）：席位在 30 秒内保留，比赛中也可回
        if (room.players.has(myId)) {
          const p = room.players.get(myId);
          const timer = room.timers.get(myId);
          if (timer) { clearTimeout(timer); room.timers.delete(myId); }
          p.disconnected = false;
          // 同上：重连回比赛中的人不能被“长时间没前进”看门狗误判
          if (room.phase === 'race') room.progressAt.set(myId, Date.now());
          if (session.name) p.name = session.name;
          if (session.roomCode && session.roomCode !== code) {
            const prev = rooms.get(session.roomCode);
            if (prev) leaveRoom(session, prev);
          }
          session.roomCode = code;
          console.log(`[relay] ${p.name} 重连回 ${code}`);
          send(ws, { type: 'joined', code });
          broadcast(room, roomInfo(room));
          return;
        }
        if (room.players.size >= 4) { send(ws, { type: 'error', code: 'ROOM_FULL' }); return; }
        if (room.phase === 'race') { send(ws, { type: 'error', code: 'ROOM_IN_RACE' }); return; }
        if (currentRoom) leaveRoom(session, currentRoom);
        room.players.set(myId, { name: session.name, ready: false, disconnected: false, token: session.token });
        session.roomCode = code;
        console.log(`[relay] ${session.name} 加入 ${code}（${room.players.size}人）`);
        send(ws, { type: 'joined', code });
        broadcast(room, roomInfo(room));
        break;
      }
      case 'select_level': {
        if (!currentRoom || currentRoom.hostId !== myId) return;
        currentRoom.pick = msg.pick;
        broadcast(currentRoom, roomInfo(currentRoom));
        break;
      }
      case 'ready': {
        if (!currentRoom) return;
        const p = currentRoom.players.get(myId);
        if (p) p.ready = !!msg.ready;
        broadcast(currentRoom, roomInfo(currentRoom));
        break;
      }
      case 'start': {
        if (!currentRoom || currentRoom.hostId !== myId) return;
        currentRoom.phase = 'race';
        currentRoom.startAt = Date.now() + 3000;
        currentRoom.lastX.clear();
        currentRoom.finished.clear();
        currentRoom.raceEnded = false;
        currentRoom.raceStartedAt = currentRoom.startAt;
        currentRoom.progressAt.clear();
        for (const id of currentRoom.players.keys()) currentRoom.progressAt.set(id, currentRoom.startAt);
        scheduleRaceWatch(currentRoom);
        broadcast(currentRoom, {
          type: 'start', startAt: currentRoom.startAt, pick: currentRoom.pick, serverNow: Date.now(),
        });
        break;
      }
      case 'rematch': {
        // 房主重赛：回到大厅，重置准备状态
        if (!currentRoom || currentRoom.hostId !== myId) return;
        resetRace(currentRoom);
        for (const p of currentRoom.players.values()) p.ready = false;
        broadcast(currentRoom, { type: 'rematch' });
        broadcast(currentRoom, roomInfo(currentRoom));
        break;
      }
      case 'back_to_lobby': {
        // 房主结束比赛：专用事件，确保其他玩家自动回大厅
        if (!currentRoom || currentRoom.hostId !== myId) return;
        resetRace(currentRoom);
        for (const p of currentRoom.players.values()) p.ready = false;
        broadcast(currentRoom, { type: 'back_to_lobby' });
        broadcast(currentRoom, roomInfo(currentRoom));
        break;
      }
      case 'leave': {
        // 任何玩家都能主动离开（含比赛中）：退出观战/结算界面用，避免只能等房主
        if (!currentRoom) {
          session.roomCode = '';
          return;
        }
        const room = currentRoom;
        console.log(`[relay] ${session.name} 主动离开 ${room.code}`);
        leaveRoom(session, room);
        break;
      }
      case 'phrase': {
        if (!currentRoom) return;
        const idx = Number(msg.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= QUICK_PHRASES.length) return;
        const p = currentRoom.players.get(myId);
        broadcast(currentRoom, {
          type: 'phrase', from: myId, name: p?.name ?? '玩家', text: QUICK_PHRASES[idx],
        });
        break;
      }
      case 'state': {
        // 实时状态转发（位置、极性、完成）——基础校验：有限值 + 进度单调 + 时间合理
        if (!currentRoom || currentRoom.phase !== 'race') return;
        const d = msg.data || {};
        const nums = [d.x, d.y, d.vx, d.vy, d.polarity, d.time];
        if (!nums.every(v => typeof v === 'number' && Number.isFinite(v))) return;
        let prev = currentRoom.lastX.get(myId) ?? 0;
        if (d.time < 0 || d.time > 3600) return;
        // 复活会把人拉回检查点：允许一次明显回退并重置单调基线。
        // 否则观战者看到的坐标会永远冻在死亡点，看门狗也会把“正在重跑的人”误判成挂机。
        if (d.x < prev - 8) prev = d.x;
        const nextX = Math.max(prev, d.x);
        // 前进超过 2px 才刷新“有进度”时间，观战面板的连击字段只做兜底截断
        if (nextX > prev + 2) currentRoom.progressAt.set(myId, Date.now());
        currentRoom.lastX.set(myId, nextX);
        if (typeof d.combo === 'number' && Number.isFinite(d.combo)) {
          d.combo = Math.max(0, Math.min(9999, Math.floor(d.combo)));
        } else {
          delete d.combo;
        }
        broadcast(currentRoom, { type: 'state', from: myId, ...d }, myId);
        break;
      }
      case 'finish': {
        if (!currentRoom) return;
        const t = Number(msg.time);
        // 同一玩家只接受一次完赛成绩（重复发送更小时间无法覆盖排名）
        if (!validateFinish({
          phase: currentRoom.phase,
          alreadyFinished: currentRoom.finished.has(myId),
          time: t,
          lastX: currentRoom.lastX.get(myId) ?? 0,
        })) return;
        currentRoom.finished.set(myId, t);
        broadcast(currentRoom, { type: 'finish', from: myId, time: t });
        // 根因修复：最后一人 finish 时服务端从未判定“本局结束”，客户端只能干等
        maybeEndRace(currentRoom);
        break;
      }
    }
  });

  ws.on('close', () => {
    // 已被新连接顶替的旧 socket 关闭时，不能影响当前会话
    const latest = sessions.get(session.token);
    if (latest?.ws !== ws) return;
    session.ws = null;
    session.closedAt = Date.now();
    const room = session.roomCode ? rooms.get(session.roomCode) : null;
    if (!room) {
      sessions.delete(session.token);
      return;
    }
    // 30 秒重连窗口：先保留席位并标记断开，超时才真正移除
    const p = room.players.get(session.publicId);
    if (!p) {
      sessions.delete(session.token);
      return;
    }
    p.disconnected = true;
    p.ready = false;
    const timer = setTimeout(() => {
      if (room.players.get(session.publicId)?.disconnected) {
        leaveRoom(session, room);
        sessions.delete(session.token);
      }
      room.timers.delete(session.publicId);
    }, PLAYER_RECONNECT_GRACE_MS);
    room.timers.set(session.publicId, timer);
    broadcast(room, roomInfo(room));
  });
});

function resetRace(room) {
  room.phase = 'lobby';
  room.startAt = 0;
  room.lastX.clear();
  room.finished.clear();
  room.raceEnded = false;
  room.raceStartedAt = 0;
  room.progressAt.clear();
  if (room.raceTimer) {
    clearInterval(room.raceTimer);
    room.raceTimer = null;
  }
}

/** 本局看门狗：每 5 秒检查一次，全员完赛或有人长时间不动就广播结算 */
function scheduleRaceWatch(room) {
  if (room.raceTimer) clearInterval(room.raceTimer);
  room.raceTimer = setInterval(() => {
    if (room.phase !== 'race' || room.raceEnded) {
      clearInterval(room.raceTimer);
      room.raceTimer = null;
      return;
    }
    maybeEndRace(room);
  }, RACE_WATCH_TICK_MS);
  if (room.raceTimer.unref) room.raceTimer.unref();
}

/**
 * 是否该结算：房内所有人都已完赛（或房里已经没人），
 * 或者所有未完赛的人都超过 RACE_STALL_MS 没有前进（挂机/卡住）。
 */
function maybeEndRace(room) {
  if (!room || room.phase !== 'race' || room.raceEnded) return;
  if (room.players.size === 0) return;
  const unfinished = [...room.players.keys()].filter(id => !room.finished.has(id));
  if (unfinished.length === 0) {
    endRace(room, 'all_finished');
    return;
  }
  const now = Date.now();
  const stalled = unfinished.filter(id => now - (room.progressAt.get(id) ?? room.raceStartedAt) >= RACE_STALL_MS);
  if (stalled.length === unfinished.length) endRace(room, 'timeout');
}

function endRace(room, reason) {
  if (!room || room.raceEnded) return;
  room.raceEnded = true;
  if (room.raceTimer) {
    clearInterval(room.raceTimer);
    room.raceTimer = null;
  }
  const results = [...room.players.entries()]
    .map(([id, p]) => ({
      id,
      name: p.name,
      finished: room.finished.has(id),
      time: room.finished.get(id) ?? 0,
    }))
    .sort((a, b) => {
      if (a.finished && b.finished) return a.time - b.time;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return 0;
    });
  console.log(`[relay] 房间 ${room.code} 本局结算（${reason}，${results.length} 人）`);
  broadcast(room, { type: 'race_end', reason, results, serverNow: Date.now() });
}

function leaveRoom(session, room) {
  const pid = session.publicId;
  const timer = room.timers?.get(pid);
  if (timer) { clearTimeout(timer); room.timers.delete(pid); }
  room.players.delete(pid);
  room.lastX?.delete(pid);
  room.finished?.delete(pid);
  room.progressAt?.delete(pid);
  if (session.roomCode === room.code) session.roomCode = '';
  if (room.players.size === 0) {
    for (const t of room.timers?.values() ?? []) clearTimeout(t);
    if (room.raceTimer) clearInterval(room.raceTimer);
    rooms.delete(room.code);
    return;
  }
  // 房主离开：转让给第一个仍在线（未断开）的玩家，全部断开则交给第一个
  if (room.hostId === pid) {
    const connected = [...room.players.entries()].find(([, p]) => !p.disconnected);
    room.hostId = connected ? connected[0] : [...room.players.keys()][0];
  }
  broadcast(room, roomInfo(room));
  // 有人退出/掉线被移除后重新判定：剩下的都完赛就立刻结算，不必等房主
  maybeEndRace(room);
}

// 自动识别 cpolar 隧道地址（cpolar 本地 API：http://127.0.0.1:4040）
// 主用穿透方案：另开窗口执行 cpolar http 8080；识别到后打印玩家要填的 wss 地址
// 不设探测次数上限——relay 可能被 pm2 设为开机自启、早于 cpolar 上线，发现隧道后自动停止探测
let cpolarFound = false;
const cpolarTimer = setInterval(async () => {
  if (cpolarFound) { clearInterval(cpolarTimer); return; }
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(1200) });
    const data = await res.json();
    for (const t of data.tunnels ?? []) {
      if (t.proto === 'https' && t.public_url) {
        console.log(`[relay] 已识别 cpolar 隧道，玩家服务器地址填：${t.public_url.replace('https://', 'wss://')}`);
        console.log(`[relay] 自制关卡上传/下载接口：${t.public_url}/api/levels`);
        cpolarFound = true;
        break;
      }
    }
  } catch { /* cpolar 未启动，继续等待 */ }
}, 5000);
