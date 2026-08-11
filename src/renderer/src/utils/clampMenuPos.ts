/**
 * 右键菜单视口边缘钳制（v2.4.8 打磨轮引入，本次抽为纯函数便于 node 直测）。
 *
 * 设计要点：
 * - 永不产出 NaN/Infinity：坐标非有限时回退边距；视口/菜单尺寸非有限时跳过钳制。
 *   （NaN 写进 style 会被浏览器丢弃，fixed 元素失去 left/top 回退静态位置——
 *   这是「菜单撑满界面」失效链的一环，必须在此掐断。）
 * - 常规路径：菜单实测尺寸 + 边距，超出视口右侧/底部则内移；极小窗口至少保留左边距。
 */

export interface MenuPos {
  left: number;
  top: number;
}

export function clampMenuPos(
  x: number,
  y: number,
  width: number,
  height: number,
  innerW: number,
  innerH: number,
  margin = 8,
): MenuPos {
  const safeX = Number.isFinite(x) ? x : margin;
  const safeY = Number.isFinite(y) ? y : margin;
  if (![width, height, innerW, innerH].every(Number.isFinite)) {
    return { left: safeX, top: safeY };
  }
  return {
    left: Math.max(margin, Math.min(safeX, innerW - width - margin)),
    top: Math.max(margin, Math.min(safeY, innerH - height - margin)),
  };
}
