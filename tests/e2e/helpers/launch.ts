/**
 * e2e app 启动夹具（v2.5.8 A4，台账 D-07 结构收口）：
 * 每个 spec 用自己的文件名作 label，userData/logs 隔离到 tmpdir/qihebox-e2e-<label>/——
 * 消除历史共享目录 qihebox-e2e-userdata 的跨 spec 登录态污染假红（D-07 实录）。
 * 同一 spec 内多次 launch（重启/恢复类用例）天然共享同一 label = 共享同一 userData，
 * 与改造前 spec 内行为一致；跨 spec 从此互不可见。
 * main 侧：src/main/index.ts 读 QIHEBOX_E2E_USERDATA（目录名，非绝对路径）。
 */
import os from 'node:os'
import path from 'node:path'

/** spec label → e2e userData 目录名（tmpdir 下） */
export function e2eUserDataDirName(label: string): string {
  return `qihebox-e2e-${label}`
}

/** spec label → e2e userData 绝对路径（与 main 侧 app.setPath 一致） */
export function e2eUserDataDir(label: string): string {
  return path.join(os.tmpdir(), e2eUserDataDirName(label))
}

/** 组装 electron.launch 的 env：QIHEBOX_E2E=1 + 按 spec 隔离的 userData + 调用方附加项 */
export function e2eLaunchEnv(label: string, extra?: Record<string, string>): Record<string, string | undefined> {
  return {
    ...process.env,
    QIHEBOX_E2E: '1',
    QIHEBOX_E2E_USERDATA: e2eUserDataDirName(label),
    ...extra,
  }
}
