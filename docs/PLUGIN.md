# 启禾文件管理 插件协议（v1）

> 本文档是 启禾文件管理（qihe-box）插件协议的**公开契约**：插件作者据此开发 `.qbox` 插件，宿主行为以本文档与实现 `src/plugins/types.ts` 同源定义为准。
> **协议即承诺**：本文档写到的，宿主必须做到；宿主做到的，必须写进本文档。发现二者不符请提 issue。
> **v1 增量（2026-08-14，随 v2.5 宿主落地）**：`syncScope` 字段（规则⑧）、`permissions.account`（规则⑨）、`host.account` 接通、`host.files` 能力域（错误码）、`host.entitlement` 占位、侧载收紧（开发者模式 + 确认框文案）。
> 内部实施路线与策略不在本文档范围（本地保留）；本文档只写插件作者需要的一切。

---

## 〇、开源与插件边界（插件作者必读）

- **本体永远免费开源**：宿主（qihe-box 本体）本地文件管理核心永久免费，Apache 2.0，不随插件变化。
- **插件独立于本体**：插件（`.qbox` 包）由插件作者/发行方自行发布与维护，宿主不介入**第三方**插件的发布与分发（官方插件可由发行方预装随安装包分发，见 §六「官方预装」）。
- **权益标记**：官方插件可在 manifest 声明 `entitlement` 取钥门槛（字段语义见 §三）。**宿主零门槛校验**——不判定权益、不查订阅状态（`host.entitlement` 是恒 `free` 占位，见 §五）；真正的闸在启禾云取钥面：`POST /api/box/plugin-key` 按登记门槛裁决是否发钥（见 §六）。取钥失败时宿主不吞原因——按云端 `code` 如实报出问题与用户下一步（v2.6 起）。
- **数据边界不变**：插件不改变「文件本体本地存储、不经宿主上传」的承诺；插件自身的网络权限按 §三 `permissions` 声明式披露，安装确认时明示。

---

## 一、总览

- 插件 = 独立分发的 `.qbox` 包（zip），经应用内插件管理页安装/启停/卸载，**与本体发版完全解耦**；宿主另支持**官方预装（离线可用）**——发行方可把官方 `.qbox` 放进安装包随包分发，应用首启自动安装（落位与语义同手动安装，同样可停用／卸载／更新，见 §六「官方预装」）。
- 宿主三段：主进程宿主（发现/校验/加载/握手/IPC 路由）、preload 透传命名空间、渲染层宿主（页面路由/Sidebar/右键菜单注入）。
- 设计三要素：**本体纯净**（插件代码与状态不进本体目录与本体能手写的存储）、**内存克制**（未启用零内存、按需加载）、**启动快速**（插件不进 `app ready → 窗口可交互` 关键路径）。

**协议分层图**（v2.5.4 弹一 C-5d，七层一句话职责；自下而上——各层职责单一，不构成重复实现）：

| 层 | 一句话职责 |
|---|---|
| 清单 | `manifest.json` 声明身份/权限/激活/页面（校验 + 侧载收紧） |
| 主进程能力域 | `PluginHost.customer/supplier/quote/share/files/...`——本体业务的白名单结构化出口（读域 + 写桥 + 事件） |
| 渲染层桥 | `window.qihebox.ui.*`——页面/弹窗级的纯 UI 钩子（预填开表单，不过 IPC、永不自动建档） |
| 宿主事件 | `host.events`——业务变化（`customerCreated`/`supplierCreated`/`fileArchived`/`importComplete`...）订阅总线 |
| 插件事件桥 | 插件 → 渲染层广播（`qihebox:event:<channel>`）与插件 IPC 前缀通道 |
| 插件 IPC | `qihebox:plugin:<ipcPrefix>:<action>`——插件自身的服务接口（callee 白名单 + 前缀唯一） |
| ui 预填 | §5.7 表单注册表（`openCreatePrefill`/`openEditPrefill`）——AI/插件产出载荷 → 弹窗预填 → 用户确认建档 |

### 术语

| 术语 | 含义 |
|---|---|
| 宿主（Host） | 应用本体 |
| 握手 | 宿主调用插件入口 `activate(host)`，插件返回能力注册表（PluginRegistration） |
| 能力 | 插件声明的扩展点：`ipc`（服务 API）、`pages`（页面）、`commands`（右键菜单命令 / 表单上下文槽命令） |
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

- **安装**：管理页从官方索引勾选下载（`catalog()` → `install({ downloadUrl, sha256 })`，需登录态，见 §5.3），或手动导入本地 `.qbox`（侧载）→ JSON Schema + SHA-256 校验 → 解压到 `userData/plugins/<id>/pkg/` → 登记。
- **状态**：插件业务状态存 `userData/plugins/<id>/state/`（经 `host.storage` 访问）；启停覆盖存 `userData/plugins/config.json`。代码与状态分离。
- **覆盖安装（v2.6 起）**：同 id 已安装时再次侧载同一插件 = **覆盖安装**——仅替换 `pkg/`，**保留 `state/`**（消息历史/配对/身份等数据不丢）；旧实例自动停用并重新激活；覆盖失败回滚旧包。需要"全新安装"（清空数据）须先卸载。**更新生效口径（2026-09-22 实测）**：已加载的插件模块/页面在进程内不热替换（见 §八「更新即重启」）——覆盖安装的新版本**重启应用后**完全生效。
- **卸载**：删除 `pkg/` 与 `state/`；「禁用」两者都保留。
- **渲染层加载**：插件 renderer 产物经 `qihebox://plugin/<id>/...` 协议 URL 动态 `import()`（访问才加载），响应携带 CSP 头（见 §六 规则 5）；**插件包自包含依赖**（solid-js 等打入自身产物），宿主不提供共享运行时。
- **样式复用（v2.5.1 起）**：插件页面运行在同一渲染上下文，可引用本体编译进全局 CSS 的组件类（如 `btn-primary`、`.md-prose` Markdown 渲染样式类，以文档列名为准）；Tailwind purge 以产物实含为验收，插件不应假定未列名类的存在。
- **官方插件加密（v2.5.7 起，F5）**：官方加密插件在 manifest 声明 `encryption` 块（见 §三），包内 `main/index.js` 与 `renderer/**.js` 以密文 `.enc` 存在（**无明文 JS**），布局 = `QHENC1` 魔数 + AES-256-GCM（iv 12B + tag 16B + body），算法 `aes-256-gcm`。宿主激活/页面加载时**在线取钥 + 内存解密**（`Module._compile` / 协议 Response），明文不落盘。密钥与权益（`login` / `subscription` 两档门槛）由启禾云 `/api/box/plugin-key` 分发，取钥携带密文 sha256 在服务端比对（防调包）。第三方插件**不得**声明 `encryption` 块（明文开放平台口径）。

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
  syncScope?: 'global' | 'local'   // 状态同步范围：'global' = state/ 期望跨设备可用；'local' = 仅本机；缺省 'local'
                                   // （v2.5 增量；与 commands[].scope 完全无关）
  kind: Array<'ipc' | 'pages' | 'commands'>   // 至少声明其一
  ipcPrefix: string                // IPC 通道前缀 → qihebox:plugin:<prefix>:<action>，全局唯一
  permissions?: {                  // 声明式权限（v1 用于安装确认与管理页展示）
    network?: string[]             // 域名白名单；'*' 必须附 reasoning
    clipboard?: boolean
    notification?: boolean
    account?: boolean              // 账号能力（v2.5 增量）：声明后 host.account 返回真实登录态；未声明恒 null
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
    label: PluginText              // 按钮/菜单文案
    scope: 'file' | 'global'       // 'file'=右键菜单注入；'global'=表单上下文槽（v2.5.4，当前：新建发票弹窗 create 模式首行，随 registry 启停增减）
    when?: { exts?: string[] }     // 可见性过滤，防右键菜单污染
    openPage?: string              // 「打开本插件页面」命令（v2.5.9 增量）：声明后宿主不执行回调，
                                   // 改为把右键 filePaths 写 sessionStorage 交接键并 navigate 到该页；
                                   // 必须为本插件 pages[].path 之一（登记期校验，防越权跳转）
  }>
  description?: PluginText
  author?: string
  license?: string
  keywords?: string[]
  icon?: string                    // 插件自身图标（管理页展示）
  homepage?: string
  /** 官方插件加密块（v2.5.7 起，F5）：存在 → main/renderer JS 以 .enc 密文分发，
   *  宿主在线取钥 + 内存解密加载；第三方插件不得声明（明文开放平台口径） */
  encryption?: {
    algo: 'aes-256-gcm'          // 加密算法（当前唯一）
    keyId: string                // 平台侧插件密钥表 登记的密钥版本号（构建期随机，每版本一钥）
    entitlement: 'login' | 'subscription' // 取钥权益门槛（login = 登录态 / subscription = 权益生效态）
  }
}
```

**校验规则**（宿主登记阶段执行，任一失败 → broken）：

1. `id` 全局唯一；`ipcPrefix` 全局唯一；`pages[].path` 不与本体路由及已注册插件路由冲突 <!-- contract:v1:manifest.rule1 -->
2. `kind` 声明与实际的 pages/commands 一致（互相有字段） <!-- contract:v1:manifest.rule2 -->
3. `apiCompat` 与宿主 `API_VERSION` 相交（`min ≤ 1 ≤ max`）；声明 `minHostVersion` 时宿主产品版本须 ≥ 该值 <!-- contract:v1:manifest.rule3 -->
4. `pages[].path` 必须以 `/plugin/` 开头；`pages[].component` 必须为包内相对路径（拒绝绝对路径与 `..` 逃逸） <!-- contract:v1:manifest.rule4 -->
5. `transport` 缺省或 `'inproc'`；其余值 → broken（v1 仅进程内） <!-- contract:v1:manifest.rule5 -->
6. `permissions.network` 域名须为合法主机名或 `'*'`（`'*'` 须附说明，管理页醒目展示） <!-- contract:v1:manifest.rule6 -->
7. `activation` 中 `onEvent:<channel>` 的 channel 必须以本插件 `ipcPrefix` 开头 <!-- contract:v1:manifest.rule7 -->
8. `syncScope` 仅支持缺省（默认 `'local'`）、`'global'` 或 `'local'`；其余值 → broken（v2.5 增量） <!-- contract:v1:manifest.rule8 -->
9. `permissions` 子字段类型校验：`account` / `clipboard` / `notification` 布尔、`network` 字符串数组或 `'*'`；非法 → broken（v2.5 增量） <!-- contract:v1:manifest.rule9 -->
10. `commands[].openPage`（可选）三边校验：非空字符串 / `'/plugin/'` 前缀 / 必须命中本插件 `pages[].path`；非法 → broken（v2.5.9 增量） <!-- contract:v1:manifest.rule10 -->

---

## 四、生命周期（握手时序）

```
发现 ──▶ 校验 ──▶ 惰性加载 ──▶ 握手 ──▶ 运行 ──▶ 停用
         │            │
         └ 失败 → broken（不加载，管理页如实上报）
         失败重试：仅「加载/握手」失败，下次触发时重试
```

<!-- contract:v1:retry.policy -->

| 阶段 | 时机 | 说明 |
|---|---|---|
| 发现 | 启动（app ready 后，同步微秒级） | 扫描已安装包清单 + 启停覆盖；不加载任何插件代码 |
| 校验 | 发现后立即 | §三 十条规则 |
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

**`openPage` 运行语义（v2.5.9 增量）**：`scope='file'` 命令声明 `openPage` 后，宿主在文件右键菜单注入该项的形态不变，但点击行为改为两步：① 把本次右键的 `filePaths` 写入 `sessionStorage['qihebox:plugin-handoff']`（JSON：`{ pluginId, paths, at }`）；② `navigate(openPage + '?from=menu&t=<时间戳>')`，并 `window.dispatchEvent(new CustomEvent('qihebox:plugin-handoff'))`（solid-router 的 navigate 走 pushState 不发 DOM 事件，页面已打开时不重挂 → 显式广播）。插件页面挂载时及收到该事件时读取交接键并**立即清除**（take 语义；`pluginId` 不符或形状非法的条目忽略不清）。未声明 `openPage` 的命令维持 `callPlugin(pluginId, commandId, { filePaths })` 原行为。
| IPC 首次到达 | `plugins.call(<id>, ...)` | 被调用时激活 |
| `onEvent:<channel>` | **显式声明** | 事件订阅类插件必须声明，否则永不激活 |
| `onStartupFinished` | **显式声明** | 启动完成后延迟激活，不进启动关键路径 |

### 熔断与可观测

1. loader 对插件所有入口（activate / ipc handler / commands / events 回调 / dispose）一律 try/catch
2. 连续失败 **3 次** → 自动置 broken，管理页展示失败原因与计数，可手动重置
3. 管理页展示每插件激活耗时、调用次数、失败计数
4. **已知代价（诚实说明）**：进程内方案下，插件 `activate` 内的同步死循环会卡死宿主进程，无法防御——选择内存克制的已知代价，靠信任分级与审查兜底（见 §六）

<!-- contract:v1:fuse.policy -->

### API 演进政策

1. **只增不删**：同一 API 大版本内只新增；废弃字段标记 `@deprecated`，至少存活一个宿主大版本
2. `apiCompat` 不相交 → broken + 管理页明确提示「需升级宿主 / 需升级插件」
3. 官方索引维护「插件版本 → 所需宿主 API 版本」映射（versions.json），旧宿主自动选兼容旧版插件
4. **宿主的选版口径（v2.6 实装）**：`catalog()` 对每个插件在全部兼容版本里取**语义化版本最高**者呈现与安装
   （不取列表末位——服务端顺序不该改变宿主行为）；无兼容版本 → 管理页标「不兼容」并置灰，**不提供下载**（§5.3）

<!-- contract:v1:api-version -->
<!-- contract:v1:api-evolution -->

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

  /** 事件总线：订阅宿主事件（workspaceChanged / importComplete / certExpiring / updateAvailable /
   *  accountChanged 等，完整清单与投递语义见本节下方说明）
   *  或向渲染层广播。插件 emit 的 channel 必须以本插件 ipcPrefix 开头；
   *  宿主保留事件（无插件前缀）只能 on 不能 emit */
  events: {
    on(channel: string, cb: (data: unknown) => void): () => void
    emit(channel: string, data: unknown): void
  }

  /** 受限核心能力（白名单，不放开任意文件操作） */
  workspace: {
    currentPath(): string | null
    list(): unknown
    /** v2.6.1 增量：用户指定的**默认工作区**（「以后启动都打开这个盘」那个指针）。
     *  未设置 → null；已设置的路径**可能暂时失效**（目录被删 / 移动盘未挂载）——此时原样返回该路径，
     *  拿到非 null **不代表当前可用**（存在性判断本身有竞态，宿主不做，交由消费方自行校验）。
     *  读的是**持久偏好**而非「当前打开哪个」（两者可以不同：用户临时切到别的工作区时默认指针不变），
     *  因此不受启动时序影响，`activate` 期即可拿到「本次启动将要打开哪个盘」。只读——设默认与切工作区
     *  是用户动作，不开给插件。
     *  **可选成员**：旧宿主（2.5.x / 2.6.0）无此方法，请能力探测 `host.workspace.defaultPath?.() ?? null`。
     *  **已发布：v2.6.1（2026-09-26）**，宿主能力探测为准（旧宿主 2.5.x / 2.6.0 无此方法）。 */
    defaultPath?(): string | null
  }
  /** 受限对话框（仅选择，不放开任意路径）。三个方法共用一套语义：**返回裸值不是信封**
   *  （与渲染桥 `qihebox.*` 的 ApiResult 不同）；**取消与失败可分辨**——取消回空值（多选 `[]` /
   *  单选 `''`），失败抛带 `code` 的业务错误（`DIALOG_FAILED`），不得两者都回空。
   *  下面那个 `host.dialog.openFiles` 的 v2.6.1 增补说明是契约的一部分，别跳。 */
  dialog: { openFile(opts: unknown): Promise<string>; openFiles?(opts: unknown): Promise<string[]>; openDirectory(opts: unknown): Promise<string> }
  // openFiles（v2.6.1 增量，可选成员）：多选文件，properties = ['openFile','multiSelections']。
  //   - 单批上限 200：超出部分宿主截断不取入（宿主日志如实记录）；插件收到恰好 200 条时须如实提示
  //     「已达宿主上限 200，超出部分未取入」，不得静默。
  //   - opts = { title?: string; filters?: [{ name, extensions }] }（与 openFile 同口径，其余忽略）。
  //   - 旧宿主（≤2.6.0）无此方法 ⇒ 请能力探测（`typeof host.dialog.openFiles === 'function'`），
  //     缺席时自行降级**并如实说明**（不得静默——「选了文件没反应」是这条通道存在的理由）。
  /** 图像处理（v2.6.1 增量，**可选成员**）：宿主内置图像引擎（sharp/libvips），插件不再自带图像运行时。
   *  只做「读源 → 内存变换 → 返回编码字节」：**宿主不写盘**——输出文件由插件自己落（命名与存在性
   *  检查本来就是插件的事）。顺序（三个都给时）：crop → rotate → resize。语义、缺省档与错误码见下方
   *  host.images 段。 */
  images?: {
    transform(req: {
      source: string          // 源图绝对路径（按内容判，只认 jpeg/png/webp）
      format?: 'jpeg' | 'png' | 'webp'   // 输出格式；缺省随源：.png→png / .webp→webp / 其余→jpeg；扩展名不认识时看真实格式，仍不认识按 jpeg
      quality?: number        // 1..100（png 忽略）；缺省 85
      maxWidth?: number       // contain：等比内缩、绝不放大（默认档）
      maxHeight?: number
      scale?: number          // 倍率，优先于 maxWidth/maxHeight
      stretch?: boolean       // true 且同时给了 maxWidth+maxHeight = 精确宽高（不保比例）
      rotate?: 0 | 90 | 180 | 270        // 90/270 交换宽高
      crop?: { x: number; y: number; w: number; h: number }   // 像素矩形（相对源图）；越界按图幅取整求交；无交集 → IMAGES_CROP_OUT_OF_RANGE
      cropRatio?: number      // 带比例时取交集内最大等比框（锚点 = 交集左上角）
      flatten?: string        // 非 alpha 输出格式（jpeg）的透明底合成色，缺省 '#ffffff'（与既有白底口径一致）
      keepMetadata?: boolean  // 缺省 false = 剥 EXIF/ICC 等（与旧 canvas 路径同效）
    }): Promise<{ data: Uint8Array; width: number; height: number; bytes: number; format: 'jpeg' | 'png' | 'webp' }>
  }
  notify(title: string, body: string): boolean

  /** 账号登录态（v2.5 增量接通）：同步签名；未登录 → null；permissions.account !== true 时恒 null。
   *  v2.5.7（F4a）：cloudFetch 宿主代签中继——相对路径（/ 开头）强制 + 前缀白名单
   *  （/api/box/*、/api/ai/*）；未登录 → NOT_LOGGED_IN；未配置服务器 → NO_SERVER；
   *  代签头由宿主注入（Authorization: Bearer <token>、X-Qihe-Client: box），
   *  同名用户头被宿主覆盖；body 非字符串时 JSON 序列化。返回原生 Response。 */
  account: {
    /** @deprecated v2.5.7（F4a）：请用 cloudFetch 中继；getToken 存活一个宿主大版本后移除（§四.1） */
    getToken(): string | null
    isLoggedIn(): boolean
    /** v2.6 增量（批 1）：本机设备标识（与心跳 `device_id` 同源）；不可读 → null。
     *  向 erp `/api/box/me` 附 `current_device_id` 即得设备清单里的「本机」标记（`is_current`）；
     *  非凭据、不得自造；**可选成员**——旧宿主（2.5.x）无此方法，请能力探测（缺席按「本机未知」降级）。 */
    getDeviceId?(): string | null
    cloudFetch(path: string, init?: {
      method?: string
      headers?: Record<string, string>
      body?: string | Record<string, unknown> | unknown[]
      signal?: AbortSignal
    }): Promise<Response>
  }

  /** 工作区文件能力域（v2.5 增量）：受限读写；错误为带 code 的业务错误（不触发熔断计数）。
   *  错误码：NOT_FOUND / OUT_OF_WORKSPACE / NO_WORKSPACE / TOO_LARGE / INVALID_NAME / IO_ERROR */
  files: {
    readText(relPath: string): Promise<string>      // 工作区内 UTF-8 文本，≤ 10MB
    readBuffer(relPath: string): Promise<Uint8Array> // 工作区内二进制，≤ 50MB
    writeExport(fileName: string, data: string | Uint8Array): Promise<void>
    // 写导出物：平铺写入 工作区/导出/<pluginId>_<fileName>（应用导出区自动展示），≤ 50MB
  }

  /** 权益占位（v2.5 增量）：恒 { tier: 'free', expiresAt: null, quota: null }；插件须判空按 free 处理 */
  entitlement: { status(): { tier: 'free' | 'subscribed'; expiresAt: string | null; quota: { [k: string]: { used: number; limit: number } } | null } }
}
```

<!-- contract:v1:host.api-version -->
<!-- contract:v1:host.log -->
<!-- contract:v1:host.storage -->
<!-- contract:v1:host.events -->
<!-- contract:v1:host.workspace -->
<!-- contract:v1:host.dialog -->
<!-- contract:v1:host.images -->
<!-- contract:v1:host.notify -->
<!-- contract:v1:host.account -->
<!-- contract:v1:host.files -->
<!-- contract:v1:host.entitlement -->

> **host.dialog 语义（v2.6.1 起明写，三条都是契约）**：① **取消与失败必须可分辨**——取消回空值（`openFiles` → `[]`；`openFile` / `openDirectory` → `''`），失败抛带 `code` 的业务错误（`DIALOG_FAILED`），**不得两者都回空**；② **返回的是裸值不是信封**——`host.*` 主进程面的既有约定是返回值语义、异常经 `code` 区分，与渲染桥 `qihebox.*` 的 `ApiResult` 语义不同，别按信封拆（按信封读裸值 = 把用户选好的一批当取消静默丢弃）；③ **只增不改**——`openFile` / `openDirectory` 的形状与取消语义一字不动。`openFiles` 单批上限 200（宿主侧截断，超出部分未取入），可选成员 + 能力探测见上。
> **host.images 语义（v2.6.1 起，本段是契约）**：① **只做内存变换、宿主不写盘**——`transform` 只返回 `{ data, width, height, bytes, format }`，**输出文件由插件自己落**（命名与存在性检查本来就是插件的事）；源只按传入的 `source` 绝对路径读，不碰工作区白名单外的任何写面。② **顺序**：`crop → rotate → resize`（三个都给时按此序；`crop` 矩形相对**源图**，越界部分按图幅取整求交，与图幅无交集 → `IMAGES_CROP_OUT_OF_RANGE`；90/270 旋转交换宽高，resize 的 contain/scale 按旋转后的有效宽高算）。③ **默认档**：`quality` 缺省 85（png 忽略）；`maxWidth/maxHeight` 缺省档 = contain **等比内缩、绝不放大**（`scale` 给定时优先于两者；`stretch: true` 且两边都给 = 精确宽高不保比例）；`flatten` 仅对非 alpha 输出格式（jpeg）生效、缺省 `'#ffffff'`（透明底铺白）；`keepMetadata` 缺省 false = 剥 EXIF/ICC。④ **格式与像素闸**：源按**内容**判、只认 jpeg/png/webp（输出格式缺省随源，扩展名不认识时看真实格式）；`w*h > 1e8` 像素在解码前拒（`IMAGES_TOO_LARGE`，文案报实际宽高与上限）。⑤ **错误码表（均带 `code`、不计熔断、中文人话）**：`IMAGES_BAD_REQUEST`（参数非法）/ `IMAGES_UNSUPPORTED_FORMAT`（输出格式值非法，或源内容不是三格式）/ `IMAGES_READ_FAILED`（源读不到：宿主 `readFile` 阶段失败）/ `IMAGES_DECODE_FAILED`（sharp 侧失败：坏图/非图/变换与编码失败）/ `IMAGES_CROP_OUT_OF_RANGE` / `IMAGES_TOO_LARGE` / `IMAGES_ENGINE_UNAVAILABLE`（引擎加载失败；该实例此后**每次调用**都以此码失败）。**引擎原文只进宿主日志、绝不进用户面**（sharp 失败是外层无 `code` 的聚合 Error、文案随 locale 变甚至乱码）。⑥ **可选成员 + 能力探测**：旧宿主（≤2.6.0）无此成员 ⇒ `typeof host.images?.transform === 'function'`，缺席时插件自行降级并如实说明（不得静默）；引擎不可用（旧/坏安装）时调用会以 `IMAGES_ENGINE_UNAVAILABLE` 失败，插件同样要给出中文出路而不是白屏。
> **`getPathForFile`（稳定 util 契约，v2.6.1 起上台面，实现零变更）**：`window.qihebox.getPathForFile(file: File): string`——把一个渲染层的 `File`（拖放/粘贴来的）换成**本机绝对路径**（宿主 preload 里是 Electron `webUtils.getPathForFile` 的直通，同步返回）。插件渲染层取拖入文件的真实路径**唯一推荐**用它（cloud / tools 两处官方插件已在用）；**不要读 `File.path`**——那是 Electron 32 已移除的旧属性，宿主现锁 ^31 只是暂时还能用。它属渲染层桥（`qihebox.*` 命名空间）但不是 IPC，**没有 ApiResult 包装、也不是 Promise**；非本地文件等异常情形的结果随 Electron 该 API 本身，调用方按需自行兜底。

> **host.account.cloudFetch 错误码（v2.5.7 F4a）**：`PERMISSION_DENIED`（未声明 `permissions.account`）/ `NOT_LOGGED_IN`（未登录）/ `NO_SERVER`（未配置服务器地址）/ `INVALID_NAME`（路径非 `/` 开头相对路径）/ `NOT_ALLOWED`（非 `/api/box/*` 或 `/api/ai/*` 前缀）。以上均带 `code` 属性、不计入熔断计数。响应体处理与超时策略由插件侧负责（宿主只负责代签与转发，不解析业务载荷）。

> **host.events 投递语义（v2.5.1 起明示）**：宿主事件只投递给**已激活**插件的订阅——事件到达时未激活的插件收不到该次事件。需在某宿主事件到达时必在场的插件：`manifest.activation` 声明 `onEvent:<ipcPrefix>:<channel>`（规则⑦），并在 `activate` 内自检一次当前状态（激活与投递存在时序竞态，触发激活的那次事件可能先于订阅注册到达，不可依赖收到它）。
> **宿主事件清单**：`workspaceChanged`（工作区切换，payload 为新路径）/ `importComplete`（导入完成）/ `certExpiring`（证书到期）/ `updateAvailable`（发现新版本）/ `accountChanged`（**v2.5.1**：登录/登出成功，payload `{ loggedIn: boolean }`）/ `customerCreated` / `customerUpdated` / `fileArchived`（customers/share 域事件，见 §5.5）/ `supplierCreated` / `supplierUpdated`（suppliers 域事件，v2.5.4 弹一 C-3）。
> **写路径投递口径（v2.5.7 补丁明示，两域对称）**：客户与供应商的 `create` / `update` / `rename` / `linkRelation`（关联产品集）/ `unlinkRelation` 在**成功路径**均投 `<entity>Created` / `<entity>Updated`（payload `{ name, oldName? }`）；`delete` 与失败/取消路径**不投**。注：供应商两条关联通道在 v2.4.9 打磨 M8「镜像客户」时漏抄了投递，导致依赖关联变化刷新的插件（业务脉络图谱）拿不到信号、只能等重启——v2.5.7 补丁补齐，并加 `tests/unit/ipc-entity-events.test.ts` 钉住两域对称（客户侧作对照基准）。插件侧不要假设"任何数据变化都有事件"：报价/发票/入库/产品集 四域当前**无事件通道**，兜底口径 = 进页重拉 + 自定 TTL（见插件侧 PLAN 契约 11）。
> 依赖登录态的插件应声明 `onEvent:<ipcPrefix>:accountChanged`，并在 activate 自检 `host.account.isLoggedIn()`（activate 期已登录可直接启用相关服务，不必等事件）。

> **host.files 边界说明**：`readText` / `readBuffer` 的 `relPath` 相对当前工作区，realpath 解析防符号链接逃逸，超出工作区 → `OUT_OF_WORKSPACE`，无工作区 → `NO_WORKSPACE`，不存在 → `NOT_FOUND`，超限 → `TOO_LARGE`；`writeExport` 文件名经宿主安全校验（非法 → `INVALID_NAME`）。带 `code` 属性的业务错误**不计入熔断**（熔断只统计加载/握手/未定义方法类失败），可放心用错误码做业务分支。产品约定：插件应只读取用户操作涉及的文件；inproc 无法技术强制，靠权限声明与侧载知情授权兜底。渲染层大数据读取建议走 `qihebox://file` URL 而非插件 IPC（structured clone 放大）。

<!-- contract:v1:error.code -->
<!-- contract:v1:host.files.boundary -->

### 5.2 插件 → 宿主：PluginRegistration（activate 返回）

```ts
export interface PluginRegistration {
  /** key = action，完整通道 = qihebox:plugin:<ipcPrefix>:<action> */
  ipc?: Record<string, (args: unknown) => Promise<unknown>>
  pages?: PluginManifest['pages']
  /** key = manifest.commands[].id；命令点击时宿主以 `callPlugin(pluginId, commandId, …)` 发往
      同名 IPC action（qihebox:plugin:<ipcPrefix>:<commandId>）：数据回传请在 ipc 表注册同名
      handler（返回任意 Promise<unknown>，如预填字段集合）；本回调仍须声明（manifest 一致性校验），
      可不承载业务逻辑。 */
  commands?: Record<string, (ctx: { filePaths: string[]; host: PluginHost }) => Promise<void> | void>
  /** 停用清理：定时器、事件订阅、长连接 */
  dispose?: () => void
}
```

**IPC 返回值约定（v2.5.4 起）**：handler 返回值若已是 `{ success: boolean, error?, data? }` 形状（ApiResult），宿主**透传不重复包装**（调用侧得到单层信封）；其余任意 payload 由宿主统一装 `{success:true, data:<payload>}`。需要「业务失败不熔断」的插件：请在 handler 内自行捕获预期失败并返回 `{success:false, error:{code,message}}`，**不要 throw**（throw 计入宿主熔断计数，见 §2.3.2）。

<!-- contract:v1:registration.ipc -->
<!-- contract:v1:registration.api-result-passthrough -->
<!-- contract:v1:registration.pages -->
<!-- contract:v1:registration.commands -->
<!-- contract:v1:registration.dispose -->

### 5.3 渲染层 → 宿主：window.qihebox.plugins

```ts
window.qihebox.plugins = {
  list(): Promise<ApiResult<PluginInfo[]>>            // 含禁用/broken
  call(pluginId: string, action: string, payload?: unknown): Promise<ApiResult<unknown>>
  setEnabled(pluginId: string, enabled: boolean): Promise<ApiResult<boolean>>
  catalog(): Promise<ApiResult<PluginCatalogEntry[]>> // 官方索引目录（v2.6 实装；进入管理页时拉取，不后台轮询）
  // PluginInstallSource = { filePath: string } | { downloadUrl: string; sha256: string }
  install(source: PluginInstallSource): Promise<ApiResult<PluginInfo>>
  // v2.6 起双形态：
  //  { filePath } 侧载——需开发者模式开启，关闭时拒绝（DEV_MODE_REQUIRED）
  //  { downloadUrl, sha256 } 官方索引——需登录态；下载后逐字节校验 SHA-256，不符拒绝安装（不落盘半包）
  uninstall(pluginId: string): Promise<ApiResult<boolean>>
  on(channel: string, cb: (data: unknown) => void): () => void  // 订阅函数，返回退订函数（非 Promise）
}

/** 开发者模式（v2.5 增量）：侧载安装入口门控，默认关，重启保持 */
window.qihebox.settings = {
  getDevMode(): Promise<ApiResult<boolean>>
  setDevMode(enabled: boolean): Promise<ApiResult<boolean>>
}

/** 应用内重启（v2.6 增量）：插件**覆盖安装（更新）后**新版本需重启应用才完全生效（见 §八「更新即重启」）；
 *  通道内部落点 qihebox:app:relaunch（app.relaunch() + app.quit()，走正常退出路径） */
window.qihebox.app = {
  relaunch(): Promise<ApiResult<boolean>>
}

/** ApiResult<T> = { success: boolean; data: T | null; error: string | null }（对齐 src/shared/types.ts 实际定义） */
```

`catalog()` 的条目形状（宿主按自身 `API_VERSION` 与产品版本判定兼容性后输出）：

```ts
export interface PluginCatalogEntry {
  id: string            // 插件 id（域名倒序，与 manifest.id 一致）
  name: string          // 展示名
  description?: string
  author?: string
  icon?: string         // 图标 URL（https；插件尚未下载，包内路径不可用）
  images?: string[]     // 截图 URL（https；v2.6.2 增量，宿主读侧最多收 3 张、坏项逐条丢，全坏则整字段缺省）。**宿主读侧已随 v2.6.1 发布（2026-09-26）**；服务端目录面属 2.6.2、未上线——条目里有没有这些字段以官方目录实发为准，插件按能力探测兜底
  detail?: string       // 功能详情长文（纯文本可含换行；v2.6.2 增量。长度上限在服务端写入侧把关，宿主不截断）。**宿主读侧已随 v2.6.1 发布（2026-09-26）**；服务端目录面属 2.6.2、未上线——条目里有没有这些字段以官方目录实发为准，插件按能力探测兜底
  source?: string       // 来源描述（缺省「启禾官方」）
  permissions?: { network?: string[]; clipboard?: boolean; notification?: boolean; account?: boolean; customers?: boolean; share?: boolean }  // permissions 摘要（仅展示）
  versions: PluginCatalogVersion[]              // 版本列表（服务端全量，宿主不裁剪）
  compatible: boolean   // 宿主派生：存在与当前宿主兼容的版本
  selected?: PluginCatalogVersion               // 宿主派生：选中可安装版本（最新兼容版本）
  reason?: string       // 宿主派生：不兼容原因（置灰时展示）
}

export interface PluginCatalogVersion {
  version: string                    // 语义化版本
  apiCompat?: [number, number]       // 所需宿主 API 版本范围（缺省 [1,1]，与 manifest.apiCompat 同口径）
  minHostVersion?: string            // 宿主产品版本下限（如 '2.6.0'；缺省不限）
  size?: number                      // 包体字节数（管理页展示体积）
  releaseNotes?: string              // 本版更新说明（v2.6.2 增量；空串/纯空白按缺省处理，界面如实说"官方没写"而不是藏掉）。**宿主读侧已随 v2.6.1 发布（2026-09-26）**；服务端目录面属 2.6.2、未上线——条目里有没有这些字段以官方目录实发为准，插件按能力探测兜底
  sha256: string                     // .qbox 包整体 SHA-256（64 位十六进制）
  downloadUrl: string                // 包体地址（绝对 https；同源 http 仅用于自建/内网部署）
}
```

**展示字段的宽容边界（v2.6.2）**：`images` / `detail` / `releaseNotes` 属**展示位**——形状不对、类型不对、
内容全坏，一律降级为该字段缺省，**不抛错**（一条截图地址写错不该让整个插件目录变成「目录不可用」）。
`sha256` / `downloadUrl` / `version` 等**承重字段**照旧严格：任一条坏即整体抛 `CATALOG_BAD_PAYLOAD`。
两头的分界各有一条单测钉着，防止"宽容"哪天蔓延到承重字段上。

**目录链的失败口径（不谎报空目录）**：`catalog()` 的错误串形如 `CODE：人话`，管理页按 CODE 决定出路，
**只有 200 + 空列表才显示「目录暂无插件」**；未登录 / 未配置服务器 / 端点未部署一律如实报错：

| CODE | 触发 | 管理页出路 |
|---|---|---|
| `NOT_LOGGED_IN` | 未登录，或服务端 401/403 | 「去登录」 |
| `NO_SERVER` | 宿主未配置云服务地址 | 提示改配置（重试） |
| `NOT_DEPLOYED` | 端点 404（服务端未部署该功能） | 「重试」（稍后再来） |
| `CATALOG_UNAVAILABLE` | 其余非 2xx / 网络不可达 | 「重试」 |
| `CATALOG_BAD_PAYLOAD` | 回包形状非法（含 `code != 200`） | 「重试」 |

下载链同理：`DOWNLOAD_NOT_LOGGED_IN`（未登录，**不发起下载**）/ `DOWNLOAD_URL_UNTRUSTED`（地址不在 https 与同源 http 之内）/
`DOWNLOAD_BAD_SHA256`（校验值形状非法）/ `DOWNLOAD_FAILED`（HTTP 错误 / 无包体 / 写入中断）/
`DOWNLOAD_HASH_MISMATCH`（下载完成但 SHA-256 与索引不符 → 已删包体、未进安装管线）。

<!-- contract:v1:window.plugins -->
<!-- contract:v1:window.settings -->
<!-- contract:v2.6:window.plugins.catalog -->

> preload 为薄壳纯透传，不 import 任何插件代码。

### 5.4 IPC 通道命名

| 通道 | 归属 |
|---|---|
| `qihebox:*` / `qihebox:event:*` | 本体（现有白名单，不变） |
| `qihebox:plugins:list / setEnabled / call / catalog / install / uninstall` | 宿主通用通道 |
| `qihebox:plugin:<ipcPrefix>:<action>` | 插件通道，前缀登记时校验全局唯一 |
| `qihebox:settings:getDevMode / setDevMode` | 宿主（v2.5 增量：开发者模式） |

<!-- contract:v1:ipc.channels -->

### 5.5 customers 能力域与 `erp_ext` 契约（v2.4.9 定稿，**v2.5.1 实装**）

**customers 能力域**（插件协议 `PluginHost` 白名单，供桥接插件使用；白名单收窄，不给通用文件读写）：

| 能力 | 方向 | 说明 |
|---|---|---|
| `customer.list` / `customer.get` | ERP 读 | 客户档案全量/增量 |
| `customer.writeErpExt` | ERP 写 | 仅写 `erp_ext` 命名空间 |
| `customer.syncProfile` | ERP 写 | 双向同步：写本体对齐字段（type/contact/phone/email/address/notes）+ `erp_ext`（**v2.5.1 实装**） |
| `relation.link` / `relation.unlink` | ERP 写 | 建立/解除客户↔产品集关联 |
| 事件 `customerCreated` / `customerUpdated` / `fileArchived` | box → ERP | 复用 `host.events` 总线，增量同步不靠轮询 |

<!-- contract:v1:host.customer -->
<!-- contract:v2.7:customer.list -->
<!-- contract:v2.7:customer.get -->
<!-- contract:v2.7:customer.write-erp-ext -->
<!-- contract:v2.7:customer.sync-profile -->
<!-- contract:v2.7:relation.link -->
<!-- contract:v2.7:relation.unlink -->
<!-- contract:v1:event.customer-file-archived -->
<!-- contract:v2.7:event.customer-created -->
<!-- contract:v2.7:event.customer-updated -->
<!-- contract:v2.7:event.file-archived -->

**方法签名**（v2.5.1 实装，`host.customer`；权限门控：`manifest.permissions.customers !== true` → 全部方法抛 `PERMISSION_DENIED`，**含读方法**——与 `host.account` 未声明时恒 null 的静默不同，customers 含写，显式拒绝更诚实）：

```ts
customer: {
  /** 客户档案全量/增量列表；since = updated_at 严大于过滤（ISO 串，Date.parse 归一化），缺省全量 */
  list(since?: string): Promise<CustomerProfile[]>
  /** 单客户档案；不存在（以目录为准）→ null */
  get(name: string): Promise<CustomerProfile | null>
  /** 仅写 erp_ext 命名空间（整体替换）；目录有而 JSON 无条目 → 补最小条目后写；目录亦无 → NOT_FOUND */
  writeErpExt(name: string, ext: Record<string, unknown>): Promise<void>
  /** 双向同步：写本体对齐字段（type/contact/phone/email/address/notes）+ erp_ext；
   *  回显式乐观锁：req.updated_at ≤ 档案 updated_at → STALE；较新 → 仅写白名单差异字段；
   *  box 权威字段（alias/country/source/related_product_sets/tags）入参 → FIELD_DENIED */
  syncProfile(req: {
    name: string
    fields?: { type?: '企业' | '个人'; contact?: string; phone?: string; email?: string; address?: string; notes?: string }
    erp_ext?: Record<string, unknown>
    updated_at: string
  }): Promise<{ applied: boolean }>
  relation: {
    /** 客户↔产品集关联（related_product_sets 增删）；幂等；产品集不存在 → NOT_FOUND */
    link(customerName: string, productSetName: string): Promise<void>
    unlink(customerName: string, productSetName: string): Promise<void>
  }
}
```

**返回类型 `CustomerProfile`**（v2.5.4 类型收口，对齐 `src/plugins/types.ts`）：

```ts
interface CustomerProfile {
  name: string
  file_count: number           // 客户目录递归文件数
  alias?: string; country?: string; contact?: string; source?: string
  type?: '企业' | '个人'        // 缺省 = 未分类
  phone?: string; email?: string; address?: string
  tags: string[]
  notes: string
  related_product_sets?: string[]
  erp_ext?: Record<string, unknown>
  created_at: string; updated_at: string
}
```

**事件 payload**（v2.5.4 起文档化，对齐宿主实现 src/main/ipc.ts；经 `host.events.on` 订阅）：

| 事件 | payload |
|---|---|
| `customerCreated` | `{ name: string }` |
| `customerUpdated` | `{ name: string; oldName?: string }`（重命名时 `oldName` 带旧名） |
| `fileArchived` | `{ region: 'invoice' \| 'inbound' \| 'exchange' \| 'quote'; path: string; name: string }`（归档落盘的区 / 工作区相对路径 / 文件名；只投成功路径，批量逐条） |

<!-- contract:v2.5.4:customer-profile -->
<!-- contract:v2.5.4:event.payloads -->

**错误码**（v2.5.1 实装，全部带 code → 不计入熔断计数）：`PERMISSION_DENIED / NO_WORKSPACE / NOT_FOUND / INVALID_NAME / FIELD_DENIED / STALE / IO_ERROR`；**`syncProfile` 的 STALE 唯一口径 = 以带 `code` 的错误抛出**（2026-09-23 口径钉死；宿主 `ipc.ts` 适配器：内部 `applied:false` 即 `throw fileError('STALE', …)`，**不再以返回值形态出现**）——消费方按 `err.code === 'STALE'` 判定并续行，回显式乐观锁语义不变（请求方回填的 `updated_at` 须严大于档案值，「同时」亦判 STALE 不后写）。

**字段归属规则**（v2.4.9 定稿，替换 v2.4.7「ERP 不可写本体字段」表述）：

- erp-bridge（经 `customer.syncProfile`）可写：**本体对齐字段**（type/contact/phone/email/address/notes，即与启禾 OS共有的基础字段）与 `erp_ext`
- box 权威（ERP 只读）：alias/country/source/related_product_sets
- `erp_ext` 仅 ERP 写（本体只读不校验、API 面不含入参）

**`erp_ext` schema**（v2.7 erp-bridge 写入目标，本体不校验但文档定稿；2026-08-20 已随云桥 M1 实装）：

```ts
erp_ext?: {
  code?: string             // 客户编码（启禾 OS权威，erp customers.code，云桥上行回填）
  status?: string           // 客户状态：正常/停用/黑名单（启禾 OS权威，erp customers.status，云桥上行回填）
  synced_at?: string        // 最近同步时间（云桥写，ISO）
  // 后续按启禾 OS 扩展追加，命名空间规则不变
}
```
> 说明（2026-08-20，Q2）：原草案 `level/follow_status/last_order/ai_profile` 在 erp 侧无真实落点（契约悬空），已按桥接定稿**删除声明**；将来需要时按命名空间扩展规则追加。

<!-- contract:v2.7:erp-ext.schema -->

**冲突规则（记录级裁决）**：同步以整条档案 `updated_at` 较新者为准，方向确定后仅写对方能力域白名单内的差异字段；box 专属字段（alias/country/source/related_product_sets）不在 ERP 写白名单、永不被覆盖；`erp_ext` 仅 ERP 写。已知取舍：记录级时间戳粒度下，同记录内 box 与 ERP 对不同字段的并发改动存在互覆盖可能（v2.7 实装按此实现；字段级时间戳列为后续细化候选，不在本版本承诺）。

**能力域扩展规则**（v2.5 定稿）：

- **能力域 = 协议附录，一域一节**：每个业务能力域（customers，以及未来 suppliers、invoices 等）在 PLUGIN.md 以单独一节声明其公开契约，能力表、字段归属规则、命名空间 schema、冲突规则随节成组。
- **扩展模式统一**：任一能力域按「读能力（`list`/`get`）+ 写能力（`write<Ext>`）+ 关联能力（`relation.link`/`relation.unlink`）+ 事件（`<entity>Created`/`<entity>Updated`/`<entity>Deleted`，经 `host.events` 总线）」成组声明；customers 域为第一实例（读 = `list`/`get`、写 = `writeErpExt`/`syncProfile`、关联 = `relation.link`/`relation.unlink`、事件 = `customerCreated`/`customerUpdated`/`fileArchived`，见上表）。
- **命名空间通用约定（`erp_ext` / `ocr_ext`）**：插件写回本体不拥有的数据，一律写入命名空间字段，本体只读不校验；命名空间内字段由写入方（桥接插件）定义并版本化，本体不解析——`erp_ext` 由 erp-bridge 写（客户/供应商档案），`ocr_ext` 由 OCR 查验插件写（发票台账，v2.7 写入目标），均只读展示。
- **冲突裁决通用规则**：同步冲突沿用本节记录级裁决——整条档案 `updated_at` 较新者为准，方向确定后仅写对方能力域白名单内的差异字段（见上「冲突规则」）。
- **新增能力域 = 协议增量**：新增业务能力域遵循 §四「API 演进政策」（只增不删），随宿主版本发布；不删除、不改写既有能力域契约。

### 5.5.1 suppliers 能力域与 `erp_ext` 契约（v2.5.4 弹一 C-1，云桥 M3）

**suppliers 能力域**（照 §5.5 customers 薄壳模式：白名单收窄，不给通用文件读写）：

| 能力 | 方向 | 说明 |
|---|---|---|
| `supplier.list` / `supplier.get` | ERP 读 | 供应商档案全量/增量（`since` 严大于）；目录缺失 → null |
| `supplier.writeErpExt` | ERP 写 | 仅写 `erp_ext` 命名空间 |
| `supplier.syncProfile` | ERP 写 | 双向同步：本体对齐字段（contact/phone/email/address/notes）+ `erp_ext`（回显乐观锁，供应商无 type） |
| 事件 `supplierCreated` / `supplierUpdated` | box → ERP | 复用 `host.events` 总线，增量同步不靠轮询 |

**权限门控**：`manifest.permissions.suppliers !== true` → 全部方法抛 `PERMISSION_DENIED`（**含读方法**，独立位——不复用 customers，不同数据域显式声明更诚实）。

<!-- contract:v1:host.supplier -->

```ts
supplier: {
  /** 供应商档案全量/增量列表；since = updated_at 严大于过滤（ISO 串，Date.parse 归一化），缺省全量 */
  list(since?: string): Promise<SupplierProfile[]>
  /** 单供应商档案；不存在（以目录为准）→ null */
  get(name: string): Promise<SupplierProfile | null>
  /** 仅写 erp_ext 命名空间（整体替换）；目录有而 JSON 无条目 → 补最小条目后写；目录亦无 → NOT_FOUND */
  writeErpExt(name: string, ext: Record<string, unknown>): Promise<void>
  /** 双向同步：写本体对齐字段（contact/phone/email/address/notes）+ erp_ext；
   *  回显式乐观锁：req.updated_at ≤ 档案 updated_at → STALE；较新 → 仅写白名单差异字段；
   *  box 权威字段（tags/related_product_sets）入参 → FIELD_DENIED */
  syncProfile(req: {
    name: string
    fields?: { contact?: string; phone?: string; email?: string; address?: string; notes?: string }
    erp_ext?: Record<string, unknown>
    updated_at: string
  }): Promise<{ applied: boolean }>
}
```

**返回类型 `SupplierProfile`**（对齐 `src/plugins/types.ts` / `shared/types.ts SupplierInfo`）：

```ts
interface SupplierProfile {
  name: string
  file_count: number           // 供应商目录递归文件数
  contact?: string; phone?: string; email?: string; address?: string
  notes: string
  tags: string[]
  related_product_sets?: string[]
  erp_ext?: Record<string, unknown>
  created_at: string; updated_at: string
}
```

**事件 payload**（对齐宿主实现 src/main/ipc.ts；经 `host.events.on` 订阅，只投成功路径）：

| 事件 | payload |
|---|---|
| `supplierCreated` | `{ name: string }` |
| `supplierUpdated` | `{ name: string; oldName?: string }`（创建/更新/重命名；重命名时 `oldName` 带旧名） |

<!-- contract:v1:event.supplier -->

**字段归属规则**（同 customers 域语义）：erp-bridge（经 `supplier.syncProfile`）可写 **本体对齐字段**（contact/phone/email/address/notes）与 `erp_ext`；box 权威（ERP 只读）：tags/related_product_sets；`erp_ext` 仅 ERP 写（本体只读不校验、API 面不含入参）。供应商无 type 字段（schema 零迁移，云桥 M3 口径）。

### 5.5.2 quote 只读域（v2.5.4 弹一 C-4，云桥 M3）

**报价台账只读投影**（增量读，供云桥插件上行推送前读取 box 报价数据）：

| 能力 | 方向 | 说明 |
|---|---|---|
| `quote.list` / `quote.get` | 桥读 | 报价台账全量/增量（`since` 严大于）；单条不存在 → null |

**权限门控**：**并入 `permissions.customers` 同一位**（C-2 拍板——客户/供应商/报价是同一桥插件的客户关系数据面，权限位不碎片化）；未声明 → 全部方法抛 `PERMISSION_DENIED`。

**无任何写方法**：报价在 box 侧的建档永远走预填桥（§5.7 `openCreatePrefill('quote')` / `openEditPrefill`）手动确认；上行推送后 erp 回执（行 id 集合）存插件 storage——box 报价台账保持纯净。

<!-- contract:v1:host.quote -->

```ts
quote: {
  /** 报价台账全量/增量列表；since = updated_at 严大于过滤（ISO 串，Date.parse 归一化），缺省全量 */
  list(since?: string): Promise<QuoteProfile[]>
  /** 单条报价；不存在（无此单号）→ null */
  get(quotationNo: string): Promise<QuoteProfile | null>
}
```

返回类型 `QuoteProfile` = box 台账字段全量（`quotation_no` / `date` / `customer` / `lines[{product,sku,qty,unit_price,amount}]` / `total_amount` / `status('草稿'|'已确认'|'修订中')` / `confirmed_at?` / `notes?` / `file_path` / `quote_ext?` / `created_at` / `updated_at`），对齐 `shared/types.ts QuoteRecord`（运行时零改动）。

### 5.5.3 invoice / inbound 只读域（v2.5.7 协议增量 E1 / E2）

**发票 / 入库台账只读投影**（增量读，供云桥/OCR 插件在推送前读取 box 台账数据；照 §5.5.2 quote 薄壳模式）：

| 能力 | 方向 | 说明 |
|---|---|---|
| `invoice.list` / `invoice.get` | 桥读 | 发票台账全量/增量（`since` 严大于）；单条（号码=查重主键）不存在 → null |
| `inbound.list` / `inbound.get` | 桥读 | 入库台账全量/增量（`since` 严大于）；单条（单据编号=主键）不存在 → null |

**权限门控**：**并入 `permissions.customers` 同一位**（与 quote 同——客户关系数据面权限位不碎片化，C-2 拍板延续）；未声明 → 全部方法抛 `PERMISSION_DENIED`。

**无任何写方法**（只读投影）：发票/入库的建档永远走预填桥（§5.7 `openCreatePrefill('invoice')` / `openEditPrefill`）手动确认；与 quote 相同——box 台账保持纯净，插件不直写台账。

<!-- contract:v1:host.invoice -->
<!-- contract:v1:host.inbound -->

```ts
invoice: {
  /** 发票台账全量/增量列表；since = updated_at 严大于过滤（ISO 串，Date.parse 归一化），缺省全量 */
  list(since?: string): Promise<InvoiceProfile[]>
  /** 单张发票（号码=查重主键）；不存在 → null */
  get(number: string): Promise<InvoiceProfile | null>
}
inbound: {
  /** 入库台账全量/增量列表；since = updated_at 严大于过滤（ISO 串，Date.parse 归一化），缺省全量 */
  list(since?: string): Promise<InboundProfile[]>
  /** 单张入库单（单据编号=主键）；不存在 → null */
  get(id: string): Promise<InboundProfile | null>
}
```

返回类型对齐 `shared/types.ts`（`InvoiceRecord` / `InboundRecord`）：`InvoiceProfile` = `number / code? / date / amount / seller / buyer / status('待报销'|'已报销'|'已入账') / customer? / supplier? / due_date? / file_path / tags? / notes? / created_at / updated_at`（`supplier?` = **v2.5.7 补丁线**进项票关联供应商，box 权威字段、名字引用语义同 `customer`——在宿主「发票」页编辑落，供应商改名由 `renameSupplier` 级联；旧宿主投影无此字段，插件须容缺省）（**不含 `ocr_ext` 命名空间**）；`InboundProfile` = `id / date / supplier / supplier_id? / product_set? / file_path / amount? / notes? / created_at / updated_at`。

### 5.6 share 能力域（局域网共享与拉取，v2.5.1 实装）

**定位**：为「把工作区发布到局域网 + 拉取进工作区」提供**契约内**通道。通用域（非 LAN 专属，协议地位平等）。本域与 v2.7 `com.qihe.share`（P2P 直传插件）**无关**。

**权限门控**：`manifest.permissions.share !== true` → 全部方法抛 `PERMISSION_DENIED`（同 §5.5 customers 口径）。

<!-- contract:v1:host.share -->

> **legacy 注记（v2.5.4 弹一 C-5b，协议真合并）**：`listCustomers`/`listProductSets` 方法**物理保留（只增不删，LAN 插件在用）**，实现与各实体域（`customer.list`/`supplier.list`）**同源**（同一 core 数据投影，仅剥离 `erp_ext`/`ocr_ext` 命名空间）。**新插件请用实体域**（`customer.list` / `supplier.list` / `quote.list`）——share 域仅为局域网协作保留的视图通道。

```ts
share: {
  /** 只读实体视图（字段白名单见下；不含 erp_ext / ocr_ext 命名空间）——
   *  v2.5.4 起同源转调实体域（legacy，见上注记） */
  listProductSets(): Promise<unknown[]>
  listCustomers(): Promise<unknown[]>
  /** 目录树一层（名称/类型/大小/mtime）；relPath 缺省 = 工作区根；
   *  .qihefilemanager/（含 trash）拒绝（HIDDEN）；5s 短缓存由插件侧自管。
   *  条目形状 2026-09-23 钉死（实现 `qihe-box/src/main/core/shareView.ts:150`）：
   *  `{ name: string; kind: 'dir' | 'file'; size: number; mtime: string }`——
   *  目录 size 恒 0、mtime 为 ISO 串（stat 失败条目 size 0 / mtime ''）；排序 = dir 全在 file 前、同类按名升序。
   *  **判别类型只认 `kind`**（曾有插件按不存在的 `type:'directory'|'file'` 判别 ⇒ 真宿主下清单恒空；
   *  context 插件 2026-09-22、cloud 插件同族缺陷均已修） */
  listTree(relPath?: string): Promise<{ name: string; kind: 'dir' | 'file'; size: number; mtime: string }[]>
  /** 元数据（无记录 → 空 tags/notes/证书字段）；文件路径 → metadata store；
   *  产品集根路径 → product_sets.json（两级粒度；产品集根不是证书载体 ⇒ 证书两字段恒空串）。
   *  v2.6 批7（D8）：形状 + `cert_type` / `expiry_date` 证书两字段 */
  getMetadata(relPath: string): Promise<{ tags: string[]; notes: string; cert_type: string; expiry_date: string }>
  statFile(relPath: string): Promise<{ size: number; mtime: string }>
  /** Range 读：length ≤ 4MB/次；宿主侧定位读（fs.read position，禁止全量载入）；
   *  offset+length 越界截断到 EOF（返回短读） */
  readFileChunk(relPath: string, offset: number, length: number): Promise<Uint8Array>
  /** 拉取写：offset=0 新建截断、>0 定位写（fs.write position）；单 chunk ≤ 4MB；
   *  拒绝清单（HIDDEN）：.qihefilemanager/（含 trash）、导出/、交换区/；
   *  realpath 逃逸 → OUT_OF_WORKSPACE；写入后失效目标目录索引快照 */
  writePulledFile(targetRelPath: string, chunk: Uint8Array, offset: number): Promise<void>
  /** 同名合并：存在 → 'exists'（零覆盖）；不存在 → 复用产品集/客户创建 → 'created' */
  ensureProductSet(name: string): Promise<'created' | 'exists'>
  ensureCustomer(name: string): Promise<'created' | 'exists'>
  /** 按需确保第一层子文件夹存在（图包/证书/文档/客户）——v2.5.9（A9）起「以盘为准」：：
   *  kind=image|cert|doc → 产品集/<holder>/{图包|证书|文档}/<name>；kind=customer → 客户/<holder>/<name>。
   *  目录缺失 → **创建**；已存在 → 什么都不做；幂等。**不再登记进全局子文件夹表**
   *  （那张表如今只是"新建产品集/客户时的默认目录模板"，插件建出来的目录本身就在盘上，
   *   界面直接可见，无需登记）。若插件此前依赖"注册后别的集也出现该文件夹"，那是旧缺陷而非契约。名称/holder 防穿越；kind 非法 → INVALID_NAME */
  ensureSubfolder(kind: 'image' | 'cert' | 'doc' | 'customer', holder: string, name: string): Promise<void>
  /** 元数据合并导入：path 粒度两级——文件路径 → metadata store；产品集根路径 → product_sets.json；
   *  tags 并集；notes / cert_type / expiry_date **逐字段**「本地为空采纳远端、本地非空且不同 → 保留本地（计入冲突清单）」；
   *  v2.6 批7（D8）：文件级 + 可选 `cert_type` / `expiry_date`（缺省 = 不改动本地；`expiry_date` 落库前归一化为
   *  `YYYY-MM-DD`，不可解析则原样保留）——**写入后宿主原生「证书到期提醒」即生效**（现行：到期日 ±30 天窗 + 文件存在校验）。
   *  产品集根不是证书载体 ⇒ 该两字段不落、不计冲突。单批 ≤ 500 条；返回冲突清单供插件提示 */
  mergePulledMetadata(entries: { path: string; tags: string[]; notes: string; cert_type?: string; expiry_date?: string }[]): Promise<{ conflicts: string[] }>
  /** 缩略图通道（v2.5.7 协议增量 E4）：relPath 工作区相对路径 → 缩略图 URL（qihebox:// 协议，可直接 <img src>）。
   *  size：256（默认，缩略档）| 2048（预览降采样副本）。图片按需生成；视频仅缓存命中
   *  （未缓存空串，不生成——帧缩略图由渲染层抓帧后写缓存）；非图片 → ''。
   *  隐藏/逃逸路径 → HIDDEN / OUT_OF_WORKSPACE（同 share 域错误码）。返回空串 = 无缩略图可用 */
  getThumb(relPath: string, size?: 256 | 2048): Promise<string>
}
```

**错误码**（v2.5.1 实装，全部带 code → 不计入熔断计数）：`PERMISSION_DENIED / NO_WORKSPACE / NOT_FOUND / INVALID_NAME / HIDDEN / OUT_OF_WORKSPACE / IO_ERROR`。

**字段白名单**：

- `listProductSets`：name / image_count / cert_count / doc_count / created_at / tags / notes（**不含** erp_ext / ocr_ext 命名空间）
- `listCustomers`：name / file_count / alias / country / contact / source / type / phone / email / address / tags / notes / related_product_sets / created_at / updated_at（**不含** erp_ext）
- `getMetadata`（v2.6 批7 D8 扩）：`{ tags, notes, cert_type, expiry_date }`——证书两字段**只有文件级路径有**（产品集根不是证书载体 ⇒ 恒空串）
- `getThumb`（v2.5.7 E4 实装）：返回 `qihebox://thumb/<...>` URL（图片 256/2048 两档按需生成；视频仅缓存命中；非图片空串）——见上方 §share 方法签名

**明确不做**（共享面边界）：

- 共享面**无任何写端点**——对端写 = 拉取方主动 `writePulledFile` 进**自己**工作区；`.qihefilemanager/`（含 trash）永不暴露
- `erp_ext` / `ocr_ext` 不进共享视图
- **与 files 域分工**：`files` = 单文件读 + 导出写（插件自身操作）；`share` = 结构化视图 + Range 读 + 拉取写（跨机协作契约）。收窄张力取舍：share 域不为「通用文件浏览」开放，实体视图是协作语义的主通道

### 5.7 ui 能力域：新建通用预填（v2.5.4 实装）

**`window.qihebox.ui.openCreatePrefill`** —— 渲染层 UI 钩子（插件页面与宿主同窗口同 JS 上下文，直调即可）：跳转对应页面、打开新建弹窗并按载荷填好字段。**永不自动建档**——创建始终由用户在弹窗手点确认；纯 UI 动作，无返回值、无数据写入、不过 IPC、不需要 permissions 声明。

```ts
window.qihebox.ui.openCreatePrefill(
  entity: 'customer' | 'productSet' | 'supplier' | 'quote' | 'invoice' | 'inbound',
  payload: CreatePrefillPayload | CreatePrefillPayload[],  // 数组 = 批量，逐条确认（创建推进下一条 / 取消清空队列）
): void
```

**载荷 = 各实体创建字段的全可选子集（传啥填啥；未知键忽略，非法值丢键）**：

| entity | 载荷字段（全部可选） | 落点 |
|---|---|---|
| `customer` | name/alias/country/contact/source/type(企业\|个人）/phone/email/address/tags/notes/related_product_sets | `/clients` 新建客户弹窗 |
| `productSet` | name/tags/notes | `/product-sets` 新建产品集弹窗 |
| `supplier` | name/contact/phone/email/address/notes/tags/related_product_sets | `/suppliers` 新建区 |
| `quote` | quotation_no/date/customer/lines[{product,sku,qty,unit_price}]/notes/file_path | `/quotes` 新建报价单弹窗 |
| `invoice` | number/code/date/amount/seller/buyer/customer/due_date/file_path/tags/notes（status 不预填，新建恒「待报销」） | `/invoices` 发票 tab |
| `inbound` | id/date/supplier/supplier_id/product_set/amount/notes/file_path | `/invoices` 入库 tab |

**规则**：单批 ≤50 条（超出截断）；按自然键去重（customer/supplier/productSet=name、quote=quotation_no、invoice=number、inbound=id；缺键条目保留）；字符串 trim；枚举（customer.type）非法丢键；数组字段非数组成员丢弃；保存校验完全复用各实体既有 create 流程（预填不绕过任何校验）。未知 entity 静默忽略（调用方编程错误不落地）。

**典型调用方**：erp-bridge「仅云端客户」面板（云字段 → customer 预填，含批量）；AI/OCR 识别插件（识别图片/文档产出 `{entity, fields}` → 同一入口预填——识别引擎在插件侧，宿主永不内置 AI 推理）。字段类型定义见宿主 `src/renderer/src/stores/createPrefillNormalize.ts`（`CreatePrefillPayload` 等）。

<!-- contract:v2.5.4:ui.open-create-prefill -->

#### 5.7.1 编辑预填（v2.5.4 弹一 C-6，表单注册表全表单化）

**`window.qihebox.ui.openEditPrefill(entity, key, payload)`** —— 渲染层 UI 钩子（同 openCreatePrefill 语义）：**key = 实体自然键**（customer/supplier/productSet=name、quote=quotation_no、invoice=number、inbound=id），跳转对应详情/列表页、打开**编辑弹窗**——弹窗先加载该记录原值，payload 为「建议改动」覆盖为建议值，**保存仍由用户手点**（永不自动覆盖）。

```ts
window.qihebox.ui.openEditPrefill(
  entity: 'customer' | 'productSet' | 'supplier' | 'quote' | 'invoice' | 'inbound',
  key: string,                                          // 实体自然键
  payload: CreatePrefillPayload,                        // 建议改动（与 create 同 schema，未知键忽略）
): void
```

**规则**：单条制（不批量不去重——编辑是"改一条"）；payload 归一化同 §5.7（trim/枚举合法值/数组过滤）；原值由弹窗自身加载（key 对应记录不存在 → 忽略本次建议，不报错）；保存校验完全复用各实体既有 update/detail 流程。**语义分档（弹一 T3/E3 拍板）**：customer/supplier 保存后宿主事件（`customerUpdated`/`supplierUpdated`，§5.5.1）可被插件感知；quote/invoice/inbound 宿主无 created/updated 事件源——插件端"保存成功"需用户对话确认（不做自动回填承诺）。

**全表单注册表（v2.5.4 覆盖「所有表单都能填」）**：

| formId | 入口 | 落点 |
|---|---|---|
| `customer.create` / `customer.edit` | openCreatePrefill / openEditPrefill | `/clients`（新建弹窗 / 客户详情编辑弹窗） |
| `productSet.create` / `productSet.edit` | 同上 | `/product-sets`（新建弹窗 / 编辑弹窗） |
| `supplier.create` / `supplier.edit` | 同上 | `/suppliers`（新建区 / 供应商详情编辑弹窗） |
| `quote.create` / `quote.edit` | 同上 | `/quotes`（新建弹窗 / 报价详情编辑弹窗） |
| `invoice.create` / `invoice.edit` | 同上 | `/invoices` 发票 tab（新建 / 编辑弹窗） |
| `inbound.create` / `inbound.edit` | 同上 | `/invoices` 入库 tab（新建 / 编辑弹窗） |

<!-- contract:v2.5.4:ui.open-edit-prefill -->

#### 5.7.2 openEntity 导航桥（v2.5.7 协议增量 E3）

**`window.qihebox.ui.openEntity(entity, key)`** —— 渲染层 UI 钩子（同 prefill 语义）：跳本体**实体对应页**——有详情页的实体（customer/productSet/supplier/quote）带 `key`（自然键）去详情/编辑定位；invoice/inbound 回列表页（本体无对应详情深链，列表内可再定位）。纯 UI 动作：无数据写入、不过 IPC、不需要 permissions 声明；未知 entity / 空 key 静默忽略（编程错误不落地）。

```ts
window.qihebox.ui.openEntity(
  entity: 'customer' | 'productSet' | 'supplier' | 'quote' | 'invoice' | 'inbound',
  key: string,   // customer/supplier/productSet=name、quote=quotation_no；invoice/inbound 忽略 key（回列表）
): void
```

**典型调用方**：OCR/识别插件识别出某张发票/入库单后 → `openEntity('invoice')` 让用户直接看到台账结果；ERP 侧提示「该客户档案在这里」→ `openEntity('customer', name)`。

<!-- contract:v2.5.7:ui.open-entity -->

---

## 六、安全与信任分级

**诚实说明**：v1 采用进程内（inproc）加载，插件代码经动态 import 进入宿主进程后，技术上拥有与宿主相同的能力（Node API 可达）。「插件只能经 host 访问系统」是**架构约定而非技术强制**（与 Obsidian 的公开立场一致）。因此分级：

| 信任级 | 对象 | 约束方式 |
|---|---|---|
| 可信 | 官方索引分发的 `.qbox` | 官方评审（与本体同级标准）；SHA-256 经官方索引公布比对 |
| 受限信任 | 手动侧载的 `.qbox` | **v2.5 侧载收紧**：导入入口在「插件管理页 → 开发者模式」（默认关）；宿主在 IPC 层强制（devMode 关闭时安装被拒）；安装前弹通用风险确认框（明确告知同等系统权限 + 未经官方审查 + 仅安装信任来源）；安装后展示权限声明；对恶意插件**不设防** |

**协议地位平等**：宿主不存在仅官方插件可调用的隐藏 API——官方插件走的每一条通道都在本文档内。官方与第三方的差别全部在协议外（分发渠道与信任级），不在协议内。

宿主对两级均强制执行：

1. 插件只能通过 `host` 注入的能力访问系统；不提供任意路径读写、任意 shell 执行（`host.files` 为白名单例外，见 §5.1）
2. 插件状态只能写在 `userData/plugins/<id>/state/`；storage.set 有路径与大小校验（单 key ≤ 1MB，总容量 ≤ 64MB） <!-- contract:v1:storage.bounds -->
3. 插件不得注册 `qihebox:*` 前缀通道；事件 channel 强制 `ipcPrefix` 前缀 <!-- contract:v1:channel.reserved --> <!-- contract:v1:event.prefix -->
4. `permissions` 字段先行：v1 用于展示与安装确认，未来 `transport='process'` 隔离落地时升级为强制拦截
5. 插件文件响应携带 `Content-Security-Policy` 头（`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`）<!-- contract:v1:security.csp -->——**诚实说明**：插件页面以 `import()` 模块加载，Chromium 不对 JS 子资源执行响应头 CSP，故该头目前为**形式防护**（v2.7 沙箱化后生效）；插件代码的实质隔离依赖 v2.7 `transport='process'`
6. 一切安装均需 JSON Schema + SHA-256 校验；侧载另需开发者模式开启 + 通用风险确认框 <!-- contract:v1:install.check -->

**确认对话框口径（v2.5 落地）**：安装确认框文案为「此插件将获得与启禾文件管理同等的系统权限：可读取工作区文件、访问网络、执行系统命令。插件未经过官方审查。仅安装你信任来源的插件。确认安装？」；权限声明的完整展示在安装后的管理页详情中（安装前逐项预览属 v2.6 预检 API，v2.5 不实现）。

<!-- contract:v1:sideload.gate -->

**官方预装（离线可用，v2.6 起）**：发行方可把官方 `.qbox` 放进安装包内的预装目录随包分发（打包态 `resources/official-plugins/`；开发/未打包态回退仓库内 `build/official-plugins/`）。应用**每次启动**扫描该目录（首次启动完成安装，之后命中「已装 ≥ 预装」判据直接跳过，无重复安装），对每个包走与手动安装**完全相同**的标准安装管线（清单 Schema 校验 + 整包 SHA-256 → 解压到 `userData/plugins/<id>/pkg/` → 登记），落位与语义一致——**预装包同样可停用、可卸载、可被更高版本覆盖更新，不享有任何隐藏通道**；预装来源不改变本节的信任分级，协议能力与手动安装（侧载/官方索引）的包完全平等。两条判据：① 同 id 已安装且版本 ≥ 预装版本 ⇒ **跳过**，不覆盖用户已有版本（已装但清单损坏/版本不可读时按覆盖安装尝试修复，失败则回滚并记失败）；② 预装目录不存在（例如开源自建构建不带预装目录）⇒ **零预装条目**，出包与功能不受影响。预装失败**不阻断应用启动**：单包失败只记日志并收进报告，报告落在 `userData/plugins/preinstall-report.json`（`userData` 位置见 §七），逐包记录动作（`installed` / `updated` / `skipped` / `failed`）与人话原因；主进程日志另打印对应 warn 行（跳过的打印 info）。

**官方插件加密诚实口径（v2.5.7 起，F5）**：加密（`encryption` 块，见 §二/§三）**不是 DRM，不承诺防破解**——按 Kerckhoffs 原则，解密逻辑随 box 源码公开，掌握宿主可执行文件的攻击者（含用户自编译、attach 调试）可在进程内转储解密后的明文。加密的实际价值有三，均以「提高门槛」而非「不可破」为目标：①静态提取需要先破解（unzip+grep 直接拿不到代码）；②密钥服务端化（erp `POST /api/box/plugin-key` 权益门控 + 密文 sha256 比对 + 取钥审计）使**无账号/无权益分发不可用**；③审计落账可溯源泄漏。密钥 7 天缓存宽限仅在本机生效，过期须在线取钥（锁云端插件入口；本地功能不受影响）。**取钥失败的用户可见口径（v2.6 起）**：宿主不把失败折叠成一句通用话术，而是按云端 `code` 报出**问题 + 下一步**——该版本未在云端登记（去联系插件发布方）/ 包内容与登记不一致（已拒绝加载，重新安装）/ 取钥门槛未生效（指向应用内订阅入口）/ 未登录（去登录）/ 云端故障（可重试）；**fail-closed 不变**：拿不到钥就不加载、不解密。原因同时留在插件管理页（插件条目上的「最近一次加载失败」，激活成功后清除）。

---

## 七、状态隔离

| 数据 | 位置 | 归属 |
|---|---|---|
| 工作区配置/元数据 | 工作区 `.qihefilemanager/` | 本体（插件禁写） |
| 最近工作区/缩略图/索引 | `userData/` | 本体 |
| 插件启停覆盖 | `userData/plugins/config.json` | 宿主 |
| 插件代码包 | `userData/plugins/<id>/pkg/` | 宿主（安装器写入） |
| 插件业务状态 | `userData/plugins/<id>/state/` | 插件（storage 限界） |
| 插件导出物 | 工作区 `导出/<pluginId>_<fileName>` | 插件产物（`host.files.writeExport`，应用导出区展示；**卸载不自动删除**） |

<!-- contract:v1:state.isolation -->

**`syncScope` 语义（v2.5 增量）**：`state/` 位于 `userData/plugins/<id>/`（本机全局，不在工作区内）——`syncScope: 'global'` 声明该插件的状态期望跨设备可用，`'local'`（缺省）为仅本机。消费机制尚未落地（后续版本提供），v2.5 仅作声明与展示。

<!-- contract:v1:sync-scope.semantics -->

**首方插件的用户数据区写口（授权例外，v2.6 起）**：上表列的是**通用**隔离面；唯一的例外是官方首方插件 `com.qihe.cloud`（启禾云）——经产品方明确授权，它可以把图片整理结果写入工作区**用户数据区**的产品集图包目录 `产品集/<集名>/图包/**`。该例外受四条自律约束，四条同时成立才允许落盘：① **复制不移动**——源文件只读，不改不删；② **同名加序号、绝不覆盖**既有文件；③ 目标集只限**已存在**的产品集（不在清单即拒）；④ 目标路径经**真实路径（realpath）校验**必须仍在工作区内（拒 `..` 与符号链接逃逸）。**该例外属首方授权，第三方插件不自动适用**——第三方插件要写用户数据区，须另行取得用户明示授权，并在插件说明中披露写面与范围。

**同一位首方插件 v0.9.1 四条自用通道的写面台账（2026-09-25 补录）**：上段授权的落盘只经 `ai.wb.organize.apply` 一条写口；同批另有两条只读腿与一条只写插件自有状态区的腿。四条均为**插件自用 IPC**（完整通道 = `qihebox:plugin:cloud:<action>`；宿主零改动、不新增宿主契约、不占权限位），逐条登记写面：

| 通道 | 入参 → 返回（承重字段） | 写面 |
|---|---|---|
| `ai.wb.organize.pickDir` | 无参 → `{ ok, dir }`（取消 = `ok:false` + 空 `dir`） | 无（弹宿主目录框选一个**工作区外**的文件夹，`host.dialog.openDirectory`） |
| `ai.wb.organize.scan` | `{ dir, limit? }` → `{ ok, dir, files[{name, relPath, absPath, bytes}], found, truncated, skipped, errors, budgetHit, dirsVisited }`（失败 = `{ ok:false, message }`） | 无（只读递归列 jpg/jpeg/png/webp；符号链接不跟随，截断如实报） |
| `ai.wb.organize.apply` | `{ rows[{name, srcPath, targetSet, newName?}] }` → `{ ok, message?, total, done, failed, results[{ok, name, newPath?/reason?}] }`（逐行成败隔离） | **工作区用户数据区**：`产品集/<集名>/图包/**`——即上段授权例外，受四条自律约束 |
| `ai.wb.calib` | 一条带字符串 `kind` 的校准记录 → `{ ok }`（`ts` 由主进程现取） | 插件自有区：`userData/plugins/<id>/state/` 的 `ai:calib:v1`（环形封顶 100 条；不出网、不扣额度） |

---

## 八、资源与启动承诺

- 未安装/禁用插件：零内存、零代码加载
- 插件代码全部惰性加载，不进 `app ready → 窗口可交互` 关键路径
- 「停用即释放」的诚实口径：ESM 模块代码一经加载无法从 V8 卸载（VS Code / Obsidian 同样如此）；承诺是停用后**实例/订阅/定时器/IPC 通道全部回收**，模块代码常驻、重启后完全释放
- 「更新即重启」的诚实口径（2026-09-22）：插件代码与页面一经加载即进模块缓存，**覆盖安装（更新）不热替换进程内已加载的旧版本**——新版本在重启应用后完全生效（宿主不做进程内热替换承诺）

<!-- contract:v1:memory.zero -->

---

## 九、开发与调试

- 公开仓库 `src/plugins/hello/` 是教学样板 + e2e 夹具：展示 manifest 写法、activate/registration、页面与命令注册（storage/events 最小配方见其 README §四）
- **完整教学见 `src/plugins/hello/README.md`**（15 分钟上手 + 逐文件讲解 + 改造指引 + 契约速查 + 已知边界）
- 构建：参考 `scripts/build-hello-plugin.mjs`，把编译产物打包为 `.qbox`（zip）
- 安装：应用内「设置 → 插件 → 开发者模式」开启后，经「手动导入 .qbox」侧载（默认关闭开发者模式；安装前有通用风险确认框）
- 调试：主进程日志经 `host.log`；broken 原因、激活耗时、调用计数在管理页可见
- **一致性套件**：`npm run conformance -- <插件路径>`（`.qbox` 或含 `manifest.json` 的目录；未传参默认体检 hello）对插件跑协议体检（manifest 校验→安装→握手→页面/IPC/命令→host API 语义往返→卸载），上手与报告解读见 `tests/e2e/conformance/README.md`
- 问题与协议不符之处：到公开仓库提 issue

---

## 十、未来扩展（协议预留，未生效）

- `transport: 'process'`：不可信插件组共享一个 utilityProcess 的隔离方案（VS Code 扩展宿主同粒度）
- `transport: 'http'`：loopback 桥接，供外部应用经桥接插件对接
- 两条路径下 `activate` / `PluginRegistration` 语义不变，仅传输层变化

<!-- contract:v2.7:transport.process -->
<!-- contract:v2.7:transport.http -->

---

*协议版本：v1（API_VERSION = 1，随 v2.5 宿主生效；2026-08-14 增量：syncScope / permissions.account / host.account / host.files / host.entitlement / 侧载收紧，均为向后兼容新增；2026-09-22 补：§二/§八 加「更新即重启」生效口径——非协议变更，仅承诺口径补全；2026-09-23 补：§5.6 `listTree` 条目形状钉死（只认 `kind`）、`STALE` 抛错口径钉死、§三 规则计数勘正——均为口径澄清，非协议变更；**同日 v2.6 批 2 实装**：§5.3 `catalog()` + `PluginCatalogEntry` 形状 + `install({ downloadUrl, sha256 })` 双形态与目录/下载链错误码、§二 安装链、§三.4 选版口径、§5.3 `app.relaunch()`——`catalog()` / 官方索引安装形态从「当前未实现」转为实装口径；同日 **v2.6 批 3 实装**：§一 插件分发口径改写（原「安装包不内置任何插件」→ 支持官方预装）+ §六 新增「官方预装（离线可用）」段——非协议变更（无新字段、无新通道、无新 IPC），仅分发形态与承诺口径补全）；2026-09-23 勘正（2.6 放行审查轮 2）：§〇「权益标记」措辞改为与实现一致（宿主零门槛校验，闸在云端取钥面）、§六 补「取钥失败的用户可见口径」（原因 + 下一步，fail-closed 不变）——仅口径澄清，非协议变更）；**2026-09-24 v2.6.1 增量**：§5.1 `host.workspace.defaultPath?()`（默认工作区**只读**持久指针，可选成员 + 能力探测，零权限位）——向后兼容新增，`API_VERSION` 仍 1，`currentPath()` / `list()` 签名与行为零改动；**2026-09-25 v2.6.1 增量（B8）**：§5.1 `host.dialog.openFiles?()`（多选，上限 200 宿主截断，可选成员 + 能力探测）+ §5.1 host.dialog 三条语义（取消≠失败 / 裸值非信封 / 只增不改）明写 + `getPathForFile` 升为稳定 util 契约（实现零变更）——同为向后兼容新增，`openFile` / `openDirectory` 形状与取消语义一字未动。**2026-09-26 v2.6.1 增量（B14）**：§5.1 `host.images?()`（宿主内置图像引擎口：读源 → 内存变换 → 返回编码字节，**宿主不写盘**；顺序 crop → rotate → resize；七错误码 `IMAGES_*`；可选成员 + 能力探测）——向后兼容新增，`API_VERSION` 仍 1，既有成员零改动。**2026-09-25 v2.6.2 增量**：§5.3 目录条目新增展示三字段 `images?` / `detail?` / 每版 `releaseNotes?`（官方目录 → 管理页「详情」弹窗：截图可翻、功能介绍、按版更新说明）——同为向后兼容新增，`API_VERSION` 仍 1，承重字段判据一字未动，新增的「宽容只限展示位」边界由单测分两头钉住。**v2.6.1 已于 2026-09-26 发布**；2.6.2 展示三字段仍在途（宿主读侧随 2.6.1 已落地、服务端目录面未上线），宿主能力探测为准） · 本文档在公开仓库维护，契约修订与实现同步*
