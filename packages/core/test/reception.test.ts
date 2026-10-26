import { describe, expect, it } from 'vitest';
import {
  FicheClient,
  Reception,
  adaptInbound,
  applyMigrations,
  fromSyncSqlite,
  senderIdentifiers,
  type AdaptContext,
  type InboundMessage,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Jeux inventés : aucune vraie personne, aucun vrai numéro, aucune vraie adresse.
const NOW = new Date('2026-12-01T10:00:00.000Z');
const ctx: AdaptContext = { now: NOW, ownIds: ['PAGE-1', 'IG-OWN-1'] };

const instagramDm = {
  object: 'instagram',
  entry: [
    {
      id: 'IG-OWN-1',
      time: 1796124000000,
      messaging: [
        {
          sender: { id: 'IGSID-501' },
          recipient: { id: 'IG-OWN-1' },
          timestamp: 1796124000000,
          message: { mid: 'ig-mid-1', text: 'Bonjour, le T3 est encore dispo ?', attachments: [{ type: 'image' }] },
        },
      ],
    },
  ],
};

const instagramComment = {
  object: 'instagram',
  entry: [
    {
      id: 'IG-OWN-1',
      time: 1796124060,
      changes: [
        {
          field: 'comments',
          value: { id: 'ig-comment-9', text: 'Prix ?', from: { id: 'IGSID-777', username: 'Lea.Testeuse' }, media: { id: 'reel-42' } },
        },
      ],
    },
  ],
};

const messenger = {
  object: 'page',
  entry: [
    {
      id: 'PAGE-1',
      time: 1796124120000,
      messaging: [
        {
          sender: { id: 'PSID-12' },
          recipient: { id: 'PAGE-1' },
          timestamp: 1796124120000,
          message: { mid: 'm-mid-3', text: 'Je voudrais visiter' },
        },
      ],
    },
  ],
};

const facebookComment = {
  object: 'page',
  entry: [
    {
      id: 'PAGE-1',
      time: 1796124180,
      changes: [
        {
          field: 'feed',
          value: {
            item: 'comment',
            verb: 'add',
            comment_id: 'post-8_comment-5',
            post_id: 'post-8',
            message: 'Toujours en vente ?',
            from: { id: 'FBID-31', name: 'Paul Essai' },
            created_time: 1796124180,
          },
        },
      ],
    },
  ],
};

const whatsapp = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA-1',
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'PN-1' },
            contacts: [{ wa_id: '33600000101', profile: { name: 'Nina Fictive' } }],
            messages: [
              { from: '33600000101', id: 'wamid.A1', timestamp: '1796124240', type: 'text', text: { body: 'Bonsoir, une visite samedi ?' } },
              { from: '33600000101', id: 'wamid.A2', timestamp: '1796124250', type: 'image', image: { caption: 'Ma maison' } },
            ],
          },
        },
      ],
    },
  ],
};

const email = {
  messageId: '<mail-1@exemple.test>',
  from: 'Hugo Inventé <Hugo.Invente@exemple.test>',
  to: 'contact@agence.test',
  subject: 'Appartement rue imaginaire',
  text: 'Bonjour, je souhaite des informations.',
  date: '2026-12-01T09:30:00.000Z',
  inReplyTo: '<fil-0@exemple.test>',
  attachments: 1,
};

const portalEmail = {
  messageId: '<portail-7@seloger.com>',
  from: 'SeLoger <noreply@contact.seloger.com>',
  replyTo: 'Zoe Imaginaire <zoe.imaginaire@exemple.test>',
  subject: 'Nouvelle demande pour votre annonce 12345',
  text: 'Une personne souhaite visiter.',
  date: '2026-12-01T09:40:00.000Z',
};

const siteForm = {
  submissionId: 'form-55',
  firstName: 'Camille',
  email: ' Camille.Essai@Exemple.test ',
  phone: '06 00 00 01 02',
  message: 'Rappelez-moi après 18 h',
  propertyRef: 'bien-dijon-12',
  submittedAt: '2026-12-01T09:50:00.000Z',
};

const siteChat = { sessionId: 'sess-9', messageId: 'q1', text: 'Quels sont les frais ?', sentAt: '2026-12-01T09:55:00.000Z', page: '/biens/bien-dijon-12' };

function one(result: ReturnType<typeof adaptInbound>): InboundMessage {
  expect(result.unreadable).toEqual([]);
  expect(result.messages).toHaveLength(1);
  return result.messages[0]!;
}

describe('C01 · un exemple par canal et par type se normalise sans perte', () => {
  it('message Instagram', () => {
    expect(one(adaptInbound('instagram', instagramDm, ctx))).toEqual({
      channel: 'instagram',
      kind: 'direct',
      externalId: 'ig-mid-1',
      conversationRef: 'IGSID-501',
      sender: { channelId: 'IGSID-501', name: null, identifiers: [] },
      subject: null,
      text: 'Bonjour, le T3 est encore dispo ?',
      receivedAt: new Date(1796124000000),
      postRef: null,
      propertyRef: null,
      portal: null,
      hasAttachment: true,
    });
  });

  it('commentaire Instagram, avec la vidéo commentée et le compte normalisé', () => {
    const m = one(adaptInbound('instagram', instagramComment, ctx));
    expect(m).toMatchObject({
      channel: 'instagram',
      kind: 'comment',
      externalId: 'ig-comment-9',
      postRef: 'reel-42',
      text: 'Prix ?',
      sender: { channelId: 'IGSID-777', name: 'Lea.Testeuse', identifiers: [{ kind: 'instagram', value: 'lea.testeuse' }] },
      receivedAt: new Date(1796124060 * 1000),
    });
  });

  it('message Messenger', () => {
    expect(one(adaptInbound('facebook', messenger, ctx))).toMatchObject({
      channel: 'facebook',
      kind: 'direct',
      externalId: 'm-mid-3',
      conversationRef: 'PSID-12',
      sender: { channelId: 'PSID-12' },
      text: 'Je voudrais visiter',
      hasAttachment: false,
    });
  });

  it('commentaire Facebook', () => {
    expect(one(adaptInbound('facebook', facebookComment, ctx))).toMatchObject({
      channel: 'facebook',
      kind: 'comment',
      externalId: 'post-8_comment-5',
      postRef: 'post-8',
      sender: { channelId: 'FBID-31', name: 'Paul Essai' },
      text: 'Toujours en vente ?',
      receivedAt: new Date(1796124180 * 1000),
    });
  });

  it('WhatsApp, texte et photo avec légende, numéro au format international', () => {
    const result = adaptInbound('whatsapp', whatsapp, ctx);
    expect(result.unreadable).toEqual([]);
    expect(result.messages).toHaveLength(2);
    const [first, second] = result.messages;
    expect(first).toMatchObject({
      channel: 'whatsapp',
      kind: 'direct',
      externalId: 'wamid.A1',
      conversationRef: '33600000101',
      sender: { name: 'Nina Fictive', identifiers: [{ kind: 'whatsapp', value: '+33600000101' }] },
      text: 'Bonsoir, une visite samedi ?',
      hasAttachment: false,
      receivedAt: new Date(1796124240 * 1000),
    });
    expect(second).toMatchObject({ externalId: 'wamid.A2', text: 'Ma maison', hasAttachment: true });
  });

  it('mail, avec son fil, son objet et sa pièce jointe signalée', () => {
    expect(one(adaptInbound('email', email, ctx))).toEqual({
      channel: 'email',
      kind: 'email',
      externalId: '<mail-1@exemple.test>',
      conversationRef: '<fil-0@exemple.test>',
      sender: { channelId: null, name: 'Hugo Inventé', identifiers: [{ kind: 'email', value: 'hugo.invente@exemple.test' }] },
      subject: 'Appartement rue imaginaire',
      text: 'Bonjour, je souhaite des informations.',
      receivedAt: new Date('2026-12-01T09:30:00.000Z'),
      postRef: null,
      propertyRef: null,
      portal: null,
      hasAttachment: true,
    });
  });

  it('mail de portail : le portail est reconnu, le client est l’adresse de réponse', () => {
    expect(one(adaptInbound('email', portalEmail, ctx))).toMatchObject({
      kind: 'portal_email',
      portal: 'seloger',
      subject: 'Nouvelle demande pour votre annonce 12345',
      sender: { name: 'Zoe Imaginaire', identifiers: [{ kind: 'email', value: 'zoe.imaginaire@exemple.test' }] },
    });
    // Sans adresse de réponse, l'adresse du portail n'est jamais prise pour celle du client.
    const { replyTo: _ignored, ...withoutReply } = portalEmail;
    expect(one(adaptInbound('email', withoutReply, ctx)).sender.identifiers).toEqual([]);
  });

  it('formulaire « Être rappelé » du site', () => {
    expect(one(adaptInbound('site_form', siteForm, ctx))).toEqual({
      channel: 'site',
      kind: 'form',
      externalId: 'form-55',
      conversationRef: null,
      sender: {
        channelId: null,
        name: 'Camille',
        identifiers: [
          { kind: 'email', value: 'camille.essai@exemple.test' },
          { kind: 'phone', value: '+33600000102' },
        ],
      },
      subject: null,
      text: 'Rappelez-moi après 18 h',
      receivedAt: new Date('2026-12-01T09:50:00.000Z'),
      postRef: null,
      propertyRef: 'bien-dijon-12',
      portal: null,
      hasAttachment: false,
    });
  });

  it('assistant du site', () => {
    expect(one(adaptInbound('site_chat', siteChat, ctx))).toMatchObject({
      channel: 'site',
      kind: 'site_chat',
      externalId: 'sess-9/q1',
      conversationRef: 'sess-9',
      sender: { channelId: 'sess-9' },
      text: 'Quels sont les frais ?',
      propertyRef: '/biens/bien-dijon-12',
    });
  });

  it('nos propres messages, les échos, accusés et statuts ne sont pas des messages reçus', () => {
    const echo = structuredClone(instagramDm);
    (echo.entry[0]!.messaging[0]!.message as Record<string, unknown>).is_echo = true;
    expect(adaptInbound('instagram', echo, ctx)).toEqual({ messages: [], unreadable: [], ignored: 1 });
    const ownComment = structuredClone(facebookComment);
    ownComment.entry[0]!.changes[0]!.value.from.id = 'PAGE-1';
    expect(adaptInbound('facebook', ownComment, ctx).ignored).toBe(1);
    const read = { object: 'page', entry: [{ id: 'PAGE-1', messaging: [{ sender: { id: 'PSID-12' }, read: { watermark: 1 } }] }] };
    expect(adaptInbound('facebook', read, ctx)).toEqual({ messages: [], unreadable: [], ignored: 1 });
    const statuses = { entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.X', status: 'read' }] } }] }] };
    expect(adaptInbound('whatsapp', statuses, ctx)).toEqual({ messages: [], unreadable: [], ignored: 1 });
  });

  it('une liste d’une autre forme que prévu est gardée comme illisible, jamais perdue', () => {
    const badMessaging = { entry: [{ id: 'PAGE-1', messaging: { message: { mid: 'm1', text: 'Bonjour' } } }] };
    const r1 = adaptInbound('facebook', badMessaging, ctx);
    expect(r1.messages).toEqual([]);
    expect(r1.unreadable).toHaveLength(1);
    expect(r1.unreadable[0]!.raw).toContain('Bonjour');
    const badChanges = { entry: [{ id: 'IG-OWN-1', changes: { field: 'comments' } }] };
    expect(adaptInbound('instagram', badChanges, ctx).unreadable).toHaveLength(1);
    const empty = { entry: [{ id: 'PAGE-1', autre: [] }] };
    expect(adaptInbound('facebook', empty, ctx).unreadable).toHaveLength(1);
    const waChanges = { entry: [{ id: 'W', changes: { value: {} } }] };
    expect(adaptInbound('whatsapp', waChanges, ctx).unreadable).toHaveLength(1);
    const waMessages = { entry: [{ changes: [{ field: 'messages', value: { messages: { id: 'wamid.Z', from: '33600000101' } } }] }] };
    const r2 = adaptInbound('whatsapp', waMessages, ctx);
    expect(r2.unreadable).toHaveLength(1);
    expect(r2.unreadable[0]!.raw).toContain('wamid.Z');
  });

  it('un changement abîmé ou inconnu est gardé ; seuls les événements connus sont écartés', () => {
    const fb = (value: Record<string, unknown>, field = 'feed') => ({ entry: [{ id: 'PAGE-1', changes: [{ field, value }] }] });
    const noVerb = { item: 'comment', comment_id: 'c1', post_id: 'p1', message: 'Bonjour', from: { id: 'u1' } };
    expect(adaptInbound('facebook', fb(noVerb), ctx).unreadable).toHaveLength(1);
    expect(adaptInbound('facebook', fb({ item: 'post', verb: 'add', message: 'Une question', from: { id: 'u1' } }), ctx).unreadable).toHaveLength(1);
    expect(adaptInbound('facebook', fb({ item: 'comment' }, 'autre'), ctx).unreadable).toHaveLength(1);
    expect(adaptInbound('facebook', fb({ item: 'reaction', verb: 'add', from: { id: 'u1' } }), ctx)).toEqual({ messages: [], unreadable: [], ignored: 1 });
    expect(adaptInbound('facebook', fb({ ...noVerb, verb: 'remove' }), ctx)).toEqual({ messages: [], unreadable: [], ignored: 1 });
    const ig = { entry: [{ id: 'IG-OWN-1', changes: [{ field: 'mentions', value: { media_id: 'x' } }] }] };
    expect(adaptInbound('instagram', ig, ctx).unreadable).toHaveLength(1);
  });

  it('les messages reçus pendant qu’une autre application a la main (standby) sont lus', () => {
    const standby = { object: 'page', entry: [{ id: 'PAGE-1', standby: messenger.entry[0]!.messaging }] };
    expect(one(adaptInbound('facebook', standby, ctx)).externalId).toBe('m-mid-3');
  });

  it('nos propres mails ne sont pas des messages reçus', () => {
    const own = { ...email, from: 'Agence <Agent@Agence.test>' };
    expect(adaptInbound('email', own, { now: NOW, ownIds: ['agent@agence.test'] })).toEqual({ messages: [], unreadable: [], ignored: 1 });
  });

  it('un bouton ou une question d’accueil touchés sont des messages ; un événement inconnu est gardé', () => {
    const postback = {
      object: 'instagram',
      entry: [{ id: 'IG-OWN-1', messaging: [{ sender: { id: 'IGSID-501' }, timestamp: 1796124300000, postback: { mid: 'pb-1', title: 'Ce bien est-il encore disponible ?', payload: 'Q1' } }] }],
    };
    expect(one(adaptInbound('instagram', postback, ctx))).toMatchObject({
      kind: 'direct',
      externalId: 'pb-1',
      text: 'Ce bien est-il encore disponible ?',
      conversationRef: 'IGSID-501',
    });
    const unknown = { object: 'page', entry: [{ id: 'PAGE-1', messaging: [{ sender: { id: 'PSID-12' }, nouveau: { x: 1 } }] }] };
    const result = adaptInbound('facebook', unknown, ctx);
    expect(result.messages).toEqual([]);
    expect(result.unreadable).toHaveLength(1);
  });

  it('une date absente ou illisible prend l’heure de réception', () => {
    expect(one(adaptInbound('email', { ...email, date: 'pas une date' }, ctx)).receivedAt).toEqual(NOW);
  });
});

describe('C01 · un message illisible est gardé, jamais jeté', () => {
  it('notification sans forme, élément abîmé au milieu d’éléments lisibles, type inconnu', () => {
    const broken = adaptInbound('instagram', 'pas du JSON', ctx);
    expect(broken.messages).toEqual([]);
    expect(broken.unreadable).toEqual([{ channel: 'instagram', reason: expect.any(String), raw: 'pas du JSON' }]);

    const mixed = structuredClone(whatsapp) as { entry: { changes: { value: { messages: unknown[] } }[] }[] };
    mixed.entry[0]!.changes[0]!.value.messages.push({ from: '33600000101', id: 'wamid.A3', type: 'unsupported' });
    const result = adaptInbound('whatsapp', mixed, ctx);
    expect(result.messages.map((m) => m.externalId)).toEqual(['wamid.A1', 'wamid.A2']);
    expect(result.unreadable).toHaveLength(1);
    expect(result.unreadable[0]!.raw).toContain('wamid.A3');

    expect(adaptInbound('email', { from: 'x', text: 'bonjour' }, ctx).unreadable).toHaveLength(1);
    expect(adaptInbound('site_chat', { sessionId: 's', messageId: 'm', text: '   ' }, ctx).unreadable).toHaveLength(1);
  });
});

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let n = 0;
  const reception = new Reception(db, () => `id-${++n}`, () => NOW);
  const network = await new FicheClient(db).createNetwork('Réseau test');
  return { db, reception, networkId: network.id };
}

const PERSONAL = [
  'Lea.Testeuse',
  'lea.testeuse',
  'IGSID-501',
  'IGSID-777',
  'PSID-12',
  'FBID-31',
  'Paul Essai',
  '33600000101',
  'Nina Fictive',
  'hugo.invente',
  'Hugo Inventé',
  'zoe.imaginaire',
  'camille.essai',
  'Camille',
  '+33600000102',
  'T3',
  'Prix ?',
  'Bonsoir',
  'Rappelez-moi',
  'Appartement rue imaginaire',
  'pas du JSON',
];

describeWithSqlite('C01 · rangement unique des messages reçus', () => {
  it('[R18] un même message reçu deux fois n’est rangé et traité qu’une fois', async () => {
    const { db, reception, networkId } = await setup();
    const first = await reception.ingest(networkId, 'whatsapp', whatsapp);
    const again = await reception.ingest(networkId, 'whatsapp', structuredClone(whatsapp));
    expect(first.received.map((r) => [r.outcome, r.toProcess])).toEqual([
      ['stored', true],
      ['stored', true],
    ]);
    // Pas encore pris : la seconde réception peut encore le traiter, mais `claim` ne cède qu'une fois.
    expect(again.received.map((r) => r.outcome)).toEqual(['duplicate', 'duplicate']);
    for (const r of first.received) expect(await reception.claim(r.inboundId)).toBe(true);
    for (const r of again.received) expect(await reception.claim(r.inboundId)).toBe(false);
    const third = await reception.ingest(networkId, 'whatsapp', structuredClone(whatsapp));
    expect(third.received.map((r) => [r.outcome, r.toProcess])).toEqual([
      ['duplicate', false],
      ['duplicate', false],
    ]);
    expect(again.received.map((r) => r.inboundId)).toEqual(first.received.map((r) => r.inboundId));
    const count = await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM inbound_messages');
    expect(count?.n).toBe(2);
  });

  it('[R18] un même message reçu deux fois en même temps n’est rangé et traité qu’une fois', async () => {
    const { db, reception, networkId } = await setup();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reception.ingest(networkId, 'email', structuredClone(email))),
    );
    const flat = results.flatMap((r) => r.received);
    expect(flat.filter((r) => r.outcome === 'stored')).toHaveLength(1);
    expect(new Set(flat.map((r) => r.inboundId)).size).toBe(1);
    expect((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM inbound_messages'))?.n).toBe(1);

    // Chaque réception tente de traiter, toutes en même temps : une seule l'obtient.
    const id = flat[0]!.inboundId;
    const claims = await Promise.all(flat.filter((r) => r.toProcess).map((r) => reception.claim(r.inboundId)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await reception.markProcessed(id)).toBe(true);
    expect(await reception.claim(id)).toBe(false);
    expect((await reception.get(id))?.status).toBe('processed');
  });

  it('[R18] un message rangé puis perdu avant son traitement est repris une fois, jamais zéro', async () => {
    const { reception, networkId } = await setup();
    const first = await reception.ingest(networkId, 'email', email);
    // Coupure : le traitement n'a jamais commencé. Le message attend dans la reprise.
    expect((await reception.pending(networkId)).map((r) => r.id)).toEqual([first.received[0]!.inboundId]);
    const again = await reception.ingest(networkId, 'email', email);
    expect(again.received[0]).toMatchObject({ outcome: 'duplicate', toProcess: true });
    expect(await reception.claim(again.received[0]!.inboundId)).toBe(true);
    expect(await reception.pending(networkId)).toEqual([]);
  });

  it('[R18] le même identifiant sur un autre canal ou un autre type est un autre message', async () => {
    const { reception, networkId } = await setup();
    const asDm = await reception.ingest(networkId, 'instagram', instagramDm);
    const sameIdOnMessenger = structuredClone(messenger);
    sameIdOnMessenger.entry[0]!.messaging[0]!.message.mid = 'ig-mid-1';
    const other = await reception.ingest(networkId, 'facebook', sameIdOnMessenger);
    expect(asDm.received[0]!.toProcess).toBe(true);
    expect(other.received[0]!.toProcess).toBe(true);
  });

  it('chaque canal et chaque type se range et se relit sans perte', async () => {
    const { reception, networkId } = await setup();
    const inputs = [
      ['instagram', instagramDm],
      ['instagram', instagramComment],
      ['facebook', messenger],
      ['facebook', facebookComment],
      ['whatsapp', whatsapp],
      ['email', email],
      ['email', portalEmail],
      ['site_form', siteForm],
      ['site_chat', siteChat],
    ] as const;
    for (const [source, raw] of inputs) {
      const expected = adaptInbound(source, raw, { now: NOW });
      const { received } = await reception.ingest(networkId, source, raw);
      expect(received).toHaveLength(expected.messages.length);
      for (const [i, message] of expected.messages.entries()) {
        const row = await reception.get(received[i]!.inboundId);
        expect(row).toMatchObject({
          channel: message.channel,
          kind: message.kind,
          external_id: message.externalId,
          conversation_ref: message.conversationRef,
          sender_channel_id: message.sender.channelId,
          sender_name: message.sender.name,
          subject: message.subject,
          body: message.text,
          post_ref: message.postRef,
          property_ref: message.propertyRef,
          portal: message.portal,
          has_attachment: message.hasAttachment ? 1 : 0,
          status: 'received',
          received_at: message.receivedAt.toISOString(),
        });
        expect(senderIdentifiers(row!)).toEqual(message.sender.identifiers);
      }
    }
  });

  it('un message illisible est rangé avec son contenu et signalé à l’agent, une seule fois', async () => {
    const { reception, networkId } = await setup();
    const first = await reception.ingest(networkId, 'instagram', 'pas du JSON');
    const again = await reception.ingest(networkId, 'instagram', 'pas du JSON');
    expect(first.received).toEqual([{ inboundId: expect.any(String), outcome: 'unreadable', toProcess: false }]);
    expect(again.received[0]).toMatchObject({ inboundId: first.received[0]!.inboundId, outcome: 'duplicate' });
    const waiting = await reception.forAgent(networkId);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ status: 'unreadable', raw_payload: 'pas du JSON', channel: 'instagram' });
    // Un message illisible n'est jamais pris pour un traitement automatique.
    expect(await reception.claim(waiting[0]!.id)).toBe(false);
  });

  it('[R13] le journal de la réception ne contient aucune donnée personnelle', async () => {
    const { db, reception, networkId } = await setup();
    for (const [source, raw] of [
      ['instagram', instagramDm],
      ['instagram', instagramComment],
      ['facebook', messenger],
      ['facebook', facebookComment],
      ['whatsapp', whatsapp],
      ['email', email],
      ['email', portalEmail],
      ['site_form', siteForm],
      ['site_chat', siteChat],
      ['instagram', 'pas du JSON'],
    ] as const) {
      await reception.ingest(networkId, source, raw);
      await reception.ingest(networkId, source, raw);
    }
    const rows = await db.all<Record<string, unknown>>('SELECT * FROM reception_log');
    expect(rows.length).toBe(22);
    expect(new Set(rows.map((r) => r.outcome))).toEqual(new Set(['stored', 'duplicate', 'unreadable']));
    const logText = JSON.stringify(rows);
    for (const value of PERSONAL) expect(logText, value).not.toContain(value);
    // Le journal ne garde que des identifiants internes : ni identifiant de message du canal, ni conversation.
    for (const value of ['ig-mid-1', 'wamid.A1', 'mail-1@exemple.test', 'form-55', 'sess-9']) {
      expect(logText, value).not.toContain(value);
    }
  });

  it('rien n’est effacé : un message traité reste rangé', async () => {
    const { db, reception, networkId } = await setup();
    const { received } = await reception.ingest(networkId, 'site_form', siteForm);
    const id = received[0]!.inboundId;
    await reception.claim(id);
    await reception.markProcessed(id);
    expect(await reception.get(id)).toMatchObject({ status: 'processed', body: 'Rappelez-moi après 18 h' });
    expect((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM reception_log WHERE inbound_id = ?', [id]))?.n).toBe(1);
  });
});
