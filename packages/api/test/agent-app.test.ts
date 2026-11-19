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
import { fakeDocument, pageIds } from './fake-dom.ts';

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
    // Les demandes de M08 passent par `send` : chacune vise une adresse fixe de l'API, sans la clé.
    const sends = js.match(/\bsend\(([^,)]+)/g) ?? [];
    expect(sends.length).toBeGreaterThan(5);
    for (const call of sends) expect(call).toMatch(/^send\((?:path|base|'\/v1\/)/);
    // Le dépôt du Studio (X12) : son adresse est faite par l'écran, sous `/v1/studio/biens/`, jamais avec la clé.
    expect(js).toContain("'x-aimmo-sha256': sha");
    // `base` est toujours une adresse fixe de l'API.
    for (const b of js.match(/var base = [^;]+;/g) ?? []) expect(b).toMatch(/^var base = '\/v1\//);
    expect(js.match(/(?:api|fetch)\(([^,)]+)/g)?.sort()).toEqual(['api(path', 'api(path', 'api(path', 'fetch(path', 'fetch(path', "fetch('/v1/acces/invitation'", "api('/v1/plan-du-jour'", "api('/v1/alertes-agent'", "api('/v1/offres/a-tenir'", "api('/v1/contacts-chauds'", "api('/v1/annonces'", "api('/v1/rendez-vous/jour'", "api('/v1/usage/matin'", "api('/v1/apres-vente/journee'", "api('/v1/moi'", "api('/v1/fiches/' + encodeURIComponent(personId", "api('/v1/rappels/' + encodeURIComponent(taskId"].sort());
    // BR102 : le dépôt au coffre a quitté le script de l'application ; servi à part, il passe par `send`, sous `/v1/conformite/personnes/`.
    const coffre = AGENT_APP_FILES['/app/coffre.js']!;
    expect(coffre.match(/(?:api|fetch)\(/g)).toBeNull();
    expect(coffre.match(/\bsend\(([^,)]+)/g)).toEqual(["send(base + '/recus'", 'send(base + q']);
    expect(coffre).toContain("var base = '/v1/conformite/personnes/' + encodeURIComponent(personId) + '/coffre';");
  });

  it('[R16] une clé refusée ne montre rien et est effacée ; une panne ne l’efface pas ; la déconnexion l’efface', async () => {
    const run = async (answer: () => Promise<Response>, stored: string | null, navigator: Record<string, unknown> = {}) => {
      const { els, listeners: docListeners, document } = fakeDocument(pageIds(AGENT_APP_FILES['/app/']!));
      const storage = new Map<string, string>(stored === null ? [] : [['aimmo.cle', stored]]);
      const calls: { url: string; headers: Record<string, string> }[] = [];
      runInNewContext(AGENT_APP_FILES['/app/app.js']!, {
        document,
        localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
        fetch: (url: string, init: { headers: Record<string, string> }) => {
          calls.push({ url, headers: init.headers });
          return answer();
        },
        navigator,
      });
      docListeners.DOMContentLoaded!();
      await new Promise((r) => setTimeout(r, 0));
      // AU018 : la visite sans réseau n'est pas sur cet appareil : son script ne se charge pas.
      for (const e of els['hors-ligne']!.all()) if (e.tagName === 'script') e.listeners.error?.({});
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      return { els, storage, calls };
    };
    const KEY = 'k'.repeat(40);
    const ok = await run(async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }), KEY);
    expect(ok.els.accueil!.hidden).toBe(false);
    expect(ok.els.bonjour!.textContent).toBe('Bonjour Alex');
    // Après /v1/moi, la journée : plan, contacts chauds, rendez-vous, toujours avec la clé dans l'en-tête seulement.
    expect(ok.calls).toEqual(['/v1/moi', '/v1/plan-du-jour', '/v1/alertes-agent', '/v1/offres/a-tenir', '/v1/contacts-chauds', '/v1/annonces', '/v1/rendez-vous/jour', '/v1/apres-vente/journee', '/v1/usage/matin'].map((url) => ({ url, headers: { authorization: `Bearer ${KEY}` } })));
    // Sans service worker, l'agent est prévenu, la panne n'est pas avalée.
    expect(ok.els.note!.hidden).toBe(false);
    const failing = await run(async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }), KEY, { serviceWorker: { register: () => Promise.reject(new Error('refus')) } });
    expect(failing.els.note!.textContent).toMatch(/réseau/);
    const working = await run(async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }), KEY, { serviceWorker: { register: () => Promise.resolve({}) } });
    expect(working.els.note!.hidden).toBe(true);
    ok.els.sortir!.listeners.click!({});
    expect(ok.storage.has('aimmo.cle')).toBe(false);
    expect(ok.els.accueil!.hidden).toBe(true);
    expect(ok.els.bonjour!.textContent).toBe('');

    for (const answer of [
      async () => Response.json({ ok: false, code: 'unauthorized' }, { status: 401 }),
      async () => Response.json({ ok: false, rule: 'R16', code: 'agent_inactive' }, { status: 403 }),
      // La direction a son écran depuis K09, le responsable de la conformité depuis L10 ; un partenaire n'a rien ici.
      async () => Response.json({ ok: true, data: { role: 'partner', firstName: null } }),
    ]) {
      const refused = await run(answer, KEY);
      expect(refused.els.accueil!.hidden).toBe(true);
      expect(refused.els.connexion!.hidden).toBe(false);
      expect(refused.els.bonjour!.textContent).toBe('');
      expect(refused.storage.has('aimmo.cle')).toBe(false);
    }
    for (const answer of [async () => Promise.reject(new TypeError('hors ligne')), async () => new Response('panne', { status: 503 })]) {
      const offline = await run(answer, KEY);
      expect(offline.els.accueil!.hidden).toBe(true);
      expect(offline.storage.get('aimmo.cle')).toBe(KEY);
      expect(offline.els.erreur!.textContent).toMatch(/Réessayez/);
    }
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
        keys: async () => ['aimmo-app-v0', 'aimmo-app-v1', 'aimmo-app-v2'],
        delete: async (n: string) => void stored.push(`delete:${n}`),
        match: async () => undefined,
      },
      fetch: async () => new Response('x'),
    };
    runInNewContext(AGENT_APP_FILES['/app/sw.js']!, sandbox);
    listeners.install!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    listeners.activate!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    // AU018 : la coquille v2 garde la visite sans réseau ; les anciennes sont effacées.
    expect(stored).toEqual([...AGENT_APP_SHELL, 'delete:aimmo-app-v0', 'delete:aimmo-app-v1']);
    expect(AGENT_APP_SHELL).toContain('/app/hors-ligne.js');
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
