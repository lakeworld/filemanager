package explorer

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestShowFiles(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("explorer bridge is Windows-only")
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

	if err := ShowFiles([]string{p1, p2}); err != nil {
		t.Fatalf("ShowFiles failed: %v", err)
	}
}

func TestShowFilesMissing(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("explorer bridge is Windows-only")
	}

	err := ShowFiles([]string{`C:\nonexistent\file.txt`})
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}
