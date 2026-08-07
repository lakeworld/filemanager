export default function Logo(props: { class?: string }) {
  return (
    <svg
      class={props.class || "w-6 h-6"}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Blue rounded-rect background */}
      <rect width="512" height="512" rx="102" fill="#0873c9" />

      {/* White "启" character, centered */}
      <text
        x="256"
        y="256"
        text-anchor="middle"
        dominant-baseline="central"
        fill="white"
        font-family="'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif"
        font-weight="bold"
        font-size="280"
      >
        启
      </text>
    </svg>
  );
}
