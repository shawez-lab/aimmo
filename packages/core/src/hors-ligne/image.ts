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

const u16 = (b: Uint8Array, i: number): number => (((b[i] as number) << 8) | (b[i + 1] as number)) >>> 0;
const SOF_MARKERS: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const ARITHMETIC: ReadonlySet<number> = new Set([0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Des tables de quantification bien formées : chacune 64 valeurs, sur 8 ou 16 bits, numéro 0 à 3. */
function goodDqt(b: Uint8Array, p: number, end: number): boolean {
  while (p < end) {
    const pq = (b[p] as number) >> 4;
    if (pq > 1 || ((b[p] as number) & 15) > 3) return false;
    p += 1 + (pq ? 128 : 64);
  }
  return p === end;
}
/** Des tables de Huffman bien formées : classe et numéro valables, 16 longueurs, puis autant de valeurs. */
function goodDht(b: Uint8Array, p: number, end: number): boolean {
  while (p < end) {
    if (p + 17 > end || (b[p] as number) >> 4 > 1 || ((b[p] as number) & 15) > 3) return false;
    let sum = 0;
    for (let k = 1; k <= 16; k++) sum += b[p + k] as number;
    if (sum === 0 || sum > 256) return false;
    p += 17 + sum;
  }
  return p === end;
}

/**
 * Un JPEG entier, lu de bout en bout sans le décoder : début, tables de quantification et de Huffman, une seule trame
 * (SOF) à la taille dite, au moins un balayage (SOS) dont les composantes sont celles de la trame, des données codées
 * sans marqueur parasite, et la fin, au dernier octet. Rend la taille de la trame, ou `null` [R677].
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  let dqt = false;
  let dht = false;
  let sof: { width: number; height: number; marker: number; components: Set<number> } | null = null;
  let scans = 0;
  while (i + 2 <= n) {
    if (bytes[i] !== 0xff) return null;
    while (i + 1 < n && bytes[i + 1] === 0xff) i++;
    const marker = bytes[i + 1] as number;
    i += 2;
    if (marker === 0xd9) return scans > 0 && sof && i === n ? { width: sof.width, height: sof.height } : null;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) return null;
    if (i + 2 > n) return null;
    const len = u16(bytes, i);
    if (len < 2 || i + len > n) return null;
    const p = i + 2;
    const end = i + len;
    if (marker === 0xdb) {
      if (!goodDqt(bytes, p, end)) return null;
      dqt = true;
    } else if (marker === 0xc4) {
      if (!goodDht(bytes, p, end)) return null;
      dht = true;
    } else if (marker === 0xdd) {
      if (len !== 4) return null;
    } else if (SOF_MARKERS.has(marker)) {
      if (sof || len < 8) return null;
      const nc = bytes[p + 5] as number;
      const precision = bytes[p] as number;
      if ((precision !== 8 && precision !== 12) || (nc !== 1 && nc !== 3 && nc !== 4) || len !== 8 + 3 * nc) return null;
      const height = u16(bytes, p + 1);
      const width = u16(bytes, p + 3);
      if (width === 0 || height === 0) return null;
      const components = new Set<number>();
      for (let k = 0; k < nc; k++) components.add(bytes[p + 6 + 3 * k] as number);
      if (components.size !== nc) return null;
      sof = { width, height, marker, components };
    } else if (marker === 0xda) {
      if (!sof || !dqt || (!dht && !ARITHMETIC.has(sof.marker))) return null;
      const ns = bytes[p] as number;
      if (ns < 1 || ns > 4 || len !== 6 + 2 * ns) return null;
      for (let k = 0; k < ns; k++) if (!sof.components.has(bytes[p + 1 + 2 * k] as number)) return null;
      // Les données codées : un 0xFF n'y est suivi que de 0x00 (octet bourré) ou d'une reprise (RST0 à RST7).
      let j = end;
      while (j < n) {
        if (bytes[j] !== 0xff) {
          j++;
          continue;
        }
        const next = bytes[j + 1];
        if (next === undefined) return null;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          j += 2;
          continue;
        }
        break;
      }
      if (j === end || j >= n) return null;
      scans++;
      i = j;
      continue;
    } else if (!((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)) {
      // Tout autre marqueur (hiérarchique, réservé) : pas un JPEG que l'on range.
      return null;
    }
    i = end;
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
