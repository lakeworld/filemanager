import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import {
  currentWorkspace,
  workspaceConfig,
  loadWorkspaceConfig,
  updateWorkspaceConfig,
  defaultWorkspaceConfig,
} from "~/stores/workspace";
import { api } from "~/wails/api";
import type { SubfolderDriftReport } from "~/types";
import { loadTagDefs, refreshTags } from "~/stores/tags";
import { showToast } from "~/stores/notifyBanner";
import ConfirmDialog from "~/components/ConfirmDialog";
import SearchSelect from "~/components/ui/SearchSelect";
import type { ApiResult, NamingField, TagInfo, WorkspaceConfig } from "~/types";
import { BUILTIN_NOTES_FOLDER } from "~/constants/notes";
import Input from "~/components/ui/Input";
import { SHORTCUTS, comboLabel } from "~/shortcuts";
import { appSettings, appSettingsReady, reloadAppSettings, setAppSetting } from "~/stores/appSettings";
import { wakeOutcome, WAKE_OCCUPIED_HINT } from "~/lib/wakeFeedback";
import type { AppSettingsPatch } from "../../../shared/appSettings";
import { CERT_REMINDER_DAY_CHOICES, WAKE_SEARCH_ACCELERATOR_LABEL } from "../../../shared/appSettings";

/**
 * v2.5.8 D11（W7）：通用卡里的一条开关（对齐开机自启既有行式：标题 + 一行说明 + 右侧复选框）。
 * 抽成小组件是因为本卡从 1 条变 6 条，重复六段同样的 label 结构反而更难核对是否漏了某项。
 */
/** 写失败/未就绪时禁用开关（就绪前是默认值镜像，点了会被首拉响应覆盖 → 见 stores/appSettings） */
function SettingToggle(props: {
  title: string;
  desc: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      class="flex items-center justify-between gap-4 cursor-pointer py-2"
      classList={{ "opacity-60 cursor-not-allowed": !!props.disabled }}
    >
      <div>
        <div class="text-sm font-medium text-surface-700">{props.title}</div>
        <div class="text-xs text-surface-400 mt-0.5">{props.desc}</div>
      </div>
      <input
        type="checkbox"
        class="w-5 h-5 accent-primary-600 cursor-pointer"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
    </label>
  );
}

/** 提前提醒天数选项（档位与顺序取自 shared 唯一真相，不在这里另写一份数字） */
const CERT_DAY_OPTIONS = CERT_REMINDER_DAY_CHOICES.map((d) => ({ value: String(d), label: `${d} 天` }));

/** 预设色板（标签颜色选择） */
const PALETTE = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#22c55e",
  "#14b8a6", "#0ea5e9", "#3b82f6", "#8b5cf6", "#ec4899",
  "#64748b",
];

/** v2.5.9（A9 刀4）：模板表 vs 盘上实际的差额摘要（只读，打开「子文件夹」tab 时自动跑）。
 *  不新建卡片、不加按钮——见挂载处的棘轮说明。 */
function HealthDriftSummary() {
  const [report, setReport] = createSignal<SubfolderDriftReport | null>(null);
  const [failed, setFailed] = createSignal("");

  onMount(() => {
    void (async () => {
      const r = await api.workspace.healthAudit();
      if (r.success && r.data) setReport(r.data);
      else setFailed(r.error || "体检失败");
    })();
  });

  const KIND_LABEL: Record<string, string> = {
    image: "图包", cert: "证书", doc: "文档", customer: "客户", supplier: "供应商",
  };
  const SCOPE_LABEL: Record<string, string> = { productSet: "产品集", customer: "客户", supplier: "供应商" };
  const where = (f: { scope: string; entity: string; kind: string; name: string }): string =>
    `${SCOPE_LABEL[f.scope] ?? f.scope}「${f.entity}」/ ${KIND_LABEL[f.kind] ?? f.kind} / ${f.name}`;

  return (
    <Show when={report() || failed()} fallback={<p class="text-xs text-surface-400">体检中…</p>}>
      <Show when={failed()}>
        <p class="text-xs text-danger-600">工作区体检失败：{failed()}</p>
      </Show>
      <Show when={report()}>
        {(r) => (
          <div class="text-xs text-surface-500 space-y-2">
            <p>
              体检：扫了 {r().scannedEntities} 个实体 · <b class="text-surface-700">未登记 {r().unregistered.length}</b>（盘上有、表里没有，v2.5.9 起会显示） ·
              模板死条目 {r().templateOnly.length} · 空目录 {r().emptyFolders.length}
            </p>
            <Show when={r().unregistered.length > 0}>
              <div>
                <p class="text-surface-600 mb-0.5">未登记目录（会开始出现在界面上）：</p>
                <ul class="space-y-0.5 max-h-32 overflow-auto">
                  <For each={r().unregistered}>{(f) => <li>· {where(f)}</li>}</For>
                </ul>
              </div>
            </Show>
            <Show when={r().templateOnly.length > 0}>
              <p>
                模板死条目（登记了但盘上没有，只在新建实体时生效）：
                <span class="text-surface-600">{r().templateOnly.join("、")}</span>
              </p>
            </Show>
            <Show when={r().emptyFolders.length > 0}>
              <p>
                空目录 {r().emptyFolders.length} 个（会淡显），例如：
                <span class="text-surface-600">{r().emptyFolders.slice(0, 5).map(where).join("；")}</span>
                <Show when={r().emptyFolders.length > 5}>
                  <span class="text-surface-400"> 等 {r().emptyFolders.length} 个</span>
                </Show>
              </p>
            </Show>
          </div>
        )}
      </Show>
    </Show>
  );
}

/** v2.5.8（D3.5）：存储优化——去重巡检（证书/文档域同内容重建硬链接；同步物化副本的本机回收） */
function DedupSweepCard() {
  const [sweeping, setSweeping] = createSignal(false);
  const [result, setResult] = createSignal<{ groups: number; relinked: number; bytesSaved: number; failed: number } | null>(null);

  const fmtBytes = (n: number): string => {
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
    return n + " B";
  };

  const runSweep = async () => {
    if (sweeping()) return;
    setSweeping(true);
    setResult(null);
    try {
      const r = await api.files.dedupSweep();
      if (!r.success || !r.data) {
        showToast("error", "去重巡检失败", r.error || "未知错误");
        return;
      }
      setResult({ groups: r.data.groups, relinked: r.data.relinked, bytesSaved: r.data.bytesSaved, failed: r.data.failed.length });
      if (r.data.groups === 0) showToast("success", "未发现重复内容");
      else
        showToast(
          "success",
          `发现 ${r.data.groups} 组重复，重建 ${r.data.relinked} 个硬链接`,
          `节省磁盘约 ${fmtBytes(r.data.bytesSaved)}` + (r.data.failed.length > 0 ? `，${r.data.failed.length} 个跳过` : ""),
        );
    } catch (err) {
      showToast("error", "去重巡检失败", String(err));
    } finally {
      setSweeping(false);
    }
  };

  return (
    <div class="card card-glass p-6">
      <h2 class="text-lg font-semibold mb-2">存储优化 · 去重巡检</h2>
      <p class="text-sm text-surface-500 mb-1">
        扫描证书/文档域中内容完全相同的文件并重建硬链接：磁盘只存一份，各产品集照常可见，标签/到期日等元数据不动，不删除任何文件。
      </p>
      <p class="text-xs text-surface-400 mb-4">
        适用场景：坚果云同步到另一台机器后，硬链接关系一般会断（物化为两份独立文件），在新机器上跑一次巡检即可回收。仅对大小相同的文件做内容比对，串行低占用；巡检后另一端同步软件会对被替换文件做一次对账（内容相同，流量影响极小）。
      </p>
      <div class="flex items-center gap-3">
        <button class="btn-primary px-4" disabled={sweeping()} onClick={() => void runSweep()}>
          {sweeping() ? "巡检中…" : "开始巡检"}
        </button>
        <Show when={result()}>
          {(r) => (
            <span class="text-sm text-surface-600">
              发现 {r().groups} 组 · 重建 {r().relinked} 个 · 节省 {fmtBytes(r().bytesSaved)}
              <Show when={r().failed > 0}> · 跳过 {r().failed} 个</Show>
            </span>
          )}
        </Show>
      </div>
    </div>
  );
}

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
    // 成功也按主进程回读的真实状态落位（未打包实例的「关」可能是 no-op，恒按 checked 落位会留下假象）
    setAutoLaunchState(r.data === undefined ? checked : !!r.data);
  };

  // —— v2.5.8 D11（W7）：应用级设置开关（userData/settings.json，与开机自启同一回滚纪律）——
  // 值来自 `stores/appSettings` 的信号（App 启动时拉一次）；写回以主进程返回的全量值为权威。
  const pref = appSettings;
  const prefReady = appSettingsReady;
  // v2.5.9/A6-1 验收补漏（评审 Spec 轴抓到）：主进程注册不上时会把持久值如实退回 false，
  // 这里负责把"为什么弹回关了"说一句——否则用户只看到一个自己跳回去的开关，等于没说。
  const [wakeNote, setWakeNote] = createSignal("");
  const savePref = async (patch: AppSettingsPatch) => {
    const ok = await setAppSetting(patch);
    if (!ok) {
      // 写失败必须**await 重拉**：复选框是受控的，但 Solid 只在信号变化时才回写 DOM——
      // 用户刚点过的那一下已经改了 DOM 状态，不重拉就留下「显示已关、其实没落盘」的假象。
      await reloadAppSettings();
      showToast("error", "设置失败", "未能保存该设置，已恢复为磁盘上的当前值");
      return; // 写都没写成，别把"写失败"报成"快捷键被占用"
    }
    const outcome = wakeOutcome(patch.globalWakeShortcut, pref().globalWakeShortcut);
    if (outcome === "occupied") {
      setWakeNote(WAKE_OCCUPIED_HINT);
      showToast("error", "全局唤醒快捷键未注册", "开关已保持关闭；释放该组合键后可以再试一次");
    } else if (outcome === "registered") {
      setWakeNote("");
    }
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

  // —— v2.2.1：子文件夹重命名；v2.5.3（P2-19）补 doc 域；v2.5.5 补 supplier 域
  // v2.5.9（A9 刀3b）：口径变了——这里改的是**默认模板**（新建实体时建哪些文件夹）。
  //   旧行为会把**所有已有实体下的同名目录一起物理改名**（用户只改个名，整个工作区的盘被动）。
  //   现在改名后先问一句：默认「只改模板」，要连实体一起改必须点显式的危险按钮。——
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

  /**
   * 执行子文件夹改名。`across` 缺省 false＝**只改默认模板**（安全默认，不动任何实体目录）；
   * true＝连所有产品集/客户/供应商下的同名目录一起物理改名（**直接改硬盘上的目录名**）。
   * v2.5.9（A9 刀3b）：旧行为是无条件 across=true——用户只是改个名，整个工作区的盘被动过。
   */
  const confirmRename = async (across = false) => {
    const target = renamingFolder();
    if (!target) return;
    const newName = subfolderRenameValue().trim();
    if (!newName) {
      setRenameError("名称不能为空");
      return;
    }
    const r = await api.workspace.renameSubfolder(target.type, target.oldName, newName, { acrossEntities: across });
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
            <Input
              compact
              autoFocus
              class="w-32 border-primary-300"
              ariaLabel="重命名子文件夹"
              value={subfolderRenameValue()}
              onInput={(e) => setSubfolderRenameValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmRename(); // 安全默认：只改模板
                if (e.key === "Escape") cancelRename();
              }}
            />
            <button class="icon-btn text-primary-600 hover:text-primary-700 text-xs" onClick={() => void confirmRename()}>✓</button>
            {/* v2.5.9（A9 刀3b）：这颗红钮是**显式点名才动盘**——把每个实体下的同名目录一起改名。
                 ✓ / Enter 走的是安全默认（只改新建模板）。旧代码那种"改个名就迁全工作区"不再发生。
                 基准值同批更新见 `tests/unit/uiScan.test.ts` 的 BASE 变更流水（用户 2026-09-21 点头）。 */}
            <button class="icon-btn text-danger-600 hover:text-danger-700 transition-colors text-xs" title="连所有实体下的同名文件夹一起改名（直接改硬盘上的目录名）" onClick={() => void confirmRename(true)}>⇌</button>
            <button class="icon-btn text-surface-400 hover:text-surface-600 text-xs" onClick={cancelRename}>✕</button>
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
              <button class="icon-btn text-surface-400 hover:text-primary-600 ml-0.5" title="重命名（默认只改新建模板；旁边 ⇌ 才连所有实体一起改）" onClick={() => startRename(props.type, props.name)}>
                ✎
              </button>
              <button class="icon-btn text-surface-400 hover:text-danger-500 ml-0.5" onClick={() => props.onRemove(props.index)}>
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
          <div class="card card-glass p-12 text-center">
            <div class="text-4xl mb-3">⚙️</div>
            <h3 class="text-lg font-medium text-surface-700">未选择工作区</h3>
            <p class="text-sm text-surface-400 mt-1">请先创建或打开一个工作区</p>
          </div>
        }
      >
        <div class="space-y-6">
          {/* v2.4.9（S4）：通用——开机自启（应用级设置，Linux .desktop / Win·mac 系统登录项）
              v2.5.8 D11（W7）：本卡从「只有一条开机自启」扩成应用级设置全集。
              **默认值全部 = 该项开关化之前的现行行为**（老用户升级零行为变更，shared/appSettings.ts 是唯一真相）；
              每项一行说明文案、同一行式（对齐下方开机自启的既有格式）。
              减少动画未列：它与 D6 固化的「prefers-reduced-motion 全站单点」门禁语义冲突（加应用级开关 =
              要动那条门禁的断言），按「改门禁需拍板」留待裁决，见执行卡 §十。 */}
          <div class="card card-glass p-6">
            <h2 class="text-lg font-semibold mb-2">通用</h2>
            <p class="text-sm text-surface-500 mb-4">应用级通用设置</p>
            <div class="flex flex-col divide-y divide-surface-100">
              <label class="flex items-center justify-between gap-4 cursor-pointer py-2 first:pt-0">
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
              <SettingToggle
                title="关闭主窗口时驻留托盘"
                desc="开：点关闭只隐藏到托盘，后台继续运行（默认）。关：关闭主窗口即退出应用"
                checked={pref().closeToTray}
                disabled={!prefReady()}
                onChange={(v) => void savePref({ closeToTray: v })}
              />
              <SettingToggle
                title="自动检查更新"
                desc="启动时与每天后台检查一次并提醒；关闭后可在「我的 → 检查更新」手动检查"
                checked={pref().autoUpdateCheck}
                disabled={!prefReady()}
                onChange={(v) => void savePref({ autoUpdateCheck: v })}
              />
              <SettingToggle
                title="悬浮多选操作条"
                desc="选中文件/记录时屏幕底部浮出批量操作条。关闭后不再浮出，批量按钮仍在各页工具栏内"
                checked={pref().selectionBar}
                disabled={!prefReady()}
                onChange={(v) => void savePref({ selectionBar: v })}
              />
              <SettingToggle
                title="剪贴板让位正文选区"
                desc="复制时若正文里选中了文字，Ctrl+C 复制那段文字而不是文件路径（推荐保持开启）"
                checked={pref().clipboardGuard}
                disabled={!prefReady()}
                onChange={(v) => void savePref({ clipboardGuard: v })}
              />
              <SettingToggle
                title={`全局唤醒搜索（${WAKE_SEARCH_ACCELERATOR_LABEL}）`}
                desc="任何程序前台时按下都能把启禾唤到前面并直接进搜索页。默认关——它占用的是系统级按键，可能与你其它软件的快捷键撞车"
                checked={pref().globalWakeShortcut}
                disabled={!prefReady()}
                onChange={(v) => void savePref({ globalWakeShortcut: v })}
              />
              <Show when={wakeNote()}>
                <p class="text-xs text-warning-800 -mt-2 mb-2">{wakeNote()}</p>
              </Show>
              <SettingToggle
                title="证书到期与发票待办提醒"
                desc="每日一次系统通知（当天已提醒过的不重复打扰）；关闭后仪表盘区块照常显示"
                checked={pref().certReminder}
                disabled={!prefReady()}
                onChange={(v) => void savePref({ certReminder: v })}
              />
              {/* 提前天数只在提醒开着时可编辑，避免"看着能改其实不生效" */}
              {/* 未就绪 = 给组件传 disabled（复审 r2 A-1：原先在页面里糊一层「整行不可点」，鼠标点不动但键盘 Tab+Enter 仍能改值）；整行只留淡出观感 */}
              <div
                class="flex items-center justify-between gap-4 py-2"
                classList={{ "opacity-60": !prefReady() }}
              >
                <div>
                  <div class={`text-sm font-medium ${pref().certReminder ? "text-surface-700" : "text-surface-400"}`}>
                    提前提醒天数
                  </div>
                  <div class="text-xs text-surface-400 mt-0.5">到期日前多少天开始提醒（已过期未超同样天数内仍提醒）</div>
                </div>
                <SearchSelect
                  class="w-32"
                  compact
                  disabled={!prefReady()}
                  searchable={false}
                  ariaLabel="提前提醒天数"
                  options={CERT_DAY_OPTIONS}
                  value={String(pref().certReminderDays)}
                  matchTriggerWidth={false}
                  onChange={(v) => void savePref({ certReminderDays: Number(v) })}
                />
              </div>
            </div>
          </div>

          {/* v2.5.8（D11 / W6）：快捷键速查——**直读 `shortcuts.ts` 的声明表**，
              不在这里另写一份键位（ PLAN W6「设置页只读展示、不支持改键」的落地形态：
              表是唯一真相，加了键这条卡自动跟上，删了也不会留下过期文案） */}
          <div class="card card-glass p-6">
            <h2 class="text-lg font-semibold mb-2">快捷键</h2>
            <p class="text-sm text-surface-500 mb-4">应用内快捷键一览（暂不支持自定义改键）</p>
            <ul class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
              <For each={SHORTCUTS}>
                {(s) => (
                  <li class="flex items-baseline gap-2 text-sm">
                    <kbd class="shrink-0 px-1.5 py-0.5 rounded border border-surface-200 bg-surface-100 text-xs font-mono text-surface-700">
                      {comboLabel(s)}
                    </kbd>
                    <span class="text-surface-600">{s.desc}</span>
                  </li>
                )}
              </For>
              {/* v2.5.9 A6-1：全局键**不进** `SHORTCUTS` 声明表——那张表是渲染层应用内快捷键
                  （监听计数门禁钉死在 14 处），而这个是主进程 `globalShortcut` 注册的系统级键，
                  两码事。键位读 shared 常量，不在这里另写一份。 */}
              <li class="flex items-baseline gap-2 text-sm">
                <kbd class="shrink-0 px-1.5 py-0.5 rounded border border-surface-200 bg-surface-100 text-xs font-mono text-surface-700">
                  {WAKE_SEARCH_ACCELERATOR_LABEL}
                </kbd>
                <span class="text-surface-600">全局唤醒搜索（系统级，默认关；在「通用」里开启）</span>
              </li>
            </ul>
            <p class="text-xs text-surface-400 mt-3">
              另：Esc 关闭当前最上层（弹窗 / 菜单 / 下拉 / 浮条清空选择），方向键与 Enter/Tab 在各弹出层内导航。
            </p>
          </div>

          {/* v2.5.8（D3.5）：存储优化——去重巡检（2026-09-06 用户拍板：置于「通用」卡下方） */}

          <DedupSweepCard />

          {/* 标签管理 */}
          <div class="card card-glass p-6">
            <h2 class="text-lg font-semibold mb-2">标签管理</h2>
            <p class="text-sm text-surface-500 mb-4">统一管理标签颜色；重命名/删除会同步所有文件与产品集</p>

            {/* 新建标签 */}
            <div class="flex items-center gap-2 mb-4 flex-wrap">
              <Input
              class="w-36"
                placeholder="标签名称"
                value={newTagName()}
                onInput={(e) => setNewTagName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
              />
              {/* v2.5.8 D9（W4 控件统一 II）：新建标签行两处原生 select → SearchSelect（compact，
                  与同行色板按钮/输入框等高）；值口径不变（父级空串 ↔ null 的转换仍在 onChange 里）。 */}
              <SearchSelect
                class="min-w-[132px] md:w-52"
                compact
                ariaLabel="标签父级"
                options={[
                  { value: "", label: "顶层标签" },
                  ...topLevelTags().map((t) => ({ value: t.name, label: `作为 ${t.name} 的子标签` })),
                ]}
                value={newTagParent() ?? ""}
                placeholder="顶层标签"
                matchTriggerWidth={false}
                onChange={(v) => setNewTagParent(v || null)}
              />
              {/* v2.5.7（A3）：新建标签业务域选择（general = 全域） */}
              <SearchSelect
                class="min-w-[112px] md:w-36"
                compact
                ariaLabel="标签域"
                options={SCOPE_OPTIONS}
                value={newTagScope()}
                matchTriggerWidth={false}
                onChange={setNewTagScope}
              />
              <div class="flex items-center gap-1">
                <For each={PALETTE}>
                  {(c) => (
                    <button
                      class={`icon-btn w-5 h-5 rounded-full ${newTagColor() === c ? "ring-2 ring-offset-1 ring-surface-700 scale-110" : ""}`}
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
                          <span class="chip bg-primary-50 text-primary-600">
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
                                    class="icon-btn w-4 shrink-0 text-surface-400 hover:text-surface-700 cursor-pointer text-[10px] leading-none"
                                    title={expandedTopTags().includes(tag.name) ? "收起子标签" : "展开子标签"}
                                    onClick={() => toggleTopTag(tag.name)}
                                  >
                                    {expandedTopTags().includes(tag.name) ? "▼" : "▶"}
                                  </button>
                                </Show>
                                <button
                                  class="icon-btn w-5 h-5 rounded-full shrink-0 cursor-pointer"
                                  style={{ "background-color": tag.color }}
                                  title="点击改颜色"
                                  onClick={() => setEditingColor(editingColor() === tag.name ? null : tag.name)}
                                />
                        <Show when={editingColor() === tag.name}>
                          <div class="flex items-center gap-1">
                            <For each={PALETTE}>
                              {(c) => (
                                <button
                                  class={`icon-btn w-4 h-4 rounded-full ${tag.color === c ? "ring-2 ring-offset-1 ring-surface-700" : ""}`}
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
                          <Input
                            compact
                            class="flex-1 min-w-0"
                            ariaLabel="重命名标签"
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
                          {/* v2.5.8 D9：原生 `autofocus` + `onBlur` 收起 → SearchSelect 的
                              autoFocus + onClose（同一语义：挂载即聚焦、收起即退出内联编辑）。
                              尺寸吃统一档 compact，不再保留 text-xs 第三档（§五 不重新发明档位）。 */}
                          <SearchSelect
                            class="shrink-0"
                            compact
                            autoFocus
                            ariaLabel={`设置标签 ${tag.name} 的业务域`}
                            options={SCOPE_OPTIONS}
                            value={tag.scope ?? "general"}
                            matchTriggerWidth={false}
                            onChange={(v) => void handleSetScope(tag.name, v)}
                            onClose={() => setScopeEditing(null)}
                          />
                        </Show>
                        <span class="text-xs text-surface-400 shrink-0">{tag.count} 处</span>
                        <button
                          class="link-btn text-xs text-surface-500 hover:text-primary-600 shrink-0"
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
                              class="link-btn text-xs text-surface-500 hover:text-primary-600"
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
                                      class="row-btn w-full px-3 py-1.5 text-left text-sm hover:bg-surface-100"
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
                          class="link-btn text-xs text-danger-500 hover:text-danger-600 shrink-0"
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
                                    class="icon-btn w-4 h-4 rounded-full shrink-0 cursor-pointer"
                                    style={{ "background-color": child.color }}
                                    title="点击改颜色"
                                    onClick={() => setEditingColor(editingColor() === child.name ? null : child.name)}
                                  />
                                  <Show when={editingColor() === child.name}>
                                    <div class="flex items-center gap-1">
                                      <For each={PALETTE}>
                                        {(c) => (
                                          <button
                                            class={`icon-btn w-4 h-4 rounded-full ${child.color === c ? "ring-2 ring-offset-1 ring-surface-700" : ""}`}
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
                                    <Input
                                      compact
                                      class="flex-1 min-w-0"
                                      ariaLabel="重命名子标签"
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
                                    class="link-btn text-xs text-surface-500 hover:text-primary-600 shrink-0"
                                    title="提升为顶层标签"
                                    onClick={() => handlePromote(child.name)}
                                  >
                                    ⬆ 顶层
                                  </button>
                                  <button
                                    class="link-btn text-xs text-surface-500 hover:text-primary-600 shrink-0"
                                    onClick={() => {
                                      setRenaming(child.name);
                                      setRenameValue(child.name);
                                    }}
                                  >
                                    重命名
                                  </button>
                                  <button
                                    class="link-btn text-xs text-danger-500 hover:text-danger-600 shrink-0"
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
                        {/* 孤儿标签的「未定义」色点：**不是按钮**——没有 onClick，也不该有按压反馈。
                            原写成 button 标签是语义错（D14 清点时全站唯一一个无 onClick 的按钮），改成 span：
                            全站按钮基数因此 270 → 269，属**口径真实变化**，不是漏扫。
                            （措辞刻意不写尖括号标签名：JSX 注释里的标签字样会让 `grep -c` 与清点器对不上数。） */}
                        <span
                          class="w-5 h-5 rounded-full shrink-0 bg-surface-300 border border-dashed border-surface-400"
                          title="未定义标签"
                        />
                        <span class="text-sm font-medium flex-1 text-warning-800">{tag.name}</span>
                        <span class="text-xs text-surface-400 shrink-0">{tag.count} 处</span>
                        <Show when={adoptingOrphan() === tag.name}>
                          <div class="flex items-center gap-1">
                            <For each={PALETTE}>
                              {(c) => (
                                <button
                                  class="icon-btn w-4 h-4 rounded-full"
                                  style={{ "background-color": c }}
                                  onClick={() => handleAdopt(tag.name, c)}
                                />
                              )}
                            </For>
                          </div>
                        </Show>
                        <button
                          class="link-btn text-xs text-surface-500 hover:text-primary-600 shrink-0"
                          onClick={() => setAdoptingOrphan(adoptingOrphan() === tag.name ? null : tag.name)}
                        >
                          {adoptingOrphan() === tag.name ? "取消" : "转为正式标签"}
                        </button>
                        <button
                          class="link-btn text-xs text-danger-500 hover:text-danger-600 shrink-0"
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
          <div class="card card-glass p-6">
            <h2 class="text-lg font-semibold mb-4">命名模板</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">产品集前缀</label>
                <Input
                  type="text"
                  class="w-full"
                  value={config().naming_template.product_set_prefix}
                  onInput={(e) => updateNamingField("product_set_prefix", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">产品集后缀</label>
                <Input
                  type="text"
                  class="w-full"
                  value={config().naming_template.product_set_suffix}
                  onInput={(e) => updateNamingField("product_set_suffix", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">SKU 分隔符</label>
                <Input
                  type="text"
                  class="w-full"
                  value={config().naming_template.sku_separator}
                  onInput={(e) => updateNamingField("sku_separator", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">冲突后缀模板</label>
                <Input
                  type="text"
                  class="w-full"
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

          {/* v2.5.9（A9 刀4）：老工作区体检——打开本 tab 自动跑，只读。
              ⚠ 刻意**不做成新卡片、也不放按钮**：本仓有两道点着数的棘轮
              （`.card-glass` 浮层玻璃点位、按钮面三分类），新增任意一个都要用户点头才能动基线；
              而"打开设置就看到差额"本来就不需要按钮——自动跑更省一步，也不该为它单独申请基线。 */}
          <div class="mb-4">
            <HealthDriftSummary />
          </div>

          {/* v2.5.5：LAN 自动注册说明（PLAN §四 决策 3——子文件夹管理段可见性反馈） */}
          <p class="text-xs text-surface-400 mb-2">LAN 传输来的文件夹会自动加入对应清单（图包/证书/文档/客户），无需手动添加。</p>

          {/* Image Subfolders */}
          <div class="card card-glass p-6">
            <h2 class="text-lg font-semibold mb-4">图包子文件夹</h2>
            <p class="-mt-3 mb-3 text-xs text-surface-500">这里是<b>模板</b>：只决定"新建实体时默认建哪些文件夹"。某个实体里实际有哪些文件夹，看它自己页面上方那一排（以硬盘为准，v2.5.9）；在那个页面里新建/删除文件夹<b>不会</b>改到这里来。</p>
            <div class="flex gap-2 mb-4">
              <Input
                type="text"
                class="flex-1 min-w-0"
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
          <div class="card card-glass p-6">
            <h2 class="text-lg font-semibold mb-4">证书子文件夹</h2>
            <p class="-mt-3 mb-3 text-xs text-surface-500">这里是<b>模板</b>：只决定"新建实体时默认建哪些文件夹"。某个实体里实际有哪些文件夹，看它自己页面上方那一排（以硬盘为准，v2.5.9）；在那个页面里新建/删除文件夹<b>不会</b>改到这里来。</p>
            <div class="flex gap-2 mb-4">
              <Input
                type="text"
                class="flex-1 min-w-0"
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
          <div class="card card-glass p-6">
            <h2 class="text-lg font-semibold mb-4">客户子文件夹</h2>
            <p class="-mt-3 mb-3 text-xs text-surface-500">这里是<b>模板</b>：只决定"新建实体时默认建哪些文件夹"。某个实体里实际有哪些文件夹，看它自己页面上方那一排（以硬盘为准，v2.5.9）；在那个页面里新建/删除文件夹<b>不会</b>改到这里来。</p>
            <div class="flex gap-2 mb-4">
              <Input
                type="text"
                class="flex-1 min-w-0"
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
          <div class="card card-glass p-6">
            <h2 class="text-lg font-semibold mb-4">文档子文件夹</h2>
            <p class="-mt-3 mb-3 text-xs text-surface-500">这里是<b>模板</b>：只决定"新建实体时默认建哪些文件夹"。某个实体里实际有哪些文件夹，看它自己页面上方那一排（以硬盘为准，v2.5.9）；在那个页面里新建/删除文件夹<b>不会</b>改到这里来。</p>
            <div class="flex gap-2 mb-4">
              <Input
                type="text"
                class="flex-1 min-w-0"
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
          <div class="card card-glass p-6">
            <h2 class="text-lg font-semibold mb-4">供应商子文件夹</h2>
            <p class="-mt-3 mb-3 text-xs text-surface-500">这里是<b>模板</b>：只决定"新建实体时默认建哪些文件夹"。某个实体里实际有哪些文件夹，看它自己页面上方那一排（以硬盘为准，v2.5.9）；在那个页面里新建/删除文件夹<b>不会</b>改到这里来。</p>
            <div class="flex gap-2 mb-4">
              <Input
                type="text"
                class="flex-1 min-w-0"
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

          {/* v2.5.8（D3.5）：存储优化——去重巡检（已上移至「通用」下方） */}
          
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
