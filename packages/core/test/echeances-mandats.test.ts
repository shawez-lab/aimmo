import { expect, it } from 'vitest';
import {
  Acces,
  ControlesSignature,
  Diffusion,
  EcheancesMandats,
  FicheClient,
  FicheUnique,
  Modeles,
  RegistreMandats,
  SignaturePapier,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';

// Modèle, registre et personnes inventés.
const BODY = 'Mandat de test : {{mandant.nom}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\n!! Clause de test.\n\nNuméro : {{registre.numero}}.';
const SIGNED = new Date('2027-02-10T09:00:00.000Z');
// Heure de Paris : UTC+2 d'avril à octobre, UTC+1 sinon (dates de test hors des jours de changement).
const paris = (date: string, hhmm = '06:00') => new Date(`${date}T${hhmm}:00${date.slice(5, 7) >= '04' && date.slice(5, 7) <= '10' ? '+02:00' : '+01:00'}`);

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = new Date('2027-02-10T10:00:00.000Z');
  const now = () => clock;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const controles = new ControlesSignature(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const agent = as('agent', alex.id);
  const direction = as('direction', 'direction-1');
  for (const kind of ['mandat_vente_exclusif', 'mandat_vente_simple'] as const) {
    const v = await modeles.createVersion(direction, kind, BODY);
    await modeles.validate(as('compliance', 'c-1'), v.ok ? v.template.id : '');
  }
  await controles.setFeeSchedule(direction, { maxRatePercent: 5, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  let n = 0;
  const signed = async (kind: 'mandat_vente_exclusif' | 'mandat_vente_simple', place: 'agence' | 'hors_agence' = 'agence', months = 12) => {
    n += 1;
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: `Exemple${n}` });
    const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `REF-T-${n}`, kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 200000 });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
    await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
    await identiteAuCoffre({ db, acces, journal, now }, agent, p.id, { piece: 'carte_identite', seenAt: SIGNED });
    const d = await modeles.generate(agent, { kind, personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': months } });
    if (!d.ok) throw new Error(d.code);
    const r = await new SignaturePapier(db, acces, journal, { now }).register(agent, d.document.id, { signedAt: SIGNED, place, scanRef: `scans/test-${n}.pdf`, source: 'referral' });
    if (!r.ok) throw new Error(r.code);
    return r.value.mandateId;
  };
  const echeances = new EcheancesMandats(db, journal, { now });
  const at = (d: Date) => {
    clock = d;
  };
  return { db, journal, acces, network, registre: new RegistreMandats(db, journal, { now }), agent, direction, as, sam, signed, echeances, at };
}

describeWithSqlite('D06 · échéances des mandats', () => {
  it('[R18] une seule tâche par échéance, rangée à temps, à l’heure de Paris ; aucun envoi', async () => {
    const t = await setup();
    const exclusive = await t.signed('mandat_vente_exclusif');
    await t.signed('mandat_vente_simple');
    // Période exclusive : fin le 10 mai 2027, tâche 15 jours avant, le 25 avril.
    t.at(paris('2027-04-24', '23:59'));
    expect(await t.echeances.run()).toBe(0);
    t.at(paris('2027-04-25', '00:01'));
    expect(await t.echeances.run()).toBe(1);
    expect(await t.echeances.run()).toBe(0);
    expect(await Promise.all([t.echeances.run(), t.echeances.run()])).toEqual([0, 0]);
    t.at(paris('2027-05-11'));
    expect(await t.echeances.run()).toBe(0);
    // Fin des mandats : 10 février 2028, tâche 30 jours avant, le 11 janvier.
    t.at(paris('2028-01-10'));
    expect(await t.echeances.run()).toBe(0);
    t.at(paris('2028-01-11'));
    expect(await t.echeances.run()).toBe(2);
    const list = await t.echeances.list(t.agent);
    // Ouvertes d'abord, par jour d'échéance ; deux échéances du même jour, dans un ordre stable quelconque.
    expect(list.ok && list.tasks.map((k) => [k.kind, k.dueDay, k.mandateId === exclusive]).sort()).toEqual([
      ['fin_mandat', '2028-02-10', false],
      ['fin_mandat', '2028-02-10', true],
      ['fin_periode_exclusive', '2027-05-10', true],
    ]);
    expect(list.ok && list.tasks[0]!.kind).toBe('fin_periode_exclusive');
    expect(await t.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`)).toEqual({ n: 0 });
  });

  it('un mandat rétracté n’a plus d’échéance ; les tâches sont à l’agent seul [R16] ; le journal ne porte aucun nom', async () => {
    const t = await setup();
    const m = await t.signed('mandat_vente_exclusif', 'hors_agence');
    t.at(paris('2027-02-12', '10:00'));
    expect(await new Diffusion(t.db, t.acces, t.journal, { now: () => paris('2027-02-12', '10:00') }).recordWithdrawal(t.agent, m, { proof: 'test', receivedAt: paris('2027-02-12', '09:00') })).toEqual({ ok: true });
    t.at(paris('2027-04-25'));
    expect(await t.echeances.run()).toBe(0);
    await t.signed('mandat_vente_exclusif');
    expect(await t.echeances.run()).toBe(1);
    expect(await t.echeances.list(t.as('agent', t.sam.id))).toEqual({ ok: true, tasks: [] });
    expect(await t.echeances.list(t.direction)).toMatchObject({ ok: false, rule: 'R16' });
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Léa|Exemple/);
  });

  it('un mandat exclusif plus court que 3 mois n’a pas d’échéance de période ; un mandat annulé après sa tâche ne la montre plus', async () => {
    const t = await setup();
    await t.signed('mandat_vente_exclusif', 'agence', 1);
    t.at(paris('2027-04-25'));
    expect(await t.echeances.run()).toBe(0);
    const m = await t.signed('mandat_vente_exclusif');
    expect(await t.echeances.run()).toBe(1);
    expect(await t.registre.cancel(t.direction, m, 'termination')).toMatchObject({ ok: true });
    expect(await t.echeances.list(t.agent)).toEqual({ ok: true, tasks: [] });
    // La tâche reste gardée, seulement plus montrée.
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM mandate_tasks')).toEqual({ n: 1 });
  });
});
