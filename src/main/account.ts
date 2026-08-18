/**
 * 账号服务（v2.2.0）：可选登录（复用 ERP PocketBase 账号）+ 活跃心跳。
 *
 * 设计：
 * - 登录为可选；登录态供后续插件能力复用（host.account，见 PLUGIN.md）；统计是心跳副产品
 * - 隐私边界：心跳仅上报设备标识 / 平台 / 版本，文件与目录内容永不上传
 * - token 优先 safeStorage 加密落盘，Linux 无 keyring 时降级明文（本地单用户，JWT 过期即失效）
 * - 依赖注入（fetch / 加解密 / 版本 / 日志），主进程装配，vitest 可独立单测
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeJsonAtomic } from './core/jsonStore'

const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000
/** 登录请求上限（AbortController 超时 + race 兜底，v2.5.3 T4） */
const LOGIN_TIMEOUT_MS = 15_000
/** 单次心跳请求上限（v2.5.3 T4） */
const HEARTBEAT_TIMEOUT_MS = 10_000

/** 登录超时专用错误（与网络异常区分文案） */
class LoginTimeoutError extends Error {
  constructor() {
    super('login timeout')
    this.name = 'LoginTimeoutError'
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export interface AccountDeps {
  /** account.json 绝对路径（userData 下） */
  accountFile: string
  /** 登录/心跳服务地址（不含末尾斜杠）；由宿主从本地私有配置注入，不进公开仓 */
  baseUrl: string
  /** token 加密（safeStorage.encryptString → base64，失败抛错由调用方降级） */
  encrypt: (plain: string) => string
  /** token 解密；解密失败返回空串表示不可用 */
  decrypt: (encoded: string) => string
  /** 应用版本（app.getVersion） */
  version: () => string
  /** 日志（可选） */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
  /** 网络实现（默认全局 fetch） */
  fetchImpl?: typeof fetch
  /** 登录请求超时（ms）；测试可缩短（v2.5.3 T4） */
  loginTimeoutMs?: number
  /** 单次心跳请求超时（ms）；测试可缩短（v2.5.3 T4） */
  heartbeatTimeoutMs?: number
  /**
   * 心跳 401 会话过期回调（v2.5.3 P1-6）：首次置位 sessionExpired 时触发一次，
   * 携带当前完整登录态（照 status() 形状）；装配层注入广播到渲染层（beat 可能无窗口，由装配层处理）。
   */
  onSessionExpired?: (status: AccountStatus) => void
}

export interface AccountStatus {
  loggedIn: boolean
  email: string
  sessionExpired: boolean
}

interface StoredAccount {
  token: string
  userId: string
  email: string
  deviceId: string
}

const log = (deps: AccountDeps, level: 'info' | 'warn' | 'error', msg: string): void => {
  try {
    deps.log?.(level, `[account] ${msg}`)
  } catch {
    // 日志失败不影响主流程
  }
}

export class AccountService {
  private sessionExpired = false
  private heartbeatTimer: NodeJS.Timeout | null = null
  /**
   * v2.5（PLAN §3.2 r2-测试P1-4/架构P1-1/性能P1-3）：token/登录态内存缓存。
   * 修正伪前提：master account.ts 无内存缓存，status()/beat() 每次 load() 读盘+解密；
   * host.account 是同步接口且被高频调用（AI 类插件每次请求取 token），须走缓存。
   * 生命周期：login/load 读盘成功后写入；logout 清空；解密异常 → null + log 警告（不抛）。
   */
  private tokenCache: string | null = null
  private loggedInCache = false
  /** 会话代数：login/logout 递增；旧会话迟到的 beat 结果只按代数丢弃（v2.5.3 T4） */
  private sessionGen = 0
  /** 心跳单飞：在途时新 tick 直接跳过（v2.5.3 T4） */
  private beatInFlight = false
  /** 当前在途心跳的 AbortController（logout 中止用；完成后清空） */
  private currentBeatController: AbortController | null = null

  constructor(private deps: AccountDeps) {}

  // —— 本地落盘 ——

  private load(): StoredAccount | null {
    try {
      const raw = fs.readFileSync(this.deps.accountFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoredAccount>
      if (!parsed.token || !parsed.userId || !parsed.deviceId) return null
      const token = this.deps.decrypt(parsed.token)
      if (!token) {
        // v2.5：safeStorage 解密异常 → token 不可用，按未登录处理（log 警告，不抛）
        log(this.deps, 'warn', 'token 解密失败（safeStorage 异常？），按未登录处理')
        this.tokenCache = null
        this.loggedInCache = false
        return null
      }
      const acc: StoredAccount = {
        token,
        userId: parsed.userId,
        email: parsed.email ?? '',
        deviceId: parsed.deviceId,
      }
      // v2.5：读盘成功 → 写入缓存（getToken/isLoggedIn 直接返回，不重复读盘+解密）
      this.tokenCache = token
      this.loggedInCache = true
      return acc
    } catch {
      // 文件缺失/损坏 → 同步清缓存（登录态已不存在，host.account 不得返回旧 token）
      this.tokenCache = null
      this.loggedInCache = false
      return null
    }
  }

  /** 原子落盘：mkdir -p + 临时文件 rename（durable fsync）；失败返回 false（v2.5.3 T4） */
  private async save(acc: StoredAccount): Promise<boolean> {
    try {
      await fsp.mkdir(path.dirname(this.deps.accountFile), { recursive: true })
      const payload: StoredAccount = { ...acc, token: this.deps.encrypt(acc.token) }
      await writeJsonAtomic(this.deps.accountFile, payload, { durable: true })
      return true
    } catch (err) {
      log(this.deps, 'error', `落盘失败: ${String(err)}`)
      return false
    }
  }

  private async remove(): Promise<void> {
    // v2.5.3（T4）A1：不再吞错——移除失败向上抛，由 logout() 外层 try/catch 记录日志
    // （此前内部 catch 吞掉一切，logout() 的「移除失败要 log」分支永不触发，属死代码）
    await fsp.rm(this.deps.accountFile, { force: true })
  }

  // —— 登录 / 登出 / 状态 ——

  async login(
    email: string,
    password: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.deps.baseUrl) {
      return { ok: false, error: '未配置服务器地址，登录不可用' }
    }
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const controller = new AbortController()
    const timeoutMs = this.deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS
    let timer: NodeJS.Timeout | undefined
    // 超时：AbortController 通知真实 fetch 取消；race 兜底（mock 忽略 signal 时仍能判超时）
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new LoginTimeoutError())
      }, timeoutMs)
    })
    let res: Response
    try {
      res = await Promise.race([
        fetchImpl(`${this.deps.baseUrl}/collections/users/auth-with-password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // 桌面客户端标识：服务端据此豁免图形验证码（仍受邮箱认证+登录限流保护）
            'X-Qihe-Client': 'box',
          },
          body: JSON.stringify({ identity: email, password }),
          signal: controller.signal,
        }),
        timeoutPromise,
      ])
    } catch (err) {
      if (err instanceof LoginTimeoutError) {
        return { ok: false, error: '登录超时，请检查网络后重试' }
      }
      if (isAbortError(err) && controller.signal.aborted) {
        // 超时 abort 引起的 AbortError（真实 fetch）→ 与超时同文案
        return { ok: false, error: '登录超时，请检查网络后重试' }
      }
      return { ok: false, error: '网络异常，请检查网络后重试' }
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      // v2.5.1 登录增强（D3/D9）：透传服务端 message（凭据错误等如实展示），
      // 429 限流给固定文案；message 限长 200 字符防撑破布局（P2-D）。隐私边界不变。
      let serverMsg = ''
      try {
        const b = (await res.json()) as { message?: string }
        serverMsg = typeof b?.message === 'string' ? b.message.trim() : ''
      } catch {
        // 响应体非 JSON → 走兜底
      }
      if (res.status === 429) {
        return { ok: false, error: '登录过于频繁，请稍后再试' }
      }
      if (serverMsg) {
        return { ok: false, error: serverMsg.slice(0, 200) }
      }
      return { ok: false, error: '登录失败，请稍后重试' }
    }
    let body: { token?: string; record?: { id?: string; email?: string } }
    try {
      body = await res.json()
    } catch {
      return { ok: false, error: '登录响应异常，请稍后重试' }
    }
    const token = body?.token
    const userId = body?.record?.id
    if (!token || !userId) {
      return { ok: false, error: '登录响应异常，请稍后重试' }
    }
    const existing = this.load()
    const deviceId = existing?.deviceId ?? randomUUID()
    // 只有落盘成功才写缓存、启动心跳并返回成功（v2.5.3 T4）
    const saved = await this.save({ token, userId, email: body.record?.email ?? email, deviceId })
    if (!saved) {
      return { ok: false, error: '登录状态保存失败，请重试' }
    }
    this.sessionExpired = false
    this.sessionGen += 1 // 新会话代数：旧心跳迟到结果一律丢弃
    // v2.5：登录成功写入 token 缓存（host.account 同步读取）
    this.tokenCache = token
    this.loggedInCache = true
    log(this.deps, 'info', `登录成功 user=${userId}`)
    // 登录即启动心跳（统计活跃），并立即上报一次
    this.startHeartbeat()
    void this.beat(this.sessionGen)
    return { ok: true }
  }

  async logout(): Promise<void> {
    this.stopHeartbeat()
    this.sessionGen += 1 // 登出即换代：在途心跳结果作废
    this.currentBeatController?.abort()
    this.currentBeatController = null
    try {
      await this.remove()
    } catch (err) {
      // 移除失败记录日志，但不阻塞内存登出（v2.5.3 T4）
      log(this.deps, 'error', `移除账号文件失败: ${String(err)}`)
    }
    this.sessionExpired = false
    // v2.5：登出清空 token 缓存
    this.tokenCache = null
    this.loggedInCache = false
  }

  /** v2.5（PLAN §3.2）：同步返回 token 内存缓存（登录态读盘时写入；未登录 → null） */
  getToken(): string | null {
    return this.tokenCache
  }

  /** v2.5（PLAN §3.2）：同步返回登录态缓存 */
  isLoggedIn(): boolean {
    return this.loggedInCache
  }

  status(): AccountStatus {
    const acc = this.load()
    if (!acc) {
      return { loggedIn: false, email: '', sessionExpired: false }
    }
    return { loggedIn: true, email: acc.email, sessionExpired: this.sessionExpired }
  }

  // —— 心跳（活跃统计，失败静默）——

  /**
   * 心跳上报（v2.5.3 T4 加固）：
   * - 单飞：在途时新 tick 直接跳过，不并发重复上报；
   * - 代数隔离：login/logout 递增 sessionGen，旧会话迟到结果不写入状态；
   * - 超时：heartbeatTimeoutMs 上限，AbortController + race 兜底；结束后清 controller。
   */
  async beat(gen?: number): Promise<void> {
    if (this.beatInFlight) return
    const acc = this.load()
    if (!acc || !this.deps.baseUrl) return
    this.beatInFlight = true
    const controller = new AbortController()
    this.currentBeatController = controller
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const timeoutMs = this.deps.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('heartbeat timeout'))
      }, timeoutMs)
    })
    try {
      try {
        const res = await Promise.race([
          fetchImpl(`${this.deps.baseUrl}/box/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${acc.token}` },
            body: JSON.stringify({
              device_id: acc.deviceId,
              platform: process.platform + (process.arch ? `-${process.arch}` : ''),
              version: this.deps.version(),
            }),
            signal: controller.signal,
          }),
          timeoutPromise,
        ])
        if (gen !== undefined && gen !== this.sessionGen) return // 旧会话迟到结果丢弃
        if (res.status === 401) {
          if (!this.sessionExpired) {
            this.sessionExpired = true
            // v2.5.3（P1-6）：会话过期 → 广播到渲染层（Profile 过期横幅即时刷新）；
            // 只在新置位时广播，避免每小时心跳对同一过期态重复推送
            this.deps.onSessionExpired?.(this.status())
          }
          log(this.deps, 'warn', '心跳 401，会话已失效')
        }
      } catch {
        if (gen !== undefined && gen !== this.sessionGen) return
        if (controller.signal.aborted) {
          if (this.currentBeatController === controller) {
            // 超时 abort（本 beat 自己的 controller 仍在职、未被清空）→ 心跳超时
            log(this.deps, 'warn', '心跳超时，已取消')
          } else {
            // controller 已被 logout 清空/被新 beat 替换 → abort 来自登出中止，
            // 不作「心跳超时」误报（v2.5.3 T4 C2）
            log(this.deps, 'info', '心跳被中止（登出）')
          }
        }
        // 其他网络异常静默（不影响使用）
      }
    } finally {
      clearTimeout(timer)
      if (this.currentBeatController === controller) this.currentBeatController = null
      this.beatInFlight = false
    }
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return
    // v2.4.7（评审 P5）：.unref()——心跳定时器不阻止进程退出（与每日任务一致；托盘常驻本身已保活）
    this.heartbeatTimer = setInterval(() => void this.beat(this.sessionGen), HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref()
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
