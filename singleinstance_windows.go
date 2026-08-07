//go:build windows

package main

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const mutexName = "Global\\qihefilemanager-instance"

// ensureSingleInstance returns true if this is the only instance running.
// If another instance is already running, it tries to activate that window
// and returns false so the caller should exit.
func ensureSingleInstance() bool {
	_, err := windows.CreateMutex(nil, false, syscall.StringToUTF16Ptr(mutexName))
	if err != nil {
		if err == windows.ERROR_ALREADY_EXISTS {
			activateExistingWindow()
			return false
		}
	}
	return true
}

func activateExistingWindow() {
	title := syscall.StringToUTF16Ptr("启禾文件管理")
	hwnd := findWindowW(nil, title)
	if hwnd != 0 {
		// SW_RESTORE = 9
		showWindowAsync(hwnd, 9)
		setForegroundWindow(hwnd)
	}
}

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	procFindWindowW         = user32.NewProc("FindWindowW")
	procShowWindowAsync     = user32.NewProc("ShowWindowAsync")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
)

func findWindowW(className, windowName *uint16) uintptr {
	ret, _, _ := procFindWindowW.Call(
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowName)),
	)
	return ret
}

func showWindowAsync(hwnd uintptr, cmdShow int32) {
	_, _, _ = procShowWindowAsync.Call(hwnd, uintptr(cmdShow))
}

func setForegroundWindow(hwnd uintptr) {
	_, _, _ = procSetForegroundWindow.Call(hwnd)
}
