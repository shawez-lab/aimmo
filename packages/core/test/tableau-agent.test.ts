import { expect, it } from 'vitest';
import { ActeVente, Echeancier } from '../src/dossiers/index.ts';
import { Commissions, TableauAgent, parisDayStart } from '../src/pilotage/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : agents, clients, rendez-vous, montants.
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

it('le premier instant d’un jour de Paris, hiver comme été', () => {
  expect(parisDayStart('2027-01-15').toISOString()).toBe('2027-01-14T23:00:00.000Z');
  expect(parisDayStart('2027-07-15').toISOString()).toBe('2027-07-14T22:00:00.000Z');
  expect(parisDayStart('2027-03-28').toISOString()).toBe('2027-03-27T23:00:00.000Z');
});

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



describeWithSqlite('K04 · tableau de bord de l’agent, chaque chiffre prouvé', () => {
  async function world() {
    const t = await setup();
    const c = t.commissions();
    await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 });
    await t.compromis();
    await c.sync(t.network.id);
    await t.acte();
    await c.sync(t.network.id);
    // Des contacts attribués et des rendez-vous, rangés comme le socle les range ; un seul de chaque autour des bornes.
    let n = 0;
    const attribution = async (agentId: string, at: string) => {
      n += 1;
      const p = await t.store.createPerson({ networkId: t.network.id, agentId, firstName: `Client${n}` });
      await t.db.run("INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at) VALUES (?, ?, ?, NULL, ?, 'zone', 24, NULL, ?)", [`att-${n}`, t.network.id, p.id, agentId, at]);
      return p.id;
    };
    const appointment = async (agentId: string, personId: string, at: string, status: string) => {
      n += 1;
      const end = new Date(Date.parse(at) + 3_600_000).toISOString();
      await t.db.run("INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, replaces_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 'estimation', ?, ?, ?, ?, 'agent', NULL, ?, ?)", [`rdv-${n}`, t.network.id, agentId, personId, at, end, status, `h${n}`, at, at]);
    };
    // Juin 2027, à Paris : du 31 mai 22 h à 30 juin 22 h, en temps universel.
    const p1 = await attribution(t.alexId, '2027-05-31T21:59:59.000Z'); // 31 mai, 23 h 59 : hors période
    const p2 = await attribution(t.alexId, '2027-05-31T22:00:00.000Z'); // 1er juin, minuit : dans la période
    await attribution(t.alexId, '2027-06-30T21:59:00.000Z'); // 30 juin, 23 h 59 : dans la période
    await attribution(t.sam.userId, '2027-06-10T10:00:00.000Z'); // un autre agent
    await appointment(t.alexId, p1, '2027-06-02T08:00:00.000Z', 'honored');
    await appointment(t.alexId, p2, '2027-06-03T08:00:00.000Z', 'absent');
    await appointment(t.alexId, p2, '2027-06-04T08:00:00.000Z', 'cancelled');
    await appointment(t.alexId, p2, '2027-07-01T08:00:00.000Z', 'honored');
    return { ...t, c, tableau: new TableauAgent(t.db, t.journal, { now: t.now }) };
  }

  it('[R69] chaque chiffre est égal au nombre ou à la somme des lignes qu’il montre ; les bornes sont des jours de Paris', async () => {
    const t = await world();
    const june = await t.tableau.of(t.agent, { from: '2027-06-01', to: '2027-06-30' });
    if (!june.ok) throw new Error(june.code);
    const d = june.value;
    expect(d.contacts.lines.map((l) => l.attributionId)).toEqual(['att-2', 'att-3']);
    expect(d.appointments.lines.map((l) => l.appointmentId)).toEqual(['rdv-5']);
    expect(d.sales.lines).toEqual([{ fileId: t.fileId, signedOn: '2027-06-10' }]);
    expect(d.mandates.lines).toEqual([]);
    expect(d.upcomingFees.lines).toEqual([{ fileId: t.fileId, status: 'due', amountCents: 700_000 }]);
    for (const k of ['contacts', 'appointments', 'mandates', 'sales'] as const) expect([k, d[k].value]).toEqual([k, d[k].lines.length]);
    expect(d.upcomingFees.value).toBe(d.upcomingFees.lines.reduce((a, l) => a + l.amountCents, 0));
    // Février : le mandat signé le 10.
    const feb = await t.tableau.of(t.agent, { from: '2027-02-01', to: '2027-02-28' });
    expect(feb.ok && feb.value.mandates.lines.map((l) => l.at)).toEqual(['2027-02-10T09:00:00.000Z']);
    // Une fois payée, la commission n'est plus à venir.
    await t.c.recordStep(t.network.id, t.fileId, 'facturee', 'factures/essai-1', 'direction:direction-1');
    await t.c.recordStep(t.network.id, t.fileId, 'payee', 'virements/essai-1', 'direction:direction-1');
    const after = await t.tableau.of(t.agent, { from: '2027-06-01', to: '2027-06-30' });
    expect(after.ok && after.value.upcomingFees).toEqual({ value: 0, lines: [] });
  });

  it('[R16, R68, R14] l’agent ne lit que son tableau, sans comparaison ; la direction lit celui d’un agent ; la conformité, rien', async () => {
    const t = await world();
    const sam = await t.tableau.of(t.sam, { from: '2027-06-01', to: '2027-06-30' });
    expect(sam.ok && sam.value).toMatchObject({ agentId: t.sam.userId, contacts: { value: 1 }, sales: { value: 0 }, upcomingFees: { value: 0 } });
    expect(Object.keys(sam.ok ? sam.value : {})).toEqual(['agentId', 'from', 'to', 'contacts', 'appointments', 'mandates', 'sales', 'upcomingFees']);
    const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    expect(await t.tableau.of(t.sam, { from: '2027-06-01', to: '2027-06-30', agentId: t.alexId })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.tableau.of({ role: 'compliance', networkId: t.network.id, userId: 'c-1' }, { from: '2027-06-01', to: '2027-06-30', agentId: t.alexId })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.tableau.of({ ...t.direction, networkId: 'autre' }, { from: '2027-06-01', to: '2027-06-30', agentId: t.alexId })).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length - before).toBe(3);
    const direction = await t.tableau.of(t.direction, { from: '2027-06-01', to: '2027-06-30', agentId: t.alexId });
    expect(direction.ok && direction.value.contacts.value).toBe(2);
    expect(await t.tableau.of(t.agent, { from: '2027-06-30', to: '2027-06-01' })).toMatchObject({ code: 'bad_period' });
    expect(await t.tableau.of(t.agent, { from: '2026-01-01', to: '2027-06-01' })).toMatchObject({ code: 'bad_period' });
    // Au journal : la lecture, jamais un chiffre [R13].
    const reads = (await t.journal.all()).filter((e) => e.type === 'pilotage.lecture');
    expect(JSON.stringify(reads)).not.toMatch(/700000/);
  });
});
