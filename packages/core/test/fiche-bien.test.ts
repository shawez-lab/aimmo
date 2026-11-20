import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { FicheBien, energyPriceText, parseSheet } from '../src/annonces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Biens, agents et réseau inventés.
const TODAY = new Date('2027-03-10T09:00:00.000Z');

const PID = 'bien-test-1';
const U1 = '0b6f1d2e-1111-4a2b-8c3d-000000000001';
const U2 = '0b6f1d2e-2222-4a2b-8c3d-000000000002';
const U3 = '0b6f1d2e-3333-4a2b-8c3d-000000000003';
const ref = (u: string, ext: string, pid = PID) => `biens/${pid}/${u}.${ext}`;
const FULL = {
  characteristics: { bedrooms: 2, floor: 3, floorsTotal: 5, buildYear: 1965, heating: 'collectif', outdoor: ['terrasse', 'balcon'], landM2: null, parkingSpaces: 1, elevator: true },
  energy: { energyClass: 'D', climateClass: 'C', annualCostMinEur: 1100, annualCostMaxEur: 1550, costReferenceYear: 2023, diagnosedOn: '2027-01-15' },
  coownership: { isCoownership: true, lots: 24, annualChargesEur: 1800, proceedings: false },
  risks: { inRiskZone: true },
  media: [
    { ref: ref(U1, 'jpg'), kind: 'photo', edit: 'lumiere_cadrage' },
    { ref: ref(U2, 'webp'), kind: 'photo', edit: 'amenagement_virtuel' },
    { ref: ref(U3, 'mp4'), kind: 'video', edit: 'aucune' },
  ],
};

/** La fiche de test, pour le bien créé dans la base (son identifiant est tiré au hasard). */
const forProperty = <T>(value: T, propertyId: string): T => JSON.parse(JSON.stringify(value).split(PID).join(propertyId)) as T;

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
  return { db, journal, fiches, propertyId: b.id, full: forProperty(FULL, b.id), agent: as('agent', alex.id), sam: as('agent', sam.id), direction: as('direction', 'd-1'), compliance: as('compliance', 'c-1'), partner: as('partner', 'p-1'), stranger: as('direction', 'd-2', other.id), setClock: (d: Date) => (clock = d) };
}

it('[R51] AU070 · la fiche dit maison ou appartement, ou rien ; une autre valeur est refusée et nommée', () => {
  const r = parseSheet({ characteristics: { dwelling: 'apartment' } }, TODAY, PID);
  expect(r.ok && r.value.characteristics.dwelling).toBe('apartment');
  const none = parseSheet({}, TODAY, PID);
  expect(none.ok && 'dwelling' in none.value.characteristics).toBe(false);
  expect(parseSheet({ characteristics: { dwelling: 'villa' } }, TODAY, PID)).toEqual({ ok: false, field: 'characteristics.dwelling' });
});

it('P01 · une fiche complète est acceptée et rangée dans un ordre fixe', () => {
  const r = parseSheet(FULL, TODAY, PID);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.characteristics.outdoor).toEqual(['balcon', 'terrasse']);
  expect(r.value.energy).toEqual(FULL.energy);
  expect(r.value.coownership).toEqual(FULL.coownership);
  // Une fiche vide est permise : ce qui manque bloquera la publication (P02), pas la saisie.
  expect(parseSheet({}, TODAY, PID)).toMatchObject({ ok: true, value: { energy: null, coownership: null, risks: null, media: [] } });
});

it('P01 · chaque champ est contrôlé et le premier champ fautif est nommé', () => {
  // AU061 · équipements et état : liste fermée, sans doublon ; absents, rien n'est rangé.
  const withC = (patch: Record<string, unknown>) => parseSheet({ ...FULL, characteristics: { ...FULL.characteristics, ...patch } }, TODAY, PID);
  const eq = withC({ amenities: ['cheminee', 'piscine'], condition: 'bon_etat' });
  expect(eq.ok && eq.value.characteristics).toMatchObject({ amenities: ['piscine', 'cheminee'], condition: 'bon_etat' });
  expect(withC({ amenities: ['jacuzzi'] })).toEqual({ ok: false, field: 'characteristics.amenities' });
  expect(withC({ amenities: ['cave', 'cave'] })).toEqual({ ok: false, field: 'characteristics.amenities' });
  expect(withC({ condition: 'parfait' })).toEqual({ ok: false, field: 'characteristics.condition' });
  const none = withC({});
  expect(none.ok && 'amenities' in none.value.characteristics).toBe(false);
  const withEnergy = (patch: Record<string, unknown>) => parseSheet({ ...FULL, energy: { ...FULL.energy, ...patch } }, TODAY, PID);
  expect(withEnergy({ energyClass: 'H' })).toEqual({ ok: false, field: 'energy.energyClass' });
  expect(withEnergy({ climateClass: 'b' })).toEqual({ ok: false, field: 'energy.climateClass' });
  expect(withEnergy({ annualCostMinEur: -5 })).toEqual({ ok: false, field: 'energy.annualCostMinEur' });
  expect(withEnergy({ annualCostMinEur: 0 })).toEqual({ ok: false, field: 'energy.annualCostMinEur' });
  expect(withEnergy({ annualCostMinEur: 2000 })).toEqual({ ok: false, field: 'energy.annualCostMinEur' });
  expect(withEnergy({ annualCostMaxEur: 1550.5 })).toEqual({ ok: false, field: 'energy.annualCostMaxEur' });
  expect(withEnergy({ costReferenceYear: 2028 })).toEqual({ ok: false, field: 'energy.costReferenceYear' });
  // AU065 · les années des prix que le diagnostic cite : qui se suivent, la dernière étant l'année des prix.
  const span = withEnergy({ costReferenceYear: 2023, costReferenceYears: [2021, 2022, 2023] });
  expect(span.ok && span.value.energy).toMatchObject({ costReferenceYear: 2023, costReferenceYears: [2021, 2022, 2023] });
  for (const years of [[2021, 2023], [2023], [2021, 2022], [2022, 2021, 2023], [2019, 2020, 2021, 2022, 2023, 2024]]) {
    expect(withEnergy({ costReferenceYear: 2023, costReferenceYears: years })).toEqual({ ok: false, field: 'energy.costReferenceYears' });
  }
  // AU064 · numéro ADEME, valeurs et document du diagnostic : gardés, contrôlés, jamais devinés.
  const full = withEnergy({ ademeNumber: '2321E0123456J', primaryEnergyKwhM2: 212, ghgKgM2: 41, documentRef: `biens/${PID}/0b6f1d2e-1111-4a2b-8c3d-0000000000dd.pdf` });
  expect(full.ok && full.value.energy).toMatchObject({ ademeNumber: '2321E0123456J', primaryEnergyKwhM2: 212, ghgKgM2: 41 });
  expect(withEnergy({ ademeNumber: '2321e0123456j' })).toEqual({ ok: false, field: 'energy.ademeNumber' });
  expect(withEnergy({ ademeNumber: '2321E012345' })).toEqual({ ok: false, field: 'energy.ademeNumber' });
  expect(withEnergy({ primaryEnergyKwhM2: 212.5 })).toEqual({ ok: false, field: 'energy.primaryEnergyKwhM2' });
  expect(withEnergy({ ghgKgM2: -1 })).toEqual({ ok: false, field: 'energy.ghgKgM2' });
  expect(withEnergy({ documentRef: 'biens/autre/0b6f1d2e-1111-4a2b-8c3d-0000000000dd.pdf' })).toEqual({ ok: false, field: 'energy.documentRef' });
  expect(withEnergy({ documentRef: `biens/${PID}/0b6f1d2e-1111-4a2b-8c3d-0000000000dd.jpg` })).toEqual({ ok: false, field: 'energy.documentRef' });
  expect(energyPriceText({ costReferenceYear: 2021 })).toBe('Prix moyens des énergies indexés au 1er janvier 2021 (abonnements compris).');
  expect(energyPriceText({ costReferenceYear: 2023, costReferenceYears: [2021, 2022, 2023] })).toBe('Prix moyens des énergies indexés sur les années 2021, 2022 et 2023 (abonnements compris).');
  // Date du diagnostic : jamais dans le futur, à l'heure de Paris ; jamais une date impossible.
  expect(withEnergy({ diagnosedOn: '2027-03-11' })).toEqual({ ok: false, field: 'energy.diagnosedOn' });
  expect(withEnergy({ diagnosedOn: '2027-02-30' })).toEqual({ ok: false, field: 'energy.diagnosedOn' });
  expect(withEnergy({ diagnosedOn: '2027-03-10' }).ok).toBe(true);
  expect(parseSheet({ ...FULL, energy: { ...FULL.energy, diagnosedOn: '2027-03-11' } }, new Date('2027-03-10T23:30:00.000Z'), PID).ok).toBe(true);
  // Champ inconnu : refusé, jamais ignoré ; aucun texte libre ne peut entrer.
  expect(withEnergy({ commentaire: 'au 12 rue des Essais' })).toEqual({ ok: false, field: 'energy.commentaire' });
  expect(parseSheet({ ...FULL, adresse: '12 rue des Essais' }, TODAY, PID)).toEqual({ ok: false, field: 'adresse' });
  expect(parseSheet({ ...FULL, characteristics: { ...FULL.characteristics, note: 'x' } }, TODAY, PID)).toEqual({ ok: false, field: 'characteristics.note' });
  expect(parseSheet({ ...FULL, characteristics: { ...FULL.characteristics, floor: 6 } }, TODAY, PID)).toEqual({ ok: false, field: 'characteristics.floor' });
  expect(parseSheet({ ...FULL, characteristics: { ...FULL.characteristics, heating: 'cheminée' } }, TODAY, PID)).toEqual({ ok: false, field: 'characteristics.heating' });
  expect(parseSheet({ ...FULL, characteristics: { ...FULL.characteristics, outdoor: ['jardin', 'jardin'] } }, TODAY, PID)).toEqual({ ok: false, field: 'characteristics.outdoor' });
  expect(parseSheet({ ...FULL, characteristics: { ...FULL.characteristics, buildYear: 2028 } }, TODAY, PID)).toEqual({ ok: false, field: 'characteristics.buildYear' });
  expect(parseSheet({ ...FULL, coownership: { isCoownership: true, lots: 0, annualChargesEur: 10, proceedings: false } }, TODAY, PID)).toEqual({ ok: false, field: 'coownership.lots' });
  expect(parseSheet({ ...FULL, coownership: { isCoownership: true, lots: 3, annualChargesEur: 10 } }, TODAY, PID)).toEqual({ ok: false, field: 'coownership.proceedings' });
  expect(parseSheet({ ...FULL, coownership: { isCoownership: false, lots: 3 } }, TODAY, PID)).toEqual({ ok: false, field: 'coownership.lots' });
  expect(parseSheet({ ...FULL, risks: { inRiskZone: 'oui' } }, TODAY, PID)).toEqual({ ok: false, field: 'risks.inRiskZone' });
  // [R46] La référence d'une photo vient du stockage : aucun nom libre, qui pourrait porter une adresse, ni la photo d'un autre bien.
  const media = (r: string, kind = 'photo') => parseSheet({ ...FULL, media: [{ ref: r, kind, edit: 'aucune' }] }, TODAY, PID);
  expect(media(`biens/${PID}/12-rue-des-Essais-Dijon.jpg`)).toEqual({ ok: false, field: 'media.0.ref' });
  expect(media(ref(U1, 'jpg', 'autre-bien'))).toEqual({ ok: false, field: 'media.0.ref' });
  expect(media(`biens/${PID}/../${U1}.jpg`)).toEqual({ ok: false, field: 'media.0.ref' });
  expect(media(ref(U1, 'mp4'))).toEqual({ ok: false, field: 'media.0.ref' });
  expect(media(ref(U1, 'jpg'), 'video')).toEqual({ ok: false, field: 'media.0.ref' });
  expect(media(ref(U1, 'jpg')).ok).toBe(true);
  expect(parseSheet({ ...FULL, media: [FULL.media[0], FULL.media[0]] }, TODAY, PID)).toEqual({ ok: false, field: 'media.1.ref' });
  expect(parseSheet({ ...FULL, media: [{ ref: ref(U3, 'mp4'), kind: 'video', edit: 'amenagement_virtuel' }] }, TODAY, PID)).toEqual({ ok: false, field: 'media.0.edit' });
  expect(parseSheet('fiche', TODAY, PID)).toEqual({ ok: false, field: 'fiche' });
});

describeWithSqlite('P01 · fiche du bien versionnée', () => {
  it('[R17] une modification crée une version, l’ancienne reste lisible et rien ne change ni ne s’efface', async () => {
    const t = await setup();
    const v1 = await t.fiches.save(t.agent, t.propertyId, t.full);
    expect(v1).toMatchObject({ ok: true, value: { version: 1 } });
    t.setClock(new Date('2027-03-11T09:00:00.000Z'));
    const v2 = await t.fiches.save(t.direction, t.propertyId, { ...t.full, risks: { inRiskZone: false } });
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
    expect(await t.fiches.save(t.agent, t.propertyId, { ...t.full, energy: { ...t.full.energy, energyClass: 'Z' } })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'energy.energyClass' });
    expect(await t.fiches.read(t.agent, t.propertyId)).toEqual({ ok: false, rule: null, code: 'no_sheet' });
    expect((await t.fiches.history(t.direction, t.propertyId)) ).toEqual({ ok: true, value: [] });
  });

  it('deux enregistrements simultanés ont deux versions différentes, sans trou', async () => {
    const t = await setup();
    const results = await Promise.all([1, 2, 3, 4].map((n) => t.fiches.save(t.agent, t.propertyId, { ...t.full, characteristics: { ...t.full.characteristics, bedrooms: n } })));
    expect(results.every((r) => r.ok)).toBe(true);
    const h = await t.fiches.history(t.agent, t.propertyId);
    expect(h.ok && h.value.map((v) => v.version)).toEqual([1, 2, 3, 4]);
  });

  it('[R16] seuls l’agent du bien et la direction écrivent ; chaque refus est au journal', async () => {
    const t = await setup();
    expect(await t.fiches.save(t.sam, t.propertyId, t.full)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.fiches.save(t.compliance, t.propertyId, t.full)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.fiches.save(t.partner, t.propertyId, t.full)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.fiches.save(t.stranger, t.propertyId, t.full)).toMatchObject({ ok: false, rule: 'R16', code: 'other_network' });
    expect(await t.fiches.history(t.direction, t.propertyId)).toEqual({ ok: true, value: [] });
    // Un autre agent ne lit pas la fiche complète, même d'un bien du fichier commun.
    await t.db.run("UPDATE properties SET status = 'available' WHERE id = ?", [t.propertyId]);
    await t.fiches.save(t.agent, t.propertyId, t.full);
    expect(await t.fiches.read(t.sam, t.propertyId)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.fiches.read(t.compliance, t.propertyId)).toMatchObject({ ok: true, value: { version: 1 } });
    const refusals = (await t.journal.bySubject(`property:${t.propertyId}`)).filter((e) => e.type === 'acces.refuse');
    expect(refusals.length).toBeGreaterThanOrEqual(5);
    expect(await t.fiches.read(t.agent, 'bien-inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_property' });
  });

  it('[R13] le journal porte le numéro de version, aucune donnée de la fiche', async () => {
    const t = await setup();
    await t.fiches.save(t.agent, t.propertyId, t.full);
    const entries = (await t.journal.bySubject(`property:${t.propertyId}`)).filter((e) => e.type === 'bien.fiche_version');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data).toEqual({ rule: 'R17', version: 1 });
    // Les empreintes et identifiants, tirés au hasard, peuvent contenir ces chiffres : seuls le type et les données comptent.
    expect(JSON.stringify({ type: entries[0]!.type, data: entries[0]!.data })).not.toMatch(/REF-T-1|0b6f1d2e|1550|Dijon/);
  });
});
