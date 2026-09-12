<!-- 渲染层按钮面材质棘轮基线（v2.5.8 D13，2026-09-12） -->
<!-- tests/unit/uiInventory.test.ts 读取；更新：UIINV_UPDATE=1 npx vitest run tests/unit/uiInventory.test.ts -->
<!-- 棘轮单向向下：任一文件任一列超基线即红；数变小**不**自动跟码漂移，必须跑上面那条显式落账。终值 = 0 / 空表（D14 逐档收 .btn-*）。 -->

[tint]
# 全站：裸 <button> 贴组件档**基态**底色（bg-primary-600 / bg-surface-100 / bg-danger-600）
# 却不裸挂 .btn-* 五档、也不挂形状具名档的处数（变体前缀如 hover:bg-* 不算；底座内部另有 BTN_BASE_INTERNAL 钉死）
count: 0

[handwritten]
# 列 = 文件 | 真欠账裸 <button>（既不走 .btn-* 五档、也不走形状具名档）处数 | 其中贴组件档基态底色处数
# 口径 = scripts/scan-ui-inventory.mjs 标签体解析；路径相对 src/renderer/src；清零的文件由 UPDATE 时自动摘掉
- components/DatePicker.tsx | 1 | 0
- pages/Clients.tsx | 1 | 0
- pages/Notes.tsx | 1 | 0
- pages/Quotes.tsx | 1 | 0
- plugins/PluginManagerPage.tsx | 2 | 0
