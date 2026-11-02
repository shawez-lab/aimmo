import { expect, it } from 'vitest';
import {
  Acces,
  ControleEnvois,
  ConversationRelais,
  DEFAULT_SEND_SETTINGS,
  DecisionEnvoi,
  FakeChannel,
  FicheClient,
  FicheUnique,
  PremiereReponse,
  Rattachement,
  Reception,
  ReconnaissanceBien,
  SqlSendJournal,
  SqliteJournalStore,
  applyMigrations,
  decideSend,
  fromSyncSqlite,
  humanRepliesFromMeta,
  humanRepliesFromWhatsApp,
  type Channel,
  type InboundMessage,
  type ReplyWriter,
  type SendFacts,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un dimanche à 23 h, heure de Paris : les réponses à un client qui vient d'écrire partent quand même [R01].
const SUNDAY_NIGHT = new Date('2026-12-06T22:00:00.000Z');
const OUR_APP = '1000000000000001';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function setup(writer?: ReplyWriter) {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  let clock = SUNDAY_NIGHT.getTime();
  const now = (): Date => new Date(clock);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const decisions = new DecisionEnvoi(db, store, fiche, { now });
  const reception = new Reception(db, undefined, now);
  const rattachement = new Rattachement(db, store, fiche, decisions, reception, { now });
  const biens = new ReconnaissanceBien(db);
  const channels = (['email', 'sms', 'whatsapp', 'instagram', 'facebook', 'phone'] as Channel[]).map((c) => new FakeChannel(c));
  const controle = new ControleEnvois(db, fiche, decisions, { channels, journal: new SqlSendJournal(db, undefined, now), now });
  const premiere = new PremiereReponse(db, fiche, reception, biens, controle, writer ? { writer } : {});
  const acces = new Acces(db, store, fiche, new SqliteJournalStore(raw), { now });
  const relais = new ConversationRelais(db, store, fiche, reception, premiere, acces, { now });
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const other = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Autre' });
  const home = await store.createProperty({
    networkId: network.id,
    agentId: agent.id,
    reference: '383',
    kind: 'home',
    city: 'Dijon',
    surfaceM2: 82,
    priceEur: 245000,
    status: 'available',
  });
  await biens.link({ networkId: network.id, propertyId: home.id, kind: 'post', value: 'video-383', at: now() });

  let seq = 0;
  /** Un message privé Instagram inventé, dans la conversation du client `who`. */
  const dm = (who: string, text: string, extra: Partial<InboundMessage> = {}): InboundMessage => {
    seq += 1;
    return {
      channel: 'instagram',
      kind: 'direct',
      externalId: `mid-${seq}`,
      conversationRef: `igsid-${who}`,
      sender: { channelId: `igsid-${who}`, name: null, identifiers: [{ kind: 'instagram', value: `${who}.test` }] },
      subject: null,
      text,
      receivedAt: now(),
      postRef: null,
      propertyRef: null,
      portal: null,
      hasAttachment: false,
      ...extra,
    };
  };
  const receive = async (m: InboundMessage): Promise<string> => {
    const [r] = (await reception.store(network.id, { messages: [m], unreadable: [], ignored: 0 })).received;
    const inboundId = (r as { inboundId: string }).inboundId;
    await rattachement.attach(inboundId);
    await db.run('UPDATE persons SET agent_id = ? WHERE id = (SELECT person_id FROM inbound_messages WHERE id = ?)', [agent.id, inboundId]);
    return inboundId;
  };
  const sent = (channel: Channel): string[] => channels.find((c) => c.channel === channel)!.sent.map((s) => s.body);
  const personOf = async (inboundId: string): Promise<string> => (await reception.get(inboundId))!.person_id!;
  const echo = (who: string, mid: string, text: string, appId?: string) => ({
    object: 'instagram',
    entry: [
      {
        id: 'page-1',
        time: clock,
        messaging: [
          {
            sender: { id: 'page-1' },
            recipient: { id: `igsid-${who}` },
            timestamp: clock,
            message: { mid, text, is_echo: true, ...(appId ? { app_id: appId } : {}) },
          },
        ],
      },
    ],
  });
  return {
    db,
    controle,
    relais,
    network,
    agent,
    other,
    dm,
    receive,
    sent,
    personOf,
    echo,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describeWithSqlite('C05 · conversation et relais à l’agent', () => {
  it('[R21] après la réponse d’un agent, plus aucun message automatique dans cette conversation', async () => {
    const t = await setup();
    const first = await t.receive(t.dm('lou', 'Bonjour, vous êtes dispo pour un appel ?'));
    expect(await t.relais.process(first)).toMatchObject({ status: 'replied' });
    expect(t.sent('instagram')).toHaveLength(1);

    // L'agent répond lui-même dans Instagram : l'écho revient sans notre application.
    t.advance(2 * MINUTE);
    const replies = humanRepliesFromMeta('instagram', t.echo('lou', 'mid-human-1', 'Je vous appelle demain matin.'), [OUR_APP]);
    expect(replies).toHaveLength(1);
    expect(await t.relais.noteHumanReply(t.network.id, replies[0]!)).toBe('noted');
    // Le même écho reçu deux fois n'est rangé qu'une fois.
    expect(await t.relais.noteHumanReply(t.network.id, replies[0]!)).toBe('duplicate');

    t.advance(MINUTE);
    const second = await t.receive(t.dm('lou', 'Super, et le prix ?'));
    expect(await t.relais.process(second)).toMatchObject({ status: 'silent' });
    const person = await t.personOf(second);
    // Même une relance d'initiative ne part plus dans cette conversation, ni aucune réponse.
    const reply = await t.controle.send({
      networkId: t.network.id,
      personId: person,
      conversationId: 'instagram:igsid-lou',
      channel: 'instagram',
      kind: 'reply',
      fallbackTexts: ['Hello ! Je reviens vers toi.'],
    });
    expect(reply).toMatchObject({ status: 'refused', rule: 'R21' });
    expect(t.sent('instagram')).toHaveLength(1);
    const state = await t.relais.state(person, 'instagram:igsid-lou');
    expect(state).toMatchObject({ holder: 'agent', humanReplied: true, handover: { reason: 'human_reply' } });
  });

  it('[R21] une relance sans conversation citée, sur un canal de Meta, se tait aussi après la réponse d’un humain', async () => {
    const t = await setup();
    const id = await t.receive(t.dm('ivy', 'Bonjour'));
    t.advance(1000);
    await t.relais.process(id);
    const [human] = humanRepliesFromMeta('instagram', t.echo('ivy', 'mid-human-ivy', 'Je vous rappelle.'), [OUR_APP]);
    expect(await t.relais.noteHumanReply(t.network.id, human!)).toBe('noted');
    t.advance(11 * HOUR); // lundi 10 h, dans la fenêtre de Meta
    const out = await t.controle.send({
      networkId: t.network.id,
      personId: await t.personOf(id),
      channel: 'instagram',
      kind: 'follow_up',
      subject: 'relance:ivy',
      fallbackTexts: ['Hello ! Toujours partant pour la visite ?'],
    });
    expect(out).toMatchObject({ status: 'refused', rule: 'R21' });
    const facts: SendFacts = {
      exclusions: [],
      consents: [],
      relations: [],
      sentToday: { review_request: 0, partner: 0 },
      messages: [{ conversation_id: 'instagram:x', channel: 'instagram', direction: 'in', occurred_at: '2026-12-07T08:00:00.000Z' }],
      handovers: [{ conversation_id: 'instagram:x', handed_at: '2026-12-07T08:05:00.000Z' }],
    };
    expect(decideSend({ channel: 'instagram', kind: 'follow_up', at: new Date('2026-12-07T13:00:00.000Z') }, facts)).toMatchObject({ allowed: false, rule: 'R21' });
    expect(decideSend({ channel: 'instagram', kind: 'follow_up', at: new Date('2026-12-07T13:00:00.000Z') }, { ...facts, handovers: [] })).toMatchObject({ allowed: true });
  });

  it('[R21] l’écho de notre propre réponse, même sans application, ne fait pas taire l’assistant', async () => {
    const t = await setup();
    const id = await t.receive(t.dm('kim', 'Bonjour, vous êtes dispo ?'));
    t.advance(1000);
    await t.relais.process(id);
    // Notre réponse revient en écho sans app_id : son identifiant est celui que le canal nous a rendu.
    const [ours] = humanRepliesFromMeta('instagram', t.echo('kim', 'fake-1', t.sent('instagram')[0]!), [OUR_APP]);
    expect(await t.relais.noteHumanReply(t.network.id, ours!)).toBe('own');
    // Le même texte sous un autre identifiant, alors que le nôtre est connu : c'est un humain qui l'a écrit.
    const [copy] = humanRepliesFromMeta('instagram', t.echo('kim', 'mid-copie', t.sent('instagram')[0]!), [OUR_APP]);
    expect(await t.relais.noteHumanReply(t.network.id, copy!)).toBe('noted');
    t.advance(MINUTE);
    expect(await t.relais.process(await t.receive(t.dm('kim', 'Je voudrais vendre')))).toMatchObject({ status: 'silent' });
    expect(t.sent('instagram')).toHaveLength(1);
  });

  it('[R21] notre écho arrivé avant que le canal rende son identifiant est reconnu à son texte', async () => {
    const t = await setup();
    const id = await t.receive(t.dm('lia', 'Bonjour, vous êtes dispo ?'));
    t.advance(1000);
    await t.relais.process(id);
    // Le canal n'a pas encore rendu l'identifiant : on l'efface du jeu de test en le rendant inconnu.
    await t.db.run("UPDATE outbound_refs SET message_id = (SELECT id FROM messages WHERE direction = 'in' LIMIT 1)");
    const [early] = humanRepliesFromMeta('instagram', t.echo('lia', 'mid-inconnu', t.sent('instagram')[0]!), [OUR_APP]);
    expect(await t.relais.noteHumanReply(t.network.id, early!)).toBe('own');
    t.advance(MINUTE);
    expect(await t.relais.process(await t.receive(t.dm('lia', 'Je voudrais vendre')))).toMatchObject({ status: 'replied' });
    expect(t.sent('instagram')).toHaveLength(2);
  });

  it('[R21] l’agent qui répond depuis WhatsApp Business fait taire l’assistant', async () => {
    const t = await setup();
    const wa = (text: string): InboundMessage => ({
      ...t.dm('wa', text),
      channel: 'whatsapp',
      conversationRef: '33600000099',
      sender: { channelId: '33600000099', name: null, identifiers: [{ kind: 'whatsapp', value: '+33600000099' }] },
    });
    const id = await t.receive(wa('Bonjour, le bien est dispo ?'));
    t.advance(1000);
    expect(await t.relais.process(id)).toMatchObject({ status: 'replied' });
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'smb_message_echoes', value: { message_echoes: [{ from: '33100000000', to: '33600000099', id: 'wamid.human', timestamp: String(Math.floor(SUNDAY_NIGHT.getTime() / 1000) + 60), type: 'text', text: { body: 'Je vous appelle.' } }] } }] }],
    };
    const [human] = humanRepliesFromWhatsApp(payload);
    expect(human).toMatchObject({ channel: 'whatsapp', conversationRef: '33600000099' });
    expect(await t.relais.noteHumanReply(t.network.id, human!)).toBe('noted');
    t.advance(MINUTE);
    expect(await t.relais.process(await t.receive(wa('Merci, à demain')))).toMatchObject({ status: 'silent' });
    expect(t.sent('whatsapp')).toHaveLength(1);
    expect(humanRepliesFromWhatsApp({ entry: [{ changes: [{ field: 'messages', value: {} }] }] })).toHaveLength(0);
  });

  it('[R21] sur WhatsApp, un humain qui écrit le même texte que l’assistant le fait quand même taire', async () => {
    const t = await setup();
    const wa = (text: string): InboundMessage => ({
      ...t.dm('wb', text),
      channel: 'whatsapp',
      conversationRef: '33600000098',
      sender: { channelId: '33600000098', name: null, identifiers: [{ kind: 'whatsapp', value: '+33600000098' }] },
    });
    const id = await t.receive(wa('Bonjour'));
    t.advance(1000);
    await t.relais.process(id);
    await t.db.run('UPDATE outbound_refs SET message_id = (SELECT id FROM messages WHERE direction = ? LIMIT 1)', ['in']);
    const human = { channel: 'whatsapp' as const, conversationRef: '33600000098', externalId: 'wamid.same', text: t.sent('whatsapp')[0]!, sentAt: new Date(SUNDAY_NIGHT.getTime() + 2000) };
    expect(await t.relais.noteHumanReply(t.network.id, human)).toBe('noted');
  });

  it('[R21] l’agent qui écrit le premier : la personne est retrouvée par son identifiant chez le canal', async () => {
    const t = await setup();
    const id = await t.receive(t.dm('rio', 'Bonjour'));
    const person = await t.personOf(id);
    await t.db.run('INSERT INTO contact_keys (network_id, key, person_id, created_at) VALUES (?, ?, ?, ?)', [t.network.id, 'instagram:direct:igsid-autre', person, SUNDAY_NIGHT.toISOString()]);
    const [human] = humanRepliesFromMeta('instagram', t.echo('autre', 'mid-first', 'Bonjour, je vous écris pour la maison.'), [OUR_APP]);
    expect(await t.relais.noteHumanReply(t.network.id, human!)).toBe('noted');
    expect(await t.relais.state(person, 'instagram:igsid-autre')).toMatchObject({ holder: 'agent' });
    const [nobody] = humanRepliesFromMeta('instagram', t.echo('personne', 'mid-x', 'Bonjour'), [OUR_APP]);
    expect(await t.relais.noteHumanReply(t.network.id, nobody!)).toBe('unknown_conversation');
  });

  it('[R21] nos propres échos ne font pas taire l’assistant ; un écho sans application connue, si', () => {
    expect(humanRepliesFromMeta('instagram', setupEcho(OUR_APP), [OUR_APP])).toHaveLength(0);
    expect(humanRepliesFromMeta('instagram', setupEcho('2000000000000002'), [OUR_APP])).toHaveLength(1);
    expect(humanRepliesFromMeta('instagram', setupEcho(undefined), [OUR_APP])).toHaveLength(1);
    // Un message du client n'est pas un écho.
    const notEcho = { entry: [{ messaging: [{ sender: { id: 'u' }, recipient: { id: 'p' }, timestamp: 1, message: { mid: 'm', text: 'x' } }] }] };
    expect(humanRepliesFromMeta('instagram', notEcho, [OUR_APP])).toHaveLength(0);
    expect(humanRepliesFromMeta('instagram', 'pas du json', [OUR_APP])).toHaveLength(0);
  });

  it('[R12] [R21] une alerte vue revient quand le client réécrit sans réponse humaine, l’assistant reste muet', async () => {
    const t = await setup();
    const open = async () => (await t.db.all<{ reason: string }>("SELECT reason FROM agent_alerts WHERE seen_at IS NULL AND reason = 'exchanges'")).map((a) => a.reason);
    for (let i = 0; i < 6; i++) {
      t.advance(MINUTE);
      await t.relais.process(await t.receive(t.dm('noa', `Message ${i}`)));
    }
    expect(await open()).toEqual(['exchanges']);
    const sent = t.sent('instagram').length;
    t.advance(MINUTE);
    await t.db.run('UPDATE agent_alerts SET seen_at = ?', [new Date(SUNDAY_NIGHT.getTime() + 7 * MINUTE).toISOString()]);
    expect(await open()).toEqual([]);
    t.advance(HOUR);
    const again = await t.receive(t.dm('noa', 'Toujours là ?'));
    expect(await t.relais.process(again)).toMatchObject({ status: 'silent' });
    expect(await open()).toEqual(['exchanges']);
    expect(t.sent('instagram')).toHaveLength(sent);
    // Le même message rejoué après avoir vu l'alerte ne la rouvre pas.
    t.advance(MINUTE);
    await t.db.run('UPDATE agent_alerts SET seen_at = ?', [new Date(SUNDAY_NIGHT.getTime() + 2 * HOUR).toISOString()]);
    await t.relais.process(again);
    expect(await open()).toEqual([]);
  });

  it('[R21] au 6e message du client, l’agent est prévenu et l’assistant se tait', async () => {
    const t = await setup();
    const texts = ['Bonjour', 'Je veux vendre ma maison', 'Vous pouvez me rappeler ?', 'Merci', 'Et pour une estimation ?', 'Allô ?', 'Toujours là ?'];
    const outcomes = [];
    for (const text of texts) {
      t.advance(MINUTE);
      outcomes.push(await t.relais.process(await t.receive(t.dm('noa', text))));
    }
    // Les 5 premiers messages restent à l'assistant.
    for (const o of outcomes.slice(0, 5)) expect(['replied', 'not_sent']).toContain(o.status);
    expect(outcomes[5]).toMatchObject({ status: 'handed_over' });
    expect(outcomes[6]).toMatchObject({ status: 'silent' });
    const sentAfterFive = t.sent('instagram').length;
    expect(sentAfterFive).toBeGreaterThan(0);
    expect(sentAfterFive).toBeLessThanOrEqual(5);

    const alerts = await t.relais.alertsFor(t.network.id, t.agent.id);
    expect(alerts.filter((a) => a.reason === 'exchanges')).toHaveLength(1);
    // L'alerte ne porte aucun texte du client ni aucune coordonnée [R13].
    expect(JSON.stringify(alerts)).not.toMatch(/Allô|maison|vendre|estimation/);

    // La décision d'envoi refuse aussi d'elle-même au-delà de 5 messages reçus.
    const conversation = 'instagram:c';
    const facts = (received: number): SendFacts => ({
      exclusions: [],
      consents: [],
      relations: [],
      sentToday: { review_request: 0, partner: 0 },
      messages: Array.from({ length: received }, (_, i) => ({
        conversation_id: conversation,
        channel: 'instagram' as const,
        direction: 'in' as const,
        occurred_at: new Date(SUNDAY_NIGHT.getTime() - (received - i) * MINUTE).toISOString(),
      })),
    });
    const ask = { channel: 'instagram' as const, kind: 'reply' as const, conversationId: conversation, at: SUNDAY_NIGHT };
    expect(decideSend(ask, facts(5))).toMatchObject({ allowed: true });
    expect(decideSend(ask, facts(6))).toMatchObject({ allowed: false, rule: 'R21' });
    // Une relance sans conversation citée compte aussi les échanges du canal.
    const { conversationId: _c, ...noConversation } = ask;
    expect(decideSend({ ...noConversation, kind: 'follow_up', at: new Date('2026-12-07T09:00:00.000Z') }, facts(5))).toMatchObject({ allowed: true });
    expect(decideSend({ ...noConversation, kind: 'follow_up', at: new Date('2026-12-07T09:00:00.000Z') }, facts(6))).toMatchObject({ allowed: false, rule: 'R21' });
  });

  it('[R21] l’IA qui rédige pendant qu’un humain répond est arrêtée : rien ne part', async () => {
    let relais: ConversationRelais | null = null;
    let netId = '';
    const writer: ReplyWriter = {
      async write() {
        const [reply] = humanRepliesFromMeta('instagram', setupEcho(undefined, 'igsid-zoe'), [OUR_APP]);
        await relais!.noteHumanReply(netId, reply!);
        return 'Hello ! Le bien est dispo, tu veux le visiter ?';
      },
    };
    const t = await setup(writer);
    relais = t.relais;
    netId = t.network.id;
    // Un premier message ouvre la conversation, puis un commentaire de la même personne cite le bien.
    const first = await t.receive(t.dm('zoe', 'Bonjour', { postRef: 'video-383' }));
    const out = await t.relais.process(first);
    expect(out).toMatchObject({ status: 'not_sent', reply: { result: { status: 'refused', rule: 'R21' } } });
    expect(t.sent('instagram')).toHaveLength(0);
  });

  it('[R21] l’agent voit la conversation et la reprend à tout moment ; rendez-vous pris, l’assistant se tait', async () => {
    const t = await setup();
    const id = await t.receive(t.dm('ana', 'Bonjour, une visite samedi ?'));
    t.advance(1000);
    await t.relais.process(id);
    const person = await t.personOf(id);
    const me = { role: 'agent' as const, userId: t.agent.id, networkId: t.network.id };
    const seen = await t.relais.view(me, person, 'instagram:igsid-ana');
    expect(seen.ok).toBe(true);
    if (seen.ok) {
      expect(seen.messages.map((m) => m.direction)).toEqual(['in', 'out']);
      expect(seen.state.holder).toBe('assistant');
    }
    // Un autre agent ne voit pas la conversation [R16].
    expect(await t.relais.view({ role: 'agent', userId: t.other.id, networkId: t.network.id }, person, 'instagram:igsid-ana')).toEqual({ ok: false });
    expect(await t.relais.takeOver({ role: 'agent', userId: t.other.id, networkId: t.network.id }, person, 'instagram:igsid-ana')).toBeNull();

    expect(await t.relais.takeOver(me, person, 'instagram:igsid-ana')).toMatchObject({ reason: 'agent_takeover' });
    t.advance(MINUTE);
    expect(await t.relais.process(await t.receive(t.dm('ana', 'Parfait, à samedi')))).toMatchObject({ status: 'silent' });
    expect(t.sent('instagram')).toHaveLength(1);

    // Rendez-vous pris dans une autre conversation : l'assistant s'y tait aussi, pour de bon.
    const other = await t.receive(t.dm('eli', 'Bonjour, rappel possible ?'));
    await t.relais.process(other);
    await t.relais.appointmentBooked(await t.personOf(other), 'instagram:igsid-eli');
    t.advance(MINUTE);
    expect(await t.relais.process(await t.receive(t.dm('eli', 'Merci !')))).toMatchObject({ status: 'silent' });
    expect(t.sent('instagram')).toHaveLength(2);
  });

  it('[R22] sur Instagram, Facebook et WhatsApp, rien ne part hors des 24 heures depuis le dernier message du client', async () => {
    const t = await setup();
    const id = await t.receive(t.dm('max', 'Bonjour'));
    await t.relais.process(id);
    const person = await t.personOf(id);
    const followUp = (channel: Channel, subject: string) =>
      t.controle.send({
        networkId: t.network.id,
        personId: person,
        conversationId: `instagram:igsid-max`,
        channel,
        kind: 'follow_up',
        subject,
        fallbackTexts: [`Hello ! Je reviens vers toi, comme promis, ${subject === 'relance-1' ? 'pour la visite' : 'pour le rappel'}.`],
      });
    // Lundi 10 h, moins de 24 heures après : la relance part.
    t.advance(11 * HOUR);
    expect(await followUp('instagram', 'relance-1')).toMatchObject({ status: 'sent' });
    // Mardi 10 h, 35 heures après le dernier message du client : plus rien.
    t.advance(24 * HOUR);
    expect(await followUp('instagram', 'relance-2')).toMatchObject({ status: 'refused', rule: 'R22' });

    const base: SendFacts = {
      exclusions: [],
      consents: [{ channel: 'whatsapp', purpose: 'follow_up', given_at: '2026-01-01T00:00:00.000Z', withdrawn_at: null }],
      relations: [],
      sentToday: { review_request: 0, partner: 0 },
      messages: [{ conversation_id: 'whatsapp:x', channel: 'whatsapp', direction: 'in', occurred_at: '2026-12-07T09:00:00.000Z' }],
    };
    const at = (ms: number) => new Date(Date.parse('2026-12-07T09:00:00.000Z') + ms);
    for (const channel of ['whatsapp', 'instagram', 'facebook'] as Channel[]) {
      const facts = { ...base, messages: base.messages.map((m) => ({ ...m, channel, conversation_id: `${channel}:x` })) };
      const reply = (ms: number) => decideSend({ channel, kind: 'reply', conversationId: `${channel}:x`, at: at(ms) }, facts);
      expect(reply(24 * HOUR)).toMatchObject({ allowed: true });
      expect(reply(24 * HOUR + 1)).toMatchObject({ allowed: false, rule: 'R22' });
      // Sans aucun message du client sur ce canal, la fenêtre n'est jamais ouverte.
      expect(decideSend({ channel, kind: 'follow_up', at: at(HOUR) }, { ...base, messages: [] })).toMatchObject({ allowed: false, rule: 'R22' });
    }
    // Le mail n'a pas de fenêtre de Meta.
    expect(decideSend({ channel: 'email', kind: 'reply', conversationId: 'email:x', at: at(30 * HOUR) }, {
      ...base,
      messages: [{ conversation_id: 'email:x', channel: 'email', direction: 'in', occurred_at: base.messages[0]!.occurred_at }],
    }).rule).not.toBe('R22');
  });

  it('[R01] une relance à l’initiative du réseau ne part ni le soir ni le dimanche', () => {
    const facts: SendFacts = {
      exclusions: [],
      consents: [],
      relations: [],
      sentToday: { review_request: 0, partner: 0 },
      messages: [{ conversation_id: 'instagram:x', channel: 'instagram', direction: 'in', occurred_at: '2026-12-06T09:00:00.000Z' }],
    };
    const followUp = (iso: string) => decideSend({ channel: 'instagram', kind: 'follow_up', conversationId: 'instagram:x', at: new Date(iso) }, facts);
    // Dimanche 11 h, heure de Paris.
    expect(followUp('2026-12-06T10:00:00.000Z')).toMatchObject({ allowed: false, rule: 'R01' });
    // Lundi 21 h, heure de Paris : déjà hors de la fenêtre de Meta comme des heures ; un message reçu à 20 h 30.
    const evening = { ...facts, messages: [{ ...facts.messages[0]!, occurred_at: '2026-12-07T19:30:00.000Z' }] };
    expect(decideSend({ channel: 'instagram', kind: 'follow_up', conversationId: 'instagram:x', at: new Date('2026-12-07T20:00:00.000Z') }, evening)).toMatchObject({
      allowed: false,
      rule: 'R01',
    });
    // La réponse au client qui vient d'écrire part, elle, à toute heure.
    expect(decideSend({ channel: 'instagram', kind: 'reply', conversationId: 'instagram:x', at: new Date('2026-12-07T20:00:00.000Z') }, evening)).toMatchObject({
      allowed: true,
      rule: 'R01',
    });
    expect(DEFAULT_SEND_SETTINGS.assistantMaxExchanges).toBe(5);
    expect(DEFAULT_SEND_SETTINGS.metaWindowHours).toBe(24);
  });
});

function setupEcho(appId: string | undefined, recipient = 'igsid-x') {
  return {
    object: 'instagram',
    entry: [
      {
        messaging: [
          {
            sender: { id: 'page-1' },
            recipient: { id: recipient },
            timestamp: SUNDAY_NIGHT.getTime(),
            message: { mid: `mid-echo-${appId ?? 'none'}-${recipient}`, text: 'Je vous rappelle.', is_echo: true, ...(appId ? { app_id: appId } : {}) },
          },
        ],
      },
    ],
  };
}
