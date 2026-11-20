import { expect, it } from 'vitest';
import { FakeChannel, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { Academie, BacASable, SANDBOX_GESTURES, SANDBOX_STEPS, type SandboxStorage, type SandboxWorld } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi à 11 h, heure de Paris. Réseau, agents et clients inventés.
let clock = Date.parse('2027-07-13T09:00:00.000Z');
const OUT_TABLES = ['send_log', 'trial_outbox', 'outbound_refs', 'send_reservations'];

class MemoryStorage implements SandboxStorage {
  readonly bases = new Map<string, SqlDatabase>();
  async open(agentId: string): Promise<SqlDatabase> {
    let db = this.bases.get(agentId);
    if (!db) {
      db = fromSyncSqlite(openMemoryDatabase());
      this.bases.set(agentId, db);
    }
    return db;
  }
}

async function setup() {
  clock = Date.parse('2027-07-13T09:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  const migrations = loadMigrations();
  await applyMigrations(db, migrations);
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const academie = new Academie(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const m = await academie.addModule(dir, { title: 'Premier parcours au bac à sable', track: 'entree', position: 1, videoId: 'bacasable01', durationMinutes: 60, mandatory: false });
  if (!m.ok) throw new Error('module');
  const storage = new MemoryStorage();
  const bac = new BacASable(db, journal, academie, { migrations, storage, academyModuleId: m.moduleId, now });
  const newcomer = (await store.createAgent({ networkId: network.id, firstName: 'Nina', lastName: 'Nouvelle' })).id;
  const veteran = (await store.createAgent({ networkId: network.id, firstName: 'Vic', lastName: 'Ancien' })).id;
  // Un vrai client du réseau, suivi par l'ancien : il ne doit jamais apparaître au bac à sable.
  const fiche = new FicheUnique(db, store, { now });
  const real = await store.createPerson({ networkId: network.id, agentId: veteran, firstName: 'Réel' });
  await fiche.addIdentifier({ networkId: network.id, agentId: veteran, personId: real.id, kind: 'email', value: 'vrai.client@reseau.example' });
  const as = (agentId: string) => ({ role: 'agent' as const, userId: agentId, networkId: network.id });
  return { db, journal, store, academie, network, dir, storage, bac, newcomer, veteran, real, as, moduleId: m.moduleId };
}

/** Le premier parcours complet, fait comme l'agent le ferait dans son application. */
async function parcours(world: SandboxWorld): Promise<void> {
  const contact = await world.inventedContact(0);
  expect(contact.status).toBe('replied');
  const hot = await world.captation.rappels.hotList(world.captation.acces, world.viewer);
  if (!hot.ok) throw new Error('liste');
  const task = hot.value.contacts.find((c) => c.personId === contact.personId)!;
  expect(await world.captation.rappels.done(world.captation.acces, world.viewer, task.taskId)).toBe(true);
  expect((await world.rendezVous.setAvailability(world.viewer, { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, from: '09:00', to: '18:00' })) })).ok).toBe(true);
  const booked = await world.rendezVous.book({ networkId: world.networkId, agentId: world.agentId, personId: contact.personId!, propertyId: world.propertyId, kind: 'estimation', start: new Date('2027-07-15T08:00:00.000Z'), source: 'agent', channel: 'email' });
  expect(booked.ok).toBe(true);
  const range = await world.fourchette.estimate({ kind: 'house', surface: 110, lat: 47.335, lon: 4.99, postalCode: '21240' });
  if (!range.ok) throw new Error(range.reason);
  const report = await world.avis.draft({ networkId: world.networkId, propertyId: world.propertyId, kind: 'house', surface: 110, range });
  const validated = await world.avis.validate(world.viewer, report.id);
  expect(validated.ok).toBe(true);
}

const outCount = async (db: SqlDatabase): Promise<number> => {
  let total = Number((await db.first<{ n: number }>("SELECT count(*) AS n FROM messages WHERE direction = 'out'"))?.n ?? 0);
  for (const t of OUT_TABLES) total += Number((await db.first<{ n: number }>(`SELECT count(*) AS n FROM ${t}`))?.n ?? 0);
  return total;
};

describeWithSqlite('bac à sable du premier parcours (Jamais vu)', () => {
  it('[R82] le parcours complet se fait de bout en bout, chaque étape cochée par le journal du bac à sable, et compte à l\'académie', async () => {
    const w = await setup();
    const opened = await w.bac.open(w.as(w.newcomer));
    if (!opened.ok) throw new Error(opened.code);
    const before = await w.bac.progress(w.as(w.newcomer), w.newcomer);
    expect(before.ok && before.value.steps.every((s) => !s.done)).toBe(true);
    expect(before.ok && before.value.next).toBe('Un vendeur vous écrit : votre assistant lui répond dans la minute.');
    await parcours(opened.world);
    const after = await w.bac.progress(w.as(w.newcomer), w.newcomer);
    if (!after.ok) throw new Error(after.code);
    expect(after.value.steps.map((s) => [s.step, s.done])).toEqual(SANDBOX_STEPS.map((s) => [s, true]));
    expect(after.value.completed).toBe(true);
    expect(after.value.countedAtAcademy).toBe(true);
    expect(after.value.next).toBeNull();
    expect(Number((await w.db.first<{ n: number }>('SELECT count(*) AS n FROM academy_completions WHERE agent_id = ? AND module_id = ?', [w.newcomer, w.moduleId]))?.n)).toBe(1);
    // Relu : rien de neuf, et le module ne compte qu'une fois.
    await w.bac.progress(w.dir, w.newcomer);
    expect(Number((await w.db.first<{ n: number }>('SELECT count(*) AS n FROM sandbox_steps'))?.n)).toBe(5);
    expect((await w.journal.all()).filter((e) => e.type === 'bac_a_sable.fini')).toHaveLength(1);
  });

  it('[R01] [R02] [R03] [R04] [R82] aucun envoi ne sort du bac à sable, même quand le réseau est mis en service', async () => {
    const w = await setup();
    // Le réseau réel, mis en service avec ses vrais canaux.
    const live = ['email', 'sms', 'whatsapp', 'phone', 'instagram', 'facebook', 'site'].map((c) => new FakeChannel(c as never));
    createCaptation(w.db, w.journal, { now: () => new Date(clock), channels: live });
    const opened = await w.bac.open(w.as(w.newcomer));
    if (!opened.ok) throw new Error(opened.code);
    await parcours(opened.world);
    await opened.world.inventedContact(1);
    for (const channel of live) expect(channel.sent).toEqual([]);
    // Tout ce qui « part » reste dans la boîte d'essai de la base du bac à sable.
    expect(Number((await opened.world.db.first<{ n: number }>('SELECT count(*) AS n FROM trial_outbox'))?.n)).toBeGreaterThan(0);
    expect(await outCount(w.db)).toBe(0);
    // Le constructeur ne prend aucun canal : il n'y a pas de porte pour en passer un.
    expect(Object.keys((w.bac as unknown as { options: object }).options).sort()).toEqual(['academyModuleId', 'migrations', 'now', 'storage']);
  });

  it('[R82] le bac à sable vit dans sa propre base, sans aucune donnée réelle, et l\'agent n\'y voit aucun client réel', async () => {
    const w = await setup();
    const opened = await w.bac.open(w.as(w.newcomer));
    if (!opened.ok) throw new Error(opened.code);
    await parcours(opened.world);
    const sandbox = opened.world.db;
    expect(sandbox).not.toBe(w.db);
    const dump = JSON.stringify(await sandbox.all("SELECT name FROM sqlite_master WHERE type = 'table'"));
    expect(dump).toContain('persons');
    const persons = await sandbox.all<{ network_id: string }>('SELECT network_id FROM persons');
    expect(persons.length).toBeGreaterThan(0);
    expect(new Set(persons.map((p) => p.network_id))).toEqual(new Set([opened.world.networkId]));
    expect(opened.world.networkId).not.toBe(w.network.id);
    // Le vrai client et le vrai réseau n'y sont pas ; l'agent ne le retrouve pas depuis son bac à sable.
    expect(await opened.world.captation.fiche.findByIdentifier(opened.world.networkId, 'email', 'vrai.client@reseau.example')).toEqual([]);
    expect(await sandbox.first('SELECT id FROM persons WHERE id = ?', [w.real.id])).toBeNull();
    expect(await sandbox.first('SELECT id FROM networks WHERE id = ?', [w.network.id])).toBeNull();
    const names = JSON.stringify(await sandbox.all('SELECT first_name, last_name FROM agents'));
    expect(names).not.toMatch(/Nina|Nouvelle|Vic/);
    // Et rien du bac à sable n'entre dans la base du réseau.
    expect(await w.db.first("SELECT id FROM person_identifiers WHERE value LIKE '%essai.example'")).toBeNull();
    expect(Number((await w.db.first<{ n: number }>('SELECT count(*) AS n FROM persons'))?.n)).toBe(1);
  });

  it('[R82] les étapes ne se saisissent pas : seuls les événements du bac à sable, dans l\'ordre, les cochent', async () => {
    const w = await setup();
    const opened = await w.bac.open(w.as(w.newcomer));
    if (!opened.ok) throw new Error(opened.code);
    // Un événement du réseau réel ne coche rien au bac à sable.
    await w.journal.all();
    const { appendEvent } = await import('../src/index.ts');
    await appendEvent(w.journal, { type: 'avis.valide', actor: `agent:${w.newcomer}`, subject: null, data: {} }, () => new Date(clock));
    // L'avis validé avant le contact ne compte pas : l'ordre compte.
    await appendEvent(new SqlJournalStore(opened.world.db), { type: 'avis.valide', actor: `agent:${w.newcomer}`, subject: null, data: {} }, () => new Date(clock));
    await opened.world.inventedContact(0);
    const p = await w.bac.progress(w.as(w.newcomer), w.newcomer);
    if (!p.ok) throw new Error(p.code);
    expect(p.value.steps.filter((s) => s.done).map((s) => s.step)).toEqual(['contact_recu', 'qualification']);
    expect(p.value.next).toBe('Vous le rappelez et marquez la tâche faite.');
    // Un journal du bac à sable trafiqué : rien n'est lu, et la direction le sait.
    await opened.world.db.exec("DROP TRIGGER IF EXISTS journal_append_only_update; DROP TRIGGER IF EXISTS journal_sans_modification");
    const triggers = await opened.world.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'journal'");
    for (const t of triggers) await opened.world.db.exec(`DROP TRIGGER "${t.name}"`);
    await opened.world.db.run("UPDATE journal SET type = 'rappel.fait' WHERE seq = 1");
    expect(await w.bac.progress(w.dir, w.newcomer)).toEqual({ ok: false, rule: null, code: 'broken_journal' });
  });

  it('[R82] des événements écrits à la main, sans le geste rangé, ne cochent rien', async () => {
    const w = await setup();
    const opened = await w.bac.open(w.as(w.newcomer));
    if (!opened.ok) throw new Error(opened.code);
    const { appendEvent } = await import('../src/index.ts');
    const forge = new SqlJournalStore(opened.world.db);
    const t = () => new Date(clock);
    await appendEvent(forge, { type: 'bac_a_sable.contact_recu', actor: 'system:bac_a_sable', subject: 'person:inventee', data: {} }, t);
    await appendEvent(forge, { type: 'qualification.rangee', actor: 'system:qualification', subject: 'person:inventee', data: {} }, t);
    await appendEvent(forge, { type: 'rappel.fait', actor: `agent:${w.newcomer}`, subject: 'person:inventee', data: { task: 'x' } }, t);
    await appendEvent(forge, { type: 'rdv.reserve', actor: 'agent', subject: 'appointment:x', data: { kind: 'estimation', agent: w.newcomer } }, t);
    await appendEvent(forge, { type: 'avis.valide', actor: `agent:${w.newcomer}`, subject: 'property:x', data: { report: 'x' } }, t);
    const p = await w.bac.progress(w.as(w.newcomer), w.newcomer);
    expect(p.ok && p.value.steps.filter((s) => s.done)).toEqual([]);
    // Un vrai contact reçu, puis des gestes forgés : seuls contact et qualification comptent.
    const contact = await opened.world.inventedContact(0);
    await appendEvent(forge, { type: 'rappel.fait', actor: `agent:${w.newcomer}`, subject: `person:${contact.personId}`, data: { task: 'x' } }, t);
    await appendEvent(forge, { type: 'rdv.reserve', actor: 'agent', subject: 'appointment:x', data: { kind: 'estimation', agent: w.newcomer } }, t);
    const q = await w.bac.progress(w.as(w.newcomer), w.newcomer);
    expect(q.ok && q.value.steps.filter((s) => s.done).map((s) => s.step)).toEqual(['contact_recu', 'qualification']);
    expect(Number((await w.db.first<{ n: number }>('SELECT count(*) AS n FROM academy_completions'))?.n)).toBe(0);
  });

  it('un parcours fini que l\'académie refuse est tracé, puis compté dès que le module existe', async () => {
    const w = await setup();
    let moduleId = 'module-absent';
    const bac = new BacASable(w.db, w.journal, w.academie, {
      migrations: loadMigrations(),
      storage: w.storage,
      get academyModuleId() {
        return moduleId;
      },
      now: () => new Date(clock),
    });
    const opened = await bac.open(w.as(w.newcomer));
    if (!opened.ok) throw new Error(opened.code);
    await parcours(opened.world);
    const first = await bac.progress(w.as(w.newcomer), w.newcomer);
    expect(first.ok && [first.value.completed, first.value.countedAtAcademy]).toEqual([true, false]);
    expect((await w.journal.all()).filter((e) => e.type === 'bac_a_sable.academie_refusee').map((e) => e.data.code)).toEqual(['unknown_module']);
    moduleId = w.moduleId;
    const again = await bac.progress(w.dir, w.newcomer);
    expect(again.ok && again.value.countedAtAcademy).toBe(true);
    expect(Number((await w.db.first<{ n: number }>('SELECT count(*) AS n FROM academy_completions WHERE module_id = ?', [w.moduleId]))?.n)).toBe(1);
    expect((await w.journal.all()).filter((e) => e.type === 'bac_a_sable.fini')).toHaveLength(1);
  });

  it('[R16] seul l\'agent ouvre son bac à sable ; lui et la direction lisent sa progression ; refus au journal', async () => {
    const w = await setup();
    expect(await w.bac.open(w.dir)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.bac.progress(w.as(w.veteran), w.newcomer)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await w.bac.progress({ role: 'compliance', userId: 'c', networkId: w.network.id }, w.newcomer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.bac.progress(w.dir, w.newcomer)).toEqual({ ok: false, rule: null, code: 'not_opened' });
    await w.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [w.veteran]);
    expect(await w.bac.open(w.as(w.veteran))).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect((await w.journal.all()).filter((e) => e.type === 'acces.refuse')).toHaveLength(4);
    // Ouvert deux fois : le même bac à sable, peuplé une seule fois.
    const a = await w.bac.open(w.as(w.newcomer));
    const b = await w.bac.open(w.as(w.newcomer));
    if (!a.ok || !b.ok) throw new Error('ouverture');
    expect(b.world.db).toBe(a.world.db);
    expect(Number((await a.world.db.first<{ n: number }>('SELECT count(*) AS n FROM properties'))?.n)).toBe(1);
    expect(Number((await a.world.db.first<{ n: number }>('SELECT count(*) AS n FROM agent_zones'))?.n)).toBe(1);
  });

  it('une base de bac à sable qui serait celle du réseau est refusée', async () => {
    const w = await setup();
    const bad = new BacASable(w.db, w.journal, w.academie, { migrations: loadMigrations(), storage: { open: async () => w.db }, now: () => new Date(clock) });
    await expect(bad.open(w.as(w.newcomer))).rejects.toThrow(/autre base/);
  });

  it('[R82] [R16] AU025 : l\'agent fait les cinq étapes depuis son écran, une à une, dans l\'ordre, et sa progression reste', async () => {
    const w = await setup();
    const me = w.as(w.newcomer);
    // Pas encore ouvert : aucun geste.
    expect(await w.bac.act(me, 'contact_recu')).toEqual({ ok: false, rule: null, code: 'not_opened' });
    expect((await w.bac.open(me)).ok).toBe(true);
    // Hors de l'ordre, une étape inconnue, la qualification (faite par la chaîne), un autre rôle : refusés.
    expect(await w.bac.act(me, 'rendez_vous')).toEqual({ ok: false, rule: null, code: 'not_next_step' });
    expect(await w.bac.act(me, 'qualification')).toEqual({ ok: false, rule: null, code: 'invalid_step' });
    expect(await w.bac.act(w.dir, 'contact_recu')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const seen: string[][] = [];
    for (const gesture of SANDBOX_GESTURES) {
      const r = await w.bac.act(me, gesture);
      if (!r.ok) throw new Error(`${gesture} : ${r.code}`);
      seen.push(r.value.steps.filter((s) => s.done).map((s) => s.step));
    }
    expect(seen).toEqual([
      ['contact_recu', 'qualification'],
      ['contact_recu', 'qualification', 'rappel_fait'],
      ['contact_recu', 'qualification', 'rappel_fait', 'rendez_vous'],
      [...SANDBOX_STEPS],
    ]);
    expect(await w.bac.act(me, 'avis_valide')).toEqual({ ok: false, rule: null, code: 'completed' });
    // Progression persistante : un autre service, plus tard, sur le même stockage, relit le parcours fini.
    clock += 86_400_000;
    const again = new BacASable(w.db, w.journal, w.academie, { migrations: loadMigrations(), storage: w.storage, academyModuleId: w.moduleId, now: () => new Date(clock) });
    const read = await again.progress(me, w.newcomer);
    expect(read.ok && read.value.completed && read.value.countedAtAcademy).toBe(true);
    expect(read.ok && read.value.next).toBeNull();
    // L'autre agent n'a rien : son bac à sable n'est pas celui de la nouvelle.
    expect(await again.progress(w.as(w.veteran), w.veteran)).toEqual({ ok: false, rule: null, code: 'not_opened' });
    expect(w.storage.bases.size).toBe(1);
  });
});
