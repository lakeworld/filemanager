/**
 * 系统剪贴板「文件列表」的解析（v2.5.8 D19 / 体验批 B3：Ctrl+V 粘贴导入）。
 *
 * 单独成模块的理由：这一步是**纯字符串 → 路径数组**，是整个粘贴链路里唯一会因
 * 外部程序写法不同而出错的地方（资源管理器、Chrome、微信各自往剪贴板写的形状都不一样），
 * 也是最该被单测钉住的一段。放进 `clipboard.ts` 就得连 `electron` 一起 mock 才能测，
 * 而本文件零依赖 ⇒ `tests/unit/clipboardParse.test.ts` 直接 import。
 *
 * 两种输入格式，对应两个平台的读法（工具链与复制侧 `clipboard.ts` 严格镜像）：
 *  - `text/uri-list`（Linux，xclip / xsel / wl-paste / Electron 回退都读这一种）：
 *    一行一个 `file://` URI，允许 `#` 开头的注释行（RFC 2483），允许 CR；
 *  - Windows PowerShell `Get-Clipboard -Format FileDropList` 的 stdout：
 *    一行一个**明文绝对路径**（不是 URI），且会在末尾多一个换行。
 */

/** 拆行：CR / LF / CRLF 都算分隔，去掉首尾空白，丢掉空行 */
function toLines(raw: string): string[] {
  return raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/** `file://` URI → 绝对路径。解不开、或根本不是 file: 协议（http、sftp…）→ null 交给上层丢弃 */
function fromFileUri(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;
  try {
    const u = new URL(uri);
    if (u.protocol !== "file:") return null;
    // 先剥百分号编码再归一分隔符：中文与空格在 URI 里是 %xx，落到磁盘必须是原字符
    let p = decodeURIComponent(u.pathname);
    // Windows：`file:///C:/x/y.png` 的 pathname 是 `/C:/x/y.png`，开头那个斜杠是 URI 语法不是路径
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    // UNC：`file://server/share` → `\\server\share`
    if (u.hostname && u.hostname !== "localhost") p = `\\\\${u.hostname}${p.replace(/\//g, "\\")}`;
    // 长度 >1 才算一个文件：`file://` / `file:///` 这类残缺 URI 的 pathname 是 "/"，
    // 原样返回等于把「导入整个文件系统根」交给下游——必须当无效丢掉
    return p.length > 1 ? p : null;
  } catch {
    return null;
  }
}

/**
 * 解析 `text/uri-list`。
 * 规则：**只认 file: 条目**，注释行（`#`）与非法 URI 逐条丢弃而非整批失败——
 * 浏览器/IM 往剪贴板同时写 text 与 uri-list 时，掺进来的 `http:` 不该让用户一个文件都粘不上。
 */
export function parseUriList(raw: string): string[] {
  const out: string[] = [];
  for (const line of toLines(raw)) {
    if (line.startsWith("#")) continue; // RFC 2483 注释行
    const p = fromFileUri(line);
    if (p) out.push(p);
  }
  return out;
}

/**
 * 解析 Windows `Get-Clipboard -Format FileDropList` 的输出（一行一个明文绝对路径）。
 * 同时兼容个别程序往 uri-list 里写 file: 的写法——遇到就顺手解码，不让它原样进移动参数。
 */
export function parseFileDropList(raw: string): string[] {
  const out: string[] = [];
  for (const line of toLines(raw)) {
    if (line.startsWith("#")) continue;
    if (line.startsWith("file:")) {
      const p = fromFileUri(line);
      if (p) out.push(p);
      continue;
    }
    // 明文路径：Windows 只接受带盘符或 UNC 的绝对路径，相对路径一律丢弃
    // （粘进来一个相对路径，后面拼接出来的目标位置就靠猜了，宁可不粘）
    if (/^[A-Za-z]:[\\/]/.test(line) || line.startsWith("\\\\")) out.push(line);
  }
  return out;
}

/** 去重且保持原顺序（同一文件在剪贴板里被列两遍时，不该导两遍） */
export function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
