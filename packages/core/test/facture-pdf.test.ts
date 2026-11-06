import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import {
  FACTURX_FILENAME,
  factureElectronique,
  montantImprime,
  pdfFacturX,
  profilSrgb,
  totauxFacturX,
  xmlJoint,
  type IdentiteClient,
  type IdentiteEmetteur,
  type InvoiceContent,
} from '../src/pilotage/index.ts';
import { POPPINS_BOLD, POPPINS_REGULAR } from '../src/pilotage/facturx-police.ts';

// Tout est inventé : sociétés, SIREN, numéros de TVA, adresses, clients, montants.
const RESEAU: IdentiteEmetteur = {
  name: 'Réseau Fictif SAS',
  siren: '900000001',
  vatId: 'FR00900000001',
  address: { line1: '1 rue Inventée', postcode: '21000', city: 'Dijon', country: 'FR' },
  regime: { category: 'S' },
  paymentTerms: 'Payable à réception. Pénalités de retard : trois fois le taux d’intérêt légal. Indemnité forfaitaire pour frais de recouvrement : 40 €.',
};
const AGENT: IdentiteEmetteur = {
  name: 'Alex Agent EI',
  siren: '900000002',
  vatId: 'FR00900000002',
  address: { line1: '3 allée Fictive', line2: 'Bâtiment B', postcode: '21800', city: 'Quetigny', country: 'FR' },
  regime: { category: 'E', exemptionReason: 'TVA non applicable, art. 293 B du CGI' },
  paymentTerms: 'Payable à 30 jours.',
};
const CLIENT: IdentiteClient = { name: 'Acheteur Exemple', address: { line1: '2 place Imaginaire', postcode: '21000', city: 'Dijon', country: 'FR' } };

const HONORAIRES: InvoiceContent = {
  label: 'F-2027-00001',
  kind: 'honoraires',
  issuedOn: '2027-06-11',
  issuer: 'Réseau Fictif SAS',
  recipient: 'Acheteur Exemple',
  designation: 'Honoraires de transaction, bien REF-T-1',
  htCents: 1_041_667,
  vatBp: 2000,
  vatCents: 208_333,
  ttcCents: 1_250_000,
  mentions: ['Facture d’essai, sans valeur comptable.'],
  corrects: null,
  saleDay: '2027-06-10',
  reason: null,
};
const AVOIR: InvoiceContent = { ...HONORAIRES, label: 'A-2027-00001', kind: 'avoir', htCents: -1_041_667, vatCents: -208_333, ttcCents: -1_250_000, corrects: 'F-2027-00001', reason: 'erreur_montant' };
const REVERSEMENT: InvoiceContent = { ...HONORAIRES, label: 'R-2027-00001', kind: 'reversement', issuer: 'Alex Agent EI', recipient: 'Réseau Fictif SAS', designation: 'Reversement de commission, dossier REF-T-1', htCents: 562_500, vatBp: 0, vatCents: 0, ttcCents: 562_500 };

function xmlOf(content: InvoiceContent, seller: IdentiteEmetteur = RESEAU, buyer: IdentiteClient = CLIENT): string {
  const r = factureElectronique({ content, seller, buyer });
  if (!r.ok) throw new Error(r.missing.join(', '));
  return r.xml;
}

function pdfOf(xml: string): Uint8Array {
  const r = pdfFacturX(xml);
  if (!r.ok) throw new Error(r.missing.join(', '));
  return r.pdf;
}

const latin1 = (b: Uint8Array): string => new TextDecoder('latin1').decode(b);

/** Les objets du PDF, par numéro : le dictionnaire, et le flux brut s'il y en a un. */
function objects(pdf: Uint8Array): Map<number, { dict: string; stream: Uint8Array | null; offset: number }> {
  const text = latin1(pdf);
  const out = new Map<number, { dict: string; stream: Uint8Array | null; offset: number }>();
  const re = /(\d+) 0 obj\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('\nendobj\n', start);
    const body = text.slice(start, end);
    const s = body.indexOf('\nstream\n');
    if (s < 0) out.set(Number(m[1]), { dict: body, stream: null, offset: m.index });
    else {
      const dict = body.slice(0, s);
      const length = Number(/\/Length (\d+) >>$/.exec(dict)![1]);
      const from = start + s + '\nstream\n'.length;
      expect(text.slice(from + length, from + length + 10)).toBe('\nendstream');
      out.set(Number(m[1]), { dict, stream: pdf.slice(from, from + length), offset: m.index });
    }
    re.lastIndex = end;
  }
  return out;
}

/** Le texte imprimé, ligne par ligne, relu dans les contenus de page (chaînes hexadécimales en WinAnsi). */
function printed(pdf: Uint8Array): string[] {
  const decoder = new TextDecoder('windows-1252');
  const lines: string[] = [];
  for (const o of objects(pdf).values()) {
    if (!o.stream || !/^<<\s+\/Length \d+ >>$/.test(o.dict)) continue;
    for (const m of latin1(o.stream).matchAll(/<([0-9a-f]*)> Tj/g)) {
      const bytes = Uint8Array.from(m[1]!.match(/../g)!.map((h) => parseInt(h, 16)));
      lines.push(decoder.decode(bytes));
    }
  }
  return lines;
}

/** Lit une police TrueType : unités du corps, et la chasse d'avance d'un caractère par la table cmap (3,1). */
function trueType(font: Uint8Array): { advance: (unicode: number) => number | null; glyphs: number } {
  const dv = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = new Map<string, number>();
  for (let i = 0; i < dv.getUint16(4); i++) {
    const at = 12 + i * 16;
    tables.set(String.fromCharCode(font[at]!, font[at + 1]!, font[at + 2]!, font[at + 3]!), dv.getUint32(at + 8));
  }
  const head = tables.get('head')!;
  const upm = dv.getUint16(head + 18);
  const hhea = tables.get('hhea')!;
  const hmetrics = dv.getUint16(hhea + 34);
  const hmtx = tables.get('hmtx')!;
  const cmap = tables.get('cmap')!;
  let sub = -1;
  for (let i = 0; i < dv.getUint16(cmap + 2); i++) {
    const at = cmap + 4 + i * 8;
    if (dv.getUint16(at) === 3 && dv.getUint16(at + 2) === 1) sub = cmap + dv.getUint32(at + 4);
  }
  expect(sub).toBeGreaterThan(0);
  expect(dv.getUint16(sub)).toBe(4);
  const segX2 = dv.getUint16(sub + 6);
  const glyph = (u: number): number => {
    const ends = sub + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let i = 0; i < segX2 / 2; i++) {
      if (u > dv.getUint16(ends + i * 2)) continue;
      if (u < dv.getUint16(starts + i * 2)) return 0;
      const ro = dv.getUint16(ranges + i * 2);
      if (ro === 0) return (u + dv.getInt16(deltas + i * 2)) & 0xffff;
      const g = dv.getUint16(ranges + i * 2 + ro + (u - dv.getUint16(starts + i * 2)) * 2);
      return g === 0 ? 0 : (g + dv.getInt16(deltas + i * 2)) & 0xffff;
    }
    return 0;
  };
  return {
    glyphs: dv.getUint16(tables.get('maxp')! + 4),
    advance: (u) => {
      const g = glyph(u);
      if (g === 0) return null;
      return Math.round((dv.getUint16(hmtx + Math.min(g, hmetrics - 1) * 4) * 1000) / upm);
    },
  };
}

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

it('[R256] PDF/A-3b : en-tête binaire, table des objets exacte, identifiant, rien de chiffré ni de script', () => {
  const pdf = pdfOf(xmlOf(HONORAIRES));
  expect(latin1(pdf.slice(0, 9))).toBe('%PDF-1.7\n');
  // Le commentaire binaire : au moins quatre octets au-delà de 127 juste après l'en-tête (ISO 19005-3, 6.1.2).
  expect([...pdf.slice(10, 14)].every((b) => b > 127)).toBe(true);
  const text = latin1(pdf);
  expect(text.endsWith('%%EOF\n')).toBe(true);
  const objs = objects(pdf);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
  expect(text.slice(startxref, startxref + 5)).toBe('xref\n');
  const rows = text.slice(startxref).split('trailer')[0]!.split('\n').slice(2).filter((r) => r.length > 0);
  expect(rows[0]).toBe('0000000000 65535 f\r');
  expect(rows).toHaveLength(objs.size + 1);
  rows.slice(1).forEach((row, i) => {
    expect(row).toMatch(/^\d{10} 00000 n\r$/);
    expect(Number(row.slice(0, 10))).toBe(objs.get(i + 1)!.offset);
  });
  expect(text).toMatch(/trailer\n<< \/Size \d+ \/Root 1 0 R \/ID \[<[0-9A-F]{32}> <[0-9A-F]{32}>\] >>/);
  for (const banned of ['/Encrypt', '/JavaScript', '/JS ', '/Launch', '/Transparency', '/SMask', '/LZWDecode', '/Filter']) expect(text).not.toContain(banned);
});

it('[R256] PDF/A-3b : chaque police est intégrée, ses chasses sont celles du programme, et chaque caractère imprimé y a son glyphe', () => {
  const pdf = pdfOf(xmlOf(REVERSEMENT, AGENT, { name: 'Réseau Fictif SAS', siren: '900000001', address: RESEAU.address }));
  const objs = objects(pdf);
  const fonts = [...objs.values()].filter((o) => o.dict.includes('/Type /Font '));
  expect(fonts).toHaveLength(2);
  const decoder = new TextDecoder('windows-1252');
  const used = new Set(printed(pdf).join('').split(''));
  for (const font of fonts) {
    expect(font.dict).toContain('/Subtype /TrueType');
    expect(font.dict).toContain('/Encoding /WinAnsiEncoding');
    expect(font.dict).toMatch(/\/BaseFont \/[A-Z]{6}\+Poppins-(Regular|Bold) /);
    const widths = /\/Widths \[([^\]]*)\]/.exec(font.dict)![1]!.split(' ').map(Number);
    expect(widths).toHaveLength(224);
    const descriptor = objs.get(Number(/\/FontDescriptor (\d+) 0 R/.exec(font.dict)![1]))!;
    // Non symbolique (bit 6) : les codes passent par WinAnsi puis par la table cmap (3,1) du programme.
    expect(descriptor.dict).toContain('/Flags 32 ');
    const file = objs.get(Number(/\/FontFile2 (\d+) 0 R/.exec(descriptor.dict)![1]))!;
    expect(file.dict).toContain(`/Length1 ${file.stream!.length}`);
    const tt = trueType(file.stream!);
    for (const ch of used) {
      const code = [...Array(224).keys()].map((i) => i + 32).find((c) => decoder.decode(Uint8Array.of(c)) === ch)!;
      expect(code, `caractère ${ch}`).toBeDefined();
      // ISO 19005-3, 6.2.11.5 : la chasse du dictionnaire est celle du programme, et 6.2.11.8 : jamais .notdef.
      expect(tt.advance(ch.codePointAt(0)!), `glyphe de ${ch}`).toBe(widths[code - 32]);
    }
  }
  // Les deux faces intégrées sont celles de la police rangée dans le code, entières.
  const programs = fonts.map((f) => objs.get(Number(/\/FontFile2 (\d+) 0 R/.exec(objs.get(Number(/\/FontDescriptor (\d+) 0 R/.exec(f.dict)![1]))!.dict)![1]))!.stream!);
  expect(programs.map((p) => p.length).sort()).toEqual([b64(POPPINS_REGULAR.base64).length, b64(POPPINS_BOLD.base64).length].sort());
});

it('[R256] PDF/A-3b : profil de couleurs sRGB valide en intention de sortie, métadonnées XMP Factur-X et schéma d’extension', () => {
  const pdf = pdfOf(xmlOf(HONORAIRES));
  const objs = objects(pdf);
  const catalog = objs.get(1)!.dict;
  expect(catalog).toContain('/Type /Catalog');
  expect(catalog).toContain('/S /GTS_PDFA1');
  const icc = objs.get(Number(/\/DestOutputProfile (\d+) 0 R/.exec(catalog)![1]))!;
  expect(icc.dict).toContain('/N 3');
  expect(icc.stream).toEqual(profilSrgb());
  const p = icc.stream!;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  expect(dv.getUint32(0)).toBe(p.length);
  expect(latin1(p.slice(12, 24))).toBe('mntrRGB XYZ ');
  expect(latin1(p.slice(36, 40))).toBe('acsp');
  expect(p[8]).toBe(2);
  const tags = new Map<string, [number, number]>();
  for (let i = 0; i < dv.getUint32(128); i++) tags.set(latin1(p.slice(132 + i * 12, 136 + i * 12)), [dv.getUint32(136 + i * 12), dv.getUint32(140 + i * 12)]);
  for (const t of ['desc', 'cprt', 'wtpt', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC']) {
    const [at, size] = tags.get(t)!;
    expect(at % 4).toBe(0);
    expect(at + size).toBeLessThanOrEqual(p.length);
  }
  // Les primaires s'additionnent au blanc D50, à l'arrondi près.
  const xyz = (t: string) => [0, 1, 2].map((k) => dv.getInt32(tags.get(t)![0] + 8 + k * 4) / 65536);
  const sum = [0, 1, 2].map((k) => xyz('rXYZ')[k]! + xyz('gXYZ')[k]! + xyz('bXYZ')[k]!);
  sum.forEach((v, k) => expect(Math.abs(v - xyz('wtpt')[k]!)).toBeLessThan(0.002));

  const meta = objs.get(Number(/\/Metadata (\d+) 0 R/.exec(catalog)![1]))!;
  expect(meta.dict).toContain('/Type /Metadata /Subtype /XML');
  const xmp = new TextDecoder().decode(meta.stream!);
  expect(xmp.startsWith('<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>')).toBe(true);
  expect(xmp).toContain('<pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>');
  expect(xmp).toContain('<fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>factur-x.xml</fx:DocumentFileName><fx:Version>1.0</fx:Version><fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>');
  expect(xmp).toContain('<pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>');
  for (const prop of ['DocumentFileName', 'DocumentType', 'Version', 'ConformanceLevel']) expect(xmp).toContain(`<pdfaProperty:name>${prop}</pdfaProperty:name>`);
  expect(xmp).toContain('<rdf:li xml:lang="x-default">Facture F-2027-00001</rdf:li>');
  expect(xmp.endsWith('<?xpacket end="w"?>')).toBe(true);
  // Pas de dictionnaire d'informations : rien qui puisse contredire les métadonnées (ISO 19005-3, 6.6.2.3).
  expect(latin1(pdf).split('trailer')[1]).not.toContain('/Info');
});

it('[R256] le XML joint est, octet pour octet, celui qui est rangé ; il porte la relation Data et son type', () => {
  const tricky = xmlOf({ ...HONORAIRES, designation: 'Honoraires <b>&</b> "frais" — l’agence' }, { ...RESEAU, name: 'A & B <SAS>' });
  for (const xml of [xmlOf(HONORAIRES), xmlOf(AVOIR), xmlOf(REVERSEMENT, AGENT, CLIENT), tricky]) {
    const pdf = pdfOf(xml);
    expect(xmlJoint(pdf)).toEqual(new TextEncoder().encode(xml));
    const objs = objects(pdf);
    const catalog = objs.get(1)!.dict;
    const spec = Number(/\/AF \[(\d+) 0 R\]/.exec(catalog)![1]);
    expect(catalog).toContain(`/EmbeddedFiles << /Names [(${FACTURX_FILENAME}) ${spec} 0 R] >>`);
    const filespec = objs.get(spec)!.dict;
    expect(filespec).toContain('/Type /Filespec');
    expect(filespec).toContain(`/F (${FACTURX_FILENAME}) /UF (${FACTURX_FILENAME})`);
    expect(filespec).toContain('/AFRelationship /Data');
    const file = objs.get(Number(/\/EF << \/F (\d+) 0 R/.exec(filespec)![1]))!;
    expect(file.dict).toContain('/Type /EmbeddedFile /Subtype /text#2Fxml');
    expect(file.dict).toMatch(/\/Params << \/ModDate \(D:\d{14}Z\) \/Size \d+ >>/);
    expect(Number(/\/Size (\d+) >>/.exec(file.dict)![1])).toBe(new TextEncoder().encode(xml).length);
  }
  expect(xmlJoint(new TextEncoder().encode('%PDF-1.7\n%%EOF\n'))).toBeNull();
});

it('[R256] chaque montant imprimé est celui du XML : facture, avoir et reversement exonéré, aucun autre', () => {
  for (const [content, seller] of [[HONORAIRES, RESEAU], [AVOIR, RESEAU], [REVERSEMENT, AGENT]] as const) {
    const xml = xmlOf(content, seller);
    const totals = totauxFacturX(xml)!;
    const fmt = (c: number) => montantImprime(`${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`);
    const lines = printed(pdfOf(xml));
    const amounts = lines.filter((l) => l.includes('€') && /\d/.test(l) && !l.includes(' : '));
    expect(new Set(amounts)).toEqual(new Set([fmt(totals.htCents), fmt(totals.vatCents), fmt(totals.ttcCents), fmt(totals.dueCents)]));
    const label = (l: string) => lines.indexOf(l);
    expect(lines[label('Total HT') + 1]).toBe(fmt(totals.htCents));
    expect(lines[label('Total TTC') + 1]).toBe(fmt(totals.ttcCents));
    expect(lines.some((l) => l === `TVA ${content.vatBp / 100} %`)).toBe(true);
  }
  expect(montantImprime('1250000.05')).toBe('1\u00a0250\u00a0000,05\u00a0€');
  expect(montantImprime('0.00')).toBe('0,00\u00a0€');
});

it('[R256] le PDF imprime le XML : nature, numéro, dates, parties, désignation, mentions, motif d’exonération et facture corrigée', () => {
  const honoraires = printed(pdfOf(xmlOf(HONORAIRES)));
  for (const s of ['Facture', 'N° F-2027-00001', 'Émise le 11/06/2027', 'Acte du 10/06/2027', 'Réseau Fictif SAS', '1 rue Inventée', '21000 Dijon', 'SIREN 900000001', 'TVA FR00900000001', 'Acheteur Exemple', '2 place Imaginaire', 'Honoraires de transaction, bien REF-T-1', 'Facture d’essai, sans valeur comptable.', 'Net à payer']) {
    expect(honoraires, s).toContain(s);
  }
  const avoir = printed(pdfOf(xmlOf(AVOIR)));
  expect(avoir).toContain('Avoir');
  expect(avoir).toContain('Corrige la facture F-2027-00001');
  expect(avoir).not.toContain('Facture');
  const reversement = printed(pdfOf(xmlOf(REVERSEMENT, AGENT)));
  expect(reversement).toContain('TVA non applicable, art. 293 B du CGI');
  expect(reversement).toContain('Bâtiment B');
  expect(reversement).toContain('21800 Quetigny');
});

it('[R256] la même facture donne le même PDF, octet pour octet ; deux factures, deux identifiants', () => {
  const a = pdfOf(xmlOf(HONORAIRES));
  expect(pdfOf(xmlOf(HONORAIRES))).toEqual(a);
  const id = (p: Uint8Array) => /\/ID \[<([0-9A-F]+)>/.exec(latin1(p))![1];
  expect(id(pdfOf(xmlOf(AVOIR)))).not.toBe(id(a));
});

it('[R256] un caractère que la police n’a pas n’est jamais remplacé : pas de PDF, le manque est dit ; un XML étranger n’en donne pas non plus', () => {
  const xml = xmlOf(HONORAIRES, RESEAU, { ...CLIENT, name: 'Client \u0646\u0645\u0648\u0646\u0647 Exemple' });
  const r = pdfFacturX(xml);
  expect(r).toEqual({ ok: false, missing: ['caractere_hors_police U+0646 (R256)', 'caractere_hors_police U+0645 (R256)', 'caractere_hors_police U+0648 (R256)', 'caractere_hors_police U+0647 (R256)'] });
  expect(pdfFacturX('<?xml version="1.0"?><autre/>')).toEqual({ ok: false, missing: ['xml_facturx (R254)'] });
  expect(pdfFacturX(xmlOf(HONORAIRES).replace(/<ram:GrandTotalAmount>[^<]*<\/ram:GrandTotalAmount>/, ''))).toEqual({ ok: false, missing: ['xml_facturx (R254)'] });
});

it('[R256] un espacement autre que l’espace (tabulation, espace fine, saut de ligne) s’imprime en espace, sans jamais faire tomber le PDF', () => {
  const xml = xmlOf({ ...HONORAIRES, designation: 'Honoraires\tde\u2009transaction\u202Fbien\u3000REF-T-1', mentions: ['Ligne une\u2028ligne deux'] }, { ...RESEAU, name: 'Réseau\tFictif SAS' });
  const r = pdfFacturX(xml);
  expect(r.ok).toBe(true);
  const lines = printed((r as { pdf: Uint8Array }).pdf);
  expect(lines).toContain('Réseau Fictif SAS');
  expect(lines).toContain('Honoraires de transaction bien REF-T-1');
  expect(lines).toContain('Ligne une ligne deux');
  expect(xmlJoint((r as { pdf: Uint8Array }).pdf)).toEqual(new TextEncoder().encode(xml));
});

it('[R256] de longues mentions passent à la page suivante, numérotée, sans rien perdre ni déborder', () => {
  const mentions = Array.from({ length: 40 }, (_, i) => `Mention inventée numéro ${i + 1} : ${'texte de remplissage '.repeat(12).trim()}.`);
  const pdf = pdfOf(xmlOf({ ...HONORAIRES, mentions, designation: `Honoraires ${'tres-long-mot-sans-espace'.repeat(8)}` }));
  const text = latin1(pdf);
  const count = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)![1]);
  expect(count).toBeGreaterThan(1);
  const lines = printed(pdf);
  expect(lines).toContain(`1 / ${count}`);
  expect(lines).toContain(`${count} / ${count}`);
  const body = lines.filter((l) => !l.startsWith('Facture électronique Factur-X') && !/^\d+ \/ \d+$/.test(l));
  const flat = body.join(' ').replace(/\s+/g, ' ');
  for (const m of mentions) expect(flat.replace(/ /g, '')).toContain(m.replace(/ /g, ''));
  // Rien ne sort de la page : chaque texte commence dans les marges.
  for (const m of text.matchAll(/ ([\d.]+) ([\d.]+) Td </g)) {
    expect(Number(m[1])).toBeGreaterThanOrEqual(56);
    expect(Number(m[1])).toBeLessThan(595.28 - 56);
    expect(Number(m[2])).toBeGreaterThanOrEqual(56);
  }
});

// Le fichier d'exemple que le travail « Vérifier le PDF/A » passe à veraPDF (ISO 19005-3, niveau B).
it('écrit le PDF d’exemple pour veraPDF quand FACTURX_PDF_OUT est donné', () => {
  const out = process.env.FACTURX_PDF_OUT;
  if (!out) return;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, pdfOf(xmlOf(HONORAIRES)));
  writeFileSync(out.replace(/\.pdf$/, '-avoir.pdf'), pdfOf(xmlOf(AVOIR)));
  writeFileSync(out.replace(/\.pdf$/, '-reversement.pdf'), pdfOf(xmlOf(REVERSEMENT, AGENT)));
});
