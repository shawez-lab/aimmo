import { describe, expect, it } from 'vitest';
import { PageBien, publicTextProblems, type PageInput } from '../src/annonces/index.ts';
import { htmlProblems } from '../src/design/audit.ts';
import { SUPPORT_SIZES, Supports, renderBusinessCard, renderFlyer, renderNeighbourhoodLetter, renderPanel } from '../src/studio/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Annonce, agent et photos inventés.
const N = '\u00a0';
const S = '\u202f';
const INPUT: PageInput = {
  payload: {
    reference: 'REF-T-9',
    version: 4,
    state: 'en_vente',
    title: 'Appartement 3 pièces à Villebrune',
    body: 'Au 3e étage avec ascenseur.\nBalcon.',
    mentions: `Prix : 210${S}000${N}€ honoraires inclus, soit 200${S}000${N}€ hors honoraires et 5${N}% TTC du prix hors honoraires, à la charge de l'acquéreur.\nCarte professionnelle n° CPI 0000.`,
    priceEur: 210000,
    media: [],
  },
  agent: { firstName: 'Alexandrine', lastName: 'Fictive', phone: '03 00 00 00 00', email: 'alex@exemple.test' },
  photos: [
    { ref: 'biens/b1/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg', kind: 'photo', overlay: null },
    { ref: 'biens/b1/0b6f1d2e-2222-4a2b-8c3d-000000000002.jpg', kind: 'photo', overlay: 'Aménagement virtuel' },
    { ref: 'biens/b1/0b6f1d2e-3333-4a2b-8c3d-000000000003.jpg', kind: 'photo', overlay: null },
  ],
};

const visibleText = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<br>/g, '\n')
    .replace(/<\/(p|h1|h2|li|div)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const ALL = () => ({
  panneau: renderPanel(INPUT)!,
  flyer: renderFlyer(INPUT)!,
  lettre_quartier: renderNeighbourhoodLetter(INPUT)!,
  carte_visite: renderBusinessCard(INPUT.agent!),
});

describe('X06 · supports imprimés', () => {
  it('[R201] chaque support part de la base papier du système de design et passe le contrôle d’accessibilité', () => {
    for (const [kind, html] of Object.entries(ALL())) {
      expect(htmlProblems(html, { print: true }), kind).toEqual([]);
      const size = SUPPORT_SIZES[kind as keyof typeof SUPPORT_SIZES];
      expect(html, kind).toContain(`@page{size:${size.widthMm}mm ${size.heightMm}mm;margin:0}`);
      expect(html, kind).toContain(`.page{width:${size.widthMm}mm;height:${size.heightMm}mm;overflow:hidden`);
      expect(html.match(/<section class="page">/g), kind).toHaveLength(1);
      // Rien d'extérieur : ni script, ni police, ni image d'ailleurs.
      expect(html, kind).not.toMatch(/<script|<link|https?:\/\//);
    }
    expect(SUPPORT_SIZES.carte_visite).toEqual({ widthMm: 85, heightMm: 55, pages: 1 });
    expect(SUPPORT_SIZES.flyer).toMatchObject({ widthMm: 148, heightMm: 210 });
  });

  it('[R43] [R44] le prix et les mentions viennent de la version publiée ; qui montre le prix montre les mentions', () => {
    const { panneau, flyer, lettre_quartier } = ALL();
    for (const html of [flyer, lettre_quartier]) {
      expect(html).toContain(`<p class="prix">210${S}000${N}€</p>`);
      expect(html).toContain(INPUT.payload.mentions!.replace(/'/g, '&#39;'));
      expect(html.indexOf('class="prix"')).toBeLessThan(html.indexOf('class="mentions"'));
    }
    // Le panneau porte aussi toutes les mentions de la version publiée, sans prix en grand.
    expect(panneau).toContain(INPUT.payload.mentions!.replace(/'/g, '&#39;'));
    expect(panneau).not.toContain('class="prix"');
    expect(panneau).toContain('<p class="etat">À vendre</p>');
    expect(renderPanel({ ...INPUT, payload: { ...INPUT.payload, state: 'sous_offre' } })).toContain('<p class="etat">Sous offre</p>');
    // Un autre prix publié : partout le nouveau.
    const amended = { ...INPUT, payload: { ...INPUT.payload, priceEur: 199000, mentions: INPUT.payload.mentions!.replace(`210${S}000`, `199${S}000`) } };
    expect(renderFlyer(amended)).toContain(`199${S}000${N}€`);
    expect(renderFlyer(amended)).not.toContain(`210${S}000${N}€`);
    // Sans mentions, sans prix, ou retirée : rien ne s'imprime.
    expect(renderFlyer({ ...INPUT, payload: { ...INPUT.payload, mentions: null } })).toBeNull();
    expect(renderFlyer({ ...INPUT, payload: { ...INPUT.payload, priceEur: null } })).toBeNull();
    expect(renderNeighbourhoodLetter({ ...INPUT, payload: { ...INPUT.payload, state: 'retiree' } })).toBeNull();
    expect(renderPanel({ ...INPUT, payload: { ...INPUT.payload, state: 'retiree' } })).toBeNull();
  });

  it('[R46] [R48] aucun support ne porte d’adresse ; les textes ajoutés passent le contrôle ; l’aménagement virtuel garde sa mention', () => {
    for (const [kind, html] of Object.entries(ALL())) {
      for (const line of visibleText(html).split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.includes('@'))) {
        expect(publicTextProblems(line).filter((p) => p.code !== 'nombre_sans_source' && p.code !== 'fait_sans_source'), `${kind} : ${line}`).toEqual([]);
      }
    }
    const flyer = renderFlyer(INPUT)!;
    expect(flyer.match(/<img /g)).toHaveLength(2);
    expect(flyer).toContain('<span class="virtuel">Aménagement virtuel</span>');
    expect(flyer).toContain('alt="Photo du bien, aménagement virtuel"');
    // Un texte publié qui porterait une adresse ne vient jamais d'ici : le support n'écrit que le titre publié.
    expect(renderNeighbourhoodLetter(INPUT)).not.toMatch(/\brue\b|\bavenue\b|\bboulevard\b/i);
  });

  it('[R16] sans agent actif, ni panneau ni lettre : personne à joindre', () => {
    expect(renderPanel({ ...INPUT, agent: null })).toBeNull();
    expect(renderNeighbourhoodLetter({ ...INPUT, agent: null })).toBeNull();
    expect(renderBusinessCard({ firstName: 'A', lastName: 'B', phone: null, email: null })).toContain('Agent immobilier');
  });
});

describeWithSqlite('X06 · supports depuis la version publiée', () => {
  it('[R44] [R16] l’agent du bien ou la direction impriment depuis la dernière version publiée ; un autre agent, non', async () => {
    const t = await setupAnnonce();
    const pages = new PageBien(t.db, t.acces, t.journal, { now: t.now });
    const supports = new Supports(t.db, t.acces, t.journal, pages, { now: t.now });
    expect(await supports.render(t.agent, t.propertyId, 'flyer')).toEqual({ ok: false, rule: 'R10', code: 'pas_publie' });
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    await pages.setAgentCard(t.agent, t.alexId, { phone: '03 00 00 00 01', email: 'alex@exemple.test' });
    for (const kind of ['fiche', 'panneau', 'flyer', 'lettre_quartier']) {
      const r = await supports.render(t.agent, t.propertyId, kind);
      expect(r.ok, kind).toBe(true);
      if (r.ok) expect(htmlProblems(r.html, { print: true }), kind).toEqual([]);
    }
    const flyer = await supports.render(t.direction, t.propertyId, 'flyer');
    expect(flyer.ok && flyer.html).toContain(`210${S}000${N}€`);
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    const after = await supports.render(t.agent, t.propertyId, 'flyer');
    expect(after.ok && after.html).toContain(`200${S}000${N}€`);
    expect(await supports.render(t.sam, t.propertyId, 'flyer')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await supports.render(t.agent, t.propertyId, 'affiche_geante')).toEqual({ ok: false, rule: 'R10', code: 'support_inconnu' });
    // La carte de visite : l'agent lui-même ou la direction.
    const card = await supports.businessCard(t.agent, t.alexId);
    expect(card.ok && card.html).toContain('03 00 00 00 01');
    expect(await supports.businessCard(t.sam, t.alexId)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await supports.businessCard(t.direction, t.alexId)).toMatchObject({ ok: true });
    // Retirée : plus rien ne s'imprime.
    await t.db.run("UPDATE properties SET status = 'withdrawn' WHERE id = ?", [t.propertyId]);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await supports.render(t.direction, t.propertyId, 'flyer')).toEqual({ ok: false, rule: 'R10', code: 'annonce_retiree' });
  });
});
