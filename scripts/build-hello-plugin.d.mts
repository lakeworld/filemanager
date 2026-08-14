/**
 * scripts/build-hello-plugin.mjs 的类型声明（供 tests/unit 静态检查使用；
 * 脚本本体为纯 JS，运行时不加载本文件）。与 .mjs 实现保持同步。
 */

/** zip 打包条目：name 为包内相对路径（正斜杠）；目录条目 name 以 '/' 结尾且 data 为空 */
export interface QboxEntry {
  name: string
  data: Buffer | string
}

/** 内存打包 zip（deflate）→ Buffer，格式与 src/main/core/archive.ts 的 extractZip 解压器兼容 */
export function packQbox(entries: QboxEntry[]): Buffer

/** 构建 hello 插件 .qbox：esbuild（main→CJS、renderer→ESM 自包含）+ manifest + packQbox；返回产物路径与包内条目 */
export function buildHelloPlugin(opts?: {
  srcDir?: string
  outDir?: string
  log?: (...args: unknown[]) => void
}): Promise<{ outPath: string; files: string[] }>

/** 默认源目录（项目内 src/plugins/hello） */
export const DEFAULT_SRC_DIR: string
/** 默认输出目录（项目内 out/plugins） */
export const DEFAULT_OUT_DIR: string
