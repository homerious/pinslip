/**
 * Logo 同款图钉（临摹 resources/icon.png 顶部红钉：圆头 + 短针 + 高光点）。
 * 用 currentColor 着色——置顶按钮红/灰、色条选中标记红，都是它。
 * 外层 CSS 按 `.sticky-note__btn svg` 等规则统一控制尺寸。
 */
export default function PinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" className={className} aria-hidden="true">
      {/* 针：圆头下方的短锥 */}
      <path d="M7.05 7.8h1.9l-.35 6.7h-1.2z" fill="currentColor" />
      {/* 圆头 */}
      <circle cx="8" cy="5" r="4.2" fill="currentColor" />
      {/* 高光：红色/深色着色时自然透出，灰色时几乎不可见 */}
      <circle cx="6.4" cy="3.5" r="1.3" fill="#fff" opacity="0.35" />
    </svg>
  );
}
