/**
 * 生成标准 Windows .lnk 快捷方式（纯二进制，不调用 COM / 脚本宿主）。
 * 遵循 MS-SHLLINK：ShellLinkHeader + LinkInfo + StringData + ExtraData。
 * 目标为 wscript.exe，参数指向 open-panel.vbs，因此双击无黑窗、可自定义图标。
 */
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = process.argv[2] || 'D:\\desk';
const LNK_NAME = 'WorkBuddy ' + String.fromCharCode(0x79EF, 0x5206, 0x6258, 0x7BA1) + '.lnk';

const TARGET = 'C:\\Windows\\System32\\wscript.exe';
const ARGS = '"D:\\WB-AutoClaim\\open-panel.vbs"';
const WORKDIR = 'D:\\WB-AutoClaim';
const ICON = 'D:\\WB-AutoClaim\\assets\\AutoClaim.ico';
const NAME = 'WorkBuddy ' + String.fromCharCode(0x65E5, 0x5E38, 0x79EF, 0x5206, 0x81EA, 0x52A8, 0x6258, 0x7BA1);

/* ── StringData：CountCharacters(2) + UTF-16LE ── */
function stringData(s) {
  const cnt = Buffer.alloc(2);
  const body = Buffer.from(s, 'utf16le');
  cnt.writeUInt16LE(body.length / 2, 0);
  return Buffer.concat([cnt, body]);
}

/* ── LinkInfo：VolumeID + LocalBasePath + CommonPathSuffix ── */
function buildLinkInfo(target) {
  const localBase = Buffer.from(target + '\0', 'ascii');
  const suffix = Buffer.from('\0', 'ascii');

  const volumeLabel = Buffer.from('\0', 'ascii'); // 空卷标
  const volHeader = Buffer.alloc(16);
  volHeader.writeUInt32LE(16 + volumeLabel.length, 0); // VolumeIDSize
  volHeader.writeUInt32LE(3, 4);                      // DriveType = DRIVE_FIXED
  volHeader.writeUInt32LE(0, 8);                      // DriveSerialNumber
  volHeader.writeUInt32LE(16, 12);                    // VolumeLabelOffset (ANSI)
  const volumeID = Buffer.concat([volHeader, volumeLabel]);

  const header = Buffer.alloc(28);
  header.writeUInt32LE(28 + volumeID.length + localBase.length + suffix.length, 0); // LinkInfoSize
  header.writeUInt32LE(0x1C, 4);                                                    // LinkInfoHeaderSize
  header.writeUInt32LE(1, 8);                                                       // VolumeIDAndLocalBasePath
  header.writeUInt32LE(28, 12);                                                     // VolumeIDOffset
  header.writeUInt32LE(28 + volumeID.length, 16);                                   // LocalBasePathOffset
  header.writeUInt32LE(0, 20);                                                      // CNRLOffset
  header.writeUInt32LE(28 + volumeID.length + localBase.length, 24);                // CommonPathSuffixOffset

  return Buffer.concat([header, volumeID, localBase, suffix]);
}

/* ── ShellLinkHeader (76 bytes) ── */
function buildHeader(flags, iconIndex, showCommand) {
  const h = Buffer.alloc(76);
  h.writeUInt32LE(0x0000004C, 0);                        // HeaderSize
  Buffer.from([
    0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
  ]).copy(h, 4);                                         // LinkCLSID
  h.writeUInt32LE(flags, 20);                            // LinkFlags
  h.writeUInt32LE(0x00000020, 24);                       // FileAttributes = ARCHIVE
  // CreationTime / AccessTime / WriteTime / FileSize 保持 0
  h.writeUInt32LE(iconIndex, 56);                        // IconIndex
  h.writeUInt32LE(showCommand, 60);                      // ShowCommand
  return h;
}

const HasLinkInfo = 0x00000002;
const HasName = 0x00000004;
const HasWorkingDir = 0x00000010;
const HasArguments = 0x00000020;
const HasIconLocation = 0x00000040;
const IsUnicode = 0x00000080;
const flags = HasLinkInfo | HasName | HasWorkingDir | HasArguments | HasIconLocation | IsUnicode;

const SW_SHOWMINNOACTIVE = 7;
const lnk = Buffer.concat([
  buildHeader(flags, 0, SW_SHOWMINNOACTIVE),
  buildLinkInfo(TARGET),
  stringData(NAME),        // NAME_STRING
  stringData(WORKDIR),     // WORKING_DIR
  stringData(ARGS),        // COMMAND_LINE_ARGUMENTS
  stringData(ICON),        // ICON_LOCATION
  Buffer.alloc(4),         // ExtraData terminal block
]);

const out = path.join(DESKTOP, LNK_NAME);
fs.mkdirSync(DESKTOP, { recursive: true });
fs.writeFileSync(out, lnk);
console.log('LNK :', out);
console.log('SIZE:', lnk.length, 'bytes');
console.log('NAME:', LNK_NAME);
