import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { Appels, type CallSegment, type CallTranscriber, type IncomingCall } from '../../core/src/voix/appels.ts';
import { APPELS_RECUS_REFUSALS, appelsRoutes, type AppelsServices } from '../src/appels.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Un mardi de décembre, 10 h à Paris. Tout est inventé.
const T0 = Date.parse('2026-12-08T09:00:00.000Z');
const at = (s: number): Date => new Date(T0 + s * 1000);

const SEGMENTS: CallSegment[] = [
  { speaker: 'agent', startS: 0, endS: 6, text: 'Bonjour, cet appel est enregistré pour mieux vous suivre, vous êtes d’accord ?' },
  { speaker: 'appelant', startS: 6, endS: 8, text: 'Oui, d’accord.' },
  { speaker: 'appelant', startS: 9, endS: 20, text: 'Je souhaite vendre ma maison à Talant.' },
  { speaker: 'agent', startS: 21, endS: 24, text: 'Vous avez un prix en tête ? À Chenôve on voit 300 000 €.' },
  { speaker: 'appelant', startS: 25, endS: 33, text: 'Je pensais à 280 000 €, et je voudrais vendre dans 3 mois.' },
];
const transcriber: CallTranscriber = { transcribe: async () => ({ segments: SEGMENTS, language: 'fr', confidence: 0.9 }) };

function incoming(over: Partial<IncomingCall> = {}): IncomingCall {
  return { provider: 'essai', callId: 'APPEL-1', from: '06 00 00 03 01', startedAt: at(0), endedAt: at(40), announcedAt: at(3), consentAt: at(7), recordingRef: 'REC-SECRET-1', originCode: null, ...over };
}

async function setup() {
  const now = (): Date => at(600);
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, unique, journal, { now });
  const network = await store.createNetwork('Réseau Essai');
  const a = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const b = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Essai' });
  const alex: Viewer = { role: 'agent', userId: a.id, networkId: network.id };
  const sam: Viewer = { role: 'agent', userId: b.id, networkId: network.id };
  const direction: Viewer = { role: 'direction', userId: 'dir-1', networkId: network.id };
  const person = await store.createPerson({ networkId: network.id, agentId: a.id, firstName: 'Client' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'phone', value: '06 00 00 03 01' });
  const appels = new Appels(db, journal, store, unique, transcriber, { now });
  const s: AppelsServices = { db, acces, journal, now };
  const route = appelsRoutes().find((r) => r.method === 'GET')!;
  const read = async (viewer: Viewer, personId: string, query = '') => {
    const path = `/fiches/${personId}/appels-recus`;
    const match = route.pattern.exec(path);
    if (!match) throw new Error(`route absente : ${path}`);
    const response = await route.handle(s, viewer, match.slice(1), new Request(`https://api.example.test/v1${path}${query}`));
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { db, journal, store, unique, network, person, alex, sam, direction, appels, read, route, agentA: a };
}

describeWithSqlite('BR61 · les appels reçus, relus dans la fiche', () => {
  it('[R243] l’agent de la fiche relit l’appel : résumé dont chaque ligne porte la phrase de l’appelant, transcription, rien envoyé', async () => {
    const t = await setup();
    expect(await t.appels.receive(t.network.id, incoming())).toMatchObject({ ok: true, status: 'traite' });
    const r = await t.read(t.alex, t.person.id);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    const c = r.body.data[0];
    expect(c).toMatchObject({ status: 'traite', needsAgent: false, durationS: 40, hasRecording: true, originKind: 'inconnue', category: 'seller', stop: null });
    expect(c.summary.length).toBeGreaterThan(0);
    const said = SEGMENTS.filter((x) => x.speaker === 'appelant').map((x) => x.text);
    for (const line of c.summary) expect(said).toContain(line.quote);
    expect(c.summary.find((l: { key: string }) => l.key === 'city')).toMatchObject({ value: 'Talant', quote: 'Je souhaite vendre ma maison à Talant.' });
    expect(c.transcript).toHaveLength(SEGMENTS.length);
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM trial_outbox')).toEqual({ n: 0 });
  });

  it('la référence de l’enregistrement n’est jamais rendue, seulement s’il y en a un', async () => {
    const t = await setup();
    await t.appels.receive(t.network.id, incoming());
    await t.appels.receive(t.network.id, incoming({ callId: 'APPEL-2', consentAt: null, startedAt: at(100), endedAt: at(130) }));
    const r = await t.read(t.alex, t.person.id);
    expect(JSON.stringify(r.body)).not.toContain('REC-SECRET-1');
    expect(r.body.data.map((c: { hasRecording: boolean; status: string }) => [c.status, c.hasRecording])).toEqual([
      ['sans_enregistrement', false],
      ['traite', true],
    ]);
    for (const c of r.body.data) {
      expect(c).not.toHaveProperty('recordingRef');
      expect(c).not.toHaveProperty('origin');
    }
    expect(r.body.data[0]).toMatchObject({ needsAgent: true, summary: [], transcript: [] });
  });

  it('[R16] seul l’agent de la fiche ou la direction ; chaque refus est au journal et dit en mots', async () => {
    const t = await setup();
    await t.appels.receive(t.network.id, incoming());
    expect((await t.read(t.direction, t.person.id)).body.data).toHaveLength(1);
    const other = await t.read(t.sam, t.person.id);
    expect(other).toMatchObject({ status: 403, body: { ok: false, rule: 'R16', code: 'not_assigned', message: APPELS_RECUS_REFUSALS['not_assigned'] } });
    expect(other.body).not.toHaveProperty('data');
    const compliance = await t.read({ role: 'compliance', userId: 'c', networkId: t.network.id }, t.person.id);
    expect(compliance).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    const foreign = await t.read({ role: 'direction', userId: 'd2', networkId: 'autre-reseau' }, t.person.id);
    expect(foreign).toMatchObject({ status: 403, body: { rule: 'R16', code: 'other_network' } });
    expect((await t.read(t.alex, 'inconnue')).status).toBe(404);
    const refusals = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refusals.length).toBeGreaterThanOrEqual(3);
    for (const code of Object.keys(APPELS_RECUS_REFUSALS)) expect(APPELS_RECUS_REFUSALS[code]).toMatch(/\S/);
  });

  it('aucun paramètre : une lecture qui en porte est refusée', async () => {
    const t = await setup();
    expect(await t.read(t.alex, t.person.id, '?tout=1')).toMatchObject({ status: 400, body: { code: 'unexpected_field' } });
  });

  it('les appels d’une fiche réunie se relisent sur la fiche gardée ; un appel en cours n’est pas montré', async () => {
    const t = await setup();
    const double = await t.store.createPerson({ networkId: t.network.id, agentId: t.agentA.id });
    await t.store.addIdentifier({ networkId: t.network.id, personId: double.id, kind: 'phone', value: '06 00 00 03 09' });
    await t.appels.receive(t.network.id, incoming({ callId: 'APPEL-D', from: '06 00 00 03 09' }));
    await t.unique.merge({ survivorId: t.person.id, mergedId: double.id, reason: 'même personne, test' });
    await t.db.run(
      "INSERT INTO calls (id, network_id, provider, call_id, status, person_id, attach, started_at, created_at) VALUES ('en-cours-1', ?, 'essai', 'APPEL-X', 'en_cours', ?, 'matched', ?, ?)",
      [t.network.id, t.person.id, at(500).toISOString(), at(500).toISOString()],
    );
    const r = await t.read(t.alex, t.person.id);
    expect(r.body.data.map((c: { id: string }) => c.id)).not.toContain('en-cours-1');
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].status).toBe('traite');
    // Lue depuis la fiche réunie, la même liste.
    expect((await t.read(t.alex, double.id)).body.data).toHaveLength(1);
  });

  it('[R13] le journal ne garde ni phrase, ni numéro, ni référence de l’enregistrement', async () => {
    const t = await setup();
    await t.appels.receive(t.network.id, incoming());
    const before = (await t.journal.all()).length;
    await t.read(t.alex, t.person.id);
    await t.read(t.sam, t.person.id);
    const added = (await t.journal.all()).slice(before);
    expect(added.length).toBeGreaterThan(0);
    const text = JSON.stringify(added);
    for (const secret of ['Talant', '280 000', '06 00 00 03 01', '0600000301', 'REC-SECRET-1']) expect(text).not.toContain(secret);
  });

  it('docs/API.md décrit la route', () => {
    const doc = readFileSync(new URL('../../../docs/API.md', import.meta.url), 'utf8');
    expect(doc).toContain('`/v1/fiches/<id>/appels-recus`');
    expect(t_routes()).toContain('fiche.appels_recus.lire');
  });
});

const t_routes = (): string[] => appelsRoutes().map((r) => r.name);
