import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { Notifications, type AgentPushGate } from '../../core/src/automatismes/notifications.ts';
import { MAX_NOTIFICATIONS_BODY_BYTES, NOTIFICATIONS_REFUSALS, notificationsRoutes, type NotificationsServices } from '../src/notifications.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// BR66 : les réglages et la liste des notifications, par les routes. Un mardi d'octobre, 10 h à Paris.
// Réseau, agents, personnes et coordonnées inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');

async function setup() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(TUE_10H);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const a = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const b = await store.createAgent({ networkId: network.id, firstName: 'Léa', lastName: 'Agent' });
  const alex: Viewer = { role: 'agent', userId: a.id, networkId: network.id };
  const lea: Viewer = { role: 'agent', userId: b.id, networkId: network.id };
  const direction: Viewer = { role: 'direction', userId: 'dir-1', networkId: network.id };
  const noa = await store.createPerson({ networkId: network.id, agentId: a.id, firstName: 'Noa' });
  await store.addIdentifier({ networkId: network.id, personId: noa.id, kind: 'email', value: 'noa@example.test' });
  const sacha = await store.createPerson({ networkId: network.id, agentId: b.id, firstName: 'Sacha' });
  await store.addIdentifier({ networkId: network.id, personId: sacha.id, kind: 'email', value: 'sacha@example.test' });
  const sent: string[] = [];
  const gate: AgentPushGate = { sendToAgent: async ({ payload }) => (sent.push(payload.pushId), 'ok') };
  const notifications = new Notifications(db, journal, gate, { now });
  const s: NotificationsServices = { db, journal, now };
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown, raw?: string) => {
    const bare = path.split('?')[0]!;
    const route = notificationsRoutes().find((r) => r.method === method && r.pattern.test(bare));
    if (!route) throw new Error(`route absente : ${method} ${bare}`);
    const params = route.pattern.exec(bare)!.slice(1);
    const text = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const request = new Request(`https://api.example.test/v1${path}`, {
      method,
      ...(text !== undefined ? { body: text, headers: { 'content-type': 'application/json' } } : {}),
    });
    const response = await route.handle(s, viewer, params, request);
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const refusals = async () => (await journal.all()).filter((e) => e.type === 'acces.refuse' && e.data['kind'] === 'notifications');
  return { db, journal, store, network, alex, lea, direction, noa, sacha, notifications, sent, call, refusals, agentA: a };
}

describeWithSqlite('BR66 · les réglages et la liste des notifications, par les routes', () => {
  it('[R16] seul l’agent en activité, pour lui seul : la direction et un agent parti refusés, au journal, en mots', async () => {
    const t = await setup();
    for (const [method, path] of [
      ['GET', '/notifications/reglages'],
      ['POST', '/notifications/reglages'],
      ['GET', '/notifications'],
      ['GET', '/notifications/envois/abc'],
    ] as const) {
      const r = await t.call(t.direction, method, path, method === 'POST' ? { quietStart: 0, quietEnd: 0 } : undefined);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role', message: NOTIFICATIONS_REFUSALS['role'] });
    }
    expect(await t.refusals()).toHaveLength(4);
    // La direction n'a rien rangé.
    expect(await t.db.first<{ n: number }>('SELECT count(*) AS n FROM agent_notification_settings')).toEqual({ n: 0 });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.agentA.id]);
    const gone = await t.call(t.alex, 'GET', '/notifications/reglages');
    expect(gone.status).toBe(403);
    expect(gone.body).toMatchObject({ rule: 'R16', code: 'not_self', message: NOTIFICATIONS_REFUSALS['not_self'] });
    // Un agent d'un autre réseau n'est pas en activité dans celui-ci.
    const elsewhere = await t.call({ ...t.lea, networkId: 'autre-reseau' }, 'GET', '/notifications');
    expect(elsewhere.body).toMatchObject({ code: 'not_self' });
  });

  it('[R412] [R413] réglages rangés puis relus ; contact chaud non réglable, minute hors du jour refusée, en mots', async () => {
    const t = await setup();
    const first = await t.call(t.alex, 'GET', '/notifications/reglages');
    expect(first).toMatchObject({ status: 200, body: { ok: true, data: { quietStart: 1260, quietEnd: 480, levels: { client_ecrit: 'haute', info: 'basse' } } } });
    expect(first.body.data.levels).not.toHaveProperty('contact_chaud');
    const set = await t.call(t.alex, 'POST', '/notifications/reglages', { quietStart: 1320, quietEnd: 420, levels: { info: 'coupee', tache: 'haute' } });
    expect(set).toMatchObject({ status: 200, body: { ok: true, data: { quietStart: 1320, quietEnd: 420, levels: { info: 'coupee', tache: 'haute', client_ecrit: 'haute' } } } });
    expect((await t.call(t.alex, 'GET', '/notifications/reglages')).body.data).toEqual(set.body.data);
    // Léa garde les siens : un agent ne règle que pour lui.
    expect((await t.call(t.lea, 'GET', '/notifications/reglages')).body.data.quietStart).toBe(1260);
    const hot = await t.call(t.alex, 'POST', '/notifications/reglages', { quietStart: 0, quietEnd: 0, levels: { contact_chaud: 'coupee' } });
    expect(hot).toMatchObject({ status: 400, body: { rule: 'R412', code: 'hot_fixed', message: NOTIFICATIONS_REFUSALS['hot_fixed'] } });
    for (const bad of [1440, -1, 12.5, '600', null]) {
      const r = await t.call(t.alex, 'POST', '/notifications/reglages', { quietStart: bad, quietEnd: 480 });
      expect(r).toMatchObject({ status: 400, body: { rule: 'R413', code: 'invalid_quiet', message: NOTIFICATIONS_REFUSALS['invalid_quiet'] } });
    }
    for (const levels of [{ info: 'urgente' }, { inconnue: 'haute' }, ['haute'], 'haute', null]) {
      const r = await t.call(t.alex, 'POST', '/notifications/reglages', { quietStart: 0, quietEnd: 0, levels });
      expect(r).toMatchObject({ status: 400, body: { code: 'invalid_level', message: NOTIFICATIONS_REFUSALS['invalid_level'] } });
    }
    // Rien de rangé par un refus.
    expect(await t.db.first<{ n: number }>('SELECT count(*) AS n FROM agent_notification_settings')).toEqual({ n: 1 });
  });

  it('champ inattendu, corps illisible ou trop gros, paramètre de lecture : refusés en mots', async () => {
    const t = await setup();
    expect(await t.call(t.alex, 'POST', '/notifications/reglages', { quietStart: 0, quietEnd: 0, agentId: 'autre' })).toMatchObject({ status: 400, body: { code: 'unexpected_field' } });
    expect(await t.call(t.alex, 'POST', '/notifications/reglages', undefined, 'pas du json')).toMatchObject({ status: 400, body: { code: 'invalid_body', message: NOTIFICATIONS_REFUSALS['invalid_body'] } });
    expect(await t.call(t.alex, 'POST', '/notifications/reglages', undefined, '[1, 2]')).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    const big = JSON.stringify({ quietStart: 0, quietEnd: 0, levels: { info: 'x'.repeat(MAX_NOTIFICATIONS_BODY_BYTES) } });
    expect(await t.call(t.alex, 'POST', '/notifications/reglages', undefined, big)).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.call(t.alex, 'GET', '/notifications?agent=autre')).toMatchObject({ status: 400, body: { code: 'unexpected_field' } });
    expect(await t.call(t.alex, 'GET', '/notifications/reglages?x=1')).toMatchObject({ status: 400, body: { code: 'unexpected_field' } });
  });

  it('[R16] la liste ne rend que ses notifications, sur les fiches qu’il voit en entier, sans clé interne', async () => {
    const t = await setup();
    await t.notifications.notify({ agentId: t.alex.userId, personId: t.noa.id, kind: 'client_ecrit', sourceKey: 'message:m1' });
    await t.notifications.notify({ agentId: t.lea.userId, personId: t.sacha.id, kind: 'client_ecrit', sourceKey: 'message:m2' });
    const r = await t.call(t.alex, 'GET', '/notifications');
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ personId: t.noa.id, kind: 'client_ecrit', urgency: 'haute', status: 'a_envoyer', pushId: null, sentAt: null });
    expect(Object.keys(r.body.data[0]).sort()).toEqual(['createdAt', 'id', 'kind', 'personId', 'pushId', 'sentAt', 'status', 'urgency']);
    expect(JSON.stringify(r.body)).not.toContain('message:m1');
    // La fiche passe à Léa : Alex ne la voit plus, sa notification non plus.
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.lea.userId, t.noa.id]);
    expect((await t.call(t.alex, 'GET', '/notifications')).body.data).toHaveLength(0);
  });

  it('[R415] le détail d’un envoi ne rend que ses notifications, pour cet agent ; celui d’un autre agent est inconnu', async () => {
    const t = await setup();
    const hot = await t.notifications.notify({ agentId: t.alex.userId, personId: t.noa.id, kind: 'contact_chaud', sourceKey: 'callback:cb-1' });
    expect(hot.ok).toBe(true);
    expect(t.sent).toHaveLength(1);
    const pushId = t.sent[0]!;
    const mine = await t.call(t.alex, 'GET', `/notifications/envois/${pushId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toMatchObject([{ personId: t.noa.id, kind: 'contact_chaud', urgency: 'immediate', pushId }]);
    const other = await t.call(t.lea, 'GET', `/notifications/envois/${pushId}`);
    expect(other).toMatchObject({ status: 404, body: { ok: false, code: 'unknown', message: NOTIFICATIONS_REFUSALS['unknown'] } });
    expect(await t.call(t.alex, 'GET', '/notifications/envois/inconnu')).toMatchObject({ status: 404, body: { code: 'unknown' } });
  });

  it('[R13] aucune route n’envoie rien ; le journal ne garde ni prénom ni coordonnée', async () => {
    const t = await setup();
    await t.call(t.alex, 'POST', '/notifications/reglages', { quietStart: 1320, quietEnd: 420 });
    await t.call(t.alex, 'GET', '/notifications');
    await t.call(t.direction, 'GET', '/notifications');
    expect(t.sent).toHaveLength(0);
    expect(await t.db.first<{ n: number }>('SELECT count(*) AS n FROM agent_push_trial_outbox')).toEqual({ n: 0 });
    const text = JSON.stringify(await t.journal.all());
    expect(text).not.toMatch(/Noa|Sacha|example\.test/);
  });

  it('docs/API.md décrit les routes', () => {
    const doc = readFileSync(new URL('../../../docs/API.md', import.meta.url), 'utf8');
    for (const path of ['`/v1/notifications/reglages`', '`/v1/notifications`', '`/v1/notifications/envois/<id>`']) expect(doc).toContain(path);
    expect(notificationsRoutes().map((r) => r.name)).toEqual(['notifications.reglages.lire', 'notifications.reglages.ranger', 'notifications.lire', 'notifications.envoi.lire']);
  });
});
