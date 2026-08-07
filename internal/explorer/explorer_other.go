//go:build !windows

package explorer

import "errors"

// ShowFiles is not supported on non-Windows platforms.
func ShowFiles(paths []string) error {
	return errors.New("show files in explorer is only supported on Windows")
}
