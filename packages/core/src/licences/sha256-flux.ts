/**
 * Un SHA-256 incrémental, sans dépendance (RC46) [R667].
 *
 * `crypto.subtle.digest` ne prend qu'un tampon entier : pour l'empreinte d'une pièce de plusieurs centaines de Mo lue
 * tranche par tranche, il faut garder l'état du calcul d'une tranche à l'autre. L'empreinte rendue est la SHA-256
 * standard (FIPS 180-4) de tous les octets donnés, dans l'ordre : la même que celle de n'importe quel outil courant.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export class Sha256Flux {
  private readonly h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly w = new Uint32Array(64);
  /** Les octets qui n'ont pas encore rempli un bloc de 64. */
  private readonly pending = new Uint8Array(64);
  private pendingLength = 0;
  /** Le nombre d'octets donnés ; sûr jusqu'à 2^53. */
  private total = 0;
  private done = false;

  /** Ajoute des octets, dans l'ordre. */
  update(bytes: Uint8Array): this {
    if (this.done) throw new Error('sha256_deja_rendue');
    let offset = 0;
    this.total += bytes.byteLength;
    if (this.pendingLength > 0) {
      const take = Math.min(64 - this.pendingLength, bytes.byteLength);
      this.pending.set(bytes.subarray(0, take), this.pendingLength);
      this.pendingLength += take;
      offset = take;
      if (this.pendingLength < 64) return this;
      this.block(this.pending, 0);
      this.pendingLength = 0;
    }
    while (offset + 64 <= bytes.byteLength) {
      this.block(bytes, offset);
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      this.pending.set(bytes.subarray(offset), 0);
      this.pendingLength = bytes.byteLength - offset;
    }
    return this;
  }

  /** L'empreinte, en hexadécimal minuscule ; le calcul est ensuite fermé. */
  hex(): string {
    if (this.done) throw new Error('sha256_deja_rendue');
    const bits = this.total * 8;
    const tail = new Uint8Array(this.pendingLength + 9 <= 64 ? 64 : 128);
    tail.set(this.pending.subarray(0, this.pendingLength));
    tail[this.pendingLength] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.byteLength - 8, Math.floor(bits / 0x100000000));
    view.setUint32(tail.byteLength - 4, bits >>> 0);
    for (let o = 0; o < tail.byteLength; o += 64) this.block(tail, o);
    this.done = true;
    return [...this.h].map((x) => x.toString(16).padStart(8, '0')).join('');
  }

  private block(bytes: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((bytes[j]! << 24) | (bytes[j + 1]! << 16) | (bytes[j + 2]! << 8) | bytes[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    const hh = this.h;
    let a = hh[0]!;
    let b = hh[1]!;
    let c = hh[2]!;
    let d = hh[3]!;
    let e = hh[4]!;
    let f = hh[5]!;
    let g = hh[6]!;
    let h = hh[7]!;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    hh[0] = (hh[0]! + a) >>> 0;
    hh[1] = (hh[1]! + b) >>> 0;
    hh[2] = (hh[2]! + c) >>> 0;
    hh[3] = (hh[3]! + d) >>> 0;
    hh[4] = (hh[4]! + e) >>> 0;
    hh[5] = (hh[5]! + f) >>> 0;
    hh[6] = (hh[6]! + g) >>> 0;
    hh[7] = (hh[7]! + h) >>> 0;
  }
}
