/* ═══════════════════════════════════════════════════════════
   AutoClaim · 前端控制层
   动效哲学：吸附用弹簧临界/过阻尼（不越界），点按用欠阻尼（有回弹）
   ═══════════════════════════════════════════════════════════ */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ── 弹簧积分器 ── */
function spring({ from = 0, to = 1, stiffness = 210, damping, mass = 1, onUpdate, onDone }) {
  const zeta = damping;                       // 阻尼比：1 临界 → 无过冲
  const c = 2 * zeta * Math.sqrt(stiffness * mass);
  let x = from, v = 0, last = performance.now(), raf = 0;
  const step = (now) => {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const f = -stiffness * (x - to) - c * v;
    v += (f / mass) * dt;
    x += v * dt;
    if (Math.abs(x - to) < 0.0015 && Math.abs(v) < 0.0015) {
      x = to; onUpdate && onUpdate(x);
      onDone && onDone();
      return;
    }
    onUpdate && onUpdate(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

const SNAP = 1.28;   // 过阻尼：吸附
const LIVE = 0.34;   // 欠阻尼：轻弹

/* ── 数字滚动（过阻尼，锁死等宽） ── */
function countTo(el, target) {
  if (!el) return;
  const from = Number(el.dataset.v || 0);
  if (from === target) { el.textContent = fmt(target); return; }
  el.dataset.v = target;
  spring({
    from, to: target, stiffness: 320, damping: SNAP, mass: 1,
    onUpdate: (x) => { el.textContent = fmt(Math.round(x)); },
  });
}
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

/* ── 状态 ── */
let STATE = { settings: {}, accounts: [], stats: {} };
let streams = [];
let refreshing = false;

/* ── 请求 ── */
const CONN_HINT = '无法连接本地服务（WB-AutoClaim 可能未运行、端口被占用，或被浏览器代理 / 扩展拦截了 127.0.0.1）。请确认程序正在运行，并直接访问 http://127.0.0.1:8788/';
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    // 网络层失败 = 本地服务不可达，给出可操作的提示，而不是浏览器原生的 “Failed to fetch”
    throw new Error(CONN_HINT);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

/* ── 将异常转为可读提示（浏览器原生 "Failed to fetch" 太隐晦） ── */
function errMsg(e) {
  const m = e && e.message ? e.message : String(e);
  if (/Failed to fetch|NetworkError|load failed|fetch/i.test(m)) return CONN_HINT;
  return m;
}

/* ── 连接状态横幅 ── */
let connBad = false;
function showConnBanner(msg) {
  const b = $('#connBanner'); if (!b) return;
  $('#connMsg').textContent = msg || CONN_HINT;
  b.hidden = false;
}
function hideConnBanner() {
  const b = $('#connBanner'); if (b) b.hidden = true;
}
$('#connClose')?.addEventListener('click', hideConnBanner);
async function checkConn() {
  try {
    await api('/api/state');
    if (connBad) { connBad = false; hideConnBanner(); }
  } catch (e) {
    connBad = true;
    showConnBanner(CONN_HINT);
  }
}

/* ═══════════ 渲染 ═══════════ */
async function refresh(silent = true) {
  if (refreshing) return;
  refreshing = true;
  try {
    const data = await api('/api/state');
    STATE = data;
    render();
  } catch (e) {
    if (!silent) toast('无法连接本地服务：' + e.message, 'err');
    setLive(false);
  } finally {
    refreshing = false;
  }
}

function render() {
  const { stats, accounts, settings } = STATE;

  countTo($('#mClaimed'), stats.claimedToday || 0);
  $('#mClaimedOf').textContent = `/ ${stats.total || 0}`;
  const pct = stats.total ? (stats.claimedToday / stats.total) * 100 : 0;
  $('#mBar').style.width = `${pct}%`;

  countTo($('#mTodayCredit'), stats.todayCredit || 0);
  $('#mTodaySub').textContent = stats.todayCredit
    ? `今日 ${stats.claimedToday} 个账号已完成签到`
    : '等待今日首次执行';

  const dd = $('#dataDir');
  if (dd && STATE.dataDir) dd.textContent = STATE.dataDir;

  countTo($('#mTotal'), stats.totalCredit || 0);
  $('#mTotalSub').textContent = `覆盖 ${stats.enabled} 个启用账号`;

  renderNext(stats);
  renderAccList(accounts);
  renderAccGrid(accounts);

  $('#accHint').textContent = `${accounts.length} 个账号 · ${accounts.filter((a) => a.enabled).length} 启用`;
  const gw = $('#chatGw'); if (gw) gw.textContent = '网关 127.0.0.1:' + (STATE.settings.gatewayPort || 8789);

  // 设置回填（仅首次 & 未聚焦时）
  if (!render._filled) {
    $('#setTime').value = settings.claimTime || '00:05';
    $('#setJitter').value = settings.jitterMinutes ?? 14;
    $('#setRetry').value = settings.maxRetry ?? 3;
    $('#setEndpoint').value = settings.endpoint || 'https://www.workbuddy.cn';
    $$('.switch-row').forEach((r) => {
      r.querySelector('.switch').classList.toggle('on', !!settings[r.dataset.key]);
    });
    render._filled = true;
  }
}

function renderNext(stats) {
  const el = $('#mNext');
  if (!stats.nextRunAt) {
    el.textContent = '已执行';
    $('#mNextDay').textContent = 'done';
    $('#mNextSub').textContent = `明日 ${STATE.settings.claimTime} 再次执行`;
    return;
  }
  const d = new Date(stats.nextRunAt);
  el.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  $('#mNextDay').textContent = d.getDate() === new Date().getDate() ? 'today' : 'tomorrow';
  $('#mNextSub').textContent = `每日 ${STATE.settings.claimTime} ± ${STATE.settings.jitterMinutes} 分钟`;
}

function statusOf(a) {
  if (STATE.stats.running) return { cls: 'running', txt: '执行中' };
  if (a.lastRun?.status === 'auth') return { cls: 'auth', txt: '需授权' };
  if (a.today) return { cls: 'ok', txt: '今日已领' };
  if (a.lastRun && a.lastRun.ok === false) return { cls: 'fail', txt: '待重试' };
  return { cls: 'wait', txt: '待执行' };
}

function renderAccList(accounts) {
  const box = $('#accList');
  if (!accounts.length) {
    box.innerHTML = `<div class="empty"><div class="halo"></div><div>还没有账号。点击右上角「添加账号」，粘贴一段 cURL 即可。</div></div>`;
    return;
  }
  box.innerHTML = accounts.map((a) => {
    const s = statusOf(a);
    return `
      <div class="acc-row" data-id="${a.id}">
        <div class="acc-id">
          <div class="avatar">${(a.name || 'A').slice(0, 1).toUpperCase()}</div>
          <div class="acc-meta">
            <div class="acc-name">${esc(a.name)}</div>
            <div class="acc-sub">${esc(a.uid || '未绑定 UID')} · ${a.hasRefresh ? '可自动续期' : '仅当前令牌'}</div>
          </div>
        </div>
        <div class="acc-credit">
          <b>${a.today?.credit ?? 0}</b>
          <span>今日积分</span>
        </div>
        <span class="chip ${s.cls}">${s.txt}</span>
      </div>`;
  }).join('');
}

function renderAccGrid(accounts) {
  const box = $('#accGrid');
  if (!accounts.length) {
    box.innerHTML = `<div class="empty"><div class="halo"></div><div>账号矩阵为空</div></div>`;
    return;
  }
  box.innerHTML = accounts.map((a) => {
    const s = statusOf(a);
    const hist = a.history || [];
    const bars = last14(hist).map((h) => {
      const hh = h.credit > 0 ? Math.min(34, 8 + h.credit / 4) : 4;
      return `<i style="height:${hh}px" title="${h.day} · ${h.credit}"></i>`;
    }).join('');
    return `
      <article class="acc-card" data-id="${a.id}">
        <div class="head">
          <div>
            <div class="name">${esc(a.name)}</div>
            <div class="uid">${esc(mask(a.uid))}</div>
          </div>
          <span class="chip ${s.cls}">${s.txt}</span>
        </div>
        <div class="rows">
          <div class="kv"><span>连签</span><b>${a.streak || 0} 天</b></div>
          <div class="kv"><span>累计积分</span><b>${a.totalCredit || 0}</b></div>
          <div class="kv"><span>最近执行</span><b>${a.lastRun ? timeOf(a.lastRun.at) : '—'}</b></div>
        </div>
        <div class="spark">${bars || '<i style="height:3px"></i>'}</div>
        <div class="foot">
          <button class="mini-btn act-claim" data-id="${a.id}">立即领取</button>
          <button class="mini-btn act-toggle" data-id="${a.id}">${a.enabled ? '暂停' : '启用'}</button>
          <button class="mini-btn act-del" data-id="${a.id}">移除</button>
        </div>
      </article>`;
  }).join('');
}

function last14(hist) {
  const out = [];
  const map = new Map(hist.map((h) => [h.day, h]));
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push(map.get(k) || { day: k, credit: 0 });
  }
  return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mask = (s) => (!s ? '—' : s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
const timeOf = (t) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/* ═══════════ 实时流：逐字 blur 晕开 ═══════════ */
const LIMIT = 160;

function pushLine(item) {
  graphs.forEach((g) => g(item));
}

function streamInto(box) {
  return (item) => {
    if (!box) return;
    const line = document.createElement('div');
    line.className = `line ${item.level || 'info'}`;

    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = timeOf(item.t);
    line.appendChild(ts);

    const tx = document.createElement('span');
    tx.className = 'tx';
    const text = String(item.text || '');
    const frag = document.createDocumentFragment();
    [...text].forEach((ch, i) => {
      const s = document.createElement('span');
      s.className = 'ch';
      s.textContent = ch;
      s.style.animationDelay = `${Math.min(i * 11, 620)}ms`;
      frag.appendChild(s);
    });
    tx.appendChild(frag);
    line.appendChild(tx);

    box.appendChild(line);
    while (box.children.length > LIMIT) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
    const cnt = $('#streamCount');
    if (cnt && box.id === 'consoleMini') cnt.textContent = String(box.children.length);
  };
}

const graphs = [
  streamInto($('#consoleMini')),
  streamInto($('#consoleFull')),
];

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false);
  es.onmessage = (ev) => {
    try {
      const item = JSON.parse(ev.data);
      if (item.id === 'hello') return;
      pushLine(item);
      // 关键事件后刷新状态
      if (item.level === 'run' || item.level === 'ok') refresh();
    } catch {}
  };
}

function setLive(on) {
  const pill = $('#livePill');
  pill.classList.toggle('on', on);
  pill.classList.toggle('off', !on);
  $('#liveText').textContent = on ? '实时在线' : '连接中断';
}

/* ═══════════ 交互 ═══════════ */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 420);
  }, 3200);
}

/* 导航 */
$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
  const view = btn.dataset.view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  const titles = { overview: ['总览', '多账号每日积分自动托管 · 到点静默执行'], accounts: ['账号矩阵', '集中管理全部 WorkBuddy 账号'], pool: ['积分池', '多账号聚合为一个虚拟主账号 · 单一入口调用'], console: ['运行日志', '实时流式输出 · 逐条可追溯'], chat: ['对话', '走统一网关 · 10 个账号自动轮换出额度'], settings: ['策略设置', '执行时刻、重试与续期策略'] };
  $('#viewTitle').textContent = titles[view][0];
  $('#viewSub').textContent = titles[view][1];
  if (view === 'pool') renderPool();
});

/* ═══════════ 积分池 / 统一网关 ═══════════ */
let poolBusy = false;

async function renderPool() {
  if (poolBusy) return;
  poolBusy = true;
  try {
    const [credits, gw] = await Promise.all([
      api('/api/credits'),
      api('/api/gateway').catch(() => null),
    ]);

    const p = credits.pool || {};
    countTo($('#poolTotal'), p.totalCredits || 0);
    $('#poolAccounts').textContent = fmt(p.accounts || 0);
    $('#poolToday').textContent = fmt(p.todayCredit || 0);
    $('#poolCapacity').textContent = fmt(p.dailyCapacity || 0);
    $('#poolStreak').textContent = p.avgStreak ?? 0;
    $('#tipAccountCount').textContent = fmt(p.accounts || 0);
    $('#poolNote').textContent = p.accounts
      ? `${p.online}/${p.accounts} 个账号读取成功 · 顶部数字是每个账号账户里的积分余额合计（含套餐/赠送/奖励），不是每日签到所得`
      : '还没有账号，先去「添加账号」';

    if (gw) {
      $('#gwBase').textContent = gw.baseUrl;
      $('#gwStatus').textContent = gw.running ? '运行中' : '未运行';
      $('#gwStatus').style.color = gw.running ? 'var(--cyan)' : 'var(--rose)';

      $('#gwModels').innerHTML = (gw.models || [])
        .map((m) => `<span class="chip-model">${esc(m)}</span>`).join('');

      const health = gw.health || [];
      const byCredit = {};
      (credits.rows || []).forEach((r) => { byCredit[r.id] = r; });

      $('#gwHealthRows').innerHTML = health.length
        ? health.map((h) => {
          const c = byCredit[h.id] || {};
          const cls = h.cooling ? 'cool' : (h.hasToken && h.enabled ? 'ok' : 'off');
          const label = h.cooling ? '冷却中' : (h.hasToken ? '就绪' : '无令牌');
          return `<tr>
            <td>${esc(h.name || '—')}</td>
            <td><em class="tnum">${fmt(c.totalCredits || 0)}</em></td>
            <td><em class="tnum">${fmt(h.served || 0)}</em></td>
            <td><span class="dotg ${cls}"></span>${label}</td>
          </tr>`;
        }).join('')
        : '<tr><td colspan="4" style="color:var(--t4)">暂无账号</td></tr>';
    } else {
      $('#gwStatus').textContent = '接口不可用';
      $('#gwStatus').style.color = 'var(--rose)';
    }
  } catch (e) {
    $('#poolNote').textContent = '读取失败：' + e.message;
  } finally {
    poolBusy = false;
  }
}

$('#btnCopyBase')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#gwBase').textContent.trim());
    toast('已复制网关地址', 'ok');
  } catch { toast('复制失败，请手动选中', 'err'); }
});

$$('.copy-btn').forEach((b) => b.addEventListener('click', async () => {
  const t = document.getElementById(b.dataset.target);
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t.textContent.trim());
    toast('已复制', 'ok');
  } catch { toast('复制失败，请手动选中', 'err'); }
}));

$('#btnGwRestart')?.addEventListener('click', async () => {
  try {
    await api('/api/gateway/restart', { method: 'POST' });
    toast('网关已重启', 'ok');
    setTimeout(renderPool, 800);
  } catch (e) { toast('重启失败：' + e.message, 'err'); }
});

/* 领取全部 */
$('#btnRunAll').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!STATE.accounts.length) return toast('先添加一个账号', 'err');
  btn.classList.remove('press');
  void btn.offsetWidth;
  btn.classList.add('press');
  btn.disabled = true;
  try {
    await api('/api/claim-all', { method: 'POST', body: {} });
    toast('已完成本轮全部签到', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    refresh();
  }
});

/* 单账号 / 卡片操作 */
document.addEventListener('click', async (e) => {
  const claim = e.target.closest('.act-claim');
  if (claim) {
    e.stopPropagation();
    claim.classList.add('press');
    claim.disabled = true;
    try {
      const r = await api(`/api/accounts/${claim.dataset.id}/claim`, { method: 'POST', body: {} });
      toast(r.result.message, r.result.ok ? 'ok' : 'err');
    } catch (err) { toast(err.message, 'err'); }
    claim.disabled = false;
    return refresh();
  }
  const tog = e.target.closest('.act-toggle');
  if (tog) {
    const a = STATE.accounts.find((x) => x.id === tog.dataset.id);
    if (!a) return;
    await api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { enabled: !a.enabled } });
    return refresh();
  }
  const del = e.target.closest('.act-del');
  if (del) {
    if (!confirm('确定移除该账号？凭据将从本地加密库删除。')) return;
    await api(`/api/accounts/${del.dataset.id}`, { method: 'DELETE' });
    toast('账号已移除');
    return refresh();
  }
});

/* 弹层 */
const scrim = $('#scrim');
function openModal() {
  scrim.classList.add('show');
  $('#modalTip').textContent = '';
  $('#modalTip').className = 'modal-tip';
  setTimeout(() => $('#inName').focus(), 260);
}
function closeModal() {
  scrim.classList.remove('show');
  $('#inRaw').value = '';
  ['#inToken', '#inUid', '#inRefresh', '#inDevice', '#inName'].forEach((s) => { $(s).value = ''; });
}
$('#btnAdd').addEventListener('click', openModal);
$('#btnAdd2').addEventListener('click', openModal);
$('#btnCloseModal').addEventListener('click', closeModal);
$('#btnCancel').addEventListener('click', closeModal);
scrim.addEventListener('click', (e) => { if (e.target === scrim) closeModal(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/* ── 手机号登录（浏览器代登录）── */
let loginTimer = null;
let loginSessionId = null;
function stopLoginPoll() { if (loginTimer) { clearInterval(loginTimer); loginTimer = null; } }
async function cancelLoginSession() {
  if (loginSessionId) { api('/api/login/cancel', { method: 'POST', body: { id: loginSessionId } }).catch(() => {}); }
  stopLoginPoll();
  loginSessionId = null;
  const c = $('#btnPhoneCancel'); if (c) c.style.display = 'none';
}
$('#btnPhoneLogin').addEventListener('click', async () => {
  const tip = $('#loginStatus');
  if (loginSessionId) { toast('登录窗口已打开，请在浏览器里完成登录', 'info'); return; }
  tip.className = 'modal-tip';
  tip.textContent = '正在启动登录窗口…';
  try {
    const r = await api('/api/login/start', { method: 'POST', body: {} });
    loginSessionId = r.id;
    $('#btnPhoneCancel').style.display = '';
    tip.className = 'modal-tip';
    tip.textContent = '已打开登录窗口：输入手机号 → 获取验证码 → 填验证码。登录成功后会自动加号并领取。';
    loginTimer = setInterval(async () => {
      try {
        const st = await api('/api/login/status?id=' + encodeURIComponent(loginSessionId));
        if (st.message) tip.textContent = st.message;
        if (st.state === 'done') {
          stopLoginPoll();
          tip.className = 'modal-tip ok';
          toast(st.message || '登录成功', st.result && st.result.claim && st.result.claim.ok ? 'ok' : 'err');
          refresh();
          loginSessionId = null;
          $('#btnPhoneCancel').style.display = 'none';
          setTimeout(() => closeModal(), 1000);
        } else if (st.state === 'error') {
          stopLoginPoll();
          tip.className = 'modal-tip err';
          tip.textContent = st.message || '登录失败，请重试';
          loginSessionId = null;
          $('#btnPhoneCancel').style.display = 'none';
        }
      } catch (e) {
        stopLoginPoll();
        tip.className = 'modal-tip err';
        tip.textContent = errMsg(e);
        showConnBanner();
        loginSessionId = null;
      }
    }, 2000);
  } catch (e) {
    tip.className = 'modal-tip err';
    tip.textContent = errMsg(e);
    showConnBanner();
  }
});
$('#btnPhoneCancel').addEventListener('click', async () => {
  await cancelLoginSession();
  const tip = $('#loginStatus');
  tip.className = 'modal-tip';
  tip.textContent = '已取消登录';
});
['#btnCloseModal', '#btnCancel'].forEach((sel) => {
  $(sel).addEventListener('click', () => { cancelLoginSession(); });
});

$('#btnSubmit').addEventListener('click', async (e) => {
  e.stopPropagation();
  const btn = e.currentTarget;
  const tip = $('#modalTip');
  const payload = {
    name: $('#inName').value.trim(),
    raw: $('#inRaw').value.trim(),
    accessToken: $('#inToken').value.trim(),
    uid: $('#inUid').value.trim(),
    refreshToken: $('#inRefresh').value.trim(),
    deviceToken: $('#inDevice').value.trim(),
  };
  if (!payload.raw && (!payload.accessToken || !payload.uid)) {
    tip.className = 'modal-tip err';
    tip.textContent = '请粘贴登录后的 cURL（最省事），或填写 accessToken+X-User-Id / Cookie';
    return;
  }
  btn.disabled = true;
  tip.className = 'modal-tip';
  tip.textContent = '正在校验凭据…';
  try {
    const r = await api('/api/accounts', { method: 'POST', body: payload });
    tip.className = 'modal-tip ok';
    tip.textContent = '已添加，开始首次领取…';
    const res = await api(`/api/accounts/${r.account.id}/claim`, { method: 'POST', body: {} });
    if (res.result.ok) {
      tip.className = 'modal-tip ok';
      tip.textContent = `成功：${res.result.message}`;
      toast(`账号「${r.account.name}」${res.result.message}`, 'ok');
      closeModal();
    } else {
      tip.className = 'modal-tip err';
      tip.textContent = res.result.message;
    }
    refresh();
  } catch (err) {
    tip.className = 'modal-tip err';
    tip.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

/* 设置 */
$$('.switch-row').forEach((row) => {
  row.addEventListener('click', () => {
    const sw = row.querySelector('.switch');
    sw.classList.toggle('on');
    const key = row.dataset.key;
    api('/api/settings', { method: 'POST', body: { [key]: sw.classList.contains('on') } }).catch(() => {});
  });
});

$('#btnSaveSettings').addEventListener('click', async (e) => {
  e.currentTarget.classList.add('press');
  try {
    await api('/api/settings', {
      method: 'POST',
      body: {
        claimTime: $('#setTime').value || '00:05',
        jitterMinutes: Number($('#setJitter').value || 0),
        maxRetry: Number($('#setRetry').value || 3),
        endpoint: $('#setEndpoint').value.trim() || 'https://www.workbuddy.cn',
      },
    });
    $('#settingsTip').textContent = '已保存 · 调度已重排';
    toast('策略已保存', 'ok');
    render._filled = false;
    refresh();
  } catch (err) { toast(err.message, 'err'); }
});

/* 导出 */
$('#btnExport').addEventListener('click', () => { window.location.href = '/api/export'; });

/* ═══════════ 对话（统一网关） ═══════════ */
let chatMessages = [];
let chatBusy = false;
let chatRenderTimer = null;

function renderChat() {
  const box = $('#chatLog');
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  if (!chatMessages.length) {
    box.innerHTML = '<div class="chat-empty">在下方输入消息，请求会自动在 10 个账号间轮换。无需切换账号，所有积分合并使用一个入口。</div>';
    return;
  }
  box.innerHTML = chatMessages.map((m) => {
    const text = m.content || (m.role === 'assistant' ? '思考中…' : '');
    return `<div class="chat-bubble ${m.role === 'user' ? 'c-user' : 'c-ai'}">
      <div class="cb-label">${m.role === 'user' ? '你' : 'AI'}</div>
      <div class="cb-text">${esc(text)}</div>
    </div>`;
  }).join('');
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function renderChatThrottled() {
  if (chatRenderTimer) return;
  chatRenderTimer = setTimeout(() => { chatRenderTimer = null; renderChat(); }, 55);
}
async function sendChat() {
  const ta = $('#chatText');
  const text = ta.value.trim();
  if (!text || chatBusy) return;
  ta.value = '';
  chatMessages.push({ role: 'user', content: text });
  chatMessages.push({ role: 'assistant', content: '' });
  renderChat();
  chatBusy = true;
  $('#btnChatSend').disabled = true;
  const port = STATE.settings.gatewayPort || 8789;
  const key = STATE.settings.gatewayKey || '';
  const model = $('#chatModel').value || STATE.settings.defaultModel || 'glm-5.3';
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = 'Bearer ' + key;
  const history = chatMessages.map((m) => ({ role: m.role, content: m.content }));
  const last = chatMessages[chatMessages.length - 1];
  const accEl = $('#chatAcc');
  try {
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model, messages: history, stream: true }) });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      last.content = '⚠️ 网关返回 ' + resp.status + '：' + txt.slice(0, 240);
      return finishChat();
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!raw.startsWith('data:')) continue;
        const d = raw.slice(5).trim();
        if (d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch { continue; }
        const piece = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
        if (piece) last.content += piece;
        if (j.account) accEl.textContent = '本次服务账号：' + j.account;
        renderChatThrottled();
      }
    }
    if (!last.content) last.content = '（无内容返回）';
  } catch (err) {
    last.content = '⚠️ 网络/网关错误：' + err.message;
  } finally {
    finishChat();
  }
}
function finishChat() {
  chatBusy = false;
  const b = $('#btnChatSend'); if (b) b.disabled = false;
  renderChat();
  const box = $('#chatLog'); if (box) box.scrollTop = box.scrollHeight;
}
$('#btnChatSend')?.addEventListener('click', sendChat);
$('#chatText')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$('#nav').addEventListener('click', (e) => {
  if (e.target.closest('.nav-item')?.dataset.view === 'chat') {
    $('#chatGw').textContent = '网关 127.0.0.1:' + (STATE.settings.gatewayPort || 8789);
  }
});

/* 清屏 */
['#btnClearStream', '#btnClearStream2'].forEach((s) => {
  $(s).addEventListener('click', () => {
    ['#consoleMini', '#consoleFull'].forEach((c) => { $(c).innerHTML = ''; });
    $('#streamCount').textContent = '0';
  });
});

/* 时钟 */
function tickClock() {
  const d = new Date();
  $('#clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  $('#clockDate').textContent = d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' });
}
setInterval(tickClock, 1000);

/* ── 启动 ── */
tickClock();
refresh(false);
connectSSE();
api('/api/logs?limit=60').then(({ logs }) => logs.forEach(pushLine)).catch(() => {});
setInterval(() => refresh(), 15000);
checkConn();
setInterval(() => checkConn(), 10000);
