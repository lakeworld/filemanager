package main

import (
	"os"
	"path/filepath"
	"strings"
)

// Search performs a global search across product set names and file names.
func (a *App) Search(query string) ApiResult[SearchResult] {
	ws := a.currentWorkspacePath()
	if ws == "" {
		return Err[SearchResult]("未打开工作区")
	}
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return Ok(SearchResult{Files: []FileEntry{}, ProductSets: []ProductSetInfo{}})
	}

	result := SearchResult{
		Files:       []FileEntry{},
		ProductSets: []ProductSetInfo{},
	}
	seenSet := make(map[string]bool)

	sets, err := os.ReadDir(filepath.Join(ws, productSetsDir))
	if err != nil {
		return Err[SearchResult](err.Error())
	}
	for _, set := range sets {
		if !set.IsDir() {
			continue
		}
		setName := set.Name()
		setMatched := strings.Contains(strings.ToLower(setName), query)
		if setMatched {
			info, _ := set.Info()
			result.ProductSets = append(result.ProductSets, ProductSetInfo{
				Name:       setName,
				ImageCount: a.countFiles(filepath.Join(ws, productSetsDir, setName, imagesDir)),
				CertCount:  a.countFiles(filepath.Join(ws, productSetsDir, setName, "证书")),
				CreatedAt:  formatTime(info.ModTime()),
			})
			seenSet[setName] = true
		}

		imgFiles, _ := a.listDirFilesRecursive(filepath.Join(ws, productSetsDir, setName, imagesDir))
		certFiles, _ := a.listDirFilesRecursive(filepath.Join(ws, productSetsDir, setName, "证书"))
		for _, f := range append(imgFiles, certFiles...) {
			if strings.Contains(strings.ToLower(f.Name), query) {
				result.Files = append(result.Files, f)
				if !seenSet[setName] {
					info, _ := set.Info()
					result.ProductSets = append(result.ProductSets, ProductSetInfo{
						Name:       setName,
						ImageCount: a.countFiles(filepath.Join(ws, productSetsDir, setName, imagesDir)),
						CertCount:  a.countFiles(filepath.Join(ws, productSetsDir, setName, "证书")),
						CreatedAt:  formatTime(info.ModTime()),
					})
					seenSet[setName] = true
				}
			}
		}
	}

	return Ok(result)
}
