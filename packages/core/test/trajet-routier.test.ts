import { expect, it } from 'vitest';
import {
  APPOINTMENT_PURPOSE,
  FicheClient,
  MeilleursCreneaux,
  RendezVous,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  parisInstant,
  roadEstimate,
  type Availability,
  type Place,
  type RoadTimeSource,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// AU054 : le meilleur créneau ne repose plus seulement sur un vol d'oiseau majoré. Biens, personnes, agent et service inventés.
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const NOW = at('2026-11-09', '08:00');
const WEEK: Availability = { weekly: [1, 2, 3, 4, 5].flatMap((weekday) => [{ weekday, from: '09:00', to: '12:00' }, { weekday, from: '14:00', to: '18:00' }]) };
const AGENCE: Place = { lat: 47.322, lon: 5.0415 };
const DIJON: Place = { lat: 47.325, lon: 5.04 };
// De l'autre côté d'un obstacle (voie ferrée, rivière) : tout près à vol d'oiseau, loin par la route.
const EN_FACE: Place = { lat: 47.31, lon: 5.03 };
const MIN = 60_000;
// À 22 mètres, mais séparé : le même lieu n'est jamais supposé sur une simple proximité.
const VOISIN: Place = { lat: 47.3252, lon: 5.04 };

async function world(roads: RoadTimeSource | null, target: Place = EN_FACE) {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lea = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Exemple' });
  await store.addConsent({ networkId: net.id, personId: lea.id, purpose: APPOINTMENT_PURPOSE, channel: 'email', proof: 'formulaire test', givenAt: new Date('2026-01-01T00:00:00Z') });
  const rdv = new RendezVous(db, new SqlJournalStore(db), { now: () => NOW });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  await rdv.setAvailability(asPaul, WEEK);
  const p = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'B-ROUTE-7', kind: 'home', postalCode: '21000', city: 'Commune test' });
  const r = await rdv.book({ networkId: net.id, agentId: paul.id, personId: lea.id, propertyId: p.id, kind: 'estimation', start: at('2026-11-10', '14:00'), source: 'agent' });
  if (!r.ok) throw new Error(`refusé : ${r.code}`);
  const best = new MeilleursCreneaux(db, { placeOf: async (id) => (id === p.id ? DIJON : null) }, roads);
  const free = await rdv.freeSlotsFor(paul.id, 'estimation', at('2026-11-10', '00:00'), at('2026-11-10', '23:59'));
  const rank = () => best.rank({ agentId: paul.id, kind: 'estimation', target, free, base: AGENCE, limit: 100 });
  return { rank, free };
}

/** Un service d'itinéraires inventé : 50 minutes entre deux lieux distincts, et il note ce qu'il reçoit. */
function fakeRoads(answer: (from: Place, to: Place) => unknown = () => ({ minutes: 50, source: 'Itinéraires test' })) {
  const calls: unknown[][] = [];
  const roads = { roadMinutes: async (from: Place, to: Place) => { calls.push([from, to]); return answer(from, to) as never; } };
  return { roads, calls };
}

const AFTER = at('2026-11-10', '15:00'); // fin du rendez-vous voisin

describeWithSqlite('AU054 · un trajet avec obstacle utilise un temps routier sourcé, ou reste non garanti', () => {
  it('[R701] constat reproduit : à vol d’oiseau, le créneau de 15 h 30 passe alors que la route demande 50 minutes ; il reste dit non garanti', async () => {
    expect(roadEstimate(DIJON, EN_FACE)).toBeLessThanOrEqual(30);
    const w = await world(null);
    const ranked = await w.rank();
    const half = ranked.find((s) => s.start.getTime() === at('2026-11-10', '15:30').getTime());
    expect(half).toBeDefined();
    expect(half!.guaranteed).toBe(false);
    expect(half!.sources).toEqual([]);
    expect(half!.reason).toContain('non garantie');
    expect(half!.reason).toContain('à confirmer');
    expect(ranked.every((s) => !s.guaranteed)).toBe(true);
  });

  it('[R701] avec un service d’itinéraires, le temps routier sourcé décide : rien avant 50 minutes de route, et le créneau est garanti', async () => {
    const { roads } = fakeRoads();
    const w = await world(roads);
    const ranked = await w.rank();
    const got = ranked.map((s) => s.start.getTime());
    expect(got).not.toContain(at('2026-11-10', '15:30').getTime());
    const afternoon = ranked.filter((s) => s.start >= AFTER);
    expect(afternoon.length).toBeGreaterThan(0);
    for (const s of afternoon) expect(s.start.getTime() - AFTER.getTime()).toBeGreaterThanOrEqual(50 * MIN);
    for (const s of ranked) {
      expect(s.guaranteed).toBe(true);
      expect(s.sources).toEqual(['Itinéraires test']);
      expect(s.reason).toContain('Temps routier : Itinéraires test.');
      expect(s.reason).not.toContain('non garantie');
    }
    const first = afternoon[0]!;
    expect(first.travelBefore).toBe(50);
    // Tout créneau proposé était déjà libre : le temps sourcé ne fait qu'allonger la règle.
    for (const t of got) expect(w.free.map((s) => s.start.getTime())).toContain(t);
  });

  it('[R701] le service ne reçoit que deux positions, une fois par trajet, jamais une adresse, une référence ni un nom [R09]', async () => {
    const { roads, calls } = fakeRoads();
    const w = await world(roads);
    await w.rank();
    expect(calls.length).toBeGreaterThan(0);
    const keys = new Set<string>();
    for (const [from, to] of calls) {
      for (const p of [from, to]) expect(Object.keys(p as object).sort()).toEqual(['lat', 'lon']);
      const k = JSON.stringify([from, to]);
      expect(keys.has(k)).toBe(false);
      keys.add(k);
      expect(JSON.stringify([from, to])).not.toMatch(/B-ROUTE|Léa|Commune|21000/);
    }
  });

  it('[R701] une panne ou une réponse absurde du service ne fait rien inventer : l’estimation reste, non garantie', async () => {
    const bad: Array<() => unknown> = [
      () => { throw new Error('panne'); },
      () => null,
      () => ({ minutes: Number.NaN, source: 'X service' }),
      () => ({ minutes: -5, source: 'X service' }),
      () => ({ minutes: 9999, source: 'X service' }),
      () => ({ minutes: 50 }),
      () => ({ minutes: 50, source: '   ' }),
    ];
    for (const answer of bad) {
      const { roads } = fakeRoads(answer);
      const ranked = await (await world(roads)).rank();
      const half = ranked.find((s) => s.start.getTime() === at('2026-11-10', '15:30').getTime());
      expect(half, String(answer)).toBeDefined();
      expect(half!.guaranteed).toBe(false);
      expect(half!.reason).toContain('non garantie');
    }
  });

  it('[R701] le nom du service est nettoyé dans le motif : ni numéro ni signe d’adresse', async () => {
    const { roads } = fakeRoads(() => ({ minutes: 50, source: 'Routes <b>21000</b> n°12' }));
    const ranked = await (await world(roads)).rank();
    expect(ranked.length).toBeGreaterThan(0);
    for (const s of ranked) {
      expect(s.reason).not.toMatch(/21000|12|<|>/);
      expect(s.guaranteed).toBe(true);
    }
  });

  it('[R701] deux lieux distincts à quelques mètres consultent le service : jamais garantis sur la seule proximité', async () => {
    const { roads, calls } = fakeRoads();
    const ranked = await (await world(roads, VOISIN)).rank();
    expect(calls.some(([from, to]) => JSON.stringify(from) === JSON.stringify(DIJON) && JSON.stringify(to) === JSON.stringify(VOISIN))).toBe(true);
    expect(ranked.map((s) => s.start.getTime())).not.toContain(at('2026-11-10', '15:30').getTime());
    for (const s of ranked.filter((x) => x.start >= AFTER)) expect(s.start.getTime() - AFTER.getTime()).toBeGreaterThanOrEqual(50 * MIN);
    const blind = await (await world(null, VOISIN)).rank();
    expect(blind.length).toBeGreaterThan(0);
    expect(blind.every((s) => !s.guaranteed && s.reason.includes('non garantie'))).toBe(true);
  });

  it('[R701] la même position est le même lieu : aucun service consulté, rien à confirmer pour ce côté', async () => {
    const { roads, calls } = fakeRoads();
    const ranked = await (await world(roads, DIJON)).rank();
    expect(calls.every(([from, to]) => JSON.stringify(from) !== JSON.stringify(to))).toBe(true);
    const next = ranked.find((s) => s.start.getTime() === at('2026-11-10', '15:30').getTime());
    expect(next?.travelBefore).toBe(0);
    expect(next?.guaranteed).toBe(true);
  });
});
