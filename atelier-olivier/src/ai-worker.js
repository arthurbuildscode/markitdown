// Travailleur « magie » : super-résolution (Real-ESRGAN) et colorisation automatique
// (Zhang et al.), exécutées localement avec ONNX Runtime Web. Rien ne quitte l'ordinateur.

const base = self.location.href;
let ortPromise = null;
const sessions = new Map();
const cancelled = new Set();

function threadCount() {
  const cores = self.navigator.hardwareConcurrency || 4;
  return cores <= 4 ? cores : Math.min(8, Math.ceil(cores * 0.6));
}

function loadOrt() {
  if (!ortPromise) {
    ortPromise = import(/* @vite-ignore */ new URL('ort/ort.wasm.min.mjs', base).href).then((ort) => {
      ort.env.wasm.wasmPaths = new URL('ort/', base).href;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? threadCount() : 1;
      ort.env.logLevel = 'error';
      return ort;
    });
  }
  return ortPromise;
}

async function session(name) {
  const ort = await loadOrt();
  if (!sessions.has(name)) {
    const response = await fetch(new URL(`models/${name}.onnx`, base));
    if (!response.ok) throw new Error(`Modèle « ${name} » introuvable`);
    const model = new Uint8Array(await response.arrayBuffer());
    sessions.set(name, await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }));
  }
  return { ort, model: sessions.get(name) };
}

async function release(name) {
  const model = sessions.get(name);
  sessions.delete(name);
  if (model) await model.release();
}

const progress = (id, value, message) => self.postMessage({ type: 'progress', id, value, message });

function checkCancelled(id) {
  if (cancelled.has(id)) {
    cancelled.delete(id);
    throw new Error('__annule__');
  }
}

// --- Définition : agrandissement / restauration par tuiles -------------------
const TILE = 192;
const PAD = 10;

async function upscale({ id, width, height, buffer, factor }) {
  progress(id, 0, 'Préparation du modèle…');
  const { ort, model } = await session('upscale-x4');
  const src = new Uint8ClampedArray(buffer);
  const k = 4 / factor; // réduction appliquée à la sortie x4 (1, 2 ou 4)
  const total = Math.ceil(width / TILE) * Math.ceil(height / TILE);
  let done = 0;

  for (let ty = 0; ty < height; ty += TILE) {
    for (let tx = 0; tx < width; tx += TILE) {
      checkCancelled(id);
      const tw = Math.min(TILE, width - tx);
      const th = Math.min(TILE, height - ty);
      const px = Math.max(0, tx - PAD);
      const py = Math.max(0, ty - PAD);
      const pw = Math.min(width, tx + tw + PAD) - px;
      const ph = Math.min(height, ty + th + PAD) - py;

      const input = new Float32Array(3 * pw * ph);
      const plane = pw * ph;
      for (let y = 0; y < ph; y++) {
        let s = ((py + y) * width + px) * 4;
        let d = y * pw;
        for (let x = 0; x < pw; x++, s += 4, d++) {
          input[d] = src[s] / 255;
          input[d + plane] = src[s + 1] / 255;
          input[d + 2 * plane] = src[s + 2] / 255;
        }
      }
      const tensor = new ort.Tensor('float32', input, [1, 3, ph, pw]);
      const result = await model.run({ image: tensor });
      const out = result.upscaled.data;
      const ow = pw * 4;
      const oplane = ow * ph * 4;

      const fw = tw * factor;
      const fh = th * factor;
      const tile = new Uint8ClampedArray(fw * fh * 4);
      const ox = (tx - px) * 4;
      const oy = (ty - py) * 4;
      const norm = 255 / (k * k);
      for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
          let r = 0;
          let g = 0;
          let b = 0;
          for (let j = 0; j < k; j++) {
            let o = (oy + y * k + j) * ow + ox + x * k;
            for (let i = 0; i < k; i++, o++) {
              r += out[o];
              g += out[o + oplane];
              b += out[o + 2 * oplane];
            }
          }
          const d = (y * fw + x) * 4;
          tile[d] = r * norm;
          tile[d + 1] = g * norm;
          tile[d + 2] = b * norm;
          const sx = Math.min(width - 1, tx + Math.floor(x / factor));
          const sy = Math.min(height - 1, ty + Math.floor(y / factor));
          tile[d + 3] = src[(sy * width + sx) * 4 + 3];
        }
      }
      tensor.dispose();
      result.upscaled.dispose();
      done += 1;
      self.postMessage({ type: 'tile', id, x: tx * factor, y: ty * factor, width: fw, height: fh, data: tile }, [tile.buffer]);
      progress(id, done / total, 'Reconstruction des détails…');
    }
  }
  self.postMessage({ type: 'done', id });
}

// --- Colorisation automatique -------------------------------------------------
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const LINEAR_TO_SRGB = new Uint8ClampedArray(4097);
for (let i = 0; i <= 4096; i++) {
  const c = i / 4096;
  LINEAR_TO_SRGB[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
}

function lightness(r, g, b) {
  const y = 0.2126729 * SRGB_TO_LINEAR[r] + 0.7151522 * SRGB_TO_LINEAR[g] + 0.072175 * SRGB_TO_LINEAR[b];
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

const labInverse = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);

async function colorize({ id, width, height, buffer, strength = 1 }) {
  progress(id, 0.02, 'Préparation du modèle de colorisation…');
  const { ort, model } = await session('colorize');
  checkCancelled(id);
  const src = new Uint8ClampedArray(buffer);

  // Le modèle « regarde » une version réduite (petit côté 256 px, multiples de 8).
  let scale = 256 / Math.min(width, height);
  if (Math.max(width, height) * scale > 512) scale = 512 / Math.max(width, height);
  const mw = Math.max(32, Math.round((width * scale) / 8) * 8);
  const mh = Math.max(32, Math.round((height * scale) / 8) * 8);

  progress(id, 0.2, 'Analyse de la photo…');
  const lum = new Float32Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const y0 = Math.floor((y * height) / mh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / mh));
    for (let x = 0; x < mw; x++) {
      const x0 = Math.floor((x * width) / mw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / mw));
      let sum = 0;
      let n = 0;
      const stepY = Math.max(1, Math.floor((y1 - y0) / 4));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 4));
      for (let j = y0; j < y1; j += stepY) {
        for (let i = x0; i < x1; i += stepX) {
          const s = (j * width + i) * 4;
          sum += lightness(src[s], src[s + 1], src[s + 2]);
          n++;
        }
      }
      lum[y * mw + x] = sum / n;
    }
  }

  const tensor = new ort.Tensor('float32', lum, [1, 1, mh, mw]);
  const result = await model.run({ lum: tensor });
  const ab = result.ab.data;
  tensor.dispose();
  checkCancelled(id);
  progress(id, 0.75, 'Application des couleurs…');

  const plane = mw * mh;
  const fxScale = mw / width;
  const fyScale = mh / height;
  for (let y = 0; y < height; y++) {
    const gy = Math.min(mh - 1, Math.max(0, (y + 0.5) * fyScale - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(mh - 1, y0 + 1);
    const wy = gy - y0;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(mw - 1, Math.max(0, (x + 0.5) * fxScale - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(mw - 1, x0 + 1);
      const wx = gx - x0;
      const i00 = y0 * mw + x0;
      const i01 = y0 * mw + x1;
      const i10 = y1 * mw + x0;
      const i11 = y1 * mw + x1;
      const w00 = (1 - wx) * (1 - wy);
      const w01 = wx * (1 - wy);
      const w10 = (1 - wx) * wy;
      const w11 = wx * wy;
      const a = (ab[i00] * w00 + ab[i01] * w01 + ab[i10] * w10 + ab[i11] * w11) * strength;
      const b = (ab[i00 + plane] * w00 + ab[i01 + plane] * w01 + ab[i10 + plane] * w10 + ab[i11 + plane] * w11) * strength;

      const s = (y * width + x) * 4;
      const L = lightness(src[s], src[s + 1], src[s + 2]);
      const fy = (L + 16) / 116;
      const X = 0.95047 * labInverse(fy + a / 500);
      const Y = labInverse(fy);
      const Z = 1.08883 * labInverse(fy - b / 200);
      const r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
      const g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
      const bl = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
      src[s] = LINEAR_TO_SRGB[Math.min(4096, Math.max(0, Math.round(r * 4096)))];
      src[s + 1] = LINEAR_TO_SRGB[Math.min(4096, Math.max(0, Math.round(g * 4096)))];
      src[s + 2] = LINEAR_TO_SRGB[Math.min(4096, Math.max(0, Math.round(bl * 4096)))];
    }
  }
  result.ab.dispose();
  await release('colorize'); // libère ~300 Mo de mémoire
  self.postMessage({ type: 'done', id, buffer: src.buffer }, [src.buffer]);
}

self.onmessage = async (event) => {
  const job = event.data;
  if (job.type === 'cancel') {
    cancelled.add(job.id);
    return;
  }
  try {
    if (job.type === 'upscale') await upscale(job);
    else if (job.type === 'colorize') await colorize(job);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    self.postMessage({ type: 'error', id: job.id, cancelled: message === '__annule__', message });
  }
};
