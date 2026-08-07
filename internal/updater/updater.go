// Package updater implements the client-side update logic for Qihe File Manager.
// It is responsible for checking the server-side version feed, downloading the
// installer, verifying its checksum, and spawning the Windows sidecar updater.
package updater

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	updateFeedURL = "https://www.qihebook.cloud/version.json"
	installerName = "qihefilemanager-update.exe"
	updaterName   = "qihe-updater.exe"
	progressEvent = "update:progress"
)

// UpdateInfo describes a new version available on the server.
type UpdateInfo struct {
	Version      string `json:"version"`
	DownloadURL  string `json:"download_url"`
	Checksum     string `json:"checksum"`
	ReleaseNotes string `json:"release_notes"`
}

// Manager coordinates update checks and installations.
type Manager struct {
	ctx context.Context
}

// NewManager creates a new update manager bound to the Wails context.
func NewManager(ctx context.Context) *Manager {
	return &Manager{ctx: ctx}
}

// Check fetches the remote version feed and compares it with the current version.
// It returns nil when the current version is up to date.
func (m *Manager) Check(currentVersion string) (*UpdateInfo, error) {
	req, err := http.NewRequestWithContext(m.ctx, http.MethodGet, updateFeedURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Cache-Control", "no-cache")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch version.json failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("version.json returned %d", resp.StatusCode)
	}

	var info UpdateInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, fmt.Errorf("decode version.json failed: %w", err)
	}

	if info.Version == "" {
		return nil, fmt.Errorf("remote version is empty")
	}

	if !IsNewer(currentVersion, info.Version) {
		return nil, nil
	}

	info.DownloadURL = resolveURL(info.DownloadURL)
	return &info, nil
}

// Download downloads the installer to the system temp directory and reports
// progress through the Wails runtime event "update:progress".
func (m *Manager) Download(info UpdateInfo) (string, error) {
	req, err := http.NewRequestWithContext(m.ctx, http.MethodGet, info.DownloadURL, nil)
	if err != nil {
		return "", err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("download installer failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("installer returned %d", resp.StatusCode)
	}

	tmpDir := os.TempDir()
	installerPath := filepath.Join(tmpDir, installerName)
	out, err := os.Create(installerPath)
	if err != nil {
		return "", fmt.Errorf("create temp installer failed: %w", err)
	}
	defer out.Close()

	total := resp.ContentLength
	written := int64(0)
	buf := make([]byte, 64*1024)
	lastEmit := time.Now()

	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := out.Write(buf[:n]); werr != nil {
				return "", fmt.Errorf("write installer failed: %w", werr)
			}
			written += int64(n)

			if time.Since(lastEmit) > 200*time.Millisecond {
				emitProgress(m.ctx, written, total)
				lastEmit = time.Now()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return "", fmt.Errorf("read installer failed: %w", rerr)
		}
	}

	emitProgress(m.ctx, written, total)

	if info.Checksum != "" {
		if err := VerifyChecksum(installerPath, info.Checksum); err != nil {
			os.Remove(installerPath)
			return "", err
		}
	}

	return installerPath, nil
}

// Apply extracts the embedded updater sidecar, spawns it with the installer
// details, and asks Wails to quit the main application.
func (m *Manager) Apply(installerPath string, checksum string, appPath string) error {
	updaterPath, err := extractUpdater()
	if err != nil {
		return fmt.Errorf("extract updater failed: %w", err)
	}

	if appPath == "" {
		appPath = os.Args[0]
	}
	appPath, err = filepath.Abs(appPath)
	if err != nil {
		return fmt.Errorf("resolve app path failed: %w", err)
	}

	pid := os.Getpid()
	args := []string{
		"--pid", strconv.Itoa(pid),
		"--installer", installerPath,
		"--app", appPath,
		"--delay", "5s",
		"--log", filepath.Join(os.TempDir(), "qihe-updater.log"),
	}
	if checksum != "" {
		args = append(args, "--checksum", checksum)
	}

	cmd := exec.Command(updaterPath, args...)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start updater failed: %w", err)
	}

	runtime.Quit(m.ctx)
	return nil
}

// extractUpdater writes the embedded updater binary to the temp directory.
func extractUpdater() (string, error) {
	tmpDir := os.TempDir()
	updaterPath := filepath.Join(tmpDir, updaterName)
	if err := os.WriteFile(updaterPath, updaterBinary, 0755); err != nil {
		return "", err
	}
	return updaterPath, nil
}

// VerifyChecksum compares the SHA-256 of the file at path with the expected value.
func VerifyChecksum(path, expected string) error {
	expected = stripPrefix(expected, "sha256:")

	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, bufio.NewReader(f)); err != nil {
		return err
	}
	actual := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expected, actual)
	}
	return nil
}

// IsNewer reports whether latest is newer than current using simple semver-like
// comparison. Non-numeric segments are treated as 0 to avoid NaN.
func IsNewer(current, latest string) bool {
	parse := func(v string) []int {
		v = strings.TrimPrefix(strings.TrimPrefix(v, "v"), "V")
		parts := strings.Split(v, ".")
		out := make([]int, 0, len(parts))
		for _, p := range parts {
			if n, err := strconv.Atoi(p); err == nil {
				out = append(out, n)
			} else {
				out = append(out, 0)
			}
		}
		return out
	}

	cur := parse(current)
	lat := parse(latest)
	maxLen := len(cur)
	if len(lat) > maxLen {
		maxLen = len(lat)
	}

	for i := 0; i < maxLen; i++ {
		var a, b int
		if i < len(cur) {
			a = cur[i]
		}
		if i < len(lat) {
			b = lat[i]
		}
		if a < b {
			return true
		}
		if a > b {
			return false
		}
	}
	return false
}

func resolveURL(raw string) string {
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		return raw
	}
	if !strings.HasPrefix(raw, "/") {
		raw = "/" + raw
	}
	return "https://www.qihebook.cloud" + raw
}

func emitProgress(ctx context.Context, current, total int64) {
	pct := 0
	if total > 0 {
		pct = int(float64(current) / float64(total) * 100)
	}
	runtime.EventsEmit(ctx, progressEvent, map[string]any{
		"current": current,
		"total":   total,
		"percent": pct,
	})
}

func stripPrefix(s, prefix string) string {
	if strings.HasPrefix(s, prefix) {
		return s[len(prefix):]
	}
	return s
}
