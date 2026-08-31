/**
 * hello 示例插件构建脚本单测（v2.5，PLAN §七）：
 * - packQbox：内存 zip（deflate）产物与宿主解压器（core/archive.ts extractZip）兼容——
 *   往返逐字节一致（中文条目名 / 空文件 / 二进制），且宿主登记期校验（validateManifest）对包内 manifest 通过
 * - buildHelloPlugin：自建最小 fixture 源（manifest + src/main/index.ts + src/renderer/Main.ts，
 *   renderer 用 h() 无 JSX 写法——esbuild 无 Solid JSX 编译，脚本头注释约定）全流程 →
 *   .qbox 结构（manifest 原样 / main CJS / renderer ESM 自包含无裸 import）；
 *   main 产物可被 node 动态 import 并 activate(host) 返回 registration（IPC 回显可用）；
 *   renderer 产物 default 导出为组件函数
 * - 输入防御：缺 manifest / 缺 main 入口 / JSX 源 → 明确报错
 */
import { describe, expect, it } from 'vitest'
import { packQbox, buildHelloPlugin } from '../../scripts/build-hello-plugin.mjs'
import { extractZip } from '../../src/main/core/archive'
import { validateManifest } from '../../src/plugins/types'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

/** 最小 fixture 源（等价 hello 源码子代理交付物形态：manifest + src/main/index.ts + src/renderer/*.ts） */
const MANIFEST_JSON = JSON.stringify(
  {
    id: 'com.qihe.hello',
    name: 'hello 示例插件',
    version: '0.1.0',
    apiVersion: 1,
    enabled: true,
    kind: ['ipc', 'pages', 'commands'],
    ipcPrefix: 'hello',
    description: '协议教学示例：IPC 回显 + 页面 + 右键命令',
    author: '启禾软件',
    license: 'MIT',
    pages: [{ path: '/plugin/hello', label: 'hello', icon: 'plugin', group: '插件', component: 'renderer/Main.js' }],
    commands: [{ id: 'hello-say', label: 'hello 打招呼', scope: 'file' }],
  },
  null,
  2,
)

const MAIN_SRC = `/** hello 主进程入口：activate(host) → PluginRegistration（IPC 回显 + 命令回调） */
export async function activate(host) {
  return {
    ipc: {
      echo: async (args) => ({ ok: true, echo: args, apiVersion: host.apiVersion }),
    },
    commands: {
      'hello-say': async ({ filePaths, host: h }) => {
        h.notify('hello', \`选中 \${filePaths.length} 个文件\`)
      },
    },
    dispose: () => {},
  }
}
`

const RENDERER_SRC = `/** hello 页面组件：h() 无 JSX 写法（esbuild 无 Solid JSX 编译，见构建脚本头注释） */
import { createSignal } from 'solid-js'
import h from 'solid-js/h'

export default function HelloPage() {
  const [count, setCount] = createSignal(0)
  return h('div', { 'data-hello': 'hello-plugin' }, [
    h('h2', {}, 'hello 插件页面'),
    h('p', {}, '点击按钮调用本地状态'),
    h('button', { onClick: () => setCount(count() + 1) }, \`count: \${count()}\`),
  ])
}
`

/** 临时目录内构造最小 fixture 源，返回 srcDir */
async function makeFixtureSrc(overrides: Partial<Record<'main' | 'renderer' | 'manifest', string | null>> = {}): Promise<string> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-hello-'))
  const srcDir = path.join(base, 'hello-src')
  await fsp.mkdir(path.join(srcDir, 'src', 'main'), { recursive: true })
  await fsp.mkdir(path.join(srcDir, 'src', 'renderer'), { recursive: true })
  if (overrides.manifest !== null) await fsp.writeFile(path.join(srcDir, 'manifest.json'), overrides.manifest ?? MANIFEST_JSON)
  if (overrides.main !== null) await fsp.writeFile(path.join(srcDir, 'src', 'main', 'index.ts'), overrides.main ?? MAIN_SRC)
  if (overrides.renderer !== null) await fsp.writeFile(path.join(srcDir, 'src', 'renderer', 'Main.ts'), overrides.renderer ?? RENDERER_SRC)
  return srcDir
}

async function tmpOut(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-hello-out-'))
}

describe('packQbox（内存 zip 打包，与宿主解压器兼容）', () => {
  it('往返：中文条目名 / 空文件 / 二进制 经 extractZip 解压逐字节一致', async () => {
    const buf = packQbox([
      { name: 'manifest.json', data: '{"id":"com.qihe.hello"}' },
      { name: 'main/index.js', data: 'module.exports = { activate: async () => ({}) }' },
      { name: 'renderer/Main.js', data: Buffer.from([0, 1, 2, 0xff, 0xfe]) },
      { name: 'renderer/空目录/', data: '' }, // 目录条目（store，无数据）
    ])
    const zipPath = path.join(await tmpOut(), 't.qbox')
    await fsp.writeFile(zipPath, buf)
    const outDir = path.join(await tmpOut(), 'out')
    const { count } = await extractZip(zipPath, outDir)
    expect(count).toBe(4)
    expect(await fsp.readFile(path.join(outDir, 'manifest.json'), 'utf8')).toBe('{"id":"com.qihe.hello"}')
    expect(await fsp.readFile(path.join(outDir, 'main', 'index.js'), 'utf8')).toBe('module.exports = { activate: async () => ({}) }')
    expect(await fsp.readFile(path.join(outDir, 'renderer', 'Main.js'))).toEqual(Buffer.from([0, 1, 2, 0xff, 0xfe]))
    expect((await fsp.stat(path.join(outDir, 'renderer', '空目录'))).isDirectory()).toBe(true)
  })

  it('防御：空条目列表 / 非法条目名（绝对路径、.. 逃逸、盘符）拒绝', () => {
    expect(() => packQbox([])).toThrow('缺少打包条目')
    expect(() => packQbox([{ name: '/abs.js', data: 'x' }])).toThrow('绝对路径')
    expect(() => packQbox([{ name: '../evil.js', data: 'x' }])).toThrow('.. 逃逸')
    expect(() => packQbox([{ name: 'C:/evil.js', data: 'x' }])).toThrow('盘符')
    expect(() => packQbox([{ name: 'dir/', data: 'x' }])).toThrow('目录条目不得含数据')
  })
})

describe('buildHelloPlugin（fixture 全流程 → .qbox）', () => {
  it('产物结构：manifest 原样 + main CJS + renderer ESM，条目齐全且 id 决定包名', async () => {
    const srcDir = await makeFixtureSrc()
    const outDir = await tmpOut()
    const logs: unknown[] = []
    const { outPath, files } = await buildHelloPlugin({ srcDir, outDir, log: (...a) => logs.push(a) })

    expect(path.basename(outPath)).toBe('com.qihe.hello.qbox')
    expect(files.sort()).toEqual(['main/index.js', 'manifest.json', 'renderer/Main.js'])

    // 解压到临时目录验证内容
    const extracted = path.join(await tmpOut(), 'pkg')
    await extractZip(outPath, extracted)
    expect(await fsp.readFile(path.join(extracted, 'manifest.json'), 'utf8')).toBe(MANIFEST_JSON)
    // 构建日志含 esbuild 与打包行（可观测）
    expect(logs.some((l) => String(l).includes('manifest.json'))).toBe(true)
  })

  it('main 产物：可被 node 动态 import，activate(host) 返回 registration，IPC 回显可用', async () => {
    const srcDir = await makeFixtureSrc()
    const outDir = await tmpOut()
    const { outPath } = await buildHelloPlugin({ srcDir, outDir, log: () => {} })

    const extracted = path.join(await tmpOut(), 'pkg')
    await extractZip(outPath, extracted)
    const mod = (await import(pathToFileURL(path.join(extracted, 'main', 'index.js')).href)) as {
      activate: (host: unknown) => Promise<{ ipc: Record<string, (a: unknown) => Promise<unknown>> }>
    }
    expect(typeof mod.activate).toBe('function')

    const host = { apiVersion: 1 }
    const reg = await mod.activate(host)
    expect(typeof reg.ipc.echo).toBe('function')
    await expect(reg.ipc.echo({ msg: '你好' })).resolves.toEqual({ ok: true, echo: { msg: '你好' }, apiVersion: 1 })
  })

  it('renderer 产物：ESM 自包含（无裸 import、solid-js 已打入），default 导出为组件函数', async () => {
    const srcDir = await makeFixtureSrc()
    const outDir = await tmpOut()
    const { outPath } = await buildHelloPlugin({ srcDir, outDir, log: () => {} })

    const extracted = path.join(await tmpOut(), 'pkg')
    await extractZip(outPath, extracted)
    const rendererJs = await fsp.readFile(path.join(extracted, 'renderer', 'Main.js'), 'utf8')
    // 自包含：不得残留对 solid-js 的裸 import（宿主不提供共享运行时，PLUGIN.md §2.1）
    expect(rendererJs).not.toMatch(/from\s+['"]solid-js/)
    // 组件为模块 default 导出（渲染层 import(url) 后取 default，PLAN §4.3）
    // v2.5.7（F2a 构建 minify）：bundle 已 minify（近单行），源码标识符 HelloPage 被 mangle
    expect(rendererJs.split('\n').filter((l) => l.trim() !== '').length).toBeLessThan(5)
    expect(rendererJs).not.toContain('HelloPage')

    const mod = (await import(pathToFileURL(path.join(extracted, 'renderer', 'Main.js')).href)) as {
      default?: () => unknown
    }
    expect(typeof mod.default).toBe('function')
  })

  it('包内 manifest 通过宿主登记期校验（validateManifest）', async () => {
    const srcDir = await makeFixtureSrc()
    const outDir = await tmpOut()
    const { outPath } = await buildHelloPlugin({ srcDir, outDir, log: () => {} })

    const extracted = path.join(await tmpOut(), 'pkg')
    await extractZip(outPath, extracted)
    const r = validateManifest(JSON.parse(await fsp.readFile(path.join(extracted, 'manifest.json'), 'utf8')))
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('输入防御：缺 manifest / 缺 main 入口 / JSX 源 → 明确报错', async () => {
    await expect(buildHelloPlugin({ srcDir: await makeFixtureSrc({ manifest: null }), outDir: await tmpOut(), log: () => {} })).rejects.toThrow('缺少插件清单')
    await expect(buildHelloPlugin({ srcDir: await makeFixtureSrc({ main: null }), outDir: await tmpOut(), log: () => {} })).rejects.toThrow('缺少主进程入口')
    await expect(
      buildHelloPlugin({ srcDir: await makeFixtureSrc({ renderer: 'export default () => <div>hi</div>\n' }), outDir: await tmpOut(), log: () => {} }),
    ).rejects.toThrow('JSX')
    // manifest 非 JSON
    await expect(buildHelloPlugin({ srcDir: await makeFixtureSrc({ manifest: 'not-json' }), outDir: await tmpOut(), log: () => {} })).rejects.toThrow('不是合法 JSON')
  })
})

describe('buildHelloPlugin --encrypt（F5b 加密构建）', () => {
  it('密文 .enc 代替明文，manifest 注入 encryption 块，密钥落盘 600 + 密文 sha256 返回', async () => {
    const srcDir = await makeFixtureSrc()
    const outDir = await tmpOut()
    const logs: unknown[] = []
    const { outPath, files, keyHex, cipherHashes } = await buildHelloPlugin({
      srcDir,
      outDir,
      encrypt: true,
      entitlement: 'login',
      log: (...a) => logs.push(a),
    })

    // 包内：明文 JS 缺失、加密版存在、manifest 含 encryption
    expect(files.sort()).toEqual(['main/index.js.enc', 'manifest.json', 'renderer/Main.js.enc'])
    const extracted = path.join(await tmpOut(), 'pkg')
    await extractZip(outPath, extracted)
    expect(fsExists(path.join(extracted, 'main', 'index.js'))).toBe(false)
    expect(fsExists(path.join(extracted, 'main', 'index.js.enc'))).toBe(true)
    expect(fsExists(path.join(extracted, 'renderer', 'Main.js.enc'))).toBe(true)

    const manifest = JSON.parse(await fsp.readFile(path.join(extracted, 'manifest.json'), 'utf8'))
    expect(manifest.encryption).toEqual({ algo: 'aes-256-gcm', keyId: expect.any(String), entitlement: 'login' })
    // 宿主登记期校验（新增 encryption 字段）通过
    const r = validateManifest(manifest)
    expect(r.ok).toBe(true)

    // 密钥：返回 hex + 密文 sha256 对齐（长度 64 hex；encrypt:true 保证返回）
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(cipherHashes!.length).toBe(2) // main + renderer
    for (const h of cipherHashes!) expect(h.sha256).toMatch(/^[0-9a-f]{64}$/)

    // 密文可用宿主解密模块往返（关键：构建格式与运行时 decryptEnc 双端一致）
    const { decryptEnc } = await import('../../src/main/plugins/encryption')
    const mainEnc = await fsp.readFile(path.join(extracted, 'main', 'index.js.enc'))
    const dec = decryptEnc(mainEnc, keyHex!)
    expect(dec).not.toBeNull()
    // 明文是 CJS bundle（module.exports）
    expect(dec!.toString('utf8')).toContain('module.exports')
    // 密文本身不含明文特征
    expect(mainEnc.toString('utf8')).not.toContain('module.exports')
  })

  it('非法 entitlement 报错（fail-fast，防误构付费插件为 login）', async () => {
    await expect(
      buildHelloPlugin({ srcDir: await makeFixtureSrc(), outDir: await tmpOut(), encrypt: true, entitlement: 'free' as never, log: () => {} }),
    ).rejects.toThrow('--entitlement 仅支持 login/subscription')
  })
})

function fsExists(p: string): boolean {
  return fs.existsSync(p)
}
