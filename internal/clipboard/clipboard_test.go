package clipboard

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCopyFiles(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("clipboard copy is Windows-only")
	}

	dir := t.TempDir()
	p1 := filepath.Join(dir, "test1.txt")
	p2 := filepath.Join(dir, "test2.txt")
	if err := os.WriteFile(p1, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p2, []byte("world"), 0644); err != nil {
		t.Fatal(err)
	}

	if err := CopyFiles([]string{p1, p2}); err != nil {
		t.Fatalf("CopyFiles failed: %v", err)
	}
}

func TestCopyFilesMissing(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("clipboard copy is Windows-only")
	}

	err := CopyFiles([]string{`C:\nonexistent\file.txt`})
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}
