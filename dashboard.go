package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// DashboardStats returns aggregate statistics for the current workspace.
func (a *App) DashboardStats() ApiResult[DashboardStats] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[DashboardStats]("未打开工作区")
	}
	stats := DashboardStats{RecentFiles: []FileEntry{}}

	sets, err := os.ReadDir(filepath.Join(ws, productSetsDir))
	if err != nil {
		return Err[DashboardStats](err.Error())
	}
	stats.TotalProductSets = len(sets)

	var allFiles []FileEntry
	for _, set := range sets {
		if !set.IsDir() {
			continue
		}
		setDir := filepath.Join(ws, productSetsDir, set.Name())
		imgFiles, _ := a.listDirFilesRecursive(filepath.Join(setDir, imagesDir))
		certFiles, _ := a.listDirFilesRecursive(filepath.Join(setDir, "证书"))
		stats.TotalImages += len(imgFiles)
		stats.TotalCerts += len(certFiles)
		allFiles = append(allFiles, imgFiles...)
		allFiles = append(allFiles, certFiles...)
	}

	sort.Slice(allFiles, func(i, j int) bool {
		return allFiles[i].Modified > allFiles[j].Modified
	})
	if len(allFiles) > 10 {
		stats.RecentFiles = allFiles[:10]
	} else {
		stats.RecentFiles = allFiles
	}

	expiring, _ := a.checkExpiringCerts()
	stats.ExpiringCerts = len(expiring)

	return Ok(stats)
}

// CheckExpiringCerts returns certificates expiring within 30 days.
func (a *App) CheckExpiringCerts() ApiResult[[][3]string] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[[][3]string]("未打开工作区")
	}
	result, err := a.checkExpiringCerts()
	if err != nil {
		return Err[[][3]string](err.Error())
	}
	return Ok(result)
}

func (a *App) checkExpiringCerts() ([][3]string, error) {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return nil, nil
	}
	store, err := a.loadMetadataStore()
	if err != nil {
		return nil, err
	}
	threshold := time.Now().AddDate(0, 0, 30)
	var result [][3]string
	for key, meta := range store.Files {
		if strings.TrimSpace(meta.ExpiryDate) == "" {
			continue
		}
		t, err := time.Parse("2006-01-02", meta.ExpiryDate)
		if err != nil {
			continue
		}
		if t.After(threshold) {
			continue
		}
		fileName := filepath.Base(key)
		productSet := filepath.Dir(key)
		result = append(result, [3]string{productSet, fileName, meta.ExpiryDate})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i][2] < result[j][2]
	})
	return result, nil
}
