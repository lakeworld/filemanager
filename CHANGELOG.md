# 更新日志

## v1.3.0 — 2026-08-05（开源版）

### 开源免费化

- **转为开源免费软件**：移除全部授权逻辑（激活 / 设备绑定 / 远程状态校验），`internal/license/license.go::Check()` 恒返回已激活（`OpenEdition` 开关，前端零改动）
- **剥离敏感与商业资产**：代码签名证书私钥（`certs/`）、授权服务器（`license-server/`）自仓库移除，`git` 历史重建为干净起点
- 无需 License Key，下载即用全部功能

## v1.2.5 — 2026-06-26

### 代码签名

- **自签名代码签名**：exe 和 installer 现在使用自签名证书签名，属性显示发布者「启禾软件」（不再是"未知发布者"）
- 新增 `scripts/generate-cert.sh`：一键生成自签名代码签名证书（RSA 4096，10 年有效）
- `build-server.sh` 构建后自动调用 `osslsigncode` 签名 exe + installer
- 用户安装 `code-signing.crt` 到受信任根后可消除本地 SmartScreen 警告

### 版本号

- 安装包文件名包含版本号：`qihefilemanager-1.2.5-amd64-installer.exe`
- 同时保留固定名 `qihefilemanager-amd64-installer.exe` 作为稳定下载链接

### 其他

- 更新检查 URL 从 `/box/version.json` 改为 `/version.json`（官网合并进 ERP SPA 后）
- `version.json` 产物路径改为 `web/public/version.json`

---

## v1.0.0 — 2026-06-25

第一个正式可用版本，面向电商运营与销售团队的本地化产品图包 & 证书资料管理工具。

### 核心功能

- **工作区管理**：自包含工作区，文件、配置、元数据、缩略图全部在一个目录内，复制即迁移。
- **产品集管理**：
  - 创建、删除、空产品集重命名。
  - 产品集标签与备注，支持按名称/标签筛选。
  - XLSX 批量导入创建产品集。
- **图包 / 证书分类**：
  - 自定义子文件夹（图包：主图、详情页、白底图、素材；证书：3C、质检、专利等）。
  - 拖拽导入，自动按命名模板重命名。
  - 导入时自动生成 256×256 缩略图。
- **文件外发**：
  - 复制到系统剪贴板（`CF_HDROP`），支持微信/钉钉 `Ctrl+V` 粘贴发送原图。
  - 在资源管理器中打开并高亮选中文件，方便拖拽到聊天窗口。
- **浏览与检索**：
  - 全局搜索产品集与文件名。
  - 图包库 / 证书库支持按产品集、子文件夹筛选，按时间/名称/大小排序，文件名搜索。
  - 多选批量复制、删除、在文件夹中显示。
- **预览与元数据**：
  - 图片、PDF、视频预览。
  - 文件级元数据：标签、备注、证书类型、到期日。
  - 用系统默认程序打开文件。
- **系统托盘**：最小化到托盘，常驻后台。

### 构建产物

- `build/bin/qihefilemanager.exe`（约 14 MB，便携版）
- `build/bin/qihefilemanager-amd64-installer.exe`（约 7 MB，NSIS 安装包，支持卸载）

---

## 2026-06-24

### 新增

- **导出文件桥接方案（替代原生 Drag-Out）**
  - 由于 WebView2 自身会接管拖拽并携带预览位图，无法被 Go 侧替换为 `CF_HDROP`，原生拖拽导出不可靠，改为桥接方案。
  - 后端新增 Windows-only `internal/clipboard` 包：通过 `CF_HDROP` 把文件复制到系统剪贴板，支持在微信、钉钉等聊天窗口按 `Ctrl+V` 批量粘贴发送原图。
  - 后端新增 Windows-only `internal/explorer` 包：通过 `SHParseDisplayName` + `SHOpenFolderAndSelectItems` 打开资源管理器并高亮选中文件，用户可继续从资源管理器拖到聊天窗口。
  - 后端新增 `CopyFilesToClipboard` / `ShowFilesInExplorer` 接口，移除原 `DragOutFiles`。
  - 前端文件浏览器（`FileBrowser.tsx`）移除旧拖拽，新增工具栏「复制选中」与「在文件夹中显示」按钮，支持 `Ctrl+C` 批量复制已选文件。
  - 前端图包库（`Images.tsx`）移除旧拖拽，图片右键菜单支持「复制」与「在文件夹中显示」。
  - 非 Windows 平台提供空实现，前端可正常编译，运行时导出功能不可用。

## 2026-06-24

### 修复

- **文件预览**
  - 修复导入图片后无预览的问题：改为通过 Wails AssetServer 自定义 Handler 直接提供文件 URL，避免 base64 data URL 在 WebView2 中无法加载大图。
  - 导入完成后立即生成缩略图，文件卡片显示真实缩略图。
  - 预览弹窗支持图片、PDF 和视频，增加错误提示，加载失败时显示具体原因。
  - 预览弹窗新增「用系统程序打开」按钮，作为所有文件类型的兜底方案。
  - 后端新增 `GetWorkspaceFileUrl` 接口，返回可在前端直接使用的文件 URL。
  - 后端新增 `OpenFileWithDefaultApp` 接口，调用系统默认程序打开文件。

- **拖拽导入文件不生效**
  - 在 `main.go` 中添加 Wails v2 拖拽配置 `DragAndDrop: &options.DragAndDrop{EnableFileDrop: true}`，启用原生文件拖拽。
  - 修复 `frontend/src/components/GlobalDropOverlay.tsx` 中 `OnFileDrop` 的 `useDropTarget` 参数误用：由 `true` 改为 `false`，避免在没有 `--wails-drop-target` 样式元素时无法触发回调。
  - 优化拖拽覆盖层状态管理：使用 `onMount` 单次注册监听，增加 `drop` 事件兜底和 5 秒超时自动隐藏，防止覆盖层卡住。
  - 补回 `GlobalDropOverlay.tsx` 中缺失的 `For` 组件导入。

## 2026-06-24

### 新增

- **删除功能**
  - 后端新增 `ProductSetDelete` 接口，删除产品集及其下所有 SKU、文件，并清理相关 metadata 与缩略图。
  - 后端新增 `SkuDelete` 接口，删除 SKU 及其下所有文件，并清理相关 metadata 与缩略图。
  - 后端新增 `DeleteSubfolder` 接口，删除 SKU 下的图包/证书子文件夹，并清理该子文件夹内文件的 metadata 与缩略图，同时从工作区配置中移除该子文件夹类型。
  - 前端产品集卡片与产品集详情页新增「删除产品集」按钮，带二次确认。
  - 前端 SKU 卡片新增「删除」按钮，带二次确认。
  - 前端文件浏览器新增文件多选、全选与批量删除功能。
  - 前端文件浏览器新增「删除当前图包/证书类型」按钮。
  - 新增 `delete_test.go`，覆盖产品集、SKU、子文件夹删除及 metadata 清理。

## 2026-06-24

### 新增

- **产品集批量创建**
  - 后端新增 `ProductSetCreateWithSkus` 接口，可一次性创建产品集及其下的多个 SKU。
  - 前端"新建产品集"弹窗支持添加 SKU 列表，填写后一并提交创建。

- **XLSX 模板导入/导出**
  - 后端新增 `ExportXlsxTemplate` / `ImportProductSetsFromXlsx` 接口（`xlsx.go`）。
  - 模板包含"产品集导入模板"数据表和"填写说明"说明表，带表头样式与示例行。
  - 前端"产品集"页面新增"XLSX 模板"和"XLSX 导入"按钮。
  - 支持同一产品集连续多行，按产品集名称自动分组批量创建。

- **文件选择对话框**
  - 后端新增 `OpenFileDialog`，支持前端选择 `.xlsx` 等文件。

- **应用图标自定义**
  - 新增 `scripts/render_logo.py`，基于 `build/logo.svg` 生成：
    - `build/appicon.png`（512×512）
    - `build/trayicon.png`（64×64）
    - `build/trayicon.ico`

### 修复

- **前端弹窗溢出**
  - "新建产品集"弹窗改为响应式 2 列网格布局，模态框加宽并增加滚动，避免 SKU 输入行撑出模态框。

- **系统托盘重复创建与内存泄漏**
  - 使用 `sync.Once` 严格保证 `systray.Run` 只启动一次，防止托盘图标分裂。
  - 增加 `trayExitCh`，应用退出时正确结束托盘菜单 goroutine，避免 goroutine 泄漏。

### 文档

- 更新 `本地文件管理项目.md`，补充批量创建、XLSX 导入、图标生成等章节。
- 更新 `BUILD.md`，增加图标生成步骤与 NSIS 安装包构建说明。
- 新增 `CHANGELOG.md`（本文件）。

### 测试

- 新增 `xlsx_test.go`，覆盖 `ProductSetCreateWithSkus`、`ExportXlsxTemplate`、`ImportProductSetsFromXlsx`。
- 全部 Go 测试通过：
  ```bash
  go test -v ./...
  ```

### 构建产物

- `build/bin/qihefilemanager.exe`（约 13 MB）
- `build/bin/qihefilemanager-amd64-installer.exe`（约 7 MB）
