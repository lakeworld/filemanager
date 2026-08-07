//go:build windows

package updater

import _ "embed"

//go:embed updater_windows_amd64.exe
var updaterBinary []byte
