import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeChannel, FicheClient, ReconnaissanceBien, SqlJournalStore, applyMigrations, createCaptation, verifyChain, type SqlDatabase } from '@aimmo/core';
import { MAX_META_BYTES, handleRequest, sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Secrets inventés pour les tests, jamais utilisés ailleurs.
const APP_SECRET = 'secret-application-meta-de-test-0000000000';
const OTHER_SECRET = 'autre-secret-qui-n-est-pas-le-notre-000000';
const VERIFY_TOKEN = 'jeton-de-verification-meta-test-111111111';
const BASE = 'https://aimmo-api.example.workers.dev';
const URL_META = `${BASE}/v1/meta/notifications`;
const MINUTE = 60_000;
// Un mardi à 10 h et un dimanche à 23 h, heure de Paris.
const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const SUNDAY_23H = Date.parse('2026-12-06T22:00:00.000Z');

// Nos comptes inventés : page Facebook, compte Instagram, numéro WhatsApp, application AIMMO.
const PAGE_ID = '900000000000001';
const IG_ID = '178400000000001';
const WA_PHONE_ID = '100000000000001';
const OUR_APP = '555000000000001';
const MANYCHAT_LIKE_APP = '777000000000001';

const PROPERTIES = [
  { ref: '501', price: 189_000, surface: 64, area: 'Montchapet', post: 'video-501', fbPost: `${PAGE_ID}_501` },
  { ref: '502', price: 312_000, surface: 97, area: 'Chevreul', post: 'video-502', fbPost: `${PAGE_ID}_502` },
  { ref: '503', price: 254_000, surface: 78, area: 'Port du Canal', post: 'video-503', fbPost: `${PAGE_ID}_503` },
];

const sign = (body: string, secret = APP_SECRET): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

async function world(overrides: { mode?: string; appSecret?: string | undefined; networkId?: string | null } = {}) {
  const db: SqlDatabase = fromD1(fakeD1(openMemoryDatabase()));
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const biens = new ReconnaissanceBien(db);
  for (const p of PROPERTIES) {
    const home = await store.createProperty({
      networkId: network.id,
      agentId: agent.id,
      reference: p.ref,
      kind: 'home',
      city: 'Dijon',
      surfaceM2: p.surface,
      priceEur: p.price,
      status: 'available',
    });
    await db.run('INSERT INTO property_details (property_id, network_id, neighborhood, highlight, updated_at) VALUES (?, ?, ?, ?, ?)', [
      home.id,
      network.id,
      p.area,
      'belle lumière',
      now().toISOString(),
    ]);
    await biens.link({ networkId: network.id, propertyId: home.id, kind: 'post', value: p.post, at: now() });
    await biens.link({ networkId: network.id, propertyId: home.id, kind: 'post', value: p.fbPost, at: now() });
  }
  const meta = {
    appSecret: 'appSecret' in overrides ? overrides.appSecret : APP_SECRET,
    verifyTokenSha256: await sha256Hex(VERIFY_TOKEN),
    networkId: overrides.networkId === null ? undefined : network.id,
    ownIds: `${PAGE_ID},${IG_ID},${WA_PHONE_ID}`,
    appIds: OUR_APP,
  };
  const call = (request: Request) => handleRequest(request, { db, apiKeys: undefined, mode: overrides.mode ?? 'essai', meta, now });
  const post = (payload: unknown, signature?: string | null) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const sig = signature === undefined ? sign(body) : signature;
    if (sig !== null) headers['x-hub-signature-256'] = sig;
    return call(new Request(URL_META, { method: 'POST', headers, body }));
  };
  const outbox = async () =>
    db.all<{ message_id: string; channel: string; created_at: string; body: string }>(
      'SELECT t.message_id, t.channel, t.created_at, m.body FROM trial_outbox t JOIN messages m ON m.id = t.message_id ORDER BY t.rowid',
    );
  const inbound = async () => (await db.all<{ id: string }>('SELECT id FROM inbound_messages')).length;
  return {
    db,
    network,
    call,
    post,
    outbox,
    inbound,
    journal: new SqlJournalStore(db),
    setClock: (t: number) => {
      clock = t;
    },
  };
}

let seq = 0;
const next = (): number => (seq += 1);

function igDirect(senderId: string, text: string, at: number) {
  const n = next();
  return {
    object: 'instagram',
    entry: [{ id: IG_ID, time: at, messaging: [{ sender: { id: senderId }, recipient: { id: IG_ID }, timestamp: at, message: { mid: `ig-mid-${n}`, text } }] }],
  };
}

function igComment(userId: string, username: string, media: string, text: string, at: number) {
  const n = next();
  return {
    object: 'instagram',
    entry: [
      {
        id: IG_ID,
        time: Math.floor(at / 1000),
        changes: [{ field: 'comments', value: { id: `ig-comment-${n}`, text, from: { id: userId, username }, media: { id: media }, timestamp: Math.floor(at / 1000) } }],
      },
    ],
  };
}

function fbDirect(senderId: string, text: string, at: number) {
  const n = next();
  return {
    object: 'page',
    entry: [{ id: PAGE_ID, time: at, messaging: [{ sender: { id: senderId }, recipient: { id: PAGE_ID }, timestamp: at, message: { mid: `fb-mid-${n}`, text } }] }],
  };
}

function fbComment(userId: string, name: string, post: string, text: string, at: number) {
  const n = next();
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: Math.floor(at / 1000),
        changes: [
          {
            field: 'feed',
            value: { item: 'comment', verb: 'add', comment_id: `${post}_c${n}`, post_id: post, from: { id: userId, name }, message: text, created_time: Math.floor(at / 1000) },
          },
        ],
      },
    ],
  };
}

function waMessage(from: string, text: string, at: number) {
  const n = next();
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-test',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: WA_PHONE_ID },
              contacts: [{ wa_id: from, profile: { name: 'Client Essai' } }],
              messages: [{ from, id: `wamid.test-${n}`, timestamp: String(Math.floor(at / 1000)), type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

function igEcho(clientId: string, text: string, at: number, appId?: string) {
  const n = next();
  return {
    object: 'instagram',
    entry: [
      {
        id: IG_ID,
        time: at,
        messaging: [
          { sender: { id: IG_ID }, recipient: { id: clientId }, timestamp: at, message: { mid: `ig-echo-${n}`, text, is_echo: true, ...(appId ? { app_id: appId } : {}) } },
        ],
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describeWithSqlite('C07 · Instagram, Facebook et WhatsApp, en mode essai', () => {
  it('la vérification de l’abonnement rend le défi seulement avec le bon jeton', async () => {
    const w = await world();
    const get = (token: string, challenge = '1158201444', mode = 'subscribe') =>
      w.call(new Request(`${URL_META}?hub.mode=${mode}&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=${challenge}`));
    const good = await get(VERIFY_TOKEN);
    expect(good.status).toBe(200);
    expect(await good.text()).toBe('1158201444');
    expect((await get('jeton-de-verification-meta-faux-1111111111')).status).toBe(403);
    expect((await get(VERIFY_TOKEN, '1158201444', 'unsubscribe')).status).toBe(403);
    // Le défi n'est jamais renvoyé s'il n'a pas la forme attendue.
    expect((await get(VERIFY_TOKEN, '%3Cscript%3E')).status).toBe(403);
  });

  it('une notification à la signature fausse, absente ou d’un autre secret est refusée : rien n’est lu ni rangé', async () => {
    const w = await world();
    const payload = JSON.stringify(igDirect('17841000000001', 'Bonjour, toujours dispo ?', TUESDAY_10H));
    const tampered = payload.replace('dispo', 'libre');
    const responses = [
      await w.post(payload, null),
      await w.post(payload, 'sha256=00'),
      await w.post(payload, sign(payload, OTHER_SECRET)),
      await w.post(tampered, sign(payload)),
      await w.post(payload, sign(payload).replace('sha256=', 'sha1=')),
    ];
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    expect(await w.inbound()).toBe(0);
    expect(await w.outbox()).toHaveLength(0);
    const refused = (await w.journal.all()).filter((e) => e.type === 'meta.refuse');
    expect(refused.map((e) => e.data['reason'])).toEqual(['signature', 'signature', 'signature', 'signature', 'signature']);
    // La bonne signature passe.
    expect((await w.post(payload)).status).toBe(200);
    expect(await w.inbound()).toBe(1);
  });

  it('un secret en cours de changement : l’ancien et le nouveau sont admis', async () => {
    const w = await world({ appSecret: `${OTHER_SECRET}, ${APP_SECRET}` });
    const payload = JSON.stringify(igDirect('17841000000002', 'Bonjour', TUESDAY_10H));
    expect((await w.post(payload, sign(payload, APP_SECRET))).status).toBe(200);
  });

  for (const channel of ['instagram', 'facebook', 'whatsapp'] as const) {
    it(`20 messages ${channel}, de jour comme de nuit : chacun a sa réponse prête en moins d’une minute, rien ne part`, async () => {
      const w = await world();
      for (let i = 0; i < 20; i += 1) {
        const at = (i % 2 === 0 ? TUESDAY_10H : SUNDAY_23H) + i * MINUTE;
        w.setClock(at);
        const sender = `${channel === 'whatsapp' ? '336000000' : '178410000'}${String(i).padStart(2, '0')}`;
        const text = 'Bonjour, est-ce que ce bien est toujours disponible ?';
        const payload = channel === 'instagram' ? igDirect(sender, text, at) : channel === 'facebook' ? fbDirect(sender, text, at) : waMessage(sender, text, at);
        const response = await w.post(payload);
        expect(response.status, `${channel} ${i}`).toBe(200);
        expect(await response.json()).toEqual({ ok: true, received: true });
        const out = await w.outbox();
        expect(out, `${channel} ${i}`).toHaveLength(i + 1);
        expect(out[i]!.channel).toBe(channel);
        expect(Date.parse(out[i]!.created_at) - at).toBeLessThan(MINUTE);
      }
      const entries = await w.journal.all();
      expect(entries.filter((e) => e.type === 'envoi.essai')).toHaveLength(20);
      // Ni texte ni identifiant de client au journal [R13], et la chaîne reste intacte.
      expect(JSON.stringify(entries)).not.toMatch(/Bonjour|disponible|17841000|33600000/);
      expect((await verifyChain(entries)).ok).toBe(true);
    });
  }

  it('3 commentaires Instagram sur 3 vidéos différentes : 3 réponses, chacune avec le bon bien', async () => {
    const w = await world();
    for (const [i, p] of PROPERTIES.entries()) {
      expect((await w.post(igComment(`1784200000000${i}`, `camille.essai${i}`, p.post, 'Prix ? Toujours dispo ?', TUESDAY_10H))).status).toBe(200);
    }
    const out = await w.outbox();
    expect(out).toHaveLength(3);
    const price = (n: number) => `${new Intl.NumberFormat('fr-FR').format(n).replace(/\s/g, ' ')} €`;
    for (const [i, p] of PROPERTIES.entries()) {
      const body = out[i]!.body.replace(/\s/g, ' ');
      expect(out[i]!.channel).toBe('instagram');
      expect(body).toContain(price(p.price).replace(/\s/g, ' '));
      expect(body).toContain(p.area);
      for (const other of PROPERTIES.filter((o) => o !== p)) expect(body).not.toContain(other.area);
    }
  });

  it('un commentaire Facebook sur une publication de la page cite le bon bien', async () => {
    const w = await world();
    expect((await w.post(fbComment('1000000000001', 'Dorian Essai', PROPERTIES[1]!.fbPost, 'Combien ?', TUESDAY_10H))).status).toBe(200);
    const [out] = await w.outbox();
    expect(out!.channel).toBe('facebook');
    expect(out!.body).toContain('Chevreul');
    expect(out!.body).not.toMatch(/Montchapet|Port du Canal/);
  });

  it('[R18] la même notification reçue deux fois ne donne qu’une réponse', async () => {
    const w = await world();
    const payload = JSON.stringify(waMessage('33600000099', 'Bonjour', TUESDAY_10H));
    expect((await w.post(payload)).status).toBe(200);
    w.setClock(TUESDAY_10H + MINUTE);
    expect((await w.post(payload)).status).toBe(200);
    expect(await w.inbound()).toBe(1);
    expect(await w.outbox()).toHaveLength(1);
  });

  it('[R21] après la réponse d’un humain reçue en écho, l’assistant se tait ; l’écho de notre propre application ne compte pas', async () => {
    const w = await world();
    const quiet = '17843000000001';
    const ours = '17843000000002';
    await w.post(igDirect(quiet, 'Bonjour', TUESDAY_10H));
    await w.post(igDirect(ours, 'Bonjour', TUESDAY_10H));
    expect(await w.outbox()).toHaveLength(2);
    w.setClock(TUESDAY_10H + MINUTE);
    // Un écho d'une autre application (ManyChat, l'application Instagram) est réputé humain.
    await w.post(igEcho(quiet, 'Je vous rappelle tout de suite.', TUESDAY_10H + MINUTE, MANYCHAT_LIKE_APP));
    await w.post(igEcho(ours, 'Message de notre application', TUESDAY_10H + MINUTE, OUR_APP));
    w.setClock(TUESDAY_10H + 2 * MINUTE);
    await w.post(igDirect(quiet, 'Merci, et le prix ?', TUESDAY_10H + 2 * MINUTE));
    await w.post(igDirect(ours, 'Et le prix ?', TUESDAY_10H + 2 * MINUTE));
    // La conversation passée à l'agent ne tente plus rien ; l'autre continue (sa deuxième réponse reprend la
    // première, refusée en doublon [R05] tant que la vraie IA n'est pas branchée : limite connue de C05).
    const attempts = await w.db.all<{ person_id: string }>('SELECT person_id FROM send_log WHERE occurred_at = ?', [new Date(TUESDAY_10H + 2 * MINUTE).toISOString()]);
    expect(attempts).toHaveLength(1);
    const oursPerson = await w.db.first<{ person_id: string }>('SELECT person_id FROM inbound_messages WHERE conversation_ref = ? LIMIT 1', [ours]);
    expect(attempts[0]!.person_id).toBe(oursPerson!.person_id);
    const handed = await w.db.all<{ conversation_id: string; reason: string }>('SELECT conversation_id, reason FROM conversation_handovers');
    expect(handed).toEqual([{ conversation_id: `instagram:${quiet}`, reason: 'human_reply' }]);
  });

  it('[R21] un écho humain dans le même lot que le premier message de la conversation fait taire l’assistant, dès ce message', async () => {
    const w = await world();
    const client = '17843000000009';
    const first = igDirect(client, 'Bonjour', TUESDAY_10H);
    const echo = igEcho(client, 'Je vous réponds tout de suite.', TUESDAY_10H + 1000);
    first.entry[0]!.messaging.push(echo.entry[0]!.messaging[0]! as never);
    expect((await w.post(first)).status).toBe(200);
    // Un humain a déjà répondu : l'assistant ne répond pas, même au premier message.
    expect(await w.outbox()).toHaveLength(0);
    const handed = await w.db.all<{ conversation_id: string; reason: string }>('SELECT conversation_id, reason FROM conversation_handovers');
    expect(handed).toEqual([{ conversation_id: `instagram:${client}`, reason: 'human_reply' }]);
    const before = (await w.db.all('SELECT id FROM send_log')).length;
    w.setClock(TUESDAY_10H + MINUTE);
    await w.post(igDirect(client, 'Et le prix ?', TUESDAY_10H + MINUTE));
    expect((await w.db.all('SELECT id FROM send_log')).length).toBe(before);
  });

  it('[R21] un écho humain reçu avant le premier message du client, dans une autre notification, fait taire l’assistant', async () => {
    const w = await world();
    const client = '17843000000010';
    // L'agent écrit le premier depuis l'application Instagram : la conversation n'est pas encore connue.
    expect((await w.post(igEcho(client, 'Bonjour, je reviens vers vous pour la maison.', TUESDAY_10H))).status).toBe(200);
    w.setClock(TUESDAY_10H + MINUTE);
    expect((await w.post(igDirect(client, 'Bonjour, avec plaisir', TUESDAY_10H + MINUTE))).status).toBe(200);
    expect(await w.outbox()).toHaveLength(0);
    const handed = await w.db.all<{ conversation_id: string }>('SELECT conversation_id FROM conversation_handovers');
    expect(handed).toEqual([{ conversation_id: `instagram:${client}` }]);
    const pending = await w.db.all<{ applied_at: string | null }>('SELECT applied_at FROM pending_human_replies');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.applied_at).not.toBeNull();
  });

  it('[R21] une reprise après une panne avant la réponse repasse par les échos en attente', async () => {
    const w = await world();
    const { chaine } = createCaptation(w.db, w.journal, { now: () => new Date(TUESDAY_10H) });
    const payload = igDirect('17843000000011', 'Bonjour', TUESDAY_10H);
    await expect(
      chaine.receive(w.network.id, 'instagram', payload, {}, { beforeReply: async () => Promise.reject(new Error('panne')) }),
    ).rejects.toThrow('panne');
    const calls: string[] = [];
    const again = await chaine.receive(w.network.id, 'instagram', payload, {}, { beforeReply: async () => void calls.push('avant') });
    expect(calls).toEqual(['avant']);
    expect(again[0]).toMatchObject({ status: 'replied' });
  });

  it('aucun envoi réel : aucune adresse extérieure n’est appelée, et le code du Worker n’en contient aucune', async () => {
    const w = await world();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('aucun appel extérieur attendu'));
    await w.post(igDirect('17844000000001', 'Bonjour', TUESDAY_10H));
    await w.post(fbComment('1000000000002', 'Elsa Essai', PROPERTIES[0]!.fbPost, 'Dispo ?', TUESDAY_10H));
    await w.post(waMessage('33600000077', 'Bonjour', TUESDAY_10H));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await w.outbox()).toHaveLength(3);
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}${file}`, 'utf8');
      expect(source, file).not.toMatch(/\b(await|return)\s+fetch\s*\(|globalThis\.fetch|graph\.facebook\.com|manychat\.com/i);
      // Seule exception, écrite ici : le Worker passe `fetch` aux lecteurs des données publiques de l'estimation en
      // ligne (E05), qui ne font que des GET, jamais un envoi. Partout ailleurs, aucun usage de `fetch`.
      const uses = source
        .split('\n')
        .filter((line) => /\bfetch\b/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line) && !/^\s*fetch\(request: Request/.test(line))
        .map((line) => line.trim());
      expect(uses, file).toEqual(
        file === 'worker.ts'
          ? [
              'const reader = env.DVF_BASE_URL ? httpDvfReader(fetch.bind(globalThis), env.DVF_BASE_URL) : null;',
              'return reader ? { geocoder: new BanGeocoder(fetch.bind(globalThis)), sales: new DvfSiteSales(reader) } : undefined;',
      // Les données publiques d'un bien pour l'avis de valeur (E09), en lecture seule, jamais un envoi.
      '...(estimation ? { estimation, fetchPublicData: fetch.bind(globalThis) } : {}),',
              // Le fichier public du registre des gels de la DG Trésor (BR85), lu en GET au seul appui du responsable de
              // la conformité, jamais un envoi.
              'registreGels: { get: fetch.bind(globalThis), url: registreGelsUrl(env.REGISTRE_GELS_URL), userAgent: REGISTRE_GELS_USER_AGENT },',
              // La Base adresse nationale pour le secteur d'une recherche et la position d'un bien (AU073), en GET : seuls un
              // lieu ou l'adresse désignée partent, jamais un envoi.
              'secteursGeocoder: new BanGeocoder(fetch.bind(globalThis)),',
              // La base ouverte des diagnostics de l'ADEME pour la veille (HX16, BR26), en lecture seule : seuls le code
              // postal et le jour partent, jamais un envoi.
              // La Base adresse nationale puis le Géoportail de l'urbanisme pour la zone du résumé de copropriété (BR87),
              // lus en GET au seul appui de l'agent du bien, jamais un envoi.
              'copropriete: { geocoder: new BanGeocoder(fetch.bind(globalThis)), urbanism: new GpuUrbanism(fetch.bind(globalThis)) },',
              'dpeFeed: new AdemeDiagnosisFeed(fetch.bind(globalThis)),',
            ]
          : file === 'bac-a-sable.ts'
            ? // AU025 : l'objet durable du bac à sable de l'agent, joint par sa seule liaison, à une adresse qui ne mène nulle
              // part (`.invalid`) ; rien ne sort du compte Cloudflare, jamais un envoi.
              [
                'async fetch(request: Request): Promise<Response> {',
                "const res = await stub.fetch(new Request('https://bac-a-sable.invalid/sql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(op) }));",
              ]
            : [],
      );
    }
  });

  it('fermé par défaut : hors mode essai, sans secret ou sans réseau, rien n’est lu', async () => {
    const payload = JSON.stringify(igDirect('17845000000001', 'Bonjour', TUESDAY_10H));
    const offMode = await world({ mode: 'reel' });
    expect((await offMode.post(payload)).status).toBe(503);
    const noSecret = await world({ appSecret: undefined });
    expect((await noSecret.post(payload)).status).toBe(503);
    const noNetwork = await world({ networkId: null });
    expect((await noNetwork.post(payload)).status).toBe(503);
    for (const w of [offMode, noSecret, noNetwork]) expect(await w.inbound()).toBe(0);
  });

  it('une notification trop grosse est refusée ; un objet inconnu est noté au journal sans être lu', async () => {
    const w = await world();
    const big = JSON.stringify({ object: 'instagram', entry: [], pad: 'x'.repeat(MAX_META_BYTES) });
    expect((await w.post(big)).status).toBe(413);
    const unknown = await w.post({ object: 'permissions', entry: [] });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ ok: true, received: false });
    const lines = (await w.journal.all()).filter((e) => e.type.startsWith('meta.'));
    expect(lines.map((e) => [e.type, e.data['reason']])).toEqual([
      ['meta.refuse', 'taille'],
      ['meta.non_traite', 'objet'],
    ]);
  });

  it('un message illisible signé est rangé et signalé, jamais jeté', async () => {
    const w = await world();
    const response = await w.post({ object: 'instagram', entry: [{ id: IG_ID, time: TUESDAY_10H, messaging: [{ sender: { id: '1784600' }, weird: true }] }] });
    expect(response.status).toBe(200);
    const rows = await w.db.all<{ status: string }>('SELECT status FROM inbound_messages');
    expect(rows).toEqual([{ status: 'unreadable' }]);
  });

  it('le Worker passe ses variables META_* à l’adresse des notifications', async () => {
    const d1 = fakeD1(openMemoryDatabase());
    await applyMigrations(fromD1(d1), loadMigrations());
    const network = await new FicheClient(fromD1(d1)).createNetwork('Réseau test');
    const env: Env = { DB: d1, MODE: 'essai', META_APP_SECRET: APP_SECRET, META_NETWORK_ID: network.id, META_VERIFY_TOKEN_SHA256: await sha256Hex(VERIFY_TOKEN) };
    const payload = JSON.stringify(igDirect('17847000000001', 'Bonjour', Date.now()));
    const signed = await worker.fetch(new Request(URL_META, { method: 'POST', headers: { 'x-hub-signature-256': sign(payload) }, body: payload }), env);
    expect(signed.status).toBe(200);
    const unsigned = await worker.fetch(new Request(URL_META, { method: 'POST', body: payload }), env);
    expect(unsigned.status).toBe(401);
    const check = await worker.fetch(new Request(`${URL_META}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`), env);
    expect(await check.text()).toBe('42');
  });
});

describeWithSqlite('C07 · adresse de la réponse chez Meta', () => {
  it('la réponse va à la conversation reçue : compte propre au canal pour un message privé, commentaire pour un commentaire, jamais celle d’un autre', async () => {
    const db: SqlDatabase = fromD1(fakeD1(openMemoryDatabase()));
    await applyMigrations(db, loadMigrations());
    const now = (): Date => new Date(TUESDAY_10H);
    const network = await new FicheClient(db, { now }).createNetwork('Réseau test');
    const channels = (['email', 'sms', 'whatsapp', 'instagram', 'facebook', 'phone'] as const).map((c) => new FakeChannel(c));
    const { chaine, controle } = createCaptation(db, new SqlJournalStore(db), { now, channels });
    await chaine.receive(network.id, 'instagram', igDirect('17848000000001', 'Bonjour', TUESDAY_10H), { now: now() });
    await chaine.receive(network.id, 'facebook', fbComment('1000000000003', 'Fabien Essai', `${PAGE_ID}_999`, 'Dispo ?', TUESDAY_10H), { now: now() });
    const ig = channels.find((c) => c.channel === 'instagram')!.sent;
    const fb = channels.find((c) => c.channel === 'facebook')!.sent;
    expect(ig.map((m) => [m.to, m.thread])).toEqual([['17848000000001', 'direct']]);
    expect(fb).toHaveLength(1);
    expect(fb[0]!.thread).toBe('comment');
    expect(fb[0]!.to).toMatch(new RegExp(`^${PAGE_ID}_999_c\\d+$`));
    // Une conversation qui n'est pas celle de la personne n'est jamais une adresse.
    await chaine.receive(network.id, 'instagram', igDirect('17848000000002', 'Bonjour', TUESDAY_10H), { now: now() });
    expect(ig).toHaveLength(2);
    const first = await db.first<{ person_id: string }>("SELECT person_id FROM inbound_messages WHERE conversation_ref = '17848000000001'");
    const out = await controle.send({
      networkId: network.id,
      personId: first!.person_id,
      channel: 'instagram',
      kind: 'reply',
      conversationId: 'instagram:17848000000002',
      fallbackTexts: ['Bonjour.'],
    });
    expect(out.status).not.toBe('sent');
    expect(ig).toHaveLength(2);
  });
});
