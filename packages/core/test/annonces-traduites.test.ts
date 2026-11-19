import { describe, expect, it } from 'vitest';
import {
  AnnoncesTraduites,
  ExportPortailsEtrangers,
  INTERNATIONAL_TRIAL_FORMAT,
  buyerLanguage,
  controlTranslation,
  maskFigures,
  unmaskFigures,
  type ListingLanguage,
  type ListingTranslator,
} from '../src/annonces/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Textes inventés.
const FR = { title: 'Appartement, 3 pièces, 62 m², Dijon', body: 'Appartement de 62 m² à Dijon, 3 pièces dont 2 chambres. Au 3e étage sur 5. Prix 210 000 €. Classe énergie D.' };
const EN = { title: 'Apartment, 3 rooms, 62 m², Dijon', body: 'A bright apartment of 62 m² in Dijon, 3 rooms including 2 bedrooms. On the 3e floor of 5. Price 210 000 €. Energy class D.' };

describe('HX05 · contrôle d’une traduction', () => {
  it('[R257] mêmes nombres écrits pareil et même classe : la traduction passe ; « A » en tête de phrase anglaise est l’article', () => {
    expect(controlTranslation(FR, EN, 'en')).toEqual({ ok: true, title: [], body: [] });
  });

  it('[R257] un chiffre changé, écrit autrement, en autre écriture ou en lettres est refusé', () => {
    const body = (b: string) => controlTranslation(FR, { title: EN.title, body: b }, 'en').body;
    expect(body(EN.body.replace('210 000', '200 000'))).toEqual(['chiffre_manquant', 'chiffre_ajoute']);
    expect(body(EN.body.replace('210 000', '210,000'))).toEqual(['chiffre_manquant', 'chiffre_ajoute']);
    expect(body(EN.body.replace(' of 5', ''))).toEqual(['chiffre_manquant']);
    expect(body(`${EN.body} Built in 1965.`)).toEqual(['chiffre_ajoute']);
    expect(body(EN.body.replace('2 bedrooms', '2 bedrooms and three balconies'))).toEqual(['nombre_en_lettres']);
    // Chiffres arabes orientaux de même valeur : jamais le même chiffre.
    const ar = { title: 'شقة، 3 غرف، 62 m²، ديجون', body: FR.body.replace('62', '٦٢') };
    expect(controlTranslation(FR, ar, 'ar').body).toContain('chiffre_autre_ecriture');
    expect(controlTranslation(FR, { title: FR.title, body: `${FR.body} اثنان` }, 'ar').body).toEqual(['nombre_en_lettres']);
    expect(controlTranslation(FR, { title: FR.title, body: `${FR.body} δύο` }, 'el').body).toEqual(['nombre_en_lettres']);
  });

  it('[R257] des chiffres ou des classes intervertis, ou une unité changée, sont refusés', () => {
    const fr = { title: FR.title, body: `${FR.body} Climat B.` };
    const body = (b: string) => controlTranslation(fr, { title: EN.title, body: b }, 'en').body;
    expect(body(`${EN.body} Climate B.`)).toEqual([]);
    expect(body(`${EN.body.replace('class D', 'class B')} Climate D.`)).toEqual(['classes_interverties']);
    expect(body(`${EN.body.replace('62 m²', '3 m²').replace('3 rooms', '62 rooms')} Climate B.`)).toEqual(['chiffre_manquant', 'chiffre_ajoute']);
    expect(controlTranslation(FR, { title: EN.title, body: 'Apartment in Dijon, 3 rooms including 2 bedrooms, 62 m². On the 3e floor of 5. Price 210 000 €. Energy class D.' }, 'en').body).toEqual(['chiffres_intervertis']);
    expect(body(`${EN.body.replace('62 m²', '62 sq ft')} Climate B.`)).toEqual(['chiffre_manquant', 'chiffre_ajoute']);
    expect(body(`${EN.body.replace('210 000 €', '210 000 $')} Climate B.`)).toEqual(['chiffre_manquant', 'chiffre_ajoute']);
  });

  it('[R257] une classe énergie changée ou ajoutée, un lien ou une adresse mail sont refusés ; un texte vide aussi', () => {
    const body = (b: string) => controlTranslation(FR, { title: EN.title, body: b }, 'en').body;
    expect(body(EN.body.replace('class D', 'class B'))).toEqual(['classe_manquante', 'classe_ajoutee']);
    expect(body(`${EN.body} Climate class C.`)).toEqual(['classe_ajoutee']);
    expect(body(`${EN.body} Write to agent@example.test.`)).toEqual(['lien_ou_mail']);
    expect(body(`${EN.body} See www.example.test`)).toEqual(['lien_ou_mail']);
    expect(controlTranslation(FR, { title: ' ', body: EN.body }, 'en').title).toEqual(['texte_vide']);
  });

  it('[R257] [R46] une voie nommée, un critère discriminant ou un mot interdit sont refusés dans chaque langue, comme en français', () => {
    const body = (b: string, l: ListingLanguage = 'en') => controlTranslation(FR, { title: FR.title, body: b }, l).body;
    expect(body(`${EN.body} Adresse : rue des Essais.`)).toContain('adresse');
    expect(body(`${EN.body} Near Elm Street.`)).toEqual(['adresse']);
    expect(body(`${EN.body} Ideal for a young couple.`)).toEqual(['critere_discriminant']);
    expect(body(`${EN.body} No children.`)).toEqual(['critere_discriminant']);
    expect(body(`${EN.body} Free parking.`)).toEqual(['mot_interdit']);
    expect(body(`${FR.body} قرب شارع النخيل.`, 'ar')).toEqual(['adresse']);
    expect(body(`${FR.body} مناسب لعائلة مسلم.`, 'ar')).toEqual(['critere_discriminant']);
    expect(body(`${FR.body} نزدیک خیابان.`, 'fa')).toEqual(['adresse']);
    expect(body(`${FR.body} गली के पास।`, 'hi')).toEqual(['adresse']);
    expect(body(`${FR.body} ਸੜਕ ਦੇ ਨੇੜੇ।`, 'pa')).toEqual(['adresse']);
    expect(body(`${FR.body} قریب سڑک۔`, 'ur')).toEqual(['adresse']);
    expect(body(`${FR.body} κοντά στην οδό.`, 'el')).toEqual(['adresse']);
    // Hors anglais, un mot latin qui n'est pas dans le français (une voie, un nom) est refusé ; « Dijon » repris passe.
    expect(body(`${FR.body} Près de Essais.`, 'ar')).toEqual(['mot_latin_sans_source']);
    expect(body(`${FR.body} ديجون Dijon.`, 'ar')).toEqual([]);
  });

  it('[R257] les repères : l’IA ne voit ni chiffre ni classe, et chaque repère revient une fois', () => {
    const values: string[] = [];
    const masked = maskFigures(FR.body, values);
    expect(masked).not.toMatch(/\d(?![^⟦]*⟧)/);
    expect(masked.replace(/⟦\d+⟧/g, '')).not.toMatch(/\d|(?<![\p{L}])[A-G](?![\p{L}])/u);
    expect(values).toEqual(['62', '3', '2', '3', '5', '210 000', 'D']);
    const all = values.map((_, i) => i + 1);
    expect(unmaskFigures(masked, values, all)).toBe(FR.body);
    expect(unmaskFigures(masked.replace('⟦7⟧', ''), values, all)).toBeNull();
    expect(unmaskFigures(`${masked} ⟦1⟧`, values, all)).toBeNull();
    expect(unmaskFigures(`${masked} 4`, values, all)).toBeNull();
    expect(unmaskFigures(`${masked} ⟦9⟧`.replace('⟦7⟧', ''), values, all)).toBeNull();
    // Repères intervertis : « 3 m², 62 pièces » ne passe jamais.
    expect(unmaskFigures(masked.replace('⟦1⟧', '⟦X⟧').replace('⟦2⟧', '⟦1⟧').replace('⟦X⟧', '⟦2⟧'), values, all)).toBeNull();
  });
});

describe('HX05 · langue de l’acheteur', () => {
  it('[R259] la fiche d’abord, sinon l’écriture du message : grec, gurmukhi, devanagari, ourdou, persan, arabe, anglais, français', () => {
    expect(buyerLanguage('ur', 'Hello')).toBe('ur');
    expect(buyerLanguage('fr', 'Hello, is it still available?')).toBe('fr');
    expect(buyerLanguage(null, 'Καλησπέρα, είναι διαθέσιμο;')).toBe('el');
    expect(buyerLanguage(null, 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ')).toBe('pa');
    expect(buyerLanguage(null, 'नमस्ते, क्या यह उपलब्ध है?')).toBe('hi');
    expect(buyerLanguage(null, 'السلام علیکم، کیا یہ دستیاب ہے؟')).toBe('ur');
    expect(buyerLanguage(null, 'سلام، آیا این خانه هنوز موجود است؟ لطفاً بگویید')).toBe('fa');
    expect(buyerLanguage(null, 'مرحبا، هل الشقة متاحة؟')).toBe('ar');
    expect(buyerLanguage(null, 'Hello, is it still available?')).toBe('en');
    expect(buyerLanguage(null, 'Bonjour, est-ce toujours disponible ?')).toBe('fr');
  });
});

/** La marque de chaque langue dans les textes de l'IA de test, dans son écriture : hors anglais, aucun mot latin inventé. */
const MARK: Record<ListingLanguage, string> = { en: 'en', ur: 'اردو', hi: 'हिंदी', pa: 'ਪੰਜਾਬੀ', fa: 'فارسی', ar: 'عربي', el: 'ελ' };

/** Une IA de test : elle rend les repères tels quels, et garde ce qu'elle a reçu. */
class FakeTranslator implements ListingTranslator {
  received: { language: ListingLanguage; title: string; body: string }[] = [];
  edit: (s: string) => string = (s) => s;
  async translate(input: { language: ListingLanguage; title: string; body: string }) {
    this.received.push(input);
    return { title: this.edit(`[${MARK[input.language]}] ${input.title}`), body: this.edit(`[${MARK[input.language]}] ${input.body}`) };
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
  const french = t.channels.find((c) => c.channel === 'portails')!.received.at(-1)!;
  // L'agent du bien déclare parler anglais : rien n'est plus ouvert d'office (AU113).
  if (!(await tr.declareLanguages(t.agent, t.alexId, ['en'])).ok) throw new Error('langues');
  return { ...t, ia, tr, exporter, french };
}

describeWithSqlite('HX05 · langues de l’agent', () => {
  it('[R258] AU113 · une langue, l’anglais compris, seulement si l’agent du bien la déclare ; seul lui ou la direction la déclare', async () => {
    const s = await setup();
    expect(await s.tr.languagesFor(s.network.id, s.alexId)).toEqual(['en']);
    expect(await s.tr.propose(s.agent, s.propertyId, 'ur')).toMatchObject({ ok: false, rule: 'R258', code: 'langue_non_parlee' });
    expect(await s.tr.propose(s.agent, s.propertyId, 'de')).toMatchObject({ ok: false, rule: 'R258', code: 'langue_non_parlee' });
    expect(await s.tr.declareLanguages(s.sam, s.alexId, ['ur'])).toMatchObject({ ok: false, rule: 'R16' });
    expect(await s.tr.declareLanguages(s.agent, s.alexId, ['ur', 'xx'])).toMatchObject({ ok: false, code: 'bad_languages' });
    expect(await s.tr.declareLanguages(s.agent, s.alexId, ['ar', 'ur', 'el'])).toEqual({ ok: true, value: ['ur', 'ar', 'el'] });
    expect(await s.tr.declareLanguages(s.direction, s.alexId, ['ur', 'ar'])).toEqual({ ok: true, value: ['ur', 'ar'] });
    // Une nouvelle déclaration sans l'anglais le ferme : il n'est plus ouvert d'office.
    expect(await s.tr.languagesFor(s.network.id, s.alexId)).toEqual(['ur', 'ar']);
    expect(await s.tr.propose(s.agent, s.propertyId, 'en')).toMatchObject({ ok: false, code: 'langue_non_parlee' });
    expect(await s.tr.propose(s.agent, s.propertyId, 'el')).toMatchObject({ ok: false, code: 'langue_non_parlee' });
    expect((await s.tr.propose(s.agent, s.propertyId, 'ur')).ok).toBe(true);
    // Toutes les déclarations sont gardées.
    expect((await s.db.all('SELECT seq FROM agent_language_declarations WHERE agent_id = ?', [s.alexId])).length).toBe(3);
  });
});

describeWithSqlite('HX05 · traduction par l’IA, puis validation par l’agent', () => {
  it('[R257] l’IA ne reçoit aucun chiffre ni classe ; le code remet les chiffres ; une IA qui écrit un chiffre ou perd un repère est refusée et rien n’est gardé', async () => {
    const s = await setup();
    const ok = await s.tr.propose(s.agent, s.propertyId, 'en');
    if (!ok.ok) throw new Error(ok.code);
    const sent = s.ia.received[0]!;
    expect(`${sent.title} ${sent.body}`.replace(/⟦\d+⟧/g, '')).not.toMatch(/\p{Nd}|(?<![\p{L}\p{N}])[A-G](?![\p{L}\p{N}])/u);
    expect(controlTranslation(s.french as { title: string; body: string }, ok.value, 'en').ok).toBe(true);
    expect(ok.value.body).toContain('62 m²');
    s.ia.edit = (x) => x.replace(/⟦1⟧/g, '7');
    expect(await s.tr.propose(s.agent, s.propertyId, 'en')).toMatchObject({ ok: false, rule: 'R257', code: 'ia_refusee' });
    s.ia.edit = (x) => x.replace(/⟦\d+⟧/, '');
    expect(await s.tr.propose(s.agent, s.propertyId, 'en')).toMatchObject({ ok: false, rule: 'R257', code: 'ia_refusee' });
    s.ia.edit = (x) => x.replace(/⟦(\d+)⟧(.*)⟦(\d+)⟧/, '⟦$3⟧$2⟦$1⟧');
    expect(await s.tr.propose(s.agent, s.propertyId, 'en')).toMatchObject({ ok: false, rule: 'R257', code: 'ia_refusee' });
    s.ia.edit = (x) => `${x} three`;
    expect(await s.tr.propose(s.agent, s.propertyId, 'en')).toMatchObject({ ok: false, rule: 'R257', code: 'ia_refusee' });
    expect((await s.db.all('SELECT id FROM listing_translations')).length).toBe(1);
    // Au journal : la langue et les codes, jamais le texte [R13].
    const events = await s.journal.bySubject(`property:${s.propertyId}`);
    const refused = events.filter((e) => e.type === 'annonce.traduction_ia_refusee');
    expect(refused.map((e) => e.data)).toEqual([
      { rule: 'R257', language: 'en', codes: ['reperes'] },
      { rule: 'R257', language: 'en', codes: ['reperes'] },
      { rule: 'R257', language: 'en', codes: ['reperes'] },
      { rule: 'R257', language: 'en', codes: ['nombre_en_lettres'] },
    ]);
    expect(JSON.stringify(events)).not.toContain('[en]');
  });

  it('[R257] une IA en panne, trop lente ou hors format : rien n’est gardé, la raison va au journal sans le texte ni l’erreur', async () => {
    const t = await setup();
    const cases: [ListingTranslator, string][] = [
      [{ translate: async () => { throw new Error('clé secrète refusée'); } }, 'panne'],
      [{ translate: () => new Promise(() => {}) }, 'delai'],
      [{ translate: async () => ({ title: 1, body: null }) as unknown as { title: string; body: string } }, 'hors_format'],
    ];
    for (const [translator] of cases) {
      const tr = new AnnoncesTraduites(t.db, t.acces, t.journal, { now: t.now, translator, timeoutMs: 20 });
      expect(await tr.propose(t.agent, t.propertyId, 'en')).toMatchObject({ ok: false, code: 'ia_indisponible' });
    }
    const events = (await t.journal.bySubject(`property:${t.propertyId}`)).filter((e) => e.type === 'annonce.traduction_ia_indisponible');
    expect(events.map((e) => e.data)).toEqual(cases.map(([, reason]) => ({ rule: 'R257', language: 'en', reason })));
    expect(JSON.stringify(events)).not.toContain('secrète');
    expect((await t.db.all('SELECT id FROM listing_translations')).length).toBe(0);
  });

  it('[R258] rien ne part sans validation de l’agent du bien ; seule la dernière traduction se valide ; la direction et un autre agent ne valident pas', async () => {
    const s = await setup();
    const first = await s.tr.propose(s.agent, s.propertyId, 'en');
    if (!first.ok) throw new Error(first.code);
    expect(await s.exporter.listings(s.network.id)).toEqual([]);
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, 'en')).toBeNull();
    const own = await s.tr.correct(s.agent, s.propertyId, 'en', { title: first.value.title.replace('[en] ', ''), body: first.value.body.replace('[en] ', '') });
    if (!own.ok) throw new Error(own.code);
    expect(own.value.origin).toBe('agent');
    expect(await s.tr.validate(s.agent, first.value.id)).toMatchObject({ ok: false, rule: 'R258', code: 'not_latest' });
    expect(await s.tr.validate(s.direction, own.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await s.tr.validate(s.sam, own.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await s.tr.validate({ ...s.agent, networkId: 'autre' }, own.value.id)).toMatchObject({ ok: false, code: 'unknown_translation' });
    const v = await s.tr.validate(s.agent, own.value.id);
    expect(v.ok).toBe(true);
    expect(await s.tr.validate(s.agent, own.value.id)).toMatchObject({ ok: false, code: 'already_validated' });
    expect((await s.exporter.listings(s.network.id)).map((l) => l.language)).toEqual(['en']);
    // Une correction de l'agent passe le même contrôle.
    expect(await s.tr.correct(s.agent, s.propertyId, 'en', { title: own.value.title, body: own.value.body.replace('62 m²', '64 m²') })).toMatchObject({ ok: false, rule: 'R257', code: 'refused_text', body: ['chiffre_manquant', 'chiffre_ajoute'] });
  });

  it('[R258] une nouvelle annonce française rend ses traductions caduques ; un agent qui ne parle plus une langue n’y publie plus', async () => {
    const s = await setup();
    await s.tr.declareLanguages(s.agent, s.alexId, ['en', 'ar']);
    for (const l of ['en', 'ar'] as const) {
      const p = await s.tr.propose(s.agent, s.propertyId, l);
      if (!p.ok) throw new Error(p.code);
      expect((await s.tr.validate(s.agent, p.value.id)).ok).toBe(true);
    }
    expect((await s.exporter.listings(s.network.id)).map((l) => l.language)).toEqual(['en', 'ar']);
    await s.tr.declareLanguages(s.agent, s.alexId, []);
    // L'anglais n'est plus ouvert d'office : sans langue déclarée, plus rien ne part (AU113).
    expect((await s.exporter.listings(s.network.id)).map((l) => l.language)).toEqual([]);
    await s.tr.declareLanguages(s.agent, s.alexId, ['en', 'ar']);
    // L'agent écrit une nouvelle annonce française, pas encore validée : plus rien n'est publiable, ni traduit.
    const fresh = await s.annonces.propose(s.agent, s.propertyId);
    if (!fresh.ok) throw new Error(fresh.code);
    const before = (await s.tr.read(s.agent, s.propertyId, 'en')) as { ok: true; value: { id: string } };
    // Tant que le passage n'a pas retiré l'annonce, l'acheteur reçoit ce qui est publié, comme les portails.
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, 'en')).toMatchObject({ language: 'en' });
    await s.publication.sync(s.network.id, s.propertyId);
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, 'en')).toBeNull();
    expect(await s.exporter.listings(s.network.id)).toEqual([]);
    expect((await s.tr.validate(s.agent, before.value.id)).ok).toBe(false);
    expect(await s.tr.propose(s.agent, s.propertyId, 'en')).toMatchObject({ ok: false, code: 'no_listing' });
    expect((await s.annonces.validate(s.agent, fresh.value.id)).ok).toBe(true);
    await s.publication.sync(s.network.id, s.propertyId);
    expect(await s.exporter.listings(s.network.id)).toEqual([]);
    // Validée, la nouvelle annonce : l'ancienne traduction ne vaut plus pour elle.
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, 'ar')).toBeNull();
    const again = await s.tr.propose(s.agent, s.propertyId, 'en');
    if (!again.ok) throw new Error(again.code);
    expect(again.value.draftId).toBe(fresh.value.id);
  });
});

describeWithSqlite('AU113 · un relecteur désigné pour une langue que l’agent du bien ne parle pas', () => {
  it('[R258] la direction désigne un agent qui déclare la langue ; lui seul valide alors cette langue ; retiré, la langue se ferme', async () => {
    const s = await setup();
    await s.tr.declareLanguages(s.agent, s.alexId, ['en']);
    // Sans relecteur, l'arabe reste fermé.
    expect(await s.tr.propose(s.agent, s.propertyId, 'ar')).toMatchObject({ ok: false, code: 'langue_non_parlee' });
    // Seule la direction désigne ; le relecteur doit déclarer la langue.
    expect(await s.tr.designateReviewer(s.agent, s.propertyId, 'ar', s.sam.userId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await s.tr.designateReviewer(s.direction, s.propertyId, 'ar', s.sam.userId)).toMatchObject({ ok: false, code: 'langue_non_parlee' });
    await s.tr.declareLanguages(s.sam, s.sam.userId, ['ar']);
    expect(await s.tr.designateReviewer(s.direction, s.propertyId, 'ar', s.sam.userId)).toEqual({ ok: true });
    expect(await s.tr.languagesFor(s.network.id, s.alexId, s.propertyId)).toEqual(['en', 'ar']);
    const p = await s.tr.propose(s.agent, s.propertyId, 'ar');
    if (!p.ok) throw new Error(p.code);
    // L'agent du bien, qui ne parle pas arabe, ne valide pas ; le relecteur, oui.
    expect(await s.tr.validate(s.agent, p.value.id)).toMatchObject({ ok: false, code: 'langue_non_parlee' });
    expect(await s.tr.validate(s.sam, p.value.id)).toMatchObject({ ok: true, value: { validated: { by: `agent:${s.sam.userId}` } } });
    expect((await s.exporter.listings(s.network.id)).map((l) => l.language)).toContain('ar');
    // Le relecteur, qui n'est pas l'agent du bien, lit la traduction de sa langue, et seulement elle.
    expect(await s.tr.read(s.sam, s.propertyId, 'ar')).toMatchObject({ ok: true, value: { id: p.value.id } });
    expect(await s.tr.read(s.sam, s.propertyId, 'en')).toMatchObject({ ok: false });
    // Cette lecture s'écrit au journal, comme toute lecture d'un bien [R16].
    expect((await s.journal.all()).filter((e) => e.type === 'bien.lu' && e.actor === `agent:${s.sam.userId}` && (e.data as { view?: string }).view === 'relecteur')).toHaveLength(1);
    // Remplacé par un autre relecteur : la validation de l'ancien ne vaut plus, rien ne part avant la sienne.
    const nour = await s.store.createAgent({ networkId: s.network.id, firstName: 'Nour', lastName: 'Relectrice' });
    const asNour = { role: 'agent', userId: nour.id, networkId: s.network.id } as typeof s.sam;
    await s.tr.declareLanguages(asNour, nour.id, ['ar']);
    expect(await s.tr.designateReviewer(s.direction, s.propertyId, 'ar', nour.id)).toEqual({ ok: true });
    expect((await s.exporter.listings(s.network.id)).map((l) => l.language)).not.toContain('ar');
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, 'ar')).toBeNull();
    const again = await s.tr.propose(s.agent, s.propertyId, 'ar');
    if (!again.ok) throw new Error(again.code);
    expect((await s.tr.validate(asNour, again.value.id)).ok).toBe(true);
    expect((await s.exporter.listings(s.network.id)).map((l) => l.language)).toContain('ar');
    // Le jour de son départ, même avant le passage du planificateur, le relecteur ne lit ni ne valide plus [R86].
    const today = s.now().toISOString().slice(0, 10);
    await s.db.run("INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES ('dep-nour', ?, ?, ?, ?, 'demission_agent', 1, 'direction:d', ?)", [s.network.id, nour.id, today, today, s.now().toISOString()]);
    expect((await s.tr.read(asNour, s.propertyId, 'ar')).ok).toBe(false);
    expect((await s.tr.forBuyer(s.network.id, s.propertyId, 'ar'))?.language).not.toBe('ar');
    // Retiré, la langue se ferme et sa traduction ne part plus.
    expect(await s.tr.designateReviewer(s.direction, s.propertyId, 'ar', null)).toEqual({ ok: true });
    expect((await s.exporter.listings(s.network.id)).map((l) => l.language)).not.toContain('ar');
  });
});

describeWithSqlite('HX05 · portails étrangers et réponse à l’acheteur (Jamais vu)', () => {
  it('[R259] le flux porte chaque traduction validée avec le prix, les mentions et les médias de la version française, au caractère près ; un bien vendu sort', async () => {
    const s = await setup();
    await s.tr.declareLanguages(s.agent, s.alexId, ['en', 'ar']);
    for (const l of ['ar', 'en'] as const) {
      const p = await s.tr.propose(s.agent, s.propertyId, l);
      if (!p.ok) throw new Error(p.code);
      await s.tr.validate(s.agent, p.value.id);
    }
    const list = await s.exporter.listings(s.network.id);
    expect(list.map((l) => l.language)).toEqual(['en', 'ar']);
    for (const l of list) {
      expect(l.mentions).toBe(s.french.mentions);
      expect(l.priceEur).toBe(s.french.priceEur);
      expect(l.media).toEqual(s.french.media);
      expect(l.version).toBe(s.french.version);
      expect(l.title).toContain(`[${MARK[l.language]}]`);
    }
    const feed = await s.exporter.feed(s.network.id);
    expect(feed.body).toContain('langue="ar" sens="rtl"');
    expect(feed.body).toContain('langue="en" sens="ltr"');
    expect(feed.body).toContain(`<prix devise="EUR">${s.french.priceEur}</prix>`);
    expect(feed.body).not.toMatch(/Léa|Exemple/);
    expect((await s.exporter.feed(s.network.id, INTERNATIONAL_TRIAL_FORMAT, ['en'])).body).not.toContain('langue="ar"');
    expect(await s.exporter.listings('autre-reseau')).toEqual([]);
    await s.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [s.propertyId]);
    await s.publication.sync(s.network.id, s.propertyId);
    expect(await s.exporter.listings(s.network.id)).toEqual([]);
  });

  it('[R259] l’acheteur reçoit l’annonce dans sa langue, sinon en anglais, sinon rien ; jamais une traduction non validée', async () => {
    const s = await setup();
    await s.tr.declareLanguages(s.agent, s.alexId, ['en', 'ur']);
    const ur = await s.tr.propose(s.agent, s.propertyId, 'ur');
    if (!ur.ok) throw new Error(ur.code);
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, buyerLanguage(null, 'السلام علیکم، کیا یہ دستیاب ہے؟'))).toBeNull();
    const en = await s.tr.propose(s.agent, s.propertyId, 'en');
    if (!en.ok) throw new Error(en.code);
    await s.tr.validate(s.agent, en.value.id);
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, 'ur')).toMatchObject({ language: 'en', rightToLeft: false });
    await s.tr.validate(s.agent, ur.value.id);
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, 'ur')).toEqual({ language: 'ur', title: ur.value.title, body: ur.value.body, rightToLeft: true, priceEur: s.french.priceEur, mentions: s.french.mentions, version: s.french.version });
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, 'el')).toMatchObject({ language: 'en' });
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, 'fr')).toBeNull();
    expect(await s.tr.forBuyer('autre-reseau', s.propertyId, 'ur')).toBeNull();
    // Vendu, ou retiré : plus rien à envoyer, même traduit et validé.
    await s.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [s.propertyId]);
    await s.publication.sync(s.network.id, s.propertyId);
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, 'ur')).toBeNull();
    expect(await s.tr.forBuyer(s.network.id, s.propertyId, 'en')).toBeNull();
  });

  it('[R259] une annonce validée mais jamais publiée n’est envoyée à personne', async () => {
    const t = await setupAnnonce();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    expect((await t.annonces.validate(t.agent, t.draftId)).ok).toBe(true);
    const tr = new AnnoncesTraduites(t.db, t.acces, t.journal, { now: t.now, translator: new FakeTranslator() });
    await tr.declareLanguages(t.agent, t.alexId, ['en']);
    const p = await tr.propose(t.agent, t.propertyId, 'en');
    if (!p.ok) throw new Error(p.code);
    expect((await tr.validate(t.agent, p.value.id)).ok).toBe(true);
    // Délai de rétractation encore ouvert : aucune version publiée.
    expect(await tr.forBuyer(t.network.id, t.propertyId, 'en')).toBeNull();
    expect(await new ExportPortailsEtrangers(t.db, t.acces, t.journal).listings(t.network.id)).toEqual([]);
  });

  it('[R257] la base refuse de changer ou d’effacer une traduction, une validation ou une déclaration de langues', async () => {
    const s = await setup();
    await s.tr.declareLanguages(s.agent, s.alexId, ['en', 'ur']);
    const p = await s.tr.propose(s.agent, s.propertyId, 'en');
    if (!p.ok) throw new Error(p.code);
    await s.tr.validate(s.agent, p.value.id);
    await expect(s.db.run("UPDATE listing_translations SET body = 'x'")).rejects.toThrow(/ne change plus/);
    await expect(s.db.run('DELETE FROM listing_translations')).rejects.toThrow(/rien ne s'efface/);
    await expect(s.db.run("UPDATE listing_translation_validations SET validated_by = 'x'")).rejects.toThrow(/rien ne change/);
    await expect(s.db.run('DELETE FROM listing_translation_validations')).rejects.toThrow(/rien ne s'efface/);
    await expect(s.db.run("UPDATE agent_language_declarations SET languages = '[]'")).rejects.toThrow(/rien ne change/);
    await expect(s.db.run('DELETE FROM agent_language_declarations')).rejects.toThrow(/rien ne s'efface/);
    await expect(s.db.run("INSERT INTO listing_translations (id, property_id, network_id, draft_id, language, seq, title, body, origin, created_by, created_at) VALUES ('x', ?, ?, ?, 'de', 9, 't', 'b', 'ia', 'a', 'n')", [s.propertyId, s.network.id, s.draftId])).rejects.toThrow();
  });
});
