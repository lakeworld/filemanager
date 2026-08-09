/**
 * -webkit-app-region 类型补充（P1-8 as any 清理）：
 * Electron 无边框窗口拖拽区专用属性，csstype 未收录该键，
 * 通过模块扩充使 style={{ "-webkit-app-region": ... }} 直接通过类型检查，
 * 各页面不再需要 `as any` 断言。取值与 Chromium 一致：drag / no-drag。
 */
import "csstype";

declare module "csstype" {
  interface PropertiesHyphen {
    "-webkit-app-region"?: "drag" | "no-drag";
  }
}
