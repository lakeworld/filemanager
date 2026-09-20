/**
 * check-version-sync.mjs 的类型声明（vitest node 侧 import 用；CI/本地 CLI 运行不受影响）。
 * 只声明单测需要的两个导出：纯判据 collectFailures 与真实读取 readInputs。
 */

export interface VersionSyncTutorial {
  /** 相对仓根的路径，用于失败信息点名 */
  file: string
  text: string
}

/** 判据输入：四处文本 + 教程清单（全字段可选，便于单测只喂关心的那几处） */
export interface VersionSyncInput {
  version: string
  changelog?: string
  readme?: string
  releaseExists?: boolean
  tutorials?: VersionSyncTutorial[]
  releaseDirPresent?: boolean
}

/** 真实读取后的完整输入（readInputs 的返回） */
export interface VersionSyncInputs extends VersionSyncInput {
  changelog: string
  readme: string
  releaseExists: boolean
  tutorials: VersionSyncTutorial[]
  releaseDirPresent: boolean
}

/** 返回失败项（空数组 = 全绿）；每条都是可直接打印给人看的一句人话 */
export declare function collectFailures(input: VersionSyncInput): string[]

/** 从仓根读出四处 + 本版归位教程（母本正文一并计入） */
export declare function readInputs(root?: string): VersionSyncInputs