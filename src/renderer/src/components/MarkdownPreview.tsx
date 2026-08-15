import { createSignal, onMount, Show } from "solid-js";
import { api } from "~/wails/api";
import { resolveMdImageUrl } from "../../../shared/mdImages";
import { configureMarked, sanitizeLinkHref } from "../../../shared/mdRender";

/**
 * Markdown 预览（v2.5.1 F4）：
 * - marked 动态 import 懒加载（模块级缓存 Promise，首次预览 md 才加载，不占启动路径，D21）
 * - 禁原生 HTML（configureMarked：转义输出，免 DOMPurify）
 * - 图片：相对路径 → qihebox://file/<base64url>（resolveMdImageUrl，D22）；http(s) 直链
 * - 链接：href 白名单（sanitizeLinkHref，javascript:/data: 拒绝）
 * - 2MB 上限：readTextFile 拒绝超限 → 引导「用系统程序打开」
 * 三态：加载 Skeleton / 错误 EmptyState+重试 / 就绪渲染 .md-prose
 */

let markedReady: Promise<typeof import("marked")> | null = null;
async function loadMarked(): Promise<typeof import("marked")> {
  if (!markedReady) {
    markedReady = import("marked").then((m) => {
      configureMarked(m.marked);
      return m;
    });
  }
  return markedReady;
}

type MdState = "loading" | "ready" | "tooLarge" | "error";

export default function MarkdownPreview(props: { filePath: string }) {
  const [state, setState] = createSignal<MdState>("loading");
  const [html, setHtml] = createSignal("");
  const [errorMsg, setErrorMsg] = createSignal("");

  const load = async () => {
    setState("loading");
    const res = await api.files.readTextFile(props.filePath);
    if (!res.success) {
      // 2MB 上限拒绝 → 引导系统打开（错误信息由 core readTextFile 抛出）
      if ((res.error ?? "").includes("文件过大")) {
        setState("tooLarge");
      } else {
        setErrorMsg(res.error || "读取文件失败");
        setState("error");
      }
      return;
    }
    try {
      const { marked } = await loadMarked();
      const raw = await marked.parse(res.data ?? "");
      // 渲染后 DOM 处理：图片相对路径 → qihebox://；链接白名单（禁 HTML 已由 renderer 保证）
      const div = document.createElement("div");
      div.innerHTML = raw;
      div.querySelectorAll("img").forEach((img) => {
        const src = img.getAttribute("src") ?? "";
        const resolved = resolveMdImageUrl(props.filePath, src);
        if (resolved) img.setAttribute("src", resolved);
        else img.remove();
      });
      div.querySelectorAll("a").forEach((a) => {
        const href = a.getAttribute("href") ?? "";
        const safe = sanitizeLinkHref(href);
        if (safe) a.setAttribute("href", safe);
        else a.removeAttribute("href");
      });
      setHtml(div.innerHTML);
      setState("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "渲染失败");
      setState("error");
    }
  };

  onMount(load);

  return (
    <>
      <Show when={state() === "loading"}>
      <div class="w-full h-full p-6 overflow-y-auto">
        <div class="skeleton h-6 w-1/3 mb-4 rounded" />
        <div class="skeleton h-4 w-full mb-2 rounded" />
        <div class="skeleton h-4 w-5/6 mb-2 rounded" />
        <div class="skeleton h-4 w-2/3 mb-6 rounded" />
        <div class="skeleton h-24 w-full mb-4 rounded" />
      </div>
    </Show>
    <Show when={state() === "tooLarge"}>
      <div class="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
        <div class="text-4xl">📄</div>
        <p class="text-sm text-surface-600">
          文档较大（超过 2MB），内嵌预览已跳过
        </p>
        <button class="btn-primary" onClick={() => void api.files.openWithDefaultApp(props.filePath)}>
          用系统程序打开
        </button>
      </div>
    </Show>
    <Show when={state() === "error"}>
      <div class="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
        <div class="text-4xl">⚠️</div>
        <p class="text-sm text-surface-600">{errorMsg()}</p>
        <div class="flex gap-3">
          <button class="btn-secondary" onClick={() => void api.files.openWithDefaultApp(props.filePath)}>
            用系统程序打开
          </button>
          <button class="btn-primary" onClick={() => void load()}>
            重试
          </button>
        </div>
      </div>
    </Show>
    <Show when={state() === "ready"}>
      <div class="md-prose w-full h-full p-6 overflow-y-auto" innerHTML={html()} />
    </Show>
    </>
  );
}
