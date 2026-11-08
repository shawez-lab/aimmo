import { describe, expect, it } from 'vitest';
import type { ListingFacts } from '../src/annonces/annonce-sourcee.ts';
import { DiffusionSurveillee } from '../src/diffusion/surveillance.ts';
import { controlPortalText, maskPortalText, PHOTO_SUBJECTS, photoCaption, subjectInSheet, TextesPortails, type PortalTextWriter } from '../src/diffusion/textes.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Réseau, bien, fiche, portails et textes inventés.
const FACTS: ListingFacts = {
  kind: 'home', city: 'Dijon', postalCode: '21000', surfaceM2: 62, rooms: 3, bedrooms: 2, floor: 3, floorsTotal: 5, buildYear: 1965,
  heating: 'collectif', outdoor: ['balcon'], landM2: null, parkingSpaces: 1, elevator: true, energyClass: 'D', climateClass: 'C',
};
const SOURCE = {
  title: 'Logement, 3 pièces, 62 m², Dijon',
  body: 'Logement de 62 m² à Dijon, 3 pièces dont 2 chambres. Au 3e étage sur 5, avec ascenseur. Construit en 1965. Balcon. 1 place de stationnement. Chauffage collectif. Classe énergie D.',
};
const SELOGER = {
  title: 'Dijon : 3 pièces de 62 m²',
  body: 'À Dijon, un logement de 62 m² en 3 pièces, dont 2 chambres, au 3e étage sur 5 avec ascenseur. Construit en 1965. Balcon et 1 place de stationnement. Chauffage collectif. Classe énergie D.',
};
const LEBONCOIN = {
  title: 'Appartement 3 pièces 62 m² à Dijon',
  body: 'Logement de 62 m² à Dijon : 3 pièces, 2 chambres. Il se trouve au 3e étage sur 5, avec ascenseur, dans un immeuble construit en 1965. Un balcon. 1 place de stationnement. Chauffage collectif. Classe énergie D.',
};

describe('HX39 · contrôle du texte d’un portail, sans base', () => {
  it('[R476] un texte récrit qui garde les mêmes nombres et la même classe, chaque phrase sourcée, passe', () => {
    expect(controlPortalText(SOURCE, SELOGER, FACTS)).toEqual({ ok: true, title: [], body: [] });
    expect(controlPortalText(SOURCE, LEBONCOIN, FACTS).ok).toBe(true);
  });

  it('[R476] un nombre changé, ajouté, interverti ou écrit en lettres est refusé', () => {
    expect(controlPortalText(SOURCE, { ...SELOGER, title: 'Dijon : 3 pièces de 65 m²' }, FACTS).title).toEqual(['chiffres_differents']);
    expect(controlPortalText(SOURCE, { ...SELOGER, title: 'Dijon : 62 m² en 3 pièces' }, FACTS).title).toEqual(['chiffres_differents']);
    expect(controlPortalText(SOURCE, { ...SELOGER, body: SELOGER.body.replace('2 chambres', 'deux chambres') }, FACTS).body).toEqual(expect.arrayContaining(['chiffres_differents', 'nombre_en_lettres']));
    expect(controlPortalText(SOURCE, { ...SELOGER, title: 'Dijon : ٣ pièces de 62 m²' }, FACTS).title).toEqual(['chiffres_differents']);
  });

  it('[R476] aucun prix dans le texte d’un portail : le prix vient de la version publiée seule', () => {
    const withPrice = { ...SELOGER, body: `${SELOGER.body} Prix 210 000 €.` };
    expect(controlPortalText(SOURCE, withPrice, FACTS).ok).toBe(false);
    // Même si le texte publié portait un nombre de plus, un prix reste un nombre sans source dans la fiche.
    const sourceWithPrice = { ...SOURCE, body: `${SOURCE.body} Prix 210 000 €.` };
    expect(controlPortalText(sourceWithPrice, withPrice, FACTS).body).toEqual(['phrase_sans_source']);
  });

  it('[R476] une classe changée, un lien, un fait que la fiche ne porte pas ou une adresse sont refusés', () => {
    expect(controlPortalText(SOURCE, { ...SELOGER, body: SELOGER.body.replace('Classe énergie D', 'Classe énergie B') }, FACTS).body).toEqual(['classes_differentes']);
    expect(controlPortalText(SOURCE, { ...SELOGER, body: `${SELOGER.body} Voir www.exemple.test.` }, FACTS).body).toContain('lien_ou_mail');
    expect(controlPortalText(SOURCE, { ...SELOGER, body: SELOGER.body.replace('Balcon et', 'Piscine, balcon et') }, FACTS).body).toEqual(['phrase_sans_source']);
    expect(controlPortalText(SOURCE, { ...SELOGER, body: SELOGER.body.replace('À Dijon,', 'Rue des Essais à Dijon,') }, FACTS).body).toEqual(['phrase_sans_source']);
    expect(controlPortalText(SOURCE, { title: ' ', body: SELOGER.body }, FACTS).title).toEqual(['texte_vide']);
  });
  it('[R476] une classe écrite en minuscule compte aussi : la changer est refusé, « il a » n’est pas une classe', () => {
    const src = { ...SOURCE, body: SOURCE.body.replace('Classe énergie D.', 'Classe énergie d.') };
    expect(controlPortalText(src, { ...SELOGER, body: SELOGER.body.replace('Classe énergie D.', 'Classe énergie c.') }, FACTS).body).toEqual(['classes_differentes']);
    expect(controlPortalText(src, { ...SELOGER, body: SELOGER.body.replace('Classe énergie D.', 'Classe énergie d.') }, FACTS).ok).toBe(true);
    expect(controlPortalText(SOURCE, { ...SELOGER, body: SELOGER.body.replace('Balcon et', 'Il a un balcon et') }, FACTS).body).not.toContain('classes_differentes');
    const f6: ListingFacts = { ...FACTS, energyClass: 'A', climateClass: 'C' };
    const srcA = { ...SOURCE, body: SOURCE.body.replace('Classe énergie D.', 'Classe énergie A.') };
    expect(controlPortalText(srcA, { ...SELOGER, body: SELOGER.body.replace('Classe énergie D.', 'Classe énergie a.') }, f6).ok).toBe(true);
    expect(controlPortalText(srcA, { ...SELOGER, body: SELOGER.body.replace('Classe énergie D.', 'Classe énergie : c.') }, f6).body).toContain('classes_differentes');
  });

  it('[R476] chaque lettre garde son champ : échanger énergie et climat est refusé', () => {
    const src = { ...SOURCE, body: SOURCE.body.replace('Classe énergie D.', 'Classe énergie D. Classe climat C.') };
    const ok = { ...SELOGER, body: SELOGER.body.replace('Classe énergie D.', 'Classe énergie D, classe climat C.') };
    expect(controlPortalText(src, ok, FACTS).ok).toBe(true);
    const swapped = { ...SELOGER, body: SELOGER.body.replace('Classe énergie D.', 'Classe climat D. Classe énergie C.') };
    expect(controlPortalText(src, swapped, FACTS).body).toContain('classes_differentes');
  });

  it('[R476] l’IA ne reçoit aucune lettre de classe, même en minuscule, ni aucun chiffre', () => {
    const values: string[] = [];
    const masked = maskPortalText('Au 3e étage, 62 m². Classe énergie d, classe climat C. Il a un balcon.', values);
    expect(masked).toBe('Au ⟦1⟧e étage, ⟦2⟧ m². Classe énergie ⟦3⟧, classe climat ⟦4⟧. Il a un balcon.');
    expect(values).toEqual(['3', '62', 'd', 'C']);
  });

  it('[R476] tout nombre en lettres est refusé, ordinaux et mots composés compris ; « un » seulement devant une unité', () => {
    const f6: ListingFacts = { ...FACTS, floor: 6 };
    for (const extra of ['Au sixième étage.', 'Au sixieme étage.', 'Vingt-deux lots.', 'Une seconde chambre.', 'Un étage.', 'Neuf pièces.']) {
      expect(controlPortalText(SOURCE, { ...SELOGER, body: `${SELOGER.body} ${extra}` }, f6).body).toContain('nombre_en_lettres');
    }
    expect(controlPortalText(SOURCE, { ...SELOGER, body: SELOGER.body.replace('Balcon et', 'Un balcon et') }, FACTS).body).not.toContain('nombre_en_lettres');
  });

});

describe('HX39 · légendes des photos, sans base', () => {
  it('[R478] la légende dit la place de la photo et ce qu’elle montre, tiré de la fiche', () => {
    expect(photoCaption({ index: 1, total: 4, subject: 'chambre', facts: FACTS, edit: 'aucune', overlay: null })).toBe('Photo 1 sur 4 : une des 2 chambres.');
    expect(photoCaption({ index: 2, total: 4, subject: 'balcon', facts: FACTS, edit: 'aucune', overlay: null })).toBe('Photo 2 sur 4 : le balcon, au 3e étage.');
    expect(photoCaption({ index: 3, total: 4, subject: 'piece_principale', facts: FACTS, edit: 'lumiere_cadrage', overlay: null })).toBe('Photo 3 sur 4 : une des 3 pièces principales. Lumière et cadrage retouchés.');
    expect(photoCaption({ index: 4, total: 4, subject: 'stationnement', facts: FACTS, edit: 'aucune', overlay: null })).toBe('Photo 4 sur 4 : la place de stationnement.');
  });

  it('[R478] une photo sans sujet dit seulement sa place ; un aménagement virtuel est toujours dit', () => {
    expect(photoCaption({ index: 1, total: 2, subject: null, facts: FACTS, edit: null, overlay: null })).toBe('Photo 1 sur 2 du bien.');
    expect(photoCaption({ index: 2, total: 2, subject: 'chambre', facts: FACTS, edit: 'amenagement_virtuel', overlay: 'Aménagement virtuel' })).toBe(
      'Photo 2 sur 2 : une des 2 chambres. Aménagement virtuel : le mobilier et la décoration montrés sont ajoutés à l’image, ils ne sont pas dans le bien.',
    );
  });

  it('[R478] aucune légende ne cite un élément absent de la fiche, quel que soit le sujet dit', () => {
    const empty: ListingFacts = { ...FACTS, rooms: null, bedrooms: 0, outdoor: [], landM2: null, parkingSpaces: 0, elevator: false };
    for (const subject of PHOTO_SUBJECTS) {
      expect(subjectInSheet(subject, empty)).toBe(false);
      expect(photoCaption({ index: 1, total: 1, subject, facts: empty, edit: 'aucune', overlay: null })).toBe('Photo 1 sur 1 du bien.');
    }
    // Avec la fiche pleine, chaque mot de la légende qui nomme un élément vient d'un champ de la fiche.
    const full: ListingFacts = { ...FACTS, outdoor: ['balcon', 'terrasse', 'jardin', 'cour'], landM2: 450 };
    const words: Record<string, (f: ListingFacts) => boolean> = {
      chambre: (f) => (f.bedrooms ?? 0) > 0, balcon: (f) => f.outdoor.includes('balcon'), terrasse: (f) => f.outdoor.includes('terrasse'), jardin: (f) => f.outdoor.includes('jardin'),
      cour: (f) => f.outdoor.includes('cour'), terrain: (f) => f.landM2 !== null, stationnement: (f) => (f.parkingSpaces ?? 0) > 0, ascenseur: (f) => f.elevator === true,
    };
    for (const facts of [full, FACTS, empty]) {
      for (const subject of PHOTO_SUBJECTS) {
        const caption = photoCaption({ index: 1, total: 1, subject, facts, edit: 'aucune', overlay: null }).toLowerCase();
        for (const [w, has] of Object.entries(words)) if (caption.includes(w)) expect(has(facts)).toBe(true);
      }
    }
    expect(photoCaption({ index: 1, total: 1, subject: 'terrain', facts: full, edit: 'aucune', overlay: null })).toBe('Photo 1 sur 1 : le terrain de 450 m².');
  });
});

/** Une IA de test : elle récrit le texte masqué, ou se trompe à la demande. */
class FakeWriter implements PortalTextWriter {
  seen: { portal: string; title: string; body: string }[] = [];
  mode: 'bien' | 'chiffre' | 'repere_perdu' | 'piscine' | 'panne' = 'bien';
  async write(input: { portal: string; title: string; body: string }): Promise<{ title: string; body: string }> {
    this.seen.push(input);
    if (this.mode === 'panne') throw new Error('indisponible');
    const title = input.title.replace(/^Logement, /, 'À Dijon, logement de ').replace(/, Dijon$/, '');
    const body = input.body.replace('Balcon.', 'Avec un balcon.');
    if (this.mode === 'chiffre') return { title: `${title} 4`, body };
    if (this.mode === 'repere_perdu') return { title: title.replace('⟦1⟧', ''), body };
    if (this.mode === 'piscine') return { title, body: `${body} Piscine.` };
    return { title, body };
  }
}

async function setup() {
  const t = await setupAnnonce();
  t.setClock(new Date('2027-02-12T10:00:00.000Z'));
  await t.annonces.validate(t.agent, t.draftId);
  t.setClock(new Date('2027-03-01T08:00:00.000Z'));
  await t.publication.sync(t.network.id, t.propertyId);
  let n = 0;
  const newId = () => `id-${++n}`;
  const d = new DiffusionSurveillee(t.db, t.acces, t.journal, { now: t.now, newId });
  await d.setPortal(t.direction, { code: 'seloger', label: 'SeLoger', host: 'www.seloger.com', requiredFields: ['titre', 'texte', 'prix', 'mentions'], minPhotos: 1 });
  await d.setPortal(t.direction, { code: 'leboncoin', label: 'leboncoin', host: 'www.leboncoin.fr', requiredFields: ['prix'], minPhotos: 0 });
  await d.choose(t.agent, t.propertyId, 'seloger', true);
  await d.choose(t.agent, t.propertyId, 'leboncoin', true);
  const writer = new FakeWriter();
  const tp = new TextesPortails(t.db, t.acces, t.journal, { now: t.now, newId, writer });
  const sheet = await t.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [t.propertyId]);
  const photos = (JSON.parse(sheet!.data) as { media: { ref: string; kind: string }[] }).media.filter((m) => m.kind === 'photo').map((m) => m.ref);
  return { ...t, d, tp, writer, photos };
}

describeWithSqlite('HX39 · texte par portail et légendes des photos', () => {
  it('[R476] prix, mentions et photos identiques dans tous les textes : seuls le titre et le texte changent', async () => {
    const t = await setup();
    expect(await t.tp.write(t.agent, { propertyId: t.propertyId, portal: 'seloger', ...SELOGER })).toMatchObject({ ok: true });
    expect(await t.tp.write(t.agent, { propertyId: t.propertyId, portal: 'leboncoin', ...LEBONCOIN })).toMatchObject({ ok: true });
    const sl = (await t.tp.portalListings(t.network.id, 'seloger'))[0]!;
    const lbc = (await t.tp.portalListings(t.network.id, 'leboncoin'))[0]!;
    const site = (await t.tp.portalPayload(t.network.id, t.propertyId, 'site'))!;
    expect([sl.title, lbc.title, site.title]).toEqual([SELOGER.title, LEBONCOIN.title, SOURCE.title]);
    expect([sl.body, lbc.body, site.body]).toEqual([SELOGER.body, LEBONCOIN.body, SOURCE.body]);
    for (const p of [lbc, site]) {
      expect(p.priceEur).toBe(sl.priceEur);
      expect(p.mentions).toBe(sl.mentions);
      expect(p.media).toEqual(sl.media);
      expect([p.reference, p.version, p.state]).toEqual([sl.reference, sl.version, sl.state]);
    }
    const published = JSON.parse((await t.db.first<{ payload: string }>('SELECT payload FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [t.propertyId]))!.payload) as { priceEur: number; mentions: string };
    expect(sl.priceEur).toBe(published.priceEur);
    expect(sl.mentions).toBe(published.mentions);
  });

  it('[R476] un texte d’agent refusé au contrôle n’est pas gardé, et le portail reçoit le texte publié', async () => {
    const t = await setup();
    const r = await t.tp.write(t.agent, { propertyId: t.propertyId, portal: 'seloger', title: SELOGER.title, body: `${SELOGER.body} Prix 199 000 €.` });
    expect(r).toMatchObject({ ok: false, rule: 'R476', code: 'texte_refuse' });
    expect(await t.db.first('SELECT 1 FROM diffusion_portal_texts')).toBeNull();
    expect((await t.tp.portalPayload(t.network.id, t.propertyId, 'seloger'))).toMatchObject({ title: SOURCE.title, body: SOURCE.body, portalTextId: null });
  });

  it('[R476] [R477] l’IA ne voit ni chiffre ni classe ; son texte attend la validation de l’agent du bien', async () => {
    const t = await setup();
    const r = await t.tp.draft(t.agent, { propertyId: t.propertyId, portal: 'seloger' });
    expect(r).toMatchObject({ ok: true, title: 'À Dijon, logement de 3 pièces, 62 m²' });
    expect(t.writer.seen[0]!.title).toBe('Logement, ⟦1⟧ pièces, ⟦2⟧ m², Dijon');
    expect(/[0-9]/.test((t.writer.seen[0]!.title + t.writer.seen[0]!.body).replace(/⟦\d+⟧/g, ''))).toBe(false);
    expect(t.writer.seen[0]!.body).toContain('Classe énergie ⟦');
    // Pas encore validé : le portail reçoit le texte publié.
    expect((await t.tp.portalPayload(t.network.id, t.propertyId, 'seloger'))!.title).toBe(SOURCE.title);
    if (!r.ok) throw new Error('draft');
    expect(await t.tp.validate(t.sam, r.textId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.tp.validate(t.direction, r.textId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.tp.validate(t.agent, r.textId)).toEqual({ ok: true });
    expect(await t.tp.validate(t.agent, r.textId)).toEqual({ ok: false, rule: 'R477', code: 'deja_valide' });
    const p = (await t.tp.portalPayload(t.network.id, t.propertyId, 'seloger'))!;
    expect(p).toMatchObject({ title: 'À Dijon, logement de 3 pièces, 62 m²', portalTextId: r.textId });
    expect(p.body).toContain('Avec un balcon.');
    // Un autre portail n'en reçoit rien.
    expect((await t.tp.portalPayload(t.network.id, t.propertyId, 'leboncoin'))!.title).toBe(SOURCE.title);
  });

  it('[R476] une IA qui ajoute un chiffre, perd un repère, invente un fait ou tombe en panne est refusée, rien n’est gardé', async () => {
    const t = await setup();
    for (const mode of ['chiffre', 'repere_perdu', 'piscine', 'panne'] as const) {
      t.writer.mode = mode;
      expect(await t.tp.draft(t.agent, { propertyId: t.propertyId, portal: 'seloger' })).toEqual({ ok: false, rule: 'R476', code: 'ia_refusee' });
    }
    expect(await t.db.first('SELECT 1 FROM diffusion_portal_texts')).toBeNull();
    const events = await t.db.all<{ type: string }>("SELECT type FROM journal WHERE type = 'diffusion.texte_portail_ia_refuse'");
    expect(events).toHaveLength(4);
  });

  it('[R477] une nouvelle version publiée rend caducs les textes des portails : le portail reçoit le nouveau texte publié', async () => {
    const t = await setup();
    const d = await t.tp.draft(t.agent, { propertyId: t.propertyId, portal: 'seloger' });
    expect(await t.tp.write(t.agent, { propertyId: t.propertyId, portal: 'leboncoin', ...LEBONCOIN })).toMatchObject({ ok: true });
    await t.amend(205000);
    t.setClock(new Date('2027-03-02T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    const lbc = (await t.tp.portalPayload(t.network.id, t.propertyId, 'leboncoin'))!;
    expect(lbc.version).toBe(2);
    expect(lbc).toMatchObject({ title: SOURCE.title, portalTextId: null, priceEur: 215000 });
    if (!d.ok) throw new Error('draft');
    expect(await t.tp.validate(t.agent, d.textId)).toEqual({ ok: false, rule: 'R477', code: 'version_depassee' });
    expect(await t.tp.texts(t.agent, t.propertyId)).toEqual({ ok: true, texts: [] });
  });

  it('[R477] [R16] seul l’agent du bien en activité écrit le texte d’un portail réglé par la direction', async () => {
    const t = await setup();
    expect(await t.tp.write(t.sam, { propertyId: t.propertyId, portal: 'seloger', ...SELOGER })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.tp.write(t.direction, { propertyId: t.propertyId, portal: 'seloger', ...SELOGER })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.tp.write(t.agent, { propertyId: t.propertyId, portal: 'pap', ...SELOGER })).toEqual({ ok: false, rule: 'R477', code: 'portail_inconnu' });
    const texts = await t.tp.texts(t.agent, t.propertyId);
    expect(texts).toEqual({ ok: true, texts: [] });
  });

  it('[R476] un texte validé que la fiche ne porte plus retombe sur le texte publié', async () => {
    const t = await setup();
    expect(await t.tp.write(t.agent, { propertyId: t.propertyId, portal: 'seloger', ...SELOGER })).toMatchObject({ ok: true });
    // La fiche perd son balcon ; la version publiée n'a pas encore changé.
    const row = await t.db.first<{ id: string; network_id: string; version: number; data: string; created_by: string }>('SELECT * FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [t.propertyId]);
    const sheet = JSON.parse(row!.data) as { characteristics: { outdoor: string[] } };
    sheet.characteristics.outdoor = [];
    await t.db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['fiche-2', t.propertyId, row!.network_id, Number(row!.version) + 1, JSON.stringify(sheet), row!.created_by, t.now().toISOString()]);
    expect((await t.tp.portalPayload(t.network.id, t.propertyId, 'seloger'))).toMatchObject({ title: SOURCE.title, portalTextId: null });
  });

  it('[R478] chaque photo reçoit sa légende ; ce que l’agent dit d’une photo doit être dans la fiche', async () => {
    const t = await setup();
    const [p1, p2] = t.photos;
    expect(await t.tp.describePhoto(t.agent, { propertyId: t.propertyId, ref: p1, subject: 'piscine' })).toEqual({ ok: false, rule: 'R478', code: 'sujet_inconnu' });
    expect(await t.tp.describePhoto(t.agent, { propertyId: t.propertyId, ref: p1, subject: 'jardin' })).toEqual({ ok: false, rule: 'R478', code: 'absent_de_la_fiche' });
    expect(await t.tp.describePhoto(t.agent, { propertyId: t.propertyId, ref: 'biens/x/autre.jpg', subject: 'balcon' })).toEqual({ ok: false, rule: 'R478', code: 'photo_inconnue' });
    expect(await t.tp.describePhoto(t.sam, { propertyId: t.propertyId, ref: p1, subject: 'balcon' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.tp.describePhoto(t.agent, { propertyId: t.propertyId, ref: p1, subject: 'balcon' })).toEqual({ ok: true });
    expect(await t.tp.describePhoto(t.agent, { propertyId: t.propertyId, ref: p2, subject: 'chambre' })).toEqual({ ok: true });
    let media = (await t.tp.portalPayload(t.network.id, t.propertyId, 'seloger'))!.media;
    expect(media.map((m) => m.caption)).toEqual([
      'Photo 1 sur 2 : le balcon, au 3e étage. Lumière et cadrage retouchés.',
      'Photo 2 sur 2 : une des 2 chambres. Aménagement virtuel : le mobilier et la décoration montrés sont ajoutés à l’image, ils ne sont pas dans le bien.',
    ]);
    // Les légendes sont les mêmes sur chaque portail.
    expect((await t.tp.portalListings(t.network.id, 'leboncoin'))[0]!.media).toEqual(media);
    // Le dernier choix fait foi ; « aucun » le retire.
    expect(await t.tp.describePhoto(t.agent, { propertyId: t.propertyId, ref: p1, subject: null })).toEqual({ ok: true });
    media = (await t.tp.portalPayload(t.network.id, t.propertyId, 'seloger'))!.media;
    expect(media[0]!.caption).toBe('Photo 1 sur 2 du bien. Lumière et cadrage retouchés.');
  });

  it('[R478] une fiche qui ne porte plus ce que la photo montrait : la légende ne le cite plus', async () => {
    const t = await setup();
    expect(await t.tp.describePhoto(t.agent, { propertyId: t.propertyId, ref: t.photos[0], subject: 'balcon' })).toEqual({ ok: true });
    const row = await t.db.first<{ network_id: string; version: number; data: string; created_by: string }>('SELECT * FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [t.propertyId]);
    const sheet = JSON.parse(row!.data) as { characteristics: { outdoor: string[] } };
    sheet.characteristics.outdoor = [];
    await t.db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['fiche-2', t.propertyId, row!.network_id, Number(row!.version) + 1, JSON.stringify(sheet), row!.created_by, t.now().toISOString()]);
    const media = (await t.tp.portalPayload(t.network.id, t.propertyId, 'seloger'))!.media;
    expect(media[0]!.caption).toBe('Photo 1 sur 2 du bien. Lumière et cadrage retouchés.');
    expect(media.every((m) => !m.caption?.toLowerCase().includes('balcon'))).toBe(true);
  });

  it('[R478] les retouches dites viennent de la fiche publiée, pas d’une fiche plus récente pas encore publiée', async () => {
    const t = await setup();
    const row = await t.db.first<{ network_id: string; version: number; data: string; created_by: string }>('SELECT * FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [t.propertyId]);
    const sheet = JSON.parse(row!.data) as { media: { ref: string; kind: string; edit: string }[] };
    // La fiche suivante retire la première photo et déclare la deuxième sans retouche ; rien n'est encore publié.
    sheet.media = sheet.media.slice(1).map((m) => ({ ...m, edit: 'aucune' }));
    await t.db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['fiche-2', t.propertyId, row!.network_id, Number(row!.version) + 1, JSON.stringify(sheet), row!.created_by, t.now().toISOString()]);
    const media = (await t.tp.portalPayload(t.network.id, t.propertyId, 'seloger'))!.media;
    expect(media.map((m) => m.caption)).toEqual([
      'Photo 1 sur 2 du bien. Lumière et cadrage retouchés.',
      'Photo 2 sur 2 du bien. Aménagement virtuel : le mobilier et la décoration montrés sont ajoutés à l’image, ils ne sont pas dans le bien.',
    ]);
  });

  it('[R17] textes, validations et sujets des photos ne s’effacent ni ne se réécrivent', async () => {
    const t = await setup();
    await t.tp.write(t.agent, { propertyId: t.propertyId, portal: 'seloger', ...SELOGER });
    await t.tp.describePhoto(t.agent, { propertyId: t.propertyId, ref: t.photos[0], subject: 'balcon' });
    for (const table of ['diffusion_portal_texts', 'diffusion_portal_text_validations', 'diffusion_photo_subjects']) {
      await expect(t.db.run(`DELETE FROM ${table}`)).rejects.toThrow();
      await expect(t.db.run(`UPDATE ${table} SET by_actor = 'x'`.replace('by_actor', table === 'diffusion_portal_texts' ? 'created_by' : 'by_actor'))).rejects.toThrow();
    }
  });
});
