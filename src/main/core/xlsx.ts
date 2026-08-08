/**
 * XLSX 模板导出/批量导入（对照原 Go xlsx.go，exceljs 替代 excelize）
 * 纯 TS 业务层：不 import electron，可在 node 环境直接测试。
 * 性能：exceljs 延迟加载（动态 import），避免主进程启动加载其依赖链。
 */
import ExcelJS from 'exceljs'
import { WorkspaceService, ProductSetInfo } from './workspace'

const TEMPLATE_SHEET = '产品集导入模板'
const INSTRUCTIONS_SHEET = '填写说明'

function allEmpty(row: ExcelJS.Row): boolean {
  let hasValue = false
  row.eachCell({ includeEmpty: false }, () => {
    hasValue = true
  })
  return !hasValue
}

export class XlsxService {
  constructor(private workspace: WorkspaceService) {}

  /** 导出带样式的导入模板（对照 ExportXlsxTemplate） */
  async exportTemplate(filePath: string): Promise<void> {
    if (!filePath.trim()) throw new Error('路径不能为空')
    const XLSX = ExcelJS
    const wb = new XLSX.Workbook()
    const ws = wb.worksheets[0] ?? wb.addWorksheet(TEMPLATE_SHEET)
    ws.name = TEMPLATE_SHEET

    // 表头：粗体白字蓝底居中
    const header = ws.getCell('A1')
    header.value = '产品集名称'
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } }
    header.alignment = { horizontal: 'center', vertical: 'middle' }

    // 示例行：灰色斜体 + 浅灰底
    const example = ws.getCell('A2')
    example.value = '示例产品集'
    example.font = { italic: true, color: { argb: 'FF6B7280' } }
    example.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }

    ws.getColumn(1).width = 24

    // 填写说明 sheet
    const inst = wb.addWorksheet(INSTRUCTIONS_SHEET)
    inst.getCell('A1').value = '产品集导入模板使用说明'
    inst.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' } }
    inst.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } }
    inst.getCell('A3').value = '1. 在“产品集导入模板”工作表中填写数据，从第 3 行开始。'
    inst.getCell('A4').value = '2. 每行对应一个产品集，导入后仅创建产品集。'
    inst.getCell('A5').value = '3. 第 2 行为示例数据，填写前请删除或覆盖。'
    inst.getCell('A6').value = '4. 产品集名称为必填项，不可为空。'
    inst.getColumn(1).width = 80

    await wb.xlsx.writeFile(filePath)
  }

  /** 从 xlsx 批量创建产品集（对照 ImportProductSetsFromXlsx） */
  async importProductSets(filePath: string): Promise<ProductSetInfo[]> {
    const ws0 = this.workspace.currentWorkspacePath()
    if (!ws0) throw new Error('未打开工作区')
    if (!filePath.trim()) throw new Error('路径不能为空')

    const XLSX = ExcelJS
    const wb = new XLSX.Workbook()
    await wb.xlsx.readFile(filePath)
    const sheet = wb.worksheets[0]
    if (!sheet) throw new Error('无法读取工作表')

    const created: ProductSetInfo[] = []
    const seen = new Set<string>()
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r)
      if (allEmpty(row)) continue
      const name = String(row.getCell(1).value ?? '').trim()
      if (!name) throw new Error(`第 ${r} 行产品集名称不能为空`)
      if (seen.has(name)) continue
      seen.add(name)
      created.push(await this.workspace.productSetCreate({ name }))
    }
    return created
  }
}
