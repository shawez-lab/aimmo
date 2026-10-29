import { describe, expect, it } from 'vitest';
import { frenchDate, frenchMonth, renderPricePage, sourceLine, type CommunePrices, type PublicCell } from '../src/attirer/index.ts';
import { BUDGETS, budgetProblems, htmlProblems } from '../src/design/audit.ts';
import { DESIGN_CSS } from '../src/design/systeme.ts';

// Tout est inventé : commune, quartiers, chiffres.
const commune = { slug: 'commune-test', name: 'Commune Test', level: 'commune' as const };
const ouest = { slug: 'ouest', name: 'Ouest', level: 'quartier' as const };
const est = { slug: 'est', name: 'Est', level: 'quartier' as const };
const cell = (zone: PublicCell['zone'], kind: PublicCell['kind'], sales: number, median: number, q1: number, q3: number, over: Partial<PublicCell> = {}): PublicCell => ({
  zone,
  kind,
  status: 'publiee',
  sales,
  median,
  q1,
  q3,
  source: 'DVF, jeu inventé',
  dvfLastSale: '2026-06-30',
  period: { from: '2024-07-01', to: '2026-06-30' },
  ...over,
});
const PRICES: CommunePrices = {
  versionId: 'v1',
  computedAt: '2026-10-29T08:00:00.000Z',
  cells: [
    cell(commune, 'apartment', 13, 2600, 2250, 3250),
    cell(commune, 'house', 8, 2870, 2410, 3330),
    cell(ouest, 'apartment', 7, 2300, 2100, 2500),
    cell(est, 'apartment', 6, 3250, 3100, 3400, { status: 'reprise', source: 'DVF, publication précédente', dvfLastSale: '2025-12-31' }),
  ],
  held: [
    { zone: ouest, kind: 'house', reason: 'seuil' },
    { zone: est, kind: 'house', reason: 'difference' },
  ],
};
const OPTS = { communeSlug: 'commune-test', estimateHref: '/estimer', siteUrl: 'https://reseau.exemple.test' };
const page = (over: Partial<typeof OPTS & { quarterSlug: string | null }> = {}, prices = PRICES) => {
  const r = renderPricePage(prices, { ...OPTS, ...over });
  if (!r.ok) throw new Error(r.code);
  return r.html;
};
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
const N = ' ';
const B = ' ';

describe('AT02 · pages de prix publiques', () => {
  it('dates écrites en français', () => {
    expect(frenchDate('2026-06-30')).toBe('30 juin 2026');
    expect(frenchDate('2026-02-01')).toBe('1er février 2026');
    expect(frenchMonth('2024-07-01')).toBe('juillet 2024');
  });

  it('[R150] seules des cases publiables sont montrées : une case retenue ne montre aucun chiffre, seulement sa raison', () => {
    const html = page();
    const text = visible(html);
    expect(text).toContain(`2${N}600${B}€/m²`);
    expect(text).toContain(`La moitié des ventes entre 2${N}250${B}€/m² et 3${N}250${B}€/m²`);
    expect(text).toContain('sur 13 ventes, de juillet 2024 à juin 2026');
    // Ouest, maisons : seuil ; Est, maisons : différence. Aucun chiffre pour elles, dans le texte comme dans les données.
    expect(text).toContain('Pas assez de ventes');
    expect(text).toContain('Chiffre retenu');
    const q = page({ quarterSlug: 'est' });
    expect(visible(q)).toContain('Chiffre retenu : publié, il laisserait retrouver une vente par différence avec un autre.');
    expect((q.match(/class="grand/g) ?? []).length).toBe(1);
    // Une case qui arriverait incomplète ou retenue n'est jamais montrée, même si on la glisse parmi les cases montrables.
    const tricked: CommunePrices = {
      ...PRICES,
      cells: [
        cell(commune, 'apartment', 13, 2600, 2250, 3250, { status: 'retenue' as never }),
        cell(commune, 'house', 0, 2870, 2410, 3330),
        cell(ouest, 'apartment', 7, 2300, 2100, 2500, { source: '' }),
      ],
      held: [],
    };
    const t = page({}, tricked);
    expect(visible(t)).not.toMatch(/2 600|2 870|2 300/);
    expect(t).not.toMatch(/"value":(?:2600|2870|2300)/);
  });

  it('[R150] [R29] aucune adresse, aucune date ni aucun prix d’une vente isolée : seulement des chiffres regroupés', () => {
    const html = page();
    expect(html).not.toMatch(/\b\d{1,3}\s*(?:bis|ter)?,?\s*(?:rue|avenue|boulevard|chemin|place)\b/i);
    // Les seules dates : la période commune à la version et la date de publication des ventes.
    const days = [...visible(html).matchAll(/\b(\d{1,2}(?:er)?) (janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre) (\d{4})\b/g)].map((m) => m[0]);
    expect(new Set(days)).toEqual(new Set(['30 juin 2026', '31 décembre 2025']));
  });

  it('[R151] chaque chiffre est suivi de sa source et de sa date', () => {
    const html = page();
    for (const c of PRICES.cells) expect(visible(html)).toContain(c.status === 'reprise' ? 'DVF, publication précédente, 31 décembre 2025' : sourceLine(c));
    // Chaque bloc de chiffres porte sa ligne de source, et la reprise le dit.
    const blocks = html.match(/<section class="case"[\s\S]*?<\/section>/g)!;
    expect(blocks).toHaveLength(2);
    for (const b of blocks) expect(b).toMatch(/Source : DVF, jeu inventé, ventes publiées jusqu’au 30 juin 2026\./);
    expect(sourceLine(PRICES.cells[3]!)).toBe('Source : DVF, publication précédente, ventes publiées jusqu’au 31 décembre 2025. Chiffres de la publication précédente, gardés pour qu’aucune vente ne puisse être retrouvée.');
    expect(visible(page({ quarterSlug: 'est' }))).toContain('Chiffres de la publication précédente');
    // Chaque ligne du tableau des quartiers aussi.
    const rows = html.match(/<tr><th scope="row">[\s\S]*?<\/tr>/g)!;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      const figures = (r.match(/€\/m²/g) ?? []).length;
      const sources = (r.match(/DVF, /g) ?? []).length;
      expect(sources).toBe(figures);
    }
  });

  it('la méthode est expliquée, l’estimation en ligne proposée, et les données structurées ne décrivent que des chiffres regroupés', () => {
    const html = page();
    expect(html).toContain('Comment ces prix sont calculés');
    expect(html).toContain('<a class="appel" href="/estimer">Estimer mon logement</a>');
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!);
    expect(ld['@type']).toBe('Dataset');
    expect(ld.url).toBe('https://reseau.exemple.test/prix/commune-test');
    expect(ld.temporalCoverage).toBe('2024-07/2026-06');
    expect(ld.isBasedOn).toEqual(['DVF, jeu inventé']);
    expect(ld.variableMeasured.map((v: { value: number }) => v.value)).toEqual([2600, 2870]);
    // Une page de quartier a ses propres données, et un lien vers sa commune.
    const q = page({ quarterSlug: 'ouest' });
    expect(q).toContain('<a href="/prix/commune-test">Prix à Commune Test</a>');
    expect(JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(q)![1]!).name).toBe('Prix de l’immobilier à Ouest, Commune Test');
    // Le tableau de la commune mène à chaque quartier.
    expect(html).toContain('<a href="/prix/commune-test/est">Est</a>');
    expect(html).toContain('<a href="/prix/commune-test/ouest">Ouest</a>');
  });

  it('un nom de zone ne peut rien injecter, ni dans la page ni dans les données structurées', () => {
    const evil = { slug: 'commune-test', name: '</script><img src=x onerror=alert(1)>', level: 'commune' as const };
    const html = page({}, { ...PRICES, cells: [cell(evil, 'apartment', 13, 2600, 2250, 3250)], held: [] });
    expect(html).not.toContain('<img src=x');
    expect((html.match(/<\/script>/g) ?? []).length).toBe(1);
  });

  it('une commune et un quartier du même nom court restent deux pages distinctes', () => {
    const twin = { slug: 'commune-test', name: 'Centre', level: 'quartier' as const };
    const prices: CommunePrices = { ...PRICES, cells: [...PRICES.cells, cell(twin, 'apartment', 9, 3900, 3500, 4200)] };
    const c = visible(page({}, prices));
    expect(c).toContain(`2${N}600${B}€/m²`);
    expect(page({}, prices)).toContain('<a href="/prix/commune-test/commune-test">Centre</a>');
    const q = visible(page({ quarterSlug: 'commune-test' }, prices));
    expect(q).toContain(`3${N}900${B}€/m²`);
    expect(q).not.toContain(`2${N}600${B}€/m²`);
  });

  it('une zone inconnue, un quartier d’une autre commune ou une adresse douteuse ne donnent pas de page', () => {
    expect(renderPricePage(PRICES, { ...OPTS, communeSlug: 'autre' })).toEqual({ ok: false, code: 'zone_inconnue' });
    expect(renderPricePage(PRICES, { ...OPTS, communeSlug: 'ouest' })).toEqual({ ok: false, code: 'zone_inconnue' });
    expect(renderPricePage(PRICES, { ...OPTS, quarterSlug: 'nord' })).toEqual({ ok: false, code: 'zone_inconnue' });
    expect(renderPricePage(PRICES, { ...OPTS, quarterSlug: 'commune-test' })).toEqual({ ok: false, code: 'zone_inconnue' });
    expect(renderPricePage(PRICES, { ...OPTS, quarterSlug: '../x' })).toEqual({ ok: false, code: 'zone_inconnue' });
    expect(renderPricePage(PRICES, { ...OPTS, estimateHref: 'javascript:alert(1)' })).toEqual({ ok: false, code: 'adresse_invalide' });
    expect(renderPricePage(PRICES, { ...OPTS, siteUrl: 'http://reseau.exemple.test' })).toEqual({ ok: false, code: 'adresse_invalide' });
  });

  it('[R07] « agent immobilier » et « offert », jamais « mandataire » ni « gratuit »', () => {
    for (const html of [page(), page({ quarterSlug: 'ouest' })]) {
      const t = visible(html).toLowerCase();
      expect(t).toContain('agent immobilier');
      expect(t).toContain('offert');
      expect(t).not.toMatch(/mandataire|gratuit/);
    }
  });

  it('[R201] la page passe le contrôle du système de design et tient dans 14 Ko compressés', () => {
    for (const html of [page(), page({ quarterSlug: 'ouest' }), page({ quarterSlug: 'est' })]) {
      expect(htmlProblems(html)).toEqual([]);
      expect(budgetProblems({ html }, BUDGETS.page)).toEqual([]);
      expect(/<style>([\s\S]*?)<\/style>/.exec(html)![1]!.startsWith(DESIGN_CSS)).toBe(true);
      expect(html).toMatch(/class="marque"/);
    }
  });
});
