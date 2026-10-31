// 深挖：账号列表/余额字段/模型/流式对话可用性
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
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': UA,
    Origin: 'https://www.workbuddy.cn',
    Referer: 'https://www.workbuddy.cn/',
  };
  if (acc.accessToken) h.Authorization = `Bearer ${acc.accessToken}`;
  if (acc.uid) h['X-User-Id'] = acc.uid;
  if (acc.cookie) h.Cookie = acc.cookie;
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
    return { status: res.status, body: (await res.text().catch(() => '')).slice(0, 900) };
  } catch (e) { return { status: 0, body: 'ERR ' + e.message }; }
}

(async () => {
  const acc = accounts[0];
  console.log('=== 1. /v2/accounts 完整结构（看是否列出多个账号）===');
  const r1 = await call(acc, 'GET', '/v2/accounts');
  console.log(r1.status, r1.body);

  console.log('\n=== 2. /v2/chat/completions 流式最小请求 ===');
  const r2 = await call(acc, 'POST', '/v2/chat/completions', {
    model: 'claude-sonnet-4-5',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
  });
  console.log(r2.status, r2.body.slice(0, 500));

  console.log('\n=== 3. 找余额：尝试几个语义路由 ===');
  for (const [m, p] of [
    ['GET', '/v2/billing/balance'],
    ['GET', '/v2/billing/credit'],
    ['GET', '/v2/user/credits'],
    ['GET', '/v2/user/credit'],
    ['POST', '/v2/billing/meter/user-usage'],
    ['GET', '/v2/console/accounts'],
    ['GET', '/v2/models'],
    ['GET', '/v2/model/list'],
  ]) {
    const r = await call(acc, m, p);
    console.log(`${String(r.status).padEnd(4)} ${m.padEnd(4)} ${p.padEnd(36)} ${r.body.replace(/\s+/g, ' ').slice(0, 150)}`);
  }
})();
