//go:build !windows

package main

// ensureSingleInstance always allows startup on non-Windows platforms.
func ensureSingleInstance() bool {
	return true
}
