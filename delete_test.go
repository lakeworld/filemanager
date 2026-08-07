package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProductSetDelete(t *testing.T) {
	tmp := t.TempDir()
	app := NewApp()

	if res := app.WorkspaceCreate(tmp); !res.Success {
		t.Fatalf("create workspace: %s", res.Error)
	}

	// Create product set and import a file.
	if res := app.ProductSetCreate(ProductSetCreateRequest{Name: "待删系列"}); !res.Success {
		t.Fatalf("create product set: %s", res.Error)
	}

	src := filepath.Join(tmp, "dummy.txt")
	if err := os.WriteFile(src, []byte("hello"), 0644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	imp := app.FileImport(ImportFileRequest{
		SourcePaths:      []string{src},
		TargetProductSet: "待删系列",
		TargetType:       "image",
		TargetFolder:     "主图",
		SubFolder:        "主图",
	})
	if !imp.Success {
		t.Fatalf("import file: %s", imp.Error)
	}

	if res := app.MetadataUpdate(MetadataUpdateRequest{
		ProductSet: "待删系列",
		FileName:   imp.Data[0].Name,
		ExpiryDate: "2026-12-31",
		Tags:       []string{"测试"},
	}); !res.Success {
		t.Fatalf("update metadata: %s", res.Error)
	}

	// Delete product set.
	if res := app.ProductSetDelete("待删系列"); !res.Success {
		t.Fatalf("delete product set: %s", res.Error)
	}

	psDir := filepath.Join(tmp, "产品集", "待删系列")
	if _, err := os.Stat(psDir); !os.IsNotExist(err) {
		t.Fatalf("product set dir still exists")
	}

	meta := app.MetadataGet("待删系列", imp.Data[0].Name)
	if !meta.Success {
		t.Fatalf("metadata get failed: %s", meta.Error)
	}
	if meta.Data.AddedAt != "" {
		t.Fatalf("metadata should be removed after product set deletion")
	}
}

func TestDeleteSubfolder(t *testing.T) {
	tmp := t.TempDir()
	app := NewApp()

	if res := app.WorkspaceCreate(tmp); !res.Success {
		t.Fatalf("create workspace: %s", res.Error)
	}

	if res := app.ProductSetCreate(ProductSetCreateRequest{Name: "系列"}); !res.Success {
		t.Fatalf("create product set: %s", res.Error)
	}

	// Create a custom subfolder.
	if res := app.CreateSubfolder(SubfolderCreateRequest{
		ProductSet: "系列",
		FileType:   "cert",
		Name:       "FDA认证",
	}); !res.Success {
		t.Fatalf("create subfolder: %s", res.Error)
	}

	src := filepath.Join(tmp, "dummy.txt")
	if err := os.WriteFile(src, []byte("hello"), 0644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	imp := app.FileImport(ImportFileRequest{
		SourcePaths:      []string{src},
		TargetProductSet: "系列",
		TargetType:       "cert",
		TargetFolder:     "FDA认证",
		SubFolder:        "FDA认证",
	})
	if !imp.Success {
		t.Fatalf("import file: %s", imp.Error)
	}

	if res := app.MetadataUpdate(MetadataUpdateRequest{
		ProductSet: "系列",
		FileName:   imp.Data[0].Name,
		ExpiryDate: "2026-12-31",
	}); !res.Success {
		t.Fatalf("update metadata: %s", res.Error)
	}

	if res := app.DeleteSubfolder(DeleteSubfolderRequest{
		ProductSet: "系列",
		FileType:   "cert",
		Name:       "FDA认证",
	}); !res.Success {
		t.Fatalf("delete subfolder: %s", res.Error)
	}

	subDir := filepath.Join(tmp, "产品集", "系列", "证书", "FDA认证")
	if _, err := os.Stat(subDir); !os.IsNotExist(err) {
		t.Fatalf("subfolder still exists")
	}

	meta := app.MetadataGet("系列", imp.Data[0].Name)
	if !meta.Success {
		t.Fatalf("metadata get failed: %s", meta.Error)
	}
	if meta.Data.AddedAt != "" {
		t.Fatalf("metadata should be removed after subfolder deletion")
	}
}
