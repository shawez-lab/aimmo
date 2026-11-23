import { describe, expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { ChaineVocale, NotesVocales, voiceNoteLanguage, type Transcriber, type VoiceAudio } from '../src/voix/notes-vocales.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const SELL = 'Je souhaite vendre ma maison à Talant rapidement.';

/** Un faux transcripteur : rend ce qu'on lui dit, et retient ce qu'il a reçu. */
function fakeTranscriber(answer: (audio: VoiceAudio) => unknown): Transcriber & { calls: VoiceAudio[] } {
  const calls: VoiceAudio[] = [];
  return {
    calls,
    async transcribe(audio) {
      calls.push(audio);
      return answer(audio);
    },
  };
}

const ok = (text = SELL) => fakeTranscriber(() => ({ text, language: 'fr', confidence: 0.93 }));

async function setup(transcriber: Transcriber | null, timeoutMs?: number) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(TUESDAY_10H);
  const journal = new SqlJournalStore(db);
  const captation = createCaptation(db, journal, { now });
  const network = await captation.store.createNetwork('Réseau test');
  const alex = await captation.store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  await captation.attribution.addZone(network.id, alex.id, 'Talant');
  const notes = new NotesVocales(db, journal, transcriber, { now, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  const vocale = new ChaineVocale(notes, captation.chaine, captation.reception, now);
  return { db, journal, captation, network, notes, vocale };
}

const whatsApp = (id: string, message: Record<string, unknown>, from = '33600000201') => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA-1',
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'PN-1' },
            contacts: [{ wa_id: from, profile: { name: 'Nina Fictive' } }],
            messages: [{ from, id, timestamp: String(TUESDAY_10H / 1000), ...message }],
          },
        },
      ],
    },
  ],
});
const waVoice = (id: string, from?: string) => whatsApp(id, { type: 'audio', audio: { id: `MEDIA-${id}`, mime_type: 'audio/ogg; codecs=opus', voice: true } }, from);
const waText = (id: string, body: string, from?: string) => whatsApp(id, { type: 'text', text: { body } }, from);

const metaVoice = (object: 'instagram' | 'page', mid: string, sender = 'IGSID-9') => ({
  object,
  entry: [
    {
      id: 'OWN-1',
      time: TUESDAY_10H,
      messaging: [
        {
          sender: { id: sender },
          recipient: { id: 'OWN-1' },
          timestamp: TUESDAY_10H,
          message: { mid, attachments: [{ type: 'audio', payload: { url: `https://cdn.exemple.test/audio/${mid}.mp4` } }] },
        },
      ],
    },
  ],
});

interface QualRow {
  category: string;
  route: string | null;
  city: string | null;
  budget_min_eur: number | null;
  budget_max_eur: number | null;
}
const first = async <T,>(db: SqlDatabase, sql: string): Promise<T | undefined> => (await db.all<T>(sql))[0];
const qualification = async (db: SqlDatabase, channel: string, externalId: string): Promise<QualRow | undefined> =>
  (
    await db.all<QualRow>(
      `SELECT q.category, q.route, q.city, q.budget_min_eur, q.budget_max_eur FROM qualifications q
       JOIN inbound_messages i ON i.id = q.inbound_id WHERE i.channel = ? AND i.external_id = ?`,
      [channel, externalId],
    )
  )[0];

describeWithSqlite('HX23 · notes vocales transcrites et traitées', () => {
  it('[R240] une note vocale WhatsApp donne la même réponse et la même qualification que le même texte écrit', async () => {
    const t = await setup(ok());
    const [voice] = await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.V1', '33600000201'));
    const [written] = await t.vocale.receive(t.network.id, 'whatsapp', waText('wamid.T1', SELL, '33600000202'));
    expect(voice).toMatchObject({ status: 'replied' });
    expect(written).toMatchObject({ status: 'replied' });
    const q1 = await qualification(t.db, 'whatsapp', 'wamid.V1');
    const q2 = await qualification(t.db, 'whatsapp', 'wamid.T1');
    expect(q1).toBeDefined();
    expect(q1).toEqual(q2);
    const inbound = await first<{ body: string }>(t.db, "SELECT body FROM inbound_messages WHERE external_id = 'wamid.V1'");
    expect(inbound?.body).toBe(SELL);
  });

  it('[R240] Instagram et Messenger : la note seule est transcrite et entre dans la chaîne', async () => {
    const t = await setup(ok());
    const [ig] = await t.vocale.receive(t.network.id, 'instagram', metaVoice('instagram', 'ig-v1'), { ownIds: ['OWN-1'] });
    const [fb] = await t.vocale.receive(t.network.id, 'facebook', metaVoice('page', 'fb-v1', 'PSID-9'), { ownIds: ['OWN-1'] });
    expect(ig).toMatchObject({ status: 'replied' });
    expect(fb).toMatchObject({ status: 'replied' });
    expect((await qualification(t.db, 'instagram', 'ig-v1'))?.category).toBe((await qualification(t.db, 'facebook', 'fb-v1'))?.category);
  });

  it('[R240] la transcription est marquée comme telle et liée à son audio d’origine', async () => {
    const t = await setup(ok());
    const [r] = await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.V2'));
    expect(await t.notes.forInbound(t.network.id, r!.inboundId)).toEqual({
      transcription: true,
      channel: 'whatsapp',
      mediaRef: 'MEDIA-wamid.V2',
      mime: 'audio/ogg; codecs=opus',
      language: 'fr',
      confidence: 0.93,
    });
    // Un message écrit n'est jamais dit transcrit.
    const [w] = await t.vocale.receive(t.network.id, 'whatsapp', waText('wamid.T2', SELL, '33600000203'));
    expect(await t.notes.forInbound(t.network.id, w!.inboundId)).toBeNull();
    // Une autre agence ne lit pas la note d'un autre réseau.
    const other = await t.captation.store.createNetwork('Autre réseau');
    expect(await t.notes.forInbound(other.id, r!.inboundId)).toBeNull();
  });

  it('[R241] une transcription impossible passe la main à l’agent, sans aucune réponse ni texte inventé', async () => {
    const cases: [string, Transcriber | null, number | undefined, string][] = [
      ['absent', null, undefined, 'indisponible'],
      ['en panne', fakeTranscriber(() => Promise.reject(new Error('panne'))), undefined, 'echec'],
      ['trop lent', fakeTranscriber(() => new Promise(() => {})), 5, 'indisponible'],
      ['vide', fakeTranscriber(() => ({ text: '  ', language: 'fr', confidence: 0.99 })), undefined, 'vide'],
      ['incertain', fakeTranscriber(() => ({ text: SELL, language: 'fr', confidence: 0.3 })), undefined, 'incertaine'],
      ['hors format', fakeTranscriber(() => ({ texte: SELL })), undefined, 'echec'],
    ];
    for (const [label, transcriber, timeoutMs, reason] of cases) {
      const t = await setup(transcriber, timeoutMs);
      const results = await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.X'));
      expect(results, label).toEqual([expect.objectContaining({ status: 'unreadable', messageId: null })]);
      expect((await t.db.all('SELECT * FROM messages')).length, label).toBe(0);
      expect((await t.db.all('SELECT * FROM qualifications')).length, label).toBe(0);
      const unread = await t.captation.reception.forAgent(t.network.id);
      expect(unread, label).toHaveLength(1);
      // L'agent garde de quoi écouter la note : son contenu brut, avec la référence du média.
      expect(unread[0]!.raw_payload, label).toContain('MEDIA-wamid.X');
      const row = await first<{ status: string; failure: string; transcript: string | null; media_ref: string | null }>(t.db, 'SELECT * FROM voice_notes');
      expect(row, label).toMatchObject({ status: 'impossible', failure: reason, transcript: null, media_ref: null });
    }
  });

  it('[R241] dans un lot, seule la note impossible passe à l’agent : les autres messages suivent la chaîne', async () => {
    const t = await setup(fakeTranscriber(() => ({ text: SELL, language: 'fr', confidence: 0.2 })));
    const raw = waVoice('wamid.M1');
    raw.entry[0]!.changes[0]!.value.messages.push({ from: '33600000201', id: 'wamid.M2', timestamp: String(TUESDAY_10H / 1000), type: 'text', text: { body: SELL } } as never);
    const results = await t.vocale.receive(t.network.id, 'whatsapp', raw);
    expect(results.map((r) => r.status).sort()).toEqual(['replied', 'unreadable']);
    // La notification d'origine n'est pas modifiée.
    expect(raw.entry[0]!.changes[0]!.value.messages).toHaveLength(2);
  });

  it('[R18] la même note reçue deux fois n’est transcrite, rangée et qualifiée qu’une fois', async () => {
    const transcriber = ok();
    const t = await setup(transcriber);
    await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.D1'));
    const [again] = await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.D1'));
    expect(again).toMatchObject({ status: 'duplicate' });
    expect(transcriber.calls).toHaveLength(1);
    expect((await t.db.all('SELECT * FROM voice_notes')).length).toBe(1);
    expect((await t.db.all('SELECT * FROM qualifications')).length).toBe(1);
    // Une note impossible reçue deux fois n'est ni retranscrite ni rangée deux fois.
    const failing = fakeTranscriber(() => ({ text: '', language: null, confidence: 1 }));
    const u = await setup(failing);
    await u.vocale.receive(u.network.id, 'whatsapp', waVoice('wamid.D2'));
    const [twice] = await u.vocale.receive(u.network.id, 'whatsapp', waVoice('wamid.D2'));
    expect(twice).toMatchObject({ status: 'duplicate' });
    expect(failing.calls).toHaveLength(1);
    expect(await u.captation.reception.forAgent(u.network.id)).toHaveLength(1);
  });

  it('[R18] [R240] deux livraisons simultanées de la même note ne la transcrivent qu’une fois', async () => {
    let release: (v: unknown) => void = () => {};
    const transcriber = fakeTranscriber(() => new Promise((resolve) => (release = resolve)));
    const t = await setup(transcriber);
    const first = t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.C1'));
    await new Promise((r) => setTimeout(r, 0));
    const second = await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.C1'));
    expect(second).toEqual([]);
    release({ text: SELL, language: 'fr', confidence: 0.9 });
    expect(await first).toEqual([expect.objectContaining({ status: 'replied' })]);
    expect(transcriber.calls).toHaveLength(1);
    expect((await t.db.all('SELECT * FROM qualifications')).length).toBe(1);
    expect((await t.db.all('SELECT * FROM inbound_messages')).length).toBe(1);
  });

  it('[R18] une réservation restée en cours après une coupure est reprise', async () => {
    const transcriber = ok();
    const t = await setup(transcriber);
    const old = new Date(TUESDAY_10H - 10 * 60_000).toISOString();
    await t.db.run("INSERT INTO voice_notes (id, network_id, channel, external_id, status, created_at) VALUES ('vn-old', ?, 'whatsapp', 'wamid.S1', 'en_cours', ?)", [t.network.id, old]);
    const [r] = await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.S1'));
    expect(r).toMatchObject({ status: 'replied' });
    expect(transcriber.calls).toHaveLength(1);
  });

  it('[R15] un IBAN dicté n’est rangé en clair nulle part', async () => {
    const t = await setup(ok('Voici mon IBAN FR76 3000 6000 0112 3456 7890 189 pour le dépôt.'));
    await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.I1'));
    const rows = JSON.stringify(await t.db.all('SELECT transcript FROM voice_notes')) + JSON.stringify(await t.db.all('SELECT body FROM inbound_messages'));
    expect(rows.replace(/\s/g, '')).not.toContain('FR7630006000011234567890189');
    expect(rows).not.toContain('7890 189');
  });

  it('[R240] une note Meta en attente (standby) est transcrite comme une autre ; nos propres notes ne le sont jamais', async () => {
    const transcriber = ok();
    const t = await setup(transcriber);
    const standby = metaVoice('instagram', 'ig-sb1') as { entry: Record<string, unknown>[] };
    standby.entry[0]!.standby = standby.entry[0]!.messaging;
    delete standby.entry[0]!.messaging;
    const [r] = await t.vocale.receive(t.network.id, 'instagram', standby, { ownIds: ['OWN-1'] });
    expect(r).toMatchObject({ status: expect.not.stringMatching(/unreadable/) });
    expect(await t.notes.forInbound(t.network.id, r!.inboundId)).toMatchObject({ transcription: true });
    const own = await t.vocale.receive(t.network.id, 'instagram', metaVoice('instagram', 'ig-own1', 'OWN-1'), { ownIds: ['OWN-1'] });
    expect(own).toEqual([]);
    expect(transcriber.calls).toHaveLength(1);
  });

  it('[R15] le transcripteur ne reçoit que la référence de l’audio, jamais le numéro ni le nom', async () => {
    const transcriber = ok();
    const t = await setup(transcriber);
    await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.P1', '33600000299'));
    expect(transcriber.calls).toEqual([{ channel: 'whatsapp', mediaRef: 'MEDIA-wamid.P1', mime: 'audio/ogg; codecs=opus' }]);
    expect(JSON.stringify(transcriber.calls)).not.toMatch(/33600000299|Nina/);
  });

  it('[R13] ni le texte transcrit ni l’audio ne vont au journal', async () => {
    const t = await setup(ok('Je vends ma maison au 12 rue Imaginaire, appelez le 06 00 00 02 98.'));
    await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.J1'));
    const lines = await t.db.all<{ type: string; data: string }>('SELECT type, data FROM journal');
    const voice = lines.filter((l) => l.type === 'voix.note_recue');
    expect(voice).toHaveLength(1);
    const all = JSON.stringify(lines);
    expect(all).not.toContain('Imaginaire');
    expect(all).not.toContain('MEDIA-wamid.J1');
    expect(all).not.toContain('wamid.J1');
  });

  it('une transcription rangée ne change jamais', async () => {
    const t = await setup(ok());
    await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.F1'));
    await expect(t.db.run("UPDATE voice_notes SET transcript = 'autre'")).rejects.toThrow(/rien ne change/);
  });

  it('une notification sans note vocale passe telle quelle, sans appel au transcripteur', async () => {
    const transcriber = ok();
    const t = await setup(transcriber);
    const raw = waText('wamid.N1', SELL);
    const prepared = await t.notes.prepare(t.network.id, 'whatsapp', raw);
    expect(prepared.raw).toBe(raw);
    expect(await t.notes.prepare(t.network.id, 'email', { text: 'x' })).toEqual({ raw: { text: 'x' }, unreadable: [], failed: [], inProgress: 0 });
    expect(transcriber.calls).toHaveLength(0);
  });
});

describe('HX23 · rien sans base', () => {
  it('le module se charge sans base', () => {
    expect(typeof NotesVocales).toBe('function');
  });
});

describeWithSqlite('RC24 · la réponse à une note vocale suit la langue reconnue', () => {
  const spoken = (text: string, language: string | null) => fakeTranscriber(() => ({ text, language, confidence: 0.9 }));
  const replyTo = async (db: SqlDatabase, externalId: string): Promise<string> => {
    const row = await first<{ body: string }>(
      db,
      `SELECT m.body FROM messages m JOIN inbound_messages i ON i.person_id = m.person_id WHERE i.external_id = '${externalId}' AND m.direction = 'out' ORDER BY m.rowid DESC`,
    );
    expect(row, externalId).toBeDefined();
    return row!.body;
  };
  // Aucun mot de la petite liste d'anglais : seule la langue reconnue par le transcripteur dit « anglais ».
  const NO_KEYWORD = 'Good morning, my family wants to sell our house in Talant soon.';

  it('[R240] une note reconnue en anglais reçoit sa réponse en anglais, même sans mot de la liste', async () => {
    const t = await setup(spoken(NO_KEYWORD, 'en-GB'));
    const [r] = await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.L1'));
    expect(r).toMatchObject({ status: 'replied' });
    expect(await replyTo(t.db, 'wamid.L1')).toMatch(/\n\nHello\b/);
    // Le même texte écrit garde la règle d'aujourd'hui : devinée des mots, ici le français.
    const [w] = await t.vocale.receive(t.network.id, 'whatsapp', waText('wamid.L1w', NO_KEYWORD, '33600000209'));
    expect(w).toMatchObject({ status: 'replied' });
    expect(await replyTo(t.db, 'wamid.L1w')).toMatch(/\n\nBonjour\b/);
  });

  it('[R240] une note reconnue en français fait répondre en français, même à une fiche marquée anglaise', async () => {
    const t = await setup(spoken(SELL, 'fr'));
    const [w] = await t.vocale.receive(t.network.id, 'whatsapp', waText('wamid.L2a', 'Hello, is it still available?'));
    expect(w).toMatchObject({ status: 'replied' });
    await t.db.run("UPDATE persons SET language = 'en'");
    const [v] = await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.L2'));
    expect(v).toMatchObject({ status: 'replied' });
    expect(await replyTo(t.db, 'wamid.L2')).toMatch(/\n\nBonjour\b/);
  });

  it('[R240] une autre langue reconnue, ou aucune, garde la règle d’aujourd’hui (fiche, puis mots du message)', async () => {
    const cases: [string, string, string | null, boolean, RegExp][] = [
      ['espagnol, fiche française', 'Quiero vender mi casa en Talant pronto.', 'es', false, /\n\nBonjour\b/],
      ['espagnol, fiche anglaise', 'Quiero vender mi casa en Talant pronto.', 'es', true, /\n\nHello\b/],
      ['sans langue, mots anglais', 'Hello, I would like to sell my house in Talant please.', null, false, /\n\nHello\b/],
      ['langue hors format', NO_KEYWORD, 'english', false, /\n\nBonjour\b/],
    ];
    for (const [label, text, language, englishFile, expected] of cases) {
      const t = await setup(spoken(text, language));
      if (englishFile) {
        await t.vocale.receive(t.network.id, 'whatsapp', waText('wamid.L3a', 'Hello, is it still available?'));
        await t.db.run("UPDATE persons SET language = 'en'");
      }
      const [v] = await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.L3'));
      expect(v, label).toMatchObject({ status: 'replied' });
      expect(await replyTo(t.db, 'wamid.L3'), label).toMatch(expected);
    }
  });

  it('la langue d’une note n’est lue que pour une note transcrite du même réseau', async () => {
    const t = await setup(spoken(NO_KEYWORD, 'EN'));
    const [r] = await t.vocale.receive(t.network.id, 'whatsapp', waVoice('wamid.L4'));
    // « EN » n'est pas un code de langue rangé : la note n'a pas de langue.
    expect(await voiceNoteLanguage(t.db, t.network.id, r!.inboundId)).toBeNull();
    const u = await setup(spoken(NO_KEYWORD, 'en'));
    const [ok1] = await u.vocale.receive(u.network.id, 'whatsapp', waVoice('wamid.L5'));
    expect(await voiceNoteLanguage(u.db, u.network.id, ok1!.inboundId)).toBe('en');
    const other = await u.captation.store.createNetwork('Autre réseau');
    expect(await voiceNoteLanguage(u.db, other.id, ok1!.inboundId)).toBeNull();
    // Un message écrit n'a pas de langue parlée.
    const [w] = await u.vocale.receive(u.network.id, 'whatsapp', waText('wamid.L5w', NO_KEYWORD, '33600000210'));
    expect(await voiceNoteLanguage(u.db, u.network.id, w!.inboundId)).toBeNull();
    // Une note impossible (incertaine) ne rend jamais de langue, et ne reçoit aucune réponse [R241].
    const v = await setup(fakeTranscriber(() => ({ text: NO_KEYWORD, language: 'en', confidence: 0.2 })));
    const [bad] = await v.vocale.receive(v.network.id, 'whatsapp', waVoice('wamid.L6'));
    expect(bad).toMatchObject({ status: 'unreadable' });
    expect(await voiceNoteLanguage(v.db, v.network.id, bad!.inboundId)).toBeNull();
    expect((await v.db.all('SELECT * FROM messages')).length).toBe(0);
  });
});
