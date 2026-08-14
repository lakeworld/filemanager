# Hello 示例插件 —— 第三方插件作者的第一份教材

> 本目录是 启禾文件管理（qihe-box）插件协议的**教学样板**：最小可运行的 `.qbox` 插件，演示插件协议三种能力（`ipc` / `pages` / `commands`），并给出 `storage` / `events` 的最小可抄配方。目标是让你**照抄即可开工**——15 分钟跑通第一支自己的插件。
>
> - **宿主**：启禾文件管理（Electron + TypeScript），插件协议公开契约见仓库 `docs/PLUGIN.md`。
> - **本样板的插件版本**：`manifest.json` 里 `version` = `2.5.5`（插件自身版本号，与宿主版本无关）。
> - **分发形态**：侧载安装（开发者模式），构建产物 `out/plugins/com.qihe.hello.qbox` **不进安装包**。
> - **协议版本**：针对宿主 `apiVersion: 1`（当前宿主 `API_VERSION = 1`）。

---

## 一、这个插件演示了什么

| 能力 | 声明处 | 实现处 | 你能看到什么 |
|---|---|---|---|
| `ipc` | `manifest.json` 的 `kind` + `ipcPrefix` | `src/main/index.ts` 的 `activate` 返回 `ipc.ping` | 渲染层调 `plugins.call('com.qihe.hello', 'ping', …)`，主进程回显 |
| `pages` | `manifest.json` 的 `pages` | `src/renderer/Main.ts` | 侧边栏「插件」分组里的「Hello 示例」页面 |
| `commands` | `manifest.json` 的 `commands` | `src/main/index.ts` 返回 `commands['hello.greet']` | 文件列表右键菜单里的「👋 Hello 示例（记录文件数）」 |

三者之间的联动：页面里的按钮 → 经 `window.qihebox.plugins.call` → 主进程 `ipc.ping` → 回显结果渲染回页面；右键命令 → 主进程 `commands['hello.greet']` → `host.log` 记录选中文件数（管理页可见日志）。

`storage`（状态隔离存储）与 `events`（事件总线）本样板**没有**在页面里接线，但都属于 `host` 注入能力的核心成员；最小可抄配方见 [§四 改造指引](#四改造指引照抄即可开工) 的「storage / events 配方」。

---

## 二、目录结构逐文件讲解

```
src/plugins/hello/
├── manifest.json            # 插件清单：宿主据此校验、登记、注入页面/命令
└── src/
    ├── main/index.ts        # 主进程入口：export async function activate(host)
    └── renderer/Main.ts     # 页面模块：SolidJS 无 JSX 写法，组件 = 模块默认导出

scripts/
├── build-hello-plugin.mjs   # 构建脚本：源码 → 自包含 .qbox（仓库根目录）
└── build-hello-plugin.d.mts # 构建脚本的类型声明（供静态检查，运行时不加载）
```

### 2.1 `manifest.json` —— 每个字段为什么这么写

```jsonc
{
  "id": "com.qihe.hello",          // ① 全局唯一 id，域名倒序（如 com.qihe.hello）。冲突 → 宿主标记 broken
  "name": "Hello 示例插件",         // ② 展示名（管理页 / 侧边栏）。v1 用裸字符串
  "version": "2.5.5",              // ③ 插件自身版本（语义化版本），与宿主版本无关
  "apiVersion": 1,                 // ④ 针对的宿主 API 版本；宿主 API_VERSION 当前恒为 1
  "enabled": true,                 // ⑤ 默认启停，可被管理页覆盖
  "kind": ["ipc", "pages", "commands"], // ⑥ 声明的能力，至少其一；且须与实际 pages/commands 字段一致
  "ipcPrefix": "hello",            // ⑦ IPC 通道前缀 → qihebox:plugin:hello:<action>，全局唯一
  "description": "…",              // ⑧ 描述（管理页展示；network:'*' 时必填，见 §六）
  "author": "启禾软件",
  "license": "MIT",
  "pages": [                       // ⑨ pages 能力：注册到侧边栏 + 路由的页面入口
    {
      "path": "/plugin/hello",     //   路由路径，必须以 /plugin/ 开头（防与本体路由冲突）
      "label": "Hello 示例",        //   侧边栏菜单名
      "icon": "👋",                 //   侧边栏图标（emoji）
      "group": "插件",              //   侧边栏分组名
      "component": "renderer/Main.js" // 包内相对路径 → 页面模块产物（.ts 编译为 .js）
    }
  ],
  "commands": [                    // ⑩ commands 能力：右键菜单扩展点
    {
      "id": "hello.greet",         //   插件内唯一；对应 activate 返回的 commands['hello.greet']
      "label": "👋 Hello 示例（记录文件数）",
      "scope": "file"              //   file = 文件右键菜单；global = 全局菜单
    }
  ]
}
```

> 字段要点：`id` / `ipcPrefix` / `pages[].path` 三者都要全局唯一（`id`、`ipcPrefix` 在登记期校验，`pages[].path` 不与本体路由及已注册插件路由冲突）。`pages[].component` 是**包内相对路径**且必须能对应到 `.qbox` 内的真实文件。完整字段定义与九条校验规则见 `docs/PLUGIN.md` §三。

### 2.2 `src/main/index.ts` —— `activate` 返回什么

```ts
import type { PluginHost, PluginRegistration } from '../../../types'

export async function activate(host: PluginHost): Promise<PluginRegistration> {
  // host 是宿主注入的全部能力（log / storage / events / files / dialog / notify / account …）
  host.log('info', '[hello] 插件激活，宿主 API v' + host.apiVersion)

  const pings: string[] = []

  return {
    // ipc：key = action，完整通道 = qihebox:plugin:hello:<action>
    ipc: {
      ping: async (payload) => { /* …返回 { echo, count, apiVersion } */ },
    },
    // commands：key = manifest.commands[].id，回调拿到 { filePaths, host }
    commands: {
      'hello.greet': async (ctx) => { /* ctx.filePaths = 选中文件绝对路径数组 */ },
    },
    // dispose：禁用/卸载时宿主调用，回收定时器/订阅/引用
    dispose: () => { pings.length = 0 },
  }
}
```

- **入口约定**：主进程入口 `export async function activate(host)`，宿主在首次使用时动态 `import` 该文件并调用它；返回的 `PluginRegistration` 是插件向宿主注册的全部能力。
- **`ipc` 的 `action` 名**是插件自己定的（本例 `ping`），渲染层调用时用 `plugins.call(插件id, action, payload)` 的 `action` 对应它。
- **`commands` 的 key 必须等于 `manifest.commands[].id`**（本例 `hello.greet`），否则命令点了找不到回调。
- **`dispose` 是可选但推荐**：停用时回收实例状态；模块代码本身常驻（ESM 无法从 V8 卸载），重启后完全释放——这是插件协议的诚实口径，见 `docs/PLUGIN.md` §八。
- 类型定义在仓库 `src/plugins/types.ts`（与 `docs/PLUGIN.md` §五同源），宿主/插件双向 API 的完整签名都在这两个地方。

### 2.3 `src/renderer/Main.ts` —— 页面怎么写

```ts
import { createSignal } from 'solid-js'
import h from 'solid-js/h'          // 无 JSX 写法：用 h() 构造组件
import type { Component } from 'solid-js'

const Main: Component = () => {
  const [result, setResult] = createSignal('（尚未调用）')

  const callPing = async () => {
    const r = await window.qihebox.plugins.call('com.qihe.hello', 'ping', { text: '你好，插件！' })
    // r 是 ApiResult 包装：{ success, data, error }
    if (r?.success && r.data) setResult('回声：' + r.data.echo)
    else setResult('调用失败：' + (r?.error ?? '未知错误'))
  }

  return h('div', null, [
    h('h1', null, '👋 Hello 示例插件'),
    h('button', { get onClick() { return () => void callPing() } }, '调用 ping IPC'),
    h('div', null, () => result()), // 动态子节点传函数：信号变化才更新 DOM
  ])
}

export default Main   // 组件 = 模块默认导出，宿主动态 import 取 default
```

三条约定（构建脚本会强制校验，违反直接报错）：

1. **无 JSX**：本样板不用 `.tsx`，用 `import h from 'solid-js/h'` 的 `h()` 构造组件；`.tsx/.jsx` 或 `.ts/.js` 内含 JSX 会直接构建失败（esbuild 无 Solid JSX 编译语义）。
2. **组件 = 模块默认导出**：`export default Main`，宿主经 `qihebox://plugin/com.qihe.hello/renderer/Main.js` 协议 URL 动态 `import` 取 `default`。
3. **渲染层调用插件 IPC 走 `window.qihebox.plugins.call`**，返回值一律是 `ApiResult` 包装（`{ success, data, error }`），不是裸数据。

> `h()` 的细节：事件绑定用 `get onClick() { … }`（Getter 触发 spread 路径，Solid 标准事件挂载），动态文本用**函数子节点** `() => result()`（静态值只求值一次）。这两条在 `scripts/build-hello-plugin.mjs` 头注释有实测说明，照抄即可。

---

## 三、15 分钟上手路径

> 前置：Node.js 20+（建议 22+）。

```bash
# 1. 拉取公开仓库
git clone https://github.com/lakeworld/filemanager.git
cd filemanager

# 2. 装依赖（首次约数分钟）
npm i

# 3. 构建 hello 插件（esbuild 编译主进程 + 渲染层 → 打包 zip 为 .qbox）
node scripts/build-hello-plugin.mjs
# 产物：out/plugins/com.qihe.hello.qbox（成功静默，可用 ls out/plugins/ 确认）
```

4. 打开「启禾文件管理」应用。
5. **开启开发者模式**：`设置 → 插件 → 开发者模式`（默认关，侧载安装的入口门控，重启保持）。
6. **手动导入 `.qbox`**：插件管理页 → 手动导入 → 选 `out/plugins/com.qihe.hello.qbox` → 确认风险框（侧载插件与宿主同等系统权限，仅安装信任来源）。
7. **看三种能力**：
   - 侧边栏「插件」分组出现「👋 Hello 示例」→ 点开，点「调用 ping IPC」，看到回声与累计次数（`pages` + `ipc`）。
   - 文件列表里右键任意文件 → 「👋 Hello 示例（记录文件数）」→ 主进程日志记录选中文件数（`commands`）。
   - 插件管理页看状态：启用/禁用、激活耗时、调用次数、失败计数（可观测）。
8. **卸载**：插件管理页 → 卸载（删除代码与状态）；或先「禁用」（仅回收实例，数据保留）。

> 想自动化体检自己的插件：`npm run conformance -- <你的插件目录或 .qbox>`（默认体检 hello），协议一致性逐条 pass/fail 报告，解读见 `tests/e2e/conformance/README.md`。

---

## 四、改造指引（照抄即可开工）

把 hello 改成你的插件，按下面顺序改四步。

### 4.1 换身份：`id` / `ipcPrefix` / `name`

```jsonc
{
  "id": "com.example.mytool",   // 换成你的域名倒序 id（全局唯一）
  "ipcPrefix": "mytool",        // 换成你的通道前缀（全局唯一，且不以 qihebox: 开头）
  "name": "我的插件",
  "pages": [{ "path": "/plugin/mytool", "label": "我的插件", "icon": "🧰", "group": "插件", "component": "renderer/Main.js" }],
  "commands": [{ "id": "mytool.do", "label": "🧰 我的命令", "scope": "file" }]
}
```

- 改了 `id`，`.qbox` 产物名随之变为 `com.example.mytool.qbox`（构建脚本按 `manifest.id` 命名）。
- 改了 `pages[].path`，渲染层调用与页面路由同步改；改了 `ipcPrefix`，`activation` 里若有 `onEvent:<channel>` 的 channel 必须以新前缀开头（规则⑦）。

### 4.2 加自己的 command / action（主进程）

```ts
export async function activate(host: PluginHost): Promise<PluginRegistration> {
  return {
    ipc: {
      // 新 action：渲染层 plugins.call('com.example.mytool', 'sum', { a, b })
      sum: async (payload) => {
        const { a, b } = (payload ?? {}) as { a?: number; b?: number }
        return { result: (a ?? 0) + (b ?? 0) }
      },
    },
    commands: {
      'mytool.do': async (ctx) => {
        host.log('info', `[mytool] 选中 ${ctx.filePaths.length} 个文件`)
        // ctx.host 也可用：ctx.host.notify('标题', '内容')
      },
    },
    dispose: () => {},
  }
}
```

### 4.3 渲染层怎么调 `window.qihebox.plugins.call`

```ts
// 参数：(插件 id, action, payload)；插件 id = manifest.id（不是 ipcPrefix！）
const r = await window.qihebox.plugins.call('com.example.mytool', 'sum', { a: 1, b: 2 })
// r: ApiResult = { success: boolean; data: T | null; error: string | null }
if (r.success) {
  // r.data = { result: 3 }
} else {
  // r.error 为失败原因
}
```

其他渲染层 API（`window.qihebox.plugins` 完整签名见 `docs/PLUGIN.md` §5.3）：`list()`（含禁用/broken）、`setEnabled(id, bool)`、`install({ filePath })`、`uninstall(id)`、`on(channel, cb)`（订阅插件广播，返回退订函数）。

### 4.4 `storage` / `events` 最小配方

**storage（主进程，状态隔离存储）**：

```ts
export async function activate(host: PluginHost) {
  // 写入 userData/plugins/<id>/state/，与本体存储完全隔离；全异步
  await host.storage.set('greeting.count', 1)
  const n = await host.storage.get('greeting.count') // → 1
  // 边界：单 key ≤ 1MB，总容量 ≤ 64MB（docs/PLUGIN.md §六 规则 2）
}
```

**events（主进程 ↔ 渲染层）**：

```ts
export async function activate(host: PluginHost) {
  // 订阅宿主事件（只能 on，不能 emit 到宿主保留事件；宿主事件如 workspaceChanged）
  const off = host.events.on('workspaceChanged', (data) => {
    host.log('info', '[mytool] workspace changed')
  })
  // 向渲染层广播（channel 必须以本插件 ipcPrefix 开头，防冒充本体事件）
  host.events.emit('mytool.didSomething', { ok: true })

  return { dispose: () => off() } // 停用时退订
}
```

```ts
// 渲染层订阅插件广播
const off = window.qihebox.plugins.on('mytool.didSomething', (data) => { /* … */ })
// 组件卸载时退订：off()
```

---

## 五、契约要点速查

> 完整契约以 `docs/PLUGIN.md` 为准，这里只列你写代码前必须记住的点，不重复抄全文。

- **manifest 九条校验**（`docs/PLUGIN.md` §三，任一失败 → 拒绝安装 / 标记 broken）：① `id` / `ipcPrefix` / `pages[].path` 全局唯一、不冲突；② `kind` 声明与 `pages`/`commands` 字段一致；③ `apiCompat` 与宿主 `API_VERSION` 相交；④ `pages[].path` 以 `/plugin/` 开头、`component` 为包内相对路径；⑤ `transport` 缺省或 `inproc`；⑥ `permissions.network` 合法主机名或 `*`（`*` 须附说明）；⑦ `activation` 的 `onEvent:<channel>` 须以 `ipcPrefix` 开头；⑧ `syncScope` 仅缺省 / `global` / `local`；⑨ `permissions` 子字段类型校验。
- **ApiResult 包装**：所有经 `window.qihebox.plugins.*` 的返回值都是 `{ success, data, error }`，`data` 成功才非空；不要假设裸数据。
- **host 能力白名单**（`docs/PLUGIN.md` §5.1）：`log` / `storage` / `events` / `workspace` / `dialog` / `notify` / `account` / `files` / `entitlement`——没有任意文件读写、没有 shell；`host.files` 是受限读写（`readText`/`readBuffer`/`writeExport`，错误带 `code`，不触发熔断）。
- **权限声明**（`manifest.permissions`，§三）：`network` / `clipboard` / `notification` / `account`，v1 用于管理页展示与安装确认，未来 `transport:'process'` 隔离落地时升级为强制拦截。
- **侧载需开发者模式**：`设置 → 插件 → 开发者模式`（默认关），关闭时 `install({ filePath })` 返回 `DEV_MODE_REQUIRED`（§5.3、§六 规则 6）。
- **通道命名**（§5.4）：插件通道固定 `qihebox:plugin:<ipcPrefix>:<action>`；`qihebox:*` 前缀与 `qihebox:event:*` 为宿主保留，插件不得注册。
- **`.qbox` 包结构**（§二）：zip 容器，根放 `manifest.json`，`main/index.js` 为编译后的主进程入口，`renderer/` 放页面模块（自包含依赖）。

---

## 六、已知边界（诚实说明）

1. **inproc 信任模型**：v1 为进程内加载，插件代码经动态 `import` 进入宿主进程后，技术上拥有与宿主相同的能力（Node API 可达）。「插件只能经 `host` 访问系统」是**架构约定而非技术强制**——与 Obsidian 的公开立场一致。因此侧载插件安装前有通用风险确认框，仅安装信任来源（§六 信任分级）。
2. **CSP 为形式防护**：插件页面以 `import()` 模块加载，Chromium 不对 JS 子资源执行响应头 CSP，故 `Content-Security-Policy` 头目前是**形式防护**，实质隔离依赖未来 `transport:'process'`（v2.7 沙箱化后生效）。
3. **SHA-256 侧载为记录**：安装时做的 SHA-256 校验用于比对官方索引公布的哈希（防篡改/记录来源），**不是**对恶意插件的防护——恶意插件可以自我声明任意哈希。
4. **模块代码常驻**：ESM 模块一经加载无法从 V8 卸载，「停用即释放」指实例/订阅/定时器/IPC 通道全部回收，模块代码常驻、重启后完全释放（§八）。
5. **权限字段先行**：`permissions` v1 只做展示与安装确认，不强制拦截能力（等 `transport:'process'` 隔离落地）。

---

*本样板随 v2.5 发布；协议问题与不符之处，到公开仓库提 issue。*
