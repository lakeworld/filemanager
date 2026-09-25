import { createSignal, createEffect, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import Modal from "~/components/ui/Modal";
import ConfirmDialog from "~/components/ConfirmDialog"; // v2.5.5（B1-B）：脏守卫二次确认
import Input from "~/components/ui/Input";
import Textarea from "~/components/ui/Textarea";
import TagInput from "~/components/TagInput";
import { api } from "~/wails/api";
import { showToast } from "~/stores/notifyBanner";
import { tagList } from "~/stores/tags";
import { defaultWorkspaceConfig, workspaceConfig } from "~/stores/workspace";
import type { ProductSetCreateRequest } from "~/types";
import type { ProductSetPrefill } from "~/stores/createPrefillNormalize";
import { currentTemplateLabel, placeholderFor } from "../../../../shared/industryTemplates";

/**
 * 新建产品集弹窗（v2.5.1 T3 波2 拆分 + overlay→Modal 迁移）：
 * 字段信号与提交逻辑从 ProductSets.tsx 纯搬迁；成功回调 onCreated。
 * v2.5.4 预填（内部设计文档 §3.4）：可选 initial + onCancel（语义同 CreateClientModal）。
 * v2.5.9 A6-3：`onCreated(name)` 带出新建的名字——调用方据此**直接进详情**（`/product-sets/<name>`）；
 * 不带名字时调用方只能停在列表页（旧行为），那是本次要修的用户体验缺口。
 */
export default function CreatePsModal(props: {
  open: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
  initial?: ProductSetPrefill | null;
  onCancel?: () => void;
}) {
  const [newPsName, setNewPsName] = createSignal("");
  const [newPsTags, setNewPsTags] = createSignal<string[]>([]);
  const [newPsNotes, setNewPsNotes] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  // v2.5.5（B1-B）：脏守卫——打开时表单初值快照 + 确认弹窗开关
  const [snapshot, setSnapshot] = createSignal<Record<string, unknown> | null>(null);
  const [discardOpen, setDiscardOpen] = createSignal(false);
  // v2.6.1：点「设置 → 文件夹模板」链接后，若表单已脏——先走放弃确认，确认后才关弹窗并跳转
  const [gotoSettingsAfterClose, setGotoSettingsAfterClose] = createSignal(false);
  const navigate = useNavigate();

  // —— v2.6.1：提示块（PLAN §五.4 A 版逐字 + 三清单预览）+ placeholder 跟模板 ——
  // config 尚未从磁盘加载时用渲染层默认值兜底（默认值现与主进程同词表 = 电商），不再出现"空清单预览"。
  const cfg = () => workspaceConfig() ?? defaultWorkspaceConfig();
  /** 当前模板展示名（未命中 = 「自定义」）——与设置页徽标同一派生口径 */
  const tplLabel = () => currentTemplateLabel(cfg());

  // 打开时 seed（有 initial 预填，无则清空防残留；依赖 open 与 initial 引用，同客户弹窗）
  createEffect(() => {
    if (!props.open) return;
    const init = props.initial;
    const seeded = { name: init?.name ?? "", tags: init?.tags ?? [], notes: init?.notes ?? "" };
    setNewPsName(seeded.name);
    setNewPsTags(seeded.tags);
    setNewPsNotes(seeded.notes);
    setSnapshot(seeded); // v2.5.5（B1-B）：脏守卫初始快照
    setDiscardOpen(false);
  });

  /** v2.5.5（B1-B）：脏判定 = 表单字段相对打开快照有改动 */
  const dirty = () => {
    const snap = snapshot();
    if (!snap) return false;
    return (
      newPsName() !== snap.name ||
      newPsNotes() !== snap.notes ||
      JSON.stringify(newPsTags()) !== JSON.stringify(snap.tags)
    );
  };

  /** 关闭请求：dirty → 弹「放弃未保存内容？」；否则直关（取消按钮与遮罩/Esc 同路） */
  const requestClose = () => {
    if (discardOpen()) return; // 确认弹窗打开期间防叠加触发
    if (dirty()) setDiscardOpen(true);
    else realClose();
  };

  /** 真实关闭（放弃修改确认后 / 非 dirty）：清确认态 + 走 onCancel/onClose；
   *  v2.6.1：确认为「去设置里换模板」这条路的，关完再跳 `/settings?tab=folders`。 */
  const realClose = () => {
    setDiscardOpen(false);
    (props.onCancel ?? props.onClose)();
    if (gotoSettingsAfterClose()) {
      setGotoSettingsAfterClose(false);
      navigate("/settings?tab=folders");
    }
  };

  /** v2.6.1：提示块里的「设置 → 文件夹模板」是可点链接（不是纯文本）——关弹窗 → 落「文件夹模板」页签。
   *  脏表单先过既有的放弃确认（不静默丢用户敲了一半的名字）。 */
  const goFoldersTab = () => {
    if (dirty()) {
      setGotoSettingsAfterClose(true);
      setDiscardOpen(true);
      return;
    }
    realClose();
    navigate("/settings?tab=folders");
  };

  const handleCreate = async () => {
    if (saving()) return;
    const name = newPsName().trim();
    if (!name) return;
    setSaving(true);
    const req: ProductSetCreateRequest = {
      name,
      tags: newPsTags(),
      notes: newPsNotes().trim(),
    };
    const result = await api.productSets.create(req);
    setSaving(false);
    if (result.success) {
      setNewPsName("");
      setNewPsTags([]);
      setNewPsNotes("");
      props.onClose();
      props.onCreated(name);
    } else {
      showToast("error", "创建失败", result.error || "未知错误");
    }
  };

  return (
    <Show when={props.open}>
      <>
        <Modal
          open
          title="新建产品集"
          subtitle="名称即产品集文件夹名，图包 / 证书 / 文档都挂在它下面"
          size="lg"
          framed
          onClose={realClose}
          // v2.5.5（B1-B）：脏守卫——dirty 时遮罩/Esc 走 onCloseRequest（二次确认）
          dirty={dirty()}
          onCloseRequest={requestClose}
          footer={
            <>
              {/* v2.5.5（B1-B）：取消与遮罩/Esc 同路——dirty 时走 requestClose（二次确认） */}
              <button class="btn-secondary" onClick={requestClose}>取消</button>
              <button class="btn-primary" disabled={saving()} onClick={() => void handleCreate()}>
                {saving() ? "创建中..." : "确认创建"}
              </button>
            </>
          }
        >
          {/* v2.6.1：显眼提示块（PLAN §五.4 A 版逐字）——实底主色块（弹窗内禁半透明白底，
              不用 Invoices banner 的 bg-primary-50/40）；无 emoji（新增码位要重生成 woff2，不划算）。
              「设置 → 文件夹模板」是可点链接：关弹窗 → /settings?tab=folders（脏表单先过放弃确认）。 */}
          <div class="rounded-lg border border-primary-200 bg-primary-50 px-3 py-2.5 mb-4 text-sm text-primary-800">
            <p class="font-medium">
              文件夹名按当前模板（{tplLabel()}）生成。不合你们的项目？到<button class="link-btn text-primary-700 hover:text-primary-800 hover:underline" onClick={goFoldersTab}>「设置 → 文件夹模板」</button>换一套或自己改——只影响以后新建的产品集。
            </p>
            <p class="mt-1 text-xs text-primary-700">
              会建：图包〔{cfg().image_subfolders.join(" · ")}〕证书〔{cfg().cert_subfolders.join(" · ")}〕文档〔{(cfg().doc_subfolders ?? []).join(" · ")}〕
            </p>
          </div>
          <div class="dlg-field">
            <label class="dlg-label dlg-required" aria-required="true">产品集名称</label>
            <Input value={newPsName()} placeholder={placeholderFor(cfg())} onInput={(e) => setNewPsName(e.currentTarget.value)} class="w-full" />
          </div>
          <div class="dlg-field">
            <label class="dlg-label">标签<span class="dlg-hint">（建议从已定义标签中选择）</span></label>
            <TagInput value={newPsTags()} onChange={setNewPsTags} options={tagList()} placeholder="如：客户、重点" scope="product_set" />
          </div>
          <div class="dlg-field">
            <label class="dlg-label">备注</label>
            <Textarea value={newPsNotes()} rows={3} placeholder="添加备注..." onInput={(e) => setNewPsNotes(e.currentTarget.value)} class="w-full" />
          </div>
        </Modal>
        {/* v2.5.5（B1-B）：脏守卫「放弃未保存内容？」二次确认（独立 Modal 叠层） */}
        <Show when={discardOpen()}>
          <ConfirmDialog
            title="放弃未保存内容？"
            message="该弹窗有未保存的修改，放弃后将不会保存任何内容。"
            confirmLabel="放弃修改"
            cancelLabel="继续编辑"
            danger
            onConfirm={realClose}
            onCancel={() => {
              setGotoSettingsAfterClose(false); // 「继续编辑」= 不走跳转（v2.6.1）
              setDiscardOpen(false);
            }}
          />
        </Show>
      </>
    </Show>
  );
}
