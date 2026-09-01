# 启禾文件管理 v2.5.4 发布说明
> 归档时间：2026-09-01 · 归档原因：版本已被取代（发布说明保留当前版 RELEASE-2.5.7；docs-staleness-policy §三，用户批准归档）

> 版本：2.5.4 · 2026-08-22（08-23 局域网补丁并入，不升号）· 开源免费（Apache-2.0）
> 下载：官网 `https://www.qihebook.cloud/file-manager` · 源码 GitHub `lakeworld/filemanager`
> 本版为 **功能版本**：全业务新建通用预填 + 云桥 M3（供应商/报价双向）+ 插件协议真合并 + AI 助手宿主面 + 发票识别（AI 多模态填表）。**普通用户可见收益：发票「从文件识别」一键填表、插件能力统一预填入口、供应商档案双向同步**。

---

## 一、全业务新建通用预填（插件协议 §5.7）

- `window.qihebox.ui.openCreatePrefill(entity, payload)`：插件携带客户/产品集/供应商/报价单/发票/入库单 6 类实体的任意字段子集，跳转对应页面、打开新建弹窗并预填；批量传数组逐条确认（创建推进下一条 / 取消清空队列），单批 ≤50 条、按自然键去重
- **永不自动建档**：创建始终由用户在弹窗手点确认，保存校验完全复用各实体既有流程
- 编辑侧配套 `openEditPrefill(entity, key, payload)`：6 实体 × create/edit 全表单注册表（12 个表单全部可预填），编辑预填单条制，保存仍由用户手点
- 典型调用方：erp-bridge「仅云端可见」面板的「预填新建」（单条 + 多选批量）；AI/OCR 类识别插件复用同一入口（识别引擎在插件侧，宿主不内置 AI 推理）

## 二、云桥 M3：供应商 / 报价（弹一）

- 新增 `suppliers` 能力域：`host.supplier` 的 `list`（增量 since）/`get`/`writeErpExt`/`syncProfile`——供应商档案双向同步；`manifest.permissions.suppliers` 独立权限位；宿主事件 +2（`supplierCreated` / `supplierUpdated`）
- 新增 `quote` 只读域：`host.quote.list(since)/get(quotation_no)` 报价台账只读投影，**无写方法**——报价建档仍走预填桥手动确认
- 协议真合并（C-5）：`makeEntityDomain` 泛型工厂合一 customer/supplier 域 + `EntityProfile` 基型同源；share 域 legacy 标注

## 三、AI 助手宿主面（弹二，插件 com.qihe.cloud）

- 插件侧 AI 聊天面板（独立双栏页 `/plugin/cloud-ai`）；本体零 `src/` 改动——AI 推理/网络/凭据全部在插件与云端，红线合规
- AI 工具面（boxCli）19 个白名单 op，**无任何写类 op，保存永远由用户在弹窗手点**；AI 视角默认脱敏（手机号/邮箱打码）
- 生命周期纪律：首个 chat 才拉起 worker/网关（零常驻）、单条消息锁、崩溃退避、登出/dispose 成对清理

## 四、发票识别（AI 多模态填表，插件 com.qihe.cloud）

- 新建发票弹窗「从文件识别」按钮：图片/截图/扫描图或文字层数电票 PDF → 识别插件本地预处理（图片缩放 / PDF 抽文字）→ 云端 AI 代理 → 阶跃 step-3.7-flash 多模态识别 → 字段白名单回填 → **识别成功即复制归档**入 `发票/年份/`；重复发票号拦截落账；识别能力全在插件，本体零 AI

## 五、局域网补丁（2026-08-23，插件 com.qihe.lan v0.2.3）

- share 域新增 `ensureSubfolder(kind, holder, name)`：插件目录拉取后把第一层子文件夹注册进工作区白名单，宿主面板免手动「新建子文件夹」即显示拉取的 sku/白底等目录；旧宿主兼容静默跳过

## 六、测试与门禁

- 单测 **783 / 55 文件** / e2e **144 / 34 文件**（插件宿主 8 个 zz-* e2e 迁至插件私有仓后重定基线）/ 双 tsc 零错误 / 构建通过 / 一致性套件独立口径 / 内存 soak 独立口径
- 插件侧单测 **507**（LAN 259 + erp-bridge 67 + cloud 181），conformance 全项绿
- 内存基线沿用 v2.5.3 实测三态（醒着 485 / 托盘常驻 484 / 自启 282 MiB，2026-08-19 复测）；本版命中性能触发面时按 PERF-SOP 实测，热态内存基线挂账随巡更跟进

## 七、下一步（路线预告）

- **v2.6**：局域网协作（官方插件 `com.qihe.lan`：发现配对 / 只读共享 / 1:1 与群聊）
- **v2.7**：官方插件索引 + AI/OCR/erp-bridge 插件化业务 + `transport='process'` 进程隔离（协议已预留）
