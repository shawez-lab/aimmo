import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FicheClient,
  FicheUnique,
  DecisionEnvoi,
  SqlJournalStore,
  applyMigrations,
  verifyChain,
  type JournalEntry,
  type SqlDatabase,
} from '@aimmo/core';
import { handleRequest, sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import { parseApiKeys } from '../src/auth.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clés inventées pour les tests, jamais utilisées ailleurs.
const KEY_AGENT = 'test-cle-agent-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_OTHER_AGENT = 'test-cle-autre-agent-bbbbbbbbbbbbbbbbbbbbbbb';
const KEY_DIRECTION = 'test-cle-direction-cccccccccccccccccccccccccc';
const KEY_PARTNER = 'test-cle-partenaire-dddddddddddddddddddddddddd';

const BASE = 'https://aimmo-api.example.workers.dev';
// Un lundi d'octobre à 10 h, heure de Paris.
const MONDAY_10H = new Date('2026-10-19T08:00:00.000Z');
// Un dimanche à 22 h, heure de Paris.
const SUNDAY_22H = new Date('2026-10-25T21:00:00.000Z');

interface World {
  env: Env;
  db: SqlDatabase;
  journal: SqlJournalStore;
  fiches: FicheClient;
  net: string;
  agentId: string;
  otherAgentId: string;
  mine: string;
  others: string;
  stopped: string;
  propertyOther: string;
  propertyDraft: string;
}

async function keysFor(entries: { key: string; role: string; userId: string; networkId: string }[]): Promise<string> {
  return JSON.stringify(
    await Promise.all(entries.map(async ({ key, ...rest }) => ({ sha256: await sha256Hex(key), ...rest }))),
  );
}

async function world(): Promise<World> {
  const d1 = fakeD1(openMemoryDatabase());
  const db = fromD1(d1);
  await applyMigrations(db, loadMigrations());
  const fiches = new FicheClient(db, { now: () => MONDAY_10H });
  const unique = new FicheUnique(db, fiches, { now: () => MONDAY_10H });
  const envoi = new DecisionEnvoi(db, fiches, unique, { now: () => MONDAY_10H });
  const network = await fiches.createNetwork('Réseau test');
  const agent = await fiches.createAgent({ networkId: network.id, firstName: 'Agent', lastName: 'Un' });
  const other = await fiches.createAgent({ networkId: network.id, firstName: 'Agent', lastName: 'Deux' });
  const mine = await fiches.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Camille' });
  const others = await fiches.createPerson({ networkId: network.id, agentId: other.id, firstName: 'Dominique' });
  const stopped = await fiches.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Lou' });
  await envoi.recordReceived({
    networkId: network.id,
    agentId: agent.id,
    personId: stopped.id,
    channel: 'email',
    conversationId: 'conv-stop',
    body: 'Stop, merci',
    occurredAt: new Date('2026-10-18T08:00:00.000Z'),
  });
  const propertyOther = await fiches.createProperty({
    networkId: network.id,
    agentId: other.id,
    reference: 'REF-TEST-1',
    kind: 'home',
    status: 'available',
  });
  const propertyDraft = await fiches.createProperty({
    networkId: network.id,
    agentId: other.id,
    reference: 'REF-TEST-2',
    kind: 'home',
    status: 'draft',
  });
  const env: Env = {
    DB: d1,
    MODE: 'essai',
    API_KEYS: await keysFor([
      { key: KEY_AGENT, role: 'agent', userId: agent.id, networkId: network.id },
      { key: KEY_OTHER_AGENT, role: 'agent', userId: other.id, networkId: network.id },
      { key: KEY_DIRECTION, role: 'direction', userId: 'direction-1', networkId: network.id },
      { key: KEY_PARTNER, role: 'partner', userId: 'partenaire-1', networkId: network.id },
    ]),
  };
  return {
    env,
    db,
    journal: new SqlJournalStore(db),
    fiches,
    net: network.id,
    agentId: agent.id,
    otherAgentId: other.id,
    mine: mine.id,
    others: others.id,
    stopped: stopped.id,
    propertyOther: propertyOther.id,
    propertyDraft: propertyDraft.id,
  };
}

function call(env: Env, path: string, init: { key?: string; method?: string; body?: unknown } = {}): Promise<Response> {
  const headers = new Headers();
  if (init.key !== undefined) headers.set('authorization', `Bearer ${init.key}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const request = new Request(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return worker.fetch(request, env);
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const lines = (w: World): Promise<JournalEntry[]> => w.journal.all();

describe('clés d\'accès', () => {
  it('une configuration absente, vide ou mal formée ferme l\'API', () => {
    expect(parseApiKeys(undefined)).toBeNull();
    expect(parseApiKeys('')).toBeNull();
    expect(parseApiKeys('[]')).toBeNull();
    expect(parseApiKeys('pas du json')).toBeNull();
    expect(parseApiKeys(JSON.stringify([{ sha256: 'court', role: 'agent', userId: 'a', networkId: 'n' }]))).toBeNull();
    expect(parseApiKeys(JSON.stringify([{ sha256: 'a'.repeat(64), role: 'admin', userId: 'a', networkId: 'n' }]))).toBeNull();
    const twice = { sha256: 'a'.repeat(64), role: 'agent', userId: 'a', networkId: 'n' };
    expect(parseApiKeys(JSON.stringify([twice, twice]))).toBeNull();
    expect(parseApiKeys(JSON.stringify([twice]))).toEqual([twice]);
  });
});

describeWithSqlite('API du socle de bout en bout, sur une base D1 locale', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it('la santé répond sans clé et sans rien lire', async () => {
    const response = await call(w.env, '/v1/sante');
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ ok: true, mode: 'essai' });
    expect(await lines(w)).toHaveLength(0);
  });

  it('sans clé, avec une clé fausse ou trop courte : refusé, rien n\'est lu', async () => {
    for (const key of [undefined, 'test-cle-inconnue-eeeeeeeeeeeeeeeeeeeeeeeeeee', 'court']) {
      const response = await call(w.env, `/v1/fiches/${w.mine}`, key === undefined ? {} : { key });
      expect(response.status).toBe(401);
      expect(JSON.stringify(await body(response))).not.toContain('Camille');
    }
    expect(await lines(w)).toHaveLength(0);
  });

  it('sans clés configurées, l\'API est fermée', async () => {
    const { API_KEYS: _unused, ...withoutKeys } = w.env;
    const response = await call(withoutKeys, `/v1/fiches/${w.mine}`, { key: KEY_AGENT });
    expect(response.status).toBe(503);
  });

  it('hors mode essai, l\'API est fermée, même avec une bonne clé', async () => {
    for (const MODE of [undefined, 'reel', 'ESSAI']) {
      const env: Env = { ...w.env };
      if (MODE === undefined) delete env.MODE;
      else env.MODE = MODE;
      expect((await call(env, `/v1/fiches/${w.mine}`, { key: KEY_AGENT })).status).toBe(503);
      expect((await call(env, '/v1/sante')).status).toBe(503);
    }
    expect(await lines(w)).toHaveLength(0);
  });

  it('[R16] un agent lit sa fiche, et la lecture est au journal', async () => {
    const response = await call(w.env, `/v1/fiches/${w.mine}`, { key: KEY_AGENT });
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result).toMatchObject({ ok: true, view: 'full' });
    expect((result['data'] as { person: { id: string } }).person.id).toBe(w.mine);
    const journal = await lines(w);
    expect(journal.map((entry) => entry.type)).toEqual(['fiche.lue']);
    expect(journal[0]).toMatchObject({ actor: `agent:${w.agentId}`, subject: `person:${w.mine}` });
  });

  it('[R16] un agent ne lit pas la fiche d\'un autre agent, et le refus est au journal', async () => {
    const response = await call(w.env, `/v1/fiches/${w.others}`, { key: KEY_AGENT });
    expect(response.status).toBe(403);
    const result = await body(response);
    expect(result).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(JSON.stringify(result)).not.toContain('Dominique');
    expect((await lines(w)).map((entry) => entry.type)).toEqual(['acces.refuse']);
  });

  it('[R16] une fiche inconnue répond 404, et la demande est au journal', async () => {
    const response = await call(w.env, '/v1/fiches/inconnue', { key: KEY_AGENT });
    expect(response.status).toBe(404);
    expect((await lines(w)).map((entry) => entry.type)).toEqual(['acces.refuse']);
  });

  it('[R16] la liste d\'un agent ne montre que ses clients ; un partenaire ne voit rien', async () => {
    const response = await call(w.env, '/v1/fiches', { key: KEY_AGENT });
    expect(response.status).toBe(200);
    const ids = ((await body(response))['data'] as { id: string }[]).map((person) => person.id).sort();
    expect(ids).toEqual([w.mine, w.stopped].sort());
    expect((await call(w.env, '/v1/fiches', { key: KEY_PARTNER })).status).toBe(403);
  });

  it('[R16] un bien en vente d\'un autre agent se lit en fiche commune ; un brouillon est refusé', async () => {
    const shared = await call(w.env, `/v1/biens/${w.propertyOther}`, { key: KEY_AGENT });
    expect(shared.status).toBe(200);
    expect(await body(shared)).toMatchObject({ ok: true, view: 'shared' });
    expect((await call(w.env, `/v1/biens/${w.propertyDraft}`, { key: KEY_AGENT })).status).toBe(403);
  });

  it('[R16] le journal d\'une fiche : refusé à l\'agent, ouvert à la direction', async () => {
    await call(w.env, `/v1/fiches/${w.mine}`, { key: KEY_AGENT });
    expect((await call(w.env, `/v1/fiches/${w.mine}/journal`, { key: KEY_AGENT })).status).toBe(403);
    const response = await call(w.env, `/v1/fiches/${w.mine}/journal`, { key: KEY_DIRECTION });
    expect(response.status).toBe(200);
    const entries = (await body(response))['data'] as JournalEntry[];
    expect(entries.map((entry) => entry.type)).toContain('fiche.lue');
  });

  it('[R01] [R13] décision d\'essai : une relance le dimanche soir est refusée, la règle est au journal, rien ne part', async () => {
    const before = await w.fiches.listMessages(w.mine);
    const response = await call(w.env, '/v1/envois/decision', {
      key: KEY_AGENT,
      body: { personId: w.mine, channel: 'instagram', kind: 'follow_up', at: SUNDAY_22H.toISOString() },
    });
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result).toMatchObject({ ok: true, mode: 'essai', sent: false, data: { allowed: false, rule: 'R01' } });
    expect(await w.fiches.listMessages(w.mine)).toEqual(before);
    const decision = (await lines(w)).find((entry) => entry.type === 'envoi.decision.essai');
    expect(decision).toMatchObject({ subject: `person:${w.mine}`, data: { rule: 'R01', allowed: false, mode: 'essai' } });
  });

  it('[R03] décision d\'essai : une prospection par mail sans accord est refusée', async () => {
    const response = await call(w.env, '/v1/envois/decision', {
      key: KEY_AGENT,
      body: { personId: w.mine, channel: 'email', kind: 'prospecting', at: MONDAY_10H.toISOString() },
    });
    expect(await body(response)).toMatchObject({ data: { allowed: false, rule: 'R03' } });
  });

  it('[R03] décision d\'essai : avec un accord en cours, le même mail serait permis, sans partir', async () => {
    await w.fiches.addConsent({
      networkId: w.net,
      agentId: w.agentId,
      personId: w.mine,
      purpose: 'prospecting',
      channel: 'email',
      proof: 'formulaire-test',
      givenAt: new Date('2026-10-01T08:00:00.000Z'),
    });
    const response = await call(w.env, '/v1/envois/decision', {
      key: KEY_AGENT,
      body: { personId: w.mine, channel: 'email', kind: 'prospecting', at: MONDAY_10H.toISOString() },
    });
    expect(await body(response)).toMatchObject({ sent: false, data: { allowed: true } });
    expect((await w.fiches.listMessages(w.mine)).filter((m) => m.direction === 'out')).toHaveLength(0);
  });

  it('[R04] décision d\'essai : après « stop », plus rien sur aucun canal', async () => {
    for (const channel of ['email', 'sms', 'instagram', 'whatsapp']) {
      const response = await call(w.env, '/v1/envois/decision', {
        key: KEY_AGENT,
        body: { personId: w.stopped, channel, kind: 'reply', conversationId: 'conv-stop', at: MONDAY_10H.toISOString() },
      });
      expect(await body(response)).toMatchObject({ data: { allowed: false, rule: 'R04' } });
    }
  });

  it('[R16] décision d\'essai sur la fiche d\'un autre agent : refusée, sans décision au journal', async () => {
    const response = await call(w.env, '/v1/envois/decision', {
      key: KEY_AGENT,
      body: { personId: w.others, channel: 'email', kind: 'reply' },
    });
    expect(response.status).toBe(403);
    expect((await lines(w)).map((entry) => entry.type)).toEqual(['acces.refuse']);
  });

  it('décision d\'essai : un corps mal formé est refusé sans rien lire', async () => {
    const bad: unknown[] = [
      { personId: w.mine, channel: 'pigeon', kind: 'reply' },
      { personId: w.mine, channel: 'email', kind: 'spam' },
      { personId: w.mine, channel: 'email', kind: 'reply', at: 'hier' },
      { channel: 'email', kind: 'reply' },
      [1, 2],
    ];
    for (const item of bad) {
      expect((await call(w.env, '/v1/envois/decision', { key: KEY_AGENT, body: item })).status).toBe(400);
    }
    expect(await lines(w)).toHaveLength(0);
  });

  it('[R13] le journal tenu sous D1 garde sa chaîne, et seule la direction peut la vérifier', async () => {
    await call(w.env, `/v1/fiches/${w.mine}`, { key: KEY_AGENT });
    await call(w.env, `/v1/fiches/${w.others}`, { key: KEY_AGENT });
    expect((await call(w.env, '/v1/journal/verification', { key: KEY_AGENT })).status).toBe(403);
    const response = await call(w.env, '/v1/journal/verification', { key: KEY_DIRECTION });
    expect(await body(response)).toMatchObject({ ok: true, data: { ok: true, lines: 3 } });
    expect(await verifyChain(await lines(w))).toEqual({ ok: true });
  });

  it('adresse inconnue : 404 ; mauvaise méthode : 405', async () => {
    expect((await call(w.env, '/v1/inconnue', { key: KEY_AGENT })).status).toBe(404);
    expect((await call(w.env, '/autre', { key: KEY_AGENT })).status).toBe(404);
    expect((await call(w.env, '/v1/fiches', { key: KEY_AGENT, method: 'DELETE' })).status).toBe(405);
  });

  it('une erreur n\'est jamais avalée : 500 et une ligne au journal, sans détail', async () => {
    const failing: SqlDatabase = {
      ...w.db,
      first: (sql, params) =>
        sql.includes('FROM persons') ? Promise.reject(new Error('panne inventée')) : w.db.first(sql, params),
    };
    const response = await handleRequest(
      new Request(`${BASE}/v1/fiches/${w.mine}`, { headers: { authorization: `Bearer ${KEY_AGENT}` } }),
      { db: failing, apiKeys: w.env.API_KEYS, mode: 'essai' },
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await body(response))).not.toContain('panne');
    const last = (await lines(w)).at(-1);
    expect(last).toMatchObject({ type: 'api.erreur', data: { route: 'fiche', error: 'Error' } });
  });
});

describe('configuration du Worker', () => {
  const toml = readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8');
  const settings = toml.split('\n').filter((line) => !line.trim().startsWith('#'));

  it('aucune route sur shawez-immo.com : la mise en ligne ne touche pas ses systèmes', () => {
    expect(settings.some((line) => /^\s*routes?\s*=/.test(line))).toBe(false);
    expect(settings.join('\n')).not.toMatch(/shawez/i);
    expect(toml).toMatch(/^name = "aimmo-api"$/m);
  });

  it('mode essai, et aucune clé dans la configuration', () => {
    expect(toml).toMatch(/^MODE = "essai"$/m);
    expect(settings.join('\n')).not.toMatch(/API_KEYS\s*=/);
  });
});
