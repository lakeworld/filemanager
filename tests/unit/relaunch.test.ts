/**
 * 应用内重启单测（v2.6 批 2，`qihebox:app:relaunch`）：
 * 1. core/relaunch.ts 纯判据（node 直测，不依赖 electron）——AppImage / 安装版 / 未打包三分支；
 * 2. 平台薄壳 relaunchMain.ts（vi.mock electron）——**先 app.relaunch(opts) 再 app.quit()** 的调用序与实参。
 *
 * 为什么这两面都要钉：判据错了「重启」会重启成一个不存在的文件（AppImage 的 execPath 住在
 * /tmp/.mount_XXXX 挂载点，每次启动目录名都变），调用序错了就成了「退出但不重启」——
 * 两者都只在真机点一下才暴露，而真机点一下之前没有别的机器判据。
 * 判据复用 core/autoLaunch.ts 的 resolveAutoLaunchTarget（同一份「该执行哪个文件」），
 * 差异只在出口形态（自启写 .desktop / 注册表；重启交 electron app.relaunch）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveRelaunchOptions } from '../../src/main/core/relaunch'

/** 平台薄壳依赖 electron —— 单测 mock 掉（electron 包在纯 node 下 require 返回二进制路径，不可用） */
const { relaunch, quit, appState } = vi.hoisted(() => ({
  relaunch: vi.fn(),
  quit: vi.fn(),
  appState: { isPackaged: true },
}))
vi.mock('electron', () => ({
  app: {
    relaunch,
    quit,
    get isPackaged() {
      return appState.isPackaged
    },
  },
}))

import { relaunchApp } from '../../src/main/relaunchMain'

const APPIMAGE = '/home/user/Apps/启禾文件管理-2.6.0.AppImage'

afterEach(() => {
  delete process.env.APPIMAGE
  delete process.env.QIHEBOX_AUTOSTART_FORCE
  appState.isPackaged = true
  relaunch.mockClear()
  quit.mockClear()
})

describe('core/relaunch 纯判据（AppImage / 安装版 / 未打包）', () => {
  it('AppImage 形态 → execPath 取 env.APPIMAGE，参数沿用原启动参数（argv[0] 不带）', () => {
    expect(
      resolveRelaunchOptions({
        env: { APPIMAGE: APPIMAGE },
        execPath: '/tmp/.mount_qihe7X/启禾文件管理',
        isPackaged: true,
        argv: ['/tmp/.mount_qihe7X/启禾文件管理', '--no-sandbox', '/tmp/x.qbox'],
      }),
    ).toEqual({ execPath: APPIMAGE, args: ['--no-sandbox', '/tmp/x.qbox'] })
  })

  it('已打包非 AppImage（deb / NSIS）→ 空对象 = 交 electron 默认 execPath', () => {
    expect(
      resolveRelaunchOptions({ env: {}, execPath: '/opt/qihe/qihebox', isPackaged: true, argv: ['/opt/qihe/qihebox'] }),
    ).toEqual({})
  })

  it('未打包（开发 / electron . 预览）→ 空对象（同默认，开发期点「立即重启」不会砖）', () => {
    expect(
      resolveRelaunchOptions({ env: {}, execPath: '/usr/bin/electron', isPackaged: false, argv: ['electron', '.'] }),
    ).toEqual({})
  })

  it('APPIMAGE 为空串视为未设置（与自启同一宽松口径）', () => {
    expect(
      resolveRelaunchOptions({ env: { APPIMAGE: '' }, execPath: '/opt/qihe/qihebox', isPackaged: true, argv: ['x'] }),
    ).toEqual({})
  })
})

describe('relaunchMain 薄壳（app.relaunch + app.quit）', () => {
  it('AppImage：app.relaunch({ execPath: env.APPIMAGE, args }) 且**先 relaunch 再 quit**（正常退出路径）', () => {
    process.env.APPIMAGE = APPIMAGE
    relaunchApp()
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(relaunch).toHaveBeenCalledWith({ execPath: APPIMAGE, args: process.argv.slice(1) })
    expect(quit).toHaveBeenCalledTimes(1)
    expect(relaunch.mock.invocationCallOrder[0]).toBeLessThan(quit.mock.invocationCallOrder[0])
  })

  it('安装版：app.relaunch({}) + app.quit()', () => {
    relaunchApp()
    expect(relaunch).toHaveBeenCalledWith({})
    expect(quit).toHaveBeenCalledTimes(1)
    expect(relaunch.mock.invocationCallOrder[0]).toBeLessThan(quit.mock.invocationCallOrder[0])
  })
})