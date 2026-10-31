#!/usr/bin/env node
/**
 * 把 public/ 下的前端静态资源（index.html / style.css / app.js）
 * 生成为 base64 内联模块 inline-assets.cjs，供 esbuild 打包进单文件 exe。
 *
 * 这样 exe 运行时磁盘上没有 public/ 目录也能正常提供面板，
 * 彻底摆脱 SEA 的 getAsset / sentinel fuse 这套易碎机制。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['index.html', 'style.css', 'app.js'];
const out = {};
for (const f of FILES) {
  const p = path.join(__dirname, 'public', f);
  if (!fs.existsSync(p)) {
    console.error(`警告：缺少前端文件 ${p}，跳过`);
    continue;
  }
  out[f] = fs.readFileSync(p).toString('base64');
}

const banner = '/* 自动生成，勿手改 · 由 gen-inline.cjs 生成，随 exe 内置 */\n';
fs.writeFileSync(
  path.join(__dirname, 'inline-assets.cjs'),
  banner + 'module.exports = ' + JSON.stringify(out, null, 0) + ';\n',
);
console.log(`已生成 inline-assets.cjs · 内置 ${Object.keys(out).join(', ')}`);
