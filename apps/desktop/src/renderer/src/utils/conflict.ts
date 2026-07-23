/** git 同步冲突标记处理：检测与剥离（全部用本地 / 全部用远端）。
 *  冲突块格式（git merge 写入 .md 的标准 markers）：
 *    <<<<<<< 本地
 *    ...本地行...
 *    =======
 *    ...远端行...
 *    >>>>>>> 远端
 *  解析原则：逐行扫描，支持多个冲突块；无冲突部分原样保留；
 *  格式不完整的 markers（缺 ======= / >>>>>>>，或块内又嵌套 <<<<<<<）原样保留，绝不误伤正文 */

export type ConflictSide = 'local' | 'remote';

/** 内容是否含冲突起始标记（与 NoteView 的 hasConflict 判定同一标准） */
export const hasConflictMarkers = (text: string): boolean => /^<<<<<<< /m.test(text);

/** marker 行判定：行首 7 个重复符号，容忍行尾 \r（CRLF 文件）与任意 label 后缀 */
const isStart = (line: string): boolean => /^<{7}/.test(line.replace(/\r$/, ''));
const isSep = (line: string): boolean => /^={7}/.test(line.replace(/\r$/, ''));
const isEnd = (line: string): boolean => /^>{7}/.test(line.replace(/\r$/, ''));

/** 把全文里所有格式完整的冲突块剥成指定一侧（local = ======= 之上，remote = 之下） */
export function resolveConflicts(text: string, side: ConflictSide): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isStart(lines[i])) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    // 从 <<<<<<< 之后找 =======；期间再遇 <<<<<<< 视为嵌套/不完整，放弃本块
    let sep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isStart(lines[j])) break;
      if (isSep(lines[j])) {
        sep = j;
        break;
      }
    }
    // 从 ======= 之后找 >>>>>>>；期间再遇任何 marker 视为不完整，放弃本块
    let end = -1;
    if (sep !== -1) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (isStart(lines[j]) || isSep(lines[j])) break;
        if (isEnd(lines[j])) {
          end = j;
          break;
        }
      }
    }
    if (sep === -1 || end === -1) {
      // 不完整 markers：起始行原样保留，从下一行继续逐行扫描
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const picked = side === 'local' ? lines.slice(i + 1, sep) : lines.slice(sep + 1, end);
    out.push(...picked);
    i = end + 1;
  }
  return out.join('\n');
}
