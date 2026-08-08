# 进程与性能（Performance）

> 本文档说明 启禾文件管理 的进程架构、内存特征与性能优化设计，供维护与性能调优参考。
> 数据基线见 `docs/PERF.md`（bench 自动追加）。

## 一、进程架构（Electron 多进程模型）

应用启动后共 **4 个进程**（Deepin x64，v2.1.1 进程瘦身生效）：

| 进程 | 类型 | 职责 | 空载 RSS 参考 |
|---|---|---|---|
| 主进程 | `Browser` | 窗口/托盘/IPC/协议/缩略图调度 | ~280MB |
| 渲染进程 | `Renderer` | 页面 UI、虚拟滚动、PDF 预览 | ~148MB |
| GPU 进程 | `GPU` | 软件渲染空壳（--disable-gpu 后） | ~90MB |
| 工具进程 | `utility` | 网络栈（NetworkService，架构强制） | ~77MB |

> 空载总内存 ~600MB（v2.1.1 前 ~800MB / 7 进程）。~520MB 是 **Electron 43 + Deepin 软件渲染** 的
> 固有基线（Chromium 平台成本），不是应用逻辑开销。Windows 有 GPU 加速且无 zygote。

**v2.1.1 进程瘦身**（`electron-builder.yml` `linux.executableArgs`）：

- `--no-zygote`：去掉 3 个 zygote 孵化器（-3 进程 -118MB）。必须为启动参数（appendSwitch 运行时设置时机太晚不生效）
- `--disable-gpu`：Deepin 本就软件渲染，GPU 进程 207MB → 90MB 空壳，无崩溃
- 仅 Linux 生效；Windows 无 zygote 且保留 GPU 加速，不加参数
- ⚠️ 实测证伪：`--single-process`（极限合并为 1 进程）在 Deepin 上启动即崩（SIGTRAP），已放弃；
  `--js-flags` 与 `disableHardwareAcceleration` 历史上有启动崩溃记录，均不启用

**进程可靠性设计**：

- **渲染进程崩溃** → 自动 reload，最多 3 次后退出（`index.ts setupCrashRecovery`）
- **主进程崩溃** = 应用退出（无法自愈）→ 所以一切**原生渲染一律不进主进程**：
  - 图片缩略图：sharp（纯 C 库，经多年验证稳定）
  - PDF 预览：pdfjs 渲染进程 canvas（Chromium Skia）
  - ⚠️ 历史教训：`pdfjs + @napi-rs/canvas` 渲染真实证书 PDF 会原生段错误（SEGV）导致主进程闪退，已禁用该路径；PDF 不做缩略图（见下文"产品决策"）

## 一·五、内存实测（v2.1.1 进程瘦身后，Deepin，1 万张图目录）

| 阶段 | 渲染进程 RSS | DOM 节点 | 说明 |
|---|---|---|---|
| 空载（Dashboard） | ~150MB | — | 总内存 ~600MB（4 进程） |
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
