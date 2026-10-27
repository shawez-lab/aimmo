import { expect, it } from 'vitest';
import {
  Acces,
  ControlesSignature,
  Diffusion,
  FicheClient,
  FicheUnique,
  Modeles,
  RegistreMandats,
  SignaturePapier,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  withdrawalLastDay,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Modèle, registre et personnes inventés. Février 2027 : Paris est à UTC+1.
const BODY = 'Mandat de test : {{mandant.nom}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}}.';
const SIGNED = new Date('2027-02-10T09:00:00.000Z'); // mercredi 10 février, 10 h à Paris
const paris = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+01:00`);

async function setup(duration: number | null = 12) {
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
  // Un modèle sans champ de durée, pour le cas d'un mandat dont la durée n'est pas connue.
  const v = await modeles.createVersion(direction, 'mandat_vente_simple', duration === null ? BODY.replace(', {{mandat.duree_mois}}', '') : BODY);
  await modeles.validate(as('compliance', 'c-1'), v.ok ? v.template.id : '');
  await controles.setFeeSchedule(direction, { maxRatePercent: 5, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const diffusion = new Diffusion(db, acces, journal, { now });
  let n = 0;
  const signed = async (place: 'agence' | 'hors_agence' | 'distance') => {
    n += 1;
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: `Exemple${n}` });
    const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `REF-T-${n}`, kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 200000 });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
    await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
    await controles.recordIdentity(agent, p.id, { piece: 'carte_identite', seenAt: SIGNED });
    const inputs = { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', ...(duration === null ? {} : { 'mandat.duree_mois': duration }) } as const;
    const d = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: p.id, propertyId: b.id, inputs: inputs as never });
    if (!d.ok) throw new Error(d.code);
    const r = await new SignaturePapier(db, acces, journal, { now }).register(agent, d.document.id, { signedAt: SIGNED, place, scanRef: `scans/test-${n}.pdf`, source: 'referral' });
    if (!r.ok) throw new Error(r.code);
    return { propertyId: b.id, mandateId: r.value.mandateId };
  };
  const setClock = (d: Date) => {
    clock = d;
  };
  return { db, journal, store, diffusion, network, agent, direction, as, sam, signed, setClock };
}

describeWithSqlite('D05 · rétractation et diffusion bloquée', () => {
  it('délai de 14 jours à l’heure de Paris, prolongé au jour ouvrable suivant un samedi, un dimanche ou un férié', () => {
    expect(withdrawalLastDay(SIGNED, 'agence')).toBeNull();
    expect(withdrawalLastDay(SIGNED, 'hors_agence')).toBe('2027-02-24');
    expect(withdrawalLastDay(SIGNED, 'distance')).toBe('2027-02-24');
    // Signé un samedi : le 14e jour est un samedi, prolongé au lundi.
    expect(withdrawalLastDay(paris('2027-02-13', '11:00'), 'hors_agence')).toBe('2027-03-01');
    // Le 14e jour est le samedi 8 mai, férié : prolongé au lundi 10 mai.
    expect(withdrawalLastDay(paris('2027-04-24', '11:00'), 'hors_agence')).toBe('2027-05-10');
    // C'est le jour de Paris qui compte : 23 h 30 le 10 en temps universel, c'est déjà le 11 à Paris.
    expect(withdrawalLastDay(new Date('2027-02-10T23:30:00.000Z'), 'hors_agence')).toBe('2027-02-25');
    expect(withdrawalLastDay(new Date('2027-02-10T22:30:00.000Z'), 'hors_agence')).toBe('2027-02-24');
  });

  it('[R42] aucune diffusion sans mandat signé et numéroté ; diffusion refusée pendant le délai, permise le lendemain de sa fin', async () => {
    const t = await setup();
    const bare = await t.store.createProperty({ networkId: t.network.id, agentId: null as never, reference: 'REF-SANS', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 1, rooms: 1, priceEur: 1 });
    expect(await t.diffusion.canDiffuse(t.network.id, bare.id)).toMatchObject({ allowed: false, reason: 'no_mandate' });
    const away = await t.signed('hors_agence');
    expect(await t.diffusion.canDiffuse(t.network.id, away.propertyId, paris('2027-02-24', '23:59'))).toMatchObject({ allowed: false, reason: 'withdrawal_period', withdrawalLastDay: '2027-02-24' });
    expect(await t.diffusion.canDiffuse(t.network.id, away.propertyId, paris('2027-02-25', '00:01'))).toMatchObject({ allowed: true, reason: 'allowed' });
    const office = await t.signed('agence');
    expect(await t.diffusion.canDiffuse(t.network.id, office.propertyId, paris('2027-02-10', '11:00'))).toMatchObject({ allowed: true, reason: 'allowed' });
    // Après la durée du mandat (12 mois), plus de diffusion.
    expect(await t.diffusion.canDiffuse(t.network.id, office.propertyId, new Date('2028-02-10T09:00:00.000Z'))).toMatchObject({ allowed: false, reason: 'expired' });
  });

  it('[R42] la demande écrite du vendeur permet la diffusion plus tôt ; une rétractation l’arrête et annule l’inscription', async () => {
    const t = await setup();
    const a = await t.signed('distance');
    t.setClock(paris('2027-02-12', '10:00'));
    expect(await t.diffusion.recordEarlyStart(t.agent, a.mandateId, { proof: 'mail du vendeur du 12/02 (test)', receivedAt: paris('2027-02-12', '09:00') })).toEqual({ ok: true });
    expect(await t.diffusion.canDiffuse(t.network.id, a.propertyId, paris('2027-02-12', '10:00'))).toMatchObject({ allowed: true, reason: 'allowed_early_start' });
    expect(await t.diffusion.recordWithdrawal(t.agent, a.mandateId, { proof: 'formulaire de rétractation reçu (test)', receivedAt: paris('2027-02-12', '09:30') })).toEqual({ ok: true });
    expect(await t.diffusion.canDiffuse(t.network.id, a.propertyId, paris('2027-03-01', '10:00'))).toMatchObject({ allowed: false, reason: 'withdrawn' });
    const cancel = await t.db.first<{ reason: string }>(`SELECT reason FROM mandate_register WHERE mandate_id = ? AND kind = 'annulation'`, [a.mandateId]);
    expect(cancel?.reason).toBe('withdrawal');
    expect(await t.diffusion.recordWithdrawal(t.agent, a.mandateId, { proof: 'x', receivedAt: paris('2027-02-12', '09:30') })).toEqual({ ok: false, rule: null, code: 'already_recorded' });
  });

  it('[R42] une rétractation après le délai, ou pour un mandat signé à l’agence, est refusée ; un mandat sans durée ne se diffuse pas', async () => {
    const t = await setup();
    const a = await t.signed('hors_agence');
    t.setClock(paris('2027-03-01', '10:00'));
    expect(await t.diffusion.recordWithdrawal(t.agent, a.mandateId, { proof: 'x', receivedAt: paris('2027-02-25', '09:00') })).toEqual({ ok: false, rule: 'R42', code: 'delay_over' });
    const office = await t.signed('agence');
    expect(await t.diffusion.recordWithdrawal(t.agent, office.mandateId, { proof: 'x', receivedAt: paris('2027-02-11', '09:00') })).toEqual({ ok: false, rule: 'R42', code: 'no_withdrawal_period' });
    expect(await t.diffusion.recordEarlyStart(t.agent, office.mandateId, { proof: 'x', receivedAt: paris('2027-02-11', '09:00') })).toEqual({ ok: false, rule: 'R42', code: 'no_withdrawal_period' });
    const u = await setup(null);
    const b = await u.signed('agence');
    expect(await u.diffusion.canDiffuse(u.network.id, b.propertyId, paris('2027-02-11', '10:00'))).toMatchObject({ allowed: false, reason: 'duration_unknown' });
  });

  it('[R16] seuls l’agent de la fiche et la direction enregistrent ; la décision se lit sous les droits du bien ; rien ne s’efface', async () => {
    const t = await setup();
    const a = await t.signed('hors_agence');
    t.setClock(paris('2027-02-12', '10:00'));
    const proof = { proof: 'x', receivedAt: paris('2027-02-12', '09:00') };
    expect(await t.diffusion.recordWithdrawal(t.as('agent', t.sam.id), a.mandateId, proof)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.diffusion.recordEarlyStart(t.as('compliance', 'c-1'), a.mandateId, proof)).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.diffusion.read(t.agent, a.propertyId)).ok).toBe(true);
    expect(await t.diffusion.read(t.as('agent', t.sam.id), a.propertyId)).toMatchObject({ ok: false, rule: 'R16' });
    await t.diffusion.recordEarlyStart(t.direction, a.mandateId, proof);
    await expect(t.db.run('DELETE FROM mandate_early_starts')).rejects.toThrow(/gardée/);
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Léa|Exemple/);
  });
});
