/**
 * 一致性套件 · Playwright `_electron` spec（v2.5，PLAN-v2.5-测试.md §四 Task 4）。
 *
 * 第三方插件作者可用的「协议一致性体检」：manifest 校验 → 侧载安装 → 握手 → 页面/IPC/命令抽查 →
 * host API 语义往返 → 禁用 → 卸载清场。全程 manifest 驱动（插件 id / 能力声明一律读自 .qbox 内
 * manifest.json，不预设插件内部名）。
 *
 * 基建照抄 tests/e2e/plugins.spec.ts：launch（QIHEBOX_E2E=1 隔离 userData）+ killApp 组杀（SIGKILL 负 PID
 * 杀进程组）+ beforeAll/afterAll 清场（卸载全部 + devMode 关回），防串行残留污染（workers:1）。
 *
 * 目标插件：CONFORMANCE_PLUGIN env（run-conformance.mjs 注入绝对路径）；缺省 = out/plugins/com.qihe.hello.qbox。
 *
 * host API 自证约定（README §“各步骤含义”详述）：
 *   - 声明 ipc 的插件可暴露 `conformance.selfTest`（返回 { ok, checks }，覆盖 storage/files/account/notify/
 *     entitlement/workspace 全量往返）→ spec 步骤 e 逐项断言；未实现则回退 hello 教学动作 `ping`，并跳过步骤 e。
 *   - 暴露 `conformance.emit`（host.events.emit）→ spec 在渲染层经 window.qihebox.plugins.on 订阅并断言收到。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { validateManifest } from '../../../src/plugins/types'
import type { PluginManifest } from '../../../src/plugins/types'
import { readManifestFromQbox } from './helpers'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 目标插件路径（run-conformance.mjs 注入 CONFORMANCE_PLUGIN；缺省 hello 默认路径） */
const PLUGIN_QBOX = process.env.CONFORMANCE_PLUGIN
  ? path.resolve(process.env.CONFORMANCE_PLUGIN)
  : path.join(ROOT, 'out', 'plugins', 'com.qihe.hello.qbox')

/** 自测约定动作名 */
const SELF_TEST_ACTION = 'conformance.selfTest'
/** events 自证动作名（host.events.emit → 渲染层 plugins.on） */
const EMIT_ACTION = 'conformance.emit'
/** 页面错误回退文案（页面加载/渲染失败时的负向排除标记） */
const PAGE_ERROR_TEXTS = [
  '插件页面加载失败',
  '插件页面渲染失败',
  '插件页面模块缺少默认导出组件',
  '插件页面模块路径非法',
]

/** conformance.selfTest 返回的 checks 结构（宽松声明，逐项断言时判空） */
interface SelfTestChecks {
  storage?: { ok?: boolean; value?: unknown; error?: string }
  files?: { ok?: boolean; content?: string; error?: string }
  account?: { token?: string | null; isLoggedIn?: boolean; error?: string }
  notify?: { ok?: boolean; returned?: unknown; error?: string }
  entitlement?: { tier?: string; expiresAt?: string | null; quota?: unknown; error?: string }
  workspace?: { path?: string | null; error?: string }
}

test.describe('插件协议一致性体检（conformance）', () => {
  let app: ElectronApplication
  let page: Page
  let manifestRaw: unknown
  let manifestValid: boolean
  let validateErrors: string[]
  let manifest: PluginManifest | null

  const launchApp = async (): Promise<void> => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  }

  /** 组杀：SIGKILL 负 PID 杀进程组，再 app.close()（照抄 plugins.spec.ts） */
  const killApp = async (): Promise<void> => {
    if (!app) return
    try {
      process.kill(-app.process().pid!, 'SIGKILL')
    } catch {
      try {
        process.kill(app.process().pid!, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
  }

  const gotoRoute = (route: string) =>
    page.evaluate((r) => {
      window.history.pushState({}, '', r)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, route)

  const setDevMode = (enabled: boolean) =>
    page.evaluate(async (v) => (window as any).qihebox.settings.setDevMode(v), enabled)

  const listPlugins = () => page.evaluate(async () => (window as any).qihebox.plugins.list())

  test.beforeAll(async () => {
    // 步骤 a（不依赖 electron）：读 .qbox 内 manifest.json + validateManifest 校验规则①–⑨
    const { raw } = await readManifestFromQbox(PLUGIN_QBOX)
    manifestRaw = raw
    const v = validateManifest(raw)
    manifestValid = v.ok
    validateErrors = v.errors
    manifest = v.ok ? (raw as PluginManifest) : null
    await launchApp()
  })

  test.afterAll(async () => {
    // 清场：卸载全部插件 + devMode 关回（跨运行残留防护，同 plugins.spec.ts）+ 组杀进程
    try {
      const list = await page.evaluate(async () => (window as any).qihebox.plugins.list())
      for (const p of (list?.data ?? []) as Array<{ id: string }>) {
        await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), p.id)
      }
      await page.evaluate(async () => (window as any).qihebox.settings.setDevMode(false))
    } catch {
      /* 应用可能已退出 */
    }
    await killApp()
  })

  test('一致性体检全流程', async () => {
    await test.step('a. manifest 校验（validateManifest 规则①–⑨）', async () => {
      if (manifestValid) {
        console.log(`[conformance] manifest 校验通过：${manifest!.id}@${manifest!.version}`)
      } else {
        console.log(`[conformance] manifest 校验未通过（${validateErrors.length} 条）：${validateErrors.join('；')}`)
      }
    })

    if (!manifestValid) {
      // —— 负路径：断言宿主正确拒绝安装（清单校验失败） ——
      const badId = (manifestRaw as { id?: string })?.id ?? ''
      await test.step('负路径：devMode 开 → 安装被拒绝（清单校验失败，命中具体规则）', async () => {
        await setDevMode(true)
        const ins = await page.evaluate(
          async (p) => (window as any).qihebox.plugins.install({ filePath: p }),
          PLUGIN_QBOX,
        )
        expect(ins.success).toBe(false)
        const errText = String(ins.error)
        expect(errText).toContain('清单校验失败')
        // 错误信息命中具体规则关键词（transport / syncScope / apiCompat / permissions / pages / commands 等）
        expect(errText.match(/transport|syncScope|apiCompat|permissions|activation|pages|commands|ipcPrefix|kind/i)).toBeTruthy()
      })
      await test.step('负路径：清单不残留该插件（拒绝安装 = 未登记）', async () => {
        const list = await listPlugins()
        expect(list.data.some((p: any) => p.id === badId)).toBe(false)
      })
      await test.step('负路径：devMode 关回', async () => {
        await setDevMode(false)
      })
      return
    }

    // —— 正路径 ——
    const id = manifest!.id
    const declaredIpc = manifest!.kind.includes('ipc')
    const declaredPages = manifest!.pages ?? []
    const declaredCommands = manifest!.commands ?? []

    await test.step('b. devMode 开 → 侧载安装 → 管理页出现、无 broken', async () => {
      await setDevMode(true)
      // 跨 spec 共享 e2e userData（$TMPDIR/qihebox-e2e-userdata）：前序 spec
      // 可能残留同 id 已安装插件 → install 抛「插件已安装」。先卸载兜底。
      await page.evaluate(async (pid) => (window as any).qihebox.plugins.uninstall(pid), id).catch(() => {})
      const ins = await page.evaluate(
        async (p) => (window as any).qihebox.plugins.install({ filePath: p }),
        PLUGIN_QBOX,
      )
      expect(ins.success).toBe(true)
      expect(ins.data.id).toBe(id)
      const list = await listPlugins()
      const info = list.data.find((p: any) => p.id === id)
      expect(info).toBeTruthy()
      expect(info.state).not.toBe('broken')
    })

    await test.step('c. 握手：列表可见且状态 enabled（broken 则 fail 并输出原因）', async () => {
      const list = await listPlugins()
      const info = list.data.find((p: any) => p.id === id)
      expect(info, '插件应在清单中可见').toBeTruthy()
      if (info.state === 'broken') {
        throw new Error(`插件 broken：${info.brokenReason ?? '未知原因'}`)
      }
      expect(info.state).toBe('enabled')
    })

    await test.step('前置：创建工作区（host.files / host.workspace 语义往返依赖）', async () => {
      const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'conformance-ws-'))
      const r = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
      expect(r.success).toBe(true)
    })

    // —— d. 能力抽查（manifest 驱动）——
    if (declaredPages.length > 0) {
      await test.step('d. pages 可达（导航 + 内容非空，manifest 驱动）', async () => {
        for (const p of declaredPages) {
          await gotoRoute(p.path)
          // 等待插件模块动态 import 完成（「加载中」消失；即时完成则本就为 0）
          await expect(page.locator('main').getByText('插件页面加载中', { exact: false })).toHaveCount(0, {
            timeout: 15000,
          })
          const mainText = (await page.locator('main').innerText()) ?? ''
          for (const err of PAGE_ERROR_TEXTS) {
            expect(mainText, `页面 ${p.path} 不应出现错误回退`).not.toContain(err)
          }
          expect(mainText.trim().length, `页面 ${p.path} 内容非空`).toBeGreaterThan(0)
        }
      })
    }

    if (declaredCommands.length > 0) {
      await test.step('d. commands 注册存在（manifest 驱动）', async () => {
        const list = await listPlugins()
        const info = list.data.find((p: any) => p.id === id)
        expect(info?.commands).toBeTruthy()
        const cmdIds = ((info?.commands ?? []) as Array<{ id: string }>).map((c) => c.id)
        for (const c of declaredCommands) {
          expect(cmdIds, `命令 ${c.id} 应已注册`).toContain(c.id)
        }
      })
    }

    let selfTestData: { ok?: boolean; checks?: SelfTestChecks } | null = null
    if (declaredIpc) {
      await test.step('d. ipc 往返（conformance.selfTest 或 ping 回退）', async () => {
        const selfTest = await page.evaluate(
          async (args) => (window as any).qihebox.plugins.call(args.id, args.action, {}),
          { id, action: SELF_TEST_ACTION },
        )
        if (selfTest.success) {
          selfTestData = selfTest.data as { ok?: boolean; checks?: SelfTestChecks }
          expect(selfTestData.ok, 'conformance.selfTest 往返成功').toBe(true)
          return
        }
        // 未实现自测约定 → 回退 hello 教学动作 ping（hello 是默认目标）
        const ping = await page.evaluate(
          async (args) => (window as any).qihebox.plugins.call(args.id, 'ping', { text: 'conformance-probe' }),
          { id },
        )
        if (ping.success) {
          expect(ping.data.echo, 'ping 往返回显一致').toBe('conformance-probe')
          return
        }
        console.log(
          '[conformance] 插件声明 ipc 但未提供 conformance.selfTest / ping 动作，跳过 IPC 往返（第三方插件可自行实现自测约定）',
        )
      })
    }

    // —— e. host API 语义往返（仅当插件提供自测动作；hello 未实现 → 跳过）——
    await test.step('e. host API 语义往返（自证）', async () => {
      if (!selfTestData) {
        console.log('[conformance] 插件未提供 conformance.selfTest 自测动作，跳过 host API 语义往返')
        return
      }
      const checks = selfTestData.checks ?? {}
      expect(checks.storage?.ok, 'storage set→get 一致').toBe(true)
      expect(checks.files?.ok, 'files writeExport→读回一致').toBe(true)
      expect(checks.account?.error).toBeUndefined()
      expect(typeof checks.account?.isLoggedIn, 'account 接真实服务（声明 account 权限）').toBe('boolean')
      expect(checks.account?.isLoggedIn, 'e2e 未登录态 isLoggedIn=false').toBe(false)
      expect(checks.account?.token, 'e2e 未登录态 token=null').toBeNull()
      expect(checks.notify?.ok, 'notify 返回布尔').toBe(true)
      expect(checks.entitlement?.error).toBeUndefined()
      expect(checks.entitlement?.tier, 'entitlement 恒 free').toBe('free')
      expect(checks.entitlement?.expiresAt).toBeNull()
      expect(checks.entitlement?.quota).toBeNull()
      expect(typeof checks.workspace?.path, 'workspace.currentPath 非空').toBe('string')
      expect((checks.workspace?.path ?? '').length).toBeGreaterThan(0)
    })

    // —— e2. events 往返（emit → 渲染层 on 收到；仅当声明 ipc 且插件提供 conformance.emit）——
    if (declaredIpc) {
      await test.step('e. events 往返（host.events.emit → 渲染层 plugins.on 收到）', async () => {
        const channel = `${manifest!.ipcPrefix}:conformance-events`
        const payload = `conformance-events-${Date.now()}`
        // 先订阅（渲染层挂监听），再触发插件 emit，最后断言收到
        await page.evaluate(async (ch) => {
          const qb = (window as any).qihebox
          ;(window as any).__conformanceEventPromise = new Promise((resolve: (v: unknown) => void) => {
            const unsub = qb.plugins.on(ch, (data: unknown) => {
              unsub()
              resolve(data)
            })
          })
        }, channel)
        const emitRes = await page.evaluate(
          async (args) =>
            (window as any).qihebox.plugins.call(args.id, args.action, { channel: args.channel, data: args.data }),
          { id, action: EMIT_ACTION, channel, data: payload },
        )
        if (emitRes.success) {
          const got = await page.evaluate(async () => (window as any).__conformanceEventPromise)
          expect(got, '渲染层应收到插件广播事件').toBe(payload)
        } else {
          console.log('[conformance] 插件未提供 conformance.emit 动作，跳过 events 往返')
        }
      })
    }

    // —— e3. 覆盖安装（2026-08-16 方案 A）：同包重装 → 成功、state/ 保留、IPC 恢复 ——
    await test.step('e3. 覆盖安装（同包重装）→ 成功、state/ 保留、IPC 恢复', async () => {
      const stateDir = path.join(os.tmpdir(), 'qihebox-e2e-userdata', 'plugins', id, 'state')
      const hadState = fs.existsSync(stateDir)
      const before = hadState ? fs.readdirSync(stateDir).sort() : []
      const ins = await page.evaluate(
        async (p) => (window as any).qihebox.plugins.install({ filePath: p }),
        PLUGIN_QBOX,
      )
      expect(ins.success, '同 id 覆盖安装应成功（不再抛「插件已安装」）').toBe(true)
      expect(ins.data.id).toBe(id)
      const after = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).sort() : []
      if (hadState) {
        expect(after, 'state/ 应完整保留（覆盖安装不丢数据）').toEqual(before)
      }
      // 覆盖后旧实例已停用、新实例重新激活 → IPC 往返恢复
      const selfTest = await page.evaluate(
        async (args) => (window as any).qihebox.plugins.call(args.id, args.action, {}),
        { id, action: SELF_TEST_ACTION },
      )
      if (!selfTest.success) {
        const ping = await page.evaluate(
          async (args) => (window as any).qihebox.plugins.call(args.id, 'ping', { text: 'after-replace' }),
          { id },
        )
        expect(ping.success, '覆盖安装后 IPC 应恢复可调用').toBe(true)
      }
    })

    // —— f. 禁用 → 卸载 → 清场 ——
    await test.step('f. 禁用 → 卸载 → 清单清空（state/ 一并删除）', async () => {
      const stateDir = path.join(os.tmpdir(), 'qihebox-e2e-userdata', 'plugins', id, 'state')
      const off = await page.evaluate(async (pid) => (window as any).qihebox.plugins.setEnabled(pid, false), id)
      expect(off.success).toBe(true)
      const list = await listPlugins()
      expect(list.data.find((p: any) => p.id === id).state).toBe('disabled')
      const rm = await page.evaluate(async (pid) => (window as any).qihebox.plugins.uninstall(pid), id)
      expect(rm.success).toBe(true)
      const list2 = await listPlugins()
      expect(list2.data.some((p: any) => p.id === id)).toBe(false)
      expect(fs.existsSync(stateDir), '卸载应删除 state/（卸载 = 彻底清除语义不变）').toBe(false)
    })
  })
})
