//go:build !windows

package clipboard

import "errors"

// CopyFiles is not supported on non-Windows platforms.
func CopyFiles(paths []string) error {
	return errors.New("clipboard file copy is only supported on Windows")
}
