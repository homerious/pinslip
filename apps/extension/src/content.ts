// content script：两个职责——
//  1) 记录最后一次 contextmenu 命中的锚点（background 拿链接文字，OnClickData 不带文本）；
//  2) 响应剪藏请求：@mozilla/readability 提取正文，turndown 转 Markdown。
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

let lastAnchor: { href: string; text: string } | null = null;

document.addEventListener(
  'contextmenu',
  (ev) => {
    const a = (ev.target as Element | null)?.closest?.('a[href]');
    if (a) {
      lastAnchor = {
        href: (a as HTMLAnchorElement).href,
        text: (a.textContent ?? '').trim(),
      };
    } else {
      lastAnchor = null;
    }
  },
  true,
);

function clipArticle(): { title: string; markdown: string } | null {
  // Readability 会改写 DOM，必须传克隆文档
  const doc = document.cloneNode(true) as Document;
  const article = new Readability(doc).parse();
  if (!article || !article.content) return null;
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const markdown = td.turndown(article.content).trim();
  if (!markdown) return null;
  return {
    title: (article.title || document.title || '').trim(),
    markdown,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'pinslip:anchor-text') {
    // 仅当记录的锚点与 background 给的 linkUrl 一致才采信文字
    sendResponse(
      lastAnchor && lastAnchor.href === message.linkUrl ? { text: lastAnchor.text } : {},
    );
    return false;
  }
  if (message?.type === 'pinslip:clip') {
    try {
      sendResponse(clipArticle() ?? {});
    } catch {
      sendResponse({});
    }
    return false;
  }
  return false;
});
