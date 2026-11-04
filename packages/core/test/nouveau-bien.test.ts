import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, NouveauBien, SqlJournalStore, applyMigrations, fromSyncSqlite, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé.
const NOW = new Date('2027-02-03T10:00:00.000Z');
const INPUT = { kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 200000 };

async function setup(options: { newReference?: () => string } = {}) {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = () => NOW;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, unique, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  const biens = new NouveauBien(db, acces, journal, { now, ...options });
  return { db, journal, store, network, person, biens, alex: as('agent', alex.id), sam: as('agent', sam.id), direction: as('direction', 'd-1'), compliance: as('compliance', 'c-1'), alexId: alex.id };
}

const links = (t: Awaited<ReturnType<typeof setup>>) => t.db.all<{ role: string; project_id: string; property_id: string }>('SELECT role, project_id, property_id FROM project_properties');

describeWithSqlite('SV06 · l’agent crée un bien et le lie à son vendeur', () => {
  it('le bien est créé en préparation, à l’agent de la fiche, et lié à un projet de vente ouvert pour l’occasion', async () => {
    const t = await setup();
    const r = await t.biens.create(t.alex, t.person.id, INPUT);
    expect(r).toMatchObject({ ok: true, value: { already: false, kind: 'home', city: 'Dijon', surfaceM2: 62, status: 'draft' } });
    if (!r.ok) return;
    expect(r.value.reference).toMatch(/^B-[0-9A-F]{8}$/);
    const p = await t.db.first<{ agent_id: string; price_eur: number; status: string }>('SELECT agent_id, price_eur, status FROM properties WHERE id = ?', [r.value.propertyId]);
    expect(p).toMatchObject({ agent_id: t.alexId, price_eur: 200000, status: 'draft' });
    const project = await t.db.first<{ id: string; kind: string; person_id: string }>('SELECT id, kind, person_id FROM projects');
    expect(project).toMatchObject({ kind: 'sell', person_id: t.person.id });
    expect(await links(t)).toEqual([{ role: 'owned', project_id: project!.id, property_id: r.value.propertyId }]);
    expect(await t.biens.list(t.alex, t.person.id)).toMatchObject({ ok: true, value: [{ propertyId: r.value.propertyId }] });
  });

  it('un projet de vente qui existe sert, il n’en est pas ouvert un autre', async () => {
    const t = await setup();
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: t.person.id, kind: 'sell' });
    await t.biens.create(t.alex, t.person.id, INPUT);
    expect((await t.db.all('SELECT id FROM projects')).length).toBe(1);
    expect((await links(t))[0]!.project_id).toBe(project.id);
  });

  it('une réponse perdue puis un nouvel essai ne crée pas le bien deux fois', async () => {
    const t = await setup();
    const a = await t.biens.create(t.alex, t.person.id, INPUT);
    const b = await t.biens.create(t.alex, t.person.id, INPUT);
    expect(b).toMatchObject({ ok: true, value: { already: true } });
    if (a.ok && b.ok) expect(b.value.propertyId).toBe(a.value.propertyId);
    expect((await t.db.all('SELECT id FROM properties')).length).toBe(1);
    expect((await t.journal.all()).filter((e) => e.type === 'bien.cree')).toHaveLength(1);
    // Un autre bien du même client, lui, se crée.
    expect(await t.biens.create(t.alex, t.person.id, { ...INPUT, surfaceM2: 80 })).toMatchObject({ ok: true, value: { already: false } });
  });

  it('une référence déjà prise est tirée de nouveau : elle reste unique dans le réseau, et rien n’est créé à moitié', async () => {
    const refs = ['B-AAAAAAAA', 'B-AAAAAAAA', 'B-BBBBBBBB'];
    const t = await setup({ newReference: () => refs.shift()! });
    await t.biens.create(t.alex, t.person.id, INPUT);
    const second = await t.biens.create(t.alex, t.person.id, { ...INPUT, surfaceM2: 90 });
    expect(second).toMatchObject({ ok: true, value: { reference: 'B-BBBBBBBB' } });
    expect((await t.db.all('SELECT id FROM properties')).length).toBe(2);
    expect((await links(t)).length).toBe(2);
    // Toujours la même référence : le geste échoue, sans bien ni lien orphelin.
    const stuck = await setup({ newReference: () => 'B-CCCCCCCC' });
    await stuck.biens.create(stuck.alex, stuck.person.id, INPUT);
    await expect(stuck.biens.create(stuck.alex, stuck.person.id, { ...INPUT, surfaceM2: 90 })).rejects.toThrow(/UNIQUE/);
    expect((await stuck.db.all('SELECT id FROM properties')).length).toBe(1);
    expect((await links(stuck)).length).toBe(1);
  });

  it('[R16] l’agent de la fiche et la direction créent ; un autre agent et la conformité sont refusés, au journal', async () => {
    const t = await setup();
    expect(await t.biens.create(t.sam, t.person.id, INPUT)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.biens.list(t.sam, t.person.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.biens.create(t.compliance, t.person.id, INPUT)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.db.all('SELECT id FROM properties')).length).toBe(0);
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length).toBeGreaterThanOrEqual(3);
    expect(await t.biens.create(t.direction, t.person.id, INPUT)).toMatchObject({ ok: true });
    expect(await t.biens.create(t.alex, '00000000-0000-4000-8000-000000000000', INPUT)).toMatchObject({ ok: false, code: 'unknown' });
  });

  it('une fiche sans agent ne reçoit pas de bien : elle s’attribue d’abord', async () => {
    const t = await setup();
    const orphan = await t.store.createPerson({ networkId: t.network.id, firstName: 'Noé' });
    expect(await t.biens.create(t.direction, orphan.id, INPUT)).toEqual({ ok: false, rule: null, code: 'no_agent' });
  });

  it.each([
    [{ kind: 'chateau' }, 'bad_kind'],
    [{ postalCode: '2100' }, 'bad_postal_code'],
    [{ city: ' ' }, 'bad_city'],
    [{ city: '12 rue de l’Essai' }, 'bad_city'],
    [{ surfaceM2: 0 }, 'bad_surface'],
    [{ surfaceM2: '62' }, 'bad_surface'],
    [{ surfaceM2: 62.5 }, 'bad_surface'],
    [{ rooms: -1 }, 'bad_rooms'],
    [{ priceEur: 0 }, 'bad_price'],
  ])('une saisie fausse est refusée, rien n’est créé : %j', async (patch, code) => {
    const t = await setup();
    expect(await t.biens.create(t.alex, t.person.id, { ...INPUT, ...patch })).toEqual({ ok: false, rule: null, code });
    expect((await t.db.all('SELECT id FROM properties')).length).toBe(0);
  });

  it('[R13] le journal ne porte ni commune, ni prix, ni nom', async () => {
    const t = await setup();
    await t.biens.create(t.alex, t.person.id, INPUT);
    const entry = (await t.journal.all()).find((e) => e.type === 'bien.cree')!;
    expect(entry.data).toEqual({ rule: 'R16', kind: 'home' });
  });
});
