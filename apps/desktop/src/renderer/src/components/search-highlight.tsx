import type { ReactNode } from 'react';

const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** 以首个命中词为锚点把 text 截成短窗口（首尾补 …），命中词放窗口约 1/4 处。
 *  用途：标题等单行省略场景——窗口必须短于一行可视容量，否则命中词会被
 *  CSS text-overflow 省略号截掉（与服务端 makeSnippet 同策略）。
 *  max 按字符数（rune）计；无命中时从开头截。 */
export function windowAroundMatch(text: string, terms: string[], max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;

  const clean = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
  let hitStart = -1;
  let hitLen = 0;
  if (clean.length > 0) {
    const re = new RegExp(clean.map((t) => t.replace(REGEX_ESCAPE, '\\$&')).join('|'), 'gi');
    const m = re.exec(text);
    if (m) {
      hitStart = [...text.slice(0, m.index)].length; // code unit 下标 → 字符下标
      hitLen = [...m[0]].length;
    }
  }
  if (hitStart < 0) return chars.slice(0, max).join('') + '…';

  let start = Math.max(0, hitStart - Math.floor(max / 4));
  if (hitStart + hitLen > start + max) start = hitStart; // 超长命中词：对齐其开头
  let end = start + max;
  if (end > chars.length) {
    end = chars.length;
    start = Math.max(0, end - max);
  }
  return (start > 0 ? '…' : '') + chars.slice(start, end).join('') + (end < chars.length ? '…' : '');
}

/** 把 text 中命中 terms 的片段包成 <mark>（React 安全渲染，不走 innerHTML）。
 *  大小写不敏感子串匹配：正则 'gi' 在原串上扫描，索引天然对齐，
 *  避开 toLowerCase 全文转换可能改变串长（如土耳其语 İ）导致的区间错位。
 *  与后端 bigram 命中语义近似一致：CJK 连续段整体匹配、拉丁词子串匹配。
 *  重叠/相邻区间先合并再切段，避免嵌套 <mark>。 */
export function highlightTerms(text: string, terms: string[]): ReactNode {
  const clean = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
  if (!text || clean.length === 0) return text;

  const re = new RegExp(clean.map((t) => t.replace(REGEX_ESCAPE, '\\$&')).join('|'), 'gi');
  const ranges: [number, number][] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    ranges.push([m.index, m.index + m[0].length]); // m[0] 非空，exec 必推进，无零宽死循环
  }
  if (ranges.length === 0) return text;

  // exec 从左到右扫描，区间已按起点有序；合并重叠/相邻区间
  const merged: [number, number][] = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  const out: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([s, e], i) => {
    if (s > cursor) out.push(text.slice(cursor, s));
    out.push(<mark key={i}>{text.slice(s, e)}</mark>);
    cursor = e;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
