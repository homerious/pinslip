import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from '../api/client';

export default function ClipperSettings({ port }: { port: number }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [feedback, setFeedback] = useState<'revoked' | 'error'>();
  const [busy, setBusy] = useState(false);

  async function manage(method: 'POST' | 'DELETE') {
    setBusy(true);
    setFeedback(undefined);
    try {
      const result = await request<{ code?: string }>('/api/clipper/pairing', { method });
      setCode(result.code ?? '');
      if (method === 'DELETE') setFeedback('revoked');
    } catch {
      setFeedback('error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="settings-panel__section">{t('clipper.title')}</div>
      <div className="settings-card">
        <div className="settings-panel__row">
          <span className="settings-panel__label">{t('mcp.httpBase')}</span>
          <span className="settings-panel__value">{port ? `http://127.0.0.1:${port}` : '…'}</span>
        </div>
        <div className="settings-panel__row">
          <button className="settings-panel__btn" disabled={busy || !port} onClick={() => void manage('POST')}>
            {t('clipper.pair')}
          </button>
          <button className="settings-panel__btn" disabled={busy || !port} onClick={() => void manage('DELETE')}>
            {t('clipper.revoke')}
          </button>
        </div>
        {code && (
          <input className="settings-panel__input" aria-label={t('clipper.code')} readOnly value={code} onFocus={event => event.currentTarget.select()} />
        )}
        <div className="settings-panel__hint" role="status">{t(feedback ? `clipper.${feedback}` : 'clipper.hint')}</div>
      </div>
    </>
  );
}
