/**
 * 一致性套件 · 共享工具（v2.5，PLAN-v2.5-测试.md Task 4）。
 * 自包含的最小 zip 读取器：从 .qbox（zip 容器）读取 manifest.json，供 conformance.spec.ts 步骤 a 使用。
 * 不依赖 src/main/core/archive.ts（解耦第三方可用的体检工具与本体内核，仅保留协议契约 types.ts 一处耦合）。
 * 仅处理 method 8（deflate）/ method 0（store）条目，与 build-hello-plugin.mjs 的 packQbox 产物兼容。
 */
import fsp from 'node:fs/promises'
import zlib from 'node:zlib'

interface CdEntry {
  method: number
  compSize: number
  localOffset: number
  nameLen: number
  extraLen: number
  commentLen: number
}

/** 从 zip 容器读取指定条目内容（经 central directory 定位 + local header 取数据起点）。 */
export async function readZipEntry(zipPath: string, entryName: string): Promise<Buffer> {
  const buf = await fsp.readFile(zipPath)

  // EOCD：从尾部最多 64KB+22 字节内找 PK\x05\x06
  const tailLen = Math.min(buf.length, 65557)
  const tail = buf.subarray(buf.length - tailLen)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(`不是有效的 zip 文件（未找到目录尾）：${zipPath}`)
  const cdOffset = tail.readUInt32LE(eocd + 16)
  const cdSize = tail.readUInt32LE(eocd + 12)
  if (cdOffset + cdSize > buf.length) throw new Error(`zip 目录损坏：${zipPath}`)

  // 遍历 central directory，定位目标条目
  let found: CdEntry | null = null
  let pos = cdOffset
  const cdEnd = cdOffset + cdSize
  while (pos + 46 <= cdEnd) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break
    const method = buf.readUInt16LE(pos + 10)
    const compSize = buf.readUInt32LE(pos + 20)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
    if (name === entryName) {
      found = { method, compSize, localOffset, nameLen, extraLen, commentLen }
      break
    }
    pos += 46 + nameLen + extraLen + commentLen
  }
  if (!found) throw new Error(`zip 内未找到条目：${entryName}`)

  // local header：跳过 name/extra 定位数据起点
  const lh = found.localOffset
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error(`条目损坏：${entryName}`)
  const lhNameLen = buf.readUInt16LE(lh + 26)
  const lhExtraLen = buf.readUInt16LE(lh + 28)
  const dataStart = lh + 30 + lhNameLen + lhExtraLen
  const comp = buf.subarray(dataStart, dataStart + found.compSize)

  if (found.method === 8) return zlib.inflateRawSync(comp)
  if (found.method === 0) return Buffer.from(comp)
  throw new Error(`不支持的压缩方式（method=${found.method}）：${entryName}`)
}

/** 从 .qbox 读取 manifest.json 并解析为 JSON（不在此校验结构——校验由 validateManifest 执行）。 */
export async function readManifestFromQbox(qboxPath: string): Promise<{ raw: unknown }> {
  const raw = JSON.parse((await readZipEntry(qboxPath, 'manifest.json')).toString('utf8')) as unknown
  return { raw }
}
