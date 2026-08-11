# 启禾文件管理 v2.4.1 发布说明

> 版本：2.4.1 · 2026-08-09 · 开源免费（Apache-2.0）
> 下载：官网 `https://www.qihebook.cloud/file-manager` · 源码 GitHub `lakeworld/filemanager`

---

## 一、v2.4.1 变更总览

| 类别 | 内容 |
|---|---|
| **性能** | Everything 式精简索引：全量快照 + 事件驱动 + 落盘，切换文件夹零磁盘 IO |
| **交互** | 单击选择 / 双击打开；右键菜单关闭优化 |
| **标签** | 颜色克制化；打标下拉支持子父标签选择 |
| **稳定性** | 存量类型错误清零；CI 四 job 全绿（类型/单测/e2e/双平台打包） |

### 1.1 Everything 式精简索引（核心性能升级）

- **全量索引快照**：打开工作区时一次构建全工作区文件索引，内存常驻 + 落盘持久化（`用户数据目录/index/<工作区哈希>/index.json`），二次启动直接加载，免全量扫描
- **切换文件夹零磁盘 IO**：文件列表查询命中内存快照（仅 1 次目录 `stat` 做签名比对），万级文件目录切换瞬时完成；图包库/证书库全库浏览不再逐目录扫描
- **变更驱动扫描**：只有目录真实改动才重建该目录——
  - 应用内写操作（导入/删除/改名/移动/建删子文件夹/回收站）显式失效，即时生效
  - 外部变更（在资源管理器中增删文件）由文件系统监听（`fs.watch` 递归）即时感知；监听不可用时自动降级为目录签名校验（查询时比对目录 mtime，毫秒级）
- **内存占用小**：快照存紧凑条目（`[文件名, 大小, 修改时间, 类型, 缩略图标记]`），`path` 与缩略图路径查询时纯函数推导，不做字符串冗余——万级文件约 1-2MB，LRU 上限 4096 目录兜底
- **文件操作正确性不受影响**：索引只是「文件列表只读视图」，所有写操作仍直通文件系统，索引失效即重建，永不阻塞操作

### 1.2 交互体验

- **单击选择 / 双击打开**：文件浏览器、图包库、证书库、搜索页的文件卡片——单击切换选中（250ms 延迟判定，双击自动清除避免误选），双击打开预览；搜索文件项右键菜单联动选中集（支持多选批量操作）
- **右键菜单关闭优化**：任意鼠标按键点击外部、再次右键、滚动列表均立即关闭（此前存在"不随点击消失"问题）；菜单内点击不误关

### 1.3 标签

- **颜色克制化**：标签 chip 改为中性深灰文字 + 颜色 8% 透明度淡底 + 细边框 + 实色圆点，彩色仅作点缀，整体素雅
- **子父标签选择**：打标下拉展开全部子标签（缩进 + `父/子` 前缀 + 色点），子标签可直接点选——此前候选仅顶层标签

### 1.4 其余打磨（自 v2.4.0 起一并包含）

- **应用内更新检查**：启动 + 每 24 小时静默检查（`https://www.qihebook.cloud/version.json`），发现新版本经「我的 → 更新」页提示「前往官网下载」
- **标签体系重构**：移除固定预设标签（升级一次性迁移清空）、删除不再复活、颜色自由修改
- **拖拽修复**：应用内拖出后拖回窗口不再误触发导入
- **右键菜单统一**：六处入口（文件浏览器/图包库/证书库/搜索/产品集/预览弹窗）共享 builder 一致
- **文件移动**：跨子文件夹/跨产品集移动，元数据与缩略图跟随、同名冲突自动加序号
- **导入目录**：拖入目录递归平铺导入；**批量重命名**：多选 → 前缀+序号
- **回收站**：30 天自动清理过期条目；**证书到期系统通知**：每日去重
- **外部命令健壮性**：xdg-open/文件管理器 5 秒超时 + 句柄释放（无桌面/CI 环境不再挂起）

---

## 二、安装与升级

### 2.1 Windows

- NSIS 安装包（`启禾文件管理 Setup 2.4.1.exe`）：双击安装，自动创建桌面/开始菜单快捷方式
- 便携 zip（`启禾文件管理-2.4.1-win-x64.zip`）：解压即用，升级 = 解压新包替换

### 2.2 Linux（deb / AppImage）

```bash
# deb 安装 / 覆盖升级（推荐）
sudo dpkg -i qihe-box_2.4.1_amd64.deb
# 安装位置 /opt/启禾文件管理/，桌面菜单「启禾文件管理」

# AppImage 免安装
chmod +x 启禾文件管理-2.4.1.AppImage
./启禾文件管理-2.4.1.AppImage
# 无 FUSE 环境：./启禾文件管理-2.4.1.AppImage --appimage-extract-and-run
```

### 2.3 数据兼容

- **工作区零迁移**：`config.json` / `metadata.json` / `product_sets.json` / `tags.json` 结构不变，旧工作区直接打开
- **索引快照自动重建**：索引存于用户数据目录（非工作区），版本升级自动重新构建，不影响工作区
- 缩略图缓存在用户数据目录（`thumbs/`），旧缓存自动复用

---

## 三、开发者指南

### 3.1 环境与命令

```bash
npm install          # 依赖（.npmrc 已配置国内镜像）
npm run dev          # 开发模式（热更新）
npm test             # 单元测试（vitest，tests/unit，110 用例）
npm run test:e2e     # 端到端测试（Playwright 19 用例；无桌面需 xvfb-run）
npm run bench        # 性能基准 → docs/PERF.md（不进 CI）
npm run build        # 构建三段产物到 out/
npm run build:linux  # 打包 Linux（AppImage + deb）
npm run build:win    # 打包 Windows（NSIS，建议在 CI/Windows）
```

### 3.2 CI 门禁（GitHub Actions）

`.github/workflows/ci.yml`，push 全分支 + PR 触发，四 job：

| Job | 内容 |
|---|---|
| test | tsc 双配置类型检查 + 单测 + electron-vite build |
| e2e | Xvfb 无头 Playwright（`QIHEBOX_E2E=1` 模式，主进程跳过托盘拦截） |
| package (ubuntu) | AppImage + deb（`--publish never`） |
| package (windows) | NSIS（`shell: bash` 兼容） |

### 3.3 发布流程

1. bump `package.json` version + 更新 `CHANGELOG.md` + 本文件
2. 推送触发 CI（全量门禁全绿）
3. 本机 `npm run build:linux` 出 AppImage/deb；Windows 从 CI artifact 取 NSIS
4. 冒烟：安装 → 打开旧工作区 → 抽查核心功能
5. 产物归位 `软件发布包/`；官网同步 `version.json`（版本 + 下载链接 + 说明）与下载页
6. （可选）打 git tag `v2.4.1`

### 3.4 索引设计要点（维护者）

- `src/main/core/indexCache.ts`：`WorkspaceIndex`——紧凑快照 `Map<dir, {sig, items}>`，`query` 命中零 IO（dirty 标记或目录 mtime 签名变化才重建）
- 变更链路：写操作 → `invalidate(dir)`（dirty）；`fs.watch(ws, {recursive:true})` 外部事件 → invalidate；监听失败降级签名模式
- 落盘：`userData/index/<workspaceHash>/index.json`（原子写），启动 `load` → 后台 `validate` 签名校验
- 内存：紧凑元组条目（万级 ~1-2MB），LRU 4096 目录

---

## 四、已知问题与说明

- 应用内「自动下载安装」未开放：更新检查仅提示 + 引导官网下载全新安装包
- 无桌面环境（SSH/CI）下「用默认程序打开」「在文件夹中显示」为降级行为（超时跳过）
- 索引对「同 mtime 下文件内容覆盖」的外部修改存在短暂陈旧（签名粒度），应用内操作即时生效；Windows/macOS 文件监听可覆盖该场景
