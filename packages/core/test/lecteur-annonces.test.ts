import { describe, expect, it } from 'vitest';
import { HttpListingReader, eurosOf, parseListingPage, type FetchLike } from '../src/diffusion/lecteur-annonces.ts';
import { DiffusionSurveillee } from '../src/diffusion/surveillance.ts';
import { RegistreMandats } from '../src/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// AU068 · Portails, pages et annonces inventés : aucune page réelle n'est lue par les tests.
const URL_SL = 'https://www.seloger.com/annonces/achat/appartement/dijon-21/au068.htm';

/** Une page d'annonce comme les portails en publient : données structurées et texte visible. */
const page = (o: { price: number | string; mentions: string; availability?: string; ld?: boolean }): string =>
  `<!doctype html><html><head><title>Annonce</title>${
    o.ld === false ? '' : `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'RealEstateListing', name: 'Appartement', offers: { '@type': 'Offer', price: o.price, priceCurrency: 'EUR', ...(o.availability ? { availability: o.availability } : {}) } })}</script>`
  }<script>var tracker = "1 000 000 €";</script></head><body><h1>Appartement de 3 pièces</h1><p>${o.mentions.replace(/\n/g, '</p><p>')}</p></body></html>`;

/** Un faux réseau : chaque adresse rend la réponse qu'on lui a donnée, et chaque appel est noté. */
function fakeFetch(): { fetch: FetchLike; pages: Map<string, { status: number; type?: string; body?: string }>; calls: { url: string; redirect: string }[] } {
  const pages = new Map<string, { status: number; type?: string; body?: string }>();
  const calls: { url: string; redirect: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    const p = pages.get(url) ?? { status: 404 };
    return { status: p.status, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (p.type ?? 'text/html; charset=utf-8') : null) }, text: async () => p.body ?? '' };
  };
  return { fetch, pages, calls };
}

describe('AU068 · la lecture d’une page d’annonce', () => {
  it('[R473] le prix des données structurées, puis du texte ; les classes du texte ; une offre épuisée n’est plus en ligne', () => {
    const mentions = 'Prix : 210 000 € honoraires inclus.\nClasse énergie D, classe climat C.';
    expect(parseListingPage(page({ price: 210000, mentions }))).toMatchObject({ found: true, priceEur: 210000, energyClass: 'D', climateClass: 'C' });
    expect(parseListingPage(page({ price: '199 000', mentions }))).toMatchObject({ priceEur: 199000 });
    expect(parseListingPage(page({ price: 0, mentions, ld: false }))).toMatchObject({ priceEur: 210000 });
    expect(parseListingPage(page({ price: 210000, mentions, availability: 'https://schema.org/SoldOut' }))).toEqual({ found: false });
    // Le texte d'un script ne compte pas pour le prix.
    expect(() => parseListingPage('<html><script>var p = "1 000 000 €";</script><p>Bel appartement</p></html>')).toThrow('prix_illisible');
    expect([eurosOf('210.000'), eurosOf('210000,00'), eurosOf(' 1 250 000 € '), eurosOf('abc'), eurosOf(-3)]).toEqual([210000, 210000, 1250000, null, null]);
  });

  it('[R473] les références de caractères sont décodées ; un prix structuré vide laisse lire le prix du texte', () => {
    const html = '<html><body><p>Prix&nbsp;: 210&#8239;000&#x20AC; honoraires inclus.</p><p>Classe &eacute;nergie D, classe climat C. Cuisine &agrave; l&rsquo;&Eacute;tage.</p></body></html>';
    const ld = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Offer', price: null })}</script>`;
    const r = parseListingPage(ld + html);
    expect(r).toMatchObject({ found: true, priceEur: 210000, energyClass: 'D', climateClass: 'C' });
    expect(r.found && r.text).toContain('Classe énergie D');
    expect(r.found && r.text).toContain('à l’Étage');
    expect(parseListingPage(`<script type="application/ld+json">${JSON.stringify({ '@type': 'Offer', price: 'sur demande', priceSpecification: { price: 199000 } })}</script><p>x</p>`)).toMatchObject({ priceEur: 199000 });
  });

  it('[R473] seule l’annonce relue compte : une recommandation vendue ne la dit pas retirée, ni son prix n’est pris', () => {
    const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
    const main = { '@type': 'RealEstateListing', url: 'https://www.seloger.com/a/1.htm', offers: { '@type': 'Offer', price: 210000, availability: 'https://schema.org/InStock' } };
    const other = { '@type': 'RealEstateListing', url: 'https://www.seloger.com/a/2.htm', offers: { '@type': 'Offer', price: 99000, availability: 'https://schema.org/SoldOut' } };
    const body = '<p>Prix : 210 000 €</p>';
    expect(parseListingPage(ld(main) + ld(other) + body)).toMatchObject({ found: true, priceEur: 210000 });
    // La recommandation avant l'annonce : l'adresse de la page désigne la bonne.
    expect(parseListingPage(ld(other) + ld(main) + body, 'https://www.seloger.com/a/1.htm?xtor=1')).toMatchObject({ found: true, priceEur: 210000 });
    expect(parseListingPage(ld(other) + ld(main) + body, 'https://www.seloger.com/a/2.htm')).toEqual({ found: false });
    // Une annonce désignée par un paramètre : l'autre identifiant n'est pas elle ; le suivi ne compte pas.
    const byId = (id: number, price: number, availability: string) => ({ '@type': 'RealEstateListing', url: `https://www.portail.example/detail?id=${id}`, offers: { price, availability } });
    const twin = ld(byId(2, 99000, 'https://schema.org/SoldOut')) + ld(byId(1, 210000, 'https://schema.org/InStock')) + body;
    expect(parseListingPage(twin, 'https://www.portail.example/detail?id=1&utm_source=lettre')).toMatchObject({ found: true, priceEur: 210000 });
    expect(parseListingPage(twin, 'https://www.portail.example/detail?id=2')).toEqual({ found: false });
    // Un fil d'Ariane ou une organisation ne sont pas une annonce.
    expect(parseListingPage(ld({ '@type': 'Organization', name: 'Portail' }) + ld({ '@type': 'BreadcrumbList' }) + body)).toMatchObject({ priceEur: 210000 });
  });

  it('[R473] une mise en forme dans le texte ne crée pas d’écart avec la mention publiée', () => {
    const r = parseListingPage('<div><p>Prix : <strong>210 000 €</strong> honoraires inclus.</p><p>Classe énergie <strong>D</strong>, classe climat <b>C</b>.</p></div>');
    expect(r.found && r.text).toContain('Classe énergie D, classe climat C.');
    expect(r.found && r.text).toContain('Prix : 210 000 € honoraires inclus. Classe');
    expect(r).toMatchObject({ energyClass: 'D', climateClass: 'C' });
  });

  it('[R473] un prix écrit avec ses centimes se lit ; une offre désignée par son @id dit si l’annonce est encore là', () => {
    for (const t of ['210 000,00 €', '210000.00 €', '210.000,00 €', '210 000 €']) expect(parseListingPage(`<p>Prix : ${t}</p>`), t).toMatchObject({ priceEur: 210000 });
    const graph = (availability: string) =>
      `<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'RealEstateListing', offers: { '@id': '#offre' } }, { '@id': '#offre', '@type': 'Offer', price: 210000, availability }] })}</script><p>Prix : 210 000 €</p>`;
    expect(parseListingPage(graph('https://schema.org/SoldOut'))).toEqual({ found: false });
    expect(parseListingPage(graph('https://schema.org/InStock'))).toMatchObject({ found: true, priceEur: 210000 });
    expect(parseListingPage(`<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'RealEstateListing', offers: '#o' }, { '@id': '#o', price: '199000' }] })}</script><p>x</p>`)).toMatchObject({ priceEur: 199000 });
  });

  it('[R473] les classes et les mentions sont lues dans l’annonce seule, pas dans les annonces recommandées ; un @id à ancre n’est pas la page', () => {
    const html = `<html><body><header><p>Classe énergie A</p></header><main>
      <section class="annonces-similaires"><div><p>Prix : 99 000 €</p><p>Classe énergie D, classe climat C.</p></div></section>
      <article><h1>Maison</h1><p>Prix : 210 000 € honoraires inclus.</p><p>Classe énergie F, classe climat E.</p></article>
      <aside><p>Classe énergie B</p></aside></main><footer>Classe climat A</footer></body></html>`;
    const r = parseListingPage(html);
    expect(r).toMatchObject({ found: true, priceEur: 210000, energyClass: 'F', climateClass: 'E' });
    expect(r.found && r.text).not.toContain('99 000');
    const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
    const page = 'https://www.seloger.com/a/1.htm';
    const graph = ld({ '@graph': [{ '@id': '#offre-recommandee', '@type': 'Offer', price: 99000, availability: 'https://schema.org/SoldOut' }, { '@type': 'RealEstateListing', url: page, offers: { price: 210000, availability: 'https://schema.org/InStock' } }] });
    expect(parseListingPage(graph + '<p>x</p>', page)).toMatchObject({ found: true, priceEur: 210000 });
  });

  it('[R473] l’en-tête de l’annonce elle-même est lu ; une annonce dont l’@id absolu porte une ancre est bien la page', () => {
    const r = parseListingPage('<header>Menu</header><main><article><header><h1>Maison</h1><p>Classe énergie F, classe climat E.</p></header><p>Prix : 210 000 €</p></article></main>');
    expect(r).toMatchObject({ found: true, priceEur: 210000, energyClass: 'F', climateClass: 'E' });
    const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
    const page = 'https://www.seloger.com/a/1.htm';
    const html = ld({ '@type': 'RealEstateListing', url: 'https://www.seloger.com/a/2.htm', offers: { price: 99000, availability: 'https://schema.org/SoldOut' } }) + ld({ '@type': 'RealEstateListing', '@id': `${page}#annonce`, offers: { price: 210000, availability: 'https://schema.org/InStock' } }) + '<p>x</p>';
    expect(parseListingPage(html, page)).toMatchObject({ found: true, priceEur: 210000 });
  });

  it('[R473] 404 et 410 : plus en ligne ; une redirection, une autre réponse ou une page qui n’est pas du HTML : illisible ; jamais de redirection suivie', async () => {
    const f = fakeFetch();
    const reader = new HttpListingReader(f.fetch);
    f.pages.set(URL_SL, { status: 410 });
    expect(await reader.read('seloger', URL_SL)).toEqual({ found: false });
    for (const p of [{ status: 301 }, { status: 503 }, { status: 200, type: 'application/json', body: '{}' }]) {
      f.pages.set(URL_SL, p);
      await expect(reader.read('seloger', URL_SL)).rejects.toThrow();
    }
    expect(f.calls.every((c) => c.redirect === 'manual')).toBe(true);
    await expect(reader.read('seloger', 'http://www.seloger.com/a')).rejects.toThrow('adresse_refusee');
    await expect(reader.read('seloger', 'https://x:y@www.seloger.com/a')).rejects.toThrow('adresse_refusee');
    expect(f.calls).toHaveLength(4);
  });
});

async function setup() {
  const t = await setupAnnonce();
  t.setClock(new Date('2027-02-12T10:00:00.000Z'));
  await t.annonces.validate(t.agent, t.draftId);
  t.setClock(new Date('2027-03-01T08:00:00.000Z'));
  await t.publication.sync(t.network.id, t.propertyId);
  const d = new DiffusionSurveillee(t.db, t.acces, t.journal, { now: t.now });
  expect(await d.setPortal(t.direction, { code: 'seloger', label: 'SeLoger', host: 'www.seloger.com', requiredFields: ['prix'], minPhotos: 0 })).toEqual({ ok: true });
  expect(await d.choose(t.agent, t.propertyId, 'seloger', true)).toEqual({ ok: true });
  const version = async () => (await t.db.first<{ seq: number; payload: string }>('SELECT seq, payload FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [t.propertyId]))!;
  const { seq } = await version();
  await d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq, outcome: 'acceptee', onlineUrl: URL_SL });
  const f = fakeFetch();
  /** La page en ligne telle que le portail la montre pour la version publiée maintenant. */
  const online = async () => {
    const v = JSON.parse((await version()).payload) as { priceEur: number; mentions: string };
    f.pages.set(URL_SL, { status: 200, body: page({ price: v.priceEur, mentions: v.mentions }) });
  };
  return { ...t, d, version, f, online, reader: new HttpListingReader(f.fetch) };
}

describeWithSqlite('AU068 · la relecture réelle de chaque portail ouvre une action datée', () => {
  it('[R473] constat puis correction : une baisse de prix pas encore en ligne ouvre une tâche datée, relue conforme elle se ferme', async () => {
    const t = await setup();
    await t.online();
    expect(await t.d.verifyAll(t.network.id, t.reader)).toEqual({ checked: 1, outcomes: { conforme: 1 }, failed: 0 });
    // Le prix baisse par avenant ; le portail montre encore l'ancien.
    const before = JSON.parse((await t.version()).payload) as { priceEur: number; mentions: string };
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    t.f.pages.set(URL_SL, { status: 200, body: page({ price: before.priceEur, mentions: before.mentions }) });
    const lowered = (JSON.parse((await t.version()).payload) as { priceEur: number }).priceEur;
    expect(lowered).toBeLessThan(before.priceEur);
    t.setClock(new Date('2027-03-02T07:00:00.000Z'));
    expect((await t.d.verifyAll(t.network.id, t.reader)).outcomes).toEqual({ ecart: 1 });
    const tasks = await t.d.tasks(t.agent);
    expect(tasks.ok && tasks.tasks.map((x) => [x.kind, x.createdAt, x.gaps.find((g) => g.field === 'prix')])).toEqual([
      ['ecart', '2027-03-02T07:00:00.000Z', { field: 'prix', published: lowered, online: before.priceEur }],
    ]);
    // Le portail suit : la relecture suivante ferme la tâche.
    await t.online();
    expect((await t.d.verifyAll(t.network.id, t.reader)).outcomes).toEqual({ conforme: 1 });
    const after = await t.d.tasks(t.agent);
    expect(after.ok && after.tasks).toEqual([]);
  });

  it('[R473] une annonce retirée encore visible ouvre une tâche ; disparue (410), tout est en ordre', async () => {
    const t = await setup();
    await t.online();
    expect((await new RegistreMandats(t.db, t.journal, { now: t.now }).cancel(t.direction, t.mandateId, 'termination')).ok).toBe(true);
    await t.publication.sync(t.network.id, t.propertyId);
    expect((await t.d.verifyAll(t.network.id, t.reader)).outcomes).toEqual({ toujours_en_ligne: 1 });
    const tasks = await t.d.tasks(t.agent);
    expect(tasks.ok && tasks.tasks.map((x) => [x.kind, x.gaps])).toEqual([['ecart', [{ field: 'retrait' }]]]);
    t.f.pages.set(URL_SL, { status: 410 });
    expect((await t.d.verifyAll(t.network.id, t.reader)).outcomes).toEqual({ retiree_absente: 1 });
  });

  it('[R473] une page en panne est rangée illisible, sans tâche ; un autre réseau n’est jamais relu', async () => {
    const t = await setup();
    t.f.pages.set(URL_SL, { status: 503 });
    expect(await t.d.verifyAll(t.network.id, t.reader)).toEqual({ checked: 1, outcomes: { illisible: 1 }, failed: 0 });
    const tasks = await t.d.tasks(t.agent);
    expect(tasks.ok && tasks.tasks).toEqual([]);
    expect(await t.d.verifyAll('autre-reseau', t.reader)).toEqual({ checked: 0, outcomes: {}, failed: 0 });
  });
});
