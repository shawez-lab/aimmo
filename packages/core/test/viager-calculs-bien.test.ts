import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { VIAGER_LIST_LIMIT, Viager } from '../src/neuf-viager/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Jeu de test inventé : âges, valeurs, taux, tables d'espérance, personnes et biens n'ont rien de réel.
describeWithSqlite('RC47 · les calculs de viager d’un bien, relus d’une ouverture à l’autre', () => {
  async function setup() {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    let clock = new Date('2027-03-01T10:00:00.000Z');
    const now = () => clock;
    const journal = new SqlJournalStore(db);
    const store = new FicheClient(db, { now });
    const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
    const network = await store.createNetwork('Réseau test');
    const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
    const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
    const agent = as('agent', alex.id);
    const other = as('agent', sam.id);
    const direction = as('direction', 'direction-1');
    const viager = new Viager(db, journal, { now });
    const property = (reference: string) =>
      store.createProperty({ networkId: network.id, agentId: alex.id, reference, kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 200000, status: 'available' });
    const table = async (vintage: string, rows = [{ age: 68, expectancyTenths: 175 }, { age: 75, expectancyTenths: 128 }]) => {
      const r = await viager.importLifeTable(direction, { vintage, source: 'Table inventée pour les tests, ensemble des deux sexes', rows });
      if (!r.ok) throw new Error(r.code);
      return r.value.tableId;
    };
    const typed = {
      marketValue: { value: 20_000_000, hypothesis: 'valeur libre de l’avis de valeur' },
      occupied: { value: true, hypothesis: 'le vendeur garde l’usage' },
      headAges: { value: [75], hypothesis: 'âge déclaré' },
      bouquet: { value: 3_000_000, hypothesis: 'convenu avec le vendeur' },
      annualRateBp: { value: 300, hypothesis: 'taux technique retenu' },
    };
    let minute = 0;
    const compute = async (viewer: Viewer, input: { propertyId?: string; projectId?: string }, inputs: unknown = typed) => {
      minute += 1;
      clock = new Date(Date.parse('2027-03-01T10:00:00.000Z') + minute * 60_000);
      const r = await viager.compute(acces, viewer, { ...input, inputs });
      if (!r.ok) throw new Error(r.code);
      return r.value.id;
    };
    const ids = (r: Awaited<ReturnType<Viager['listForProperty']>>) => {
      if (!r.ok) throw new Error(r.code);
      return r.value.map((c) => c.calculation.id);
    };
    return { db, journal, acces, store, network, alex, sam, agent, other, direction, viager, property, table, typed, compute, ids, setClock: (d: Date) => (clock = d) };
  }

  it('[R16] les calculs du bien, du plus récent au plus ancien, 50 au plus, jamais ceux d’un autre bien', async () => {
    const t = await setup();
    await t.table('2024');
    const p = await t.property('REF-RC47-1');
    const q = await t.property('REF-RC47-2');
    const first = await t.compute(t.agent, { propertyId: p.id });
    const elsewhere = await t.compute(t.agent, { propertyId: q.id });
    const loose = await t.compute(t.agent, {});
    const second = await t.compute(t.agent, { propertyId: p.id });
    expect(t.ids(await t.viager.listForProperty(t.acces, t.agent, p.id))).toEqual([second, first]);
    const onQ = t.ids(await t.viager.listForProperty(t.acces, t.agent, q.id));
    expect(onQ).toEqual([elsewhere]);
    expect(onQ).not.toContain(loose);
    // Au-delà de 50 : les 50 plus récents seulement.
    const many: string[] = [second, first];
    for (let i = 0; i < VIAGER_LIST_LIMIT; i += 1) many.unshift(await t.compute(t.agent, { propertyId: p.id }));
    const listed = t.ids(await t.viager.listForProperty(t.acces, t.agent, p.id));
    expect(VIAGER_LIST_LIMIT).toBe(50);
    expect(listed).toEqual(many.slice(0, 50));
    expect(listed).not.toContain(first);
  });

  it('[R540] [R541] chaque calcul dit s’il se rejoue à l’identique, et un écart quand ce qui est rangé ne tient plus', async () => {
    const t = await setup();
    await t.table('2024');
    const p = await t.property('REF-RC47-3');
    const id = await t.compute(t.agent, { propertyId: p.id });
    const r = await t.viager.listForProperty(t.acces, t.agent, p.id);
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toHaveLength(1);
    expect(r.value[0]).toMatchObject({ replay: 'identique', tableReplaced: false });
    const one = await t.viager.read(t.acces, t.agent, id);
    if (!one.ok) throw new Error(one.code);
    expect(r.value[0]!.calculation).toEqual(one.value);
    // Un calcul rangé dont le résultat ne suit plus ses entrées : un écart, jamais « identique ».
    await t.db.run(
      `INSERT INTO viager_calculations (id, network_id, property_id, project_id, inputs, status, result, formula_version, created_by, created_at)
       SELECT 'calc-faux', network_id, property_id, project_id, inputs, status, replace(result, '"monthlyRentCents":', '"monthlyRentCents":1'), formula_version, created_by, '2027-03-02T09:00:00.000Z'
       FROM viager_calculations WHERE id = ?`,
      [id],
    );
    // Un calcul qui cite une table que le réseau n'a pas : un écart aussi.
    await t.db.run(
      `INSERT INTO viager_calculations (id, network_id, property_id, project_id, inputs, status, result, formula_version, created_by, created_at)
       SELECT 'calc-table', network_id, property_id, project_id, replace(inputs, '"table:', '"table:x'), status, result, formula_version, created_by, '2027-03-02T08:00:00.000Z'
       FROM viager_calculations WHERE id = ?`,
      [id],
    );
    const again = await t.viager.listForProperty(t.acces, t.agent, p.id);
    if (!again.ok) throw new Error(again.code);
    expect(again.value.map((c) => [c.calculation.id, c.replay])).toEqual([
      ['calc-faux', 'ecart'],
      ['calc-table', 'ecart'],
      [id, 'identique'],
    ]);
  });

  it('[R541] une table plus récente importée après le calcul : « table remplacée », jamais avant ; un calcul incomplet ne cite aucune table', async () => {
    const t = await setup();
    const p = await t.property('REF-RC47-4');
    // Sans table : calcul incomplet, sans espérance ; ni écart inventé ni table remplacée.
    const incomplete = await t.compute(t.agent, { propertyId: p.id });
    await t.table('2024');
    const before = await t.compute(t.agent, { propertyId: p.id });
    let r = await t.viager.listForProperty(t.acces, t.agent, p.id);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.map((c) => [c.calculation.id, c.calculation.result.status, c.replay, c.tableReplaced])).toEqual([
      [before, 'complet', 'identique', false],
      [incomplete, 'incomplet', 'identique', false],
    ]);
    t.setClock(new Date('2027-04-01T10:00:00.000Z'));
    await t.table('2025', [{ age: 75, expectancyTenths: 131 }]);
    const after = await t.compute(t.agent, { propertyId: p.id });
    r = await t.viager.listForProperty(t.acces, t.agent, p.id);
    if (!r.ok) throw new Error(r.code);
    // Le calcul neuf a été fait le 2027-03-01 à l'horloge du test : seul l'ordre des tables compte, pas la date.
    const byId = new Map(r.value.map((c) => [c.calculation.id, c]));
    expect(byId.get(before)).toMatchObject({ replay: 'identique', tableReplaced: true });
    expect(byId.get(after)).toMatchObject({ replay: 'identique', tableReplaced: false });
    expect(byId.get(incomplete)).toMatchObject({ replay: 'identique', tableReplaced: false });
  });

  it('[R16] bien vu en partage : les calculs de l’agent lui-même seulement ; projet d’une fiche qui n’est pas la sienne : absent ; direction : tous', async () => {
    const t = await setup();
    await t.table('2024');
    const p = await t.property('REF-RC47-5');
    // Alex suit le vendeur du bien ; Sam suit une autre personne dont le projet possède aussi le bien.
    const seller = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Léa', lastName: 'Exemple' });
    const sellerProject = await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: seller.id, kind: 'sell' });
    const coOwner = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.id, firstName: 'Noé', lastName: 'Exemple' });
    const coOwnerProject = await t.store.createProject({ networkId: t.network.id, agentId: t.sam.id, personId: coOwner.id, kind: 'sell' });
    for (const project of [sellerProject.id, coOwnerProject.id]) {
      await t.db.run("INSERT INTO project_properties (project_id, property_id, network_id, agent_id, role, created_at) VALUES (?, ?, ?, NULL, 'owned', '2027-03-01T09:00:00.000Z')", [
        project,
        p.id,
        t.network.id,
      ]);
    }
    const alexLoose = await t.compute(t.agent, { propertyId: p.id });
    const alexProject = await t.compute(t.agent, { propertyId: p.id, projectId: sellerProject.id });
    const samOwn = await t.compute(t.other, { propertyId: p.id });
    const directionOnSam = await t.compute(t.direction, { propertyId: p.id, projectId: coOwnerProject.id });
    expect(await t.acces.readProperty(t.other, p.id)).toMatchObject({ ok: true, view: 'shared' });
    // Sam voit le bien en partage : son propre calcul seulement, pas même celui que la direction a fait pour le projet de sa fiche.
    const forSam = t.ids(await t.viager.listForProperty(t.acces, t.other, p.id));
    expect(forSam).toContain(samOwn);
    expect(forSam).not.toContain(alexLoose);
    expect(forSam).not.toContain(alexProject);
    expect(forSam).not.toContain(directionOnSam);
    // Alex voit le bien en entier : tout, sauf le calcul rattaché au projet d'une fiche qui n'est pas à lui.
    expect(t.ids(await t.viager.listForProperty(t.acces, t.agent, p.id))).toEqual([samOwn, alexProject, alexLoose]);
    // La direction : tous.
    expect(t.ids(await t.viager.listForProperty(t.acces, t.direction, p.id))).toEqual([directionOnSam, samOwn, alexProject, alexLoose]);
    // Chaque calcul relu dans la liste se relit aussi un par un : mêmes droits que `read`.
    for (const [viewer, listed] of [
      [t.other, forSam],
      [t.agent, [samOwn, alexProject, alexLoose]],
    ] as const) {
      for (const id of [alexLoose, alexProject, samOwn, directionOnSam]) expect((await t.viager.read(t.acces, viewer, id)).ok).toBe(listed.includes(id));
    }
    // Le journal de la liste ne garde ni montant ni âge.
    const events = (await t.journal.all()).filter((e) => e.type === 'viager.calculs_relus');
    expect(events.length).toBe(3);
    expect(JSON.stringify(events)).not.toMatch(/20000000|3000000|\b75\b/);
  });

  it('[R16] bien inconnu ou d’un autre réseau, agent parti ou au dossier incomplet, autre rôle : refus, rien lu', async () => {
    const t = await setup();
    await t.table('2024');
    const p = await t.property('REF-RC47-6');
    await t.compute(t.agent, { propertyId: p.id });
    const elsewhere = await t.store.createNetwork('Autre réseau');
    const far = await t.store.createAgent({ networkId: elsewhere.id, firstName: 'Ana', lastName: 'Agent' });
    const farProperty = await t.store.createProperty({ networkId: elsewhere.id, agentId: far.id, reference: 'REF-RC47-X', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 40, rooms: 2, priceEur: 100000, status: 'available' });
    expect(await t.viager.listForProperty(t.acces, t.agent, 'inconnu')).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
    expect(await t.viager.listForProperty(t.acces, t.agent, 42)).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
    expect(await t.viager.listForProperty(t.acces, t.agent, farProperty.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.viager.listForProperty(t.acces, t.direction, farProperty.id)).toMatchObject({ ok: false, rule: 'R16' });
    const conformite = { role: 'compliance', userId: 'c-1', networkId: t.network.id } as Viewer;
    expect(await t.viager.listForProperty(t.acces, conformite, p.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    // Dossier d'agent incomplet (une pièce échue) : plus rien, même ses propres calculs [R82].
    await t.db.run(
      "INSERT INTO agent_file_pieces (id, network_id, agent_id, kind, version, ref, issued_on, valid_until, is_draft, recorded_by, recorded_at) VALUES ('pc-1', ?, ?, 'assurance_rcp', 1, 'ref-pc-1', '2026-01-01', '2026-12-31', 0, 'direction:direction-1', '2027-01-01T00:00:00.000Z')",
      [t.network.id, t.sam.id],
    );
    expect(await t.viager.listForProperty(t.acces, t.other, p.id)).toEqual({ ok: false, rule: 'R16', code: 'agent_file_incomplete' });
    // Agent parti : plus rien.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    expect(await t.viager.listForProperty(t.acces, t.agent, p.id)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    // Aucun de ces refus n'a relu de calcul.
    expect((await t.journal.all()).filter((e) => e.type === 'viager.calculs_relus')).toHaveLength(0);
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && (e.data as { kind?: string }).kind === 'viager_calculation');
    expect(refused.length).toBeGreaterThanOrEqual(4);
  });
});
