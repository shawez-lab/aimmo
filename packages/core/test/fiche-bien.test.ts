import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { FicheBien, parseSheet } from '../src/annonces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Biens, agents et réseau inventés.
const TODAY = new Date('2027-03-10T09:00:00.000Z');

const FULL = {
  characteristics: { bedrooms: 2, floor: 3, floorsTotal: 5, buildYear: 1965, heating: 'collectif', outdoor: ['terrasse', 'balcon'], landM2: null, parkingSpaces: 1, elevator: true },
  energy: { energyClass: 'D', climateClass: 'C', annualCostMinEur: 1100, annualCostMaxEur: 1550, costReferenceYear: 2023, diagnosedOn: '2027-01-15' },
  coownership: { isCoownership: true, lots: 24, annualChargesEur: 1800, proceedings: false },
  risks: { inRiskZone: true },
  media: [
    { ref: 'biens/REF-T-1/sejour.jpg', kind: 'photo', edit: 'lumiere_cadrage' },
    { ref: 'biens/REF-T-1/chambre.jpg', kind: 'photo', edit: 'amenagement_virtuel' },
    { ref: 'biens/REF-T-1/visite.mp4', kind: 'video', edit: 'aucune' },
  ],
};

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TODAY;
  const now = () => clock;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 210000 });
  const fiches = new FicheBien(db, acces, journal, { now });
  return { db, journal, fiches, propertyId: b.id, agent: as('agent', alex.id), sam: as('agent', sam.id), direction: as('direction', 'd-1'), compliance: as('compliance', 'c-1'), partner: as('partner', 'p-1'), stranger: as('direction', 'd-2', other.id), setClock: (d: Date) => (clock = d) };
}

it('P01 · une fiche complète est acceptée et rangée dans un ordre fixe', () => {
  const r = parseSheet(FULL, TODAY);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.characteristics.outdoor).toEqual(['balcon', 'terrasse']);
  expect(r.value.energy).toEqual(FULL.energy);
  expect(r.value.coownership).toEqual(FULL.coownership);
  // Une fiche vide est permise : ce qui manque bloquera la publication (P02), pas la saisie.
  expect(parseSheet({}, TODAY)).toMatchObject({ ok: true, value: { energy: null, coownership: null, risks: null, media: [] } });
});

it('P01 · chaque champ est contrôlé et le premier champ fautif est nommé', () => {
  const withEnergy = (patch: Record<string, unknown>) => parseSheet({ ...FULL, energy: { ...FULL.energy, ...patch } }, TODAY);
  expect(withEnergy({ energyClass: 'H' })).toEqual({ ok: false, field: 'energy.energyClass' });
  expect(withEnergy({ climateClass: 'b' })).toEqual({ ok: false, field: 'energy.climateClass' });
  expect(withEnergy({ annualCostMinEur: -5 })).toEqual({ ok: false, field: 'energy.annualCostMinEur' });
  expect(withEnergy({ annualCostMinEur: 0 })).toEqual({ ok: false, field: 'energy.annualCostMinEur' });
  expect(withEnergy({ annualCostMinEur: 2000 })).toEqual({ ok: false, field: 'energy.annualCostMinEur' });
  expect(withEnergy({ annualCostMaxEur: 1550.5 })).toEqual({ ok: false, field: 'energy.annualCostMaxEur' });
  expect(withEnergy({ costReferenceYear: 2028 })).toEqual({ ok: false, field: 'energy.costReferenceYear' });
  // Date du diagnostic : jamais dans le futur, à l'heure de Paris ; jamais une date impossible.
  expect(withEnergy({ diagnosedOn: '2027-03-11' })).toEqual({ ok: false, field: 'energy.diagnosedOn' });
  expect(withEnergy({ diagnosedOn: '2027-02-30' })).toEqual({ ok: false, field: 'energy.diagnosedOn' });
  expect(withEnergy({ diagnosedOn: '2027-03-10' }).ok).toBe(true);
  expect(parseSheet({ ...FULL, energy: { ...FULL.energy, diagnosedOn: '2027-03-11' } }, new Date('2027-03-10T23:30:00.000Z')).ok).toBe(true);
  // Champ inconnu : refusé, jamais ignoré ; aucun texte libre ne peut entrer.
  expect(withEnergy({ commentaire: 'au 12 rue des Essais' })).toEqual({ ok: false, field: 'energy.commentaire' });
  expect(parseSheet({ ...FULL, adresse: '12 rue des Essais' }, TODAY)).toEqual({ ok: false, field: 'adresse' });
  expect(parseSheet({ ...FULL, characteristics: { ...FULL.characteristics, note: 'x' } }, TODAY)).toEqual({ ok: false, field: 'characteristics.note' });
  expect(parseSheet({ ...FULL, characteristics: { ...FULL.characteristics, floor: 6 } }, TODAY)).toEqual({ ok: false, field: 'characteristics.floor' });
  expect(parseSheet({ ...FULL, characteristics: { ...FULL.characteristics, heating: 'cheminée' } }, TODAY)).toEqual({ ok: false, field: 'characteristics.heating' });
  expect(parseSheet({ ...FULL, characteristics: { ...FULL.characteristics, outdoor: ['jardin', 'jardin'] } }, TODAY)).toEqual({ ok: false, field: 'characteristics.outdoor' });
  expect(parseSheet({ ...FULL, characteristics: { ...FULL.characteristics, buildYear: 2028 } }, TODAY)).toEqual({ ok: false, field: 'characteristics.buildYear' });
  expect(parseSheet({ ...FULL, coownership: { isCoownership: true, lots: 0, annualChargesEur: 10, proceedings: false } }, TODAY)).toEqual({ ok: false, field: 'coownership.lots' });
  expect(parseSheet({ ...FULL, coownership: { isCoownership: true, lots: 3, annualChargesEur: 10 } }, TODAY)).toEqual({ ok: false, field: 'coownership.proceedings' });
  expect(parseSheet({ ...FULL, coownership: { isCoownership: false, lots: 3 } }, TODAY)).toEqual({ ok: false, field: 'coownership.lots' });
  expect(parseSheet({ ...FULL, risks: { inRiskZone: 'oui' } }, TODAY)).toEqual({ ok: false, field: 'risks.inRiskZone' });
  expect(parseSheet({ ...FULL, media: [{ ref: '../secret.jpg', kind: 'photo', edit: 'aucune' }] }, TODAY)).toEqual({ ok: false, field: 'media.0.ref' });
  expect(parseSheet({ ...FULL, media: [FULL.media[0], FULL.media[0]] }, TODAY)).toEqual({ ok: false, field: 'media.1.ref' });
  expect(parseSheet({ ...FULL, media: [{ ref: 'v.mp4', kind: 'video', edit: 'amenagement_virtuel' }] }, TODAY)).toEqual({ ok: false, field: 'media.0.edit' });
  expect(parseSheet('fiche', TODAY)).toEqual({ ok: false, field: 'fiche' });
});

describeWithSqlite('P01 · fiche du bien versionnée', () => {
  it('[R17] une modification crée une version, l’ancienne reste lisible et rien ne change ni ne s’efface', async () => {
    const t = await setup();
    const v1 = await t.fiches.save(t.agent, t.propertyId, FULL);
    expect(v1).toMatchObject({ ok: true, value: { version: 1 } });
    t.setClock(new Date('2027-03-11T09:00:00.000Z'));
    const v2 = await t.fiches.save(t.direction, t.propertyId, { ...FULL, risks: { inRiskZone: false } });
    expect(v2).toMatchObject({ ok: true, value: { version: 2, sheet: { risks: { inRiskZone: false } }, createdBy: 'direction:d-1' } });
    expect(await t.fiches.read(t.agent, t.propertyId)).toMatchObject({ ok: true, value: { version: 2 } });
    expect(await t.fiches.read(t.agent, t.propertyId, 1)).toMatchObject({ ok: true, value: { version: 1, sheet: { risks: { inRiskZone: true } } } });
    expect(await t.fiches.read(t.agent, t.propertyId, 3)).toEqual({ ok: false, rule: null, code: 'unknown_version' });
    const h = await t.fiches.history(t.compliance, t.propertyId);
    expect(h.ok && h.value.map((v) => v.version)).toEqual([1, 2]);
    await expect(t.db.run('DELETE FROM property_sheets')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE property_sheets SET data = '{}'")).rejects.toThrow(/ne change plus/);
  });

  it('une saisie fautive ne range rien et nomme le champ', async () => {
    const t = await setup();
    expect(await t.fiches.save(t.agent, t.propertyId, { ...FULL, energy: { ...FULL.energy, energyClass: 'Z' } })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'energy.energyClass' });
    expect(await t.fiches.read(t.agent, t.propertyId)).toEqual({ ok: false, rule: null, code: 'no_sheet' });
    expect(await t.fiches.latest(t.propertyId)).toBeNull();
  });

  it('deux enregistrements simultanés ont deux versions différentes, sans trou', async () => {
    const t = await setup();
    const results = await Promise.all([1, 2, 3, 4].map((n) => t.fiches.save(t.agent, t.propertyId, { ...FULL, characteristics: { ...FULL.characteristics, bedrooms: n } })));
    expect(results.every((r) => r.ok)).toBe(true);
    const h = await t.fiches.history(t.agent, t.propertyId);
    expect(h.ok && h.value.map((v) => v.version)).toEqual([1, 2, 3, 4]);
  });

  it('[R16] seuls l’agent du bien et la direction écrivent ; chaque refus est au journal', async () => {
    const t = await setup();
    expect(await t.fiches.save(t.sam, t.propertyId, FULL)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.fiches.save(t.compliance, t.propertyId, FULL)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.fiches.save(t.partner, t.propertyId, FULL)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.fiches.save(t.stranger, t.propertyId, FULL)).toMatchObject({ ok: false, rule: 'R16', code: 'other_network' });
    expect(await t.fiches.latest(t.propertyId)).toBeNull();
    // Un autre agent ne lit pas la fiche complète, même d'un bien du fichier commun.
    await t.db.run("UPDATE properties SET status = 'available' WHERE id = ?", [t.propertyId]);
    await t.fiches.save(t.agent, t.propertyId, FULL);
    expect(await t.fiches.read(t.sam, t.propertyId)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.fiches.read(t.compliance, t.propertyId)).toMatchObject({ ok: true, value: { version: 1 } });
    const refusals = (await t.journal.bySubject(`property:${t.propertyId}`)).filter((e) => e.type === 'acces.refuse');
    expect(refusals.length).toBeGreaterThanOrEqual(5);
    expect(await t.fiches.read(t.agent, 'bien-inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_property' });
  });

  it('[R13] le journal porte le numéro de version, aucune donnée de la fiche', async () => {
    const t = await setup();
    await t.fiches.save(t.agent, t.propertyId, FULL);
    const entries = (await t.journal.bySubject(`property:${t.propertyId}`)).filter((e) => e.type === 'bien.fiche_version');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data).toEqual({ rule: 'R17', version: 1 });
    expect(JSON.stringify(entries[0])).not.toMatch(/REF-T-1|sejour|1550|Dijon/);
  });
});
