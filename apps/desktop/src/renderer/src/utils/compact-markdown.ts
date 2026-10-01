/**
 * toCompactMarkdown 复制出口的统一序列化（便签「复制全部」/ Ctrl+C / 主界面列表「复制全部」同一口径）：
 * - markdown 语法原样保留（标题/加粗/链接/表格/分割线/引用/代码块），不做语法剥离——
 *   复制出来没有格式，用户写 markdown 的意义就不在了；
 * - markdown 源文用空行分隔块（\n\n），直接拷会「一个换行变两个」，块分隔空行折叠丢弃；
 *   用户有意的空行（Milkdown 写入的独立 <br/> 行）保留一个；
 * - 行内 <br/> → 换行，避免粘贴到别处出现字面 br 标签；
 * - 围栏代码块（```/~~~）内部原样不动：空行与字面 <br/> 都是代码内容。
 */
export function toCompactMarkdown(content: string): string {
  const out: string[] = [];
  let fenceChar: string | null = null; // 处于围栏代码块内时的围栏字符（` 或 ~）
  for (const raw of content.split('\n')) {
    const fence = /^[ \t]*(```+|~~~+)/.exec(raw);
    if (fence) {
      if (fenceChar === null) fenceChar = fence[1][0];
      else if (fence[1][0] === fenceChar) fenceChar = null;
      out.push(raw);
      continue;
    }
    if (fenceChar !== null) {
      out.push(raw); // 代码块内部：原样
      continue;
    }
    if (/^[ \t]*<br\s*\/?>[ \t]*$/i.test(raw)) {
      out.push(''); // 用户有意的空行：保留
      continue;
    }
    if (!raw.trim()) continue; // markdown 块分隔空行：丢弃
    out.push(raw.replace(/<br\s*\/?>/gi, '\n'));
  }
  return out.join('\n');
}
