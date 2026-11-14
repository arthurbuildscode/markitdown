// L'Atelier d'Olivier — logique de l'interface.
import { Engine } from './engine.js';
import { DEFAULTS, SLIDER_GROUPS, PRESETS, TONES, BW_FILTERS, isNeutral, analyse, autoEnhance } from './params.js';
import { FORMATS, decodeImage, encodeImage, resizeCanvas, makeCanvas, context } from './codecs.js';
import * as ai from './ai.js';

const $ = (selector) => document.querySelector(selector);
const api = window.atelier;
const app = $('#app');
const stage = $('#stage');
const viewHost = $('#view');

const state = {
  file: null,
  base: null,
  params: { ...DEFAULTS },
  history: [],
  index: -1,
  savedEntry: null,
  crop: null,
  compare: false,
  splitX: 0,
  holdBefore: false,
  busy: false,
  tab: 'reglages',
};
const view = { zoom: 1, panX: 0, panY: 0, fit: true };
const controls = {};
let engine = null;

const rad = (degrees) => (degrees * Math.PI) / 180;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const dpr = () => window.devicePixelRatio || 1;
const megapixels = (w, h) => {
  const mp = (w * h) / 1e6;
  return mp >= 10 ? Math.round(mp) : Math.round(mp * 10) / 10;
};
const formatSize = (w, h) => `${w.toLocaleString('fr-FR')} × ${h.toLocaleString('fr-FR')} px`;

// ---------------------------------------------------------------------------
// Notifications et écran d'attente
// ---------------------------------------------------------------------------
function toast(message, { error = false, action, onAction, duration = 4200 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action;
    button.addEventListener('click', () => {
      onAction();
      el.remove();
    });
    el.append(button);
  }
  $('#toasts').append(el);
  setTimeout(() => el.remove(), error ? 7000 : action ? 9000 : duration);
}

const busy = {
  startedAt: 0,
  show(title, { cancel = null, indeterminate = true } = {}) {
    state.busy = true;
    this.startedAt = 0;
    $('#busy-title').textContent = title;
    $('#busy-detail').textContent = '';
    $('#busy-bar').style.width = '0%';
    $('#busy .progress').classList.toggle('indeterminate', indeterminate);
    const button = $('#busy-cancel');
    button.hidden = !cancel;
    button.onclick = cancel
      ? () => {
          button.disabled = true;
          $('#busy-detail').textContent = 'Annulation…';
          cancel();
        }
      : null;
    button.disabled = false;
    $('#busy').hidden = false;
  },
  update(value, detail, { eta = false } = {}) {
    $('#busy .progress').classList.remove('indeterminate');
    $('#busy-bar').style.width = `${Math.round(clamp(value, 0, 1) * 100)}%`;
    let text = detail || '';
    if (eta && value > 0) {
      if (!this.startedAt) this.startedAt = performance.now() - 1;
      const elapsed = (performance.now() - this.startedAt) / 1000;
      const remaining = (elapsed * (1 - value)) / value;
      if (elapsed > 3 && value < 1) {
        text += remaining > 90 ? ` — encore ${Math.round(remaining / 60)} min environ` : ` — encore ${Math.max(1, Math.round(remaining))} s environ`;
      }
    }
    $('#busy-detail').textContent = text;
  },
  hide() {
    state.busy = false;
    $('#busy').hidden = true;
  },
};

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

// ---------------------------------------------------------------------------
// Curseurs
// ---------------------------------------------------------------------------
function createSlider(container, { label, min = -100, max = 100, value = 0, defaultValue = 0, track, suffix = '', onInput, onChange }) {
  const el = document.createElement('div');
  el.className = 'slider';
  if (track) el.dataset.track = track;
  el.innerHTML = '<div class="slider-head"><span class="slider-label"></span><span class="slider-value"></span></div><input type="range">';
  el.querySelector('.slider-label').textContent = label;
  const input = el.querySelector('input');
  const readout = el.querySelector('.slider-value');
  input.min = min;
  input.max = max;
  input.step = 1;
  input.setAttribute('aria-label', label);

  const paint = () => {
    const v = Number(input.value);
    readout.textContent = (min < 0 && v > 0 ? '+' : '') + v + suffix;
    el.classList.toggle('changed', v !== defaultValue);
    if (!track) {
      const at = (x) => `calc(8px + (100% - 16px) * ${(x - min) / (max - min)})`;
      const from = at(Math.min(v, min < 0 ? 0 : min));
      const to = at(Math.max(v, min < 0 ? 0 : min));
      input.style.setProperty('--fill', `linear-gradient(90deg, #3d452c ${from}, #b7c267 ${from}, #b7c267 ${to}, #3d452c ${to})`);
    }
  };
  input.value = value;
  paint();
  input.addEventListener('input', () => {
    paint();
    onInput(Number(input.value));
  });
  input.addEventListener('change', () => onChange && onChange(Number(input.value)));
  el.addEventListener('dblclick', () => {
    if (Number(input.value) === defaultValue) return;
    input.value = defaultValue;
    paint();
    onInput(defaultValue);
    if (onChange) onChange(defaultValue);
  });
  el.title = 'Double-clic pour remettre à zéro';
  container.append(el);
  return {
    el,
    set(v) {
      input.value = v;
      paint();
    },
  };
}

function paramSlider(container, key, label, options = {}) {
  const scale = options.scale || 100;
  controls[key] = createSlider(container, {
    label,
    min: options.min ?? -100,
    max: options.max ?? 100,
    track: options.track,
    suffix: options.suffix,
    defaultValue: Math.round(DEFAULTS[key] * scale),
    value: Math.round(state.params[key] * scale),
    onInput: (v) => {
      state.params[key] = v / scale;
      requestDraw();
    },
    onChange: () => commit(label),
  });
  controls[key].scale = scale;
}

function syncControls() {
  for (const [key, control] of Object.entries(controls)) {
    if (control.scale) control.set(Math.round(state.params[key] * control.scale));
  }
  $('#bw-toggle').checked = state.params.bw;
  document.querySelectorAll('#bw-filters .chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.mix === state.params.bwMix);
    chip.disabled = !state.params.bw;
  });
  document.querySelectorAll('#tone-swatches .swatch').forEach((swatch) => {
    const none = swatch.dataset.color === '';
    swatch.classList.toggle('active', none ? state.params.toneAmount === 0 : state.params.toneAmount > 0 && swatch.dataset.color === state.params.toneColor);
  });
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------
let drawQueued = false;
let settleTimer = 0;

function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

function draw() {
  if (!engine || !state.base) return;
  engine.render(
    state.params,
    { zoom: view.zoom, panX: view.panX, panY: view.panY, rotation: state.crop ? rad(state.crop.angle) : 0 },
    { split: state.compare && !state.crop ? state.splitX : -1, bypass: state.holdBefore },
  );
  layoutOverlays();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(onSettled, 160);
}

function onSettled() {
  if (!state.base || state.busy || !engine.isHealthy()) return;
  drawHistogram(analyse(engine.renderThumbnail(state.params, 256)).hist);
  const current = state.params;
  document.querySelectorAll('.preset').forEach((button) => {
    const preset = PRESETS.find((p) => p.id === button.dataset.preset);
    const target = { ...DEFAULTS, ...preset.params };
    button.classList.toggle('active', Object.keys(DEFAULTS).every((key) => target[key] === current[key]));
  });
}

function drawHistogram(hist) {
  const canvas = $('#histogram');
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (!hist) return;
  let peak = 1;
  for (const channel of [hist.r, hist.g, hist.b]) {
    const sorted = Array.from(channel.subarray(2, 254)).sort((a, b) => a - b);
    peak = Math.max(peak, sorted[Math.floor(sorted.length * 0.985)] * 1.25);
  }
  ctx.globalCompositeOperation = 'screen';
  const colors = { r: '#d9655a', g: '#74b86a', b: '#5d8fd6' };
  for (const key of ['r', 'g', 'b']) {
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let i = 0; i < 256; i++) {
      ctx.lineTo((i / 255) * width, height - Math.min(1, hist[key][i] / peak) * (height - 6));
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = colors[key];
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function stageDevice() {
  return { w: engine.canvas.width, h: engine.canvas.height };
}

function fitZoom() {
  const { w, h } = stageDevice();
  const margin = (state.crop ? 64 : 26) * dpr();
  const z = Math.min((w - 2 * margin) / state.base.width, (h - 2 * margin) / state.base.height);
  if (state.crop) return z;
  const longSide = Math.max(state.base.width, state.base.height);
  return Math.min(z, Math.max(1, Math.min(2.5, (700 * dpr()) / longSide)));
}

function fitView() {
  view.zoom = Math.max(fitZoom(), 0.01);
  view.panX = 0;
  view.panY = 0;
  view.fit = true;
  updateStatus();
  requestDraw();
}

function clampPan() {
  const { w, h } = stageDevice();
  const limitX = (state.base.width * view.zoom) / 2 + w / 2 - 80;
  const limitY = (state.base.height * view.zoom) / 2 + h / 2 - 80;
  view.panX = clamp(view.panX, -limitX, limitX);
  view.panY = clamp(view.panY, -limitY, limitY);
}

function zoomAt(factor, mx = 0, my = 0, absolute = null) {
  if (!state.base || state.crop) return;
  const fit = fitZoom();
  const next = clamp(absolute ?? view.zoom * factor, Math.min(fit, 0.05), 32);
  view.panX = mx - (mx - view.panX) * (next / view.zoom);
  view.panY = my - (my - view.panY) * (next / view.zoom);
  view.zoom = next;
  view.fit = false;
  clampPan();
  updateStatus();
  requestDraw();
}

function resizeStage() {
  if (!engine) return;
  const w = Math.max(1, Math.round(stage.clientWidth * dpr()));
  const h = Math.max(1, Math.round(stage.clientHeight * dpr()));
  if (engine.canvas.width !== w || engine.canvas.height !== h) {
    engine.canvas.width = w;
    engine.canvas.height = h;
  }
  if (!state.splitX || state.splitX > w) state.splitX = w / 2;
  if (!state.base) return;
  if (view.fit || state.crop) view.zoom = Math.max(fitZoom(), 0.01);
  draw();
}

function layoutOverlays() {
  const ratio = dpr();
  const handle = $('#compare-handle');
  handle.hidden = !(state.compare && !state.crop && state.base);
  if (!handle.hidden) handle.style.left = `${state.splitX / ratio}px`;
  $('#before-badge').hidden = !state.holdBefore;

  const layer = $('#crop-layer');
  layer.hidden = !state.crop;
  if (state.crop) {
    const { w, h } = stageDevice();
    const r = state.crop.rect;
    const box = $('#crop-box');
    box.style.left = `${(w / 2 + view.panX + (r.cx - r.w / 2) * view.zoom) / ratio}px`;
    box.style.top = `${(h / 2 + view.panY + (r.cy - r.h / 2) * view.zoom) / ratio}px`;
    box.style.width = `${(r.w * view.zoom) / ratio}px`;
    box.style.height = `${(r.h * view.zoom) / ratio}px`;
    $('#crop-size').textContent = `Nouveau cadre : ${formatSize(Math.round(r.w), Math.round(r.h))}`;
  }
}

function updateStatus() {
  if (!state.base) return;
  $('#status-file').textContent = state.file ? state.file.name : '';
  $('#status-size').textContent = `${formatSize(state.base.width, state.base.height)} · ${megapixels(state.base.width, state.base.height)} Mpx`;
  const percent = Math.round(view.zoom * 100);
  $('#status-zoom').textContent = `Zoom ${percent} %`;
  $('#btn-zoom-fit').textContent = view.fit ? 'Ajusté' : `${percent} %`;
}

// ---------------------------------------------------------------------------
// Image de travail et historique
// ---------------------------------------------------------------------------
function setBase(canvas) {
  const previous = state.base;
  state.base = canvas;
  engine.setImage(canvas);
  if (previous && !view.fit && previous.width !== canvas.width) {
    view.zoom *= previous.width / canvas.width;
  }
  if (view.fit || !previous) fitView();
  updateMagicPane();
  updateStatus();
  schedulePresetThumbnails();
  requestDraw();
}

function commit(label) {
  state.history.length = state.index + 1;
  state.history.push({ base: state.base, params: { ...state.params }, label });
  // Limite la mémoire : au plus 60 étapes et 5 images distinctes en pleine définition.
  const distinct = () => new Set(state.history.map((entry) => entry.base)).size;
  while (state.history.length > 60 || distinct() > 5) state.history.shift();
  state.index = state.history.length - 1;
  refreshHistoryUi();
}

function restore(index) {
  if (index < 0 || index >= state.history.length || state.busy) return;
  const entry = state.history[index];
  state.index = index;
  state.params = { ...entry.params };
  if (entry.base !== state.base) setBase(entry.base);
  if (state.crop) startCrop();
  syncControls();
  refreshHistoryUi();
  requestDraw();
}

function refreshHistoryUi() {
  $('#btn-undo').disabled = state.index <= 0;
  $('#btn-redo').disabled = state.index >= state.history.length - 1;
  api.setDirty(Boolean(state.base) && state.history[state.index] !== state.savedEntry);
}

function isDirty() {
  return Boolean(state.base) && state.history[state.index] !== state.savedEntry;
}

function applyParams(next, label) {
  state.params = { ...next };
  syncControls();
  requestDraw();
  commit(label);
}

// ---------------------------------------------------------------------------
// Ouverture
// ---------------------------------------------------------------------------
async function openBytes(bytes, name, filePath = null) {
  if (state.busy) return;
  if (isDirty() && !window.confirm('Ouvrir une autre photo ?\n\nLes retouches de la photo en cours ne sont pas enregistrées et seront perdues.')) return;
  busy.show('Ouverture de la photo…');
  await nextFrame();
  try {
    const { canvas, reduced } = await decodeImage(bytes, name);
    let dir = null;
    if (filePath) {
      const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
      dir = cut > 0 ? filePath.slice(0, cut) : null;
    }
    state.file = { name, path: filePath, dir };
    state.params = { ...DEFAULTS };
    state.history = [];
    state.index = -1;
    state.crop = null;
    app.classList.remove('cropping');
    state.compare = false;
    $('#btn-compare').classList.remove('active');
    state.base = null;
    view.fit = true;
    app.classList.remove('no-image');
    resizeStage();
    setBase(canvas);
    commit('Ouverture');
    state.savedEntry = state.history[0];
    refreshHistoryUi();
    syncControls();
    selectTab('reglages');
    document.title = `${name} — L'Atelier d'Olivier`;
    if (reduced) toast('Cette photo est immense : elle a été légèrement réduite pour rester fluide.');
  } catch (error) {
    console.error(error);
    toast(`Impossible d’ouvrir « ${name} ». Le fichier n’est peut-être pas une image.`, { error: true });
  } finally {
    busy.hide();
  }
}

async function openDialog() {
  if (state.busy) return;
  const file = await api.openDialog();
  if (file) await openBytes(file.data, file.name, file.path);
}

async function openFileObject(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await openBytes(bytes, file.name || 'photo', api.pathForFile(file));
}

// ---------------------------------------------------------------------------
// Filtres
// ---------------------------------------------------------------------------
let presetTimer = 0;
function schedulePresetThumbnails() {
  clearTimeout(presetTimer);
  presetTimer = setTimeout(() => {
    if (!state.base || state.busy || !engine.isHealthy()) return;
    document.querySelectorAll('.preset').forEach((button) => {
      const preset = PRESETS.find((p) => p.id === button.dataset.preset);
      const data = engine.renderThumbnail({ ...DEFAULTS, ...preset.params }, 260);
      const canvas = button.querySelector('canvas');
      canvas.width = data.width;
      canvas.height = data.height;
      canvas.getContext('2d').putImageData(data, 0, 0);
    });
  }, 220);
}

function buildPresets() {
  const grid = $('#preset-grid');
  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset' + (preset.signature ? ' signature' : '');
    button.dataset.preset = preset.id;
    button.innerHTML = '<canvas width="3" height="2"></canvas><span class="preset-name"></span>';
    button.querySelector('.preset-name').textContent = preset.name;
    button.addEventListener('click', () => applyParams({ ...DEFAULTS, ...preset.params }, `Filtre ${preset.name}`));
    grid.append(button);
  }
}

// ---------------------------------------------------------------------------
// Recadrage, redressement, rotations
// ---------------------------------------------------------------------------
const ASPECTS = [
  { id: 'libre', name: 'Libre', value: null },
  { id: 'original', name: 'Original', value: 'original' },
  { id: '1-1', name: 'Carré', value: 1 },
  { id: '4-3', name: '4:3', value: 4 / 3 },
  { id: '3-2', name: '3:2', value: 3 / 2 },
  { id: '16-9', name: '16:9', value: 16 / 9 },
  { id: 'a4', name: 'A4', value: Math.SQRT2 },
];

function largestRect(aspect, angle) {
  const c = Math.abs(Math.cos(rad(angle)));
  const s = Math.abs(Math.sin(rad(angle)));
  const w = Math.min(state.base.width / (c + s / aspect), state.base.height / (s + c / aspect));
  return { cx: 0, cy: 0, w, h: w / aspect };
}

function cropValid(rect, angle) {
  const c = Math.cos(rad(angle));
  const s = Math.sin(rad(angle));
  const halfW = state.base.width / 2 + 0.75;
  const halfH = state.base.height / 2 + 0.75;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = rect.cx + (sx * rect.w) / 2;
      const y = rect.cy + (sy * rect.h) / 2;
      if (Math.abs(c * x + s * y) > halfW || Math.abs(-s * x + c * y) > halfH) return false;
    }
  }
  return true;
}

function resolvedAspect() {
  const crop = state.crop;
  const def = ASPECTS.find((a) => a.id === crop.aspectId);
  if (!def || def.value === null) return null;
  let ratio = def.value === 'original' ? state.base.width / state.base.height : def.value;
  const portrait = def.value === 'original' ? false : crop.portrait;
  if (portrait && ratio > 1) ratio = 1 / ratio;
  return ratio;
}

function startCrop() {
  app.classList.add('cropping');
  state.compare = false;
  $('#btn-compare').classList.remove('active');
  state.crop = {
    angle: 0,
    aspectId: 'libre',
    portrait: state.base.height > state.base.width,
    rect: { cx: 0, cy: 0, w: state.base.width, h: state.base.height },
  };
  controls.angle.set(0);
  refreshAspectChips();
  view.panX = 0;
  view.panY = 0;
  view.zoom = Math.max(fitZoom(), 0.01);
  updateStatus();
  requestDraw();
}

function stopCrop() {
  app.classList.remove('cropping');
  if (!state.crop) return;
  state.crop = null;
  fitView();
}

function refreshAspectChips() {
  document.querySelectorAll('#aspect-chips .chip').forEach((chip) => {
    if (chip.dataset.aspect === 'swap') {
      const def = ASPECTS.find((a) => a.id === state.crop?.aspectId);
      chip.disabled = !state.crop || !def || typeof def.value !== 'number' || def.value === 1;
    } else {
      chip.classList.toggle('active', Boolean(state.crop) && chip.dataset.aspect === state.crop.aspectId);
    }
  });
}

function resetCropRect() {
  const crop = state.crop;
  const aspect = resolvedAspect() ?? crop.rect.w / crop.rect.h;
  crop.rect = largestRect(aspect, crop.angle);
  requestDraw();
}

function bakeCrop() {
  const crop = state.crop;
  if (!crop) return;
  const { rect, angle } = crop;
  const w = Math.max(1, Math.round(rect.w));
  const h = Math.max(1, Math.round(rect.h));
  const untouched = angle === 0 && w >= state.base.width && h >= state.base.height;
  if (!untouched) {
    const out = makeCanvas(w, h);
    const ctx = context(out);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(w / 2 - rect.cx, h / 2 - rect.cy);
    ctx.rotate(rad(angle));
    ctx.drawImage(state.base, -state.base.width / 2, -state.base.height / 2);
    app.classList.remove('cropping');
    state.crop = null;
    view.fit = true;
    setBase(out);
    commit('Recadrage');
  }
  selectTab('reglages');
}

function transformBase(kind) {
  if (!state.base || state.busy) return;
  const src = state.base;
  const quarter = kind === 'left' || kind === 'right';
  const out = makeCanvas(quarter ? src.height : src.width, quarter ? src.width : src.height);
  const ctx = context(out);
  ctx.translate(out.width / 2, out.height / 2);
  if (kind === 'left') ctx.rotate(-Math.PI / 2);
  if (kind === 'right') ctx.rotate(Math.PI / 2);
  if (kind === 'flip-h') ctx.scale(-1, 1);
  if (kind === 'flip-v') ctx.scale(1, -1);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  const wasCropping = Boolean(state.crop);
  state.crop = null;
  view.fit = true;
  setBase(out);
  commit({ left: 'Rotation à gauche', right: 'Rotation à droite', 'flip-h': 'Miroir', 'flip-v': 'Renversement' }[kind]);
  if (wasCropping) startCrop();
}

function setupCropInteractions() {
  const box = $('#crop-box');
  let drag = null;

  box.addEventListener('pointerdown', (event) => {
    if (!state.crop || event.button !== 0) return;
    event.preventDefault();
    box.setPointerCapture(event.pointerId);
    drag = {
      handle: event.target.dataset.handle || 'move',
      x: event.clientX,
      y: event.clientY,
      rect: { ...state.crop.rect },
    };
  });

  box.addEventListener('pointermove', (event) => {
    if (!drag || !state.crop) return;
    const scale = dpr() / view.zoom;
    const dx = (event.clientX - drag.x) * scale;
    const dy = (event.clientY - drag.y) * scale;
    const r0 = drag.rect;
    let left = r0.cx - r0.w / 2;
    let right = r0.cx + r0.w / 2;
    let top = r0.cy - r0.h / 2;
    let bottom = r0.cy + r0.h / 2;
    const handle = drag.handle;
    const minSize = Math.min(48, state.base.width / 4, state.base.height / 4);

    if (handle === 'move') {
      left += dx;
      right += dx;
      top += dy;
      bottom += dy;
    } else {
      if (handle.includes('w')) left = Math.min(left + dx, right - minSize);
      if (handle.includes('e')) right = Math.max(right + dx, left + minSize);
      if (handle.includes('n')) top = Math.min(top + dy, bottom - minSize);
      if (handle.includes('s')) bottom = Math.max(bottom + dy, top + minSize);
      const aspect = resolvedAspect();
      if (aspect) {
        let w = right - left;
        let h = bottom - top;
        if (handle === 'n' || handle === 's') {
          w = h * aspect;
          left = r0.cx - w / 2;
          right = r0.cx + w / 2;
        } else if (handle === 'e' || handle === 'w') {
          h = w / aspect;
          top = r0.cy - h / 2;
          bottom = r0.cy + h / 2;
        } else {
          if (w / h > aspect) w = h * aspect;
          else h = w / aspect;
          if (handle.includes('w')) left = right - w;
          else right = left + w;
          if (handle.includes('n')) top = bottom - h;
          else bottom = top + h;
        }
      }
    }

    const candidate = { cx: (left + right) / 2, cy: (top + bottom) / 2, w: right - left, h: bottom - top };
    const current = state.crop.rect;
    let next = candidate;
    if (!cropValid(candidate, state.crop.angle)) {
      // Recherche du plus grand déplacement qui reste dans la photo.
      let lo = 0;
      let hi = 1;
      const mix = (t) => ({
        cx: current.cx + (candidate.cx - current.cx) * t,
        cy: current.cy + (candidate.cy - current.cy) * t,
        w: current.w + (candidate.w - current.w) * t,
        h: current.h + (candidate.h - current.h) * t,
      });
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (cropValid(mix(mid), state.crop.angle)) lo = mid;
        else hi = mid;
      }
      next = mix(lo);
    }
    state.crop.rect = next;
    layoutOverlays();
  });

  const end = () => {
    drag = null;
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------------------
// Magie : amélioration automatique, définition, colorisation
// ---------------------------------------------------------------------------
function autoImprove() {
  if (!state.base || state.busy) return;
  const stats = engine.renderThumbnail(DEFAULTS, 320, { bypass: true });
  applyParams(autoEnhance(stats, state.params), 'Amélioration automatique');
  toast('Photo améliorée automatiquement. Affinez avec les curseurs si besoin.');
}

function updateMagicPane() {
  if (!state.base) return;
  const { width, height } = state.base;
  $('#size-info').textContent = `Taille actuelle : ${formatSize(width, height)} (${megapixels(width, height)} Mpx)`;
  for (const factor of [2, 4]) {
    const button = document.querySelector(`[data-upscale="${factor}"]`);
    const ok = ai.canUpscale(width, height, factor);
    button.disabled = !ok;
    $(`#up-${factor}`).textContent = ok ? `${formatSize(width * factor, height * factor)}` : 'photo déjà très grande';
  }
}

async function runUpscale(factor) {
  if (!state.base || state.busy) return;
  const mp = (state.base.width * state.base.height) / 1e6;
  if (mp > 3 && !window.confirm(`Cette photo est grande (${megapixels(state.base.width, state.base.height)} Mpx) : le calcul peut prendre plusieurs minutes.\n\nLancer quand même ?`)) return;
  const job = ai.upscale(state.base, factor, (value, message) => busy.update(value, message, { eta: true }));
  busy.show(factor === 1 ? 'Restauration des détails' : `Agrandissement ×${factor}`, { cancel: job.cancel });
  try {
    const out = await job.promise;
    busy.hide();
    setBase(out);
    commit(factor === 1 ? 'Restauration des détails' : `Agrandissement ×${factor}`);
    toast(factor === 1 ? 'Détails restaurés.' : `Photo agrandie : ${formatSize(out.width, out.height)}.`);
  } catch (error) {
    if (!error.cancelled) {
      console.error(error);
      toast('Le calcul n’a pas abouti. Essayez avec une photo plus petite.', { error: true });
    }
  } finally {
    busy.hide();
  }
}

async function runColorize() {
  if (!state.base || state.busy) return;
  const job = ai.colorize(state.base, (value, message) => busy.update(value, message));
  busy.show('Colorisation de la photo', { cancel: job.cancel });
  try {
    const out = await job.promise;
    busy.hide();
    setBase(out);
    state.params = { ...state.params, bw: false, toneAmount: 0, saturation: Math.max(0, state.params.saturation) };
    syncControls();
    commit('Colorisation');
    toast('Photo colorisée. Ajustez « Saturation » et « Température » à votre goût.');
  } catch (error) {
    if (!error.cancelled) {
      console.error(error);
      toast('La colorisation n’a pas abouti.', { error: true });
    }
  } finally {
    busy.hide();
  }
}

// ---------------------------------------------------------------------------
// Enregistrement
// ---------------------------------------------------------------------------
const exportOptions = { format: 'jpeg', quality: {}, size: 'original', width: 0, pdfLayout: 'a4' };
const SIZES = [
  { id: 'original', label: () => `Taille d’origine (${formatSize(state.base.width, state.base.height)})`, side: null },
  { id: 'grande', label: () => 'Grande — 3000 px', side: 3000 },
  { id: 'moyenne', label: () => 'Moyenne — 2000 px', side: 2000 },
  { id: 'petite', label: () => 'Petite, pour e-mail — 1280 px', side: 1280 },
  { id: 'perso', label: () => 'Personnalisée…', side: 'custom' },
];

function exportDimensions() {
  const { width, height } = state.base;
  const size = SIZES.find((s) => s.id === exportOptions.size) || SIZES[0];
  if (size.side === null) return { width, height };
  if (size.side === 'custom') {
    const w = clamp(Math.round(exportOptions.width) || width, 16, 16000);
    return { width: w, height: Math.max(1, Math.round((w * height) / width)) };
  }
  const scale = Math.min(1, size.side / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function refreshExportDialog() {
  const format = FORMATS.find((f) => f.id === exportOptions.format);
  document.querySelectorAll('.format').forEach((button) => button.classList.toggle('active', button.dataset.format === format.id));
  $('#quality-field').hidden = !format.quality;
  if (format.quality) controls.exportQuality.set(exportOptions.quality[format.id] ?? format.quality);
  $('#custom-size-field').hidden = exportOptions.size !== 'perso';
  $('#pdf-field').hidden = format.id !== 'pdf';
  const dims = exportDimensions();
  let summary = `Fichier ${format.label} de ${formatSize(dims.width, dims.height)}.`;
  if (format.id === 'gif') summary += ' Le GIF est limité à 256 couleurs : préférez JPEG ou PNG pour une photo.';
  if (format.id === 'tiff' || format.id === 'bmp') summary += ' Format non compressé : le fichier sera volumineux.';
  if (format.id === 'avif' && dims.width * dims.height > 8e6) summary += ' L’encodage AVIF d’une grande photo peut prendre une minute.';
  $('#export-summary').textContent = summary;
}

function openExportDialog() {
  if (!state.base || state.busy) return;
  if (state.crop) selectTab('reglages');
  const select = $('#export-size');
  select.innerHTML = '';
  for (const size of SIZES) {
    if (typeof size.side === 'number' && size.side >= Math.max(state.base.width, state.base.height)) continue;
    const option = document.createElement('option');
    option.value = size.id;
    option.textContent = size.label();
    select.append(option);
  }
  if (![...select.options].some((o) => o.value === exportOptions.size)) exportOptions.size = 'original';
  select.value = exportOptions.size;
  if (!exportOptions.width) exportOptions.width = state.base.width;
  $('#export-width').value = Math.min(exportOptions.width, 16000);
  $('#pdf-layout').value = exportOptions.pdfLayout;
  refreshExportDialog();
  $('#export-dialog').showModal();
}

/** Produit les octets du fichier final (développement pleine définition + encodage). */
async function produceFile(options, onProgress = () => {}) {
  const format = FORMATS.find((f) => f.id === options.format);
  let canvas = state.base;
  if (!isNeutral(state.params)) {
    const develop = () => engine.renderFull(state.params, (p) => onProgress(p * 0.7, 'Développement en pleine définition…'));
    try {
      canvas = await develop();
    } catch (error) {
      console.warn('Nouvel essai après une interruption graphique', error);
      await new Promise((resolve) => setTimeout(resolve, 400));
      engine.recover();
      canvas = await develop();
    }
  }
  const dims = options.dimensions || { width: canvas.width, height: canvas.height };
  if (dims.width !== canvas.width || dims.height !== canvas.height) {
    canvas = resizeCanvas(canvas, dims.width, dims.height);
  }
  onProgress(0.75, `Encodage ${format.label}…`);
  await nextFrame();
  return encodeImage(canvas, format.id, { quality: options.quality ?? format.quality, pdfLayout: options.pdfLayout });
}

async function saveWithDialog() {
  const format = FORMATS.find((f) => f.id === exportOptions.format);
  const stem = (state.file?.name || 'photo').replace(/\.[^.]+$/, '');
  const dir = state.file?.dir || (await api.defaultDir());
  const separator = dir.includes('\\') ? '\\' : '/';
  const filePath = await api.saveDialog({
    defaultPath: `${dir}${separator}${stem}-retouche.${format.ext}`,
    filters: [{ name: `Image ${format.label}`, extensions: [format.ext] }],
    extension: format.ext,
  });
  if (!filePath) return;
  busy.show('Enregistrement de la photo', { indeterminate: false });
  await nextFrame();
  try {
    const bytes = await produceFile(
      {
        format: format.id,
        quality: exportOptions.quality[format.id] ?? format.quality,
        pdfLayout: exportOptions.pdfLayout,
        dimensions: exportDimensions(),
      },
      (value, detail) => busy.update(value, detail),
    );
    busy.update(0.95, 'Écriture du fichier…');
    await api.writeFile(filePath, bytes);
    state.savedEntry = state.history[state.index];
    refreshHistoryUi();
    const name = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
    toast(`« ${name} » est enregistrée.`, { action: 'Afficher dans le dossier', onAction: () => api.showInFolder(filePath) });
  } catch (error) {
    console.error(error);
    toast(`L’enregistrement a échoué : ${error.message}`, { error: true });
  } finally {
    busy.hide();
  }
}

function buildExportDialog() {
  const grid = $('#format-grid');
  for (const format of FORMATS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'format';
    button.dataset.format = format.id;
    button.innerHTML = '<strong></strong><span></span>';
    button.querySelector('strong').textContent = format.label;
    button.querySelector('span').textContent = format.hint;
    button.addEventListener('click', () => {
      exportOptions.format = format.id;
      refreshExportDialog();
    });
    grid.append(button);
  }
  controls.exportQuality = createSlider($('#quality-slider'), {
    label: 'Qualité',
    min: 30,
    max: 100,
    value: 92,
    defaultValue: 92,
    suffix: ' %',
    onInput: (v) => {
      exportOptions.quality[exportOptions.format] = v;
    },
  });
  $('#export-size').addEventListener('change', (event) => {
    exportOptions.size = event.target.value;
    refreshExportDialog();
  });
  $('#export-width').addEventListener('input', (event) => {
    exportOptions.width = Number(event.target.value);
    refreshExportDialog();
  });
  $('#pdf-layout').addEventListener('change', (event) => {
    exportOptions.pdfLayout = event.target.value;
  });
  $('#export-dialog').addEventListener('close', () => {
    if ($('#export-dialog').returnValue === 'ok') saveWithDialog();
    $('#export-dialog').returnValue = '';
  });
}

// ---------------------------------------------------------------------------
// Construction de l'interface
// ---------------------------------------------------------------------------
function selectTab(tab) {
  if (state.tab === tab && (tab !== 'cadre' || state.crop)) return;
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  document.querySelectorAll('.pane').forEach((pane) => pane.classList.toggle('active', pane.id === `pane-${tab}`));
  if (!state.base) return;
  if (tab === 'cadre') startCrop();
  else stopCrop();
  requestDraw();
}

function buildPanel() {
  const groups = $('#slider-groups');
  for (const group of SLIDER_GROUPS) {
    const details = document.createElement('details');
    details.className = 'group';
    details.open = group.open;
    details.innerHTML = '<summary></summary><div class="group-body"></div>';
    details.querySelector('summary').textContent = group.title;
    const body = details.querySelector('.group-body');
    for (const slider of group.sliders) paramSlider(body, slider.key, slider.label, slider);
    groups.append(details);
  }

  // Noir et blanc
  $('#bw-toggle').addEventListener('change', (event) => {
    state.params.bw = event.target.checked;
    syncControls();
    requestDraw();
    commit('Noir et blanc');
  });
  for (const filter of BW_FILTERS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.mix = filter.id;
    chip.textContent = filter.name;
    if (filter.hint) chip.title = `Conseillé pour : ${filter.hint}`;
    chip.addEventListener('click', () => {
      state.params.bwMix = filter.id;
      syncControls();
      requestDraw();
      commit(filter.name);
    });
    $('#bw-filters').append(chip);
  }

  // Virage
  const swatches = $('#tone-swatches');
  for (const tone of [{ id: 'aucun', name: 'Aucun virage', color: '' }, ...TONES]) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch' + (tone.color ? '' : ' none');
    swatch.dataset.color = tone.color;
    swatch.title = tone.name;
    swatch.setAttribute('aria-label', tone.name);
    if (tone.color) swatch.style.setProperty('--swatch', tone.color);
    swatch.addEventListener('click', () => {
      if (tone.color) {
        state.params.toneColor = tone.color;
        if (state.params.toneAmount === 0) state.params.toneAmount = 0.6;
      } else {
        state.params.toneAmount = 0;
      }
      syncControls();
      requestDraw();
      commit(tone.name);
    });
    swatches.append(swatch);
  }
  paramSlider($('#tone-slider'), 'toneAmount', 'Intensité du virage', { min: 0 });

  // Colorisation créative
  const split = $('#split-sliders');
  paramSlider(split, 'splitShadowHue', 'Couleur des ombres', { min: 0, max: 360, scale: 1, track: 'spectrum', suffix: '°' });
  paramSlider(split, 'splitShadowAmount', 'Intensité dans les ombres', { min: 0 });
  paramSlider(split, 'splitHighHue', 'Couleur des hautes lumières', { min: 0, max: 360, scale: 1, track: 'spectrum', suffix: '°' });
  paramSlider(split, 'splitHighAmount', 'Intensité dans les hautes lumières', { min: 0 });

  // Recadrage
  const chips = $('#aspect-chips');
  for (const aspect of ASPECTS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.aspect = aspect.id;
    chip.textContent = aspect.name;
    chip.addEventListener('click', () => {
      if (!state.crop) return;
      state.crop.aspectId = aspect.id;
      refreshAspectChips();
      if (aspect.value !== null) resetCropRect();
    });
    chips.append(chip);
  }
  const swap = document.createElement('button');
  swap.type = 'button';
  swap.className = 'chip';
  swap.dataset.aspect = 'swap';
  swap.textContent = '⇄ Portrait / paysage';
  swap.addEventListener('click', () => {
    if (!state.crop) return;
    state.crop.portrait = !state.crop.portrait;
    resetCropRect();
  });
  chips.append(swap);

  controls.angle = createSlider($('#angle-slider'), {
    label: 'Redresser',
    min: -45,
    max: 45,
    suffix: '°',
    onInput: (v) => {
      if (!state.crop) return;
      state.crop.angle = v;
      resetCropRect();
    },
  });

  $('#btn-crop-apply').addEventListener('click', bakeCrop);
  $('#btn-crop-cancel').addEventListener('click', () => state.base && startCrop());
  $('#btn-rot-left').addEventListener('click', () => transformBase('left'));
  $('#btn-rot-right').addEventListener('click', () => transformBase('right'));
  $('#btn-flip-h').addEventListener('click', () => transformBase('flip-h'));
  $('#btn-flip-v').addEventListener('click', () => transformBase('flip-v'));

  // Magie
  $('#btn-auto').addEventListener('click', autoImprove);
  document.querySelectorAll('[data-upscale]').forEach((button) => {
    button.addEventListener('click', () => runUpscale(Number(button.dataset.upscale)));
  });
  $('#btn-colorize').addEventListener('click', runColorize);

  document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.tab)));
}

function setupStageInteractions() {
  let pan = null;
  viewHost.addEventListener('pointerdown', (event) => {
    if (!state.base || state.crop || event.button !== 0) return;
    viewHost.setPointerCapture(event.pointerId);
    pan = { x: event.clientX, y: event.clientY, panX: view.panX, panY: view.panY };
    viewHost.classList.add('panning');
  });
  viewHost.addEventListener('pointermove', (event) => {
    if (!pan) return;
    view.panX = pan.panX + (event.clientX - pan.x) * dpr();
    view.panY = pan.panY + (event.clientY - pan.y) * dpr();
    view.fit = false;
    clampPan();
    updateStatus();
    requestDraw();
  });
  const endPan = () => {
    pan = null;
    viewHost.classList.remove('panning');
  };
  viewHost.addEventListener('pointerup', endPan);
  viewHost.addEventListener('pointercancel', endPan);

  const pointerOffset = (event) => {
    const box = stage.getBoundingClientRect();
    return [(event.clientX - box.left - box.width / 2) * dpr(), (event.clientY - box.top - box.height / 2) * dpr()];
  };
  stage.addEventListener(
    'wheel',
    (event) => {
      if (!state.base) return;
      event.preventDefault();
      const [mx, my] = pointerOffset(event);
      zoomAt(Math.exp(-event.deltaY * 0.0016), mx, my);
    },
    { passive: false },
  );
  viewHost.addEventListener('dblclick', (event) => {
    if (!state.base || state.crop) return;
    if (view.fit) {
      const [mx, my] = pointerOffset(event);
      zoomAt(1, mx, my, 1);
    } else {
      fitView();
    }
  });

  // Séparateur avant / après
  const handle = $('#compare-handle');
  let sliding = false;
  handle.addEventListener('pointerdown', (event) => {
    handle.setPointerCapture(event.pointerId);
    sliding = true;
  });
  handle.addEventListener('pointermove', (event) => {
    if (!sliding) return;
    const box = stage.getBoundingClientRect();
    state.splitX = clamp((event.clientX - box.left) * dpr(), 20, engine.canvas.width - 20);
    requestDraw();
  });
  handle.addEventListener('pointerup', () => (sliding = false));
  handle.addEventListener('pointercancel', () => (sliding = false));

  // Glisser-déposer
  let dragDepth = 0;
  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    stage.classList.add('dragging');
    $('#drop-hint').hidden = !state.base;
  });
  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      stage.classList.remove('dragging');
      $('#drop-hint').hidden = true;
    }
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    stage.classList.remove('dragging');
    $('#drop-hint').hidden = true;
    const file = event.dataTransfer?.files?.[0];
    if (file) openFileObject(file);
  });
  window.addEventListener('paste', (event) => {
    const item = Array.from(event.clipboardData?.items || []).find((entry) => entry.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (file) openFileObject(new File([file], 'photo-collee.png', { type: file.type }));
  });

  new ResizeObserver(resizeStage).observe(stage);
  window.matchMedia('(resolution: 1dppx)').addEventListener('change', resizeStage);
}

function setBefore(on) {
  if (!state.base || state.crop || state.holdBefore === on) return;
  state.holdBefore = on;
  $('#btn-before').classList.toggle('active', on);
  requestDraw();
}

function setupToolbar() {
  $('#btn-open').addEventListener('click', openDialog);
  $('#btn-welcome-open').addEventListener('click', openDialog);
  $('#btn-save').addEventListener('click', openExportDialog);
  $('#btn-undo').addEventListener('click', () => restore(state.index - 1));
  $('#btn-redo').addEventListener('click', () => restore(state.index + 1));
  $('#btn-reset').addEventListener('click', () => {
    if (!state.base || isNeutral(state.params)) return;
    applyParams({ ...DEFAULTS }, 'Réinitialisation');
  });
  $('#btn-zoom-in').addEventListener('click', () => zoomAt(1.3));
  $('#btn-zoom-out').addEventListener('click', () => zoomAt(1 / 1.3));
  $('#btn-zoom-fit').addEventListener('click', () => state.base && !state.crop && fitView());
  $('#btn-compare').addEventListener('click', () => {
    if (!state.base || state.crop) return;
    state.compare = !state.compare;
    $('#btn-compare').classList.toggle('active', state.compare);
    requestDraw();
  });
  const before = $('#btn-before');
  before.addEventListener('pointerdown', () => setBefore(true));
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) before.addEventListener(type, () => setBefore(false));

  $('#brand').addEventListener('click', () => $('#about-dialog').showModal());

  window.addEventListener('keydown', (event) => {
    if (document.querySelector('dialog[open]')) return;
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName) && event.target.type !== 'range' && event.target.type !== 'checkbox';
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (ctrl && key === 'o') {
      event.preventDefault();
      openDialog();
    } else if (ctrl && key === 's') {
      event.preventDefault();
      openExportDialog();
    } else if (ctrl && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      restore(state.index - 1);
    } else if (ctrl && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault();
      restore(state.index + 1);
    } else if (typing) {
      return;
    } else if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat) setBefore(true);
    } else if (key === '+' || key === '=') {
      zoomAt(1.3);
    } else if (key === '-') {
      zoomAt(1 / 1.3);
    } else if (key === '0') {
      if (state.base && !state.crop) fitView();
    } else if (key === '1') {
      zoomAt(1, 0, 0, 1);
    } else if (key === 'escape' && state.crop) {
      selectTab('reglages');
    } else if (key === 'enter' && state.crop) {
      bakeCrop();
    }
  });
  window.addEventListener('keyup', (event) => {
    if (event.code === 'Space') setBefore(false);
  });
  window.addEventListener('blur', () => setBefore(false));
}

async function start() {
  const hour = new Date().getHours();
  const greeting = hour < 5 || hour >= 18 ? 'Bonsoir' : hour >= 12 ? 'Bon après-midi' : 'Bonjour';
  $('#welcome-kicker').textContent = `${greeting} Olivier,`;

  buildPanel();
  buildPresets();
  buildExportDialog();
  setupToolbar();
  setupStageInteractions();
  setupCropInteractions();
  refreshHistoryUi();

  try {
    engine = new Engine(viewHost);
    engine.onContextRestored = () => {
      schedulePresetThumbnails();
      requestDraw();
    };
    resizeStage();
  } catch (error) {
    console.error(error);
    $('.welcome-lead').textContent = 'Cet ordinateur ne permet pas l’affichage accéléré (WebGL 2) nécessaire à l’atelier. Mettez à jour le pilote de la carte graphique puis relancez.';
    $('#btn-welcome-open').disabled = true;
    return;
  }

  const info = await api.info();
  $('#about-version').textContent = `Version ${info.version}`;
  api.onOpenPath(async (filePath) => {
    const file = await api.readFile(filePath);
    if (file) openBytes(file.data, file.name, file.path);
  });
  if (info.initialFile) {
    const file = await api.readFile(info.initialFile);
    if (file) await openBytes(file.data, file.name, file.path);
  }
}

// Accès pour les tests automatisés.
window.__atelier = { state, view, openBytes, produceFile, selectTab, runUpscale, runColorize, autoImprove, bakeCrop, transformBase, applyParams, DEFAULTS, PRESETS };

start();
