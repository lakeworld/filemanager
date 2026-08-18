# 启禾文件管理

> **官网下载（Windows / Linux）：https://www.qihebook.cloud/file-manager**
> 开源免费 · 无需注册 · 下载即用

## 这是什么

一款帮你**管好产品资料**的免费桌面软件：把散落在微信、钉钉、邮件和各文件夹里的产品图片、证书、说明书，按「产品集」归拢到一起，想找什么几秒就能翻出来，一键发给客户。

**谁适合用**：电商卖家、品牌运营、供应链销售——凡是经常要给客户发产品图、发证书的人。

**它解决的事**：

- 图片证书散得到处都是，要用时翻半天 → 按产品集统一收纳，搜索/筛选/标签随用随取
- 发给客户怕拿错版本 → 命名自动规范，到期证书提前 30 天提醒
- 发给客户步骤繁琐 → 选中一键复制，微信/钉钉里 Ctrl+V 直接粘贴原图；也能直接拖进聊天窗口

**几个放心点**：

- **资料全在你自己电脑上**：软件不联网上传任何东西，工作区就是一个普通文件夹，整个拷到另一台电脑就能接着用（配合坚果云等同步盘还能多机共享）
- **开源免费**：代码全部公开（GitHub `lakeworld/filemanager`），核心功能永久免费，无广告无激活
- **不怕误删**：删除进回收站，30 天内可恢复

## 三分钟上手

1. **下载安装**：点上方官网链接，选 Windows 或 Linux 版本（文件夹里有图文安装教程，跟着点就行）
2. **选工作区**：第一次打开选一个常用文件夹（比如新建一个"我的图库"），以后资料都放这里
3. **开始用**：把图片文件夹直接拖进软件 → 建产品集 → 打标签 → 搜索/预览/一键外发

## 遇到问题？

- **加入用户群**：https://www.qihebook.cloud/wechat-group（微信扫码入群，长期有效）
- **邮箱反馈**：1252235854@qq.com
- **Windows 安装提示"未知发布者"**：这是正常现象（软件未购买商业签名证书），点「更多信息 → 仍要运行」即可。请只从上方官网获取安装包
- 软件内「我的」页面也有入群与反馈入口

## 更多

- 与 [启禾 OS](https://www.qihebook.cloud/)（AI 原生 ERP）同生态：文件管理是独立的免费桌面工具，不依赖启禾 OS 账号即可使用
- 详细功能说明见 [HELP.md](HELP.md)；版本更新记录见 [CHANGELOG.md](CHANGELOG.md)；最新版发布说明见 [docs/RELEASE-2.5.3.md](docs/RELEASE-2.5.3.md)

---

## 开发者

技术栈：Electron + TypeScript + SolidJS + Tailwind CSS（Windows / Linux 桌面应用）。

- **理念**：本地优先、工作区自包含（文件 + 配置 + 元数据同一文件夹），无数据库，纯 JSON 持久化
- **插件体系**：v2.5 起公开插件协议（API_VERSION=1，冻结只增不删），教学插件 15 分钟上手 → [docs/PLUGIN.md](docs/PLUGIN.md)
- **登录服务地址**：应用内置可选账号登录（仅匿名活跃统计，不登录不影响任何本地功能）。源码不写死服务器地址，地址由安装包随包携带（`resources/server.json`）；自建部署可在应用数据目录放 `server.json`（`{"apiBase": "https://your-server/api"}`）覆盖
- **数据兼容性**：工作区数据格式与 v1.x（Wails 版）完全兼容，零迁移直接打开

```bash
npm install          # 安装依赖（.npmrc 已配置国内镜像加速）
npm run dev          # 开发模式（热更新）
npm test             # 单元测试（vitest，754 用例）
npm run test:e2e     # 端到端测试（Playwright，136 用例）
npm run build        # 构建三段产物到 out/
npm run build:linux  # 打包 Linux（AppImage + deb）
npm run build:win    # 打包 Windows（NSIS）
```

构建说明见 [BUILD.md](BUILD.md)；性能基线公开维护于 [docs/PERF.md](docs/PERF.md)。环境要求：Node.js 20+。

## 许可证

Apache-2.0 · Copyright © 2026 启禾软件
