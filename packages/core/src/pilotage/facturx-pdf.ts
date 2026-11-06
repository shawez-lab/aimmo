/**
 * La facture Factur-X complète : un PDF/A-3b lisible qui porte le XML EN 16931 de HX04 (HX60) [R254, R256].
 *
 * Le PDF est tiré du XML rangé et de lui seul : chaque nom, adresse, date et montant imprimé est relu dans le XML, et
 * le XML joint (`factur-x.xml`, relation `Data`) est l'octet près celui qui est rangé. Le PDF ne peut donc jamais dire
 * autre chose que la facture électronique qui fait foi.
 *
 * Décidé, lecture prudente : écrit à la main, sans dépendance (rien de lourd dans le Worker) ; police Poppins intégrée,
 * réduite aux caractères WinAnsi ; un caractère hors de cette police (un nom en alphabet arabe, par exemple) n'est
 * jamais remplacé par un autre : le PDF n'est pas écrit et le manque est dit, le XML seul reste valable ; profil de
 * couleurs sRGB écrit par le code (courbe IEC 61966-2.1 en table, primaires adaptées à D50) ; aucun flux compressé,
 * aucune date de l'horloge : la même facture donne toujours le même PDF, octet pour octet.
 */
import { POPPINS_BOLD, POPPINS_REGULAR, type PoliceFacture } from './facturx-police.ts';

export const FACTURX_FILENAME = 'factur-x.xml';
const FX_NS = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';

export type PdfFacturX = { ok: true; pdf: Uint8Array } | { ok: false; missing: string[] };

interface Adresse {
  line1: string;
  line2: string | null;
  postcode: string;
  city: string;
  country: string;
}

interface Partie {
  name: string;
  siren: string | null;
  vatId: string | null;
  address: Adresse;
}

/** Ce que le PDF imprime, relu dans le XML. Les montants restent les chaînes du XML : rien n'est recalculé. */
export interface VueFacturX {
  id: string;
  typeCode: '380' | '381';
  issuedOn: string;
  notes: string[];
  designation: string;
  seller: Partie;
  buyer: Partie;
  deliveryOn: string | null;
  rate: string;
  exemptionReason: string | null;
  paymentTerms: string;
  ht: string;
  vat: string;
  ttc: string;
  due: string;
  corrects: string | null;
}

/**
 * Un texte du XML, ses entités rendues ; tout espacement (tabulation, saut de ligne, espace fine, espace
 * idéographique…) s'imprime en espace simple, l'espace insécable restant insécable : la police n'a qu'eux deux.
 */
const unesc = (v: string): string =>
  v
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[^\S\u00a0]/g, ' ');

const first = (xml: string, tag: string): string | null => {
  const m = new RegExp(`<ram:${tag}(?: [^>]*)?>([^<]*)</ram:${tag}>`).exec(xml);
  return m ? unesc(m[1]!) : null;
};

const between = (xml: string, tag: string): string | null => {
  const start = xml.indexOf(`<ram:${tag}>`);
  const end = xml.indexOf(`</ram:${tag}>`, start);
  return start < 0 || end < 0 ? null : xml.slice(start, end);
};

const day102 = (v: string | null): string | null => (v && /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);

function partie(block: string | null): Partie | null {
  if (!block) return null;
  const name = first(block, 'Name');
  const addr = between(block, 'PostalTradeAddress');
  if (!name || !addr) return null;
  const line1 = first(addr, 'LineOne');
  const postcode = first(addr, 'PostcodeCode');
  const city = first(addr, 'CityName');
  const country = first(addr, 'CountryID');
  if (!line1 || !postcode || !city || !country) return null;
  const legal = between(block, 'SpecifiedLegalOrganization');
  const tax = between(block, 'SpecifiedTaxRegistration');
  return { name, siren: legal ? first(legal, 'ID') : null, vatId: tax ? first(tax, 'ID') : null, address: { line1, line2: first(addr, 'LineTwo'), postcode, city, country } };
}

/** Relit dans le XML EN 16931 de HX04 tout ce que le PDF imprime ; `null` si le XML n'est pas l'un des nôtres. */
export function vueFacturX(xml: string): VueFacturX | null {
  const doc = /<rsm:ExchangedDocument>([\s\S]*?)<\/rsm:ExchangedDocument>/.exec(xml)?.[1] ?? '';
  const id = /<rsm:ExchangedDocument>\s*<ram:ID>([^<]*)<\/ram:ID>/.exec(xml)?.[1];
  const typeCode = /<rsm:ExchangedDocument>[\s\S]*?<ram:TypeCode>(38[01])<\/ram:TypeCode>/.exec(xml)?.[1] as '380' | '381' | undefined;
  const issuedOn = day102(/<ram:IssueDateTime><udt:DateTimeString format="102">(\d{8})</.exec(xml)?.[1] ?? null);
  const line = between(xml, 'IncludedSupplyChainTradeLineItem');
  const designation = line ? first(line, 'Name') : null;
  const seller = partie(between(xml, 'SellerTradeParty'));
  const buyer = partie(between(xml, 'BuyerTradeParty'));
  const settlement = xml.split('<ram:ApplicableHeaderTradeSettlement>')[1] ?? '';
  const tax = between(settlement, 'ApplicableTradeTax');
  const terms = between(settlement, 'SpecifiedTradePaymentTerms');
  const sums = between(settlement, 'SpecifiedTradeSettlementHeaderMonetarySummation');
  const delivery = between(xml, 'ApplicableHeaderTradeDelivery');
  const referenced = between(settlement, 'InvoiceReferencedDocument');
  const rate = tax ? first(tax, 'RateApplicablePercent') : null;
  const paymentTerms = terms ? first(terms, 'Description') : null;
  const ht = sums ? first(sums, 'TaxBasisTotalAmount') : null;
  const vat = sums ? first(sums, 'TaxTotalAmount') : null;
  const ttc = sums ? first(sums, 'GrandTotalAmount') : null;
  const due = sums ? first(sums, 'DuePayableAmount') : null;
  if (!id || !typeCode || !issuedOn || !designation || !seller || !buyer || !rate || !paymentTerms || !ht || !vat || !ttc || !due) return null;
  const notes = [...doc.matchAll(/<ram:IncludedNote><ram:Content>([^<]*)<\/ram:Content><\/ram:IncludedNote>/g)].map((m) => unesc(m[1]!));
  return {
    id: unesc(id),
    typeCode,
    issuedOn,
    notes,
    designation,
    seller,
    buyer,
    deliveryOn: delivery ? day102(/<udt:DateTimeString format="102">(\d{8})</.exec(delivery)?.[1] ?? null) : null,
    rate,
    exemptionReason: tax ? first(tax, 'ExemptionReason') : null,
    paymentTerms,
    ht,
    vat,
    ttc,
    due,
    corrects: referenced ? first(referenced, 'IssuerAssignedID') : null,
  };
}

// --- Texte et police -------------------------------------------------------------------------------------------

/** Les codes 0x80 à 0x9F de WinAnsiEncoding ; 0x81, 0x8D, 0x8F, 0x90 et 0x9D n'existent pas. */
const WIN_ANSI_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Le code WinAnsi d'un caractère, ou `null` s'il n'est pas dans la police intégrée. */
function winAnsi(ch: string): number | null {
  const u = ch.codePointAt(0)!;
  if (u >= 0x20 && u <= 0x7e) return u;
  if (u >= 0xa0 && u <= 0xff) return u;
  return WIN_ANSI_HIGH[u] ?? null;
}

/** Les caractères d'un texte que la police intégrée n'a pas, dans l'ordre, sans doublon. */
export function horsPolice(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    const code = winAnsi(ch);
    const name = `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
    if ((code === null || POPPINS_REGULAR.widths[code - 32] === 0 || POPPINS_BOLD.widths[code - 32] === 0) && !out.includes(name)) out.push(name);
  }
  return out;
}

const encode = (text: string): number[] => [...text].map((ch) => winAnsi(ch)!);

const widthOf = (font: PoliceFacture, text: string, size: number): number =>
  encode(text).reduce((sum, code) => sum + font.widths[code - 32]!, 0) * (size / 1000);

/** Coupe un texte aux espaces pour tenir dans `max` points ; un mot trop long est coupé où il faut. */
function wrap(font: PoliceFacture, text: string, size: number, max: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let current = '';
    for (const word of paragraph.split(/ +/).filter((w) => w.length > 0)) {
      const candidate = current ? `${current} ${word}` : word;
      if (widthOf(font, candidate, size) <= max) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = '';
      let rest = word;
      while (widthOf(font, rest, size) > max) {
        let cut = rest.length - 1;
        while (cut > 1 && widthOf(font, rest.slice(0, cut), size) > max) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      current = rest;
    }
    lines.push(current);
  }
  return lines;
}

/** Un montant du XML (`8333.33`) à la française : `8 333,33 €`, avec des espaces insécables. */
export function montantImprime(v: string): string {
  const [whole, cents] = v.split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped},${cents} €`;
}

const dateImprimee = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

// --- Mise en page --------------------------------------------------------------------------------------------------

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const INK = '0.106 0.122 0.157';
const MUTED = '0.40 0.43 0.48';
const ACCENT = '0.09 0.32 0.30';

type Face = 'R' | 'B';
const FACES: Record<Face, PoliceFacture> = { R: POPPINS_REGULAR, B: POPPINS_BOLD };

class Pages {
  readonly pages: string[][] = [[]];
  y = PAGE_H - MARGIN;

  get ops(): string[] {
    return this.pages[this.pages.length - 1]!;
  }

  /** Assure `h` points sous le curseur, sinon ouvre une page. */
  room(h: number): void {
    if (this.y - h >= MARGIN + 40) return;
    this.pages.push([]);
    this.y = PAGE_H - MARGIN;
  }

  text(x: number, y: number, s: string, face: Face, size: number, color = INK): void {
    const hex = encode(s).map((c) => c.toString(16).padStart(2, '0')).join('');
    this.ops.push(`BT /F${face} ${size} Tf ${color} rg ${x.toFixed(2)} ${y.toFixed(2)} Td <${hex}> Tj ET`);
  }

  right(xRight: number, y: number, s: string, face: Face, size: number, color = INK): void {
    this.text(xRight - widthOf(FACES[face], s, size), y, s, face, size, color);
  }

  /** Le filet d'accent en tête de la première page. */
  ops0(left: number, right: number): void {
    this.pages[0]!.push(`${ACCENT} rg ${left} ${(PAGE_H - MARGIN + 14).toFixed(2)} ${(right - left).toFixed(2)} 3 re f`);
  }

  rule(x1: number, x2: number, y: number, width = 0.6, color = MUTED): void {
    this.ops.push(`${color} RG ${width} w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S`);
  }

  /** Un paragraphe coupé à la largeur, ligne par ligne, avec saut de page si besoin. */
  paragraph(x: number, s: string, face: Face, size: number, max: number, color = INK): void {
    for (const line of wrap(FACES[face], s, size, max)) {
      this.room(size * 1.5);
      this.y -= size * 1.45;
      this.text(x, this.y, line, face, size, color);
    }
  }
}

function adresseLignes(p: Partie): string[] {
  const a = p.address;
  return [a.line1, ...(a.line2 ? [a.line2] : []), `${a.postcode} ${a.city}${a.country === 'FR' ? '' : ` (${a.country})`}`];
}

function layout(v: VueFacturX): string[][] {
  const p = new Pages();
  const left = MARGIN;
  const rightEdge = PAGE_W - MARGIN;
  const avoir = v.typeCode === '381';

  // En-tête : l'émetteur à gauche, la nature et le numéro à droite, chacun coupé à la largeur de sa colonne.
  p.ops0(left, rightEdge);
  const sellerW = (rightEdge - left) * 0.56;
  const headW = rightEdge - left - sellerW - 24;
  /** Écrit un texte coupé à `max`, ligne après ligne, aligné à gauche en `x` ou à droite sur `x` ; rend le nouveau `y`. */
  const block = (x: number, y0: number, s: string, face: Face, size: number, max: number, step: number, color = INK, alignRight = false): number => {
    let y = y0;
    wrap(FACES[face], s, size, max).forEach((line, i) => {
      if (i > 0) y -= step;
      if (alignRight) p.right(x, y, line, face, size, color);
      else p.text(x, y, line, face, size, color);
    });
    return y;
  };
  let y = block(left, PAGE_H - MARGIN - 14, v.seller.name, 'B', 13, sellerW, 16);
  for (const l of [...adresseLignes(v.seller), ...(v.seller.siren ? [`SIREN ${v.seller.siren}`] : []), ...(v.seller.vatId ? [`TVA ${v.seller.vatId}`] : [])]) {
    y = block(left, y - 13, l, 'R', 9, sellerW, 12, MUTED);
  }
  let ry = PAGE_H - MARGIN - 18;
  p.right(rightEdge, ry, avoir ? 'Avoir' : 'Facture', 'B', 22, ACCENT);
  ry = block(rightEdge, ry - 18, `N° ${v.id}`, 'B', 10, headW, 13, INK, true);
  ry = block(rightEdge, ry - 14, `Émise le ${dateImprimee(v.issuedOn)}`, 'R', 9, headW, 12, MUTED, true);
  if (v.deliveryOn) ry = block(rightEdge, ry - 13, `Acte du ${dateImprimee(v.deliveryOn)}`, 'R', 9, headW, 12, MUTED, true);
  if (avoir && v.corrects) ry = block(rightEdge, ry - 13, `Corrige la facture ${v.corrects}`, 'R', 9, headW, 12, MUTED, true);
  p.y = Math.min(y, ry) - 34;

  // Le client, coupé à la largeur de la page.
  const fullW = rightEdge - left;
  p.text(left, p.y, 'Facturé à', 'B', 8, ACCENT);
  p.y = block(left, p.y - 15, v.buyer.name, 'B', 11, fullW, 14);
  for (const l of [...adresseLignes(v.buyer), ...(v.buyer.siren ? [`SIREN ${v.buyer.siren}`] : [])]) {
    p.y = block(left, p.y - 13, l, 'R', 9, fullW, 12, MUTED);
  }

  // La ligne facturée.
  p.y -= 34;
  const amountCol = rightEdge;
  p.text(left, p.y, 'Désignation', 'B', 8, ACCENT);
  p.right(amountCol, p.y, 'Montant HT', 'B', 8, ACCENT);
  p.y -= 8;
  p.rule(left, rightEdge, p.y, 0.8, ACCENT);
  // Le montant se pose en face de la première ligne, sur sa page, même si la désignation continue plus loin.
  p.room(10 * 1.5);
  p.right(amountCol, p.y - 10 * 1.45, montantImprime(v.ht), 'R', 10);
  p.paragraph(left, v.designation, 'R', 10, rightEdge - left - 120);
  p.y -= 10;
  p.rule(left, rightEdge, p.y);

  // Les totaux, tels que le XML les porte.
  const totals: [string, string, Face][] = [
    ['Total HT', v.ht, 'R'],
    [`TVA ${v.rate.replace('.', ',')} %`, v.vat, 'R'],
    ['Total TTC', v.ttc, 'B'],
    [avoir ? 'Montant de l’avoir' : 'Net à payer', v.due, 'B'],
  ];
  p.y -= 8;
  for (const [label, value, face] of totals) {
    p.room(18);
    p.y -= 16;
    p.text(rightEdge - 220, p.y, label, face, 10, face === 'B' ? INK : MUTED);
    p.right(amountCol, p.y, montantImprime(value), face, 10);
  }
  if (v.exemptionReason) {
    p.y -= 6;
    p.paragraph(left, v.exemptionReason, 'R', 9, rightEdge - left, MUTED);
  }

  // Conditions et mentions.
  p.y -= 24;
  p.room(30);
  p.text(left, p.y, 'Conditions de paiement', 'B', 8, ACCENT);
  p.y -= 4;
  p.paragraph(left, v.paymentTerms, 'R', 9, rightEdge - left);
  if (v.notes.length > 0) {
    p.y -= 16;
    p.room(30);
    p.text(left, p.y, 'Mentions', 'B', 8, ACCENT);
    p.y -= 4;
    for (const n of v.notes) p.paragraph(left, n, 'R', 9, rightEdge - left);
  }

  // Le pied de chaque page : ce qui fait foi.
  const foot = `Facture électronique Factur-X, profil EN 16931. Le fichier ${FACTURX_FILENAME} joint fait foi.`;
  p.pages.forEach((ops, i) => {
    ops.push(`${MUTED} RG 0.4 w ${left} ${MARGIN + 14} m ${rightEdge} ${MARGIN + 14} l S`);
    const hex = (s: string) => encode(s).map((c) => c.toString(16).padStart(2, '0')).join('');
    ops.push(`BT /FR 7.5 Tf ${MUTED} rg ${left} ${MARGIN} Td <${hex(foot)}> Tj ET`);
    if (p.pages.length > 1) {
      const n = `${i + 1} / ${p.pages.length}`;
      ops.push(`BT /FR 7.5 Tf ${MUTED} rg ${(rightEdge - widthOf(POPPINS_REGULAR, n, 7.5)).toFixed(2)} ${MARGIN} Td <${hex(n)}> Tj ET`);
    }
  });
  return p.pages;
}

// --- Profil de couleurs ----------------------------------------------------------------------------------------

/** Un profil ICC v2 sRGB d'écran : primaires IEC 61966-2.1 adaptées à D50, courbe sRGB en 1024 points. */
export function profilSrgb(): Uint8Array {
  const s15 = (v: number): number[] => {
    const n = Math.round(v * 65536) >>> 0;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  };
  const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
  const xyz = (x: number, y: number, z: number): number[] => [...ascii('XYZ '), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)];
  const desc = (s: string): number[] => [
    ...ascii('desc'), 0, 0, 0, 0, ...u32(s.length + 1), ...ascii(s), 0,
    0, 0, 0, 0, 0, 0, 0, 0, // Unicode : langue et longueur nulles
    0, 0, 0, ...new Array<number>(67).fill(0), // ScriptCode : code, longueur, 67 octets
  ];
  const curve: number[] = [...ascii('curv'), 0, 0, 0, 0, ...u32(1024)];
  for (let i = 0; i < 1024; i++) {
    const c = i / 1023;
    const lin = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    const n = Math.round(lin * 65535);
    curve.push((n >>> 8) & 255, n & 255);
  }
  const text = (s: string): number[] => [...ascii('text'), 0, 0, 0, 0, ...ascii(s), 0];
  const tags: [string, number[]][] = [
    ['desc', desc('sRGB IEC61966-2.1')],
    ['cprt', text('Domaine public : profil écrit par AIMMO à partir de la norme IEC 61966-2.1.'.normalize('NFD').replace(/[̀-ͯ]/g, ''))],
    ['wtpt', xyz(0.9642, 1.0, 0.8249)],
    ['rXYZ', xyz(0.4361, 0.2225, 0.0139)],
    ['gXYZ', xyz(0.3851, 0.7169, 0.0971)],
    ['bXYZ', xyz(0.1431, 0.0606, 0.7141)],
    ['rTRC', curve],
  ];
  const pad = (a: number[]): number[] => (a.length % 4 === 0 ? a : [...a, ...new Array<number>(4 - (a.length % 4)).fill(0)]);
  const tableSize = 4 + (tags.length + 2) * 12;
  let offset = 128 + tableSize;
  const table: number[] = [...u32(tags.length + 2)];
  const data: number[] = [];
  let trc = 0;
  for (const [sig, body] of tags) {
    table.push(...ascii(sig), ...u32(offset), ...u32(body.length));
    if (sig === 'rTRC') trc = offset;
    const padded = pad(body);
    data.push(...padded);
    offset += padded.length;
  }
  // Les trois courbes partagent la même table.
  for (const sig of ['gTRC', 'bTRC']) table.push(...ascii(sig), ...u32(trc), ...u32(tags[tags.length - 1]![1].length));
  const size = 128 + tableSize + data.length;
  const header = [
    ...u32(size), 0, 0, 0, 0, 0x02, 0x10, 0, 0, ...ascii('mntrRGB XYZ '),
    0x07, 0xea, 0, 11, 0, 6, 0, 0, 0, 0, 0, 0, // 2026-11-06 00:00:00, fixe : le profil ne change jamais
    ...ascii('acsp'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, // attributs
    0, 0, 0, 0, // intention perceptuelle
    ...s15(0.9642), ...s15(1.0), ...s15(0.8249),
    0, 0, 0, 0,
    ...new Array<number>(44).fill(0),
  ];
  return Uint8Array.from([...header, ...table, ...data]);
}

// --- Écriture du PDF ---------------------------------------------------------------------------------------------

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

const pdfString = (s: string): string => `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;

const base64Bytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Une empreinte de 16 octets, stable, pour l'identifiant du fichier (pas un sceau : la preuve reste le SHA-256 du XML). */
function fileId(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0xdeadbeef;
  let h4 = 0x41c6ce57;
  for (const b of bytes) {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ b, 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ b, 0xc2b2ae35) >>> 0;
    h4 = Math.imul(h4 ^ b, 0x27d4eb2f) >>> 0;
  }
  return [h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('').toUpperCase();
}

const xmlEsc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function xmp(v: VueFacturX): string {
  const prop = (name: string, description: string) =>
    `<rdf:li rdf:parseType="Resource"><pdfaProperty:name>${name}</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>${description}</pdfaProperty:description></rdf:li>`;
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>',
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format>application/pdf</dc:format><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(`${v.typeCode === '381' ? 'Avoir' : 'Facture'} ${v.id}`)}</rdf:li></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>${xmlEsc(v.seller.name)}</rdf:li></rdf:Seq></dc:creator></rdf:Description>`,
    '<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><pdf:Producer>AIMMO</pdf:Producer></rdf:Description>',
    `<rdf:Description rdf:about="" xmlns:fx="${FX_NS}"><fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>${FACTURX_FILENAME}</fx:DocumentFileName><fx:Version>1.0</fx:Version><fx:ConformanceLevel>EN 16931</fx:ConformanceLevel></rdf:Description>`,
    '<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">',
    '<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">',
    '<pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>',
    `<pdfaSchema:namespaceURI>${FX_NS}</pdfaSchema:namespaceURI>`,
    '<pdfaSchema:prefix>fx</pdfaSchema:prefix>',
    '<pdfaSchema:property><rdf:Seq>',
    prop('DocumentFileName', 'name of the embedded XML invoice file'),
    prop('DocumentType', 'INVOICE'),
    prop('Version', 'The actual version of the Factur-X XML schema'),
    prop('ConformanceLevel', 'The conformance level of the embedded Factur-X data'),
    '</rdf:Seq></pdfaSchema:property>',
    '</rdf:li></rdf:Bag></pdfaExtension:schemas>',
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
}

class Writer {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;
  private readonly offsets: number[] = [];

  push(part: Uint8Array | string): void {
    const bytes = typeof part === 'string' ? ascii(part) : part;
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  object(n: number, dict: string): void {
    this.offsets[n] = this.length;
    this.push(`${n} 0 obj\n${dict}\nendobj\n`);
  }

  stream(n: number, dict: string, body: Uint8Array): void {
    this.offsets[n] = this.length;
    this.push(`${n} 0 obj\n<< ${dict} /Length ${body.length} >>\nstream\n`);
    this.push(body);
    this.push('\nendstream\nendobj\n');
  }

  finish(root: number): Uint8Array {
    const count = this.offsets.length;
    const xref = this.length;
    const body = this.bytes();
    const id = fileId(body);
    const rows = ['xref', `0 ${count}`, '0000000000 65535 f\r'];
    for (let i = 1; i < count; i++) rows.push(`${String(this.offsets[i]).padStart(10, '0')} 00000 n\r`);
    this.push(`${rows.join('\n')}\ntrailer\n<< /Size ${count} /Root ${root} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`);
    return this.bytes();
  }

  private bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

function fontObjects(w: Writer, first: number, font: PoliceFacture, tag: string): void {
  const program = base64Bytes(font.base64);
  const name = `${tag}+${font.name}`;
  w.object(first, `<< /Type /Font /Subtype /TrueType /BaseFont /${name} /FirstChar 32 /LastChar 255 /Widths [${font.widths.join(' ')}] /Encoding /WinAnsiEncoding /FontDescriptor ${first + 1} 0 R >>`);
  w.object(
    first + 1,
    `<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [${font.bbox.join(' ')}] /ItalicAngle ${font.italicAngle} /Ascent ${font.ascent} /Descent ${font.descent} /CapHeight ${font.capHeight} /StemV ${font.stemV} /FontFile2 ${first + 2} 0 R >>`,
  );
  w.stream(first + 2, `/Length1 ${program.length}`, program);
}

/**
 * Le PDF/A-3b Factur-X d'un XML EN 16931 rangé, ou ce qui manque pour l'écrire [R256]. Le XML est joint tel quel ;
 * rien n'est imprimé qui ne vienne de lui.
 */
export function pdfFacturX(xml: string): PdfFacturX {
  const v = vueFacturX(xml);
  if (!v) return { ok: false, missing: ['xml_facturx (R254)'] };
  const printed = [v.id, v.designation, v.paymentTerms, v.exemptionReason ?? '', v.corrects ?? '', ...v.notes, ...[v.seller, v.buyer].flatMap((p) => [p.name, p.siren ?? '', p.vatId ?? '', ...adresseLignes(p)])].join(' ');
  const outside = horsPolice(printed);
  if (outside.length > 0) return { ok: false, missing: outside.map((u) => `caractere_hors_police ${u} (R256)`) };

  const pages = layout(v);
  const xmlBytes = new TextEncoder().encode(xml);
  const w = new Writer();
  w.push('%PDF-1.7\n%');
  w.push(Uint8Array.from([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  // 1 catalogue, 2 pages, 3-5 police normale, 6-8 grasse, 9 métadonnées, 10 profil, 11 XML joint, 12 sa fiche,
  // puis chaque page et son contenu.
  const firstPage = 13;
  const kids = pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(' ');
  w.object(
    1,
    `<< /Type /Catalog /Pages 2 0 R /Metadata 9 0 R /OutputIntents [<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB IEC61966-2.1) /Info (sRGB IEC61966-2.1) /DestOutputProfile 10 0 R >>] /Names << /EmbeddedFiles << /Names [${pdfString(FACTURX_FILENAME)} 12 0 R] >> >> /AF [12 0 R] /PageMode /UseAttachments >>`,
  );
  w.object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  fontObjects(w, 3, POPPINS_REGULAR, 'AIMMOR');
  fontObjects(w, 6, POPPINS_BOLD, 'AIMMOB');
  w.stream(9, '/Type /Metadata /Subtype /XML', new TextEncoder().encode(xmp(v)));
  w.stream(10, '/N 3', profilSrgb());
  const mod = `D:${v.issuedOn.replace(/-/g, '')}000000Z`;
  w.stream(11, `/Type /EmbeddedFile /Subtype /text#2Fxml /Params << /ModDate ${pdfString(mod)} /Size ${xmlBytes.length} >>`, xmlBytes);
  w.object(12, `<< /Type /Filespec /F ${pdfString(FACTURX_FILENAME)} /UF ${pdfString(FACTURX_FILENAME)} /Desc (Factur-X) /AFRelationship /Data /EF << /F 11 0 R /UF 11 0 R >> >>`);
  pages.forEach((ops, i) => {
    const n = firstPage + i * 2;
    w.object(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /FR 3 0 R /FB 6 0 R >> >> /Contents ${n + 1} 0 R >>`);
    w.stream(n + 1, '', ascii(ops.join('\n')));
  });
  return { ok: true, pdf: w.finish(1) };
}

/** Relit le XML joint d'un PDF Factur-X, octet pour octet ; `null` si le PDF n'en porte pas. */
export function xmlJoint(pdf: Uint8Array): Uint8Array | null {
  const text = new TextDecoder('latin1').decode(pdf);
  const at = text.indexOf('/Type /EmbeddedFile ');
  if (at < 0) return null;
  const end = text.indexOf('>>\nstream\n', at);
  const length = end < 0 ? undefined : /\/Length (\d+) $/.exec(text.slice(at, end))?.[1];
  if (end < 0 || !length) return null;
  const start = end + '>>\nstream\n'.length;
  return pdf.slice(start, start + Number(length));
}
