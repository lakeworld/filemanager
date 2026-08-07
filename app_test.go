package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceAndProductSetFlow(t *testing.T) {
	tmp := t.TempDir()
	app := NewApp()

	// 1. Create workspace
	res := app.WorkspaceCreate(tmp)
	if !res.Success {
		t.Fatalf("create workspace: %s", res.Error)
	}
	if res.Data.Path != tmp {
		t.Fatalf("workspace path mismatch")
	}

	// 2. Verify workspace is current
	cur := app.WorkspaceCurrent()
	if !cur.Success || cur.Data == nil || cur.Data.Path != tmp {
		t.Fatalf("current workspace not set")
	}

	// 3. Create product set
	ps := app.ProductSetCreate(ProductSetCreateRequest{Name: "测试系列"})
	if !ps.Success {
		t.Fatalf("create product set: %s", ps.Error)
	}

	// 4. Verify directories
	psDir := filepath.Join(tmp, "产品集", "测试系列")
	if _, err := os.Stat(psDir); err != nil {
		t.Fatalf("product set dir not created: %v", err)
	}
	for _, sub := range []string{"图包/主图", "图包/详情页", "图包/白底图", "图包/素材", "证书/3C", "证书/质检", "证书/专利"} {
		if _, err := os.Stat(filepath.Join(psDir, sub)); err != nil {
			t.Fatalf("sub folder %s not created: %v", sub, err)
		}
	}

	// 5. Import a dummy file
	src := filepath.Join(tmp, "dummy.txt")
	if err := os.WriteFile(src, []byte("hello"), 0644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	imp := app.FileImport(ImportFileRequest{
		SourcePaths:      []string{src},
		TargetProductSet: "测试系列",
		TargetType:       "image",
		TargetFolder:     "主图",
		SubFolder:        "主图",
	})
	if !imp.Success {
		t.Fatalf("import file: %s", imp.Error)
	}
	if len(imp.Data) != 1 {
		t.Fatalf("expected 1 imported file, got %d", len(imp.Data))
	}

	// 6. List files
	list := app.FileList(FileListRequest{
		ProductSet: "测试系列",
		FileType:   "image",
		SubFolder:  "主图",
	})
	if !list.Success {
		t.Fatalf("list files: %s", list.Error)
	}
	if len(list.Data) != 1 {
		t.Fatalf("expected 1 listed file, got %d", len(list.Data))
	}

	// 7. Product set stats
	stats := app.ProductSetStats("测试系列")
	if !stats.Success {
		t.Fatalf("product set stats: %s", stats.Error)
	}
	if stats.Data.ImageCount != 1 || stats.Data.CertCount != 0 {
		t.Fatalf("unexpected product set stats: %+v", stats.Data)
	}

	// 8. Dashboard stats
	dash := app.DashboardStats()
	if !dash.Success {
		t.Fatalf("dashboard stats: %s", dash.Error)
	}
	if dash.Data.TotalProductSets != 1 || dash.Data.TotalImages != 1 || dash.Data.TotalCerts != 0 {
		t.Fatalf("unexpected dashboard stats: %+v", dash.Data)
	}

	// 9. Metadata
	meta := app.MetadataUpdate(MetadataUpdateRequest{
		ProductSet: "测试系列",
		FileName:   imp.Data[0].Name,
		CertType:   "",
		ExpiryDate: "2026-12-31",
		Tags:       []string{"测试"},
		Notes:      "备注",
	})
	if !meta.Success {
		t.Fatalf("update metadata: %s", meta.Error)
	}
	got := app.MetadataGet("测试系列", imp.Data[0].Name)
	if !got.Success || got.Data.Notes != "备注" {
		t.Fatalf("metadata get failed: %+v", got)
	}
}
