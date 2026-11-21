/**
 * AU103 · L'image entière de la photo HDR, prise par la caméra du téléphone [R677].
 *
 * - Le téléphone fond les prises en couleurs, à leur taille (au plus `IMAGE_MAX_SIDE` points du grand côté), en fait un
 *   JPEG, puis relit ce JPEG : c'est sur l'image gardée, décodée et réduite, que se fait le contrôle de qualité, pas sur
 *   les prises. L'image gardée accompagne la saisie par son empreinte, sa taille et sa version réduite (`kept`).
 * - Le serveur juge de nouveau la version réduite de l'image gardée (trop sombre, brûlée, floue), refait la fusion des
 *   prises réduites et vérifie que l'image gardée en est bien le résultat ; une image trop petite pour une annonce est
 *   refusée.
 * - Le fichier lui-même part ensuite, à part, quand le réseau le permet : le serveur ne le range que s'il a l'empreinte,
 *   le poids et la taille annoncés, et s'il est un vrai JPEG. Tant qu'il n'est pas rangé, le téléphone le garde.
 * - Aucune IA : des calculs écrits, mêmes entrées, même verdict.
 */
import { decodeLuma, fuseExposures, judgePhoto, type Luma, type PhotoProblem, type PhotoThresholds, PHOTO_THRESHOLDS } from './photo.ts';

/** Le grand côté de l'image gardée : au moins de quoi illustrer une annonce, au plus ce que le téléphone fond sans peine. */
export const IMAGE_MIN_LONG_SIDE = 1280;
export const IMAGE_MAX_SIDE = 2048;
/** Le poids du fichier JPEG, au plus. */
export const IMAGE_MAX_BYTES = 4_000_000;
export const IMAGE_TYPE = 'image/jpeg';
/** L'écart moyen permis, de 0 à 255, entre l'image gardée réduite et la fusion des prises réduites. */
export const KEPT_MAX_MEAN_GAP = 16;
/** L'écart de proportions permis entre l'image entière et sa version réduite (arrondis de la réduction). */
const RATIO_TOLERANCE = 0.06;

/** Ce que la saisie dit de l'image gardée. */
export interface KeptImage {
  sha256: string;
  width: number;
  height: number;
  bytes: number;
  kept: Luma;
}

export type KeptCode = 'image_manquante' | 'image_invalide' | 'image_trop_petite' | 'image_differente' | PhotoProblem;

/** Lire ce que la saisie dit de l'image : `null` si un champ manque ou sort des bornes. */
export function readKeptImage(v: unknown): KeptImage | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) return null;
  const side = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= IMAGE_MAX_SIDE;
  if (!side(o.width) || !side(o.height)) return null;
  if (!Number.isInteger(o.bytes) || (o.bytes as number) < 1 || (o.bytes as number) > IMAGE_MAX_BYTES) return null;
  const kept = decodeLuma(o.kept);
  if (!kept) return null;
  return { sha256: o.sha256, width: o.width, height: o.height, bytes: o.bytes as number, kept };
}

/** L'écart moyen, point par point, entre deux images réduites de même taille. */
export function meanGap(a: Luma, b: Luma): number {
  let s = 0;
  for (let i = 0; i < a.luma.length; i++) s += Math.abs((a.luma[i] as number) - (b.luma[i] as number));
  return Math.round((s / a.luma.length) * 100) / 100;
}

export type KeptVerdict = { ok: true; image: KeptImage; figures: ReturnType<typeof judgePhoto>['figures'] } | { ok: false; rule: 'R677'; code: KeptCode };

/**
 * Le contrôle de l'image gardée [R677] : présente, assez grande, de mêmes proportions que sa version réduite, bonne à
 * l'œil des calculs (ni sombre, ni brûlée, ni floue), et résultat des prises fondues. Les prises elles-mêmes ont déjà
 * passé le contrôle HDR [R277].
 */
export function checkKeptImage(raw: unknown, exposures: readonly Luma[], t: PhotoThresholds = PHOTO_THRESHOLDS): KeptVerdict {
  if (raw === undefined || raw === null) return { ok: false, rule: 'R677', code: 'image_manquante' };
  const image = readKeptImage(raw);
  if (!image) return { ok: false, rule: 'R677', code: 'image_invalide' };
  const first = exposures[0];
  if (!first || image.kept.width !== first.width || image.kept.height !== first.height) return { ok: false, rule: 'R677', code: 'image_invalide' };
  const ratio = image.width / image.height;
  if (Math.abs(image.kept.width / image.kept.height - ratio) / ratio > RATIO_TOLERANCE) return { ok: false, rule: 'R677', code: 'image_invalide' };
  if (Math.max(image.width, image.height) < IMAGE_MIN_LONG_SIDE) return { ok: false, rule: 'R677', code: 'image_trop_petite' };
  const verdict = judgePhoto(image.kept, t);
  if (!verdict.ok) return { ok: false, rule: 'R677', code: verdict.problems[0] as PhotoProblem };
  if (meanGap(image.kept, fuseExposures(exposures)) > KEPT_MAX_MEAN_GAP) return { ok: false, rule: 'R677', code: 'image_differente' };
  return { ok: true, image, figures: verdict.figures };
}

/**
 * La taille d'un JPEG, lue dans son en-tête de trame (SOF), sans le décoder : `null` si ce n'est pas un JPEG entier
 * (début, trame, fin).
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[n - 2] !== 0xff || bytes[n - 1] !== 0xd9) return null;
  let i = 2;
  while (i + 4 <= n) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] as number;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    if (len < 2 || i + 2 + len > n) return null;
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      if (len < 7) return null;
      const height = ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number);
      const width = ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/** L'empreinte SHA-256 d'un fichier, en hexadécimal. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Le fichier reçu est-il celui que la saisie annonçait ? Même poids, même empreinte, vrai JPEG de même taille [R677]. */
export async function matchesKept(bytes: Uint8Array, expected: { sha256: string; width: number; height: number; bytes: number }): Promise<boolean> {
  if (bytes.length !== expected.bytes) return false;
  const size = jpegSize(bytes);
  if (!size || size.width !== expected.width || size.height !== expected.height) return false;
  return (await sha256Hex(bytes)) === expected.sha256;
}
