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
  externals?: string[]
  /** v2.5.7（F5b）：加密构建开关（密文 .enc 代替明文 + manifest 注入 encryption 块） */
  encrypt?: boolean
  /** v2.5.7（F5b）：权益门槛（login/subscription；缺省 login） */
  entitlement?: 'login' | 'subscription'
  /** v2.5.7（F5b）：密钥输出路径（明文 hex 写盘，供测试/登记用） */
  keyOut?: string
  log?: (...args: unknown[]) => void
}): Promise<{
  outPath: string
  files: string[]
  /** v2.5.7（F5b）：加密构建时返回密钥 hex（64 位）；非加密构建为实现侧固定返回 null（非 undefined） */
  keyHex: string | null
  /** v2.5.7（F5b）：包内各文件密文 sha256（格式 {file, sha256}[]）；非加密构建返回空数组，登记 erp 用 */
  cipherHashes: { file: string; sha256: string }[]
}>

/** 默认源目录（项目内 src/plugins/hello） */
export const DEFAULT_SRC_DIR: string
/** 默认输出目录（项目内 out/plugins） */
export const DEFAULT_OUT_DIR: string
