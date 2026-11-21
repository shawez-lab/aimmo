import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, missingMetaSettings, type SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex, type ApiConfig } from '../src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// AU033 : Instagram, Facebook et WhatsApp, canal par canal. Tout est inventé : comptes, clients, secrets, clés.
const ORIGIN = 'https://aimmo-api.example.test';
const KEYS = { direction: 'test-cle-au033-dir-dddddddddddddddddddddddddd', alex: 'test-cle-au033-alex-aaaaaaaaaaaaaaaaaaaaaaaaa' };
const APP_SECRET = 'secret-application-meta-au033-0000000000000';
const VERIFY_TOKEN = 'jeton-de-verification-meta-au033-11111111';
const T0 = Date.parse('2026-12-08T09:00:00.000Z');
const PAGE_ID = '900000000000033';
const IG_ID = '178400000000033';
const WA_PHONE_ID = '100000000000033';
const OUR_APP = '555000000000033';
// Le numéro d'une cliente déjà connue de l'agence (fiche ouverte par un autre canal).
const KNOWN_PHONE = '+33611223344';
const IG_SENDER = '17841000000077';
const FB_SENDER = '27841000000088';

let seq = 0;
const igDirect = (sender: string, text: string, at: number) => ({
  object: 'instagram',
  entry: [{ id: IG_ID, time: at, messaging: [{ sender: { id: sender }, recipient: { id: IG_ID }, timestamp: at, message: { mid: `ig-au033-${(seq += 1)}`, text } }] }],
});
const fbDirect = (sender: string, text: string, at: number) => ({
  object: 'page',
  entry: [{ id: PAGE_ID, time: at, messaging: [{ sender: { id: sender }, recipient: { id: PAGE_ID }, timestamp: at, message: { mid: `fb-au033-${(seq += 1)}`, text } }] }],
});
const waMessage = (from: string, text: string, at: number) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba-au033',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: WA_PHONE_ID },
            contacts: [{ wa_id: from, profile: { name: 'Cliente Essai' } }],
            messages: [{ from, id: `wamid.au033-${(seq += 1)}`, timestamp: String(Math.floor(at / 1000)), type: 'text', text: { body: text } }],
          },
        },
      ],
    },
  ],
});

type State = { configured: boolean; missing: string[]; otherNetwork: boolean; channels: { channel: string; status: string; lastReceivedAt: string | null; last30Days: number; treated30Days: number; unreadable30Days: number }[] };

async function world(metaOverride?: Partial<NonNullable<ApiConfig['meta']>> | null) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = T0;
  const now = (): Date => new Date(clock);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const known = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Claire' });
  await store.addIdentifier({ networkId: network.id, agentId: agent.id, personId: known.id, kind: 'phone', value: KNOWN_PHONE });
  const ids = { direction: { role: 'direction', userId: 'direction-1' }, alex: { role: 'agent', userId: agent.id } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as (keyof typeof KEYS)[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network.id, ...ids[w] }))));
  const fullMeta = { appSecret: APP_SECRET, verifyTokenSha256: await sha256Hex(VERIFY_TOKEN), networkId: network.id, ownIds: `${PAGE_ID},${IG_ID},${WA_PHONE_ID}`, appIds: OUR_APP };
  const meta = metaOverride === null ? undefined : { ...fullMeta, ...(metaOverride ?? {}) };
  const config = (): ApiConfig => ({ db, apiKeys, mode: 'essai', now, ...(meta ? { meta } : {}) });
  const post = async (payload: unknown, secret = APP_SECRET) => {
    const body = JSON.stringify(payload);
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    return handleRequest(new Request(`${ORIGIN}/v1/meta/notifications`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body }), config());
  };
  const state = async (who: keyof typeof KEYS = 'direction') => {
    const r = await handleRequest(new Request(`${ORIGIN}/v1/captation/meta`, { headers: { authorization: `Bearer ${KEYS[who]}` } }), config());
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as { ok: boolean; rule?: string; data?: State } };
  };
  const persons = async () => (await db.all<{ n: number }>('SELECT count(*) AS n FROM persons p WHERE NOT EXISTS (SELECT 1 FROM person_merges m WHERE m.merged_id = p.id AND m.undone_at IS NULL)'))[0]!.n;
  return { db, network, agent, known, post, state, persons, journal: new SqlJournalStore(db), tick: (ms: number) => (clock += ms) };
}

const channelOf = (s: State, c: string) => s.channels.find((x) => x.channel === c)!;

describeWithSqlite('AU033 · Instagram, Facebook et WhatsApp, canal par canal', () => {
  it('[R670] l’activation Meta se lit canal par canal : avant tout vrai message, chacun est « non vérifié »', async () => {
    const w = await world();
    const r = await w.state();
    // Le constat de l'audit : sans cette lecture, rien ne disait si Meta livre vraiment (404 avant AU033).
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      configured: true,
      missing: [],
      otherNetwork: false,
      channels: ['instagram', 'facebook', 'whatsapp'].map((channel) => ({ channel, status: 'non_verifiee', lastReceivedAt: null, last30Days: 0, treated30Days: 0, unreadable30Days: 0 })),
    });
  });

  it('[R670] [R18] un message sur chacun des trois canaux rejoint la bonne fiche, avec son origine et un traitement visible', async () => {
    const w = await world();
    // WhatsApp : la cliente déjà connue par son téléphone retrouve sa fiche, aucune autre n'est créée.
    expect((await w.post(waMessage(KNOWN_PHONE.slice(1), 'Bonjour, le T3 est-il disponible ?', T0))).status).toBe(200);
    expect(await w.persons()).toBe(1);
    // Instagram et Facebook : une fiche par personne, retrouvée au message suivant par son compte chez le canal.
    w.tick(60_000);
    expect((await w.post(igDirect(IG_SENDER, 'Bonjour', T0 + 60_000))).status).toBe(200);
    w.tick(60_000);
    expect((await w.post(fbDirect(FB_SENDER, 'Bonjour', T0 + 120_000))).status).toBe(200);
    expect(await w.persons()).toBe(3);
    w.tick(60_000);
    expect((await w.post(igDirect(IG_SENDER, 'Et le prix ?', T0 + 180_000))).status).toBe(200);
    expect(await w.persons()).toBe(3);

    const rows = await w.db.all<{ channel: string; person_id: string | null }>('SELECT channel, person_id FROM inbound_messages ORDER BY received_at');
    expect(rows.map((r) => r.channel)).toEqual(['whatsapp', 'instagram', 'facebook', 'instagram']);
    expect(rows[0]!.person_id).toBe(w.known.id);
    expect(rows[3]!.person_id).toBe(rows[1]!.person_id);
    expect(new Set(rows.map((r) => r.person_id)).size).toBe(3);
    // L'origine : chaque fiche garde le canal par lequel la personne est arrivée.
    for (const r of rows) {
      const sources = await w.db.all<{ channel: string }>('SELECT channel FROM sources WHERE person_id = ?', [r.person_id]);
      expect(sources.map((s) => s.channel), r.channel).toContain(r.channel);
    }
    // Le traitement visible : chaque message a sa réponse prête dans la boîte d'essai, rien ne part.
    const outbox = await w.db.all<{ channel: string }>('SELECT channel FROM trial_outbox ORDER BY rowid');
    expect(outbox.map((o) => o.channel).sort()).toEqual(['facebook', 'instagram', 'instagram', 'whatsapp']);

    const s = (await w.state()).body.data!;
    for (const c of ['instagram', 'facebook', 'whatsapp']) expect(channelOf(s, c).status, c).toBe('verifiee');
    expect(channelOf(s, 'instagram')).toMatchObject({ last30Days: 2, treated30Days: 2, lastReceivedAt: new Date(T0 + 180_000).toISOString() });
    expect(channelOf(s, 'whatsapp')).toMatchObject({ last30Days: 1, treated30Days: 1 });
  });

  it('[R670] un message rejoué ne compte qu’une fois ; une signature fausse ou un message illisible ne vérifient rien', async () => {
    const w = await world();
    const payload = waMessage('33600000055', 'Bonjour', T0);
    expect((await w.post(payload)).status).toBe(200);
    expect((await w.post(payload)).status).toBe(200);
    expect((await w.post(igDirect(IG_SENDER, 'Bonjour', T0), 'autre-secret-qui-n-est-pas-le-notre-000')).status).toBe(401);
    expect((await w.post({ object: 'page', entry: [{ id: PAGE_ID, time: T0, messaging: [{ sender: { id: FB_SENDER }, weird: true }] }] })).status).toBe(200);
    const s = (await w.state()).body.data!;
    expect(channelOf(s, 'whatsapp')).toMatchObject({ status: 'verifiee', last30Days: 1, treated30Days: 1 });
    expect(channelOf(s, 'instagram')).toMatchObject({ status: 'non_verifiee', last30Days: 0 });
    expect(channelOf(s, 'facebook')).toMatchObject({ status: 'non_verifiee', last30Days: 0, unreadable30Days: 1 });
  });

  it('[R670] une réponse rangée mais jamais livrée (envoi coupé) ne vérifie pas le canal', async () => {
    const w = await world();
    const at = new Date(T0).toISOString();
    const row = { net: w.network.id, agent: w.agent.id, person: w.known.id };
    // Un envoi coupé entre la réponse rangée et sa livraison : ni boîte d'essai, ni accusé du canal, ni alerte.
    await w.db.run("INSERT INTO messages (id, network_id, agent_id, person_id, conversation_id, channel, direction, author_kind, body, occurred_at, created_at) VALUES ('m-in', ?, ?, ?, 'conv-coupee', 'instagram', 'in', 'person', 'Bonjour', ?, ?)", [row.net, row.agent, row.person, at, at]);
    await w.db.run("INSERT INTO messages (id, network_id, agent_id, person_id, conversation_id, channel, direction, author_kind, body, occurred_at, created_at) VALUES ('m-out', ?, ?, ?, 'conv-coupee', 'instagram', 'out', 'ai', 'Réponse', ?, ?)", [row.net, row.agent, row.person, at, at]);
    await w.db.run(
      "INSERT INTO inbound_messages (id, network_id, agent_id, dedup_key, channel, kind, body, status, person_id, message_id, received_at, created_at) VALUES ('in-1', ?, ?, 'instagram:coupe', 'instagram', 'direct', 'Bonjour', 'processed', ?, 'm-in', ?, ?)",
      [row.net, row.agent, row.person, at, at],
    );
    expect(channelOf((await w.state()).body.data!, 'instagram')).toMatchObject({ status: 'non_verifiee', last30Days: 1, treated30Days: 0 });
    // La même réponse livrée dans la boîte d'essai : le canal est vérifié.
    await w.db.run("INSERT INTO trial_outbox (message_id, channel, created_at) VALUES ('m-out', 'instagram', ?)", [at]);
    expect(channelOf((await w.state()).body.data!, 'instagram')).toMatchObject({ status: 'verifiee', treated30Days: 1 });
  });

  it('[R670] [R21] la réponse d’un humain reçue en écho du canal, dans le même lot que le premier message, vérifie le canal', async () => {
    const w = await world();
    const first = igDirect(IG_SENDER, 'Bonjour', T0);
    first.entry[0]!.messaging.push({
      sender: { id: IG_ID },
      recipient: { id: IG_SENDER },
      timestamp: T0 + 1000,
      message: { mid: `ig-au033-echo-${(seq += 1)}`, text: 'Je vous réponds tout de suite.', is_echo: true },
    } as never);
    expect((await w.post(first)).status).toBe(200);
    // L'assistant se tait : aucune réponse d'essai, mais la réponse de l'humain est passée par le canal.
    expect(await w.db.all('SELECT * FROM trial_outbox')).toHaveLength(0);
    expect(channelOf((await w.state()).body.data!, 'instagram')).toMatchObject({ status: 'verifiee', treated30Days: 1 });
  });

  it('[R670] un message vieux de plus de 30 jours garde le canal vérifié, mais ne compte plus dans les 30 jours', async () => {
    const w = await world();
    expect((await w.post(waMessage('33600000066', 'Bonjour', T0))).status).toBe(200);
    w.tick(31 * 86_400_000);
    const s = (await w.state()).body.data!;
    expect(channelOf(s, 'whatsapp')).toMatchObject({ status: 'verifiee', last30Days: 0, treated30Days: 0, lastReceivedAt: new Date(T0).toISOString() });
  });

  it('[R670] chaque réglage manquant est nommé, jamais sa valeur ; un autre réseau ne recevra rien', async () => {
    expect((await (await world(null)).state()).body.data).toMatchObject({
      configured: false,
      missing: ['META_APP_SECRET', 'META_VERIFY_TOKEN_SHA256', 'META_NETWORK_ID', 'META_OWN_IDS', 'META_APP_IDS'],
    });
    expect((await (await world({ verifyTokenSha256: 'pas-une-empreinte', appIds: ' , ' })).state()).body.data).toMatchObject({
      configured: false,
      missing: ['META_VERIFY_TOKEN_SHA256', 'META_APP_IDS'],
    });
    const other = await world({ networkId: 'un-autre-reseau' });
    expect((await other.state()).body.data).toMatchObject({ configured: false, missing: [], otherNetwork: true });
    expect(missingMetaSettings({ mode: 'reel', appSecret: 'x', verifyTokenSha256: 'a'.repeat(64), networkId: 'n', ownIds: '1', appIds: '2' })).toEqual(['MODE']);
    // Aucune valeur de réglage ni identifiant de compte ou de client dans la réponse [R13].
    const w = await world();
    await w.post(waMessage(KNOWN_PHONE.slice(1), 'Bonjour', T0));
    const text = (await w.state()).text;
    for (const secret of [APP_SECRET, PAGE_ID, IG_ID, WA_PHONE_ID, OUR_APP, KNOWN_PHONE.slice(1), w.known.id, 'Bonjour']) expect(text).not.toContain(secret);
  });

  it('[R16] un agent ne lit pas l’état de la captation Meta ; le refus est au journal', async () => {
    const w = await world();
    const r = await w.state('alex');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, rule: 'R16' });
    const refus = (await w.journal.all()).filter((e) => e.type === 'acces.refuse' && e.subject === 'captation:meta');
    expect(refus).toHaveLength(1);
  });
});
