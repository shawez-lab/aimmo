import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runScheduler } from '../src/planificateur.ts';
import { DATES_JOB, DATE_REFUSALS, SCENARIOS_JOB, dateRefusalWords, datesRoutes } from '../src/scenarios.ts';
import { FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../../core/src/index.ts';
import { AUTOMATION_PURPOSE } from '../../core/src/automatismes/scenarios.ts';
import { DATES_PURPOSE } from '../../core/src/automatismes/dates-clients.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Un mardi 12 octobre, 10 h à Paris. Réseaux, agents, personnes, adresses et clés d'API inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');
const HOUR = 3_600_000;
const KEYS = {
  direction: 'test-cle-br56-direction-aaaaaaaaaaaaaaaaaaaaaaa',
  alex: 'test-cle-br56-alex-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  bea: 'test-cle-br56-bea-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  conformite: 'test-cle-br56-conformite-cccccccccccccccccccc',
  ailleurs: 'test-cle-br56-ailleurs-dddddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;
const BIRTHDAY_TEXT = 'Bonjour {prenom}, joyeux anniversaire ! Belle journée à vous.';
const WELCOME = {
  name: 'Bienvenue',
  trigger: 'nouveau_contact',
  waitHours: 0,
  message: { channel: 'email', text: 'Bonjour {prenom}, merci pour votre demande. Je vous rappelle très vite pour en parler.' },
  task: null,
};

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUE_10H;
  const now = () => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const net = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: net.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: net.id, firstName: 'Béa', lastName: 'Essai' });
  const ids: Record<Who, { role: string; userId: string; networkId: string }> = {
    direction: { role: 'direction', userId: 'direction-1', networkId: net.id },
    alex: { role: 'agent', userId: alex.id, networkId: net.id },
    bea: { role: 'agent', userId: bea.id, networkId: net.id },
    conformite: { role: 'compliance', userId: 'conformite-1', networkId: net.id },
    ailleurs: { role: 'direction', userId: 'direction-2', networkId: other.id },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now };
  const http = async (who: Who, method: 'GET' | 'POST', path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) init.body = JSON.stringify(body);
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, init), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; mode?: string; field?: string; message?: string } };
  };
  /** Une personne suivie par Alex, avec son mail et ses accords « dates des clients » et « automatismes ». */
  const person = async (firstName: string) => {
    const p = await store.createPerson({ networkId: net.id, agentId: alex.id, firstName });
    await store.addIdentifier({ networkId: net.id, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}@exemple.test` });
    for (const purpose of [DATES_PURPOSE, AUTOMATION_PURPOSE]) await store.addConsent({ networkId: net.id, personId: p.id, purpose, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(clock - HOUR) });
    return p.id;
  };
  const refusals = async () => (await journal.all()).filter((e) => e.type === 'acces.refuse');
  const count = async (table: string) => (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
  const outbox = async () => (await db.all<{ person_id: string; body: string }>('SELECT m.person_id, m.body FROM trial_outbox o JOIN messages m ON m.id = o.message_id ORDER BY m.rowid')).map((r) => [r.person_id, r.body.includes('anniversaire') ? 'date' : 'scenario']);
  const date = (personId: string, extra: Record<string, unknown> = {}) => ({ personId, kind: 'anniversaire', month: 10, day: 12, proof: 'dit au téléphone (test)', ...extra });
  const unique = new FicheUnique(db, store, { now });
  return { db, journal, net, store, unique, alex, http, person, refusals, count, outbox, date, now, at: (t: number) => { clock = t; } };
}

describeWithSqlite('BR56 · routes des dates des clients, et leur passage au planificateur', () => {
  it('[R16] ranger une date : l’agent qui suit la fiche et la direction seulement ; chaque refus au journal, en mots', async () => {
    const t = await setup();
    const lea = await t.person('Léa');
    // Un rôle sans droit est refusé avant toute lecture du corps.
    const role = await t.http('conformite', 'POST', '/dates-clients', undefined, '{pas du json');
    expect(role.status).toBe(403);
    expect(role.body).toMatchObject({ ok: false, rule: 'R16', code: 'role', message: DATE_REFUSALS['role'] });
    // L'agent qui ne suit pas la fiche, la direction d'un autre réseau, une fiche inconnue : refusés par la lecture sous droits.
    expect((await t.http('bea', 'POST', '/dates-clients', t.date(lea))).body).toMatchObject({ rule: 'R16', code: 'not_assigned' });
    const ailleurs = await t.http('ailleurs', 'POST', '/dates-clients', t.date(lea));
    expect(ailleurs.status).toBe(403);
    expect(ailleurs.body.code).toBe('other_network');
    const unknown = await t.http('alex', 'POST', '/dates-clients', t.date('personne-inconnue'));
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toBe(DATE_REFUSALS['unknown']);
    expect((await t.refusals()).length).toBe(4);
    expect((await t.refusals())[0]!.data).toMatchObject({ rule: 'R16', kind: 'client_date', code: 'role', gesture: 'record' });
    expect(await t.count('client_dates')).toBe(0);
    // L'agent qui suit la fiche, puis la direction (une correction) : deux lignes, la dernière compte.
    for (const who of ['alex', 'direction'] as const) {
      const ok = await t.http(who, 'POST', '/dates-clients', t.date(lea));
      expect(ok.status, who).toBe(200);
      expect(ok.body).toMatchObject({ ok: true, mode: 'essai' });
      expect(typeof ok.body.data.dateId).toBe('string');
    }
    expect(await t.count('client_dates')).toBe(2);
  });

  it('[R16] écrire les textes : la direction seule, refus au journal avant de lire le corps', async () => {
    const t = await setup();
    for (const who of ['alex', 'conformite'] as const) {
      const r = await t.http(who, 'POST', '/dates-clients/textes', undefined, '{pas du json');
      expect(r.status, who).toBe(403);
      expect(r.body).toMatchObject({ rule: 'R16', code: 'not_direction', message: DATE_REFUSALS['not_direction'] });
    }
    expect((await t.refusals()).map((e) => e.data.gesture)).toEqual(['texts', 'texts']);
    expect(await t.count('client_date_texts')).toBe(0);
  });

  it('[R404] [R405] une date sans preuve, impossible ou d’une sorte inconnue est refusée en mots ; rien n’est rangé', async () => {
    const t = await setup();
    const lea = await t.person('Léa');
    const cases: [Record<string, unknown>, string][] = [
      [{ proof: '' }, 'no_proof'],
      [{ proof: undefined }, 'no_proof'],
      [{ proof: 'x'.repeat(201) }, 'no_proof'],
      [{ month: 2, day: 30 }, 'bad_date'],
      [{ month: 13 }, 'bad_date'],
      [{ day: 1.5 }, 'bad_date'],
      [{ kind: 'mariage' }, 'bad_kind'],
    ];
    for (const [extra, code] of cases) {
      const r = await t.http('alex', 'POST', '/dates-clients', t.date(lea, extra));
      expect(r.status, code).toBe(409);
      expect(r.body).toMatchObject({ ok: false, rule: 'R404', code });
      expect(r.body.message).toBe(DATE_REFUSALS[code]);
    }
    // Un 29 février existe : il se souhaite le 28 les années sans 29.
    expect((await t.http('alex', 'POST', '/dates-clients', t.date(lea, { month: 2, day: 29 }))).status).toBe(200);
    // Un champ, un paramètre ou un corps non prévu : 400, rien de rangé.
    expect((await t.http('alex', 'POST', '/dates-clients', t.date(lea, { year: 1980 }))).body).toMatchObject({ code: 'unknown_field', field: 'year' });
    expect((await t.http('alex', 'POST', '/dates-clients?x=1', t.date(lea))).body).toMatchObject({ code: 'unknown_field', field: 'x' });
    expect((await t.http('alex', 'POST', '/dates-clients', undefined, '[1]')).body.code).toBe('invalid_body');
    expect((await t.http('alex', 'POST', '/dates-clients', t.date(42 as unknown as string))).body).toMatchObject({ rule: 'R404', code: 'bad_person' });
    expect(await t.count('client_dates')).toBe(1);
  });

  it('[R405] [R403] les textes : de un à cinq, sans chiffre, contrôlés comme ceux d’un scénario ; refus en mots', async () => {
    const t = await setup();
    const digit = await t.http('direction', 'POST', '/dates-clients/textes', { kind: 'anniversaire', channel: 'email', texts: ['Bonjour {prenom}, joyeux anniversaire pour vos 40 ans !'] });
    expect(digit.status).toBe(409);
    expect(digit.body).toMatchObject({ ok: false, rule: 'R10', code: 'text_R10' });
    expect(digit.body.message).toMatch(/chiffre/);
    const cases: [Record<string, unknown>, string, string][] = [
      [{ texts: [] }, 'R405', 'bad_texts'],
      [{ texts: Array.from({ length: 6 }, () => BIRTHDAY_TEXT) }, 'R405', 'bad_texts'],
      [{ texts: ['Joyeux anniversaire !'] }, 'R405', 'first_name_slot'],
      [{ kind: 'noel' }, 'R405', 'bad_kind'],
      [{ channel: 'courrier' }, 'R405', 'bad_channel'],
    ];
    for (const [extra, rule, code] of cases) {
      const r = await t.http('direction', 'POST', '/dates-clients/textes', { kind: 'anniversaire', channel: 'email', texts: [BIRTHDAY_TEXT], ...extra });
      expect(r.status, code).toBe(409);
      expect(r.body).toMatchObject({ rule, code });
      expect(r.body.message, code).not.toMatch(/Refusé par la règle/);
    }
    expect(await t.count('client_date_texts')).toBe(0);
    const ok = await t.http('direction', 'POST', '/dates-clients/textes', { kind: 'anniversaire', channel: 'email', texts: [BIRTHDAY_TEXT] });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ seq: 1 });
  });

  it('[R402] [R405] [R26] au planificateur, le passage des dates suit celui des scénarios, en mode essai seulement', async () => {
    const t = await setup();
    expect((await t.http('direction', 'POST', '/dates-clients/textes', { kind: 'anniversaire', channel: 'email', texts: [BIRTHDAY_TEXT] })).status).toBe(200);
    // Paul est connu avant l'allumage : aucun message de scénario, son anniversaire part.
    t.at(TUE_10H - 2 * HOUR);
    const paul = await t.person('Paul');
    expect((await t.http('alex', 'POST', '/dates-clients', t.date(paul))).status).toBe(200);
    t.at(TUE_10H);
    const composed = await t.http('direction', 'POST', '/scenarios', WELCOME);
    const id = composed.body.data.scenarioId as string;
    expect((await t.http('direction', 'POST', `/scenarios/${id}/essai`)).status).toBe(200);
    expect((await t.http('direction', 'POST', `/scenarios/${id}/allumer`)).status).toBe(200);
    // Léa arrive après l'allumage, le jour de son anniversaire : le scénario prend la place du jour, la date attend.
    t.at(TUE_10H + 10 * 60_000);
    const lea = await t.person('Léa');
    expect((await t.http('alex', 'POST', '/dates-clients', t.date(lea))).status).toBe(200);
    t.at(TUE_10H + HOUR);
    // Hors mode essai, le planificateur ne passe pas : rien ne part.
    expect(await runScheduler({ db: t.db, mode: 'reel', now: t.now })).toBeNull();
    expect(await t.count('client_date_messages')).toBe(0);
    const tick = await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    expect(tick?.ran).toContain(DATES_JOB);
    expect(tick!.ran.indexOf(SCENARIOS_JOB)).toBeLessThan(tick!.ran.indexOf(DATES_JOB));
    // Par le contrôle central, dans la boîte du mode essai : un message par personne ce jour, jamais deux.
    expect(await t.outbox()).toEqual([
      [lea, 'scenario'],
      [paul, 'date'],
    ]);
    // Le journal ne garde ni la date ni le texte [R13].
    const events = JSON.stringify(await t.journal.all());
    expect(events).not.toContain('joyeux');
    expect(events).not.toContain('téléphone (test)');
  });

  it('chaque refus des dates a ses mots, jamais un code nu', () => {
    for (const code of Object.keys(DATE_REFUSALS)) expect(dateRefusalWords(code, 'R404'), code).toBe(DATE_REFUSALS[code]);
    expect(dateRefusalWords('text_R07', 'R07')).toMatch(/offert/);
  });

  it('docs/API.md décrit chaque route des dates et leur passage', () => {
    const doc = readFileSync(new URL('../../../docs/API.md', import.meta.url), 'utf8');
    expect(doc).toContain('## Dates des clients (BR56)');
    const section = doc.slice(doc.indexOf('## Dates des clients (BR56)'));
    const written = ['`POST /`', '`POST /textes`', '`GET /?personId=<id>`', '`GET /textes`'];
    expect(written.length).toBe(datesRoutes().length);
    for (const w of written) expect(section, w).toContain(w);
    expect(section).toContain(DATES_JOB);
  });
});

describeWithSqlite('BR59 · relire les dates rangées et les textes en service', () => {
  it('[R16] lire les dates d’une fiche : l’agent qui la suit et la direction ; chaque refus au journal, en mots', async () => {
    const t = await setup();
    const lea = await t.person('Léa');
    const role = await t.http('conformite', 'GET', `/dates-clients?personId=${lea}`);
    expect(role.status).toBe(403);
    expect(role.body).toMatchObject({ ok: false, rule: 'R16', code: 'role', message: DATE_REFUSALS['role'] });
    expect((await t.http('bea', 'GET', `/dates-clients?personId=${lea}`)).body).toMatchObject({ rule: 'R16', code: 'not_assigned', message: DATE_REFUSALS['not_assigned'] });
    expect((await t.http('ailleurs', 'GET', `/dates-clients?personId=${lea}`)).body.code).toBe('other_network');
    const unknown = await t.http('alex', 'GET', '/dates-clients?personId=personne-inconnue');
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toBe(DATE_REFUSALS['unknown']);
    expect((await t.refusals()).map((e) => e.data.code)).toEqual(['role', 'not_assigned', 'other_network', 'unknown']);
    expect((await t.refusals())[0]!.data).toMatchObject({ kind: 'client_date', gesture: 'read' });
    // Paramètre manquant, doublé, mal formé ou non prévu : rien n'est lu.
    for (const q of ['', '?personId=', '?personId=a%20b', `?personId=${lea}&personId=${lea}`]) {
      expect((await t.http('alex', 'GET', `/dates-clients${q}`)).body, q).toMatchObject({ rule: 'R404', code: 'bad_person', message: DATE_REFUSALS['bad_person'] });
    }
    expect((await t.http('alex', 'GET', `/dates-clients?personId=${lea}&x=1`)).body).toMatchObject({ code: 'unknown_field', field: 'x' });
    for (const who of ['alex', 'direction'] as const) {
      const ok = await t.http(who, 'GET', `/dates-clients?personId=${lea}`);
      expect(ok.status, who).toBe(200);
      expect(ok.body).toMatchObject({ ok: true, mode: 'essai', data: [] });
    }
  });

  it('[R404] [R17] la dernière date rangée de chaque sorte compte, fiches réunies comprises ; les anciennes sont comptées, gardées', async () => {
    const t = await setup();
    const lea = await t.person('Léa');
    const double = await t.person('Léa');
    expect((await t.http('alex', 'POST', '/dates-clients', t.date(lea, { month: 3, day: 4, proof: 'dite au téléphone (test)' }))).status).toBe(200);
    t.at(TUE_10H + 60_000);
    expect((await t.http('alex', 'POST', '/dates-clients', t.date(double, { month: 3, day: 5, proof: 'corrigée en rendez-vous (test)' }))).status).toBe(200);
    expect((await t.http('direction', 'POST', '/dates-clients', t.date(lea, { kind: 'fete', month: 12, day: 6, proof: 'donnée par mail (test)' }))).status).toBe(200);
    // Avant la réunion, chaque fiche ne dit que ses propres dates.
    expect((await t.http('alex', 'GET', `/dates-clients?personId=${double}`)).body.data).toEqual([
      { kind: 'anniversaire', month: 3, day: 5, proof: 'corrigée en rendez-vous (test)', recordedAt: new Date(TUE_10H + 60_000).toISOString(), replaced: 0 },
    ]);
    await t.unique.merge({ survivorId: lea, mergedId: double, reason: 'même personne, test' });
    for (const id of [lea, double]) {
      const r = await t.http('alex', 'GET', `/dates-clients?personId=${id}`);
      expect(r.body.data, id).toEqual([
        { kind: 'anniversaire', month: 3, day: 5, proof: 'corrigée en rendez-vous (test)', recordedAt: new Date(TUE_10H + 60_000).toISOString(), replaced: 1 },
        { kind: 'fete', month: 12, day: 6, proof: 'donnée par mail (test)', recordedAt: new Date(TUE_10H + 60_000).toISOString(), replaced: 0 },
      ]);
    }
    expect(await t.count('client_dates')).toBe(3);
  });

  it('[R405] [R16] les textes en service : la direction seule ; seul le dernier jeu de chaque sorte et canal', async () => {
    const t = await setup();
    for (const who of ['alex', 'conformite'] as const) {
      const r = await t.http(who, 'GET', '/dates-clients/textes');
      expect(r.status, who).toBe(403);
      expect(r.body).toMatchObject({ rule: 'R16', code: 'not_direction', message: DATE_REFUSALS['not_direction'] });
    }
    expect((await t.refusals()).map((e) => e.data.gesture)).toEqual(['read_texts', 'read_texts']);
    expect((await t.http('direction', 'GET', '/dates-clients/textes')).body).toMatchObject({ ok: true, data: [] });
    expect((await t.http('direction', 'GET', '/dates-clients/textes?kind=fete')).body).toMatchObject({ code: 'unknown_field', field: 'kind' });
    const SMS = 'Bonne fête {prenom} !';
    expect((await t.http('direction', 'POST', '/dates-clients/textes', { kind: 'anniversaire', channel: 'email', texts: ['Ancien texte {prenom}.'] })).status).toBe(200);
    t.at(TUE_10H + 60_000);
    expect((await t.http('direction', 'POST', '/dates-clients/textes', { kind: 'anniversaire', channel: 'email', texts: [BIRTHDAY_TEXT, 'Bel anniversaire {prenom}.'] })).status).toBe(200);
    expect((await t.http('direction', 'POST', '/dates-clients/textes', { kind: 'fete', channel: 'sms', texts: [SMS] })).status).toBe(200);
    // La direction d'un autre réseau ne lit pas ces textes.
    expect((await t.http('ailleurs', 'GET', '/dates-clients/textes')).body.data).toEqual([]);
    const at = new Date(TUE_10H + 60_000).toISOString();
    expect((await t.http('direction', 'GET', '/dates-clients/textes')).body.data).toEqual([
      { kind: 'anniversaire', channel: 'email', texts: [BIRTHDAY_TEXT, 'Bel anniversaire {prenom}.'], seq: 2, writtenAt: at },
      { kind: 'fete', channel: 'sms', texts: [SMS], seq: 1, writtenAt: at },
    ]);
  });

  it('[R13] le journal garde la lecture de la fiche, jamais la date, sa preuve ni un texte', async () => {
    const t = await setup();
    const lea = await t.person('Léa');
    await t.http('alex', 'POST', '/dates-clients', t.date(lea, { proof: 'confiée en visite (test)' }));
    await t.http('direction', 'POST', '/dates-clients/textes', { kind: 'anniversaire', channel: 'email', texts: [BIRTHDAY_TEXT] });
    const before = (await t.journal.all()).length;
    await t.http('alex', 'GET', `/dates-clients?personId=${lea}`);
    await t.http('direction', 'GET', '/dates-clients/textes');
    const read = (await t.journal.all()).slice(before);
    expect(read.map((e) => e.type)).toContain('fiche.lue');
    const events = JSON.stringify(await t.journal.all());
    expect(events).not.toContain('confiée en visite');
    expect(events).not.toContain('joyeux');
  });
});
