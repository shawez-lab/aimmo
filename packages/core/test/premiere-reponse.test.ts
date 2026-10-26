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
  checkText,
  fallbackTexts,
  fromSyncSqlite,
  numbersIn,
  type Channel,
  type InboundChannel,
  type InboundKind,
  type InboundMessage,
  type ReplyBrief,
  type ReplyWriter,
  type SenderIdentifier,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un dimanche à 23 h, heure de Paris : une réponse à un client qui vient d'écrire part quand même [R01].
const NOW = new Date('2026-12-06T22:00:00.000Z');
const PRICE = 245000;
const SURFACE = 82.5;

let seq = 0;
function msg(channel: InboundChannel, kind: InboundKind, identifiers: SenderIdentifier[], text: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  seq += 1;
  return {
    channel,
    kind,
    externalId: `ext-${seq}`,
    conversationRef: `conv-${seq}`,
    sender: { channelId: kind === 'direct' || kind === 'comment' ? `id-${seq}` : null, name: 'Camille', identifiers },
    subject: null,
    text,
    receivedAt: new Date(NOW.getTime() - 60_000),
    postRef: null,
    propertyRef: null,
    portal: null,
    hasAttachment: false,
    ...extra,
  };
}

class FakeWriter implements ReplyWriter {
  briefs: ReplyBrief[] = [];
  constructor(private readonly answer: (brief: ReplyBrief) => Promise<string>) {}
  write(brief: ReplyBrief): Promise<string> {
    this.briefs.push(brief);
    return this.answer(brief);
  }
}

async function setup(writer?: ReplyWriter) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => NOW;
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const decisions = new DecisionEnvoi(db, store, fiche, { now });
  const reception = new Reception(db, undefined, now);
  const rattachement = new Rattachement(db, store, fiche, decisions, reception, { now });
  const biens = new ReconnaissanceBien(db);
  const channels = (['email', 'sms', 'whatsapp', 'instagram', 'facebook', 'phone'] as Channel[]).map((c) => new FakeChannel(c));
  const controle = new ControleEnvois(db, fiche, decisions, { channels, journal: new SqlSendJournal(db, undefined, now), now });
  const premiere = new PremiereReponse(db, fiche, reception, biens, controle, writer ? { writer } : {});
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const home = await store.createProperty({
    networkId: network.id,
    agentId: agent.id,
    reference: '383',
    kind: 'home',
    city: 'Dijon',
    surfaceM2: SURFACE,
    priceEur: PRICE,
    status: 'available',
  });
  await db.run('INSERT INTO property_details (property_id, network_id, neighborhood, highlight, updated_at) VALUES (?, ?, ?, ?, ?)', [
    home.id,
    network.id,
    'Montchapet',
    'jardin de 300 m² sans vis-à-vis',
    NOW.toISOString(),
  ]);
  // Le vendeur : jamais nommé dans une réponse [R19].
  const seller = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Bérénice', lastName: 'Vendeuse' });
  const project = await store.createProject({ networkId: network.id, agentId: agent.id, personId: seller.id, kind: 'sell' });
  await store.linkProjectProperty({ networkId: network.id, agentId: agent.id, projectId: project.id, propertyId: home.id, role: 'owned' });
  await biens.link({ networkId: network.id, propertyId: home.id, kind: 'post', value: 'video-383', at: NOW });
  const run = async (m: InboundMessage) => {
    const [r] = (await reception.store(network.id, { messages: [m], unreadable: [], ignored: 0 })).received;
    const inboundId = (r as { inboundId: string }).inboundId;
    await rattachement.attach(inboundId);
    return premiere.reply(inboundId);
  };
  const sent = (channel: Channel): string[] => channels.find((c) => c.channel === channel)!.sent.map((s) => s.body);
  return { db, store, decisions, network, home, run, sent, channels, premiere };
}

const ig = (v: string): SenderIdentifier => ({ kind: 'instagram', value: v });
const mail = (v: string): SenderIdentifier => ({ kind: 'email', value: v });
const wa = (v: string): SenderIdentifier => ({ kind: 'whatsapp', value: v });

describeWithSqlite('C04 · première réponse', () => {
  it('[R10] chaque chiffre de la réponse vient de la fiche du bien', async () => {
    const t = await setup();
    const out = await t.run(msg('instagram', 'comment', [ig('camille.test')], 'Prix ? Toujours dispo ?', { postRef: 'video-383' }));
    expect(out).toMatchObject({ recognition: 'recognized', nextStep: 'visit', result: { status: 'sent', fallbackText: true } });
    const body = t.sent('instagram')[0]!;
    expect(body).toContain('245 000 €');
    expect(body).toContain('82,5 m²');
    expect(body).toContain('Montchapet');
    const allowed = new Set(['245000', '82.5', '300']);
    expect(numbersIn(body).every((n) => allowed.has(n))).toBe(true);
  });

  it('[R10] une IA qui invente un chiffre est refusée : le texte de secours part', async () => {
    const writer = new FakeWriter(async () => 'Hello ! Il est à 230 000 €, tu veux le visiter ?');
    const t = await setup(writer);
    const out = await t.run(msg('instagram', 'comment', [ig('camille.ia')], 'Combien ?', { postRef: 'video-383' }));
    expect(out.result).toMatchObject({ status: 'sent', aiText: false, fallbackText: true, rule: 'R12' });
    expect(t.sent('instagram')[0]).not.toContain('230');
  });

  it('[R19] jamais l\'adresse exacte ni le nom du vendeur, même si l\'IA les écrit', async () => {
    const writer = new FakeWriter(async () => 'Hello ! C’est la maison de Bérénice, 12 rue des Lilas. Tu veux la visiter ?');
    const t = await setup(writer);
    await t.run(msg('instagram', 'comment', [ig('camille.r19')], 'C’est où ?', { postRef: 'video-383' }));
    const body = t.sent('instagram')[0]!;
    expect(body).not.toMatch(/Bérénice|Vendeuse|rue des Lilas/i);
    // Le contrôle du texte refuse le nom du vendeur.
    expect(checkText('Bonjour, c’est le bien de Bérénice.', { audience: 'client', channel: 'email', sellerNames: ['Bérénice'] })).toContainEqual(
      expect.objectContaining({ rule: 'R19' }),
    );
  });

  it('[R20] bien non reconnu : message simple et honnête, sans aucune donnée de bien, et l\'IA ne rédige pas', async () => {
    const writer = new FakeWriter(async () => 'Hello ! La maison à Dijon dispose d’un jardin. Tu veux la visiter ?');
    const t = await setup(writer);
    const out = await t.run(msg('instagram', 'direct', [ig('camille.r20')], 'Et la réf 999 ?'));
    expect(out).toMatchObject({ recognition: 'unrecognized', nextStep: 'callback', result: { status: 'sent', aiText: false } });
    expect(writer.briefs).toHaveLength(0);
    const body = t.sent('instagram')[0]!;
    expect(numbersIn(body)).toEqual([]);
    expect(body).not.toMatch(/Dijon|Montchapet|m²|€/);
  });

  it('une seule question pour avancer, et aucune pour un simple merci', async () => {
    const writer = new FakeWriter(async () => 'Hello ! Il est disponible. Tu veux le visiter ? Ou que je t’appelle ?');
    const t = await setup(writer);
    await t.run(msg('instagram', 'comment', [ig('camille.q')], 'Dispo ?', { postRef: 'video-383' }));
    expect((t.sent('instagram')[0]!.match(/\?/g) ?? []).length).toBe(1);
    const thanks = await t.run(msg('instagram', 'direct', [ig('camille.merci')], 'Merci beaucoup !'));
    expect(thanks.nextStep).toBeNull();
    const closing = t.sent('instagram').at(-1)!;
    expect(closing).not.toContain('?');
  });

  it('[R12] IA muette ou trop lente : le texte de secours part, avec les vraies données', async () => {
    const writer = new FakeWriter(() => Promise.reject(new Error('panne inventée')));
    const t = await setup(writer);
    const out = await t.run(msg('whatsapp', 'direct', [wa('+33610000099')], 'Bonjour, le bien est-il disponible ?', { postRef: 'video-383' }));
    expect(out.result).toMatchObject({ status: 'sent', aiText: false, fallbackText: true, rule: 'R12' });
    expect(t.sent('whatsapp')[0]).toContain('245 000 €');
  });

  it('[R06] la mention légale est au premier message, et seulement là', async () => {
    const t = await setup();
    await t.run(msg('instagram', 'direct', [ig('camille.mention')], 'Bonjour', { conversationRef: 'fil-1' }));
    await t.run(msg('instagram', 'direct', [ig('camille.mention')], 'Vous êtes où ?', { conversationRef: 'fil-1' }));
    const [first, second] = t.sent('instagram');
    expect(first).toMatch(/^Réponse rapide de mon assistant IA/);
    expect(second ?? '').not.toMatch(/assistant/i);
  });

  it('[R08] ton par canal : tutoiement sur Instagram, vouvoiement avec le prénom ailleurs', async () => {
    const t = await setup();
    await t.run(msg('instagram', 'comment', [ig('camille.ton')], 'Dispo ?', { postRef: 'video-383' }));
    await t.run(msg('facebook', 'comment', [{ kind: 'facebook', value: '100000001' }], 'Dispo ?', { postRef: 'video-383' }));
    await t.run(msg('whatsapp', 'direct', [wa('+33610000077')], 'Toujours disponible ?', { postRef: 'video-383' }));
    await t.run(msg('email', 'email', [mail('camille.ton@example.org')], 'Bonjour, le bien 383 est-il disponible ? Réf 383'));
    const instagram = t.sent('instagram')[0]!;
    expect(instagram).toMatch(/\bTu\b/);
    expect(instagram).not.toMatch(/\bvous\b/i);
    for (const channel of ['facebook', 'whatsapp', 'email'] as const) {
      const body = t.sent(channel)[0]!;
      expect(body).toMatch(/Bonjour Camille/);
      expect(body).toMatch(/\bvous\b/i);
      expect(body).not.toMatch(/\btu\b/i);
    }
  });

  it('langue du client : une question en anglais reçoit une réponse en anglais', async () => {
    const t = await setup();
    await t.run(msg('email', 'email', [mail('sam.en@example.org')], 'Hello, is it still available? Ref 383', { sender: { channelId: null, name: 'Sam', identifiers: [mail('sam.en@example.org')] } }));
    expect(t.sent('email')[0]).toMatch(/Hello Sam, the property in Dijon/);
  });

  it('[R15] l\'IA ne reçoit ni mail, ni téléphone, ni adresse du message', async () => {
    const writer = new FakeWriter(async () => 'Bonjour Camille, il est disponible. Souhaitez-vous le visiter ?');
    const t = await setup(writer);
    await t.run(
      msg('email', 'email', [mail('camille.pii@example.org')], 'Bonjour, réf 383 dispo ? Camille, 06 12 34 56 78, camille.pii@example.org, 4 rue des Essais'),
    );
    const received = writer.briefs[0]!.received;
    expect(received).not.toMatch(/06 12|example\.org|rue des Essais/);
    expect(received).toContain('réf 383');
  });

  it('[R05] [R12] un second message sur un bien déjà envoyé reçoit une réponse, sans le bien', async () => {
    const t = await setup();
    await t.run(msg('instagram', 'comment', [ig('camille.deux')], 'Prix ?', { postRef: 'video-383' }));
    const second = await t.run(msg('instagram', 'comment', [ig('camille.deux')], 'Il y a un garage ?', { postRef: 'video-383' }));
    expect(second.result).toMatchObject({ status: 'sent' });
    const body = t.sent('instagram')[1]!;
    expect(numbersIn(body)).toEqual([]);
    expect(t.sent('instagram')).toHaveLength(2);
  });

  it('[R18] une seule réponse par message reçu, même relancé ou en double au même moment', async () => {
    const t = await setup();
    const m = msg('instagram', 'comment', [ig('camille.r18')], 'Prix ?', { postRef: 'video-383' });
    const first = await t.run(m);
    expect(first.result).toMatchObject({ status: 'sent' });
    const again = await t.premiere.reply(first.inboundId);
    expect(again).toMatchObject({ result: null, skipped: 'Ce message a déjà reçu sa réponse.' });
    const both = await Promise.all([t.premiere.reply(first.inboundId), t.premiere.reply(first.inboundId)]);
    expect(both.every((o) => o.result === null)).toBe(true);
    expect(t.sent('instagram')).toHaveLength(1);
  });

  it('[R18] un envoi en panne laisse répondre à nouveau au même message', async () => {
    const t = await setup();
    t.channels.find((c) => c.channel === 'instagram')!.failWith = new Error('panne inventée');
    const first = await t.run(msg('instagram', 'direct', [ig('camille.panne')], 'Bonjour'));
    expect(first.result).toMatchObject({ status: 'failed' });
    t.channels.find((c) => c.channel === 'instagram')!.failWith = null;
    const retry = await t.premiere.reply(first.inboundId);
    expect(retry.result).toMatchObject({ status: 'sent' });
    expect(t.sent('instagram')).toHaveLength(1);
  });

  it('[R02] une personne exclue ne reçoit rien, pas même la première réponse', async () => {
    const t = await setup();
    const out = await t.run(msg('instagram', 'direct', [ig('camille.stop')], 'Stop, ne plus me contacter'));
    expect(out.result).toMatchObject({ status: 'refused', rule: 'R04' });
    expect(t.sent('instagram')).toEqual([]);
  });

  it('les textes de secours passent eux-mêmes le contrôle du texte, sur chaque canal', () => {
    const property = { kind: 'home' as const, status: 'available' as const, priceEur: PRICE, surfaceM2: SURFACE, rooms: 4, city: 'Dijon', neighborhood: 'Montchapet', highlight: 'jardin de 300 m²' };
    for (const channel of ['instagram', 'facebook', 'whatsapp', 'email', 'sms'] as const) {
      for (const p of [property, null]) {
        for (const nextStep of ['visit', 'callback', 'valuation', null] as const) {
          for (const language of ['fr', 'en'] as const) {
          const brief: ReplyBrief = { channel, language, informal: channel === 'instagram', firstName: channel === 'instagram' ? null : 'Camille', received: 'x', property: p, nextStep };
          const [text] = fallbackTexts(brief);
          const problems = checkText(text!, {
            audience: 'client',
            channel,
            firstOfConversation: true,
            firstName: channel === 'instagram' ? null : 'Camille',
            figures: p ? [PRICE, SURFACE, 4, 'jardin de 300 m²'] : [],
            maxQuestions: nextStep === null ? 0 : 1,
          });
          expect({ channel, language, nextStep, property: !!p, problems }).toEqual({ channel, language, nextStep, property: !!p, problems: [] });
          }
        }
      }
    }
  });
});
