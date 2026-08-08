# 更新日志

## v2.2.1 — 2026-08-08（修复专项：拖拽 / 子文件夹 / PDF / 内存长稳）

> AI 功能（v2.2.0 实现）本期**不开放**：客户端入口已隐藏（`FEATURE_AI=false`），代码保留在独立分支，成熟后发布。

### 修复

- **拖拽拖出失效（打包回归）**：`build/logo.png` 未进 asar 导致 startDrag 图标为空，安装版无法拖出；已加入打包白名单
- **图包/证书子文件夹不可修改**：新增「重命名」能力（设置页 ✎ 按钮），改名会**同步迁移所有已有产品集**下的同名目录（幂等：未建目录的产品集自动跳过）；metadata 按「产品集/文件名」存储，无需迁移
- **PDF 预览重做（打包版曾空白/报错/闪退/极慢）**：
  - 内嵌主窗口预览（点击文件在原有 Modal 中打开，与主界面一体；曾尝试独立预览窗口，因界面与主应用重复割裂而回退）
  - 流式加载（Range 请求，不全量读内存）+ 页缓存 LRU + 降采样渐进渲染 + 渲染队列（快速翻页不白屏）+ worker 单例 + 关闭销毁清理
- **图片预览**：全分辨率大图，主窗口内嵌查看

### 内存长稳（常驻进程最少化）

- 修复 4 个真实增长点：metadata 缓存 LRU（3 工作区）、CountCache LRU（2048）、PdfPreview blob 单例、sharp/libvips 缓存收紧
- V8 参数（半空间调小，长期运行更快归还内存）+ `--in-process-gpu` 去 GPU 空壳进程（Linux 打包实测验证）
- **MemoryWatchdog**：5 分钟基线 + 60 秒采样，渲染进程超阈值自动优雅 reload；24 小时定时 reload 保底；窗口隐藏时清理 Blink 图像缓存；崩溃自愈后重置计数
- 目标：常驻内存稳定（去 GPU + 懒加载实测），长期运行不增长；PDF 流式加载避免大文件全量占内存

### 服务端配套（ERP 平台管理员）

- 平台管理员新增「文件管理」tab：box 用户列表（设备/活跃/AI 用量）、概览统计、版本/平台分布、7 天活跃趋势、服务端组件可用性

## v2.2.0 — 2026-08-08（账号登录 + AI 智能整理 + 活跃统计）

### 新功能：可选登录（复用「启禾 OS」账号）

- 「我的」→「账号」：邮箱+密码登录，不登录完全不影响本地功能
- 登录后自动上报活跃（设备标识+平台+版本+最近使用），用于统计活跃用户；可随时登出停止
- token 优先系统安全存储加密，Linux 无 keyring 时降级明文（本地单用户，JWT 过期即失效）

### 新功能：AI 智能整理（登录解锁，新用户 50 次试用）

- **AI 批量命名**：多选文件 → 右键「AI 命名」→ 按命名模板批量生成规范名 → 预览勾选后应用
- **AI 标签建议**：多选文件 → 右键「AI 打标」→ 只从现有标签中推荐 → 一键批量打标
- **证书信息抽取**：PDF 预览 →「AI 抽取信息」→ 自动填证书类型/到期日/编号/发证机构
- **AI 语义搜索**：搜索页自然语言查询（如「上周的营业执照」）→ AI 翻译关键词+条件 → 本地执行
- 额度：每账号累计 50 次 + 每日 30 次上限（服务端校验，防滥用/控成本）；用完仅 AI 断供，本地功能不受影响

### 隐私边界

- AI 仅上传文件名 / PDF 纯文本 / 命名模板 / 现有标签；图片与文件本体、目录结构永不上传
- 服务端处理完即丢，不留存请求内容；PRIVACY.md 已更新

### 服务端（ERP 后端配套）

- 新增 `box_devices`（活跃心跳 upsert）与 `box_ai_quota`（试用额度）集合
- 新增 `POST /api/box/heartbeat`、`POST /api/box/ai`（4 个 action），复用全局 AI 配置链与结构化输出模式（Generate→JSON）

## v2.1.2 — 2026-08-08（包瘦身）

- **安装包 -10%**：pdfjs-dist（101MB）实际进包的 39MB 全部排除——渲染层已把它打进 bundle（worker 复制到 assets），node_modules 里是死重。asar 68MB → 29MB（-57%），deb/AppImage 137MB → **124MB**，Windows zip 同步减小
- 验证：安装版冒烟全绿（PDF 预览 bundle 加载正常、缩略图 36/36、4 进程）

## v2.1.1 — 2026-08-08（进程瘦身）

### 进程合并（7 → 4，总内存 ~800MB → ~600MB）

- **去掉 3 个 zygote 孵化器**（`--no-zygote`，-118MB）：Chromium 直接 spawn 子进程；参数固化为启动参数（`linux.executableArgs`），Linux 生效
- **禁用 GPU 进程**（`--disable-gpu`，207MB → 90MB 空壳）：Deepin 本就软件渲染，纯开销；无崩溃
- **实测证伪**：`--single-process` 极限合并（1 进程）在 Deepin 上启动即崩（SIGTRAP），已放弃；`--js-flags` / `disableHardwareAcceleration` 历史崩溃坑，不启用
- Windows 不受影响（无 zygote，保留 GPU 加速）

### 实测（Deepin 安装版）

- 进程：7 → 4（主 280 / 渲染 148 / GPU 90 / utility 77）
- 总内存：~800MB → **~600MB**；万图滚动渲染进程增量 ≤41MB 不变

## v2.1.0 — 2026-08-08（内存性能专项 + PDF 预览）

### 修复（真实环境验证）

- **闪退（SEGV）**：真实证书 PDF（含 Form XObject/嵌入字体）在 `pdfjs + @napi-rs/canvas` 渲染时会原生段错误 → 主进程崩溃闪退。**不再用该路径渲染 PDF**
- **PDF 预览不渲染**：Chromium PDFium 不渲染 iframe 中的 `qihebox://` 自定义协议 PDF，改为 pdfjs-dist 渲染进程 canvas 渲染（canvas + 上一页/下一页/缩放，worker 走 blob URL 兼容打包环境）
- 验证：真实工作区 97 个证书 PDF 抽样——预览 17 页报告可翻页、应用不闪退

### 产品决策：PDF 不做缩略图

- 曾尝试隐藏窗口 PDFium 渲染 PDF 首屏缩略图，实测成本高（每张 ~2s 窗口渲染、批量排队）且失败回退 📄 等于白做——**取消**。缩略图仅图片（sharp）；PDF 证书在列表中保持 📄 占位，点开用 pdfjs 预览查看内容

### 内存性能（万图场景内存不再失控）

- **虚拟滚动**（`@tanstack/solid-virtual`）：图包库/证书库/产品集文件页只渲染视口 ± 缓冲行，滚出即卸载。实测 1 万张图目录 DOM 恒定 ~40 个卡片（旧版滚到底挂 1 万个节点）；渲染进程内存增量 ≤41MB 且回顶回落
- **缩略图缓存迁移到 userData**：缩略图不再写入工作区 `.thumbnails`（坚果云目录不被缓存文件刷屏）；旧缓存自动迁移复用；新协议 `qihebox://thumb/` 独立提供
- **缩略图 URL 渲染层 LRU 缓存**：虚拟滚动回滚时命中率≈100%，免重复 IPC 往返
- **关闭拼写检查**（`spellcheck: false`），省渲染进程资源

### PDF 预览

- 证书 PDF 在列表保持 📄 占位，点开后用 pdfjs 渲染进程渲染（canvas，上一页/下一页/缩放）——解决原 iframe 预览不显示的问题

### 实测（Deepin，1 万张图）

- DOM 节点 36~54 恒定；渲染进程 156MB（空载）→ 197MB（滚动峰值）→ 回落 194MB
- 总内存基线 ~700MB 为 Electron 43 + 软件渲染 GPU 的固有开销

## v2.0.2 — 2026-08-08（标签层级 + 性能 + 页面）

### 标签体系升级

- **父/子标签层级**：标签可设父级（两层结构）；管理页树形展示（子标签缩进）；打标签时按父/子分组快速选择；chip 显示层级（`父/子`）；删除父标签时子标签自动提升为顶层
- **固定色预设标签**：内置 5 个（重要红/待更新橙/已更新绿/问题黄/归档灰），颜色固定、可重命名/删除；旧工作区自动补全

### 性能优化

- **路由级懒加载**：首屏只加载仪表盘，其余页面按需分包（减小首屏 bundle）
- **大列表分批渲染**：图包库/证书库万级文件只渲染可见区，滚动加载更多（IntersectionObserver）
- **exceljs 延迟加载**：主进程启动不再加载其依赖链

### 页面

- **帮助页**挂载 `/help` 路由 + 侧边栏入口（此前为死页面）
- **我的 → 更新**：最新/失败状态显示当前版本 + 「前往官网下载」引导

### 修复

- 拖拽拖出到微信变路径：`preventDefault` 阻止 HTML5 默认拖拽，让 `startDrag` 原生文件拖拽接管（需用户实测确认）

## v2.0.1 — 2026-08-08（修复 + 升级）

### 缩略图修复（关键）

- **根因**：旧版用绝对路径 sha256 作缩略图缓存键，Windows 生成的缩略图在 Linux 下路径不同导致全部失效
- **修复**：缓存键改为「相对工作区路径」hash（跨平台一致，坚果云 Win/Linux 双机共享也可复用）；新增 `ensureThumbnail` IPC，缩略图缺失自动生成
- 验证：真实工作区「团队共享」旧图缩略图自动补齐显示

### 新功能

- **标签体系升级**：全局标签定义（`tags.json` 颜色体系，自动迁移旧版 `tags_state.json`）；Settings 新增标签管理（新建/改色/重命名/删除，重命名与删除同步所有文件与产品集引用）；文件预览与产品集标签按颜色显示
- **拖拽拖出**：从图包/证书库直接拖文件到桌面/文件管理器/微信（Electron `startDrag` 原生多文件拖拽）
- **右键体系**：统一 ContextMenu 组件（消除 4 页面重复代码），补全操作：用默认程序打开 / 复制路径；多选支持复制/文件夹显示/删除
- **图标**：Linux 任务栏/窗口图标（BrowserWindow icon）

### 修复

- `shell.openPath` 在 Linux 挂起导致"用默认程序打开"IPC 永不回复 → 改用 `xdg-open` 子进程
- preload 返回值与 Wails 语义对齐（getSize/getPosition/isMaximised 解包）

### 测试

- 单测 28（新增标签体系 4 用例）；e2e 15（新增标签/拖拽/复制路径/右键 4 用例）

## v2.0.0 — 2026-08-08（Electron 重构版）

### 技术栈迁移：Wails v2 + Go → Electron + TypeScript

- **主进程**：TypeScript 全栈（原 Go 2866 行 → TS），业务层 `src/main/core/` 与 Electron 解耦，可在 node 环境直接单测
- **前端**：SolidJS + Tailwind 原样保留（4595 行零重写），仅替换 Wails 绑定层为 preload IPC（`window.qihebox`）
- **平台支持**：Windows + Linux（Deepin 实测）。自带 Chromium 绕开系统 WebKitGTK 依赖，修复原版 Linux 剪贴板/资源管理器空实现问题
- **数据兼容**：工作区格式（config/metadata/缩略图哈希路径）与 v1.x 完全一致，旧工作区零迁移

### 性能（对比原版优化）

- 目录扫描缓存（目录树 mtime 签名）：Dashboard 首扫 2000 文件 **130ms**（原同步递归）
- 搜索异步 + 防抖 + 缓存：**138ms / 2000 文件**
- 导入 100 文件（含 sharp 缩略图）：**293ms** 不阻塞 UI
- 大图/PDF/视频预览走 `qihebox://` 自定义协议（流式 + Range），不再整读内存

### 稳定性

- 渲染进程崩溃自动 reload（限 3 次）；GPU 崩溃降级记录
- JSON 原子写（tmp+rename）；`metadata.json` 损坏自动备份 `.corrupt-<ts>` 并降级
- 主进程日志落盘（`app.getPath('logs')` 按日期轮转）
- 单实例锁（替代原 CreateMutex）；关闭窗口=隐藏托盘

### 平台能力

- 剪贴板复制文件：Windows CF_HDROP / Linux text/uri-list（Deepin X11 实测）
- 资源管理器选中：dde-file-manager（Deepin）/ nautilus / dolphin / shell
- 打包：AppImage + deb（Linux）/ NSIS（Windows）；体积 104MB（asar+maximum 压缩+语言包精简）

### 测试体系（原 Go 测试迁移 + 新增）

- vitest 单测 24 用例（命名引擎/路径校验/工作区/元数据/XLSX）
- Playwright e2e 11 用例（窗口/IPC/缩略图/协议/剪贴板/资源管理器/窗口控制/XLSX）
- 性能基准 `npm run bench` → docs/PERF.md

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
