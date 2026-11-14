// Ouverture et enregistrement des images dans tous les formats courants.
import { PDFDocument } from 'pdf-lib';

export const FORMATS = [
  { id: 'jpeg', label: 'JPEG', ext: 'jpg', hint: 'Le plus courant, idéal pour les photos', quality: 92 },
  { id: 'png', label: 'PNG', ext: 'png', hint: 'Sans perte de qualité' },
  { id: 'pdf', label: 'PDF', ext: 'pdf', hint: 'Document à imprimer ou envoyer', quality: 92 },
  { id: 'webp', label: 'WebP', ext: 'webp', hint: 'Léger, pour Internet', quality: 90 },
  { id: 'tiff', label: 'TIFF', ext: 'tif', hint: 'Impression et archivage' },
  { id: 'avif', label: 'AVIF', ext: 'avif', hint: 'Très léger, récent', quality: 70 },
  { id: 'bmp', label: 'BMP', ext: 'bmp', hint: 'Bitmap Windows' },
  { id: 'gif', label: 'GIF', ext: 'gif', hint: '256 couleurs' },
];

export const MAX_SIDE = 16000;
export const MAX_PIXELS = 120e6;

let worker = null;
let nextId = 1;
const pending = new Map();

function callWorker(message, transfer) {
  if (!worker) {
    worker = new Worker(new URL('codec-worker.js', document.baseURI), { type: 'module' });
    worker.onmessage = (event) => {
      const job = pending.get(event.data.id);
      if (!job) return;
      pending.delete(event.data.id);
      if (event.data.error) job.reject(new Error(event.data.error));
      else job.resolve(event.data);
    };
    worker.onerror = (event) => {
      for (const job of pending.values()) job.reject(new Error(event.message || 'Erreur du module de formats'));
      pending.clear();
      worker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id }, transfer);
  });
}

export function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function context(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

/** Réduction de haute qualité (par moitiés successives). */
export function resizeCanvas(source, width, height) {
  let current = source;
  while (current.width / 2 > width && current.height / 2 > height) {
    const half = makeCanvas(Math.ceil(current.width / 2), Math.ceil(current.height / 2));
    const hctx = context(half);
    hctx.imageSmoothingQuality = 'high';
    hctx.drawImage(current, 0, 0, half.width, half.height);
    current = half;
  }
  const out = makeCanvas(width, height);
  const ctx = context(out);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, 0, 0, width, height);
  return out;
}

function sniff(bytes, name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[3] === 0x2a)) return 'tiff';
  if (bytes.length > 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  if (ext === 'svg') return 'svg';
  return 'native';
}

function fitWithinLimits(canvas) {
  const scale = Math.min(1, MAX_SIDE / Math.max(canvas.width, canvas.height), Math.sqrt(MAX_PIXELS / (canvas.width * canvas.height)));
  if (scale >= 1) return { canvas, reduced: false };
  return { canvas: resizeCanvas(canvas, Math.round(canvas.width * scale), Math.round(canvas.height * scale)), reduced: true };
}

/** Décode un fichier image en canvas 2D. */
export async function decodeImage(bytes, name) {
  const kind = sniff(bytes, name);
  let canvas;
  if (kind === 'tiff' || kind === 'heic') {
    const copy = bytes.slice();
    const result = await callWorker({ task: 'decode-' + kind, bytes: copy }, [copy.buffer]);
    canvas = makeCanvas(result.width, result.height);
    context(canvas).putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
  } else if (kind === 'svg') {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.max(1, 2000 / Math.max(img.naturalWidth || 300, img.naturalHeight || 150));
      canvas = makeCanvas(Math.round((img.naturalWidth || 300) * scale), Math.round((img.naturalHeight || 150) * scale));
      context(canvas).drawImage(img, 0, 0, canvas.width, canvas.height);
    } finally {
      URL.revokeObjectURL(url);
    }
  } else {
    const bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
    canvas = makeCanvas(bitmap.width, bitmap.height);
    context(canvas).drawImage(bitmap, 0, 0);
    bitmap.close();
  }
  return fitWithinLimits(canvas);
}

function flatten(canvas) {
  const out = makeCanvas(canvas.width, canvas.height);
  const ctx = context(out);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

async function toBytes(canvas, type, quality) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new Error("L'encodage a échoué (image trop grande ?)");
  return new Uint8Array(await blob.arrayBuffer());
}

async function encodePdf(canvas, quality, layout) {
  const jpeg = await toBytes(flatten(canvas), 'image/jpeg', quality);
  const pdf = await PDFDocument.create();
  pdf.setTitle('Photo');
  pdf.setCreator("L'Atelier d'Olivier");
  pdf.setProducer("L'Atelier d'Olivier");
  const image = await pdf.embedJpg(jpeg);
  if (layout === 'a4') {
    const landscape = canvas.width > canvas.height;
    const pageW = landscape ? 841.89 : 595.28;
    const pageH = landscape ? 595.28 : 841.89;
    const margin = 28.35; // 1 cm
    const scale = Math.min((pageW - 2 * margin) / canvas.width, (pageH - 2 * margin) / canvas.height);
    const w = canvas.width * scale;
    const h = canvas.height * scale;
    const page = pdf.addPage([pageW, pageH]);
    page.drawImage(image, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h });
  } else {
    // Page aux dimensions exactes de la photo, à 300 points par pouce (taille d'impression).
    const w = (canvas.width * 72) / 300;
    const h = (canvas.height * 72) / 300;
    const page = pdf.addPage([w, h]);
    page.drawImage(image, { x: 0, y: 0, width: w, height: h });
  }
  return pdf.save();
}

/** Encode un canvas dans le format demandé et renvoie les octets du fichier. */
export async function encodeImage(canvas, format, { quality = 92, pdfLayout = 'image' } = {}) {
  const q = Math.min(1, Math.max(0.05, quality / 100));
  switch (format) {
    case 'jpeg':
      return toBytes(flatten(canvas), 'image/jpeg', q);
    case 'png':
      return toBytes(canvas, 'image/png');
    case 'webp':
      return toBytes(canvas, 'image/webp', q);
    case 'pdf':
      return encodePdf(canvas, q, pdfLayout);
    case 'tiff':
    case 'bmp':
    case 'gif':
    case 'avif': {
      const source = format === 'tiff' || format === 'avif' ? canvas : flatten(canvas);
      const data = context(source).getImageData(0, 0, source.width, source.height).data;
      const bytes = new Uint8Array(data.buffer);
      const result = await callWorker({ task: 'encode-' + format, bytes, width: source.width, height: source.height, quality }, [bytes.buffer]);
      return result.bytes;
    }
    default:
      throw new Error('Format inconnu : ' + format);
  }
}
