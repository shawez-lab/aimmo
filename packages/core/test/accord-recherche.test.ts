import { expect, it } from 'vitest';
import {
  AGENT_CONSENT_LABELS,
  AGENT_CONSENT_PURPOSES,
  Acces,
  AccordsFiche,
  FicheAcquereur,
  FicheClient,
  FicheUnique,
  Rapprochement,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  type DiffusionGate,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { RechercheLangage, SEARCH_CONSENT_PURPOSE } from '../src/recherche/langage-courant.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// RC13 : l'agent note l'accord `buyer_search`, que rien d'autre ne range. Tout est inventé.
const START = Date.parse('2027-03-09T09:00:00.000Z');
const PHRASE = 'Maison 4 pièces à Dijon, 100 m² mini, budget 350 000 €, si possible un garage';
const PROOF = 'Elle m’a demandé de garder sa recherche, de vive voix, à l’agence.';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const accords = new AccordsFiche(store, acces, journal, { now });
  const acquereurs = new FicheAcquereur(db, journal, { now });
  const diffusion: DiffusionGate = {
    canDiffuse: async () => ({ allowed: true, reason: 'allowed' }),
  };
  const rapprochement = new Rapprochement(db, fiche, diffusion, journal, {
    now,
  });
  const recherche = new RechercheLangage(
    db,
    {
      propertyForMatch: async (p) => ({
        ...(await rapprochement.propertyForMatch(p)),
        features: [],
      }),
    },
    diffusion,
    journal,
    { now },
  );
  const network = await store.createNetwork('Réseau test');
  const alexAgent = await store.createAgent({
    networkId: network.id,
    firstName: 'Alex',
    lastName: 'Agent',
  });
  const samAgent = await store.createAgent({
    networkId: network.id,
    firstName: 'Sam',
    lastName: 'Agent',
  });
  const alex: Viewer = {
    role: 'agent',
    userId: alexAgent.id,
    networkId: network.id,
  };
  const sam: Viewer = {
    role: 'agent',
    userId: samAgent.id,
    networkId: network.id,
  };
  const person = await store.createPerson({
    networkId: network.id,
    agentId: alexAgent.id,
    firstName: 'Camille',
  });
  await store.addIdentifier({
    networkId: network.id,
    personId: person.id,
    kind: 'email',
    value: 'camille.inventee@example.test',
  });
  const project = await store.createProject({
    networkId: network.id,
    agentId: alexAgent.id,
    personId: person.id,
    kind: 'buy',
  });
  const input = {
    purpose: 'buyer_search',
    channel: 'email',
    proof: PROOF,
    givenOn: '2027-03-08',
  };
  const save = (viewer: Viewer = alex) => recherche.save(acces, viewer, acquereurs, project.id, PHRASE);
  return { db, journal, accords, alex, sam, person, project, input, save };
}

it('[R03] la finalité de la recherche rangée est dans la liste fermée, sous le nom que la recherche lit', () => {
  expect(SEARCH_CONSENT_PURPOSE).toBe('buyer_search');
  expect(AGENT_CONSENT_PURPOSES).toContain(SEARCH_CONSENT_PURPOSE);
  expect(AGENT_CONSENT_LABELS[SEARCH_CONSENT_PURPOSE]).toBe('Recherche rangée dans la fiche acquéreur');
});

describeWithSqlite('RC13 · l’agent note l’accord de ranger une recherche', () => {
  it('[R422] noté par l’agent, la recherche se range ; retiré, elle est refusée', async () => {
    const t = await setup();
    expect(await t.save()).toEqual({
      ok: false,
      rule: 'R422',
      code: 'sans_accord',
    });

    const noted = await t.accords.record(t.alex, t.person.id, t.input);
    expect(noted).toMatchObject({ ok: true, value: { already: false } });
    const saved = await t.save();
    expect(saved.ok).toBe(true);
    const [row] = await t.db.all<{ consent_id: string }>('SELECT consent_id FROM phrase_searches');
    expect(row!.consent_id).toBe(noted.ok ? noted.value.consentId : '');

    const taken = await t.accords.withdraw(t.alex, t.person.id, noted.ok ? noted.value.consentId : '');
    expect(taken.ok).toBe(true);
    expect(await t.save()).toEqual({
      ok: false,
      rule: 'R422',
      code: 'sans_accord',
    });
    // La recherche déjà rangée reste [R17].
    expect(await t.db.all('SELECT id FROM phrase_searches')).toHaveLength(1);
  });

  it('[R16] un autre agent ne note pas cet accord, et le refus va au journal', async () => {
    const t = await setup();
    const refused = await t.accords.record(t.sam, t.person.id, t.input);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.rule).toBe('R16');
    expect(await t.db.all("SELECT id FROM consents WHERE purpose = 'buyer_search'")).toEqual([]);
    expect(await t.save()).toEqual({
      ok: false,
      rule: 'R422',
      code: 'sans_accord',
    });
    const entries = await t.journal.all();
    expect(entries.some((e) => e.type === 'acces.refuse')).toBe(true);
  });

  it('[R03] sans preuve écrite, ou daté dans le futur, rien n’est noté', async () => {
    const t = await setup();
    expect(
      (
        await t.accords.record(t.alex, t.person.id, {
          ...t.input,
          proof: 'oui',
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await t.accords.record(t.alex, t.person.id, {
          ...t.input,
          givenOn: '2027-03-20',
        })
      ).ok,
    ).toBe(false);
    expect(await t.db.all("SELECT id FROM consents WHERE purpose = 'buyer_search'")).toEqual([]);
  });
});
