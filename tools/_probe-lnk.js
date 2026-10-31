const fs = require('node:fs');
const out = 'D:\\WB-AutoClaim\\_lnk_test.lnk';
const TARGET = 'C:\\Windows\\System32\\wscript.exe';
const ARGS = '"D:\\WB-AutoClaim\\_lnk_probe.vbs"';
const WORKDIR = 'D:\\WB-AutoClaim';
const ICON = 'D:\\WB-AutoClaim\\assets\\AutoClaim.ico';
function sd(s) { const c = Buffer.alloc(2); const b = Buffer.from(s, 'utf16le'); c.writeUInt16LE(b.length / 2); return Buffer.concat([c, b]); }
function li(t) {
  const lb = Buffer.from(t + '\0', 'ascii'), sf = Buffer.from('\0', 'ascii');
  const vh = Buffer.alloc(16); const vl = Buffer.from('\0', 'ascii');
  vh.writeUInt32LE(16 + vl.length, 0); vh.writeUInt32LE(3, 4); vh.writeUInt32LE(0, 8); vh.writeUInt32LE(16, 12);
  const v = Buffer.concat([vh, vl]); const h = Buffer.alloc(28);
  h.writeUInt32LE(28 + v.length + lb.length + sf.length, 0); h.writeUInt32LE(0x1C, 4); h.writeUInt32LE(1, 8);
  h.writeUInt32LE(28, 12); h.writeUInt32LE(28 + v.length, 16); h.writeUInt32LE(0, 20); h.writeUInt32LE(28 + v.length + lb.length, 24);
  return Buffer.concat([h, v, lb, sf]);
}
function hd() {
  const h = Buffer.alloc(76); h.writeUInt32LE(0x4C, 0);
  Buffer.from([1, 20, 2, 0, 0, 0, 0, 0, 192, 0, 0, 0, 0, 0, 0, 70]).copy(h, 4);
  h.writeUInt32LE(0x02 | 0x04 | 0x10 | 0x20 | 0x40 | 0x80, 20); h.writeUInt32LE(0x20, 24);
  h.writeUInt32LE(0, 56); h.writeUInt32LE(7, 60); return h;
}
fs.writeFileSync(out, Buffer.concat([hd(), li(TARGET), sd('probe'), sd(WORKDIR), sd(ARGS), sd(ICON), Buffer.alloc(4)]));
console.log('test lnk written:', out);
