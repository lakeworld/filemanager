# 启禾文件管理 编译指南

本文档说明如何在 Windows 上从零开始编译 启禾文件管理，包括环境搭建、开发调试、打包可执行文件和安装包。

---

## 一、环境要求

| 依赖 | 版本 | 用途 |
|------|------|------|
| Go | 1.23+ | 后端编译 |
| Node.js | 20+ | 前端构建 |
| Wails CLI | v2.12+ | Wails 应用构建 |
| NSIS | 3.10+ | 仅生成 `.exe` 安装包时需要 |

> 所有工具都可以安装在用户目录下，**不需要管理员权限**。

---

## 二、环境安装

### 2.1 方案 A：便携版安装（推荐，无需管理员权限）

#### 1) 安装 Go

下载 Windows amd64 zip 版：

```powershell
# 下载并解压到用户目录
mkdir -Force "$env:USERPROFILE\.go"
Invoke-WebRequest -Uri "https://go.dev/dl/go1.23.4.windows-amd64.zip" -OutFile "$env:USERPROFILE\.go\go.zip"
Expand-Archive -Path "$env:USERPROFILE\.go\go.zip" -DestinationPath "$env:USERPROFILE\.go" -Force
```

#### 2) 安装 Node.js

下载 Windows x64 zip 版：

```powershell
mkdir -Force "$env:USERPROFILE\.node"
Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.18.1/node-v20.18.1-win-x64.zip" -OutFile "$env:USERPROFILE\.node\node.zip"
Expand-Archive -Path "$env:USERPROFILE\.node\node.zip" -DestinationPath "$env:USERPROFILE\.node" -Force
```

#### 3) 配置环境变量

创建环境脚本 `C:\Users\<用户名>\.qihefilemanager-env.ps1`：

```powershell
$env:GO_ROOT = "$env:USERPROFILE\.go\go"
$env:NODE_ROOT = "$env:USERPROFILE\.node\node-v20.18.1-win-x64"
$env:GO_BIN = "$env:USERPROFILE\go\bin"
$env:Path = "$env:GO_ROOT\bin;$env:NODE_ROOT;$env:GO_BIN;$env:Path"
$env:GOPROXY = "https://goproxy.cn,direct"
```

每次打开 PowerShell 时加载：

```powershell
. "$env:USERPROFILE\.qihefilemanager-env.ps1"
```

在 Git Bash 中可创建 `~/.qihefilemanager-env.sh`：

```bash
export GO_ROOT="$HOME/.go/go"
export NODE_ROOT="$HOME/.node/node-v20.18.1-win-x64"
export GO_BIN="$HOME/go/bin"
export PATH="$GO_ROOT/bin:$NODE_ROOT:$GO_BIN:$PATH"
export GOPROXY="https://goproxy.cn,direct"
```

加载：

```bash
source ~/.qihefilemanager-env.sh
```

#### 4) 安装 Wails CLI

```bash
source ~/.qihefilemanager-env.sh
go install github.com/wailsapp/wails/v2/cmd/wails@latest
wails version
```

#### 5) 安装 NSIS（仅打包安装包时需要）

从 Chocolatey NuGet 包下载便携版：

```powershell
mkdir -Force "$env:USERPROFILE\.nsis"
Invoke-WebRequest -Uri "https://community.chocolatey.org/api/v2/package/nsis.portable/3.10.0" -OutFile "$env:USERPROFILE\.nsis\nsis.portable.nupkg"
Expand-Archive -Path "$env:USERPROFILE\.nsis\nsis.portable.nupkg" -DestinationPath "$env:USERPROFILE\.nsis" -Force
Expand-Archive -Path "$env:USERPROFILE\.nsis\tools\nsis-3.10.zip" -DestinationPath "$env:USERPROFILE\.nsis" -Force
```

将 NSIS 加入 PATH：

```bash
export PATH="$HOME/.nsis/nsis-3.10:$PATH"
```

验证：

```bash
makensis -VERSION
```

---

### 2.2 方案 B：标准安装（需要管理员权限）

- **Go**: 下载 `.msi` 安装包并运行：https://go.dev/dl/
- **Node.js**: 下载 `.msi` 安装包并运行：https://nodejs.org/
- **Wails CLI**: 安装 Go 后执行 `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- **NSIS**: 下载安装包：https://nsis.sourceforge.io/Download

---

## 三、配置 npm 镜像（中国大陆推荐）

```bash
npm config set registry https://registry.npmmirror.com
```

---

## 四、编译步骤

### 4.1 克隆/进入项目

```bash
cd /e/qihefilemanager
```

### 4.2 加载环境

```bash
source ~/.qihefilemanager-env.sh
export PATH="$HOME/.nsis/nsis-3.10:$PATH"
```

### 4.3 生成应用图标

应用图标源文件是 `build/logo.svg`。在构建可执行文件或安装包之前，如果修改过图标，请先运行：

```bash
pip install Pillow
python scripts/render_logo.py
```

该脚本会基于 `build/logo.svg` 生成：
- `build/appicon.png`（512×512，Wails 用它生成 Windows 可执行文件图标）
- `build/trayicon.png`（64×64，系统托盘图标）
- `build/trayicon.ico`（托盘图标 ICO 容器）

### 4.4 开发模式

```bash
wails dev
```

- 自动编译前端并启动 Vite 开发服务器
- 自动编译 Go 后端
- 启动应用窗口
- 前端热更新生效

### 4.5 构建 Windows 可执行文件

```bash
wails build -platform windows/amd64
```

产物：

```
build/bin/qihefilemanager.exe
```

### 4.6 构建 Windows 安装包

```bash
wails build -platform windows/amd64 -nsis
```

产物：

```
build/bin/qihefilemanager.exe
build/bin/qihefilemanager-amd64-installer.exe
```

> 需要先安装 NSIS 并确保 `makensis.exe` 在 PATH 中，否则 `-nsis` 会失败。

---

## 五、在 Linux 服务器上构建

如果你不想在 Windows 本地打包，可以把源码上传到 Linux 服务器（如 Ubuntu），在服务器上交叉编译出 Windows 安装包。

### 5.1 环境要求

服务器系统：Ubuntu 22.04+ / Debian 12+（其他发行版可手动安装对应包）。

需要 root 或 sudo 权限执行安装脚本。

### 5.2 一键安装依赖

```bash
cd /path/to/qihefilemanager
./scripts/setup-server.sh
```

该脚本会自动安装：
- Git、curl、build-essential
- Go 1.23+
- Node.js 20+
- NSIS（`makensis`）
- Wails CLI

脚本运行完成后，执行：

```bash
source ~/.bashrc
```

### 5.3 一键构建

```bash
./scripts/build-server.sh
```

构建完成后，产物位于：

```
build/bin/qihefilemanager.exe
build/bin/qihefilemanager-amd64-installer.exe
```

把这两个文件下载到 Windows 即可分发或安装。

### 5.4 手动步骤（如果不用脚本）

```bash
# 安装依赖
sudo apt-get update
sudo apt-get install -y git curl wget build-essential nsis

# 安装 Go（以 1.23.4 为例）
curl -L https://go.dev/dl/go1.23.4.linux-amd64.tar.gz -o /tmp/go.tar.gz
sudo tar -C /usr/local -xzf /tmp/go.tar.gz
export PATH=$PATH:/usr/local/go/bin

# 安装 Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 Wails CLI
go install github.com/wailsapp/wails/v2/cmd/wails@latest
export PATH=$HOME/go/bin:$PATH

# 构建
cd /path/to/qihefilemanager
cd frontend && npm install && cd ..
go mod tidy
wails build -platform windows/amd64 -nsis
```

---

## 六、关键配置文件说明

### 6.1 `wails.json`

```json
{
  "$schema": "https://wails.io/schemas/config.v2.json",
  "name": "qihefilemanager",
  "outputfilename": "qihefilemanager",
  "wailsjsdir": "./frontend/src",
  "frontend:install": "npm install",
  "frontend:build": "npm run build",
  "frontend:dev:watcher": "npm run dev",
  "frontend:dev:serverUrl": "auto",
  "frontend": {
    "dir": "./frontend"
  }
}
```

> **注意**：`frontend:build` 和 `frontend:install` 必须使用带冒号的键名，否则 `wails build` 会跳过前端编译，导致运行时白屏。

### 6.2 `frontend/package.json`

前端依赖：`solid-js`、`@solidjs/router`、Tailwind CSS、Vite 等。

---

## 七、常见问题

### 7.1 `wails build` 跳过前端编译

错误表现：日志中出现 `No Build command. Skipping.`，运行后白屏。

解决：确保 `wails.json` 中使用 `frontend:install` 和 `frontend:build` 键名，不要使用嵌套对象格式。

### 7.2 前端构建报错找不到 `wailsjs/go/main/App`

原因：`wailsjsdir` 配置与前端 import 路径不一致。

解决：确保 `wails.json` 中 `wailsjsdir` 设置为 `./frontend/src`，与 `src/wails/api.ts` 中的 import 路径 `~/wailsjs/go/main/App` 一致。

### 7.3 Go 模块下载失败

在中国大陆建议设置 Go 代理：

```bash
export GOPROXY="https://goproxy.cn,direct"
```

### 7.4 NSIS 安装包构建失败

确保 `makensis.exe` 在 PATH 中：

```bash
which makensis
makensis -VERSION
```

---

## 八、验证环境

```bash
wails doctor
```

应显示：

- Go Installed
- Node.js Installed
- npm Installed
- WebView2 Installed
- NSIS Available/Installed

---

## 九、产物清单

| 文件 | 大小 | 说明 |
|------|------|------|
| `build/bin/qihefilemanager.exe` | ~11 MB | 独立可执行文件，可直接运行 |
| `build/bin/qihefilemanager-amd64-installer.exe` | ~6 MB | Windows 安装包 |

---

## 十、官网与下载发布

官网营销页已合并进 ERP SPA，文件管理介绍页位于 ERP 域名 `/file-manager` 路径；安装包通过 `/box/downloads/` 发布。

| 路径 | 用途 | 本机端口/目录 |
|---|---|---|
| `https://www.qihebook.cloud/box/` | 官网静态站点 | `/opt/qihe-erp/qihefilemanager/web-tools/dist` |

### 10.1 构建

```bash
cd web-tools
npm install
npm run build
```

产物：`web-tools/dist/`

### 10.2 部署

与 ERP 共用同一域名和 SSL 证书，**不需要新增 DNS 记录**。

已写入 Nginx 配置：
- `/etc/nginx/snippets/qihe-box-locations.conf`
- `/etc/nginx/conf.d/qihe-box-zones.conf`

并已在 `/etc/nginx/sites-enabled/qihe-erp.conf` 中 include。

如果 Nginx 配置被 ERP 部署覆盖，重新执行：

```bash
sudo cp /opt/qihe-erp/qihefilemanager/deploy/qihe-box-path-locations.conf /etc/nginx/snippets/qihe-box-locations.conf
sudo cp /opt/qihe-erp/qihefilemanager/deploy/qihe-box-path-zones.conf /etc/nginx/conf.d/qihe-box-zones.conf
# 确保 qihe-erp.conf 的 443 server 块中有：include /etc/nginx/snippets/qihe-box-locations.conf;
sudo nginx -t && sudo systemctl reload nginx
```

#### 上传安装包

```bash
sudo mkdir -p /opt/qihe-erp/qihefilemanager/downloads
sudo cp build/bin/qihefilemanager-amd64-installer.exe /opt/qihe-erp/qihefilemanager/downloads/
sudo chown -R www-data:www-data /opt/qihe-erp/qihefilemanager/downloads
```

### 10.3 下载限速

为防止安装包被爬虫刷流量，Nginx 已对 `/box/downloads/` 做了限制：

- 单个 IP 每秒最多 1 次下载请求（burst=3）
- 单个 IP 最多 2 个并发下载连接

如需更严格的防盗链，后续可升级为签名下载链接或接入 CDN。

---

## 十一、与启禾 ERP 的关系

**启禾文件管理** 是一个**独立于 ERP 的项目**，但它是基于启禾 ERP 的设计语言、品牌体系和工程标准延伸出来的产品。

| | 启禾 ERP | 启禾文件管理（BOX 项目） |
|---|---|---|
| 定位 | 企业业务系统（聊天、库存、采购、订单、财务等） | 本地桌面工具（产品图包 / 证书资料管理） |
| 架构 | Web 应用，浏览器访问 | Wails 桌面应用，Windows 本地运行 |
| 用户 | 租户内员工，多人在线协作 | 个人/销售，单机免费使用 |
| 数据 | 云端 PocketBase，多主体隔离 | 本地工作区，数据不上云 |
| 部署 | `www.qihebook.cloud` | `box.qihebook.cloud` |
| 授权 | 租户订阅 / 系统密钥 | 开源免费 |

两者共用：
- 同一台服务器和 Nginx 入口
- 同样的品牌、配色、字体
- 同样的 Vue/SolidJS + SCSS 工程风格

ERP 用户可以在 `box.qihebook.cloud` 了解到文件管理器；文件管理器的购买者不需要 ERP 账号即可独立使用。

---

## 十二、调试白屏

如果运行后白屏：

1. 确认构建日志中出现 `Compiling frontend: Done`
2. 确认 `frontend/dist/` 下有 `index.html` 和 `assets/`
3. 使用开发模式运行查看控制台报错：

```bash
wails dev
```

4. 在 `main.go` 中临时启用 DevTools 打包测试版：

```go
LogLevel: logger.DEBUG,
```

并设置：

```go
Debug: options.Debug{
    OpenInspectorOnStartup: true,
},
```
