package license

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// DeviceFingerprint returns a stable hardware-bound identifier for the current machine.
func DeviceFingerprint() string {
	var parts []string

	hostname, _ := os.Hostname()
	parts = append(parts, hostname)

	if runtime.GOOS == "windows" {
		parts = append(parts, windowsFingerprintParts()...)
	} else {
		parts = append(parts, fallbackFingerprintParts()...)
	}

	sum := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(sum[:])[:32]
}

func windowsFingerprintParts() []string {
	var parts []string

	parts = append(parts, wmicValue("cpu", "ProcessorId"))
	parts = append(parts, wmicValue("baseboard", "SerialNumber"))
	parts = append(parts, wmicValue("diskdrive", "SerialNumber"))
	parts = append(parts, firstMACAddress())
	parts = append(parts, machineGUID())

	return parts
}

func fallbackFingerprintParts() []string {
	var parts []string
	parts = append(parts, os.Getenv("HOME"))
	parts = append(parts, os.Getenv("USER"))
	parts = append(parts, os.Getenv("HOSTNAME"))
	return parts
}

func wmicValue(className, field string) string {
	cmd := exec.Command("wmic", className, "get", field, "/value")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	prefix := field + "="
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(line, prefix))
		}
	}
	return ""
}

func firstMACAddress() string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if len(iface.HardwareAddr) > 0 {
			return iface.HardwareAddr.String()
		}
	}
	return ""
}

func machineGUID() string {
	if runtime.GOOS != "windows" {
		return ""
	}
	cmd := exec.Command("reg", "query", "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(out))
	if len(fields) >= 3 {
		return fields[len(fields)-1]
	}
	return ""
}
