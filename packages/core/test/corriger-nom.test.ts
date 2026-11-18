import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Acces, CompleterNom, CorrigerNom, FicheAgent, FicheClient, FicheUnique, Modeles, NouveauBien, Qualification, SqlJournalStore, applyMigrations, fromSyncSqlite, type Viewer } from '../src/index.ts';
import { sellerNameWords } from '../src/fiche/noms-vendeur.ts';
import { sourcePerson } from '../src/espaces/lecture.ts';
import { nameWords } from '../src/visites/compte-rendu.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { designerTout } from './designation-jeu.ts';

// Tout est inventé.
const NOW = new Date('2027-03-03T10:00:00.000Z');

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
  const other = await store.createNetwork('Autre réseau');
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  const nom = new CorrigerNom(db, acces, journal, { now });
  const read = (id = person.id) => db.first<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM persons WHERE id = ?', [id]);
  return { db, journal, store, acces, unique, now, network, person, nom, read, alexId: alex.id, alex: as('agent', alex.id), direction: as('direction', 'd-1'), compliance: as('compliance', 'c-1'), outsider: as('direction', 'd-2', other.id) };
}

describeWithSqlite('SV10 · la direction corrige un nom', () => {
  it('[R17] le nom change, la valeur d’avant reste lisible par la direction, avec son motif', async () => {
    const t = await setup();
    expect(await t.nom.correct(t.direction, t.person.id, { lastName: ' Exemplaire ', reason: 'faute_de_frappe' })).toEqual({ ok: true, value: { firstName: 'Léa', lastName: 'Exemplaire', changed: true } });
    expect(await t.read()).toEqual({ first_name: 'Léa', last_name: 'Exemplaire' });
    await t.nom.correct(t.direction, t.person.id, { firstName: 'Lia', reason: 'etat_civil' });
    const list = await t.nom.list(t.direction, t.person.id);
    if (!list.ok) throw new Error(list.code);
    expect(list.value).toHaveLength(2);
    expect(list.value[1]).toMatchObject({ oldFirstName: 'Léa', oldLastName: 'Exemple', newFirstName: 'Léa', newLastName: 'Exemplaire', reason: 'faute_de_frappe', actor: 'direction:d-1', at: NOW.toISOString() });
    expect(list.value[0]).toMatchObject({ oldLastName: 'Exemplaire', newFirstName: 'Lia', reason: 'etat_civil' });
  });

  it('[R17] une correction rangée ne change jamais', async () => {
    const t = await setup();
    await t.nom.correct(t.direction, t.person.id, { lastName: 'Autre', reason: 'faute_de_frappe' });
    await expect(t.db.run("UPDATE person_name_corrections SET old_last_name = 'Rien'")).rejects.toThrow(/rien ne change/);
  });

  it('[R13] aucun nom au journal : ni l’ancien, ni le nouveau ; une ligne par correction', async () => {
    const t = await setup();
    await t.nom.correct(t.direction, t.person.id, { firstName: 'Zoé', lastName: 'Martinez', reason: 'demande_de_la_personne' });
    const lines = (await t.journal.all()).filter((e) => e.type === 'fiche.nom_corrige');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.data).toMatchObject({ rule: 'R16', reason: 'demande_de_la_personne', fields: ['firstName', 'lastName'] });
    const text = JSON.stringify(await t.journal.all());
    for (const name of ['Zoé', 'Martinez', 'Léa', 'Exemple']) expect(text).not.toContain(name);
  });

  it('[R16] seule la direction du réseau : agent de la fiche, conformité et autre réseau refusés, au journal, rien d’écrit ni de lu', async () => {
    const t = await setup();
    await t.nom.correct(t.direction, t.person.id, { lastName: 'Secret', reason: 'faute_de_frappe' });
    for (const viewer of [t.alex, t.compliance, t.outsider]) {
      expect(await t.nom.correct(viewer, t.person.id, { lastName: 'Pirate', reason: 'faute_de_frappe' })).toMatchObject({ ok: false, rule: 'R16' });
      expect(await t.nom.list(viewer, t.person.id)).toMatchObject({ ok: false, rule: 'R16' });
    }
    expect(await t.read()).toEqual({ first_name: 'Léa', last_name: 'Secret' });
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.data.kind === 'name_correction');
    expect(refused.map((e) => e.actor)).toEqual(expect.arrayContaining(['agent:' + t.alexId, 'compliance:c-1']));
    expect(await t.nom.correct(t.direction, '0b6f1d2e-5555-4a2b-8c3d-000000000099', { lastName: 'X', reason: 'faute_de_frappe' })).toMatchObject({ ok: false, rule: null, code: 'unknown' });
  });

  it('un motif, un nom ou un champ faux sont refusés, sans rien écrire', async () => {
    const t = await setup();
    const cases: [Record<string, unknown> | null, string][] = [
      [null, 'invalid_body'],
      [{ lastName: 'Autre', reason: 'caprice' }, 'bad_reason'],
      [{ lastName: 'Autre' }, 'bad_reason'],
      [{ lastName: '06 12', reason: 'faute_de_frappe' }, 'bad_name'],
      [{ lastName: 12, reason: 'faute_de_frappe' }, 'bad_name'],
      [{ reason: 'faute_de_frappe' }, 'no_name'],
      [{ lastName: 'Autre', reason: 'faute_de_frappe', agentId: 'x' }, 'unexpected_field'],
      [{ firstName: null, lastName: '  ', reason: 'faute_de_frappe' }, 'name_required'],
    ];
    for (const [input, code] of cases) expect(await t.nom.correct(t.direction, t.person.id, input)).toEqual({ ok: false, rule: null, code });
    expect(await t.db.first('SELECT 1 FROM person_name_corrections')).toBeNull();
    expect(await t.read()).toEqual({ first_name: 'Léa', last_name: 'Exemple' });
  });

  it('document déjà généré inchangé ; le suivant lit le nom corrigé', async () => {
    const t = await setup();
    const biens = new NouveauBien(t.db, t.acces, t.journal, { now: t.now });
    const b = await biens.create(t.alex, t.person.id, { requestId: '0b6f1d2e-5555-4a2b-8c3d-000000000041', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, priceEur: 150000 });
    if (!b.ok) throw new Error(b.code);
    const modeles = new Modeles(t.db, t.acces, t.journal, { now: t.now });
    const version = await modeles.createVersion(t.direction, 'mandat_vente_simple', 'Mandat de test : {{mandant.nom}}, {{bien.prix}}.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.');
    if (!version.ok) throw new Error(version.code);
    await designerTout(t.db);
    const generate = () => modeles.generate(t.alex, { kind: 'mandat_vente_simple', personId: t.person.id, propertyId: b.value.propertyId, inputs: {} });
    const before = await generate();
    if (!before.ok) throw new Error(before.code);
    const stored = () => t.db.first<{ content: string; content_hash: string }>('SELECT content, content_hash FROM documents WHERE id = ?', [before.document.id]);
    const saved = await stored();
    expect(saved!.content).toContain('Léa Exemple');
    await t.nom.correct(t.direction, t.person.id, { lastName: 'Exemplaire', reason: 'faute_de_frappe' });
    expect(await stored()).toEqual(saved);
    const after = await generate();
    if (!after.ok) throw new Error(after.code);
    expect(after.document.id).not.toBe(before.document.id);
    expect(after.document.content).toContain('Léa Exemplaire');
  });

  it('un prénom qui n’est que le nom : la direction le range, l’agent peut ensuite remplir le vrai prénom, et cela se journalise', async () => {
    const t = await setup();
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Dupont' });
    const completer = new CompleterNom(t.db, t.acces, t.journal, { now: t.now });
    expect(await completer.complete(t.alex, p.id, { lastName: 'Dupont' })).toMatchObject({ ok: false, code: 'name_in_first_name' });
    expect(await t.nom.correct(t.direction, p.id, { firstName: null, lastName: 'Dupont', reason: 'nom_dans_prenom' })).toMatchObject({ ok: true, value: { firstName: null, lastName: 'Dupont' } });
    expect(await completer.complete(t.alex, p.id, { firstName: 'Jean' })).toEqual({ ok: true, value: { firstName: 'Jean', lastName: 'Dupont' } });
    // Un prénom déjà rempli une fois par l’agent, vidé par la direction, puis rempli de nouveau : le second geste a sa ligne [R13].
    await t.nom.correct(t.direction, p.id, { firstName: null, reason: 'faute_de_frappe' });
    await completer.complete(t.alex, p.id, { firstName: 'Jeanne' });
    expect((await t.journal.bySubject(`person:${p.id}`)).filter((e) => e.type === 'fiche.nom_complete').map((e) => e.data.fields)).toEqual([['firstName'], ['firstName']]);
  });

  it('fiche réunie : la correction va sur la survivante, l’historique suit, et un nom d’une fiche réunie ne se vide pas', async () => {
    const t = await setup();
    const survivor = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, lastName: 'Survie' });
    const merged = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Ancien' });
    await t.unique.merge({ survivorId: survivor.id, mergedId: merged.id, reason: 'même mail' });
    expect(await t.nom.correct(t.direction, merged.id, { firstName: null, reason: 'faute_de_frappe' })).toEqual({ ok: false, rule: null, code: 'name_on_merged_fiche' });
    expect(await t.nom.correct(t.direction, merged.id, { firstName: 'Nouveau', reason: 'faute_de_frappe' })).toMatchObject({ ok: true, value: { firstName: 'Nouveau', lastName: 'Survie' } });
    expect(await t.read(survivor.id)).toEqual({ first_name: 'Nouveau', last_name: 'Survie' });
    expect(await t.read(merged.id)).toEqual({ first_name: 'Ancien', last_name: null });
    const list = await t.nom.list(t.direction, survivor.id);
    expect(list).toMatchObject({ ok: true, value: [{ oldFirstName: 'Ancien', newFirstName: 'Nouveau' }] });
  });

  it('la même valeur redonnée : réussit, sans seconde correction ; une panne du journal se répare au nouvel essai [R13]', async () => {
    const t = await setup();
    await t.db.run("CREATE TRIGGER panne_journal BEFORE INSERT ON journal WHEN NEW.type = 'fiche.nom_corrige' BEGIN SELECT RAISE(ABORT, 'panne'); END");
    await expect(t.nom.correct(t.direction, t.person.id, { lastName: 'Autre', reason: 'faute_de_frappe' })).rejects.toThrow(/panne/);
    await t.db.run('DROP TRIGGER panne_journal');
    expect(await t.nom.correct(t.direction, t.person.id, { lastName: 'Autre', reason: 'faute_de_frappe' })).toMatchObject({ ok: true, value: { changed: false } });
    await t.nom.correct(t.direction, t.person.id, { lastName: 'Autre', reason: 'faute_de_frappe' });
    expect(await t.db.all('SELECT id FROM person_name_corrections')).toHaveLength(1);
    expect((await t.journal.all()).filter((e) => e.type === 'fiche.nom_corrige')).toHaveLength(1);
  });

  it('[R17] deux corrections croisées : une seule passe, l’autre le dit, et l’historique reste juste', async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.nom.correct(t.direction, t.person.id, { lastName: 'Un', reason: 'faute_de_frappe' }), t.nom.correct(t.direction, t.person.id, { lastName: 'Deux', reason: 'faute_de_frappe' })]);
    const rows = await t.db.all<{ old_last_name: string; new_last_name: string }>('SELECT old_last_name, new_last_name FROM person_name_corrections ORDER BY rowid');
    const row = await t.read();
    expect(row!.last_name).toBe(rows.at(-1)!.new_last_name);
    if (a.ok && b.ok) expect(rows[1]!.old_last_name).toBe(rows[0]!.new_last_name);
    else expect([a, b].find((r) => !r.ok)).toMatchObject({ code: 'name_changed' });
  });

  it('[R15] [R19] [R161] un nom corrigé reste retenu des textes : l’IA, l’autre partie, les espaces, les textes publics', async () => {
    const t = await setup();
    await t.nom.correct(t.direction, t.person.id, { firstName: 'Lia', lastName: 'Durand', reason: 'etat_civil' });
    // L'IA : le masque lit l'ancien nom et le nouveau.
    const q = new Qualification(t.db, t.store, t.unique, {} as never, {} as never, t.journal, { now: t.now }) as unknown as { namesOf(id: string, sender: string | null): Promise<string[]> };
    expect(await q.namesOf(t.person.id, null)).toEqual(expect.arrayContaining(['Léa', 'Exemple', 'Lia', 'Durand']));
    // L'autre partie : les mots interdits du vendeur.
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: t.person.id, kind: 'sell' });
    const property = await t.store.createProperty({ networkId: t.network.id, agentId: t.alexId, reference: 'B-TEST', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60 } as never);
    await t.store.linkProjectProperty({ networkId: t.network.id, agentId: t.alexId, projectId: project.id, propertyId: property.id, role: 'owned' });
    const words = await sellerNameWords(t.db, t.unique, property.id);
    for (const name of ['Exemple', 'Durand']) expect(words).toEqual(expect.arrayContaining(nameWords(name)));
    // Les espaces des clients.
    const source = await sourcePerson(t.db, t.unique, t.person.id);
    expect(source.lastName).toContain('Exemple');
    expect(source.lastName).toContain('Durand');
    // Aucune ligne d'avant pour une autre fiche : la vue ne mêle rien.
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Noa' });
    expect(await t.db.all('SELECT first_name, last_name FROM person_known_names WHERE id = ?', [other.id])).toEqual([{ first_name: 'Noa', last_name: null }]);
  });

  it('[R15] [R19] [R46] chaque garde lit les noms d’avant : aucune ne repart de la seule table des fiches', () => {
    for (const file of ['qualification/qualification.ts', 'fiche/noms-vendeur.ts', 'espaces/lecture.ts', 'apres-vente/demandes-avis.ts', 'apres-vente/relances-apres-vente.ts', 'apres-vente/remerciements.ts', 'dossiers/relances.ts', 'attirer/quartier.ts', 'attirer/fiche-google.ts', 'visites/point-semaine.ts']) {
      const code = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(code, file).toContain('person_known_names');
      expect(code, file).not.toMatch(/first_name, last_name FROM persons WHERE (id IN|network_id)/);
    }
  });

  it('[R16] la fiche de l’application annonce le geste à la direction seule', async () => {
    const t = await setup();
    const fiche = new FicheAgent(t.db, t.acces, { now: t.now });
    expect(await fiche.read(t.direction, t.person.id)).toMatchObject({ ok: true, value: { nameCorrectable: true } });
    const agent = await fiche.read(t.alex, t.person.id);
    expect(agent.ok && 'nameCorrectable' in agent.value).toBe(false);
  });
});
