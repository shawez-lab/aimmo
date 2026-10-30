import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, Mandats, MesureSources, SqlJournalStore, applyMigrations, fromSyncSqlite, type CostProofStore, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Octobre 2027 à Paris (UTC+2 jusqu'au 31). Réseau, agents, clients, coûts et preuves inventés.
const NOW = Date.parse('2027-11-03T09:00:00.000Z');

class FakeProofs implements CostProofStore {
  readonly refs = new Set(['preuves/facture-site-1.pdf', 'preuves/facture-site-2.pdf', 'preuves/facture-reseaux.pdf']);
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(NOW);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const mandats = new Mandats(db, fiche, journal, { now });
  const mesure = new MesureSources(db, new FakeProofs(), journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  let k = 0;
  /** Un client d'Alex venu par ce canal. */
  const client = async (who: string, channel: string | null) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: who, lastName: 'Essai' });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `${who.toLowerCase()}@example.test` });
    if (channel) await store.addSource({ networkId: network.id, agentId: alex.id, personId: p.id, channel, detail: null, occurredAt: new Date(NOW - 90 * 86_400_000) });
    return p.id;
  };
  const appointment = async (personId: string, startAt: string, status = 'honored', kind = 'estimation') => {
    const end = new Date(Date.parse(startAt) + 3_600_000).toISOString();
    await db.run(
      `INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, replaces_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'agent', NULL, ?, ?)`,
      [`rdv-${++k}`, network.id, alex.id, personId, kind, startAt, end, status, `h-${k}`, startAt, startAt],
    );
  };
  const mandate = async (personId: string, signedAt: string, source?: string) => {
    const r = await mandats.record(acces, agent, { personId, signedAt: new Date(signedAt), ...(source ? { source } : {}) });
    if (!r.ok) throw new Error(r.code);
  };
  return { db, journal, store, mesure, network, alex, agent, dir, client, appointment, mandate };
}

const line = (r: Awaited<ReturnType<MesureSources['report']>>, source: string) => (r.ok ? r.value.lines.find((l) => l.source === source) : undefined);

describeWithSqlite('G10 · mesure mensuelle des sources de mandats', () => {
  it('[R144] chaque nombre du compte rendu se recalcule à la main sur un jeu inventé', async () => {
    const t = await setup();
    const ana = await t.client('Ana', 'site');
    const ben = await t.client('Ben', 'site');
    const cleo = await t.client('Cleo', 'instagram');
    const dan = await t.client('Dan', 'recommandation');
    const eve = await t.client('Eve', null);
    // Mandats d'octobre à Paris : le 1er à 0 h 30 compte (30 septembre en temps universel), le 31 à 23 h 30 aussi.
    await t.mandate(ana, '2027-09-30T22:30:00.000Z');
    await t.mandate(ben, '2027-10-31T22:30:00.000Z');
    await t.mandate(dan, '2027-10-15T10:00:00.000Z');
    // Hors du mois : septembre à Paris, novembre à Paris.
    await t.mandate(cleo, '2027-09-30T21:30:00.000Z', 'social');
    await t.mandate(eve, '2027-10-31T23:30:00.000Z', 'portal');
    // Rendez-vous d'estimation tenus en octobre : Ana, Cleo, Eve (fiche sans source). Annulé, visite, novembre : non.
    await t.appointment(ana, '2027-10-05T08:00:00.000Z');
    await t.appointment(cleo, '2027-10-06T08:00:00.000Z');
    await t.appointment(eve, '2027-10-07T08:00:00.000Z');
    await t.appointment(ben, '2027-10-08T08:00:00.000Z', 'cancelled');
    await t.appointment(ben, '2027-10-09T08:00:00.000Z', 'honored', 'visite');
    await t.appointment(dan, '2027-11-02T08:00:00.000Z');
    // Coûts : le site corrigé en version 2, les réseaux sociaux.
    expect(await t.mesure.enterCost(t.dir, { month: '2027-10', source: 'site', amountCents: 30000, proofRef: 'preuves/facture-site-1.pdf' })).toEqual({ ok: true, value: { version: 1 } });
    expect(await t.mesure.enterCost(t.dir, { month: '2027-10', source: 'site', amountCents: 45001, proofRef: 'preuves/facture-site-2.pdf' })).toEqual({ ok: true, value: { version: 2 } });
    expect(await t.mesure.enterCost(t.dir, { month: '2027-10', source: 'social', amountCents: 20000, proofRef: 'preuves/facture-reseaux.pdf' })).toMatchObject({ ok: true });
    const r = await t.mesure.report(t.dir, '2027-10');
    // Calcul à la main : site 2 mandats, 1 rendez-vous, 450,01 € → 225,005 € arrondi à 22 501 centimes par mandat.
    expect(line(r, 'site')).toMatchObject({ mandates: 2, appointments: 1, costCents: 45001, costPerMandateCents: 22501 });
    expect(line(r, 'social')).toMatchObject({ mandates: 0, appointments: 1, costCents: 20000, costPerMandateCents: null });
    expect(line(r, 'referral')).toMatchObject({ mandates: 1, appointments: 0, costCents: null, costPerMandateCents: null });
    expect(line(r, 'inconnue')).toMatchObject({ label: 'Source inconnue', mandates: 0, appointments: 1 });
    expect(r.ok && r.value.totals).toEqual({ mandates: 3, appointments: 3, costCents: 65001 });
  });

  it('[R144] aucune décision automatique : seule la direction garde ou arrête une source, sa décision rangée telle quelle', async () => {
    const t = await setup();
    await t.mesure.enterCost(t.dir, { month: '2027-10', source: 'social', amountCents: 900000, proofRef: 'preuves/facture-reseaux.pdf' });
    const before = await t.mesure.report(t.dir, '2027-10');
    // Une source qui coûte cher sans mandat n'est ni arrêtée ni signalée par le code.
    expect(before.ok && before.value.lines.every((l) => l.decision === null)).toBe(true);
    expect(before.ok && Object.keys(before.value.lines[0]!).sort()).toEqual(['appointments', 'costCents', 'costPerMandateCents', 'decision', 'label', 'mandates', 'source']);
    expect(await t.db.all('SELECT * FROM mandate_source_decisions')).toEqual([]);
    expect(await t.mesure.decide(t.dir, { month: '2027-10', source: 'social', decision: 'arreter', reason: 'Aucun mandat en trois mois' })).toMatchObject({ ok: true });
    expect(line(await t.mesure.report(t.dir, '2027-10'), 'social')!.decision).toEqual({ decision: 'arreter', month: '2027-10', decidedAt: new Date(NOW).toISOString() });
    expect(await t.mesure.decide(t.dir, { month: '2027-10', source: 'social', decision: 'supprimer', reason: 'x y z' })).toEqual({ ok: false, rule: null, code: 'bad_decision' });
    // Corrigée à la même milliseconde : la dernière décision rangée fait foi, quel que soit son identifiant.
    expect(await t.mesure.decide(t.dir, { month: '2027-10', source: 'social', decision: 'garder', reason: 'Correction de la direction' })).toMatchObject({ ok: true });
    expect(line(await t.mesure.report(t.dir, '2027-10'), 'social')!.decision).toMatchObject({ decision: 'garder' });
    // Le code seul ne peut pas écrire une décision : la base exige la direction.
    await expect(t.db.run("INSERT INTO mandate_source_decisions (id, network_id, month, source, seq, decision, reason, decided_by, decided_at) VALUES ('d', ?, '2027-10', 'site', 1, 'arreter', 'auto', 'system:planificateur', '2027-11-01')", [t.network.id])).rejects.toThrow();
    await expect(t.db.run('DELETE FROM mandate_source_decisions')).rejects.toThrow(/rien ne s'efface/);
    // Un coût sans preuve déposée n'est pas un chiffre de la base.
    expect(await t.mesure.enterCost(t.dir, { month: '2027-10', source: 'site', amountCents: 100, proofRef: 'preuves/inconnue.pdf' })).toEqual({ ok: false, rule: 'R144', code: 'no_proof' });
  });

  it('[R13] aucune donnée personnelle dans le compte rendu ni au journal', async () => {
    const t = await setup();
    const ana = await t.client('Ana', 'site');
    await t.mandate(ana, '2027-10-10T10:00:00.000Z');
    await t.appointment(ana, '2027-10-05T08:00:00.000Z');
    const r = await t.mesure.report(t.dir, '2027-10');
    expect(JSON.stringify(r)).not.toMatch(/Ana|Essai|example\.test|person/);
    expect(JSON.stringify((await t.journal.all()).filter((e) => e.type.startsWith('mesure_sources')))).not.toMatch(/Ana|example\.test|person/);
  });

  it('[R16] seule la direction lit le compte rendu, saisit les coûts et décide ; chaque refus au journal', async () => {
    const t = await setup();
    const others = [t.agent, { role: 'compliance' as const, userId: 'c-1', networkId: t.network.id }, { role: 'partner' as const, userId: 'p-1', networkId: t.network.id }];
    for (const v of others) {
      expect(await t.mesure.report(v, '2027-10')).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.mesure.enterCost(v, { month: '2027-10', source: 'site', amountCents: 1, proofRef: 'preuves/facture-site-1.pdf' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.mesure.decide(v, { month: '2027-10', source: 'site', decision: 'garder', reason: 'bien' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse')).toHaveLength(9);
    expect(await t.db.all('SELECT * FROM mandate_source_costs')).toEqual([]);
    expect(await t.mesure.report(t.dir, '2027-13')).toEqual({ ok: false, rule: null, code: 'bad_month' });
  });
});
