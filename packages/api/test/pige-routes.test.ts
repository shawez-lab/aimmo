import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import type { PigeSource, RawAd } from '../../core/src/pige/index.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../../core/src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Le lundi 7 décembre 2026, 10 h à Paris. Réseau, agents, annonces, numéros et clés d'API inventés.
const MONDAY_10H = Date.parse('2026-12-07T09:00:00.000Z');
const SUNDAY_10H = Date.parse('2026-12-06T09:00:00.000Z');
const DAY = 86_400_000;
const KEYS = {
  alex: 'test-cle-br29-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br29-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br29-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br29-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

async function setup(options: { withSource?: boolean } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_10H;
  const now = () => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const net = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: net.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: net.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const zone = async (agentId: string, commune: string) =>
    db.run("INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at, ended_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', NULL)", [crypto.randomUUID(), net.id, agentId, commune]);
  await zone(alex.id, 'Talant');
  await zone(sam.id, 'Fontaine-lès-Dijon');
  let n = 0;
  const ad = (over: Partial<RawAd> & Record<string, unknown> = {}): RawAd => {
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
      publishedAt: new Date(clock - DAY).toISOString(),
      text: 'Belle maison avec jardin, appelez Jean Particulier au 06 00 00 00 01.',
      phone: '0600000001',
      name: 'Jean Particulier',
      ...over,
    } as RawAd;
  };
  const ads: RawAd[] = [
    ad(),
    ad({ text: 'Vente entre particuliers uniquement, pas d’agence.' }),
    ad({ noAgency: true }),
    ad({ commune: 'Fontaine-lès-Dijon', postalCode: '21121' }),
    ad({ commune: 'Lyon', postalCode: '69001' }),
  ];
  let calls = 0;
  const source: PigeSource = {
    ads: async () => {
      calls += 1;
      return ads;
    },
  };
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: alex.id },
    sam: { role: 'agent', userId: sam.id },
    direction: { role: 'direction', userId: 'direction-1' },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: net.id, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now, ...(options.withSource === false ? {} : { pigeSource: source }) };
  const http = async (who: Who, method: 'GET' | 'POST', path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) init.body = JSON.stringify(body);
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, init), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; mode?: string; field?: string } };
  };
  const refusals = async () => (await journal.all()).filter((e) => e.type === 'acces.refuse' && e.data.kind === 'pige');
  const count = async (table: string) => (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
  return { db, journal, http, refusals, count, sourceCalls: () => calls, at: (t: number) => { clock = t; } };
}

describeWithSqlite('BR29 · routes de la pige des annonces de particuliers', () => {
  it('[R16] chaque route refuse le mauvais rôle en 403, au journal, avant de lire le corps ou la source', async () => {
    const t = await setup();
    const cases: [Who, 'GET' | 'POST', string, string?][] = [
      ['conformite', 'GET', '/pige'],
      ['direction', 'POST', '/pige/annonces/x1/message'],
      ['conformite', 'POST', '/pige/annonces/x1/message'],
      // Corps illisible : le rôle est refusé d'abord.
      ['direction', 'POST', '/pige/messages/d1/validation', '{pas du json'],
      ['conformite', 'POST', '/pige/annonces/x1/opposition'],
      ['alex', 'POST', '/pige/releve'],
      ['conformite', 'POST', '/pige/releve'],
    ];
    for (const [who, method, path, raw] of cases) {
      const r = await t.http(who, method, path, undefined, raw);
      expect(r.status, `${who} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await t.refusals()).length).toBe(cases.length);
    expect(t.sourceCalls()).toBe(0);
    expect(await t.count('pige_ads')).toBe(0);
  });

  it('sans source de pige branchée, la relève répond 400 sans rien ranger', async () => {
    const t = await setup({ withSource: false });
    const r = await t.http('direction', 'POST', '/pige/releve');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: 'source_absente' });
    expect(await t.count('pige_ads')).toBe(0);
  });

  it('[R273] la relève écarte « pas d’agence » et hors zone ; la file de l’agent ne montre que ses communes', async () => {
    const t = await setup();
    const r = await t.http('direction', 'POST', '/pige/releve');
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('essai');
    expect(r.body.data).toEqual({ added: 2, noAgency: 2, outside: 1, unreadable: 0 });
    const alex = await t.http('alex', 'GET', '/pige');
    expect(alex.status).toBe(200);
    expect(alex.body.data).toHaveLength(1);
    expect(alex.body.data[0]).toMatchObject({ commune: 'Talant', kind: 'house', draft: null });
    const sam = await t.http('sam', 'GET', '/pige');
    expect(sam.body.data.map((e: { commune: string }) => e.commune)).toEqual(['Fontaine-lès-Dijon']);
    const direction = await t.http('direction', 'GET', '/pige');
    expect(direction.body.data).toHaveLength(2);
    // Aucune annonce « pas d'agence » n'est rendue, à personne.
    for (const who of ['alex', 'sam', 'direction'] as const) expect(JSON.stringify((await t.http(who, 'GET', '/pige')).body)).not.toMatch(/particuliers uniquement|agence/i);
  });

  it('[R274] sans case publiée des prix de la commune, « marché non chiffré », jamais un chiffre deviné', async () => {
    const t = await setup();
    await t.http('direction', 'POST', '/pige/releve');
    const [entry] = (await t.http('alex', 'GET', '/pige')).body.data;
    expect(entry.market).toEqual({ unpriced: true, reason: 'marche_non_chiffre' });
  });

  it('[R273] [R13] aucune coordonnée ni aucun texte du particulier ne sort, dans la file ou dans le message', async () => {
    const t = await setup();
    await t.http('direction', 'POST', '/pige/releve');
    const [entry] = (await t.http('alex', 'GET', '/pige')).body.data;
    const prepared = await t.http('alex', 'POST', `/pige/annonces/${entry.adId}/message`);
    expect(prepared.status).toBe(200);
    const all = JSON.stringify([(await t.http('alex', 'GET', '/pige')).body, (await t.http('direction', 'GET', '/pige')).body, prepared.body]);
    expect(all).not.toMatch(/Jean|Particulier|06 ?00|0600000001|jardin|appelez/i);
  });

  it('[R275] [R26] le message est préparé une fois par bien, puis remis à coller dans les heures, jamais envoyé', async () => {
    const t = await setup();
    await t.http('direction', 'POST', '/pige/releve');
    const [entry] = (await t.http('alex', 'GET', '/pige')).body.data;
    // Sam n'est pas l'agent de Talant : la couche métier refuse.
    expect((await t.http('sam', 'POST', `/pige/annonces/${entry.adId}/message`)).status).toBe(403);
    const prepared = await t.http('alex', 'POST', `/pige/annonces/${entry.adId}/message`);
    expect(prepared.body.data).toMatchObject({ sent: false });
    expect(prepared.body.data.body).toContain('Alex');
    const again = await t.http('alex', 'POST', `/pige/annonces/${entry.adId}/message`);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ rule: 'R05', code: 'deja_prepare' });
    const draftId = prepared.body.data.draftId as string;
    // Par SMS : la décision unique refuse faute d'accord [R03].
    const sms = await t.http('alex', 'POST', `/pige/messages/${draftId}/validation`, { channel: 'sms' });
    expect(sms.status).toBe(409);
    expect(sms.body.rule).toBe('R03');
    // Un dimanche : hors des heures d'envoi [R01].
    t.at(SUNDAY_10H + 7 * DAY);
    const sunday = await t.http('alex', 'POST', `/pige/messages/${draftId}/validation`, { channel: 'annonce' });
    expect(sunday.status).toBe(409);
    expect(sunday.body.rule).toBe('R01');
    t.at(MONDAY_10H);
    // Sam ne valide pas le message d'Alex.
    expect((await t.http('sam', 'POST', `/pige/messages/${draftId}/validation`, { channel: 'annonce' })).status).toBe(403);
    const handed = await t.http('alex', 'POST', `/pige/messages/${draftId}/validation`, { channel: 'annonce' });
    expect(handed.status).toBe(200);
    expect(handed.body.data).toEqual({ body: prepared.body.data.body, channel: 'annonce', sent: false, toPaste: true });
    const twice = await t.http('alex', 'POST', `/pige/messages/${draftId}/validation`, { channel: 'annonce' });
    expect(twice.status).toBe(409);
    // Rien n'est parti d'AIMMO : aucun message rangé à envoyer.
    expect(await t.count('outbound_messages').catch(() => 0)).toBe(0);
    expect((await t.journal.all()).some((e) => /envoy|sent/.test(e.type))).toBe(false);
  });

  it('[R04] une opposition ferme le bien : il quitte la file et n’a plus de message', async () => {
    const t = await setup();
    await t.http('direction', 'POST', '/pige/releve');
    const [entry] = (await t.http('alex', 'GET', '/pige')).body.data;
    // Hors de la zone de Sam : 403.
    expect((await t.http('sam', 'POST', `/pige/annonces/${entry.adId}/opposition`)).status).toBe(403);
    expect((await t.http('alex', 'POST', `/pige/annonces/${entry.adId}/opposition`)).status).toBe(200);
    expect((await t.http('alex', 'GET', '/pige')).body.data).toEqual([]);
    expect((await t.http('alex', 'POST', `/pige/annonces/${entry.adId}/message`)).status).not.toBe(200);
    expect((await t.http('alex', 'POST', '/pige/annonces/inconnue/opposition')).status).toBe(404);
  });

  it('corps illisible, champ ou paramètre non prévu : 400 sans rien ranger', async () => {
    const t = await setup();
    await t.http('direction', 'POST', '/pige/releve');
    const [entry] = (await t.http('alex', 'GET', '/pige')).body.data;
    const prepared = await t.http('alex', 'POST', `/pige/annonces/${entry.adId}/message`);
    const path = `/pige/messages/${prepared.body.data.draftId}/validation`;
    expect((await t.http('alex', 'POST', path, undefined, '{pas du json')).body).toMatchObject({ code: 'invalid_body' });
    const extra = await t.http('alex', 'POST', path, { channel: 'annonce', phone: '0600000002' });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({ code: 'unknown_field', field: 'phone' });
    const q = await t.http('alex', 'GET', '/pige?commune=Dijon');
    expect(q.status).toBe(400);
    expect(q.body).toMatchObject({ code: 'unknown_field', field: 'commune' });
    const bad = await t.http('alex', 'POST', path, { channel: 'pigeon' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('bad_channel');
    expect(await t.count('pige_handovers')).toBe(0);
  });

  it('une route sans corps refuse tout corps illisible, trop gros ou portant un champ, sans rien lire ni ranger', async () => {
    const t = await setup();
    for (const raw of ['{"unexpected":true}', '{pas du json', '[1]', JSON.stringify({ x: 'a'.repeat(3000) })]) {
      const r = await t.http('direction', 'POST', '/pige/releve', undefined, raw);
      expect(r.status, raw.slice(0, 20)).toBe(400);
    }
    expect(t.sourceCalls()).toBe(0);
    expect(await t.count('pige_ads')).toBe(0);
    // Un corps vide ou `{}` passe.
    expect((await t.http('direction', 'POST', '/pige/releve', {})).status).toBe(200);
    const [entry] = (await t.http('alex', 'GET', '/pige')).body.data;
    expect((await t.http('alex', 'POST', `/pige/annonces/${entry.adId}/message`, { body: 'Mon texte' })).body).toMatchObject({ code: 'unknown_field', field: 'body' });
    expect((await t.http('alex', 'POST', `/pige/annonces/${entry.adId}/opposition`, undefined, '{oops')).body).toMatchObject({ code: 'invalid_body' });
    expect(await t.count('pige_drafts')).toBe(0);
    expect(await t.count('pige_oppositions')).toBe(0);
  });
});
