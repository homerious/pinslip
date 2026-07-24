// 插件内极简 i18n：消息量小，不引桌面端 react-i18next。
// 语言按浏览器 UI 语言自动选择（zh* → zh-CN；未知语言回退 en）。

export type Lang = 'zh-CN' | 'en' | 'ja' | 'ko' | 'es' | 'de' | 'fr';

type Dict = Record<string, string>;

const zhCN: Dict = {
  menuSaveSelection: '保存到 PinSlip',
  menuSaveLink: '保存链接到 PinSlip',
  menuClipPage: '剪藏正文到 PinSlip',
  menuSaveScreenshot: '截图保存到 PinSlip',
  saved: '已保存',
  saving: '保存中…',
  cannotConnect: '无法连接 PinSlip',
  connectGuide: '请确认 PinSlip 桌面应用已打开，并检查端口设置。',
  openOptions: '打开设置',
  popupPlaceholder: '记点什么…',
  popupSave: '保存',
  optionsTitle: 'PinSlip 插件设置',
  portLabel: '服务端口',
  portHint: '默认 17639；桌面端设置页可查看实际端口（知名端口被占用时会回退随机端口）。',
  retest: '重新检测',
  connected: '已连接 PinSlip（版本 {version}）',
  disconnected: '无法连接 PinSlip',
  clipFailed: '正文提取失败，可改用「保存到 PinSlip」保存选中内容',
  screenshotTitle: '截图：{title}',
  sourceFrom: '—— 摘自 [{title}]({url})',
};

const en: Dict = {
  menuSaveSelection: 'Save to PinSlip',
  menuSaveLink: 'Save link to PinSlip',
  menuClipPage: 'Clip article to PinSlip',
  menuSaveScreenshot: 'Save screenshot to PinSlip',
  saved: 'Saved',
  saving: 'Saving…',
  cannotConnect: 'Cannot connect to PinSlip',
  connectGuide: 'Make sure the PinSlip desktop app is running and check the port setting.',
  openOptions: 'Open settings',
  popupPlaceholder: 'Jot something down…',
  popupSave: 'Save',
  optionsTitle: 'PinSlip Extension Settings',
  portLabel: 'Service port',
  portHint: 'Default is 17639; the desktop settings page shows the actual port (a random port is used as fallback when the well-known port is busy).',
  retest: 'Test again',
  connected: 'Connected to PinSlip (version {version})',
  disconnected: 'Cannot connect to PinSlip',
  clipFailed: 'Failed to extract the article; use "Save to PinSlip" on selected text instead',
  screenshotTitle: 'Screenshot: {title}',
  sourceFrom: '—— From [{title}]({url})',
};

const ja: Dict = {
  menuSaveSelection: 'PinSlip に保存',
  menuSaveLink: 'リンクを PinSlip に保存',
  menuClipPage: '本文を PinSlip にクリップ',
  menuSaveScreenshot: 'スクリーンショットを PinSlip に保存',
  saved: '保存しました',
  saving: '保存中…',
  cannotConnect: 'PinSlip に接続できません',
  connectGuide: 'PinSlip デスクトップアプリが起動しているか確認し、ポート設定を見直してください。',
  openOptions: '設定を開く',
  popupPlaceholder: '何かメモする…',
  popupSave: '保存',
  optionsTitle: 'PinSlip 拡張機能の設定',
  portLabel: 'サービスポート',
  portHint: 'デフォルトは 17639。実際のポートはデスクトップの設定ページで確認できます（固定ポートが使用中の場合はランダムポートにフォールバックします）。',
  retest: '再検出',
  connected: 'PinSlip に接続しました（バージョン {version}）',
  disconnected: 'PinSlip に接続できません',
  clipFailed: '本文を抽出できませんでした。選択テキストの「PinSlip に保存」をお試しください',
  screenshotTitle: 'スクリーンショット：{title}',
  sourceFrom: '—— 出典 [{title}]({url})',
};

const ko: Dict = {
  menuSaveSelection: 'PinSlip에 저장',
  menuSaveLink: '링크를 PinSlip에 저장',
  menuClipPage: '본문을 PinSlip에 클리핑',
  menuSaveScreenshot: '스크린샷을 PinSlip에 저장',
  saved: '저장됨',
  saving: '저장 중…',
  cannotConnect: 'PinSlip에 연결할 수 없습니다',
  connectGuide: 'PinSlip 데스크톱 앱이 실행 중인지 확인하고 포트 설정을 점검하세요.',
  openOptions: '설정 열기',
  popupPlaceholder: '메모를 입력하세요…',
  popupSave: '저장',
  optionsTitle: 'PinSlip 확장 설정',
  portLabel: '서비스 포트',
  portHint: '기본값은 17639입니다. 실제 포트는 데스크톱 설정 페이지에서 확인할 수 있습니다(잘 알려진 포트가 사용 중이면 임의 포트로 대체됩니다).',
  retest: '다시 감지',
  connected: 'PinSlip에 연결됨(버전 {version})',
  disconnected: 'PinSlip에 연결할 수 없습니다',
  clipFailed: '본문을 추출하지 못했습니다. 선택한 텍스트를 「PinSlip에 저장」으로 저장해 보세요',
  screenshotTitle: '스크린샷: {title}',
  sourceFrom: '—— 출처 [{title}]({url})',
};

const es: Dict = {
  menuSaveSelection: 'Guardar en PinSlip',
  menuSaveLink: 'Guardar enlace en PinSlip',
  menuClipPage: 'Recortar artículo a PinSlip',
  menuSaveScreenshot: 'Guardar captura en PinSlip',
  saved: 'Guardado',
  saving: 'Guardando…',
  cannotConnect: 'No se puede conectar con PinSlip',
  connectGuide: 'Asegúrate de que la app de escritorio PinSlip esté abierta y revisa el puerto.',
  openOptions: 'Abrir ajustes',
  popupPlaceholder: 'Anota algo…',
  popupSave: 'Guardar',
  optionsTitle: 'Ajustes de la extensión PinSlip',
  portLabel: 'Puerto del servicio',
  portHint: 'El puerto por defecto es 17639; la página de ajustes del escritorio muestra el puerto real (se usa un puerto aleatorio si el conocido está ocupado).',
  retest: 'Probar de nuevo',
  connected: 'Conectado a PinSlip (versión {version})',
  disconnected: 'No se puede conectar con PinSlip',
  clipFailed: 'No se pudo extraer el artículo; usa «Guardar en PinSlip» con el texto seleccionado',
  screenshotTitle: 'Captura: {title}',
  sourceFrom: '—— De [{title}]({url})',
};

const de: Dict = {
  menuSaveSelection: 'In PinSlip speichern',
  menuSaveLink: 'Link in PinSlip speichern',
  menuClipPage: 'Artikel nach PinSlip clippen',
  menuSaveScreenshot: 'Screenshot in PinSlip speichern',
  saved: 'Gespeichert',
  saving: 'Speichern…',
  cannotConnect: 'Keine Verbindung zu PinSlip',
  connectGuide: 'Bitte sicherstellen, dass die PinSlip-Desktop-App läuft, und den Port prüfen.',
  openOptions: 'Einstellungen öffnen',
  popupPlaceholder: 'Etwas notieren…',
  popupSave: 'Speichern',
  optionsTitle: 'PinSlip-Erweiterungseinstellungen',
  portLabel: 'Dienst-Port',
  portHint: 'Standard ist 17639; der tatsächliche Port steht in den Desktop-Einstellungen (bei belegtem Standardport wird ein Zufallsport verwendet).',
  retest: 'Erneut prüfen',
  connected: 'Mit PinSlip verbunden (Version {version})',
  disconnected: 'Keine Verbindung zu PinSlip',
  clipFailed: 'Artikel konnte nicht extrahiert werden; stattdessen markierten Text „In PinSlip speichern“ verwenden',
  screenshotTitle: 'Screenshot: {title}',
  sourceFrom: '—— Quelle [{title}]({url})',
};

const fr: Dict = {
  menuSaveSelection: 'Enregistrer dans PinSlip',
  menuSaveLink: 'Enregistrer le lien dans PinSlip',
  menuClipPage: 'Capturer l’article dans PinSlip',
  menuSaveScreenshot: 'Enregistrer la capture dans PinSlip',
  saved: 'Enregistré',
  saving: 'Enregistrement…',
  cannotConnect: 'Impossible de se connecter à PinSlip',
  connectGuide: 'Vérifiez que l’app de bureau PinSlip est ouverte et contrôlez le port.',
  openOptions: 'Ouvrir les réglages',
  popupPlaceholder: 'Noter quelque chose…',
  popupSave: 'Enregistrer',
  optionsTitle: 'Réglages de l’extension PinSlip',
  portLabel: 'Port du service',
  portHint: 'Le port par défaut est 17639 ; la page de réglages du bureau affiche le port réel (un port aléatoire est utilisé si le port connu est occupé).',
  retest: 'Retester',
  connected: 'Connecté à PinSlip (version {version})',
  disconnected: 'Impossible de se connecter à PinSlip',
  clipFailed: 'Échec de l’extraction de l’article ; utilisez « Enregistrer dans PinSlip » sur le texte sélectionné',
  screenshotTitle: 'Capture : {title}',
  sourceFrom: '—— Source [{title}]({url})',
};

const ALL: Record<Lang, Dict> = {
  'zh-CN': zhCN,
  en,
  ja,
  ko,
  es,
  de,
  fr,
};

function resolveLang(): Lang {
  const ui = (chrome.i18n?.getUILanguage?.() ?? 'en').toLowerCase();
  if (ui.startsWith('zh')) return 'zh-CN';
  for (const l of ['ja', 'ko', 'es', 'de', 'fr'] as const) {
    if (ui.startsWith(l)) return l;
  }
  return 'en';
}

const dict = ALL[resolveLang()];

/** 取文案并做 {name} 占位替换。 */
export function msg(key: keyof typeof zhCN, vars?: Record<string, string>): string {
  let s = dict[key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, v);
    }
  }
  return s;
}
