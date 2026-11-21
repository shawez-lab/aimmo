/**
 * AU103 · Un vrai JPEG de base, fait pour les tests : chaque carré de 8 × 8 points ne garde que sa lumière moyenne (aucun
 * détail), codée par Huffman avec les tables standard. En couleurs, la lumière est échantillonnée 2 × 2 et les deux
 * couleurs restent neutres. Tout décodeur de JPEG le lit.
 */
export interface Gray {
  width: number;
  height: number;
  luma: Uint8Array;
}

const DC_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
// Une seule valeur AC : la fin de bloc, code « 0 ».
const AC_COUNTS = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const AC_VALUES = [0];

function codes(counts: number[], values: number[]): Map<number, { code: number; len: number }> {
  const out = new Map<number, { code: number; len: number }>();
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let j = 0; j < counts[l - 1]!; j++) out.set(values[k++]!, { code: code++, len: l });
    code <<= 1;
  }
  return out;
}

/** Une image grise agrandie (ou réduite) au point le plus proche. */
export function resize(img: Gray, width: number, height: number): Gray {
  const luma = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y * img.height) / height) * img.width;
    for (let x = 0; x < width; x++) luma[y * width + x] = img.luma[row + Math.floor((x * img.width) / width)]!;
  }
  return { width, height, luma };
}

export function encodeJpeg(img: Gray, o: { color?: boolean; restart?: number } = {}): Uint8Array {
  const { width: w, height: h } = img;
  const color = o.color ?? false;
  const dc = codes(DC_COUNTS, DC_VALUES);
  const ac = codes(AC_COUNTS, AC_VALUES);
  const out: number[] = [0xff, 0xd8];
  const seg = (marker: number, body: number[]) => out.push(0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body);
  seg(0xdb, [0x00, ...new Array<number>(64).fill(1)]);
  seg(0xc0, color ? [8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0] : [8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
  seg(0xc4, [0x00, ...DC_COUNTS, ...DC_VALUES]);
  seg(0xc4, [0x10, ...AC_COUNTS, ...AC_VALUES]);
  if (o.restart) seg(0xdd, [o.restart >> 8, o.restart & 255]);
  seg(0xda, color ? [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0] : [1, 1, 0x00, 0, 63, 0]);
  let acc = 0;
  let nbits = 0;
  const write = (code: number, len: number) => {
    for (let k = len - 1; k >= 0; k--) {
      acc = (acc << 1) | ((code >> k) & 1);
      if (++nbits === 8) {
        out.push(acc);
        if (acc === 0xff) out.push(0x00);
        acc = 0;
        nbits = 0;
      }
    }
  };
  const flush = () => {
    while (nbits !== 0) write(1, 1);
  };
  const mean = (bx: number, by: number): number => {
    let s = 0;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) s += img.luma[Math.min(h - 1, by * 8 + y) * w + Math.min(w - 1, bx * 8 + x)]!;
    return s / 64;
  };
  const pred = [0, 0, 0];
  const block = (k: number, value: number) => {
    const diff = value - pred[k]!;
    pred[k] = value;
    const a = Math.abs(diff);
    const s = a === 0 ? 0 : Math.floor(Math.log2(a)) + 1;
    const c = dc.get(s)!;
    write(c.code, c.len);
    if (s) write(diff >= 0 ? diff : diff + (1 << s) - 1, s);
    const e = ac.get(0)!;
    write(e.code, e.len);
  };
  const m = color ? 16 : 8;
  const mx = Math.ceil(w / m);
  const my = Math.ceil(h / m);
  let count = 0;
  for (let y = 0; y < my; y++)
    for (let x = 0; x < mx; x++) {
      if (o.restart && count > 0 && count % o.restart === 0) {
        flush();
        out.push(0xff, 0xd0 + (((count / o.restart) - 1) % 8));
        pred.fill(0);
      }
      count++;
      if (color) {
        for (let v = 0; v < 2; v++) for (let u = 0; u < 2; u++) block(0, Math.round(8 * (mean(2 * x + u, 2 * y + v) - 128)));
        block(1, 0);
        block(2, 0);
      } else block(0, Math.round(8 * (mean(x, y) - 128)));
    }
  flush();
  out.push(0xff, 0xd9);
  return new Uint8Array(out);
}
