import { For, Show, createSignal } from "solid-js";
import type { IndustryTemplate, WorkspaceConfig } from "~/types";
import {
  BUILTIN_TEMPLATES,
  currentTemplateLabel,
  fiveListsOfConfig,
  matchTemplate,
} from "../../../../shared/industryTemplates";
import Input from "~/components/ui/Input";
import ConfirmDialog from "~/components/ConfirmDialog";
import { showToast } from "~/stores/notifyBanner";

/**
 * 行业文件夹模板卡（v2.6.1 B17 · PLAN §三/§五）：模板卡阵列（内置 8 + 我的模板）+ 顶部「当前：×××」徽标。
 *
 * 三条口径（PLAN §五）：
 *  - **点模板 = 只改草稿**（五张清单整体替换进草稿信号，不落盘；要生效按底部「保存设置」）。
 *    所以本组件只派发 `onApply`，自己不动磁盘。
 *  - **徽标派生**：`matchTemplate(config())`——手改任意一张清单就自动变「自定义」；不往 config 存
 *    "当前模板 id"（避免双源）。config 尚未从磁盘加载时不做判定（gate 到 `loaded()`）。
 *  - **自定义模板**：新增（存当前清单）/ 重命名 / 覆盖 / 删除；内置只读——"改内置" = 复制成自定义或直接改清单。
 *    删除与覆盖要过 `ConfirmDialog`（会覆盖用户自己攒的模板）。
 *
 * 视觉：外层玻璃卡（随页内一致），卡阵列用实底描边小块 + 命中项 `.card-selected`（全站选中态单点）。
 */
export default function IndustryTemplateCard(props: {
  /** 当前草稿（Settings 页的 config 信号） */
  config: () => WorkspaceConfig;
  /** 工作区 config 是否已从磁盘加载（加载前不判定模板，防"默认工作区被误报成自定义"） */
  loaded: () => boolean;
  /** 「用这套」：把五张清单整体替换进草稿（不落盘） */
  onApply: (t: IndustryTemplate) => void;
  /** 自定义模板列表变更（改名/新增/覆盖/删除都只改草稿里的 custom_templates） */
  onCustomTemplates: (list: IndustryTemplate[]) => void;
}) {
  const customTemplates = () => props.config().custom_templates ?? [];
  /** 命中态（内置优先于自定义；未加载不判定） */
  const matchedId = () => (props.loaded() ? (matchTemplate(props.config()).template?.id ?? "") : "");
  const currentLabel = () => (props.loaded() ? currentTemplateLabel(props.config()) : "读取中…");

  /** 内联名字编辑：'add' = 新增；'rename:<id>' = 重命名 */
  const [editing, setEditing] = createSignal<null | string>(null);
  const [nameDraft, setNameDraft] = createSignal("");
  /** 待确认：删除 / 覆盖（都要过 ConfirmDialog——会动用户自己攒的模板） */
  const [pending, setPending] = createSignal<{ kind: "delete" | "overwrite"; id: string; name: string } | null>(null);

  /** 从当前草稿的五张清单造一份模板（列序与判定共用 fiveListsOfConfig 单点，不在这另写一遍列序） */
  const fromDraft = (id: string, name: string): IndustryTemplate => {
    const [image_subfolders, cert_subfolders, doc_subfolders, customer_subfolders, supplier_subfolders] =
      fiveListsOfConfig(props.config());
    return {
      id,
      name,
      image_subfolders: [...image_subfolders],
      cert_subfolders: [...cert_subfolders],
      doc_subfolders: [...doc_subfolders],
      customer_subfolders: [...customer_subfolders],
      supplier_subfolders: [...supplier_subfolders],
    };
  };

  const nameTaken = (name: string, exceptId?: string): boolean =>
    [...BUILTIN_TEMPLATES, ...customTemplates()].some((t) => t.id !== exceptId && t.name === name);

  const startAdd = () => {
    setEditing("add");
    setNameDraft("");
  };

  const startRename = (t: IndustryTemplate) => {
    setEditing(`rename:${t.id}`);
    setNameDraft(t.name);
  };

  const cancelEdit = () => {
    setEditing(null);
    setNameDraft("");
  };

  const commitName = () => {
    const now = editing();
    if (now === null) return;
    const name = nameDraft().trim();
    if (!name) {
      showToast("error", "模板名不能为空", "起个名字（如：我们自己的分类）再回车");
      return;
    }
    if (now === "add") {
      if (nameTaken(name)) {
        showToast("error", "模板名已被占用", `已有一套模板叫「${name}」，换个名字`);
        return;
      }
      props.onCustomTemplates([...customTemplates(), fromDraft(`custom:${name}`, name)]);
      showToast("success", `已存为模板「${name}」`, "内容 = 当前五张清单；点底部「保存设置」后随工作区保存");
    } else {
      const id = now.slice("rename:".length);
      const t = customTemplates().find((x) => x.id === id);
      if (t && name !== t.name) {
        if (nameTaken(name, id)) {
          showToast("error", "模板名已被占用", `已有一套模板叫「${name}」，换个名字`);
          return;
        }
        props.onCustomTemplates(
          customTemplates().map((x) => (x.id === id ? { ...x, id: `custom:${name}`, name } : x)),
        );
      }
    }
    cancelEdit();
  };

  const apply = (t: IndustryTemplate) => {
    props.onApply(t);
    showToast("success", `已套用「${t.name}」`, "五张清单已换成这套，点底部「保存设置」才生效");
  };

  /** 确认后执行（Solid props 惰性 getter：先取快照再清 pending，同 Settings 的 DeleteConfirm 先例） */
  const doPending = () => {
    const p = pending();
    if (!p) return;
    const { kind, id, name } = p;
    setPending(null);
    if (kind === "delete") {
      props.onCustomTemplates(customTemplates().filter((x) => x.id !== id));
      showToast("success", `已删除模板「${name}」`, "只删模板，不动任何文件夹；点底部「保存设置」后生效");
    } else {
      props.onCustomTemplates(customTemplates().map((x) => (x.id === id ? fromDraft(id, name) : x)));
      showToast("success", `已用当前清单覆盖「${name}」`, "点底部「保存设置」后生效");
    }
  };

  const TemplateCard = (p: { t: IndustryTemplate; builtin: boolean }) => (
    <div
      class="rounded-lg border border-surface-200 p-3"
      classList={{ "card-selected": matchedId() === p.t.id }}
      data-template={p.t.name}
    >
      <div class="flex items-start justify-between gap-2">
        <span class="text-sm font-medium text-surface-800">{p.t.name}</span>
        <span class={`chip ${p.builtin ? "bg-surface-100 text-surface-500" : "bg-primary-50 text-primary-600"}`}>
          {p.builtin ? "内置" : "我的"}
        </span>
      </div>
      <p class="mt-1 text-[11px] leading-relaxed text-surface-400">
        图包：{p.t.image_subfolders.join(" · ")}
      </p>
      <div class="mt-2 flex items-center gap-3">
        <button class="btn-secondary px-3 py-1.5 text-xs" onClick={() => apply(p.t)}>
          用这套
        </button>
        <Show when={!p.builtin}>
          <button
            class="link-btn text-xs text-surface-500 hover:text-primary-600"
            title="改名不改清单内容"
            onClick={() => startRename(p.t)}
          >
            重命名
          </button>
          <button
            class="link-btn text-xs text-surface-500 hover:text-primary-600"
            title="用当前五张清单覆盖这套模板"
            onClick={() => setPending({ kind: "overwrite", id: p.t.id, name: p.t.name })}
          >
            覆盖
          </button>
          <button
            class="link-btn text-xs text-danger-500 hover:text-danger-600"
            title="只删模板，不动任何文件夹"
            onClick={() => setPending({ kind: "delete", id: p.t.id, name: p.t.name })}
          >
            删除
          </button>
        </Show>
      </div>
    </div>
  );

  return (
    <div class="card card-glass p-6">
      <div class="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h2 class="text-lg font-semibold mb-2">文件夹模板</h2>
          <p class="text-sm text-surface-500">
            点「用这套」= 把下面五张清单整体换成这一套（只改草稿，点底部「保存设置」才生效；只影响以后新建实体，
            存量文件夹不动）。手改任意一张清单后，「当前」会自动变成「自定义」。
          </p>
        </div>
        <span class="chip bg-primary-50 text-primary-600 px-3 py-1 text-sm">当前：{currentLabel()}</span>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <For each={BUILTIN_TEMPLATES}>{(t) => <TemplateCard t={t} builtin />}</For>
        <For each={customTemplates()}>{(t) => <TemplateCard t={t} builtin={false} />}</For>
      </div>

      {/* 新增模板（存当前清单）；重命名复用同一条内联输入 */}
      <div class="mt-4 flex items-center gap-2 flex-wrap">
        <Show
          when={editing() !== null}
          fallback={
            <button class="link-btn text-sm text-primary-600 hover:text-primary-700" onClick={startAdd}>
              ＋ 新增模板（存当前清单）
            </button>
          }
        >
          <Input
            compact
            autoFocus
            class="w-48"
            ariaLabel="模板名称"
            value={nameDraft()}
            onInput={(e) => setNameDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") cancelEdit();
            }}
          />
          <button class="icon-btn text-primary-600 hover:text-primary-700 text-xs" title="确定" onClick={commitName}>
            ✓
          </button>
          <button class="icon-btn text-surface-400 hover:text-surface-600 text-xs" title="取消" onClick={cancelEdit}>
            ✕
          </button>
          <span class="text-xs text-surface-400">
            {editing() === "add" ? "把当前五张清单存成一个模板" : "改名不改变清单内容"}
          </span>
        </Show>
      </div>

      <Show when={pending()}>
        <ConfirmDialog
          title={pending()!.kind === "delete" ? "删除模板" : "覆盖模板"}
          message={
            pending()!.kind === "delete"
              ? `确定删除模板「${pending()!.name}」吗？只删这份模板，不动任何文件夹。`
              : `确定用当前五张清单覆盖模板「${pending()!.name}」吗？这套模板原来的内容会被替换。`
          }
          confirmLabel={pending()!.kind === "delete" ? "删除" : "覆盖"}
          danger={pending()!.kind === "delete"}
          onConfirm={doPending}
          onCancel={() => setPending(null)}
        />
      </Show>
    </div>
  );
}