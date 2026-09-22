<!-- Windows 平台分支清单基线（W0 防复发门禁） -->
<!-- 由 npm run win:update 生成；tests/unit/winBranchInventory.test.ts 逐行比对 -->
<!-- 列：file:line | kind | 覆盖测试（UNCOVERED = 该类点位无测试引用，门禁红） -->
count: 12

- src/main/account.ts:453 | platform-read | tests/unit/account.test.ts tests/unit/accountCaptcha.test.ts tests/unit/ipc-entity-events.test.ts | platform: process.platform + (process.arch ? `-${process.arch}` : ''),
- src/main/autoLaunchMain.ts:29 | platform-read | tests/unit/autoLaunch.test.ts | export function isMacAutostartLaunch(platform: NodeJS.Platform = process.platform): boolean {
- src/main/autoLaunchMain.ts:34 | platform-read | tests/unit/autoLaunch.test.ts | export function setAutoLaunch(enabled: boolean, platform: NodeJS.Platform = process.platform): void {
- src/main/autoLaunchMain.ts:41 | win32-branch | tests/unit/autoLaunch.test.ts | if (platform === 'win32') {
- src/main/autoLaunchMain.ts:77 | platform-read | tests/unit/autoLaunch.test.ts | export function isAutoLaunch(platform: NodeJS.Platform = process.platform): boolean {
- src/main/autoLaunchMain.ts:78 | win32-branch | tests/unit/autoLaunch.test.ts | if (platform === 'win32') return app.getLoginItemSettings().openAtLogin
- src/main/clipboard.ts:41 | win32-branch | tests/unit/clipboardParse.test.ts tests/unit/winPlatformBranches.test.ts | if (process.platform === 'win32') {
- src/main/clipboard.ts:146 | win32-branch | tests/unit/clipboardParse.test.ts tests/unit/winPlatformBranches.test.ts | if (process.platform === 'win32') return dedupePaths(parseFileDropList(await winGetClipboardFiles()))
- src/main/explorer.ts:11 | win32-branch | tests/unit/winPlatformBranches.test.ts | if (process.platform === 'win32') {
- src/main/open.ts:25 | win32-branch | tests/unit/winPlatformBranches.test.ts | if (process.platform === 'win32') {
- src/main/window.ts:255 | win32-branch | tests/unit/winWindowHooks.test.ts | if (process.platform === 'win32' && mainWindow) {
- src/main/window.ts:343 | win32-branch | tests/unit/winWindowHooks.test.ts | if (process.platform === 'win32') {
