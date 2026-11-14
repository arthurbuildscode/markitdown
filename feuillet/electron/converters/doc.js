'use strict';
/**
 * Conversion des fichiers Word binaires (.doc, Word 97-2003) en fragment HTML.
 *
 * Trois chemins, du plus fidèle au plus sûr :
 *  1. lecture directe du format (texte + mise en forme de base : gras, italique,
 *     souligné, barré, taille, couleur, police, exposant/indice, titres,
 *     alignement, tableaux, listes) ;
 *  2. en cas d'échec, texte brut via `word-extractor` (un <p> par paragraphe),
 *     à condition que la structure du fichier ait pu être vérifiée (voir
 *     `isSafeForWordExtractor`) ;
 *  3. pour les fichiers Word 6/95, que `word-extractor` ne lit pas : extraction
 *     du texte brut par nos soins, sans mise en forme.
 *
 * Hors périmètre : images, en-têtes et pieds de page, notes, zones de texte,
 * suivi des modifications (le texte supprimé est simplement omis), fichiers
 * chiffrés.
 *
 * Le HTML produit reste volontairement simple (h1-h6, p, strong, em, u, s, sup,
 * sub, span, br, table, ul/ol) pour passer sans surprise dans le convertisseur
 * HTML → DOCX.
 *
 * Références : [MS-DOC] et [MS-CFB] (Microsoft Open Specifications).
 */

const EMPTY_PARAGRAPH = '<p>&nbsp;</p>';
const MAX_TABLE_DEPTH = 6;
const NO_BASE_STYLE = 0x0fff;
const FALLBACK_TIMEOUT_MS = 20000;
const NON_BREAKING_HYPHEN = String.fromCharCode(0x2011);

class DocError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DocError';
    this.code = code;
  }
}

function encryptedError() {
  return new DocError('Ce fichier .doc est protégé par mot de passe : il ne peut pas être ouvert.', 'DOC_ENCRYPTED');
}

/* ------------------------------------------------------------------------ */
/* Utilitaires texte                                                         */
/* ------------------------------------------------------------------------ */

/** Octets 0x80-0x9F de Windows-1252 (les morceaux « compressés » du .doc). */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d,
  0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x009d, 0x017e, 0x0178,
];

/** Échappe le texte et retire ce qui rendrait le XML du .docx invalide. */
function escapeHtml(text) {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffe\uffff]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '')
    .replace(/(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function plainTextToHtml(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
  return lines
    .map((line) => {
      return /\S/.test(line) ? `<p>${encodeText(line)}</p>` : EMPTY_PARAGRAPH;
    })
    .join('\n');
}

function hasVisibleText(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, '')
    .trim().length > 0;
}

/* ------------------------------------------------------------------------ */
/* Conteneur OLE (Compound File Binary)                                      */
/* ------------------------------------------------------------------------ */

const CFB_MAX_REGULAR_SECTOR = 0xfffffffa;

/**
 * Lecteur minimal et synchrone de fichier composé OLE.
 * @returns {{ stream(name: string): Buffer | null }} accès aux flux de la racine
 */
function readCompoundFile(buf) {
  if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) {
    throw new Error('not an OLE compound file');
  }
  const sectorShift = buf.readUInt16LE(0x1e);
  const miniShift = buf.readUInt16LE(0x20);
  if (sectorShift < 7 || sectorShift > 16 || miniShift > sectorShift) throw new Error('bad OLE header');
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  const fatSectorCount = buf.readUInt32LE(0x2c);
  const dirStart = buf.readUInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38) || 4096;
  const miniFatStart = buf.readUInt32LE(0x3c);
  let difatSector = buf.readUInt32LE(0x44);
  const sectorCount = Math.ceil(buf.length / sectorSize);
  const sectorOffset = (sector) => (sector + 1) * sectorSize;
  const perSector = sectorSize >>> 2;

  // `consistent` : aucune anomalie relevée dans les tables d'allocation. Notre
  // lecture tolère ces anomalies ; word-extractor (le repli) non, voir plus bas.
  let consistent =
    (sectorShift === 9 || sectorShift === 12) &&
    miniShift === 6 &&
    fatSectorCount <= sectorCount &&
    buf.readUInt32LE(0x40) <= sectorCount &&
    buf.readUInt32LE(0x48) <= sectorCount;

  // DIFAT : liste des secteurs qui contiennent la FAT.
  const fatSectors = [];
  const addFatSector = (sector) => {
    if (sector < sectorCount && sectorOffset(sector) + sectorSize <= buf.length) fatSectors.push(sector);
    else consistent = false;
  };
  for (let i = 0; i < 109 && fatSectors.length < fatSectorCount; i++) addFatSector(buf.readUInt32LE(0x4c + i * 4));
  let difatSectorsRead = 0;
  for (let guard = 0; difatSector < sectorCount && guard < sectorCount; guard++) {
    const offset = sectorOffset(difatSector);
    if (offset + sectorSize > buf.length) break;
    difatSectorsRead++;
    for (let i = 0; i < perSector - 1 && fatSectors.length < fatSectorCount; i++) {
      addFatSector(buf.readUInt32LE(offset + i * 4));
    }
    difatSector = buf.readUInt32LE(offset + sectorSize - 4);
  }
  if (fatSectors.length !== fatSectorCount) consistent = false;
  if (fatSectorCount > 109 && difatSectorsRead !== buf.readUInt32LE(0x48)) consistent = false;

  const fat = new Uint32Array(fatSectors.length * perSector).fill(0xffffffff);
  fatSectors.forEach((sector, index) => {
    const offset = sectorOffset(sector);
    for (let i = 0; i < perSector && offset + i * 4 + 4 <= buf.length; i++) {
      fat[index * perSector + i] = buf.readUInt32LE(offset + i * 4);
    }
  });

  const chain = (start, table) => {
    const sectors = [];
    let sector = start;
    while (sector <= CFB_MAX_REGULAR_SECTOR && sector < table.length && sectors.length <= table.length) {
      sectors.push(sector);
      sector = table[sector];
    }
    return sectors;
  };

  const readRegular = (start, size) => {
    const parts = [];
    let total = 0;
    for (const sector of chain(start, fat)) {
      if (size >= 0 && total >= size) break;
      const offset = sectorOffset(sector);
      if (offset >= buf.length) break;
      const part = buf.subarray(offset, Math.min(offset + sectorSize, buf.length));
      parts.push(part);
      total += part.length;
    }
    const data = Buffer.concat(parts);
    return size >= 0 && data.length > size ? data.subarray(0, size) : data;
  };

  const directory = readRegular(dirStart, -1);
  const entryCount = Math.floor(directory.length / 128);
  if (entryCount < 1) throw new Error('empty OLE directory');
  const entry = (id) => {
    const offset = id * 128;
    const nameLength = Math.min(Math.max(directory.readUInt16LE(offset + 0x40) - 2, 0), 62);
    return {
      name: directory.toString('utf16le', offset, offset + nameLength),
      type: directory[offset + 0x42],
      left: directory.readUInt32LE(offset + 0x44),
      right: directory.readUInt32LE(offset + 0x48),
      child: directory.readUInt32LE(offset + 0x4c),
      start: directory.readUInt32LE(offset + 0x74),
      size: directory.readUInt32LE(offset + 0x78),
    };
  };

  const root = entry(0);
  let miniStream = null;
  let miniFat = null;
  const loadMini = () => {
    if (miniStream) return;
    miniStream = readRegular(root.start, root.size);
    const raw = readRegular(miniFatStart, -1);
    miniFat = new Uint32Array(raw.length >>> 2);
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = raw.readUInt32LE(i * 4);
  };
  const readMini = (start, size) => {
    loadMini();
    const parts = [];
    let total = 0;
    for (const sector of chain(start, miniFat)) {
      if (total >= size) break;
      const offset = sector * miniSize;
      if (offset >= miniStream.length) break;
      const part = miniStream.subarray(offset, Math.min(offset + miniSize, miniStream.length));
      parts.push(part);
      total += part.length;
    }
    const data = Buffer.concat(parts);
    return data.length > size ? data.subarray(0, size) : data;
  };

  // Flux situés directement sous la racine (on ne descend pas dans les
  // sous-dossiers : un objet incorporé peut contenir son propre « WordDocument »).
  const rootStreams = new Map();
  const seen = new Set();
  const pending = [root.child];
  while (pending.length) {
    const id = pending.pop();
    if (id >= entryCount || seen.has(id)) continue;
    seen.add(id);
    const item = entry(id);
    if (item.type === 2 && !rootStreams.has(item.name)) rootStreams.set(item.name, item);
    pending.push(item.left, item.right);
  }

  return {
    /** Vrai si les tables d'allocation sont cohérentes et sans chaîne cyclique. */
    isConsistent() {
      if (!consistent) return false;
      loadMini();
      return isAcyclic(fat) && isAcyclic(miniFat);
    },
    stream(name) {
      let item = rootStreams.get(name);
      if (!item) {
        // Arborescence abîmée : on se rabat sur un balayage linéaire.
        for (let id = 1; id < entryCount && !item; id++) {
          const candidate = entry(id);
          if (candidate.type === 2 && candidate.name === name) item = candidate;
        }
      }
      if (!item) return null;
      return item.size < miniCutoff ? readMini(item.start, item.size) : readRegular(item.start, item.size);
    },
  };
}

/** Vérifie qu'aucune chaîne de secteurs ne boucle (table d'allocation vue comme graphe i → table[i]). */
function isAcyclic(table) {
  const state = new Uint8Array(table.length); // 0 : jamais vu, 1 : chaîne en cours, 2 : chaîne validée
  for (let start = 0; start < table.length; start++) {
    let sector = start;
    while (sector < table.length && state[sector] === 0) {
      state[sector] = 1;
      sector = table[sector];
    }
    if (sector < table.length && state[sector] === 1) return false;
    for (sector = start; sector < table.length && state[sector] === 1; sector = table[sector]) state[sector] = 2;
  }
  return true;
}

/* ------------------------------------------------------------------------ */
/* Sprm (modificateurs de propriétés)                                        */
/* ------------------------------------------------------------------------ */

const SPRM = {
  // Caractères
  CFRMarkDel: 0x0800,
  CFSpec: 0x0855,
  CSymbol: 0x6a09,
  CIstd: 0x4a30,
  CPlain: 0x2a33,
  CFBold: 0x0835,
  CFItalic: 0x0836,
  CFStrike: 0x0837,
  CFDStrike: 0x2a53,
  CKul: 0x2a3e,
  CHps: 0x4a43,
  CIco: 0x2a42,
  CCv: 0x6870,
  CIss: 0x2a48,
  CFtcDefault: 0x4a3d,
  CRgFtc0: 0x4a4f,
  CFBiDi: 0x085a,
  CFBoldBi: 0x085c,
  CFItalicBi: 0x085d,
  CHpsBi: 0x4a61,
  // Paragraphes
  PIstd: 0x4600,
  PJc80: 0x2403,
  PJc: 0x2461,
  PFBiDi: 0x2441,
  PFInTable: 0x2416,
  PFTtp: 0x2417,
  PIlvl: 0x260a,
  PIlfo: 0x460b,
  PItap: 0x6649,
  PDtap: 0x664a,
  PFInnerTableCell: 0x244b,
  PFInnerTtp: 0x244c,
  PHugePapx: 0x6645,
  PHugePapx2: 0x6646,
  PChgTabs: 0xc615,
  // Tableaux
  TDefTable: 0xd608,
  TDefTable10: 0xd606,
};

/** Correspondance isprm → sprm pour les Prm « simples » des morceaux (fichiers à enregistrement rapide). */
const PRM_SPRM = {
  0x05: SPRM.PJc80,
  0x0c: SPRM.PIlvl,
  0x18: SPRM.PFInTable,
  0x19: SPRM.PFTtp,
  0x41: SPRM.CFRMarkDel,
  0x53: SPRM.CPlain,
  0x55: SPRM.CFBold,
  0x56: SPRM.CFItalic,
  0x57: SPRM.CFStrike,
  0x5e: SPRM.CKul,
  0x62: SPRM.CIco,
  0x68: SPRM.CIss,
  0x73: SPRM.CFDStrike,
  0x75: SPRM.CFSpec,
};

/** Parcourt un grpprl ; `handler(sprm, buffer, offsetOpérande, tailleOpérande)`. */
function forEachSprm(grpprl, handler) {
  const length = grpprl.length;
  let offset = 0;
  while (offset + 2 <= length) {
    const sprm = grpprl[offset] | (grpprl[offset + 1] << 8);
    offset += 2;
    let size;
    switch (sprm >> 13) {
      case 0:
      case 1:
        size = 1;
        break;
      case 2:
      case 4:
      case 5:
        size = 2;
        break;
      case 3:
        size = 4;
        break;
      case 7:
        size = 3;
        break;
      default:
        if (offset >= length) return;
        if (sprm === SPRM.TDefTable || sprm === SPRM.TDefTable10) {
          if (offset + 2 > length) return;
          size = (grpprl[offset] | (grpprl[offset + 1] << 8)) + 1;
        } else if (sprm === SPRM.PChgTabs && grpprl[offset] === 255) {
          if (offset + 2 > length) return;
          const deleted = grpprl[offset + 1];
          const addOffset = offset + 2 + deleted * 4;
          if (addOffset >= length) return;
          size = 2 + deleted * 4 + 1 + grpprl[addOffset] * 3;
        } else {
          size = grpprl[offset] + 1;
        }
    }
    if (offset + size > length) return;
    handler(sprm, grpprl, offset, size);
    offset += size;
  }
}

function toggle(operand, styleValue) {
  if (operand === 0) return false;
  if (operand === 1) return true;
  if (operand === 0x80) return !!styleValue;
  if (operand === 0x81) return !styleValue;
  return operand !== 0;
}

/** Palette « ico » de Word ; 0 = automatique. */
const ICO_COLORS = [
  null, '#000000', '#0000FF', '#00FFFF', '#00FF00', '#FF00FF', '#FF0000', '#FFFF00', '#FFFFFF', '#000080', '#008080',
  '#008000', '#800080', '#800000', '#808000', '#808080', '#C0C0C0',
];

function hex2(value) {
  return value.toString(16).padStart(2, '0').toUpperCase();
}

const DEFAULT_CHP = Object.freeze({
  bold: false,
  italic: false,
  strike: false,
  dstrike: false,
  underline: 0,
  hps: 20,
  color: null,
  iss: 0,
  ftc: -1,
  bidi: false,
  boldBi: false,
  italicBi: false,
  hpsBi: 20,
  deleted: false,
  special: false,
  symbolFtc: -1,
  symbolChar: 0,
});

const DEFAULT_PAP = Object.freeze({
  istd: 0,
  jc: 0,
  jcLogical: false,
  bidi: false,
  inTable: false,
  ttp: false,
  itap: 0,
  innerCell: false,
  innerTtp: false,
  ilfo: 0,
  ilvl: 0,
  tdef: null,
});

/* ------------------------------------------------------------------------ */
/* Document Word 97-2003                                                     */
/* ------------------------------------------------------------------------ */

class Word97Document {
  /**
   * @param {Buffer} wd flux « WordDocument »
   * @param {{ stream(name: string): Buffer | null }} cfb
   */
  constructor(wd, cfb) {
    this.wd = wd;
    const flags = wd.readUInt16LE(0x0a);
    if (flags & 0x0100) throw encryptedError();

    const table = cfb.stream(flags & 0x0200 ? '1Table' : '0Table') || cfb.stream(flags & 0x0200 ? '0Table' : '1Table');
    if (!table) throw new Error('missing table stream');
    this.table = table;
    this.cfb = cfb;
    this.dataStream = undefined;

    // Le FIB est une suite de blocs de taille variable ; on calcule les décalages.
    const csw = wd.readUInt16LE(0x20);
    const rgLw = 0x22 + csw * 2 + 2;
    const cslw = wd.readUInt16LE(rgLw - 2);
    this.rgLw = rgLw;
    this.cslw = cslw;
    this.rgFcLcb = rgLw + cslw * 4 + 2;
    this.cbRgFcLcb = wd.readUInt16LE(this.rgFcLcb - 2);
    this.ccpText = wd.readInt32LE(rgLw + 3 * 4);
    if (this.ccpText < 0) throw new Error('bad ccpText');

    this.styles = [];
    this.defaultFtc = -1;
    this.fonts = [];
    this.lists = null;
    this.styleChpCache = new Map();
    this.stylePapCache = new Map();
    this.headingCache = new Map();
    this.listCounters = new Map();

    this.readPieces();
    // Les éléments suivants sont facultatifs : en cas de structure abîmée on
    // perd de la mise en forme, pas le texte.
    this.optional(() => this.readStyles());
    this.optional(() => this.readFonts());
    this.optional(() => this.readLists());
    this.chpRuns = this.optional(() => this.readFkps(12, false), emptyRuns());
    this.papRuns = this.optional(() => this.readFkps(13, true), emptyRuns());
  }

  optional(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  /** Paire (fc, lcb) n° `index` du FIB, ou null si absente. */
  fcLcb(index) {
    if (index >= this.cbRgFcLcb) return null;
    const offset = this.rgFcLcb + index * 8;
    const fc = this.wd.readUInt32LE(offset);
    const lcb = this.wd.readUInt32LE(offset + 4);
    if (!lcb || fc >= this.table.length) return null;
    return { fc, lcb: Math.min(lcb, this.table.length - fc) };
  }

  getDataStream() {
    if (this.dataStream === undefined) this.dataStream = this.optional(() => this.cfb.stream('Data'), null) || null;
    return this.dataStream;
  }

  /* ---- Table des morceaux (piece table) -------------------------------- */

  readPieces() {
    const clx = this.fcLcb(33);
    if (!clx) throw new Error('missing piece table');
    const table = this.table;
    const end = clx.fc + clx.lcb;
    let pos = clx.fc;
    const prcs = [];
    while (pos < end && table[pos] === 1) {
      const size = table.readUInt16LE(pos + 1);
      prcs.push(table.subarray(pos + 3, pos + 3 + size));
      pos += 3 + size;
    }
    if (pos >= end || table[pos] !== 2) throw new Error('corrupt piece table');
    const lcb = table.readUInt32LE(pos + 1);
    pos += 5;
    const count = Math.floor((lcb - 4) / 12);
    if (count < 1) throw new Error('empty piece table');

    const pieces = [];
    for (let i = 0; i < count; i++) {
      const cpStart = table.readUInt32LE(pos + i * 4);
      const cpEnd = table.readUInt32LE(pos + (i + 1) * 4);
      const pcd = pos + (count + 1) * 4 + i * 8;
      const rawFc = table.readUInt32LE(pcd + 2);
      const prm = table.readUInt16LE(pcd + 6);
      const compressed = (rawFc & 0x40000000) !== 0;
      let prmGrpprl = null;
      if (prm & 1) {
        prmGrpprl = prcs[prm >> 1] || null;
      } else if (prm) {
        const sprm = PRM_SPRM[(prm >> 1) & 0x7f];
        if (sprm) prmGrpprl = Buffer.from([sprm & 0xff, sprm >> 8, prm >> 8]);
      }
      if (cpEnd <= cpStart) continue;
      pieces.push({
        cpStart,
        cpEnd,
        fc: compressed ? (rawFc & 0x3fffffff) >>> 1 : rawFc & 0x3fffffff,
        bytesPerChar: compressed ? 1 : 2,
        prmGrpprl,
      });
    }
    this.pieces = pieces;
  }

  /** Charge le texte du corps : un code UTF-16 et une position fichier par caractère. */
  loadBody() {
    const wd = this.wd;
    // Un caractère occupe au moins un octet du flux : borne sûre pour un ccpText abîmé.
    const covered = this.pieces.reduce((max, piece) => Math.max(max, piece.cpEnd), 0);
    const n = Math.min(this.ccpText, covered, wd.length);
    this.ccpText = n;
    // Des morceaux qui se recouvrent massivement trahissent une table abîmée.
    let total = 0;
    for (const piece of this.pieces) total += Math.max(Math.min(piece.cpEnd, n) - piece.cpStart, 0);
    if (total > n * 2 + 1024) throw new Error('overlapping pieces');
    const chars = new Uint16Array(n);
    const fcs = new Int32Array(n).fill(-1);
    const pieceOf = new Int32Array(n).fill(-1);
    this.pieces.forEach((piece, index) => {
      const last = Math.min(piece.cpEnd, n);
      for (let cp = piece.cpStart; cp < last; cp++) {
        const fc = piece.fc + (cp - piece.cpStart) * piece.bytesPerChar;
        if (fc + piece.bytesPerChar > wd.length) break;
        let code;
        if (piece.bytesPerChar === 1) {
          code = wd[fc];
          if (code >= 0x80 && code < 0xa0) code = CP1252_HIGH[code - 0x80];
        } else {
          code = wd[fc] | (wd[fc + 1] << 8);
        }
        chars[cp] = code;
        fcs[cp] = fc;
        pieceOf[cp] = index;
      }
    });
    this.chars = chars;
    this.fcs = fcs;
    this.pieceOf = pieceOf;
  }

  /* ---- Feuille de styles ----------------------------------------------- */

  readStyles() {
    const stsh = this.fcLcb(1);
    if (!stsh) return;
    const table = this.table;
    const end = stsh.fc + stsh.lcb;
    const cbStshi = table.readUInt16LE(stsh.fc);
    const stshi = stsh.fc + 2;
    const count = table.readUInt16LE(stshi);
    const baseSize = table.readUInt16LE(stshi + 2);
    if (cbStshi >= 14) this.defaultFtc = table.readUInt16LE(stshi + 12);

    const styles = [];
    let pos = stshi + cbStshi;
    for (let i = 0; i < count && pos + 2 <= end; i++) {
      const cbStd = table.readUInt16LE(pos);
      pos += 2;
      if (!cbStd) {
        styles.push(null);
        continue;
      }
      const start = pos;
      const stdEnd = Math.min(start + cbStd, end);
      pos = start + cbStd;
      const style = { sti: 0xfff, stk: 0, base: NO_BASE_STYLE, papx: null, chpx: null };
      styles.push(style);
      if (stdEnd - start < Math.max(baseSize, 6) + 2) continue;
      style.sti = table.readUInt16LE(start) & 0x0fff;
      const word1 = table.readUInt16LE(start + 2);
      style.stk = word1 & 0x0f;
      style.base = word1 >> 4;
      const upxCount = table.readUInt16LE(start + 4) & 0x0f;
      const nameLength = table.readUInt16LE(start + baseSize);
      let cursor = start + baseSize + 2 + (nameLength + 1) * 2;
      const upxs = [];
      for (let k = 0; k < upxCount; k++) {
        if ((cursor - start) & 1) cursor++;
        if (cursor + 2 > stdEnd) break;
        const cbUpx = table.readUInt16LE(cursor);
        cursor += 2;
        if (cursor + cbUpx > stdEnd) break;
        upxs.push(table.subarray(cursor, cursor + cbUpx));
        cursor += cbUpx;
      }
      if (style.stk === 1) {
        if (upxs[0] && upxs[0].length >= 2) style.papx = upxs[0].subarray(2);
        style.chpx = upxs[1] || null;
      } else if (style.stk === 2) {
        style.chpx = upxs[0] || null;
      }
    }
    this.styles = styles;
  }

  /** Propriétés de caractère héritées d'un style de paragraphe. */
  styleChp(istd, depth = 0) {
    const cached = this.styleChpCache.get(istd);
    if (cached) return cached;
    const style = this.styles[istd];
    let chp;
    if (!style || style.stk !== 1 || depth > 16) {
      chp = { ...DEFAULT_CHP, ftc: this.defaultFtc };
    } else {
      const parent =
        style.base !== NO_BASE_STYLE && style.base !== istd
          ? this.styleChp(style.base, depth + 1)
          : { ...DEFAULT_CHP, ftc: this.defaultFtc };
      chp = { ...parent };
      if (style.chpx) this.applyChpSprms(chp, style.chpx, parent);
    }
    Object.freeze(chp);
    if (depth === 0 || style) this.styleChpCache.set(istd, chp);
    return chp;
  }

  /** Propriétés de paragraphe héritées d'un style. */
  stylePap(istd, depth = 0) {
    const cached = this.stylePapCache.get(istd);
    if (cached) return cached;
    const style = this.styles[istd];
    let pap;
    if (!style || style.stk !== 1 || depth > 16) {
      pap = { ...DEFAULT_PAP, istd };
    } else {
      const parent =
        style.base !== NO_BASE_STYLE && style.base !== istd ? this.stylePap(style.base, depth + 1) : DEFAULT_PAP;
      pap = { ...parent, istd };
      if (style.papx) this.applyPapSprms(pap, style.papx);
      pap.istd = istd;
    }
    Object.freeze(pap);
    this.stylePapCache.set(istd, pap);
    return pap;
  }

  /** Niveau de titre (1-9) du style, 0 sinon. Les styles dérivés d'un titre en héritent. */
  headingLevel(istd) {
    if (this.headingCache.has(istd)) return this.headingCache.get(istd);
    let level = 0;
    if (!this.styles.length) {
      level = istd >= 1 && istd <= 9 ? istd : 0;
    } else {
      let current = istd;
      for (let depth = 0; depth < 16; depth++) {
        const style = this.styles[current];
        if (!style || style.stk !== 1) break;
        if (style.sti >= 1 && style.sti <= 9) {
          level = style.sti;
          break;
        }
        if (style.base === NO_BASE_STYLE || style.base === current) break;
        current = style.base;
      }
    }
    this.headingCache.set(istd, level);
    return level;
  }

  /* ---- Polices ---------------------------------------------------------- */

  readFonts() {
    const sttb = this.fcLcb(15);
    if (!sttb) return;
    const table = this.table;
    const end = sttb.fc + sttb.lcb;
    const count = table.readUInt16LE(sttb.fc);
    if (count === 0xffff) return;
    const fonts = [];
    let pos = sttb.fc + 4;
    for (let i = 0; i < count && pos < end; i++) {
      const size = table[pos] + 1;
      let name = '';
      for (let p = pos + 40; p + 1 < pos + size && p + 1 < end; p += 2) {
        const code = table.readUInt16LE(p);
        if (!code) break;
        name += String.fromCharCode(code);
      }
      // Nom réduit à des caractères sans danger dans un attribut style.
      name = name.replace(/[^\p{L}\p{N} ._-]/gu, '').trim();
      fonts.push(name);
      pos += size;
    }
    this.fonts = fonts;
  }

  /* ---- Listes ----------------------------------------------------------- */

  readLists() {
    const plfLst = this.fcLcb(73);
    const plfLfo = this.fcLcb(74);
    if (!plfLst || !plfLfo) {
      this.lists = { lfo: [], lst: new Map() };
      return;
    }
    const table = this.table;
    // Un niveau (LVL) : LVLF de 28 octets, puis grpprlPapx, grpprlChpx et le texte du numéro.
    const readLevel = (pos) => {
      const xst = pos + 28 + table[pos + 25] + table[pos + 24];
      return { nfc: table[pos + 4], startAt: table.readInt32LE(pos), end: xst + 2 + table.readUInt16LE(xst) * 2 };
    };

    // Définitions de listes : lsid → niveaux.
    const lst = new Map();
    const listCount = table.readUInt16LE(plfLst.fc);
    let pos = plfLst.fc + 2 + listCount * 28;
    for (let i = 0; i < listCount; i++) {
      const lstf = plfLst.fc + 2 + i * 28;
      const levelCount = table[lstf + 26] & 1 ? 1 : 9;
      const levels = [];
      for (let level = 0; level < levelCount; level++) {
        const parsed = readLevel(pos);
        levels.push(parsed);
        pos = parsed.end;
      }
      lst.set(table.readInt32LE(lstf), levels);
    }

    // Instances de listes (LFO) : c'est leur numéro (ilfo) que portent les paragraphes.
    const lfo = [];
    const lfoCount = table.readUInt32LE(plfLfo.fc);
    for (let i = 0; i < lfoCount && plfLfo.fc + 4 + (i + 1) * 16 <= table.length; i++) {
      lfo.push({ lsid: table.readInt32LE(plfLfo.fc + 4 + i * 16), overrides: null });
    }
    this.lists = { lfo, lst };

    // Surcharges par instance (redémarrage de la numérotation, autre format).
    this.optional(() => {
      pos = plfLfo.fc + 4 + lfo.length * 16;
      lfo.forEach((entry, index) => {
        const overrideCount = table[plfLfo.fc + 4 + index * 16 + 12];
        pos += 4;
        for (let k = 0; k < overrideCount; k++) {
          const flags = table.readUInt32LE(pos + 4);
          const override = { restart: (flags & 0x10) !== 0, startAt: table.readInt32LE(pos), nfc: -1 };
          pos += 8;
          if (flags & 0x20) {
            const parsed = readLevel(pos);
            override.nfc = parsed.nfc;
            override.startAt = parsed.startAt;
            pos = parsed.end;
          }
          if (!entry.overrides) entry.overrides = new Map();
          entry.overrides.set(flags & 0x0f, override);
        }
      });
    });
  }

  /**
   * Liste à laquelle appartient le paragraphe, ou null.
   * `start` : premier numéro du niveau ; `restart` : numéro imposé par l'instance, sinon null.
   */
  listInfo(pap) {
    const ilfo = pap.ilfo;
    if (ilfo < 1 || ilfo > 0x07fe) return null;
    const level = Math.min(pap.ilvl, 8);
    // Tables de listes illisibles : on ne sait pas distinguer puces et numéros.
    if (!this.lists) return { tag: 'ul', lsid: -ilfo, ilfo, level, start: 1, restart: null };
    const entry = this.lists.lfo[ilfo - 1];
    if (!entry) return null;
    const levels = this.lists.lst.get(entry.lsid);
    if (!levels) return { tag: 'ul', lsid: entry.lsid, ilfo, level, start: 1, restart: null };
    const definition = levels[Math.min(level, levels.length - 1)];
    const override = entry.overrides ? entry.overrides.get(level) : null;
    const nfc = override && override.nfc >= 0 ? override.nfc : definition.nfc;
    if (nfc === 0xff) return null; // niveau sans numéro ni puce
    return {
      tag: nfc === 23 ? 'ul' : 'ol',
      lsid: entry.lsid,
      ilfo,
      level,
      start: definition.startAt,
      restart: override && override.restart ? override.startAt : null,
    };
  }

  /**
   * Numéro que Word afficherait pour cet élément : la numérotation se poursuit
   * d'un bloc à l'autre tant que la liste (lsid) est la même, ce qui permet de
   * reprendre au bon numéro après un paragraphe ou un tableau intercalé.
   */
  nextListNumber(list) {
    let state = this.listCounters.get(list.lsid);
    if (!state) {
      state = { next: new Array(9).fill(null), seen: new Set() };
      this.listCounters.set(list.lsid, state);
    }
    const key = list.ilfo * 16 + list.level;
    if (list.restart !== null && !state.seen.has(key)) state.next[list.level] = list.restart;
    state.seen.add(key);
    if (state.next[list.level] === null) state.next[list.level] = list.start;
    const number = state.next[list.level]++;
    state.next.fill(null, list.level + 1);
    return number;
  }

  /* ---- FKP : plages de propriétés de caractères et de paragraphes ------ */

  /**
   * Lit toutes les pages FKP référencées par la table d'index (PlcfBteChpx ou
   * PlcfBtePapx) et renvoie les plages triées par position fichier.
   */
  readFkps(fcLcbIndex, isPapx) {
    const wd = this.wd;
    const table = this.table;
    const pages = new Set();
    const plc = this.fcLcb(fcLcbIndex);
    if (plc) {
      const count = Math.floor((plc.lcb - 4) / 8);
      for (let i = 0; i < count; i++) {
        pages.add(table.readUInt32LE(plc.fc + (count + 1) * 4 + i * 4) & 0x3fffff);
      }
    }
    // Enregistrement rapide : la table d'index peut être incomplète, les pages
    // restantes se suivent alors à partir de pnChpFirst / pnPapFirst.
    if (this.cslw >= 18) {
      const first = wd.readUInt32LE(this.rgLw + (isPapx ? 16 : 13) * 4);
      const total = wd.readUInt32LE(this.rgLw + (isPapx ? 17 : 14) * 4);
      if (total > pages.size && total < 0x10000 && (first + total) * 512 <= wd.length) {
        for (let i = 0; i < total; i++) pages.add(first + i);
      }
    }

    const runs = [];
    for (const page of pages) {
      const base = page * 512;
      if (base < 512 || base + 512 > wd.length) continue;
      const crun = wd[base + 511];
      const entrySize = isPapx ? 13 : 1;
      if (!crun || (crun + 1) * 4 + crun * entrySize > 511) continue;
      for (let j = 0; j < crun; j++) {
        const start = wd.readUInt32LE(base + j * 4);
        const end = wd.readUInt32LE(base + (j + 1) * 4);
        if (end <= start) continue;
        const wordOffset = wd[base + (crun + 1) * 4 + j * entrySize] * 2;
        let grpprl = null;
        let istd = 0;
        if (wordOffset) {
          const at = base + wordOffset;
          if (isPapx) {
            let cb = wd[at] * 2 - 1;
            let dataStart = at + 1;
            if (wd[at] === 0) {
              cb = wd[at + 1] * 2;
              dataStart = at + 2;
            }
            const dataEnd = Math.min(dataStart + cb, base + 512);
            if (dataEnd - dataStart >= 2) {
              istd = wd.readUInt16LE(dataStart);
              grpprl = wd.subarray(dataStart + 2, dataEnd);
            }
          } else {
            const cb = wd[at];
            grpprl = wd.subarray(at + 1, Math.min(at + 1 + cb, base + 512));
          }
        }
        runs.push({ start, end, grpprl, istd });
      }
    }
    runs.sort((a, b) => a.start - b.start || a.end - b.end);
    return { runs, starts: Int32Array.from(runs, (run) => run.start) };
  }

  /* ---- Application des sprm -------------------------------------------- */

  applyChpSprms(chp, grpprl, styleChp) {
    forEachSprm(grpprl, (sprm, b, o) => {
      switch (sprm) {
        case SPRM.CFBold:
          chp.bold = toggle(b[o], styleChp.bold);
          break;
        case SPRM.CFItalic:
          chp.italic = toggle(b[o], styleChp.italic);
          break;
        case SPRM.CFStrike:
          chp.strike = toggle(b[o], styleChp.strike);
          break;
        case SPRM.CFDStrike:
          chp.dstrike = toggle(b[o], styleChp.dstrike);
          break;
        case SPRM.CFBoldBi:
          chp.boldBi = toggle(b[o], styleChp.boldBi);
          break;
        case SPRM.CFItalicBi:
          chp.italicBi = toggle(b[o], styleChp.italicBi);
          break;
        case SPRM.CFBiDi:
          chp.bidi = toggle(b[o], styleChp.bidi);
          break;
        case SPRM.CKul:
          chp.underline = b[o];
          break;
        case SPRM.CHps:
          chp.hps = b[o] | (b[o + 1] << 8);
          break;
        case SPRM.CHpsBi:
          chp.hpsBi = b[o] | (b[o + 1] << 8);
          break;
        case SPRM.CIco:
          chp.color = ICO_COLORS[b[o]] || null;
          break;
        case SPRM.CCv:
          chp.color = b[o + 3] === 0xff ? null : `#${hex2(b[o])}${hex2(b[o + 1])}${hex2(b[o + 2])}`;
          break;
        case SPRM.CIss:
          chp.iss = b[o];
          break;
        case SPRM.CRgFtc0:
        case SPRM.CFtcDefault:
          chp.ftc = b[o] | (b[o + 1] << 8);
          break;
        case SPRM.CFRMarkDel:
          chp.deleted = b[o] !== 0;
          break;
        case SPRM.CFSpec:
          chp.special = toggle(b[o], styleChp.special);
          break;
        case SPRM.CSymbol:
          chp.symbolFtc = b[o] | (b[o + 1] << 8);
          chp.symbolChar = b[o + 2] | (b[o + 3] << 8);
          chp.special = true;
          break;
        case SPRM.CPlain: {
          const { special, deleted } = chp;
          Object.assign(chp, styleChp, { special, deleted });
          break;
        }
        case SPRM.CIstd:
          this.applyCharStyle(chp, b[o] | (b[o + 1] << 8), styleChp, 0);
          break;
        default:
      }
    });
  }

  applyCharStyle(chp, istd, styleChp, depth) {
    const style = this.styles[istd];
    if (!style || style.stk !== 2 || depth > 16) return;
    if (style.base !== NO_BASE_STYLE && style.base !== istd) this.applyCharStyle(chp, style.base, styleChp, depth + 1);
    if (style.chpx) this.applyChpSprms(chp, style.chpx, styleChp);
  }

  applyPapSprms(pap, grpprl, depth = 0) {
    forEachSprm(grpprl, (sprm, b, o, size) => {
      switch (sprm) {
        case SPRM.PIstd:
          pap.istd = b[o] | (b[o + 1] << 8);
          break;
        case SPRM.PJc80:
          pap.jc = b[o];
          pap.jcLogical = false;
          break;
        case SPRM.PJc:
          pap.jc = b[o];
          pap.jcLogical = true;
          break;
        case SPRM.PFBiDi:
          pap.bidi = b[o] !== 0;
          break;
        case SPRM.PFInTable:
          pap.inTable = b[o] !== 0;
          break;
        case SPRM.PFTtp:
          pap.ttp = b[o] !== 0;
          break;
        case SPRM.PIlvl:
          pap.ilvl = b[o];
          break;
        case SPRM.PIlfo:
          pap.ilfo = b[o] | (b[o + 1] << 8);
          break;
        case SPRM.PItap:
          pap.itap = b.readInt32LE(o);
          break;
        case SPRM.PDtap:
          pap.itap += b.readInt32LE(o);
          break;
        case SPRM.PFInnerTableCell:
          pap.innerCell = b[o] !== 0;
          break;
        case SPRM.PFInnerTtp:
          pap.innerTtp = b[o] !== 0;
          break;
        case SPRM.PHugePapx:
        case SPRM.PHugePapx2: {
          // Propriétés trop volumineuses pour le FKP : stockées dans le flux « Data ».
          const data = depth < 2 ? this.getDataStream() : null;
          const at = b.readUInt32LE(o);
          if (data && at + 2 <= data.length) {
            const cb = data.readUInt16LE(at);
            this.applyPapSprms(pap, data.subarray(at + 2, Math.min(at + 2 + cb, data.length)), depth + 1);
          }
          break;
        }
        case SPRM.TDefTable:
          pap.tdef = parseTableDefinition(b, o, size);
          break;
        default:
      }
    });
  }

  /* ---- Recherche des propriétés à une position fichier ----------------- */

  findRun(set, fc, hint) {
    const { runs, starts } = set;
    if (hint >= 0 && hint < runs.length && fc >= runs[hint].start && fc < runs[hint].end) return hint;
    let low = 0;
    let high = starts.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= fc) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    // Des plages peuvent se chevaucher dans les fichiers abîmés : on recule au besoin.
    for (let i = found, steps = 0; i >= 0 && steps < 4; i--, steps++) {
      if (fc < runs[i].end) return i;
    }
    return -1;
  }

  /** Propriétés du paragraphe dont la marque de fin se trouve à la position `cp`. */
  papAt(cp) {
    if (cp < 0 || cp >= this.fcs.length || this.fcs[cp] < 0) return { ...DEFAULT_PAP };
    const index = this.findRun(this.papRuns, this.fcs[cp], -1);
    const run = index >= 0 ? this.papRuns.runs[index] : null;
    const pap = { ...this.stylePap(run ? run.istd : 0) };
    if (run && run.grpprl) this.applyPapSprms(pap, run.grpprl);
    const piece = this.pieces[this.pieceOf[cp]];
    if (piece && piece.prmGrpprl) this.applyPapSprms(pap, piece.prmGrpprl);
    return pap;
  }

  /* ---- Conversion ------------------------------------------------------- */

  toHtml() {
    this.loadBody();
    const n = this.ccpText;
    const chars = this.chars;
    const hidden = findFieldInstructions(chars);

    const root = [];
    const tables = [];
    const container = () => (tables.length ? tables[tables.length - 1].blocks : root);
    const closeTable = () => {
      const table = tables.pop();
      if (table.blocks.length) table.cells.push({ blocks: table.blocks });
      if (table.cells.length) table.rows.push({ cells: table.cells, tdef: null });
      if (table.rows.length) container().push({ kind: 'table', rows: table.rows });
    };
    const setDepth = (depth) => {
      while (tables.length > depth) closeTable();
      while (tables.length < depth) tables.push({ rows: [], cells: [], blocks: [] });
    };

    const emit = (start, end, terminator) => {
      const pap = this.papAt(terminator ? end : end - 1);
      const isCellMark = terminator === 0x07;
      // Un saut de page ou de section isolé ne produit pas de paragraphe vide.
      if (terminator === 0x0c && end === start) return;

      let depth;
      if (isCellMark) {
        depth = 1;
      } else {
        depth = pap.inTable ? Math.min(Math.max(pap.itap, 1), MAX_TABLE_DEPTH) : 0;
        // Entre deux marques de cellule, un paragraphe appartient forcément au tableau.
        if (depth === 0 && tables.length && (tables[0].cells.length || tables[0].blocks.length)) depth = 1;
      }
      setDepth(depth);

      const rowEnd = depth === 1 ? isCellMark && pap.ttp : depth > 1 && pap.innerTtp;
      const cellEnd = depth === 1 ? isCellMark : depth > 1 && pap.innerCell;
      if (depth === 0) {
        root.push(this.buildParagraph(start, end, pap, hidden));
        return;
      }
      const table = tables[depth - 1];
      if (rowEnd) {
        if (table.blocks.length) {
          table.cells.push({ blocks: table.blocks });
          table.blocks = [];
        }
        if (table.cells.length) table.rows.push({ cells: table.cells, tdef: pap.tdef });
        table.cells = [];
        return;
      }
      table.blocks.push(this.buildParagraph(start, end, pap, hidden));
      if (cellEnd) {
        table.cells.push({ blocks: table.blocks });
        table.blocks = [];
      }
    };

    let start = 0;
    for (let cp = 0; cp < n; cp++) {
      const code = chars[cp];
      if (code !== 0x0d && code !== 0x07 && code !== 0x0c) continue;
      // Une marque de paragraphe à l'intérieur d'un code de champ n'est pas une fin de paragraphe.
      if (hidden[cp] && code !== 0x07) continue;
      emit(start, cp, code);
      start = cp + 1;
    }
    if (start < n) emit(start, n, 0);
    setDepth(0);

    return renderBlocks(root);
  }

  /** Construit le bloc (paragraphe, titre ou élément de liste) couvrant [start, end[. */
  buildParagraph(start, end, pap, hidden) {
    const { chars, fcs, pieceOf, pieces, chpRuns } = this;
    const heading = this.headingLevel(pap.istd);
    const styleChp = this.styleChp(pap.istd);

    const segments = [];
    let current = null;
    let lastRun = -2;
    let lastPiece = -2;
    let format = null;
    let chp = null;

    const push = (text, fmt) => {
      if (current && current.format.key === fmt.key) {
        current.text += text;
      } else {
        current = { text, format: fmt };
        segments.push(current);
      }
    };

    for (let cp = start; cp < end; cp++) {
      if (hidden[cp]) continue;
      const code = chars[cp];
      const fc = fcs[cp];
      if (fc < 0) continue;

      const run = this.findRun(chpRuns, fc, lastRun);
      const pieceIndex = pieceOf[cp];
      if (run !== lastRun || pieceIndex !== lastPiece || !chp) {
        lastRun = run;
        lastPiece = pieceIndex;
        chp = { ...styleChp };
        const grpprl = run >= 0 ? chpRuns.runs[run].grpprl : null;
        if (grpprl) this.applyChpSprms(chp, grpprl, styleChp);
        const piece = pieces[pieceIndex];
        if (piece && piece.prmGrpprl) this.applyChpSprms(chp, piece.prmGrpprl, styleChp);
        format = this.formatOf(chp, styleChp, heading > 0, chp.ftc);
      }
      if (chp.deleted) continue;

      if (code < 0x20) {
        if (code === 0x09) {
          push('\t', format);
        } else if (code === 0x0b || code === 0x0a || code === 0x0e || code === 0x0d || code === 0x0c) {
          segments.push({ br: true });
          current = null;
        } else if (code === 0x1e) {
          push(NON_BREAKING_HYPHEN, format);
        }
        // 0x1F (césure optionnelle), 0x01/0x08 (ancres d'image), 0x02-0x05
        // (appels de note, d'annotation) et marques de champ : ignorés.
        continue;
      }
      if (chp.special && code === 0x28 && chp.symbolChar) {
        // Caractère inséré par « Insertion > Symbole » : il porte sa propre police.
        const symbol = chp.symbolChar < 0x100 ? 0xf000 | chp.symbolChar : chp.symbolChar;
        push(String.fromCharCode(symbol), this.formatOf(chp, styleChp, false, chp.symbolFtc));
        continue;
      }
      push(String.fromCharCode(code), format);
    }

    const inner = renderInline(segments);
    const list = this.listInfo(pap);
    if (list && !heading) {
      // Un élément vide garde sa place (et son numéro) grâce à l'espace insécable.
      return {
        kind: 'li',
        tag: list.tag,
        lsid: list.lsid,
        level: list.level,
        number: this.nextListNumber(list),
        inner: inner || '&nbsp;',
      };
    }
    if (!inner) return { kind: 'p', html: EMPTY_PARAGRAPH };
    const align = alignmentOf(pap);
    const tag = heading ? `h${Math.min(heading, 6)}` : 'p';
    return { kind: 'p', html: `<${tag}${align ? ` style="text-align:${align}"` : ''}>${inner}</${tag}>` };
  }

  /**
   * Mise en forme à émettre pour une suite de caractères. Dans un titre, seul
   * ce qui s'écarte du style de titre est émis (le <hN> porte déjà le reste).
   */
  formatOf(chp, styleChp, relative, ftc) {
    const bidi = chp.bidi;
    let bold = bidi ? chp.boldBi : chp.bold;
    let italic = bidi ? chp.italicBi : chp.italic;
    let underline = chp.underline !== 0;
    let size = bidi ? chp.hpsBi : chp.hps;
    let color = chp.color;
    let font = ftc >= 0 ? this.fonts[ftc] || '' : '';
    if (relative) {
      if (bidi ? styleChp.boldBi : styleChp.bold) bold = false;
      if (bidi ? styleChp.italicBi : styleChp.italic) italic = false;
      if (styleChp.underline !== 0) underline = false;
      if (size === (bidi ? styleChp.hpsBi : styleChp.hps)) size = 0;
      if (color === styleChp.color) color = null;
      if (ftc === styleChp.ftc) font = '';
    }
    // Noir = couleur par défaut ; le blanc serait illisible sans la trame de fond d'origine.
    if (color === '#000000' || color === '#FFFFFF') color = null;
    if (size < 2 || size > 3276) size = 0;
    const strike = chp.strike || chp.dstrike;
    const script = chp.iss === 1 ? 'sup' : chp.iss === 2 ? 'sub' : '';
    const css = [];
    if (size) css.push(`font-size:${size / 2}pt`);
    if (color) css.push(`color:${color}`);
    if (font) css.push(`font-family:'${font}'`);
    let open = '';
    let close = '';
    for (const tag of [bold && 'strong', italic && 'em', underline && 'u', strike && 's', script]) {
      if (!tag) continue;
      open += `<${tag}>`;
      close = `</${tag}>${close}`;
    }
    const style = css.join(';');
    return { key: `${style}|${open}`, style, open, close };
  }
}

function emptyRuns() {
  return { runs: [], starts: new Int32Array(0) };
}

/** sprmTDefTable : limites des cellules d'une ligne et indicateurs de fusion. */
function parseTableDefinition(b, o, size) {
  if (size < 3) return null;
  const count = b[o + 2];
  if (count < 1 || count > 64 || 3 + (count + 1) * 2 > size) return null;
  const edges = [];
  for (let i = 0; i <= count; i++) edges.push(b.readInt16LE(o + 3 + i * 2));
  const flags = [];
  const tcStart = o + 3 + (count + 1) * 2;
  for (let i = 0; i < count; i++) {
    const at = tcStart + i * 20;
    flags.push(at + 2 <= o + size ? b.readUInt16LE(at) : 0);
  }
  return { edges, flags };
}

/**
 * Repère les codes de champ : l'instruction (entre 0x13 et 0x14) est masquée,
 * le résultat (entre 0x14 et 0x15) est conservé. Les marques non appariées
 * sont laissées de côté pour ne jamais avaler la fin du document.
 */
function findFieldInstructions(chars) {
  const hidden = new Uint8Array(chars.length);
  const stack = [];
  for (let cp = 0; cp < chars.length; cp++) {
    const code = chars[cp];
    if (code === 0x13) {
      stack.push({ begin: cp, separator: -1 });
    } else if (code === 0x14) {
      const top = stack[stack.length - 1];
      if (top && top.separator < 0) top.separator = cp;
    } else if (code === 0x15 && stack.length) {
      const field = stack.pop();
      hidden.fill(1, field.begin, (field.separator >= 0 ? field.separator : cp) + 1);
      hidden[cp] = 1;
    }
  }
  return hidden;
}

function alignmentOf(pap) {
  let jc = pap.jc;
  if (pap.bidi && pap.jcLogical) jc = jc === 0 ? 2 : jc === 2 ? 0 : jc;
  if (jc === 1) return 'center';
  if (jc === 2) return 'right';
  if (jc === 3 || jc === 4 || jc === 5 || jc === 7 || jc === 8 || jc === 9) return 'justify';
  return pap.bidi ? 'right' : '';
}

/* ------------------------------------------------------------------------ */
/* Rendu HTML                                                                */
/* ------------------------------------------------------------------------ */

function encodeText(text) {
  // Tabulations et espaces multiples sont écrits en entités : le convertisseur
  // HTML → DOCX les conserve alors tels quels au lieu de les fusionner.
  return escapeHtml(text)
    .replace(/\t/g, '&#9;')
    .replace(/ {2,}|^ | $/g, (spaces) => '&#32;'.repeat(spaces.length));
}

/**
 * Sérialise le contenu d'un paragraphe ; renvoie '' s'il n'a rien de visible.
 * Les suites de même police/taille/couleur partagent un seul <span>.
 */
function renderInline(segments) {
  // Un élément qui ne contient que des espaces est supprimé par le
  // convertisseur HTML → DOCX : on rattache ces espaces au texte voisin.
  const items = [];
  let pendingSpace = '';
  for (const segment of segments) {
    if (segment.br) {
      pendingSpace = '';
      items.push(segment);
      continue;
    }
    const previous = items[items.length - 1];
    const joinable = previous && !previous.br;
    if (!/\S/.test(segment.text)) {
      if (joinable) previous.text += segment.text;
      else pendingSpace += segment.text;
      continue;
    }
    const text = pendingSpace + segment.text;
    pendingSpace = '';
    if (joinable && previous.format.key === segment.format.key) previous.text += text;
    else items.push({ text, format: segment.format });
  }
  // Les sauts de ligne en fin de paragraphe n'apportent rien.
  while (items.length && items[items.length - 1].br) items.pop();

  let html = '';
  for (let i = 0; i < items.length; ) {
    if (items[i].br) {
      html += '<br>';
      i++;
      continue;
    }
    const style = items[i].format.style;
    let group = '';
    for (; i < items.length; i++) {
      const item = items[i];
      if (item.br) {
        // Un saut de ligne reste dans le <span> si la même mise en forme reprend ensuite.
        const next = items[i + 1];
        if (!next || next.br || next.format.style !== style) break;
        group += '<br>';
      } else if (item.format.style === style) {
        group += item.format.open + encodeText(item.text) + item.format.close;
      } else {
        break;
      }
    }
    html += style ? `<span style="${style}">${group}</span>` : group;
  }
  return html;
}

function renderBlocks(blocks) {
  const out = [];
  for (let i = 0; i < blocks.length; ) {
    const block = blocks[i];
    if (block.kind === 'li') {
      let j = i;
      while (j < blocks.length && blocks[j].kind === 'li') j++;
      out.push(renderList(blocks.slice(i, j)));
      i = j;
    } else {
      out.push(block.kind === 'table' ? renderTable(block) : block.html);
      i++;
    }
  }
  return out.join('\n');
}

function renderList(items) {
  let html = '';
  const open = [];
  const start = (item) => {
    // Une liste numérotée interrompue reprend à son numéro (attribut start).
    const attribute = item.tag === 'ol' && item.number !== 1 && item.number >= 0 && item.number < 32768;
    html += `<${item.tag}${attribute ? ` start="${item.number}"` : ''}><li>`;
    return { tag: item.tag, level: item.level, lsid: item.lsid, expected: item.number + 1 };
  };
  for (const item of items) {
    while (open.length && open[open.length - 1].level > item.level) html += `</li></${open.pop().tag}>`;
    const top = open[open.length - 1];
    if (top && top.level === item.level) {
      const sameList = top.tag === item.tag && (item.tag === 'ul' || (top.lsid === item.lsid && top.expected === item.number));
      if (sameList) {
        html += '</li><li>';
        top.expected++;
      } else {
        html += `</li></${top.tag}>`;
        open[open.length - 1] = start(item);
      }
    } else {
      open.push(start(item));
    }
    html += item.inner;
  }
  while (open.length) html += `</li></${open.pop().tag}>`;
  return html;
}

/**
 * Calcule les colspan à partir des limites de cellules (sprmTDefTable).
 * Sans définition exploitable pour une ligne, ses cellules sont émises telles
 * quelles. Les fusions verticales ne sont pas reproduites : les cellules
 * concernées restent distinctes.
 */
function layoutTable(rows) {
  const TOLERANCE = 30; // twips
  const usable = (row) => row.tdef && row.tdef.edges.length === row.cells.length + 1;
  const edges = [];
  for (const row of rows) if (usable(row)) edges.push(...row.tdef.edges);
  edges.sort((a, b) => a - b);
  const grid = [];
  for (const edge of edges) if (!grid.length || edge - grid[grid.length - 1] > TOLERANCE) grid.push(edge);
  const column = (edge) => {
    let best = 0;
    for (let i = 1; i < grid.length; i++) if (Math.abs(grid[i] - edge) < Math.abs(grid[best] - edge)) best = i;
    return best;
  };
  const notEmpty = (block) => block.html !== EMPTY_PARAGRAPH;

  return rows.map((row) => {
    if (!usable(row)) return row.cells.map((cell) => ({ blocks: cell.blocks, colspan: 1 }));
    const { edges: rowEdges, flags } = row.tdef;
    const out = [];
    row.cells.forEach((cell, index) => {
      const from = column(rowEdges[index]);
      const span = Math.max(column(rowEdges[index + 1]) - from, 1);
      const flag = flags[index] || 0;
      // fMerged sans fFirstMerged : suite d'une fusion horizontale « à l'ancienne ».
      if ((flag & 0x0003) === 0x0002 && out.length) {
        const first = out[out.length - 1];
        first.colspan += span;
        first.blocks.push(...cell.blocks.filter(notEmpty));
        return;
      }
      out.push({ blocks: cell.blocks.slice(), colspan: span });
    });
    return out;
  });
}

function renderTable(table) {
  const rows = layoutTable(table.rows);
  let html = '<table>';
  for (const cells of rows) {
    if (!cells.length) continue;
    html += '<tr>';
    for (const cell of cells) {
      const attributes = cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '';
      html += `<td${attributes}>${renderBlocks(cell.blocks) || EMPTY_PARAGRAPH}</td>`;
    }
    html += '</tr>';
  }
  return `${html}</table>`;
}

/* ------------------------------------------------------------------------ */
/* Word 6 / Word 95 : texte brut uniquement                                  */
/* ------------------------------------------------------------------------ */

/** Page de codes probable d'après la langue du document (FIB.lid). */
function legacyEncoding(lid) {
  switch (lid & 0x3ff) {
    case 0x19: // russe
    case 0x22: // ukrainien
    case 0x23: // biélorusse
    case 0x02: // bulgare
      return 'windows-1251';
    case 0x05: // tchèque
    case 0x0e: // hongrois
    case 0x15: // polonais
    case 0x18: // roumain
    case 0x1b: // slovaque
    case 0x24: // slovène
      return 'windows-1250';
    case 0x08:
      return 'windows-1253'; // grec
    case 0x1f:
      return 'windows-1254'; // turc
    case 0x0d:
      return 'windows-1255'; // hébreu
    case 0x01:
      return 'windows-1256'; // arabe
    case 0x25:
    case 0x26:
    case 0x27:
      return 'windows-1257'; // langues baltes
    default:
      return 'windows-1252';
  }
}

function decodeLegacy(bytes, encoding) {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte >= 0x80 && byte < 0xa0 ? CP1252_HIGH[byte - 0x80] : byte);
    return text;
  }
}

function oldWordToHtml(wd) {
  const flags = wd.readUInt16LE(0x0a);
  if (flags & 0x0100) throw encryptedError();
  const fcMin = wd.readUInt32LE(0x18);
  const ccpText = wd.readUInt32LE(0x34);
  const parts = [];
  if (flags & 0x0004) {
    // Fichier « complexe » : le texte est réparti en morceaux, décrits dans le flux principal.
    let pos = wd.readUInt32LE(0x160);
    const end = Math.min(pos + wd.readUInt32LE(0x164), wd.length);
    while (pos < end && wd[pos] === 1) pos += 3 + wd.readUInt16LE(pos + 1);
    if (pos >= end || wd[pos] !== 2) throw new Error('corrupt piece table');
    const count = Math.floor((wd.readUInt32LE(pos + 1) - 4) / 12);
    pos += 5;
    for (let i = 0; i < count; i++) {
      const cpStart = wd.readUInt32LE(pos + i * 4);
      const cpEnd = Math.min(wd.readUInt32LE(pos + (i + 1) * 4), ccpText);
      const fc = wd.readUInt32LE(pos + (count + 1) * 4 + i * 8 + 2);
      if (cpEnd > cpStart && fc < wd.length) parts.push(wd.subarray(fc, Math.min(fc + cpEnd - cpStart, wd.length)));
    }
  } else {
    if (fcMin >= wd.length) throw new Error('bad text offset');
    parts.push(wd.subarray(fcMin, Math.min(fcMin + ccpText, wd.length)));
  }
  const raw = decodeLegacy(Buffer.concat(parts), legacyEncoding(wd.readUInt16LE(0x06)));

  const chars = Uint16Array.from(raw, (ch) => ch.charCodeAt(0));
  const hidden = findFieldInstructions(chars);
  let text = '';
  for (let i = 0; i < raw.length; i++) {
    const code = chars[i];
    if (code === 0x07) {
      // Marque de cellule ; deux marques de suite terminent la ligne du tableau.
      if (raw.charCodeAt(i + 1) === 0x07) {
        text += '\n';
        i++;
      } else {
        text += '\t';
      }
    } else if (hidden[i]) {
      continue;
    } else if (code === 0x0d || code === 0x0b || code === 0x0c) {
      text += '\n';
    } else if (code === 0x1e) {
      text += NON_BREAKING_HYPHEN;
    } else if (code === 0x09 || code >= 0x20) {
      text += raw[i];
    }
  }
  return plainTextToHtml(text);
}

/* ------------------------------------------------------------------------ */
/* Point d'entrée                                                            */
/* ------------------------------------------------------------------------ */

/** Lecture directe du format, avec mise en forme. Lève une exception si la structure est illisible. */
function convertWithFormatting(buffer) {
  const cfb = readCompoundFile(buffer);
  const wd = cfb.stream('WordDocument');
  if (!wd || wd.length < 0x60) throw new Error('missing WordDocument stream');
  const magic = wd.readUInt16LE(0);
  const nFib = wd.readUInt16LE(2);
  if (magic === 0xa5dc || (magic === 0xa5ec && nFib < 106)) return oldWordToHtml(wd);
  if (magic !== 0xa5ec) throw new Error('not a Word document');
  return new Word97Document(wd, cfb).toHtml();
}

/**
 * word-extractor ne se protège pas contre les fichiers abîmés : une chaîne de
 * secteurs cyclique le fait boucler jusqu'à épuisement de la mémoire, un
 * en-tête ou une table des morceaux incohérents lui font allouer des
 * gigaoctets. On ne lui confie donc que les fichiers dont la structure a été
 * vérifiée par nos soins.
 */
function isSafeForWordExtractor(buffer) {
  try {
    const cfb = readCompoundFile(buffer);
    if (!cfb.isConsistent()) return false;
    const wd = cfb.stream('WordDocument');
    if (!wd || wd.length < 0x200 || wd.readUInt16LE(0) !== 0xa5ec) return false;
    const doc = new Word97Document(wd, cfb);
    // word-extractor lit le FIB à des positions fixes.
    if (doc.rgFcLcb !== 0x9a || doc.pieces.length > 100000) return false;
    let bytes = 0;
    for (const piece of doc.pieces) bytes += (piece.cpEnd - piece.cpStart) * piece.bytesPerChar;
    return bytes <= wd.length * 4;
  } catch {
    return false;
  }
}

/** Repli : texte brut extrait par word-extractor, un <p> par paragraphe. */
async function convertPlainText(buffer) {
  const WordExtractor = require('word-extractor');
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('word-extractor timeout')), FALLBACK_TIMEOUT_MS);
  });
  try {
    const extracted = await Promise.race([new WordExtractor().extract(buffer), timeout]);
    const body = extracted.getBody({ filterUnicode: false });
    if (typeof body !== 'string') throw new Error('no body text');
    return plainTextToHtml(body);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convertit un fichier .doc (Word 97-2003) en fragment HTML (contenu de <body>).
 * @param {Buffer} buffer contenu du fichier
 * @returns {Promise<string>}
 * @throws {Error} message en français ; `code` vaut 'DOC_ENCRYPTED' ou 'DOC_UNREADABLE'
 */
async function docToHtml(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    if (buffer instanceof ArrayBuffer) buffer = Buffer.from(buffer);
    else if (ArrayBuffer.isView(buffer)) buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    else throw new TypeError('docToHtml attend un Buffer.');
  }

  let formatted = null;
  try {
    formatted = convertWithFormatting(buffer);
    if (hasVisibleText(formatted)) return formatted;
  } catch (error) {
    if (error instanceof DocError) throw error;
  }

  // La lecture directe a échoué ou n'a rien trouvé : on tente le texte brut.
  if (isSafeForWordExtractor(buffer)) {
    try {
      const plain = await convertPlainText(buffer);
      if (formatted === null || hasVisibleText(plain)) return plain;
    } catch {
      // On signale l'échec ci-dessous.
    }
  }
  if (formatted !== null) return formatted || EMPTY_PARAGRAPH;

  throw new DocError(
    'Impossible de lire ce fichier .doc : il est endommagé ou son format n’est pas reconnu.',
    'DOC_UNREADABLE',
  );
}

module.exports = { docToHtml };
