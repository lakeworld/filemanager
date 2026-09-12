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
 *
 * v2.5.8 复审 A-5（D9-D12 r2）：两条写路径（`set` / `setDevMode`）一律走 `core/jsonStore` 的
 * `mutateJsonFile`——读—改—写整体在**按路径串行锁**内完成，且损坏文件先隔离成
 * `settings.json.corrupt-<ts>` 留证再抛错。此前直接 `writeJsonAtomic` 有两处后果：
 * 同文件并发写各自基于「锁外旧快照」合并会丢更新；坏 json 被当空设置整体覆盖、用户偏好无声清零。
 * 只读路径（`getAll` / `getDevMode`）仍是同步容错：损坏 → 回落默认、**不移动文件**，
 * 与 `core/paths.ts` `readJsonFile` 的「只读不破坏现场」口径一致（留证由写路径负责）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { mutateJsonFile } from './core/jsonStore'
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

/** 形态闸门：数组 / null / 非对象一律不认（只读侧当空设置，写侧当损坏） */
function asSettingsFile(value: unknown): AppSettingsFile | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AppSettingsFile) : null
}

export function createSettings(userDataDir: string): SettingsService {
  const settingsPath = path.join(userDataDir, 'settings.json')

  function read(): AppSettingsFile {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8')
      return asSettingsFile(JSON.parse(raw) as unknown) ?? {}
    } catch {
      // 缺失/损坏 → 默认（不阻塞启动；留证与拒绝覆盖归写路径）
    }
    return {}
  }

  /**
   * 唯一写盘入口：读 → 合并 → 落盘整段跑在 `jsonStore.mutateJsonFile` 的按路径串行锁里。
   * 两件事一次做掉：① 同文件并发写不再各自基于「锁外旧快照」合并（丢更新）；
   * ② 磁盘上那份不是合法设置形状（坏 json / 数组 / 非对象）时，jsonStore 先把它改名隔离成
   * `settings.json.corrupt-<ts>` 留证，再抛错**拒绝覆盖**——绝不拿默认值静默清空用户偏好。
   * 缺文件才按空形状起步（= 读侧的全默认），这与 metadata/customers/invoices 等共享 JSON 同一条纪律。
   */
  function mutateFile(merge: (stored: AppSettingsFile) => AppSettingsFile): Promise<AppSettingsFile> {
    return mutateJsonFile<AppSettingsFile, AppSettingsFile>(settingsPath, {
      read: async () => ({}),
      validate: asSettingsFile,
      mutate: (stored) => {
        const next = merge(stored)
        // jsonStore 落盘的是它读到的那个对象，所以原地换键、不能换引用
        const bag = stored as Record<string, unknown>
        for (const key of Object.keys(bag)) delete bag[key]
        Object.assign(bag, next)
        return stored
      },
      save: async () => true,
    })
  }

  return {
    getDevMode(): boolean {
      return read().devMode === true
    },
    async setDevMode(enabled: boolean): Promise<void> {
      await mutateFile((stored) => ({ ...stored, devMode: !!enabled }))
    },
    getAll(): AppSettings {
      return resolveAppSettings(read())
    },
    async set(patch: AppSettingsPatch): Promise<AppSettings> {
      const written = await mutateFile((stored) => mergeAppSettings(stored, patch))
      return resolveAppSettings(written)
    },
  }
}
