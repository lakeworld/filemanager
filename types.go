package main

import "time"

// ApiResult is the uniform response envelope exposed to the frontend.
type ApiResult[T any] struct {
	Success bool   `json:"success"`
	Data    T      `json:"data"`
	Error   string `json:"error"`
}

func Ok[T any](data T) ApiResult[T] {
	return ApiResult[T]{Success: true, Data: data}
}

func Err[T any](err string) ApiResult[T] {
	var zero T
	return ApiResult[T]{Success: false, Data: zero, Error: err}
}

func ErrResult(err string) ApiResult[any] {
	return ApiResult[any]{Success: false, Data: nil, Error: err}
}

// NamingTemplate controls automatic file/folder naming.
type NamingTemplate struct {
	ProductSetPrefix string   `json:"product_set_prefix"`
	ProductSetSuffix string   `json:"product_set_suffix"`
	SkuSeparator     string   `json:"sku_separator"`
	SkuFields        []string `json:"sku_fields"`
	ConflictSuffix   string   `json:"conflict_suffix"`
}

// WorkspaceConfig is persisted in <workspace>/.qihefilemanager/config.json.
type WorkspaceConfig struct {
	Name            string         `json:"name"`
	NamingTemplate  NamingTemplate `json:"naming_template"`
	ImageSubfolders []string       `json:"image_subfolders"`
	CertSubfolders  []string       `json:"cert_subfolders"`
}

// WorkspaceInfo is returned to the frontend.
type WorkspaceInfo struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
}

// ProductSetInfo describes a product set folder under 产品集/.
type ProductSetInfo struct {
	Name       string   `json:"name"`
	ImageCount int      `json:"image_count"`
	CertCount  int      `json:"cert_count"`
	CreatedAt  string   `json:"created_at"`
	Tags       []string `json:"tags"`
	Notes      string   `json:"notes"`
}

// ProductSetStats returns per-type counts for a product set.
type ProductSetStats struct {
	ImageCount int    `json:"image_count"`
	CertCount  int    `json:"cert_count"`
	CreatedAt  string `json:"created_at"`
}

// FileEntry is a file shown in the file browser.
type FileEntry struct {
	Name          string `json:"name"`
	Path          string `json:"path"`
	Size          int64  `json:"size"`
	Modified      string `json:"modified"`
	FileType      string `json:"file_type"`
	ThumbnailPath string `json:"thumbnail_path"`
}

// FileMetadata is persisted in the workspace metadata store.
type FileMetadata struct {
	CertType   string   `json:"cert_type"`
	ExpiryDate string   `json:"expiry_date"`
	Tags       []string `json:"tags"`
	Notes      string   `json:"notes"`
	AddedAt    string   `json:"added_at"`
}

// DashboardStats is returned for the home dashboard.
type DashboardStats struct {
	TotalProductSets int         `json:"total_product_sets"`
	TotalImages      int         `json:"total_images"`
	TotalCerts       int         `json:"total_certs"`
	ExpiringCerts    int         `json:"expiring_certs"`
	RecentFiles      []FileEntry `json:"recent_files"`
}

// SearchResult groups results from a global search.
type SearchResult struct {
	Files       []FileEntry      `json:"files"`
	ProductSets []ProductSetInfo `json:"product_sets"`
}

// ImportFileRequest is sent when importing dragged/selected files.
type ImportFileRequest struct {
	SourcePaths      []string `json:"source_paths"`
	TargetProductSet string   `json:"target_product_set"`
	TargetFolder     string   `json:"target_folder"`
	TargetType       string   `json:"target_type"`
	SubFolder        string   `json:"sub_folder"`
}

// FileListRequest selects a slice of files.
type FileListRequest struct {
	ProductSet string `json:"product_set"`
	FileType   string `json:"file_type"`
	SubFolder  string `json:"sub_folder"`
}

// MetadataKey identifies a file for metadata lookup.
type MetadataKey struct {
	ProductSet string `json:"product_set"`
	FileName   string `json:"file_name"`
}

// MetadataUpdateRequest updates metadata for one file.
type MetadataUpdateRequest struct {
	ProductSet string   `json:"product_set"`
	FileName   string   `json:"file_name"`
	CertType   string   `json:"cert_type"`
	ExpiryDate string   `json:"expiry_date"`
	Tags       []string `json:"tags"`
	Notes      string   `json:"notes"`
}

// FileRenameRequest renames a single file within the workspace.
type FileRenameRequest struct {
	Path    string `json:"path"`
	NewName string `json:"newName"`
}

// SubfolderCreateRequest creates a custom sub-folder.
type SubfolderCreateRequest struct {
	ProductSet string `json:"product_set"`
	FileType   string `json:"file_type"`
	Name       string `json:"name"`
}

// DeleteSubfolderRequest deletes an image or certificate sub-folder.
type DeleteSubfolderRequest struct {
	ProductSet string `json:"product_set"`
	FileType   string `json:"file_type"`
	Name       string `json:"name"`
}

// ProductSetCreateRequest creates a product set.
type ProductSetCreateRequest struct {
	Name  string   `json:"name"`
	Tags  []string `json:"tags"`
	Notes string   `json:"notes"`
}

// ProductSetUpdateRequest updates a product set's tags and notes.
type ProductSetUpdateRequest struct {
	Name  string   `json:"name"`
	Tags  []string `json:"tags"`
	Notes string   `json:"notes"`
}

// LicenseInfo describes an activated license.
type LicenseInfo struct {
	License      string `json:"license"`
	Email        string `json:"email"`
	Type         string `json:"type"`
	ActivatedAt  string `json:"activated_at"`
	Fingerprint  string `json:"fingerprint"`
	IsTrial      bool   `json:"is_trial"`
	ExpiresAt    string `json:"expires_at"`
	TrialExpired bool   `json:"trial_expired"`
	DaysLeft     int    `json:"days_left"`
}

// LicenseStatus is returned by LicenseCheck.
type LicenseStatus struct {
	Activated bool        `json:"activated"`
	Info      LicenseInfo `json:"info"`
}

// LicenseActivateRequest is sent from the frontend to activate a license.
type LicenseActivateRequest struct {
	License string `json:"license"`
	Email   string `json:"email"`
	Code    string `json:"code"`
}

// UpdateInfo describes a new version available on the server.
type UpdateInfo struct {
	Version      string `json:"version"`
	DownloadURL  string `json:"download_url"`
	Checksum     string `json:"checksum"`
	ReleaseNotes string `json:"release_notes"`
}

func formatTime(t time.Time) string {
	return t.Format("2006-01-02 15:04:05")
}
