// 运维后台账号存储（角色 / 密码哈希 / 引导管理员）
//
// 安全约定：
//  - 密码只用 crypto.scrypt（每账号独立 salt）落盘，绝不保存明文；
//  - 密码校验走固定长度派生 + timingSafeEqual；账号不存在时也照常派生一次，
//    避免通过响应时间判断用户是否存在；
//  - 账号数据固定写入 DATA_DIR 下的 accounts.json（先写 .tmp 再 rename 原子替换）；
//  - relay.env 的 ADMIN_USER / ADMIN_PASSWORD 只在“还没有任何账号”时用于创建引导管理员，
//    之后一律以 accounts.json 为准，升级后不会因为旧配置与新账号体系不一致而进不去；
//  - 不允许删除 / 禁用 / 降级最后一个启用中的管理员。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveBootstrapCredentials } from './admin.mjs';

export const ACCOUNTS_FILE = 'accounts.json';
export const ROLE_ADMIN = 'admin';
export const ROLE_VIEWER = 'viewer';
export const ROLES = [ROLE_ADMIN, ROLE_VIEWER];
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_USERNAME_LENGTH = 32;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const SALT_BYTES = 16;
const KEY_LEN = 64;
const KDF = 'scrypt';
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
/** 账号不存在时也派生一次，保证耗时与真实账号接近 */
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0x5a);
const DUMMY_HASH = Buffer.alloc(KEY_LEN, 0);

export class AccountError extends Error {
  /** @param {'INVALID_USERNAME'|'INVALID_PASSWORD'|'INVALID_ROLE'|'DUPLICATE'|'NOT_FOUND'|'LAST_ADMIN'|'STORE_FAILED'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password ?? ''), salt, KEY_LEN, SCRYPT_OPTS, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function deriveSync(password, salt) {
  return crypto.scryptSync(String(password ?? ''), salt, KEY_LEN, SCRYPT_OPTS);
}

function newSalt() {
  return crypto.randomBytes(SALT_BYTES);
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function normalizeUsername(value) {
  return String(value ?? '').trim();
}

// 尽量兼容旧版 relay.env 里可能出现的用户名（允许中文、空格、符号），
// 只拒绝空串、超长与控制字符，避免升级时因为校验过严而进不去。
function assertUsername(username) {
  if (!username || username.length > MAX_USERNAME_LENGTH || CONTROL_CHARS_RE.test(username)) {
    throw new AccountError('INVALID_USERNAME', `用户名需 1–${MAX_USERNAME_LENGTH} 位，且不能包含控制字符`);
  }
}

function assertPassword(password) {
  const s = String(password ?? '');
  if (s.length < MIN_PASSWORD_LENGTH || s.length > MAX_PASSWORD_LENGTH) {
    throw new AccountError('INVALID_PASSWORD', `密码长度需 ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} 位`);
  }
}

function assertRole(role) {
  if (!ROLES.includes(role)) throw new AccountError('INVALID_ROLE', '角色只能是 admin 或 viewer');
}

function publicView(account) {
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    disabled: !!account.disabled,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    passwordUpdatedAt: account.passwordUpdatedAt,
  };
}

export class AccountStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir 数据目录（DATA_DIR）
   * @param {string} [opts.envFile] relay.env 路径（仅用于首次引导管理员）
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ dir, envFile, log = () => {} }) {
    this.dir = dir;
    this.file = path.join(dir, ACCOUNTS_FILE);
    this.log = log;
    this.accounts = [];
    this.loaded = this.load();
    this.bootstrapped = false;
    if (this.accounts.length === 0) this.bootstrap(envFile);
  }

  get size() {
    return this.accounts.length;
  }

  get enabledAdminCount() {
    return this.accounts.filter(a => a.role === ROLE_ADMIN && !a.disabled).length;
  }

  /** 没有任何启用中的管理员 → 后台拒绝访问（未配置引导管理员时也会走到这里） */
  get configured() {
    return this.enabledAdminCount > 0;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(raw?.accounts) ? raw.accounts : [];
      const loaded = [];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.id !== 'string' || typeof item.username !== 'string') continue;
        if (!ROLES.includes(item.role)) continue;
        if (typeof item.salt !== 'string' || typeof item.hash !== 'string') continue;
        loaded.push({
          id: item.id,
          username: item.username,
          role: item.role,
          disabled: !!item.disabled,
          salt: item.salt,
          hash: item.hash,
          createdAt: Number(item.createdAt) || Date.now(),
          updatedAt: Number(item.updatedAt) || Date.now(),
          passwordUpdatedAt: Number(item.passwordUpdatedAt) || Number(item.createdAt) || Date.now(),
        });
      }
      this.accounts = loaded;
      return true;
    } catch {
      // 文件不存在或损坏：从空账号开始，随后尝试用 relay.env 引导管理员
      this.accounts = [];
      return false;
    }
  }

  /** 首次启动：没有任何账号时用 relay.env 的 ADMIN_USER / ADMIN_PASSWORD 建引导管理员 */
  bootstrap(envFile) {
    let creds;
    try {
      creds = resolveBootstrapCredentials(envFile);
    } catch {
      return;
    }
    if (!creds.user || !creds.password) {
      this.log('未配置引导管理员（ADMIN_USER / ADMIN_PASSWORD），后台将拒绝访问');
      return;
    }
    try {
      // 引导账号沿用旧版 relay.env：不强制新版最小长度，避免旧密码过短导致升级后进不去
      const username = normalizeUsername(creds.user);
      assertUsername(username);
      const salt = newSalt();
      const hash = deriveSync(creds.password, salt);
      const now = Date.now();
      const account = {
        id: newId(),
        username,
        role: ROLE_ADMIN,
        disabled: false,
        salt: salt.toString('hex'),
        hash: hash.toString('hex'),
        createdAt: now,
        updatedAt: now,
        passwordUpdatedAt: now,
      };
      this.accounts.push(account);
      if (!this.flush()) {
        this.accounts = this.accounts.filter(a => a.id !== account.id);
        this.log('引导管理员写入磁盘失败，后台将拒绝访问');
        return;
      }
      this.bootstrapped = true;
      this.log('已使用 relay.env 创建引导管理员（仅首次启动；之后以 accounts.json 为准）');
    } catch (err) {
      this.log(`引导管理员创建失败（${err.code || 'ERROR'}），后台将拒绝访问`);
    }
  }

  list() {
    return [...this.accounts]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicView);
  }

  getById(id) {
    return this.accounts.find(a => a.id === id) ?? null;
  }

  findByUsername(username) {
    const name = normalizeUsername(username);
    if (!name) return null;
    const lower = name.toLowerCase();
    return this.accounts.find(a => a.username.toLowerCase() === lower) ?? null;
  }

  /**
   * 校验账号密码。禁用账号同样返回失败（不向调用方区分原因）。
   * @returns {Promise<{ok: boolean, account?: object}>}
   */
  async verify(username, password) {
    const account = this.findByUsername(username);
    const salt = account ? Buffer.from(account.salt, 'hex') : DUMMY_SALT;
    let derived;
    try {
      derived = await derive(String(password ?? ''), salt);
    } catch {
      return { ok: false };
    }
    const expected = account ? Buffer.from(account.hash, 'hex') : DUMMY_HASH;
    const pass = derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
    if (!account || !pass || account.disabled) return { ok: false };
    return { ok: true, account };
  }

  async create({ username, role, password }) {
    const name = normalizeUsername(username);
    assertUsername(name);
    assertRole(role);
    assertPassword(password);
    if (this.findByUsername(name)) {
      throw new AccountError('DUPLICATE', '该用户名已存在');
    }
    const salt = newSalt();
    const hash = await derive(password, salt);
    const now = Date.now();
    const account = {
      id: newId(),
      username: name,
      role,
      disabled: false,
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      createdAt: now,
      updatedAt: now,
      passwordUpdatedAt: now,
    };
    this.accounts.push(account);
    if (!this.flush()) {
      this.accounts = this.accounts.filter(a => a.id !== account.id);
      throw new AccountError('STORE_FAILED', '账号写入磁盘失败');
    }
    return publicView(account);
  }

  /** 修改角色 / 禁用状态（一次计算两处变更后的结果，避免分步改到“零管理员”） */
  update(id, { role, disabled } = {}) {
    const account = this.getById(id);
    if (!account) throw new AccountError('NOT_FOUND', '账号不存在');
    if (role !== undefined) assertRole(role);
    const nextRole = role === undefined ? account.role : role;
    const nextDisabled = disabled === undefined ? account.disabled : !!disabled;
    if (account.role === ROLE_ADMIN && !account.disabled
      && (nextRole !== ROLE_ADMIN || nextDisabled)
      && this.enabledAdminCount === 1) {
      throw new AccountError('LAST_ADMIN', '不能删除、禁用或降级最后一个启用中的管理员');
    }
    const prev = { role: account.role, disabled: account.disabled, updatedAt: account.updatedAt };
    account.role = nextRole;
    account.disabled = nextDisabled;
    account.updatedAt = Date.now();
    if (!this.flush()) {
      Object.assign(account, prev);
      throw new AccountError('STORE_FAILED', '账号写入磁盘失败');
    }
    return publicView(account);
  }

  async resetPassword(id, password) {
    const account = this.getById(id);
    if (!account) throw new AccountError('NOT_FOUND', '账号不存在');
    assertPassword(password);
    const salt = newSalt();
    const hash = await derive(password, salt);
    const now = Date.now();
    const prev = {
      salt: account.salt, hash: account.hash,
      updatedAt: account.updatedAt, passwordUpdatedAt: account.passwordUpdatedAt,
    };
    account.salt = salt.toString('hex');
    account.hash = hash.toString('hex');
    account.updatedAt = now;
    account.passwordUpdatedAt = now;
    if (!this.flush()) {
      Object.assign(account, prev);
      throw new AccountError('STORE_FAILED', '账号写入磁盘失败');
    }
    return publicView(account);
  }

  remove(id) {
    const account = this.getById(id);
    if (!account) throw new AccountError('NOT_FOUND', '账号不存在');
    if (account.role === ROLE_ADMIN && !account.disabled && this.enabledAdminCount === 1) {
      throw new AccountError('LAST_ADMIN', '不能删除最后一个启用中的管理员');
    }
    this.accounts = this.accounts.filter(a => a.id !== id);
    if (!this.flush()) {
      this.accounts.push(account);
      throw new AccountError('STORE_FAILED', '账号写入磁盘失败');
    }
    return publicView(account);
  }

  /** 原子落盘：tmp + rename */
  flush() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const payload = JSON.stringify({
        v: 1,
        updatedAt: Date.now(),
        accounts: this.accounts.map(a => ({
          id: a.id,
          username: a.username,
          role: a.role,
          disabled: !!a.disabled,
          kdf: KDF,
          salt: a.salt,
          hash: a.hash,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
          passwordUpdatedAt: a.passwordUpdatedAt,
        })),
      });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      console.error(`[admin] 账号落盘失败：${err.message}`);
      return false;
    }
  }
}
