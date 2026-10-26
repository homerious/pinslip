import { useCallback, useEffect, useState } from 'react';
import type { CopyAllFormat } from '@shared/types';

export function useCopyFormat() {
  const [format, setFormat] = useState<CopyAllFormat>('markdown');
  useEffect(() => {
    let alive = true;
    let receivedUpdate = false;
    const apply = (value: unknown) => { if (alive) setFormat(value === 'plain' ? 'plain' : 'markdown'); };
    window.api.getAdvanced().then(settings => { if (!receivedUpdate) apply(settings.copyAllFormat); }).catch(() => {});
    const off = window.api.onAdvancedChanged(settings => { receivedUpdate = true; apply(settings.copyAllFormat); });
    return () => { alive = false; off(); };
  }, []);
  const change = useCallback(async (next: CopyAllFormat) => {
    const saved = await window.api.setAdvanced({ copyAllFormat: next });
    setFormat(saved.copyAllFormat);
  }, []);
  return [format, change] as const;
}
