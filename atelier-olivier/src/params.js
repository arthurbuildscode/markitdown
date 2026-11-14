// Réglages, filtres prêts à l'emploi et amélioration automatique.

export const DEFAULTS = Object.freeze({
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  hue: 0,
  sharpen: 0,
  clarity: 0,
  denoise: 0,
  bw: false,
  bwMix: 'neutre',
  toneColor: '#a67c52',
  toneAmount: 0,
  splitShadowHue: 215,
  splitShadowAmount: 0,
  splitHighHue: 42,
  splitHighAmount: 0,
  vignette: 0,
  grain: 0,
  fade: 0,
});

export function isNeutral(params) {
  return Object.keys(DEFAULTS).every((key) => {
    if (key === 'bwMix') return !params.bw || params.bwMix === DEFAULTS.bwMix;
    if (key === 'toneColor') return params.toneAmount === 0 || params.toneColor === DEFAULTS.toneColor;
    if (key === 'splitShadowHue') return params.splitShadowAmount === 0 || params.splitShadowHue === DEFAULTS.splitShadowHue;
    if (key === 'splitHighHue') return params.splitHighAmount === 0 || params.splitHighHue === DEFAULTS.splitHighHue;
    return params[key] === DEFAULTS[key];
  });
}

// Groupes de curseurs du panneau « Réglages ». min/max en unités affichées (÷100 en interne).
export const SLIDER_GROUPS = [
  {
    id: 'lumiere',
    title: 'Lumière',
    open: true,
    sliders: [
      { key: 'exposure', label: 'Exposition' },
      { key: 'brightness', label: 'Luminosité' },
      { key: 'contrast', label: 'Contraste' },
      { key: 'highlights', label: 'Hautes lumières' },
      { key: 'shadows', label: 'Ombres' },
      { key: 'whites', label: 'Blancs' },
      { key: 'blacks', label: 'Noirs' },
    ],
  },
  {
    id: 'couleur',
    title: 'Couleur',
    open: true,
    sliders: [
      { key: 'temperature', label: 'Température', track: 'temperature' },
      { key: 'tint', label: 'Teinte', track: 'tint' },
      { key: 'vibrance', label: 'Vibrance' },
      { key: 'saturation', label: 'Saturation' },
      { key: 'hue', label: 'Nuance', track: 'hue' },
    ],
  },
  {
    id: 'details',
    title: 'Netteté et détails',
    open: true,
    sliders: [
      { key: 'sharpen', label: 'Netteté' },
      { key: 'clarity', label: 'Clarté' },
      { key: 'denoise', label: 'Réduction du bruit', min: 0 },
    ],
  },
  {
    id: 'effets',
    title: 'Effets',
    open: false,
    sliders: [
      { key: 'vignette', label: 'Vignettage' },
      { key: 'grain', label: 'Grain argentique', min: 0 },
      { key: 'fade', label: 'Fondu', min: 0 },
    ],
  },
];

export const TONES = [
  { id: 'sepia', name: 'Sépia', color: '#a67c52' },
  { id: 'olive', name: 'Olive', color: '#8b8f4b' },
  { id: 'or', name: 'Or', color: '#c49a3c' },
  { id: 'selenium', name: 'Sélénium', color: '#7d6f86' },
  { id: 'cyanotype', name: 'Cyanotype', color: '#3f6f9f' },
  { id: 'cuivre', name: 'Cuivre', color: '#b8693f' },
];

export const BW_FILTERS = [
  { id: 'neutre', name: 'Neutre' },
  { id: 'rouge', name: 'Filtre rouge', hint: 'ciels dramatiques' },
  { id: 'jaune', name: 'Filtre jaune', hint: 'paysages' },
  { id: 'vert', name: 'Filtre vert', hint: 'portraits, feuillages' },
  { id: 'bleu', name: 'Filtre bleu', hint: 'ambiance ancienne' },
];

export const PRESETS = [
  { id: 'original', name: 'Original', params: {} },
  { id: 'eclat', name: 'Éclat', params: { contrast: 0.16, vibrance: 0.3, clarity: 0.2, sharpen: 0.25, shadows: 0.1 } },
  {
    id: 'huile-olive',
    name: 'Huile d’olive',
    signature: true,
    params: {
      temperature: 0.14, tint: -0.1, contrast: 0.12, fade: 0.16, vibrance: 0.05, vignette: 0.22,
      splitShadowHue: 78, splitShadowAmount: 0.4, splitHighHue: 48, splitHighAmount: 0.3,
    },
  },
  {
    id: 'portrait',
    name: 'Portrait',
    params: { exposure: 0.04, contrast: 0.08, highlights: -0.2, shadows: 0.2, vibrance: 0.12, clarity: -0.12, temperature: 0.06, vignette: 0.15, sharpen: 0.15 },
  },
  {
    id: 'paysage',
    name: 'Paysage',
    params: { contrast: 0.18, highlights: -0.3, shadows: 0.25, vibrance: 0.4, clarity: 0.35, sharpen: 0.3, saturation: 0.05 },
  },
  {
    id: 'provence',
    name: 'Provence',
    params: { temperature: 0.2, exposure: 0.06, vibrance: 0.25, highlights: -0.15, shadows: 0.15, splitHighHue: 40, splitHighAmount: 0.2 },
  },
  {
    id: 'matin',
    name: 'Matin frais',
    params: { temperature: -0.18, contrast: 0.1, vibrance: 0.12, splitShadowHue: 215, splitShadowAmount: 0.25 },
  },
  {
    id: 'cinema',
    name: 'Cinéma',
    params: {
      contrast: 0.2, saturation: -0.1, vignette: 0.25, fade: 0.08,
      splitShadowHue: 190, splitShadowAmount: 0.35, splitHighHue: 35, splitHighAmount: 0.3,
    },
  },
  {
    id: 'vintage',
    name: 'Vintage',
    params: {
      fade: 0.35, contrast: -0.05, saturation: -0.2, temperature: 0.12, grain: 0.3, vignette: 0.3,
      splitShadowHue: 200, splitShadowAmount: 0.15, splitHighHue: 45, splitHighAmount: 0.25,
    },
  },
  { id: 'nb', name: 'Noir et blanc', params: { bw: true, contrast: 0.12 } },
  { id: 'nb-intense', name: 'N&B intense', params: { bw: true, bwMix: 'rouge', contrast: 0.38, clarity: 0.3, blacks: -0.2, grain: 0.15 } },
  { id: 'sepia', name: 'Sépia', params: { bw: true, toneColor: '#a67c52', toneAmount: 0.6, contrast: 0.08, fade: 0.1, vignette: 0.2 } },
  { id: 'cyanotype', name: 'Cyanotype', params: { bw: true, toneColor: '#3f6f9f', toneAmount: 0.7, contrast: 0.15 } },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round2 = (value) => Math.round(value * 100) / 100;

/** Statistiques d'une miniature (ImageData) : histogrammes et moyennes. */
export function analyse(imageData) {
  const { data } = imageData;
  const hist = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) };
  let count = 0;
  let sumSat = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    hist.r[r]++;
    hist.g[g]++;
    hist.b[b]++;
    hist.l[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
    sumSat += Math.max(r, g, b) - Math.min(r, g, b);
    sumR += r;
    sumG += g;
    sumB += b;
    count++;
  }
  const percentile = (fraction) => {
    const target = count * fraction;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist.l[i];
      if (acc >= target) return i / 255;
    }
    return 1;
  };
  const n = Math.max(count, 1);
  return { hist, count, percentile, meanSat: sumSat / n / 255, mean: [sumR / n / 255, sumG / n / 255, sumB / n / 255] };
}

/** Propose des réglages équilibrés à partir de l'image d'origine. */
export function autoEnhance(imageData, current) {
  const stats = analyse(imageData);
  const low = stats.percentile(0.005);
  const high = stats.percentile(0.995);
  const p10 = stats.percentile(0.1);
  const p90 = stats.percentile(0.9);
  const median = stats.percentile(0.5);
  const isGray = stats.meanSat < 0.03;

  const blacks = -clamp((low - 0.012) / 0.12, 0, 0.85);
  const whites = clamp((1 - high - 0.012) / 0.25, 0, 0.85);
  const bp = -blacks * 0.12;
  const wp = 1 - whites * 0.25;
  const stretched = clamp((median - bp) / (wp - bp), 0.02, 0.98);
  const gamma = Math.log(0.46) / Math.log(stretched);
  const brightness = clamp((-Math.log(gamma) / 0.6) * 0.55, -0.3, 0.35);

  let temperature = 0;
  if (!isGray) {
    const [r, , b] = stats.mean;
    temperature = clamp(((b - r) / Math.max(r + b, 1e-3)) * 0.6, -0.1, 0.1);
  }

  return {
    ...current,
    exposure: 0,
    brightness: round2(brightness),
    contrast: 0.08,
    highlights: p90 > 0.88 ? -0.2 : -0.05,
    shadows: p10 < 0.12 ? 0.25 : 0.08,
    whites: round2(whites),
    blacks: round2(blacks),
    temperature: round2(temperature),
    tint: 0,
    vibrance: isGray ? 0 : stats.meanSat < 0.25 ? 0.28 : 0.12,
    clarity: 0.14,
    sharpen: 0.3,
  };
}
