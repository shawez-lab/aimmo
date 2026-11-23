import { expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import type { AudioHttpFn } from '../../core/src/voix/transcripteur-reel.ts';
import { processMetaNotification, type MetaConfig } from '../src/meta.ts';
import { audioSourceFromEnv, reprisesVocalesRoutes, transcriberFromEnv, type ReprisesServices } from '../src/reprises-vocales.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Un mardi de décembre, 10 h à Paris. Tout est inventé.
const T0 = Date.parse('2026-12-08T09:00:00.000Z');
const SELL = 'Je souhaite vendre ma maison à Talant rapidement.';
const SPEECH = 'https://transcription.exemple.test/v1/audio/transcriptions';
const KEY = 'cle-de-test-inventee-0123456789';
const TOKEN = 'jeton-whatsapp-invente-0123';
const WA_FILE = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=9';
const AUDIO = new Uint8Array([79, 103, 103, 83, 9, 9]);

const ENV = { TRANSCRIPTION_MODE: 'reel', TRANSCRIPTION_URL: SPEECH, TRANSCRIPTION_MODEL: 'whisper-1', TRANSCRIPTION_KEY: KEY, WHATSAPP_MEDIA_TOKEN: TOKEN };

const voice = (id: string, mediaId: string) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA-1',
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'PN-1' },
            contacts: [{ wa_id: '33600000501', profile: { name: 'Nina Fictive' } }],
            messages: [{ from: '33600000501', id, timestamp: String(T0 / 1000), type: 'audio', audio: { id: mediaId, mime_type: 'audio/ogg; codecs=opus', voice: true } }],
          },
        },
      ],
    },
  ],
});

/** Le faux Meta et le faux service de transcription : `speech` dit ce que rend le service. */
function internet(speech: () => Response): AudioHttpFn & { urls: string[] } {
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(url);
    if (url.startsWith('https://graph.facebook.com/v21.0/')) return new Response(JSON.stringify({ url: WA_FILE, mime_type: 'audio/ogg' }), { status: 200 });
    if (url === WA_FILE) return new Response(AUDIO, { status: 200, headers: { 'content-type': 'audio/ogg' } });
    if (url === SPEECH) return speech();
    throw new Error(`adresse inattendue : ${url}`);
  }) as AudioHttpFn & { urls: string[] };
  fn.urls = urls;
  return fn;
}
const spoken = () => new Response(JSON.stringify({ text: SELL, language: 'french', segments: [{ start: 0, end: 4, avg_logprob: -0.04, no_speech_prob: 0.01 }] }), { status: 200 });

async function setup(env: Record<string, string>, speech: () => Response = spoken) {
  const now = (): Date => new Date(T0);
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  const captation = createCaptation(db, journal, { now });
  const network = await captation.store.createNetwork('Réseau Essai');
  const a = await captation.store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  await captation.attribution.addZone(network.id, a.id, 'Talant');
  const http = internet(speech);
  const config: MetaConfig = { db, appSecret: 'x', verifyTokenSha256: undefined, networkId: network.id, ownIds: '', appIds: '', transcriber: transcriberFromEnv(env, http), now };
  const s: ReprisesServices = { db, journal, now, audio: audioSourceFromEnv(env, http) };
  const alex: Viewer = { role: 'agent', userId: a.id, networkId: network.id };
  const call = async (method: 'GET' | 'POST', path: string, viewer: Viewer = alex) => {
    for (const r of reprisesVocalesRoutes()) {
      const m = r.method === method ? r.pattern.exec(path) : null;
      if (m) return r.handle(s, viewer, m.slice(1), new Request(`https://api.example.test/v1${path}`, { method }));
    }
    throw new Error(`route absente : ${method} ${path}`);
  };
  return { db, config, http, alex, network, call };
}

it('[R696] le vrai transcripteur n’est fait que si tout est rangé', () => {
  const http = internet(spoken);
  expect(transcriberFromEnv(ENV, http)).not.toBeNull();
  expect(transcriberFromEnv({ ...ENV, TRANSCRIPTION_MODE: 'essai' }, http)).toBeNull();
  for (const key of ['TRANSCRIPTION_URL', 'TRANSCRIPTION_MODEL', 'TRANSCRIPTION_KEY'] as const) {
    expect(transcriberFromEnv({ ...ENV, [key]: '' }, http), key).toBeNull();
  }
  expect(transcriberFromEnv({ ...ENV, TRANSCRIPTION_URL: 'https://exemple.test/autre' }, http)).toBeNull();
});

describeWithSqlite('AU044 · le vocal réel dans le Worker, et sa reprise', () => {
  it('[R696] [R240] une note WhatsApp reçue par Meta est transcrite pour de vrai et reçoit sa réponse comme un texte', async () => {
    const t = await setup(ENV);
    const out = await processMetaNotification(t.config, t.network.id, 'whatsapp', voice('wamid.W1', '9001'));
    expect(out.results.map((r) => r.status)).toEqual(['replied']);
    expect(t.http.urls).toEqual(['https://graph.facebook.com/v21.0/9001', WA_FILE, SPEECH]);
    const [note] = await t.db.all<{ status: string; transcript: string; media_ref: string }>('SELECT status, transcript, media_ref FROM voice_notes');
    expect(note).toEqual({ status: 'transcrite', transcript: SELL, media_ref: '9001' });
  });

  it('[R696] [R241] sans transcripteur réglé, la note est illisible, sans réponse, et sa reprise s’écoute puis se clôt', async () => {
    const t = await setup({ WHATSAPP_MEDIA_TOKEN: TOKEN });
    const out = await processMetaNotification(t.config, t.network.id, 'whatsapp', voice('wamid.W2', '9002'));
    expect(out.results).toEqual([expect.objectContaining({ status: 'unreadable', messageId: null })]);

    const list = await t.call('GET', '/notes-vocales/reprises');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: { open: { id: string; failure: string }[]; done: unknown[]; ecoute: boolean } };
    expect(body.data.ecoute).toBe(true);
    expect(body.data.open).toEqual([expect.objectContaining({ channel: 'whatsapp', failure: 'indisponible' })]);
    expect(JSON.stringify(body)).not.toContain('9002');
    const id = body.data.open[0]!.id;

    const audio = await t.call('GET', `/notes-vocales/reprises/${id}/audio`);
    expect(audio.status).toBe(200);
    expect(audio.headers.get('content-type')).toBe('audio/ogg');
    expect(audio.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(AUDIO);

    const done = await t.call('POST', `/notes-vocales/reprises/${id}/faite`);
    expect(done.status).toBe(200);
    expect((await t.call('POST', `/notes-vocales/reprises/${id}/faite`)).status).toBe(409);
    const after = (await (await t.call('GET', '/notes-vocales/reprises')).json()) as { data: { open: unknown[]; done: { id: string }[] } };
    expect(after.data.open).toEqual([]);
    expect(after.data.done.map((d) => d.id)).toEqual([id]);
  });

  it('[R696] le service en panne : reprise ouverte avec la raison ; l’audio expiré chez Meta est dit, sans rien de sa réponse', async () => {
    const t = await setup(ENV, () => new Response('{"error":"secret interne"}', { status: 500 }));
    await processMetaNotification(t.config, t.network.id, 'whatsapp', voice('wamid.W3', '9003'));
    const body = (await (await t.call('GET', '/notes-vocales/reprises')).json()) as { data: { open: { id: string; failure: string }[] } };
    expect(body.data.open.map((o) => o.failure)).toEqual(['echec']);
    const gone: ReprisesServices = { db: t.db, journal: new SqlJournalStore(t.db), now: () => new Date(T0), audio: audioSourceFromEnv(ENV, (async () => new Response('{}', { status: 404 })) as AudioHttpFn) };
    const route = reprisesVocalesRoutes().find((r) => r.name === 'notes_vocales.reprise.audio')!;
    const path = `/notes-vocales/reprises/${body.data.open[0]!.id}/audio`;
    const res = await route.handle(gone, t.alex, route.pattern.exec(path)!.slice(1), new Request(`https://api.example.test/v1${path}`));
    expect(res.status).toBe(410);
    const text = await res.text();
    expect(text).toContain('introuvable_audio');
    expect(text).not.toContain('secret');
  });

  it('[R16] un partenaire ne voit ni la file ni l’audio ; un paramètre inconnu est refusé', async () => {
    const t = await setup({});
    await processMetaNotification(t.config, t.network.id, 'whatsapp', voice('wamid.W4', '9004'));
    const partner: Viewer = { role: 'partner', userId: 'p-1', networkId: t.network.id };
    expect((await t.call('GET', '/notes-vocales/reprises', partner)).status).toBe(403);
    const [row] = await t.db.all<{ id: string }>('SELECT id FROM voice_note_recoveries');
    expect((await t.call('GET', `/notes-vocales/reprises/${row!.id}/audio`, partner)).status).toBe(403);
    const route = reprisesVocalesRoutes()[0]!;
    const res = await route.handle({ db: t.db, journal: new SqlJournalStore(t.db), now: () => new Date(T0), audio: null }, t.alex, [], new Request('https://api.example.test/v1/notes-vocales/reprises?x=1'));
    expect(res.status).toBe(400);
  });
});
