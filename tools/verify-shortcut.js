/** 只读解析 .lnk（MS-SHLLINK），先用系统自带 lnk 校准，再校验我们生成的快捷方式。 */
const fs = require('node:fs');

function readAsciiZ(b, off) {
  let e = off;
  while (e < b.length && b[e] !== 0) e++;
  return b.subarray(off, e).toString('ascii');
}

function parse(buf) {
  const out = {};
  const headerSize = buf.readUInt32LE(0);
  out.headerSize = headerSize;
  out.clsid = buf.subarray(4, 20).toString('hex');
  const flags = buf.readUInt32LE(20);
  out.flags = '0x' + flags.toString(16);
  out.fileAttributes = '0x' + buf.readUInt32LE(24).toString(16);
  out.iconIndex = buf.readUInt32LE(56);
  out.showCommand = buf.readUInt32LE(60);

  let o = headerSize;
  if (flags & 0x1) { // HasLinkTargetIDList
    const sz = buf.readUInt16LE(o);
    out.idListBytes = sz;
    o += 2 + sz;
  }
  if (flags & 0x2) { // HasLinkInfo
    const li = o;
    const liSize = buf.readUInt32LE(li);
    const liHeader = buf.readUInt32LE(li + 4);
    const liFlags = buf.readUInt32LE(li + 8);
    const volOff = buf.readUInt32LE(li + 12);
    const baseOff = buf.readUInt32LE(li + 16);
    const cnrOff = buf.readUInt32LE(li + 20);
    const sfxOff = buf.readUInt32LE(li + 24);
    out.linkInfo = {
      size: liSize, headerSize: liHeader, flags: liFlags,
      volumeIDOffset: volOff, localBasePathOffset: baseOff,
      cnrOffset: cnrOff, suffixOffset: sfxOff,
      localBasePath: readAsciiZ(buf, li + baseOff),
      suffix: readAsciiZ(buf, li + sfxOff),
      volumeIDSize: buf.readUInt32LE(li + volOff),
      driveType: buf.readUInt32LE(li + volOff + 4),
    };
    o = li + liSize;
  }

  const unicode = !!(flags & 0x80);
  out.unicode = unicode;
  const readStr = () => {
    const n = buf.readUInt16LE(o); o += 2;
    const s = unicode
      ? buf.subarray(o, o + n * 2).toString('utf16le')
      : readAsciiZ(buf, o);
    o += unicode ? n * 2 : n + 1;
    return s;
  };
  out.strings = {};
  if (flags & 0x4) out.strings.name = readStr();
  if (flags & 0x8) out.strings.relativePath = readStr();
  if (flags & 0x10) out.strings.workingDir = readStr();
  if (flags & 0x20) out.strings.arguments = readStr();
  if (flags & 0x40) out.strings.iconLocation = readStr();
  out.bytesConsumed = o;
  out.totalBytes = buf.length;
  return out;
}

const files = process.argv.slice(2);
for (const f of files) {
  const label = f.includes('Edge') ? '[REFERENCE system lnk]' : '[OUR generated lnk]';
  console.log('\n' + label + '  ' + f);
  try {
    const j = parse(fs.readFileSync(f));
    console.log(JSON.stringify(j, null, 2));
  } catch (e) {
    console.log('PARSE ERROR: ' + e.message);
  }
}
