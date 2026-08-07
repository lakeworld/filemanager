package main

import (
	"fmt"
	"strings"

	"github.com/xuri/excelize/v2"
)

const xlsxTemplateSheetName = "产品集导入模板"

// ExportXlsxTemplate writes a styled xlsx template to the given path.
func (a *App) ExportXlsxTemplate(path string) ApiResult[bool] {
	if strings.TrimSpace(path) == "" {
		return Err[bool]("路径不能为空")
	}

	f := excelize.NewFile()
	defer f.Close()

	// Rename default sheet.
	index, err := f.GetSheetIndex("Sheet1")
	if err != nil {
		return Err[bool](err.Error())
	}
	_ = f.SetSheetName(f.GetSheetName(index), xlsxTemplateSheetName)

	headers := []string{"产品集名称"}
	example := []string{"示例产品集"}

	// Header style: bold text, blue background.
	headerStyleID, err := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Color: "#FFFFFF"},
		Fill:      excelize.Fill{Type: "pattern", Color: []string{"#3B82F6"}, Pattern: 1},
		Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "center"},
	})
	if err != nil {
		return Err[bool](err.Error())
	}

	// Example row style: gray italic text.
	exampleStyleID, err := f.NewStyle(&excelize.Style{
		Font: &excelize.Font{Italic: true, Color: "#6B7280"},
		Fill: excelize.Fill{Type: "pattern", Color: []string{"#F3F4F6"}, Pattern: 1},
	})
	if err != nil {
		return Err[bool](err.Error())
	}

	// Write headers.
	for col, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(col+1, 1)
		_ = f.SetCellValue(xlsxTemplateSheetName, cell, h)
	}
	_ = f.SetCellStyle(xlsxTemplateSheetName, "A1", "A1", headerStyleID)

	// Write example row.
	for col, v := range example {
		cell, _ := excelize.CoordinatesToCellName(col+1, 2)
		_ = f.SetCellValue(xlsxTemplateSheetName, cell, v)
	}
	_ = f.SetCellStyle(xlsxTemplateSheetName, "A2", "A2", exampleStyleID)

	// Add instructions sheet.
	instSheet := "填写说明"
	if _, err := f.NewSheet(instSheet); err != nil {
		return Err[bool](err.Error())
	}
	_ = f.SetCellValue(instSheet, "A1", "产品集导入模板使用说明")
	_ = f.SetCellStyle(instSheet, "A1", "A1", headerStyleID)
	_ = f.SetCellValue(instSheet, "A3", "1. 在“产品集导入模板”工作表中填写数据，从第 3 行开始。")
	_ = f.SetCellValue(instSheet, "A4", "2. 每行对应一个产品集，导入后仅创建产品集。")
	_ = f.SetCellValue(instSheet, "A5", "3. 第 2 行为示例数据，填写前请删除或覆盖。")
	_ = f.SetCellValue(instSheet, "A6", "4. 产品集名称为必填项，不可为空。")
	_ = f.SetColWidth(instSheet, "A", "A", 80)

	// Set column widths on data sheet.
	_ = f.SetColWidth(xlsxTemplateSheetName, "A", "A", 24)

	if err := f.SaveAs(path); err != nil {
		return Err[bool](err.Error())
	}
	return Ok(true)
}

// ImportProductSetsFromXlsx reads an xlsx file and batch creates product sets.
func (a *App) ImportProductSetsFromXlsx(path string) ApiResult[[]ProductSetInfo] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[[]ProductSetInfo]("未打开工作区")
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return Err[[]ProductSetInfo]("路径不能为空")
	}

	f, err := excelize.OpenFile(path)
	if err != nil {
		return Err[[]ProductSetInfo](err.Error())
	}
	defer f.Close()

	// Use the first sheet.
	sheet := f.GetSheetName(0)
	if sheet == "" {
		return Err[[]ProductSetInfo]("无法读取工作表")
	}

	rows, err := f.GetRows(sheet)
	if err != nil {
		return Err[[]ProductSetInfo](err.Error())
	}
	if len(rows) <= 1 {
		return Ok([]ProductSetInfo{})
	}

	// Collect unique product set names.
	seen := make(map[string]bool)
	created := make([]ProductSetInfo, 0)
	for i, row := range rows[1:] {
		lineNo := i + 2 // 1-based line number in spreadsheet (header is row 1)
		if len(row) == 0 || allEmpty(row) {
			continue
		}
		setName := strings.TrimSpace(getCell(row, 0))
		if setName == "" {
			return Err[[]ProductSetInfo](fmt.Sprintf("第 %d 行产品集名称不能为空", lineNo))
		}
		if seen[setName] {
			continue
		}
		seen[setName] = true

		result := a.ProductSetCreate(ProductSetCreateRequest{Name: setName})
		if !result.Success {
			return Err[[]ProductSetInfo](result.Error)
		}
		created = append(created, result.Data)
	}

	return Ok(created)
}

func getCell(row []string, index int) string {
	if index < 0 || index >= len(row) {
		return ""
	}
	return row[index]
}

func allEmpty(row []string) bool {
	for _, c := range row {
		if strings.TrimSpace(c) != "" {
			return false
		}
	}
	return true
}
