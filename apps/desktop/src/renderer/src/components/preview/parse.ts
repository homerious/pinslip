import { remark } from 'remark';
import gfm from 'remark-gfm';

export interface PreviewNode {
  type: string;
  value?: string;
  children?: PreviewNode[];
  depth?: number;
  ordered?: boolean;
  start?: number;
  checked?: boolean | null;
  url?: string;
  alt?: string;
}
interface SourceNode extends PreviewNode { children?: SourceNode[]; position?: { end: { offset?: number } } }
export interface ParsedPreview { tree: PreviewNode; truncated: boolean }
const parser = remark().use(gfm);
const allowed = new Set(['root', 'text', 'paragraph', 'heading', 'strong', 'emphasis', 'delete',
  'list', 'listItem', 'blockquote', 'code', 'inlineCode', 'table', 'tableRow', 'tableCell',
  'link', 'image', 'break', 'thematicBreak']);

export function attachmentSource(src: string): string | null {
  const relative = src.replace(/^(?:\.\.\/)+/, '');
  if (!relative.startsWith('attachments/')) return null;
  try {
    const name = decodeURIComponent(relative.slice('attachments/'.length));
    if (!name || /[/\\:\x00?#]/.test(name) || name === '.' || name === '..' ||
      !/\.(png|jpe?g|gif|webp)$/i.test(name)) return null;
    return 'pinslip-img://attachments/' + encodeURIComponent(name);
  } catch { return null; }
}

export function parsePreview(markdown: string, expanded: boolean, sourceTruncated = false): ParsedPreview {
  const source = parser.parse(markdown) as unknown as SourceNode;
  let truncated = sourceTruncated;
  // 截断源的最后一个块可能是不完整表格/链接/围栏，宁可舍弃而不露出破碎语法。
  if (sourceTruncated && source.children?.length) source.children.pop();
  let remaining = expanded ? 600 : 120;
  function visit(n: SourceNode, depth: number): PreviewNode | null {
    if (!allowed.has(n.type)) return null;
    if (remaining <= 0 || depth > 12) { truncated = true; return null; }
    remaining--;
    const out: PreviewNode = { type: n.type };
    if (n.value !== undefined) {
      const limit = expanded ? 4000 : 800;
      out.value = n.value.slice(0, limit);
      if (n.value.length > limit) truncated = true;
    }
    if (n.type === 'heading') out.depth = Math.min(6, Math.max(1, n.depth ?? 1));
    if (n.type === 'list') { out.ordered = n.ordered; out.start = n.start; }
    if (n.type === 'listItem') out.checked = n.checked;
    if (n.type === 'image') { out.url = attachmentSource(n.url ?? '') ?? undefined; out.alt = (n.alt ?? '').slice(0, 200); }
    if (n.children) {
      out.children = [];
      const limit = n.type === 'table' ? (expanded ? 15 : 4) : n.type === 'tableRow' ? 8 : Infinity;
      if (n.children.length > limit) truncated = true;
      for (const child of n.children.slice(0, limit)) {
        if (remaining <= 0) { truncated = true; break; }
        const next = visit(child, depth + 1);
        if (next) out.children.push(next);
      }
    }
    return out;
  }
  return { tree: visit(source, 0) ?? { type: 'root', children: [] }, truncated };
}
