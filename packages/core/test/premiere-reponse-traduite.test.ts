// RC34 · La première réponse à un acheteur étranger porte l'annonce dans sa langue [R259]. Textes et personnes inventés.
import { expect, it } from 'vitest';
import {
  ControleEnvois,
  DecisionEnvoi,
  FakeChannel,
  FicheClient,
  FicheUnique,
  PremiereReponse,
  Rattachement,
  Reception,
  ReconnaissanceBien,
  SqlSendJournal,
  applyMigrations,
  createCaptation,
  fromSyncSqlite,
  withTranslation,
  type BuyerListingTranslation,
  type BuyerTranslations,
  type Channel,
  type InboundChannel,
  type InboundKind,
  type InboundMessage,
  type ReplyBrief,
  type ReplyWriter,
  type SqlDatabase,
} from '../src/index.ts';
import { AnnoncesTraduites, buyerLanguage, type ListingLanguage, type ListingTranslator } from '../src/annonces/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const NOW = new Date('2026-12-06T22:00:00.000Z');
const PRICE = 245000;

const AR: BuyerListingTranslation = {
  language: 'ar',
  title: 'شقة، 4 غرف، 82,5 m²، ديجون',
  body: 'شقة مشرقة 82,5 m² في ديجون، 4 غرف. السعر 245 000 €.',
  priceEur: PRICE,
  mentions: 'Honoraires à la charge du vendeur.',
  version: 3,
};

/** Une source de traductions de test : elle garde ce qu'on lui demande, et rend celle de la langue de l'acheteur. */
class FakeTranslations implements BuyerTranslations {
  asked: { personLanguage: string | null; text: string }[] = [];
  byLanguage = new Map<string, BuyerListingTranslation>([['ar', AR]]);
  async forBuyerMessage(_n: string, _p: string, personLanguage: string | null, text: string) {
    this.asked.push({ personLanguage, text });
    const l = buyerLanguage(personLanguage, text);
    return l === 'fr' ? null : (this.byLanguage.get(l) ?? this.byLanguage.get('en') ?? null);
  }
}

let seq = 0;
function msg(channel: InboundChannel, kind: InboundKind, email: string, text: string): InboundMessage {
  seq += 1;
  return {
    channel,
    kind,
    externalId: `ext-${seq}`,
    conversationRef: `conv-${seq}`,
    sender: { channelId: kind === 'direct' ? `id-${seq}` : null, name: 'Samir', identifiers: [{ kind: 'email', value: email }] },
    subject: null,
    text,
    receivedAt: new Date(NOW.getTime() - 60_000),
    postRef: null,
    propertyRef: '383',
    portal: null,
    hasAttachment: false,
  };
}

async function setup(options: { writer?: ReplyWriter; translations?: BuyerTranslations | null; status?: 'available' | 'sold' } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => NOW;
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const decisions = new DecisionEnvoi(db, store, fiche, { now });
  const reception = new Reception(db, undefined, now);
  const rattachement = new Rattachement(db, store, fiche, decisions, reception, { now });
  const channels = (['email', 'sms', 'whatsapp', 'instagram', 'facebook', 'phone'] as Channel[]).map((c) => new FakeChannel(c));
  const controle = new ControleEnvois(db, fiche, decisions, { channels, journal: new SqlSendJournal(db, undefined, now), now });
  const translations = options.translations === null ? undefined : (options.translations ?? new FakeTranslations());
  const premiere = new PremiereReponse(db, fiche, reception, new ReconnaissanceBien(db), controle, {
    ...(options.writer ? { writer: options.writer } : {}),
    ...(translations ? { translations } : {}),
  });
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const home = await store.createProperty({ networkId: network.id, agentId: agent.id, reference: '383', kind: 'home', city: 'Dijon', surfaceM2: 82.5, rooms: 4, priceEur: PRICE, status: options.status ?? 'available' });
  const seller = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Bérénice', lastName: 'Vendeuse' });
  const project = await store.createProject({ networkId: network.id, agentId: agent.id, personId: seller.id, kind: 'sell' });
  await store.linkProjectProperty({ networkId: network.id, agentId: agent.id, projectId: project.id, propertyId: home.id, role: 'owned' });
  const run = async (m: InboundMessage) => {
    const [r] = (await reception.store(network.id, { messages: [m], unreadable: [], ignored: 0 })).received;
    const inboundId = (r as { inboundId: string }).inboundId;
    await rattachement.attach(inboundId);
    return premiere.reply(inboundId);
  };
  const sent = (channel: Channel): string[] => channels.find((c) => c.channel === channel)!.sent.map((s) => s.body);
  return { db, store, network, home, run, sent, translations: translations as FakeTranslations | undefined };
}

describeWithSqlite('RC34 · la première réponse porte l’annonce dans la langue de l’acheteur', () => {
  it('[R259] un message en arabe : la réponse en anglais, puis le titre, le texte et les mentions de l’annonce arabe validée', async () => {
    const t = await setup();
    const r = await t.run(msg('email', 'direct', 'samir@example.test', 'مرحبا، هل الشقة متاحة؟'));
    expect(r.result?.status).toBe('sent');
    expect(r.translation).toEqual({ language: 'ar', version: 3, part: 'complete' });
    const [body] = t.sent('email');
    expect(body).toContain('Hello Samir, the property in Dijon is available : 245 000 €, 82,5 m². Would you like to arrange a visit?');
    expect(body).toContain(`\n\n${AR.title}\n\n${AR.body}\n\n${AR.mentions}`);
    expect(body).not.toContain('Bérénice');
    // Le texte validé ne passe jamais par la rédaction de la réponse.
    expect(t.translations!.asked).toEqual([{ personLanguage: null, text: 'مرحبا، هل الشقة متاحة؟' }]);
  });

  it('[R259] avec une annonce traduite, l’IA ne rédige pas : le texte du code, puis le texte validé tel quel', async () => {
    const briefs: ReplyBrief[] = [];
    const writer: ReplyWriter = { write: async (b) => (briefs.push(b), 'Hello Samir, lovely flat. Would you like to arrange a visit?') };
    const t = await setup({ writer });
    const r = await t.run(msg('email', 'direct', 'samir@example.test', 'مرحبا، هل الشقة متاحة؟'));
    expect(briefs).toEqual([]);
    expect(r.result).toMatchObject({ status: 'sent', aiText: false });
    expect(t.sent('email')[0]).toContain(AR.body);
  });

  it('[R259] la langue de la fiche d’abord ; une fiche en français par défaut ne dit rien, l’écriture du message décide', async () => {
    const t = await setup();
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Samir', language: 'ar' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'email', value: 'samir@example.test' });
    const r = await t.run(msg('email', 'direct', 'samir@example.test', 'Hello, is it still available?'));
    expect(t.translations!.asked.at(-1)).toEqual({ personLanguage: 'ar', text: 'Hello, is it still available?' });
    expect(r.translation).toMatchObject({ language: 'ar' });
    const fr = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Nadia' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: fr.id, kind: 'email', value: 'nadia@example.test' });
    await t.run(msg('email', 'direct', 'nadia@example.test', 'مرحبا، هل الشقة متاحة؟'));
    expect(t.translations!.asked.at(-1)!.personLanguage).toBeNull();
  });

  it('[R259] un acheteur qui écrit en français, ou sans traduction : la réponse d’aujourd’hui, sans annonce traduite', async () => {
    const t = await setup();
    const fr = await t.run(msg('email', 'direct', 'lea@example.test', 'Bonjour, est-ce toujours disponible ?'));
    expect(fr.translation).toBeNull();
    expect(t.sent('email')[0]).toContain('Bonjour Samir, le bien à Dijon est disponible : 245 000 €, 82,5 m². Souhaitez-vous organiser une visite ?');
    t.translations!.byLanguage.clear();
    const none = await t.run(msg('email', 'direct', 'samir@example.test', 'مرحبا، هل الشقة متاحة؟'));
    expect(none.translation).toBeNull();
    // Sans traduction, la règle de la langue de la réponse ne change pas.
    expect(t.sent('email')[1]).toMatch(/\n\nBonjour Samir, le bien à Dijon est disponible/);
    const without = await setup({ translations: null });
    const r = await without.run(msg('email', 'direct', 'samir@example.test', 'مرحبا، هل الشقة متاحة؟'));
    expect(r.translation).toBeNull();
    expect(without.sent('email')[0]).not.toContain(AR.title);
  });

  it('[R259] un prix de l’annonce différent de celui que la réponse dit : aucune traduction, jamais deux prix', async () => {
    const t = await setup();
    t.translations!.byLanguage.set('ar', { ...AR, priceEur: 240000 });
    const r = await t.run(msg('email', 'direct', 'samir@example.test', 'مرحبا، هل الشقة متاحة؟'));
    expect(r.translation).toBeNull();
    expect(t.sent('email')[0]).not.toContain(AR.title);
    expect(t.sent('email')[0]).toContain('245 000 €');
  });

  it('[R259] un texte complet trop long pour le canal : le titre traduit seul suit la réponse', async () => {
    const t = await setup();
    t.translations!.byLanguage.set('ar', { ...AR, body: `${AR.body} ${'شقة مشرقة وهادئة. '.repeat(250)}` });
    const r = await t.run(msg('email', 'direct', 'samir@example.test', 'مرحبا، هل الشقة متاحة؟'));
    expect(r.result?.status).toBe('sent');
    expect(r.translation).toEqual({ language: 'ar', version: 3, part: 'title' });
    const [body] = t.sent('email');
    expect(body!.endsWith(`\n\n${AR.title}`)).toBe(true);
    expect(body).not.toContain('شقة مشرقة وهادئة');
  });

  it('[R259] [R08] une annonce que le contrôle refuse (parenthèse) : le titre seul, sinon la réponse d’aujourd’hui', async () => {
    const t = await setup();
    t.translations!.byLanguage.set('ar', { ...AR, body: `${AR.body} (هادئة)`, title: `${AR.title} (ديجون)` });
    const r = await t.run(msg('email', 'direct', 'samir@example.test', 'مرحبا، هل الشقة متاحة؟'));
    expect(r.result?.status).toBe('sent');
    expect(r.translation).toBeNull();
    expect(t.sent('email')[0]!.endsWith('\n\nHello Samir, the property in Dijon is available : 245 000 €, 82,5 m². Would you like to arrange a visit?')).toBe(true);
  });

  it('[R259] un bien vendu, ou un simple merci : aucune traduction demandée', async () => {
    const sold = await setup({ status: 'sold' });
    const r = await sold.run(msg('email', 'direct', 'samir@example.test', 'مرحبا، هل الشقة متاحة؟'));
    expect(r.translation).toBeNull();
    expect(sold.translations!.asked).toEqual([]);
    const t = await setup();
    await t.run(msg('email', 'direct', 'samir@example.test', 'Thanks!'));
    expect(t.translations!.asked).toEqual([]);
  });

  it('[R259] [R05] un bien déjà envoyé à l’acheteur : la seconde réponse ne cite plus le bien, ni son annonce traduite', async () => {
    const t = await setup();
    const first = await t.run(msg('email', 'direct', 'samir@example.test', 'مرحبا، هل الشقة متاحة؟'));
    expect(first.translation).toMatchObject({ language: 'ar', part: 'complete' });
    const second = await t.run(msg('email', 'direct', 'samir@example.test', 'مرحبا، هل يمكنني الزيارة؟'));
    expect(second.result?.status).toBe('sent');
    expect(second.translation).toBeNull();
    expect(t.translations!.asked).toHaveLength(1);
    expect(t.sent('email')[1]).not.toContain(AR.title);
  });

  it('[R259] withTranslation : complet, puis titre seul, puis la réponse d’aujourd’hui, sans doublon', () => {
    expect(withTranslation(['A', 'A'], { title: ' T ', body: 'B', mentions: 'M (n) et (p).' })).toEqual(['A\n\nT\n\nB\n\nM, n et, p.', 'A\n\nT', 'A']);
  });
});

/** Une IA de test qui rend les repères tels quels, précédés d'une marque. */
class EchoTranslator implements ListingTranslator {
  async translate(input: { language: ListingLanguage; title: string; body: string }) {
    // « 1 place de stationnement » reste tel quel : ce n'est pas une adresse [R09] (BR68).
    return { title: `EN ${input.title}`, body: `EN ${input.body}` };
  }
}

describeWithSqlite('RC34 · la chaîne de captation joint l’annonce traduite validée', () => {
  it('[R259] un message en anglais sur la référence publiée : la réponse porte l’annonce anglaise validée, à sa version', async () => {
    const t = await setupAnnonce();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    const v = await t.annonces.validate(t.agent, t.draftId);
    if (!v.ok) throw new Error(v.code);
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    const tr = new AnnoncesTraduites(t.db, t.acces, t.journal, { now: t.now, translator: new EchoTranslator() });
    // L'agent déclare parler anglais : l'anglais n'est plus ouvert d'office (AU113).
    await tr.declareLanguages(t.agent, t.agent.userId, ['en']);
    const proposed = await tr.propose(t.agent, t.propertyId, 'en');
    if (!proposed.ok) throw new Error(proposed.code);
    const valid = await tr.validate(t.agent, proposed.value.id);
    if (!valid.ok) throw new Error(valid.code);
    const french = t.channels.find((c) => c.channel === 'portails')!.received.at(-1)!;
    expect(await tr.forBuyerMessage(t.network.id, t.propertyId, null, 'Bonjour, est-ce disponible ?')).toBeNull();
    expect(await tr.forBuyerMessage(t.network.id, t.propertyId, null, 'Hello, is it still available?')).toMatchObject({ language: 'en', version: french.version });

    const email = new FakeChannel('email');
    const { chaine } = createCaptation(t.db, t.journal, { now: t.now, channels: [email], withQualification: false, withOrigin: false });
    await chaine.receive(t.network.id, 'site_form', { submissionId: 'f-1', email: 'john@example.test', message: 'Hello, ref REF-T-1, is it still available?' });
    const [body] = email.sent.map((s) => s.body);
    expect(body).toMatch(/\n\nHello, the property in Dijon is available : 210 000 €, 62 m²\. Would you like to arrange a visit\?\n\n/);
    // Les mentions de la version publiée, mot pour mot, leurs parenthèses seules mises en virgules [R08].
    expect(french.mentions).toContain('(abonnements compris)');
    expect(body).toContain(`\n\n${valid.value.title}\n\n${valid.value.body}\n\n${french.mentions!.replace(/\s*\(([^()]*)\)/g, ', $1')}`);
    expect(body).not.toMatch(/[()]/);
  });
});
