import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { PUBLIC_PATHS, attirerRoutes, handleAttirerPublic, type AttirerServices } from '../src/attirer.ts';
import { ProgrammesNeufs, areaOf, dayOf, eurosOf, floorOf, sourceText } from '../../core/src/neuf-viager/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, promoteur, programme, lots et barèmes inventés ; adresses en exemple.test.
const NET = 'https://reseau.exemple.test';
const AGENT_SITE = 'https://alex.exemple.test';

async function setup(opts: { scales?: boolean; promoter?: string; name?: string } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-03-15T09:00:00.000Z');
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alexandrine', lastName: 'Inventée' })).id;
  const direction = { role: 'direction', userId: 'dir-1', networkId: network } as Viewer;
  const as: AttirerServices = { db, journal, now };
  const sites = attirerRoutes().find((r) => r.method === 'POST' && r.pattern.test('/attirer/sites'))!;
  for (const site of [{ kind: 'reseau', baseUrl: NET, active: true }, { kind: 'agent', agentId: alex, baseUrl: AGENT_SITE, active: true }]) {
    const res = await sites.handle(as, direction, [], new Request('https://api.exemple.test/attirer/sites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(site) }));
    expect(res.status).toBe(200);
  }
  const promoter = crypto.randomUUID();
  await db.run('INSERT INTO partners (id, network_id, trade, business_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    promoter,
    network,
    'promoteur',
    opts.promoter ?? 'Promoteur Inventé',
    'direction:dir-1',
    '2027-01-01T00:00:00.000Z',
  ]);
  const neuf = new ProgrammesNeufs(db, journal, { now });
  const created = await neuf.createProgram(direction, { promoterPartnerId: promoter, agentId: alex, name: opts.name ?? 'Les Jardins Inventés', city: 'Dijon', postalCode: '21000' });
  if (!created.ok) throw new Error(created.code);
  const program = created.value.programId;
  if (opts.scales !== false) {
    expect((await neuf.setFeeScale(direction, { kind: 'neuf', rateBp: 250, source: 'Barème du neuf inventé', validFrom: '2027-01-01' })).ok).toBe(true);
    expect((await neuf.setFeeScale(direction, { kind: 'ancien', rateBp: 750, source: 'Barème de l’ancien inventé', validFrom: '2027-01-01' })).ok).toBe(true);
  }
  const lot = async (lotRef: string, status: string, confirmedOn: string, priceCents = 25_000_000) => {
    const r = await neuf.recordLot(direction, program, { lotRef, typology: 't3', livingAreaHundredths: 6550, floor: 2, priceCents, status, confirmedOn });
    expect(r.ok).toBe(true);
  };
  const get = (url: string, method = 'GET') => handleAttirerPublic(as, new Request(url, { method }));
  return { db, network, alex, program, lot, get, setNow: (iso: string) => (clock = Date.parse(iso)) };
}

it('BR76 · les mises en forme de la grille', () => {
  expect(eurosOf(25_000_000)).toBe('250 000 €');
  expect(eurosOf(25_000_050)).toBe('250 000,50 €');
  expect(areaOf(6500)).toBe('65 m²');
  expect(areaOf(6550)).toBe('65,5 m²');
  expect(areaOf(6555)).toBe('65,55 m²');
  expect(floorOf(0)).toBe('Rez-de-chaussée');
  expect(floorOf(1)).toBe('1er étage');
  expect(floorOf(-1)).toBe('Sous-sol 1');
  expect(dayOf('2027-03-01')).toBe('1er mars 2027');
  expect(sourceText('bareme:0c1d · Barème inventé')).toBe('Barème inventé');
  expect(Object.values(PUBLIC_PATHS).some((p) => p.test('/neuf/0c1d2e3f-aaaa-bbbb-cccc-000000000000'))).toBe(true);
  expect(Object.values(PUBLIC_PATHS).some((p) => p.test('/neuf/a/b'))).toBe(false);
});

describeWithSqlite('BR76 · la grille d’un programme neuf sur le site du réseau', () => {
  it('[R543] seuls les lots disponibles confirmés depuis 14 jours au plus sont montrés', async () => {
    const t = await setup();
    await t.lot('A01', 'disponible', '2027-03-10');
    await t.lot('A02', 'disponible', '2027-03-10');
    await t.lot('A02', 'vendu', '2027-03-12');
    await t.lot('A03', 'option', '2027-03-12');
    await t.lot('A04', 'reserve', '2027-03-12');
    await t.lot('A05', 'disponible', '2027-02-20');
    await t.lot('A06', 'disponible', '2027-03-01');
    const res = (await t.get(`${NET}/neuf/${t.program}`))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const html = await res.text();
    expect(html).toContain('Lot A01');
    expect(html).toContain('Lot A06');
    for (const gone of ['A02', 'A03', 'A04', 'A05']) expect(html).not.toContain(`Lot ${gone}`);
    // Le lendemain, A06 dépasse 14 jours : il n'est plus publié tant qu'on ne le reconfirme pas.
    t.setNow('2027-03-16T09:00:00.000Z');
    const next = await (await t.get(`${NET}/neuf/${t.program}`))!.text();
    expect(next).toContain('Lot A01');
    expect(next).not.toContain('Lot A06');
  });

  it('[R544] [R10] chaque frais porte sa source et sa date, sans identifiant interne', async () => {
    const t = await setup();
    await t.lot('A01', 'disponible', '2027-03-10');
    const html = await (await t.get(`${NET}/neuf/${t.program}`))!.text();
    expect(html).toContain('250 000 €');
    // 2,5 % de 250 000 € = 6 250 € ; 7,5 % = 18 750 € ; écart 12 500 €.
    expect(html).toContain('Frais d’acquisition du neuf : 6\u202f250\u00a0€ <span class="doux">(prix TTC du lot × 250 points de base (barème du neuf))</span>');
    expect(html).toContain('Frais de l’ancien, au même prix : 18\u202f750\u00a0€ <span class="doux">(même prix × 750 points de base (barème de l’ancien))</span>');
    expect(html).toContain('Économie face à l’ancien : 12\u202f500\u00a0€ <span class="doux">(frais de l’ancien − frais du neuf, au même prix)</span>');
    expect(html).toContain('Barème du neuf : Barème du neuf inventé, en vigueur depuis le 1er janvier 2027.');
    expect(html).toContain('Barème de l’ancien : Barème de l’ancien inventé, en vigueur depuis le 1er janvier 2027.');
    expect(html).not.toContain('bareme:');
    expect(html).toContain('65,5 m²');
    expect(html).toContain('Confirmé le 10 mars 2027');
  });

  it('[R544] sans barème, aucun frais n’est écrit et la page le dit', async () => {
    const t = await setup({ scales: false });
    await t.lot('A01', 'disponible', '2027-03-10');
    const html = await (await t.get(`${NET}/neuf/${t.program}`))!.text();
    expect(html).toContain('non calculés, barème absent');
    expect(html).toContain('le barème n’est pas encore rangé');
    expect(html).not.toContain('Économie face à l’ancien');
    expect(html).not.toContain('D’où viennent les frais');
  });

  it('[R543] aucun nom d’agent, de client ni d’auteur de version ; le contact mène à la liste quand la page de l’agent n’est pas publiable', async () => {
    const t = await setup();
    await t.lot('A01', 'disponible', '2027-03-10');
    const html = await (await t.get(`${NET}/neuf/${t.program}`))!.text();
    for (const secret of ['Alexandrine', 'Inventée', t.alex, 'dir-1', 'direction:']) expect(html).not.toContain(secret);
    expect(html).toContain('href="/agents"');
    expect(html).toContain('Promoteur Inventé');
  });

  it('[R153] servie sur le site du réseau seul : 404 ailleurs, pour un programme inconnu ou d’un autre réseau', async () => {
    const t = await setup();
    await t.lot('A01', 'disponible', '2027-03-10');
    expect((await t.get(`${AGENT_SITE}/neuf/${t.program}`))!.status).toBe(404);
    expect((await t.get(`${NET}/neuf/inconnu`))!.status).toBe(404);
    expect((await t.get(`https://inconnu.exemple.test/neuf/${t.program}`))!.status).toBe(404);
    // Un programme d'un autre réseau, dans la même base, n'est jamais lu par ce site.
    await t.db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-autre', 'Autre réseau', '2027-01-01T00:00:00.000Z')");
    await t.db.run("INSERT INTO agents (id, network_id, first_name, last_name, zone, created_at, updated_at) VALUES ('ag-autre', 'net-autre', 'Autre', 'Agent', 'Ville inventée', 'x', 'x')");
    await t.db.run("INSERT INTO partners (id, network_id, trade, business_name, created_by, created_at) VALUES ('pr-autre', 'net-autre', 'promoteur', 'Autre promoteur', 'direction:d', '2027-01-01T00:00:00.000Z')");
    await t.db.run(
      "INSERT INTO new_programs (id, network_id, promoter_partner_id, agent_id, name, city, postal_code, created_by, created_at) VALUES ('prog-autre', 'net-autre', 'pr-autre', 'ag-autre', 'Autre programme', 'Beaune', '21200', 'direction:d', '2027-01-01T00:00:00.000Z')",
    );
    expect((await t.get(`${NET}/neuf/prog-autre`))!.status).toBe(404);
  });

  it('GET et HEAD seulement, non indexée en essai', async () => {
    const t = await setup();
    await t.lot('A01', 'disponible', '2027-03-10');
    const res = (await t.get(`${NET}/neuf/${t.program}`))!;
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(await res.text()).toContain('<meta name="robots" content="noindex">');
    expect((await t.get(`${NET}/neuf/${t.program}`, 'POST'))!.status).toBe(405);
    const head = (await t.get(`${NET}/neuf/${t.program}`, 'HEAD'))!;
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('un programme sans lot publié dit qu’aucun lot n’est disponible', async () => {
    const t = await setup();
    await t.lot('A01', 'option', '2027-03-10');
    const html = await (await t.get(`${NET}/neuf/${t.program}`))!.text();
    expect(html).toContain('Aucun lot n’est disponible et confirmé en ce moment.');
    expect(html).not.toContain('Lot A01');
  });

  it('tout texte venu de la base est échappé', async () => {
    const t = await setup({ promoter: '<script>alert(1)</script>', name: 'Les <b>Jardins</b>' });
    await t.lot('A01', 'disponible', '2027-03-10');
    const html = await (await t.get(`${NET}/neuf/${t.program}`))!.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<b>Jardins</b>');
    expect(html).toContain('Les &lt;b&gt;Jardins&lt;/b&gt;');
  });
});
