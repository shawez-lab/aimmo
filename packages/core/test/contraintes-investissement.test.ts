import { expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { Contraintes, RENTAL_BAN_ALERT, energyAlertGate, energyConstraint, type ConstraintSet } from '../src/investir/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TODAY = '2027-09-14';

it('[R124] [R100] une classe G, ou au-delà de 450 kWh/m²/an, est « interdit à la location » ; F et E portent leur date à venir', () => {
  const g = energyConstraint('G', null, TODAY, 'fiche');
  expect(g).toMatchObject({ status: 'interdit', bannedFrom: '2025-01-01' });
  expect(g.text.startsWith(RENTAL_BAN_ALERT)).toBe(true);
  expect(g.text).toBe('Interdit à la location : classe énergie G, interdite à la location depuis le 01/01/2025.');
  const over = energyConstraint('F', 451, TODAY, 'agent');
  expect(over).toMatchObject({ status: 'interdit', bannedFrom: '2023-01-01' });
  expect(over.text).toBe('Interdit à la location : consommation de 451 kWh/m²/an, au-delà de 450 kWh/m²/an, interdite pour un bail depuis le 01/01/2023.');
  expect(energyConstraint('F', 450, TODAY, 'agent')).toMatchObject({ status: 'echeance', bannedFrom: '2028-01-01' });
  expect(energyConstraint('F', null, TODAY, 'fiche').text).toBe('Classe énergie F : interdite à la location à partir du 01/01/2028, sauf travaux qui la font changer de classe.');
  expect(energyConstraint('E', null, TODAY, 'fiche')).toMatchObject({ status: 'echeance', bannedFrom: '2034-01-01' });
  expect(energyConstraint('D', null, TODAY, 'fiche')).toMatchObject({ status: 'aucune', bannedFrom: null });
  expect(energyConstraint(null, null, TODAY, 'aucune')).toMatchObject({ status: 'inconnue' });
  // Le seuil interdit même sans classe.
  expect(energyConstraint(null, 520, TODAY, 'agent')).toMatchObject({ status: 'interdit', bannedFrom: '2023-01-01' });
  expect(energyConstraint(null, 450, TODAY, 'agent')).toMatchObject({ status: 'inconnue' });
  // F devient interdit le jour venu, par la même règle.
  expect(energyConstraint('F', null, '2028-01-01', 'fiche')).toMatchObject({ status: 'interdit' });
});

it('[R124] la porte refuse un texte sans l’alerte en tête, ou sans contraintes calculées', () => {
  const banned: ConstraintSet = { constraints: [], rentalBan: true, energyUnknown: false, alertsFirst: ['Interdit à la location : classe énergie G.'], computedAt: TODAY };
  expect(energyAlertGate(banned, 'Interdit à la location : classe énergie G.\nAppartement de 45 m²…')).toEqual({ ok: true });
  expect(energyAlertGate(banned, '  Interdit à la location : classe énergie G. Suite')).toEqual({ ok: true });
  expect(energyAlertGate(banned, 'Appartement de 45 m². Interdit à la location : classe énergie G.')).toEqual({ ok: false, rule: 'R124', code: 'alerte_absente' });
  expect(energyAlertGate(banned, '')).toMatchObject({ ok: false, code: 'alerte_absente' });
  expect(energyAlertGate(null, 'Appartement')).toEqual({ ok: false, rule: 'R124', code: 'contraintes_absentes' });
  expect(energyAlertGate(undefined, 'Appartement')).toMatchObject({ ok: false, code: 'contraintes_absentes' });
  const clear: ConstraintSet = { constraints: [], rentalBan: false, energyUnknown: false, alertsFirst: [], computedAt: TODAY };
  expect(energyAlertGate(clear, 'Appartement de 45 m²')).toEqual({ ok: true });
});

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  let clock = Date.parse(`${TODAY}T08:00:00.000Z`);
  const now = (): Date => new Date((clock += 1000));
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', '2026-01-01T00:00:00.000Z')");
  const sheet = async (id: string, data: unknown) => {
    await db.run(
      "INSERT INTO properties (id, network_id, reference, kind, status, created_at, updated_at) VALUES (?, 'net-1', ?, 'home', 'available', '2027-01-01', '2027-01-01')",
      [id, `REF-${id}`],
    );
    await db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, 'net-1', 1, ?, 'agent:a', '2027-01-01')", [
      `s-${id}`,
      id,
      JSON.stringify(data),
    ]);
  };
  const contraintes = new Contraintes(db, journal, { now });
  const direction = { role: 'direction' as const, userId: 'dir-1', networkId: 'net-1' };
  return { db, journal, contraintes, sheet, direction };
}

describeWithSqlite('Y04 · contraintes signalées', () => {
  it('[R124] un bien classé G porte l’alerte en tête pour qui veut louer, et dans les contraintes pour qui ne veut pas', async () => {
    const t = await setup();
    await t.sheet('p-g', { energy: { energyClass: 'G' }, coownership: { isCoownership: false } });
    for (const target of ['unfurnished', 'furnished', 'shared', null] as const) {
      const set = await t.contraintes.forProperty({ networkId: 'net-1', propertyId: 'p-g', inseeCode: null, rentalTarget: target });
      expect(set.rentalBan, String(target)).toBe(true);
      expect(set.alertsFirst[0]!.startsWith(RENTAL_BAN_ALERT)).toBe(true);
      expect(set.constraints[0]).toMatchObject({ kind: 'energie', status: 'interdit', source: 'fiche du bien p-g, version 1' });
    }
    const none = await t.contraintes.forProperty({ networkId: 'net-1', propertyId: 'p-g', inseeCode: null, rentalTarget: 'none' });
    expect(none.rentalBan).toBe(false);
    expect(none.alertsFirst).toEqual([]);
    expect(none.constraints[0]).toMatchObject({ status: 'interdit' });
    // La classe de la fiche l'emporte sur ce que l'agent dirait.
    const said = await t.contraintes.forProperty({ networkId: 'net-1', propertyId: 'p-g', inseeCode: null, energyClass: 'C', rentalTarget: 'furnished' });
    expect(said.rentalBan).toBe(true);
  });

  it('une classe inconnue est à vérifier en tête ; la copropriété est lue dans la fiche du bien', async () => {
    const t = await setup();
    await t.sheet('p-x', { energy: null, coownership: { isCoownership: true, lots: 24, annualChargesEur: 1800, proceedings: true } });
    const set = await t.contraintes.forProperty({ networkId: 'net-1', propertyId: 'p-x', inseeCode: null, rentalTarget: 'unfurnished' });
    expect(set.energyUnknown).toBe(true);
    expect(set.alertsFirst).toEqual(['Classe énergie inconnue : à vérifier avant toute proposition de location.']);
    expect(set.constraints[1]).toEqual({
      kind: 'copropriete',
      lots: 24,
      annualChargesEur: 1800,
      proceedings: true,
      text: 'Copropriété de 24 lots, 1800 € de charges par an, procédure en cours.',
      source: 'fiche du bien p-x, version 1',
    });
    // Classe dite par l'agent, avec sa source, quand la fiche n'en a pas.
    const told = await t.contraintes.forProperty({ networkId: 'net-1', propertyId: 'p-x', inseeCode: null, energyClass: 'E', energySource: 'agent:a-1, DPE vu', rentalTarget: 'unfurnished' });
    expect(told.constraints[0]).toMatchObject({ status: 'echeance', bannedFrom: '2034-01-01', source: 'agent:a-1, DPE vu' });
    expect(told.alertsFirst).toEqual([]);
    // Sans classe, au-delà du seuil : interdit, alerte en tête ; une consommation non entière n'est jamais jetée.
    const over = await t.contraintes.forProperty({ networkId: 'net-1', propertyId: 'p-x', inseeCode: null, finalEnergyKwh: 520, energySource: 'agent:a-1', rentalTarget: 'furnished' });
    expect(over.rentalBan).toBe(true);
    expect(over.alertsFirst[0]!.startsWith('Interdit à la location')).toBe(true);
    const half = await t.contraintes.forProperty({ networkId: 'net-1', propertyId: 'p-x', inseeCode: null, energyClass: 'F', finalEnergyKwh: 450.5, rentalTarget: 'furnished' });
    expect(half.constraints[0]).toMatchObject({ status: 'interdit', finalEnergyKwh: 451 });
    await expect(t.contraintes.forProperty({ networkId: 'net-1', propertyId: 'p-x', inseeCode: null, energyClass: 'F', finalEnergyKwh: -3, rentalTarget: 'furnished' })).rejects.toThrow(/impossible/);
  });

  it('une règle de commune est rangée par la direction avec sa source et sa date ; sans source, refusée', async () => {
    const t = await setup();
    const base = { inseeCode: '99001', rule: 'autorisation_prealable', effectiveFrom: '2026-01-01', source: 'Délibération du conseil municipal (exemple inventé)', sourceDate: '2025-10-01' };
    expect(await t.contraintes.recordCommuneRule(t.direction, { ...base, source: '' })).toEqual({ ok: false, rule: 'R124', code: 'source' });
    expect(await t.contraintes.recordCommuneRule(t.direction, { ...base, source: undefined })).toMatchObject({ ok: false, code: 'source' });
    expect(await t.contraintes.recordCommuneRule(t.direction, { ...base, sourceDate: 'hier' })).toMatchObject({ ok: false, code: 'date_source' });
    expect(await t.contraintes.recordCommuneRule(t.direction, { ...base, rule: 'quota' })).toMatchObject({ ok: false, code: 'regle' });
    expect(await t.contraintes.recordCommuneRule(t.direction, { ...base, inseeCode: 'Dijon' })).toMatchObject({ ok: false, code: 'insee' });
    expect(await t.contraintes.recordCommuneRule({ role: 'agent', userId: 'a-1', networkId: 'net-1' }, base)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM commune_rental_rules'))!.n)).toBe(0);
    await expect(
      t.db.run("INSERT INTO commune_rental_rules (id, network_id, insee_code, rule, effective_from, source, source_date, recorded_by, recorded_at) VALUES ('r', 'net-1', '99001', 'encadrement_loyers', '2026-01-01', ' ', '2026-01-01', 'x', 'y')"),
    ).rejects.toThrow();

    expect(await t.contraintes.recordCommuneRule(t.direction, base)).toMatchObject({ ok: true });
    expect(await t.contraintes.recordCommuneRule(t.direction, { ...base, rule: 'encadrement_loyers', effectiveFrom: '2028-01-01' })).toMatchObject({ ok: true });
    const set = await t.contraintes.forProperty({ networkId: 'net-1', propertyId: null, inseeCode: '99001', energyClass: 'C', rentalTarget: 'furnished' });
    // La règle à venir n'est pas encore en vigueur.
    expect(set.constraints.filter((c) => c.kind === 'commune')).toEqual([
      {
        kind: 'commune',
        rule: 'autorisation_prealable',
        inseeCode: '99001',
        effectiveFrom: '2026-01-01',
        text: 'Autorisation préalable de mise en location (permis de louer) dans la commune depuis le 01/01/2026.',
        source: 'Délibération du conseil municipal (exemple inventé), 01/10/2025',
      },
    ]);
    // Une fin rangée ensuite l'emporte : la règle plus récente de la même sorte compte, l'ancienne reste.
    expect(await t.contraintes.recordCommuneRule(t.direction, { ...base, effectiveUntil: '2027-06-30' })).toMatchObject({ ok: true });
    const later = await t.contraintes.forProperty({ networkId: 'net-1', propertyId: null, inseeCode: '99001', energyClass: 'C', rentalTarget: 'furnished' });
    expect(later.constraints.filter((c) => c.kind === 'commune')).toEqual([]);
    // Un renouvellement rangé pour plus tard ne cache pas la règle d'aujourd'hui.
    expect(await t.contraintes.recordCommuneRule(t.direction, { ...base, inseeCode: '99002', effectiveFrom: '2026-01-01' })).toMatchObject({ ok: true });
    expect(await t.contraintes.recordCommuneRule(t.direction, { ...base, inseeCode: '99002', effectiveFrom: '2029-01-01' })).toMatchObject({ ok: true });
    const renewed = await t.contraintes.forProperty({ networkId: 'net-1', propertyId: null, inseeCode: '99002', energyClass: 'C', rentalTarget: 'furnished' });
    expect(renewed.constraints.filter((c) => c.kind === 'commune')).toMatchObject([{ rule: 'autorisation_prealable', effectiveFrom: '2026-01-01' }]);
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM commune_rental_rules'))!.n)).toBe(5);
    await expect(t.db.run('DELETE FROM commune_rental_rules')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE commune_rental_rules SET source = 'x'")).rejects.toThrow(/ne change plus/);
    const refused = (await t.journal.all()).filter((e) => e.type === 'investir.regle.refuse');
    expect(refused.map((e) => (e.data as { code: string }).code)).toEqual(['source', 'source', 'date_source', 'regle', 'insee']);
  });
});

it('[R124] AU098b · un G ultramarin porte l’échéance de 2028, sans le seuil métropolitain des 450 kWh', () => {
  const g = energyConstraint('G', 460, '2027-09-14', 'fiche', 'outre_mer');
  expect(g).toMatchObject({ status: 'echeance', bannedFrom: '2028-01-01' });
  expect(energyConstraint('G', 460, '2027-09-14', 'fiche')).toMatchObject({ status: 'interdit' });
  expect(energyConstraint('E', null, '2027-09-14', 'fiche', 'outre_mer')).toMatchObject({ bannedFrom: null });
});
