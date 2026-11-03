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
  mandateEndDay,
  withdrawalLastDay,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { localTime } from '../src/envoi/horaires.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';

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
    await identiteAuCoffre({ db, acces, journal, now }, agent, p.id, { piece: 'carte_identite', seenAt: SIGNED });
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

  it('[R42] la fin du mandat se compte en jours de Paris, ramenée au dernier jour du mois', () => {
    expect(mandateEndDay(paris('2027-01-31', '10:00'), 1)).toBe('2027-02-28');
    expect(mandateEndDay(paris('2027-02-01', '00:30'), 1)).toBe('2027-03-01');
    expect(mandateEndDay(paris('2027-11-30', '10:00'), 3)).toBe('2028-02-29');
    expect(mandateEndDay(paris('2027-02-10', '10:00'), 12)).toBe('2028-02-10');
  });

  it('[R42, R16] une rétractation n’écrit rien si le registre ne peut pas l’annuler ; une reprise fait l’annulation manquante', async () => {
    const t = await setup();
    const a = await t.signed('hors_agence');
    t.setClock(paris('2027-02-12', '10:00'));
    const proof = { proof: 'formulaire reçu (test)', receivedAt: paris('2027-02-12', '09:00') };
    // La fiche passe à Sam : il la voit, mais il n'est pas l'agent du mandat ; refusé, rien d'écrit.
    await t.db.run('UPDATE persons SET agent_id = ?', [t.sam.id]);
    expect(await t.diffusion.recordWithdrawal(t.as('agent', t.sam.id), a.mandateId, proof)).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM mandate_withdrawals')).toEqual({ n: 0 });
    // L'annulation au registre est coupée : la rétractation est rangée ; la reprise fait l'annulation et réussit.
    let cut = true;
    const flaky: SqlDatabase = {
      ...t.db,
      run: async (sql, params) => {
        if (cut && sql.includes('INSERT INTO mandate_register')) throw new Error('coupure');
        return t.db.run(sql, params);
      },
    };
    const { Acces: AccesClass, FicheClient: Fc, FicheUnique: Fu } = await import('../src/index.ts');
    const store = new Fc(flaky);
    const acces = new AccesClass(flaky, store, new Fu(flaky, store), t.journal, { now: () => paris('2027-02-12', '10:00') });
    await expect(new Diffusion(flaky, acces, t.journal, { now: () => paris('2027-02-12', '10:00') }).recordWithdrawal(t.direction, a.mandateId, proof)).rejects.toThrow(/coupure/);
    cut = false;
    expect(await t.diffusion.recordWithdrawal(t.direction, a.mandateId, proof)).toEqual({ ok: true });
    expect(await t.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM mandate_register WHERE kind = 'annulation'`)).toEqual({ n: 1 });
    expect(await t.diffusion.recordWithdrawal(t.direction, a.mandateId, proof)).toEqual({ ok: false, rule: null, code: 'already_recorded' });
  });

  it('[R42] D16 : envoyée le dernier jour et reçue après, la rétractation tient ; le jour compte à Paris, l’heure du téléphone ne compte pas', async () => {
    const t = await setup();
    const a = await t.signed('hors_agence');
    t.setClock(paris('2027-02-26', '10:00'));
    expect(await t.diffusion.recordWithdrawal(t.agent, a.mandateId, { proof: 'x', sentOn: '2027-02-25' })).toEqual({ ok: false, rule: 'R42', code: 'delay_over' });
    expect(await t.diffusion.recordWithdrawal(t.agent, a.mandateId, { proof: 'x', sentOn: '2027-02-09' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.diffusion.recordWithdrawal(t.agent, a.mandateId, { proof: 'x', sentOn: '2027-02-27' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.diffusion.recordWithdrawal(t.agent, a.mandateId, { proof: 'lettre (test)', sentOn: '2027-02-24' })).toEqual({ ok: true });
    expect(await t.db.first('SELECT sent_on, received_at FROM mandate_withdrawals WHERE mandate_id = ?', [a.mandateId])).toEqual({ sent_on: '2027-02-24', received_at: paris('2027-02-26', '10:00').toISOString() });
    // Envoyée aujourd'hui, à 23 h 30 à Paris : le jour de Paris n'est pas celui du temps universel.
    const b = await t.signed('hors_agence');
    t.setClock(new Date('2027-02-12T22:30:00.000Z'));
    expect(await t.diffusion.recordWithdrawal(t.agent, b.mandateId, { proof: 'mail (test)', sentOn: '2027-02-12' })).toEqual({ ok: true });
  });

  it('[R42] D16 : une demande datée d’un jour reste ce jour-là à Paris, hiver comme été, et jamais avant la signature du même jour', async () => {
    const t = await setup();
    const winter = await t.signed('hors_agence');
    t.setClock(paris('2027-02-15', '10:00'));
    expect(await t.diffusion.recordEarlyStart(t.agent, winter.mandateId, { proof: 'mail (test)', receivedOn: '2027-02-12' })).toEqual({ ok: true });
    expect(await t.diffusion.canDiffuse(t.network.id, winter.propertyId, paris('2027-02-11', '23:00'))).toMatchObject({ reason: 'withdrawal_period' });
    expect(await t.diffusion.canDiffuse(t.network.id, winter.propertyId, paris('2027-02-12', '08:00'))).toMatchObject({ reason: 'allowed_early_start' });
    const bad = await t.signed('hors_agence');
    expect(await t.diffusion.recordEarlyStart(t.agent, bad.mandateId, { proof: 'x', receivedOn: '2027-02-16' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.diffusion.recordEarlyStart(t.agent, bad.mandateId, { proof: 'x', receivedOn: '2027-02-09' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.diffusion.recordEarlyStart(t.agent, bad.mandateId, { proof: 'x', receivedOn: 'hier' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    // 21 h UTC reste le même jour à Paris, été comme hiver.
    const summer = new Date('2027-07-15T21:00:00.000Z');
    expect(localTime(summer, 'Europe/Paris').date).toBe('2027-07-15');
    expect(localTime(new Date('2027-01-15T21:00:00.000Z'), 'Europe/Paris').date).toBe('2027-01-15');
  });

  it('[R16] un mandat inconnu ou d’un autre réseau est refusé, et le refus est au journal', async () => {
    const t = await setup();
    const a = await t.signed('hors_agence');
    const proof = { proof: 'x', receivedAt: SIGNED };
    const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    expect(await t.diffusion.recordWithdrawal({ role: 'direction', userId: 'd', networkId: 'autre-reseau' } as Viewer, a.mandateId, proof)).toEqual({ ok: false, rule: null, code: 'unknown_mandate' });
    expect(await t.diffusion.recordEarlyStart(t.direction, 'inconnu', proof)).toEqual({ ok: false, rule: null, code: 'unknown_mandate' });
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length).toBe(before + 2);
  });
});
