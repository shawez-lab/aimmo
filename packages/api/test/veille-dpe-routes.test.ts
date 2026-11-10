import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runScheduler } from '../src/planificateur.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../../core/src/index.ts';
import type { DiagnosisFeed } from '../../core/src/veille-dpe/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, diagnostics, adresses et clés d'API inventés. Le lundi 7 décembre 2026, à 7 h à Paris.
const SEVEN_PARIS = Date.parse('2026-12-07T06:00:00.000Z');
const KEYS = {
  alex: 'test-cle-br26-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br26-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br26-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br26-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

let seq = 0;
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    numero_dpe: `2621E${String(2_000_000 + seq)}T`,
    date_etablissement_dpe: '2026-12-01',
    date_reception_dpe: '2026-12-02',
    etiquette_dpe: 'G',
    etiquette_ges: 'F',
    type_batiment: 'appartement',
    surface_habitable_logement: 38,
    numero_voie_ban: '5',
    nom_rue_ban: 'Rue des Essais',
    code_postal_ban: '21240',
    nom_commune_ban: 'Talant',
    _geopoint: '47.33,5.01',
    ...over,
  };
}

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = SEVEN_PARIS;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const zone = (agentId: string, commune: string) =>
    db.run("INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at, ended_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', NULL)", [crypto.randomUUID(), network.id, agentId, commune]);
  await zone(alex.id, 'Talant');
  await zone(sam.id, 'Dijon');
  // La source : chaque code postal rend ses lignes ; les demandes sont notées.
  const byPostcode = new Map<string, Record<string, unknown>[]>();
  const calls: { postcode: string; since: string }[] = [];
  const feed: DiagnosisFeed = {
    recent: async (q) => {
      calls.push(q);
      return byPostcode.get(q.postcode) ?? [];
    },
  };
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: alex.id },
    sam: { role: 'agent', userId: sam.id },
    direction: { role: 'direction', userId: 'direction-1' },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network.id, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now };
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
  const tick = () => runScheduler({ db, mode: 'essai', now, dpeFeed: feed });
  const refusals = async () => (await journal.all()).filter((e) => e.type === 'acces.refuse');
  const count = async (table: string) => Number((await db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n);
  return { db, journal, network, alex, sam, config, send, http, tick, calls, set: (pc: string, rows: Record<string, unknown>[]) => byPostcode.set(pc, rows), refusals, count, setClock: (t: number) => (clock = t) };
}

/** Une requête dont le corps ne doit pas être lu : s'il l'était avant le rôle, la route ne répondrait pas 403. */
function untouchable(url: string, init: RequestInit): Request {
  const r = new Request(url, init);
  Object.defineProperty(r, 'text', { value: () => Promise.reject(new Error('corps lu avant le contrôle du rôle')) });
  Object.defineProperty(r, 'json', { value: () => Promise.reject(new Error('corps lu avant le contrôle du rôle')) });
  return r;
}

describeWithSqlite('BR26 · routes de la veille des diagnostics énergétiques', () => {
  it('[R16] chaque route refuse le mauvais rôle en 403, au journal, avant toute lecture du corps', async () => {
    const t = await setup();
    const cases: [Who, string, string][] = [
      ['direction', 'GET', '/veille-dpe/secteurs'],
      ['conformite', 'GET', '/veille-dpe/secteurs'],
      ['direction', 'POST', '/veille-dpe/secteurs'],
      ['conformite', 'POST', '/veille-dpe/secteurs/secteur-1/fermeture'],
      ['direction', 'GET', '/veille-dpe/alertes'],
      ['conformite', 'GET', '/veille-dpe/carte'],
      ['direction', 'POST', '/veille-dpe/diagnostics/dpe-1/lettre'],
      ['conformite', 'GET', '/veille-dpe/lettres/lettre-1'],
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
    expect((await t.refusals()).filter((e) => e.data.kind === 'veille_dpe').length).toBe(11);
  });

  it('[R289] un secteur ne s’ouvre que sur une commune des zones de l’agent ; il se lit et se ferme par son agent seul', async () => {
    const t = await setup();
    const out = await t.http('alex', 'POST', '/veille-dpe/secteurs', { commune: 'Dijon', postcode: '21000' });
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ rule: 'R289', code: 'hors_zone' });
    const ok = await t.http('alex', 'POST', '/veille-dpe/secteurs', { commune: 'Talant', postcode: '21240' });
    expect(ok.status, ok.body.code).toBe(200);
    expect(ok.body.mode).toBe('essai');
    const sectorId = ok.body.data.sectorId as string;
    expect((await t.http('alex', 'POST', '/veille-dpe/secteurs', { commune: 'Talant', postcode: '21240' })).body.code).toBe('deja_suivi');
    expect((await t.http('alex', 'GET', '/veille-dpe/secteurs')).body.data).toEqual([{ sectorId, commune: 'Talant', postcode: '21240', inZone: true }]);
    expect((await t.http('sam', 'GET', '/veille-dpe/secteurs')).body.data).toEqual([]);
    // Sam ne ferme pas le secteur d'Alex : refus au journal [R16].
    const before = (await t.refusals()).length;
    const other = await t.http('sam', 'POST', `/veille-dpe/secteurs/${sectorId}/fermeture`, {});
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('pas_son_secteur');
    expect((await t.refusals()).length).toBe(before + 1);
    expect((await t.http('alex', 'POST', '/veille-dpe/secteurs/inconnu/fermeture', {})).status).toBe(404);
    expect((await t.http('alex', 'POST', `/veille-dpe/secteurs/${sectorId}/fermeture`, {})).status).toBe(200);
    expect((await t.http('alex', 'POST', `/veille-dpe/secteurs/${sectorId}/fermeture`, {})).body.code).toBe('deja_ferme');
    expect((await t.http('alex', 'GET', '/veille-dpe/secteurs')).body.data).toEqual([]);
  });

  it('[R288] [R289] le passage du planificateur range chaque diagnostic une seule fois, dans l’alerte de la seule commune suivie', async () => {
    const t = await setup();
    await t.http('alex', 'POST', '/veille-dpe/secteurs', { commune: 'Talant', postcode: '21240' });
    const g = row();
    const c = row({ etiquette_dpe: 'C' });
    const ailleurs = row({ nom_commune_ban: 'Daix' });
    const nom = row({ nom_rue_ban: 'Chez Martin Rue des Essais' });
    t.set('21240', [g, c, ailleurs, nom]);
    await t.tick();
    // Seuls le code postal et le jour partent vers la source.
    expect(t.calls).toEqual([{ postcode: '21240', since: '2026-11-30' }]);
    expect(await t.count('dpe_diagnoses')).toBe(2);
    const alerts = await t.http('alex', 'GET', '/veille-dpe/alertes');
    expect(alerts.status, alerts.body.code).toBe(200);
    expect(alerts.body.data).toHaveLength(1);
    expect(alerts.body.data[0]).toMatchObject({ commune: 'Talant', postcode: '21240', day: '2026-12-07' });
    expect(alerts.body.data[0].items.map((i: { number: string }) => i.number).sort()).toEqual([g.numero_dpe, c.numero_dpe].sort());
    expect(JSON.stringify(alerts.body)).not.toMatch(/Martin|Daix/);
    // Sam, sans secteur sur Talant, n'a pas d'alerte.
    expect((await t.http('sam', 'GET', '/veille-dpe/alertes')).body.data).toEqual([]);
    // Le lendemain, la source rend encore les mêmes : rien ne remonte deux fois.
    t.setClock(SEVEN_PARIS + 24 * 3_600_000);
    await t.tick();
    expect(await t.count('dpe_diagnoses')).toBe(2);
    expect((await t.http('alex', 'GET', '/veille-dpe/alertes')).body.data).toEqual([]);
    expect((await t.http('alex', 'GET', '/veille-dpe/alertes?day=2026-12-07')).body.data[0].items).toHaveLength(2);
    // Un jour mal écrit, ou un paramètre non prévu : 400.
    expect((await t.http('alex', 'GET', '/veille-dpe/alertes?day=07-12-2026')).body).toMatchObject({ code: 'bad_day' });
    expect((await t.http('alex', 'GET', '/veille-dpe/alertes?jour=2026-12-07')).body).toMatchObject({ code: 'unknown_field', field: 'jour' });
  });

  it('[R289] la carte : l’agent ses seules communes, la direction tout le réseau, avec la date d’interdiction de louer', async () => {
    const t = await setup();
    await t.http('alex', 'POST', '/veille-dpe/secteurs', { commune: 'Talant', postcode: '21240' });
    await t.http('sam', 'POST', '/veille-dpe/secteurs', { commune: 'Dijon', postcode: '21000' });
    t.set('21240', [row(), row({ etiquette_dpe: 'B' })]);
    t.set('21000', [row({ code_postal_ban: '21000', nom_commune_ban: 'Dijon', etiquette_dpe: 'F' })]);
    await t.tick();
    const alex = await t.http('alex', 'GET', '/veille-dpe/carte');
    expect(alex.status, alex.body.code).toBe(200);
    expect(alex.body.data.map((p: { address: { commune: string } }) => p.address.commune)).toEqual(['Talant', 'Talant']);
    const g = alex.body.data.find((p: { energyClass: string }) => p.energyClass === 'G');
    expect(g.rentBanFrom).toBe('2025-01-01');
    expect((await t.http('alex', 'GET', '/veille-dpe/carte?classes=G')).body.data).toHaveLength(1);
    expect((await t.http('alex', 'GET', '/veille-dpe/carte?commune=Dijon')).body).toMatchObject({ rule: 'R289', code: 'hors_zone' });
    expect((await t.http('alex', 'GET', '/veille-dpe/carte?classes=H')).body).toMatchObject({ code: 'bad_classes' });
    expect((await t.http('alex', 'GET', '/veille-dpe/carte?rayon=3')).body).toMatchObject({ code: 'unknown_field', field: 'rayon' });
    const direction = await t.http('direction', 'GET', '/veille-dpe/carte');
    expect(direction.body.data.map((p: { address: { commune: string } }) => p.address.commune).sort()).toEqual(['Dijon', 'Talant', 'Talant']);
  });

  it('[R290] la lettre « Au propriétaire » : un F ou un G de sa zone, une seule, sans aucun nom, imprimée par son agent ou la direction', async () => {
    const t = await setup();
    await t.http('alex', 'POST', '/veille-dpe/secteurs', { commune: 'Talant', postcode: '21240' });
    t.set('21240', [row(), row({ etiquette_dpe: 'D' })]);
    await t.tick();
    const points = (await t.http('alex', 'GET', '/veille-dpe/carte')).body.data as { diagnosisId: string; energyClass: string }[];
    const g = points.find((p) => p.energyClass === 'G')!;
    const d = points.find((p) => p.energyClass === 'D')!;
    expect((await t.http('alex', 'POST', `/veille-dpe/diagnostics/${d.diagnosisId}/lettre`, {})).body).toMatchObject({ rule: 'R290', code: 'classe_sans_lettre' });
    // Sam n'a pas Talant dans ses zones : refus au journal.
    const before = (await t.refusals()).length;
    const sam = await t.http('sam', 'POST', `/veille-dpe/diagnostics/${g.diagnosisId}/lettre`, {});
    expect(sam.status).toBe(403);
    expect(sam.body.code).toBe('hors_zone');
    expect((await t.refusals()).length).toBe(before + 1);
    // Un champ en plus (un nom à chercher) est refusé, rien n'est rangé.
    const named = await t.http('alex', 'POST', `/veille-dpe/diagnostics/${g.diagnosisId}/lettre`, { ownerName: 'Jean Essai' });
    expect(named.body).toMatchObject({ code: 'unknown_field', field: 'ownerName' });
    expect(await t.count('dpe_letters')).toBe(0);
    const letter = await t.http('alex', 'POST', `/veille-dpe/diagnostics/${g.diagnosisId}/lettre`, {});
    expect(letter.status, letter.body.code).toBe(200);
    expect(letter.body.data.bannedFrom).toBe('2025-01-01');
    expect((await t.http('alex', 'POST', `/veille-dpe/diagnostics/${g.diagnosisId}/lettre`, {})).body.code).toBe('deja_preparee');
    expect((await t.http('alex', 'POST', '/veille-dpe/diagnostics/inconnu/lettre', {})).status).toBe(404);
    const letterId = letter.body.data.letterId as string;
    const print = await t.send('alex', 'GET', `/veille-dpe/lettres/${letterId}`);
    expect(print.status).toBe(200);
    expect(print.headers.get('content-type')).toMatch(/^text\/html/);
    expect(print.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const html = await print.text();
    expect(html).toContain('Rue des Essais');
    expect(html).not.toMatch(/Jean Essai/);
    expect((await t.send('direction', 'GET', `/veille-dpe/lettres/${letterId}`)).status).toBe(200);
    const other = await t.http('sam', 'GET', `/veille-dpe/lettres/${letterId}`);
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('pas_sa_lettre');
    expect((await t.http('alex', 'GET', '/veille-dpe/lettres/inconnue')).status).toBe(404);
  });

  it('corps mal formé ou champ non prévu : 400, rien n’est rangé', async () => {
    const t = await setup();
    expect((await t.http('alex', 'POST', '/veille-dpe/secteurs', undefined, 'pas du json')).body).toMatchObject({ code: 'invalid_body' });
    expect((await t.http('alex', 'POST', '/veille-dpe/secteurs', undefined, '[1]')).body).toMatchObject({ code: 'invalid_body' });
    expect((await t.http('alex', 'POST', '/veille-dpe/secteurs', { commune: 'Talant', postcode: '21240', proprietaire: 'x' })).body).toMatchObject({ code: 'unknown_field', field: 'proprietaire' });
    expect((await t.http('alex', 'POST', '/veille-dpe/secteurs', { commune: 'Talant', postcode: '2124' })).body).toMatchObject({ code: 'bad_postcode' });
    expect((await t.http('alex', 'POST', '/veille-dpe/secteurs', undefined, JSON.stringify({ commune: 'x'.repeat(3_000), postcode: '21240' }))).body).toMatchObject({ code: 'invalid_body' });
    expect(await t.count('dpe_watch_sectors')).toBe(0);
  });

  it('[R13] le journal ne garde aucune adresse de diagnostic', async () => {
    const t = await setup();
    await t.http('alex', 'POST', '/veille-dpe/secteurs', { commune: 'Talant', postcode: '21240' });
    t.set('21240', [row({ nom_rue_ban: 'Allée des Tilleuls Inventés' })]);
    await t.tick();
    const [p] = (await t.http('alex', 'GET', '/veille-dpe/carte')).body.data as { diagnosisId: string }[];
    const l = await t.http('alex', 'POST', `/veille-dpe/diagnostics/${p!.diagnosisId}/lettre`, {});
    await t.send('alex', 'GET', `/veille-dpe/lettres/${l.body.data.letterId}`);
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Tilleuls/);
  });
});
