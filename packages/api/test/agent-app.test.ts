import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations } from '@aimmo/core';
import { sha256Hex } from '../src/index.ts';
import { AGENT_APP_CSP, AGENT_APP_FILES, AGENT_APP_SHELL } from '../src/agent-app.ts';
import { fromD1 } from '../src/d1.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clés inventées pour les tests, jamais utilisées ailleurs.
const KEY_AGENT = 'test-cle-app-agent-aaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_LEFT = 'test-cle-app-parti-bbbbbbbbbbbbbbbbbbbbbbbbbbb';
const KEY_DIRECTION = 'test-cle-app-direction-ccccccccccccccccccccccc';
const BASE = 'https://aimmo-api.example.workers.dev';

async function world(mode = 'essai') {
  const d1 = fakeD1(openMemoryDatabase());
  const db = fromD1(d1);
  await applyMigrations(db, loadMigrations());
  const fiches = new FicheClient(db);
  const network = await fiches.createNetwork('Réseau test');
  const alex = await fiches.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const gil = await fiches.createAgent({ networkId: network.id, firstName: 'Gil', lastName: 'Parti' });
  await db.run(`UPDATE agents SET status = 'left' WHERE id = ?`, [gil.id]);
  const keys = await Promise.all(
    [
      { key: KEY_AGENT, role: 'agent', userId: alex.id },
      { key: KEY_LEFT, role: 'agent', userId: gil.id },
      { key: KEY_DIRECTION, role: 'direction', userId: 'direction-1' },
    ].map(async ({ key, ...rest }) => ({ sha256: await sha256Hex(key), networkId: network.id, ...rest })),
  );
  const env: Env = { DB: d1, MODE: mode, API_KEYS: JSON.stringify(keys) };
  return { env, db, journal: new SqlJournalStore(db) };
}

const get = (env: Env, path: string, init: RequestInit = {}) => worker.fetch(new Request(`${BASE}${path}`, init), env);

describe('A01 · fichiers de l’application', () => {
  it('[R07] les textes de l’application sont en français, sans « mandataire » ni « gratuit »', () => {
    for (const body of Object.values(AGENT_APP_FILES)) expect(body).not.toMatch(/mandataire|gratuit/i);
    expect(AGENT_APP_FILES['/app/']).toContain('<html lang="fr">');
  });

  it('aucun script ni style en ligne, aucune ressource extérieure', () => {
    const html = AGENT_APP_FILES['/app/']!;
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\sstyle=|<style/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(AGENT_APP_CSP).toContain("default-src 'none'");
    expect(AGENT_APP_CSP).toContain("connect-src 'self'");
  });

  it('[R13] le script pose les textes sans code, et la clé ne passe que dans l’en-tête', () => {
    const js = AGENT_APP_FILES['/app/app.js']!;
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(js).toContain("authorization: 'Bearer ' + key");
    // Les seules adresses appelées sont fixes : aucune n'est construite avec la clé.
    expect(js.match(/(?:api|fetch)\(([^,)]+)/g)).toEqual(['api(path', 'fetch(path', "api('/v1/moi'"]);
  });

  it('le service worker ne garde que la coquille ; une réponse de l’API n’est jamais mise en cache', async () => {
    const stored: string[] = [];
    const listeners: Record<string, (event: unknown) => void> = {};
    const waits: Promise<unknown>[] = [];
    const responded: string[] = [];
    const sandbox = {
      URL,
      Promise,
      self: { location: { origin: BASE }, addEventListener: (name: string, fn: (e: unknown) => void) => (listeners[name] = fn) },
      caches: {
        open: async () => ({ addAll: async (urls: string[]) => void stored.push(...urls), put: async (u: string) => void stored.push(`put:${u}`) }),
        keys: async () => ['aimmo-app-v0', 'aimmo-app-v1'],
        delete: async (n: string) => void stored.push(`delete:${n}`),
        match: async () => undefined,
      },
      fetch: async () => new Response('x'),
    };
    runInNewContext(AGENT_APP_FILES['/app/sw.js']!, sandbox);
    listeners.install!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    listeners.activate!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(stored).toEqual([...AGENT_APP_SHELL, 'delete:aimmo-app-v0']);
    for (const [path, method] of [['/v1/moi', 'GET'], ['/v1/plan-du-jour', 'GET'], ['/app/', 'GET'], ['/app/app.js', 'GET'], ['/app/', 'POST'], ['/ailleurs', 'GET']] as const) {
      listeners.fetch!({ request: { url: `${BASE}${path}`, method }, respondWith: () => responded.push(`${method} ${path}`) });
    }
    expect(responded).toEqual(['GET /app/', 'GET /app/app.js']);
    expect(AGENT_APP_FILES['/app/sw.js']).not.toMatch(/\.put\(/);
    expect(AGENT_APP_SHELL.every((p) => p.startsWith('/app/'))).toBe(true);
  });
});

describeWithSqlite('A01 · coquille servie par le Worker et route /v1/moi', () => {
  it('chaque fichier est servi avec sa politique de contenu et ses en-têtes de sécurité', async () => {
    const w = await world();
    for (const path of [...AGENT_APP_SHELL, '/app/sw.js']) {
      const r = await get(w.env, path);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-security-policy')).toBe(AGENT_APP_CSP);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(await r.text()).toBe(AGENT_APP_FILES[path]);
    }
    expect((await get(w.env, '/app/sw.js')).headers.get('service-worker-allowed')).toBe('/app/');
    const manifest = JSON.parse(await (await get(w.env, '/app/manifest.webmanifest')).text()) as Record<string, unknown>;
    expect(manifest).toMatchObject({ start_url: '/app/', scope: '/app/', display: 'standalone', lang: 'fr' });
    expect((await get(w.env, '/app')).headers.get('location')).toBe('/app/');
    expect((await get(w.env, '/app/inconnu.js')).status).toBe(404);
    expect((await get(w.env, '/app/', { method: 'POST' })).status).toBe(405);
    expect(await w.journal.all()).toEqual([]);
  });

  it('hors mode essai, l’application n’est pas servie', async () => {
    const w = await world('reel');
    expect((await get(w.env, '/app/')).status).toBe(503);
  });

  it('[R16, R13] /v1/moi rend le rôle et le prénom de l’agent, rien d’autre ; clé absente, fausse ou d’un agent parti : refusée, la clé jamais écrite', async () => {
    const w = await world();
    const me = await get(w.env, '/v1/moi', { headers: { authorization: `Bearer ${KEY_AGENT}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ ok: true, mode: 'essai', data: { role: 'agent', firstName: 'Alex' } });
    expect(await (await get(w.env, '/v1/moi', { headers: { authorization: `Bearer ${KEY_DIRECTION}` } })).json()).toEqual({
      ok: true,
      mode: 'essai',
      data: { role: 'direction', firstName: null },
    });
    expect((await get(w.env, '/v1/moi')).status).toBe(401);
    expect((await get(w.env, '/v1/moi', { headers: { authorization: 'Bearer test-cle-inconnue-zzzzzzzzzzzzzzzzzzzzzzzzzzzz' } })).status).toBe(401);
    expect((await get(w.env, '/v1/moi', { headers: { authorization: `Bearer ${KEY_LEFT}` } })).status).toBe(403);
    expect(JSON.stringify(await w.journal.all())).not.toMatch(/test-cle/);
    expect((await w.journal.all()).filter((e) => e.type === 'acces.refuse')).toHaveLength(1);
  });
});
