import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { HonorairesLocation, MisesEnLocation, feeCeilings, feeProblems, type RentalFacts } from '../src/location/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, propriétaire, logements et communes inventés (codes communes fictifs). Le 12 juillet 2027 est un lundi.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const FACTS: RentalFacts = {
  furnished: false,
  rentCents: 65_000,
  chargesCents: 5_000,
  livingAreaHundredths: 4_250,
  energyClass: 'D',
  finalEnergyKwh: 210,
  buildYear: 1985,
  electricityOver15: false,
  gas: 'aucune',
  leaseStart: '2027-09-01',
};

describe('W02 · plafonds écrits', () => {
  it('[R102] plafonds par zone, au centime, depuis la surface habitable', () => {
    // 42,50 m² : 12 € → 510 €, 10 € → 425 €, 8 € → 340 €, état des lieux 3 € → 127,50 €.
    expect(feeCeilings(4_250, 'tres_tendue', 65_000, false)).toEqual({ zone: 'tres_tendue', tenantCeilingCents: 51_000, inventoryCeilingCents: 12_750, depositCeilingCents: 65_000 });
    expect(feeCeilings(4_250, 'tendue', 65_000, false).tenantCeilingCents).toBe(42_500);
    expect(feeCeilings(4_250, 'autre', 65_000, false).tenantCeilingCents).toBe(34_000);
    // Une commune sans zone connue prend le plafond le plus bas.
    expect(feeCeilings(4_250, 'inconnue', 65_000, false).tenantCeilingCents).toBe(34_000);
    // Un meublé : deux mois de loyer hors charges.
    expect(feeCeilings(4_250, 'autre', 65_000, true).depositCeilingCents).toBe(130_000);
  });

  it('[R102] chaque dépassement est nommé, testé à un centime près', () => {
    const c = feeCeilings(4_250, 'tendue', 65_000, false);
    const ok = { tenantCents: 42_500, tenantInventoryCents: 12_750, landlordCents: 55_250, depositCents: 65_000 };
    expect(feeProblems(ok, c)).toEqual([]);
    expect(feeProblems({ ...ok, tenantCents: 42_501, landlordCents: 60_000 }, c)).toEqual(['tenant_ceiling']);
    expect(feeProblems({ ...ok, tenantInventoryCents: 12_751, landlordCents: 60_000 }, c)).toEqual(['inventory_ceiling']);
    expect(feeProblems({ ...ok, landlordCents: 55_249 }, c)).toEqual(['over_landlord']);
    expect(feeProblems({ ...ok, depositCents: 65_001 }, c)).toEqual(['deposit_ceiling']);
  });
});

async function setup() {
  clock = Date.parse('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const listings = new MisesEnLocation(db, { has: async () => true }, journal, { now, newId: uuid });
  const fees = new HonorairesLocation(db, listings, journal, { now });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bailleur', lastName: 'Inventé' });
  const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-1', kind: 'home', postalCode: '21000' });
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const other = { role: 'agent' as const, userId: bea.id, networkId: network.id };
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const compliance = { role: 'compliance' as const, userId: 'conf-1', networkId: network.id };
  const open = async (facts: Partial<RentalFacts> = {}) => {
    const c = await listings.create(agent, { propertyId: home.id, ownerPersonId: owner.id });
    if (!c.ok) throw new Error(c.code);
    expect((await listings.recordFacts(agent, c.value.listingId, { ...FACTS, ...facts })).ok).toBe(true);
    return c.value.listingId;
  };
  const events = (type: string) => db.all<{ data: string }>('SELECT data FROM journal WHERE type = ? ORDER BY seq', [type]);
  return { db, listings, fees, agent, other, dir, compliance, open, events };
}

const OK = { inseeCode: '99001', tenantCents: 42_500, tenantInventoryCents: 12_750, landlordCents: 55_250, depositCents: 65_000 };

describeWithSqlite('W02 · honoraires et dépôt de garantie', () => {
  it('[R102] la zone vient de la base, avec sa source et sa date d’effet ; sans zone, 8 € par m²', async () => {
    const t = await setup();
    const id = await t.open();
    expect(await t.fees.ceilings(t.agent, id, '99001')).toMatchObject({ ok: true, value: { zone: 'inconnue', tenantCeilingCents: 34_000 } });
    expect(await t.fees.recordZone(t.dir, { inseeCode: '99001', zone: 'tendue', effectiveFrom: '2023-08-26', source: 'Liste officielle inventée pour le test' })).toEqual({ ok: true, value: true });
    expect(await t.fees.ceilings(t.agent, id, '99001')).toMatchObject({ ok: true, value: { zone: 'tendue', tenantCeilingCents: 42_500 } });
    // Une nouvelle date d'effet s'ajoute ; elle ne vaut qu'à partir de sa date (bail du 1er septembre 2027).
    expect((await t.fees.recordZone(t.dir, { inseeCode: '99001', zone: 'tres_tendue', effectiveFrom: '2027-10-01', source: 'Arrêté inventé' })).ok).toBe(true);
    expect(await t.fees.ceilings(t.agent, id, '99001')).toMatchObject({ ok: true, value: { zone: 'tendue' } });
    expect(await t.fees.recordZone(t.dir, { inseeCode: '99001', zone: 'tendue', effectiveFrom: '2023-08-26', source: 'Doublon' })).toEqual({ ok: false, rule: null, code: 'already_recorded' });
    expect(await t.fees.recordZone(t.agent, { inseeCode: '99002', zone: 'tendue', effectiveFrom: '2023-08-26', source: 'Liste' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.fees.recordZone(t.dir, { inseeCode: '9900', zone: 'tendue', effectiveFrom: '2023-08-26', source: 'Liste' })).toMatchObject({ code: 'bad_insee' });
    expect(await t.fees.recordZone(t.dir, { inseeCode: '2A004', zone: 'zone_a', effectiveFrom: '2023-08-26', source: 'Liste' })).toMatchObject({ code: 'bad_zone' });
    await expect(t.db.run("UPDATE rental_zones SET zone = 'autre'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM rental_zones')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R102] un barème au plafond est rangé ; un centime de trop est refusé avec sa raison, au journal', async () => {
    const t = await setup();
    await t.fees.recordZone(t.dir, { inseeCode: '99001', zone: 'tendue', effectiveFrom: '2023-08-26', source: 'Liste officielle inventée' });
    const id = await t.open();
    expect(await t.fees.record(t.agent, id, { ...OK, tenantCents: 42_501, landlordCents: 60_000 })).toEqual({ ok: false, rule: 'R102', code: 'tenant_ceiling' });
    expect(await t.fees.record(t.agent, id, { ...OK, tenantInventoryCents: 12_751, landlordCents: 60_000 })).toEqual({ ok: false, rule: 'R102', code: 'inventory_ceiling' });
    expect(await t.fees.record(t.agent, id, { ...OK, landlordCents: 55_249 })).toEqual({ ok: false, rule: 'R102', code: 'over_landlord' });
    expect(await t.fees.record(t.agent, id, { ...OK, depositCents: 65_001 })).toEqual({ ok: false, rule: 'R102', code: 'deposit_ceiling' });
    expect(await t.db.all('SELECT 1 FROM rental_fees')).toHaveLength(0);
    expect((await t.events('location.bareme_refuse')).map((e) => JSON.parse(e.data))).toHaveLength(4);
    const r = await t.fees.record(t.agent, id, OK);
    expect(r).toMatchObject({ ok: true, value: { version: 1, zone: 'tendue', tenantCents: 42_500, tenantCeilingCents: 42_500 } });
    expect(await t.fees.current(t.agent.networkId, id)).toMatchObject({ version: 1, depositCents: 65_000 });
    // Le journal ne garde aucun montant.
    for (const e of await t.db.all<{ data: string }>('SELECT data FROM journal')) expect(e.data).not.toMatch(/42500|65000|55250/);
  });

  it('[R102] la base refuse elle-même un dépassement, même écrit sans le code', async () => {
    const t = await setup();
    const id = await t.open();
    const insert = (tenant: number) =>
      t.db.run(
        "INSERT INTO rental_fees (listing_id, version, facts_version, insee_code, zone, tenant_cents, tenant_inventory_cents, landlord_cents, deposit_cents, tenant_ceiling_cents, inventory_ceiling_cents, deposit_ceiling_cents, recorded_by, recorded_at) VALUES (?, 1, 1, '99001', 'autre', ?, 0, 100000, 0, 34000, 12750, 65000, 'x', 'y')",
        [id, tenant],
      );
    await expect(insert(34_001)).rejects.toThrow(/CHECK/);
    await insert(34_000);
    await expect(t.db.run('UPDATE rental_fees SET tenant_cents = 1')).rejects.toThrow(/ne change plus/);
  });

  it('[R102] meublé : deux mois de loyer ; un changement de faits rend le barème caduc', async () => {
    const t = await setup();
    const id = await t.open({ furnished: true });
    expect((await t.fees.record(t.agent, id, { ...OK, landlordCents: 50_000, tenantCents: 34_000, tenantInventoryCents: 12_750, depositCents: 130_000 })).ok).toBe(true);
    expect(await t.fees.record(t.agent, id, { ...OK, landlordCents: 50_000, tenantCents: 34_000, tenantInventoryCents: 12_750, depositCents: 130_001 })).toEqual({ ok: false, rule: 'R102', code: 'deposit_ceiling' });
    expect(await t.fees.current(t.agent.networkId, id)).not.toBeNull();
    // La surface corrigée à la baisse : le barème rangé ne vaut plus, il faut en ranger un nouveau.
    await t.listings.recordFacts(t.agent, id, { ...FACTS, furnished: true, livingAreaHundredths: 3_000 });
    expect(await t.fees.current(t.agent.networkId, id)).toBeNull();
    expect(await t.fees.record(t.agent, id, { ...OK, landlordCents: 50_000, tenantCents: 34_000, tenantInventoryCents: 9_000, depositCents: 130_000 })).toEqual({ ok: false, rule: 'R102', code: 'tenant_ceiling' });
    expect((await t.fees.record(t.agent, id, { ...OK, landlordCents: 50_000, tenantCents: 24_000, tenantInventoryCents: 9_000, depositCents: 130_000 })).ok).toBe(true);
    expect(await t.fees.current(t.agent.networkId, id)).toMatchObject({ version: 2, factsVersion: 2 });
  });

  it('[R16] montants contrôlés, droits de M15 : l’agent du logement et la direction rangent, la conformité lit', async () => {
    const t = await setup();
    const id = await t.open();
    expect(await t.fees.record(t.agent, id, { ...OK, tenantCents: 425.5 })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'tenantCents' });
    expect(await t.fees.record(t.agent, id, { ...OK, depositCents: -1 })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'depositCents' });
    expect(await t.fees.record(t.other, id, OK)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.fees.record(t.compliance, id, OK)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.fees.ceilings(t.compliance, id, '99001')).ok).toBe(true);
    expect((await t.fees.record(t.dir, id, { ...OK, tenantCents: 34_000, landlordCents: 50_000 })).ok).toBe(true);
    expect(await t.fees.current('autre-reseau', id)).toBeNull();
  });
});
