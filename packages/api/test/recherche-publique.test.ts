import { describe, expect, it } from 'vitest';
import { FicheClient } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runListingSync } from '../src/vitrine.ts';
import { DELAY_END, MIN, setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';
import { htmlProblems, screenCssProblems } from '../../core/src/design/audit.ts';
import { PHRASE_MAX_LENGTH, type PhraseResult, type PhraseResults } from '../../core/src/recherche/langage-courant.ts';
import { PUBLIC_NEIGHBOURS_MAX, PUBLIC_SEARCH_LIMIT, keepPublished, parsePublicSearchQuery, publicSearchSteps } from '../../core/src/recherche/page-publique.ts';

// Réseau, agents, bien, sites et clés inventés.
const API = 'https://aimmo-api.example.test';
const NET = 'https://reseau-br44.example.test';
const ALEX_SITE = 'https://alex-br44.example.test';
const SAM_SITE = 'https://sam-br44.example.test';
const OTHER = 'https://autre-br44.example.test';
const KEYS = { direction: 'test-cle-br44-dir-cccccccccccccccccccccccccccccc', autre: 'test-cle-br44-autre-ddddddddddddddddddddddddddd' };
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PHRASE = 'Une maison de 3 pièces à Dijon, budget 250 000 €';

async function setup() {
  const t = await setupAnnonce();
  const other = (await new FicheClient(t.db).createNetwork('Autre réseau')).id;
  const apiKeys = JSON.stringify([
    { sha256: await sha256Hex(KEYS.direction), role: 'direction', userId: 'dir-1', networkId: t.network.id },
    { sha256: await sha256Hex(KEYS.autre), role: 'direction', userId: 'dir-9', networkId: other },
  ]);
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now, media: { get: async () => null } };
  const site = async (who: keyof typeof KEYS, body: unknown) => {
    const res = await handleRequest(new Request(`${API}/v1/attirer/sites`, { method: 'POST', headers: { authorization: `Bearer ${KEYS[who]}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), config);
    expect(res.status).toBe(200);
  };
  await site('direction', { kind: 'reseau', baseUrl: NET, active: true });
  await site('direction', { kind: 'agent', agentId: t.alexId, baseUrl: ALEX_SITE, active: true });
  await site('direction', { kind: 'agent', agentId: t.sam.userId, baseUrl: SAM_SITE, active: true });
  await site('autre', { kind: 'reseau', baseUrl: OTHER, active: true });
  const search = (host: string, params: Record<string, string | string[]> | string, opts: { method?: string; ua?: string | null } = {}) => {
    const qs = typeof params === 'string' ? params : (() => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
      return p.toString();
    })();
    const headers: Record<string, string> = {};
    const ua = opts.ua === undefined ? BROWSER : opts.ua;
    if (ua !== null) headers['user-agent'] = ua;
    return handleRequest(new Request(`${host}/chercher${qs ? `?${qs}` : ''}`, { method: opts.method ?? 'GET', headers }), config);
  };
  const publish = async () => {
    const v = await t.annonces.validate(t.agent, t.draftId);
    if (!v.ok) throw new Error(v.code);
    t.setClock(new Date(DELAY_END.getTime() + 5 * MIN));
    await runListingSync(t.db, t.now);
  };
  return { ...t, search, publish, config };
}

describeWithSqlite('BR44 · la recherche en langage courant sur le site public', () => {
  it('[R421] [R420] le site du réseau et celui de l’agent du bien le montrent avec ses raisons ; un autre agent, un autre réseau, l’adresse de l’API non', async () => {
    const t = await setup();
    await t.publish();
    const lien = `/biens/${t.propertyId}`;
    for (const host of [NET, ALEX_SITE]) {
      const res = await t.search(host, { q: PHRASE });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(lien);
      expect(html).toContain('Les biens qui vous correspondent');
      // Chaque raison dit d'après quels mots de la phrase [R420].
      expect(html).toMatch(/<ul class="raisons"><li>[^<]+ <span class="doux">D'après « [^<]+ »\.<\/span><\/li>/);
      // Jamais l'adresse du bien [R421].
      expect(html).not.toContain('21000');
    }
    const sam = await (await t.search(SAM_SITE, { q: PHRASE })).text();
    expect(sam).not.toContain(lien);
    expect(sam).toContain('Aucun bien en vente ne correspond en ce moment.');
    expect(await (await t.search(OTHER, { q: PHRASE })).text()).not.toContain(lien);
    expect((await t.search(API, { q: PHRASE })).status).toBe(404);
  });

  it('[R421] [R220] un bien non publié, ou dont le mandat est échu, n’est jamais montré', async () => {
    const t = await setup();
    expect(await (await t.search(NET, { q: PHRASE })).text()).not.toContain(`/biens/${t.propertyId}`);
    await t.publish();
    expect(await (await t.search(NET, { q: PHRASE })).text()).toContain(`/biens/${t.propertyId}`);
    t.setClock(new Date('2031-01-01T10:00:00.000Z'));
    expect(await (await t.search(NET, { q: PHRASE })).text()).not.toContain(`/biens/${t.propertyId}`);
  });

  it('la phrase n’est ni gardée en base, ni écrite au journal ; rien n’est compté', async () => {
    const t = await setup();
    await t.publish();
    const before = (await t.journal.all()).length;
    const views = await t.db.all('SELECT * FROM site_page_views').catch(() => []);
    const res = await t.search(NET, { q: 'Une maison à Dijon près de la rue Zanzibarienne, budget 250 000 €' });
    expect(res.status).toBe(200);
    expect((await t.journal.all()).length).toBe(before);
    expect(JSON.stringify(await t.journal.all())).not.toContain('Zanzibarienne');
    expect(await t.db.all('SELECT * FROM site_page_views').catch(() => [])).toEqual(views);
  });

  it('contre le moissonnage : jamais en cache, jamais indexée, un robot annoncé ou sans navigateur ne reçoit aucun bien', async () => {
    const t = await setup();
    await t.publish();
    const res = await t.search(NET, { q: PHRASE });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self'");
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    // Le système de design d'AIMMO : la feuille part de la base, la page est lisible et accessible [R201].
    expect(htmlProblems(html)).toEqual([]);
    expect(screenCssProblems(/<style>([^<]*)<\/style>/.exec(html)![1]!)).toEqual([]);
    for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'python-requests/2.31.0', 'curl/8.4.0', '', null]) {
      const robot = await t.search(NET, { q: PHRASE }, { ua });
      expect(robot.status).toBe(200);
      const html = await robot.text();
      expect(html).not.toContain(`/biens/${t.propertyId}`);
      expect(html).toContain('La recherche se fait dans un navigateur.');
    }
  });

  it('un paramètre non prévu ou une phrase répétée : 404 ; une phrase trop longue est dite, jamais tronquée en silence ; sans phrase, le formulaire seul', async () => {
    const t = await setup();
    await t.publish();
    expect((await t.search(NET, { q: PHRASE, page: '2' })).status).toBe(404);
    expect((await t.search(NET, { q: [PHRASE, PHRASE] })).status).toBe(404);
    expect((await t.search(NET, { voisine: 'Talant' })).status).toBe(404);
    const long = await t.search(NET, { q: `Dijon ${'a'.repeat(PHRASE_MAX_LENGTH)}` });
    expect(long.status).toBe(400);
    const text = await long.text();
    expect(text).toContain(`Votre phrase dépasse ${PHRASE_MAX_LENGTH} signes`);
    expect(text).not.toContain(`/biens/${t.propertyId}`);
    const empty = await t.search(NET, '');
    expect(empty.status).toBe(200);
    const form = await empty.text();
    expect(form).toContain('<form method="get" action="/chercher"');
    expect(form).not.toContain('Les biens qui vous correspondent');
    const post = await t.search(NET, { q: PHRASE }, { method: 'POST' });
    expect(post.status).toBe(405);
    const head = await t.search(NET, { q: PHRASE }, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('[R423] une commune voisine est proposée à part, et n’entre que par le lien que suit le visiteur ; le bien y est marqué', async () => {
    const t = await setup();
    await t.publish();
    const phrase = 'Une maison de 3 pièces à Talant, budget 250 000 €';
    const first = await (await t.search(NET, { q: phrase })).text();
    // Sans geste, le bien de Dijon n'est montré qu'à part, marqué comme voisin.
    const main = first.slice(0, first.indexOf('Dans les communes voisines'));
    expect(main).not.toContain(`/biens/${t.propertyId}`);
    expect(first.slice(first.indexOf('Dans les communes voisines'))).toContain(`/biens/${t.propertyId}`);
    expect(first).toContain('Commune voisine de Talant, proposée');
    expect(first).toContain('Ajouter Dijon, voisine de Talant');
    const accepted = await (await t.search(NET, { q: phrase, voisine: 'Dijon' })).text();
    expect(accepted.slice(0, accepted.indexOf('</ul>'))).toContain(`/biens/${t.propertyId}`);
    expect(accepted).toContain('Les biens qui vous correspondent');
    expect(accepted).not.toContain('Ajouter Dijon, voisine de Talant');
    // Une voisine qui n'est pas proposée ne change rien.
    const stray = await (await t.search(NET, { q: phrase, voisine: 'Marseille' })).text();
    expect(stray.slice(0, stray.indexOf('Dans les communes voisines'))).not.toContain(`/biens/${t.propertyId}`);
  });

  it('[R50] les mots sur les personnes sont écartés et dits ; une phrase sans critère le dit', async () => {
    const t = await setup();
    await t.publish();
    const html = await (await t.search(NET, { q: 'Nous sommes un couple de religion juive, on cherche une maison à Dijon' })).text();
    expect(html).toContain('Mots écartés');
    expect(html).toContain('un critère sur les personnes, que nous ne prenons jamais en compte');
    const none = await (await t.search(NET, { q: 'bonjour' })).text();
    expect(none).toContain("Nous n'avons reconnu aucun critère");
  });

  it('robots.txt du site garde tout fermé en essai', async () => {
    const t = await setup();
    const res = await handleRequest(new Request(`${NET}/robots.txt`), t.config);
    expect(await res.text()).toContain('Disallow: /');
  });
});

describe('BR44 · lecture de l’adresse et coupe des listes', () => {
  it('liste fermée de paramètres, voisines bornées', () => {
    expect(parsePublicSearchQuery(new URLSearchParams(''))).toEqual({ phrase: null, neighbours: [] });
    expect(parsePublicSearchQuery(new URLSearchParams('q=%20'))).toEqual({ phrase: null, neighbours: [] });
    expect(parsePublicSearchQuery(new URLSearchParams('q=Dijon&voisine=Talant'))).toEqual({ phrase: 'Dijon', neighbours: ['Talant'] });
    expect(parsePublicSearchQuery(new URLSearchParams('q=Dijon&voisine=Talant&voisine=Talant'))).toBeNull();
    expect(parsePublicSearchQuery(new URLSearchParams('q=Dijon&voisine=%3Cscript%3E'))).toBeNull();
    const many = new URLSearchParams('q=Dijon');
    for (let i = 0; i <= PUBLIC_NEIGHBOURS_MAX; i += 1) many.append('voisine', `Commune${'x'.repeat(i)}`);
    expect(parsePublicSearchQuery(many)).toBeNull();
    expect(parsePublicSearchQuery(new URLSearchParams(`q=${'a'.repeat(PHRASE_MAX_LENGTH + 1)}`))).toMatchObject({ tooLong: true });
    expect(publicSearchSteps({ neighbours: ['Talant'] })).toEqual([{ acceptNeighbour: 'Talant' }]);
  });

  it(`au plus ${PUBLIC_SEARCH_LIMIT} biens par liste, seulement ceux publiés sur le site, titre et prix de l’annonce [R421]`, () => {
    const hit = (i: number): PhraseResult => ({ propertyId: `b${i}`, reference: `R${i}`, kind: 'apartment', city: 'Dijon', priceEur: 1, surfaceM2: 50, rooms: 2, status: 'match', reasons: [{ text: 'Commune cherchée.', from: 'Dijon' }], preferencesMet: 0, neighbourOf: null });
    const results = { search: { criteria: [], ignored: [], excludedCommunes: [], excludedKinds: [], refusedPropertyIds: [] }, results: Array.from({ length: 30 }, (_, i) => hit(i)), neighbours: [hit(99)], proposedNeighbours: [] } as unknown as PhraseResults;
    const published = Array.from({ length: 30 }, (_, i) => i).filter((i) => i % 2 === 0).map((i) => ({ propertyId: `b${i}`, title: `Annonce ${i}`, priceEur: 1000 + i, city: 'Dijon' }));
    const kept = keepPublished(results, published);
    expect(kept.results).toHaveLength(PUBLIC_SEARCH_LIMIT);
    expect(kept.results.every((r) => Number(r.propertyId.slice(1)) % 2 === 0)).toBe(true);
    expect(kept.results[0]).toMatchObject({ title: 'Annonce 0', priceEur: 1000, reasons: [{ text: 'Commune cherchée.', from: 'Dijon' }] });
    expect(kept.neighbours).toHaveLength(0);
  });
});
