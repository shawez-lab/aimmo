import { describe, expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import type { EstimatedKind, Sale, SalesCoverage, SalesSource } from '../src/estimation/fourchette.ts';
import {
  PrixRegroupes,
  decideBlock,
  figuresOf,
  insideRing,
  minus,
  ringSelfCrosses,
  ringsOverlap,
  roundPrice,
  saleSet,
  subsetRevealing,
  windowOf,
  type CellDecision,
  type CellSale,
  type LatLon,
  type ShownCell,
  renderPricePage,
  sourceLine,
} from '../src/attirer/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

/** Des ventes inventées : `n` ventes d'empreintes `p-0`, `p-1`… au prix donné. */
function sales(prefix: string, prices: number[]): CellSale[] {
  return prices.map((p, i) => ({ fingerprint: `${prefix}-${i}`, pricePerM2: p }));
}
const flat = (prefix: string, n: number, price = 2500) => sales(prefix, Array.from({ length: n }, () => price));

/** Un générateur pseudo-aléatoire fixe, pour des jeux inventés reproductibles. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Le contrôle indépendant du calcul : pour des cases montrées (ensembles de ventes), aucun groupe de quartiers retiré
 * de la commune, et aucune paire de cases dont l'une contient l'autre, ne laisse un reste de 1 à k - 1 ventes.
 * Énumère tous les groupes, sans programmation dynamique.
 */
function leaks(commune: Map<string, number> | null, quarters: Map<string, number>[], others: Map<string, number>[], k: number): string[] {
  const found: string[] = [];
  const size = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  if (commune) {
    for (let mask = 1; mask < 1 << quarters.length; mask++) {
      let sum = 0;
      for (let i = 0; i < quarters.length; i++) if (mask & (1 << i)) sum += size(quarters[i]!);
      const rest = size(commune) - sum;
      if (rest >= 1 && rest < k) found.push(`groupe ${mask} : reste ${rest}`);
    }
  }
  const shown = [...(commune ? [commune] : []), ...quarters];
  for (const a of shown) {
    for (const b of others) {
      const ab = minus(a, b);
      const ba = minus(b, a);
      if ((ba === 0 && ab >= 1 && ab < k) || (ab === 0 && ba >= 1 && ba < k)) found.push(`paire : ${ab}/${ba}`);
    }
  }
  return found;
}

function shownOf(decisions: CellDecision[]) {
  return decisions.filter((d) => d.status !== 'retenue');
}

describe('AT01 · calcul des cases de prix', () => {
  it('médiane et quartiles égaux au calcul fait à la main, arrondis à 10 €', () => {
    // 5 ventes : triées 2000, 2100, 2440, 2600, 3000 ; médiane 2440 ; bas 2000, 2100 → 2050 ; haut 2600, 3000 → 2800.
    expect(figuresOf([2600, 2000, 3000, 2440, 2100], 10)).toEqual({ sales: 5, median: 2440, q1: 2050, q3: 2800 });
    // 6 ventes : 1000, 1500, 2000, 2003, 2500, 4000 ; médiane (2000 + 2003) / 2 = 2001,5 → 2000 ;
    // bas 1000, 1500, 2000 → 1500 ; haut 2003, 2500, 4000 → 2500.
    expect(figuresOf([4000, 2003, 1000, 2500, 1500, 2000], 10)).toEqual({ sales: 6, median: 2000, q1: 1500, q3: 2500 });
    expect(roundPrice(2445, 10)).toBe(2450);
    expect(roundPrice(2444.9, 10)).toBe(2440);
  });

  it("la période d'une version est la même pour toutes ses cases, jamais la date d'une vente", () => {
    expect(windowOf('2026-06-30', 24)).toEqual({ from: '2024-07', to: '2026-06' });
    expect(windowOf('2026-01-15', 12)).toEqual({ from: '2025-02', to: '2026-01' });
  });

  it('[R150] AT19 : un contour qui se croise, se touche ou repasse sur lui-même est reconnu ; un contour simple, même concave, passe', () => {
    const square: LatLon[] = [[0, 0], [0, 1], [1, 1], [1, 0]];
    expect(ringSelfCrosses(square)).toBe(false);
    expect(ringSelfCrosses([[0, 0], [0, 1], [1, 0]])).toBe(false);
    // Concave en U, et un sommet de plus au milieu d'un bord droit.
    expect(ringSelfCrosses([[0, 0], [0, 3], [3, 3], [3, 0], [2, 0], [2, 2], [1, 2], [1, 0]])).toBe(false);
    expect(ringSelfCrosses([[0, 0], [0, 0.5], [0, 1], [1, 1], [1, 0]])).toBe(false);
    // Un point répété à la suite, y compris le point de fermeture.
    expect(ringSelfCrosses([[0, 0], [0, 1], [0, 1], [1, 1], [1, 0], [0, 0]])).toBe(false);
    // Le nœud papillon, ses diagonales qui se coupent.
    expect(ringSelfCrosses([[0, 0], [1, 1], [0, 1], [1, 0]])).toBe(true);
    // Un sommet qui touche un autre bord, ou deux boucles qui se pincent au même sommet.
    expect(ringSelfCrosses([[0, 0], [0, 2], [1, 0], [2, 2], [2, 0]])).toBe(true);
    expect(ringSelfCrosses([[0, 0], [1, 1], [2, 0], [2, 2], [1, 1], [0, 2]])).toBe(true);
    // Un aller-retour sur un même bord, sans aucune surface.
    expect(ringSelfCrosses([[0, 0], [0, 2], [0, 1], [1, 1]])).toBe(true);
    expect(ringSelfCrosses([[0, 0], [0, 1], [0, 0]])).toBe(true);
  });

  it('[R150] RC59 : un contour presque plat, une pointe qui revient sur son bord, un sommet à moins de 10 cm d’un autre bord se touchent', () => {
    // En mètres autour de Dijon : [vers le nord, vers l'est].
    const m = (ring: Array<[number, number]>): LatLon[] => ring.map(([n, e]) => [47.32 + n / 110_574, 5.04 + e / (111_320 * Math.cos((47.32 * Math.PI) / 180))] as LatLon);
    // Trois sommets alignés à 1 mm près : aucun intérieur.
    expect(ringSelfCrosses(m([[0, 0], [0, 500], [0.001, 1000]]))).toBe(true);
    // Un carré dont un côté a un sommet de plus, 1 mm hors de son bord : un vrai contour.
    expect(ringSelfCrosses(m([[0, 0], [0, 100], [100, 100], [100.001, 50], [100, 0]]))).toBe(false);
    // Une pointe de 50 m sur le haut d'un rectangle, dont le retour passe à 1 cm, puis 5 cm, de l'aller ; à 2 m, une vraie pointe.
    const needle = (gap: number) => m([[0, 0], [0, 200], [200, 200], [200, 100 + gap], [250, 100], [200, 100], [200, 0]]);
    expect(ringSelfCrosses(needle(0.01))).toBe(true);
    expect(ringSelfCrosses(needle(0.05))).toBe(true);
    expect(ringSelfCrosses(needle(2))).toBe(false);
    // Une fente dont les deux bords passent à 5 cm l'un de l'autre ; à 1 m, une vraie fente.
    const slit = (gap: number) => m([[0, 0], [0, 100], [100, 100], [100, 0], [50 + gap, 0], [50 + gap, 80], [50, 80], [50, 0]]);
    expect(ringSelfCrosses(slit(0.05))).toBe(true);
    expect(ringSelfCrosses(slit(1))).toBe(false);
    // Un contour très fin : 1 km de long, 5 cm de large ; à 1 m de large, il passe.
    expect(ringSelfCrosses(m([[0, 0], [0, 1000], [0.05, 1000], [0.05, 0]]))).toBe(true);
    expect(ringSelfCrosses(m([[0, 0], [0, 1000], [1, 1000], [1, 0]]))).toBe(false);
    // Un petit bord de 5 cm qui tourne normalement, un point répété : acceptés.
    expect(ringSelfCrosses(m([[0, 0], [0, 100], [100, 100], [100, 0], [50, 0], [50, -0.05], [0, -0.05]]))).toBe(false);
    expect(ringSelfCrosses(m([[0, 0], [0, 100], [100, 100], [100, 100], [100, 0]]))).toBe(false);
    // Concave en U, à l'échelle d'un quartier.
    expect(ringSelfCrosses(m([[0, 0], [0, 300], [300, 300], [300, 0], [200, 0], [200, 200], [100, 200], [100, 0]]))).toBe(false);
  });

  it('[R150] AT19 : le plus grand contour admis se contrôle en un temps borné, seul et contre un voisin', { timeout: 60_000 }, () => {
    const circle = (lat: number, lon: number): LatLon[] => Array.from({ length: 2000 }, (_, i) => [lat + 0.01 * Math.cos((2 * Math.PI * i) / 2000), lon + 0.01 * Math.sin((2 * Math.PI * i) / 2000)] as LatLon);
    const a = circle(47, 5);
    const b = circle(47, 5.03);
    const at = performance.now();
    expect(ringSelfCrosses(a)).toBe(false);
    const alone = performance.now() - at;
    expect(ringsOverlap(a, b)).toBe(false);
    const both = performance.now() - at - alone;
    expect(alone).toBeLessThan(5000);
    expect(both).toBeLessThan(30_000);
  });

  it('deux zones voisines qui partagent un bord ne se recouvrent pas, même avec un sommet de plus sur ce bord', () => {
    expect(ringsOverlap([[0, 0], [0, 1], [0.5, 1], [1, 1], [1, 0]], [[0, 1], [0, 2], [1, 2], [1, 1]])).toBe(false);
    expect(ringsOverlap([[0, 0], [0, 1], [1, 1], [1, 0]], [[0, 1], [0, 2], [1, 2], [1, 1]])).toBe(false);
    expect(ringsOverlap([[0, 0], [0, 1], [1, 1], [1, 0]], [[0.2, 0.2], [0.2, 0.8], [0.8, 0.8], [0.8, 0.2]])).toBe(true);
    expect(ringsOverlap([[0, 0], [0, 2], [2, 2], [2, 0]], [[1, 1], [1, 3], [3, 3], [3, 1]])).toBe(true);
    // Un contour concave : le second carré est dans le creux, sans le toucher.
    const u: LatLon[] = [[0, 0], [0, 3], [3, 3], [3, 0], [2, 0], [2, 2], [1, 2], [1, 0]];
    expect(ringsOverlap(u, [[1.2, 0.2], [1.2, 1.8], [1.8, 1.8], [1.8, 0.2]])).toBe(false);
    expect(ringsOverlap(u, [[0.5, 2.5], [0.5, 2.8], [2.5, 2.8], [2.5, 2.5]])).toBe(true);
    // Deux contours identiques se recouvrent.
    expect(ringsOverlap(u, [...u])).toBe(true);
  });

  it('point dans un contour', () => {
    const square: LatLon[] = [[0, 0], [0, 1], [1, 1], [1, 0]];
    expect(insideRing([0.5, 0.5], square)).toBe(true);
    expect(insideRing([1.5, 0.5], square)).toBe(false);
  });

  it('[R150] une case de moins de 5 ventes n\'est jamais publiée', () => {
    const d = decideBlock({ communeId: 'c', communeSales: flat('a', 4), quarters: [], previous: [] }, 'v1');
    expect(d).toEqual([{ zoneId: 'c', status: 'retenue', reason: 'seuil', figures: null, set: null, fromVersion: null }]);
    const q = decideBlock({ communeId: 'c', communeSales: [...flat('a', 8), ...flat('b', 4)], quarters: [{ zoneId: 'q1', sales: flat('a', 8) }, { zoneId: 'q2', sales: flat('b', 4) }], previous: [] }, 'v1');
    expect(q.find((x) => x.zoneId === 'q2')).toMatchObject({ status: 'retenue', reason: 'seuil' });
  });

  it('[R150] Jamais vu : la commune moins ses quartiers ne laisse jamais retrouver une vente', () => {
    // Commune de 12 ventes, quartier de 10 : 12 - 10 = 2 ventes retrouvables → le quartier est retenu.
    const d = decideBlock({ communeId: 'c', communeSales: [...flat('a', 10), ...flat('x', 2)], quarters: [{ zoneId: 'q1', sales: flat('a', 10) }], previous: [] }, 'v1');
    expect(d.find((x) => x.zoneId === 'c')!.status).toBe('publiee');
    expect(d.find((x) => x.zoneId === 'q1')).toMatchObject({ status: 'retenue', reason: 'difference' });
    // Deux quartiers de 6 et 5, commune de 13 : 13 - 11 = 2 → le plus petit est retenu, 13 - 6 = 7 tient.
    const e = decideBlock(
      { communeId: 'c', communeSales: [...flat('a', 6), ...flat('b', 5), ...flat('x', 2)], quarters: [{ zoneId: 'q1', sales: flat('a', 6) }, { zoneId: 'q2', sales: flat('b', 5) }], previous: [] },
      'v1',
    );
    expect(e.map((x) => [x.zoneId, x.status, x.reason])).toEqual([['c', 'publiee', null], ['q1', 'publiee', null], ['q2', 'retenue', 'difference']]);
    // Toutes les ventes dans un seul quartier : commune et quartier identiques, reste 0, rien n'est révélé.
    const f = decideBlock({ communeId: 'c', communeSales: flat('a', 7), quarters: [{ zoneId: 'q1', sales: flat('a', 7) }], previous: [] }, 'v1');
    expect(f.every((x) => x.status === 'publiee')).toBe(true);
  });

  it('[R150] entre deux versions, deux ventes de plus ne se lisent pas par différence : la commune garde la version précédente', () => {
    const v1 = decideBlock({ communeId: 'c', communeSales: flat('a', 10, 2000), quarters: [], previous: [] }, 'v1');
    const prev: ShownCell[] = shownOf(v1).map((d) => ({ zoneId: d.zoneId, set: d.set!, figures: d.figures!, fromVersion: d.fromVersion! }));
    const v2 = decideBlock({ communeId: 'c', communeSales: [...flat('a', 10, 2000), ...sales('n', [9000, 9100])], quarters: [], previous: prev }, 'v2');
    expect(v2).toEqual([{ zoneId: 'c', status: 'reprise', reason: 'version', figures: v1[0]!.figures, set: v1[0]!.set, fromVersion: 'v1' }]);
    // Cinq ventes de plus : la différence ne montre plus une vente isolée, les nouveaux chiffres sont publiés.
    const v3 = decideBlock({ communeId: 'c', communeSales: [...flat('a', 10, 2000), ...flat('n', 5, 9000)], quarters: [], previous: prev }, 'v3');
    expect(v3[0]).toMatchObject({ status: 'publiee', fromVersion: 'v3' });
  });

  it('[R150] entre deux versions, un quartier qui gagnerait une vente est retenu, la commune reste publiée', () => {
    const v1 = decideBlock({ communeId: 'c', communeSales: [...flat('a', 6), ...flat('b', 20)], quarters: [{ zoneId: 'q1', sales: flat('a', 6) }], previous: [] }, 'v1');
    const prev: ShownCell[] = shownOf(v1).map((d) => ({ zoneId: d.zoneId, set: d.set!, figures: d.figures!, fromVersion: d.fromVersion! }));
    const v2 = decideBlock(
      { communeId: 'c', communeSales: [...flat('a', 6), ...flat('n', 1), ...flat('b', 20), ...flat('m', 9)], quarters: [{ zoneId: 'q1', sales: [...flat('a', 6), ...flat('n', 1)] }], previous: prev },
      'v2',
    );
    expect(v2.map((x) => [x.zoneId, x.status, x.reason])).toEqual([['c', 'publiee', null], ['q1', 'retenue', 'version']]);
  });

  it('[R150] sur des jeux de ventes inventés, aucune paire de cases publiées ne laisse un reste de 1 à 4 ventes, dans une version ni entre deux', () => {
    const k = 5;
    const random = rng(20261029);
    let checked = 0;
    const reasons = new Set<string>();
    for (let run = 0; run < 300; run++) {
      const nq = 1 + Math.floor(random() * 4);
      const pool = (prefix: string) => Array.from({ length: Math.floor(random() * 14) }, (_, i) => ({ fingerprint: `${prefix}-${i}`, pricePerM2: 1500 + Math.floor(random() * 3000) }));
      const quarterSales = Array.from({ length: nq }, (_, i) => pool(`r${run}q${i}`));
      const outside = pool(`r${run}o`);
      const v1In = { communeId: 'c', communeSales: [...quarterSales.flat(), ...outside], quarters: quarterSales.map((s, i) => ({ zoneId: `q${i}`, sales: s })), previous: [] };
      const v1 = decideBlock(v1In, 'v1');
      const prev: ShownCell[] = shownOf(v1).map((d) => ({ zoneId: d.zoneId, set: d.set!, figures: d.figures!, fromVersion: d.fromVersion! }));
      // Version suivante : quelques ventes sortent de la période, quelques ventes nouvelles arrivent.
      const evolve = (list: CellSale[], prefix: string) => [...list.filter(() => random() > 0.15), ...pool(prefix).slice(0, Math.floor(random() * 4))];
      const q2 = quarterSales.map((s, i) => evolve(s, `r${run}n${i}`));
      const o2 = evolve(outside, `r${run}no`);
      const v2 = decideBlock({ communeId: 'c', communeSales: [...q2.flat(), ...o2], quarters: q2.map((s, i) => ({ zoneId: `q${i}`, sales: s })), previous: prev }, 'v2');
      for (const d of [...v1, ...v2]) if (d.reason) reasons.add(`${d.status}:${d.reason}`);
      for (const [decisions, before] of [[v1, []], [v2, prev.map((p) => p.set as Map<string, number>)]] as const) {
        const shown = shownOf(decisions);
        for (const d of shown) expect(d.figures!.sales).toBeGreaterThanOrEqual(k);
        const commune = shown.find((d) => d.zoneId === 'c');
        const quarters = shown.filter((d) => d.zoneId !== 'c');
        // Sans commune montrée, aucun quartier ne l'est.
        if (!commune) expect(quarters).toEqual([]);
        // Une reprise montre tout le bloc précédent : c'est la version précédente, déjà contrôlée.
        if (commune?.status === 'reprise') continue;
        expect(leaks(commune ? (commune.set as Map<string, number>) : null, quarters.map((q) => q.set as Map<string, number>), [...before], k)).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
    // Le jeu inventé passe bien par chaque garde : seuil, différence dans la version, différence entre versions.
    expect([...reasons].sort()).toEqual(['reprise:version', 'retenue:difference', 'retenue:seuil', 'retenue:version']);
  });

  it('le calcul rapide des groupes égale l\'énumération de tous les groupes', () => {
    const random = rng(7);
    for (let i = 0; i < 500; i++) {
      const sizes = Array.from({ length: 1 + Math.floor(random() * 6) }, () => Math.floor(random() * 12));
      const total = sizes.reduce((a, b) => a + b, 0) + Math.floor(random() * 6);
      let brute = false;
      for (let mask = 0; mask < 1 << sizes.length; mask++) {
        let s = 0;
        sizes.forEach((v, j) => (mask & (1 << j) ? (s += v) : 0));
        if (total - s >= 1 && total - s < 5) brute = true;
      }
      expect(subsetRevealing(total, sizes, 5)).toBe(brute);
    }
  });

  it('les doublons comptent dans les différences', () => {
    const a = saleSet([{ fingerprint: 'x', pricePerM2: 1 }, { fingerprint: 'x', pricePerM2: 1 }]);
    const b = saleSet([{ fingerprint: 'x', pricePerM2: 1 }]);
    expect(minus(a, b)).toBe(1);
    expect(minus(b, a)).toBe(0);
  });
});

/** Une source DVF inventée : ventes données à la main, publication changeable. */
class FakeSales implements SalesSource {
  constructor(public cov: SalesCoverage | null, public list: Sale[]) {}
  async coverage() {
    return this.cov;
  }
  async within(kind: EstimatedKind) {
    return this.list.filter((s) => s.kind === kind);
  }
}

// Une commune inventée, carrée, et deux quartiers qui la partagent en deux.
const COMMUNE: LatLon[] = [[47.0, 5.0], [47.0, 5.1], [47.1, 5.1], [47.1, 5.0]];
const WEST: LatLon[] = [[47.0, 5.0], [47.0, 5.05], [47.1, 5.05], [47.1, 5.0]];
const EAST: LatLon[] = [[47.0, 5.05], [47.0, 5.1], [47.1, 5.1], [47.1, 5.05]];

let seq = 0;
function sale(kind: EstimatedKind, lon: number, pricePerM2: number, month = '2026-03'): Sale {
  seq++;
  return { id: `t:${seq}`, kind, lat: 47.05 + (seq % 50) / 10000, lon, surface: 40 + (seq % 30), pricePerM2, month };
}

async function setup(list: Sale[], lastSale = '2026-06-30') {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  let clock = Date.parse('2026-10-29T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', '2026-01-01T00:00:00.000Z')");
  const source = new FakeSales({ department: '99', lastSale, years: [2024, 2025, 2026], source: 'DVF, jeu inventé' }, list);
  const prix = new PrixRegroupes(db, journal, source, { now });
  const direction = { role: 'direction' as const, userId: 'dir-1', networkId: 'net-1' };
  const c = await prix.defineZone(direction, { level: 'commune', slug: 'commune-test', name: 'Commune Test', inseeCode: '99001', ring: COMMUNE, ringSource: 'Contour inventé' });
  if (!c.ok) throw new Error(c.code);
  await prix.defineZone(direction, { level: 'quartier', parentId: c.id, slug: 'ouest', name: 'Ouest', ring: WEST, ringSource: 'Contour inventé' });
  await prix.defineZone(direction, { level: 'quartier', parentId: c.id, slug: 'est', name: 'Est', ring: EAST, ringSource: 'Contour inventé' });
  return { db, journal, prix, source, direction, communeId: c.id };
}

describeWithSqlite('AT01 · versions des prix dans la base', () => {
  it('[R150] [R151] une version par publication DVF : cases regroupées, source et date, rien d\'une vente isolée', async () => {
    const list = [
      ...[2000, 2100, 2200, 2300, 2400, 2500, 2600].map((p) => sale('apartment', 5.02, p)),
      ...[3000, 3100, 3200, 3300, 3400, 3500].map((p) => sale('apartment', 5.08, p)),
      ...[1800, 1900].map((p) => sale('house', 5.02, p)),
      sale('apartment', 5.08, 9999, '2023-01'), // hors période : ignorée
      sale('apartment', 6.5, 9999), // hors commune : ignorée
    ];
    const { prix } = await setup(list);
    const r = await prix.recompute('net-1');
    expect(r).toMatchObject({ ran: true });
    const p = (await prix.communePrices('net-1', 'commune-test'))!;
    const apt = p.cells.filter((c) => c.kind === 'apartment').map((c) => [c.zone.slug, c.sales, c.median, c.q1, c.q3]);
    // Commune : 13 ventes, médiane 2600 ; bas 2000…2500 → 2250 ; haut 3000…3500 → 3250.
    // Ouest : 2000…2600 → 2300, 2100, 2500. Est : 3000…3500 → (3200 + 3300) / 2 = 3250, 3100, 3400.
    expect(apt).toEqual([
      ['commune-test', 13, 2600, 2250, 3250],
      ['est', 6, 3250, 3100, 3400],
      ['ouest', 7, 2300, 2100, 2500],
    ]);
    for (const c of p.cells) {
      expect(c.source).toBe('DVF, jeu inventé');
      expect(c.dvfLastSale).toBe('2026-06-30');
      expect(c.period).toEqual({ from: '2024-07', to: '2026-06' });
      // Seules ces clés : aucune adresse, aucune voie, aucune date ni prix d'une vente.
      expect(Object.keys(c).sort()).toEqual(['dvfLastSale', 'kind', 'median', 'period', 'q1', 'q3', 'sales', 'source', 'status', 'zone']);
    }
    // Les maisons : 2 ventes, rien de publié, seulement la raison.
    expect(p.held.filter((h) => h.kind === 'house').map((h) => [h.zone.slug, h.reason])).toEqual([['commune-test', 'seuil'], ['est', 'seuil'], ['ouest', 'seuil']]);
    expect(JSON.stringify(p)).not.toMatch(/9999|t:\d|47\.0\d|fingerprint/);
  });

  it('[R150] relancer ne refait rien ; une nouvelle publication DVF donne une nouvelle version, la précédente reste lisible', async () => {
    const list = [2000, 2100, 2200, 2300, 2400, 2500].map((p) => sale('apartment', 5.02, p));
    const { prix, source, db } = await setup(list);
    const first = await prix.recompute('net-1');
    expect(await prix.recompute('net-1')).toEqual({ ran: false, reason: 'deja_fait', versionId: (first as { versionId: string }).versionId });
    // Octobre : deux ventes de plus, chères. Les nouveaux chiffres laisseraient lire ces deux ventes : reprise.
    source.cov = { ...source.cov!, lastSale: '2026-09-30' };
    source.list = [...list, sale('apartment', 5.02, 8000, '2026-08'), sale('apartment', 5.02, 8100, '2026-09')];
    const second = await prix.recompute('net-1');
    expect(second).toMatchObject({ ran: true, carried: 2 });
    const latest = (await prix.communePrices('net-1', 'commune-test'))!;
    const commune = latest.cells.find((c) => c.zone.slug === 'commune-test' && c.kind === 'apartment')!;
    expect(commune).toMatchObject({ status: 'reprise', sales: 6, dvfLastSale: '2026-06-30' });
    // Cinq ventes de plus encore : publiées.
    source.cov = { ...source.cov!, lastSale: '2027-03-31' };
    source.list = [...source.list, ...[8200, 8300, 8400].map((p) => sale('apartment', 5.02, p, '2027-02'))];
    await prix.recompute('net-1');
    const third = (await prix.communePrices('net-1', 'commune-test'))!;
    expect(third.cells.find((c) => c.zone.slug === 'commune-test' && c.kind === 'apartment')).toMatchObject({ status: 'publiee', sales: 11, dvfLastSale: '2027-03-31' });
    const versions = await prix.versions('net-1');
    expect(versions.map((v) => v.dvfLastSale)).toEqual(['2027-03-31', '2026-09-30', '2026-06-30']);
    const old = (await prix.communePrices('net-1', 'commune-test', versions[2]!.id))!;
    expect(old.cells.find((c) => c.zone.slug === 'commune-test')).toMatchObject({ status: 'publiee', sales: 6, median: 2250 });
    // Rien ne s'efface ni ne se réécrit [R17].
    await expect(db.run('DELETE FROM price_cells')).rejects.toThrow();
    await expect(db.run("UPDATE price_cells SET median_m2 = 1")).rejects.toThrow();
  });

  it('[R150] une version coupée en route est refaite à l\'identique puis close ; une version close ne reçoit plus rien', async () => {
    const list = [2000, 2100, 2200, 2300, 2400, 2500].map((p) => sale('apartment', 5.02, p));
    const { prix, db } = await setup(list);
    // Une coupure : la version et une case sont rangées, puis plus rien.
    const realRun = db.run.bind(db);
    let cut = false;
    let cells = 0;
    db.run = async (sql, params) => {
      if (sql.startsWith('INSERT OR IGNORE INTO price_cells') && ++cells === 2) {
        cut = true;
        throw new Error('coupure');
      }
      return realRun(sql, params);
    };
    await expect(prix.recompute('net-1')).rejects.toThrow('coupure');
    db.run = realRun;
    expect(cut).toBe(true);
    expect(await prix.communePrices('net-1', 'commune-test')).toBeNull();
    const r = await prix.recompute('net-1');
    expect(r).toMatchObject({ ran: true });
    const p = (await prix.communePrices('net-1', 'commune-test'))!;
    expect(p.cells.find((c) => c.zone.slug === 'commune-test')).toMatchObject({ sales: 6 });
    const vid = (r as { versionId: string }).versionId;
    const zone = (await db.first<{ id: string }>("SELECT id FROM price_zones WHERE slug = 'ouest'"))!.id;
    await db.exec('PRAGMA foreign_keys = OFF');
    await expect(
      db.run("INSERT INTO price_cells (version_id, area_id, kind, status, hold_code) VALUES (?, ?, 'house', 'retenue', 'version')", [vid, 'zone-inconnue']),
    ).rejects.toThrow('version complète');
    await expect(db.run("INSERT INTO price_cell_sales (version_id, area_id, kind, fingerprint, n) VALUES (?, ?, 'apartment', ?, 1)", [vid, zone, 'f'.repeat(64)])).rejects.toThrow('version complète');
  });

  it('[R16] seule la direction trace une zone ; un contour ou un code mal formés sont refusés', async () => {
    const { prix, communeId } = await setup([]);
    const agent = { role: 'agent' as const, userId: 'ag-1', networkId: 'net-1' };
    expect(await prix.defineZone(agent, { level: 'commune', slug: 'x', name: 'X', inseeCode: '99002', ring: COMMUNE, ringSource: 's' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const direction = { role: 'direction' as const, userId: 'dir-1', networkId: 'net-1' };
    expect(await prix.defineZone(direction, { level: 'commune', slug: 'noeud', name: 'Nœud', inseeCode: '99002', ring: [[47, 5], [47.1, 5.1], [47, 5.1], [47.1, 5]], ringSource: 's' })).toMatchObject({ ok: false, rule: 'R150', code: 'contour_croise' });
    expect(await prix.defineZone(direction, { level: 'commune', slug: 'x', name: 'X', inseeCode: '99002', ring: [[1, 2]], ringSource: 's' })).toMatchObject({ code: 'contour' });
    expect(await prix.defineZone(direction, { level: 'commune', slug: 'X X', name: 'X', inseeCode: '99002', ring: COMMUNE, ringSource: 's' })).toMatchObject({ code: 'slug' });
    expect(await prix.defineZone(direction, { level: 'commune', slug: 'commune-test', name: 'X', inseeCode: '99002', ring: COMMUNE, ringSource: 's' })).toMatchObject({ code: 'slug_pris' });
    expect(await prix.defineZone(direction, { level: 'quartier', parentId: 'inconnue', slug: 'q', name: 'Q', ring: WEST, ringSource: 's' })).toMatchObject({ code: 'parent' });
    expect(await prix.defineZone(direction, { level: 'quartier', parentId: communeId, slug: 'q', name: 'Q', inseeCode: '99001', ring: WEST, ringSource: 's' })).toMatchObject({ code: 'insee' });
    expect(await prix.defineZone(direction, { level: 'commune', slug: 'y', name: 'Y', inseeCode: '99003', ring: COMMUNE, ringSource: '' })).toMatchObject({ code: 'source' });
  });

  it('[R150] une commune qui en recouvre une autre est refusée ; retirée puis retracée, elle ne laisse rien lire par différence', async () => {
    const list = [2000, 2100, 2200, 2300, 2400, 2500].map((p) => sale('apartment', 5.02, p));
    const { prix, source, direction, communeId } = await setup(list);
    // Même commune décalée, emboîtée : refusée, avec sa raison.
    const inner: LatLon[] = [[47.01, 5.01], [47.01, 5.09], [47.09, 5.09], [47.09, 5.01]];
    expect(await prix.defineZone(direction, { level: 'commune', slug: 'autre', name: 'Autre', inseeCode: '99002', ring: inner, ringSource: 's' })).toMatchObject({ code: 'chevauchement' });
    // Une voisine qui partage un bord est acceptée.
    const east: LatLon[] = [[47.0, 5.1], [47.0, 5.2], [47.1, 5.2], [47.1, 5.1]];
    expect(await prix.defineZone(direction, { level: 'commune', slug: 'voisine', name: 'Voisine', inseeCode: '99003', ring: east, ringSource: 's' })).toMatchObject({ ok: true });
    // Deux quartiers qui se recouvrent : refusé.
    expect(await prix.defineZone(direction, { level: 'quartier', parentId: communeId, slug: 'centre', name: 'Centre', ring: inner, ringSource: 's' })).toMatchObject({ code: 'chevauchement' });
    await prix.recompute('net-1');
    // La commune est retirée, puis retracée plus grande avec deux ventes de plus : la différence se lirait.
    expect(await prix.retireZone({ role: 'agent', userId: 'a', networkId: 'net-1' }, communeId)).toMatchObject({ code: 'role' });
    expect(await prix.retireZone(direction, communeId)).toMatchObject({ ok: true });
    const big: LatLon[] = [[46.95, 4.95], [46.95, 5.1], [47.15, 5.1], [47.15, 4.95]];
    expect(await prix.defineZone(direction, { level: 'commune', slug: 'commune-test', name: 'Commune Test', inseeCode: '99001', ring: big, ringSource: 's' })).toMatchObject({ ok: true });
    source.list = [...list, { id: 'n1', kind: 'apartment', lat: 46.97, lon: 4.97, surface: 50, pricePerM2: 9000, month: '2026-04' }, { id: 'n2', kind: 'apartment', lat: 46.97, lon: 4.98, surface: 50, pricePerM2: 9100, month: '2026-04' }];
    expect(await prix.recompute('net-1')).toMatchObject({ ran: true });
    const p = (await prix.communePrices('net-1', 'commune-test'))!;
    expect(p.cells.filter((c) => c.zone.slug === 'commune-test')).toEqual([]);
    expect(p.held.find((h) => h.zone.slug === 'commune-test' && h.kind === 'apartment')).toMatchObject({ reason: 'version' });
    // L'ancienne version reste lisible sous son nom.
    const versions = await prix.versions('net-1');
    expect((await prix.communePrices('net-1', 'commune-test', versions[1]!.id))!.cells.find((c) => c.zone.slug === 'commune-test')).toMatchObject({ sales: 6 });
  });

  it('[R150] une vente dont la position a été corrigée ne cache pas deux ventes nouvelles', async () => {
    const list = Array.from({ length: 10 }, (_, i) => sale('apartment', 5.02, 2000 + i * 10));
    const { prix, source } = await setup(list);
    await prix.recompute('net-1');
    const moved = { ...list[0]!, lat: list[0]!.lat + 0.00001 };
    source.cov = { ...source.cov!, lastSale: '2026-09-30' };
    source.list = [moved, ...list.slice(1), sale('apartment', 5.02, 9000, '2026-08'), sale('apartment', 5.02, 9100, '2026-09')];
    expect(await prix.recompute('net-1')).toMatchObject({ ran: true });
    const p = (await prix.communePrices('net-1', 'commune-test'))!;
    expect(p.cells.find((c) => c.zone.slug === 'commune-test' && c.kind === 'apartment')).toMatchObject({ status: 'reprise', sales: 10 });
  });

  it('[R150] une lecture incomplète des ventes n\'écrit rien et le dit au journal ; refaite complète, la version est calculée', async () => {
    const list = [2000, 2100, 2200, 2300, 2400, 2500].map((p) => sale('apartment', 5.02, p));
    const { prix, source, db } = await setup(list);
    let broken = true;
    (source as FakeSales & { scan?: unknown }).scan = async (kind: EstimatedKind) => ({ sales: await source.within(kind), issues: broken ? 1 : 0 });
    expect(await prix.recompute('net-1')).toEqual({ ran: false, reason: 'source_incomplete' });
    expect((await db.first<{ n: number }>('SELECT count(*) AS n FROM price_versions'))!.n).toBe(0);
    expect((await db.first<{ n: number }>("SELECT count(*) AS n FROM journal WHERE type = 'attirer.prix.incomplet'"))!.n).toBe(1);
    broken = false;
    expect(await prix.recompute('net-1')).toMatchObject({ ran: true });
  });

  it('[R150] une reprise après coupure avec une autre lecture des ventes ne mélange jamais les deux', async () => {
    const list = [2000, 2100, 2200, 2300, 2400, 2500].map((p) => sale('apartment', 5.02, p));
    const { prix, source, db } = await setup(list);
    const realRun = db.run.bind(db);
    let cells = 0;
    db.run = async (sql, params) => {
      if (sql.startsWith('INSERT OR IGNORE INTO price_cells') && ++cells === 2) throw new Error('coupure');
      return realRun(sql, params);
    };
    await expect(prix.recompute('net-1')).rejects.toThrow('coupure');
    db.run = realRun;
    source.list = [...list, sale('apartment', 5.08, 3000)];
    const r = (await prix.recompute('net-1')) as { ran: true; versionId: string };
    const cellsOf = await db.all<{ version_id: string }>('SELECT DISTINCT version_id FROM price_cells');
    expect(cellsOf.length).toBe(2);
    const p = (await prix.communePrices('net-1', 'commune-test'))!;
    expect(p.versionId).toBe(r.versionId);
    expect(p.cells.find((c) => c.zone.slug === 'commune-test')).toMatchObject({ sales: 7 });
  });

  it('[R150] changer la période ou l\'arrondi donne une nouvelle version', async () => {
    const list = [2001, 2102, 2203, 2304, 2405, 2506].map((p) => sale('apartment', 5.02, p));
    const { prix, db, journal, source } = await setup(list);
    await prix.recompute('net-1');
    const other = new PrixRegroupes(db, journal, source, { settings: { roundTo: 100 } });
    expect(await other.recompute('net-1')).toMatchObject({ ran: true });
    expect((await other.communePrices('net-1', 'commune-test'))!.cells[0]!.median % 100).toBe(0);
    // Une version passée se lit pareil, quel que soit le seuil du lecteur.
    const strict = new PrixRegroupes(db, journal, source, { settings: { minSales: 10 } });
    const first = (await prix.versions('net-1')).at(-1)!.id;
    expect((await strict.communePrices('net-1', 'commune-test', first))!.cells.find((c) => c.zone.slug === 'commune-test')).toMatchObject({ sales: 6 });
    const longer = new PrixRegroupes(db, journal, source, { settings: { windowMonths: 36 } });
    expect(await longer.recompute('net-1')).toMatchObject({ ran: true });
    expect((await longer.communePrices('net-1', 'commune-test'))!.cells[0]!.period.from).toBe('2023-07');
  });

  it('sans publication DVF ou sans zone, aucune version', async () => {
    const { prix, source } = await setup([]);
    source.cov = null;
    expect(await prix.recompute('net-1')).toEqual({ ran: false, reason: 'dvf_non_couvert' });
    source.cov = { department: '99', lastSale: '2026-06-30', years: [2026], source: 's' };
    expect(await prix.recompute('net-2')).toEqual({ ran: false, reason: 'aucune_zone' });
    expect(await prix.communePrices('net-1', 'inconnue')).toBeNull();
  });
});

describeWithSqlite('AT02 · la page de prix rendue depuis la dernière version', () => {
  it('[R150] [R151] la page ne montre que les cases publiables de la version, chacune avec sa source et sa date', async () => {
    const list = [
      ...[2000, 2100, 2200, 2300, 2400, 2500, 2600].map((p) => sale('apartment', 5.02, p)),
      ...[3000, 3100, 3200, 3300, 3400, 3500].map((p) => sale('apartment', 5.08, p)),
      ...[1800, 1900].map((p) => sale('house', 5.02, p)),
    ];
    const { prix } = await setup(list);
    await prix.recompute('net-1');
    const prices = (await prix.communePrices('net-1', 'commune-test'))!;
    const r = renderPricePage(prices, { communeSlug: 'commune-test', estimateHref: '/estimer', siteUrl: 'https://reseau.exemple.test' });
    if (!r.ok) throw new Error(r.code);
    const text = r.html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
    for (const c of prices.cells.filter((x) => x.zone.slug === 'commune-test')) expect(text).toContain(sourceLine(c));
    // Deux maisons seulement : aucune case de maison, et aucun de leurs prix.
    expect(prices.cells.some((c) => c.kind === 'house')).toBe(false);
    expect(text).not.toMatch(/1 8\d0|1 9\d0/);
    expect(text).toContain('Pas assez de ventes pour publier un chiffre fiable.');
  });
});
