import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it } from 'vitest';
import { FicheClient, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { loadMigrations, migrationsDir } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const FICHE_TABLES = [
  'agents',
  'consents',
  'exclusions',
  'messages',
  'networks',
  'person_identifiers',
  'persons',
  'project_properties',
  'projects',
  'properties',
  'sources',
];

const fiche = loadMigrations().filter((m) => m.id === '0001_fiche_client');

async function freshDb(): Promise<SqlDatabase> {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, fiche);
  return db;
}

async function tables(db: SqlDatabase): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
  );
  return rows.map((row) => row.name);
}

interface ColumnInfo {
  name: string;
  pk: number;
}

async function columns(db: SqlDatabase, table: string): Promise<ColumnInfo[]> {
  return db.all<ColumnInfo>(`SELECT name, pk FROM pragma_table_info('${table}')`);
}

function clock(start = '2026-11-02T09:00:00.000Z') {
  let t = Date.parse(start);
  return () => new Date((t += 1000));
}

describeWithSqlite('S03 · migrations de la fiche client', () => {
  it("s'appliquent sur une base vide", async () => {
    const db = fromSyncSqlite(openMemoryDatabase());
    const applied = await applyMigrations(db, fiche);
    expect(applied).toEqual(['0001_fiche_client']);
    expect(await tables(db)).toEqual(FICHE_TABLES);
  });

  it('se rejouent sans erreur ni changement', async () => {
    const db = await freshDb();
    expect(await applyMigrations(db, fiche)).toEqual([]);
    // Le script lui-même se rejoue aussi, même hors du suivi des migrations.
    for (const migration of fiche) await db.exec(migration.sql);
    expect(await tables(db)).toEqual(FICHE_TABLES);
  });

  it('toutes les migrations du dépôt passent ensemble, dans l’ordre de leur numéro', async () => {
    const all = loadMigrations();
    expect(all.map((m) => m.id)).toEqual([...all.map((m) => m.id)].sort());
    for (const m of all) expect(m.id).toMatch(/^\d{4}_[a-z0-9_]+$/);
    const db = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, all);
    expect(await applyMigrations(db, all)).toEqual([]);
  });

  it('chaque table a sa clé, porte le réseau et l’agent', async () => {
    const db = await freshDb();
    for (const table of FICHE_TABLES) {
      const cols = await columns(db, table);
      expect(cols.some((c) => c.pk > 0), `clé de ${table}`).toBe(true);
      if (table === 'networks') continue;
      const names = cols.map((c) => c.name);
      expect(names, `réseau dans ${table}`).toContain('network_id');
      if (table !== 'agents') expect(names, `agent dans ${table}`).toContain('agent_id');
    }
  });

  it('les recherches du socle passent par un index', async () => {
    const db = await freshDb();
    const plan = async (sql: string) =>
      (await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)).map((r) => r.detail).join(' | ');
    expect(
      await plan("SELECT person_id FROM person_identifiers WHERE network_id = 'n' AND kind = 'email' AND value = 'x'"),
    ).toContain('person_identifiers_lookup');
    expect(await plan("SELECT id FROM persons WHERE network_id = 'n' AND agent_id = 'a'")).toContain(
      'persons_agent',
    );
    expect(await plan("SELECT id FROM consents WHERE person_id = 'p' AND channel = 'sms'")).toContain(
      'consents_person',
    );
    expect(await plan("SELECT id FROM exclusions WHERE person_id = 'p'")).toContain('exclusions_person');
    expect(
      await plan("SELECT id FROM messages WHERE person_id = 'p' ORDER BY occurred_at DESC LIMIT 1"),
    ).toContain('messages_person');
    expect(
      await plan("SELECT id FROM messages WHERE conversation_id = 'c' ORDER BY occurred_at DESC LIMIT 1"),
    ).toContain('messages_conversation');
    expect(await plan("SELECT id FROM projects WHERE person_id = 'p'")).toContain('projects_person');
  });

  it('[R15] aucune colonne pour une pièce d’identité, l’anti-blanchiment ou des coordonnées bancaires', async () => {
    const db = await freshDb();
    const FORBIDDEN =
      /(iban|bic|swift|rib|bank|banque|card|carte|passport|passeport|identity|identite|cni|piece|kyc|aml|blanchiment|ssn|social_security|secu|birth|naissance|tax_id|fiscal)/i;
    for (const table of await tables(db)) {
      expect(table).not.toMatch(FORBIDDEN);
      for (const { name } of await columns(db, table)) {
        expect(`${table}.${name}`).not.toMatch(FORBIDDEN);
      }
    }
  });
});

describeWithSqlite('S03 · accès typé à la fiche client', () => {
  let db: SqlDatabase;
  let store: FicheClient;
  let networkId: string;
  let agentId: string;

  beforeEach(async () => {
    db = await freshDb();
    store = new FicheClient(db, { now: clock() });
    networkId = (await store.createNetwork('Réseau de test')).id;
    agentId = (await store.createAgent({ networkId, firstName: 'Agent', lastName: 'Test' })).id;
  });

  it('une personne peut avoir plusieurs identifiants, de chaque sorte', async () => {
    const person = await store.createPerson({ networkId, agentId, firstName: 'Camille', lastName: 'Exemple' });
    const ids = [
      { kind: 'email', value: 'camille@example.test' },
      { kind: 'email', value: 'c.exemple@example.test' },
      { kind: 'phone', value: '+33600000001' },
      { kind: 'instagram', value: 'camille.exemple' },
      { kind: 'facebook', value: '1000000001' },
      { kind: 'whatsapp', value: '+33600000001' },
    ] as const;
    for (const id of ids) await store.addIdentifier({ networkId, agentId, personId: person.id, ...id });
    const stored = await store.listIdentifiers(person.id);
    expect(stored.map((i) => [i.kind, i.value])).toEqual(ids.map((i) => [i.kind, i.value]));
    const found = await store.findPersonsByIdentifier(networkId, 'phone', '+33600000001');
    expect(found.map((p) => p.id)).toEqual([person.id]);
    expect(found[0]).toEqual(await store.getPerson(person.id));
  });

  it('deux fiches qui partagent un identifiant sont toutes deux trouvées, pour la fusion de S04', async () => {
    const a = await store.createPerson({ networkId, firstName: 'Alex' });
    const b = await store.createPerson({ networkId, firstName: 'Alex' });
    for (const p of [a, b]) await store.addIdentifier({ networkId, personId: p.id, kind: 'email', value: 'alex@example.test' });
    const found = await store.findPersonsByIdentifier(networkId, 'email', 'alex@example.test');
    expect(found.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('le même identifiant deux fois sur la même fiche est refusé', async () => {
    const p = await store.createPerson({ networkId });
    await store.addIdentifier({ networkId, personId: p.id, kind: 'email', value: 'x@example.test' });
    await expect(
      store.addIdentifier({ networkId, personId: p.id, kind: 'email', value: 'x@example.test' }),
    ).rejects.toThrow();
  });

  it('une sorte d’identifiant inconnue est refusée par la base', async () => {
    const p = await store.createPerson({ networkId });
    await expect(
      db.run(
        "INSERT INTO person_identifiers (id, network_id, person_id, kind, value, created_at) VALUES ('i', ?, ?, 'fax', '1', '2026-11-02T09:00:00.000Z')",
        [networkId, p.id],
      ),
    ).rejects.toThrow();
  });

  it('un accord garde sa finalité, son canal, sa preuve et sa date ; un accord sans preuve est refusé', async () => {
    const p = await store.createPerson({ networkId, agentId });
    const givenAt = new Date('2026-10-30T15:00:00.000Z');
    const consent = await store.addConsent({
      networkId,
      agentId,
      personId: p.id,
      purpose: 'alertes acquéreur',
      channel: 'email',
      proof: 'formulaire du site, demande n° test-1',
      givenAt,
    });
    expect(await store.listConsents(p.id)).toEqual([consent]);
    expect(consent.given_at).toBe(givenAt.toISOString());
    await expect(
      store.addConsent({ networkId, personId: p.id, purpose: 'x', channel: 'sms', proof: '  ', givenAt }),
    ).rejects.toThrow(/preuve/);
    await expect(
      db.run(
        "INSERT INTO consents (id, network_id, person_id, purpose, channel, proof, given_at, created_at) VALUES ('c', ?, ?, 'x', 'sms', '', 'd', 'd')",
        [networkId, p.id],
      ),
    ).rejects.toThrow();
  });

  it('[R17] un accord retiré et une exclusion levée gardent leur ligne', async () => {
    const p = await store.createPerson({ networkId });
    const consent = await store.addConsent({
      networkId,
      personId: p.id,
      purpose: 'relances',
      channel: 'sms',
      proof: 'accord écrit test',
      givenAt: new Date('2026-10-01T10:00:00.000Z'),
    });
    await store.withdrawConsent(consent.id, new Date('2026-10-20T10:00:00.000Z'));
    const exclusion = await store.addExclusion({
      networkId,
      personId: p.id,
      reason: 'stop',
      notedAt: new Date('2026-10-21T10:00:00.000Z'),
    });
    expect(exclusion.channel).toBeNull();
    await store.liftExclusion(exclusion.id, new Date('2026-10-22T10:00:00.000Z'));
    const consents = await store.listConsents(p.id);
    expect(consents).toHaveLength(1);
    expect(consents[0]?.withdrawn_at).toBe('2026-10-20T10:00:00.000Z');
    const exclusions = await store.listExclusions(p.id);
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0]?.lifted_at).toBe('2026-10-22T10:00:00.000Z');
  });

  it('retirer un accord ou lever une exclusion inconnus est une erreur ; le second retrait garde la première date', async () => {
    const at = new Date('2026-10-20T10:00:00.000Z');
    await expect(store.withdrawConsent('absent', at)).rejects.toThrow(/Accord inconnu/);
    await expect(store.liftExclusion('absent', at)).rejects.toThrow(/Exclusion inconnue/);
    const p = await store.createPerson({ networkId });
    const consent = await store.addConsent({
      networkId,
      personId: p.id,
      purpose: 'relances',
      channel: 'email',
      proof: 'accord écrit test',
      givenAt: new Date('2026-10-01T10:00:00.000Z'),
    });
    expect(await store.withdrawConsent(consent.id, at)).toBe(at.toISOString());
    expect(await store.withdrawConsent(consent.id, new Date('2026-10-25T10:00:00.000Z'))).toBe(at.toISOString());
  });

  it('une ligne ne peut pas pointer vers une fiche, un agent ou un projet d’un autre réseau', async () => {
    const other = (await store.createNetwork('Autre réseau')).id;
    const p = await store.createPerson({ networkId, agentId });
    await expect(
      store.addIdentifier({ networkId: other, personId: p.id, kind: 'email', value: 'w@example.test' }),
    ).rejects.toThrow();
    await expect(store.createPerson({ networkId: other, agentId })).rejects.toThrow();
    const project = await store.createProject({ networkId, personId: p.id, kind: 'sell' });
    const otherPerson = await store.createPerson({ networkId: other });
    await expect(
      store.createProject({ networkId: other, personId: otherPerson.id, kind: 'buy' }).then(() =>
        store.addSource({
          networkId: other,
          personId: otherPerson.id,
          projectId: project.id,
          channel: 'site',
          occurredAt: new Date('2026-11-01T10:00:00.000Z'),
        }),
      ),
    ).rejects.toThrow();
    expect(await store.findPersonsByIdentifier(other, 'email', 'w@example.test')).toEqual([]);
  });

  it('un message ou une source ne peut pas citer le projet d’une autre personne', async () => {
    const a = await store.createPerson({ networkId });
    const b = await store.createPerson({ networkId });
    const projectOfB = await store.createProject({ networkId, personId: b.id, kind: 'buy' });
    const occurredAt = new Date('2026-11-01T10:00:00.000Z');
    await expect(
      store.recordMessage({
        networkId,
        personId: a.id,
        projectId: projectOfB.id,
        channel: 'email',
        direction: 'in',
        authorKind: 'person',
        body: 'test',
        occurredAt,
      }),
    ).rejects.toThrow();
    await expect(
      store.addSource({ networkId, personId: a.id, projectId: projectOfB.id, channel: 'site', occurredAt }),
    ).rejects.toThrow();
    expect(await store.listMessages(a.id)).toEqual([]);
    expect((await store.getPerson(a.id))?.last_contact_at).toBeNull();
  });

  it('[R17] la base refuse d’effacer une personne qui a un historique', async () => {
    const p = await store.createPerson({ networkId });
    await store.addIdentifier({ networkId, personId: p.id, kind: 'email', value: 'y@example.test' });
    await expect(db.run('DELETE FROM persons WHERE id = ?', [p.id])).rejects.toThrow();
    expect(await store.getPerson(p.id)).not.toBeNull();
  });

  it('[R17] l’accès à la fiche client ne contient aucun effacement', () => {
    const dir = fileURLToPath(new URL('../src/db/', import.meta.url));
    for (const file of readdirSync(dir)) {
      expect(readFileSync(dir + file, 'utf8'), file).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
    }
    expect(readFileSync(migrationsDir + '0001_fiche_client.sql', 'utf8')).not.toMatch(
      /\bON DELETE CASCADE\b|\bDROP\b|\bDELETE FROM\b/i,
    );
  });

  it('projets, sources, biens et messages se rattachent à la personne', async () => {
    const p = await store.createPerson({ networkId, agentId, firstName: 'Dominique' });
    const project = await store.createProject({
      networkId,
      agentId,
      personId: p.id,
      kind: 'buy',
      budgetMaxEur: 250000,
      criteria: { rooms_min: 3 },
    });
    await store.addSource({
      networkId,
      agentId,
      personId: p.id,
      projectId: project.id,
      channel: 'instagram',
      detail: 'réponse à une publication de test',
      occurredAt: new Date('2026-11-01T18:00:00.000Z'),
    });
    const property = await store.createProperty({
      networkId,
      agentId,
      reference: 'TEST-001',
      kind: 'home',
      postalCode: '21000',
      city: 'Dijon',
      surfaceM2: 72.5,
      rooms: 3,
      priceEur: 239000,
      status: 'available',
    });
    await store.linkProjectProperty({ networkId, agentId, projectId: project.id, propertyId: property.id, role: 'proposed' });
    await store.recordMessage({
      networkId,
      agentId,
      personId: p.id,
      projectId: project.id,
      conversationId: 'conv-test',
      channel: 'instagram',
      direction: 'in',
      authorKind: 'person',
      body: 'Bonjour, le bien est-il encore disponible ?',
      occurredAt: new Date('2026-11-01T18:05:00.000Z'),
    });

    expect((await store.listProjects(p.id)).map((x) => [x.kind, x.budget_max_eur, x.criteria])).toEqual([
      ['buy', 250000, '{"rooms_min":3}'],
    ]);
    expect((await store.listSources(p.id)).map((s) => s.channel)).toEqual(['instagram']);
    expect(await store.getProperty(property.id)).toEqual(property);
    expect((await store.listProjectProperties(project.id)).map((l) => l.property_id)).toEqual([property.id]);
    const messages = await store.listMessages(p.id);
    expect(messages.map((m) => [m.direction, m.author_kind, m.cost_cents])).toEqual([['in', 'person', 0]]);
    expect((await store.getPerson(p.id))?.last_contact_at).toBe('2026-11-01T18:05:00.000Z');
    expect((await store.listPersonsOfAgent(networkId, agentId)).map((x) => x.id)).toEqual([p.id]);
  });

  it('les dates sont rangées en temps universel ISO 8601', async () => {
    const p = await store.createPerson({ networkId });
    expect(p.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('un lien vers une ligne absente est refusé', async () => {
    await expect(store.createPerson({ networkId: 'absent' })).rejects.toThrow();
    await expect(
      store.addIdentifier({ networkId, personId: 'absent', kind: 'email', value: 'z@example.test' }),
    ).rejects.toThrow();
  });
});
