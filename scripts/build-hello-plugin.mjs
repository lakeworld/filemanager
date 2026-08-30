/**
 * hello 示例插件构建脚本（v2.5，PLAN §七）：源码 → 自包含 `.qbox` 包（不进安装包，e2e 侧载夹具）。
 *
 * 零新增依赖：esbuild 为 vite 内置依赖（仅本脚本 import）；zip 打包用 node 内置 zlib 手写容器
 * （格式与 src/main/core/archive.ts 的 extractZip 解压器兼容——local header + central directory + EOCD，
 *  method 8 deflate + UTF-8 条目名，宿主安装器可直接解压）。
 *
 * 源目录约定（与 hello 插件源码子代理对齐，PLAN §七）：
 *   <srcDir>/manifest.json          清单（原样进入 .qbox 根，完整校验由宿主登记期执行）
 *   <srcDir>/src/main/index.ts     主进程入口：export async function activate(host) → PluginRegistration
 *   <srcDir>/src/renderer/**       渲染层页面模块（每个 .ts/.js 独立 bundle，产物 renderer/<同名>.js）
 *
 * 渲染层 JSX 约定：esbuild 不提供 Solid JSX 编译语义（需 babel-preset-solid，本脚本禁用），
 *  renderer 源一律用无 JSX 写法：import h from 'solid-js/h'（该子路径 ESM 为 default 导出）、
 *  其余响应式原语（createSignal 等）从 'solid-js' 导入；出现 .tsx/.jsx 直接报错（不静默产出错误运行时调用）。
 *  h() 事件约定（2026-08-11 实测）：静态 props 走 assign 路径（属性直赋）——事件名必须小写（onclick/oninput），
 *  大写 onClick 会被原样赋为元素自定义属性、点击不触发；需要响应式 props（函数/Getter）才会走 spread 路径。
 *  solid-js 随 bundle 打入产物（自包含）。
 *
 * 用法：
 *   node scripts/build-hello-plugin.mjs                # 默认 src=src/plugins/hello out=out/plugins
 *   node scripts/build-hello-plugin.mjs --src <dir> --out <dir> [--externals a,b,c]
 *   --externals：main 构建的 external 包名（逗号分隔，如 bufferutil,utf-8-validate——ws 的
 *   native 可选依赖，esbuild 无 node 内置解析时需 external；ws 有纯 JS fallback，运行期自动降级）
 *
 * v2.5.7（F5b）加密构建：
 *   node scripts/build-hello-plugin.mjs --src <dir> --out <dir> --encrypt [--entitlement login|subscription] [--key-out <file>]
 *   main/index.js 与 renderer/**.js 以 AES-256-GCM 加密为 <name>.enc（QHENC1 魔数 + iv + tag + body），
 *   明文不落包；manifest 自动注入 encryption 块（algo/keyId 随机/entitlement）。
 *   --key-out 输出内容密钥 hex 到指定文件（默认 out/<id>.key，仅构建人持有，不进包不进仓）；
 *   同时打印密文 sha256（登记 erp box_plugin_keys 用）。entitlement 默认 'login'。
 */
import { build } from 'esbuild'
import zlib from 'node:zlib'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_SRC_DIR = path.join(ROOT, 'src/plugins/hello')
export const DEFAULT_OUT_DIR = path.join(ROOT, 'out/plugins')

/** v2.5.7（F5b）：.enc 包内密文布局 = QHENC1 魔数 + iv(12) + tag(16) + body（与 encryption.ts 双端一致） */
export const ENC_MAGIC = 'QHENC1'

/** AES-256-GCM 加密（keyHex 为 32 字节 hex）→ Buffer 完整密文；key 非法抛错（构建期 fail-fast） */
export function encryptBytes(buf, keyHex) {
  const key = Buffer.from(keyHex, 'hex')
  if (key.length !== 32) throw new Error(`内容密钥须为 32 字节 hex（当前 ${key.length * 8} bit）`)
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(buf), c.final()])
  return Buffer.concat([Buffer.from(ENC_MAGIC, 'utf8'), iv, c.getAuthTag(), body])
}

/**
 * esbuild 额外包解析路径（指向本项目 node_modules）：真实源（src/plugins/hello）默认即可解析；
 * 外部 fixture / e2e 临时源在项目外构建时依赖此项解析 solid-js。nodePaths 追加于默认解析之后，零副作用。
 */
const NODE_PATHS = [path.join(ROOT, 'node_modules')]

// —— CRC32（ZIP 用，查表法，与 core/archive.ts 同算法）——

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf, seed = 0) {
  let c = ~seed >>> 0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

function u16(v) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(v & 0xffff)
  return b
}
function u32(v) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v >>> 0)
  return b
}

/** ZIP 条目名安全：拒绝绝对路径 / 盘符 / '..' 逃逸（打包侧同样不做越界名）。
 *  条目 name 为包内相对路径（正斜杠）；目录条目 name 以 '/' 结尾且 data 为空 */
function safeEntryName(name) {
  const norm = name.replace(/\\/g, '/')
  if (norm.startsWith('/')) throw new Error(`非法 zip 条目名（绝对路径）：${name}`)
  if (/^[a-zA-Z]:/.test(norm)) throw new Error(`非法 zip 条目名（盘符）：${name}`)
  if (norm.split('/').some((s) => s === '..')) throw new Error(`非法 zip 条目名（.. 逃逸）：${name}`)
  return norm
}

/**
 * 内存打包 zip（deflate）→ Buffer。hello .qbox 体积为 KB 级，无需流式；
 * 格式对齐 core/archive.ts 解压器：local header 直接写全 crc/大小（method 8、flag bit11=UTF-8），
 * central directory 条目含 method/crc/大小/偏移，尾部 EOCD。
 */
/** @param {Array<{ name: string; data: Buffer | string }>} entries */
export function packQbox(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('缺少打包条目')
  const locals = []
  const central = []
  let offset = 0

  for (const raw of entries) {
    if (!raw || typeof raw.name !== 'string') throw new Error('条目须含 name')
    const name = safeEntryName(raw.name)
    const isDir = name.endsWith('/')
    const data = Buffer.isBuffer(raw.data) ? raw.data : Buffer.from(raw.data ?? '', 'utf8')
    if (isDir && data.length > 0) throw new Error(`目录条目不得含数据：${name}`)
    const nameBuf = Buffer.from(name, 'utf8')
    const comp = isDir ? Buffer.alloc(0) : zlib.deflateRawSync(data)
    const crc = isDir ? 0 : crc32(data)
    const srcSize = isDir ? 0 : data.length

    // 4GB 上限（与 core/archive.ts 一致，不静默截断）
    if (srcSize > 0xffffffff || comp.length > 0xffffffff) throw new Error(`条目过大：${name}`)

    locals.push(
      Buffer.concat([
        Buffer.from('PK\x03\x04', 'binary'),
        u16(20), // version needed
        u16(0x0800), // flags: UTF-8
        u16(isDir ? 0 : 8), // method: 0 store（目录）/ 8 deflate
        u16(0), // time
        u16(0), // date
        u32(crc),
        u32(comp.length),
        u32(srcSize),
        u16(nameBuf.length),
        u16(0), // extra len
        nameBuf,
      ]),
    )
    if (!isDir) locals.push(comp)
    central.push(
      Buffer.concat([
        Buffer.from('PK\x01\x02', 'binary'),
        u16(20), // version made by
        u16(20), // version needed
        u16(0x0800), // flags
        u16(isDir ? 0 : 8), // method
        u16(0), // time
        u16(0), // date
        u32(crc),
        u32(comp.length),
        u32(srcSize),
        u16(nameBuf.length),
        u16(0), // extra len
        u16(0), // comment len
        u16(0), // disk
        u16(0), // internal attrs
        u32(isDir ? 0x10 : 0), // external attrs（目录位）
        u32(offset),
        nameBuf,
      ]),
    )
    offset += 30 + nameBuf.length + comp.length
  }

  if (entries.length > 0xffff) throw new Error('条目数超 65535，暂不支持 ZIP64')
  const cd = Buffer.concat(central)
  if (offset + cd.length > 0xffffffff) throw new Error('包总大小超 4GB，暂不支持 ZIP64')
  const eocd = Buffer.concat([
    Buffer.from('PK\x05\x06', 'binary'),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(offset),
    u16(0), // comment len
  ])
  return Buffer.concat([...locals, cd, eocd])
}

// —— 源目录扫描 ——

/** 主进程入口探测：src/main/index.ts | index.js（存在其一） */
async function findMainEntry(srcDir) {
  for (const name of ['index.ts', 'index.js']) {
    const p = path.join(srcDir, 'src', 'main', name)
    if (await fsp.stat(p).catch(() => null)) return p
  }
  throw new Error(`缺少主进程入口：${path.join(srcDir, 'src/main/index.ts')}（或 index.js）`)
}

/** 渲染层源收集：src/renderer/** 下所有 .ts/.js（保持相对路径）；.tsx/.jsx 或 .ts/.js 内含 JSX 均明确报错
 * （esbuild 无 Solid JSX 编译，且对 .ts/.js 默认按 React 语义 transform——静默产出错误运行时，须拦截） */
const JSX_HINT_RE = /(^|[=(,{:]\s*|=>\s*|\breturn\s+)\s*<\/?[A-Za-z]/

async function collectRendererSources(srcDir) {
  const base = path.join(srcDir, 'src', 'renderer')
  const info = await fsp.stat(base).catch(() => null)
  if (!info) throw new Error(`缺少渲染层源目录：${base}`)
  const out = []
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase()
        if (ext === '.tsx' || ext === '.jsx') {
          throw new Error(
            `渲染层源含 JSX 文件（esbuild 无 Solid JSX 编译语义，本脚本不支持）：${full}。` +
              `请改用无 JSX 写法（import h from 'solid-js/h' 构造组件），见 scripts/build-hello-plugin.mjs 头注释`,
          )
        }
        if (ext === '.ts' || ext === '.js') {
          // .ts/.js 内 JSX：esbuild 会按 React 语义 transform（静默错误产物），内容检测拦截
          const text = await fsp.readFile(full, 'utf8').catch(() => '')
          if (JSX_HINT_RE.test(text)) {
            throw new Error(
              `渲染层源 .ts/.js 内含 JSX 语法（esbuild 无 Solid JSX 编译语义，本脚本不支持）：${full}。` +
                `请改用无 JSX 写法（import h from 'solid-js/h' 构造组件），见 scripts/build-hello-plugin.mjs 头注释`,
            )
          }
          out.push({ abs: full, rel: path.relative(base, full).replace(/\\/g, '/') })
        }
      }
    }
  }
  await walk(base)
  if (out.length === 0) throw new Error(`渲染层源目录无 .ts/.js 文件：${base}`)
  return out
}

/**
 * 构建 hello 插件 `.qbox`：esbuild（main→CJS bundle、renderer 每模块→ESM bundle 且 solid-js 打入自包含）
 * + manifest 原样进入包根 + packQbox 打包。
 * 返回产物路径与包内条目列表；全部内存完成（esbuild write:false），零中间文件。
 * @param {{ srcDir?: string; outDir?: string; log?: (...a: unknown[]) => void }} [opts]
 * @returns {Promise<{ outPath: string; files: string[] }>}
 */
export async function buildHelloPlugin(opts = {}) {
  // 构建流水线（四步，照抄即可看懂每一步在做什么）：
  //   ① 读 manifest.json —— 存在 + 可解析 + 有 id（结构级校验；九条完整校验由宿主登记期执行）
  //   ② esbuild 编译 —— main/index.ts → main/index.js（CJS）；renderer 每个 .ts/.js → renderer/<同名>.js（ESM，solid-js 打入自包含）
  //   ③ 打包 zip —— manifest 原样 + 编译产物，经 packQbox 手写 zip 容器输出 <id>.qbox
  //   ④ 落盘校验 —— 写入 outDir 后确认条目数与产物大小（log 打印；结构级，不含宿主完整校验）
  const srcDir = opts.srcDir ?? DEFAULT_SRC_DIR
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR
  const log = opts.log ?? (() => {})
  /** v2.5.1（波 0，D19）：main 构建 externals（字符串数组；默认空 = hello 不声明） */
  const externals = Array.isArray(opts.externals) ? opts.externals : []
  /** v2.5.7（F5b）：加密构建开关 + 权益门槛 + 密钥输出路径 */
  const encrypt = opts.encrypt === true
  const entitlement = opts.entitlement ?? 'login'
  const keyOut = opts.keyOut

  // —— manifest：存在 + JSON 可解析 + id 可用（完整校验由宿主登记期执行）——
  const manifestPath = path.join(srcDir, 'manifest.json')
  const manifestText = await fsp.readFile(manifestPath, 'utf8').catch(() => null)
  if (manifestText === null) throw new Error(`缺少插件清单：${manifestPath}`)
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (err) {
    throw new Error(`插件清单不是合法 JSON：${manifestPath}（${err.message}）`)
  }
  if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
    throw new Error('插件清单缺少 id（.qbox 包名依据）')
  }

  // —— esbuild：main（CJS，node 平台，宿主动态 import 取 default=module.exports）——
  // v2.5.1（波 0，D19）：externals 注入——ws 的 native 可选依赖（bufferutil/utf-8-validate）需 external
  //（esbuild 尝试解析失败即报错；ws 运行期有纯 JS fallback），由调用方 --externals 声明
  const mainEntry = await findMainEntry(srcDir)
  const mainBuild = await build({
    entryPoints: [mainEntry],
    outfile: 'main/index.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    nodePaths: NODE_PATHS,
    external: externals.length > 0 ? externals : undefined,
    // v2.5.7（F2a 构建 minify）：提示词/编排/契约不再以明文可读形态躺在包里（T1 逆向 IP 降低门槛）
    minify: true,
    logLevel: 'silent',
    write: false,
  })
  const mainOut = mainBuild.outputFiles?.find((f) => f.path.endsWith('/main/index.js'))
  if (!mainOut) throw new Error('esbuild 未产出 main/index.js')

  // —— esbuild：renderer（每模块独立 ESM bundle，solid-js 打入，宿主经协议 URL 动态 import 单文件）——
  const rendererSrcs = await collectRendererSources(srcDir)
  const rendererBuild = await build({
    entryPoints: rendererSrcs.map((s) => s.abs),
    outdir: 'renderer',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    splitting: false,
    nodePaths: NODE_PATHS,
    // 外部插件目录经 nodePaths 回退解析 solid-js 时，esbuild 会命中 package.json 的
    // module/main（server.js），导致插件渲染层拿到 Solid server 空实现（createEffect 不执行）。
    // 这里显式把 solid-js 主包别名到浏览器端 client 入口，确保插件页面使用真正的响应式实现。
    alias: {
      'solid-js': path.join(ROOT, 'node_modules/solid-js/dist/solid.js'),
      'solid-js/h': path.join(ROOT, 'node_modules/solid-js/h/dist/h.js'),
      'solid-js/web': path.join(ROOT, 'node_modules/solid-js/web/dist/web.js'),
    },
    mainFields: ['browser', 'module', 'main'],
    // v2.5.7（F2a 构建 minify）：渲染层同样压缩——叠加 F1b 去除提示词后，包内不再有
    // 可直接照抄的明文业务逻辑（T1 逆向 IP 门槛抬高）
    minify: true,
    logLevel: 'silent',
    write: false,
  })
  const rendererOuts = rendererBuild.outputFiles ?? []
  if (rendererOuts.length === 0) throw new Error('esbuild 未产出 renderer 产物')
  // write:false 时 outputFiles[].path 为绝对路径，按产物 basename（.ts→.js）匹配入口；同名冲突明确报错
  const rendererByBase = new Map()
  for (const f of rendererOuts) {
    const base = path.basename(f.path)
    if (rendererByBase.has(base)) throw new Error(`renderer 产物 basename 冲突：${base}`)
    rendererByBase.set(base, f)
  }
  const rendererFiles = []

  // —— 打包 ——
  // v2.5.7（F5b）：加密构建时，main/index.js 与 renderer/**.js → <name>.enc（明文不落包），
  // manifest 注入 encryption 块（algo/keyId 随机/entitlement）；assets 保持明文（不在加密范围）。
  let keyHex
  let cipherHashes = []
  if (encrypt) {
    if (entitlement !== 'login' && entitlement !== 'subscription') {
      throw new Error(`--entitlement 仅支持 login/subscription（当前：${entitlement}）`)
    }
    keyHex = crypto.randomBytes(32).toString('hex')
  }
  const entries = [
    {
      name: 'manifest.json',
      data: encrypt
        ? JSON.stringify({
            ...JSON.parse(manifestText),
            encryption: { algo: 'aes-256-gcm', keyId: crypto.randomUUID(), entitlement },
          })
        : manifestText,
    },
  ]
  if (encrypt) {
    const mainEnc = encryptBytes(mainOut.contents, keyHex)
    cipherHashes.push({ name: 'main/index.js', sha256: crypto.createHash('sha256').update(mainEnc).digest('hex') })
    entries.push({ name: 'main/index.js.enc', data: mainEnc })
  } else {
    entries.push({ name: 'main/index.js', data: mainOut.contents })
  }
  for (const s of rendererSrcs) {
    const outName = s.rel.replace(/\.ts$/, '.js')
    const out = rendererByBase.get(path.basename(outName))
    if (!out) throw new Error(`esbuild 未产出 renderer 产物：${s.rel}`)
    const zipName = `renderer/${outName}`
    if (encrypt) {
      const enc = encryptBytes(out.contents, keyHex)
      cipherHashes.push({ name: zipName, sha256: crypto.createHash('sha256').update(enc).digest('hex') })
      entries.push({ name: zipName + '.enc', data: enc })
    } else {
      entries.push({ name: zipName, data: out.contents })
    }
    rendererFiles.push(zipName)
  }

  // —— assets（可选）——<srcDir>/assets/** 原样入包（worker 运行时/主题等静态资源，存在即携带；无则零影响）
  if (await fsp.stat(path.join(srcDir, 'assets')).catch(() => null)) {
    const assetsFiles = await collectAssetEntries(srcDir)
    entries.push(...assetsFiles)
    log(`✓ assets/ 随包（${assetsFiles.length} 个文件）`)
  }

  await fsp.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, `${manifest.id}.qbox`)
  await fsp.writeFile(outPath, packQbox(entries), { mode: 0o644 })

  const kb = (n) => (n / 1024).toFixed(1)
  log(`✓ esbuild main → main/index.js (${kb(mainOut.contents.length)} KB)`)
  for (const f of rendererFiles) log(`✓ esbuild renderer → ${f}`)
  log(`✓ manifest.json 校验通过（结构级；完整校验由宿主登记期执行）`)
  if (encrypt) {
    // 内容密钥输出（默认 out/<id>.key，--key-out 覆盖）：构建人持有，登记 erp 用；密文 sha256 并列打印
    const keyFilePath = keyOut ?? path.join(outDir, `${manifest.id}.key`)
    await fsp.writeFile(keyFilePath, keyHex + '\n', { mode: 0o600 })
    log(`✓ 内容密钥 → ${keyFilePath}（权限 600，不进仓；erp 登记用）`)
    log(`✓ manifest 注入 encryption（keyId=${JSON.parse(entries[0].data).encryption.keyId}，entitlement=${entitlement}）`)
    for (const h of cipherHashes) log(`✓ 密文 sha256(${h.name})=${h.sha256}`)
  }
  log(`✓ 打包 → ${outPath}（${entries.length} 条目，${kb((await fsp.stat(outPath)).size)} KB）`)
  return { outPath, files: entries.map((e) => e.name), keyHex: keyHex ?? null, cipherHashes }
}

/** 收集 <srcDir>/assets/** 全部文件为 zip 条目（目录结构原样入包，不含空目录） */
async function collectAssetEntries(srcDir) {
  const base = path.join(srcDir, 'assets')
  const out = []
  const walk = async (dir, rel) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const name = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(abs, name)
      else out.push({ name: `assets/${name}`, data: await fsp.readFile(abs) })
    }
  }
  await walk(base, '')
  return out
}

// —— CLI（node scripts/build-hello-plugin.mjs [--src <dir>] [--out <dir>]）——
function isMain() {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return import.meta.url === pathToFileURL(path.resolve(argv1)).href
  } catch {
    return false
  }
}

if (isMain()) {
  const args = process.argv.slice(2)
  let src
  let out
  let externals
  let encrypt = false
  let entitlement
  let keyOut
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--src' && args[i + 1]) src = args[++i]
    else if (args[i] === '--out' && args[i + 1]) out = args[++i]
    else if (args[i] === '--externals' && args[i + 1]) externals = args[++i].split(',').map((s) => s.trim()).filter(Boolean)
    else if (args[i] === '--encrypt') encrypt = true
    else if (args[i] === '--entitlement' && args[i + 1]) entitlement = args[++i]
    else if (args[i] === '--key-out' && args[i + 1]) keyOut = args[++i]
    else {
      console.error(`未知参数：${args[i]}（用法：--src <dir> --out <dir> [--externals a,b,c] [--encrypt] [--entitlement login|subscription] [--key-out <file>]）`)
      process.exit(2)
    }
  }
  buildHelloPlugin({ srcDir: src, outDir: out, externals, encrypt, entitlement, keyOut }).catch((err) => {
    console.error(`✗ 构建失败：${err.message}`)
    process.exit(1)
  })
}
