import { attachmentsApi } from '../../api/attachments';

/**
 * 编辑器图片支持（粘贴上传 + 相对路径显示）：
 * - markdown 里存 **相对笔记文件** 的路径 `![](../attachments/att-xxx.png)`——
 *   相对路径是相对 md 文件所在目录解析的（标准 markdown 语义），
 *   notes/ 与 inbox/ 同为一级目录，所以 `../` 前缀恒定；
 *   Obsidian / VS Code / Typora 等任何查看器都能正确解析；
 * - 显示层把 attachments/ 前缀改写为 pinslip-img:// 自定义协议（主进程从 vault 读图），
 *   避开 Go 服务随机端口写进 markdown 会过期的问题；
 * - 待办：嵌套文件夹上线后，../ 前缀需按笔记所在深度生成。
 */

const ATTACH_PROTOCOL = 'pinslip-img://';

/** 把服务端返回的 vault 相对路径（attachments/<name>）转成写进 markdown 的相对路径。
 *  相对路径相对 md 文件所在目录解析：notes/ 根的笔记用 `../attachments/…`，
 *  嵌套文件夹 notes/a/b/ 下的笔记按深度补 `../../../attachments/…`。 */
export function toMarkdownImageSrc(vaultRelPath: string, folder = ''): string {
  const depth = folder ? folder.split('/').length : 0;
  return '../'.repeat(depth + 1) + vaultRelPath;
}

/** 显示用地址解析：vault 附件相对路径 → 自定义协议；其余（http/data 等）原样返回。
 *  兼容任意深度 `../` 前缀（嵌套文件夹）与无前缀旧写法 */
export function resolveImageSrc(src: string): string {
  const m = /^(?:\.\.\/)+(attachments\/.*)$/.exec(src);
  if (m) return ATTACH_PROTOCOL + m[1];
  if (src.startsWith('attachments/')) return ATTACH_PROTOCOL + src;
  return src;
}

/** 粘贴处理：剪贴板含图片文件时上传 vault 并插入 image 节点。
 *  folder = 笔记所在子文件夹（notes/ 相对路径），决定写进 markdown 的 ../ 前缀深度。
 *  返回 true 表示已接管；无图片返回 false 走默认粘贴逻辑。
 *  view 用 any：editorViewOptionsCtx 是无类型 slice，仅为类型引入 prosemirror 依赖不值当 */
export function handleImagePaste(folder = '') {
  return (view: any, event: ClipboardEvent): boolean => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith('image/'),
    );
    if (files.length === 0) return false;
    event.preventDefault();
    void (async () => {
      for (const file of files) {
        const res = await attachmentsApi.upload(file).catch(() => null);
        if (!res) continue;
        const imageNode = view.state.schema.nodes.image.create({
          src: toMarkdownImageSrc(res.path, folder), // 相对笔记文件的路径，外部查看器可解析
        });
        view.dispatch(view.state.tr.replaceSelectionWith(imageNode));
      }
    })();
    return true;
  };
}

interface ImageNodeLike {
  type: unknown;
  attrs: { src?: string; alt?: string; title?: string };
}

/** image 节点 nodeview：leaf 节点无 contentDOM，渲染 <img> 并按需改写 src */
export function createImageView(initialNode: ImageNodeLike) {
  let node = initialNode;
  const img = document.createElement('img');
  img.className = 'pinslip-editor-image';
  const sync = (): void => {
    img.src = resolveImageSrc(String(node.attrs.src ?? ''));
    img.alt = String(node.attrs.alt ?? '');
    img.title = String(node.attrs.title ?? '');
  };
  sync();
  return {
    dom: img,
    update(updated: ImageNodeLike) {
      if (updated.type !== node.type) return false;
      node = updated;
      sync();
      return true;
    },
  };
}
