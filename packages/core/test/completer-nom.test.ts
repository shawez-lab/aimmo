import { expect, it } from 'vitest';
import { Acces, CompleterNom, FicheAgent, FicheClient, FicheUnique, Modeles, NouveauBien, SqlJournalStore, applyMigrations, fromSyncSqlite, type Viewer } from '../src/index.ts';
import { sellerNameWords } from '../src/fiche/noms-vendeur.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé.
const NOW = new Date('2027-02-03T10:00:00.000Z');

async function setup() {
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
  const other = await store.createNetwork('Autre réseau');
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa' });
  const nom = new CompleterNom(db, acces, journal, { now });
  const read = () => db.first<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM persons WHERE id = ?', [person.id]);
  return { db, journal, store, acces, unique, now, network, person, nom, read, alexId: alex.id, alex: as('agent', alex.id), sam: as('agent', sam.id), direction: as('direction', 'd-1'), compliance: as('compliance', 'c-1'), outsider: as('direction', 'd-2', other.id) };
}

describeWithSqlite('SV07 · l’agent complète le nom d’une fiche', () => {
  it('le nom vide se remplit, sans toucher au prénom ; le mandat, incomplet avant, est complet ensuite', async () => {
    const t = await setup();
    const biens = new NouveauBien(t.db, t.acces, t.journal, { now: t.now });
    const b = await biens.create(t.alex, t.person.id, { requestId: '0b6f1d2e-5555-4a2b-8c3d-000000000031', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, priceEur: 150000 });
    if (!b.ok) throw new Error(b.code);
    const modeles = new Modeles(t.db, t.acces, t.journal, { now: t.now });
    const version = await modeles.createVersion(t.direction, 'mandat_vente_simple', 'Mandat de test : {{mandant.nom}}, {{bien.prix}}.\n\nNuméro : {{registre.numero}}.');
    if (!version.ok) throw new Error(version.code);
    const mandate = () => modeles.generate(t.alex, { kind: 'mandat_vente_simple', personId: t.person.id, propertyId: b.value.propertyId, inputs: {} });
    expect(await mandate()).toMatchObject({ ok: true, document: { status: 'incomplet', missing: ['mandant.nom'] } });
    expect(await t.nom.complete(t.alex, t.person.id, { lastName: ' de la  Fontaine ' })).toEqual({ ok: true, value: { firstName: 'Léa', lastName: 'de la Fontaine' } });
    expect(await t.read()).toEqual({ first_name: 'Léa', last_name: 'de la Fontaine' });
    expect(await mandate()).toMatchObject({ ok: true, document: { status: 'complet', missing: [] } });
  });

  it('[R17] un nom déjà écrit n’est pas écrasé, même donné avec un champ vide à côté ; rien n’est écrit à moitié', async () => {
    const t = await setup();
    await t.nom.complete(t.alex, t.person.id, { lastName: 'Exemple' });
    expect(await t.nom.complete(t.alex, t.person.id, { lastName: 'Autre' })).toEqual({ ok: false, rule: null, code: 'already_named' });
    expect(await t.nom.complete(t.alex, t.person.id, { firstName: 'Zoé' })).toEqual({ ok: false, rule: null, code: 'already_named' });
    const nameless = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, lastName: 'Exemple' });
    expect(await t.nom.complete(t.alex, nameless.id, { firstName: 'Zoé', lastName: 'Autre' })).toEqual({ ok: false, rule: null, code: 'already_named' });
    expect(await t.db.first('SELECT first_name FROM persons WHERE id = ?', [nameless.id])).toEqual({ first_name: null });
    expect(await t.read()).toEqual({ first_name: 'Léa', last_name: 'Exemple' });
  });

  it('la même valeur redonnée, après une réponse perdue, réussit sans nouvelle ligne au journal', async () => {
    const t = await setup();
    await t.nom.complete(t.alex, t.person.id, { lastName: 'Exemple' });
    expect(await t.nom.complete(t.alex, t.person.id, { lastName: 'Exemple' })).toMatchObject({ ok: true });
    expect((await t.journal.all()).filter((e) => e.type === 'fiche.nom_complete')).toHaveLength(1);
  });

  it('[R13] aucun nom au journal : seuls les champs remplis', async () => {
    const t = await setup();
    await t.nom.complete(t.alex, t.person.id, { lastName: 'Exemple' });
    const entry = (await t.journal.all()).find((e) => e.type === 'fiche.nom_complete')!;
    expect(entry.data).toEqual({ rule: 'R16', fields: ['lastName'] });
    expect(JSON.stringify(await t.journal.all())).not.toContain('Exemple');
  });

  it('[R16] l’agent de la fiche et la direction complètent ; un autre agent, la conformité, un autre réseau : refusés, au journal', async () => {
    const t = await setup();
    for (const viewer of [t.sam, t.compliance, t.outsider]) expect(await t.nom.complete(viewer, t.person.id, { lastName: 'Exemple' })).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.read())?.last_name).toBeNull();
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length).toBeGreaterThanOrEqual(3);
    expect(await t.nom.complete(t.direction, t.person.id, { lastName: 'Exemple' })).toMatchObject({ ok: true });
    expect(await t.nom.complete(t.alex, '00000000-0000-4000-8000-000000000000', { lastName: 'X' })).toMatchObject({ ok: false, code: 'unknown' });
  });

  it('fiche réunie : le nom va sur la fiche que lisent les documents', async () => {
    const t = await setup();
    const root = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Léa' });
    await t.unique.merge({ survivorId: root.id, mergedId: t.person.id, reason: 'même mail' });
    expect(await t.nom.complete(t.alex, t.person.id, { lastName: 'Exemple' })).toMatchObject({ ok: true });
    expect(await t.db.first('SELECT last_name FROM persons WHERE id = ?', [root.id])).toEqual({ last_name: 'Exemple' });
  });

  it('[R17] un nom déjà écrit sur une fiche réunie compte : un autre est refusé, le même est porté sur la fiche survivante', async () => {
    const t = await setup();
    await t.nom.complete(t.alex, t.person.id, { lastName: 'Exemple' });
    const root = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId });
    await t.unique.merge({ survivorId: root.id, mergedId: t.person.id, reason: 'même mail' });
    expect(await t.nom.complete(t.alex, root.id, { lastName: 'Autre' })).toEqual({ ok: false, rule: null, code: 'already_named' });
    expect(await t.nom.complete(t.alex, root.id, { firstName: 'Zoé' })).toEqual({ ok: false, rule: null, code: 'already_named' });
    expect(await t.nom.complete(t.alex, root.id, { firstName: 'Léa', lastName: 'Exemple' })).toEqual({ ok: true, value: { firstName: 'Léa', lastName: 'Exemple' } });
    expect(await t.db.first('SELECT first_name, last_name FROM persons WHERE id = ?', [root.id])).toEqual({ first_name: 'Léa', last_name: 'Exemple' });
    const summary = await new FicheAgent(t.db, t.acces, { now: t.now }).read(t.alex, t.person.id);
    expect(summary).toMatchObject({ ok: true, value: { firstName: 'Léa', lastName: 'Exemple' } });
  });

  it('un mail signé « Jean Dupont » a tout rangé en prénom : le nom en sort, il n’est pas doublé', async () => {
    const t = await setup();
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Jean Dupont' });
    expect(await t.nom.complete(t.alex, p.id, { lastName: 'dupont' })).toEqual({ ok: true, value: { firstName: 'Jean', lastName: 'dupont' } });
    expect((await t.journal.all()).filter((e) => e.type === 'fiche.nom_complete').at(-1)!.data).toEqual({ rule: 'R16', fields: ['firstName', 'lastName'] });
    // Le prénom n'est que ce nom : rien ne resterait, le geste le dit.
    const q = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Martin' });
    expect(await t.nom.complete(t.alex, q.id, { lastName: 'Martin' })).toEqual({ ok: false, rule: null, code: 'name_in_first_name' });
    expect(await t.db.first('SELECT first_name, last_name FROM persons WHERE id = ?', [q.id])).toEqual({ first_name: 'Martin', last_name: null });
  });

  it('prénom et nom s’écrivent d’un seul geste : une panne n’en laisse pas la moitié', async () => {
    const t = await setup();
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId });
    await t.db.run("CREATE TRIGGER panne_nom BEFORE UPDATE OF last_name ON persons WHEN NEW.last_name = 'Exemple' BEGIN SELECT RAISE(ABORT, 'panne'); END");
    await expect(t.nom.complete(t.alex, p.id, { firstName: 'Zoé', lastName: 'Exemple' })).rejects.toThrow(/panne/);
    expect(await t.db.first('SELECT first_name, last_name FROM persons WHERE id = ?', [p.id])).toEqual({ first_name: null, last_name: null });
  });

  it('[R17] deux gestes croisés ne mêlent pas deux identités : le second, parti d’une lecture ancienne, est refusé', async () => {
    const t = await setup();
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId });
    const [a, b] = await Promise.all([t.nom.complete(t.alex, p.id, { firstName: 'Zoé', lastName: 'Exemple' }), t.nom.complete(t.alex, p.id, { firstName: 'Bob', lastName: 'Martin' })]);
    const row = await t.db.first<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM persons WHERE id = ?', [p.id]);
    expect([`${row!.first_name} ${row!.last_name}`]).toEqual(expect.arrayContaining([expect.stringMatching(/^(Zoé Exemple|Bob Martin)$/)]));
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('[R13] une panne du journal après l’écriture : le nouvel essai écrit la ligne manquante, une fois', async () => {
    const t = await setup();
    await t.db.run("CREATE TRIGGER panne_journal BEFORE INSERT ON journal WHEN NEW.type = 'fiche.nom_complete' BEGIN SELECT RAISE(ABORT, 'panne'); END");
    await expect(t.nom.complete(t.alex, t.person.id, { lastName: 'Exemple' })).rejects.toThrow(/panne/);
    await t.db.run('DROP TRIGGER panne_journal');
    expect(await t.nom.complete(t.alex, t.person.id, { lastName: 'Exemple' })).toMatchObject({ ok: true });
    await t.nom.complete(t.alex, t.person.id, { lastName: 'Exemple' });
    expect((await t.journal.all()).filter((e) => e.type === 'fiche.nom_complete')).toHaveLength(1);
  });

  it('[R19] le nom écrit sur la fiche survivante d’un vendeur est interdit, mot à mot, même si le projet reste sur une fiche réunie', async () => {
    const t = await setup();
    const root = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Léa' });
    const b = await new NouveauBien(t.db, t.acces, t.journal, { now: t.now }).create(t.alex, t.person.id, { requestId: '0b6f1d2e-5555-4a2b-8c3d-000000000032', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60 });
    if (!b.ok) throw new Error(b.code);
    await t.unique.merge({ survivorId: root.id, mergedId: t.person.id, reason: 'même mail' });
    await t.nom.complete(t.alex, root.id, { lastName: 'de la Fontaine' });
    const words = await sellerNameWords(t.db, t.unique, b.value.propertyId);
    expect(words).toEqual(expect.arrayContaining(['fontaine', 'lea']));
    // Le destinataire n'est pas son propre vendeur.
    expect(await sellerNameWords(t.db, t.unique, b.value.propertyId, [root.id, t.person.id])).toEqual([]);
  });

  it.each([
    [{ lastName: 'a@example.test' }, 'bad_name'],
    [{ lastName: '06 00 00 00 00' }, 'bad_name'],
    [{ lastName: 42 }, 'bad_name'],
    [{ lastName: 'x'.repeat(81) }, 'bad_name'],
    [{ lastName: '  ' }, 'no_name'],
    [{}, 'no_name'],
  ])('une saisie fausse est refusée : %j', async (input, code) => {
    const t = await setup();
    expect(await t.nom.complete(t.alex, t.person.id, input)).toEqual({ ok: false, rule: null, code });
    expect((await t.read())?.last_name).toBeNull();
  });
});
