import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { ExportAgent, RapportsSurMesure, canonicalJson, exportOrphans, fingerprintOf, parseDefinition } from '../src/rapports/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Jeu de test inventé : agents, clients, dates.

it('[R560] une définition se compose dans le catalogue fermé, jamais par agent', () => {
  expect(parseDefinition({ measures: ['mandats', 'contacts'], grouping: 'mois' })).toEqual({ ok: true, value: { measures: ['contacts', 'mandats'], grouping: 'mois' } });
  expect(parseDefinition({ measures: ['contacts'], grouping: 'agent' })).toEqual({ ok: false, rule: 'R14', code: 'compares_agents' });
  expect(parseDefinition({ measures: ['contacts'], grouping: 'total', agents: ['a', 'b'] })).toEqual({ ok: false, rule: 'R14', code: 'compares_agents' });
  expect(parseDefinition({ measures: ['contacts'], grouping: 'total', filtre: 'x' })).toMatchObject({ ok: false, rule: 'R560', code: 'bad_definition' });
  expect(parseDefinition({ measures: ['chiffre_affaires'], grouping: 'total' })).toMatchObject({ ok: false, code: 'bad_measures' });
  expect(parseDefinition({ measures: ['contacts', 'contacts'], grouping: 'total' })).toMatchObject({ ok: false, code: 'bad_measures' });
  expect(parseDefinition({ measures: [], grouping: 'total' })).toMatchObject({ ok: false, code: 'bad_measures' });
  expect(parseDefinition({ measures: ['contacts'], grouping: 'semaine' })).toMatchObject({ ok: false, code: 'bad_grouping' });
});

it('[R561] l’écriture canonique ne dépend pas de l’ordre des clés', async () => {
  expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
  expect(await fingerprintOf({ a: 1, b: 2 })).toBe(await fingerprintOf({ b: 2, a: 1 }));
  expect(await fingerprintOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
});

describeWithSqlite('HX62 · rapports sur mesure et export complet', () => {
  async function setup() {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const clock = new Date('2027-07-15T10:00:00.000Z');
    const now = () => clock;
    const journal = new SqlJournalStore(db);
    const store = new FicheClient(db, { now });
    new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
    const network = await store.createNetwork('Réseau test');
    const otherNetwork = await store.createNetwork('Autre réseau');
    const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
    // Sam parraine Alex : son identifiant ne doit pas pour autant entrer dans l'export d'Alex.
    await db.run('UPDATE agents SET sponsor_agent_id = ? WHERE id = ?', [sam.id, alex.id]);
    const far = await store.createAgent({ networkId: otherNetwork.id, firstName: 'Loin', lastName: 'Agent' });
    const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
    let n = 0;
    const attribution = async (agentId: string, at: string, net = network.id) => {
      n += 1;
      const p = await store.createPerson({ networkId: net, agentId, firstName: `Client${n}` });
      await db.run("INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at) VALUES (?, ?, ?, NULL, ?, 'zone', 24, NULL, ?)", [`att-${n}`, net, p.id, agentId, at]);
      return p.id;
    };
    const appointment = async (agentId: string, personId: string, at: string, status: string) => {
      n += 1;
      const end = new Date(Date.parse(at) + 3_600_000).toISOString();
      await db.run("INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, replaces_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 'estimation', ?, ?, ?, ?, 'agent', NULL, ?, ?)", [`rdv-${n}`, network.id, agentId, personId, at, end, status, `h${n}`, at, at]);
    };
    const mandate = async (agentId: string, personId: string, at: string) => {
      n += 1;
      await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, project_id, property_id, signed_at, source_kind, source_detail, source_id, recorded_by, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'site', NULL, NULL, ?, ?)", [`man-${n}`, network.id, agentId, personId, at, agentId, at]);
    };
    // Mai à juillet 2027, à Paris. Le 31 mai à 23 h 59 de Paris reste en mai ; minuit le 1er juin est en juin.
    const a1 = await attribution(alex.id, '2027-05-31T21:59:00.000Z');
    const a2 = await attribution(alex.id, '2027-05-31T22:00:00.000Z');
    await attribution(alex.id, '2027-07-02T08:00:00.000Z');
    const s1 = await attribution(sam.id, '2027-06-10T08:00:00.000Z');
    await attribution(far.id, '2027-06-10T08:00:00.000Z', otherNetwork.id);
    await appointment(alex.id, a1, '2027-06-02T08:00:00.000Z', 'honored');
    await appointment(alex.id, a2, '2027-06-03T08:00:00.000Z', 'absent');
    await appointment(sam.id, s1, '2027-06-04T08:00:00.000Z', 'honored');
    await mandate(alex.id, a1, '2027-06-20T08:00:00.000Z');
    await mandate(sam.id, s1, '2027-07-01T08:00:00.000Z');
    // Biens, ventes et parts de commission. Les dossiers de vente ne sont pas montés ici : les clés étrangères sont
    // coupées le temps de ranger ces lignes, comme le socle les range à l'acte.
    for (const [id, agentId, net] of [['bien-alex', alex.id, network.id], ['bien-sam', sam.id, network.id], ['bien-loin', far.id, otherNetwork.id]] as const) {
      await db.run("INSERT INTO properties (id, network_id, agent_id, reference, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'home', 'draft', ?, ?)", [id, net, agentId, `REF-${id}`, '2027-05-02T08:00:00.000Z', '2027-05-02T08:00:00.000Z']);
    }
    await db.run('PRAGMA foreign_keys = OFF');
    await db.run("INSERT INTO commission_grids (id, network_id, version, valid_from, default_rate_bp, agent_rates, created_by, created_at) VALUES ('g1', ?, 1, '2027-01-01', 7000, '{}', 'direction-1', '2027-01-01')", [network.id]);
    const sale = async (fileId: string, agentId: string, net: string, dueOn: string) => {
      await db.run("INSERT INTO sale_commissions (file_id, network_id, mandate_id, agent_id, fee_eur, fee_charge, due_on, status, created_at) VALUES (?, ?, 'man-x', ?, 10000, 'vendeur', ?, 'due', ?)", [fileId, net, agentId, dueOn, `${dueOn}T10:00:00.000Z`]);
      await db.run("INSERT INTO commissions (file_id, network_id, agent_id, mandate_id, compromis_on, fee_cents, fee_charge, grid_id, created_at) VALUES (?, ?, ?, 'man-x', '2027-04-01', 1000000, 'vendeur', 'g1', '2027-04-01')", [fileId, net, agentId]);
    };
    await sale('vente-alex-1', alex.id, network.id, '2027-05-01'); // premier jour de la période
    await sale('vente-alex-2', alex.id, network.id, '2027-07-31'); // dernier jour de la période
    await sale('vente-alex-3', alex.id, network.id, '2027-08-01'); // hors période
    await sale('vente-sam', sam.id, network.id, '2027-06-15');
    await sale('vente-loin', far.id, otherNetwork.id, '2027-06-15');
    const share = (fileId: string, seq: number, kind: string, beneficiary: string | null, reason: string | null, cents: number) =>
      db.run('INSERT INTO commission_shares (file_id, seq, kind, beneficiary_id, reason, amount_cents) VALUES (?, ?, ?, ?, ?, ?)', [fileId, seq, kind, beneficiary, reason, cents]);
    await share('vente-alex-1', 1, 'reseau', null, null, 300000);
    await share('vente-alex-1', 2, 'agent', alex.id, null, 600000);
    await share('vente-alex-1', 3, 'parrainage', sam.id, null, 100000);
    await share('vente-sam', 1, 'reseau', null, null, 300000);
    await share('vente-sam', 2, 'agent', sam.id, null, 400000);
    await share('vente-sam', 3, 'partage', alex.id, 'fichier_commun', 300000);
    await db.run('PRAGMA foreign_keys = ON');
    return {
      db,
      journal,
      store,
      network,
      alex,
      sam,
      far,
      as,
      agent: as('agent', alex.id),
      other: as('agent', sam.id),
      direction: as('direction', 'direction-1'),
      rapports: new RapportsSurMesure(db, journal, { now }),
      // Le second facteur se vérifie dans cles-appareil.test.ts [R601] ; ici, une porte qui laisse passer.
      exports: new ExportAgent(db, journal, { requireSecondFactor: async () => ({ ok: true }) }, { now }),
    };
  }
  const ALL = { measures: ['contacts', 'rendez_vous', 'mandats', 'ventes'], grouping: 'mois' };

  it('[R560] [R69] chaque chiffre est le nombre exact de ses lignes ; mois de Paris, mois vides compris', async () => {
    const t = await setup();
    const r = await t.rapports.run(t.agent, { definition: ALL, from: '2027-05-01', to: '2027-07-31' });
    if (!r.ok) throw new Error(r.code);
    for (const c of r.value.cells) expect(c.value).toBe(c.lines.length);
    const cell = (m: string, k: string) => r.value.cells.find((c) => c.measure === m && c.key === k)!;
    expect(cell('contacts', '2027-05').lines.map((l) => l.id)).toEqual(['att-1']);
    expect(cell('contacts', '2027-06').lines.map((l) => l.id)).toEqual(['att-2']);
    expect(cell('contacts', '2027-07').value).toBe(1);
    expect(cell('rendez_vous', '2027-06').value).toBe(1); // l'absent ne compte pas
    expect(cell('mandats', '2027-06').value).toBe(1);
    expect(cell('mandats', '2027-07').value).toBe(0); // celui de Sam n'est pas là
    expect(cell('ventes', '2027-05').lines.map((l) => l.id)).toEqual(['vente-alex-1']);
    expect(cell('ventes', '2027-06').value).toBe(0); // celle de Sam n'est pas là
    expect(cell('ventes', '2027-07').lines).toEqual([{ id: 'vente-alex-2', at: '2027-07-31' }]); // dernier jour compris
    expect(r.value.cells).toHaveLength(12);
    expect(r.value).toMatchObject({ scope: 'agent', agentId: t.alex.id });
    // Aucune ligne n'en dit plus que l'identifiant et la date.
    for (const c of r.value.cells) for (const l of c.lines) expect(Object.keys(l).sort()).toEqual(['at', 'id']);
  });

  it('[R560] [R14] le total du réseau : la direction seule, sans aucun découpage par agent', async () => {
    const t = await setup();
    const r = await t.rapports.run(t.direction, { definition: { measures: ['contacts', 'mandats', 'ventes'], grouping: 'total' }, from: '2027-05-01', to: '2027-07-31', network: true });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.scope).toBe('reseau');
    expect(r.value.agentId).toBeUndefined();
    expect(r.value.cells.map((c) => [c.measure, c.value])).toEqual([
      ['contacts', 4], // l'autre réseau n'y est pas
      ['mandats', 2],
      ['ventes', 3],
    ]);
    expect(r.value.cells[2]!.lines.map((l) => l.id)).toEqual(['vente-alex-1', 'vente-sam', 'vente-alex-2']);
    expect(JSON.stringify(r.value)).not.toContain(t.alex.id);
    expect(JSON.stringify(r.value)).not.toContain(t.sam.id);
    // Un agent ne lit pas le total du réseau ; personne ne lit deux agents à la fois.
    expect(await t.rapports.run(t.agent, { definition: ALL, from: '2027-05-01', to: '2027-07-31', network: true })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.rapports.run(t.direction, { definition: ALL, from: '2027-05-01', to: '2027-07-31', network: true, agentId: t.alex.id })).toMatchObject({ ok: false, rule: 'R14' });
    expect(await t.rapports.run(t.direction, { definition: { measures: ['contacts'], grouping: 'agent' }, from: '2027-05-01', to: '2027-07-31', network: true })).toMatchObject({ ok: false, rule: 'R14' });
    // La base refuse aussi une définition qui parle d'agent.
    await expect(t.db.run("INSERT INTO custom_reports (id, network_id, owner_id, owner_role, name, definition, created_at) VALUES ('x', ?, 'direction-1', 'direction', 'Par agent', '{\"grouping\":\"agent\"}', '2027-07-15')", [t.network.id])).rejects.toThrow();
  });

  it('[R16] un agent ne lit que ses chiffres ; la direction lit un agent de son réseau ; les autres rôles rien', async () => {
    const t = await setup();
    expect(await t.rapports.run(t.other, { definition: ALL, from: '2027-05-01', to: '2027-07-31', agentId: t.alex.id })).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
    const d = await t.rapports.run(t.direction, { definition: { measures: ['contacts'], grouping: 'total' }, from: '2027-05-01', to: '2027-07-31', agentId: t.sam.id });
    expect(d).toMatchObject({ ok: true, value: { scope: 'agent', agentId: t.sam.id, cells: [{ value: 1 }] } });
    expect(await t.rapports.run(t.direction, { definition: ALL, from: '2027-05-01', to: '2027-07-31', agentId: t.far.id })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.rapports.run(t.as('compliance', 'c-1'), { definition: ALL, from: '2027-05-01', to: '2027-07-31' })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.rapports.run(t.agent, { definition: ALL, from: '2027-01-01', to: '2028-01-31' })).toMatchObject({ ok: false, code: 'bad_period' });
    expect(await t.rapports.run(t.agent, { definition: ALL, from: '2027-02-30', to: '2027-03-01' })).toMatchObject({ ok: false, code: 'bad_period' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    expect(await t.rapports.run(t.agent, { definition: ALL, from: '2027-05-01', to: '2027-07-31' })).toMatchObject({ ok: false, rule: 'R16', code: 'agent_inactive' });
  });

  it('[R560] un rapport enregistré ne change plus et ne se lit que par son auteur', async () => {
    const t = await setup();
    const saved = await t.rapports.save(t.agent, { name: 'Mes mandats du trimestre', definition: { measures: ['mandats'], grouping: 'mois' } });
    if (!saved.ok) throw new Error(saved.code);
    expect(await t.rapports.save(t.agent, { name: '  ', definition: ALL })).toMatchObject({ ok: false, code: 'bad_name' });
    expect(await t.rapports.save(t.agent, { name: 'Classement', definition: { measures: ['mandats'], grouping: 'agent' } })).toMatchObject({ ok: false, rule: 'R14' });
    const list = await t.rapports.list(t.agent);
    expect(list).toMatchObject({ ok: true, value: [{ id: saved.value.id, name: 'Mes mandats du trimestre', definition: { measures: ['mandats'], grouping: 'mois' } }] });
    expect(await t.rapports.list(t.other)).toEqual({ ok: true, value: [] });
    const run = await t.rapports.runSaved(t.agent, saved.value.id, { from: '2027-06-01', to: '2027-06-30' });
    expect(run).toMatchObject({ ok: true, value: { cells: [{ measure: 'mandats', key: '2027-06', value: 1 }] } });
    expect(await t.rapports.runSaved(t.other, saved.value.id, { from: '2027-06-01', to: '2027-06-30' })).toMatchObject({ ok: false, code: 'unknown_report' });
    await expect(t.db.run("UPDATE custom_reports SET name = 'autre' WHERE id = ?", [saved.value.id])).rejects.toThrow();
    await expect(t.db.run('DELETE FROM custom_reports WHERE id = ?', [saved.value.id])).rejects.toThrow();
    // Au journal : la lecture, jamais un chiffre [R13].
    const rows = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type = 'pilotage.lecture'");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.data).not.toMatch(/"value"|att-|man-/);
  });

  it('[R561] l’export de l’agent ne contient que ses données, porte son empreinte et se vérifie', async () => {
    const t = await setup();
    await t.rapports.save(t.agent, { name: 'Contacts', definition: { measures: ['contacts'], grouping: 'total' } });
    await t.rapports.save(t.other, { name: 'Contacts de Sam', definition: { measures: ['contacts'], grouping: 'total' } });
    // Une fiche reprise, suivie par Alex sans aucune attribution.
    const repris = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Repris' });
    const e = await t.exports.make(t.agent);
    if (!e.ok) throw new Error(e.code);
    const { document, fingerprint } = e.value;
    expect(document.agentId).toBe(t.alex.id);
    expect(document.tables.agent.map((r) => r.id)).toEqual([t.alex.id]);
    expect(document.tables.attributions.map((r) => r.id)).toEqual(['att-1', 'att-2', 'att-3']);
    expect(document.tables.contacts.map((r) => r.id)).toContain(repris.id);
    expect(document.tables.contacts).toHaveLength(4);
    expect(Object.keys(document.tables.contacts[0]!).sort()).toEqual(['created_at', 'id']);
    expect(document.tables.appointments).toHaveLength(2);
    expect(document.tables.mandates).toHaveLength(1);
    expect(document.tables.customReports.map((r) => r.name)).toEqual(['Contacts']);
    expect(document.tables.properties.map((r) => r.id)).toEqual(['bien-alex']);
    expect(document.tables.sales.map((r) => r.file_id)).toEqual(['vente-alex-1', 'vente-alex-2', 'vente-alex-3']);
    // Ses parts seulement : la sienne sur sa vente, son partage sur celle de Sam ; ni la part du parrain ni celles de Sam.
    expect(document.tables.commissionShares.map((r) => [r.file_id, r.kind, r.amount_cents])).toEqual([
      ['vente-alex-1', 'agent', 600000],
      ['vente-sam', 'partage', 300000],
    ]);
    const text = JSON.stringify(document);
    expect(text).not.toContain(t.sam.id);
    expect(text).not.toContain(t.far.id);
    expect(text).not.toContain('Sam');
    // Les clients par leurs identifiants seulement : aucun prénom de fiche.
    expect(text).not.toMatch(/Client\d|Repris/);
    // L'empreinte : recalculée, et rangée par AIMMO.
    expect(fingerprint).toBe(await fingerprintOf(document));
    expect(await t.exports.verify(JSON.parse(text))).toEqual({ verified: true, fingerprint });
    const changed = JSON.parse(text) as typeof document;
    changed.tables.mandates = [];
    expect((await t.exports.verify(changed)).verified).toBe(false);
    const other = JSON.parse(text) as typeof document;
    other.agentId = t.sam.id;
    expect((await t.exports.verify(other)).verified).toBe(false);
    expect(await t.exports.verify({ format: 'autre' })).toEqual({ verified: false, fingerprint: null });
    // Le journal garde l'empreinte, jamais le contenu.
    const j = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'export.agent'");
    expect(j).toHaveLength(1);
    expect(j[0]!.data).toContain(fingerprint);
    expect(j[0]!.data).not.toMatch(/att-|Alex/);
    // La base garde l'empreinte, qui ne change plus.
    await expect(t.db.run('UPDATE agent_exports SET fingerprint = ?', ['0'.repeat(64)])).rejects.toThrow();
    await expect(t.db.run('DELETE FROM agent_exports')).rejects.toThrow();
  });

  it('[R561] [R16] l’agent seul tire son export', async () => {
    const t = await setup();
    expect(await t.exports.make(t.direction)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.exports.make(t.as('compliance', 'c-1'))).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.exports.make(t.as('agent', t.alex.id, 'autre-reseau'))).toMatchObject({ ok: false, rule: 'R16' });
    const e = await t.exports.make(t.other);
    expect(e.ok && e.value.document.tables.attributions.map((r) => r.id)).toEqual(['att-4']);
    expect(e.ok && e.value.document.tables.commissionShares.map((r) => [r.file_id, r.kind])).toEqual([
      ['vente-alex-1', 'parrainage'],
      ['vente-sam', 'agent'],
    ]);
  });

  it('[R561] [R16] AU110 · l’export de reprise autorisé par contrat : ses clients, leurs coordonnées, ses pièces, sans référence orpheline', async () => {
    const t = await setup();
    const client = (await t.db.first<{ person_id: string }>("SELECT person_id FROM attributions WHERE id = 'att-1'"))!.person_id;
    await t.store.addIdentifier({ networkId: t.network.id, personId: client, kind: 'email', value: 'client.un@example.test' });
    await t.store.addConsent({ networkId: t.network.id, personId: client, purpose: 'suivi', channel: 'email', proof: 'formulaire test', givenAt: new Date('2027-05-01T08:00:00.000Z') });
    // Une ligne qui désigne la fiche d'un autre agent (un rendez-vous resté à son nom) : hors de ses fiches.
    const autre = (await t.db.first<{ person_id: string }>("SELECT person_id FROM attributions WHERE id = 'att-4'"))!.person_id;
    await t.db.run("INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, replaces_id, created_at, updated_at) VALUES ('rdv-autre', ?, ?, ?, NULL, 'visite', '2027-06-05T08:00:00.000Z', '2027-06-05T09:00:00.000Z', 'honored', 'hx', 'agent', NULL, '2027-06-05', '2027-06-05')", [t.network.id, t.alex.id, autre]);
    await t.db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('fiche-alex', 'bien-alex', ?, 1, ?, 'agent', '2027-05-02')", [t.network.id, JSON.stringify({ media: [{ ref: 'biens/bien-alex/photo-1.jpg', kind: 'photo' }] })]);
    // Deux mandats signés d'Alex : l'un pour son client, l'autre pour un client confié depuis à Sam.
    await t.db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, project_id, property_id, signed_at, source_kind, source_detail, source_id, recorded_by, created_at) VALUES ('man-autre', ?, ?, ?, NULL, NULL, '2027-06-21', 'site', NULL, NULL, ?, '2027-06-21')", [t.network.id, t.alex.id, autre, t.alex.id]);
    // Un mandat de son client qui désigne son projet de vente : le projet part avec lui [AU110].
    await t.db.run("INSERT INTO projects (id, network_id, agent_id, person_id, kind, stage, created_at, updated_at) VALUES ('proj-1', ?, ?, ?, 'sell', 'new', '2027-06-01', '2027-06-01')", [t.network.id, t.alex.id, client]);
    await t.db.run("INSERT INTO projects (id, network_id, agent_id, person_id, kind, stage, created_at, updated_at) VALUES ('proj-autre', ?, ?, ?, 'sell', 'new', '2027-06-01', '2027-06-01')", [t.network.id, t.alex.id, autre]);
    await t.db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, project_id, property_id, signed_at, source_kind, source_detail, source_id, recorded_by, created_at) VALUES ('man-p', ?, ?, ?, 'proj-1', NULL, '2027-06-22', 'site', NULL, NULL, ?, '2027-06-22')", [t.network.id, t.alex.id, client, t.alex.id]);
    await t.db.run('PRAGMA foreign_keys = OFF');
    for (const [doc, mandate, person, scan] of [['doc-a', 'man-9', client, 'mandats/x/scan-a.pdf'], ['doc-b', 'man-autre', autre, 'mandats/x/scan-b.pdf']] as const) {
      await t.db.run("INSERT INTO documents (id, network_id, template_id, template_version, template_hash, kind, mode, status, missing, agent_id, person_id, property_id, content, content_hash, created_by, created_at) VALUES (?, ?, 't', 1, 'h', 'mandat_vente_simple', 'reel', 'complet', '[]', ?, ?, NULL, 'x', 'h', 'agent', '2027-06-20')", [doc, t.network.id, t.alex.id, person]);
      await t.db.run("INSERT INTO signed_documents (document_id, network_id, signed_at, place, scan_ref, mandate_id, number, copy_content, copy_hash, registered_by, created_at) VALUES (?, ?, '2027-06-20', 'agence', ?, ?, NULL, NULL, NULL, 'agent', '2027-06-20')", [doc, t.network.id, scan, mandate]);
    }
    await t.db.run('PRAGMA foreign_keys = ON');
    // Le constat : l'export de l'agent seul porte des identifiants, sans fiche, et des références orphelines.
    const plain = await t.exports.make(t.agent);
    if (!plain.ok) throw new Error(plain.code);
    expect(plain.value.document.tables.clients).toBeUndefined();
    expect(exportOrphans(plain.value.document).length).toBeGreaterThan(0);
    // La direction seule autorise, au vu d'un contrat, pour 90 jours au plus.
    expect(await t.exports.authorize(t.agent, t.alex.id, { scope: 'clients', contractRef: 'C-1' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.exports.authorize(t.direction, t.alex.id, { scope: 'tout', contractRef: 'C-1' })).toEqual({ ok: false, rule: null, code: 'bad_scope' });
    expect(await t.exports.authorize(t.direction, t.alex.id, { scope: 'clients', contractRef: ' ' })).toEqual({ ok: false, rule: null, code: 'bad_contract' });
    expect(await t.exports.authorize(t.direction, t.alex.id, { scope: 'clients', contractRef: 'C-1', days: 91 })).toEqual({ ok: false, rule: null, code: 'bad_days' });
    const given = await t.exports.authorize(t.direction, t.alex.id, { scope: 'clients_pieces', contractRef: 'Contrat de reprise R-2027-04', days: 30 });
    if (!given.ok) throw new Error(given.code);
    // Une autorisation d'un autre agent ne sert pas.
    expect(await t.exports.make(t.other, undefined, { authorizationId: given.value.id })).toMatchObject({ ok: false, rule: 'R16', code: 'no_authorization' });
    const e = await t.exports.make(t.agent, undefined, { authorizationId: given.value.id });
    if (!e.ok) throw new Error(e.code);
    const doc = e.value.document;
    expect(doc.authorization).toEqual({ id: given.value.id, scope: 'clients_pieces', contractRef: 'Contrat de reprise R-2027-04', expiresOn: '2027-08-14' });
    expect(doc.tables.clients).toHaveLength(3);
    expect(doc.tables.clientIdentifiers).toEqual([{ person_id: client, kind: 'email', value: 'client.un@example.test' }]);
    expect(doc.tables.clientConsents).toMatchObject([{ person_id: client, purpose: 'suivi', channel: 'email' }]);
    expect(doc.tables.files).toEqual([
      { table: 'signed_documents', ref: 'mandats/x/scan-a.pdf', mandate_id: 'man-9' },
      { table: 'property_sheets', ref: 'biens/bien-alex/photo-1.jpg', property_id: 'bien-alex' },
    ]);
    // Ce qui n'est pas à lui est écarté et compté : le mandat et le scan du client confié à Sam, les ventes et parts hors
    // de l'export ; rien d'orphelin ne reste ; rien d'un autre agent n'y entre.
    expect(doc.excluded).toEqual({ appointments: 1, mandates: 1, sales: 3, commissionShares: 2, files: 1 });
    expect(doc.tables.commissionShares).toEqual([]);
    expect(doc.tables.projects!.map((r) => r.id)).toEqual(['proj-1']);
    expect(doc.tables.mandates!.find((r) => r.id === 'man-p')).toMatchObject({ project_id: 'proj-1' });
    expect(exportOrphans(doc)).toEqual([]);
    expect(JSON.stringify(doc)).not.toContain(autre);
    expect(JSON.stringify(doc)).not.toContain(t.sam.id);
    expect(await t.exports.verify(JSON.parse(JSON.stringify(doc)))).toEqual({ verified: true, fingerprint: e.value.fingerprint });
    // Échue, l'autorisation ne sert plus.
    const late = new ExportAgent(t.db, t.journal, { requireSecondFactor: async () => ({ ok: true }) }, { now: () => new Date('2027-08-15T10:00:00.000Z') });
    expect(await late.make(t.agent, undefined, { authorizationId: given.value.id })).toMatchObject({ ok: false, rule: 'R16', code: 'no_authorization' });
  });
});
