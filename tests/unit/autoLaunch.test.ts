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
  autostartDir,
  buildDesktopEntry,
  desktopEntryPath,
  isAutoLaunchMode,
} from '../../src/main/core/autoLaunch'

/** 平台薄壳依赖 electron —— 单测 mock 掉（electron 包在纯 node 下 require 返回二进制路径，不可用） */
const { setLoginItemSettings, getLoginItemSettings } = vi.hoisted(() => ({
  setLoginItemSettings: vi.fn(),
  getLoginItemSettings: vi.fn(() => ({ openAtLogin: false, wasOpenedAtLogin: false })),
}))
vi.mock('electron', () => ({
  app: {
    setLoginItemSettings,
    getLoginItemSettings,
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
})

describe('平台薄壳（autoLaunchMain，mock electron，platform 参数化）', () => {
  let xdg: string
  beforeEach(() => {
    xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'autolaunch-'))
    process.env.XDG_CONFIG_HOME = xdg
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
