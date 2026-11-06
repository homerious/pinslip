import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { previewStore } from './client';
import { previewKey } from './store';
import type { PreviewNode } from './parse';

function LazyImage({ src, alt }: { src: string; alt: string }): JSX.Element {
  const root = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)));
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  return <span ref={root} className="markdown-preview__image">
    {visible && !failed ? <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} /> : `▧ ${alt}`}
  </span>;
}

export default function MarkdownPreview({ id, excerpt, expanded, direction = 'auto' }: { id: string; excerpt: string; expanded: boolean; direction?: 'auto' | 'ltr' | 'rtl' }): JSX.Element {
  const { t } = useTranslation();
  const key = previewKey(id, expanded);
  const collapsedKey = previewKey(id, false);
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribe = previewStore.subscribe(key, listener);
    if (!expanded) return unsubscribe;
    const unsubscribeCollapsed = previewStore.subscribe(collapsedKey, listener);
    return () => { unsubscribe(); unsubscribeCollapsed(); };
  }, [key, collapsedKey, expanded]);
  const snapshot = useCallback(() => previewStore.get(key) ?? previewStore.get(collapsedKey), [key, collapsedKey]);
  const entry = useSyncExternalStore(subscribe, snapshot);
  // 展开源尚在请求/解析时保留折叠树与高度，避免 Markdown → 纯文本 → Markdown 的两次重排。
  const showExpanded = expanded && previewStore.get(key) !== undefined;
  let images = 0;
  const render = (node: PreviewNode, index: number): ReactNode => {
    const children = node.children?.map(render);
    const props = { key: index };
    switch (node.type) {
      case 'text': return node.value;
      case 'root': return children;
      case 'heading': return createElement(`h${node.depth ?? 1}`, props, children);
      case 'paragraph': return <p {...props}>{children}</p>;
      case 'strong': return <strong {...props}>{children}</strong>;
      case 'emphasis': return <em {...props}>{children}</em>;
      case 'delete': return <del {...props}>{children}</del>;
      case 'list': return node.ordered ? <ol {...props} start={node.start}>{children}</ol> : <ul {...props}>{children}</ul>;
      case 'listItem': return <li {...props} className={node.checked != null ? 'markdown-preview__task' : undefined}>{node.checked != null && <input type="checkbox" checked={node.checked} readOnly disabled />}{children}</li>;
      case 'blockquote': return <blockquote {...props}>{children}</blockquote>;
      case 'code': return <pre {...props}><code>{node.value}</code></pre>;
      case 'inlineCode': return <code {...props}>{node.value}</code>;
      case 'table': return <div {...props} className="markdown-preview__table"><table><tbody>{children}</tbody></table></div>;
      case 'tableRow': return <tr {...props}>{children}</tr>;
      case 'tableCell': return <td {...props}>{children}</td>;
      case 'link': return <span {...props} className="markdown-preview__link">{children}</span>;
      case 'image': return showExpanded && node.url && images++ < 3
        ? <LazyImage {...props} src={node.url} alt={node.alt || t('preview.image')} />
        : <span {...props} className="markdown-preview__placeholder">▧ {node.alt || t('preview.image')}</span>;
      case 'break': return <br {...props} />;
      case 'thematicBreak': return <hr {...props} />;
      default: return null;
    }
  };
  const ready = entry && (entry.parsed.tree.children?.length ?? 0) > 0;
  return <div className={`note-list__preview markdown-preview${showExpanded ? ' is-expanded' : ''}`} dir={entry?.data.direction || direction}>
    {ready ? render(entry.parsed.tree, 0) : <span className="markdown-preview__fallback">{excerpt}</span>}
    {entry?.parsed.truncated && <span className="markdown-preview__truncated">{t('preview.truncated')}</span>}
  </div>;
}
