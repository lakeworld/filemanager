import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import ExcelJS from 'exceljs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-xlsx-'))
}

describe('XLSX 模板导出与批量导入（对照原 xlsx_test.go）', () => {
  it('导出模板 → 填 2 行 → 导入 → 2 个产品集目录', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // 导出模板
    const templatePath = path.join(ws, 'template.xlsx')
    await box.xlsxExportTemplate(templatePath)
    await expect(fsp.stat(templatePath)).resolves.toBeTruthy()

    // 填数据（覆盖示例行 + 新增一行）
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(templatePath)
    const sheet = wb.worksheets[0]
    sheet.getCell('A2').value = '导入系列一'
    sheet.getCell('A3').value = '导入系列二'
    await wb.xlsx.writeFile(templatePath)

    // 导入
    const created = await box.xlsxImport(templatePath)
    expect(created).toHaveLength(2)

    for (const name of ['导入系列一', '导入系列二']) {
      const psDir = path.join(ws, '产品集', name)
      await expect(fsp.stat(psDir)).resolves.toBeTruthy()
    }
  })

  it('重复名称只创建一次', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const templatePath = path.join(ws, 'dup.xlsx')
    await box.xlsxExportTemplate(templatePath)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(templatePath)
    const sheet = wb.worksheets[0]
    sheet.getCell('A2').value = '重复'
    sheet.getCell('A3').value = '重复'
    await wb.xlsx.writeFile(templatePath)

    const created = await box.xlsxImport(templatePath)
    expect(created).toHaveLength(1)
  })
})
