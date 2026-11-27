import { describe, expect, it } from 'vitest';
import { DESIGN_CSS, ETIQUETTES_CSS, ETIQUETTES_DPE } from '../src/design/systeme.ts';
import { contrastRatio, filledButtons, htmlProblems, screenCssProblems } from '../src/design/audit.ts';
import { PageBien, computeMentions, energyClassesOf, energyLabels, renderListingPage, renderListingPrint, type PageInput } from '../src/annonces/index.ts';
import { printHeightMm } from '../src/annonces/page-bien.ts';
import { keyFacts } from '../src/annonces/page-bien.ts';
import { surfacesFor } from '../src/annonces/fiche-bien.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Annonce, agent et photos inventés.
const N = ' ';
const S = ' ';
const INPUT: PageInput = {
  payload: {
    reference: 'REF-T-1',
    version: 3,
    state: 'en_vente',
    title: 'Appartement 3 pièces à Dijon',
    body: 'Au 3e étage avec ascenseur.\nBalcon.',
    mentions: `Prix : 210${S}000${N}€ honoraires inclus, soit 200${S}000${N}€ hors honoraires et 5${N}% TTC du prix hors honoraires, à la charge de l'acquéreur.\nCarte professionnelle n° CPI 0000.`,
    priceEur: 210000,
    media: [],
  },
  agent: { firstName: 'Alex', lastName: 'Agent', phone: '03 00 00 00 00', email: 'alex@exemple.test' },
  photos: [
    { ref: 'biens/b1/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg', kind: 'photo', overlay: null },
    { ref: 'biens/b1/0b6f1d2e-2222-4a2b-8c3d-000000000002.jpg', kind: 'photo', overlay: 'Aménagement virtuel' },
  ],
};

describe('P05 · page du bien et fiche imprimable', () => {
  it('[R43] la page porte le prix en grand, l’état, le texte, toutes les mentions et l’agent', () => {
    const html = renderListingPage(INPUT);
    expect(html).toContain(`<p class="prix">210${S}000${N}€</p>`);
    expect(html).toContain('<span class="etat">En vente</span>');
    expect(html).toContain(INPUT.payload.mentions!.replace(/'/g, '&#39;'));
    expect(html).toContain('href="tel:0300000000"');
    expect(html).toContain('href="mailto:alex@exemple.test"');
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain('name="viewport"');
    // Le prix en grand vient avant les mentions, qui sont lisibles et non cachées.
    expect(html.indexOf('class="prix"')).toBeLessThan(html.indexOf('class="mentions"'));
    // Rien de la page ne cache quoi que ce soit : seule la base du système sait cacher un élément marqué `hidden`.
    expect(html).toContain(DESIGN_CSS);
    // La frise décorative est seulement tue aux lecteurs d'écran.
    expect(html.replace(DESIGN_CSS, '').replace('<div class="frise" aria-hidden="true"></div>', '')).not.toMatch(/display:\s*none|hidden/);
  });

  it('[R48] une photo d’aménagement virtuel porte la mention sur l’image, dans la page et la fiche', () => {
    for (const html of [renderListingPage(INPUT), renderListingPrint(INPUT)!]) {
      expect(html.match(/<span class="virtuel">Aménagement virtuel<\/span>/g)).toHaveLength(1);
      expect(html).toContain('0b6f1d2e-2222-4a2b-8c3d-000000000002.jpg" alt="Photo du bien, aménagement virtuel"');
    }
  });

  it('l’état et le prix suivent la version : sous offre, vendu, retiré', () => {
    expect(renderListingPage({ ...INPUT, payload: { ...INPUT.payload, state: 'sous_offre' } })).toContain('Sous offre');
    expect(renderListingPage({ ...INPUT, payload: { ...INPUT.payload, state: 'vendu', priceEur: 200000 } })).toContain(`200${S}000${N}€`);
    const retired = renderListingPage({ ...INPUT, payload: { reference: 'REF-T-1', version: 4, state: 'retiree', title: null, body: null, mentions: null, priceEur: null, media: [] } });
    expect(retired).toContain("Ce bien n'est plus proposé à la vente.");
    expect(retired).toContain('content="noindex"');
    expect(retired).not.toMatch(/€|<img|Balcon/);
    expect(renderListingPrint({ ...INPUT, payload: { ...INPUT.payload, state: 'retiree' } })).toBeNull();
  });

  it('[R46] tout texte est échappé ; aucune adresse ni nom du vendeur ne peut venir d’ailleurs que de la version', () => {
    const html = renderListingPage({ ...INPUT, payload: { ...INPUT.payload, title: '<script>alert(1)</script>', body: '"><img src=x onerror=alert(1)>' }, agent: { firstName: '<b>', lastName: 'x', phone: 'javascript:alert(1)', email: 'x"@y.fr' } });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('mailto:x"');
    expect(html).toContain('&lt;script&gt;');
  });

  it('DS083 · la fiche imprimable tient sur une feuille A4 quand le texte le permet : la photo, le titre, le prix, la description, les mentions, l’agent', () => {
    const many = { ...INPUT, photos: Array.from({ length: 9 }, (_, i) => ({ ref: `biens/b1/0b6f1d2e-1111-4a2b-8c3d-00000000000${i}.jpg`, kind: 'photo' as const, overlay: null })) };
    const html = renderListingPrint(many)!;
    expect(printHeightMm(many)).toBeLessThanOrEqual(297);
    expect(html.match(/<section class="page">/g)).toHaveLength(1);
    expect(html).toContain('@page{size:A4');
    expect(html).toContain('.page{width:210mm;height:297mm;padding:14mm 16mm;overflow:hidden;display:flex;flex-direction:column;');
    // Dans l'ordre de lecture : la marque, les photos, le titre, le prix et l'état, la description, les mentions, l'agent.
    const page = html.split('<section class="page">')[1]!;
    const order = ['<p class="marque">AIMMO <span>Réf. REF-T-1</span></p>', '<ul class="photos p4">', '<h1>Appartement 3 pièces à Dijon</h1>', '<span class="prix">', '<span class="etat">En vente</span>', '<p class="texte">', '<div class="mentions">', '<section class="agent"'].map((part) => page.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Quatre photos au plus, et aucune n'attend un défilement qui n'existe pas sur le papier.
    expect(page.match(/<img /g)).toHaveLength(4);
    expect(html).not.toContain('loading="lazy"');
    expect(page).toContain('agent immobilier');
    // Les photos prennent la place qui reste ; si le texte en demandait plus, ce sont elles qui rétrécissent.
    expect(html).toContain('.photos{flex:1 1 0;min-height:0;');
    // Sur papier, les retours à la ligne deviennent des espaces.
    const lines = renderListingPrint({ ...INPUT, payload: { ...INPUT.payload, body: Array.from({ length: 60 }, () => 'Balcon.').join('\n') } })!;
    expect(lines).toContain(`<p class="texte">${Array.from({ length: 60 }, () => 'Balcon.').join(' ')}</p>`);
  });

  it('DS083 · un long texte : deux feuilles au plus, la première garde le prix, les mentions et quatre photos, la seconde porte le texte, les photos suivantes et l’agent', () => {
    const photos = Array.from({ length: 9 }, (_, i) => ({ ref: `biens/b1/0b6f1d2e-1111-4a2b-8c3d-00000000000${i}.jpg`, kind: 'photo' as const, overlay: null }));
    const long = { ...INPUT, photos, payload: { ...INPUT.payload, body: 'Une phrase inventée pour mesurer la place. '.repeat(70).trim() } };
    expect(long.payload.body.length).toBeGreaterThan(2900);
    expect(printHeightMm(long)).toBeGreaterThan(297);
    const html = renderListingPrint(long)!;
    expect(html.match(/<section class="page">/g)).toHaveLength(2);
    const [page1, page2] = html.split('<section class="page">').slice(1);
    expect(page1).toContain('class="prix"');
    expect(page1).toContain('class="mentions"');
    expect(page1!.match(/<img /g)).toHaveLength(4);
    expect(page1).not.toContain('class="texte"');
    expect(page2).toContain('class="texte"');
    expect(page2).toContain('agent immobilier');
    // Les photos cinq à sept accompagnent le texte : la seconde feuille n'est jamais un en-tête et une ligne.
    expect(page2).toContain('<ul class="photos suite">');
    expect(page2!.match(/<img /g)).toHaveLength(3);
    expect(html.match(/class="agent"/g)).toHaveLength(1);
    // La hauteur comptée grandit avec le texte, le titre et les mentions : rien ne passe d'une feuille à deux par hasard.
    const withBody = (n: number): number => printHeightMm({ ...INPUT, photos, payload: { ...INPUT.payload, body: 'x'.repeat(n) } });
    expect(withBody(200)).toBeLessThan(withBody(800));
    expect(withBody(800)).toBeLessThan(withBody(1600));
    expect(printHeightMm({ ...INPUT, photos: [] })).toBeLessThan(printHeightMm({ ...INPUT, photos }));
    expect(printHeightMm({ ...INPUT, agent: null })).toBeLessThan(printHeightMm(INPUT));
  });
});

describe('DS072 · la page du bien vend le bien', () => {
  const DPE = `${INPUT.payload.mentions!.split('\n')[0]}\nClasse énergie D, classe climat B. Logement à consommation énergétique moyenne.\nCarte professionnelle n° CPI 0000.`;

  it('la photo d’abord : la galerie ouvre la page, la première image n’attend pas, les autres viennent au défilement', () => {
    const html = renderListingPage({ ...INPUT, photos: [{ ...INPUT.photos[0]!, caption: 'Le séjour' }, INPUT.photos[1]!] });
    const main = html.slice(html.indexOf('<main>'));
    expect(main.startsWith('<main><ul class="photos">')).toBe(true);
    expect(main.indexOf('class="photos"')).toBeLessThan(main.indexOf('<h1>'));
    const imgs = [...main.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toContain('fetchpriority="high"');
    expect(imgs[0]).not.toContain('loading="lazy"');
    expect(imgs[1]).toContain('loading="lazy"');
    // La légende des portails reste le texte de remplacement et la légende visible [R478] ; la mention reste sur l'image [R48].
    expect(main).toContain('alt="Le séjour" fetchpriority="high" decoding="async"><span class="legende">Le séjour</span>');
    expect(main.match(/<span class="virtuel">Aménagement virtuel<\/span>/g)).toHaveLength(1);
    // Une galerie qui se feuillette du doigt, sans script : chaque photo s'arrête à sa place, la suivante dépasse.
    expect(html).toContain('.photos{display:flex;');
    expect(html).toContain('overflow-x:auto;scroll-snap-type:x mandatory');
    expect(html).toContain('.photos li{position:relative;flex:0 0 88%;');
    expect(html).not.toContain('<script');
    // La fiche imprimable n'a pas de photo prioritaire : toutes se chargent d'emblée.
    expect(renderListingPrint(INPUT)).not.toContain('fetchpriority');
  });

  it('[R43] les faits en une ligne viennent de la version publiée seule : surfaces du site (AU063) et classes des mentions', () => {
    const payload = { ...INPUT.payload, mentions: DPE, surfaces: [{ kind: 'habitable' as const, m2: 118, source: 'mesurage' as const }, { kind: 'carrez' as const, m2: 60.5, source: null }, { kind: 'utile' as const, m2: 40, source: null }] };
    expect(keyFacts(payload)).toBe(
      `<dl class="faits"><div><dt>Surface habitable</dt><dd>118${N}m²</dd></div><div><dt>Surface Carrez</dt><dd>60,5${N}m²</dd></div><div><dt>Classe énergie</dt><dd>D</dd></div><div><dt>Classe climat</dt><dd>B</dd></div></dl>`,
    );
    // Un local, des murs ou un fonds : la version publiée range la surface utile en tête, et la page la dit d'abord (AU063, R47).
    const shop = { ...INPUT.payload, surfaces: surfacesFor('portails', { kind: 'commercial', surfaceM2: 40, usableM2: 85.25 }).map((x) => ({ kind: x.kind, m2: x.m2, source: x.source })) };
    expect(shop.surfaces.map((x) => x.kind)).toEqual(['utile', 'habitable']);
    expect(keyFacts(shop)).toBe(`<dl class="faits"><div><dt>Surface utile</dt><dd>85,25${N}m²</dd></div><div><dt>Surface habitable</dt><dd>40${N}m²</dd></div></dl>`);
    expect(keyFacts({ ...INPUT.payload, surfaces: [{ kind: 'utile', m2: 120, source: 'acte' }] })).toBe(`<dl class="faits"><div><dt>Surface utile</dt><dd>120${N}m²</dd></div></dl>`);
    // Un logement, lui, garde l'ordre du site : la surface utile que les portails reçoivent n'y est pas dite.
    expect(surfacesFor('portails', { kind: 'home', surfaceM2: 118, carrezM2: 60.5, usableM2: 40 }).map((x) => x.kind)).toEqual(['habitable', 'carrez', 'utile']);
    // Sans surface ni diagnostic dans la version : aucun fait, rien d'inventé ni de déduit du titre.
    expect(keyFacts(INPUT.payload)).toBe('');
    const html = renderListingPage({ ...INPUT, payload });
    expect(html.indexOf('class="prix"')).toBeLessThan(html.indexOf('class="faits"'));
    expect(html.indexOf('class="faits"')).toBeLessThan(html.indexOf('class="texte"'));
    expect(renderListingPage(INPUT)).not.toContain('<dl');
    expect(htmlProblems(html)).toEqual([]);
  });

  it('l’agent a deux gestes, de vrais boutons : demander une visite par écrit, appeler ; un seul est plein', () => {
    const html = renderListingPage(INPUT);
    expect(html).toContain('<p class="gestes"><a class="appel" href="mailto:alex@exemple.test?subject=Demande%20de%20visite%2C%20r%C3%A9f.%20REF-T-1">Demander une visite</a><a class="appel second" href="tel:0300000000">Appeler</a></p>');
    expect(filledButtons(html)).toEqual(['Demander une visite']);
    // Le numéro et l'adresse restent écrits en clair, avec le nom et le titre [R07].
    expect(html).toContain('<section class="agent" aria-label="Votre agent"><p class="nom">Alex Agent</p><p class="doux">agent immobilier</p>');
    expect(html).toContain('>03 00 00 00 00</a>');
    expect(html).toContain('>alex@exemple.test</a>');
    // Sur téléphone, les gestes restent au pied de l'écran ; rien d'autre ne bouge.
    expect(html).toContain('.gestes{position:sticky;bottom:0;');
  });

  it('un bien sous offre ou vendu ne propose plus de visite ; sans coordonnées réglées, aucun geste', () => {
    for (const state of ['sous_offre', 'vendu'] as const) {
      const html = renderListingPage({ ...INPUT, payload: { ...INPUT.payload, state } });
      expect(html, state).not.toContain('Demander une visite');
      expect(html, state).toContain('subject=Votre%20annonce%2C%20r%C3%A9f.%20REF-T-1">Écrire à l’agent</a>');
      // Écrire devient le second geste : appeler est le geste plein.
      expect(filledButtons(html), state).toEqual(['Appeler']);
    }
    const phoneOnly = renderListingPage({ ...INPUT, agent: { ...INPUT.agent!, email: null } });
    expect(filledButtons(phoneOnly)).toEqual(['Appeler']);
    expect(phoneOnly).not.toContain('mailto:');
    const mailOnly = renderListingPage({ ...INPUT, agent: { ...INPUT.agent!, phone: null } });
    expect(filledButtons(mailOnly)).toEqual(['Demander une visite']);
    expect(mailOnly).not.toContain('tel:');
    const none = renderListingPage({ ...INPUT, agent: { ...INPUT.agent!, phone: null, email: null } });
    expect(none).toContain('<p class="nom">Alex Agent</p>');
    expect(none).not.toContain('class="gestes"');
    // Un agent parti n'est plus montré : ni son nom, ni un geste.
    const gone = renderListingPage({ ...INPUT, agent: null });
    expect(gone).not.toContain('class="contact"');
    expect(gone).not.toContain('class="gestes"');
  });
});

describeWithSqlite('P05 · page et fiche depuis la version publiée', () => {
  it('la page suit d’elle-même la dernière version publiée : prix, état, retrait', async () => {
    const t = await setupAnnonce();
    const pages = new PageBien(t.db, t.acces, t.journal, { now: t.now });
    expect(await pages.page(t.network.id, t.propertyId)).toBeNull();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await pages.setAgentCard(t.agent, t.alexId, { phone: '03 00 00 00 01', email: 'alex@exemple.test' })).toEqual({ ok: true });
    let html = (await pages.page(t.network.id, t.propertyId))!;
    expect(html).toContain(`210${S}000${N}€`);
    expect(html).toContain('Aménagement virtuel');
    expect(html).toContain('href="tel:0300000001"');
    expect(html).not.toMatch(/Léa|Exemple/);
    expect(html).not.toContain('.mp4');
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    html = (await pages.page(t.network.id, t.propertyId))!;
    expect(html).toContain(`200${S}000${N}€`);
    expect(await pages.print(t.network.id, t.propertyId)).toContain(`200${S}000${N}€`);
    await t.db.run("UPDATE properties SET status = 'withdrawn' WHERE id = ?", [t.propertyId]);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await pages.page(t.network.id, t.propertyId)).toContain("n'est plus proposé");
    expect(await pages.print(t.network.id, t.propertyId)).toBeNull();
    expect(await pages.page('autre-reseau', t.propertyId)).toBeNull();
  });

  it('[R16] seuls l’agent lui-même et la direction règlent ses coordonnées ; rien ne s’efface', async () => {
    const t = await setupAnnonce();
    const pages = new PageBien(t.db, t.acces, t.journal, { now: t.now });
    expect(await pages.setAgentCard(t.sam, t.alexId, { phone: '03 00 00 00 01', email: 'a@exemple.test' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await pages.setAgentCard(t.agent, t.alexId, { phone: 'abc', email: 'a@exemple.test' })).toEqual({ ok: false, rule: null, code: 'bad_phone' });
    expect(await pages.setAgentCard(t.agent, t.alexId, { phone: '0300000001', email: 'pas-un-mail' })).toEqual({ ok: false, rule: null, code: 'bad_email' });
    expect(await pages.setAgentCard(t.direction, 'agent-inconnu', { phone: '0300000001', email: 'a@exemple.test' })).toEqual({ ok: false, rule: null, code: 'unknown_agent' });
    expect(await pages.setAgentCard(t.direction, t.alexId, { phone: '0300000001', email: 'a@exemple.test' })).toEqual({ ok: true });
    await expect(t.db.run('DELETE FROM agent_public_cards')).rejects.toThrow(/rien ne s'efface/);
    // Un agent parti ne règle plus ses coordonnées, ni lui ni la direction ; le refus est au journal.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alexId]);
    expect(await pages.setAgentCard(t.agent, t.alexId, { phone: '0300000002', email: 'b@exemple.test' })).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await pages.setAgentCard(t.direction, t.alexId, { phone: '0300000002', email: 'b@exemple.test' })).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect((await t.journal.bySubject(`agent:${t.alexId}`)).filter((e) => e.type === 'acces.refuse' && (e.data as { code: string }).code === 'agent_inactive')).toHaveLength(2);
    expect(await t.db.all('SELECT id FROM agent_public_cards')).toHaveLength(1);
  });
});

describe('AU006 · les deux étiquettes du DPE sur la page et la fiche imprimable', () => {
  const WITH_DPE: PageInput = {
    ...INPUT,
    payload: { ...INPUT.payload, mentions: `${INPUT.payload.mentions!.split('\n')[0]}\nClasse énergie E, classe climat C. Montant estimé des dépenses annuelles d'énergie pour un usage standard : entre 900${N}€ et 1${S}300${N}€ par an.\nCarte professionnelle n° CPI 0000.` },
  };

  it('[R43] la page et la fiche montrent les deux échelles de A à G, la classe du bien en avant et dite en mots', () => {
    for (const html of [renderListingPage(WITH_DPE), renderListingPrint(WITH_DPE)!]) {
      expect(html).toContain(ETIQUETTES_CSS);
      const energie = /<figure class="etiquette energie">([\s\S]*?)<\/figure>/.exec(html)![1]!;
      const climat = /<figure class="etiquette climat">([\s\S]*?)<\/figure>/.exec(html)![1]!;
      for (const [fig, current] of [[energie, 'E'], [climat, 'C']] as const) {
        expect(fig.match(/<li/g)).toHaveLength(7);
        expect([...fig.matchAll(/<i>([A-G])<\/i>/g)].map((m) => m[1])).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
        expect(fig.match(/aria-current="true"/g)).toHaveLength(1);
        expect(fig).toContain(`<li class="ce-bien" aria-current="true"><b><i>${current}</i></b><strong>◂ ce bien</strong>`);
        expect(fig).toContain(`classe ${current}</figcaption>`);
        // Aucun seuil chiffré : il dépend de la surface et des émissions, il pourrait contredire le diagnostic.
        expect(fig).not.toMatch(/\d|kWh|CO/);
      }
      expect(energie).toContain('Performance énergétique : classe E');
      expect(climat).toContain('Émissions de gaz à effet de serre : classe C');
    }
    // Sur la fiche, les étiquettes sont sur la première page, avec le prix et les mentions.
    const page1 = renderListingPrint(WITH_DPE)!.split('<section class="page">')[1]!;
    expect(page1).toContain('class="etiquettes"');
  });

  it('[R43] le constat de l’audit : avant, les classes n’étaient que du texte ; un dessin en couleur les montre', () => {
    const html = renderListingPage(WITH_DPE);
    // Chaque barre a sa couleur, celle du modèle officiel, posée par le système.
    for (const [kind, colors] of Object.entries(ETIQUETTES_DPE)) {
      colors.forEach(([fond], i) => {
        expect(ETIQUETTES_CSS).toContain(`.${kind} li:nth-child(${i + 1}) b{background:${fond};`);
      });
    }
    expect(html.indexOf('class="mentions"')).toBeLessThan(html.indexOf('class="etiquettes"'));
  });

  it('[R201] chaque barre a un texte lisible : contraste de 4,5 au moins', () => {
    for (const colors of Object.values(ETIQUETTES_DPE)) for (const [fond, texte] of colors) expect(contrastRatio(fond, texte)).toBeGreaterThanOrEqual(4.5);
  });

  it('[R201] les étiquettes font partie du système : le contrôle des écrans les accepte, rien d’autre n’y entre', () => {
    for (const html of [renderListingPage(WITH_DPE), renderListingPrint(WITH_DPE)!]) {
      expect(screenCssProblems(/<style>([\s\S]*?)<\/style>/.exec(html)![1]!)).toEqual([]);
      expect(htmlProblems(html, { print: html.includes('@page') })).toEqual([]);
    }
    // Une couleur à soi ajoutée après les étiquettes est toujours refusée.
    expect(screenCssProblems(`${DESIGN_CSS}${ETIQUETTES_CSS}.x{color:#ff0000}`)).toEqual(['couleur hors système : #ff0000']);
    // Les couleurs des étiquettes ne sont pas des jetons : un texte ne peut pas les reprendre sans être vu.
    expect(ETIQUETTES_CSS).not.toMatch(/--(?:energie|climat)-/);
    expect(screenCssProblems(`${DESIGN_CSS}${ETIQUETTES_CSS}p{color:#f4e70f}`)).toEqual(['couleur hors système : #f4e70f']);
  });

  it('[R43] les classes viennent des mentions publiées seules ; sans elles (terrain), aucune étiquette', () => {
    expect(energyClassesOf(WITH_DPE.payload.mentions)).toEqual({ energy: 'E', climate: 'C' });
    expect(energyClassesOf('Classe énergie H, classe climat C.')).toBeNull();
    expect(energyClassesOf(null)).toBeNull();
    expect(energyLabels(INPUT.payload.mentions)).toBe('');
    expect(renderListingPage(INPUT)).not.toContain('class="etiquettes"');
    expect(renderListingPrint(INPUT)).not.toContain('class="etiquettes"');
    // La phrase lue est exactement celle que le calcul des mentions écrit.
    const mentions = computeMentions({
      kind: 'home',
      terms: { priceEur: 200000, feeEur: 10000, feeCharge: 'vendeur' },
      sheet: { characteristics: null, energy: { energyClass: 'F', climateClass: 'D', annualCostMinEur: 900, annualCostMaxEur: 1300, costReferenceYear: 2025, diagnosedOn: '2024-03-01' }, coownership: { isCoownership: false }, risks: { inRiskZone: false }, media: [] } as never,
      cardNumber: 'CPI 0000',
      intervenant: null,
      today: '2026-11-19',
    });
    expect(energyClassesOf(mentions.text)).toEqual({ energy: 'F', climate: 'D' });
  });
});
