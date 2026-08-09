# 上线前审计与修复方案（RELEASE-AUDIT）

> 适用范围：v2.4.x 正式发布前。
> 本文档 = 主问题（切换文件夹图片渲染不出来）根因与修复方案 + 全量审计发现（去重定级）+ 修复批次建议 + 验收标准。
> 引用格式：`文件:行号`。行号以审计时工作区状态为准（含未提交改动）。

## 1. 背景与方法

起因：用户反馈从「详情页」切到「主图」等子文件夹 tab 后，图片渲染不出来，观感像卡死。随后按上线标准做了 7 个范围的审计：内存、PDF 查看、证书到期提醒、文件操作正确性、拖拽/剪贴板/导入、主进程骨架/安全/更新/打包、构建与测试健康。

**已实证的结论**（非推测）：

- `@tanstack/solid-virtual` dist 源码逐行核对（`node_modules/@tanstack/solid-virtual/dist/esm/index.js`）：`createComputed` 内 `setOptions(mergeProps(...))` 展开读到的 `count` 是调用时求值的死数字，无 signal 依赖。
- 用仓库自带 solid-js 1.9 做 node 实验验证：store `reconcile({key:"index"})` 保留同 key 行对象身份，`<For>` 按引用缓存、回调不重跑。
- sharp 0.35.3 核实：`shrinkOnLoad` 自 0.33.0 起改名 `fastShrinkOnLoad` 且默认值为 `true`，旧名在运行时与类型定义中均已不存在。
- Electron 43.3.0 实测：`qihebox://` 跨协议 XHR/CORS 正常；`net.fetch(file://)` 对 Range 请求**不回 206/Content-Range/Accept-Ranges/Content-Length**；pdfjs 5.6.205 对非 http(s) 协议不发 Range 请求。
- `npx tsc --noEmit`（renderer 配置）绿；`tsconfig.node.json` 配置 1 个错误（见 P0-1）；vitest 110/110 绿；`electron-vite build` 成功。

**源码级推断、待实机验证**：

- Windows「复制文件到剪贴板」（CF_HDROP 格式 ID 问题，P0-2）——证据链完整但必须在 Windows 实机花 5 分钟复现确认。
- VirtualGrid 冻结的端到端表现（机制已实证，未在无显示环境外跑完整 e2e 复现）。

## 2. 主问题根因：切换文件夹图片渲染不出来

三个叠加根因 + 一组放大器。场景前提：「详情页 / 主图 / 白底图 / 素材」tab 共用同一条路由 `/files/:type/:productSet/:subFolder`（`src/renderer/src/index.tsx:37`），切 tab 只变参数，**FileBrowser 与 VirtualGrid 组件不卸载**。

### 根因 1（主因）：VirtualGrid 拿到的是「死数据」，新文件夹内容进不了网格

`src/renderer/src/components/VirtualGrid.tsx`：

- **`count` 被冻结在挂载时刻**（`:76`）：`count: Math.ceil(props.items.length / cols())` 是 `createVirtualizer` 调用时一次性求值的普通数字。代码注释声称"内部访问 items/cols 会自动追踪变化"——dist 源码证实不成立：`createComputed` 里 `setOptions(mergeProps(resolvedOptions, options, …))` 展开读到的是这个死数字，没有任何 signal 被读取，computed 只跑一次。行数永远不随 `files()` 变化。
- **`rowItems` 是行创建时刻的死切片**（`:88-94`）：solid-virtual 内部对 virtual items 用 `createStore` + `reconcile({key:"index"})`，同 index 的行对象身份永久保留 → Solid `<For>` 按引用缓存 → 行回调绝不重跑 → 每行永远显示它首次创建时切到的 `props.items` 切片。

合成效果：切 tab 后 `files()` 已是新数组，但网格原样显示旧文件夹内容（观感 = 卡死）；若滚动触发 onChange，只有 index 集合变化覆盖到的行重建 → 新旧文件夹内容混杂；重建行的图片要等 IPC → 常驻骨架屏（观感 = 渲染不出来）。

注意：工作区里未提交的 `loadSeq`（FileBrowser）、`loadId`（FileThumbnail）、`scrollResetKey` 三处修复都是对的，但它们防的是"数据到达渲染层之前"的竞态，治不了"渲染层没把新数据读进去"这个病灶。

### 根因 2（放大器）：主进程缩略图队列饥饿

`src/main/thumbnail.ts:50-110`：4 并发纯 FIFO，无取消、无优先级、无超时、无长度上限。旧文件夹滚入视口的每张未缓存图都入队，切文件夹后不取消；新文件夹的一屏请求排在全部积压之后。每张生成 = 读原图 + 解码 + 编码，本地几十~几百 ms；工作区在坚果云同步目录、文件未本地化时触发云端水合，单张可达秒级。几百张积压 ÷ 4 并发 = 几十秒到分钟级的"假卡死"。极端情况：某个生成任务永不 settle（sharp 挂死 / 同步目录读阻塞），4 个槽位占满即**全局缩略图真死锁**，只能重启。导入（`files.ts:284` 逐张 await）、重命名、移动、startDrag 都共用这 4 个槽位，进一步加剧。

### 根因 3（"永久不显示"的来源）：FileThumbnail 无 `onError` 兜底 + URL 未验证即入 LRU

`src/renderer/src/components/FileThumbnail.tsx:75`：IPC resolve 时就把 URL 存进模块级 LRU（上限 1000）。但 **IPC 成功 ≠ `<img>` 可加载**——`qihebox://thumb/` 请求可能 404（缓存被外部清理）、403（跨工作区瞬间前缀校验用当前工作区根）、流中断。当前 `<img>` 没有 `onError`（未提交改动中移除）→ 破图永久挂着；坏 URL 进 LRU 后每次重访直接命中、跳过重试 → 该图永久空白直到重启渲染进程。

### 放大器：clearCache + 协议无缓存头

`src/renderer/src/App.tsx:181-186`：失焦 30 秒 `webFrame.clearCache()` 清空 HTTP/图像缓存；`src/main/protocol.ts:83-89` 响应只有 CORS 头、**无 `Cache-Control`**，缓存行为依赖 Chromium 启发式。两者叠加 → 切走再回来所有图重新走协议 fetch + 解码，在根因 2 的积压场景下表现为"回来看图全在转圈"。

### 已排除的嫌疑

- 渲染端竞态：`loadSeq`/`loadId` 守卫方向正确（保留）。
- `pending` 去重（`thumbnail.ts:149-171`）：入队后同步 set，无竞态。
- blob URL：缩略图链路不用 blob URL，无 revoke 泄漏。
- `memoryWatchdog.ts`：死代码（import 未调用），不参与此问题（见 §4-P1 骨架组）。
- 协议注册时机、scanCache：与本问题无关。

## 3. 主问题修复方案

### 修复 1：VirtualGrid 响应式化（~10 行，根治"切换不变"）

- `count` 改 getter：`get count() { return Math.ceil(props.items.length / cols()) }`——`setOptions` 展开读取时触发 getter，读取 `props.items` 与 `cols()` 建立依赖，`createComputed` 随数据/断点变化重跑。
- 行内切片改派生函数：`const rowStart = () => row.index * cols()`、`const rowItems = () => props.items.slice(rowStart(), Math.min(rowStart() + cols(), props.items.length))`，模板里 `<For each={rowItems()}>`。`props.items` 换数组 → `each` 重新求值 → 按新 item 引用重建行内容。
- 同步修正 `:74-75` 的过时注释（"自动追踪"的说法是错的，是这次事故的认知根源）。

### 修复 2：生成队列加「代际作废 + 浏览优先 + 超时 + 上限」（~50 行，主进程自闭合，不动 preload API）

- 任务打来源标签：`browse`（`thumbnailUrl` IPC）/ `background`（import、rename、move、startDrag）。
- **代际作废**：`files:list` 处理入口作废所有**排队中**的 browse 任务（立即 resolve `''`）。每次切文件夹必先走 `files:list`，旧积压自动清空；前端的 `loadId` 守卫天然丢弃迟到的 `''`，无副作用。运行中的任务不打断（sharp 不可取消），靠超时兜底。
- **优先级**：browse 任务插队到队首，background 排队尾；浏览体验永远优先于导入。
- **超时**：单任务 15s 未 settle 按失败处理（resolve `''`），杜绝真死锁。
- **上限**：队列长度 > 200 时新任务快速失败（resolve `''`），防无界积压。
- 内存上界保持不变：`limitInputPixels: 250MP`、`fastShrinkOnLoad` 默认 true（见 P0-1 的类型修正）、libvips 缓存 16MB/4 句柄/32 项、并发 4。

### 修复 3：FileThumbnail 容错（~10 行）

- 恢复 `<img onError>`：触发时**从 LRU 剔除该 key** 再 `setError`——下次进入该文件夹自动重试，坏 URL 不再永久固化。
- `storeThumbUrl` 推迟到 `img.onload` 之后执行，保证进缓存的 URL 一定可显示。
- 更新头部注释（当前注释解释的正是被移除的行为，会误导后来者）。

### 修复 4：协议缓存头（~3 行）

thumb 响应加 `Cache-Control: private, max-age=31536000, immutable`。缩略图按源图 mtime 管理新鲜度、磁盘路径稳定，可安全长缓存；削弱 clearCache 与重复解码的抖动，回切秒显。`qihebox://file/` 原图响应不加（原图可能被同路径覆盖更新，mtime 变化后 Chromium 启发式缓存可能滞后——维持现状，列为观察项）。

### 修复 5：测试补强

- e2e 切文件夹用例（`tests/e2e/smoke.spec.ts` 新增段）断言改为：切换后 `img[src^="qihebox://thumb/"]` 的 src 集合与目标文件夹 `files.list` 结果一致（现断言"存在 img 且 complete"在旧内容残留时也通过，属于假绿）。
- 新增单测：队列代际作废（files:list 后旧 browse 任务全部 resolve `''`）、browse 插队、超时按失败、上限溢出快速失败。

## 4. 审计其他发现（去重定级）

### P0（上线阻塞）

**P0-1 主进程类型检查失败，CI 门禁必红** — `src/main/thumbnail.ts:158`（未提交改动引入）
`shrinkOnLoad` 在 sharp 0.33.0 起改名 `fastShrinkOnLoad`（且默认即 `true`），0.35.3 的类型定义中旧名不存在 → `npx tsc --noEmit -p tsconfig.node.json` 报 TS2353，push 后 CI「Typecheck main / preload / tests」必红。运行时未知键被静默忽略且期望行为本来就是默认值，**无功能损失**。
修法：删掉 `shrinkOnLoad: true`（或改为 `fastShrinkOnLoad: true`），一行。同步修正 `:20-25` 注释中的错误认知。

**P0-2 Windows「复制文件到剪贴板」大概率整体失效（待实机确认）** — `src/main/clipboard.ts:36-44`
`clipboard.writeBuffer('CF_HDROP', buffer)` 在 Chromium 150 实现中走 `RegisterClipboardFormat(L"CF_HDROP")`，得到 ≥0xC000 的新格式 ID，而资源管理器/微信/钉钉粘贴只认预定义 `CF_HDROP = 15`。DROPFILES 缓冲区本身构造正确（20 字节头、`pFiles=20`、`fWide=1`、UTF-16LE 双 null 结尾），问题纯粹在写入目标格式。UI 提示"已复制 N 个文件"，实际粘贴无内容。这是招牌功能（微信发原图），CHANGELOG 只记录了 Linux 实测，Windows 侧从未实机验证。
修法：先 Windows 实机 5 分钟验证；复现则 Windows 分支改走 PowerShell `Set-Clipboard -Path …`（项目已有 PowerShell 先例 `explorer.ts:127`），并补一条发布前实机验收项（见 §7）。

### P1（建议上线前修）

#### 安全收口组（同一主题：主进程不信任渲染输入，可一次收口）

- **P1-S1 名称入参缺分隔符/`..` 校验 → 路径穿越** — `src/main/core/workspace.ts:280-306`（productSetCreate）、`workspace.ts:327-354`（renameProductSet）、`workspace.ts:214-248`（renameSubfolder）、`src/main/core/files.ts:314-334`（createSubfolder）、`files.ts:173-179`（fileList 只读穿越）、`files.ts:336-360`（deleteSubfolder）。名称只 `trim()` 直接 `path.join`：实测 `../../../../tmp/evil` 可在工作区外 mkdir 并污染 config.json；`deleteSubfolder` 传 `../..` 可把产品集目录当"子文件夹"移入回收站。修法：core 层统一拒绝 `/`、`\`、`..` 及首尾点，并对 join 结果做 `isPathInsideWorkspace` 兜底。
- **P1-S2 `saveTextFile` IPC 任意路径写** — `src/main/ipc.ts:167-169` → `files.ts:562-564`：无 `isPathInsideWorkspace` 校验，是 preload 白名单里唯一的"任意写"原语。修法：补校验（或限定 `.csv`/`.txt` 等后缀白名单），与其他 files:* handler 对齐。
- **P1-S3 Windows 多选「在资源管理器显示」PowerShell 注入** — `src/main/explorer.ts:105-125`：文件名经 `JSON.stringify` 拼进 PS **双引号**数组，`$()`/反引号会被展开，而这些字符在 NTFS 文件名合法。供应商图包夹带 `a$(…).jpg` 即可以用户权限执行任意命令。修法：文件名改单引号 + `''` 转义（与 dir 参数一致），或 `-EncodedCommand`/stdin 传参。

#### 数据安全组

- **P1-D1 无扩展名文件冲突改名丢失整个文件名** — `src/main/core/naming.ts:58`：`name.slice(0, -ext.length)` 在 `ext === ''` 时是 `slice(0, -0)` → 空串。`LICENSE`/`Makefile` 等冲突时被改名为 `_1`，原名丢失（已 node 实测）。触发点：`files.ts:444`（moveFiles）、`files.ts:277`（importOneFile）。修法：`ext ? name.slice(0, -ext.length) : name`。
- **P1-D2 回收站目录 purge 清缩略图是空操作 + 可能显示错图** — `src/main/core/trash.ts:180-184`：purge 时 `originalPath` 已移入回收站、目录不存在，`removeThumbnailsInDir` 的 walk 首行 readdir 失败静默返回 → 目录类缓存**从不被清理**。后果一：userData 缓存只涨不消；后果二：缩略图按相对路径 hash，坚果云同步来的同路径新文件若 mtime 比旧缓存旧，`isFresh` 误判命中 → **新文件显示旧图的缩略图**（与根因 3 叠加后前端无自愈手段）。修法：purge 时遍历回收站 dataDir，把每个文件映射回 originalPath 相对位置计算缩略图路径删除。现有单测用假 ThumbnailProvider 抓不到，需补真实目录用例。
- **P1-D3 元数据 key 不含子文件夹/类型 → 同名文件元数据串号、被误删** — `src/main/core/metadata.ts:91-93`：key 为 `产品集/文件名`（继承 Go 版）。同产品集下 `图包/主图/a.jpg` 与 `图包/白底图/a.jpg` 共享同一条元数据：改标签互相串；purge 回收站里的 `a.jpg`（`trash.ts:172`）会把仍在正常使用的另一个 `a.jpg` 的标签一并删除；moveFiles 迁 key（`files.ts:460-474`）会把元数据从留下的同名文件身上"带走"。修法：key 加入 `类型/子文件夹` 段 + 一次性迁移。**趁正式上线前用户基数小改，成本最低。**
- **P1-D4 元数据 key 用 `path.join` → 跨平台分隔符不一致** — `metadata.ts:91-93,136`：Windows 写 `集\文件`、Linux 写 `集/文件`。工作区经坚果云双机共享时，另一平台查询全 miss（标签凭空消失），`removeFileMetadataForProductSet` 前缀匹配同样失效。缩略图 hash 当年已为双机场景改相对路径（`paths.ts:111-114` 注释），元数据 key 是漏网之鱼。修法：key 统一固定 `/` 拼接 + 读取兼容旧 `\` key 迁移。与 P1-D3 合并一次迁移完成。
- **P1-D5 移动/删除部分失败无聚合** — `files.ts:430-496`（moveFiles）、`files.ts:302-311`（fileDelete）：循环内任一文件抛错即整体中断，已成功的不回传、未处理的不说明；EXDEV 回退 copy 成功 rm 失败时源/目标双份且元数据未迁移。修法：逐文件 try/catch，返回 `{moved, failed}` 聚合，前端展示明细。
- **P1-D6 目录列举逐文件 stat 无容错** — `files.ts:127`（listRaw）、`files.ts:152`（listDirFilesRecursive）：readdir 到 stat 之间文件被同步客户端替换 → ENOENT → 整个 fileList 失败、文件夹打不开。坚果云活跃同步期高概率。修法：单文件 stat 失败跳过（可记 warn）。
- **P1-D7 `isPathInsideWorkspace` 纯词法校验，符号链接可逃逸** — `src/main/core/paths.ts:103-108`：`path.resolve` 只折叠 `..`，不解析符号链接；工作区内指向外部的 symlink/junction 会让 delete/move/open/协议层放行到工作区外。修法：校验前对两侧 `realpath`（不存在的路径回退词法）。

#### 导入链路组

- **P1-I1 单文件失败整批中断 + 失败事件 count=0** — `files.ts:199-207`（循环无 try/catch）、`src/main/ipc.ts:122-127`（失败事件 `count: 0` 硬编码）：500 个导入到第 237 个遇水合失败/文件锁即整批中止，前 236 个已落盘但用户只看见"导入失败"；**重试时冲突加序号把已落盘的再复制成 `_1` 副本**——真实的批量重复数据路径。修法：循环内逐文件容错收集失败清单，完成/失败事件携带 `imported`/`failed` 明细。
- **P1-I2 并发导入无防护 → 同名覆盖丢数据** — `GlobalDropOverlay.tsx:74-119`（无 importing 守卫可两次 drop 并发）+ `files.ts:276-281`（`resolveConflictName` 检查后 `copyFile` 默认覆盖，TOCTOU）：两批含同名文件时后写覆盖先写，先导入的图数据丢失；metadata.json 两写者交错。修法：主进程导入互斥锁/串行队列 + `COPYFILE_EXCL` 配合冲突重试；事件带 cancelToken。
- **P1-I3 每导入一个文件全量重写一次 metadata.json** — `files.ts:288` → `metadata.ts:117-122`：N 文件导入 = N 次全量 JSON tmp+rename，O(n²) IO；坚果云目录每次 rename 都是同步事件，同步客户端持锁时 rename EPERM 直接中断导入（放大 P1-I1）。修法：导入循环内累积元数据，结束一次落盘（或防抖合并写）。
- **P1-I4 导入循环逐张 `await` 缩略图** — `files.ts:284`：每张图导入都排队等 sharp，500 张拖到分钟级，且长期占满 4 槽位饿死浏览。修法：复制完成后异步触发（不 await），生成失败不阻塞导入；配合修复 2 的 background 标签。

#### 骨架/运行时组

- **P1-R1 崩溃自愈可形成无限 reload 循环** — `src/main/index.ts:100-115`：`render-process-gone` 计数 >3 才 `app.quit()`，但 `did-finish-load` 把计数清零——可复现崩溃的页面（如超大目录 OOM）会"崩溃 → reload 成功 → 清零 → 再崩溃"无限循环；`App.tsx:162-165` 的路由持久化让 reload 精确回到崩溃页。修法：计数加时间窗（10 分钟内 ≥3 次才 quit），加载成功不清零；或崩溃后清除 lastRoute。
- **P1-R2 导入途中窗口被休眠销毁 → 导入静默中断** — `ipc.ts:96-129`：`win` 在导入开始时捕获，之后进度/完成/失败回调直接 `win?.webContents.send(...)` 无 `isDestroyed()` 检查；`window.ts:132` 第三层休眠 `destroy()` 后下一个进度事件抛 "Object has been destroyed" → 异常同步传播进导入循环 → 部分导入且无任何提示。修法：所有 send 前加 `win && !win.isDestroyed()`（`index.ts:195` 已有正确范式）或 try/catch。
- **P1-R3 memoryWatchdog 是死代码，且直接启用也不生效** — `src/main/memoryWatchdog.ts`：全仓库仅 `index.ts:19` import，从未调用；且 `app.getAppMetrics()` 的 `workingSetSize` 单位是 **KB**，与 `800 * 1024 * 1024` 字节比较永不触发（`:37-39`）。**建议：本版本删除模块与 import**（分层休眠已覆盖大部分场景；带 bug 临时接线本身就是风险），下版本修单位 + 实现 `isBusy` 后再灰度启用。
- **P1-R4 Linux xclip 复制 IPC 长期挂起** — `clipboard.ts:49-67`：xclip 读完 stdin 后 fork 驻留进程持有剪贴板并继承 stderr 管道，`close` 事件（要求 stdio 全 EOF）一直不触发 → `await api.files.copyFilesToClipboard(...)` 不返回，"已复制"提示不显示（复制本身已成功）。修法：监听 `exit` 而非 `close`，stderr 改 `ignore`。
- **P1-R5 Linux 无 xclip 回退假成功** — `clipboard.ts:70-85`：Electron `writeBuffer('text/uri-list')` 在无 xclip 桌面不生效（自家 e2e `platform.spec.ts:71-73` 已观测并用 `test.skip` 绕过）却报成功。修法：依次回退 `xsel`/`wl-copy`，全失败按错误抛出，不静默成功。
- **P1-R6 startDrag 前 `await ensureThumbnailFor`，拖出响应被阻塞且失败静默** — `ipc.ts:206-217` + `dragout.ts:47`：未缓存图要等 sharp 生成（水合场景秒级），用户提前松手则拖拽"没反应"；icon 读不到时 Electron 静默不拖拽；handler 拒绝时渲染层丢弃结果无感知。修法：startDrag 只做同步缓存命中判断，miss 直接用默认 logo 立即发起；渲染层检查返回值并提示。

#### PDF/媒体组

- **P1-P1 pdfjs 对非 http(s) 协议不发 Range → 大 PDF 整文件进内存** — `src/renderer/src/components/PdfPreview.tsx:107-108`：`rangeChunkSize` 是死参数，pdfjs 5.6.205 `validateRangeRequestCapabilities` 对非 http 直接判定不支持 Range（实测）。"流式加载"注释与实际不符。大 PDF（证书合辑）整文件 XHR 成 ArrayBuffer；Linux 安装包固化 `--max-old-space-size=1024`（`electron-builder.yml:57`），有 OOM 白屏风险。修法（推荐短期方案）：接受全量加载，修正注释与死参数，对超大文件（如 >100MB）给加载提示或引导"用系统程序打开"；长期再评估自定义 `PDFDataRangeTransport` 走 IPC 按需取字节。
- **P1-P2 协议 Range 透传形同虚设 → 视频 seek 大概率异常** — `src/main/protocol.ts:78-89`：实测 `net.fetch(file://)` 对 Range 请求只回部分字节但 status=200、无 206/Content-Range/Accept-Ranges/Content-Length；`<video>` 依赖 206 才能拖进度条。修法：手写 Range 解析 + `fsp.open` 读区间，自行构造 206 + Content-Range + Accept-Ranges + Content-Length（+ `Access-Control-Expose-Headers`）。
- **P1-P3 PdfPreview 异步挂载竞态 → 加载中秒关泄漏 document + worker** — `PdfPreview.tsx:76-124`（4 个 await 点）vs `:126-138`（onCleanup）：加载期间关闭弹窗，cleanup 先跑（此时 `pdfDoc` 为 null），async 继续跑在已卸载 DOM 上建 PDFViewer，新 document 再无人 destroy。P1-P1 的全量下载把这个窗口拉得很长。修法：组件级 `disposed` 标志，每个 await 后检查，已销毁立即 `loadingTask.destroy()` 返回。

#### 证书提醒组

- **P1-C1 到期日期无格式归一化 → 解析失败静默跳过** — `src/main/core/dashboard.ts:36-37`：`new Date(meta.expiry_date + 'T00:00:00')` 只认 `YYYY-MM-DD`；AI 抽取路径把服务端返回值原样写入（`FilePreviewModal.tsx:78`），`2025/03/01`、`2025.3.1`、ISO 带时间等全部 Invalid Date → **该证书从 Dashboard 和系统通知同时消失，无任何日志**。修法：写入时归一化（拒收或转标准格式），读取处宽松解析 + 失败记 warn。
- **P1-C2 已删除/孤儿元数据证书仍每天提醒** — `files.ts:301-311`（删除进回收站元数据保留）+ `trash.ts:208`（保留 30 天）+ `dashboard.ts:29-45`（checkExpiringCerts 从不校验文件是否存在）：删除的临期证书最长 30 天每天弹通知；外部删除（资源管理器/同步冲突）产生孤儿元数据则**永久**提醒。修法：checkExpiringCerts 校验文件存在（用工作区索引批量判断，避免慢 FS 逐条 stat），回收站条目排除出提醒。
- **P1-C3 系统通知不可用时完全静默且照记去重** — `index.ts:204-210, 226-235`：未检查 `Notification.isSupported()`；Linux 无通知守护进程时 `show()` 不抛异常只是不显示；先落盘去重再发送 → 当天被认为已提醒，用户什么都看不到，应用内也无兜底。修法：启动探测，不支持/失败时降级为渲染进程内提醒（复用 update 事件通道）并不记入去重；至少在 FAQ 说明 Linux 需通知守护进程。

### P2（下版本排期，紧凑收录）

**内存/骨架**：
- `child-process-gone` 是 app 级监听，注册在 `setupCrashRecovery` 内随每次窗口重建累积（`index.ts:117-121`）→ 移到模块级只注册一次。
- 最小化 2 分钟静默 reload 丢弃未保存 UI 状态（`window.ts:86-95`）→ reload 前探测是否有打开的预览/未保存编辑。
- `importCancelled` Set 只增不减（`ipc.ts:57,130-141`）→ cancel 时校验在途或加 TTL。
- 工作区索引：load miss 走 build 不清空 → 跨工作区残留（`indexCache.ts:186-222`）；`dirtyDirs` 只增不减（`indexCache.ts:31,164-166`）→ 设上限或定期裁剪。
- 主进程 watchdog 决策落地（见 P1-R3）。

**PDF/预览**：
- 双重 destroy 的 promise rejection 未捕获（`PdfPreview.tsx:127-132`）→ `.catch(() => {})`。
- 缩放百分比初始瞬态显示 0%（`:114-115`）；搜索 0 结果无提示（`:102-105`）；单页渲染失败仅 console.error → 补 UI 提示。
- `stores/preview.ts:38-60` openPreview 无序号守卫（连开两文件慢的覆盖新的）；`loadMetadata` 同病 → 加序号守卫。

**证书提醒**：
- 切工作区不触发检查、去重 key 不含工作区标识（`index.ts:239-243`、`notify.ts:45`）→ 切钩子追加检查 + key 加工作区 hash。
- 过期多年的证书每天按"将于 X 到期"提醒（`dashboard.ts:38` 无下限）→ 加下限或改"已于 X 过期"分组。
- 通知无点击行为、逐条轰炸（`index.ts:204-235`）→ 聚合一条 + click 唤起主窗口跳 Dashboard。
- Certs 页无到期徽标（`Certs.tsx:280-282`）、`loadAllCerts` 无代数守卫（`:68-90`）、`clickTimer` 死代码（`:46`）。
- 每日提醒锚定启动时刻、受睡眠漂移（`index.ts:383-386`）→ 每小时检查本地日期变更。

**文件操作/元数据**：
- metadata 内存缓存从不回读磁盘（`metadata.ts:40-56`）→ 双机同步变更被本机下一次保存整体覆盖；按 mtime 失效。
- renameFile 校验不足（`files.ts:363-400`）：不挡 Windows 非法字符 `:*?"<>|`、保留名 CON/NUL、尾随点/空格；仅大小写改名被"目标已存在"误拒。
- 元数据迁移孤儿/覆盖边角（`files.ts:466-473`、`trash.ts:119-130` 恢复加 `-恢复N` 后 key 不匹配）；importOneFile 无条件覆盖已有元数据（`files.ts:287-288`）。
- `writeJsonAtomic` 无 fsync、tmp 孤儿无清理（`paths.ts:85-90`）；元数据并发写 last-writer-wins（`metadata.ts:83-89`）。
- trashItem 兜底留孤儿 data 目录（`trash.ts:71-76`）；`empty()` 单条失败仍报"已清空"（`trash.ts:194-199`）；目录 size 显示 inode 大小误导（`trash.ts:84`）。
- watcher 降级模式仅靠目录 mtime 签名，同目录文件覆盖不触发重建（`index.ts:276-306`）。
- Trash.tsx `relLocation` 只认 `/`（`:27-30`）；fileContextMenu 取首个"产品集"段（`fileContextMenu.ts:159-163`）在工作区路径含同名目录时提取错误；deleteSubfolder 先删后 saveConfig 的顺序不一致（`files.ts:348-359`）。

**拖拽/剪贴板/导入**：
- `import:complete` 后 3 秒 idle 定时器竞态（`GlobalDropOverlay.tsx:146`）；progress/complete 事件不带 token 混显。
- 内部拖拽标记 8s 窗口吞掉拖回（`dragout.ts:23-30`）；`dragend` 不派发平台监听器逐次累积（`:38`）。
- 目录展开阶段无进度反馈假 8%（`GlobalDropOverlay.tsx:298-299`）；walk 不跟随符号链接 → 经 symlink 的文件静默漏导（`files.ts:235-239`，无循环风险已确认）。
- `composeTargetName` 对 product_set/sub_folder 不过 sanitizeName（`naming.ts:20-37`）；importFiles 的 targetDir 无越界校验（与 moveFiles 不一致）。
- text/uri-list 兜底写裸路径非 `file://` URI（`dragout.ts:43`）；取消粒度只在文件边界（`files.ts:201`）；dialog 打开期间再 drop 静默替换待导入列表（`GlobalDropOverlay.tsx:249`）。
- explorer：超时即视为成功（`explorer.ts:26-29`）；Linux 缺 nemo/thunar/caja fallback（`:76-77`）。

**安全/打包/工程**：
- 协议前缀校验不解析 realpath（`protocol.ts:54-69`）；`shell.openExternal` 无 scheme 白名单（`window.ts:101-104`）。
- 日志按天滚动永不清理、含敏感绝对路径（`log.ts`、`protocol.ts:58/66`）→ 启动清理 N 天前。
- NSIS 卸载不清 userData（缩略图缓存可达 GB 级 + account.json 含 token）——需决策并写进文档。
- 跨平台构建陷阱：`npmRebuild: false` 下在 Linux 交叉打 Windows 包会把 Linux 版 sharp 二进制打进去 → Windows 缩略图静默全废。固化到 `docs/PACKAGING.md`/CI。
- `xlsx:exportTemplate`/`xlsx:import` 路径无校验（`ipc.ts:270-271`）。
- `protocol.ts:43` base64 try/catch 是死代码；`render-process-gone` 把休眠 destroy 的 clean-exit 也计数（实际无影响）。
- e2e 假绿两项：剪贴板用例 CI 永远 skip（`platform.spec.ts:71-73`）；"资源管理器显示"断言验证不了真实效果（`platform.spec.ts:91` + `explorer.ts:26-29`）；`xlsx.spec.ts` 漏断言"批量系列二"。

## 5. 修复批次建议

**批次一（上线前必修）**：

1. 主问题修复 1–5（VirtualGrid / 队列 / FileThumbnail / 缓存头 / 测试补强）。
2. P0-1 一行类型修正。
3. P0-2 Windows 实机验证 + 修复。
4. 安全收口组（S1–S3）。
5. 数据安全组（D1–D7；D3+D4 合并一次元数据 key 迁移）。
6. 导入链路组（I1–I4）。
7. 骨架组（R1、R2、R4、R5、R6；R3 按"删除模块"执行）。
8. 证书提醒组（C1–C3）。

**批次二（紧随的 2.4.x）**：PDF 组（P1–P3，P1 先落地短期方案）、通知聚合 + 点击跳转、Certs 页到期徽标与加载守卫、协议 realpath、metadata mtime 失效、日志清理、NSIS 清理策略决策、preview store 序号守卫。

**批次三（可延后）**：其余 P2。

## 6. 验收标准

> 数值为基于本项目场景的合理目标，首次实测后可校准；不达标即不通过。

### A. 主问题（切换文件夹渲染）

- A1 两个各含 ≥50 图的文件夹来回切换 20 次：每次网格显示的文件名集合与目标文件夹 `files.list` 结果**完全一致**，无旧文件夹残留、无新旧混杂。
- A2 已缓存文件夹切换后首屏图片全部显示 ≤ 300ms（本地 SSD）。
- A3 首次浏览 200 张未缓存图（本地文件系统）：首屏可见缩略图全部显示 ≤ 3s；滚动到底全程无"永久骨架屏"。
- A4 旧文件夹 500 张未缓存图积压时切换：新文件夹首屏 ≤ 3s（代际作废生效）。
- A5 单张坏图（删除其缩略图缓存文件制造 404）：显示 emoji 占位；再次进入该文件夹自动重试；不影响同屏其他图。
- A6 连续切换 + 滚动 10 分钟后：DOM 节点稳定在每屏 40–60；渲染进程 JS heap 增长 ≤ 50MB；主进程缩略图队列清空、无残留 pending。
- A7 e2e 强断言用例通过：切换后 `img[src^="qihebox://thumb/"]` 的 src 集合与目标文件夹 `files.list` 一致。

### B. 内存

- B1 万图文件夹滚动到底再回顶：DOM 节点 < 100。
- B2 PDF 打开→关闭 20 次（含加载中秒关）：渲染进程 RSS 增量 ≤ 100MB（无 document/worker 泄漏）。
- B3 导入 1000 张图期间继续浏览其他文件夹：浏览缩略图正常出现（队列不被导入饿死）；主进程 RSS ≤ 500MB。
- B4 托盘隐藏/休眠销毁重建窗口 10 次：无 `MaxListenersExceededWarning`，app 级监听器数量恒定。

### C. PDF 与媒体

- C1 100MB+ PDF：行为符合所选方案（整载则有明确加载提示、Linux 不 OOM 白屏；或 DataRangeTransport 分页加载）。
- C2 损坏/加密 PDF：显示错误界面 + 「用系统程序打开」引导，不白屏。
- C3 视频预览拖动进度条正常（修 P1-P2 后验收）。

### D. 证书到期提醒

- D1 `expiry_date` 分别为 `YYYY-MM-DD`、`YYYY/M/D`、ISO 带时间：三种都能正确进入提醒列表；非法值（如 `2023-02-30`）记 warn 且不影响其他证书。
- D2 删除一张临期证书（进回收站）：当天起不再收到其系统通知，Dashboard 列表不再出现。
- D3 外部删除文件（资源管理器删）后：孤儿元数据不再触发提醒。
- D4 模拟系统通知不可用：应用内有兜底提示，且当日不误记去重（恢复后仍能收到）。

### E. 文件操作

- E1 无扩展名文件 `LICENSE` 冲突导入/移动 → 目标为 `LICENSE_1`，原名保留。
- E2 新建产品集/子文件夹输入 `../x`、`a/b`、`a\b`：明确拒绝，工作区外零创建，config 不污染。
- E3 同产品集不同子文件夹的同名文件：标签/备注互不影响；purge 其一不殃及其他；Win 写入的 key 在 Linux 可读（迁移后）。
- E4 批量移动 50 个文件、第 25 个被锁：返回成功/失败明细，前端可见；已移动不回滚、未移动在原位；无源/目标双份。
- E5 导入 500 个文件、其中 3 个不可读：497 个完成 + 失败清单可见；重试不产生 `_1` 重复副本。
- E6 回收站 purge 一个子文件夹后：userData 中对应缩略图缓存确实被删除；同路径新文件显示新图。
- E7 坚果云活跃同步期间浏览：单文件 stat 失败不拖垮整个文件夹列表。
- E8 工作区内存在指向外部的符号链接：delete/move/open/协议层均拒绝越界操作。
- E9 文件名含 `$(…)`，多选「在资源管理器中显示」：按字面处理，无任何命令执行。

### F. 剪贴板与拖拽

- F1 Windows 实机：复制 3 个文件 → 资源管理器 Ctrl+V 成功；微信会话粘贴成功。
- F2 Linux（有 xclip）：复制后 1s 内出现「已复制」提示，IPC 不挂起。
- F3 Linux（无 xclip）：复制要么经 xsel/wl-copy 真实成功，要么明确报错；不假成功。
- F4 多文件拖出到桌面/文件管理器：Windows 与 Linux 均成功。
- F5 拖入含 3 层嵌套 + 空目录 + 符号链接的文件夹：递归平铺导入、无循环；symlink 目标文件的处理行为与文档说明一致。
- F6 导入进行中 startDrag 未缓存图：拖拽即时响应（不等缩略图）。

### G. 工程门禁

- G1 `npx tsc --noEmit`（两个 tsconfig）全绿；`npm test` 全绿（含新增队列/命名/通知/元数据单测）；`npm run build` 成功。
- G2 e2e 强断言切文件夹用例通过；无依赖弱断言的用例冒充覆盖。
- G3 CI 全绿。

### H. 安全与健壮

- H1 `saveTextFile`、`fileList` 传越界路径：主进程拒绝。
- H2 同一崩溃页 10 分钟内崩 3 次：app 退出或回安全页，不无限 reload。
- H3 preload 白名单复核：不存在未经主进程校验的文件写/删原语。

## 7. 上线前人工验收 Checklist

**Windows 实机**（覆盖源码无法验证项）：

- [ ] 复制文件到剪贴板 → 资源管理器 / 微信 / 钉钉粘贴（P0-2 终验）
- [ ] 多文件拖出到桌面 / 聊天窗口
- [ ] 右键「在资源管理器中显示」单选与多选
- [ ] 系统通知（到期提醒、导入完成）弹出与点击行为
- [ ] 应用内更新检查提示
- [ ] 安装 → 使用 → 卸载；确认 userData 残留策略符合决策
- [ ] 含中文/空格/特殊字符路径的导入、预览、复制

**Linux 实机**：

- [ ] 有 xclip / 无 xclip 两种环境的复制（F2/F3）
- [ ] 多文件拖出（DDE / GNOME 至少各一）
- [ ] 系统通知（有 / 无通知守护进程两种环境，D4）
- [ ] AppImage 启动与桌面集成

**坚果云同步活跃期专项**：

- [ ] 同步进行中浏览大文件夹（E7、A 组复测）
- [ ] 未水合文件导入（E5 复测）
- [ ] 双机共享工作区：元数据/缩略图跨平台一致（E3）

---

*文档版本：v1（审计基准：v2.4.1 + 工作区未提交改动）。修复完成后按 §6 逐条验收并在此文档勾销。*

## 实施状态（v2.4.2 批次一）

批次一已于 2026-08-09 实施完毕，验证结果：

- **代码变更**：主进程（thumbnail 队列重构、files/metadata/trash/dashboard/workspace/paths/naming、ipc 全部 handler、protocol、clipboard、explorer、index）+ 渲染层（VirtualGrid/FileThumbnail 修复、preview/FileBrowser/MoveDialog/api 适配、证书降级横幅）+ preload + 测试。`memoryWatchdog.ts` 已按 R3 决策删除。
- **工程门禁**：双 tsconfig `tsc --noEmit` 全绿；vitest 123/123 通过（新增 13 项：ThumbQueue 5 项、naming 无扩展名、导入整批容错、metadata 隔离/懒迁移/批量写/日期归一化、dashboard 日期+存在性、无扩展名冲突导入）；`electron-vite build` 成功。
- **待实机验收（不可在本环境完成）**：
  - P0-2 Windows 剪贴板（Set-Clipboard 方案）→ §7 Windows 实机清单第 1 项。
  - e2e 切文件夹强断言（已改写为「src 集合无交集 + 数量吻合」，需 Xvfb/桌面环境跑）。
  - 坚果云活跃同步期专项、双机共享工作区元数据一致性（§7）。
- **行为变化提示**：导入不再同步生成缩略图（I4，改为浏览时按需生成）；文件删除/移动部分失败不再整体报错而是返回明细（D5，前端已适配展示）；元数据 key 结构变更带旧数据懒迁移（D3+D4）。

### v2.4.2 追加：交互统一 + dev 下 PDF 打不开的根因修复

用户实机反馈后追加：

1. **单击/双击/右键统一**（FileBrowser / Images / Certs 三页）：单击立即选中（再点一次取消，纯 toggle）、双击打开预览、右键未选中项自动先选中再出菜单。原先 Certs 页单击直接弹预览、FileBrowser/Images 有 250ms 延迟选中，三页行为不一致。
2. **右键菜单不可用的根因**：`useContextMenu.open` 未 `stopPropagation`，事件冒泡到 window 的 contextmenu 关闭监听器 → 菜单刚打开就被立即关闭。已修。
3. **dev 下 PDF 打不开（P1-P3 深挖）**：vite 给经 module graph 服务的文件注入 `import "/@vite/client"`，pdfjs 从 blob: URL 建模块 worker 时无法解析该裸路径（`Invalid relative url or base scheme isn't hierarchical`）→ worker 加载失败 → PDF 整个打不开。打包产物不受影响（worker 为原样资产），故仅 dev 复现。修复：`electron.vite.config.ts` 将 `pdfjs-dist` 排除 `optimizeDeps` 预打包 + `PdfPreview` 中 dev 分支用 `?raw` 原始源码打 blob（生产构建该分支被 `import.meta.env.DEV` 死代码消除，worker 仍走 `?url` 独立资产，打包体积不变）。实测 dev 与打包均正常；新增 `tests/e2e/pdf.spec.ts` 回归（生成最小合法 PDF，断言 canvas 渲染且无错误横幅）。
4. **Certs 到期徽标**（批次二 P2-5 前段）：卡片显示到期日 + 倒计时（≤30 天红色），`loadAllCerts` 加代数守卫防切工作区竞态。

**追加后验证**：tsc 双配置全绿；vitest 123/123；e2e 21/21（含 pdf.spec.ts、强化版切文件夹断言）；build 体积无回退（index ~180KB，worker 独立资产）。
