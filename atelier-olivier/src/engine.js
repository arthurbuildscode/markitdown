// Moteur de rendu WebGL2 : applique tous les réglages en temps réel sur la carte graphique,
// puis exporte en pleine définition par tuiles (aucune limite pratique de taille d'image).

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const DEVELOP = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uSrc;
uniform sampler2D uLow;
uniform vec2 uImgSize;
uniform vec4 uSrcRect;
uniform mat3 uFragToImg;
uniform float uFootprint;
uniform float uSigma;
uniform int uMode;        // 0 = affichage, 1 = export (alpha droit)
uniform float uSplit;     // position du séparateur avant/après (px écran), -1 = aucun
uniform int uBypass;      // 1 = image d'origine, sans réglages

uniform vec3 uGain;
uniform float uShoulder;
uniform float uGamma;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uSaturation;
uniform float uVibrance;
uniform mat3 uHueMat;
uniform float uSharpen;
uniform float uClarity;
uniform float uDenoise;
uniform float uBW;
uniform vec3 uBWMix;
uniform vec3 uToneColor;
uniform float uToneAmount;
uniform vec3 uSplitShadow;
uniform vec3 uSplitHigh;
uniform float uFade;
uniform float uVignette;
uniform float uGrain;
uniform float uGrainSize;

out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float luma(vec3 c) { return dot(c, LUMA); }

vec4 sampleSrc(vec2 p) {
  return texture(uSrc, (p - uSrcRect.xy) / uSrcRect.zw);
}

float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(p)) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n) * (1.0 / 4294967295.0);
}

// Exposition + balance des blancs (en lumière linéaire) puis luminosité (gamma).
vec3 expose(vec3 c) {
  vec3 lin = pow(max(c, 0.0), vec3(2.2)) * uGain;
  c = pow(lin, vec3(1.0 / 2.2));
  if (uShoulder > 0.0) {
    const float t = 0.8;
    vec3 soft = t + (1.0 - t) * tanh(max(c - t, 0.0) / (1.0 - t));
    c = mix(min(c, 1.0), mix(c, soft, step(t, c)), uShoulder);
  }
  return pow(clamp(c, 0.0, 1.0), vec3(uGamma));
}

vec3 develop(vec2 p, vec3 src) {
  vec3 c = src;

  // Netteté et réduction du bruit (noyau 5 x 5, filtre bilatéral + masque flou).
  if (uSharpen != 0.0 || uDenoise > 0.0) {
    float rangeSigma = 0.02 + 0.14 * uDenoise;
    float rangeK = 1.0 / (2.0 * rangeSigma * rangeSigma);
    vec3 blur = vec3(0.0);
    vec3 bil = vec3(0.0);
    float wsum = 0.0;
    float bsum = 0.0;
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        vec2 o = vec2(float(i), float(j));
        vec3 t = sampleSrc(p + o * uSigma).rgb;
        float g = exp(-dot(o, o) * 0.5);
        vec3 d = t - src;
        float r = exp(-dot(d, d) * rangeK);
        blur += t * g;
        wsum += g;
        bil += t * g * r;
        bsum += g * r;
      }
    }
    blur /= wsum;
    bil /= bsum;
    c = mix(src, bil, clamp(uDenoise * 1.6, 0.0, 1.0));
    if (uSharpen > 0.0) {
      float detail = clamp(luma(c - blur), -0.2, 0.2);
      c += detail * uSharpen * 2.2;
    } else if (uSharpen < 0.0) {
      c = mix(c, blur, -uSharpen);
    }
  }

  vec3 low = texture(uLow, p / uImgSize).rgb;

  // Clarté : contraste local sur les tons moyens.
  if (uClarity != 0.0) {
    float l0 = luma(c);
    float mid = sqrt(max(1.0 - abs(2.0 * l0 - 1.0), 0.0));
    c += uClarity * 0.9 * (l0 - luma(low)) * mid;
  }

  c = expose(c);

  // Hautes lumières et ombres, guidées par la luminosité locale.
  if (uShadows != 0.0 || uHighlights != 0.0) {
    float lm = luma(expose(low));
    float l = clamp(luma(c), 0.0, 1.0);
    float shadowMask = 1.0 - smoothstep(0.0, 0.55, lm);
    float highMask = smoothstep(0.45, 1.0, lm);
    float l2 = pow(l, exp(-uShadows * shadowMask * 0.9));
    l2 = 1.0 - pow(1.0 - l2, exp(uHighlights * highMask * 0.9));
    c *= l2 / max(l, 1e-4);
  }

  // Blancs et noirs (niveaux).
  if (uWhites != 0.0 || uBlacks != 0.0) {
    float bp = -uBlacks * 0.12;
    float wp = 1.0 - uWhites * 0.25;
    c = (c - bp) / (wp - bp);
  }

  // Contraste : courbe en S autour du gris moyen.
  if (uContrast != 0.0) {
    float g = exp(uContrast * 0.9);
    vec3 x = clamp(c, 0.0, 1.0);
    vec3 lo = 0.5 * pow(2.0 * x, vec3(g));
    vec3 hi = 1.0 - 0.5 * pow(2.0 * (1.0 - x), vec3(g));
    c = mix(lo, hi, step(0.5, x));
  }

  // Vibrance et saturation.
  if (uSaturation != 0.0 || uVibrance != 0.0) {
    float l = luma(c);
    float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    float factor = (1.0 + uSaturation) * (1.0 + uVibrance * (1.0 - smoothstep(0.0, 0.7, sat)));
    c = mix(vec3(l), c, factor);
  }

  c = uHueMat * c;

  // Noir et blanc avec mélangeur de couches.
  if (uBW > 0.0) {
    c = mix(c, vec3(dot(c, uBWMix)), uBW);
  }

  // Virage (sépia, cyanotype, olive...).
  if (uToneAmount > 0.0) {
    float l = clamp(luma(c), 0.0, 1.0);
    vec3 duo = l < 0.5 ? uToneColor * (2.0 * l) : mix(uToneColor, vec3(1.0), 2.0 * l - 1.0);
    c = mix(c, duo, uToneAmount);
  }

  // Colorisation créative : teinte des ombres et des hautes lumières.
  {
    float l = clamp(luma(c), 0.0, 1.0);
    c += uSplitShadow * (1.0 - l) * (1.0 - l) + uSplitHigh * l * l;
  }

  if (uFade > 0.0) {
    c = mix(c, c * 0.8 + 0.11, uFade);
  }

  if (uVignette != 0.0) {
    vec2 q = p / uImgSize - 0.5;
    float v = smoothstep(0.3, 1.05, length(q) * 1.4142);
    if (uVignette > 0.0) c *= 1.0 - uVignette * v * 0.85;
    else c += -uVignette * v * 0.6 * (1.0 - c);
  }

  if (uGrain > 0.0) {
    vec2 gp = floor(p / uGrainSize);
    float n = hash(gp) + hash(gp + 71.0) - 1.0;
    float l = clamp(luma(c), 0.0, 1.0);
    c += n * uGrain * 0.14 * min(1.0, uGrainSize / uFootprint) * (1.0 - 0.5 * abs(2.0 * l - 1.0));
  }

  return clamp(c, 0.0, 1.0);
}

void main() {
  vec2 p = (uFragToImg * vec3(gl_FragCoord.xy, 1.0)).xy;
  vec4 src = sampleSrc(p);
  bool original = uBypass == 1 || (uSplit >= 0.0 && gl_FragCoord.x < uSplit);
  vec3 c = original ? src.rgb : develop(p, src.rgb);

  if (uMode == 1) {
    outColor = vec4(c, src.a);
    return;
  }

  vec2 edge = min(p, uImgSize - p);
  float coverage = clamp(min(edge.x, edge.y) / uFootprint + 0.5, 0.0, 1.0);
  vec2 cell = floor(gl_FragCoord.xy / 12.0);
  vec3 checker = mix(vec3(0.24), vec3(0.3), mod(cell.x + cell.y, 2.0));
  c = mix(checker, c, src.a);
  if (uSplit >= 0.0 && abs(gl_FragCoord.x - uSplit) < 1.0) c = vec3(0.96, 0.95, 0.86);
  outColor = vec4(c * coverage, coverage);
}`;

const BLUR = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform float uSigmaPx;
out vec4 outColor;
void main() {
  vec2 size = vec2(textureSize(uTex, 0));
  vec2 uv = gl_FragCoord.xy / size;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -24; i <= 24; i++) {
    float x = float(i);
    float w = exp(-x * x / (2.0 * uSigmaPx * uSigmaPx));
    sum += texture(uTex, uv + uDir * x / size) * w;
    wsum += w;
  }
  outColor = sum / wsum;
}`;

const LOW_SIZE = 256;
const TILE = 2048;
const TILE_PAD = 16;

export const BW_MIXES = {
  neutre: [0.2126, 0.7152, 0.0722],
  rouge: [0.72, 0.24, 0.04],
  jaune: [0.5, 0.42, 0.08],
  vert: [0.18, 0.74, 0.08],
  bleu: [0.1, 0.25, 0.65],
};

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function hueToRgb(hue) {
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const table = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]];
  return table[Math.floor(h) % 6];
}

const lumaOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function chroma(hue, amount) {
  const rgb = hueToRgb(hue);
  const l = lumaOf(rgb);
  return rgb.map((v) => (v - l) * amount * 0.4);
}

function hueMatrix(hue) {
  const a = hue * Math.PI; // -1..1 -> -180°..180°
  const c = Math.cos(a);
  const s = Math.sin(a);
  const [lr, lg, lb] = [0.2126, 0.7152, 0.0722];
  // Rotation autour de l'axe des gris, en préservant la luminance.
  return [
    lr + c * (1 - lr) + s * -lr, lr + c * -lr + s * 0.143, lr + c * -lr + s * -(1 - lr),
    lg + c * -lg + s * -lg, lg + c * (1 - lg) + s * 0.14, lg + c * -lg + s * lg,
    lb + c * -lb + s * (1 - lb), lb + c * -lb + s * -0.283, lb + c * (1 - lb) + s * lb,
  ];
}

export class Engine {
  /** host : élément qui accueille le canvas d'affichage (créé et, si besoin, recréé ici). */
  constructor(host) {
    this.host = host;
    this.image = null;
    this.canvas = null;
    this.onContextRestored = null;
    this.createCanvas();
    this.init();
  }

  createCanvas() {
    const previous = this.canvas;
    const canvas = document.createElement('canvas');
    if (previous) {
      canvas.width = previous.width;
      canvas.height = previous.height;
      previous.remove();
    }
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      if (canvas !== this.canvas) return;
      this.ready = false;
      // Si le navigateur ne rétablit pas le contexte de lui-même, on repart d'un canvas neuf.
      clearTimeout(this.recoverTimer);
      this.recoverTimer = setTimeout(() => this.recover(), 1500);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      if (canvas === this.canvas) this.reinitialise();
    });
    this.host.append(canvas);
    this.canvas = canvas;
  }

  reinitialise() {
    clearTimeout(this.recoverTimer);
    try {
      this.init();
      if (this.image) this.setImage(this.image);
    } catch (error) {
      console.warn('Réinitialisation graphique impossible', error);
      this.ready = false;
      return false;
    }
    if (this.onContextRestored) this.onContextRestored();
    return true;
  }

  isHealthy() {
    return Boolean(this.ready && this.gl && !this.gl.isContextLost());
  }

  /** Recrée le canvas et le contexte graphique après une perte (pilote, veille, bureau à distance...). */
  recover() {
    if (this.isHealthy()) return true;
    this.createCanvas();
    return this.reinitialise();
  }

  ensureReady() {
    if (!this.isHealthy() && !this.recover()) throw new Error('Affichage graphique indisponible');
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 indisponible');
    this.gl = gl;
    this.maxTexture = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 16384);
    this.develop = this.program(DEVELOP);
    this.blur = this.program(BLUR);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.srcTex = null;
    this.lowTex = null;
    this.fbo = gl.createFramebuffer();
    this.targets = new Map();
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    this.ready = true;
  }

  program(fragmentSource) {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error('Shader : ' + gl.getShaderInfoLog(shader));
      }
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.bindAttribLocation(program, 0, 'aPos');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Programme : ' + gl.getProgramInfoLog(program));
    }
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
    return { program, uniforms };
  }

  texture(source, { mipmaps = false, width, height } = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (source === null || ArrayBuffer.isView(source)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mipmaps) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    return tex;
  }

  // Cible de rendu hors écran, réutilisée d'un appel à l'autre.
  target(name, width, height) {
    const gl = this.gl;
    let target = this.targets.get(name);
    if (!target || target.width !== width || target.height !== height) {
      if (target) gl.deleteTexture(target.tex);
      target = { tex: this.texture(null, { width, height }), width, height };
      this.targets.set(name, target);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
    gl.viewport(0, 0, width, height);
    return target;
  }

  /** Définit l'image de travail (un canvas 2D en pleine définition). */
  setImage(image) {
    const gl = this.gl;
    this.image = image;
    this.width = image.width;
    this.height = image.height;
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    if (this.lowTex) gl.deleteTexture(this.lowTex);

    let source = image;
    const longSide = Math.max(image.width, image.height);
    if (longSide > this.maxTexture) {
      const scale = this.maxTexture / longSide;
      source = document.createElement('canvas');
      source.width = Math.max(1, Math.floor(image.width * scale));
      source.height = Math.max(1, Math.floor(image.height * scale));
      const ctx = source.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, source.width, source.height);
    }
    this.srcTex = this.texture(source, { mipmaps: true });

    // Version très floue de l'image entière : sert à la clarté et aux ombres / hautes lumières.
    const lowScale = LOW_SIZE / longSide;
    const lw = Math.max(2, Math.round(image.width * lowScale));
    const lh = Math.max(2, Math.round(image.height * lowScale));
    const small = document.createElement('canvas');
    small.width = lw;
    small.height = lh;
    const sctx = small.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(source, 0, 0, lw, lh);
    const smallTex = this.texture(small);
    const sigma = LOW_SIZE * 0.03;
    gl.useProgram(this.blur.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.blur.uniforms.uTex, 0);
    gl.uniform1f(this.blur.uniforms.uSigmaPx, sigma);
    this.target('blurA', lw, lh);
    gl.bindTexture(gl.TEXTURE_2D, smallTex);
    gl.uniform2f(this.blur.uniforms.uDir, 1, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const passA = this.targets.get('blurA');
    this.lowTex = this.texture(null, { width: lw, height: lh });
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.lowTex, 0);
    gl.viewport(0, 0, lw, lh);
    gl.bindTexture(gl.TEXTURE_2D, passA.tex);
    gl.uniform2f(this.blur.uniforms.uDir, 0, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.deleteTexture(smallTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  setUniforms(params, { matrix, footprint, mode, split = -1, bypass = false, srcRect }) {
    const gl = this.gl;
    const u = this.develop.uniforms;
    gl.useProgram(this.develop.program);
    gl.bindVertexArray(this.vao);
    gl.uniform1i(u.uSrc, 0);
    gl.uniform1i(u.uLow, 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lowTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(u.uImgSize, this.width, this.height);
    gl.uniform4f(u.uSrcRect, ...(srcRect || [0, 0, this.width, this.height]));
    gl.uniformMatrix3fv(u.uFragToImg, false, matrix);
    gl.uniform1f(u.uFootprint, footprint);
    const longSide = Math.max(this.width, this.height);
    gl.uniform1f(u.uSigma, Math.min(2.5, Math.max(0.75, longSide / 2800)));
    gl.uniform1i(u.uMode, mode);
    gl.uniform1f(u.uSplit, split);
    gl.uniform1i(u.uBypass, bypass ? 1 : 0);

    const p = params;
    const wb = [1 + 0.28 * p.temperature + 0.07 * p.tint, 1 - 0.2 * p.tint, 1 - 0.28 * p.temperature + 0.07 * p.tint];
    const norm = lumaOf(wb);
    const exposureGain = 2 ** (p.exposure * 2);
    const gain = wb.map((v) => (v / norm) * exposureGain);
    gl.uniform3f(u.uGain, ...gain);
    const peak = Math.max(...gain) ** (1 / 2.2);
    gl.uniform1f(u.uShoulder, Math.min(1, Math.max(0, (peak - 1) * 3)));
    gl.uniform1f(u.uGamma, Math.exp(-p.brightness * 0.6));
    gl.uniform1f(u.uContrast, p.contrast);
    gl.uniform1f(u.uHighlights, p.highlights);
    gl.uniform1f(u.uShadows, p.shadows);
    gl.uniform1f(u.uWhites, p.whites);
    gl.uniform1f(u.uBlacks, p.blacks);
    gl.uniform1f(u.uSaturation, p.saturation);
    gl.uniform1f(u.uVibrance, p.vibrance);
    gl.uniformMatrix3fv(u.uHueMat, false, p.hue === 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : hueMatrix(p.hue));
    gl.uniform1f(u.uSharpen, p.sharpen);
    gl.uniform1f(u.uClarity, p.clarity);
    gl.uniform1f(u.uDenoise, p.denoise);
    gl.uniform1f(u.uBW, p.bw ? 1 : 0);
    gl.uniform3f(u.uBWMix, ...(BW_MIXES[p.bwMix] || BW_MIXES.neutre));
    const tone = hexToRgb(p.toneColor);
    const toneLuma = Math.max(lumaOf(tone), 1e-3);
    gl.uniform3f(u.uToneColor, ...tone.map((v) => Math.min(1, (v * 0.5) / toneLuma)));
    gl.uniform1f(u.uToneAmount, p.toneAmount);
    gl.uniform3f(u.uSplitShadow, ...chroma(p.splitShadowHue, p.splitShadowAmount));
    gl.uniform3f(u.uSplitHigh, ...chroma(p.splitHighHue, p.splitHighAmount));
    gl.uniform1f(u.uFade, p.fade);
    gl.uniform1f(u.uVignette, p.vignette);
    gl.uniform1f(u.uGrain, p.grain);
    gl.uniform1f(u.uGrainSize, Math.max(1, longSide / 1600));
  }

  /**
   * Affiche l'image dans le canvas.
   * view : { zoom, panX, panY, rotation } en pixels physiques ; zoom = px écran par px image.
   */
  render(params, view, { split = -1, bypass = false } = {}) {
    if (!this.isHealthy() || !this.image) return;
    const gl = this.gl;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const z = view.zoom;
    const cos = Math.cos(view.rotation || 0);
    const sin = Math.sin(view.rotation || 0);
    const cx = cw / 2 + view.panX;
    const cy = ch / 2 + view.panY;
    const matrix = [
      cos / z, -sin / z, 0,
      -sin / z, -cos / z, 0,
      (-cos * cx + sin * (ch - cy)) / z + this.width / 2, (sin * cx + cos * (ch - cy)) / z + this.height / 2, 1,
    ];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.BLEND);
    this.setUniforms(params, { matrix, footprint: 1 / z, mode: 0, split, bypass });
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Rend l'image entière en miniature (pour les filtres et l'histogramme). */
  renderThumbnail(params, maxSide, { bypass = false } = {}) {
    this.ensureReady();
    const gl = this.gl;
    const scale = Math.min(1, maxSide / Math.max(this.width, this.height));
    const tw = Math.max(1, Math.round(this.width * scale));
    const th = Math.max(1, Math.round(this.height * scale));
    this.target('thumb', tw, th);
    const matrix = [this.width / tw, 0, 0, 0, this.height / th, 0, 0, 0, 1];
    this.setUniforms(params, { matrix, footprint: this.width / tw, mode: 1, bypass });
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixels = new Uint8ClampedArray(tw * th * 4);
    gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return new ImageData(pixels, tw, th);
  }

  /**
   * Développe l'image en pleine définition, tuile par tuile, et renvoie un nouveau canvas.
   * onProgress(fraction) est appelé régulièrement ; la fonction rend la main entre les tuiles.
   */
  async renderFull(params, onProgress) {
    this.ensureReady();
    const gl = this.gl;
    const image = this.image;
    const W = image.width;
    const H = image.height;
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const octx = out.getContext('2d');
    const ictx = image.getContext('2d', { willReadFrequently: true });
    const tile = Math.min(TILE, this.maxTexture - 2 * TILE_PAD);
    const total = Math.ceil(W / tile) * Math.ceil(H / tile);
    let done = 0;

    for (let ty = 0; ty < H; ty += tile) {
      for (let tx = 0; tx < W; tx += tile) {
        const tw = Math.min(tile, W - tx);
        const th = Math.min(tile, H - ty);
        const px = Math.max(0, tx - TILE_PAD);
        const py = Math.max(0, ty - TILE_PAD);
        const pw = Math.min(W, tx + tw + TILE_PAD) - px;
        const ph = Math.min(H, ty + th + TILE_PAD) - py;
        const data = ictx.getImageData(px, py, pw, ph);
        const tex = this.texture(data.data, { width: pw, height: ph });
        this.target('tile', tw, th);
        this.setUniforms(params, {
          matrix: [1, 0, 0, 0, 1, 0, tx, ty, 1],
          footprint: 1,
          mode: 1,
          srcRect: [px, py, pw, ph],
        });
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const pixels = new Uint8ClampedArray(tw * th * 4);
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.deleteTexture(tex);
        if (gl !== this.gl || gl.isContextLost()) throw new Error('Contexte graphique perdu');
        octx.putImageData(new ImageData(pixels, tw, th), tx, ty);
        done += 1;
        if (onProgress) onProgress(done / total);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
}
