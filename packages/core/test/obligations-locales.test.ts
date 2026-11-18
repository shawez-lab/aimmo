import { expect, it } from 'vitest';
import type { PropertySheet } from '../src/annonces/index.ts';
import { Designations } from '../src/documents/designation.ts';
import { DEFAULT_VALIDITY_MONTHS, LOCAL_SOURCE_MAX_AGE_DAYS, PIECE_LABELS, UNKNOWN_LOCAL, cityKey, expectedPieces, expiredPieces, freshZone, type LocalFacts } from '../src/dossiers/index.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const house: PropertySheet = {
  characteristics: { bedrooms: 3, floor: null, floorsTotal: 2, buildYear: 2008, heating: 'individuel_electrique', outdoor: [], landM2: 500, parkingSpaces: null, elevator: null },
  energy: null,
  coownership: { isCoownership: false },
  risks: null,
  media: [],
};
const SOURCE = { title: 'Arrêté préfectoral inventé', url: 'https://prefecture.example.fr/arretes/1', datedOn: '2021-05-04', readOn: '2027-01-10' };
const known = (patch: Partial<LocalFacts> = {}): LocalFacts => ({
  commune: { postalCode: '21000', city: 'Dijon' },
  termites: { inZone: false, source: SOURCE },
  merule: { inZone: false, source: SOURCE },
  sanitation: 'collectif',
  ...patch,
});
const local = (l: ReturnType<typeof expectedPieces>) => l?.pieces.filter((p) => ['etat_termites', 'information_merule', 'controle_assainissement'].includes(p.piece));

it('[R60] AU011 · constat reproduit : sans rien savoir du lieu, plus aucun dossier « complet » ne laisse termites, mérule et assainissement au notaire', () => {
  // Avant : la liste ne disait rien de ces trois pièces et le dossier pouvait être complet. Maintenant, l'inconnu se dit.
  const unknownPlace = expectedPieces('home', house, 2027);
  expect(local(unknownPlace)).toEqual([]);
  expect(unknownPlace?.unknown).toEqual(expect.arrayContaining(['commune', 'assainissement']));
  // Commune connue, sans lecture d'arrêté : chaque zone est inconnue.
  expect(expectedPieces('home', house, 2027, { ...UNKNOWN_LOCAL, commune: { postalCode: '21000', city: 'Dijon' }, sanitation: 'collectif' })?.unknown).toEqual(['classe_energie', 'zone_termites', 'zone_merule']);
});

it('[R60] AU011 · une zone d’arrêté fait demander la pièce, avec sa source datée ; l’assainissement non collectif fait demander son contrôle', () => {
  const l = expectedPieces('home', house, 2027, known({ termites: { inZone: true, source: SOURCE }, merule: { inZone: true, source: SOURCE }, sanitation: 'non_collectif' }));
  expect(local(l)).toEqual([
    { piece: 'etat_termites', side: 'vendeur', reason: 'zone_termites', source: SOURCE },
    { piece: 'information_merule', side: 'vendeur', reason: 'zone_merule', source: SOURCE },
    { piece: 'controle_assainissement', side: 'vendeur', reason: 'assainissement_non_collectif' },
  ]);
  expect(l?.local).toEqual([{ hazard: 'termites', inZone: true, source: SOURCE }, { hazard: 'merule', inZone: true, source: SOURCE }]);
  // Hors zone et raccordé : rien à demander, mais la lecture qui l'a dit reste visible ; rien d'inconnu côté lieu.
  const out = expectedPieces('home', house, 2027, known());
  expect(local(out)).toEqual([]);
  expect(out?.local.map((r) => r.inZone)).toEqual([false, false]);
  expect(out?.unknown).toEqual(['classe_energie']);
  // Un local commercial : termites et mérule, jamais l'assainissement d'un logement.
  const shop = expectedPieces('commercial', house, 2027, known({ termites: { inZone: true, source: SOURCE }, sanitation: null }));
  expect(local(shop)?.map((p) => p.piece)).toEqual(['etat_termites']);
  expect(shop?.unknown).toEqual([]);
  // Un terrain : rien de tout cela, même sans rien savoir.
  expect(expectedPieces('land', null, 2027)?.unknown).toEqual([]);
  // Mêmes données, même liste.
  expect(expectedPieces('home', house, 2027, known())).toEqual(expectedPieces('home', house, 2027, known()));
});

it('AU011 · une lecture d’arrêté vaut un an, jamais lue dans le futur ; le nom de commune se compare sans accents ni traits d’union', () => {
  const zone = { inZone: true, source: { ...SOURCE, readOn: '2026-01-01' } };
  expect(LOCAL_SOURCE_MAX_AGE_DAYS).toBe(365);
  expect(freshZone(zone, '2027-01-01')).toEqual(zone);
  expect(freshZone(zone, '2027-01-02')).toBeNull();
  expect(freshZone(zone, '2025-12-31')).toBeNull();
  expect(freshZone(null, '2027-01-01')).toBeNull();
  expect(cityKey('Fontaine-lès-Dijon')).toBe(cityKey('FONTAINE LES DIJON'));
  expect(cityKey(" L'Étang-Vergy ")).toBe('l etang vergy');
});

it('[R60] AU011 · l’état termites vaut 6 mois et le contrôle de l’assainissement 3 ans, au jour de l’acte ; chaque pièce a son nom en français', () => {
  expect(DEFAULT_VALIDITY_MONTHS.etat_termites).toBe(6);
  expect(DEFAULT_VALIDITY_MONTHS.controle_assainissement).toBe(36);
  const lines = [
    { piece: 'etat_termites' as const, received: { issuedOn: '2027-01-10' } },
    { piece: 'controle_assainissement' as const, received: { issuedOn: '2024-07-10' } },
    { piece: 'information_merule' as const, received: { issuedOn: '2020-01-01' } },
  ];
  expect(expiredPieces(lines, '2027-07-09')).toEqual([]);
  expect(expiredPieces(lines, '2027-07-10')).toEqual(['etat_termites', 'controle_assainissement']);
  expect(PIECE_LABELS.etat_termites).toMatch(/termites/);
  expect(PIECE_LABELS.controle_assainissement).toMatch(/assainissement non collectif/);
});

describeWithSqlite('AU011 · obligations locales du dossier de vente', () => {
  const input = (patch: Record<string, unknown> = {}) => ({ postalCode: '21000', city: 'Dijon', hazard: 'termites', inZone: true, title: 'Arrêté préfectoral inventé, termites', url: 'https://prefecture.example.fr/arretes/termites-2', datedOn: '2026-06-01', readOn: '2027-03-01', ...patch });

  it('[R60] une maison au lieu inconnu n’est jamais complète ; zone et raccordement rangés, les pièces sont demandées avec leur source, puis le dossier se complète', async () => {
    const t = await setupDossier('maison', {}, { local: false });
    await t.verifyBuyer();
    const first = await t.pieces.status(t.agent, t.fileId);
    if (!first.ok) throw new Error(first.code);
    for (const piece of first.value.missing) await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-02-15' });
    const before = await t.pieces.status(t.agent, t.fileId);
    if (!before.ok) throw new Error(before.code);
    // Le constat : tout est reçu, l'identité vérifiée, et pourtant rien ne dit les termites, la mérule, l'assainissement.
    expect(before.value).toMatchObject({ missing: [], identity: 'verifiee', complete: false, unknown: ['zone_termites', 'zone_merule', 'assainissement'] });
    expect((await t.obligations.recordZone(t.direction, input())).ok).toBe(true);
    expect((await t.obligations.recordZone(t.direction, input({ hazard: 'merule', inZone: false, title: 'Arrêté préfectoral inventé, mérule', url: 'https://prefecture.example.fr/arretes/merule' }))).ok).toBe(true);
    expect((await t.obligations.recordSanitation(t.agent, t.propertyId, 'non_collectif')).ok).toBe(true);
    const after = await t.pieces.status(t.agent, t.fileId);
    if (!after.ok) throw new Error(after.code);
    expect(after.value).toMatchObject({ unknown: [], missing: ['etat_termites', 'controle_assainissement'], complete: false });
    expect(after.value.lines.find((l) => l.piece === 'etat_termites')?.source).toEqual({ title: 'Arrêté préfectoral inventé, termites', url: 'https://prefecture.example.fr/arretes/termites-2', datedOn: '2026-06-01', readOn: '2027-03-01' });
    expect(after.value.local.map((r) => `${r.hazard}:${r.inZone}`)).toEqual(['termites:true', 'merule:false']);
    for (const piece of after.value.missing) expect((await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-02-20' })).ok).toBe(true);
    const done = await t.pieces.status(t.agent, t.fileId);
    expect(done.ok && done.value.complete).toBe(true);
    // Un an et un jour après la lecture, la zone redevient inconnue : le dossier n'est plus dit complet.
    t.setClock(new Date('2028-03-02T12:00:00.000Z'));
    const stale = await t.pieces.status(t.agent, t.fileId);
    expect(stale.ok && stale.value).toMatchObject({ complete: false, unknown: ['zone_termites', 'zone_merule'] });
  });

  it('[R60] la commune est celle de la désignation du bien : une lecture d’une autre commune ne vaut pas pour lui', async () => {
    const t = await setupDossier('maison');
    const ok = await t.pieces.status(t.agent, t.fileId);
    expect(ok.ok && ok.value.unknown).toEqual([]);
    const moved = await new Designations(t.db, t.acces, t.journal, { now: t.now }).setProperty(t.agent, t.propertyId, { address: { street: '3 rue Inventée', postalCode: '21121', city: 'Fontaine-lès-Dijon' }, parcels: [{ prefix: null, section: 'AB', number: '12' }] });
    expect(moved.ok).toBe(true);
    const s = await t.pieces.status(t.agent, t.fileId);
    expect(s.ok && s.value.unknown).toEqual(['zone_termites', 'zone_merule']);
    // Le nom saisi autrement (casse, accents, trait d'union) désigne la même commune.
    for (const hazard of ['termites', 'merule']) expect((await t.obligations.recordZone(t.direction, input({ postalCode: '21121', city: 'FONTAINE LES DIJON', hazard, inZone: false }))).ok).toBe(true);
    const s2 = await t.pieces.status(t.agent, t.fileId);
    expect(s2.ok && s2.value.unknown).toEqual([]);
  });

  it('[R17] la lecture la plus récente vaut, l’ancienne reste ; rien ne se réécrit ni ne s’efface', async () => {
    const t = await setupDossier('maison');
    expect((await t.obligations.recordZone(t.direction, input())).ok).toBe(true);
    const s = await t.pieces.status(t.agent, t.fileId);
    expect(s.ok && s.value.missing).toEqual(['titre_propriete', 'fiche_renseignements_vendeur', 'etat_risques', 'dpe', 'electricite', 'gaz', 'etat_termites', 'fiche_renseignements_acquereur']);
    const rows = await t.db.all<{ version: number; in_zone: number }>("SELECT version, in_zone FROM local_hazard_orders WHERE hazard = 'termites' ORDER BY version");
    expect(rows.map((r) => [Number(r.version), Number(r.in_zone)])).toEqual([[1, 0], [2, 1]]);
    await expect(t.db.run("UPDATE local_hazard_orders SET in_zone = 0")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM local_hazard_orders')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE property_sanitation SET mode = 'non_collectif'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM property_sanitation')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R16] seule la direction range une zone ; seuls l’agent du bien et la direction déclarent le raccordement ; chaque refus au journal', async () => {
    const t = await setupDossier('maison', {}, { local: false });
    expect(await t.obligations.recordZone(t.agent, input())).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const compliance = { role: 'compliance' as const, networkId: t.network.id, userId: 'conformite-1' };
    expect((await t.obligations.recordZone(compliance, input())).ok).toBe(false);
    expect((await t.obligations.recordSanitation(t.sam, t.propertyId, 'collectif')).ok).toBe(false);
    expect((await t.obligations.recordSanitation(compliance, t.propertyId, 'collectif')).ok).toBe(false);
    expect((await t.obligations.recordSanitation(t.direction, t.propertyId, 'collectif')).ok).toBe(true);
    const refused = [...(await t.journal.bySubject(`network:${t.network.id}`)), ...(await t.journal.bySubject(`property:${t.propertyId}`))].filter((e) => e.type === 'acces.refuse');
    expect(refused.length).toBeGreaterThanOrEqual(3);
    expect(await t.db.first('SELECT 1 FROM local_hazard_orders')).toBeNull();
  });

  it('une saisie fautive est refusée sans rien ranger : commune, risque, lien, dates', async () => {
    const t = await setupDossier('maison', {}, { local: false });
    expect(await t.obligations.recordZone(t.direction, input({ postalCode: '2100' }))).toMatchObject({ code: 'bad_commune' });
    expect(await t.obligations.recordZone(t.direction, input({ city: '<b>' }))).toMatchObject({ code: 'bad_commune' });
    expect(await t.obligations.recordZone(t.direction, input({ hazard: 'radon' }))).toMatchObject({ code: 'bad_hazard' });
    expect(await t.obligations.recordZone(t.direction, input({ url: 'http://prefecture.example.fr/a' }))).toMatchObject({ code: 'bad_source' });
    expect(await t.obligations.recordZone(t.direction, input({ inZone: 'oui' }))).toMatchObject({ code: 'bad_source' });
    expect(await t.obligations.recordZone(t.direction, input({ readOn: '2027-03-02' }))).toMatchObject({ code: 'bad_date' });
    expect(await t.obligations.recordZone(t.direction, input({ datedOn: '2027-03-01', readOn: '2027-02-28' }))).toMatchObject({ code: 'bad_date' });
    expect(await t.obligations.recordZone(t.direction, input({ datedOn: '2027-02-30' }))).toMatchObject({ code: 'bad_date' });
    expect(await t.obligations.recordSanitation(t.agent, t.propertyId, 'fosse')).toMatchObject({ code: 'bad_mode' });
    expect(await t.obligations.recordSanitation(t.agent, 'bien-inconnu', 'collectif')).toMatchObject({ ok: false });
    expect(await t.db.first('SELECT 1 FROM local_hazard_orders')).toBeNull();
    expect(await t.db.first('SELECT 1 FROM property_sanitation')).toBeNull();
  });

  it('[R13] au journal : le risque et le mode, jamais la commune ni l’adresse', async () => {
    const t = await setupDossier('maison');
    const events = [...(await t.journal.bySubject(`network:${t.network.id}`)), ...(await t.journal.bySubject(`property:${t.propertyId}`))].filter((e) => e.type.startsWith('obligations.'));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['obligations.zone_rangee', 'obligations.assainissement_range']));
    expect(JSON.stringify(events)).not.toMatch(/Dijon|21000|prefecture/);
  });
});
