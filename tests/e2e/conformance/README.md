# 一致性套件（conformance）

对任意插件做**协议一致性体检**：`manifest 校验 → 侧载安装 → 握手 → 页面 / IPC / 命令抽查 → host API 语义往返 → 禁用 → 卸载清场`。第三方插件作者无需懂宿主内部实现，5 分钟即可跑通并读懂报告。

## 5 分钟上手

```bash
# 1. 构建插件为 .qbox（详见下节「.qbox 打包指引」）
node scripts/build-hello-plugin.mjs --src <你的插件目录> --out /tmp/my-plugin

# 2. 跑体检（套件会自动构建内置夹具 + 启动 Playwright Electron）
npm run conformance -- /tmp/my-plugin/com.example.demo.qbox

# 3. 读报告：每步 pass/fail 明细逐条输出；退出码 0 = 全部通过，非 0 = 有失败项
```

- 未传参数时默认体检 `out/plugins/com.qihe.hello.qbox`（教学样板，`npm run preconformance` 已构建）。
- 也支持传**插件目录**（需含 `manifest.json`，套件现场打包为临时 .qbox）：

```bash
npm run conformance -- /path/to/plugin-src
```

## .qbox 打包指引

`.qbox` 是 zip 容器，包内结构：

```
<plugin-id>.qbox (zip)
├── manifest.json      # 清单（JSON，字段见 docs/PLUGIN.md §三）
├── main/index.js      # 主进程入口：export async function activate(host)（CJS：module.exports = { activate } 亦可）
└── renderer/          # 可选：页面模块（自包含，组件 = 模块默认导出）
```

- 官方教学样板与打包脚本参考 `src/plugins/hello/` + `scripts/build-hello-plugin.mjs`（esbuild 打包 TS/JS + 手写 zip 容器）。
- 纯 JS 插件可直接用 `scripts/build-conformance-fixtures.mjs` 里的 `packPluginDir`（复用 hello 的 `packQbox`）把目录打包为 .qbox，无需 esbuild。
- 宿主安装时做 JSON Schema + SHA-256 校验，规则①–⑨ 任一失败 → 拒绝安装 / 标记 broken（负路径，见下）。

## 各步骤含义

| 步骤 | 断言 | 说明 |
|---|---|---|
| a. manifest 校验 | `validateManifest` 规则①–⑨ | 读 .qbox 内 manifest.json 逐条校验（id / ipcPrefix / apiCompat / transport / syncScope / permissions / pages / commands / activation） |
| b. 侧载安装 | devMode 开 → 安装成功、无 broken | 负路径（manifest 非法）→ 断言宿主**拒绝安装**并报「清单校验失败」 |
| c. 握手 | 清单可见且 `state=enabled` | broken 则直接 fail 并输出 `brokenReason` |
| d. 能力抽查 | 按 manifest 声明驱动 | 声明 `pages` → 导航 + 内容非空；声明 `ipc` → 至少一个 action 往返；声明 `commands` → 命令注册存在 |
| e. host API 语义往返 | 真实调用（非“方法存在”空断言） | 见下「host API 自证约定」 |
| f. 清场 | 禁用 → 卸载 → 清单清空 + devMode 关回 | 组杀进程、无残留 |

## host API 自证约定（可选实现）

要让步骤 e 覆盖 host API 语义往返，插件可在 `activate(host)` 返回的 `registration.ipc` 里暴露**两个约定动作**（动作名固定，与插件内部名无关）：

```js
module.exports = {
  async activate(host) {
    return {
      ipc: {
        // 覆盖 storage / files / account / notify / entitlement / workspace 的全量自证
        'conformance.selfTest': async () => {
          const key = 'roundtrip'; const value = { n: 42 }
          await host.storage.set(key, value)
          const got = await host.storage.get(key)
          // files：writeExport 后经 readText('导出/<id>_<fileName>') 读回
          await host.files.writeExport('x.txt', 'hi')
          const readBack = await host.files.readText('导出/<你的id>_x.txt')
          return {
            ok: true,
            checks: {
              storage: { ok: JSON.stringify(got) === JSON.stringify(value) },
              files: { ok: readBack === 'hi' },
              account: { token: host.account.getToken(), isLoggedIn: host.account.isLoggedIn() },
              notify: { ok: typeof host.notify('t', 'b') === 'boolean' },
              entitlement: host.entitlement.status(),   // { tier:'free', expiresAt:null, quota:null }
              workspace: { path: host.workspace.currentPath() },
            },
          }
        },
        // events 往返：host.events.emit → 渲染层 window.qihebox.plugins.on 收到
        'conformance.emit': async (payload) => {
          host.events.emit(String(payload.channel), payload.data)
          return { ok: true }
        },
      },
    }
  },
}
```

未实现这两个动作不影响 a–d / f 步骤（`ipc` 声明时套件回退 hello 的 `ping` 动作做基础往返）；实现后步骤 e 才会全量断言 host API 语义。

## 内置夹具

| 夹具 | 路径（构建后） | 用途 |
|---|---|---|
| `com.qihe.conformance.bad` | `out/plugins/com.qihe.conformance.bad.qbox` | **负路径**：`transport: 'http'`（非法）→ 断言宿主拒绝安装 |
| `com.qihe.conformance.full` | `out/plugins/com.qihe.conformance.full.qbox` | **正路径全覆盖**：声明 pages+ipc+commands+全权限，实现 `conformance.selfTest` / `conformance.emit` |

> 注：插件 `id` 仅允许小写字母/数字/点（`validateManifest` 规则①，连字符非法），故夹具 id 用点分 `conformance.bad` / `conformance.full`（任务示例名中的连字符形为示意，不合法）。

夹具源码在 `tests/e2e/conformance/fixtures/`（纯 JS，无 esbuild），由 `scripts/build-conformance-fixtures.mjs` 构建，**不进 `src/plugins`**。

## 环境要求

- 需要能启动 Electron 图形环境（本地桌面或 `xvfb-run`；CI 用 `xvfb-run`）。
- 需要 `out/` 已构建（`npm run build`；插件宿主在 `out/main` 里）。干净环境示例：

```bash
env -i PATH=$PATH HOME=/tmp/qh-home PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright DISPLAY=:0 \
  npm run conformance -- out/plugins/com.qihe.conformance.full.qbox
```
