/**
 * 一致性套件正路径夹具 · 主进程入口（纯 JS，随 build-conformance-fixtures.mjs 打包为 .qbox）。
 * 提供 host API 语义自证 IPC 动作，供 conformance.spec.ts 步骤 e 全量往返断言：
 *   - `conformance.selfTest`：storage set→get / files writeExport→readText / account / notify / entitlement / workspace 全量自证，返回 { ok, checks }
 *   - `conformance.emit`：host.events.emit(channel, data)（渲染层经 window.qihebox.plugins.on 收到，spec 侧断言）
 * 本入口为 CJS（module.exports），宿主经 import() 取 default.activate 握手（见 src/main/plugins/loader.ts）。
 */
const SELF_ID = 'com.qihe.conformance.full'

module.exports = {
  async activate(host) {
    host.log('info', '[conformance-full] 插件激活，宿主 API v' + host.apiVersion)

    return {
      ipc: {
        /** host API 语义自证（步骤 e）：全部能力一次往返，结果结构化返回，spec 逐项断言 */
        'conformance.selfTest': async () => {
          const checks = {}

          // storage：set → get 一致（JSON 深比较）
          try {
            const key = 'conformance.roundtrip'
            const value = { n: 42, s: 'roundtrip', t: Date.now() }
            await host.storage.set(key, value)
            const got = await host.storage.get(key)
            checks.storage = {
              ok: JSON.stringify(got) === JSON.stringify(value),
              value: got,
            }
          } catch (err) {
            checks.storage = { ok: false, error: String(err) }
          }

          // files：writeExport → readText 读回（导出平铺命名 <id>_<fileName>，见 src/main/plugins/host.ts）
          try {
            const fileName = 'conformance-export.txt'
            const content = 'conformance-roundtrip-' + Date.now()
            await host.files.writeExport(fileName, content)
            const readBack = await host.files.readText('导出/' + SELF_ID + '_' + fileName)
            checks.files = { ok: readBack === content, content: readBack }
          } catch (err) {
            checks.files = { ok: false, error: String(err) }
          }

          // account：manifest 声明 permissions.account=true → 接真实 AccountService（e2e 未登录 → token null / isLoggedIn false）
          try {
            checks.account = {
              token: host.account.getToken(),
              isLoggedIn: host.account.isLoggedIn(),
            }
          } catch (err) {
            checks.account = { error: String(err) }
          }

          // notify：返回布尔（true=已发出 / false=环境不支持），语义是「返回布尔」而非「必须 true」
          try {
            const r = host.notify('conformance-full', 'notify 自证')
            checks.notify = { ok: typeof r === 'boolean', returned: r }
          } catch (err) {
            checks.notify = { ok: false, error: String(err) }
          }

          // entitlement：恒 free 占位（红线 4：本体零订阅实现）
          try {
            const st = host.entitlement.status()
            checks.entitlement = { tier: st.tier, expiresAt: st.expiresAt, quota: st.quota }
          } catch (err) {
            checks.entitlement = { error: String(err) }
          }

          // workspace：currentPath 非空（spec 侧前置已创建工作区）
          try {
            checks.workspace = { path: host.workspace.currentPath() }
          } catch (err) {
            checks.workspace = { error: String(err) }
          }

          return { ok: true, checks }
        },

        /** events 自证（步骤 e）：host.events.emit → 渲染层 window.qihebox.plugins.on 收到（spec 侧订阅 + 断言） */
        'conformance.emit': async (payload) => {
          const p = payload || {}
          host.events.emit(String(p.channel), p.data)
          return { ok: true, channel: p.channel }
        },
      },

      commands: {
        'conformance-full.noop': async () => {
          host.log('info', '[conformance-full] 命令 conformance-full.noop 触发')
        },
      },

      dispose: () => {
        host.log('info', '[conformance-full] 插件停用，实例已回收')
      },
    }
  },
}
