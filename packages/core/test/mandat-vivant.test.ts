import { expect, it } from 'vitest';
import { Acces, ControlesSignature, Diffusion, FicheClient, FicheUnique, Modeles, RegistreMandats, SignaturePapier, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { designerTout } from './designation-jeu.ts';

// Modèles, registre et personnes inventés.
const BODY = 'Mandat de test : {{mandant.nom}}, {{bien.prix}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.';
const SIGNED = new Date('2027-02-10T09:00:00.000Z');

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
  if (!v.ok) throw new Error(v.code);
  await modeles.validate(as('compliance', 'c-1'), v.template.id);
  await new ControlesSignature(db, acces, journal, { now }).setFeeSchedule(direction, { maxRatePercent: 5, minEur: 0 });
  const registre = new RegistreMandats(db, journal, { now });
  await registre.configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-V-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 200000 });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
  await identiteAuCoffre({ db, acces, journal, now }, agent, p.id, { piece: 'carte_identite', seenAt: SIGNED });
  const prepare = async () => {
    await designerTout(db);
    const d = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 3 } });
    if (!d.ok) throw new Error(d.code);
    return d.document.id;
  };
  const papier = new SignaturePapier(db, acces, journal, { now });
  let n = 0;
  const sign = (id: string, input: { signedAt?: Date; place?: 'agence' | 'distance'; source?: string | null } = {}) =>
    papier.register(agent, id, { signedAt: input.signedAt ?? SIGNED, place: input.place ?? 'agence', scanRef: `scans/mandat-${++n}.pdf`, source: input.source === undefined ? 'referral' : input.source });
  const lines = async () => (await db.first<{ n: number }>('SELECT count(*) AS n FROM mandate_register'))!.n;
  return { db, acces, journal, now, agent, direction, registre, prepare, sign, lines, propertyId: b.id, networkId: network.id, tick: (d: Date) => (clock = d) };
}

const mandateOf = (r: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['sign']>>) => {
  if (!r.ok) throw new Error(r.code);
  return r.value.mandateId;
};

describeWithSqlite('D15 · un seul mandat vivant par bien', () => {
  it('[R39] un second mandat sur un bien au mandat vivant est refusé, sans numéro ni réservation', async () => {
    const t = await setup();
    const [a, b] = [await t.prepare(), await t.prepare()];
    mandateOf(await t.sign(a));
    const before = await t.lines();
    expect(await t.sign(b)).toEqual({ ok: false, rule: 'R39', code: 'mandate_in_force' });
    expect(await t.lines()).toBe(before);
    expect(await t.db.first('SELECT document_id FROM signed_documents WHERE document_id = ?', [b])).toBeNull();
  });

  it('[R39] un enregistrement arrêté avant son numéro ne se finit pas si un autre mandat est devenu vivant', async () => {
    const t = await setup();
    const [a, b] = [await t.prepare(), await t.prepare()];
    expect((await t.sign(a, { source: null })).ok).toBe(false);
    mandateOf(await t.sign(b));
    const before = await t.lines();
    expect(await t.sign(a)).toEqual({ ok: false, rule: 'R39', code: 'mandate_in_force' });
    expect(await t.lines()).toBe(before);
  });

  it('une reprise, seule sur son bien, n’est pas refusée', async () => {
    const t = await setup();
    const a = await t.prepare();
    expect((await t.sign(a, { source: null })).ok).toBe(false);
    expect(await t.sign(a)).toMatchObject({ ok: true, value: { number: 'T-001' } });
  });

  it('[R39] un document qui a déjà son numéro finit son enregistrement', async () => {
    const t = await setup();
    const a = await t.prepare();
    // Une coupure juste après le numéro, avant l'exemplaire.
    const cut: SqlDatabase = {
      ...t.db,
      run: (sql, params) => (sql.startsWith('UPDATE signed_documents SET copy_content') ? Promise.reject(new Error('coupure')) : t.db.run(sql, params)),
    };
    const paper = { signedAt: SIGNED, place: 'agence' as const, scanRef: 'scans/coupe.pdf', source: 'referral' };
    await expect(new SignaturePapier(cut, t.acces, t.journal, { now: t.now }).register(t.agent, a, paper)).rejects.toThrow('coupure');
    expect(await t.db.first('SELECT number, copy_content FROM signed_documents WHERE document_id = ?', [a])).toEqual({ number: 'T-001', copy_content: null });
    expect(await t.sign(a)).toMatchObject({ ok: true, value: { number: 'T-001' } });
  });

  it('[R39] un mandat inscrit, coupé avant son exemplaire, garde le bien ; il finit ensuite, seul mandat vivant', async () => {
    const t = await setup();
    const [a, b] = [await t.prepare(), await t.prepare()];
    const cut: SqlDatabase = { ...t.db, run: (sql, params) => (sql.startsWith('UPDATE signed_documents SET copy_content') ? Promise.reject(new Error('coupure')) : t.db.run(sql, params)) };
    await expect(new SignaturePapier(cut, t.acces, t.journal, { now: t.now }).register(t.agent, a, { signedAt: SIGNED, place: 'agence', scanRef: 'scans/coupe.pdf', source: 'referral' })).rejects.toThrow('coupure');
    expect(await t.sign(b)).toEqual({ ok: false, rule: 'R39', code: 'mandate_in_force' });
    expect(await t.sign(a)).toMatchObject({ ok: true, value: { number: 'T-001' } });
  });

  it('[R39] coupé entre l’inscription et la recopie du numéro : le bien reste gardé, et ce document finit', async () => {
    const t = await setup();
    const [a, b] = [await t.prepare(), await t.prepare()];
    const cut: SqlDatabase = { ...t.db, run: (sql, params) => (sql.startsWith('UPDATE signed_documents SET number') ? Promise.reject(new Error('coupure')) : t.db.run(sql, params)) };
    await expect(new SignaturePapier(cut, t.acces, t.journal, { now: t.now }).register(t.agent, a, { signedAt: SIGNED, place: 'agence', scanRef: 'scans/coupe.pdf', source: 'referral' })).rejects.toThrow('coupure');
    expect(await t.sign(b)).toEqual({ ok: false, rule: 'R39', code: 'mandate_in_force' });
    expect(await t.sign(a)).toMatchObject({ ok: true, value: { number: 'T-001' } });
  });

  it('[R39] un mandat annulé plus récent ne masque pas un mandat plus ancien encore en délai de rétractation', async () => {
    const t = await setup();
    const [a, b, c] = [await t.prepare(), await t.prepare(), await t.prepare()];
    const first = mandateOf(await t.sign(a, { signedAt: new Date('2027-02-10T09:30:00.000Z') }));
    expect((await t.registre.cancel(t.direction, first, 'error')).ok).toBe(true);
    mandateOf(await t.sign(b, { signedAt: new Date('2027-02-10T09:00:00.000Z'), place: 'distance' }));
    expect(await t.sign(c)).toEqual({ ok: false, rule: 'R39', code: 'mandate_in_force' });
  });

  it('un mandat annulé au registre rouvre le bien', async () => {
    const t = await setup();
    const [a, b] = [await t.prepare(), await t.prepare()];
    const id = mandateOf(await t.sign(a));
    expect((await t.registre.cancel(t.direction, id, 'error')).ok).toBe(true);
    expect(await t.sign(b)).toMatchObject({ ok: true, value: { number: 'T-002' } });
  });

  it('un mandat rétracté rouvre le bien', async () => {
    const t = await setup();
    const [a, b] = [await t.prepare(), await t.prepare()];
    const id = mandateOf(await t.sign(a, { place: 'distance' }));
    t.tick(new Date('2027-02-12T10:00:00.000Z'));
    const r = await new Diffusion(t.db, t.acces, t.journal, { now: t.now }).recordWithdrawal(t.agent, id, { proof: 'scans/retractation.pdf', receivedAt: new Date('2027-02-12T09:00:00.000Z') });
    expect(r.ok).toBe(true);
    expect((await t.sign(b, { signedAt: new Date('2027-02-12T09:30:00.000Z') })).ok).toBe(true);
  });

  it('un mandat échu rouvre le bien', async () => {
    const t = await setup();
    const [a, b] = [await t.prepare(), await t.prepare()];
    mandateOf(await t.sign(a));
    t.tick(new Date('2027-06-20T10:00:00.000Z'));
    expect((await t.sign(b, { signedAt: new Date('2027-06-20T09:00:00.000Z') })).ok).toBe(true);
  });
});
