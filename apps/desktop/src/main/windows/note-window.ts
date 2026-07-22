import { BrowserWindow } from 'electron';
import { loadView, viewWebPreferences } from './view-helper';
import { clampRectToWorkArea, getWindowStateRaw, markCollapsed, trackWindowState } from './window-state';
import type { WinCal } from './window-state';
import { attachEdgeSnap, latticeStep, NOTE_MARGIN } from './snap';
import type { OtherNote, SnapHandle, SnapHooks } from './snap';
import { COLLAPSE_ANIM_MS } from '../../shared/anim';

/** 折叠成标题条时的窗口高度（DIP）：标题栏 32 + 上下透明边距 16×2（阴影留白） */
export const NOTE_COLLAPSED_HEIGHT = 64;
/** 展开态最小高度（DIP，与 minHeight 一致）：expanded 记忆高度低于它即视为脏数据 */
const NOTE_MIN_EXPANDED_HEIGHT = 160;
/** 新建便签默认高度（构造单位）：展开恢复遇脏数据高度时的回退目标 */
const NOTE_DEFAULT_HEIGHT = 420;

/** 各便签窗口的自校准参数（win.id → calibrate），折叠/展开做 构造单位↔DIP 换算用 */
const winCals = new Map<number, () => WinCal>();
/** 各便签窗口的吸附句柄（win.id → 权威物理尺寸），折叠/展开宽度物理锚定用 */
const snapHandles = new Map<number, SnapHandle>();

export interface NoteWindowOptions {
  noteId: string;
  index: number; // 用于新窗口的错位摆放（无位置记忆时）
  alwaysOnTop: boolean; // 置顶状态（来自笔记持久化的 pin）
  getOthers?: () => OtherNote[]; // 其他便签窗口（便签间磁铁/成组判定用；组过滤由调用方做）
  snapHooks?: SnapHooks; // 成组手势回调（stack-zone 高亮预告 + 松手成组）
  folder?: string; // 新建便签的落盘文件夹（随路由 query 下发给渲染进程）
}

/** 取窗口的吸附句柄：便签组 restack 走 animateTo（复用落位动画的格点量化纪律） */
export function getNoteSnapHandle(win: BrowserWindow): SnapHandle | undefined {
  return snapHandles.get(win.id);
}

/** 创建便签窗口：无边框、透明；进任务栏（不置顶时也能找回）、可最小化；
 *  有位置记忆则恢复原位，否则错位摆放；置顶与否由用户选择 */
export function createNoteWindow({ noteId, index, alwaysOnTop, getOthers, snapHooks, folder }: NoteWindowOptions): BrowserWindow {
  const saved = getWindowStateRaw(`note:${noteId}`);
  // 期望的构造参数（恢复的记忆值或默认错位摆放）；
  // 折叠记忆的窗口：saved.height 即折叠高度，最小尺寸/可缩放同步收紧
  const collapsed = saved?.collapsed === true;
  const ix = saved?.x ?? 120 + index * 30;
  const iy = saved?.y ?? 120 + index * 30;
  const iw = saved?.width ?? 320;
  const ih = saved?.height ?? (collapsed ? NOTE_COLLAPSED_HEIGHT : NOTE_DEFAULT_HEIGHT);

  const win = new BrowserWindow({
    x: ix,
    y: iy,
    width: iw,
    height: ih,
    minWidth: 220, // 最小尺寸：再小标题栏按钮就挤不下了
    minHeight: collapsed ? NOTE_COLLAPSED_HEIGHT : NOTE_MIN_EXPANDED_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop,
    skipTaskbar: false, // 所有便签都进任务栏，便于找回
    title: '新便签', // 渲染进程加载后会用便签标题覆盖
    resizable: !collapsed,
    minimizable: true,
    maximizable: false,
    show: false,
    webPreferences: viewWebPreferences(),
  });

  // 自校准：混合 DPI 下窗口显示到目标屏后 OS 会重缩放 DIP 尺寸（物理大小不变）。
  // 首次保存时量出 期望/报告 的比值 K 与位置偏移 C，之后保存按 K 还原，
  // 否则每轮 保存→恢复 尺寸都缩一级（150% 屏上是 ×2/3 滚雪球）。
  let cal: WinCal | null = null;
  const calibrate = (): WinCal => {
    if (!cal) {
      const d = win.getNormalBounds();
      // K 只接受常见 DPI 比例（100/125/150/175/200% 的正倒数），
      // 防止「用户第一次拖拽」被误判为 OS 重缩放（拖拽比例是任意值，会落回 1）
      const raw = d.width > 0 ? iw / d.width : 1;
      const RATIOS = [0.5, 2 / 3, 0.75, 0.8, 1, 1.25, 1.5, 1.75, 2];
      const snapped = RATIOS.find((r) => Math.abs(raw - r) / r < 0.025) ?? 1;
      if (snapped !== 1) {
        cal = { k: snapped, cx: ix - d.x * snapped, cy: iy - d.y * snapped };
      } else {
        cal = { k: 1, cx: 0, cy: 0 };
      }
      console.log(
        `[note] calibrate: win=${win.id} k=${cal.k} c=(${cal.cx.toFixed(1)},${cal.cy.toFixed(1)}) raw=${raw.toFixed(4)} report=(${d.x},${d.y} ${d.width}x${d.height}) expect=(${ix},${iy} ${iw}x${ih})`,
      );
    }
    return cal;
  };

  trackWindowState(`note:${noteId}`, win, calibrate);
  winCals.set(win.id, calibrate);
  // 完整落屏校正（会话恢复安全网）：winstate 只校验"与显示器相交"（露 1px
  // 即算可见），标题栏出屏 = 拖不回来。按真实 DIP bounds 把卡片钳进工作区；
  // ready-to-show 前完成，用户无感。卡片可贴屏幕边缘 = 透明边距允许出屏
  {
    const b = win.getBounds();
    const p = clampRectToWorkArea(b, NOTE_MARGIN);
    if (p.x !== b.x || p.y !== b.y) {
      win.setPosition(p.x, p.y);
      console.log(`[note] clamped into work area: (${b.x},${b.y}) -> (${p.x},${p.y})`);
    }
  }
  // 屏幕边缘 + 便签间磁铁吸附（含落位动画）；K 供动画帧目标量化到整数物理像素，
  // 句柄里的权威物理尺寸给折叠/展开做宽度锚定；snapHooks 接成组手势
  const snap = attachEdgeSnap(win, getOthers, () => calibrate().k, snapHooks);
  snapHandles.set(win.id, snap);
  // 窗口关闭统一清理：校准参数 / 吸附句柄 / 待提交几何定时器。
  // 只在建窗时注册一次——折叠等重复路径里再注册 closed 监听会逐次累积，
  // 超过 10 个触发 MaxListenersExceededWarning
  win.on('closed', () => {
    winCals.delete(win.id);
    snapHandles.delete(win.id);
    cancelCommit(win);
  });
  // 新建便签的落盘文件夹经路由 query 下发（HashRouter 下 useSearchParams 可读）
  loadView(win, `/note/${noteId}${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`);

  win.once('ready-to-show', () => win.show());
  return win;
}

/** 待提交的几何变更定时器（win.id → timeout），二次切换/窗口关闭时取消 */
const winCommitTimers = new Map<number, NodeJS.Timeout>();

function cancelCommit(win: BrowserWindow): void {
  const timer = winCommitTimers.get(win.id);
  if (timer) {
    clearTimeout(timer);
    winCommitTimers.delete(win.id);
  }
}

/** 折叠/展开便签窗口（渲染进程发起；折叠状态本身由渲染进程持久化到笔记数据）。
 *  折叠：记住当前展开尺寸 → 高度压到标题条（禁缩放）；展开：恢复记忆尺寸。
 *  bounds 持久化由 trackWindowState 的 resize 事件兜底，这里只维护 collapsed/expanded 标记。
 *
 *  单位纪律（血的教训，勿改）：winstate 存「构造单位」（≈物理像素，经自校准 K 换算），
 *  而 setBounds 吃的是 DIP。直接把存储值喂给 setBounds，在非 100% 屏上每折叠一次
 *  窗口就被放大 K 倍、写回存储、下次再乘——宽度滚雪球。因此：
 *  setBounds 一律用 getNormalBounds() 的当前 DIP 原生值；只有进出存储才过 K。
 *
 *  动画纪律（根治「动画缓慢变大」，勿改回逐帧）：窗口几何不做逐帧动画——
 *  每帧一次 DIP↔物理取整换算，分数坐标累积漂移。动画在渲染层用 CSS transition
 *  做（.is-collapse-anim），主进程只在动画首/尾提交**一次** setBounds：
 *  折叠在动画末提交（窗口保持大，卡片先卷起），展开在动画起点提交（卡片向下长入透明区）。
 *  提交几何全部量化到「干净格点」（latticeStep：物理量对齐 k 分子倍数时
 *  DIP↔物理换算为精确整数，报告值零通胀、渲染层不跳宽）；宽度用吸附侧
 *  权威物理值，提交后 commitAuthSize 直写意图尺寸并屏蔽报告回读。
 *  expanded 高度 < 展开最小高视为脏数据，回退新建默认高度。 */
export function setNoteWindowCollapsed(
  win: BrowserWindow,
  noteId: string,
  collapsed: boolean,
  /** 几何提交完成回调（便签组联动用）：展开在动画起点提交后触发，
   *  折叠在动画末提交后触发；幂等/自愈路径（几何未变）不触发 */
  onCommitted?: () => void,
): void {
  if (win.isDestroyed()) return;
  const key = `note:${noteId}`;
  const cal = winCals.get(win.id)?.() ?? { k: 1, cx: 0, cy: 0 };
  const dip = win.getNormalBounds(); // 当前 DIP：setBounds 的唯一合法输入
  const saved = getWindowStateRaw(key);
  // 幂等判定：展开态最小高度 160，任何 ≤ 折叠高度+ε 的窗口必处于折叠态
  const isCollapsedNow = dip.height <= NOTE_COLLAPSED_HEIGHT + 4;
  cancelCommit(win);
  // 宽度物理锚定 + 干净格点（与吸附落位同纪律）：优先吸附侧权威物理宽度，
  // 没有则报告值×K 后量化到格点。喂出的 DIP 全是精确整数，提交后零通胀
  const D = latticeStep(cal.k);
  const qz = (v: number) => Math.round(v / D) * D;
  const snapHandle = snapHandles.get(win.id);
  const widthPhys = snapHandle?.getAuthSize()?.w ?? qz(dip.width * cal.k);

  if (collapsed) {
    // 已是折叠态（重启恢复/渲染层加载时重放自愈）：几何不动，仅确保标记在。
    // 绝不能把当前 64px 记为 expanded——「展开后高度变得很小」就是
    // 状态脱钩时再点收起，把折叠高度写进了展开尺寸
    if (isCollapsedNow) {
      markCollapsed(key, true, saved?.expanded);
      return;
    }
    // 展开尺寸存构造单位（与 saveWindowState 同一换算），展开时除 K 还原
    const expanded = {
      x: Math.round(dip.x * cal.k + cal.cx),
      y: Math.round(dip.y * cal.k + cal.cy),
      width: Math.round(dip.width * cal.k),
      height: Math.round(dip.height * cal.k),
    };
    win.setMinimumSize(220, NOTE_COLLAPSED_HEIGHT);
    win.setResizable(false);
    markCollapsed(key, true, expanded); // 状态立即翻转
    // 动画末一次性提交几何：取提交时刻实时位置（期间用户可能拖动了窗口）
    const timer = setTimeout(() => {
      winCommitTimers.delete(win.id);
      if (win.isDestroyed()) return;
      const cur = win.getNormalBounds();
      const xPhys = qz(cur.x * cal.k);
      const yPhys = qz(cur.y * cal.k);
      const hPhys = qz(NOTE_COLLAPSED_HEIGHT * cal.k);
      win.setBounds({
        x: xPhys / cal.k,
        y: yPhys / cal.k,
        width: widthPhys / cal.k,
        height: hPhys / cal.k,
      });
      snapHandle?.commitAuthSize(widthPhys, hPhys); // 直写意图值，报告回读被屏蔽
      const rb = win.getBounds();
      console.log(
        `[note] collapse commit: win=${win.id} k=${cal.k} lattice=${D} intendedPhys=(${xPhys},${yPhys} ${widthPhys}x${hPhys}) reportPhys=(${Math.round(rb.x * cal.k)},${Math.round(rb.y * cal.k)} ${Math.round(rb.width * cal.k)}x${Math.round(rb.height * cal.k)})`,
      );
      onCommitted?.(); // 便签组联动：兄弟贴上新底缘（此时窗口已变矮，restack 读到真实几何）
    }, COLLAPSE_ANIM_MS);
    winCommitTimers.set(win.id, timer);
    // 关闭时的 timer 清理由建窗时统一注册的 closed 监听兜底，此处不再注册
  } else {
    // 已是展开态：no-op（渲染层加载时无条件重放 collapsed，命中这里即状态一致）
    if (!isCollapsedNow) return;
    // 位置/宽度不动（折叠只压高度），高度用构造单位（≈物理）直接量化。
    // 高度下限判定：历史脏数据可能把 expanded 记成不合常理的小值
    // （< 展开态最小高度，正常交互到不了），视为损坏，回退新建便签默认高度
    const restored = saved?.expanded?.height ?? 0;
    const useDefault = Math.round(restored / cal.k) < NOTE_MIN_EXPANDED_HEIGHT;
    const hPhys = useDefault ? qz(NOTE_DEFAULT_HEIGHT) : qz(restored);
    const xPhys = qz(dip.x * cal.k);
    const yPhys = qz(dip.y * cal.k);
    // 动画起点一次性提交几何：窗口先到位，卡片 CSS 动画向下长入（下方透明区 180ms）
    win.setBounds({
      x: xPhys / cal.k,
      y: yPhys / cal.k,
      width: widthPhys / cal.k,
      height: hPhys / cal.k,
    });
    snapHandle?.commitAuthSize(widthPhys, hPhys);
    const rb = win.getBounds();
    console.log(
      `[note] expand commit: win=${win.id} k=${cal.k} restored=${restored}${useDefault ? ' (default-fallback)' : ''} intendedPhys=(${xPhys},${yPhys} ${widthPhys}x${hPhys}) reportPhys=(${Math.round(rb.x * cal.k)},${Math.round(rb.y * cal.k)} ${Math.round(rb.width * cal.k)}x${Math.round(rb.height * cal.k)})`,
    );
    win.setMinimumSize(220, NOTE_MIN_EXPANDED_HEIGHT);
    win.setResizable(true);
    markCollapsed(key, false);
    onCommitted?.(); // 便签组联动：兄弟下移让位（与卡片 CSS 长入大致同步，160ms vs 180ms）
  }
}
