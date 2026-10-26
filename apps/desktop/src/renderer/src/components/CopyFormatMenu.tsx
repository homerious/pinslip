import { useTranslation } from 'react-i18next';
import type { CopyAllFormat } from '@shared/types';
import CopyIcon from '~icons/ph/copy';
import AnchoredMenu, { type MenuAnchor } from './AnchoredMenu';

export type CopyMenuAnchor = MenuAnchor;
export default function CopyFormatMenu({ anchor, onSelect, onClose }: {
  anchor: CopyMenuAnchor;
  onSelect(format: CopyAllFormat): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  return <AnchoredMenu anchor={anchor} label={t('copyFormat.choose')} className="copy-format-menu" onClose={onClose}>
    {(['markdown','plain'] as const).map(format => <button type="button" role="menuitem" className="sticky-note__menu-item" key={format}
      onClick={() => onSelect(format)}><CopyIcon />{t('copyFormat.' + (format === 'markdown' ? 'asMarkdown' : 'asPlain'))}</button>)}
  </AnchoredMenu>;
}
