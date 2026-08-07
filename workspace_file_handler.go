package main

import (
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const workspaceFilesPrefix = "/workspace-files"

// workspaceFileHandler serves files from the current workspace via the Wails AssetServer.
// This allows the frontend to preview images, PDFs and videos using normal URLs
// instead of huge base64 data URLs, which WebView2 struggles with for large files.
type workspaceFileHandler struct {
	app *App
}

func newWorkspaceFileHandler(app *App) *workspaceFileHandler {
	return &workspaceFileHandler{app: app}
}

func (h *workspaceFileHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ws := h.app.currentWorkspacePath()
	if ws == "" {
		http.Error(w, "no workspace open", http.StatusServiceUnavailable)
		return
	}

	encoded := strings.TrimPrefix(r.URL.Path, workspaceFilesPrefix)
	encoded = strings.TrimPrefix(encoded, "/")
	if encoded == "" {
		// Support query parameter fallback, e.g. /workspace-files?p=base64
		encoded = r.URL.Query().Get("p")
	}
	if encoded == "" {
		http.Error(w, "missing file parameter", http.StatusBadRequest)
		return
	}

	filePathBytes, err := base64.URLEncoding.DecodeString(encoded)
	if err != nil {
		http.Error(w, "invalid file parameter", http.StatusBadRequest)
		return
	}
	filePath := string(filePathBytes)
	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		http.Error(w, "empty file path", http.StatusBadRequest)
		return
	}

	if !strings.HasPrefix(filepath.Clean(filePath), filepath.Clean(ws)) {
		http.Error(w, "file outside workspace", http.StatusForbidden)
		return
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", mimeTypeForPath(filePath))
	w.Write(data)
}

func mimeTypeForPath(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".tiff", ".tif":
		return "image/tiff"
	case ".pdf":
		return "application/pdf"
	case ".mp4":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mov":
		return "video/quicktime"
	case ".avi":
		return "video/x-msvideo"
	default:
		return "application/octet-stream"
	}
}

// workspaceFileURL returns a URL that the frontend can use to load the given workspace file.
func workspaceFileURL(filePath string) string {
	encoded := base64.URLEncoding.EncodeToString([]byte(filePath))
	return workspaceFilesPrefix + "/" + encoded
}
