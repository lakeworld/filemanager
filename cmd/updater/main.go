//go:build windows

// Package main implements a tiny Windows sidecar updater for Qihe File Manager.
// It is spawned by the main application before quitting; its job is to wait for
// the main process to exit, run the downloaded NSIS installer silently, restart
// the application, and then clean itself up.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	pidFlag       = flag.Int("pid", 0, "process ID of the main application to wait for")
	installerFlag = flag.String("installer", "", "path to the downloaded NSIS installer")
	appPathFlag   = flag.String("app", "", "path to the main application executable to restart")
	checksumFlag  = flag.String("checksum", "", "expected sha256 checksum of the installer (optional)")
	delayFlag     = flag.Duration("delay", 3*time.Second, "extra delay after the process exits before running the installer")
	logFlag       = flag.String("log", "", "path to updater log file (default: temp/updater.log)")
)

func main() {
	flag.Parse()

	initLogger()

	if *pidFlag == 0 {
		log.Fatal("--pid is required")
	}
	if *installerFlag == "" {
		log.Fatal("--installer is required")
	}
	if *appPathFlag == "" {
		log.Fatal("--app is required")
	}

	log.Printf("updater started: pid=%d installer=%s app=%s", *pidFlag, *installerFlag, *appPathFlag)

	if err := waitForProcess(*pidFlag); err != nil {
		log.Fatalf("failed to wait for process %d: %v", *pidFlag, err)
	}

	log.Printf("main process exited, waiting %v before install", *delayFlag)
	time.Sleep(*delayFlag)

	if *checksumFlag != "" {
		if err := verifyInstallerChecksum(*installerFlag, *checksumFlag); err != nil {
			log.Fatalf("installer checksum verification failed: %v", err)
		}
		log.Println("installer checksum verified")
	}

	if err := runInstaller(*installerFlag); err != nil {
		log.Fatalf("installer failed: %v", err)
	}
	log.Println("installer completed")

	if err := startApp(*appPathFlag); err != nil {
		log.Fatalf("failed to restart app: %v", err)
	}
	log.Println("app restarted")

	cleanup(*installerFlag)
}

func initLogger() {
	path := *logFlag
	if path == "" {
		path = filepath.Join(os.TempDir(), "qihe-updater.log")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		log.SetOutput(os.Stdout)
		log.Printf("cannot open log file %s: %v", path, err)
		return
	}
	log.SetOutput(f)
}

// waitForProcess waits until the Windows process with the given PID terminates.
func waitForProcess(pid int) error {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		// If the process has already exited, OpenProcess fails; that is fine.
		if err == windows.ERROR_INVALID_PARAMETER {
			return nil
		}
		return fmt.Errorf("OpenProcess: %w", err)
	}
	defer windows.CloseHandle(handle)

	waitEvent, err := windows.WaitForSingleObject(handle, windows.INFINITE)
	if err != nil {
		return fmt.Errorf("WaitForSingleObject: %w", err)
	}
	if waitEvent != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("unexpected wait event: %d", waitEvent)
	}
	return nil
}

// verifyInstallerChecksum computes the SHA-256 of the installer and compares it
// with the expected value. The expected value may be prefixed with "sha256:".
func verifyInstallerChecksum(path, expected string) error {
	expected = stripPrefix(expected, "sha256:")

	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	actual := hex.EncodeToString(h.Sum(nil))
	if actual != expected {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expected, actual)
	}
	return nil
}

// shellExecuteInfo mirrors the SHELLEXECUTEINFOW structure from the Windows SDK.
type shellExecuteInfo struct {
	cbSize       uint32
	fMask        uint32
	hwnd         uintptr
	lpVerb       *uint16
	lpFile       *uint16
	lpParameters *uint16
	lpDirectory  *uint16
	nShow        int32
	hInstApp     uintptr
	lpIDList     uintptr
	lpClass      *uint16
	hkeyClass    uintptr
	dwHotKey     uint32
	hIcon        uintptr
	hProcess     uintptr
}

const (
	seeMaskNoCloseProcess = 0x00000040
	swHide                = 0
)

var (
	shell32             = syscall.NewLazyDLL("shell32.dll")
	procShellExecuteExW = shell32.NewProc("ShellExecuteExW")
)

// runInstaller executes the NSIS installer silently with the /S flag.
// It uses ShellExecuteExW with the "runas" verb so Windows shows a UAC prompt
// and the installer can write to Program Files.
func runInstaller(path string) error {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve installer path: %w", err)
	}

	verb, err := windows.UTF16PtrFromString("runas")
	if err != nil {
		return fmt.Errorf("encode verb: %w", err)
	}
	file, err := windows.UTF16PtrFromString(absPath)
	if err != nil {
		return fmt.Errorf("encode path: %w", err)
	}
	params, err := windows.UTF16PtrFromString("/S")
	if err != nil {
		return fmt.Errorf("encode params: %w", err)
	}

	sei := &shellExecuteInfo{
		cbSize:       uint32(unsafe.Sizeof(shellExecuteInfo{})),
		fMask:        seeMaskNoCloseProcess,
		lpVerb:       verb,
		lpFile:       file,
		lpParameters: params,
		nShow:        swHide,
	}

	ret, _, err := procShellExecuteExW.Call(uintptr(unsafe.Pointer(sei)))
	if ret == 0 {
		return fmt.Errorf("ShellExecuteExW failed: %w", err)
	}
	if sei.hInstApp <= 32 {
		return fmt.Errorf("ShellExecuteExW returned hInstApp=%d", sei.hInstApp)
	}
	if sei.hProcess == 0 {
		return fmt.Errorf("installer did not return a process handle")
	}
	defer windows.CloseHandle(windows.Handle(sei.hProcess))

	waitEvent, err := windows.WaitForSingleObject(windows.Handle(sei.hProcess), windows.INFINITE)
	if err != nil {
		return fmt.Errorf("WaitForSingleObject: %w", err)
	}
	if waitEvent != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("unexpected wait event: %d", waitEvent)
	}
	return nil
}

// startApp launches the main application and immediately detaches.
func startApp(path string) error {
	cmd := exec.Command(path)
	hideWindow(cmd)
	return cmd.Start()
}

// cleanup schedules deletion of the updater executable and the installer after
// a short delay. A running Windows executable cannot delete itself, so we spawn
// a detached cmd.exe process to do the cleanup.
func cleanup(installerPath string) {
	self, err := os.Executable()
	if err != nil {
		log.Printf("cannot determine updater path for cleanup: %v", err)
		return
	}
	self, err = filepath.Abs(self)
	if err != nil {
		log.Printf("cannot resolve updater path: %v", err)
		return
	}

	installerPath, err = filepath.Abs(installerPath)
	if err != nil {
		log.Printf("cannot resolve installer path: %v", err)
	}

	args := []string{
		"/c", "start", "/b", "", "cmd", "/c",
		"timeout", "/t", "3", "/nobreak", ">nul",
		"&&", "del", "\"" + installerPath + "\"",
		"&&", "del", "\"" + self + "\"",
	}
	cmd := exec.Command("cmd", args...)
	cmd.SysProcAttr = &windows.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		log.Printf("failed to schedule cleanup: %v", err)
	}
}

func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &windows.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
}

func stripPrefix(s, prefix string) string {
	if len(s) >= len(prefix) && s[:len(prefix)] == prefix {
		return s[len(prefix):]
	}
	return s
}
