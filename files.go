package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"certmanager/internal/clipboard"
	"certmanager/internal/explorer"

	"github.com/nfnt/resize"
	"github.com/pkg/browser"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const thumbnailDir = ".thumbnails"

func (a *App) productSetRootPath(productSet string) string {
	return filepath.Join(a.currentWorkspacePath(), productSetsDir, productSet)
}

func (a *App) targetDir(req ImportFileRequest) string {
	if req.TargetType == "image" {
		return filepath.Join(a.productSetRootPath(req.TargetProductSet), imagesDir, req.SubFolder)
	}
	return filepath.Join(a.productSetRootPath(req.TargetProductSet), "证书", req.SubFolder)
}

type fileWithTime struct {
	entry FileEntry
	mod   time.Time
}

func (a *App) listDirFiles(dir string) ([]FileEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []FileEntry{}, nil
		}
		return nil, err
	}
	items := make([]fileWithTime, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		path := filepath.Join(dir, name)
		thumb := a.thumbnailUrl(path)
		items = append(items, fileWithTime{
			entry: FileEntry{
				Name:          name,
				Path:          path,
				Size:          info.Size(),
				Modified:      formatTime(info.ModTime()),
				FileType:      classifyFileType(name),
				ThumbnailPath: thumb,
			},
			mod: info.ModTime(),
		})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].mod.After(items[j].mod)
	})
	files := make([]FileEntry, len(items))
	for i, it := range items {
		files[i] = it.entry
	}
	return files, nil
}

// thumbnailUrl returns the thumbnail path only if the thumbnail file actually exists.
func (a *App) thumbnailUrl(filePath string) string {
	thumb := a.thumbnailPath(filePath)
	if _, err := os.Stat(thumb); err == nil {
		return thumb
	}
	return ""
}

func classifyFileType(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff":
		return "image"
	case ".pdf":
		return "pdf"
	case ".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v":
		return "video"
	default:
		return "other"
	}
}

// listDirFilesRecursive walks a directory recursively and returns all non-hidden files.
func (a *App) listDirFilesRecursive(dir string) ([]FileEntry, error) {
	var items []fileWithTime
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		thumb := a.thumbnailUrl(path)
		items = append(items, fileWithTime{
			entry: FileEntry{
				Name:          name,
				Path:          path,
				Size:          info.Size(),
				Modified:      formatTime(info.ModTime()),
				FileType:      classifyFileType(name),
				ThumbnailPath: thumb,
			},
			mod: info.ModTime(),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].mod.After(items[j].mod)
	})
	files := make([]FileEntry, len(items))
	for i, it := range items {
		files[i] = it.entry
	}
	return files, nil
}

// FileList returns files inside a product set sub-folder.
func (a *App) FileList(req FileListRequest) ApiResult[[]FileEntry] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[[]FileEntry]("未打开工作区")
	}
	var dir string
	if req.FileType == "image" {
		dir = filepath.Join(ws, productSetsDir, req.ProductSet, imagesDir, req.SubFolder)
	} else {
		dir = filepath.Join(ws, productSetsDir, req.ProductSet, "证书", req.SubFolder)
	}
	files, err := a.listDirFiles(dir)
	if err != nil {
		return Err[[]FileEntry](err.Error())
	}
	return Ok(files)
}

// FileImport copies external files into the workspace asynchronously.
func (a *App) FileImport(req ImportFileRequest) ApiResult[[]FileEntry] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[[]FileEntry]("未打开工作区")
	}
	if len(req.SourcePaths) == 0 {
		return Err[[]FileEntry]("没有选择文件")
	}
	cfg, err := a.loadConfig(ws)
	if err != nil {
		return Err[[]FileEntry](err.Error())
	}
	targetDir := a.targetDir(req)
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return Err[[]FileEntry](err.Error())
	}

	// Test mode: synchronous execution (no context means not running via Wails frontend)
	if a.ctx == nil {
		imported := make([]FileEntry, 0, len(req.SourcePaths))
		for _, src := range req.SourcePaths {
			entry, err := a.importOneFile(src, targetDir, req, cfg)
			if err != nil {
				return Err[[]FileEntry](err.Error())
			}
			imported = append(imported, entry)
		}
		return Ok(imported)
	}

	// Production mode: run in background goroutine to avoid blocking the frontend
	go func() {
		runtime.LogInfof(a.ctx, "开始导入 %d 个文件到 %s", len(req.SourcePaths), targetDir)
		for i, src := range req.SourcePaths {
			runtime.LogInfof(a.ctx, "导入源文件[%d]: %s", i, src)
		}
		imported := make([]FileEntry, 0, len(req.SourcePaths))
		for _, src := range req.SourcePaths {
			entry, err := a.importOneFile(src, targetDir, req, cfg)
			if err != nil {
				runtime.LogErrorf(a.ctx, "导入失败: %v", err)
				runtime.EventsEmit(a.ctx, "import:complete", map[string]interface{}{
					"success": false,
					"error":   err.Error(),
					"count":   len(imported),
				})
				return
			}
			imported = append(imported, entry)
		}
		runtime.LogInfof(a.ctx, "导入完成 %d 个文件", len(imported))
		runtime.EventsEmit(a.ctx, "import:complete", map[string]interface{}{
			"success": true,
			"count":   len(imported),
		})
	}()

	return Ok([]FileEntry{})
}

func (a *App) importOneFile(srcPath, targetDir string, req ImportFileRequest, cfg WorkspaceConfig) (FileEntry, error) {
	srcPath = strings.TrimSpace(srcPath)
	if srcPath == "" {
		return FileEntry{}, fmt.Errorf("源路径为空")
	}
	// Some drag sources may provide file:// URLs or forward-slash paths.
	srcPath = strings.TrimPrefix(srcPath, "file://")
	srcPath = strings.TrimPrefix(srcPath, "file:///")
	srcPath = filepath.Clean(srcPath)
	srcInfo, err := os.Stat(srcPath)
	if err != nil {
		return FileEntry{}, fmt.Errorf("无法访问源文件 '%s': %w", srcPath, err)
	}
	if srcInfo.IsDir() {
		return FileEntry{}, fmt.Errorf("不支持导入目录: %s", srcPath)
	}
	ext := strings.ToLower(filepath.Ext(srcPath))
	base := strings.TrimSuffix(filepath.Base(srcPath), ext)
	base = sanitizeName(base)

	// Compose target name based on naming template
	prefix := cfg.NamingTemplate.ProductSetPrefix
	suffix := cfg.NamingTemplate.ProductSetSuffix
	sep := cfg.NamingTemplate.SkuSeparator
	if sep == "" {
		sep = "_"
	}

	fieldMap := map[string]string{
		"product_set":   req.TargetProductSet,
		"sub_folder":    req.SubFolder,
		"original_name": base,
	}
	parts := []string{}
	if prefix != "" {
		parts = append(parts, prefix)
	}
	for _, f := range cfg.NamingTemplate.SkuFields {
		if v, ok := fieldMap[f]; ok && v != "" {
			parts = append(parts, v)
		}
	}
	if suffix != "" {
		parts = append(parts, suffix)
	}
	if len(parts) == 0 {
		parts = append(parts, base)
	}
	candidate := strings.Join(parts, sep) + ext

	// Conflict resolution
	destPath := filepath.Join(targetDir, candidate)
	if _, err := os.Stat(destPath); err == nil {
		conflict := cfg.NamingTemplate.ConflictSuffix
		if conflict == "" {
			conflict = "_{n}"
		}
		for i := 1; ; i++ {
			suffixPart := strings.ReplaceAll(conflict, "{n}", fmt.Sprintf("%d", i))
			candidate = strings.TrimSuffix(candidate, ext) + suffixPart + ext
			destPath = filepath.Join(targetDir, candidate)
			if _, err := os.Stat(destPath); os.IsNotExist(err) {
				break
			}
		}
	}

	if err := copyFile(srcPath, destPath); err != nil {
		return FileEntry{}, err
	}

	// Generate thumbnail for images
	thumb := a.ensureThumbnail(destPath)

	// Record metadata
	fileMeta := FileMetadata{
		Tags:    []string{},
		Notes:   "",
		AddedAt: time.Now().Format(time.RFC3339),
	}
	_ = a.setFileMetadata(req.TargetProductSet, filepath.Base(destPath), fileMeta)

	info, _ := os.Stat(destPath)
	return FileEntry{
		Name:          filepath.Base(destPath),
		Path:          destPath,
		Size:          info.Size(),
		Modified:      formatTime(info.ModTime()),
		FileType:      classifyFileType(destPath),
		ThumbnailPath: thumb,
	}, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func sanitizeName(name string) string {
	replacer := strings.NewReplacer(
		"\\", "_",
		"/", "_",
		":", "_",
		"*", "_",
		"?", "_",
		"\"", "_",
		"<", "_",
		">", "_",
		"|", "_",
	)
	return strings.TrimSpace(replacer.Replace(name))
}

// FileDelete removes one or more files from the workspace.
func (a *App) FileDelete(paths []string) ApiResult[bool] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[bool]("未打开工作区")
	}
	for _, p := range paths {
		if !strings.HasPrefix(filepath.Clean(p), filepath.Clean(ws)) {
			return Err[bool]("只能删除工作区内的文件")
		}
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return Err[bool](err.Error())
		}
		// remove thumbnail if present
		thumb := a.thumbnailPath(p)
		_ = os.Remove(thumb)
	}
	return Ok(true)
}

// CreateSubfolder creates a new image or certificate sub-folder under a product set.
func (a *App) CreateSubfolder(req SubfolderCreateRequest) ApiResult[bool] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[bool]("未打开工作区")
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return Err[bool]("名称不能为空")
	}
	cfg, err := a.loadConfig(ws)
	if err != nil {
		return Err[bool](err.Error())
	}

	var dir string
	if req.FileType == "cert" {
		dir = filepath.Join(ws, productSetsDir, req.ProductSet, "证书", req.Name)
	} else {
		dir = filepath.Join(ws, productSetsDir, req.ProductSet, imagesDir, req.Name)
	}
	if _, err := os.Stat(dir); err == nil {
		return Err[bool]("子文件夹已存在")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return Err[bool](err.Error())
	}
	if req.FileType == "cert" {
		cfg.CertSubfolders = append(cfg.CertSubfolders, req.Name)
	} else {
		cfg.ImageSubfolders = append(cfg.ImageSubfolders, req.Name)
	}
	if err := a.saveConfig(ws, cfg); err != nil {
		return Err[bool](err.Error())
	}
	return Ok(true)
}

// DeleteSubfolder deletes an image or certificate sub-folder under a product set.
func (a *App) DeleteSubfolder(req DeleteSubfolderRequest) ApiResult[bool] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[bool]("未打开工作区")
	}
	req.ProductSet = strings.TrimSpace(req.ProductSet)
	req.Name = strings.TrimSpace(req.Name)
	if req.ProductSet == "" || req.Name == "" {
		return Err[bool]("产品集和子文件夹名称不能为空")
	}
	var dir string
	if req.FileType == "image" {
		dir = filepath.Join(ws, productSetsDir, req.ProductSet, imagesDir, req.Name)
	} else {
		dir = filepath.Join(ws, productSetsDir, req.ProductSet, "证书", req.Name)
	}
	if _, err := os.Stat(dir); err != nil {
		return Err[bool]("子文件夹不存在")
	}
	// Clean up metadata and thumbnails for files in this subfolder only.
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		_ = a.removeFileMetadata(req.ProductSet, d.Name())
		_ = os.Remove(a.thumbnailPath(path))
		return nil
	})
	if err := os.RemoveAll(dir); err != nil {
		return Err[bool](err.Error())
	}
	// Remove the subfolder name from workspace config so it no longer appears in tabs.
	cfg, _ := a.loadConfig(ws)
	if req.FileType == "image" {
		cfg.ImageSubfolders = filterSlice(cfg.ImageSubfolders, req.Name)
	} else {
		cfg.CertSubfolders = filterSlice(cfg.CertSubfolders, req.Name)
	}
	_ = a.saveConfig(ws, cfg)
	return Ok(true)
}

func filterSlice(list []string, item string) []string {
	out := make([]string, 0, len(list))
	for _, v := range list {
		if v != item {
			out = append(out, v)
		}
	}
	return out
}

// RenameProductSet renames a product set folder. Renaming is only allowed when
// the product set contains no files, to avoid breaking metadata and thumbnail
// associations that are keyed by product set name / file path.
func (a *App) RenameProductSet(oldName, newName string) ApiResult[bool] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[bool]("未打开工作区")
	}
	oldName = strings.TrimSpace(oldName)
	newName = strings.TrimSpace(newName)
	if oldName == "" || newName == "" {
		return Err[bool]("名称不能为空")
	}
	oldDir := filepath.Join(ws, productSetsDir, oldName)
	newDir := filepath.Join(ws, productSetsDir, newName)
	if _, err := os.Stat(oldDir); err != nil {
		return Err[bool]("原产品集不存在")
	}
	if _, err := os.Stat(newDir); err == nil {
		return Err[bool]("新产品集已存在")
	}

	// Block rename if any non-hidden files exist under the product set.
	hasFiles := false
	_ = filepath.WalkDir(oldDir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		hasFiles = true
		return filepath.SkipDir // stop early once we find one file
	})
	if hasFiles {
		return Err[bool]("该产品集下已有文件，无法重命名。如需修改名称，请先删除文件或新建空产品集。")
	}

	if err := os.Rename(oldDir, newDir); err != nil {
		return Err[bool](err.Error())
	}

	// Migrate product set extra info (tags/notes) to the new name.
	extra, _ := a.loadProductSetsInfo(ws)
	if info, ok := extra[oldName]; ok {
		extra[newName] = info
		delete(extra, oldName)
		_ = a.saveProductSetsInfo(ws, extra)
	}

	return Ok(true)
}

// productSetFromFilePath extracts the product set name from a file path under
// <workspace>/产品集/<productSet>/... If the file is not under 产品集/, it
// returns an empty string.
func productSetFromFilePath(ws, filePath string) string {
	base := filepath.Join(filepath.Clean(ws), productSetsDir)
	rel, err := filepath.Rel(base, filePath)
	if err != nil || strings.HasPrefix(rel, "..") {
		return ""
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) > 0 && parts[0] != "." {
		return parts[0]
	}
	return ""
}

// FileRename renames a single file within the workspace and migrates its
// metadata and thumbnail associations.
func (a *App) FileRename(req FileRenameRequest) ApiResult[bool] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[bool]("未打开工作区")
	}

	oldPath := strings.TrimSpace(req.Path)
	newName := strings.TrimSpace(req.NewName)
	if oldPath == "" || newName == "" {
		return Err[bool]("路径和名称不能为空")
	}

	oldPath = filepath.Clean(oldPath)
	wsClean := filepath.Clean(ws)
	if !strings.HasPrefix(oldPath, wsClean+string(filepath.Separator)) && oldPath != wsClean {
		return Err[bool]("只能重命名工作区内的文件")
	}

	if strings.ContainsAny(newName, "/\\") {
		return Err[bool]("文件名不能包含路径分隔符")
	}

	oldName := filepath.Base(oldPath)
	if oldName == newName {
		return Ok(true)
	}

	newPath := filepath.Join(filepath.Dir(oldPath), newName)
	if _, err := os.Stat(newPath); err == nil {
		return Err[bool]("目标文件已存在")
	}
	if _, err := os.Stat(oldPath); err != nil {
		return Err[bool]("原文件不存在")
	}

	if err := os.Rename(oldPath, newPath); err != nil {
		return Err[bool](err.Error())
	}

	// Migrate metadata keyed by productSet/fileName.
	productSet := productSetFromFilePath(ws, oldPath)
	if productSet != "" {
		meta, _ := a.loadMetadataStore()
		oldKey := a.fileMetadataKey(productSet, oldName)
		if m, ok := meta.Files[oldKey]; ok {
			newKey := a.fileMetadataKey(productSet, newName)
			meta.Files[newKey] = m
			delete(meta.Files, oldKey)
			_ = a.saveMetadataStore(meta)
		}
	}

	// Remove old thumbnail and regenerate for images.
	oldThumb := a.thumbnailPath(oldPath)
	if oldThumb != "" {
		_ = os.Remove(oldThumb)
	}
	if classifyFileType(newPath) == "image" {
		_ = a.ensureThumbnail(newPath)
	}

	return Ok(true)
}

func (a *App) thumbnailRoot() string {
	return filepath.Join(a.currentWorkspacePath(), appDataDir, thumbnailDir)
}

func (a *App) thumbnailPath(filePath string) string {
	sum := sha256.Sum256([]byte(filePath))
	key := hex.EncodeToString(sum[:16])
	ext := strings.ToLower(filepath.Ext(filePath))
	return filepath.Join(a.thumbnailRoot(), key[:2], key+ext+".thumb.jpg")
}

func (a *App) ensureThumbnail(filePath string) string {
	if classifyFileType(filePath) != "image" {
		return ""
	}
	thumb := a.thumbnailPath(filePath)
	if info, err := os.Stat(thumb); err == nil {
		srcInfo, err := os.Stat(filePath)
		if err == nil && info.ModTime().After(srcInfo.ModTime()) {
			return thumb
		}
	}
	if err := os.MkdirAll(filepath.Dir(thumb), 0755); err != nil {
		return ""
	}
	f, err := os.Open(filePath)
	if err != nil {
		return ""
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return ""
	}
	thumbImg := resize.Thumbnail(256, 256, img, resize.Lanczos3)
	out, err := os.Create(thumb)
	if err != nil {
		return ""
	}
	defer out.Close()
	if err := jpeg.Encode(out, thumbImg, &jpeg.Options{Quality: 85}); err != nil {
		return ""
	}
	return thumb
}

// GetFileDataUrl reads a local file and returns it as a base64 data URL.
func (a *App) GetFileDataUrl(filePath string) ApiResult[string] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[string]("未打开工作区")
	}
	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		return Err[string]("路径不能为空")
	}
	if !strings.HasPrefix(filepath.Clean(filePath), filepath.Clean(ws)) {
		return Err[string]("只能访问工作区内的文件")
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		return Err[string](err.Error())
	}
	mime := "application/octet-stream"
	switch strings.ToLower(filepath.Ext(filePath)) {
	case ".jpg", ".jpeg":
		mime = "image/jpeg"
	case ".png":
		mime = "image/png"
	case ".gif":
		mime = "image/gif"
	case ".webp":
		mime = "image/webp"
	case ".pdf":
		mime = "application/pdf"
	}
	b64 := base64.StdEncoding.EncodeToString(data)
	return Ok(fmt.Sprintf("data:%s;base64,%s", mime, b64))
}

// GetWorkspaceFileUrl returns a URL for loading a workspace file through the Wails AssetServer.
// This is more efficient than base64 data URLs for large images, PDFs and videos.
func (a *App) GetWorkspaceFileUrl(filePath string) ApiResult[string] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[string]("未打开工作区")
	}
	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		return Err[string]("路径不能为空")
	}
	if !strings.HasPrefix(filepath.Clean(filePath), filepath.Clean(ws)) {
		return Err[string]("只能访问工作区内的文件")
	}
	return Ok(workspaceFileURL(filePath))
}

// OpenFileWithDefaultApp opens the given file with the system's default application.
func (a *App) OpenFileWithDefaultApp(filePath string) ApiResult[bool] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[bool]("未打开工作区")
	}
	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		return Err[bool]("路径不能为空")
	}
	if !strings.HasPrefix(filepath.Clean(filePath), filepath.Clean(ws)) {
		return Err[bool]("只能打开工作区内的文件")
	}
	if err := browser.OpenFile(filePath); err != nil {
		return Err[bool](err.Error())
	}
	return Ok(true)
}

// SaveTextFile saves text content to a file (outside workspace allowed for user-selected export paths).
func (a *App) SaveTextFile(filePath string, content string) ApiResult[bool] {
	if err := os.WriteFile(filePath, []byte(content), 0644); err != nil {
		return Err[bool](err.Error())
	}
	return Ok(true)
}

// CopyFilesToClipboard places the given workspace files on the clipboard as
// CF_HDROP, allowing the user to paste them into other applications such as
// WeChat or DingTalk with Ctrl+V.
func (a *App) CopyFilesToClipboard(paths []string) ApiResult[bool] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[bool]("未打开工作区")
	}
	if len(paths) == 0 {
		return Err[bool]("没有选择文件")
	}
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			return Err[bool]("存在空路径")
		}
		if !strings.HasPrefix(filepath.Clean(p), filepath.Clean(ws)) {
			return Err[bool]("只能复制工作区内的文件")
		}
		if _, err := os.Stat(p); err != nil {
			return Err[bool](fmt.Sprintf("文件不可访问: %s", err.Error()))
		}
	}
	if err := clipboard.CopyFiles(paths); err != nil {
		return Err[bool](err.Error())
	}
	return Ok(true)
}

// ShowFilesInExplorer opens Windows Explorer at the directory containing the
// given workspace files, with those files selected. The user can then drag the
// files out to another application.
func (a *App) ShowFilesInExplorer(paths []string) ApiResult[bool] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[bool]("未打开工作区")
	}
	if len(paths) == 0 {
		return Err[bool]("没有选择文件")
	}
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			return Err[bool]("存在空路径")
		}
		if !strings.HasPrefix(filepath.Clean(p), filepath.Clean(ws)) {
			return Err[bool]("只能显示工作区内的文件")
		}
		if _, err := os.Stat(p); err != nil {
			return Err[bool](fmt.Sprintf("文件不可访问: %s", err.Error()))
		}
	}
	if err := explorer.ShowFiles(paths); err != nil {
		return Err[bool](err.Error())
	}
	return Ok(true)
}
