import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';

export interface VirtualRow { key: string; render: () => ReactElement; estimate?: number }

export default function VirtualNoteList({ rows, resetKey = '' }: { rows: VirtualRow[]; resetKey?: string }): JSX.Element {
  const root = useRef<HTMLUListElement>(null);
  const [margin, setMargin] = useState(0);
  const [pinned, setPinned] = useState<number | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => root.current?.closest<HTMLElement>('.main-view') ?? null,
    estimateSize: index => rows[index].estimate ?? 145,
    getItemKey: index => rows[index].key,
    overscan: 4,
    scrollMargin: margin,
    gap: 8,
    rangeExtractor: range => {
      const indexes = defaultRangeExtractor(range);
      return pinned !== null && pinned < rows.length ? [...new Set([...indexes, pinned])].sort((a, b) => a - b) : indexes;
    },
  });
  useLayoutEffect(() => {
    const element = root.current;
    const parent = element?.closest<HTMLElement>('.main-view');
    if (!element || !parent) return;
    const measure = (): void => setMargin(element.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(parent); observer.observe(element);
    return () => observer.disconnect();
  }, [resetKey]);
  useLayoutEffect(() => { virtualizer.measure(); setPinned(null); virtualizer.scrollToOffset(0); }, [resetKey]);
  const pinEvent = (target: EventTarget): void => {
    const row = (target as HTMLElement).closest<HTMLElement>('[data-virtual-index]');
    if (row) setPinned(Number(row.dataset.virtualIndex));
  };
  return <ul ref={root} className="note-list virtual-note-list" style={{ height: virtualizer.getTotalSize() }}
    onFocusCapture={event => pinEvent(event.target)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPinned(null); }}
    onDragStartCapture={event => pinEvent(event.target)} onDragEndCapture={() => setPinned(null)}>
    {virtualizer.getVirtualItems().map(item => <li key={item.key} ref={virtualizer.measureElement}
      data-index={item.index} data-virtual-index={item.index} className="virtual-note-list__row"
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start - margin}px)` }}>
      <ul className="note-list">{rows[item.index].render()}</ul>
    </li>)}
  </ul>;
}
