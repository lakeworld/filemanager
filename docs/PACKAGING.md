# 打包与发布指南（PACKAGING）

> 启禾文件管理（Electron）安装包制作与发布全流程。覆盖：产物位置、环境准备、Linux / Windows 分平台打包、CI 打包、产物归位与验证。
> 适用版本：v2.4.1+（electron-builder 26 / electron-vite 5 / Node 22）

---

## 一、产物总览

### 1.1 产物清单

| 产物 | 平台 | 形态 | 体积参考 | 说明 |
|---|---|---|---|---|
| `启禾文件管理-<ver>.AppImage` | Linux | 免安装单文件 | ~124MB | `chmod +x` 直接运行；无 FUSE 用 `--appimage-extract-and-run` |
| `qihe-box_<ver>_amd64.deb` | Linux | 安装包 | ~124MB | `sudo dpkg -i`，安装到 `/opt/启禾文件管理/`，生成桌面菜单 |
| `启禾文件管理 Setup <ver>.exe` | Windows | NSIS 安装包 | ~123MB | 安装向导/路径选择/快捷方式/卸载器；electron-builder 26 命名带空格 |
| `启禾文件管理-<ver>-win-x64.zip` | Windows | 便携包 | ~167MB | 解压即用；`signAndEditExecutable=false` 时 exe 为默认图标 |

### 1.2 产物存放位置

| 目录 | 内容 | 说明 |
|---|---|---|
| `release/` | 本机构建产物 | electron-builder 默认输出（`.gitignore` 已忽略，不进 git） |
| `out/` | electron-vite 三段构建产物 | main/preload/renderer，打包的输入（也进 .gitignore） |
| `软件发布包/` | **对外发布目录** | 按版本分子目录：`软件发布包/<ver>/`，手动维护（.gitignore 忽略） |
| CI artifact | Actions 产物 | `qihe-box-Linux` / `qihe-box-Windows`，登录 GitHub 下载 |

**发布目录规范**（`软件发布包/<ver>/`）：

```
软件发布包/
└── 2.4.1/
    ├── 启禾文件管理 Setup 2.4.1.exe      # Windows NSIS
    ├── 启禾文件管理-2.4.1-win-x64.zip    # Windows 便携
    ├── 启禾文件管理-2.4.1.AppImage       # Linux 免安装
    └── qihe-box_2.4.1_amd64.deb          # Linux 安装包
```

> 惯例：保留当前版本 + 上一版本（回滚用），更旧版本发布时清理。

---

## 二、环境准备

### 2.1 通用要求

| 依赖 | 要求 |
|---|---|
| Node.js | 22+（Electron 43 要求） |
| npm | 10+（`.npmrc` 已配国内镜像：registry/electron/sharp 加速） |
| electron-builder | 随依赖安装（26.x） |

```bash
npm install   # 首次
npm run build # 先构建三段产物到 out/（打包命令内部也会执行）
```

### 2.2 Windows 打包的特殊要求

electron-builder 打 Windows 包需要 **wine**（用于 `rcedit` 写 exe 图标/版本资源 + `signtool` 签名）：

- **Windows 机器**：无需 wine（electron-builder 全自动）
- **Linux（含统信/Deepin）**：需 wine。统信系统自带的是 **deepin-wine**，命令名不是 `wine`，需软链：

```bash
ln -sf /usr/bin/deepin-wine10-stable ~/bin/wine   # 以实际命令名为准（可 ls /usr/bin | grep wine 确认）
export PATH="$HOME/bin:$PATH"                       # 当前终端生效
wine --version                                      # 应输出 wine-xx.x
```

> 若没有 wine：`sudo apt install wine`（约 200MB）。deepin-wine 首次运行会初始化容器，稍慢属正常。

electron-builder 打 win 包时**自动下载**以下工具到 `~/.cache/electron-builder/`（网络走 `.npmrc` 镜像，无需手动）：

- `nsis` + `nsis-resources`（安装包生成器）
- `winCodeSign`（rcedit/signtool 运行环境）
- Windows 版 Electron 二进制

### 2.3 ⚠️ sharp 原生二进制的交叉编译陷阱（v2.4.2 起）

`npmRebuild: false` 依赖 sharp 预编译二进制，**sharp 的平台二进制由 npm 按本机平台安装**（`node_modules/@img/sharp-<platform>-<arch>`）。在 Linux 上打 Windows 包时，若缺失 Windows 二进制，打包产物里只有 Linux 的 `.so` → **Windows 端缩略图静默全废**（`ensureThumbnail` 失败只回空串，不易察觉）。

**Linux 本机打 Windows 包前必须补装 Windows 二进制**（版本与 `node_modules/sharp/package.json` 的 `optionalDependencies` 一致）：

```bash
npm install --no-save --force @img/sharp-win32-x64@<sharp版本>   # 如 0.35.3
# 验证：ls node_modules/@img/ 应同时出现 sharp-linux-x64 与 sharp-win32-x64
```

- `--force`：该包的 `os: ["win32"]` 在 Linux 上默认拒绝安装，需强制
- `--no-save`：不进 package.json（本机专属，避免污染锁文件；CI/Windows 机器无需此步）
- 打包后在 `release/win-unpacked/resources/app.asar.unpacked/node_modules/@img/` 中应能看到 `sharp-win32-x64`
- sharp 运行时按 `process.platform` 加载对应包，win + linux 二进制共存于 node_modules 无冲突

---

## 三、分平台打包

### 3.1 Linux（AppImage + deb）

```bash
npm run build:linux
# = electron-vite build && electron-builder --linux --publish never
```

产物：`release/启禾文件管理-<ver>.AppImage` + `release/qihe-box_<ver>_amd64.deb`

> `--publish never`：禁止 electron-builder 在 CI 环境隐式发布（无 `GH_TOKEN` 时会失败）。

### 3.2 Windows NSIS 安装包

**本机 Linux（有统信 wine）**：

```bash
export PATH="$HOME/bin:$PATH"   # 若 wine 软链在 ~/bin
npm run build:win
# = electron-vite build && electron-builder --win --publish never
```

产物：`release/启禾文件管理 Setup <ver>.exe`

**CI / Windows 机器**：见第四节，最省事。

### 3.3 Windows 便携 zip

```bash
npx electron-builder --win zip -c.win.signAndEditExecutable=false
```

产物：`release/启禾文件管理-<ver>-win.zip`（重命名为 `-win-x64.zip` 统一命名）。

> `signAndEditExecutable=false`：跳过 rcedit（wine 依赖），**无需 wine** 也能在 Linux 打 zip；代价是 exe 为默认 Electron 图标（功能不受影响）。
> 想保留图标但只跳过签名：`-c.win.signExecutable=false`。

---

## 四、CI 打包（GitHub Actions）

`.github/workflows/ci.yml` 的 `package` job（matrix: ubuntu-latest + windows-latest）在每次 push/PR 自动执行：

| Job | 平台 | 产物 |
|---|---|---|
| Package (ubuntu-latest) | Linux | AppImage + deb |
| Package (windows-latest) | Windows | NSIS Setup exe |

产物上传为 artifact：`qihe-box-Linux` / `qihe-box-Windows`。

**下载**：GitHub 仓库 → Actions → 对应 run → Artifacts → 下载 zip（需登录）。Windows 产物用此路径最标准（干净 Windows 环境，图标/版本完整）。

---

## 五、产物归位与发布

1. 把 `release/` 产物拷入 `软件发布包/<ver>/`（规范见 1.2）
2. 冒烟验证（见第六节）
3. 官网同步（qihe-erp 仓库，需部署确认）：
   - `web/public/version.json` → 新版本 + 坚果云下载链接 + 更新说明（应用内「检查更新」读取）
   - `web/src/views/site/FileManagerView.vue` 版本号
4. 推送触发 CI 全绿后即可对外

---

## 六、冒烟验证清单

安装/运行后抽查：

- [ ] 启动进入仪表盘，无报错
- [ ] 打开旧工作区（数据兼容，零迁移）
- [ ] 产品集 → 建 SKU → 拖拽导入图片 → 缩略图显示
- [ ] 标签打标（含子标签）、删除标签不复活
- [ ] 文件移动 / 批量重命名 / 目录拖入导入
- [ ] 切换文件夹瞬时（索引命中）
- [ ] 预览：图片 / PDF（pdfjs）/ 视频
- [ ] 右键菜单：六处入口一致、点击外部即关闭
- [ ] 「我的 → 更新」检查更新（有网时）

---

## 七、常见问题

| 现象 | 原因与处理 |
|---|---|
| `wine: 未找到命令` | 统信 wine 命令名非 `wine`——`ls /usr/bin \| grep wine` 找实际命令（如 `deepin-wine10-stable`），软链到 `~/bin/wine` 并加 PATH |
| `GH_TOKEN is not set` | electron-builder CI 隐式发布——打包命令必须带 `--publish never`（package.json scripts 已带） |
| AppImage 无法运行 | 缺 FUSE：`./xxx.AppImage --appimage-extract-and-run`，或 `sudo apt install libfuse2` |
| NSIS 工具下载失败 | 网络问题，重试或检查 `~/.cache/electron-builder/`；`.npmrc` 已配国内镜像 |
| Windows 打包在 Linux 报 rcedit 失败 | wine 缺失或版本过旧——确认 `wine --version` 可用 |
| 打包体积异常 | `npm ls --prod` 应只有 sharp/exceljs；`electronLanguages` 只留 zh-CN/en-US（electron-builder.yml 已配） |
| Windows 端缩略图全废 | Linux 本机打 win 包漏了 `@img/sharp-win32-x64`（见 2.3）——验证 `release/win-unpacked/resources/app.asar.unpacked/node_modules/@img/` 含 win32 目录 |
| 中文路径（坚果云）项目 | e2e/bench 有已知兼容问题；打包本身无碍 |

---

## 八、版本号与 CHANGELOG

- 版本号：`package.json` `version` 字段（electron-builder 读取，产物名/版本信息用它）
- 每次发布必更：`CHANGELOG.md`（更新日志）+ `docs/RELEASE-<ver>.md`（发布说明）+ 官网 `version.json`
- 发布节奏建议：功能/修复合入 → bump 版本 → 全量 CI 绿 → 打包 → 冒烟 → 归位 → 官网同步
