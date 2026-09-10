/**
 * e2e app 启动夹具（v2.5.8 A4，台账 D-07 结构收口）：
 * 每个 spec 用自己的文件名作 label，userData/logs 隔离到 tmpdir/qihebox-e2e-<label>/——
 * 消除历史共享目录 qihebox-e2e-userdata 的跨 spec 登录态污染假红（D-07 实录）。
 * 同一 spec 内多次 launch（重启/恢复类用例）天然共享同一 label = 共享同一 userData，
 * 与改造前 spec 内行为一致；跨 spec 从此互不可见。
 * main 侧：src/main/index.ts 读 QIHEBOX_E2E_USERDATA（目录名，非绝对路径）。
 * spec 侧组装方式：`env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName(label) }`
 * （v2.5.8 D1-D3 审核：不设 e2eLaunchEnv 统一入口——各 spec 常需附加自有变量
 * （QIHEBOX_AUTOSTART/XDG_CONFIG_HOME 等），显式展开更直白，避免为传参而传参。）
 */
/**
 * e2e userData 目录名前缀（tmpdir 下）。唯一真相源：
 * 组装（e2eUserDataDirName）与收尾（tmpTeardown）都从这里取，避免手抄清单腐烂。
 * 历史共享目录 qihebox-e2e-userdata（src/main/index.ts 的回退名）同样以此前缀开头，一并被收尾覆盖。
 */
export const E2E_USERDATA_PREFIX = 'qihebox-e2e-'

/** spec label → e2e userData 目录名（tmpdir 下） */
export function e2eUserDataDirName(label: string): string {
  return `${E2E_USERDATA_PREFIX}${label}`
}
