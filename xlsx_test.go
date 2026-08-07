package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/xuri/excelize/v2"
)

func TestExportAndImportXlsxTemplate(t *testing.T) {
	tmp := t.TempDir()
	app := NewApp()

	if res := app.WorkspaceCreate(tmp); !res.Success {
		t.Fatalf("create workspace: %s", res.Error)
	}

	// Export template
	templatePath := filepath.Join(tmp, "template.xlsx")
	exportRes := app.ExportXlsxTemplate(templatePath)
	if !exportRes.Success {
		t.Fatalf("export xlsx template: %s", exportRes.Error)
	}
	if _, err := os.Stat(templatePath); err != nil {
		t.Fatalf("template file not created: %v", err)
	}

	// Fill template with real data (overwrite example row and add a new row).
	f, err := excelize.OpenFile(templatePath)
	if err != nil {
		t.Fatalf("open template: %v", err)
	}
	_ = f.SetCellValue("产品集导入模板", "A2", "导入系列一")
	_ = f.SetCellValue("产品集导入模板", "A3", "导入系列二")
	if err := f.SaveAs(templatePath); err != nil {
		t.Fatalf("save filled template: %v", err)
	}
	f.Close()

	// Import
	importRes := app.ImportProductSetsFromXlsx(templatePath)
	if !importRes.Success {
		t.Fatalf("import xlsx: %s", importRes.Error)
	}
	if len(importRes.Data) != 2 {
		t.Fatalf("expected 2 product sets, got %d", len(importRes.Data))
	}

	for _, name := range []string{"导入系列一", "导入系列二"} {
		psDir := filepath.Join(tmp, "产品集", name)
		if _, err := os.Stat(psDir); err != nil {
			t.Fatalf("imported product set dir %s not created: %v", name, err)
		}
	}
}
