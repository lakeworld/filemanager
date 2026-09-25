/**
 * host.dialog 能力实现（v2.6.1 协议增量，PROTOCOL 卡 §二 A 案）：单选文件 / 单选目录 / **多选文件**。
 *
 * 为什么从 ipc.ts 抽出来：装配闭包（ipc.ts）里那版 `openDialog(kind)` 只取 `filePaths[0]`
 * 且与 electron 强耦合，宿主侧行为（多选条数、取消语义、截断上限、失败分类）无从在 node 下单测。
 * 抽成本模块后 io 注入（getWindow / showOpenDialog / log 全由装配层给），单测可直接喂假 dialog。
 *
 * 三条契约语义（写进 docs/PLUGIN.md，缺一不可——「选了图片没反应」那个洞的教训）：
 * 1. **取消与失败必须可分辨**：取消 → 空值（多选 `[]`，单选 `''`）；失败 → 带 code 的业务错误
 *    （`DIALOG_FAILED`）抛出，**不得两者都回空**。
 * 2. **返回的是裸值不是信封**：host.* 主进程面的既有约定是返回值语义（异常经 code 区分），
 *    与渲染桥 `qihebox.*` 的 ApiResult 信封不同——插件侧不要按信封拆。
 * 3. **只增不改**：openFile / openDirectory 的形状与取消语义一字不动。
 *
 * 截断口径（P1 拍板）：`openFiles` 单批 ≤ `OPEN_FILES_MAX`（200）——防「选了整个照片库」把
 * 路径数组灌进插件。截断时宿主记日志（含被截条数），插件端收到恰好 200 条须如实提示
 * 「已达宿主上限，超出部分未取入」（口径由宿主定，插件侧话术在 com.qihe.tools 落地）。
 */
import { fileError } from './host'

/** 多选单批上限（P1 拍板 ≤200；宿主侧截断，超出部分不取入） */
export const OPEN_FILES_MAX = 200

/** Electron.OpenDialogOptions 的最小结构类型（本模块不 import electron，保持 node 可测） */
export interface OpenDialogOptionsLike {
  title: string
  properties: string[]
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface OpenDialogResultLike {
  canceled: boolean
  filePaths: string[]
}

export interface DialogIo {
  /** 当前主窗口（无 → null；electron 的 `(win, opts)` / `(opts)` 两形由 io 决定） */
  getWindow(): unknown | null
  showOpenDialog(win: unknown | null, opts: OpenDialogOptionsLike): Promise<OpenDialogResultLike>
  log(level: 'info' | 'warn' | 'error', msg: string): void
}

export interface DialogCapability {
  openFile(opts: unknown): Promise<string>
  openFiles(opts: unknown): Promise<string[]>
  openDirectory(opts: unknown): Promise<string>
}

/** 插件传入的 opts（`unknown` 面）：只认 title 与 filters，其余忽略（与既有单选同口径） */
function parseOpts(opts: unknown): { title: string; filters?: Array<{ name: string; extensions: string[] }> } {
  const o = (opts ?? {}) as { title?: unknown; filters?: unknown }
  return {
    title: typeof o.title === 'string' && o.title !== '' ? o.title : '',
    filters: Array.isArray(o.filters) ? (o.filters as Array<{ name: string; extensions: string[] }>) : undefined,
  }
}

export function createDialogCapability(io: DialogIo): DialogCapability {
  /** 共用调用：包失败分类（原始原因只进日志，插件拿到的是一句话 + code） */
  async function call(kindLabel: string, opts: OpenDialogOptionsLike): Promise<OpenDialogResultLike> {
    try {
      return await io.showOpenDialog(io.getWindow(), opts)
    } catch (err) {
      io.log('warn', `[plugins] ${kindLabel}对话框调用失败：${err instanceof Error ? err.message : String(err)}`)
      throw fileError('DIALOG_FAILED', `打开${kindLabel}选择框失败，请重试`)
    }
  }

  /** 路径数组净化：只留非空字符串（electron 已保证，但归一让契约面更稳） */
  function pathsOf(r: OpenDialogResultLike): string[] {
    if (!r || r.canceled !== false || !Array.isArray(r.filePaths)) return []
    return r.filePaths.filter((p): p is string => typeof p === 'string' && p !== '')
  }

  return {
    async openFile(opts: unknown): Promise<string> {
      const o = parseOpts(opts)
      const base: OpenDialogOptionsLike = { title: o.title || '选择文件', properties: ['openFile'] }
      if (o.filters) base.filters = o.filters
      const paths = pathsOf(await call('文件', base))
      return paths.length === 0 ? '' : paths[0]
    },

    async openFiles(opts: unknown): Promise<string[]> {
      const o = parseOpts(opts)
      const base: OpenDialogOptionsLike = { title: o.title || '选择文件', properties: ['openFile', 'multiSelections'] }
      if (o.filters) base.filters = o.filters
      const paths = pathsOf(await call('文件', base))
      if (paths.length > OPEN_FILES_MAX) {
        // 截断必须留痕：宿主的日志是这条话术唯一的机器可查落点（插件端只在恰好 200 条时如实提示）
        io.log('warn', `[plugins] dialog.openFiles 选中 ${paths.length} 条，超过宿主上限 ${OPEN_FILES_MAX}，已截断（超出部分未取入）`)
        return paths.slice(0, OPEN_FILES_MAX)
      }
      return paths
    },

    async openDirectory(opts: unknown): Promise<string> {
      const o = parseOpts(opts)
      const base: OpenDialogOptionsLike = { title: o.title || '选择文件夹', properties: ['openDirectory', 'createDirectory'] }
      const paths = pathsOf(await call('文件夹', base))
      return paths.length === 0 ? '' : paths[0]
    },
  }
}