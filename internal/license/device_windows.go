//go:build windows

package license

import (
	"os/exec"
	"syscall"
)

// hideWindow prevents console windows from flashing when running WMIC/REG
// inside a GUI Wails application on Windows.
func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
}
