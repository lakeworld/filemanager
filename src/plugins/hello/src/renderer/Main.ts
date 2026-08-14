/**
 * hello 示例插件 · 渲染层页面模块（v2.5，PLAN §七）。
 * 构建约定：本文件由 scripts/build-hello-plugin.mjs 经 esbuild 打包为 renderer/Main.js，
 * 产物自包含（solid-js 打入）；本文件无 JSX（用 h() 构造，脚本检测到 <tag 会报错），组件 = 模块默认导出。
 * 页面经 qihebox://plugin/com.qihe.hello/renderer/Main.js 协议 URL 动态 import（访问才加载）。
 */
import { createSignal } from 'solid-js'
import type { Component } from 'solid-js'
import h from 'solid-js/h'

interface PingResult {
  success: boolean
  data?: { echo?: string; count?: number }
  error?: string | null
}

const Main: Component = () => {
  const [result, setResult] = createSignal('（尚未调用）')
  const [count, setCount] = createSignal(0)

  const callPing = async () => {
    setResult('调用中…')
    try {
      const bridge = (globalThis as { qihebox?: { plugins?: { call: (...a: unknown[]) => Promise<unknown> } } }).qihebox
      const r = (await bridge?.plugins?.call('com.qihe.hello', 'ping', { text: '你好，插件！' })) as
        | PingResult
        | undefined
      if (r?.success && r.data) {
        setResult('回声：' + (r.data.echo ?? ''))
        setCount(r.data.count ?? 0)
      } else {
        setResult('调用失败：' + (r?.error ?? '未知错误'))
      }
    } catch (err) {
      setResult('调用异常：' + String(err))
    }
  }

  const button = h(
    'button',
    {
      style: 'background:#4f46e5;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:13px;cursor:pointer;',
      // h() 事件绑定（2026-08-11 实测）：静态 props 走 assign 路径（事件不挂载）；
      // 用 getter 触发 spread 路径（Solid 标准事件挂载，onClick → click 监听）。见 build-hello-plugin.mjs 头注释
      get onClick() {
        return () => void callPing()
      },
    },
    '调用 ping IPC',
  )
  // 动态子节点必须传函数（h() 对函数子节点按响应式表达式处理）：静态值只在渲染时求值一次，信号变化不更新 DOM
  const resultLine = h('div', { style: 'margin-top:12px;font-size:13px;color:#334155;' }, () => result())
  const countLine = () =>
    count() > 0
      ? h('div', { style: 'margin-top:4px;font-size:12px;color:#94a3b8;' }, () => '累计调用 ' + count() + ' 次')
      : null

  return h(
    'div',
    { style: 'padding:24px;max-width:520px;' },
    [
      h('h1', { style: 'font-size:20px;font-weight:600;margin-bottom:8px;' }, '👋 Hello 示例插件'),
      h(
        'p',
        { style: 'color:#64748b;font-size:13px;line-height:1.6;margin-bottom:16px;' },
        '演示插件协议的三种能力：本页面（pages）、IPC 调用（ping）、文件右键命令（hello.greet）。页面模块经 qihebox://plugin/ 协议加载，依赖自包含于插件包内。',
      ),
      button,
      resultLine,
      countLine,
    ],
  )
}

export default Main
