/**
 * 开机自启单测（v2.4.9 S4）：
 * 1. core/autoLaunch.ts 纯函数（node 直测，不依赖 electron）
 * 2. 平台薄壳 autoLaunchMain.ts 三分支（vi.mock electron + platform 参数化注入）
 * 3. 防漂移静态锚定：AUTOSTART_ARGS 与 electron-builder.yml linux.executableArgs、
 *    scripts/measure-memory.mjs PROD_ARGS 三处逐字一致（builder.yml/mjs 无法 import TS，
 *    运行期自校验空转——静态锚定是防漂移唯一手段；AGENTS §六 参数同步硬规则由两处扩为三处）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUTOSTART_ARGS,
  UNPACKED_AUTOLAUNCH_MESSAGE,
  autostartDir,
  buildDesktopEntry,
  desktopEntryPath,
  entryOwnedByExec,
  isAutoLaunchMode,
  resolveAutoLaunchTarget,
} from '../../src/main/core/autoLaunch'

/** 平台薄壳依赖 electron —— 单测 mock 掉（electron 包在纯 node 下 require 返回二进制路径，不可用） */
const { setLoginItemSettings, getLoginItemSettings, appState } = vi.hoisted(() => ({
  setLoginItemSettings: vi.fn(),
  getLoginItemSettings: vi.fn(() => ({ openAtLogin: false, wasOpenedAtLogin: false })),
  /** 可变打包态：isPackaged 用 getter 暴露，逐例翻转（mock 工厂只求值一次，故不能写死属性值） */
  appState: { isPackaged: true },
}))
vi.mock('electron', () => ({
  app: {
    setLoginItemSettings,
    getLoginItemSettings,
    get isPackaged() {
      return appState.isPackaged
    },
  },
}))

import { isAutoLaunch, isMacAutostartLaunch, setAutoLaunch } from '../../src/main/autoLaunchMain'

/** 仓库根（tests/unit → 上两级的 package.json 所在目录） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
/** AUTOSTART_ARGS 去掉 --autostart = builder.yml / measure-memory.mjs 中的五参（防漂移比对基准） */
const EXPECTED_ARGS = AUTOSTART_ARGS.filter((a) => a !== '--autostart')

describe('core/autoLaunch 纯函数', () => {
  it('isAutoLaunchMode 双来源：argv 含 --autostart → true；env QIHEBOX_AUTOSTART=1 → true；都无 → false', () => {
    expect(isAutoLaunchMode(['--autostart'], {})).toBe(true)
    expect(isAutoLaunchMode(['--no-sandbox', '--autostart'], {})).toBe(true)
    expect(isAutoLaunchMode([], { QIHEBOX_AUTOSTART: '1' })).toBe(true)
    expect(isAutoLaunchMode(['--no-sandbox'], { QIHEBOX_AUTOSTART: '0' })).toBe(false)
    expect(isAutoLaunchMode([], {})).toBe(false)
    expect(isAutoLaunchMode(['--autostart-x'], {})).toBe(false) // 前缀相似不误命中
  })

  it('autostartDir：XDG_CONFIG_HOME 有 → 用之；无/空 → ~/.config', () => {
    expect(autostartDir({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/u')).toBe('/tmp/xdg')
    expect(autostartDir({}, '/home/u')).toBe(path.join('/home/u', '.config'))
    // XDG 规范：空串视为未设置，回退 ~/.config
    expect(autostartDir({ XDG_CONFIG_HOME: '' }, '/home/u')).toBe(path.join('/home/u', '.config'))
  })

  it('desktopEntryPath = autostartDir + 启禾文件管理.desktop', () => {
    expect(desktopEntryPath({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/u')).toBe(
      path.join('/tmp/xdg', 'autostart', '启禾文件管理.desktop'),
    )
    expect(desktopEntryPath({}, '/home/u')).toBe(path.join('/home/u', '.config', 'autostart', '启禾文件管理.desktop'))
  })

  it('buildDesktopEntry：Type/Name/Exec 全量参数 + 路径空格双引号 + X-GNOME-Autostart-enabled', () => {
    const execPath = '/home/u/我的 文件夹/qihe-box'
    const content = buildDesktopEntry(execPath)
    expect(content).toContain('[Desktop Entry]')
    expect(content).toContain('Type=Application')
    expect(content).toContain('Name=启禾文件管理')
    expect(content).toContain('X-GNOME-Autostart-enabled=true')
    // Exec 行整体逐字断言：双引号包裹路径 + AUTOSTART_ARGS 全量（防漂移核心断言）
    const execLine = content.split('\n').find((l) => l.startsWith('Exec='))
    expect(execLine).toBe(`Exec="${execPath}" ${AUTOSTART_ARGS.join(' ')}`)
    // 普通路径同样恒双引号（写入薄壳统一形态，不做有空格才引的条件分支）
    expect(buildDesktopEntry('/opt/qihe-box').split('\n').find((l) => l.startsWith('Exec='))).toBe(
      'Exec="/opt/qihe-box" ' + AUTOSTART_ARGS.join(' '),
    )
  })

  it('buildDesktopEntry 桌面项字段齐备：Icon/Terminal/StartupWMClass/Categories/Comment（与安装器 qihe-box.desktop 同口径）', () => {
    const content = buildDesktopEntry('/opt/启禾文件管理/qihe-box')
    // 缺 Icon → DE 启动项面板显示成通用齿轮；缺 Terminal=false → 部分 DE 会按终端程序处理
    expect(content).toContain('Icon=qihe-box')
    expect(content).toContain('Terminal=false')
    expect(content).toContain('StartupWMClass=qihe-box')
    expect(content).toContain('Categories=Office;')
    expect(content).toContain('Name=启禾文件管理')
    expect(content).toContain('Type=Application')
  })
})

describe('resolveAutoLaunchTarget 自启目标解析（v2.5.8 缺陷修：未打包/AppImage 形态）', () => {
  it('AppImage 形态优先取 env.APPIMAGE（execPath 在 /tmp/.mount_* 每次挂载都变，写它重启即失效）', () => {
    expect(
      resolveAutoLaunchTarget({
        env: { APPIMAGE: '/home/user/下载/启禾文件管理-2.5.8.AppImage' },
        execPath: '/tmp/.mount_abc123/启禾文件管理',
        isPackaged: true,
      }),
    ).toBe('/home/user/下载/启禾文件管理-2.5.8.AppImage')
  })

  it('已打包且非 AppImage → process.execPath；APPIMAGE 空串视为未设（XDG 式宽松），不吃空值', () => {
    expect(
      resolveAutoLaunchTarget({ env: {}, execPath: '/opt/启禾文件管理/qihe-box', isPackaged: true }),
    ).toBe('/opt/启禾文件管理/qihe-box')
    expect(
      resolveAutoLaunchTarget({ env: { APPIMAGE: '' }, execPath: '/opt/qihe-box', isPackaged: true }),
    ).toBe('/opt/qihe-box')
  })

  it('未打包（dev / `electron .` 预览实例）→ null：execPath 是 electron 裸二进制、app 路径住在 argv 里，写它登录必弹 Electron 空窗', () => {
    expect(
      resolveAutoLaunchTarget({
        env: {},
        execPath: '/repo/node_modules/electron/dist/electron',
        isPackaged: false,
      }),
    ).toBeNull()
  })

  it('QIHEBOX_AUTOSTART_FORCE=1 开发/测试旁路：未打包也按安装版取 execPath（e2e 验开关链路用），且 APPIMAGE 仍优先', () => {
    expect(
      resolveAutoLaunchTarget({
        env: { QIHEBOX_AUTOSTART_FORCE: '1' },
        execPath: '/repo/node_modules/electron/dist/electron',
        isPackaged: false,
      }),
    ).toBe('/repo/node_modules/electron/dist/electron')
    expect(
      resolveAutoLaunchTarget({
        env: { QIHEBOX_AUTOSTART_FORCE: '1', APPIMAGE: '/home/u/启禾.AppImage' },
        execPath: '/tmp/.mount_x/启禾文件管理',
        isPackaged: false,
      }),
    ).toBe('/home/u/启禾.AppImage')
    // 非 '1' 不放行（旁路只认精确值，防误设 QIHEBOX_AUTOSTART_FORCE=true/0 打开）
    expect(
      resolveAutoLaunchTarget({
        env: { QIHEBOX_AUTOSTART_FORCE: '0' },
        execPath: '/repo/electron',
        isPackaged: false,
      }),
    ).toBeNull()
  })
})

describe('entryOwnedByExec 坏条目归属判定（只清自己写坏的那条，不误删安装版条目）', () => {
  it('Exec 指向该 execPath → true；指向别处 / 内容缺失 → false', () => {
    const dev = '/repo/node_modules/electron/dist/electron'
    expect(entryOwnedByExec(buildDesktopEntry(dev), dev)).toBe(true)
    expect(entryOwnedByExec(buildDesktopEntry('/opt/启禾文件管理/qihe-box'), dev)).toBe(false)
    expect(entryOwnedByExec('', dev)).toBe(false)
  })
})

describe('平台薄壳（autoLaunchMain，mock electron，platform 参数化）', () => {
  let xdg: string
  beforeEach(() => {
    xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'autolaunch-'))
    process.env.XDG_CONFIG_HOME = xdg
    // 逐例复位到「安装版」形态：打包态与 AppImage 变量都会左右自启目标解析
    appState.isPackaged = true
    delete process.env.APPIMAGE
    delete process.env.QIHEBOX_AUTOSTART_FORCE
    setLoginItemSettings.mockClear()
    getLoginItemSettings.mockClear()
  })
  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME
    fs.rmSync(xdg, { recursive: true, force: true })
  })

  it('Linux：setAutoLaunch(true) 写 .desktop（真实文件系统）→ isAutoLaunch true；关 → 文件删除、false', () => {
    const entry = path.join(xdg, 'autostart', '启禾文件管理.desktop')
    expect(fs.existsSync(entry)).toBe(false)
    setAutoLaunch(true, 'linux')
    expect(fs.existsSync(entry)).toBe(true)
    expect(isAutoLaunch('linux')).toBe(true)
    // .desktop 内容与纯函数产物一致（Exec 含 process.execPath + 全量参数）
    expect(fs.readFileSync(entry, 'utf8')).toBe(buildDesktopEntry(process.execPath))
    setAutoLaunch(false, 'linux')
    expect(fs.existsSync(entry)).toBe(false)
    expect(isAutoLaunch('linux')).toBe(false)
    // Linux 分支不触碰 electron 登录项 API
    expect(setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('Windows：setLoginItemSettings 带 path + args [--autostart]；isAutoLaunch 读 openAtLogin', () => {
    setAutoLaunch(true, 'win32')
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: process.execPath,
      args: ['--autostart'],
    })
    getLoginItemSettings.mockReturnValue({ openAtLogin: true, wasOpenedAtLogin: false })
    expect(isAutoLaunch('win32')).toBe(true)
    getLoginItemSettings.mockReturnValue({ openAtLogin: false, wasOpenedAtLogin: false })
    expect(isAutoLaunch('win32')).toBe(false)
  })

  it('macOS：openAsHidden 兜底（args 不可用不写入）；wasOpenedAtLogin 判定自启实例（待验证分支）', () => {
    setAutoLaunch(true, 'darwin')
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, openAsHidden: true })
    getLoginItemSettings.mockReturnValue({ openAtLogin: true, wasOpenedAtLogin: true })
    expect(isAutoLaunch('darwin')).toBe(true)
    // wasOpenedAtLogin 为 macOS 自启实例判定的唯一来源（isMacAutostartLaunch，index.ts 启动分支用）
    expect(isMacAutostartLaunch('darwin')).toBe(true)
    expect(isMacAutostartLaunch('linux')).toBe(false) // 非 mac 平台短路，不调 API
    getLoginItemSettings.mockReturnValue({ openAtLogin: true, wasOpenedAtLogin: false })
    expect(isMacAutostartLaunch('darwin')).toBe(false)
  })

  it('Linux 未打包：开 → 拒写并抛人话（不写坏条目），关 → 静默幂等清掉本实例写坏的那条', () => {
    const entry = path.join(xdg, 'autostart', '启禾文件管理.desktop')
    // 先按安装版形态（beforeEach 已置 isPackaged=true）写一条合法条目，再切未打包
    setAutoLaunch(true, 'linux')
    expect(fs.existsSync(entry)).toBe(true)
    // 未打包实例点「开」：抛人话，且原条目一字未改
    appState.isPackaged = false
    expect(() => setAutoLaunch(true, 'linux')).toThrow(UNPACKED_AUTOLAUNCH_MESSAGE)
    expect(fs.readFileSync(entry, 'utf8')).toContain('Exec="' + process.execPath + '"') // 未被改写
    setAutoLaunch(false, 'linux') // execPath 与条目 Exec 同源 → 判为本实例所有，清掉
    expect(fs.existsSync(entry)).toBe(false)
    // 合法条目属另一个 execPath：未打包实例的「关」不得越权删除
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, buildDesktopEntry('/opt/启禾文件管理/qihe-box'), 'utf8')
    setAutoLaunch(false, 'linux')
    expect(fs.existsSync(entry)).toBe(true)
  })

  it('Linux AppImage 形态：条目 Exec 取 env.APPIMAGE 本体路径，不取挂载点内的 execPath', () => {
    const entry = path.join(xdg, 'autostart', '启禾文件管理.desktop')
    process.env.APPIMAGE = '/home/user/下载/启禾文件管理-2.5.8.AppImage'
    setAutoLaunch(true, 'linux')
    const content = fs.readFileSync(entry, 'utf8')
    expect(content).toContain('Exec="' + process.env.APPIMAGE + '" ' + AUTOSTART_ARGS.join(' '))
    expect(content).not.toContain(process.execPath)
  })

  it('Windows 未打包：开 → 抛人话不写注册表（Run 键指 electron.exe 同样弹空窗）；关 → 仍可撤销（不需目标）', () => {
    appState.isPackaged = false
    expect(() => setAutoLaunch(true, 'win32')).toThrow(UNPACKED_AUTOLAUNCH_MESSAGE)
    expect(setLoginItemSettings).not.toHaveBeenCalled()
    setAutoLaunch(false, 'win32')
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false })
  })
})

describe('防漂移静态锚定（AUTOSTART_ARGS 三处同步：core 常量 / builder.yml / measure-memory.mjs）', () => {
  it('electron-builder.yml linux.executableArgs 与 AUTOSTART_ARGS（去 --autostart）逐字一致', () => {
    const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')
    const lines = yml.split('\n')
    const idx = lines.findIndex((l) => l.trim() === 'executableArgs:')
    expect(idx).toBeGreaterThan(-1) // 段落存在，防锚点漂移
    // 只取 executableArgs 段自身：首个非「4 空格缩进 - 」行或空行即止（win: 段的 - target 不越界收入）
    const block: string[] = []
    for (const l of lines.slice(idx + 1)) {
      if (!l.trim() || !/^\s+- /.test(l)) break
      block.push(l)
    }
    const args = block.map((l) => l.trim().slice(2).trim())
    expect(args).toEqual(EXPECTED_ARGS)
  })

  it('scripts/measure-memory.mjs PROD_ARGS 与 AUTOSTART_ARGS（去 --autostart）逐字一致', () => {
    const mjs = fs.readFileSync(path.join(ROOT, 'scripts', 'measure-memory.mjs'), 'utf8')
    const block = mjs.match(/const PROD_ARGS = \[([\s\S]*?)\]/)?.[1]
    expect(block).toBeDefined() // 常量存在，防锚点漂移
    const args = [...(block as string).matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(args).toEqual(EXPECTED_ARGS)
  })
})
