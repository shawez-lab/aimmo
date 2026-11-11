import { expect, it } from 'vitest';
import { checkRecruitingText } from '../../core/src/reseau/index.ts';
import type { SqlDatabase } from '../../core/src/db/sql.ts';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { handleCandidature } from '../src/candidature.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents et clés inventés. Le mardi 9 mars 2027, à 10 h à Paris.
const NOW = new Date('2027-03-09T09:00:00.000Z');
const KEYS = {
  alex: 'test-cle-br37-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  direction: 'test-cle-br37-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br37-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: t.alexId },
    direction: { role: 'direction', userId: t.direction.userId },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now };
  const http = async (who: Who, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string } };
  };
  const page = async (path: string, form?: Record<string, string>, db: SqlDatabase = t.db) => {
    const init: RequestInit = form ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() } : {};
    const res = await handleCandidature(new Request(`https://aimmo.exemple.test${path}`, init), { db, networkId: t.network.id, now: t.now });
    return { status: res!.status, html: await res!.text() };
  };
  const events = async (type: string) => (await t.journal.all()).filter((e) => e.type === type);
  return { ...t, http, page, events };
}

/** La section des communes de la page, ou `null` si elle n'y est pas. */
const section = (html: string): string | null => html.match(/<h2><small>Où nous recrutons<\/small>[\s\S]*?<\/ul>/)?.[0] ?? null;

describeWithSqlite('BR37 · routes des communes à pourvoir et communes ouvertes sur la page de candidature', () => {
  it('[R16] les deux routes sont à la direction seule : 403 et refus au journal, rien n’est rangé', async () => {
    const t = await setup();
    for (const who of ['alex', 'conformite'] as Who[]) {
      expect(await t.http(who, 'GET', '/recrutement/communes?mois=2027-02')).toMatchObject({ status: 403, body: { ok: false, rule: 'R16', code: 'role' } });
      expect(await t.http(who, 'POST', '/recrutement/communes/decision', { commune: 'Talant', open: true, reason: 'Des clients attendent' })).toMatchObject({ status: 403, body: { rule: 'R16' } });
      // Un corps illisible ne passe jamais avant le rôle.
      expect((await t.http(who, 'POST', '/recrutement/communes/decision', 'pas un objet')).status).toBe(403);
    }
    const refused = await t.events('acces.refuse');
    expect(refused.length).toBe(6);
    expect(refused.map((e) => (e.data as { kind: string }).kind)).toContain('recrutement.communes.decision');
    expect(await t.db.all('SELECT * FROM recruiting_commune_decisions')).toEqual([]);
    expect(await t.events('communes_recrutement.mois_lu')).toEqual([]);
  });

  it('[R626] la direction lit un mois fini, commune par commune ; le mois en cours est refusé', async () => {
    const t = await setup();
    const r = await t.http('direction', 'GET', '/recrutement/communes?mois=2027-02');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: 'essai' });
    expect(r.body.data.month).toBe('2027-02');
    expect(r.body.data.withoutCommune).toBe(0);
    const talant = (r.body.data.communes as { commune: string }[]).find((c) => c.commune === 'Talant');
    expect(talant).toEqual({ commune: 'Talant', clientsWaiting: 0, agentsNow: expect.any(Number), open: false, openSince: null, toOpen: false, toClose: false });
    expect((await t.events('communes_recrutement.mois_lu')).length).toBe(1);
    expect(await t.http('direction', 'GET', '/recrutement/communes?mois=2027-03')).toMatchObject({ status: 409, body: { ok: false, rule: 'R626', code: 'month_not_finished' } });
    expect(await t.http('direction', 'GET', '/recrutement/communes')).toMatchObject({ status: 400, body: { code: 'bad_month' } });
    expect(await t.http('direction', 'GET', '/recrutement/communes?mois=2027-13')).toMatchObject({ status: 400, body: { code: 'bad_month' } });
  });

  it('[R627] ouvrir puis fermer une commune par versions ; hors liste, décision répétée, champ inconnu ou sans raison refusés', async () => {
    const t = await setup();
    const open = await t.http('direction', 'POST', '/recrutement/communes/decision', { commune: 'Talant', open: true, reason: 'Des clients attendent un agent' });
    expect(open).toMatchObject({ status: 200, body: { ok: true, data: { commune: 'Talant', version: 1, open: true } } });
    expect(await t.http('direction', 'POST', '/recrutement/communes/decision', { commune: 'Talant', open: true, reason: 'Encore' })).toMatchObject({ status: 409, body: { rule: 'R627', code: 'deja_ouverte' } });
    expect(await t.http('direction', 'POST', '/recrutement/communes/decision', { commune: 'Paris', open: true, reason: 'Hors de la liste' })).toMatchObject({ status: 409, body: { rule: 'R627', code: 'commune_inconnue' } });
    expect(await t.http('direction', 'POST', '/recrutement/communes/decision', { commune: 'Longvic', open: true, reason: 'Ok', note: 'x' })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    expect(await t.http('direction', 'POST', '/recrutement/communes/decision', { commune: 'Longvic', open: true })).toMatchObject({ status: 400, body: { code: 'bad_reason' } });
    expect(await t.http('direction', 'POST', '/recrutement/communes/decision', { commune: 'Longvic', open: 'oui', reason: 'Texte' })).toMatchObject({ status: 400, body: { code: 'bad_open' } });
    const month = await t.http('direction', 'GET', '/recrutement/communes?mois=2027-02');
    expect((month.body.data.communes as { commune: string; open: boolean }[]).find((c) => c.commune === 'Talant')).toMatchObject({ open: true, openSince: NOW.toISOString() });
    const close = await t.http('direction', 'POST', '/recrutement/communes/decision', { commune: 'Talant', open: false, reason: 'Un agent arrive' });
    expect(close).toMatchObject({ status: 200, body: { data: { version: 2, open: false } } });
    // Rien ne s'efface : les deux versions restent.
    expect(await t.db.all<{ version: number; is_open: number }>('SELECT version, is_open FROM recruiting_commune_decisions ORDER BY version')).toEqual([
      { version: 1, is_open: 1 },
      { version: 2, is_open: 0 },
    ]);
  });

  it('[R628] [R80] la page de candidature dit les seules communes ouvertes, triées, par leur nom, sans aucun chiffre', async () => {
    const t = await setup();
    // Aucune commune ouverte : aucune section.
    expect(section((await t.page('/rejoindre')).html)).toBeNull();
    for (const commune of ['Talant', 'Chenôve', 'Longvic']) {
      expect((await t.http('direction', 'POST', '/recrutement/communes/decision', { commune, open: true, reason: 'Des clients attendent' })).status).toBe(200);
    }
    expect((await t.http('direction', 'POST', '/recrutement/communes/decision', { commune: 'Longvic', open: false, reason: 'Un agent arrive' })).status).toBe(200);
    const res = await t.page('/rejoindre');
    expect(res.status).toBe(200);
    const s = section(res.html)!;
    expect(s).not.toBeNull();
    expect([...s.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1])).toEqual(['Chenôve', 'Talant']);
    expect(s.replace(/<[^>]+>/g, ' ')).not.toMatch(/\d/);
    expect(res.html).toContain('Votre commune n’y est pas ? Candidatez quand même');
    expect(checkRecruitingText(s.replace(/<[^>]+>/g, ' ')).ok).toBe(true);
    // Un formulaire à corriger garde la liste.
    const again = await t.page('/rejoindre', { firstName: '', currentStatus: 'autre', experience: 'aucune', source: 'page', email: 'lina@exemple.test' });
    expect(again.status).toBe(400);
    expect(section(again.html)).toContain('<li>Talant</li>');
  });

  it('[R628] les communes d’un autre réseau ne sont jamais montrées', async () => {
    const t = await setup();
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO recruiting_commune_decisions (network_id, commune, version, is_open, reason, decided_by, decided_at) VALUES ('autre-reseau', 'Talant', 1, 1, 'Ailleurs', 'direction:x', ?)", [NOW.toISOString()]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    expect(section((await t.page('/rejoindre')).html)).toBeNull();
  });

  it('une lecture des communes qui échoue n’empêche jamais la page de servir', async () => {
    const t = await setup();
    expect((await t.http('direction', 'POST', '/recrutement/communes/decision', { commune: 'Talant', open: true, reason: 'Des clients attendent' })).status).toBe(200);
    const broken: SqlDatabase = {
      exec: (sql) => t.db.exec(sql),
      run: (sql, p) => t.db.run(sql, p),
      first: (sql, p) => t.db.first(sql, p),
      all: async (sql, p) => {
        if (/recruiting_commune_decisions/.test(sql)) throw new Error('base indisponible');
        return t.db.all(sql, p);
      },
    };
    const res = await t.page('/rejoindre', undefined, broken);
    expect(res.status).toBe(200);
    expect(res.html).toContain('<form method="post"');
    expect(section(res.html)).toBeNull();
    // La panne est dite au journal, sans rien de personnel.
    const failed = await t.events('candidature.communes_illisibles');
    expect(failed.length).toBe(1);
    expect(failed[0]!.data).toEqual({ rule: 'R628', error: 'Error' });
  });

  it('une lecture qui échoue, journal en panne aussi : la page sert, la panne est dite à la console', async () => {
    const t = await setup();
    const broken: SqlDatabase = {
      exec: (sql) => t.db.exec(sql),
      run: async (sql, p) => {
        if (/journal/i.test(sql)) throw new Error('journal indisponible');
        return t.db.run(sql, p);
      },
      first: (sql, p) => t.db.first(sql, p),
      all: async (sql, p) => {
        if (/recruiting_commune_decisions/.test(sql)) throw new Error('base indisponible');
        return t.db.all(sql, p);
      },
    };
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const res = await t.page('/rejoindre', undefined, broken);
      expect(res.status).toBe(200);
      expect(section(res.html)).toBeNull();
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([['candidature : communes ouvertes illisibles, journal indisponible', 'Error']]);
  });
});
