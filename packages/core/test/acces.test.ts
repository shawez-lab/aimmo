import { beforeEach, describe, expect, it } from 'vitest';
import {
  Acces,
  FicheClient,
  FicheUnique,
  ROLES,
  SqliteJournalStore,
  applyMigrations,
  decideAccess,
  fromSyncSqlite,
  verifyChain,
  type JournalEntry,
  type JournalStore,
  type Resource,
  type ResourceKind,
  type Role,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const NET = 'net-1';
const OTHER_NET = 'net-2';

const viewer = (role: Role, userId = `${role}-1`, networkId = NET): Viewer => ({ role, userId, networkId });

/** Une ressource de chaque type, qui appartient à l'agent `agent-2` quand elle a un agent. */
const othersResource = (kind: ResourceKind, networkId = NET): Resource => {
  switch (kind) {
    case 'person':
      return { kind, networkId, agentIds: ['agent-2'] };
    case 'property':
      return { kind, networkId, agentId: 'agent-2', status: 'draft' };
    case 'figures':
      return { kind, networkId, agentId: 'agent-2' };
    case 'journal':
    case 'compliance_vault':
      return { kind, networkId };
  }
};

const KINDS: ResourceKind[] = ['person', 'property', 'figures', 'journal', 'compliance_vault'];

describe('droits par rôle et par type de donnée', () => {
  const refusedByRole: Record<Role, ResourceKind[]> = {
    agent: KINDS,
    direction: ['compliance_vault'],
    compliance: ['figures'],
    partner: KINDS,
    // AU107 · l'assistante ne lit qu'un bien du fichier commun (un brouillon d'un autre lui est refusé) ; le comptable rien.
    assistant: KINDS,
    accountant: KINDS,
  };

  for (const role of ROLES) {
    for (const kind of refusedByRole[role]) {
      it(`[R16] ${role} : accès refusé à ${kind} qui n'est pas à lui`, () => {
        expect(decideAccess(viewer(role), othersResource(kind))).toMatchObject({ allowed: false, rule: 'R16' });
      });
    }
    for (const kind of KINDS) {
      it(`[R16] ${role} : accès refusé à ${kind} d'un autre réseau`, () => {
        const own = kind === 'person'
          ? { kind, networkId: OTHER_NET, agentIds: [`${role}-1`] }
          : othersResource(kind, OTHER_NET);
        expect(decideAccess(viewer(role), own as Resource)).toEqual({ allowed: false, rule: 'R16', code: 'other_network' });
      });
    }
  }

  it('[R16] la direction voit fiches, biens, chiffres et journal ; la conformité fiches, biens, journal et coffre', () => {
    for (const kind of ['person', 'property', 'figures', 'journal'] as const) {
      expect(decideAccess(viewer('direction'), othersResource(kind)).allowed).toBe(true);
    }
    for (const kind of ['person', 'property', 'journal', 'compliance_vault'] as const) {
      expect(decideAccess(viewer('compliance'), othersResource(kind)).allowed).toBe(true);
    }
  });

  it('[R16] un agent voit ses clients, ses biens et ses chiffres', () => {
    const me = viewer('agent', 'agent-1');
    expect(decideAccess(me, { kind: 'person', networkId: NET, agentIds: ['agent-1', null] })).toMatchObject({ allowed: true, view: 'full' });
    expect(decideAccess(me, { kind: 'property', networkId: NET, agentId: 'agent-1', status: 'draft' })).toMatchObject({ allowed: true, view: 'full' });
    expect(decideAccess(me, { kind: 'figures', networkId: NET, agentId: 'agent-1' }).allowed).toBe(true);
  });

  it("[R16] un agent ne voit pas une fiche sans agent, ni une fiche réunie à celle d'un autre agent", () => {
    const me = viewer('agent', 'agent-1');
    expect(decideAccess(me, { kind: 'person', networkId: NET, agentIds: [null] })).toMatchObject({ allowed: false, code: 'not_assigned' });
    expect(decideAccess(me, { kind: 'person', networkId: NET, agentIds: ['agent-1', 'agent-2'] })).toMatchObject({ allowed: false });
  });

  it("[R16] les biens en vente d'un autre agent forment le fichier commun, ses autres biens restent privés", () => {
    const me = viewer('agent', 'agent-1');
    for (const status of ['available', 'under_offer'] as const) {
      expect(decideAccess(me, { kind: 'property', networkId: NET, agentId: 'agent-2', status })).toMatchObject({ allowed: true, view: 'shared' });
    }
    for (const status of ['draft', 'sold', 'rented', 'withdrawn'] as const) {
      expect(decideAccess(me, { kind: 'property', networkId: NET, agentId: 'agent-2', status }).allowed).toBe(false);
    }
  });

  it('[R16] un rôle inconnu est refusé partout', () => {
    const intruder = { role: 'admin', userId: 'x', networkId: NET } as unknown as Viewer;
    for (const kind of KINDS) expect(decideAccess(intruder, othersResource(kind)).allowed).toBe(false);
  });
});

describeWithSqlite('lecture des fiches sous droits, écrite au journal', () => {
  let acces: Acces;
  let fiches: FicheClient;
  let unique: FicheUnique;
  let journal: JournalStore;
  let ids: { net: string; a1: string; a2: string; gone: string; p1: string; p2: string; p1b: string; free: string };
  let db: Awaited<ReturnType<typeof setup>>['db'];

  async function setup() {
    const raw = openMemoryDatabase();
    const sql = fromSyncSqlite(raw);
    await applyMigrations(sql, loadMigrations());
    let t = Date.parse('2026-11-02T09:00:00.000Z');
    const now = () => new Date((t += 1000));
    return { db: sql, raw, now };
  }

  beforeEach(async () => {
    const s = await setup();
    db = s.db;
    fiches = new FicheClient(db, { now: s.now });
    unique = new FicheUnique(db, fiches, { now: s.now });
    journal = new SqliteJournalStore(s.raw);
    acces = new Acces(db, fiches, unique, journal, { now: s.now });
    const net = (await fiches.createNetwork('Réseau test')).id;
    const a1 = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Un' })).id;
    const a2 = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Deux' })).id;
    const gone = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Parti' })).id;
    await db.run("UPDATE agents SET status = 'left' WHERE id = ?", [gone]);
    const p1 = (await fiches.createPerson({ networkId: net, agentId: a1, firstName: 'Client', lastName: 'Inventé' })).id;
    const p1b = (await fiches.createPerson({ networkId: net, agentId: null, firstName: 'Client', lastName: 'Double' })).id;
    const p2 = (await fiches.createPerson({ networkId: net, agentId: a2, firstName: 'Autre', lastName: 'Client' })).id;
    const free = (await fiches.createPerson({ networkId: net, agentId: null })).id;
    await fiches.addIdentifier({ networkId: net, personId: p1, kind: 'email', value: 'client.invente@example.test' });
    await unique.merge({ survivorId: p1, mergedId: p1b, reason: 'même mail' });
    ids = { net, a1, a2, gone, p1, p2, p1b, free };
  });

  const agent = (id: string, networkId = ids.net): Viewer => ({ role: 'agent', userId: id, networkId });
  const lines = async (type: string): Promise<JournalEntry[]> => (await journal.all()).filter((e) => e.type === type);

  it('[R16] un agent lit la fiche de son client, et la lecture est écrite au journal sans donnée personnelle', async () => {
    const result = await acces.readFiche(agent(ids.a1), ids.p1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.identifiers.map((i) => i.value)).toEqual(['client.invente@example.test']);
    const [line] = await lines('fiche.lue');
    expect(line).toMatchObject({ actor: `agent:${ids.a1}`, subject: `person:${ids.p1}`, data: { rule: 'R16' } });
    expect(JSON.stringify(await journal.all())).not.toMatch(/invente|Inventé|example\.test/);
    expect(await verifyChain(await journal.all())).toEqual({ ok: true });
  });

  it('[R16] lire une fiche réunie passe par la fiche gardée et le journal le dit', async () => {
    const result = await acces.readFiche(agent(ids.a1), ids.p1b);
    expect(result.ok && result.value.person.id).toBe(ids.p1);
    const [line] = await lines('fiche.lue');
    expect(line?.subject).toBe(`person:${ids.p1}`);
    expect(line?.data.requested).toBe(`person:${ids.p1b}`);
  });

  it("[R16] un agent ne lit pas la fiche d'un autre agent ni une fiche sans agent, et le refus est écrit au journal", async () => {
    expect(await acces.readFiche(agent(ids.a1), ids.p2)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await acces.readFiche(agent(ids.a1), ids.free)).toMatchObject({ ok: false });
    const refusals = await lines('acces.refuse');
    expect(refusals.map((e) => e.subject)).toEqual([`person:${ids.p2}`, `person:${ids.free}`]);
    expect(await lines('fiche.lue')).toEqual([]);
  });

  it("[R16] l'accès d'un agent parti est coupé, comme celui d'un agent d'un autre réseau ou inconnu", async () => {
    expect(await acces.readFiche(agent(ids.gone), ids.p1)).toMatchObject({ ok: false, code: 'agent_inactive' });
    expect(await acces.readFiche(agent(ids.a1, 'autre-reseau'), ids.p1)).toMatchObject({ ok: false, code: 'agent_inactive' });
    expect(await acces.readFiche(agent('inconnu'), ids.p1)).toMatchObject({ ok: false, code: 'agent_inactive' });
    expect(await acces.listPersons(agent(ids.gone))).toMatchObject({ ok: false });
  });

  it('[R16] une fiche inconnue est refusée sans rien révéler', async () => {
    expect(await acces.readFiche(viewer('direction', 'dir-1', ids.net), 'absente')).toMatchObject({ ok: false, code: 'unknown' });
  });

  it("[R16] la direction et la conformité lisent toute fiche du réseau, jamais celle d'un autre réseau ; un partenaire rien", async () => {
    expect((await acces.readFiche(viewer('direction', 'dir-1', ids.net), ids.p2)).ok).toBe(true);
    expect((await acces.readFiche(viewer('compliance', 'conf-1', ids.net), ids.p2)).ok).toBe(true);
    expect(await acces.readFiche(viewer('direction', 'dir-1', 'autre-reseau'), ids.p2)).toMatchObject({ ok: false, code: 'other_network' });
    expect(await acces.readFiche(viewer('partner', 'part-1', ids.net), ids.p2)).toMatchObject({ ok: false, code: 'role' });
    expect(await acces.listPersons(viewer('partner', 'part-1', ids.net))).toMatchObject({ ok: false, code: 'role' });
    expect((await lines('fiche.lue')).map((e) => e.actor)).toEqual(['direction:dir-1', 'compliance:conf-1']);
  });

  it('[R16] la liste des fiches d\'un agent ne montre que ses clients, et la liste est écrite au journal', async () => {
    const mine = await acces.listPersons(agent(ids.a1));
    expect(mine.ok && mine.value.map((p) => p.id)).toEqual([ids.p1]);
    const all = await acces.listPersons(viewer('direction', 'dir-1', ids.net));
    expect(all.ok && all.value.map((p) => p.id).sort()).toEqual([ids.p1, ids.p1b, ids.p2, ids.free].sort());
    const listed = await lines('fiches.listees');
    expect(listed[0]?.data).toMatchObject({ count: 1, persons: [`person:${ids.p1}`] });
  });

  it("[R16] une fiche suivie par l'agent mais réunie à celle d'un autre agent n'apparaît pas dans sa liste", async () => {
    const shared = (await fiches.createPerson({ networkId: ids.net, agentId: ids.a1 })).id;
    // Situation qu'une fusion refuse, créée à la main pour vérifier que la lecture tient quand même.
    await db.run(
      `INSERT INTO person_merges (id, network_id, survivor_id, merged_id, reason, merged_at, created_at)
       VALUES ('m-test', ?, ?, ?, 'test', '2026-11-02T10:00:00.000Z', '2026-11-02T10:00:00.000Z')`,
      [ids.net, ids.p2, shared],
    );
    const mine = await acces.listPersons(agent(ids.a1));
    expect(mine.ok && mine.value.map((p) => p.id)).toEqual([ids.p1]);
    expect(await acces.readFiche(agent(ids.a1), shared)).toMatchObject({ ok: false });
  });

  it("[R16] un bien : complet pour son agent, fiche commune s'il est en vente, refusé sinon", async () => {
    const draft = await fiches.createProperty({ networkId: ids.net, agentId: ids.a2, reference: 'T-1', kind: 'home' });
    const listed = await fiches.createProperty({ networkId: ids.net, agentId: ids.a2, reference: 'T-2', kind: 'home', status: 'available' });
    expect(await acces.readProperty(agent(ids.a2), draft.id)).toMatchObject({ ok: true, view: 'full' });
    expect(await acces.readProperty(agent(ids.a1), listed.id)).toMatchObject({ ok: true, view: 'shared' });
    expect(await acces.readProperty(agent(ids.a1), draft.id)).toMatchObject({ ok: false, code: 'not_assigned' });
    expect(await acces.readProperty(viewer('partner', 'part-1', ids.net), listed.id)).toMatchObject({ ok: false });    const reads = await lines('bien.lu');
    expect(reads.map((e) => [e.actor, e.subject, e.data.view])).toEqual([
      [`agent:${ids.a2}`, `property:${draft.id}`, 'full'],
      [`agent:${ids.a1}`, `property:${listed.id}`, 'shared'],
    ]);
  });

  it("[R16] le journal d'une fiche se lit par la direction et la conformité, jamais par un agent", async () => {
    await acces.readFiche(agent(ids.a1), ids.p1);
    const seen = await acces.readJournalOf(viewer('compliance', 'conf-1', ids.net), ids.p1);
    expect(seen.ok && seen.value.map((e) => e.type)).toEqual(['fiche.lue', 'journal.lu']);
    expect(await acces.readJournalOf(agent(ids.a1), ids.p1)).toMatchObject({ ok: false, code: 'role' });
    expect((await lines('journal.lu')).map((e) => e.actor)).toEqual(['compliance:conf-1']);
  });

  it('[R16] les chiffres : chacun les siens, la direction ceux de son réseau, la conformité aucun, un agent parti rien', async () => {
    expect((await acces.canSeeFigures(agent(ids.a1), ids.a1)).allowed).toBe(true);
    expect((await acces.canSeeFigures(agent(ids.a1), ids.a2)).allowed).toBe(false);
    expect((await acces.canSeeFigures(viewer('direction', 'dir-1', ids.net), ids.a2)).allowed).toBe(true);
    expect((await acces.canSeeFigures(viewer('compliance', 'conf-1', ids.net), ids.a2)).allowed).toBe(false);
    expect(await acces.canSeeFigures(agent(ids.gone), ids.gone)).toMatchObject({ allowed: false, code: 'agent_inactive' });
    expect(await acces.canSeeFigures(viewer('direction', 'dir-1', ids.net), 'inconnu')).toMatchObject({ allowed: false, code: 'unknown' });
    const otherNet = (await fiches.createNetwork('Autre réseau')).id;
    const stranger = (await fiches.createAgent({ networkId: otherNet, firstName: 'Agent', lastName: 'Ailleurs' })).id;
    expect(await acces.canSeeFigures(viewer('direction', 'dir-1', ids.net), stranger)).toMatchObject({ allowed: false, code: 'other_network' });
    expect((await lines('acces.refuse')).length).toBe(5);
  });

  it("[R16] le journal d'une fiche réunie rend aussi les lectures faites par la fiche gardée", async () => {
    await acces.readFiche(agent(ids.a1), ids.p1b);
    for (const id of [ids.p1b, ids.p1]) {
      const seen = await acces.readJournalOf(viewer('direction', 'dir-1', ids.net), id);
      expect(seen.ok && seen.value.filter((e) => e.type === 'fiche.lue').map((e) => e.actor)).toEqual([`agent:${ids.a1}`]);
    }
  });

  it('[R16] si le journal ne répond pas, aucune fiche n\'est lue', async () => {
    const broken: JournalStore = {
      ...journal,
      last: () => journal.last(),
      all: () => journal.all(),
      bySubject: (s) => journal.bySubject(s),
      byPeriod: (a, b) => journal.byPeriod(a, b),
      append: async () => {
        throw new Error('journal indisponible');
      },
    };
    const blind = new Acces(db, fiches, unique, broken);
    await expect(blind.readFiche(agent(ids.a1), ids.p1)).rejects.toThrow('journal indisponible');
    await expect(blind.listPersons(agent(ids.a1))).rejects.toThrow('journal indisponible');
    const listed = await fiches.createProperty({ networkId: ids.net, agentId: ids.a1, reference: 'T-9', kind: 'home' });
    await expect(blind.readProperty(agent(ids.a1), listed.id)).rejects.toThrow('journal indisponible');
  });
});
