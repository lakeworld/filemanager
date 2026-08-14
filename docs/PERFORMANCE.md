# 进程与性能（Performance）

> 本文档说明 启禾文件管理 的进程架构、内存特征与性能优化设计，供维护与性能调优参考。
> 数据基线见 `docs/PERF.md`（bench 自动追加）。
> **实测规程**：每个版本发布前必做内存实测（`scripts/measure-memory.mjs`，需先 `npx electron-vite build`）
> 与性能基准（`npm run bench`），对照本文档与 `docs/PERF.md` 的基线判定（±5% 门禁）。

## 一、进程架构（Electron 多进程模型）

应用启动后共 **3 个进程**（Deepin x64，v2.2.1 进程瘦身生效）：

| 进程 | 类型 | 职责 | 空载 RSS 参考（v2.4.6 / Electron 31） |
|---|---|---|---|
| 主进程 | `Browser` | 窗口/托盘/IPC/协议/缩略图调度（含 in-process GPU） | ~239MB |
| 渲染进程 | `Renderer` | 页面 UI、虚拟滚动、PDF 预览（PDFViewer） | ~153MB |
| 工具进程 | `utility` | 网络栈（NetworkService，架构强制） | ~70MB |

> 空载总内存 ~464MB（v2.4.6 / Electron 31 实测；v2.4.5 为 ~487MB；v2.4.3 / Electron 43 为 ~580MB；v2.1.1 前 ~800MB / 7 进程）。~460MB 主要是 **Electron 31 + Deepin 软件渲染** 的
> 固有基线（Chromium 平台成本），不是应用逻辑开销。Windows 有 GPU 加速且无 zygote。
> v2.4.5 曾尝试 `--enable-features=NetworkServiceInProcess` 砍 utility 进程：Electron 31 实测不尊重该 feature（utility 仍独立存在），已撤销未固化。

**进程瘦身**（`electron-builder.yml` `linux.executableArgs`）：

- `--no-zygote`：去掉 3 个 zygote 孵化器（-3 进程 -118MB）。必须为启动参数（appendSwitch 运行时设置时机太晚不生效）
- `--disable-gpu` + `--in-process-gpu`（v2.2.1）：Deepin 本就软件渲染，GPU 逻辑并入主进程，**常驻 4 进程 → 3 进程**
- `--js-flags=--max-old-space-size=768`（v2.4.6）：堆上限 2048 → 1024 → 768，GC 触发更早、长期运行不膨胀；v2.4.6 删除 v2.3.0 的 `--max-semi-space-size=16`——Node 20 / V8 11.3 起 semi-space 随堆上限自适应缩小，显式 16MB 反把每个 isolate 年轻代抬到 ~48MB（nodejs/node#55487）
- 仅 Linux 生效；Windows 无 zygote 且保留 GPU 加速，不加参数
- ⚠️ 实测证伪：`--single-process`（极限合并为 1 进程）在 Deepin 上启动即崩（SIGTRAP），已放弃

## 一·六、分层休眠（v2.3.0，不用时降内存；v2.4.5 第三层提速 2 分钟 → 30 秒）

三层递进，全部实测通过（打包版，Deepin）：

| 层级 | 触发 | 动作 | 内存效果 |
|---|---|---|---|
| 第一层 | 窗口失焦 30 秒 | 清理 Blink 图像解码缓存（`webFrame.clearCache`） | 回来重新解码，短暂释放 |
| 第二层 | 窗口最小化 2 分钟无恢复 | 渲染进程 `reload` 回收（不可见无感） | 渲染进程回落 |
| 第三层 | 关闭到托盘 30 秒无活跃（v2.4.5：原 2 分钟） | **销毁 BrowserWindow**，渲染进程归零；`window-all-closed` 空监听阻止 Electron 默认退出 | **464MB → 295MB**（主 224 + utility 70，托盘常驻） |

- 唤醒：托盘点击 / 二次启动（`second-instance`）/ `activate` → `ensureMainWindow` 重建窗口，渲染层读 localStorage 恢复上次页面；重建后回到 ~464MB
- 销毁时机精确 30 秒（日志 `[sleep]` 链路可查；env `QIHEBOX_DESTROY_DELAY_MS` 可覆盖）；`window-all-closed` 必须监听，否则 Electron 在 Windows/Linux 全窗口关闭后默认退出（v2.3.0 修复项）
- 主进程休眠态 ~224MB 为 Electron/Chromium 基础 + in-process GPU 的物理下限（Node + 托盘），用户设想的"只剩 20-30MB"不可达（已实测确认）

**内存实测（v2.4.6 / Electron 31.7.7，Deepin，3 进程结构，smaps_rollup）**：

| 阶段 | 总内存 | 说明 |
|---|---|---|
| 空载（恢复工作区页面） | ~464MB | 主 239 / 渲染 153 / utility 70 |
| 关闭到托盘后 30 秒内 | ~464MB | 渲染仍存活（销毁倒计时中） |
| **休眠态（销毁后）** | **~295MB** | 主 224 / utility 70，渲染 0 |
| 二次启动唤醒 | ~464MB | 渲染进程重建（~153MB） |

> 演进：v2.4.3（E43）空载 580 / 休眠 408 → v2.4.5（E31）487 / 310 → v2.4.6 **464 / 295**（达成 ≤300MB 常驻目标）→ v2.4.7（客户+发票 + 打磨，干净环境实测）**472 / 300**（+1.7%，±5% 门禁内，过门禁；497-502MB 为「生产版常驻干扰下」的误记（CHANGELOG v2.4.8 段口径），以干净环境 472/300 为准）→ v2.4.8（打磨 + 补丁轮复测）**472 / 300** → v2.4.9（供应商/报价/自启/日志/命名槽位，3 次取稳定值）**472 / 301**（+0.3%，零回归；新增 ~20 IPC handler + 2 新列表页 + 日志系统无内存增长）+ **自启态 288**（`--autostart` 延迟建窗首次实测，无渲染进程、优于托盘档）。→ **v2.5（插件宿主 + 协议 + 测试四件套 + 15 项审查修复，3 次取稳定值）醒着 462 / 托盘 289 / 自启态 277**（零插件默认态，过门禁 ≤487/310/310；比 v2.4.9 略优——插件宿主零默认态加载的「零插件零内存」承诺兑现）。
> v2.4.6 收益构成：exceljs 懒加载、删 `--max-semi-space-size=16`、堆上限 768、indexCache 配额 4096→512、
> `v8CacheOptions: 'code'`；渲染层另有预览 2048px 降采样副本（解码位图 ~96MB→≤16MB/张）等优化。
> PSS/独占口径详见 `docs/PERF.md` 2026-08-11 条。

**进程可靠性设计**：

- **渲染进程崩溃** → 自动 reload，最多 3 次后退出；`did-finish-load` 重置计数（v2.2.1）
- **主进程崩溃** = 应用退出（无法自愈）→ 所以一切**原生渲染一律不进主进程**：
  - 图片缩略图：sharp（纯 C 库，经多年验证稳定）
  - PDF 预览：pdfjs 官方 PDFViewer 渲染进程 canvas（Chromium Skia）
  - ⚠️ 历史教训：`pdfjs + @napi-rs/canvas` 渲染真实证书 PDF 会原生段错误（SEGV）导致主进程闪退，已禁用该路径；PDF 不做缩略图（见下文"产品决策"）

## 一·五、内存实测（v2.2.1 进程瘦身后，Deepin，1 万张图目录）

| 阶段 | 渲染进程 RSS | DOM 节点 | 说明 |
|---|---|---|---|
| 空载（Dashboard） | ~150MB | — | 总内存 ~580MB（3 进程，GPU 并入主进程） |
| 打开图包库（1万图） | ~190MB | 36 卡片 | 虚拟滚动只渲染视口 ± overscan |
| 滚动到底 / 回顶 | ~194MB | ~36 卡片 | 节点恒定，**回落**（无泄漏） |
| 峰值 | ~197MB | 54 卡片 | 增量 ≤41MB |

**达标标准**（v2.1.0 起）：

- 万图目录 DOM 节点 ≤ 100（实际 ~40）
- 渲染进程峰值增量 ≤ 50MB 且回顶回落
- 滚动保持 60fps 级（只渲染可见行）

## 二、性能优化设计

### 1. 虚拟滚动（核心，`@tanstack/solid-virtual`）

- 图包库 / 证书库 / 产品集文件页共用 `VirtualGrid.tsx`
- 固定行高 + 响应式列数（2/4/5/6 断点），只渲染可见行 ± 3 行 overscan，滚出即卸载
- 相比 v2.0.2 的"分批渲染（slice + 哨兵，只增不减）"：万图场景 DOM 从 1 万个降到 ~40 个

### 2. 图片三级缓存

| 层级 | 位置 | 说明 |
|---|---|---|
| 原图 | 磁盘（工作区） | 永不经内存整读，`qihebox://` 流式 + Range |
| 缩略图 | userData `thumbs/<workspaceHash>/` | sharp 256px jpeg 落盘；mtime 命中复用 |
| 内存 | 渲染进程视口内 | 只保留可见行 ~40 张；滚出由浏览器回收 |

- 缩略图 URL 渲染层 LRU 缓存（上限 1000），滚动回滚命中率≈100%，免重复 IPC
- 缩略图迁移 userData（v2.1.0）：工作区不被 `.thumbnails` 污染，坚果云不同步缓存
- **产品决策**：PDF 不生成缩略图（隐藏窗口 PDFium 渲染成本高、失败回退等于白做），列表保持 📄 占位，内容以 pdfjs 预览查看

### 3. 懒加载

- 路由级懒加载：首屏只加载 Dashboard
- sharp / pdfjs 动态 import：主进程启动不加载原生库
- exceljs 延迟加载：导入/导出时才加载

### 4. 主进程并发控制

- 缩略图生成限并发 2（`thumbnail.ts` 队列），批量导入不争抢资源
- 元数据读缓存（`MetadataService` Map 缓存），大 metadata.json 不反复全量解析
- 目录扫描缓存（`scanCache.ts` mtime 签名）

### 5. 明确不启用的调优（历史坑）

| 方案 | 状态 | 原因 |
|---|---|---|
| `--js-flags` 压 V8 堆 | ❌ 不启用 | Deepin 上 Electron 43 启动崩溃（已实测） |
| `disableHardwareAcceleration` | ❌ 不启用 | Deepin 上启动崩溃 |
| `spellcheck: false` | ✅ 已启用 | 省渲染进程资源，无副作用 |

## 三、性能验证方法

```bash
npm run bench        # core 层基准 → 追加 docs/PERF.md
npm test             # 单元测试
npx playwright test  # e2e（含缩略图/协议/PDF 链路）
```

UI 层内存实测：见本文档"二、内存特征"——用 `app.getAppMetrics()`（主进程）取各进程 workingSetSize，
配合页面 `document.getElementsByTagName('*').length` 统计 DOM 节点数。

## 四、已知边界

- 空载总内存 ~700MB 为 Electron 平台基线，无法低于 Chromium 成本
- 单实例锁：应用运行期间二次启动直接退出（托盘常驻设计），非崩溃
- PDF 不生成缩略图（成本与价值不匹配），预览走 pdfjs 渲染进程（Chromium Skia），畸形 PDF 打开失败时可「用系统程序打开」
