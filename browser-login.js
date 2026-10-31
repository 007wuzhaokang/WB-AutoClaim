/* ──────────────────────────────────────────────────────────────
 * browser-login.js  ·  浏览器代登录（CDP）
 * 用系统 Edge 打开真实登录页，用户在窗口里输手机号 + 验证码。
 * 后端通过 Chrome DevTools Protocol 实时监听发往 workbuddy.cn 的请求，
 * 自动截获登录后的 Authorization / Cookie / X-User-Id 等凭据。
 * 零依赖：使用 Node 18+ 内置的 global WebSocket + fetch。
 * ────────────────────────────────────────────────────────────── */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft\\Edge\\Application\\msedge.exe') : '',
].filter(Boolean);

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

const sessions = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randPort() { return 9400 + Math.floor(Math.random() * 400); }

async function cdpJSON(port, pathname) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'GET' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {}
}

/* 按调试端口找出真正的 Edge 进程并杀掉。
   Edge 常会「自我重启」：原进程退出、新进程接管同一端口，
   这时 killTree(原始 pid) 完全无效。netstat 查端口占用最可靠。 */
function killBrowserByPort(port) {
  if (!port) return;
  try {
    const out = spawn('netstat', ['-ano'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let buf = '';
    out.stdout.on('data', (d) => { buf += d.toString(); });
    out.on('close', () => {
      const re = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'gim');
      const pids = [...buf.matchAll(re)].map((m) => m[1]);
      for (const p of new Set(pids)) {
        try { spawn('taskkill', ['/PID', p, '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
      }
    });
  } catch {}
}

/* 按 user-data-dir 清理残留的 Edge 子进程（渲染进程等）。 */
function killBrowserByProfile(profile) {
  if (!profile) return;
  const marker = path.basename(profile);
  try {
    const out = spawn('wmic', ['process', 'where', `CommandLine like '%${marker}%'`, 'get', 'ProcessId', '/value'],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let buf = '';
    out.stdout.on('data', (d) => { buf += d.toString(); });
    out.on('close', () => {
      const pids = [...buf.matchAll(/ProcessId=(\d+)/g)].map((m) => m[1]);
      for (const p of pids) {
        try { spawn('taskkill', ['/PID', p, '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
      }
    });
  } catch {}
}

/* 噪音路径：埋点/统计/静态资源，绝不能当登录凭据 */
function isNoisePath(u) {
  return /\/(collect|sa|v2_upload|cookie-guard|destination|monitor|report|log|beacon|rum|trace|stat|analytics|track)\b/i.test(u)
    || /\.(gif|png|jpg|jpeg|svg|ico|css|js|woff2?|ttf|map)(\?|$)/i.test(u)
    || /\/static\//i.test(u);
}
/* 解出 JWT 载荷：里面带 uid / nickname，省掉一次反查账号信息的请求 */
function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

/* 像真接口的路径（登录后的业务调用） */
function isApiPath(u) {
  return /\/(v2|v1|billing|meter|user|account|credit|auth|checkin)\b/i.test(u);
}

/* 把收到的请求头挑出登录凭据（严格模式，避免误抓埋点） */
function processHeaders(s, url, headersObj) {
  let host = '';
  try { host = new URL(url).host; } catch {}
  const isTarget = /(^|\.)workbuddy\.cn$/.test(host) || /(^|\.)codebuddy\.cn$/.test(host);
  if (!isTarget) return;
  if (isNoisePath(url)) return;

  const lower = {};
  for (const k of Object.keys(headersObj || {})) lower[String(k).toLowerCase()] = headersObj[k];
  const auth = String(lower['authorization'] || '').trim();
  const cookie = String(lower['cookie'] || '').trim();
  const uid = String(lower['x-user-id'] || lower['x-uid'] || '').trim();
  const hasBearer = /^bearer\s+/i.test(auth);

  // 采集门槛：只认带 Bearer 的请求。网页登录完成后不会发带 token 的请求，
  // 真正的令牌由 pollAuthToken 用 state 换取；这里只作补充，避免拿脏 Cookie 误导状态。
  let score = 0;
  if (hasBearer) score = 100 + (uid ? 5 : 0);
  else if (auth) score = 50;
  if (!score) return;

  const fp = `${auth}|${cookie}|${uid}`;
  if (s.rejected && s.rejected.has(fp)) return;

  const cand = {
    url,
    fp,
    auth,
    cookie: s.jar || cookie,
    ua: s.ua || '',
    uid,
    refresh: String(lower['x-refresh-token'] || '').trim(),
    device: String(lower['x-device-token'] || '').trim(),
    ent: String(lower['x-enterprise-id'] || lower['x-tenant-id'] || '').trim(),
    score,
    at: Date.now(),
  };
  s.candidates.push(cand);
  if (!s.captured || score > s.captured.score) {
    s.captured = cand;
    if (s.state !== 'done') {
      s.state = 'captured';
      s.message = '已识别到登录凭据，正在自动添加账号并领取…';
    }
  }
}

async function attachTarget(s, target) {
  if (!target || !target.webSocketDebuggerUrl) return;
  if (s.attached.has(target.id)) return;
  s.attached.add(target.id);

  let ws;
  try { ws = new WebSocket(target.webSocketDebuggerUrl); } catch { return; }
  s.sockets.add(ws);

  let idc = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = ++idc;
    pending.set(i, resolve);
    try { ws.send(JSON.stringify({ id: i, method, params })); } catch { resolve(null); }
  });
  // 记住最新页面通道：grabCreds() 需要用它取 HttpOnly cookie / navigator.userAgent
  // （Edge 自重启后会 attach 新目标，这里自然被覆盖成新的 send）
  s.pageSend = send;

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
    if (msg.method === 'Network.requestWillBeSent') {
      const req = msg.params.request || {};
      s.reqMeta.set(msg.params.requestId, { url: req.url || '' });
      processHeaders(s, req.url || '', req.headers || {});
    } else if (msg.method === 'Network.requestWillBeSentExtraInfo') {
      const meta = s.reqMeta.get(msg.params.requestId);
      const url = (meta && meta.url) || '';
      if (url) processHeaders(s, url, msg.params.headers || {});
    }
  };
  ws.onopen = async () => {
    s.message = '登录窗口已打开，请用手机号 + 验证码登录…';
    if (s.state === 'starting') s.state = 'waiting';
    await send('Network.enable', {});
    await send('Runtime.enable', {});
    await send('Page.enable', {});

    // 自动切到「手机号」登录方式：登录页默认是微信扫码，多等几秒让表单渲染完再点
    const clickPhoneTab = async () => {
      if (s.phoneTabDone) return;
      try {
        const r = await send('Runtime.evaluate', {
          expression: `(() => {
            const nodes = [...document.querySelectorAll('span.login-method-text, [role="tab"], .login-methods *')]
              .filter(e => !e.children.length && (e.textContent || '').trim() === '手机号');
            if (!nodes.length) return 'no-tab';
            const n = nodes[0];
            (n.parentElement || n).click();
            n.click();
            return 'ok';
          })()`,
          returnByValue: true,
        });
        const v = r && r.result && r.result.value;
        if (v === 'ok') {
          s.phoneTabDone = true;
          s.message = '已切到手机号登录，请输入手机号并获取验证码…';
        }
      } catch {}
    };
    const tabTimer = setInterval(() => {
      if (s.state === 'done' || s.closed || s.phoneTabDone) return;
      clickPhoneTab();
    }, 2500);
    s.timers.push(tabTimer);
    s.timers.push(setTimeout(() => { try { clearInterval(tabTimer); } catch {} }, 30000));

    const t = setInterval(async () => {
      if (s.state === 'done' || s.closed) return;
      try {
        const r = await send('Runtime.evaluate', {
          expression: 'JSON.stringify({url:location.href})',
          returnByValue: true,
        });
        if (r && r.result && r.result.value) s.lastUrl = r.result.value;
      } catch {}
      // 兜底：网页登录成功后不再发带 token 的请求，但 localStorage / cookie 里通常留着凭据
      if (!s.captured) scanPageForToken(s, send);
    }, 3000);
    s.timers.push(t);
  };
  ws.onerror = () => {};
  ws.onclose = () => {};
}

/* 抓取真实登录态：完整 cookie jar（含 HttpOnly）+ 精确 UA + uid。
   为什么必须这么做（线上实测结论）：
   1) document.cookie 只能看到 4 个非 HttpOnly cookie，真正决定鉴权的
      KEYCLOAK_IDENTITY / AUTH_SESSION_ID / session / session_2 全是 HttpOnly，
      只能通过 CDP 的 Network.getAllCookies 拿到；
   2) 官方网关把会话和 User-Agent 绑死——UA 差一个字符（例如 Edg/156.0.0.1）
      就直接 401，所以必须原样保存页面 navigator.userAgent 并复用。 */
async function grabCreds(s, withAccounts) {
  const send = s.pageSend;
  if (typeof send !== 'function') return false;
  let got = false;

  try {
    const r = await send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true });
    const ua = r && r.result && r.result.value;
    if (ua) { s.ua = String(ua); got = true; }
  } catch {}

  try {
    await send('Network.enable', {});
    const ck = await send('Network.getAllCookies');
    const list = (ck && ck.cookies) || [];
    const jar = list
      .filter((c) => /workbuddy\.cn$/i.test(String(c.domain || '').replace(/^\./, '')))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    if (jar) { s.jar = jar; got = true; }
  } catch {}

  // uid / 昵称：/console/accounts 返回当前登录账号，比令牌载荷可靠
  if (!withAccounts) return got;
  try {
    const r = await send('Runtime.evaluate', {
      expression: `fetch('/console/accounts',{credentials:'include',headers:{Accept:'application/json'}})
        .then(r=>r.text()).then(t=>t.slice(0,4000))`,
      returnByValue: true,
      awaitPromise: true,
    });
    const txt = (r && r.result && r.result.value) || '';
    if (txt.startsWith('{')) {
      const j = JSON.parse(txt);
      const a0 = ((j.data && j.data.accounts) || [])[0] || {};
      if (a0.uid) s.uid = String(a0.uid);
      if (a0.nickname) s.nick = String(a0.nickname);
      if (a0.enterprise_id) s.ent = String(a0.enterprise_id);
    }
  } catch {}

  return got;
}

/* 兜底：网页登录成功后不再发带 token 的请求，但 localStorage 里有 loggedIn=true。
   用它判定"用户已登录成功"，立刻抓登录态并触发一次令牌换取。 */
async function scanPageForToken(s, send) {
  if (s.loggedInSeen) return;
  try {
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const out = { loggedIn: false };
        try { out.loggedIn = localStorage.getItem('loggedIn') === 'true'; } catch {}
        try { out.uid = localStorage.getItem('CODEBUDDY_IDE_SELECTED_ACCOUNT_ID') || ''; } catch {}
        return JSON.stringify(out);
      })()`,
      returnByValue: true,
    });
    const raw = r && r.result && r.result.value;
    if (!raw) return;
    const st = JSON.parse(raw);
    if (!st.loggedIn) return;
    s.loggedInSeen = true;
    if (st.uid) s.pageUid = String(st.uid);
    s.message = '已检测到登录成功，正在获取完整会话…';
    await grabCreds(s, true);
    if (typeof s.fetchTokenNow === 'function') s.fetchTokenNow();
  } catch {}
}

/* 用 state 轮询官方换取令牌：GET /v2/plugin/auth/token?state=...
   这才是网页登录完成后真正的令牌交接方式——网页只显示"登录成功"，
   不再发带 token 的请求，所以纯抓包抓不到。code=11217 表示仍在等待登录。 */
async function pollAuthToken(s) {
  const headers = {
    'Content-Type': 'application/json',
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
  };
  const url = `https://www.workbuddy.cn/v2/plugin/auth/token?state=${encodeURIComponent(s.authState)}`;

  const tick = async () => {
    if (s.closed || s.state === 'done' || s.consumed || s.tokenPolled) return;
    // 每次换取前刷新完整登录态（cookie jar + 精确 UA）：
    // 登录前也存在一批评测用 cookie，必须每次重取，否则会存下登录前的过期 jar
    await grabCreds(s);
    try {
      const r = await fetch(url, { headers });
      const j = await r.json().catch(() => null);
      if (!j) return;
      if (j.code === 11217) return;            // login ing...
      const d = j.data || j;
      const token = d.accessToken || d.access_token || d.token;
      if (!token) return;

      // 一次性把 uid / 昵称 / 最新 jar 补齐（/console/accounts 只在登录成功后才有意义）
      await grabCreds(s, true);

      // 令牌载荷里带 nickname / enterprise_id，可省掉一次反查请求
      const pay = decodeJwtPayload(token) || {};
      s.captured = {
        url: 'plugin:auth/token',
        auth: 'Bearer ' + token,
        // 优先用 CDP 抓到的完整 jar（含 HttpOnly 鉴权 cookie）
        cookie: s.jar || String(d.cookie || ''),
        ua: s.ua || '',
        uid: String(s.uid || d.uid || d.userId || d.user_id
          || (d.user && (d.user.uid || d.user.id))
          || pay.uid || s.pageUid || ''),
        nickname: String(s.nick || pay.nickname || pay.name || ''),
        refresh: String(d.refreshToken || d.refresh_token || ''),
        device: String(d.deviceToken || d.device_token || ''),
        ent: String(s.ent || d.enterpriseId || d.enterprise_id || pay.enterprise_id || ''),
        score: 9999,
        at: Date.now(),
        source: 'token-poll',
        // 便于首次接入时确认字段结构（面板日志会打印）
        rawKeys: Object.keys(d).join(','),
      };
      s.tokenPolled = true;
      s.raw = j;
      if (s.state !== 'done') {
        s.state = 'captured';
        s.message = '登录成功，正在自动添加账号并领取…';
      }
    } catch { /* 网络抖动继续轮询 */ }
  };

  const timer = setInterval(tick, 3000);
  s.timers.push(timer);
  setTimeout(() => { try { clearInterval(timer); } catch {} }, 12 * 60 * 1000);
  // 页面检测到登录成功时立即触发一次，不用等下一个 3 秒周期
  s.fetchTokenNow = tick;
}

async function pumpTargets(s) {
  const closedNoise = new Set();
  while (!s.closed) {
    if (s.state === 'done') { await sleep(1500); continue; }
    const list = await cdpJSON(s.port, '/json/list');
    if (Array.isArray(list)) {
      s.ready = true;
      for (const t of list) {
        // 自动关掉 Edge 自身的干扰弹窗（权限请求 / 同步确认），它们会抢焦点盖住登录页
        if (t.type === 'page' && /^edge:\/\/(permission-request|sync-confirmation|edge-sync|welcome|whatsnew)/i.test(t.url || '') && !closedNoise.has(t.id)) {
          closedNoise.add(t.id);
          fetch(`http://127.0.0.1:${s.port}/json/close/${t.id}`).catch(() => {});
          continue;
        }
        if (t.type === 'page' && !/^edge:\/\//i.test(t.url || '') && !s.attached.has(t.id)) attachTarget(s, t).catch(() => {});
      }
    }
    await sleep(700);
  }
}

async function start(opts = {}) {
  const exe = findBrowser();
  if (!exe) throw new Error('未找到 Edge / Chrome 浏览器，无法启动登录窗口');

  const id = crypto.randomUUID();
  const port = randPort();
  const profile = path.join(os.tmpdir(), 'wb-login-' + id.slice(0, 8));

  // 不硬编码登录路径：向官方接口申请一次性 state，拿服务端下发的 authUrl。
  // 直接开 /login/ 会因 SPA 路由不匹配而落到企业版营销页（WORKBUDDY ENTERPRISE）。
  let startUrl = opts.startUrl || '';
  let authState = '';
  if (!startUrl) {
    try {
      const r = await fetch('https://www.workbuddy.cn/v2/plugin/auth/state?platform=workbuddy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-No-Authorization': 'true',
          'X-No-User-Id': 'true',
          'X-No-Enterprise-Id': 'true',
          'X-No-Department-Info': 'true',
        },
        body: '{}',
      });
      const j = await r.json();
      const u = j && j.data && j.data.authUrl;
      if (typeof u === 'string' && /^https:\/\/[a-z0-9.-]*(workbuddy|codebuddy)\.cn\/login/i.test(u)) {
        startUrl = u;
        authState = String(j.data.state || '');
      }
    } catch { /* 下面走兜底 */ }
  }
  if (!startUrl) startUrl = 'https://www.workbuddy.cn/login?platform=workbuddy';
  if (!authState) {
    try { authState = new URL(startUrl).searchParams.get('state') || ''; } catch {}
  }

  const child = spawn(exe, [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-sync',
    '--deny-permission-prompts',
    '--disable-background-networking',
    '--disable-component-extensions-with-background-pages',
    // 关掉 Edge 的账号登录 / 同步确认 / 本地网络权限弹窗，否则会抢占窗口把登录页顶掉
    '--disable-features=Translate,msEdgeSidebarV2,msEdgeIdentity,msImplicitSignin,msEdgeSyncConfirmation,EdgeSyncConfirmation,LocalNetworkAccessChecks',
    '--new-window',
    startUrl,
  ], { stdio: 'ignore', windowsHide: false });

  const s = {
    id, port, profile, child, pid: child.pid,
    state: 'starting',
    message: '正在启动浏览器…',
    authState,
    candidates: [],
    captured: null,
    rejected: new Set(),
    lastProbed: null,
    consumed: false,
    phoneTabDone: false,
    tokenPolled: false,
    attached: new Set(),
    sockets: new Set(),
    timers: [],
    reqMeta: new Map(),
    result: null,
    closed: false,
    startedAt: Date.now(),
  };
  sessions.set(id, s);

  /* Edge 有一个「compat layer relaunch」机制：启动后不久它会自己重启一遍
     （命令行里会多出 --edge-skip-compat-layer-relaunch），原始进程退出、
     新进程接管同一个调试端口。此时如果把 child 的 exit 当成「用户关闭窗口」，
     就会把 pollAuthToken 一起停掉 → 浏览器里已显示"登录成功"，但令牌永远拿不到。
     所以这里必须探测调试端口：端口还活着 = Edge 只是重启了，会话继续。 */
  child.on('exit', () => {
    if (s.closed || s.state === 'done') return;
    // 给新进程一点接管时间，再判断端口是否还活着
    setTimeout(async () => {
      if (s.closed || s.state === 'done') return;
      const alive = await cdpJSON(port, '/json/version').catch(() => null);
      if (alive) {
        // Edge 自重启 → 会话继续有效。
        // 原先的 pumpTargets 循环因为 s.closed 一直为 false 而仍在运行，
        // 它会自动把新进程上的页面目标重新 attach 过来，这里无需重复启动。
        s.message = '浏览器已自动重启，正在继续监听…';
        return;
      }
      // 端口也没了 → 确实是窗口被关闭
      s.closed = true;
      if (s.state !== 'done') { s.state = 'error'; s.message = '登录窗口已关闭'; }
    }, 1500);
  });

  pumpTargets(s).catch(() => {});
  if (authState) pollAuthToken(s);

  setTimeout(async () => {
    if (s.state === 'starting' || s.state === 'waiting') {
      const v = await cdpJSON(port, '/json/version').catch(() => null);
      if (!v) { s.state = 'error'; s.message = '无法连接调试端口，可能被安全软件拦截'; }
    }
  }, 4000);

  setTimeout(() => { if (s.state !== 'done') cancel(id, '登录超时（10 分钟）'); }, 10 * 60 * 1000);

  return id;
}

function getSession(id) { return sessions.get(id) || null; }

function cancel(id, reason) {
  const s = sessions.get(id);
  if (!s) return;
  s.closed = true;
  try { for (const t of s.timers) clearInterval(t); } catch {}
  try { for (const w of s.sockets) { try { w.close(); } catch {} } } catch {}
  killTree(s.pid);
  // Edge 自重启后原 PID 已失效，必须按调试端口 / user-data-dir 清理新进程
  killBrowserByPort(s.port);
  killBrowserByProfile(s.profile);
  try { fs.rmSync(s.profile, { recursive: true, force: true }); } catch {}
  if (s.state !== 'done') { s.state = 'error'; s.message = reason || '已取消登录'; }
  setTimeout(() => sessions.delete(id), 60 * 1000);
}

module.exports = { start, getSession, cancel, findBrowser };
