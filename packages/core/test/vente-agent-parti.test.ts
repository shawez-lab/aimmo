import { expect, it } from 'vitest';
import { ActeVente, Echeancier } from '../src/dossiers/index.ts';
import { saleAgentAt } from '../src/dossiers/acte.ts';
import { Commissions, TableauAgent } from '../src/pilotage/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// RC37 · La vente reste à l'agent du compromis, même parti avant l'acte. Tout est inventé.
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000037.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

async function setup() {
  const t = await setupDossier('appartement');
  const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
  const c = new Commissions(t.db, t.acces, t.journal, { now: t.now });
  await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 });
  await t.startCompromis();
  t.setClock(at9('2027-03-11'));
  for (const [kind, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['etat_date_attendu', '2027-05-20'], ['acte_prevu', '2027-06-10']] as const) {
    const r = await echeancier.record(t.agent, t.fileId, { kind, day, proofRef: PROOF });
    if (!r.ok) throw new Error(r.code);
  }
  const status = await t.pieces.status(t.agent, t.fileId);
  if (!status.ok) throw new Error(status.code);
  for (const piece of status.value.missing) {
    const r = await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-11' });
    if (!r.ok) throw new Error(r.code);
  }
  /** Le départ d'Alex, rangé comme J11 le range : le bien passe à `to` (NULL : la file de la direction). */
  let n = 0;
  const depart = async (agentId: string, leavesOn: string, to: string | null) => {
    n += 1;
    const id = `depart-${n}`;
    const at = `${leavesOn}T05:00:00.000Z`;
    await t.db.run(
      "INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at, processed_at) VALUES (?, ?, ?, '2027-01-02', ?, 'demission_agent', 3, 'direction:test', ?, ?)",
      [id, t.network.id, agentId, leavesOn, at, at],
    );
    await t.db.run('INSERT INTO agent_departure_handovers (departure_id, network_id, kind, subject_id, from_agent_id, to_agent_id, at) VALUES (?, ?, \'property\', ?, ?, ?, ?)', [id, t.network.id, t.propertyId, agentId, to, at]);
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [to, t.propertyId]);
    // Ses clients aussi, l'acquéreur compris (J11).
    await t.db.run('UPDATE persons SET agent_id = ? WHERE network_id = ? AND agent_id = ?', [to, t.network.id, agentId]);
  };
  const acte = (viewer = t.sam) => {
    t.setClock(at9('2027-06-11'));
    return new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }).record(viewer, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
  };
  const saleAgent = async () => (await t.db.first<{ agent_id: string }>('SELECT agent_id FROM sale_commissions WHERE file_id = ?', [t.fileId]))?.agent_id;
  const plannedAgent = async () => (await t.db.first<{ agent_id: string }>('SELECT agent_id FROM commissions WHERE file_id = ?', [t.fileId]))?.agent_id;
  return { ...t, c, depart, acte, saleAgent, plannedAgent, tableau: new TableauAgent(t.db, t.journal, { now: t.now }) };
}

describeWithSqlite('RC37 · la vente reste à l’agent du compromis, même parti avant l’acte', () => {
  it('[R69] commission prévue avant le départ : l’acte, la commission et le tableau disent l’agent parti, jamais son successeur', async () => {
    const t = await setup();
    await t.c.sync(t.network.id);
    expect(await t.plannedAgent()).toBe(t.alexId);
    await t.depart(t.alexId, '2027-04-01', t.sam.userId);
    const r = await t.acte();
    expect(r).toMatchObject({ ok: true });
    expect(await t.saleAgent()).toBe(t.alexId);
    const alex = await t.tableau.of(t.direction, { from: '2027-06-01', to: '2027-06-30', agentId: t.alexId });
    expect(alex.ok && alex.value.sales.lines).toEqual([{ fileId: t.fileId, signedOn: '2027-06-10' }]);
    const sam = await t.tableau.of(t.sam, { from: '2027-06-01', to: '2027-06-30' });
    expect(sam.ok && sam.value.sales).toEqual({ value: 0, lines: [] });
  });

  it('[R69] passage des commissions jamais fait avant le départ : la commission prévue va à l’agent du compromis, pas à la file ni au successeur', async () => {
    const t = await setup();
    await t.depart(t.alexId, '2027-04-01', null);
    await t.c.sync(t.network.id);
    expect(await t.plannedAgent()).toBe(t.alexId);
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [t.sam.userId, t.propertyId]);
    await t.db.run('UPDATE persons SET agent_id = ? WHERE network_id = ? AND agent_id IS NULL', [t.sam.userId, t.network.id]);
    expect((await t.acte()).ok).toBe(true);
    expect(await t.saleAgent()).toBe(t.alexId);
  });

  it('[R69] sans passage des commissions, l’acte lit seul l’agent du jour du compromis', async () => {
    const t = await setup();
    await t.depart(t.alexId, '2027-04-01', t.sam.userId);
    expect((await t.acte()).ok).toBe(true);
    expect(await t.saleAgent()).toBe(t.alexId);
  });

  it('un départ le jour même du compromis ou avant ne lui laisse pas la vente : c’est l’agent qui tient le bien', async () => {
    const t = await setup();
    await t.depart(t.alexId, '2027-03-10', t.sam.userId);
    expect((await t.acte()).ok).toBe(true);
    expect(await t.saleAgent()).toBe(t.sam.userId);
  });

  it('deux départs de suite : l’agent qui tenait le bien au compromis, celui d’avant et celui d’après mis à part', async () => {
    const t = await setup();
    // Alex part avant le compromis, Sam reprend le bien… puis le jeu inverse : Sam tient le compromis et part après.
    await t.depart(t.alexId, '2027-02-01', t.sam.userId);
    await t.depart(t.sam.userId, '2027-04-01', null);
    expect(await t.c.sync(t.network.id)).toMatchObject({ planned: 1 });
    expect(await t.plannedAgent()).toBe(t.sam.userId);
  });

  it('un bien encore dans la file de la direction au compromis : aucun agent, la commission attend son agent', async () => {
    const t = await setup();
    await t.depart(t.alexId, '2027-03-01', null);
    expect(await saleAgentAt(t.db, t.network.id, t.propertyId, '2027-03-10')).toBeNull();
    expect(await t.c.sync(t.network.id)).toMatchObject({ planned: 0 });
    expect(await t.plannedAgent()).toBeUndefined();
    // Avant le départ, le bien était à Alex ; un autre réseau ne lit rien.
    expect(await saleAgentAt(t.db, t.network.id, t.propertyId, '2027-02-27')).toBe(t.alexId);
    expect(await saleAgentAt(t.db, 'autre-reseau', t.propertyId, '2027-02-27')).toBeNull();
  });

  it('sans aucun départ, rien ne change : la vente est à l’agent du bien', async () => {
    const t = await setup();
    await t.c.sync(t.network.id);
    expect((await t.acte(t.agent)).ok).toBe(true);
    expect(await t.saleAgent()).toBe(t.alexId);
    expect(await t.plannedAgent()).toBe(t.alexId);
  });
});
