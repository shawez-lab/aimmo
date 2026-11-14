/**
 * RC40 · Le texte des pages d'un PDF, lu sans IA, page par page.
 *
 * La prélecture du projet du notaire (RC39) et le résumé de copropriété (HX35) attendent le texte de chaque page. Cette
 * fonction le tire du PDF lui-même, sans dépendance ni IA : objets en clair et flux d'objets, compression Flate, arbre des
 * pages et ressources héritées, formulaires imbriqués.
 *
 * Décidé, lecture prudente : elle ne devine jamais. Une page dont un texte ne se décode pas avec certitude (police
 * composite sans table `ToUnicode`, police incorporée sans encodage, glyphe inconnu, filtre non lu) est rendue illisible,
 * à lire par l'agent, plutôt qu'un texte faux qui passerait ensuite pour lu ; une page sans aucun texte (un scan) aussi.
 * Un PDF chiffré, trop gros, abîmé, aux pages trop nombreuses ou à la décompression démesurée est refusé en mots, jamais
 * par une exception. Rien n'est rangé ni écrit au journal : le texte reste dans la mémoire de l'appelant [R13, R15].
 */

export interface PdfLimits {
  /** Taille du fichier, en octets. */
  maxBytes: number;
  maxPages: number;
  /** Total des octets décompressés pour tout le fichier : au-delà, le fichier est refusé (bombe de décompression). */
  maxInflatedBytes: number;

  /** Total des éléments de contenu lus pour tout le fichier, formulaires répétés compris : au-delà, le fichier est refusé. */
  maxWork: number;
}

export const PDF_LIMITS: PdfLimits = { maxBytes: 25 * 1024 * 1024, maxPages: 300, maxInflatedBytes: 80 * 1024 * 1024, maxWork: 5_000_000 };

export type PdfPageText = { page: number; text: string } | { page: number; text: null; reason: 'no_text' | 'undecodable' };

export const PDF_TEXT_REFUSALS = ['not_pdf', 'encrypted', 'too_large', 'too_many_pages', 'inflate_limit', 'too_complex', 'unreadable'] as const;
export type PdfTextRefusalCode = (typeof PDF_TEXT_REFUSALS)[number];
export type PdfTextRefusal = { ok: false; rule: null; code: PdfTextRefusalCode };

/** Le refus dit à l'agent, en mots. */
export const PDF_TEXT_REFUSAL_TEXT: Record<PdfTextRefusalCode, string> = {
  not_pdf: "Ce fichier n'est pas un PDF.",
  encrypted: 'Ce PDF est protégé par un mot de passe : son texte ne peut pas être lu. Lisez-le vous-même.',
  too_large: 'Ce PDF est trop gros pour être lu ici. Lisez-le vous-même.',
  too_many_pages: 'Ce PDF a trop de pages pour être lu ici. Lisez-le vous-même.',
  inflate_limit: 'Ce PDF se décompresse en un volume démesuré : il n’est pas lu. Lisez-le vous-même.',
  too_complex: 'Ce PDF répète ses contenus de façon démesurée : il n’est pas lu. Lisez-le vous-même.',
  unreadable: 'Ce PDF est abîmé ou d’un format non pris en charge : son texte ne peut pas être lu. Lisez-le vous-même.',
};

/** Le texte de chaque page, prêt pour la prélecture : une page illisible devient une page vide, rien n'y sera retrouvé. */
export function pagesForReading(pages: readonly PdfPageText[]): string[] {
  return pages.map((p) => p.text ?? '');
}

/** Les numéros des pages à lire par l'agent. */
export function pagesToRead(pages: readonly PdfPageText[]): number[] {
  return pages.filter((p) => p.text === null).map((p) => p.page);
}

// ————— Valeurs du format —————

class Name {
  constructor(readonly v: string) {}
}
/** Une chaîne : ses octets, un caractère par octet. */
class Str {
  constructor(readonly v: string) {}
}
class Ref {
  constructor(
    readonly n: number,
    readonly g: number,
  ) {}
}
class Dict {
  constructor(readonly m: Map<string, Value>) {}
  get(k: string): Value | undefined {
    return this.m.get(k);
  }
}
class Stream {
  constructor(
    readonly dict: Dict,
    readonly raw: string,
  ) {}
}
class Op {
  constructor(readonly v: string) {}
}
type Value = null | boolean | number | Name | Str | Ref | Value[] | Dict | Stream;

class Broken extends Error {}
class TooBig extends Error {}
class TooComplex extends Error {}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

class Lexer {
  pos: number;
  constructor(
    readonly s: string,
    pos = 0,
  ) {
    this.pos = pos;
  }

  skipWs(): void {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++;
      } else break;
    }
  }

  regular(): string {
    const start = this.pos;
    while (this.pos < this.s.length) {
      const c = this.s.charCodeAt(this.pos);
      if (WS.has(c) || DELIM.has(c)) break;
      this.pos++;
    }
    return this.s.slice(start, this.pos);
  }

  /** Une valeur, ou un opérateur dans un flux de contenu ; null en fin de texte. */
  next(): Value | Op | undefined {
    this.skipWs();
    const s = this.s;
    if (this.pos >= s.length) return undefined;
    const ch = s[this.pos]!;
    if (ch === '/') {
      this.pos++;
      return new Name(this.regular().replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
    }
    if (ch === '(') return this.literal();
    if (ch === '<') {
      if (s[this.pos + 1] === '<') {
        this.pos += 2;
        return this.dict();
      }
      return this.hex();
    }
    if (ch === '[') {
      this.pos++;
      const out: Value[] = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= s.length) throw new Broken();
        if (s[this.pos] === ']') {
          this.pos++;
          return out;
        }
        const v = this.value();
        out.push(v);
      }
    }
    if (ch === ']' || ch === '>' || ch === ')' || ch === '{' || ch === '}') {
      this.pos++;
      return new Op(ch);
    }
    const word = this.regular();
    if (word === '') {
      this.pos++;
      return new Op(ch);
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const n = Number(word);
      // « n g R » : une référence.
      if (/^\d+$/.test(word)) {
        const save = this.pos;
        this.skipWs();
        const g = this.regular();
        if (/^\d+$/.test(g)) {
          this.skipWs();
          if (this.s[this.pos] === 'R' && (this.pos + 1 >= this.s.length || WS.has(this.s.charCodeAt(this.pos + 1)) || DELIM.has(this.s.charCodeAt(this.pos + 1)))) {
            this.pos++;
            return new Ref(n, Number(g));
          }
        }
        this.pos = save;
      }
      return n;
    }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new Op(word);
  }

  /** Une valeur, jamais un opérateur. */
  value(): Value {
    const v = this.next();
    if (v === undefined || v instanceof Op) throw new Broken();
    return v;
  }

  private dict(): Dict {
    const m = new Map<string, Value>();
    for (;;) {
      this.skipWs();
      if (this.pos >= this.s.length) throw new Broken();
      if (this.s.startsWith('>>', this.pos)) {
        this.pos += 2;
        return new Dict(m);
      }
      const k = this.next();
      if (!(k instanceof Name)) throw new Broken();
      m.set(k.v, this.value());
    }
  }

  private hex(): Str {
    const end = this.s.indexOf('>', this.pos);
    if (end < 0) throw new Broken();
    let h = this.s.slice(this.pos + 1, end).replace(/[\s\0]/g, '');
    this.pos = end + 1;
    if (!/^[0-9a-fA-F]*$/.test(h)) throw new Broken();
    if (h.length % 2) h += '0';
    let out = '';
    for (let i = 0; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
    return new Str(out);
  }

  private literal(): Str {
    const s = this.s;
    let depth = 1;
    let out = '';
    this.pos++;
    while (this.pos < s.length) {
      const c = s[this.pos++]!;
      if (c === '\\') {
        const e = s[this.pos++];
        if (e === undefined) break;
        if (e === 'n') out += '\n';
        else if (e === 'r') out += '\r';
        else if (e === 't') out += '\t';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === '\r') {
          if (s[this.pos] === '\n') this.pos++;
        } else if (e === '\n') {
          // Fin de ligne échappée : rien.
        } else if (e >= '0' && e <= '7') {
          let oct = e;
          while (oct.length < 3 && s[this.pos]! >= '0' && s[this.pos]! <= '7') oct += s[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else out += e;
      } else if (c === '(') {
        depth++;
        out += c;
      } else if (c === ')') {
        depth--;
        if (depth === 0) return new Str(out);
        out += c;
      } else if (c === '\r') {
        if (s[this.pos] === '\n') this.pos++;
        out += '\n';
      } else out += c;
    }
    throw new Broken();
  }
}

// ————— Le fichier —————

function latin1(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return out;
}

function toBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

class Budget {
  used = 0;
  constructor(readonly max: number) {}
}

/** Le travail de lecture du fichier : chaque élément de contenu lu, et chaque caractère rendu, le compte. */
class Work {
  used = 0;
  constructor(readonly max: number) {}
  charge(n: number): void {
    this.used += n;
    if (this.used > this.max) throw new TooComplex();
  }
}

/** Décompresse un flux Flate, dans la limite du budget du fichier ; null si le flux est abîmé. */
async function inflate(raw: string, budget: Budget): Promise<string | null> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(toBytes(raw)).catch(() => undefined);
  writer.close().catch(() => undefined);
  const parts: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.used += value.byteLength;
      if (budget.used > budget.max) {
        await reader.cancel().catch(() => undefined);
        throw new TooBig();
      }
      parts.push(latin1(value));
    }
  } catch (error) {
    if (error instanceof TooBig) throw error;
    return null;
  }
  return parts.join('');
}

class PdfFile {
  readonly objects = new Map<number, Value>();
  readonly trailers: Dict[] = [];
  /** Les objets en plusieurs versions dont aucune ne peut être dite en vigueur. */
  readonly ambiguous = new Set<number>();
  /** Vrai dès qu'une lecture a suivi une référence vers un objet ambigu. */
  touchedAmbiguous = false;
  private readonly decoded = new Map<Stream, string | null>();

  constructor(
    readonly src: string,
    readonly budget: Budget,
    readonly work: Work,
  ) {}

  scan(): void {
    const src = this.src;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const lx = new Lexer(src, m.index + m[0].length);
      let v: Value;
      try {
        v = lx.value();
      } catch {
        continue;
      }
      if (v instanceof Dict) {
        lx.skipWs();
        if (src.startsWith('stream', lx.pos)) {
          let start = lx.pos + 6;
          if (src[start] === '\r') start++;
          if (src[start] === '\n') start++;
          const len = v.get('Length');
          let end = -1;
          if (typeof len === 'number' && Number.isInteger(len) && len >= 0 && start + len <= src.length && /^\s*endstream/.test(src.slice(start + len, start + len + 20))) end = start + len;
          if (end < 0) {
            const e = src.indexOf('endstream', start);
            if (e < 0) continue;
            end = e;
            if (src[end - 1] === '\n') end--;
            if (src[end - 1] === '\r') end--;
          }
          v = new Stream(v, src.slice(start, end));
          re.lastIndex = end;
        } else re.lastIndex = lx.pos;
      } else re.lastIndex = lx.pos;
      this.objects.set(Number(m[1]), v);
    }
    const tr = /trailer\s*<</g;
    while ((m = tr.exec(src))) {
      try {
        const d = new Lexer(src, m.index + 7).value();
        if (d instanceof Dict) this.trailers.push(d);
      } catch {
        // Un trailer abîmé ne compte pas.
      }
    }
    for (const v of [...this.objects.values()]) if (v instanceof Stream && this.name(v.dict.get('Type')) === 'XRef') this.trailers.push(v.dict);
  }

  /** Les objets rangés dans les flux d'objets ; un objet écrit en clair garde la priorité. */
  async unpackObjectStreams(): Promise<void> {
    const direct = new Set(this.objects.keys());
    const packed = new Map<number, string>();
    for (const v of [...this.objects.values()]) {
      if (!(v instanceof Stream) || this.name(v.dict.get('Type')) !== 'ObjStm') continue;
      const data = await this.decode(v);
      if (data === null) continue;
      const n = this.get(v.dict.get('N'));
      const first = this.get(v.dict.get('First'));
      if (typeof n !== 'number' || typeof first !== 'number' || n < 0 || n > 100_000) continue;
      const head = new Lexer(data);
      const pairs: [number, number][] = [];
      try {
        for (let i = 0; i < n; i++) {
          const num = head.value();
          const off = head.value();
          if (typeof num !== 'number' || typeof off !== 'number') break;
          pairs.push([num, off]);
        }
      } catch {
        continue;
      }
      const sorted = [...pairs].sort((a, b) => a[1] - b[1]);
      for (const [num, off] of pairs) {
        const next = sorted.find((p) => p[1] > off)?.[1] ?? data.length;
        const text = data.slice(first + off, first + next).trim();
        const seen = packed.get(num);
        // Deux versions d'un même objet, l'une en clair et l'autre compressée, ou dans deux flux différents : sans la
        // table des références, rien ne dit laquelle est en vigueur. Lecture prudente : l'objet est ambigu.
        if (direct.has(num) || (seen !== undefined && seen !== text)) {
          this.ambiguous.add(num);
          continue;
        }
        packed.set(num, text);
        try {
          this.objects.set(num, new Lexer(data, first + off).value());
        } catch {
          // Un objet abîmé ne compte pas.
        }
      }
    }
  }

  get(v: Value | undefined, depth = 0): Value | undefined {
    if (v instanceof Ref) {
      if (depth > 16) return undefined;
      if (this.ambiguous.has(v.n)) this.touchedAmbiguous = true;
      return this.get(this.objects.get(v.n), depth + 1);
    }
    return v;
  }

  dict(v: Value | undefined): Dict | null {
    const d = this.get(v);
    if (d instanceof Dict) return d;
    if (d instanceof Stream) return d.dict;
    return null;
  }

  name(v: Value | undefined): string | null {
    const n = this.get(v);
    return n instanceof Name ? n.v : null;
  }

  /** Le contenu d'un flux, filtres appliqués ; null si un filtre n'est pas lu ou si le flux est abîmé. */
  async decode(s: Stream): Promise<string | null> {
    if (this.decoded.has(s)) return this.decoded.get(s)!;
    let out: string | null = s.raw;
    const f = this.get(s.dict.get('Filter'));
    const filters = f === undefined || f === null ? [] : Array.isArray(f) ? f.map((x) => this.name(x)) : [this.name(f)];
    const parms = this.get(s.dict.get('DecodeParms'));
    for (let i = 0; i < filters.length && out !== null; i++) {
      const p = this.dict(Array.isArray(parms) ? parms[i] : parms);
      const predictor = p ? this.get(p.get('Predictor')) : undefined;
      if ((filters[i] === 'FlateDecode' || filters[i] === 'Fl') && (predictor === undefined || predictor === 1)) out = await inflate(out, this.budget);
      else out = null;
    }
    this.decoded.set(s, out);
    return out;
  }

  encrypted(): boolean {
    return this.trailers.some((t) => t.get('Encrypt') !== undefined);
  }

  catalog(): Dict | null {
    for (let i = this.trailers.length - 1; i >= 0; i--) {
      const root = this.dict(this.trailers[i]!.get('Root'));
      if (root && this.dict(root.get('Pages'))) return root;
    }
    let found: Dict | null = null;
    for (const v of this.objects.values()) if (v instanceof Dict && this.name(v.get('Type')) === 'Catalog' && this.dict(v.get('Pages'))) found = v;
    return found;
  }
}

// ————— Les polices —————

/** WinAnsi : Latin-1, plus les signes de 0x80 à 0x9F. */
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function winAnsi(code: number): string | null {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return ' ';
  if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);
  if (code >= 0xa0 && code <= 0xff) return String.fromCharCode(code);
  return WIN_ANSI_HIGH[code] ?? null;
}

/** Codage standard d'Adobe : seule la partie sûre (ASCII, sauf les deux apostrophes). */
function standardAscii(code: number): string | null {
  if (code === 0x27) return '’';
  if (code === 0x60) return '‘';
  if (code === 0x20 || (code > 0x20 && code <= 0x7e)) return String.fromCharCode(code);
  return null;
}

const GLYPH_NAMES: Record<string, string> = {
  space: ' ', nbspace: ' ', period: '.', comma: ',', colon: ':', semicolon: ';', hyphen: '-', minus: '−', endash: '–', emdash: '—',
  parenleft: '(', parenright: ')', bracketleft: '[', bracketright: ']', slash: '/', percent: '%', ampersand: '&', at: '@', numbersign: '#',
  dollar: '$', Euro: '€', euro: '€', quotesingle: "'", quoteright: '’', quoteleft: '‘', quotedbl: '"', quotedblleft: '“', quotedblright: '”',
  guillemotleft: '«', guillemotright: '»', exclam: '!', question: '?', asterisk: '*', plus: '+', equal: '=', less: '<', greater: '>',
  underscore: '_', degree: '°', section: '§', ellipsis: '…', bullet: '•', ordmasculine: 'º', ordfeminine: 'ª', twosuperior: '²', threesuperior: '³',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  eacute: 'é', egrave: 'è', ecircumflex: 'ê', edieresis: 'ë', agrave: 'à', aacute: 'á', acircumflex: 'â', adieresis: 'ä', ccedilla: 'ç',
  ugrave: 'ù', uacute: 'ú', ucircumflex: 'û', udieresis: 'ü', icircumflex: 'î', idieresis: 'ï', iacute: 'í', ocircumflex: 'ô', odieresis: 'ö', oacute: 'ó',
  ydieresis: 'ÿ', oe: 'œ', ae: 'æ', fi: 'fi', fl: 'fl',
  Eacute: 'É', Egrave: 'È', Ecircumflex: 'Ê', Edieresis: 'Ë', Agrave: 'À', Acircumflex: 'Â', Adieresis: 'Ä', Ccedilla: 'Ç', Ugrave: 'Ù',
  Ucircumflex: 'Û', Udieresis: 'Ü', Icircumflex: 'Î', Idieresis: 'Ï', Ocircumflex: 'Ô', Odieresis: 'Ö', Ydieresis: 'Ÿ', OE: 'Œ', AE: 'Æ',
};

function glyph(name: string): string | null {
  if (/^[A-Za-z]$/.test(name)) return name;
  if (name in GLYPH_NAMES) return GLYPH_NAMES[name]!;
  const uni = /^uni([0-9A-F]{4})$/.exec(name);
  if (uni) {
    const c = parseInt(uni[1]!, 16);
    return c < 0xd800 || c > 0xdfff ? String.fromCharCode(c) : null;
  }
  return null;
}

/** Les polices standard, nom exact : seules elles, non incorporées et sans encodage, sont lues au codage standard. */
const STANDARD_FONTS = /^(Helvetica(-Bold|-Oblique|-BoldOblique)?|Times-(Roman|Bold|Italic|BoldItalic)|Courier(-Bold|-Oblique|-BoldOblique)?|Arial(MT)?(,(Bold|Italic|BoldItalic))?|TimesNewRoman(PSMT)?(,(Bold|Italic|BoldItalic))?)$/;

interface FontDecoder {
  /** Le texte d'une chaîne, ou null s'il ne se décode pas avec certitude. */
  decode(bytes: string): string | null;
}

const NO_DECODER: FontDecoder = { decode: () => null };

function utf16be(bytes: string): string | null {
  if (bytes.length % 2) return null;
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
  return out;
}

function codeOf(bytes: string): number {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) n = n * 256 + bytes.charCodeAt(i);
  return n;
}

interface CMap {
  ranges: { len: number; lo: number; hi: number }[];
  map: Map<string, string>;
}

function parseCMap(data: string, work: Work): CMap | null {
  const lx = new Lexer(data);
  const ranges: CMap['ranges'] = [];
  const map = new Map<string, string>();
  const stack: (Value | Op)[] = [];
  try {
    for (;;) {
      const t = lx.next();
      if (t === undefined) break;
      work.charge(1);
      if (!(t instanceof Op)) {
        stack.push(t);
        continue;
      }
      if (t.v === 'endcodespacerange') {
        for (let i = 0; i + 1 < stack.length; i += 2) {
          const lo = stack[i];
          const hi = stack[i + 1];
          if (lo instanceof Str && hi instanceof Str && lo.v.length === hi.v.length && lo.v.length >= 1 && lo.v.length <= 4) ranges.push({ len: lo.v.length, lo: codeOf(lo.v), hi: codeOf(hi.v) });
        }
      } else if (t.v === 'endbfchar') {
        work.charge(stack.length);
        for (let i = 0; i + 1 < stack.length; i += 2) {
          const src = stack[i];
          const dst = stack[i + 1];
          if (!(src instanceof Str) || !(dst instanceof Str)) continue;
          const u = utf16be(dst.v);
          if (u !== null) map.set(`${src.v.length}:${codeOf(src.v)}`, u);
        }
      } else if (t.v === 'endbfrange') {
        for (let i = 0; i + 2 < stack.length; i += 3) {
          const lo = stack[i];
          const hi = stack[i + 1];
          const dst = stack[i + 2];
          if (!(lo instanceof Str) || !(hi instanceof Str) || lo.v.length !== hi.v.length) continue;
          const a = codeOf(lo.v);
          const b = codeOf(hi.v);
          if (b < a || b - a > 65_535) continue;
          work.charge(b - a + 1);
          for (let c = a; c <= b; c++) {
            let u: string | null = null;
            if (Array.isArray(dst)) {
              const d = dst[c - a];
              u = d instanceof Str ? utf16be(d.v) : null;
            } else if (dst instanceof Str) {
              const base = utf16be(dst.v);
              if (base !== null && base.length >= 1) u = base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - a));
            }
            if (u !== null) map.set(`${lo.v.length}:${c}`, u);
          }
        }
      }
      stack.length = 0;
    }
  } catch (error) {
    if (error instanceof TooComplex) throw error;
    return null;
  }
  return { ranges, map };
}

function cmapDecoder(cmap: CMap, defaultLen: number, fallback: ((code: number) => string | null) | null): FontDecoder {
  const lens = [...new Set(cmap.ranges.map((r) => r.len))].sort((a, b) => a - b);
  return {
    decode(bytes) {
      let out = '';
      let i = 0;
      while (i < bytes.length) {
        let len = 0;
        for (const l of lens) {
          if (i + l > bytes.length) break;
          const c = codeOf(bytes.slice(i, i + l));
          if (cmap.ranges.some((r) => r.len === l && c >= r.lo && c <= r.hi)) {
            len = l;
            break;
          }
        }
        if (len === 0) len = lens.length > 0 ? -1 : defaultLen;
        if (len < 0 || i + len > bytes.length) return null;
        const code = codeOf(bytes.slice(i, i + len));
        const u = cmap.map.get(`${len}:${code}`) ?? (len === 1 && fallback ? fallback(code) : null);
        if (u === null) return null;
        out += u;
        i += len;
      }
      return out;
    },
  };
}

function simpleTable(file: PdfFile, font: Dict): ((code: number) => string | null) | null {
  const base = file.name(font.get('BaseFont'))?.replace(/^[A-Z]{6}\+/, '') ?? '';
  if (/Symbol|Dingbats|Wingdings/i.test(base)) return null;
  const enc = file.get(font.get('Encoding'));
  const descriptor = file.dict(font.get('FontDescriptor'));
  const embedded = descriptor !== null && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => descriptor.get(k) !== undefined);
  const baseTable = (name: string | null): ((code: number) => string | null) | null => {
    if (name === 'WinAnsiEncoding') return winAnsi;
    if (name === 'StandardEncoding') return standardAscii;
    if (name === 'MacRomanEncoding') return (code) => (code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : null);
    // Sans encodage : une police incorporée garde son propre codage, inconnu ici ; seule une police standard non incorporée est lue.
    if (name === null) return !embedded && STANDARD_FONTS.test(base) ? standardAscii : null;
    return null;
  };
  if (enc === undefined || enc === null) return baseTable(null);
  if (enc instanceof Name) return baseTable(enc.v);
  if (enc instanceof Dict) {
    const baseName = file.name(enc.get('BaseEncoding'));
    const table = baseTable(baseName);
    const diffs = file.get(enc.get('Differences'));
    const override = new Map<number, string | null>();
    if (Array.isArray(diffs)) {
      let code = -1;
      for (const d of diffs) {
        const v = file.get(d);
        if (typeof v === 'number') code = v;
        else if (v instanceof Name && code >= 0) override.set(code++, glyph(v.v));
      }
    }
    return (code) => (override.has(code) ? override.get(code)! : table ? table(code) : null);
  }
  return null;
}

async function fontDecoder(file: PdfFile, fontValue: Value | undefined): Promise<FontDecoder> {
  const font = file.dict(fontValue);
  if (!font) return NO_DECODER;
  const subtype = file.name(font.get('Subtype'));
  const composite = subtype === 'Type0';
  if (subtype === 'Type3') return NO_DECODER;
  const fallback = composite ? null : simpleTable(file, font);
  const tu = font.get('ToUnicode') === undefined ? undefined : file.get(font.get('ToUnicode'));
  if (tu !== undefined) {
    // Une table donnée mais illisible ne cède jamais au codage de base : le texte pourrait différer du document.
    if (!(tu instanceof Stream)) return NO_DECODER;
    const data = await file.decode(tu);
    const cmap = data === null ? null : parseCMap(data, file.work);
    if (!cmap || cmap.map.size === 0) return NO_DECODER;
    return cmapDecoder(cmap, composite ? 2 : 1, fallback);
  }
  if (composite || !fallback) return NO_DECODER;
  return {
    decode(bytes) {
      let out = '';
      for (let i = 0; i < bytes.length; i++) {
        const u = fallback(bytes.charCodeAt(i));
        if (u === null) return null;
        out += u;
      }
      return out;
    },
  };
}

// ————— Les pages —————

interface PageState {
  lines: string[];
  line: string;
  lineY: number | null;
  moved: boolean;
  shown: number;
  undecodable: boolean;
}

const MAX_FORM_DEPTH = 4;

async function readContent(file: PdfFile, content: string, resources: Dict | null, st: PageState, depth: number, forms: Set<Stream>): Promise<void> {
  const fonts = resources ? file.dict(resources.get('Font')) : null;
  const xobjects = resources ? file.dict(resources.get('XObject')) : null;
  const states = resources ? file.dict(resources.get('ExtGState')) : null;
  const decoders = new Map<string, FontDecoder>();
  let font: FontDecoder = NO_DECODER;
  const saved: FontDecoder[] = [];
  let tm = [1, 0, 0, 1, 0, 0];
  let lm = [1, 0, 0, 1, 0, 0];
  const lx = new Lexer(content);
  let operands: Value[] = [];

  const newline = () => {
    st.lines.push(st.line);
    st.line = '';
    st.moved = false;
  };
  const place = () => {
    const y = tm[5]!;
    if (st.lineY !== null && Math.abs(y - st.lineY) > 1) newline();
    else if (st.moved && st.line !== '' && !st.line.endsWith(' ')) st.line += ' ';
    st.lineY = y;
    st.moved = false;
  };
  const show = (s: Str) => {
    const t = font.decode(s.v);
    st.shown++;
    if (t === null) {
      st.undecodable = true;
      return;
    }
    file.work.charge(t.length);
    st.line += t;
  };
  const moveTo = (tx: number, ty: number) => {
    lm = [lm[0]!, lm[1]!, lm[2]!, lm[3]!, tx * lm[0]! + ty * lm[2]! + lm[4]!, tx * lm[1]! + ty * lm[3]! + lm[5]!];
    tm = [...lm];
    st.moved = true;
  };
  const nextLine = () => {
    newline();
    st.lineY = null;
  };

  for (;;) {
    const t = lx.next();
    if (t === undefined) break;
    file.work.charge(1);
    if (!(t instanceof Op)) {
      operands.push(t);
      if (operands.length > 64) operands = operands.slice(-64);
      continue;
    }
    const nums = operands.filter((o): o is number => typeof o === 'number');
    switch (t.v) {
      case 'q':
        if (saved.length > 256) throw new Broken();
        saved.push(font);
        break;
      case 'Q':
        font = saved.pop() ?? font;
        break;
      case 'BT':
        tm = [1, 0, 0, 1, 0, 0];
        lm = [1, 0, 0, 1, 0, 0];
        st.moved = true;
        break;
      case 'Tf': {
        const n = operands.find((o): o is Name => o instanceof Name);
        if (n) {
          if (!decoders.has(n.v)) decoders.set(n.v, await fontDecoder(file, fonts?.get(n.v)));
          font = decoders.get(n.v)!;
        } else font = NO_DECODER;
        break;
      }
      case 'gs': {
        // Un état graphique peut choisir la police : elle est appliquée, ou la page est illisible.
        const n = operands[operands.length - 1];
        const g = n instanceof Name && states ? file.dict(states.get(n.v)) : null;
        if (!g) break;
        const f = g.get('Font');
        if (f === undefined) break;
        const arr = file.get(f);
        const key = `gs:${(n as Name).v}`;
        if (!decoders.has(key)) decoders.set(key, Array.isArray(arr) && arr.length >= 1 ? await fontDecoder(file, arr[0]) : NO_DECODER);
        font = decoders.get(key)!;
        break;
      }
      case 'Td':
      case 'TD':
        if (nums.length >= 2) moveTo(nums[nums.length - 2]!, nums[nums.length - 1]!);
        break;
      case 'Tm':
        if (nums.length >= 6) {
          lm = nums.slice(-6);
          tm = [...lm];
          st.moved = true;
        }
        break;
      case 'T*':
        nextLine();
        break;
      case 'Tj': {
        const s = operands[operands.length - 1];
        if (s instanceof Str) {
          place();
          show(s);
        }
        break;
      }
      case "'":
      case '"': {
        const s = operands[operands.length - 1];
        nextLine();
        if (s instanceof Str) {
          place();
          show(s);
        }
        break;
      }
      case 'TJ': {
        const arr = operands[operands.length - 1];
        if (Array.isArray(arr)) {
          place();
          for (const e of arr) {
            if (e instanceof Str) show(e);
            else if (typeof e === 'number' && e < -200 && st.line !== '' && !st.line.endsWith(' ')) st.line += ' ';
          }
        }
        break;
      }
      case 'BI': {
        // Image en ligne : ses octets ne sont pas du contenu.
        const id = /\sID[\s]/g;
        id.lastIndex = lx.pos;
        const m = id.exec(content);
        if (!m) throw new Broken();
        const ei = /\sEI(?=[\s]|$)/g;
        ei.lastIndex = m.index + m[0].length;
        const e = ei.exec(content);
        if (!e) throw new Broken();
        lx.pos = e.index + e[0].length;
        break;
      }
      case 'Do': {
        const n = operands[operands.length - 1];
        if (!(n instanceof Name) || !xobjects) break;
        const x = file.get(xobjects.get(n.v));
        if (!(x instanceof Stream) || file.name(x.dict.get('Subtype')) !== 'Form') break;
        if (depth >= MAX_FORM_DEPTH || forms.has(x)) {
          st.undecodable = true;
          break;
        }
        const data = await file.decode(x);
        if (data === null) {
          st.undecodable = true;
          break;
        }
        forms.add(x);
        const saved = st.lineY;
        await readContent(file, data, file.dict(x.dict.get('Resources')) ?? resources, st, depth + 1, forms);
        forms.delete(x);
        st.lineY = saved;
        st.moved = true;
        break;
      }
      default:
        break;
    }
    operands = [];
  }
}

function tidy(lines: string[]): string {
  return lines
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n')
    .normalize('NFC');
}

async function pageText(file: PdfFile, page: Dict, resources: Dict | null, n: number): Promise<PdfPageText> {
  const c = file.get(page.get('Contents'));
  const parts = Array.isArray(c) ? c.map((x) => file.get(x)) : c === undefined || c === null ? [] : [c];
  const chunks: string[] = [];
  for (const p of parts) {
    if (!(p instanceof Stream)) return { page: n, text: null, reason: 'undecodable' };
    const d = await file.decode(p);
    if (d === null) return { page: n, text: null, reason: 'undecodable' };
    chunks.push(d);
  }
  const st: PageState = { lines: [], line: '', lineY: null, moved: false, shown: 0, undecodable: false };
  if (file.touchedAmbiguous) return { page: n, text: null, reason: 'undecodable' };
  try {
    await readContent(file, chunks.join('\n'), resources, st, 0, new Set());
  } catch (error) {
    if (error instanceof TooBig || error instanceof TooComplex) throw error;
    return { page: n, text: null, reason: 'undecodable' };
  }
  st.lines.push(st.line);
  if (st.undecodable || file.touchedAmbiguous) return { page: n, text: null, reason: 'undecodable' };
  const text = tidy(st.lines);
  if (text === '') return { page: n, text: null, reason: 'no_text' };
  return { page: n, text };
}

class TooManyPages extends Error {}

interface FoundPage {
  page: Dict;
  resources: Dict | null;
  /** La page, ou ses ressources héritées, lues à travers un objet ambigu. */
  ambiguous: boolean;
}

function collectPages(file: PdfFile, node: Dict, resources: Dict | null, inherited: boolean, out: FoundPage[], seen: Set<Dict>, max: number, depth: number): void {
  if (seen.has(node) || depth > 64) throw new Broken();
  seen.add(node);
  file.touchedAmbiguous = false;
  const res = file.dict(node.get('Resources')) ?? resources;
  const kids = file.get(node.get('Kids'));
  const type = file.name(node.get('Type'));
  const ambiguous = inherited || file.touchedAmbiguous;
  if (type === 'Page' || (type === null && !Array.isArray(kids))) {
    out.push({ page: node, resources: res, ambiguous });
    if (out.length > max) throw new TooManyPages();
    return;
  }
  // Une liste de pages lue à travers un objet ambigu ne dit pas quelles pages sont en vigueur : refusé.
  if (!Array.isArray(kids) || ambiguous) throw new Broken();
  for (const k of kids) {
    file.touchedAmbiguous = false;
    const d = file.dict(k);
    if (!d) throw new Broken();
    collectPages(file, d, res, ambiguous || file.touchedAmbiguous, out, seen, max, depth + 1);
  }
}

/** Le texte de chaque page d'un PDF, dans l'ordre de ses pages. */
export async function pdfPagesText(bytes: Uint8Array, limits: Partial<PdfLimits> = {}): Promise<{ ok: true; value: { pages: PdfPageText[] } } | PdfTextRefusal> {
  const lim: PdfLimits = { ...PDF_LIMITS, ...limits };
  const refuse = (code: PdfTextRefusalCode): PdfTextRefusal => ({ ok: false, rule: null, code });
  if (!(bytes instanceof Uint8Array)) return refuse('not_pdf');
  if (bytes.length > lim.maxBytes) return refuse('too_large');
  const headAt = latin1(bytes.subarray(0, 1024)).indexOf('%PDF-');
  if (headAt < 0) return refuse('not_pdf');
  try {
    const file = new PdfFile(latin1(bytes), new Budget(lim.maxInflatedBytes), new Work(lim.maxWork));
    file.scan();
    if (file.encrypted()) return refuse('encrypted');
    await file.unpackObjectStreams();
    if (file.encrypted()) return refuse('encrypted');
    const catalog = file.catalog();
    const root = catalog ? file.dict(catalog.get('Pages')) : null;
    if (!root) return refuse('unreadable');
    if (file.touchedAmbiguous) return refuse('unreadable');
    const found: FoundPage[] = [];
    collectPages(file, root, null, false, found, new Set(), lim.maxPages, 0);
    if (found.length === 0) return refuse('unreadable');
    const pages: PdfPageText[] = [];
    for (let i = 0; i < found.length; i++) {
      const f = found[i]!;
      file.touchedAmbiguous = false;
      pages.push(f.ambiguous ? { page: i + 1, text: null, reason: 'undecodable' } : await pageText(file, f.page, f.resources, i + 1));
    }
    return { ok: true, value: { pages } };
  } catch (error) {
    if (error instanceof TooBig) return refuse('inflate_limit');
    if (error instanceof TooComplex) return refuse('too_complex');
    if (error instanceof TooManyPages) return refuse('too_many_pages');
    return refuse('unreadable');
  }
}
