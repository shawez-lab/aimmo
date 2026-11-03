import { expect, it } from 'vitest';
import {
  Acces,
  ControlesSignature,
  Diffusion,
  FicheClient,
  FicheUnique,
  Modeles,
  MisesEnVente,
  ON_SALE_JOB,
  RegistreMandats,
  SignaturePapier,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  onSaleDatesJob,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { DEFAULT_SEND_SETTINGS } from '../src/envoi/decision.ts';
import { afterSendingTime } from '../src/envoi/horaires.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';

// Modèle, registre et personnes inventés. Février 2027 : Paris est à UTC+1.
const BODY = 'Mandat de test : {{mandant.nom}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}}.';
const SIGNED = new Date('2027-02-10T09:00:00.000Z'); // mercredi 10 février, 10 h à Paris
const HOUR = 3_600_000;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = new Date('2027-02-10T10:00:00.000Z');
  const now = () => clock;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const agent = as('agent', alex.id);
  const direction = as('direction', 'direction-1');
  const v = await modeles.createVersion(direction, 'mandat_vente_simple', BODY);
  await modeles.validate(as('compliance', 'c-1'), v.ok ? v.template.id : '');
  await new ControlesSignature(db, acces, journal, { now }).setFeeSchedule(direction, { maxRatePercent: 5, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const diffusion = new Diffusion(db, acces, journal, { now });
  let n = 0;
  const signed = async (place: 'agence' | 'hors_agence') => {
    n += 1;
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: `Exemple${n}` });
    const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `REF-T-${n}`, kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 200000 });
    await db.run("UPDATE properties SET status = 'available' WHERE id = ?", [b.id]);
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
    await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
    await identiteAuCoffre({ db, acces, journal, now }, agent, p.id, { piece: 'carte_identite', seenAt: SIGNED });
    const d = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } as never });
    if (!d.ok) throw new Error(d.code);
    const r = await new SignaturePapier(db, acces, journal, { now }).register(agent, d.document.id, { signedAt: SIGNED, place, scanRef: `scans/test-${n}.pdf`, source: 'referral' });
    if (!r.ok) throw new Error(r.code);
    return { propertyId: b.id, mandateId: r.value.mandateId };
  };
  const dates = () => new MisesEnVente(db, journal, { now });
  const row = (propertyId: string) => db.first<{ on_sale_at: string; mandate_id: string; noted_at: string }>('SELECT on_sale_at, mandate_id, noted_at FROM property_on_sale WHERE property_id = ?', [propertyId]);
  return { db, journal, diffusion, agent, signed, dates, row, now, setClock: (iso: string) => { clock = new Date(iso); } };
}

describeWithSqlite('IN11 · la date de mise en vente', () => {
  it('[R222] mandat signé à l’agence : la date est l’inscription au registre, pas le passage qui la voit', async () => {
    const t = await setup();
    const { propertyId, mandateId } = await t.signed('agence'); // enregistré à 10:00:00 UTC
    t.setClock('2027-02-12T15:00:00.000Z');
    expect(await t.dates().run()).toBe(1);
    expect(await t.row(propertyId)).toEqual({ on_sale_at: '2027-02-10T10:00:00.000Z', mandate_id: mandateId, noted_at: '2027-02-12T15:00:00.000Z' });
  });

  it('[R222] [R42] signé hors de l’agence : rien pendant le délai, puis minuit à Paris le lendemain de sa fin', async () => {
    const t = await setup();
    const { propertyId } = await t.signed('hors_agence'); // dernier jour : le 24 février
    t.setClock('2027-02-24T22:59:00.000Z');
    expect(await t.dates().run()).toBe(0);
    expect(await t.row(propertyId)).toBeNull();
    t.setClock('2027-02-25T07:00:00.000Z');
    expect(await t.dates().run()).toBe(1);
    expect((await t.row(propertyId))?.on_sale_at).toBe('2027-02-24T23:00:00.000Z');
  });

  it('[R222] la demande écrite du vendeur : la date est le moment où AIMMO l’a notée', async () => {
    const t = await setup();
    const { propertyId, mandateId } = await t.signed('hors_agence');
    t.setClock('2027-02-12T09:30:00.000Z');
    const early = await t.diffusion.recordEarlyStart(t.agent, mandateId, { proof: 'courrier reçu', receivedOn: '2027-02-11' });
    expect(early.ok).toBe(true);
    t.setClock('2027-03-01T09:00:00.000Z');
    await t.dates().run();
    expect((await t.row(propertyId))?.on_sale_at).toBe('2027-02-12T09:30:00.000Z');
  });

  it('[R222] rangée une seule fois : un second passage ne la déplace pas, et la base refuse de la réécrire', async () => {
    const t = await setup();
    const { propertyId } = await t.signed('agence');
    await t.dates().run();
    const first = await t.row(propertyId);
    t.setClock('2027-03-01T09:00:00.000Z');
    expect(await t.dates().run()).toBe(0);
    expect(await t.row(propertyId)).toEqual(first);
    await expect(t.db.run("UPDATE property_on_sale SET on_sale_at = 'x' WHERE property_id = ?", [propertyId])).rejects.toThrow();
    await expect(t.db.run('DELETE FROM property_on_sale WHERE property_id = ?', [propertyId])).rejects.toThrow();
  });

  it('[R222] seul un bien en vente est daté ; le journal ne porte aucune donnée de personne', async () => {
    const t = await setup();
    const { propertyId } = await t.signed('agence');
    const other = await t.signed('agence');
    await t.db.run("UPDATE properties SET status = 'draft' WHERE id = ?", [other.propertyId]);
    await t.dates().run();
    expect(await t.row(other.propertyId)).toBeNull();
    const ev = await t.db.all<{ data: string; subject: string }>("SELECT data, subject FROM journal WHERE type = 'bien.mise_en_vente'");
    expect(ev).toEqual([{ data: JSON.stringify({ rule: 'R222' }), subject: `property:${propertyId}` }]);
  });

  it('[R222] le passage n’envoie rien : aucun message, aucune alerte, et il garde sa place de tâche à part', async () => {
    const t = await setup();
    await t.signed('agence');
    const job = onSaleDatesJob(t.db, t.journal, { now: t.now });
    expect(job.name).toBe(ON_SALE_JOB);
    await job.run({ job: job.name, slot: 'x', at: t.now() });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM property_on_sale')).toEqual({ n: 1 });
    expect(await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'")).toEqual({ n: 0 });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM property_alerts')).toEqual({ n: 0 });
  });
});

it('[R01] une heure de temps d’envoi : à la seconde, la nuit, le dimanche, le soir, et au changement d’heure', () => {
  const after = (iso: string) => afterSendingTime(new Date(iso), HOUR, DEFAULT_SEND_SETTINGS).toISOString();
  // Juin : Paris à UTC+2. Le 10 est un jeudi.
  expect(after('2027-06-10T10:00:17.000Z')).toBe('2027-06-10T11:00:17.000Z');
  expect(after('2027-06-10T00:30:00.000Z')).toBe('2027-06-10T07:00:00.000Z'); // la nuit : de 8 h à 9 h
  expect(after('2027-06-10T05:59:59.000Z')).toBe('2027-06-10T07:00:00.000Z'); // 7 h 59 min 59 s
  expect(after('2027-06-10T06:00:00.000Z')).toBe('2027-06-10T07:00:00.000Z'); // 8 h pile
  expect(after('2027-06-10T17:30:30.000Z')).toBe('2027-06-11T06:30:30.000Z'); // 19 h 30 min 30 s : le reste au matin
  expect(after('2027-06-10T18:00:00.000Z')).toBe('2027-06-11T07:00:00.000Z'); // 20 h pile : fermé
  expect(after('2027-06-12T17:30:00.000Z')).toBe('2027-06-14T06:30:00.000Z'); // samedi soir : lundi matin
  expect(after('2027-06-13T09:00:00.000Z')).toBe('2027-06-14T07:00:00.000Z'); // dimanche
  // Le dimanche 28 mars 2027, Paris passe à l'heure d'été : lundi 8 h vaut 6 h en temps universel.
  expect(after('2027-03-27T23:30:00.000Z')).toBe('2027-03-29T07:00:00.000Z');
  // Le dimanche 31 octobre 2027, retour à l'heure d'hiver : lundi 8 h vaut 7 h en temps universel.
  expect(after('2027-10-30T22:30:00.000Z')).toBe('2027-11-01T08:00:00.000Z');
  // Au samedi d'avant : 19 h 30 d'été, le reste le lundi à l'heure d'hiver.
  expect(after('2027-10-30T17:30:00.000Z')).toBe('2027-11-01T07:30:00.000Z');
});
