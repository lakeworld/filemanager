import { Show, createSignal, createEffect } from "solid-js";
import { api } from "~/wails/api";

export default function FileThumbnail(props: { path: string | null; fileType: string; class?: string }) {
  const [url, setUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal(false);

  createEffect(() => {
    const thumbPath = props.path;
    if (!thumbPath) {
      setUrl(null);
      setError(true);
      return;
    }
    setError(false);
    api.files.workspaceUrl(thumbPath).then((result) => {
      if (result.success && result.data) {
        setUrl(result.data);
      } else {
        setError(true);
      }
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
