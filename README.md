# 启禾文件管理

> **启禾生态成员** · 云端企业级能力见 [启禾 OS · 仓迹](https://www.qihebook.cloud/)——AI 原生 ERP，自然语言操作（订单 / 库存 / 财务 / 客户）

一个基于 **Electron + TypeScript + SolidJS + Tailwind CSS** 的跨平台桌面应用（Windows / Linux），用于管理电商产品图包与证书文件。

> 核心理念：**产品集驱动的文件工厂**。以产品集为组织单元、图包/证书为内容分类，整个工作区自包含，复制到任何位置即可使用。
>
> 授权模式：**开源免费**。无需激活，下载即用全部功能。

## 产品定位

**启禾文件管理** 是一款面向 **电商运营、销售团队以及线下客户经理** 的本地化产品资料管理工具。

> **与启禾 ERP 的关系**：文件管理器是独立于 ERP 的开源免费桌面产品，不依赖 ERP 账号即可使用；但它延续启禾 ERP 的品牌、设计语言与工程标准，可视为启禾产品生态向本地工具场景的延伸（BOX 项目）。

它解决的核心痛点是：

- 产品图片、证书、检测报告散落在微信、钉钉、邮件和各处文件夹中，查找困难。
- 发给客户或平台时容易拿错版本、遗漏文件。
- 素材和证书没有统一的归类和检索方式。

通过「产品集 → 图包 / 证书 → 子文件夹」的简单结构，它把产品相关资料集中管理，让用户能够快速预览、搜索、筛选，并一键复制到剪贴板或打开文件夹进行外发。

**典型用户**：电商卖家、品牌方运营、供应链销售、需要频繁给客户发送产品资料的线下业务人员。

## 架构

**v2.0 起由 Wails v2 + Go 迁移至 Electron**（迁移动机：Linux 支持硬需求 + 全 TS 技术栈统一 + 自带 Chromium 绕开系统 WebKitGTK 兼容风险）。

```
src/
├── main/            # 主进程（TypeScript）
│   ├── core/        # 纯 TS 业务层（不依赖 electron，可 node 直测）
│   │   ├── workspace.ts   # 工作区/产品集/配置/最近工作区
│   │   ├── files.ts       # 文件列表/导入/重命名/删除
│   │   ├── naming.ts      # 命名模板引擎 + 冲突后缀
│   │   ├── metadata.ts    # 元数据（损坏自动备份降级）
│   │   ├── search.ts      # 全局搜索
│   │   ├── dashboard.ts   # 仪表盘统计
│   │   ├── xlsx.ts        # XLSX 模板/批量导入
│   │   ├── paths.ts       # 路径常量/安全校验/原子写
│   │   └── scanCache.ts   # 目录树 mtime 签名扫描缓存
│   ├── thumbnail.ts  # sharp 缩略图（限并发队列）
│   ├── protocol.ts   # qihebox:// 文件协议（流式 + Range + 越界校验）
│   ├── clipboard.ts  # Win CF_HDROP / Linux text/uri-list
│   ├── explorer.ts   # 资源管理器选中（dde-file-manager/nautilus/dolphin/shell）
│   ├── ipc.ts        # IPC 薄壳（仅透传 + ApiResult 包装）
│   ├── notify.ts     # 证书到期系统通知（每日去重）
│   ├── updater.ts    # 应用内更新检查（version.json + 语义化比对）
│   └── window.ts     # 无边框窗口/托盘/隐藏到托盘
├── preload/         # contextBridge 暴露 window.qihebox（白名单 API）
└── renderer/        # SolidJS 前端（页面零改动，仅绑定层换源）
```

## 主要功能

- 工作区自包含：文件、配置、元数据在同一文件夹内；**缩略图缓存存于 userData**（v2.1.0，不再污染工作区/坚果云同步）
- **默认工作区**：启动自动恢复最近工作区，首次使用自动创建 `~/启禾文件管理`
- 产品集 → 图包/证书 → 子文件夹 层级管理
- 拖拽导入文件，自动按命名模板重命名（冲突自动加 `_1` 序号）；**目录拖入**递归平铺导入
- **文件移动**：跨子文件夹 / 跨产品集移动，元数据与缩略图跟随
- **批量重命名**：多选文件 → 前缀 + 序号
- **应用内更新检查**：启动 / 每 24h 静默检查 + 手动检查，发现新版引导前往官网下载
- XLSX 模板导入/导出（批量建产品集）
- **标签体系**：父/子标签层级，颜色可自由修改，删除后不再复活（不再有固定预设标签），文件与产品集统一打标
- 证书到期提醒（30 天内）
- 全局搜索（异步 + 防抖 + 扫描缓存）
- 一键复制文件到剪贴板（微信/钉钉直接粘贴）、资源管理器选中
- **拖拽拖出**：文件直接拖到桌面/聊天窗口（原生多文件拖拽）
- **统一右键菜单**：预览/用默认程序打开/复制/复制路径/重命名/删除
- 系统托盘常驻、无边框窗口、单实例
- 大图/PDF/视频流式预览（qihebox:// 协议，支持 Range；PDF 采用 pdfjs-dist 官方 PDFViewer：连续滚动、文本层、全文搜索、任意缩放）
- 崩溃自愈：渲染进程崩溃自动 reload、元数据损坏自动备份
- 性能：路由懒加载 + 虚拟滚动（万图 DOM 恒定 ~40 节点）+ 扫描缓存 + 缩略图限并发队列 + 渲染层 URL 缓存

## 开发

环境要求：Node.js 20+（Electron 43 建议 Node 22+）

```bash
npm install          # 安装依赖（.npmrc 已配置国内镜像加速）

npm run dev          # 开发模式（热更新 + 应用窗口）
npm test             # 单元测试（vitest，仅 tests/unit，96 用例）
npm run test:e2e     # 端到端测试（Playwright，19 用例，e2e 模式 QIHEBOX_E2E=1）
npm run bench        # 性能基准（数据记录在本地内部文档，不进公开仓库）
npm run build        # 构建三段产物到 out/
npm run build:linux  # 打包 Linux（AppImage + deb）
npm run build:win    # 打包 Windows（NSIS，需在 Windows/CI 构建）
```

## 打包产物

| 平台 | 产物 | 目标体积 |
|---|---|---|
| Linux | `release/启禾文件管理-2.4.2.AppImage` / `.deb` | ≤ 140MB |
| Windows | `release/启禾文件管理-2.4.2-win-x64.zip`（便携） / `Setup 2.4.2.exe`（NSIS） | ≤ 195MB |

## Windows 安装提示（SmartScreen）

Windows 安装/运行时提示「未知发布者」或蓝色警告是**正常现象**：当前安装包未做代码签名（签名需商业证书），Windows 对从网上下载的未签名程序都会提示。处理方式：

1. 点击「更多信息」
2. 选择「仍要运行」
3. 仅从官网 / GitHub Releases 下载安装包（保障来源可信）

> 本项目免费开源、无商业签名证书。项目正在评估免费代码签名方案（如开源项目免费证书 / Azure Trusted Signing），落地后此提示将消失；目前对安全提示敏感的用户可改用 Linux 版（AppImage / deb，无此步骤）。

## 数据兼容性

工作区数据格式与 v1.x（Wails 版）完全兼容：`config.json` / `metadata.json` / `product_sets.json` 结构不变；缩略图 v2.1.0 起缓存于 userData（`app.getPath('userData')/thumbs`），旧工作区 `.thumbnails/` 缓存自动迁移复用，**零迁移直接打开**。

## 目录说明

```
.
├── src/main/        # 主进程（TS，业务在 core/ 与 electron 解耦）
├── src/preload/     # 预加载（contextBridge）
├── src/renderer/    # SolidJS 前端（原 frontend/ 迁入）
├── tests/
│   ├── unit/        # vitest 单测（core 层）
│   ├── bench/       # 性能基准
│   └── e2e/         # Playwright _electron
├── docs/            # 公开文档（发布说明等；运维/规划类文档本地保留）
└── scripts/         # 辅助脚本
```

## 许可证

Copyright © 2026 启禾软件
