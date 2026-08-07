//go:build !windows

package license

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}
