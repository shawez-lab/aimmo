import { describe, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import {
  LISTING_MAX_BODY,
  LISTING_MAX_TITLE,
  ProgrammesNeufs,
  eurosOf,
  feesOf,
  listingStillHolds,
  newBuildListing,
  type LotFees,
  type PublishedGrid,
  type PublishedLot,
} from '../src/neuf-viager/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Jeu de test inventé : programme, promoteur, barèmes, prix et lots n'ont rien de réel.
const fees = (priceCents: number, day = '2027-03-01'): LotFees => {
  const n = feesOf(priceCents, 250);
  const o = feesOf(priceCents, 750);
  return {
    newFees: { value: n, source: 'bareme:b-neuf · Barème du neuf inventé', asOf: '2027-01-01', hypothesis: 'prix TTC du lot × 250 points de base (barème du neuf)' },
    oldFees: { value: o, source: 'bareme:b-ancien · Barème de l’ancien inventé', asOf: '2027-01-01', hypothesis: 'même prix × 750 points de base (barème de l’ancien)' },
    saving: { value: o - n, source: 'calcul:neuf', asOf: day, hypothesis: 'frais de l’ancien − frais du neuf, au même prix' },
  };
};
const lot = (lotRef: string, priceCents: number, confirmedOn = '2027-03-01', withFees = true): PublishedLot => ({
  lotRef,
  typology: 't3',
  livingAreaHundredths: 6550,
  floor: 2,
  priceCents,
  confirmedOn,
  fees: withFees ? fees(priceCents) : null,
});
const grid = (lots: PublishedLot[], over: Partial<PublishedGrid> = {}): PublishedGrid => ({
  programId: 'prog-1',
  name: 'Les Jardins Test',
  city: 'Dijon',
  postalCode: '21000',
  promoter: 'Promoteur Inventé',
  day: '2027-03-05',
  lots,
  ...over,
});
const ok = <T,>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
  if (!r.ok) throw new Error(r.code);
  return r.value;
};

// Les montants et surfaces s'écrivent avec des espaces insécables, comme sur la page publique ; les tests les lisent en espaces simples.
const n = (t: string): string => t.replace(/[\u202f\u00a0]/g, ' ');
const listing = (g: PublishedGrid) => {
  const v = ok(newBuildListing(g));
  return { ...v, title: n(v.title), body: n(v.body) };
};

describe('RC56 · la grille d’un programme neuf écrite pour les annonces', () => {
  it('[R10] [R544] titre et texte rendus depuis la grille : chaque prix et chaque frais sont ceux de la grille', () => {
    const g = grid([lot('B02', 32_000_000, '2027-03-02'), lot('A01', 18_000_000)]);
    const a = listing(g);
    expect(a.title).toBe('Les Jardins Test, programme neuf à Dijon : 2 lots dès 180 000 €');
    expect(a.title.length).toBeLessThanOrEqual(LISTING_MAX_TITLE);
    expect(a.body.length).toBeLessThanOrEqual(LISTING_MAX_BODY);
    // Du moins cher au plus cher, un lot par ligne.
    const lines = a.body.split('\n').filter((l) => l.startsWith('• Lot'));
    expect(lines).toEqual([
      '• Lot A01 · T3, 65,5 m², 2e étage · 180 000 € · frais d’acquisition 4 500 €, contre 13 500 € dans l’ancien au même prix, soit 9 000 € d’économie · confirmé le 1er mars 2027',
      '• Lot B02 · T3, 65,5 m², 2e étage · 320 000 € · frais d’acquisition 8 000 €, contre 24 000 € dans l’ancien au même prix, soit 16 000 € d’économie · confirmé le 2 mars 2027',
    ]);
    // Aucun montant qui ne vienne de la grille [R10].
    const allowed = new Set(g.lots.flatMap((l) => [l.priceCents, l.fees!.newFees.value, l.fees!.oldFees.value, l.fees!.saving.value]).map((c) => n(eurosOf(c))));
    for (const m of a.body.match(/\d[\d ]*(?:,\d{2})? €/g) ?? []) expect(allowed.has(m)).toBe(true);
    // Chaque barème cité une fois, avec sa date et son hypothèse, sans son identifiant interne [R544].
    expect(a.body.match(/Barème du neuf : /g)).toHaveLength(1);
    expect(a.body).toContain('Barème du neuf : Barème du neuf inventé, en vigueur depuis le 1er janvier 2027 (prix TTC du lot × 250 points de base (barème du neuf)).');
    expect(a.body).toContain('Barème de l’ancien : Barème de l’ancien inventé, en vigueur depuis le 1er janvier 2027');
    expect(a.body).not.toContain('b-neuf');
    expect(a.body).toContain('sous réserve de la vente des lots');
    expect(a.body).toContain('pas une offre');
    expect(a.body).not.toMatch(/[<>]/);
    expect(a.lots).toEqual([
      { lotRef: 'A01', priceCents: 18_000_000, confirmedOn: '2027-03-01' },
      { lotRef: 'B02', priceCents: 32_000_000, confirmedOn: '2027-03-02' },
    ]);
    expect(a.omitted).toBe(0);
    expect(listing(grid([lot('A01', 18_000_000)])).title).toBe('Les Jardins Test, programme neuf à Dijon : 1 lot dès 180 000 €');
  });

  it('[R544] sans barème, aucun frais n’est écrit et le texte le dit', () => {
    const a = listing(grid([lot('A01', 18_000_000, '2027-03-01', false)]));
    expect(a.body).toContain('frais non calculés, barème absent');
    expect(a.body).toContain('Les frais ne sont pas calculés : le barème n’est pas encore rangé.');
    expect(a.body).not.toContain('D’où viennent les frais');
    expect(a.body.match(/\d[\d ]*(?:,\d{2})? €/g)).toEqual(['180 000 €']);
    // Un lot avec barème et un sans : chacun dit le sien, la phrase générale n'est pas écrite.
    const b = listing(grid([lot('A01', 18_000_000, '2027-03-01', false), lot('A02', 20_000_000)]));
    expect(b.body).toContain('frais non calculés, barème absent');
    expect(b.body).not.toContain('le barème n’est pas encore rangé');
    expect(b.body).toContain('D’où viennent les frais');
  });

  it('[R543] grille vide ou lot confirmé hors des 14 jours : aucun texte, refus en mots', () => {
    expect(newBuildListing(grid([]))).toEqual({ ok: false, rule: 'R543', code: 'no_lot_published' });
    // Confirmé il y a 15 jours : plus publiable.
    expect(newBuildListing(grid([lot('A01', 18_000_000, '2027-02-18')]))).toEqual({ ok: false, rule: 'R543', code: 'lot_not_confirmed' });
    // Confirmé il y a 14 jours : encore publiable.
    expect(newBuildListing(grid([lot('A01', 18_000_000, '2027-02-19')])).ok).toBe(true);
    // Confirmé dans le futur, ou jour mal formé.
    expect(newBuildListing(grid([lot('A01', 18_000_000, '2027-03-06')]))).toMatchObject({ ok: false, code: 'lot_not_confirmed' });
    expect(newBuildListing(grid([lot('A01', 18_000_000, '1er mars')]))).toMatchObject({ ok: false, code: 'lot_not_confirmed' });
    expect(newBuildListing(grid([lot('A01', 18_000_000)], { day: 'demain' }))).toMatchObject({ ok: false, code: 'day_invalid' });
    // Un prix nul, négatif ou non entier n'est jamais écrit [R10].
    for (const p of [0, -5, 1.5]) expect(newBuildListing(grid([lot('A01', p, '2027-03-01', false)]))).toMatchObject({ ok: false, code: 'price_invalid' });
    // Le même lot deux fois.
    expect(newBuildListing(grid([lot('A01', 18_000_000), lot('A01', 19_000_000)]))).toMatchObject({ ok: false, code: 'lot_listed_twice' });
  });

  it('4000 signes tenus sans couper un lot : les moins chers écrits, les autres comptés', () => {
    const lots = Array.from({ length: 60 }, (_, i) => lot(`L${String(i).padStart(2, '0')}`, 15_000_000 + (59 - i) * 100_000));
    const a = listing(grid(lots));
    expect(a.body.length).toBeLessThanOrEqual(LISTING_MAX_BODY);
    expect(a.omitted).toBeGreaterThan(0);
    expect(a.lots.length + a.omitted).toBe(60);
    const lines = a.body.split('\n').filter((l) => l.startsWith('• Lot'));
    expect(lines).toHaveLength(a.lots.length);
    for (const l of lines) expect(l).toMatch(/ · confirmé le 1er mars 2027$/);
    // Les moins chers d'abord : les lots écrits sont exactement les moins chers.
    const cheapest = [...lots].sort((x, y) => x.priceCents - y.priceCents).slice(0, a.lots.length).map((l) => l.lotRef);
    expect(a.lots.map((l) => l.lotRef)).toEqual(cheapest);
    expect(a.body).toContain(`Et ${a.omitted} autres lots disponibles, à demander à l’agent du programme.`);
    // Le titre compte tous les lots publiés, et part du moins cher.
    expect(a.title).toBe('Les Jardins Test, programme neuf à Dijon : 60 lots dès 150 000 €');
    // Les barèmes et la mention restent écrits, même texte plein.
    expect(a.body).toContain('D’où viennent les frais');
    expect(a.body).toContain('pas une offre');
  });

  it('nom trop long pour 160 signes : refus, jamais un nom coupé ; nom ou commune vides refusés', () => {
    const base = 'Les Jardins Test, programme neuf à Dijon : 1 lot dès 180 000 €'.length - 'Les Jardins Test'.length;
    const fits = 'N'.repeat(LISTING_MAX_TITLE - base);
    const a = listing(grid([lot('A01', 18_000_000)], { name: fits }));
    expect(a.title.length).toBe(LISTING_MAX_TITLE);
    expect(a.title.startsWith(fits)).toBe(true);
    expect(newBuildListing(grid([lot('A01', 18_000_000)], { name: `${fits}N` }))).toEqual({ ok: false, rule: null, code: 'name_too_long' });
    expect(newBuildListing(grid([lot('A01', 18_000_000)], { name: ' \n ' }))).toMatchObject({ ok: false, code: 'name_missing' });
    expect(newBuildListing(grid([lot('A01', 18_000_000)], { city: '' }))).toMatchObject({ ok: false, code: 'name_missing' });
  });

  it('retours à la ligne et balises d’un nom rendus inoffensifs', () => {
    const a = ok(
      newBuildListing(
        grid([lot('A01', 18_000_000)], { name: 'Les Jardins\n• Lot Z99 · 1 €\r\n<script>x</script>', promoter: 'Promoteur\u2028Inventé', city: 'Dijon\t' }),
      ),
    );
    expect(a.title).not.toMatch(/[\n\r<>]/);
    expect(a.body).not.toMatch(/[<>\r\u2028]/);
    // Seules les lignes des lots commencent par « • Lot » : un nom n'en fabrique aucune.
    expect(a.body.split('\n').filter((l) => l.startsWith('• Lot'))).toHaveLength(1);
    expect(a.body.split('\n')[0]).toContain('promoteur Promoteur Inventé');
    expect(a.title).toContain('programme neuf à Dijon :');
  });

  it('[R543] l’annonce dit jusqu’à quel jour elle tient, et le lendemain elle ne tient plus (Jamais vu)', () => {
    const a = listing(grid([lot('A01', 18_000_000, '2027-03-04'), lot('A02', 20_000_000, '2027-02-25')]));
    // La plus ancienne confirmation plus 14 jours.
    expect(a.validUntil).toBe('2027-03-11');
    const sameDay = grid([lot('A01', 18_000_000, '2027-03-04'), lot('A02', 20_000_000, '2027-02-25')], { day: '2027-03-11' });
    expect(listingStillHolds(a, sameDay)).toEqual({ holds: true, gone: [], priceChanged: [], expired: false, otherProgram: false });
    // Le lendemain, A02 n'est plus publié : l'annonce est à retirer.
    const next = grid([lot('A01', 18_000_000, '2027-03-04')], { day: '2027-03-12' });
    expect(listingStillHolds(a, next)).toEqual({ holds: false, gone: ['A02'], priceChanged: [], expired: true, otherProgram: false });
    // Même si la grille la montrait encore (reconfirmée), l'annonce a passé son jour : elle se refait.
    const reconfirmed = grid([lot('A01', 18_000_000, '2027-03-04'), lot('A02', 20_000_000, '2027-03-12')], { day: '2027-03-12' });
    expect(listingStillHolds(a, reconfirmed)).toMatchObject({ holds: false, expired: true, gone: [] });
  });

  it('[R543] lot vendu ou prix changé : nommés, l’annonce ne tient plus ; un lot de plus ne la rend pas fausse', () => {
    const a = listing(grid([lot('A01', 18_000_000), lot('A02', 20_000_000), lot('A03', 22_000_000)]));
    const today = (lots: PublishedLot[], over: Partial<PublishedGrid> = {}) => grid(lots, { day: '2027-03-06', ...over });
    expect(listingStillHolds(a, today([lot('A01', 18_000_000), lot('A03', 21_500_000)]))).toEqual({
      holds: false,
      gone: ['A02'],
      priceChanged: ['A03'],
      expired: false,
      otherProgram: false,
    });
    expect(listingStillHolds(a, today([lot('A01', 18_000_000), lot('A02', 20_000_000), lot('A03', 22_000_000), lot('A04', 25_000_000)])).holds).toBe(true);
    // La grille d'un autre programme ne confirme jamais l'annonce.
    expect(listingStillHolds(a, today(a.lots.map((l) => lot(l.lotRef, l.priceCents)), { programId: 'prog-2' }))).toMatchObject({ holds: false, otherProgram: true });
    expect(listingStillHolds(a, today([lot('A01', 18_000_000)], { day: 'demain' }))).toMatchObject({ holds: false, expired: true });
  });
});

describeWithSqlite('RC56 · l’annonce écrite depuis la grille publiée en base', () => {
  it('[R543] [R544] un lot vendu sort de l’annonce refaite, et l’annonce d’avant ne tient plus', async () => {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const clock = new Date('2027-03-05T10:00:00.000Z');
    const now = () => clock;
    const journal = new SqlJournalStore(db);
    const store = new FicheClient(db, { now });
    new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
    const network = await store.createNetwork('Réseau test');
    const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const agent = { role: 'agent', userId: alex.id, networkId: network.id } as Viewer;
    const direction = { role: 'direction', userId: 'direction-1', networkId: network.id } as Viewer;
    const neuf = new ProgrammesNeufs(db, journal, { now });
    const promoter = crypto.randomUUID();
    await db.run('INSERT INTO partners (id, network_id, trade, business_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      promoter,
      network.id,
      'promoteur',
      'Promoteur Inventé',
      'direction:direction-1',
      clock.toISOString(),
    ]);
    const p = ok(await neuf.createProgram(direction, { promoterPartnerId: promoter, agentId: alex.id, name: 'Les Jardins Test', city: 'Dijon', postalCode: '21000' }));
    const record = (lotRef: string, status: string, priceCents: number) =>
      neuf.recordLot(agent, p.programId, { lotRef, typology: 't3', livingAreaHundredths: 6500, floor: 2, priceCents, status, confirmedOn: '2027-03-01' });
    ok(await neuf.setFeeScale(direction, { kind: 'neuf', rateBp: 250, source: 'Barème du neuf inventé pour les tests', validFrom: '2027-01-01' }));
    ok(await neuf.setFeeScale(direction, { kind: 'ancien', rateBp: 750, source: 'Barème de l’ancien inventé pour les tests', validFrom: '2027-01-01' }));
    for (const [ref, price] of [['A01', 25_000_000], ['A02', 21_000_000]] as const) ok(await record(ref, 'disponible', price));
    const first = listing((await neuf.publishedGrid(network.id, p.programId))!);
    expect(first.lots.map((l) => l.lotRef)).toEqual(['A02', 'A01']);
    expect(first.body).toContain('frais d’acquisition 5 250 €, contre 15 750 € dans l’ancien au même prix');
    expect(first.body).toContain('Barème du neuf : Barème du neuf inventé pour les tests');
    expect(first.body).not.toMatch(/Alex|bareme:/);
    ok(await record('A02', 'vendu', 21_000_000));
    const today = (await neuf.publishedGrid(network.id, p.programId))!;
    expect(listingStillHolds(first, today)).toMatchObject({ holds: false, gone: ['A02'] });
    const again = listing(today);
    expect(again.lots.map((l) => l.lotRef)).toEqual(['A01']);
    expect(again.body).not.toContain('Lot A02');
    expect(listingStillHolds(again, today).holds).toBe(true);
  });
});
