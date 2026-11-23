// 运维后台：/admin 登录页、看板页、账号与数据管理接口
//
// 角色：
//  - admin  ：完整权限（看板 + 账号管理 + 清零统计 + 删除自制地图）
//  - viewer ：只能查看看板；所有写操作在服务端一律 403，不依赖前端隐藏按钮
//
// 安全约定：
//  - 账号密码只存在 DATA_DIR/accounts.json，且只保存 scrypt 哈希与每账号独立 salt；
//    relay.env 的 ADMIN_USER / ADMIN_PASSWORD 只在“还没有任何账号”时用于创建引导管理员，
//    之后以账号文件为准（详见 accounts.mjs）。
//  - 密码比较先固定长度派生再 timingSafeEqual；账号不存在也照常派生一次。
//  - 登录失败退避按“账号维度”计数：5 次锁 15 分钟。隧道下所有玩家共用出口 IP，
//    按 IP 计数会误伤所有人，所以这里不再使用 IP。
//  - 登录成功发 32 字节随机 token，仅放内存（重启失效），HttpOnly + SameSite=Strict Cookie。
//  - 所有写接口额外要求自定义请求头 X-Admin-Action / X-Admin-Confirm，
//    配合 SameSite=Strict 抵御跨站请求伪造。
//  - 日志只打印成功/失败与动作，绝不打印密码、token 原文、IP。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ADMIN_COOKIE = 'mr_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const LOGIN_BODY_LIMIT = 1024;
const API_BODY_LIMIT = 8192;
const ACCOUNT_ID_RE = /^\/admin\/api\/accounts\/([A-Za-z0-9]{8,32})(?:\/password)?$/;
const LEVEL_CODE_RE = /^\/admin\/api\/levels\/([A-Za-z0-9_-]{4,24})$/;

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "img-src data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

/** 解析 KEY=VALUE 环境文件（# 注释、空行忽略，支持成对引号） */
export function readEnvFile(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const key = s.slice(0, i).trim();
    if (!key) continue;
    let value = s.slice(i + 1).trim();
    if (value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) &&
      value[0] === value[value.length - 1]) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 引导管理员配置：环境变量优先（非空时），否则用 relay.env 文件；都没有则空串 */
export function resolveBootstrapCredentials(envFile) {
  const fileEnv = envFile ? readEnvFile(envFile) : {};
  const pick = key => {
    const fromProcess = process.env[key];
    if (fromProcess !== undefined && String(fromProcess).trim() !== '') return String(fromProcess).trim();
    return (fileEnv[key] ?? '').trim();
  };
  return { user: pick('ADMIN_USER'), password: pick('ADMIN_PASSWORD') };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function isHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (proto === 'https') return true;
  return !!req.socket?.encrypted;
}

function cookieAttrs(req) {
  return `Path=/admin; HttpOnly; SameSite=Strict${isHttps(req) ? '; Secure' : ''}`;
}

function getCookie(req, name) {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string' || !raw) return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/** 登录失败退避：按账号名（小写）计数，成功清零；只存在内存里 */
class LoginThrottle {
  constructor({ maxFails = MAX_FAILS, lockMs = LOCK_MS } = {}) {
    this.maxFails = maxFails;
    this.lockMs = lockMs;
    this.byKey = new Map();
  }

  check(key) {
    const now = Date.now();
    const rec = this.byKey.get(key);
    if (!rec) return { locked: false, retryAfterMs: 0 };
    if (rec.lockedUntil && now < rec.lockedUntil) {
      return { locked: true, retryAfterMs: rec.lockedUntil - now };
    }
    if ((rec.lockedUntil && now >= rec.lockedUntil) || now - rec.firstAt >= this.lockMs) {
      this.byKey.delete(key);
    }
    return { locked: false, retryAfterMs: 0 };
  }

  fail(key) {
    const now = Date.now();
    let rec = this.byKey.get(key);
    if (!rec || now - rec.firstAt >= this.lockMs) rec = { fails: 0, firstAt: now, lockedUntil: 0 };
    rec.fails += 1;
    if (rec.fails >= this.maxFails) rec.lockedUntil = now + this.lockMs;
    this.byKey.set(key, rec);
    if (this.byKey.size > 5000) {
      this.prune(now);
      // 仍超限（短时间内大量不同账号名）时丢弃最早的记录，避免内存无上限增长
      while (this.byKey.size > 5000) this.byKey.delete(this.byKey.keys().next().value);
    }
  }

  reset(key) {
    this.byKey.delete(key);
  }

  prune(now) {
    for (const [key, rec] of this.byKey) {
      const expired = rec.lockedUntil ? now >= rec.lockedUntil : now - rec.firstAt >= this.lockMs;
      if (expired) this.byKey.delete(key);
    }
  }
}

class AdminSessions {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  create(account) {
    const token = crypto.randomBytes(32).toString('hex');
    this.map.set(token, {
      accountId: account.id,
      expires: Date.now() + this.ttlMs,
    });
    if (this.map.size > 200) this.prune();
    return token;
  }

  get(token) {
    if (!token) return null;
    const rec = this.map.get(token);
    if (!rec) return null;
    if (Date.now() >= rec.expires) {
      this.map.delete(token);
      return null;
    }
    return rec;
  }

  destroy(token) {
    if (token) this.map.delete(token);
  }

  /** 账号被禁用 / 删除 / 改角色 / 重置密码时，撤销它的所有会话（可保留当前 token） */
  revokeAccount(accountId, exceptToken = '') {
    for (const [token, rec] of this.map) {
      if (rec.accountId === accountId && token !== exceptToken) this.map.delete(token);
    }
  }

  prune() {
    const now = Date.now();
    for (const [token, rec] of this.map) {
      if (now >= rec.expires) this.map.delete(token);
    }
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(Object.assign(new Error('too large'), { status: 413 }));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', err => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

async function readJsonBody(req) {
  let raw;
  try {
    raw = await readBody(req, API_BODY_LIMIT);
  } catch (err) {
    throw Object.assign(new Error(err.status === 413 ? '请求体过大' : '读取请求体失败'), {
      status: err.status === 413 ? 413 : 400,
    });
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw Object.assign(new Error('JSON 解析失败'), { status: 400 });
  }
}

function sendJson(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    ...extra,
  });
  res.end(body);
}

function sendText(res, status, text, extra = {}) {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(body);
}

function redirect(res, location, extra = {}) {
  res.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store',
    'Content-Length': 0,
    ...extra,
  });
  res.end();
}

/** 写接口的统一错误映射（不泄露内部细节） */
function accountErrorStatus(code) {
  switch (code) {
    case 'NOT_FOUND': return 404;
    case 'LAST_ADMIN': return 409;
    case 'DUPLICATE': return 409;
    case 'STORE_FAILED': return 500;
    default: return 400;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.publicDir 静态页目录（server/public）
 * @param {import('./stats-store.mjs').StatsStore} opts.stats
 * @param {import('./level-store.mjs').LevelStore} opts.levels
 * @param {import('./accounts.mjs').AccountStore} opts.accounts
 * @param {object} opts.live 实时聚合：{ rooms(), players(), levelStock() }
 * @returns {Function & { configured: boolean }}
 */
export function createAdminHandler({ publicDir, stats, levels, accounts, live }) {
  const adminFile = path.join(publicDir, 'admin.html');
  const loginFile = path.join(publicDir, 'admin-login.html');
  const sessions = new AdminSessions(SESSION_TTL_MS);
  const throttle = new LoginThrottle();

  function loadTemplate(file, fallback) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      console.error(`[admin] 页面读取失败 ${file}：${err.message}`);
      return fallback;
    }
  }

  function renderLogin(res, { status = 200, error = '', notice = '' } = {}) {
    const fallback = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>运维后台登录</title><body style="font-family:system-ui;background:#10131a;color:#e8edf7;padding:48px">
<h1>运维后台登录</h1><p>${escapeHtml(error)}</p><p>${escapeHtml(notice)}</p>
<form method="post" action="/admin/login"><input name="user" placeholder="账号"><input name="password" type="password" placeholder="密码"><button>登录</button></form></body></html>`;
    const html = loadTemplate(loginFile, fallback)
      .replaceAll('{{ERROR}}', escapeHtml(error))
      .replaceAll('{{NOTICE}}', escapeHtml(notice));
    res.writeHead(status, PAGE_HEADERS);
    res.end(html);
  }

  const NOT_CONFIGURED = '后台未初始化：服务器上没有任何启用中的管理员账号。请在 relay.env 设置 ADMIN_USER / ADMIN_PASSWORD 后重启服务（仅首次启动用于创建引导管理员，之后以 data/accounts.json 为准）。';

  /** 解析当前请求的登录态；返回当前账号（每次请求都回查账号文件内存态，禁用/降级即时生效） */
  function currentAccount(req) {
    const rec = sessions.get(getCookie(req, ADMIN_COOKIE));
    if (!rec) return null;
    const account = accounts.getById(rec.accountId);
    if (!account || account.disabled) return null;
    return account;
  }

  /** 写操作前的服务端校验：必须是启用中的管理员 + 自定义请求头（CSRF） */
  function requireWrite(req, res, account, confirm) {
    if (!account) {
      sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
      return false;
    }
    if (account.role !== 'admin') {
      sendJson(res, 403, { ok: false, error: '游客账号只能查看看板，不能执行修改操作' });
      return false;
    }
    if (String(req.headers['x-admin-action'] || '') !== '1') {
      sendJson(res, 400, { ok: false, error: '缺少操作校验头' });
      return false;
    }
    if (confirm && String(req.headers['x-admin-confirm'] || '') !== confirm) {
      sendJson(res, 400, { ok: false, error: '缺少二次确认' });
      return false;
    }
    return true;
  }

  function userView(account) {
    return { id: account.id, username: account.username, role: account.role };
  }

  const handler = async function handleAdminHttp(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }
    if (!pathname.startsWith('/admin')) return false;

    const token = getCookie(req, ADMIN_COOKIE);
    const configured = accounts.configured;
    const account = configured ? currentAccount(req) : null;
    const authed = !!account;

    // ---------------- 登录 / 退出 / 页面 ----------------

    if (pathname === '/admin/login' && req.method === 'POST') {
      if (!configured) {
        renderLogin(res, { status: 503, error: '后台不可用', notice: NOT_CONFIGURED });
        return true;
      }
      let body = '';
      try {
        body = await readBody(req, LOGIN_BODY_LIMIT);
      } catch (err) {
        const tooLarge = err.status === 413;
        renderLogin(res, {
          status: tooLarge ? 413 : 400,
          error: tooLarge ? '请求体过大' : '读取表单失败',
        });
        return true;
      }
      const form = new URLSearchParams(body);
      const user = (form.get('user') ?? '').trim();
      const password = form.get('password') ?? '';
      const throttleKey = user.toLowerCase() || '∅';
      const gate = throttle.check(throttleKey);
      if (gate.locked) {
        const mins = Math.max(1, Math.ceil(gate.retryAfterMs / 60000));
        renderLogin(res, {
          status: 429,
          error: '尝试次数过多，该账号已临时锁定',
          notice: `请 ${mins} 分钟后再试。`,
        });
        return true;
      }
      const result = await accounts.verify(user, password);
      if (!result.ok) {
        throttle.fail(throttleKey);
        // 不打印账号 / 密码 / IP：隐私政策承诺 IP 只留在内存里用于限流
        console.warn('[admin] 后台登录失败');
        renderLogin(res, { status: 401, error: '账号或密码错误' });
        return true;
      }
      throttle.reset(throttleKey);
      const newToken = sessions.create(result.account);
      console.log(`[admin] 后台登录成功（角色 ${result.account.role}）`);
      redirect(res, '/admin', {
        'Set-Cookie': `${ADMIN_COOKIE}=${newToken}; ${cookieAttrs(req)}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      });
      return true;
    }

    if (pathname === '/admin/logout' && req.method === 'POST') {
      sessions.destroy(token);
      redirect(res, '/admin/login', {
        'Set-Cookie': `${ADMIN_COOKIE}=; ${cookieAttrs(req)}; Max-Age=0`,
      });
      return true;
    }

    if (pathname === '/admin/login') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, '只支持 GET / POST', { Allow: 'GET, HEAD, POST' });
        return true;
      }
      if (authed) {
        redirect(res, '/admin');
        return true;
      }
      renderLogin(res, { notice: configured ? '' : NOT_CONFIGURED });
      return true;
    }

    if (pathname === '/admin' || pathname === '/admin/') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, '只支持 GET', { Allow: 'GET, HEAD' });
        return true;
      }
      if (!configured) {
        renderLogin(res, { notice: NOT_CONFIGURED });
        return true;
      }
      if (!authed) {
        redirect(res, '/admin/login');
        return true;
      }
      const html = loadTemplate(adminFile, '<!doctype html><meta charset="utf-8"><title>运维统计</title><p>看板页面缺失，请重新部署 public/admin.html</p>');
      res.writeHead(200, PAGE_HEADERS);
      res.end(html);
      return true;
    }

    // ---------------- 只读接口（两种角色都可） ----------------

    if (pathname === '/admin/api/me') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '方法不支持' }, { Allow: 'GET' });
        return true;
      }
      if (!authed) {
        sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
        return true;
      }
      sendJson(res, 200, { ok: true, user: userView(account), now: Date.now() });
      return true;
    }

    if (pathname === '/admin/api/stats') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '方法不支持' }, { Allow: 'GET' });
        return true;
      }
      if (!authed) {
        sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
        return true;
      }
      const summary = stats.summary(7);
      const t = summary.totals;
      sendJson(res, 200, {
        ok: true,
        now: Date.now(),
        user: userView(account),
        current: {
          rooms: live.rooms(),
          players: live.players(),
          levelStock: live.levelStock(),
        },
        peak: { players: t.peakPlayers, at: t.peakAt || null },
        totals: {
          roomsCreated: t.roomsTotal,
          sessions: t.sessionsTotal,
          matches: t.matchesTotal,
          completions: t.completionsTotal,
          uploads: t.uploadsTotal,
          downloads: t.downloadsTotal,
        },
        last7: summary.last7,
      });
      return true;
    }

    // ---------------- 账号管理（仅管理员） ----------------

    if (pathname === '/admin/api/accounts') {
      if (!authed) {
        sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
        return true;
      }
      if (account.role !== 'admin') {
        sendJson(res, 403, { ok: false, error: '游客账号只能查看看板，不能管理账号' });
        return true;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          accounts: accounts.list(),
          selfId: account.id,
          enabledAdmins: accounts.enabledAdminCount,
        });
        return true;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '方法不支持' }, { Allow: 'GET, POST' });
        return true;
      }
      if (!requireWrite(req, res, account)) return true;
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, err.status || 400, { ok: false, error: err.message });
        return true;
      }
      try {
        const created = await accounts.create({
          username: body.username,
          role: body.role,
          password: body.password,
        });
        console.log(`[admin] 已新建账号（角色 ${created.role}）`);
        sendJson(res, 201, { ok: true, account: created });
      } catch (err) {
        const status = accountErrorStatus(err.code);
        if (status === 500) console.error(`[admin] 新建账号失败：${err.message}`);
        sendJson(res, status, { ok: false, error: err.message });
      }
      return true;
    }

    const accountMatch = pathname.match(ACCOUNT_ID_RE);
    if (accountMatch) {
      if (!requireWrite(req, res, account)) return true;
      const id = accountMatch[1];
      const isPassword = pathname.endsWith('/password');
      if (isPassword) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '方法不支持' }, { Allow: 'POST' });
          return true;
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, err.status || 400, { ok: false, error: err.message });
          return true;
        }
        try {
          await accounts.resetPassword(id, body.password);
          sessions.revokeAccount(id, token);
          console.log('[admin] 已重置账号密码（该账号其他会话已失效）');
          sendJson(res, 200, { ok: true });
        } catch (err) {
          const status = accountErrorStatus(err.code);
          if (status === 500) console.error(`[admin] 重置密码失败：${err.message}`);
          sendJson(res, status, { ok: false, error: err.message });
        }
        return true;
      }
      if (req.method === 'PATCH') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, err.status || 400, { ok: false, error: err.message });
          return true;
        }
        try {
          const updated = accounts.update(id, {
            role: body.role === undefined ? undefined : body.role,
            disabled: body.disabled === undefined ? undefined : body.disabled,
          });
          if (updated.disabled || updated.role !== 'admin') sessions.revokeAccount(id, token);
          console.log(`[admin] 已更新账号（角色 ${updated.role}，${updated.disabled ? '已禁用' : '启用中'}）`);
          sendJson(res, 200, { ok: true, account: updated });
        } catch (err) {
          const status = accountErrorStatus(err.code);
          if (status === 500) console.error(`[admin] 更新账号失败：${err.message}`);
          sendJson(res, status, { ok: false, error: err.message });
        }
        return true;
      }
      if (req.method === 'DELETE') {
        if (!requireWrite(req, res, account, 'DELETE_ACCOUNT')) return true;
        try {
          accounts.remove(id);
          sessions.revokeAccount(id, token);
          console.log('[admin] 已删除账号');
          sendJson(res, 200, { ok: true });
        } catch (err) {
          const status = accountErrorStatus(err.code);
          if (status === 500) console.error(`[admin] 删除账号失败：${err.message}`);
          sendJson(res, status, { ok: false, error: err.message });
        }
        return true;
      }
      sendJson(res, 405, { ok: false, error: '方法不支持' }, { Allow: 'PATCH, DELETE' });
      return true;
    }

    // ---------------- 数据修改（仅管理员） ----------------

    if (pathname === '/admin/api/maintenance/reset-stats') {
      if (!requireWrite(req, res, account, 'RESET_STATS')) return true;
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '方法不支持' }, { Allow: 'POST' });
        return true;
      }
      const ok = stats.reset();
      if (!ok) {
        console.error('[admin] 清零统计落盘失败');
        sendJson(res, 500, { ok: false, error: '统计清零后写入磁盘失败' });
        return true;
      }
      console.log('[admin] 已清零运维统计');
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (pathname === '/admin/api/levels') {
      if (!authed) {
        sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
        return true;
      }
      if (account.role !== 'admin') {
        sendJson(res, 403, { ok: false, error: '游客账号只能查看看板，不能查看或修改地图数据' });
        return true;
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '方法不支持' }, { Allow: 'GET' });
        return true;
      }
      sendJson(res, 200, { ok: true, levels: levels.list(200) });
      return true;
    }

    const levelMatch = pathname.match(LEVEL_CODE_RE);
    if (levelMatch) {
      if (!requireWrite(req, res, account, 'DELETE_LEVEL')) return true;
      if (req.method !== 'DELETE') {
        sendJson(res, 405, { ok: false, error: '方法不支持' }, { Allow: 'DELETE' });
        return true;
      }
      try {
        const removed = levels.remove(levelMatch[1]);
        if (!removed) {
          sendJson(res, 404, { ok: false, error: '分享码不存在或已删除' });
          return true;
        }
        console.log(`[admin] 已删除自制地图 ${levelMatch[1]}`);
        sendJson(res, 200, { ok: true, code: levelMatch[1] });
      } catch (err) {
        console.error(`[admin] 删除自制地图失败：${err.message}`);
        sendJson(res, 500, { ok: false, error: '删除失败，删除后写入磁盘出错' });
      }
      return true;
    }

    sendText(res, 404, 'Not found');
    return true;
  };

  Object.defineProperty(handler, 'configured', { get: () => accounts.configured });
  return handler;
}
