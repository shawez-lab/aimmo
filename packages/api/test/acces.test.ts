import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { applyMigrations, type SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import { exchangeInvitation, mergeKeys, parseGrants, randomToken } from '../src/acces.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { createAccess, invitationLink, invitationMail, invitationSql, readRequest, sendFailureDetail, sha256, type Runner } from '../outils/creer-acces.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase, type SqliteDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';
import { fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : personnes, adresses, réseau, clés.
const ENV = {
  ACCES_PRENOM: 'Camille',
  ACCES_NOM: 'Exemple',
  ACCES_MAIL: 'camille@exemple.test',
  ACCES_EXPEDITEUR: 'acces@exemple.test',
  ACCES_RESEAU: 'reseau-essai',
  ACCES_AGENT: 'agent-direction',
};
const BASE = 'https://aimmo-api.example.workers.dev';
const T0 = new Date('2026-11-02T09:00:00.000Z');
const SECRET_KEY = 'test-cle-secret-direction-zzzzzzzzzzzzzzzzzzzzzz';

interface World {
  raw: SqliteDatabase;
  db: SqlDatabase;
  sql: (text: string) => void;
}

async function world(): Promise<World> {
  const raw = openMemoryDatabase();
  const db = fromD1(fakeD1(raw));
  await applyMigrations(db, loadMigrations());
  return { raw, db, sql: (text) => raw.exec(text) };
}

/** Range une invitation comme le fait le travail GitHub, et rend son jeton. */
async function invite(w: World, at: Date = T0, env: Record<string, string> = ENV): Promise<string> {
  const token = randomToken(32);
  w.sql(invitationSql(readRequest(env), sha256(token), at));
  return token;
}

function dump(raw: SqliteDatabase): string {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return tables.map((t) => JSON.stringify(raw.prepare(`SELECT * FROM "${t.name}"`).all())).join('\n');
}

const call = (db: SqlDatabase, path: string, init: RequestInit = {}, apiKeys?: string, now: Date = T0) =>
  handleRequest(new Request(`${BASE}${path}`, init), { db, apiKeys, mode: 'essai', now: () => now });
const exchange = (db: SqlDatabase, jeton: unknown, now: Date = T0) =>
  call(db, '/v1/acces/invitation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jeton }) }, undefined, now);

describeWithSqlite('Z02 · lien d’invitation à usage unique', () => {
  it('le lien ouvre deux clés neuves, agent et direction, dont la base ne garde que l’empreinte', async () => {
    const w = await world();
    const token = await invite(w);
    const res = await exchange(w.db, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { data: { cles: { role: string; cle: string }[] } };
    const cles = body.data.cles;
    expect(cles.map((c) => c.role)).toEqual(['agent', 'direction']);
    expect(new Set(cles.map((c) => c.cle)).size).toBe(2);
    for (const c of cles) expect(c.cle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = dump(w.raw);
    for (const c of cles) {
      expect(stored).not.toContain(c.cle);
      expect(stored).toContain(await sha256Hex(c.cle));
    }
    expect(stored).not.toContain(token);

    const agent = await call(w.db, '/v1/moi', { headers: { authorization: `Bearer ${cles[0]!.cle}` } });
    expect(await agent.json()).toMatchObject({ data: { role: 'agent', firstName: 'Camille' } });
    const direction = await call(w.db, '/v1/moi', { headers: { authorization: `Bearer ${cles[1]!.cle}` } });
    expect(await direction.json()).toMatchObject({ data: { role: 'direction' } });
  });

  it('un lien ne sert qu’une fois, même pour deux échanges simultanés', async () => {
    const w = await world();
    const token = await invite(w);
    const [a, b] = await Promise.all([exchange(w.db, token), exchange(w.db, token)]);
    expect([a.status, b.status].sort()).toEqual([200, 410]);
    const again = await exchange(w.db, token, new Date(T0.getTime() + 60_000));
    expect(again.status).toBe(410);
    expect(await again.json()).toMatchObject({ error: { code: 'invitation_used' } });
    expect((w.raw.prepare('SELECT COUNT(*) AS n FROM access_keys').get() as { n: number }).n).toBe(2);
  });

  it('un lien expiré est refusé à la 24e heure, accepté juste avant', async () => {
    const w = await world();
    const late = await invite(w);
    const res = await exchange(w.db, late, new Date(T0.getTime() + 24 * 3600_000));
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: { code: 'invitation_expired' } });
    expect((w.raw.prepare('SELECT COUNT(*) AS n FROM access_keys').get() as { n: number }).n).toBe(0);
    const inTime = await invite(w);
    expect((await exchange(w.db, inTime, new Date(T0.getTime() + 24 * 3600_000 - 1000))).status).toBe(200);
  });

  it('un jeton inconnu ou mal formé n’ouvre rien', async () => {
    const w = await world();
    await invite(w);
    expect((await exchange(w.db, randomToken(32))).status).toBe(404);
    expect((await exchange(w.db, 'court')).status).toBe(400);
    expect((await exchange(w.db, 42)).status).toBe(400);
    const get = await call(w.db, '/v1/acces/invitation');
    expect(get.status).toBe(405);
    expect((w.raw.prepare('SELECT COUNT(*) AS n FROM access_keys').get() as { n: number }).n).toBe(0);
  });

  it('le journal garde l’usage et les refus, sans jeton, clé ni empreinte de clé [R13]', async () => {
    const w = await world();
    const token = await invite(w);
    const res = await exchange(w.db, token);
    const cles = ((await res.json()) as { data: { cles: { cle: string }[] } }).data.cles;
    await exchange(w.db, token);
    const journal = JSON.stringify(w.raw.prepare('SELECT * FROM journal').all());
    expect(journal).toContain('acces.invitation_utilisee');
    expect(journal).toContain('acces.invitation_refusee');
    expect(journal).not.toContain(token);
    expect(journal).not.toContain(await sha256Hex(token));
    for (const c of cles) {
      expect(journal).not.toContain(c.cle);
      expect(journal).not.toContain(await sha256Hex(c.cle));
    }
    expect(journal).not.toContain('camille@exemple.test');
  });

  it('les empreintes déjà présentes dans API_KEYS restent toutes valables, et l’API reste fermée sans aucune clé', async () => {
    const w = await world();
    w.sql("INSERT INTO networks (id, name, created_at) VALUES ('reseau-essai', 'Essai', '2026-01-01T00:00:00.000Z')");
    const secret = JSON.stringify([{ sha256: await sha256Hex(SECRET_KEY), role: 'direction', userId: 'dir-1', networkId: 'reseau-essai' }]);
    const closed = await call(w.db, '/v1/moi', { headers: { authorization: `Bearer ${SECRET_KEY}` } });
    expect(closed.status).toBe(503);
    const before = await call(w.db, '/v1/moi', { headers: { authorization: `Bearer ${SECRET_KEY}` } }, secret);
    expect(before.status).toBe(200);
    const token = await invite(w);
    const cles = ((await (await exchange(w.db, token)).json()) as { data: { cles: { cle: string }[] } }).data.cles;
    const after = await call(w.db, '/v1/moi', { headers: { authorization: `Bearer ${SECRET_KEY}` } }, secret);
    expect(after.status).toBe(200);
    expect((await call(w.db, '/v1/moi', { headers: { authorization: `Bearer ${cles[0]!.cle}` } }, secret)).status).toBe(200);
    // Un secret mal formé ferme tout, clés d'invitation comprises : lecture prudente.
    expect((await call(w.db, '/v1/moi', { headers: { authorization: `Bearer ${cles[0]!.cle}` } }, '[{"oups":1}]')).status).toBe(503);
    // Une clé retirée ne sert plus.
    w.sql("UPDATE access_keys SET revoked_at = '2026-11-03T00:00:00.000Z'");
    expect((await call(w.db, '/v1/moi', { headers: { authorization: `Bearer ${cles[0]!.cle}` } }, secret)).status).toBe(401);
  });

  it('une invitation et une clé ne s’effacent pas, et ne changent que pour servir ou être retirées', async () => {
    const w = await world();
    const token = await invite(w);
    expect(() => w.sql('DELETE FROM access_invitations')).toThrow();
    expect(() => w.sql("UPDATE access_invitations SET expires_at = '2099-01-01T00:00:00.000Z'")).toThrow();
    await exchange(w.db, token);
    expect(() => w.sql("UPDATE access_invitations SET used_at = '2026-11-02T10:00:00.000Z'")).toThrow();
    expect(() => w.sql('DELETE FROM access_keys')).toThrow();
    expect(() => w.sql("UPDATE access_keys SET role = 'compliance'")).toThrow();
  });

  it('le travail crée la fiche d’agent une seule fois, et refuse une fiche d’un autre réseau', async () => {
    const w = await world();
    await invite(w);
    await invite(w, new Date(T0.getTime() + 1000));
    expect((w.raw.prepare("SELECT COUNT(*) AS n FROM agents WHERE id = 'agent-direction'").get() as { n: number }).n).toBe(1);
    expect((w.raw.prepare('SELECT COUNT(*) AS n FROM access_invitations').get() as { n: number }).n).toBe(2);
    expect(() => w.sql(invitationSql(readRequest({ ...ENV, ACCES_RESEAU: 'autre-reseau' }), sha256(randomToken(32)), T0))).toThrow();
    expect((w.raw.prepare('SELECT COUNT(*) AS n FROM access_invitations').get() as { n: number }).n).toBe(2);
  });

  it('du travail GitHub au lien : le mail porte le seul jeton dont la base garde l’empreinte', async () => {
    const w = await world();
    const logs: string[] = [];
    const sent: ReturnType<typeof invitationMail>[] = [];
    let sqlText = '';
    const runner: Runner = {
      d1(file) {
        sqlText = readFileSync(file, 'utf8');
        w.sql(sqlText);
        return { ok: true };
      },
      async send(mail) {
        sent.push(mail);
        return { ok: true, detail: '' };
      },
      log: (l) => logs.push(l),
      now: () => T0,
    };
    expect(await createAccess(ENV, runner)).toBe(true);
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.to).toBe('camille@exemple.test');
    const token = /#invitation=([A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
    expect(mail.text).toContain(invitationLink('https://aimmo-api.shawez.workers.dev/app/', token));
    expect(sqlText).not.toContain(token);
    expect(sqlText).toContain(sha256(token));
    expect(logs.join('\n')).not.toMatch(/invitation=|camille@|[A-Za-z0-9_-]{43}/);
    // Le mail ne parle ni de l'IA, ni de gratuité [R06].
    expect(mail.text).not.toMatch(/\bIA\b|intelligence artificielle|gratuit/i);
    expect((await exchange(w.db, token)).status).toBe(200);
  });

  it('rien ne part si la base refuse, et un mail refusé ne laisse qu’une invitation que personne ne connaît', async () => {
    const logs: string[] = [];
    let sends = 0;
    const base: Runner = { d1: () => ({ ok: false }), send: async () => ((sends += 1), { ok: true, detail: '' }), log: (l) => logs.push(l), now: () => T0 };
    expect(await createAccess(ENV, base)).toBe(false);
    expect(sends).toBe(0);
    expect(await createAccess(ENV, { ...base, d1: () => ({ ok: true }), send: async () => ({ ok: false, detail: sendFailureDetail(403, { errors: [{ code: 10000, message: 'camille@exemple.test' }] }) }) })).toBe(false);
    expect(logs.join('\n')).toContain('HTTP 403, codes 10000');
    expect(logs.join('\n')).not.toContain('camille@');
  });

  it('une demande douteuse s’arrête avant toute écriture', () => {
    expect(() => readRequest({ ...ENV, ACCES_PRENOM: "x'); DROP TABLE agents; --" })).toThrow();
    expect(() => readRequest({ ...ENV, ACCES_MAIL: 'pas-une-adresse' })).toThrow();
    expect(() => readRequest({ ...ENV, ACCES_AGENT: 'Agent Direction' })).toThrow();
    expect(() => readRequest({ ...ENV, ACCES_APP: 'http://aimmo.test/app/' })).toThrow();
    expect(readRequest({ ...ENV, ACCES_NOM: "D'Arc-Lefèvre" }).lastName).toBe("D'Arc-Lefèvre");
    const sql = invitationSql(readRequest({ ...ENV, ACCES_NOM: "D'Arc" }), 'a'.repeat(64), T0, 'inv-1');
    expect(sql).toContain("'D''Arc'");
  });
});

describe('Z02 · règles sans base', () => {
  it('les clés du secret passent toujours avant celles des invitations, aucune n’est perdue', () => {
    const a = { sha256: 'a'.repeat(64), role: 'direction' as const, userId: 'd', networkId: 'n' };
    const b = { sha256: 'b'.repeat(64), role: 'agent' as const, userId: 'x', networkId: 'n' };
    const clash = { ...a, role: 'agent' as const, userId: 'autre' };
    expect(mergeKeys([a], [clash, b])).toEqual([a, b]);
  });

  it('une invitation aux rôles mal formés n’ouvre rien', () => {
    expect(parseGrants('[]')).toBeNull();
    expect(parseGrants('[{"role":"roi","userId":"x"}]')).toBeNull();
    expect(parseGrants('[{"role":"agent","userId":"x"},{"role":"agent","userId":"y"}]')).toBeNull();
    expect(parseGrants('oups')).toBeNull();
  });

  it('le travail GitHub ne lit ni ne réécrit API_KEYS, et ne tourne que depuis main', () => {
    const yml = readFileSync(new URL('../../../.github/workflows/creer-acces.yml', import.meta.url), 'utf8');
    const tool = readFileSync(new URL('../outils/creer-acces.ts', import.meta.url), 'utf8');
    for (const text of [yml, tool]) expect(text).not.toMatch(/secret\s+(?:put|bulk)|'secret'/);
    expect(yml).toContain("if: github.ref == 'refs/heads/main'");
    expect(yml).toContain('workflow_dispatch');
    // Aucune adresse ni aucun nom réels écrits dans le dépôt : tout est donné au lancement.
    expect(yml).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
  });

  it('exchangeInvitation refuse un jeton qui n’est pas une chaîne', async () => {
    const db = { first: async () => null } as unknown as SqlDatabase;
    expect(await exchangeInvitation(db, null, T0)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('Z02 · la page ouvre l’application déjà connectée', () => {
  const HTML = AGENT_APP_FILES['/app/']!;
  const TOKEN = 'T'.repeat(43);
  const AGENT_KEY = 'a'.repeat(43);
  const DIR_KEY = 'd'.repeat(43);
  const settle = async () => {
    for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
  };
  type Answer = (init: { body?: string }) => Promise<Response>;

  async function open(hash: string, invitation: Answer, stored: [string, string][] = []) {
    const { els, listeners, document } = fakeDocument(pageIds(HTML));
    const storage = new Map<string, string>(stored);
    const calls: { method: string; url: string; authorization?: string | undefined; body?: string | undefined }[] = [];
    const replaced: string[] = [];
    const empty = async () => Response.json({ ok: true, mode: 'essai', data: [] });
    runInNewContext(AGENT_APP_FILES['/app/app.js']!, {
      document,
      location: { hash },
      history: { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
      localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
      fetch: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
        const method = init.method ?? 'GET';
        const authorization = init.headers?.authorization;
        calls.push({ method, url, authorization, body: init.body });
        if (url === '/v1/acces/invitation') return invitation(init);
        if (url === '/v1/moi') {
          if (authorization === `Bearer ${AGENT_KEY}`) return Promise.resolve(Response.json({ ok: true, data: { role: 'agent', firstName: 'Camille' } }));
          if (authorization === `Bearer ${DIR_KEY}`) return Promise.resolve(Response.json({ ok: true, data: { role: 'direction', firstName: null } }));
          return Promise.resolve(Response.json({ ok: false }, { status: 401 }));
        }
        return empty();
      },
      URL: { createObjectURL: () => 'blob:essai', revokeObjectURL: () => undefined },
      setTimeout,
      navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
    });
    listeners.DOMContentLoaded!();
    await settle();
    return { els, storage, calls, replaced };
  }

  it('le lien entre sans rien saisir, garde les deux clés sur l’appareil et passe de la journée au réseau', async () => {
    const t = await open(`#invitation=${TOKEN}`, async (init) => {
      expect(JSON.parse(init.body!)).toEqual({ jeton: TOKEN });
      return Response.json({ ok: true, data: { cles: [{ role: 'agent', cle: AGENT_KEY }, { role: 'direction', cle: DIR_KEY }] } });
    });
    expect(t.replaced).toEqual(['/app/']);
    expect(t.storage.get('aimmo.cle')).toBe(AGENT_KEY);
    expect(t.storage.get('aimmo.cle.direction')).toBe(DIR_KEY);
    expect(t.els.accueil!.hidden).toBe(false);
    expect(t.els.bonjour!.textContent).toBe('Bonjour Camille');
    // Le jeton ne part que dans le corps de l'échange, jamais dans une adresse ni un en-tête.
    expect(t.calls.filter((c) => c.url.includes(TOKEN) || (c.authorization ?? '').includes(TOKEN))).toHaveLength(0);
    expect(t.els['vers-reseau']!.hidden).toBe(false);
    t.els['vers-reseau']!.listeners.click!({});
    await settle();
    expect(t.els.reseau!.hidden).toBe(false);
    expect(t.els['vers-journee']!.hidden).toBe(false);
    t.els['vers-journee']!.listeners.click!({});
    await settle();
    expect(t.els.accueil!.hidden).toBe(false);
  });

  it('un lien déjà servi ne garde rien et le dit simplement', async () => {
    const t = await open(`#invitation=${TOKEN}`, async () => Response.json({ ok: false, error: { code: 'invitation_used' } }, { status: 410 }));
    expect(t.storage.size).toBe(0);
    expect(t.els.connexion!.hidden).toBe(false);
    expect(t.els.erreur!.textContent).toBe('Ce lien a déjà servi. Demandez un nouveau lien.');
    expect(t.replaced).toEqual(['/app/']);
  });

  it('un lien expiré le dit aussi, et un lien tronqué ne part même pas', async () => {
    const t = await open(`#invitation=${TOKEN}`, async () => Response.json({ ok: false, error: { code: 'invitation_expired' } }, { status: 410 }));
    expect(t.els.erreur!.textContent).toContain('expiré');
    const cut = await open('#invitation=TTT', async () => {
      throw new Error('aucun appel attendu');
    });
    expect(cut.calls.some((c) => c.url === '/v1/acces/invitation')).toBe(false);
    expect(cut.els.erreur!.textContent).toContain('incomplet');
  });

  it('sans lien, l’application s’ouvre comme avant avec la clé de l’appareil, sans bouton vers le réseau', async () => {
    const t = await open('', async () => {
      throw new Error('aucun appel attendu');
    }, [['aimmo.cle', AGENT_KEY]]);
    expect(t.els.accueil!.hidden).toBe(false);
    expect(t.els['vers-reseau']!.hidden).toBe(true);
    expect(t.replaced).toEqual([]);
  });
});
