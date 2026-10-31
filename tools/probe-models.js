// 逐个试模型：确认 /v2/chat/completions 流式是否可被账号令牌调用（即积分能否被 API 消耗）
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

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['claude-sonnet-4.6', 'claude-opus-4-7', 'glm-5.3', 'deepseek-v4-pro', 'kimi-k2.6', 'gpt-5.6-terra', 'qwen-token-plan-cn', 'gpt-5.5'];

async function tryModel(acc, model) {
  const base = (acc.endpoint || 'https://www.workbuddy.cn').replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': UA,
    Origin: 'https://www.workbuddy.cn',
    Referer: 'https://www.workbuddy.cn/',
    Authorization: `Bearer ${acc.accessToken}`,
  };
  if (acc.uid) headers['X-User-Id'] = acc.uid;
  if (acc.deviceToken) headers['X-Device-Token'] = acc.deviceToken;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    const res = await fetch(base + '/v2/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
      }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const txt = await res.text().catch(() => '');
    return { status: res.status, body: txt.slice(0, 300) };
  } catch (e) {
    return { status: 0, body: 'ERR ' + e.message };
  }
}

(async () => {
  const acc = accounts[0];
  console.log(`账号「${acc.name}」测试 ${MODELS.length} 个模型（max_tokens=16，消耗极低）\n`);
  const results = [];
  for (const m of MODELS) {
    const r = await tryModel(acc, m);
    const code = (r.body.match(/"code":(\d+)/) || [])[1] || '';
    const msg = (r.body.match(/"msg":"([^"]{0,70})"/) || [])[1] || '';
    const ok4xx = r.status === 200;
    console.log(`${ok4xx ? 'OK  ' : '--  '} ${String(r.status).padEnd(4)} ${m.padEnd(24)} code=${code.padEnd(6)} ${msg}`);
    if (ok4xx) console.log(`       ${r.body.replace(/\s+/g, ' ').slice(0, 220)}`);
    results.push({ m, r });
  }
  const hit = results.find((x) => x.r.status === 200);
  console.log(`\n结论：${hit ? '模型「' + hit.m + '」可用 —— 积分可被 API 消耗，统一网关方案成立' : '未找到可用模型'}`);
})();
