import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { countPublicView, statistiquesSiteRoutes } from '../src/statistiques-site.ts';
import { runListingSync } from '../src/vitrine.ts';
import { DELAY_END, MIN, setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents, bien, sites, contacts et clés inventés. Les navigateurs sont des chaînes publiques, personne derrière.
const API = 'https://aimmo-api.example.test';
const NET = 'https://reseau-br41.example.test';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ROBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const KEYS = {
  alex: 'test-cle-br41-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br41-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br41-direction-cccccccccccccccccccccc',
  compliance: 'test-cle-br41-conformite-dddddddddddddddddddd',
  inconnu: 'test-cle-br41-inconnu-eeeeeeeeeeeeeeeeeeeeeeeee',
};
type Who = keyof typeof KEYS;

async function setup() {
  const t = await setupAnnonce();
  const ids: Record<Who, { role: string; userId: string; networkId: string }> = {
    alex: { role: 'agent', userId: t.alexId, networkId: t.network.id },
    sam: { role: 'agent', userId: t.sam.userId, networkId: t.network.id },
    direction: { role: 'direction', userId: 'direction-1', networkId: t.network.id },
    compliance: { role: 'compliance', userId: 'c-1', networkId: t.network.id },
    inconnu: { role: 'agent', userId: 'agent-inconnu', networkId: t.network.id },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now };
  const call = async (who: Who, path: string, method = 'GET') => {
    const r = await handleRequest(new Request(`${API}/v1${path}`, { method, headers: { authorization: `Bearer ${KEYS[who]}` } }), config);
    return { status: r.status, body: (await r.json()) as any };
  };
  const page = (url: string, o: { method?: string; ua?: string | null } = {}) =>
    handleRequest(new Request(url, { method: o.method ?? 'GET', headers: o.ua === null ? {} : { 'user-agent': o.ua ?? PHONE } }), config);
  const site = async () => {
    const r = await handleRequest(
      new Request(`${API}/v1/attirer/sites`, { method: 'POST', headers: { authorization: `Bearer ${KEYS.direction}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'reseau', baseUrl: NET, active: true }) }),
      config,
    );
    expect(r.status).toBe(200);
  };
  const publish = async () => {
    const v = await t.annonces.validate(t.agent, t.draftId);
    if (!v.ok) throw new Error(v.code);
    t.setClock(new Date(DELAY_END.getTime() + 5 * MIN));
    await runListingSync(t.db, t.now);
  };
  const views = async () => (await t.db.all<{ kind: string; ref: string; views: number }>('SELECT c.kind, c.ref, sum(v.views) AS views FROM site_page_views v JOIN public_contents c ON c.id = v.content_id GROUP BY c.id ORDER BY c.kind')).map((r) => ({ ...r, views: Number(r.views) }));
  return { ...t, config, call, page, site, publish, views };
}

describeWithSqlite('BR41 · routes des statistiques du site, et les vues des pages publiques', () => {
  it('[R285] [R156] la page d’un bien servie sur le site compte une vue ; ni un robot, ni un HEAD, ni la fiche, ni l’adresse de l’API ; rien du visiteur gardé', async () => {
    const t = await setup();
    await t.site();
    await t.publish();
    const url = `${NET}/biens/${t.propertyId}`;
    const before = (await t.journal.all()).length;
    for (let i = 0; i < 2; i += 1) expect((await t.page(url)).status).toBe(200);
    expect(await t.views()).toEqual([{ kind: 'bien', ref: t.propertyId, views: 2 }]);
    // Un robot, un HEAD, la fiche imprimable, la page à l'adresse de l'API : la page sert, rien n'est compté.
    expect((await t.page(url, { ua: ROBOT })).status).toBe(200);
    expect((await t.page(url, { method: 'HEAD' })).status).toBe(200);
    expect((await t.page(`${url}/fiche`)).status).toBe(200);
    expect((await t.page(`${API}/biens/${t.propertyId}`)).status).toBe(200);
    // Sans navigateur annoncé, c'est un script pour RC12 : la page sert, rien n'est compté.
    expect((await t.page(url, { ua: null })).status).toBe(200);
    expect(await t.views()).toEqual([{ kind: 'bien', ref: t.propertyId, views: 2 }]);
    // Rien du visiteur : la table ne garde que le contenu, le jour et le compteur ; le journal ne dit rien des vues.
    const cols = (await t.db.all<{ name: string }>("SELECT name FROM pragma_table_info('site_page_views')")).map((c) => c.name).sort();
    expect(cols).toEqual(['content_id', 'day', 'network_id', 'views']);
    const after = JSON.stringify((await t.journal.all()).slice(before));
    expect(after).not.toContain('iPhone');
    expect(after).not.toContain('Googlebot');
    // Le bien, ses vues et rien d'autre, dans la lecture de la direction et de son agent [R286].
    for (const who of ['direction', 'alex'] as const) {
      const r = await t.call(who, '/site/statistiques');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, mode: 'essai', sent: false });
      expect(r.body.data.pages).toEqual([expect.objectContaining({ kind: 'bien', ref: t.propertyId, views: 2, demandes: [], vendeurs: [], mandats: [] })]);
    }
    // Sam ne lit que ses pages : pas le bien d'Alex.
    expect((await t.call('sam', '/site/statistiques')).body.data.pages).toEqual([]);
  });

  it('[R285] le simulateur compte ses vues ; une page de quartier sans code ne crée rien ; un autre site ne compte pas', async () => {
    const t = await setup();
    await t.site();
    expect((await t.page(`${NET}/simulateur`)).status).toBe(200);
    expect(await t.views()).toEqual([{ kind: 'simulateur', ref: 'simulateur', views: 1 }]);
    // Une adresse qui n'est pas un site en service : 404, rien de compté.
    expect((await t.page('https://inconnu-br41.example.test/simulateur')).status).toBe(404);
    expect(await t.views()).toEqual([{ kind: 'simulateur', ref: 'simulateur', views: 1 }]);
    // Un quartier sans code de AT07 : aucun contenu créé ; avec son code, la vue compte.
    const s = { db: t.db, journal: t.journal, now: t.now };
    const get = new Request(`${NET}/quartiers/dijon/centre`, { headers: { 'user-agent': PHONE } });
    await countPublicView(s, get, t.network.id, 'quartier', 'dijon/centre');
    expect(await t.db.first("SELECT id FROM public_contents WHERE kind = 'quartier'")).toBeNull();
    await t.db.run("INSERT INTO public_contents (id, network_id, kind, ref, created_at) VALUES ('quartiercode', ?, 'quartier', 'dijon/centre', ?)", [t.network.id, t.now().toISOString()]);
    await countPublicView(s, get, t.network.id, 'quartier', 'dijon/centre');
    expect(await t.views()).toEqual([
      { kind: 'quartier', ref: 'dijon/centre', views: 1 },
      { kind: 'simulateur', ref: 'simulateur', views: 1 },
    ]);
  });

  it('une panne du compteur ne change pas la page servie : l’échec est écrit au journal, sans rien du visiteur', async () => {
    const t = await setup();
    await t.site();
    const ok = await (await t.page(`${NET}/simulateur`)).text();
    await t.db.exec('DROP TABLE site_page_views');
    const res = await t.page(`${NET}/simulateur`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ok);
    const failed = (await t.journal.all()).filter((e) => e.type === 'site.vue_non_comptee');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data).toEqual({ kind: 'simulateur', error: 'Error' });
    expect(JSON.stringify(failed)).not.toContain('iPhone');
  });

  it('[R16] [R286] un autre rôle, un agent inconnu du réseau : refusés, refus au journal ; la direction et l’agent seuls', async () => {
    const t = await setup();
    for (const r of statistiquesSiteRoutes()) {
      const path = r.pattern.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');
      const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
      expect(await t.call('compliance', path)).toEqual({ status: 403, body: { ok: false, rule: 'R16', code: 'role' } });
      const inconnu = await t.call('inconnu', path);
      expect(inconnu.status).toBe(403);
      expect(inconnu.body).toMatchObject({ ok: false, rule: 'R16', code: 'agent_inactive' });
      const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').slice(before);
      expect(refused.map((e) => e.data.code)).toEqual(['role', 'agent_inactive']);
      expect(refused[0]!.data.kind).toBe(`route.${r.name}`);
      for (const who of ['direction', 'alex'] as const) expect((await t.call(who, path)).status).toBe(200);
      // Une autre méthode n'est pas une route.
      expect((await t.call('direction', path, 'POST')).status).not.toBe(200);
    }
  });

  it('la période va de 7 à 365 jours, écrite en chiffres ; tout autre paramètre est refusé 400', async () => {
    const t = await setup();
    const r = await t.call('direction', '/site/statistiques');
    expect(r.status).toBe(200);
    // 90 jours sans paramètre : du premier au dernier jour, à Paris.
    expect((Date.parse(r.body.data.lastDay) - Date.parse(r.body.data.firstDay)) / 86_400_000).toBe(89);
    expect((await t.call('direction', '/site/statistiques?jours=7')).status).toBe(200);
    expect((await t.call('direction', '/site/prochaine-page?jours=365')).status).toBe(200);
    for (const q of ['jours=6', 'jours=366', 'jours=abc', 'jours=07', 'jours=30.5', 'jours=', 'jours=30&jours=40'])
      expect(await t.call('direction', `/site/statistiques?${q}`), q).toEqual({ status: 400, body: { ok: false, rule: null, code: 'bad_period' } });
    expect(await t.call('direction', '/site/prochaine-page?periode=30')).toEqual({ status: 400, body: { ok: false, rule: null, code: 'unknown_field', field: 'periode' } });
  });

  it('[R287] [R286] la prochaine page à écrire dit ses chiffres, et chaque vendeur se vérifie par son message', async () => {
    const t = await setup();
    await t.site();
    const day = t.now().toISOString();
    // Une page de prix, deux vues, une demande d'un vendeur venue d'elle.
    await t.db.run("INSERT INTO public_contents (id, network_id, kind, ref, created_at) VALUES ('prixcodeaaaa', ?, 'prix', 'dijon', ?)", [t.network.id, day]);
    const person = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Léa', lastName: 'Inventée' });
    await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: person.id, kind: 'sell' });
    const at = new Date(t.now().getTime() - 2 * 86_400_000).toISOString();
    await t.db.run(
      `INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, external_id, conversation_ref, sender_name, body, status, person_id, received_at, created_at)
       VALUES ('in-br41', ?, 'k-br41', 'site', 'form', 'ext-br41', NULL, 'Personne Inventée', 'Bonjour', 'processed', ?, ?, ?)`,
      [t.network.id, person.id, at, at],
    );
    await t.db.run("INSERT INTO contact_origins (id, network_id, inbound_id, content_id, content_kind, method, recorded_at) VALUES ('o-br41', ?, 'in-br41', 'prixcodeaaaa', 'prix', 'lien', ?)", [t.network.id, at]);
    const s = { db: t.db, journal: t.journal, now: t.now };
    for (let i = 0; i < 2; i += 1) await countPublicView(s, new Request(`${NET}/prix/dijon`, { headers: { 'user-agent': PHONE } }), t.network.id, 'prix', 'dijon');
    await t.db.run('INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at) VALUES (?, ?, ?, ?, ?)', ['z-br41', t.network.id, t.alexId, 'Quetigny', day]);
    const stats = await t.call('direction', '/site/statistiques');
    expect(stats.body.data.pages).toEqual([expect.objectContaining({ kind: 'prix', ref: 'dijon', views: 2, demandes: ['in-br41'], vendeurs: ['in-br41'], vendeursPour1000Vues: 500 })]);
    const next = await t.call('direction', '/site/prochaine-page');
    expect(next.status).toBe(200);
    expect(next.body.data.reason).toBe('proposee');
    expect(next.body.data.suggestion).toMatchObject({ kind: 'prix', commune: 'Quetigny', figures: { kindVendeurs: 1, kindViews: 2, communeVendeurs: 0 } });
    expect(next.body.data.suggestion.text).toContain('1 vendeur pour 2 vues');
    // L'agent lit la proposition pour ses zones ; aucun nom de personne dans les réponses.
    expect((await t.call('alex', '/site/prochaine-page')).body.data.suggestion).toMatchObject({ commune: 'Quetigny' });
    expect(JSON.stringify([stats.body, next.body])).not.toContain('Inventée');
  });
});
