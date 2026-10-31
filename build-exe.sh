#!/usr/bin/env bash
# 一键重建 WB-AutoClaim 单文件 exe（SEA + esbuild + postject + rcedit）
set -e
cd "$(dirname "$0")"

ESBUILD=./node_modules/@esbuild/win32-x64/esbuild.exe
NODE_EXE="$(which node)"
POSTJECT="node node_modules/postject/dist/cli.js"
RCEDIT=./build/tools/rcedit.exe
ICON=build/icon.ico
OUT=dist/WB-AutoClaim.exe

echo "[0/5] 生成内置前端资源 inline-assets.cjs"
node gen-inline.cjs

echo "[1/5] esbuild 打包 server.js -> dist/bundle.cjs"
"$ESBUILD" server.js --bundle --platform=node --format=cjs --target=node18 --outfile=dist/bundle.cjs --define:process.env.WB_EXE='"1"'

echo "[2/5] 生成 SEA blob"
node --experimental-sea-config sea-config.json

echo "[3/5] 复制 node.exe -> $OUT"
cp -f "$NODE_EXE" "$OUT"

echo "[4/5] rcedit 嵌图标+版本"
# 刚 cp 出来的 exe 偶尔被 Defender/索引短暂占用，rcedit 会报 "Unable to commit changes"，
# 这里重试几次即可（实测第二次就能成功）
retry_rcedit() {
  local i=0
  until "$RCEDIT" "$@"; do
    i=$((i + 1))
    if [ "$i" -ge 8 ]; then echo "rcedit 失败（已重试 $i 次）：$*"; return 1; fi
    sleep 1
  done
}
retry_rcedit "$OUT" --set-icon "$ICON"
retry_rcedit "$OUT" --set-version-string "ProductName" "WB-AutoClaim"
retry_rcedit "$OUT" --set-version-string "FileDescription" "WorkBuddy 积分托管 成长任务自动化"

echo "[5/5] postject 注入 blob"
node node_modules/postject/dist/cli.js "$OUT" NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

echo "完成：$OUT ($(stat -c%s "$OUT") bytes)"
