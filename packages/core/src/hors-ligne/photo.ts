/**
 * La photo prise dans l'appli (HX12) [R277].
 *
 * - Chaque photo est faite de plusieurs prises à des expositions différentes, fondues en une seule image (HDR) : les
 *   zones sombres viennent de la prise claire, les fenêtres de la prise sombre. Une photo d'une seule prise, ou de prises
 *   de même lumière, n'est pas une photo HDR : refusée.
 * - L'image fondue est jugée sur sa version réduite en niveaux de gris : trop sombre, brûlée ou floue, elle est refusée
 *   tout de suite, sur le téléphone, avant que l'agent quitte la pièce. Le serveur refait le même calcul sur la même
 *   image réduite : il ne croit jamais le verdict du téléphone.
 * - Aucune IA : des calculs écrits, mêmes entrées, même verdict.
 */

/** Une image réduite en niveaux de gris : une valeur de 0 (noir) à 255 (blanc) par point, ligne après ligne. */
export interface Luma {
  width: number;
  height: number;
  luma: Uint8Array;
}

export const PHOTO_PROBLEMS = ['trop_sombre', 'brulee', 'floue'] as const;
export type PhotoProblem = (typeof PHOTO_PROBLEMS)[number];

/** Les réglages du jugement : modifiables sans toucher au code. */
export interface PhotoThresholds {
  /** En dessous de cette moyenne, la photo est trop sombre. */
  minBrightness: number;
  /** Au-delà de cette part de points blancs (250 et plus), la photo est brûlée. */
  maxClipped: number;
  /** En dessous de cette netteté (variance du laplacien), la photo est floue. */
  minSharpness: number;
  /** Au moins tant de prises fondues. */
  minExposures: number;
  /** Écart de lumière moyenne, au moins, entre la prise la plus sombre et la plus claire. */
  minExposureSpread: number;
}

export const PHOTO_THRESHOLDS: PhotoThresholds = Object.freeze({ minBrightness: 60, maxClipped: 0.2, minSharpness: 40, minExposures: 2, minExposureSpread: 25 });

/** La taille de l'image réduite, en points, de chaque côté. */
export const MIN_SIDE = 32;
export const MAX_SIDE = 128;
export const MAX_EXPOSURES = 5;

export interface PhotoFigures {
  /** Lumière moyenne, de 0 à 255. */
  brightness: number;
  /** Part des points blancs, de 0 à 1. */
  clipped: number;
  /** Variance du laplacien : plus elle est haute, plus l'image est nette. */
  sharpness: number;
}

export interface PhotoVerdict {
  ok: boolean;
  problems: PhotoProblem[];
  figures: PhotoFigures;
  /** Ce que l'agent lit sur l'écran, en une phrase, quand la photo est refusée. */
  advice: string | null;
}

const ADVICE: Record<PhotoProblem, string> = {
  trop_sombre: 'Trop sombre : allumez, ouvrez les volets, puis reprenez la photo.',
  brulee: 'Trop de blanc : tournez-vous un peu pour sortir la fenêtre du centre, puis reprenez la photo.',
  floue: 'Floue : tenez le téléphone à deux mains, attendez une seconde sans bouger, puis reprenez la photo.',
};

/** Une image réduite valable : taille dans les bornes, un point par case. */
export function validLuma(v: unknown): v is Luma {
  if (typeof v !== 'object' || v === null) return false;
  const l = v as Partial<Luma>;
  if (!Number.isInteger(l.width) || !Number.isInteger(l.height)) return false;
  const w = l.width as number;
  const h = l.height as number;
  if (w < MIN_SIDE || h < MIN_SIDE || w > MAX_SIDE || h > MAX_SIDE) return false;
  return l.luma instanceof Uint8Array && l.luma.length === w * h;
}

/** Lumière, blancs et netteté d'une image réduite. */
export function figuresOf(img: Luma): PhotoFigures {
  const { width: w, height: h, luma } = img;
  let sum = 0;
  let white = 0;
  for (let i = 0; i < luma.length; i++) {
    const v = luma[i] as number;
    sum += v;
    if (v >= 250) white++;
  }
  // Laplacien à quatre voisins, sur l'intérieur de l'image.
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = (luma[i - 1] as number) + (luma[i + 1] as number) + (luma[i - w] as number) + (luma[i + w] as number) - 4 * (luma[i] as number);
      n++;
      const d = lap - mean;
      mean += d / n;
      m2 += d * (lap - mean);
    }
  }
  const round = (x: number, k = 100): number => Math.round(x * k) / k;
  return { brightness: round(sum / luma.length), clipped: round(white / luma.length, 1000), sharpness: round(n > 0 ? m2 / n : 0) };
}

/** Le jugement d'une image : trop sombre, brûlée, floue, ou bonne [R277]. */
export function judgePhoto(img: Luma, t: PhotoThresholds = PHOTO_THRESHOLDS): PhotoVerdict {
  const figures = figuresOf(img);
  const problems: PhotoProblem[] = [];
  if (figures.brightness < t.minBrightness) problems.push('trop_sombre');
  if (figures.clipped > t.maxClipped) problems.push('brulee');
  if (figures.sharpness < t.minSharpness) problems.push('floue');
  return { ok: problems.length === 0, problems, figures, advice: problems.length ? ADVICE[problems[0] as PhotoProblem] : null };
}

/** Le poids d'un point dans la fusion : le plus fort au milieu des gris, presque nul au noir et au blanc. */
const wellExposed = (v: number): number => Math.exp(-((v / 255 - 0.5) ** 2) / (2 * 0.2 * 0.2)) + 1e-6;

/**
 * La fusion des prises (HDR, par exposition) : chaque point de l'image finale est la moyenne des prises, chacune pesée
 * par sa bonne exposition à cet endroit. Les prises ont la même taille.
 */
export function fuseExposures(exposures: readonly Luma[]): Luma {
  const first = exposures[0];
  if (!first) throw new Error('Aucune prise.');
  const { width, height } = first;
  for (const e of exposures) if (e.width !== width || e.height !== height) throw new Error('Prises de tailles différentes.');
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    let num = 0;
    let den = 0;
    for (const e of exposures) {
      const v = e.luma[i] as number;
      const w = wellExposed(v);
      num += w * v;
      den += w;
    }
    out[i] = Math.max(0, Math.min(255, Math.round(num / den)));
  }
  return { width, height, luma: out };
}

export type HdrResult =
  | { ok: true; image: Luma; verdict: PhotoVerdict; exposures: number }
  | { ok: false; rule: 'R277'; code: 'prises_invalides' | 'pas_hdr' | 'photo_refusee'; verdict: PhotoVerdict | null; advice: string };

/**
 * Une photo HDR de l'appli : au moins deux prises de même taille et de lumières différentes, fondues, puis jugées. Le
 * téléphone l'appelle avant de garder la photo ; le serveur l'appelle de nouveau sur les mêmes prises réduites [R277].
 */
export function hdrPhoto(exposures: unknown, t: PhotoThresholds = PHOTO_THRESHOLDS): HdrResult {
  if (!Array.isArray(exposures) || exposures.length > MAX_EXPOSURES || !exposures.every(validLuma)) {
    return { ok: false, rule: 'R277', code: 'prises_invalides', verdict: null, advice: 'La photo n’a pas été prise en entier : reprenez-la.' };
  }
  const list = exposures as Luma[];
  const first = list[0];
  if (!first || list.some((e) => e.width !== first.width || e.height !== first.height)) {
    return { ok: false, rule: 'R277', code: 'prises_invalides', verdict: null, advice: 'La photo n’a pas été prise en entier : reprenez-la.' };
  }
  const means = list.map((e) => figuresOf(e).brightness);
  if (list.length < t.minExposures || Math.max(...means) - Math.min(...means) < t.minExposureSpread) {
    return { ok: false, rule: 'R277', code: 'pas_hdr', verdict: null, advice: 'Une seule lumière a été prise : reprenez la photo sans bouger pendant les prises.' };
  }
  const image = fuseExposures(list);
  const verdict = judgePhoto(image, t);
  if (!verdict.ok) return { ok: false, rule: 'R277', code: 'photo_refusee', verdict, advice: verdict.advice ?? '' };
  return { ok: true, image, verdict, exposures: list.length };
}

/** Une image réduite mise en texte pour voyager hors ligne : taille, puis les points en base 64. */
export function encodeLuma(img: Luma): { width: number; height: number; data: string } {
  let s = '';
  for (let i = 0; i < img.luma.length; i++) s += String.fromCharCode(img.luma[i] as number);
  return { width: img.width, height: img.height, data: btoa(s) };
}

/** L'inverse : rend `null` pour tout ce qui n'est pas une image réduite valable. */
export function decodeLuma(v: unknown): Luma | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { width?: unknown; height?: unknown; data?: unknown };
  if (typeof o.data !== 'string' || o.data.length > 4 * Math.ceil((MAX_SIDE * MAX_SIDE) / 3) + 4) return null;
  let raw: string;
  try {
    raw = atob(o.data);
  } catch {
    return null;
  }
  const luma = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) luma[i] = raw.charCodeAt(i);
  const img = { width: o.width as number, height: o.height as number, luma };
  return validLuma(img) ? img : null;
}
