import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import {
  currentWorkspace,
  workspaceConfig,
  loadWorkspaceConfig,
  updateWorkspaceConfig,
  defaultWorkspaceConfig,
} from "~/stores/workspace";
import { api } from "~/wails/api";
import { loadTagDefs, refreshTags } from "~/stores/tags";
import { showToast } from "~/stores/notifyBanner";
import ConfirmDialog from "~/components/ConfirmDialog";
import type { ApiResult, NamingField, TagInfo, WorkspaceConfig } from "~/types";
import { BUILTIN_NOTES_FOLDER } from "~/constants/notes";

/** 预设色板（标签颜色选择） */
const PALETTE = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#22c55e",
  "#14b8a6", "#0ea5e9", "#3b82f6", "#8b5cf6", "#ec4899",
  "#64748b",
];

export default function Settings() {
  const [config, setConfig] = createSignal<WorkspaceConfig>(defaultWorkspaceConfig());
  const [newImageFolder, setNewImageFolder] = createSignal("");
  const [newCertFolder, setNewCertFolder] = createSignal("");
  // v2.4.7：客户子文件夹管理（对齐 image/cert 段；旧 config 无字段时缺省为空数组，loadConfig 后端兜底默认值）
  const [newCustomerFolder, setNewCustomerFolder] = createSignal("");
  // v2.5.3（P2-19）：文档子文件夹管理（config.doc_subfolders，v2.5.1 起 core/files 已支持 doc scope，UI 补齐）
  const [newDocFolder, setNewDocFolder] = createSignal("");
  // v2.5.5：供应商子文件夹管理（config.supplier_subfolders，对齐客户；原固定集决策废止）
  const [newSupplierFolder, setNewSupplierFolder] = createSignal("");
  const [saved, setSaved] = createSignal(false);

  // —— v2.4.9（S4）：开机自启（应用级设置，不依赖工作区；门控内与既有 card 结构一致）——
  const [autoLaunch, setAutoLaunchState] = createSignal(false);
  const loadAutoLaunch = async () => {
    const r = await api.app.isAutoLaunch();
    if (r.success && r.data) setAutoLaunchState(r.data);
  };
  const toggleAutoLaunch = async (checked: boolean) => {
    const r = await api.app.setAutoLaunch(checked);
    if (!r.success) {
      setAutoLaunchState(!checked); // 失败回滚，避免 UI 与真实状态漂移
      showToast("error", "设置失败", r.error || "开机自启设置失败，请重试");
      return;
    }
    setAutoLaunchState(checked);
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadWorkspaceConfig();
    }
  });

  createEffect(() => {
    const c = workspaceConfig();
    if (c) {
      setConfig(c);
    }
  });

  // v2.5.2（PERF-SOP §四）：保存成功提示定时器句柄化 + 卸载清理（照 FileBrowserView 先例）
  let savedTimer: number | undefined;
  onCleanup(() => window.clearTimeout(savedTimer));
  const handleSave = async () => {
    const success = await updateWorkspaceConfig(config());
    if (success) {
      setSaved(true);
      window.clearTimeout(savedTimer);
      savedTimer = window.setTimeout(() => setSaved(false), 2000);
    } else {
      showToast("error", "保存失败", "设置未能保存到工作区，请重试");
    }
  };

  const addImageFolder = () => {
    const name = newImageFolder().trim();
    if (!name) return;
    if (config().image_subfolders.includes(name)) {
      showToast("error", "添加失败", `子文件夹「${name}」已存在`);
      return;
    }
    setConfig((prev) => ({
      ...prev,
      image_subfolders: [...prev.image_subfolders, name],
    }));
    setNewImageFolder("");
  };

  const removeImageFolder = (index: number) => {
    setConfig((prev) => ({
      ...prev,
      image_subfolders: prev.image_subfolders.filter((_, i) => i !== index),
    }));
  };

  const addCertFolder = () => {
    const name = newCertFolder().trim();
    if (!name) return;
    if (config().cert_subfolders.includes(name)) {
      showToast("error", "添加失败", `子文件夹「${name}」已存在`);
      return;
    }
    setConfig((prev) => ({
      ...prev,
      cert_subfolders: [...prev.cert_subfolders, name],
    }));
    setNewCertFolder("");
  };

  const removeCertFolder = (index: number) => {
    setConfig((prev) => ({
      ...prev,
      cert_subfolders: prev.cert_subfolders.filter((_, i) => i !== index),
    }));
  };

  // v2.4.7：客户子文件夹（config.customer_subfolders）
  const addCustomerFolder = () => {
    const name = newCustomerFolder().trim();
    if (!name) return;
    // v2.5.7（A2 笔记）：内建名不可入 config（core createSubfolder 幂等语义 + 这里防误录）
    if (name === BUILTIN_NOTES_FOLDER) {
      showToast("error", "添加失败", `「${BUILTIN_NOTES_FOLDER}」为内建子文件夹，无需添加`);
      return;
    }
    if ((config().customer_subfolders ?? []).includes(name)) {
      showToast("error", "添加失败", `子文件夹「${name}」已存在`);
      return;
    }
    setConfig((prev) => ({
      ...prev,
      customer_subfolders: [...(prev.customer_subfolders ?? []), name],
    }));
    setNewCustomerFolder("");
  };

  const removeCustomerFolder = (index: number) => {
    setConfig((prev) => ({
      ...prev,
      customer_subfolders: (prev.customer_subfolders ?? []).filter((_, i) => i !== index),
    }));
  };

  // v2.5.3（P2-19）：文档子文件夹（config.doc_subfolders；照 customer 先例）
  const addDocFolder = () => {
    const name = newDocFolder().trim();
    if (!name) return;
    // v2.5.7（A2 笔记）：内建名不可入 config
    if (name === BUILTIN_NOTES_FOLDER) {
      showToast("error", "添加失败", `「${BUILTIN_NOTES_FOLDER}」为内建子文件夹，无需添加`);
      return;
    }
    if ((config().doc_subfolders ?? []).includes(name)) {
      showToast("error", "添加失败", `子文件夹「${name}」已存在`);
      return;
    }
    setConfig((prev) => ({
      ...prev,
      doc_subfolders: [...(prev.doc_subfolders ?? []), name],
    }));
    setNewDocFolder("");
  };

  const removeDocFolder = (index: number) => {
    setConfig((prev) => ({
      ...prev,
      doc_subfolders: (prev.doc_subfolders ?? []).filter((_, i) => i !== index),
    }));
  };

  // v2.5.5：供应商子文件夹（config.supplier_subfolders；照 customer 先例）
  const addSupplierFolder = () => {
    const name = newSupplierFolder().trim();
    if (!name) return;
    // v2.5.7（A2 笔记）：内建名不可入 config
    if (name === BUILTIN_NOTES_FOLDER) {
      showToast("error", "添加失败", `「${BUILTIN_NOTES_FOLDER}」为内建子文件夹，无需添加`);
      return;
    }
    if ((config().supplier_subfolders ?? []).includes(name)) {
      showToast("error", "添加失败", `子文件夹「${name}」已存在`);
      return;
    }
    setConfig((prev) => ({
      ...prev,
      supplier_subfolders: [...(prev.supplier_subfolders ?? []), name],
    }));
    setNewSupplierFolder("");
  };

  const removeSupplierFolder = (index: number) => {
    setConfig((prev) => ({
      ...prev,
      supplier_subfolders: (prev.supplier_subfolders ?? []).filter((_, i) => i !== index),
    }));
  };

  // —— v2.2.1：子文件夹重命名（立即生效并同步迁移所有已有产品集）；v2.5.3（P2-19）补 doc 域；v2.5.5 补 supplier 域 ——
  const [renamingFolder, setRenamingFolder] = createSignal<{ type: "image" | "cert" | "customer" | "supplier" | "doc"; oldName: string } | null>(null);
  const [subfolderRenameValue, setSubfolderRenameValue] = createSignal("");
  const [renameError, setRenameError] = createSignal("");

  const startRename = (type: "image" | "cert" | "customer" | "supplier" | "doc", oldName: string) => {
    setRenamingFolder({ type, oldName });
    setSubfolderRenameValue(oldName);
    setRenameError("");
  };

  const cancelRename = () => {
    setRenamingFolder(null);
    setSubfolderRenameValue("");
    setRenameError("");
  };

  const confirmRename = async () => {
    const target = renamingFolder();
    if (!target) return;
    const newName = subfolderRenameValue().trim();
    if (!newName) {
      setRenameError("名称不能为空");
      return;
    }
    const r = await api.workspace.renameSubfolder(target.type, target.oldName, newName);
    if (r.success && r.data) {
      setConfig(r.data);
      await loadWorkspaceConfig();
      cancelRename();
    } else {
      setRenameError(r.error || "重命名失败");
    }
  };

  /** 子文件夹 chip（图包/证书/客户/供应商/文档通用）：名称 + ✎重命名 + ✕删除；重命名中变输入框。
   *  v2.5.7（A2 笔记）：内建「笔记」不可改/不可删——builtin=true 时隐藏操作按钮并显示徽标。 */
  const SubfolderChip = (props: {
    name: string;
    type: "image" | "cert" | "customer" | "supplier" | "doc";
    onRemove: (index: number) => void;
    index: number;
    builtin?: boolean;
  }) => {
    const isRenaming = () => renamingFolder()?.type === props.type && renamingFolder()?.oldName === props.name;
    return (
      <Show
        when={!isRenaming()}
        fallback={
          <span class="inline-flex items-center gap-1 px-3 py-1.5 bg-surface-100 rounded-lg text-sm">
            <input
              class="w-32 px-1.5 py-0.5 border border-primary-300 rounded text-sm focus:outline-none"
              value={subfolderRenameValue()}
              autofocus
              onInput={(e) => setSubfolderRenameValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmRename();
                if (e.key === "Escape") cancelRename();
              }}
            />
            <button class="text-primary-600 hover:text-primary-700 text-xs" onClick={() => void confirmRename()}>✓</button>
            <button class="text-surface-400 hover:text-surface-600 text-xs" onClick={cancelRename}>✕</button>
          </span>
        }
      >
        <span class="inline-flex items-center gap-1 px-3 py-1.5 bg-surface-100 rounded-lg text-sm">
          <span>{props.name}</span>
          {props.builtin ? (
            <span class="text-[10px] px-1 py-0.5 rounded bg-primary-50 text-primary-600 font-medium" title="内建「笔记」子文件夹：不可重命名/删除">
              内建
            </span>
          ) : (
            <>
              <button class="text-surface-400 hover:text-primary-600 ml-0.5" title="重命名（同步所有产品集）" onClick={() => startRename(props.type, props.name)}>
                ✎
              </button>
              <button class="text-surface-400 hover:text-danger-500 ml-0.5" onClick={() => props.onRemove(props.index)}>
                ✕
              </button>
            </>
          )}
        </span>
      </Show>
    );
  };

  const updateNamingField = (field: keyof WorkspaceConfig["naming_template"], value: string) => {
    setConfig((prev) => ({
      ...prev,
      naming_template: {
        ...prev.naming_template,
        [field]: value,
      },
    }));
  };

  // —— v2.4.9 S5：命名模板字段勾选（sku_fields 增删；旧 config 显式 3 字段原样保留——勾选「编号」才启用 sequence 槽位）——
  const NAMING_FIELD_OPTIONS: { key: NamingField; label: string }[] = [
    { key: "product_set", label: "产品集名" },
    { key: "sub_folder", label: "子文件夹" },
    { key: "original_name", label: "原文件名" },
    { key: "sequence", label: "编号" },
  ];
  const toggleSkuField = (key: NamingField) => {
    setConfig((prev) => {
      const fields = prev.naming_template.sku_fields;
      const next = fields.includes(key) ? fields.filter((f) => f !== key) : [...fields, key];
      return { ...prev, naming_template: { ...prev.naming_template, sku_fields: next } };
    });
  };

  // —— 标签管理 ——
  const [tags, setTags] = createSignal<TagInfo[]>([]);
  const [newTagName, setNewTagName] = createSignal("");
  const [newTagColor, setNewTagColor] = createSignal(PALETTE[0]);
  const [newTagParent, setNewTagParent] = createSignal<string | null>(null);
  // v2.5.7（A3）：新建标签业务域（缺省 general = 全域）
  const [newTagScope, setNewTagScope] = createSignal<string>("general");
  const [editingColor, setEditingColor] = createSignal<string | null>(null); // 正在改色的标签
  const [renaming, setRenaming] = createSignal<string | null>(null); // 正在重命名的标签
  const [renameValue, setRenameValue] = createSignal("");
  const [movingTag, setMovingTag] = createSignal<string | null>(null); // 顶层标签「移至…」展开的标签
  const [confirmDelete, setConfirmDelete] = createSignal<{ name: string; orphan: boolean } | null>(null); // 删除/清引用确认弹窗
  // v2.4.7（F8）：标签树折叠——有子标签的顶层标签默认收起，点箭头展开；新建/移入子标签后自动展开
  const [expandedTopTags, setExpandedTopTags] = createSignal<string[]>([]);
  // v2.5.7（A3）：正在改域的标签（内联 select）
  const [scopeEditing, setScopeEditing] = createSignal<string | null>(null);

  // v2.5.7（A3）：域中文显示 + 分组顺序（域列/分组用；general = 全域）
  // 2026-08-30 用户拍板：ledger 拆分 → invoice（发票）/ quote（报价）
  const SCOPE_LABEL: Record<string, string> = {
    general: "全域",
    file: "文件",
    product_set: "产品集",
    client: "客户",
    supplier: "供应商",
    invoice: "发票",
    quote: "报价",
  };
  /** 域下拉选项（新建/编辑共用，与 SCOPE_LABEL 同源，避免三处漂移） */
  const SCOPE_OPTIONS: { value: string; label: string }[] = ["general", "file", "product_set", "client", "supplier", "invoice", "quote"].map(
    (v) => ({ value: v, label: SCOPE_LABEL[v] }),
  );

  const handleSetScope = async (name: string, scope: string) => {
    const r = await api.tags.setScope(name, scope === "general" ? undefined : scope);
    setScopeEditing(null);
    if (!r.success) showToast("error", "修改域失败", r.error || "未知错误");
    await loadTags();
    refreshTags();
  };

  /** v2.5.7（A3）：按域分组渲染序列——general 在前，其余按固定顺序 */
  const tagGroups = () => {
    const order = ["general", "file", "product_set", "client", "supplier", "invoice", "quote"];
    const groups: { scope: string; label: string; tags: TagInfo[] }[] = [];
    for (const scope of order) {
      const list = tags().filter((t) => !t.parent && (t.scope ?? "general") === scope);
      if (list.length > 0) groups.push({ scope, label: SCOPE_LABEL[scope] ?? scope, tags: list });
    }
    return groups;
  };

  const toggleTopTag = (name: string) =>
    setExpandedTopTags((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );

  /** 顶层标签（供新建时选父级） */
  const topLevelTags = () => tags().filter((t) => !t.parent);

  const loadTags = async () => {
    const r = await api.tags.list();
    if (r.success && r.data) setTags(r.data);
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadTags();
      loadTagDefs();
    }
  });

  const handleAddTag = async () => {
    const name = newTagName().trim();
    if (!name) return;
    const r = await api.tags.create(name, newTagColor(), newTagParent(), newTagScope() === "general" ? undefined : newTagScope());
    if (!r.success) {
      showToast("error", "创建标签失败", r.error || "未知错误");
      return;
    }
    // 先取父级再重置（评审 P1：此前先 setNewTagParent(null) 后取值，parent 恒为 null，展开逻辑成死代码）
    const parent = newTagParent();
    setNewTagName("");
    setNewTagParent(null);
    if (parent) {
      // 新建的是子标签 → 展开父级让新标签立即可见
      setExpandedTopTags((prev) => (prev.includes(parent) ? prev : [...prev, parent]));
    }
    await loadTags();
    refreshTags();
  };

  const handleSetColor = async (name: string, color: string) => {
    const r = await api.tags.setColor(name, color);
    if (!r.success && r.error) showToast("error", "修改颜色失败", r.error);
    setEditingColor(null);
    await loadTags();
    refreshTags();
  };

  const handleRename = async (oldName: string) => {
    const newName = renameValue().trim();
    if (!newName || newName === oldName) {
      setRenaming(null);
      return;
    }
    const r = await api.tags.rename(oldName, newName);
    if (r.success) {
      setRenaming(null);
      setRenameValue("");
      // 重命名后同步展开状态 key（评审 P2：否则旧名残留、该标签回收起态）
      setExpandedTopTags((prev) => prev.map((n) => (n === oldName ? newName : n)));
      await loadTags();
      refreshTags();
    } else {
      showToast("error", "重命名失败", r.error || "未知错误");
    }
  };

  /** 删除标签 → 弹确认框（带影响范围 count） */
  const handleDeleteTag = (name: string) => {
    setConfirmDelete({ name, orphan: false });
  };

  const doDeleteTag = async (name: string) => {
    const count = tags().find((t) => t.name === name)?.count ?? 0;
    const r = await api.tags.delete(name);
    if (r.success) {
      await loadTags();
      refreshTags();
      showToast("success", `已删除标签「${name}」`, `将从 ${count} 处移除`);
    } else {
      showToast("error", "删除失败", r.error || "未知错误");
    }
  };

  const handlePromote = async (name: string) => {
    const r = await api.tags.setParent(name, null);
    if (!r.success) {
      showToast("error", "提升失败", r.error || "未知错误");
      return;
    }
    await loadTags();
    refreshTags();
  };

  /** 顶层标签移至其他顶层标签下 */
  const handleMoveTo = async (name: string, target: string) => {
    const r = await api.tags.setParent(name, target);
    setMovingTag(null);
    if (!r.success) {
      showToast("error", "移动失败", r.error || "未知错误");
      return;
    }
    // 移入的标签成为 target 的子标签 → 展开 target 让结果可见
    setExpandedTopTags((prev) => (prev.includes(target) ? prev : [...prev, target]));
    await loadTags();
    refreshTags();
  };

  // —— v2.3.0：未定义标签（孤儿）治理 ——
  const orphanTags = () => tags().filter((t) => t.defined === false);
  const [adoptingOrphan, setAdoptingOrphan] = createSignal<string | null>(null);

  const handleAdopt = async (name: string, color: string) => {
    const r = await api.tags.adopt(name, color);
    if (!r.success && r.error) showToast("error", "转正失败", r.error);
    setAdoptingOrphan(null);
    await loadTags();
    refreshTags();
  };

  /** 清除孤儿引用 → 弹确认框（带影响范围 count） */
  const handleRemoveOrphan = (name: string) => {
    setConfirmDelete({ name, orphan: true });
  };

  const doRemoveOrphan = async (name: string) => {
    const count = tags().find((t) => t.name === name)?.count ?? 0;
    const r = await api.tags.delete(name);
    if (r.success) {
      await loadTags();
      refreshTags();
      showToast("success", `已清除标签「${name}」的引用`, `将从 ${count} 处移除`);
    } else {
      showToast("error", "清除失败", r.error || "未知错误");
    }
  };

  /** 顶层标签「移至…」下拉：点击其他区域关闭 */
  onMount(() => {
    const onDown = (e: MouseEvent) => {
      if (movingTag() === null) return;
      const t = e.target as Node;
      if (t instanceof Element && t.closest("[data-move-menu]")) return;
      setMovingTag(null);
    };
    window.addEventListener("mousedown", onDown);
    onCleanup(() => window.removeEventListener("mousedown", onDown));
  });

  // v2.4.9（S4）：挂载回填开机自启开关状态（应用级，无需工作区）
  onMount(() => {
    void loadAutoLaunch();
  });

  /** 删除/清除引用确认弹窗内容（target 由 Show 保证非空） */
  const DeleteConfirm = (props: { name: string; orphan: boolean; onDone: () => void }) => {
    const count = () => tags().find((t) => t.name === props.name)?.count ?? 0;
    return (
      <ConfirmDialog
        title={props.orphan ? "清除引用" : "删除标签"}
        message={
          props.orphan
            ? `确定清除标签「${props.name}」的所有引用吗？将从 ${count()} 处移除。`
            : `确定删除标签「${props.name}」吗？将从 ${count()} 处移除，并同步清理所有文件与产品集。`
        }
        confirmLabel={props.orphan ? "清除" : "删除"}
        danger
        onConfirm={() => {
          // Solid props 惰性 getter：先取快照再 onDone（同 FileBrowserView/Search 2026-08-15 修复；
          // 此前 onDone 置 null 后读 props.orphan/props.name 重求值为 null → TypeError，删除不执行）
          const { name, orphan } = props;
          props.onDone();
          void (orphan ? doRemoveOrphan(name) : doDeleteTag(name));
        }}
        onCancel={props.onDone}
      />
    );
  };

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <div class="mb-8">
        <h1 class="text-2xl font-bold text-surface-900">设置</h1>
        <p class="text-surface-500 mt-1">配置当前工作区的命名规则和文件夹类型</p>
      </div>

      <Show
        when={currentWorkspace()}
        fallback={
          <div class="card p-12 text-center">
            <div class="text-4xl mb-3">⚙️</div>
            <h3 class="text-lg font-medium text-surface-700">未选择工作区</h3>
            <p class="text-sm text-surface-400 mt-1">请先创建或打开一个工作区</p>
          </div>
        }
      >
        <div class="space-y-6">
          {/* v2.4.9（S4）：通用——开机自启（应用级设置，Linux .desktop / Win·mac 系统登录项） */}
          <div class="card p-6">
            <h2 class="text-lg font-semibold mb-2">通用</h2>
            <p class="text-sm text-surface-500 mb-4">应用级通用设置</p>
            <label class="flex items-center justify-between gap-4 cursor-pointer">
              <div>
                <div class="text-sm font-medium text-surface-700">开机自启</div>
                <div class="text-xs text-surface-400 mt-0.5">登录系统后自动启动，驻留托盘后台运行，不弹出主窗口</div>
              </div>
              <input
                type="checkbox"
                class="w-5 h-5 accent-primary-600 cursor-pointer"
                checked={autoLaunch()}
                onChange={(e) => void toggleAutoLaunch(e.currentTarget.checked)}
              />
            </label>
          </div>

          {/* 标签管理 */}
          <div class="card p-6">
            <h2 class="text-lg font-semibold mb-2">标签管理</h2>
            <p class="text-sm text-surface-500 mb-4">统一管理标签颜色；重命名/删除会同步所有文件与产品集</p>

            {/* 新建标签 */}
            <div class="flex items-center gap-2 mb-4 flex-wrap">
              <input
                class="px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 w-36"
                placeholder="标签名称"
                value={newTagName()}
                onInput={(e) => setNewTagName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
              />
              <select
                class="px-2 py-2 border border-surface-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                aria-label="标签父级"
                value={newTagParent() ?? ""}
                onChange={(e) => setNewTagParent(e.currentTarget.value || null)}
              >
                <option value="">顶层标签</option>
                <For each={topLevelTags()}>
                  {(t) => <option value={t.name}>作为 {t.name} 的子标签</option>}
                </For>
              </select>
              {/* v2.5.7（A3）：新建标签业务域选择（general = 全域） */}
              <select
                class="px-2 py-2 border border-surface-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                aria-label="标签域"
                value={newTagScope()}
                onChange={(e) => setNewTagScope(e.currentTarget.value)}
              >
                <For each={SCOPE_OPTIONS}>
                  {(o) => <option value={o.value}>{o.label}</option>}
                </For>
              </select>
              <div class="flex items-center gap-1">
                <For each={PALETTE}>
                  {(c) => (
                    <button
                      class={`w-5 h-5 rounded-full transition-transform ${newTagColor() === c ? "ring-2 ring-offset-1 ring-surface-700 scale-110" : ""}`}
                      style={{ "background-color": c }}
                      onClick={() => setNewTagColor(c)}
                    />
                  )}
                </For>
              </div>
              <button class="btn-primary px-3 py-2 text-sm" onClick={handleAddTag}>
                + 添加
              </button>
            </div>

            {/* 标签树（顶层 + 子标签；v2.5.7 A3：按域分组，general 在前） */}
            <Show
              when={topLevelTags().length > 0}
              fallback={<div class="text-sm text-surface-400 py-4 text-center">暂无标签，先给文件或产品集打上标签吧</div>}
            >
              <div class="space-y-4">
                <For each={tagGroups()}>
                  {(group) => (
                    <div>
                      <Show when={group.scope !== "general"}>
                        <div class="flex items-center gap-2 mb-1">
                          <span class="text-xs font-medium text-primary-600 px-2 py-0.5 bg-primary-50 rounded-full">
                            {group.label}域
                          </span>
                          <span class="text-[11px] text-surface-400">仅在该业务域选择器中出现</span>
                        </div>
                      </Show>
                      <div class="space-y-1">
                        <For each={group.tags}>
                          {(tag) => (
                            <>
                              <div class="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-surface-100 transition-colors">
                                {/* v2.4.7（F8）：折叠箭头——有子标签才显示，点击展开/收起 */}
                                <Show
                                  when={tag.children.length > 0}
                                  fallback={<span class="w-4 shrink-0" />}
                                >
                                  <button
                                    class="w-4 shrink-0 text-surface-400 hover:text-surface-700 cursor-pointer text-[10px] leading-none"
                                    title={expandedTopTags().includes(tag.name) ? "收起子标签" : "展开子标签"}
                                    onClick={() => toggleTopTag(tag.name)}
                                  >
                                    {expandedTopTags().includes(tag.name) ? "▼" : "▶"}
                                  </button>
                                </Show>
                                <button
                                  class="w-5 h-5 rounded-full shrink-0 cursor-pointer"
                                  style={{ "background-color": tag.color }}
                                  title="点击改颜色"
                                  onClick={() => setEditingColor(editingColor() === tag.name ? null : tag.name)}
                                />
                        <Show when={editingColor() === tag.name}>
                          <div class="flex items-center gap-1">
                            <For each={PALETTE}>
                              {(c) => (
                                <button
                                  class={`w-4 h-4 rounded-full ${tag.color === c ? "ring-2 ring-offset-1 ring-surface-700" : ""}`}
                                  style={{ "background-color": c }}
                                  onClick={() => handleSetColor(tag.name, c)}
                                />
                              )}
                            </For>
                          </div>
                        </Show>
                        <Show
                          when={renaming() === tag.name}
                          fallback={
                            <span class="text-sm font-medium flex-1">
                              {tag.name}
                            </span>
                          }
                        >
                          <input
                            class="px-2 py-1 border border-surface-200 rounded text-sm flex-1 min-w-0"
                            value={renameValue()}
                            onInput={(e) => setRenameValue(e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleRename(tag.name);
                              if (e.key === "Escape") setRenaming(null);
                            }}
                          />
                        </Show>
                        {/* v2.5.7（A3）：域列——徽标 + 点击改域（内联 select） */}
                        <span class="shrink-0 text-[11px] px-1.5 py-0.5 rounded-full bg-surface-100 text-surface-500 cursor-pointer hover:bg-primary-50 hover:text-primary-600"
                          title="点击修改标签域"
                          onClick={() => setScopeEditing(scopeEditing() === tag.name ? null : tag.name)}
                        >
                          {SCOPE_LABEL[tag.scope ?? "general"] ?? "全域"}
                        </span>
                        <Show when={scopeEditing() === tag.name}>
                          <select
                            class="shrink-0 px-1 py-0.5 border border-surface-200 rounded text-xs bg-white"
                            value={tag.scope ?? "general"}
                            onChange={(e) => void handleSetScope(tag.name, e.currentTarget.value)}
                            onBlur={() => setScopeEditing(null)}
                            autofocus
                          >
                            <For each={SCOPE_OPTIONS}>
                              {(o) => <option value={o.value}>{o.label}</option>}
                            </For>
                          </select>
                        </Show>
                        <span class="text-xs text-surface-400 shrink-0">{tag.count} 处</span>
                        <button
                          class="text-xs text-surface-500 hover:text-primary-600 shrink-0"
                          onClick={() => {
                            setRenaming(tag.name);
                            setRenameValue(tag.name);
                          }}
                        >
                          重命名
                        </button>
                        <Show when={topLevelTags().length > 1}>
                          <div data-move-menu class="relative shrink-0">
                            <button
                              class="text-xs text-surface-500 hover:text-primary-600"
                              onClick={() => setMovingTag(movingTag() === tag.name ? null : tag.name)}
                            >
                              移至…
                            </button>
                            <Show when={movingTag() === tag.name}>
                              <div class="absolute right-0 top-full mt-1 z-30 bg-white border border-surface-200 rounded-lg shadow-lg py-1 min-w-32">
                                <div class="px-3 py-1 text-[11px] text-surface-400">移至其他顶层标签下</div>
                                <For each={topLevelTags().filter((t) => t.name !== tag.name)}>
                                  {(target) => (
                                    <button
                                      class="w-full px-3 py-1.5 text-left text-sm hover:bg-surface-100"
                                      onClick={() => void handleMoveTo(tag.name, target.name)}
                                    >
                                      {target.name}
                                    </button>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        </Show>
                        <button
                          class="text-xs text-danger-500 hover:text-danger-600 shrink-0"
                          onClick={() => handleDeleteTag(tag.name)}
                        >
                          删除
                        </button>
                      </div>

                      {/* 子标签（缩进；v2.4.7 默认收起，点顶层标签箭头展开） */}
                      <Show when={tag.children.length > 0 && expandedTopTags().includes(tag.name)}>
                        <div class="ml-8 border-l-2 border-surface-100 pl-3 space-y-1">
                          <For each={tag.children}>
                            {(childName) => {
                              const child = tags().find((t) => t.name === childName);
                              if (!child) return null;
                              return (
                                <div class="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-surface-100 transition-colors">
                                  <button
                                    class="w-4 h-4 rounded-full shrink-0 cursor-pointer"
                                    style={{ "background-color": child.color }}
                                    title="点击改颜色"
                                    onClick={() => setEditingColor(editingColor() === child.name ? null : child.name)}
                                  />
                                  <Show when={editingColor() === child.name}>
                                    <div class="flex items-center gap-1">
                                      <For each={PALETTE}>
                                        {(c) => (
                                          <button
                                            class={`w-4 h-4 rounded-full ${child.color === c ? "ring-2 ring-offset-1 ring-surface-700" : ""}`}
                                            style={{ "background-color": c }}
                                            onClick={() => handleSetColor(child.name, c)}
                                          />
                                        )}
                                      </For>
                                    </div>
                                  </Show>
                                  <Show
                                    when={renaming() === child.name}
                                    fallback={
                                      <span class="text-sm flex-1 min-w-0">
                                        <span class="text-[11px] text-surface-400 mr-1">└ {tag.name}/</span>
                                        <span class="font-medium">{child.name}</span>
                                      </span>
                                    }
                                  >
                                    <input
                                      class="px-2 py-1 border border-surface-200 rounded text-sm flex-1 min-w-0"
                                      value={renameValue()}
                                      onInput={(e) => setRenameValue(e.currentTarget.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") handleRename(child.name);
                                        if (e.key === "Escape") setRenaming(null);
                                      }}
                                    />
                                  </Show>
                                  <span class="text-xs text-surface-400 shrink-0">{child.count} 处</span>
                                  <button
                                    class="text-xs text-surface-500 hover:text-primary-600 shrink-0"
                                    title="提升为顶层标签"
                                    onClick={() => handlePromote(child.name)}
                                  >
                                    ⬆ 顶层
                                  </button>
                                  <button
                                    class="text-xs text-surface-500 hover:text-primary-600 shrink-0"
                                    onClick={() => {
                                      setRenaming(child.name);
                                      setRenameValue(child.name);
                                    }}
                                  >
                                    重命名
                                  </button>
                                  <button
                                    class="text-xs text-danger-500 hover:text-danger-600 shrink-0"
                                    onClick={() => handleDeleteTag(child.name)}
                                  >
                                    删除
                                  </button>
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      </Show>
                    </>
                  )}
                </For>
                </div>
              </div>
              )}
            </For>
            </div>
            </Show>

            {/* v2.3.0：未定义标签（孤儿）治理区块 */}
            <Show when={orphanTags().length > 0}>
              <div class="mt-4 pt-3 border-t border-surface-100">
                <div class="flex items-center gap-2 mb-2">
                  <span class="text-sm font-medium text-surface-600">未定义标签</span>
                  <span class="text-[11px] text-surface-400">
                    存在于文件/产品集但未在此定义（历史自由输入引入），可转为正式标签或清除引用
                  </span>
                </div>
                <div class="space-y-1">
                  <For each={orphanTags()}>
                    {(tag) => (
                      <div class="flex items-center gap-3 py-2 px-3 rounded-lg bg-warning-50/60 hover:bg-warning-50 transition-colors">
                        <button
                          class="w-5 h-5 rounded-full shrink-0 cursor-default bg-surface-300 border border-dashed border-surface-400"
                          title="未定义标签"
                        />
                        <span class="text-sm font-medium flex-1 text-warning-800">{tag.name}</span>
                        <span class="text-xs text-surface-400 shrink-0">{tag.count} 处</span>
                        <Show when={adoptingOrphan() === tag.name}>
                          <div class="flex items-center gap-1">
                            <For each={PALETTE}>
                              {(c) => (
                                <button
                                  class="w-4 h-4 rounded-full"
                                  style={{ "background-color": c }}
                                  onClick={() => handleAdopt(tag.name, c)}
                                />
                              )}
                            </For>
                          </div>
                        </Show>
                        <button
                          class="text-xs text-surface-500 hover:text-primary-600 shrink-0"
                          onClick={() => setAdoptingOrphan(adoptingOrphan() === tag.name ? null : tag.name)}
                        >
                          {adoptingOrphan() === tag.name ? "取消" : "转为正式标签"}
                        </button>
                        <button
                          class="text-xs text-danger-500 hover:text-danger-600 shrink-0"
                          onClick={() => handleRemoveOrphan(tag.name)}
                        >
                          清除引用
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* 删除/清除引用确认弹窗 */}
            <Show when={confirmDelete()}>
              <DeleteConfirm
                name={confirmDelete()!.name}
                orphan={confirmDelete()!.orphan}
                onDone={() => setConfirmDelete(null)}
              />
            </Show>
          </div>

          {/* Naming Template */}
          <div class="card p-6">
            <h2 class="text-lg font-semibold mb-4">命名模板</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">产品集前缀</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={config().naming_template.product_set_prefix}
                  onInput={(e) => updateNamingField("product_set_prefix", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">产品集后缀</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={config().naming_template.product_set_suffix}
                  onInput={(e) => updateNamingField("product_set_suffix", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">SKU 分隔符</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={config().naming_template.sku_separator}
                  onInput={(e) => updateNamingField("sku_separator", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">冲突后缀模板</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={config().naming_template.conflict_suffix}
                  onInput={(e) => updateNamingField("conflict_suffix", e.currentTarget.value)}
                />
                <p class="text-xs text-surface-400 mt-1">使用 {"{n}"} 表示序号</p>
              </div>
            </div>

            {/* v2.4.9 S5：字段复选框组（sku_fields 勾选；编号 hint 说明两种编号来源） */}
            <div class="mt-4 pt-4 border-t border-surface-100">
              <label class="block text-sm font-medium text-surface-700 mb-2">字段</label>
              <div class="flex flex-wrap gap-4">
                <For each={NAMING_FIELD_OPTIONS}>
                  {(opt) => (
                    <label class="inline-flex items-center gap-1.5 text-sm text-surface-700 cursor-pointer">
                      <input
                        type="checkbox"
                        class="w-4 h-4 accent-primary-600 cursor-pointer"
                        checked={config().naming_template.sku_fields.includes(opt.key)}
                        onChange={() => toggleSkuField(opt.key)}
                      />
                      {opt.label}
                    </label>
                  )}
                </For>
              </div>
              <p class="text-xs text-surface-400 mt-1">编号：导入按批次顺序、批量重命名按起始序号，自动补零</p>
            </div>
          </div>

          {/* v2.5.5：LAN 自动注册说明（PLAN §四 决策 3——子文件夹管理段可见性反馈） */}
          <p class="text-xs text-surface-400 mb-2">LAN 传输来的文件夹会自动加入对应清单（图包/证书/文档/客户），无需手动添加。</p>

          {/* Image Subfolders */}
          <div class="card p-6">
            <h2 class="text-lg font-semibold mb-4">图包子文件夹</h2>
            <div class="flex gap-2 mb-4">
              <input
                type="text"
                class="flex-1 px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="新增子文件夹名称"
                value={newImageFolder()}
                onInput={(e) => setNewImageFolder(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && addImageFolder()}
              />
              <button class="btn-primary" onClick={addImageFolder}>
                添加
              </button>
            </div>
            <div class="flex flex-wrap gap-2">
              <For each={config().image_subfolders}>
                {(folder, index) => (
                  <SubfolderChip name={folder} type="image" index={index()} onRemove={removeImageFolder} />
                )}
              </For>
            </div>
            <Show when={renameError()}>
              <div class="mt-2 text-sm text-danger-600">{renameError()}</div>
            </Show>
          </div>

          {/* Cert Subfolders */}
          <div class="card p-6">
            <h2 class="text-lg font-semibold mb-4">证书子文件夹</h2>
            <div class="flex gap-2 mb-4">
              <input
                type="text"
                class="flex-1 px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="新增证书类型名称"
                value={newCertFolder()}
                onInput={(e) => setNewCertFolder(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && addCertFolder()}
              />
              <button class="btn-primary" onClick={addCertFolder}>
                添加
              </button>
            </div>
            <div class="flex flex-wrap gap-2">
              <For each={config().cert_subfolders}>
                {(folder, index) => (
                  <SubfolderChip name={folder} type="cert" index={index()} onRemove={removeCertFolder} />
                )}
              </For>
            </div>
            <Show when={renameError()}>
              <div class="mt-2 text-sm text-danger-600">{renameError()}</div>
            </Show>
          </div>

          {/* v2.4.7：客户子文件夹（对齐 image/cert 段；重命名同步迁移所有客户目录） */}
          <div class="card p-6">
            <h2 class="text-lg font-semibold mb-4">客户子文件夹</h2>
            <div class="flex gap-2 mb-4">
              <input
                type="text"
                class="flex-1 px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="新增客户子文件夹名称"
                value={newCustomerFolder()}
                onInput={(e) => setNewCustomerFolder(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && addCustomerFolder()}
              />
              <button class="btn-primary" onClick={addCustomerFolder}>
                添加
              </button>
            </div>
            <div class="flex flex-wrap gap-2">
              {/* v2.5.7（A2 笔记）：内建「笔记」徽标（不写 config，永不进入列表；仅作可视说明） */}
              <SubfolderChip name={BUILTIN_NOTES_FOLDER} type="customer" index={-1} onRemove={() => {}} builtin />
              <For each={config().customer_subfolders ?? []}>
                {(folder, index) => (
                  <SubfolderChip name={folder} type="customer" index={index()} onRemove={removeCustomerFolder} />
                )}
              </For>
            </div>
            <Show when={renameError()}>
              <div class="mt-2 text-sm text-danger-600">{renameError()}</div>
            </Show>
          </div>

          {/* v2.5.3（P2-19）：文档子文件夹（对齐客户段；config.doc_subfolders；重命名同步迁移所有产品集「文档/」目录） */}
          <div class="card p-6">
            <h2 class="text-lg font-semibold mb-4">文档子文件夹</h2>
            <div class="flex gap-2 mb-4">
              <input
                type="text"
                class="flex-1 px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="新增文档子文件夹名称"
                value={newDocFolder()}
                onInput={(e) => setNewDocFolder(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && addDocFolder()}
              />
              <button class="btn-primary" onClick={addDocFolder}>
                添加
              </button>
            </div>
            <div class="flex flex-wrap gap-2">
              {/* v2.5.7（A2 笔记）：内建「笔记」徽标（不写 config，永不进入列表；仅作可视说明） */}
              <SubfolderChip name={BUILTIN_NOTES_FOLDER} type="doc" index={-1} onRemove={() => {}} builtin />
              <For each={config().doc_subfolders ?? []}>
                {(folder, index) => (
                  <SubfolderChip name={folder} type="doc" index={index()} onRemove={removeDocFolder} />
                )}
              </For>
            </div>
            <Show when={renameError()}>
              <div class="mt-2 text-sm text-danger-600">{renameError()}</div>
            </Show>
          </div>

          {/* v2.5.5：供应商子文件夹（对齐客户段；config.supplier_subfolders；重命名同步迁移所有供应商目录） */}
          <div class="card p-6">
            <h2 class="text-lg font-semibold mb-4">供应商子文件夹</h2>
            <div class="flex gap-2 mb-4">
              <input
                type="text"
                class="flex-1 px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="新增供应商子文件夹名称"
                value={newSupplierFolder()}
                onInput={(e) => setNewSupplierFolder(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && addSupplierFolder()}
              />
              <button class="btn-primary" onClick={addSupplierFolder}>
                添加
              </button>
            </div>
            <div class="flex flex-wrap gap-2">
              {/* v2.5.7（A2 笔记）：内建「笔记」徽标（不写 config，永不进入列表；仅作可视说明） */}
              <SubfolderChip name={BUILTIN_NOTES_FOLDER} type="supplier" index={-1} onRemove={() => {}} builtin />
              <For each={config().supplier_subfolders ?? []}>
                {(folder, index) => (
                  <SubfolderChip name={folder} type="supplier" index={index()} onRemove={removeSupplierFolder} />
                )}
              </For>
            </div>
            <Show when={renameError()}>
              <div class="mt-2 text-sm text-danger-600">{renameError()}</div>
            </Show>
          </div>

          <div class="flex items-center gap-4">
            <button class="btn-primary px-6" onClick={handleSave}>
              {saved() ? "已保存 ✓" : "保存设置"}
            </button>
            <Show when={saved()}>
              <span class="text-sm text-success-600">设置已保存到工作区</span>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
