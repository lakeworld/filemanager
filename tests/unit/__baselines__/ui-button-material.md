<!-- 渲染层按钮面材质棘轮基线（v2.5.8 D13，2026-09-12） -->
<!-- tests/unit/uiInventory.test.ts 读取；更新：UIINV_UPDATE=1 npx vitest run tests/unit/uiInventory.test.ts -->
<!-- 棘轮单向向下：任一文件任一列超基线即红；数变小**不**自动跟码漂移，必须跑上面那条显式落账。终值 = 0 / 空表（D14 逐档收 .btn-*）。 -->

[tint]
# 全站：裸 <button> 贴组件档底色（bg-primary-600 / bg-surface-100 / bg-danger-600）却不属五档 .btn-* 的处数
# 不含 BTN_TINT_BASE_EXEMPT 点名的底座豁免（现 1 处：components/ui/SearchSelect.tsx 的选项行）；= 下表第三列之和
count: 34

[handwritten]
# 列 = 文件 | 手写裸 <button>（不走 .btn-*）处数 | 其中贴组件档底色处数
# 口径 = scripts/scan-ui-inventory.mjs 标签体解析；路径相对 src/renderer/src；清零的文件由 UPDATE 时自动摘掉
- components/ContextMenu.tsx | 1 | 1
- components/DatePicker.tsx | 12 | 5
- components/file-browser/FileBrowserToolbar.tsx | 1 | 0
- components/FileBrowserView.tsx | 8 | 0
- components/FilePreviewModal.tsx | 1 | 0
- components/GlobalDropOverlay.tsx | 6 | 0
- components/Header.tsx | 4 | 4
- components/MoveDialog.tsx | 3 | 0
- components/QuoteFormModal.tsx | 2 | 0
- components/QuoteStatusActions.tsx | 5 | 3
- components/Sidebar.tsx | 5 | 5
- components/TagChip.tsx | 1 | 0
- components/TagInput.tsx | 2 | 2
- components/TitleBar.tsx | 3 | 0
- components/ui/Button.tsx | 1 | 0
- components/ui/SearchSelect.tsx | 2 | 0
- components/ui/SelectionBar.tsx | 2 | 0
- pages/Certs.tsx | 2 | 0
- pages/Clients.tsx | 5 | 0
- pages/Exports.tsx | 3 | 1
- pages/Images.tsx | 1 | 0
- pages/Invoices.tsx | 2 | 0
- pages/invoices/ArchiveField.tsx | 2 | 0
- pages/invoices/BatchIdentifyModal.tsx | 1 | 0
- pages/invoices/InboundCards.tsx | 4 | 1
- pages/invoices/InvoiceCards.tsx | 7 | 2
- pages/invoices/OrphanList.tsx | 2 | 0
- pages/invoices/StagedIdentifyList.tsx | 3 | 0
- pages/Notes.tsx | 2 | 0
- pages/ProductSets.tsx | 5 | 0
- pages/Profile.tsx | 12 | 8
- pages/QuoteDetail.tsx | 2 | 0
- pages/Quotes.tsx | 5 | 1
- pages/Settings.tsx | 21 | 1
- pages/SupplierDetail.tsx | 2 | 0
- pages/Suppliers.tsx | 1 | 0
- pages/Trash.tsx | 2 | 0
- plugins/PluginManagerPage.tsx | 4 | 0
