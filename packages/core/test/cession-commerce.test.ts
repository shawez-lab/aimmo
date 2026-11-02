import { expect, it } from 'vitest';
import { Acces, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { CessionCommerce, FicheCommerce, transferSteps } from '../src/commerces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const proof = (n: number): string => `preuves/00000000-0000-4000-8000-${String(n).padStart(12, '0')}.pdf`;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-09-07T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const { store, fiche } = createCaptation(db, journal, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const fiches = new FicheCommerce(db, journal, { now });
  const cessions = new CessionCommerce(db, journal, fiches, { now });
  const network = await store.createNetwork('Réseau test');
  const alexAgent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const samAgent = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction' | 'compliance' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  const alex = as('agent', alexAgent.id);
  const direction = as('direction', 'dir-1');
  let seq = 0;
  const shop = async (sheet: Record<string, unknown>, city = 'Dijon', postalCode = '21000', kind: 'business' | 'business_walls' = 'business') => {
    const p = await store.createProperty({ networkId: network.id, agentId: alexAgent.id, reference: `CE-${(seq += 1)}`, kind, status: 'available', city, postalCode });
    await fiches.update(acces, alex, p.id, { activity: 'restaurant', ...sheet });
    const f = await cessions.open(acces, alex, p.id);
    if (!f.ok) throw new Error(`ouverture ${JSON.stringify(f)}`);
    return { property: p, fileId: f.value.fileId };
  };
  let n = 0;
  const date = (fileId: string, kind: string, day: string) => cessions.record(acces, alex, fileId, { kind, day, proofRef: proof((n += 1)) });
  /** La direction range Dijon hors de tout périmètre de sauvegarde. */
  const outside = () => cessions.recordCommune(direction, { postalCode: '21000', city: 'Dijon', inPerimeter: false, source: 'Liste inventée des périmètres', sourceDate: '2026-06-30' });
  const setDay = (day: string) => (clock = Date.parse(`${day}T08:00:00.000Z`));
  return { outside, db, journal, acces, cessions, alex, sam: as('agent', samAgent.id), direction, compliance: as('compliance', 'conf-1'), shop, date, setDay };
}

const lineOf = (v: { lines: { step: string; status: string; due: string | null }[] }, step: string) => v.lines.find((l) => l.step === step)!;

describeWithSqlite('CE07 · étapes de la cession d’un fonds', () => {
  it('[R116] dossier A : 4 salariés, licence IV, hors périmètre ; chaque date égale au calcul fait à la main', async () => {
    const t = await setup();
    await t.outside();
    const a = await t.shop({ employees: 4, licenses: ['licence_4'] });
    await t.date(a.fileId, 'cession_prevue', '2027-10-27');
    // Information des salariés : 27 octobre − 2 mois = 27 août 2027, un vendredi ouvré.
    await t.date(a.fileId, 'information_salaries', '2027-08-20');
    await t.date(a.fileId, 'autorisations_verifiees', '2027-09-01');
    expect(await t.cessions.declareReady(t.acces, t.alex, a.fileId)).toMatchObject({ ok: false, rule: 'R116', missing: ['sequestre'] });
    await t.cessions.setEscrow(t.acces, t.alex, a.fileId, { kind: 'notaire', name: 'Maître Camille Inventée, notaire à Dijon' });
    const ready = await t.cessions.declareReady(t.acces, t.alex, a.fileId);
    expect(ready).toMatchObject({ ok: true, value: { ready: true } });
    if (!ready.ok) return;
    expect(lineOf(ready.value, 'information_salaries')).toMatchObject({ status: 'fait', due: '2027-08-27' });
    expect(lineOf(ready.value, 'preemption')).toMatchObject({ status: 'sans_objet' });
    expect(lineOf(ready.value, 'publication_jal')).toMatchObject({ status: 'apres_cession' });
    // Après la cession : 27 octobre + 15 jours = 11 novembre, férié, avancé au mercredi 10 novembre.
    t.setDay('2027-11-16');
    await t.date(a.fileId, 'cession_signee', '2027-10-27');
    await t.date(a.fileId, 'publication_jal', '2027-11-02');
    const v = await t.date(a.fileId, 'publication_bodacc', '2027-11-04');
    if (!v.ok) throw new Error('date');
    expect(lineOf(v.value, 'publication_jal')).toMatchObject({ status: 'fait', due: '2027-11-10' });
    expect(lineOf(v.value, 'publication_bodacc')).toMatchObject({ status: 'fait', due: '2027-11-10' });
    // Oppositions : 4 novembre + 10 jours = dimanche 14 novembre, reporté au lundi 15 novembre.
    expect(lineOf(v.value, 'fin_oppositions')).toMatchObject({ status: 'fait', due: '2027-11-15' });
  });

  it('[R116] dossier B : sans salarié, dans un périmètre de sauvegarde ; la commune a 2 mois, son silence vaut renonciation', async () => {
    const t = await setup();
    expect(await t.cessions.recordCommune(t.alex, { postalCode: '21000', city: 'Dijon', inPerimeter: true, source: 'x', sourceDate: '2027-01-01' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.cessions.recordCommune(t.direction, { postalCode: '21000', city: 'Dijon', inPerimeter: true, sourceDate: '2027-01-01' })).toMatchObject({ ok: false, code: 'bad_source' });
    await t.cessions.recordCommune(t.direction, { postalCode: '21000', city: 'Dijon', inPerimeter: true, source: 'Délibération inventée du conseil municipal', sourceDate: '2026-06-30' });
    const b = await t.shop({ employees: 0 });
    await t.date(b.fileId, 'cession_prevue', '2027-10-29');
    const before = await t.cessions.declareReady(t.acces, t.alex, b.fileId);
    expect(before).toMatchObject({ ok: false, rule: 'R116', missing: ['sequestre', 'preemption'] });
    // Déclaration reçue le vendredi 6 août 2027 : + 2 mois = mercredi 6 octobre 2027.
    const v = await t.date(b.fileId, 'declaration_preemption', '2027-08-06');
    if (!v.ok) throw new Error('date');
    expect(lineOf(v.value, 'preemption')).toMatchObject({ status: 'a_faire', due: '2027-10-06' });
    expect(lineOf(v.value, 'information_salaries')).toMatchObject({ status: 'sans_objet' });
    await t.cessions.setEscrow(t.acces, t.alex, b.fileId, { kind: 'banque', name: 'Banque Inventée de Bourgogne' });
    expect(await t.cessions.declareReady(t.acces, t.alex, b.fileId)).toMatchObject({ ok: false, missing: ['preemption'] });
    t.setDay('2027-10-07');
    expect(await t.cessions.declareReady(t.acces, t.alex, b.fileId)).toMatchObject({ ok: true, value: { ready: true, inPerimeter: true } });
    // La commune sortie du périmètre : l'étape est sans objet.
    await t.cessions.recordCommune(t.direction, { postalCode: '21000', city: 'DIJON', inPerimeter: false, source: 'Délibération inventée de levée', sourceDate: '2027-09-01' });
    const after = await t.cessions.read(t.acces, t.alex, b.fileId);
    expect(after.ok && lineOf(after.value, 'preemption')).toMatchObject({ status: 'sans_objet' });
    // Remise dans le périmètre, autrement écrite : la dernière version de la même commune fait foi.
    expect(await t.cessions.recordCommune(t.direction, { postalCode: '21000', city: 'DIJON', inPerimeter: true, source: 'Délibération inventée de rétablissement', sourceDate: '2027-10-01' })).toMatchObject({ ok: true, value: { version: 3 } });
    const again = await t.cessions.read(t.acces, t.alex, b.fileId);
    expect(again.ok && again.value.inPerimeter).toBe(true);
    // Une préemption exercée bloque la cession pour de bon.
    const pre = await t.date(b.fileId, 'preemption_exercee', '2027-10-05');
    expect(pre.ok && lineOf(pre.value, 'preemption')).toMatchObject({ status: 'preemptee' });
    expect(await t.cessions.declareReady(t.acces, t.alex, b.fileId)).toMatchObject({ ok: false, rule: 'R116', missing: ['preemption'] });
  });

  it('[R116] dossier C : 12 salariés, fin de délai un dimanche ; une information tardive bloque', async () => {
    const t = await setup();
    await t.outside();
    const c = await t.shop({ employees: 12 });
    await t.cessions.setEscrow(t.acces, t.alex, c.fileId, { kind: 'avocat', name: 'Cabinet Inventé, avocats' });
    await t.date(c.fileId, 'cession_prevue', '2027-12-17');
    // 17 décembre − 2 mois = dimanche 17 octobre, avancé au vendredi 15 octobre : jamais annoncer trop tard.
    t.setDay('2027-10-18');
    const v = await t.date(c.fileId, 'information_salaries', '2027-10-16');
    if (!v.ok) throw new Error('date');
    expect(lineOf(v.value, 'information_salaries')).toMatchObject({ status: 'en_retard', due: '2027-10-15' });
    expect(await t.cessions.declareReady(t.acces, t.alex, c.fileId)).toMatchObject({ ok: false, rule: 'R116', missing: ['information_salaries'] });
    // Une date corrigée, avec sa preuve, s'ajoute en nouvelle version.
    const fixed = await t.date(c.fileId, 'information_salaries', '2027-10-14');
    expect(fixed).toMatchObject({ ok: true, value: { dates: { information_salaries: { day: '2027-10-14', version: 2 } }, ready: true } });
  });

  it('[R10] aucune date inventée : sans date ni preuve, l’étape est à saisir', async () => {
    const t = await setup();
    const d = await t.shop({});
    const v = await t.cessions.read(t.acces, t.alex, d.fileId);
    if (!v.ok) throw new Error('lecture');
    // Le nombre de salariés inconnu : à saisir, et bloquant.
    // La commune que la direction n'a pas rangée : la préemption est à saisir, par prudence.
    expect(v.value.lines.filter((l) => l.status === 'a_saisir').map((l) => l.step)).toEqual(['cession_prevue', 'sequestre', 'information_salaries', 'preemption']);
    expect(v.value.inPerimeter).toBeNull();
    expect(v.value.lines.every((l) => l.status === 'a_saisir' ? l.due === null : true)).toBe(true);
    expect(await t.cessions.record(t.acces, t.alex, d.fileId, { kind: 'cession_prevue', day: '2027-12-01' })).toMatchObject({ ok: false, code: 'bad_proof' });
    expect(await t.cessions.record(t.acces, t.alex, d.fileId, { kind: 'cession_signee', day: '2027-12-01', proofRef: proof(99) })).toMatchObject({ ok: false, code: 'future_day' });
    expect(await t.cessions.record(t.acces, t.alex, d.fileId, { kind: 'cession_prevue', day: '2027-02-30', proofRef: proof(98) })).toMatchObject({ ok: false, code: 'bad_day' });
    expect(transferSteps({ employees: 3, licenses: [], inPerimeter: false, escrow: null, dates: {}, today: '2027-09-07' }).lines.find((l) => l.step === 'information_salaries')).toMatchObject({ status: 'a_saisir', due: null });
  });

  it('[R117] le séquestre est un avocat, un notaire ou une banque nommés, jamais le réseau ni un agent', async () => {
    const t = await setup();
    const e = await t.shop({ employees: 0 });
    for (const input of [
      { kind: 'reseau', name: 'Séquestre du réseau' },
      { kind: 'agent', name: 'Alex Agent' },
      { kind: 'notaire', name: 'AIMMO séquestre' },
      { kind: 'banque', name: 'Compte du Réseau test' },
      { kind: 'avocat', name: 'Maître Alex Agent' },
      { kind: 'avocat', name: 'Agent Sam' },
    ]) {
      expect(await t.cessions.setEscrow(t.acces, t.alex, e.fileId, input), input.name).toMatchObject({ ok: false, rule: 'R117', code: 'sequestre_interdit' });
    }
    expect(await t.cessions.setEscrow(t.acces, t.alex, e.fileId, { kind: 'notaire', name: 'Me' })).toMatchObject({ ok: false, code: 'bad_name' });
    expect(await t.cessions.setEscrow(t.acces, t.alex, e.fileId, { kind: 'notaire', name: 'Office notarial inventé de Beaune' })).toMatchObject({ ok: true, value: { escrow: { kind: 'notaire', version: 1 } } });
  });

  it('[R16] [R17] droits, sorte, et rien ne s’efface ; rien n’est envoyé aux clients', async () => {
    const t = await setup();
    const f = await t.shop({ employees: 2 });
    expect(await t.cessions.read(t.acces, t.sam, f.fileId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.cessions.record(t.acces, t.compliance, f.fileId, { kind: 'cession_prevue', day: '2027-12-01', proofRef: proof(1) })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.cessions.read(t.acces, t.compliance, f.fileId)).toMatchObject({ ok: true });
    expect(await t.cessions.open(t.acces, t.alex, f.property.id)).toMatchObject({ ok: false, code: 'already_open' });
    await expect(t.shop({}, 'Dijon', '21000', 'business_walls')).rejects.toThrow(/sorte/);
    await t.date(f.fileId, 'cession_prevue', '2027-12-01');
    await expect(t.db.run('UPDATE business_transfer_dates SET day = ?', ['2027-01-01'])).rejects.toThrow(/rien ne se réécrit/);
    await expect(t.db.run('DELETE FROM business_transfer_files')).rejects.toThrow(/rien ne s'efface/);
    expect(await t.db.all('SELECT 1 FROM messages')).toHaveLength(0);
  });

  it('[R116] une tâche à l’agent avant chaque échéance, une seule ; une date à saisir, une seule', async () => {
    const t = await setup();
    await t.cessions.recordCommune(t.direction, { postalCode: '21000', city: 'Dijon', inPerimeter: true, source: 'Délibération inventée', sourceDate: '2026-06-30' });
    const b = await t.shop({ employees: 0 });
    await t.date(b.fileId, 'cession_prevue', '2027-10-29');
    await t.date(b.fileId, 'declaration_preemption', '2027-08-06');
    const first = await t.cessions.run((await t.db.first<{ id: string }>('SELECT id FROM networks'))!.id);
    // Le séquestre à saisir ; la préemption (6 octobre, 7 jours d'avance) pas encore.
    const net = (await t.db.first<{ id: string }>('SELECT id FROM networks'))!.id;
    expect(first).toBe(1);
    expect(await t.cessions.run(net)).toBe(0);
    t.setDay('2027-09-29');
    expect(await t.cessions.run(net)).toBe(1);
    expect(await t.cessions.run(net)).toBe(0);
    const tasks = await t.cessions.tasksOf(t.alex);
    expect(tasks.ok && tasks.value.map((x) => [x.step, x.due])).toEqual([
      ['sequestre', null],
      ['preemption', '2027-10-06'],
    ]);
    expect(await t.cessions.tasksOf(t.sam)).toEqual({ ok: true, value: [] });
  });
});

it('aucune avance de tâche hors des bornes', () => {
  expect(() => new CessionCommerce({} as SqlDatabase, {} as never, {} as never, { notice: { preemption: -1 } })).toThrow();
});

describeWithSqlite('CE12 · la signature suit la cession déclarée prête', () => {
  it('[R116] pas de signature avant la cession déclarée prête ; une signature rangée se corrige même si une étape manque ensuite', async () => {
    const t = await setup();
    await t.outside();
    const a = await t.shop({ employees: 0 });
    expect(await t.date(a.fileId, 'cession_signee', '2027-01-15')).toMatchObject({ ok: false, rule: 'R116', code: 'etapes_bloquantes', missing: ['cession_prevue', 'sequestre'] });
    await t.date(a.fileId, 'cession_prevue', '2027-10-27');
    await t.cessions.setEscrow(t.acces, t.alex, a.fileId, { kind: 'notaire', name: 'Office notarial inventé' });
    expect(await t.date(a.fileId, 'cession_signee', '2027-01-15')).toMatchObject({ ok: false, rule: 'R116', code: 'cession_non_declaree' });
    expect((await t.journal.bySubject(`property:${a.property.id}`)).filter((e) => e.type === 'commerces.cession.pas_prete')).toHaveLength(2);
    await t.cessions.declareReady(t.acces, t.alex, a.fileId);
    expect(await t.date(a.fileId, 'cession_signee', '2027-01-15')).toMatchObject({ ok: true });
    // La commune rangée ensuite dans un périmètre : la cession n'est plus prête ; la signature qui a eu lieu se corrige quand même.
    await t.cessions.recordCommune(t.direction, { postalCode: '21000', city: 'Dijon', inPerimeter: true, source: 'Liste inventée corrigée', sourceDate: '2026-07-30' });
    expect(await t.cessions.read(t.acces, t.alex, a.fileId)).toMatchObject({ ok: true, value: { ready: false, missing: ['preemption'] } });
    expect(await t.date(a.fileId, 'cession_signee', '2027-01-16')).toMatchObject({ ok: true, value: { dates: { cession_signee: { day: '2027-01-16', version: 2 } } } });
  });
});
