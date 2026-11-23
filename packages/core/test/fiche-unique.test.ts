import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FicheClient,
  FicheUnique,
  applyMigrations,
  MemoryJournalStore,
  fromSyncSqlite,
  normalizeEmail,
  normalizeFacebook,
  normalizeIdentifier,
  normalizeInstagram,
  normalizePhone,
  type IdentifierKind,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations, migrationsDir } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const migrations = loadMigrations().filter((m) => ['0001_fiche_client', '0003_fusion', '1520_exclusions_copies', '1530_appels_notes', '1540_appels_copies'].includes(m.id));

function clock(start = '2026-11-02T09:00:00.000Z') {
  let t = Date.parse(start);
  return () => new Date((t += 1000));
}

describe('S04 · normalisation des identifiants', () => {
  it('mail en minuscules, sans espaces ; points et « + » gardés', () => {
    expect(normalizeEmail('  Lea.Martin@Example.TEST ')).toBe('lea.martin@example.test');
    expect(normalizeEmail('mailto:a@b.test')).toBe('a@b.test');
    expect(normalizeEmail('a+maison@b.test')).toBe('a+maison@b.test');
    expect(normalizeEmail('pas un mail')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
  });

  it('téléphone au format international', () => {
    for (const raw of ['06 11 22 33 44', '06.11.22.33.44', '+33 6 11 22 33 44', '0033611223344', '+33 (0)6 11 22 33 44', '33611223344', '+330611223344']) {
      expect(normalizePhone(raw), raw).toBe('+33611223344');
    }
    expect(normalizePhone('+41 79 123 45 67')).toBe('+41791234567');
    expect(normalizePhone('0041 79 123 45 67')).toBe('+41791234567');
    for (const raw of ['0612', '06 11 22 33 4', '+33 6 11 22 33 44 55', 'appeler le soir', '']) {
      expect(normalizePhone(raw), raw).toBeNull();
    }
  });

  it('comptes Instagram et Facebook', () => {
    expect(normalizeInstagram('@Jules.Test')).toBe('jules.test');
    expect(normalizeInstagram('https://www.instagram.com/jules.test/?hl=fr')).toBe('jules.test');
    expect(normalizeInstagram('nom avec espace')).toBeNull();
    expect(normalizeInstagram('a/b')).toBeNull();
    expect(normalizeFacebook('https://www.facebook.com/profile.php?id=1000000042')).toBe('1000000042');
    expect(normalizeFacebook('https://m.facebook.com/Agence.Test/')).toBe('agence.test');
    expect(normalizeFacebook('1000000042')).toBe('1000000042');
    expect(normalizeFacebook('a/b c')).toBeNull();
    expect(normalizeFacebook('https://www.facebook.com/people/Alpha-Test/1000000001/')).toBe('1000000001');
    expect(normalizeFacebook('https://www.facebook.com/people/Beta-Test/1000000002/')).toBe('1000000002');
    expect(normalizeFacebook('https://www.facebook.com/profile.php?sk=about&id=1000000003')).toBe('1000000003');
    for (const raw of ['https://www.facebook.com/groups/123/', 'https://facebook.com/share/abc', 'https://www.facebook.com/']) {
      expect(normalizeFacebook(raw), raw).toBeNull();
    }
    for (const raw of ['https://www.instagram.com/p/AbC123/', 'https://instagram.com/reel/xyz', 'https://www.instagram.com/']) {
      expect(normalizeInstagram(raw), raw).toBeNull();
    }
  });
});

type Ident = [IdentifierKind, string];

/** 50 fiches inventées : 9 groupes de doublons connus (25 fiches) et 25 fiches seules, dont des pièges. */
const CLUSTERS: Ident[][][] = [
  // mail écrit de trois façons
  [[['email', 'Lea.Martin@Example.test']], [['email', ' lea.martin@example.test ']], [['email', 'mailto:LEA.MARTIN@example.test']]],
  // téléphone en quatre formats, dont un WhatsApp
  [
    [['phone', '06 11 22 33 44']],
    [['phone', '+33 6 11 22 33 44']],
    [['phone', '0033611223344']],
    [['whatsapp', '+33 (0)6 11 22 33 44']],
  ],
  // Instagram
  [[['instagram', '@Jules.Test']], [['instagram', 'https://www.instagram.com/jules.test/']], [['instagram', 'jules.test']]],
  // Facebook
  [[['facebook', 'https://facebook.com/profile.php?id=1000000042']], [['facebook', '1000000042']]],
  // chaîne : mail, puis mail et téléphone, puis téléphone et Instagram, puis Instagram
  [
    [['email', 'chaine@example.test']],
    [['email', 'CHAINE@example.test'], ['phone', '07 00 00 00 01']],
    [['phone', '+33700000001'], ['instagram', 'chaine.test']],
    [['instagram', '@chaine.test']],
  ],
  // le même numéro, en téléphone puis en WhatsApp
  [[['phone', '06 99 00 00 02']], [['whatsapp', '+33699000002']]],
  // numéro suisse
  [[['phone', '+41 79 123 45 67']], [['phone', '0041791234567']]],
  // mail, puis mail et téléphone, puis téléphone
  [[['email', 'Mixte@Example.test']], [['email', 'mixte@example.test'], ['phone', '06 55 00 00 03']], [['phone', '0655000003']]],
  // deux identifiants communs à la fois
  [[['email', 'deux@example.test'], ['phone', '06 44 00 00 04']], [['email', 'Deux@example.test'], ['phone', '+33644000004']]],
];

const ALONE: Ident[][] = [
  [['email', 'paul.durand@example.test']],
  [['email', 'pauldurand@example.test']], // pas les mêmes adresses : deux personnes
  [['email', 'sam@example.test']],
  [['email', 'sam+maison@example.test']], // adresse différente : deux personnes
  [['phone', '06 11 22 33 45']], // un chiffre de plus que le groupe 2
  [['phone', '0612']], // invalide : ne rapproche rien
  [['phone', '0612']],
  [['instagram', 'jules.test2']],
  [['facebook', '1000000043']],
  ...Array.from({ length: 16 }, (_, i): Ident[] => [['email', `seul${i}@example.test`]]),
];

const trace = () => ({ journal: new MemoryJournalStore(), actor: 'direction:test' });

describeWithSqlite('S04 · une seule fiche par personne', () => {
  let db: SqlDatabase;
  let store: FicheClient;
  let fiches: FicheUnique;
  let networkId: string;

  beforeEach(async () => {
    db = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, migrations);
    const now = clock();
    store = new FicheClient(db, { now });
    fiches = new FicheUnique(db, store, { now });
    networkId = (await store.createNetwork('Réseau de test')).id;
  });

  /**
   * Range les identifiants par l'accès normal, qui normalise. Une valeur non valable est rangée brute par SQL,
   * comme une ancienne donnée reprise telle quelle : elle ne doit rien rapprocher.
   */
  async function createFiche(idents: Ident[], firstName = 'Test'): Promise<string> {
    const p = await store.createPerson({ networkId, firstName });
    for (const [kind, value] of idents) {
      if (normalizeIdentifier(kind, value) !== null) {
        await store.addIdentifier({ networkId, personId: p.id, kind, value });
      } else {
        await db.run(
          "INSERT INTO person_identifiers (id, network_id, person_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?, '2026-11-02T09:00:00.000Z')",
          [crypto.randomUUID(), networkId, p.id, kind, value],
        );
      }
    }
    return p.id;
  }

  async function loadDataset() {
    const expected: string[][] = [];
    for (const cluster of CLUSTERS) {
      const ids: string[] = [];
      for (const idents of cluster) ids.push(await createFiche(idents));
      expected.push(ids);
    }
    const alone: string[] = [];
    for (const idents of ALONE) alone.push(await createFiche(idents, 'Camille')); // homonymes
    return { expected, alone };
  }

  async function countRows(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const t of ['persons', 'person_identifiers', 'consents', 'exclusions', 'projects', 'sources', 'messages']) {
      counts[t] = (await db.first<{ n: number }>(`SELECT count(*) AS n FROM ${t}`))?.n ?? -1;
    }
    return counts;
  }

  it('50 fiches inventées avec doublons connus : 50 sur 50 bien regroupées', async () => {
    const { expected, alone } = await loadDataset();
    expect(expected.flat().length + alone.length).toBe(50);
    const groups = await fiches.findDuplicateGroups(networkId);
    const groupOf = new Map<string, string>();
    for (const g of groups) for (const id of g) groupOf.set(id, g.join(','));
    let right = 0;
    for (const ids of expected) {
      const key = [...ids].sort().join(',');
      for (const id of ids) if (groupOf.get(id) === key) right++;
    }
    for (const id of alone) if (!groupOf.has(id)) right++;
    expect(right).toBe(50);
    expect(groups.length).toBe(CLUSTERS.length);
  });

  it('[R17] fusionner tous les doublons garde tout, puis une fusion se défait à l’identique', async () => {
    const { expected } = await loadDataset();
    const before = await countRows();
    const target = expected[4] as string[]; // la chaîne
    const separateBefore = await Promise.all(target.map((id) => fiches.view(id)));

    const merges = [];
    for (const ids of expected) {
      const [survivor, ...others] = ids as [string, ...string[]];
      for (const other of others) merges.push(await fiches.merge({ survivorId: survivor, mergedId: other, reason: 'identifiant commun' }));
    }
    expect(await fiches.findDuplicateGroups(networkId)).toEqual([]);
    expect(await countRows()).toEqual(before);

    const merged = await fiches.view(target[3] as string);
    expect(merged.person.id).toBe(target[0]);
    expect(merged.members.map((m) => m.id)).toEqual(target);
    expect(merged.identifiers).toHaveLength(6);

    for (const m of merges) await fiches.undoMerge(m.id, trace());
    expect(await countRows()).toEqual(before);
    const separateAfter = await Promise.all(target.map((id) => fiches.view(id)));
    expect(separateAfter.map((v) => ({ ...v, merges: [] }))).toEqual(separateBefore.map((v) => ({ ...v, merges: [] })));
    expect(separateAfter[0]?.merges.every((m) => m.undone_at !== null)).toBe(true);
    expect((await fiches.findDuplicateGroups(networkId)).length).toBe(CLUSTERS.length);
  });

  it('la fiche réunie montre l’historique de chaque fiche, et toute fiche fusionnée mène à la fiche gardée', async () => {
    const a = await createFiche([['email', 'histo@example.test']]);
    const b = await createFiche([['phone', '06 33 00 00 05'], ['email', 'Histo@example.test']]);
    const occurredAt = new Date('2026-11-01T10:00:00.000Z');
    const msg = { networkId, channel: 'email', direction: 'in', authorKind: 'person', body: 'test', occurredAt } as const;
    await store.recordMessage({ ...msg, personId: a });
    await store.recordMessage({ ...msg, personId: b, occurredAt: new Date('2026-11-01T11:00:00.000Z') });
    await store.addConsent({ networkId, personId: b, purpose: 'alertes', channel: 'email', proof: 'formulaire test', givenAt: occurredAt });
    await store.addExclusion({ networkId, personId: a, reason: 'stop', notedAt: occurredAt });
    await fiches.merge({ survivorId: a, mergedId: b, reason: 'même mail' });

    const view = await fiches.view(b);
    expect(view.person.id).toBe(a);
    expect(view.messages.map((m) => m.person_id)).toEqual([a, b]);
    expect(view.consents.map((c) => c.person_id)).toEqual([b]);
    expect(view.exclusions.map((e) => e.person_id)).toEqual([a]);
    expect((await fiches.findByIdentifier(networkId, 'whatsapp', '+33 6 33 00 00 05')).map((p) => p.id)).toEqual([a]);
  });

  it('fusion de fiches déjà fusionnées : on remonte aux fiches gardées', async () => {
    const a = await createFiche([['email', 'a@example.test']]);
    const b = await createFiche([['email', 'b@example.test']]);
    const c = await createFiche([['email', 'c@example.test']]);
    await fiches.merge({ survivorId: a, mergedId: b, reason: 'décision de l’agent' });
    const m = await fiches.merge({ survivorId: c, mergedId: b, reason: 'décision de l’agent' });
    expect([m.survivor_id, m.merged_id]).toEqual([c, a]);
    expect(await fiches.membersOf(b)).toEqual([c, a, b]);
    await expect(fiches.merge({ survivorId: b, mergedId: c, reason: 'x' })).rejects.toThrow(/déjà réunies/);
  });

  it('fusions refusées : même fiche, sans raison, autre réseau, deux agents différents', async () => {
    const a = await createFiche([]);
    const b = await createFiche([]);
    await expect(fiches.merge({ survivorId: a, mergedId: a, reason: 'x' })).rejects.toThrow();
    await expect(fiches.merge({ survivorId: a, mergedId: b, reason: ' ' })).rejects.toThrow(/pourquoi/);
    const other = (await store.createNetwork('Autre')).id;
    const c = (await store.createPerson({ networkId: other })).id;
    await expect(fiches.merge({ survivorId: a, mergedId: c, reason: 'x' })).rejects.toThrow(/réseaux/);
    const x = (await store.createAgent({ networkId, firstName: 'X', lastName: 'Test' })).id;
    const y = (await store.createAgent({ networkId, firstName: 'Y', lastName: 'Test' })).id;
    const px = (await store.createPerson({ networkId, agentId: x })).id;
    const py = (await store.createPerson({ networkId, agentId: y })).id;
    await expect(fiches.merge({ survivorId: px, mergedId: py, reason: 'x' })).rejects.toThrow(/deux agents/);
    expect(await db.first<{ n: number }>('SELECT count(*) AS n FROM person_merges')).toEqual({ n: 0 });
  });

  it('deux agents différents ne se réunissent pas non plus en passant par une fiche sans agent', async () => {
    const x = (await store.createAgent({ networkId, firstName: 'X', lastName: 'Test' })).id;
    const y = (await store.createAgent({ networkId, firstName: 'Y', lastName: 'Test' })).id;
    const a = (await store.createPerson({ networkId })).id;
    const b = (await store.createPerson({ networkId, agentId: x })).id;
    const c = (await store.createPerson({ networkId, agentId: y })).id;
    await fiches.merge({ survivorId: a, mergedId: b, reason: 'x' });
    await expect(fiches.merge({ survivorId: a, mergedId: c, reason: 'x' })).rejects.toThrow(/deux agents/);
    await expect(fiches.merge({ survivorId: c, mergedId: b, reason: 'x' })).rejects.toThrow(/deux agents/);
  });

  it('deux fusions croisées lancées en même temps ne créent pas de boucle', async () => {
    const p = await createFiche([]);
    const q = await createFiche([]);
    const results = await Promise.allSettled([
      fiches.merge({ survivorId: p, mergedId: q, reason: 'x' }),
      fiches.merge({ survivorId: q, mergedId: p, reason: 'x' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await db.first<{ n: number }>('SELECT count(*) AS n FROM person_merges'))?.n).toBe(1);
    expect((await fiches.view(p)).members).toHaveLength(2);
    expect((await fiches.view(q)).members).toHaveLength(2);
  });

  it('deux fusions simultanées vers une même fiche sans agent ne réunissent pas deux agents', async () => {
    const x = (await store.createAgent({ networkId, firstName: 'X', lastName: 'Test' })).id;
    const y = (await store.createAgent({ networkId, firstName: 'Y', lastName: 'Test' })).id;
    const a = (await store.createPerson({ networkId })).id;
    const b = (await store.createPerson({ networkId, agentId: x })).id;
    const c = (await store.createPerson({ networkId, agentId: y })).id;
    const results = await Promise.allSettled([
      fiches.merge({ survivorId: a, mergedId: b, reason: 'x' }),
      fiches.merge({ survivorId: a, mergedId: c, reason: 'x' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const agents = new Set((await fiches.view(a)).members.map((m) => m.agent_id).filter(Boolean));
    expect(agents.size).toBe(1);
  });

  it('un identifiant saisi brut par l’accès normal est rangé normalisé et retrouvé', async () => {
    const p = await createFiche([]);
    const row = await store.addIdentifier({ networkId, personId: p, kind: 'phone', value: '06 11 22 33 44' });
    expect(row.value).toBe('+33611223344');
    expect((await fiches.findByIdentifier(networkId, 'phone', '0611223344')).map((x) => x.id)).toEqual([p]);
    await expect(store.addIdentifier({ networkId, personId: p, kind: 'phone', value: '0612' })).rejects.toThrow();
  });

  it('défaire une fusion inconnue est une erreur ; la défaire deux fois garde la première date', async () => {
    await expect(fiches.undoMerge('absent', trace())).rejects.toThrow(/inconnue/);
    const a = await createFiche([]);
    const b = await createFiche([]);
    const m = await fiches.merge({ survivorId: a, mergedId: b, reason: 'x' });
    const first = await fiches.undoMerge(m.id, trace());
    expect(await fiches.undoMerge(m.id, trace())).toBe(first);
    expect(await fiches.rootOf(b)).toBe(b);
  });

  it('[R03] hasConsentInForce lit les fiches réunies : une ligne ouverte plus ancienne qu’un retrait de l’autre fiche ne compte pas', async () => {
    const a = await createFiche([]);
    const b = await createFiche([]);
    const consent = (personId: string, day: string) => store.addConsent({ networkId, personId, purpose: 'alertes', channel: 'email', proof: 'preuve inventée', givenAt: new Date(`2026-${day}T10:00:00.000Z`) });
    await consent(b, '03-01');
    expect(await fiches.hasConsentInForce(b, 'alertes', 'email')).toBe(true);
    const old = await consent(a, '02-01');
    await store.withdrawConsent(old.id, new Date('2026-04-01T10:00:00.000Z'));
    expect(await fiches.hasConsentInForce(a, 'alertes', 'email')).toBe(false);
    await fiches.merge({ survivorId: a, mergedId: b, reason: 'même personne' });
    expect(await fiches.hasConsentInForce(a, 'alertes', 'email')).toBe(false);
    expect(await fiches.channelsInForce(b, 'alertes')).toEqual([]);
    await consent(a, '05-01');
    expect(await fiches.hasConsentInForce(b, 'alertes', 'email')).toBe(true);
    expect(await fiches.hasConsentInForce(b, 'alertes', 'sms')).toBe(false);
    expect(await fiches.channelsInForce(a, 'alertes')).toEqual(['email']);
  });

  it('un identifiant saisi est normalisé, refusé s’il n’est pas valable, pas doublé', async () => {
    const p = await createFiche([]);
    const first = await fiches.addIdentifier({ networkId, personId: p, kind: 'phone', value: '06 22 00 00 06' });
    expect(first.value).toBe('+33622000006');
    const again = await fiches.addIdentifier({ networkId, personId: p, kind: 'phone', value: '+33 6 22 00 00 06' });
    expect(again.id).toBe(first.id);
    await expect(fiches.addIdentifier({ networkId, personId: p, kind: 'email', value: 'pas un mail' })).rejects.toThrow();
    expect(await store.listIdentifiers(p)).toHaveLength(1);
  });
});

const SECOND_FILE_DROP = 'DROP TABLE sale_files;';

describe('[R17] le code n’efface aucune donnée', () => {
  it('[R17] l’exception H51 : un seul DROP, sur `sale_files`, après une recopie vérifiée complète, et nulle part ailleurs', () => {
    const exceptions = readdirSync(migrationsDir).filter((f) => /\bDROP\s+TABLE\b/i.test(readFileSync(migrationsDir + f, 'utf8').replace(/^\s*--.*$/gm, '')));
    expect(exceptions).toEqual(['1760_second_dossier.sql']);
    const sql = readFileSync(migrationsDir + '1760_second_dossier.sql', 'utf8').replace(/^\s*--.*$/gm, '');
    expect(sql.match(/\bDROP\b/gi)).toHaveLength(1);
    const drop = sql.indexOf(SECOND_FILE_DROP);
    const copy = sql.indexOf('INSERT INTO sale_files_refaite');
    const check = sql.indexOf('INSERT INTO sale_files_recopie');
    expect(copy).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(copy);
    expect(drop).toBeGreaterThan(check);
    expect(sql).toMatch(/complete INTEGER NOT NULL CHECK \(complete = 1\)/);
  });

  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(dir + f).isDirectory() ? files(`${dir}${f}/`) : [dir + f]));

  it('aucun DELETE, DROP ni TRUNCATE dans le code du cœur ni dans les migrations', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    for (const file of [...files(src), ...files(migrationsDir)]) {
      let text = readFileSync(file, 'utf8').replace(/^\s*(--|\/\/|\*).*$/gm, '');
      // La seule exception, décidée par Shawez (H51) : `sale_files` refaite pour un second dossier, testée à part.
      if (file.endsWith('/1760_second_dossier.sql')) text = text.replace(SECOND_FILE_DROP, '');
      // La procédure d'effacement que R17 prévoit (AU020) : un seul DELETE, ligne par ligne, dans `eraseForReal`.
      if (file.endsWith('/conformite/effacement-reel.ts')) {
        expect(text.match(/\bDELETE\s+FROM\b/gi), file).toHaveLength(1);
        text = text.replace('`DELETE FROM "${p.table}" WHERE ${where.sql}`', '');
      }
      expect(text, file).not.toMatch(/\bDELETE\s+FROM\b|\bDROP\s+(TABLE|INDEX|VIEW)\b|\bTRUNCATE\b|ON DELETE CASCADE/i);
    }
  });
});
