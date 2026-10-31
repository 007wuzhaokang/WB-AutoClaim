#!/usr/bin/env node
/**
 * WB AutoClaim — 本地免打扰签到服务
 * 零依赖 · 数据全部落在 D:\WB-AutoClaim\data
 *
 *  启动： node server.js  （或双击 start.bat）
 *  面板： http://127.0.0.1:8788
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');
const { URL } = require('node:url');
const { createGateway, DEFAULT_MODELS } = require('./gateway');
const browserLogin = require('./browser-login');
/* SEA（单文件 exe）下内置 node:sea；普通 node 运行时 require 会抛错，这里兜底为 null */
const sea = (() => { try { return require('node:sea'); } catch { return null; } })();

/* ────────────────────────── 路径与常量 ────────────────────────── */
/* 打包成 exe 后，数据目录必须落在 exe 旁边（可写）；静态资源随包内置 */
const isPkg = (typeof process.pkg !== 'undefined');
const EXE_DIR = isPkg ? path.dirname(process.execPath) : __dirname;
const PUBLIC_DIR = path.join(__dirname, 'public');      // 开发态与打包态都在包内
const DATA_DIR = path.join(EXE_DIR, 'data');            // 始终落在 exe 同目录，持久可写
const VAULT = path.join(DATA_DIR, 'vault.enc');
const KEYFILE = path.join(DATA_DIR, 'vault.key');
const LOGFILE = path.join(DATA_DIR, 'runs.jsonl');
const CONFIG = path.join(DATA_DIR, 'config.json');
const STARTED_AT = Date.now();

/* 内置前端资源（打包时由 gen-inline.cjs 生成）：exe 单文件下磁盘无 public 目录，从此读取 */
let INLINE_ASSETS = {};
try { INLINE_ASSETS = require('./inline-assets.cjs') || {}; } catch { INLINE_ASSETS = {}; }

/* 读取前端静态资源：优先磁盘（开发态）→ SEA blob → 内置字符串（exe 单文件） */
function readPublic(rel) {
  const key = String(rel).replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, key);
  if (fs.existsSync(full) && fs.statSync(full).isFile()) return fs.readFileSync(full);
  if (sea && process.isBundled === true) {
    try { const b = sea.getAsset('public/' + key); if (b) return b; } catch {}
  }
  if (INLINE_ASSETS[key]) return Buffer.from(INLINE_ASSETS[key], 'base64');
  return null;
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  endpoint: 'https://www.workbuddy.cn',
  claimTime: '00:05',
  jitterMinutes: 14,
  autoRefresh: true,
  maxRetry: 3,
  retryDelaySec: 45,
  catchUp: true,
  port: 8788,
  notifyFail: true,
  /* 统一网关：多账号聚合成一个虚拟主账号 */
  gatewayEnabled: true,
  gatewayPort: 8789,
  gatewayKey: '',
  defaultModel: 'glm-5.3',
};

/* ────────────────────────── 极简日志 ────────────────────────── */
const ring = [];
const sseClients = new Set();

function emit(level, text, meta) {
  const item = {
    id: crypto.randomUUID(),
    t: Date.now(),
    level,
    text,
    meta: meta || null,
  };
  ring.push(item);
  if (ring.length > 800) ring.shift();
  const payload = `data: ${JSON.stringify(item)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
  if (level === 'run' || level === 'error') {
    try { fs.appendFileSync(LOGFILE, JSON.stringify(item) + '\n'); } catch {}
  }
  const tag = { info: '  ·', run: '  ▶', ok: '  ✓', warn: '  !', error: '  ✕' }[level] || '  ·';
  process.stdout.write(`${tag} ${text}\n`);
}

/* ────────────────────────── 加密存储 ────────────────────────── */
function loadKey() {
  if (!fs.existsSync(KEYFILE)) {
    const k = crypto.randomBytes(32);
    fs.writeFileSync(KEYFILE, k.toString('hex'), { mode: 0o600 });
    return k;
  }
  return Buffer.from(fs.readFileSync(KEYFILE, 'utf8').trim(), 'hex');
}
const KEY = loadKey();

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function open(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
}

let state = { settings: { ...DEFAULT_SETTINGS }, accounts: [] };

function loadState() {
  try {
    if (fs.existsSync(VAULT)) {
      const raw = open(fs.readFileSync(VAULT));
      state.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
      state.accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
    }
  } catch (e) {
    emit('error', `存储解密失败：${e.message}（已启用空白配置）`);
  }
  if (fs.existsSync(CONFIG)) {
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
      state.settings = { ...state.settings, ...c };
    } catch {}
  }
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(VAULT, seal(state));
      fs.writeFileSync(CONFIG, JSON.stringify(state.settings, null, 2));
    } catch (e) {
      emit('error', `保存失败：${e.message}`);
    }
  }, 120);
}

/* ────────────────────────── 账号工具 ────────────────────────── */
function maskToken(t) {
  if (!t) return '';
  if (t.length <= 14) return t.slice(0, 4) + '••••';
  return `${t.slice(0, 8)}••••••${t.slice(-6)}`;
}

function publicAccount(a) {
  const h = a.history || [];
  const today = todayKey();
  const last = h[h.length - 1] || null;
  const todayRun = h.find((x) => x.day === today);
  return {
    id: a.id,
    name: a.name,
    uid: a.uid || '',
    enterpriseId: a.enterpriseId || '',
    enabled: a.enabled !== false,
    note: a.note || '',
    tokenMasked: maskToken(a.accessToken),
    hasRefresh: !!a.refreshToken,
    hasDevice: !!a.deviceToken,
    hasCookie: !!a.cookie,
    createdAt: a.createdAt,
    lastRun: a.lastRun || null,
    today: todayRun || null,
    streak: a.streak || 0,
    totalCredit: a.totalCredit || 0,
    history: h.slice(-14),
    guessedExp: a.tokenExp ? a.tokenExp : null,
    expiringSoon: !!a.tokenExp && a.tokenExp - Date.now() < 36e5 * 6,
  };
}

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ────────────────────────── HTTP 调用 ────────────────────────── */
function baseHeaders(acc, extra = {}) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    Origin: 'https://www.workbuddy.cn',
    Referer: 'https://www.workbuddy.cn/',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (acc.authMode === 'cookie' && acc.cookie) {
    /* 网页登录（手机号）拿到的账号走 Cookie 鉴权：
       网关把会话与 User-Agent 绑定校验，UA 必须与登录时浏览器完全一致；
       同时带上 Bearer 反而会让网关按令牌校验而 401，所以这里刻意不发
       Authorization / X-User-Id。 */
    h.Cookie = acc.cookie;
    if (acc.userAgent) h['User-Agent'] = acc.userAgent;
  } else {
    if (acc.accessToken) h.Authorization = `Bearer ${acc.accessToken}`;
    if (acc.uid) h['X-User-Id'] = acc.uid;
    if (acc.cookie) h.Cookie = acc.cookie;
  }
  if (acc.enterpriseId) {
    h['X-Enterprise-Id'] = acc.enterpriseId;
    h['X-Tenant-Id'] = acc.enterpriseId;
  }
  if (acc.deviceToken) h['X-Device-Token'] = acc.deviceToken;
  return { ...h, ...extra };
}

async function apiCall(acc, method, pathname, body, extraHeaders) {
  const endpoint = acc.endpoint || state.settings.endpoint;
  const url = `${endpoint.replace(/\/+$/, '')}${pathname}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, {
      method,
      headers: baseHeaders(acc, extraHeaders),
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/* ── 用 accessToken 反查账号信息（补 uid）── */
async function fetchAccountByToken(token, endpoint) {
  const base = String(endpoint || 'https://www.workbuddy.cn').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/console/accounts`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const j = await res.json().catch(() => null);
    const raw = j?.data?.accounts ?? j?.accounts ?? j?.data ?? [];
    const list = Array.isArray(raw) ? raw : [];
    const pick = list.find((a) => String(a.type || '') === 'personal') || list[0];
    if (!pick) return null;
    return {
      uid: String(pick.uid || pick.id || pick.userId || '').trim(),
      nickname: pick.nickname || pick.name || '',
      phone: pick.phoneNumber || pick.phone_number || '',
      enterpriseId: String(pick.enterpriseId || pick.enterprise_id || '').trim(),
      type: String(pick.type || ''),
    };
  } catch {
    return null;
  }
}


/* ── 统一网关生命周期 ── */
let GW = null;

function buildGateway() {
  return createGateway({
    getAccounts: () => state.accounts,
    refreshToken: (acc) => refreshToken(acc),
    emit,
    port: Number(state.settings.gatewayPort) || 8789,
    host: '127.0.0.1',
    requireKey: state.settings.gatewayKey || '',
    defaultModel: state.settings.defaultModel || 'glm-5.3',
  });
}

async function startGateway() {
  if (state.settings.gatewayEnabled === false) return false;
  if (GW && GW.server && GW.server.listening) return true;
  GW = buildGateway();
  try {
    await GW.start();
    emit('info', `统一网关已启动 · http://127.0.0.1:${Number(state.settings.gatewayPort) || 8789}/v1`);
    return true;
  } catch (e) {
    GW = null;
    emit('error', `统一网关启动失败：${e.message}`);
    return false;
  }
}

async function stopGateway() {
  if (!GW) return true;
  try { await GW.stop(); } catch {}
  GW = null;
  return true;
}

/* ── 令牌刷新 ── */
async function refreshToken(acc) {
  if (!acc.refreshToken) return { ok: false, reason: '无 refreshToken' };
  const endpoint = (acc.endpoint || state.settings.endpoint).replace(/\/+$/, '');
  // 客户端存在两种路径：/v2/plugin/auth/token/refresh（新版）与 /v2/auth/token/refresh（旧版）
  const paths = ['/v2/plugin/auth/token/refresh', '/v2/auth/token/refresh'];
  let lastErr = '无新令牌';
  try {
    for (const p of paths) {
      const res = await fetch(endpoint + p, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Refresh-Token': acc.refreshToken,
          'X-Auth-Refresh-Source': 'plugin',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36',
        },
        body: '{}',
      });
      const json = await res.json().catch(() => null);
      const d = json?.data || json;
      const token = d?.accessToken || d?.access_token || d?.token;
      if (!token) { lastErr = `HTTP ${res.status} ${(json && (json.msg || json.message)) || '无新令牌'}`; continue; }
      acc.accessToken = token;
      if (d.refreshToken || d.refresh_token) acc.refreshToken = d.refreshToken || d.refresh_token;
      if (d.expiresIn) acc.tokenExp = Date.now() + Number(d.expiresIn) * 1000;
      else if (d.expiresAt) acc.tokenExp = Number(d.expiresAt);
      saveState();
      return { ok: true };
    }
    return { ok: false, reason: lastErr };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/* ────────────────────────── 签到核心 ────────────────────────── */
function looksClaimed(payload) {  if (!payload) return false;
  const flat = JSON.stringify(payload).toLowerCase();
  if (/(already|claimed|repeat|duplicate)/.test(flat)) return true;
  if (/已(经)?(签到|领取|签过)/.test(flat)) return true;
  const flagKeys = ['claimed', 'isClaimed', 'is_claimed', 'checkedIn', 'checked_in', 'todayClaimed', 'claimedToday', 'claim_eligible'];
  for (const k of flagKeys) {
    if (k in payload) {
      const v = payload[k];
      if (k === 'claim_eligible') { if (v === false) return true; }
      else if (v === true) return true;
    }
  }
  return false;
}

function pickCredit(payload) {
  if (!payload) return 0;
  const keys = ['credit', 'credits', 'amount', 'reward', 'points', 'earned_credit', 'daily_credit'];
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'number' && v > 0) return v;
  }
  return 0;
}

async function claimOne(acc, opts = {}) {
  const tag = `[${acc.name}]`;
  const result = {
    ok: false,
    credit: 0,
    status: 'fail',
    message: '',
    checkedIn: false,
  };

  // 0) 令牌预刷新
  if (state.settings.autoRefresh && acc.refreshToken && (!acc.accessToken || (acc.tokenExp && acc.tokenExp - Date.now() < 6 * 36e5))) {
    const r = await refreshToken(acc);
    emit(r.ok ? 'info' : 'warn', `${tag} 令牌刷新${r.ok ? '成功' : `跳过（${r.reason}）`}`);
  }

  // 1) 查状态
  let st;
  try {
    st = await apiCall(acc, 'POST', '/v2/billing/meter/checkin-status', {});
  } catch (e) {
    result.message = `状态接口不可达：${e.message}`;
    emit('error', `${tag} ${result.message}`);
    return finish(acc, result);
  }

  if (st.status === 401) {
    if (acc.refreshToken) {
      const r = await refreshToken(acc);
      if (r.ok) {
        st = await apiCall(acc, 'POST', '/v2/billing/meter/checkin-status', {}).catch((e) => ({ status: 0, text: e.message }));
      }
    }
    if (st.status === 401) {
      result.status = 'auth';
      const gateway = /^\s*</.test(String(st.text || ''));
      result.message = acc.authMode === 'cookie'
        ? '登录态已过期（Cookie 失效），请点「打开登录窗口」重新登录一次'
        : gateway
          ? '鉴权被网关拦截（HTTP 401）：令牌已过期或缺少 Cookie。请重新 Copy as cURL 粘贴完整请求'
          : '登录态失效，需要重新授权（粘贴新的 cURL / Token）';
      emit('error', `${tag} ${result.message}`);
      return finish(acc, result);
    }
  }

  if (st.status !== 200 || !st.json) {
    result.message = `状态接口返回异常 HTTP ${st.status} ${(st.text || '').slice(0, 160)}`;
    emit('error', `${tag} ${result.message}`);
    return finish(acc, result);
  }

  const statusData = st.json.data || st.json;
  if (st.json.code !== 0) {
    result.message = `状态接口 code=${st.json.code} ${st.json.msg || ''}`;
    emit('warn', `${tag} ${result.message}`);
  }

  if (looksClaimed(statusData)) {
    result.ok = true;
    result.status = 'already';
    result.checkedIn = true;
    result.credit = pickCredit(statusData);
    result.message = `今日已领取${result.credit ? ` · ${result.credit} 积分` : ''}`;
    emit('info', `${tag} ${result.message}`);
    return finish(acc, result);
  }

  // 2) 执行领取
  let cl;
  try {
    cl = await apiCall(acc, 'POST', '/v2/billing/meter/daily-checkin', {});
  } catch (e) {
    result.message = `领取接口不可达：${e.message}`;
    emit('error', `${tag} ${result.message}`);
    return finish(acc, result);
  }

  if (cl.status === 401) {
    result.status = 'auth';
    result.message = '领取时鉴权失败（401），需重新授权';
    emit('error', `${tag} ${result.message}`);
    return finish(acc, result);
  }

  const body = cl.json || {};
  const data = body.data || body;
  if (body.code === 0) {
    result.ok = true;
    result.status = 'claimed';
    result.checkedIn = true;
    result.credit = pickCredit(data) || pickCredit(statusData) || 0;
    const streak = data.streak_days ?? data.streakDays ?? statusData.streak_days ?? null;
    result.message = `领取成功${result.credit ? ` +${result.credit}` : ''}${streak ? ` · 连签 ${streak} 天` : ''}`;
    if (streak) acc.streak = Number(streak);
    emit('ok', `${tag} ${result.message}`);
  } else if (looksClaimed(data) || /已(经)?(签到|领取)/.test(String(body.msg || ''))) {
    result.ok = true;
    result.status = 'already';
    result.checkedIn = true;
    result.message = `今日已领取${body.msg ? `（${body.msg}）` : ''}`;
    emit('info', `${tag} ${result.message}`);
  } else {
    result.message = `领取失败 code=${body.code} ${body.msg || (cl.text || '').slice(0, 140)}`;
    emit('error', `${tag} ${result.message}`);
  }
  return finish(acc, result);
}

function finish(acc, result) {
  const now = new Date();
  acc.lastRun = { at: Date.now(), ok: result.ok, status: result.status, message: result.message, credit: result.credit };
  if (result.checkedIn) {
    acc.history = Array.isArray(acc.history) ? acc.history : [];
    const day = todayKey(now);
    const exists = acc.history.find((x) => x.day === day);
    if (!exists) {
      acc.history.push({ day, at: Date.now(), credit: result.credit, status: result.status, message: result.message });
      if (acc.history.length > 90) acc.history = acc.history.slice(-90);
      acc.totalCredit = (acc.totalCredit || 0) + result.credit;
    }
  }
  saveState();
  return result;
}

/* ────────────────────────── 调度器 ────────────────────────── */
let running = false;
const scheduledFor = { day: null, done: false, plannedAt: 0 };

function planToday() {
  const [h, m] = String(state.settings.claimTime || '00:05').split(':').map(Number);
  const now = new Date();
  const at = new Date(now);
  at.setHours(h || 0, m || 0, 0, 0);
  const jitter = Math.floor(Math.random() * (state.settings.jitterMinutes || 0)) * 60000;
  return at.getTime() + jitter;
}

function schedulerTick() {
  const day = todayKey();
  if (scheduledFor.day !== day) {
    scheduledFor.day = day;
    scheduledFor.done = false;
    scheduledFor.plannedAt = planToday();
  }
  if (scheduledFor.done || running) return;
  const now = Date.now();
  const overdue = now > scheduledFor.plannedAt + 6 * 36e5; // 超过 6 小时视为跨天
  if (now >= scheduledFor.plannedAt && !overdue) {
    scheduledFor.done = true;
    runAll('定时自动签到');
  } else if (overdue && state.settings.catchUp) {
    scheduledFor.done = true;
    scheduledFor.plannedAt = planToday();
  }
}

async function runAll(reason, onlyId) {
  if (running) return { skipped: true };
  running = true;
  const list = state.accounts.filter((a) => a.enabled !== false && (!onlyId || a.id === onlyId));
  emit('run', `开始${reason} · 共 ${list.length} 个账号`);
  const summary = { total: list.length, ok: 0, already: 0, fail: 0, credit: 0 };
  for (const acc of list) {
    let attempt = 0;
    let r = null;
    while (attempt < Math.max(1, state.settings.maxRetry)) {
      attempt++;
      r = await claimOne(acc);
      if (r.ok) break;
      if (r.status === 'auth') break;
      if (attempt < state.settings.maxRetry) {
        emit('warn', `[${acc.name}] 第 ${attempt} 次失败，${state.settings.retryDelaySec}s 后重试`);
        await new Promise((res) => setTimeout(res, (state.settings.retryDelaySec || 45) * 1000));
      }
    }
    if (!r) continue;
    if (r.status === 'claimed') { summary.ok++; summary.credit += r.credit || 0; }
    else if (r.status === 'already') summary.already++;
    else summary.fail++;
    await new Promise((res) => setTimeout(res, 900 + Math.random() * 1400));
  }
  emit('run', `本轮结束 · 新领 ${summary.ok} · 已领 ${summary.already} · 失败 ${summary.fail} · 合计 ${summary.credit} 积分`);
  running = false;
  return summary;
}

/* ────────────────────────── 输入解析 ────────────────────────── */
function parseAccountInput(input) {
  const out = { name: '', uid: '', accessToken: '', refreshToken: '', deviceToken: '', enterpriseId: '', cookie: '', endpoint: '' };
  const raw = String(input || '').trim();
  if (!raw) throw new Error('内容为空');

  if (raw.startsWith('{') || raw.startsWith('[')) {
    let j;
    try { j = JSON.parse(raw); } catch { throw new Error('JSON 解析失败'); }
    const o = Array.isArray(j) ? j[0] : j;
    out.accessToken = o.accessToken || o.token || o.access_token || '';
    out.refreshToken = o.refreshToken || o.refresh_token || '';
    out.uid = String(o.uid || o.userId || o.user_id || o['X-User-Id'] || '');
    out.name = o.name || o.email || o.nickname || '';
    out.deviceToken = o.deviceToken || o['X-Device-Token'] || '';
    out.enterpriseId = o.enterpriseId || o['X-Enterprise-Id'] || '';
    out.cookie = o.cookie || '';
    out.endpoint = o.endpoint || '';
    return out;
  }

  if (/curl\s/i.test(raw) || /-H\s*['"]/.test(raw)) {
    const headers = {};
    const re = /-H\s*(['"])([\s\S]*?)\1/g;
    let m;
    while ((m = re.exec(raw))) {
      const line = m[2];
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    const urlMatch = raw.match(/https?:\/\/[^\s'"]+/);
    if (urlMatch) {
      try { out.endpoint = new URL(urlMatch[0]).origin; } catch {}
    }
    const auth = headers.authorization || '';
    out.accessToken = auth.replace(/^bearer\s+/i, '').trim();
    out.uid = headers['x-user-id'] || headers['x-uid'] || '';
    out.deviceToken = headers['x-device-token'] || '';
    out.enterpriseId = headers['x-enterprise-id'] || headers['x-tenant-id'] || '';
    out.cookie = headers.cookie || '';
    out.refreshToken = headers['x-refresh-token'] || '';
    if (!out.accessToken && !out.cookie)
      throw new Error('未在 cURL 中找到 Authorization 或 Cookie，请复制登录后发往 www.workbuddy.cn 的请求');
    return out;
  }

  // 纯 Token / 自定义分隔
  const parts = raw.split(/[\s,|]+/).filter(Boolean);
  out.accessToken = parts[0];
  out.uid = parts[1] || '';
  out.refreshToken = parts[2] || '';
  return out;
}

function isStaticPath(p) { return /\.(js|css|png|jpg|jpeg|svg|woff2?|ttf|map|ico|gif|webp)(\?|$)/i.test(p); }

/* ────────────────────────── HTTP 服务 ────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, max = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch { resolve({ raw: s }); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${state.settings.port}`);
  const p = url.pathname;

  try {
    /* ── SSE ── */
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'hello', level: 'info', t: Date.now(), text: '控制台已连接', meta: null })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    /* ── 状态 ── */
    if (p === '/api/state') {
      const accounts = state.accounts.map(publicAccount);
      const today = todayKey();
      const claimedToday = accounts.filter((a) => a.today && a.today.status !== 'fail' && a.today.status !== 'auth').length;
      return sendJSON(res, 200, {
        settings: state.settings,
        dataDir: DATA_DIR,
        accounts,
        stats: {
          total: accounts.length,
          enabled: accounts.filter((a) => a.enabled).length,
          claimedToday,
          totalCredit: accounts.reduce((s, a) => s + (a.totalCredit || 0), 0),
          todayCredit: accounts.reduce((s, a) => s + (a.today?.credit || 0), 0),
          needAuth: accounts.filter((a) => a.lastRun?.status === 'auth').length,
          uptime: Date.now() - STARTED_AT,
          running,
          nextRunAt: scheduledFor.done ? null : scheduledFor.plannedAt || planToday(),
          todayKey: today,
        },
      });
    }

    /* ── 日志 ── */
    if (p === '/api/logs') {
      const limit = Number(url.searchParams.get('limit') || 200);
      return sendJSON(res, 200, { logs: ring.slice(-limit) });
    }

    /* ── 手机号登录（浏览器代登录，自动抓取凭据）── */
    if (p === '/api/login/start' && req.method === 'POST') {
      try {
        const id = await browserLogin.start({});
        emit('info', '已打开登录窗口，请在浏览器中用手机号 + 验证码登录');
        return sendJSON(res, 200, { ok: true, id, state: 'starting' });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }

    if (p === '/api/login/status') {
      const id = url.searchParams.get('id');
      const s = browserLogin.getSession(id);
      if (!s) return sendJSON(res, 404, { error: '登录会话不存在或已结束' });
      if (s.state === 'captured' && !s.consumed && s.captured && s.lastProbed !== s.captured) {
        const c = s.captured;
        s.lastProbed = c;
        const token = String(c.auth || '').replace(/^bearer\s+/i, '').trim();
        let uid = String(c.uid || '').trim();
        if (c.source === 'token-poll' && c.rawKeys) emit('info', `登录令牌字段：${c.rawKeys}`);
        // 令牌轮询返回里通常没有 uid，用 token 反查一次账号信息补齐
        if (!uid && token) {
          const got = await fetchAccountByToken(token, 'https://www.workbuddy.cn');
          if (got && got.uid) {
            uid = got.uid;
            if (!c.ent && got.enterpriseId) c.ent = got.enterpriseId;
            if (got.nickname) c.nickname = got.nickname;
          }
        }
        // 判定是否拿到了完整会话（含 HttpOnly 的 Keycloak 鉴权 cookie）
        const cookieStr = String(c.cookie || '');
        const hasJar = /KEYCLOAK_IDENTITY|AUTH_SESSION_ID|(?:^|;\s*)session=/.test(cookieStr);
        // 验证闸门：用真实凭据请求一次状态接口，只有 200 + code 0 才落库
        const probe = {
          accessToken: hasJar ? '' : token,
          authMode: hasJar ? 'cookie' : '',
          cookie: cookieStr,
          userAgent: c.ua || '',
          uid,
          deviceToken: c.device || '',
          enterpriseId: c.ent || '',
          endpoint: 'https://www.workbuddy.cn',
        };
        let probeRes;
        try { probeRes = await apiCall(probe, 'POST', '/v2/billing/meter/checkin-status', {}); }
        catch (e) { probeRes = { status: 0, text: e.message }; }

        const probedOk = probeRes.status === 200 && probeRes.json && probeRes.json.code === 0;
        if (!probedOk) {
          if (c.fp && s.rejected) s.rejected.add(c.fp);
          s.probeFails = (s.probeFails || 0) + 1;
          s.captured = null;
          s.state = 'waiting';
          if (probeRes.status === 401 && !hasJar) {
            s.message = '拿到的会话缺少 HttpOnly 鉴权 Cookie，正在重新获取…';
          } else if (probeRes.status === 401) {
            s.message = '会话已过期或被网关拒绝，请重新点「打开登录窗口」再登录一次';
          } else {
            s.message = `已获取会话，鉴权未通过（HTTP ${probeRes.status}），继续等待…`;
          }
          if (s.probeFails === 3) emit('warn', `登录鉴权连续失败：${s.message}`);
          if (s.probeFails >= 6) {
            s.state = 'error';
            s.message = '已多次拿不到有效会话（网关 401）。请点「取消」后重新打开登录窗口，用手机号重新登录一次';
            emit('error', s.message);
          }
        } else {
          s.consumed = true;
          try {
            let target = state.accounts.find((a) => a.uid && uid && a.uid === uid)
              || (hasJar && state.accounts.find((a) => a.cookie === cookieStr))
              || (token ? state.accounts.find((a) => a.accessToken === token) : null);
            const label = c.nickname || (uid ? `手机号账号 ${uid.slice(-4)}` : `手机号账号 ${state.accounts.length + 1}`);
            if (!target) {
              target = {
                id: crypto.randomUUID(),
                name: label,
                uid, accessToken: token, refreshToken: c.refresh || '',
                deviceToken: c.device || '', enterpriseId: c.ent || '',
                cookie: cookieStr, userAgent: c.ua || '',
                authMode: hasJar ? 'cookie' : '',
                endpoint: 'https://www.workbuddy.cn',
                note: '手机号登录', enabled: true, createdAt: Date.now(), history: [], streak: 0, totalCredit: 0,
              };
              state.accounts.push(target);
              emit('info', `手机号登录成功，已添加账号「${target.name}」`);
            } else {
              if (token) target.accessToken = token;
              if (cookieStr) target.cookie = cookieStr;
              if (c.ua) target.userAgent = c.ua;
              if (hasJar) target.authMode = 'cookie';
              if (c.refresh) target.refreshToken = c.refresh;
              if (uid) target.uid = uid;
              if (c.ent) target.enterpriseId = c.ent;
              emit('info', `手机号登录成功，已更新账号「${target.name}」`);
            }
            saveState();
            const result = await claimOne(target, {});
            s.state = 'done';
            s.result = { account: publicAccount(target), claim: result };
            s.message = result.ok ? `登录成功，${result.message}` : `登录成功，但领取未成功：${result.message}`;
            setTimeout(() => browserLogin.cancel(id, '登录完成'), 1500);
          } catch (e) {
            s.state = 'error';
            s.message = '添加账号失败：' + e.message;
          }
        }
      }
      return sendJSON(res, 200, { state: s.state, message: s.message, result: s.result || null });
    }

    if (p === '/api/login/cancel' && req.method === 'POST') {
      const body = await readBody(req);
      browserLogin.cancel(String(body.id || ''), '已取消');
      return sendJSON(res, 200, { ok: true });
    }

    /* ── 新增账号 ── */
    if (p === '/api/accounts' && req.method === 'POST') {
      const body = await readBody(req);
      const rawInput = String(body.raw || body.text || '').trim();
      let parsed = {};
      if (rawInput) {
        try { parsed = parseAccountInput(rawInput); }
        catch (e) {
          if (!body.accessToken && !body.uid) return sendJSON(res, 400, { error: e.message });
          parsed = {};
        }
      }
      const acc = {
        id: crypto.randomUUID(),
        name: (body.name || parsed.name || '').trim() || `账号 ${state.accounts.length + 1}`,
        uid: String(body.uid || parsed.uid || '').trim(),
        accessToken: (body.accessToken || parsed.accessToken || '').trim(),
        refreshToken: (body.refreshToken || parsed.refreshToken || '').trim(),
        deviceToken: (body.deviceToken || parsed.deviceToken || '').trim(),
        enterpriseId: (body.enterpriseId || parsed.enterpriseId || '').trim(),
        cookie: (body.cookie || parsed.cookie || '').trim(),
        userAgent: (body.userAgent || parsed.userAgent || '').trim(),
        authMode: (body.authMode || '').trim(),
        endpoint: (body.endpoint || parsed.endpoint || '').trim(),
        note: (body.note || '').trim(),
        enabled: true,
        createdAt: Date.now(),
        history: [],
        streak: 0,
        totalCredit: 0,
      };
      // 只有 Keycloak 完整会话（含 HttpOnly 项）才走 Cookie 鉴权，普通 cookie 片段仍按令牌走
      if (!acc.authMode && acc.cookie && /KEYCLOAK_IDENTITY|AUTH_SESSION_ID|(?:^|;\s*)session=/.test(acc.cookie)) {
        acc.authMode = 'cookie';
      }
      if (!acc.accessToken && !acc.cookie)
        return sendJSON(res, 400, { error: '未能识别到登录凭据（Authorization 或 Cookie）。请确认复制的是登录后、发往 www.workbuddy.cn 的请求。' });
      if (!acc.uid && acc.accessToken)
        return sendJSON(res, 400, { error: '识别到 Bearer 令牌但缺少 X-User-Id，请粘贴同时带 X-User-Id 的请求，或在下方手动补填。' });
      state.accounts.push(acc);
      saveState();
      emit('info', `已添加账号「${acc.name}」`);
      return sendJSON(res, 200, { account: publicAccount(acc) });
    }

    /* ── 修改 / 删除 ── */
    const mAcc = p.match(/^\/api\/accounts\/([\w-]+)$/);
    if (mAcc) {
      const acc = state.accounts.find((a) => a.id === mAcc[1]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const body = await readBody(req);
        for (const k of ['name', 'uid', 'accessToken', 'refreshToken', 'deviceToken', 'enterpriseId', 'cookie', 'userAgent', 'authMode', 'endpoint', 'note']) {
          if (typeof body[k] === 'string' && body[k].trim()) acc[k] = body[k].trim();
        }
        if (typeof body.enabled === 'boolean') acc.enabled = body.enabled;
        saveState();
        return sendJSON(res, 200, { account: publicAccount(acc) });
      }
      if (req.method === 'DELETE') {
        state.accounts = state.accounts.filter((a) => a.id !== acc.id);
        saveState();
        emit('warn', `已删除账号「${acc.name}」`);
        return sendJSON(res, 200, { ok: true });
      }
    }

    /* ── 手动领取 ── */
    const mClaim = p.match(/^\/api\/accounts\/([\w-]+)\/claim$/);
    if (mClaim && req.method === 'POST') {
      const acc = state.accounts.find((a) => a.id === mClaim[1]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      const r = await claimOne(acc);
      return sendJSON(res, 200, { result: r, account: publicAccount(acc) });
    }

    /* ── 统一网关：把多个账号聚合成一个虚拟主账号 ── */
    if (p === '/api/gateway' && req.method === 'GET') {
      const gw = GW;
      return sendJSON(res, 200, {
        enabled: state.settings.gatewayEnabled !== false,
        port: Number(state.settings.gatewayPort) || 8789,
        keyRequired: !!state.settings.gatewayKey,
        defaultModel: state.settings.defaultModel || 'glm-5.3',
        models: DEFAULT_MODELS,
        running: !!(gw && gw.server && gw.server.listening),
        baseUrl: `http://127.0.0.1:${Number(state.settings.gatewayPort) || 8789}/v1`,
        stats: gw ? gw.stats() : null,
        health: gw ? gw.health() : [],
      });
    }

    if (p === '/api/gateway/reset' && req.method === 'POST') {
      if (GW) GW.reset();
      emit('info', '网关健康状态已重置');
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/gateway/restart' && req.method === 'POST') {
      try {
        await stopGateway();
        await startGateway();
        return sendJSON(res, 200, { ok: true, port: Number(state.settings.gatewayPort) || 8789 });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }

    /* ── 积分池：账号上的总积分（额度包剩余合计），不是每日签到的累加 ── */
    if (p === '/api/credits') {
      const rows = await Promise.all(
        state.accounts.map(async (a) => {
          const tr = (a.history || []).find((x) => x.day === todayKey()) || null;
          const row = {
            id: a.id, name: a.name, uid: a.uid || '',
            todayChecked: !!tr,
            todayCredit: (tr && tr.credit) || 0,
            streak: a.streak || 0,
            /* 账号总积分：取额度包（Packages）剩余合计，data.TotalCredits */
            totalCredits: 0,
            plan: '',
            packages: 0,
            ok: false, http: 0, error: '',
          };
          if (!a.accessToken && !a.cookie) { row.error = '无凭据'; return row; }
          try {
            const r = await apiCall(a, 'POST', '/billing/meter/get-user-resource-summary', {});
            row.http = r.status;
            const d = (r.json && r.json.data) || {};
            if (r.status === 200 && r.json && r.json.code === 0 && d.TotalCredits !== undefined) {
              // 接口返回字符串且带浮点尾差（如 "477.49000075"），统一取整
              row.totalCredits = Math.round(Number(d.TotalCredits) || 0);
              row.plan = d.SubscriptionPackageName || '';
              row.packages = (d.Packages || []).length;
              row.ok = true;
            } else if (r.status === 401) {
              row.error = '登录态失效';
            } else {
              row.error = `HTTP ${r.status}`;
            }
          } catch (e) {
            row.error = e.message;
          }
          return row;
        }),
      );
      const sum = (k) => rows.reduce((s, x) => s + (Number(x[k]) || 0), 0);
      return sendJSON(res, 200, {
        rows,
        pool: {
          accounts: rows.length,
          online: rows.filter((x) => x.ok).length,
          todayCredit: sum('todayCredit'),
          totalCredits: sum('totalCredits'),
          claimedToday: rows.filter((x) => x.todayChecked).length,
          avgStreak: rows.length ? Math.round((sum('streak') / rows.length) * 10) / 10 : 0,
          /* 每天可领上限 = 账号数 × 每号日领额度 */
          dailyCapacity: rows.length * 100,
        },
      });
    }

    /* ── 全部领取 ── */
    if (p === '/api/claim-all' && req.method === 'POST') {
      if (running) return sendJSON(res, 409, { error: '正在执行中' });
      const summary = await runAll('手动全量签到');
      return sendJSON(res, 200, { summary });
    }

    /* ── 设置 ── */
    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const next = { ...state.settings };
      for (const k of ['endpoint', 'claimTime', 'jitterMinutes', 'maxRetry', 'retryDelaySec']) {
        if (body[k] !== undefined) next[k] = body[k];
      }
      for (const k of ['autoRefresh', 'catchUp', 'notifyFail']) {
        if (typeof body[k] === 'boolean') next[k] = body[k];
      }
      const prevPort = Number(next.gatewayPort) || 8789;
      for (const k of ['gatewayKey', 'defaultModel']) if (body[k] !== undefined) next[k] = body[k];
      if (typeof body.gatewayEnabled === 'boolean') next.gatewayEnabled = body.gatewayEnabled;
      if (body.gatewayPort !== undefined) next.gatewayPort = Number(body.gatewayPort) || 8789;
      const cfgChanged =
        next.gatewayKey !== state.settings.gatewayKey ||
        next.defaultModel !== state.settings.defaultModel ||
        next.gatewayEnabled !== state.settings.gatewayEnabled ||
        (Number(next.gatewayPort) || 8789) !== prevPort;
      state.settings = next;
      saveState();
      scheduledFor.day = null;
      emit('info', `设置已更新 · 每日 ${next.claimTime} 执行`);
      if (cfgChanged) {
        await stopGateway();
        await startGateway();
        emit('info', '网关配置已变化，已重新加载');
      }
      return sendJSON(res, 200, { settings: state.settings });
    }

    /* ── 导入 / 导出 ── */
    if (p === '/api/export') {
      const dump = {
        exportedAt: Date.now(),
        settings: state.settings,
        accounts: state.accounts.map((a) => ({ ...a })),
      };
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="wb-autoclaim-backup.json"',
      });
      return res.end(JSON.stringify(dump, null, 2));
    }

    if (p === '/api/import' && req.method === 'POST') {
      const body = await readBody(req);
      const list = Array.isArray(body.accounts) ? body.accounts : [];
      let added = 0;
      for (const a of list) {
        if (!a.accessToken || !a.uid) continue;
        if (state.accounts.some((x) => x.uid === a.uid)) continue;
        state.accounts.push({
          id: crypto.randomUUID(),
          name: a.name || `账号 ${state.accounts.length + 1}`,
          uid: String(a.uid),
          accessToken: a.accessToken,
          refreshToken: a.refreshToken || '',
          deviceToken: a.deviceToken || '',
          enterpriseId: a.enterpriseId || '',
          cookie: a.cookie || '',
          endpoint: a.endpoint || '',
          enabled: true,
          createdAt: Date.now(),
          history: [],
        });
        added++;
      }
      saveState();
      emit('info', `导入完成，新增 ${added} 个账号`);
      return sendJSON(res, 200, { added });
    }

    /* ── 静态文件（开发态走 fs，SEA 单文件走内置资源） ── */
    let file = p === '/' ? '/index.html' : p;
    file = file.replace(/\.\./g, '');
    const buf = readPublic(file);
    if (buf) {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      return res.end(buf);
    }

    return sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    emit('error', `请求异常 ${p}：${e.message}`);
    return sendJSON(res, 500, { error: e.message });
  }
});

/* ────────────────────────── 启动 ────────────────────────── */
loadState();

// 启动补领：当天还没领且已过计划时间 → 立刻补一次
function bootCatchUp() {
  if (!state.settings.catchUp) return;
  const today = todayKey();
  const pending = state.accounts.filter(
    (a) => a.enabled !== false && !(a.history || []).some((x) => x.day === today),
  );
  if (pending.length && state.accounts.length) {
    const [h, m] = String(state.settings.claimTime || '00:05').split(':').map(Number);
    const now = new Date();
    const planned = new Date(now).setHours(h || 0, m || 0, 0, 0);
    if (now.getTime() > planned) {
      emit('info', `检测到 ${pending.length} 个账号今日未签到，启动补领`);
      setTimeout(() => runAll('开机补领'), 4000);
    }
  }
}

/* ────────────────────────── 常量 ────────────────────────── */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const LISTEN_PORT = Number(state.settings.port) || 8788;
const LISTEN_HOST = process.env.HOST || '127.0.0.1';
let listenAttempts = 0;

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    listenAttempts++;
    if (listenAttempts > 100) {
      emit('error', `端口 ${LISTEN_PORT} 持续被占用，放弃启动`);
      process.exit(1);
    }
    emit('warn', `端口 ${LISTEN_PORT} 被占用（可能处于 TIME_WAIT），3 秒后第 ${listenAttempts} 次重试…`);
    setTimeout(() => server.listen(LISTEN_PORT, LISTEN_HOST), 3000);
  } else {
    emit('error', `监听失败：${err && err.message}`);
    process.exit(1);
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  emit('info', `服务已启动 · http://${LISTEN_HOST}:${LISTEN_PORT}`);
  emit('info', `数据目录 ${DATA_DIR} · 账号 ${state.accounts.length} 个`);
  startGateway().then((ok) => {
    if (ok) {
      emit('info', `对外只需配这一个地址即可用完整池：http://127.0.0.1:${Number(state.settings.gatewayPort) || 8789}/v1`);
    }
  });
  bootCatchUp();
  // 打包成 exe（编译期注入 WB_EXE）/ 显式要求时，自动打开管理面板
  if (process.env.WB_EXE || isPkg || process.env.OPEN_BROWSER) {
    const url = `http://${LISTEN_HOST}:${LISTEN_PORT}/`;
    setTimeout(() => {
      try {
        if (process.platform === 'win32') exec(`cmd /c start "" "${url}"`);
        else if (process.platform === 'darwin') exec(`open "${url}"`);
        else exec(`xdg-open "${url}"`);
      } catch (e) { /* 忽略：用户可手动打开 */ }
    }, 1200);
  }
});

setInterval(schedulerTick, 20000);
setInterval(() => {
  // 每分钟清理一次调度状态，防止休眠后时间漂移
  if (scheduledFor.day !== todayKey()) scheduledFor.day = null;
}, 60000);

process.on('uncaughtException', (e) => emit('error', `未捕获异常：${e.message}`));
process.on('unhandledRejection', (e) => emit('error', `未处理 Promise：${e && e.message}`));
process.on('SIGINT', () => { emit('info', '服务已停止'); process.exit(0); });
