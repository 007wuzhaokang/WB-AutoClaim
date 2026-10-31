/**
 * 生成 AutoClaim 专属图标：极光渐变圆角方 + 对勾。
 * 输出多尺寸 ICO（PNG 压缩，Vista+ 支持）与一张 256px PNG 预览。
 * 零依赖，仅用 Node 内置 zlib。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets');
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ── PNG 编码 ── */
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1);
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const dst = y * (1 + w * 4);
    raw[dst] = 0; // filter: none
    rgba.copy(raw, dst + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── 绘制 ── */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;

function gradient(t) {
  const stops = [
    [0.00, [124, 108, 246]], // violet
    [0.40, [ 79,  70, 229]], // indigo
    [0.76, [ 42, 150, 214]], // blue
    [1.00, [ 34, 211, 238]], // cyan
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      return [mix(c0[0], c1[0], k), mix(c0[1], c1[1], k), mix(c0[2], c1[2], k)];
    }
  }
  return stops[stops.length - 1][1];
}

function sdRoundBox(px, py, hw, hh, r) {
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0, 1);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function render(S) {
  const rgba = Buffer.alloc(S * S * 4);
  const small = S <= 32;
  const radius = small ? 0.19 : 0.225;
  const halfBox = 0.5 - 0.025;
  const stroke = small ? 0.072 : 0.056;
  // 对勾：左中 → 下中 → 右上
  const P1 = [-0.265, 0.005], P2 = [-0.075, 0.195], P3 = [0.255, -0.205];
  const SS = 3; // 超采样

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / S - 0.5;
          const py = (y + (sy + 0.5) / SS) / S - 0.5;

          const dBox = sdRoundBox(px, py, halfBox, halfBox, radius);
          const aBox = clamp(0.5 - dBox * S, 0, 1);
          if (aBox <= 0) continue;

          let t = clamp((px + py) * 0.62 + 0.5, 0, 1);
          let [cr, cg, cb] = gradient(t);

          // 右下角暖色光晕
          const amber = Math.exp(-(((px - 0.32) ** 2 + (py - 0.34) ** 2) / 0.045)) * 0.28;
          cr = mix(cr, 255, amber); cg = mix(cg, 183, amber); cb = mix(cb, 92, amber);

          // 顶部高光 / 底部压暗，制造微明度层次
          const hi = Math.pow(clamp(0.5 - py * 1.25, 0, 1), 2) * 0.13;
          cr = mix(cr, 255, hi); cg = mix(cg, 255, hi); cb = mix(cb, 255, hi);
          const lo = clamp((py - 0.05) * 0.55, 0, 1) * 0.20;
          cr *= (1 - lo); cg *= (1 - lo); cb *= (1 - lo);

          // 对勾
          const d1 = sdSegment(px, py, P1[0], P1[1], P2[0], P2[1]);
          const d2 = sdSegment(px, py, P2[0], P2[1], P3[0], P3[1]);
          const dMark = Math.min(d1, d2) - stroke;
          const aMark = clamp(0.5 - dMark * S, 0, 1);
          const aGlow = clamp(0.5 - (dMark - 0.018) * S, 0, 1) * 0.12 * (1 - aMark);

          const glow = aGlow;
          cr = mix(cr, 255, glow); cg = mix(cg, 255, glow); cb = mix(cb, 255, glow);
          cr = mix(cr, 255, aMark); cg = mix(cg, 255, aMark); cb = mix(cb, 255, aMark);

          const w = aBox / (SS * SS);
          r += cr * w; g += cg * w; b += cb * w; a += aBox / (SS * SS);
        }
      }
      const i = (y * S + x) * 4;
      // 预乘还原：渐变只在 box 内累积，除以 alpha 得到正确颜色
      const alpha = clamp(a, 0, 1);
      rgba[i]     = alpha > 0 ? clamp(r / alpha, 0, 255) : 0;
      rgba[i + 1] = alpha > 0 ? clamp(g / alpha, 0, 255) : 0;
      rgba[i + 2] = alpha > 0 ? clamp(b / alpha, 0, 255) : 0;
      rgba[i + 3] = clamp(alpha * 255, 0, 255);
    }
  }
  return rgba;
}

/* ── ICO 封装（多尺寸 PNG 条目）── */
function buildICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + 16 * images.length;
  const entries = [];
  for (const im of images) {
    const e = Buffer.alloc(16);
    e[0] = im.size >= 256 ? 0 : im.size;
    e[1] = im.size >= 256 ? 0 : im.size;
    e[2] = 0; e[3] = 0;                 // colors, reserved
    e.writeUInt16LE(1, 4);              // planes
    e.writeUInt16LE(32, 6);             // bit count
    e.writeUInt32LE(im.png.length, 8);  // bytes in res
    e.writeUInt32LE(offset, 12);        // offset
    offset += im.png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const sizes = [256, 64, 48, 32, 16];
const images = sizes.map((size) => ({ size, png: encodePNG(size, size, render(size)) }));

const icoPath = path.join(OUT_DIR, 'AutoClaim.ico');
const pngPath = path.join(OUT_DIR, 'AutoClaim-preview.png');
fs.writeFileSync(icoPath, buildICO(images));
fs.writeFileSync(pngPath, images[0].png);
console.log('ICO :', icoPath, fs.statSync(icoPath).size, 'bytes');
console.log('PNG :', pngPath, fs.statSync(pngPath).size, 'bytes');
console.log('sizes:', sizes.join(', '));
