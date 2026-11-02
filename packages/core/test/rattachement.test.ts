import { expect, it } from 'vitest';
import {
  Acces,
  DecisionEnvoi,
  FicheAgent,
  SqlJournalStore,
  FicheClient,
  FicheUnique,
  Rattachement,
  Reception,
  REPLY_PURPOSE,
  applyMigrations,
  contactKeys,
  fromSyncSqlite,
  type InboundChannel,
  type InboundKind,
  type InboundMessage,
  type SenderIdentifier,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Jeux inventés : aucune vraie personne, aucun vrai numéro, aucune vraie adresse.
// Mardi 1er décembre 2026, 11 h à Paris.
const NOW = new Date('2026-12-01T10:00:00.000Z');

let seq = 0;
function msg(
  channel: InboundChannel,
  kind: InboundKind,
  sender: { channelId?: string | null; name?: string | null; identifiers?: SenderIdentifier[] },
  text = 'Bonjour, je suis intéressé par le bien.',
  extra: Partial<InboundMessage> = {},
): InboundMessage {
  seq += 1;
  return {
    channel,
    kind,
    externalId: `ext-${seq}`,
    conversationRef: sender.channelId ?? `conv-${seq}`,
    sender: { channelId: sender.channelId ?? null, name: sender.name ?? null, identifiers: sender.identifiers ?? [] },
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
const phone = (value: string): SenderIdentifier => ({ kind: 'phone', value });
const wa = (value: string): SenderIdentifier => ({ kind: 'whatsapp', value });
const email = (value: string): SenderIdentifier => ({ kind: 'email', value });
const insta = (value: string): SenderIdentifier => ({ kind: 'instagram', value });

describeWithSqlite('C02 · rattacher chaque contact à sa fiche', () => {
  async function setup() {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const now = () => NOW;
    const store = new FicheClient(db, { now });
    const fiche = new FicheUnique(db, store, { now });
    const decisions = new DecisionEnvoi(db, store, fiche, { now });
    const reception = new Reception(db, undefined, now);
    const rattachement = new Rattachement(db, store, fiche, decisions, reception, { now });
    const network = await store.createNetwork('Réseau de test');
    const receive = async (m: InboundMessage): Promise<string> => {
      const [r] = (await reception.store(network.id, { messages: [m], unreadable: [], ignored: 0 })).received;
      return (r as { inboundId: string }).inboundId;
    };
    const countPersons = async () => Number((await db.first<{ n: number }>('SELECT count(*) AS n FROM persons'))?.n);
    return { db, store, fiche, decisions, reception, rattachement, network, receive, countPersons };
  }

  it('50 contacts inventés avec doublons connus : chaque message rejoint la bonne fiche, aucune fiche en double, moins d’une minute chacun', async () => {
    const t = await setup();
    // 10 contacts déjà en base, créés avant C02, avec des identifiants saisis à la main.
    const expected = new Map<number, string>();
    const old: string[] = [];
    for (let k = 0; k < 10; k++) {
      const p = await t.store.createPerson({ networkId: t.network.id, firstName: `Ancien${k}` });
      await t.fiche.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'phone', value: `06 00 00 09 ${String(k).padStart(2, '0')}` });
      old.push(p.id);
    }
    // Messages des 50 contacts, chaque contact sur plusieurs canaux quand il le peut.
    const messages: { contact: number; m: InboundMessage }[] = [];
    for (let i = 0; i < 50; i++) {
      const tel = `+3360000${String(100 + i).padStart(4, '0')}`;
      const mail = `contact${i}@exemple.test`;
      const user = `contact_${i}`;
      switch (i % 5) {
        case 0: // formulaire puis WhatsApp puis mail
          messages.push({ contact: i, m: msg('site', 'form', { name: `Prenom${i}`, identifiers: [phone(tel), email(mail)] }) });
          messages.push({ contact: i, m: msg('whatsapp', 'direct', { channelId: tel.slice(1), identifiers: [wa(tel)] }) });
          messages.push({ contact: i, m: msg('email', 'email', { identifiers: [email(mail.toUpperCase())] }) });
          break;
        case 1: // commentaire puis second commentaire, compte écrit autrement
          messages.push({ contact: i, m: msg('instagram', 'comment', { channelId: `IGC-${i}`, identifiers: [insta(user)] }, 'Prix ?') });
          messages.push({ contact: i, m: msg('instagram', 'comment', { channelId: `IGC-${i}`, identifiers: [insta(`@${user.toUpperCase()}`)] }, 'Dispo ?') });
          break;
        case 2: { // messages privés Instagram ou Messenger : seul l'identifiant propre au canal
          const channel = i % 2 === 0 ? 'instagram' : 'facebook';
          messages.push({ contact: i, m: msg(channel, 'direct', { channelId: `SID-${i}` }) });
          messages.push({ contact: i, m: msg(channel, 'direct', { channelId: `SID-${i}` }) });
          messages.push({ contact: i, m: msg(channel, 'direct', { channelId: `SID-${i}` }, 'Merci') });
          break;
        }
        case 3: // mail de portail, mail, formulaire qui ajoute le téléphone, puis WhatsApp
          messages.push({ contact: i, m: msg('email', 'portal_email', { identifiers: [email(mail)] }, 'Demande de visite', { portal: 'portail-test' }) });
          messages.push({ contact: i, m: msg('email', 'email', { identifiers: [email(` ${mail} `)] }) });
          messages.push({ contact: i, m: msg('site', 'form', { identifiers: [email(mail), phone(`0${tel.slice(3)}`)] }) });
          messages.push({ contact: i, m: msg('whatsapp', 'direct', { channelId: tel.slice(1), identifiers: [wa(tel)] }) });
          break;
        case 4: { // un contact déjà en base, connu par son téléphone, qui écrit sur WhatsApp
          const k = Math.floor(i / 5);
          messages.push({ contact: i, m: msg('whatsapp', 'direct', { channelId: `w${i}`, identifiers: [wa(`+336000009${String(k).padStart(2, '0')}`)] }) });
          expected.set(i, old[k] as string);
          break;
        }
      }
    }

    let slowest = 0;
    for (const { contact, m } of messages) {
      const id = await t.receive(m);
      const start = performance.now();
      const res = await t.rattachement.attach(id);
      slowest = Math.max(slowest, performance.now() - start);
      expect(res.outcome).not.toBeNull();
      const root = await t.fiche.rootOf(res.personId as string);
      if (!expected.has(contact)) expected.set(contact, root);
      expect(root, `contact ${contact}`).toBe(expected.get(contact));
      expect((await t.reception.get(id))?.status).toBe('processed');
    }
    // Une fiche par contact : 40 fiches créées et les 10 anciennes, qui portent les contacts « case 4 ».
    const roots = new Set(expected.values());
    expect(roots.size).toBe(50);
    expect(await t.countPersons()).toBe(50);
    expect(slowest).toBeLessThan(60_000);
    // Le formulaire a donné le prénom et les deux identifiants ; WhatsApp n'a pas créé de seconde fiche.
    const fiche0 = await t.fiche.view(expected.get(0) as string);
    expect(fiche0.person.first_name).toBe('Prenom0');
    expect(fiche0.messages).toHaveLength(3);
    expect(fiche0.identifiers.map((i) => `${i.kind}:${i.value}`).sort()).toEqual(
      ['email:contact0@exemple.test', 'phone:+33600000100', 'whatsapp:+33600000100'].sort(),
    );
    expect(fiche0.sources.map((s) => s.channel).sort()).toEqual(['email', 'site', 'whatsapp']);
  });

  it('la source et l’accord de réponse sont rattachés, avec la preuve : le message reçu', async () => {
    const t = await setup();
    const id = await t.receive(msg('site', 'form', { name: 'Zoé', identifiers: [phone('0600000200'), email('zoe@exemple.test')] }, 'Rappelez-moi', { propertyRef: 'REF-12' }));
    const res = await t.rattachement.attach(id);
    expect(res.outcome).toBe('created');
    const view = await t.fiche.view(res.personId as string);
    expect(view.sources).toHaveLength(1);
    expect(view.sources[0]?.detail).toBe('form · bien REF-12');
    expect(view.consents.map((c) => [c.channel, c.purpose, c.proof]).sort()).toEqual([
      ['email', REPLY_PURPOSE, `message reçu ${id}`],
      ['phone', REPLY_PURPOSE, `message reçu ${id}`],
    ]);
    const decision = await t.decisions.decide(res.personId as string, { channel: 'phone', kind: 'reply', conversationId: view.messages[0]?.conversation_id as string, at: NOW });
    expect(decision.allowed).toBe(true);
  });

  it('[R03] le formulaire « Être rappelé » ouvre l’appel ; passé 13 mois il le referme, et une nouvelle demande le rouvre', async () => {
    const t = await setup();
    const journal = new SqlJournalStore(t.db);
    const fiche = new FicheAgent(t.db, new Acces(t.db, t.store, t.fiche, journal, { now: () => NOW }), { now: () => NOW });
    const direction = { role: 'direction' as const, userId: 'dir-1', networkId: t.network.id };
    const old = new Date(NOW.getTime() - 420 * 86_400_000);
    const first = await t.rattachement.attach(await t.receive(msg('site', 'form', { name: 'Zoé', identifiers: [phone('0600000210')] }, 'Rappelez-moi', { receivedAt: old })));
    const personId = first.personId as string;
    const stale = await fiche.read(direction, personId);
    expect(stale.ok && stale.value).toMatchObject({ call: null, callRefusal: 'no_consent' });

    await t.rattachement.attach(await t.receive(msg('site', 'form', { name: 'Zoé', identifiers: [phone('0600000210')] }, 'Rappelez-moi encore')));
    const fresh = await fiche.read(direction, personId);
    expect(fresh.ok && fresh.value.callRefusal).toBeNull();
    expect(fresh.ok && fresh.value.call).toMatch(/^tel:/);
    expect((await t.fiche.view(personId)).consents.filter((c) => c.channel === 'phone')).toHaveLength(2);
  });

  it('[R204] après un refus noté, la même personne redemande à être rappelée : sa nouvelle demande rouvre l’appel', async () => {
    const t = await setup();
    const journal = new SqlJournalStore(t.db);
    const fiche = new FicheAgent(t.db, new Acces(t.db, t.store, t.fiche, journal, { now: () => NOW }), { now: () => NOW });
    const direction = { role: 'direction' as const, userId: 'dir-1', networkId: t.network.id };
    const before = new Date(NOW.getTime() - 30 * 86_400_000);
    const first = await t.rattachement.attach(await t.receive(msg('site', 'form', { name: 'Zoé', identifiers: [phone('0600000212')] }, 'Rappelez-moi', { receivedAt: before })));
    const personId = first.personId as string;
    await t.db.run("INSERT INTO call_notes (id, network_id, person_id, outcome, basis, noted_by, noted_at) VALUES ('n1', ?, ?, 'refused', 'request', 'agent:a', ?)", [t.network.id, personId, new Date(NOW.getTime() - 86_400_000).toISOString()]);
    const refused = await fiche.read(direction, personId);
    expect(refused.ok && refused.value).toMatchObject({ call: null, callRefusal: 'no_consent' });
    await t.rattachement.attach(await t.receive(msg('site', 'form', { name: 'Zoé', identifiers: [phone('0600000212')] }, 'Finalement, rappelez-moi')));
    const again = await fiche.read(direction, personId);
    expect(again.ok && again.value.callRefusal).toBeNull();
    expect(again.ok && again.value.call).toMatch(/^tel:/);
  });

  it('[R03] une demande récente n’ajoute pas de second accord', async () => {
    const t = await setup();
    const first = await t.rattachement.attach(await t.receive(msg('site', 'form', { name: 'Zoé', identifiers: [phone('0600000211')] }, 'Rappelez-moi')));
    await t.rattachement.attach(await t.receive(msg('site', 'form', { name: 'Zoé', identifiers: [phone('0600000211')] }, 'Rappelez-moi encore')));
    expect((await t.fiche.view(first.personId as string)).consents).toHaveLength(1);
  });

  it('[R02] une personne exclue qui écrit est reconnue et rien ne lui répond', async () => {
    const t = await setup();
    const p = await t.store.createPerson({ networkId: t.network.id });
    await t.fiche.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'email', value: 'exclue@exemple.test' });
    await t.store.addExclusion({ networkId: t.network.id, personId: p.id, reason: 'network_list', notedAt: new Date('2026-01-01T00:00:00Z') });
    const id = await t.receive(msg('email', 'email', { identifiers: [email('Exclue@Exemple.test')] }, 'Bonjour, le bien est-il disponible ?'));
    const res = await t.rattachement.attach(id);
    expect(res.personId).toBe(p.id);
    expect(res.outcome).toBe('matched');
    expect(res.silenced).toBe(true);
    const conversationId = (await t.fiche.view(p.id)).messages[0]?.conversation_id as string;
    const decision = await t.decisions.decide(p.id, { channel: 'email', kind: 'reply', conversationId, at: NOW });
    expect(decision).toMatchObject({ allowed: false, rule: 'R02' });
    expect((await t.rattachement.journal(id))[0]).toMatchObject({ outcome: 'matched', silenced: 1 });
  });

  it('[R02] fiches en double suivies par deux agents : rattaché à la plus ancienne, exclusion reprise, direction prévenue', async () => {
    const t = await setup();
    const a1 = await t.store.createAgent({ networkId: t.network.id, firstName: 'Agent', lastName: 'Un' });
    const a2 = await t.store.createAgent({ networkId: t.network.id, firstName: 'Agent', lastName: 'Deux' });
    const older = await t.store.createPerson({ networkId: t.network.id, agentId: a1.id });
    const newer = await t.store.createPerson({ networkId: t.network.id, agentId: a2.id });
    for (const p of [older, newer]) await t.fiche.addIdentifier({ networkId: t.network.id, agentId: p.agent_id, personId: p.id, kind: 'phone', value: '0600000300' });
    await t.store.addExclusion({ networkId: t.network.id, agentId: a2.id, personId: newer.id, reason: 'sold', notedAt: new Date('2026-11-01T00:00:00Z') });
    const id = await t.receive(msg('whatsapp', 'direct', { channelId: '33600000300', identifiers: [wa('+33600000300')] }, 'Bonjour'));
    const res = await t.rattachement.attach(id);
    expect(res).toMatchObject({ outcome: 'ambiguous', needsHuman: true, silenced: true });
    expect([older.id, newer.id]).toContain(res.personId);
    expect(res.personId).toBe([older, newer].sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id))[0]?.id);
    const conversationId = (await t.fiche.view(res.personId as string)).messages[0]?.conversation_id as string;
    expect(await t.decisions.decide(res.personId as string, { channel: 'whatsapp', kind: 'reply', conversationId, at: NOW })).toMatchObject({ allowed: false, rule: 'R02' });
  });

  it('fiches en double d’un même agent : réunies à la réception (S04, réversible)', async () => {
    const t = await setup();
    const p1 = await t.store.createPerson({ networkId: t.network.id });
    const p2 = await t.store.createPerson({ networkId: t.network.id });
    await t.fiche.addIdentifier({ networkId: t.network.id, personId: p1.id, kind: 'email', value: 'double@exemple.test' });
    await t.fiche.addIdentifier({ networkId: t.network.id, personId: p2.id, kind: 'phone', value: '0600000400' });
    const id = await t.receive(msg('site', 'form', { identifiers: [email('double@exemple.test'), phone('06 00 00 04 00')] }));
    const res = await t.rattachement.attach(id);
    expect(res.outcome).toBe('merged');
    expect(await t.fiche.rootOf(p1.id)).toBe(await t.fiche.rootOf(p2.id));
    expect(await t.countPersons()).toBe(2);
  });

  it('[R04] « stop » reçu sur un canal ferme tous les canaux, et ne donne aucun accord', async () => {
    const t = await setup();
    const first = await t.rattachement.attach(await t.receive(msg('site', 'form', { identifiers: [phone('0600000500'), email('arret@exemple.test')] })));
    const personId = first.personId as string;
    const id = await t.receive(msg('whatsapp', 'direct', { channelId: '33600000500', identifiers: [wa('+33600000500')] }, 'STOP'));
    const res = await t.rattachement.attach(id);
    expect(res).toMatchObject({ personId, exclusion: 'stop', silenced: true });
    const view = await t.fiche.view(personId);
    expect(view.consents.some((c) => c.channel === 'whatsapp')).toBe(false);
    for (const channel of ['email', 'phone', 'whatsapp', 'instagram'] as const) {
      const decision = await t.decisions.decide(personId, { channel, kind: 'reply', conversationId: view.messages[0]?.conversation_id as string, at: NOW });
      expect(decision, channel).toMatchObject({ allowed: false, rule: 'R04' });
    }
    expect((await t.rattachement.journal(id))[0]).toMatchObject({ exclusion: 'stop', silenced: 1 });
  });

  it('[R18] un même message rattaché deux fois, même en même temps, ne l’est qu’une fois', async () => {
    const t = await setup();
    const m = msg('instagram', 'direct', { channelId: 'IGSID-900' });
    const id = await t.receive(m);
    expect(await t.receive(m)).toBe(id);
    const [a, b] = await Promise.all([t.rattachement.attach(id), t.rattachement.attach(id)]);
    expect([a.outcome, b.outcome].filter((o) => o === null)).toHaveLength(1);
    const personId = (a.personId ?? b.personId) as string;
    expect((await t.fiche.view(personId)).messages).toHaveLength(1);
    expect(await t.countPersons()).toBe(1);
  });

  it('deux messages simultanés d’une même personne inconnue : une seule fiche gardée', async () => {
    const t = await setup();
    const id1 = await t.receive(msg('site', 'form', { identifiers: [phone('0600000600')] }));
    const id2 = await t.receive(msg('whatsapp', 'direct', { channelId: '33600000600', identifiers: [wa('+33600000600')] }));
    const [a, b] = await Promise.all([t.rattachement.attach(id1), t.rattachement.attach(id2)]);
    const rootA = await t.fiche.rootOf(a.personId as string);
    expect(await t.fiche.rootOf(b.personId as string)).toBe(rootA);
    expect((await t.fiche.view(rootA)).messages).toHaveLength(2);
    expect((await t.fiche.findDuplicateGroups(t.network.id))).toEqual([]);
  });

  it('une erreur pendant le rattachement rend le message, qui sera repris', async () => {
    const t = await setup();
    const id = await t.receive(msg('email', 'email', { identifiers: [email('panne@exemple.test')] }));
    const flakyStore = Object.create(t.store) as FicheClient;
    flakyStore.recordMessage = async () => {
      throw new Error('panne');
    };
    const broken = new Rattachement(t.db, flakyStore, t.fiche, t.decisions, t.reception, { now: () => NOW });
    await expect(broken.attach(id)).rejects.toThrow('panne');
    expect((await t.reception.get(id))?.status).toBe('received');
    const [res] = await t.rattachement.attachPending(t.network.id);
    expect(res?.inboundId).toBe(id);
    expect((await t.reception.get(id))?.status).toBe('processed');
    expect(await t.countPersons()).toBe(1);
  });

  it('[R13] le journal du rattachement ne contient aucune donnée personnelle', async () => {
    const t = await setup();
    const id = await t.receive(msg('site', 'form', { name: 'Prénomsecret', identifiers: [phone('0600000700'), email('secret@exemple.test')] }, 'Texte privé du client'));
    await t.rattachement.attach(id);
    const rows = JSON.stringify(await t.rattachement.journal(id));
    for (const secret of ['Prénomsecret', '600000700', 'secret@exemple', 'Texte privé']) expect(rows).not.toContain(secret);
  });

  it('les clés de contact : identifiants normalisés et identifiant propre au canal, WhatsApp et téléphone confondus', () => {
    const keys = contactKeys({ channel: 'whatsapp', kind: 'direct', sender_channel_id: '33600000800', sender_identifiers: JSON.stringify([wa('+33600000800'), email('X@Exemple.test'), insta('pas valable !')]) });
    expect(keys).toEqual(['email:x@exemple.test', 'phone:+33600000800', 'whatsapp:direct:33600000800']);
  });

  it('[R04] « stop » sur des fiches suivies par deux agents : toutes les fiches de la personne sont fermées', async () => {
    const t = await setup();
    const a1 = await t.store.createAgent({ networkId: t.network.id, firstName: 'Agent', lastName: 'Un' });
    const a2 = await t.store.createAgent({ networkId: t.network.id, firstName: 'Agent', lastName: 'Deux' });
    const p1 = await t.store.createPerson({ networkId: t.network.id, agentId: a1.id });
    const p2 = await t.store.createPerson({ networkId: t.network.id, agentId: a2.id });
    for (const p of [p1, p2]) await t.fiche.addIdentifier({ networkId: t.network.id, agentId: p.agent_id, personId: p.id, kind: 'email', value: 'deux@exemple.test' });
    const res = await t.rattachement.attach(await t.receive(msg('email', 'email', { identifiers: [email('deux@exemple.test')] }, 'Stop, ne plus me contacter')));
    expect(res).toMatchObject({ outcome: 'ambiguous', exclusion: 'stop', silenced: true, needsHuman: true });
    for (const p of [p1, p2]) {
      await t.store.addConsent({ networkId: t.network.id, agentId: p.agent_id, personId: p.id, purpose: 'alert', channel: 'email', proof: 'test', givenAt: new Date('2026-01-01T00:00:00Z') });
      expect(await t.decisions.decide(p.id, { channel: 'email', kind: 'alert', at: NOW }), p.id).toMatchObject({ allowed: false, rule: 'R04' });
    }
  });

  it('[R18] une panne après le rangement du message : la reprise ne range pas le message une seconde fois', async () => {
    const t = await setup();
    const id = await t.receive(msg('whatsapp', 'direct', { channelId: '33600000900', identifiers: [wa('+33600000900')] }, 'STOP'));
    const flaky = Object.create(t.decisions) as DecisionEnvoi;
    flaky.recordExclusion = async () => {
      throw new Error('panne');
    };
    const broken = new Rattachement(t.db, t.store, t.fiche, flaky, t.reception, { now: () => NOW });
    await expect(broken.attach(id)).rejects.toThrow('panne');
    expect((await t.reception.get(id))?.status).toBe('received');
    const res = await t.rattachement.attach(id);
    const view = await t.fiche.view(res.personId as string);
    expect(view.messages).toHaveLength(1);
    expect(res).toMatchObject({ exclusion: 'stop', silenced: true });
    expect(await t.countPersons()).toBe(1);
  });

  it('[R18] un message pris puis abandonné sans erreur (traitement coupé net) est repris après 10 minutes, une seule fois', async () => {
    const t = await setup();
    const id = await t.receive(msg('email', 'email', { identifiers: [email('coupe@exemple.test')] }));
    let clock = NOW;
    const r = new Rattachement(t.db, t.store, t.fiche, t.decisions, t.reception, { now: () => clock });
    expect(await t.reception.claim(id)).toBe(true); // pris, puis plus rien : le Worker a été arrêté
    expect(await r.attachPending(t.network.id)).toEqual([]);
    clock = new Date(NOW.getTime() + 11 * 60_000);
    const [res] = await r.attachPending(t.network.id);
    expect(res).toMatchObject({ inboundId: id, outcome: 'created' });
    expect(await r.attachPending(t.network.id)).toEqual([]);
    expect((await t.fiche.view(res?.personId as string)).messages).toHaveLength(1);
  });
});
