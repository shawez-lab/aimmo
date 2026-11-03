import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { PUBLIC_PATHS, attirerRoutes, handleAttirerPublic, type AttirerServices } from '../src/attirer.ts';
import { pilotageRoutes, type PilotageServices } from '../src/pilotage.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau d'essai, adresses en exemple.test.
const NET = 'https://reseau.exemple.test';
const AGENT_SITE = 'https://camille.exemple.test';
const direction = { role: 'direction', userId: 'dir-1', networkId: 'net-1' } as Viewer;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  const now = (): Date => new Date('2027-02-02T09:00:00.000Z');
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', '2026-01-01T00:00:00.000Z')");
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, zone, created_at, updated_at) VALUES ('ag-1', 'net-1', 'Camille', 'Exemple', 'Ville inventée', 'x', 'x')");
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const ps: PilotageServices = { db, journal, acces, now };
  const as: AttirerServices = { db, journal, now, priceSales: { sales: async () => [] } as never };
  const post = async (viewer: Viewer, body: unknown) => {
    const route = pilotageRoutes().find((r) => r.name === 'pilotage.preuve_sceau')!;
    const res = await route.handle(ps, viewer, [], new Request('https://api.exemple.test/v1/pilotage/preuve/sceau', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const sites = attirerRoutes().find((r) => r.method === 'POST' && r.pattern.test('/attirer/sites'))!;
  for (const site of [{ kind: 'reseau', baseUrl: NET, active: true }, { kind: 'agent', agentId: 'ag-1', baseUrl: AGENT_SITE, active: true }]) {
    const res = await sites.handle(as, direction, [], new Request('https://api.exemple.test/attirer/sites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(site) }));
    expect(res.status).toBe(200);
  }
  const get = (url: string, method = 'GET') => handleAttirerPublic(as, new Request(url, { method }));
  return { post, get, ps };
}

describeWithSqlite('IN02 · routes du sceau et compte public', () => {
  it('[R16] [R212] la route scelle pour la direction, refuse un écart, un agent et un montant', async () => {
    const t = await setup();
    expect(await t.post(direction, { month: '2027-01', manualCount: 2 })).toMatchObject({ status: 409, body: { rule: 'R212', code: 'count_mismatch', counted: 0, given: 2 } });
    expect((await t.post({ ...direction, role: 'agent', userId: 'ag-1' } as Viewer, { month: '2027-01', manualCount: 0 })).status).toBe(403);
    expect(await t.post(direction, { month: '2027-01', manualCount: 0, montant: 3 })).toMatchObject({ status: 400, body: { code: 'amount_refused' } });
    expect(await t.post(direction, { month: '2027-01', manualCount: 0 })).toMatchObject({ status: 200, body: { ok: true, data: { seq: 1, counted: 0 } } });
  });

  it('[R16] [R213] la lecture des sceaux pour l’écran : la direction seule, et un sceau se voit aussitôt', async () => {
    const t = await setup();
    const read = (viewer: Viewer) => pilotageRoutes().find((r) => r.name === 'pilotage.preuve_sceaux')!.handle(t.ps, viewer, [], new Request('https://api.exemple.test/v1/pilotage/preuve/sceaux'));
    expect((await read({ ...direction, role: 'agent', userId: 'ag-1' } as Viewer)).status).toBe(403);
    expect((await read({ ...direction, role: 'compliance', userId: 'c-1' } as Viewer)).status).toBe(403);
    expect(((await (await read(direction)).json()) as Record<string, any>).data.seals).toEqual([]);
    expect((await t.post(direction, { month: '2027-01', manualCount: 0 })).status).toBe(200);
    expect(((await (await read(direction)).json()) as Record<string, any>).data.seals).toHaveLength(1);
  });

  it('[R213] le compte public est servi sur le site du réseau seul, en page et en fichier, sans index en essai', async () => {
    const t = await setup();
    expect(Object.values(PUBLIC_PATHS).some((p) => p.test('/preuve'))).toBe(true);
    expect(Object.values(PUBLIC_PATHS).some((p) => p.test('/preuve.json'))).toBe(true);
    expect((await t.post(direction, { month: '2027-01', manualCount: 0 })).status).toBe(200);
    const page = (await t.get(`${NET}/preuve`))!;
    expect(page.status).toBe(200);
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const html = await page.text();
    expect(html).toContain('janvier 2027');
    expect(html).toContain('href="/preuve.json"');
    const file = (await t.get(`${NET}/preuve.json`))!;
    expect(file.headers.get('content-type')).toContain('application/json');
    const proof = (await file.json()) as Record<string, any>;
    expect(proof.seals).toHaveLength(1);
    expect(proof).toMatchObject({ chainSound: true, registerSound: true, target: 10, requiredMonths: 6 });
    expect((await t.get(`${AGENT_SITE}/preuve`))!.status).toBe(404);
    expect((await t.get(`${AGENT_SITE}/preuve.json`))!.status).toBe(404);
    expect((await t.get('https://inconnu.exemple.test/preuve'))!.status).toBe(404);
    expect((await t.get(`${NET}/preuve`, 'POST'))!.status).toBe(405);
    expect(await (await t.get(`${NET}/preuve`, 'HEAD'))!.text()).toBe('');
  });
});
