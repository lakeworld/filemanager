package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	appDataDir           = ".qihefilemanager"
	configFile           = "config.json"
	metadataFile         = "metadata.json"
	productSetsInfoFile  = "product_sets.json"
	productSetsDir       = "产品集"
	imagesDir            = "图包"
	exportsDir           = "导出"
	recentFile           = ".qihefilemanager_recent.json"
)

// productSetExtraInfo holds editable metadata for a product set.
type productSetExtraInfo struct {
	Tags  []string `json:"tags"`
	Notes string   `json:"notes"`
}

func defaultNamingTemplate() NamingTemplate {
	return NamingTemplate{
		ProductSetPrefix: "",
		ProductSetSuffix: "",
		SkuSeparator:     "_",
		SkuFields:        []string{"product_set", "sub_folder", "original_name"},
		ConflictSuffix:   "_{n}",
	}
}

func defaultWorkspaceConfig() WorkspaceConfig {
	return WorkspaceConfig{
		Name:            "Workspace",
		NamingTemplate:  defaultNamingTemplate(),
		ImageSubfolders: []string{"主图", "详情页", "白底图", "素材"},
		CertSubfolders:  []string{"3C", "质检", "专利"},
	}
}

func (a *App) cmDir(workspace string) string {
	return filepath.Join(workspace, appDataDir)
}

func (a *App) configPath(workspace string) string {
	return filepath.Join(a.cmDir(workspace), configFile)
}

func (a *App) metadataPath(workspace string) string {
	return filepath.Join(a.cmDir(workspace), metadataFile)
}

func (a *App) productSetsInfoPath(workspace string) string {
	return filepath.Join(a.cmDir(workspace), productSetsInfoFile)
}

func (a *App) loadProductSetsInfo(workspace string) (map[string]productSetExtraInfo, error) {
	path := a.productSetsInfoPath(workspace)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return make(map[string]productSetExtraInfo), nil
		}
		return nil, err
	}
	var store map[string]productSetExtraInfo
	if err := json.Unmarshal(data, &store); err != nil {
		return make(map[string]productSetExtraInfo), nil
	}
	if store == nil {
		store = make(map[string]productSetExtraInfo)
	}
	return store, nil
}

func (a *App) saveProductSetsInfo(workspace string, store map[string]productSetExtraInfo) error {
	if err := a.ensureWorkspaceDirs(workspace); err != nil {
		return err
	}
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(a.productSetsInfoPath(workspace), data, 0644)
}

func (a *App) recentPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, recentFile)
}

func (a *App) ensureWorkspaceDirs(workspace string) error {
	dirs := []string{
		a.cmDir(workspace),
		filepath.Join(workspace, productSetsDir),
		filepath.Join(workspace, imagesDir),
		filepath.Join(workspace, "证书"),
		filepath.Join(workspace, exportsDir),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) loadConfig(workspace string) (WorkspaceConfig, error) {
	path := a.configPath(workspace)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			cfg := defaultWorkspaceConfig()
			_ = a.saveConfig(workspace, cfg)
			return cfg, nil
		}
		return WorkspaceConfig{}, err
	}
	var cfg WorkspaceConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return WorkspaceConfig{}, err
	}
	return cfg, nil
}

func (a *App) saveConfig(workspace string, cfg WorkspaceConfig) error {
	if err := a.ensureWorkspaceDirs(workspace); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(a.configPath(workspace), data, 0644)
}

func (a *App) currentWorkspacePath() string {
	if a.currentWS == "" {
		return ""
	}
	return a.currentWS
}

func (a *App) setCurrentWorkspace(workspace string) error {
	if workspace == "" {
		a.currentWS = ""
		return nil
	}
	if _, err := os.Stat(workspace); err != nil {
		return err
	}
	if err := a.ensureWorkspaceDirs(workspace); err != nil {
		return err
	}
	a.currentWS = workspace
	return a.addRecentWorkspace(workspace)
}

func (a *App) addRecentWorkspace(workspace string) error {
	recents, _ := a.loadRecentWorkspaces()
	list := []string{}
	for _, r := range recents {
		if r != workspace {
			list = append(list, r)
		}
	}
	list = append([]string{workspace}, list...)
	if len(list) > 10 {
		list = list[:10]
	}
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(a.recentPath(), data, 0644)
}

func (a *App) loadRecentWorkspaces() ([]string, error) {
	data, err := os.ReadFile(a.recentPath())
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}
	var list []string
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, err
	}
	filtered := make([]string, 0, len(list))
	for _, p := range list {
		if _, err := os.Stat(p); err == nil {
			filtered = append(filtered, p)
		}
	}
	return filtered, nil
}

// WorkspaceList returns recently opened workspaces.
func (a *App) WorkspaceList() ApiResult[[]WorkspaceInfo] {
	paths, err := a.loadRecentWorkspaces()
	if err != nil {
		return Err[[]WorkspaceInfo](err.Error())
	}
	infos := make([]WorkspaceInfo, 0, len(paths))
	for _, p := range paths {
		info, err := a.workspaceInfo(p)
		if err == nil {
			infos = append(infos, info)
		}
	}
	return Ok(infos)
}

func (a *App) workspaceInfo(workspace string) (WorkspaceInfo, error) {
	stat, err := os.Stat(workspace)
	if err != nil {
		return WorkspaceInfo{}, err
	}
	name := filepath.Base(workspace)
	cm := filepath.Join(workspace, appDataDir)
	if s, err := os.Stat(cm); err == nil {
		_ = s
	}
	return WorkspaceInfo{Path: workspace, Name: name, CreatedAt: formatTime(stat.ModTime())}, nil
}

// WorkspaceCurrent returns the currently active workspace.
func (a *App) WorkspaceCurrent() ApiResult[*WorkspaceInfo] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Ok[*WorkspaceInfo](nil)
	}
	info, err := a.workspaceInfo(ws)
	if err != nil {
		return Err[*WorkspaceInfo](err.Error())
	}
	return Ok(&info)
}

// WorkspaceCreate creates a new workspace at the given path.
func (a *App) WorkspaceCreate(path string) ApiResult[WorkspaceInfo] {
	path = strings.TrimSpace(path)
	if path == "" {
		return Err[WorkspaceInfo]("路径不能为空")
	}
	if err := a.ensureWorkspaceDirs(path); err != nil {
		return Err[WorkspaceInfo](err.Error())
	}
	if err := a.saveConfig(path, defaultWorkspaceConfig()); err != nil {
		return Err[WorkspaceInfo](err.Error())
	}
	if err := a.setCurrentWorkspace(path); err != nil {
		return Err[WorkspaceInfo](err.Error())
	}
	info, _ := a.workspaceInfo(path)
	return Ok(info)
}

// WorkspaceOpen opens an existing workspace.
func (a *App) WorkspaceOpen(path string) ApiResult[WorkspaceInfo] {
	path = strings.TrimSpace(path)
	if path == "" {
		return Err[WorkspaceInfo]("路径不能为空")
	}
	if err := a.setCurrentWorkspace(path); err != nil {
		return Err[WorkspaceInfo](err.Error())
	}
	info, err := a.workspaceInfo(path)
	if err != nil {
		return Err[WorkspaceInfo](err.Error())
	}
	return Ok(info)
}

// WorkspaceSwitch switches to a workspace already known in recents.
func (a *App) WorkspaceSwitch(path string) ApiResult[WorkspaceInfo] {
	return a.WorkspaceOpen(path)
}

// GetWorkspaceConfig returns the current workspace config.
func (a *App) GetWorkspaceConfig() ApiResult[WorkspaceConfig] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[WorkspaceConfig]("未打开工作区")
	}
	cfg, err := a.loadConfig(ws)
	if err != nil {
		return Err[WorkspaceConfig](err.Error())
	}
	return Ok(cfg)
}

// UpdateWorkspaceConfig persists the current workspace config.
func (a *App) UpdateWorkspaceConfig(config WorkspaceConfig) ApiResult[WorkspaceConfig] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[WorkspaceConfig]("未打开工作区")
	}
	if err := a.saveConfig(ws, config); err != nil {
		return Err[WorkspaceConfig](err.Error())
	}
	return Ok(config)
}

// ProductSetList lists all product sets in the current workspace.
func (a *App) ProductSetList() ApiResult[[]ProductSetInfo] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[[]ProductSetInfo]("未打开工作区")
	}
	dir := filepath.Join(ws, productSetsDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return Err[[]ProductSetInfo](err.Error())
	}
	extra, _ := a.loadProductSetsInfo(ws)
	sets := make([]ProductSetInfo, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		info, _ := e.Info()
		setName := e.Name()
		ex := extra[setName]
		sets = append(sets, ProductSetInfo{
			Name:       setName,
			ImageCount: a.countFiles(filepath.Join(dir, setName, imagesDir)),
			CertCount:  a.countFiles(filepath.Join(dir, setName, "证书")),
			CreatedAt:  formatTime(info.ModTime()),
			Tags:       ex.Tags,
			Notes:      ex.Notes,
		})
	}
	sort.Slice(sets, func(i, j int) bool { return sets[i].Name < sets[j].Name })
	return Ok(sets)
}

// ProductSetCreate creates a new product set folder with default image and cert subfolders.
func (a *App) ProductSetCreate(req ProductSetCreateRequest) ApiResult[ProductSetInfo] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[ProductSetInfo]("未打开工作区")
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return Err[ProductSetInfo]("名称不能为空")
	}
	dir := filepath.Join(ws, productSetsDir, name)
	if _, err := os.Stat(dir); err == nil {
		return Err[ProductSetInfo]("产品集已存在")
	}
	cfg, err := a.loadConfig(ws)
	if err != nil {
		return Err[ProductSetInfo](err.Error())
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return Err[ProductSetInfo](err.Error())
	}
	for _, sub := range cfg.ImageSubfolders {
		_ = os.MkdirAll(filepath.Join(dir, imagesDir, sub), 0755)
	}
	for _, sub := range cfg.CertSubfolders {
		_ = os.MkdirAll(filepath.Join(dir, "证书", sub), 0755)
	}

	// Persist tags and notes if provided.
	if len(req.Tags) > 0 || strings.TrimSpace(req.Notes) != "" {
		extra, _ := a.loadProductSetsInfo(ws)
		extra[name] = productSetExtraInfo{
			Tags:  req.Tags,
			Notes: strings.TrimSpace(req.Notes),
		}
		_ = a.saveProductSetsInfo(ws, extra)
	}

	info, _ := os.Stat(dir)
	return Ok(ProductSetInfo{Name: name, ImageCount: 0, CertCount: 0, CreatedAt: formatTime(info.ModTime())})
}

// UpdateProductSetInfo updates tags and notes for a product set.
func (a *App) UpdateProductSetInfo(req ProductSetUpdateRequest) ApiResult[bool] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[bool]("未打开工作区")
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return Err[bool]("名称不能为空")
	}
	dir := filepath.Join(ws, productSetsDir, name)
	if _, err := os.Stat(dir); err != nil {
		return Err[bool]("产品集不存在")
	}

	extra, _ := a.loadProductSetsInfo(ws)
	if len(req.Tags) == 0 && strings.TrimSpace(req.Notes) == "" {
		delete(extra, name)
	} else {
		extra[name] = productSetExtraInfo{
			Tags:  req.Tags,
			Notes: strings.TrimSpace(req.Notes),
		}
	}
	if err := a.saveProductSetsInfo(ws, extra); err != nil {
		return Err[bool](err.Error())
	}
	return Ok(true)
}

// ProductSetStats returns image/cert counts for a single product set.
func (a *App) ProductSetStats(name string) ApiResult[ProductSetStats] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[ProductSetStats]("未打开工作区")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return Err[ProductSetStats]("名称不能为空")
	}
	dir := filepath.Join(ws, productSetsDir, name)
	info, err := os.Stat(dir)
	if err != nil {
		return Err[ProductSetStats]("产品集不存在")
	}
	return Ok(ProductSetStats{
		ImageCount: a.countFiles(filepath.Join(dir, imagesDir)),
		CertCount:  a.countFiles(filepath.Join(dir, "证书")),
		CreatedAt:  formatTime(info.ModTime()),
	})
}

// ProductSetDelete deletes a product set folder and all its contents.
func (a *App) ProductSetDelete(name string) ApiResult[bool] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[bool]("未打开工作区")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return Err[bool]("名称不能为空")
	}
	dir := filepath.Join(ws, productSetsDir, name)
	if _, err := os.Stat(dir); err != nil {
		return Err[bool]("产品集不存在")
	}
	if err := a.deleteWorkspaceDir(dir); err != nil {
		return Err[bool](err.Error())
	}
	_ = a.removeFileMetadataForProductSet(name)
	return Ok(true)
}

func (a *App) countFiles(dir string) int {
	c := 0
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() && !strings.HasPrefix(d.Name(), ".") {
			c++
		}
		return nil
	})
	return c
}

// deleteWorkspaceDir removes a directory and its thumbnails.
func (a *App) deleteWorkspaceDir(dir string) error {
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		thumb := a.thumbnailPath(path)
		_ = os.Remove(thumb)
		return nil
	})
	return os.RemoveAll(dir)
}
