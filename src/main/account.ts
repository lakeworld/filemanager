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
import path from 'node:path'

const BASE_URL = 'https://api.example.invalid'
const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000

export interface AccountDeps {
  /** account.json 绝对路径（userData 下） */
  accountFile: string
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

  constructor(private deps: AccountDeps) {}

  // —— 本地落盘 ——

  private load(): StoredAccount | null {
    try {
      const raw = fs.readFileSync(this.deps.accountFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoredAccount>
      if (!parsed.token || !parsed.userId || !parsed.deviceId) return null
      return {
        token: this.deps.decrypt(parsed.token),
        userId: parsed.userId,
        email: parsed.email ?? '',
        deviceId: parsed.deviceId,
      }
    } catch {
      return null
    }
  }

  private save(acc: StoredAccount): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.accountFile), { recursive: true })
      const payload: StoredAccount = { ...acc, token: this.deps.encrypt(acc.token) }
      fs.writeFileSync(this.deps.accountFile, JSON.stringify(payload, null, 2), 'utf8')
    } catch (err) {
      log(this.deps, 'error', `落盘失败: ${String(err)}`)
    }
  }

  private remove(): void {
    try {
      fs.rmSync(this.deps.accountFile, { force: true })
    } catch {
      // 忽略
    }
  }

  // —— 登录 / 登出 / 状态 ——

  async login(
    email: string,
    password: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    let res: Response
    try {
      res = await fetchImpl(`${BASE_URL}/collections/users/auth-with-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 桌面客户端标识：服务端据此豁免图形验证码（仍受邮箱认证+登录限流保护）
          'X-Qihe-Client': 'box',
        },
        body: JSON.stringify({ identity: email, password }),
      })
    } catch {
      return { ok: false, error: '网络异常，请检查网络后重试' }
    }
    if (!res.ok) {
      // 登录可能触发 ERP 验证码 / 限流 / 邮箱验证，统一引导到官网网页端
      return { ok: false, error: '登录失败（可能需邮箱验证或验证码），请前往官网网页端登录后重试' }
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
    this.sessionExpired = false
    this.save({ token, userId, email: body.record?.email ?? email, deviceId })
    log(this.deps, 'info', `登录成功 user=${userId}`)
    // 登录即启动心跳（统计活跃），并立即上报一次
    this.startHeartbeat()
    void this.beat()
    return { ok: true }
  }

  async logout(): Promise<void> {
    this.stopHeartbeat()
    this.remove()
    this.sessionExpired = false
  }

  status(): AccountStatus {
    const acc = this.load()
    if (!acc) {
      return { loggedIn: false, email: '', sessionExpired: false }
    }
    return { loggedIn: true, email: acc.email, sessionExpired: this.sessionExpired }
  }

  // —— 心跳（活跃统计，失败静默）——

  async beat(): Promise<void> {
    const acc = this.load()
    if (!acc) return
    const fetchImpl = this.deps.fetchImpl ?? fetch
    try {
      const res = await fetchImpl(`${BASE_URL}/box/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${acc.token}` },
        body: JSON.stringify({
          device_id: acc.deviceId,
          platform: process.platform + (process.arch ? `-${process.arch}` : ''),
          version: this.deps.version(),
        }),
      })
      if (res.status === 401) {
        this.sessionExpired = true
        log(this.deps, 'warn', '心跳 401，会话已失效')
      }
    } catch {
      // 网络异常静默（不影响使用）
    }
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return
    // v2.4.7（评审 P5）：.unref()——心跳定时器不阻止进程退出（与每日任务一致；托盘常驻本身已保活）
    this.heartbeatTimer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref()
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
