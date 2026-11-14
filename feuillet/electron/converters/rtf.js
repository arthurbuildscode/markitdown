'use strict';
/**
 * Conversion RTF → HTML simple (fragment de corps), sans dépendance.
 * Couvre le texte et son encodage (pages de codes, \u), gras/italique/souligné/
 * barré, exposant/indice, taille et couleur, l'alignement, les titres, les
 * listes, les tableaux, les liens et les images PNG/JPEG intégrées. Les en-têtes,
 * pieds de page, notes, objets OLE et images vectorielles (WMF/EMF) ne sont pas repris.
 *
 * L'analyse se fait en une passe sur les octets, avec une pile d'états explicite :
 * pas de récursion sur les groupes, donc pas de limite de profondeur ni de coût
 * quadratique sur les gros fichiers.
 */

// Destinations : ce que devient le texte rencontré dans le groupe courant.
const D_BODY = 0;
const D_FONTTBL = 1;
const D_COLORTBL = 2;
const D_STYLESHEET = 3;
const D_LISTTABLE = 4;
const D_LISTOVERRIDE = 5;
const D_LISTTEXT = 6;
const D_FLDINST = 7;
const D_PICT = 8;
const D_SHP = 9;
const D_PN = 10;
// Pseudo-destinations : mots reconnus qui ne changent pas forcément l'état.
const X_SKIP = 20;
const X_KEEP = 21;
const X_FLDRSLT = 22;
const X_SHPTXT = 23;

const DESTS = new Map();
for (const word of (
  'header headerl headerr headerf footer footerl footerr footerf footnote info nonshppict shprslt ' +
  'nonesttables upr xe tc rxe txe objdata objclass objname objalias objsect themedata ' +
  'colorschememapping datastore latentstyles generator template filetbl revtbl rsidtbl pgptbl ' +
  'annotation atnid atnauthor atndate atntime atnref atnicn atnparent atrfstart atrfend bkmkstart ' +
  'bkmkend falt panose fname ftnsep ftnsepc ftncn aftnsep aftnsepc aftncn keycode formfield ' +
  'datafield pnseclvl mmathPr xmlnstbl userprops private background wgrffmtfilter pgdsctbl docvar ' +
  'picprop blipuid htmltag mhtmltag levelmarker expandedcolortbl listpicture do'
).split(' ')) {
  DESTS.set(word, X_SKIP);
}
DESTS.set('fonttbl', D_FONTTBL);
DESTS.set('colortbl', D_COLORTBL);
DESTS.set('stylesheet', D_STYLESHEET);
DESTS.set('listtable', D_LISTTABLE);
DESTS.set('listoverridetable', D_LISTOVERRIDE);
DESTS.set('listtext', D_LISTTEXT);
DESTS.set('pntext', D_LISTTEXT);
DESTS.set('fldinst', D_FLDINST);
DESTS.set('fldrslt', X_FLDRSLT);
DESTS.set('pict', D_PICT);
DESTS.set('shpinst', D_SHP);
DESTS.set('shptxt', X_SHPTXT);
DESTS.set('pn', D_PN);
DESTS.set('shppict', X_KEEP);
DESTS.set('result', X_KEEP);

/** Destinations dont le texte brut est simplement ignoré. */
const DROPS_TEXT = [];
DROPS_TEXT[D_LISTTABLE] = DROPS_TEXT[D_LISTOVERRIDE] = DROPS_TEXT[D_SHP] = DROPS_TEXT[D_PN] = true;

// Après \uN, ces mots ne peuvent pas être le caractère de repli : certains
// générateurs omettent le repli, et avaler un \par casserait la structure.
const NOT_FALLBACK = new Set(['u', 'uc', 'par', 'cell', 'row', 'pard', 'sect', 'line', 'tab']);

const UNDERLINES = new Set(
  ('ul uld uldb ulw uldash uldashd uldashdd ulth ulwave ulhwave ulldash ululdbwave ulthd ' +
    'ulthdash ulthdashd ulthdashdd ulthldash').split(' '),
);

const SPECIAL_CHARS = {
  emdash: '\u2014',
  endash: '\u2013',
  lquote: '\u2018',
  rquote: '\u2019',
  ldblquote: '\u201c',
  rdblquote: '\u201d',
  bullet: '\u2022',
  emspace: '\u2003',
  enspace: '\u2002',
  qmspace: '\u2005',
  zwj: '\u200d',
  zwnj: '\u200c',
  tab: '\t',
  line: '\n',
  lbr: '\n',
};

const PN_ORDERED = new Set(['pnlvlbody', 'pndec', 'pnucltr', 'pnlcltr', 'pnucrm', 'pnlcrm', 'pnord', 'pnordt', 'pncard']);

const HEADING_NAME = /^(?:heading|titre|überschrift|ueberschrift|título|titulo|titolo|kop|rubrik|overskrift)\s*([1-9])$/i;
// « o » seul est une puce courante (Courier New) : une lettre n'est un numéro que suivie d'un point ou d'une parenthèse.
const ORDERED_MARKER = /^\(?(?:\d+(?:\.\d+)*[.):]?|[A-Za-z]{1,6}[.)])/;
const LINK_SCHEME = /^(?:https?:\/\/|mailto:)/i;
const MAX_IMAGE_WIDTH = 600;

const HEX = new Int8Array(256).fill(-1);
for (let k = 0; k < 10; k++) HEX[0x30 + k] = k;
for (let k = 0; k < 6; k++) HEX[0x41 + k] = HEX[0x61 + k] = 10 + k;

/* ------------------------------------------------------------------ */
/* Pages de codes                                                      */
/* ------------------------------------------------------------------ */

const CP_LABELS = {
  874: 'windows-874',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  866: 'ibm866',
  10000: 'macintosh',
  10007: 'x-mac-cyrillic',
  20866: 'koi8-r',
  21866: 'koi8-u',
  28592: 'iso-8859-2',
  28595: 'iso-8859-5',
  28597: 'iso-8859-7',
  28605: 'iso-8859-15',
};
const DOUBLE_BYTE = new Set([932, 936, 949, 950]);

// \fcharsetN → page de codes ; 1 (défaut) et 2 (symbole) suivent celle du document.
const CHARSET_CP = {
  0: 1252, 77: 10000, 128: 932, 129: 949, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258,
  177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250, 254: 437, 255: 850,
};

// Moitiés hautes des pages DOS (\pc, \pca), absentes de TextDecoder.
const DOS_HIGH = {
  437:
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
    'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0',
  850:
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' +
    'ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0',
};
// Secours si l'exécutable n'embarque pas le décodeur windows-1252.
const CP1252_C1 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

const codePages = new Map();

/** @returns {{ cp: number, sb: string[] | null, dec: TextDecoder | null }} */
function codePage(cp) {
  let page = codePages.get(cp);
  if (page) return page;
  let high = DOS_HIGH[cp] || null;
  let dec = null;
  if (!high) {
    try {
      dec = new TextDecoder(CP_LABELS[cp] || 'windows-1252');
    } catch {
      try {
        dec = new TextDecoder('windows-1252');
      } catch {
        high = CP1252_C1 + Buffer.from(Array.from({ length: 96 }, (_, k) => 0xa0 + k)).toString('latin1');
      }
    }
  }
  if (dec && DOUBLE_BYTE.has(cp) && CP_LABELS[cp] === dec.encoding) {
    page = { cp, sb: null, dec };
  } else {
    const sb = new Array(256);
    for (let v = 0; v < 256; v++) {
      let ch;
      if (v < 0x80) ch = String.fromCharCode(v);
      else ch = high ? high[v - 0x80] : dec.decode(Uint8Array.of(v));
      const code = ch.charCodeAt(0);
      // Caractères de contrôle et octets non attribués : rien à afficher.
      if ((code < 0x20 && code !== 9) || (code >= 0x7f && code < 0xa0) || code === 0xfffd) ch = '';
      sb[v] = ch;
    }
    page = { cp, sb, dec: null };
  }
  codePages.set(cp, page);
  return page;
}

function isLeadByte(cp, v) {
  if (cp === 932) return (v >= 0x81 && v <= 0x9f) || (v >= 0xe0 && v <= 0xfc);
  return v >= 0x81 && v <= 0xfe;
}

/* ------------------------------------------------------------------ */
/* Rendu HTML                                                          */
/* ------------------------------------------------------------------ */

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
// Caractères interdits en XML : ils rendraient le .docx illisible.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ufffe\uffff]/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\t': '&#9;', '\n': '<br>' };

function escText(text) {
  return text
    .replace(LONE_SURROGATE, '')
    .replace(FORBIDDEN, '')
    // En RTF chaque espace compte ; en HTML une suite d'espaces n'en vaut qu'un.
    .replace(/ {2,}/g, (spaces) => ` ${'\u00a0'.repeat(spaces.length - 1)}`)
    .replace(/[&<>\t\n]/g, (ch) => ESCAPES[ch]);
}

/**
 * Adresse d'un lien, prête pour un attribut entre guillemets. Le « & » reste
 * tel quel : html-to-docx ne décode pas les entités des attributs, « &amp; »
 * finirait littéralement dans l'adresse.
 */
function escUrl(url) {
  return url
    .replace(LONE_SURROGATE, '')
    .replace(FORBIDDEN, '')
    .replace(/["<>\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`);
}

/**
 * Chaîne de balises d'un format, de l'extérieur vers l'intérieur ; dans un
 * titre, gras et taille sont implicites.
 */
function chainOf(fmt, heading) {
  const slot = heading ? 'chainHeading' : 'chain';
  if (fmt[slot]) return fmt[slot];
  const chain = [];
  if (fmt.href) chain.push({ open: `<a href="${escUrl(fmt.href)}">`, close: '</a>', link: true });
  const styles = [];
  if (!heading && fmt.fs) styles.push(`font-size:${fmt.fs / 2}pt`);
  if (fmt.color) styles.push(`color:${fmt.color}`);
  if (fmt.bg) styles.push(`background-color:${fmt.bg}`);
  if (fmt.font) styles.push(`font-family:'${fmt.font}'`);
  if (styles.length) chain.push({ open: `<span style="${styles.join(';')}">`, close: '</span>' });
  const tag = (name) => chain.push({ open: `<${name}>`, close: `</${name}>` });
  if (fmt.b && !heading) tag('strong');
  if (fmt.i) tag('em');
  if (fmt.ul) tag('u');
  if (fmt.strike) tag('s');
  if (fmt.va === 1) tag('sup');
  else if (fmt.va === 2) tag('sub');
  return (fmt[slot] = chain);
}

function hasContent(runs) {
  for (const run of runs) if (run.img || /[^\s]/.test(run.t)) return true;
  return false;
}

function renderInline(runs, heading) {
  if (!hasContent(runs)) return '';
  let out = '';
  let text = '';
  const open = [];
  const closeTo = (depth) => {
    out += escText(text);
    text = '';
    while (open.length > depth) out += open.pop().close;
  };
  for (const run of runs) {
    if (run.img) {
      closeTo(0);
      out += run.img;
      continue;
    }
    // On garde ouvertes les balises encore valables et on n'ouvre que celles
    // qui manquent : les passages voisins fusionnent, les autres s'imbriquent.
    const chain = chainOf(run.f, heading);
    let keep = 0;
    while (keep < open.length && chain.some((el) => el.open === open[keep].open)) keep++;
    // Un lien enveloppe toujours les autres balises.
    if (chain.length && chain[0].link && !(keep && open[0].open === chain[0].open)) keep = 0;
    if (keep !== open.length || keep !== chain.length) {
      closeTo(keep);
      for (const el of chain) {
        if (open.some((kept) => kept.open === el.open)) continue;
        out += el.open;
        open.push(el);
      }
    }
    text += run.t;
  }
  closeTo(0);
  return out;
}

/**
 * Position d'un élément de liste par rapport à la liste ouverte : -1 moins
 * profond, 0 même niveau, 1 plus profond. Les niveaux (\ilvl) ne se comparent
 * qu'au sein d'une même liste ; entre deux listes, seul le retrait renseigne.
 */
function listDepth(item, open) {
  if (item.ls === open.ls) return Math.sign(item.ilvl - open.ilvl);
  const delta = item.li - open.li;
  return Math.abs(delta) <= 100 ? 0 : Math.sign(delta);
}

function renderBlocks(blocks, out) {
  const lists = [];
  const closeLists = () => {
    while (lists.length) out.push(`</li></${lists.pop().tag}>`);
  };
  for (const block of blocks) {
    if (block.rows) {
      closeLists();
      let columns = 0;
      for (const row of block.rows) columns = Math.max(columns, row.length);
      out.push('<table>');
      for (const row of block.rows) {
        out.push('<tr>');
        for (let c = 0; c < columns; c++) {
          out.push('<td>');
          // Grille complétée : le convertisseur DOCX attend des lignes de même longueur.
          if (c < row.length && row[c].length) renderBlocks(row[c], out);
          else out.push('<p></p>');
          out.push('</td>');
        }
        out.push('</tr>');
      }
      out.push('</table>');
    } else if (block.list) {
      const item = block.list;
      const tag = item.ordered ? 'ol' : 'ul';
      while (lists.length && listDepth(item, lists[lists.length - 1]) < 0) {
        out.push(`</li></${lists.pop().tag}>`);
      }
      const top = lists[lists.length - 1];
      if (top && listDepth(item, top) === 0) {
        // Même niveau : on continue la liste, sauf changement de type ou nouvelle liste de premier niveau.
        if (top.tag === tag && (top.ls === item.ls || lists.length > 1)) {
          out.push('</li>');
        } else {
          out.push(`</li></${top.tag}><${tag}>`);
        }
        lists.pop();
      } else {
        out.push(`<${tag}>`);
      }
      lists.push({ tag, ls: item.ls, ilvl: item.ilvl, li: item.li });
      out.push('<li>', renderInline(block.runs, false));
    } else {
      closeLists();
      const inline = renderInline(block.runs, block.h > 0);
      const tag = block.h && inline ? `h${block.h}` : 'p';
      const align = block.align ? ` style="text-align:${block.align}"` : '';
      out.push(`<${tag}${align}>`, inline, `</${tag}>`);
    }
  }
  closeLists();
}

/* ------------------------------------------------------------------ */
/* Analyse                                                             */
/* ------------------------------------------------------------------ */

function newState() {
  return {
    dest: D_BODY,
    uc: 1,
    // Caractère
    font: -1,
    cp: null,
    b: false,
    i: false,
    ul: false,
    strike: false,
    caps: false,
    va: 0,
    fs: 0,
    cf: 0,
    hl: 0,
    hidden: 0,
    href: '',
    fmt: null,
    // Paragraphe
    align: '',
    s: 0,
    outline: -1,
    intbl: false,
    ls: 0,
    ilvl: 0,
    li: 0,
    pn: 0,
  };
}

function cloneState(s) {
  return {
    dest: s.dest,
    uc: s.uc,
    font: s.font,
    cp: s.cp,
    b: s.b,
    i: s.i,
    ul: s.ul,
    strike: s.strike,
    caps: s.caps,
    va: s.va,
    fs: s.fs,
    cf: s.cf,
    hl: s.hl,
    hidden: s.hidden,
    href: s.href,
    fmt: s.fmt,
    align: s.align,
    s: s.s,
    outline: s.outline,
    intbl: s.intbl,
    ls: s.ls,
    ilvl: s.ilvl,
    li: s.li,
    pn: s.pn,
  };
}

/**
 * @param {Buffer | Uint8Array} input contenu du fichier .rtf
 * @param {{ fonts?: boolean }} [options] `fonts` : émettre aussi les polices (font-family)
 * @returns {string} fragment HTML (sans <html>/<body>)
 */
function rtfToHtml(input, options) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const n = b.length;
  const useFonts = !!(options && options.fonts);
  let i = 0;
  if (n >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < n && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0d || b[i] === 0x0a)) i++;
  if (n - i < 5 || b.latin1Slice(i, i + 5) !== '{\\rtf') {
    throw new Error("Ce fichier n'est pas un document RTF valide.");
  }

  // --- Tables du document
  let docCp = 1252;
  let deff = -1;
  const fonts = new Map(); // n° → { name, cp }
  let curFont = null;
  const colors = []; // index → '#rrggbb' | null (automatique)
  let rgb = null;
  const styleLevels = new Map(); // n° de style → niveau de titre
  let sheetDepth = -1;
  let sty = null;
  const listsById = new Map();
  const lsToList = new Map();
  let curList = null;
  let curOverride = null;

  // --- État de l'analyse
  const stack = [];
  let st = newState();
  let starred = false; // « \* » vu : le prochain mot inconnu fait ignorer son groupe
  let skipFb = 0; // caractères de repli restant à sauter après \uN
  let lead = -1; // octet de tête en attente (pages de codes sur deux octets)
  const pair = new Uint8Array(2);
  let inst = ''; // instruction du champ en cours (HYPERLINK…)
  let pic = null;
  let pnOrdered = false;
  let nextPar = 0; // position du prochain \par connu, pour ne pas le rechercher à chaque accolade
  const formats = new Map();

  // --- Document en construction
  const body = [];
  let para = { runs: [], lt: '', hasLt: false };
  let table = null; // tableau ouvert en fin de `body`
  let cells = []; // cellules terminées de la ligne en cours
  let cell = []; // paragraphes de la cellule en cours

  /** Indice de l'accolade fermant le groupe courant ; les données \bin sont enjambées. */
  function groupEnd(from) {
    let depth = 0;
    let j = from;
    while (j < n) {
      const c = b[j];
      if (c === 0x5c) {
        if (b[j + 1] === 0x62 && b[j + 2] === 0x69 && b[j + 3] === 0x6e && b[j + 4] >= 0x30 && b[j + 4] <= 0x39) {
          let k = j + 4;
          let size = 0;
          while (b[k] >= 0x30 && b[k] <= 0x39 && k - j < 16) size = size * 10 + (b[k++] - 0x30);
          if (b[k] === 0x20) k++;
          j = k + size;
        } else {
          j += 2;
        }
      } else if (c === 0x7b) {
        depth++;
        j++;
      } else if (c === 0x7d) {
        if (depth === 0) return j;
        depth--;
        j++;
      } else {
        j++;
      }
    }
    return n;
  }

  function curPage() {
    if (st.cp) return st.cp;
    const font = fonts.get(st.font < 0 ? deff : st.font);
    return (st.cp = codePage(font && font.cp != null ? font.cp : docCp));
  }

  function curFormat() {
    const color = st.cf > 0 && colors[st.cf] && colors[st.cf] !== '#000000' ? colors[st.cf] : '';
    const bg = (st.hl > 0 && colors[st.hl]) || '';
    let fontName = '';
    if (useFonts) {
      const font = fonts.get(st.font < 0 ? deff : st.font);
      if (font) fontName = font.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim();
    }
    const flags = (st.b ? 1 : 0) | (st.i ? 2 : 0) | (st.ul ? 4 : 0) | (st.strike ? 8 : 0) | (st.va << 4);
    const key = `${flags}|${st.fs}|${color}|${bg}|${fontName}|${st.href}`;
    let fmt = formats.get(key);
    if (!fmt) {
      fmt = {
        b: st.b, i: st.i, ul: st.ul, strike: st.strike, va: st.va, fs: st.fs,
        color, bg, font: fontName, href: st.href, chain: null, chainHeading: null,
      };
      formats.set(key, fmt);
    }
    return (st.fmt = fmt);
  }

  function emitText(text) {
    switch (st.dest) {
      case D_BODY: {
        if (st.hidden) return;
        const fmt = st.fmt || curFormat();
        if (st.caps) text = text.toUpperCase();
        const runs = para.runs;
        const last = runs.length ? runs[runs.length - 1] : null;
        if (last && last.f === fmt) last.t += text;
        else runs.push({ t: text, f: fmt, img: null });
        return;
      }
      case D_LISTTEXT:
        para.lt += text;
        return;
      case D_FLDINST:
        if (inst.length < 4096) inst += text;
        return;
      case D_FONTTBL:
        if (!curFont) return;
        if (text.includes(';')) {
          curFont.name = (curFont.name + text.slice(0, text.indexOf(';'))).trim();
          curFont = null;
        } else {
          curFont.name += text;
        }
        return;
      case D_COLORTBL:
        for (let k = 0; k < text.length; k++) {
          if (text[k] !== ';') continue;
          colors.push(rgb ? `#${rgb.map((v) => (v & 255).toString(16).padStart(2, '0')).join('')}` : null);
          rgb = null;
        }
        return;
      case D_STYLESHEET:
        if (sty && sty.name.length < 256) sty.name += text;
        return;
      default:
    }
  }

  function hexByte(v) {
    const page = curPage();
    if (page.sb) {
      lead = -1;
      if (page.sb[v]) emitText(page.sb[v]);
    } else if (lead >= 0) {
      pair[0] = lead;
      pair[1] = v;
      lead = -1;
      emitText(page.dec.decode(pair).replace(/\ufffd/g, ''));
    } else if (isLeadByte(page.cp, v)) {
      lead = v;
    } else {
      emitText(v < 0x80 ? String.fromCharCode(v) : page.dec.decode(Uint8Array.of(v)).replace(/\ufffd/g, ''));
    }
  }

  /** Niveau de numérotation déclaré dans la table des listes (-1 si inconnu). */
  function levelFormat(ls, ilvl) {
    const list = listsById.get(lsToList.get(ls));
    const level = list && list.levels[ilvl];
    return level ? level.nfc : -1;
  }

  function listOf(p) {
    if (!(st.ls > 0 || st.pn || p.hasLt)) return null;
    const marker = p.lt.replace(/[\s\u00a0]+/g, ' ').trim();
    const nfc = st.ls > 0 ? levelFormat(st.ls, st.ilvl) : -1;
    const numbered = nfc >= 0 && nfc !== 23 && nfc !== 255;
    let ordered;
    if (marker) {
      ordered = ORDERED_MARKER.test(marker) || numbered;
    } else {
      // Pas de puce calculée par l'auteur du fichier : on se fie aux tables.
      if (nfc === 255 || !(st.ls > 0 || st.pn)) return null;
      if (nfc < 0 && !st.pn && !hasContent(p.runs)) return null;
      ordered = nfc >= 0 ? numbered : st.pn === 2;
    }
    return { ordered, ls: st.ls, ilvl: st.ilvl, li: st.li };
  }

  function closeRow() {
    if (cell.length) {
      cells.push(cell);
      cell = [];
    }
    if (!cells.length) return;
    if (!table) {
      table = { rows: [] };
      body.push(table);
    }
    table.rows.push(cells);
    cells = [];
  }

  /** Termine le paragraphe courant avec les propriétés en vigueur à cet instant. */
  function endPara(inCell) {
    const p = para;
    para = { runs: [], lt: '', hasLt: false };
    let level = styleLevels.get(st.s) || 0;
    if (!level && st.outline >= 0 && st.outline < 9) level = st.outline + 1;
    const block = {
      runs: p.runs,
      align: st.align,
      h: Math.min(level, 6),
      list: level ? null : listOf(p),
    };
    if (inCell || st.intbl) {
      cell.push(block);
    } else {
      // Un paragraphe hors tableau clôt le tableau en cours.
      closeRow();
      table = null;
      body.push(block);
    }
  }

  function flushPara() {
    if (hasContent(para.runs)) endPara(cells.length > 0 || cell.length > 0);
  }

  function finishPict() {
    const p = pic;
    pic = null;
    if (!p || !p.type) return;
    let data;
    if (p.bin) {
      data = p.bin;
    } else {
      let total = 0;
      for (let k = 0; k < p.ranges.length; k += 2) total += p.ranges[k + 1] - p.ranges[k];
      data = Buffer.allocUnsafe(total >> 1);
      let o = 0;
      let high = -1;
      for (let k = 0; k < p.ranges.length; k += 2) {
        for (let j = p.ranges[k]; j < p.ranges[k + 1]; j++) {
          const v = HEX[b[j]];
          if (v < 0) continue;
          if (high < 0) {
            high = v;
          } else {
            data[o++] = (high << 4) | v;
            high = -1;
          }
        }
      }
      data = data.subarray(0, o);
    }
    const isPng = data.length > 24 && data.readUInt32BE(0) === 0x89504e47;
    const isJpeg = data.length > 4 && data[0] === 0xff && data[1] === 0xd8;
    if (!isPng && !isJpeg) return;
    // Taille voulue en twips (1/1440 pouce) → pixels à 96 ppp.
    let width = p.wgoal > 0 ? p.wgoal / 15 : 0;
    let height = p.hgoal > 0 ? p.hgoal / 15 : 0;
    if (!width || !height) {
      width = isPng ? data.readUInt32BE(16) : p.w;
      height = isPng ? data.readUInt32BE(20) : p.h;
    }
    width *= (p.sx > 0 ? p.sx : 100) / 100;
    height *= (p.sy > 0 ? p.sy : 100) / 100;
    let size = '';
    if (width >= 1 && height >= 1 && width < 1e5 && height < 1e5) {
      if (width > MAX_IMAGE_WIDTH) {
        height *= MAX_IMAGE_WIDTH / width;
        width = MAX_IMAGE_WIDTH;
      }
      size = ` width="${Math.round(width)}" height="${Math.max(1, Math.round(height))}"`;
    }
    const mime = isPng ? 'image/png' : 'image/jpeg';
    para.runs.push({ t: '', f: null, img: `<img src="data:${mime};base64,${data.toString('base64')}"${size}>` });
  }

  /** Lien d'un champ HYPERLINK ; les renvois internes (\l "signet") ne donnent rien. */
  function linkOfField() {
    const match = /HYPERLINK\s+(?:"([^"]*)"|([^\s"\\]+))/i.exec(inst);
    const url = match ? (match[1] || match[2] || '').trim() : '';
    return LINK_SCHEME.test(url) ? url : '';
  }

  function enterDest(code) {
    const from = st.dest;
    switch (code) {
      case X_KEEP:
        return;
      case X_FLDRSLT:
        if (from === D_BODY) {
          // Un champ sans lien (PAGEREF…) dans le résultat d'un lien reste dans ce lien.
          const link = linkOfField();
          if (link) {
            st.href = link;
            st.fmt = null;
          }
        }
        return;
      case X_SHPTXT:
        if (from === D_SHP) st.dest = D_BODY;
        return;
      case D_FLDINST:
        if (from === D_BODY) {
          st.dest = D_FLDINST;
          inst = '';
        }
        return;
      case D_PICT:
        if (from === D_BODY || from === D_SHP) {
          st.dest = D_PICT;
          pic = { type: '', w: 0, h: 0, wgoal: 0, hgoal: 0, sx: 100, sy: 100, ranges: [], bin: null };
          return;
        }
        break;
      case D_SHP:
        if (from === D_BODY || from === D_SHP) {
          st.dest = D_SHP;
          return;
        }
        break;
      case D_LISTTEXT:
        if (from === D_BODY) {
          st.dest = D_LISTTEXT;
          para.hasLt = true;
          return;
        }
        break;
      case D_PN:
        if (from === D_BODY) {
          st.dest = D_PN;
          pnOrdered = false;
          return;
        }
        break;
      default:
        if (code !== X_SKIP && from === D_BODY) {
          st.dest = code;
          if (code === D_STYLESHEET) sheetDepth = stack.length;
          return;
        }
    }
    i = groupEnd(i);
  }

  /** Mots propres aux tables d'en-tête ; renvoie true si le mot est consommé. */
  function tableWord(dest, word, param, has) {
    switch (dest) {
      case D_FONTTBL:
        if (word === 'f') {
          curFont = { name: '', cp: null };
          fonts.set(param, curFont);
          return true;
        }
        if (curFont && word === 'fcharset') {
          curFont.cp = CHARSET_CP[param] != null ? CHARSET_CP[param] : null;
          return true;
        }
        if (curFont && word === 'cpg' && has) {
          curFont.cp = param;
          return true;
        }
        return false;
      case D_COLORTBL:
        if (word === 'red' || word === 'green' || word === 'blue') {
          if (!rgb) rgb = [0, 0, 0];
          rgb[word === 'red' ? 0 : word === 'green' ? 1 : 2] = param;
        }
        return true;
      case D_STYLESHEET:
        if (!sty) return false;
        if (word === 's') sty.num = param;
        else if (word === 'cs' || word === 'ds' || word === 'ts' || word === 'tsrowd') sty.para = false;
        else if (word === 'outlinelevel') sty.outline = param;
        else return false;
        return true;
      case D_LISTTABLE:
        if (word === 'list') {
          curList = { levels: [] };
        } else if (curList) {
          if (word === 'listlevel') curList.levels.push({ nfc: -1 });
          else if (word === 'listid') listsById.set(param, curList);
          else if ((word === 'levelnfc' || word === 'levelnfcn') && curList.levels.length) {
            curList.levels[curList.levels.length - 1].nfc = param;
          }
        }
        return true;
      case D_LISTOVERRIDE:
        if (word === 'listoverride') {
          curOverride = { id: null, ls: null };
        } else if (curOverride && (word === 'listid' || word === 'ls')) {
          if (word === 'ls') curOverride.ls = param;
          else curOverride.id = param;
          if (curOverride.ls !== null && curOverride.id !== null) lsToList.set(curOverride.ls, curOverride.id);
        }
        return true;
      case D_PICT:
        if (pic) {
          if (word === 'pngblip') pic.type = 'png';
          else if (word === 'jpegblip') pic.type = 'jpeg';
          else if (word === 'picw') pic.w = param;
          else if (word === 'pich') pic.h = param;
          else if (word === 'picwgoal') pic.wgoal = param;
          else if (word === 'pichgoal') pic.hgoal = param;
          else if (word === 'picscalex') pic.sx = param;
          else if (word === 'picscaley') pic.sy = param;
        }
        return true;
      case D_PN:
        if (word === 'pnlvlblt') pnOrdered = false;
        else if (PN_ORDERED.has(word)) pnOrdered = true;
        return true;
      default:
        return false;
    }
  }

  function control(word, param, has) {
    lead = -1;
    if (starred) {
      starred = false;
      if (!DESTS.has(word)) {
        i = groupEnd(i);
        return;
      }
    }
    const code = DESTS.get(word);
    if (code !== undefined) {
      enterDest(code);
      return;
    }
    const dest = st.dest;
    if (dest !== D_BODY && tableWord(dest, word, param, has)) return;
    const on = !has || param !== 0;
    const inBody = dest === D_BODY;
    switch (word) {
      // --- Structure
      case 'par':
        if (inBody) endPara(false);
        return;
      case 'cell':
        if (inBody) {
          // « \par\cell » (pandoc) : pas de paragraphe vide en fin de cellule.
          if (para.runs.length || !cell.length) endPara(true);
          cells.push(cell);
          cell = [];
        }
        return;
      case 'row':
        if (inBody) {
          if (hasContent(para.runs)) endPara(true);
          else para.runs = [];
          closeRow();
        }
        return;
      case 'nestcell':
        // Tableaux imbriqués mis à plat : leurs cellules deviennent des paragraphes.
        if (inBody) endPara(true);
        return;
      case 'page':
      case 'sect':
      case 'column':
        if (inBody && hasContent(para.runs)) endPara(false);
        return;
      // --- Paragraphe
      case 'pard':
        st.align = '';
        st.s = 0;
        st.outline = -1;
        st.intbl = false;
        st.ls = 0;
        st.ilvl = 0;
        st.li = 0;
        st.pn = 0;
        return;
      case 'ql':
        st.align = '';
        return;
      case 'qc':
        st.align = 'center';
        return;
      case 'qr':
        st.align = 'right';
        return;
      case 'qj':
      case 'qd':
        st.align = 'justify';
        return;
      case 's':
        st.s = param;
        return;
      case 'outlinelevel':
        st.outline = has ? param : -1;
        return;
      case 'intbl':
        st.intbl = true;
        return;
      case 'ls':
        st.ls = param;
        return;
      case 'ilvl':
        st.ilvl = param;
        return;
      case 'li':
      case 'lin':
        st.li = param;
        return;
      // --- Caractère
      case 'plain':
        st.b = st.i = st.ul = st.strike = st.caps = false;
        st.va = 0;
        st.fs = 0;
        st.cf = 0;
        st.hl = 0;
        st.hidden = 0;
        st.font = -1;
        st.cp = null;
        st.fmt = null;
        return;
      case 'b':
        st.b = on;
        st.fmt = null;
        return;
      case 'i':
        st.i = on;
        st.fmt = null;
        return;
      case 'ulnone':
        st.ul = false;
        st.fmt = null;
        return;
      case 'strike':
      case 'striked':
        st.strike = on;
        st.fmt = null;
        return;
      case 'super':
        st.va = on ? 1 : 0;
        st.fmt = null;
        return;
      case 'sub':
        st.va = on ? 2 : 0;
        st.fmt = null;
        return;
      case 'up':
      case 'dn':
        // LibreOffice écrit exposants et indices comme des décalages verticaux.
        st.va = has && param > 0 ? (word === 'up' ? 1 : 2) : 0;
        st.fmt = null;
        return;
      case 'nosupersub':
        st.va = 0;
        st.fmt = null;
        return;
      case 'fs':
        st.fs = has && param > 0 && param < 4000 ? param : 0;
        st.fmt = null;
        return;
      case 'cf':
        st.cf = has ? param : 0;
        st.fmt = null;
        return;
      case 'caps':
        st.caps = on;
        return;
      case 'highlight':
        st.hl = has ? param : 0;
        st.fmt = null;
        return;
      case 'v':
        st.hidden = on ? st.hidden | 1 : st.hidden & ~1;
        return;
      case 'deleted':
        // Texte supprimé en suivi des modifications : il ne fait plus partie du document.
        st.hidden = on ? st.hidden | 2 : st.hidden & ~2;
        return;
      case 'f':
        st.font = param;
        st.cp = null;
        if (useFonts) st.fmt = null;
        return;
      // --- Encodage
      case 'u': {
        skipFb = st.uc;
        let cp = param;
        if (cp < 0) cp += 65536;
        if (cp < 0 || cp > 0x10ffff || (cp < 0x20 && cp !== 9)) return;
        emitText(cp > 0xffff ? String.fromCodePoint(cp) : String.fromCharCode(cp));
        return;
      }
      case 'uc':
        st.uc = has && param >= 0 ? param : 1;
        return;
      case 'ansicpg':
        if (has && param > 0) docCp = param;
        st.cp = null;
        return;
      case 'mac':
        docCp = 10000;
        st.cp = null;
        return;
      case 'pc':
        docCp = 437;
        st.cp = null;
        return;
      case 'pca':
        docCp = 850;
        st.cp = null;
        return;
      case 'deff':
        deff = param;
        st.cp = null;
        return;
      case 'field':
        if (inBody) inst = '';
        return;
      default: {
        const ch = SPECIAL_CHARS[word];
        if (ch !== undefined) {
          emitText(ch);
        } else if (UNDERLINES.has(word)) {
          st.ul = on;
          st.fmt = null;
        }
      }
    }
  }

  // --- Boucle principale
  while (i < n) {
    const c = b[i];
    if (c === 0x5c) {
      i++;
      if (i >= n) break;
      let d = b[i];
      if ((d >= 0x61 && d <= 0x7a) || (d >= 0x41 && d <= 0x5a)) {
        const start = i;
        do d = b[++i];
        while ((d >= 0x61 && d <= 0x7a) || (d >= 0x41 && d <= 0x5a));
        const word = b.latin1Slice(start, i);
        let has = false;
        let param = 0;
        let negative = false;
        if (d === 0x2d && b[i + 1] >= 0x30 && b[i + 1] <= 0x39) {
          negative = true;
          d = b[++i];
        }
        if (d >= 0x30 && d <= 0x39) {
          has = true;
          let digits = 0;
          do {
            if (digits++ < 10) param = param * 10 + (d - 0x30);
            d = b[++i];
          } while (d >= 0x30 && d <= 0x39);
          if (negative) param = -param;
        }
        if (d === 0x20) i++;
        if (word === 'bin') {
          // Données binaires brutes : elles peuvent contenir des accolades.
          if (has && param > 0) {
            const end = Math.min(n, i + param);
            if (st.dest === D_PICT && pic && pic.type) pic.bin = b.subarray(i, end);
            i = end;
          }
          continue;
        }
        if (skipFb > 0) {
          if (!NOT_FALLBACK.has(word)) {
            skipFb--;
            continue;
          }
          skipFb = 0;
        }
        control(word, param, has);
      } else {
        i++;
        switch (d) {
          case 0x27: {
            const h1 = HEX[b[i]];
            const h2 = HEX[b[i + 1]];
            if (h1 >= 0 && h2 >= 0) {
              i += 2;
              if (skipFb > 0) skipFb--;
              else hexByte((h1 << 4) | h2);
            }
            break;
          }
          case 0x5c:
          case 0x7b:
          case 0x7d:
            if (skipFb > 0) skipFb--;
            else emitText(String.fromCharCode(d));
            break;
          case 0x7e:
            if (skipFb > 0) skipFb--;
            else emitText('\u00a0');
            break;
          case 0x5f:
            if (skipFb > 0) skipFb--;
            else emitText('\u2011');
            break;
          case 0x2a:
            starred = true;
            break;
          case 0x0d:
            // « \ » en fin de ligne vaut \par (TextEdit).
            if (b[i] === 0x0a) i++;
            skipFb = 0;
            if (st.dest === D_BODY) endPara(false);
            break;
          case 0x0a:
            skipFb = 0;
            if (st.dest === D_BODY) endPara(false);
            break;
          case 0x09:
            emitText('\t');
            break;
          default:
        }
      }
    } else if (c === 0x7b) {
      i++;
      stack.push(st);
      st = cloneState(st);
      skipFb = 0;
      starred = false;
      lead = -1;
      if (st.dest === D_STYLESHEET && stack.length === sheetDepth + 1) {
        sty = { num: 0, para: true, name: '', outline: -1 };
      }
    } else if (c === 0x7d) {
      i++;
      skipFb = 0;
      starred = false;
      lead = -1;
      if (!stack.length) continue;
      // Fin du groupe racine : le dernier paragraphe garde ses propriétés même sans \par.
      if (stack.length === 1 && st.dest === D_BODY) flushPara();
      const closed = st.dest;
      st = stack.pop();
      if (!stack.length) {
        // Après la fin du document, on ne poursuit (accolade en trop) que s'il
        // reste des paragraphes : les octets parasites en fin de fichier sont courants.
        if (nextPar < i) nextPar = b.indexOf('\\par', i, 'latin1');
        if (nextPar < 0) break;
      }
      if (closed !== st.dest) {
        if (closed === D_PICT) finishPict();
        else if (closed === D_PN) st.pn = pnOrdered ? 2 : 1;
      } else if (closed === D_STYLESHEET && sty && stack.length === sheetDepth) {
        if (sty.para) {
          const name = sty.name.replace(/;\s*$/, '').trim();
          const match = HEADING_NAME.exec(name);
          if (match) styleLevels.set(sty.num, Number(match[1]));
          else if (sty.outline >= 0 && sty.outline < 9) styleLevels.set(sty.num, sty.outline + 1);
        }
        sty = null;
      }
    } else if (c === 0x0d || c === 0x0a) {
      i++;
    } else {
      let j = i;
      let high = false;
      for (; j < n; j++) {
        const e = b[j];
        if (e === 0x5c || e === 0x7b || e === 0x7d || e === 0x0d || e === 0x0a) break;
        if (e >= 0x80) high = true;
      }
      let start = i;
      i = j;
      starred = false;
      const dest = st.dest;
      if (dest === D_PICT) {
        if (pic && pic.type) pic.ranges.push(start, j);
        continue;
      }
      if (DROPS_TEXT[dest]) continue;
      if (skipFb > 0) {
        const skipped = Math.min(skipFb, j - start);
        start += skipped;
        skipFb -= skipped;
        if (start === j) continue;
      }
      let text;
      if (high || lead >= 0) {
        // Octets 8 bits bruts (hors norme mais courants) : décodés comme \'xx.
        const page = curPage();
        if (page.sb) {
          text = '';
          for (let k = start; k < j; k++) text += page.sb[b[k]];
        } else {
          let bytes = b.subarray(start, j);
          if (lead >= 0) bytes = Buffer.concat([Buffer.from([lead]), bytes]);
          text = page.dec.decode(bytes).replace(/\ufffd/g, '');
        }
        lead = -1;
      } else {
        text = b.latin1Slice(start, j);
      }
      if (text) emitText(text);
    }
  }

  // Fichier tronqué ou sans \par final : rien ne doit se perdre.
  flushPara();
  closeRow();

  const out = [];
  renderBlocks(body, out);
  return out.join('');
}

module.exports = { rtfToHtml };
