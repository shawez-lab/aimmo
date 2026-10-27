import { describe, expect, it } from 'vitest';
import { PageBien, renderListingPage, renderListingPrint, type PageInput } from '../src/annonces/index.ts';
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
    expect(html).not.toMatch(/display:\s*none|hidden/);
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

  it('la fiche imprimable a exactement deux pages A4, la première porte le prix et les mentions, quatre photos au plus', () => {
    const many = { ...INPUT, photos: Array.from({ length: 9 }, (_, i) => ({ ref: `biens/b1/0b6f1d2e-1111-4a2b-8c3d-00000000000${i}.jpg`, kind: 'photo' as const, overlay: null })) };
    const html = renderListingPrint(many)!;
    expect(html.match(/<section class="page">/g)).toHaveLength(2);
    expect(html).toContain('@page{size:A4');
    expect(html).toContain('height:297mm;padding:16mm 16mm 14mm;overflow:hidden');
    const [page1, page2] = html.split('<section class="page">').slice(1);
    expect(page1).toContain('class="prix"');
    expect(page1).toContain('class="mentions"');
    expect(page1!.match(/<img /g)).toHaveLength(4);
    expect(page2).toContain('class="texte"');
    expect(page2).toContain('agent immobilier');
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
  });
});
