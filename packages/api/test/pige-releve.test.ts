import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runScheduler } from '../src/planificateur.ts';
import { pigeProvider, pigeSourceOf } from '../src/worker.ts';
import { HttpPigeSource, PIGE_COLLECT_JOB, PigeSourceError, missingPigeSettings, type PigeFetcher, type PigeProviderSettings } from '../../core/src/pige/index.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../../core/src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// AU034 · La relève de la pige par un vrai fournisseur. Le lundi 7 décembre 2026 ; réseau, agents, annonces, adresse du
// fournisseur et clés inventés.
const MONDAY_6H = Date.parse('2026-12-07T05:05:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PROVIDER_URL = 'https://pige.fournisseur.example.test/v1/annonces';
const PROVIDER_TOKEN = 'cle-fournisseur-inventee-0123456789';
const KEYS = {
  alex: 'test-cle-au034-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  direction: 'test-cle-au034-direction-cccccccccccccccccccc',
  conformite: 'test-cle-au034-conformite-dddddddddddddddddd',
};
type Who = keyof typeof KEYS;

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Un faux fournisseur, qui répond par pages ; `fail` force une panne. */
function fakeProvider(now: () => Date) {
  const calls: Call[] = [];
  let fail: null | 'http401' | 'http503' | 'json' | 'reseau' = null;
  let n = 0;
  const ad = (over: Record<string, unknown> = {}) => {
    n += 1;
    return {
      source: 'Site A',
      sourceRef: `a-${n}`,
      kind: 'house',
      commune: 'Talant',
      postalCode: '21240',
      surfaceM2: 90 + n * 5,
      rooms: 4,
      priceEur: 279_000,
      publishedAt: new Date(now().getTime() - DAY).toISOString(),
      text: 'Belle maison, appelez Jean Particulier au 06 00 00 00 01.',
      ...over,
    };
  };
  const fetcher: PigeFetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (fail === 'reseau') throw new Error(`connexion coupée vers ${PROVIDER_URL}?token=${PROVIDER_TOKEN}`);
    if (fail === 'http401') return { ok: false, status: 401, json: async () => ({}) };
    if (fail === 'http503') return { ok: false, status: 503, json: async () => ({}) };
    if (fail === 'json') return { ok: true, status: 200, json: async () => { throw new SyntaxError('pas du json'); } };
    const u = new URL(url);
    if (u.searchParams.get('page') === '2') return { ok: true, status: 200, json: async () => ({ ads: [ad({ commune: 'Lyon', postalCode: '69001' })] }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ ads: [ad(), ad({ noAgency: true }), ad({ text: 'Vente entre particuliers uniquement, pas d’agence.' })], next: `${PROVIDER_URL}?page=2` }),
    };
  };
  return { fetcher, calls, setFail: (f: typeof fail) => { fail = f; } };
}

async function setup(options: { provider?: Partial<PigeProviderSettings> | null } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_6H;
  const now = () => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const net = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: net.id, firstName: 'Alex', lastName: 'Agent' });
  await db.run("INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at, ended_at) VALUES (?, ?, ?, 'Talant', '2026-01-01T00:00:00.000Z', NULL)", [crypto.randomUUID(), net.id, alex.id]);
  const fake = fakeProvider(now);
  const settings: PigeProviderSettings | null =
    options.provider === null ? null : { url: PROVIDER_URL, token: PROVIDER_TOKEN, networkId: net.id, ...(options.provider ?? {}) };
  const wired = settings ? pigeSourceOf(settings, fake.fetcher) : null;
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: alex.id },
    direction: { role: 'direction', userId: 'direction-1' },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const keys = async (networkId: string) =>
    Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId, ...ids[w] })));
  let apiKeys = JSON.stringify(await keys(net.id));
  const config = (): ApiConfig => ({ db, apiKeys, mode: 'essai', now, pigeSource: wired?.source ?? null, pigeProvider: settings });
  const http = async (who: Who, method: 'GET' | 'POST', path: string) => {
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers: { authorization: `Bearer ${KEYS[who]}` } }), config());
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; reason?: string } };
  };
  const tick = () => runScheduler({ db, mode: 'essai', now, pigeProvider: wired });
  const runs = () => db.all<{ outcome: string; reason: string | null; received: number; added: number; no_agency: number; outside: number }>('SELECT outcome, reason, received, added, no_agency, outside FROM pige_runs ORDER BY ran_at, rowid');
  const events = async (type: string) => (await journal.all()).filter((e) => e.type === type);
  return {
    db,
    journal,
    net,
    other,
    fake,
    wired,
    http,
    tick,
    runs,
    events,
    useOtherNetwork: async () => { apiKeys = JSON.stringify(await keys(other.id)); },
    at: (t: number) => { clock = t; },
  };
}

describeWithSqlite('AU034 · la pige relevée chaque jour chez un vrai fournisseur', () => {
  it('[R671] constat reproduit : avec ses réglages, le Worker branche le fournisseur, qui n’était jamais raccordé', async () => {
    const settings = pigeProvider({ PIGE_SOURCE_URL: PROVIDER_URL, PIGE_SOURCE_TOKEN: PROVIDER_TOKEN, PIGE_NETWORK_ID: 'reseau-1' });
    const wired = pigeSourceOf(settings, fakeProvider(() => new Date(MONDAY_6H)).fetcher);
    expect(wired).not.toBeNull();
    expect(wired?.networkId).toBe('reseau-1');
    expect(wired?.source).toBeInstanceOf(HttpPigeSource);
    // Un réglage manquant ou mal formé : aucune source, et le nom du réglage est dit.
    expect(pigeSourceOf(pigeProvider({}))).toBeNull();
    expect(missingPigeSettings(pigeProvider({}))).toEqual(['PIGE_SOURCE_URL', 'PIGE_SOURCE_TOKEN', 'PIGE_NETWORK_ID']);
    expect(missingPigeSettings({ url: 'http://pige.example.test/annonces', token: 'court', networkId: 'reseau-1' })).toEqual(['PIGE_SOURCE_URL', 'PIGE_SOURCE_TOKEN']);
    expect(missingPigeSettings({ url: 'https://moi:secret@pige.example.test/annonces', token: PROVIDER_TOKEN, networkId: 'reseau-1' })).toEqual(['PIGE_SOURCE_URL']);
  });

  it('[R671] [R273] à 6 h, le planificateur relève les annonces du fournisseur ; « pas d’agence » et hors zone écartés, aucun texte gardé', async () => {
    const t = await setup();
    const tick = await t.tick();
    expect(tick?.ran).toContain(PIGE_COLLECT_JOB);
    expect(await t.runs()).toEqual([{ outcome: 'ok', reason: null, received: 4, added: 1, no_agency: 2, outside: 1 }]);
    // Seule la date part : ni le réseau, ni une commune ; la clé dans l'en-tête, jamais dans l'adresse.
    expect(t.fake.calls).toHaveLength(2);
    const first = new URL(t.fake.calls[0]!.url);
    expect(`${first.origin}${first.pathname}`).toBe(PROVIDER_URL);
    expect([...first.searchParams.keys()]).toEqual(['since']);
    expect(t.fake.calls[0]!.url).not.toContain(t.net.id);
    expect(t.fake.calls[0]!.url).not.toContain(PROVIDER_TOKEN);
    expect(t.fake.calls[0]!.headers.authorization).toBe(`Bearer ${PROVIDER_TOKEN}`);
    const alex = await t.http('alex', 'GET', '/pige');
    expect(alex.body.data).toHaveLength(1);
    expect(alex.body.data[0]).toMatchObject({ commune: 'Talant', source: 'Site A' });
    const dump = JSON.stringify(await t.db.all('SELECT * FROM pige_ads')) + JSON.stringify(await t.journal.all());
    expect(dump).not.toContain('Jean Particulier');
    expect(dump).not.toContain(PROVIDER_TOKEN);
    expect((await t.events('pige.relevee')).map((e) => e.data)).toEqual([{ rule: 'R671', received: 4, added: 1 }]);
    // Une seule fois par jour : le passage suivant de la même heure ne relève pas de nouveau.
    t.at(MONDAY_6H + 20 * 60_000);
    await t.tick();
    expect(await t.runs()).toHaveLength(1);
    // Hors de 6 h, rien.
    t.at(MONDAY_6H + 4 * HOUR);
    await t.tick();
    expect(await t.runs()).toHaveLength(1);
  });

  it('[R671] l’écran dit la date de la dernière relève ; une panne est rangée, dite au journal et en alerte, puis le rétablissement', async () => {
    const t = await setup();
    let etat = await t.http('alex', 'GET', '/pige/etat');
    expect(etat.status).toBe(200);
    expect(etat.body.data).toEqual({ configured: true, missing: [], lastCollectedAt: null, lastRun: null, alert: 'jamais_relevee' });
    await t.tick();
    etat = await t.http('alex', 'GET', '/pige/etat');
    expect(etat.body.data).toMatchObject({ lastCollectedAt: new Date(MONDAY_6H).toISOString(), lastRun: { outcome: 'ok', reason: null, received: 4, added: 1 }, alert: null });
    // Le lendemain, le fournisseur refuse la clé : la panne est rangée avec sa raison, la date reste celle d'hier.
    t.at(MONDAY_6H + DAY);
    t.fake.setFail('http401');
    const tick = await t.tick();
    expect(tick?.failed ?? []).not.toContain(PIGE_COLLECT_JOB);
    expect((await t.runs()).at(-1)).toMatchObject({ outcome: 'panne', reason: 'acces_refuse', received: 0, added: 0 });
    expect((await t.events('pige.panne')).map((e) => e.data)).toEqual([{ rule: 'R671', reason: 'acces_refuse' }]);
    etat = await t.http('direction', 'GET', '/pige/etat');
    expect(etat.body.data).toMatchObject({ lastCollectedAt: new Date(MONDAY_6H).toISOString(), lastRun: { outcome: 'panne', reason: 'acces_refuse' }, alert: 'panne' });
    // Le jour suivant, il répond : rétabli, dit au journal.
    t.at(MONDAY_6H + 2 * DAY);
    t.fake.setFail(null);
    await t.tick();
    expect(await t.events('pige.retablie')).toHaveLength(1);
    etat = await t.http('alex', 'GET', '/pige/etat');
    expect(etat.body.data).toMatchObject({ lastCollectedAt: new Date(MONDAY_6H + 2 * DAY).toISOString(), alert: null });
    // Passé 26 heures sans relève réussie : en retard.
    t.at(MONDAY_6H + 3 * DAY + 3 * HOUR);
    etat = await t.http('alex', 'GET', '/pige/etat');
    expect(etat.body.data.alert).toBe('en_retard');
  });

  it('[R671] chaque panne garde une raison de la liste fermée, jamais le texte de l’erreur', async () => {
    for (const [fail, reason] of [['http503', 'fournisseur_indisponible'], ['json', 'reponse_illisible'], ['reseau', 'reseau']] as const) {
      const t = await setup();
      t.fake.setFail(fail);
      const r = await t.http('direction', 'POST', '/pige/releve');
      expect(r.status, fail).toBe(502);
      expect(r.body).toMatchObject({ ok: false, rule: 'R671', code: 'fournisseur_en_panne', reason });
      expect((await t.runs()).at(-1)).toMatchObject({ outcome: 'panne', reason });
      const dump = JSON.stringify(await t.journal.all()) + JSON.stringify(await t.db.all('SELECT * FROM pige_runs'));
      expect(dump).not.toContain(PROVIDER_TOKEN);
      expect(dump).not.toContain('pige.fournisseur.example.test');
    }
  });

  it('[R671] la page suivante n’est suivie que sous la même adresse ; une réponse sans liste est illisible', async () => {
    const calls: string[] = [];
    const fetcher: PigeFetcher = async (url) => {
      calls.push(url);
      const first = new URL(url).searchParams.get('since') === '2026-12-01T00:00:00.000Z';
      return { ok: true, status: 200, json: async () => (first ? { ads: [{ a: 1 }], next: 'https://ailleurs.example.test/v1/annonces?page=2' } : { pas: 'de liste' }) };
    };
    const source = new HttpPigeSource(fetcher, { url: PROVIDER_URL, token: PROVIDER_TOKEN });
    expect(await source.ads('n', new Date('2026-12-01T00:00:00.000Z'))).toHaveLength(1);
    expect(calls).toHaveLength(1);
    await expect(source.ads('n', new Date('2026-12-02T00:00:00.000Z'))).rejects.toEqual(new PigeSourceError('reponse_illisible'));
    expect(() => new HttpPigeSource(fetcher, { url: 'http://pige.example.test/', token: PROVIDER_TOKEN })).toThrow();
  });

  it('[R671] [R16] la direction voit les réglages manquants, l’agent seulement l’alerte ; un autre rôle est refusé', async () => {
    const t = await setup({ provider: { token: undefined } });
    const d = await t.http('direction', 'GET', '/pige/etat');
    expect(d.body.data).toMatchObject({ configured: false, missing: ['PIGE_SOURCE_TOKEN'], alert: 'non_reglee' });
    const a = await t.http('alex', 'GET', '/pige/etat');
    expect(a.body.data).toMatchObject({ configured: false, missing: [], alert: 'non_reglee' });
    const c = await t.http('conformite', 'GET', '/pige/etat');
    expect(c.status).toBe(403);
    expect(c.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    // Sans source, la relève ne range rien.
    const r = await t.http('direction', 'POST', '/pige/releve');
    expect(r.body).toMatchObject({ ok: false, code: 'source_absente' });
    expect(await t.runs()).toEqual([]);
  });

  it('[R671] seul le réseau du fournisseur relève : la direction d’un autre réseau n’a pas de source', async () => {
    const t = await setup();
    await t.useOtherNetwork();
    const r = await t.http('direction', 'POST', '/pige/releve');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: 'source_absente' });
    expect(t.fake.calls).toHaveLength(0);
    const etat = await t.http('direction', 'GET', '/pige/etat');
    expect(etat.body.data).toMatchObject({ configured: false, alert: 'non_reglee' });
  });

  it('[R17] une relève rangée ne change ni ne s’efface', async () => {
    const t = await setup();
    await t.tick();
    await expect(t.db.run("UPDATE pige_runs SET outcome = 'panne', reason = 'autre'")).rejects.toThrow(/rien ne change/);
    await expect(t.db.run('DELETE FROM pige_runs')).rejects.toThrow(/rien ne s'efface/);
  });
});
