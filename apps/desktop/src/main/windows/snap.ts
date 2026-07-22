import { screen } from 'electron';
import type { BrowserWindow, Rectangle } from 'electron';

/**
 * 屏幕边缘吸附 + 便签间磁铁：拖动便签靠近/越出工作区边缘、或贴近其他
 * 置顶便签时，松手后吸附对齐（只动位置，不动尺寸；x/y 各轴独立）。
 *
 * 实现要点：
 * - 松手判定：app-region 拖拽是 OS 模态移动循环，渲染层拿不到 mouseup——
 *   Windows 用 hookWindowMessage(WM_EXITSIZEMOVE) 拿真实松手才落位；
 *   非 Windows 回退为 move 静默 ~140ms 判定（中途停顿可能提前吸附）
 * - 便签间磁铁仅置顶便签参与（拖动方 win.isAlwaysOnTop() 判定 + 目标方
 *   由 getOthers 过滤）；屏幕边缘吸附所有便签都生效
 * - 组内便签退出磁铁池：不做磁铁目标、自身拖动不触发磁铁/成组（均由
 *   getOthers 过滤实现，本文件不感知组）；组 vs 组 v1 互不吸引、不合并
 * - 两卡片重叠 ≥50% = 成组区（stack-zone）：产出成组候选而非吸附候选，
 *   松手无吸附候选时经 SnapHooks.onStackDrop 成组
 * - 整组拖动（组手柄）期间经 SnapHandle.suppress 抑制成员各自吸附——
 *   主进程对所有成员程序化 setBounds，其 move 事件不触发边缘吸附
 * - 吸附落位是 160ms easeOutCubic 动画，不是瞬跳；动画/落位引发的 move
 *   事件要屏蔽，避免重复触发
 * - 预览窗口方案已废弃（观感奇怪，2026-07 评审决定不做）
 */

/** 吸附阈值（DIP）：窗口边缘距工作区边缘小于该值即吸附 */
const SNAP_DIST = 20;
/** 越界吸附阈值：窗口越出边缘但未超过窗口尺寸的该比例时拉回对齐；
 *  超过（98% 都出了屏）才视为跨屏/刻意停靠不硬拉——实测后定为 0.98 */
const OFFSCREEN_RATIO = 0.98;
/** 相邻屏判定容差（DIP）：多屏逻辑工作区之间的缝隙/重叠在这个范围内视为相邻 */
const ADJACENT_TOL = 48;
/** move 事件静默多久视为拖动结束（ms） */
const APPLY_DELAY = 140;
/** 吸附动画时长（ms） */
const ANIM_DURATION = 160;
/** 吸附落位后屏蔽 move 检测的附加时长（ms），防落位事件重复触发 */
const IGNORE_AFTER_APPLY = 60;

function intersects(b: Rectangle, a: Rectangle): boolean {
  return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
}

/** 计算吸附目标：x/y 各轴独立。触发条件：
 *  1. 窗口边缘在工作区边缘内侧 SNAP_DIST 内（靠近即吸）
 *  2. 窗口越出边缘但未超过 OFFSCREEN_RATIO（拉回对齐）
 *  例外：窗口已跨入相邻屏时，该方向的共享边缘不吸附（跨屏放行）。 */
export function computeEdgeSnap(b: Rectangle): Rectangle | null {
  let { x, y } = b;
  const { width: w, height: h } = b;
  const maxOffW = w * OFFSCREEN_RATIO;
  const maxOffH = h * OFFSCREEN_RATIO;
  let snapped = false;
  const displays = screen.getAllDisplays();
  for (const d of displays) {
    const a = d.workArea;
    if (!intersects(b, a)) continue; // 只考虑与窗口相交的屏
    // 相邻屏放行：跨入哪边，哪边的共享边缘不吸
    const crossRight = displays.some(
      (o) => o !== d && intersects(b, o.workArea) && o.workArea.x >= a.x + a.width - ADJACENT_TOL,
    );
    const crossLeft = displays.some(
      (o) => o !== d && intersects(b, o.workArea) && o.workArea.x + o.workArea.width <= a.x + ADJACENT_TOL,
    );
    const crossDown = displays.some(
      (o) => o !== d && intersects(b, o.workArea) && o.workArea.y >= a.y + a.height - ADJACENT_TOL,
    );
    const crossUp = displays.some(
      (o) => o !== d && intersects(b, o.workArea) && o.workArea.y + o.workArea.height <= a.y + ADJACENT_TOL,
    );
    if (!crossLeft && (Math.abs(x - a.x) < SNAP_DIST || (x < a.x && a.x - x < maxOffW))) {
      x = a.x;
      snapped = true;
    } else if (
      !crossRight &&
      (Math.abs(x + w - (a.x + a.width)) < SNAP_DIST ||
        (x + w > a.x + a.width && x + w - (a.x + a.width) < maxOffW))
    ) {
      x = a.x + a.width - w;
      snapped = true;
    }
    if (!crossUp && (Math.abs(y - a.y) < SNAP_DIST || (y < a.y && a.y - y < maxOffH))) {
      y = a.y;
      snapped = true;
    } else if (
      !crossDown &&
      (Math.abs(y + h - (a.y + a.height)) < SNAP_DIST ||
        (y + h > a.y + a.height && y + h - (a.y + a.height) < maxOffH))
    ) {
      y = a.y + a.height - h;
      snapped = true;
    }
  }
  return snapped ? { x, y, width: w, height: h } : null;
}

/** 便签间吸附阈值（DIP）：与其他便签的横向间距小于该值即贴合 */
const NOTE_SNAP_DIST = 16;
/** 纵向并列/顶对齐阈值（DIP）：y 区间不重叠时顶缘差小于该值才算并排关系，贴合时顶缘一并对齐 */
const NOTE_ALIGN_DIST = 32;
/** 贴合后卡片间留的缝（DIP）：严丝合缝时阴影无处过渡，观感发闷；
 *  便签组 restack 的头尾间距也复用此值 */
export const NOTE_GAP = 2;
/** 重叠解开上限：x 重叠量 / 目标宽度 低于该值时解开为并排；达到则进入
 *  成组区（stack-zone）——产出成组候选，不做吸附干预 */
const NOTE_STACK_RATIO = 0.5;
/** 便签窗口的透明阴影边距（与渲染层 --note-margin 一致）：
 *  吸附须用卡片矩形（窗口矩形内缩一圈），否则贴合后两张卡片空出 2×16px 的缝 */
export const NOTE_MARGIN = 16;

/** 窗口矩形 → 可视卡片矩形（刨去四边阴影边距） */
export function cardRect(b: Rectangle): Rectangle {
  return {
    x: b.x + NOTE_MARGIN,
    y: b.y + NOTE_MARGIN,
    width: b.width - NOTE_MARGIN * 2,
    height: b.height - NOTE_MARGIN * 2,
  };
}

/** 磁铁/成组判定的目标便签：id 用于成组回调定位目标窗口；
 *  grouped=true 的目标退出磁铁层（不贴合/不解开），只做 stack-zone 判定
 *  （自由便签压上来 ≥50% = 加入该组） */
export interface OtherNote {
  id: string;
  rect: Rectangle;
  grouped?: boolean;
}

export interface NoteSnapOutcome {
  target: Rectangle | null;
  detail?: string; // 候选说明（日志用）
  nearMiss?: string; // 接近但未触发的最近情形（诊断日志用）
  stackTargetId?: string; // 成组候选目标（stack-zone ≥50% 重叠命中；多个命中取重叠率最大者）
}

/** 便签间吸附：左右并排 + 上下叠放。
 *  对每个其他便签 o（卡片坐标系）：
 *  横向：先决= y 重叠 或 顶缘差 <32 → 分离贴合（x 间距 <16 贴左/右侧 + 顶对齐）
 *        / 重叠解开（x 重叠量 / 目标宽 <50%）
 *  纵向：先决= x 重叠 或 左缘差 <32 → 分离贴合（y 间距 <16 贴上/下方 + 左对齐）
 *        / 重叠解开（y 重叠量 / 目标高 <50%）
 *  两方向候选竞争，取总移动量最小者；重叠率 ≥50% 进入成组区（stack-zone）：
 *  产出成组候选（多个目标命中取重叠率最大者），不再做吸附干预。
 *  全程用卡片矩形（刨去 16px 阴影边距），返回换回窗口坐标。 */
export function computeNoteSnap(b: Rectangle, others: OtherNote[]): NoteSnapOutcome {
  const bc = cardRect(b); // 全程用卡片矩形计算，最后换回窗口坐标
  type Candidate = { x: number; y: number; move: number; desc: string };
  // 返回值风格：TS 控制流分析跟踪不到闭包内赋值，直接赋 best 会被窄化为 null
  const pick = (cur: Candidate | null, x: number, y: number, desc: string): Candidate | null => {
    const move = Math.abs(x - bc.x) + Math.abs(y - bc.y);
    if (move === 0) return cur;
    return !cur || move < cur.move ? { x, y, move, desc } : cur;
  };
  let best: Candidate | null = null;
  type Miss = { score: number; text: string };
  // 同 pick：返回值风格绕开 TS 闭包窄化
  const miss = (cur: Miss | null, score: number, text: string): Miss | null =>
    !cur || score < cur.score ? { score, text } : cur;
  let near: Miss | null = null;
  // 成组候选：stack-zone 命中的目标，多个命中时保留重叠率最大者
  let stack: { id: string; ratio: number } | null = null;

  for (const n of others) {
    const o = cardRect(n.rect);
    // 带符号间距：正=区间间距，负=重叠量
    const gapX = Math.max(bc.x, o.x) - Math.min(bc.x + bc.width, o.x + o.width);
    const gapY = Math.max(bc.y, o.y) - Math.min(bc.y + bc.height, o.y + o.height);
    const topDiff = Math.abs(bc.y - o.y);
    const leftDiff = Math.abs(bc.x - o.x);
    const oDesc = `o(${o.x},${o.y} ${o.width}×${o.height})`;

    // 横向先决：y 重叠 或 顶缘差 <32；纵向先决：x 重叠 或 左缘差 <32
    const alongside = gapY < 0 || topDiff < NOTE_ALIGN_DIST;
    const stacked = gapX < 0 || leftDiff < NOTE_ALIGN_DIST;

    // 组内成员：退出磁铁层（不贴合/不解开/不记 near），只做 stack-zone 判定——
    // 自由便签压上来 ≥50% = 加入该组（v1：组成员不两两成组、组不合并）
    if (n.grouped) {
      if (alongside && gapX < 0) {
        const rw = -gapX / o.width;
        if (rw >= NOTE_STACK_RATIO && (!stack || rw > stack.ratio)) stack = { id: n.id, ratio: rw };
      }
      if (stacked && gapY < 0) {
        const rh = -gapY / o.height;
        if (rh >= NOTE_STACK_RATIO && (!stack || rh > stack.ratio)) stack = { id: n.id, ratio: rh };
      }
      continue;
    }

    if (alongside) {
      if (gapX >= 0) {
        // 横向分离态：间距 <16 → 贴合左/右侧
        if (gapX < NOTE_SNAP_DIST) {
          const right = bc.x >= o.x + o.width;
          const x = right ? o.x + o.width + NOTE_GAP : o.x - bc.width - NOTE_GAP;
          const y = topDiff < NOTE_ALIGN_DIST ? o.y : bc.y;
          best = pick(
            best,
            x,
            y,
            `dock ${right ? 'right' : 'left'} of ${oDesc}${y !== bc.y ? ' +align-top' : ''}`,
          );
        } else {
          near = miss(near, gapX, `${oDesc} x-gap ${gapX} (threshold ${NOTE_SNAP_DIST})`);
        }
      } else {
        // 横向重叠态：重叠量 / 目标宽 <50% → 解开成并排 + 顶对齐
        const rw = -gapX / o.width;
        if (rw < NOTE_STACK_RATIO) {
          const right = bc.x + bc.width / 2 > o.x + o.width / 2;
          const x = right ? o.x + o.width + NOTE_GAP : o.x - bc.width - NOTE_GAP;
          best = pick(
            best,
            x,
            o.y,
            `overlap-x ${Math.round(rw * 100)}% -> dock ${right ? 'right' : 'left'} of ${oDesc} +align-top`,
          );
        } else {
          // 重叠 ≥50% = 成组区：产出成组候选（不再记 nearMiss）
          if (!stack || rw > stack.ratio) stack = { id: n.id, ratio: rw };
        }
      }
    } else if (gapX >= 0 && gapX < 64) {
      near = miss(
        near,
        Math.min(topDiff, gapY),
        `${oDesc} not-alongside: top-diff ${topDiff} / y-gap ${gapY} (threshold ${NOTE_ALIGN_DIST})`,
      );
    }

    // 纵向（stacked 先决已在循环首统一计算）
    if (stacked) {
      if (gapY >= 0) {
        // 纵向分离态：间距 <16 → 贴合上/下方
        if (gapY < NOTE_SNAP_DIST) {
          const below = bc.y >= o.y + o.height;
          const y = below ? o.y + o.height + NOTE_GAP : o.y - bc.height - NOTE_GAP;
          const x = leftDiff < NOTE_ALIGN_DIST ? o.x : bc.x;
          best = pick(
            best,
            x,
            y,
            `dock ${below ? 'below' : 'above'} ${oDesc}${x !== bc.x ? ' +align-left' : ''}`,
          );
        } else {
          near = miss(near, gapY, `${oDesc} y-gap ${gapY} (threshold ${NOTE_SNAP_DIST})`);
        }
      } else {
        // 纵向重叠态：重叠量 / 目标高 <50% → 解开成上下 + 左对齐
        const rh = -gapY / o.height;
        if (rh < NOTE_STACK_RATIO) {
          const below = bc.y + bc.height / 2 > o.y + o.height / 2;
          const y = below ? o.y + o.height + NOTE_GAP : o.y - bc.height - NOTE_GAP;
          best = pick(
            best,
            o.x,
            y,
            `overlap-y ${Math.round(rh * 100)}% -> dock ${below ? 'below' : 'above'} ${oDesc} +align-left`,
          );
        } else {
          // 重叠 ≥50% = 成组区：产出成组候选（不再记 nearMiss）
          if (!stack || rh > stack.ratio) stack = { id: n.id, ratio: rh };
        }
      }
    } else if (gapY >= 0 && gapY < 64) {
      near = miss(
        near,
        Math.min(leftDiff, gapX),
        `${oDesc} not-stacked: left-diff ${leftDiff} / x-gap ${gapX} (threshold ${NOTE_ALIGN_DIST})`,
      );
    }
  }

  return {
    // 卡片坐标换回窗口坐标（四边阴影边距）
    target: best
      ? { x: best.x - NOTE_MARGIN, y: best.y - NOTE_MARGIN, width: b.width, height: b.height }
      : null,
    detail: best?.desc,
    nearMiss: near?.text,
    stackTargetId: stack?.id,
  };
}

export interface SnapOutcome {
  target: Rectangle | null;
  source: 'note' | 'edge' | null;
  detail?: string;
  nearMiss?: string;
  stackTargetId?: string; // 成组候选目标（透传 computeNoteSnap 的 stack-zone 结果）
}

/** 合成吸附结果：先便签间磁铁，再套屏幕边缘规则（既保磁铁手感，又守不出屏底线）。 */
export function computeSnap(b: Rectangle, others: OtherNote[]): SnapOutcome {
  const n = computeNoteSnap(b, others);
  if (n.target) {
    return {
      target: computeEdgeSnap(n.target) ?? n.target,
      source: 'note',
      detail: n.detail,
      stackTargetId: n.stackTargetId,
    };
  }
  const edge = computeEdgeSnap(b);
  if (edge) return { target: edge, source: 'edge', stackTargetId: n.stackTargetId };
  return { target: null, source: null, nearMiss: n.nearMiss, stackTargetId: n.stackTargetId };
}

/** DIP→物理比例 k 的「干净格点」步进（物理像素）：k=p/q（最简分数）时取 p。
 *  物理量对齐 p 的整数倍时，DIP↔物理双向换算都是精确整数，
 *  getBounds 报告值零通胀（125%→5、150%→3、175%→7、200%→2、100%/异常→1）。 */
export function latticeStep(k: number): number {
  for (let q = 1; q <= 16; q += 1) {
    const p = Math.round(k * q);
    if (p > 0 && Math.abs(k * q - p) < 1e-6) return p;
  }
  return 1; // 非常规比例：不量化，退化为原行为
}

/** attachEdgeSnap 句柄：向窗口管理侧暴露吸附内部锚定的权威物理尺寸 */
export interface SnapHandle {
  /** 权威物理尺寸（用户真实缩放/折叠变形时锚定，动画帧不回读）；尚未记录时 null */
  getAuthSize: () => { w: number; h: number } | null;
  /** 程序化几何变更（折叠/展开提交）后直写权威物理尺寸（按干净格点量化），
   *  并屏蔽随后 300ms 的 resize/move——报告值不参与，奇偶通胀进不来 */
  commitAuthSize: (w: number, h: number) => void;
  /** 程序化滑动到指定位置（便签组 restack 用）：复用落位动画——格点量化、
   *  权威物理尺寸、ignoreUntil 屏蔽全套纪律；只动位置，尺寸取权威值不动 */
  animateTo: (x: number, y: number) => void;
  /** 程序化瞬时移动（整组拖动跟随帧用）：与落位动画同一纪律——物理尺寸
   *  锚定（authSize 优先）+ 位置量化到 lattice 格点，物理尺寸帧帧恒定
   *  （不产生 WM_SIZE 抖动）；帧自带 100ms 吸附屏蔽，调用方无需再 suppress */
  moveTo: (x: number, y: number) => void;
  /** 程序化设置尺寸（整组统一宽度用）：与折叠提交同纪律——格点量化 +
   *  权威尺寸直写 + 屏蔽报告回读（不回读 setBounds 的 OS 通胀报告） */
  setSizeDip: (w: number, h: number) => void;
  /** 抑制吸附检测 ms 毫秒（整组拖动用）：期间 move/resize 事件一律忽略——
   *  主进程程序化 setBounds 引发的 move 不会触发成员自己的边缘吸附/日志刷屏 */
  suppress: (ms: number) => void;
}

/** 成组手势回调（stack-zone：两卡片重叠 ≥50%） */
export interface SnapHooks {
  /** 成组预告：拖动中命中/切换/离开 stack-zone 目标（去重后触发；null = 无目标） */
  onStackHover?: (targetId: string | null) => void;
  /** 松手成组：松手时刻无吸附候选且有 stack-zone 目标 */
  onStackDrop?: (targetId: string) => void;
  /** 真实松手（每次 release 末尾无条件触发）：组内几何收敛出口——
   *  成员拖出解组/归位 restack/宽度统一由 group-manager 判定，本文件不感知组 */
  onReleased?: () => void;
}

/** WM_EXITSIZEMOVE：Windows 模态移动/缩放循环结束消息（= 真实松手） */
const WM_EXITSIZEMOVE = 0x0232;
/** 动画帧率节拍（60fps） */
const FRAME_MS = 1000 / 60;

/** 给便签窗口挂吸附（屏幕边缘 + 便签间磁铁，松手后以 160ms easeOutCubic 落位）。
 *  getScale 回传窗口的 DIP→物理像素比例（与 winstate 自校准 K 同源，比
 *  screen.scaleFactor 可靠），动画帧目标量化到整数物理像素用；
 *  不传则按所在显示器 scaleFactor 估算。
 *  hooks 是成组手势出口：stack-zone 命中/离开预告 + 松手成组。 */
export function attachEdgeSnap(
  win: BrowserWindow,
  getOthers?: () => OtherNote[],
  getScale?: () => number,
  hooks?: SnapHooks,
): SnapHandle {
  let timer: NodeJS.Timeout | null = null; // 仅非 Windows 回退路径用
  let anim: NodeJS.Timeout | null = null;
  let candidate: Rectangle | null = null;
  let lastStackTarget: string | null = null; // 成组预告的当前目标（去重用）
  let ignoreUntil = 0;
  let animating = false;
  let hooked = false; // WM_EXITSIZEMOVE 钩子是否挂上（Windows）
  let lastCandKey = ''; // 候选去重：只在变化时打日志
  let lastMissLog = 0; // near-miss 节流（1s）
  let lastSkipLog = 0; // 磁铁跳过日志节流（5s）
  // 权威尺寸（整数物理像素，干净格点）：只在用户真实缩放时刷新、或被
  // commitAuthSize 直写。动画帧/提交的 setBounds 报告值带位置奇偶抖动
  // （±1~2px 且有增长偏向），绝不回读喂回——否则逐次单向棘轮累积
  let authSize: { w: number; h: number } | null = null;

  const scaleOf = (): number => {
    const k = getScale?.();
    if (k && k > 0) return k;
    try {
      return screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
    } catch {
      return 1;
    }
  };

  const stopAnim = () => {
    if (anim) {
      clearTimeout(anim);
      anim = null;
    }
    animating = false;
  };

  /** 落位动画：物理空间 easeOutCubic 插值。
   *  顺帧关键：每一帧的位置/尺寸都取干净格点 → 物理尺寸帧帧恒定 →
   *  不产生 WM_SIZE → 渲染层零重排（掉帧主因），OS 只做纯位移；
   *  调度对齐 60fps 节拍（setInterval 会累积计时抖动）。 */
  const applySnap = (c: Rectangle): void => {
    const from = win.getBounds();
    if (from.x === c.x && from.y === c.y) return; // 已在吸附位
    // 新落位取代进行中的动画（restack 会覆盖成员未完成的边缘吸附滑动——
    // 不起 stopAnim 两条 tick 循环在同一窗口上打架）
    stopAnim();
    // 动画滑到边缘：easeOutCubic（末段减速，手感不撞墙）
    ignoreUntil = Date.now() + ANIM_DURATION + IGNORE_AFTER_APPLY;
    const k = scaleOf();
    const D = latticeStep(k);
    const qz = (v: number) => Math.round(v / D) * D;
    const size = authSize ?? { w: qz(from.width * k), h: qz(from.height * k) };
    const sx = Math.round(from.x * k);
    const sy = Math.round(from.y * k);
    const tx = qz(c.x * k);
    const ty = qz(c.y * k);
    console.log(
      `[snap] apply: from=(${from.x},${from.y} ${from.width}x${from.height})dip -> target=(${c.x},${c.y})dip k=${k} lattice=${D} size=(${size.w}x${size.h})phys src=${authSize ? 'auth' : 'fallback'}`,
    );
    const start = Date.now();
    animating = true;
    const tick = () => {
      if (win.isDestroyed()) {
        stopAnim();
        return;
      }
      const t = Math.min(1, (Date.now() - start) / ANIM_DURATION);
      const e = 1 - Math.pow(1 - t, 3);
      win.setBounds({
        x: qz(sx + (tx - sx) * e) / k,
        y: qz(sy + (ty - sy) * e) / k,
        width: size.w / k,
        height: size.h / k,
      });
      if (t >= 1) {
        stopAnim();
        // 落位即锚定意图物理尺寸：报告值带 ±1~2px 奇偶抖动（且曾观测到
        // setBounds(325) 报告 326 的 OS 级偏差），不回读喂回——否则
        // restack/吸附每跑一轮尺寸涨一级（单向棘轮）
        authSize = { w: size.w, h: size.h };
        // 落位校验：报告物理值应等于意图值；不等说明换算链还有通胀
        const rb = win.getBounds();
        console.log(
          `[snap] landed: expectPhys=(${tx},${ty} ${size.w}x${size.h}) reportPhys=(${Math.round(rb.x * k)},${Math.round(rb.y * k)} ${Math.round(rb.width * k)}x${Math.round(rb.height * k)}) reportDip=(${rb.x},${rb.y} ${rb.width}x${rb.height})`,
        );
        return;
      }
      // 漂移校正调度：对齐 60fps 节拍，setInterval 的累积抖动会让帧间隔忽长忽短
      const elapsed = Date.now() - start;
      anim = setTimeout(tick, Math.max(1, Math.ceil(elapsed / FRAME_MS) * FRAME_MS - elapsed));
    };
    anim = setTimeout(tick, FRAME_MS);
  };

  win.on('resize', () => {
    // 动画帧/落位/折叠提交引发的 resize 不算用户真实缩放（ignoreUntil 屏蔽）
    if (animating || Date.now() < ignoreUntil || win.isDestroyed()) return;
    const k = scaleOf();
    const D = latticeStep(k);
    const b = win.getBounds();
    // 锚定值量化到干净格点：之后动画/提交喂出的 DIP 全是精确整数
    authSize = {
      w: Math.round((b.width * k) / D) * D,
      h: Math.round((b.height * k) / D) * D,
    };
    console.log(
      `[snap] authSize refresh: report=(${b.width}x${b.height})dip k=${k} lattice=${D} -> auth=(${authSize.w}x${authSize.h})phys`,
    );
  });

  /** 松手结算：吸附候选优先落位；无候选且有成组目标则回调成组。
   *  两条松手路径（WM_EXITSIZEMOVE / 静默 timer）共用；成组预告一并收尾；
   *  末尾无条件发 onReleased（组内几何收敛出口：成员拖出解组/归位/宽度统一） */
  const release = (): void => {
    const c = candidate;
    candidate = null;
    const st = lastStackTarget;
    if (st) {
      lastStackTarget = null;
      hooks?.onStackHover?.(null);
    }
    if (c) {
      applySnap(c);
    } else if (st) {
      console.log(`[snap] stack-drop target=${st}`);
      hooks?.onStackDrop?.(st);
    }
    hooks?.onReleased?.();
  };

  win.on('move', () => {
    if (win.isDestroyed()) return;
    if (Date.now() < ignoreUntil) return; // 吸附动画/落位/折叠提交引发的 move
    stopAnim(); // 用户重新拖动，取消进行中的动画
    // 便签间磁铁仅置顶便签参与（目标方由 getOthers 过滤）；屏幕边缘吸附不受限
    const pinned = win.isAlwaysOnTop();
    if (!pinned && Date.now() - lastSkipLog > 5000) {
      lastSkipLog = Date.now();
      console.log('[snap] note-magnet skipped: window not always-on-top (edge snap still active)');
    }
    const r = computeSnap(win.getBounds(), pinned ? (getOthers?.() ?? []) : []);
    candidate = r.target;
    if (candidate) {
      const key = `${r.source}:${candidate.x},${candidate.y}:${r.detail ?? ''}`;
      if (key !== lastCandKey) {
        lastCandKey = key;
        console.log(
          `[snap] candidate(${r.source})${r.detail ? ' ' + r.detail : ''} → target=(${candidate.x},${candidate.y})`,
        );
      }
    } else {
      lastCandKey = '';
      if (r.nearMiss && Date.now() - lastMissLog > 1000) {
        lastMissLog = Date.now();
        console.log(`[snap] near-miss: ${r.nearMiss}`);
      }
    }
    // 成组预告：吸附候选优先（有候选不高亮）；无候选时 stack-zone 目标点亮，
    // 变化才回调（仿候选日志的去重纪律——move 高频，回调/日志不能逐帧发）
    const stackTarget = candidate ? null : (r.stackTargetId ?? null);
    if (stackTarget !== lastStackTarget) {
      lastStackTarget = stackTarget;
      hooks?.onStackHover?.(stackTarget);
      if (stackTarget) console.log(`[snap] stack-hover target=${stackTarget}`);
    }
    // 无候选且无目标：有 onReleased 钩子时也要设松手 timer——组内成员磁铁池
    // 为空（永远无候选/无目标），但松手仍要触发组内几何收敛（拖出解组等）
    if (!candidate && !lastStackTarget && !hooks?.onReleased) return;
    // Windows 由 WM_EXITSIZEMOVE（真实松手）触发结算；其他平台回退静默判定
    // （吸附候选与成组目标任一存在都要设 timer——成组目标走的也是松手判定）
    if (hooked) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!win.isDestroyed()) release();
    }, APPLY_DELAY);
  });

  // 松手判定（仅 Windows）：app-region 拖拽是 OS 模态移动循环，渲染层拿不到
  // mouseup；WM_EXITSIZEMOVE 在移动/缩放模态循环结束时必发，即真实松手
  if (process.platform === 'win32') {
    try {
      win.hookWindowMessage(WM_EXITSIZEMOVE, () => {
        if (win.isDestroyed() || Date.now() < ignoreUntil) return;
        release();
      });
      hooked = true;
    } catch {
      hooked = false; // 回退静默判定
    }
  }

  win.on('closed', () => {
    if (timer) clearTimeout(timer);
    stopAnim();
    // 不要 unhookWindowMessage：HWND 随窗口销毁，钩子不会再触发，无泄漏；
    // 且 closed 触发时窗口对象已销毁，调任何原生方法都抛
    // "Object has been destroyed"——还会中断后续 closed 监听器（窗口池清理）
  });

  return {
    getAuthSize: () => authSize,
    commitAuthSize: (w, h) => {
      const D = latticeStep(scaleOf());
      authSize = { w: Math.round(w / D) * D, h: Math.round(h / D) * D };
      console.log(`[snap] authSize commit: (${authSize.w}x${authSize.h})phys lattice=${D}`);
      // 提交引发的 resize/move 300ms 内不触发刷新/吸附（报告值不进场）
      ignoreUntil = Date.now() + 300;
    },
    // 复用落位动画：只动位置（applySnap 从不取 c 的尺寸），尺寸取权威值
    animateTo: (x, y) => applySnap({ x, y, width: 0, height: 0 }),
    // 整组拖动跟随帧：瞬时移动，同 applySnap 的格点/锚定纪律但不开动画——
    // 物理尺寸帧帧恒定（消除 ±1px 振荡 → 无 WM_SIZE → 渲染层零重排抖动）
    moveTo: (x, y) => {
      if (win.isDestroyed()) return;
      stopAnim(); // 拖动帧优先：进行中的落位动画立即让位
      const k = scaleOf();
      const D = latticeStep(k);
      const qz = (v: number) => Math.round(v / D) * D;
      const from = win.getBounds();
      const size = authSize ?? { w: qz(from.width * k), h: qz(from.height * k) };
      // fallback 当场锚定：setBounds 报告值带 +1~2px OS 级偏差（已观测
      // setBounds(400x267) 报告 401x268），不锚定则拖动每帧回读 inflated
      // 报告 → 写回更大值 → 再 inflate，逐帧单向棘轮（窗口持续变大）
      if (!authSize) authSize = size;
      // 拖动帧引发的 move/resize 100ms 内不进吸附判定（调用方高频连发，逐帧刷新）
      ignoreUntil = Date.now() + 100;
      win.setBounds({ x: qz(x * k) / k, y: qz(y * k) / k, width: size.w / k, height: size.h / k });
    },
    // 程序化设置尺寸（整组统一宽度用）：同折叠提交纪律——物理量格点化 +
    // 意图尺寸直写 authSize + 300ms 屏蔽（报告值不进场，防 OS 通胀棘轮）
    setSizeDip: (w, h) => {
      if (win.isDestroyed()) return;
      stopAnim();
      const k = scaleOf();
      const D = latticeStep(k);
      const qz = (v: number) => Math.round(v / D) * D;
      const wPhys = qz(w * k);
      const hPhys = qz(h * k);
      const b = win.getBounds();
      ignoreUntil = Date.now() + 300;
      win.setBounds({ x: b.x, y: b.y, width: wPhys / k, height: hPhys / k });
      authSize = { w: wPhys, h: hPhys };
    },
    // 整组拖动抑制：屏蔽期内的 move（程序化 setBounds 引发）不触发吸附
    suppress: (ms) => {
      ignoreUntil = Date.now() + ms;
    },
  };
}
