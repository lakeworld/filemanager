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
  // 就绪标志必须无条件落下：`get()` 被 reject（IPC 通道缺失 / 主进程失联）时 `.then` 的回调根本不执行，
  // 六开关会永久停在 `disabled={!prefReady()}` 的置灰态，外加一条 unhandled rejection（复审 r2 ⑤-3）。
  // 读失败按"默认值 = 现行行为"降级并解除置灰，与上面那句注释的口径一致；不静默吞掉 reject 本身。
  void b
    .get()
    .then((r) => {
      if (r.success && r.data) setAppSettings(r.data)
    })
    .catch(() => {
      /* 读不到设置：保持默认值，不弹错打扰用户 */
    })
    .finally(() => setAppSettingsReady(true))
}

/**
 * 写一个/多个键并同步本地信号。返回是否写成功——调用方（设置页开关）据其回滚 UI。
 * 以服务端返回值为权威：脏值被主进程归一（如天数档位外 → 30）时，UI 跟着回落而非停留在本地值。
 */
export async function setAppSetting(patch: AppSettingsPatch): Promise<boolean> {
  const b = bridge()
  if (!b) return false
  // 契约是「返回是否写成功」，调用方（设置页开关）据其回滚 UI 并弹错——所以 reject 也必须收敛成 false，
  // 不能把异常抛给 `savePref`：它 await 且无 try/catch，一抛就连回滚带 toast 一起丢。
  let r: Awaited<ReturnType<typeof b.set>>
  try {
    r = await b.set(patch)
  } catch {
    return false
  }
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
  // 本函数被 `Settings.tsx` 的 `savePref` 直接 await 且**没有 try/catch**：它一 reject，
  // 后面那句"设置失败"的 toast 就永远不弹（用户只看到复选框自己跳回去，没有任何解释）。
  // 所以这里把读失败收敛成 resolve——重拉不到就用现有信号值落位，报错仍由 savePref 负责。
  return b
    .get()
    .then((r) => {
      if (r.success && r.data) setAppSettings(r.data)
      setAppSettingsReady(true)
    })
    .catch(() => {
      setAppSettingsReady(true)
    })
}

/** 悬浮多选条是否显示（W7；默认 true = D10 现行形态） */
export const selectionBarVisible = (): boolean => appSettings().selectionBar
/** 剪贴板选区守卫是否生效（W7；默认 true = v2.5.7 A1 现行口径） */
export const clipboardGuardOn = (): boolean => appSettings().clipboardGuard

export { appSettings, appSettingsReady }
