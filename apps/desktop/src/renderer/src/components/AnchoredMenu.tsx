import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuAnchor { element: HTMLElement; x?: number; y?: number }

/** 使用便签现有菜单样式，在按钮附近展开，避免卡片裁切及窗口边缘溢出。 */
export default function AnchoredMenu({ anchor, label, className = '', children, onClose }: {
  anchor: MenuAnchor;
  label: string;
  className?: string;
  children: ReactNode;
  onClose(): void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(true);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const place = useCallback(() => {
    const menu = menuRef.current;
    if (!menu || !anchor.element.isConnected || !anchor.element.getClientRects().length) { onClose(); return; }
    const rect = anchor.element.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const x = anchor.x ?? rect.left;
    const above = rect.top - size.height - 4;
    const y = anchor.y ?? (above >= 8 ? above : rect.bottom + 4);
    const next = { left: Math.max(8, Math.min(x, innerWidth - size.width - 8)),
      top: Math.max(8, Math.min(y, innerHeight - size.height - 8)) };
    setPosition(previous => previous.left === next.left && previous.top === next.top ? previous : next);
  }, [anchor.element, anchor.x, anchor.y, onClose]);
  // 父视图重排工具栏后重新量位置；仅几何变化才更新状态。
  useLayoutEffect(() => { place(); });
  useLayoutEffect(() => {
    const menu = menuRef.current!;
    restoreFocus.current = true;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node) && !anchor.element.contains(event.target as Node)) {
        restoreFocus.current = false; onClose();
      }
    };
    const dismiss = () => { restoreFocus.current = false; onClose(); };
    const scroll = (event: Event) => { if (!menu.contains(event.target as Node)) dismiss(); };
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('transitionend', place, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('transitionend', place, true);
      if (restoreFocus.current && anchor.element.isConnected) anchor.element.focus({ preventScroll: true });
    };
  }, [anchor.element, onClose, place]);
  return createPortal(<div ref={menuRef} className={`sticky-note__menu anchored-menu ${className}`} role="menu" aria-label={label}
    style={position} onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      const buttons = Array.from(menuRef.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); buttons[current]?.click(); }
      else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); }
      else if (buttons.length && ['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
      }
    }}>{children}</div>, document.body);
}
