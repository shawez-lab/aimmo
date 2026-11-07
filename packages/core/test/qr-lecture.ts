// Un lecteur de code QR pour les tests, écrit à part de l'encodeur : tables recopiées de la norme ISO/IEC 18004,
// syndromes de Reed-Solomon calculés par évaluation (et non par division), zigzag réécrit. Il lit une matrice nette,
// sans traitement d'image, et refuse tout code dont la correction ne retombe pas à zéro.

/** Les quinze bits de format du niveau M, masques 0 à 7, tels que la norme les donne (tableau C.1). */
const FORMAT_M = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
/** Positions des alignements, versions 1 à 10 (annexe E). */
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
/** Niveau M (tableau 9) : [codes de correction par bloc, [nombre de blocs, codes de données par bloc]…]. */
const BLOCKS_M: Record<number, [number, [number, number][]]> = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
};

const EXP: number[] = [];
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP.push(x);
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
}
const LOG: number[] = new Array(256).fill(0);
EXP.forEach((v, i) => (LOG[v] = i));
const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[(LOG[a]! + LOG[b]!) % 255]!);

/** Les syndromes d'un bloc (données puis correction) : tous nuls pour un bloc juste. */
function syndromesZero(block: number[], ecc: number): boolean {
  for (let i = 0; i < ecc; i++) {
    let s = 0;
    for (const c of block) s = mul(s, EXP[i]!) ^ c;
    if (s !== 0) return false;
  }
  return true;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

export function readQr(m: readonly boolean[][]): string {
  const n = m.length;
  const version = (n - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 10) throw new Error('taille');
  // Format, première copie : colonne 8 de haut en bas puis ligne 8 vers la gauche, bit de poids fort en premier.
  const at = (x: number, y: number): string => (m[y]![x] ? '1' : '0');
  const coords: [number, number][] = [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]];
  const first = coords.map(([x, y]) => at(x, y)).join('');
  const second = [...Array.from({ length: 7 }, (_, i) => at(8, n - 1 - i)), ...Array.from({ length: 8 }, (_, i) => at(n - 8 + i, 8))].join('');
  const mask = FORMAT_M.indexOf(first);
  if (mask < 0 || second !== first) throw new Error('format');

  const reserved = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const box = (x0: number, y0: number, w: number, h: number): void => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < n && y < n) reserved[y]![x] = true;
  };
  box(0, 0, 9, 9);
  box(n - 8, 0, 8, 9);
  box(0, n - 8, 9, 8);
  box(6, 0, 1, n);
  box(0, 6, n, 1);
  const a = ALIGN[version]!;
  // Partout, sauf sur les trois repères des coins.
  const last = a[a.length - 1];
  for (const cy of a) for (const cx of a) if (!((cx === 6 && cy === 6) || (cx === 6 && cy === last) || (cx === last && cy === 6))) box(cx - 2, cy - 2, 5, 5);
  if (version >= 7) {
    box(n - 11, 0, 3, 6);
    box(0, n - 11, 6, 3);
  }

  const bits: number[] = [];
  let upward = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < n; k++) {
      const y = upward ? n - 1 - k : k;
      for (const x of [col, col - 1]) if (!reserved[y]![x]) bits.push((m[y]![x] ? 1 : 0) ^ (MASKS[mask]!(x, y) ? 1 : 0));
    }
    upward = !upward;
  }
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((s, b) => (s << 1) | b, 0));

  const [ecc, groups] = BLOCKS_M[version]!;
  const sizes = groups.flatMap(([count, len]) => new Array<number>(count).fill(len));
  const blocks = sizes.map(() => [] as number[]);
  let k = 0;
  for (let i = 0; i < Math.max(...sizes); i++) sizes.forEach((len, b) => i < len && blocks[b]!.push(codewords[k++]!));
  const eccs = sizes.map(() => [] as number[]);
  for (let i = 0; i < ecc; i++) sizes.forEach((_, b) => eccs[b]!.push(codewords[k++]!));
  blocks.forEach((data, b) => {
    if (!syndromesZero([...data, ...eccs[b]!], ecc)) throw new Error('correction');
  });

  const data = blocks.flat();
  const stream = data.flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >> (7 - i)) & 1));
  const take = (len: number, from: number): number => stream.slice(from, from + len).reduce((s, b) => (s << 1) | b, 0);
  if (take(4, 0) !== 0b0100) throw new Error('mode');
  const lenBits = version < 10 ? 8 : 16;
  const count = take(lenBits, 4);
  const bytes = Array.from({ length: count }, (_, i) => take(8, 4 + lenBits + i * 8));
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
}

/** Les modules dessinés dans le SVG de `qrSvg`, relus depuis son chemin. */
export function modulesFromSvg(svg: string): boolean[][] {
  const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!box) throw new Error('viewBox');
  const side = Number(box[1]);
  const n = side - 8;
  const out = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  for (const [, x, y] of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) out[Number(y) - 4]![Number(x) - 4] = true;
  return out;
}
