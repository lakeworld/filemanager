/**
 * 泄漏门禁的例外清单（scripts/check-no-secrets.mjs 使用）：
 * 每条必须写明**为什么不是泄漏**——无理由的例外等于把门禁拆了。
 */

/** 提交/标签身份允许清单（正则）。新增开发者请用对外身份或 GitHub noreply 邮箱 */
export const ALLOWED_IDENTITIES = [
  /^ai_qihe@vip\.qq\.com$/, // 对外声明身份（package.json author / README / PRIVACY 同一邮箱）
  /^ci-bot@qihe\.local$/, // 自动巡更提交（占位域名，非真实账号）
  /[A-Za-z0-9._+-]+@users\.noreply\.github\.com$/, // GitHub 隐私邮箱
  /^noreply@github\.com$/, // GitHub 网页 squash/merge
]

/** 软规则（凭据赋值 / URL 内嵌密码）跳过、但硬规则仍然生效的文件 */
export const IGNORE_PATHS = [
  /^package-lock\.json$/, // npm 锁文件：integrity 是 sha512 摘要、registry URL 是镜像站，均非凭据
  /^src\/renderer\/src\/assets\/fonts\//, // 字体子集二进制
  /(^|\/)[\w.-]+\.(woff2?|ttf|otf|png|jpg|jpeg|gif|ico|webp|pdf|qbox|AppImage|deb|zip|gz|7z)$/i,
]

/** 一旦跟踪即违规的路径：真实服务地址只准住本地（.gitignore:6），打包时经 extraResources 注入 */
export const SERVER_CONFIG_PATHS = ['build/server.json', 'config/server.json', 'server.json']

/**
 * 精确例外：{ file, rule, reason }
 * file 为字符串时按「扫描位置前缀」匹配（`路径` 或 `路径:行`），为 RegExp 时整体测位置；
 * rule 为字符串精确匹配规则名，为 RegExp 时测规则名（用于一处豁免多规则）。
 */
export const ALLOW = [
  {
    file: 'tests/unit/moneyInput.test.ts',
    rule: 'ip-address',
    reason: '金额格式化的非法输入样本（四段点分数字），与网络地址无关',
  },
  {
    // 门禁自己的反向实验必须常驻伪造样本（AGENTS.md §一.8：新增断言先做反向实验）。
    // 样本值全部是经典占位号/张三这类假名，且个人邮箱用运行时 join 拼出——所以
    // personal-email 与 commit-identity 两条规则在本文件里**照常生效**，不豁免；
    // 豁免的只是「形状必然撞规则」的五条（含真实用户名形态的 /home/zhangsan/ 夹具）。
    file: 'tests/unit/leakCheck.test.ts',
    rule: /^(sync-dir|local-path|private-key|credential-assign|url-with-credentials|ip-address)$/,
    reason: '泄漏门禁的反向实验样本（值全为伪造，不指向任何真实凭据/主机）',
  },
  {
    // 2026-09-12 隐私清洗的历史残留：这 4 个文件已在 1ea6ef6 迁出公开树（插件宿主测试搬到
    // qihe-plugins 私有仓），只有旧 blob 里还留着网盘目录名；当前 tip 零残留。
    // 用户名级路径（local-path）在历史里已随重写清零，故这里只豁免 sync-dir。
    file: /^(docs\/SUBSCRIPTION\.md|tests\/e2e\/zz-(cross-plugin|lan-home|pwa-launch-home)\.spec\.ts):/,
    rule: 'sync-dir',
    reason: '已迁出公开树的死路径，仅存历史 blob（见 commit 1ea6ef6）',
  },
  {
    // 门禁源码必然把「被拦模式」本身写进去（正则不写出来就没法审计）。
    // 这里豁免的是形状类规则；被拦的具体私人标识值一个都没写——个人邮箱用「域名族 + 公开
    // 联系邮箱白名单」泛化、本机路径用「用户名不像编造的」泛化，正是为了让本文件可以公开。
    file: /^scripts\/(check-no-secrets|leak-allowlist)\.mjs:/,
    rule: /^(sync-dir|local-path|personal-email|ip-address|private-key)$/,
    reason: '门禁源码的自指（写的是模式，不是值）',
  },
  {
    // 公开历史 blob 里的第三方署名：v1.x Wails 期由框架生成的 package.json 作者字段，
    // 不是启禾任何人的地址；该路径在 v1.3 换栈后已不存在于 tip，仅存历史。
    file: /^frontend\/src\/wailsjs\/runtime\/package\.json:/,
    rule: 'personal-email',
    reason: '第三方框架生成物的作者署名，仅存历史 blob（tip 无此路径）',
  },
]
