import { expect, it } from 'vitest';
import { Echeancier, alsaceMoselleHolidays, buyerWithdrawalLastDay, calendarFor, domicileInAlsaceMoselle, preemptionLastDay, propertyPlace, scheduleLines } from '../src/dossiers/index.ts';
import { readFileSync } from 'node:fs';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// AU085 · Jeux inventés. Pâques 2027 : le 28 mars, donc le Vendredi saint le 26 mars. Le 26 décembre 2028 est un mardi.

it('[R61] AU085 : le constat ne tient plus, le calcul ne dit plus ignorer les jours fériés d’Alsace-Moselle', () => {
  const source = readFileSync(new URL('../src/dossiers/echeancier.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/Alsace-Moselle ne sont pas comptés/);
});

it('[R61] AU085 : le Vendredi saint et la Saint-Étienne sont fériés en Alsace-Moselle, et seulement là', () => {
  expect([...alsaceMoselleHolidays(2027)].sort()).toEqual(['2027-03-26', '2027-12-26']);
  expect([...alsaceMoselleHolidays(2028)].sort()).toEqual(['2028-04-14', '2028-12-26']);
  expect([...alsaceMoselleHolidays(2030)].sort()).toEqual(['2030-04-19', '2030-12-26']);
  // Vendredi saint : la rétractation qui y finit passe au mardi 30 mars (samedi, dimanche, lundi de Pâques).
  expect(buyerWithdrawalLastDay('2027-03-16')).toBe('2027-03-26');
  expect(buyerWithdrawalLastDay('2027-03-16', 'national')).toBe('2027-03-26');
  expect(buyerWithdrawalLastDay('2027-03-16', 'alsace_moselle')).toBe('2027-03-30');
  // Saint-Étienne un mardi : le mercredi 27.
  expect(buyerWithdrawalLastDay('2028-12-16', 'national')).toBe('2028-12-26');
  expect(buyerWithdrawalLastDay('2028-12-16', 'alsace_moselle')).toBe('2028-12-27');
  // Le délai de la commune : deux mois tombant le 26 décembre 2028, ou le Vendredi saint 2028.
  expect(preemptionLastDay('2028-10-26', undefined, undefined, 'national')).toBe('2028-12-26');
  expect(preemptionLastDay('2028-10-26', undefined, undefined, 'alsace_moselle')).toBe('2028-12-27');
  expect(preemptionLastDay('2028-02-14', undefined, undefined, 'national')).toBe('2028-04-14');
  expect(preemptionLastDay('2028-02-14', undefined, undefined, 'alsace_moselle')).toBe('2028-04-18'); // samedi, dimanche, lundi de Pâques
  // Après une suspension aussi : reprise le 26 novembre 2028, un mois au moins, fin le 26 décembre.
  expect(preemptionLastDay('2028-09-01', '2028-10-20', '2028-11-26', 'national')).toBe('2028-12-26');
  expect(preemptionLastDay('2028-09-01', '2028-10-20', '2028-11-26', 'alsace_moselle')).toBe('2028-12-27');
});

it('[R61] AU085 : le calendrier suit le lieu du bien et le domicile de l’acquéreur ; un lieu inconnu prend le plus prudent', () => {
  expect(propertyPlace('57000')).toBe('alsace_moselle');
  expect(propertyPlace('67000')).toBe('alsace_moselle');
  expect(propertyPlace('68100')).toBe('alsace_moselle');
  expect(propertyPlace('21000')).toBe('ailleurs');
  expect(propertyPlace('88000')).toBe('ailleurs'); // les Vosges ne sont pas en droit local
  expect(propertyPlace(null)).toBe('inconnu');
  expect(propertyPlace('57')).toBe('inconnu');
  expect(calendarFor('alsace_moselle')).toEqual({ calendar: 'alsace_moselle', reason: 'bien' });
  expect(calendarFor('ailleurs')).toEqual({ calendar: 'national', reason: null });
  expect(calendarFor('ailleurs', true)).toEqual({ calendar: 'alsace_moselle', reason: 'domicile_acquereur' });
  expect(calendarFor('inconnu')).toEqual({ calendar: 'alsace_moselle', reason: 'lieu_inconnu' });
  expect(domicileInAlsaceMoselle({ postalCode: '67000', country: null })).toBe(true);
  expect(domicileInAlsaceMoselle({ postalCode: '67000', country: 'France' })).toBe(true);
  expect(domicileInAlsaceMoselle({ postalCode: '67000', country: 'Allemagne' })).toBe(false);
  expect(domicileInAlsaceMoselle({ postalCode: '21000', country: null })).toBe(false);
  // Le dossier retient le délai le plus tardif : un coacquéreur domicilié à Strasbourg prolonge la rétractation.
  const facts = { hasLoanCondition: true, isCoownershipLot: true };
  const lines = scheduleLines({ notification_acquereur: '2027-03-16' }, facts, ['2027-03-16'], { lead: 'national', coBuyers: ['alsace_moselle'] });
  expect(lines[0]).toMatchObject({ deadline: 'fin_retractation', day: '2027-03-30', calendar: 'alsace_moselle' });
  expect(scheduleLines({ notification_acquereur: '2027-03-16' }, facts, ['2027-03-16'])[0]).toMatchObject({ day: '2027-03-26', calendar: 'national' });
  // Une date lue telle que saisie n'a pas de calendrier.
  expect(lines.find((l) => l.deadline === 'acte')?.calendar).toBeNull();
});

describeWithSqlite('AU085 · échéancier d’un dossier en Alsace-Moselle', () => {
  const PARIS_9H = (day: string) => new Date(`${day}T08:00:00.000Z`);
  // Le bien déménage : une nouvelle version de sa désignation, qui prime sur le code postal de sa fiche (AU002).
  const place = async (t: Awaited<ReturnType<typeof setupDossier>>, postalCode: string, city: string) => {
    const p = await t.db.first<{ property_id: string; network_id: string }>('SELECT property_id, network_id FROM sale_files WHERE id = ?', [t.fileId]);
    await t.db.run(
      `INSERT INTO property_designations (id, network_id, property_id, version, street, postal_code, city, parcels, set_by, set_at)
       VALUES ('designation-am', ?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM property_designations WHERE property_id = ?), '4 rue Inventée', ?, ?, '[{"prefix":null,"section":"AB","number":"2"}]', 'test', ?)`,
      [p!.network_id, p!.property_id, p!.property_id, postalCode, city, t.now().toISOString()],
    );
  };

  it('[R61] un bien à Metz : la rétractation et la réponse de la commune passent le Vendredi saint et la Saint-Étienne', async () => {
    const t = await setupDossier();
    await place(t, '57000', 'Metz');
    await t.startCompromis();
    t.setClock(PARIS_9H('2027-03-16'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    expect(await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF })).toMatchObject({ ok: true });
    expect(await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-16', proofRef: PROOF })).toMatchObject({ ok: true });
    const s = await e.schedule(t.agent, t.fileId);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.value.lines[0]).toMatchObject({ deadline: 'fin_retractation', day: '2027-03-30', calendar: 'alsace_moselle' });
    expect(s.value.buyers[0]).toMatchObject({ lastDay: '2027-03-30', calendar: 'alsace_moselle', calendarReason: 'bien' });
    expect(s.value.preemptionCalendar).toEqual({ calendar: 'alsace_moselle', reason: 'bien' });
    // La tâche de l'agent arrive la veille du vrai dernier jour, pas la veille du Vendredi saint.
    t.setClock(PARIS_9H('2027-03-29'));
    await e.run(t.network.id);
    const tasks = await e.tasksOf(t.agent);
    expect(tasks.ok && tasks.tasks.filter((k) => k.deadline === 'fin_retractation')).toMatchObject([{ kind: 'avant_echeance', day: '2027-03-30' }]);
  });

  it('[R61] un bien à Dijon reste au calendrier national ; un acquéreur domicilié à Colmar prolonge sa seule rétractation', async () => {
    const t = await setupDossier();
    await t.startCompromis();
    t.setClock(PARIS_9H('2027-03-16'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-16', proofRef: PROOF });
    let s = await e.schedule(t.agent, t.fileId);
    expect(s.ok && s.value.lines[0]).toMatchObject({ day: '2027-03-26', calendar: 'national' });
    expect(s.ok && s.value.preemptionCalendar).toEqual({ calendar: 'national', reason: null });
    const buyer = await t.db.first<{ buyer_person_id: string; network_id: string }>('SELECT buyer_person_id, network_id FROM sale_files WHERE id = ?', [t.fileId]);
    await t.db.run(
      `INSERT INTO person_domiciles (id, network_id, person_id, version, street, postal_code, city, country, set_by, set_at)
       VALUES ('domicile-colmar', ?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM person_domiciles WHERE person_id = ?), '3 rue Inventée', '68000', 'Colmar', NULL, 'test', ?)`,
      [buyer!.network_id, buyer!.buyer_person_id, buyer!.buyer_person_id, t.now().toISOString()],
    );
    s = await e.schedule(t.agent, t.fileId);
    expect(s.ok && s.value.lines[0]).toMatchObject({ day: '2027-03-30', calendar: 'alsace_moselle' });
    expect(s.ok && s.value.buyers[0]).toMatchObject({ calendar: 'alsace_moselle', calendarReason: 'domicile_acquereur' });
    // La commune de Dijon répond au calendrier national.
    expect(s.ok && s.value.preemptionCalendar).toEqual({ calendar: 'national', reason: null });
  });

  it('[R61] le domicile saisi sur la fiche gardée d’une fusion compte pour l’acquéreur de la fiche réunie', async () => {
    const t = await setupDossier();
    await t.startCompromis();
    t.setClock(PARIS_9H('2027-03-16'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-16', proofRef: PROOF });
    const buyer = await t.db.first<{ buyer_person_id: string; network_id: string }>('SELECT buyer_person_id, network_id FROM sale_files WHERE id = ?', [t.fileId]);
    const survivor = (await t.store.createPerson({ networkId: buyer!.network_id, agentId: t.alexId, firstName: 'Gardée', lastName: 'Exemple' })).id;
    const at = t.now().toISOString();
    await t.db.run(
      `INSERT INTO person_domiciles (id, network_id, person_id, version, street, postal_code, city, country, set_by, set_at)
       VALUES ('domicile-strasbourg', ?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM person_domiciles WHERE person_id = ?), '5 rue Inventée', '67000', 'Strasbourg', 'France', 'test', ?)`,
      [buyer!.network_id, survivor, survivor, at],
    );
    expect((await e.schedule(t.agent, t.fileId)).ok && ((await e.schedule(t.agent, t.fileId)) as { value: { lines: { day: string | null }[] } }).value.lines[0]!.day).toBe('2027-03-26');
    await t.db.run(
      "INSERT INTO person_merges (id, network_id, agent_id, survivor_id, merged_id, reason, merged_at, undone_at, created_at) VALUES ('fusion-am', ?, NULL, ?, ?, 'même personne', ?, NULL, ?)",
      [buyer!.network_id, survivor, buyer!.buyer_person_id, at, at],
    );
    const s = await e.schedule(t.agent, t.fileId);
    expect(s.ok && s.value.lines[0]).toMatchObject({ day: '2027-03-30', calendar: 'alsace_moselle' });
    expect(s.ok && s.value.buyers[0]).toMatchObject({ calendarReason: 'domicile_acquereur' });
  });
});
