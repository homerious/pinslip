import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import type { CopyAllFormat } from '@shared/types';
import { toCompactMarkdown } from './compact-markdown';

interface Node {
  type: string;
  children?: Node[];
  value?: string;
  url?: string;
  alt?: string;
  identifier?: string;
  label?: string;
  checked?: boolean | null;
  ordered?: boolean;
  start?: number | null;
}
const parser = remark().use(remarkGfm);
const isBreak = (node: Node) => node.type === 'html' && /^\s*<br\s*\/?>\s*$/i.test(node.value ?? '');
const key = (id = '') => id.replace(/\s+/g, ' ').toLowerCase();

export function toPlainText(markdown: string): string {
  const root = parser.parse(markdown.replace(/\r\n?/g, '\n')) as Node;
  const definitions = new Map<string, string>();
  const collect = (node: Node): void => {
    if (node.type === 'definition' && !definitions.has(key(node.identifier))) definitions.set(key(node.identifier), node.url ?? '');
    node.children?.forEach(collect);
  };
  collect(root);
  const children = (node: Node) => (node.children ?? []).map(render).join('');
  const blocks = (node: Node) => (node.children ?? []).filter(n => n.type !== 'definition')
    .map(n => isBreak(n) ? '' : render(n)).join('\n');
  const link = (label: string, url: string) => !url || label === url ? label : label ? `${label} (${url})` : url;
  function render(node: Node): string {
    switch (node.type) {
      case 'root': case 'blockquote': case 'listItem': return blocks(node);
      case 'text': case 'inlineCode': case 'code': return node.value ?? '';
      case 'break': return '\n';
      case 'html': return isBreak(node) ? '\n' : node.value ?? '';
      case 'link': return link(children(node), node.url ?? '');
      case 'image': return link(node.alt ?? '', node.url ?? '');
      case 'linkReference': return link(children(node), definitions.get(key(node.identifier)) ?? '');
      case 'imageReference': return link(node.alt ?? node.label ?? '', definitions.get(key(node.identifier)) ?? '');
      case 'definition': return '';
      case 'thematicBreak': return '────────';
      case 'list': return (node.children ?? []).map((item, i) => {
        const prefix = typeof item.checked === 'boolean' ? (item.checked ? '☑ ' : '☐ ')
          : node.ordered ? `${(node.start ?? 1) + i}. ` : '• ';
        return blocks(item).split('\n').map((line, index) => (index === 0 ? prefix : ' '.repeat(prefix.length)) + line).join('\n');
      }).join('\n');
      case 'table': return (node.children ?? []).map(row => (row.children ?? [])
        .map(cell => children(cell).replace(/[\t\n\r]+/g, ' ')).join('\t')).join('\n');
      case 'footnoteReference': return `[${node.label ?? node.identifier ?? ''}]`;
      case 'footnoteDefinition': return `[${node.label ?? node.identifier ?? ''}] ${blocks(node)}`;
      default: return node.children ? children(node) : node.value ?? '';
    }
  }
  return render(root);
}

export function copyText(markdown: string, format: CopyAllFormat): string {
  if (format === 'markdown') return toCompactMarkdown(markdown);
  try { return toPlainText(markdown); }
  catch { return markdown; } // 解析失败保留原文，绝不丢掉内容。
}
