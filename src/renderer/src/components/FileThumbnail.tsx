import { Show, createSignal, createEffect, onCleanup } from "solid-js";

/**
 * 文件缩略图：
 * - 图片：先 ensureThumbnail（缺失自动生成，mtime 命中毫秒级返回）→ workspaceUrl → <img>
 * - 非图片 / 生成失败：emoji 占位
 */
export default function FileThumbnail(props: { filePath: string | null; fileType: string; class?: string }) {
  const [url, setUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal(false);

  createEffect(() => {
    const fp = props.filePath;
    if (!fp || props.fileType !== "image") {
      setUrl(null);
      setError(true);
      return;
    }
    setError(false);
    let cancelled = false;

    (window.qihebox.files.ensureThumbnail(fp) as Promise<any>)
      .then((r) => {
        if (cancelled) return null;
        if (r?.success && r.data) {
          return window.qihebox.files.workspaceUrl(r.data) as Promise<any>;
        }
        return null;
      })
      .then((urlRes) => {
        if (cancelled) return;
        if (urlRes?.success && urlRes.data) {
          setUrl(urlRes.data);
        } else {
          setError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    onCleanup(() => {
      cancelled = true;
    });
  });

  return (
    <Show
      when={url() && !error()}
      fallback={
        <span class="text-3xl">
          {props.fileType === "image" ? "🖼️" : props.fileType === "pdf" ? "📄" : props.fileType === "video" ? "🎬" : "📎"}
        </span>
      }
    >
      <img
        src={url()!}
        class={props.class || "w-full h-full object-cover"}
        alt=""
        draggable={false}
        onError={() => setError(true)}
      />
    </Show>
  );
}
