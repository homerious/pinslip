import { app, screen } from 'electron';
import type { BrowserWindow, Rectangle } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 窗口位置/尺寸记忆：JSON 存 userData/window-state.json。
 * key 规则：便签 `note:<id>`，主窗口 `main`。保存防抖 500ms。
 *
 * 存储单位说明（高分屏多显示器的血泪教训）：
 * Windows 混合 DPI（如主屏 100% + 副屏 150%）下，窗口跨屏显示时 OS 会按
 * WM_DPICHANGED 把 DIP 尺寸重缩放（物理大小不变），而 Electron 报的
 * scaleFactor 在某些机器上不可靠（误报 1）。若直接把"报告尺寸"存回去，
 * 每轮 保存→恢复 都会缩小一级，滚雪球。
 * 因此便签窗口使用「自校准」：建窗后量出 期望尺寸/报告尺寸 的比值 K 与
 * 位置偏移 C，之后保存一律按 K 还原为构造单位（约等于物理像素）。
 * 单屏 100% 时 K=1、C=0，无感知。主窗口固定尺寸走原 DIP 路径。
 */
export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 折叠成标题条（仅便签）：当前 height 为折叠高度，expanded 记展开时的 bounds */
  collapsed?: boolean;
  /** 折叠前的展开尺寸（构造单位）；展开后清除 */
  expanded?: { x: number; y: number; width: number; height: number };
}

/** 自校准参数：物理 ≈ 报告DIP × k + (cx, cy) */
export interface WinCal {
  k: number;
  cx: number;
  cy: number;
}

let cache: Record<string, WindowState> | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function statePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadAll(): Record<string, WindowState> {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Record<string, WindowState>;
  } catch {
    cache = {};
  }
  return cache;
}

function schedulePersist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(statePath(), JSON.stringify(loadAll(), null, 2));
    } catch {
      /* 磁盘写入失败不影响使用 */
    }
  }, 500);
}

/** 位置是否与任一显示器工作区相交（拔外接屏/改分辨率后防止窗口丢到屏外） */
function isVisible(s: WindowState): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      s.x < a.x + a.width && s.x + s.width > a.x && s.y < a.y + a.height && s.y + s.height > a.y
    );
  });
}

/** 便签用：原样读取存储值（构造单位，约等于物理像素），仅做可见性校验 */
export function getWindowStateRaw(key: string): WindowState | null {
  const s = loadAll()[key];
  if (!s || typeof s.x !== 'number' || typeof s.width !== 'number') return null;
  return isVisible(s) ? s : null;
}

/** 完整落屏钳制：把窗口矩形（DIP）按"内容区"（刨去透明边距 margin）钳进
 *  最近显示器工作区，返回钳制后的窗口左上角坐标。
 *  恢复安全网：isVisible 只校验相交（露 1px 即算可见），混合 DPI 换算/拔屏/
 *  位置漂移会把保存坐标攒到半屏外——标题栏出屏 = 窗口拖不回来。
 *  便签传 NOTE_MARGIN（卡片可以贴屏幕边缘 = 窗口透明边距允许出屏）；
 *  主窗口无透明边距传 0。内容区比屏还大时保顶/保左（操作区可见优先） */
export function clampRectToWorkArea(b: Rectangle, margin = 0): { x: number; y: number } {
  const area = screen.getDisplayNearestPoint({ x: b.x + margin, y: b.y + margin }).workArea;
  const cw = b.width - margin * 2;
  const ch = b.height - margin * 2;
  const cx = Math.min(Math.max(b.x + margin, area.x), Math.max(area.x, area.x + area.width - cw));
  const cy = Math.min(Math.max(b.y + margin, area.y), Math.max(area.y, area.y + area.height - ch));
  return { x: cx - margin, y: cy - margin };
}

/** 主窗口用：物理像素转 DIP（窗口构造参数语义） */
export function getWindowState(key: string): WindowState | null {
  const s = getWindowStateRaw(key);
  if (!s) return null;
  try {
    // window 传 null：按 rect 坐标自行判断所属显示器
    return screen.screenToDipRect(null, s);
  } catch {
    return s;
  }
}

/** 记录窗口当前位置/尺寸；cal 为便签自校准参数（无则按 DIP↔物理换算）。
 *  保留 entry 上的 collapsed/expanded 扩展字段（折叠功能），不被 bounds 覆盖 */
export function saveWindowState(key: string, win: BrowserWindow, cal?: WinCal | null): void {
  if (win.isDestroyed()) return;
  const dip = win.getNormalBounds();
  let physical: WindowState;
  if (cal) {
    physical = {
      x: Math.round(dip.x * cal.k + cal.cx),
      y: Math.round(dip.y * cal.k + cal.cy),
      width: Math.round(dip.width * cal.k),
      height: Math.round(dip.height * cal.k),
    };
  } else {
    try {
      physical = screen.dipToScreenRect(win, dip);
    } catch {
      physical = dip; // 换算失败回退 DIP（100% 缩放下两者相等）
    }
  }
  const prev = loadAll()[key];
  loadAll()[key] = { ...prev, ...physical };
  schedulePersist();
}

/** 标记便签折叠状态：折叠时记录展开尺寸（构造单位），展开时清除。
 *  bounds 本身由 trackWindowState 的 resize 事件按实际窗口保存 */
export function markCollapsed(
  key: string,
  collapsed: boolean,
  expanded?: { x: number; y: number; width: number; height: number },
): void {
  const all = loadAll();
  const prev = all[key];
  if (!prev) return;
  if (collapsed) {
    // expanded 未传时保留旧值（折叠幂等分支的透传），不覆盖已有记忆
    all[key] = { ...prev, collapsed: true, ...(expanded ? { expanded } : {}) };
  } else {
    const { expanded: _drop, ...rest } = prev;
    all[key] = { ...rest, collapsed: false };
  }
  schedulePersist();
}

/** 跟踪窗口的移动/缩放/关闭，自动持久化位置；getCal 在每次保存时取校准参数 */
export function trackWindowState(
  key: string,
  win: BrowserWindow,
  getCal?: () => WinCal | null,
): void {
  const save = () => saveWindowState(key, win, getCal?.());
  win.on('resize', save);
  win.on('move', save);
  win.on('close', save);
}
