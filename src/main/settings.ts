/**
 * userData 级用户设置（v2.5 增量，PLAN §3.5）：
 * 开发者模式（devMode）——侧载插件导入入口的开关（默认关，userData/settings.json 持久化，重启保持）。
 * 不用工作区 config：插件安装是 userData 级全局行为，工作区 config 会被共享工作区携带。
 * IPC 通道（qihebox:settings:getDevMode / setDevMode）在装配层（src/main/index.ts）注册，本模块只做读写。
 * 纯 TS（不 import electron，userData 目录由装配层注入），可在 node 环境直接测试。
 *
 * v2.5.8（D11 / W7）设置页扩充：**沿用本模块既有形状扩键，零新存储文件、IPC 只加两条**——
 * 形态 / 默认值 / 归一与合并全在 `src/shared/appSettings.ts`（唯一真相，三端共读），
 * 本文件只做落盘与读取。新增应用级开关只需改 shared 那一处，不再新增一键一对的通道。
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from './core/paths'
import {
  type AppSettings,
  type AppSettingsFile,
  type AppSettingsPatch,
  mergeAppSettings,
  resolveAppSettings,
} from '../shared/appSettings'

/** 兼容既有调用方与测试的类型别名（形状真相在 shared/appSettings.ts） */
export type UserSettings = AppSettingsFile

export interface SettingsService {
  /** 开发者模式是否开启（默认 false）——v2.5 既有签名，保留给插件侧载与既有测试 */
  getDevMode(): boolean
  /** 设置开发者模式并落盘（幂等）——同上，保留既有签名 */
  setDevMode(enabled: boolean): Promise<void>
  /** W7：全量读取（按默认值归一，脏数据不改变行为） */
  getAll(): AppSettings
  /** W7：局部写入并落盘，返回写入后的全量值（与 setDevMode 同一「先落盘再返回」纪律） */
  set(patch: AppSettingsPatch): Promise<AppSettings>
}

export function createSettings(userDataDir: string): SettingsService {
  const settingsPath = path.join(userDataDir, 'settings.json')

  function read(): AppSettingsFile {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8')
      return resolveRawJson(raw)
    } catch {
      // 缺失/损坏 → 默认（不阻塞启动）
    }
    return {}
  }

  return {
    getDevMode(): boolean {
      return read().devMode === true
    },
    async setDevMode(enabled: boolean): Promise<void> {
      const settings = read()
      settings.devMode = !!enabled
      await writeJsonAtomic(settingsPath, settings)
    },
    getAll(): AppSettings {
      return resolveAppSettings(read())
    },
    async set(patch: AppSettingsPatch): Promise<AppSettings> {
      const next = mergeAppSettings(read(), patch)
      await writeJsonAtomic(settingsPath, next)
      return resolveAppSettings(next)
    },
  }
}

/** JSON.parse 后仍要过一道形态闸门（数组 / null / 非对象一律当空设置，交给 resolve 兜默认） */
function resolveRawJson(raw: string): AppSettingsFile {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as AppSettingsFile
  } catch {
    // 坏 json → 空设置（resolve 兜默认）
  }
  return {}
}
