//go:build windows

package explorer

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	ole32   = windows.NewLazySystemDLL("ole32.dll")
	shell32 = windows.NewLazySystemDLL("shell32.dll")

	procCoInitializeEx             = ole32.NewProc("CoInitializeEx")
	procCoUninitialize             = ole32.NewProc("CoUninitialize")
	procCoTaskMemFree              = ole32.NewProc("CoTaskMemFree")
	procSHParseDisplayName         = shell32.NewProc("SHParseDisplayName")
	procSHOpenFolderAndSelectItems = shell32.NewProc("SHOpenFolderAndSelectItems")
)

const (
	coInitApartmentThreaded = 0x2
)

// ShowFiles opens Windows Explorer at the directory containing the given
// files, with those files highlighted/selected. If the files span multiple
// directories, one Explorer window is opened for each directory.
func ShowFiles(paths []string) error {
	if len(paths) == 0 {
		return fmt.Errorf("no files to show")
	}

	absPaths := make([]string, 0, len(paths))
	for _, p := range paths {
		if _, err := os.Stat(p); err != nil {
			return fmt.Errorf("file not accessible %q: %w", p, err)
		}
		abs, err := filepath.Abs(p)
		if err != nil {
			return fmt.Errorf("failed to resolve %q: %w", p, err)
		}
		absPaths = append(absPaths, abs)
	}

	// Group files by directory so SHOpenFolderAndSelectItems can select them.
	groups := make(map[string][]string)
	for _, p := range absPaths {
		dir := filepath.Dir(p)
		groups[dir] = append(groups[dir], p)
	}

	hr, _, _ := procCoInitializeEx.Call(0, coInitApartmentThreaded)
	if hr != 0 && hr != 0x00000001 { // S_OK=0, S_FALSE=1 already initialized
		return fmt.Errorf("CoInitializeEx failed: HRESULT 0x%08X", hr)
	}
	defer procCoUninitialize.Call()

	for dir, files := range groups {
		if err := showFilesInDir(dir, files); err != nil {
			return err
		}
	}
	return nil
}

func showFilesInDir(dir string, files []string) error {
	dirPtr, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return fmt.Errorf("invalid directory %q: %w", dir, err)
	}

	var folderPidl uintptr
	hr, _, _ := procSHParseDisplayName.Call(
		uintptr(unsafe.Pointer(dirPtr)),
		0,
		uintptr(unsafe.Pointer(&folderPidl)),
		0,
		0,
	)
	if hr != 0 || folderPidl == 0 {
		return fmt.Errorf("SHParseDisplayName for folder %q failed: HRESULT 0x%08X", dir, hr)
	}
	defer procCoTaskMemFree.Call(folderPidl)

	filePidls := make([]uintptr, 0, len(files))
	for _, f := range files {
		filePtr, err := syscall.UTF16PtrFromString(f)
		if err != nil {
			freePidls(filePidls)
			return fmt.Errorf("invalid file path %q: %w", f, err)
		}
		var pidl uintptr
		hr, _, _ := procSHParseDisplayName.Call(
			uintptr(unsafe.Pointer(filePtr)),
			0,
			uintptr(unsafe.Pointer(&pidl)),
			0,
			0,
		)
		if hr != 0 || pidl == 0 {
			freePidls(filePidls)
			return fmt.Errorf("SHParseDisplayName for file %q failed: HRESULT 0x%08X", f, hr)
		}
		filePidls = append(filePidls, pidl)
	}
	defer freePidls(filePidls)

	var pidlArrayPtr unsafe.Pointer
	if len(filePidls) > 0 {
		pidlArrayPtr = unsafe.Pointer(&filePidls[0])
	}

	hr, _, _ = procSHOpenFolderAndSelectItems.Call(
		folderPidl,
		uintptr(len(filePidls)),
		uintptr(pidlArrayPtr),
		0,
	)
	if hr != 0 {
		return fmt.Errorf("SHOpenFolderAndSelectItems failed: HRESULT 0x%08X", hr)
	}
	return nil
}

func freePidls(pidls []uintptr) {
	for _, p := range pidls {
		if p != 0 {
			procCoTaskMemFree.Call(p)
		}
	}
}
