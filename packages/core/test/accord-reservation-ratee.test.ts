import { expect, it } from 'vitest';
import { APPOINTMENT_PURPOSE, DecisionEnvoi, FicheClient, FicheUnique, RendezVous, SqlJournalStore, applyMigrations, decideSend, fromSyncSqlite, parisInstant, type AppointmentKind } from '../src/index.ts';
import { ReservationEnLigne } from '../src/rendezvous/en-ligne.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé. Le 10 novembre 2026 est un mardi.
const at = (day: string, hour: number): Date => parisInstant(day, hour * 60)!;
const WEEK = { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, from: '09:00', to: '18:00' })) };

async function setup() {
  let clock = at('2026-11-09', 8).getTime();
  const now = (): Date => new Date((clock += 1));
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Paul', lastName: 'Essai' });
  const journal = new SqlJournalStore(db);
  let busy: { start: Date; end: Date }[] = [];
  let calls = 0;
  let from: number | null = null;
  const agenda = { busy: async () => (++calls, from !== null && calls >= from ? busy : []) };
  const options = { now, linkBase: 'https://essai.example.test/', agenda };
  await new RendezVous(db, journal, options).setAvailability({ role: 'agent', userId: agent.id, networkId: network.id }, WEEK);
  const online = new ReservationEnLigne(db, journal, options);
  const input = (start: Date) => ({ networkId: network.id, agentId: agent.id, kind: 'estimation' as AppointmentKind, start, source: 'site' as const, firstName: 'Léa', email: 'lea.inventee@example.test', consentProof: 'case cochée sur le site' });
  // Le créneau est libre au premier contrôle, pris au second : la réservation échoue après avoir rangé l'accord.
  const takeAfterCheck = (start: Date) => {
    busy = [{ start, end: new Date(start.getTime() + 3_600_000) }];
    from = calls + 2;
  };
  const decision = new DecisionEnvoi(db, store, fiche, { now });
  const canRemind = async () => {
    const row = await db.first<{ person_id: string }>('SELECT person_id FROM consents');
    return decision.decide(row!.person_id, { channel: 'email', kind: 'reminder', purpose: APPOINTMENT_PURPOSE, at: at('2026-11-09', 10) });
  };
  return { db, online, input, takeAfterCheck, canRemind };
}

describeWithSqlite('AC05 · une réservation ratée n’est pas un refus de la personne', () => {
  it('[R03] [R17] le rendez-vous déjà pris garde ses rappels ; la ligne de l’essai raté reste, fermée, et n’ouvre rien', async () => {
    const t = await setup();
    expect((await t.online.book(t.input(at('2026-11-10', 9)))).ok).toBe(true);
    expect((await t.canRemind()).allowed).toBe(true);

    const second = at('2026-11-11', 9);
    t.takeAfterCheck(second);
    expect((await t.online.book(t.input(second))).ok).toBe(false);

    const rows = await t.db.all<{ given_at: string; withdrawn_at: string | null }>('SELECT given_at, withdrawn_at FROM consents ORDER BY given_at');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.withdrawn_at).toBeNull();
    expect(rows[1]!.withdrawn_at).toBe(rows[1]!.given_at);
    expect((await t.canRemind()).allowed).toBe(true);
  });

  it('[R03] une première réservation ratée ne laisse aucun accord qui compte', async () => {
    const t = await setup();
    const start = at('2026-11-10', 9);
    t.takeAfterCheck(start);
    expect((await t.online.book(t.input(start))).ok).toBe(false);
    expect((await t.canRemind()).rule).toBe('R03');
  });

  it('[R03] un vrai retrait, même d’une seconde après l’accord, ferme bien l’accord plus ancien', () => {
    const consent = (given_at: string, withdrawn_at: string | null = null) => ({ channel: 'email' as const, purpose: APPOINTMENT_PURPOSE, given_at, withdrawn_at });
    const ask = (consents: ReturnType<typeof consent>[]) =>
      decideSend(
        { channel: 'email', kind: 'reminder', purpose: APPOINTMENT_PURPOSE, at: at('2026-11-10', 10) },
        { exclusions: [], consents, messages: [], relations: [], sentToday: { review_request: 0, partner: 0 } },
      );
    const old = consent('2026-03-01T10:00:00.000Z');
    expect(ask([old, consent('2026-04-01T10:00:00.000Z', '2026-04-01T10:00:00.000Z')]).allowed).toBe(true);
    expect(ask([old, consent('2026-04-01T10:00:00.000Z', '2026-04-01T10:00:01.000Z')]).rule).toBe('R03');
  });
});
