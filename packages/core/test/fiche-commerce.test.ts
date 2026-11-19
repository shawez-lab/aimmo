import { describe, expect, it } from 'vitest';
import { Acces, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import {
  ACTIVITIES,
  FicheCommerce,
  PUBLIC_PROPERTY_COLUMNS,
  SHEET_FIELDS,
  SHEET_VISIBILITY,
  TachesBail,
  checkSheetChanges,
  leaseMilestones,
  minusMonths,
  sheetText,
  EMPTY_SHEET,
  visibilityOf,
} from '../src/commerces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TUESDAY_10H = Date.parse('2027-09-07T08:00:00.000Z');

/** Une fiche inventée, chaque valeur reconnaissable pour la chercher dans ce qui sort. */
const FULL = {
  activity: 'boulangerie_patisserie',
  signName: 'Au Fournil Imaginaire',
  fiscalYears: [
    { year: 2025, revenueCents: 41_234_500, resultCents: 3_876_100 },
    { year: 2026, revenueCents: 43_987_600, resultCents: 4_112_300 },
    { year: 2024, revenueCents: 39_456_700, resultCents: -1_234_500 },
  ],
  leaseStart: '2021-04-01',
  leaseYears: 9,
  leaseAnnualRentCents: 1_872_300,
  leaseUse: 'named_and_related',
  leaseAssignment: 'landlord_approval',
  employees: 7,
  equipment: ['Four à sole Zéphyr 4 étages', 'Pétrin spirale'],
  licenses: ['agrement_sanitaire', 'terrasse'],
};
const SECRETS = ['Fournil', 'Imaginaire', '41234500', '43987600', '39456700', '3876100', '4112300', '1234500', '1872300', 'Zéphyr', 'Pétrin', '2021-04-01', 'landlord_approval', 'agrement_sanitaire'];

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const { store, fiche } = createCaptation(db, journal, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const fiches = new FicheCommerce(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  let seq = 0;
  const property = async (kind: 'business' | 'business_walls' | 'commercial' | 'home' = 'business', status: 'draft' | 'available' = 'available') =>
    store.createProperty({ networkId: network.id, agentId: alex.id, reference: `CE-${(seq += 1)}`, kind, status, city: 'Dijon', postalCode: '21000', surfaceM2: 85, priceEur: 187_000 });
  const as = (role: 'agent' | 'direction' | 'compliance' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  const count = async (sql: string, params: (string | number | null)[] = []) => Number((await db.first<{ n: number }>(sql, params))!.n);
  return { db, journal, acces, fiches, network, alex, sam, property, as, count };
}

it('[R110] seule l’activité est publique dans la fiche ; une colonne non classée est confidentielle', () => {
  const publics = Object.entries(SHEET_VISIBILITY).filter(([, v]) => v === 'public').map(([k]) => k);
  expect(publics).toEqual(['activity']);
  expect(visibilityOf('activity')).toBe('public');
  for (const column of ['sign_name', 'fiscal_years', 'lease_annual_rent_cents', 'employees', 'une_colonne_ajoutee_plus_tard', 'address', '']) {
    expect(visibilityOf(column), column).toBe('confidential');
  }
  // Le prix, la référence et l'agent du bien ne sont pas publics.
  expect(PUBLIC_PROPERTY_COLUMNS).toEqual(['kind', 'city', 'postal_code', 'surface_m2']);
});

it('[R110] un champ inconnu est refusé, jamais ignoré ; une valeur hors liste aussi', () => {
  expect(checkSheetChanges({ activity: 'restaurant', address: '3 rue des Essais' })).toEqual({ ok: false, rule: 'R110', code: 'champ_inconnu' });
  expect(checkSheetChanges({ ownerName: 'Dupont' })).toEqual({ ok: false, rule: 'R110', code: 'champ_inconnu' });
  expect(checkSheetChanges({ activity: 'casino' })).toMatchObject({ ok: false, code: 'hors_liste', field: 'activity' });
  expect(checkSheetChanges({ leaseUse: 'tout' })).toMatchObject({ ok: false, code: 'hors_liste', field: 'leaseUse' });
  expect(checkSheetChanges({ leaseAssignment: 'libre' })).toMatchObject({ ok: false, code: 'hors_liste', field: 'leaseAssignment' });
  expect(checkSheetChanges({ licenses: ['licence_4', 'licence_9'] })).toMatchObject({ ok: false, code: 'hors_liste', field: 'licenses' });
  expect(checkSheetChanges({ leaseYears: 0 })).toMatchObject({ ok: false, code: 'valeur', field: 'leaseYears' });
  expect(checkSheetChanges({ employees: 2.5 })).toMatchObject({ ok: false, code: 'valeur', field: 'employees' });
  expect(checkSheetChanges({ leaseAnnualRentCents: '1000' })).toMatchObject({ ok: false, code: 'valeur', field: 'leaseAnnualRentCents' });
  expect(checkSheetChanges({ leaseStart: '2021-02-30' })).toMatchObject({ ok: false, code: 'valeur', field: 'leaseStart' });
  for (const d of ['2021-13-01', '2021-01-32', '2021-00-10']) expect(checkSheetChanges({ leaseStart: d }), d).toMatchObject({ ok: false, code: 'valeur', field: 'leaseStart' });
  expect(checkSheetChanges({ signName: '   ' })).toMatchObject({ ok: false, code: 'valeur', field: 'signName' });
  expect(checkSheetChanges({ equipment: ['x'.repeat(81)] })).toMatchObject({ ok: false, code: 'valeur', field: 'equipment' });
  // Exercices : 3 au plus, une année une fois, trois clés exactement, résultat négatif permis.
  const y = (year: number) => ({ year, revenueCents: 100, resultCents: -5 });
  expect(checkSheetChanges({ fiscalYears: [y(2023), y(2024), y(2025), y(2026)] })).toMatchObject({ ok: false, code: 'valeur', field: 'fiscalYears' });
  expect(checkSheetChanges({ fiscalYears: [y(2025), y(2025)] })).toMatchObject({ ok: false, code: 'valeur', field: 'fiscalYears' });
  expect(checkSheetChanges({ fiscalYears: [{ ...y(2025), ownerSalaryCents: 1 }] })).toMatchObject({ ok: false, code: 'valeur', field: 'fiscalYears' });
  expect(checkSheetChanges({ fiscalYears: [{ year: 2025, revenueCents: -1, resultCents: 0 }] })).toMatchObject({ ok: false, code: 'valeur', field: 'fiscalYears' });
  // L'excédent brut d'exploitation est facultatif, entier, et peut être négatif.
  expect(checkSheetChanges({ fiscalYears: [{ ...y(2025), ebitdaCents: -7 }] })).toMatchObject({ ok: true, value: { fiscalYears: [{ year: 2025, ebitdaCents: -7 }] } });
  expect(checkSheetChanges({ fiscalYears: [{ ...y(2025), ebitdaCents: 1.5 }] })).toMatchObject({ ok: false, code: 'valeur', field: 'fiscalYears' });
  expect(checkSheetChanges({})).toMatchObject({ ok: false, code: 'valeur' });
  expect(checkSheetChanges(null)).toMatchObject({ ok: false, code: 'valeur' });
  expect(checkSheetChanges(['activity'])).toMatchObject({ ok: false, code: 'valeur' });

  const ok = checkSheetChanges(FULL);
  expect(ok.ok).toBe(true);
  // Les exercices sont rangés du plus récent au plus ancien.
  expect(ok.ok && ok.value.fiscalYears!.map((f) => f.year)).toEqual([2026, 2025, 2024]);
  expect(checkSheetChanges({ fiscalYears: null, equipment: null, licenses: null, signName: null })).toEqual({
    ok: true,
    value: { fiscalYears: [], equipment: [], licenses: [], signName: null },
  });
  expect(ACTIVITIES.length).toBeGreaterThan(10);
});

describeWithSqlite('CE01 · fiche du commerce', () => {
  it('[R110] chaque colonne de la table est classée, et seule l’activité est publique', async () => {
    const t = await setup();
    const cols = (await t.db.all<{ name: string }>("SELECT name FROM pragma_table_info('business_sheets')")).map((c) => c.name);
    expect(cols.sort()).toEqual(Object.keys(SHEET_VISIBILITY).sort());
    expect(cols.filter((c) => visibilityOf(c) === 'public')).toEqual(['activity']);
    // Chaque champ de la fiche a sa colonne.
    expect(SHEET_FIELDS.length).toBe(14);
  });

  it('[R110] [R09] la vue publique ne porte ni enseigne, ni exercice, ni loyer, ni bail, ni prix, même quand la fiche les porte', async () => {
    const t = await setup();
    const p = await t.property();
    expect(await t.fiches.update(t.acces, t.as('agent', t.alex.id), p.id, FULL)).toMatchObject({ ok: true, created: true });
    const view = await t.fiches.publicView(p.id);
    expect(view).toEqual({ kind: 'business', activity: 'boulangerie_patisserie', city: 'Dijon', postalCode: '21000', surfaceM2: 85 });
    const text = JSON.stringify(view);
    for (const secret of [...SECRETS, '187000', p.reference, t.alex.id]) expect(text, secret).not.toContain(secret);
    // Murs et local professionnel ont aussi leur vue ; un logement n'en a pas.
    expect((await t.fiches.publicView((await t.property('business_walls')).id))?.activity).toBeNull();
    expect((await t.fiches.publicView((await t.property('commercial')).id))?.kind).toBe('commercial');
    expect(await t.fiches.publicView((await t.property('home')).id)).toBeNull();
    expect(await t.fiches.publicView('inconnu')).toBeNull();
  });

  it('[R17] une version ne change plus, la suivante la remplace, rien ne s’efface', async () => {
    const t = await setup();
    const p = await t.property();
    const alex = t.as('agent', t.alex.id);
    await t.fiches.update(t.acces, alex, p.id, FULL);
    expect(await t.fiches.update(t.acces, alex, p.id, { employees: 7 })).toMatchObject({ ok: true, created: false });
    const second = await t.fiches.update(t.acces, alex, p.id, { employees: 6, equipment: null });
    expect(second).toMatchObject({ ok: true, created: true });
    const read = await t.fiches.read(t.acces, alex, p.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.history.map((v) => v.version)).toEqual([1, 2]);
    expect(read.value.history[0]!.sheet.employees).toBe(7);
    expect(read.value.history[0]!.sheet.equipment).toEqual(FULL.equipment);
    expect(read.value.current!.sheet).toMatchObject({ employees: 6, equipment: [], signName: 'Au Fournil Imaginaire', leaseYears: 9 });
    expect(read.value.current!.sources.employees).toBe(`agent:${t.alex.id}`);
    await expect(t.db.run('UPDATE business_sheets SET employees = 1')).rejects.toThrow(/ne se réécrit pas/);
    await expect(t.db.run('DELETE FROM business_sheets')).rejects.toThrow(/rien ne s'efface/);
    // Deux écritures simultanées prennent deux numéros.
    await Promise.all([t.fiches.update(t.acces, alex, p.id, { employees: 5 }), t.fiches.update(t.acces, alex, p.id, { leaseYears: 10 })]);
    const last = await t.fiches.current(p.id);
    expect(last!.version).toBe(4);
    expect(last!.sheet).toMatchObject({ employees: 5, leaseYears: 10 });
  });

  it('[R13] un refus va au journal sans aucune valeur, et rien n’est rangé', async () => {
    const t = await setup();
    const p = await t.property();
    const alex = t.as('agent', t.alex.id);
    expect(await t.fiches.update(t.acces, alex, p.id, { ...FULL, ownerName: 'Dupont' })).toMatchObject({ ok: false, rule: 'R110', code: 'champ_inconnu' });
    expect(await t.fiches.update(t.acces, alex, p.id, { ...FULL, activity: 'casino' })).toMatchObject({ ok: false, code: 'hors_liste', field: 'activity' });
    expect(await t.count('SELECT count(*) AS n FROM business_sheets')).toBe(0);
    await t.fiches.update(t.acces, alex, p.id, FULL);
    const events = (await t.journal.all()).filter((e) => e.type.startsWith('commerces.fiche'));
    expect(events.map((e) => e.type)).toEqual(['commerces.fiche.refuse', 'commerces.fiche.refuse', 'commerces.fiche']);
    const text = JSON.stringify(events);
    for (const secret of [...SECRETS, 'Dupont', 'casino']) expect(text, secret).not.toContain(secret);
  });

  it('[R16] un autre agent est refusé, au journal ; la conformité lit sans écrire ; la direction écrit ; un autre réseau ne voit rien', async () => {
    const t = await setup();
    // En vente : le bien est au fichier commun, Sam le voit en partie, pas sa fiche de commerce.
    const p = await t.property('business', 'available');
    await t.fiches.update(t.acces, t.as('agent', t.alex.id), p.id, FULL);
    const sam = t.as('agent', t.sam.id);
    expect(await t.fiches.read(t.acces, sam, p.id)).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.fiches.update(t.acces, sam, p.id, { employees: 1 })).toMatchObject({ ok: false, rule: 'R16' });
    const draft = await t.property('business', 'draft');
    expect(await t.fiches.read(t.acces, sam, draft.id)).toMatchObject({ ok: false, rule: 'R16' });
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.actor === `agent:${t.sam.id}`);
    expect(refused.length).toBeGreaterThanOrEqual(3);

    const compliance = t.as('compliance', 'conf-1');
    expect(await t.fiches.read(t.acces, compliance, p.id)).toMatchObject({ ok: true });
    expect(await t.fiches.update(t.acces, compliance, p.id, { employees: 1 })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.fiches.update(t.acces, t.as('partner', 'p-1'), p.id, { employees: 1 })).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.fiches.current(p.id))!.sheet.employees).toBe(7);

    expect(await t.fiches.read(t.acces, { role: 'agent', userId: t.alex.id, networkId: 'autre-reseau' }, p.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.fiches.update(t.acces, t.as('direction', 'dir-1'), p.id, { employees: 8 })).toMatchObject({ ok: true, created: true });
    const read = await t.fiches.read(t.acces, t.as('agent', t.alex.id), p.id);
    expect(read.ok && read.value.current!.sources.employees).toBe('direction:dir-1');
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('[R17] une colonne JSON illisible n’est jamais lue comme vide : rien n’est écrit par-dessus', async () => {
    const t = await setup();
    const p = await t.property();
    const alex = t.as('agent', t.alex.id);
    await t.fiches.update(t.acces, alex, p.id, FULL);
    // Une ligne abîmée, rangée hors du module (les versions ne se réécrivent pas : on en ajoute une).
    await t.db.run(
      `INSERT INTO business_sheets (id, network_id, property_id, version, fiscal_years, equipment, licenses, sources, author, created_at)
       VALUES ('abimee', ?, ?, 2, '[{"year":', '[]', '[]', '{}', 'agent:x', '2027-09-07T09:00:00.000Z')`,
      [t.network.id, p.id],
    );
    await expect(t.fiches.update(t.acces, alex, p.id, { employees: 2 })).rejects.toThrow(/fiscal_years illisible/);
    expect(await t.count('SELECT count(*) AS n FROM business_sheets')).toBe(2);
  });

  it('un bien qui n’est pas un commerce est refusé', async () => {
    const t = await setup();
    const home = await t.property('home');
    expect(await t.fiches.update(t.acces, t.as('agent', t.alex.id), home.id, { activity: 'restaurant' })).toMatchObject({ ok: false, code: 'sorte' });
    expect(await t.count('SELECT count(*) AS n FROM business_sheets')).toBe(0);
  });
});

describe('AU101 · les dates utiles du bail commercial', () => {
  it('[R10] échéances triennales, fin et jours limites des congés, par le code ; rien sans début ni durée', () => {
    // L'exemple de service-public.fr : un bail du 1er juillet 2014 sur 9 ans expire le 30 juin 2023.
    expect(leaseMilestones({ leaseStart: '2014-07-01', leaseYears: 9 }, '2014-07-01')).toMatchObject({ nextTriennial: '2017-06-30', leaseEnd: '2023-06-30', endNoticeBy: '2022-12-30' });
    const lease = { leaseStart: '2021-03-15', leaseYears: 9 };
    expect(leaseMilestones(lease, '2026-11-19')).toEqual({ nextTriennial: '2027-03-14', triennialNoticeBy: '2026-09-14', leaseEnd: '2030-03-14', endNoticeBy: '2029-09-14', ended: false });
    // Le jour même de l'échéance, elle est encore la prochaine ; le lendemain, seule la fin compte.
    expect(leaseMilestones(lease, '2027-03-14')).toMatchObject({ nextTriennial: '2027-03-14' });
    expect(leaseMilestones(lease, '2027-03-15')).toMatchObject({ nextTriennial: null, triennialNoticeBy: null, leaseEnd: '2030-03-14' });
    expect(leaseMilestones(lease, '2030-03-14')).toMatchObject({ ended: false });
    expect(leaseMilestones(lease, '2030-03-15')).toMatchObject({ ended: true });
    // Un bail commencé un 29 février : l'anniversaire tombe le 28 les années ordinaires, l'échéance la veille.
    expect(leaseMilestones({ leaseStart: '2024-02-29', leaseYears: 9 }, '2025-01-01')).toMatchObject({ nextTriennial: '2027-02-27', triennialNoticeBy: '2026-08-27' });
    expect(minusMonths('2027-08-31', 6)).toBe('2027-02-28');
    expect(leaseMilestones({ leaseStart: null, leaseYears: 9 }, '2026-11-19')).toBeNull();
    expect(leaseMilestones({ leaseStart: '2021-03-15', leaseYears: null }, '2026-11-19')).toBeNull();
  });
  it('[R110] l’indice de révision se range dans la liste fermée, et le dossier écrit les dates', () => {
    expect(checkSheetChanges({ leaseIndex: 'ilc' })).toMatchObject({ ok: true, value: { leaseIndex: 'ilc' } });
    expect(checkSheetChanges({ leaseIndex: 'irl' })).toMatchObject({ ok: false, field: 'leaseIndex' });
    const text = sheetText({ ...EMPTY_SHEET, fiscalYears: [], equipment: [], licenses: [], leaseStart: '2021-03-15', leaseYears: 9, leaseIndex: 'ilc' }, 'C-1', '2026-11-19');
    expect(text).toContain('révision indice des loyers commerciaux');
    expect(text).toContain('Prochaine échéance triennale : 2027-03-14, congé du preneur à donner au plus tard le 2026-09-14.');
    expect(text).toContain('Fin du bail : 2030-03-14');
  });
});

describeWithSqlite('AU101b · les jours limites de congé en tâches de l’agent', () => {
  it('[R10] une tâche, une seule, 60 jours avant le jour limite ; rien sans début ni durée ; plus rien quand la fiche change', async () => {
    const t = await setup();
    const agent = t.as('agent', t.alex.id);
    // Aujourd'hui le 7 septembre 2027. Bail du 1er janvier 2019 sur 9 ans : échéance triennale le 31 décembre 2027,
    // congé au plus tard le 30 juin 2027 (passé) ; fin le 31 décembre 2027, congé au plus tard le 30 juin 2027 aussi.
    // Un bail du 1er mai 2022 : échéance triennale le 30 avril 2028, congé au plus tard le 30 octobre 2027, dans 53 jours.
    const near = await t.property('business');
    expect((await t.fiches.update(t.acces, agent, near.id, { leaseStart: '2022-05-01', leaseYears: 9 })).ok).toBe(true);
    const far = await t.property('commercial');
    expect((await t.fiches.update(t.acces, agent, far.id, { leaseStart: '2026-05-01', leaseYears: 9 })).ok).toBe(true);
    const none = await t.property('business');
    expect((await t.fiches.update(t.acces, agent, none.id, { leaseYears: 9 })).ok).toBe(true);
    const bail = new TachesBail(t.db, t.journal, t.fiches, { now: () => new Date(TUESDAY_10H) });
    expect(await bail.run(t.network.id)).toBe(1);
    expect(await bail.run(t.network.id)).toBe(0);
    const r = await bail.tasksOf(agent);
    expect(r).toEqual({ ok: true, value: [{ propertyId: near.id, reference: near.reference, kind: 'conge_triennal', deadline: '2027-10-30', expiry: '2028-04-30' }] });
    expect(await bail.tasksOf(t.as('direction', 'd1'))).toMatchObject({ ok: false, rule: 'R16' });
    // Le début du bail corrigé : l'ancienne tâche ne se montre plus.
    expect((await t.fiches.update(t.acces, agent, near.id, { leaseStart: '2022-07-01' })).ok).toBe(true);
    expect(await bail.tasksOf(agent)).toEqual({ ok: true, value: [] });
  });
});
