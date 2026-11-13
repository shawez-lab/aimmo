import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Acces, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { ChaineVocale, NotesVocales, type Transcriber } from '../../core/src/voix/notes-vocales.ts';
import { NOTES_VOCALES_REFUSALS, appelsRoutes, type AppelsServices } from '../src/appels.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Un mardi de décembre, 10 h à Paris. Tout est inventé.
const T0 = Date.parse('2026-12-08T09:00:00.000Z');
const SELL = 'Je souhaite vendre ma maison à Talant rapidement.';
const IBAN = 'FR7630006000011234567890189';

const whatsApp = (id: string, message: Record<string, unknown>, from: string) => ({
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
            messages: [{ from, id, timestamp: String(T0 / 1000), ...message }],
          },
        },
      ],
    },
  ],
});
const voice = (id: string, from = '33600000401') => whatsApp(id, { type: 'audio', audio: { id: `MEDIA-SECRET-${id}`, mime_type: 'audio/ogg; codecs=opus', voice: true } }, from);

async function setup(answer: (mediaRef: string) => unknown = () => ({ text: SELL, language: 'fr-FR', confidence: 0.91 })) {
  let clock = T0;
  const now = (): Date => new Date(clock);
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  const captation = createCaptation(db, journal, { now });
  const network = await captation.store.createNetwork('Réseau Essai');
  const a = await captation.store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const b = await captation.store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Essai' });
  await captation.attribution.addZone(network.id, a.id, 'Talant');
  const transcriber: Transcriber = { transcribe: async (audio) => answer(audio.mediaRef) };
  const notes = new NotesVocales(db, journal, transcriber, { now });
  const vocale = new ChaineVocale(notes, captation.chaine, captation.reception, now);
  const acces = new Acces(db, captation.store, captation.fiche, journal, { now });
  const alex: Viewer = { role: 'agent', userId: a.id, networkId: network.id };
  const sam: Viewer = { role: 'agent', userId: b.id, networkId: network.id };
  const direction: Viewer = { role: 'direction', userId: 'dir-1', networkId: network.id };
  const s: AppelsServices = { db, acces, journal, now };
  const route = appelsRoutes().find((r) => r.name === 'fiche.notes_vocales.lire')!;
  const receive = async (id: string, from?: string) => {
    clock += 60_000;
    await vocale.receive(network.id, 'whatsapp', voice(id, from));
    const [row] = await db.all<{ person_id: string | null }>('SELECT person_id FROM inbound_messages WHERE external_id = ?', [id]);
    return row?.person_id ?? null;
  };
  const read = async (viewer: Viewer, personId: string, query = '') => {
    const path = `/fiches/${personId}/notes-vocales`;
    const match = route.pattern.exec(path);
    if (!match) throw new Error(`route absente : ${path}`);
    const response = await route.handle(s, viewer, match.slice(1), new Request(`https://api.example.test/v1${path}${query}`));
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { db, journal, captation, network, alex, sam, direction, receive, read, agentA: a };
}

describeWithSqlite('BR62 · les notes vocales, relues dans la fiche', () => {
  it('[R240] l’agent de la fiche relit la note : texte transcrit, canal, langue parlée en code court, sûreté ; rien envoyé de plus', async () => {
    const t = await setup();
    const person = (await t.receive('wamid.N1'))!;
    expect(person).toBeTruthy();
    const assigned = await t.db.all<{ agent_id: string | null }>('SELECT agent_id FROM persons WHERE id = ?', [person]);
    expect(assigned[0]?.agent_id).toBe(t.agentA.id);
    const r = await t.read(t.alex, person);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ channel: 'whatsapp', transcript: SELL, language: 'fr', confidence: 0.91, hasAudio: true });
    expect(typeof r.body.data[0].receivedAt).toBe('string');
  });

  it('[R15] la référence de l’audio n’est jamais rendue ; un IBAN dicté reste masqué', async () => {
    const t = await setup(() => ({ text: `Voici mon IBAN ${IBAN} pour la suite.`, language: 'fr', confidence: 0.9 }));
    const person = (await t.receive('wamid.I1'))!;
    const r = await t.read(t.direction, person);
    expect(r.body.data).toHaveLength(1);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('MEDIA-SECRET');
    expect(text).not.toContain(IBAN);
    expect(text).toContain('[IBAN masqué]');
    for (const n of r.body.data) {
      expect(n).not.toHaveProperty('mediaRef');
      expect(n).not.toHaveProperty('mime');
      expect(n).not.toHaveProperty('external_id');
    }
  });

  it('[R241] une note en cours ou impossible n’est pas montrée', async () => {
    const t = await setup((ref) => (ref.endsWith('N2') ? { text: '', language: null, confidence: 0 } : { text: SELL, language: 'fr', confidence: 0.9 }));
    const person = (await t.receive('wamid.N1'))!;
    await t.receive('wamid.N2');
    await t.db.run(
      "INSERT INTO voice_notes (id, network_id, channel, external_id, status, created_at) VALUES ('en-cours-1', ?, 'whatsapp', 'wamid.N1-bis', 'en_cours', ?)",
      [t.network.id, new Date(T0).toISOString()],
    );
    const r = await t.read(t.alex, person);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].transcript).toBe(SELL);
  });

  it('[R16] seul l’agent de la fiche ou la direction ; chaque refus est au journal et dit en mots', async () => {
    const t = await setup();
    const person = (await t.receive('wamid.N1'))!;
    expect((await t.read(t.direction, person)).body.data).toHaveLength(1);
    const other = await t.read(t.sam, person);
    expect(other).toMatchObject({ status: 403, body: { ok: false, rule: 'R16', code: 'not_assigned', message: NOTES_VOCALES_REFUSALS['not_assigned'] } });
    expect(other.body).not.toHaveProperty('data');
    const compliance = await t.read({ role: 'compliance', userId: 'c', networkId: t.network.id }, person);
    expect(compliance).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    const foreign = await t.read({ role: 'direction', userId: 'd2', networkId: 'autre-reseau' }, person);
    expect(foreign).toMatchObject({ status: 403, body: { rule: 'R16', code: 'other_network' } });
    expect((await t.read(t.alex, 'inconnue')).status).toBe(404);
    const refusals = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refusals.length).toBeGreaterThanOrEqual(3);
    for (const code of Object.keys(NOTES_VOCALES_REFUSALS)) expect(NOTES_VOCALES_REFUSALS[code]).toMatch(/\S/);
  });

  it('aucun paramètre : une lecture qui en porte est refusée', async () => {
    const t = await setup();
    const person = (await t.receive('wamid.N1'))!;
    expect(await t.read(t.alex, person, '?tout=1')).toMatchObject({ status: 400, body: { code: 'unexpected_field' } });
  });

  it('les notes d’une fiche réunie se relisent sur la fiche gardée, de la plus récente à la plus ancienne', async () => {
    const t = await setup();
    const kept = (await t.receive('wamid.N1', '33600000401'))!;
    const double = (await t.receive('wamid.N2', '33600000402'))!;
    expect(double).not.toBe(kept);
    await t.captation.fiche.merge({ survivorId: kept, mergedId: double, reason: 'même personne, test' });
    const r = await t.read(t.alex, kept);
    expect(r.body.data).toHaveLength(2);
    expect(Date.parse(r.body.data[0].receivedAt)).toBeGreaterThanOrEqual(Date.parse(r.body.data[1].receivedAt));
    expect((await t.read(t.alex, double)).body.data).toHaveLength(2);
  });

  it('[R13] le journal ne garde ni texte, ni numéro, ni identifiant du canal', async () => {
    const t = await setup();
    const person = (await t.receive('wamid.N1'))!;
    const before = (await t.journal.all()).length;
    await t.read(t.alex, person);
    await t.read(t.sam, person);
    const added = (await t.journal.all()).slice(before);
    expect(added.length).toBeGreaterThan(0);
    const text = JSON.stringify(added);
    for (const secret of ['Talant', 'vendre', '33600000401', 'MEDIA-SECRET', 'wamid.N1']) expect(text).not.toContain(secret);
  });

  it('docs/API.md décrit la route', () => {
    const doc = readFileSync(new URL('../../../docs/API.md', import.meta.url), 'utf8');
    expect(doc).toContain('`/v1/fiches/<id>/notes-vocales`');
    expect(appelsRoutes().map((r) => r.name)).toContain('fiche.notes_vocales.lire');
  });
});
