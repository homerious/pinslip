// background service worker：右键菜单 + 四个保存动作。
// 反馈走 action 角标（无 notifications 权限）：成功绿 ✓ 1.5s，失败红 ✗ 并打开选项页引导。

import { msg } from './i18n';
import { createInboxNote, quick, uploadImage } from './api';

const MENUS: Array<{ id: string; titleKey: string; contexts: chrome.contextMenus.ContextType[] }> = [
  { id: 'save-selection', titleKey: 'menuSaveSelection', contexts: ['selection'] },
  { id: 'save-link', titleKey: 'menuSaveLink', contexts: ['link'] },
  { id: 'clip-page', titleKey: 'menuClipPage', contexts: ['page'] },
  { id: 'save-screenshot', titleKey: 'menuSaveScreenshot', contexts: ['page'] },
];

function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    for (const m of MENUS) {
      chrome.contextMenus.create({
        id: m.id,
        title: msg(m.titleKey),
        contexts: m.contexts,
      });
    }
  });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

/** 来源行：—— 摘自 [标题](URL)（措辞随 i18n，markdown 结构不变）。 */
function sourceLine(title: string, url: string): string {
  return msg('sourceFrom', { title, url });
}

function flashBadge(text: string, color: string, ms: number): void {
  void chrome.action.setBadgeBackgroundColor({ color });
  void chrome.action.setBadgeText({ text });
  setTimeout(() => void chrome.action.setBadgeText({ text: '' }), ms);
}

function reportSuccess(): void {
  flashBadge('✓', '#2da44e', 1500);
}

/** 失败反馈：红角标 + 打开选项页（页面里有连接状态与排查引导）。 */
function reportFailure(err: unknown): void {
  console.error('[PinSlip]', err);
  flashBadge('✗', '#cf222e', 3000);
  void chrome.runtime.openOptionsPage();
}

/** 向 content script 取「上次右键命中的链接文字」（OnClickData 不带链接文本）。 */
function queryAnchorText(tabId: number, linkUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'pinslip:anchor-text', linkUrl }, (resp) => {
      if (chrome.runtime.lastError || !resp || typeof resp.text !== 'string') {
        resolve(null);
      } else {
        resolve(resp.text);
      }
    });
  });
}

interface ClipResult {
  title: string;
  markdown: string;
}

/** 让 content script 用 Readability 提取正文并转 Markdown。 */
function requestClip(tabId: number): Promise<ClipResult | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'pinslip:clip' }, (resp) => {
      if (chrome.runtime.lastError || !resp || typeof resp.markdown !== 'string' || !resp.markdown) {
        resolve(null);
      } else {
        resolve({ title: String(resp.title ?? ''), markdown: resp.markdown });
      }
    });
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',');
  const mime = /data:(.*?)(;|$)/.exec(head)?.[1] ?? 'image/png';
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const tabId = tab.id;
  const pageTitle = tab.title ?? '';
  const pageUrl = info.pageUrl ?? tab.url ?? '';

  void (async () => {
    switch (info.menuItemId) {
      case 'save-selection': {
        const text = info.selectionText?.trim();
        if (!text) return;
        await quick(`${text}\n\n${sourceLine(pageTitle, pageUrl)}`);
        break;
      }
      case 'save-link': {
        const linkUrl = info.linkUrl;
        if (!linkUrl) return;
        const text = (await queryAnchorText(tabId, linkUrl)) || linkUrl;
        await quick(`[${text}](${linkUrl})\n\n${sourceLine(pageTitle, pageUrl)}`);
        break;
      }
      case 'clip-page': {
        const clip = await requestClip(tabId);
        // 正文提取失败不是连接问题：只亮红角标，不开选项页
        if (!clip) {
          console.warn('[PinSlip]', msg('clipFailed'));
          flashBadge('✗', '#cf222e', 3000);
          return;
        }
        await createInboxNote(clip.title || pageTitle, `${clip.markdown}\n\n${sourceLine(pageTitle, pageUrl)}`);
        break;
      }
      case 'save-screenshot': {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const { path } = await uploadImage(dataUrlToBlob(dataUrl), '.png');
        // 便签落 inbox/，markdown 里附件写相对笔记文件的路径：../attachments/<name>
        const content = `![](../${path})\n\n${sourceLine(pageTitle, pageUrl)}`;
        await createInboxNote(msg('screenshotTitle', { title: pageTitle }), content);
        break;
      }
    }
  })()
    .then(reportSuccess)
    .catch(reportFailure);
});
