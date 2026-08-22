/**
 * 发票识别测试夹具 · 渲染层占位模块。
 * build-hello-plugin.mjs 要求 src/renderer 至少一个 .ts/.js 模块；本插件 kind 无 pages，
 * 该模块不会被宿主加载，仅用于满足构建要求（返回 null 的空组件，零依赖）。
 */
export default function Noop(): null {
  return null
}
