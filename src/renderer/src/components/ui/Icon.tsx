/**
 * 图标底座（v2.5.1 T2，D9）：零依赖内联 SVG——stroke 风格、24 viewBox、currentColor、fill none。
 * 清单：T2 按 Sidebar 导航 + 高频操作定稿（导航/新建/删除/编辑/搜索/关闭/下载/筛选/返回/更多/复制/移动/打标/压缩/解压/刷新/保存/文件夹/文件/图片/视频/文档/证书/客户/供应商/报价/发票/设置/帮助/回收站/导出/插件/仪表盘）。
 * 使用：<Icon name="search" class="w-4 h-4" />
 * Solid 纪律（D11）：禁解构 props。
 */

type IconName =
  | "dashboard"
  | "productSets"
  | "images"
  | "certs"
  | "docs"
  | "customers"
  | "suppliers"
  | "quotes"
  | "invoices"
  | "search"
  | "exports"
  | "trash"
  | "settings"
  | "profile"
  | "plugins"
  | "help"
  | "plus"
  | "trash"
  | "edit"
  | "close"
  | "download"
  | "filter"
  | "back"
  | "more"
  | "refresh"
  | "save"
  | "folder"
  | "file"
  | "image"
  | "video";

const PATHS: Record<string, string> = {
  dashboard: "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z",
  productSets: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  images: "M4 16l4.586-4.586a2 2 0 0 1 2.828 0L16 16m-2-2 1.586-1.586a2 2 0 0 1 2.828 0L20 14M4 20h16a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1zM14 8h.01",
  certs: "M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z",
  docs: "M7 21h10a2 2 0 0 0 2-2V9.414a1 1 0 0 0-.293-.707l-5.414-5.414A1 1 0 0 0 12.586 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2zm3-9h4m-4 4h4M9 3v6h6",
  customers: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2m9-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8 10v-2a4 4 0 0 0-3-3.87m-4-12.13a4 4 0 0 1 0 7.75",
  suppliers: "M16 11V7a4 4 0 0 0-8 0v4m-2 0a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2H6z",
  quotes: "M9 12h6m-6 4h6m-8-8h.01M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
  invoices: "M9 17H7m10 0h-2m-8-4h10m-10-4h6m3 11H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l6 6v10a2 2 0 0 1-2 2z",
  search: "M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z",
  exports: "M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  trash: "M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16",
  settings: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  profile: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7z",
  plugins: "M17 14v6m-3-3h6M14 7a3 3 0 1 0-6 0 3 3 0 0 0 6 0zm-4 5v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2h2m6-3h2a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-2",
  help: "M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  plus: "M12 4v16m8-8H4",
  edit: "M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5m-1.414-9.414a2 2 0 1 1 2.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
  close: "M6 18L18 6M6 6l12 12",
  download: "M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2m-4-4-4 4m0 0-4-4m4 4V4",
  filter: "M3 5h18l-7 8v6l-4 2v-8L3 5z",
  back: "M15 19l-7-7 7-7",
  more: "M12 5h.01M12 12h.01M12 19h.01M5 12h.01M19 12h.01",
  refresh: "M4 4v5h5M20 20v-5h-5M20 9a8 8 0 0 0-14.32-3.55M4 15a8 8 0 0 0 14.32 3.55",
  save: "M8 7H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3m-1-2v6H9V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z",
  file: "M7 3h7l6 6v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm7 0v6h6",
  image: "M4 16l4.586-4.586a2 2 0 0 1 2.828 0L16 16m-2-2 1.586-1.586a2 2 0 0 1 2.828 0L20 14M4 20h16a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1zM14 8h.01",
  video: "M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14M5 18h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z",
};

interface IconProps {
  name: IconName;
  class?: string;
}

export default function Icon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={2}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class ?? "w-4 h-4"}
      aria-hidden="true"
    >
      <path d={PATHS[props.name] ?? PATHS.file} />
    </svg>
  );
}
