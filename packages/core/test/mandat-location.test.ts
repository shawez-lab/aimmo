import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, Modeles, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { Diffusion } from '../src/documents/index.ts';
import { HonorairesLocation, MisesEnLocation, rentalMandateGate, rentalMandateInForce } from '../src/location/index.ts';
import { designerTout } from './designation-jeu.ts';
import { signRentalMandate } from './mandat-location-jeu.ts';
import { loadMigrations, withMigrationsBefore } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// AU014 · Modèle, réseau, bailleur et logement inventés : ce n'est pas un modèle juridique.
const BODY = [
  'MANDAT DE LOCATION (MODÈLE DE TEST)',
  'Entre {{mandant.nom}}, bailleur, domicilié {{mandant.domicile}}, et {{reseau.nom}}, représenté par {{agent.nom}}.',
  'Logement : {{bien.type}} référence {{bien.reference}}, {{bien.adresse}}, {{bien.cadastre}}.',
  'Honoraires du bailleur : {{honoraires.montant}}. Durée : {{mandat.duree_mois}}.',
  'Numéro au registre : {{registre.numero}}. Fait le {{document.date}}.',
].join('\n\n');
const NOW = new Date('2027-02-10T10:00:00.000Z');

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = () => NOW;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bailleur', lastName: 'Inventé' });
  const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-AU014', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 42, rooms: 2 });
  const listings = new MisesEnLocation(db, { has: async () => true }, journal, { now });
  const fees = new HonorairesLocation(db, listings, journal, { now });
  const diffusion = new Diffusion(db, acces, journal, { now });
  return { db, journal, modeles, network, alex, as, owner, home, listings, fees, diffusion, now, direction: as('direction', 'direction-1'), agent: as('agent', alex.id) };
}

const FEES = { tenantCents: 30_000, tenantInventoryCents: 9_000, landlordCents: 30_000, landlordInventoryCents: 9_000, depositCents: 60_000 };

describeWithSqlite('AU014 · la location sous mandat de location signé et inscrit', () => {
  it('[R40] le modèle « mandat de location » : numéro au registre et désignation exigés ; la charge des honoraires ne s’y choisit pas', async () => {
    const t = await setup();
    expect(await t.modeles.createVersion(t.direction, 'mandat_location', BODY.replace('{{registre.numero}}', ''))).toMatchObject({ ok: false, code: 'no_number_field' });
    expect(await t.modeles.createVersion(t.direction, 'mandat_location', BODY.replace(', {{bien.cadastre}}', ''))).toMatchObject({ ok: false, code: 'no_designation_field' });
    const v = await t.modeles.createVersion(t.direction, 'mandat_location', BODY);
    expect(v).toMatchObject({ ok: true, template: { kind: 'mandat_location', version: 1, status: 'essai' } });
    await designerTout(t.db);
    const doc = await t.modeles.generate(t.agent, { kind: 'mandat_location', personId: t.owner.id, propertyId: t.home.id, inputs: { 'honoraires.montant': 400, 'mandat.duree_mois': 36 } });
    expect(doc).toMatchObject({ ok: true, document: { kind: 'mandat_location', status: 'complet', mode: 'essai' } });
    expect(doc.ok && doc.document.content).toContain('Mandat de location · L-AU014');
    expect(await t.modeles.generate(t.agent, { kind: 'mandat_location', personId: t.owner.id, propertyId: t.home.id, inputs: { 'honoraires.montant': 400, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 36 } })).toMatchObject({ ok: false, code: 'bad_input' });
  });

  it('[R42] [R100] constat puis correction : sans mandat de location en cours, aucun barème ne se range ; un mandat de vente n’ouvre pas la location', async () => {
    const t = await setup();
    const c = await t.listings.create(t.agent, { propertyId: t.home.id, ownerPersonId: t.owner.id });
    if (!c.ok) throw new Error(c.code);
    const gate = rentalMandateGate(t.db, t.journal, t.now);
    expect(await rentalMandateInForce(gate, t.network.id, t.home.id, NOW)).toBe(false);
    expect(await t.fees.record(t.agent, c.value.listingId, FEES)).toEqual({ ok: false, rule: 'R100', code: 'no_rental_mandate' });
    // Un mandat de vente signé et inscrit sur le même logement : la vente s'ouvre, la location reste fermée.
    await signRentalMandate(t.db, { networkId: t.network.id, agentId: t.alex.id, personId: t.owner.id, propertyId: t.home.id, kind: 'mandat_vente_simple' });
    expect((await t.diffusion.canDiffuse(t.network.id, t.home.id, NOW)).allowed).toBe(true);
    expect((await t.diffusion.canDiffuse(t.network.id, t.home.id, NOW, 'location')).allowed).toBe(false);
    expect(await t.fees.record(t.agent, c.value.listingId, FEES)).toMatchObject({ ok: false, code: 'no_rental_mandate' });
    // Le mandat de location signé et inscrit ouvre la location, sans rien ouvrir pour la vente d'un autre bien.
    const m = await signRentalMandate(t.db, { networkId: t.network.id, agentId: t.alex.id, personId: t.owner.id, propertyId: t.home.id });
    expect(await t.diffusion.canDiffuse(t.network.id, t.home.id, NOW, 'location')).toMatchObject({ allowed: true, mandateId: m });
    expect([...(await t.diffusion.diffusableProperties(t.network.id, NOW, 'location'))]).toEqual([t.home.id]);
    const refusals = (await t.journal.all()).filter((e) => e.type === 'location.bareme_refuse').map((e) => e.data.problems);
    expect(refusals).toEqual([['no_rental_mandate'], ['no_rental_mandate']]);
  });

  it('[R42] un mandat de location échu, annulé ou rétracté referme la location', async () => {
    const t = await setup();
    // Signé il y a plus de 12 mois pour 12 mois : échu.
    await signRentalMandate(t.db, { networkId: t.network.id, agentId: t.alex.id, personId: t.owner.id, propertyId: t.home.id, signedAt: '2025-06-01T09:00:00.000Z', months: 12 });
    expect(await t.diffusion.canDiffuse(t.network.id, t.home.id, NOW, 'location')).toMatchObject({ allowed: false, reason: 'expired' });
    const m = await signRentalMandate(t.db, { networkId: t.network.id, agentId: t.alex.id, personId: t.owner.id, propertyId: t.home.id });
    await t.db.run("INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES (?, ?, 'courrier test', '2026-01-06T09:00:00.000Z', 'a', '2026-01-06T09:00:00.000Z')", [m, t.network.id]);
    expect((await t.diffusion.canDiffuse(t.network.id, t.home.id, NOW, 'location')).allowed).toBe(false);
  });

  it('[R17] les modèles existants gardent tout et deviennent d’objet « vente » ; l’objet ne change jamais, et seul un mandat simple peut être de location', async () => {
    const t = await withMigrationsBefore('4113', async () => {
      const t = await setup();
      // Avant : un modèle de vente rangé, et aucune place pour un modèle de location.
      const fields = JSON.stringify(['mandant.nom', 'registre.numero']);
      await t.db.run("INSERT INTO document_templates (id, network_id, kind, version, status, body, fields, hash, created_by, created_at) VALUES ('tpl-vente', ?, 'mandat_vente_simple', 1, 'essai', ?, ?, 'h', 'direction:direction-1', '2027-01-01T00:00:00.000Z')", [t.network.id, BODY, fields]);
      await expect(t.db.run("INSERT INTO document_templates (id, network_id, kind, version, status, body, fields, hash, created_by, created_at) VALUES ('tpl-loc', ?, 'mandat_location', 1, 'essai', 'b', '[]', 'h', 'd', 'a')", [t.network.id])).rejects.toThrow(/CHECK/);
      return t;
    });
    const before = await t.db.all('SELECT id, kind, version, status, body, fields, hash FROM document_templates ORDER BY id');
    expect((await applyMigrations(t.db, loadMigrations()))[0]).toBe('4113_mandat_location');
    expect(await t.db.all('SELECT id, kind, version, status, body, fields, hash FROM document_templates ORDER BY id')).toEqual(before);
    expect(await t.db.all('SELECT purpose FROM document_templates')).toEqual([{ purpose: 'vente' }]);
    // Après : le modèle de location se range, à la suite des versions du mandat simple, et se relit comme tel.
    const loc = await t.modeles.createVersion(t.direction, 'mandat_location', BODY);
    expect(loc).toMatchObject({ ok: true, template: { kind: 'mandat_location', version: 2 } });
    const listed = await t.modeles.list(t.direction);
    expect(listed.ok && listed.templates.map((x) => [x.kind, x.version])).toEqual(expect.arrayContaining([['mandat_vente_simple', 1], ['mandat_location', 2]]));
    await expect(t.db.run("UPDATE document_templates SET purpose = 'vente' WHERE purpose = 'location'")).rejects.toThrow();
    await expect(t.db.run("INSERT INTO document_templates (id, network_id, kind, version, status, body, fields, hash, created_by, created_at, purpose) VALUES ('x', ?, 'mandat_vente_exclusif', 9, 'essai', 'b', '[]', 'h', 't', 'a', 'location')", [t.network.id])).rejects.toThrow();
    // Un mandat simple de vente se fait toujours sur son propre modèle, jamais sur celui de la location, et l'inverse.
    await designerTout(t.db);
    const sale = await t.modeles.generate(t.agent, { kind: 'mandat_vente_simple', personId: t.owner.id, propertyId: t.home.id });
    expect(sale.ok && [sale.document.kind, sale.document.templateVersion]).toEqual(['mandat_vente_simple', 1]);
    const rent = await t.modeles.generate(t.agent, { kind: 'mandat_location', personId: t.owner.id, propertyId: t.home.id, inputs: { 'honoraires.montant': 400, 'mandat.duree_mois': 36 } });
    expect(rent.ok && [rent.document.kind, rent.document.templateVersion]).toEqual(['mandat_location', 2]);
  });
});
