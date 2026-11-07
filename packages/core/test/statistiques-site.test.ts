import { expect, it } from 'vitest';
import { StatistiquesSite } from '../src/statistiques-site/statistiques.ts';
import { readSchema } from '../src/conformite/registre.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, communes, contacts et contenus inventés.
const NOW = Date.parse('2026-12-07T10:00:00.000Z');
const DAY = 86_400_000;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = NOW;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const stats = new StatistiquesSite(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  const bien = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'B1', kind: 'home', postalCode: '21800', city: 'Quetigny-Test', status: 'available' });
  let codes = 0;
  const content = async (kind: string, ref: string, networkId = network.id) => {
    codes += 1;
    const id = `code${'abcdefgh'.slice(0, 8 - String(codes).length)}${[...String(codes)].map((d) => 'abcdefghij'[Number(d)]).join('')}`;
    await db.run('INSERT INTO public_contents (id, network_id, kind, ref, created_at) VALUES (?, ?, ?, ?, ?)', [id, networkId, kind, ref, new Date(NOW).toISOString()]);
    return id;
  };
  let m = 0;
  /** Une conversation venue de tel contenu, d'une personne qui vend, achète ou n'est pas encore rattachée. */
  const demande = async (contentId: string | null, o: { project?: string | null; mandate?: boolean; at?: number; conv?: string } = {}) => {
    m += 1;
    let personId: string | null = null;
    if (o.project !== null) {
      const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Inès', lastName: `Durand${m}` });
      personId = person.id;
      if (o.project) await store.createProject({ networkId: network.id, agentId: alex.id, personId, kind: o.project as 'sell' });
      if (o.mandate) {
        await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'site', 'test', ?)", [
          `m${m}`,
          network.id,
          alex.id,
          personId,
          bien.id,
          new Date((o.at ?? NOW - 10 * DAY) + DAY).toISOString(),
          new Date(NOW).toISOString(),
        ]);
      }
    }
    const id = `in-${m}`;
    const at = new Date(o.at ?? NOW - 10 * DAY).toISOString();
    await db.run(
      `INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, external_id, conversation_ref, sender_name, body, status, person_id, received_at, created_at)
       VALUES (?, ?, ?, 'site', 'form', ?, ?, 'Personne Inventée', 'Bonjour', 'processed', ?, ?, ?)`,
      [id, network.id, `k-${id}`, `ext-${id}`, o.conv ?? null, personId, at, at],
    );
    if (contentId) {
      const kind = (await db.first<{ kind: string }>('SELECT kind FROM public_contents WHERE id = ?', [contentId]))!.kind;
      await db.run("INSERT INTO contact_origins (id, network_id, inbound_id, content_id, content_kind, method, recorded_at) VALUES (?, ?, ?, ?, ?, 'lien', ?)", [`o-${id}`, network.id, id, contentId, kind, at]);
    }
    return id;
  };
  const views = async (code: string, n: number) => {
    for (let i = 0; i < n; i += 1) expect(await stats.countView(network.id, code)).toEqual({ ok: true });
  };
  const zone = async (agentId: string, commune: string) =>
    db.run('INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at) VALUES (?, ?, ?, ?, ?)', [`z-${agentId}-${commune}`, network.id, agentId, commune, new Date(NOW).toISOString()]);
  return { db, journal, stats, store, network, other, alex, sam, as, direction: as('direction', 'd1'), agentAlex: as('agent', alex.id), agentSam: as('agent', sam.id), bien, content, demande, views, zone, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('HX15 · statistiques du site', () => {
  it('[R285] [R156] une vue n’est qu’un compteur par contenu et par jour : rien du visiteur n’est gardé', async () => {
    const t = await setup();
    const page = await t.content('prix', 'dijon-test');
    await t.views(page, 3);
    t.setClock(NOW + DAY);
    await t.views(page, 1);
    expect(await t.db.all('SELECT content_id, day, views FROM site_page_views ORDER BY day')).toEqual([
      { content_id: page, day: '2026-12-07', views: 3 },
      { content_id: page, day: '2026-12-08', views: 1 },
    ]);
    // La table n'a aucune place pour une donnée du visiteur.
    const schema = readSchema(loadMigrations());
    const cols = schema.get('site_page_views');
    expect(cols ? [...cols.columns].sort() : null).toEqual(['content_id', 'day', 'network_id', 'views']);
    // Un code inconnu, d'un autre réseau, ou qui n'en est pas un : rien n'est compté.
    const elsewhere = await t.content('prix', 'ailleurs-test', t.other.id);
    for (const bad of [elsewhere, 'pas-un-code', 'zzzzzzzzzzzz', 42, null]) expect(await t.stats.countView(t.network.id, bad)).toEqual({ ok: false, code: 'unknown_content' });
    expect(await t.db.first<{ n: number }>('SELECT SUM(views) AS n FROM site_page_views')).toEqual({ n: 4 });
    // Un compteur ne descend pas et ne s'efface pas.
    await expect(t.db.run('UPDATE site_page_views SET views = 0')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM site_page_views')).rejects.toThrow();
  });

  it('[R286] chaque statistique relie la page à des demandes réelles : demandes, vendeurs et mandats, chacun par son message', async () => {
    const t = await setup();
    const prix = await t.content('prix', 'dijon-test');
    const quartier = await t.content('quartier', 'dijon-test/centre');
    await t.views(prix, 40);
    await t.views(quartier, 10);
    const v1 = await t.demande(prix, { project: 'sell', mandate: true });
    const v2 = await t.demande(prix, { project: 'valuation' });
    const a1 = await t.demande(prix, { project: 'buy' });
    const n1 = await t.demande(prix, { project: null });
    const q1 = await t.demande(quartier, { project: 'sell' });
    // Une suite de la même conversation ne compte pas deux fois ; une conversation d'avant la période ne compte pas.
    await t.demande(prix, { project: 'buy', conv: 'conv-1' });
    await t.demande(null, { project: 'sell', conv: 'conv-1', at: NOW - 9 * DAY });
    await t.demande(prix, { project: 'sell', at: NOW - 120 * DAY });
    // Sans origine connue : aucune page ne la prend.
    await t.demande(null, { project: 'sell' });
    const r = await t.stats.pages(t.direction);
    expect(r).toMatchObject({ ok: true, firstDay: '2026-09-09', lastDay: '2026-12-07' });
    if (!r.ok) return;
    const byId = new Map(r.pages.map((p) => [p.contentId, p]));
    const p = byId.get(prix)!;
    expect(p.views).toBe(40);
    expect(p.demandes).toHaveLength(5);
    expect(p.demandes).toEqual(expect.arrayContaining([v1, v2, a1, n1]));
    expect(p.vendeurs).toEqual([v1, v2].sort());
    expect(p.mandats).toEqual([v1]);
    expect(p.vendeursPour1000Vues).toBe(50);
    expect(byId.get(quartier)).toMatchObject({ views: 10, demandes: [q1], vendeurs: [q1], mandats: [], vendeursPour1000Vues: 100 });
    // Chaque demande comptée est un message reçu du réseau.
    for (const page of r.pages) for (const id of page.demandes) expect(await t.db.first('SELECT id FROM inbound_messages WHERE id = ? AND network_id = ?', [id, t.network.id])).toEqual({ id });
    // Aucun nom dans le résultat.
    expect(JSON.stringify(r)).not.toMatch(/Inès|Durand|Inventée/);
    expect(await t.stats.pages(t.direction, { days: 3 })).toEqual({ ok: false, rule: null, code: 'bad_period' });
  });

  it('[R286] [R16] l’agent voit sa page et ses biens ; ni la conformité ni un agent parti ne voient rien', async () => {
    const t = await setup();
    const pageAlex = await t.content('agent', t.alex.id);
    const pageSam = await t.content('agent', t.sam.id);
    const bien = await t.content('bien', t.bien.id);
    const prix = await t.content('prix', 'dijon-test');
    for (const c of [pageAlex, pageSam, bien, prix]) await t.views(c, 2);
    const alex = await t.stats.pages(t.agentAlex);
    expect(alex.ok && alex.pages.map((p) => p.contentId).sort()).toEqual([pageAlex, bien].sort());
    const sam = await t.stats.pages(t.agentSam);
    expect(sam.ok && sam.pages.map((p) => p.contentId)).toEqual([pageSam]);
    expect(await t.stats.pages(t.as('compliance', 'c1'))).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.stats.pages({ role: 'agent', userId: t.alex.id, networkId: t.other.id })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.stats.nextPage(t.as('compliance', 'c1'))).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R287] la prochaine page à écrire : la sorte qui amène le plus de vendeurs par vue, dans la commune qui ne l’a pas encore', async () => {
    const t = await setup();
    await t.zone(t.alex.id, 'Dijon-Test');
    await t.zone(t.alex.id, 'Quetigny-Test');
    await t.zone(t.sam.id, 'Talant-Test');
    const prix = await t.content('prix', 'dijon-test');
    const quartier = await t.content('quartier', 'dijon-test/centre');
    const bien = await t.content('bien', t.bien.id);
    // Sans vendeur mesuré : rien n'est proposé.
    expect(await t.stats.nextPage(t.direction)).toEqual({ ok: true, suggestion: null, reason: 'aucun_vendeur_mesure' });
    await t.views(prix, 50);
    await t.views(quartier, 10);
    await t.demande(prix, { project: 'sell' });
    await t.demande(quartier, { project: 'sell' });
    // Deux vendeurs déjà arrivés par un bien de Quetigny-Test.
    await t.demande(bien, { project: 'sell' });
    await t.demande(bien, { project: 'valuation' });
    // Quartier : 1 vendeur pour 10 vues, mieux que prix (1 pour 50). Dijon-Test a déjà sa page de quartier ; Quetigny-Test,
    // où arrivent déjà deux vendeurs, passe avant Talant-Test.
    const r = await t.stats.nextPage(t.direction);
    expect(r).toEqual({
      ok: true,
      reason: 'proposee',
      suggestion: {
        kind: 'quartier',
        commune: 'Quetigny-Test',
        path: '/quartiers/quetigny-test/',
        figures: { kindVendeurs: 1, kindViews: 10, communeVendeurs: 2 },
        text: 'Écrire la page de quartier de Quetigny-Test : sur la période, les pages de quartier ont amené 1 vendeur pour 10 vues (100 pour 1 000 vues), et Quetigny-Test n\'a pas encore la sienne alors que 2 vendeurs y sont déjà arrivés par le site.',
      },
    });
    // L'agent : seulement ses communes.
    const sam = await t.stats.nextPage(t.agentSam);
    expect(sam).toMatchObject({ ok: true, reason: 'proposee', suggestion: { kind: 'quartier', commune: 'Talant-Test', figures: { communeVendeurs: 0 } } });
    if (sam.ok && sam.suggestion) expect(sam.suggestion.text).toBe('Écrire la page de quartier de Talant-Test : sur la période, les pages de quartier ont amené 1 vendeur pour 10 vues (100 pour 1 000 vues), et Talant-Test n\'a pas encore la sienne.');
    // Toutes les communes ont leur page : rien n'est proposé.
    await t.content('quartier', 'quetigny-test/centre');
    await t.content('quartier', 'talant-test/centre');
    expect(await t.stats.nextPage(t.direction)).toEqual({ ok: true, suggestion: null, reason: 'toutes_les_communes_ont_leur_page' });
  });

  it('[R287] à égalité de vendeurs par vue, la sorte qui en amène le plus passe d’abord ; le même jeu donne la même proposition', async () => {
    const t = await setup();
    await t.zone(t.alex.id, 'Dijon-Test');
    const prix = await t.content('prix', 'autre-test');
    const quartier = await t.content('quartier', 'autre-test/centre');
    await t.views(prix, 20);
    await t.views(quartier, 10);
    await t.demande(prix, { project: 'sell' });
    await t.demande(prix, { project: 'sell' });
    await t.demande(quartier, { project: 'sell' });
    const a = await t.stats.nextPage(t.direction);
    expect(a).toMatchObject({ ok: true, suggestion: { kind: 'prix', commune: 'Dijon-Test', path: '/prix/dijon-test' } });
    expect(await t.stats.nextPage(t.direction)).toEqual(a);
  });
});
