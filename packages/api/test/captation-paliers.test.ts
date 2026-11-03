import { expect, it } from 'vitest';
import { FicheClient, PaliersBascule, ROLLOUT_MIN_REQUESTS, SqlJournalStore, applyMigrations, captationAutomation, type SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clés inventées pour les tests, jamais utilisées ailleurs.
const KEY_DIRECTION = 'test-cle-canaux-direction-aaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_COMPLIANCE = 'test-cle-canaux-conformite-bbbbbbbbbbbbbbbbbbbbbbbbb';
const KEY_AGENT = 'test-cle-canaux-agent-ccccccccccccccccccccccccccccccc';
const KEY_PARTNER = 'test-cle-canaux-partenaire-dddddddddddddddddddddddddd';
const BASE = 'https://aimmo-api.example.workers.dev/v1/captation/paliers';
const DAY = 86_400_000;

interface Row {
  channel: string;
  connected: boolean;
  stage: string;
  since: string | null;
  requests: number;
  automation?: string;
  lastIncidentKind: string | null;
}

async function world(rollout?: { open: boolean; connected: readonly ('email' | 'whatsapp')[] }) {
  const db: SqlDatabase = fromD1(fakeD1(openMemoryDatabase()));
  await applyMigrations(db, loadMigrations());
  const fiches = new FicheClient(db);
  const network = await fiches.createNetwork('Réseau test');
  const agent = await fiches.createAgent({ networkId: network.id, firstName: 'Paul', lastName: 'Essai' });
  let clock = Date.parse('2026-11-03T09:00:00.000Z');
  const now = (): Date => new Date(clock);
  const config = {
    db,
    mode: 'essai',
    now,
    ...(rollout ? { captationRollout: rollout } : {}),
    apiKeys: JSON.stringify([
      { sha256: await sha256Hex(KEY_DIRECTION), role: 'direction', userId: 'direction-test', networkId: network.id },
      { sha256: await sha256Hex(KEY_COMPLIANCE), role: 'compliance', userId: 'conformite-test', networkId: network.id },
      { sha256: await sha256Hex(KEY_AGENT), role: 'agent', userId: agent.id, networkId: network.id },
      { sha256: await sha256Hex(KEY_PARTNER), role: 'partner', userId: 'partenaire-test', networkId: network.id },
    ]),
  };
  const http = async (path: string, key: string, method = 'GET') => {
    const res = await handleRequest(new Request(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${key}` } }), config);
    return { status: res.status, body: (await res.json()) as { ok: boolean; code?: string; rule?: string; data?: unknown } };
  };
  const journal = new SqlJournalStore(db);
  const paliers = new PaliersBascule(db, journal, { now });
  /** L'essai a tenu : 7 jours et assez de messages comptés sur ce canal. */
  const proven = async (channel: 'email' | 'whatsapp') => {
    const automation = captationAutomation(channel);
    const { stageSince } = await paliers.decide(network.id, automation, 'compte');
    for (let i = 0; i < ROLLOUT_MIN_REQUESTS; i++) await paliers.countRequest(network.id, automation, stageSince);
    clock += 7 * DAY;
  };
  const stage = async (channel: string) => (((await http('', KEY_DIRECTION)).body.data as Row[]).find((r) => r.channel === channel))!;
  const events = () => journal.all();
  return { db, network, http, paliers, proven, stage, events, forward: (days: number) => { clock += days * DAY; } };
}

describeWithSqlite('C09e · le palier de chaque canal, lu et avancé par la direction', () => {
  it('[R16] [R26] direction et conformité lisent chaque canal : des nombres et des dates, en essai, rien de branché par défaut', async () => {
    const t = await world();
    for (const key of [KEY_DIRECTION, KEY_COMPLIANCE]) {
      const r = await t.http('', key);
      expect(r.status).toBe(200);
      const rows = r.body.data as Row[];
      expect(rows.map((v) => v.channel)).toEqual(['email', 'phone', 'sms', 'instagram', 'facebook', 'whatsapp', 'site']);
      for (const v of rows) expect(v).toMatchObject({ connected: false, stage: 'shadow', since: null, requests: 0 });
      expect(rows[0]).not.toHaveProperty('automation');
    }
  });

  it.each([
    ['agent', KEY_AGENT],
    ['partner', KEY_PARTNER],
  ])('[R16] le rôle %s ne lit ni n’avance : refus au journal', async (role, key) => {
    const t = await world({ open: true, connected: ['email'] });
    expect((await t.http('', key)).status).toBe(403);
    expect((await t.http('/email/avancer', key, 'POST')).status).toBe(403);
    const refused = (await t.events()).filter((e) => e.type === 'acces.refuse');
    expect(refused.map((e) => e.data.kind)).toEqual(expect.arrayContaining(['bascule.paliers', 'bascule.avancer']));
    expect(refused.every((e) => e.data.role === role)).toBe(true);
    expect((await t.stage('email')).stage).toBe('shadow');
  });

  it('[R16] la conformité lit mais n’avance pas', async () => {
    const t = await world({ open: true, connected: ['email'] });
    await t.proven('email');
    expect((await t.http('/email/avancer', KEY_COMPLIANCE, 'POST')).status).toBe(403);
    expect((await t.stage('email')).stage).toBe('shadow');
  });

  it('[R26] sans réglage, le passage est fermé, même après un essai qui a tenu', async () => {
    const t = await world();
    await t.proven('email');
    const r = await t.http('/email/avancer', KEY_DIRECTION, 'POST');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ rule: 'R26', code: 'not_open' });
    expect((await t.stage('email')).stage).toBe('shadow');
  });

  it('[R26] fermé, un canal branché reste en essai', async () => {
    const t = await world({ open: false, connected: ['email'] });
    await t.proven('email');
    expect((await t.http('/email/avancer', KEY_DIRECTION, 'POST')).body).toMatchObject({ code: 'not_open' });
    expect((await t.stage('email'))).toMatchObject({ connected: true, stage: 'shadow' });
  });

  it('[R26] ouvert, un canal sans vrai branchement est refusé et reste en essai', async () => {
    const t = await world({ open: true, connected: ['email'] });
    await t.proven('whatsapp');
    const r = await t.http('/whatsapp/avancer', KEY_DIRECTION, 'POST');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ rule: 'R26', code: 'no_real_channel' });
    expect((await t.stage('whatsapp'))).toMatchObject({ connected: false, stage: 'shadow' });
  });

  it('[R26] ouvert et branché : refusé avant que l’essai ait tenu, puis à 10 %, ce canal seul', async () => {
    const t = await world({ open: true, connected: ['email', 'whatsapp'] });
    expect((await t.http('/email/avancer', KEY_DIRECTION, 'POST')).body).toMatchObject({ code: 'too_early' });
    t.forward(7);
    expect((await t.http('/email/avancer', KEY_DIRECTION, 'POST')).body).toMatchObject({ code: 'not_enough_requests' });
    await t.proven('email');
    const r = await t.http('/email/avancer', KEY_DIRECTION, 'POST');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ stage: 'ten_percent' });
    expect((await t.stage('email')).stage).toBe('ten_percent');
    expect((await t.stage('whatsapp')).stage).toBe('shadow');
    expect((await t.http('/email/avancer', KEY_DIRECTION, 'POST')).body).toMatchObject({ code: 'not_in_shadow' });
    // Le journal ne dit que le canal et les paliers [R13].
    const moved = (await t.events()).filter((e) => e.type === 'bascule.palier');
    expect(moved.map((e) => e.data)).toEqual([{ automation: 'captation_email', from: 'shadow', to: 'ten_percent' }]);
  });

  it('[R26] une panne du canal se lit : retour en essai, avec sa nature', async () => {
    const t = await world({ open: true, connected: ['email'] });
    await t.proven('email');
    await t.http('/email/avancer', KEY_DIRECTION, 'POST');
    await t.paliers.incident(t.network.id, captationAutomation('email'), 'failure', null, 'system:captation');
    expect(await t.stage('email')).toMatchObject({ stage: 'shadow', lastIncidentKind: 'failure', requests: 0 });
  });

  it('un canal inconnu : 404, sans palier créé', async () => {
    const t = await world({ open: true, connected: ['email'] });
    const r = await t.http('/pigeon/avancer', KEY_DIRECTION, 'POST');
    expect(r.status).toBe(404);
    expect(await t.db.all('SELECT automation FROM automation_rollouts')).toEqual([]);
    // Le nom interne d'un palier n'est pas un canal.
    expect((await t.http('/captation_email/avancer', KEY_DIRECTION, 'POST')).status).toBe(404);
  });

  it('[R26] les automatisations du site ne passent pas par cette route', async () => {
    const t = await world({ open: true, connected: ['email'] });
    expect((await t.http('/rappel_visite/avancer', KEY_DIRECTION, 'POST')).status).toBe(404);
  });
});

it('le nom du palier d’un canal reste celui de la chaîne', () => {
  expect(captationAutomation('email')).toBe('captation_email');
});
