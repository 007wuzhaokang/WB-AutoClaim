/* ============================================================================
 * 统一网关 —— 把多个 WorkBuddy 账号合成一个「虚拟主账号」
 *
 * 背景：官方没有积分转账接口（所有 transfer 路由均 404），积分无法真正搬运。
 * 但积分可以通过 /v2/chat/completions 被账号令牌消耗（已实测）。
 * 于是：对外暴露单个 OpenAI 兼容端点，内部在全部账号令牌之间自动路由，
 * 效果上等价于“所有积分注入同一个账号”，且客户端只需配置一次、永不切换。
 *
 * 对外接口：
 *   GET  /v1/models              聚合模型清单
 *   POST /v1/chat/completions    OpenAI 兼容（stream 与非 stream 都支持）
 *   POST /v2/chat/completions    同上（兼容客户端里写死 /v2 的）
 *   GET  /health                 网关自检
 * ==========================================================================*/
'use strict';

const http = require('node:http');
const https = require('node:https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/* 上游返回的这些 code 意味“这个号现在用不了”，应换号重试 */
const ROTATE_CODES = new Set([
  11102, // model unavailable / not authorized
  11101, // bad request shape
  11403, // quota / permission-ish
  11217, // not logged in
]);
const HTTP_ROTATE = new Set([401, 402, 403, 429]);

/* 「请求级」错误：模型本身不存在，与账号无关。
   这类错误不应让账号进入冷却，也不该逐个账号轮转，直接快速失败即可。 */
function isRequestLevelError(code, txt) {
  return code === 11102 && /service info not found/i.test(String(txt || ''));
}

const DEFAULT_MODELS = [
  'glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5.3-flash',
  'deepseek-v4-pro', 'deepseek-v4-pro-0813', 'deepseek-v4-flash-0731',
  'kimi-k2.6', 'kimi-k2.5', 'kimi-k2.7-code', 'kimi-k3',
  'gpt-5.4',
];

function readBody(req, max = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createGateway(opts = {}) {
  const getAccounts = opts.getAccounts;
  const refresh = opts.refreshToken || (async () => ({ ok: false }));
  const emit = opts.emit || (() => {});
  const port = opts.port || 8789;
  const host = opts.host || '127.0.0.1';
  const requireKey = opts.requireKey || '';
  const defaultModel = opts.defaultModel || 'glm-5.3';

  /* 每个账号的健康状态：失败次数 + 冷却截止时间戳 */
  const health = new Map();
  let rr = 0;
  let stats = { requests: 0, rotations: 0, failures: 0, byAccount: {} };

  const hget = (id) => health.get(id) || { fails: 0, cooldownUntil: 0, lastOk: 0, lastErr: '' };

  function markOk(id) {
    const h = hget(id);
    h.fails = 0; h.cooldownUntil = 0; h.lastOk = Date.now(); h.lastErr = '';
    health.set(id, h);
  }
  function markFail(id, reason) {
    const h = hget(id);
    h.fails += 1;
    h.lastErr = String(reason || '').slice(0, 160);
    h.cooldownUntil = Date.now() + Math.min(600000, 15000 * Math.pow(2, h.fails - 1));
    health.set(id, h);
  }

  /* 候选账号：启用 + 有令牌 + 不在冷却期 */
  function candidates() {
    const list = (typeof getAccounts === 'function' ? getAccounts() : []).filter(
      (a) => a && a.enabled !== false && a.accessToken,
    );
    const now = Date.now();
    const ready = list.filter((a) => hget(a.id).cooldownUntil <= now);
    return ready.length ? ready : list; // 全在冷却时退回全集，避免完全不可用
  }

  /* 轮询挑选；同一请求内用 exclude 排除已失败过的号 */
  function pick(exclude) {
    const list = candidates().filter((a) => !exclude.has(a.id));
    if (!list.length) return null;
    rr = (rr + 1) % list.length;
    return list[rr];
  }

  function upstreamHeaders(acc) {
    const h = {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      Origin: 'https://www.workbuddy.cn',
      Referer: 'https://www.workbuddy.cn/',
      Authorization: `Bearer ${acc.accessToken}`,
    };
    if (acc.uid) h['X-User-Id'] = acc.uid;
    if (acc.deviceToken) h['X-Device-Token'] = acc.deviceToken;
    if (acc.enterpriseId) h['X-Enterprise-Id'] = acc.enterpriseId;
    if (acc.cookie) h.Cookie = acc.cookie;
    return h;
  }

  const base = (acc) => String(acc.endpoint || 'https://www.workbuddy.cn').replace(/\/+$/, '');

  /* 单次上游尝试。返回 { res, readable } —— 未发送任何字节时仍可安全换号 */
  function attempt(acc, payload, wantSSE) {
    return new Promise((resolve) => {
      const url = new URL(base(acc) + '/v2/chat/completions');
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const headers = upstreamHeaders(acc);
      headers.Accept = wantSSE ? 'text/event-stream' : 'application/json';
      headers['Content-Length'] = body.length;

      let settled = false;
      const req = https.request(
        url,
        { method: 'POST', headers, timeout: 120000 },
        (res) => { if (!settled) { settled = true; resolve({ ok: true, res }); } },
      );
      req.on('timeout', () => { if (!settled) { settled = true; req.destroy(new Error('upstream timeout')); resolve({ ok: false, err: 'upstream timeout' }); } });
      req.on('error', (e) => { if (!settled) { settled = true; resolve({ ok: false, err: e.message }); } });
      req.write(body);
      req.end();
    });
  }

  /* 上游是否需要先刷令牌（令牌过期） */
  async function maybeRefresh(acc, code, status) {
    if (!(status === 401 || code === 11217)) return false;
    const r = await refresh(acc).catch(() => ({ ok: false }));
    return !!(r && r.ok);
  }

  /* ── 非流式：内部强制走流式，再聚合为一个标准 JSON ── */
  async function handleNonStream(req, res, payload, t0) {
    const exclude = new Set();
    let lastErr = '';
    const maxTry = Math.max(1, candidates().length);

    for (let i = 0; i < maxTry; i++) {
      const acc = pick(exclude);
      if (!acc) { lastErr = '无可用账号'; break; }
      const a = await attempt(acc, { ...payload, stream: true }, true);
      if (!a.ok) { exclude.add(acc.id); markFail(acc.id, a.err); lastErr = a.err; continue; }
      const { res: up } = a;

      if (up.statusCode !== 200) {
        const txt = await collect(up).catch(() => '');
        const code = Number((txt.match(/"code":(\d+)/) || [])[1] || 0);
        up.destroy();
        const refreshed = await maybeRefresh(acc, code, up.statusCode);
        if (refreshed) { i--; continue; }
        if (isRequestLevelError(code, txt)) {
          return sendJSON(res, badGateway(up.statusCode, txt), up.statusCode);
        }
        if (up.statusCode === 429 || HTTP_ROTATE.has(up.statusCode) || ROTATE_CODES.has(code)) {
          stats.rotations++; exclude.add(acc.id); markFail(acc.id, `HTTP ${up.statusCode} code=${code}`); lastErr = txt.slice(0, 200); continue;
        }
        return sendJSON(res, badGateway(up.statusCode, txt), up.statusCode);
      }

      /* 正常：收集全部 chunk 后合成一条完整响应 */
      try {
        const agg = await aggregateStream(up, payload.model);
        markOk(acc.id);
        stats.requests++;
        stats.byAccount[acc.id] = (stats.byAccount[acc.id] || 0) + 1;
        emit('info', `网关完成请求 · 账号「${acc.name}」· ${payload.model} · ${Date.now() - t0}ms`);
        return sendJSON(res, agg, 200);
      } catch (e) {
        exclude.add(acc.id); markFail(acc.id, e.message); lastErr = e.message;
      }
    }
    stats.failures++;
    return sendJSON(res, badGateway(502, lastErr || 'all accounts failed'), 502);
  }

  /* ── 流式：直接透传 SSE；若尚未写入任何字节则可安全换号 ── */
  async function handleStream(req, res, payload, t0) {
    const exclude = new Set();
    let lastErr = '';
    const maxTry = Math.max(1, candidates().length);

    for (let i = 0; i < maxTry; i++) {
      const acc = pick(exclude);
      if (!acc) { lastErr = '无可用账号'; break; }
      const a = await attempt(acc, { ...payload, stream: true }, true);
      if (!a.ok) { exclude.add(acc.id); markFail(acc.id, a.err); lastErr = a.err; continue; }
      const { res: up } = a;

      if (up.statusCode !== 200) {
        const txt = await collect(up).catch(() => '');
        const code = Number((txt.match(/"code":(\d+)/) || [])[1] || 0);
        up.destroy();
        const refreshed = await maybeRefresh(acc, code, up.statusCode);
        if (refreshed) { i--; continue; }
        if (isRequestLevelError(code, txt)) {
          res.writeHead(up.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(txt || '{}');
          return;
        }
        if (up.statusCode === 429 || HTTP_ROTATE.has(up.statusCode) || ROTATE_CODES.has(code)) {
          stats.rotations++; exclude.add(acc.id); markFail(acc.id, `HTTP ${up.statusCode} code=${code}`); lastErr = txt.slice(0, 200); continue;
        }
        res.writeHead(up.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(txt || '{}');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Gateway-Account': Buffer.from(String(acc.name || ''), 'utf8').toString('base64'),
      });

      let wrote = false;
      let buf = '';
      const done = await new Promise((resolve) => {
        up.on('data', (c) => {
          if (!wrote) wrote = true;
          res.write(c);
          buf += c.toString('utf8');
        });
        up.on('end', () => resolve('end'));
        up.on('error', (e) => { lastErr = e.message; resolve('err:' + e.message); });
        req.on('close', () => { try { up.destroy(); } catch {} resolve('client-gone'); });
      });

      markOk(acc.id);
      if (wrote) {
        stats.requests++;
        stats.byAccount[acc.id] = (stats.byAccount[acc.id] || 0) + 1;
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
        return;
      }
      /* 一个字节都没发出就出错 → 换号 */
      exclude.add(acc.id);
      markFail(acc.id, done.startsWith('err:') ? lastErr : 'empty upstream');
      if (i === maxTry - 1) {
        stats.failures++;
        if (!res.headersSent) return sendJSON(res, badGateway(502, lastErr || 'all accounts failed'), 502);
        try { res.end(); } catch {}
      }
    }
    if (!res.headersSent) return sendJSON(res, badGateway(502, lastErr || 'all accounts failed'), 502);
    try { res.end(); } catch {}
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', `http://${host}:${port}`);
    const p = u.pathname.replace(/\/+$/, '') || '/';

    /* 允许浏览器跨域调用：面板(8788)与任意 OpenAI 客户端直连本网关 */
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (p === '/health') {
      const list = candidates();
      return sendJSON(res, {
        ok: true,
        gateway: 'WB-AutoClaim Unified Gateway',
        accounts: list.length,
        cooldown: [...health.entries()].filter(([, v]) => v.cooldownUntil > Date.now()).length,
        stats,
      }, 200);
    }

    /* 简易鉴权：设了 requireKey 就必须带 key */
    if (requireKey) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
        || (req.headers['x-api-key'] || '').trim();
      if (got !== requireKey) {
        return sendJSON(res, { error: 'invalid api key' }, 401);
      }
    }

    if (p === '/v1/models' && req.method === 'GET') {
      const now = Math.floor(Date.now() / 1000);
      return sendJSON(res, {
        object: 'list',
        data: DEFAULT_MODELS.map((id) => ({ id, object: 'model', created: now, owned_by: 'workbuddy-pool' })),
      }, 200);
    }

    if ((p === '/v1/chat/completions' || p === '/v2/chat/completions') && req.method === 'POST') {
      const t0 = Date.now();
      let payload;
      try {
        payload = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      } catch {
        return sendJSON(res, { error: 'invalid json' }, 400);
      }
      if (!Array.isArray(payload.messages) || !payload.messages.length) {
        return sendJSON(res, { error: 'messages required' }, 400);
      }
      if (!payload.model) payload.model = defaultModel;
      /* 上游要求流式，非流式请求由网关内部消化 */
      if (payload.stream) return handleStream(req, res, payload, t0);
      return handleNonStream(req, res, payload, t0);
    }

    return sendJSON(res, { error: 'not found', routes: ['GET /v1/models', 'POST /v1/chat/completions', 'GET /health'] }, 404);
  });

  return {
    server,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve({ port, host }));
      });
    },
    stop() {
      return new Promise((resolve) => { try { server.close(() => resolve(true)); } catch { resolve(false); } });
    },
    stats: () => ({ ...stats, health: [...health.entries()].map(([id, v]) => ({ id, ...v })) }),
    reset() { stats = { requests: 0, rotations: 0, failures: 0, byAccount: {} }; health.clear(); },
    health() {
      const list = typeof getAccounts === 'function' ? getAccounts() : [];
      return list.map((a) => {
        const h = hget(a.id);
        return {
          id: a.id, name: a.name, enabled: a.enabled !== false,
          hasToken: !!a.accessToken,
          coolingUntil: h.cooldownUntil,
          cooling: h.cooldownUntil > Date.now(),
          fails: h.fails, lastOk: h.lastOk, lastErr: h.lastErr,
          served: stats.byAccount[a.id] || 0,
        };
      });
    },
  };
}

/* ── 工具 ── */
function collect(stream) {
  return new Promise((resolve, reject) => {
    const parts = [];
    stream.on('data', (c) => parts.push(c));
    stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    stream.on('error', reject);
  });
}

/* 把上游 SSE 聚合成一条非流式响应 */
function aggregateStream(up, model) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let content = '';
    let reasoning = '';
    let finish = null;
    let id = '';
    let created = Math.floor(Date.now() / 1000);
    let usage = null;
    let got = false;

    up.setEncoding('utf8');
    up.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = line.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const raw = dataLine.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let j;
        try { j = JSON.parse(raw); } catch { continue; }
        got = true;
        if (j.id) id = j.id;
        if (j.created) created = j.created;
        if (j.usage) usage = j.usage;
        const ch = (j.choices && j.choices[0]) || null;
        if (ch) {
          if (ch.delta && typeof ch.delta.content === 'string') content += ch.delta.content;
          if (ch.delta && typeof ch.delta.reasoning_content === 'string') reasoning += ch.delta.reasoning_content;
          if (ch.finish_reason) finish = ch.finish_reason;
        }
      }
    });
    up.on('end', () => {
      if (!got) return reject(new Error('upstream returned no data'));
      const msg = { role: 'assistant', content };
      if (reasoning) msg.reasoning_content = reasoning;
      resolve({
        id: id || `cmb-${Date.now()}`,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: msg, finish_reason: finish || 'stop' }],
        usage: usage || null,
      });
    });
    up.on('error', reject);
  });
}

function badGateway(status, upstreamBody) {
  return {
    error: {
      message: upstreamBody ? String(upstreamBody).slice(0, 400) : 'upstream error',
      type: 'upstream_error',
      code: status,
    },
  };
}

function sendJSON(res, obj, status = 200) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

module.exports = { createGateway, DEFAULT_MODELS };
