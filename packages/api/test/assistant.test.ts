import { expect, it } from 'vitest';
import { FicheClient, SiteSessionChannel, SqlJournalStore, applyMigrations, createCaptation, verifyChain, type ReplyWriter, type SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex, type AssistantLimits } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clés et visiteurs inventés pour les tests, jamais utilisés ailleurs.
const KEY_CHAT = 'test-cle-assistant-site-cccccccccccccccccccccc';
const KEY_FORM = 'test-cle-depot-formulaire-ffffffffffffffffffff';
const BASE = 'https://aimmo-api.example.workers.dev';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Un mardi à 10 h et un dimanche à 23 h, heure de Paris.
const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const SUNDAY_23H = Date.parse('2026-12-06T22:00:00.000Z');
// Une adresse de documentation (RFC 5737) et un navigateur inventé : ils ne doivent être rangés nulle part [R15].
const VISITOR_IP = '203.0.113.77';
const USER_AGENT = 'NavigateurInvente/9.9';

// Une annonce inventée : avec un bien reconnu, la fausse IA rédige [R20].
const PROPERTY_REF = 'MAISON-ESSAI';

const visitor = (i: number): string => `visiteur-essai-${String(i).padStart(4, '0')}-abcdef`;

// Une fausse IA : une réponse différente à chaque message, sans chiffre ni question de trop.
const PHRASES = ['C’est noté, merci.', 'Très bien, je transmets.', 'Entendu, merci pour la précision.', 'Bien reçu, merci.', 'Parfait, c’est noté.'];
function fakeWriter(): ReplyWriter {
  let n = 0;
  return { write: async () => PHRASES[n++ % PHRASES.length]! };
}

async function world(limits?: AssistantLimits, writer?: ReplyWriter) {
  const db: SqlDatabase = fromD1(fakeD1(openMemoryDatabase()));
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  await store.createProperty({ networkId: network.id, agentId: agent.id, reference: PROPERTY_REF, kind: 'home', city: 'Dijon', status: 'available' });
  const intakeKeys = JSON.stringify([
    { sha256: await sha256Hex(KEY_CHAT), networkId: network.id, source: 'site_chat' },
    { sha256: await sha256Hex(KEY_FORM), networkId: network.id, source: 'site_form' },
  ]);
  const config = { db, apiKeys: undefined, intakeKeys, mode: 'essai', now, ...(limits ? { assistantLimits: limits } : {}), ...(writer ? { writer } : {}) };
  const call = (path: string, body: unknown, key: string | null = KEY_CHAT) =>
    handleRequest(
      new Request(`${BASE}/v1${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': VISITOR_IP,
          'user-agent': USER_AGENT,
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
      }),
      config,
    );
  const open = async (visitorId: string): Promise<string> => {
    const response = await call('/assistant/sessions', { visitorId });
    expect(response.status).toBe(201);
    return ((await response.json()) as { sessionId: string }).sessionId;
  };
  const say = (sessionId: string, visitorId: string, messageId: string, text: string, extra: Record<string, unknown> = {}) =>
    call(`/assistant/sessions/${sessionId}/messages`, { visitorId, messageId, text, ...extra });
  const replies = () =>
    db.all<{ message_id: string; created_at: string; body: string; conversation_id: string }>(
      `SELECT t.message_id, t.created_at, m.body, m.conversation_id FROM trial_outbox t JOIN messages m ON m.id = t.message_id
       WHERE t.channel = 'site' ORDER BY t.rowid`,
    );
  return {
    db,
    network,
    call,
    open,
    say,
    replies,
    journal: new SqlJournalStore(db),
    setClock: (t: number) => {
      clock = t;
    },
  };
}

const MENTION = /^Réponse immédiate de l’assistant IA/;

describeWithSqlite('C08 · API de l’assistant du site, en mode essai', () => {
  it('[R06] 20 messages, de jour comme de nuit : chacun a sa réponse prête en moins d’une minute, mention au premier, rien ne part', async () => {
    const w = await world();
    for (let i = 0; i < 20; i += 1) {
      const at = (i % 2 === 0 ? TUESDAY_10H : SUNDAY_23H) + i * MINUTE;
      w.setClock(at);
      const id = visitor(i);
      const session = await w.open(id);
      const response = await w.say(session, id, 'm1', i % 3 === 0 ? 'Bonjour, la maison est-elle toujours disponible ?' : 'Bonjour, je voudrais faire estimer mon appartement.');
      expect(response.status, `message ${i}`).toBe(200);
      // En mode essai, la réponse est prête mais n'est pas rendue au visiteur.
      expect(await response.json()).toEqual({ ok: true, mode: 'essai', sent: false, status: 'ready', reply: null });
      const all = await w.replies();
      expect(all, `message ${i}`).toHaveLength(i + 1);
      const last = all[i]!;
      expect(Date.parse(last.created_at) - at).toBeLessThan(MINUTE);
      expect(last.conversation_id).toBe(`site:${session}`);
      expect(last.body).toMatch(MENTION);
    }
    const channels = await w.db.all<{ channel: string }>('SELECT DISTINCT channel FROM trial_outbox');
    expect(channels).toEqual([{ channel: 'site' }]);
    const entries = await w.journal.all();
    expect(entries.filter((e) => e.type === 'envoi.essai')).toHaveLength(20);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('[R06] la mention n’est que dans le premier message automatique de la conversation', async () => {
    const w = await world(undefined, fakeWriter());
    const id = visitor(1);
    const session = await w.open(id);
    await w.say(session, id, 'm1', 'Bonjour, cette maison est-elle encore disponible ?', { propertyRef: PROPERTY_REF });
    w.setClock(TUESDAY_10H + MINUTE);
    const second = await w.say(session, id, 'm2', 'Je cherche aussi un appartement, pouvez-vous me rappeler ?');
    expect(((await second.json()) as { status: string }).status).toBe('ready');
    const [first, next] = await w.replies();
    expect(first!.body).toMatch(MENTION);
    expect(next!.body).not.toMatch(/assistant|IA\b/);
  });

  it('[R15] une conversation sans accord ne laisse rien au-delà de ce que la personne a écrit : ni adresse IP, ni navigateur, ni identifiant en clair', async () => {
    const w = await world();
    const id = visitor(7);
    const session = await w.open(id);
    await w.say(session, id, 'm1', 'Bonjour, quel est le quartier de ce bien ?', { page: '/biens/maison-essai' });
    await w.say(session, id, 'm2', 'Merci beaucoup.');
    const tables = await w.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    let dump = '';
    for (const { name } of tables) dump += JSON.stringify(await w.db.all(`SELECT * FROM "${name}"`));
    for (const forbidden of [VISITOR_IP, USER_AGENT, id]) expect(dump).not.toContain(forbidden);
    // La fiche du visiteur : aucun nom, aucune coordonnée ; seulement ses messages et nos réponses.
    const persons = await w.db.all<{ id: string; first_name: string | null; last_name: string | null }>('SELECT id, first_name, last_name FROM persons');
    expect(persons).toHaveLength(1);
    expect(persons[0]).toMatchObject({ first_name: null, last_name: null });
    expect(await w.db.all('SELECT * FROM person_identifiers')).toEqual([]);
    expect(await w.db.all('SELECT * FROM consents')).toEqual([]);
    const written = await w.db.all<{ body: string }>("SELECT body FROM messages WHERE direction = 'in' ORDER BY occurred_at, rowid");
    expect(written.map((m) => m.body)).toEqual(['Bonjour, quel est le quartier de ce bien ?', 'Merci beaucoup.']);
  });

  it('[R18] le même message reçu deux fois ne donne qu’une réponse', async () => {
    const w = await world();
    const id = visitor(2);
    const session = await w.open(id);
    await w.say(session, id, 'm1', 'Bonjour, je souhaite vendre ma maison.');
    const again = await w.say(session, id, 'm1', 'Bonjour, je souhaite vendre ma maison.');
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe('none');
    expect(await w.replies()).toHaveLength(1);
  });

  it('[R12] sans IA branchée, un deuxième message qui recevrait le même texte de secours passe à l’agent, jamais un silence', async () => {
    const w = await world();
    const id = visitor(10);
    const session = await w.open(id);
    await w.say(session, id, 'm1', 'Bonjour, je cherche un appartement.');
    const second = await w.say(session, id, 'm2', 'Avec un balcon de préférence.');
    expect(((await second.json()) as { status: string }).status).toBe('with_agent');
    expect(await w.replies()).toHaveLength(1);
    const alerts = await w.db.all<{ n: number }>("SELECT count(*) AS n FROM agent_alerts");
    expect(Number(alerts[0]!.n)).toBeGreaterThan(0);
  });

  it('[R21] une conversation passée à l’agent : l’assistant se tait, l’agent est prévenu', async () => {
    const w = await world(undefined, fakeWriter());
    const id = visitor(3);
    const session = await w.open(id);
    await w.say(session, id, 'm1', 'Bonjour, cette maison est-elle encore disponible ?', { propertyRef: PROPERTY_REF });
    const { relais } = createCaptation(w.db, w.journal);
    const person = await w.db.first<{ person_id: string }>('SELECT person_id FROM inbound_messages LIMIT 1');
    await relais.appointmentBooked(person!.person_id, `site:${session}`);
    w.setClock(TUESDAY_10H + MINUTE);
    const after = await w.say(session, id, 'm2', 'Je cherche aussi un appartement, pouvez-vous me rappeler ?');
    expect(((await after.json()) as { status: string }).status).toBe('with_agent');
    expect(await w.replies()).toHaveLength(1);
  });

  it('appels limités par visiteur : conversations ouvertes, messages par visiteur et par conversation, puis l’heure suivante de nouveau', async () => {
    const w = await world({ sessionsPerVisitor: 2, messagesPerVisitor: 3, messagesPerSession: 2 });
    const id = visitor(4);
    const a = await w.open(id);
    const b = await w.open(id);
    const third = await w.call('/assistant/sessions', { visitorId: id });
    expect(third.status).toBe(429);
    // Un autre visiteur n'est pas touché par la limite du premier.
    expect((await w.call('/assistant/sessions', { visitorId: visitor(5) })).status).toBe(201);

    expect((await w.say(a, id, 'a1', 'Bonjour, une question sur un bien.')).status).toBe(200);
    expect((await w.say(a, id, 'a2', 'Il a un garage ?')).status).toBe(200);
    expect((await w.say(a, id, 'a3', 'Et une cave ?')).status).toBe(429); // 2 par conversation
    expect((await w.say(b, id, 'b1', 'Bonjour, autre question.')).status).toBe(429); // 3 par visiteur, places prises
    w.setClock(TUESDAY_10H + HOUR);
    expect((await w.say(b, id, 'b1', 'Bonjour, autre question.')).status).toBe(200);
    // Un appel refusé par la limite ne range rien : seuls les trois messages admis sont dans la fiche.
    expect(await w.db.all("SELECT id FROM inbound_messages")).toHaveLength(3);
  });

  it('une clé sert à sa seule source, et une conversation n’appartient qu’à son visiteur', async () => {
    const w = await world();
    const id = visitor(6);
    expect((await w.call('/assistant/sessions', { visitorId: id }, null)).status).toBe(401);
    expect((await w.call('/assistant/sessions', { visitorId: id }, KEY_FORM)).status).toBe(401);
    // La clé de l'assistant ne dépose pas de formulaire.
    expect((await w.call('/captation/formulaire', { submissionId: 'f1', email: 'alix@example.test', message: 'Rappel' })).status).toBe(401);
    // visitorId : un identifiant opaque, jamais une adresse.
    expect((await w.call('/assistant/sessions', { visitorId: 'alix@example.test' })).status).toBe(400);

    const session = await w.open(id);
    expect((await w.say(session, visitor(8), 'm1', 'Bonjour')).status).toBe(404);
    expect((await w.say('0'.repeat(64), id, 'm1', 'Bonjour')).status).toBe(404);
    expect((await w.say(session, id, 'm1', 'x'.repeat(2001))).status).toBe(400);
    expect(await w.replies()).toHaveLength(0);
  });

  it('[R06] hors essai, la réponse passée par le contrôle central est remise à la session du visiteur, et à elle seule', async () => {
    const w = await world();
    const site = new SiteSessionChannel();
    const { chaine } = createCaptation(w.db, w.journal, { channels: [site] });
    const [result] = await chaine.receive(w.network.id, 'site_chat', { sessionId: 'session-a', messageId: 'm1', text: 'Bonjour, je voudrais vendre ma maison.' });
    expect(result).toMatchObject({ status: 'replied' });
    const delivered = site.take('session-a');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(MENTION);
    expect(site.take('session-a')).toEqual([]);
    // Rien dans la boîte d'essai, et rien pour une autre session.
    expect(await w.db.all('SELECT * FROM trial_outbox')).toEqual([]);
    expect(site.take('session-b')).toEqual([]);
  });

  it('hors mode essai, l’assistant est fermé', async () => {
    const w = await world();
    const response = await handleRequest(
      new Request(`${BASE}/v1/assistant/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY_CHAT}` },
        body: JSON.stringify({ visitorId: visitor(9) }),
      }),
      { db: w.db, apiKeys: undefined, intakeKeys: undefined, mode: 'reel' },
    );
    expect(response.status).toBe(503);
  });
});
