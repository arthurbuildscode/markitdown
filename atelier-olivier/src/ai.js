// Côté interface : pilote le travailleur IA (définition et colorisation).
import { makeCanvas, context, MAX_SIDE, MAX_PIXELS } from './codecs.js';

let worker = null;
let nextId = 1;
const jobs = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('ai-worker.js', document.baseURI), { type: 'module' });
  worker.onmessage = (event) => {
    const message = event.data;
    const job = jobs.get(message.id);
    if (!job) return;
    if (message.type === 'progress') job.onProgress(message.value, message.message);
    else if (message.type === 'tile') job.onTile(message);
    else if (message.type === 'done') {
      jobs.delete(message.id);
      job.resolve(message);
    } else if (message.type === 'error') {
      jobs.delete(message.id);
      const error = new Error(message.message);
      error.cancelled = message.cancelled;
      job.reject(error);
    }
  };
  worker.onerror = (event) => {
    for (const job of jobs.values()) job.reject(new Error(event.message || 'Le module IA a rencontré une erreur'));
    jobs.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

function run(message, transfer, handlers) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, onProgress: handlers.onProgress || (() => {}), onTile: handlers.onTile || (() => {}) });
  });
  ensureWorker().postMessage({ ...message, id }, transfer);
  return { promise, cancel: () => worker && worker.postMessage({ type: 'cancel', id }) };
}

/** Indique si l'agrandissement demandé reste dans des limites raisonnables. */
export function canUpscale(width, height, factor) {
  const w = width * factor;
  const h = height * factor;
  return Math.max(w, h) <= MAX_SIDE && w * h <= MAX_PIXELS;
}

/** Super-résolution : factor = 1 (restauration), 2 ou 4. Renvoie { promise<canvas>, cancel }. */
export function upscale(canvas, factor, onProgress) {
  const { width, height } = canvas;
  const data = context(canvas).getImageData(0, 0, width, height).data;
  const out = makeCanvas(width * factor, height * factor);
  const octx = context(out);
  const job = run({ type: 'upscale', width, height, buffer: data.buffer, factor }, [data.buffer], {
    onProgress,
    onTile: (tile) => octx.putImageData(new ImageData(tile.data, tile.width, tile.height), tile.x, tile.y),
  });
  return { promise: job.promise.then(() => out), cancel: job.cancel };
}

/** Colorisation automatique d'une photo noir et blanc. Renvoie { promise<canvas>, cancel }. */
export function colorize(canvas, onProgress) {
  const { width, height } = canvas;
  const data = context(canvas).getImageData(0, 0, width, height).data;
  const job = run({ type: 'colorize', width, height, buffer: data.buffer, strength: 1.15 }, [data.buffer], { onProgress });
  return {
    promise: job.promise.then((message) => {
      const out = makeCanvas(width, height);
      context(out).putImageData(new ImageData(new Uint8ClampedArray(message.buffer), width, height), 0, 0);
      return out;
    }),
    cancel: job.cancel,
  };
}
