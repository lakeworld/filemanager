package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"os"
	"sync"

	"certmanager/internal/license"
	"certmanager/internal/updater"

	"fyne.io/systray"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed build/trayicon.ico
var trayIconBytes []byte

//go:embed wails.json
var wailsConfigBytes []byte

// appVersion is resolved at startup from the embedded wails.json.
var appVersion = resolveAppVersion()

func resolveAppVersion() string {
	var cfg struct {
		Info struct {
			ProductVersion string `json:"productVersion"`
		} `json:"info"`
	}
	if err := json.Unmarshal(wailsConfigBytes, &cfg); err == nil && cfg.Info.ProductVersion != "" {
		return cfg.Info.ProductVersion
	}
	return "0.0.0"
}

// App struct
type App struct {
	ctx          context.Context
	currentWS    string
	quitting     bool
	mu           sync.Mutex
	trayOnce     sync.Once
	trayStarted  bool
	trayExitCh   chan struct{}
	licenseMgr   *license.Manager
	updateMgr    *updater.Manager
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called at application startup
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.updateMgr = updater.NewManager(ctx)

	mgr, err := license.NewManager("")
	if err != nil {
		runtime.LogErrorf(ctx, "failed to initialize license manager: %v", err)
	} else {
		a.licenseMgr = mgr
	}

	a.restoreLastWorkspace()
	runtime.WindowSetMinSize(ctx, 1024, 720)
	a.trayOnce.Do(func() {
		a.mu.Lock()
		a.trayStarted = true
		a.trayExitCh = make(chan struct{})
		a.mu.Unlock()
		go systray.Run(a.onSystrayReady, a.onSystrayExit)
	})
}

// restoreLastWorkspace loads the most recent workspace if the app was restarted.
func (a *App) restoreLastWorkspace() {
	recents, err := a.loadRecentWorkspaces()
	if err != nil || len(recents) == 0 {
		return
	}
	last := recents[0]
	if _, err := os.Stat(last); err != nil {
		return
	}
	a.currentWS = last
}

// beforeClose is called when the application is about to quit.
// Hide to tray instead of closing, unless the user explicitly chose Quit from the tray menu.
func (a *App) beforeClose(ctx context.Context) (prevent bool) {
	a.mu.Lock()
	q := a.quitting
	a.mu.Unlock()
	if q {
		return false
	}
	runtime.Hide(ctx)
	return true
}

// shutdown is called at application termination
func (a *App) shutdown(ctx context.Context) {
	a.setQuitting(true)
	a.mu.Lock()
	started := a.trayStarted
	a.mu.Unlock()
	if started {
		systray.Quit()
	}
}

func (a *App) setQuitting(v bool) {
	a.mu.Lock()
	a.quitting = v
	a.mu.Unlock()
}

// onSystrayReady builds the system tray menu.
func (a *App) onSystrayReady() {
	systray.SetIcon(trayIconBytes)
	systray.SetTitle("启禾文件管理")
	systray.SetTooltip("启禾文件管理 - 常驻后台运行中")

	mShow := systray.AddMenuItem("显示主界面", "显示启禾文件管理主窗口")
	mHide := systray.AddMenuItem("隐藏到托盘", "隐藏主窗口，后台运行")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("退出", "完全退出启禾文件管理")

	go func() {
		for {
			select {
			case <-mShow.ClickedCh:
				if a.ctx != nil {
					runtime.Show(a.ctx)
				}
			case <-mHide.ClickedCh:
				if a.ctx != nil {
					runtime.Hide(a.ctx)
				}
			case <-mQuit.ClickedCh:
				a.setQuitting(true)
				if a.ctx != nil {
					runtime.Quit(a.ctx)
				}
			case <-a.trayExitCh:
				return
			}
		}
	}()
}

// onSystrayExit cleans up the system tray resources.
func (a *App) onSystrayExit() {
	a.mu.Lock()
	ch := a.trayExitCh
	a.trayExitCh = nil
	a.mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

// GetAppVersion returns the current application version.
func (a *App) GetAppVersion() string {
	return appVersion
}

// WindowHideToTray hides the main window to the system tray.
func (a *App) WindowHideToTray() {
	if a.ctx == nil {
		return
	}
	runtime.Hide(a.ctx)
}

// WindowShow shows and activates the main window.
func (a *App) WindowShow() {
	if a.ctx == nil {
		return
	}
	runtime.Show(a.ctx)
}

// WindowMinimize minimizes the main window.
func (a *App) WindowMinimize() {
	if a.ctx == nil {
		return
	}
	runtime.WindowMinimise(a.ctx)
}

// WindowToggleMaximize toggles between maximized and normal window state.
func (a *App) WindowToggleMaximize() {
	if a.ctx == nil {
		return
	}
	if runtime.WindowIsMaximised(a.ctx) {
		runtime.WindowUnmaximise(a.ctx)
	} else {
		runtime.WindowMaximise(a.ctx)
	}
}

// WindowIsMaximised reports whether the main window is currently maximized.
func (a *App) WindowIsMaximised() bool {
	if a.ctx == nil {
		return false
	}
	return runtime.WindowIsMaximised(a.ctx)
}

// WindowQuit fully exits the application.
func (a *App) WindowQuit() {
	a.setQuitting(true)
	if a.ctx == nil {
		return
	}
	runtime.Quit(a.ctx)
}

// OpenDirectoryDialog opens a native directory picker.
func (a *App) OpenDirectoryDialog(title string) ApiResult[string] {
	if a.ctx == nil {
		return Err[string]("应用尚未启动")
	}
	selected, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: title,
	})
	if err != nil {
		return Err[string](err.Error())
	}
	return Ok(selected)
}

// SaveFileDialog opens a native save file picker.
func (a *App) SaveFileDialog(title string, defaultFilename string) ApiResult[string] {
	if a.ctx == nil {
		return Err[string]("应用尚未启动")
	}
	selected, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           title,
		DefaultFilename: defaultFilename,
	})
	if err != nil {
		return Err[string](err.Error())
	}
	return Ok(selected)
}

// OpenFileDialog opens a native file picker.
func (a *App) OpenFileDialog(title string, filters []runtime.FileFilter) ApiResult[string] {
	if a.ctx == nil {
		return Err[string]("应用尚未启动")
	}
	selected, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   title,
		Filters: filters,
	})
	if err != nil {
		return Err[string](err.Error())
	}
	return Ok(selected)
}

// LicenseCheck verifies whether the app is activated on this device.
func (a *App) LicenseCheck() ApiResult[LicenseStatus] {
	if a.licenseMgr == nil {
		return Err[LicenseStatus]("授权模块未初始化")
	}
	status, err := a.licenseMgr.Check()
	if err != nil {
		return Err[LicenseStatus](err.Error())
	}
	return Ok(LicenseStatus{
		Activated: status.Activated,
		Info:      LicenseInfo(status.Info),
	})
}

// LicenseRequestCode requests a verification code for the given license and email.
func (a *App) LicenseRequestCode(email, key string) ApiResult[bool] {
	if a.licenseMgr == nil {
		return Err[bool]("授权模块未初始化")
	}
	if err := a.licenseMgr.RequestCode(key, email); err != nil {
		return Err[bool](err.Error())
	}
	return Ok(true)
}

// LicenseActivate activates the license using the verification code.
func (a *App) LicenseActivate(req LicenseActivateRequest) ApiResult[LicenseStatus] {
	if a.licenseMgr == nil {
		return Err[LicenseStatus]("授权模块未初始化")
	}
	status, err := a.licenseMgr.Activate(req.License, req.Email, req.Code)
	if err != nil {
		return Err[LicenseStatus](err.Error())
	}
	return Ok(LicenseStatus{
		Activated: status.Activated,
		Info:      LicenseInfo(status.Info),
	})
}

// LicenseStartTrial requests a 3-day device-bound trial certificate from the
// license server and stores it locally. Fails if this device has already
// consumed its trial window.
func (a *App) LicenseStartTrial() ApiResult[LicenseStatus] {
	if a.licenseMgr == nil {
		return Err[LicenseStatus]("授权模块未初始化")
	}
	status, err := a.licenseMgr.StartTrial()
	if err != nil {
		return Err[LicenseStatus](err.Error())
	}
	return Ok(LicenseStatus{
		Activated: status.Activated,
		Info:      LicenseInfo(status.Info),
	})
}

// LicenseLogout deactivates this device and clears local license storage.
func (a *App) LicenseLogout() ApiResult[bool] {
	if a.licenseMgr == nil {
		return Err[bool]("授权模块未初始化")
	}
	if err := a.licenseMgr.Logout(); err != nil {
		return Err[bool](err.Error())
	}
	return Ok(true)
}

// LicenseInfo returns the current license information.
func (a *App) LicenseInfo() ApiResult[LicenseInfo] {
	if a.licenseMgr == nil {
		return Err[LicenseInfo]("授权模块未初始化")
	}
	return Ok(LicenseInfo(a.licenseMgr.Info()))
}

// CheckUpdate fetches the remote version feed and returns the latest version
// info when a newer version is available.
func (a *App) CheckUpdate() ApiResult[*updater.UpdateInfo] {
	if a.updateMgr == nil {
		return Err[*updater.UpdateInfo]("更新模块未初始化")
	}
	info, err := a.updateMgr.Check(appVersion)
	if err != nil {
		return Err[*updater.UpdateInfo](err.Error())
	}
	return Ok(info)
}

// DownloadUpdate downloads the installer for the given update info to the
// system temp directory and returns its local path.
func (a *App) DownloadUpdate(info updater.UpdateInfo) ApiResult[string] {
	if a.updateMgr == nil {
		return Err[string]("更新模块未初始化")
	}
	path, err := a.updateMgr.Download(info)
	if err != nil {
		return Err[string](err.Error())
	}
	return Ok(path)
}

// ApplyUpdate spawns the sidecar updater and quits the main application.
func (a *App) ApplyUpdate(installerPath string, checksum string) ApiResult[bool] {
	if a.updateMgr == nil {
		return Err[bool]("更新模块未初始化")
	}
	if err := a.updateMgr.Apply(installerPath, checksum, ""); err != nil {
		return Err[bool](err.Error())
	}
	return Ok(true)
}
