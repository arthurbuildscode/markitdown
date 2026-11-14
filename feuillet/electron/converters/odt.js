'use strict';
/**
 * Conversion OpenDocument Texte (.odt) → HTML simple.
 * Couvre le texte, les titres, gras/italique/souligné/barré, taille et couleur,
 * l'alignement, les listes et les tableaux. Les images, en-têtes et pieds de
 * page ne sont pas repris.
 */
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function children(node) {
  const out = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

/** Lit les styles automatiques et nommés : nom → propriétés utiles. */
function collectStyles(doc, styles) {
  const nodes = doc.getElementsByTagName('style:style');
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const name = node.getAttribute('style:name');
    if (!name) continue;
    const style = { parent: node.getAttribute('style:parent-style-name') || null };
    const text = node.getElementsByTagName('style:text-properties')[0];
    if (text) {
      if (text.getAttribute('fo:font-weight') === 'bold') style.bold = true;
      if (text.getAttribute('fo:font-style') === 'italic') style.italic = true;
      const underline = text.getAttribute('style:text-underline-style');
      if (underline && underline !== 'none') style.underline = true;
      const strike = text.getAttribute('style:text-line-through-style');
      if (strike && strike !== 'none') style.strike = true;
      const size = text.getAttribute('fo:font-size');
      if (size && /pt$/.test(size)) style.size = size;
      const color = text.getAttribute('fo:color');
      if (color && /^#[0-9a-f]{6}$/i.test(color)) style.color = color;
      const position = text.getAttribute('style:text-position') || '';
      if (/^super/.test(position)) style.sup = true;
      if (/^sub/.test(position)) style.sub = true;
    }
    const para = node.getElementsByTagName('style:paragraph-properties')[0];
    if (para) {
      const align = para.getAttribute('fo:text-align');
      if (align) {
        style.align = { start: 'left', end: 'right', center: 'center', justify: 'justify' }[align] || align;
      }
    }
    styles.set(name, style);
  }
  const lists = doc.getElementsByTagName('text:list-style');
  for (let i = 0; i < lists.length; i++) {
    const first = children(lists[i]).find((c) => c.nodeType === 1);
    styles.set(`list:${lists[i].getAttribute('style:name')}`, {
      ordered: !!first && first.nodeName === 'text:list-level-style-number',
    });
  }
}

function resolve(styles, name) {
  const merged = {};
  const seen = new Set();
  const chain = [];
  for (let n = name; n && styles.has(n) && !seen.has(n); n = styles.get(n).parent) {
    seen.add(n);
    chain.unshift(styles.get(n));
  }
  for (const s of chain) Object.assign(merged, s);
  return merged;
}

function wrapInline(html, style) {
  if (!html) return html;
  const css = [];
  if (style.size) css.push(`font-size:${style.size}`);
  if (style.color && style.color.toLowerCase() !== '#000000') css.push(`color:${style.color}`);
  if (css.length) html = `<span style="${css.join(';')}">${html}</span>`;
  if (style.sup) html = `<sup>${html}</sup>`;
  if (style.sub) html = `<sub>${html}</sub>`;
  if (style.strike) html = `<s>${html}</s>`;
  if (style.underline) html = `<u>${html}</u>`;
  if (style.italic) html = `<em>${html}</em>`;
  if (style.bold) html = `<strong>${html}</strong>`;
  return html;
}

function inline(node, styles) {
  let out = '';
  for (const c of children(node)) {
    if (c.nodeType === 3) {
      out += esc(c.nodeValue);
      continue;
    }
    if (c.nodeType !== 1) continue;
    switch (c.nodeName) {
      case 'text:span':
        out += wrapInline(inline(c, styles), resolve(styles, c.getAttribute('text:style-name')));
        break;
      case 'text:a': {
        const href = c.getAttribute('xlink:href') || '';
        const safe = /^(https?:|mailto:)/i.test(href);
        out += safe ? `<a href="${esc(href).replace(/"/g, '&quot;')}">${inline(c, styles)}</a>` : inline(c, styles);
        break;
      }
      case 'text:s':
        out += '&nbsp;'.repeat(Math.max(1, parseInt(c.getAttribute('text:c') || '1', 10) || 1));
        break;
      case 'text:tab':
        out += '&#9;';
        break;
      case 'text:line-break':
        out += '<br>';
        break;
      case 'text:note':
      case 'office:annotation':
      case 'text:tracked-changes':
        break;
      default:
        out += inline(c, styles);
    }
  }
  return out;
}

function paragraph(node, styles, tag) {
  const style = resolve(styles, node.getAttribute('text:style-name'));
  const align = style.align && style.align !== 'left' ? ` style="text-align:${style.align}"` : '';
  // Dans un titre, le gras du style est implicite.
  const content = tag === 'p' ? wrapInline(inline(node, styles), style) : inline(node, styles);
  return `<${tag}${align}>${content}</${tag}>`;
}

function block(node, styles, listStyle) {
  return blockNodes(children(node), styles, listStyle);
}

function blockNodes(nodes, styles, listStyle) {
  let out = '';
  for (const c of nodes) {
    if (c.nodeType !== 1) continue;
    switch (c.nodeName) {
      case 'text:h': {
        const level = Math.min(6, Math.max(1, parseInt(c.getAttribute('text:outline-level') || '1', 10) || 1));
        out += paragraph(c, styles, `h${level}`);
        break;
      }
      case 'text:p':
        out += paragraph(c, styles, 'p');
        break;
      case 'text:list': {
        const name = c.getAttribute('text:style-name') || listStyle;
        const ordered = !!(styles.get(`list:${name}`) || {}).ordered;
        const tag = ordered ? 'ol' : 'ul';
        let items = '';
        for (const item of children(c)) {
          if (item.nodeType !== 1 || !/^text:list-(item|header)$/.test(item.nodeName)) continue;
          items += `<li>${listItem(item, styles, name)}</li>`;
        }
        out += `<${tag}>${items}</${tag}>`;
        break;
      }
      case 'table:table': {
        let rows = '';
        const rowNodes = c.getElementsByTagName('table:table-row');
        for (let r = 0; r < rowNodes.length; r++) {
          // Les lignes des tableaux imbriqués sont rendues avec leur propre tableau.
          let owner = rowNodes[r].parentNode;
          while (owner && owner.nodeName !== 'table:table') owner = owner.parentNode;
          if (owner !== c) continue;
          let cells = '';
          for (const cell of children(rowNodes[r])) {
            if (cell.nodeType !== 1 || cell.nodeName !== 'table:table-cell') continue;
            const span = parseInt(cell.getAttribute('table:number-columns-spanned') || '1', 10) || 1;
            cells += `<td${span > 1 ? ` colspan="${span}"` : ''}>${block(cell, styles) || '<p></p>'}</td>`;
          }
          if (cells) rows += `<tr>${cells}</tr>`;
        }
        if (rows) out += `<table>${rows}</table>`;
        break;
      }
      case 'text:section':
      case 'text:index-body':
      case 'text:table-of-content':
      case 'text:tracked-changes':
        if (c.nodeName !== 'text:tracked-changes') out += block(c, styles, listStyle);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Contenu d'un élément de liste : le premier paragraphe est mis à plat dans le <li>. */
function listItem(item, styles, listStyle) {
  let out = '';
  let first = true;
  for (const c of children(item)) {
    if (c.nodeType !== 1) continue;
    if (first && (c.nodeName === 'text:p' || c.nodeName === 'text:h')) {
      out += wrapInline(inline(c, styles), resolve(styles, c.getAttribute('text:style-name')));
    } else {
      out += blockNodes([c], styles, listStyle);
    }
    first = false;
  }
  return out;
}

async function odtToHtml(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const contentEntry = zip.file('content.xml');
  if (!contentEntry) throw new Error("Ce fichier .odt est illisible (contenu introuvable).");
  if (zip.file('META-INF/manifest.xml')) {
    const manifest = await zip.file('META-INF/manifest.xml').async('string');
    if (manifest.includes('manifest:encryption-data')) {
      throw new Error('Ce fichier .odt est protégé par mot de passe.');
    }
  }
  const parser = new DOMParser({ onError: () => {} });
  const styles = new Map();
  const stylesEntry = zip.file('styles.xml');
  if (stylesEntry) collectStyles(parser.parseFromString(await stylesEntry.async('string'), 'text/xml'), styles);
  const doc = parser.parseFromString(await contentEntry.async('string'), 'text/xml');
  collectStyles(doc, styles);
  const body = doc.getElementsByTagName('office:text')[0];
  if (!body) throw new Error("Ce fichier n'est pas un document texte OpenDocument.");
  return block(body, styles) || '<p></p>';
}

module.exports = { odtToHtml };
