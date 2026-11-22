import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { mailboxesFromEnv, parseMailboxTokens, runMailboxPass, type BoiteEnv } from '../src/boite.ts';
import { boiteOf } from '../src/worker.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../../core/src/index.ts';
import { REFRESH, SECRET, fakeGmail, fakeOutlook, type FakeMail } from '../../core/test/boite-serveurs.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Le mardi 24 novembre 2026, 10 h à Paris. Réseau, agents, clients, jetons, clés d'API et mails inventés.
const NOW = new Date('2026-11-24T09:00:00.000Z');
const DAY = 86_400_000;
const KEYS = {
  alex: 'test-cle-au043-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  lea: 'test-cle-au043-lea-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-au043-direction-ccccccccccccccccccccc',
};
type Who = keyof typeof KEYS;
const GOOGLE_ID = '123-abc.apps.googleusercontent.com';
const MS_ID = '00000000-0000-4000-8000-000000000001';

it('aucune boîte sans mise en service complète [R683]', () => {
  const h = fakeGmail([]).http;
  const full: BoiteEnv = { BOITE_MODE: 'reel', BOITE_GOOGLE_CLIENT_ID: GOOGLE_ID, BOITE_GOOGLE_CLIENT_SECRET: SECRET, BOITE_JETONS: JSON.stringify({ 'agent-1': { gmail: REFRESH } }) };
  expect(mailboxesFromEnv(full, h)?.of('agent-1').map((p) => p.provider)).toEqual(['gmail']);
  expect(mailboxesFromEnv(full, h)?.of('agent-2')).toEqual([]);
  expect(mailboxesFromEnv({ ...full, BOITE_MODE: undefined }, h)).toBeNull();
  expect(mailboxesFromEnv({ ...full, BOITE_MODE: 'essai' }, h)).toBeNull();
  expect(mailboxesFromEnv({ ...full, BOITE_GOOGLE_CLIENT_ID: 'pas-un-client' }, h)).toBeNull();
  expect(mailboxesFromEnv({ ...full, BOITE_GOOGLE_CLIENT_SECRET: ' ' }, h)).toBeNull();
  expect(mailboxesFromEnv({ ...full, BOITE_JETONS: undefined }, h)).toBeNull();
  expect(mailboxesFromEnv({ ...full, BOITE_JETONS: 'pas du JSON' }, h)).toBeNull();
  // Outlook seul, avec un annuaire mal formé : rien.
  const ms: BoiteEnv = { BOITE_MODE: 'reel', BOITE_MICROSOFT_CLIENT_ID: MS_ID, BOITE_MICROSOFT_CLIENT_SECRET: SECRET, BOITE_JETONS: JSON.stringify({ 'agent-1': { outlook: REFRESH } }) };
  expect(mailboxesFromEnv(ms, h)?.of('agent-1').map((p) => p.provider)).toEqual(['outlook']);
  expect(mailboxesFromEnv({ ...ms, BOITE_MICROSOFT_TENANT: 'a/b' }, h)).toBeNull();
  // Les deux, et une entrée mal formée écartée sans être devinée.
  const both = mailboxesFromEnv({ ...full, ...ms, BOITE_JETONS: JSON.stringify({ 'agent-1': { gmail: REFRESH, outlook: REFRESH }, 'agent 2': { gmail: REFRESH }, 'agent-3': { gmail: 'court' } }) }, h);
  expect(both?.of('agent-1').map((p) => p.provider)).toEqual(['gmail', 'outlook']);
  expect(both?.agents()).toEqual(['agent-1']);
  expect(parseMailboxTokens('[1]').gmail.size).toBe(0);
  // Le Worker : sans `BOITE_MODE`, aucune boîte ; sans `PIECES`, aucun rangement.
  expect(boiteOf({ ...full } as never)).toEqual({ mailboxes: expect.anything(), files: null });
  expect(boiteOf({} as never)).toEqual({ mailboxes: null, files: null });
});

async function setup(mails: FakeMail[], options: { gmail?: boolean; outlookMails?: FakeMail[]; files?: boolean } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = () => NOW;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const net = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: net.id, firstName: 'Alex', lastName: 'Agent' });
  const lea = await store.createAgent({ networkId: net.id, firstName: 'Léa', lastName: 'Agent' });
  const camille = await store.createPerson({ networkId: net.id, agentId: alex.id, firstName: 'Camille' });
  await store.addIdentifier({ networkId: net.id, personId: camille.id, kind: 'email', value: 'camille@exemple.test' });
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: alex.id },
    lea: { role: 'agent', userId: lea.id },
    direction: { role: 'direction', userId: 'direction-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: net.id, ...ids[w] }))));
  const gmail = fakeGmail(mails);
  const outlook = fakeOutlook(options.outlookMails ?? []);
  const http = (url: string, init?: Parameters<typeof gmail.http>[1]) => (url.includes('microsoft') ? outlook.http(url, init) : gmail.http(url, init));
  const tokens: Record<string, Record<string, string>> = { [alex.id]: { ...(options.gmail === false ? {} : { gmail: REFRESH }), ...(options.outlookMails ? { outlook: REFRESH } : {}) } };
  const mailboxes = mailboxesFromEnv(
    { BOITE_MODE: 'reel', BOITE_GOOGLE_CLIENT_ID: GOOGLE_ID, BOITE_GOOGLE_CLIENT_SECRET: SECRET, BOITE_MICROSOFT_CLIENT_ID: MS_ID, BOITE_MICROSOFT_CLIENT_SECRET: SECRET, BOITE_JETONS: JSON.stringify(tokens) },
    http,
  );
  const puts: string[] = [];
  const files = options.files === false ? null : { put: async (key: string) => void puts.push(key) };
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now, boite: { mailboxes, files } };
  const call = async (who: Who, method: 'GET' | 'POST', path: string) => {
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers: { authorization: `Bearer ${KEYS[who]}` } }), config);
    return { status: r.status, body: (await r.json()) as any };
  };
  const events = async () => (await db.all<{ type: string; data: string }>('SELECT type, data FROM journal ORDER BY seq')).map((e) => ({ type: e.type, data: JSON.parse(e.data) as Record<string, unknown> }));
  return { db, journal, now, net, alex, lea, camille, call, gmail, outlook, puts, mailboxes, files, events };
}

const PDF = new TextEncoder().encode('%PDF-1.4\n% compromis inventé\n%%EOF');

describeWithSqlite('AU043 · la vraie boîte de l’agent dans sa file [R683, R408, R16]', () => {
  it('après l’accord, un mail reçu dans la boîte Gmail apparaît dans la file de l’agent, rattaché à sa fiche et au fil de son message d’origine', async () => {
    const t = await setup([
      { id: 'g-1', threadId: 'fil-1', at: new Date(NOW.getTime() - DAY), from: 'Camille@Exemple.test', text: 'Bonjour, voici le compromis signé.', attachments: [{ name: 'compromis.pdf', type: 'application/pdf', bytes: PDF }] },
      { id: 'g-2', threadId: 'fil-2', at: new Date(NOW.getTime() - DAY / 2), from: 'inconnu@exemple.test', text: 'Publicité.' },
    ]);
    // Avant la lecture : la file est vide, la boîte est dite reliée.
    expect((await t.call('alex', 'GET', '/boite')).body.data).toEqual({ reliees: ['gmail'], mails: [] });
    const read = await t.call('alex', 'POST', '/boite/lecture');
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual([{ provider: 'gmail', ok: true, lus: 2, rattaches: 1, code: null }]);
    const file = (await t.call('alex', 'GET', '/boite')).body.data;
    expect(file.mails).toHaveLength(2);
    const known = file.mails.find((m: any) => m.status === 'rattache');
    expect(known).toMatchObject({ provider: 'gmail', personId: t.camille.id, conversationId: 'email:gmail:fil-1', receivedAt: new Date(NOW.getTime() - DAY).toISOString() });
    const message = await t.db.first<{ person_id: string; conversation_id: string; body: string; direction: string }>('SELECT person_id, conversation_id, body, direction FROM messages WHERE id = ?', [known.messageId]);
    expect(message).toEqual({ person_id: t.camille.id, conversation_id: 'email:gmail:fil-1', body: 'Bonjour, voici le compromis signé.', direction: 'in' });
    // L'inconnu ne garde que sa clé : aucune fiche, aucun message [R408].
    expect(file.mails.find((m: any) => m.status === 'inconnu')).toMatchObject({ personId: null, messageId: null, conversationId: null });
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM persons'))!.n).toBe(1);
    // Relu : rien de plus [R18].
    const again = await t.call('alex', 'POST', '/boite/lecture');
    expect(again.body.data[0]).toMatchObject({ ok: true, rattaches: 0 });
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM messages'))!.n).toBe(1);
    // Au journal : ni adresse, ni texte, ni jeton [R13].
    const log = JSON.stringify(await t.events());
    for (const s of ['exemple.test', 'compromis', REFRESH, SECRET]) expect(log).not.toContain(s);
    expect((await t.events()).filter((e) => e.type === 'boite.lecture').map((e) => e.data)).toEqual([
      { rule: 'R683', provider: 'gmail', ok: true, lus: 2, rattaches: 1, code: null },
      { rule: 'R683', provider: 'gmail', ok: true, lus: 1, rattaches: 0, code: null },
    ]);
  });

  it('Outlook aussi : la réception et les envoyés, dans la conversation de leur fil', async () => {
    const t = await setup([], {
      gmail: true,
      outlookMails: [{ id: 'o-1', threadId: 'conv-1', at: new Date(NOW.getTime() - DAY), from: 'camille@exemple.test', text: 'Merci pour la visite.' }],
    });
    const r = await t.call('alex', 'POST', '/boite/lecture');
    expect(r.body.data.map((x: any) => [x.provider, x.ok, x.rattaches])).toEqual([
      ['gmail', true, 0],
      ['outlook', true, 1],
    ]);
    const file = (await t.call('alex', 'GET', '/boite')).body.data;
    expect(file.reliees).toEqual(['gmail', 'outlook']);
    expect(file.mails[0]).toMatchObject({ provider: 'outlook', conversationId: 'email:outlook:conv-1', personId: t.camille.id });
  });

  it('une panne du service est dite par son code, en français, et au journal sans rien de la réponse', async () => {
    const t = await setup([]);
    // L'accord est retiré chez Google : le jeton de rafraîchissement est refusé.
    const mailboxes = mailboxesFromEnv(
      { BOITE_MODE: 'reel', BOITE_GOOGLE_CLIENT_ID: GOOGLE_ID, BOITE_GOOGLE_CLIENT_SECRET: SECRET, BOITE_JETONS: JSON.stringify({ [t.alex.id]: { gmail: 'jeton-retire-invente-000000' } }) },
      t.gmail.http,
    );
    const reads = await runMailboxPass({ db: t.db, journal: t.journal, now: t.now, mailboxes, files: t.files });
    expect(reads).toEqual([{ agentId: t.alex.id, reads: [{ provider: 'gmail', ok: false, lus: 0, rattaches: 0, code: 'connexion' }] }]);
    expect(JSON.stringify(await t.events())).not.toContain('jeton-retire');
  });

  it('le passage des quarts d’heure lit la boîte de chaque agent en activité qui l’a reliée, jamais celle d’un agent parti', async () => {
    const t = await setup([{ id: 'g-1', threadId: 'fil-1', at: new Date(NOW.getTime() - DAY), from: 'camille@exemple.test', text: 'Bonjour.' }]);
    const reads = await runMailboxPass({ db: t.db, journal: t.journal, now: t.now, mailboxes: t.mailboxes, files: t.files });
    expect(reads).toEqual([{ agentId: t.alex.id, reads: [{ provider: 'gmail', ok: true, lus: 1, rattaches: 1, code: null }] }]);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    expect(await runMailboxPass({ db: t.db, journal: t.journal, now: t.now, mailboxes: t.mailboxes, files: t.files })).toEqual([]);
    expect(await runMailboxPass({ db: t.db, journal: t.journal, now: t.now, mailboxes: null, files: t.files })).toEqual([]);
  });

  it('refus : la direction, un agent sans boîte reliée, le rangement absent, un paramètre [R16, R683]', async () => {
    const t = await setup([]);
    const dir = await t.call('direction', 'GET', '/boite');
    expect(dir.status).toBe(403);
    expect(dir.body).toMatchObject({ rule: 'R16', code: 'role' });
    expect((await t.call('direction', 'POST', '/boite/lecture')).status).toBe(403);
    const lea = await t.call('lea', 'POST', '/boite/lecture');
    expect(lea.status).toBe(409);
    expect(lea.body).toMatchObject({ rule: 'R683', code: 'boite_non_reliee', message: "Votre boîte mail n'est pas encore reliée à AIMMO : rien n'est lu." });
    expect((await t.call('lea', 'GET', '/boite')).body.data).toMatchObject({ reliees: [], mails: [] });
    expect((await t.call('alex', 'GET', '/boite?x=1')).body).toMatchObject({ code: 'unknown_field', field: 'x' });
    const noFiles = await setup([], { files: false });
    const r = await noFiles.call('alex', 'POST', '/boite/lecture');
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('stockage_indisponible');
    expect(noFiles.gmail.calls).toHaveLength(0);
    // Les mails d'Alex ne sont jamais montrés à Léa.
    const t2 = await setup([{ id: 'g-1', threadId: 'fil-1', at: new Date(NOW.getTime() - DAY), from: 'camille@exemple.test', text: 'Bonjour.' }]);
    await t2.call('alex', 'POST', '/boite/lecture');
    expect((await t2.call('lea', 'GET', '/boite')).body.data.mails).toEqual([]);
  });
});
