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

    // 填数据（第 2 行起为数据区）
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

  /**
   * 2.6.1/B16（用户拍板第三处）：示例行从 A2 挪成 A1 批注。
   * 旧版模板 A2 写死「示例产品集」，而导入循环从第 2 行起全当真数据 ⇒ 用户下载模板 →
   * 原样导入（或直接往后接着填）会凭空多出一个「示例产品集」；旧 e2e 夹具恰好把 A2 覆盖掉，
   * 这条缺陷一直没被看见。本条的承重判据 =「原样导入模板不产出任何产品集」。
   */
  it('原样导入模板（不填任何数据）→ 0 个产品集；示例只住在 A1 批注里', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const templatePath = path.join(ws, 'raw-template.xlsx')
    await box.xlsxExportTemplate(templatePath)

    // 模板本身没有数据行：A2 为空；示例在 A1 批注（exceljs cell.note，保留教学示例）
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(templatePath)
    const sheet = wb.worksheets[0]
    expect(sheet.getCell('A2').value ?? null).toBeNull()
    expect(JSON.stringify(sheet.getCell('A1').note ?? '')).toContain('示例产品集')

    // ★ 真链判据：原样导入不产出任何产品集（旧版这里会多出「示例产品集」）
    const created = await box.xlsxImport(templatePath)
    expect(created).toHaveLength(0)
    expect((await box.workspace.productSetList()).map((p) => p.name)).not.toContain('示例产品集')
  })
})
