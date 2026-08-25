import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { isInvoiceCandidate, invoiceFileTypeOf, listInvoiceDir } from '../../src/main/core/dirBrowse'

/**
 * 任意目录浏览纯函数（v2.5.5 打磨 2）：发票候选扩展名过滤 + 目录列举（子文件夹/候选文件/隐藏排除/排序）。
 * 供发票批量识别「选任意系统文件夹」面板；node 直测。
 */
describe('dirBrowse', () => {
  describe('isInvoiceCandidate', () => {
    it('接受发票候选扩展名（PDF/图片，大小写不敏感）', () => {
      for (const n of ['a.pdf', 'b.PDF', 'c.jpg', 'd.JPG', 'e.jpeg', 'f.png', 'g.webp', 'h.bmp']) {
        expect(isInvoiceCandidate(n)).toBe(true)
      }
    })
    it('拒绝非候选扩展名', () => {
      for (const n of ['a.txt', 'b.docx', 'c.zip', 'd.xlsx', 'e', 'f.tar.gz', '.pdf']) {
        expect(isInvoiceCandidate(n)).toBe(false)
      }
    })
  })

  describe('invoiceFileTypeOf', () => {
    it('pdf → pdf，其余图片 → image', () => {
      expect(invoiceFileTypeOf('a.pdf')).toBe('pdf')
      expect(invoiceFileTypeOf('a.PDF')).toBe('pdf')
      expect(invoiceFileTypeOf('a.jpg')).toBe('image')
      expect(invoiceFileTypeOf('a.webp')).toBe('image')
    })
  })

  describe('listInvoiceDir', () => {
    let root: string
    beforeAll(async () => {
      root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dirbrowse-test-'))
      await fsp.writeFile(path.join(root, 'a.pdf'), '%PDF-1.4')
      await fsp.writeFile(path.join(root, 'b.JPG'), 'img')
      await fsp.writeFile(path.join(root, 'c.txt'), 'not candidate')
      await fsp.writeFile(path.join(root, '.hidden.pdf'), 'hidden')
      await fsp.mkdir(path.join(root, '子文件夹'))
      await fsp.writeFile(path.join(root, '子文件夹', 'inner.png'), 'inner')
    })
    afterAll(async () => {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
    })

    it('返回子文件夹与候选文件（隐藏排除、扩展名过滤、按名排序）', async () => {
      const r = await listInvoiceDir(root)
      expect(r.dir).toBe(root)
      expect(r.dirs).toEqual(['子文件夹'])
      expect(r.files.map((f) => f.name)).toEqual(['a.pdf', 'b.JPG'])
      expect(r.files[0].file_type).toBe('pdf')
      expect(r.files[1].file_type).toBe('image')
      expect(r.files.every((f) => f.path.startsWith(root))).toBe(true)
      expect(r.files[0].size).toBeGreaterThan(0)
    })

    it('空路径 → 空结果', async () => {
      const r = await listInvoiceDir('')
      expect(r).toEqual({ dir: '', dirs: [], files: [] })
    })

    it('不存在的目录 → dir 保留、列表为空（不抛错）', async () => {
      const r = await listInvoiceDir(path.join(root, '不存在'))
      expect(r.dir).toBe(path.join(root, '不存在'))
      expect(r.dirs).toEqual([])
      expect(r.files).toEqual([])
    })
  })
})
