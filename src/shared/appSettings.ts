/**
 * userData 级应用设置（`userData/settings.json`）的**形态 + 默认值 + 归一/合并**（v2.5.8 D11 / W7）。
 *
 * 为什么住 shared：同一份形状要被三端读——main（读写落盘与消费开关）、preload（IPC 契约类型）、
 * renderer（设置页与消费点）。默认值即「该项开关化之前的现行行为」，所以任何一端自己写一份默认值
 * 都是双源漂移，本文件是**唯一真相**。落盘/读取的实现在 `src/main/settings.ts`。
 *
 * 纪律：
 * - 新增键 = 在本文件加一个可选字段 + 一个默认值，**不新增 IPC 通道**（读写走 getAll / set 两通道）；
 * - 落盘只写「与默认值不同」的键，删键即回滚到现行行为；
 * - `resolve` 对脏数据（类型错、档位外、数组、null）一律回落默认，**绝不因脏数据改变行为**。
 */

/** `userData/settings.json` 的持久化形状（全部可选：缺键 = 默认值 = 现行行为，旧文件天然兼容） */
export interface AppSettingsFile {
  /** 开发者模式（v2.5）：侧载插件导入入口。默认关 */
  devMode?: boolean
  /**
   * 关闭主窗口时是否驻留托盘。默认 true = v2.5.3 起的现行行为（关窗仅隐藏、进程常驻）。
   * 关 = 关窗即退出应用。
   */
  closeToTray?: boolean
  /**
   * 是否自动检查更新（启动时 + 每 24h 后台）。默认 true = v2.4.0 起的现行行为。
   * 关 = 不发后台请求；「我的 → 检查更新」的手动入口不受此开关影响。
   */
  autoUpdateCheck?: boolean
  /**
   * 是否显示悬浮多选操作条。默认 true = v2.5.8 D10（W5）的现行形态。
   * 关 = 隐藏浮条；选择态 / Ctrl+A / Delete / Esc 清空等逻辑照旧（只做显隐——
   * 待拍板 #7「关闭后的内嵌双形态回退」未拍板，按「到点未拍板 = 该项不做」执行）。
   */
  selectionBar?: boolean
  /**
   * 剪贴板选区守卫：文件被选中且**正文有非折叠文本选区**时，Ctrl+C 让位给浏览器复制正文。
   * 默认 true = v2.5.7 A1 修复后的现行行为。关 = 文件选中优先（回到 A1 之前的口径）。
   */
  clipboardGuard?: boolean
  /**
   * 证书到期 / 发票待办的**系统通知**开关。默认 true = v2.4.0 起的现行行为。
   * 关 = 不发系统通知；仪表盘上的到期/待办区块不受影响（那是页面数据，不是提醒）。
   */
  certReminder?: boolean
  /**
   * 全局唤醒搜索（默认 **false = 不注册**，v2.5.9 A6-1）。
   * 开 = 注册系统级唤醒热键（**键位唯一真相见下方 `WAKE_SEARCH_ACCELERATOR`**，此处刻意不印具体键，
   * 免得注释变成第三份复制品）：任何程序前台时按下都能把启禾唤到前面并直接落到搜索页。
   * 默认关的理由：全局热键是**抢系统按键**的动作，与别的软件撞车时先手方赢；这种"占别人的键"
   * 只能由用户自己选，不能升级后自动生效（老用户升级零行为变更）。
   * 关 = 注销注册；注册失败（被占用/系统不支持）时如实降级并写日志，不静默留一个按不动的开关。
   */
  globalWakeShortcut?: boolean
  /**
   * 证书到期提醒的提前天数。默认 30 = `DashboardService.checkExpiringCerts` 的现行窗口。
   * 只接受 `CERT_REMINDER_DAY_CHOICES` 档位，其它值回落 30（防手改 json 把窗口调成 0 天）。
   */
  certReminderDays?: number
}

/**
 * 全局唤醒搜索的加速键（v2.5.9 A6-1）——**唯一真相**：主进程用它注册，设置页速查卡用它展示。
 * 两处各写一份键位必然会漂移（改了一处、另一处还印着旧键）。
 */
export const WAKE_SEARCH_ACCELERATOR = 'Control+Alt+S'
/** 展示形态（Electron accelerator 的 `Control` 在给人看时写作 `Ctrl`） */
export const WAKE_SEARCH_ACCELERATOR_LABEL = 'Ctrl+Alt+S'

/** 证书提醒提前天数档位（顺序 = 设置页选择器顺序：宽 → 窄） */
export const CERT_REMINDER_DAY_CHOICES = [30, 14, 7] as const

/** 归一后的完整设置（每个键都有值，消费端无需再兜底） */
export interface AppSettings extends Required<AppSettingsFile> {}

/**
 * 默认值表 = 各键开关化之前的现行行为（唯一真相）。
 * 老用户升级后读不到任何新键 → 全部命中本表 → 零行为变更。
 */
export const APP_SETTINGS_DEFAULTS: AppSettings = {
  devMode: false,
  closeToTray: true,
  autoUpdateCheck: true,
  selectionBar: true,
  clipboardGuard: true,
  certReminder: true,
  globalWakeShortcut: false,
  certReminderDays: 30,
}

/** 补丁形状（渲染层只提交改动的键；未知键忽略，避免成为「任意键写入口」） */
export type AppSettingsPatch = { [K in keyof AppSettings]?: AppSettings[K] }

const BOOL_KEYS = [
  'devMode',
  'closeToTray',
  'autoUpdateCheck',
  'selectionBar',
  'clipboardGuard',
  'certReminder',
  'globalWakeShortcut',
] as const

/** 落盘形状（可能缺键）→ 完整设置；脏数据逐键回落默认 */
export function resolveAppSettings(raw: AppSettingsFile | null | undefined): AppSettings {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = { ...APP_SETTINGS_DEFAULTS }
  for (const k of BOOL_KEYS) {
    if (typeof r[k] === 'boolean') out[k] = r[k]
  }
  if ((CERT_REMINDER_DAY_CHOICES as readonly number[]).includes(r.certReminderDays as number)) {
    out.certReminderDays = r.certReminderDays as number
  }
  return out
}

/** 键是否合法（白名单闸门：`set` 通道只认这些键） */
export function isAppSettingsKey(key: unknown): key is keyof AppSettings {
  return key === 'certReminderDays' || (BOOL_KEYS as readonly string[]).includes(String(key))
}

/** 补丁是否类型合法（布尔键收非 boolean、天数键收档位外值 → 整键拒绝，不落脏数据） */
export function isValidPatchValue(key: keyof AppSettings, value: unknown): boolean {
  if (key === 'certReminderDays') {
    return (CERT_REMINDER_DAY_CHOICES as readonly number[]).includes(value as number)
  }
  return typeof value === 'boolean'
}

/**
 * 当前落盘形状 + 补丁 → 新落盘形状：
 * 先合入补丁，再逐键与默认值比对，等于默认值的键删除（保持 json 精简，回滚 = 删键）。
 */
export function mergeAppSettings(current: AppSettingsFile, patch: AppSettingsPatch): AppSettingsFile {
  const next: AppSettingsFile = { ...current }
  for (const key of Object.keys(patch) as (keyof AppSettings)[]) {
    if (!isAppSettingsKey(key)) continue
    const value = patch[key]
    if (!isValidPatchValue(key, value)) continue
    // 类型闸门已保证 value 与 key 同型（tsconfig 双配置下仍写成断言，避免 as any）
    ;(next as Record<string, unknown>)[key] = value
  }
  const merged = resolveAppSettings(next)
  for (const key of Object.keys(APP_SETTINGS_DEFAULTS) as (keyof AppSettings)[]) {
    if (merged[key] === APP_SETTINGS_DEFAULTS[key]) delete next[key]
  }
  return next
}
