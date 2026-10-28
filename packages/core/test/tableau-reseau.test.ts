import { expect } from 'vitest';
import { it } from 'vitest';
import { ActeVente, Echeancier } from '../src/dossiers/index.ts';
import { Commissions, TableauReseau } from '../src/pilotage/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : agents, zones, clients, messages, coûts.
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

async function setup() {
  const t = await setupDossier('appartement');
  const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
  const commissions = (options: ConstructorParameters<typeof Commissions>[3] = {}) => new Commissions(t.db, t.acces, t.journal, { now: t.now, ...options });
  const compromis = async () => {
    await t.startCompromis();
    t.setClock(at9('2027-03-11'));
    for (const [kind, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['etat_date_attendu', '2027-05-20'], ['acte_prevu', '2027-06-10']] as const) {
      const r = await echeancier.record(t.agent, t.fileId, { kind, day, proofRef: PROOF });
      if (!r.ok) throw new Error(r.code);
    }
  };
  const acte = async () => {
    const status = await t.pieces.status(t.agent, t.fileId);
    if (!status.ok) throw new Error(status.code);
    for (const piece of status.value.missing) {
      const r = await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-11' });
      if (!r.ok) throw new Error(r.code);
    }
    t.setClock(at9('2027-06-11'));
    const r = await new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
    if (!r.ok) throw new Error(r.code);
  };
  return { ...t, commissions, compromis, acte };
}



describeWithSqlite('K05 · tableau de bord du réseau', () => {
  async function world() {
    const t = await setup();
    const c = t.commissions();
    await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 });
    await t.compromis();
    await c.sync(t.network.id);
    await t.acte();
    await c.sync(t.network.id);
    await t.db.run("UPDATE agents SET zone = 'Dijon centre' WHERE id = ?", [t.alexId]);
    let n = 0;
    const contact = async (agentId: string | null, channel: string | null, at: string) => {
      n += 1;
      const p = await t.store.createPerson({ networkId: t.network.id, agentId, firstName: `Client${n}` });
      let qualification: string | null = null;
      if (channel) {
        await t.db.run("INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, external_id, body, status, received_at, created_at) VALUES (?, ?, ?, ?, 'direct', ?, 'Bonjour', 'processed', ?, ?)", [`in-${n}`, t.network.id, `k${n}`, channel, `x${n}`, at, at]);
        await t.db.run("INSERT INTO qualifications (id, network_id, inbound_id, person_id, category, source, created_at) VALUES (?, ?, ?, ?, 'seller', 'rules', ?)", [`q-${n}`, t.network.id, `in-${n}`, p.id, at]);
        qualification = `q-${n}`;
      }
      await t.db.run("INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at) VALUES (?, ?, ?, ?, ?, 'zone', 24, NULL, ?)", [`att-${n}`, t.network.id, p.id, qualification, agentId, at]);
      return p.id;
    };
    const p1 = await contact(t.alexId, 'email', '2027-06-02T08:00:00.000Z');
    await contact(t.alexId, null, '2027-06-03T08:00:00.000Z');
    await contact(t.sam.userId, 'instagram', '2027-06-04T08:00:00.000Z');
    await contact(null, 'email', '2027-06-05T08:00:00.000Z');
    await contact(t.sam.userId, 'email', '2027-07-05T08:00:00.000Z'); // hors période
    await t.db.run("INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, replaces_id, created_at, updated_at) VALUES ('rdv-1', ?, ?, ?, NULL, 'estimation', '2027-06-02T08:00:00.000Z', '2027-06-02T09:00:00.000Z', 'honored', 'h1', 'agent', NULL, '2027-06-01T08:00:00.000Z', '2027-06-01T08:00:00.000Z')", [t.network.id, t.sam.userId, p1]);
    for (const [channel, cents, at] of [['email', 12, '2027-06-02T08:00:00.000Z'], ['email', 30, '2027-06-03T08:00:00.000Z'], ['instagram', 5, '2027-06-04T08:00:00.000Z'], ['email', 99, '2027-07-04T08:00:00.000Z']] as const) {
      await t.store.recordMessage({ networkId: t.network.id, agentId: t.alexId, personId: p1, channel, direction: 'out', authorKind: 'ai', body: 'Bonjour', costCents: cents, occurredAt: new Date(at) });
    }
    return { ...t, tableau: new TableauReseau(t.db, t.journal, { now: t.now }) };
  }

  it('[R69] chaque total est la somme de chaque découpage : par agent, par zone, par source ; coûts de l’IA par canal et par mandat', async () => {
    const t = await world();
    const june = await t.tableau.of(t.direction, { from: '2027-06-01', to: '2027-06-30' });
    if (!june.ok) throw new Error(june.code);
    const d = june.value;
    expect(d.totals).toEqual({ contacts: 4, appointments: 1, mandates: 0, sales: 1 });
    for (const k of ['contacts', 'appointments', 'mandates', 'sales'] as const) {
      expect([k, d.byAgent.reduce((a, r) => a + r[k], 0)]).toEqual([k, d.totals[k]]);
      expect([k, d.byZone.reduce((a, r) => a + r[k], 0)]).toEqual([k, d.totals[k]]);
    }
    expect(d.bySource.contacts.reduce((a, r) => a + r.count, 0)).toBe(d.totals.contacts);
    expect(d.bySource.contacts).toEqual([{ channel: 'autre', count: 1 }, { channel: 'email', count: 2 }, { channel: 'instagram', count: 1 }]);
    expect(d.byAgent.find((r) => r.agentId === null)).toMatchObject({ contacts: 1 });
    expect(d.byZone.find((r) => r.zone === 'Dijon centre')).toMatchObject({ contacts: 2, sales: 1 });
    expect(d.aiCosts).toEqual({ totalCents: 47, byChannel: [{ channel: 'email', cents: 42 }, { channel: 'instagram', cents: 5 }], perSignedMandateCents: null });
    const feb = await t.tableau.of(t.direction, { from: '2027-02-01', to: '2027-02-28' });
    expect(feb.ok && feb.value.totals.mandates).toBe(1);
    expect(feb.ok && feb.value.bySource.mandates).toEqual([{ source: 'referral', count: 1 }]);
  });

  it('[R16, R14] la direction seule ; ni l’agent ni la conformité ; aucun rang, aucune note', async () => {
    const t = await world();
    expect(await t.tableau.of(t.agent, { from: '2027-06-01', to: '2027-06-30' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.tableau.of({ role: 'compliance', networkId: t.network.id, userId: 'c-1' }, { from: '2027-06-01', to: '2027-06-30' })).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.data.kind === 'network_dashboard')).toHaveLength(2);
    const d = await t.tableau.of(t.direction, { from: '2027-06-01', to: '2027-06-30' });
    expect(JSON.stringify(d)).not.toMatch(/rank|rang|score|note/i);
    expect(await t.tableau.of(t.direction, { from: '2027-06-30', to: '2027-06-01' })).toMatchObject({ code: 'bad_period' });
  });
});
