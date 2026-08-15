<!--
  qihe-box API 兼容性守护基线（API_VERSION=1 · 只增不删）
  生成器：tests/unit/helpers/apiSurface.ts · 更新：npm run api:update
  TypeScript: 5.9.3
  break-reason: v2.5.1 A1/A2 能力域增量（只增不删）：PluginManifest.permissions 增 customers/share 可选布尔；PluginHost 增 customer/share 命名空间（11+6 方法）
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
- PluginHost.customer.get(name: string): Promise<unknown | null>
- PluginHost.customer.list(since?: string): Promise<unknown[]>
- PluginHost.customer.relation.link(customerName: string, productSetName: string): Promise<void>
- PluginHost.customer.relation.unlink(customerName: string, productSetName: string): Promise<void>
- PluginHost.customer.relation: { link(customerName: string, productSetName: string): Promise<void>; unlink(customerName: string, productSetName: string): Promise<void>; }
- PluginHost.customer.syncProfile(req: { name: string; fields?: { type?: '企业' | '个人'; contact?: string; phone?: string; email?: string; address?: string; notes?: string; }; erp_ext?: Record<string, unknown>; updated_at: string; }): Promise<{ applied: boolean; }>
- PluginHost.customer.writeErpExt(name: string, ext: Record<string, unknown>): Promise<void>
- PluginHost.customer: { list(since?: string): Promise<unknown[]>; get(name: string): Promise<unknown | null>; writeErpExt(name: string, ext: Record<string, unknown>): Promise<void>; syncProfile(req: { name: string; fields?: { type?: '企业' | '个人'; contact?: string; phone?: string; email?: string; address?: string; notes?: string; }; erp_ext?: Record<string, unknown>; updated_at: string; }): Promise<{ applied: boolean; }>; relation: { link(customerName: string, productSetName: string): Promise<void>; unlink(customerName: string, productSetName: string): Promise<void>; }; }
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
- PluginHost.share.ensureCustomer(name: string): Promise<'created' | 'exists'>
- PluginHost.share.ensureProductSet(name: string): Promise<'created' | 'exists'>
- PluginHost.share.getMetadata(relPath: string): Promise<{ tags: string[]; notes: string; }>
- PluginHost.share.listCustomers(): Promise<unknown[]>
- PluginHost.share.listProductSets(): Promise<unknown[]>
- PluginHost.share.listTree(relPath?: string): Promise<unknown[]>
- PluginHost.share.mergePulledMetadata(entries: { path: string; tags: string[]; notes: string; }[]): Promise<{ conflicts: string[]; }>
- PluginHost.share.readFileChunk(relPath: string, offset: number, length: number): Promise<Uint8Array>
- PluginHost.share.statFile(relPath: string): Promise<{ size: number; mtime: string; }>
- PluginHost.share.writePulledFile(targetRelPath: string, chunk: Uint8Array, offset: number): Promise<void>
- PluginHost.share: { listProductSets(): Promise<unknown[]>; listCustomers(): Promise<unknown[]>; listTree(relPath?: string): Promise<unknown[]>; getMetadata(relPath: string): Promise<{ tags: string[]; notes: string; }>; statFile(relPath: string): Promise<{ size: number; mtime: string; }>; readFileChunk(relPath: string, offset: number, length: number): Promise<Uint8Array>; writePulledFile(targetRelPath: string, chunk: Uint8Array, offset: number): Promise<void>; ensureProductSet(name: string): Promise<'created' | 'exists'>; ensureCustomer(name: string): Promise<'created' | 'exists'>; mergePulledMetadata(entries: { path: string; tags: string[]; notes: string; }[]): Promise<{ conflicts: string[]; }>; }
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
- PluginManifest.permissions.customers?: boolean
- PluginManifest.permissions.network?: string[]
- PluginManifest.permissions.notification?: boolean
- PluginManifest.permissions.share?: boolean
- PluginManifest.permissions?: { network?: string[]; clipboard?: boolean; notification?: boolean; account?: boolean; customers?: boolean; share?: boolean; }
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
