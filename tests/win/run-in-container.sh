#!/usr/bin/env bash
# 容器侧执行链（qihe-win 镜像内）：装依赖 → 备 wine 前缀 → 起虚拟屏 → 跑冒烟驱动。
# 由 $HOME/qihe-docker/win-test.sh 调用（宿主侧只管挂载与镜像），也可手工：
#   docker run --rm -v <repo>:/work -v qihe-win-box-prefix:/wine/prefix -e WINEPREFIX=/wine/prefix \
#     --shm-size=1g qihe-win bash tests/win/run-in-container.sh [--keep-app]
# 单独放一个文件的原因：这些命令要经「宿主 bash → docker bash -lc → 容器 bash」三层引号，
# xvfb-run 的 -s "-screen 0 1920x1080x24" 在多层引号里必然被打散（实测报 need a command to run）。
set -euo pipefail
cd "$(dirname "$0")/../.."

# 依赖装进命名卷（沿用 dev-test.sh 的 .qihe-installed 标记口径，坚果云目录零写入）
if [ ! -f node_modules/.qihe-installed ]; then
  echo "[win-smoke] 容器内首次：npm ci（依赖在命名卷，之后复用）"
  npm ci --no-audit --no-fund
  touch node_modules/.qihe-installed
fi

# wine 前缀（卷复用；首跑约 1–2 分钟）
# 前缀必须**等 wineserver 退出**再用：wineboot --init 是异步的，立刻起应用会拿到半初始化的
# 前缀，表现为 kernel32.dll c0000135 或应用卡在路径解析循环里（实测 2026-09-08 踩过两次）。
if [ ! -f "${WINEPREFIX:-/wine/prefix}/drive_c/windows/system32/kernel32.dll" ]; then
  echo "[win-smoke] 初始化 wine 前缀（约 1–2 分钟，之后走卷复用）"
  wineboot --init
  wineserver -w
fi

# 显式指定虚拟屏尺寸与色深：xvfb-run 默认 640x480x8，Chromium 在该屏下起得极慢（实测 2 分钟才绑 CDP 端口）
# 且窗口尺寸断言会被限死；与 box CI e2e 作业同写法（.github/workflows/ci.yml）。
# 证据目录由容器内 root 写出 ⇒ 跑完交还宿主 uid，否则下次宿主侧/旁路跑写不进去（实测 EACCES）
xvfb-run -a --server-args="-screen 0 1920x1080x24" node tests/win/wine-smoke.mjs "$@"
rc=$?
chown -R 1000:1000 docs/INTERNAL/assets/win-smoke /tmp/win-smoke 2>/dev/null || true
exit $rc
