import { describe, expect, it } from 'vitest';
import { AnnoncesTraduites, ExportPortailsEtrangers, LANGUAGE_NAMES, LISTING_LANGUAGES, controlTranslation, type ListingLanguage, type ListingTranslator } from '../src/annonces/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// AU069 · Allemand, espagnol, italien et néerlandais pour les annonces, avec la même validation et le même contrôle.
// Textes inventés.
const FR = { title: 'Appartement, 3 pièces, 62 m², Dijon', body: 'Appartement de 62 m² à Dijon, 3 pièces dont 2 chambres. Au 3e étage sur 5. Prix 210 000 €. Classe énergie D.' };
const FIDELE: Record<'de' | 'es' | 'it' | 'nl', { title: string; body: string }> = {
  de: { title: 'Wohnung, 3 Zimmer, 62 m², Dijon', body: 'Helle Wohnung mit 62 m² in Dijon, 3 Zimmer, davon 2 Schlafzimmer. Im 3e Stock von 5. Preis 210 000 €. Energieklasse D.' },
  es: { title: 'Piso, 3 habitaciones, 62 m², Dijon', body: 'A pocos pasos del centro, piso de 62 m² en Dijon, 3 habitaciones con 2 dormitorios. En la planta 3e de 5. Precio 210 000 €. Clase energética D.' },
  it: { title: 'Appartamento, 3 locali, 62 m², Dijon', body: 'Appartamento di 62 m² a Dijon, 3 locali di cui 2 camere. E la luce entra ovunque. Al 3e piano su 5. Prezzo 210 000 €. Classe energetica D.' },
  nl: { title: 'Appartement, 3 kamers, 62 m², Dijon', body: 'Licht appartement van 62 m² in Dijon, 3 kamers waarvan 2 slaapkamers. Op de 3e verdieping van 5. Prijs 210 000 €. Energieklasse D.' },
};

describe('AU069 · le contrôle d’une traduction vaut pour les quatre langues', () => {
  it('[R257] le constat : l’allemand, l’espagnol, l’italien et le néerlandais sont des langues d’annonce, nommées en français', () => {
    for (const l of ['de', 'es', 'it', 'nl'] as const) expect(LISTING_LANGUAGES).toContain(l);
    expect([LANGUAGE_NAMES.de, LANGUAGE_NAMES.es, LANGUAGE_NAMES.it, LANGUAGE_NAMES.nl]).toEqual(['allemand', 'espagnol', 'italien', 'néerlandais']);
  });

  it('[R257] une traduction fidèle passe ; « A » ou « E » en tête de phrase espagnole ou italienne n’est pas une classe', () => {
    for (const [l, t] of Object.entries(FIDELE)) expect(controlTranslation(FR, t, l as ListingLanguage), l).toEqual({ ok: true, title: [], body: [] });
  });

  it('[R257] un chiffre changé, un nombre en lettres, une classe changée sont refusés, comme en anglais', () => {
    const body = (l: keyof typeof FIDELE, b: string) => controlTranslation(FR, { title: FIDELE[l].title, body: b }, l).body;
    expect(body('de', FIDELE.de.body.replace('210 000', '200 000'))).toEqual(['chiffre_manquant', 'chiffre_ajoute']);
    expect(body('de', `${FIDELE.de.body} Zwei Balkone.`)).toEqual(['nombre_en_lettres']);
    expect(body('es', `${FIDELE.es.body} Con tres balcones.`)).toEqual(['nombre_en_lettres']);
    expect(body('it', `${FIDELE.it.body} Con due balconi.`)).toEqual(['nombre_en_lettres']);
    expect(body('nl', `${FIDELE.nl.body} Met twee balkons.`)).toEqual(['nombre_en_lettres']);
    expect(body('nl', FIDELE.nl.body.replace('klasse D', 'klasse B'))).toEqual(['classe_manquante', 'classe_ajoutee']);
    expect(body('it', FIDELE.it.body.replace('62 m²', '62 mq'))).toEqual(['chiffre_manquant', 'chiffre_ajoute']);
  });

  it('[R257] [R46] une voie nommée, un critère discriminant, un mot interdit, un lien sont refusés dans chacune', () => {
    const body = (l: keyof typeof FIDELE, extra: string) => controlTranslation(FR, { title: FIDELE[l].title, body: `${FIDELE[l].body} ${extra}` }, l).body;
    expect(body('de', 'In der Straße des Parks.')).toEqual(['adresse']);
    expect(body('de', 'Ideal für eine Familie.')).toEqual(['critere_discriminant']);
    expect(body('de', 'Kostenlose Besichtigung, kostenlos.')).toEqual(['mot_interdit']);
    expect(body('es', 'Cerca de la calle Mayor.')).toEqual(['adresse']);
    expect(body('es', 'Sin niños.')).toEqual(['critere_discriminant']);
    expect(body('es', 'Visita gratis.')).toEqual(['mot_interdit']);
    expect(body('it', 'Vicino a piazza Grande.')).toEqual(['adresse']);
    expect(body('it', 'Ideale per una coppia.')).toEqual(['critere_discriminant']);
    expect(body('nl', 'Bij het plein.')).toEqual(['adresse']);
    expect(body('nl', 'Geen kinderen.')).toEqual(['critere_discriminant']);
    expect(body('nl', 'Zie www.voorbeeld.test')).toEqual(['lien_ou_mail']);
  });

  it('[R257] [R46] une voie soudée (« Lindenstraße », « Kerkstraat ») ou suivie de son nom (« via Roma », « plaza Mayor ») est refusée ; « Stellplatz » ou « plaza de garaje » passent', () => {
    const body = (l: keyof typeof FIDELE, extra: string) => controlTranslation(FR, { title: FIDELE[l].title, body: `${FIDELE[l].body} ${extra}` }, l).body;
    expect(body('de', 'In der Lindenstraße.')).toEqual(['adresse']);
    expect(body('de', 'Nahe Gartenstrasse.')).toEqual(['adresse']);
    expect(body('de', 'Nahe Lindenstr. und Park.')).toEqual(['adresse']);
    expect(body('de', 'An der Rosenallee.')).toEqual(['adresse']);
    expect(body('nl', 'Aan de Kerkstraat.')).toEqual(['adresse']);
    expect(body('nl', 'Vlak bij het Marktplein.')).toEqual(['adresse']);
    expect(body('nl', 'Aan de Prinsengracht.')).toEqual(['adresse']);
    expect(body('it', 'In via Roma.')).toEqual(['adresse']);
    expect(body('it', 'Vicino a Corso di Porta Nuova.')).toEqual(['adresse']);
    expect(body('es', 'Junto a la plaza Mayor.')).toEqual(['adresse']);
    expect(body('es', 'En la calle de Alcalá.')).toEqual(['adresse']);
    // Ce qui ne nomme aucune voie passe.
    expect(body('de', 'Mit Stellplatz und Fußweg zum Park.')).toEqual([]);
    expect(body('es', 'Con plaza de garaje.')).toEqual([]);
    expect(body('it', 'Luminoso, via dal traffico.')).toEqual([]);
    expect(body('nl', 'Met een ruime tuin.')).toEqual([]);
    // Un verbe qui finit comme une voie n'en nomme aucune (Codex, P2).
    expect(body('nl', 'De deuren slaan open naar de tuin.')).toEqual([]);
  });
});

/** Une IA de test : elle rend les repères tels quels, marqués de la langue demandée. */
class FakeTranslator implements ListingTranslator {
  received: ListingLanguage[] = [];
  async translate(input: { language: ListingLanguage; title: string; body: string }) {
    this.received.push(input.language);
    return { title: `[${input.language}] ${input.title}`, body: `[${input.language}] ${input.body}` };
  }
}

async function setup() {
  const t = await setupAnnonce();
  t.setClock(new Date('2027-02-12T10:00:00.000Z'));
  const v = await t.annonces.validate(t.agent, t.draftId);
  if (!v.ok) throw new Error(v.code);
  t.setClock(new Date('2027-03-01T08:00:00.000Z'));
  await t.publication.sync(t.network.id, t.propertyId);
  const ia = new FakeTranslator();
  let n = 0;
  const tr = new AnnoncesTraduites(t.db, t.acces, t.journal, { now: t.now, translator: ia, newId: () => `tr-${++n}` });
  const exporter = new ExportPortailsEtrangers(t.db, t.acces, t.journal);
  return { ...t, ia, tr, exporter };
}

describeWithSqlite('AU069 · les quatre langues se règlent selon les langues des agents', () => {
  it('[R258] le constat : un agent qui déclare l’allemand, l’espagnol, l’italien et le néerlandais les ouvre, et seulement lui', async () => {
    const s = await setup();
    expect(await s.tr.declareLanguages(s.agent, s.alexId, ['nl', 'de', 'it', 'es', 'en'])).toEqual({ ok: true, value: ['en', 'de', 'es', 'it', 'nl'] });
    expect(await s.tr.languagesFor(s.network.id, s.alexId, s.propertyId)).toEqual(['en', 'de', 'es', 'it', 'nl']);
    // Un autre agent qui ne les déclare pas n'a rien d'ouvert.
    expect(await s.tr.declareLanguages(s.sam, s.sam.userId, ['ar'])).toMatchObject({ ok: true });
    expect(await s.tr.languagesFor(s.network.id, s.sam.userId)).toEqual(['ar']);
    // Sans déclaration, refusées.
    await s.tr.declareLanguages(s.agent, s.alexId, ['en']);
    expect(await s.tr.propose(s.agent, s.propertyId, 'de')).toMatchObject({ ok: false, rule: 'R258', code: 'langue_non_parlee' });
  });

  it('[R257] [R258] chaque langue a sa traduction, sa dernière version et sa validation, sans se mêler à l’anglais', async () => {
    const s = await setup();
    await s.tr.declareLanguages(s.agent, s.alexId, ['en', 'de', 'es', 'it', 'nl']);
    const en = await s.tr.propose(s.agent, s.propertyId, 'en');
    const de = await s.tr.propose(s.agent, s.propertyId, 'de');
    const es = await s.tr.propose(s.agent, s.propertyId, 'es');
    if (!en.ok || !de.ok || !es.ok) throw new Error('proposition');
    expect(s.ia.received).toEqual(['en', 'de', 'es']);
    expect(de.value).toMatchObject({ language: 'de', origin: 'ia' });
    expect(de.value.body.startsWith('[de] ')).toBe(true);
    // Chaque langue relit sa propre traduction, la dernière : l'anglais ne masque pas l'allemand, ni l'inverse.
    expect(await s.tr.read(s.agent, s.propertyId, 'en')).toMatchObject({ ok: true, value: { id: en.value.id, language: 'en' } });
    expect(await s.tr.read(s.agent, s.propertyId, 'de')).toMatchObject({ ok: true, value: { id: de.value.id, language: 'de' } });
    expect(await s.tr.read(s.agent, s.propertyId, 'it')).toEqual({ ok: true, value: null });
    // Valider l'allemand : la traduction anglaise, plus ancienne, reste validable, et l'espagnol, plus récent, ne rend pas l'allemand « pas le dernier ».
    expect((await s.tr.validate(s.agent, de.value.id)).ok).toBe(true);
    expect((await s.tr.validate(s.agent, en.value.id)).ok).toBe(true);
    // Une correction de l'agent passe le même contrôle des chiffres.
    expect(await s.tr.correct(s.agent, s.propertyId, 'es', { title: es.value.title, body: es.value.body.replace('62 m²', '64 m²') })).toMatchObject({ ok: false, rule: 'R257', code: 'refused_text', body: ['chiffre_manquant', 'chiffre_ajoute'] });
    const own = await s.tr.correct(s.agent, s.propertyId, 'es', { title: es.value.title, body: es.value.body.replace('[es] ', '') });
    if (!own.ok) throw new Error(own.code);
    expect(await s.tr.validate(s.agent, es.value.id)).toMatchObject({ ok: false, rule: 'R258', code: 'not_latest' });
    expect((await s.tr.validate(s.agent, own.value.id)).ok).toBe(true);
    // Le flux des portails étrangers et l'acheteur ne reçoivent que les traductions validées, dans leur langue.
    expect((await s.exporter.listings(s.network.id)).map((l) => l.language)).toEqual(['en', 'de', 'es']);
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, 'de')).toMatchObject({ language: 'de', body: de.value.body, rightToLeft: false });
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, 'nl')).toMatchObject({ language: 'en' });
    const feed = (await s.exporter.feed(s.network.id)).body;
    expect(feed).toContain('langue="de" sens="ltr"');
    // L'agent qui ne déclare plus l'allemand n'y publie plus.
    await s.tr.declareLanguages(s.agent, s.alexId, ['en', 'es']);
    expect((await s.exporter.listings(s.network.id)).map((l) => l.language)).toEqual(['en', 'es']);
  });

  it('[R258] la direction désigne un relecteur néerlandais ; lui seul valide le néerlandais, sans toucher à un relecteur anglais', async () => {
    const s = await setup();
    await s.tr.declareLanguages(s.agent, s.alexId, ['en']);
    await s.tr.declareLanguages(s.sam, s.sam.userId, ['nl']);
    expect(await s.tr.designateReviewer(s.direction, s.propertyId, 'nl', s.sam.userId)).toEqual({ ok: true });
    expect(await s.tr.languagesFor(s.network.id, s.alexId, s.propertyId)).toEqual(['en', 'nl']);
    const nl = await s.tr.propose(s.agent, s.propertyId, 'nl');
    if (!nl.ok) throw new Error(nl.code);
    expect(await s.tr.validate(s.agent, nl.value.id)).toMatchObject({ ok: false, code: 'langue_non_parlee' });
    expect((await s.tr.validate(s.sam, nl.value.id)).ok).toBe(true);
    expect((await s.tr.reviewers(s.network.id, s.propertyId)).get('nl')).toBe(s.sam.userId);
    expect((await s.tr.reviewers(s.network.id, s.propertyId)).has('en')).toBe(false);
    expect((await s.exporter.listings(s.network.id)).map((l) => l.language)).toEqual(['nl']);
    // Retiré : le néerlandais se ferme.
    expect(await s.tr.designateReviewer(s.direction, s.propertyId, 'nl', null)).toEqual({ ok: true });
    expect((await s.exporter.listings(s.network.id)).map((l) => l.language)).toEqual([]);
  });

  it('[R257] la base range une langue nouvelle seulement sous l’anglais, et ne la change jamais', async () => {
    const s = await setup();
    await s.tr.declareLanguages(s.agent, s.alexId, ['it']);
    const it = await s.tr.propose(s.agent, s.propertyId, 'it');
    if (!it.ok) throw new Error(it.code);
    expect(await s.db.first('SELECT language, language_code FROM listing_translations WHERE id = ?', [it.value.id])).toEqual({ language: 'en', language_code: 'it' });
    const insert = (language: string, code: string) =>
      s.db.run(
        "INSERT INTO listing_translations (id, property_id, network_id, draft_id, language, language_code, seq, title, body, origin, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 99, 't', 'b', 'ia', 'a', 'n')",
        [`x-${language}-${code}`, s.propertyId, s.network.id, s.draftId, language, code],
      );
    await expect(insert('ar', 'de')).rejects.toThrow(/rangée sous une autre/);
    await expect(insert('en', 'ar')).rejects.toThrow(/rangée sous une autre/);
    await expect(insert('en', 'xx')).rejects.toThrow();
    await expect(s.db.run("UPDATE listing_translations SET language_code = 'de' WHERE id = ?", [it.value.id])).rejects.toThrow(/ne change plus/);
    await expect(
      s.db.run("INSERT INTO translation_reviewers (id, network_id, property_id, language, language_code, seq, reviewer_agent_id, designated_by, designated_at) VALUES ('r', ?, ?, 'el', 'nl', 1, NULL, 'd', 'n')", [s.network.id, s.propertyId]),
    ).rejects.toThrow(/rangée sous une autre/);
  });
});
