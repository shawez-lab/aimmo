import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import type { Geocoded } from '../../core/src/estimation/collecte.ts';
import type { Sale } from '../../core/src/estimation/fourchette.ts';
import type { ScoreServices } from '../../core/src/score-adresse/index.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../../core/src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, adresses, diagnostics, ventes et clés d'API inventés. Le lundi 7 décembre 2026, à 9 h à Paris.
const MONDAY_9H = Date.parse('2026-12-07T08:00:00.000Z');
const KEYS = {
  alex: 'test-cle-br27-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br27-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br27-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br27-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

// Environ 0,0009 degré de latitude font 100 m.
const sale = (i: number, kind: 'apartment' | 'house', dLat: number): Sale => ({ id: `t:${i}`, kind, lat: 47.33 + dLat, lon: 5.01, surface: 60, pricePerM2: 2500, month: '2024-05' });

/** Des sources publiques inventées, qui rendent aussi des champs de personne : ils ne doivent jamais sortir [R291]. */
function fakeSources(calls: string[]): ScoreServices {
  return {
    geocoder: {
      geocode: async (a) => {
        calls.push(a);
        if (/Dijon/i.test(a)) return { label: '3 Rue des Essais 21000 Dijon', lat: 47.32, lon: 5.04, postalCode: '21000', inseeCode: '21231', town: 'Dijon', banId: '21231_0002_00003', score: 0.95 } as Geocoded;
        return { label: '7 Rue des Essais 21240 Talant', lat: 47.33, lon: 5.01, postalCode: '21240', inseeCode: '21617', town: 'Talant', banId: '21617_0001_00007', score: 0.95, owner: 'Jean Essai' } as Geocoded;
      },
    },
    cadastre: { parcelAt: async () => ({ id: '21617000AB0042', section: 'AB', number: '0042', area: 1800, proprietaire: 'Jean Essai' }) as never },
    energy: { latestFor: async () => ({ energyClass: 'F', ghgClass: 'E', date: '2026-11-20', diagnosisNumber: '2621E0000002T', nom_proprietaire: 'Jean Essai', telephone: '0600000000' }) as never },
    sales: {
      coverage: async () => ({ department: '21', lastSale: '2025-12-31', years: [2021, 2022, 2023, 2024, 2025], source: 'DVF (DGFiP), fichiers du site' }),
      scan: async (kind) => ({ sales: Array.from({ length: kind === 'house' ? 15 : 35 }, (_, i) => sale(i, kind, i % 2 === 0 ? 0.0013 : -0.0013)), issues: 0 }),
    },
  };
}

async function setup(withSources = true) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_9H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const zone = (agentId: string, commune: string) =>
    db.run("INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at, ended_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', NULL)", [crypto.randomUUID(), network.id, agentId, commune]);
  await zone(alex.id, 'Talant');
  await zone(sam.id, 'Chenôve');
  const calls: string[] = [];
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: alex.id },
    sam: { role: 'agent', userId: sam.id },
    direction: { role: 'direction', userId: 'direction-1' },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network.id, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now, ...(withSources ? { scoreSources: fakeSources(calls) } : {}) };
  const send = async (who: Who, method: string, path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    return handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config);
  };
  const http = async (who: Who, method: string, path: string, body?: unknown, raw?: string) => {
    const r = await send(who, method, path, body, raw);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; mode?: string; field?: string } };
  };
  let n = 0;
  const mandate = async (agentId: string, city: string, signedAt: number) => {
    n += 1;
    const seller = await store.createPerson({ networkId: network.id, agentId, firstName: 'Vera', lastName: `Vendeuse${n}` });
    const property = await store.createProperty({ networkId: network.id, agentId, reference: `B${n}`, kind: 'home', city, priceEur: 200_000, surfaceM2: 80, rooms: 4, status: 'available' });
    const id = `m${n}`;
    const at = new Date(signedAt).toISOString();
    await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'neighbourhood_letter', 'test', ?)", [id, network.id, agentId, seller.id, property.id, at, at]);
    return id;
  };
  const refusals = async () => (await journal.all()).filter((e) => e.type === 'acces.refuse');
  const count = async () => Number((await db.first<{ n: number }>('SELECT count(*) AS n FROM address_scores'))!.n);
  return { db, journal, config, http, calls, mandate, refusals, count, alex, sam, setClock: (t: number) => (clock = t) };
}

/** Une requête dont le corps ne doit pas être lu : s'il l'était avant le rôle, la route ne répondrait pas 403. */
function untouchable(url: string, init: RequestInit): Request {
  const r = new Request(url, init);
  Object.defineProperty(r, 'text', { value: () => Promise.reject(new Error('corps lu avant le contrôle du rôle')) });
  Object.defineProperty(r, 'json', { value: () => Promise.reject(new Error('corps lu avant le contrôle du rôle')) });
  return r;
}

describeWithSqlite('BR27 · routes du score de vente par adresse', () => {
  it('[R16] chaque route refuse le mauvais rôle en 403, au journal, avant toute lecture du corps', async () => {
    const t = await setup();
    const cases: [Who, string, string][] = [
      ['direction', 'POST', '/score-adresse/scores'],
      ['conformite', 'POST', '/score-adresse/scores'],
      ['conformite', 'GET', '/score-adresse/scores'],
      ['conformite', 'POST', '/score-adresse/scores/score-1/mandat'],
      ['conformite', 'GET', '/score-adresse/mesure'],
    ];
    for (const [who, method, path] of cases) {
      const before = (await t.refusals()).length;
      const r = await t.http(who, method, path, undefined, method === 'POST' ? 'pas du json' : undefined);
      expect(r.status, `${who} ${method} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
      expect((await t.refusals()).length, `${who} ${method} ${path}`).toBe(before + 1);
      if (method === 'POST') {
        const req = untouchable(`https://aimmo-api.example.test/v1${path}`, { method, headers: { authorization: `Bearer ${KEYS[who]}`, 'content-type': 'application/json' }, body: '{}' });
        expect((await handleRequest(req, t.config)).status, `${who} ${method} ${path} (corps)`).toBe(403);
      }
    }
    // Une fois par GET, deux fois par POST (corps mal formé, puis corps qui n'est pas lu).
    expect((await t.refusals()).filter((e) => e.data.kind === 'score_adresse').length).toBe(8);
    expect(t.calls).toEqual([]);
    expect(await t.count()).toBe(0);
  });

  it('[R291] chaque point rendu cite sa source et sa date ; noté de nouveau le même jour, le même score est rendu', async () => {
    const t = await setup();
    const a = await t.http('alex', 'POST', '/score-adresse/scores', { address: '7 rue des Essais, Talant' });
    expect(a.status).toBe(200);
    expect(a.body.mode).toBe('essai');
    const v = a.body.data;
    expect(v.points.map((p: { signal: string }) => p.signal)).toEqual(['diagnostic_recent', 'interdiction_louer', 'ventes_voisinage', 'grande_parcelle']);
    for (const p of v.points as { source: string; date: string; fact: string }[]) {
      expect(p.source.length).toBeGreaterThan(3);
      expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.fact.length).toBeGreaterThan(10);
    }
    expect(v.band).toBe('tres_fort');
    // Aucune donnée de personne rendue par une source ne sort de la route [R291, R13].
    expect(JSON.stringify(a.body)).not.toMatch(/Jean Essai|0600000000|proprietaire|owner/);
    const b = await t.http('alex', 'POST', '/score-adresse/scores', { address: '7 rue des Essais, Talant' });
    expect(b.body.data).toEqual(v);
    expect(await t.count()).toBe(1);
    const list = await t.http('alex', 'GET', '/score-adresse/scores');
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([v]);
    // La direction lit tout le réseau ; l'agent d'une autre zone ne lit rien.
    expect((await t.http('direction', 'GET', '/score-adresse/scores')).body.data).toHaveLength(1);
    expect((await t.http('sam', 'GET', '/score-adresse/scores')).body.data).toEqual([]);
  });

  it('[R292] une adresse avec un nom ou hors des zones de l’agent est refusée, rien n’est rangé', async () => {
    const t = await setup();
    const named = await t.http('alex', 'POST', '/score-adresse/scores', { address: '7 rue des Essais, chez Monsieur Essai, Talant' });
    expect(named.status).toBe(409);
    expect(named.body).toMatchObject({ ok: false, rule: 'R292', code: 'nom_dans_adresse' });
    const before = (await t.refusals()).length;
    const away = await t.http('alex', 'POST', '/score-adresse/scores', { address: '3 rue des Essais, Dijon' });
    expect(away.status).toBe(403);
    expect(away.body).toMatchObject({ ok: false, rule: 'R16', code: 'hors_zone' });
    expect((await t.refusals()).length).toBe(before + 1);
    expect(await t.count()).toBe(0);
  });

  it('[R293] un mandat signé se relie une fois ; la mesure par tranche ne porte ni adresse ni nom', async () => {
    const t = await setup();
    const scored = (await t.http('alex', 'POST', '/score-adresse/scores', { address: '7 rue des Essais, Talant' })).body.data;
    const good = await t.mandate(t.alex.id, 'Talant', MONDAY_9H + 30 * 86_400_000);
    const path = `/score-adresse/scores/${scored.scoreId}/mandat`;
    // L'agent qui n'a pas signé le mandat est refusé, au journal.
    expect((await t.http('sam', 'POST', path, { mandateId: good })).body).toMatchObject({ rule: 'R16', code: 'pas_son_mandat' });
    const linked = await t.http('alex', 'POST', path, { mandateId: good });
    expect(linked.status).toBe(200);
    const again = await t.http('direction', 'POST', path, { mandateId: good });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ rule: 'R293', code: 'deja_relie' });
    expect((await t.http('alex', 'POST', '/score-adresse/scores/inconnu/mandat', { mandateId: good })).status).toBe(404);
    expect((await t.http('alex', 'POST', path, { mandateId: 'inconnu' })).status).toBe(404);
    const m = await t.http('direction', 'GET', '/score-adresse/mesure');
    expect(m.status).toBe(200);
    expect(m.body.data.map((b: { band: string }) => b.band)).toEqual(['faible', 'moyen', 'fort', 'tres_fort']);
    expect(m.body.data[3]).toMatchObject({ scored: 1, signed: 1, closed: 0, rate: null });
    expect(JSON.stringify(m.body)).not.toMatch(/Essais|Talant|Vera|Vendeuse/);
    expect((await t.http('alex', 'GET', '/score-adresse/mesure')).status).toBe(200);
  });

  it('sans sources publiques, aucune adresse ne se note et rien n’est rangé', async () => {
    const t = await setup(false);
    const r = await t.http('alex', 'POST', '/score-adresse/scores', { address: '7 rue des Essais, Talant' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, rule: null, code: 'sources_absentes' });
    expect(await t.count()).toBe(0);
    // Les lectures restent ouvertes.
    expect((await t.http('alex', 'GET', '/score-adresse/scores')).body.data).toEqual([]);
  });

  it('corps mal formé, champ ou paramètre non prévu : 400 sans rien ranger', async () => {
    const t = await setup();
    expect((await t.http('alex', 'POST', '/score-adresse/scores', undefined, 'pas du json')).body).toMatchObject({ code: 'invalid_body' });
    expect((await t.http('alex', 'POST', '/score-adresse/scores', undefined, '[1]')).status).toBe(400);
    const extra = await t.http('alex', 'POST', '/score-adresse/scores', { address: '7 rue des Essais, Talant', owner: 'Jean Essai' });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({ code: 'unknown_field', field: 'owner' });
    expect((await t.http('alex', 'POST', '/score-adresse/scores', { address: 7 })).body).toMatchObject({ code: 'bad_address' });
    expect((await t.http('alex', 'POST', '/score-adresse/scores', undefined, JSON.stringify({ address: 'x'.repeat(3000) }))).body).toMatchObject({ code: 'invalid_body' });
    expect((await t.http('alex', 'GET', '/score-adresse/scores?agent=sam')).body).toMatchObject({ code: 'unknown_field', field: 'agent' });
    expect((await t.http('alex', 'POST', '/score-adresse/scores?x=1', { address: '7 rue des Essais, Talant' })).body).toMatchObject({ code: 'unknown_field', field: 'x' });
    expect((await t.http('alex', 'POST', '/score-adresse/scores/s1/mandat', { mandateId: 12 })).body).toMatchObject({ code: 'bad_mandate' });
    expect(t.calls).toEqual([]);
    expect(await t.count()).toBe(0);
  });
});
