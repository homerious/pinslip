import { screen } from 'electron';
import type { BrowserWindow, Rectangle } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { GroupState } from '../../shared/types';
import type { GoProcess } from '../services/go-process';
import { cardRect, computeEdgeSnap, NOTE_GAP, NOTE_MARGIN } from './snap';
import { getNoteSnapHandle } from './note-window';

/**
 * 便签组（Note Group）主进程侧管理器。
 *
 * 数据纪律（磁盘即真相，与 Go 侧契约对齐）：
 * - frontmatter `group: <groupId>` 是成员关系真相源；`.pinslip/groups.json`
 *   注册表只存成员顺序（{ groups: [{ id, members: [...按顺序] }] }）
 * - 内存态先行（成组/退组立即生效、restack/拼框即时），持久化全部
 *   后台 fire-and-forget，失败只打日志不打断交互
 *
 * 几何纪律（血泪教训，勿破）：restack 只动位置不动尺寸；落位一律经
 * SnapHandle.animateTo（复用 applySnap 的格点量化 + ignoreUntil 屏蔽），
 * 禁止另起逐帧 setBounds 动画（DIP↔物理取整漂移会让窗口缓慢变大）。
 */

/** GET /api/groups 注册表的 JSON 形状（与 Go storage.GroupRegistry 对齐） */
interface GroupRegistryJson {
  groups?: { id: string; members: string[]; name?: string }[];
}

/** 拖出解组距离（px，卡片坐标）：成员卡片与其余成员包围盒外扩该值后仍
 *  不相交 = 脱离组（松手结算，见 handleMemberReleased） */
const TEAR_AWAY_DIST = 40;

/** GET /api/notes 列表项里本模块关心的字段 */
interface NoteMetaJson {
  id: string;
  group?: string;
}

export class GroupManager {
  /** groupId → 成员 id 列表（数组顺序即组内叠放顺序） */
  private readonly groups = new Map<string, string[]>();
  /** noteId → groupId（成员反查） */
  private readonly memberOf = new Map<string, string>();
  /** groupId → 用户自定义组名（可空）。解散的组残留 name 不单独清理：
   *  persistRegistry 只遍历现存组，残留永不下盘；load 每轮重建 */
  private readonly names = new Map<string, string>();
  /** 整组拖动会话（单指针，全局同时只有一个）：全员起始窗口矩形 + 主进程
   *  轮询光标（getCursorScreenPoint 恒为 DIP，与窗口 bounds 同单位）。
   *  血泪教训：绝不能用渲染层 clientX 差值——clientX 相对窗口客户区，
   *  窗口一动 Chromium 就反向补发 pointermove，位移信号自我振荡
   *  （鼠标静止也左右大跳）；轮询屏幕坐标与窗口位置天然解耦 */
  private dragSession: {
    groupId: string;
    starts: Map<string, Rectangle>;
    originX: number;
    originY: number;
    timer: NodeJS.Timeout;
    lastLogDX: number;
    lastLogDY: number;
  } | null = null;

  constructor(
    private readonly deps: {
      goProcess: GoProcess;
      /** 取便签窗口（未打开/已销毁返回 undefined） */
      getWindow: (noteId: string) => BrowserWindow | undefined;
    },
  ) {}

  /** 本地服务 HTTP 出口：端口随服务启动/重启变化，每次现取（同 fetchPinState 模式） */
  private async api(path: string, init?: RequestInit): Promise<Response> {
    const port = await this.deps.goProcess.ensureStarted();
    return fetch(`http://127.0.0.1:${port}${path}`, init);
  }

  /** 启动加载：拉注册表填充内存，再按 frontmatter reconcile 兜底——
   *  注册表多出的成员（frontmatter 已无 group / 笔记已删除）剔除；
   *  frontmatter 有但注册表缺失的按 groupId 聚类补入（顺序追加，
   *  几何校正 P5 再做）；剩 1 人的组解散并回写 frontmatter ""。
   *  有变更则整体 PUT 回注册表。失败只打日志（组功能降级，不影响便签本体） */
  async load(): Promise<void> {
    try {
      const regRes = await this.api('/api/groups');
      if (!regRes.ok) throw new Error(`GET /api/groups -> ${regRes.status}`);
      const reg = (await regRes.json()) as GroupRegistryJson;
      for (const g of reg.groups ?? []) {
        if (!g.id || !Array.isArray(g.members)) continue;
        // 去重 + 先占先得：同一 noteId 出现在多个组（脏数据）只认第一处
        const members = [...new Set(g.members)].filter(
          (id) => typeof id === 'string' && id !== '' && !this.memberOf.has(id),
        );
        if (members.length < 2) continue; // 1 人组等 reconcile 阶段统一解散
        this.groups.set(g.id, members);
        if (typeof g.name === 'string' && g.name !== '') this.names.set(g.id, g.name);
        for (const id of members) this.memberOf.set(id, g.id);
      }

      const notesRes = await this.api('/api/notes');
      if (!notesRes.ok) throw new Error(`GET /api/notes -> ${notesRes.status}`);
      const metas = (await notesRes.json()) as NoteMetaJson[];
      // frontmatter 是成员关系真相源：noteId → 其 frontmatter group
      const fmGroup = new Map(metas.map((m) => [m.id, m.group ?? '']));

      let changed = false;
      // 1) 注册表成员 frontmatter 已不含该组 id（含笔记已删除查无此人）→ 剔除
      for (const [gid, members] of [...this.groups]) {
        const kept = members.filter((id) => fmGroup.get(id) === gid);
        if (kept.length === members.length) continue;
        changed = true;
        for (const id of members) {
          if (!kept.includes(id)) this.memberOf.delete(id);
        }
        if (kept.length > 0) this.groups.set(gid, kept);
        else this.groups.delete(gid);
      }
      // 2) frontmatter 有组但注册表缺失的按 groupId 聚类补入（顺序追加）
      for (const m of metas) {
        const g = m.group ?? '';
        if (g === '' || this.memberOf.get(m.id) === g) continue;
        if (!this.groups.has(g)) this.groups.set(g, []);
        this.groups.get(g)!.push(m.id);
        this.memberOf.set(m.id, g);
        changed = true;
        console.log(`[group] reconcile: ${m.id} joined ${g} from frontmatter`);
      }
      // 3) 剩 1 人的组解散（组定义 ≥2 人），frontmatter 回写 ""
      const soloClears: string[] = [];
      for (const [gid, members] of [...this.groups]) {
        if (members.length >= 2) continue;
        changed = true;
        this.groups.delete(gid);
        const solo = members[0];
        if (solo) {
          this.memberOf.delete(solo);
          soloClears.push(solo);
        }
        console.log(`[group] reconcile: dissolved 1-member group ${gid}`);
      }
      if (changed) await this.persistRegistry();
      for (const id of soloClears) await this.writeFrontmatter(id, '');
      console.log(`[group] loaded: ${this.groups.size} group(s), ${this.memberOf.size} member(s)`);
    } catch (err) {
      console.error('[group] load failed:', err);
    }
  }

  isInGroup(noteId: string): boolean {
    return this.memberOf.has(noteId);
  }

  /** noteId 所在组的 id（未入组 null；松手结算"建组 or 加入"分流用） */
  groupOf(noteId: string): string | null {
    return this.memberOf.get(noteId) ?? null;
  }

  /** noteId 所在组的成员列表（未入组 null；加入预览整组点亮用） */
  membersOf(noteId: string): string[] | null {
    const gid = this.memberOf.get(noteId);
    return gid ? (this.groups.get(gid) ?? null) : null;
  }

  /** 便签当前组态（含角色）；不在组内返回 null */
  getState(noteId: string): GroupState | null {
    const gid = this.memberOf.get(noteId);
    if (!gid) return null;
    const members = this.groups.get(gid);
    if (!members || members.length === 0) return null;
    let role: GroupState['role'];
    if (members.length === 1) role = 'solo';
    else if (members[0] === noteId) role = 'first';
    else if (members[members.length - 1] === noteId) role = 'last';
    else role = 'middle';
    return { groupId: gid, role, name: this.names.get(gid) || undefined };
  }

  /** 松手成组：内存态先行（注册表 + pushState + restack），持久化后台。
   *  任一方已在组内则忽略（v1 组不合并）；首位按两窗卡片 y 排序定 */
  createGroup(aId: string, bId: string): void {
    if (this.memberOf.has(aId) || this.memberOf.has(bId)) {
      console.log(`[group] create ignored: ${aId}/${bId} already in a group (v1 no merge)`);
      return;
    }
    const cardOf = (id: string) => {
      const w = this.deps.getWindow(id);
      return w && !w.isDestroyed() ? cardRect(w.getBounds()) : null;
    };
    const ca = cardOf(aId);
    const cb = cardOf(bId);
    // 卡片 y 小者在上为首位；拿不到窗口（理论不会，松手路径两窗都在）按入参序
    const members = ca && cb && cb.y < ca.y ? [bId, aId] : [aId, bId];
    const groupId = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    this.groups.set(groupId, members);
    for (const id of members) this.memberOf.set(id, groupId);
    console.log(`[group] created ${groupId}: members=${members.join(',')}`);
    for (const id of members) this.pushState(id);
    this.uniformizeWidth(groupId); // 组宽统一（最宽者为准），拼缝外框右缘无缺口
    this.restack(groupId);
    void Promise.all([
      this.persistRegistry(),
      ...members.map((id) => this.writeFrontmatter(id, groupId)),
    ]).catch((err) => console.error('[group] create persist failed:', err));
  }

  /** 加入已有组（自由便签 stack-zone 压中组成员松手）：插到被压成员正下方
   *  （空间直觉：按在哪张上就贴在哪张下；压末位=追加到底），整组 restack。
   *  角色可能变化（插入位置下游全移、末位易主），全员重推组态。持久化后台 */
  addMember(noteId: string, groupId: string, afterNoteId: string): void {
    if (this.memberOf.has(noteId)) {
      console.log(`[group] join ignored: ${noteId} already in a group`);
      return;
    }
    const members = this.groups.get(groupId);
    if (!members) return;
    const idx = members.indexOf(afterNoteId);
    members.splice(idx < 0 ? members.length : idx + 1, 0, noteId);
    this.memberOf.set(noteId, groupId);
    console.log(
      `[group] ${noteId} joined ${groupId} after ${afterNoteId}: ${members.length} member(s)`,
    );
    this.uniformizeWidth(groupId); // 组宽统一（最宽者为准），新成员与整组对齐
    this.restack(groupId);
    for (const id of members) this.pushState(id);
    void Promise.all([this.persistRegistry(), this.writeFrontmatter(noteId, groupId)]).catch(
      (err) => console.error('[group] join persist failed:', err),
    );
  }

  /** 成员退组（取消置顶自动退组 / 拖出 40px / 笔记已删除收口）：内存剔除 +
   *  pushState + restack；剩 1 人自动解散（另一人也清 frontmatter、注册表
   *  删组）。持久化后台。
   *  opts.skipFrontmatter：笔记文件已删除（窗口关闭后 404 核对）时跳过对
   *  该成员自己的 frontmatter 回写——文件没了，写只会制造 404/500 噪音 */
  removeMember(noteId: string, opts?: { skipFrontmatter?: boolean }): void {
    const gid = this.memberOf.get(noteId);
    if (!gid) return;
    const members = this.groups.get(gid);
    if (!members) {
      this.memberOf.delete(noteId); // 内存脏数据兜底：反查有、正查无
      return;
    }
    const idx = members.indexOf(noteId);
    if (idx >= 0) members.splice(idx, 1);
    this.memberOf.delete(noteId);
    console.log(`[group] member left ${gid}: ${noteId} (${members.length} remaining)`);
    this.pushState(noteId); // 退组者拼框立即消失
    const persists: Promise<void>[] = [];
    if (!opts?.skipFrontmatter) persists.push(this.writeFrontmatter(noteId, ''));
    if (members.length === 1) {
      // 剩 1 人自动解散
      const last = members[0];
      this.groups.delete(gid);
      this.memberOf.delete(last);
      console.log(`[group] dissolved ${gid}: last member ${last}`);
      this.pushState(last);
      persists.push(this.writeFrontmatter(last, ''));
    } else {
      // 剩余成员收拢重排；角色可能变化（首/尾易位），全员重推组态
      this.restack(gid);
      for (const id of members) this.pushState(id);
    }
    persists.push(this.persistRegistry());
    void Promise.all(persists).catch((err) => console.error('[group] remove persist failed:', err));
  }

  /** 解散组（组手柄右键菜单）：全员退组、位置原地不动。内存先行 + 全员重推
   *  组态（拼缝外框/手柄立即消失），frontmatter 与注册表后台持久化 */
  dissolveGroup(noteId: string): void {
    const gid = this.memberOf.get(noteId);
    if (!gid) return;
    const members = this.groups.get(gid);
    if (!members) return;
    this.groups.delete(gid);
    this.names.delete(gid);
    const persists: Promise<void>[] = [];
    for (const id of members) {
      this.memberOf.delete(id);
      this.pushState(id);
      persists.push(this.writeFrontmatter(id, ''));
    }
    console.log(`[group] dissolved ${gid} by user: ${members.length} member(s) released`);
    persists.push(this.persistRegistry());
    void Promise.all(persists).catch((err) => console.error('[group] dissolve persist failed:', err));
  }

  /** 成员窗口关闭 = 退出组（2026-07-21 评审改判：关窗即退组，重开不回归；
   *  应用退出/切换保险库除外——那是系统行为不是用户意图，组要留给会话
   *  恢复/旧 vault 原样保留）。内存立即剔除（其余成员收拢）；
   *  frontmatter 回写前先核对笔记是否还在：404/服务不可达 = 笔记已删
   *  （或状态不可信），跳过回写（文件没了，写只会制造 500 噪音） */
  async handleWindowClosed(noteId: string): Promise<void> {
    const gid = this.memberOf.get(noteId);
    if (!gid) return;
    let noteExists = false;
    try {
      const res = await this.api(`/api/notes/${noteId}`);
      noteExists = res.status !== 404;
    } catch {
      // 服务不可达：不回写，保守处理（残留 frontmatter 由启动 reconcile 兜底）
    }
    this.removeMember(noteId, { skipFrontmatter: !noteExists });
  }

  /** 清空内存态重新加载（切换保险库）：旧 vault 的组关系对新 vault 无意义 */
  async reload(): Promise<void> {
    this.groups.clear();
    this.memberOf.clear();
    this.names.clear();
    await this.load();
  }

  /** restack 排版引擎：成员左对齐（对齐到组内卡片最左 x）、竖向头尾相叠、
   *  间距 NOTE_GAP(2px)；只动位置不动尺寸；落位走 animateTo 格点量化纪律。
   *  无窗口/已销毁/最小化的成员跳过（关窗保留组成员重开回归；最小化不收拢，
   *  恢复时 restackOf 归位）。
   *  opts.heightOverride：预告式重排（折叠动画起步即调用，窗口几何要动画末
   *    才提交）——指定成员按预告窗口高度参与堆叠，兄弟与卷起动画同步贴上；
   *  opts.anchorCard：显式锚点（卡片坐标）——成员松手归位时锚定"其余成员"
   *    的位置，被拖成员滑回槽位，整组不跟随拖动者漂移；
   *  opts.instant：瞬移落位（会话恢复/重开归位）——走 moveTo 而非 animateTo，
   *    启动时不该看到便签滑动 */
  restack(
    groupId: string,
    opts?: {
      heightOverride?: { noteId: string; winHeightDip: number };
      anchorCard?: { x: number; y: number };
      instant?: boolean;
    },
  ): void {
    const members = this.groups.get(groupId);
    if (!members) return;
    const cards: { id: string; card: { x: number; y: number; width: number; height: number } }[] =
      [];
    for (const id of members) {
      const win = this.deps.getWindow(id);
      if (!win || win.isDestroyed() || win.isMinimized()) continue; // 最小化 = 暂时离席
      const card = cardRect(win.getBounds());
      if (opts?.heightOverride && id === opts.heightOverride.noteId) {
        card.height = opts.heightOverride.winHeightDip - NOTE_MARGIN * 2; // 预告卡片高
      }
      cards.push({ id, card });
    }
    if (cards.length === 0) return;
    let minX = opts?.anchorCard?.x ?? Math.min(...cards.map((c) => c.card.x)); // 组内卡片最左 x
    let startY = opts?.anchorCard?.y ?? Math.min(...cards.map((c) => c.card.y)); // 锚定组当前顶缘
    // 屏幕边界钳制（血泪教训，勿删）：程序化堆叠绝不把组放出屏幕——winstate
    // 只校验"与显示器相交"（露 1px 也算可见），混合 DPI 换算/拔屏/位置漂移
    // 都能把保存坐标攒到工作区外；组顶一旦超出顶缘，手柄够不到 = 整组失去
    // 操作入口（2026-07-21 会话恢复事故）。堆叠总高超过屏高时保顶（手柄可见）
    const totalH =
      cards.reduce((sum, c) => sum + c.card.height, 0) + NOTE_GAP * (cards.length - 1);
    const maxW = Math.max(...cards.map((c) => c.card.width));
    const area = screen.getDisplayNearestPoint({ x: minX, y: startY }).workArea; // DIP，同卡片坐标
    minX = Math.min(Math.max(minX, area.x), Math.max(area.x, area.x + area.width - maxW));
    startY = Math.min(Math.max(startY, area.y), Math.max(area.y, area.y + area.height - totalH));
    let y = startY;
    for (const { id, card } of cards) {
      // 窗口坐标 = 卡片坐标 - 透明阴影边距；尺寸不动
      const wx = minX - NOTE_MARGIN;
      const wy = y - NOTE_MARGIN;
      const win = this.deps.getWindow(id)!;
      const handle = getNoteSnapHandle(win);
      if (handle) {
        if (opts?.instant) handle.moveTo(wx, wy); // 瞬移（同一格点量化纪律）
        else handle.animateTo(wx, wy);
      } else {
        // 降级：无吸附句柄（理论不会，建窗即挂）直写 bounds，仅打日志
        const b = win.getBounds();
        win.setBounds({ x: wx, y: wy, width: b.width, height: b.height });
        console.log(`[group] restack fallback setBounds: ${id} (no snap handle)`);
      }
      y += card.height + NOTE_GAP;
    }
    console.log(`[group] restacked ${groupId}: ${cards.length}/${members.length} window(s)`);
  }

  /** 成员折叠/展开几何提交后/窗口重开/最小化恢复时的组联动：所在组重排，
   *  兄弟贴上/让位。非组成员 no-op；restack 只动位置，位置不变的成员
   *  animateTo 早退，所以全组重排≠全组动——只有高度变化者下游的兄弟会滑动。
   *  winHeightDipOverride：折叠起步时的预告式重排（该成员即将变成的高度）；
   *  opts.instant：会话恢复/重开归位用瞬移（启动时不该看到滑动） */
  restackOf(noteId: string, winHeightDipOverride?: number, opts?: { instant?: boolean }): void {
    const gid = this.memberOf.get(noteId);
    if (!gid) return;
    this.restack(
      gid,
      winHeightDipOverride
        ? { heightOverride: { noteId, winHeightDip: winHeightDipOverride }, instant: opts?.instant }
        : { instant: opts?.instant },
    );
  }

  /** 组宽统一：取全开窗口成员的最宽卡片宽，其余成员程序化改宽到组宽
   *  （只增不减——调窄的成员被拉回组宽，内容永不被挤）。与 restack 分工：
   *  宽度在这里收敛（setSizeDip 格点量化 + 权威尺寸直写），位置在 restack */
  private uniformizeWidth(groupId: string): void {
    const members = this.groups.get(groupId);
    if (!members) return;
    const wins = members
      .map((id) => ({ id, win: this.deps.getWindow(id) }))
      .filter(
        (e): e is { id: string; win: BrowserWindow } =>
          !!e.win && !e.win.isDestroyed() && !e.win.isMinimized(), // 最小化离席不动尺寸
      );
    if (wins.length < 2) return;
    const targetCardW = Math.max(...wins.map((e) => cardRect(e.win.getBounds()).width));
    for (const e of wins) {
      const b = e.win.getBounds();
      if (Math.abs(cardRect(b).width - targetCardW) < 1) continue;
      const handle = getNoteSnapHandle(e.win);
      if (handle) {
        handle.setSizeDip(targetCardW + NOTE_MARGIN * 2, b.height);
      } else {
        e.win.setBounds({ x: b.x, y: b.y, width: targetCardW + NOTE_MARGIN * 2, height: b.height });
        console.log(`[group] uniform-width fallback setBounds: ${e.id} (no snap handle)`);
      }
    }
  }

  /** 成员松手结算（组内几何收敛，snap onReleased 钩子出口 + 缩放结束 IPC）：
   *  opts.resized（缩放结束）：成员位置没动，绝无拖出——跳过拖出判定
   *  （血泪教训：调矮 >~38px 会在成员与下方兄弟间张开 >40px 空档，
   *  兄弟尚未收拢，拖出判定必误伤）；只做宽度/高度收敛。
   *  拖动松手：拖出组包围盒 40px → 退组收拢；未拖出 → 滑回槽位。
   *  归位锚点：被结算成员不是最上方开放成员 → 上方成员不动（锚 others
   *  最左/最上）；是最上方 → 拖动滑回 others 顶之上（整组不跟随漂移），
   *  缩放锚它自己（组顶原位，下方兄弟按新高度让位/贴上） */
  handleMemberReleased(noteId: string, opts?: { resized?: boolean }): void {
    const gid = this.memberOf.get(noteId);
    if (!gid) return;
    const members = this.groups.get(gid);
    if (!members) return;
    const win = this.deps.getWindow(noteId);
    if (!win || win.isDestroyed()) return;
    const card = cardRect(win.getBounds());
    const others = members
      .filter((id) => id !== noteId)
      .map((id) => this.deps.getWindow(id))
      .filter((w): w is BrowserWindow => !!w && !w.isDestroyed() && !w.isMinimized()) // 最小化离席
      .map((w) => cardRect(w.getBounds()));
    if (!opts?.resized && others.length > 0) {
      const l = Math.min(...others.map((c) => c.x)) - TEAR_AWAY_DIST;
      const t = Math.min(...others.map((c) => c.y)) - TEAR_AWAY_DIST;
      const r = Math.max(...others.map((c) => c.x + c.width)) + TEAR_AWAY_DIST;
      const b = Math.max(...others.map((c) => c.y + c.height)) + TEAR_AWAY_DIST;
      const inside =
        card.x + card.width > l && card.x < r && card.y + card.height > t && card.y < b;
      if (!inside) {
        console.log(`[group] tear-away: ${noteId} left ${gid}`);
        this.removeMember(noteId); // 剩余成员收拢（removeMember 内部 restack）
        return;
      }
    }
    this.uniformizeWidth(gid);
    if (others.length === 0) {
      this.restack(gid); // 其余成员全关窗：锚自己（原地不动）
      return;
    }
    // 该成员是否最上方的开放成员（它之上的成员全关窗/最小化）
    const isTopOpen = !members
      .slice(0, members.indexOf(noteId))
      .some((id) => {
        const w = this.deps.getWindow(id);
        return w && !w.isDestroyed() && !w.isMinimized();
      });
    const othersMinX = Math.min(...others.map((c) => c.x));
    const othersMinY = Math.min(...others.map((c) => c.y));
    const anchor = opts?.resized
      ? isTopOpen
        ? { x: card.x, y: card.y } // 缩放首张：组顶原位，兄弟按新高度联动
        : { x: othersMinX, y: othersMinY } // 缩放非首张：上方成员不动
      : isTopOpen
        ? { x: othersMinX, y: othersMinY - card.height - NOTE_GAP } // 拖动首张：滑回组顶之上
        : { x: othersMinX, y: othersMinY }; // 拖动非首张：滑回 others 锚定的堆叠
    this.restack(gid, { anchorCard: anchor });
  }

  /** 整组拖动开始（组手柄 pointerdown）：记录全员起始窗口矩形 + 抑制各自吸附。
   *  非组成员/拿不到组则 no-op（渲染层只给首位成员渲染手柄，这里双保险） */
  beginDrag(noteId: string): void {
    const gid = this.memberOf.get(noteId);
    if (!gid) return;
    const members = this.groups.get(gid);
    if (!members) return;
    const starts = new Map<string, Rectangle>();
    for (const id of members) {
      const win = this.deps.getWindow(id);
      // 关窗/已销毁/最小化的成员跳过（关窗重开、最小化恢复都经 restackOf 归位）
      if (!win || win.isDestroyed() || win.isMinimized()) continue;
      starts.set(id, win.getBounds());
      // 拖动期间抑制成员各自吸附：程序化 setBounds 引发的 move 不触发
      // 成员自己的边缘吸附/磁铁，也不刷候选日志（位移刷新时再续 200ms）
      getNoteSnapHandle(win)?.suppress(500);
    }
    if (starts.size === 0) return;
    // 主进程轮询光标：getCursorScreenPoint 恒为 DIP，与 win.getBounds 同单位，
    // 且屏幕坐标与窗口位置解耦——不存在"窗口动→事件回流→位移振荡"的回路
    const origin = screen.getCursorScreenPoint();
    const timer = setInterval(() => this.pollDrag(), 16); // 60fps 跟随
    this.dragSession = {
      groupId: gid,
      starts,
      originX: origin.x,
      originY: origin.y,
      timer,
      lastLogDX: 0,
      lastLogDY: 0,
    };
    console.log(`[group] drag begin ${gid}: ${starts.size}/${members.length} window(s)`);
  }

  /** 整组拖动跟随（主进程 60fps 轮询）：全员按 起始矩形 + 光标位移 落位。
   *  走 SnapHandle.moveTo：物理尺寸锚定 + 位置格点量化——物理尺寸帧帧恒定，
   *  否则 150% 屏 DIP↔物理取整让宽高每帧 ±1px 振荡（WM_SIZE 重排抖动）；
   *  moveTo 帧自带 100ms 吸附屏蔽，无需再逐帧 suppress */
  private pollDrag(): void {
    const s = this.dragSession;
    if (!s) return;
    const cur = screen.getCursorScreenPoint();
    const dx = cur.x - s.originX;
    const dy = cur.y - s.originY;
    // 节流诊断日志：位移每跨过 16px 记一行（若再振荡，日志会来回横跳，一眼可辨）
    if (Math.abs(dx - s.lastLogDX) >= 16 || Math.abs(dy - s.lastLogDY) >= 16) {
      s.lastLogDX = dx;
      s.lastLogDY = dy;
      console.log(`[group] drag: d=(${Math.round(dx)},${Math.round(dy)})`);
    }
    let alive = 0;
    for (const [id, start] of s.starts) {
      const win = this.deps.getWindow(id);
      if (!win || win.isDestroyed()) continue; // 拖动中销毁防御
      alive += 1;
      const handle = getNoteSnapHandle(win);
      if (handle) {
        handle.moveTo(start.x + dx, start.y + dy);
      } else {
        // 降级：无吸附句柄（理论不会，建窗即挂）只动位置，不碰尺寸
        win.setPosition(Math.round(start.x + dx), Math.round(start.y + dy));
      }
    }
    if (alive === 0) {
      // 全员拖动中销毁：清场收尾（无窗口可结算，跳过 endDrag 的几何吸附）
      clearInterval(s.timer);
      this.dragSession = null;
      console.log(`[group] drag aborted ${s.groupId}: all windows destroyed`);
    }
  }

  /** 整组拖动结束：组包围盒（全员窗口矩形 union）跑 computeEdgeSnap，
   *  命中则偏移量统一加到每个成员、经各自 animateTo 同步滑动落位
   *  （格点量化 + 落位锚定意图尺寸，不另起动画循环）；未命中原地不动 */
  endDrag(noteId: string): void {
    const s = this.dragSession;
    if (!s || !s.starts.has(noteId)) return;
    clearInterval(s.timer); // 先停轮询，再做几何结算（防结算期间又来一帧）
    this.dragSession = null;
    const wins: { id: string; win: BrowserWindow; b: Rectangle }[] = [];
    for (const id of s.starts.keys()) {
      const win = this.deps.getWindow(id);
      if (!win || win.isDestroyed()) continue;
      wins.push({ id, win, b: win.getBounds() });
    }
    if (wins.length === 0) return;
    const left = Math.min(...wins.map((w) => w.b.x));
    const top = Math.min(...wins.map((w) => w.b.y));
    const right = Math.max(...wins.map((w) => w.b.x + w.b.width));
    const bottom = Math.max(...wins.map((w) => w.b.y + w.b.height));
    const union: Rectangle = { x: left, y: top, width: right - left, height: bottom - top };
    const snapped = computeEdgeSnap(union);
    if (!snapped || (snapped.x === union.x && snapped.y === union.y)) {
      console.log(`[group] drag end ${s.groupId}: no edge snap`);
      return;
    }
    const offX = snapped.x - union.x;
    const offY = snapped.y - union.y;
    console.log(`[group] drag end ${s.groupId}: edge snap offset=(${offX},${offY})`);
    for (const { id, win, b } of wins) {
      const handle = getNoteSnapHandle(win);
      if (handle) {
        handle.animateTo(b.x + offX, b.y + offY);
      } else {
        // 降级：无吸附句柄（理论不会，建窗即挂）直写 bounds，仅打日志
        win.setBounds({ x: b.x + offX, y: b.y + offY, width: b.width, height: b.height });
        console.log(`[group] drag-end fallback setBounds: ${id} (no snap handle)`);
      }
    }
  }

  /** 组态推送到便签渲染层（窗口未开/已销毁时静默丢弃——重开回归由挂载拉取兜底） */
  pushState(noteId: string): void {
    const win = this.deps.getWindow(noteId);
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC.GroupState, this.getState(noteId));
  }

  /** 成组预告高亮推送到便签渲染层 */
  pushHover(noteId: string, active: boolean): void {
    const win = this.deps.getWindow(noteId);
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC.GroupHover, active);
  }

  /** 重命名组（组标签手柄双击改名）：内存先行 + 全员重推组态，注册表后台
   *  持久化。空串 = 清除命名（回到只显示圆点的紧凑手柄） */
  renameGroup(noteId: string, name: string): void {
    const gid = this.memberOf.get(noteId);
    if (!gid) return;
    const members = this.groups.get(gid);
    if (!members) return;
    const trimmed = name.trim().slice(0, 30); // 组名上限 30 字符（tab 宽度有限）
    if (trimmed) this.names.set(gid, trimmed);
    else this.names.delete(gid);
    console.log(`[group] renamed ${gid}: "${trimmed}" (${members.length} member(s))`);
    for (const id of members) this.pushState(id);
    void this.persistRegistry().catch((err) => console.error('[group] rename persist failed:', err));
  }

  /** 整体写回注册表（PUT /api/groups body 即整个注册表；组名随组带出，
   *  undefined 被 JSON.stringify 丢弃，不落盘） */
  private async persistRegistry(): Promise<void> {
    const body: GroupRegistryJson = {
      groups: [...this.groups].map(([id, members]) => ({
        id,
        members: [...members],
        name: this.names.get(id) || undefined,
      })),
    };
    const res = await this.api('/api/groups', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PUT /api/groups -> ${res.status} ${await res.text().catch(() => '')}`);
  }

  /** 回写成员 frontmatter group 字段（"" = 移出组；部分更新不动其他字段）。
   *  5xx 多为瞬时失败（外部程序短暂占用文件/服务重启），重试一次再报错；
   *  错误带响应体——服务端真因（Go error 文本）必须进日志 */
  private async writeFrontmatter(noteId: string, group: string, attempt = 0): Promise<void> {
    const res = await this.api(`/api/notes/${noteId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group }),
    });
    if (res.ok) return;
    const detail = await res.text().catch(() => '');
    if (attempt === 0 && res.status >= 500) {
      await new Promise((r) => setTimeout(r, 300));
      return this.writeFrontmatter(noteId, group, attempt + 1);
    }
    throw new Error(`PUT /api/notes/${noteId} -> ${res.status} ${detail}`);
  }
}
