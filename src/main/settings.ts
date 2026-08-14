/**
 * userData 级用户设置（v2.5 增量，PLAN §3.5）：
 * 开发者模式（devMode）——侧载插件导入入口的开关（默认关，userData/settings.json 持久化，重启保持）。
 * 不用工作区 config：插件安装是 userData 级全局行为，工作区 config 会被共享工作区携带。
 * IPC 通道（qihebox:settings:getDevMode / setDevMode）在装配层（src/main/index.ts）注册，本模块只做读写。
 * 纯 TS（不 import electron，userData 目录由装配层注入），可在 node 环境直接测试。
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from './core/paths'

/** userData/settings.json 的持久化形状（v2.5 仅 devMode 一个键，后续键追加不破坏） */
export interface UserSettings {
  devMode?: boolean
}

export interface SettingsService {
  /** 开发者模式是否开启（默认 false） */
  getDevMode(): boolean
  /** 设置开发者模式并落盘（幂等） */
  setDevMode(enabled: boolean): Promise<void>
}

export function createSettings(userDataDir: string): SettingsService {
  const settingsPath = path.join(userDataDir, 'settings.json')

  function read(): UserSettings {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8')
      const parsed = JSON.parse(raw) as UserSettings
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
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
  }
}
