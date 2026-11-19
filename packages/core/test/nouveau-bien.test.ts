import { expect, it } from 'vitest';
import { Acces, ControlesSignature, FicheClient, FicheUnique, Modeles, NouveauBien, SqlJournalStore, applyMigrations, fromSyncSqlite, type Viewer } from '../src/index.ts';
import { fallbackListing, traceListing } from '../src/annonces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { designerTout } from './designation-jeu.ts';

// Tout est inventé.
const NOW = new Date('2027-02-03T10:00:00.000Z');
const key = (n: number) => `0b6f1d2e-5555-4a2b-8c3d-${String(n).padStart(12, '0')}`;
const INPUT = { requestId: key(1), kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 200000 };

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
  const otherNetwork = await store.createNetwork('Autre réseau');
  const outsider: Viewer = { role: 'direction', userId: 'd-2', networkId: otherNetwork.id } as Viewer;
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  const biens = new NouveauBien(db, acces, journal, { now, ...options });
  return { db, journal, store, acces, unique, now, outsider, samId: sam.id, network, person, biens, alex: as('agent', alex.id), sam: as('agent', sam.id), direction: as('direction', 'd-1'), compliance: as('compliance', 'c-1'), alexId: alex.id };
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

  it('[R51] AU070 · un logement est dit maison ou appartement à la création ; jamais pour un autre type', async () => {
    const t = await setup();
    const r = await t.biens.create(t.alex, t.person.id, { ...INPUT, dwelling: 'house' });
    if (!r.ok) throw new Error('refus');
    expect(await t.db.first('SELECT dwelling FROM properties WHERE id = ?', [r.value.propertyId])).toEqual({ dwelling: 'house' });
    expect(await t.biens.create(t.alex, t.person.id, { ...INPUT, requestId: key(3), dwelling: 'chateau' })).toMatchObject({ ok: false, code: 'bad_dwelling' });
    expect(await t.biens.create(t.alex, t.person.id, { ...INPUT, requestId: key(4), kind: 'land', dwelling: 'house' })).toMatchObject({ ok: false, code: 'bad_dwelling' });
  });

  it('un projet de vente qui existe sert, il n’en est pas ouvert un autre', async () => {
    const t = await setup();
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: t.person.id, kind: 'sell' });
    await t.biens.create(t.alex, t.person.id, INPUT);
    expect((await t.db.all('SELECT id FROM projects')).length).toBe(1);
    expect((await links(t))[0]!.project_id).toBe(project.id);
  });

  it('une réponse perdue puis un nouvel essai de la même demande ne crée rien de plus', async () => {
    const t = await setup();
    const a = await t.biens.create(t.alex, t.person.id, INPUT);
    const b = await t.biens.create(t.alex, t.person.id, INPUT);
    expect(b).toMatchObject({ ok: true, value: { already: true } });
    if (a.ok && b.ok) expect(b.value.propertyId).toBe(a.value.propertyId);
    expect((await t.db.all('SELECT id FROM properties')).length).toBe(1);
    expect((await t.journal.all()).filter((e) => e.type === 'bien.cree')).toHaveLength(1);
  });

  it('deux biens qui se ressemblent restent deux biens : seule la demande rejouée les confond', async () => {
    const t = await setup();
    await t.biens.create(t.alex, t.person.id, INPUT);
    expect(await t.biens.create(t.alex, t.person.id, { ...INPUT, requestId: key(2) })).toMatchObject({ ok: true, value: { already: false } });
    expect((await t.db.all('SELECT id FROM properties')).length).toBe(2);
  });

  it('[R16] une demande connue pour un autre client est refusée, sans rien dire de lui ; sans clé valable, rien', async () => {
    const t = await setup();
    await t.biens.create(t.alex, t.person.id, INPUT);
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Noé' });
    expect(await t.biens.create(t.alex, other.id, INPUT)).toEqual({ ok: false, rule: null, code: 'bad_request' });
    expect(await t.biens.create(t.alex, t.person.id, { ...INPUT, requestId: 'pas-une-cle' })).toEqual({ ok: false, rule: null, code: 'bad_request' });
  });

  it('[R13] une panne après la création : le nouvel essai écrit au journal ce qui y manquait, une fois', async () => {
    const t = await setup();
    await t.db.run("CREATE TRIGGER panne_journal BEFORE INSERT ON journal WHEN NEW.type = 'bien.cree' BEGIN SELECT RAISE(ABORT, 'panne'); END");
    await expect(t.biens.create(t.alex, t.person.id, INPUT)).rejects.toThrow(/panne/);
    await t.db.run('DROP TRIGGER panne_journal');
    expect(await t.biens.create(t.alex, t.person.id, INPUT)).toMatchObject({ ok: true, value: { already: true } });
    await t.biens.create(t.alex, t.person.id, INPUT);
    expect((await t.journal.all()).filter((e) => e.type === 'bien.cree')).toHaveLength(1);
  });

  it.each(['business', 'business_walls'])('un cédant (%s) garde son projet de cession, sans projet de vente en plus', async (kind) => {
    const t = await setup();
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: t.person.id, kind: 'sell_business' });
    await t.biens.create(t.alex, t.person.id, { ...INPUT, kind });
    expect(await t.db.all('SELECT kind FROM projects')).toEqual([{ kind: 'sell_business' }]);
    expect((await links(t))[0]!.project_id).toBe(project.id);
  });

  it('[R16] fiche réunie : le projet du membre sert, l’agent du membre crée même si la racine n’a pas d’agent', async () => {
    const t = await setup();
    const root = await t.store.createPerson({ networkId: t.network.id, firstName: 'Léa' });
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: t.person.id, kind: 'sell' });
    await t.unique.merge({ survivorId: root.id, mergedId: t.person.id, reason: 'même mail' });
    const r = await t.biens.create(t.alex, root.id, INPUT);
    expect(r).toMatchObject({ ok: true, value: { already: false } });
    if (!r.ok) return;
    expect((await links(t))[0]!.project_id).toBe(project.id);
    expect(await t.db.first('SELECT agent_id FROM properties')).toEqual({ agent_id: t.alexId });
    // La direction retrouve l'agent unique ; le lien vaut pour le mandat de la fiche réunie.
    expect(await t.biens.create(t.direction, root.id, { ...INPUT, requestId: key(3) })).toMatchObject({ ok: true });
    const modeles = new Modeles(t.db, t.acces, t.journal, { now: t.now });
    const version = await modeles.createVersion(t.direction, 'mandat_vente_simple', 'Mandat de test : {{mandant.nom}}, {{bien.prix}}.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.');
    if (!version.ok) throw new Error(version.code);
    await designerTout(t.db);
    const doc = await modeles.generate(t.alex, { kind: 'mandat_vente_simple', personId: root.id, propertyId: r.value.propertyId, inputs: {} });
    if (!doc.ok) throw new Error(doc.code);
    const check = await new ControlesSignature(t.db, t.acces, t.journal, { now: t.now }).check(t.alex, doc.document.id);
    if (!check.ok) throw new Error(check.code);
    expect(check.value.lines.find((l) => l.check === 'mandants')).toMatchObject({ ok: true });
  });

  it('[R16] un autre réseau : refusé', async () => {
    const t = await setup();
    expect(await t.biens.create(t.outsider, t.person.id, INPUT)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.db.all('SELECT id FROM properties')).toEqual([]);
  });

  it('[R02] une personne exclue : le bien se crée, sans aucun envoi', async () => {
    const t = await setup();
    await t.store.addExclusion({ networkId: t.network.id, personId: t.person.id, reason: 'network_list', notedAt: NOW });
    expect(await t.biens.create(t.alex, t.person.id, INPUT)).toMatchObject({ ok: true });
    expect(await t.db.all("SELECT id FROM messages WHERE direction = 'out'")).toEqual([]);
  });

  it('une référence déjà prise est tirée de nouveau : elle reste unique dans le réseau, et rien n’est créé à moitié', async () => {
    const refs = ['B-AAAAAAAA', 'B-AAAAAAAA', 'B-BBBBBBBB'];
    const t = await setup({ newReference: () => refs.shift()! });
    await t.biens.create(t.alex, t.person.id, INPUT);
    const second = await t.biens.create(t.alex, t.person.id, { ...INPUT, requestId: key(2) });
    expect(second).toMatchObject({ ok: true, value: { reference: 'B-BBBBBBBB' } });
    expect((await t.db.all('SELECT id FROM properties')).length).toBe(2);
    expect((await links(t)).length).toBe(2);
    // Toujours la même référence : le geste échoue, sans bien ni lien orphelin.
    const stuck = await setup({ newReference: () => 'B-CCCCCCCC' });
    await stuck.biens.create(stuck.alex, stuck.person.id, INPUT);
    await expect(stuck.biens.create(stuck.alex, stuck.person.id, { ...INPUT, requestId: key(2) })).rejects.toThrow(/UNIQUE/);
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
    expect(await t.biens.create(t.alex, '00000000-0000-4000-8000-000000000000', { ...INPUT, requestId: key(9) })).toMatchObject({ ok: false, code: 'unknown' });
  });

  it('AU062 · une surface au centième près reste exacte de la saisie à l’annonce, sans arrondi', async () => {
    const t = await setup();
    const r = await t.biens.create(t.alex, t.person.id, { ...INPUT, surfaceM2: 63.42 });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.surfaceM2).toBe(63.42);
    // Des centièmes que le calcul en virgule flottante écrit mal (64,01 × 100) restent acceptés.
    for (const s of [64.01, 65.01, 0.07, 1234.56]) expect((await t.biens.create(t.alex, t.person.id, { ...INPUT, requestId: `0b6f1d2e-9999-4a2b-8c3d-${String(Math.round(s * 100)).padStart(12, '0')}`, surfaceM2: s })).ok).toBe(true);
    expect(await t.db.first('SELECT surface_m2 FROM properties WHERE id = ?', [r.value.propertyId])).toEqual({ surface_m2: 63.42 });
    const facts = { kind: 'home' as const, city: 'Dijon', postalCode: '21000', surfaceM2: 63.42, rooms: 3, bedrooms: null, floor: null, floorsTotal: null, buildYear: null, heating: null, outdoor: [], elevator: null, parkingSpaces: null, landM2: null, energyClass: null, climateClass: null };
    const text = fallbackListing(facts as never);
    expect(`${text.title} ${text.body}`).toContain('63,42 m²');
    expect(traceListing(text.title, text.body, facts as never).ok).toBe(true);
    expect(traceListing(text.title, text.body.replace('63,42', '63'), facts as never).ok).toBe(false);
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
    [{ surfaceM2: 62.555 }, 'bad_surface'],
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
