/**
 * Windows 电源广播接线锚定（W0，2026-09-08 Windows 测试约定 Task 1）
 *
 * 背景：v2.5.3 T4 实测 powerMonitor 在 Windows 从不触发 suspend/resume（electron#32576），
 * 系统睡眠唤醒链路的主入口是 window.ts 里的 WM_POWERBROADCAST(0x0218) 原生 hook。
 * 该点位的宿主是 BrowserWindow（window.ts 依赖 electron app/托盘/状态机，单测整链 mock 成本与
 * 脆弱度都不划算），故采「静态锚定 + 纯函数可执行断言」混合式：
 *   - 源码文本锚：hook/unhook 成对存在、平台门正确、解绑确实落在 'closed' 处理内（防窗口销毁后 hook 泄漏）
 *   - 可执行断言：wParam → suspend/resume 归类走真函数 parsePowerBroadcast（Windows 消息语义面）
 * 与 tests/unit/autoLaunch.test.ts §3「防漂移静态锚定」同族手法；wakeup 去重门本身由
 * tests/unit/wake.test.ts 覆盖，此处不重复。
 *
 * 真机侧验证（WM_POWERBROADCAST 是否真被投递） wine 证不了（无真实电源事件源），
 * 已列入 docs/INTERNAL/WIN-真机清单.md。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PBT_APMSUSPEND,
  PBT_APMRESUMEAUTOMATIC,
  PBT_APMRESUMESUSPEND,
  parsePowerBroadcast,
} from '../../src/main/core/wake'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src/main/window.ts'), 'utf8')

/** 源码里写的字面量（勿用 ${0x0218} 模板插值——会被转成十进制 536 而对不上文本） */
const MSG_LITERAL = '0x0218'

/** 构造 hook 回调收到的 wParam（Node Buffer 小端 64 位，parsePowerBroadcast 取低 32 位） */
function wParam(v: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(v))
  return b
}

describe('window.ts WM_POWERBROADCAST 接线（静态锚定）', () => {
  it('hook 与 unhook 成对出现，且都带 0x0218', () => {
    expect(SRC).toContain(`hookWindowMessage(${MSG_LITERAL}`)
    expect(SRC).toContain(`unhookWindowMessage(${MSG_LITERAL}`)
  })

  it('两处平台判定都门在 win32（非 Windows 不该挂原生 hook）', () => {
    const hookAt = SRC.indexOf('mainWindow.hookWindowMessage(')
    const unhookAt = SRC.indexOf('mainWindow.unhookWindowMessage(')
    expect(hookAt).toBeGreaterThan(-1)
    expect(unhookAt).toBeGreaterThan(-1)
    // 向前找最近的 win32 判定：hook 在创建窗口段内、unhook 在 'closed' 段内
    expect(SRC.slice(0, hookAt).lastIndexOf("process.platform === 'win32'")).toBeGreaterThan(-1)
    expect(SRC.slice(0, unhookAt).lastIndexOf("process.platform === 'win32'")).toBeGreaterThan(-1)
    // 文案锚：unhook 必须挂在窗口销毁路径上（注释与代码同段，防被挪进别处）
    const closedAt = SRC.indexOf("mainWindow.on('closed'")
    expect(closedAt).toBeGreaterThan(-1)
    expect(unhookAt).toBeGreaterThan(closedAt)
    expect(SRC.slice(closedAt, unhookAt)).toContain("process.platform === 'win32'")
  })

  it('hook 回调走 parsePowerBroadcast + WakeSignalGate 去重（不直连恢复链）', () => {
    const hookAt = SRC.indexOf('mainWindow.hookWindowMessage(')
    const body = SRC.slice(hookAt, hookAt + 900)
    expect(body).toContain('parsePowerBroadcast(wParam)')
    expect(body).toContain('wakeGate.shouldDispatch(')
    expect(body).toContain("onSystemPause('WM_POWERBROADCAST')")
    expect(body).toContain("onSystemResume('WM_POWERBROADCAST')")
  })
})

describe('WM_POWERBROADCAST wParam 语义（Windows 消息值 → 归类）', () => {
  it('挂起族归 suspend，恢复族归 resume（0x12 自动恢复 / 0x7 恢复信号都要认）', () => {
    expect(parsePowerBroadcast(wParam(PBT_APMSUSPEND))).toBe('suspend')
    expect(parsePowerBroadcast(wParam(PBT_APMRESUMEAUTOMATIC))).toBe('resume')
    expect(parsePowerBroadcast(wParam(PBT_APMRESUMESUSPEND))).toBe('resume')
  })

  it('询问类消息归 none，不得驱动暂停/恢复（0x0 挂起询问 / 0x2 恢复询问 / 0x10 状态）', () => {
    for (const v of [0x0, 0x2, 0x10, 0x9]) {
      expect(parsePowerBroadcast(wParam(v)), `wParam=0x${v.toString(16)}`).toBe('none')
    }
  })

  it('短/畸形 Buffer 不崩且归 none（wParam 长度随 wine/真机 native 层变化）', () => {
    expect(() => parsePowerBroadcast(Buffer.alloc(0))).not.toThrow()
    expect(parsePowerBroadcast(Buffer.alloc(0))).toBe('none')
    expect(parsePowerBroadcast(Buffer.from([0x04, 0x02]))).toBe('none') // 不足 4 字节
    expect(parsePowerBroadcast(Buffer.alloc(4))).toBe('none') // 全零 = 询问类
  })

  it('只取低 32 位：高 32 位脏值不影响归类（native 指针位噪声）', () => {
    const b = Buffer.alloc(8)
    b.writeUInt32LE(PBT_APMSUSPEND, 0)
    b.writeUInt32LE(0xffffffff, 4)
    expect(parsePowerBroadcast(b)).toBe('suspend')
  })
})
