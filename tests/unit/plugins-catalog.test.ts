/**
 * 官方索引目录单测（v2.6 批 2，宿主侧）：拉取 / 解析 / 兼容映射 / 中文出路。
 *
 * 为什么这些用例必须存在：目录链**没有服务端可依赖**（erp 侧同批在实现），
 * 所以宿主这一半的行为只能靠注入 fetch 的夹具钉死；其中三条是「不许谎报」的硬判据——
 * 未登录、未配置服务器、端点未部署，**一条都不能退化成「暂无插件」的空目录**。
 *
 * 覆盖：
 * 1. 端点 URL 解析（尾 /api 剥一次，防 /api/api 双段 → SPA 兜底 200 假空目录）；
 * 2. 未登录 / 未配置 / 未部署 / 网络 / 坏形状 → 各自的中文错误码，且**失败路径不发请求**（未登录）；
 * 3. 200 + 空列表 = 真「目录为空」（唯一允许显示「暂无插件」的情形）；
 * 4. versions 兼容映射：apiCompat 相交 + minHostVersion ≥ + 取语义化最高（不是数组最后一个）；
 * 5. 语义化版本比对边界（0.10.0 > 0.9.0；预发布小于正式）。
 * 6. **2.6.2 展示字段**（`images` / `detail` / 每版 `releaseNotes`）：只宽容展示位、
 *    不放过承重字段——这条分界就是这组用例存在理由（宽容用错地方 = 目录哑掉没人报）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CATALOG_ERRORS,
  CATALOG_IMAGE_MAX,
  catalogHttpError,
  compareSemver,
  fetchCatalog,
  isVersionCompatible,
  parseCatalogPayload,
  resolveCatalogUrl,
  resolveCompatibleVersion,
  toCatalogEntries,
  type RawCatalogEntry,
} from '../../src/main/plugins/catalog'
import type { PluginCatalogVersion } from '../../src/shared/types'

const HOST = { apiVersion: 1, productVersion: '2.6.0' }

/** 夹具：一个合法目录项（字段可按需覆盖） */
function rawEntry(over: Partial<RawCatalogEntry> = {}): RawCatalogEntry {
  return {
    id: 'com.qihe.cloud',
    name: '启禾云助手',
    description: '打标签 / AI 识别 / 云端取钥',
    author: '启禾软件',
    icon: 'https://example.com/icons/cloud.png',
    source: '启禾官方',
    permissions: { account: true, network: ['api.example.com'] },
    versions: [catalogVersion()],
    ...over,
  }
}

/** 夹具：一个合法版本（默认全兼容 HOST） */
function catalogVersion(over: Partial<PluginCatalogVersion> = {}): PluginCatalogVersion {
  return {
    version: '0.7.0',
    apiCompat: [1, 1],
    minHostVersion: '2.5.0',
    size: 1_500_000,
    sha256: 'a'.repeat(64),
    downloadUrl: 'https://example.com/pkgs/cloud-0.7.0.qbox',
    ...over,
  }
}

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

const catalogBody = (plugins: unknown[]): unknown => ({
  code: 200,
  data: { catalog_version: 1, plugins },
})

describe('resolveCatalogUrl：端点拼接（尾 /api 剥一次，防双段）', () => {
  it('基址不带 /api 与带 /api 都拼成同一端点', () => {
    expect(resolveCatalogUrl('https://example.com')).toBe('https://example.com/api/box/plugin-catalog')
    expect(resolveCatalogUrl('https://example.com/')).toBe('https://example.com/api/box/plugin-catalog')
    // 批 2.5 P0-1 先例：resolveApiBase() 返回 `…/api` → 必须剥一次，否则 /api/api → SPA 兜底 200 假空目录
    expect(resolveCatalogUrl('https://example.com/api')).toBe('https://example.com/api/box/plugin-catalog')
    expect(resolveCatalogUrl('https://example.com/api/')).toBe('https://example.com/api/box/plugin-catalog')
  })

  it('未配置服务器（空基址）→ NO_SERVER 中文错误', () => {
    expect(() => resolveCatalogUrl('')).toThrow(/NO_SERVER/)
    expect(() => resolveCatalogUrl('   ')).toThrow(/未配置云服务地址/)
  })
})

describe('fetchCatalog：中文出路（不许谎报空目录）', () => {
  it('未登录 → NOT_LOGGED_IN，且**不发起请求**', async () => {
    const fetchImpl = vi.fn()
    await expect(
      fetchCatalog({ baseUrl: 'https://example.com/api', getToken: () => null, fetchImpl }, HOST),
    ).rejects.toThrow(/NOT_LOGGED_IN/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('未配置服务器 → NO_SERVER，且不发起请求', async () => {
    const fetchImpl = vi.fn()
    await expect(
      fetchCatalog({ baseUrl: '', getToken: () => 'jwt', fetchImpl }, HOST),
    ).rejects.toThrow(/NO_SERVER/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('端点未部署（HTTP 404）→ NOT_DEPLOYED，绝不退化成空目录', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'not found' }, { status: 404 }))
    await expect(
      fetchCatalog({ baseUrl: 'https://example.com', getToken: () => 'jwt', fetchImpl }, HOST),
    ).rejects.toThrow(/NOT_DEPLOYED：官方插件目录服务未就绪（HTTP 404）/)
  })

  it('401/403 → NOT_LOGGED_IN（登录态已失效）；5xx → CATALOG_UNAVAILABLE（稍后重试）', async () => {
    const f401 = vi.fn(async () => jsonResponse({}, { status: 401 }))
    await expect(
      fetchCatalog({ baseUrl: 'https://example.com', getToken: () => 'jwt', fetchImpl: f401 }, HOST),
    ).rejects.toThrow(/NOT_LOGGED_IN：官方插件目录登录态已失效（HTTP 401）/)
    const f500 = vi.fn(async () => jsonResponse({}, { status: 500 }))
    await expect(
      fetchCatalog({ baseUrl: 'https://example.com', getToken: () => 'jwt', fetchImpl: f500 }, HOST),
    ).rejects.toThrow(/CATALOG_UNAVAILABLE：官方插件目录获取失败（HTTP 500）/)
  })

  it('网络不可达 → CATALOG_UNAVAILABLE（网络不可达）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      fetchCatalog({ baseUrl: 'https://example.com', getToken: () => 'jwt', fetchImpl }, HOST),
    ).rejects.toThrow(/CATALOG_UNAVAILABLE：官方插件目录获取失败（网络不可达）/)
  })

  it('回包不是 JSON → CATALOG_BAD_PAYLOAD', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>SPA fallback</html>', { status: 200 }))
    await expect(
      fetchCatalog({ baseUrl: 'https://example.com', getToken: () => 'jwt', fetchImpl }, HOST),
    ).rejects.toThrow(/CATALOG_BAD_PAYLOAD/)
  })

  it('200 + 空列表 = 真「目录为空」（唯一允许的空态）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(catalogBody([])))
    await expect(
      fetchCatalog({ baseUrl: 'https://example.com', getToken: () => 'jwt', fetchImpl }, HOST),
    ).resolves.toEqual([])
  })

  it('正常拉取：带 Bearer 登录态、GET、解析字段并补宿主兼容判定', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(catalogBody([rawEntry()])))
    const out = await fetchCatalog({ baseUrl: 'https://example.com/api', getToken: () => 'jwt-abc', fetchImpl }, HOST)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.com/api/box/plugin-catalog')
    expect(init?.method).toBe('GET')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt-abc')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('com.qihe.cloud')
    expect(out[0].name).toBe('启禾云助手')
    expect(out[0].source).toBe('启禾官方')
    expect(out[0].compatible).toBe(true)
    expect(out[0].selected?.version).toBe('0.7.0')
    expect(out[0].selected?.sha256).toBe('a'.repeat(64))
    expect(out[0].reason).toBeUndefined()
  })
})

describe('parseCatalogPayload：严格解析（坏形状 → 中文错误，不静默丢条目）', () => {
  it('顶层非对象 / 缺 data.plugins / code 非 200 → BAD_PAYLOAD', () => {
    expect(() => parseCatalogPayload(null)).toThrow(/CATALOG_BAD_PAYLOAD：官方插件目录返回格式无法识别（顶层不是对象）/)
    expect(() => parseCatalogPayload({ code: 200, data: {} })).toThrow(/缺少 data\.plugins 数组/)
    expect(() => parseCatalogPayload({ code: 500, data: { plugins: [] } })).toThrow(/code=500，期望 200/)
  })

  it('data 直接是数组（少包一层）也接受——防整条链因形状差异哑掉', () => {
    expect(parseCatalogPayload({ code: 200, data: [rawEntry()] })).toHaveLength(1)
  })

  it('条目坏掉即整体报错，并指认第几项（宁可真话，不静默少一个插件）', () => {
    const bad = [
      rawEntry(),
      rawEntry({ id: 'com.qihe.lan', versions: [] }),
    ]
    expect(() => parseCatalogPayload(catalogBody(bad))).toThrow(/第 2 项（com\.qihe\.lan）缺少 versions/)
    expect(() => parseCatalogPayload(catalogBody([{ name: 'x', versions: [] }]))).toThrow(/第 1 项 的 id 不合法/)
  })

  it('版本字段校验：sha256 形状 / downloadUrl 必填 / apiCompat 元组 / size 数值', () => {
    const withVer = (v: unknown): unknown => catalogBody([rawEntry({ versions: [v as PluginCatalogVersion] })])
    expect(() => parseCatalogPayload(withVer(catalogVersion({ sha256: 'ZZZ' })))).toThrow(/sha256 不是 64 位十六进制/)
    expect(() => parseCatalogPayload(withVer(catalogVersion({ downloadUrl: '' })))).toThrow(/缺少 downloadUrl/)
    expect(() =>
      parseCatalogPayload(withVer(catalogVersion({ apiCompat: [2, 1] as [number, number] }))),
    ).toThrow(/apiCompat 须为 \[min, max\] 数值元组/)
    expect(() => parseCatalogPayload(withVer(catalogVersion({ size: -1 })))).toThrow(/size 须为非负数值/)
  })
})

describe('versions 兼容映射（宿主按 API_VERSION + 产品版本选最新兼容版本）', () => {
  it('compareSemver：数字段逐段比；0.10.0 > 0.9.0；预发布小于同核心正式版', () => {
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0', '1.0.0-rc1')).toBeGreaterThan(0)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
    expect(compareSemver('2.0.0', '2.0.0+build7')).toBe(0)
  })

  it('apiCompat 缺省视为 [1,1]（与 manifest 同口径）；不相交 → 不兼容', () => {
    expect(isVersionCompatible({ ...catalogVersion(), apiCompat: undefined }, HOST)).toBe(true)
    expect(isVersionCompatible(catalogVersion({ apiCompat: [2, 3] }), HOST)).toBe(false)
    expect(isVersionCompatible(catalogVersion({ apiCompat: [0, 0] }), HOST)).toBe(false)
  })

  it('minHostVersion 高于宿主产品版本 → 不兼容；等于 → 兼容', () => {
    expect(isVersionCompatible(catalogVersion({ minHostVersion: '2.6.1' }), HOST)).toBe(false)
    expect(isVersionCompatible(catalogVersion({ minHostVersion: '2.6.0' }), HOST)).toBe(true)
  })

  it('选版 = 兼容版本里语义化最高者（数组顺序反着给也一样）', () => {
    const versions = [
      catalogVersion({ version: '0.7.0', minHostVersion: '2.0.0' }),
      catalogVersion({ version: '0.10.0', minHostVersion: '2.6.0' }),
      catalogVersion({ version: '0.9.0', minHostVersion: '2.5.0' }),
    ]
    expect(resolveCompatibleVersion(versions, HOST)?.version).toBe('0.10.0')
    // 旧宿主自动选兼容旧版（PLUGIN.md §三.3 的 versions.json 语义）
    const oldHost = { apiVersion: 1, productVersion: '2.5.0' }
    expect(resolveCompatibleVersion(versions, oldHost)?.version).toBe('0.9.0')
  })

  it('全不兼容：不选版；条目 compatible=false 且给出中文原因（置灰用）', () => {
    const versions = [catalogVersion({ version: '0.8.0', minHostVersion: '9.9.9' })]
    expect(resolveCompatibleVersion(versions, HOST)).toBeNull()
    const [entry] = toCatalogEntries([rawEntry({ versions })], HOST)
    expect(entry.compatible).toBe(false)
    expect(entry.selected).toBeUndefined()
    expect(entry.reason).toContain('无与当前宿主兼容的版本')
    expect(entry.reason).toContain('API v1')
    expect(entry.reason).toContain('2.6.0')
  })

  it('apiCompat 不相交的版本被过滤，只留相交版本', () => {
    const versions = [
      catalogVersion({ version: '0.9.0', apiCompat: [2, 2] }),
      catalogVersion({ version: '0.8.0', apiCompat: [1, 1] }),
    ]
    expect(resolveCompatibleVersion(versions, HOST)?.version).toBe('0.8.0')
  })
})

describe('catalogHttpError：状态码 → 中文人话', () => {
  it('401/403 归登录态、404 归未部署、其余归稍后重试', () => {
    expect(catalogHttpError(403)).toContain('NOT_LOGGED_IN')
    expect(catalogHttpError(404)).toBe(CATALOG_ERRORS.NOT_DEPLOYED)
    expect(catalogHttpError(502)).toContain('HTTP 502')
  })
})

// —— 2.6.2 展示字段（截图 / 详情长文 / 每版更新说明）——
// 口径：这些字段坏了不影响"能不能装"，所以**逐条降级为缺省**而不是抛错；
// 但 sha256 / downloadUrl 这类承重字段一律照旧整体抛错。两条各测一头，防"宽容"被用过头。

/** 最小合法回包（展示字段与版本字段可按需覆盖，坏形状用例靠传非预期类型） */
function payloadWith(entryOver: Record<string, unknown> = {}, versionOver: Record<string, unknown> = {}): unknown {
  return {
    code: 200,
    data: {
      plugins: [
        {
          id: 'com.qihe.tools',
          name: '文件工具箱',
          versions: [
            {
              version: '0.1.8',
              sha256: 'a'.repeat(64),
              downloadUrl: 'https://example.com/com.qihe.tools-0.1.8.qbox',
              ...versionOver,
            },
          ],
          ...entryOver,
        },
      ],
    },
  }
}

const firstEntry = (json: unknown) => parseCatalogPayload(json)[0]

describe('2.6.2 展示字段：原样收下 + 只宽容展示位', () => {
  it('images / detail / 每版 releaseNotes 三项都给了 ⇒ 逐字保留（不是只判"存在"）', () => {
    const e = firstEntry(
      payloadWith(
        {
          images: ['https://img.example.com/tools-1.png', 'https://img.example.com/tools-2.png'],
          detail: '一次挑最多 100 张图。\n\n压缩、改尺寸、格式互转、裁剪旋转都在本机完成，文件不出这台电脑。',
        },
        { releaseNotes: '新增按比例裁剪（1:1 / 4:3 / 16:9）。' },
      ),
    )
    expect(e.images).toEqual([
      'https://img.example.com/tools-1.png',
      'https://img.example.com/tools-2.png',
    ])
    expect(e.detail).toContain('一次挑最多 100 张图')
    expect(e.detail).toContain('文件不出这台电脑')
    expect(e.versions[0].releaseNotes).toBe('新增按比例裁剪（1:1 / 4:3 / 16:9）。')
  })

  it('images 只收 http(s) 项、保持原顺序、超上限截断（上限 = CATALOG_IMAGE_MAX）', () => {
    const given = [
      'https://a.png',
      'http://b.png',
      'ftp://c.png',
      '',
      42,
      null,
      'https://d.png',
      'https://e.png',
    ]
    const e = firstEntry(payloadWith({ images: given }))
    expect(e.images).toEqual(['https://a.png', 'http://b.png', 'https://d.png'])
    expect(e.images!.length).toBe(CATALOG_IMAGE_MAX)
  })

  it('一张都不合法 ⇒ 字段整条缺省（不是给空数组——空数组会让界面留一排空图框）', () => {
    const e = firstEntry(payloadWith({ images: ['javascript:alert(1)', '  ', {}, []] }))
    expect('images' in e).toBe(false)
  })

  it('images 压根不是数组 / detail 是数字 ⇒ 只丢该字段，条目照常可用（目录不许因展示位坏整体打红）', () => {
    const e = firstEntry(payloadWith({ images: 'https://a.png', detail: 2026 }))
    expect('images' in e).toBe(false)
    expect('detail' in e).toBe(false)
    expect(e.id).toBe('com.qihe.tools')
    expect(e.versions[0].downloadUrl).toBe('https://example.com/com.qihe.tools-0.1.8.qbox')
  })

  it('detail 原样不截断（截断 = 显示一份被宿主改短的内容，比不显示更难查；上限住在服务端写入闸）', () => {
    const long = '图'.repeat(5000)
    const e = firstEntry(payloadWith({ detail: long }))
    expect(e.detail).toBe(long)
    expect(e.detail!.length).toBe(5000)
  })

  it('releaseNotes 空串 / 纯空白 ⇒ 该版缺省此字段（界面据此整行不显示，不写"无更新说明"占位）', () => {
    expect('releaseNotes' in parseCatalogPayload(payloadWith({}, { releaseNotes: '' }))[0].versions[0]).toBe(false)
    expect('releaseNotes' in parseCatalogPayload(payloadWith({}, { releaseNotes: '   \n ' }))[0].versions[0]).toBe(false)
  })

  it('反向：展示字段合法但承重字段坏 ⇒ 仍整体抛 CATALOG_BAD_PAYLOAD（宽容不许蔓延到 sha256）', () => {
    expect(() =>
      firstEntry(payloadWith({ images: ['https://a.png'], detail: 'x' }, { sha256: 'not-a-hash' })),
    ).toThrow(CATALOG_ERRORS.BAD_PAYLOAD)
  })
})