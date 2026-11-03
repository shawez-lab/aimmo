import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { IndicateursReseau } from '../src/pilotage/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseau, agents, zones, contacts.
const JUNE = '2027-06-10T10:00:00.000Z';

async function setup() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  raw.exec('PRAGMA foreign_keys = OFF');
  const now = (): Date => new Date('2027-07-02T10:00:00.000Z');
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const direction = as('direction', 'direction-1');
  const agent = async (id: string, zone: string | null, createdAt = '2020-01-01T00:00:00.000Z', status = 'active') => {
    await db.run('INSERT INTO agents (id, network_id, first_name, last_name, zone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, network.id, 'Prénom', 'Nom', zone, status, createdAt, createdAt]);
  };
  let n = 0;
  const contacts = async (agentId: string, count: number, at = JUNE, reason = 'zone') => {
    for (let i = 0; i < count; i++) {
      n += 1;
      await db.run('INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, 2, NULL, ?)', [`at-${n}`, network.id, `p-${n}`, agentId, reason, at]);
    }
  };
  let seq = 0;
  const mandate = async (id: string, agentId: string, signedAt = JUNE) => {
    seq += 1;
    await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, 'p', ?, 'referral', 'x', ?)", [id, network.id, agentId, signedAt, signedAt]);
    await db.run("INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, signed_at, at, actor, prev_hash, hash) VALUES (?, ?, 'inscription', ?, ?, ?, ?, ?, ?, 'x', 'p', ?)", [network.id, seq, id, seq, `T-${seq}`, agentId, signedAt, signedAt, `h-${id}`]);
  };
  const ind = new IndicateursReseau(db, journal, { now });
  return { db, journal, as, direction, agent, contacts, mandate, ind, network };
}

describeWithSqlite('IN04 · indicateurs du réseau', () => {
  it('[R14] [R215] les agents qui signent : un compte, chacun une fois, sans mandat retiré ni pas inscrit, sans nom', async () => {
    const t = await setup();
    for (const id of ['a', 'b', 'c', 'd']) await t.agent(id, 'Z');
    await t.mandate('m1', 'a');
    await t.mandate('m2', 'a');
    await t.mandate('m3', 'b');
    await t.mandate('m4', 'c');
    await t.db.run('INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['m4', t.network.id, 'preuve', JUNE, 'x', JUNE]);
    await t.db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, signed_at, source_kind, recorded_by, created_at) VALUES ('m5', ?, 'd', 'p', ?, 'referral', 'x', ?)", [t.network.id, JUNE, JUNE]);
    await t.mandate('m6', 'd', '2027-05-10T10:00:00.000Z');
    const r = await t.ind.people(t.direction, '2027-06');
    if (!r.ok) throw new Error(r.code);
    expect(r.value.activeSigners).toBe(2);
    expect(JSON.stringify(r.value)).not.toMatch(/"(a|b|c|d)"/);
  });

  it('[R215] restés au bout d’un an : l’entrée vient du dossier, un agent parti ne compte plus, un autre mois non plus', async () => {
    const t = await setup();
    const june26 = '2026-06-15T10:00:00.000Z';
    await t.agent('reste', 'Z', june26);
    await t.agent('statut-parti', 'Z', june26, 'left');
    await t.agent('depart-passe', 'Z', june26);
    await t.agent('depart-futur', 'Z', june26);
    await t.agent('depart-annule', 'Z', june26);
    await t.agent('autre-mois', 'Z', '2026-07-15T10:00:00.000Z');
    await t.agent('entre-par-m14', 'Z', '2025-01-01T10:00:00.000Z');
    await t.db.run("INSERT INTO agent_onboardings (agent_id, network_id, candidate_id, created_by, created_at) VALUES ('entre-par-m14', ?, 'cand', 'x', ?)", [t.network.id, june26]);
    const departure = (id: string, agent: string, on: string, cancelled: string | null) => t.db.run("INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at, cancelled_at) VALUES (?, ?, ?, '2027-01-01', ?, 'demission_agent', 1, 'x', ?, ?)", [id, t.network.id, agent, on, JUNE, cancelled]);
    await departure('d1', 'depart-passe', '2027-06-30', null);
    await departure('d2', 'depart-futur', '2027-09-30', null);
    await departure('d3', 'depart-annule', '2027-06-30', JUNE);
    const r = await t.ind.people(t.direction, '2027-06');
    if (!r.ok) throw new Error(r.code);
    // Entrés en juin 2026 : 6 ; partis : le statut et le départ passé ; restent 4.
    expect(r.value.retainedAfterYear).toEqual({ numerator: 4, denominator: 6, bp: 6667, cohortMonth: '2026-06' });
    const none = await t.ind.people(t.direction, '2027-01');
    if (!none.ok) throw new Error(none.code);
    expect(none.value.retainedAfterYear).toEqual({ numerator: 0, denominator: 0, bp: null, cohortMonth: '2026-01' });
  });

  it('[R68] [R215] un agent ne retrouve le chiffre d’aucun autre : 3 agents se montrent, 2 non, seul seulement pour lui', async () => {
    const t = await setup();
    for (const id of ['g1', 'g2', 'g3']) await t.agent(id, 'Grande');
    for (const id of ['d1', 'd2']) await t.agent(id, 'Double');
    await t.agent('s1', 'Seule A');
    await t.agent('s2', 'Seule B');
    await t.agent('parti', 'Double', undefined, 'left');
    await t.contacts('g1', 5);
    await t.contacts('g2', 2);
    await t.contacts('d1', 3);
    await t.contacts('d2', 4);
    await t.contacts('s1', 7);
    await t.contacts('s2', 11);
    // Le 3e agent de « Double » est parti : elle reste à 2 en activité, donc retenue, même pour l'un des siens.
    const seenBy = async (id: string) => {
      const r = await t.ind.contactsByZone(t.as('agent', id), '2027-06');
      if (!r.ok) throw new Error(r.code);
      return r.value;
    };
    const big = await seenBy('g1');
    expect(big.zones).toEqual([{ zone: 'Grande', contacts: 7 }]);
    expect(big.otherZones).toEqual({ zones: 3, contacts: 25 });
    const inDouble = await seenBy('d1');
    expect(inDouble.zones).toEqual([{ zone: 'Grande', contacts: 7 }]);
    const alone = await seenBy('s1');
    expect(alone.zones).toEqual([{ zone: 'Grande', contacts: 7 }, { zone: 'Seule A', contacts: 7 }]);
    expect(alone.otherZones).toEqual({ zones: 2, contacts: 18 });
    // Aucun chiffre d'agent ni total : la direction seule voit les petites zones.
    expect(JSON.stringify(big)).not.toMatch(/total|g2|"agent/i);
    const all = await t.ind.contactsByZone(t.direction, '2027-06');
    if (!all.ok) throw new Error(all.code);
    expect(all.value.zones).toEqual([{ zone: 'Double', contacts: 7 }, { zone: 'Grande', contacts: 7 }, { zone: 'Seule A', contacts: 7 }, { zone: 'Seule B', contacts: 11 }]);
  });

  it('[R68] [R215] un regroupement d’une seule zone n’est pas rendu : il dirait son chiffre', async () => {
    const t = await setup();
    for (const id of ['g1', 'g2', 'g3']) await t.agent(id, 'Grande');
    await t.agent('s1', 'Seule A');
    await t.contacts('g1', 1);
    await t.contacts('s1', 9);
    const r = await t.ind.contactsByZone(t.as('agent', 'g1'), '2027-06');
    if (!r.ok) throw new Error(r.code);
    expect(r.value.otherZones).toBeNull();
    expect(JSON.stringify(r.value)).not.toContain('9');
  });

  it('[R215] un contact compte une fois, chez qui le tient ; un client déjà suivi n’est pas transmis ; le mois en cours est refusé', async () => {
    const t = await setup();
    for (const id of ['a', 'b']) await t.agent(id, 'Un');
    await t.agent('c', 'Deux');
    await t.contacts('a', 1);
    await t.db.run("INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at) VALUES ('re-1', ?, 'p-1', NULL, 'c', 'reassigned', 2, 'at-1', ?)", [t.network.id, JUNE]);
    await t.contacts('b', 1, JUNE, 'already_followed');
    await t.contacts('b', 1, '2027-05-31T21:59:00.000Z'); // encore mai à Paris
    await t.contacts('b', 1, '2027-06-30T22:00:00.000Z'); // déjà juillet à Paris
    const r = await t.ind.contactsByZone(t.direction, '2027-06');
    if (!r.ok) throw new Error(r.code);
    expect(r.value.zones).toEqual([{ zone: 'Deux', contacts: 1 }]);
    expect(await t.ind.contactsByZone(t.direction, '2027-07')).toEqual({ ok: false, rule: 'R215', code: 'month_not_finished' });
    expect(await t.ind.people(t.direction, 'juin')).toEqual({ ok: false, rule: null, code: 'bad_month' });
  });

  it('[R16] [R215] les comptes de personnes pour la direction seule ; les refus sont au journal ; un autre réseau ne voit rien', async () => {
    const t = await setup();
    await t.agent('a', 'Z');
    await t.contacts('a', 2);
    expect(await t.ind.people(t.as('agent', 'a'), '2027-06')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.ind.contactsByZone(t.as('compliance', 'c-1'), '2027-06')).toMatchObject({ ok: false, rule: 'R16' });
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refused).toHaveLength(2);
    const other = await t.ind.contactsByZone({ role: 'direction', userId: 'd', networkId: 'autre' } as Viewer, '2027-06');
    if (!other.ok) throw new Error(other.code);
    expect(other.value.zones).toEqual([]);
  });
});
