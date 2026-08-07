package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/logger"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	if !ensureSingleInstance() {
		return
	}

	app := NewApp()
	fileHandler := newWorkspaceFileHandler(app)

	err := wails.Run(&options.App{
		Title:     "启禾文件管理",
		Width:     1280,
		Height:    900,
		MinWidth:  1024,
		MinHeight: 720,
		Frameless: true,
		CSSDragProperty: "--wails-draggable",
		CSSDragValue:    "drag",
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true,
		},
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: fileHandler,
		},
		BackgroundColour: &options.RGBA{R: 15, G: 23, B: 42, A: 255},
		Menu:             nil,
		Logger:           nil,
		LogLevel:         logger.DEBUG,
		OnStartup:        app.startup,
		OnBeforeClose:    app.beforeClose,
		OnShutdown:       app.shutdown,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		log.Fatal(err)
	}
}
