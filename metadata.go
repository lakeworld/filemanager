package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type workspaceMetadataStore struct {
	Files map[string]FileMetadata `json:"files"`
}

func (a *App) loadMetadataStore() (workspaceMetadataStore, error) {
	ws := a.currentWorkspacePath()
	path := a.metadataPath(ws)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return workspaceMetadataStore{Files: make(map[string]FileMetadata)}, nil
		}
		return workspaceMetadataStore{}, err
	}
	var store workspaceMetadataStore
	if err := json.Unmarshal(data, &store); err != nil {
		return workspaceMetadataStore{}, err
	}
	if store.Files == nil {
		store.Files = make(map[string]FileMetadata)
	}
	return store, nil
}

func (a *App) saveMetadataStore(store workspaceMetadataStore) error {
	if err := a.ensureWorkspaceDirs(a.currentWorkspacePath()); err != nil {
		return err
	}
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(a.metadataPath(a.currentWorkspacePath()), data, 0644)
}

func (a *App) fileMetadataKey(productSet, fileName string) string {
	return filepath.Join(productSet, fileName)
}

// MetadataGet returns metadata for a file.
func (a *App) MetadataGet(productSet, fileName string) ApiResult[FileMetadata] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[FileMetadata]("未打开工作区")
	}
	store, err := a.loadMetadataStore()
	if err != nil {
		return Err[FileMetadata](err.Error())
	}
	key := a.fileMetadataKey(productSet, fileName)
	meta, ok := store.Files[key]
	if !ok {
		return Ok(FileMetadata{
			CertType:   "",
			ExpiryDate: "",
			Tags:       []string{},
			Notes:      "",
			AddedAt:    "",
		})
	}
	return Ok(meta)
}

// MetadataUpdate updates metadata for a file.
func (a *App) MetadataUpdate(req MetadataUpdateRequest) ApiResult[bool] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[bool]("未打开工作区")
	}
	store, err := a.loadMetadataStore()
	if err != nil {
		return Err[bool](err.Error())
	}
	key := a.fileMetadataKey(req.ProductSet, req.FileName)
	existing := store.Files[key]
	if existing.AddedAt == "" {
		existing.AddedAt = currentTimeString()
	}
	existing.CertType = strings.TrimSpace(req.CertType)
	existing.ExpiryDate = strings.TrimSpace(req.ExpiryDate)
	existing.Tags = req.Tags
	existing.Notes = strings.TrimSpace(req.Notes)
	store.Files[key] = existing
	if err := a.saveMetadataStore(store); err != nil {
		return Err[bool](err.Error())
	}
	return Ok(true)
}

func (a *App) setFileMetadata(productSet, fileName string, meta FileMetadata) error {
	store, err := a.loadMetadataStore()
	if err != nil {
		return err
	}
	key := a.fileMetadataKey(productSet, fileName)
	store.Files[key] = meta
	return a.saveMetadataStore(store)
}

// removeFileMetadata removes metadata for a single file.
func (a *App) removeFileMetadata(productSet, fileName string) error {
	store, err := a.loadMetadataStore()
	if err != nil {
		return err
	}
	key := a.fileMetadataKey(productSet, fileName)
	if _, ok := store.Files[key]; !ok {
		return nil
	}
	delete(store.Files, key)
	return a.saveMetadataStore(store)
}

// removeFileMetadataForProductSet removes all metadata entries under a product set.
func (a *App) removeFileMetadataForProductSet(productSet string) error {
	store, err := a.loadMetadataStore()
	if err != nil {
		return err
	}
	prefix := productSet + string(filepath.Separator)
	changed := false
	for key := range store.Files {
		if strings.HasPrefix(key, prefix) {
			delete(store.Files, key)
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return a.saveMetadataStore(store)
}

func currentTimeString() string {
	return time.Now().Format(time.RFC3339)
}
