/**
 * 目录路径显示缩短：保留首尾、省略中间。
 * - 不超过 max 字符：原样返回
 * - 多段路径：`首段/…/末段`
 * - 两段路径：`首段/…/末段`（中间无真实段也保持形式一致）
 * - 单段超长：尾部省略
 * 完整路径应始终通过 title 属性悬停可查。
 */
export function shortenFolder(path: string, max = 14): string {
  if ([...path].length <= max) return path;
  const segs = path.split('/');
  const first = segs[0];
  const last = segs[segs.length - 1];
  if (first !== last) return `${first}/…/${last}`;
  return [...path].slice(0, max - 1).join('') + '…';
}
