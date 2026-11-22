import { describe, expect, it } from 'vitest';
import { Attribution, Qualification, ReconnaissanceBien, SqlJournalStore, applyMigrations, callbackDeadline, createCaptation, fromSyncSqlite, nextCallbackOpening, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const HOUR = 3_600_000;
const at = (iso: string): number => Date.parse(iso);

describe('AU042 · le délai de rappel ne court que pendant le service', () => {
  it('[R682] un délai pris en semaine pendant les heures garde ses heures écoulées', () => {
    // Mardi 8 décembre 2026, 10 h à Paris (9 h UTC).
    expect(callbackDeadline(at('2026-12-08T09:00:00Z'), 24)).toBe(at('2026-12-09T09:00:00Z'));
    expect(callbackDeadline(at('2026-12-08T09:00:00Z'), 8)).toBe(at('2026-12-08T17:00:00Z'));
  });

  it('[R682] un contact du samedi soir : rien ne court le dimanche, la limite tombe le lundi ou le mardi aux heures ouvertes', () => {
    // Samedi 12 décembre 2026, 21 h à Paris : le service est fermé jusqu'au lundi 8 h.
    const saturday = at('2026-12-12T20:00:00Z');
    expect(nextCallbackOpening(saturday)).toBe(at('2026-12-14T07:00:00Z'));
    // 8 h : lundi 16 h ; 24 h : mardi 8 h.
    expect(callbackDeadline(saturday, 8)).toBe(at('2026-12-14T15:00:00Z'));
    expect(callbackDeadline(saturday, 24)).toBe(at('2026-12-15T07:00:00Z'));
    // Samedi 18 h, contact chaud : 2 h le samedi, puis le dimanche ne compte pas, limite reportée au lundi 8 h.
    expect(callbackDeadline(at('2026-12-12T17:00:00Z'), 8)).toBe(at('2026-12-14T07:00:00Z'));
  });

  it('[R682] une limite qui tombe la nuit passe à l’ouverture du matin ; un jour férié ne compte pas', () => {
    // Mercredi 9 décembre 2026 à 15 h, 8 h : 23 h la nuit, donc jeudi 8 h.
    expect(callbackDeadline(at('2026-12-09T14:00:00Z'), 8)).toBe(at('2026-12-10T07:00:00Z'));
    // Jeudi 24 décembre 2026 à 15 h, 24 h : le 25 est férié, la limite passe au samedi 26 à 15 h.
    expect(callbackDeadline(at('2026-12-24T14:00:00Z'), 24)).toBe(at('2026-12-26T14:00:00Z'));
  });

  it('[R682] la limite n’est jamais plus tôt que l’heure écoulée, changement d’heure compris', () => {
    // Samedi 24 octobre 2026, 19 h à Paris (17 h UTC), la nuit du changement d'heure passe dans le dimanche fermé.
    const start = at('2026-10-24T17:00:00Z');
    const deadline = callbackDeadline(start, 24);
    expect(deadline).toBeGreaterThanOrEqual(start + 24 * HOUR);
    // 5 h le samedi jusqu'à minuit, le dimanche ne compte pas, puis 19 h le lundi : lundi 19 h, heure d'hiver (18 h UTC).
    expect(deadline).toBe(at('2026-10-26T18:00:00Z'));
    // Un service ouvert le dimanche compte le jour de 25 heures du changement d'heure à sa vraie durée.
    const open7 = { timeZone: 'Europe/Paris', from: 8 * 60, until: 20 * 60, days: [1, 2, 3, 4, 5, 6, 7], closedOnHolidays: true };
    expect(callbackDeadline(start, 24, open7)).toBe(start + 24 * HOUR);
    expect(callbackDeadline(at('2026-03-28T17:00:00Z'), 24, open7)).toBe(at('2026-03-29T17:00:00Z'));
    for (let t = at('2026-01-01T00:00:00Z'); t < at('2027-01-01T00:00:00Z'); t += 7 * HOUR + 13 * 60_000) {
      for (const h of [8, 24]) expect(callbackDeadline(t, h)).toBeGreaterThanOrEqual(t + h * HOUR);
    }
  });

  it('[R682] l’ouverture se trouve en heure locale, même la nuit du changement d’heure', () => {
    const open7 = { timeZone: 'Europe/Paris', from: 8 * 60, until: 20 * 60, days: [1, 2, 3, 4, 5, 6, 7], closedOnHolidays: true };
    // Samedi 28 mars 2026, 21 h à Paris ; le dimanche 29 passe à l'heure d'été, l'ouverture de 8 h est 6 h UTC.
    expect(nextCallbackOpening(at('2026-03-28T20:00:00Z'), open7)).toBe(at('2026-03-29T06:00:00Z'));
    expect(callbackDeadline(at('2026-03-28T20:00:00Z'), 8, open7)).toBe(at('2026-03-29T14:00:00Z'));
    // Dimanche 25 octobre 2026, passage à l'heure d'hiver : 8 h est 7 h UTC.
    expect(nextCallbackOpening(at('2026-10-24T20:00:00Z'), open7)).toBe(at('2026-10-25T07:00:00Z'));
    for (let t = at('2026-03-27T00:00:00Z'); t < at('2026-03-31T00:00:00Z'); t += 17 * 60_000) {
      const o = nextCallbackOpening(t, open7);
      expect(o).toBeGreaterThanOrEqual(t);
      // Jamais une minute ouverte sautée : la minute d'avant l'ouverture trouvée est fermée, ou c'est l'instant donné.
      if (o > t) expect(nextCallbackOpening(o - 60_000, open7)).toBe(o);
    }
  });

  it('[R682] les heures du service sont un réglage', () => {
    const allWeek = { timeZone: 'Europe/Paris', from: 0, until: 1440, days: [1, 2, 3, 4, 5, 6, 7], closedOnHolidays: false };
    const saturday = at('2026-12-12T20:00:00Z');
    expect(callbackDeadline(saturday, 24, allWeek)).toBe(saturday + 24 * HOUR);
    expect(() => callbackDeadline(saturday, 8, { ...allWeek, days: [] })).toThrow();
  });
});

async function setup(start: number) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = start;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const { chaine, store, fiche, reception } = createCaptation(db, journal, { now, withQualification: false });
  const qualification = new Qualification(db, store, fiche, reception, new ReconnaissanceBien(db), journal, { now });
  const attribution = new Attribution(db, fiche, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  await attribution.addZone(network.id, alex.id, 'Talant');
  await attribution.addZone(network.id, sam.id, 'Talant');
  await chaine.receive(network.id, 'site_form', { submissionId: 'f-1', email: 'zoe@example.test', message: 'Je souhaite vendre ma maison à Talant.' });
  const row = await db.first<{ id: string }>('SELECT id FROM inbound_messages ORDER BY rowid DESC LIMIT 1');
  const q = (await qualification.qualify(row!.id))!.id;
  return { attribution, network, q, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('AU042 · la réattribution attend le service de rappel', () => {
  it('[R682] [R25] un contact du samedi soir n’est pas retiré à son agent le dimanche, il l’est le mardi matin', async () => {
    const saturday = at('2026-12-12T20:00:00Z');
    const t = await setup(saturday);
    const first = (await t.attribution.attribute(t.q))!;
    expect(first).toMatchObject({ callback_hours: 24, reason: 'zone' });
    // Le constat de l'audit : 24 h écoulées, dimanche 21 h, le contact changeait d'agent pendant la fermeture.
    t.setClock(saturday + 24 * HOUR);
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
    t.setClock(at('2026-12-14T20:00:00Z'));
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
    t.setClock(at('2026-12-15T06:59:00Z'));
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
    t.setClock(at('2026-12-15T07:00:00Z'));
    const [next] = await t.attribution.reassignOverdue(t.network.id);
    expect(next).toMatchObject({ reason: 'reassigned', replaces_id: first.id });
    expect(next!.agent_id).not.toBe(first.agent_id);
  });
});
