import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, conformite, fromSyncSqlite, verifyChain, type SqlDatabase, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const { readSchema, describeGap, isPersonalColumn, REGISTRE_TRAITEMENTS, TABLES_SANS_DONNEE_PERSONNELLE, COLONNES_SANS_DONNEE_PERSONNELLE } = conformite;
const checkRegistry = (schema: conformite.Schema, registre: readonly conformite.Traitement[], sansDonnee: Readonly<Record<string, string>>, colonnes = COLONNES_SANS_DONNEE_PERSONNELLE) =>
  conformite.checkRegistry(schema, registre, sansDonnee, colonnes);

// Une migration de test inventée, ajoutée après toutes les vraies.
const extra = (sql: string) => [...loadMigrations(), { id: '9999_essai', sql }];
const gapsOf = (sql: string) => checkRegistry(readSchema(extra(sql)), REGISTRE_TRAITEMENTS, TABLES_SANS_DONNEE_PERSONNELLE);

describe('L06 · registre des traitements vérifié contre la base', () => {
  it('[R95] chaque table des migrations figure au registre, avec ses colonnes personnelles exactes', () => {
    const gaps = checkRegistry(readSchema(loadMigrations()), REGISTRE_TRAITEMENTS, TABLES_SANS_DONNEE_PERSONNELLE);
    // Le message d'échec dit quoi ajouter au registre, table par table.
    expect(gaps.map(describeGap)).toEqual([]);
  });

  it('[R95] chaque traitement a sa finalité, sa base légale, ses données, sa durée et ses destinataires', () => {
    expect(REGISTRE_TRAITEMENTS.length).toBeGreaterThan(10);
    for (const t of REGISTRE_TRAITEMENTS) {
      expect(t.finalite.length, t.id).toBeGreaterThan(20);
      expect(Object.keys(conformite.LEGAL_BASIS_LABELS), t.id).toContain(t.baseLegale);
      expect(t.duree, t.id).toMatch(/\d|durée|demande/);
      expect(t.personnes.length * t.donnees.length * t.destinataires.length * t.sousTraitants.length, t.id).toBeGreaterThan(0);
    }
    // Les tables qui portent le registre des mandats et l'anti-blanchiment sont sous obligation légale.
    const basisOf = (table: string) => REGISTRE_TRAITEMENTS.find((t) => table in t.tables)!.baseLegale;
    for (const table of ['mandate_register', 'compliance_vault_pieces', 'risk_sheets', 'invoices', 'journal']) expect(basisOf(table), table).toBe('obligation_legale');
    // Une table sans donnée personnelle dit pourquoi.
    for (const [table, reason] of Object.entries(TABLES_SANS_DONNEE_PERSONNELLE)) expect(reason.length, table).toBeGreaterThan(15);
  });

  it('[R95] une table de test ajoutée sans registre fait échouer la vérification', () => {
    const gaps = gapsOf('CREATE TABLE IF NOT EXISTS essai_contacts (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL);');
    expect(gaps).toEqual([{ kind: 'table_absente', table: 'essai_contacts', migration: '9999_essai', columns: ['person_id', 'email'] }]);
    expect(describeGap(gaps[0]!)).toBe("la table essai_contacts (migration 9999_essai) n'est pas au registre des traitements : colonnes personnelles person_id, email");
    // Même une table sans donnée personnelle doit être inscrite, avec sa raison.
    expect(gapsOf('CREATE TABLE essai_compteur (day TEXT PRIMARY KEY, n INTEGER NOT NULL);')).toMatchObject([{ kind: 'table_absente', table: 'essai_compteur', columns: [] }]);
  });

  it('[R95] une colonne de donnée personnelle ajoutée à une table inscrite fait échouer la vérification', () => {
    expect(gapsOf('ALTER TABLE persons ADD COLUMN birth_town TEXT;')).toEqual([{ kind: 'colonne_absente', table: 'persons', traitement: 'relation-clients', column: 'birth_town' }]);
    // Les données courantes d'une personne sont toutes reconnues.
    for (const column of ['birth_date', 'iban', 'mobile', 'firstname', 'nationality', 'ip', 'latitude', 'photo_ref', 'income_eur', 'street']) {
      expect(gapsOf(`ALTER TABLE persons ADD COLUMN ${column} TEXT;`), column).toEqual([{ kind: 'colonne_absente', table: 'persons', traitement: 'relation-clients', column }]);
      expect(gapsOf(`ALTER TABLE listing_views ADD COLUMN ${column} TEXT;`), column).toEqual([{ kind: 'technique_avec_donnee', table: 'listing_views', columns: [column] }]);
    }
    // Même une colonne au nom anodin doit être classée : rien n'entre sans qu'on l'ait regardé.
    expect(gapsOf('ALTER TABLE persons ADD COLUMN archived_at TEXT;')).toEqual([{ kind: 'colonne_non_classee', table: 'persons', column: 'archived_at' }]);
    expect(gapsOf('ALTER TABLE listing_views ADD COLUMN xyz TEXT;')).toEqual([{ kind: 'colonne_non_classee', table: 'listing_views', column: 'xyz' }]);
    // Une colonne renommée en donnée personnelle est vue.
    expect(gapsOf('ALTER TABLE listing_views RENAME COLUMN day TO visitor_email;')).toEqual([
      { kind: 'colonne_inconnue', table: 'listing_views', traitement: 'sans donnée personnelle', column: 'day' },
      { kind: 'technique_avec_donnee', table: 'listing_views', columns: ['visitor_email'] },
    ]);
    // Une colonne classée sans donnée personnelle au nom personnel est refusée.
    const wrong = { ...COLONNES_SANS_DONNEE_PERSONNELLE, persons: [...COLONNES_SANS_DONNEE_PERSONNELLE.persons!, 'first_name'] };
    expect(checkRegistry(readSchema(loadMigrations()), REGISTRE_TRAITEMENTS, TABLES_SANS_DONNEE_PERSONNELLE, wrong)).toEqual([{ kind: 'colonne_mal_classee', table: 'persons', column: 'first_name' }]);
    // Une table dite « sans donnée personnelle » qui en gagne une est refusée.
    expect(gapsOf('ALTER TABLE listing_views ADD COLUMN visitor_phone TEXT;')).toEqual([{ kind: 'technique_avec_donnee', table: 'listing_views', columns: ['visitor_phone'] }]);
  });

  it('[R95] le registre ne cite rien qui n’existe pas, et chaque table une seule fois', () => {
    const schema = readSchema(loadMigrations());
    const ghost = [{ ...REGISTRE_TRAITEMENTS[0]!, id: 'fantome', tables: { table_fantome: ['person_id'] } }];
    expect(checkRegistry(schema, [...REGISTRE_TRAITEMENTS, ...ghost], TABLES_SANS_DONNEE_PERSONNELLE)).toEqual([{ kind: 'table_inconnue', table: 'table_fantome', where: 'fantome' }]);
    const twice = [{ ...REGISTRE_TRAITEMENTS[0]!, id: 'double', tables: { persons: REGISTRE_TRAITEMENTS[0]!.tables.persons! } }];
    expect(checkRegistry(schema, [...REGISTRE_TRAITEMENTS, ...twice], TABLES_SANS_DONNEE_PERSONNELLE)).toEqual([{ kind: 'table_en_double', table: 'persons', where: ['relation-clients', 'double'] }]);
    const wrongColumn = REGISTRE_TRAITEMENTS.map((t) => (t.id === 'relation-clients' ? { ...t, tables: { ...t.tables, persons: [...t.tables.persons!, 'nickname'] } } : t));
    expect(checkRegistry(schema, wrongColumn, TABLES_SANS_DONNEE_PERSONNELLE)).toEqual([{ kind: 'colonne_inconnue', table: 'persons', traitement: 'relation-clients', column: 'nickname' }]);
    const noBasis = REGISTRE_TRAITEMENTS.map((t, i) => (i === 0 ? { ...t, duree: ' ' } : t));
    expect(checkRegistry(schema, noBasis, TABLES_SANS_DONNEE_PERSONNELLE)).toEqual([{ kind: 'traitement_incomplet', traitement: 'relation-clients', field: 'duree' }]);
  });

  it('[R95] la lecture des migrations suit commentaires, contraintes et colonnes ajoutées', () => {
    const schema = readSchema([
      { id: '0002_b', sql: "ALTER TABLE t ADD COLUMN phone TEXT; -- CREATE TABLE piege (email TEXT);\nALTER TABLE t ADD note TEXT;" },
      { id: '0001_a', sql: "CREATE TABLE IF NOT EXISTS t (\n  id TEXT PRIMARY KEY, -- l'identifiant, (avec parenthèse\n  kind TEXT CHECK (kind IN ('a,b', 'c')),\n  UNIQUE (id, kind),\n  FOREIGN KEY (id) REFERENCES u (id)\n);" },
    ]);
    expect([...schema.keys()]).toEqual(['t']);
    expect(schema.get('t')!.columns).toEqual(['id', 'kind', 'phone', 'note']);
    // Temporaire, avec schéma, renommée : chaque forme est lue.
    const forms = readSchema([
      { id: '0001', sql: 'CREATE TEMP TABLE a (person_id TEXT); CREATE TEMPORARY TABLE IF NOT EXISTS b (email TEXT); CREATE TABLE main.c (phone TEXT);' },
      { id: '0002', sql: 'ALTER TABLE main.c ADD COLUMN body TEXT; ALTER TABLE c RENAME TO d; ALTER TABLE d DROP COLUMN phone; ALTER TABLE a RENAME person_id TO agent_id;' },
    ]);
    expect(Object.fromEntries([...forms].map(([k, v]) => [k, v.columns]))).toEqual({ a: ['agent_id'], b: ['email'], d: ['body'] });
    // Crochets, commentaires au milieu, textes qui imitent une instruction : rien ne cache une table.
    const hidden = readSchema([
      { id: '0001', sql: "CREATE TABLE [crochets] ([email] TEXT); CREATE TABLE /* contacts */ cachee (phone TEXT); CREATE TABLE \"guillemets\" (body TEXT CHECK (body <> 'CREATE TABLE x (y)'));" },
    ]);
    expect(Object.fromEntries([...hidden].map(([k, v]) => [k, v.columns]))).toEqual({ crochets: ['email'], cachee: ['phone'], guillemets: ['body'] });
    expect(gapsOf('CREATE TABLE [unregistered_contacts] (email TEXT);')).toMatchObject([{ kind: 'table_absente', table: 'unregistered_contacts' }]);
    expect(gapsOf('CREATE TABLE /* contact table */ unregistered_contacts (email TEXT);')).toMatchObject([{ kind: 'table_absente', table: 'unregistered_contacts' }]);
    expect(() => readSchema([{ id: '0001', sql: 'CREATE TABLE "avec espace" (email TEXT);' }])).toThrow('forme que le registre ne sait pas lire');
    // Une table retirée puis recréée avec une donnée personnelle de plus est vue.
    expect(gapsOf('DROP TABLE IF EXISTS listing_views; CREATE TABLE listing_views (id TEXT PRIMARY KEY, property_id TEXT, network_id TEXT, channel TEXT, day TEXT, views INTEGER, recorded_at TEXT, email TEXT);')).toEqual([
      { kind: 'technique_avec_donnee', table: 'listing_views', columns: ['email'] },
    ]);
    expect(gapsOf('DROP TABLE listing_views;')).toEqual([{ kind: 'table_inconnue', table: 'listing_views', where: 'sans donnée personnelle' }]);
    // Une forme inconnue arrête la vérification au lieu de passer en silence.
    expect(() => readSchema([{ id: '0001', sql: 'CREATE VIRTUAL TABLE v USING fts5(body);' }])).toThrow('forme que le registre ne sait pas lire');
    expect(() => readSchema([{ id: '0001', sql: 'CREATE TABLE v AS SELECT * FROM persons;' }])).toThrow('table créée sans liste de colonnes');
    expect(() => readSchema([{ id: '0001', sql: 'ALTER TABLE inconnue ADD COLUMN email TEXT;' }])).toThrow('table inconnue');
    expect(() => readSchema([{ id: '0001', sql: 'CREATE TABLE t (id TEXT); ALTER TABLE t ALTER email;' }])).toThrow('modification');
    for (const c of ['confirmation_to', 'person_id', 'buyer_person_id', 'first_name', 'email', 'phone', 'body', 'recorded_by', 'validator_name', 'scan_ref', 'signed_ref']) expect(isPersonalColumn(c), c).toBe(true);
    for (const c of ['id', 'network_id', 'created_at', 'status', 'kind', 'price_eur', 'surface_m2', 'due_day', 'hash']) expect(isPersonalColumn(c), c).toBe(false);
  });
});

// Réseau et responsable inventés. Horloge simulée, à 10 h à Paris.
let clock = Date.parse('2026-10-28T09:00:00.000Z');
const at = (day: string): void => {
  clock = Date.parse(`${day}T09:00:00.000Z`);
};
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

async function setup() {
  at('2026-10-28');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const network = await new FicheClient(db, { now }).createNetwork('Réseau test');
  const relecture = new conformite.RelectureRegistre(db, journal, { now, newId: uuid });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  return { db, journal, network, relecture, conformite: as('compliance', 'conformite-1'), direction: as('direction', 'dir-1'), agent: as('agent', 'agent-1'), partner: as('partner', 'partenaire-1') };
}

describeWithSqlite('L06 · relecture trimestrielle du registre', () => {
  it('[R95] l’alerte part 15 jours avant l’échéance, une seule fois, au responsable seul', async () => {
    const t = await setup();
    const s = await t.relecture.status(t.conformite);
    expect(s).toMatchObject({ ok: true, value: { lastReviewOn: '2026-10-28', initial: true, dueOn: '2027-01-28', noticeOn: '2027-01-13', changedSinceReview: false } });
    // Jour par jour : rien avant le 13 janvier, une alerte ce jour-là, plus rien ensuite, même l'échéance passée.
    const raised: string[] = [];
    for (let d = Date.parse('2027-01-01T00:00:00Z'); d <= Date.parse('2027-02-15T00:00:00Z'); d += 86_400_000) {
      const day = new Date(d).toISOString().slice(0, 10);
      at(day);
      if ((await t.relecture.run(t.network.id)) === 1) raised.push(day);
      expect(await t.relecture.run(t.network.id)).toBe(0);
    }
    expect(raised).toEqual(['2027-01-13']);
    const list = await t.relecture.alerts(t.conformite);
    expect(list).toMatchObject({ ok: true, value: [{ dueOn: '2027-01-28', lastReviewOn: '2026-10-28', text: 'Relecture trimestrielle du registre des traitements à faire avant le 28/01/2027 (dernière relecture le 28/10/2026).' }] });
    for (const viewer of [t.agent, t.direction, t.partner]) expect(await t.relecture.alerts(viewer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.journal.all()).filter((e) => e.type === 'registre.relecture_alerte').map((e) => e.data)).toEqual([{ rule: 'R95', dueOn: '2027-01-28' }]);
    expect(await verifyChain(await t.journal.all())).toMatchObject({ ok: true });
  });

  it('[R95] [R16] seul le responsable inscrit une relecture, qui fixe la prochaine échéance', async () => {
    const t = await setup();
    at('2027-01-20');
    for (const viewer of [t.agent, t.direction, t.partner]) expect(await t.relecture.recordReview(viewer, { reviewedOn: '2027-01-20', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.relecture.recordReview(t.conformite, { reviewedOn: '2027-01-21', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'future_date' });
    expect(await t.relecture.recordReview(t.conformite, { reviewedOn: '2026-10-01', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'before_last_review' });
    expect(await t.relecture.recordReview(t.conformite, { reviewedOn: '2027-02-30', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.relecture.recordReview(t.conformite, { reviewedOn: '2027-01-20', validatorName: '  ' })).toEqual({ ok: false, rule: null, code: 'bad_name' });
    const r = await t.relecture.recordReview(t.conformite, { reviewedOn: '2027-01-20', validatorName: 'Camille Conforme' });
    expect(r).toMatchObject({ ok: true, value: { lastReviewOn: '2027-01-20', initial: false, dueOn: '2027-04-20', noticeOn: '2027-04-05', changedSinceReview: false } });
    // La direction lit l'état, sans pouvoir l'écrire.
    expect(await t.relecture.status(t.direction)).toMatchObject({ ok: true, value: { dueOn: '2027-04-20' } });
    expect(await t.relecture.status(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    at('2027-04-04');
    expect(await t.relecture.run(t.network.id)).toBe(0);
    at('2027-04-05');
    expect(await t.relecture.run(t.network.id)).toBe(1);
    // Au journal : la relecture et son empreinte, jamais le nom du responsable.
    const text = JSON.stringify(await t.journal.all());
    expect(text).not.toContain('Camille');
    expect((await t.journal.all()).find((e) => e.type === 'registre.relecture')!.data).toMatchObject({ rule: 'R95', reviewedOn: '2027-01-20' });
    // Rien ne s'efface ni ne change [R17].
    await expect(t.db.run('DELETE FROM registry_reviews')).rejects.toThrow('relecture gardée');
    await expect(t.db.run("UPDATE registry_review_alerts SET due_on = '2030-01-01'")).rejects.toThrow('alerte gardée');
  });

  it('[R95] une relecture d’un registre qui a changé depuis le dit', async () => {
    const t = await setup();
    at('2026-11-02');
    await t.relecture.recordReview(t.conformite, { reviewedOn: '2026-11-02', validatorName: 'Camille Conforme' });
    const changed = REGISTRE_TRAITEMENTS.map((x, i) => (i === 0 ? { ...x, duree: `${x.duree} Modifié.` } : x));
    const later = new conformite.RelectureRegistre(t.db, t.journal, { now: () => new Date(clock), registre: changed });
    const sameColumns = new conformite.RelectureRegistre(t.db, t.journal, { now: () => new Date(clock), colonnesSansDonnee: { ...COLONNES_SANS_DONNEE_PERSONNELLE, persons: [] } });
    expect(await sameColumns.status(t.conformite)).toMatchObject({ ok: true, value: { changedSinceReview: true } });
    expect(await later.status(t.conformite)).toMatchObject({ ok: true, value: { changedSinceReview: true } });
    expect(await t.relecture.status(t.conformite)).toMatchObject({ ok: true, value: { changedSinceReview: false } });
  });

  it('[R95] une alerte rangée sans son événement est reprise au journal, une seule fois', async () => {
    const t = await setup();
    let failing = true;
    const flaky = {
      append: async (e: Parameters<typeof t.journal.append>[0]) => {
        if (failing && e.type === 'registre.relecture_alerte') throw new Error('journal en panne');
        return t.journal.append(e);
      },
      last: () => t.journal.last(),
      all: () => t.journal.all(),
      bySubject: (s: string) => t.journal.bySubject(s),
      byPeriod: (a: string, b: string) => t.journal.byPeriod(a, b),
    };
    const relecture = new conformite.RelectureRegistre(t.db, flaky, { now: () => new Date(clock) });
    at('2027-01-13');
    await expect(relecture.run(t.network.id)).rejects.toThrow('journal en panne');
    failing = false;
    expect(await relecture.run(t.network.id)).toBe(0);
    expect(await relecture.run(t.network.id)).toBe(0);
    await relecture.alerts(t.conformite);
    expect((await t.journal.all()).filter((e) => e.type === 'registre.relecture_alerte')).toHaveLength(1);
  });
});
