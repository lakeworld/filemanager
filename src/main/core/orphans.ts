/**
 * 孤儿档案比对（PLAN-v2.5.5 §二 修复3，B1 任务 C）：
 * 扫 发票/、入库/、报价/ 目录全部文件（递归，含 <YYYY>/ 年份子目录），
 * 与各台账已登记的 file_path 集合取差集 → 返回未登记（孤儿）档案文件的工作区相对路径列表。
 *
 * - ledger 由调用方从各台账 list() 提取 file_path（core 注入式，便于 node 直测）；
 *   缺省视为空台账（全部文件为孤儿）。
 * - 返回的相对路径与台账 file_path 同口径（/ 分隔、以区名开头，如 发票/2026/xxx.pdf）。
 * - 目录本身不计数；目录不存在 / 为空 → 空数组。
 *
 * 用途：报价页「发现 N 个未登记档案文件」提示条（补建/删除入口，B1）；发票/入库「未建档」筛选（B3）。
 * 历史孤儿（含 2026-08-24 用户误删那张——文件仍在 发票/<YYYY>/、台账无记录）能被本函数扫出。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { INVOICES_DIR, INBOUND_DIR, QUOTES_DIR } from './paths'

/** 各台账已登记 file_path 集合（调用方从 list() 提取；缺省 = 空台账） */
export interface ArchiveLedger {
  invoice: string[]
  inbound: string[]
  quote: string[]
}

/** 比对结果：三区孤儿文件的工作区相对路径（/ 分隔） */
export interface OrphanReport {
  invoice: string[]
  inbound: string[]
  quote: string[]
}

/** 递归收集 dir 下全部文件相对路径（/ 分隔，以工作区为基准；目录不存在/不可读 → 静默空）。
 *  skipDirs：目录名命中即整目录跳过（v2.5.5 打磨 2——报价文档文件夹 报价/<YYYY>/<单号>/ 属台账内文件，不得计为孤儿） */
async function collectFiles(
  ws: string,
  dir: string,
  out: string[],
  skipDirs?: Set<string>,
): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (skipDirs?.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await collectFiles(ws, full, out, skipDirs)
    else if (e.isFile()) out.push(path.relative(ws, full).split(path.sep).join('/'))
  }
}

export async function compareArchiveDirs(
  ws: string,
  ledger?: ArchiveLedger,
  quoteNos?: Set<string>,
): Promise<OrphanReport> {
  const invoiceSet = new Set(ledger?.invoice ?? [])
  const inboundSet = new Set(ledger?.inbound ?? [])
  const quoteSet = new Set(ledger?.quote ?? [])
  const invoice: string[] = []
  const inbound: string[] = []
  const quote: string[] = []
  await Promise.all([
    collectFiles(ws, path.join(ws, INVOICES_DIR), invoice),
    collectFiles(ws, path.join(ws, INBOUND_DIR), inbound),
    collectFiles(ws, path.join(ws, QUOTES_DIR), quote, quoteNos),
  ])
  return {
    invoice: invoice.filter((f) => !invoiceSet.has(f)),
    inbound: inbound.filter((f) => !inboundSet.has(f)),
    quote: quote.filter((f) => !quoteSet.has(f)),
  }
}
