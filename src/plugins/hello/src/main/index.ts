/**
 * hello 示例插件 · 主进程入口（v2.5，PLAN §七）。
 * 经 scripts/build-hello-plugin.mjs 打包为 .qbox（main/index.js）侧载安装。
 * 演示三种能力：ipc（ping 回显）/ pages（见 renderer/Main.ts）/ commands（hello.greet）。
 * 源码为本体公开仓库教学样板；构建产物不进安装包（默认未安装）。
 */
import type { PluginHost, PluginRegistration } from '../../../types'

export async function activate(host: PluginHost): Promise<PluginRegistration> {
  host.log('info', '[hello] 插件激活，宿主 API v' + host.apiVersion)

  const pings: string[] = []

  return {
    /** IPC 回显：plugins.call('com.qihe.hello', 'ping', { text }) → { echo, count, apiVersion } */
    ipc: {
      ping: async (payload: unknown) => {
        const text = ((payload as { text?: string } | null)?.text ?? 'pong').slice(0, 200)
        pings.push(text)
        return { echo: text, count: pings.length, apiVersion: host.apiVersion }
      },
    },

    /** 文件右键命令：注册在 commands（触发经 plugins.call(id, commandId, { filePaths }) 回退路由，见 loader.call） */
    commands: {
      'hello.greet': async (ctx) => {
        host.log('info', `[hello] 命令 hello.greet 触发，选中文件数 = ${ctx.filePaths.length}`)
      },
    },

    /** 停用清理（禁用/卸载时宿主调用；模块代码常驻为已知代价，重启完全释放） */
    dispose: () => {
      pings.length = 0
      host.log('info', '[hello] 插件停用，实例已回收')
    },
  }
}
