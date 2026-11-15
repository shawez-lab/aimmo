import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BanGeocoder, type SqlDatabase } from '@aimmo/core';
import { PUBLIC_SOURCES, type SourceDocument } from '../../core/src/documents/copropriete-urbanisme.ts';
import type { UrbanismPoint } from '../../core/src/documents/index.ts';
import type { Geocoded } from '../../core/src/estimation/collecte.ts';
import { handleRequest, sha256Hex, type ApiConfig } from '../src/index.ts';
import { coproprieteRoutes } from '../src/copropriete.ts';
import { setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau, agents, clés, documents, adresse et réponses des services publics.
const ORIGIN = 'https://aimmo-api.example.test';
const KEYS = { alex: 'test-cle-br87-alex-aaaaaaaaaaaaaaaaaaaaaaaaaa', sam: 'test-cle-br87-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbb', direction: 'test-cle-br87-dir-ddddddddddddddddddddddddddd' };
type Who = keyof typeof KEYS;

const PV: SourceDocument = {
  kind: 'pv_assemblee',
  ref: 'dossiers/test/pv-2027-01-15.pdf',
  meetingDay: '2027-01-15',
  pages: [
    "Procès-verbal de l'assemblée générale ordinaire du 15 janvier 2027.",
    "Résolution n° 7 : l'assemblée décide le ravalement de la façade sur rue pour un montant de 48 000 € TTC, exigible le 1er septembre 2027.",
  ],
};
const SENTENCES = [
  {
    topic: 'travaux_votes',
    text: 'Le ravalement de la façade sur rue est voté',
    document: 0,
    page: 2,
    quote: "l'assemblée décide le ravalement de la façade sur rue pour un montant de 48 000 € TTC, exigible le 1er septembre 2027",
    works: { amountEur: 48000, dueOn: '2027-09-01' },
  },
];
const ADDRESS = '7 rue des Essais, 21000 Dijon';
const PLACE: Geocoded = { label: '7 Rue des Essais 21000 Dijon', lat: 47.3216, lon: 5.0415, postalCode: '21000', inseeCode: '21231', town: 'Dijon', banId: '21231_0000_00007', score: 0.93 };
const BODY = { documents: [PV], sentences: SENTENCES, address: ADDRESS };

/** Un faux Internet : la BAN et le Géoportail répondent, chaque appel est noté avec sa méthode. */
function fakePublicData() {
  const calls: { method: string; url: string }[] = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url });
    if (url.startsWith('https://data.geopf.fr/geocodage/')) {
      return Response.json({
        features: [{ geometry: { coordinates: [PLACE.lon, PLACE.lat] }, properties: { label: PLACE.label, postcode: '21000', citycode: '21231', city: 'Dijon', id: PLACE.banId, score: 0.93 } }],
      });
    }
    if (url.startsWith('https://apicarto.ign.fr/api/gpu/zone-urba')) {
      return Response.json({ features: [{ properties: { libelle: 'UA', libelong: 'Zone urbaine centrale', typezone: 'U', idurba: '21231_PLU_20190101', datappro: '20191216', partition: 'DU_21231' } }] });
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, fetcher };
}

async function setup(over: Partial<ApiConfig> = {}) {
  const t = await setupDossier('appartement');
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: t.agent.userId }, sam: { role: 'agent', userId: t.sam.userId }, direction: { role: 'direction', userId: t.direction.userId } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const geocoded: string[] = [];
  const points: UrbanismPoint[] = [];
  const injected: ApiConfig['copropriete'] = {
    geocoder: { geocode: async (address) => (geocoded.push(address), PLACE) },
    urbanism: {
      collect: async (point) => {
        points.push(point);
        return { ok: true, source: PUBLIC_SOURCES.urbanism, collectedAt: t.now().toISOString(), dataDate: '2019-12-16', value: { documentType: 'PLU', zone: 'UA', label: 'Zone urbaine centrale' } };
      },
    },
  };
  const config: ApiConfig = { db: t.db as SqlDatabase, apiKeys, mode: 'essai', now: t.now, copropriete: injected, ...over };
  const http = async (who: Who | null, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const r = await handleRequest(
      new Request(`${ORIGIN}/v1/dossiers/${t.fileId}/copropriete${path}`, {
        method,
        headers: { ...(who ? { authorization: `Bearer ${KEYS[who]}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      config,
    );
    return { status: r.status, body: (await r.json()) as { ok: boolean; rule?: string | null; code?: string; data?: any } };
  };
  const journalText = async () => JSON.stringify(await t.db.all('SELECT * FROM journal'));
  const journalCount = async () => (await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM journal'))!.n;
  return { t, http, geocoded, points, journalText, journalCount };
}

describeWithSqlite('BR87 · copropriété et urbanisme branchés au Worker', () => {
  it('[R448] [R451] les routes sont servies par l’API : résumé préparé par l’agent, relu par la direction, travaux dits à l’acquéreur ; sans clé, 401', async () => {
    const { http } = await setup();
    expect((await http(null, 'GET', '/resume')).status).toBe(401);
    const pre = await http('alex', 'POST', '/prelecture', { documents: [PV] });
    expect(pre.status).toBe(200);
    const made = await http('alex', 'POST', '/resume', BODY);
    expect(made).toMatchObject({ status: 200, body: { ok: true, mode: 'essai' } });
    expect(made.body.data.worksToNotify).toHaveLength(1);
    const read = await http('direction', 'GET', '/resume');
    expect(read.status).toBe(200);
    expect(read.body.data.id).toBe(made.body.data.id);
    const buyer = await http('alex', 'GET', '/acquereur');
    expect(buyer.status).toBe(200);
    expect(buyer.body.data.lines[0]).toContain('48 000 €');
  });

  it('[R449] [R13] la zone est collectée par les services branchés, à l’adresse tapée ; l’adresse n’est nulle part au journal', async () => {
    const { http, geocoded, points, journalText } = await setup();
    const r = await http('alex', 'POST', '/resume', BODY);
    expect(r.status).toBe(200);
    expect(geocoded).toEqual([ADDRESS]);
    expect(points).toEqual([{ lat: 47.3216, lon: 5.0415, inseeCode: '21231' }]);
    expect(r.body.data.urbanism).toMatchObject({ found: true, value: { zone: 'UA' } });
    const log = await journalText();
    expect(log).toContain('dossier.urbanisme_collecte');
    for (const leak of ['Essais', '21231_0000', '47.3216']) expect(log).not.toContain(leak);
  });

  it('[R449] sans option : la BAN de l’estimation puis le Géoportail lu par les données publiques, en GET seulement', async () => {
    const { calls, fetcher } = fakePublicData();
    const { http } = await setup({ copropriete: undefined, estimation: { geocoder: new BanGeocoder(fetcher), sales: {} as never }, fetchPublicData: fetcher });
    const r = await http('alex', 'POST', '/resume', BODY);
    expect(r.status).toBe(200);
    expect(r.body.data.urbanism).toMatchObject({ found: true, source: PUBLIC_SOURCES.urbanism, value: { zone: 'UA', documentType: 'PLU' } });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls[0]!.url.startsWith('https://data.geopf.fr/geocodage/')).toBe(true);
    expect(calls.some((c) => c.url.startsWith('https://apicarto.ign.fr/api/gpu/'))).toBe(true);
    // Seuls la position et la commune partent au Géoportail : jamais l'adresse tapée.
    for (const c of calls.filter((x) => x.url.startsWith('https://apicarto.ign.fr/'))) expect(decodeURIComponent(c.url)).not.toContain('Essais');
  });

  it('sans aucun service : zone « non collectée », le résumé se prépare quand même', async () => {
    const { http } = await setup({ copropriete: undefined });
    const r = await http('alex', 'POST', '/resume', BODY);
    expect(r.status).toBe(200);
    expect(r.body.data.urbanism).toMatchObject({ found: false, reason: 'non_collecte' });
  });

  it('[R449] une zone envoyée par l’écran est refusée par l’API en service', async () => {
    const { http, geocoded } = await setup();
    const fake = { ok: true, source: PUBLIC_SOURCES.urbanism, collectedAt: '2027-03-01T08:00:00.000Z', dataDate: '2020-01-01', value: { documentType: 'PLU', zone: 'UA', label: 'Constructible' } };
    for (const extra of [{ publicData: { urbanism: fake } }, { urbanism: fake }, { registry: {} }]) {
      expect(await http('alex', 'POST', '/resume', { ...BODY, ...extra })).toMatchObject({ status: 400, body: { rule: 'R449', code: 'public_data_not_accepted' } });
    }
    expect(geocoded).toEqual([]);
  });

  it('[R16] un autre agent est refusé, au journal, sans aucun géocodage', async () => {
    const { http, geocoded, journalCount } = await setup();
    const before = await journalCount();
    const r = await http('sam', 'POST', '/resume', BODY);
    expect(r.status).toBe(403);
    expect(r.body.rule).toBe('R16');
    expect(await journalCount()).toBeGreaterThan(before);
    expect(geocoded).toEqual([]);
  });

  it('[R82] un agent au dossier d’agent incomplet est refusé avant la route', async () => {
    const { t, http, geocoded } = await setup();
    // Une entrée par M14 sans pièce rangée (candidature inventée, hors du parcours) : le dossier est incomplet.
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO agent_onboardings (agent_id, network_id, candidate_id, created_by, created_at) VALUES (?, ?, 'cand-1', 'direction:dir-1', '2027-01-01')", [t.agent.userId, t.network.id]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    expect(await http('alex', 'POST', '/resume', BODY)).toMatchObject({ status: 403, body: { rule: 'R82', code: 'agent_file_incomplete' } });
    expect(geocoded).toEqual([]);
  });

  it('le Worker branche la Base adresse nationale et le Géoportail, en lecture seule', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(worker).toContain('copropriete: { geocoder: new BanGeocoder(fetch.bind(globalThis)), urbanism: new GpuUrbanism(fetch.bind(globalThis)) },');
  });

  it('docs/API.md décrit les routes', () => {
    const doc = readFileSync(new URL('../../../docs/API.md', import.meta.url), 'utf8');
    expect(doc).toContain('`/v1/dossiers/<id>/copropriete`');
    for (const route of ['`POST /prelecture`', '`POST /resume`', '`GET /resume`', '`GET /acquereur`']) expect(doc).toContain(route);
    expect(coproprieteRoutes().map((r) => r.name)).toEqual(expect.arrayContaining(['copropriete.acquereur', 'copropriete.prelecture', 'copropriete.preparer', 'copropriete.resume']));
  });
});
