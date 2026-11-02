import { expect, it } from 'vitest';
import { FicheClient, FicheUnique, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { ficheFirstName } from '../src/fiche/prenom.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  let clock = Date.parse('2027-01-01T08:00:00.000Z');
  const fiche = new FicheUnique(db, store, { now: () => new Date((clock += 1000)) });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const person = (firstName?: string) => store.createPerson({ networkId: network.id, agentId: alex.id, ...(firstName ? { firstName } : {}) });
  return { db, fiche, person };
}

/** Le prénom que le contrôle central attend : le premier des membres de la fiche, dans l'ordre de la vue. */
const expectedByControl = async (fiche: FicheUnique, id: string) => (await fiche.view(id)).members.map((m) => m.first_name).find((n) => n) ?? null;

describeWithSqlite('AC10 · le prénom de la fiche gardée', () => {
  it('[R08] celui de la fiche gardée, quel que soit le doublon par lequel on entre, à chaque passage', async () => {
    const t = await setup();
    const a = await t.person('Inès');
    const b = await t.person('Inna');
    const [kept, merged] = a.id > b.id ? [a, b] : [b, a];
    await t.fiche.merge({ survivorId: kept.id, mergedId: merged.id, reason: 'test' });
    for (const entry of [kept.id, merged.id, kept.id]) {
      expect(await ficheFirstName(t.db, await t.fiche.membersOf(entry))).toBe(kept.first_name);
    }
  });

  it('[R08] sans prénom sur la fiche gardée : celui d’un doublon, toujours le même, celui que le contrôle central attend', async () => {
    const t = await setup();
    const kept = await t.person();
    // Le doublon réuni le premier est celui dont l'identifiant est le plus grand : un tri par identifiant se tromperait.
    const doubles = (await Promise.all(['Zoé', 'Anna', 'Mia'].map((n) => t.person(n)))).sort((x, y) => y.id.localeCompare(x.id));
    for (const d of doubles) await t.fiche.merge({ survivorId: kept.id, mergedId: d.id, reason: 'test' });
    const members = await t.fiche.membersOf(kept.id);
    expect(await ficheFirstName(t.db, members)).toBe(doubles[0]!.first_name);
    expect(await ficheFirstName(t.db, members)).toBe(await expectedByControl(t.fiche, kept.id));
  });

  it('sans aucun prénom, ni fiche : rien', async () => {
    const t = await setup();
    const alone = await t.person();
    expect(await ficheFirstName(t.db, [alone.id])).toBeNull();
    expect(await ficheFirstName(t.db, [])).toBeNull();
  });
});
