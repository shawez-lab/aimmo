import { MentionsSite, SITE_MENTION_FIELDS } from '../src/attirer/mentions-site.ts';
import { MiseEnService, launchDay } from '../src/conformite/mise-en-service.ts';
import { launchProofInputs } from './mise-en-service-jeu.ts';
import { expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { PageAgent, Referencement, agentStructuredData, jsonLd, listingStructuredData, renderSitemap, type IndexNowClient } from '../src/attirer/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseaux, agents, biens et adresses de sites inventés.
const direction = { role: 'direction' as const, userId: 'dir-1', networkId: 'net-1' };
const NET = 'https://reseau.exemple.test';
const CAMILLE = 'https://camille.exemple.test';

async function setup(options: { indexNow?: IndexNowClient; mode?: 'essai' | 'reel' } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  let clock = Date.parse('2026-10-29T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  let n = 0;
  const newId = (): string => `id-${++n}`;
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', '2026-01-01T00:00:00.000Z')");
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-2', 'Autre réseau', '2026-01-01T00:00:00.000Z')");
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, zone, created_at, updated_at) VALUES ('ag-1', 'net-1', 'Camille', 'Exemple', 'Dijon centre', 'x', 'x')");
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, zone, created_at, updated_at) VALUES ('ag-3', 'net-1', 'Lou', 'Essai', 'Chenôve', 'x', 'x')");
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, status, created_at, updated_at) VALUES ('ag-2', 'net-1', 'Paul', 'Parti', 'left', 'x', 'x')");
  const ref = new Referencement(db, journal, { now, newId, ...options });
  return { db, journal, ref, now };
}

/**
 * Toutes les mentions du site, inventées ; sans `all`, il en manque encore une. Avec `proofs` (par défaut : `all`), les
 * preuves du tableau de mise en service sont aussi déclarées, valides ce jour (AU088).
 */
async function completeMentions(db: SqlDatabase, journal: SqlJournalStore, all: boolean, now: () => Date = () => new Date(), proofs = all) {
  const fields = Object.keys(SITE_MENTION_FIELDS).filter((f) => all || f !== 'mediateur');
  expect(await new MentionsSite(db, journal, { now }).set(direction, Object.fromEntries(fields.map((f) => [f, `Texte inventé ${f}`])))).toEqual({ ok: true });
  if (!(await db.first("SELECT 1 AS x FROM listing_settings WHERE id = 's-mentions'"))) {
    await db.exec('PRAGMA foreign_keys = OFF');
    await db.run("INSERT INTO listing_settings (id, network_id, card_number, set_by, set_at) VALUES ('s-mentions', 'net-1', 'CPI 0000', 'direction:dir-1', 'x')");
    await db.run("INSERT INTO card_holders (id, network_id, holder_name, set_by, set_at) VALUES ('h-mentions', 'net-1', 'Société Exemple', 'direction:dir-1', 'x')");
    await db.exec('PRAGMA foreign_keys = ON');
  }
  if (!proofs) return;
  const launch = new MiseEnService(db, journal, { now });
  for (const input of launchProofInputs(launchDay(now()), 'CPI 0000')) expect((await launch.declare(direction, input)).ok).toBe(true);
}

async function listing(db: SqlDatabase, id: string, agent: string, seq: number, state: string, title = `Maison ${id}`, price = 250000) {
  await db.exec('PRAGMA foreign_keys = OFF');
  await db.run(
    "INSERT OR IGNORE INTO properties (id, network_id, agent_id, reference, kind, postal_code, city, created_at, updated_at) VALUES (?, 'net-1', ?, ?, 'home', '99000', 'Ville inventée', 'x', 'x')",
    [id, agent, `REF-${id}`],
  );
  await db.run(
    "INSERT INTO listing_versions (id, property_id, network_id, seq, state, draft_id, price_eur, payload, payload_hash, reason, created_at) VALUES (?, ?, 'net-1', ?, ?, ?, ?, ?, 'h', 'test', ?)",
    [
      `${id}-${seq}`,
      id,
      seq,
      state,
      state === 'retiree' ? null : `d-${id}-${seq}`,
      state === 'retiree' ? null : price,
      JSON.stringify({ reference: `REF-${id}`, state, title, body: 'Texte', mentions: 'Classe énergie D, classe climat C.', priceEur: price, media: [] }),
      `2026-10-${String(10 + seq).padStart(2, '0')}T09:00:00.000Z`,
    ],
  );
  await db.exec('PRAGMA foreign_keys = ON');
}

async function sites(t: Awaited<ReturnType<typeof setup>>) {
  const net = await t.ref.setSite(direction, { kind: 'reseau', baseUrl: NET, active: true });
  const cam = await t.ref.setSite(direction, { kind: 'agent', agentId: 'ag-1', baseUrl: CAMILLE, active: true });
  if (!net.ok || !cam.ok) throw new Error('sites');
  return { net: net.siteId, cam: cam.siteId };
}

const locs = (r: Awaited<ReturnType<Referencement['sitemap']>>): string[] => (r.ok ? r.entries.map((e) => e.loc) : []);

describeWithSqlite('AT04 · référencement : plan du site, données structurées, page de référence unique', () => {
  it('[R153] un bien test publié apparaît dans le plan des deux sites, sous la même page de référence : celle du site de son agent', async () => {
    const t = await setup();
    const s = await sites(t);
    await listing(t.db, 'b1', 'ag-1', 1, 'en_vente');
    await listing(t.db, 'b2', 'ag-3', 1, 'sous_offre');
    expect(await t.ref.canonicalFor('net-1', 'b1')).toBe(`${CAMILLE}/biens/b1`);
    // L'agent sans site : la page du réseau.
    expect(await t.ref.canonicalFor('net-1', 'b2')).toBe(`${NET}/biens/b2`);
    const network = await t.ref.sitemap('net-1', s.net);
    const own = await t.ref.sitemap('net-1', s.cam);
    expect(locs(network).filter((l) => l.includes('/biens/'))).toEqual([`${CAMILLE}/biens/b1`, `${NET}/biens/b2`]);
    expect(locs(own).filter((l) => l.includes('/biens/'))).toEqual([`${CAMILLE}/biens/b1`]);
    if (!network.ok) throw new Error('plan');
    expect(network.entries.find((e) => e.loc.endsWith('/b1'))).toEqual({ loc: `${CAMILLE}/biens/b1`, lastmod: '2026-10-11', kind: 'bien' });
    // Le site de l'agent mis hors service : ses biens reviennent à la page du réseau, une seule à la fois.
    expect(await t.ref.setSite(direction, { kind: 'agent', agentId: 'ag-1', baseUrl: CAMILLE, active: false })).toMatchObject({ ok: true });
    expect(await t.ref.canonicalFor('net-1', 'b1')).toBe(`${NET}/biens/b1`);
    expect((await t.ref.sitemap('net-1', s.cam)).ok).toBe(false);
    // Un autre réseau ne voit rien de ce réseau.
    expect(await t.ref.canonicalFor('net-2', 'b1')).toBeNull();
  });

  it('[R153] aucune page de référence vers une page non publiée : brouillon, vendu, retiré ou incomplet', async () => {
    const t = await setup();
    const s = await sites(t);
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO properties (id, network_id, agent_id, reference, kind, created_at, updated_at) VALUES ('brouillon', 'net-1', 'ag-1', 'REF-br', 'home', 'x', 'x')");
    await t.db.exec('PRAGMA foreign_keys = ON');
    await listing(t.db, 'vendu', 'ag-1', 1, 'en_vente');
    await listing(t.db, 'vendu', 'ag-1', 2, 'vendu');
    await listing(t.db, 'vide', 'ag-1', 1, 'en_vente', '');
    for (const id of ['brouillon', 'vendu', 'vide', 'inconnu', '../x']) expect(await t.ref.canonicalFor('net-1', id), id).toBeNull();
    expect(await t.ref.listingSeo('net-1', 'vendu')).toBeNull();
    expect(locs(await t.ref.sitemap('net-1', s.net)).filter((l) => l.includes('/biens/'))).toEqual([]);
    // Sans aucun site en service, aucune page de référence.
    const u = await setup();
    await listing(u.db, 'b1', 'ag-1', 1, 'en_vente');
    expect(await u.ref.canonicalFor('net-1', 'b1')).toBeNull();
  });

  it('[R153] [R26] un bien retiré sort du plan et est signalé ; en mode essai, rien ne part, chaque page une seule fois', async () => {
    const calls: string[][] = [];
    const t = await setup({ indexNow: { submit: async (_h, urls) => void calls.push([...urls]) } });
    const s = await sites(t);
    await listing(t.db, 'b1', 'ag-1', 1, 'en_vente');
    await listing(t.db, 'b2', 'ag-3', 1, 'en_vente');
    expect(await t.ref.signalChanges('net-1')).toEqual({ mode: 'essai', signalled: 2, failed: 0 });
    // Rien de nouveau : rien n'est signalé de nouveau.
    expect(await t.ref.signalChanges('net-1')).toEqual({ mode: 'essai', signalled: 0, failed: 0 });
    // Une nouvelle version : modifiée ; un retrait : retirée.
    await listing(t.db, 'b1', 'ag-1', 2, 'sous_offre');
    await listing(t.db, 'b2', 'ag-3', 2, 'retiree');
    expect(await t.ref.signalChanges('net-1')).toEqual({ mode: 'essai', signalled: 2, failed: 0 });
    expect(locs(await t.ref.sitemap('net-1', s.net))).not.toContain(`${NET}/biens/b2`);
    const rows = await t.db.all<{ url: string; change: string; mode: string; outcome: string }>('SELECT url, change, mode, outcome FROM seo_signals ORDER BY rowid');
    expect(rows).toEqual([
      { url: `${CAMILLE}/biens/b1`, change: 'publiee', mode: 'essai', outcome: 'essai' },
      { url: `${NET}/biens/b2`, change: 'publiee', mode: 'essai', outcome: 'essai' },
      { url: `${CAMILLE}/biens/b1`, change: 'modifiee', mode: 'essai', outcome: 'essai' },
      { url: `${NET}/biens/b2`, change: 'retiree', mode: 'essai', outcome: 'essai' },
    ]);
    // Le service n'a jamais été appelé : en essai, rien ne part [R26].
    expect(calls).toEqual([]);
    // Le mode réel demandé sans service reste en essai.
    const u = await setup({ mode: 'reel' });
    await sites(u);
    await listing(u.db, 'b1', 'ag-1', 1, 'en_vente');
    expect((await u.ref.signalChanges('net-1')).mode).toBe('essai');
    // Au passage en mode réel, les pages connues pendant l'essai partent une fois.
    const sent: string[] = [];
    const real = new Referencement(t.db, t.journal, { mode: 'reel', indexNow: { submit: async (_h, urls) => void sent.push(...urls) } });
    // [R221] Une mention légale manque : le site reste en essai, rien ne part.
    await completeMentions(t.db, t.journal, false);
    expect((await real.signalChanges('net-1')).mode).toBe('essai');
    expect(sent).toEqual([]);
    // [R675] Toutes les mentions, mais aucune preuve de mise en service : toujours l'essai.
    await completeMentions(t.db, t.journal, true, undefined, false);
    expect((await real.signalChanges('net-1')).mode).toBe('essai');
    expect(sent).toEqual([]);
    await completeMentions(t.db, t.journal, true);
    expect(await real.signalChanges('net-1')).toEqual({ mode: 'reel', signalled: 1, failed: 0 });
    expect(sent).toEqual([`${CAMILLE}/biens/b1`]);
    expect(await real.signalChanges('net-1')).toEqual({ mode: 'reel', signalled: 0, failed: 0 });
  });

  it('en mode réel, un appel par hôte ; une panne est rangée et la page signalée de nouveau au passage suivant', async () => {
    const calls: { host: string; urls: string[] }[] = [];
    let down = true;
    const t = await setup({
      mode: 'reel',
      indexNow: {
        submit: async (host, urls) => {
          calls.push({ host, urls: [...urls] });
          if (down && host === 'camille.exemple.test') throw new TypeError('panne');
        },
      },
    });
    await sites(t);
    await completeMentions(t.db, t.journal, true, t.now);
    await listing(t.db, 'b1', 'ag-1', 1, 'en_vente');
    await listing(t.db, 'b2', 'ag-3', 1, 'en_vente');
    expect(await t.ref.signalChanges('net-1')).toEqual({ mode: 'reel', signalled: 1, failed: 1 });
    expect(calls).toEqual([
      { host: 'camille.exemple.test', urls: [`${CAMILLE}/biens/b1`] },
      { host: 'reseau.exemple.test', urls: [`${NET}/biens/b2`] },
    ]);
    down = false;
    expect(await t.ref.signalChanges('net-1')).toEqual({ mode: 'reel', signalled: 1, failed: 0 });
    expect(calls[2]).toEqual({ host: 'camille.exemple.test', urls: [`${CAMILLE}/biens/b1`] });
    const types = (await t.journal.all()).map((e) => e.type);
    expect(types).toContain('referencement.signalement_echec');
  });

  it('[R46] les données structurées ne portent ni voie, ni numéro, ni code postal ; un texte ne ferme jamais la balise', async () => {
    const t = await setup();
    await sites(t);
    await listing(t.db, 'b1', 'ag-1', 1, 'en_vente', 'Maison </script><script>alert(1)</script> & jardin');
    const seo = await t.ref.listingSeo('net-1', 'b1');
    expect(seo?.canonical).toBe(`${CAMILLE}/biens/b1`);
    const text = seo!.structuredData;
    expect(text).not.toMatch(/<|>/);
    const data = JSON.parse(text);
    expect(data).toMatchObject({
      '@type': 'RealEstateListing',
      name: 'Maison </script><script>alert(1)</script> & jardin',
      url: `${CAMILLE}/biens/b1`,
      offers: { price: 250000, priceCurrency: 'EUR', availability: 'https://schema.org/InStock' },
      contentLocation: { address: { addressLocality: 'Ville inventée', addressCountry: 'FR' } },
      provider: { name: 'Camille Exemple' },
    });
    expect(JSON.stringify(data)).not.toMatch(/99000|postalCode|streetAddress/);
    expect(JSON.parse(listingStructuredData({ canonical: `${NET}/biens/b9`, title: 'T', priceEur: 1, state: 'sous_offre', city: null, agentName: null }))).toEqual({
      '@context': 'https://schema.org',
      '@type': 'RealEstateListing',
      name: 'T',
      url: `${NET}/biens/b9`,
      offers: { '@type': 'Offer', price: 1, priceCurrency: 'EUR', availability: 'https://schema.org/LimitedAvailability' },
    });
    expect(JSON.parse(agentStructuredData({ url: `${NET}/agents/ag-1`, firstName: 'Camille', lastName: 'Exemple', zone: 'Dijon centre' }))).toEqual({
      '@context': 'https://schema.org',
      '@type': 'RealEstateAgent',
      name: 'Camille Exemple',
      jobTitle: 'Agent immobilier',
      url: `${NET}/agents/ag-1`,
      areaServed: 'Dijon centre',
    });
    expect(jsonLd({ a: ' &' })).toBe('{"a":"\\u2028\\u0026"}');
  });

  it('[R16] [R153] seule la direction règle un site ; une adresse ne sert jamais deux sites en service', async () => {
    const t = await setup();
    const agent = { role: 'agent' as const, userId: 'ag-1', networkId: 'net-1' };
    expect(await t.ref.setSite(agent, { kind: 'agent', agentId: 'ag-1', baseUrl: CAMILLE, active: true })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.journal.all()).some((e) => e.type === 'acces.refuse')).toBe(true);
    for (const baseUrl of ['http://reseau.exemple.test', 'https://reseau.exemple.test/', 'https://reseau.exemple.test/chemin', 'https://user@reseau.exemple.test', 'javascript:alert(1)', 'https://RESEAU.exemple.test']) {
      expect(await t.ref.setSite(direction, { kind: 'reseau', baseUrl, active: true }), baseUrl).toEqual({ ok: false, rule: null, code: 'bad_url' });
    }
    expect(await t.ref.setSite(direction, { kind: 'agent', agentId: 'ag-2', baseUrl: 'https://paul.exemple.test', active: true })).toEqual({ ok: false, rule: 'R16', code: 'agent_parti' });
    expect(await t.ref.setSite(direction, { kind: 'agent', agentId: 'ag-x', baseUrl: 'https://x.exemple.test', active: true })).toEqual({ ok: false, rule: 'R16', code: 'unknown_agent' });
    expect(await t.ref.setSite(direction, { kind: 'reseau', agentId: 'ag-1', baseUrl: NET, active: true })).toEqual({ ok: false, rule: null, code: 'bad_agent' });
    await sites(t);
    expect(await t.ref.setSite(direction, { kind: 'agent', agentId: 'ag-3', baseUrl: CAMILLE, active: true })).toEqual({ ok: false, rule: 'R153', code: 'url_taken' });
    expect(await t.ref.setSite({ ...direction, networkId: 'net-2' }, { kind: 'reseau', baseUrl: NET, active: true })).toEqual({ ok: false, rule: 'R153', code: 'url_taken' });
    // Le même site, réglé de nouveau, reste permis.
    expect(await t.ref.setSite(direction, { kind: 'reseau', baseUrl: NET, active: true })).toMatchObject({ ok: true });
    await expect(t.db.run('DELETE FROM public_sites')).rejects.toThrow();
  });

  it('[R152] [R150] le plan du réseau liste les pages d’agent publiables et les pages de prix montrables, échappées', async () => {
    const t = await setup();
    const s = await sites(t);
    const pages = new PageAgent(t.db, t.journal, { now: t.now });
    expect(await pages.setLegalMentions(direction, 'ag-1', { rsacNumber: 'RSAC 123456789', rsacRegistry: 'Dijon' })).toEqual({ ok: true });
    await t.db.run("INSERT INTO listing_settings (id, network_id, card_number, set_by, set_at) VALUES ('s1', 'net-1', 'CPI 9999 0000 000 000 001', 'direction:dir-1', 'x')");
    expect(await pages.setCardHolder(direction, 'Société Exemple')).toEqual({ ok: true });
    // Une commune avec une case publiée, un quartier dont la seule case est retenue.
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO price_zones (id, network_id, level, parent_id, slug, label, insee_code, ring_json, ring_source, recorded_by, recorded_at) VALUES ('z1', 'net-1', 'commune', NULL, 'ville-inventee', 'Ville inventée', '99001', '[]', 'test', 'x', 'x')");
    await t.db.run("INSERT INTO price_zones (id, network_id, level, parent_id, slug, label, insee_code, ring_json, ring_source, recorded_by, recorded_at) VALUES ('z4', 'net-1', 'commune', NULL, 'ville-sans-case', 'Ville inventée', '99001', '[]', 'test', 'x', 'x')");
    await t.db.run("INSERT INTO price_zones (id, network_id, level, parent_id, slug, label, insee_code, ring_json, ring_source, recorded_by, recorded_at) VALUES ('z2', 'net-1', 'quartier', 'z1', 'centre', 'Centre', NULL, '[]', 'test', 'x', 'x')");
    await t.db.run("INSERT INTO price_zones (id, network_id, level, parent_id, slug, label, insee_code, ring_json, ring_source, recorded_by, recorded_at) VALUES ('z3', 'net-1', 'quartier', 'z1', 'gare', 'Gare', NULL, '[]', 'test', 'x', 'x')");
    await t.db.run(
      "INSERT INTO price_versions (id, network_id, source, dvf_last_sale, window_from, window_to, areas_digest, sales_digest, min_sales, round_to, status, computed_at, completed_at) VALUES ('v1', 'net-1', 'DVF', '2026-06-30', '2024-07-01', '2026-06-30', ?, ?, 5, 10, 'en_cours', 'x', NULL)",
      ['a'.repeat(64), 'b'.repeat(64)],
    );
    const cols = (await t.db.all<{ name: string; notnull: number }>("SELECT name, \"notnull\" FROM pragma_table_info('price_cells')")).map((c) => c.name);
    const insertCell = async (area: string, status: string, hold: string | null) => {
      const values: Record<string, unknown> = { version_id: 'v1', area_id: area, kind: 'apartment', status, hold_code: hold };
      const names = cols.filter((c) => c in values);
      await t.db.run(`INSERT INTO price_cells (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((c) => values[c] as string | null));
    };
    await insertCell('z1', 'publiee', null);
    await insertCell('z2', 'publiee', null);
    await insertCell('z3', 'retenue', 'seuil');
    await insertCell('z4', 'retenue', 'seuil');
    await t.db.run("UPDATE price_versions SET status = 'complet', completed_at = '2026-10-20T08:00:00.000Z' WHERE id = 'v1'");
    await t.db.exec('PRAGMA foreign_keys = ON');
    const plan = await t.ref.sitemap('net-1', s.net);
    // Lou n'a pas ses mentions : sa page n'est pas publiée, elle n'entre pas au plan.
    // [RS02] L'accueil et les pages où il mène entrent au plan de leur site, la preuve au seul réseau.
    expect(locs(plan)).toEqual([`${NET}/`, `${NET}/biens`, `${NET}/agents`, `${NET}/prix`, `${NET}/estimation`, `${NET}/simulateur`, `${NET}/preuve`, `${NET}/mentions-legales`, `${NET}/donnees-personnelles`, `${NET}/agents/ag-1`, `${NET}/prix/ville-inventee`, `${NET}/prix/ville-inventee/centre`]);
    expect(locs(await t.ref.sitemap('net-1', s.cam))).toEqual([`${CAMILLE}/`, `${CAMILLE}/biens`, `${CAMILLE}/estimation`, `${CAMILLE}/simulateur`, `${CAMILLE}/mentions-legales`, `${CAMILLE}/donnees-personnelles`, `${CAMILLE}/agents/ag-1`]);
    // [RS03] [R150] La liste des communes : une case publiée, jamais une commune sans case publiable.
    expect((await t.ref.priceCommunes('net-1')).map((c) => c.slug)).toEqual(['ville-inventee']);
    expect(renderSitemap([{ loc: 'https://x.exemple.test/a?b=1&c=<2>', lastmod: '2026-10-20', kind: 'prix' }])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>https://x.exemple.test/a?b=1&amp;c=&lt;2&gt;</loc><lastmod>2026-10-20</lastmod></url>\n</urlset>\n',
    );
  });
});
