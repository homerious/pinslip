// 三进程共享的动画常量。

/** 折叠/展开动画时长（ms）。
 *  主进程用它定时「动画末一次性提交窗口几何」（折叠分支）；
 *  渲染层 CSS transition 用同一时长（global.css 的 .is-collapse-anim，改动要两边同步）；
 *  与吸附落位动画（snap.ts ANIM_DURATION 160ms）同一手感量级 */
export const COLLAPSE_ANIM_MS = 180;
