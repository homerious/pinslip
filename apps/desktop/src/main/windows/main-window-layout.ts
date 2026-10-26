import { app, screen } from 'electron';
import type { BrowserWindow, Display, Rectangle } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SIZE = { width: 320, height: 600 }; // 构造单位，不能直接传 setBounds。
const MIN_SIZE = { width: 280, height: 400 }; // 运行中的约束为 DIP。
const SETTLE_MS = 300;

interface Layout {
  version: 1;
  size: { width: number; height: number }; // 权威构造尺寸，人工缩放才改变。
  display: { id: number; workArea: Rectangle; scaleFactor: number };
  position: { x: number; y: number }; // 正常 DIP 矩形在工作区可移动范围内的比例。
}

const filePath = (): string => path.join(app.getPath('userData'), 'manager-layout.json');
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readLayout(): Layout | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as Layout;
    const { size, display, position } = value;
    if (value.version !== 1 || !size || !display || !position) return null;
    if (![size.width, size.height].every((n) => finite(n) && n > 0 && n <= 100_000)) return null;
    if (![position.x, position.y].every((n) => finite(n) && n >= 0 && n <= 1)) return null;
    if (!finite(display.id) || !finite(display.scaleFactor) || display.scaleFactor <= 0) return null;
    if (!display.workArea || ![display.workArea.x, display.workArea.y, display.workArea.width, display.workArea.height].every(finite)
      || display.workArea.width <= 0 || display.workArea.height <= 0) return null;
    return value;
  } catch { return null; }
}

export function clearMainWindowLayout(): void {
  try { fs.rmSync(filePath(), { force: true }); } catch { /* 不影响当前窗口。 */ }
}

function positionInArea(b: Rectangle, area: Rectangle): Layout['position'] {
  const ratio = (offset: number, free: number): number => free <= 0 ? 0 : Math.min(1, Math.max(0, offset / free));
  return { x: ratio(b.x - area.x, area.width - b.width), y: ratio(b.y - area.y, area.height - b.height) };
}

/** 主窗口独立布局控制器，不进入便签 winstate；无人工调整时绝不循环回写报告尺寸。 */
export class MainWindowLayout {
  readonly initialBounds: Rectangle;
  private win: BrowserWindow | null = null;
  private size = { ...DEFAULT_SIZE };
  private display: Display;
  private position: Layout['position'] | null;
  private kx = 1;
  private ky = 1;
  private ready = false;
  private suspended = false;
  private resetting = false;
  private pendingMove = false;
  private pendingResize = false;
  private timer: NodeJS.Timeout | null = null;
  private systemTimer: NodeJS.Timeout | null = null;

  constructor(private enabled: boolean) {
    const saved = enabled ? readLayout() : null;
    const originalDisplay = saved && screen.getAllDisplays().find((d) => d.id === saved.display.id);
    this.display = originalDisplay || screen.getPrimaryDisplay();
    this.position = originalDisplay && saved ? saved.position : null;
    if (saved) this.size = { ...saved.size };
    const area = this.display.workArea;
    // 在建原生窗前限制异常大值，避免先分配巨大窗口再落屏。
    this.size.width = Math.min(this.size.width, Math.round(area.width * Math.max(1, this.display.scaleFactor)));
    this.size.height = Math.min(this.size.height, Math.round(area.height * Math.max(1, this.display.scaleFactor)));
    this.initialBounds = { ...this.size, x: area.x, y: area.y };
  }

  bind(win: BrowserWindow): void {
    this.win = win;
    const mark = (resize: boolean): void => {
      if (!this.ready || this.resetting || win.isMinimized()) return;
      if (this.suspended) {
        if (process.platform === 'linux') return;
        // will-* 明确是人工动作，事件发生在新尺寸应用前；不丢启动后立即拖动。
        if (this.systemTimer) clearTimeout(this.systemTimer);
        this.systemTimer = null;
        this.calibrate();
        this.suspended = false;
      }
      this.pendingMove = true;
      this.pendingResize ||= resize;
      this.schedule();
    };
    win.on('will-move', () => mark(false));
    win.on('will-resize', () => mark(true));
    const changed = (resize: boolean): void => {
      if (process.platform === 'linux') mark(resize); // Linux 没有人工 will 事件。
      else if (this.pendingMove || this.pendingResize) this.schedule();
    };
    win.on('move', () => changed(false));
    win.on('resize', () => changed(true));
    win.on('hide', () => this.flush());
    win.on('show', () => {
      if (!this.ready || this.resetting) return;
      // 隐藏期间 OS 可能改变 DPI；只重校准，不重新套用保存布局或回写尺寸。
      this.suspended = true;
      this.resumeAfterSystemChange();
    });
    win.on('close', () => this.flush());
    win.on('minimize', () => this.flush());
    win.on('closed', () => {
      this.cancelPending();
      if (this.systemTimer) clearTimeout(this.systemTimer);
      screen.removeListener('display-added', this.screenChanged);
      screen.removeListener('display-removed', this.screenChanged);
      screen.removeListener('display-metrics-changed', this.screenChanged);
      this.win = null;
    });
    screen.on('display-added', this.screenChanged);
    screen.on('display-removed', this.screenChanged);
    screen.on('display-metrics-changed', this.screenChanged);
  }

  /** ready-to-show 时先校准/落屏再显示；延迟系统事件不作为人工变化保存。 */
  initialize(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.calibrate();
    this.suspended = true;
    this.fit(this.display, this.position);
    this.ready = true;
    this.resumeAfterSystemChange();
  }

  private calibrate(): void {
    if (!this.win) return;
    const b = this.win.getNormalBounds();
    if (b.width > 0 && b.height > 0) {
      // 分轴校准兼容系统边框。校准仅影响下一次人工尺寸变化，不反向改权威值。
      this.kx = this.size.width / b.width;
      this.ky = this.size.height / b.height;
    }
  }

  private fit(display: Display, position: Layout['position'] | null, desired?: Rectangle): void {
    if (!this.win) return;
    const win = this.win;
    const area = display.workArea;
    const b = desired ?? win.getNormalBounds();
    const width = Math.round(Math.min(area.width, Math.max(Math.min(MIN_SIZE.width, area.width), b.width)));
    const height = Math.round(Math.min(area.height, Math.max(Math.min(MIN_SIZE.height, area.height), b.height)));
    const x = Math.round(area.x + (position ? position.x * Math.max(0, area.width - width) : Math.max(0, area.width - width - 12)));
    const y = Math.round(area.y + (position ? position.y * Math.max(0, area.height - height) : Math.max(0, area.height - height - 12)));
    win.setMinimumSize(Math.min(MIN_SIZE.width, area.width), Math.min(MIN_SIZE.height, area.height));
    const current = win.getNormalBounds();
    if (current.x !== x || current.y !== y || current.width !== width || current.height !== height) {
      win.setBounds({ x, y, width, height }); // 全部是正常 DIP，禁止使用存储尺寸直接提交。
    }
    if (width !== b.width) this.size.width = Math.round(width * this.kx);
    if (height !== b.height) this.size.height = Math.round(height * this.ky);
    this.display = display;
    this.position = positionInArea({ x, y, width, height }, area);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SETTLE_MS);
  }

  private cancelPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingMove = false;
    this.pendingResize = false;
  }

  flush(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.ready || this.suspended || (!this.pendingMove && !this.pendingResize)) return;
    const b = win.getNormalBounds();
    const display = screen.getDisplayMatching(b);
    if (display.id !== this.display.id && !this.pendingResize) this.calibrate();
    if (this.pendingResize) {
      if (display.id !== this.display.id) {
        // 跨屏同时缩放：用已校准比例乘屏幕比例变化，不把当前新尺寸误当旧意图校准。
        const ratio = display.scaleFactor / this.display.scaleFactor;
        this.kx *= ratio;
        this.ky *= ratio;
      }
      this.size = { width: Math.round(b.width * this.kx), height: Math.round(b.height * this.ky) };
    }
    this.display = display;
    this.position = positionInArea(b, display.workArea);
    this.cancelPending();
    this.persist();
  }

  setEnabled(enabled: boolean): void {
    this.flush();
    this.enabled = enabled;
    if (enabled) {
      if (this.ready && this.win) {
        this.position = positionInArea(this.win.getNormalBounds(), this.display.workArea);
        this.persist();
      }
    } else {
      this.cancelPending();
      clearMainWindowLayout();
    }
  }

  private persist(): void {
    if (!this.enabled || !this.position) return;
    const value: Layout = { version: 1, size: { ...this.size }, position: this.position,
      display: { id: this.display.id, workArea: this.display.workArea, scaleFactor: this.display.scaleFactor } };
    try { fs.writeFileSync(filePath(), JSON.stringify(value, null, 2)); } catch { /* 不影响使用。 */ }
  }

  private resumeAfterSystemChange(): void {
    if (this.systemTimer) clearTimeout(this.systemTimer);
    this.systemTimer = setTimeout(() => {
      this.systemTimer = null;
      if (!this.win || this.win.isDestroyed()) return;
      this.calibrate();
      this.suspended = false;
    }, SETTLE_MS);
  }

  private screenChanged = (): void => {
    if (!this.ready || !this.win || this.win.isDestroyed()) return;
    this.cancelPending();
    this.suspended = true;
    if (this.systemTimer) clearTimeout(this.systemTimer);
    this.systemTimer = setTimeout(() => {
      if (!this.win || this.win.isDestroyed()) return;
      const display = screen.getAllDisplays().find((d) => d.id === this.display.id);
      this.calibrate(); // 系统 DPI 调整后仍以原权威尺寸为锚。
      this.fit(display ?? screen.getPrimaryDisplay(), display ? this.position : null);
      this.resumeAfterSystemChange();
    }, SETTLE_MS);
  };

  async reset(): Promise<void> {
    const win = this.win;
    if (!win || win.isDestroyed()) { clearMainWindowLayout(); return; }
    this.cancelPending();
    this.resetting = true;
    this.suspended = true;
    if (this.systemTimer) clearTimeout(this.systemTimer);
    const display = screen.getPrimaryDisplay();
    if (win.isMinimized()) win.restore();
    // 先进入主屏，再等 OS 的 DPI 调整；不能把副屏校准参数直接用于主屏。
    win.setPosition(display.workArea.x, display.workArea.y);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (win.isDestroyed()) return;
    this.calibrate();
    this.size = { ...DEFAULT_SIZE };
    const dip = { x: display.workArea.x, y: display.workArea.y,
      width: Math.round(this.size.width / this.kx), height: Math.round(this.size.height / this.ky) };
    this.fit(display, null, dip);
    this.calibrate();
    if (this.enabled) this.persist();
    else clearMainWindowLayout();
    this.resetting = false;
    this.resumeAfterSystemChange();
  }
}
