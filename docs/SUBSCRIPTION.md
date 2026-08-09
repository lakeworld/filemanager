# 启禾文件管理（box）订阅体系 + 插件框架设计

> 状态：设计稿（分支 `feat/subscription`，未实施、未发布）
> 范围：本仓库（客户端）+ 服务端（qihe-erp）全链路设计
> 关联：后端仓库 `/home/lake/Nutstore Files/我的坚果云/qihe-erp`、官网 `/file-manager`

## 1. 背景与目标

启禾文件管理 v2.3.1 定位为「开源免费、无需激活、下载即用全部功能」。为支撑长期迭代，计划引入**订阅增值模式**：核心能力保持开源免费，进阶能力（个人版 / 团队版 / AI）以**插件形态**按需交付。

设计目标：

- **核心不动**：现有本地文件管理、索引、虚拟滚动、PDF/图片预览等基础功能永久免费
- **新功能一律插件形态**：AI、个人版权益、团队版权益各自独立成插件，安装/卸载/订阅过期联动
- **客户端瘦身**：插件默认不带入安装包，按需下载，主包体积不膨胀
- **服务端硬校验兜底**：涉及资金与数据安全的接口（AI 用量、索引备份、提醒推送）服务端强制校验订阅档位，客户端只做 UI 门控
- **离线可用**：本地功能不依赖网络；订阅状态本地缓存，断网不锁功能

> ⚠️ 本期状态：**仅设计文档**。不实现代码、不做人工收款、不打包、不部署。支付网关（微信支付等）仅预留接口，是否上线、上线形式由用户后续决策。

## 2. 产品定位与定价（草案）

| 档位 | 价格 | 定位 |
|------|------|------|
| 开源免费版 | ¥0 | 本地文件管理、产品集（限 50 个）、索引、虚拟滚动、基础 PDF/图片预览、AI 试用 50 次 |
| 个人版 | ¥29/年 | 免费版全部 + 证书到期邮件提醒 + 云端索引备份 + 高级搜索/批量操作 + 产品集不限量 |
| 团队版 | ¥158/年 | 个人版全部 + 不限席位 + 协作锁 + 云端策略锁 + 状态仪表盘（本期仅预留） |
| AI 插件 | 按量付费 | 证书 OCR、自动标签、语义搜图（所有版本通用，登录即用，含免费试用额度） |

### 权益矩阵

| 能力 | 免费版 | 个人版 | 团队版 |
|------|:---:|:---:|:---:|
| 本地文件管理 / 索引 / 虚拟滚动 / 拖拽 | ✅ | ✅ | ✅ |
| PDF / 图片预览与基础编辑 | ✅ | ✅ | ✅ |
| 产品集 | ≤50 | 不限 | 不限 |
| AI 试用额度 | 50 次（登录） | 50 次（登录） | 50 次（登录） |
| 证书到期本地弹窗（30 天） | ✅ | ✅ | ✅ |
| 证书到期邮件提醒（30/7/1 天） | ❌ | ✅ | ✅ |
| 云端索引备份 / 恢复 | ❌ | ✅ | ✅ |
| 高级搜索（标签+时间+类型+证书状态组合） | ❌ | ✅ | ✅ |
| 批量操作（重命名/移动/打标签） | 基础 | 高级 | 高级 |
| 团队协作（锁 / 策略 / 仪表盘） | ❌ | ❌ | 预留 |

> 收款方式待定：人工开通、微信支付等均为未来决策项，不在本期范围。

## 3. 总体架构

```
box 客户端 (本仓库)                         服务端 (qihe-erp)
─────────────────                         ─────────────────
渲染层 SolidJS                            /api/box/me           订阅+额度+插件清单
  stores/plugins.ts（运行时信号）           /api/box/heartbeat   响应附订阅摘要
  features.ts → enabled(id)               /api/box/plugins      插件清单+下载
  8 处 FEATURE_AI 引用改造                 /api/box/index-backup 云端索引备份(存取)
主进程                                    /api/box/cert-reminders 证书提醒上报
  PluginService（下载/校验/启停）           box_remind 协程        30/7/1 天邮件提醒
  AccountService（订阅缓存）               box_subscriptions 表   订阅状态
  workspace 产品集限额                     （支付网关：预留）
  backup / remind 定时器
```

- 订阅判定：客户端本地缓存（登录/心跳/`/box/me` 刷新）+ 服务端接口硬校验
- 插件与订阅关系：**插件=能力包，订阅=许可证**。插件安装后是否生效取决于订阅档位是否覆盖该插件的 tier（free ⊂ personal ⊂ team）

## 4. 插件框架（客户端，核心）

### 4.1 设计原则

- 插件 = **单个 JSON manifest**（几十 KB）+ 可选资源文件。功能开关、版本、校验信息全在 manifest 中
- 插件包由服务端 `GET /api/box/plugins/{id}/download` 动态生成，**无需独立静态托管**
- 安装目录：`userData/plugins/{id}/manifest.json`（跨平台一致）
- 安装 ≠ 启用：启用需「已安装 && 当前订阅 tier 覆盖插件 tier」
- 订阅过期：已安装插件自动停用（保留安装记录，UI 提示续费，不删用户数据）

### 4.2 插件清单（第一版三档）

| 插件 id | 名称 | tier | 内容 |
|---------|------|------|------|
| `ai` | AI 智能整理 | 全版本通用 | rename/tag/cert/search 四种 AI 动作（代码已实现，`FEATURE_AI` 门控） |
| `personal` | 个人版权益包 | personal | 证书邮件提醒 + 云端索引备份 + 高级搜索/批量操作 + 产品集不限量 |
| `team` | 团队版权益包 | team | 协作锁/策略锁/状态仪表盘（本期仅占位，功能后置） |

### 4.3 Manifest 格式（草案）

```json
{
  "id": "personal",
  "name": "个人版权益包",
  "version": "1.0.0",
  "tier": "personal",
  "min_box_version": "2.4.0",
  "download_url": "https://api.example.invalid/box/plugins/personal/download",
  "checksum": "sha256:...",
  "features": ["cert-reminder", "index-backup", "advanced-search", "batch-ops", "unlimited-product-sets"],
  "icon": "data:image/svg+xml;base64,...",
  "published_at": "2026-08-01T00:00:00Z"
}
```

### 4.4 PluginService（`src/main/plugins.ts`，新增）

职责与依赖注入（与 `account.ts` 同风格，vitest 可测）：

- `listInstalled()` — 读 `userData/plugins/` 下已安装 manifest
- `fetchCatalog()` — `GET /api/box/plugins` 拉可安装清单
- `install(id)` — 下载 → 校验 sha256 → 写 `userData/plugins/{id}/manifest.json`
- `remove(id)` — 卸载（不删任何工作区数据）
- `status(id)` — `{installed, version, enabled, tier, reason}`（reason: `not_installed / tier_mismatch / subscription_expired / ok`）
- 启动 + 订阅变化时重算 `enabled` 集合，通过 IPC 事件 `qihebox:event:plugins:changed` 通知渲染层

### 4.5 IPC / preload（新增 4 通道）

| IPC channel | preload API | 说明 |
|---|---|---|
| `qihebox:plugin:list` | `plugins.list()` | 已安装插件 + 状态 |
| `qihebox:plugin:install` | `plugins.install(id)` | 下载安装 |
| `qihebox:plugin:remove` | `plugins.remove(id)` | 卸载 |
| `qihebox:plugin:status` | `plugins.status(id)` | 单插件状态 |

### 4.6 渲染层改造（`FEATURE_AI` → 运行时信号）

现状：`src/renderer/src/features.ts` 定义编译期常量 `FEATURE_AI = false`，8 处引用点：

| 文件 | 行 | 用途 |
|---|---|---|
| `src/renderer/src/pages/Profile.tsx` | 400/408/418/485 | AI 试用横幅 / 功能简介 / 剩余额度 |
| `src/renderer/src/pages/FileBrowser.tsx` | 561/567 | 右键菜单「AI 批量命名 / AI 打标」 |
| `src/renderer/src/pages/Search.tsx` | 197 | 「🤖 AI 搜索」按钮 |
| `src/renderer/src/components/FilePreviewModal.tsx` | 130 | 「🤖 AI 抽取信息」按钮 |

改造方案：

- `features.ts` 删除 `FEATURE_AI`，导出 `enabled(id: string): boolean`（读 `stores/plugins.ts` 信号）
- 新建 `src/renderer/src/stores/plugins.ts`（SolidJS store）：`installed() / enabled(id) / install(id) / remove(id) / status(id)`，订阅变化时刷新
- 8 处引用改为 `enabled('ai')`；AI 生效条件 = **插件已安装 && 已登录**（服务端 `box_ai_quota` 额度校验不变）
- 门控语义：未安装 → 入口隐藏；已安装但未登录 → 点击提示登录

## 5. 订阅状态与 Entitlement（客户端）

### 5.1 AccountStatus 扩展（`src/main/account.ts`）

```ts
export interface SubscriptionInfo {
  tier: 'free' | 'personal' | 'team'
  status: 'none' | 'active' | 'expired'
  expires_at: string | null   // ISO
  days_left: number | null
}

export interface AccountStatus {
  loggedIn: boolean
  email: string
  sessionExpired: boolean
  remaining: number | null      // AI 试用剩余
  subscription: SubscriptionInfo // 新增
}
```

### 5.2 刷新通道（三处，任一成功即更新本地缓存）

1. **登录响应**：`auth-with-password` 成功后调用 `GET /api/box/me` 拉取
2. **主动刷新**：`qihebox:account:refresh` IPC（Profile 页「刷新订阅」按钮）
3. **心跳响应**：`POST /api/box/heartbeat` 响应附带 `subscription` 摘要（被动兜底）

落盘：`userData/account.json`（与 token 同文件，safeStorage 加密，Linux 无 keyring 降级明文，同现状）。

### 5.3 过期处理

- 每日启动时校验 `expires_at`：过期 → `status: 'expired'`，插件自动停用，UI 提示续费
- 服务端校验为准：`index-backup` / `cert-reminders` / `ai` 接口返回 `SUBSCRIPTION_REQUIRED` / `SUBSCRIPTION_EXPIRED` 时，客户端刷新本地状态并提示

### 5.4 本地破解说明（v1 接受）

客户端缓存可被本地篡改；v1 不做设备指纹强绑定。资金/数据相关能力（AI 用量、索引备份、提醒推送）全部服务端硬校验，篡改仅影响 UI 展示。

## 6. 各档功能设计（客户端）

### 6.1 产品集限额（免费版 50）

- `src/main/core/workspace.ts` `productSetCreate()`（当前 301 行起）：创建前统计 `product_sets.json` 数量，≥50 且 tier 非 personal/team → 抛 `PRODUCT_SET_LIMIT`
- `productSetList()` 返回 `{ sets, limit, tier }`，前端 `ProductSets.tsx` 超限时显示升级引导卡片（跳官网定价页）
- 删除走回收站（v2.3.1），回收站内的产品集**计入**限额（防绕过）

### 6.2 高级搜索 / 批量操作（personal 门控，UI 层）

- `src/main/core/search.ts`：`search(query, filters)` 支持组合筛选 `{ tags, recent_days, file_type_ext, subfolder, cert_status }`（`types.ts` 中 `AiSearchFilters` 已预留 tags/recent_days 字段）
- `src/renderer/src/pages/Search.tsx`：筛选栏 UI（personal 插件启用才渲染）
- `FileBrowser.tsx`：多选模式 + 批量重命名/移动/打标签（personal 门控）
- 主进程不做硬校验（纯本地能力，UI 门控 v1 足够；与「高级」区分的基础批量操作保持免费）

### 6.3 证书到期邮件提醒（personal）

- 保留免费版本地 30 天弹窗：`src/main/core/dashboard.ts` `checkExpiringCerts()`
- personal 插件启用时：主进程定时器（启动 + 每 24h）将 30 天内到期证书 `{ product_set, file_name, cert_type, expiry_date }` 上报 `POST /api/box/cert-reminders`
- 隐私边界：**只上传文件名 + 到期日 + 证书类型，不上传文件本体与图片**（与现有 AI 边界一致，见 `account.ts` 头注释）
- 服务端负责：去重、窗口控频（30/7/1 天各发一次）、订阅过期停发

### 6.4 云端索引备份 / 恢复（personal）

- 新增 `src/main/core/backup.ts`：
  - `backup()`：打包 `.qihefilemanager/` 下 `metadata.json / product_sets.json / tags.json / config.json` 为单 JSON → `POST /api/box/index-backup`
  - `restore()`：拉取最近一份 → **原子写回**（先写 `.bak` 再覆盖，防写一半损坏）
- 触发：personal 插件启用时启动上传一次 + 每 24h 一次 + Profile 页手动按钮
- 容量说明：万级文件 metadata 约几 MB~几十 MB，全量上传可接受；服务端每用户保留 5 份

## 7. 服务端设计（qihe-erp，本期不实现）

> 全部照抄现有模式：鉴权 `box.go`（`e.Auth` + `boxAuthRequired`）、集合 `028_box_telemetry.go`（`privateKejiCollection`，API rules 全 nil）、记账 `internal/billing/billing.go`（幂等事务）、邮件 `003_smtp_otp.go`（`app.NewMailClient()`）。

### 7.1 新集合（migration `029_box_subscription.go`）

**box_subscriptions**

| 字段 | 类型 | 说明 |
|---|---|---|
| user_id | text | 唯一索引 |
| tier | text | personal / team |
| status | text | active / expired |
| starts_at / expires_at | date | 订阅起止 |
| operator_user_id | text | 开通操作人（管理端） |
| source | text | admin（人工开通） |
| idempotency_key | text | 幂等键（防重复开通） |
| created / updated | autodate | — |

**box_index_backups**

| 字段 | 类型 | 说明 |
|---|---|---|
| user_id | text | 索引 user_id |
| data | text | 索引 JSON（几 MB 级） |
| size_bytes | number | 备份体量 |
| created_at | date | 保留每用户最近 5 份，超出删最旧 |

**box_cert_reminders**

| 字段 | 类型 | 说明 |
|---|---|---|
| user_id | text | — |
| product_set / file_name | text | 唯一索引 (user_id, product_set, file_name) |
| cert_type | text | 证书类型 |
| expiry_date | date | 到期日 |
| last_sent_at | date | 最近发送时间 |
| sent_days | text | 已发窗口，如 `"30,7"` |
| channel | text | 预留：email（现值）/ wechat（未来） |

### 7.2 API 清单

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/box/me` | Bearer JWT | `{tier, status, expires_at, days_left, ai_remaining, plugins}` |
| GET | `/api/box/plugins` | Bearer JWT（或匿名，待定） | 插件目录（三档清单） |
| GET | `/api/box/plugins/{id}/download` | 无 | 动态生成 manifest JSON |
| POST | `/api/box/index-backup` | personal+ | 存备份（超 5 份删最旧） |
| GET | `/api/box/index-backup` | personal+ | 取最近一份 |
| POST | `/api/box/cert-reminders` | personal+ | 上报待提醒证书（去重） |
| POST | `/api/box/heartbeat` | Bearer JWT | 响应附 `subscription` 摘要 |
| POST | `/api/box/ai` | Bearer JWT | 档位逻辑不变（AI 按量付费后续调整） |

### 7.3 邮件提醒协程（`internal/boxremind`）

- `cmd/server/main.go` 启动 goroutine + ticker（每 6h）
- 扫描 `box_cert_reminders` 中 30/7/1 天内到期、且对应窗口未发过的记录（join `box_subscriptions` 校验 status=active）
- 邮件模板：主题「【启禾文件管理】证书到期提醒」，正文含产品集/文件名/证书类型/到期日；`app.NewMailClient().Send()` 复用 SMTP 配置（`ERP_SMTP_*`）
- 发送成功 → 更新 `sent_days` + `last_sent_at`

### 7.4 支付网关预留（本期仅设计）

- 定义接口 `PaymentGateway { CreateOrder(...) }` + `WechatPayGateway` stub（返回「未开通」）
- `.env.example` 预留键名（不写真实值）：`WECHAT_PAY_*`（商户号、API 密钥、证书路径）
- 记账函数 `ApplyBoxPurchase(app, userID, plan, cycle, amountCents, operatorID, idempotencyKey)`：幂等事务写订单 + 订阅（仿 `internal/billing/billing.go`），**本期不实现**
- 定价常量（未来）：个人版 ¥29/年 = 2900 cents、团队版 ¥158/年 = 15800 cents（`internal/contract/pricing.go`）

### 7.5 团队版预留

- 表结构/API 按「协作锁、策略锁、状态仪表盘」三块预留占位（本期不建表、不写接口）
- 客户端 `tier=team` 时 Profile 页显示「团队版即将上线」

## 8. 官网与文档口径（本期不改页面）

- 官网 `/file-manager`（`web/src/docs/file-manager/page.json` purchase 段 + `web/src/views/site/FileManagerView.vue`）：从「开源免费、不再商业化授权」改为「开源免费 + 订阅增值」三档口径，购买入口待收款方式确定后实现
- box `README.md` / `CHANGELOG.md`：授权模式段落同步更新
- ERP `docs/PRICING.md`：补 box 订阅章节
- 本仓库 `docs/OPS.md`：补订阅相关运维（备份表清理、邮件队列监控）说明

## 9. 安全与隐私边界

- **数据不出本机**（沿用现状原则）：图片/文件本体永不上传；云端仅存文件名、索引元数据、到期日
- 索引备份含标签/备注（`metadata.json` 含 `notes`）：需在 UI 明示「标签与备注将同步至云端」，提供排除项（可选只备份结构不含 notes）
- AI 调用现状边界不变：仅上传文件名 / PDF 文本 / 模板 / 标签（`account.ts:6` 注释）
- 服务端：`box_*` 集合 API rules 全 nil，仅路由可读写；管理接口 `RequirePermissionWithOverrides(e, app, permission.AdminUsers)`

## 10. 实施路线（后续，仍在分支上推进）

| 阶段 | 内容 | 验证 |
|---|---|---|
| P1 插件框架 | PluginService + IPC/preload + stores/plugins.ts + features.ts 运行时化（8 处改造） | vitest + e2e |
| P2 订阅状态 | account.ts 扩展 + `/api/box/me` + 三通道刷新 | 单测 |
| P3 客户端功能 | 产品集限额、search filters、批量操作、backup.ts、cert 上报、Profile 订阅/插件 UI | vitest + e2e |
| P4 服务端 | 3 集合 + 5 API + boxremind 协程 + 订阅校验 | go test |
| P5 管理端 | 订阅列表 / 人工开通（待收款决策后再定） | 手动 |
| P6 发布决策 | bump 版本 → 打包三件套 → 官网同步 → 坚果云 | 用户确认后才执行 |

> 每个阶段独立提交，全部完成后由用户验收，**验收通过前不合并 master、不发布**。

## 11. 开放问题

1. **收款方式**：人工开通 / 微信支付 / 其他 —— 决定管理端形态与网关实现（本期不阻塞设计）
2. **插件清单接口是否匿名可读**：匿名可读便于官网展示；登录可读便于按档位过滤
3. **索引备份容量上限**：单份上限（如 50MB）+ 超限处理（拒绝 or 压缩）
4. **证书「本地 OCR 提取到期日」**：现为手动填写（`FilePreviewModal.tsx`），后续可接 AI 抽取（已预留 `FEATURE_AI` cert 动作）
5. **团队版三件套的优先级**：协作锁 > 状态仪表盘 > 策略锁？（待用户排期）
