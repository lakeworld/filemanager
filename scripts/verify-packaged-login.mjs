#!/usr/bin/env node
/**
 * 发布红线：打包产物登录实测（RELEASE-RUNBOOK ③ 配套）。
 *
 * 对**已安装的打包产物**（非 out/ 开发产物）跑完整登录流程：
 * 退出旧登录态 → UI 表单重新登录 → 断言登录态 + 登录后即时心跳无 401/超时告警。
 *
 * 用法：
 *   QIHEBOX_VERIFY_EMAIL=... QIHEBOX_VERIFY_PASSWORD=... node scripts/verify-packaged-login.mjs [可执行文件路径]
 *
 * - 凭据只走环境变量，不落盘不进仓；可执行文件路径默认 Linux deb 安装位（/opt/启禾文件管理/qihe-box），
 *   Windows 可传 NSIS 安装后的 exe 路径。
 * - 用真实 userData（不设 QIHEBOX_E2E）：验证的是用户实际拿到的包 + 包内置 server.json 地址。
 * - 任一环节失败即非零退出（红线，fail-closed）。
 */
import { _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const email = process.env.QIHEBOX_VERIFY_EMAIL
const password = process.env.QIHEBOX_VERIFY_PASSWORD
if (!email || !password) {
  console.error('[login-verify] 缺少 QIHEBOX_VERIFY_EMAIL / QIHEBOX_VERIFY_PASSWORD 环境变量')
  process.exit(2)
}

const execPath = process.argv[2] ?? '/opt/启禾文件管理/qihe-box'
if (!fs.existsSync(execPath)) {
  console.error(`[login-verify] 可执行文件不存在: ${execPath}`)
  process.exit(2)
}

/** 打包产物的生产 userData 日志目录（与 app 内 app.getPath('logs') 一致） */
function prodLogsDir() {
  return path.join(os.homedir(), '.config', '启禾文件管理', 'logs')
}

function todayLogFile() {
  const d = new Date()
  const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return path.join(prodLogsDir(), `main-${ds}.log`)
}

function fail(msg) {
  console.error(`[login-verify] FAIL: ${msg}`)
  process.exit(1)
}

const app = await electron.launch({ executablePath: execPath, args: ['--no-sandbox'] })
let page
try {
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!window.qihebox, null, { timeout: 15000 })
  await page.waitForFunction(() => !!document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 15000 })

  const t0 = Date.now()
  // 日志增量基线：只断言本次启动后的新增内容（当日日志可能含历史告警）
  let logBeforeLen = 0
  try {
    logBeforeLen = fs.readFileSync(todayLogFile(), 'utf8').length
  } catch {
    /* 当日日志尚不存在 */
  }
  const status0 = (await page.evaluate(() => window.qihebox.account.status()))?.data
  console.log(`[login-verify] 初始登录态: loggedIn=${status0?.loggedIn} email=${status0?.email || '(未登录)'}`)

  // 进 Profile 页账号区（侧栏「我的」→ 账号 tab）
  await page.getByText('我的', { exact: false }).first().click()
  await page.getByText('账号', { exact: true }).first().click()

  // 已有登录态 → 先退出（完整流程从登出开始）
  if (status0?.loggedIn) {
    await page.getByText('登出', { exact: true }).first().click()
    await page.waitForFunction(() => !!document.querySelector('input[placeholder="邮箱"]'), null, { timeout: 10000 })
    console.log('[login-verify] 已退出旧登录态')
  }

  // UI 表单登录
  await page.fill('input[placeholder="邮箱"]', email)
  await page.fill('input[placeholder="密码"]', password)
  await page.getByRole('button', { name: '登录', exact: true }).click()

  // 等 UI 级结果：成功 = 表单换成已登录态（邮箱输入框消失）；失败 = 红色错误条出现
  const outcome = await Promise.race([
    page
      .waitForFunction(() => !document.querySelector('input[placeholder="邮箱"]'), null, { timeout: 25000 })
      .then(() => 'success'),
    page
      .waitForSelector('.text-danger-600', { timeout: 25000 })
      .then(async (el) => `error:${(await el.textContent())?.trim() ?? ''}`),
  ]).catch(() => 'timeout')
  if (outcome !== 'success') fail(`UI 登录未成功: ${outcome}`)

  // 主进程登录态断言（ApiResult 包装 → .data）
  const status1 = (await page.evaluate(() => window.qihebox.account.status()))?.data
  if (!status1?.loggedIn) fail('登录后 status().loggedIn 仍为 false')
  if (status1.sessionExpired) fail('登录后 sessionExpired 不应为 true')
  console.log(`[login-verify] UI 登录成功: email=${status1.email}`)

  // 登录成功即触发一次即时心跳（account.ts login → beat）：等 5s 让心跳跑完，
  // 断言主进程日志出现「登录成功」且无新增 401/超时告警
  await page.waitForTimeout(5000)
  let logText = ''
  try {
    logText = fs.readFileSync(todayLogFile(), 'utf8').slice(logBeforeLen)
  } catch {
    fail(`主进程日志不可读: ${todayLogFile()}`)
  }
  if (!logText.includes('[account] 登录成功')) fail('主进程日志本次无「登录成功」记录')
  if (logText.includes('[account] 心跳 401') || logText.includes('[account] 心跳超时')) {
    fail('登录后即时心跳出现 401/超时告警（打包产物心跳链路异常）')
  }
  console.log(`[login-verify] 心跳静默通过（无 401/超时告警；成功心跳本不落日志）`)

  // 包内置 server.json 地址核验（登录能成功已隐含地址正确；再显式核对文件在位）
  const resServerJson = path.join(path.dirname(execPath), 'resources', 'server.json')
  if (!fs.existsSync(resServerJson)) fail(`包内置 server.json 缺失: ${resServerJson}`)
  console.log(`[login-verify] 包内置 server.json 在位: ${resServerJson}`)

  console.log(`[login-verify] PASS（耗时 ${Date.now() - t0}ms）——打包产物登录红线通过`)
} catch (err) {
  // 失败留现场截图（红线排查用）
  try {
    if (page) {
      const shot = '/tmp/login-verify-fail.png'
      await page.screenshot({ path: shot })
      console.error(`[login-verify] 现场截图: ${shot}`)
    }
  } catch {
    /* 截图失败不覆盖原错误 */
  }
  throw err
} finally {
  try {
    process.kill(app.process().pid, 'SIGKILL')
  } catch {
    /* 已退出 */
  }
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
}
