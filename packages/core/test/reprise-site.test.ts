import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { fromSyncSqlite, readOnly, readSiteContacts, type SqlDatabase } from '../src/index.ts';
import { describeWithSqlite, openMemoryDatabase, type SqliteDatabase } from './sqlite.ts';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const T = '2026-09-01T08:00:00.000Z';

// Toutes les personnes et coordonnées sont inventées ; les domaines sont réservés aux exemples.
function addCompte(raw: SqliteDatabase, id: number, email: string, extra: { phone?: string; consent?: string | null; verified?: number } = {}): void {
  raw
    .prepare(
      `INSERT INTO comptes (id, email, mdp, civilite, prenom, nom, telephone, verifie, source, consentement_le, cree_le)
       VALUES (?, ?, '', 'Mme', 'Prénom', 'Nom', ?, ?, 'site', ?, ?)`,
    )
    .run(id, email, extra.phone ?? null, extra.verified ?? 0, extra.consent === undefined ? T : extra.consent, T);
}

let seq = 0;
function addDemande(
  raw: SqliteDatabase,
  input: { compteId?: number | null; contact?: unknown; rawContact?: string; statut?: string; raison?: string | null; suspect?: number },
  withLaterColumns = true,
): string {
  seq += 1;
  const reference = `E-20260901-T${String(seq).padStart(5, '0')}`;
  const contact = input.rawContact ?? JSON.stringify(input.contact ?? {});
  if (withLaterColumns) {
    raw
      .prepare(
        `INSERT INTO demandes (reference, compte_id, source, type, code_postal, commune, reponses, contact, statut, raison, statut_le, suspect, cree_le)
         VALUES (?, ?, 'site', 'maison', '21000', 'Dijon', '{}', ?, ?, ?, ?, ?, ?)`,
      )
      .run(reference, input.compteId ?? null, contact, input.statut ?? 'recue', input.raison ?? null, T, input.suspect ?? 0, T);
  } else {
    raw
      .prepare(
        `INSERT INTO demandes (reference, compte_id, source, type, reponses, contact, statut, cree_le)
         VALUES (?, ?, 'site', 'appartement', '{}', ?, ?, ?)`,
      )
      .run(reference, input.compteId ?? null, contact, input.statut ?? 'recue', T);
  }
  return reference;
}

describe('base en lecture seule', () => {
  const fake: SqlDatabase = {
    exec: async () => undefined,
    run: async () => ({ changes: 1 }),
    all: async () => [],
    first: async () => null,
  };
  const db = readOnly(fake);

  it('toute écriture échoue avant d\'atteindre la base', async () => {
    await expect(db.run('UPDATE comptes SET nom = ?', ['x'])).rejects.toThrow(/lecture seule/);
    await expect(db.exec('DELETE FROM comptes')).rejects.toThrow(/lecture seule/);
    for (const sql of [
      'DELETE FROM comptes',
      'SELECT 1; DELETE FROM comptes',
      'WITH x AS (SELECT 1) DELETE FROM comptes',
      'PRAGMA writable_schema = 1',
      'INSERT INTO comptes VALUES (1)',
    ]) {
      await expect(db.all(sql)).rejects.toThrow(/lecture seule/);
      await expect(db.first(sql)).rejects.toThrow(/lecture seule/);
    }
  });

  it('une lecture passe', async () => {
    await expect(db.all('SELECT * FROM comptes ORDER BY id')).resolves.toEqual([]);
  });
});

describeWithSqlite('lecture de la base du site', () => {
  let raw: SqliteDatabase;
  let db: SqlDatabase;

  beforeEach(() => {
    raw = openMemoryDatabase();
    raw.exec(fixture('site-schema.sql'));
    raw.exec(fixture('site-colonnes.sql'));
    db = fromSyncSqlite(raw);
  });

  it('un compte et ses demandes donnent un contact, sans perte', async () => {
    addCompte(raw, 1, 'camille.exemple@example.org', { phone: '06 00 00 00 01', verified: 1 });
    const r1 = addDemande(raw, { compteId: 1, contact: { email: 'camille.exemple@example.org', telephone: '0600000001' } });
    const r2 = addDemande(raw, { compteId: 1, contact: { email: 'camille.autre@example.org', telephone: '06 00 00 00 09' }, statut: 'mandat' });
    const reading = await readSiteContacts(db);
    expect(reading.contacts).toHaveLength(1);
    expect(reading.contacts[0]).toEqual({
      origin: 'site:compte:1',
      emails: ['camille.exemple@example.org', 'camille.autre@example.org'],
      phones: ['06 00 00 00 01', '0600000001', '06 00 00 00 09'],
      civility: 'Mme',
      firstName: 'Prénom',
      lastName: 'Nom',
      createdAt: T,
      consentAt: T,
      verified: true,
      requests: [
        { reference: r1, type: 'maison', postalCode: '21000', city: 'Dijon', status: 'recue', reason: null, createdAt: T, statusAt: T },
        { reference: r2, type: 'maison', postalCode: '21000', city: 'Dijon', status: 'mandat', reason: null, createdAt: T, statusAt: T },
      ],
      problems: [],
    });
  });

  it('une demande sans compte donne son propre contact, avec « Perdu » et sa raison', async () => {
    const ref = addDemande(raw, {
      contact: { civilite: 'M.', prenom: 'Dominique', nom: 'Exemple', email: 'dominique@example.net', telephone: '0700000002' },
      statut: 'close',
      raison: 'Vendu par un particulier',
    });
    const reading = await readSiteContacts(db);
    expect(reading.contacts).toHaveLength(1);
    expect(reading.contacts[0]).toMatchObject({
      origin: `site:demande:${ref}`,
      emails: ['dominique@example.net'],
      phones: ['0700000002'],
      firstName: 'Dominique',
      consentAt: null,
      requests: [{ reference: ref, status: 'close', reason: 'Vendu par un particulier' }],
    });
  });

  it('une demande de robot et une adresse de test sont écartées et comptées', async () => {
    addDemande(raw, { contact: { email: 'robot@example.com' }, suspect: 1 });
    addCompte(raw, 2, 'essai@test.invalid');
    addDemande(raw, { compteId: 2, contact: { email: 'essai@test.invalid' } });
    addDemande(raw, { contact: { email: 'autre@sous.test.invalid' } });
    addDemande(raw, { contact: { email: 'vrai@example.com' } });
    const reading = await readSiteContacts(db);
    expect(reading.skipped).toEqual({ suspect: 1, test: 2 });
    expect(reading.contacts.map((contact) => contact.emails)).toEqual([['vrai@example.com']]);
  });

  it('un contact illisible est gardé et signalé, jamais jeté', async () => {
    const ref = addDemande(raw, { rawContact: '{pas du json' });
    addCompte(raw, 3, 'lou@example.org');
    addDemande(raw, { compteId: 3, rawContact: 'null' });
    addDemande(raw, { contact: {} });
    const reading = await readSiteContacts(db);
    expect(reading.contacts).toHaveLength(3);
    expect(reading.flagged).toBe(3);
    const byOrigin = new Map(reading.contacts.map((contact) => [contact.origin, contact.problems]));
    expect(byOrigin.get(`site:demande:${ref}`)).toEqual(['contact_illisible']);
    expect(byOrigin.get('site:compte:3')).toEqual(['contact_illisible']);
    expect([...byOrigin.values()]).toContainEqual(['sans_coordonnees']);
  });

  it('une base d\'avant les colonnes ajoutées se lit aussi', async () => {
    const old = openMemoryDatabase();
    old.exec(fixture('site-schema.sql'));
    addCompte(old, 1, 'ancien@example.org', { consent: null });
    addDemande(old, { compteId: 1, contact: { email: 'ancien@example.org' }, statut: 'pause' }, false);
    const reading = await readSiteContacts(fromSyncSqlite(old));
    expect(reading.contacts).toHaveLength(1);
    expect(reading.contacts[0]?.requests[0]).toMatchObject({ status: 'pause', reason: null, statusAt: null, type: 'appartement' });
  });

  it('une base vide, ou sans les tables, ne rend rien', async () => {
    expect(await readSiteContacts(fromSyncSqlite(openMemoryDatabase()))).toEqual({ contacts: [], skipped: { suspect: 0, test: 0 }, flagged: 0 });
  });

  it('la lecture ne change rien à la base du site', async () => {
    addCompte(raw, 1, 'camille@example.org');
    addDemande(raw, { compteId: 1, contact: { email: 'camille@example.org' } });
    const before = JSON.stringify([raw.prepare('SELECT * FROM comptes').all(), raw.prepare('SELECT * FROM demandes').all()]);
    await readSiteContacts(db);
    await readSiteContacts(db);
    expect(JSON.stringify([raw.prepare('SELECT * FROM comptes').all(), raw.prepare('SELECT * FROM demandes').all()])).toBe(before);
  });
});
