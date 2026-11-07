/**
 * Code QR écrit à la main, sans dépendance (HX07) : mode octets, correction M, versions 1 à 10 (213 octets au plus),
 * selon la norme ISO/IEC 18004. Le masque est celui de moindre pénalité, comme le veut la norme. Le code rend une
 * matrice de modules ; `qrSvg` la dessine en un seul chemin, avec sa marge de quatre modules.
 */

export interface QrCode {
  version: number;
  mask: number;
  size: number;
  /** `modules[y][x]` : vrai pour un module sombre. */
  modules: boolean[][];
}

/** Correction M : codes de correction par bloc et nombre de blocs, pour les versions 1 à 10. */
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26] as const;
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5] as const;
export const QR_MAX_VERSION = 10;
/** Le niveau M s'écrit 0 dans les bits de format. */
const ECL_M_BITS = 0;

export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (version: number): number => Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version - 1]! * BLOCKS[version - 1]!;

/** Capacité en octets d'une version, en mode octets. */
export const byteCapacity = (version: number): number => Math.floor((dataCodewords(version) * 8 - 4 - (version < 10 ? 8 : 16)) / 8);

export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = version * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

// Corps de Galois GF(2^8), polynôme 0x11d.
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i] = result[i]! ^ gfMul(coef, factor)));
  }
  return result;
}

export function formatBits(mask: number): number {
  const data = (ECL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

class Grid {
  readonly modules: boolean[][];
  readonly fixed: boolean[][];
  readonly size: number;
  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.fixed[y]![x] = true;
  }
}

/** Les motifs fixes : repères, séparateurs, alignements, lignes de synchronisation, et la place du format. */
function drawFunctionPatterns(g: Grid, version: number): void {
  const n = g.size;
  for (let i = 0; i < n; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= n || y < 0 || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const pos = alignmentPositions(version);
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.set(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  drawFormat(g, 0);
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(a, b, dark);
      g.set(b, a, dark);
    }
  }
}

function drawFormat(g: Grid, mask: number): void {
  const n = g.size;
  const bits = formatBits(mask);
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, n - 15 + i, bit(i));
  g.set(8, n - 8, true);
}

/** Les codes de données, découpés en blocs, chacun suivi de sa correction, puis entrelacés. */
export function interleave(data: readonly number[], version: number): number[] {
  const blocks = BLOCKS[version - 1]!;
  const ecc = ECC_PER_BLOCK[version - 1]!;
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(ecc);
  const parts: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const len = shortLen - ecc + (i < shortBlocks ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const block = [...dat];
    if (i < shortBlocks) block.push(0); // place réservée, sautée à l'entrelacement
    parts.push([...block, ...rsRemainder(dat, divisor)]);
  }
  const out: number[] = [];
  for (let i = 0; i < parts[0]!.length; i++) {
    parts.forEach((block, j) => {
      if (i !== shortLen - ecc || j >= shortBlocks) out.push(block[i]!);
    });
  }
  return out;
}

/** L'ordre de lecture des modules libres : en zigzag, deux colonnes à la fois, de droite à gauche. */
export function dataPositions(fixed: readonly boolean[][]): [number, number][] {
  const n = fixed.length;
  const out: [number, number][] = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (!fixed[y]![x]) out.push([x, y]);
      }
    }
  }
  return out;
}

const PENALTY = { N1: 3, N2: 3, N3: 40, N4: 10 } as const;

/** La pénalité d'une matrice, selon les quatre règles de la norme. */
export function penalty(m: readonly boolean[][]): number {
  const n = m.length;
  let score = 0;
  const line = (get: (i: number, j: number) => boolean): void => {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j <= n; j++) {
        if (j < n && get(i, j) === get(i, j - 1)) run++;
        else {
          if (run >= 5) score += PENALTY.N1 + run - 5;
          run = 1;
        }
      }
      // Motif 1:1:3:1:1, précédé ou suivi de quatre modules clairs (la marge compte comme claire).
      const at = (j: number): boolean => j >= 0 && j < n && get(i, j);
      for (let j = 0; j + 7 <= n; j++) {
        if (!(at(j) && !at(j + 1) && at(j + 2) && at(j + 3) && at(j + 4) && !at(j + 5) && at(j + 6))) continue;
        const before = !at(j - 1) && !at(j - 2) && !at(j - 3) && !at(j - 4);
        const after = !at(j + 7) && !at(j + 8) && !at(j + 9) && !at(j + 10);
        if (before) score += PENALTY.N3;
        if (after) score += PENALTY.N3;
      }
    }
  };
  line((i, j) => m[i]![j]!);
  line((i, j) => m[j]![i]!);
  for (let y = 0; y + 1 < n; y++) {
    for (let x = 0; x + 1 < n; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += PENALTY.N2;
    }
  }
  const dark = m.reduce((s, row) => s + row.filter(Boolean).length, 0);
  const total = n * n;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * PENALTY.N4;
  return score;
}

export type QrRefusal = { ok: false; code: 'trop_long' | 'vide' };

/** Encode le texte en UTF-8, mode octets, correction M, dans la plus petite version qui le tient. */
export function encodeQr(text: string): { ok: true; qr: QrCode } | QrRefusal {
  const bytes = [...new TextEncoder().encode(text)];
  if (bytes.length === 0) return { ok: false, code: 'vide' };
  let version = 1;
  while (version <= QR_MAX_VERSION && byteCapacity(version) < bytes.length) version++;
  if (version > QR_MAX_VERSION) return { ok: false, code: 'trop_long' };

  const bits: number[] = [];
  const push = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  const base = new Grid(version * 4 + 17);
  drawFunctionPatterns(base, version);
  const codewords = interleave(data, version);
  const positions = dataPositions(base.fixed);
  positions.forEach(([x, y], i) => {
    const byte = codewords[i >>> 3];
    base.modules[y]![x] = byte !== undefined && ((byte >>> (7 - (i & 7))) & 1) === 1;
  });

  let best: QrCode | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = new Grid(base.size);
    for (let y = 0; y < g.size; y++) {
      for (let x = 0; x < g.size; x++) {
        g.modules[y]![x] = base.modules[y]![x]!;
        g.fixed[y]![x] = base.fixed[y]![x]!;
      }
    }
    for (const [x, y] of positions) if (maskBit(mask, x, y)) g.modules[y]![x] = !g.modules[y]![x];
    drawFormat(g, mask);
    const score = penalty(g.modules);
    if (score < bestScore) {
      bestScore = score;
      best = { version, mask, size: g.size, modules: g.modules };
    }
  }
  return { ok: true, qr: best! };
}

/**
 * Le code dessiné en SVG : un seul chemin, marge de quatre modules, à l'échelle de son cadre. Les couleurs viennent de
 * la feuille du support (encre sur papier, `.qr svg`), jamais du dessin [R201].
 */
export function qrSvg(qr: QrCode, label: string): string {
  const quiet = 4;
  const side = qr.size + quiet * 2;
  let d = '';
  qr.modules.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  }));
  const safe = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" role="img" aria-label="${safe}" shape-rendering="crispEdges"><path d="${d}" fill="currentColor"/></svg>`;
}
