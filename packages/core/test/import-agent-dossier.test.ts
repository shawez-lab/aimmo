import { beforeEach, expect, it } from 'vitest';
import { DecisionEnvoi, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type SqlValue } from '../src/index.ts';
import { ImportAgent, pieceCategory, readAgentPieces, safeLink } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase, type SqliteDatabase } from './sqlite.ts';

// AU030 · Biens, fichiers et liens inventés : example.org et des références d'essai.
const NOW = new Date('2027-07-15T08:00:00.000Z');

interface World {
  raw: SqliteDatabase;
  db: SqlDatabase;
  importer: ImportAgent;
  net: string;
  agent: string;
  other: string;
  journal: SqlJournalStore;
}

let w: World;
const me = (): { role: 'agent'; userId: string; networkId: string } => ({ role: 'agent', userId: w.agent, networkId: w.net });
const count = async (sql: string, params: SqlValue[] = []): Promise<number> => Number((await w.db.first<{ n: number }>(sql, params))?.n ?? 0);
const snapshot = (): string => {
  const tables = w.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('journal', 'journal_entries') ORDER BY name").all() as { name: string }[];
  return JSON.stringify(tables.map(({ name }) => [name, w.raw.prepare(`SELECT * FROM "${name}"`).all()]));
};
const propertyOf = async (reference: string): Promise<string> =>
  (await w.db.first<{ property_id: string }>('SELECT property_id FROM agent_import_properties WHERE export_reference = ? AND agent_id = ?', [reference, w.agent]))!.property_id;

/** L'export des biens de l'ancien logiciel. */
const PROPERTIES = ['Référence;Type;Code postal;Ville;Surface;Prix', 'V100;Maison;21000;Dijon;120;320000', 'V200;Appartement;21000;Dijon;64;189000'].join('\n');

/** Le dossier témoin : photos, diagnostics, mandats, annonce, document, et des pièces à ne pas reprendre. */
const PIECES = [
  'Référence bien;Type de pièce;Nom du fichier;Lien;Date;Signé;Portail',
  'V100;Photo;facade.jpg;https://medias.example.org/v100/facade.jpg;2027-03-01;;', // 2
  'V100;Photo;sejour.jpg;;2027-03-01;;', // 3
  'V100;DPE;dpe-v100.pdf;;2027-02-10;;', // 4
  'V100;Diagnostic amiante;amiante-v100.pdf;;2027-02-10;;', // 5
  'V100;Mandat exclusif;mandat-v100.pdf;;2027-03-02;oui;', // 6 : mandat signé
  'V100;Annonce;;https://annonces.example.org/v100;2027-03-05;;Portail Essai', // 7 : diffusion, un lien
  'V100;Titre de propriété;titre-v100.pdf;;;;', // 8
  'V200;Mandat;mandat-v200.pdf;;2027-04-01;non;', // 9 : mandat repris, signature non dite : à regarder
  ';Photo;orpheline.jpg;;;;', // 10 : aucun bien
  'V999;Photo;inconnu.jpg;;;;', // 11 : bien absent de l'export des biens
  'V100;Fax;fax.pdf;;;;', // 12 : type inconnu
  'V100;Photo;;;;;', // 13 : ni fichier ni lien
  'V100;Annonce;;http://annonces.example.org/v100-clair;;;', // 14 : lien non sûr, seul
].join('\n');

describeWithSqlite('AU030 · les biens repris gardent leur dossier : photos, diagnostics, mandats signés et diffusion', () => {
  beforeEach(async () => {
    const raw = openMemoryDatabase();
    const db = fromSyncSqlite(raw);
    await applyMigrations(db, loadMigrations());
    const now = (): Date => NOW;
    const fiches = new FicheClient(db, { now });
    const unique = new FicheUnique(db, fiches, { now });
    const envoi = new DecisionEnvoi(db, fiches, unique, { now });
    const journal = new SqlJournalStore(db);
    const importer = new ImportAgent(db, fiches, unique, envoi, journal, { now });
    const net = (await fiches.createNetwork('Réseau test')).id;
    const agent = (await fiches.createAgent({ networkId: net, firstName: 'Nouvel', lastName: 'Agent' })).id;
    const other = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Voisin' })).id;
    w = { raw, db, importer, net, agent, other, journal };
  });

  it('[R84] constat reproduit : le dossier témoin garde ses photos, diagnostics, mandats, annonce et documents, sur son bien', async () => {
    const r = await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES, pieces: PIECES });
    if (!r.ok) throw new Error(r.code);
    expect(r.report.properties.created).toBe(2);
    expect(r.report.dossier.kept).toEqual({ photo: 2, diagnostic: 2, mandate: 2, diffusion: 1, document: 1 });

    const one = await w.importer.dossierOf(me(), await propertyOf('V100'));
    if (!one.ok) throw new Error(one.code);
    expect(one.value.counts).toEqual({ photo: 2, diagnostic: 2, mandate: 1, diffusion: 1, document: 1 });
    expect(one.value.pieces.map((p) => [p.category, p.label, p.fileName, p.link, p.datedOn, p.signed, p.portal, p.from])).toEqual([
      ['mandate', 'Mandat exclusif', 'mandat-v100.pdf', null, '2027-03-02', true, null, 'Hektor'],
      ['diagnostic', 'DPE', 'dpe-v100.pdf', null, '2027-02-10', null, null, 'Hektor'],
      ['diagnostic', 'Diagnostic amiante', 'amiante-v100.pdf', null, '2027-02-10', null, null, 'Hektor'],
      ['photo', 'Photo', 'facade.jpg', 'https://medias.example.org/v100/facade.jpg', '2027-03-01', null, null, 'Hektor'],
      ['photo', 'Photo', 'sejour.jpg', null, '2027-03-01', null, null, 'Hektor'],
      ['diffusion', 'Annonce', null, 'https://annonces.example.org/v100', '2027-03-05', null, 'Portail Essai', 'Hektor'],
      ['document', 'Titre de propriété', 'titre-v100.pdf', null, null, null, null, 'Hektor'],
    ]);
    const two = await w.importer.dossierOf(me(), await propertyOf('V200'));
    if (!two.ok) throw new Error(two.code);
    expect(two.value.pieces.map((p) => [p.category, p.fileName, p.signed])).toEqual([['mandate', 'mandat-v200.pdf', false]]);
  });

  it("[R84] chaque pièce écartée est comptée avec sa ligne et sa raison, à l'aperçu avant validation, puis le même bilan à l'import", async () => {
    const before = snapshot();
    const p = await w.importer.preview(me(), w.agent, { format: 'hektor', properties: PROPERTIES, pieces: PIECES });
    if (!p.ok) throw new Error(p.code);
    // L'aperçu n'écrit rien, hors du journal.
    expect(snapshot()).toBe(before);
    const notTaken = { no_property: [10], unknown_property: [11], other_agent: [], unknown_type: [12], no_source: [13], unsafe_link: [14] };
    expect(p.report.properties).toEqual({ read: 2, new: 2, known: 0, unreadableLines: [] });
    expect(p.report.dossier).toEqual({ read: 13, kept: { photo: 2, diagnostic: 2, mandate: 2, diffusion: 1, document: 1 }, known: 0, notTaken, unsignedMandateLines: [9] });
    expect(p.report.summary).toContain('5 pièces non reprises, listées par leur numéro de ligne et leur raison.');
    expect(p.report.summary.at(-1)).toBe("Rien n'est encore rangé : validez pour lancer l'import.");

    const r = await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES, pieces: PIECES });
    if (!r.ok) throw new Error(r.code);
    expect(r.report.dossier).toEqual(p.report.dossier);
    expect(r.report.summary).toContain('1 mandat sans signature dite, listé par son numéro de ligne.');
    expect(r.report.summary).toContain("Les annonces de l'ancien logiciel restent des liens : rien n'est republié, le bien reste en brouillon.");
    expect(await count('SELECT count(*) AS n FROM agent_import_property_pieces')).toBe(8);
  });

  it('[R18] relancé, ni le bien ni ses pièces ne doublent ; une pièce deux fois dans l\'export est comptée une fois', async () => {
    const twice = `${PIECES}\nV100;Photo;sejour.jpg;;2027-03-01;;`;
    const first = await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES, pieces: twice });
    if (!first.ok) throw new Error(first.code);
    expect(first.report.dossier.known).toBe(1);
    const again = await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES, pieces: twice });
    if (!again.ok) throw new Error(again.code);
    expect(again.report.dossier.kept).toEqual({ photo: 0, diagnostic: 0, mandate: 0, diffusion: 0, document: 0 });
    expect(again.report.dossier.known).toBe(9);
    expect(await count('SELECT count(*) AS n FROM agent_import_property_pieces')).toBe(8);
    // Un aperçu après coup dit la même chose : tout est déjà repris.
    const p = await w.importer.preview(me(), w.agent, { format: 'hektor', pieces: twice });
    if (!p.ok) throw new Error(p.code);
    expect([p.report.dossier.known, p.report.dossier.kept.photo]).toEqual([9, 0]);
  });

  it("[R84] un dossier déposé après ses biens les retrouve ; le bien d'un autre agent n'est jamais touché", async () => {
    await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES });
    // Le bien V200 est passé depuis à un autre agent : ses pièces ne lui sont pas ajoutées.
    w.raw.prepare('UPDATE properties SET agent_id = ? WHERE id = ?').run(w.other, await propertyOf('V200'));
    const r = await w.importer.run(me(), w.agent, { format: 'hektor', pieces: PIECES });
    if (!r.ok) throw new Error(r.code);
    expect(r.report.dossier.kept).toEqual({ photo: 2, diagnostic: 2, mandate: 1, diffusion: 1, document: 1 });
    expect(r.report.dossier.notTaken.other_agent).toEqual([9]);
    // Le même dossier déposé sous un autre logiciel ne retrouve pas les biens d'Hektor : rien n'est deviné.
    const apimo = await w.importer.run(me(), w.agent, { format: 'apimo', pieces: PIECES });
    if (!apimo.ok) throw new Error(apimo.code);
    expect(apimo.report.dossier.notTaken.unknown_property).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 11]);
  });

  it("[R84] rien n'est publié ni envoyé : le bien reste en brouillon, l'annonce reprise reste un lien", async () => {
    await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES, pieces: PIECES });
    expect(await count("SELECT count(*) AS n FROM properties WHERE status <> 'draft'")).toBe(0);
    for (const table of ['listing_pushes', 'listing_versions', 'send_log', 'trial_outbox']) expect([table, await count(`SELECT count(*) AS n FROM ${table}`)]).toEqual([table, 0]);
  });

  it("[R16] le dossier repris se lit par l'agent du bien ou la direction ; un autre agent est refusé, au journal", async () => {
    await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES, pieces: PIECES });
    const id = await propertyOf('V100');
    const other = await w.importer.dossierOf({ role: 'agent', userId: w.other, networkId: w.net }, id);
    expect(other).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    const direction = await w.importer.dossierOf({ role: 'direction', userId: 'dir-1', networkId: w.net }, id);
    expect(direction.ok && direction.value.pieces.length).toBe(7);
    // Chaque lecture réussie est au journal avant d'être rendue [R16].
    const reads = (await w.journal.all()).filter((e) => e.type === 'bien.lu');
    expect(reads.map((e) => [e.subject, (e.data as { via: string; pieces: number }).via, (e.data as { pieces: number }).pieces])).toEqual([[`property:${id}`, 'import.dossier', 7]]);
    const refused = (await w.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refused.map((e) => [e.subject, (e.data as { kind: string }).kind])).toEqual([[`property:${id}`, 'agent_import_dossier']]);
    // Un agent ne prévisualise pas l'import d'un autre [R16].
    expect(await w.importer.preview({ role: 'agent', userId: w.other, networkId: w.net }, w.agent, { format: 'hektor', pieces: PIECES })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
  });

  it('[R13] au journal, des nombres seulement : jamais un nom de fichier ni un lien', async () => {
    await w.importer.preview(me(), w.agent, { format: 'hektor', properties: PROPERTIES, pieces: PIECES });
    await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES, pieces: PIECES });
    const text = JSON.stringify(await w.journal.all());
    for (const secret of ['facade.jpg', 'mandat-v100', 'annonces.example.org', 'medias.example.org', 'Portail Essai']) expect(text).not.toContain(secret);
    const run = (await w.journal.all()).find((e) => e.type === 'reseau.import');
    expect(run?.data).toMatchObject({ pieces: 8, piecesNotTaken: 5 });
  });

  it('lecture : les sortes de pièces, la signature dite, et seuls les liens https sans identifiant', async () => {
    expect(['Photos', 'DPE', 'Diagnostic électricité', 'Mandat signé', 'Avenant n°1', 'Annonce SeLoger', 'Plan', 'Fax'].map(pieceCategory)).toEqual([
      'photo', 'diagnostic', 'diagnostic', 'mandate', 'mandate', 'diffusion', 'document', undefined,
    ]);
    expect([safeLink('https://example.org/a'), safeLink('http://example.org/a'), safeLink('https://moi:secret@example.org/a'), safeLink('javascript:alert(1)')]).toEqual([
      'https://example.org/a', null, null, null,
    ]);
    const reading = await readAgentPieces(
      ['Ref;Type;Fichier;Signature', 'A;Mandat signé;m1.pdf;', 'A;Mandat non signé;m2.pdf;', 'A;Mandat;m3.pdf;12/03/2027', 'A;Mandat;m4.pdf;', 'A;Photo;p.jpg;oui'].join('\n'),
      'excel',
      'agent-x',
    );
    expect(reading.lines.map((l) => [l.category, l.signed])).toEqual([['mandate', true], ['mandate', false], ['mandate', true], ['mandate', null], ['photo', null]]);
    await expect(readAgentPieces('Type;Commentaire\nPhoto;x', 'excel', 'agent-x')).rejects.toThrow(/référence/);
  });
});
