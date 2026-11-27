import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DepotsReprise, FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type SqlValue, type Viewer } from '@aimmo/core';
import { checkBatch, d1Rest, D1RestError } from '../outils/d1-rest.ts';
import { main, readEnv, safeMessage, summary } from '../outils/reprise.ts';
import { repriseRoutes } from '../src/reprise.ts';
import { APP_JS, INDEX_HTML, RESEAU_PAGE_HTML } from '../app/fichiers.ts';
import { REPRISE_JS, REPRISE_SCRIPT } from '../app/reprise.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase, type SqliteDatabase } from '../../core/test/sqlite.ts';

// Toutes les personnes et coordonnées sont inventées ; les domaines sont réservés aux exemples.
const NOW = new Date('2026-11-01T09:00:00.000Z');
const T = '2026-09-01T08:00:00.000Z';
const AIMMO = '11111111-1111-1111-1111-111111111111';
const SITE = '22222222-2222-2222-2222-222222222222';
const fixture = (name: string): string => readFileSync(new URL(`../../core/test/fixtures/${name}`, import.meta.url), 'utf8');
const mail = (i: number): string => `personne${i}@example.org`;
const phone = (i: number): string => `06 10 00 ${String(Math.floor(i / 100)).padStart(2, '0')} ${String(i % 100).padStart(2, '0')}`;

const FILES = {
  exclusion_list: ['Email;Téléphone', ...[1, 2, 3].map((i) => `${mail(i)};`)].join('\n'),
  gohighlevel: ['Contact Id,First Name,Email,Phone,DND', ...Array.from({ length: 6 }, (_, k) => `g${k},Alix,${mail(k + 11)},,${k < 2 ? 'true' : ''}`)].join('\n'),
  manychat: ['User ID;Instagram Username;Phone;Subscribed', ...Array.from({ length: 4 }, (_, k) => `m${k};insta.exemple${k};${phone(k + 31)};${k < 1 ? 'no' : 'yes'}`)].join('\n'),
};

/** Un faux service D1 de Cloudflare, sur des bases node:sqlite : il répond comme l'API REST `/query`. */
function fakeCloudflare(bases: Record<string, SqliteDatabase>, opts: { noBatch?: boolean; failFirst?: number; limitFirst?: number } = {}) {
  const calls: { db: string; body: string }[] = [];
  let failures = opts.failFirst ?? 0;
  let limited = opts.limitFirst ?? 0;
  const runOne = (raw: SqliteDatabase, sql: string, params: SqlValue[]) => {
    const st = raw.prepare(sql);
    if (/^\s*(SELECT|WITH)\b/i.test(sql)) return { results: st.all(...params).map((r) => ({ ...(r as object) })), meta: { changes: 0 }, success: true };
    const r = st.run(...params) as { changes?: number | bigint };
    return { results: [], meta: { changes: Number(r.changes ?? 0) }, success: true };
  };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const m = /\/accounts\/acc\/d1\/database\/([0-9a-f-]{36})\/query$/.exec(String(url));
    const raw = m ? bases[m[1] as string] : undefined;
    const body = String(init?.body ?? '');
    calls.push({ db: m?.[1] ?? '?', body });
    if ((init?.headers as Record<string, string>)?.authorization !== 'Bearer jeton-de-test') return new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status: 401 });
    if (!raw) return new Response(JSON.stringify({ success: false, errors: [{ code: 7404 }] }), { status: 404 });
    if (limited > 0) {
      limited -= 1;
      return new Response('{}', { status: 429, headers: { 'retry-after': '7' } });
    }
    if (failures > 0) {
      failures -= 1;
      return new Response('{}', { status: 503 });
    }
    const parsed = JSON.parse(body) as { sql?: string; params?: SqlValue[]; batch?: { sql: string; params?: SqlValue[] }[] };
    try {
      if (parsed.batch) {
        if (opts.noBatch) return new Response(JSON.stringify({ success: false, errors: [{ code: 7400 }] }), { status: 400 });
        raw.exec('BEGIN');
        try {
          const out = parsed.batch.map((s) => runOne(raw, s.sql, s.params ?? []));
          raw.exec('COMMIT');
          return new Response(JSON.stringify({ success: true, result: out }));
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        }
      }
      return new Response(JSON.stringify({ success: true, result: [runOne(raw, parsed.sql as string, parsed.params ?? [])] }));
    } catch {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 7500 }] }), { status: 400 });
    }
  }) as typeof fetch;
  return { fetcher, calls };
}

async function world() {
  const site = openMemoryDatabase();
  site.exec(fixture('site-schema.sql'));
  site.exec(fixture('site-colonnes.sql'));
  const compte = site.prepare(
    `INSERT INTO comptes (id, email, mdp, civilite, prenom, nom, telephone, verifie, source, consentement_le, cree_le) VALUES (?, ?, '', 'Mme', 'Prénom', 'Nom', ?, 1, 'site', ?, ?)`,
  );
  for (let i = 1; i <= 20; i++) compte.run(i, mail(i), phone(i), T, T);
  const raw = openMemoryDatabase();
  const db = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  const fiches = new FicheClient(db, { now: () => NOW });
  const net = (await fiches.createNetwork('Réseau test')).id;
  const shawez = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Principal' })).id;
  const journal = new SqlJournalStore(db);
  const direction: Viewer = { role: 'direction', networkId: net, userId: shawez };
  return { site, raw, db, net, shawez, journal, direction };
}

const ENV = { CLOUDFLARE_API_TOKEN: 'jeton-de-test', CLOUDFLARE_ACCOUNT_ID: 'acc', REPRISE_BASE_AIMMO: AIMMO, REPRISE_BASE_SITE: SITE, REPRISE_MINUTES: '5' };
const count = async (db: SqlDatabase, table: string): Promise<number> => Number((await db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n ?? 0);

describeWithSqlite('reprise lancée sur les vraies bases : travail, API D1 et dépôt (I05)', () => {
  it('[R16] [R13] la route de dépôt : direction seule, contenu jamais rendu, état en nombres', async () => {
    const w = await world();
    const routes = repriseRoutes();
    const deposit = routes.find((r) => r.name === 'reprise.depot')!;
    const etat = routes.find((r) => r.name === 'reprise.etat')!;
    const s = { db: w.db, journal: w.journal, now: () => NOW };
    const req = (body: unknown): Request => new Request('https://x/v1/reprise/fichiers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const agent: Viewer = { role: 'agent', networkId: w.net, userId: w.shawez };
    expect((await deposit.handle(s, agent, [], req({ tool: 'manychat', csv: FILES.manychat }))).status).toBe(403);
    expect((await deposit.handle(s, w.direction, [], req({ tool: 'manychat', csv: FILES.manychat, autre: 1 }))).status).toBe(400);
    const ok = await deposit.handle(s, w.direction, [], req({ tool: 'manychat', csv: FILES.manychat }));
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).not.toMatch(/insta\.exemple|06 10/);
    expect(JSON.parse(text)).toMatchObject({ ok: true, data: { tool: 'manychat', lines: 4 } });
    const state = await (await etat.handle(s, w.direction, [], new Request('https://x/v1/reprise/etat'))).json();
    expect(state).toMatchObject({ ok: true, data: { depots: { manychat: { lines: 4 } }, progress: null } });
    expect((await etat.handle(s, agent, [], new Request('https://x/v1/reprise/etat'))).status).toBe(403);
  });

  it('[R17] [R02] [R04] le travail fait la reprise par l\'API D1 : site en lecture seule, contrôle vert, sortie en nombres', async () => {
    const w = await world();
    const depots = new DepotsReprise(w.db, w.journal, { now: () => NOW });
    for (const [tool, csv] of Object.entries(FILES)) expect((await depots.deposit(w.direction, { tool, csv })).ok).toBe(true);
    const before = JSON.stringify(w.site.prepare('SELECT * FROM comptes').all());
    const cf = fakeCloudflare({ [AIMMO]: w.raw, [SITE]: w.site });
    const out: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = cf.fetcher;
    try {
      expect(await main(ENV, (t) => out.push(t))).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(out.join('\n')).toMatch(/contrôle vert/);
    expect(out.join('\n')).not.toMatch(/example\.org|06 10|insta\.exemple|Alix|Prénom/);
    // 20 comptes du site ; la liste recoupe 3 comptes ; GoHighLevel en recoupe 6 (11 à 16) ; ManyChat ajoute 4 personnes.
    expect(await count(w.db, 'persons')).toBe(24);
    expect(JSON.stringify(w.site.prepare('SELECT * FROM comptes').all())).toBe(before);
    // Rien d'autre qu'une lecture n'a été envoyé à la base du site.
    const siteBodies = cf.calls.filter((c) => c.db === SITE).map((c) => JSON.parse(c.body) as { sql?: string; batch?: unknown });
    expect(siteBodies.length).toBeGreaterThan(0);
    expect(siteBodies.every((b) => b.batch === undefined && /^\s*(SELECT|WITH)\b/i.test(b.sql ?? ''))).toBe(true);
  });

  it('[R02] sans lot pris en charge par l\'API, rien n\'est écrit', async () => {
    const w = await world();
    const cf = fakeCloudflare({ [AIMMO]: w.raw, [SITE]: w.site }, { noBatch: true });
    const origFetch = globalThis.fetch;
    globalThis.fetch = cf.fetcher;
    try {
      await expect(main(ENV, () => undefined)).rejects.toThrow(D1RestError);
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(await count(w.db, 'persons')).toBe(0);
    expect(await count(w.db, 'journal')).toBe(0);
  });

  it('sans les trois fichiers, le travail s\'arrête sans rien reprendre', async () => {
    const w = await world();
    const cf = fakeCloudflare({ [AIMMO]: w.raw, [SITE]: w.site });
    const out: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = cf.fetcher;
    try {
      expect(await main(ENV, (t) => out.push(t))).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(out.join('')).toMatch(/aucun fichier déposé/);
    expect(await count(w.db, 'persons')).toBe(0);
  });

  it('une lecture est refaite après une panne passagère ; une écriture seulement après un refus de la limite', async () => {
    const w = await world();
    const waits: number[] = [];
    const read = fakeCloudflare({ [AIMMO]: w.raw }, { failFirst: 2 });
    const db = d1Rest({ accountId: 'acc', databaseId: AIMMO, token: 'jeton-de-test', fetch: read.fetcher, wait: async (ms) => void waits.push(ms) });
    expect(await db.first<{ n: number }>('SELECT count(*) AS n FROM networks')).toEqual({ n: 1 });
    expect(waits).toEqual([500, 1000]);
    const write = fakeCloudflare({ [AIMMO]: w.raw }, { failFirst: 1 });
    const db2 = d1Rest({ accountId: 'acc', databaseId: AIMMO, token: 'jeton-de-test', fetch: write.fetcher, wait: async () => undefined });
    await expect(db2.run("INSERT INTO networks (id, name, created_at) VALUES ('n2', 'Autre', ?)", [T])).rejects.toThrow(/HTTP 503/);
    expect(write.calls).toHaveLength(1);
    expect(await count(w.db, 'networks')).toBe(1);
    // Un refus de la limite de l'API n'a rien exécuté : l'écriture est refaite après l'attente demandée.
    const limitedWaits: number[] = [];
    const lim = fakeCloudflare({ [AIMMO]: w.raw }, { limitFirst: 2 });
    const db3 = d1Rest({ accountId: 'acc', databaseId: AIMMO, token: 'jeton-de-test', fetch: lim.fetcher, wait: async (ms) => void limitedWaits.push(ms) });
    expect(await db3.run("INSERT INTO networks (id, name, created_at) VALUES ('n3', 'Autre', ?)", [T])).toEqual({ changes: 1 });
    expect(limitedWaits).toEqual([7000, 7000]);
    expect(await count(w.db, 'networks')).toBe(2);
  });

  it('[R13] une erreur de D1 ne cite ni la requête ni ses valeurs', async () => {
    const w = await world();
    const cf = fakeCloudflare({ [AIMMO]: w.raw });
    const db = d1Rest({ accountId: 'acc', databaseId: AIMMO, token: 'jeton-de-test', fetch: cf.fetcher });
    const error = await db.run('INSERT INTO table_absente VALUES (?)', [mail(1)]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(D1RestError);
    expect(String((error as Error).message)).not.toMatch(/example|table_absente/);
    expect(safeMessage(error)).toMatch(/^D1 : requête refusée/);
    expect(safeMessage(new Error(`contact ${mail(1)} illisible`))).toBe('Erreur Error (détail masqué).');
    await expect(checkBatch(db)).resolves.toBeUndefined();
  });

  it('la configuration du travail est vérifiée avant toute lecture', () => {
    expect(() => readEnv({ ...ENV, CLOUDFLARE_API_TOKEN: '' })).toThrow(/H04/);
    expect(() => readEnv({ ...ENV, REPRISE_BASE_SITE: '' })).toThrow(/espace-estimation introuvable/);
    expect(() => readEnv({ ...ENV, REPRISE_BASE_SITE: AIMMO })).toThrow(/même/);
    expect(readEnv(ENV).minutes).toBe(5);
    expect(summary({ state: 'stopped', code: 'missing_files' })).toMatch(/il manque un des trois fichiers/);
  });

  it('le travail GitHub : lancé à la main depuis main, base du site trouvée par son nom, secrets jamais affichés', () => {
    const yml = readFileSync(new URL('../../../.github/workflows/reprise.yml', import.meta.url), 'utf8');
    expect(yml).toMatch(/workflow_dispatch:/);
    expect(yml).not.toMatch(/\n\s+push:|schedule:|pull_request/);
    expect(yml).toMatch(/github\.ref == 'refs\/heads\/main'/);
    expect(yml).toMatch(/find_id espace-estimation/);
    expect(yml).toMatch(/find_id aimmo/);
    expect(yml).toMatch(/d\.name === process\.env\.NAME/);
    expect(yml).toMatch(/node --experimental-transform-types --no-warnings packages\/api\/outils\/reprise\.ts/);
    expect(yml).not.toMatch(/echo .*CLOUDFLARE_API_TOKEN|set -x/);
  });

  it('l\'écran du réseau porte le dépôt des trois fichiers, étiquetés, et n\'affiche que des nombres', () => {
    for (const tool of ['exclusion_list', 'gohighlevel', 'manychat']) {
      // DS069 : l'écran du réseau est dans la page de la direction, plus dans celle de l'agent.
      expect(RESEAU_PAGE_HTML).toContain(`<label for="reprise-${tool}">`);
      expect(RESEAU_PAGE_HTML).toContain(`<input id="reprise-${tool}" type="file"`);
      expect(INDEX_HTML).not.toContain(`id="reprise-${tool}"`);
    }
    expect(REPRISE_SCRIPT).toContain("send('/v1/reprise/fichiers', 'POST', { tool: t.id, csv: csv })");
    // Le fichier n'est jamais gardé sur l'appareil.
    expect(REPRISE_SCRIPT).toContain('function depositReprise');
    expect(REPRISE_JS + REPRISE_SCRIPT).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });
});
