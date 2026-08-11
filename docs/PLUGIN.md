# 启禾文件管理 插件协议（v1）

> 本文档是 启禾文件管理（qihe-box）插件协议的**公开契约**：插件作者据此开发 `.qbox` 插件，宿主行为以本文档与实现 `src/plugins/types.ts` 同源定义为准。
> **协议即承诺**：本文档写到的，宿主必须做到；宿主做到的，必须写进本文档。发现二者不符请提 issue。
> 内部实施路线与策略不在本文档范围（本地保留）；本文档只写插件作者需要的一切。

---

## 一、总览

- 插件 = 独立分发的 `.qbox` 包（zip），经应用内插件管理页安装/启停/卸载，**与本体发版完全解耦**（安装包不内置任何插件）。
- 宿主三段：主进程宿主（发现/校验/加载/握手/IPC 路由）、preload 透传命名空间、渲染层宿主（页面路由/Sidebar/右键菜单注入）。
- 设计三要素：**本体纯净**（插件代码与状态不进本体目录与本体能手写的存储）、**内存克制**（未启用零内存、按需加载）、**启动快速**（插件不进 `app ready → 窗口可交互` 关键路径）。

### 术语

| 术语 | 含义 |
|---|---|
| 宿主（Host） | 应用本体 |
| 握手 | 宿主调用插件入口 `activate(host)`，插件返回能力注册表（PluginRegistration） |
| 能力 | 插件声明的扩展点：`ipc`（服务 API）、`pages`（页面）、`commands`（右键菜单命令） |
| broken | 校验失败/熔断的插件状态：宿主不加载，管理页如实展示原因 |
| 官方索引 | 官方插件目录（JSON 索引），应用内勾选下载的来源，包哈希经索引公布比对 |

---

## 二、.qbox 包结构

```
<plugin-id>.qbox (zip)
├── manifest.json      # 清单（JSON Schema 校验，字段同 §三 PluginManifest）
├── main/index.js      # 主进程入口（编译产物）：export async function activate(host): Promise<PluginRegistration>
├── renderer/          # 渲染层编译产物（页面模块等，自包含依赖）
└── shared/            # 可选（公共类型/资源）
```

- **安装**：管理页从官方索引勾选下载，或手动导入本地 `.qbox`（侧载）→ JSON Schema + SHA-256 校验 → 解压到 `userData/plugins/<id>/pkg/` → 登记。
- **状态**：插件业务状态存 `userData/plugins/<id>/state/`（经 `host.storage` 访问）；启停覆盖存 `userData/plugins/config.json`。代码与状态分离。
- **卸载**：删除 `pkg/` 与 `state/`；「禁用」两者都保留。
- **渲染层加载**：插件 renderer 产物经 `qihebox://plugin/<id>/...` 协议 URL 动态 `import()`（访问才加载），纳入 CSP 管辖；**插件包自包含依赖**（solid-js 等打入自身产物），宿主不提供共享运行时。

---

## 三、PluginManifest 规范

包内清单为 `manifest.json`，字段与协议的同源类型定义（公开仓库 `src/plugins/types.ts`）一致：

```ts
/** 展示文本：v1 直接用裸字符串（仅中文）；为未来 i18n 预留 map 形态，
 *  解析器接受 string | map，裸字符串等价于 { default: string }（非 breaking 扩展） */
export type PluginText = string | { default: string; [locale: string]: string }

export interface PluginManifest {
  /** 全局唯一 id，域名倒序，如 'com.example.ai'。冲突 → broken */
  id: string
  name: PluginText                 // 展示名（管理页/侧边栏）
  version: string                  // 语义化版本
  apiVersion: number               // 针对的宿主 API 版本（当前 API_VERSION = 1）
  apiCompat?: [number, number]     // 兼容的宿主 API 版本范围，默认 [apiVersion, apiVersion]
  minHostVersion?: string          // 宿主产品版本下限（如 '2.5.0'），排查用
  transport?: 'inproc'             // v1 唯一合法值；'process'/'http' 为未来预留
  enabled: boolean                 // 默认启停；可被管理页覆盖
  kind: Array<'ipc' | 'pages' | 'commands'>   // 至少声明其一
  ipcPrefix: string                // IPC 通道前缀 → qihebox:plugin:<prefix>:<action>，全局唯一
  permissions?: {                  // 声明式权限（v1 用于安装确认与管理页展示）
    network?: string[]             // 域名白名单；'*' 必须附 reasoning
    clipboard?: boolean
    notification?: boolean
  }
  activation?: Array<'onStartupFinished' | `onEvent:${string}`>  // 见 §四 激活触发
  pages?: Array<{
    path: string                   // 必须以 '/plugin/' 开头，如 '/plugin/hello'
    label: PluginText
    icon: string
    group: string
    component: string              // 包内相对路径，如 'renderer/pages/Main.js'
  }>
  commands?: Array<{
    id: string                     // 插件内唯一
    label: PluginText
    scope: 'file' | 'global'
    when?: { exts?: string[] }     // 可见性过滤，防右键菜单污染
  }>
  description?: PluginText
  author?: string
  license?: string
  keywords?: string[]
  icon?: string                    // 插件自身图标（管理页展示）
  homepage?: string
}
```

**校验规则**（宿主登记阶段执行，任一失败 → broken）：

1. `id` 全局唯一；`ipcPrefix` 全局唯一；`pages[].path` 不与本体路由及已注册插件路由冲突
2. `kind` 声明与实际的 pages/commands 一致（互相有字段）
3. `apiCompat` 与宿主 `API_VERSION` 相交（`min ≤ 1 ≤ max`）；声明 `minHostVersion` 时宿主产品版本须 ≥ 该值
4. `pages[].path` 必须以 `/plugin/` 开头；`pages[].component` 必须为包内相对路径（拒绝绝对路径与 `..` 逃逸）
5. `transport` 缺省或 `'inproc'`；其余值 → broken（v1 仅进程内）
6. `permissions.network` 域名须为合法主机名或 `'*'`（`'*'` 须附说明，管理页醒目展示）
7. `activation` 中 `onEvent:<channel>` 的 channel 必须以本插件 `ipcPrefix` 开头

---

## 四、生命周期（握手时序）

```
发现 ──▶ 校验 ──▶ 惰性加载 ──▶ 握手 ──▶ 运行 ──▶ 停用
         │            │
         └ 失败 → broken（不加载，管理页如实上报）
         失败重试：仅「加载/握手」失败，下次触发时重试
```

| 阶段 | 时机 | 说明 |
|---|---|---|
| 发现 | 启动（app ready 后，同步微秒级） | 扫描已安装包清单 + 启停覆盖；不加载任何插件代码 |
| 校验 | 发现后立即 | §三 七条规则 |
| 惰性加载 | **首次使用** | 动态 import 插件 main 入口 |
| 握手 | 加载成功后 | 调用 `activate(host)`，校验返回的 registration；记录激活耗时 |
| 运行 | 握手成功后 | IPC 路由、页面路由、命令注入、事件转发 |
| 停用 | 管理页禁用 / 应用退出 | 注销 IPC → 移除页面与命令 → `dispose()` → 释放引用；代码与状态保留 |

**禁用不销毁**：禁用仅回收实例与能力，数据保留，重新启用即恢复；卸载才是删除代码与状态。

### 激活触发（activation）

| 触发点 | 来源 | 说明 |
|---|---|---|
| onView | `pages` 声明自动推断 | 访问插件页面才激活 |
| onCommand | `commands` 声明自动推断 | 点击插件命令才激活 |
| IPC 首次到达 | `plugins.call(<id>, ...)` | 被调用时激活 |
| `onEvent:<channel>` | **显式声明** | 事件订阅类插件必须声明，否则永不激活 |
| `onStartupFinished` | **显式声明** | 启动完成后延迟激活，不进启动关键路径 |

### 熔断与可观测

1. loader 对插件所有入口（activate / ipc handler / commands / events 回调 / dispose）一律 try/catch
2. 连续失败 **3 次** → 自动置 broken，管理页展示失败原因与计数，可手动重置
3. 管理页展示每插件激活耗时、调用次数、失败计数
4. **已知代价（诚实说明）**：进程内方案下，插件 `activate` 内的同步死循环会卡死宿主进程，无法防御——选择内存克制的已知代价，靠信任分级与审查兜底（见 §六）

### API 演进政策

1. **只增不删**：同一 API 大版本内只新增；废弃字段标记 `@deprecated`，至少存活一个宿主大版本
2. `apiCompat` 不相交 → broken + 管理页明确提示「需升级宿主 / 需升级插件」
3. 官方索引维护「插件版本 → 所需宿主 API 版本」映射（versions.json），旧宿主自动选兼容旧版插件

---

## 五、双向 API

### 5.1 宿主 → 插件：PluginHost（activate 注入）

```ts
export interface PluginHost {
  apiVersion: number               // 当前恒为 1
  log(level: 'info' | 'warn' | 'error', msg: string): void

  /** 状态隔离存储：userData/plugins/<id>/state/，与本体存储完全隔离。全异步 */
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }

  /** 事件总线：订阅宿主事件（workspaceChanged / importComplete / certExpiring / updateAvailable...）
   *  或向渲染层广播。插件 emit 的 channel 必须以本插件 ipcPrefix 开头；
   *  宿主保留事件（无插件前缀）只能 on 不能 emit */
  events: {
    on(channel: string, cb: (data: unknown) => void): () => void
    emit(channel: string, data: unknown): void
  }

  /** 受限核心能力（白名单，不放开任意文件操作） */
  workspace: { currentPath(): string | null; list(): unknown }
  dialog: { openFile(opts: unknown): Promise<string>; openDirectory(opts: unknown): Promise<string> }
  notify(title: string, body: string): boolean

  /** 预留：账号登录态（AI 类插件复用 token 调远端服务），后续版本接通 */
  account?: { getToken(): string | null; isLoggedIn(): boolean }
}
```

### 5.2 插件 → 宿主：PluginRegistration（activate 返回）

```ts
export interface PluginRegistration {
  /** key = action，完整通道 = qihebox:plugin:<ipcPrefix>:<action> */
  ipc?: Record<string, (args: unknown) => Promise<unknown>>
  pages?: PluginManifest['pages']
  /** key = manifest.commands[].id */
  commands?: Record<string, (ctx: { filePaths: string[]; host: PluginHost }) => Promise<void> | void>
  /** 停用清理：定时器、事件订阅、长连接 */
  dispose?: () => void
}
```

### 5.3 渲染层 → 宿主：window.qihebox.plugins

```ts
window.qihebox.plugins = {
  list(): Promise<PluginInfo[]>                       // 含禁用/broken
  call(pluginId: string, action: string, payload?: unknown): Promise<unknown>
  setEnabled(pluginId: string, enabled: boolean): Promise<boolean>
  catalog(): Promise<PluginCatalogEntry[]>            // 官方索引目录（进入管理页时拉取，不后台轮询）
  install(source: { downloadUrl: string; sha256: string } | { filePath: string }): Promise<boolean>
  uninstall(pluginId: string): Promise<boolean>
  on(channel: string, cb: (data: unknown) => void): () => void
}
```

> preload 为薄壳纯透传，不 import 任何插件代码。

### 5.4 IPC 通道命名

| 通道 | 归属 |
|---|---|
| `qihebox:*` / `qihebox:event:*` | 本体（现有白名单，不变） |
| `qihebox:plugins:list / setEnabled / call / catalog / install / uninstall` | 宿主通用通道 |
| `qihebox:plugin:<ipcPrefix>:<action>` | 插件通道，前缀登记时校验全局唯一 |

---

## 六、安全与信任分级

**诚实说明**：v1 采用进程内（inproc）加载，插件代码经动态 import 进入宿主进程后，技术上拥有与宿主相同的能力（Node API 可达）。「插件只能经 host 访问系统」是**架构约定而非技术强制**（与 Obsidian 的公开立场一致）。因此分级：

| 信任级 | 对象 | 约束方式 |
|---|---|---|
| 可信 | 官方索引分发的 `.qbox` | 官方评审（与本体同级标准）；SHA-256 经官方索引公布比对 |
| 受限信任 | 手动侧载的 `.qbox` | 安装前权限确认对话框（permissions / 域名白名单）知情授权；对恶意插件**不设防** |

**协议地位平等**：宿主不存在仅官方插件可调用的隐藏 API——官方插件走的每一条通道都在本文档内。官方与第三方的差别全部在协议外（分发渠道与信任级），不在协议内。

宿主对两级均强制执行：

1. 插件只能通过 `host` 注入的能力访问系统；不提供任意路径读写、任意 shell 执行
2. 插件状态只能写在 `userData/plugins/<id>/state/`；storage.set 有路径与大小校验（单 key ≤ 1MB，总容量 ≤ 64MB）
3. 插件不得注册 `qihebox:*` 前缀通道；事件 channel 强制 `ipcPrefix` 前缀
4. `permissions` 字段先行：v1 用于展示与安装确认，未来 `transport='process'` 隔离落地时升级为强制拦截
5. 插件页面模块纳入 CSP 管辖
6. 一切安装均需 JSON Schema + SHA-256 校验；侧载另需权限确认对话框

---

## 七、状态隔离

| 数据 | 位置 | 归属 |
|---|---|---|
| 工作区配置/元数据 | 工作区 `.qihefilemanager/` | 本体（插件禁写） |
| 最近工作区/缩略图/索引 | `userData/` | 本体 |
| 插件启停覆盖 | `userData/plugins/config.json` | 宿主 |
| 插件代码包 | `userData/plugins/<id>/pkg/` | 宿主（安装器写入） |
| 插件业务状态 | `userData/plugins/<id>/state/` | 插件（storage 限界） |

---

## 八、资源与启动承诺

- 未安装/禁用插件：零内存、零代码加载
- 插件代码全部惰性加载，不进 `app ready → 窗口可交互` 关键路径
- 「停用即释放」的诚实口径：ESM 模块代码一经加载无法从 V8 卸载（VS Code / Obsidian 同样如此）；承诺是停用后**实例/订阅/定时器/IPC 通道全部回收**，模块代码常驻、重启后完全释放

---

## 九、开发与调试

- 公开仓库 `src/plugins/hello/` 是教学样板 + e2e 夹具：展示 manifest 写法、activate/registration、页面与命令注册、storage 使用
- 构建：参考 `scripts/build-hello-plugin.mjs`，把编译产物打包为 `.qbox`（zip）
- 安装：应用内「设置 → 插件 → 手动导入 .qbox」侧载（走权限确认对话框）
- 调试：主进程日志经 `host.log`；broken 原因、激活耗时、调用计数在管理页可见
- 问题与协议不符之处：到公开仓库提 issue

---

## 十、未来扩展（协议预留，未生效）

- `transport: 'process'`：不可信插件组共享一个 utilityProcess 的隔离方案（VS Code 扩展宿主同粒度）
- `transport: 'http'`：loopback 桥接，供外部应用经桥接插件对接
- 两条路径下 `activate` / `PluginRegistration` 语义不变，仅传输层变化

---

*协议版本：v1（API_VERSION = 1，随 v2.5 宿主生效） · 本文档在公开仓库维护，契约修订与实现同步*
