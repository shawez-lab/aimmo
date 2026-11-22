import { describe, expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { ChaineVocale, NotesVocales } from '../src/voix/notes-vocales.ts';
import { ReprisesVocales } from '../src/voix/reprises-vocales.ts';
import {
  AUDIO_MAX_BYTES,
  AudioError,
  MetaAudioSource,
  SpeechTranscriber,
  isMetaFileUrl,
  readSpeechResponse,
  validSpeechService,
  type AudioHttpFn,
} from '../src/voix/transcripteur-reel.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const SELL = 'Je souhaite vendre ma maison à Talant rapidement.';
const KEY = 'cle-de-test-inventee-0123456789';
const WA_TOKEN = 'jeton-whatsapp-invente-0123';
const SPEECH = 'https://transcription.exemple.test/v1/audio/transcriptions';
const AUDIO = new Uint8Array([79, 103, 103, 83, 1, 2, 3, 4]);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: FormData | string | undefined;
}

/** Un faux Internet : chaque adresse rend ce qu'on lui dit, et chaque appel est retenu. */
function fakeHttp(routes: Record<string, (call: Call) => Response | Promise<Response>>): AudioHttpFn & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url, init) => {
    const call: Call = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body };
    calls.push(call);
    const route = routes[url];
    if (!route) throw new Error(`adresse inattendue : ${url}`);
    return route(call);
  }) as AudioHttpFn & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const audioFile = (type = 'audio/ogg', bytes: Uint8Array = AUDIO) => new Response(bytes, { status: 200, headers: { 'content-type': type } });
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const speech = (text = SELL, language = 'french', logprob = -0.05, silence = 0.01) =>
  jsonRes({ text, language, duration: 3, segments: [{ start: 0, end: 3, avg_logprob: logprob, no_speech_prob: silence, text }] });

const IG_URL = 'https://scontent.xx.fbcdn.net/v/t/audio-1.mp4?x=1';
const WA_FILE = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1';

function realStack(routes: Record<string, (call: Call) => Response | Promise<Response>>, token: string | null = WA_TOKEN) {
  const http = fakeHttp(routes);
  const source = new MetaAudioSource({ whatsappToken: token, http });
  const transcriber = new SpeechTranscriber(source, { url: SPEECH, apiKey: KEY, model: 'whisper-1', http });
  return { http, source, transcriber };
}

describe('AU044 · le vrai transcripteur des notes vocales', () => {
  it('[R696] une note Instagram : le fichier de Meta seul part au service, le texte et la langue reviennent', async () => {
    const { http, transcriber } = realStack({ [IG_URL]: () => audioFile('audio/mp4'), [SPEECH]: () => speech() });
    const t = await transcriber.transcribe({ channel: 'instagram', mediaRef: IG_URL, mime: null });
    expect(t.text).toBe(SELL);
    expect(t.language).toBe('fr');
    expect(t.confidence).toBeGreaterThan(0.9);
    const sent = http.calls.find((c) => c.url === SPEECH)!;
    expect(sent.method).toBe('POST');
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
    const form = sent.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    // Le service ne reçoit que le fichier audio, le modèle et le format [R15] : ni fiche, ni coordonnée.
    expect([...form.keys()].sort()).toEqual(['file', 'model', 'response_format']);
    const file = form.get('file') as File;
    expect(file.name).toBe('note.m4a');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(AUDIO);
    // Le fichier de Meta est lu sans aucun jeton.
    expect(http.calls.find((c) => c.url === IG_URL)!.headers).toEqual({});
  });

  it('[R696] une note WhatsApp : le média est lu à l’API Graph avec le jeton, puis son fichier', async () => {
    const { http, transcriber } = realStack({
      'https://graph.facebook.com/v21.0/123456789': () => jsonRes({ url: WA_FILE, mime_type: 'audio/ogg; codecs=opus', id: '123456789' }),
      [WA_FILE]: () => audioFile('application/octet-stream'),
      [SPEECH]: () => speech('Bonjour, je cherche un appartement.', 'fr'),
    });
    const t = await transcriber.transcribe({ channel: 'whatsapp', mediaRef: '123456789', mime: 'audio/ogg; codecs=opus' });
    expect(t).toEqual({ text: 'Bonjour, je cherche un appartement.', language: 'fr', confidence: expect.any(Number) });
    expect(http.calls.map((c) => c.url)).toEqual(['https://graph.facebook.com/v21.0/123456789', WA_FILE, SPEECH]);
    expect(http.calls[0]!.headers.authorization).toBe(`Bearer ${WA_TOKEN}`);
    expect(http.calls[1]!.headers.authorization).toBe(`Bearer ${WA_TOKEN}`);
    expect(((http.calls[2]!.body as FormData).get('file') as File).name).toBe('note.ogg');
  });

  it('[R696] une adresse hors des serveurs de Meta, un port ou un identifiant mal formé : rien n’est appelé', async () => {
    const { http, source } = realStack({});
    for (const mediaRef of ['https://exemple.test/a.mp4', 'http://scontent.xx.fbcdn.net/a.mp4', 'https://scontent.xx.fbcdn.net:8443/a.mp4', 'https://user:pw@scontent.xx.fbcdn.net/a', 'https://fbcdn.net.exemple.test/a']) {
      await expect(source.fetch({ channel: 'facebook', mediaRef, mime: null })).rejects.toMatchObject({ code: 'reference' });
    }
    await expect(source.fetch({ channel: 'whatsapp', mediaRef: '../me', mime: null })).rejects.toMatchObject({ code: 'reference' });
    expect(http.calls).toEqual([]);
    expect(isMetaFileUrl(IG_URL)).toBe(true);
    expect(isMetaFileUrl('https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1')).toBe(true);
  });

  it('[R696] un renvoi n’emporte pas le jeton et ne mène qu’à un serveur de Meta', async () => {
    const other = 'https://cdn.fbsbx.com/a.ogg';
    const { http, source } = realStack({
      'https://graph.facebook.com/v21.0/42': () => jsonRes({ url: WA_FILE }),
      [WA_FILE]: () => new Response(null, { status: 302, headers: { location: other } }),
      [other]: () => audioFile('audio/ogg'),
    });
    const file = await source.fetch({ channel: 'whatsapp', mediaRef: '42', mime: null });
    expect(file.type).toBe('audio/ogg');
    expect(http.calls[2]!.headers).toEqual({});
    const evil = realStack({ [IG_URL]: () => new Response(null, { status: 302, headers: { location: 'https://exemple.test/vol' } }) });
    await expect(evil.source.fetch({ channel: 'instagram', mediaRef: IG_URL, mime: null })).rejects.toMatchObject({ code: 'reference' });
    expect(evil.http.calls).toHaveLength(1);
  });

  it('[R696] chaque panne devient un code fermé, sans rien de la réponse du service [R13]', async () => {
    const cases: [Record<string, () => Response>, string, string | null][] = [
      [{}, 'acces', null],
      [{ 'https://graph.facebook.com/v21.0/7': () => jsonRes({ error: { message: 'secret' } }, 401) }, 'acces', WA_TOKEN],
      [{ 'https://graph.facebook.com/v21.0/7': () => jsonRes({ error: {} }, 404) }, 'introuvable', WA_TOKEN],
      [{ 'https://graph.facebook.com/v21.0/7': () => jsonRes({ url: WA_FILE }), [WA_FILE]: () => audioFile('image/png') }, 'format', WA_TOKEN],
      [{ 'https://graph.facebook.com/v21.0/7': () => jsonRes({ url: WA_FILE }), [WA_FILE]: () => new Response('x', { headers: { 'content-type': 'audio/ogg', 'content-length': String(AUDIO_MAX_BYTES + 1) } }) }, 'trop_gros', WA_TOKEN],
      [{ 'https://graph.facebook.com/v21.0/7': () => jsonRes({ url: WA_FILE }), [WA_FILE]: () => audioFile(), [SPEECH]: () => jsonRes({ error: 'quota' }, 429) }, 'limite', WA_TOKEN],
      [{ 'https://graph.facebook.com/v21.0/7': () => jsonRes({ url: WA_FILE }), [WA_FILE]: () => audioFile(), [SPEECH]: () => new Response('<html>', { status: 200 }) }, 'panne', WA_TOKEN],
    ];
    for (const [routes, code, token] of cases) {
      const { transcriber } = realStack(routes, token);
      const error = await transcriber.transcribe({ channel: 'whatsapp', mediaRef: '7', mime: null }).catch((e: unknown) => e);
      expect(error, code).toBeInstanceOf(AudioError);
      expect((error as AudioError).code).toBe(code);
      expect((error as AudioError).message).not.toMatch(/secret|quota|html|jeton/);
    }
  });

  it('[R241] la confiance vient des segments ; sans segment, elle est nulle, jamais devinée', () => {
    expect(readSpeechResponse({ text: 'oui', language: 'english', segments: [] })).toEqual({ text: 'oui', language: 'en', confidence: 0 });
    expect(readSpeechResponse({ text: 'oui', language: 'fr' }).confidence).toBe(0);
    const mixed = readSpeechResponse({
      text: 'a b',
      language: 'xx-yy-zz',
      segments: [
        { start: 0, end: 1, avg_logprob: 0, no_speech_prob: 0 },
        { start: 1, end: 4, avg_logprob: Math.log(0.5), no_speech_prob: 0 },
      ],
    });
    expect(mixed.confidence).toBeCloseTo((1 * 1 + 3 * 0.5) / 4, 3);
    expect(mixed.language).toBeNull();
    // Beaucoup de silence : la note est incertaine.
    expect(readSpeechResponse({ text: 'hum', segments: [{ start: 0, end: 2, avg_logprob: -0.01, no_speech_prob: 0.9 }] }).confidence).toBeLessThan(0.2);
    expect(() => readSpeechResponse({ segments: [] })).toThrow(AudioError);
  });

  it('[R696] une configuration mal formée ne fait aucun transcripteur', () => {
    expect(validSpeechService(SPEECH, 'whisper-1', KEY)).toBe(true);
    expect(validSpeechService('http://transcription.exemple.test/v1/audio/transcriptions', 'whisper-1', KEY)).toBe(false);
    expect(validSpeechService('https://transcription.exemple.test/v1/chat', 'whisper-1', KEY)).toBe(false);
    expect(validSpeechService(SPEECH, 'whisper 1', KEY)).toBe(false);
    expect(validSpeechService(SPEECH, 'whisper-1', 'court')).toBe(false);
    const source = new MetaAudioSource({ whatsappToken: null, http: fakeHttp({}) });
    expect(() => new SpeechTranscriber(source, { url: SPEECH, apiKey: 'court', model: 'whisper-1', http: fakeHttp({}) })).toThrow();
  });
});

const waVoice = (id: string, mediaId: string) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA-1',
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'PN-1' },
            contacts: [{ wa_id: '33600000201', profile: { name: 'Nina Fictive' } }],
            messages: [{ from: '33600000201', id, timestamp: String(TUESDAY_10H / 1000), type: 'audio', audio: { id: mediaId, mime_type: 'audio/ogg; codecs=opus', voice: true } }],
          },
        },
      ],
    },
  ],
});

async function setup(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(TUESDAY_10H);
  const journal = new SqlJournalStore(db);
  const captation = createCaptation(db, journal, { now });
  const network = await captation.store.createNetwork('Réseau test');
  const other = await captation.store.createNetwork('Autre réseau');
  const alex = await captation.store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const ailleurs = await captation.store.createAgent({ networkId: other.id, firstName: 'Lou', lastName: 'Ailleurs' });
  await captation.attribution.addZone(network.id, alex.id, 'Talant');
  const { transcriber, http } = realStack(routes);
  const notes = new NotesVocales(db, journal, transcriber, { now });
  const vocale = new ChaineVocale(notes, captation.chaine, captation.reception, now);
  const reprises = new ReprisesVocales(db, journal, { now });
  return { db, journal, captation, network, other, alex, ailleurs, vocale, reprises, http };
}

describeWithSqlite('AU044 · un vrai vocal devient un texte traçable, une panne ouvre sa reprise', () => {
  it('[R696] [R240] un vrai vocal WhatsApp passe par le vrai transcripteur, rangé comme transcription liée à son média', async () => {
    const t = await setup({
      'https://graph.facebook.com/v21.0/111': () => jsonRes({ url: WA_FILE, mime_type: 'audio/ogg' }),
      [WA_FILE]: () => audioFile(),
      [SPEECH]: () => speech(),
    });
    const results = await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.A1', '111'));
    expect(results.map((r) => r.status)).toEqual(['replied']);
    const rows = await t.db.all<{ status: string; media_ref: string; transcript: string; language: string }>('SELECT status, media_ref, transcript, language FROM voice_notes');
    expect(rows).toEqual([{ status: 'transcrite', media_ref: '111', transcript: SELL, language: 'fr' }]);
    expect(await t.db.all('SELECT id FROM voice_note_recoveries')).toEqual([]);
  });

  it('[R696] [R241] le service en panne : la note est illisible, aucune réponse, et une seule reprise garde l’audio', async () => {
    const t = await setup({
      'https://graph.facebook.com/v21.0/222': () => jsonRes({ url: WA_FILE }),
      [WA_FILE]: () => audioFile(),
      [SPEECH]: () => jsonRes({ error: 'panne' }, 503),
    });
    const first = await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.B2', '222'));
    expect(first).toEqual([expect.objectContaining({ status: 'unreadable', messageId: null })]);
    // La même note livrée de nouveau : ni nouvel essai, ni seconde reprise [R18].
    await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.B2', '222'));
    expect(t.http.calls.filter((c) => c.url === SPEECH)).toHaveLength(1);
    const unread = await t.captation.reception.forAgent(t.network.id);
    expect(unread).toHaveLength(1);
    expect(unread[0]!.raw_payload).toContain('222');

    const list = await t.reprises.list({ role: 'agent', networkId: t.network.id, userId: t.alex.id });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.open).toEqual([{ id: expect.any(String), channel: 'whatsapp', failure: 'echec', inboundId: unread[0]!.id, createdAt: new Date(TUESDAY_10H).toISOString(), doneAt: null }]);
    // La file ne montre jamais la référence de l'audio.
    expect(JSON.stringify(list.value)).not.toContain('222');
    const id = list.value.open[0]!.id;

    const audio = await t.reprises.audioOf({ role: 'agent', networkId: t.network.id, userId: t.alex.id }, id);
    expect(audio).toEqual({ ok: true, value: { channel: 'whatsapp', mediaRef: '222', mime: 'audio/ogg; codecs=opus' } });

    const done = await t.reprises.done({ role: 'direction', networkId: t.network.id, userId: 'dir-1' }, id);
    expect(done).toMatchObject({ ok: true, value: { id, doneAt: expect.any(String) } });
    expect(await t.reprises.done({ role: 'agent', networkId: t.network.id, userId: t.alex.id }, id)).toEqual({ ok: false, status: 409, code: 'deja_faite' });
    const after = await t.reprises.list({ role: 'agent', networkId: t.network.id, userId: t.alex.id });
    expect(after.ok && after.value.open).toEqual([]);
    expect(after.ok && after.value.done.map((r) => r.id)).toEqual([id]);
    await expect(t.db.run("UPDATE voice_note_recoveries SET media_ref = 'x' WHERE id = ?", [id])).rejects.toThrow();

    // Au journal : l'ouverture, l'écoute et la fin, sans la référence de l'audio ni aucun texte [R13].
    const events = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type LIKE 'voix.%' ORDER BY seq");
    expect(events.map((e) => e.type)).toEqual(['voix.note_recue', 'voix.reprise_ouverte', 'voix.reprise_ecoutee', 'voix.reprise_faite']);
    for (const e of events) expect(e.data).not.toMatch(/222|lookaside|Talant/);
  });

  it('[R696] [R16] un agent d’un autre réseau, un partenaire ou un agent parti n’y accède pas, et c’est au journal', async () => {
    const t = await setup({ 'https://graph.facebook.com/v21.0/333': () => jsonRes({}, 404) });
    await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.C3', '333'));
    const [row] = await t.db.all<{ id: string }>('SELECT id FROM voice_note_recoveries');
    expect(row).toBeDefined();
    const outsider = { role: 'agent' as const, networkId: t.network.id, userId: t.ailleurs.id };
    const partner = { role: 'partner' as const, networkId: t.network.id, userId: 'p-1' };
    for (const viewer of [outsider, partner]) {
      expect(await t.reprises.list(viewer)).toEqual({ ok: false, status: 403, code: 'role' });
      expect(await t.reprises.audioOf(viewer, row!.id)).toEqual({ ok: false, status: 403, code: 'role' });
      expect(await t.reprises.done(viewer, row!.id)).toEqual({ ok: false, status: 403, code: 'role' });
    }
    // La direction d'un autre réseau ne trouve pas la reprise.
    expect(await t.reprises.audioOf({ role: 'direction', networkId: t.other.id, userId: 'd-2' }, row!.id)).toEqual({ ok: false, status: 404, code: 'introuvable' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    expect(await t.reprises.list({ role: 'agent', networkId: t.network.id, userId: t.alex.id })).toEqual({ ok: false, status: 403, code: 'role' });
    const refused = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'acces.refuse'");
    expect(refused.length).toBeGreaterThanOrEqual(7);
    expect(refused.every((r) => r.data.includes('voice_recovery'))).toBe(true);
  });
});

