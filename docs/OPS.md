# 运维指南（OPS）

> 启禾文件管理 · Linux 部署/升级/备份/排障。桌面应用运维的核心是**工作区数据**与**发布渠道**。

## 一、安装与升级

### Linux（deb / AppImage）

```bash
# 安装 / 覆盖升级
sudo dpkg -i qihe-box_2.1.0_amd64.deb

# AppImage（免安装，直接运行）
chmod +x 启禾文件管理-2.1.0.AppImage
./启禾文件管理-2.1.0.AppImage
```

安装位置：`/opt/启禾文件管理/`（deb 包，含 `qihe-box` 可执行文件与 `resources/app.asar`）。

**升级前建议**：确认工作区已备份（见下）。升级后旧版缩略图缓存自动迁移，零迁移打开工作区。

### Windows（便携 zip）

解压 `启禾文件管理-2.1.0-win-x64.zip` 运行 `启禾文件管理.exe`，免安装；升级 = 解压新包替换。

> 正式 NSIS 安装包需在 Windows/CI 构建（Linux 下打 exe 需要 wine，本机未安装）。

## 二、数据与备份

| 数据 | 位置 | 备份建议 |
|---|---|---|
| **工作区（核心数据）** | 用户指定文件夹（默认 `~/启禾文件管理`） | 整目录复制/坚果云同步；`.qihefilemanager/` 内含 config/metadata/tags |
| 缩略图缓存（可重建） | `~/.config/启禾文件管理/thumbs/<workspaceHash>/` | 无需备份，丢失自动重建 |
| 应用配置/最近工作区 | `~/.qihefilemanager_recent.json` | 无需备份 |

> 工作区放在坚果云/OneDrive/NAS 目录即可多机同步使用；缩略图缓存在 userData，不进云。

**备份一条命令**：

```bash
cp -r "工作区目录" 备份目录/$(date +%Y%m%d)
```

## 三、日志与进程

- 日志目录：`~/.config/启禾文件管理/logs/`（应用日志，`log.ts` 写入）
- 崩溃记录：`~/.config/启禾文件管理/Crashpad/`（Chromium 崩溃转储）
- 系统级崩溃（主进程 SEGV 等）：`journalctl --since today | grep qihe-box` / `dmesg | grep segfault`

```bash
# 查看进程（正常 7 个：主/渲染/GPU/zygote×3/utility）
ps aux | grep qihe-box

# 应用运行期间二次启动会直接退出（单实例锁，托盘常驻设计）——不是崩溃
```

## 四、常见故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动一闪而过（"闪退"） | 单实例锁（已有实例在托盘） | 检查 `ps aux | grep qihe-box`，确认后再启动；或托盘菜单「退出」 |
| 二次启动无反应 | 同上 | 同上 |
| 证书 PDF 预览空白 | 畸形 PDF 解析失败 | 预览内「用系统程序打开」兜底 |
| 图片无缩略图 | 旧版图片未补生成 | 重新导入一次，或触发重新生成（mtime 变化） |
| 缩略图缓存异常 | userData thumbs 损坏 | 删除 `~/.config/启禾文件管理/thumbs` 自动重建 |
| 主进程崩溃日志有 `SEGV` | 历史上 pdfjs+canvas 渲染真实 PDF 崩溃（v2.1.0 已禁用该路径） | 升级到 2.1.0+ |
| 升级后配置失效 | — | 检查 `~/.config/启禾文件管理` 权限与磁盘空间 |

## 五、发布流程（维护者）

```bash
npm test && npx playwright test   # 全量测试
npm run build:linux               # AppImage + deb → release/
npx electron-builder --win dir    # win-unpacked → zip 便携包（无 wine 环境）
# 拷贝到 软件发布包/ 目录
# 官网同步：version.json（版本+更新说明+下载链接）→ 本地 web 构建 → rsync dist
```

官网文件站：`box.qihebook.cloud`（nginx 配置见 `deploy/`，限速下载）。

### 版本号管理

- `package.json` `version` 字段（electron-builder 读取）
- `CHANGELOG.md` 记录更新内容（每次发布必更）
- 官网 `version.json` 与安装包版本保持一致

## 六、安全与隐私

- **本地优先**：数据全部在工作区本地，应用无任何上传行为；源码开源（Apache-2.0）可审计
- 缩略图等派生数据在 userData，不进入工作区云同步目录
- 对外下载仅经官网（HTTPS + nginx 限速），安装包不随源码仓库发布
