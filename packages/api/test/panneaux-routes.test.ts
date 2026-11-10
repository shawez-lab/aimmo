import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runScheduler } from '../src/planificateur.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents, biens, adresses et clés d'API inventés. Le 1er mars 2027, à 9 h à Paris.
const KEYS = {
  alex: 'test-cle-br23-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br23-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br23-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br23-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;
const ADDRESS = { streetNumber: '12 bis', street: 'Rue des Essais', postcode: '21000', city: 'Dijon' };

async function setup() {
  const t = await setupAnnonce();
  t.setClock(new Date('2027-02-12T10:00:00.000Z'));
  await t.annonces.validate(t.agent, t.draftId);
  t.setClock(new Date('2027-03-01T08:00:00.000Z'));
  await t.publication.sync(t.network.id, t.propertyId);
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: t.alexId },
    sam: { role: 'agent', userId: t.sam.userId },
    direction: { role: 'direction', userId: t.direction.userId },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now };
  const http = async (who: Who, method: string, path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; mode?: string; field?: string } };
  };
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
  const count = async (table: string) => Number((await t.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n);
  const stock = async (n = 2) => {
    const r = await http('direction', 'POST', '/panneaux/stock', { size: 'grand', count: n });
    expect(r.status, r.body.code).toBe(200);
    return r.body.data.numbers as number[];
  };
  return { ...t, config, http, refusals, count, stock };
}

/** Une requête dont le corps ne doit pas être lu : s'il l'était avant le rôle, la route ne répondrait pas 403. */
function untouchable(url: string, init: RequestInit): Request {
  const r = new Request(url, init);
  Object.defineProperty(r, 'text', { value: () => Promise.reject(new Error('corps lu avant le contrôle du rôle')) });
  Object.defineProperty(r, 'json', { value: () => Promise.reject(new Error('corps lu avant le contrôle du rôle')) });
  return r;
}

describeWithSqlite('BR23 · routes du stock de panneaux', () => {
  it('[R16] chaque route refuse le mauvais rôle en 403, au journal, avant toute lecture du corps', async () => {
    const t = await setup();
    const cases: [Who, string, string][] = [
      ['conformite', 'GET', '/panneaux'],
      ['conformite', 'GET', '/panneaux/a-recuperer'],
      ['alex', 'POST', '/panneaux/stock'],
      ['conformite', 'POST', '/panneaux/stock'],
      ['conformite', 'POST', '/panneaux/poses'],
      ['conformite', 'POST', '/panneaux/poses/pose-1/retrait'],
    ];
    for (const [who, method, path] of cases) {
      const before = (await t.refusals()).length;
      const r = await t.http(who, method, path, undefined, method === 'POST' ? 'pas du json' : undefined);
      expect(r.status, `${who} ${method} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16' });
      expect((await t.refusals()).length, `${who} ${method} ${path}`).toBeGreaterThan(before);
      if (method === 'POST') {
        const req = untouchable(`https://aimmo-api.example.test/v1${path}`, { method, headers: { authorization: `Bearer ${KEYS[who]}`, 'content-type': 'application/json' }, body: '{}' });
        expect((await handleRequest(req, t.config)).status, `${who} ${method} ${path} (corps)`).toBe(403);
      }
    }
    // Une fois par GET, deux fois par POST (corps mal formé, puis corps qui n'est pas lu).
    expect((await t.refusals()).filter((e) => e.data.kind === 'panneaux').length).toBe(10);
    expect(await t.count('signs')).toBe(0);
  });

  it('[R282] les numéros sont donnés par le code ; un format ou un nombre hors liste est refusé', async () => {
    const t = await setup();
    expect(await t.stock(2)).toEqual([1, 2]);
    expect((await t.http('direction', 'POST', '/panneaux/stock', { size: 'petit' })).body.data.numbers).toEqual([3]);
    expect(await t.http('direction', 'POST', '/panneaux/stock', { size: 'geant', count: 1 })).toMatchObject({ status: 409, body: { rule: 'R282', code: 'bad_size' } });
    expect(await t.http('direction', 'POST', '/panneaux/stock', { size: 'grand', count: 51 })).toMatchObject({ status: 409, body: { rule: 'R282', code: 'bad_count' } });
    // Un numéro choisi par l'appelant n'est pas un champ prévu.
    expect(await t.http('direction', 'POST', '/panneaux/stock', { size: 'grand', number: 99 })).toMatchObject({ status: 400, body: { code: 'unknown_field', field: 'number' } });
    const s = await t.http('direction', 'GET', '/panneaux');
    expect(s).toMatchObject({ status: 200, body: { ok: true, mode: 'essai', data: { counts: { total: 3, enStock: 3, poses: 0 } } } });
  });

  it('[R282] [R42] une pose seulement sur son bien diffusable, à son adresse, un endroit à la fois ; l’autre agent ne la voit pas [R284]', async () => {
    const t = await setup();
    const [n1] = await t.stock(1);
    const pose = (who: Who, extra: Record<string, unknown> = {}) => t.http(who, 'POST', '/panneaux/poses', { signNumber: n1, propertyId: t.propertyId, address: ADDRESS, ...extra });
    // Sam n'est pas l'agent du bien.
    const before = (await t.refusals()).length;
    expect(await pose('sam')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect((await t.refusals()).length).toBe(before + 1);
    expect(await pose('alex', { address: { ...ADDRESS, postcode: '21240', city: 'Talant' } })).toMatchObject({ status: 409, body: { rule: 'R282', code: 'hors_du_bien' } });
    expect(await pose('alex', { signNumber: 99 })).toMatchObject({ status: 404, body: { code: 'unknown_sign' } });
    const ok = await pose('alex');
    expect(ok.status, ok.body.code).toBe(200);
    expect(await pose('direction')).toMatchObject({ status: 409, body: { rule: 'R282', code: 'pas_au_stock' } });
    // L'agent lit ses poses, avec l'adresse ; Sam n'en lit aucune, mais les comptes.
    expect((await t.http('alex', 'GET', '/panneaux')).body.data.placed).toMatchObject([{ placementId: ok.body.data.placementId, signNumber: n1, propertyId: t.propertyId, address: ADDRESS }]);
    const sam = await t.http('sam', 'GET', '/panneaux');
    expect(sam.body.data).toMatchObject({ counts: { total: 1, poses: 1 }, placed: [] });
    // Bien sans mandat diffusable : la porte de diffusion refuse [R42].
    const [n2] = await t.stock(1);
    const bare = await t.store.createProperty({ networkId: t.network.id, agentId: t.alexId, reference: 'REF-T-9', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 40, rooms: 2, priceEur: 120000 });
    const refused = await t.http('alex', 'POST', '/panneaux/poses', { signNumber: n2, propertyId: bare.id, address: ADDRESS });
    expect(refused.status).toBe(409);
    expect(refused.body.rule).toBe('R42');
  });

  it('[R283] le planificateur range « récupérer le panneau » quand le bien est vendu ; l’agent le dit récupéré, une fois', async () => {
    const t = await setup();
    const [n1] = await t.stock(1);
    const placed = await t.http('alex', 'POST', '/panneaux/poses', { signNumber: n1, propertyId: t.propertyId, address: ADDRESS });
    expect(placed.status, placed.body.code).toBe(200);
    expect((await t.http('alex', 'GET', '/panneaux/a-recuperer')).body.data).toEqual([]);
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.propertyId]);
    // Le passage de 13 h, heure de Paris.
    t.setClock(new Date('2027-03-01T12:05:00.000Z'));
    const tick = await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    expect(tick?.ran).toContain('panneaux.recuperer');
    const due = await t.http('alex', 'GET', '/panneaux/a-recuperer');
    expect(due.body.data).toMatchObject([{ kind: 'panneau', placementId: placed.body.data.placementId, signNumber: n1, propertyId: t.propertyId, address: ADDRESS }]);
    expect((await t.http('direction', 'GET', '/panneaux/a-recuperer')).body.data).toHaveLength(1);
    expect((await t.http('sam', 'GET', '/panneaux/a-recuperer')).body.data).toEqual([]);
    // Sam ne retire pas la pose d'Alex ; un résultat hors liste est refusé ; Alex la dit récupérée, une fois.
    const path = `/panneaux/poses/${placed.body.data.placementId}/retrait`;
    expect(await t.http('sam', 'POST', path, { outcome: 'recupere' })).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.http('alex', 'POST', path, { outcome: 'vole' })).toMatchObject({ status: 409, body: { rule: 'R283', code: 'bad_outcome' } });
    expect((await t.http('alex', 'POST', path, { outcome: 'recupere' })).status).toBe(200);
    expect(await t.http('alex', 'POST', path, { outcome: 'recupere' })).toMatchObject({ status: 409, body: { rule: 'R283', code: 'deja_retire' } });
    expect(await t.http('alex', 'POST', '/panneaux/poses/inconnue-1/retrait', { outcome: 'recupere' })).toMatchObject({ status: 404 });
    expect((await t.http('direction', 'GET', '/panneaux')).body.data.counts).toMatchObject({ enStock: 1, poses: 0, aRecuperer: 0 });
    // Le journal ne porte aucune adresse [R13].
    expect(JSON.stringify(await t.journal.all())).not.toContain('Rue des Essais');
  });

  it('un corps absent, pas en JSON ou trop gros est refusé en 400 au bon rôle', async () => {
    const t = await setup();
    for (const [who, path] of [['direction', '/panneaux/stock'], ['alex', '/panneaux/poses'], ['alex', '/panneaux/poses/pose-1/retrait']] as [Who, string][]) {
      expect((await t.http(who, 'POST', path, undefined, 'pas du json')).body.code, path).toBe('invalid_body');
      expect((await t.http(who, 'POST', path, undefined, '[1]')).status, path).toBe(400);
      expect((await t.http(who, 'POST', path, undefined, JSON.stringify({ size: 'x'.repeat(5_000) }))).status, path).toBe(400);
    }
  });
});
