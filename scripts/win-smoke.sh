#!/usr/bin/env bash
# test:win 入口 —— Windows/wine 冒烟门禁（W1b，2026-09-08 Windows 测试约定）
#
# 分工：本脚本只做「定位容器 runner + 前置检查」，真正的起包/断言在
#   tests/win/wine-smoke.mjs（容器内跑），runner 在 $QIHE_DOCKER_HOME/win-test.sh。
# 为什么 runner 不放本仓：Docker 镜像与宿主脚本按 2026-09-05 既定约定**不进坚果云同步目录**
#   （镜像层/卷/构建日志都落在 $HOME/qihe-docker，见 LOG 2026-09-05「Docker 开发/测试环境上线」）。
#
# 用法：npm run test:win            # 全链冒烟（起包 → CDP → Windows 使用链 → 日志体检）
#       npm run test:win -- --shell # 进容器手工调
#       npm run test:win -- --keep-app
#       npm run test:win -- --host-wine  # 旁路：用宿主 wine 跑同一套断言（见下）
# 前置：release/win-unpacked 必须是**本次构建**的产物（新鲜度由 W1a check:win-artifact 把关）：
#       npm run build && npx electron-builder --win dir --publish never -c.win.signAndEditExecutable=false
#
# 两个后端（断言完全相同，只是 wine 在哪跑）：
#   docker（默认，目标形态）  —— 镜像 qihe-win 里的 WineHQ wine。
#   --host-wine（应急旁路）   —— 本机已装好的 wine（$QIHE_HOST_WINE，默认 ~/bin/wine）+ $QIHE_HOST_WINEPREFIX。
#     为什么要这条：2026-09-08 实测宿主 deepin-wine 10.14 上 27 项全绿，而容器内 WineHQ wine 起包后
#     DevTools 的 HTTP/WS 永不回包（已排除项与排查表见内部 Windows 测试守则 §七/§八）。
#     ⚠ 旁路只让门禁今天能跑，**不等于** Docker 形态已通；留证与播报必须分清两条（SOP §二 红线）。
set -euo pipefail

DOCK_HOME="${QIHE_DOCKER_HOME:-$HOME/qihe-docker}"
RUNNER="$DOCK_HOME/win-test.sh"
BACKEND="${QIHE_WIN_BACKEND:-docker}"
ARGS=()
for a in "$@"; do
  case "$a" in
    --host-wine) BACKEND="host" ;;
    --docker) BACKEND="docker" ;;
    *) ARGS+=("$a") ;;
  esac
done
if [ ${#ARGS[@]} -gt 0 ]; then set -- "${ARGS[@]}"; else set --; fi

if [ "$BACKEND" = host ]; then
  HOSTWINE="${QIHE_HOST_WINE:-$HOME/bin/wine}"
  [ -x "$HOSTWINE" ] || { echo "[test:win] 宿主 wine 不存在或不可执行：$HOSTWINE（用 QIHE_HOST_WINE=<path> 指定）" >&2; exit 2; }
  [ -n "${QIHE_HOST_WINEPREFIX:-}" ] || export QIHE_HOST_WINEPREFIX="$HOME/.qhe-winprobe"
  export WINEPREFIX="$QIHE_HOST_WINEPREFIX"
  export PATH="$(dirname "$HOSTWINE"):$PATH"
  echo "[test:win] 旁路后端：宿主 wine $(wine --version 2>/dev/null) · 前缀 $WINEPREFIX"
  # 证据单独落 host-wine/ 目录：容器形态（latest/）与旁路形态永远是两份证据，不许互相冒充
  exec node tests/win/wine-smoke.mjs --artifacts docs/INTERNAL/assets/win-smoke/host-wine "$@"
fi

if [ ! -f "$RUNNER" ]; then
  echo "[test:win] 缺容器 runner：$RUNNER" >&2
  echo "           用 QIHE_DOCKER_HOME=<dir> 指定 docker 家目录（镜像定义在 \$dir/image/Dockerfile.qihe-win）" >&2
  exit 2
fi

# 产物缺失时给一条可照抄的出包命令（不自动构建：打包是发布动作，须人主导）
if [ ! -d "release/win-unpacked" ]; then
  echo "[test:win] 缺 release/win-unpacked，先出包：" >&2
  echo "  npm run build && npx electron-builder --win dir --publish never -c.win.signAndEditExecutable=false" >&2
  exit 2
fi

exec bash "$RUNNER" "$@"
