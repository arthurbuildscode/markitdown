import { renderAllPagesNow } from '@eigenpal/docx-editor-core/layout-painter';

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Construit une page HTML autonome contenant toutes les pages du document
 * telles que l'éditeur les affiche. Elle sert à l'impression et à l'export PDF,
 * réalisés par le processus principal dans une fenêtre cachée.
 */
export async function buildPrintHtml(root: ParentNode, title: string): Promise<string | null> {
  const pages = root.querySelector<HTMLElement>('.paged-editor__pages');
  if (!pages) return null;
  // L'éditeur ne dessine que les pages visibles : on force le rendu de toutes.
  renderAllPagesNow(pages);

  const clone = pages.cloneNode(true) as HTMLElement;
  clone.style.cssText = 'display:block;margin:0;padding:0;';
  let size = '';
  clone.querySelectorAll<HTMLElement>('.layout-page').forEach((page, index) => {
    page.style.boxShadow = 'none';
    page.style.margin = '0';
    if (index === 0 && page.style.width && page.style.height) {
      size = `${page.style.width} ${page.style.height}`;
    }
  });

  // Les images « blob: » n'existent que dans cette fenêtre : on les intègre au document.
  await Promise.all(
    Array.from(clone.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')).map(async (img) => {
      try {
        img.src = await blobToDataUrl(await (await fetch(img.src)).blob());
      } catch {
        img.removeAttribute('src');
      }
    }),
  );

  const fontFaces: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSFontFaceRule) fontFaces.push(rule.cssText);
      }
    } catch {
      // Feuille de style inaccessible : sans incidence sur le rendu des pages.
    }
  }

  const doc = document.implementation.createHTMLDocument(title);
  const meta = doc.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  doc.head.prepend(meta);
  const style = doc.createElement('style');
  style.textContent = [
    '* { margin: 0; padding: 0; }',
    'html, body { background: white; }',
    '.layout-page { break-after: page; overflow: hidden; }',
    '.layout-page:last-child { break-after: auto; }',
    `@page { margin: 0; size: ${size || 'A4'}; }`,
    ...fontFaces,
  ].join('\n');
  doc.head.appendChild(style);
  doc.body.appendChild(doc.importNode(clone, true));
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}
