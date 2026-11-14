'use strict';
/**
 * Import de fichiers : tout format pris en charge est ramené à un .docx en
 * mémoire, seul format que l'éditeur manipule nativement.
 *
 *  - .docx / .docm            → lus tels quels (format natif)
 *  - .dotx / .dotm            → modèles : type de contenu corrigé, ouverts comme nouveau document
 *  - .doc / .rtf / .odt / .txt / .md / .html → convertis en HTML puis en .docx
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const NATIVE_EXTENSIONS = ['docx', 'docm'];
const TEMPLATE_EXTENSIONS = ['dotx', 'dotm'];
const CONVERTED_EXTENSIONS = ['doc', 'dot', 'rtf', 'odt', 'txt', 'md', 'markdown', 'html', 'htm'];
const OPEN_EXTENSIONS = [...NATIVE_EXTENSIONS, ...TEMPLATE_EXTENSIONS, ...CONVERTED_EXTENSIONS];

const OPEN_FILTERS = [
  { name: 'Tous les documents', extensions: OPEN_EXTENSIONS },
  { name: 'Documents Word', extensions: ['docx', 'docm', 'doc', 'dotx', 'dotm', 'dot'] },
  { name: 'Texte OpenDocument', extensions: ['odt'] },
  { name: 'Texte enrichi (RTF)', extensions: ['rtf'] },
  { name: 'Texte brut et Markdown', extensions: ['txt', 'md', 'markdown'] },
  { name: 'Pages web', extensions: ['html', 'htm'] },
  { name: 'Tous les fichiers', extensions: ['*'] },
];

/** A4, marges de 2,5 cm (unités : twips). */
const PAGE = { width: 11906, height: 16838, margin: 1417 };

function extensionOf(filePath) {
  return path.extname(filePath).slice(1).toLowerCase();
}

function isSupported(filePath) {
  return OPEN_EXTENSIONS.includes(extensionOf(filePath));
}

/** Identifie le format réel d'après le contenu, l'extension pouvant mentir. */
function sniff(buffer, ext) {
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip';
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0xd0cf11e0) return 'ole';
  if (buffer.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  return ext;
}

function decodeText(buffer) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textToHtml(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `<p>${escapeHtml(line).replace(/\t/g, '&#9;') || ''}</p>`)
    .join('');
}

/** Retire ce qui n'a pas sa place dans un document : scripts, styles, cadres. */
function sanitizeHtml(html) {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return (body ? body[1] : html)
    .replace(/<(script|style|iframe|object|embed|noscript|template|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed|link|meta|base)\b[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Les images distantes ou locales ne sont pas récupérées : seules les images intégrées sont gardées.
    .replace(/<img\b(?![^>]*\ssrc\s*=\s*["']?data:image\/)[^>]*>/gi, '');
}

async function htmlToDocx(html) {
  const HTMLtoDOCX = require('@turbodocx/html-to-docx');
  const result = await HTMLtoDOCX(sanitizeHtml(html) || '<p></p>', null, {
    orientation: 'portrait',
    pageSize: { width: PAGE.width, height: PAGE.height },
    margins: {
      top: PAGE.margin,
      right: PAGE.margin,
      bottom: PAGE.margin,
      left: PAGE.margin,
      header: 708,
      footer: 708,
      gutter: 0,
    },
    font: 'Calibri',
    fontSize: 22,
    lang: 'fr-FR',
    table: { row: { cantSplit: true }, borderOptions: { size: 4, stroke: 'single', color: '000000' } },
  });
  return Buffer.isBuffer(result) ? result : Buffer.from(await result.arrayBuffer());
}

/** Un modèle (.dotx/.dotm) devient un document ordinaire en changeant son type de contenu. */
async function templateToDocument(buffer) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file('[Content_Types].xml');
  if (!entry) return buffer;
  const xml = await entry.async('string');
  const fixed = xml
    .replace(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    )
    .replace(
      'application/vnd.ms-word.template.macroEnabledTemplate.main+xml',
      'application/vnd.ms-word.document.macroEnabled.main+xml',
    );
  if (fixed === xml) return buffer;
  zip.file('[Content_Types].xml', fixed);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function zipKind(buffer) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  if (zip.file('word/document.xml')) return 'docx';
  if (zip.file('content.xml')) return 'odt';
  return 'unknown';
}

/**
 * @returns {Promise<{ data: Buffer, native: boolean, format: string }>}
 *   `native` : le fichier d'origine est un .docx que l'on peut réécrire en place.
 */
async function importBuffer(buffer, ext) {
  let kind = sniff(buffer, ext);
  if (kind === 'zip') {
    try {
      kind = await zipKind(buffer);
    } catch {
      throw new Error('Ce fichier est endommagé : son contenu est illisible.');
    }
  } else if ([...NATIVE_EXTENSIONS, ...TEMPLATE_EXTENSIONS, 'odt'].includes(kind)) {
    // L'extension annonce un format compressé, mais le contenu n'en est pas un.
    throw new Error("Ce fichier n'est pas un document valide : il est vide ou endommagé.");
  }
  if (kind === 'ole' || kind === 'dot') kind = 'doc';

  switch (kind) {
    case 'docx': {
      if (TEMPLATE_EXTENSIONS.includes(ext)) {
        return { data: await templateToDocument(buffer), native: false, format: ext };
      }
      // Un .docx renommé (.doc, .rtf…) reste lisible, mais on ne réécrit pas sous cette extension.
      return { data: buffer, native: NATIVE_EXTENSIONS.includes(ext), format: 'docx' };
    }
    case 'odt': {
      const { odtToHtml } = require('./odt');
      return { data: await htmlToDocx(await odtToHtml(buffer)), native: false, format: 'odt' };
    }
    case 'doc': {
      const { docToHtml } = require('./doc');
      return { data: await htmlToDocx(await docToHtml(buffer)), native: false, format: 'doc' };
    }
    case 'rtf': {
      const { rtfToHtml } = require('./rtf');
      return { data: await htmlToDocx(await rtfToHtml(buffer)), native: false, format: 'rtf' };
    }
    case 'md':
    case 'markdown': {
      const { marked } = require('marked');
      const html = await marked.parse(decodeText(buffer));
      return { data: await htmlToDocx(html), native: false, format: 'md' };
    }
    case 'html':
    case 'htm':
      return { data: await htmlToDocx(decodeText(buffer)), native: false, format: 'html' };
    case 'txt':
      return { data: await htmlToDocx(textToHtml(decodeText(buffer))), native: false, format: 'txt' };
    default:
      throw new Error("Ce format de fichier n'est pas pris en charge.");
  }
}

async function importFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return importBuffer(buffer, extensionOf(filePath));
}

module.exports = {
  OPEN_EXTENSIONS,
  OPEN_FILTERS,
  PAGE,
  extensionOf,
  isSupported,
  importFile,
  importBuffer,
  htmlToDocx,
  textToHtml,
};
