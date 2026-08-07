//go:build windows

package clipboard

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")

	procOpenClipboard            = user32.NewProc("OpenClipboard")
	procCloseClipboard           = user32.NewProc("CloseClipboard")
	procEmptyClipboard           = user32.NewProc("EmptyClipboard")
	procSetClipboardData         = user32.NewProc("SetClipboardData")
	procRegisterClipboardFormatW = user32.NewProc("RegisterClipboardFormatW")

	procGlobalAlloc  = kernel32.NewProc("GlobalAlloc")
	procGlobalLock   = kernel32.NewProc("GlobalLock")
	procGlobalUnlock = kernel32.NewProc("GlobalUnlock")
	procGlobalFree   = kernel32.NewProc("GlobalFree")
)

const (
	cfHDrop      = 15 // CF_HDROP
	gmemMoveable = 0x0002

	dropEffectCopy = 1
	dropEffectMove = 2
	dropEffectLink = 4
)

// DROPFILES is the header for the CF_HDROP clipboard format.
type DROPFILES struct {
	pFiles uint32
	ptX    int32
	ptY    int32
	fNC    uint32
	fWide  uint32
}

// CopyFiles places the given file paths onto the Windows clipboard as a
// CF_HDROP object. Most applications that accept files from Explorer (WeChat,
// DingTalk, Outlook, etc.) can then paste them with Ctrl+V.
func CopyFiles(paths []string) error {
	if len(paths) == 0 {
		return fmt.Errorf("no files to copy")
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err != nil {
			return fmt.Errorf("file not accessible %q: %w", p, err)
		}
	}

	hGlobal, err := createHDrop(paths)
	if err != nil {
		return err
	}

	ret, _, _ := procOpenClipboard.Call(0)
	if ret == 0 {
		globalFree(hGlobal)
		return fmt.Errorf("OpenClipboard failed: %w", windows.GetLastError())
	}
	defer procCloseClipboard.Call()

	procEmptyClipboard.Call()

	ret, _, _ = procSetClipboardData.Call(uintptr(cfHDrop), hGlobal)
	if ret == 0 {
		globalFree(hGlobal)
		return fmt.Errorf("SetClipboardData failed: %w", windows.GetLastError())
	}

	// Hint that the operation is a copy, not a move or link.
	_ = setPreferredDropEffect(dropEffectCopy)

	return nil
}

// createHDrop allocates a global memory block containing a DROPFILES structure
// followed by the given file paths as a double-null-terminated Unicode list.
func createHDrop(paths []string) (uintptr, error) {
	hdrSize := uint64(unsafe.Sizeof(DROPFILES{}))

	var listSize uint64
	utf16Lists := make([][]uint16, 0, len(paths))
	for _, p := range paths {
		u, err := windows.UTF16FromString(p)
		if err != nil {
			return 0, fmt.Errorf("invalid path %q: %w", p, err)
		}
		utf16Lists = append(utf16Lists, u)
		listSize += uint64(len(u)) * 2
	}
	listSize += 2 // final extra null terminator

	size := hdrSize + listSize
	hGlobal, err := globalAlloc(gmemMoveable, uintptr(size))
	if err != nil {
		return 0, fmt.Errorf("GlobalAlloc failed: %w", err)
	}

	ptr := globalLock(hGlobal)
	if ptr == nil {
		globalFree(hGlobal)
		return 0, fmt.Errorf("GlobalLock failed")
	}

	df := (*DROPFILES)(ptr)
	df.pFiles = uint32(hdrSize)
	df.ptX = 0
	df.ptY = 0
	df.fNC = 0
	df.fWide = 1

	buf := (*[1 << 30]uint16)(unsafe.Pointer(uintptr(ptr) + uintptr(hdrSize)))
	offset := 0
	for _, u := range utf16Lists {
		for _, c := range u {
			buf[offset] = c
			offset++
		}
	}
	buf[offset] = 0 // final terminating null

	globalUnlock(hGlobal)
	return hGlobal, nil
}

// setPreferredDropEffect writes the "Preferred DropEffect" clipboard format
// so that paste targets default to copy/move/link rather than guessing.
func setPreferredDropEffect(effect uint32) error {
	fmtName, err := syscall.UTF16PtrFromString("Preferred DropEffect")
	if err != nil {
		return err
	}
	fmtID, _, _ := procRegisterClipboardFormatW.Call(uintptr(unsafe.Pointer(fmtName)))
	if fmtID == 0 {
		return fmt.Errorf("RegisterClipboardFormat failed: %w", windows.GetLastError())
	}

	hGlobal, err := globalAlloc(gmemMoveable, unsafe.Sizeof(effect))
	if err != nil {
		return err
	}
	ptr := globalLock(hGlobal)
	if ptr == nil {
		globalFree(hGlobal)
		return fmt.Errorf("GlobalLock failed")
	}
	*(*uint32)(ptr) = effect
	globalUnlock(hGlobal)

	ret, _, _ := procSetClipboardData.Call(fmtID, hGlobal)
	if ret == 0 {
		globalFree(hGlobal)
		return fmt.Errorf("SetClipboardData Preferred DropEffect failed: %w", windows.GetLastError())
	}
	return nil
}

func globalAlloc(flags uint32, size uintptr) (uintptr, error) {
	h, _, err := procGlobalAlloc.Call(uintptr(flags), size)
	if h == 0 {
		return 0, err
	}
	return h, nil
}

func globalLock(h uintptr) unsafe.Pointer {
	ptr, _, _ := procGlobalLock.Call(h)
	if ptr == 0 {
		return nil
	}
	return unsafe.Pointer(ptr)
}

func globalUnlock(h uintptr) {
	procGlobalUnlock.Call(h)
}

func globalFree(h uintptr) {
	procGlobalFree.Call(h)
}
