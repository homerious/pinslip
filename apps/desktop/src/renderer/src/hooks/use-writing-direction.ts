import { useCallback, useEffect, useState } from 'react';
import type { WritingDirection } from '@shared/types';

export function useWritingDirection() {
  const [direction, setDirection] = useState<WritingDirection>('auto');
  useEffect(() => {
    let alive = true;
    let receivedUpdate = false;
    const apply = (value: unknown) => {
      if (alive) setDirection(value === 'ltr' || value === 'rtl' ? value : 'auto');
    };
    window.api.getAdvanced().then(settings => {
      if (!receivedUpdate) apply(settings.writingDirection);
    }).catch(() => {});
    const off = window.api.onAdvancedChanged(settings => {
      receivedUpdate = true;
      apply(settings.writingDirection);
    });
    return () => { alive = false; off(); };
  }, []);
  const change = useCallback(async (next: WritingDirection) => {
    const saved = await window.api.setAdvanced({ writingDirection: next });
    setDirection(saved.writingDirection);
  }, []);
  return [direction, change] as const;
}
