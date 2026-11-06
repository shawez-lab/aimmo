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
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Novembre 2026 : Paris est à UTC+1. Lieux approchés de communes réelles ; biens, personnes et agent inventés.
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const NOW = at('2026-11-09', '08:00');
const WEEK: Availability = { weekly: [1, 2, 3, 4, 5].flatMap((weekday) => [{ weekday, from: '09:00', to: '12:00' }, { weekday, from: '14:00', to: '18:00' }]) };
const AGENCE: Place = { lat: 47.322, lon: 5.0415 };
const DIJON: Place = { lat: 47.325, lon: 5.04 };
const CHENOVE: Place = { lat: 47.29, lon: 5.01 };
const BEAUNE: Place = { lat: 47.0244, lon: 4.84 };
const POMMARD: Place = { lat: 47.009, lon: 4.795 };

async function world() {
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
  const positions = new Map<string, Place>();
  const property = async (reference: string, place: Place | null) => {
    const p = await store.createProperty({ networkId: net.id, agentId: paul.id, reference, kind: 'home', postalCode: '21000', city: 'Commune test' });
    if (place) positions.set(p.id, place);
    return p.id;
  };
  const book = async (start: Date, propertyId: string | null, kind: 'estimation' | 'visite' = 'estimation') => {
    const r = await rdv.book({ networkId: net.id, agentId: paul.id, personId: lea.id, propertyId, kind, start, source: 'agent' });
    if (!r.ok) throw new Error(`refusé : ${r.code}`);
  };
  const best = new MeilleursCreneaux(db, { placeOf: async (id) => positions.get(id) ?? null });
  const free = (kind: 'estimation' | 'appel', from: string, to: string) => rdv.freeSlotsFor(paul.id, kind, at(from, '00:00'), at(to, '23:59'));
  return { paul, property, book, best, free };
}

describeWithSqlite('HX02 · le meilleur créneau, trajets compris (Jamais vu)', () => {
  it('[R237] un créneau dont le trajet réel ne tient pas dans l’écart n’est pas proposé ; jamais moins que le trajet minimal [R32]', async () => {
    const w = await world();
    await w.book(at('2026-11-10', '14:00'), await w.property('B-BEAUNE', BEAUNE));
    const free = await w.free('estimation', '2026-11-10', '2026-11-10');
    const starts = free.map((s) => s.start.getTime());
    expect(starts).toContain(at('2026-11-10', '15:30').getTime());
    const ranked = await w.best.rank({ agentId: w.paul.id, kind: 'estimation', target: CHENOVE, free, base: AGENCE, limit: 100 });
    const got = ranked.map((s) => s.start.getTime());
    // Beaune → Chenôve : bien plus que les 30 minutes du trajet minimal ; rien entre 15 h 30 et l'arrivée possible.
    const travel = roadEstimate(BEAUNE, CHENOVE);
    expect(travel).toBeGreaterThan(30);
    for (const s of ranked) {
      if (s.start > at('2026-11-10', '15:00')) expect(s.start.getTime() - at('2026-11-10', '15:00').getTime()).toBeGreaterThanOrEqual(travel * 60_000);
    }
    expect(got).not.toContain(at('2026-11-10', '15:30').getTime());
    // Le matin, Chenôve → Beaune tient avant 14 h.
    expect(got).toContain(at('2026-11-10', '09:00').getTime());
    // Tout créneau proposé était déjà libre par V01 : le trajet réel ne fait qu'allonger la règle.
    for (const t of got) expect(starts).toContain(t);
  });

  it('[R237] le créneau qui ajoute le moins de route passe en premier, même un autre jour', async () => {
    const w = await world();
    // Mardi : une visite à Dijon. Mercredi : une visite à Beaune. Le nouveau bien est à Pommard, à côté de Beaune.
    await w.book(at('2026-11-10', '09:00'), await w.property('B-DIJON', DIJON));
    await w.book(at('2026-11-11', '09:00'), await w.property('B-BEAUNE', BEAUNE));
    const free = await w.free('estimation', '2026-11-10', '2026-11-11');
    const ranked = await w.best.rank({ agentId: w.paul.id, kind: 'estimation', target: POMMARD, free, base: AGENCE, limit: 5 });
    expect(ranked).toHaveLength(5);
    const first = ranked[0]!;
    expect(first.start.getTime()).toBe(at('2026-11-11', '10:30').getTime());
    expect(first.travelBefore).toBe(roadEstimate(BEAUNE, POMMARD));
    expect(first.addedMinutes!).toBeLessThan(60);
    // Les créneaux du mardi, plus tôt mais loin de toute visite voisine, coûtent bien plus de route.
    const tuesday = (await w.best.rank({ agentId: w.paul.id, kind: 'estimation', target: POMMARD, free: free.filter((s) => s.start < at('2026-11-11', '00:00')), base: AGENCE }))[0]!;
    expect(tuesday.addedMinutes!).toBeGreaterThan(first.addedMinutes! + 60);
    for (let i = 1; i < ranked.length; i++) expect(ranked[i]!.addedMinutes!).toBeGreaterThanOrEqual(ranked[i - 1]!.addedMinutes!);
  });

  it('[R09] le motif ne donne que des minutes, jamais une référence, une adresse ni un nom', async () => {
    const w = await world();
    await w.book(at('2026-11-10', '09:00'), await w.property('B-SECRET-42', DIJON));
    const ranked = await w.best.rank({ agentId: w.paul.id, kind: 'estimation', target: CHENOVE, free: await w.free('estimation', '2026-11-10', '2026-11-10'), base: AGENCE });
    expect(ranked.length).toBeGreaterThan(0);
    for (const s of ranked) {
      expect(s.reason).toMatch(/min/);
      for (const secret of ['B-SECRET', 'Léa', 'Exemple', 'Commune test', '21000']) expect(s.reason).not.toContain(secret);
    }
  });

  it('[R237] un lieu inconnu ne fait rien inventer : le créneau reste, après les autres, avec le trajet minimal seul', async () => {
    const w = await world();
    await w.book(at('2026-11-10', '09:00'), await w.property('B-SANS-LIEU', null));
    await w.book(at('2026-11-11', '09:00'), await w.property('B-DIJON', DIJON));
    const free = await w.free('estimation', '2026-11-10', '2026-11-11');
    const ranked = await w.best.rank({ agentId: w.paul.id, kind: 'estimation', target: CHENOVE, free, base: AGENCE, limit: 200 });
    const firstUnknown = ranked.findIndex((s) => s.addedMinutes === null);
    expect(firstUnknown).toBeGreaterThan(0);
    expect(ranked.slice(firstUnknown).every((s) => s.addedMinutes === null && s.reason.startsWith('Lieu inconnu'))).toBe(true);
    expect(ranked.slice(0, firstUnknown).every((s) => s.addedMinutes !== null)).toBe(true);
    // Sans lieu pour le nouveau bien, tout reste proposé, dans l'ordre, sans aucun chiffre de route.
    const blind = await w.best.rank({ agentId: w.paul.id, kind: 'estimation', target: null, free, base: AGENCE, limit: 3 });
    expect(blind.map((s) => s.start.getTime())).toEqual(free.slice(0, 3).map((s) => s.start.getTime()));
    expect(blind.every((s) => s.addedMinutes === null)).toBe(true);
  });

  it('un appel ne demande aucun trajet : les créneaux restent dans l’ordre', async () => {
    const w = await world();
    await w.book(at('2026-11-10', '09:00'), await w.property('B-BEAUNE', BEAUNE));
    const free = await w.free('appel', '2026-11-10', '2026-11-10');
    const ranked = await w.best.rank({ agentId: w.paul.id, kind: 'appel', target: CHENOVE, free, base: AGENCE });
    expect(ranked.map((s) => s.start.getTime())).toEqual(free.slice(0, 3).map((s) => s.start.getTime()));
    expect(ranked.every((s) => s.addedMinutes === 0)).toBe(true);
  });
});

it('l’estimation de route est la même à chaque calcul, nulle sur place, arrondie aux 5 minutes', () => {
  expect(roadEstimate(DIJON, DIJON)).toBe(0);
  const a = roadEstimate(DIJON, BEAUNE);
  expect(a).toBe(roadEstimate(DIJON, BEAUNE));
  expect(a % 5).toBe(0);
  expect(a).toBeGreaterThan(60);
  expect(roadEstimate(DIJON, CHENOVE)).toBeLessThan(30);
});
