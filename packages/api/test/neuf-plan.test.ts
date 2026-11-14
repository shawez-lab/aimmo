import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { attirerRoutes, handleAttirerPublic, type AttirerServices } from '../src/attirer.ts';
import { Referencement, type IndexNowClient } from '../../core/src/attirer/referencement.ts';
import { ProgrammesNeufs } from '../../core/src/neuf-viager/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// BR77 · Réseaux, agents, promoteurs, programmes et lots inventés ; adresses en exemple.test.
const NET = 'https://reseau.exemple.test';
const AGENT_SITE = 'https://alex.exemple.test';
const OTHER = 'https://autre.exemple.test';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-03-15T09:00:00.000Z');
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const as: AttirerServices = { db, journal, now };
  const siteRoute = attirerRoutes().find((r) => r.method === 'POST' && r.pattern.test('/attirer/sites'))!;
  const network = async (name: string, sites: (agent: string) => object[]) => {
    const id = (await store.createNetwork(name)).id;
    const agent = (await store.createAgent({ networkId: id, firstName: 'Alexandrine', lastName: 'Inventée' })).id;
    const direction = { role: 'direction', userId: `dir-${id}`, networkId: id } as Viewer;
    for (const site of sites(agent)) {
      const res = await siteRoute.handle(as, direction, [], new Request('https://api.exemple.test/attirer/sites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(site) }));
      expect(res.status).toBe(200);
    }
    const promoter = crypto.randomUUID();
    await db.run('INSERT INTO partners (id, network_id, trade, business_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [promoter, id, 'promoteur', 'Promoteur Inventé', 'direction:dir', '2027-01-01T00:00:00.000Z']);
    const neuf = new ProgrammesNeufs(db, journal, { now });
    expect((await neuf.setFeeScale(direction, { kind: 'neuf', rateBp: 250, source: 'Barème du neuf inventé', validFrom: '2027-01-01' })).ok).toBe(true);
    const program = async (name: string) => {
      const created = await neuf.createProgram(direction, { promoterPartnerId: promoter, agentId: agent, name, city: 'Dijon', postalCode: '21000' });
      if (!created.ok) throw new Error(created.code);
      return created.value.programId;
    };
    const lot = async (programId: string, lotRef: string, status: string, confirmedOn: string, priceCents = 25_000_000) => {
      expect((await neuf.recordLot(direction, programId, { lotRef, typology: 't3', livingAreaHundredths: 6550, floor: 2, priceCents, status, confirmedOn })).ok).toBe(true);
    };
    return { id, agent, program, lot };
  };
  const main = await network('Réseau test', (agent) => [
    { kind: 'reseau', baseUrl: NET, active: true },
    { kind: 'agent', agentId: agent, baseUrl: AGENT_SITE, active: true },
  ]);
  const siteIds = async (networkId: string) => new Map((await new Referencement(db, journal, { now }).sites(networkId)).map((s) => [s.baseUrl, s.siteId]));
  return { db, journal, now, main, network, siteIds, setNow: (iso: string) => (clock = Date.parse(iso)), get: (url: string) => handleAttirerPublic(as, new Request(url)) };
}

const neufEntries = (r: Awaited<ReturnType<Referencement['sitemap']>>) => (r.ok ? r.entries.filter((e) => e.kind === 'neuf' || e.loc.includes('/neuf/')) : []);

describeWithSqlite('BR77 · les programmes neufs au plan du site et signalés aux moteurs', () => {
  it('[R153] la grille entre au plan du seul site du réseau, avec le jour de confirmation le plus récent', async () => {
    const t = await setup();
    const p = await t.main.program('Les Jardins Inventés');
    await t.main.lot(p, 'A01', 'disponible', '2027-03-08');
    await t.main.lot(p, 'A02', 'disponible', '2027-03-12');
    const ref = new Referencement(t.db, t.journal, { now: t.now });
    const ids = await t.siteIds(t.main.id);
    const plan = await ref.sitemap(t.main.id, ids.get(NET)!);
    expect(neufEntries(plan)).toEqual([{ loc: `${NET}/neuf/${p}`, lastmod: '2027-03-12', kind: 'neuf' }]);
    expect(plan.ok && plan.xml).toContain(`<url><loc>${NET}/neuf/${p}</loc><lastmod>2027-03-12</lastmod></url>`);
    // L'adresse donnée aux moteurs est bien servie par le site du réseau.
    expect((await t.get(`${NET}/neuf/${p}`))!.status).toBe(200);
    // Jamais sur le site d'un agent, même celui de l'agent du programme [R153].
    expect(neufEntries(await ref.sitemap(t.main.id, ids.get(AGENT_SITE)!))).toEqual([]);
  });

  it('[R543] un programme sans lot publié n’est pas au plan', async () => {
    const t = await setup();
    const empty = await t.main.program('Le Programme Sans Lot');
    const gone = await t.main.program('Le Clos Vendu');
    await t.main.lot(gone, 'B01', 'disponible', '2027-03-10');
    await t.main.lot(gone, 'B01', 'vendu', '2027-03-11');
    await t.main.lot(gone, 'B02', 'option', '2027-03-11');
    await t.main.lot(gone, 'B03', 'reserve', '2027-03-11');
    await t.main.lot(gone, 'B04', 'disponible', '2027-02-28');
    const ids = await t.siteIds(t.main.id);
    const ref = new Referencement(t.db, t.journal, { now: t.now });
    expect(neufEntries(await ref.sitemap(t.main.id, ids.get(NET)!))).toEqual([]);
    expect(empty).not.toBe(gone);
    // Le lot B04 reconfirmé : la grille revient au plan.
    await t.main.lot(gone, 'B04', 'disponible', '2027-03-14');
    expect(neufEntries(await ref.sitemap(t.main.id, ids.get(NET)!)).map((e) => e.loc)).toEqual([`${NET}/neuf/${gone}`]);
  });

  it('un programme d’un autre réseau n’est pas au plan', async () => {
    const t = await setup();
    const other = await t.network('Autre réseau', () => [{ kind: 'reseau', baseUrl: OTHER, active: true }]);
    const theirs = await other.program('Le Programme d’Ailleurs');
    await other.lot(theirs, 'C01', 'disponible', '2027-03-12');
    const ours = await t.main.program('Les Jardins Inventés');
    await t.main.lot(ours, 'A01', 'disponible', '2027-03-12');
    const ref = new Referencement(t.db, t.journal, { now: t.now });
    const plan = await ref.sitemap(t.main.id, (await t.siteIds(t.main.id)).get(NET)!);
    expect(neufEntries(plan).map((e) => e.loc)).toEqual([`${NET}/neuf/${ours}`]);
    expect(plan.ok && plan.xml).not.toContain(theirs);
    expect(neufEntries(await ref.sitemap(other.id, (await t.siteIds(other.id)).get(OTHER)!)).map((e) => e.loc)).toEqual([`${OTHER}/neuf/${theirs}`]);
  });

  it('[R26] la grille est signalée publiée, modifiée quand un prix change, retirée au dernier lot vendu, sans appeler le service en essai', async () => {
    const t = await setup();
    const calls: unknown[] = [];
    const indexNow: IndexNowClient = { submit: async (...a: unknown[]) => void calls.push(a) } as unknown as IndexNowClient;
    const ref = new Referencement(t.db, t.journal, { now: t.now, indexNow });
    const p = await t.main.program('Les Jardins Inventés');
    const url = `${NET}/neuf/${p}`;
    const rows = async () => t.db.all<{ change: string; outcome: string }>('SELECT change, outcome FROM seo_signals WHERE url = ? ORDER BY rowid', [url]);
    await ref.signalChanges(t.main.id);
    expect(await rows()).toEqual([]);
    await t.main.lot(p, 'A01', 'disponible', '2027-03-12');
    await ref.signalChanges(t.main.id);
    expect(await rows()).toEqual([{ change: 'publiee', outcome: 'essai' }]);
    // Rien ne change : rien n'est signalé de nouveau.
    await ref.signalChanges(t.main.id);
    expect(await rows()).toHaveLength(1);
    await t.main.lot(p, 'A01', 'disponible', '2027-03-12', 24_000_000);
    await ref.signalChanges(t.main.id);
    expect(await rows()).toEqual([{ change: 'publiee', outcome: 'essai' }, { change: 'modifiee', outcome: 'essai' }]);
    await t.main.lot(p, 'A01', 'vendu', '2027-03-14');
    await ref.signalChanges(t.main.id);
    expect(await rows()).toEqual([{ change: 'publiee', outcome: 'essai' }, { change: 'modifiee', outcome: 'essai' }, { change: 'retiree', outcome: 'essai' }]);
    expect(calls).toEqual([]);
  });
});
