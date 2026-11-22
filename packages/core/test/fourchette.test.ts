import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGE_SETTINGS, Fourchette, adjustmentsFor, departmentOf, type EstimatedProperty, type Sale, type SalesCoverage, type SalesSource } from '../src/index.ts';

// Ventes inventées, tirées par un générateur fixe : le même jeu a servi à relever les résultats de la méthode du site.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function sales(seed: number, n: number, lat0: number, lon0: number, spread: number, prefix: string): Sale[] {
  const r = rng(seed);
  const out: Sale[] = [];
  for (let i = 0; i < n; i++) {
    const kind = r() < 0.6 ? 'apartment' : 'house';
    const surface = Math.round(30 + r() * 120);
    const pricePerM2 = Math.round(1800 + r() * 2200);
    const m = 202301 + Math.floor(r() * 3) * 100 + Math.floor(r() * 12);
    const lat = Number((lat0 + (r() - 0.5) * spread).toFixed(5));
    const lon = Number((lon0 + (r() - 0.5) * spread).toFixed(5));
    r();
    if (kind === 'house') r();
    out.push({ id: `${prefix}${i}`, kind, lat, lon, surface, pricePerM2, month: `${Math.floor(m / 100)}-${String(m % 100).padStart(2, '0')}` });
  }
  return out;
}

const COVERAGE: SalesCoverage = { department: '21', lastSale: '2025-12-30', years: [2023, 2024, 2025], source: 'DVF test' };

class MemorySales implements SalesSource {
  calls = 0;
  constructor(
    readonly all: readonly Sale[],
    private readonly cover: SalesCoverage | null = COVERAGE,
  ) {}
  async coverage() {
    return this.cover;
  }
  async within(kind: Sale['kind']) {
    this.calls++;
    return this.all.filter((s) => s.kind === kind);
  }
}

const ALL = [...sales(7, 400, 47.322, 5.041, 0.02, 'a'), ...sales(11, 60, 47.3, 5.1, 0.08, 'b')];
const OCT_2026 = () => new Date('2026-10-27T10:00:00.000Z');
const range = (src: SalesSource = new MemorySales(ALL), now = OCT_2026) => new Fourchette(src, DEFAULT_RANGE_SETTINGS, now);
// La méthode du site ne borne pas l'ancienneté des ventes : la comparer demande une fenêtre ouverte (AU048).
const siteMethod = () => new Fourchette(new MemorySales(ALL), { ...DEFAULT_RANGE_SETTINGS, maxSaleAgeMonths: 1200 }, OCT_2026);
const flat = (over: Partial<EstimatedProperty>): EstimatedProperty => ({ kind: 'apartment', surface: 65, lat: 47.3225, lon: 5.0412, postalCode: '21000', ...over });

describe('E01 · fourchette de prix par le code', () => {
  it('donne les mêmes résultats que la méthode du site sur des cas inventés', async () => {
    const cases: [EstimatedProperty, Record<string, unknown>][] = [
      [flat({ condition: 'bon', floor: 2 }), { low: 161000, high: 197000, pricePerM2: 2758, medianPerM2: 2758, radius: 500, n: 32, adj: [] }],
      [
        flat({ surface: 42, lat: 47.318, lon: 5.045, condition: 'rafraichir', floor: 4, elevator: false, balcony: true, cellar: true }),
        { low: 102000, high: 125000, pricePerM2: 2697, medianPerM2: 2932, radius: 500, n: 19, adj: [['État général', -5], ['Étage élevé sans ascenseur', -6], ['Balcon', 2], ['Cave', 1]] },
      ],
      [
        { kind: 'house', surface: 120, lat: 47.322, lon: 5.041, postalCode: '21000', pool: true, garage: true, land: 900, era: 'apres2012' },
        { low: 338000, high: 413000, pricePerM2: 3127, medianPerM2: 2817, radius: 500, n: 35, adj: [['Époque de construction', 4], ['Piscine', 4], ['Garage', 3]] },
      ],
      [
        { kind: 'house', surface: 95, lat: 47.33, lon: 5.09, postalCode: '21800', condition: 'travaux', land: 100 },
        { low: 209000, high: 265000, pricePerM2: 2495, medianPerM2: 2935, radius: 3500, n: 40, adj: [['État général', -12], ['Petit terrain', -3]] },
      ],
    ];
    for (const [property, expected] of cases) {
      const r = await siteMethod().estimate(property);
      if (!r.ok) throw new Error(`pas de fourchette : ${r.reason}`);
      expect({
        low: r.low,
        high: r.high,
        pricePerM2: r.pricePerM2,
        medianPerM2: r.medianPerM2,
        radius: r.radius,
        n: r.comparables.length,
        adj: r.adjustments.map((a) => [a.label, a.pct]),
      }).toEqual(expected);
    }
  });

  it('[R27] chaque comparable est une vente de la source, avec sa date, et rien n’est inventé', async () => {
    const r = await range().estimate(flat({}));
    if (!r.ok) throw new Error(r.reason);
    const byId = new Map(ALL.map((s) => [s.id, s]));
    for (const c of r.comparables) {
      const sale = byId.get(c.id);
      expect(sale).toBeDefined();
      expect(c).toMatchObject({ month: sale!.month, pricePerM2: sale!.pricePerM2, surface: sale!.surface, kind: 'apartment' });
      expect(c.month).toMatch(/^\d{4}-\d{2}$/);
    }
    const sorted = r.comparables.map((c) => c.pricePerM2).sort((a, b) => a - b);
    expect(r.medianPerM2).toBeGreaterThanOrEqual(sorted[0]!);
    expect(r.medianPerM2).toBeLessThanOrEqual(sorted[sorted.length - 1]!);
  });

  it('[R27] moins de 5 comparables : pas de fourchette, avec sa raison', async () => {
    const few = ALL.filter((s) => s.kind === 'apartment').slice(0, 200);
    const r = await range(new MemorySales(few)).estimate(flat({ lat: 47.2, lon: 5.3, postalCode: '21110' }));
    expect(r).toMatchObject({ ok: false, reason: 'peu_de_ventes', comparablesFound: 0 });
    const four = ALL.filter((s) => s.kind === 'apartment').slice(0, 4).map((s) => ({ ...s, lat: 47.3225, lon: 5.0412, surface: 65, month: '2025-03' }));
    expect(await range(new MemorySales(four)).estimate(flat({}))).toMatchObject({ ok: false, reason: 'peu_de_ventes', comparablesFound: 4 });
    const five = ALL.filter((s) => s.kind === 'apartment').slice(0, 5).map((s) => ({ ...s, lat: 47.3225, lon: 5.0412, surface: 65, month: '2025-03' }));
    expect((await range(new MemorySales(five)).estimate(flat({}))).ok).toBe(true);
  });

  it('[R27] pas de fourchette sans logement, sans adresse, ou hors de la zone des données', async () => {
    expect(await range().estimate(flat({ kind: 'land' }))).toMatchObject({ ok: false, reason: 'type' });
    expect(await range().estimate(flat({ kind: 'commercial' }))).toMatchObject({ ok: false, reason: 'type' });
    expect(await range().estimate(flat({ lat: null }))).toMatchObject({ ok: false, reason: 'adresse' });
    expect(await range().estimate(flat({ surface: 0 }))).toMatchObject({ ok: false, reason: 'adresse' });
    expect(await range().estimate(flat({ postalCode: '75001' }))).toMatchObject({ ok: false, reason: 'hors_zone' });
    expect(await range(new MemorySales(ALL, null)).estimate(flat({}))).toMatchObject({ ok: false, reason: 'donnees_absentes' });
  });

  it('[R28] la date des dernières ventes est toujours rendue, et l’absence des plus récentes signalée', async () => {
    const late = await range().estimate(flat({}));
    expect(late.data).toMatchObject({ lastSale: '2025-12-30', years: [2023, 2024, 2025], source: 'DVF test', recentMissing: true, monthsSinceLastSale: 10 });
    const fresh = await range(new MemorySales(ALL), () => new Date('2026-02-15T10:00:00.000Z')).estimate(flat({}));
    expect(fresh.data).toMatchObject({ recentMissing: false, monthsSinceLastSale: 2 });
    if (!late.ok) throw new Error(late.reason);
    expect(late.latestUsedSale).toBe(late.comparables.map((c) => c.month).sort().at(-1));
    // Des comparables anciens dans des données récentes : c'est la date des ventes utilisées qui est dite.
    const old = ALL.filter((s) => s.kind === 'apartment').slice(0, 6).map((s) => ({ ...s, lat: 47.3225, lon: 5.0412, surface: 65, month: '2024-01' }));
    const aged = await range(new MemorySales(old, { ...COVERAGE, lastSale: '2026-10-01' })).estimate(flat({}));
    expect(aged).toMatchObject({ ok: true, latestUsedSale: '2024-01', data: { lastSale: '2026-10-01' } });
    const refused = await range().estimate(flat({ kind: 'land' }));
    expect(refused.data.lastSale).toBe('2025-12-30');
  });

  it('[R28] Bas-Rhin, Haut-Rhin, Moselle et Mayotte : pas de ventes DVF, et c’est dit', async () => {
    for (const postalCode of ['67000', '68100', '57000', '97600']) {
      const src = new MemorySales(ALL, { ...COVERAGE, department: postalCode.startsWith('97') ? '976' : postalCode.slice(0, 2) });
      const r = await range(src).estimate(flat({ postalCode }));
      expect(r, postalCode).toMatchObject({ ok: false, reason: 'dvf_non_couvert', data: { dvfNotCovered: true } });
      expect(src.calls).toBe(0);
    }
    expect((await range().estimate(flat({}))).data.dvfNotCovered).toBe(false);
  });

  it('le diagnostic énergétique ajuste le prix, dans les bornes', async () => {
    expect(adjustmentsFor(flat({ floor: 2, energyClass: 'G' })).lines).toEqual([['Diagnostic énergétique', -0.08]]);
    expect(adjustmentsFor(flat({ floor: 2, energyClass: 'D' })).lines).toEqual([]);
    const worst = adjustmentsFor(flat({ condition: 'travaux', era: '1948-1974', floor: 6, elevator: false, energyClass: 'G' }));
    expect(worst.total).toBe(-0.25);
    const a = await range().estimate(flat({ floor: 2, energyClass: 'A' }));
    const g = await range().estimate(flat({ floor: 2, energyClass: 'G' }));
    if (!a.ok || !g.ok) throw new Error('fourchette attendue');
    expect(a.low).toBeGreaterThan(g.low);
  });

  it('département d’un code postal', () => {
    expect(departmentOf('21000')).toBe('21');
    expect(departmentOf('97600')).toBe('976');
    expect(departmentOf('20000')).toBe('20');
    expect(departmentOf('2100')).toBeNull();
  });
});

describe('AU048 · la fenêtre de temps des ventes retenues', () => {
  const near = (month: string, i: number): Sale => ({ id: `w${i}-${month}`, kind: 'apartment', lat: 47.3225, lon: 5.0412 + i * 0.00001, surface: 65, pricePerM2: 2500 + i, month });

  it('constat : des ventes de 2020 suffisaient pour une fourchette ; elles sont maintenant écartées [R691]', async () => {
    const old = Array.from({ length: 6 }, (_, i) => near('2020-01', i));
    const r = await range(new MemorySales(old)).estimate(flat({}));
    expect(r).toMatchObject({ ok: false, reason: 'peu_de_ventes', comparablesFound: 0 });
  });

  it('[R691] seules les ventes des 36 mois avant l’estimation sont retenues ; la fenêtre, sa raison et les ventes écartées sont rendues', async () => {
    const mixed = [...Array.from({ length: 6 }, (_, i) => near('2025-06', i)), near('2023-10', 7), near('2023-09', 8), near('2019-05', 9)];
    const r = await range(new MemorySales(mixed)).estimate(flat({}));
    if (!r.ok) throw new Error(r.reason);
    expect(r.window).toEqual({ months: 36, from: '2023-10', excludedOld: 2, justification: expect.stringContaining('trop changé') });
    expect(r.comparables.map((c) => c.month).sort()).toEqual(['2023-10', '2025-06', '2025-06', '2025-06', '2025-06', '2025-06', '2025-06']);
    expect(r.comparables.every((c) => c.month >= r.window.from)).toBe(true);
  });

  it('[R691] la fenêtre suit la date de l’estimation et son réglage ; les ventes anciennes font élargir le rayon', async () => {
    const jan = await range(new MemorySales(ALL), () => new Date('2026-01-31T23:00:00.000Z')).estimate(flat({}));
    if (!jan.ok) throw new Error(jan.reason);
    expect(jan.window.from).toBe('2023-01');
    const two = await new Fourchette(new MemorySales(ALL), { ...DEFAULT_RANGE_SETTINGS, maxSaleAgeMonths: 24 }, OCT_2026).estimate(flat({}));
    if (!two.ok) throw new Error(two.reason);
    expect(two.window).toMatchObject({ months: 24, from: '2024-10' });
    expect(two.comparables.every((c) => c.month >= '2024-10')).toBe(true);
    // Moins de ventes récentes près du bien : le rayon s'élargit plutôt que de garder des ventes anciennes.
    const close = [...Array.from({ length: 8 }, (_, i) => near('2019-01', i)), ...Array.from({ length: 12 }, (_, i) => ({ ...near('2025-01', 20 + i), lat: 47.3225 + 0.0045 }))];
    const wide = await range(new MemorySales(close)).estimate(flat({}));
    if (!wide.ok) throw new Error(wide.reason);
    expect(wide.comparables).toHaveLength(12);
    expect(wide.radius).toBeGreaterThan(300);
    expect(wide.window.excludedOld).toBe(8);
  });
});
