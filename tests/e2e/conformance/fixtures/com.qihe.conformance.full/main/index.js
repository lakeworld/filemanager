/**
 * 一致性套件正路径夹具 · 主进程入口（纯 JS，随 build-conformance-fixtures.mjs 打包为 .qbox）。
 * 提供 host API 语义自证 IPC 动作，供 conformance.spec.ts 步骤 e 全量往返断言：
 *   - `conformance.selfTest`：storage set→get / files writeExport→readText / account / notify / entitlement / workspace 全量自证，返回 { ok, checks }
 *   - `conformance.emit`：host.events.emit(channel, data)（渲染层经 window.qihebox.plugins.on 收到，spec 侧断言）
 *
 * v2.6.1（B8）：selfTest 增 `checks.dialog`——host.dialog.openFiles 真装配链四态（多选 / 取消 /
 * >200 截断 / 失败分类）原样回报读数，判据住 spec 侧（宿主上限 200 是 PLUGIN.md 公开承诺，
 * 夹具不抄第二份数字）。**四态靠 title 哨兵区分**，spec 在 app 侧把 dialog.showOpenDialog
 * 换成按哨兵应答的假实现（原生文件框在 e2e 里点不动）：
 *   '__conformance_multi__'  → 2 条路径      '__conformance_cancel__' → canceled
 *   '__conformance_cap__'    → 250 条路径     '__conformance_fail__'   → 抛错
 * 旧宿主（无 openFiles）→ checks.dialog = { ok:false, reason:'no-openFiles' }，spec 记跳过不假绿。
 *
 * v2.6.1（B14）：selfTest 增 `checks.images`——host.images.transform 真装配链两态：
 * 正路径 = 写一张内嵌小 PNG（4×4，sharp 现造 96 B）到导出目录 → 以 maxWidth/maxHeight 2 变换，
 * 回报 宽高/字节/格式/魔数（判据住 spec 侧：宿主最大值/尺寸不抄第二份）；负路径 = 不存在的源
 * → 回报错误码（应为 IMAGES_READ_FAILED）。旧宿主（无 images）→ { ok:false, reason:'no-images' }，
 * spec 记跳过不假绿。
 *
 * 本入口为 CJS（module.exports），宿主经 import() 取 default.activate 握手（见 src/main/plugins/loader.ts）。
 */
const SELF_ID = 'com.qihe.conformance.full'

/** 4×4 纯色 PNG（96 B，sharp 现造）：images 正路径的源——内嵌避免夹具依赖 Node 图像库 */
const IMAGES_SRC_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHxkzkC4AAGt4IfFcjJB6AAAAAElFTkSuQmCC'

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

          // dialog（v2.6.1 B8）：openFiles 真装配链四态，原样回报读数（判据住 spec 侧）
          try {
            if (typeof host.dialog.openFiles !== 'function') {
              checks.dialog = { ok: false, reason: 'no-openFiles' }   // 旧宿主形态：spec 记跳过
            } else {
              const pick = async (title) => {
                try {
                  const files = await host.dialog.openFiles({ title })
                  return { ok: true, len: files.length, first: files[0] || '', last: files[files.length - 1] || '' }
                } catch (e) {
                  return { ok: false, code: e && e.code, message: e && e.message }
                }
              }
              checks.dialog = {
                ok: true,
                multi: await pick('__conformance_multi__'),
                cancel: await pick('__conformance_cancel__'),
                cap: await pick('__conformance_cap__'),
                fail: await pick('__conformance_fail__'),
              }
            }
          } catch (err) {
            checks.dialog = { ok: false, reason: 'throw', error: String(err) }
          }

          // images（v2.6.1 B14）：宿主内置图像引擎口两态，原样回报读数（判据住 spec 侧）
          try {
            if (!host.images || typeof host.images.transform !== 'function') {
              checks.images = { ok: false, reason: 'no-images' }   // 旧宿主形态：spec 记跳过
            } else {
              // 正路径：小 PNG 写进导出目录（写导出物是既有白名单能力），再按绝对路径经 images 变换
              const srcName = 'conformance-images-src.png'
              await host.files.writeExport(srcName, Buffer.from(IMAGES_SRC_PNG_B64, 'base64'))
              const ws = String(host.workspace.currentPath() || '').replace(/\/+$/, '')
              const source = ws + '/导出/' + SELF_ID + '_' + srcName
              const out = await host.images.transform({ source: source, maxWidth: 2, maxHeight: 2 })
              const missing = await host.images.transform({ source: source + '.missing.png' }).then(
                () => ({ ok: true }),
                (e) => ({ ok: false, code: e && e.code, message: e && e.message }),
              )
              checks.images = {
                ok: true,
                out: {
                  width: out.width,
                  height: out.height,
                  bytes: out.bytes,
                  format: out.format,
                  magic: Buffer.from(out.data.slice(0, 4)).toString('hex'),
                },
                missing,
              }
            }
          } catch (err) {
            checks.images = { ok: false, reason: 'throw', error: String(err) }
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
