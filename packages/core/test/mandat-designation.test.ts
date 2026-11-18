import { expect, it } from 'vitest';
import {
  Acces,
  ControlesSignature,
  Designations,
  FicheClient,
  FicheUnique,
  Modeles,
  RegistreMandats,
  SignaturePapier,
  SqlJournalStore,
  TEMPLATE_FIELDS,
  applyMigrations,
  canSignForReal,
  formatParcels,
  fromSyncSqlite,
  readAddress,
  readParcels,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { DESIGNATION } from './designation-jeu.ts';

// AU002 · La désignation du bien et le domicile du mandant, en champs. Adresses, parcelles et personnes inventées.
const OLD_BODY = 'Mandat de test : {{mandant.nom}}, {{bien.reference}}, honoraires {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}}.';
const BODY = OLD_BODY + DESIGNATION;
const T0 = Date.parse('2027-02-10T10:00:00.000Z');
const INPUTS = { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } as const;
const ADDRESS = { street: '12 rue des Essais', postalCode: '21000', city: 'Dijon' };
const PARCELS = [{ section: 'ab', number: '0123' }, { prefix: '012', section: 'C', number: '45' }];

async function setup(body = BODY, validated = true) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = () => new Date(T0);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, unique, journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const designations = new Designations(db, acces, journal, { now });
  const controles = new ControlesSignature(db, acces, journal, { now });
  const papier = new SignaturePapier(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const agent: Viewer = { role: 'agent', userId: alex.id, networkId: network.id };
  const other: Viewer = { role: 'agent', userId: sam.id, networkId: network.id };
  const direction: Viewer = { role: 'direction', userId: 'direction-1', networkId: network.id };
  // Un modèle d'avant AU002 se rangeait sans la désignation : il est écrit tel quel, comme il dort dans la base.
  let templateId: string;
  if (body.includes('{{bien.adresse}}')) {
    const v = await modeles.createVersion(direction, 'mandat_vente_simple', body);
    if (!v.ok) throw new Error(v.code);
    templateId = v.template.id;
  } else {
    templateId = 'modele-ancien';
    await db.run(
      `INSERT INTO document_templates (id, network_id, kind, version, status, body, fields, hash, created_by, created_at) VALUES (?, ?, 'mandat_vente_simple', 1, 'essai', ?, ?, ?, 'direction:d', ?)`,
      [templateId, network.id, body, JSON.stringify([...body.matchAll(/\{\{\s*([a-z_.]+)\s*\}\}/g)].map((m) => m[1]).filter((f, i, a) => a.indexOf(f) === i)), 'a'.repeat(64), new Date(T0).toISOString()],
    );
  }
  if (validated) await modeles.validate({ role: 'compliance', userId: 'c-1', networkId: network.id }, templateId);
  await controles.setFeeSchedule(direction, { maxRatePercent: 5, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-D-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 90, rooms: 4, priceEur: 250000 });
  const owner = async (firstName: string, lastName: string) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName, lastName });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
    await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: property.id, role: 'owned' });
    return p.id;
  };
  const identify = (personId: string) => identiteAuCoffre({ db, acces, journal, now }, agent, personId, { piece: 'carte_identite', seenAt: new Date(T0) });
  const generate = (personId: string, coMandantIds?: string[]) =>
    modeles.generate(agent, { kind: 'mandat_vente_simple', personId, propertyId: property.id, inputs: INPUTS as never, ...(coMandantIds ? { coMandantIds } : {}) });
  return { db, journal, store, unique, modeles, designations, controles, papier, network, alex, agent, other, direction, property, owner, identify, generate };
}

describeWithSqlite('AU002 · le mandat reprend en champs l’adresse du bien, son cadastre et le domicile du mandant', () => {
  it('[R40] constat de l’audit : le catalogue des champs a désormais l’adresse, le cadastre et le domicile, repris de la base', () => {
    expect(TEMPLATE_FIELDS['bien.adresse']).toEqual({ source: 'base', label: 'adresse du bien' });
    expect(TEMPLATE_FIELDS['bien.cadastre']).toEqual({ source: 'base', label: 'désignation cadastrale du bien' });
    expect(TEMPLATE_FIELDS['mandant.domicile']).toEqual({ source: 'base', label: 'domicile du mandant' });
  });

  it('[R40] un nouveau modèle de mandat de vente sans place pour la désignation est refusé ; l’avenant n’y est pas tenu', async () => {
    const t = await setup();
    expect(await t.modeles.createVersion(t.direction, 'mandat_vente_simple', OLD_BODY)).toEqual({ ok: false, rule: 'R40', code: 'no_designation_field' });
    expect(await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', `${OLD_BODY}\n\n!! Exclusivité de test.\n\nBien {{bien.adresse}}, {{bien.cadastre}}.`)).toEqual({ ok: false, rule: 'R40', code: 'no_designation_field' });
    expect(await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', `${BODY}\n\n!! Exclusivité de test.`)).toMatchObject({ ok: true });
    expect(await t.modeles.createVersion(t.direction, 'avenant_mandat', 'Avenant au mandat {{mandat.numero}} : {{avenant.objet}}.')).toMatchObject({ ok: true });
  });

  it('[R40] sans adresse, sans parcelle ou sans domicile, le mandat est incomplet et ne se signe pas en réel', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    await t.identify(lea);
    const none = await t.generate(lea);
    if (!none.ok) throw new Error(none.code);
    expect(none.document).toMatchObject({ mode: 'reel', status: 'incomplet', missing: ['bien.adresse', 'bien.cadastre', 'mandant.domicile'] });
    expect(none.document.content).toContain('[à compléter : adresse du bien]');
    expect(none.document.content).toContain('[à compléter : désignation cadastrale du bien]');
    expect(none.document.content).toContain('[à compléter : domicile du mandant]');
    expect(canSignForReal(none.document)).toBe(false);
    const check = await t.controles.check(t.agent, none.document.id);
    expect(check.ok && check.value.lines.find((l) => l.check === 'champs')).toEqual({ check: 'champs', ok: false, code: 'missing_fields' });
    expect(await t.papier.register(t.agent, none.document.id, { signedAt: new Date(T0), place: 'agence', scanRef: 'scans/2027/02/test-d.pdf', source: 'referral' })).toMatchObject({ ok: false });

    expect(await t.designations.setProperty(t.agent, t.property.id, { address: ADDRESS, parcels: PARCELS })).toMatchObject({ ok: true });
    const half = await t.generate(lea);
    expect(half.ok && half.document).toMatchObject({ status: 'incomplet', missing: ['mandant.domicile'] });
  });

  it('[R40] tout rempli : l’exemplaire signé porte l’adresse, chaque parcelle et le domicile, tels que saisis', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    await t.identify(lea);
    expect(await t.designations.setProperty(t.agent, t.property.id, { address: ADDRESS, parcels: PARCELS })).toMatchObject({ ok: true });
    expect(await t.designations.setDomicile(t.agent, lea, { street: '3 place du Test', postalCode: '21121', city: 'Fontaine-lès-Dijon' })).toMatchObject({ ok: true });
    const d = await t.generate(lea);
    if (!d.ok) throw new Error(d.code);
    expect(d.document).toMatchObject({ mode: 'reel', status: 'complet', missing: [] });
    expect(d.document.content).toContain('Bien situé 12 rue des Essais, 21000 Dijon, cadastré section AB n° 123 ; préfixe 012, section C n° 45. Mandant domicilié 3 place du Test, 21121 Fontaine-lès-Dijon.');
    expect(await t.controles.check(t.agent, d.document.id)).toMatchObject({ ok: true, value: { passed: true } });
    expect(await t.papier.register(t.agent, d.document.id, { signedAt: new Date(T0), place: 'agence', scanRef: 'scans/2027/02/test-d.pdf', source: 'referral' })).toMatchObject({ ok: true });
    const copy = await t.papier.copy(t.agent, d.document.id);
    if (!copy.ok) throw new Error(copy.code);
    expect(copy.content).toContain('12 rue des Essais, 21000 Dijon');
    expect(copy.content).toContain('section AB n° 123 ; préfixe 012, section C n° 45');
    expect(copy.content).toContain('3 place du Test, 21121 Fontaine-lès-Dijon');
    // Une saisie plus récente vaut pour le mandat suivant ; l'exemplaire signé ne change pas, au caractère près.
    await t.designations.setDomicile(t.agent, lea, { street: '9 rue Nouvelle', postalCode: '21000', city: 'Dijon' });
    expect(((await t.papier.copy(t.agent, d.document.id)) as { content: string }).content).toBe(copy.content);
    const next = await t.generate(lea);
    expect(next.ok && next.document.content).toContain('Mandant domicilié 9 rue Nouvelle, 21000 Dijon.');
    // [R13] Au journal, ni adresse, ni parcelle.
    const journal = JSON.stringify(await t.db.all('SELECT * FROM journal'));
    expect(journal).not.toContain('Essais');
    expect(journal).not.toContain('Nouvelle');
    expect(journal).not.toContain('"AB"');
    // Rien ne s'efface ni ne se réécrit.
    await expect(t.db.run('DELETE FROM person_domiciles')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run(`UPDATE property_designations SET city = 'Beaune'`)).rejects.toThrow(/ne se réécrit pas/);
  });

  it('[R40, R41] deux mandants : chacun nommé avec son propre domicile ; celui de l’un qui manque rend le mandat incomplet', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const noe = await t.owner('Noé', 'Autre');
    await t.designations.setProperty(t.agent, t.property.id, { address: ADDRESS, parcels: PARCELS });
    await t.designations.setDomicile(t.agent, lea, ADDRESS);
    const one = await t.generate(lea, [noe]);
    expect(one.ok && one.document).toMatchObject({ status: 'incomplet', missing: ['mandant.domicile'] });
    await t.designations.setDomicile(t.agent, noe, { street: '1 Hauptstrasse', postalCode: '10115', city: 'Berlin', country: 'Allemagne' });
    const both = await t.generate(lea, [noe]);
    if (!both.ok) throw new Error(both.code);
    expect(both.document.status).toBe('complet');
    expect(both.document.content).toContain('Mandant domicilié Léa Exemple : 12 rue des Essais, 21000 Dijon ; Noé Autre : 1 Hauptstrasse, 10115 Berlin, Allemagne.');
  });

  it('[R40] un modèle d’avant AU002, même validé, ne donne qu’un mandat incomplet : la désignation y manque', async () => {
    const t = await setup(OLD_BODY);
    const lea = await t.owner('Léa', 'Exemple');
    await t.designations.setProperty(t.agent, t.property.id, { address: ADDRESS, parcels: PARCELS });
    await t.designations.setDomicile(t.agent, lea, ADDRESS);
    const d = await t.generate(lea);
    if (!d.ok) throw new Error(d.code);
    expect(d.document).toMatchObject({ mode: 'reel', status: 'incomplet', missing: ['bien.adresse', 'bien.cadastre', 'mandant.domicile'] });
    expect(canSignForReal(d.document)).toBe(false);
  });

  it('[R16] seuls l’agent du bien ou de la fiche et la direction saisissent ; une saisie mal formée est refusée', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    expect(await t.designations.setProperty(t.other, t.property.id, { address: ADDRESS, parcels: PARCELS })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.designations.setDomicile(t.other, lea, ADDRESS)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.designations.setDomicile({ role: 'compliance', userId: 'c-1', networkId: t.network.id }, lea, ADDRESS)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.designations.setProperty(t.direction, t.property.id, { address: ADDRESS, parcels: PARCELS })).toMatchObject({ ok: true });
    expect(await t.designations.setProperty(t.agent, t.property.id, { address: { ...ADDRESS, postalCode: '2100' }, parcels: PARCELS })).toEqual({ ok: false, rule: null, code: 'bad_address' });
    expect(await t.designations.setProperty(t.agent, t.property.id, { address: ADDRESS, parcels: [] })).toEqual({ ok: false, rule: null, code: 'bad_parcels' });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM person_domiciles')).toEqual({ n: 0 });
  });

  it('les champs saisis sont vérifiés : code postal, section, numéro, doublon, texte de balise', () => {
    expect(readAddress({ street: '  12   rue des Essais ', postalCode: '21000', city: 'Dijon' })).toEqual({ street: '12 rue des Essais', postalCode: '21000', city: 'Dijon' });
    expect(readAddress({ street: '12 rue <b>', postalCode: '21000', city: 'Dijon' })).toBeNull();
    expect(readAddress({ street: '12 rue des Essais', postalCode: '21000', city: 'Dijon', country: 'Belgique' })).toBeNull();
    expect(readAddress({ street: '1 rue Haute', postalCode: '1000', city: 'Bruxelles', country: 'Belgique' }, { abroad: true })).toEqual({ street: '1 rue Haute', postalCode: '1000', city: 'Bruxelles', country: 'Belgique' });
    expect(readAddress({ street: '1 rue Haute', postalCode: '1000', city: 'Dijon' }, { abroad: true })).toBeNull();
    expect(readAddress({ street: '1 Test Street', postalCode: 'SW1A 1AA', city: 'London', country: 'Royaume-Uni' }, { abroad: true })).toMatchObject({ postalCode: 'SW1A 1AA', country: 'Royaume-Uni' });
    expect(readParcels([{ section: 'ab', number: '0123' }])).toEqual([{ prefix: null, section: 'AB', number: '123' }]);
    expect(readParcels([{ section: '0A', number: 7 }])).toEqual([{ prefix: null, section: '0A', number: '7' }]);
    expect(readParcels([{ section: 'ABC', number: '1' }])).toBeNull();
    expect(readParcels([{ section: 'AB', number: '12345' }])).toBeNull();
    expect(readParcels([{ section: 'AB', number: '0' }])).toBeNull();
    expect(readParcels([{ section: 'AB', number: '1' }, { section: 'ab', number: '01' }])).toBeNull();
    expect(readParcels([{ section: 'AB', number: '1', prefix: '12' }])).toBeNull();
    expect(formatParcels([{ prefix: null, section: 'AB', number: '1' }])).toBe('section AB n° 1');
  });
});
