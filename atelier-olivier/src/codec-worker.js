// Travailleur dédié aux formats que le navigateur ne gère pas nativement
// (TIFF, HEIC, BMP, GIF, AVIF) : l'interface reste fluide pendant l'encodage.
import * as UTIF from 'utif2';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

let avifModule = null;
let heifModule = null;

function decodeTiff(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const pages = UTIF.decode(buffer).filter((ifd) => ifd.t256 && ifd.t257);
  if (!pages.length) throw new Error('TIFF illisible');
  const page = pages.reduce((best, ifd) => (ifd.t256[0] * ifd.t257[0] > best.t256[0] * best.t257[0] ? ifd : best));
  UTIF.decodeImage(buffer, page);
  const rgba = UTIF.toRGBA8(page);
  return { width: page.width, height: page.height, rgba };
}

async function decodeHeic(bytes) {
  if (!heifModule) {
    const loaded = await import('libheif-js/wasm-bundle');
    heifModule = loaded.default || loaded;
  }
  const decoder = new heifModule.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images || !images.length) throw new Error('HEIC illisible');
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  const rgba = await new Promise((resolve, reject) => {
    image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (result) => {
      if (!result) reject(new Error('Décodage HEIC impossible'));
      else resolve(result.data);
    });
  });
  images.forEach((img) => img.free && img.free());
  return { width, height, rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) };
}

function encodeBmp(rgba, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const out = new Uint8Array(54 + rowSize * height);
  const view = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(2, out.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, rowSize * height, true);
  view.setInt32(38, 3780, true);
  view.setInt32(42, 3780, true);
  for (let y = 0; y < height; y++) {
    let src = (height - 1 - y) * width * 4;
    let dst = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      out[dst++] = rgba[src + 2];
      out[dst++] = rgba[src + 1];
      out[dst++] = rgba[src];
      src += 4;
    }
  }
  return out;
}

function encodeGif(rgba, width, height) {
  const palette = quantize(rgba, 256);
  const index = applyPalette(rgba, palette);
  const gif = GIFEncoder();
  gif.writeFrame(index, width, height, { palette });
  gif.finish();
  return gif.bytes();
}

async function encodeAvif(rgba, width, height, quality) {
  if (!avifModule) {
    const { default: factory } = await import('@jsquash/avif/codec/enc/avif_enc.js');
    const wasm = await WebAssembly.compileStreaming(fetch(new URL('codecs/avif_enc.wasm', self.location.href)));
    avifModule = await factory({
      instantiateWasm(imports, done) {
        WebAssembly.instantiate(wasm, imports).then((instance) => done(instance));
        return {};
      },
    });
  }
  const output = avifModule.encode(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height, {
    quality,
    qualityAlpha: -1,
    denoiseLevel: 0,
    tileColsLog2: 0,
    tileRowsLog2: 0,
    speed: 7,
    subsample: 1,
    chromaDeltaQ: false,
    sharpness: 0,
    tune: 0,
    enableSharpYUV: false,
    bitDepth: 8,
    lossless: false,
  });
  if (!output) throw new Error('Encodage AVIF impossible');
  return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
}

self.onmessage = async (event) => {
  const { id, task, bytes, width, height, quality } = event.data;
  try {
    if (task === 'decode-tiff' || task === 'decode-heic') {
      const result = task === 'decode-tiff' ? decodeTiff(bytes) : await decodeHeic(bytes);
      const rgba = new Uint8ClampedArray(result.rgba.buffer.slice(result.rgba.byteOffset, result.rgba.byteOffset + result.rgba.byteLength));
      self.postMessage({ id, width: result.width, height: result.height, rgba }, [rgba.buffer]);
      return;
    }
    let out;
    if (task === 'encode-tiff') out = new Uint8Array(UTIF.encodeImage(bytes, width, height));
    else if (task === 'encode-bmp') out = encodeBmp(bytes, width, height);
    else if (task === 'encode-gif') out = encodeGif(bytes, width, height);
    else if (task === 'encode-avif') out = await encodeAvif(bytes, width, height, quality);
    else throw new Error('Tâche inconnue : ' + task);
    const copy = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out : out.slice();
    self.postMessage({ id, bytes: copy }, [copy.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
};
