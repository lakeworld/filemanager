# 启禾文件管理 编译指南（Electron 版 v2.5.6）

本文档说明如何构建与打包 启禾文件管理（Electron + TypeScript + SolidJS），包括开发调试、单元/端到端测试、性能基准与安装包产出。

---

## 一、环境要求

| 依赖 | 版本 | 用途 |
|------|------|------|
| Node.js | 20+（建议 22+） | 前端与主进程构建 |
| npm | 10+ | 依赖管理 |
| electron-builder | 随依赖安装 | 打包 NSIS / AppImage / deb |

> Linux 构建 AppImage/deb 可在本机直接进行；Windows NSIS 建议在 Windows 或 CI（GitHub Actions windows runner）上构建。

## 二、安装依赖

```bash
npm install
```

> 项目内置 `.npmrc`：npm 源与 Electron/sharp 二进制均走国内镜像，中国大陆网络下无需手动配置代理。

## 三、开发模式

```bash
npm run dev
```

- electron-vite 构建 main / preload / renderer 三段并启动 Electron
- 前端热更新（Vite dev server），主进程改动自动重启

## 四、测试

```bash
npm test            # 单元测试（vitest，855 用例）
npm run test:e2e    # 端到端测试（Playwright _electron，161 用例，e2e 模式 QIHEBOX_E2E=1；无桌面环境需 xvfb-run）
npm run bench       # 性能基准（数据记录在本地内部文档，不进公开仓库）
```

## 五、构建与打包

```bash
npm run build        # 构建三段产物到 out/
npm run build:linux  # Linux：release/启禾文件管理-*.AppImage + *.deb
npm run build:win    # Windows：release/启禾文件管理 Setup-*.exe（NSIS）
```

> 打包命令均带 `--publish never`：只产出安装包，不自动发布 Release。CI package job（GitHub Actions）同样以该参数做双平台打包验证，产物以 artifact 形式下载。

### 产物清单

| 平台 | 产物 | 体积（实测） |
|---|---|---|
| Linux | `release/启禾文件管理-2.5.6.AppImage` | 104MB |
| Linux | `release/qihe-box_2.5.6_amd64.deb` | 104MB |
| Windows | `release/启禾文件管理 Setup 2.5.6.exe` | ~90MB（待 Windows 构建确认） |

> 体积优化已启用：asar + maximum 压缩 + 依赖归位（运行时仅 sharp/exceljs）+ Chromium 语言包精简（zh-CN/en-US）。
> Electron 自带 Chromium 与 sharp 原生库是体积大头（对比 Wails 版 11MB exe），这是跨平台一致性的固有代价。

## 六、架构速览

```
src/main/core/     # 纯 TS 业务层（不依赖 electron，可 node 直测）
src/main/          # 主进程：窗口/托盘/协议/剪贴板/资源管理器/IPC
src/preload/       # contextBridge 白名单 API（window.qihebox）
src/renderer/      # SolidJS 前端（原 Wails 版前端零改动迁入）
tests/unit|bench|e2e
```

数据兼容：工作区 `config.json` / `metadata.json` / `.thumbnails/` 与 v1.x 完全一致，旧工作区零迁移打开。

## 七、常见问题

### 7.1 Electron 二进制下载慢/失败

`.npmrc` 已配置 `electron_mirror=https://npmmirror.com/mirrors/electron/`；若仍失败可手动设置环境变量：
```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
```

### 7.2 AppImage 无法运行（FUSE）

```bash
./启禾文件管理-*.AppImage --appimage-extract-and-run   # 绕过 FUSE
# 或安装 libfuse2
```

### 7.3 打包体积优化

- 运行时依赖保持最小：`npm ls --prod` 应仅见 sharp + exceljs
- 平台裁剪：仅安装当前平台 sharp 二进制（`@img/sharp-linux-x64` 等）
- `electronLanguages` 只保留 zh-CN/en-US

### 7.4 在含空格路径（如坚果云）下调试

Playwright `_electron.launch` 对含空格路径有已知兼容问题，e2e/bench 通过项目内 `tests/` 或临时无空格入口规避；`npm run dev` 不受影响。
