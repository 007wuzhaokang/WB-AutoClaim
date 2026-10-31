// 全量：并发跑所有账号的签到/额度状态，并展开完整 data 字段找余额
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const KEY = Buffer.from(fs.readFileSync(path.join(ROOT, 'data', 'vault.key'), 'utf8').trim(), 'hex');
function openVault(buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}
const st = openVault(fs.readFileSync(path.join(ROOT, 'data', 'vault.enc')));
const accounts = (st.accounts || []).filter((a) => a.accessToken);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function hdr(acc) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA, Origin: 'https://www.workbuddy.cn', Referer: 'https://www.workbuddy.cn/' };
  if (acc.accessToken) h.Authorization = `Bearer ${acc.accessToken}`;
  if (acc.uid) h['X-User-Id'] = acc.uid;
  if (acc.deviceToken) h['X-Device-Token'] = acc.deviceToken;
  return h;
}
async function call(acc, method, p, body) {
  const base = (acc.endpoint || 'https://www.workbuddy.cn').replace(/\/+$/, '');
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const res = await fetch(base + p, { method, headers: hdr(acc), body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    clearTimeout(t);
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch (e) { return { status: 0, json: null, err: e.message }; }
}

(async () => {
  console.log('=== A. checkin-activity-status 完整字段（首个账号）===');
  const a0 = accounts[0];
  const r = await call(a0, 'POST', '/v2/billing/meter/checkin-activity-status', {});
  console.log(JSON.stringify(r.json, null, 2).slice(0, 1400));

  console.log('\n=== B. 10 个账号并发签到状态汇总 ===');
  const rows = await Promise.all(accounts.map(async (a) => {
    const x = await call(a, 'POST', '/v2/billing/meter/checkin-activity-status', {});
    const d = x.json?.data || {};
    return {
      name: a.name,
      uid: (a.uid || '').slice(0, 8),
      http: x.status,
      active: d.active,
      todayChecked: d.today_checked_in,
      streak: d.streak_days,
      daily: d.daily_credit,
      today: d.today_credit,
    };
  }));
  console.table(rows);

  console.log('\n=== C. 全模型扫描（首个账号，逐个试）===');
  const ALL = ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5.3-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-0731', 'deepseek-v4-pro-0813',
    'kimi-k2.6', 'kimi-k2.5', 'kimi-k2.7-code', 'kimi-k3', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-oss-120b', 'gpt-oss-20b', 'claude35'];
  const avail = [];
  for (const m of ALL) {
    const x = await call(a0, 'POST', '/v2/chat/completions', { model: m, stream: false, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 });
    const code = x.json?.code;
    // 400 + 11102 = 模型不可用；非流式会报 11101，说明模型本身存在
    const exists = x.status === 200 || code === 11101;
    if (exists) { avail.push(m); console.log(`  AVAILABLE  ${m}`); }
  }
  console.log(`\n可用模型共 ${avail.length} 个：${avail.join(', ')}`);
  fs.writeFileSync(path.join(ROOT, 'data', 'models-cache.json'), JSON.stringify({ at: Date.now(), models: avail }, null, 2));
  console.log('已缓存到 data/models-cache.json');
})();
