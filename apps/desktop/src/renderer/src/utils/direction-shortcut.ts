/** 仅在正文中完成一次纯 Ctrl+Shift 手势后切换；不抢占 Ctrl+Shift+V/Z 等组合。 */
export function bindDirectionShortcut(target: Window, change: (direction: 'ltr' | 'rtl') => void) {
  const controls = new Set<string>();
  let candidate: 'ltr' | 'rtl' | null = null;
  let blocked = false;
  const inEditor = (event: KeyboardEvent) => event.target instanceof Element &&
    !!event.target.closest('.ProseMirror[contenteditable="true"]');
  const reset = () => { controls.clear(); candidate = null; blocked = false; };
  const down = (event: KeyboardEvent) => {
    if (!inEditor(event) || event.altKey || event.metaKey || event.isComposing) {
      blocked = true; candidate = null; return;
    }
    if (event.code === 'ControlLeft' || event.code === 'ControlRight') controls.add(event.code);
    const modifier = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight'].includes(event.code);
    if (!modifier || controls.size > 1) { blocked = true; candidate = null; }
    if (!blocked && event.ctrlKey && event.shiftKey && controls.size === 1) {
      candidate = controls.has('ControlRight') ? 'rtl' : 'ltr';
    }
  };
  const up = (event: KeyboardEvent) => {
    if (candidate && !blocked && inEditor(event) && !event.altKey && !event.metaKey && !event.isComposing &&
      ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
      event.preventDefault();
      change(candidate);
      candidate = null;
    }
    controls.delete(event.code);
    if (!event.ctrlKey && !event.shiftKey) reset();
  };
  target.addEventListener('keydown', down, true);
  target.addEventListener('keyup', up, true);
  target.addEventListener('blur', reset);
  return () => {
    target.removeEventListener('keydown', down, true);
    target.removeEventListener('keyup', up, true);
    target.removeEventListener('blur', reset);
  };
}
