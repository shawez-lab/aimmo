import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { excerptsOf, verifyReading } from '../src/avant-contrat/lecture-projet.ts';
import { PDF_TEXT_REFUSALS, PDF_TEXT_REFUSAL_TEXT, pagesForReading, pagesToRead, pdfPagesText, type PdfPageText } from '../src/documents/texte-pdf.ts';

// Des PDF inventés, écrits à la main : aucune vraie personne, aucun vrai bien.

type Obj = string | { dict: string; data: Uint8Array | string; flate?: boolean };

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Un PDF : l'objet i porte le numéro i + 1. */
function pdf(objects: Obj[], opts: { trailer?: string; root?: number; xref?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [enc('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objects.forEach((o, i) => {
    offsets.push(at);
    let chunk: Uint8Array;
    if (typeof o === 'string') chunk = enc(`${i + 1} 0 obj\n${o}\nendobj\n`);
    else {
      const raw = typeof o.data === 'string' ? enc(o.data) : o.data;
      const data = o.flate ? new Uint8Array(deflateSync(raw)) : raw;
      const filter = o.flate ? ' /Filter /FlateDecode' : '';
      chunk = concat([enc(`${i + 1} 0 obj\n<< ${o.dict}${filter} /Length ${data.length} >>\nstream\n`), data, enc('\nendstream\nendobj\n')]);
    }
    parts.push(chunk);
    at += chunk.length;
  });
  if (opts.xref !== false) {
    let x = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) x += `${String(o).padStart(10, '0')} 00000 n \n`;
    x += `trailer\n<< /Size ${objects.length + 1} /Root ${opts.root ?? 1} 0 R ${opts.trailer ?? ''} >>\nstartxref\n${at}\n%%EOF\n`;
    parts.push(enc(x));
  }
  return concat(parts);
}

const HELV = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

/** Catalogue, arbre d'une page par contenu, police Helvetica en WinAnsi. */
function simple(contents: string[], opts: { flate?: boolean } = {}): Uint8Array {
  const n = contents.length;
  const kids = contents.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  const objs: Obj[] = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`, HELV];
  contents.forEach((c, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push({ dict: '', data: c, flate: opts.flate ?? false });
  });
  return pdf(objs);
}

const textOf = (pages: PdfPageText[]) => pages.map((p) => p.text);

async function pages(bytes: Uint8Array) {
  const r = await pdfPagesText(bytes);
  if (!r.ok) throw new Error(`refusé : ${r.code}`);
  return r.value.pages;
}

/** Une table ToUnicode : bfchar et bfrange, codes sur deux octets. */
const TO_UNICODE = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Adobe-Identity-UCS def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
3 beginbfchar
<0003> <0020>
<0010> <00E9>
<0011> <20AC>
endbfchar
2 beginbfrange
<0024> <003D> <0041>
<0044> <005D> <0061>
endbfrange
1 beginbfrange
<0060> <0069> <0030>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

/** Encode un texte dans les codes de la table ci-dessus. */
function cid(text: string): string {
  let hex = '';
  for (const ch of text) {
    let code: number;
    if (ch === ' ') code = 0x03;
    else if (ch === 'é') code = 0x10;
    else if (ch === '€') code = 0x11;
    else if (ch >= 'A' && ch <= 'Z') code = 0x24 + ch.charCodeAt(0) - 65;
    else if (ch >= 'a' && ch <= 'z') code = 0x44 + ch.charCodeAt(0) - 97;
    else if (ch >= '0' && ch <= '9') code = 0x60 + ch.charCodeAt(0) - 48;
    else throw new Error(ch);
    hex += code.toString(16).padStart(4, '0');
  }
  return `<${hex}>`;
}

function composite(content: string, opts: { toUnicode?: boolean } = {}): Uint8Array {
  const tu = opts.toUnicode === false ? '' : ' /ToUnicode 6 0 R';
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    `<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+NotoSans /Encoding /Identity-H /DescendantFonts [7 0 R]${tu} >>`,
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 3 0 R >> >> /Contents 5 0 R >>',
    { dict: '', data: content, flate: true },
    { dict: '', data: TO_UNICODE, flate: true },
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+NotoSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>',
  ]);
}

describe('RC40 · le texte des pages d’un PDF', () => {
  it('lit une page en clair, ligne par ligne', async () => {
    const p = await pages(simple(['BT /F1 12 Tf 72 720 Td (Projet de compromis de vente) Tj 0 -14 Td (Prix : 245 000 euros) Tj ET']));
    expect(p).toEqual([{ page: 1, text: 'Projet de compromis de vente\nPrix : 245 000 euros' }]);
  });

  it('lit un flux compressé et plusieurs pages', async () => {
    const p = await pages(simple(['BT /F1 12 Tf 72 720 Td (Page un) Tj ET', 'BT /F1 12 Tf 72 720 Td (Page deux) Tj ET'], { flate: true }));
    expect(textOf(p)).toEqual(['Page un', 'Page deux']);
    expect(p.map((x) => x.page)).toEqual([1, 2]);
  });

  it('suit l’ordre de l’arbre des pages, pas celui des numéros d’objets, avec ressources héritées et tableau de contenus', async () => {
    const bytes = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [9 0 R 3 0 R] /Count 3 /Resources << /Font << /F1 4 0 R >> >> >>',
      '<< /Type /Page /Parent 2 0 R /Contents [5 0 R 6 0 R] >>',
      HELV,
      { dict: '', data: 'BT /F1 12 Tf 72 720 Td (Troisieme page,) Tj ET' },
      { dict: '', data: 'BT /F1 12 Tf 72 706 Td (ligne suivante) Tj ET', flate: true },
      '<< /Type /Page /Parent 9 0 R /Contents 8 0 R >>',
      { dict: '', data: 'BT /F1 12 Tf 72 720 Td (Premiere page) Tj ET' },
      '<< /Type /Pages /Parent 2 0 R /Kids [7 0 R 10 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 9 0 R /Contents 11 0 R >>',
      { dict: '', data: 'BT /F1 12 Tf 72 720 Td (Deuxieme page) Tj ET' },
    ]);
    expect(textOf(await pages(bytes))).toEqual(['Premiere page', 'Deuxieme page', 'Troisieme page,\nligne suivante']);
  });

  it('lit le texte d’un formulaire imbriqué, et refuse une boucle de formulaires', async () => {
    const bytes = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /Fm1 6 0 R >> >> /Contents 5 0 R >>',
      HELV,
      { dict: '', data: 'BT /F1 12 Tf 72 760 Td (En-tete) Tj ET q /Fm1 Do Q' },
      { dict: '/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >>', data: 'BT /F1 12 Tf 72 700 Td (Dans le formulaire) Tj ET', flate: true },
    ]);
    expect(textOf(await pages(bytes))).toEqual(['En-tete\nDans le formulaire']);
    const loop = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /Fm1 6 0 R >> >> /Contents 5 0 R >>',
      HELV,
      { dict: '', data: 'BT /F1 12 Tf (Texte) Tj ET /Fm1 Do' },
      { dict: '/Type /XObject /Subtype /Form /Resources << /XObject << /Fm1 6 0 R >> >>', data: '/Fm1 Do' },
    ]);
    expect(await pages(loop)).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
  });

  it('lit WinAnsi, les chaînes échappées, les espaces de TJ et les opérateurs de ligne', async () => {
    const content = String.raw`BT /F1 12 Tf 72 720 Td (Acte pr\351vu le 15/09/2027 \(au plus tard\)) Tj T* [(Montant)-300(du d)20(\351p\364t : 12 250 \200)] TJ (Ligne suivante) ' 1 2 (Encore une) " ET`;
    expect(textOf(await pages(simple([content])))).toEqual(['Acte prévu le 15/09/2027 (au plus tard)\nMontant du dépôt : 12 250 €\nLigne suivante\nEncore une']);
  });

  it('MacRoman et le codage standard : la partie ASCII seulement, un octet haut rend la page illisible', async () => {
    const font = (e: string) => `<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman${e} >>`;
    const one = (f: string, text: string) =>
      pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', f, { dict: '', data: `BT /F1 12 Tf (${text}) Tj ET` }]);
    expect(textOf(await pages(one(font(' /Encoding /MacRomanEncoding'), "l'acte")))).toEqual(["l'acte"]);
    expect(textOf(await pages(one(font(''), "l'acte")))).toEqual(['l’acte']);
    expect(await pages(one(font(' /Encoding /MacRomanEncoding'), 'pr\\216vu'))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
    expect(await pages(one(font(''), 'pr\\351vu'))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
  });

  it('saute une image en ligne sans lire ses octets comme du texte', async () => {
    const content = 'BT /F1 12 Tf 72 720 Td (Avant) Tj ET BI /W 4 /H 1 /BPC 8 /CS /G ID \x28\x29\xff\x00 EI BT /F1 12 Tf 72 700 Td (Apres) Tj ET';
    expect(textOf(await pages(simple([content])))).toEqual(['Avant\nApres']);
    // Les octets de l'image contiennent « EI » puis du texte : ils ne sont jamais lus.
    const pixels = ' EI BT /F1 12 Tf (Prix : 100000) Tj ET '.padEnd(60, ' ');
    expect(await pages(simple([`BI /W 60 /H 1 /BPC 8 /CS /G ID ${pixels} EI`]))).toEqual([{ page: 1, text: null, reason: 'no_text' }]);
    expect(textOf(await pages(simple([`BI /W 6 /H 1 /BPC 1 /IM true ID \x01 EI BI /L 3 /F /AHx ID 4E> EI BT /F1 12 Tf (Texte) Tj ET`])))).toEqual(['Texte']);
    // Image compressée sans longueur dite : sa fin n'est pas sûre, la page est illisible.
    expect(await pages(simple([`BT /F1 12 Tf (Texte) Tj ET BI /W 2 /H 1 /BPC 8 /CS /G /F /AHx ID 4E4F> EI`]))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
  });

  it('lit une police composite par sa table ToUnicode (bfchar, bfrange), accents et euro compris', async () => {
    const content = `BT /F2 11 Tf 72 720 Td ${cid('Prix de vente 245000 €')} Tj 0 -14 Td [${cid('Acte pr')} -10 ${cid('évu')}] TJ ET`;
    expect(textOf(await pages(composite(content)))).toEqual(['Prix de vente 245000 €\nActe prévu']);
  });

  it('l’espace entre deux textes d’une ligne se lit sur leur position et la largeur des glyphes, jamais inventé', async () => {
    // Largeurs d'Helvetica pour les codes 32 à 120 utiles ici.
    const W: Record<string, number> = { ' ': 278, ':': 278, '0': 556, '1': 556, P: 667, r: 333, i: 222, x: 500 };
    const widths = Array.from({ length: 89 }, (_, k) => W[String.fromCharCode(32 + k)] ?? 500).join(' ');
    const make = (x: string, font = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 120 /Widths [${widths}] >>`) =>
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        font,
        { dict: '', data: `BT /F1 12 Tf 1 0 0 1 72 720 Tm (Prix : 1) Tj 1 0 0 1 ${x} 720 Tm (00000) Tj ET` },
      ]);
    expect(textOf(await pages(make('109.344')))).toEqual(['Prix : 100000']);
    expect(textOf(await pages(make('115')))).toEqual(['Prix : 1 00000']);
    expect(textOf(await pages(make('40')))).toEqual(['Prix : 1\n00000']);
    expect(await pages(make('109.344', HELV))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
    const cidContent = (x: number) => `BT /F2 10 Tf 1 0 0 1 72 720 Tm ${cid('Prix')} Tj 1 0 0 1 ${x} 720 Tm ${cid('245')} Tj ET`;
    expect(textOf(await pages(composite(cidContent(112))))).toEqual(['Prix245']);
    expect(textOf(await pages(composite(cidContent(120))))).toEqual(['Prix 245']);
  });

  it('positions comparées dans l’espace de la page : la transformation cm compte, q et Q la rendent', async () => {
    const mono = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 126 /Widths [${Array(95).fill(500).join(' ')}] >>`;
    const make = (content: string) =>
      pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', mono, { dict: '', data: content }]);
    expect(textOf(await pages(make('BT /F1 10 Tf 0 700 Td (Prix : 1) Tj ET BT /F1 10 Tf 40 700 Td (00000) Tj ET')))).toEqual(['Prix : 100000']);
    expect(textOf(await pages(make('BT /F1 10 Tf 0 700 Td (Prix : 1) Tj ET 1 0 0 1 100 0 cm BT /F1 10 Tf 40 700 Td (00000) Tj ET')))).toEqual(['Prix : 1 00000']);
    expect(textOf(await pages(make('q 1 0 0 1 100 0 cm BT /F1 10 Tf 0 700 Td (Prix : 1) Tj ET Q BT /F1 10 Tf 140 700 Td (00000) Tj ET')))).toEqual(['Prix : 100000']);
    expect(textOf(await pages(make('q 1 0 0 1 100 0 cm Q BT /F1 10 Tf 0 700 Td (Prix : 1) Tj ET BT /F1 10 Tf 40 700 Td (00000) Tj ET')))).toEqual(['Prix : 100000']);
    // Un texte tourné se lit le long de sa ligne de base.
    expect(textOf(await pages(make('BT /F1 10 Tf 0 1 -1 0 100 100 Tm (Prix : 1) Tj (00000) Tj ET')))).toEqual(['Prix : 100000']);
    expect(textOf(await pages(make('BT /F1 10 Tf 0 1 -1 0 100 100 Tm (Prix : 1) Tj 0 1 -1 0 100 140 Tm (00000) Tj ET')))).toEqual(['Prix : 100000']);
    expect(textOf(await pages(make('BT /F1 10 Tf 0 1 -1 0 100 100 Tm (Prix : 1) Tj 0 1 -1 0 100 150 Tm (00000) Tj ET')))).toEqual(['Prix : 1 00000']);
    // Un formulaire hérite de l'espacement de qui l'appelle.
    const form = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /Fm 6 0 R >> >> /Contents 5 0 R >>',
      mono,
      { dict: '', data: 'BT 10 Tc ET /Fm Do' },
      { dict: '/Subtype /Form /Resources << /Font << /F1 4 0 R >> >>', data: 'BT /F1 10 Tf 0 700 Td (Prix : 1) Tj ET BT /F1 10 Tf 120 700 Td (00000) Tj ET' },
    ]);
    expect(textOf(await pages(form))).toEqual(['Prix : 100000']);
    // Un formulaire qui continue la ligne de la page : la position décide, pas l'appel.
    const continued = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /Fm 6 0 R >> >> /Contents 5 0 R >>',
      mono,
      { dict: '', data: 'BT /F1 10 Tf 0 100 Td (Prix : 1) Tj ET /Fm Do BT /F1 10 Tf 110 100 Td (euros) Tj ET' },
      { dict: '/Subtype /Form /Resources << /Font << /F1 4 0 R >> >>', data: 'BT /F1 10 Tf 40 100 Td (00000) Tj ET' },
    ]);
    expect(textOf(await pages(continued))).toEqual(['Prix : 100000 euros']);
    // Une montée du texte (Ts) le sort de la ligne.
    expect(textOf(await pages(make('BT /F1 10 Tf 1 0 0 1 0 100 Tm (Prix : 1) Tj 100 Ts (00000) Tj ET')))).toEqual(['Prix : 1\n00000']);
    expect(textOf(await pages(make('BT /F1 10 Tf 1 0 0 1 0 100 Tm (Prix : 1) Tj 0.5 Ts (00000) Tj ET')))).toEqual(['Prix : 100000']);
    // Un recul en fin de TJ compte encore pour le texte suivant, avec ou sans largeurs connues.
    expect(textOf(await pages(make('BT /F1 10 Tf 0 700 Td [(Prix : 1) -1000] TJ (00000) Tj ET')))).toEqual(['Prix : 1 00000']);
    expect(textOf(await pages(simple(['BT /F1 12 Tf [(Prix : 1) -1000] TJ (00000) Tj ET'])))).toEqual(['Prix : 1 00000']);
    expect(textOf(await pages(simple(['BT /F1 12 Tf [(Prix : 1) -1000 (00000)] TJ ET'])))).toEqual(['Prix : 1 00000']);
  });

  it('une table ToUnicode aux destinations démesurées compte leur longueur dans le travail : refusé en mots', async () => {
    const dst = '0041'.repeat(2048);
    const cmap = `begincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <1FFF> <${dst}>\nendbfrange\nendcmap`;
    const bytes = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type0 /BaseFont /Inconnue /Encoding /Identity-H /ToUnicode 6 0 R >>',
      { dict: '', data: 'BT /F2 10 Tf <0001> Tj ET' },
      { dict: '', data: cmap, flate: true },
    ]);
    expect(await pdfPagesText(bytes, { maxWork: 100_000 })).toEqual({ ok: false, rule: null, code: 'too_complex' });
  });

  it('une table ToUnicode à très nombreuses plages de codes se lit sans balayage répété, chevauchements refusés', async () => {
    const n = 20_000;
    const spaces = Array.from({ length: n }, (_, i) => `<${(i * 2).toString(16).padStart(4, '0')}> <${(i * 2).toString(16).padStart(4, '0')}>`).join('\n');
    const last = ((n - 1) * 2).toString(16).padStart(4, '0');
    const cmap = (ranges: string) => `begincmap\n${n} begincodespacerange\n${ranges}\nendcodespacerange\n1 beginbfchar\n<${last}> <0041>\nendbfchar\nendcmap`;
    const make = (ranges: string) =>
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type0 /BaseFont /Inconnue /Encoding /Identity-H /ToUnicode 6 0 R >>',
        { dict: '', data: `BT /F2 10 Tf <${last.repeat(n)}> Tj ET`, flate: true },
        { dict: '', data: cmap(ranges), flate: true },
      ]);
    const started = Date.now();
    const r = await pages(make(spaces));
    expect(r[0]!.text).toBe('A'.repeat(n));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await pages(make(spaces + '\n<0000> <0010>'))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
  });

  it('dans TJ, seuls les reculs nets entre deux textes font un espace', async () => {
    expect(textOf(await pages(simple(['BT /F1 12 Tf [(Prix : 1) -300 300 (00000)] TJ ET'])))).toEqual(['Prix : 100000']);
    expect(textOf(await pages(simple(['BT /F1 12 Tf [(Prix :) -150 -150 (1)] TJ ET'])))).toEqual(['Prix : 1']);
  });

  it('largeurs d’une police composite : plages lues par recherche, chevauchements jamais crus', async () => {
    const withW = (w: string, content: string) =>
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
        '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+NotoSans /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>',
        '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 3 0 R >> >> /Contents 5 0 R >>',
        { dict: '', data: content, flate: true },
        { dict: '', data: TO_UNICODE, flate: true },
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+NotoSans /W ${w} >>`,
      ]);
    const two = (x: number) => `BT /F2 10 Tf 1 0 0 1 72 720 Tm ${cid('Prix')} Tj 1 0 0 1 ${x} 720 Tm ${cid('245')} Tj ET`;
    // P r i x : quatre glyphes de 500, soit 20 au corps 10.
    expect(textOf(await pages(withW('[51 51 500 76 76 500 85 85 500 91 91 500]', two(92))))).toEqual(['Prix245']);
    expect(await pages(withW('[36 87 500 60 70 600]', two(92)))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
    const many = Array.from({ length: 20_000 }, (_, i) => `${1000 + i * 2} ${1000 + i * 2} 500`).join(' ');
    const glyphs = '<' + '0024'.repeat(20_000) + '>';
    const started = Date.now();
    const r = await pdfPagesText(withW(`[${many} 36 87 500]`, `BT /F2 10 Tf 72 720 Td ${glyphs} Tj ET`));
    expect(r.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('[R12] un objet invoqué introuvable ou d’un genre non lu rend la page illisible ; une image non', async () => {
    const make = (xobjects: string, extra: Obj[] = []) =>
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> ${xobjects} >> /Contents 5 0 R >>`,
        HELV,
        { dict: '', data: 'BT /F1 12 Tf (Prix :) Tj ET /Fm Do' },
        ...extra,
      ]);
    expect(await pages(make('/XObject << /Fm 9 0 R >>'))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
    expect(await pages(make(''))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
    expect(await pages(make('/XObject << /Fm 6 0 R >>', [{ dict: '/Subtype /PS', data: 'x' }]))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
    expect(textOf(await pages(make('/XObject << /Fm 6 0 R >>', [{ dict: '/Subtype /Image /Width 1 /Height 1', data: 'x' }])))).toEqual(['Prix :']);
  });

  it('un flux d’objets démesuré compte dans le travail de lecture : refusé en mots', async () => {
    const n = 20_000;
    const header = Array.from({ length: n }, (_, i) => `${i + 10} ${i * 5}`).join(' ') + '\n';
    const body = 'null\n'.repeat(n);
    const data = new Uint8Array(deflateSync(enc(header + body)));
    const bytes = concat([
      simple(['BT /F1 12 Tf (Texte) Tj ET']).subarray(0, 9),
      enc(`9 0 obj\n<< /Type /ObjStm /N ${n} /First ${header.length} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`),
      data,
      enc('\nendstream\nendobj\n'),
      simple(['BT /F1 12 Tf (Texte) Tj ET']).subarray(9),
    ]);
    const started = Date.now();
    expect(await pdfPagesText(bytes, { maxWork: 10_000 })).toEqual({ ok: false, rule: null, code: 'too_complex' });
    expect(textOf(await pages(bytes))).toEqual(['Texte']);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('[R12] une police composite sans ToUnicode : page illisible, jamais un texte deviné', async () => {
    const content = `BT /F2 11 Tf 72 720 Td ${cid('Prix 245000')} Tj ET`;
    expect(await pages(composite(content, { toUnicode: false }))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
  });

  it('[R12] un code absent de la table ToUnicode : page illisible', async () => {
    const content = 'BT /F2 11 Tf 72 720 Td <00440045FFF0> Tj ET';
    expect(await pages(composite(content))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
  });

  it('[R12] une police incorporée sans encodage, ou un glyphe inconnu : page illisible ; les autres pages restent lues', async () => {
    const bytes = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 8 0 R 10 0 R] /Count 3 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /TrueType /BaseFont /QWERTY+Calibri /FontDescriptor 6 0 R >>',
      { dict: '', data: 'BT /F1 12 Tf (\x01\x02\x03) Tj ET' },
      '<< /Type /FontDescriptor /FontName /QWERTY+Calibri /FontFile2 7 0 R >>',
      { dict: '', data: 'fausse police' },
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 9 0 R >> >> /Contents 11 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [65 /g12 /eacute] >> >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 9 0 R >> >> /Contents 12 0 R >>',
      { dict: '', data: 'BT /F1 12 Tf (zAz) Tj ET' },
      { dict: '', data: 'BT /F1 12 Tf (pr) Tj (Bvu) Tj ET' },
    ]);
    const p = await pages(bytes);
    expect(p).toEqual([
      { page: 1, text: null, reason: 'undecodable' },
      { page: 2, text: null, reason: 'undecodable' },
      { page: 3, text: 'prévu' },
    ]);
    expect(pagesToRead(p)).toEqual([1, 2]);
    expect(pagesForReading(p)).toEqual(['', '', 'prévu']);
  });

  it('[R12] une page d’image seule (un scan) est dite sans texte, à lire', async () => {
    const bytes = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
      { dict: '', data: 'q 595 0 0 842 0 0 cm /Im1 Do Q' },
      { dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', data: '\x80' },
    ]);
    expect(await pages(bytes)).toEqual([{ page: 1, text: null, reason: 'no_text' }]);
  });

  it('[R12] un contenu au filtre non lu : page illisible', async () => {
    const bytes = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
      { dict: '/Filter /LZWDecode', data: 'xyz' },
      HELV,
    ]);
    expect(await pages(bytes)).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
  });

  it('lit les objets rangés dans un flux d’objets (PDF 1.5), sans table de références classique', async () => {
    const inner = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', HELV];
    let body = '';
    const head: string[] = [];
    inner.forEach((o, i) => {
      head.push(`${i + 1} ${body.length}`);
      body += o + '\n';
    });
    const header = head.join(' ') + '\n';
    const bytes = concat([
      enc('%PDF-1.5\n'),
      enc(`6 0 obj\n<< /Type /ObjStm /N 4 /First ${header.length} /Filter /FlateDecode /Length 0 >>\nstream\n`),
      new Uint8Array(deflateSync(enc(header + body))),
      enc('\nendstream\nendobj\n'),
      (() => {
        const data = deflateSync(enc('BT /F1 12 Tf 72 720 Td (Dans un flux d objets) Tj ET'));
        return concat([enc(`5 0 obj\n<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), new Uint8Array(data), enc('\nendstream\nendobj\n')]);
      })(),
      enc('7 0 obj\n<< /Type /XRef /Size 8 /Root 1 0 R /W [1 2 1] /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\n0\n%%EOF\n'),
    ]);
    expect(textOf(await pages(bytes))).toEqual(['Dans un flux d objets']);
  });

  it('police changée dans q … Q : la police d’avant revient après Q', async () => {
    const bytes = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
      HELV,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [49 /nine] >> >>',
      { dict: '', data: 'BT /F1 12 Tf (Prix :) Tj q /F2 12 Tf (1) Tj Q (1) Tj ET' },
    ]);
    expect(textOf(await pages(bytes))).toEqual(['Prix :91']);
  });

  it('une police choisie par un état graphique (gs) est appliquée ; mal formée, la page est illisible', async () => {
    const make = (gsFont: string) =>
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /ExtGState << /GS2 << /Type /ExtGState ${gsFont} >> /GS3 << /LW 2 >> >> >> /Contents 6 0 R >>`,
        HELV,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [49 /nine] >> >>',
        { dict: '', data: 'BT /F1 12 Tf /GS3 gs (Prix :1) Tj /GS2 gs (11) Tj ET' },
      ]);
    expect(textOf(await pages(make('/Font [5 0 R 12]')))).toEqual(['Prix :199']);
    expect(await pages(make('/Font 12'))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
  });

  it('[R12] sans encodage : seule une police standard au nom exact et non incorporée est lue', async () => {
    const make = (font: string, extra: Obj[] = []) =>
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        font,
        { dict: '', data: 'BT /F1 12 Tf (Prix 100000) Tj ET' },
        ...extra,
      ]);
    expect(textOf(await pages(make('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>')))).toEqual(['Prix 100000']);
    expect(await pages(make('<< /Type /Font /Subtype /Type1 /BaseFont /HelveticaNeue >>'))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
    expect(await pages(make('<< /Type /Font /Subtype /TrueType /BaseFont /CourierPrime >>'))).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
    const embedded = make('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FontDescriptor 6 0 R >>', ['<< /Type /FontDescriptor /FontName /Helvetica /FontFile 7 0 R >>', { dict: '', data: 'police' }]);
    expect(await pages(embedded)).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
  });

  it('une table ToUnicode aux plages démesurées compte dans le travail de lecture : refusé en mots', async () => {
    const ranges = Array.from({ length: 200 }, (_, i) => `<${(i * 256).toString(16).padStart(4, '0')}00> <${(i * 256).toString(16).padStart(4, '0')}FF> <0041>`).join('\n');
    const cmap = `begincmap\n1 begincodespacerange\n<000000> <FFFFFF>\nendcodespacerange\n200 beginbfrange\n${ranges}\nendbfrange\nendcmap`;
    const bytes = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>',
      { dict: '', data: 'BT /F1 12 Tf (A) Tj ET' },
      { dict: '', data: cmap, flate: true },
    ]);
    expect(await pdfPagesText(bytes, { maxWork: 10_000 })).toEqual({ ok: false, rule: null, code: 'too_complex' });
  });

  it('des formulaires répétés et imbriqués ne font pas travailler sans fin : refusé en mots', async () => {
    const calls = Array.from({ length: 20 }, () => '/Fm Do').join(' ');
    const bytes = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /Fm 5 0 R >> >> /Contents 8 0 R >>',
      HELV,
      { dict: '/Subtype /Form /Resources << /XObject << /Fm 6 0 R >> >>', data: calls },
      { dict: '/Subtype /Form /Resources << /XObject << /Fm 7 0 R >> >>', data: calls },
      { dict: '/Subtype /Form /Resources << /Font << /F1 4 0 R >> >>', data: `BT /F1 12 Tf (${'x'.repeat(1000)}) Tj ET`, flate: true },
      { dict: '', data: calls },
    ]);
    const started = Date.now();
    expect(await pdfPagesText(bytes, { maxWork: 1_000_000 })).toEqual({ ok: false, rule: null, code: 'too_complex' });
    // Un grand tableau TJ lu à chaque appel d'un formulaire compte chacun de ses éléments.
    const zeros = Array(100_000).fill('0').join(' ');
    const big = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /Fm 5 0 R >> >> /Contents 6 0 R >>',
      HELV,
      { dict: '/Subtype /Form /Resources << /Font << /F1 4 0 R >> >>', data: `BT /F1 12 Tf [(a) ${zeros} (b)] TJ ET`, flate: true },
      { dict: '', data: Array(100).fill('/Fm Do').join(' ') },
    ]);
    expect(await pdfPagesText(big, { maxWork: 300_000 })).toEqual({ ok: false, rule: null, code: 'too_complex' });
    // Une police à très grande table de largeurs, choisie à chaque appel d'un formulaire : lue une fois, comptée.
    const wide = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm 5 0 R >> >> /Contents 6 0 R >>',
      `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /FirstChar 0 /Widths [${Array(100_000).fill(500).join(' ')}] >>`,
      { dict: '/Subtype /Form /Resources << /Font << /F1 4 0 R >> >>', data: 'BT /F1 12 Tf 0 700 Td (a) Tj ET' },
      { dict: '', data: Array(200).fill('/Fm Do').join(' ') },
    ]);
    expect(await pdfPagesText(wide, { maxWork: 50_000 })).toEqual({ ok: false, rule: null, code: 'too_complex' });
    const t0 = Date.now();
    expect((await pdfPagesText(wide)).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('[R12] une table ToUnicode donnée mais illisible ne cède pas au codage de base : page illisible', async () => {
    const bytes = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>',
      { dict: '', data: 'BT /F1 12 Tf (Prix : 100000) Tj ET' },
      { dict: '/Filter /LZWDecode', data: 'illisible' },
    ]);
    expect(await pages(bytes)).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
    const empty = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode /Identity-H >>',
      { dict: '', data: 'BT /F1 12 Tf (Prix : 100000) Tj ET' },
    ]);
    expect(await pages(empty)).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
  });

  describe('versions d’un objet (fichier modifié par ajouts)', () => {
    /** Un flux d'objets qui range les objets donnés, par numéro. */
    function objStm(num: number, objs: [number, string][]): Uint8Array {
      let body = '';
      const head: string[] = [];
      for (const [n, o] of objs) {
        head.push(`${n} ${body.length}`);
        body += o + '\n';
      }
      const header = head.join(' ') + '\n';
      const data = new Uint8Array(deflateSync(enc(header + body)));
      return concat([enc(`${num} 0 obj\n<< /Type /ObjStm /N ${objs.length} /First ${header.length} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, enc('\nendstream\nendobj\n')]);
    }
    const stream = (num: number, text: string) => enc(`${num} 0 obj\n<< /Length ${text.length} >>\nstream\n${text}\nendstream\nendobj\n`);
    const PAGE = (contents: number) => `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R >>`;
    const base = () => [
      enc('%PDF-1.5\n'),
      enc('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n'),
      enc(`3 0 obj\n${HELV}\nendobj\n`),
      stream(5, 'BT /F1 12 Tf (Prix : 100000) Tj ET'),
      stream(6, 'BT /F1 12 Tf (Prix : 200000) Tj ET'),
    ];

    it('deux versions en clair : la dernière écrite, celle de l’ajout, est lue', async () => {
      const bytes = concat([...base(), enc(`4 0 obj\n${PAGE(5)}\nendobj\n`), enc('%%EOF\n'), enc(`4 0 obj\n${PAGE(6)}\nendobj\n`), enc('trailer\n<< /Root 1 0 R >>\n%%EOF\n')]);
      expect(textOf(await pages(bytes))).toEqual(['Prix : 200000']);
    });

    it('une version en clair et une compressée : la page est illisible, jamais l’ancien prix', async () => {
      const bytes = concat([...base(), enc(`4 0 obj\n${PAGE(5)}\nendobj\n`), objStm(7, [[4, PAGE(6)]]), enc('trailer\n<< /Root 1 0 R >>\n%%EOF\n')]);
      expect(await pages(bytes)).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
    });

    it('deux versions dans deux flux d’objets : illisible si elles diffèrent, lue si elles sont identiques', async () => {
      const differ = concat([...base(), objStm(7, [[4, PAGE(5)]]), objStm(8, [[4, PAGE(6)]]), enc('trailer\n<< /Root 1 0 R >>\n%%EOF\n')]);
      expect(await pages(differ)).toEqual([{ page: 1, text: null, reason: 'undecodable' }]);
      const same = concat([...base(), objStm(7, [[4, PAGE(6)]]), objStm(8, [[4, PAGE(6)]]), enc('trailer\n<< /Root 1 0 R >>\n%%EOF\n')]);
      expect(textOf(await pages(same))).toEqual(['Prix : 200000']);
    });

    it('une liste de pages en deux versions ambiguës : refusée', async () => {
      const bytes = concat([
        enc('%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n'),
        enc(`3 0 obj\n${HELV}\nendobj\n4 0 obj\n${PAGE(5)}\nendobj\n`),
        stream(5, 'BT /F1 12 Tf (Texte) Tj ET'),
        objStm(7, [[2, '<< /Type /Pages /Kids [] /Count 0 >>']]),
        enc('trailer\n<< /Root 1 0 R >>\n%%EOF\n'),
      ]);
      expect(await pdfPagesText(bytes)).toEqual({ ok: false, rule: null, code: 'unreadable' });
    });
  });

  it('refuse en mots, sans exception : chiffré, pas un PDF, trop gros, trop de pages, bombe de décompression, abîmé', async () => {
    const one = simple(['BT /F1 12 Tf (Texte) Tj ET']);
    const encrypted = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', '<< /Filter /Standard /V 2 /R 3 >>'], { trailer: '/Encrypt 3 0 R' });
    expect(await pdfPagesText(encrypted)).toEqual({ ok: false, rule: null, code: 'encrypted' });
    expect(await pdfPagesText(enc('Bonjour, ceci est un texte.'))).toEqual({ ok: false, rule: null, code: 'not_pdf' });
    expect(await pdfPagesText(one, { maxBytes: 100 })).toEqual({ ok: false, rule: null, code: 'too_large' });
    expect(await pdfPagesText(simple(['BT ET', 'BT ET', 'BT ET']), { maxPages: 2 })).toEqual({ ok: false, rule: null, code: 'too_many_pages' });
    const bomb = simple(['BT /F1 12 Tf (' + 'a'.repeat(2_000_000) + ') Tj ET'], { flate: true });
    expect(bomb.length).toBeLessThan(20_000);
    expect(await pdfPagesText(bomb, { maxInflatedBytes: 1_000_000 })).toEqual({ ok: false, rule: null, code: 'inflate_limit' });
    expect(await pdfPagesText(enc('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R\nendobj\n%%EOF'))).toEqual({ ok: false, rule: null, code: 'unreadable' });
    expect(await pdfPagesText(one.subarray(0, 60))).toEqual({ ok: false, rule: null, code: 'unreadable' });
    const cycle = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Pages /Kids [2 0 R] /Count 1 >>']);
    expect(await pdfPagesText(cycle)).toEqual({ ok: false, rule: null, code: 'unreadable' });
    expect(await pdfPagesText('pas des octets' as unknown as Uint8Array)).toEqual({ ok: false, rule: null, code: 'not_pdf' });
    for (const code of PDF_TEXT_REFUSALS) expect(PDF_TEXT_REFUSAL_TEXT[code]).toMatch(/\.$/);
  });

  it('un flux compressé abîmé rend la page illisible, pas le fichier', async () => {
    const bad = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      { dict: '/Filter /FlateDecode', data: 'pas du tout compressé' },
      HELV,
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
      { dict: '', data: 'BT /F1 12 Tf (Lisible) Tj ET' },
    ]);
    expect(await pages(bad)).toEqual([
      { page: 1, text: null, reason: 'undecodable' },
      { page: 2, text: 'Lisible' },
    ]);
  });

  it('[R511] le texte tiré du PDF suffit à la prélecture : un prix retrouvé sur sa page est proposé, une page illisible reste à lire', async () => {
    const bytes = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
      HELV,
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
      { dict: '', data: 'BT /F1 11 Tf 72 720 Td (Compromis de vente) Tj 0 -14 Td (Le prix de vente est fix\\351 \\340 245 000 euros.) Tj ET', flate: true },
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 7 0 R >> >> /Contents 8 0 R >>',
      '<< /Type /Font /Subtype /Type0 /BaseFont /Inconnue /Encoding /Identity-H >>',
      { dict: '', data: 'BT /F2 11 Tf <00440045> Tj ET' },
    ]);
    const r = await pdfPagesText(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const texts = pagesForReading(r.value.pages);
    expect(excerptsOf(texts).map((e) => e.page)).toEqual([1]);
    const read = verifyReading(texts, { priceEur: { value: 245000, page: 1 } });
    expect(read.proposal.priceEur).toEqual({ value: 245000, page: 1 });
    expect(verifyReading(texts, { priceEur: { value: 245000, page: 2 } }).proposal.priceEur).toBeNull();
    expect(pagesToRead(r.value.pages)).toEqual([2]);
  });

  it('ne range rien et n’écrit rien : une fonction pure, sans base ni journal', async () => {
    expect(pdfPagesText.length).toBe(1);
    const a = await pdfPagesText(simple(['BT /F1 12 Tf (Texte) Tj ET']));
    const b = await pdfPagesText(simple(['BT /F1 12 Tf (Texte) Tj ET']));
    expect(a).toEqual(b);
    const source = readFileSync(new URL('../src/documents/texte-pdf.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^import /m);
  });
});
