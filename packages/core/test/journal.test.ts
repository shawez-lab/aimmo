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
});
