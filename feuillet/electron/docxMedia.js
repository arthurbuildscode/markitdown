'use strict';
/**
 * Remise en ordre des images d'un .docx avant écriture sur disque.
 *
 * À l'enregistrement, le moteur d'édition réinsère chaque image comme un
 * nouveau fichier `word/media/imageN.png`, y compris quand il s'agit en réalité
 * d'un WMF, d'un EMF ou d'un JPEG, et laisse l'original en place. Sans
 * correction, le document grossit à chaque enregistrement et Word reçoit des
 * images dont l'extension ne correspond pas au contenu.
 *
 * Ici, les images identiques sont ramenées à un seul fichier, portant une
 * extension conforme à son contenu, et les liens du document sont mis à jour.
 */
const crypto = require('node:crypto');
const JSZip = require('jszip');

/** Formats reconnus : extensions acceptées (la première sert en cas de renommage) et type MIME. */
const KINDS = {
  png: { extensions: ['png'], mime: 'image/png' },
  jpeg: { extensions: ['jpeg', 'jpg', 'jpe'], mime: 'image/jpeg' },
  gif: { extensions: ['gif'], mime: 'image/gif' },
  bmp: { extensions: ['bmp', 'dib'], mime: 'image/bmp' },
  tiff: { extensions: ['tiff', 'tif'], mime: 'image/tiff' },
  emf: { extensions: ['emf'], mime: 'image/x-emf' },
  wmf: { extensions: ['wmf'], mime: 'image/x-wmf' },
};

function sniff(data) {
  if (data.length < 44) return null;
  if (data.readUInt32BE(0) === 0x89504e47) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpeg';
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (data[0] === 0x42 && data[1] === 0x4d) return 'bmp';
  if (data.readUInt32BE(0) === 0x49492a00 || data.readUInt32BE(0) === 0x4d4d002a) return 'tiff';
  if (data.readUInt32LE(0) === 1 && data.subarray(40, 44).toString('latin1') === ' EMF') return 'emf';
  if (data.readUInt32LE(0) === 0x9ac6cdd7) return 'wmf'; // WMF « plaçable »
  if (data.readUInt16LE(2) === 9 && [1, 2].includes(data.readUInt16LE(0))) return 'wmf';
  return null;
}

const extensionOf = (name) => (/\.([^./]+)$/.exec(name)?.[1] ?? '').toLowerCase();

/**
 * @param {Buffer} buffer contenu .docx produit par l'éditeur
 * @returns {Promise<Buffer>} le même contenu, images dédoublonnées ; `buffer` tel quel s'il n'y a rien à corriger
 */
async function tidyDocxMedia(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const mediaNames = Object.keys(zip.files).filter((name) => /^word\/media\/[^/]+$/.test(name) && !zip.files[name].dir);
  if (!mediaNames.length) return buffer;

  /** empreinte du contenu → fichiers ayant ce contenu, dans l'ordre de l'archive (originaux d'abord) */
  const groups = new Map();
  for (const name of mediaNames) {
    const data = await zip.file(name).async('nodebuffer');
    const hash = crypto.createHash('sha1').update(data).digest('hex');
    if (!groups.has(hash)) groups.set(hash, { kind: sniff(data), data, names: [] });
    groups.get(hash).names.push(name);
  }

  const taken = new Set(Object.keys(zip.files));
  /** ancien chemin → chemin conservé */
  const moved = new Map();
  const usedKinds = new Set();
  for (const { kind, data, names } of groups.values()) {
    const fits = (name) => !kind || KINDS[kind].extensions.includes(extensionOf(name));
    let kept = names.find(fits);
    if (!kept) {
      // Aucun exemplaire correctement nommé : on renomme le premier.
      const base = names[0].replace(/\.[^./]+$/, '');
      const extension = KINDS[kind].extensions[0];
      kept = `${base}.${extension}`;
      for (let i = 1; taken.has(kept); i++) kept = `${base}_${i}.${extension}`;
      taken.add(kept);
      zip.file(kept, data);
      usedKinds.add(kind);
    }
    for (const name of names) {
      if (name === kept) continue;
      moved.set(name, kept);
      zip.remove(name);
    }
  }
  if (!moved.size) return buffer;

  // Liens du document, des en-têtes, des pieds de page… vers les fichiers conservés.
  for (const relsName of Object.keys(zip.files).filter((name) => /^word\/_rels\/[^/]+\.rels$/.test(name))) {
    const xml = await zip.file(relsName).async('string');
    const updated = xml.replace(/Target="([^"]+)"/g, (match, target) => {
      const absolute = target.startsWith('/');
      const kept = moved.get(absolute ? target.slice(1) : `word/${target}`);
      if (!kept) return match;
      return `Target="${absolute ? `/${kept}` : kept.slice('word/'.length)}"`;
    });
    if (updated !== xml) zip.file(relsName, updated);
  }

  // Une extension apparue par renommage doit être déclarée dans les types de contenu.
  const typesEntry = zip.file('[Content_Types].xml');
  if (typesEntry && usedKinds.size) {
    let types = await typesEntry.async('string');
    for (const kind of usedKinds) {
      const extension = KINDS[kind].extensions[0];
      if (new RegExp(`<Default[^>]*Extension="${extension}"`, 'i').test(types)) continue;
      types = types.replace(/<Types[^>]*>/, (open) => `${open}<Default Extension="${extension}" ContentType="${KINDS[kind].mime}"/>`);
    }
    zip.file('[Content_Types].xml', types);
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { tidyDocxMedia };
