import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, RendezVous, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { MAX_DICTEE_BODY_BYTES, dicteeRoutes, type DicteeServices } from '../src/dictee.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Tout est inventé. Jeudi 3 décembre 2026, 10 h à Paris.
const T0 = Date.parse('2026-12-03T09:00:00.000Z');
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };
const key = (n: number) => `7d1c2b3a-1111-4a2b-8c3d-${String(n).padStart(12, '0')}`;
const TUESDAY_10H = '2026-12-08T09:00:00.000Z';

const DICTATION = [
  'Je sors de chez Madame Claire Exemple, elle veut vendre sa maison.',
  'Son numéro est le 06 12 34 56 78 et son mail claire.exemple@example.test.',
  'La maison fait 120 m², 5 pièces, au 21240 Talant.',
  'Prix demandé 320 000 euros.',
  "Rendez-vous d'estimation mardi à 10 h.",
].join(' ');

const KEEP_ALL = {
  contact: ['firstName', 'lastName', 'phone', 'email', 'project'],
  bien: ['kind', 'postalCode', 'city', 'surfaceM2', 'rooms', 'priceEur'],
  rendezvous: ['appointmentKind', 'start'],
};

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const clock = T0;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const rdv = new RendezVous(db, journal, { now });
  const network = await store.createNetwork('Réseau Essai');
  const a = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const alex: Viewer = { role: 'agent', userId: a.id, networkId: network.id };
  const direction: Viewer = { role: 'direction', userId: 'dir-1', networkId: network.id };
  const compliance = { role: 'compliance', userId: 'conf-1', networkId: network.id } as Viewer;
  await rdv.setAvailability(alex, WEEK);
  const s: DicteeServices = { db, acces, journal, now };
  const call = async (viewer: Viewer, path: string, body: unknown, raw?: string) => {
    const route = dicteeRoutes().find((r) => r.pattern.test(path));
    if (!route) throw new Error(`route absente : ${path}`);
    const request = new Request(`https://api.example.test/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) });
    const response = await route.handle(s, viewer, [], request);
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const counts = async () => {
    const n = async (t: string) => (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
    return { persons: await n('persons'), properties: await n('properties'), appointments: await n('appointments') };
  };
  const someone = await store.createPerson({ networkId: network.id, agentId: a.id, firstName: 'Paul', lastName: 'Fictif' });
  return { db, journal, rdv, network, alex, direction, compliance, call, counts, someone, agentId: a.id };
}

describeWithSqlite('BR100 · la création à la voix par l’API', () => {
  it('[R16] la direction et la conformité sont refusées avant la lecture du corps, et le refus est au journal', async () => {
    const t = await setup();
    for (const viewer of [t.direction, t.compliance]) {
      for (const path of ['/dictee/lecture', '/dictee/validation']) {
        // Un corps illisible : la réponse est le refus de rôle, pas une erreur de corps.
        const r = await t.call(viewer, path, null, '{pas du json');
        expect(r.status, `${viewer.role} ${path}`).toBe(403);
        expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
      }
    }
    const refusals = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refusals).toHaveLength(4);
    expect(refusals.every((e) => (e.data as Record<string, unknown>).kind === 'dictation')).toBe(true);
  });

  it('[R260] [R261] la lecture rend chaque champ avec sa phrase et ne range rien', async () => {
    const t = await setup();
    const before = await t.counts();
    const entries = (await t.journal.all()).length;
    const r = await t.call(t.alex, '/dictee/lecture', { dictation: DICTATION });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: 'essai', sent: false, data: { report: null } });
    const fields = r.body.data.draft.fields as { target: string; key: string; value: unknown; sentence: number; quote: string }[];
    const surface = fields.find((f) => f.target === 'bien' && f.key === 'surfaceM2')!;
    expect(surface.value).toBe(120);
    expect(r.body.data.draft.sentences[surface.sentence]).toContain(surface.quote);
    expect(fields.find((f) => f.key === 'start')?.value).toBe(TUESDAY_10H);
    expect(typeof r.body.data.readAt).toBe('string');
    expect(await t.counts()).toEqual(before);
    expect((await t.journal.all()).length).toBe(entries);
  });

  it('[R261] la validation range la fiche, le bien et le rendez-vous ; rejouée, rien ne double', async () => {
    const t = await setup();
    const read = await t.call(t.alex, '/dictee/lecture', { dictation: DICTATION });
    const body = { requestId: key(1), dictation: DICTATION, readAt: read.body.data.readAt, keep: KEEP_ALL };
    const r = await t.call(t.alex, '/dictee/validation', body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: 'essai', sent: false, data: { personId: key(1), contact: 'created', propertyId: key(1), report: null } });
    expect(r.body.data.ok).toBeUndefined();
    const after = await t.counts();
    const again = await t.call(t.alex, '/dictee/validation', body);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(r.body.data);
    expect(await t.counts()).toEqual(after);
    expect(await t.db.first('SELECT start_at, person_id FROM appointments WHERE id = ?', [r.body.data.appointmentId])).toEqual({ start_at: TUESDAY_10H, person_id: key(1) });
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM messages'))!.n).toBe(0);
  });

  it('[R13] la dictée n’est jamais écrite au journal', async () => {
    const t = await setup();
    const read = await t.call(t.alex, '/dictee/lecture', { dictation: DICTATION });
    await t.call(t.alex, '/dictee/validation', { requestId: key(1), dictation: DICTATION, readAt: read.body.data.readAt, keep: KEEP_ALL });
    const all = JSON.stringify(await t.journal.all()).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}/g, '');
    for (const secret of ['Claire', 'Exemple', '0612', '+33612345678', 'example.test', 'Talant', '320000', 'Madame', 'Je sors']) expect(all, secret).not.toContain(secret);
  });

  it('[R260] un champ que la dictée ne porte pas est refusé 409 avec ses clés, rien n’est rangé', async () => {
    const t = await setup();
    const before = await t.counts();
    const dictation = 'Madame Zoé Exemple vend sa maison au 21240 Talant.';
    const read = await t.call(t.alex, '/dictee/lecture', { dictation });
    const r = await t.call(t.alex, '/dictee/validation', { requestId: key(2), dictation, readAt: read.body.data.readAt, keep: { bien: ['rooms'] } });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, rule: 'R260', code: 'not_dictated', keys: ['bien.rooms'] });
    expect(await t.counts()).toEqual(before);
  });

  it('[R32] [R261] le créneau qui n’est plus libre : 409, avec ce qu’une tentative d’avant a déjà rangé', async () => {
    const t = await setup();
    const read = await t.call(t.alex, '/dictee/lecture', { dictation: DICTATION });
    const readAt = read.body.data.readAt;
    // Une première validation sans le rendez-vous range la fiche et le bien.
    const first = await t.call(t.alex, '/dictee/validation', { requestId: key(3), dictation: DICTATION, readAt, keep: { contact: KEEP_ALL.contact, bien: KEEP_ALL.bien } });
    expect(first.status).toBe(200);
    // Le créneau est pris par un autre rendez-vous.
    const other = await t.rdv.book({ networkId: t.network.id, agentId: t.agentId, personId: t.someone.id, propertyId: null, kind: 'estimation', start: new Date(TUESDAY_10H), source: 'agent', channel: null });
    expect(other.ok).toBe(true);
    const before = await t.counts();
    const r = await t.call(t.alex, '/dictee/validation', { requestId: key(3), dictation: DICTATION, readAt, keep: KEEP_ALL });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, rule: 'R32', code: 'slot_not_free', kept: { personId: key(3), contact: 'created', propertyId: key(3) } });
    expect(await t.counts()).toEqual(before);
  });

  it('un corps mal formé, un champ non prévu ou une dictée trop longue : 400, rien n’est rangé', async () => {
    const t = await setup();
    const before = await t.counts();
    const cases: [string, unknown, string?][] = [
      ['/dictee/lecture', null, '{pas du json'],
      ['/dictee/lecture', { dictation: DICTATION, agentId: 'x' }],
      ['/dictee/lecture', { dictation: '   ' }],
      ['/dictee/lecture', { dictation: 'a'.repeat(5001) }],
      ['/dictee/lecture', { dictation: DICTATION, appointmentId: '../x' }],
      ['/dictee/lecture', null, JSON.stringify({ dictation: 'é'.repeat(5000), pad: 'x'.repeat(MAX_DICTEE_BODY_BYTES) })],
      ['/dictee/validation', { requestId: key(4), dictation: DICTATION, readAt: new Date(T0).toISOString(), keep: KEEP_ALL, personId: 'x' }],
      ['/dictee/validation', { requestId: key(4), dictation: DICTATION, readAt: new Date(T0).toISOString(), keep: [] }],
      ['/dictee/validation', { requestId: 'pas-un-uuid', dictation: DICTATION, readAt: new Date(T0).toISOString(), keep: KEEP_ALL }],
      ['/dictee/validation', { requestId: key(4), dictation: DICTATION, readAt: new Date(T0).toISOString(), keep: KEEP_ALL, report: { opinion: 1 } }],
    ];
    for (const [path, body, raw] of cases) {
      const r = await t.call(t.alex, path, body, raw);
      expect(r.status, JSON.stringify(body ?? raw).slice(0, 80)).toBe(400);
      expect(r.body.ok).toBe(false);
    }
    // Une dictée de 5 000 lettres accentuées tient dans le corps.
    const long = await t.call(t.alex, '/dictee/lecture', { dictation: 'é'.repeat(5000) });
    expect(long.status).toBe(200);
    expect(await t.counts()).toEqual(before);
  });

  it('une lecture trop ancienne est refusée 409 : la dictée se relit', async () => {
    const t = await setup();
    const r = await t.call(t.alex, '/dictee/validation', { requestId: key(5), dictation: DICTATION, readAt: new Date(T0 - 13 * 3_600_000).toISOString(), keep: KEEP_ALL });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: 'stale_reading' });
  });

  it('docs/API.md décrit les routes, branchées dans l’application', () => {
    const doc = readFileSync(new URL('../../../docs/API.md', import.meta.url), 'utf8');
    expect(doc).toContain('## Création à la voix (BR100)');
    expect(doc).toContain('`POST /lecture`');
    expect(doc).toContain('`POST /validation`');
    const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    expect(app).toContain('...dicteeRoutesDef(),');
    expect(dicteeRoutes().map((r) => r.name)).toEqual(['dictee.lecture', 'dictee.validation']);
  });
});
