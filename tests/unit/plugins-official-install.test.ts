/**
 * 官方索引分发链**真链**测试（v2.6 批 2）：本地 HTTP 夹具服务器 → 目录拉取 → 登录态下载 →
 * 逐字节 SHA-256 → 既有 `.qbox` 安装管线 → 登记版本对得上。
 *
 * 与 plugins-catalog / plugins-download 两文件的分工：那两个用注入 fetch 打**分支**，
 * 这里打通**整条链**（含真实网络栈、真实 zip 包、真实安装器）——批 2 的验收判据
 * 「应用内勾选下载 → 装上 → 版本对得上」在宿主侧的等价物。服务端由 erp 侧另行实现，
 * 故本用例自带夹具服务器，形状即公开契约 §5.3 的端点形状。
 *
 * 三条负向判据同样在链上打：
 * ① 未登录 → 服务端**零请求**（不是"下载了但拒绝安装"）；
 * ② 索引 sha256 与包体不符 → 拒绝 + 目录零残留；
 * ③ 服务端 401（登录态失效）→ 中文 NOT_LOGGED_IN。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fetchCatalog } from '../../src/main/plugins/catalog'
import { downloadPluginPackage } from '../../src/main/plugins/download'
import { PluginInstaller } from '../../src/main/plugins/installer'
import { PluginRegistry, PKG_DIR, MAIN_ENTRY } from '../../src/main/plugins/registry'
import { compressToZip } from '../../src/main/core/archive'

const HOST = { apiVersion: 1, productVersion: '2.6.0' }
const TOKEN = 'jwt-official'
const PLUGIN_ID = 'com.qihe.offi'
const PLUGIN_VERSION = '0.1.0'

let root: string
let staging: string
let qbox: string
let qboxSha: string
/** 夹具服务器收到的请求（负向用例断言「零请求」用） */
let requests: string[] = []
let server: http.Server
let baseUrl = ''

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-official-root-'))
  staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-official-stage-'))
  await fsp.mkdir(path.join(staging, 'main'), { recursive: true })
  await fsp.writeFile(
    path.join(staging, 'manifest.json'),
    JSON.stringify({
      id: PLUGIN_ID,
      name: '官方分发夹具',
      version: PLUGIN_VERSION,
      apiVersion: 1,
      enabled: true,
      kind: ['ipc'],
      ipcPrefix: 'offi',
    }),
  )
  await fsp.writeFile(path.join(staging, MAIN_ENTRY), 'module.exports = { activate: async () => ({ ipc: {} }) }')
  qbox = path.join(root, `${PLUGIN_ID}.qbox`)
  await compressToZip([path.join(staging, 'manifest.json'), path.join(staging, 'main')], qbox)
  qboxSha = createHash('sha256').update(await fsp.readFile(qbox)).digest('hex')

  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if (req.url === '/api/box/plugin-catalog') {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 401, message: 'unauthorized' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          code: 200,
          data: {
            catalog_version: 1,
            plugins: [
              {
                id: PLUGIN_ID,
                name: '官方分发夹具',
                source: '启禾官方',
                versions: [
                  {
                    version: PLUGIN_VERSION,
                    apiCompat: [1, 1],
                    minHostVersion: '2.5.0',
                    size: fs.statSync(qbox).size,
                    sha256: qboxSha,
                    downloadUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/pkg/${PLUGIN_ID}-${PLUGIN_VERSION}.qbox`,
                  },
                ],
              },
            ],
          },
        }),
      )
      return
    }
    const pkgPath = `/pkg/${PLUGIN_ID}-${PLUGIN_VERSION}.qbox`
    if (req.url === pkgPath) {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(fs.readFileSync(qbox))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
})

describe('真链：目录 → 登录态下载 → SHA-256 → 安装 → 登记', () => {
  it('整条链走通：目录选中版本 → 下载校验 → 装进 pkg/ → 清单版本与索引一致', async () => {
    requests = []
    const entries = await fetchCatalog({ baseUrl, getToken: () => TOKEN }, HOST)
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry.compatible).toBe(true)
    expect(entry.selected?.version).toBe(PLUGIN_VERSION)
    expect(entry.selected?.size).toBe(fs.statSync(qbox).size)

    const destDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-official-dl-'))
    const dl = await downloadPluginPackage(
      { baseUrl, getToken: () => TOKEN },
      { downloadUrl: entry.selected!.downloadUrl, sha256: entry.selected!.sha256, destDir },
    )
    expect(dl.size).toBe(fs.statSync(qbox).size)

    const registry = new PluginRegistry({ root, hostVersion: '2.6.0' })
    registry.scan()
    const installer = new PluginInstaller({ root, registry, log: () => {} })
    const r = await installer.install(dl.filePath)
    expect(r.id).toBe(PLUGIN_ID)
    // 安装登记：版本与索引一致（= 批 2 判据「版本对得上」）
    expect(registry.get(PLUGIN_ID)?.state).toBe('enabled')
    expect(registry.info(PLUGIN_ID)?.version).toBe(PLUGIN_VERSION)
    expect(fs.existsSync(path.join(root, PLUGIN_ID, PKG_DIR, MAIN_ENTRY))).toBe(true)
    // 防篡改记录 = 索引声明的 sha256（不是"下载到的某个包"）
    expect(await fsp.readFile(path.join(root, PLUGIN_ID, '.qbox.sha256'), 'utf-8')).toBe(qboxSha)

    // 临时包体由调用方（IPC 层）删除；此处模拟并断言删得掉（不落盘半包的另一半）
    await fsp.rm(dl.filePath, { force: true })
    expect(await fsp.readdir(destDir)).toEqual([])

    // 两个请求：目录 + 包体（登录态各带一次）
    expect(requests).toEqual(['GET /api/box/plugin-catalog', `GET /pkg/${PLUGIN_ID}-${PLUGIN_VERSION}.qbox`])
  })

  it('未登录：目录链与下载链都在**联网之前**拒绝（服务端零请求）', async () => {
    requests = []
    await expect(fetchCatalog({ baseUrl, getToken: () => null }, HOST)).rejects.toThrow(/NOT_LOGGED_IN/)
    await expect(
      downloadPluginPackage(
        { baseUrl, getToken: () => null },
        { downloadUrl: `${baseUrl}/pkg/x.qbox`, sha256: qboxSha, destDir: root },
      ),
    ).rejects.toThrow(/DOWNLOAD_NOT_LOGGED_IN/)
    expect(requests).toEqual([])
  })

  it('服务端 401（登录态失效）→ 中文 NOT_LOGGED_IN（不谎报空目录）', async () => {
    await expect(fetchCatalog({ baseUrl, getToken: () => 'jwt-stale' }, HOST)).rejects.toThrow(
      /NOT_LOGGED_IN：官方插件目录登录态已失效（HTTP 401）/,
    )
  })

  it('索引 sha256 与包体不符 → 拒绝安装，且目标目录零残留（不落盘半包）', async () => {
    requests = []
    const entries = await fetchCatalog({ baseUrl, getToken: () => TOKEN }, HOST)
    const wrongSha = createHash('sha256').update('tampered').digest('hex')
    const destDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-official-dl-'))
    await expect(
      downloadPluginPackage(
        { baseUrl, getToken: () => TOKEN },
        { downloadUrl: entries[0].selected!.downloadUrl, sha256: wrongSha, destDir },
      ),
    ).rejects.toThrow(/DOWNLOAD_HASH_MISMATCH：插件包校验失败——SHA-256 与官方索引不一致，已放弃安装/)
    expect(await fsp.readdir(destDir)).toEqual([])
    // 目录复取一次 + 包体被完整取过一次（证明"校验的是下到的字节"，不是"没下就报错"）
    expect(requests).toEqual([
      'GET /api/box/plugin-catalog',
      `GET /pkg/${PLUGIN_ID}-${PLUGIN_VERSION}.qbox`,
    ])
  })

  it('端点未部署（404）→ 中文 NOT_DEPLOYED（服务端侧形状同契约）', async () => {
    const entriesServer = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end('nope')
    })
    await new Promise<void>((resolve) => entriesServer.listen(0, '127.0.0.1', resolve))
    const port = (entriesServer.address() as AddressInfo).port
    try {
      await expect(
        fetchCatalog({ baseUrl: `http://127.0.0.1:${port}`, getToken: () => TOKEN }, HOST),
      ).rejects.toThrow(/NOT_DEPLOYED：官方插件目录服务未就绪（HTTP 404）/)
    } finally {
      await new Promise<void>((resolve) => entriesServer.close(() => resolve()))
    }
  })
})