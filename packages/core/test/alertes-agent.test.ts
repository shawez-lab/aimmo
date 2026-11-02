import { expect, it } from 'vitest';
import { AlertesAgent, FicheClient, FicheUnique, MAX_AGENT_ALERTS, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé.
const TUESDAY_10H = new Date('2026-12-08T09:00:00.000Z').getTime();

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Autre' });
  const lea = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  const zoe = await store.createPerson({ networkId: network.id, agentId: sam.id, firstName: 'Zoé', lastName: 'Exemple' });
  const service = new AlertesAgent(db, journal, { now });
  let n = 0;
  const alert = async (personId: string, agentId: string | null, over: { conversation?: string; reason?: string } = {}) => {
    n += 1;
    const id = `alerte-${String(n).padStart(3, '0')}`;
    await db.run(`INSERT INTO agent_alerts (id, network_id, agent_id, person_id, conversation_id, reason, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`, [
      id,
      network.id,
      agentId,
      personId,
      over.conversation ?? `instagram:conv-${n}`,
      over.reason ?? 'needs_reply',
      new Date(clock + n * 1000).toISOString(),
    ]);
    return id;
  };
  const asAgent = (id: string): Viewer => ({ role: 'agent', networkId: network.id, userId: id });
  /** Marque vue telle que la base la montre : le cas d'un écran à jour. */
  const seen = async (agentId: string, id: string) => {
    const row = await db.first<{ created_at: string }>('SELECT created_at FROM agent_alerts WHERE id = ?', [id]);
    return service.markSeen(asAgent(agentId), id, row?.created_at ?? 'inconnue');
  };
  const lines = () => db.all<{ type: string; actor: string; subject: string | null; data: string }>('SELECT type, actor, subject, data FROM journal ORDER BY rowid');
  return { db, now, tick: (ms: number) => (clock += ms), journal, store, fiche, network, other, alex, sam, lea, zoe, service, alert, asAgent, seen, lines };
}

describeWithSqlite('C09c · alertes de l’agent', () => {
  it('[R16] l’agent voit ses alertes et celles de ses fiches, jamais celles d’un autre', async () => {
    const t = await setup();
    await t.alert(t.lea.id, t.alex.id);
    // Fiche sans agent à l'heure de l'alerte, attribuée ensuite : l'alerte suit la fiche.
    await t.alert(t.lea.id, null);
    await t.alert(t.zoe.id, t.sam.id);
    const seenByAlex = await t.service.list(t.asAgent(t.alex.id));
    if (!seenByAlex.ok) throw new Error(seenByAlex.code);
    expect(seenByAlex.value.alerts.map((a) => a.firstName)).toEqual(['Léa', 'Léa']);
    const seenBySam = await t.service.list(t.asAgent(t.sam.id));
    if (!seenBySam.ok) throw new Error(seenBySam.code);
    expect(seenBySam.value.alerts.map((a) => a.personId)).toEqual([t.zoe.id]);
  });

  it('[R16] la fiche passée à un autre agent emporte son alerte ; une fiche d’un autre réseau ne donne rien', async () => {
    const t = await setup();
    const id = await t.alert(t.lea.id, t.alex.id);
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.id, t.lea.id]);
    const before = await t.service.list(t.asAgent(t.alex.id));
    expect(before).toMatchObject({ ok: true, value: { alerts: [] } });
    expect(await t.seen(t.alex.id, id)).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
    const after = await t.service.list(t.asAgent(t.sam.id));
    expect(after.ok && after.value.alerts.map((a) => a.id)).toEqual([id]);
    expect(await t.service.markSeen({ role: 'agent', networkId: t.other.id, userId: t.sam.id }, id, 'x')).toMatchObject({ ok: false, code: 'agent_inactive' });
  });

  it('[R16] fiches réunies : l’alerte d’une fiche fusionnée s’ouvre sur la fiche gardée, de proche en proche', async () => {
    const t = await setup();
    const free = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Doublon', lastName: 'Exemple' });
    const free2 = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Doublon2', lastName: 'Exemple' });
    const id = await t.alert(free2.id, null);
    await t.fiche.merge({ survivorId: free.id, mergedId: free2.id, reason: 'même personne' });
    await t.fiche.merge({ survivorId: t.lea.id, mergedId: free.id, reason: 'même personne' });
    const read = await t.service.list(t.asAgent(t.alex.id));
    if (!read.ok) throw new Error(read.code);
    expect(read.value.alerts).toMatchObject([{ id, personId: t.lea.id, firstName: 'Léa' }]);
    // Personne d'autre ne la voit.
    expect(await t.service.list(t.asAgent(t.sam.id))).toMatchObject({ ok: true, value: { alerts: [] } });
  });

  it('[R16] une alerte inconnue et celle d’un autre reçoivent le même refus, écrit au journal ; les autres rôles sont refusés', async () => {
    const t = await setup();
    const id = await t.alert(t.zoe.id, t.sam.id);
    const theirs = await t.seen(t.alex.id, id);
    const unknown = await t.seen(t.alex.id, 'inconnue');
    expect(theirs).toEqual(unknown);
    expect((await t.db.first<{ seen_at: string | null }>('SELECT seen_at FROM agent_alerts WHERE id = ?', [id]))!.seen_at).toBeNull();
    expect((await t.lines()).filter((l) => l.type === 'acces.refuse')).toHaveLength(2);
    for (const role of ['direction', 'compliance', 'partner'] as const) {
      expect(await t.service.list({ role, networkId: t.network.id, userId: 'x' })).toMatchObject({ ok: false, code: 'role' });
    }
  });

  it('[R86] [R82] un agent parti ou au dossier incomplet ne lit rien', async () => {
    const t = await setup();
    await t.alert(t.lea.id, t.alex.id);
    // Une seule pièce rangée : le dossier existe, il n'est pas complet.
    await t.db.run(
      "INSERT INTO agent_file_pieces (id, network_id, agent_id, kind, version, ref, issued_on, valid_until, is_draft, recorded_by, recorded_at) VALUES ('piece-1', ?, ?, 'contrat_agent_commercial', 1, 'ref-1', '2026-01-01', NULL, 0, 'test', ?)",
      [t.network.id, t.alex.id, t.now().toISOString()],
    );
    expect(await t.service.list(t.asAgent(t.alex.id))).toMatchObject({ ok: false, code: 'agent_file_incomplete' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    expect(await t.service.list(t.asAgent(t.alex.id))).toMatchObject({ ok: false, code: 'agent_inactive' });
  });

  it('[R17] marquer vue ne supprime rien : la ligne reste, datée, et sort de la liste ; un second geste ne change rien', async () => {
    const t = await setup();
    const id = await t.alert(t.lea.id, t.alex.id);
    const keep = await t.alert(t.lea.id, t.alex.id);
    expect(await t.seen(t.alex.id, id)).toEqual({ ok: true, value: { already: false, changed: false } });
    const first = (await t.db.first<{ seen_at: string }>('SELECT seen_at FROM agent_alerts WHERE id = ?', [id]))!.seen_at;
    expect(first).toBe(t.now().toISOString());
    t.tick(60_000);
    expect(await t.seen(t.alex.id, id)).toEqual({ ok: true, value: { already: true, changed: false } });
    expect((await t.db.first<{ seen_at: string }>('SELECT seen_at FROM agent_alerts WHERE id = ?', [id]))!.seen_at).toBe(first);
    expect((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM agent_alerts'))!.n).toBe(2);
    const read = await t.service.list(t.asAgent(t.alex.id));
    expect(read.ok && read.value.alerts.map((a) => a.id)).toEqual([keep]);
    expect((await t.lines()).filter((l) => l.type === 'alerte_agent.vue')).toHaveLength(1);
  });

  it('[R13] le journal et la réponse ne portent ni nom ni référence de conversation', async () => {
    const t = await setup();
    const id = await t.alert(t.lea.id, t.alex.id, { conversation: 'email:lea.exemple@example.test' });
    const odd = await t.alert(t.lea.id, t.alex.id, { conversation: 'portail:06-00-00-00-00' });
    const read = await t.service.list(t.asAgent(t.alex.id));
    if (!read.ok) throw new Error(read.code);
    expect(read.value.alerts.map((a) => a.channel)).toEqual(['email', null]);
    expect(JSON.stringify(read.value)).not.toMatch(/example\.test|06-00|conv/);
    await t.seen(t.alex.id, id);
    await t.seen(t.alex.id, odd);
    const lines = await t.lines();
    // Chaque prénom rendu est écrit au journal avant d'être rendu [R16].
    expect(lines.filter((l) => l.type === 'fiche.lue').map((l) => l.subject)).toEqual([`person:${t.lea.id}`, `person:${t.lea.id}`]);
    expect(JSON.stringify(lines)).not.toMatch(/Léa|Exemple|example\.test|06-00/);
  });

  it('[R02] [R04] une exclusion active se dit sur l’alerte, levée elle ne se dit plus', async () => {
    const t = await setup();
    await t.alert(t.lea.id, t.alex.id);
    const closed = async () => {
      const r = await t.service.list(t.asAgent(t.alex.id));
      if (!r.ok) throw new Error(r.code);
      return r.value.alerts[0]!.contactClosed;
    };
    expect(await closed()).toBe(false);
    const ex = await t.store.addExclusion({ networkId: t.network.id, personId: t.lea.id, reason: 'stop', channel: null, notedAt: t.now() });
    expect(await closed()).toBe(true);
    await t.db.run('UPDATE exclusions SET lifted_at = ? WHERE id = ?', [t.now().toISOString(), ex.id]);
    expect(await closed()).toBe(false);
  });

  it('les plus anciennes d’abord, et le reste se dit', async () => {
    const t = await setup();
    const ids: string[] = [];
    for (let i = 0; i < MAX_AGENT_ALERTS + 2; i++) ids.push(await t.alert(t.lea.id, t.alex.id));
    const read = await t.service.list(t.asAgent(t.alex.id));
    if (!read.ok) throw new Error(read.code);
    expect(read.value.alerts.map((a) => a.id)).toEqual(ids.slice(0, MAX_AGENT_ALERTS));
    expect(read.value.more).toBe(true);
  });

  it('[R12] [R13] [R16] la direction compte les alertes qu’aucun agent ne voit, sans rien du client ; un agent n’a pas ce compte', async () => {
    const t = await setup();
    const direction: Viewer = { role: 'direction', networkId: t.network.id, userId: 'dir-1' };
    const count = async () => {
      const r = await t.service.unseenByAnyAgent(direction);
      if (!r.ok) throw new Error(r.code);
      return r.value;
    };
    // Vue par son agent : pas comptée.
    await t.alert(t.lea.id, t.alex.id);
    expect(await count()).toEqual({ total: 0, exchanges: 0, needsReply: 0, more: false });
    // Fiche sans agent.
    const free = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Noa', lastName: 'Exemple' });
    await t.alert(free.id, null, { reason: 'exchanges' });
    expect(await count()).toEqual({ total: 1, exchanges: 1, needsReply: 0, more: false });
    // Fiches de deux agents réunies : aucun des deux ne la voit.
    await t.alert(t.zoe.id, t.sam.id);
    await t.db.run("INSERT INTO person_merges (id, network_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES ('m-1', ?, ?, ?, 'test', ?, ?)", [t.network.id, t.lea.id, t.zoe.id, t.now().toISOString(), t.now().toISOString()]);
    expect((await count()).total).toBe(3);
    await t.db.run("UPDATE person_merges SET undone_at = ? WHERE id = 'm-1'", [t.now().toISOString()]);
    expect((await count()).total).toBe(1);
    // Attribuée : elle sort du compte, l'agent la voit.
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.alex.id, free.id]);
    expect((await count()).total).toBe(0);
    const read = await t.service.list(t.asAgent(t.alex.id));
    expect(read.ok && read.value.alerts.map((a) => a.personId)).toContain(free.id);
    // Une alerte vue n'est plus comptée : Sam en voit une, marque vue, puis part ; la seconde seule revient au compte.
    const zoeSeen = await t.alert(t.zoe.id, t.sam.id, { conversation: 'email:conv-vue' });
    await t.seen(t.sam.id, zoeSeen);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.sam.id]);
    expect((await count()).total).toBe(1);
    expect(await t.service.unseenByAnyAgent(t.asAgent(t.alex.id))).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(JSON.stringify(await t.lines())).not.toMatch(/Noa|Zoé|conv-/);
  });

  it('[R12] un stock d’alertes chez un agent actif ne cache pas une alerte sans agent', async () => {
    const t = await setup();
    for (let i = 0; i < 120; i++) await t.alert(t.lea.id, t.alex.id);
    const free = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Noa', lastName: 'Exemple' });
    await t.alert(free.id, null);
    const r = await t.service.unseenByAnyAgent({ role: 'direction', networkId: t.network.id, userId: 'dir-1' });
    expect(r).toMatchObject({ ok: true, value: { total: 1, needsReply: 1, more: false } });
  });

  it('[R12] au-delà de 100 fiches réunies examinées, le compte dit qu’il est un minimum', async () => {
    const t = await setup();
    const direction: Viewer = { role: 'direction', networkId: t.network.id, userId: 'dir-1' };
    const at = t.now().toISOString();
    const add = async (i: number) => {
      const a = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Noa', lastName: 'Exemple' });
      const b = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Noa', lastName: 'Exemple' });
      await t.db.run("INSERT INTO person_merges (id, network_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES (?, ?, ?, ?, 'test', ?, ?)", [`m-${i}`, t.network.id, a.id, b.id, at, at]);
      await t.alert(b.id, null);
    };
    for (let i = 0; i < 100; i++) await add(i);
    expect(await t.service.unseenByAnyAgent(direction)).toMatchObject({ ok: true, value: { total: 100, more: false } });
    await add(100);
    expect(await t.service.unseenByAnyAgent(direction)).toMatchObject({ ok: true, value: { total: 100, more: true } });
  });

  it('[R12] un écran resté sur une ancienne lecture ne referme pas une alerte rouverte', async () => {
    const t = await setup();
    const id = await t.alert(t.lea.id, t.alex.id);
    const read = await t.service.list(t.asAgent(t.alex.id));
    const old = read.ok ? read.value.alerts[0]!.createdAt : '';
    await t.db.run('UPDATE agent_alerts SET created_at = ?, seen_at = NULL WHERE id = ?', ['2027-01-01T00:00:00.000Z', id]);
    expect(await t.service.markSeen(t.asAgent(t.alex.id), id, old)).toEqual({ ok: true, value: { already: false, changed: true } });
    const after = await t.service.list(t.asAgent(t.alex.id));
    expect(after.ok && after.value.alerts.map((a) => a.id)).toEqual([id]);
    expect((await t.lines()).filter((l) => l.type === 'alerte_agent.vue')).toHaveLength(0);
  });

  it('[R16] [R12] fusion défaite : l’alerte revient à la fiche du message, chez son agent', async () => {
    const t = await setup();
    const free = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Noa', lastName: 'Exemple' });
    const merge = await t.fiche.merge({ survivorId: t.lea.id, mergedId: free.id, reason: 'même personne' });
    const { relais } = createCaptation(t.db, t.journal, { now: t.now, withOrigin: false });
    await relais['alert'](free.id, 'email:conv-b', 'needs_reply', t.now().toISOString());
    const merged = await t.service.list(t.asAgent(t.alex.id));
    expect(merged.ok && merged.value.alerts.map((a) => a.personId)).toEqual([t.lea.id]);
    await t.fiche.undoMerge(merge.id, { journal: t.journal, actor: 'test' });
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.id, free.id]);
    expect(await t.service.list(t.asAgent(t.alex.id))).toMatchObject({ ok: true, value: { alerts: [] } });
    const sam = await t.service.list(t.asAgent(t.sam.id));
    expect(sam.ok && sam.value.alerts.map((a) => [a.personId, a.firstName])).toEqual([[free.id, 'Noa']]);
  });

  it('[R12] une alerte vue se rouvre pour un message reçu après, pas pour le même message rejoué', async () => {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    let clock = TUESDAY_10H;
    const now = (): Date => new Date(clock);
    const journal = new SqlJournalStore(db);
    const { store, relais } = createCaptation(db, journal, { now, withOrigin: false });
    const network = await store.createNetwork('Réseau test');
    const agent = await store.createAgent({ networkId: network.id, firstName: 'Paul', lastName: 'Essai' });
    const person = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa', lastName: 'Exemple' });
    const service = new AlertesAgent(db, journal, { now });
    const viewer: Viewer = { role: 'agent', networkId: network.id, userId: agent.id };
    const raise = (receivedAt: Date) => relais['alert'](person.id, 'email:conv-1', 'needs_reply', receivedAt.toISOString());
    const alerts = async () => {
      const r = await service.list(viewer);
      if (!r.ok) throw new Error(r.code);
      return r.value.alerts;
    };
    const firstMessage = now();
    await raise(firstMessage);
    const [first] = await alerts();
    // Reposée sans être vue : rien ne change, ni la ligne ni sa date.
    clock += 60_000;
    await raise(now());
    expect(await alerts()).toEqual([first]);
    clock += 60_000;
    await service.markSeen(viewer, first!.id, first!.createdAt);
    expect(await alerts()).toEqual([]);
    // Le même message rejoué par le canal : l'alerte reste vue.
    clock += 60_000;
    await raise(firstMessage);
    expect(await alerts()).toEqual([]);
    // Une nouvelle réponse tombée : la même ligne, à la nouvelle date, de nouveau à reprendre.
    clock += 3_600_000;
    await raise(now());
    expect(await alerts()).toEqual([{ ...first, createdAt: now().toISOString() }]);
    expect((await db.all('SELECT id FROM agent_alerts')).length).toBe(1);
    // La date où elle avait été vue reste au journal [R17].
    expect((await db.all("SELECT 1 AS yes FROM journal WHERE type = 'alerte_agent.vue'")).length).toBe(1);
  });
});
