/**
 * 应用级设置的渲染层镜像（v2.5.8 D11 / W7）。
 *
 * 真相在主进程（`userData/settings.json`，见 `src/main/settings.ts` + `src/shared/appSettings.ts`），
 * 本模块只做两件事：启动时 `loadAppSettings()` 拉一次全量、`setAppSetting()` 写回并同步本地信号。
 *
 * 为什么本地要留一份信号而不是每次消费点各拉一次 IPC：
 * - 浮条显隐、剪贴板守卫这类是**渲染期高频判定**（每次 keydown / 每次浮条渲染都要读），走 IPC 会
 *   把它变成异步且每帧一次跨进程调用；
 * - 默认值 = 现行行为（`APP_SETTINGS_DEFAULTS`），所以**拉取失败或拉取未回来之前**，消费点看到的
 *   就是老用户 today 的行为，不会出现「首帧先闪一下新形态再回退」这类闪烁。
 *
 * 写回失败时把信号回滚为服务端返回值（`set` 通道返回落盘后的全量值），UI 不与磁盘漂移。
 */
import { createSignal } from 'solid-js'
import type { AppSettings, AppSettingsPatch } from '../../../shared/appSettings'
import { APP_SETTINGS_DEFAULTS } from '../../../shared/appSettings'

const bridge = (): {
  get(): Promise<{ success: boolean; data: AppSettings | null; error: string | null }>
  set(p: AppSettingsPatch): Promise<{ success: boolean; data: AppSettings | null; error: string | null }>
} | null => {
  // 双 tsconfig 纪律（照 plugins/registry.ts 同款写法）：先整体断言 window 再取属性，
  // 否则 node 配置下 tests 引入本文件时 Window 无 qihebox 声明会报 TS2339
  const w = window as unknown as {
    qihebox?: {
      appSettings: {
        get(): Promise<{ success: boolean; data: AppSettings | null; error: string | null }>
        set(p: AppSettingsPatch): Promise<{ success: boolean; data: AppSettings | null; error: string | null }>
      }
    }
  }
  return w.qihebox?.appSettings ?? null
}

const [appSettings, setAppSettings] = createSignal<AppSettings>(APP_SETTINGS_DEFAULTS)
/**
 * 镜像是否已从主进程拉回过一次。
 * 存在的理由不是"少渲染一次"，而是**竞态闸门**：首拉未回来时设置页显示的是默认值，
 * 用户此刻点开关 → 写盘成功，但随后到达的首拉响应会把信号覆盖回磁盘旧值之外的另一份快照，
 * 界面与磁盘就此漂移。设置页据此在就绪前禁用开关（消费点不需要，默认值本就是现行行为）。
 */
const [appSettingsReady, setAppSettingsReady] = createSignal(false)

/** 全量拉取（App onMount 调一次）；失败静默保持默认值 = 现行行为，不弹错误打扰用户 */
export function loadAppSettings(): void {
  const b = bridge()
  if (!b) {
    setAppSettingsReady(true) // 无桥（纯渲染层单测环境）也算就绪，别让开关永远点不动
    return
  }
  void b.get().then((r) => {
    if (r.success && r.data) setAppSettings(r.data)
    setAppSettingsReady(true)
  })
}

/**
 * 写一个/多个键并同步本地信号。返回是否写成功——调用方（设置页开关）据其回滚 UI。
 * 以服务端返回值为权威：脏值被主进程归一（如天数档位外 → 30）时，UI 跟着回落而非停留在本地值。
 */
export async function setAppSetting(patch: AppSettingsPatch): Promise<boolean> {
  const b = bridge()
  if (!b) return false
  const r = await b.set(patch)
  if (r.success && r.data) {
    setAppSettings(r.data)
    setAppSettingsReady(true)
    return true
  }
  return false
}

/** 写失败后的重拉（调用方 await 它，回滚才会在下一次渲染前落地——不 await 会闪一下错值） */
export function reloadAppSettings(): Promise<void> {
  const b = bridge()
  if (!b) return Promise.resolve()
  return b.get().then((r) => {
    if (r.success && r.data) setAppSettings(r.data)
    setAppSettingsReady(true)
  })
}

/** 悬浮多选条是否显示（W7；默认 true = D10 现行形态） */
export const selectionBarVisible = (): boolean => appSettings().selectionBar
/** 剪贴板选区守卫是否生效（W7；默认 true = v2.5.7 A1 现行口径） */
export const clipboardGuardOn = (): boolean => appSettings().clipboardGuard

export { appSettings, appSettingsReady }
