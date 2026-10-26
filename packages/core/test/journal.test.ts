import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryJournalStore,
  SqliteJournalStore,
  appendEvent,
  verifyChain,
  type JournalEntry,
  type JournalStore,
} from '../src/index.ts';
import {
  describeWithSqlite,
  openMemoryDatabase,
  type SqliteDatabase,
} from './sqlite.ts';

const migrationPath = fileURLToPath(
  new URL('../../../db/migrations/0002_journal.sql', import.meta.url),
);
const migration = readFileSync(migrationPath, 'utf8');
const dates = [
  new Date('2026-01-02T10:00:00.000Z'),
  new Date('2026-01-02T11:00:00.000Z'),
  new Date('2026-01-03T09:00:00.000Z'),
];

async function fill(store: JournalStore): Promise<JournalEntry[]> {
  for (const [index, date] of dates.entries()) {
    await appendEvent(
      store,
      {
        type: index === 1 ? 'fiche.lue' : 'message.refuse',
        actor: 'agent:12',
        subject: index === 2 ? 'client:24' : 'client:18',
        data: { rule: 'R13', attemptId: `attempt:${index + 1}` },
      },
      () => date,
    );
  }
  return store.all();
}

function sharedStoreTests(name: string, makeStore: () => JournalStore): void {
  describe(name, () => {
    it('valide une chaîne de trois lignes', async () => {
      expect(await verifyChain(await fill(makeStore()))).toEqual({ ok: true });
    });

    it('détecte une ligne 2 modifiée', async () => {
      const entries = await fill(makeStore());
      entries[1] = { ...entries[1]!, type: 'message.envoye' };
      expect(await verifyChain(entries)).toMatchObject({ ok: false, brokenAt: 2 });
    });

    it('détecte une ligne 2 supprimée', async () => {
      const entries = await fill(makeStore());
      entries.splice(1, 1);
      expect(await verifyChain(entries)).toMatchObject({ ok: false });
    });

    it('détecte les lignes 2 et 3 interverties', async () => {
      const entries = await fill(makeStore());
      [entries[1], entries[2]] = [entries[2]!, entries[1]!];
      expect(await verifyChain(entries)).toMatchObject({ ok: false });
    });

    it('refuse deux lignes avec le même numéro', async () => {
      const store = makeStore();
      const [first] = await fill(store);
      await expect(store.append({ ...first!, hash: 'f'.repeat(64) })).rejects.toThrow();
      expect((await store.all()).map(({ seq }) => seq)).toEqual([1, 2, 3]);
    });

    it('garde tous les ajouts simultanés, dans une chaîne valide', async () => {
      const store = makeStore();
      await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          appendEvent(
            store,
            { type: 'message.envoye', actor: 'systeme', subject: `client:${index}`, data: {} },
            () => dates[0]!,
          ),
        ),
      );
      const entries = await store.all();
      expect(entries.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);
      expect(await verifyChain(entries)).toEqual({ ok: true });
    });

    it('filtre par sujet et période, dans l’ordre', async () => {
      const store = makeStore();
      await fill(store);
      expect((await store.bySubject('client:18')).map(({ seq }) => seq)).toEqual([1, 2]);
      expect(
        (
          await store.byPeriod('2026-01-02T10:30:00.000Z', '2026-01-03T09:00:00.000Z')
        ).map(({ seq }) => seq),
      ).toEqual([2, 3]);
    });
  });
}

sharedStoreTests('journal en mémoire', () => new MemoryJournalStore());

describeWithSqlite('journal SQLite', () => {
  const databases: SqliteDatabase[] = [];

  afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
  });

  const makeStore = (): JournalStore => {
    const database = openMemoryDatabase();
    databases.push(database);
    database.exec(migration);
    return new SqliteJournalStore(database);
  };

  it('refuse toute modification ou tout effacement en base', async () => {
    const database = openMemoryDatabase();
    databases.push(database);
    database.exec(migration);
    await fill(new SqliteJournalStore(database));
    expect(() =>
      database.prepare("UPDATE journal SET type = 'message.envoye' WHERE seq = 2").run(),
    ).toThrow(/ajout seul/);
    expect(() => database.prepare('DELETE FROM journal WHERE seq = 2').run()).toThrow(
      /ajout seul/,
    );
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO journal (seq, at, type, actor, subject, data, prev_hash, hash)
           VALUES (2, '2026-01-02T11:00:00.000Z', 'message.envoye', 'agent:12', 'client:18',
                   '{}', ?, ?)`,
        )
        .run('0'.repeat(64), 'e'.repeat(64)),
    ).toThrow(/ajout seul/);
    expect(await verifyChain(await new SqliteJournalStore(database).all())).toEqual({ ok: true });
  });

  sharedStoreTests('stockage', makeStore);
});

describe('données personnelles du journal', () => {
  it('[R13] refuse une adresse mail en clair', async () => {
    await expect(
      appendEvent(
        new MemoryJournalStore(),
        {
          type: 'message.refuse',
          actor: 'systeme',
          subject: null,
          data: { detail: 'Écrire à alice@example.test' },
        },
        () => dates[0]!,
      ),
    ).rejects.toThrow(/donnée personnelle/i);
  });

  it('[R13] refuse un numéro de téléphone en clair', async () => {
    await expect(
      appendEvent(
        new MemoryJournalStore(),
        {
          type: 'message.refuse',
          actor: 'systeme',
          subject: null,
          data: { nested: { detail: '+33 6 12 34 56 78' } },
        },
        () => dates[0]!,
      ),
    ).rejects.toThrow(/donnée personnelle/i);
  });

  it('[R13] refuse une donnée personnelle hors de data', async () => {
    for (const input of [
      { type: 'message.refuse', actor: 'bob@example.test', subject: null },
      { type: 'message.refuse', actor: 'systeme', subject: '06 12 34 56 78' },
      { type: 'appel 0033612345678', actor: 'systeme', subject: null },
    ]) {
      const store = new MemoryJournalStore();
      await expect(appendEvent(store, { ...input, data: {} }, () => dates[0]!)).rejects.toThrow(
        /donnée personnelle/i,
      );
      expect(await store.all()).toEqual([]);
    }
  });

  it('[R13] accepte les identifiants internes au format UUID, même faits surtout de chiffres', async () => {
    const store = new MemoryJournalStore();
    const id = '12345678-0012-3456-7890-123456789012';
    await appendEvent(
      store,
      { type: 'fiche.lue', actor: `agent:${id}`, subject: `person:${id}`, data: { members: [`person:${id}`] } },
      () => dates[0]!,
    );
    expect(await store.all()).toHaveLength(1);
  });

  it("[R13] refuse une adresse mail dont la première partie a la forme d'un UUID", async () => {
    const subject = '550e8400-e29b-41d4-a716-446655440000@relais.example.test';
    await expect(
      appendEvent(new MemoryJournalStore(), { type: 'x', actor: 'systeme', subject, data: {} }, () => dates[0]!),
    ).rejects.toThrow(/donnée personnelle/i);
  });

  it('[R13] refuse encore un numéro collé à un identifiant interne', async () => {
    const id = 'a1b2c3d4-0045-8123-9abc-def012345678';
    for (const subject of [`person:${id} +33 6 12 34 56 78`, `${id}:0612345678`, '0012-3456-7890']) {
      await expect(
        appendEvent(new MemoryJournalStore(), { type: 'x', actor: 'systeme', subject, data: {} }, () => dates[0]!),
      ).rejects.toThrow(/donnée personnelle/i);
    }
  });

  it('[R13] refuse une donnée personnelle dans un nom de champ', async () => {
    const store = new MemoryJournalStore();
    await expect(
      appendEvent(
        store,
        {
          type: 'message.refuse',
          actor: 'systeme',
          subject: null,
          data: { nested: { 'alice@example.test': 'client:18' } },
        },
        () => dates[0]!,
      ),
    ).rejects.toThrow(/donnée personnelle/i);
    expect(await store.all()).toEqual([]);
  });

  it('[R13] contrôle une copie figée de la ligne', async () => {
    const store = new MemoryJournalStore();
    const data = { detail: 'client:18' };
    const pending = appendEvent(
      store,
      { type: 'message.refuse', actor: 'systeme', subject: null, data },
      () => dates[0]!,
    );
    data.detail = 'alice@example.test';
    await pending;
    const [entry] = await store.all();
    expect(entry!.data).toEqual({ detail: 'client:18' });
    expect(await verifyChain(await store.all())).toEqual({ ok: true });
  });

  it('[R13] accepte les identifiants internes', async () => {
    const store = new MemoryJournalStore();
    await appendEvent(
      store,
      {
        type: 'fiche.lue',
        actor: 'agent:12',
        subject: 'client:18',
        data: { attemptId: 'attempt:2026' },
      },
      () => dates[0]!,
    );
    expect(await store.all()).toHaveLength(1);
  });
});
