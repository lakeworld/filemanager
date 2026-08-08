/** 用系统默认应用打开文件（对照原 Go files.go OpenFileWithDefaultApp） */
import { shell } from 'electron'

export async function openFileWithDefaultApp(filePath: string): Promise<void> {
  const err = await shell.openPath(filePath)
  if (err) throw new Error(err)
}
