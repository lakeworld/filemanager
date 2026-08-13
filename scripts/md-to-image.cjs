// md-to-image.cjs — 把 Markdown 渲染成图片（PNG）
// 用法：electron scripts/md-to-image.cjs <input.md> <output.png> [width=900]
// 原理：md → HTML（内联样式）→ 无头 BrowserWindow 加载 → capturePage 全页截图
// 不依赖第三方 md 库：内置轻量转换（标题/列表/粗体/代码/引用/分隔线/链接）
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ---------- md → html（轻量，够用即可） ----------
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code class="c">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
}
function mdToHtml(md) {
  const lines = md.split('\n')
  let html = ''
  let ul = false
  let ol = false
  const close = () => {
    if (ul) { html += '</ul>'; ul = false }
    if (ol) { html += '</ol>'; ol = false }
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^### /.test(line)) { close(); html += `<h3>${esc(line.slice(4))}</h3>` }
    else if (/^## /.test(line)) { close(); html += `<h2>${esc(line.slice(3))}</h2>` }
    else if (/^# /.test(line)) { close(); html += `<h1>${esc(line.slice(2))}</h1>` }
    else if (/^> /.test(line)) { close(); html += `<blockquote>${inline(line.slice(2))}</blockquote>` }
    else if (/^---+\s*$/.test(line)) { close(); html += '<hr/>' }
    else if (/^```/.test(line)) { close(); continue } // 忽略代码块围栏（教程无代码块需求）
    else if (/^- /.test(line) || /^\* /.test(line)) {
      if (ol) { html += '</ol>'; ol = false }
      if (!ul) { html += '<ul>'; ul = true }
      html += `<li>${inline(line.replace(/^[-*] /, ''))}</li>`
    } else {
      const m = line.match(/^(\d+)\.\s+(.*)$/)
      if (m) {
        if (ul) { html += '</ul>'; ul = false }
        if (!ol) { html += '<ol>'; ol = true }
        html += `<li>${inline(m[2])}</li>`
      } else if (line === '') { close(); html += '<div class="sp"></div>' }
      else { close(); html += `<p>${inline(line)}</p>` }
    }
  }
  close()
  return html
}

const STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Noto Sans CJK SC", "WenQuanYi Micro Hei", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #ffffff; color: #1f2937; padding: 48px 56px; line-height: 1.75; font-size: 17px;
  }
  h1 { font-size: 26px; font-weight: 700; margin-bottom: 18px; color: #0f172a; }
  h2 { font-size: 21px; font-weight: 700; margin: 28px 0 12px; padding-bottom: 8px; border-bottom: 2px solid #e2e8f0; color: #0f172a; }
  h3 { font-size: 18px; font-weight: 600; margin: 20px 0 10px; color: #0f172a; }
  p { margin: 8px 0; }
  ul, ol { margin: 8px 0 8px 24px; }
  li { margin: 4px 0; }
  strong { font-weight: 700; color: #0f172a; }
  code.c { background: #f1f5f9; border-radius: 4px; padding: 2px 6px; font-family: "JetBrains Mono", "Fira Code", Consolas, monospace; font-size: 15px; color: #b91c1c; }
  pre { display: none; } /* 简化：不渲染代码块（教程无此需求） */
  blockquote { border-left: 4px solid #60a5fa; background: #eff6ff; padding: 10px 14px; border-radius: 0 8px 8px 0; margin: 10px 0; color: #334155; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 22px 0; }
  a { color: #2563eb; text-decoration: none; }
  .sp { height: 10px; }
  .note { color: #64748b; font-size: 14px; margin-top: 24px; padding-top: 12px; border-top: 1px dashed #cbd5e1; }
`

function buildHtml(md, width) {
  const html = mdToHtml(md)
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${STYLE}</style></head>
<body style="width:${width}px">${html}</body></html>`
}

// ---------- Electron 截图 ----------
app.whenReady().then(async () => {
  // 注意：process.argv = [electron, ...flags, script, input, output, width]
  // 用户参数在 script 路径之后，跳过 flags 和 script 本身
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--')).slice(1)
  const input = args[0]
  const output = args[1]
  const widthArg = args[2]
  if (!input || !output) {
    console.error('用法: electron scripts/md-to-image.cjs <input.md> <output.png> [width=900]')
    process.exit(1)
  }
  const width = parseInt(widthArg || '900', 10)
  const md = fs.readFileSync(input, 'utf8')
  const tmpHtml = path.join(os.tmpdir(), `md-to-image-${Date.now()}.html`)
  fs.writeFileSync(tmpHtml, buildHtml(md, width), 'utf8')
  try {
    const win = new BrowserWindow({ width, height: 800, show: false, backgroundColor: '#ffffff' })
    await win.loadFile(tmpHtml)
    // 等字体/渲染稳定（Noto CJK 首次加载可能稍慢）
    await new Promise((r) => setTimeout(r, 600))
    // 读取全页高度，调整窗口后截图
    const height = await win.webContents.executeJavaScript('document.body.scrollHeight + 80')
    win.setContentSize(width, height)
    await new Promise((r) => setTimeout(r, 200))
    const image = await win.webContents.capturePage()
    fs.writeFileSync(output, image.toPNG())
    console.log(`OK: ${output} (${width}x${height})`)
    app.exit(0)
  } catch (e) {
    console.error('FAIL:', e)
    process.exit(1)
  } finally {
    try { fs.unlinkSync(tmpHtml) } catch {}
  }
})
