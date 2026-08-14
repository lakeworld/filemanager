<!--
  qihe-box API 兼容性守护基线（API_VERSION=1 · 只增不删）
  生成器：tests/unit/helpers/apiSurface.ts · 更新：npm run api:update
  TypeScript: 5.9.3
  break-reason: （无）
-->

# qihe-box 插件协议 API 面（types / preload / ipc）
## types

- EntitlementStatus.expiresAt: string | null
- EntitlementStatus.quota: { [key: string]: { used: number; limit: number; }; } | null
- EntitlementStatus.tier: 'free' | 'subscribed'
- PluginBusinessError.code: string
- PluginHost.account.getToken(): string | null
- PluginHost.account.isLoggedIn(): boolean
- PluginHost.account: { getToken(): string | null; isLoggedIn(): boolean; }
- PluginHost.apiVersion: number
- PluginHost.dialog.openDirectory(opts: unknown): Promise<string>
- PluginHost.dialog.openFile(opts: unknown): Promise<string>
- PluginHost.dialog: { openFile(opts: unknown): Promise<string>; openDirectory(opts: unknown): Promise<string>; }
- PluginHost.entitlement.status(): EntitlementStatus
- PluginHost.entitlement: { status(): EntitlementStatus; }
- PluginHost.events.emit(channel: string, data: unknown): void
- PluginHost.events.on(channel: string, cb: (data: unknown) => void): () => void
- PluginHost.events: { on(channel: string, cb: (data: unknown) => void): () => void; emit(channel: string, data: unknown): void; }
- PluginHost.files.readBuffer(relPath: string): Promise<Uint8Array>
- PluginHost.files.readText(relPath: string): Promise<string>
- PluginHost.files.writeExport(fileName: string, data: string | Uint8Array): Promise<void>
- PluginHost.files: { readText(relPath: string): Promise<string>; readBuffer(relPath: string): Promise<Uint8Array>; writeExport(fileName: string, data: string | Uint8Array): Promise<void>; }
- PluginHost.log(level: 'info' | 'warn' | 'error', msg: string): void
- PluginHost.notify(title: string, body: string): boolean
- PluginHost.storage.get(key: string): Promise<unknown>
- PluginHost.storage.set(key: string, value: unknown): Promise<void>
- PluginHost.storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; }
- PluginHost.workspace.currentPath(): string | null
- PluginHost.workspace.list(): unknown
- PluginHost.workspace: { currentPath(): string | null; list(): unknown; }
- PluginManifest.activation?: Array<'onStartupFinished' | `onEvent:${string}`>
- PluginManifest.apiCompat?: [ number, number ]
- PluginManifest.apiVersion: number
- PluginManifest.author?: string
- PluginManifest.commands?: Array<{ id: string; label: PluginText; scope: 'file' | 'global'; when?: { exts?: string[]; }; }>
- PluginManifest.commands[].id: string
- PluginManifest.commands[].label: PluginText
- PluginManifest.commands[].scope: 'file' | 'global'
- PluginManifest.commands[].when.exts?: string[]
- PluginManifest.commands[].when?: { exts?: string[]; }
- PluginManifest.description?: PluginText
- PluginManifest.enabled: boolean
- PluginManifest.homepage?: string
- PluginManifest.icon?: string
- PluginManifest.id: string
- PluginManifest.ipcPrefix: string
- PluginManifest.keywords?: string[]
- PluginManifest.kind: Array<'ipc' | 'pages' | 'commands'>
- PluginManifest.license?: string
- PluginManifest.minHostVersion?: string
- PluginManifest.name: PluginText
- PluginManifest.pages?: Array<{ path: string; label: PluginText; icon: string; group: string; component: string; }>
- PluginManifest.pages[].component: string
- PluginManifest.pages[].group: string
- PluginManifest.pages[].icon: string
- PluginManifest.pages[].label: PluginText
- PluginManifest.pages[].path: string
- PluginManifest.permissions.account?: boolean
- PluginManifest.permissions.clipboard?: boolean
- PluginManifest.permissions.network?: string[]
- PluginManifest.permissions.notification?: boolean
- PluginManifest.permissions?: { network?: string[]; clipboard?: boolean; notification?: boolean; account?: boolean; }
- PluginManifest.syncScope?: 'global' | 'local'
- PluginManifest.transport?: 'inproc'
- PluginManifest.version: string
- PluginRegistration.commands?: Record<string, (ctx: { filePaths: string[]; host: PluginHost; }) => Promise<void> | void>
- PluginRegistration.dispose?: () => void
- PluginRegistration.ipc?: Record<string, (args: unknown) => Promise<unknown>>
- PluginRegistration.pages?: PluginManifest['pages']
- const API_VERSION = 1
- function validateManifest(input: unknown): { ok: boolean; errors: string[]; }
- interface EntitlementStatus
- interface PluginBusinessError extends Error
- interface PluginHost
- interface PluginManifest
- interface PluginRegistration
- type PluginText = string | { default: string; [locale: string]: string; }

## preload

- plugins.call
- plugins.install
- plugins.list
- plugins.on
- plugins.setEnabled
- plugins.uninstall
- settings.getDevMode
- settings.setDevMode

## ipc

- qihebox:plugins:call
- qihebox:plugins:install
- qihebox:plugins:list
- qihebox:plugins:setEnabled
- qihebox:plugins:uninstall
- qihebox:settings:getDevMode
- qihebox:settings:setDevMode
