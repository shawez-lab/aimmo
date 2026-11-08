import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AgentPushTrialBox,
  ControleEnvois,
  DecisionEnvoi,
  FicheClient,
  FicheUnique,
  SqlJournalStore,
  SqlSendJournal,
  agentPushUrl,
  applyMigrations,
  fromSyncSqlite,
  type AgentPushOrder,
  type AgentPushOutcome,
  type SqlDatabase,
} from '../src/index.ts';
import { Notifications } from '../src/automatismes/notifications.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi d'octobre, 10 h à Paris. Réseau, agents et personnes inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');

describe('SV15 · une seule porte vers le service de notification', () => {
  it('[R225] aucun autre code que le contrôle central n’appelle le service de notification', () => {
    const src = fileURLToPath(new URL('../../', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = `${dir}/${name}`;
        if (name === 'node_modules' || name === 'test') continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:ts|js|mjs)$/.test(name)) files.push(path);
      }
    };
    walk(src);
    expect(files.some((f) => f.endsWith('/automatismes/notifications.ts'))).toBe(true);
    const callers = files.filter((f) => /\.pushToDevices\s*\(|\[\s*['"`]pushToDevices['"`]\s*\]/.test(readFileSync(f, 'utf8')));
    expect(callers.map((f) => f.slice(src.length).replace(/^\/+/, ''))).toEqual(['core/src/envoi/controle.ts']);
    // Aucune classe n'hérite de la boîte d'essai : elle seule est admise par le contrôle [R26].
    expect(files.filter((f) => /extends\s+AgentPushTrialBox\b/.test(readFileSync(f, 'utf8')))).toEqual([]);
    // Les notifications de HX27 ne parlent qu'au contrôle central.
    const notif = readFileSync(`${src}/core/src/automatismes/notifications.ts`, 'utf8');
    expect(notif).toMatch(/Pick<ControleEnvois, 'sendToAgent'>/);
    expect(notif).not.toMatch(/AgentPushTrialBox|pushToDevices/);
  });
});

async function setup(options: { box?: AgentPushTrialBox | null } = {}) {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  let clock = TUE_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const decisions = new DecisionEnvoi(db, store, fiche);
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const lea = await store.createAgent({ networkId: network.id, firstName: 'Léa', lastName: 'Agent' });
  const box = options.box === null ? undefined : (options.box ?? new AgentPushTrialBox(db, journal, now));
  const controle = new ControleEnvois(db, fiche, decisions, { channels: [], journal: new SqlSendJournal(db), now, ...(box ? { agentPush: box } : {}) });
  let n = 0;
  const order = (agentId: string = alex.id, pushId: string = `push-${++n}`, networkId: string = network.id): AgentPushOrder => ({
    networkId,
    agentId,
    payload: { pushId, urgency: 'haute', title: 'AIMMO', body: 'Une pièce reçue', url: agentPushUrl(pushId) },
  });
  const outbox = async () => (await db.all<{ push_id: string }>('SELECT push_id FROM agent_push_trial_outbox ORDER BY push_id')).map((r) => r.push_id);
  const log = (pushId: string) => db.all<{ outcome: string; rule: string | null; reason: string; mode: string }>('SELECT outcome, rule, reason, mode FROM agent_push_log WHERE push_id = ? ORDER BY id', [pushId]);
  return { raw, db, journal, store, network, other, alex, lea, box, controle, order, outbox, log, now, setClock: (t: number) => (clock = t) };
}

/** La boîte d'essai elle-même, avec la réponse imitée du service : elle compte ses appels, pour les tests. */
function countingBox(t: { db: SqlDatabase; journal: SqlJournalStore; now: () => Date }) {
  const state = { calls: 0, answer: 'ok' as AgentPushOutcome | 'panne' };
  const box = new AgentPushTrialBox(t.db, t.journal, t.now, async () => {
    state.calls++;
    await new Promise((r) => setTimeout(r, 5));
    if (state.answer === 'panne') throw new Error('service en panne');
    return state.answer;
  });
  return Object.assign(state, { box });
}

describeWithSqlite('SV15 · les notifications aux agents passent par le contrôle central', () => {
  it('[R225] [R26] en mode essai, l’envoi va à la boîte d’essai et rien ne part vers un téléphone', async () => {
    const t = await setup();
    const o = t.order();
    expect(await t.controle.sendToAgent(o)).toBe('ok');
    expect(await t.outbox()).toEqual([o.payload.pushId]);
    expect(await t.log(o.payload.pushId)).toEqual([{ outcome: 'ok', rule: null, reason: 'Rangé dans la boîte d’essai : rien n’est parti vers un téléphone.', mode: 'essai' }]);
    const event = await t.db.first<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type = 'envoi.essai.notification'");
    expect(JSON.parse(event?.data ?? '{}')).toEqual({ mode: 'essai', sent: false });
  });

  it('[R26] aucun autre service que la boîte d’essai n’est admis : sans elle, rien ne part', async () => {
    const t = await setup({ box: null });
    const o = t.order();
    // Refusé, l'envoi n'est pas dit fini : ses notifications restent à envoyer [R18].
    expect(await t.controle.sendToAgent(o)).toBe('echec');
    expect(await t.log(o.payload.pushId)).toMatchObject([{ outcome: 'refuse', rule: 'R26' }]);
    expect(await t.db.first('SELECT * FROM agent_push_sends')).toBeNull();
    // Un vrai service glissé à la place de la boîte d'essai n'est jamais appelé.
    let called = 0;
    const real = { pushToDevices: async () => (called++, 'ok' as const) };
    const fiche = new FicheUnique(t.db, t.store);
    const c = new ControleEnvois(t.db, fiche, new DecisionEnvoi(t.db, t.store, fiche), {
      channels: [],
      journal: new SqlSendJournal(t.db),
      agentPush: real as unknown as AgentPushTrialBox,
    });
    expect(await c.sendToAgent(t.order())).toBe('echec');
    expect(called).toBe(0);
    // Une classe qui hériterait de la boîte d'essai n'est pas la boîte d'essai : jamais appelée.
    class Heritiere extends AgentPushTrialBox {
      override async pushToDevices(): Promise<'ok'> {
        called++;
        return 'ok';
      }
    }
    const h = new ControleEnvois(t.db, fiche, new DecisionEnvoi(t.db, t.store, fiche), { channels: [], journal: new SqlSendJournal(t.db), agentPush: new Heritiere(t.db, t.journal) });
    expect(await h.sendToAgent(t.order())).toBe('echec');
    expect(called).toBe(0);
    expect(await t.db.first('SELECT * FROM agent_push_sends')).toBeNull();
  });

  it('[R225] [R18] HX27 avec un contrôle sans boîte d’essai : rien n’est dit parti ni sans appareil, tout reste à envoyer', async () => {
    const t = await setup({ box: null });
    const notifications = new Notifications(t.db, t.journal, t.controle, { now: t.now });
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Noa' });
    await notifications.notify({ agentId: t.alex.id, personId: p.id, kind: 'piece_recue', sourceKey: 'piece:1' });
    await notifications.flush();
    const rows = await t.db.all<{ status: string; sent_at: string | null }>('SELECT status, sent_at FROM agent_notifications');
    expect(rows).toEqual([{ status: 'a_envoyer', sent_at: null }]);
    expect(await t.db.all("SELECT id FROM agent_pushes WHERE status IN ('partie', 'aucun_appareil')")).toEqual([]);
  });

  it('[R225] [R05] un même envoi ne part jamais deux fois, rejoué ou demandé deux fois en même temps', async () => {
    const t0 = await setup();
    const counting = countingBox(t0);
    const fiche = new FicheUnique(t0.db, t0.store);
    const c = new ControleEnvois(t0.db, fiche, new DecisionEnvoi(t0.db, t0.store, fiche), { channels: [], journal: new SqlSendJournal(t0.db), now: t0.now, agentPush: counting.box });
    const o = t0.order();
    expect(await c.sendToAgent(o)).toBe('ok');
    // Rejoué : rien ne repart, la réponse du premier envoi est rendue.
    expect(await c.sendToAgent(o)).toBe('ok');
    expect(counting.calls).toBe(1);
    expect(await t0.log(o.payload.pushId)).toMatchObject([{ outcome: 'ok' }, { outcome: 'refuse', rule: 'R05' }]);
    // Deux demandes en même temps : une seule atteint le service, l'autre n'est pas dite partie.
    const p = t0.order();
    const both = await Promise.all([c.sendToAgent(p), c.sendToAgent(p)]);
    expect(counting.calls).toBe(2);
    expect(both.filter((r) => r === 'ok')).toHaveLength(1);
    expect(both).toContain('echec');
    // Le même identifiant pour un autre agent ne repart pas non plus, et n'est pas dit parti.
    expect(await c.sendToAgent(t0.order(t0.lea.id, o.payload.pushId))).toBe('echec');
    expect(counting.calls).toBe(2);
    expect(await t0.db.all('SELECT push_id FROM agent_push_sends')).toHaveLength(2);
  });

  it('[R225] un refus ou une panne du service est rangé une fois ; le même envoi ne repart pas, la réponse ne change plus', async () => {
    const t = await setup();
    const counting = countingBox(t);
    const fiche = new FicheUnique(t.db, t.store);
    const c = new ControleEnvois(t.db, fiche, new DecisionEnvoi(t.db, t.store, fiche), { channels: [], journal: new SqlSendJournal(t.db), now: t.now, agentPush: counting.box });
    counting.answer = 'panne';
    const o = t.order();
    expect(await c.sendToAgent(o)).toBe('echec');
    counting.answer = 'ok';
    expect(await c.sendToAgent(o)).toBe('echec');
    expect(counting.calls).toBe(1);
    counting.answer = 'aucun_appareil';
    const q = t.order();
    expect(await c.sendToAgent(q)).toBe('aucun_appareil');
    expect(await c.sendToAgent(q)).toBe('aucun_appareil');
    expect(counting.calls).toBe(2);
    expect(await t.outbox()).toEqual([]);
    // La réponse rangée ne se réécrit pas, et rien ne s'efface [R17].
    await expect(t.db.run("UPDATE agent_push_sends SET outcome = 'ok' WHERE push_id = ?", [o.payload.pushId])).rejects.toThrow(/une fois/);
    await expect(t.db.run('DELETE FROM agent_push_sends')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('DELETE FROM agent_push_log')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R225] [R86] rien pour un agent parti, ni pour un agent d’un autre réseau', async () => {
    const t = await setup();
    const gone = await t.store.createAgent({ networkId: t.network.id, firstName: 'Sam', lastName: 'Agent' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [gone.id]);
    const a = t.order(gone.id);
    expect(await t.controle.sendToAgent(a)).toBe('aucun_appareil');
    expect(await t.log(a.payload.pushId)).toMatchObject([{ outcome: 'refuse', rule: 'R86' }]);
    const b = t.order(t.alex.id, 'push-autre', t.other.id);
    expect(await t.controle.sendToAgent(b)).toBe('aucun_appareil');
    expect(await t.log(b.payload.pushId)).toMatchObject([{ outcome: 'refuse', rule: 'R86' }]);
    expect(await t.outbox()).toEqual([]);
  });

  it('[R225] [R415] [R13] le lien ne mène qu’au détail de l’envoi, et le journal ne garde ni texte ni donnée', async () => {
    const t = await setup();
    const o = t.order();
    expect(await t.controle.sendToAgent({ ...o, payload: { ...o.payload, url: 'https://exemple.test/fiche/noa' } })).toBe('echec');
    expect(await t.log(o.payload.pushId)).toMatchObject([{ outcome: 'refuse', rule: 'R415' }]);
    const p = t.order();
    await t.controle.sendToAgent(p);
    const everything = JSON.stringify([
      await t.db.all('SELECT * FROM agent_push_log'),
      await t.db.all('SELECT * FROM agent_push_sends'),
      await t.db.all('SELECT * FROM agent_push_trial_outbox'),
      await t.db.all("SELECT * FROM journal WHERE type = 'envoi.essai.notification'"),
    ]);
    expect(everything).not.toContain('Une pièce reçue');
    expect(everything).not.toContain('Alex');
    expect(everything).not.toContain('exemple.test');
  });

  it('[R225] [R26] HX27 branché sur le contrôle central : le contact chaud va à la boîte d’essai, une fois', async () => {
    const t = await setup();
    let n = 0;
    const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const notifications = new Notifications(t.db, t.journal, t.controle, { now: t.now, newId });
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Noa' });
    t.raw.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO callback_tasks (id, network_id, person_id, qualification_id, dedup_key, reason, due_at, created_at, done_at) VALUES ('cb-1', ?, ?, 'q', 'cb-1', 'r', ?, ?, NULL)", [
      t.network.id,
      p.id,
      new Date(TUE_10H + 3_600_000).toISOString(),
      new Date(TUE_10H).toISOString(),
    ]);
    t.raw.exec('PRAGMA foreign_keys = ON');
    const [r] = await notifications.hotContact('cb-1');
    expect(r).toMatchObject({ ok: true, value: { kind: 'contact_chaud', status: 'envoyee' } });
    const pushes = await t.db.all<{ id: string; status: string }>('SELECT id, status FROM agent_pushes');
    expect(pushes).toEqual([{ id: expect.any(String), status: 'partie' }]);
    expect(await t.outbox()).toEqual([pushes[0]?.id]);
    await notifications.hotContact('cb-1');
    await notifications.flush();
    expect(await t.outbox()).toHaveLength(1);
  });
});
