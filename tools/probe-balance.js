// 用本地 vault 里的真实令牌，实测「积分余额 / 额度」类接口
// 只打印路由与脱敏摘要，绝不输出令牌原文
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const KEY = Buffer.from(fs.readFileSync(path.join(ROOT, 'data', 'vault.key'), 'utf8').trim(), 'hex');

function openVault(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
}

const st = openVault(fs.readFileSync(path.join(ROOT, 'data', 'vault.enc')));
const accounts = st.accounts || [];
console.log('accounts in vault:', accounts.length);

function mask(t) {
  const s = String(t || '');
  return s.length <= 12 ? '(short)' : `${s.slice(0, 6)}...${s.slice(-4)} len=${s.length}`;
}

const usable = accounts.filter((a) => a.accessToken || a.cookie);
console.log('with credentials:', usable.length);
accounts.forEach((a) => {
  console.log(`  - ${a.name} uid=${a.uid || '-'} token=${mask(a.accessToken)} cookie=${a.cookie ? 'yes' : '-'}`);
});

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const CANDIDATES = [
  ['POST', '/v2/billing/meter/get-enterprise-user-usage'],
  ['POST', '/v2/billing/meter/checkin-activity-status'],
  ['POST', '/v2/billing/meter/checkin-status'],
  ['GET', '/v2/accounts'],
  ['GET', '/v2/user/cloudagent/quota'],
  ['GET', '/v3/config'],
  ['GET', '/v1/config'],
  ['POST', '/v2/chat/completions'],
];

async function probe(acc, method, p) {
  const base = (acc.endpoint || 'https://www.workbuddy.cn').replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': UA,
    Origin: 'https://www.workbuddy.cn',
    Referer: 'https://www.workbuddy.cn/',
  };
  if (acc.accessToken) headers.Authorization = `Bearer ${acc.accessToken}`;
  if (acc.uid) headers['X-User-Id'] = acc.uid;
  if (acc.cookie) headers.Cookie = acc.cookie;
  if (acc.deviceToken) headers['X-Device-Token'] = acc.deviceToken;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch(base + p, {
      method,
      headers,
      body: method === 'POST' ? '{}' : undefined,
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const txt = await res.text().catch(() => '');
    return { status: res.status, body: txt.slice(0, 220) };
  } catch (e) {
    return { status: 0, body: 'ERR ' + e.message };
  }
}

(async () => {
  const target = usable[0];
  if (!target) {
    console.log('\n没有可用凭据账号，跳过实测');
    return;
  }
  console.log(`\n== 用账号「${target.name}」实测 ${CANDIDATES.length} 条候选路由 ==`);
  for (const [m, p] of CANDIDATES) {
    const r = await probe(target, m, p);
    const flag = r.status === 200 ? 'HIT ' : r.status === 401 ? 'auth' : r.status === 404 ? '----' : ' ?? ';
    console.log(`${flag} ${r.status}  ${m.padEnd(4)} ${p}`);
    console.log(`      ${r.body.replace(/\s+/g, ' ')}`);
  }
})();
