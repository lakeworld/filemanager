/**
 * 发票识别测试夹具 · 主进程入口（v2.5.4 Task 4）。
 * 经 scripts/build-hello-plugin.mjs 打包为 .qbox 侧载安装，仅供 box e2e 使用（不进安装包）。
 * 保持「本体不做识别」边界：本体只渲染 global 命令按钮槽 + 白名单回填 + 归档时序；
 * 真正的识别在 com.qihe.cloud 插件内，本夹具以固定字段替代。
 *
 * IPC action `invoice.identifyFile`（与 manifest.commands[0].id 同名）：
 *   成功 → 返回 { fields, sourcePath, warnings }（宿主 ApiResult 包装后渲染层读 r.data）；
 *     sourcePath = 调用参数 args.sourcePath 原样回传，缺省回退到环境变量 QH_IDENTIFY_SOURCE
 *     （e2e 里按钮点击 args={} 时用它注入伪造外部源文件路径，以驱动归档流）。
 *   失败注入 → args.failWithCode（或环境变量 QH_IDENTIFY_FAIL）非空时抛错，
 *     宿主 handle() 转为 { success:false, error:message } 信封（渲染层 toast，表单保持）。
 */
interface IdentifyArgs {
  sourcePath?: string
  failWithCode?: string
}

interface MockHost {
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
}

export async function activate(host: MockHost): Promise<{
  ipc: Record<string, (payload: unknown) => unknown>
  dispose: () => void
}> {
  host.log('info', '[identify-mock] 激活（发票识别测试夹具）')

  return {
    ipc: {
      'invoice.identifyFile': (payload: unknown) => {
        const args = (payload ?? {}) as IdentifyArgs | null | undefined
        const failCode = (args && args.failWithCode) || process.env.QH_IDENTIFY_FAIL
        if (failCode) {
          // 失败注入：抛错 → 宿主 ApiResult 失败信封（渲染层 toast「识别失败」）
          throw new Error(`识别失败（${failCode}）：请手动填写`)
        }
        const sourcePath =
          (args && typeof args.sourcePath === 'string' && args.sourcePath) ||
          process.env.QH_IDENTIFY_SOURCE ||
          ''
        return {
          fields: { number: 'MOCK-2026-001', seller: '样例卖方', amount: 88 },
          sourcePath,
          warnings: ['部分字段未能识别'],
        }
      },
    },
    dispose: () => {
      host.log('info', '[identify-mock] 停用')
    },
  }
}
